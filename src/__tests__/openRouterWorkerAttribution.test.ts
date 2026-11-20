/**
 * Direct OpenRouter rows are credited per pool worker (worker1 … workerN).
 * Dashboard label rules: embeddingProviderLabels.test.ts.
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

jest.unstable_mockModule('../config/secretsStore.js', () => ({
  SECRET_NAMES: ['FANTOM_OPENROUTER_API_KEY'],
  readStoredSecret: jest.fn(() => null),
  secretSource: jest.fn(() => 'env'),
  storeSecret: jest.fn(),
  deleteStoredSecret: jest.fn(() => false),
  applyStoredSecretsToEnv: jest.fn(() => []),
  __resetSecretsStoreForTest: jest.fn(),
}));

const { OpenRouterWorkerPool, __resetOpenRouterPoolForTest } = await import('../openrouter/workerPool.js');
const { LoopLagGuard } = await import('../openrouter/loopLag.js');
const { __setOpenRouterFetchForTest } = await import('../openrouter/http.js');
const { DirectOpenRouterEmbeddingProvider } = await import('../openrouter/embeddingProvider.js');
const { recordVerified, __resetVectorCompatibilityForTest } = await import('../embedding/providers/vectorCompatibility.js');
const { workerSplitOf, servedAttribution, workerName } = await import('../openrouter/workerAttribution.js');
const { __resetActivityForTest } = await import('../sidecars/openRouterActivity.js');
const { embedTextsPipelined, _resetPipelineRatesForTests } = await import('../embedding/providers/embedScheduler.js');
const { embedBatchFanout } = await import('../embedding/providers/embeddingProvider.js');

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

function makePool(workerCount: number) {
  const settings = { workerCount, interactiveSlots: 2, requestTimeoutMs: 120_000 };
  return new OpenRouterWorkerPool(() => settings, new LoopLagGuard(() => settings.workerCount));
}

describe('pool worker slots', () => {
  it('gives each running bulk job a distinct 1-based slot within workerCount', async () => {
    const pool = makePool(3);
    const seen: Array<number | null> = [];
    let running = new Set<number | null>();
    let clash = false;
    await Promise.all(Array.from({ length: 12 }, () => pool.submit({
      role: 'code-embedding', lane: 'bulk', projectId: 1,
      run: async ({ worker }) => {
        if (running.has(worker)) clash = true;
        running.add(worker);
        seen.push(worker);
        await tick(2);
        running.delete(worker);
      },
    })));
    expect(clash).toBe(false);
    expect(new Set(seen)).toEqual(new Set([1, 2, 3]));
  });

  it('reuses the lowest free slot', async () => {
    const pool = makePool(2);
    const seen: Array<number | null> = [];
    for (let i = 0; i < 3; i++) {
      await pool.submit({ role: 'r', lane: 'bulk', projectId: 1, run: async ({ worker }) => { seen.push(worker); } });
    }
    expect(seen).toEqual([1, 1, 1]);
  });

  it('gives the interactive lane no slot', async () => {
    const pool = makePool(2);
    const w = await pool.submit({ role: 'r', lane: 'interactive', run: async ({ worker }) => worker });
    expect(w).toBeNull();
  });
});

describe('direct provider tags vectors with the worker that served them', () => {
  const KEY = 'sk-or-v1-FAKEKEY1234567890';
  beforeEach(() => {
    process.env.FANTOM_OPENROUTER_API_KEY = KEY;
    __resetActivityForTest();
    __resetVectorCompatibilityForTest();
    __resetOpenRouterPoolForTest(makePool(4));
    __setOpenRouterFetchForTest(async (_url, init) => {
      const body = JSON.parse(init.body!);
      const text = JSON.stringify({
        data: body.input.map((_: string, i: number) => ({ index: i, embedding: [1, 2, 3, 4] })),
        model: body.model, usage: { total_tokens: 1 },
      });
      return {
        ok: true, status: 200, headers: { get: () => null },
        text: async () => text,
        arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
      };
    });
  });
  afterEach(() => {
    __setOpenRouterFetchForTest(null);
    __resetOpenRouterPoolForTest(null);
    delete process.env.FANTOM_OPENROUTER_API_KEY;
  });

  function provider(lane: 'bulk' | 'interactive' = 'bulk') {
    const p = new DirectOpenRouterEmbeddingProvider(
      { role: 'code-embedding', providerName: 'Fantom-OR-CodeEmbedding', model: 'qwen/qwen3-embedding-8b', pin: 'Nebius' },
      4, lane,
    );
    recordVerified({ key: p.verdictKey(), providerName: p.providerName, dims: 4, samples: 1, reference: 'stored-ref' });
    return p;
  }

  it('credits a bulk batch to workerN names, never to the provider or a key', async () => {
    const p = provider();
    const vecs = await p.embedBatch(Array.from({ length: 250 }, (_, i) => `t${i}`));
    expect(vecs).toHaveLength(250);
    const split = workerSplitOf(vecs)!;
    expect(split).toBeDefined();
    for (const name of Object.keys(split)) expect(name).toMatch(/^worker[1-4]$/);
    expect(Object.values(split).reduce((a, b) => a + b, 0)).toBe(250);
    expect(JSON.stringify(split)).not.toContain(KEY);
    const credited = servedAttribution(p, 250, vecs);
    expect(credited.every(([n]) => /^worker\d$/.test(n))).toBe(true);
  });

  function credited() {
    const served = new Map<string, number>();
    const credit = (p: unknown, n: number, v?: Float32Array[]) => {
      for (const [name, k] of servedAttribution(p, n, v)) served.set(name, (served.get(name) ?? 0) + k);
    };
    return { served, credit };
  }

  it('keeps worker names through the pipelined scheduler (re-embed path)', async () => {
    _resetPipelineRatesForTests();
    const { served, credit } = credited();
    const texts = Array.from({ length: 300 }, (_, i) => `t${i}`);
    const run = await embedTextsPipelined([provider()], texts, {
      depth: 6, minChunk: 100, probeChunk: 100, maxChunk: 100, onServed: credit,
    });
    expect(run.failed).toBe(0);
    expect([...served.keys()].every(n => /^worker[1-4]$/.test(n))).toBe(true);
    expect([...served.values()].reduce((a, b) => a + b, 0)).toBe(300);
  });

  it('keeps worker names through embedBatchFanout (index build path)', async () => {
    const { served, credit } = credited();
    const local = { embedBatch: async (t: string[]) => t.map(() => new Float32Array(4)), embed: async () => new Float32Array(4),
      getModelName: () => 'qwen/qwen3-embedding-8b', getDimensions: () => 4, initialize: async () => {}, getSidecarName: () => 'BASWS35' };
    await embedBatchFanout([provider()], ['a', 'b', 'c'], credit);
    expect([...served.keys()].every(n => /^worker[1-4]$/.test(n))).toBe(true);
    await embedBatchFanout([provider(), local as never], Array.from({ length: 20 }, (_, i) => `x${i}`), credit);
    expect([...served.values()].reduce((a, b) => a + b, 0)).toBe(23);
    expect([...served.keys()].every(n => /^worker[1-4]$/.test(n) || n === 'BASWS35')).toBe(true);
  });

  it('leaves query (interactive) calls untagged', async () => {
    const vecs = await provider('interactive').embedBatch(['q']);
    expect(workerSplitOf(vecs)).toBeUndefined();
  });

  it('falls back to the provider name for an untagged result', () => {
    const local = { getSidecarName: () => 'BASWS35' };
    expect(servedAttribution(local, 7, [new Float32Array(4)])).toEqual([['BASWS35', 7]]);
    expect(servedAttribution({}, 3)).toEqual([['in-process', 3]]);
    expect(workerName(6)).toBe('worker6');
  });
});
