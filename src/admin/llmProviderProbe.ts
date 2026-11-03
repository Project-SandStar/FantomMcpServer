/**
 * One cheap live round trip per provider, on demand from the LLM Providers
 * page ("Test" / "Test all").
 *
 * Why: a bad or missing key only showed up as a footnote on the next ask
 * ("requested provider 'openrouter' was unavailable; answered via sidecar")
 * or as a 0.3 s RLM stage with zero questions. Both read as "the model found
 * nothing" when the truth was "the call never got through". This answers
 * "does this key and this route work right now" in one click, with the
 * provider's own error text when it does not.
 *
 * Each probe uses the SAVED key (process.env, loaded from the secrets store
 * or the env file), the same one the ask path uses. A key pasted into the
 * page but not saved is not tested. The request is the smallest the
 * provider accepts: one short message, a handful of output tokens.
 *
 * The `rlm` target is different: it does not test a key, it tests the RLM
 * sandbox model as the loop would resolve it (local ss-rlm, a provider-direct
 * model, or the sidecar's OpenRouter route). That is the one the operator
 * actually wants to know about when they switch the model.
 */
import { JEV_ENDPOINT, JEV_DEFAULT_MODEL } from '../embedding/providers/jevClient.js';
import type { RlmEndpoint } from '../embedding/rlmToolLoop.js';

export type ProbeTarget = 'groq' | 'anthropic' | 'gemini' | 'typesafe' | 'rlm';
export const PROBE_TARGETS: readonly ProbeTarget[] = ['groq', 'anthropic', 'gemini', 'typesafe', 'rlm'];

export interface ProbeResult {
  target: ProbeTarget;
  ok: boolean;
  /** Round trip as measured here. */
  ms: number;
  /** The model asked for. Null when the probe did not get as far as a request. */
  model: string | null;
  /** The model the server says it used, when it reports one and it differs. */
  servedModel?: string | null;
  /** Where the request went, so a pass on the wrong route is visible. */
  route: string;
  /** Short human text: the reply on success, the provider's error on failure. */
  message: string;
  status?: number;
}

export type ProbeFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ProbeOptions {
  fetchImpl?: ProbeFetch;
  timeoutMs?: number;
  /** Model to ask for; the defaults below match the rerank path. */
  model?: string;
  env?: NodeJS.ProcessEnv;
  /** `rlm` only: how the loop resolves its endpoint. Injectable for tests. */
  resolveRlm?: () => Promise<RlmEndpoint | null>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const PING_SYSTEM = 'Reply with the single word OK.';
const PING_USER = 'ping';
const PING_MAX_TOKENS = 16;

/** Same defaults as the rerank path (src/embedding/llmReranker.ts). */
const DEFAULT_MODELS: Record<'groq' | 'anthropic' | 'gemini', string> = {
  groq: 'llama-3.3-70b-versatile',
  anthropic: 'claude-sonnet-5-5',
  gemini: 'gemini-3.8-flash',
};

const KEY_ENV: Record<Exclude<ProbeTarget, 'rlm'>, string> = {
  groq: 'GROQ_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  typesafe: 'TYPESAFE_API_KEY',
};

function clip(s: string, n = 300): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** Keys never go into a result: Gemini carries its key in the URL. */
function stripKey(url: string): string {
  return url.replace(/([?&]key=)[^&]+/, '$1…');
}

async function timedFetch(
  url: string,
  init: RequestInit,
  opts: ProbeOptions,
): Promise<{ res: Response | null; ms: number; error?: string }> {
  const doFetch: ProbeFetch = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const ac = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => ac.abort(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await doFetch(url, { ...init, signal: ac.signal });
    return { res, ms: Date.now() - t0 };
  } catch (err) {
    const e = err as Error & { cause?: { message?: string } };
    return { res: null, ms: Date.now() - t0, error: e.cause?.message ?? e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Turn a response into a result: a non-2xx carries the provider's own text. */
async function finish(
  target: ProbeTarget,
  model: string | null,
  route: string,
  r: { res: Response | null; ms: number; error?: string },
  parse: (json: any) => { text: string; servedModel?: string | null },
): Promise<ProbeResult> {
  if (!r.res) return { target, ok: false, ms: r.ms, model, route, message: r.error ?? 'request failed' };
  if (!r.res.ok) {
    const body = await r.res.text().catch(() => '');
    let detail = body;
    try {
      const j = JSON.parse(body);
      detail = j?.error?.message ?? j?.message ?? j?.detail ?? body;
    } catch { /* plain text */ }
    return { target, ok: false, ms: r.ms, model, route, status: r.res.status, message: `HTTP ${r.res.status}: ${clip(String(detail))}` };
  }
  let json: any;
  try {
    json = await r.res.json();
  } catch (err) {
    return { target, ok: false, ms: r.ms, model, route, status: r.res.status, message: `bad JSON: ${(err as Error).message}` };
  }
  const { text, servedModel } = parse(json);
  const served = servedModel && servedModel !== model ? servedModel : undefined;
  return {
    target, ok: true, ms: r.ms, model, route, status: r.res.status,
    ...(served ? { servedModel: served } : {}),
    message: text.trim() ? `replied "${clip(text, 60)}"` : 'replied with no text',
  };
}

function noKey(target: ProbeTarget, model: string | null, route: string, envName: string): ProbeResult {
  return { target, ok: false, ms: 0, model, route, message: `${envName} is not set — paste the key above and save first` };
}

async function probeGroq(opts: ProbeOptions): Promise<ProbeResult> {
  const env = opts.env ?? process.env;
  const model = opts.model || DEFAULT_MODELS.groq;
  const route = 'api.groq.com';
  const key = env[KEY_ENV.groq];
  if (!key) return noKey('groq', model, route, KEY_ENV.groq);
  const r = await timedFetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model, max_tokens: PING_MAX_TOKENS, temperature: 0,
      messages: [{ role: 'system', content: PING_SYSTEM }, { role: 'user', content: PING_USER }],
    }),
  }, opts);
  return finish('groq', model, route, r, (j) => ({ text: j?.choices?.[0]?.message?.content ?? '', servedModel: j?.model }));
}

async function probeAnthropic(opts: ProbeOptions): Promise<ProbeResult> {
  const env = opts.env ?? process.env;
  const model = opts.model || DEFAULT_MODELS.anthropic;
  const route = 'api.anthropic.com';
  const key = env[KEY_ENV.anthropic];
  if (!key) return noKey('anthropic', model, route, KEY_ENV.anthropic);
  const r = await timedFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model, max_tokens: PING_MAX_TOKENS, system: PING_SYSTEM,
      messages: [{ role: 'user', content: PING_USER }],
    }),
  }, opts);
  return finish('anthropic', model, route, r, (j) => ({
    text: Array.isArray(j?.content) ? j.content.map((p: any) => p?.text ?? '').join('') : '',
    servedModel: j?.model,
  }));
}

async function probeGemini(opts: ProbeOptions): Promise<ProbeResult> {
  const env = opts.env ?? process.env;
  const model = opts.model || DEFAULT_MODELS.gemini;
  const route = 'generativelanguage.googleapis.com';
  const key = env[KEY_ENV.gemini];
  if (!key) return noKey('gemini', model, route, KEY_ENV.gemini);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const r = await timedFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: PING_SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: PING_USER }] }],
      generationConfig: { temperature: 0, maxOutputTokens: PING_MAX_TOKENS },
    }),
  }, opts);
  const out = await finish('gemini', model, route, r, (j) => ({
    text: j?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? '').join('') ?? '',
    servedModel: j?.modelVersion,
  }));
  out.message = stripKey(out.message);
  return out;
}

async function probeTypesafe(opts: ProbeOptions): Promise<ProbeResult> {
  const env = opts.env ?? process.env;
  const model = opts.model || JEV_DEFAULT_MODEL;
  const route = new URL(JEV_ENDPOINT).host;
  const key = env[KEY_ENV.typesafe];
  if (!key) return noKey('typesafe', model, route, KEY_ENV.typesafe);
  const r = await timedFetch(JEV_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      state: { probe: true, note: 'connectivity test from the LLM Providers page' },
      model,
      questions: { ping: { type: 'noul', instructions: 'Is this a connectivity probe?' } },
    }),
  }, opts);
  const out = await finish('typesafe', model, route, r, (j) => {
    const a = j?.answers?.ping;
    const p = typeof a?.noul === 'number' ? a.noul : typeof a?.probability === 'number' ? a.probability : null;
    return { text: p === null ? '' : `noul=${p.toFixed(2)}`, servedModel: j?.model };
  });
  if (out.ok && out.message === 'replied with no text') {
    out.ok = false;
    out.message = 'reply had no answers — not a Jev endpoint, or the model name is wrong';
  }
  return out;
}

/**
 * The RLM sandbox model, resolved exactly as the loop resolves it. A null
 * endpoint is the "RLM silently off" case, so the message names what to check.
 */
async function probeRlm(opts: ProbeOptions): Promise<ProbeResult> {
  const { resolveRlmEndpoint, noReasoning } = await import('../embedding/rlmToolLoop.js');
  const resolve = opts.resolveRlm ?? (() => resolveRlmEndpoint());
  let ep: RlmEndpoint | null;
  try {
    ep = await resolve();
  } catch (err) {
    return { target: 'rlm', ok: false, ms: 0, model: null, route: 'not resolved', message: `resolver threw: ${(err as Error).message}` };
  }
  if (!ep) {
    return {
      target: 'rlm', ok: false, ms: 0, model: null, route: 'not resolved',
      message: 'no RLM endpoint: the loop would skip RLM. Check the rlm policy and sandbox model on the OpenRouter page, '
        + 'the provider key for a direct: model, and the server log for the [RLM] line.',
    };
  }
  const route = ep.direct
    ? `${ep.direct} direct API`
    : ep.sandbox
      ? `sidecar OpenRouter route ${ep.base}`
      : `local ss-rlm ${ep.base}`;
  const url = ep.chatUrl ?? `${ep.base}/v1/chat/completions`;
  const r = await timedFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ep.authHeader },
    body: JSON.stringify({
      model: ep.model, stream: false, max_tokens: PING_MAX_TOKENS,
      messages: [{ role: 'system', content: PING_SYSTEM }, { role: 'user', content: PING_USER }],
      ...noReasoning(ep),
    }),
  }, opts);
  return finish('rlm', ep.model, route, r, (j) => ({ text: j?.choices?.[0]?.message?.content ?? '', servedModel: j?.model }));
}

export async function probeProvider(target: ProbeTarget, opts: ProbeOptions = {}): Promise<ProbeResult> {
  switch (target) {
    case 'groq': return probeGroq(opts);
    case 'anthropic': return probeAnthropic(opts);
    case 'gemini': return probeGemini(opts);
    case 'typesafe': return probeTypesafe(opts);
    case 'rlm': return probeRlm(opts);
  }
}

export function isProbeTarget(s: unknown): s is ProbeTarget {
  return typeof s === 'string' && (PROBE_TARGETS as readonly string[]).includes(s);
}
