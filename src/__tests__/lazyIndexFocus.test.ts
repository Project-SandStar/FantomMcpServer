/**
 * Focus set and AI change reports (lazy-incremental-indexing.md 3.11, D2,
 * D9; phase 1b): focus TTL/LRU, config, report token hash and the Basic Auth
 * bypass for the report path only, reportChanges resolution and dedupe,
 * fresh answers, runNow, and the Claude Code hook script end to end.
 * Temp SQLite DB and temp config file; no live server.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import express, { Router, type Request, type Response, type NextFunction } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FocusSet, projectForPath, relPathIn, focusDirtyRoots } from '../indexing/focusSet.js';
import { resolveLazyConfig, type LazyIndexingConfig } from '../indexing/lazyConfig.js';
import { configureFocus, reportChanges, focusCheck, focusSnapshot, isTestPath } from '../indexing/focusTools.js';
import {
  hashReportToken, verifyReportToken, createReportToken, readReportTokenHash,
  registerIndexingHookRoute, registerIndexingRoutes,
} from '../admin/indexingRoutes.js';
import { LazyIndexScheduler } from '../indexing/scheduler.js';
import { TaskQueue } from '../indexing/taskQueue.js';
import { createTestDb, addProject, write, type TestDb } from '../indexing/__testSupport__/lazyIndexTestDb.js';

describe('focus set', () => {
  it('expires entries after ttl and keeps the most recent on the LRU cap', () => {
    let t = 0;
    const s = new FocusSet({ ttlMs: 1_000, maxFiles: 3 }, () => t);
    s.touch(1, 'a.ts'); t = 100;
    s.touch(1, 'b.ts'); t = 200;
    s.touch(1, 'c.ts'); t = 300;
    s.touch(1, 'a.ts');            // a is newest again
    s.touch(2, 'd.ts');            // cap 3: b (oldest) goes
    expect(s.list().map(e => e.relPath)).toEqual(['d.ts', 'a.ts', 'c.ts']);
    expect(s.get(1, 'a.ts')?.touches).toBe(2);
    t = 1_250;                     // c (200) expired, a (300) alive
    expect(s.has(1, 'c.ts')).toBe(false);
    expect(s.has(1, 'a.ts')).toBe(true);
    t = 5_000;
    expect(s.size()).toBe(0);
    s.touch(1, 'a.ts');
    expect(s.get(1, 'a.ts')?.touches).toBe(1); // expired count does not carry over
  });

  it('resolves the longest project prefix and the dirty "focus" roots', () => {
    const ps = [{ id: 1, path: '/w/repo' }, { id: 2, path: '/w/repo/sub' }, { id: 3, path: '/w/repo2' }];
    expect(projectForPath(ps, '/w/repo/sub/x.ts')?.id).toBe(2);
    expect(projectForPath(ps, '/w/repo/x.ts')?.id).toBe(1);
    expect(projectForPath(ps, '/w/repo2/x.ts')?.id).toBe(3);
    expect(projectForPath(ps, '/w/other/x.ts')).toBeNull();
    expect(relPathIn('/w/repo', '/w/repo/a/b.ts')).toBe('a/b.ts');
    expect(relPathIn('/w/repo', '/w/repo2/b.ts')).toBeNull();
    const set = new FocusSet();
    set.touch(2, 'x.ts');
    expect(focusDirtyRoots(resolveLazyConfig({ dirty: { projects: 'focus' } }), ps, set)).toEqual([path.resolve('/w/repo/sub')]);
    expect(focusDirtyRoots(resolveLazyConfig({}), ps, set)).toEqual([]);
  });

  it('normalises focus and dirty config', () => {
    const c = resolveLazyConfig({ focus: { ttlMs: -1, maxFiles: 'x', freshWaitMs: 0, suggest: false }, dirty: { projects: 'bogus' } });
    expect(c.focus).toEqual({ ttlMs: 30 * 60_000, maxFiles: 500, freshWaitMs: 0, suggest: false });
    expect(c.dirty.projects).toBe('primary');
    expect(resolveLazyConfig({ dirty: { projects: [3, 'x', 4] } }).dirty.projects).toEqual([3, 4]);
    expect(resolveLazyConfig({}).focus.suggest).toBe(true);
    expect(isTestPath('src/__tests__/a.test.ts')).toBe(true);
    expect(isTestPath('fan/test/FooTest.fan')).toBe(true);
    expect(isTestPath('src/a.ts')).toBe(false);
  });
});

describe('report token', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-tok-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('stores only the sha256, keeps other settings, and verifies', () => {
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ port: 1, indexing: { lazy: { enabled: true } } }));
    expect(readReportTokenHash(cfg)).toBeNull();
    const { token } = createReportToken(cfg);
    const raw = fs.readFileSync(cfg, 'utf8');
    expect(raw).not.toContain(token);
    const file = JSON.parse(raw);
    expect(file.port).toBe(1);
    expect(file.indexing.lazy.enabled).toBe(true);
    expect(file.indexing.reportToken.sha256).toBe(hashReportToken(token));
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    const h = readReportTokenHash(cfg);
    expect(verifyReportToken(token, h)).toBe(true);
    expect(verifyReportToken(token + 'x', h)).toBe(false);
    expect(verifyReportToken(undefined, h)).toBe(false);
    expect(verifyReportToken(token, null)).toBe(false);
    const second = createReportToken(cfg).token; // replaces the old one
    expect(verifyReportToken(token, readReportTokenHash(cfg))).toBe(false);
    expect(verifyReportToken(second, readReportTokenHash(cfg))).toBe(true);
  });
});

/** Same mount order as createAdminRouter: hook route, Basic Auth, the rest. */
function adminApp(cfgPath: string): express.Express {
  const app = express();
  app.use(express.json());
  const router = Router();
  registerIndexingHookRoute(router, { configPath: () => cfgPath });
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (req.headers.authorization !== 'Basic ' + Buffer.from('admin:pw').toString('base64')) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    req.user = { id: '1', username: 'admin', role: 'admin', createdAt: '' };
    next();
  });
  registerIndexingRoutes(router, { configPath: () => cfgPath });
  router.get('/indexing/status', (_req, res) => { res.json({ ok: true }); });
  app.use('/admin', router);
  return app;
}

describe('admin routes + reportChanges (temp DB)', () => {
  let db: TestDb;
  let work: string;
  let cfgPath: string;
  let server: Server;
  let base: string;
  let lazyCfg: LazyIndexingConfig;
  const basic = { Authorization: 'Basic ' + Buffer.from('admin:pw').toString('base64') };

  beforeEach(async () => {
    db = await createTestDb();
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'focus-work-')));
    cfgPath = path.join(work, 'config.json');
    lazyCfg = resolveLazyConfig({});
    configureFocus({ prisma: db.prisma, runner: () => null, config: () => lazyCfg, set: new FocusSet() });
    server = adminApp(cfgPath).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    configureFocus(null);
    await new Promise(r => server.close(r));
    await db.close();
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('report path needs only the hook token; every other path needs Basic Auth', async () => {
    const post = (p: string, headers: Record<string, string>, body: unknown = {}) =>
      fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    // No token configured: refused even with Basic Auth.
    expect((await post('/admin/indexing/report', basic, { files: ['/x'] })).status).toBe(401);
    expect((await post('/admin/indexing/report-token', {})).status).toBe(401);
    const tr = await post('/admin/indexing/report-token', basic);
    expect(tr.status).toBe(200);
    const { token } = await tr.json() as { token: string };
    expect((await post('/admin/indexing/report', {}, { files: ['/x'] })).status).toBe(401);
    expect((await post('/admin/indexing/report', { 'X-Fantom-Hook-Token': 'wrong' }, { files: ['/x'] })).status).toBe(401);
    const ok = await post('/admin/indexing/report', { 'X-Fantom-Hook-Token': token }, { files: ['/nowhere/x.ts'] });
    expect(ok.status).toBe(202);
    expect(await ok.json()).toMatchObject({ projectId: null, queued: 0, unknownFiles: ['/nowhere/x.ts'] });
    // The token opens nothing else.
    expect((await fetch(base + '/admin/indexing/focus', { headers: { 'X-Fantom-Hook-Token': token } })).status).toBe(401);
    expect((await fetch(base + '/admin/indexing/status', { headers: { 'X-Fantom-Hook-Token': token } })).status).toBe(401);
    expect((await fetch(base + '/admin/indexing/report', { headers: { 'X-Fantom-Hook-Token': token } })).status).toBe(401);
    expect((await fetch(base + '/admin/indexing/focus', { headers: basic })).status).toBe(200);
  });

  it('reportChanges resolves the deepest project, dedupes per project, keeps intent', async () => {
    const outer = path.join(work, 'repo');
    const inner = path.join(outer, 'sub');
    write(path.join(outer, 'a.ts'), 'export const a = 1;\n');
    write(path.join(inner, 'b.ts'), 'export const b = 1;\n');
    write(path.join(outer, 'logo.png'), '# x\n');
    const pOuter = await addProject(db.prisma, 'outer', outer);
    const pInner = await addProject(db.prisma, 'inner', inner);

    const r1 = await reportChanges({ files: [path.join(inner, 'b.ts'), 'logo.png', '/elsewhere/c.ts'], cwd: outer, intent: 'add b', sessionId: 's1', client: 'claude-code' });
    expect(r1).toMatchObject({ projectId: pInner, queued: 1, unknownFiles: ['logo.png', '/elsewhere/c.ts'] });
    expect(r1.taskId).not.toBeNull();

    const r2 = await reportChanges({ files: ['b.ts', path.join(inner, 'gone.ts')], projectId: pInner, intent: 'fix b' });
    expect(r2.taskId).toBe(r1.taskId); // deduped into the same pending parse
    const task = await db.prisma.indexTask.findUniqueOrThrow({ where: { id: r1.taskId! } });
    expect(task.priority).toBe(10);
    const p = JSON.parse(task.payload);
    expect(p.trigger).toBe('report');
    expect(p.paths).toEqual([path.join(inner, 'b.ts')]);
    expect(p.removed).toEqual([path.join(inner, 'gone.ts')]);
    expect(p.reports.map((x: { intent: string }) => x.intent)).toEqual(['add b', 'fix b']);
    expect(p.reports[0]).toMatchObject({ sessionId: 's1', client: 'claude-code', files: ['b.ts'] });

    const r3 = await reportChanges({ files: ['a.ts', 'sub/b.ts'], cwd: outer });
    expect(r3.projects?.map(x => x.projectId).sort()).toEqual([pOuter, pInner].sort());
    expect((await focusSnapshot()).files.map(f => `${f.projectId}:${f.relPath}`)).toEqual(
      expect.arrayContaining([`${pInner}:b.ts`, `${pOuter}:a.ts`]),
    );
    await expect(reportChanges({ files: [] })).rejects.toThrow('non-empty');
    await expect(reportChanges({ files: ['a.ts'], projectId: 9999 })).rejects.toThrow('Project not found');
  });

  it('focusCheck re-parses a changed focus file, else answers stale', async () => {
    const repo = path.join(work, 'r');
    const file = path.join(repo, 'a.ts');
    write(file, 'export const a = 1;\n');
    const pid = await addProject(db.prisma, 'r', repo);
    let outcome: Promise<string> = Promise.resolve('done');
    const runs: number[] = [];
    configureFocus({
      prisma: db.prisma, config: () => lazyCfg, set: new FocusSet(),
      runner: () => ({ taskQueue: queueFor(db), runNow: async id => { runs.push(id); return outcome; } }),
    });
    expect(await focusCheck(file)).toMatchObject({ projectId: pid, focus: false, refreshed: false }); // first touch: no check
    expect(runs).toEqual([]);
    expect(await focusCheck(file)).toMatchObject({ focus: true, refreshed: true, stale: false }); // no indexed_files row = changed
    lazyCfg = resolveLazyConfig({ focus: { freshWaitMs: 30 } });
    outcome = new Promise(() => undefined);
    configureFocus({
      prisma: db.prisma, config: () => lazyCfg, set: new FocusSet(),
      runner: () => ({ taskQueue: queueFor(db), runNow: async () => outcome }),
    });
    await focusCheck(file);
    expect(await focusCheck(file)).toMatchObject({ focus: true, refreshed: false, stale: true });
  });

  it('runNow runs the report parse with trigger "report" while the flag is off', async () => {
    const repo = path.join(work, 'q');
    write(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    const pid = await addProject(db.prisma, 'q', repo);
    const calls: Array<{ id: number; trigger?: string }> = [];
    const sched = new LazyIndexScheduler({
      prisma: db.prisma,
      loadConfig: () => resolveLazyConfig({}),
      worker: {
        runIndex: async (id, opts) => {
          calls.push({ id, trigger: opts.trigger });
          return { success: true, project: { id, name: 'q', path: repo }, runId: undefined, indexResult: { functionsIndexed: 0, typesIndexed: 0, filesProcessed: 1, errors: 0, warnings: 0, duration: 0 } };
        },
        buildEmbeddings: async () => ({ processed: 0, errors: 0 }),
        heavyJobBusy: () => null,
        isProjectIndexing: () => false,
      },
    });
    configureFocus({ prisma: db.prisma, config: () => lazyCfg, set: new FocusSet(), runner: () => null });
    const r = await reportChanges({ files: [path.join(repo, 'a.ts')] });
    expect(await sched.runNow(pid)).toBe('done');
    expect(calls).toEqual([{ id: pid, trigger: 'report' }]);
    expect((await db.prisma.indexTask.findUniqueOrThrow({ where: { id: r.taskId! } })).state).toBe('done');
    expect(await sched.runNow(pid)).toBe('none');
    await sched.stop();
  });

  it('the hook script posts the edited file with the token (end to end)', async () => {
    const repo = path.join(work, 'h');
    const file = path.join(repo, 'src', 'x.ts');
    write(file, 'export const x = 1;\n');
    const pid = await addProject(db.prisma, 'h', repo);
    const { token } = createReportToken(cfgPath);
    const script = path.resolve(process.cwd(), 'scripts', 'hooks', 'fantom-report-change.sh');
    const hookJson = JSON.stringify({ session_id: 'sess-1', cwd: repo, tool_name: 'Edit', tool_input: { file_path: file } });
    const run = (env: Record<string, string>) => new Promise<void>((resolve, reject) => {
      const c = spawn('bash', [script], { env: { ...process.env, HOME: work, FANTOM_URL: base, ...env } });
      c.on('error', reject);
      c.on('exit', code => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
      c.stdin.end(hookJson);
    });
    await run({ FANTOM_REPORT_TOKEN: 'wrong' }); // refused, still exits 0
    expect(await db.prisma.indexTask.count()).toBe(0);
    await run({ FANTOM_REPORT_TOKEN: token });
    const task = await db.prisma.indexTask.findFirstOrThrow({ where: { projectId: pid, kind: 'parse' } });
    expect(JSON.parse(task.payload).reports[0]).toMatchObject({ files: ['src/x.ts'], sessionId: 'sess-1', client: 'claude-code' });
    expect(execFileSync('bash', ['-n', script]).toString()).toBe('');
  });
});

function queueFor(db: TestDb) {
  return new TaskQueue(db.prisma, { owner: 't', leaseMs: 60_000, maxAttempts: 3, backoffMs: 1_000, backoffCapMs: 10_000, heavyJobPollMs: 30_000 });
}
