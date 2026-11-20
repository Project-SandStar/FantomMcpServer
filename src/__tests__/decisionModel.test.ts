/**
 * Decision model: Clef request shape, answer mapping, failure mapping, key
 * never in an error, and Jev/Clef selection. Fetch is stubbed; the config is
 * a temp file. Nothing here reaches the network.
 */
import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { clefAsk, clefAskDetailed, CLEF_ENDPOINT, normalizeClefModel } from '../embedding/providers/clefClient.js';
import { JEV_ENDPOINT, type JevFetch } from '../embedding/providers/jevClient.js';
import {
  decisionAsk,
  getDecisionModelSettings,
  getDecisionSettings,
  saveDecisionModelSettings,
  setDecisionModelConfigPathForTests,
  testDecisionModel,
} from '../embedding/providers/decisionModel.js';
import { decideAskRoute } from '../embedding/jevGates.js';

const KEY = 'sk-or-v1-TESTKEY0-12345678-9abcdef';
const JEV_KEY = 'ts-test-key-123';

type Call = { url: string; headers: Record<string, string>; body: any };
const stub = (status: number, body: unknown, calls: Call[] = []): JevFetch =>
  async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };

const CLEF_REPLY = {
  id: 'gen-dec-1',
  model: 'cloudflare/clef-flash',
  provider: 'Cloudflare',
  answers: {
    route: { type: 'choice', choice: 'direct', confidence: 0.9, probabilities: { direct: 0.92, rlm: 0.08 } },
    identifier: { type: 'noul', noul: 0.81 },
  },
  usage: { input_tokens: 120, output_tokens: 10, cost: 0.00002 },
};

let dir: string;
let cfg: string;
const saved = { or: process.env.FANTOM_OPENROUTER_API_KEY, ts: process.env.TYPESAFE_API_KEY };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-model-'));
  cfg = path.join(dir, 'config.json');
  setDecisionModelConfigPathForTests(cfg);
  process.env.FANTOM_OPENROUTER_API_KEY = KEY;
  process.env.TYPESAFE_API_KEY = JEV_KEY;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  setDecisionModelConfigPathForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

afterAll(() => {
  if (saved.or === undefined) delete process.env.FANTOM_OPENROUTER_API_KEY; else process.env.FANTOM_OPENROUTER_API_KEY = saved.or;
  if (saved.ts === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = saved.ts;
});

describe('clefAsk', () => {
  it('posts { model, state, questions } to the OpenRouter decisions endpoint with the Bearer key', async () => {
    const calls: Call[] = [];
    const q = { route: { type: 'choice' as const, instructions: 'pick', criteria: { direct: 'a', rlm: 'b' } } };
    await clefAsk({ question: 'x' }, q, { fetchImpl: stub(200, CLEF_REPLY, calls), model: 'clef-flash' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(CLEF_ENDPOINT);
    expect(calls[0].url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(calls[0].headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].body).toEqual({ model: 'cloudflare/clef-flash', state: { question: 'x' }, questions: q });
  });

  it('maps the reply to the Jev response shape', async () => {
    const r = await clefAsk('s', {}, { fetchImpl: stub(200, CLEF_REPLY) });
    expect(r).toMatchObject({ model: 'cloudflare/clef-flash', answers: CLEF_REPLY.answers, usage: CLEF_REPLY.usage });
    expect(typeof r?.ms).toBe('number');
  });

  it('is null on HTTP error, malformed body, or no key', async () => {
    expect(await clefAsk('s', {}, { fetchImpl: stub(400, { error: { code: 400, message: 'Invalid request parameters' } }) })).toBeNull();
    expect(await clefAsk('s', {}, { fetchImpl: stub(200, { nope: true }) })).toBeNull();
    delete process.env.FANTOM_OPENROUTER_API_KEY;
    const calls: Call[] = [];
    expect(await clefAsk('s', {}, { fetchImpl: stub(200, CLEF_REPLY, calls) })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('reports a timeout', async () => {
    const hang: JevFetch = (_u, init) => new Promise((_res, rej) => {
      init.signal.addEventListener('abort', () => rej(new Error('aborted')));
    });
    const r = await clefAskDetailed('s', {}, { fetchImpl: hang, timeoutMs: 20 });
    expect(r).toMatchObject({ ok: false, error: 'timeout' });
  });

  it('never puts the key in an error', async () => {
    const leaky: JevFetch = async () => { throw new Error(`connect failed for Bearer ${KEY}`); };
    const r = await clefAskDetailed('s', {}, { fetchImpl: leaky });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(KEY);
    const r2 = await clefAskDetailed('s', {}, { fetchImpl: stub(401, { error: { message: `bad key ${KEY}` } }) });
    expect(r2).toMatchObject({ ok: false, status: 401 });
    expect(JSON.stringify(r2)).not.toContain(KEY);
    const t = await testDecisionModel('clef', { fetchImpl: leaky });
    expect(JSON.stringify(t)).not.toContain(KEY);
    const logged = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join(' ');
    expect(logged).not.toContain(KEY);
  });

  it('normalizes model ids', () => {
    expect(normalizeClefModel('clef')).toBe('cloudflare/clef');
    expect(normalizeClefModel('cloudflare/clef-flash')).toBe('cloudflare/clef-flash');
    expect(normalizeClefModel('')).toBeNull();
  });
});

describe('decision model selection', () => {
  it('defaults to jev with no setting', async () => {
    expect(getDecisionModelSettings()).toEqual({ provider: 'jev', clefModel: 'cloudflare/clef' });
    expect(getDecisionSettings().provider).toBe('jev');
    const calls: Call[] = [];
    await decisionAsk('s', {}, { fetchImpl: stub(200, { model: 'jev', answers: {} }, calls) });
    expect(calls[0].url).toBe(JEV_ENDPOINT);
    expect(calls[0].headers.Authorization).toBe(`Bearer ${JEV_KEY}`);
  });

  it('falls back to jev on a bad saved value', () => {
    fs.writeFileSync(cfg, JSON.stringify({ semanticSearch: { decisionModel: { provider: 'gpt', clefModel: 42 } } }));
    expect(getDecisionModelSettings()).toEqual({ provider: 'jev', clefModel: 'cloudflare/clef' });
  });

  it('routes to clef when selected, with the saved model', async () => {
    saveDecisionModelSettings({ provider: 'clef', clefModel: 'clef-flash' });
    const s = getDecisionSettings();
    expect(s).toMatchObject({ provider: 'clef', enabled: true, hasKey: true, model: 'cloudflare/clef-flash' });
    const calls: Call[] = [];
    await decisionAsk('s', {}, { fetchImpl: stub(200, CLEF_REPLY, calls) });
    expect(calls[0].url).toBe(CLEF_ENDPOINT);
    expect(calls[0].body.model).toBe('cloudflare/clef-flash');
  });

  it('runs the ask gate through clef', async () => {
    saveDecisionModelSettings({ provider: 'clef' });
    const calls: Call[] = [];
    const d = await decideAskRoute({ question: 'where is Ext.onStart defined?', hits: [] }, { fetchImpl: stub(200, CLEF_REPLY, calls) });
    expect(calls[0].url).toBe(CLEF_ENDPOINT);
    expect(d).toMatchObject({ route: 'direct', model: 'cloudflare/clef-flash' });
  });

  it('clef without a key is not ready', () => {
    saveDecisionModelSettings({ provider: 'clef' });
    delete process.env.FANTOM_OPENROUTER_API_KEY;
    expect(getDecisionSettings()).toMatchObject({ hasKey: false, whyNot: 'no OpenRouter key' });
  });

  it('save keeps other config keys and validates input', () => {
    fs.writeFileSync(cfg, JSON.stringify({ other: 1, semanticSearch: { jev: { minConfidence: 0.8 } } }));
    saveDecisionModelSettings({ provider: 'clef', clefModel: 'cloudflare/clef-flash' });
    const file = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
    expect(file.other).toBe(1);
    expect(file.semanticSearch.jev).toEqual({ minConfidence: 0.8 });
    expect(file.semanticSearch.decisionModel).toEqual({ provider: 'clef', clefModel: 'cloudflare/clef-flash' });
    expect(() => saveDecisionModelSettings({ provider: 'gpt' })).toThrow(/provider/);
    expect(() => saveDecisionModelSettings({ clefModel: 'openai/gpt-5' })).toThrow(/clefModel/);
    expect(() => saveDecisionModelSettings('x')).toThrow();
  });
});

describe('testDecisionModel', () => {
  it('returns ok with the yes-probability for clef', async () => {
    const reply = { model: 'cloudflare/clef', answers: { ok: { type: 'noul', noul: 0.97 } } };
    const calls: Call[] = [];
    const r = await testDecisionModel('clef', { fetchImpl: stub(200, reply, calls) });
    expect(r).toMatchObject({ ok: true, provider: 'clef', model: 'cloudflare/clef', answer: 0.97 });
    expect(calls[0].body.questions.ok.type).toBe('noul');
  });

  it('tests the provider passed, not the saved one', async () => {
    saveDecisionModelSettings({ provider: 'clef' });
    const calls: Call[] = [];
    const r = await testDecisionModel('jev', { fetchImpl: stub(200, { model: 'jev-1.13', answers: { ok: { type: 'noul', noul: 0.9 } } }, calls) });
    expect(calls[0].url).toBe(JEV_ENDPOINT);
    expect(r).toMatchObject({ ok: true, provider: 'jev', answer: 0.9 });
  });

  it('reports errors', async () => {
    const r = await testDecisionModel('clef', { fetchImpl: stub(400, { error: { message: 'Invalid request parameters' } }) });
    expect(r).toMatchObject({ ok: false, provider: 'clef', error: 'HTTP 400: Invalid request parameters' });
    delete process.env.TYPESAFE_API_KEY;
    expect(await testDecisionModel('jev')).toMatchObject({ ok: false, error: 'no TYPESAFE_API_KEY' });
  });
});
