/**
 * The wiring, not the selection: that `SemanticSearchService.search()` embeds
 * its query through `selectQueryEmbeddingProvider` and lets its failure out.
 *
 * This is a separate test from the selector's own because the bug it guards
 * is a WIRING bug. Before "OpenRouter only" the query went through
 * `selectEmbeddingProvider`, which never constructs a cloud provider — so a
 * search under that policy would have happily embedded the query on a local
 * Q4_K_M model against a full-precision cloud-built index, returned results,
 * and logged nothing. Both providers below work perfectly; the only way to
 * tell which one `search()` reached for is to break one of them.
 */

import { jest } from '@jest/globals';

/**
 * A stand-in for the production error, because the module that defines it is
 * the module being mocked. Assertions below are therefore STRUCTURAL — `code`
 * and `reason`, not `instanceof` — since comparing this class to itself would
 * pass even if the real one were deleted. Class identity is covered where it
 * can be meaningful, in openRouterOnlyPolicy.test.ts against the real export.
 */
class CloudOnlyUnavailableError extends Error {
  readonly code = 'cloud-only-unavailable';
  constructor(readonly target: string, readonly reason: string, message: string) {
    super(message);
    this.name = 'CloudOnlyUnavailableError';
  }
}

const localProvider = {
  initialize: jest.fn(async () => {}),
  embed: jest.fn(async () => new Float32Array(2560)),
  embedBatch: jest.fn(async (t: string[]) => t.map(() => new Float32Array(2560))),
  getModelName: () => 'qwen3-embedding:4b',
  getDimensions: () => 2560,
};

const cloudProvider = {
  isVirtual: true,
  initialize: jest.fn(async () => {}),
  embed: jest.fn(async () => new Float32Array(2560)),
  embedBatch: jest.fn(async (t: string[]) => t.map(() => new Float32Array(2560))),
  getModelName: () => 'qwen/qwen3-embedding-4b',
  getDimensions: () => 2560,
  getSidecarId: () => 'or:sc-1:code-embedding',
  getSidecarName: () => 'BASWS35-OR-CodeEmbedding',
};

let queryEncoderResult: () => Promise<any> = async () => localProvider;

jest.unstable_mockModule('../embedding/providers/embeddingProvider.js', () => ({
  // The OLD door. If `search()` still goes through here the test cannot fail,
  // which is exactly why it returns a perfectly working local provider.
  selectEmbeddingProvider: jest.fn(() => localProvider),
  selectEmbeddingProviderForProject: jest.fn(() => localProvider),
  selectAllEmbeddingProviders: jest.fn(() => []),
  selectAllEmbeddingProvidersWithCloud: jest.fn(async () => []),
  selectQueryEmbeddingProvider: jest.fn(() => queryEncoderResult()),
  embeddingRoutingPolicy: jest.fn(async () => ({
    role: 'code-embedding', policy: 'cloud', label: 'OpenRouter only',
    localServes: false, joinsFanOut: true,
  })),
  isSidecarUsable: jest.fn(() => true),
  embedBatchFanout: jest.fn(),
  embedPipelineSettings: jest.fn(() => ({ depth: 3, targetChunkMs: 3000 })),
  embedTimeoutMs: jest.fn(() => 120_000),
  capabilityKindsFor: jest.fn(() => ['embedding-code', 'embedding']),
  getProjectEmbeddingOverride: jest.fn(() => null),
  getProviderRates: jest.fn(() => ({})),
  policyRoleFor: jest.fn(() => 'code-embedding'),
  readRuntimeSemantic: jest.fn(() => ({ codeDimensions: 2560 })),
  HttpSidecarProvider: class {},
  CloudOnlyUnavailableError,
}));

const vectorSearch = jest.fn(async () => [] as any[]);
jest.unstable_mockModule('../embedding/vectorStore.js', () => ({
  VectorStore: class {},
  getVectorStore: jest.fn(() => ({
    search: vectorSearch,
    getEmbedding: jest.fn(async () => null),
    storeEmbeddings: jest.fn(),
    deleteProjectVectors: jest.fn(),
  })),
}));

jest.unstable_mockModule('../sidecars/registry.js', () => ({
  getSidecar: jest.fn(() => null),
  listSidecars: jest.fn(() => []),
  getSidecarForCapability: jest.fn(() => null),
  sidecarServiceUrl: jest.fn(() => ''),
  sidecarUrl: jest.fn(() => ''),
  updateSidecar: jest.fn(),
}));

const { SemanticSearchService } = await import('../embedding/semanticSearchService.js');

const svc = () => new SemanticSearchService({} as any);

beforeEach(() => {
  jest.clearAllMocks();
  queryEncoderResult = async () => cloudProvider;
  vectorSearch.mockResolvedValue([]);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('search() embeds the query through the policy-aware encoder', () => {
  it('uses the cloud encoder, not the local one', async () => {
    await svc().search('load a trio file from sax', { hybrid: false });
    expect(cloudProvider.embed).toHaveBeenCalledTimes(1);
    expect(localProvider.embed).not.toHaveBeenCalled();
  });

  it('FAILS the search when no cloud encoder can serve, instead of using local', async () => {
    // The failure mode this whole task exists to prevent: a working local
    // provider is right there, the search would succeed, and every result
    // would be ranked by a query vector 0.976 away from the corpus.
    queryEncoderResult = async () => {
      throw new CloudOnlyUnavailableError(
        'code', 'no-cloud-provider-verified',
        '[openrouter-only] no OpenRouter-backed provider has passed the vector-compatibility gate.',
      );
    };
    let thrown: any;
    try { await svc().search('load a trio file from sax', { hybrid: false }); } catch (e) { thrown = e; }

    expect(thrown?.code).toBe('cloud-only-unavailable');
    expect(thrown?.reason).toBe('no-cloud-provider-verified');
    expect(localProvider.embed).not.toHaveBeenCalled();
    // An empty result array would be the WORST outcome here: indistinguishable
    // from "nothing matched", and it is what returning [] on a swallowed error
    // would have produced.
    expect(vectorSearch).not.toHaveBeenCalled();
  });

  it('re-resolves rather than reusing an encoder cached before the policy changed', async () => {
    const s = svc();
    await s.search('one', { hybrid: false });
    queryEncoderResult = async () => {
      throw new CloudOnlyUnavailableError('code', 'openrouter-disabled', 'switched off');
    };
    // Inside the TTL the cached encoder is still correct and still used.
    await expect(s.search('two', { hybrid: false })).resolves.toBeDefined();
    // Past it, the policy is re-read and the refusal surfaces.
    (s as any)._queryEncoderAt = 0;
    await expect(s.search('three', { hybrid: false }))
      .rejects.toMatchObject({ code: 'cloud-only-unavailable', reason: 'openrouter-disabled' });
  });
});
