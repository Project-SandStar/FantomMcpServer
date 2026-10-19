/**
 * `indexing.lazy` block of config/fantomMcpServer-config.json
 * (docs/proposals/lazy-incremental-indexing.md section 4).
 *
 * Phase 1 reads only the keys it uses. `enabled` is the phase gate and
 * `projects` the allow-list: the scheduler, the watchers and the queued
 * embed in runIndex act on a project only when both say yes. Reads go
 * through readConfigFileWithRecovery; the one writer (setLazyIndexing) goes
 * through atomicWriteConfigFile, so the three other co-writers of the file
 * never lose a key to this module.
 */

import * as path from 'path';
import { atomicWriteConfigFile, readConfigFileWithRecovery } from '../config/index.js';

export interface LazyIndexingConfig {
  enabled: boolean;
  /** Allow-list of project ids, or "all". Phase 1 rollout: [275]. */
  projects: number[] | 'all';
  git: {
    enabled: boolean;
    debounceMs: number;
    inProgressPollMs: number;
    pollMs: number;
    watch: { maxRoots: number };
    concurrency: number;
    retries: number;
    retryMs: number;
    reflogTail: number;
    maxFilesPerDiff: number;
    maxCommitsPerRun: number;
    rewriteAsSwitchFiles: number;
    discoverNestedRoots: boolean;
  };
  scan: {
    intervalMs: number;
    gitIntervalMs: number;
    concurrency: number;
    pageRows: number;
    shaAlwaysProjects: number[];
  };
  maxChangedShareForIncremental: number;
  /** File-level graph patch (3.4, phase 3): preload cap, pending_refs cap. */
  graphPatch: { enabled: boolean; maxPreloadNodes: number };
  pendingRefs: { maxPerProject: number };
  /**
   * Incremental embedding (3.5, phase 4): embed only changed text through
   * embed_cache, track it in vector_state, delete orphans. `gcIntervalMs`
   * paces the vector-gc and cache-prune tasks; `cacheMaxMb` 0 = the default
   * cap min(2 048 MB, 10 % of free disk at boot).
   */
  embedPatch: { enabled: boolean; gcIntervalMs: number; cacheMaxMb: number };
  workers: { parse: number; embed: number };
  retry: { maxAttempts: number; backoffMs: number; backoffCapMs: number };
  yield: { heavyJobPollMs: number };
  memory: { rssPauseMb: number; heapPauseMb: number; rssResumeMb: number; heapResumeMb: number; alertAfterMs: number };
  /** Scheduler dispatch tick and the task lease (crash recovery only). */
  tickMs: number;
  leaseMs: number;
  /** Focus set and AI change reports (3.11, phase 1b). */
  focus: FocusConfig;
  /**
   * Dirty-tree watch scope (3.2.4, D8). Phase 1b reads the value only (no
   * dirty watcher yet): 'primary', 'active', 'focus' (3.11.1) or project ids.
   */
  dirty: { projects: DirtyScope; activeWindowMs: number };
}

export type DirtyScope = 'primary' | 'active' | 'focus' | number[];

export interface FocusConfig {
  /** An entry expires after this long without a touch. */
  ttlMs: number;
  /** LRU cap on entries. */
  maxFiles: number;
  /** How long a tool answer waits for the re-parse of a changed focus file. */
  freshWaitMs: number;
  /** Add the `related` block to answers about focus symbols. */
  suggest: boolean;
}

export const DEFAULT_LAZY_CONFIG: LazyIndexingConfig = {
  enabled: false,
  projects: [],
  git: {
    enabled: true,
    debounceMs: 1_000, inProgressPollMs: 5_000, pollMs: 10_000,
    watch: { maxRoots: 200 },
    concurrency: 2, retries: 5, retryMs: 2_000,
    reflogTail: 64,
    maxFilesPerDiff: 5_000, maxCommitsPerRun: 500, rewriteAsSwitchFiles: 50,
    discoverNestedRoots: true,
  },
  scan: {
    intervalMs: 300_000,
    gitIntervalMs: 1_800_000,
    concurrency: 2, pageRows: 5_000,
    shaAlwaysProjects: [],
  },
  maxChangedShareForIncremental: 0.4,
  graphPatch: { enabled: true, maxPreloadNodes: 200_000 },
  pendingRefs: { maxPerProject: 50_000 },
  embedPatch: { enabled: true, gcIntervalMs: 6 * 3_600_000, cacheMaxMb: 0 },
  workers: { parse: 1, embed: 1 },
  retry: { maxAttempts: 5, backoffMs: 60_000, backoffCapMs: 3_600_000 },
  yield: { heavyJobPollMs: 30_000 },
  // The server idles at 2.1–3.2 GB RSS (node --max-old-space-size=4096); the
  // old 2560/2048 lines left the queue paused for good (2026-10-17).
  memory: { rssPauseMb: 3_584, heapPauseMb: 2_560, rssResumeMb: 3_072, heapResumeMb: 2_048, alertAfterMs: 600_000 },
  tickMs: 2_000,
  leaseMs: 30 * 60_000,
  focus: { ttlMs: 30 * 60_000, maxFiles: 500, freshWaitMs: 3_000, suggest: true },
  dirty: { projects: 'primary', activeWindowMs: 30 * 60_000 },
};

export function runtimeConfigPath(): string {
  return path.resolve(process.cwd(), 'config', 'fantomMcpServer-config.json');
}

function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Deep merge of plain objects; arrays and scalars from `over` replace. */
function merge<T>(base: T, over: unknown): T {
  if (!isObj(over)) return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : v;
  }
  return out;
}

function posNum(v: unknown, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/** Merge a raw `indexing.lazy` object over the defaults. */
export function resolveLazyConfig(raw: unknown): LazyIndexingConfig {
  const cfg = merge(DEFAULT_LAZY_CONFIG, raw);
  if (cfg.projects !== 'all') {
    cfg.projects = Array.isArray(cfg.projects)
      ? cfg.projects.map(Number).filter(n => Number.isInteger(n) && n > 0)
      : [];
  }
  cfg.enabled = cfg.enabled === true;
  // merge() shares untouched nested objects with the defaults: copy before normalising.
  cfg.focus = { ...cfg.focus };
  cfg.dirty = { ...cfg.dirty };
  const dp: unknown = cfg.dirty.projects;
  cfg.dirty.projects = Array.isArray(dp)
    ? dp.map(Number).filter(n => Number.isInteger(n) && n > 0)
    : dp === 'active' || dp === 'focus' ? dp : 'primary';
  const f = cfg.focus, d = DEFAULT_LAZY_CONFIG.focus;
  f.ttlMs = posNum(f.ttlMs, d.ttlMs);
  f.maxFiles = Math.floor(posNum(f.maxFiles, d.maxFiles));
  f.freshWaitMs = Number.isFinite(Number(f.freshWaitMs)) && Number(f.freshWaitMs) >= 0 ? Number(f.freshWaitMs) : d.freshWaitMs;
  f.suggest = f.suggest !== false;
  return cfg;
}

/** Fresh read of the runtime config (cheap; called per tick, not per file). */
export function loadLazyConfig(configPath = runtimeConfigPath()): LazyIndexingConfig {
  const file = readConfigFileWithRecovery(configPath);
  return resolveLazyConfig(file?.indexing?.lazy);
}

export function isLazyEnabledFor(projectId: number, cfg: LazyIndexingConfig = loadLazyConfig()): boolean {
  if (!cfg.enabled) return false;
  return cfg.projects === 'all' || cfg.projects.includes(projectId);
}

/**
 * Turn the phase gate on/off and set the allow-list. Read-modify-write of the
 * whole file through the crash-safe pair, touching only `indexing.lazy`.
 */
export function setLazyIndexing(
  patch: { enabled?: boolean; projects?: number[] | 'all' },
  configPath = runtimeConfigPath(),
): LazyIndexingConfig {
  const file = readConfigFileWithRecovery(configPath) ?? {};
  const indexing = isObj(file.indexing) ? file.indexing : {};
  const lazy = isObj(indexing.lazy) ? indexing.lazy : {};
  if (patch.enabled !== undefined) lazy.enabled = patch.enabled;
  if (patch.projects !== undefined) lazy.projects = patch.projects;
  indexing.lazy = lazy;
  file.indexing = indexing;
  atomicWriteConfigFile(configPath, file);
  return resolveLazyConfig(lazy);
}
