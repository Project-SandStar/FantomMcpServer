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
/** True while a full rebuild writes the ACTIVE slot (`live: true`), not a shadow. */
let liveRebuildActive = false;

/**
 * `target` says which slot the rebuild writes. Readers that must not fight a
 * rebuild (watchdog, auto-embed) gate on either; `/vectors/stats` counts the
 * INACTIVE slot only for a shadow build. A live rebuild used to raise the same
 * flag and the page counted the inactive slot — empty right after a width
 * change dropped the old table — and showed 0 vectors while 16k rows landed
 * in the live one (2026-09-29, 4B → 8B switch).
 */
export function setShadowReembedActive(active: boolean, target: 'shadow' | 'live' = 'shadow'): void {
  if (target === 'live') { liveRebuildActive = active; if (active) shadowReembedActive = false; }
  else { shadowReembedActive = active; if (active) liveRebuildActive = false; }
}

/** A full rebuild is running somewhere (shadow OR live) — stand down. */
export function isShadowReembedActive(): boolean {
  return shadowReembedActive || liveRebuildActive;
}

/** The rebuild writes the INACTIVE slot: count that slot for progress. */
export function isShadowSlotBuilding(): boolean {
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

/**
 * Live progress a holder publishes (3.12 item 6), so every refusal can say
 * what is running: project N of M, functions done, providers, ETA.
 */
export interface HeavyJobProgress {
  /** Link to the page that owns the job (dashboard route). */
  page?: string;
  /** Id the owner's cancel endpoint takes. */
  jobId?: string;
  projectsDone?: number;
  projectsTotal?: number;
  itemsDone?: number;
  itemsTotal?: number;
  itemsLabel?: string;
  providers?: string[];
  /** Run start (the lock may be re-taken per project). */
  startedAt?: string;
  currentProject?: string;
}

const KIND_NAMES: Record<HeavyJobKind, string> = {
  'code-reembed': 'Code re-embedding',
  'code-reindex': 'Code reindexing',
  'axon-index': 'Axon indexing',
};

const progressByKind = new Map<HeavyJobKind, HeavyJobProgress>();

/** Publish (or clear with null) the progress of a running heavy job. */
export function setHeavyJobProgress(kind: HeavyJobKind, p: HeavyJobProgress | null): void {
  if (p) progressByKind.set(kind, p); else progressByKind.delete(kind);
}

export function getHeavyJobProgress(kind: HeavyJobKind): HeavyJobProgress | null {
  return progressByKind.get(kind) ?? null;
}

/** ETA in minutes from the run start and items done, or null. */
export function heavyJobEtaMin(p: HeavyJobProgress, now = Date.now()): number | null {
  if (!p.startedAt || !p.itemsDone || !p.itemsTotal || p.itemsDone >= p.itemsTotal) return null;
  const elapsed = now - Date.parse(p.startedAt);
  if (!(elapsed > 0)) return null;
  return Math.max(1, Math.round((elapsed / p.itemsDone) * (p.itemsTotal - p.itemsDone) / 60_000));
}

/**
 * One human sentence about a holder, e.g. "Axon indexing is running (project
 * 18/121, 760/4996 functions, 1 provider, started 10:02, ETA 25 min)".
 */
export function describeHeavyJob(h: HeavyJobHolder, p: HeavyJobProgress | null = getHeavyJobProgress(h.kind), now = Date.now()): string {
  const parts: string[] = [];
  if (p?.projectsTotal) parts.push(`project ${Math.min((p.projectsDone ?? 0) + 1, p.projectsTotal)}/${p.projectsTotal}`);
  if (p?.itemsTotal) parts.push(`${p.itemsDone ?? 0}/${p.itemsTotal} ${p.itemsLabel ?? 'items'}`);
  if (p?.providers?.length) parts.push(`${p.providers.length} provider${p.providers.length === 1 ? '' : 's'}`);
  parts.push(`started ${(p?.startedAt ?? h.since).slice(11, 16)}`);
  const eta = p ? heavyJobEtaMin(p, now) : null;
  if (eta !== null) parts.push(`ETA ${eta} min`);
  return `${KIND_NAMES[h.kind] ?? h.kind} (${h.label}) is running (${parts.join(', ')})`;
}

/** Full refusal text for a request that hit the lock. */
export function heavyJobRefusal(h: HeavyJobHolder, what = 'This job'): string {
  const p = getHeavyJobProgress(h.kind);
  const where = h.kind === 'axon-index' ? ' or cancel it on the Axon page' : p?.page ? ` or cancel it on ${p.page}` : '';
  return `${describeHeavyJob(h, p)}. ${what} will start when it finishes${where}.`;
}

/** Snapshot for GET /admin/heavy-job and the dashboard banner. */
export function getHeavyJobStatus(): {
  active: boolean;
  holder: HeavyJobHolder | null;
  progress: HeavyJobProgress | null;
  message: string | null;
  etaMin: number | null;
  queue: HeavyJobWaiter[];
  shadowRebuild: boolean;
} {
  const p = holder ? getHeavyJobProgress(holder.kind) : null;
  return {
    active: holder !== null || shadowReembedActive,
    holder,
    progress: p,
    message: holder ? describeHeavyJob(holder, p) : shadowReembedActive ? 'A vector rebuild is running' : null,
    etaMin: p ? heavyJobEtaMin(p) : null,
    queue: getHeavyJobQueue(),
    shadowRebuild: shadowReembedActive,
  };
}

export class HeavyJobBusyError extends Error {
  readonly holder: HeavyJobHolder;
  /** Human sentence naming the holder (kind, scope, progress, ETA). */
  readonly humanMessage: string;
  constructor(holder: HeavyJobHolder, requested: { kind: HeavyJobKind; label: string }) {
    const human = heavyJobRefusal(holder, `${KIND_NAMES[requested.kind] ?? requested.kind} (${requested.label})`);
    super(human);
    this.name = 'HeavyJobBusyError';
    this.holder = holder;
    this.humanMessage = human;
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
  progressByKind.clear();
}
