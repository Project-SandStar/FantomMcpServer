/**
 * Fix A: search() and textSearch() return the winning chunk's text only when
 * asked (includeText), cut to RESULT_TEXT_MAX_CHARS.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fantom-vstext-'));
process.env.MCPFANTOM_CACHE_DIR = dir;

const { connect, Index } = await import('@lancedb/lancedb');
const { VectorStore, RESULT_TEXT_MAX_CHARS } = await import('../embedding/vectorStore.js');

const DIM = 16;
const vec = (i: number) => Array.from({ length: DIM }, (_, k) => (k === i % DIM ? 1 : 0.01 * ((i + k) % 7)));

beforeAll(async () => {
  const db = await connect(path.join(dir, 'fantomvector.db'));
  const rows = Array.from({ length: 40 }, (_, i) => ({
    vector: vec(i), node_id: `n${i}`, project_id: 1, node_type: 'method', row_id: `r${i}`,
    chunk_index: 0, chunk_count: 1, line_start: 1, line_end: 2, qualified_name: `q${i}`, file_path: `f${i}.fan`,
    text: i === 3 ? 'pollPoints ' + 'x'.repeat(3000) : `read value ${i}`,
  }));
  const t = await db.createTable('code_vectors', rows);
  await t.createIndex('text', { config: Index.fts({ withPosition: false }) });
}, 60_000);

afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const store = () => new VectorStore({} as never, { embed: async () => new Float32Array(DIM) } as never);

it('search() carries text only with includeText', async () => {
  const q = new Float32Array(vec(3));
  const off = await store().search(q, { limit: 3 });
  expect(off[0].nodeId).toBe('n3');
  expect(off[0].text).toBeUndefined();
  const on = await store().search(q, { limit: 3, includeText: true });
  expect(on[0].text?.startsWith('pollPoints')).toBe(true);
  expect(on[0].text?.length).toBe(RESULT_TEXT_MAX_CHARS);
});

it('textSearch() carries text only with includeText', async () => {
  const off = await store().textSearch('pollPoints', { limit: 3 });
  expect(off[0]?.nodeId).toBe('n3');
  expect(off[0].text).toBeUndefined();
  const on = await store().textSearch('pollPoints', { limit: 3, includeText: true });
  expect(on[0].text?.length).toBe(RESULT_TEXT_MAX_CHARS);
});
