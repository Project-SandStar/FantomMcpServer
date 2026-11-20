/**
 * The OpenRouter worker pool: a bulk lane capped at `workerCount`, a separate
 * interactive lane so a search is never stuck behind an index build, AIMD on
 * 429, live settings, per-project round robin, and the event-loop lag guard.
 */
import { describe, it, expect } from '@jest/globals';
import { OpenRouterWorkerPool } from '../openrouter/workerPool.js';
import { LoopLagGuard } from '../openrouter/loopLag.js';
import { OpenRouterError } from '../openrouter/client.js';
import type { PoolSettings } from '../openrouter/settings.js';

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

/** A job the test releases by hand. */
function gate() {
  let release!: () => void;
  const p = new Promise<void>(r => { release = r; });
  return { p, release };
}

function makePool(over: Partial<PoolSettings> = {}) {
  const settings: PoolSettings = { workerCount: 3, interactiveSlots: 2, requestTimeoutMs: 120_000, ...over };
  const lag = new LoopLagGuard(() => settings.workerCount);
  const pool = new OpenRouterWorkerPool(() => settings, lag);
  return { pool, settings, lag };
}

describe('bulk lane', () => {
  it('never runs more than workerCount jobs at once', async () => {
    const { pool } = makePool({ workerCount: 3 });
    let running = 0;
    let peak = 0;
    const jobs = Array.from({ length: 20 }, (_, i) => pool.submit({
      role: 'code-embedding', lane: 'bulk', projectId: 1,
      run: async () => {
        running++;
        peak = Math.max(peak, running);
        await tick(2);
        running--;
        return i;
      },
    }));
    const out = await Promise.all(jobs);
    expect(out).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(peak).toBe(3);
    expect(pool.stats().byRole['code-embedding'].done).toBe(20);
  });

  it('applies a new workerCount to the next job', async () => {
    const { pool, settings } = makePool({ workerCount: 1 });
    const gates = Array.from({ length: 4 }, () => gate());
    let started = 0;
    const jobs = gates.map(g => pool.submit({ role: 'r', lane: 'bulk', projectId: 1, run: async () => { started++; await g.p; } }));
    await tick();
    expect(started).toBe(1);
    settings.workerCount = 3;
    gates[0].release();
    await tick();
    // One finished; the pump now fills up to the new limit of 3.
    expect(started).toBe(4);
    expect(pool.stats().bulk.running).toBe(3);
    gates.forEach(g => g.release());
    await Promise.all(jobs);
  });

  it('serves projects round robin, so one big project does not starve another', async () => {
    const { pool } = makePool({ workerCount: 1 });
    const order: string[] = [];
    const block = gate();
    // Hold the single slot so everything else queues first.
    const first = pool.submit({ role: 'r', lane: 'bulk', projectId: 1, run: async () => { await block.p; order.push('A0'); } });
    await tick();
    const jobs = [first];
    for (let i = 1; i <= 6; i++) jobs.push(pool.submit({ role: 'r', lane: 'bulk', projectId: 1, run: async () => { order.push(`A${i}`); } }));
    for (let i = 1; i <= 2; i++) jobs.push(pool.submit({ role: 'r', lane: 'bulk', projectId: 2, run: async () => { order.push(`B${i}`); } }));
    expect(pool.stats().bulk.projects).toBe(2);
    block.release();
    await Promise.all(jobs);
    // B's two jobs run within the first few slots, not after all six of A's.
    expect(order.indexOf('B1')).toBeLessThanOrEqual(2);
    expect(order.indexOf('B2')).toBeLessThanOrEqual(4);
    expect(order.filter(x => x.startsWith('A'))).toEqual(['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6']);
  });
});

describe('interactive lane', () => {
  it('starts an interactive job while every bulk slot is busy', async () => {
    const { pool } = makePool({ workerCount: 3, interactiveSlots: 2 });
    const g = gate();
    const bulk = Array.from({ length: 6 }, () => pool.submit({ role: 'code-embedding', lane: 'bulk', run: () => g.p }));
    await tick();
    expect(pool.stats().bulk.running).toBe(3);
    expect(pool.stats().bulk.queued).toBe(3);
    const answer = await pool.submit({ role: 'reranker', lane: 'interactive', run: async () => 'ranked' });
    expect(answer).toBe('ranked');
    expect(pool.stats().bulk.running).toBe(3);
    g.release();
    await Promise.all(bulk);
  });

  it('caps the interactive lane at interactiveSlots', async () => {
    const { pool } = makePool({ interactiveSlots: 2 });
    const g = gate();
    let started = 0;
    const jobs = Array.from({ length: 5 }, () => pool.submit({ role: 'r', lane: 'interactive', run: async () => { started++; await g.p; } }));
    await tick();
    expect(started).toBe(2);
    expect(pool.stats().interactive).toMatchObject({ running: 2, queued: 3, limit: 2 });
    g.release();
    await Promise.all(jobs);
    expect(started).toBe(5);
  });
});

describe('429 handling', () => {
  it('halves the limit and retries the job', async () => {
    const { pool } = makePool({ workerCount: 4 });
    const g = gate();
    const others = Array.from({ length: 3 }, () => pool.submit({ role: 'r', lane: 'bulk', run: () => g.p }));
    let attempts = 0;
    const limited = pool.submit({
      role: 'r', lane: 'bulk',
      run: async () => {
        attempts++;
        if (attempts === 1) throw new OpenRouterError('OpenRouter /embeddings HTTP 429', 429, { retryAfterMs: 20 });
        return 'second try';
      },
    });
    await tick();
    // Four were running when the 429 landed: the limit halves to 2.
    const s = pool.stats();
    expect(s.rateLimit.hits).toBe(1);
    expect(s.rateLimit.adaptiveLimit).toBe(2);
    expect(s.bulk.limit).toBe(2);
    g.release();
    await expect(limited).resolves.toBe('second try');
    expect(attempts).toBe(2);
    const rs = pool.stats().byRole.r;
    expect(rs.rateLimited).toBe(1);
    expect(rs.retried).toBe(1);
    expect(rs.failed).toBe(0);
    await Promise.all(others);
  });

  it('gives up on a non-retryable 4xx at once', async () => {
    const { pool } = makePool();
    let attempts = 0;
    const p = pool.submit({ role: 'r', lane: 'bulk', run: async () => { attempts++; throw new OpenRouterError('bad request', 400); } });
    await expect(p).rejects.toThrow('bad request');
    expect(attempts).toBe(1);
    expect(pool.stats().byRole.r.failed).toBe(1);
  });

  it('retries a 5xx once, then fails', async () => {
    const { pool } = makePool();
    let attempts = 0;
    const p = pool.submit({ role: 'r', lane: 'bulk', run: async () => { attempts++; throw new OpenRouterError('upstream 502', 502); } });
    await expect(p).rejects.toThrow('upstream 502');
    expect(attempts).toBe(2);
  });
});

describe('event-loop lag guard', () => {
  it('lowers lagLimit and the bulk limit when p95 lag is high', () => {
    const { pool, lag } = makePool({ workerCount: 3 });
    expect(pool.bulkLimit()).toBe(3);
    lag.observe(150, 150, 1_000);
    expect(lag.stats().lagLimit).toBe(2);
    expect(lag.stats().stepsDown).toBe(1);
    expect(pool.bulkLimit()).toBe(2);
    // Default floor is 2: lag the pool did not cause must not starve bulk work.
    lag.observe(150, 150, 2_000);
    expect(pool.bulkLimit()).toBe(2);
    expect(lag.stats().stepsDown).toBe(1);
  });

  it('steps down to the configured floor, never below one', () => {
    const settings: PoolSettings = { workerCount: 3, interactiveSlots: 2, requestTimeoutMs: 120_000 };
    const lag = new LoopLagGuard(() => settings.workerCount, { floor: 1 });
    const pool = new OpenRouterWorkerPool(() => settings, lag);
    lag.observe(150, 150, 1_000);
    lag.observe(150, 150, 2_000);
    expect(pool.bulkLimit()).toBe(1);
    lag.observe(150, 150, 3_000);
    expect(pool.bulkLimit()).toBe(1);
  });

  it('a floor above workerCount clamps to workerCount', () => {
    const lag = new LoopLagGuard(() => 1);
    lag.observe(500, 500, 1_000);
    expect(lag.limit()).toBe(1);
  });

  it('raises it again after rampMs of low lag, not before', () => {
    const settings: PoolSettings = { workerCount: 3, interactiveSlots: 2, requestTimeoutMs: 120_000 };
    const lag = new LoopLagGuard(() => settings.workerCount, { rampMs: 30_000 });
    const pool = new OpenRouterWorkerPool(() => settings, lag);
    lag.observe(150, 150, 1_000);
    expect(pool.bulkLimit()).toBe(2);
    lag.observe(10, 10, 1_000 + 29_999);
    expect(lag.limit()).toBe(2);
    lag.observe(10, 10, 1_000 + 30_000);
    expect(lag.limit()).toBe(3);
    expect(pool.bulkLimit()).toBe(3);
    // Never above workerCount.
    lag.observe(10, 10, 1_000 + 90_000);
    expect(lag.limit()).toBe(3);
  });

  it('holds steady between the low and high marks', () => {
    const { lag } = makePool({ workerCount: 3 });
    lag.observe(150, 150, 1_000);
    lag.observe(75, 75, 100_000);
    expect(lag.limit()).toBe(2);
  });
});
