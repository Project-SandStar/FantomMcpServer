/**
 * "OpenRouter only" end to end on the Fantom side: it round-trips through
 * save/push as `cloud-only` on the wire, it takes the GPUs out of the embed
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

const pushConfigToSidecar = jest.fn(() => true);
jest.unstable_mockModule('../sidecars/soundsuiteMaster.js', () => ({
  pushConfigToSidecar,
  isSoundSuiteSidecarConnected: jest.fn(() => true),
}));

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

// ── the cloud fleet ────────────────────────────────────────────────────────
const DIMS = 2560;
const OR_A = {
  sidecarId: 'sc-local-1', sidecarName: 'BASWS35', providerName: 'BASWS35-OR-CodeEmbedding',
  role: 'code-embedding' as const, model: 'qwen/qwen3-embedding-4b', upstreamProvider: 'DeepInfra',
  dims: DIMS, mode: 'cloud-only' as const, source: 'sidecar' as const,
};
const OR_B = { ...OR_A, sidecarId: 'sc-local-2', sidecarName: 'BASWS40', providerName: 'BASWS40-OR-CodeEmbedding' };
/** The docs half of the fleet — same model, the `embedding` role. */
const OR_DOCS_A = { ...OR_A, role: 'embedding' as const, providerName: 'BASWS35-OR-Embedding' };
const OR_DOCS_B = { ...OR_B, role: 'embedding' as const, providerName: 'BASWS40-OR-Embedding' };

let VIRTUAL_ROWS: any[] = [];
let OR_ENABLED = true;
jest.unstable_mockModule('../sidecars/virtualContainers.js', () => ({
  // Role-aware on purpose. While this ignored its argument, a caller asking
  // for the WRONG role still got rows back, so nothing could catch the docs
  // path looking up 'code-embedding' containers — which is exactly what it
  // did before the docs cloud path was wired.
  listVirtualContainers: jest.fn((role?: string) =>
    role ? VIRTUAL_ROWS.filter(r => r.role === role) : VIRTUAL_ROWS),
  listAllVirtualContainers: jest.fn(() => VIRTUAL_ROWS),
  getVirtualContainersConfig: jest.fn(() => ({ enabled: OR_ENABLED, embedMaxInFlight: 8 })),
  DEFAULT_OR_EMBED_MAX_IN_FLIGHT: 8,
  DEFAULT_OR_RERANK_MODEL: 'qwen/qwen3-reranker-8b',
  VIRTUAL_ROLES: ['embedding', 'code-embedding', 'reranker', 'code-assistant'],
}));

/** Deterministic unit-ish vector, stable per seed. */
function vec(seed: number, dims = DIMS): number[] {
  const out: number[] = [];
  let s = (seed * 2654435761) % 2147483647;
  for (let i = 0; i < dims; i++) { s = (s * 48271) % 2147483647; out.push(s / 2147483647 - 0.5); }
  return out;
}
/** Every cloud provider returns the SAME vectors — they agree with each other. */
let cloudDims = DIMS;
const virtualEmbed = jest.fn(async (_vc: any, texts: string[]) => ({
  source: 'openrouter', embeddings: texts.map((_, i) => vec(i + 1, cloudDims)), dims: cloudDims,
}));
jest.unstable_mockModule('../sidecars/virtualInferenceClient.js', () => ({
  virtualEmbed,
  virtualRerank: jest.fn(),
  VirtualInferenceUnavailable: class extends Error {},
}));

jest.unstable_mockModule('../embedding/providers/cloudBudget.js', () => ({
  withCloudPermit: jest.fn((fn: any) => fn()),
}));
jest.unstable_mockModule('../sidecars/openRouterActivity.js', () => ({
  noteCallStarted: jest.fn(), noteCallFinished: jest.fn(), isRoleCapped: jest.fn(() => false),
}));

const { pushOpenRouterConfig, getOpenRouterSettings } = await import('../sidecars/openRouterConfig.js');
const {
  selectAllEmbeddingProvidersWithCloud, selectQueryEmbeddingProvider,
  embeddingRoutingPolicy, CloudOnlyUnavailableError,
} = await import('../embedding/providers/embeddingProvider.js');
const { __resetVectorCompatibilityForTest } = await import('../embedding/providers/vectorCompatibility.js');
const { __resetVirtualEmbeddingGatesForTest } = await import('../embedding/providers/virtualEmbeddingProvider.js');

const nameOf = (p: any): string => p.getSidecarName?.() ?? 'in-process';

function setPolicy(policy: string): void {
  CONFIG = {
    semanticSearch: {
      codeDimensions: DIMS,
      openRouter: {
        allowedModels: { 'code-embedding': { model: 'qwen/qwen3-embedding-4b', provider: 'DeepInfra', dims: DIMS } },
        policyByRole: { 'code-embedding': policy, embedding: policy, reranker: 'backup', 'code-assistant': 'backup' },
      },
    },
  };
}

beforeEach(() => {
  CONFIG = {};
  LOCAL_SIDECARS = [LOCAL_SIDECAR];
  VIRTUAL_ROWS = [];
  OR_ENABLED = true;
  cloudDims = DIMS;
  virtualEmbed.mockClear();
  pushConfigToSidecar.mockClear();
  __resetVectorCompatibilityForTest();
  __resetVirtualEmbeddingGatesForTest();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// ────────────────────────────────────────────────────────────────────────────

describe('the policy round-trips through save/push', () => {
  it('stores "cloud" and puts cloud-only on the wire', () => {
    pushOpenRouterConfig({
      allowedModels: { 'code-embedding': { model: 'qwen/qwen3-embedding-4b', provider: 'DeepInfra', dims: DIMS } },
      policyByRole: { 'code-embedding': 'cloud' },
      modeByRole: {},
    } as any, 'sk-or-v1-test498a');

    const stored = getOpenRouterSettings();
    expect(stored.policyByRole!['code-embedding']).toBe('cloud');
    // modeByRole is DERIVED on every read and push, so the two cannot drift.
    expect(stored.modeByRole['code-embedding']).toBe('cloud-only');

    const payload = (pushConfigToSidecar.mock.calls[0] as any[])[1];
    expect(payload.openrouter.modeByRole['code-embedding']).toBe('cloud-only');
    // The operator vocabulary never reaches the sidecar.
    expect(JSON.stringify(payload)).not.toContain('"cloud"');
  });

  it('survives a reload, and the other roles keep their own policies', () => {
    setPolicy('cloud');
    CONFIG.semanticSearch.openRouter.policyByRole.reranker = 'backup';
    const s = getOpenRouterSettings();
    expect(s.policyByRole!['code-embedding']).toBe('cloud');
    expect(s.policyByRole!.reranker).toBe('backup');
    expect(s.modeByRole.reranker).toBe('cloud-only');
  });
});

describe('the fan-out under "OpenRouter only"', () => {
  it('contains NO local provider', async () => {
    setPolicy('cloud');
    VIRTUAL_ROWS = [OR_A, OR_B];

    const pool = await selectAllEmbeddingProvidersWithCloud('code', 'qwen3-embedding:4b');
    expect(pool.length).toBe(2);
    expect(pool.map(nameOf).sort()).toEqual([OR_A.providerName, OR_B.providerName]);
    // The local sidecar is registered, healthy, and serving the right model —
    // it is excluded by POLICY, not by being unavailable.
    expect(pool.map(nameOf)).not.toContain('BASWS35');
    expect((await embeddingRoutingPolicy('code')).localServes).toBe(false);
  });

  it('throws a NAMED reason rather than handing back the GPUs when no cloud provider is cleared', async () => {
    setPolicy('cloud');
    VIRTUAL_ROWS = [];
    await expect(selectAllEmbeddingProvidersWithCloud('code')).rejects.toThrow(CloudOnlyUnavailableError);
    await expect(selectAllEmbeddingProvidersWithCloud('code'))
      .rejects.toMatchObject({ reason: 'no-cloud-provider-discovered' });
  });

  it('names OpenRouter being switched off separately from nothing being discovered', async () => {
    setPolicy('cloud');
    OR_ENABLED = false;
    VIRTUAL_ROWS = [OR_A];
    await expect(selectAllEmbeddingProvidersWithCloud('code'))
      .rejects.toMatchObject({ reason: 'openrouter-disabled' });
  });

  it('excludes a cloud provider that fails the gate, and says the pool is unverified', async () => {
    setPolicy('cloud');
    VIRTUAL_ROWS = [OR_A];
    cloudDims = 1024; // wrong width for the 2560d table — mandatory under every regime
    await expect(selectAllEmbeddingProvidersWithCloud('code'))
      .rejects.toMatchObject({ reason: 'no-cloud-provider-verified' });
  });
});

describe('the other three policies are unchanged', () => {
  it('keeps the local providers in the pool under aggregate', async () => {
    setPolicy('aggregate');
    VIRTUAL_ROWS = [];
    const pool = await selectAllEmbeddingProvidersWithCloud('code', 'qwen3-embedding:4b');
    expect(pool.map(nameOf)).toContain('BASWS35');
  });

  it('keeps them under backup, and leaves cloud out of the fan-out', async () => {
    setPolicy('backup');
    VIRTUAL_ROWS = [OR_A, OR_B];
    const pool = await selectAllEmbeddingProvidersWithCloud('code', 'qwen3-embedding:4b');
    expect(pool.map(nameOf)).toEqual(['BASWS35']);
  });

  it('keeps them under local, with cloud excluded outright', async () => {
    setPolicy('local');
    VIRTUAL_ROWS = [OR_A, OR_B];
    const pool = await selectAllEmbeddingProvidersWithCloud('code', 'qwen3-embedding:4b');
    expect(pool.map(nameOf)).toEqual(['BASWS35']);
  });

  it('never throws CloudOnlyUnavailableError for them, however empty the cloud pool is', async () => {
    VIRTUAL_ROWS = [];
    OR_ENABLED = false;
    for (const p of ['aggregate', 'backup', 'local']) {
      setPolicy(p);
      await expect(selectAllEmbeddingProvidersWithCloud('code', 'qwen3-embedding:4b')).resolves.toBeDefined();
    }
  });
});

describe('the query encoder follows the corpus', () => {
  it('is a CLOUD provider under "OpenRouter only"', async () => {
    setPolicy('cloud');
    VIRTUAL_ROWS = [OR_B, OR_A];
    const enc = await selectQueryEmbeddingProvider('code');
    // Anchor first: the provider the others were measured against, so it is
    // the closest thing to "the one the corpus agrees with".
    expect(nameOf(enc)).toBe(OR_A.providerName);
    expect((enc as any).isVirtual).toBe(true);
  });

  it('actually embeds the query through the cloud route', async () => {
    setPolicy('cloud');
    VIRTUAL_ROWS = [OR_A];
    const enc = await selectQueryEmbeddingProvider('code');
    virtualEmbed.mockClear();
    const v = await enc.embed('load a trio file from sax');
    expect(v).toHaveLength(DIMS);
    expect(virtualEmbed).toHaveBeenCalledTimes(1);
    expect((virtualEmbed.mock.calls[0] as any[])[0].providerName).toBe(OR_A.providerName);
  });

  it('FAILS with a named reason rather than silently encoding locally', async () => {
    // The whole point. A local encoder here does not throw and does not look
    // wrong — it returns a 0.976-cosine query vector against a cloud-built
    // index and ranks the results subtly, permanently wrong.
    setPolicy('cloud');
    VIRTUAL_ROWS = [];
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

  it('fails when the cloud providers exist but none passed the gate', async () => {
    setPolicy('cloud');
    VIRTUAL_ROWS = [OR_A];
    cloudDims = 1024;
    await expect(selectQueryEmbeddingProvider('code'))
      .rejects.toMatchObject({ reason: 'no-cloud-provider-verified' });
  });

  it('refuses DOCS on cloud while the table width does not match the model', async () => {
    // The live shape: docs_vectors is 1024d (qwen3-embedding:0.6b) and every
    // hosted model is 1536d or wider. LanceDB locks the vector column at
    // creation, so no cloud provider can write into that table at all.
    //
    // This must be its OWN reason, not "nothing passed the gate". The two need
    // opposite actions — rebuild the table, versus investigate a provider —
    // and reporting a width mismatch as a verification failure sends the
    // operator looking for a fault in a provider that is working correctly.
    setPolicy('cloud');
    CONFIG.semanticSearch.docsDimensions = 1024;
    VIRTUAL_ROWS = [OR_A, OR_B, OR_DOCS_A, OR_DOCS_B];
    await expect(selectQueryEmbeddingProvider('docs'))
      .rejects.toMatchObject({ reason: 'cloud-width-mismatch' });
    // And it must NOT quietly hand back a local encoder, which is the whole
    // point of the policy's failure mode.
    expect((await embeddingRoutingPolicy('docs')).localServes).toBe(false);
  });

  it('serves DOCS from cloud once the docs table matches the model width', async () => {
    // The same policy on a table rebuilt at the model's width. This is what
    // the option exists to enable, so it has to be reachable — a policy that
    // can only ever throw is the inert setting under a different name.
    setPolicy('cloud');
    CONFIG.semanticSearch.docsDimensions = DIMS;
    VIRTUAL_ROWS = [OR_A, OR_B, OR_DOCS_A, OR_DOCS_B];
    const enc = await selectQueryEmbeddingProvider('docs');
    expect((enc as any).isVirtual).toBe(true);
    // The DOCS containers, not the code ones that share the fleet and the
    // model slug. The provider NAME is what distinguishes them — both roles
    // run `qwen/qwen3-embedding-4b` on the same hosts, so the model and the
    // sidecar prove nothing here and the suffix is the only witness that the
    // right role was looked up.
    expect(nameOf(enc)).toBe('BASWS35-OR-Embedding');
  });

  it('leaves DOCS local under the other three policies', async () => {
    CONFIG = {};
    for (const p of ['aggregate', 'backup', 'local']) {
      setPolicy(p);
      CONFIG.semanticSearch.docsDimensions = DIMS;
      VIRTUAL_ROWS = [OR_DOCS_A, OR_DOCS_B];
      const enc = await selectQueryEmbeddingProvider('docs');
      expect((enc as any).isVirtual).toBeUndefined();
    }
  });

  it('stays LOCAL under the other three policies — nothing about them changes', async () => {
    VIRTUAL_ROWS = [OR_A, OR_B];
    for (const p of ['aggregate', 'backup', 'local']) {
      setPolicy(p);
      const enc = await selectQueryEmbeddingProvider('code');
      expect(nameOf(enc)).toBe('BASWS35');
      expect((enc as any).isVirtual).toBeUndefined();
    }
  });
});
