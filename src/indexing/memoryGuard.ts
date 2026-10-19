/**
 * Memory guard for the lazy indexing queue (lazy-incremental-indexing.md 3.10).
 *
 * Hysteresis on two numbers from `process.memoryUsage()`:
 *   - pause when RSS > rssPauseMb OR heapUsed > heapPauseMb;
 *   - resume only when RSS < rssResumeMb AND heapUsed < heapResumeMb.
 * While paused the scheduler claims no task, and a task about to start
 * yields (`state = 'yielded'`, no attempt counted, `paused: 'memory'`). A
 * pause longer than alertAfterMs is logged once at warn.
 *
 * The 4 GB hard guard in src/index.ts still kills the process; this guard
 * keeps the queue well below it.
 */

import { createLogger } from '../utils/index.js';

const logger = createLogger('lazy-index');

export interface MemoryThresholds {
  rssPauseMb: number;
  heapPauseMb: number;
  rssResumeMb: number;
  heapResumeMb: number;
  alertAfterMs: number;
}

export interface MemorySample { rssMb: number; heapMb: number }

export interface MemoryState {
  paused: boolean;
  /** 'memory' while paused, the value the queue reports. */
  reason: 'memory' | null;
  since: number | null;
  sample: MemorySample;
}

export function sampleProcessMemory(): MemorySample {
  const m = process.memoryUsage();
  return { rssMb: Math.round(m.rss / 1048576), heapMb: Math.round(m.heapUsed / 1048576) };
}

export class MemoryGuard {
  private paused = false;
  private since: number | null = null;
  private alerted = false;
  private last: MemorySample = { rssMb: 0, heapMb: 0 };

  constructor(
    private thresholds: MemoryThresholds,
    private sampler: () => MemorySample = sampleProcessMemory,
    private now: () => number = Date.now,
  ) {}

  setThresholds(t: MemoryThresholds): void { this.thresholds = t; }

  /** Take a sample and update the pause state. Call every tick and before every claim. */
  check(): MemoryState {
    const s = this.sampler();
    this.last = s;
    const t = this.thresholds;
    if (!this.paused) {
      if (s.rssMb > t.rssPauseMb || s.heapMb > t.heapPauseMb) {
        this.paused = true;
        this.since = this.now();
        this.alerted = false;
        logger.info(`[lazy-index] memory guard: pause (rss=${s.rssMb}MB heap=${s.heapMb}MB, limits ${t.rssPauseMb}/${t.heapPauseMb}MB)`);
      }
    } else if (s.rssMb < t.rssResumeMb && s.heapMb < t.heapResumeMb) {
      logger.info(`[lazy-index] memory guard: resume after ${this.now() - (this.since ?? this.now())}ms (rss=${s.rssMb}MB heap=${s.heapMb}MB)`);
      this.paused = false;
      this.since = null;
    } else if (!this.alerted && this.since !== null && this.now() - this.since > t.alertAfterMs) {
      this.alerted = true;
      logger.warn(`[lazy-index] memory guard: queue paused for ${Math.round((this.now() - this.since) / 1000)}s (rss=${s.rssMb}MB heap=${s.heapMb}MB)`);
    }
    return this.state();
  }

  state(): MemoryState {
    return { paused: this.paused, reason: this.paused ? 'memory' : null, since: this.since, sample: this.last };
  }

  isPaused(): boolean { return this.paused; }
}

/** RSS/heap delta of one task, stored in index_tasks.result. */
export function memoryDelta(before: MemorySample, after: MemorySample): { rssDeltaMb: number; heapDeltaMb: number; rssMb: number } {
  return { rssDeltaMb: after.rssMb - before.rssMb, heapDeltaMb: after.heapMb - before.heapMb, rssMb: after.rssMb };
}
