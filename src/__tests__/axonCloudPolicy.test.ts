/**
 * The Axon path must obey the code-embedding routing policy, like `code_vectors` does.
 *
 * Two wiring bugs are guarded here, both of which shipped together and both of
 * which were invisible until a forced re-index failed:
 *
 *  1. `axonIndexer` / `axonSearch` reached for `selectAllEmbeddingProviders`,
 *     the LOCAL-ONLY selector. Under "OpenRouter only" the GPUs are excluded by
 *     policy and — on this fleet — advertise no embedding capability at all, so
 *     that selector returns `[]` and the run died with "no embedding provider
 *     advertises model qwen3-embedding:4b … sidecar fleet offline?" while five
 *     verified cloud embedders sat idle and the whole code corpus was built on
 *     them.
 *
 *  2. `resolveAxonEmbeddingModel()` read `semanticSearch.codeModel` raw. Under
 *     cloud-only that is the local Ollama tag, not the model that actually
 *     writes the rows — so the dashboard labelled the table with one name while
 *     `code_vectors` held another, and `getAxonTableStats()` would raise
 *     `modelMismatch` against rows a forced re-index had just written: the page
 *     asks for a re-index, the re-index runs, the page asks again.
 */

import { jest } from '@jest/globals';

const CLOUD_MODEL = 'qwen/qwen3-embedding-4b';
const LOCAL_MODEL = 'qwen3-embedding:4b';

/** What the mocked config holds for the case under test. */
let policy: string = 'cloud';

/**
 * The two doors, for the wiring test below. Both WORK — a search that reached
 * for the old one would return results and log nothing, which is exactly how
 * this shipped unnoticed. The only way to tell which door was used is which
 * provider's `embed` recorded the call.
 */
const localProvider = {
  initialize: jest.fn(async () => {}),
  embed: jest.fn(async () => new Float32Array(2560)),
  embedBatch: jest.fn(async (t: string[]) => t.map(() => new Float32Array(2560))),
  getModelName: () => LOCAL_MODEL,
  getDimensions: () => 2560,
};

const cloudProvider = {
  isVirtual: true,
  initialize: jest.fn(async () => {}),
  embed: jest.fn(async () => new Float32Array(2560)),
  embedBatch: jest.fn(async (t: string[]) => t.map(() => new Float32Array(2560))),
  getModelName: () => CLOUD_MODEL,
  getDimensions: () => 2560,
  getSidecarId: () => 'or:sc-1:code-embedding',
  getSidecarName: () => 'BASWS35-OR-CodeEmbedding',
};

jest.unstable_mockModule('../embedding/providers/embeddingProvider.js', () => ({
  // The OLD door: local-only, and deliberately healthy.
  selectAllEmbeddingProviders: jest.fn(() => [localProvider]),
  selectAllEmbeddingProvidersWithCloud: jest.fn(async () => [cloudProvider]),
  selectEmbeddingProvider: jest.fn(() => localProvider),
  // The NEW door: policy-aware, hands back the cloud pool under cloud-only.
  selectQueryEmbeddingProvider: jest.fn(async () => cloudProvider),
  embedBatchFanout: jest.fn(async (t: string[]) => t.map(() => new Float32Array(2560))),
}));

/** A LanceDB table stub: non-empty, so the search reaches the encoder. */
const queryBuilder = {
  distanceType: () => queryBuilder,
  limit: () => queryBuilder,
  where: () => queryBuilder,
  toArray: async () => [],
};
jest.unstable_mockModule('../axon/axonLance.js', () => ({
  axonTableExists: jest.fn(async () => true),
  getAxonLanceTable: jest.fn(async () => ({
    countRows: async () => 5,
    vectorSearch: () => queryBuilder,
  })),
}));
jest.unstable_mockModule('../embedding/sidecarRerankerClient.js', () => ({
  callSidecarReranker: jest.fn(async () => []),
}));
jest.unstable_mockModule('../embedding/rlmToolLoop.js', () => ({
  runRlmGather: jest.fn(async () => ({})),
}));
jest.unstable_mockModule('../axon/axonIndexer.js', () => ({
  findAxonFunction: jest.fn(() => []),
}));

jest.unstable_mockModule('../sidecars/openRouterConfig.js', () => ({
  getOpenRouterSettings: jest.fn(() => ({
    allowedModels: { 'code-embedding': { model: CLOUD_MODEL, provider: 'DeepInfra', dims: 2560 } },
    policyByRole: { 'code-embedding': policy },
    modeByRole: {},
  })),
}));

// The real routing-policy semantics — deliberately NOT mocked. Re-implementing
// "does this policy mean cloud-only?" by comparing strings in the Axon layer is
// the duplication this test exists to prevent.
const { resolveAxonEmbeddingModel } = await import('../axon/axonSettings.js');
const { axonVectorSearch } = await import('../axon/axonSearch.js');

describe('resolveAxonEmbeddingModel — resolved through the code-embedding policy', () => {
  afterEach(() => { delete process.env.CODE_EMBEDDING_MODEL; });

  it('names the OpenRouter model under "OpenRouter only" — the pool that writes the rows', () => {
    policy = 'cloud';
    expect(resolveAxonEmbeddingModel().model).toBe(CLOUD_MODEL);
  });

  it('keeps the local tag under the three GPU-serving policies', () => {
    for (const p of ['aggregate', 'backup', 'local']) {
      policy = p;
      expect(resolveAxonEmbeddingModel().model).toBe(LOCAL_MODEL);
    }
  });

  it('still lets an explicit env override win over the policy', () => {
    policy = 'cloud';
    process.env.CODE_EMBEDDING_MODEL = 'pinned-model';
    expect(resolveAxonEmbeddingModel().model).toBe('pinned-model');
  });

  it('reports dims from codeDimensions — the width the provider gate verifies against', () => {
    policy = 'cloud';
    expect(resolveAxonEmbeddingModel().dimensions).toBe(2560);
  });
});

describe('axonVectorSearch — the query encoder comes from the pool that built the rows', () => {
  beforeEach(() => {
    policy = 'cloud';
    localProvider.embed.mockClear();
    cloudProvider.embed.mockClear();
  });

  it('embeds the query on the cloud pool, not the local-only selector', async () => {
    await axonVectorSearch('point rollup by ahu');
    // A local Q4_K_M query vector against a cloud-built axon_vectors is the
    // measured ~0.976 mismatch on EVERY search, with no error to blame it on.
    expect(localProvider.embed).not.toHaveBeenCalled();
    expect(cloudProvider.embed).toHaveBeenCalledTimes(1);
  });

  it('still honours an explicit provider override (the test hook)', async () => {
    const override = {
      initialize: jest.fn(async () => {}),
      embed: jest.fn(async () => new Float32Array(2560)),
      embedBatch: jest.fn(async (t: string[]) => t.map(() => new Float32Array(2560))),
      getModelName: () => 'override',
      getDimensions: () => 2560,
    };
    await axonVectorSearch('q', { provider: override as never });
    expect(override.embed).toHaveBeenCalledTimes(1);
    expect(cloudProvider.embed).not.toHaveBeenCalled();
  });
});
