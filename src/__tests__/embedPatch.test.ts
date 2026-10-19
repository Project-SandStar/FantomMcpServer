/**
 * Phase 4 (lazy-incremental-indexing.md 3.5): embedPatch embeds only changed
 * text through embed_cache, a moved symbol keeps its vector (cache hit, no
 * provider call), orphans of patched/removed files go, vector-gc deletes what
 * no graph node claims, cache-prune keeps the LRU cap, and the worker runs
 * both tasks but yields them while a heavy job holds the lock.
 * SQLite and LanceDB in temp dirs; the embedder and vector store are fakes.
 */
import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { connect } from '@lancedb/lancedb';

jest.setTimeout(60_000);

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fantom-embpatch-'));
process.env.MCPFANTOM_CACHE_DIR = cacheDir;
afterAll(() => { fs.rmSync(cacheDir, { recursive: true, force: true }); });

const { embedPatch, gcVectors, findOrphans, readAllVectorStateIds } = await import('../indexing/embedPatch.js');
const { EmbedCache, embedCacheCapBytes } = await import('../embedding/embedCache.js');
const { fileNodeId } = await import('../embedding/embeddingText.js');
const { createTestDb, addProject } = await import('../indexing/__testSupport__/lazyIndexTestDb.js');
const { runTask } = await import('../indexing/taskWorker.js');
const { TaskQueue } = await import('../indexing/taskQueue.js');
const { MemoryGuard } = await import('../indexing/memoryGuard.js');

const MODEL = 'test-model';
const item = (nodeId: string, text: string, filePath = 'a.ts', chunkIndex = 0, chunkCount = 1) =>
  ({ nodeId, nodeType: 'function', qualifiedName: nodeId, filePath, chunkIndex, chunkCount, lineStart: 1, lineEnd: 2, text });

function fakeStore() {
  const rows = new Map<string, number>();
  const provider: string[] = [];
  return {
    rows, provider,
    embed: async (texts: string[]) => { provider.push(...texts); return texts.map((_, i) => Float32Array.from([i, 1, 2, 3])); },
    store: async (items: Array<{ nodeId: string }>) => { for (const i of items) rows.set(i.nodeId, (rows.get(i.nodeId) ?? 0) + 1); return items.length; },
    deleteVectors: async (ids: string[]) => { let n = 0; for (const id of ids) if (rows.delete(id)) n++; return n; },
  };
}

const memory = () => new MemoryGuard({ rssPauseMb: 1e9, heapPauseMb: 1e9, rssResumeMb: 1e9, heapResumeMb: 1e9, alertAfterMs: 1e9 });

describe('embedPatch (3.5)', () => {
  it('unchanged text is skipped, changed text embeds, a moved symbol hits the cache, orphans go', async () => {
    const db = await createTestDb();
    const lanceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'embpatch-lance-'));
    try {
      const pid = await addProject(db.prisma, 'p', '/tmp/p');
      const conn = await connect(lanceDir);
      const cache = new EmbedCache(async () => conn);
      const s = fakeStore();
      const deps = { prisma: db.prisma, model: MODEL, cache, embed: s.embed, store: s.store, deleteVectors: s.deleteVectors };

      // Run 1: two nodes, one with two chunks.
      let r = await embedPatch(deps, { projectId: pid, items: [item('n1', 'alpha'), item('n2', 'b0', 'a.ts', 0, 2), item('n2', 'b1', 'a.ts', 1, 2)], filePaths: ['a.ts'] });
      expect(r).toMatchObject({ nodes: 2, unchanged: 0, embeddedNodes: 2, providerTexts: 3 });

      // Run 2: same text → nothing embedded, no provider call.
      s.provider.length = 0;
      r = await embedPatch(deps, { projectId: pid, items: [item('n1', 'alpha'), item('n2', 'b0', 'a.ts', 0, 2), item('n2', 'b1', 'a.ts', 1, 2)], filePaths: ['a.ts'] });
      expect(r).toMatchObject({ unchanged: 2, embeddedNodes: 0, providerTexts: 0 });
      expect(s.provider).toEqual([]);

      // Run 3: n1 changes; n2 moves to b.ts under a new id (same text) → cache hit.
      r = await embedPatch(deps, {
        projectId: pid,
        items: [item('n1', 'alpha v2'), item('n2moved', 'b0', 'b.ts', 0, 2), item('n2moved', 'b1', 'b.ts', 1, 2)],
        filePaths: ['a.ts', 'b.ts'],
      });
      expect(s.provider).toEqual(['alpha v2']);
      expect(r.cacheHits).toBe(2);
      expect(r.embeddedNodes).toBe(2);
      expect(r.orphansDeleted).toBe(1); // n2's old rows
      expect(s.rows.has('n2')).toBe(false);
      expect((await readAllVectorStateIds(db.prisma, pid)).sort()).toEqual(['n1', 'n2moved']);

      // Removed file: its state rows and the file node go.
      s.rows.set(fileNodeId('b.ts'), 1);
      r = await embedPatch(deps, { projectId: pid, items: [], removedPaths: ['b.ts'] });
      expect(r.orphansDeleted).toBe(2);
      expect(await readAllVectorStateIds(db.prisma, pid)).toEqual(['n1']);

      // mustEmbed re-embeds a node whose vector was dropped even though state matches.
      s.provider.length = 0;
      r = await embedPatch({ ...deps, cache: null }, { projectId: pid, items: [item('n1', 'alpha v2')], mustEmbed: new Set(['n1']) });
      expect(r.embeddedNodes).toBe(1);
      expect(s.provider).toEqual(['alpha v2']);
    } finally {
      await db.close();
      fs.rmSync(lanceDir, { recursive: true, force: true });
    }
  });
});

describe('vector-gc and orphans (getIndexHealth)', () => {
  it('finds and deletes vectors and state no graph node claims; an empty graph deletes nothing', async () => {
    const db = await createTestDb();
    try {
      const pid = await addProject(db.prisma, 'p', '/tmp/p');
      const s = fakeStore();
      await embedPatch({ prisma: db.prisma, model: MODEL, embed: s.embed, store: s.store, deleteVectors: s.deleteVectors },
        { projectId: pid, items: [item('live', 'x'), item('dead', 'y')] });
      s.rows.set('ghost', 1);
      s.rows.set(fileNodeId('a.ts'), 1);
      s.rows.set('project:1', 1);
      let graph = { ids: new Set(['live']), filePaths: new Set(['a.ts']) };
      const deps = {
        prisma: db.prisma,
        graph: async () => graph,
        vectorIds: async () => new Set(s.rows.keys()),
        deleteVectors: async (_p: number, ids: string[]) => s.deleteVectors(ids),
      };
      const o = await findOrphans(deps, pid);
      expect(o.vectorOrphans.sort()).toEqual(['dead', 'ghost']);
      expect(o.stateOrphans).toEqual(['dead']);
      expect(await gcVectors(deps, pid)).toEqual({ vectorsDeleted: 2, stateDeleted: 1 });
      expect((await findOrphans(deps, pid)).vectorOrphans).toEqual([]);

      graph = { ids: new Set(), filePaths: new Set() };
      expect(await gcVectors(deps, pid)).toEqual({ vectorsDeleted: 0, stateDeleted: 0 });
      expect(s.rows.has('live')).toBe(true);
    } finally {
      await db.close();
    }
  });
});

describe('cache-prune (3.5)', () => {
  it('cap = min(2 GB, 10 % of free disk), or the configured MB', async () => {
    expect(await embedCacheCapBytes(0, 100 * 1024 ** 3)).toBe(2048 * 1048576);
    expect(await embedCacheCapBytes(0, 5 * 1024 ** 3)).toBe(Math.floor(5 * 1024 ** 3 * 0.1));
    expect(await embedCacheCapBytes(10)).toBe(10 * 1048576);
  });

  it('deletes least-recently-used rows until under the cap; a hit refreshes a row', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-lance-'));
    try {
      const conn = await connect(dir);
      const cache = new EmbedCache(async () => conn);
      const v = () => [Float32Array.from([1, 2, 3, 4])];
      for (const t of ['t0', 't1', 't2', 't3']) {
        await cache.embedThrough(MODEL, [t], async () => v());
        await new Promise(r => setTimeout(r, 5));
      }
      await cache.embedThrough(MODEL, ['t0'], async () => { throw new Error('should hit'); }); // refresh t0
      await new Promise(r => setTimeout(r, 200)); // touch is queued
      const before = await cache.size();
      expect(before.rows).toBe(4);
      const per = before.bytes / 4;
      const r = await cache.prune(per * 2);
      expect(r.rowsDeleted).toBe(2);
      expect(r.bytesAfter).toBeLessThanOrEqual(per * 2);
      // t0 survived (recently used), t1/t2 went.
      const calls: string[] = [];
      await cache.embedThrough(MODEL, ['t0', 't1', 't3'], async miss => { calls.push(...miss); return miss.map(() => v()[0]); });
      expect(calls).toEqual(['t1']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('worker: vector-gc and cache-prune tasks', () => {
  it('run when idle and yield while a heavy job holds the lock', async () => {
    const db = await createTestDb();
    try {
      const pid = await addProject(db.prisma, 'p', '/tmp/p');
      const queue = new TaskQueue(db.prisma, { owner: 't', leaseMs: 60_000, maxAttempts: 3, backoffMs: 10, backoffCapMs: 100, heavyJobPollMs: 10 });
      let heavy: string | null = 'axon-index (all)';
      let pruned = 0;
      let gc = 0;
      const deps = {
        prisma: db.prisma, queue, memory: memory(),
        runIndex: async () => { throw new Error('no'); }, buildEmbeddings: async () => ({ processed: 0, errors: 0 }),
        heavyJobBusy: () => heavy, isProjectIndexing: () => false, heavyJobPollMs: 10,
        vectorGc: async () => { gc++; return { vectorsDeleted: 3, stateDeleted: 1 }; },
        cachePrune: async () => { pruned++; return { rowsDeleted: 0 }; },
      };
      await queue.enqueue({ projectId: pid, kind: 'cache-prune', payload: {} });
      let task = (await queue.claim(['cache-prune']))!;
      expect(await runTask(deps as any, task)).toBe('yielded');
      expect(pruned).toBe(0);

      heavy = null;
      await new Promise(r => setTimeout(r, 30));
      task = (await queue.claim(['cache-prune']))!;
      expect(task).toBeTruthy();
      expect(await runTask(deps as any, task)).toBe('done');
      expect(pruned).toBe(1);

      await queue.enqueue({ projectId: pid, kind: 'vector-gc', payload: {} });
      task = (await queue.claim(['vector-gc']))!;
      expect(await runTask(deps as any, task)).toBe('done');
      expect(gc).toBe(1);
    } finally {
      await db.close();
    }
  });
});
