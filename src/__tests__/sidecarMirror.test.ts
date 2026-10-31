/**
 * fileSystemSideCar Task 8.3: receiver hook body on /admin/indexing/report,
 * FANTOM_HOOK_TOKEN, mirror path mapping and project registration, and the
 * FANTOM_API_TOKEN gate. Temp SQLite DB; no live server.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import express, { Router, type Request, type Response, type NextFunction } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FocusSet } from '../indexing/focusSet.js';
import { resolveLazyConfig } from '../indexing/lazyConfig.js';
import { configureFocus } from '../indexing/focusTools.js';
import { registerIndexingHookRoute, HOOK_TOKEN_ENV } from '../admin/indexingRoutes.js';
import { mirrorPaths, mirrorProjectSpecs, registerMirrorProjects } from '../indexing/mirror.js';
import { apiTokenGate } from '../auth/apiTokenGate.js';
import { createTestDb, addProject, write, type TestDb } from '../indexing/__testSupport__/lazyIndexTestDb.js';

describe('mirrorPaths', () => {
  it('maps relative paths under {root}/{sidecar}/{rootName} and rejects escapes', () => {
    const m = mirrorPaths('/mirror', 'mac', 'BAS', ['src/a.fan', 'src/a.fan', '../x', '/etc/passwd', 'C:/x', 7]);
    expect(m.base).toBe('/mirror/mac/BAS');
    expect(m.files).toEqual(['/mirror/mac/BAS/src/a.fan']);
    expect(m.rejected).toEqual(['../x', '/etc/passwd', 'C:/x', '7']);
    expect(() => mirrorPaths('/mirror', '..', 'BAS', [])).toThrow('sidecar');
    expect(() => mirrorPaths('/mirror', 'mac', 'a/b', [])).toThrow('root');
  });
});

describe('mirror projects', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('auto lists {sidecar}/{root} folders; explicit list parses name=path', () => {
    fs.mkdirSync(path.join(root, 'mac', 'BAS'), { recursive: true });
    fs.mkdirSync(path.join(root, 'mac', 'Lib'), { recursive: true });
    fs.mkdirSync(path.join(root, '.hidden', 'x'), { recursive: true });
    expect(mirrorProjectSpecs({ FANTOM_MIRROR_ROOT: root, FANTOM_MIRROR_PROJECTS: 'auto' })).toEqual([
      { name: 'mac-BAS', path: path.join(root, 'mac', 'BAS') },
      { name: 'mac-Lib', path: path.join(root, 'mac', 'Lib') },
    ]);
    expect(mirrorProjectSpecs({ FANTOM_MIRROR_PROJECTS: 'bas=/mirror/mac/BAS, /mirror/w/Q, rel' })).toEqual([
      { name: 'bas', path: '/mirror/mac/BAS' }, { name: 'Q', path: '/mirror/w/Q' },
    ]);
    expect(mirrorProjectSpecs({})).toEqual([]);
  });

  it('registers only missing, existing folders', async () => {
    fs.mkdirSync(path.join(root, 'mac', 'BAS'), { recursive: true });
    fs.mkdirSync(path.join(root, 'mac', 'Lib'), { recursive: true });
    const made: string[] = [];
    const created = await registerMirrorProjects({
      listPaths: async () => [path.join(root, 'mac', 'Lib')],
      create: async (s) => { made.push(s.name); },
    }, { FANTOM_MIRROR_ROOT: root, FANTOM_MIRROR_PROJECTS: `auto` });
    expect(created).toEqual(['mac-BAS']);
    expect(made).toEqual(['mac-BAS']);
  });
});

describe('receiver hook on /admin/indexing/report', () => {
  let db: TestDb;
  let work: string;
  let server: Server;
  let base: string;
  const saved = process.env[HOOK_TOKEN_ENV];

  beforeEach(async () => {
    db = await createTestDb();
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-hook-')));
    const lazyCfg = resolveLazyConfig({});
    configureFocus({ prisma: db.prisma, runner: () => null, config: () => lazyCfg, set: new FocusSet() });
    process.env[HOOK_TOKEN_ENV] = 'env-secret';
    const app = express();
    app.use(express.json());
    const router = Router();
    registerIndexingHookRoute(router, { configPath: () => path.join(work, 'config.json'), mirrorRoot: () => path.join(work, 'mirror') });
    app.use('/admin', router);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env[HOOK_TOKEN_ENV]; else process.env[HOOK_TOKEN_ENV] = saved;
    configureFocus(null);
    await new Promise(r => server.close(r));
    await db.close();
    fs.rmSync(work, { recursive: true, force: true });
  });

  const post = (body: unknown, token = 'env-secret') => fetch(base + '/admin/indexing/report', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fantom-Hook-Token': token }, body: JSON.stringify(body),
  });

  it('queues a per-file parse for the changed and removed mirror paths', async () => {
    const proj = path.join(work, 'mirror', 'mac', 'BAS');
    write(path.join(proj, 'src', 'a.ts'), 'export const a = 1;\n');
    const pid = await addProject(db.prisma, 'mac-BAS', proj);

    expect((await post({ sidecar: 'mac', root: 'BAS', paths: ['src/a.ts'] }, 'wrong')).status).toBe(401);
    const r = await post({ sidecar: 'mac', root: 'BAS', paths: ['src/a.ts', 'src/gone.ts', '../evil.ts'] });
    expect(r.status).toBe(202);
    const body = await r.json() as { projectId: number; queued: number; taskId: number; unknownFiles: string[] };
    expect(body).toMatchObject({ projectId: pid, queued: 2, unknownFiles: ['../evil.ts'] });
    const task = await db.prisma.indexTask.findUniqueOrThrow({ where: { id: body.taskId } });
    const p = JSON.parse(task.payload);
    expect(p.paths).toEqual([path.join(proj, 'src', 'a.ts')]);
    expect(p.removed).toEqual([path.join(proj, 'src', 'gone.ts')]);
    expect(p.reports[0]).toMatchObject({ client: 'sidecar-receiver', files: ['src/a.ts', 'src/gone.ts'] });
  });

  it('answers 202 with nothing queued for unknown roots; 400 for a bad sidecar id', async () => {
    const r = await post({ sidecar: 'mac', root: 'Nope', paths: ['a.ts'] });
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ queued: 0, unknownFiles: [expect.stringContaining('a.ts')] });
    expect((await post({ sidecar: '..', root: 'BAS', paths: ['a.ts'] })).status).toBe(400);
    // Old body shape still works.
    expect((await post({ files: ['/nowhere/x.ts'] })).status).toBe(202);
  });
});

describe('apiTokenGate', () => {
  let server: Server;
  let base: string;
  let token: string | undefined;

  beforeEach(() => {
    const app = express();
    app.use(apiTokenGate({ token: () => token }));
    const ok = (req: Request, res: Response) => { res.json({ user: req.user?.username ?? null, api: !!res.locals.apiTokenOk }); };
    app.post('/mcp', ok);
    app.get('/health', ok);
    app.post('/admin/indexing/report', ok);
    app.get("/admin/x", (req: Request, _res: Response, next: NextFunction) => {
      if (!req.user && req.headers.authorization?.startsWith('Basic ')) req.user = { id: '1', username: 'basic', role: 'admin', createdAt: '' };
      next();
    }, ok);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { await new Promise(r => server.close(r)); });

  it('is off when no token is set', async () => {
    token = undefined;
    expect((await fetch(base + '/mcp', { method: 'POST' })).status).toBe(200);
    expect((await fetch(base + '/admin/x')).status).toBe(200);
  });

  it('needs the bearer token on /mcp and /admin; leaves /health, the hook and Basic Auth', async () => {
    token = 's3cret';
    expect((await fetch(base + '/mcp', { method: 'POST' })).status).toBe(401);
    expect((await fetch(base + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
    const r = await fetch(base + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer s3cret' } });
    expect(await r.json()).toEqual({ user: null, api: true });
    expect((await fetch(base + '/admin/x')).status).toBe(401);
    expect(await (await fetch(base + '/admin/x', { headers: { Authorization: 'Bearer s3cret' } })).json()).toEqual({ user: 'api-token', api: true });
    expect(await (await fetch(base + '/admin/x', { headers: { Authorization: 'Basic eDp5' } })).json()).toEqual({ user: 'basic', api: false });
    expect((await fetch(base + '/health')).status).toBe(200);
    expect((await fetch(base + '/admin/indexing/report', { method: 'POST' })).status).toBe(200);
  });
});
