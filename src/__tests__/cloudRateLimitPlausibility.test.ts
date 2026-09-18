/**
 * Regression test for "the discovered rate limit reads 1/minute on a funded
 * account".
 *
 * Reproduced live, all five sidecars on 2.4.7:
 *
 *   credits { remaining: 99.96538966, totalCredits: 100, totalUsage: 0.03461034 }
 *   discoveredRequestsPerMinute: 1
 *   discoveredConcurrency: 1
 *   effectiveConcurrency: 1
 *
 * Credits were right; the rate figure was not. One request per minute is not a
 * limit anyone sells, and it did more than mis-display: `blockedFor()` arms a
 * sliding 60s window on the discovered RPM, so the whole cloud fan-out was held
 * to one request a minute — beside BASWS35's measured 12-14 texts/s, the cloud
 * provider contributed nothing and the aggregate policy was inert.
 *
 * Where the number comes from: Fantom converts `/api/v1/key`'s
 * `rate_limit {requests, interval}` to RPM. OpenRouter's current limits
 * documentation does not list `rate_limit` in the `Key` shape at all — it names
 * two rate limits (free-model request caps and DDoS protection) and points at
 * the `X-RateLimit-*` headers on a 429 for both, adding that the paid variant
 * of a model "has no platform-level request cap". So on a funded account the
 * field is a legacy signal at best.
 *
 * The rule this pins: a funded account never lets that field drag it below one
 * request per second; it sizes from the balance instead, says so, and the
 * manual override still beats everything.
 */

import {
  cloudBudgetStats, setDiscoveredCloudLimit, setManualCloudConcurrency,
  __resetCloudBudgetForTest,
  CONSERVATIVE_DEFAULT_CONCURRENCY, CREDITS_DERIVED_CONCURRENCY, MIN_PLAUSIBLE_RPM_FUNDED,
} from '../embedding/providers/cloudBudget.js';

/** The account as OpenRouter actually reported it. */
const FUNDED = { remaining: 99.96538966, totalCredits: 100, totalUsage: 0.03461034 };
const OK = { ok: true, at: '2026-09-15T17:22:48.362Z' };

beforeEach(() => { __resetCloudBudgetForTest(); });

describe('the reported incident', () => {
  it('no longer lets a 1/min signal make the cloud provider inert', () => {
    setDiscoveredCloudLimit(1, OK, FUNDED);
    const s = cloudBudgetStats();

    // What /key said is still reported verbatim — we show the operator the
    // signal, not only our verdict on it.
    expect(s.discoveredRequestsPerMinute).toBe(1);
    // ...but it is not believed, so nothing is gated on it.
    expect(s.rateLimitTrusted).toBe(false);
    expect(s.enforcedRequestsPerMinute).toBeNull();
    expect(s.discoveredConcurrency).toBeNull();

    // The ceiling comes from the balance instead of collapsing to 1.
    expect(s.source).toBe('credits');
    expect(s.creditsDerivedConcurrency).toBe(CREDITS_DERIVED_CONCURRENCY);
    expect(s.ceilingConcurrency).toBe(CREDITS_DERIVED_CONCURRENCY);
    expect(s.effectiveConcurrency).toBe(CREDITS_DERIVED_CONCURRENCY);
  });

  it('says in one sentence where the number came from', () => {
    setDiscoveredCloudLimit(1, OK, FUNDED);
    const detail = cloudBudgetStats().sourceDetail;
    expect(detail).toMatch(/account balance/i);
    expect(detail).toMatch(/\$99\.97/);
    // Names the signal it rejected, so the operator is not left guessing.
    expect(detail).toMatch(/1\/min/);
    expect(detail).toMatch(/not believed/i);
  });

  it('keeps the credits themselves untouched — they were never the problem', () => {
    setDiscoveredCloudLimit(1, OK, FUNDED);
    expect(cloudBudgetStats().credits).toEqual(FUNDED);
  });
});

describe('what counts as implausible', () => {
  it('rejects anything under one request per second on a funded account', () => {
    for (const rpm of [1, 6, 30, MIN_PLAUSIBLE_RPM_FUNDED - 1]) {
      __resetCloudBudgetForTest();
      setDiscoveredCloudLimit(rpm, OK, FUNDED);
      expect(cloudBudgetStats().rateLimitTrusted).toBe(false);
    }
  });

  it('accepts the threshold itself and anything above it', () => {
    for (const rpm of [MIN_PLAUSIBLE_RPM_FUNDED, 120, 600]) {
      __resetCloudBudgetForTest();
      setDiscoveredCloudLimit(rpm, OK, FUNDED);
      const s = cloudBudgetStats();
      expect(s.rateLimitTrusted).toBe(true);
      expect(s.enforcedRequestsPerMinute).toBe(rpm);
    }
  });

  it('does NOT second-guess a key with no credits — free-tier caps are real', () => {
    setDiscoveredCloudLimit(20, OK, { remaining: 0, totalCredits: 0, totalUsage: 0 });
    const s = cloudBudgetStats();
    expect(s.rateLimitTrusted).toBe(true);
    expect(s.enforcedRequestsPerMinute).toBe(20);
    expect(s.creditsDerivedConcurrency).toBeNull();
    expect(s.source).toBe('discovered');
  });
});

describe('a believable rate limit is still preferred when it is larger', () => {
  it('takes the rate-derived ceiling over the credits floor', () => {
    // 600 rpm = 10/s; at the 2s seed latency that is 20 concurrent, above the
    // credits-derived 16.
    setDiscoveredCloudLimit(600, OK, FUNDED);
    const s = cloudBudgetStats();
    expect(s.discoveredConcurrency).toBe(20);
    expect(s.ceilingConcurrency).toBe(20);
    expect(s.source).toBe('discovered');
    expect(s.sourceDetail).toMatch(/key's own rate limit/i);
  });

  it('never lets a believable but small one fall below the credits floor', () => {
    // 60 rpm = 1/s; at 2s latency Little's Law gives 2 concurrent — believable,
    // but a funded account should not be held under the balance-derived floor.
    setDiscoveredCloudLimit(60, OK, FUNDED);
    const s = cloudBudgetStats();
    expect(s.discoveredConcurrency).toBe(2);
    expect(s.ceilingConcurrency).toBe(CREDITS_DERIVED_CONCURRENCY);
    expect(s.source).toBe('credits');
  });
});

describe('the manual override still wins over all of it', () => {
  it('beats the credits-derived ceiling', () => {
    setDiscoveredCloudLimit(1, OK, FUNDED);
    setManualCloudConcurrency(64);
    const s = cloudBudgetStats();
    expect(s.source).toBe('manual');
    expect(s.ceilingConcurrency).toBe(64);
    expect(s.sourceDetail).toMatch(/set by hand/i);
  });

  it('beats it downwards too — an operator may throttle deliberately', () => {
    setDiscoveredCloudLimit(600, OK, FUNDED);
    setManualCloudConcurrency(2);
    expect(cloudBudgetStats().ceilingConcurrency).toBe(2);
  });

  it('hands control back to the credits-derived ceiling when cleared', () => {
    setDiscoveredCloudLimit(1, OK, FUNDED);
    setManualCloudConcurrency(64);
    setManualCloudConcurrency(null);
    const s = cloudBudgetStats();
    expect(s.source).toBe('credits');
    expect(s.ceilingConcurrency).toBe(CREDITS_DERIVED_CONCURRENCY);
  });
});

describe('when nothing is discoverable at all', () => {
  it('stays on the conservative default and says why', () => {
    setDiscoveredCloudLimit(null, {
      ok: false, unsupported: true, reason: 'Unknown action: virtual-key-info', at: null,
    });
    const s = cloudBudgetStats();
    expect(s.source).toBe('fallback');
    expect(s.ceilingConcurrency).toBe(CONSERVATIVE_DEFAULT_CONCURRENCY);
    expect(s.rateLimitTrusted).toBe(true); // nothing was rejected; nothing arrived
    expect(s.enforcedRequestsPerMinute).toBeNull();
    expect(s.sourceDetail).toMatch(/Unknown action: virtual-key-info/);
  });

  it('sizes from credits when the envelope carries a balance but no rate limit', () => {
    // The modern `/key` shape: OpenRouter's documented `Key` type has no
    // `rate_limit` field. Credits alone must still lift the budget off 4.
    setDiscoveredCloudLimit(null, OK, FUNDED);
    const s = cloudBudgetStats();
    expect(s.source).toBe('credits');
    expect(s.ceilingConcurrency).toBe(CREDITS_DERIVED_CONCURRENCY);
    expect(s.sourceDetail).toMatch(/reported no rate limit/i);
  });
});

describe('the raw envelope is kept as evidence', () => {
  it('carries rate_limit through to the stats payload untouched', () => {
    setDiscoveredCloudLimit(1, {
      ...OK,
      rawRateLimit: { requests: 1, interval: '1m' },
      envelopeKeys: ['is_free_tier', 'label', 'limit', 'rate_limit', 'total_credits', 'total_usage', 'usage'],
    }, FUNDED);
    const d = cloudBudgetStats().discovery;
    // {requests:1, interval:"1m"} is 1/min; {requests:1, interval:"10s"} would
    // be 6/min. Both round to a displayed 1 after Math.max(1, …), so the
    // envelope is the only way to tell them apart after the fact.
    expect(d.rawRateLimit).toEqual({ requests: 1, interval: '1m' });
    expect(d.envelopeKeys).toContain('rate_limit');
  });
});
