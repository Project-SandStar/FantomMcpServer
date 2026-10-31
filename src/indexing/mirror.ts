/**
 * Sidecar mirror support (fileSystemSideCar, docs/receiver.md, Task 8.3).
 *
 * The sidecar-receiver writes files to
 *   {FANTOM_MIRROR_ROOT}/{sidecarId}/{rootName}/{relPath}   (default root /mirror)
 * and then POSTs {"sidecar", "root", "paths": [relPath, ...]} to
 * /admin/indexing/report. This module turns that body into absolute paths
 * for reportChanges(), and registers mirror folders as Fantom projects.
 *
 * FANTOM_MIRROR_PROJECTS (read at boot):
 *   unset               nothing is registered
 *   "auto"              every {root}/{sidecar}/{rootName} folder becomes a
 *                       project named "{sidecar}-{rootName}". Install trees
 *                       (SkySpark/Haxall/Fantom homes, or folders of them)
 *                       and names in FANTOM_MIRROR_EXCLUDE are skipped.
 *   "a=/mirror/x/A,..." comma list of name=path (or bare paths; name = folder)
 * Paths already registered are left alone. New projects get autoIndex on.
 */

import * as fs from 'fs';
import * as path from 'path';

export const MIRROR_ROOT_ENV = 'FANTOM_MIRROR_ROOT';
export const MIRROR_PROJECTS_ENV = 'FANTOM_MIRROR_PROJECTS';

export function mirrorRoot(env: NodeJS.ProcessEnv = process.env): string {
  const v = env[MIRROR_ROOT_ENV]?.trim();
  return v && path.isAbsolute(v) ? path.resolve(v) : '/mirror';
}

/** One path segment: no separators, not "." or "..", not empty. */
function isSegment(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= 255
    && !/[\\/\0]/.test(s) && s !== '.' && s !== '..';
}

export interface MirrorPaths {
  base: string;
  files: string[];
  /** Paths refused: absolute, "..", or not strings. */
  rejected: string[];
}

/**
 * Map a receiver body to absolute paths under the mirror root. Throws when
 * sidecar or root is not a single safe path segment.
 */
export function mirrorPaths(root: string, sidecar: unknown, rootName: unknown, paths: unknown[]): MirrorPaths {
  if (!isSegment(sidecar)) throw new Error('sidecar must be a single path segment');
  if (!isSegment(rootName)) throw new Error('root must be a single path segment');
  const base = path.join(root, sidecar, rootName);
  const files: string[] = [];
  const rejected: string[] = [];
  for (const p of paths) {
    if (typeof p !== 'string' || p.trim() === '') { rejected.push(String(p)); continue; }
    const rel = p.replace(/\\/g, '/');
    if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split('/').includes('..') || rel.includes('\0')) {
      rejected.push(p);
      continue;
    }
    const abs = path.resolve(base, rel);
    if (abs !== base && abs.startsWith(base + path.sep)) files.push(abs); else rejected.push(p);
  }
  return { base, files: [...new Set(files)], rejected };
}

export interface MirrorProjectSpec { name: string; path: string }

/** Comma list of rootNames (or "sidecar/rootName") that "auto" must skip. */
export const MIRROR_EXCLUDE_ENV = 'FANTOM_MIRROR_EXCLUDE';

export function mirrorExcludeNames(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env[MIRROR_EXCLUDE_ENV] ?? '').split(',').map(s => s.trim()).filter(Boolean));
}

/** Files that only a Fantom-runtime install home (SkySpark, Haxall, Fantom) has. */
const INSTALL_MARKERS = [
  'fan.props',
  path.join('etc', 'sys', 'config.props'),
  path.join('lib', 'fan', 'sys.pod'),
  path.join('home', 'lib', 'fan'),
  path.join('home', 'fan.props'),
  path.join('src', 'sys', 'build.fan'),
];

/** True when dir is an install home (has a marker file). */
export function isInstallHome(dir: string): boolean {
  return INSTALL_MARKERS.some(m => fs.existsSync(path.join(dir, m)));
}

/**
 * True when dir is an install home, or a folder of install homes (e.g. the
 * synced ~/skyspark that holds skyspark-3.1.12, skyspark-4.0.6, ...).
 */
export function isInstallTreeRoot(dir: string): boolean {
  if (isInstallHome(dir)) return true;
  let kids: fs.Dirent[] = [];
  try { kids = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  return kids.some(d => d.isDirectory() && !d.name.startsWith('.') && isInstallHome(path.join(dir, d.name)));
}

/** Parse FANTOM_MIRROR_PROJECTS into project specs (see the file header). */
export function mirrorProjectSpecs(env: NodeJS.ProcessEnv = process.env): MirrorProjectSpec[] {
  const raw = env[MIRROR_PROJECTS_ENV]?.trim();
  if (!raw) return [];
  const root = mirrorRoot(env);
  if (raw === 'auto') {
    const out: MirrorProjectSpec[] = [];
    const dirs = (p: string) => {
      try { return fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name).sort(); } catch { return []; }
    };
    const exclude = mirrorExcludeNames(env);
    for (const sidecar of dirs(root)) {
      for (const rootName of dirs(path.join(root, sidecar))) {
        const p = path.join(root, sidecar, rootName);
        if (exclude.has(rootName) || exclude.has(`${sidecar}/${rootName}`)) continue;
        // SkySpark / Haxall / Fantom install trees are instances (docs, pods),
        // not code projects. As one project they hold 100k+ functions, and
        // the indexer trips the RSS guard. Skip them.
        if (isInstallTreeRoot(p)) continue;
        out.push({ name: `${sidecar}-${rootName}`, path: p });
      }
    }
    return out;
  }
  return raw.split(',').map(s => s.trim()).filter(Boolean).flatMap((entry) => {
    const eq = entry.indexOf('=');
    const p = (eq > 0 ? entry.slice(eq + 1) : entry).trim();
    if (!path.isAbsolute(p)) return [];
    const name = eq > 0 ? entry.slice(0, eq).trim() : path.basename(p);
    return name ? [{ name, path: path.resolve(p) }] : [];
  });
}

export interface MirrorRegistryDeps {
  listPaths(): Promise<string[]>;
  create(spec: MirrorProjectSpec): Promise<void>;
}

/** Register missing mirror projects. Returns the names created. */
export async function registerMirrorProjects(deps: MirrorRegistryDeps, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  return registerMirrorSpecs(deps, mirrorProjectSpecs(env));
}

/** Register the given specs when their folder exists and the path is new. */
export async function registerMirrorSpecs(deps: MirrorRegistryDeps, specs: MirrorProjectSpec[]): Promise<string[]> {
  if (specs.length === 0) return [];
  const known = new Set((await deps.listPaths()).map(p => path.resolve(p)));
  const created: string[] = [];
  for (const s of specs) {
    if (known.has(s.path) || !fs.existsSync(s.path)) continue;
    await deps.create(s);
    known.add(s.path);
    created.push(s.name);
  }
  return created;
}
