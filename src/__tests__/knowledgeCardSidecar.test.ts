/**
 * Sidecar models for knowledge cards: routing (sidecar vs OpenRouter), host
 * failover, no silent paid fallback, per-host limit, settings validation and
 * output parsing for thinking models (qwen3.5:9b).
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { Sidecar } from '../admin/types.js';

const chatMock = jest.fn(async (..._a: unknown[]) => ({ text: '{"summary":"x","claims":[]}', costUsd: 0.001, model: 'deepseek/deepseek-v4-flash' }));
jest.unstable_mockModule('../openrouter/client.js', () => ({ chat: chatMock }));
jest.unstable_mockModule('../openrouter/workerPool.js', () => ({
  openRouterPool: () => ({ submit: (job: { run: () => Promise<unknown> }) => job.run() }),
}));

const settings = await import('../knowledge/cardSettings.js');
const side = await import('../knowledge/cardSidecar.js');
const builder = await import('../knowledge/cardBuilder.js');
const { __setCardSettingsForTest, validateModelChoices, validateCardInput, sanitizeCardSettings, isSidecarModelId } = settings;
const { __setSidecarCardDepsForTest, sidecarCardChat, sidecarModelOptions, SidecarCardModelError, SidecarCardBusyError, stripThink, assertSidecarModelLive } = side;
const { __bulkChatForTest, parseJsonReply, estimateCost, buildIsFree } = builder;

type Host = import('../knowledge/cardSidecar.js').CardHost;

/** A host as the Sidecars tab sees it, running a completion container. */
function host(id: string, models: string[], live = true, container = 'ss-completion', status: string | null = 'running'): Host {
  const sc = {
    id, name: id, host: id, enabled: true, url: `http://${id}`, healthStatus: live ? 'healthy' : 'unhealthy',
    capabilities: { llm: { available: true, models } },
  } as unknown as Sidecar;
  return { sc, online: live, container, model: models[0] ?? null, status };
}
const ok = (content: string, finishReason: string | null = 'stop') =>
  ({ content, reasoning: '', finishReason, model: 'qwen3.5:9b', host: 'x' });

let hosts: Host[] = [];
beforeEach(() => {
  chatMock.mockClear();
  hosts = [];
  __setCardSettingsForTest({ sidecarPerHostLimit: 1 });
});
afterEach(() => { __setSidecarCardDepsForTest(null); __setCardSettingsForTest(null); });

function deps(call: (h: Sidecar, model: string) => Promise<ReturnType<typeof ok>>, limit = 1) {
  __setSidecarCardDepsForTest({
    listHosts: async () => hosts,
    call: (sc, _m, o) => call(sc, o.model),
    perHostLimit: () => limit,
    noHostWaitMs: 0,
    noHostPollMs: 10,
  });
}

describe('card model routing', () => {
  it('a sidecar id goes to the sidecar, never to OpenRouter chat()', async () => {
    hosts = [host('gpu-a', ['qwen3.5:9b'])];
    const seen: string[] = [];
    deps(async h => { seen.push(h.id); return ok('{"summary":"s","claims":[]}'); });
    const out = await __bulkChatForTest('sys', 'user', 'sidecar/ss-completion', 1, 500);
    expect(seen).toEqual(['gpu-a']);
    expect(out.costUsd).toBe(0);
    expect(out.model).toBe('sidecar/ss-completion');
    expect(chatMock).not.toHaveBeenCalled();
  });
  it('an OpenRouter id goes to chat()', async () => {
    hosts = [host('gpu-a', ['qwen3.5:9b'])];
    const call = jest.fn(async () => ok('{}'));
    deps(call);
    await __bulkChatForTest('sys', 'user', 'deepseek/deepseek-v4-flash', 1, 500);
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(call).not.toHaveBeenCalled();
  });
  it('no live host: fails cleanly with no paid fallback', async () => {
    hosts = [host('gpu-a', ['qwen3.5:9b'], false), host('gpu-b', ['other:1b'], true, 'ss-other')];
    deps(async () => ok('{}'));
    await expect(__bulkChatForTest('sys', 'user', 'sidecar/ss-completion', 1, 500)).rejects.toThrow(SidecarCardModelError);
    expect(chatMock).not.toHaveBeenCalled();
    await expect(assertSidecarModelLive('sidecar/ss-completion')).rejects.toThrow(/no online sidecar runs ss-completion/);
    await expect(assertSidecarModelLive('deepseek/deepseek-v4-flash')).resolves.toBeUndefined();
  });
});

describe('host failover and load', () => {
  it('fails over to another host when one errors', async () => {
    hosts = [host('gpu-a', ['qwen3.5:9b']), host('gpu-b', ['qwen3.5:9b'])];
    const seen: string[] = [];
    deps(async h => { seen.push(h.id); if (h.id === seen[0] && seen.length === 1) throw new Error('ECONNREFUSED'); return ok('{"a":1}'); });
    const out = await sidecarCardChat('s', 'u', 'sidecar/ss-completion', { maxTokens: 100, timeoutMs: 1000, lane: 'bulk' });
    expect(seen.length).toBe(2);
    expect(new Set(seen).size).toBe(2);
    expect(out.host).toBe(seen[1]);
  });
  it('every host failing names each error and does not call OpenRouter', async () => {
    hosts = [host('gpu-a', ['qwen3.5:9b']), host('gpu-b', ['qwen3.5:9b'])];
    deps(async h => { throw new Error(`down ${h.id}`); });
    await expect(sidecarCardChat('s', 'u', 'sidecar/ss-completion', { maxTokens: 100, timeoutMs: 1000, lane: 'bulk' }))
      .rejects.toThrow(/down gpu-a.*down gpu-b|down gpu-b.*down gpu-a/);
    expect(chatMock).not.toHaveBeenCalled();
  });
  it('a host that errors once cools down; a queued call waits for it instead of failing', async () => {
    hosts = [host('gpu-a', ['qwen3.5:9b'])];
    let clock = 1_000_000;
    let calls = 0;
    __setSidecarCardDepsForTest({
      listHosts: async () => hosts,
      perHostLimit: () => 1,
      now: () => clock,
      call: async () => { calls++; if (calls === 1) throw new Error('timeout'); return ok('{"x":1}'); },
    });
    const first = sidecarCardChat('s', 'u', 'sidecar/ss-completion', { maxTokens: 100, timeoutMs: 1000, lane: 'bulk' });
    await expect(first).rejects.toThrow(/every host failed: gpu-a: timeout/);
    // gpu-a is cooling: a new bulk call waits rather than throwing at once.
    const second = sidecarCardChat('s', 'u', 'sidecar/ss-completion', { maxTokens: 100, timeoutMs: 1000, lane: 'bulk' });
    await expect(sidecarCardChat('s', 'u', 'sidecar/ss-completion', { maxTokens: 100, timeoutMs: 1000, lane: 'interactive' }))
      .rejects.toThrow(/cooling down/);
    clock += 61_000;
    await expect(second).resolves.toMatchObject({ host: 'gpu-a', costUsd: 0 });
    expect(chatMock).not.toHaveBeenCalled();
  });
  it('a reasoning-only reply is a failed call, not a card', async () => {
    hosts = [host('gpu-a', ['qwen3.5:9b'])];
    deps(async () => ({ content: '', reasoning: 'thinking…', finishReason: 'length', model: 'm', host: 'gpu-a' }));
    await expect(sidecarCardChat('s', 'u', 'sidecar/ss-completion', { maxTokens: 100, timeoutMs: 1000, lane: 'bulk' }))
      .rejects.toThrow(/ran out of tokens/);
  });
  it('keeps at most perHostLimit calls per host and spreads load', async () => {
    hosts = [host('gpu-a', ['qwen3.5:9b']), host('gpu-b', ['qwen3.5:9b'])];
    let active: Record<string, number> = {};
    let peak = 0;
    deps(async h => {
      active[h.id] = (active[h.id] ?? 0) + 1;
      peak = Math.max(peak, ...Object.values(active));
      await new Promise(r => setTimeout(r, 5));
      active[h.id]--;
      return ok('{"x":1}');
    }, 1);
    const used = await Promise.all(Array.from({ length: 6 }, () =>
      sidecarCardChat('s', 'u', 'sidecar/ss-completion', { maxTokens: 100, timeoutMs: 1000, lane: 'bulk' })));
    expect(peak).toBe(1);
    expect(new Set(used.map(u => u.host))).toEqual(new Set(['gpu-a', 'gpu-b']));
    active = {};
  });
  it('an interactive call does not wait behind a busy host', async () => {
    hosts = [host('gpu-a', ['qwen3.5:9b'])];
    let release!: () => void;
    deps(() => new Promise(r => { release = () => r(ok('{"x":1}')); }), 1);
    const bulk = sidecarCardChat('s', 'u', 'sidecar/ss-completion', { maxTokens: 100, timeoutMs: 1000, lane: 'bulk' });
    await expect(sidecarCardChat('s', 'u', 'sidecar/ss-completion', { maxTokens: 100, timeoutMs: 1000, lane: 'interactive' }))
      .rejects.toThrow(SidecarCardBusyError);
    release();
    await bulk;
  });
});

describe('OpenRouter models blocked for this account', () => {
  it('a model missing from /models/user, or refused with ZDR, is disabled with the reason', async () => {
    const { applyAccountBlocks } = await import('../admin/knowledgeCardRoutes.js');
    const list = [
      { id: 'qwen/qwen3.7-flash', live: true },
      { id: 'openai/gpt-oss-20b', live: true },
      { id: 'z-ai/glm-5.3-flash', live: true },
    ];
    settings.noteAccountBlocked('z-ai/glm-5.3-flash', 'No endpoints available matching your ZDR policy');
    const out = applyAccountBlocks(list, new Set(['openai/gpt-oss-20b', 'z-ai/glm-5.3-flash']), settings.accountBlockedReason);
    expect(out[0]).toMatchObject({ live: false, reason: expect.stringMatching(/ZDR/) });
    expect(out[1]).toEqual({ id: 'openai/gpt-oss-20b', live: true });
    expect(out[2]).toMatchObject({ live: false, reason: expect.stringMatching(/ZDR policy/) });
    // Unknown account list: nothing is blocked on a guess.
    settings.__clearAccountBlockedForTest();
    expect(applyAccountBlocks(list, null, settings.accountBlockedReason)).toEqual(list);
  });
});

describe('sidecar model options (from the Sidecars tab data)', () => {
  it('one ss-completion entry with the model read from the hosts, online and offline hosts', async () => {
    hosts = [host('gpu-a', ['qwen3.5:9b']), host('gpu-b', ['qwen3.5:9b']), host('gpu-c', ['qwen3.5:9b'], false)];
    deps(async () => ok('{}'));
    const opts = await sidecarModelOptions();
    expect(opts.map(o => o.id)).toEqual(['sidecar/ss-completion']);
    const q = opts[0];
    expect(q.live).toBe(true);
    expect(q.models).toEqual(['qwen3.5:9b']);
    expect(q.hosts).toEqual(['gpu-a', 'gpu-b']);
    expect(q.offline).toEqual(['gpu-c']);
  });
  it('matches the Sidecars tab: one available host, three listed but unavailable', async () => {
    hosts = [
      host('host-1', ['qwen3.5:9b']),
      host('host-2', ['qwen3.5:9b'], true, 'ss-completion', 'unavailable'),
      host('host-3', ['qwen3.5:9b'], true, 'ss-completion', 'unavailable'),
      host('host-4', ['qwen3.5:9b'], false),
    ];
    deps(async () => ok('{}'));
    const opts = await sidecarModelOptions();
    expect(opts).toHaveLength(1);
    expect(opts[0]).toMatchObject({ id: 'sidecar/ss-completion', container: 'ss-completion', models: ['qwen3.5:9b'], hosts: ['host-1'], live: true });
    expect(opts[0].offline).toEqual(['host-2', 'host-3', 'host-4']);
  });
  it('an older sidecar/<model> id still routes to the container serving it', async () => {
    hosts = [host('host-1', ['qwen3.5:9b'])];
    const sent: string[] = [];
    deps(async (_h, m) => { sent.push(m); return ok('{"a":1}'); });
    await sidecarCardChat('s', 'u', 'sidecar/qwen3.5:9b', { maxTokens: 10, timeoutMs: 100, lane: 'bulk' });
    expect(sent).toEqual(['qwen3.5:9b']);
  });
  it('shows the model even when no host is online', async () => {
    hosts = [host('host-2', ['qwen3.5:9b'], false)];
    deps(async () => ok('{}'));
    expect((await sidecarModelOptions())[0]).toMatchObject({ live: false, models: ['qwen3.5:9b'] });
  });
  it('a stopped container counts as offline', async () => {
    hosts = [host('gpu-a', ['qwen3.5:9b'], true, 'ss-completion', 'exited')];
    deps(async () => ok('{}'));
    const q = (await sidecarModelOptions())[0];
    expect(q.live).toBe(false);
    expect(q.reason).toMatch(/offline \(gpu-a\)/);
  });
  it('suggests ss-completion disabled when no sidecar runs it', async () => {
    deps(async () => ok('{}'));
    const q = (await sidecarModelOptions()).find(o => o.id === 'sidecar/ss-completion')!;
    expect(q.live).toBe(false);
    expect(q.reason).toBe('no sidecar runs it');
  });
  it('sends the model the host reports, not a hardcoded one', async () => {
    hosts = [host('gpu-a', ['qwen3.5:14b'])];
    const sent: string[] = [];
    deps(async (_h, m) => { sent.push(m); return ok('{"a":1}'); });
    const out = await sidecarCardChat('s', 'u', 'sidecar/ss-completion', { maxTokens: 10, timeoutMs: 100, lane: 'bulk' });
    expect(sent).toEqual(['qwen3.5:14b']);
    expect(out.servedModel).toBe('qwen3.5:14b');
  });
});

describe('thinking off for card calls', () => {
  it('card calls ask for noThink with the role output limit', async () => {
    hosts = [host('host-a', ['qwen3.5:9b'])];
    const seen: Array<Record<string, unknown>> = [];
    __setSidecarCardDepsForTest({
      listHosts: async () => hosts, perHostLimit: () => 1,
      call: async (_sc, _m, o) => { seen.push(o as unknown as Record<string, unknown>); return ok('{"a":1}'); },
    });
    await sidecarCardChat('s', 'u', 'sidecar/ss-completion', { maxTokens: 1200, timeoutMs: 100, json: true, lane: 'bulk' });
    expect(seen[0]).toMatchObject({ noThink: true, maxTokens: 1200, responseJsonObject: true, model: 'qwen3.5:9b' });
  });
  it('the request to the host carries think:false and num_predict (Ollama /api/chat)', async () => {
    const { callSidecarChat } = await import('../embedding/sidecarLlmClient.js');
    const real = globalThis.fetch;
    const reqs: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: string, init: { body: string }) => {
      reqs.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ model: 'qwen3.5:9b', done_reason: 'stop', message: { content: '{"ok":true}', thinking: '' } }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const sc = { id: 'h', name: 'h', host: 'h', port: 8098, protocol: 'http', capabilities: { llm: { available: true, models: ['qwen3.5:9b'], port: 11434 } } } as unknown as Sidecar;
      const out = await callSidecarChat(sc, [{ role: 'user', content: 'u' }], { model: 'qwen3.5:9b', maxTokens: 1500, responseJsonObject: true, noThink: true });
      expect(reqs[0].url).toBe('http://h:11434/api/chat');
      expect(reqs[0].body).toMatchObject({ think: false, stream: false, format: 'json', options: { num_predict: 1500 } });
      expect(out).toMatchObject({ content: '{"ok":true}', finishReason: 'stop' });
    } finally { globalThis.fetch = real; }
  });
  it('a host without /api/chat gets the OpenAI route with enable_thinking false', async () => {
    const { callSidecarChat } = await import('../embedding/sidecarLlmClient.js');
    const real = globalThis.fetch;
    const reqs: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: string, init: { body: string }) => {
      reqs.push({ url, body: JSON.parse(init.body) });
      if (url.endsWith('/api/chat')) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'x' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const sc = { id: 'h', name: 'h', host: 'h', port: 8000, protocol: 'http', capabilities: { llm: { available: true, models: ['m'] } } } as unknown as Sidecar;
      await callSidecarChat(sc, [{ role: 'user', content: 'u' }], { model: 'm', maxTokens: 900, noThink: true });
      expect(reqs[1].url).toBe('http://h:8000/v1/chat/completions');
      expect(reqs[1].body).toMatchObject({ max_tokens: 900, chat_template_kwargs: { enable_thinking: false } });
    } finally { globalThis.fetch = real; }
  });
});

describe('hosts follow the live fleet', () => {
  const opts = { maxTokens: 10, timeoutMs: 100, lane: 'bulk' as const };
  it('a host that stops mid-build is dropped; the next call goes to the one serving now', async () => {
    hosts = [host('host-a', ['qwen3.5:9b']), host('host-b', ['qwen3.5:9b'], true, 'ss-completion', 'exited')];
    const seen: string[] = [];
    deps(async h => { seen.push(h.id); return ok('{"a":1}'); });
    await sidecarCardChat('s', 'u', 'sidecar/ss-completion', opts);
    hosts = [host('host-a', ['qwen3.5:9b'], true, 'ss-completion', 'exited'), host('host-b', ['qwen3.5:9b'])];
    await sidecarCardChat('s', 'u', 'sidecar/ss-completion', opts);
    expect(seen).toEqual(['host-a', 'host-b']);
  });
  it('a host that starts serving is used at once (no restart, no save)', async () => {
    hosts = [host('host-a', ['qwen3.5:9b'])];
    const seen: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    deps(async h => { seen.push(h.id); await gate; return ok('{"a":1}'); });
    const first = sidecarCardChat('s', 'u', 'sidecar/ss-completion', opts);
    await new Promise(r => setTimeout(r, 5));
    hosts = [...hosts, host('host-new', ['qwen3.5:9b'])];
    const second = sidecarCardChat('s', 'u', 'sidecar/ss-completion', opts);
    await new Promise(r => setTimeout(r, 5));
    expect(seen).toEqual(['host-a', 'host-new']);
    release();
    await Promise.all([first, second]);
  });
  it('llm available with the model loaded counts even when the container status is not running', async () => {
    const h = host('host-a', ['qwen3.5:9b'], true, 'ss-completion', 'unloaded');
    hosts = [h];
    deps(async () => ok('{}'));
    expect((await sidecarModelOptions())[0].live).toBe(false);
    hosts = [{ ...h, llmLoaded: true }];
    expect((await sidecarModelOptions())[0]).toMatchObject({ live: true, hosts: ['host-a'] });
  });
  it('none serving: a bulk call waits and re-checks, then uses a host that returns', async () => {
    hosts = [];
    const seen: string[] = [];
    __setSidecarCardDepsForTest({
      listHosts: async () => hosts, call: async h => { seen.push(h.id); return ok('{"a":1}'); },
      perHostLimit: () => 1, noHostPollMs: 10, noHostWaitMs: 5_000,
    });
    const p = sidecarCardChat('s', 'u', 'sidecar/ss-completion', opts);
    await new Promise(r => setTimeout(r, 40));
    expect(seen).toEqual([]);
    hosts = [host('host-back', ['qwen3.5:9b'])];
    expect((await p).host).toBe('host-back');
  });
  it('none serving: bulk gives up after the wait limit; interactive fails at once', async () => {
    hosts = [];
    __setSidecarCardDepsForTest({ listHosts: async () => hosts, perHostLimit: () => 1, noHostPollMs: 10, noHostWaitMs: 40 });
    await expect(sidecarCardChat('s', 'u', 'sidecar/ss-completion', opts)).rejects.toThrow(/no online sidecar runs ss-completion \(waited/);
    const t0 = Date.now();
    await expect(sidecarCardChat('s', 'u', 'sidecar/ss-completion', { ...opts, lane: 'interactive' })).rejects.toThrow(SidecarCardModelError);
    expect(Date.now() - t0).toBeLessThan(30);
    expect(chatMock).not.toHaveBeenCalled();
  });
});

describe('settings validation', () => {
  const cur = { writerModel: 'qwen/qwen3.7-flash', checkerModel: 'deepseek/deepseek-v4-flash', answerModel: 'deepseek/deepseek-v4-flash' };
  const catalogue = new Set(['qwen/qwen3.7-flash', 'deepseek/deepseek-v4-flash', 'z-ai/glm-5.3-flash']);
  it('sidecar ids pass the syntax check and survive sanitize', () => {
    expect(validateCardInput({ checkerModel: 'sidecar/ss-completion' })).toEqual([]);
    expect(sanitizeCardSettings({ checkerModel: 'sidecar/ss-completion' }).checkerModel).toBe('sidecar/ss-completion');
    expect(isSidecarModelId('sidecar/ss-completion')).toBe(true);
    expect(isSidecarModelId('qwen/qwen3.7-flash')).toBe(false);
  });
  it('accepts any sidecar id (no host needed at save) or a catalogue id; rejects the rest', () => {
    expect(validateModelChoices({ checkerModel: 'sidecar/ss-completion', answerModel: 'z-ai/glm-5.3-flash' }, cur, catalogue)).toEqual([]);
    expect(validateModelChoices({ checkerModel: 'sidecar/ss-other' }, cur, catalogue)).toEqual([]);
    expect(validateModelChoices({ writerModel: 'acme/none' }, cur, catalogue)[0]).toMatch(/not in the OpenRouter model list/);
  });
  it('does not re-check unchanged values, and accepts OpenRouter ids when the catalogue is unreachable', () => {
    const saved = { ...cur, checkerModel: 'sidecar/ss-completion' };
    expect(validateModelChoices({ ...saved }, saved, catalogue)).toEqual([]);
    expect(validateModelChoices({ writerModel: 'acme/none' }, cur, null)).toEqual([]);
  });
  it('sanitize gives the per-host limit a default of 1 and keeps saved models', () => {
    const s = sanitizeCardSettings({ writerModel: 'z-ai/glm-5.3-flash' });
    expect(s.sidecarPerHostLimit).toBe(1);
    expect(s.writerModel).toBe('z-ai/glm-5.3-flash');
  });
});

describe('partial settings update', () => {
  it('drops unknown keys and empty values, keeps what was sent', () => {
    expect(settings.cardSettingsPatch({ checkerModel: 'sidecar/ss-completion', minLines: '', useForAsks: undefined, bogus: 1, concurrency: 2 }))
      .toEqual({ checkerModel: 'sidecar/ss-completion', concurrency: 2 });
    expect(settings.cardSettingsPatch({ useForAsks: false })).toEqual({ useForAsks: false });
  });
});

describe('cost and cap for sidecar builds', () => {
  it('estimates $0 for sidecar writer and checker', () => {
    const s = sanitizeCardSettings({ writerModel: 'sidecar/ss-completion', checkerModel: 'sidecar/ss-completion' });
    expect(estimateCost(100, s, {})).toBe(0);
    expect(buildIsFree(s)).toBe(true);
    expect(buildIsFree(sanitizeCardSettings({ writerModel: 'sidecar/ss-completion' }))).toBe(false);
  });
});

describe('thinking-model output parsing', () => {
  it('strips think blocks, including a lone closing tag', () => {
    expect(stripThink('<think>plan {"a":1}</think>\nanswer')).toBe('answer');
    expect(stripThink('reasoning…</think>answer')).toBe('answer');
    expect(stripThink('answer<think>cut off')).toBe('answer');
  });
  it('finds the card JSON after think text with example objects', () => {
    const reply = '<think>Format is {"summary": "...", "claims": []}. Let me write it.</think>\nHere is the card:\n```json\n{"summary":"Adds two numbers","claims":[{"text":"returns a+b","file":"a.fan","line":3}]}\n```\nDone.';
    const j = parseJsonReply(reply, ['summary', 'claims']);
    expect(j.summary).toBe('Adds two numbers');
    expect(j.claims[0].line).toBe(3);
  });
  it('picks the object with the expected key and handles braces inside strings', () => {
    const reply = 'Note {"x":1} then {"claims":[{"i":0,"ok":true,"why":"has } brace"}],"confidence":0.9} end';
    const j = parseJsonReply(reply, ['confidence', 'claims']);
    expect(j.confidence).toBe(0.9);
    expect(j.claims[0].why).toBe('has } brace');
  });
  it('still parses plain JSON and fenced JSON', () => {
    expect(parseJsonReply('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonReply('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(parseJsonReply('no json')).toBeNull();
  });
});
