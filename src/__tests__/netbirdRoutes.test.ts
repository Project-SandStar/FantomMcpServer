/**
 * NetBird admin routes: settings in {NETBIRD_CTL_DIR}/config.json, status
 * from status.json, key never returned. Temp folders; no live NetBird.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import express, { Router, type Request, type Response, type NextFunction } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { registerNetbirdRoutes, parseNetbirdStatus, parseCaddyStatus, validHostname, validManagementUrl, validDomain, validWireguardPort } from '../admin/netbirdRoutes.js';

const KEY = 'A1B2C3D4-SECRET-KEY-WXYZ';
const TOKEN = 'cfTokenSecretValue_0123456789-abcd';

describe('netbird helpers', () => {
  it('validates hostnames and URLs', () => {
    expect(validHostname('fantom')).toBe(true);
    expect(validHostname('fantom-2')).toBe(true);
    expect(validHostname('a'.repeat(63))).toBe(true);
    expect(validHostname('a'.repeat(64))).toBe(false);
    expect(validHostname('-x')).toBe(false);
    expect(validHostname('Fantom')).toBe(false);
    expect(validHostname('a.b')).toBe(false);
    expect(validHostname('')).toBe(false);
    expect(validManagementUrl('https://example.com:443')).toBe(true);
    expect(validManagementUrl('http://example.com')).toBe(false);
    expect(validManagementUrl('nope')).toBe(false);
  });

  it('parses netbird status --json', () => {
    const raw = { netbirdIp: '192.0.2.5/16', fqdn: 'fantom.example.com', management: { connected: true }, peers: { total: 4, connected: 2 } };
    expect(parseNetbirdStatus(raw, 1000, 2000)).toEqual({
      connected: true, fqdn: 'fantom.example.com', ip: '192.0.2.5', peersConnected: 2, peersTotal: 4,
      updatedAt: new Date(1000).toISOString(),
    });
    // Old file: the container stopped writing.
    expect(parseNetbirdStatus(raw, 1000, 1000 + 120_000)?.connected).toBe(false);
    expect(parseNetbirdStatus({ management: { connected: false } }, 1000, 1000)?.connected).toBe(false);
    expect(parseNetbirdStatus(null, 1000, 1000)).toBeNull();
  });

  it('validates domains and WireGuard ports', () => {
    expect(validDomain('example.com')).toBe(true);
    expect(validDomain('localhost')).toBe(false);
    expect(validDomain('a b.co')).toBe(false);
    expect(validWireguardPort(0)).toBe(true);
    expect(validWireguardPort(65535)).toBe(true);
    expect(validWireguardPort(65536)).toBe(false);
    expect(validWireguardPort(-1)).toBe(false);
    expect(validWireguardPort('1')).toBe(false);
  });

  it('parses caddy-status.json; old file means not running', () => {
    const raw = { running: true, certificate: { names: ['a.b.co'], notAfter: '2027-01-01T00:00:00Z' }, error: 'x' };
    expect(parseCaddyStatus(raw, 1000, 2000)).toEqual({
      running: true, certificate: { names: ['a.b.co'], notAfter: '2027-01-01T00:00:00Z' }, error: 'x',
      updatedAt: new Date(1000).toISOString(), stale: false,
    });
    expect(parseCaddyStatus(raw, 1000, 1000 + 120_000)).toMatchObject({ running: false, stale: true });
    expect(parseCaddyStatus({ running: true, certificate: null }, 1000, 1000)?.certificate).toBeNull();
    expect(parseCaddyStatus('bad', 1000, 1000)).toBeNull();
  });
});

describe('/admin/netbird', () => {
  let work: string;
  let ctl: string;
  let fallback: string;
  let env: NodeJS.ProcessEnv;
  let role: 'admin' | 'viewer';
  let server: Server; let base: string;

  beforeEach(async () => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'netbird-')));
    ctl = path.join(work, 'ctl');
    fallback = path.join(work, 'cache', 'netbird-ctl');
    fs.mkdirSync(ctl);
    env = { NETBIRD_CTL_DIR: ctl };
    role = 'admin';
    const a = express();
    a.use(express.json());
    const router = Router();
    router.use((req: Request, _res: Response, next: NextFunction) => {
      req.user = { id: '1', username: 'u', role, createdAt: '' } as any;
      next();
    });
    registerNetbirdRoutes(router, { env: () => env, fallbackDir: () => fallback });
    a.use('/admin', router);
    await new Promise<void>(ok => { server = a.listen(0, () => ok()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise(r => server.close(r));
    fs.rmSync(work, { recursive: true, force: true });
  });

  const call = (method: string, p: string, body?: unknown) => fetch(base + '/admin/netbird' + p, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });

  it('gives defaults when nothing is saved', async () => {
    const v = await (await call('GET', '')).json();
    expect(v).toEqual({
      configured: true, enabled: false, hostname: 'fantom', managementUrl: 'https://api.netbird.io:443',
      hasKey: false, keyHint: null, wireguardPort: 0, status: null,
      https: {
        enabled: false, domain: '', email: '', hasToken: false, tokenHint: null,
        address: '', status: null,
      },
    });
  });

  it('takes default management URL and domain from the environment', async () => {
    env = { ...env, NETBIRD_MANAGEMENT_URL: 'https://netbird.example.com:443', NETBIRD_HTTPS_DOMAIN: 'Example.com' };
    const v = await (await call('GET', '')).json() as any;
    expect(v.managementUrl).toBe('https://netbird.example.com:443');
    expect(v.https).toMatchObject({ domain: 'example.com', address: 'https://fantom.example.com' });
  });

  it('needs a domain before HTTPS is on', async () => {
    expect((await call('PUT', '', { https: { enabled: true } })).status).toBe(400);
    expect((await call('PUT', '', { https: { enabled: true, domain: 'example.com' } })).status).toBe(200);
  });

  it('saves wireguardPort and https; never returns the token', async () => {
    await call('PUT', '', { setupKey: KEY, enabled: true });
    const res = await call('PUT', '', {
      wireguardPort: 51830,
      https: { enabled: true, domain: 'Example.COM', cloudflareToken: TOKEN, email: 'ops@example.com' },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text)).toMatchObject({
      wireguardPort: 51830,
      https: { enabled: true, domain: 'example.com', email: 'ops@example.com', hasToken: true, tokenHint: 'abcd', address: 'https://fantom.example.com' },
    });
    const file = path.join(ctl, 'config.json');
    const raw = fs.readFileSync(file, 'utf8');
    const saved = JSON.parse(raw);
    expect(saved).toMatchObject({ setupKey: KEY, wireguardPort: 51830, https: { enabled: true, domain: 'example.com', cloudflareToken: TOKEN } });
    // Top-level fields stay at a 2-space indent (the netbird entrypoint reads them with sed).
    expect(raw).toMatch(/^  "wireguardPort": 51830,$/m);
    expect(raw).toMatch(/^    "enabled": true,$/m);
    // A save without the token keeps it.
    await call('PUT', '', { https: { enabled: false } });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).https.cloudflareToken).toBe(TOKEN);
    expect(await (await call('GET', '')).text()).not.toContain(TOKEN);
  });

  it('DELETE /https-token removes only the token', async () => {
    await call('PUT', '', { setupKey: KEY, https: { enabled: true, domain: 'example.com', cloudflareToken: TOKEN } });
    const v = await (await call('DELETE', '/https-token')).json() as any;
    expect(v.https).toMatchObject({ hasToken: false, tokenHint: null, enabled: true });
    expect(v.hasKey).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(ctl, 'config.json'), 'utf8')).https.cloudflareToken).toBe('');
  });

  it('rejects bad wireguardPort and https input', async () => {
    for (const body of [
      { wireguardPort: -1 }, { wireguardPort: 65536 }, { wireguardPort: 1.5 }, { wireguardPort: '51820' },
      { https: 'on' }, { https: { enabled: 'yes' } }, { https: { domain: 'bad domain' } }, { https: { domain: 'localhost' } },
      { https: { cloudflareToken: 'short' } }, { https: { cloudflareToken: 'has space in it 0123456789' } },
      { https: { email: 'nope' } },
    ]) {
      expect((await call('PUT', '', body)).status).toBe(400);
    }
    expect(fs.existsSync(path.join(ctl, 'config.json'))).toBe(false);
  });

  it('reads caddy-status.json from the Caddy container', async () => {
    fs.writeFileSync(path.join(ctl, 'caddy-status.json'), JSON.stringify({
      running: true, certificate: { names: ['fantom.example.com'], notAfter: '2027-01-28T00:00:00Z' }, error: null, updatedAt: 'x',
    }));
    const v = await (await call('GET', '')).json() as any;
    expect(v.https.status).toMatchObject({
      running: true, certificate: { names: ['fantom.example.com'], notAfter: '2027-01-28T00:00:00Z' }, error: null, stale: false,
    });
  });

  it('saves the key with mode 600, returns only the last 4 chars, keeps the key when omitted', async () => {
    let res = await call('PUT', '', { setupKey: KEY, hostname: 'fantom', enabled: true });
    expect(res.status).toBe(200);
    let text = await res.text();
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text)).toMatchObject({ hasKey: true, keyHint: 'WXYZ', enabled: true });

    const file = path.join(ctl, 'config.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved).toMatchObject({ setupKey: KEY, hostname: 'fantom', managementUrl: 'https://api.netbird.io:443', enabled: true });
    expect(typeof saved.updatedAt).toBe('string');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    res = await call('PUT', '', { hostname: 'fantom-dev' });
    text = await res.text();
    expect(text).not.toContain(KEY);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).setupKey).toBe(KEY);
    expect(JSON.parse(text)).toMatchObject({ hostname: 'fantom-dev', keyHint: 'WXYZ' });
    expect(await (await call('GET', '')).text()).not.toContain(KEY);
  });

  it('rejects bad input', async () => {
    expect((await call('PUT', '', { hostname: 'Bad_Name' })).status).toBe(400);
    expect((await call('PUT', '', { hostname: 'a'.repeat(64) })).status).toBe(400);
    expect((await call('PUT', '', { managementUrl: 'http://example.com' })).status).toBe(400);
    expect((await call('PUT', '', { setupKey: '   ' })).status).toBe(400);
    expect((await call('PUT', '', { enabled: 'yes' })).status).toBe(400);
    // Enable needs a key.
    expect((await call('PUT', '', { enabled: true })).status).toBe(400);
    expect(fs.existsSync(path.join(ctl, 'config.json'))).toBe(false);
  });

  it('DELETE /key removes the key and disables', async () => {
    await call('PUT', '', { setupKey: KEY, enabled: true });
    const v = await (await call('DELETE', '/key')).json();
    expect(v).toMatchObject({ hasKey: false, keyHint: null, enabled: false });
    const saved = JSON.parse(fs.readFileSync(path.join(ctl, 'config.json'), 'utf8'));
    expect(saved.setupKey).toBe('');
    expect(saved.enabled).toBe(false);
  });

  it('changes need the admin role; reading does not', async () => {
    role = 'viewer';
    expect((await call('GET', '')).status).toBe(200);
    expect((await call('PUT', '', { hostname: 'x' })).status).toBe(403);
    expect((await call('DELETE', '/key')).status).toBe(403);
    expect((await call('DELETE', '/https-token')).status).toBe(403);
  });

  it('reads status.json from the container', async () => {
    fs.writeFileSync(path.join(ctl, 'status.json'), JSON.stringify({
      netbirdIp: '192.0.2.5/16', fqdn: 'fantom.example.com', management: { connected: true }, peers: { total: 3, connected: 1 },
    }));
    const v = await (await call('GET', '')).json() as any;
    expect(v.status).toMatchObject({ connected: true, fqdn: 'fantom.example.com', ip: '192.0.2.5', peersConnected: 1, peersTotal: 3 });
  });

  it('without the shared folder: not configured, saves into the cache folder', async () => {
    env = { NETBIRD_CTL_DIR: path.join(work, 'missing') };
    let v = await (await call('GET', '')).json() as any;
    expect(v.configured).toBe(false);
    v = await (await call('PUT', '', { setupKey: KEY })).json();
    expect(v).toMatchObject({ configured: false, hasKey: true, status: null });
    expect(JSON.parse(fs.readFileSync(path.join(fallback, 'config.json'), 'utf8')).setupKey).toBe(KEY);
  });
});
