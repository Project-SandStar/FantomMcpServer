/**
 * Scoped A/B: re-embed ONE project (default 265, sedonaWebEditor) with the
 * code-specialized jina-code model into a SEPARATE candidate LanceDB table,
 * then query it — without touching the production `code_vectors` table (which
 * is 1024d qwen3 and shared by all 243 projects).
 *
 * Why a copy + separate table: the running server holds the project's graph DB
 * lock and the production LanceDB open. We read nodes from a copy of the graph
 * and write vectors to .cache/ab-jina-265.lance so nothing collides.
 *
 * Faithfulness: embedding text is built EXACTLY as the production pipeline does
 * (semanticSearchService.buildEmbeddingText) so the comparison isolates the
 * model, not the text. Caveat: we call the sidecar's /api/embed with no task
 * prefix — same as production would — so this measures what the real
 * integration would do, not jina's theoretical ceiling with query/doc prompts.
 *
 * Run:  node scripts/ab-jina265.mjs [projectId]
 */
import { Database, Connection } from '@ladybugdb/core';
import { connect } from '@lancedb/lancedb';
import * as fs from 'node:fs';
import * as path from 'node:path';
import urllibHttp from 'node:http';

const PROJECT_ID = Number(process.argv[2] ?? 265);
const ADMIN = 'http://localhost:3848';
const AUTH = 'Basic ' + Buffer.from('admin:admin').toString('base64');
const CAND_DB = path.resolve('.cache', 'ab-jina-265.lance');
const SRC_GRAPH = path.resolve('.cache', 'graph', `${PROJECT_ID}.db`);
const TMP_GRAPH = path.join('/tmp', `ab-${PROJECT_ID}.db`);

const TEST_QUERIES = [
  'how does Rete.js load from Sedona Sax (app.sax) into the editor graph',
  'how does Sedona dispatch handle open and close',
  'summarize what this project does',
];
// Identifiers we hope a code-aware embedder surfaces for the Rete query.
const RETE_HOPE = ['loadFromSax', 'parseAppSax', 'parseSax', 'fromSax', 'loadApp'];

function getJSON(url) {
  return new Promise((resolve, reject) => {
    urllibHttp.get(url, { headers: { Authorization: AUTH } }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

/** POST helper to an arbitrary host (the jina sidecar), returns parsed JSON. */
function postJSON(urlStr, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = JSON.stringify(body);
    const req = urllibHttp.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => {
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${b.slice(0, 200)}`));
          try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/** Mirror of semanticSearchService.buildEmbeddingText — keep in sync. */
function buildEmbeddingText(node) {
  const parts = [node.qualifiedName.replace(/::/g, ' ').replace(/\./g, ' ')];
  if (node.signature) parts.push(node.signature);
  if (node.documentation) parts.push(node.documentation.slice(0, 200));
  return parts.join(' ');
}

async function embed(sidecarUrl, model, inputs) {
  const json = await postJSON(`${sidecarUrl}/api/embed`, { model, input: inputs });
  const arrays = json.embeddings ?? json.data?.map((d) => d.embedding) ?? [];
  if (arrays.length !== inputs.length) throw new Error(`got ${arrays.length} vectors for ${inputs.length} inputs`);
  return arrays;
}

async function main() {
  // 1) Discover the embedding-code sidecar from the live registry.
  const reg = await getJSON(`${ADMIN}/admin/sidecars?enabled=true`);
  const sc = (reg.sidecars || []).find((s) => s.capabilities?.['embedding-code']?.available);
  if (!sc) throw new Error('no enabled sidecar advertises embedding-code — is the embedding sidecar up?');
  const cap = sc.capabilities['embedding-code'];
  const sidecarUrl = `${sc.protocol}://${sc.host}:${cap.port}`;
  const model = cap.loaded ?? cap.models[0];
  console.log(`[ab] jina sidecar: ${sc.name} @ ${sidecarUrl} model=${model}`);

  // 2) Probe real dimension.
  const [probe] = await embed(sidecarUrl, model, ['dimension probe']);
  const dims = probe.length;
  console.log(`[ab] probed dimension: ${dims}d`);

  // 3) Read project nodes from a COPY of the graph (server holds the original).
  for (const f of [TMP_GRAPH, `${TMP_GRAPH}.wal`, `${TMP_GRAPH}.shadow`, `${TMP_GRAPH}.pid`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* noop */ }
  }
  fs.copyFileSync(SRC_GRAPH, TMP_GRAPH);
  const gdb = new Database(TMP_GRAPH, 64 * 1024 * 1024, true, true, 256 * 1024 * 1024);
  await gdb.init();
  const gconn = new Connection(gdb);
  await gconn.init();
  const qres = await gconn.query(
    `MATCH (n:CodeNode {project_id: ${PROJECT_ID}}) ` +
      `RETURN n.id AS id, n.name AS name, n.qualified_name AS qn, ` +
      `n.signature AS sig, n.documentation AS doc, n.file_path AS fp, n.line_start AS ls`,
  );
  const rows = await (Array.isArray(qres) ? qres[0] : qres).getAll();
  await gdb.close();
  const nodes = rows.map((r) => ({
    id: r.id, name: r.name, qualifiedName: r.qn,
    signature: r.sig || null, documentation: r.doc || null,
    filePath: r.fp || '', lineStart: Number(r.ls || 0),
  }));
  console.log(`[ab] project ${PROJECT_ID}: ${nodes.length} nodes`);

  // 4) Fresh candidate LanceDB table at the probed dims.
  fs.rmSync(CAND_DB, { recursive: true, force: true });
  const conn = await connect(CAND_DB);
  let table = null;
  let stored = 0;
  const BATCH = 64;
  const t0 = Date.now();
  for (let i = 0; i < nodes.length; i += BATCH) {
    const batch = nodes.slice(i, i + BATCH);
    const texts = batch.map(buildEmbeddingText);
    let vecs;
    try {
      vecs = await embed(sidecarUrl, model, texts);
    } catch (e) {
      console.error(`[ab] batch ${i}-${i + batch.length} embed FAILED: ${e.message}`);
      continue;
    }
    const records = batch.map((n, j) => ({
      node_id: n.id, vector: vecs[j], qualified_name: n.qualifiedName,
      file_path: n.filePath, line_start: n.lineStart,
    }));
    if (!table) table = await conn.createTable('cand', records);
    else await table.add(records);
    stored += records.length;
    if (i % 640 === 0 || i + BATCH >= nodes.length) {
      console.log(`[ab] embedded ${Math.min(i + BATCH, nodes.length)}/${nodes.length} (${Math.round((Date.now() - t0) / 1000)}s)`);
    }
  }
  console.log(`[ab] candidate table built: ${stored} vectors @ ${dims}d in ${Math.round((Date.now() - t0) / 1000)}s → ${CAND_DB}`);

  // 5) Query the candidate (jina) table for each test query, top-10.
  console.log('\n========== JINA-CODE (candidate, scoped to project ' + PROJECT_ID + ') ==========');
  for (const q of TEST_QUERIES) {
    const [qv] = await embed(sidecarUrl, model, [q]);
    const hits = await table.search(qv).distanceType('cosine').limit(10).toArray();
    console.log(`\nQ: ${q}`);
    hits.forEach((h, idx) =>
      console.log(`  ${String(idx + 1).padStart(2)}. ${h.qualified_name}  (${path.basename(h.file_path)}:${h.line_start})  d=${h._distance?.toFixed(3)}`),
    );
    const hit = hits.some((h) => RETE_HOPE.some((id) => (h.qualified_name || '').toLowerCase().includes(id.toLowerCase())));
    if (q.toLowerCase().includes('sax')) console.log(`  → surfaces a loadFromSax/parseAppSax-style symbol? ${hit ? 'YES ✓' : 'no ✗'}`);
  }
  console.log('\n[ab] done. Candidate table left at ' + CAND_DB + ' for further queries.');
  console.log('[ab] Compare against qwen3 by running the same queries through the live semanticCodeSearch tool.');
}

main().catch((e) => { console.error('[ab] FATAL:', e); process.exit(1); });
