/**
 * Local-first rerank with OpenRouter fallback.
 *
 * The policy under test, in one line: a healthy local cross-encoder always
 * wins; the cloud only covers the gap; and the choice is made fresh on every
 * request so gpu-01 coming back takes traffic on the next search without a
 * restart, a cache flush, or a config change.
 */

import { jest } from '@jest/globals';

// The router resolves the local reranker through main's
// `rerankerSidecarUsable`, so that is what the test drives — it carries the
// fleet's health and fault rules and its own 60 s probe cache.
const rerankerSidecarUsable = jest.fn<(...a: any[]) => any>();
const resetRerankerCache = jest.fn();
jest.unstable_mockModule('../embedding/hybridSearch.js', () => ({
  rerankerSidecarUsable,
  resetRerankerCache,
}));

const sidecarServiceUrl = jest.fn<(...a: any[]) => string>(() => 'http://gpu-01:8000');
jest.unstable_mockModule('../sidecars/registry.js', () => ({
  sidecarServiceUrl,
  listSidecars: jest.fn(() => []),
  getSidecar: jest.fn(),
  sidecarUrl: jest.fn(() => 'http://gpu-01:8098'),
}));

const listVirtualContainers = jest.fn<(...a: any[]) => any[]>(() => []);
jest.unstable_mockModule('../sidecars/virtualContainers.js', () => ({
  listVirtualContainers,
  listAllVirtualContainers: listVirtualContainers,
  getVirtualContainersConfig: () => ({ enabled: true, rerankModel: 'qwen/qwen3-reranker-8b', strictRerankModel: false }),
  DEFAULT_OR_RERANK_MODEL: 'qwen/qwen3-reranker-8b',
}));

const virtualRerank = jest.fn<(...a: any[]) => Promise<any>>();
jest.unstable_mockModule('../sidecars/virtualInferenceClient.js', () => ({
  virtualRerank,
  virtualEmbed: jest.fn(),
  VirtualInferenceUnavailable: class extends Error {},
}));

// The routing policy decides whether cloud may be reached at all. Default the
// reranker to 'backup' — local serves, cloud covers the gap — which is the
// policy every test below assumes unless it says otherwise. Mocked rather than
// read from disk so these tests do not depend on the machine's config file.
const getOpenRouterSettings = jest.fn<(...a: any[]) => any>(() => ({
  allowedModels: {}, modeByRole: {},
  policyByRole: { reranker: 'backup', embedding: 'aggregate', 'code-embedding': 'aggregate' },
}));
jest.unstable_mockModule('../sidecars/openRouterConfig.js', () => ({ getOpenRouterSettings }));

const { rerankLocalFirst, parseRerankScores, __resetRerankPolicyCacheForTest } =
  await import('../embedding/rerankRouter.js');

const LOCAL_SIDECAR = {
  id: 'sc-gpu01',
  name: 'gpu-01',
  healthStatus: 'healthy',
  capabilities: { reranker: { available: true, models: ['Qwen/Qwen3-Reranker-8B'], loaded: 'Qwen/Qwen3-Reranker-8B' } },
};

const OR_RERANKER = {
  sidecarId: 'sc-1',
  sidecarName: 'BASWS35',
  providerName: 'BASWS35-OR-Reranker',
  role: 'reranker' as const,
  model: 'qwen/qwen3-reranker-8b',
  mode: 'local-first' as const,
  source: 'sidecar' as const,
};

const DOCS = ['alpha', 'beta', 'gamma'];

function okFetch(json: unknown) {
  return jest.fn(async () => ({ ok: true, status: 200, json: async () => json, text: async () => '' })) as any;
}
function failFetch(status: number) {
  return jest.fn(async () => ({ ok: false, status, json: async () => ({}), text: async () => 'boom' })) as any;
}

beforeEach(() => {
  rerankerSidecarUsable.mockReset();
  resetRerankerCache.mockReset();
  listVirtualContainers.mockReset().mockReturnValue([]);
  virtualRerank.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('score parsing', () => {
  it('aligns Cohere-style results to the input order', () => {
    const s = parseRerankScores({ results: [{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] }, 3);
    expect(s).toEqual([0.1, 0, 0.9]);
  });
  it('reads vLLM /v1/score data arrays in order', () => {
    expect(parseRerankScores({ data: [{ score: 0.3 }, { score: 0.7 }, { score: 0.5 }] }, 3)).toEqual([0.3, 0.7, 0.5]);
  });
  it('returns null for an unrecognisable shape', () => {
    expect(parseRerankScores({ nope: true }, 3)).toBeNull();
  });
});

describe('local first', () => {
  it('uses the local reranker when one is healthy and never calls the cloud', async () => {
    rerankerSidecarUsable.mockReturnValue(LOCAL_SIDECAR);
    listVirtualContainers.mockReturnValue([OR_RERANKER]);
    global.fetch = okFetch({ results: DOCS.map((_, i) => ({ index: i, relevance_score: 1 - i * 0.1 })) });

    const out = await rerankLocalFirst('q', DOCS);
    expect(out!.path).toBe('local');
    expect(out!.servedBy).toBe('gpu-01');
    expect(virtualRerank).not.toHaveBeenCalled();
  });

  it('falls back to /v1/score when the sidecar has no /v1/rerank', async () => {
    rerankerSidecarUsable.mockReturnValue(LOCAL_SIDECAR);
    let call = 0;
    global.fetch = jest.fn(async () => {
      call++;
      if (call === 1) return { ok: false, status: 404, text: async () => '' } as any;
      return { ok: true, status: 200, json: async () => ({ data: [{ score: 0.5 }, { score: 0.4 }, { score: 0.3 }] }) } as any;
    }) as any;

    const out = await rerankLocalFirst('q', DOCS);
    expect(out!.path).toBe('local');
    expect(out!.scores).toEqual([0.5, 0.4, 0.3]);
  });
});

describe('fallback to OpenRouter', () => {
  it('falls back when no local reranker is registered — the gpu-01 case', async () => {
    rerankerSidecarUsable.mockReturnValue(null);
    listVirtualContainers.mockReturnValue([OR_RERANKER]);
    virtualRerank.mockResolvedValue({
      source: 'openrouter',
      results: DOCS.map((_, i) => ({ index: i, relevance_score: 0.5 + i * 0.1 })),
      model: 'qwen/qwen3-reranker-8b',
    });

    const out = await rerankLocalFirst('q', DOCS);
    expect(out!.path).toBe('openrouter');
    expect(out!.servedBy).toBe('BASWS35-OR-Reranker');
    expect(out!.model).toBe('qwen/qwen3-reranker-8b');
    expect(out!.localSkipReason).toMatch(/no usable sidecar advertises/);
  });

  it('falls back when the local reranker is registered but not usable', async () => {
    // `rerankerSidecarUsable` applies main's `isSidecarUsable` itself, so an
    // unhealthy, stale or embed-faulted host simply does not come back from
    // it — the router inherits those rules rather than re-implementing them.
    rerankerSidecarUsable.mockReturnValue(null);
    listVirtualContainers.mockReturnValue([OR_RERANKER]);
    virtualRerank.mockResolvedValue({ source: 'openrouter', results: [{ index: 0, relevance_score: 1 }], model: 'qwen/qwen3-reranker-8b' });

    const out = await rerankLocalFirst('q', ['only']);
    expect(out!.path).toBe('openrouter');
    expect(out!.localSkipReason).toMatch(/no usable sidecar/);
  });

  it('falls back when the local REQUEST fails, not just when local is absent', async () => {
    rerankerSidecarUsable.mockReturnValue(LOCAL_SIDECAR);
    listVirtualContainers.mockReturnValue([OR_RERANKER]);
    global.fetch = failFetch(500);
    virtualRerank.mockResolvedValue({ source: 'openrouter', results: [{ index: 0, relevance_score: 1 }], model: 'qwen/qwen3-reranker-8b' });

    const out = await rerankLocalFirst('q', ['only']);
    expect(out!.path).toBe('openrouter');
    expect(out!.localSkipReason).toMatch(/500/);
  });

  it('prefers the configured model when slots allow-list different ones', async () => {
    rerankerSidecarUsable.mockReturnValue(null);
    listVirtualContainers.mockReturnValue([
      // A names something else entirely; B names what Fantom is configured for.
      { ...OR_RERANKER, providerName: 'A-OR-Reranker', model: 'some/other-reranker' },
      { ...OR_RERANKER, providerName: 'B-OR-Reranker', model: 'qwen/qwen3-reranker-8b' },
    ]);
    virtualRerank.mockResolvedValue({ source: 'openrouter', results: [{ index: 0, relevance_score: 1 }], model: 'qwen/qwen3-reranker-8b' });

    const out = await rerankLocalFirst('q', ['only']);
    expect(out!.servedBy).toBe('B-OR-Reranker');
  });
});

describe('a failed local rerank drops the probe cache', () => {
  // `rerankerSidecarUsable` caches its scan for 60 s. Without invalidation a
  // host that just failed would keep being picked for a full minute; with it,
  // the next request re-scans. This is the part of "re-evaluate per request"
  // that actually matters.
  it('invalidates on an HTTP failure', async () => {
    rerankerSidecarUsable.mockReturnValue(LOCAL_SIDECAR);
    listVirtualContainers.mockReturnValue([OR_RERANKER]);
    virtualRerank.mockResolvedValue({ source: 'openrouter', results: [{ index: 0, relevance_score: 1 }], model: 'qwen/qwen3-reranker-8b' });
    global.fetch = failFetch(500);

    await rerankLocalFirst('q', ['only']);
    expect(resetRerankerCache).toHaveBeenCalled();
  });

  it('invalidates on an unparseable response', async () => {
    rerankerSidecarUsable.mockReturnValue(LOCAL_SIDECAR);
    listVirtualContainers.mockReturnValue([]);
    global.fetch = okFetch({ nonsense: true });

    await rerankLocalFirst('q', ['only']);
    expect(resetRerankerCache).toHaveBeenCalled();
  });

  it('does NOT invalidate on a successful rerank', async () => {
    rerankerSidecarUsable.mockReturnValue(LOCAL_SIDECAR);
    global.fetch = okFetch({ results: [{ index: 0, relevance_score: 0.5 }] });

    await rerankLocalFirst('q', ['only']);
    expect(resetRerankerCache).not.toHaveBeenCalled();
  });
});

describe('recovery — selection is re-evaluated per request', () => {
  it('takes local traffic back the moment gpu-01 registers again', async () => {
    listVirtualContainers.mockReturnValue([OR_RERANKER]);
    virtualRerank.mockResolvedValue({ source: 'openrouter', results: [{ index: 0, relevance_score: 1 }], model: 'qwen/qwen3-reranker-8b' });

    // 1. gpu-01 absent → cloud.
    rerankerSidecarUsable.mockReturnValue(null);
    expect((await rerankLocalFirst('q', ['x']))!.path).toBe('openrouter');

    // 2. gpu-01 comes back, no restart, no cache flush.
    rerankerSidecarUsable.mockReturnValue(LOCAL_SIDECAR);
    global.fetch = okFetch({ results: [{ index: 0, relevance_score: 0.8 }] });
    expect((await rerankLocalFirst('q', ['x']))!.path).toBe('local');

    // 3. gpu-01 goes away again — search keeps working.
    rerankerSidecarUsable.mockReturnValue(null);
    expect((await rerankLocalFirst('q', ['x']))!.path).toBe('openrouter');
  });
});

describe('no backend at all', () => {
  it('returns null so the caller keeps its input order rather than failing', async () => {
    rerankerSidecarUsable.mockReturnValue(null);
    listVirtualContainers.mockReturnValue([]);
    expect(await rerankLocalFirst('q', DOCS)).toBeNull();
  });

  it('returns null when the cloud path also fails', async () => {
    rerankerSidecarUsable.mockReturnValue(null);
    listVirtualContainers.mockReturnValue([OR_RERANKER]);
    virtualRerank.mockRejectedValue(new Error('sidecar routed to local'));
    expect(await rerankLocalFirst('q', DOCS)).toBeNull();
  });

  it('short-circuits an empty document list', async () => {
    const out = await rerankLocalFirst('q', []);
    expect(out!.scores).toEqual([]);
    expect(rerankerSidecarUsable).not.toHaveBeenCalled();
  });
});


describe('the routing policy decides whether cloud may be reached at all', () => {
  const OR = {
    sidecarId: 'sc-gpu02', sidecarName: 'BASWS34', providerName: 'BASWS34-OR-Reranker',
    role: 'reranker', mode: 'cloud-only', model: 'qwen/qwen3-reranker-8b',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // The policy read is TTL-cached to keep a synchronous config read off the
    // search path; clear it so each case drives its own policy.
    __resetRerankPolicyCacheForTest();
    // No healthy local reranker — gpu-01 has roles [cuda, ocr] and never
    // registered one, so this is the real fleet's steady state.
    rerankerSidecarUsable.mockReturnValue(null);
    listVirtualContainers.mockReturnValue([OR]);
    virtualRerank.mockResolvedValue({
      source: 'openrouter', results: [{ index: 0, relevance_score: 1 }], model: 'qwen/qwen3-reranker-8b',
    });
  });

  it('"SideCar only" keeps the request local even with a cloud-routable container registered', async () => {
    getOpenRouterSettings.mockReturnValue({ policyByRole: { reranker: 'local' } });
    const out = await rerankLocalFirst('q', ['only']);
    expect(virtualRerank).not.toHaveBeenCalled();
    // No backend served it, so callers keep their input order rather than fail.
    expect(out).toBeNull();
  });

  it('"as backup" lets the cloud cover an absent local reranker', async () => {
    getOpenRouterSettings.mockReturnValue({ policyByRole: { reranker: 'backup' } });
    const out = await rerankLocalFirst('q', ['only']);
    expect(virtualRerank).toHaveBeenCalled();
    expect(out!.path).toBe('openrouter');
  });

  it('"SideCar + OpenRouter" behaves as backup here — one call has no fan-out to join', async () => {
    getOpenRouterSettings.mockReturnValue({ policyByRole: { reranker: 'aggregate' } });
    const out = await rerankLocalFirst('q', ['only']);
    expect(virtualRerank).toHaveBeenCalled();
    expect(out!.path).toBe('openrouter');
  });

  it('an unreadable config does not silently start spending', async () => {
    getOpenRouterSettings.mockImplementation(() => { throw new Error('config unreadable'); });
    const out = await rerankLocalFirst('q', ['only']);
    expect(virtualRerank).not.toHaveBeenCalled();
    expect(out).toBeNull();
  });

  it('an omitted reranker policy falls to the default rather than reading as disabled', async () => {
    getOpenRouterSettings.mockReturnValue({ policyByRole: {} });
    const out = await rerankLocalFirst('q', ['only']);
    // Default is aggregate, which for this role means cloud may cover the gap.
    expect(virtualRerank).toHaveBeenCalled();
    expect(out!.path).toBe('openrouter');
  });
});
