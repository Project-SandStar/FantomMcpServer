/**
 * RSS guard threshold, shared by the self-watchdog in src/index.ts, the
 * dashboard Graph tab and the dashboard Memory Usage card (so the warning uses
 * the same number that kills us).
 *
 * Resolution order: FANTOM_RSS_GUARD_MB env → `rssGuardMb` in
 * config/fantomMcpServer-config.json → 90% of the cgroup memory limit
 * (at least 4000) → 4000. 0 disables the guard.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type RssGuardSource = 'env' | 'config' | 'container' | 'default';

export interface RssGuard {
  mb: number;
  source: RssGuardSource;
}

/** cgroup v2 `memory.max` in MiB, or null outside a container / when unlimited. */
export function readContainerLimitMiB(): number | null {
  try {
    const bytes = Number(fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf-8').trim());
    return Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes / 1024 / 1024) : null;
  } catch { return null; }
}

export function resolveRssGuard(): RssGuard {
  const fromEnv = process.env.FANTOM_RSS_GUARD_MB;
  if (fromEnv !== undefined) {
    const n = Number(fromEnv);
    if (Number.isFinite(n)) return { mb: n, source: 'env' };
  }
  try {
    const cfgPath = path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      if (typeof cfg?.rssGuardMb === 'number' && Number.isFinite(cfg.rssGuardMb)) return { mb: cfg.rssGuardMb, source: 'config' };
    }
  } catch { /* fallthrough */ }
  // In a container, scale with the cgroup memory limit (90%), so the guard
  // sits above the heap cap on a 16 GB limit and still fires before the
  // kernel OOM kill.
  const limit = readContainerLimitMiB();
  if (limit !== null) return { mb: Math.max(4000, Math.round(limit * 0.9)), source: 'container' };
  return { mb: 4000, source: 'default' };
}

export function resolveRssGuardMb(): number {
  return resolveRssGuard().mb;
}

/** cgroup v2 `memory.current` in MiB (container RSS incl. page cache), or null. */
export function readContainerMemoryMiB(): number | null {
  try {
    const bytes = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf-8').trim());
    return Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes / 1024 / 1024) : null;
  } catch { return null; }
}

/** Same thresholds as the Graph tab warning. */
export const MEMORY_WARN_FRACTION = 0.85;
export const MEMORY_DANGER_FRACTION = 0.95;

export interface MemoryUsageView {
  /** RSS as % of the basis (guard, or container limit / RAM when the guard is off). */
  percentage: number;
  basisMb: number;
  basis: 'guard' | 'container' | 'ram';
  guardMb: number;
  guardSource: RssGuardSource;
  level: 'ok' | 'warn' | 'danger';
}

/**
 * Pure: what the dashboard Memory Usage card shows. The guard is what restarts
 * the process, so RSS is measured against it; with the guard off (0) the
 * container limit is the next ceiling, then total RAM.
 */
export function memoryUsageView(
  rssMb: number, guard: RssGuard, containerLimitMb: number | null, totalRamMb: number,
): MemoryUsageView {
  let basisMb: number;
  let basis: MemoryUsageView['basis'];
  if (guard.mb > 0) { basisMb = guard.mb; basis = 'guard'; }
  else if (containerLimitMb !== null && containerLimitMb > 0) { basisMb = containerLimitMb; basis = 'container'; }
  else { basisMb = totalRamMb; basis = 'ram'; }
  const frac = basisMb > 0 ? rssMb / basisMb : 0;
  const level = frac >= MEMORY_DANGER_FRACTION ? 'danger' : frac >= MEMORY_WARN_FRACTION ? 'warn' : 'ok';
  return {
    percentage: Math.round(frac * 1000) / 10,
    basisMb, basis, guardMb: guard.mb, guardSource: guard.source, level,
  };
}

/** Fields the /admin/status memory block adds for the Memory Usage card. */
export function rssGuardStatus(rssBytes: number): MemoryUsageView & { containerMb: number | null; containerLimitMb: number | null } {
  const containerLimitMb = readContainerLimitMiB();
  const view = memoryUsageView(rssBytes / 1048576, resolveRssGuard(), containerLimitMb, Math.round(os.totalmem() / 1048576));
  return { ...view, containerMb: readContainerMemoryMiB(), containerLimitMb };
}
