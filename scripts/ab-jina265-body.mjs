/**
 * Body-enriched A/B: re-embed project 265 with jina-code, but feed the embedder
 * the ACTUAL SOURCE BODY (Tree-sitter line ranges) in addition to
 * qualifiedName + signature — vs the thin-text table built by ab-jina265.mjs
 * (name+sig+doc only). Tests whether richer "readings" improve retrieval for a
 * code-specialized model. Production code_vectors untouched (separate table).
 *
 * Run:  node scripts/ab-jina265-body.mjs [projectId]
 */
import { Database, Connection } from '@ladybugdb/core';
import { connect } from '@lancedb/lancedb';
import * as fs from 'node:fs';
import * as path from 'node:path';
import urllibHttp from 'node:http';

const PROJECT_ID = Number(process.argv[2] ?? 265);
const ADMIN = 'http://localhost:3848';
const AUTH = 'Basic ' + Buffer.from('admin:admin').toString('base64');
const CAND_DB = path.resolve('.cache', 'ab-jina-265-body.lance');
const SRC_GRAPH = path.resolve('.cache', 'graph', `${PROJECT_ID}.db`);
const TMP_GRAPH = path.join('/tmp', `ab-body-${PROJECT_ID}.db`);

const TEST_QUERIES = [
  'how does Rete.js load from Sedona Sax (app.sax) into the editor graph',
  'load from sax',
  'how does Sedona dispatch handle open and close',
  'parse XML into editor components',
  'websocket reconnect with backoff',
];
const RETE_HOPE = ['loadFromSax', 'parseAppSax', 'parseSax', 'loadAppSax', 'StreamingAppSaxParser'];

function getJSON(url) {
  return new Promise((resolve, reject) => {
    urllibHttp.get(url, { headers: { Authorization: AUTH } }, (res) => {
      let b = ''; res.on('data', (d) => (b += d));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
function postJSON(urlStr, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr); const data = JSON.stringify(body);
    const req = urllibHttp.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => { let b = ''; res.on('data', (d) => (b += d));
        res.on('end', () => { if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${b.slice(0,200)}`)); try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
    req.on('error', reject); req.write(data); req.end();
  });
}
async function embed(sidecarUrl, model, inputs) {
  const json = await postJSON(`${sidecarUrl}/api/embed`, { model, input: inputs });
  const arrays = json.embeddings ?? json.data?.map((d) => d.embedding) ?? [];
  if (arrays.length !== inputs.length) throw new Error(`got ${arrays.length} for ${inputs.length}`);
  return arrays;
}

// Read a body window from the file (fixed window — line_end is currently
// unreliable; this mirrors readSourceSnippet). Returns '' if unreadable.
function readBody(filePath, lineStart, maxLines = 25, maxChars = 1200) {
  try {
    if (!filePath || !lineStart || lineStart < 1 || !fs.existsSync(filePath)) return '';
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    let body = lines.slice(lineStart - 1, lineStart - 1 + maxLines).join('\n');
    if (body.length > maxChars) body = body.slice(0, maxChars);
    return body;
  } catch { return ''; }
}

function thinText(n) {
  const parts = [n.qn.replace(/::/g, ' ').replace(/\./g, ' ')];
  if (n.sig) parts.push(n.sig);
  if (n.doc) parts.push(n.doc.slice(0, 200));
  return parts.join(' ');
}

async function main() {
  const reg = await getJSON(`${ADMIN}/admin/sidecars?enabled=true`);
  const sc = (reg.sidecars || []).find((s) => s.capabilities?.['embedding-code']?.available);
  if (!sc) throw new Error('no embedding-code sidecar — is the embedding sidecar up?');
  const cap = sc.capabilities['embedding-code'];
  const sidecarUrl = `${sc.protocol}://${sc.host}:${cap.port}`;
  const model = cap.loaded ?? cap.models[0];
  console.log(`[ab-body] jina @ ${sidecarUrl} model=${model}`);

  // discover project root so relative file_paths resolve
  let projRoot = '';
  try {
    const projs = await getJSON(`${ADMIN}/admin/vectors/stats`);
    const p = (projs.projects || []).find((x) => x.projectId === PROJECT_ID || x.id === PROJECT_ID);
    projRoot = p?.path || '';
  } catch { /* best effort */ }

  for (const f of [TMP_GRAPH, `${TMP_GRAPH}.wal`, `${TMP_GRAPH}.shadow`, `${TMP_GRAPH}.pid`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* noop */ }
  }
  fs.copyFileSync(SRC_GRAPH, TMP_GRAPH);
  const gdb = new Database(TMP_GRAPH, 64 * 1024 * 1024, true, true, 256 * 1024 * 1024);
  await gdb.init(); const gconn = new Connection(gdb); await gconn.init();
  const qr = await gconn.query(
    `MATCH (n:CodeNode {project_id: ${PROJECT_ID}}) RETURN n.id AS id, n.qualified_name AS qn, ` +
      `n.signature AS sig, n.documentation AS doc, n.file_path AS fp, n.line_start AS ls`);
  const rows = await (Array.isArray(qr) ? qr[0] : qr).getAll();
  await gdb.close();

  const nodes = rows.map((r) => ({ id: r.id, qn: r.qn, sig: r.sig || null, doc: r.doc || null,
    fp: r.fp || '', ls: Number(r.ls || 0) }));
  // Resolve a readable absolute path for each node's file.
  let bodiesRead = 0;
  for (const n of nodes) {
    let p = n.fp;
    if (p && !path.isAbsolute(p) && projRoot) p = path.join(projRoot, p);
    n.body = readBody(p, n.ls);
    if (n.body) bodiesRead++;
  }
  console.log(`[ab-body] ${nodes.length} nodes; bodies read for ${bodiesRead} (${Math.round(100*bodiesRead/nodes.length)}%) | projectPath=${projRoot || '(unknown)'}`);
  if (bodiesRead === 0) { console.error('[ab-body] FATAL: no bodies readable — file paths did not resolve. Aborting.'); process.exit(2); }

  fs.rmSync(CAND_DB, { recursive: true, force: true });
  const conn = await connect(CAND_DB);
  let table = null; let stored = 0; const BATCH = 64; const t0 = Date.now();
  for (let i = 0; i < nodes.length; i += BATCH) {
    const batch = nodes.slice(i, i + BATCH);
    // ENRICHED text: thin text + the actual source body.
    const texts = batch.map((n) => `${thinText(n)}\n${n.body}`.slice(0, 4000));
    let vecs;
    try { vecs = await embed(sidecarUrl, model, texts); }
    catch (e) { console.error(`[ab-body] batch ${i} embed failed: ${e.message}`); continue; }
    const records = batch.map((n, j) => ({ node_id: n.id, vector: vecs[j], qualified_name: n.qn,
      file_path: n.fp, line_start: n.ls }));
    if (!table) table = await conn.createTable('cand', records); else await table.add(records);
    stored += records.length;
    if (i % 640 === 0 || i + BATCH >= nodes.length) console.log(`[ab-body] embedded ${Math.min(i+BATCH,nodes.length)}/${nodes.length} (${Math.round((Date.now()-t0)/1000)}s)`);
  }
  console.log(`[ab-body] BODY-ENRICHED table: ${stored} vectors → ${CAND_DB}`);

  // Compare BODY vs THIN (the ab-jina265.mjs table) for each query.
  const thinDb = path.resolve('.cache', 'ab-jina-265.lance');
  const thinTable = fs.existsSync(thinDb) ? await (await connect(thinDb)).openTable('cand').catch(() => null) : null;

  for (const q of TEST_QUERIES) {
    const [qv] = await embed(sidecarUrl, model, [q]);
    console.log(`\n===== Q: ${q}`);
    const show = async (label, tbl) => {
      if (!tbl) { console.log(`  [${label}] (table missing)`); return; }
      const hits = await tbl.search(qv).distanceType('cosine').limit(8).toArray();
      console.log(`  [${label}] ` + hits.slice(0, 6).map((h, i) => `${i+1}.${h.qualified_name.replace('sedonaWebEditor::','')}`).join('  '));
      const ranks = RETE_HOPE.map((t) => { const idx = hits.findIndex((h) => (h.qualified_name||'').toLowerCase().includes(t.toLowerCase())); return idx>=0?`${t}#${idx+1}`:null; }).filter(Boolean);
      if (q.toLowerCase().includes('sax')) console.log(`        sax targets in top8: ${ranks.length?ranks.join(', '):'NONE'}`);
    };
    await show('BODY', table);
    await show('THIN', thinTable);
  }
  console.log('\n[ab-body] done. Body table at ' + CAND_DB);
}
main().catch((e) => { console.error('[ab-body] FATAL:', e); process.exit(1); });
