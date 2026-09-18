import {
  withCloudPermit,
  cloudBudgetStats,
  setManualCloudConcurrency,
  setDiscoveredCloudLimit,
  noteCloudRateLimited,
  runWithCloudBudgetProject,
  currentCloudBudgetProject,
  isValidConcurrency,
  isRateLimitError,
  retryAfterMsFrom,
  readManualConcurrencyFromConfig,
  __resetCloudBudgetForTest,
  CONSERVATIVE_DEFAULT_CONCURRENCY,
  MAX_ALLOWED_CONCURRENCY,
} from '../embedding/providers/cloudBudget.js';

const tick = () => new Promise(r => setTimeout(r, 0));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await tick(); };

beforeEach(() => { __resetCloudBudgetForTest(); });

describe('the permit pool is global, not per provider', () => {
  it('caps total in-flight across every caller, however many providers there are', async () => {
    setManualCloudConcurrency(2);
    let peak = 0;
    let live = 0;
    const release: Array<() => void> = [];

    // Ten "providers" all pulling at once — the exact 3-sidecars-x-8-in-flight
    // shape that a per-provider cap fails to protect against.
    const calls = Array.from({ length: 10 }, () => withCloudPermit(async () => {
      live++; peak = Math.max(peak, live);
      await new Promise<void>(r => release.push(r));
      live--;
    }));

    await settle();
    expect(peak).toBe(2);
    expect(cloudBudgetStats().inFlight).toBe(2);
    expect(cloudBudgetStats().queued).toBe(8);

    while (release.length) { release.shift()!(); await settle(); }
    await Promise.all(calls);
    expect(peak).toBe(2);
    expect(cloudBudgetStats().inFlight).toBe(0);
  });

  it('releases the permit when the call throws, so one failure cannot wedge the pool', async () => {
    setManualCloudConcurrency(1);
    await expect(withCloudPermit(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(cloudBudgetStats().inFlight).toBe(0);
    await expect(withCloudPermit(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('fairness across the section-2b projects', () => {
  it('round-robins between projects instead of draining one project\'s FIFO first', async () => {
    setManualCloudConcurrency(1);
    const order: string[] = [];
    const hold = withCloudPermit(() => new Promise<void>(r => setTimeout(r, 5)));

    // Project 1 queues three chunks before project 2 queues one. A plain FIFO
    // would serve 1,1,1,2; the pool must interleave.
    const big = [0, 1, 2].map(i =>
      runWithCloudBudgetProject(1, () => withCloudPermit(async () => { order.push(`p1#${i}`); })));
    const small = runWithCloudBudgetProject(2, () => withCloudPermit(async () => { order.push('p2#0'); }));

    await hold;
    await Promise.all([...big, small]);
    // The small project must not be last behind all three.
    expect(order.indexOf('p2#0')).toBeLessThan(order.length - 1);
  });
});

describe('adaptive response to 429', () => {
  it('halves the effective budget and never retries immediately', async () => {
    setManualCloudConcurrency(8);
    expect(cloudBudgetStats().effectiveConcurrency).toBe(8);

    noteCloudRateLimited();
    const after = cloudBudgetStats();
    expect(after.effectiveConcurrency).toBe(4);
    expect(after.rateLimitHits).toBe(1);
    expect(after.state).toBe('backing-off');
    expect(after.backoffUntil).not.toBeNull();

    noteCloudRateLimited();
    expect(cloudBudgetStats().effectiveConcurrency).toBe(2);
    expect(cloudBudgetStats().rateLimitHits).toBe(2);
  });

  it('never halves below one permit', () => {
    setManualCloudConcurrency(2);
    for (let i = 0; i < 10; i++) noteCloudRateLimited();
    expect(cloudBudgetStats().effectiveConcurrency).toBe(1);
  });

  it('recognises a rate-limit error by shape, not by exact wording', () => {
    expect(isRateLimitError(new Error('OpenRouter returned 429'))).toBe(true);
    expect(isRateLimitError(new Error('rate_limit exceeded'))).toBe(true);
    expect(isRateLimitError(new Error('Too Many Requests'))).toBe(true);
    expect(isRateLimitError(new Error('502 bad gateway'))).toBe(false);
    expect(isRateLimitError(new Error('connection reset'))).toBe(false);
  });

  it('honours a Retry-After hint when the upstream sends one', () => {
    expect(retryAfterMsFrom(new Error('429 retry-after: 30'))).toBe(30_000);
    expect(retryAfterMsFrom(new Error('429 retryAfter 500ms'))).toBe(500);
    expect(retryAfterMsFrom(new Error('429'))).toBeUndefined();
  });

  it('a 429 does not touch local providers — the pool holds no local state', async () => {
    // Nothing local ever calls withCloudPermit, so the only assertion that
    // matters is that a backoff blocks CLOUD acquisition and nothing else.
    setManualCloudConcurrency(4);
    noteCloudRateLimited();
    const s = cloudBudgetStats();
    expect(s.state).toBe('backing-off');
    expect(s.inFlight).toBe(0); // no permit was consumed by the backoff itself
  });
});

describe('discovered limit versus manual override', () => {
  it('falls back to the conservative default when discovery fails', () => {
    setDiscoveredCloudLimit(null, { ok: false, unsupported: true, reason: 'Unknown action', at: null });
    const s = cloudBudgetStats();
    expect(s.source).toBe('fallback');
    expect(s.ceilingConcurrency).toBe(CONSERVATIVE_DEFAULT_CONCURRENCY);
    expect(s.discoveredConcurrency).toBeNull();
    expect(s.discovery.unsupported).toBe(true);
  });

  it('derives a concurrency from the discovered RPM', () => {
    // 600 rpm = 10/s; at the 2s seed latency that is 20 concurrent.
    setDiscoveredCloudLimit(600, { ok: true, at: new Date().toISOString() });
    const s = cloudBudgetStats();
    expect(s.source).toBe('discovered');
    expect(s.discoveredRequestsPerMinute).toBe(600);
    expect(s.discoveredConcurrency).toBe(20);
    expect(s.ceilingConcurrency).toBe(20);
  });

  it('manual wins over discovery, and blank hands control back', () => {
    setDiscoveredCloudLimit(600, { ok: true, at: null });
    setManualCloudConcurrency(3);
    expect(cloudBudgetStats().source).toBe('manual');
    expect(cloudBudgetStats().ceilingConcurrency).toBe(3);

    setManualCloudConcurrency(null);
    expect(cloudBudgetStats().source).toBe('discovered');
    expect(cloudBudgetStats().ceilingConcurrency).toBe(20);
  });

  it('refuses an out-of-range override rather than saturating the account', () => {
    expect(() => setManualCloudConcurrency(0)).toThrow(/between 1 and/);
    expect(() => setManualCloudConcurrency(-5)).toThrow();
    expect(() => setManualCloudConcurrency(1.5)).toThrow();
    expect(() => setManualCloudConcurrency(MAX_ALLOWED_CONCURRENCY + 1)).toThrow();
    expect(isValidConcurrency(MAX_ALLOWED_CONCURRENCY)).toBe(true);
    expect(isValidConcurrency('8')).toBe(false);
  });

  it('reads the override from either config location, ignoring junk', () => {
    expect(readManualConcurrencyFromConfig({ openRouterMaxConcurrent: 12 })).toBe(12);
    expect(readManualConcurrencyFromConfig({ semanticSearch: { openRouterMaxConcurrent: 6 } })).toBe(6);
    expect(readManualConcurrencyFromConfig({ openRouterMaxConcurrent: '' })).toBeNull();
    expect(readManualConcurrencyFromConfig({ openRouterMaxConcurrent: 'lots' })).toBeNull();
    expect(readManualConcurrencyFromConfig({ openRouterMaxConcurrent: 99999 })).toBeNull();
    expect(readManualConcurrencyFromConfig({})).toBeNull();
  });
});

describe('live adjustment', () => {
  it('raising the ceiling mid-flight releases queued waiters without a restart', async () => {
    setManualCloudConcurrency(1);
    let live = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const calls = Array.from({ length: 4 }, () => withCloudPermit(async () => {
      live++; peak = Math.max(peak, live);
      await new Promise<void>(r => release.push(r));
      live--;
    }));

    await settle();
    expect(cloudBudgetStats().inFlight).toBe(1);
    expect(cloudBudgetStats().queued).toBe(3);

    setManualCloudConcurrency(4);
    await settle();
    // permits-in-use moves on the page immediately, which is the requirement.
    expect(cloudBudgetStats().inFlight).toBe(4);
    expect(peak).toBe(4);

    while (release.length) release.shift()!();
    await Promise.all(calls);
  });
});

describe('the project tag survives the scheduler\'s promise chains', () => {
  // Production is runProject -> embedTextsPipelined -> embedBatch ->
  // withCloudPermit, and embedTextsPipelined re-enters its pump() from a
  // .then() on a previous dispatch. If the AsyncLocalStorage context did not
  // propagate through that, every waiter would land in bucket 0 and
  // round-robin would silently degrade to FIFO with the fairness test still
  // green. This asserts the propagation the real path depends on.
  it('still reports the project after several awaits and a .then() hop', async () => {
    setManualCloudConcurrency(1);
    const seen: Array<number | undefined> = [];
    const hold = withCloudPermit(() => new Promise<void>(r => setTimeout(r, 5)));

    const deep = (pid: number) => runWithCloudBudgetProject(pid, async () => {
      await Promise.resolve();
      await new Promise(r => setTimeout(r, 0));
      // A .then() continuation, the way pump() re-enters itself.
      return Promise.resolve().then(() => withCloudPermit(async () => {
        seen.push(currentCloudBudgetProject());
      }));
    });

    const work = [deep(7), deep(9)];
    await hold;
    await Promise.all(work);
    expect(seen.sort()).toEqual([7, 9]);
  });
});
