/**
 * /admin/sidecar-sync/* — the dashboard "Sidecar sync" page
 * (fileSystemSideCar docs/admin-screens.md). Behind the admin Basic Auth
 * (or FANTOM_API_TOKEN bearer); register AFTER the auth middleware.
 *
 *   GET    /sidecar-sync/mirror              mirror settings + effective list
 *   POST   /sidecar-sync/mirror              add {name, path}            (admin)
 *   PUT    /sidecar-sync/mirror/:name        edit {name?, path?}         (admin)
 *   DELETE /sidecar-sync/mirror/:name        remove from the list        (admin)
 *   PUT    /sidecar-sync/mirror-auto         {auto: boolean}             (admin)
 *   POST   /sidecar-sync/reload              register missing projects   (admin)
 *   GET    /sidecar-sync/status              receiver GET /v1/status, Fantom roots only
 *   GET    /sidecar-sync/accounts            receiver accounts + linked Fantom user (admin, read only)
 *   POST   /sidecar-sync/accounts/link       link receiver accounts to users by name (admin)
 *   PUT    /users/:username/sidecar-sync     {enabled, password?, roots?}      (admin)
 *   DELETE /users/:username/sidecar-sync     remove the sync login            (admin)
 *
 * "Sidecar sync login" per Fantom user (Users page, config/users.json): the
 * one user list. Changes go to the receiver's admin API (same token). The sync
 * password is write-only: never stored, returned or logged here, and Fantom
 * keeps no hash (the receiver keeps the Argon2 hash). The allowed roots go to
 * the receiver too (PUT /v1/accounts/{user}/roots), which refuses writes to
 * any other root; empty = all roots. Each change writes one
 * audit line (logger "sidecar-accounts": who, what, which account).
 *
 * Removing an entry does not delete the Fantom project or its index; reload
 * lists such projects under `notInList` so the admin can delete them on the
 * Projects page. Tokens never leave the server: replies say only set / not set.
 */

import type { Router, Request, Response, NextFunction } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/index.js';
import { runtimeConfigPath } from '../indexing/lazyConfig.js';
import { mirrorRoot, registerMirrorSpecs, type MirrorRegistryDeps } from '../indexing/mirror.js';
import {
  MirrorSettingsError, addMirrorProject, editMirrorProject, effectiveMirrorSpecs, mirrorLocation,
  readMirrorSettings, removeMirrorProject, setMirrorAuto,
} from '../indexing/mirrorStore.js';
import type { UserStore, SidecarSyncLogin } from './userStore.js';

export const RECEIVER_URL_ENV = 'SIDECAR_RECEIVER_URL';
export const RECEIVER_TOKEN_ENV = 'SIDECAR_RECEIVER_TOKEN';
export const STATUS_TARGET = 'fantom';
const STATUS_TIMEOUT_MS = 5000;
const audit = createLogger('sidecar-accounts');

export interface SidecarSyncRouteOptions {
  configPath?: () => string;
  env?: () => NodeJS.ProcessEnv;
  /** Fantom project registry; default the shared Fantom database. */
  registry?: () => Promise<MirrorRegistryDeps>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Fantom users (config/users.json); needed for the sync login routes. */
  userStore?: UserStore;
}

interface HookInfo { ok: boolean; last_ms: number | null; error: string | null }
interface RootInfo {
  name: string; target: string; company: string | null; files: number; bytes: number;
  last_path: string | null; last_change_ms: number | null; hook: HookInfo | null;
}
interface SidecarInfo { id: string; connected: boolean; last_seen_ms: number | null; roots: RootInfo[] }
interface FeedEvent { ts_ms: number; sidecar: string; root: string; path?: string; op?: string; size?: number; message?: string }
export interface ReceiverStatus {
  version: string | null; uptime_s: number | null;
  sidecars: SidecarInfo[]; recent: FeedEvent[]; errors: FeedEvent[];
}
export interface ReceiverAccount {
  id: string; username: string; roots: string[]; connected: boolean;
  last_seen_ms: number | null; last_login_ms: number | null;
  /** Roots the receiver lets this account write; empty = all roots. */
  allowed_roots: string[];
}

/** Only the fields the page needs; drops anything else the receiver may add. */
export function filterAccounts(raw: unknown): ReceiverAccount[] {
  const r = isObj(raw) ? raw : {};
  return (Array.isArray(r.accounts) ? r.accounts : []).filter(isObj).map((a: any) => ({
    id: String(a.id ?? ''), username: String(a.username ?? ''),
    roots: (Array.isArray(a.roots) ? a.roots : []).map(String),
    connected: a.connected === true,
    last_seen_ms: typeof a.last_seen_ms === 'number' ? a.last_seen_ms : null,
    last_login_ms: typeof a.last_login_ms === 'number' ? a.last_login_ms : null,
    allowed_roots: (Array.isArray(a.allowed_roots) ? a.allowed_roots : []).map(String),
  }));
}

/** Every root name the receiver knows (top-level `roots` of GET /v1/accounts). */
export function receiverRootNames(raw: unknown): string[] {
  const r = isObj(raw) ? raw : {};
  return (Array.isArray(r.roots) ? r.roots : []).map(String).filter(Boolean);
}

/** Same set of roots, order and repeats ignored. */
export function sameRoots(a: string[], b: string[]): boolean {
  const x = [...new Set(a)].sort(); const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err); }

/**
 * Keep only Fantom roots, and events for those roots. A root is Fantom's when
 * its target is "fantom" or a real path inside Fantom's mirror folder (the
 * receiver reports the real target path, e.g. /mirror/mac-alper/soundSuite).
 */
export function filterStatus(raw: unknown, mirror: string | null = null, target = STATUS_TARGET): ReceiverStatus {
  const r = isObj(raw) ? raw : {};
  const ours = (t: unknown) => t === target || (typeof t === 'string' && !!mirror && path.isAbsolute(t)
    && !path.relative(mirror, t).startsWith('..') && !path.isAbsolute(path.relative(mirror, t)));
  const sidecars: SidecarInfo[] = (Array.isArray(r.sidecars) ? r.sidecars : []).filter(isObj).map((s: any) => ({
    id: String(s.id ?? ''),
    connected: s.connected === true,
    last_seen_ms: typeof s.last_seen_ms === 'number' ? s.last_seen_ms : null,
    roots: (Array.isArray(s.roots) ? s.roots : []).filter((x: any) => isObj(x) && ours(x.target)).map((x: any) => ({
      name: String(x.name ?? ''), target: String(x.target), company: x.company ?? null,
      files: Number(x.files) || 0, bytes: Number(x.bytes) || 0,
      last_path: typeof x.last_path === 'string' ? x.last_path : null,
      last_change_ms: typeof x.last_change_ms === 'number' ? x.last_change_ms : null,
      hook: isObj(x.hook) ? { ok: x.hook.ok === true, last_ms: typeof x.hook.last_ms === 'number' ? x.hook.last_ms : null, error: x.hook.error ?? null } : null,
    })),
  })).filter(s => s.roots.length > 0);
  const keep = new Set(sidecars.flatMap(s => s.roots.map(x => `${s.id}/${x.name}`)));
  const events = (v: unknown) => (Array.isArray(v) ? v : []).filter(isObj)
    .filter((e: any) => keep.has(`${e.sidecar}/${e.root}`)) as FeedEvent[];
  return {
    version: typeof r.version === 'string' ? r.version : null,
    uptime_s: typeof r.uptime_s === 'number' ? r.uptime_s : null,
    sidecars, recent: events(r.recent), errors: events(r.errors),
  };
}

async function defaultRegistry(): Promise<MirrorRegistryDeps> {
  const { getFantomDatabase } = await import('../fantom/database.js');
  const { detectProjectLanguage } = await import('./routes.js');
  const db = getFantomDatabase();
  return {
    listPaths: async () => (await db.getAllProjects()).map(p => p.path),
    create: async (s) => {
      await db.createProject({ name: s.name, path: s.path, autoIndex: true, ...detectProjectLanguage(s.path) });
    },
  };
}

export function registerSidecarSyncRoutes(router: Router, opts: SidecarSyncRouteOptions = {}): void {
  const cfgPath = opts.configPath ?? runtimeConfigPath;
  const env = opts.env ?? (() => process.env);
  const registry = opts.registry ?? defaultRegistry;
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? STATUS_TIMEOUT_MS;

  // Last good feed, kept across failures (admin-screens.md section 4).
  let lastGood: { at: string; status: ReceiverStatus } | null = null;

  const adminOnly = (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== 'admin') { res.status(403).json({ error: 'Admin access required' }); return; }
    next();
  };

  const mirrorView = () => {
    const e = env();
    const s = readMirrorSettings(cfgPath(), e);
    const root = mirrorRoot(e);
    const effective = effectiveMirrorSpecs(s, e).map(p => ({
      ...p,
      ...(mirrorLocation(p.path, root) ?? { sidecar: null, root: null }),
      exists: fs.existsSync(p.path),
      fromAuto: !s.projects.some(x => x.path === p.path),
    }));
    return { ...s, mirrorRoot: root, effective };
  };

  const fail = (res: Response, err: unknown) => {
    if (err instanceof MirrorSettingsError) return res.status(err.status).json({ error: err.message });
    return res.status(500).json({ error: errMsg(err) });
  };

  router.get('/sidecar-sync/mirror', (_req: Request, res: Response) => {
    try { res.json(mirrorView()); } catch (err) { fail(res, err); }
  });

  router.post('/sidecar-sync/mirror', adminOnly, (req: Request, res: Response) => {
    try { addMirrorProject(cfgPath(), req.body, env()); res.status(201).json(mirrorView()); } catch (err) { fail(res, err); }
  });

  router.put('/sidecar-sync/mirror/:name', adminOnly, (req: Request, res: Response) => {
    try { editMirrorProject(cfgPath(), String(req.params.name), req.body, env()); res.json(mirrorView()); } catch (err) { fail(res, err); }
  });

  router.delete('/sidecar-sync/mirror/:name', adminOnly, (req: Request, res: Response) => {
    try {
      const { removed } = removeMirrorProject(cfgPath(), String(req.params.name), env());
      res.json({ ...mirrorView(), removed });
    } catch (err) { fail(res, err); }
  });

  router.put('/sidecar-sync/mirror-auto', adminOnly, (req: Request, res: Response) => {
    try { setMirrorAuto(cfgPath(), isObj(req.body) ? req.body.auto : undefined, env()); res.json(mirrorView()); } catch (err) { fail(res, err); }
  });

  router.post('/sidecar-sync/reload', adminOnly, async (_req: Request, res: Response) => {
    try {
      const e = env();
      const s = readMirrorSettings(cfgPath(), e);
      const specs = effectiveMirrorSpecs(s, e);
      const reg = await registry();
      const created = await registerMirrorSpecs(reg, specs);
      const missingFolders = specs.filter(p => !fs.existsSync(p.path)).map(p => p.name);
      const root = mirrorRoot(e);
      const wanted = new Set(specs.map(p => path.resolve(p.path)));
      const notInList = (await reg.listPaths()).map(p => path.resolve(p))
        .filter(p => mirrorLocation(p, root) && !wanted.has(p));
      res.json({ created, missingFolders, notInList, total: specs.length });
    } catch (err) { fail(res, err); }
  });

  router.get('/sidecar-sync/status', async (_req: Request, res: Response) => {
    const e = env();
    const url = e[RECEIVER_URL_ENV]?.trim();
    const token = e[RECEIVER_TOKEN_ENV]?.trim();
    const settings = { receiverUrl: url ? 'set' : 'not set', receiverToken: token ? 'set' : 'not set' };
    res.setHeader('Cache-Control', 'no-store');
    if (!url || !token) {
      return res.json({ configured: false, message: 'Receiver not set up', settings, status: null, fetchedAt: null, error: null });
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await doFetch(`${url.replace(/\/+$/, '')}/v1/status`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: ctl.signal,
      });
      if (!r.ok) throw new Error(`receiver answered ${r.status}`);
      lastGood = { at: new Date().toISOString(), status: filterStatus(await r.json(), mirrorRoot(e)) };
      return res.json({ configured: true, message: null, settings, status: lastGood.status, fetchedAt: lastGood.at, stale: false, error: null });
    } catch (err) {
      const msg = ctl.signal.aborted ? `receiver did not answer in ${timeoutMs / 1000} s` : errMsg(err);
      return res.json({
        configured: true, message: null, settings,
        status: lastGood?.status ?? null, fetchedAt: lastGood?.at ?? null, stale: true, error: msg,
      });
    } finally {
      clearTimeout(timer);
    }
  });

  // ---- accounts (receiver admin API) ----

  const receiver = () => {
    const e = env();
    const url = e[RECEIVER_URL_ENV]?.trim();
    const token = e[RECEIVER_TOKEN_ENV]?.trim();
    return url && token ? { base: url.replace(/\/+$/, ''), token } : null;
  };

  /** Call the receiver; returns its status and parsed body. Never logs the body. */
  const callReceiver = async (method: string, p: string, body?: unknown) => {
    const r = receiver();
    if (!r) return { status: 0, body: { error: 'Receiver not set up' } };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await doFetch(`${r.base}${p}`, {
        method,
        headers: { Authorization: `Bearer ${r.token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
      const text = await res.text();
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { parsed = { error: text || `receiver answered ${res.status}` }; }
      return { status: res.status, body: parsed };
    } catch (err) {
      const msg = ctl.signal.aborted ? `receiver did not answer in ${timeoutMs / 1000} s` : errMsg(err);
      return { status: 502, body: { error: msg } };
    } finally {
      clearTimeout(timer);
    }
  };

  const who = (req: Request) => req.user?.username ?? 'api-token';
  const validName = (u: unknown): u is string => typeof u === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(u);

  const ok = (st: number) => st >= 200 && st < 300;
  const errOf = (out: { status: number; body: unknown }) =>
    out.status === 0 ? 'Receiver not set up (SIDECAR_RECEIVER_URL, SIDECAR_RECEIVER_TOKEN)'
      : isObj(out.body) && typeof out.body.error === 'string' ? out.body.error : `receiver answered ${out.status}`;
  const codeOf = (st: number) => (st === 0 ? 503 : [400, 404, 409].includes(st) ? st : 502);
  const store = () => opts.userStore ?? null;

  /** Root names for one sidecar: receiver map/seen roots, status roots, mirror folders. */
  const rootsFor = (a: ReceiverAccount, statusRoots: Map<string, string[]>) => {
    const out = new Set<string>([...a.roots, ...(statusRoots.get(a.id) ?? [])]);
    try {
      for (const d of fs.readdirSync(path.join(mirrorRoot(env()), a.id), { withFileTypes: true })) {
        if (d.isDirectory() && !d.name.startsWith('.')) out.add(d.name);
      }
    } catch { /* no mirror folder for this sidecar */ }
    return [...out].sort((x, y) => x.localeCompare(y));
  };

  const listAccounts = async () => {
    const out = await callReceiver('GET', '/v1/accounts');
    if (!ok(out.status)) return { out, accounts: null as ReceiverAccount[] | null, rootNames: [] as string[] };
    const names = new Set<string>(receiverRootNames(out.body));
    const st = await callReceiver('GET', '/v1/status');
    const statusRoots = new Map<string, string[]>();
    if (ok(st.status) && isObj(st.body) && Array.isArray(st.body.sidecars)) {
      for (const sc of st.body.sidecars.filter(isObj)) {
        statusRoots.set(String(sc.id ?? ''), (Array.isArray(sc.roots) ? sc.roots : []).filter(isObj).map((x: any) => String(x.name ?? '')).filter(Boolean));
      }
    }
    const accounts = filterAccounts(out.body).map(a => ({ ...a, roots: rootsFor(a, statusRoots) }));
    for (const a of accounts) a.roots.forEach(r => names.add(r));
    return { out, accounts, rootNames: [...names].sort((x, y) => x.localeCompare(y)) };
  };

  router.get('/sidecar-sync/accounts', adminOnly, async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!receiver()) return res.json({ configured: false, accounts: [], rootNames: [], error: null });
    const { out, accounts, rootNames } = await listAccounts();
    if (!accounts) return res.json({ configured: true, accounts: [], rootNames: [], error: errOf(out) });
    const users = store();
    return res.json({
      configured: true, error: null, rootNames,
      accounts: accounts.map(a => {
        const u = users?.getUser(a.username) ?? null;
        return {
          ...a, user: u ? u.username : null, dashboardLogin: u ? u.dashboardLogin : null,
          syncEnabled: u?.sidecarSync?.enabled === true, allowedRoots: u?.sidecarSync?.roots ?? [],
        };
      }),
    });
  });

  router.post('/sidecar-sync/accounts/link', adminOnly, async (req: Request, res: Response) => {
    const users = store();
    if (!users) return res.status(501).json({ error: 'No user store' });
    try {
      const r = await linkReceiverAccounts(users, async () => {
        const { out, accounts } = await listAccounts();
        if (!accounts) throw Object.assign(new Error(errOf(out)), { status: codeOf(out.status) });
        return accounts;
      });
      audit.info(`link receiver accounts by ${who(req)}: linked [${r.linked.join(', ')}] created [${r.created.join(', ')}]`);
      return res.json(r);
    } catch (err) {
      return res.status((err as any)?.status ?? 502).json({ error: errMsg(err) });
    }
  });

  router.put('/users/:username/sidecar-sync', adminOnly, async (req: Request, res: Response) => {
    const users = store();
    if (!users) return res.status(501).json({ error: 'No user store' });
    const username = String(req.params.username).toLowerCase();
    const user = users.getUser(username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!validName(username)) return res.status(400).json({ error: 'This username can not be a sync login (1-64 of letters, digits, ".", "_", "-")' });
    const b = isObj(req.body) ? req.body : {};
    const enabled = b.enabled !== false;
    const roots = cleanRoots(b.roots ?? user.sidecarSync?.roots);
    if (typeof roots === 'string') return res.status(400).json({ error: roots });
    const password = typeof b.password === 'string' ? b.password : '';
    if (password && password.length < 8) return res.status(400).json({ error: 'Sync password must be at least 8 characters' });

    const list = await callReceiver('GET', '/v1/accounts');
    if (!ok(list.status)) return res.status(codeOf(list.status)).json({ error: errOf(list) });
    const acc = filterAccounts(list.body).find(a => a.username.toLowerCase() === username);
    let action = 'save settings';
    let out: { status: number; body: unknown } | null = null;
    if (!enabled) {
      if (acc) { action = 'turn off (remove account)'; out = await callReceiver('DELETE', `/v1/accounts/${encodeURIComponent(acc.username)}`); }
    } else if (!acc) {
      if (!password) return res.status(400).json({ error: 'Set a sync password to turn on the sync login' });
      action = 'turn on (add account)';
      out = await callReceiver('POST', '/v1/accounts', roots.length ? { username, password, roots } : { username, password });
    } else if (password) {
      action = 'set sync password'; out = await callReceiver('PUT', `/v1/accounts/${encodeURIComponent(acc.username)}/password`, { password });
    }
    // Allowed roots of an existing account: send only when they differ.
    if (enabled && acc && (!out || ok(out.status)) && !sameRoots(roots, acc.allowed_roots)) {
      action += ', set roots';
      out = await callReceiver('PUT', `/v1/accounts/${encodeURIComponent(acc.username)}/roots`, { roots });
    }
    audit.info(`sync login "${username}" ${action} by ${who(req)}: ${!out || ok(out.status) ? 'ok' : `failed (${out.status})`}`);
    if (out && !ok(out.status)) return res.status(codeOf(out.status)).json({ error: errOf(out) });
    const sync: SidecarSyncLogin = { enabled, roots, ...(enabled ? { linkedAt: user.sidecarSync?.linkedAt || new Date().toISOString() } : {}) };
    users.setSidecarSync(username, sync);
    return res.json({ user: users.getUser(username) });
  });

  router.delete('/users/:username/sidecar-sync', adminOnly, async (req: Request, res: Response) => {
    const users = store();
    if (!users) return res.status(501).json({ error: 'No user store' });
    const username = String(req.params.username).toLowerCase();
    if (!users.getUser(username)) return res.status(404).json({ error: 'User not found' });
    const list = await callReceiver('GET', '/v1/accounts');
    if (!ok(list.status)) return res.status(codeOf(list.status)).json({ error: errOf(list) });
    const acc = filterAccounts(list.body).find(a => a.username.toLowerCase() === username);
    if (acc) {
      const out = await callReceiver('DELETE', `/v1/accounts/${encodeURIComponent(acc.username)}`);
      audit.info(`sync login "${username}" remove by ${who(req)}: ${ok(out.status) ? 'ok' : `failed (${out.status})`}`);
      if (!ok(out.status)) return res.status(codeOf(out.status)).json({ error: errOf(out) });
    }
    users.setSidecarSync(username, undefined);
    return res.json({ user: users.getUser(username) });
  });
}

const ROOT_RE = /^[^/\\\0]+$/;

/** Root names from a list or "a, b" text. Returns an error text on bad input. */
export function cleanRoots(v: unknown): string[] | string {
  if (v === undefined || v === null) return [];
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
  if (!list) return '"roots" must be a list of root names';
  const out: string[] = [];
  for (const r of list) {
    const t = typeof r === 'string' ? r.trim() : '';
    if (!t) continue;
    if (!ROOT_RE.test(t) || t === '.' || t === '..') return `Root "${t}" must be a folder name (no "/" or "\\")`;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

export interface LinkResult { linked: string[]; created: string[]; alreadyLinked: string[] }

/**
 * Link receiver accounts to Fantom users by username. A missing user is made
 * as a viewer ("user" role) with dashboard login off. Never changes a password.
 */
export async function linkReceiverAccounts(store: UserStore, list: () => Promise<ReceiverAccount[]>): Promise<LinkResult> {
  const result: LinkResult = { linked: [], created: [], alreadyLinked: [] };
  const now = new Date().toISOString();
  for (const acc of await list()) {
    const name = acc.username.toLowerCase();
    const user = store.getUser(name);
    if (!user) {
      if (store.createSyncOnlyUser(name, { enabled: true, roots: [], linkedAt: now })) result.created.push(name);
    } else if (user.sidecarSync?.enabled) {
      result.alreadyLinked.push(name);
    } else {
      store.setSidecarSync(name, { enabled: true, roots: user.sidecarSync?.roots ?? [], linkedAt: now });
      result.linked.push(name);
    }
  }
  return result;
}
