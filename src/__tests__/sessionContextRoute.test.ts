/**
 * GET /admin/indexing/context (claudePlugin SessionStart hook) and
 * buildSessionContext: project by longest prefix, lazy flag, token auth.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import express, { Router } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createReportToken, registerIndexingHookRoute } from '../admin/indexingRoutes.js';
import { buildSessionContext } from '../admin/sessionContext.js';
import { resolveLazyConfig } from '../indexing/lazyConfig.js';
import { configureFocus } from '../indexing/focusTools.js';
import { FocusSet } from '../indexing/focusSet.js';
import { createTestDb, addProject, type TestDb } from '../indexing/__testSupport__/lazyIndexTestDb.js';

describe('session context', () => {
  let db: TestDb;
  let work: string;
  let cfgPath: string;
  let server: Server | null = null;
  let base = '';
  let token = '';
  let outer = 0;
  let inner = 0;

  beforeEach(async () => {
    db = await createTestDb();
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-ctx-'));
    const outerDir = path.join(work, 'outer');
    const innerDir = path.join(outerDir, 'inner');
    fs.mkdirSync(innerDir, { recursive: true });
    outer = await addProject(db.prisma, 'outer', outerDir);
    inner = await addProject(db.prisma, 'inner', innerDir, 'fantom');
    cfgPath = path.join(work, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ indexing: { lazy: { enabled: true, projects: [inner] } } }));
    token = createReportToken(cfgPath).token;
    const lazyCfg = resolveLazyConfig({ enabled: true, projects: [inner] });
    const set = new FocusSet();
    set.touch(inner, 'a.fan');
    configureFocus({ prisma: db.prisma, runner: () => null, config: () => lazyCfg, set });

    const app = express();
    app.use(express.json());
    const router = Router();
    registerIndexingHookRoute(router, { configPath: () => cfgPath, prisma: () => db.prisma });
    app.use('/admin', router);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    configureFocus(null);
    await new Promise<void>(r => server ? server.close(() => r()) : r());
    await db.close();
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('buildSessionContext picks the deepest project and reads the lazy flag', async () => {
    const lazyCfg = resolveLazyConfig({ enabled: true, projects: [inner] });
    const deep = await buildSessionContext({ prisma: db.prisma, cwd: path.join(work, 'outer', 'inner', 'src'), lazyConfig: lazyCfg, version: 't' });
    expect(deep.project?.id).toBe(inner);
    expect(deep.project?.lazy).toBe(true);
    expect(deep.project?.language).toBe('fantom');
    expect(deep.project?.lastRun).toBeNull();
    expect(deep.projects.map(p => p.id).sort()).toEqual([outer, inner].sort());
    expect(deep.version).toBe('t');

    const shallow = await buildSessionContext({ prisma: db.prisma, cwd: path.join(work, 'outer'), lazyConfig: lazyCfg });
    expect(shallow.project?.id).toBe(outer);
    expect(shallow.project?.lazy).toBe(false);

    const none = await buildSessionContext({ prisma: db.prisma, cwd: work, lazyConfig: lazyCfg });
    expect(none.project).toBeNull();
    expect(none.projects).toHaveLength(2);
  });

  it('the route needs the hook token and a cwd, and counts focus files', async () => {
    const cwd = encodeURIComponent(path.join(work, 'outer', 'inner'));
    expect((await fetch(`${base}/admin/indexing/context?cwd=${cwd}`)).status).toBe(401);
    expect((await fetch(`${base}/admin/indexing/context?cwd=${cwd}`, { headers: { 'X-Fantom-Hook-Token': token + 'x' } })).status).toBe(401);
    expect((await fetch(`${base}/admin/indexing/context`, { headers: { 'X-Fantom-Hook-Token': token } })).status).toBe(400);

    const r = await fetch(`${base}/admin/indexing/context?cwd=${cwd}`, { headers: { 'X-Fantom-Hook-Token': token } });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = await r.json() as any;
    expect(body.ok).toBe(true);
    expect(body.project.id).toBe(inner);
    expect(body.project.name).toBe('inner');
    expect(body.project.lazy).toBe(true);
    expect(body.project.focusFiles).toBe(1);
    expect(typeof body.version).toBe('string');
    expect(body.projects).toHaveLength(2);
  });
});
