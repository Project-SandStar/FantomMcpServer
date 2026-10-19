/**
 * Phase 2 re-key (lazy-incremental-indexing.md 3.8) and embed_cache (3.5):
 * vectors move to the new ids with zero provider calls, a crash between copy
 * and delete resumes cleanly, a second run is a no-op, a busy heavy-job lock
 * yields. LanceDB and SQLite in temp dirs; the reindex and embedder are fakes.
 */
import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { connect, type Connection, type Table } from '@lancedb/lancedb';

jest.setTimeout(60_000);

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fantom-rekey-'));
process.env.MCPFANTOM_CACHE_DIR = cacheDir;

const { runRekey } = await import('../indexing/rekeyMigration.js');
const { EmbedCache, textHash } = await import('../embedding/embedCache.js');
const { EMBED_TEXT_VERSION } = await import('../embedding/embeddingText.js');
const { createTestDb, addProject } = await import('../indexing/__testSupport__/lazyIndexTestDb.js');
const { runTask } = await import('../indexing/taskWorker.js');
const { TaskQueue } = await import('../indexing/taskQueue.js');
const { MemoryGuard } = await import('../indexing/memoryGuard.js');

afterAll(() => { fs.rmSync(cacheDir, { recursive: true, force: true }); });

const MODEL = 'test-model';
const vec = (n: number) => [n, n + 0.5, n + 0.25, -n];

async function freshLance(): Promise<{ conn: Connection; table: Table; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rekey-lance-'));
  const conn = await connect(dir);
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < 10; i++) {
    for (const ci of i === 0 ? [0, 1] : [0]) {
      rows.push({
        row_id: ci === 0 ? `legacy${String(i).padStart(10, '0')}` : `legacy${String(i).padStart(10, '0')}#${ci}`,
        node_id: `legacy${String(i).padStart(10, '0')}`,
        chunk_index: ci, chunk_count: i === 0 ? 2 : 1,
        project_id: 5, node_type: 'function', model: MODEL, dimensions: 4,
        qualified_name: `p::f${i}`, file_path: '/r/a.fan', text: `text ${i} ${ci}`,
        vector: vec(i * 10 + ci),
      });
    }
  }
  // A row of another project with a colliding legacy id stays untouched.
  rows.push({ ...rows[2], project_id: 6 });
  const table = await conn.createTable('code_vectors', rows);
  return { conn, table, dir };
}

function mappings() {
  return Array.from({ length: 12 }, (_, i) => ({
    legacyId: `legacy${String(i).padStart(10, '0')}`,
    newId: `new${String(i).padStart(13, '0')}`,
    symbolKey: `key${i}`, bodySha: `sha${i}`, qualifiedName: `p::f${i}`, filePath: '/r/a.fan',
  }));
}

describe('rekey', () => {
  it('copies vectors to the new ids, seeds the cache, resumes after a crash, then is a no-op', async () => {
    const db = await createTestDb();
    const { conn, table, dir } = await freshLance();
    try {
      const pid = await addProject(db.prisma, 'p', '/r');
      expect(pid).toBeLessThan(6);
      // Make the fixture's project id the real one.
      await table.update({ where: 'project_id = 5', values: { project_id: pid } });
      const cache = new EmbedCache(async () => conn);
      let reindexCalls = 0;
      const reindex = async (_id: number, sink: (m: any[]) => void) => { reindexCalls++; sink(mappings()); return { runId: 1, errors: 0 }; };
      let released = 0;
      const deps = {
        prisma: db.prisma, cache, reindex, pageSize: 4,
        acquireHeavy: () => () => { released++; },
        vectors: async () => table,
      };

      // Run 1 crashes after the first page's copy, before its delete.
      let deletes = 0;
      const crashing = new Proxy(table, {
        get(t, k) {
          if (k === 'delete') return async () => { deletes++; throw new Error('crash'); };
          const v = (t as any)[k];
          return typeof v === 'function' ? v.bind(t) : v;
        },
      });
      await expect(runRekey({ ...deps, vectors: async () => crashing as Table }, pid)).rejects.toThrow('crash');
      expect(deletes).toBe(1);
      expect(released).toBe(1);
      const proj1 = await db.prisma.fantomProject.findUnique({ where: { id: pid } });
      expect(proj1?.keyScheme).toBe(2);
      expect(proj1?.rekeyedAt).toBeNull();

      // Run 2 resumes: already-copied rows are not copied again.
      const r = await runRekey(deps, pid);
      expect(r.status).toBe('done');
      if (r.status !== 'done') return;
      expect(r.alreadyNew).toBe(5);     // page 1: legacy 0 (2 chunks) + 1..3
      expect(r.copied).toBe(6);         // legacy 4..9
      expect(r.deletedLegacy).toBe(11);
      expect(r.noVector).toBe(2);       // ids 10, 11 had no vector
      expect(r.links).toBe(12);

      const left = await table.query().where(`project_id = ${pid}`).toArray();
      expect(left.length).toBe(11);
      expect(left.every((x: any) => x.node_id.startsWith('new'))).toBe(true);
      expect(new Set(left.map((x: any) => x.row_id)).size).toBe(11);
      const chunk1 = left.find((x: any) => x.chunk_index === 1) as any;
      expect(chunk1.row_id).toBe('new0000000000000#1');
      expect(Array.from(chunk1.vector as Float32Array)).toEqual(vec(1));
      // The other project's row is untouched.
      expect(await table.countRows('project_id = 6')).toBe(1);

      const links = await db.prisma.symbolLink.findMany({ where: { projectId: pid, kind: 'rekey' } });
      expect(links.length).toBe(12);
      expect(links.find(l => l.oldKey === 'legacy0000000003')?.newNodeId).toBe('new0000000000003');

      // Zero provider calls: every embedded text is now a cache hit.
      let providerCalls = 0;
      const texts = left.map((x: any) => x.text as string);
      const out = await cache.embedThrough(MODEL, texts, async t => { providerCalls += t.length; return t.map(() => new Float32Array(4)); });
      expect(providerCalls).toBe(0);
      expect(out.hits).toBe(11);

      // Run 3: no-op, no reparse.
      const before = reindexCalls;
      expect((await runRekey(deps, pid)).status).toBe('already');
      expect(reindexCalls).toBe(before);
    } finally {
      await db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('yields while another heavy job holds the lock, without touching the project', async () => {
    const db = await createTestDb();
    try {
      const pid = await addProject(db.prisma, 'p', '/r');
      const r = await runRekey({
        prisma: db.prisma, cache: null, vectors: async () => { throw new Error('no'); },
        reindex: async () => { throw new Error('no'); },
        acquireHeavy: () => 'code-reembed (shadow)',
      }, pid);
      expect(r).toEqual({ status: 'yielded', holder: 'code-reembed (shadow)' });
      expect((await db.prisma.fantomProject.findUnique({ where: { id: pid } }))?.keyScheme).toBe(1);

      // Through the worker: the task yields, no attempt spent.
      const queue = new TaskQueue(db.prisma, { owner: 't', leaseMs: 60_000, maxAttempts: 3, backoffMs: 10, backoffCapMs: 100, heavyJobPollMs: 10 });
      await queue.enqueue({ projectId: pid, kind: 'rekey', payload: {} });
      const task = (await queue.claim(['rekey']))!;
      const out = await runTask({
        prisma: db.prisma, queue, memory: new MemoryGuard({ rssPauseMb: 1e9, heapPauseMb: 1e9, rssResumeMb: 1e9, heapResumeMb: 1e9, alertAfterMs: 1e9 }),
        runIndex: async () => { throw new Error('no'); }, buildEmbeddings: async () => ({ processed: 0, errors: 0 }),
        heavyJobBusy: () => null, isProjectIndexing: () => false, heavyJobPollMs: 10,
        rekey: async () => ({ status: 'yielded', holder: 'x' }),
      }, task);
      expect(out).toBe('yielded');
      const row = await db.prisma.indexTask.findUnique({ where: { id: task.id } });
      expect(row?.state).toBe('yielded');
      expect(row?.attempts ?? 0).toBeLessThanOrEqual(1);
    } finally {
      await db.close();
    }
  });
});

describe('embed_cache', () => {
  it('misses go to the provider once, hits never; keyed by model and text version', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embedcache-'));
    try {
      const conn = await connect(dir);
      const cache = new EmbedCache(async () => conn);
      const calls: string[][] = [];
      const embed = async (t: string[]) => { calls.push(t); return t.map((s, i) => Float32Array.from([s.length, i, 1, 2])); };

      // Lookup on a missing table is a plain miss and creates nothing.
      expect((await cache.lookup(MODEL, EMBED_TEXT_VERSION, [textHash('a')])).size).toBe(0);
      expect(await conn.tableNames()).not.toContain('embed_cache');

      const a = await cache.embedThrough(MODEL, ['aa', 'bbb', 'aa'], embed);
      expect(calls).toEqual([['aa', 'bbb']]);   // duplicate text embedded once
      expect(a.misses).toBe(2);
      expect(Array.from(a.vectors[2])).toEqual(Array.from(a.vectors[0]));

      const b = await cache.embedThrough(MODEL, ['bbb', 'cccc', 'aa'], embed);
      expect(calls[1]).toEqual(['cccc']);
      expect(b.hits).toBe(2);
      expect(Array.from(b.vectors[0])).toEqual([3, 1, 1, 2]);

      // Another model or text version is a different key.
      await cache.embedThrough('other', ['aa'], embed);
      await cache.embedThrough(MODEL, ['aa'], embed, EMBED_TEXT_VERSION + 1);
      expect(calls.length).toBe(4);

      // Disabled: no lookup, no write.
      const off = new EmbedCache(async () => conn, () => false);
      await off.embedThrough(MODEL, ['aa'], embed);
      expect(calls.length).toBe(5);
      expect(await (await conn.openTable('embed_cache')).countRows()).toBe(5);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
