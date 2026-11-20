/**
 * Buffer-pool and thread sizing for the per-project LadybugDB stores.
 *
 * Why threads matter: LadybugDB runs one query on as many worker threads as
 * the machine reports, and every worker pins its own pages in the buffer
 * pool. The Docker host reports 112 CPUs, so a 24 MiB pool filled on the
 * first scan of a 7 MB store ("Buffer manager exception: Unable to allocate
 * memory! The buffer pool is full", 2026-11-03, projects 4/11/13). On a copy
 * of store 11 a 24 MiB pool failed at >= 16 threads and passed at <= 8.
 * Graph queries here are small and serialized per project, so a few threads
 * lose nothing.
 *
 * Pool size: 5 × the store file (big stores need room for rebuilds), with a
 * floor, and a cap from the memory budget: (memory limit × fraction) / max
 * open stores. Every number is overridable by env.
 */

import * as fs from 'fs';
import * as os from 'os';
import { getSavedGraphSettings, resolveGraphKnob } from './graphSettings.js';

/** "buffer pool is full and no memory could be freed" and its variants. */
export function isBufferPoolError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /buffer pool is full|Buffer manager exception|Unable to allocate memory/i.test(m);
}

function knob(name: Parameters<typeof resolveGraphKnob>[0]): number {
  return resolveGraphKnob(name, getSavedGraphSettings()).value;
}

/** Memory limit in MiB: the cgroup v2 limit in a container, else total RAM. */
export function readMemoryLimitMiB(): number {
  try {
    const raw = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf-8').trim();
    const bytes = Number(raw);
    if (Number.isFinite(bytes) && bytes > 0) return Math.round(bytes / 1024 / 1024);
  } catch { /* not cgroup v2 or not a container */ }
  return Math.round(os.totalmem() / 1024 / 1024);
}

export interface PoolSizingInput {
  /** Store file size in MiB (0 for a new store). */
  fileMiB: number;
  /** Max simultaneously-open project stores (FANTOM_GRAPH_MAX_OPEN). */
  maxOpen: number;
  /** Memory limit in MiB (cgroup limit or total RAM). */
  memLimitMiB: number;
  /** FANTOM_GRAPH_DB_BUFFER_MIB: a fixed size, skips all sizing. */
  fixedMiB?: number;
  /** FANTOM_GRAPH_DB_BUFFER_MIN_MIB, default 32. */
  minMiB?: number;
  /** FANTOM_GRAPH_DB_BUFFER_MAX_MIB, default 256. */
  maxMiB?: number;
  /** FANTOM_GRAPH_POOL_MEM_FRACTION: share of memory for all open pools, default 0.0625. */
  memFraction?: number;
}

export const DEFAULT_POOL_MIN_MIB = 32;
export const DEFAULT_POOL_MAX_MIB = 256;
export const DEFAULT_POOL_MEM_FRACTION = 0.0625;

/** Pool size in MiB for one project store. Pure; see the module comment. */
export function computeProjectBufferPoolMiB(input: PoolSizingInput): number {
  if (input.fixedMiB && input.fixedMiB > 0) return Math.ceil(input.fixedMiB);
  const floor = input.minMiB ?? DEFAULT_POOL_MIN_MIB;
  const hardMax = Math.max(floor, input.maxMiB ?? DEFAULT_POOL_MAX_MIB);
  const fraction = input.memFraction ?? DEFAULT_POOL_MEM_FRACTION;
  const perStoreBudget = (input.memLimitMiB * fraction) / Math.max(1, input.maxOpen);
  const cap = Math.min(hardMax, Math.max(floor, Math.floor(perStoreBudget)));
  const wanted = Math.ceil(Math.max(0, input.fileMiB) * 5);
  return Math.min(cap, Math.max(floor, wanted));
}

/** Pool size from the environment and this machine. */
export function resolveProjectBufferPoolMiB(fileMiB: number, maxOpen: number): number {
  return computeProjectBufferPoolMiB({
    fileMiB,
    maxOpen,
    memLimitMiB: readMemoryLimitMiB(),
    // Dashboard value > env > default (src/graph/graphSettings.ts).
    fixedMiB: knob('bufferFixedMiB') || undefined,
    minMiB: knob('bufferMinMiB'),
    maxMiB: knob('bufferMaxMiB'),
    memFraction: knob('poolMemFraction'),
  });
}

export const DEFAULT_QUERY_THREADS = 4;

/** Threads per graph query: FANTOM_GRAPH_QUERY_THREADS, else min(CPUs, 4). */
export function resolveGraphQueryThreads(cpus: number = os.availableParallelism?.() ?? os.cpus().length): number {
  // Dashboard value > FANTOM_GRAPH_QUERY_THREADS > min(CPUs, 4).
  return resolveGraphKnob('queryThreads', getSavedGraphSettings(), process.env, cpus).value;
}

/** Minimal connection surface used by `runWithPoolFullRetry`. */
export interface ThreadTunableConnection {
  setMaxNumThreadForExec(n: number): void;
}

/**
 * Run a read query; if it fails with a full buffer pool, run it once more on
 * ONE thread (fewest pinned pages), then restore the thread count. Any other
 * error, or a second pool failure, is thrown to the caller.
 */
export async function runWithPoolFullRetry<R>(
  conn: ThreadTunableConnection,
  normalThreads: number,
  op: () => Promise<R>,
  onRetry?: (err: unknown) => void,
): Promise<R> {
  try {
    return await op();
  } catch (err) {
    if (!isBufferPoolError(err) || normalThreads <= 1) throw err;
    onRetry?.(err);
    conn.setMaxNumThreadForExec(1);
    try {
      return await op();
    } finally {
      try { conn.setMaxNumThreadForExec(normalThreads); } catch { /* best-effort */ }
    }
  }
}
