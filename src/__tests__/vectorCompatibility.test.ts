/**
 * The compatibility gate: a provider whose vectors are not interchangeable
 * with the local ones must never serve a single text.
 *
 * This matters more under the current fan-out policy, not less. Local and
 * cloud providers work the SAME run concurrently, so their vectors land in
 * the same 2560d table interleaved. An undetected mismatch is not a degraded
 * provider — it is a poisoned table with no way to tell which rows came from
 * where. So the gate fails closed: unverified is refused exactly like
 * known-bad.
 */

import { jest } from '@jest/globals';

const {
  verifyVectorCompatibility, cosine, PROBE_TEXTS, ensureVerified,
  __resetVectorCompatibilityForTest, isClearedToEmbed, verdictKey, getRefusal,
  recordRefusal, clearTransientRefusals, getProbeBackoff, noteSidecarRegistered, isNoTunnelFailure,
  localReference, storedReference, getVerification,
} = await import('../embedding/providers/vectorCompatibility.js');
type CompatCandidate = import('../embedding/providers/vectorCompatibility.js').CompatCandidate;

const DIMS = 2560;

/**
 * The OpenRouter side of every check. Stubbed per test with the reply shape
 * `{ embeddings, dims }`; receives the candidate and the probe texts.
 */
const virtualEmbed = jest.fn<(...a: any[]) => Promise<any>>();

/** A candidate as the gate sees it: names plus `embedProbe(texts)`. */
type Cand = CompatCandidate;
const VC: Cand = {
  providerName: 'Fantom-OR-CodeEmbedding',
  model: 'qwen/qwen3-embedding-4b',
  upstreamProvider: 'DeepInfra',
  async embedProbe(this: Cand, texts: string[]) {
    const r = await virtualEmbed(this, texts);
    const vectors = (r.embeddings as ArrayLike<number>[]).map(e => Float32Array.from(e));
    return { vectors, dims: r.dims ?? vectors[0]?.length ?? 0 };
  },
};

const KEY = verdictKey({ providerName: VC.providerName, model: VC.model, upstreamProvider: VC.upstreamProvider, reference: 'local-ref' });

/** Deterministic pseudo-random unit-ish vector, stable per seed. */
function vec(seed: number, dims = DIMS): Float32Array {
  const out = new Float32Array(dims);
  let s = seed * 2654435761 % 2147483647;
  for (let i = 0; i < dims; i++) {
    s = (s * 48271) % 2147483647;
    out[i] = (s / 2147483647) - 0.5;
  }
  return out;
}

/** Same vector nudged by `eps` — models two stacks that agree closely. */
function nudge(v: Float32Array, eps: number): number[] {
  return Array.from(v, (x, i) => x + (i % 2 === 0 ? eps : -eps));
}

function localProvider(dims = DIMS) {
  return {
    embed: async () => vec(1, dims),
    embedBatch: async (texts: string[]) => texts.map((_, i) => vec(i + 1, dims)),
    getModelName: () => 'qwen3-embedding:4b',
    getDimensions: () => dims,
    initialize: async () => {},
  };
}

beforeEach(() => {
  virtualEmbed.mockReset();
  __resetVectorCompatibilityForTest();
});

describe('cosine', () => {
  it('is 1 for identical vectors and 0 for orthogonal ones', () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 12);
    expect(cosine([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 12);
  });
  it('is 0, not NaN, for a zero vector', () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe('the gate passes a genuinely compatible provider', () => {
  it('clears it and records the cosine numbers', async () => {
    virtualEmbed.mockResolvedValue({
      source: 'openrouter',
      embeddings: PROBE_TEXTS.map((_, i) => nudge(vec(i + 1), 1e-6)),
      dims: DIMS,
    });
    const report = await verifyVectorCompatibility(VC, localReference(localProvider()), DIMS);
    expect(report.ok).toBe(true);
    expect(report.minCosine!).toBeGreaterThanOrEqual(0.99);
    expect(report.dims).toBe(DIMS);
    expect(report.samples).toBe(PROBE_TEXTS.length);
    expect(report.cosines).toHaveLength(PROBE_TEXTS.length);
    expect(isClearedToEmbed(KEY)).toBe(true);
  });
});

describe('the gate REFUSES a mismatched provider', () => {
  it('refuses when pairwise cosine falls below 0.99', async () => {
    // Different seeds → unrelated vectors → cosine near 0.
    virtualEmbed.mockResolvedValue({
      source: 'openrouter',
      embeddings: PROBE_TEXTS.map((_, i) => Array.from(vec(i + 500))),
      dims: DIMS,
    });
    const report = await verifyVectorCompatibility(VC, localReference(localProvider()), DIMS);
    expect(report.ok).toBe(false);
    expect(report.minCosine!).toBeLessThan(0.99);
    expect(isClearedToEmbed(KEY)).toBe(false);
    const fault = getRefusal(KEY)!;
    expect(fault.kind).toBe('vector-incompatible');
    expect(fault.reason).toMatch(/cosine/i);
  });

  it('refuses on a dimension mismatch even when the vectors correlate', async () => {
    virtualEmbed.mockResolvedValue({
      source: 'openrouter',
      embeddings: PROBE_TEXTS.map((_, i) => Array.from(vec(i + 1, 1024))),
      dims: 1024,
    });
    const report = await verifyVectorCompatibility(VC, localReference(localProvider()), DIMS);
    expect(report.ok).toBe(false);
    expect(getRefusal(KEY)!.kind).toBe('dimension-mismatch');
  });

  it('refuses a provider with no pinned upstream, without even probing', async () => {
    const unpinned = { ...VC, upstreamProvider: undefined };
    const report = await verifyVectorCompatibility(unpinned, localReference(localProvider()), DIMS);
    expect(report.ok).toBe(false);
    expect(virtualEmbed).not.toHaveBeenCalled();
    const k = verdictKey({ providerName: unpinned.providerName, model: unpinned.model, reference: 'local-ref' });
    expect(getRefusal(k)!.kind).toBe('no-provider-pin');
  });

  it('refuses when the probe itself fails', async () => {
    virtualEmbed.mockRejectedValue(new Error('sidecar routed to local'));
    const report = await verifyVectorCompatibility(VC, localReference(localProvider()), DIMS);
    expect(report.ok).toBe(false);
    expect(getRefusal(KEY)!.kind).toBe('probe-failed');
  });

  it('refuses when the vector count does not match the probe count', async () => {
    virtualEmbed.mockResolvedValue({
      source: 'openrouter',
      embeddings: [Array.from(vec(1))],
      dims: DIMS,
    });
    const report = await verifyVectorCompatibility(VC, localReference(localProvider()), DIMS);
    expect(report.ok).toBe(false);
    expect(getRefusal(KEY)!.kind).toBe('probe-failed');
  });
});

describe('fail-closed and re-verification', () => {
  it('treats never-checked as not cleared', () => {
    expect(isClearedToEmbed('anything')).toBe(false);
  });

  it('invalidates the verdict when the model changes', async () => {
    virtualEmbed.mockResolvedValue({
      source: 'openrouter',
      embeddings: PROBE_TEXTS.map((_, i) => nudge(vec(i + 1), 1e-6)),
      dims: DIMS,
    });
    await verifyVectorCompatibility(VC, localReference(localProvider()), DIMS);
    expect(isClearedToEmbed(KEY)).toBe(true);
    const newModelKey = verdictKey({ providerName: VC.providerName, model: 'qwen/qwen3-embedding-8b', upstreamProvider: 'DeepInfra', reference: 'local-ref' });
    expect(isClearedToEmbed(newModelKey)).toBe(false);
  });

  it('invalidates the verdict when the pinned upstream changes', async () => {
    virtualEmbed.mockResolvedValue({
      source: 'openrouter',
      embeddings: PROBE_TEXTS.map((_, i) => nudge(vec(i + 1), 1e-6)),
      dims: DIMS,
    });
    await verifyVectorCompatibility(VC, localReference(localProvider()), DIMS);
    const rePinned = verdictKey({ providerName: VC.providerName, model: VC.model, upstreamProvider: 'Novita', reference: 'local-ref' });
    expect(isClearedToEmbed(rePinned)).toBe(false);
  });

  it('keeps the two regimes in separate ledger entries', async () => {
    // A verdict reached against a cloud peer does not say this provider agrees
    // with the LOCAL hosts. If the two shared a key, flipping the policy back
    // from "OpenRouter only" to "SideCar + OpenRouter" would find a green
    // verdict already there and admit an unverified-against-local provider
    // into a mixed fan-out — the poisoning this module exists to prevent,
    // reintroduced by a dropdown.
    virtualEmbed.mockResolvedValue({
      source: 'openrouter',
      embeddings: PROBE_TEXTS.map((_, i) => nudge(vec(i + 1), 1e-6)),
      dims: DIMS,
    });
    await verifyVectorCompatibility(VC, localReference(localProvider()), DIMS);
    expect(isClearedToEmbed(KEY)).toBe(true);
    const storedKey = verdictKey({
      providerName: VC.providerName, model: VC.model, upstreamProvider: VC.upstreamProvider, reference: 'stored-ref',
    });
    expect(isClearedToEmbed(storedKey)).toBe(false);
  });

  it('shares one in-flight probe between concurrent callers', async () => {
    virtualEmbed.mockResolvedValue({
      source: 'openrouter',
      embeddings: PROBE_TEXTS.map((_, i) => nudge(vec(i + 1), 1e-6)),
      dims: DIMS,
    });
    const local = localReference(localProvider());
    const [a, b, c] = await Promise.all([
      ensureVerified(VC, local, DIMS),
      ensureVerified(VC, local, DIMS),
      ensureVerified(VC, local, DIMS),
    ]);
    expect([a, b, c]).toEqual([true, true, true]);
    expect(virtualEmbed).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// stored-ref: Fantom's direct client is checked against rows ALREADY in the
// table. The candidate must reproduce them (cos >= 0.99) for the same texts.
// ────────────────────────────────────────────────────────────────────────────

const storedKeyFor = (vc: Cand) => verdictKey({
  providerName: vc.providerName, model: vc.model, upstreamProvider: vc.upstreamProvider, reference: 'stored-ref',
});

const ROW_TEXTS = ['class Foo { Void bar() {} }', 'readAll(site)', 'Str toStr()'];
const storedRows = (eps = 0) => ROW_TEXTS.map((text, i) => ({ text, vector: eps ? Float32Array.from(nudge(vec(i + 10), eps)) : vec(i + 10) }));

describe('stored-ref: the gate checks against vectors already in the table', () => {
  it('PASSES when the candidate reproduces the stored vectors (cos >= 0.99)', async () => {
    virtualEmbed.mockResolvedValue({ embeddings: ROW_TEXTS.map((_, i) => nudge(vec(i + 10), 1e-6)), dims: DIMS });
    const ref = storedReference(storedRows(), '3 stored rows');
    const report = await verifyVectorCompatibility(VC, ref, DIMS);
    expect(report.ok).toBe(true);
    expect(report.reference).toBe('stored-ref');
    expect(report.minCosine!).toBeGreaterThanOrEqual(0.99);
    expect(isClearedToEmbed(storedKeyFor(VC))).toBe(true);
    expect(getVerification(storedKeyFor(VC))!.referenceName).toBe('3 stored rows');
  });

  it('uses the stored rows\' own texts as the probe texts', async () => {
    virtualEmbed.mockResolvedValue({ embeddings: ROW_TEXTS.map((_, i) => Array.from(vec(i + 10))), dims: DIMS });
    const report = await verifyVectorCompatibility(VC, storedReference(storedRows()), DIMS);
    expect(virtualEmbed).toHaveBeenCalledTimes(1);
    expect(virtualEmbed.mock.calls[0][1]).toEqual(ROW_TEXTS);
    expect(virtualEmbed.mock.calls[0][1]).not.toEqual(PROBE_TEXTS);
    expect(report.samples).toBe(ROW_TEXTS.length);
  });

  it('REFUSES when the candidate no longer reproduces the stored rows', async () => {
    // Same texts, different vectors: the model behind the route changed.
    virtualEmbed.mockResolvedValue({ embeddings: ROW_TEXTS.map((_, i) => Array.from(vec(i + 500))), dims: DIMS });
    const report = await verifyVectorCompatibility(VC, storedReference(storedRows()), DIMS);
    expect(report.ok).toBe(false);
    expect(report.minCosine!).toBeLessThan(0.99);
    expect(isClearedToEmbed(storedKeyFor(VC))).toBe(false);
    const refusal = getRefusal(storedKeyFor(VC))!;
    expect(refusal.kind).toBe('vector-incompatible');
    expect(refusal.reason).toMatch(/stored in the table/);
  });

  it('REFUSES a near miss just under the floor', async () => {
    // Cosine ~0.976: the measured local-Q4 vs hosted-fp gap.
    virtualEmbed.mockResolvedValue({ embeddings: ROW_TEXTS.map((_, i) => nudge(vec(i + 10), 0.065)), dims: DIMS });
    const report = await verifyVectorCompatibility(VC, storedReference(storedRows()), DIMS);
    expect(report.minCosine!).toBeLessThan(0.99);
    expect(report.minCosine!).toBeGreaterThan(0.9);
    expect(report.ok).toBe(false);
  });

  it('REFUSES with no upstream pin, before any probe', async () => {
    const unpinned: Cand = { ...VC, upstreamProvider: undefined };
    const report = await verifyVectorCompatibility(unpinned, storedReference(storedRows()), DIMS);
    expect(report.ok).toBe(false);
    expect(virtualEmbed).not.toHaveBeenCalled();
    expect(getRefusal(storedKeyFor(unpinned))!.kind).toBe('no-provider-pin');
  });

  it('still refuses on dimension — the table is one width whoever wrote it', async () => {
    virtualEmbed.mockResolvedValue({ embeddings: ROW_TEXTS.map((_, i) => Array.from(vec(i + 10, 1024))), dims: 1024 });
    const report = await verifyVectorCompatibility(VC, storedReference(storedRows()), DIMS);
    expect(report.ok).toBe(false);
    expect(getRefusal(storedKeyFor(VC))!.kind).toBe('dimension-mismatch');
  });

  it('with no stored rows yet, checks dimension and pin only, and records that nothing was compared', async () => {
    virtualEmbed.mockResolvedValue({ embeddings: PROBE_TEXTS.map((_, i) => Array.from(vec(i + 1))), dims: DIMS });
    const ok = await ensureVerified(VC, null, DIMS, 'stored-ref');
    expect(ok).toBe(true);
    const v = getVerification(storedKeyFor(VC))!;
    expect(v.reference).toBe('stored-ref');
    // No cosine is reported, because none was measured.
    expect(v.minCosine).toBeUndefined();
    expect(v.referenceName).toBeUndefined();
  });

  it('keeps stored-ref and local-ref verdicts apart', async () => {
    virtualEmbed.mockResolvedValue({ embeddings: ROW_TEXTS.map((_, i) => nudge(vec(i + 10), 1e-6)), dims: DIMS });
    await verifyVectorCompatibility(VC, storedReference(storedRows()), DIMS);
    expect(isClearedToEmbed(storedKeyFor(VC))).toBe(true);
    expect(isClearedToEmbed(KEY)).toBe(false);
  });

  it('REFUSES a null reference under the local regime — that would clear it against nothing', async () => {
    const report = await verifyVectorCompatibility(VC, null, DIMS);
    expect(report.ok).toBe(false);
    expect(virtualEmbed).not.toHaveBeenCalled();
    expect(isClearedToEmbed(KEY)).toBe(false);
  });
});


// ────────────────────────────────────────────────────────────────────────────
// Probe backoff: a host that keeps failing its probe is not re-probed on every
// reconnect. BASWS34 re-registered 187 times in one afternoon; each clear
// re-queued a 15s probe timeout, and when that ran on the query path it added
// 15s to an ask.
// ────────────────────────────────────────────────────────────────────────────

describe('probe-failed refusals back off before they are cleared', () => {
  const key = 'probe-backoff-test';
  // A live host that times out: the flapping case the backoff exists for.
  const refuse = () => recordRefusal({ key, providerName: 'flaky-OR-CodeEmbedding', kind: 'probe-failed', reason: 'OpenRouter probe failed: sendCommandToSidecar: timeout after 15000ms (action=virtual-embed)' } as any);

  beforeEach(() => {
    __resetVectorCompatibilityForTest();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-18T20:00:00Z'));
  });
  afterEach(() => { jest.useRealTimers(); __resetVectorCompatibilityForTest(); });

  it('keeps a fresh probe-failed refusal for 30s, then lets a reconnect clear it', () => {
    refuse();
    expect(clearTransientRefusals()).toBe(0);
    expect(getRefusal(key)).toBeTruthy();
    expect(getProbeBackoff(key).failures).toBe(1);
    jest.setSystemTime(Date.now() + 31_000);
    expect(clearTransientRefusals()).toBe(1);
    expect(getRefusal(key)).toBeFalsy();
  });

  it('doubles the wait on each consecutive failure', () => {
    refuse();
    jest.setSystemTime(Date.now() + 31_000);
    expect(clearTransientRefusals()).toBe(1);
    refuse(); // second consecutive failure → 60s
    expect(getProbeBackoff(key).failures).toBe(2);
    jest.setSystemTime(Date.now() + 31_000);
    expect(clearTransientRefusals()).toBe(0);
    jest.setSystemTime(Date.now() + 30_000);
    expect(clearTransientRefusals()).toBe(1);
  });

  it('never touches a verdict about the vectors themselves', () => {
    recordRefusal({ key: 'real', providerName: 'x', kind: 'vector-incompatible', reason: 'cosine 0.97' } as any);
    jest.setSystemTime(Date.now() + 3_600_000);
    expect(clearTransientRefusals()).toBe(0);
    expect(getRefusal('real')).toBeTruthy();
  });

  it('a register does NOT reset the backoff of a live-host timeout', () => {
    noteSidecarRegistered();
    for (let i = 0; i < 5; i++) refuse();
    expect(noteSidecarRegistered()).toBe(0);
    expect(getProbeBackoff(key).failures).toBe(5);
    expect(clearTransientRefusals()).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// "No WS tunnel" after a boot: the sidecars are not connected yet. On
// 2026-11-03 every provider reached ×10 in 3 min and stayed refused for 15 min
// after the fleet came back, so code search failed until a manual verify.
// ────────────────────────────────────────────────────────────────────────────

describe('no-tunnel probe failures and sidecar registers', () => {
  const key = 'no-tunnel-test';
  const NO_TUNNEL = 'the cloud peer reference embedder X failed, so compatibility could not be established: '
    + 'virtual-embed: no WS tunnel to the sidecar (command returned null)';
  const refuse = () => recordRefusal({ key, providerName: 'BASWS35-OR-CodeEmbedding', kind: 'probe-failed', reason: NO_TUNNEL } as any);

  beforeEach(() => {
    __resetVectorCompatibilityForTest();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-03T12:38:00Z'));
  });
  afterEach(() => { jest.useRealTimers(); __resetVectorCompatibilityForTest(); });

  it('recognises the no-tunnel reason', () => {
    expect(isNoTunnelFailure(NO_TUNNEL)).toBe(true);
    expect(isNoTunnelFailure('sendCommandToSidecar: timeout after 15000ms')).toBe(false);
  });

  it('does not count no-tunnel failures before any sidecar has registered', () => {
    for (let i = 0; i < 10; i++) refuse();
    expect(getProbeBackoff(key).failures).toBe(0);
    expect(getRefusal(key)).toBeTruthy();
    // The first register clears it at once — no 887 s wait.
    noteSidecarRegistered();
    expect(clearTransientRefusals()).toBe(1);
    expect(getRefusal(key)).toBeFalsy();
  });

  it('a register resets a grown no-tunnel backoff so the reverify re-probes', () => {
    noteSidecarRegistered(); // fleet seen once
    jest.setSystemTime(Date.now() + 6 * 60_000);
    for (let i = 0; i < 10; i++) refuse(); // tunnel dropped later, backoff grows
    expect(getProbeBackoff(key).failures).toBe(10);
    expect(clearTransientRefusals()).toBe(0);
    expect(noteSidecarRegistered()).toBe(1);
    expect(clearTransientRefusals()).toBe(1);
  });

  it('a flapping host gets at most one no-tunnel reset per 5 minutes', () => {
    noteSidecarRegistered();
    jest.setSystemTime(Date.now() + 6 * 60_000);
    refuse(); refuse(); refuse();
    expect(noteSidecarRegistered()).toBe(1);
    expect(clearTransientRefusals()).toBe(1);
    refuse(); refuse(); refuse(); // fails again right after the reset
    jest.setSystemTime(Date.now() + 60_000);
    expect(noteSidecarRegistered()).toBe(0); // within 5 min: no second reset
    expect(clearTransientRefusals()).toBe(0);
    jest.setSystemTime(Date.now() + 5 * 60_000);
    expect(noteSidecarRegistered()).toBe(1);
  });
});
