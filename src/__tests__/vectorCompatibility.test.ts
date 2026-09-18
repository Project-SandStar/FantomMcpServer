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

const virtualEmbed = jest.fn<(...a: any[]) => Promise<any>>();
jest.unstable_mockModule('../sidecars/virtualInferenceClient.js', () => ({
  virtualEmbed,
  virtualRerank: jest.fn(),
  VirtualInferenceUnavailable: class extends Error {},
}));

const {
  verifyVectorCompatibility, cosine, PROBE_TEXTS, ensureVerified,
  __resetVectorCompatibilityForTest, isClearedToEmbed, verdictKey, getRefusal,
  recordRefusal, clearTransientRefusals, getProbeBackoff,
  localReference, cloudReference, selectCloudReference, getVerification,
} = await import('../embedding/providers/vectorCompatibility.js');

const DIMS = 2560;

const VC = {
  sidecarId: 'sc-1',
  sidecarName: 'BASWS35',
  providerName: 'BASWS35-OR-CodeEmbedding',
  role: 'code-embedding' as const,
  model: 'qwen/qwen3-embedding-4b',
  upstreamProvider: 'DeepInfra',
  dims: DIMS,
  mode: 'local-first' as const,
  source: 'sidecar' as const,
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
    const cloudKey = verdictKey({
      providerName: VC.providerName, model: VC.model, upstreamProvider: VC.upstreamProvider, reference: 'cloud-ref',
    });
    expect(isClearedToEmbed(cloudKey)).toBe(false);
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
// "OpenRouter only": the reference moves, the gate does not go away
// ────────────────────────────────────────────────────────────────────────────

const PEER = {
  ...VC,
  sidecarId: 'sc-2',
  sidecarName: 'BASWS40',
  providerName: 'BASWS40-OR-CodeEmbedding',
};

const cloudKeyFor = (vc: typeof VC) => verdictKey({
  providerName: vc.providerName, model: vc.model, upstreamProvider: vc.upstreamProvider, reference: 'cloud-ref',
});

describe('the cloud reference is picked by the anchor rule', () => {
  it("names the first same-model provider as everyone else's reference", () => {
    const rows = [PEER, VC]; // BASWS35 sorts before BASWS40
    expect(selectCloudReference(PEER, rows)!.providerName).toBe(VC.providerName);
  });

  it('gives the anchor itself no reference — it cannot be its own peer', () => {
    expect(selectCloudReference(VC, [PEER, VC])).toBeNull();
  });

  it('ignores a provider on a DIFFERENT model — they are meant to disagree', () => {
    const other = { ...PEER, model: 'openai/text-embedding-3-large' };
    expect(selectCloudReference(VC, [VC, other])).toBeNull();
    expect(selectCloudReference(other, [VC, other])).toBeNull();
  });

  it('returns null for a sole provider — nothing to hold it to', () => {
    expect(selectCloudReference(VC, [VC])).toBeNull();
  });

  // 2026-09-18: three of five hosts were down, the alphabetical anchor among
  // them, and every live provider was refused for "no WS tunnel" to a peer
  // that was not theirs. Liveness moves the anchor; it never empties the pool.
  it('anchors on a LIVE peer when the alphabetical first has no tunnel', () => {
    const live = (r: { sidecarId: string }) => r.sidecarId === PEER.sidecarId; // only BASWS40 is up
    // VC (BASWS35) is down: the live PEER becomes the anchor, so VC is measured against it …
    expect(selectCloudReference(VC, [PEER, VC], live)!.providerName).toBe(PEER.providerName);
    // … and the sole live provider is its own anchor: no peer, dims+pin check only, still verifiable.
    expect(selectCloudReference(PEER, [PEER, VC], live)).toBeNull();
  });

  it('falls back to the plain ordering when nothing is live, so the verdict is probe-failed, not absent', () => {
    const none = () => false;
    expect(selectCloudReference(PEER, [PEER, VC], none)!.providerName).toBe(VC.providerName);
    expect(selectCloudReference(VC, [PEER, VC], none)).toBeNull();
  });
});

describe('under "OpenRouter only" the gate stops asking about local', () => {
  it('REJECTS a cloud provider that disagrees with another cloud provider', async () => {
    // OpenRouter can route one model slug to different upstreams. Two
    // <PCName>-OR-* providers disagreeing with each other is the drift that
    // would poison a cloud-built index, and it is the only drift left to catch
    // once no local vector is ever written.
    const peerVectors = PROBE_TEXTS.map((_, i) => Array.from(vec(i + 1)));
    const candidateVectors = PROBE_TEXTS.map((_, i) => Array.from(vec(i + 900)));
    virtualEmbed.mockImplementation(async (vc: any) => ({
      source: 'openrouter',
      embeddings: vc.providerName === VC.providerName ? peerVectors : candidateVectors,
      dims: DIMS,
    }));

    const report = await verifyVectorCompatibility(PEER, cloudReference(VC), DIMS);
    expect(report.ok).toBe(false);
    expect(report.reference).toBe('cloud-ref');
    expect(isClearedToEmbed(cloudKeyFor(PEER))).toBe(false);
    const refusal = getRefusal(cloudKeyFor(PEER))!;
    expect(refusal.kind).toBe('vector-incompatible');
    // The refusal must name the CLOUD peer, not a local host — an operator
    // reading "the local reference" here would go and check the wrong machine.
    expect(refusal.reason).toContain(VC.providerName);
    expect(refusal.reason).not.toMatch(/local reference/i);
    expect(refusal.referenceName).toBe(VC.providerName);
  });

  it('CLEARS two cloud providers that agree with each other, with no local host involved', async () => {
    const local = localProvider();
    const spy = jest.spyOn(local, 'embedBatch');
    virtualEmbed.mockResolvedValue({
      source: 'openrouter',
      embeddings: PROBE_TEXTS.map((_, i) => nudge(vec(i + 1), 1e-6)),
      dims: DIMS,
    });
    const report = await verifyVectorCompatibility(PEER, cloudReference(VC), DIMS);
    expect(report.ok).toBe(true);
    expect(report.reference).toBe('cloud-ref');
    expect(isClearedToEmbed(cloudKeyFor(PEER))).toBe(true);
    // Nothing local was consulted. Agreement with a Q4_K_M local model is not
    // a property of a table that holds no local rows — and the measured
    // local/cloud cosine of 0.976 would have refused this outright.
    expect(spy).not.toHaveBeenCalled();
  });

  it('admits a cloud provider that would have FAILED against a local host', async () => {
    // The whole point. The same vectors are refused under `local-ref` and
    // cleared under `cloud-ref`: the local model is not the standard a
    // cloud-built index is held to, and requiring it would block the exact
    // configuration this policy exists to enable.
    virtualEmbed.mockResolvedValue({
      source: 'openrouter',
      embeddings: PROBE_TEXTS.map((_, i) => Array.from(vec(i + 500))),
      dims: DIMS,
    });
    const asLocal = await verifyVectorCompatibility(VC, localReference(localProvider()), DIMS);
    expect(asLocal.ok).toBe(false);

    __resetVectorCompatibilityForTest();
    const asCloud = await verifyVectorCompatibility(PEER, cloudReference(VC), DIMS);
    expect(asCloud.ok).toBe(true);
  });

  it('still refuses on dimension — the table is one width whoever wrote it', async () => {
    virtualEmbed.mockResolvedValue({
      source: 'openrouter',
      embeddings: PROBE_TEXTS.map((_, i) => Array.from(vec(i + 1, 1024))),
      dims: 1024,
    });
    const report = await verifyVectorCompatibility(PEER, cloudReference(VC), DIMS);
    expect(report.ok).toBe(false);
    expect(getRefusal(cloudKeyFor(PEER))!.kind).toBe('dimension-mismatch');
  });

  it('still requires a pinned upstream — more so, with no peer to catch a split', async () => {
    const unpinned = { ...PEER, upstreamProvider: undefined };
    const report = await verifyVectorCompatibility(unpinned, cloudReference(VC), DIMS);
    expect(report.ok).toBe(false);
    expect(virtualEmbed).not.toHaveBeenCalled();
    const k = verdictKey({ providerName: unpinned.providerName, model: unpinned.model, reference: 'cloud-ref' });
    expect(getRefusal(k)!.kind).toBe('no-provider-pin');
  });

  it('checks a SOLE cloud provider on dimension and pin, and records that nothing was compared', async () => {
    virtualEmbed.mockResolvedValue({
      source: 'openrouter',
      embeddings: PROBE_TEXTS.map((_, i) => Array.from(vec(i + 1))),
      dims: DIMS,
    });
    const ok = await ensureVerified(VC, null, DIMS, 'cloud-ref');
    expect(ok).toBe(true);
    const v = getVerification(cloudKeyFor(VC))!;
    expect(v.reference).toBe('cloud-ref');
    // No cosine is reported, because none was measured. Claiming 1.0 here
    // would assert an agreement that never happened.
    expect(v.minCosine).toBeUndefined();
    expect(v.referenceName).toBeUndefined();
  });

  it('REFUSES a null reference under the local regime — that would clear it against nothing', async () => {
    // Under the policies where the GPUs serve, local and cloud rows share one
    // table. Clearing a provider without comparing it to anything is precisely
    // what the gate exists to stop, so it must not be reachable by passing the
    // wrong argument.
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
  const refuse = () => recordRefusal({ key, providerName: 'flaky-OR-CodeEmbedding', kind: 'probe-failed', reason: 'no WS tunnel' } as any);

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
});
