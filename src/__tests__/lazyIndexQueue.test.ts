/**
 * Lazy indexing queue and back-pressure (lazy-incremental-indexing.md 3.3,
 * 3.10): dedupe, lease, retry, yield; memory guard pause/resume; the worker
 * yields on a heavy job without spending an attempt. Temp SQLite DB.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { TaskQueue, mergePayload, backoffDelayMs } from '../indexing/taskQueue.js';
import { MemoryGuard, type MemorySample } from '../indexing/memoryGuard.js';
import { runTask, type WorkerDeps } from '../indexing/taskWorker.js';
import { resolveLazyConfig, isLazyEnabledFor, setLazyIndexing, loadLazyConfig } from '../indexing/lazyConfig.js';
import { createTestDb, addProject, type TestDb } from '../indexing/__testSupport__/lazyIndexTestDb.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const THRESH = { rssPauseMb: 2560, heapPauseMb: 1536, rssResumeMb: 2048, heapResumeMb: 1280, alertAfterMs: 600_000 };

describe('memory guard', () => {
  it('pauses above either limit and resumes only below both', () => {
    let s: MemorySample = { rssMb: 1000, heapMb: 500 };
    const g = new MemoryGuard(THRESH, () => s);
    expect(g.check().paused).toBe(false);
    s = { rssMb: 2600, heapMb: 500 };
    expect(g.check()).toMatchObject({ paused: true, reason: 'memory' });
    s = { rssMb: 2300, heapMb: 500 }; // below pause, above resume: hysteresis holds
    expect(g.check().paused).toBe(true);
    s = { rssMb: 1900, heapMb: 1400 }; // rss ok, heap above resume
    expect(g.check().paused).toBe(true);
    s = { rssMb: 1900, heapMb: 1000 };
    expect(g.check().paused).toBe(false);
    s = { rssMb: 1000, heapMb: 1600 }; // heap alone pauses
    expect(g.check().paused).toBe(true);
  });
});

describe('lazy config', () => {
  it('is off by default and gates on the allow-list', () => {
    expect(resolveLazyConfig(undefined).enabled).toBe(false);
    const c = resolveLazyConfig({ enabled: true, projects: [275], git: { debounceMs: 500 } });
    expect(c.git.debounceMs).toBe(500);
    expect(c.git.reflogTail).toBe(64);
    expect(isLazyEnabledFor(275, c)).toBe(true);
    expect(isLazyEnabledFor(1, c)).toBe(false);
    expect(isLazyEnabledFor(1, resolveLazyConfig({ enabled: true, projects: 'all' }))).toBe(true);
  });
  it('writes only indexing.lazy, keeping other keys', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-cfg-'));
    const file = path.join(dir, 'cfg.json');
    fs.writeFileSync(file, JSON.stringify({ settings: { a: 1 }, indexing: { other: true } }));
    setLazyIndexing({ enabled: true, projects: [275] }, file);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw.settings).toEqual({ a: 1 });
    expect(raw.indexing.other).toBe(true);
    expect(loadLazyConfig(file)).toMatchObject({ enabled: true, projects: [275] });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('task queue', () => {
  let db: TestDb;
  let pid: number;
  let clock: Date;
  let q: TaskQueue;
  const mk = (owner = 'w1') => new TaskQueue(db.prisma, {
    owner, leaseMs: 60_000, maxAttempts: 3, backoffMs: 1_000, backoffCapMs: 10_000, heavyJobPollMs: 30_000, now: () => clock,
  });

  beforeEach(async () => {
    db = await createTestDb();
    pid = await addProject(db.prisma, 'p', '/tmp/p');
    clock = new Date('2026-10-15T12:00:00Z');
    q = mk();
  });
  afterEach(async () => { await db.close(); });

  it('dedupes per (project, kind) and merges path lists', async () => {
    const a = await q.enqueue({ projectId: pid, kind: 'parse', payload: { source: 'git', rootId: 1, paths: ['/a', '/b'], removed: ['/x'] } });
    const b = await q.enqueue({ projectId: pid, kind: 'parse', priority: 10, payload: { source: 'mtime', rootId: null, paths: ['/x', '/c'], removed: ['/b'] } });
    expect(a.action).toBe('created');
    expect(b).toMatchObject({ id: a.id, action: 'merged' });
    const row = (await q.get(a.id!))!;
    const p = JSON.parse(row.payload);
    expect(p.paths.sort()).toEqual(['/a', '/b', '/c', '/x']);
    expect(p.removed).toEqual([]); // listed again → a candidate; the hash gate decides
    expect(p.source).toBe('git');
    expect(row.priority).toBe(10);
    expect(await db.prisma.indexTask.count()).toBe(1);
  });

  it('a full-reindex cancels pending parse and swallows later parses', async () => {
    await q.enqueue({ projectId: pid, kind: 'parse', payload: { paths: ['/a'] } });
    const f = await q.enqueue({ projectId: pid, kind: 'full-reindex', priority: 90, payload: { full: true } });
    expect(f.cancelled).toBe(1);
    const later = await q.enqueue({ projectId: pid, kind: 'parse', payload: { paths: ['/b'], git: { toCommit: 'abc' }, rootId: 3 } });
    expect(later).toMatchObject({ id: f.id, action: 'skipped' });
    expect(JSON.parse((await q.get(f.id!))!.payload).git.toCommit).toBe('abc');
  });

  it('claims by priority, leases, and frees the key for a new row', async () => {
    const lo = await q.enqueue({ projectId: pid, kind: 'embed', priority: 50 });
    const hi = await q.enqueue({ projectId: pid, kind: 'parse', priority: 10 });
    const t = (await q.claim(['parse', 'embed']))!;
    expect(t.id).toBe(hi.id);
    expect(t).toMatchObject({ state: 'running', leaseOwner: 'w1', dedupeKey: null });
    // While it runs a new parse gets its own pending row.
    const again = await q.enqueue({ projectId: pid, kind: 'parse' });
    expect(again.action).toBe('created');
    expect((await q.claim(['embed']))!.id).toBe(lo.id);
  });

  it('retries with backoff, then fails after maxAttempts', async () => {
    const { id } = await q.enqueue({ projectId: pid, kind: 'parse' });
    for (let i = 1; i <= 3; i++) {
      const t = (await q.claim(['parse']))!;
      expect(t.id).toBe(id);
      const st = await q.fail(id!, `boom ${i}`);
      const row = (await q.get(id!))!;
      expect(row.attempts).toBe(i);
      if (i < 3) {
        expect(st).toBe('pending');
        expect(row.nextRunAt.getTime() - clock.getTime()).toBe(backoffDelayMs(i, 1_000, 10_000));
        expect(await q.claim(['parse'])).toBeNull(); // not due yet
        clock = new Date(row.nextRunAt.getTime());
      } else {
        expect(st).toBe('failed');
      }
    }
  });

  it('yield spends no attempt and comes back after the poll delay', async () => {
    const { id } = await q.enqueue({ projectId: pid, kind: 'embed' });
    await q.claim(['embed']);
    expect(await q.yieldTask(id!, { reason: 'heavy-job', detail: 'code-reembed' })).toBe('yielded');
    const row = (await q.get(id!))!;
    expect(row.attempts).toBe(0);
    expect(JSON.parse(row.result!).paused).toBe('heavy-job');
    expect(await q.claim(['embed'])).toBeNull();
    clock = new Date(clock.getTime() + 30_000);
    expect((await q.claim(['embed']))!.id).toBe(id);
  });

  it('a yielded row folds into a newer pending row of the same key', async () => {
    const first = await q.enqueue({ projectId: pid, kind: 'parse', payload: { paths: ['/a'] } });
    await q.claim(['parse']);
    const second = await q.enqueue({ projectId: pid, kind: 'parse', payload: { paths: ['/b'] } });
    expect(await q.yieldTask(first.id!, { reason: 'memory' })).toBe('cancelled');
    expect(JSON.parse((await q.get(second.id!))!.payload).paths.sort()).toEqual(['/a', '/b']);
  });

  it('a yielded rekey survives a pending full-reindex (only parse/embed are superseded)', async () => {
    const rk = await q.enqueue({ projectId: pid, kind: 'rekey' as never });
    await q.claim(['rekey' as never]);
    await q.enqueue({ projectId: pid, kind: 'full-reindex' });
    expect(await q.yieldTask(rk.id!, { reason: 'heavy-job', detail: 'axon-index' })).toBe('yielded');
    expect((await q.get(rk.id!))!.state).toBe('yielded');
  });

  it('recovers a stale lease from a dead process', async () => {
    const { id } = await q.enqueue({ projectId: pid, kind: 'parse' });
    await q.claim(['parse']);
    const other = mk('w2');
    expect(await other.recoverStaleLeases()).toBe(1);
    const row = (await other.get(id!))!;
    expect(row).toMatchObject({ state: 'pending', attempts: 1, leaseOwner: null });
  });

  it('merges payloads deterministically', () => {
    expect(mergePayload({ paths: ['/a'], full: false }, { paths: ['/b'], full: true }).full).toBe(true);
  });

  describe('worker back-pressure', () => {
    const deps = (over: Partial<WorkerDeps>): WorkerDeps => ({
      prisma: db.prisma, queue: q,
      memory: new MemoryGuard(THRESH, () => ({ rssMb: 100, heapMb: 50 })),
      runIndex: async () => { throw new Error('not expected'); },
      buildEmbeddings: async () => ({ processed: 3, errors: 0 }),
      heavyJobBusy: () => null,
      isProjectIndexing: () => false,
      heavyJobPollMs: 30_000,
      ...over,
    });

    it('a heavy job yields the task without an attempt', async () => {
      const { id } = await q.enqueue({ projectId: pid, kind: 'embed' });
      const t = (await q.claim(['embed']))!;
      let called = false;
      const out = await runTask(deps({ heavyJobBusy: () => 'code-reembed (full)', buildEmbeddings: async () => { called = true; return { processed: 0, errors: 0 }; } }), t);
      expect(out).toBe('yielded');
      expect(called).toBe(false);
      expect((await q.get(id!))!).toMatchObject({ state: 'yielded', attempts: 0 });
    });

    it('memory pause yields; after resume the embed runs and completes', async () => {
      let s: MemorySample = { rssMb: 3000, heapMb: 100 };
      const memory = new MemoryGuard(THRESH, () => s);
      const { id } = await q.enqueue({ projectId: pid, kind: 'embed', payload: { runId: null } });
      expect(await runTask(deps({ memory }), (await q.claim(['embed']))!)).toBe('yielded');
      expect(JSON.parse((await q.get(id!))!.result!).paused).toBe('memory');
      s = { rssMb: 1000, heapMb: 100 };
      clock = new Date(clock.getTime() + 30_000);
      expect(await runTask(deps({ memory }), (await q.claim(['embed']))!)).toBe('done');
      const row = (await q.get(id!))!;
      expect(row.state).toBe('done');
      expect(JSON.parse(row.result!).processed).toBe(3);
    });

    it('an embed that stood down mid-batch yields, a throw retries', async () => {
      const { id } = await q.enqueue({ projectId: pid, kind: 'embed' });
      expect(await runTask(deps({ buildEmbeddings: async () => ({ processed: 1, errors: 0, yielded: 9 }) }), (await q.claim(['embed']))!)).toBe('yielded');
      expect((await q.get(id!))!.attempts).toBe(0);
      clock = new Date(clock.getTime() + 30_000);
      expect(await runTask(deps({ buildEmbeddings: async () => { throw new Error('sidecar down'); } }), (await q.claim(['embed']))!)).toBe('retry');
      expect((await q.get(id!))!).toMatchObject({ state: 'pending', attempts: 1, error: 'sidecar down' });
    });

    it('a parse task runs runIndex with the git context and moves the base', async () => {
      const root = await db.prisma.gitRoot.create({ data: { root: '/tmp/p', gitDir: '/tmp/p/.git', gitCommonDir: '/tmp/p/.git' } });
      await db.prisma.projectGitState.create({ data: { projectId: pid, rootId: root.id, lastIndexedCommit: 'a'.repeat(40) } });
      const git = {
        root: '/tmp/p', gitDir: '/tmp/p/.git', gitCommonDir: '/tmp/p/.git', fromCommit: 'a'.repeat(40), toCommit: 'b'.repeat(40),
        branch: 'main', headMove: { kind: 'edit', reflog: 'commit: x', linear: true }, dirty: false, commits: [],
      };
      await q.enqueue({ projectId: pid, kind: 'parse', payload: { source: 'git', rootId: root.id, paths: [], removed: [], git } });
      let seen: any = null;
      const out = await runTask(deps({
        runIndex: async (_id, opts) => {
          seen = opts;
          return { success: true, project: { id: pid, name: 'p', path: '/tmp/p' }, runId: 7, changedFiles: [], removedFiles: [], indexResult: { functionsIndexed: 0, typesIndexed: 0, filesProcessed: 1, errors: 0, warnings: 0, duration: 1 } };
        },
      }), (await q.claim(['parse']))!);
      expect(out).toBe('done');
      expect(seen.trigger).toBe('git');
      expect(seen.lazy).toMatchObject({ changeSource: 'git', gitFromCommit: 'a'.repeat(40), gitCommit: 'b'.repeat(40), headMove: 'edit', checkout: false });
      const st = await db.prisma.projectGitState.findFirst({ where: { projectId: pid } });
      expect(st!.lastIndexedCommit).toBe('b'.repeat(40));
    });

    it('a failed parse leaves the base where it was', async () => {
      const root = await db.prisma.gitRoot.create({ data: { root: '/tmp/q', gitDir: '/tmp/q/.git', gitCommonDir: '/tmp/q/.git' } });
      await db.prisma.projectGitState.create({ data: { projectId: pid, rootId: root.id, lastIndexedCommit: 'a'.repeat(40) } });
      await q.enqueue({ projectId: pid, kind: 'parse', payload: { source: 'git', rootId: root.id, git: { toCommit: 'c'.repeat(40), headMove: { kind: 'edit' } } } });
      const out = await runTask(deps({
        runIndex: async () => ({ success: false, project: { id: pid, name: 'p', path: '/tmp/q' }, indexResult: { functionsIndexed: 0, typesIndexed: 0, filesProcessed: 0, errors: 2, warnings: 0, duration: 1 } }),
      }), (await q.claim(['parse']))!);
      expect(out).toBe('retry');
      expect((await db.prisma.projectGitState.findFirst({ where: { rootId: root.id } }))!.lastIndexedCommit).toBe('a'.repeat(40));
    });
  });
});
