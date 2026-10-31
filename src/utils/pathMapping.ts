/**
 * Path mapping: rewrite a host path prefix (e.g. a Mac path stored in the DB)
 * to the path where the same folder is visible here (e.g. the sidecar mirror
 * inside the container).
 *
 *   /home/user/skyspark  →  /mirror/mac-user/skyspark
 *
 * Stored in `config/fantomMcpServer-config.json` → `pathMappings`, or the env
 * `FANTOM_PATH_MAPPINGS` ("from=to;from=to"), env first. Applied when the DB
 * rows are read (instances, builds, pods, projects, settings), so the stored
 * value never has to change. The longest matching prefix wins, and only at a
 * folder boundary (`/home/user/sky` does not match `/home/user/skyspark`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readConfigFileWithRecovery, atomicWriteConfigFile } from '../config/index.js';

export interface PathMapping {
  from: string;
  to: string;
}

const configPath = (): string => path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');

function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/[\\/]+$/, '') : p;
}

/** Keep only well-formed rows; trailing slashes removed. */
export function sanitizePathMappings(raw: unknown): PathMapping[] {
  if (!Array.isArray(raw)) return [];
  const out: PathMapping[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const from = typeof (r as any).from === 'string' ? trimSlash((r as any).from.trim()) : '';
    const to = typeof (r as any).to === 'string' ? trimSlash((r as any).to.trim()) : '';
    if (!from || !to || from === to) continue;
    out.push({ from, to });
  }
  return out;
}

/** "from=to;from=to" → rows. */
export function parsePathMappingsEnv(v: string | undefined): PathMapping[] {
  if (!v?.trim()) return [];
  return sanitizePathMappings(
    v.split(';').map(s => s.trim()).filter(Boolean).map(s => {
      const i = s.indexOf('=');
      return i > 0 ? { from: s.slice(0, i), to: s.slice(i + 1) } : null;
    }),
  );
}

let cache: { at: number; rows: PathMapping[] } | null = null;
const CACHE_MS = 2000;

/** Env rows first, then saved rows. Cached for 2 s (read on every DB row). */
export function getPathMappings(env: NodeJS.ProcessEnv = process.env): PathMapping[] {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  const saved = sanitizePathMappings(readConfigFileWithRecovery(configPath())?.pathMappings);
  const rows = [...parsePathMappingsEnv(env.FANTOM_PATH_MAPPINGS), ...saved];
  cache = { at: Date.now(), rows };
  return rows;
}

export function getPathMappingsWithSource(env: NodeJS.ProcessEnv = process.env): {
  env: PathMapping[]; saved: PathMapping[];
} {
  return {
    env: parsePathMappingsEnv(env.FANTOM_PATH_MAPPINGS),
    saved: sanitizePathMappings(readConfigFileWithRecovery(configPath())?.pathMappings),
  };
}

export function savePathMappings(rows: unknown): PathMapping[] {
  const clean = sanitizePathMappings(rows);
  const cfg = readConfigFileWithRecovery(configPath());
  cfg.pathMappings = clean;
  atomicWriteConfigFile(configPath(), cfg);
  cache = null;
  return clean;
}

/** Test hook. */
export function clearPathMappingCache(): void {
  cache = null;
}

/**
 * Map one path. Longest `from` prefix wins; it must match a whole folder name.
 * `~/x` is not expanded. Returns the input when nothing matches.
 */
export function mapPath(p: string, rows?: PathMapping[]): string;
export function mapPath(p: string | null | undefined, rows?: PathMapping[]): string | null | undefined;
export function mapPath(p: string | null | undefined, rows: PathMapping[] = getPathMappings()): string | null | undefined {
  if (!p || rows.length === 0) return p;
  let best: PathMapping | null = null;
  for (const r of rows) {
    if (p === r.from || p.startsWith(r.from + '/') || p.startsWith(r.from + '\\')) {
      if (!best || r.from.length > best.from.length) best = r;
    }
  }
  if (!best) return p;
  return best.to + p.slice(best.from.length);
}

/** For the Settings page: does the mapped target exist here? */
export function checkPathMappings(rows: PathMapping[]): Array<PathMapping & { toExists: boolean }> {
  return rows.map(r => ({ ...r, toExists: fs.existsSync(r.to) }));
}
