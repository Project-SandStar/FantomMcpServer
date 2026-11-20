/**
 * "OpenRouter only" end to end on the Fantom side: it round-trips through
 * save as `cloud-only`, it takes the GPUs out of the embed
 * fan-out, and — the part that makes it more than a label — it moves the QUERY
 * encoder to the cloud pool and refuses to quietly fall back to a local one.
 *
 * The last point is the reason the policy needed code rather than a new option
 * in a dropdown. Local Ollama serves qwen3-embedding:4b as Q4_K_M and the
 * hosted providers run full precision; the measured pairwise cosine between
 * them is 0.976. A cloud-built corpus searched with a local query vector is
 * that mismatch on 100% of queries — and it does not throw, it returns
 * plausible results in the wrong order.
 */

import { jest } from '@jest/globals';

// ── config store, in memory ────────────────────────────────────────────────
let CONFIG: any = {};
jest.unstable_mockModule('../config/index.js', () => ({
  atomicWriteConfigFile: jest.fn((_p: string, cfg: any) => { CONFIG = cfg; }),
  readConfigFileWithRecovery: jest.fn(() => CONFIG),
  isDebugEnabled: jest.fn(() => false),
}));

// `readRuntimeSemantic` reads config/fantomMcpServer-config.json off disk with
// plain fs, so the in-memory store above has to be visible there too — the
// dimensions and the policy must come from the same place or the fan-out and
// the query encoder can disagree about which table they are serving.
jest.unstable_mockModule('fs', () => {
  const real = jest.requireActual('fs') as any;
  return {
    ...real,
    default: real,
    existsSync: (p: string) => (String(p).endsWith('fantomMcpServer-config.json') ? true : real.existsSync(p)),
    readFileSync: (p: string, enc?: any) =>
      (String(p).endsWith('fantomMcpServer-config.json') ? JSON.stringify(CONFIG) : real.readFileSync(p, enc)),
  };
});

// ── the local fleet ────────────────────────────────────────────────────────
const LOCAL_SIDECAR = {
  id: 'sc-local-1',
  name: 'BASWS35',
  host: '10.0.0.35',
  port: 3000,
  enabled: true,
  healthStatus: 'healthy',
  lastSeen: new Date().toISOString(),
  capabilities: {
    'embedding-code': { available: true, models: ['qwen3-embedding:4b'], loaded: 'qwen3-embedding:4b', endpoint: '/api/embed' },
    'embedding': { available: true, models: ['jina-embeddings-v2-base-en'], loaded: 'jina-embeddings-v2-base-en', endpoint: '/api/embed' },
  },
} as any;

let LOCAL_SIDECARS: any[] = [LOCAL_SIDECAR];
jest.unstable_mockModule('../sidecars/registry.js', () => ({
  listSidecars: jest.fn(() => LOCAL_SIDECARS),
  getSidecar: jest.fn((id: string) => LOCAL_SIDECARS.find(s => s.id === id) ?? null),
  // Honour the requested kind — the docs target resolves 'embedding' and the
  // code target 'embedding-code', and a mock that ignores the difference hands
  // back a sidecar with no matching capability entry.
  getSidecarForCapability: jest.fn((kind: string) =>
    LOCAL_SIDECARS.find(s => s.capabilities?.[kind]?.available) ?? null),
  sidecarServiceUrl: jest.fn(() => 'http://10.0.0.35:3000'),
  sidecarUrl: jest.fn(() => 'http://10.0.0.35:3000'),
  updateSidecar: jest.fn(),
}));

jest.unstable_mockModule('../embedding/providers/embedFaults.js', () => ({
  classifyEmbedError: jest.fn(() => null),
  markEmbedFault: jest.fn(),
  getEmbedFault: jest.fn(() => null),
}));

jest.unstable_mockModule('../embedding/embeddingService.js', () => ({
  getEmbeddingService: jest.fn(() => ({
    initialize: async () => {}, embed: async () => new Float32Array(2560),
    embedBatch: async (t: string[]) => t.map(() => new Float32Array(2560)),
    getModelName: () => 'bge-small-en-v1.5', getDimensions: () => 384,
  })),
  getDocsEmbeddingService: jest.fn(() => ({
    initialize: async () => {}, embed: async () => new Float32Array(768),
    embedBatch: async (t: string[]) => t.map(() => new Float32Array(768)),
    getModelName: () => 'jina-embeddings-v2-base-en', getDimensions: () => 768,
  })),
}));

// ── the cloud side: Fantom's own OpenRouter client ─────────────────────────
// No sidecar is involved any more: one DirectOpenRouterEmbeddingProvider per
// role, named Fantom-OR-<Role>, gated against rows already in the table.
const DIMS = 2560;
const CODE_NAME = 'Fantom-OR-CodeEmbedding';
const DOCS_NAME = 'Fantom-OR-Embedding';
const FAKE_KEY = 'sk-or-v1-FAKEKEY1234567890';

// The key store must not read this machine's real secrets file.
jest.unstable_mockModule('../config/secretsStore.js', () => ({
  SECRET_NAMES: ['FANTOM_OPENROUTER_API_KEY'],
  readStoredSecret: jest.fn(() => null),
  secretSource: jest.fn(() => (process.env.FANTOM_OPENROUTER_API_KEY ? 'env' : null)),
  storeSecret: jest.fn(),
  deleteStoredSecret: jest.fn(() => false),
  applyStoredSecretsToEnv: jest.fn(() => []),
  __resetSecretsStoreForTest: jest.fn(),
}));

/** Rows "already in the table" that the stored-ref gate compares against. */
let STORED_ROWS: Array<{ text: string; vector: Float32Array }> = [];
jest.unstable_mockModule('../openrouter/storedSample.js', () => ({
  sampleStoredRows: jest.fn(async () => STORED_ROWS),
  __clearStoredSampleCache: jest.fn(),
}));

/** Deterministic unit-ish vector, stable per seed. */
function vec(seed: number, dims = DIMS): number[] {
  const out: number[] = [];
  let s = (seed * 2654435761) % 2147483647;
  for (let i = 0; i < dims; i++) { s = (s * 48271) % 2147483647; out.push(s / 2147483647 - 0.5); }
  return out;
}
const seedOf = (t: string) => [...t].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 100_003, 7);

let cloudDims = DIMS;
const orCalls: Array<{ url: string; body: any }> = [];

const { __setOpenRouterFetchForTest } = await import('../openrouter/http.js');
const { __resetOpenRouterPoolForTest } = await import('../openrouter/workerPool.js');
const { getOpenRouterSettings } = await import('../sidecars/openRouterConfig.js');
const {
  selectAllEmbeddingProvidersWithCloud, selectQueryEmbeddingProvider,
  embeddingRoutingPolicy, CloudOnlyUnavailableError,
} = await import('../embedding/providers/embeddingProvider.js');
const { __resetVectorCompatibilityForTest } = await import('../embedding/providers/vectorCompatibility.js');

const nameOf = (p: any): string => p.getSidecarName?.() ?? 'in-process';

function setPolicy(policy: string): void {
  const m = { model: 'qwen/qwen3-embedding-4b', provider: 'DeepInfra', dims: DIMS };
  CONFIG = {
    semanticSearch: {
      codeDimensions: DIMS,
      openRouter: {
        allowedModels: { 'code-embedding': m, embedding: m },
        policyByRole: { 'code-embedding': policy, embedding: policy, reranker: 'backup', 'code-assistant': 'backup' },
      },
    },
  };
}

beforeEach(() => {
  CONFIG = {};
  LOCAL_SIDECARS = [LOCAL_SIDECAR];
  STORED_ROWS = [];
  cloudDims = DIMS;
  orCalls.length = 0;
  process.env.FANTOM_OPENROUTER_API_KEY = FAKE_KEY;
  __setOpenRouterFetchForTest(async (url, init) => {
    const body = JSON.parse(init.body ?? '{}');
    orCalls.push({ url, body });
    const data = (body.input as string[]).map((t, index) => ({ index, embedding: vec(seedOf(t), cloudDims) }));
    const text = JSON.stringify({ data, model: body.model, usage: { total_tokens: 10 } });
    return {
      ok: true, status: 200, headers: { get: () => null },
      text: async () => text,
      arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
    };
  });
  __resetOpenRouterPoolForTest();
  __resetVectorCompatibilityForTest();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  __setOpenRouterFetchForTest(null);
  delete process.env.FANTOM_OPENROUTER_API_KEY;
});

// ────────────────────────────────────────────────────────────────────────────

describe('the policy round-trips through save', () => {
  it('stores "cloud" and derives cloud-only for the role', async () => {
    const { saveOpenRouterSettings } = await import('../sidecars/openRouterConfig.js');
    saveOpenRouterSettings({
      allowedModels: { 'code-embedding': { model: 'qwen/qwen3-embedding-4b', provider: 'DeepInfra', dims: DIMS } },
      policyByRole: { 'code-embedding': 'cloud' },
      modeByRole: {},
    } as any);
    const stored = getOpenRouterSettings();
    expect(stored.policyByRole!['code-embedding']).toBe('cloud');
    // modeByRole is DERIVED on every read, so the two cannot drift.
    expect(stored.modeByRole['code-embedding']).toBe('cloud-only');
    // The key never lands in the config file.
    expect(JSON.stringify(CONFIG)).not.toContain('sk-or-');
  });

  it('survives a reload, and the other roles keep their own policies', () => {
    setPolicy('cloud');
    CONFIG.semanticSearch.openRouter.policyByRole.reranker = 'backup';
    const s = getOpenRouterSettings();
    expect(s.policyByRole!['code-embedding']).toBe('cloud');
    expect(s.policyByRole!.reranker).toBe('backup');
  });
});

describe('the fan-out under "OpenRouter only"', () => {
  it('contains NO local provider', async () => {
    setPolicy('cloud');
    const pool = await selectAllEmbeddingProvidersWithCloud('code', 'qwen3-embedding:4b');
    expect(pool.map(nameOf)).toEqual([CODE_NAME]);
    // The local sidecar is registered, healthy, and serving the right model —
    // it is excluded by POLICY, not by being unavailable.
    expect(pool.map(nameOf)).not.toContain('BASWS35');
    expect((await embeddingRoutingPolicy('code')).localServes).toBe(false);
  });

  it('throws a NAMED reason rather than handing back the GPUs when no model is set', async () => {
    setPolicy('cloud');
    CONFIG.semanticSearch.openRouter.allowedModels = {};
    await expect(selectAllEmbeddingProvidersWithCloud('code')).rejects.toThrow(CloudOnlyUnavailableError);
    await expect(selectAllEmbeddingProvidersWithCloud('code'))
      .rejects.toMatchObject({ reason: 'no-cloud-provider-discovered' });
  });

  it('names a missing key separately from a missing model', async () => {
    setPolicy('cloud');
    delete process.env.FANTOM_OPENROUTER_API_KEY;
    await expect(selectAllEmbeddingProvidersWithCloud('code'))
      .rejects.toMatchObject({ reason: 'openrouter-disabled' });
    expect(orCalls).toHaveLength(0);
  });

  it('refuses a provider that returns the wrong width, and says the pool is unverified', async () => {
    setPolicy('cloud');
    cloudDims = 1024; // wrong width for the 2560d table — mandatory under every regime
    await expect(selectAllEmbeddingProvidersWithCloud('code'))
      .rejects.toMatchObject({ reason: 'no-cloud-provider-verified' });
  });

  it('refuses a provider that does not reproduce the rows already stored', async () => {
    setPolicy('cloud');
    STORED_ROWS = [
      { text: 'alpha', vector: Float32Array.from(vec(999)) },
      { text: 'beta', vector: Float32Array.from(vec(998)) },
    ];
    await expect(selectAllEmbeddingProvidersWithCloud('code'))
      .rejects.toMatchObject({ reason: 'no-cloud-provider-verified' });
    // The probe used the stored rows' own texts.
    expect(orCalls[0].body.input).toEqual(['alpha', 'beta']);
  });

  it('clears a provider that reproduces the stored rows', async () => {
    setPolicy('cloud');
    STORED_ROWS = ['alpha', 'beta'].map(t => ({ text: t, vector: Float32Array.from(vec(seedOf(t))) }));
    const pool = await selectAllEmbeddingProvidersWithCloud('code');
    expect(pool.map(nameOf)).toEqual([CODE_NAME]);
  });

  it('pins the upstream on every embed call', async () => {
    setPolicy('cloud');
    const [p] = await selectAllEmbeddingProvidersWithCloud('code');
    await p.embedBatch(['x', 'y']);
    for (const c of orCalls) expect(c.body.provider).toEqual({ order: ['DeepInfra'], allow_fallbacks: false });
  });
});

describe('the other three policies are unchanged', () => {
  it('keeps the local providers in the pool under aggregate', async () => {
    setPolicy('aggregate');
    const pool = await selectAllEmbeddingProvidersWithCloud('code', 'qwen3-embedding:4b');
    expect(pool.map(nameOf)).toContain('BASWS35');
  });

  it('keeps them under backup, and leaves cloud out of the fan-out', async () => {
    setPolicy('backup');
    const pool = await selectAllEmbeddingProvidersWithCloud('code', 'qwen3-embedding:4b');
    expect(pool.map(nameOf)).toEqual(['BASWS35']);
  });

  it('keeps them under local, with cloud excluded outright', async () => {
    setPolicy('local');
    const pool = await selectAllEmbeddingProvidersWithCloud('code', 'qwen3-embedding:4b');
    expect(pool.map(nameOf)).toEqual(['BASWS35']);
  });

  it('never throws CloudOnlyUnavailableError for them, however empty the cloud side is', async () => {
    delete process.env.FANTOM_OPENROUTER_API_KEY;
    for (const p of ['aggregate', 'backup', 'local']) {
      setPolicy(p);
      await expect(selectAllEmbeddingProvidersWithCloud('code', 'qwen3-embedding:4b')).resolves.toBeDefined();
    }
  });
});

describe('the query encoder follows the corpus', () => {
  it('is a CLOUD provider under "OpenRouter only"', async () => {
    setPolicy('cloud');
    const enc = await selectQueryEmbeddingProvider('code');
    expect(nameOf(enc)).toBe(CODE_NAME);
    expect((enc as any).isVirtual).toBe(true);
  });

  it('actually embeds the query through the cloud route', async () => {
    setPolicy('cloud');
    const enc = await selectQueryEmbeddingProvider('code');
    orCalls.length = 0;
    const v = await enc.embed('load a trio file from sax');
    expect(v).toHaveLength(DIMS);
    expect(orCalls).toHaveLength(1);
    expect(orCalls[0].url).toBe('https://openrouter.ai/api/v1/embeddings');
    expect(orCalls[0].body.input).toEqual(['load a trio file from sax']);
  });

  it('FAILS with a named reason rather than silently encoding locally', async () => {
    // The whole point. A local encoder here does not throw and does not look
    // wrong — it returns a 0.976-cosine query vector against a cloud-built
    // index and ranks the results subtly, permanently wrong.
    setPolicy('cloud');
    CONFIG.semanticSearch.openRouter.allowedModels = {};
    let thrown: any;
    try { await selectQueryEmbeddingProvider('code'); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(CloudOnlyUnavailableError);
    expect(thrown.reason).toBe('no-cloud-provider-discovered');
    expect(thrown.code).toBe('cloud-only-unavailable');
    expect(thrown.message).toMatch(/OpenRouter only/);
    // The message has to say WHY refusing beats answering, or the next person
    // to read it will "fix" it by adding the fallback back.
    expect(thrown.message).toMatch(/0\.976/);
  });

  it('fails when the provider exists but did not pass the gate', async () => {
    setPolicy('cloud');
    cloudDims = 1024;
    await expect(selectQueryEmbeddingProvider('code'))
      .rejects.toMatchObject({ reason: 'no-cloud-provider-verified' });
  });

  it('refuses DOCS on cloud while the table width does not match the model', async () => {
    // docs_vectors at 1024d against a 2560d hosted model. This must be its OWN
    // reason, not "nothing passed the gate": the two need opposite actions —
    // rebuild the table, versus investigate a provider.
    setPolicy('cloud');
    CONFIG.semanticSearch.docsDimensions = 1024;
    await expect(selectQueryEmbeddingProvider('docs'))
      .rejects.toMatchObject({ reason: 'cloud-width-mismatch' });
    expect(orCalls).toHaveLength(0);
    // And it must NOT quietly hand back a local encoder.
    expect((await embeddingRoutingPolicy('docs')).localServes).toBe(false);
  });

  it('serves DOCS from cloud once the docs table matches the model width', async () => {
    setPolicy('cloud');
    CONFIG.semanticSearch.docsDimensions = DIMS;
    const enc = await selectQueryEmbeddingProvider('docs');
    expect((enc as any).isVirtual).toBe(true);
    // The DOCS role, not the code one that shares the model slug.
    expect(nameOf(enc)).toBe(DOCS_NAME);
  });

  it('leaves DOCS local under the other three policies', async () => {
    for (const p of ['aggregate', 'backup', 'local']) {
      setPolicy(p);
      CONFIG.semanticSearch.docsDimensions = DIMS;
      const enc = await selectQueryEmbeddingProvider('docs');
      expect((enc as any).isVirtual).toBeUndefined();
    }
  });

  it('stays LOCAL under the other three policies — nothing about them changes', async () => {
    for (const p of ['aggregate', 'backup', 'local']) {
      setPolicy(p);
      const enc = await selectQueryEmbeddingProvider('code');
      expect(nameOf(enc)).toBe('BASWS35');
      expect((enc as any).isVirtual).toBeUndefined();
    }
  });
});
