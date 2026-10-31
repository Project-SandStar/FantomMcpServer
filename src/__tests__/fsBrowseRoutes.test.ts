/**
 * /admin/fs/dirs: allowlist (traversal, symlink escape, outside root),
 * listing and folder hints. Temp folders only.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import express, { Router, type Request, type Response, type NextFunction } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { registerFsBrowseRoutes, browseRoots, detectHint } from '../admin/fsBrowseRoutes.js';

describe('/admin/fs/dirs', () => {
  let work: string; let mirror: string; let proj: string; let outside: string; let secret: string;
  let env: NodeJS.ProcessEnv;
  let role: 'admin' | 'viewer';
  let server: Server; let base: string;

  const mk = (...p: string[]) => { const d = path.join(...p); fs.mkdirSync(d, { recursive: true }); return d; };
  const touch = (...p: string[]) => { mk(path.dirname(path.join(...p))); fs.writeFileSync(path.join(...p), ''); };

  beforeEach(async () => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsbrowse-')));
    mirror = mk(work, 'mirror');
    proj = mk(work, 'axon', 'proj');
    outside = mk(work, 'outside');
    secret = mk(mirror, 'config');
    touch(secret, 'admin.json');
    // SkySpark home, Haxall home, a pod, docs, an Axon project
    touch(mirror, 'mac', 'skyspark', 'skyspark-4.0.6', 'lib', 'fan', 'sys.pod');
    touch(mirror, 'mac', 'haxall', 'haxall-4.0.6', 'home', 'etc', 'sys', 'config.props');
    touch(mirror, 'mac', 'myPod', 'build.fan');
    mk(mirror, 'mac', 'skyspark', 'skyspark-4.0.6', 'doc', 'sys');
    touch(proj, 'inst', 'p1', 'func', 'a.axon');
    mk(mirror, 'mac', '.hidden');
    touch(mirror, 'mac', 'readme.txt');
    fs.symlinkSync(outside, path.join(mirror, 'mac', 'escape'));
    fs.symlinkSync(path.join(mirror, 'mac', 'myPod'), path.join(mirror, 'mac', 'podLink'));
    env = { FANTOM_BROWSE_ROOTS: `${mirror}:${proj},${path.join(work, 'missing')}` };
    role = 'admin';
    const a = express();
    const router = Router();
    router.use((req: Request, _res: Response, next: NextFunction) => {
      req.user = { id: '1', username: 'u', role, createdAt: '' } as any;
      next();
    });
    registerFsBrowseRoutes(router, { env: () => env, denied: () => [secret] });
    a.use('/admin', router);
    await new Promise<void>(ok => { server = a.listen(0, () => ok()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise(r => server.close(r));
    fs.rmSync(work, { recursive: true, force: true });
  });

  const get = (p?: string) => fetch(base + '/admin/fs/dirs' + (p === undefined ? '' : '?path=' + encodeURIComponent(p)));

  it('reads roots from FANTOM_BROWSE_ROOTS and drops missing ones', () => {
    expect(browseRoots(env)).toEqual([mirror, proj]);
  });

  it('lists the first root by default', async () => {
    const r = await get();
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.path).toBe(mirror);
    expect(j.parent).toBeNull();
    expect(j.roots).toEqual([mirror, proj]);
    // the denied config folder is never listed
    expect(j.entries.map((e: any) => e.name)).toEqual(['mac']);
  });

  it('lists folders only, sorted, no dotfiles, safe links only, with hints', async () => {
    const j = (await (await get(path.join(mirror, 'mac'))).json()) as any;
    expect(j.entries.map((e: any) => e.name)).toEqual(['haxall', 'myPod', 'podLink', 'skyspark']);
    expect(j.entries.find((e: any) => e.name === 'myPod').hint).toBe('pod');
    expect(j.fileCount).toBe(2); // readme.txt + escape link
    expect(j.parent).toBe(mirror);
    const s = (await (await get(path.join(mirror, 'mac', 'skyspark'))).json()) as any;
    expect(s.entries[0]).toMatchObject({ name: 'skyspark-4.0.6', hint: 'skyspark-home', isDir: true });
    const h = (await (await get(path.join(mirror, 'mac', 'haxall', 'haxall-4.0.6'))).json()) as any;
    expect(h.entries[0]).toMatchObject({ name: 'home', hint: 'haxall-home' });
    expect(detectHint(path.join(proj, 'inst', 'p1'))).toBe('axon-project');
    expect(detectHint(proj)).toBe('axon-proj');
    expect(detectHint(path.join(mirror, 'mac', 'skyspark', 'skyspark-4.0.6', 'doc'))).toBe('docs');
  });

  it('refuses traversal, symlink escape, outside paths and denied folders', async () => {
    expect((await get(path.join(mirror, '..', 'outside'))).status).toBe(403);
    expect((await get(path.join(mirror, 'mac', 'escape'))).status).toBe(403);
    expect((await get(outside)).status).toBe(403);
    expect((await get('/')).status).toBe(403);
    expect((await get(secret)).status).toBe(403);
    expect((await get('relative/path')).status).toBe(400);
    expect((await get(path.join(mirror, 'mac', 'readme.txt'))).status).toBe(400);
    expect((await get(path.join(mirror, 'nope'))).status).toBe(404);
    const text = await (await get(path.join(mirror, 'mac'))).text();
    expect(text).not.toContain(outside);
  });

  it('needs the admin role', async () => {
    role = 'viewer';
    expect((await get()).status).toBe(403);
  });

  it('caps the listing at 500 and flags truncated', async () => {
    const big = mk(mirror, 'big');
    for (let i = 0; i < 505; i++) fs.mkdirSync(path.join(big, `d${String(i).padStart(3, '0')}`));
    const j = (await (await get(big)).json()) as any;
    expect(j.entries).toHaveLength(500);
    expect(j.truncated).toBe(true);
  });
});
