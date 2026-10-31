/**
 * Sidecar sync admin routes (fileSystemSideCar docs/admin-screens.md):
 * mirror project settings, reload, and the receiver status proxy against a
 * fake receiver. Temp config file; no live server or database.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import express, { Router, type Request, type Response, type NextFunction } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { registerSidecarSyncRoutes, filterStatus, cleanRoots } from '../admin/sidecarSyncRoutes.js';
import { UserStore } from '../admin/userStore.js';

const FEED = {
  version: '0.1.0', uptime_s: 60,
  sidecars: [
    { id: 'mac', connected: true, last_seen_ms: 1, roots: [
      { name: 'BAS', target: 'fantom', company: null, files: 3, bytes: 10, last_path: 'a.fan', last_change_ms: 2, hook: { ok: true, last_ms: 2, error: null } },
      { name: 'Books', target: 'quickbooks', company: 'Acme', files: 1, bytes: 1, last_path: 'x.pdf', last_change_ms: 2, hook: null },
    ] },
    { id: 'win', connected: false, last_seen_ms: 1, roots: [{ name: 'Q', target: 'axon', files: 1, bytes: 1 }] },
  ],
  recent: [
    { ts_ms: 2, sidecar: 'mac', root: 'BAS', path: 'a.fan', op: 'write', size: 5 },
    { ts_ms: 2, sidecar: 'mac', root: 'Books', path: 'x.pdf', op: 'write', size: 5 },
  ],
  errors: [{ ts_ms: 2, sidecar: 'win', root: 'Q', message: 'nope' }],
};

function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

describe('filterStatus', () => {
  it('keeps only fantom roots and their events', () => {
    const s = filterStatus(FEED);
    expect(s.sidecars.map(x => x.id)).toEqual(['mac']);
    expect(s.sidecars[0].roots.map(r => r.name)).toEqual(['BAS']);
    expect(s.recent).toHaveLength(1);
    expect(s.errors).toHaveLength(0);
    expect(filterStatus(null)).toMatchObject({ sidecars: [], recent: [], errors: [] });
  });

  it('also keeps roots whose real target path is inside the mirror folder', () => {
    const feed = { sidecars: [{ id: 'mac-alper', connected: true, roots: [
      { name: 'soundSuite', target: '/mirror/mac-alper/soundSuite', files: 12, bytes: 1 },
      { name: 'Books', target: '/srv/books', files: 1, bytes: 1 },
    ] }], recent: [{ ts_ms: 1, sidecar: 'mac-alper', root: 'soundSuite', path: 'a.fan' }], errors: [] };
    const s = filterStatus(feed, '/mirror');
    expect(s.sidecars[0].roots.map(r => r.name)).toEqual(['soundSuite']);
    expect(s.recent).toHaveLength(1);
    expect(filterStatus(feed).sidecars).toHaveLength(0);
  });

  it('cleanRoots takes a list or "a, b" text and refuses paths', () => {
    expect(cleanRoots('BAS, Lib ,BAS')).toEqual(['BAS', 'Lib']);
    expect(cleanRoots(undefined)).toEqual([]);
    expect(typeof cleanRoots(['a/b'])).toBe('string');
  });
});

describe('/admin/sidecar-sync', () => {
  let work: string;
  let mirror: string;
  let env: NodeJS.ProcessEnv;
  let app: Server; let base: string;
  let fake: Server; let fakeBase: string;
  let fakeMode: 'ok' | 'fail' | 'slow';
  let fakeAuth: string | undefined;
  let role: 'admin' | 'viewer';
  let projects: string[];
  let store: UserStore;

  beforeEach(async () => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-sync-')));
    mirror = path.join(work, 'mirror');
    fs.mkdirSync(path.join(mirror, 'mac', 'BAS'), { recursive: true });
    fs.mkdirSync(path.join(mirror, 'mac', 'Lib'), { recursive: true });
    projects = [];
    role = 'admin';
    fakeMode = 'ok';

    const r = express();
    r.use(express.json());
    fakeCalls = [];
    r.get('/v1/accounts', (req, res) => {
      fakeAuth = req.headers.authorization;
      res.json({ accounts: fakeAccounts });
    });
    r.post('/v1/accounts', (req, res) => {
      fakeCalls.push({ method: 'POST', path: req.path, body: req.body });
      if (fakeAccounts.some(a => a.username === req.body.username)) { res.status(409).json({ error: `username \`${req.body.username}\` exists` }); return; }
      fakeAccounts.push({ id: req.body.username, username: req.body.username, password_hash: '$argon2id$secret', roots: [], allowed_roots: req.body.roots ?? [], connected: false, last_seen_ms: null, last_login_ms: null });
      res.status(201).json({ accounts: fakeAccounts });
    });
    r.put('/v1/accounts/:u/roots', (req, res) => {
      fakeCalls.push({ method: 'PUT', path: req.path, body: req.body });
      const a = fakeAccounts.find(x => x.username === req.params.u);
      if (!a) { res.status(404).json({ error: 'no account' }); return; }
      a.allowed_roots = req.body.roots;
      res.json({ accounts: fakeAccounts, roots: ['BAS', 'Lib'] });
    });
    r.put('/v1/accounts/:u/password', (req, res) => {
      fakeCalls.push({ method: 'PUT', path: req.path, body: req.body });
      res.json({ accounts: fakeAccounts });
    });
    r.delete('/v1/accounts/:u', (req, res) => {
      fakeCalls.push({ method: 'DELETE', path: req.path });
      if (fakeAccounts.length < 2) { res.status(409).json({ error: 'cannot remove the last account' }); return; }
      fakeAccounts = fakeAccounts.filter(a => a.username !== req.params.u);
      res.json({ accounts: fakeAccounts });
    });
    r.get('/v1/status', async (req, res) => {
      fakeAuth = req.headers.authorization;
      if (fakeMode === 'fail') { res.status(500).json({ error: 'boom' }); return; }
      if (fakeMode === 'slow') await new Promise(ok => setTimeout(ok, 300));
      res.json(FEED);
    });
    ({ server: fake, base: fakeBase } = await listen(r));

    env = { FANTOM_MIRROR_ROOT: mirror, FANTOM_MIRROR_PROJECTS: `bas=${path.join(mirror, 'mac', 'BAS')}` };
    const a = express();
    a.use(express.json());
    const router = Router();
    router.use((req: Request, _res: Response, next: NextFunction) => {
      req.user = { id: '1', username: 'u', role, createdAt: '' } as any;
      next();
    });
    store = new UserStore(path.join(work, 'cfg'));
    registerSidecarSyncRoutes(router, {
      userStore: store,
      configPath: () => path.join(work, 'config.json'),
      env: () => env,
      timeoutMs: 100,
      registry: async () => ({
        listPaths: async () => projects,
        create: async (s) => { projects.push(s.path); },
      }),
    });
    a.use('/admin', router);
    ({ server: app, base } = await listen(a));
  });

  afterEach(async () => {
    await new Promise(r => app.close(r));
    await new Promise(r => fake.close(r));
    fs.rmSync(work, { recursive: true, force: true });
  });

  let fakeAccounts: any[] = [];
  let fakeCalls: any[] = [];

  const call = (method: string, p: string, body?: unknown) => fetch(base + '/admin/sidecar-sync' + p, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });

  it('seeds from FANTOM_MIRROR_PROJECTS, then add / edit / remove persist in settings', async () => {
    let v = await (await call('GET', '/mirror')).json() as any;
    expect(v.source).toBe('env');
    expect(v.projects).toEqual([{ name: 'bas', path: path.join(mirror, 'mac', 'BAS') }]);
    expect(v.effective[0]).toMatchObject({ sidecar: 'mac', root: 'BAS', exists: true });

    let r = await call('POST', '/mirror', { name: 'lib', path: path.join(mirror, 'mac', 'Lib') });
    expect(r.status).toBe(201);
    v = await r.json();
    expect(v.source).toBe('settings');
    expect(v.projects.map((p: any) => p.name)).toEqual(['bas', 'lib']);

    expect((await call('POST', '/mirror', { name: 'lib', path: path.join(mirror, 'mac', 'X') })).status).toBe(409);
    expect((await call('POST', '/mirror', { name: 'out', path: '/etc' })).status).toBe(400);
    expect((await call('POST', '/mirror', { name: 'a/b', path: path.join(mirror, 'mac', 'Y') })).status).toBe(400);

    r = await call('PUT', '/mirror/lib', { name: 'lib2' });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).projects.map((p: any) => p.name)).toEqual(['bas', 'lib2']);
    expect((await call('PUT', '/mirror/none', { name: 'x' })).status).toBe(404);

    r = await call('DELETE', '/mirror/bas');
    v = await r.json();
    expect(v.removed.name).toBe('bas');
    expect(v.projects.map((p: any) => p.name)).toEqual(['lib2']);

    // Settings now win over the env var.
    env = { ...env, FANTOM_MIRROR_PROJECTS: 'other=/mirror/x/y' };
    v = await (await call('GET', '/mirror')).json();
    expect(v.projects.map((p: any) => p.name)).toEqual(['lib2']);
    expect(JSON.parse(fs.readFileSync(path.join(work, 'config.json'), 'utf8')).sidecarSync.mirror.projects).toHaveLength(1);
  });

  it('auto mode lists every mirror folder; reload registers missing ones without a restart', async () => {
    expect((await call('PUT', '/mirror-auto', { auto: 'yes' })).status).toBe(400);
    const v = await (await call('PUT', '/mirror-auto', { auto: true })).json() as any;
    expect(v.effective.map((p: any) => p.name)).toEqual(['bas', 'mac-Lib']);

    let r = await (await call('POST', '/reload')).json() as any;
    expect(r.created).toEqual(['bas', 'mac-Lib']);
    r = await (await call('POST', '/reload')).json();
    expect(r.created).toEqual([]);

    await call('PUT', '/mirror-auto', { auto: false });
    r = await (await call('POST', '/reload')).json();
    expect(r.notInList).toEqual([path.join(mirror, 'mac', 'Lib')]);
  });

  it('changes need the admin role; reading does not', async () => {
    role = 'viewer';
    expect((await call('GET', '/mirror')).status).toBe(200);
    expect((await call('POST', '/mirror', { name: 'x', path: path.join(mirror, 'mac', 'Lib') })).status).toBe(403);
    expect((await call('DELETE', '/mirror/bas')).status).toBe(403);
    expect((await call('POST', '/reload')).status).toBe(403);
  });

  it('says "Receiver not set up" without settings', async () => {
    const s = await (await call('GET', '/status')).json() as any;
    expect(s).toMatchObject({ configured: false, message: 'Receiver not set up', settings: { receiverUrl: 'not set', receiverToken: 'not set' } });
  });

  it('proxies the receiver feed, filters to fantom, keeps the last good result, never shows the token', async () => {
    env = { ...env, SIDECAR_RECEIVER_URL: fakeBase + '/', SIDECAR_RECEIVER_TOKEN: 'tok-secret' };
    let res = await call('GET', '/status');
    let text = await res.text();
    expect(text).not.toContain('tok-secret');
    let s = JSON.parse(text);
    expect(fakeAuth).toBe('Bearer tok-secret');
    expect(s).toMatchObject({ configured: true, stale: false, error: null, settings: { receiverUrl: 'set', receiverToken: 'set' } });
    expect(s.status.sidecars.map((x: any) => x.id)).toEqual(['mac']);
    expect(s.status.sidecars[0].roots[0].hook.ok).toBe(true);

    fakeMode = 'fail';
    s = await (await call('GET', '/status')).json();
    expect(s).toMatchObject({ stale: true, error: 'receiver answered 500' });
    expect(s.status.sidecars).toHaveLength(1);

    fakeMode = 'slow';
    res = await call('GET', '/status');
    text = await res.text();
    s = JSON.parse(text);
    expect(s.error).toMatch(/did not answer/);
    expect(s.status.recent).toHaveLength(1);
    expect(text).not.toContain('tok-secret');
  });

  const callUsers = (method: string, p: string, body?: unknown) => fetch(base + '/admin/users' + p, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });

  it('accounts list: read only, no hashes or token, roots filled, linked user shown', async () => {
    fakeAccounts = [{ id: 'mac', username: 'mac', password_hash: '$argon2id$secret', roots: [], connected: true, last_seen_ms: 5, last_login_ms: 4 }];
    let s = await (await call('GET', '/accounts')).json() as any;
    expect(s).toMatchObject({ configured: false, accounts: [] });

    env = { ...env, SIDECAR_RECEIVER_URL: fakeBase, SIDECAR_RECEIVER_TOKEN: 'tok-secret' };
    const text = await (await call('GET', '/accounts')).text();
    expect(text).not.toContain('tok-secret');
    expect(text).not.toContain('argon2');
    s = JSON.parse(text);
    expect(fakeAuth).toBe('Bearer tok-secret');
    // receiver status roots (BAS, Books) + mirror folders (BAS, Lib)
    expect(s.accounts[0]).toMatchObject({ username: 'mac', roots: ['BAS', 'Books', 'Lib'], connected: true, last_login_ms: 4, user: null });

    // the old write routes are gone
    expect((await call('POST', '/accounts', { username: 'x', password: 'password-1' })).status).toBe(404);
    expect(fakeCalls).toHaveLength(0);

    role = 'viewer';
    expect((await call('GET', '/accounts')).status).toBe(403);
  });

  it('link: makes a viewer user with dashboard login off, never touches the password', async () => {
    env = { ...env, SIDECAR_RECEIVER_URL: fakeBase, SIDECAR_RECEIVER_TOKEN: 'tok-secret' };
    fakeAccounts = [{ id: 'mac-alper', username: 'mac-alper', roots: [], connected: true, last_seen_ms: 5, last_login_ms: 4 }];
    let r = await (await call('POST', '/accounts/link')).json() as any;
    expect(r).toEqual({ linked: [], created: ['mac-alper'], alreadyLinked: [] });
    const u = store.getUser('mac-alper')!;
    expect(u).toMatchObject({ role: 'user', dashboardLogin: false, sidecarSync: { enabled: true, roots: [] } });
    expect(fakeCalls).toHaveLength(0);
    r = await (await call('POST', '/accounts/link')).json();
    expect(r.alreadyLinked).toEqual(['mac-alper']);
    const s = await (await call('GET', '/accounts')).json() as any;
    expect(s.accounts[0]).toMatchObject({ user: 'mac-alper', dashboardLogin: false, syncEnabled: true });
  });

  it('user sync login: on needs a password, set password, roots, off removes; never stores or returns it', async () => {
    env = { ...env, SIDECAR_RECEIVER_URL: fakeBase, SIDECAR_RECEIVER_TOKEN: 'tok-secret' };
    fakeAccounts = [{ id: 'mac', username: 'mac', roots: [], connected: true, last_seen_ms: 5, last_login_ms: 4 }];
    store.createUser('win', 'dash-pass', 'user');

    expect((await callUsers('PUT', '/nobody/sidecar-sync', { enabled: true, password: 'password-1' })).status).toBe(404);
    expect((await callUsers('PUT', '/win/sidecar-sync', { enabled: true })).status).toBe(400);
    expect((await callUsers('PUT', '/win/sidecar-sync', { enabled: true, password: 'short' })).status).toBe(400);
    expect((await callUsers('PUT', '/win/sidecar-sync', { enabled: true, password: 'password-1', roots: ['a/b'] })).status).toBe(400);
    expect(fakeCalls).toHaveLength(0);

    let res = await callUsers('PUT', '/win/sidecar-sync', { enabled: true, password: 'password-1', roots: 'BAS, Lib' });
    expect(res.status).toBe(200);
    let text = await res.text();
    expect(text).not.toContain('password-1');
    expect(JSON.parse(text).user.sidecarSync).toMatchObject({ enabled: true, roots: ['BAS', 'Lib'] });
    expect(fakeCalls.at(-1)).toEqual({ method: 'POST', path: '/v1/accounts', body: { username: 'win', password: 'password-1', roots: ['BAS', 'Lib'] } });
    const file = fs.readFileSync(path.join(work, 'cfg', 'users.json'), 'utf8');
    expect(file).not.toContain('password-1');

    // roots only: the receiver gets the new roots, the password is not touched
    res = await callUsers('PUT', '/win/sidecar-sync', { enabled: true, roots: ['BAS'] });
    expect(res.status).toBe(200);
    expect(fakeCalls.at(-1)).toEqual({ method: 'PUT', path: '/v1/accounts/win/roots', body: { roots: ['BAS'] } });

    res = await callUsers('PUT', '/win/sidecar-sync', { enabled: true, password: 'password-2' });
    expect(fakeCalls.at(-1)).toEqual({ method: 'PUT', path: '/v1/accounts/win/password', body: { password: 'password-2' } });

    res = await callUsers('PUT', '/win/sidecar-sync', { enabled: false });
    expect(res.status).toBe(200);
    expect(fakeCalls.at(-1)).toEqual({ method: 'DELETE', path: '/v1/accounts/win' });
    expect(store.getUser('win')!.sidecarSync).toMatchObject({ enabled: false, roots: ['BAS'] });

    // receiver refuses to remove the last account: error passes through, user stays
    store.setSidecarSync('mac', undefined);
    store.createSyncOnlyUser('mac', { enabled: true, roots: [] });
    res = await callUsers('DELETE', '/mac/sidecar-sync');
    expect(res.status).toBe(409);
    expect(store.getUser('mac')!.sidecarSync?.enabled).toBe(true);

    role = 'viewer';
    expect((await callUsers('PUT', '/win/sidecar-sync', { enabled: true, password: 'password-1' })).status).toBe(403);
    expect((await callUsers('DELETE', '/win/sidecar-sync')).status).toBe(403);
  });

  it('allowed roots: sent to the receiver only when they differ; root names offered', async () => {
    env = { ...env, SIDECAR_RECEIVER_URL: fakeBase, SIDECAR_RECEIVER_TOKEN: 'tok-secret' };
    fakeAccounts = [
      { id: 'mac', username: 'mac', roots: [], connected: true, last_seen_ms: 5, last_login_ms: 4 },
      { id: 'win', username: 'win', roots: [], allowed_roots: ['Lib', 'BAS'], connected: false, last_seen_ms: null, last_login_ms: null },
    ];
    store.createUser('win', 'dash-pass', 'user');

    // same set in another order: no receiver write
    let res = await callUsers('PUT', '/win/sidecar-sync', { enabled: true, roots: ['BAS', 'Lib'] });
    expect(res.status).toBe(200);
    expect(fakeCalls).toHaveLength(0);

    // empty = all roots: sent as []
    res = await callUsers('PUT', '/win/sidecar-sync', { enabled: true, roots: [] });
    expect(res.status).toBe(200);
    expect(fakeCalls).toEqual([{ method: 'PUT', path: '/v1/accounts/win/roots', body: { roots: [] } }]);
    expect(fakeAccounts.find(a => a.username === 'mac')!.allowed_roots).toBeUndefined();

    // the page gets the receiver's root names
    const s = await (await call('GET', '/accounts')).json() as any;
    expect(s.rootNames).toEqual(expect.arrayContaining(['BAS', 'Lib']));
    expect(s.accounts.find((a: any) => a.username === 'win').allowed_roots).toEqual([]);
  });

  it('sync-only users can not log in to the dashboard', () => {
    store.createSyncOnlyUser('sync1', { enabled: true, roots: [] });
    expect(store.getUser('sync1')!.dashboardLogin).toBe(false);
    expect(store.authenticate('sync1', 'anything')).toBeNull();
  });
});
