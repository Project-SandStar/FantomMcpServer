/**
 * Fantom's own OpenRouter client (src/openrouter/client.ts): request shapes,
 * the refusals that protect the vector table, 429 handling, key redaction,
 * activity accounting and the daily spend cap. No network: every call goes
 * through the `__setOpenRouterFetchForTest` seam.
 */
import { jest } from '@jest/globals';

// Never read this machine's real secrets file.
jest.unstable_mockModule('../config/secretsStore.js', () => ({
  SECRET_NAMES: ['FANTOM_OPENROUTER_API_KEY'],
  readStoredSecret: jest.fn(() => null),
  secretSource: jest.fn(() => 'env'),
  storeSecret: jest.fn(),
  deleteStoredSecret: jest.fn(() => false),
  applyStoredSecretsToEnv: jest.fn(() => []),
  __resetSecretsStoreForTest: jest.fn(),
}));

const { __setOpenRouterFetchForTest } = await import('../openrouter/http.js');
const { embed, rerank, chat, OpenRouterError, isRateLimited } = await import('../openrouter/client.js');
const { allActivity, roleActivity, setDailyCap, __resetActivityForTest } = await import('../sidecars/openRouterActivity.js');

const KEY = 'sk-or-v1-FAKEKEY1234567890';

interface Call { url: string; method: string; headers: Record<string, string>; body: any }
let calls: Call[] = [];

function reply(status: number, body: unknown, hdrs: Record<string, string> = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const lower = Object.fromEntries(Object.entries(hdrs).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => lower[n.toLowerCase()] ?? null },
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
  };
}

function serve(fn: (c: Call) => ReturnType<typeof reply>): void {
  __setOpenRouterFetchForTest(async (url, init) => {
    const c: Call = { url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(c);
    return fn(c);
  });
}

const embedReply = (n: number, dims: number, extra: Record<string, unknown> = {}) => reply(200, {
  data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: Array.from({ length: dims }, (_, j) => i + j / 10) })),
  model: 'qwen/qwen3-embedding-4b',
  usage: { total_tokens: 7 },
  ...extra,
});

const EMBED_OPTS = { role: 'code-embedding' as const, model: 'qwen/qwen3-embedding-4b', pin: 'DeepInfra', expectedDims: 4 };

beforeEach(() => {
  calls = [];
  process.env.FANTOM_OPENROUTER_API_KEY = KEY;
  __resetActivityForTest();
});
afterEach(() => {
  __setOpenRouterFetchForTest(null);
  delete process.env.FANTOM_OPENROUTER_API_KEY;
});

describe('embed', () => {
  it('sends model, input and a pinned provider with no fallbacks', async () => {
    serve(() => embedReply(2, 4));
    const r = await embed(['a', 'b'], EMBED_OPTS);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/embeddings');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({
      model: 'qwen/qwen3-embedding-4b',
      input: ['a', 'b'],
      provider: { order: ['DeepInfra'], allow_fallbacks: false },
    });
    expect(calls[0].headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].headers['X-Title']).toBe('Fantom MCP');
    expect(r.vectors).toHaveLength(2);
    expect(r.vectors[0]).toBeInstanceOf(Float32Array);
    expect(r.dims).toBe(4);
    expect(r.totalTokens).toBe(7);
  });

  it('refuses an unpinned embed before any fetch', async () => {
    serve(() => embedReply(1, 4));
    await expect(embed(['a'], { ...EMBED_OPTS, pin: '' })).rejects.toThrow(/no upstream pin/);
    expect(calls).toHaveLength(0);
  });

  it('refuses vectors of the wrong width', async () => {
    serve(() => embedReply(2, 3));
    const err = await embed(['a', 'b'], EMBED_OPTS).catch(e => e);
    expect(err).toBeInstanceOf(OpenRouterError);
    expect(err.code).toBe('wrong-dims');
    expect(err.message).toMatch(/3-dim vectors but 4 was expected/);
  });

  it('refuses a reply with the wrong number of vectors', async () => {
    serve(() => embedReply(1, 4));
    await expect(embed(['a', 'b'], EMBED_OPTS)).rejects.toThrow(/returned 1 vectors for 2 texts/);
  });

  it('puts vectors back in input order by index', async () => {
    serve(() => reply(200, {
      data: [
        { index: 2, embedding: [2, 2, 2, 2] },
        { index: 0, embedding: [0, 0, 0, 0] },
        { index: 1, embedding: [1, 1, 1, 1] },
      ],
    }));
    const r = await embed(['a', 'b', 'c'], EMBED_OPTS);
    expect(r.vectors.map(v => v[0])).toEqual([0, 1, 2]);
  });

  it('makes no call for an empty input', async () => {
    serve(() => embedReply(0, 4));
    const r = await embed([], EMBED_OPTS);
    expect(r.vectors).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('errors', () => {
  it('turns a 429 into OpenRouterError status 429 with retryAfterMs from Retry-After', async () => {
    serve(() => reply(429, { error: { message: 'Rate limit exceeded' } }, { 'Retry-After': '7' }));
    const err = await embed(['a'], EMBED_OPTS).catch(e => e);
    expect(err).toBeInstanceOf(OpenRouterError);
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(7000);
    expect(err.code).toBe('rate-limited');
    expect(isRateLimited(err)).toBe(true);
    expect(err.message).toMatch(/HTTP 429/);
    expect(err.message).toMatch(/Rate limit exceeded/);
  });

  it('never puts the key in an error message, even when the server echoes it', async () => {
    serve(() => reply(401, { error: { message: `Invalid key ${KEY} (also Bearer ${KEY})` } }));
    const errs = [
      await embed(['a'], EMBED_OPTS).catch(e => e),
      await rerank('q', ['d'], { model: 'qwen/qwen3-reranker-8b' }).catch(e => e),
      await chat([{ role: 'user', content: 'hi' }], { role: 'code-assistant', model: 'm' }).catch(e => e),
    ];
    for (const e of errs) {
      expect(e).toBeInstanceOf(OpenRouterError);
      expect(e.status).toBe(401);
      expect(e.message).not.toContain(KEY);
      expect(e.message).not.toContain('FAKEKEY');
      expect(String(e.stack)).not.toContain(KEY);
    }
  });

  it('redacts another sk-or key the server echoes too', async () => {
    serve(() => reply(400, { error: { message: 'bad key sk-or-v1-SOMEOTHERKEY99999' } }));
    const e = await embed(['a'], EMBED_OPTS).catch(x => x);
    expect(e.message).not.toContain('SOMEOTHERKEY');
  });

  it('keeps the key out of a network error message', async () => {
    __setOpenRouterFetchForTest(async () => { throw new Error(`connect failed for ${KEY}`); });
    const e = await embed(['a'], EMBED_OPTS).catch(x => x);
    expect(e).toBeInstanceOf(OpenRouterError);
    expect(e.status).toBe(0);
    expect(e.code).toBe('network');
    expect(e.message).not.toContain(KEY);
  });

  it('refuses without a key, before any fetch', async () => {
    delete process.env.FANTOM_OPENROUTER_API_KEY;
    serve(() => embedReply(1, 4));
    const e = await embed(['a'], EMBED_OPTS).catch(x => x);
    expect(e.code).toBe('no-key');
    expect(calls).toHaveLength(0);
  });
});

describe('rerank', () => {
  it('sends model, query, documents, top_n and a pin that may fall back', async () => {
    serve(() => reply(200, { results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }], model: 'qwen/qwen3-reranker-8b' }));
    const r = await rerank('q', ['a', 'b'], { model: 'qwen/qwen3-reranker-8b', pin: 'DeepInfra', topN: 2 });
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/rerank');
    expect(calls[0].body).toEqual({
      model: 'qwen/qwen3-reranker-8b', query: 'q', documents: ['a', 'b'], top_n: 2,
      provider: { order: ['DeepInfra'], allow_fallbacks: true },
    });
    expect(r.results[0]).toEqual({ index: 1, relevance_score: 0.9 });
  });

  it('sends no provider block when unpinned', async () => {
    serve(() => reply(200, { results: [] }));
    await rerank('q', ['a'], { model: 'm' });
    expect(calls[0].body).not.toHaveProperty('provider');
    expect(calls[0].body).not.toHaveProperty('top_n');
  });

  it('refuses a reply without results', async () => {
    serve(() => reply(200, { nope: true }));
    await expect(rerank('q', ['a'], { model: 'm' })).rejects.toThrow(/no results/);
  });
});

describe('chat', () => {
  it('asks for usage, turns reasoning off and never streams', async () => {
    serve(() => reply(200, {
      model: 'qwen/qwen3-coder',
      choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
      usage: { total_tokens: 12, cost: 0.0001 },
    }));
    const r = await chat([{ role: 'user', content: 'ping' }], {
      role: 'code-assistant', model: 'qwen/qwen3-coder', maxTokens: 16, temperature: 0,
      extra: { stream: true },
    });
    const b = calls[0].body;
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(b.model).toBe('qwen/qwen3-coder');
    expect(b.messages).toEqual([{ role: 'user', content: 'ping' }]);
    expect(b.usage).toEqual({ include: true });
    expect(b.reasoning).toEqual({ enabled: false });
    expect(b).not.toHaveProperty('stream');
    expect(b.max_tokens).toBe(16);
    expect(b.temperature).toBe(0);
    expect(r.text).toBe('OK');
    expect(r.costUsd).toBe(0.0001);
    expect(r.finishReason).toBe('stop');
  });

  it('turns reasoning on only when asked', async () => {
    serve(() => reply(200, { choices: [{ message: { content: '' } }] }));
    await chat([], { role: 'rlm', model: 'm', reasoning: true });
    expect(calls[0].body.reasoning).toEqual({ enabled: true });
  });

  it('throws on an error object inside a 200 reply', async () => {
    serve(() => reply(200, { error: { message: 'model is overloaded', code: 503 } }));
    const e = await chat([], { role: 'code-assistant', model: 'm' }).catch(x => x);
    expect(e).toBeInstanceOf(OpenRouterError);
    expect(e.status).toBe(503);
    expect(e.message).toMatch(/overloaded/);
  });
});

describe('activity and the daily cap', () => {
  it('records a successful call against its role', async () => {
    serve(() => embedReply(1, 4));
    await embed(['a'], EMBED_OPTS);
    const a = allActivity().find(r => r.role === 'code-embedding')!;
    expect(a.callsToday).toBe(1);
    expect(a.tokensToday).toBe(7);
    expect(a.inFlight).toBe(0);
    expect(a.lastCall).toMatchObject({ success: true, servedBy: 'fantom' });
    expect(a.callsByServedBy).toEqual({ fantom: 1 });
  });

  it('records a failed call as a failure, not a billed call', async () => {
    serve(() => reply(500, 'upstream down'));
    await embed(['a'], EMBED_OPTS).catch(() => undefined);
    const a = roleActivity('code-embedding');
    expect(a.callsToday).toBe(0);
    expect(a.lastCall).toMatchObject({ success: false });
    expect(a.lastCall!.error).toMatch(/HTTP 500/);
  });

  it('refuses a call once the role is over its daily cap, without fetching', async () => {
    // 1M tokens of qwen3-embedding-4b is $0.02; a $0.01 cap is then spent.
    serve(() => embedReply(1, 4, { usage: { total_tokens: 1_000_000 } }));
    setDailyCap('code-embedding', 0.01);
    await embed(['a'], EMBED_OPTS);
    expect(roleActivity('code-embedding').capped).toBe(true);
    calls = [];
    const e = await embed(['b'], EMBED_OPTS).catch(x => x);
    expect(e).toBeInstanceOf(OpenRouterError);
    expect(e.code).toBe('capped');
    expect(e.status).toBe(402);
    expect(calls).toHaveLength(0);
    // Other roles are not affected.
    serve(() => reply(200, { results: [] }));
    await expect(rerank('q', ['a'], { model: 'qwen/qwen3-reranker-8b' })).resolves.toBeDefined();
  });
});
