/**
 * OpenRouter worker pool.
 *
 * One worker = one bulk OpenRouter request in flight. Bulk jobs (index and
 * re-embed batches, contextualiser) wait in Fantom's own queue and are served
 * round robin across projects, so a big project cannot starve a small one.
 * Interactive jobs (query embed, rerank, chat for an ask, RLM turns, Test
 * buttons) have their own small lane outside the worker count: a search never
 * waits behind a re-embed.
 *
 * Bulk limit = min(workerCount, 429 limit, event-loop lag limit).
 *  - 429: halve, jittered cooldown (Retry-After when given), ramp back +1 per
 *    15 s without a 429. A rate-limited bulk job is retried after the cooldown
 *    (up to 3 times); network/5xx once.
 *  - lag: see loopLag.ts.
 */
import { currentOpenRouterProject } from './projectContext.js';
import { getPoolSettings, type PoolSettings } from './settings.js';
import { LoopLagGuard, type LagState } from './loopLag.js';
import { isRateLimited, isRetryable, OpenRouterError } from './client.js';

export type Lane = 'bulk' | 'interactive';

/**
 * What a job learns when it starts. `worker` is the 1-based bulk slot it holds
 * (stable per slot: the lowest free one, so with Workers = 6 the names are
 * worker1 … worker6); null on the interactive lane, which is outside the count.
 */
export interface JobContext { worker: number | null }

export interface JobSpec<T> {
  role: string;
  lane: Lane;
  projectId?: number;
  run: (ctx: JobContext) => Promise<T>;
}

interface Queued {
  role: string;
  projectKey: number;
  attempts: number;
  run: (ctx: JobContext) => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  enqueuedAt: number;
}

export interface RoleStats {
  queued: number;
  running: number;
  done: number;
  failed: number;
  rateLimited: number;
  retried: number;
  meanMs: number;
  meanWaitMs: number;
}

export interface PoolStats {
  settings: PoolSettings;
  bulk: { running: number; queued: number; limit: number; projects: number };
  interactive: { running: number; queued: number; limit: number };
  rateLimit: { adaptiveLimit: number; hits: number; coolingDownMs: number; state: 'steady' | 'ramping' | 'backing-off' };
  lag: LagState;
  byRole: Record<string, RoleStats>;
}

const RAMP_INTERVAL_MS = 15_000;
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const MAX_429_RETRIES = 3;
const MAX_OTHER_RETRIES = 1;
/** An interactive call waits out a 429 cooldown for at most this long. */
const INTERACTIVE_MAX_COOLDOWN_WAIT_MS = 3_000;

export class OpenRouterWorkerPool {
  private bulkQueues = new Map<number, Queued[]>();
  private rrOrder: number[] = [];
  private rrIndex = 0;
  private bulkRunning = 0;
  /** Bulk slots in use (1-based). */
  private busySlots = new Set<number>();
  private interQueue: Queued[] = [];
  private interRunning = 0;

  private adaptive = Number.POSITIVE_INFINITY;
  private rateLimitHits = 0;
  private backoffUntil = 0;
  private backoffMs = BASE_BACKOFF_MS;
  private lastRateLimitAt = 0;
  private lastRampAt = 0;
  private wakeTimer: NodeJS.Timeout | null = null;

  private roles = new Map<string, RoleStats & { totalMs: number; totalWaitMs: number }>();
  readonly lag: LoopLagGuard;

  constructor(private settings: () => PoolSettings = getPoolSettings, lag?: LoopLagGuard) {
    this.lag = lag ?? new LoopLagGuard(() => this.settings().workerCount);
  }

  submit<T>(spec: JobSpec<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const q: Queued = {
        role: spec.role,
        projectKey: spec.projectId ?? currentOpenRouterProject() ?? 0,
        attempts: 0,
        run: spec.run as (ctx: JobContext) => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
        enqueuedAt: Date.now(),
      };
      this.role(spec.role).queued++;
      if (spec.lane === 'interactive') this.interQueue.push(q);
      else this.pushBulk(q, false);
      this.pump();
    });
  }

  /** Bulk limit right now. */
  bulkLimit(): number {
    const s = this.settings();
    return Math.max(1, Math.min(s.workerCount, this.adaptive, this.lag.limit()));
  }

  private pushBulk(q: Queued, front: boolean): void {
    let list = this.bulkQueues.get(q.projectKey);
    if (!list) {
      list = [];
      this.bulkQueues.set(q.projectKey, list);
      this.rrOrder.push(q.projectKey);
    }
    if (front) list.unshift(q); else list.push(q);
  }

  private nextBulk(): Queued | undefined {
    for (let i = 0; i < this.rrOrder.length; i++) {
      const idx = (this.rrIndex + i) % this.rrOrder.length;
      const key = this.rrOrder[idx];
      const list = this.bulkQueues.get(key);
      if (list && list.length > 0) {
        this.rrIndex = (idx + 1) % Math.max(1, this.rrOrder.length);
        const job = list.shift()!;
        if (list.length === 0) {
          this.bulkQueues.delete(key);
          this.rrOrder.splice(idx, 1);
          if (this.rrIndex > idx) this.rrIndex--;
          if (this.rrOrder.length) this.rrIndex %= this.rrOrder.length; else this.rrIndex = 0;
        }
        return job;
      }
    }
    return undefined;
  }

  private bulkQueued(): number {
    let n = 0;
    for (const l of this.bulkQueues.values()) n += l.length;
    return n;
  }

  private pump(): void {
    const now = Date.now();
    this.rampIfClean(now);
    const cooling = this.backoffUntil > now ? this.backoffUntil - now : 0;

    // Interactive lane: own slots; waits out a short cooldown only.
    const interLimit = this.settings().interactiveSlots;
    while (this.interRunning < interLimit && this.interQueue.length > 0) {
      if (cooling > 0 && now - this.interQueue[0].enqueuedAt < INTERACTIVE_MAX_COOLDOWN_WAIT_MS) break;
      this.start(this.interQueue.shift()!, 'interactive');
    }

    if (cooling === 0) {
      while (this.bulkRunning < this.bulkLimit()) {
        const job = this.nextBulk();
        if (!job) break;
        this.start(job, 'bulk');
      }
    }

    if ((cooling > 0 && (this.bulkQueued() > 0 || this.interQueue.length > 0)) && !this.wakeTimer) {
      const wait = Math.min(cooling, this.interQueue.length > 0 ? INTERACTIVE_MAX_COOLDOWN_WAIT_MS : cooling);
      this.wakeTimer = setTimeout(() => { this.wakeTimer = null; this.pump(); }, Math.max(10, wait));
      this.wakeTimer.unref?.();
    }
  }

  private start(job: Queued, lane: Lane): void {
    const rs = this.role(job.role);
    rs.queued = Math.max(0, rs.queued - 1);
    rs.running++;
    let worker: number | null = null;
    if (lane === 'bulk') {
      this.bulkRunning++;
      worker = 1;
      while (this.busySlots.has(worker)) worker++;
      this.busySlots.add(worker);
    } else this.interRunning++;
    const t0 = Date.now();
    if (job.attempts === 0) rs.totalWaitMs += t0 - job.enqueuedAt;
    job.attempts++;
    void (async () => {
      try {
        const out = await job.run({ worker });
        rs.done++;
        rs.totalMs += Date.now() - t0;
        job.resolve(out);
      } catch (err) {
        const limited = isRateLimited(err);
        if (limited) {
          rs.rateLimited++;
          this.noteRateLimited(err instanceof OpenRouterError ? err.retryAfterMs : undefined);
        }
        const maxRetries = limited ? MAX_429_RETRIES : MAX_OTHER_RETRIES;
        if (isRetryable(err) && job.attempts <= maxRetries) {
          rs.retried++;
          rs.queued++;
          if (lane === 'bulk') this.pushBulk(job, true); else this.interQueue.unshift(job);
        } else {
          rs.failed++;
          job.reject(err);
        }
      } finally {
        rs.running = Math.max(0, rs.running - 1);
        if (lane === 'bulk') {
          this.bulkRunning--;
          if (worker !== null) this.busySlots.delete(worker);
        } else this.interRunning--;
        this.pump();
      }
    })();
  }

  noteRateLimited(retryAfterMs?: number, now = Date.now()): void {
    this.rateLimitHits++;
    const current = Math.min(this.adaptive, this.settings().workerCount, Math.max(1, this.bulkRunning));
    this.adaptive = Math.max(1, Math.floor(current / 2));
    const base = retryAfterMs && retryAfterMs > 0 ? Math.min(MAX_BACKOFF_MS, retryAfterMs) : this.backoffMs;
    this.backoffUntil = now + base / 2 + Math.random() * base / 2;
    this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);
    this.lastRateLimitAt = now;
    this.lastRampAt = now;
  }

  private rampIfClean(now: number): void {
    if (!Number.isFinite(this.adaptive)) return;
    if (now - this.lastRateLimitAt < RAMP_INTERVAL_MS || now - this.lastRampAt < RAMP_INTERVAL_MS) return;
    this.lastRampAt = now;
    this.backoffMs = BASE_BACKOFF_MS;
    if (this.adaptive + 1 >= this.settings().workerCount) this.adaptive = Number.POSITIVE_INFINITY;
    else this.adaptive += 1;
  }

  private role(name: string) {
    let r = this.roles.get(name);
    if (!r) {
      r = { queued: 0, running: 0, done: 0, failed: 0, rateLimited: 0, retried: 0, meanMs: 0, meanWaitMs: 0, totalMs: 0, totalWaitMs: 0 };
      this.roles.set(name, r);
    }
    return r;
  }

  stats(now = Date.now()): PoolStats {
    const s = this.settings();
    const byRole: Record<string, RoleStats> = {};
    for (const [k, r] of this.roles) {
      const { totalMs, totalWaitMs, ...rest } = r;
      const finished = r.done + r.failed;
      byRole[k] = { ...rest, meanMs: r.done ? Math.round(totalMs / r.done) : 0, meanWaitMs: finished ? Math.round(totalWaitMs / finished) : 0 };
    }
    const cooling = Math.max(0, this.backoffUntil - now);
    return {
      settings: s,
      bulk: { running: this.bulkRunning, queued: this.bulkQueued(), limit: this.bulkLimit(), projects: this.rrOrder.length },
      interactive: { running: this.interRunning, queued: this.interQueue.length, limit: s.interactiveSlots },
      rateLimit: {
        adaptiveLimit: Number.isFinite(this.adaptive) ? this.adaptive : s.workerCount,
        hits: this.rateLimitHits,
        coolingDownMs: cooling,
        state: cooling > 0 ? 'backing-off' : Number.isFinite(this.adaptive) ? 'ramping' : 'steady',
      },
      lag: this.lag.stats(),
      byRole,
    };
  }
}

let pool: OpenRouterWorkerPool | null = null;

/** The process-wide pool. Starts the lag monitor on first use. */
export function openRouterPool(): OpenRouterWorkerPool {
  if (!pool) {
    pool = new OpenRouterWorkerPool();
    if (process.env.JEST_WORKER_ID === undefined) pool.lag.start();
  }
  return pool;
}

export function openRouterPoolStats(): PoolStats {
  return openRouterPool().stats();
}

export function __resetOpenRouterPoolForTest(p: OpenRouterWorkerPool | null = null): void {
  pool?.lag.stop();
  pool = p;
}
