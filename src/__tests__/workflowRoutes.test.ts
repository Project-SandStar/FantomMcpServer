/** Workflow admin routes: every check goes through the ACL. */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import express, { Router, type Request, type Response, type NextFunction } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { registerWorkflowRoutes } from '../admin/workflowRoutes.js';
import { WorkflowManager } from '../workflows/workflowManager.js';
import { WorkflowAcl } from '../workflows/workflowAccess.js';

describe('workflow routes', () => {
  let dir: string; let server: Server; let base: string; let acl: WorkflowAcl; let wm: WorkflowManager;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfr-'));
    fs.writeFileSync(path.join(dir, 'glob.md'), '# Global\n\nAll.\n');
    wm = new WorkflowManager(dir); wm.loadWorkflows();
    acl = new WorkflowAcl(dir, () => null);
    acl.setMember('5', 'ann', 'editor');
    const app = express(); app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const u = req.header('x-user'); if (u) (req as any).user = { username: u, role: u === 'root' ? 'admin' : 'user' }; next();
    });
    const requireAdmin = (req: Request, res: Response, next: NextFunction) => ((req as any).user?.role === 'admin' ? next() : res.status(403).json({ error: 'admin' }));
    const r = Router(); registerWorkflowRoutes(r, () => wm, requireAdmin, () => acl); app.use('/admin', r);
    server = await new Promise(res => { const s = app.listen(0, () => res(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/admin`;
  });
  afterEach(async () => { await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

  const call = (method: string, url: string, user?: string, body?: unknown) => fetch(base + url, {
    method, headers: { 'content-type': 'application/json', ...(user ? { 'x-user': user } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });

  it('needs a user', async () => { expect((await call('GET', '/workflows')).status).toBe(401); });

  it('member creates in project, non-member cannot see it, user cannot write global', async () => {
    expect((await call('POST', '/workflows', 'ann', { scope: 'project', scopeId: '5', slug: 'run', content: '# Run\n\nGo.' })).status).toBe(201);
    expect((await call('POST', '/workflows', 'eve', { scope: 'project', scopeId: '5', slug: 'x', content: '# X' })).status).toBe(403);
    const eveList: any = await (await call('GET', '/workflows', 'eve')).json();
    expect(eveList.workflows.map((w: any) => w.id)).toEqual(['glob']);
    expect((await call('GET', '/workflows/item?id=project/5/run', 'eve')).status).toBe(404);
    expect((await call('PUT', '/workflows/glob', 'ann', { content: '# hacked' })).status).toBe(403);
    const one: any = await (await call('GET', '/workflows/item?id=project/5/run', 'ann')).json();
    expect(one.workflow.owner).toBe('ann');
    // stale save → 409
    expect((await call('PUT', '/workflows/item?id=project/5/run', 'ann', { content: '# v2', expectedMtimeMs: 1 })).status).toBe(409);
    expect((await call('PUT', '/workflows/item?id=project/5/run', 'ann', { content: '# v2', expectedMtimeMs: one.workflow.mtimeMs })).status).toBe(200);
    const h: any = await (await call('GET', '/workflows/history?id=project/5/run', 'ann')).json();
    expect(h.entries.map((e: any) => e.action)).toEqual(['update', 'create']);
  });

  it('copy built-in to project; only admins set members', async () => {
    expect((await call('POST', '/workflows/copy', 'ann', { id: 'glob', scope: 'project', scopeId: '5' })).status).toBe(201);
    expect(wm.hasWorkflow('project/5/glob')).toBe(true);
    expect((await call('PUT', '/workflows/members/5', 'ann', { username: 'eve', role: 'viewer' })).status).toBe(403);
    expect((await call('PUT', '/workflows/members/5', 'root', { username: 'eve', role: 'viewer' })).status).toBe(200);
    const eveList: any = await (await call('GET', '/workflows', 'eve')).json();
    expect(eveList.workflows.map((w: any) => w.id).sort()).toEqual(['glob', 'project/5/glob']);
  });
});
