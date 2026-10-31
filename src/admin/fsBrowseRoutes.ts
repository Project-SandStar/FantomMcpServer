/**
 * GET /admin/fs/dirs?path=<abs> — server-side folder picker for the dashboard.
 * Register AFTER the auth middleware; admin role (or API token) only.
 *
 * Lists folders only, inside an allowlist of roots:
 *   FANTOM_BROWSE_ROOTS  colon or comma list of absolute folders, else the
 *   defaults: FANTOM_MIRROR_ROOT (/mirror), AXON_PROJECT_PATH (/axon/proj) and
 *   the workflows folder. Roots that do not exist are left out.
 * Every path goes through fs.realpath, so ".." and symlinks that leave a root
 * are refused (403). Dotfiles are hidden, and the config folder is never listed.
 */
import type { Router, Request, Response, NextFunction } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { mirrorRoot } from '../indexing/mirror.js';
import { resolveWorkflowsDir } from '../workflows/workflowManager.js';

export const BROWSE_ROOTS_ENV = 'FANTOM_BROWSE_ROOTS';
export const MAX_ENTRIES = 500;

export type DirHint = 'skyspark-home' | 'haxall-home' | 'fantom-home' | 'docs' | 'pod' | 'axon-project' | 'axon-proj';

export interface DirEntry { name: string; path: string; isDir: true; hint?: DirHint }
export interface DirListing {
  path: string;
  parent: string | null;
  root: string;
  roots: string[];
  hint?: DirHint;
  entries: DirEntry[];
  fileCount: number;
  truncated: boolean;
}

export interface BrowseOptions {
  env?: () => NodeJS.ProcessEnv;
  /** Folders never listed (secrets). Default: <cwd>/config and /app/config. */
  denied?: () => string[];
}

function realOrNull(p: string): string | null {
  try { return fs.realpathSync(p); } catch { return null; }
}

/** Configured roots, resolved; missing ones dropped; duplicates removed. */
export function browseRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[BROWSE_ROOTS_ENV]?.trim();
  const list = raw
    ? raw.split(/[:,]/).map(s => s.trim()).filter(Boolean)
    : [mirrorRoot(env), env.AXON_PROJECT_PATH?.trim() || '/axon/proj', resolveWorkflowsDir(env)];
  const out: string[] = [];
  for (const r of list) {
    if (!path.isAbsolute(r)) continue;
    const real = realOrNull(r);
    if (real && fs.statSync(real).isDirectory() && !out.includes(real)) out.push(real);
  }
  return out;
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function has(dir: string, ...rel: string[]): boolean {
  try { return fs.existsSync(path.join(dir, ...rel)); } catch { return false; }
}

function subdirs(dir: string, limit = 50): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.')).slice(0, limit).map(e => e.name);
  } catch { return []; }
}

/** Guess what kind of folder this is, so the user picks the right level. */
export function detectHint(dir: string): DirHint | undefined {
  const isHome = has(dir, 'lib', 'fan') || has(dir, 'bin', 'fan') || has(dir, 'etc', 'sys');
  if (isHome) {
    const n = (path.basename(path.dirname(dir)) + '/' + path.basename(dir)).toLowerCase();
    if (n.includes('skyspark') || has(dir, 'lib', 'fan', 'skyarcd.pod') || has(dir, 'etc', 'skyarcd')) return 'skyspark-home';
    if (n.includes('haxall') || has(dir, 'lib', 'fan', 'hx.pod') || has(dir, 'etc', 'hx')) return 'haxall-home';
    return 'fantom-home';
  }
  if (has(dir, 'build.fan')) return 'pod';
  if (has(dir, 'func')) {
    try {
      if (fs.readdirSync(path.join(dir, 'func')).some(f => f.endsWith('.axon'))) return 'axon-project';
    } catch { /* not readable */ }
  }
  if (path.basename(dir) === 'proj' && subdirs(dir, 20).some(s => subdirs(path.join(dir, s), 20).some(p => has(dir, s, p, 'func')))) return 'axon-proj';
  if (path.basename(dir) === 'doc' ? subdirs(dir, 5).length > 0 : subdirs(path.join(dir, 'doc'), 5).length > 0 && !has(dir, 'src')) return 'docs';
  return undefined;
}

export class BrowseError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function listDirs(reqPath: string | undefined, env: NodeJS.ProcessEnv, denied: string[]): DirListing {
  const roots = browseRoots(env);
  if (roots.length === 0) throw new BrowseError(404, `no browse roots exist; set ${BROWSE_ROOTS_ENV}`);
  const want = reqPath && reqPath.trim() ? reqPath.trim() : roots[0];
  if (!path.isAbsolute(want) || want.includes('\0')) throw new BrowseError(400, 'path must be absolute');
  const real = realOrNull(want);
  if (!real) throw new BrowseError(404, 'folder not found');
  const root = roots.find(r => isInside(real, r));
  const deny = denied.map(d => realOrNull(d) ?? path.resolve(d));
  if (!root || deny.some(d => isInside(real, d))) throw new BrowseError(403, 'path is outside the allowed roots');
  if (!fs.statSync(real).isDirectory()) throw new BrowseError(400, 'not a folder');

  let dirents: fs.Dirent[];
  try { dirents = fs.readdirSync(real, { withFileTypes: true }); } catch { throw new BrowseError(403, 'folder not readable'); }
  dirents.sort((a, b) => a.name.localeCompare(b.name));
  const entries: DirEntry[] = [];
  let fileCount = 0;
  let truncated = false;
  for (const d of dirents) {
    if (d.name.startsWith('.')) continue;
    const full = path.join(real, d.name);
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) {
      const t = realOrNull(full);
      // A link is shown only when its target stays inside a root.
      isDir = !!t && roots.some(r => isInside(t, r)) && fs.statSync(t).isDirectory();
      if (!t || !isDir) { if (!isDir) fileCount++; continue; }
    }
    if (!isDir) { fileCount++; continue; }
    if (deny.some(x => isInside(full, x))) continue;
    if (entries.length >= MAX_ENTRIES) { truncated = true; continue; }
    const hint = detectHint(full);
    entries.push({ name: d.name, path: full, isDir: true, ...(hint ? { hint } : {}) });
  }
  const up = path.dirname(real);
  const hint = detectHint(real);
  return {
    path: real,
    parent: real !== root && isInside(up, root) ? up : null,
    root, roots, ...(hint ? { hint } : {}), entries, fileCount, truncated,
  };
}

function adminOnly(req: Request, res: Response, next: NextFunction): void {
  const u = (req as any).user;
  if (res.locals.apiTokenOk || u?.role === 'admin') { next(); return; }
  res.status(u ? 403 : 401).json({ error: u ? 'Admin access required' : 'Authentication required' });
}

export function registerFsBrowseRoutes(router: Router, opts: BrowseOptions = {}): void {
  const env = opts.env ?? (() => process.env);
  const denied = opts.denied ?? (() => [path.join(process.cwd(), 'config'), '/app/config']);
  router.get('/fs/dirs', adminOnly, (req: Request, res: Response): void => {
    const p = typeof req.query.path === 'string' ? req.query.path : undefined;
    try {
      res.json(listDirs(p, env(), denied()));
    } catch (e) {
      if (e instanceof BrowseError) { res.status(e.status).json({ error: e.message }); return; }
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}
