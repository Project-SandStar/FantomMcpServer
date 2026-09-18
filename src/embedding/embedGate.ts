/**
 * Shared gates for heavy embedding/indexing work.
 *
 * 1. `shadowReembedActive` — legacy flag: a shadow re-embed (full rebuild into
 *    the inactive code-vector slot) is in progress; the auto-embed watchdog
 *    stands down while it is set.
 *
 * 2. Heavy-job lock — ONE exclusive in-process lock shared by the code
 *    re-embed job, forced code reindexes and Axon index jobs. Two of these at
 *    once tripped the 4 GB RSS guard (exit 137) and split the shared sidecar
 *    fleet; now they serialise. `acquireHeavyJob` throws `HeavyJobBusyError`
 *    with the current holder; `waitForHeavyJob` queues FIFO and resolves when
 *    the lock is handed over (release hands the lock straight to the next
 *    waiter; a 5 s safety poll covers any missed hand-over).
 *
 * In-process state (single server); reset on restart, which also aborts the
 * jobs it protects.
 */

let shadowReembedActive = false;

export function setShadowReembedActive(active: boolean): void {
  shadowReembedActive = active;
}

export function isShadowReembedActive(): boolean {
  return shadowReembedActive;
}

// ── Heavy-job lock ──────────────────────────────────────────────────────────

export type HeavyJobKind = 'code-reembed' | 'code-reindex' | 'axon-index';

export interface HeavyJobHolder {
  kind: HeavyJobKind;
  label: string;
  /** ISO timestamp of acquisition. */
  since: string;
}

export interface HeavyJobWaiter {
  kind: HeavyJobKind;
  label: string;
  since: string;
}

export class HeavyJobBusyError extends Error {
  readonly holder: HeavyJobHolder;
  constructor(holder: HeavyJobHolder, requested: { kind: HeavyJobKind; label: string }) {
    super(`heavy job busy: ${holder.kind} (${holder.label}) running since ${holder.since} — ${requested.kind} (${requested.label}) must wait`);
    this.name = 'HeavyJobBusyError';
    this.holder = holder;
  }
}

export type HeavyJobRelease = () => void;

interface Waiter extends HeavyJobWaiter {
  resolve: (release: HeavyJobRelease) => void;
  reject: (err: Error) => void;
}

let holder: HeavyJobHolder | null = null;
let holderToken = 0; // guards double release
const waiters: Waiter[] = [];
const HEAVY_JOB_POLL_MS = 5_000;

function makeRelease(token: number): HeavyJobRelease {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (holderToken !== token) return; // stale release (already handed over)
    holder = null;
    handOver();
  };
}

/** Give the lock to the next FIFO waiter, if any. */
function handOver(): void {
  if (holder) return;
  const next = waiters.shift();
  if (!next) return;
  holder = { kind: next.kind, label: next.label, since: new Date().toISOString() };
  holderToken++;
  next.resolve(makeRelease(holderToken));
}

/**
 * Acquire the lock now or throw `HeavyJobBusyError` with the current holder.
 * Returns the release function (idempotent).
 */
export function acquireHeavyJob(kind: HeavyJobKind, label: string): HeavyJobRelease {
  if (holder) throw new HeavyJobBusyError(holder, { kind, label });
  if (waiters.length > 0) {
    // Someone is queued ahead: a direct acquire must not jump the queue.
    throw new HeavyJobBusyError({ kind: waiters[0].kind, label: `${waiters[0].label} (queued)`, since: waiters[0].since }, { kind, label });
  }
  holder = { kind, label, since: new Date().toISOString() };
  holderToken++;
  return makeRelease(holderToken);
}

/**
 * Acquire the lock, waiting FIFO if busy. `onWaiting` is called with the
 * current holder each time the caller is (still) waiting. Aborts via `signal`.
 */
export function waitForHeavyJob(
  kind: HeavyJobKind,
  label: string,
  opts: { signal?: AbortSignal; onWaiting?: (holder: HeavyJobHolder | null) => void } = {},
): Promise<HeavyJobRelease> {
  try {
    const release = acquireHeavyJob(kind, label);
    return Promise.resolve(release);
  } catch (e) {
    if (!(e instanceof HeavyJobBusyError)) return Promise.reject(e);
  }
  return new Promise<HeavyJobRelease>((resolve, reject) => {
    const w: Waiter = { kind, label, since: new Date().toISOString(), resolve, reject };
    waiters.push(w);
    opts.onWaiting?.(holder);
    // Safety poll: in case a release hand-over was missed, retry the hand-over.
    const timer = setInterval(() => {
      if (!waiters.includes(w)) { clearInterval(timer); return; }
      opts.onWaiting?.(holder);
      handOver();
    }, HEAVY_JOB_POLL_MS);
    timer.unref?.();
    const origResolve = w.resolve;
    w.resolve = (rel) => { clearInterval(timer); origResolve(rel); };
    const abort = () => {
      const i = waiters.indexOf(w);
      if (i >= 0) waiters.splice(i, 1);
      clearInterval(timer);
      reject(new Error('cancelled while waiting for the heavy-job lock'));
    };
    if (opts.signal) {
      if (opts.signal.aborted) abort();
      else opts.signal.addEventListener('abort', abort, { once: true });
    }
  });
}

export function getHeavyJob(): HeavyJobHolder | null {
  return holder;
}

export function getHeavyJobQueue(): HeavyJobWaiter[] {
  return waiters.map(w => ({ kind: w.kind, label: w.label, since: w.since }));
}

/** True while any heavy job holds the lock (or the legacy shadow flag is set). */
export function isHeavyJobActive(): boolean {
  return holder !== null || shadowReembedActive;
}

/** Test hook: clear all state. */
export function _resetHeavyJobLockForTests(): void {
  holder = null;
  holderToken = 0;
  for (const w of waiters.splice(0)) w.reject(new Error('reset'));
  shadowReembedActive = false;
}
