/**
 * The code-table indexes are built in a child process (scripts/build-vector-index.mjs).
 * This runs the real script against a small temp table: ANN, FTS and the
 * scalar indexes get built once, and a second run skips them all.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fantom-index-'));
process.env.MCPFANTOM_CACHE_DIR = dir;

const { connect } = await import('@lancedb/lancedb');
const { buildCodeTableIndexes, lastIndexBuild } = await import('../embedding/indexBuild.js');

beforeAll(async () => {
  const db = await connect(path.join(dir, 'fantomvector.db'));
  const rows = Array.from({ length: 6000 }, (_, i) => ({
    vector: Array.from({ length: 128 }, () => Math.random()),
    project_id: i % 5,
    node_id: `n${i}`,
    node_type: i % 3 ? 'method' : 'class',
    text: i === 7 ? 'pollPoints keeps polling the points every second' : `fn${i} read value ${i % 40}`,
  }));
  await db.createTable('code_vectors_b', rows);
}, 60_000);

afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

it('builds ANN, FTS and scalar indexes, then skips them on a second run', async () => {
  const first = await buildCodeTableIndexes('code_vectors_b', { log: () => {} });
  expect(first.failed).toEqual([]);
  expect(first.rows).toBe(6000);
  for (const name of ['btree(project_id)', 'btree(node_id)', 'bitmap(node_type)', 'fts(text)', 'ivf_hnsw_sq(vector)']) {
    expect(first.built.some(b => b.startsWith(name))).toBe(true);
  }
  const second = await buildCodeTableIndexes('code_vectors_b', { log: () => {} });
  expect(second.built).toEqual([]);
  expect(second.skipped).toHaveLength(5);
  expect(lastIndexBuild()?.table).toBe('code_vectors_b');
}, 120_000);

it('FTS stems English and drops stop words: "polled" finds "polling"', async () => {
  const db = await connect(path.join(dir, 'fantomvector.db'));
  const t = await db.openTable('code_vectors_b');
  const hits = await t.query().fullTextSearch('how are points polled', { columns: 'text' }).select(['node_id']).limit(5).toArray();
  expect(hits.map(h => h.node_id)).toContain('n7');
  const markers = JSON.parse(fs.readFileSync(path.join(dir, 'fantomvector.db', '.fts-config.json'), 'utf-8'));
  expect(markers.code_vectors_b).toBe('en-stem-stop-v1');
});

it('rebuilds an FTS index that has no current-config marker', async () => {
  const p = path.join(dir, 'fantomvector.db', '.fts-config.json');
  fs.writeFileSync(p, JSON.stringify({ code_vectors_b: 'old' }));
  const r = await buildCodeTableIndexes('code_vectors_b', { log: () => {} });
  expect(r.built.some(b => b.startsWith('fts(text)'))).toBe(true);
  expect(r.built).toHaveLength(1);
});

it('replaces an old IVF_PQ vector index with IVF_HNSW_SQ', async () => {
  const { Index } = await import('@lancedb/lancedb');
  const db = await connect(path.join(dir, 'fantomvector.db'));
  const rows = Array.from({ length: 6000 }, (_, i) => ({ vector: Array.from({ length: 128 }, () => Math.random()), project_id: i % 5, node_id: `m${i}` }));
  const t = await db.createTable('code_vectors', rows);
  await t.createIndex('vector', { config: Index.ivfPq({ distanceType: 'cosine', numPartitions: 10, numSubVectors: 16 }) });
  const r = await buildCodeTableIndexes('code_vectors', { log: () => {} });
  expect(r.failed).toEqual([]);
  expect(r.built.some(b => b.startsWith('ivf_hnsw_sq(vector)'))).toBe(true);
  const t2 = await db.openTable('code_vectors');
  const vec = (await t2.listIndices()).find(i => i.columns.includes('vector'));
  expect(String(vec?.indexType)).toMatch(/hnsw/i);
}, 120_000);

it('refuses a table name that is not a code slot', async () => {
  const r = await buildCodeTableIndexes('docs_vectors', { log: () => {} });
  expect(r.exitCode).not.toBe(0);
}, 60_000);
