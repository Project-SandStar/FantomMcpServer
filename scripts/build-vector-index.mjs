#!/usr/bin/env node
/**
 * Build every index a code vector table needs, OUT OF PROCESS:
 *   - IVF_HNSW_SQ on `vector` (ANN; without it every search scans the whole
 *     column). Chosen over IVF_PQ on 2026-11-20: recall@10 0.998 vs 0.71 at the
 *     same median latency, 3.8 GB vs 9.5 GB peak RAM to build (50 real queries,
 *     exact search as ground truth). An existing IVF_PQ index is replaced.
 *   - FTS on `text` (the BM25 leg; v4 tables only)
 *   - BTREE on `project_id` and `node_id`, BITMAP on `node_type` (prefilters
 *     and the delete-by-node_id write path)
 *
 * Why a separate process: training IVF_PQ on 440k x 4096 float32 needs GBs of
 * native memory, and the server runs behind a 4 GB RSS guard that kills it on
 * breach (it did, 2026-09: RSS 4,454 MB, no index). A child process has its
 * own budget. The server spawns this script itself (src/embedding/indexBuild.ts)
 * before a shadow promotion and from POST /admin/vectors/index.
 *
 * Safe beside the running server: building an index commits a new table
 * version, which LanceDB allows next to appends. Do not run two of these on
 * one table at once.
 *
 *   node --max-old-space-size=12288 scripts/build-vector-index.mjs [--table code_vectors_b] [--force] [--json]
 *
 * Idempotent: an index that already exists is skipped unless --force.
 * With --json the last stdout line is a JSON report.
 */
import { connect, Index } from '@lancedb/lancedb';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DB_DIR = process.env.FANTOM_LANCE_DIR || path.join(process.cwd(), '.cache', 'fantomvector.db');
const POINTER = path.join(DB_DIR, '.active-code-table');
const SLOTS = ['code_vectors', 'code_vectors_b'];
const FORCE = process.argv.includes('--force');
const JSON_OUT = process.argv.includes('--json');
const tableArg = (() => { const i = process.argv.indexOf('--table'); return i > 0 ? process.argv[i + 1] : undefined; })();

function activeTableName() {
  try {
    const raw = fs.readFileSync(POINTER, 'utf-8').trim();
    if (SLOTS.includes(raw)) return raw;
  } catch { /* no pointer */ }
  return 'code_vectors';
}

const name = tableArg ?? activeTableName();
if (!SLOTS.includes(name)) {
  console.error(`[index] '${name}' is not a code table slot (${SLOTS.join(', ')})`);
  process.exit(2);
}

const log = (m) => console.log(`[index] ${m}`);
const report = { table: name, rows: 0, built: [], skipped: [], failed: [], ms: 0 };
const t0 = Date.now();
const ticker = setInterval(() => {
  log(`… ${Math.round((Date.now() - t0) / 1000)}s elapsed, rss=${Math.round(process.memoryUsage().rss / 1048576)}MB`);
}, 30_000);

try {
  const db = await connect(DB_DIR);
  const table = await db.openTable(name);
  const rows = await table.countRows();
  report.rows = rows;
  const schema = await table.schema();
  const fields = new Map(schema.fields.map((f) => [f.name, f]));
  const existing = await table.listIndices();
  const has = (col) => existing.some((i) => i.columns.includes(col));
  log(`db=${DB_DIR} table=${name} rows=${rows.toLocaleString()} existing=${existing.map((i) => `${i.name}(${i.columns})`).join(', ') || 'none'}`);

  async function step(label, col, needed, build, isCurrent = () => true) {
    if (!needed.ok) { report.skipped.push(`${label}: ${needed.why}`); return; }
    if (has(col) && isCurrent() && !FORCE) { report.skipped.push(`${label}: already indexed`); return; }
    const s = Date.now();
    try {
      await build();
      report.built.push(`${label} ${((Date.now() - s) / 1000).toFixed(1)}s`);
      log(`built ${label} in ${((Date.now() - s) / 1000).toFixed(1)}s`);
    } catch (err) {
      report.failed.push(`${label}: ${String(err?.message ?? err).split('\n')[0].slice(0, 200)}`);
      log(`FAILED ${label}: ${err?.message ?? err}`);
    }
  }

  // Scalar indexes first: cheap, and they speed up every filtered query.
  await step('btree(project_id)', 'project_id', { ok: fields.has('project_id'), why: 'no column' },
    () => table.createIndex('project_id', { config: Index.btree(), replace: true }));
  await step('btree(node_id)', 'node_id', { ok: fields.has('node_id'), why: 'no column' },
    () => table.createIndex('node_id', { config: Index.btree(), replace: true }));
  await step('bitmap(node_type)', 'node_type', { ok: fields.has('node_type'), why: 'no column' },
    () => table.createIndex('node_type', { config: Index.bitmap(), replace: true }));

  // FTS on the embedded text (v4). English stemming + stop words (2026-11-20):
  // "polled" now matches "poll"/"polling", and "how"/"are" no longer count.
  // listIndices does not report tokenizer options, so a marker file records
  // which FTS config built the index; a different (or missing) marker means
  // the index predates this config and is rebuilt.
  const FTS_CONFIG = { withPosition: false, lowercase: true, baseTokenizer: 'simple', language: 'English', stem: true, removeStopWords: true, asciiFolding: true };
  const FTS_CONFIG_ID = 'en-stem-stop-v1';
  const markerPath = path.join(DB_DIR, '.fts-config.json');
  const readMarkers = () => { try { return JSON.parse(fs.readFileSync(markerPath, 'utf-8')); } catch { return {}; } };
  await step('fts(text)', 'text', { ok: fields.has('text'), why: 'no text column (pre-v4 table)' },
    async () => {
      await table.createIndex('text', { config: Index.fts(FTS_CONFIG), replace: true });
      const m = readMarkers(); m[name] = FTS_CONFIG_ID;
      const tmp = `${markerPath}.tmp`; fs.writeFileSync(tmp, JSON.stringify(m, null, 1)); fs.renameSync(tmp, markerPath);
    },
    () => readMarkers()[name] === FTS_CONFIG_ID);

  // ANN. Below 5,000 rows a scan is cheaper than the index. A vector index of
  // another type (the old IVF_PQ) counts as missing and is replaced.
  const vectorIdx = existing.find((i) => i.columns.includes('vector'));
  await step('ivf_hnsw_sq(vector)', 'vector',
    { ok: rows >= 5_000, why: `only ${rows} rows` },
    () => {
      // Few partitions for HNSW (each is its own graph): about one per 100k rows.
      const numPartitions = Math.max(1, Math.round(rows / 100_000));
      log(`IVF_HNSW_SQ ${numPartitions} partitions, m=20, efConstruction=300, cosine (replacing ${vectorIdx?.indexType ?? 'none'})`);
      return table.createIndex('vector', {
        config: Index.hnswSq({ distanceType: 'cosine', numPartitions, m: 20, efConstruction: 300, sampleRate: 256, maxIterations: 25 }),
        replace: true,
      });
    },
    () => /hnsw/i.test(String(vectorIdx?.indexType ?? '')));

  const after = await table.listIndices();
  log(`indices now: ${after.map((i) => `${i.name}(${i.columns})`).join(', ') || 'none'}`);
} catch (err) {
  report.failed.push(`open: ${String(err?.message ?? err).slice(0, 200)}`);
  console.error(`[index] FAILED: ${err?.message ?? err}`);
} finally {
  clearInterval(ticker);
  report.ms = Date.now() - t0;
  log(`done in ${(report.ms / 1000).toFixed(1)}s: built=${report.built.length} skipped=${report.skipped.length} failed=${report.failed.length}`);
  if (JSON_OUT) console.log(JSON.stringify(report));
  process.exit(report.failed.length ? 1 : 0);
}
