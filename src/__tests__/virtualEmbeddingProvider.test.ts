/**
 * The gate at the point of use: an unverified cloud provider must not write a
 * single vector, and its identity must stay distinct from its host's.
 */

import { jest } from '@jest/globals';

const virtualEmbed = jest.fn<(...a: any[]) => Promise<any>>();
jest.unstable_mockModule('../sidecars/virtualInferenceClient.js', () => ({
  virtualEmbed,
  virtualRerank: jest.fn(),
  VirtualInferenceUnavailable: class extends Error {},
}));
jest.unstable_mockModule('../sidecars/virtualContainers.js', () => ({
  getVirtualContainersConfig: () => ({ enabled: true, embedMaxInFlight: 2 }),
  DEFAULT_OR_EMBED_MAX_IN_FLIGHT: 8,
}));

const { VirtualEmbeddingProvider, __resetVirtualEmbeddingGatesForTest } =
  await import('../embedding/providers/virtualEmbeddingProvider.js');
const { __resetVectorCompatibilityForTest, recordVerified, verdictKey } =
  await import('../embedding/providers/vectorCompatibility.js');

const VC = {
  sidecarId: 'sc-1',
  sidecarName: 'BASWS35',
  providerName: 'BASWS35-OR-CodeEmbedding',
  role: 'code-embedding' as const,
  model: 'qwen/qwen3-embedding-4b',
  upstreamProvider: 'DeepInfra',
  dims: 2560,
  mode: 'local-first' as const,
  source: 'sidecar' as const,
};

const KEY = verdictKey({ providerName: VC.providerName, model: VC.model, upstreamProvider: VC.upstreamProvider, reference: 'local-ref' });
const CLOUD_KEY = verdictKey({ providerName: VC.providerName, model: VC.model, upstreamProvider: VC.upstreamProvider, reference: 'cloud-ref' });
const vec = (d: number) => new Array(d).fill(0.1);

beforeEach(() => {
  virtualEmbed.mockReset();
  __resetVectorCompatibilityForTest();
  __resetVirtualEmbeddingGatesForTest();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

function clear() {
  recordVerified({ key: KEY, providerName: VC.providerName, minCosine: 0.999, meanCosine: 0.9995, dims: 2560, samples: 10, reference: 'local-ref' });
}

/** A verdict reached under "OpenRouter only" — against a cloud peer. */
function clearUnderCloudRegime() {
  recordVerified({ key: CLOUD_KEY, providerName: VC.providerName, minCosine: 0.999, meanCosine: 0.9995, dims: 2560, samples: 10, reference: 'cloud-ref' });
}

describe('fail-closed', () => {
  it('refuses to embed before verification, without calling out', async () => {
    const p = new VirtualEmbeddingProvider(VC, 2560);
    await expect(p.embedBatch(['a', 'b'])).rejects.toThrow(/not cleared to embed/);
    expect(virtualEmbed).not.toHaveBeenCalled();
  });

  it('serves once verified', async () => {
    clear();
    virtualEmbed.mockResolvedValue({ source: 'openrouter', embeddings: [vec(2560), vec(2560)], dims: 2560 });
    const out = await new VirtualEmbeddingProvider(VC, 2560).embedBatch(['a', 'b']);
    expect(out).toHaveLength(2);
    expect(out[0].length).toBe(2560);
  });

  it('still refuses a post-verification width drift', async () => {
    clear();
    virtualEmbed.mockResolvedValue({ source: 'openrouter', embeddings: [vec(1024)], dims: 1024 });
    await expect(new VirtualEmbeddingProvider(VC, 2560).embedBatch(['a']))
      .rejects.toThrow(/refusing to store/);
  });

  it('refuses a short vector count', async () => {
    clear();
    virtualEmbed.mockResolvedValue({ source: 'openrouter', embeddings: [vec(2560)], dims: 2560 });
    await expect(new VirtualEmbeddingProvider(VC, 2560).embedBatch(['a', 'b']))
      .rejects.toThrow(/returned 1 embeddings for 2 inputs/);
  });
});

describe('scheduler contract', () => {
  it('reports the OR provider name, so attribution shows the cloud share', () => {
    expect(new VirtualEmbeddingProvider(VC, 2560).getSidecarName()).toBe('BASWS35-OR-CodeEmbedding');
  });

  it('uses an id distinct from its host sidecar, so rate memos do not blend', () => {
    const id = new VirtualEmbeddingProvider(VC, 2560).getSidecarId();
    expect(id).not.toBe(VC.sidecarId);
    expect(id).toContain(VC.sidecarId);
    expect(id).toContain('code-embedding');
  });

  it('gives the embedding and reranker roles of one host different ids', () => {
    const a = new VirtualEmbeddingProvider(VC, 2560).getSidecarId();
    const b = new VirtualEmbeddingProvider({ ...VC, role: 'embedding' }, 2560).getSidecarId();
    expect(a).not.toBe(b);
  });
});

describe('in-flight cap', () => {
  it('never exceeds embedMaxInFlight, and shares the cap across provider objects', async () => {
    clear();
    let active = 0, peak = 0;
    virtualEmbed.mockImplementation(async () => {
      active++; peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 10));
      active--;
      return { source: 'openrouter', embeddings: [vec(2560)], dims: 2560 };
    });
    // Six requests over five DIFFERENT provider objects — the per-project
    // re-select makes a fresh one each time, and OpenRouter's rate limit is
    // per account, so the cap must not reset with the object.
    await Promise.all(Array.from({ length: 6 }, () =>
      new VirtualEmbeddingProvider(VC, 2560).embedBatch(['x'])));
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('the verification regime is carried, not guessed', () => {
  it('reads the ledger entry for the regime it was constructed with', async () => {
    clearUnderCloudRegime();
    virtualEmbed.mockResolvedValue({ source: 'openrouter', embeddings: [vec(2560)], dims: 2560 });
    await expect(new VirtualEmbeddingProvider(VC, 2560, 'cloud-ref').embedBatch(['a'])).resolves.toHaveLength(1);
  });

  it('will not spend a cloud-regime verdict on a mixed table', async () => {
    // A `cloud-ref` pass says this provider agrees with the other CLOUD
    // providers — under a sole provider, only that its width is right. Neither
    // is evidence that it agrees with a local host, so flipping the policy back
    // to "SideCar + OpenRouter" must not find a green verdict waiting.
    clearUnderCloudRegime();
    await expect(new VirtualEmbeddingProvider(VC, 2560).embedBatch(['a']))
      .rejects.toThrow(/not cleared to embed/);
    expect(virtualEmbed).not.toHaveBeenCalled();
  });

  it('will not spend a local-regime verdict under "OpenRouter only" either', async () => {
    clear();
    await expect(new VirtualEmbeddingProvider(VC, 2560, 'cloud-ref').embedBatch(['a']))
      .rejects.toThrow(/not cleared to embed/);
    expect(virtualEmbed).not.toHaveBeenCalled();
  });

  it('defaults to the stricter regime, so an un-migrated call site fails closed', async () => {
    clearUnderCloudRegime();
    await expect(new VirtualEmbeddingProvider(VC, 2560).embedBatch(['a']))
      .rejects.toThrow(/not cleared to embed/);
  });
});
