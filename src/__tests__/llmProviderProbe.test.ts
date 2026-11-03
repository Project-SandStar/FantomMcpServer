/**
 * The LLM Providers "Test" probes. Each pins one thing the page relies on:
 * a missing key fails before any request, a provider error carries the
 * provider's own text, a pass reports the model and the route, Gemini's key
 * never leaks into a message, and the rlm target reports "would skip" when
 * the loop resolves no endpoint.
 */
import { describe, it, expect } from '@jest/globals';
import { probeProvider, isProbeTarget, PROBE_TARGETS, type ProbeFetch } from '../admin/llmProviderProbe.js';

function reply(status: number, body: unknown): ProbeFetch {
  return async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('llmProviderProbe', () => {
  it('lists the five targets and validates names', () => {
    expect([...PROBE_TARGETS]).toEqual(['groq', 'anthropic', 'gemini', 'typesafe', 'rlm']);
    expect(isProbeTarget('gemini')).toBe(true);
    expect(isProbeTarget('openai')).toBe(false);
  });

  it('fails without a request when the key is missing', async () => {
    let called = false;
    const fetchImpl: ProbeFetch = async () => { called = true; return new Response('{}'); };
    const r = await probeProvider('groq', { env: {}, fetchImpl });
    expect(called).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('GROQ_API_KEY');
  });

  it('reports a pass with model and route for an OpenAI-style reply', async () => {
    const r = await probeProvider('groq', {
      env: { GROQ_API_KEY: 'k' },
      fetchImpl: reply(200, { model: 'llama-3.3-70b-versatile', choices: [{ message: { content: 'OK' } }] }),
    });
    expect(r.ok).toBe(true);
    expect(r.model).toBe('llama-3.3-70b-versatile');
    expect(r.route).toBe('api.groq.com');
    expect(r.message).toContain('OK');
  });

  it("carries the provider's own error text on a non-2xx", async () => {
    const r = await probeProvider('anthropic', {
      env: { ANTHROPIC_API_KEY: 'bad' },
      fetchImpl: reply(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.message).toBe('HTTP 401: invalid x-api-key');
  });

  it('never puts the Gemini key in the message', async () => {
    const r = await probeProvider('gemini', {
      env: { GEMINI_API_KEY: 'SECRET123' },
      fetchImpl: async (url) => new Response(`not found: ${url}`, { status: 404 }),
    });
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain('SECRET123');
  });

  it('names the served model when it differs from the one asked for', async () => {
    const r = await probeProvider('gemini', {
      env: { GEMINI_API_KEY: 'k' },
      fetchImpl: reply(200, { modelVersion: 'gemini-3.8-flash-001', candidates: [{ content: { parts: [{ text: 'OK' }] } }] }),
    });
    expect(r.ok).toBe(true);
    expect(r.servedModel).toBe('gemini-3.8-flash-001');
  });

  it('reads a Jev noul answer and rejects a reply without answers', async () => {
    const ok = await probeProvider('typesafe', { env: { TYPESAFE_API_KEY: 'k' }, fetchImpl: reply(200, { model: 'jev-latest', answers: { ping: { type: 'noul', noul: 0.97 } } }) });
    expect(ok.ok).toBe(true);
    expect(ok.message).toContain('noul=0.97');
    const bad = await probeProvider('typesafe', { env: { TYPESAFE_API_KEY: 'k' }, fetchImpl: reply(200, { hello: 'world' }) });
    expect(bad.ok).toBe(false);
  });

  it('reports a timeout as a failure, not a throw', async () => {
    const fetchImpl: ProbeFetch = (_u, init) => new Promise((_res, rej) => {
      init.signal?.addEventListener('abort', () => rej(init.signal?.reason ?? new Error('aborted')));
    });
    const r = await probeProvider('groq', { env: { GROQ_API_KEY: 'k' }, fetchImpl, timeoutMs: 20 });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('timeout');
  });

  it('rlm: says the loop would skip when no endpoint resolves', async () => {
    const r = await probeProvider('rlm', { resolveRlm: async () => null });
    expect(r.ok).toBe(false);
    expect(r.route).toBe('not resolved');
    expect(r.message).toContain('skip RLM');
  });

  it('rlm: probes a resolved direct endpoint with its own chat URL and auth', async () => {
    let seen: { url: string; auth?: string; body: any } | null = null;
    const fetchImpl: ProbeFetch = async (url, init) => {
      seen = { url, auth: (init.headers as Record<string, string>).Authorization, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ model: 'gemini-3.8-flash', choices: [{ message: { content: 'OK' } }] }), { status: 200 });
    };
    const r = await probeProvider('rlm', {
      fetchImpl,
      resolveRlm: async () => ({
        base: 'https://generativelanguage.googleapis.com/v1beta/openai',
        chatUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        direct: 'gemini', model: 'gemini-3.8-flash', authHeader: { Authorization: 'Bearer g' },
      }),
    });
    expect(r.ok).toBe(true);
    expect(r.route).toBe('gemini direct API');
    expect(seen!.url).toMatch(/openai\/chat\/completions$/);
    expect(seen!.auth).toBe('Bearer g');
    expect(seen!.body.reasoning_effort).toBe('none');
  });
});
