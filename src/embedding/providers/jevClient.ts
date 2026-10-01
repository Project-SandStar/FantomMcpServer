/**
 * TypeSafe Jev — one small typed judgment per call, used to ROUTE work, never
 * to answer it. `POST https://api.typesafe.ai/v1/systemone` with a `state` and
 * a map of questions (choice / noul / score) returns one answer per question
 * with probabilities and a confidence. ~100–300 ms, fractions of a cent.
 *
 * Settings: `llmProviders.typesafe` (enabled, model; key in `TYPESAFE_API_KEY`)
 * from the LLM Providers page, plus `semanticSearch.jev.minConfidence` and
 * `semanticSearch.jev.timeoutMs` (runtime config, no restart).
 *
 * Every call is advisory. `jevAsk` returns null on any failure — no key, a
 * timeout, a 4xx/5xx, a malformed body — and the caller keeps today's
 * behaviour. It never throws into the search path.
 */
import { loadConfig } from '../../config/index.js';
import { readRuntimeSemantic } from './embeddingProvider.js';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_DEFAULT_MODEL = 'jev-latest';
const DEFAULT_TIMEOUT_MS = 4_000;
const DEFAULT_MIN_CONFIDENCE = 0.7;

export type JevQuestion =
  | { type: 'choice'; instructions: unknown; criteria: Record<string, unknown> }
  | { type: 'noul'; instructions: unknown }
  /** Score criteria are a LIST (best first); the answer's `score` is an index into it. An object is a 422. */
  | { type: 'score'; instructions: unknown; criteria: unknown[] };

export interface JevChoiceAnswer { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
/** The API returns the yes-probability under `noul` (jev-1.13.0, verified 2026-09-29). */
export interface JevNoulAnswer { type: 'noul'; noul: number; probability?: number }
export interface JevScoreAnswer { type: 'score'; score?: number; confidence: number; probabilities?: Record<string, number> }
export type JevAnswer = JevChoiceAnswer | JevNoulAnswer | JevScoreAnswer;

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
  /** Round trip as measured here. */
  ms: number;
}

export interface JevSettings {
  enabled: boolean;
  hasKey: boolean;
  model: string;
  minConfidence: number;
  timeoutMs: number;
}

export function getJevSettings(): JevSettings {
  let enabled = false;
  let model = JEV_DEFAULT_MODEL;
  try {
    const ts = (loadConfig() as { llmProviders?: { typesafe?: { enabled?: boolean; model?: string } } }).llmProviders?.typesafe;
    enabled = ts?.enabled === true;
    if (typeof ts?.model === 'string' && ts.model.trim()) model = ts.model.trim();
  } catch { /* unreadable config = off */ }
  const rt = readRuntimeSemantic()?.jev ?? {};
  const minConfidence = Number(rt.minConfidence);
  const timeoutMs = Number(rt.timeoutMs);
  return {
    enabled,
    hasKey: !!process.env.TYPESAFE_API_KEY,
    model,
    minConfidence: Number.isFinite(minConfidence) && minConfidence >= 0 && minConfidence <= 1 ? minConfidence : DEFAULT_MIN_CONFIDENCE,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 500 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  };
}

/** Enabled on the settings page AND a key is present. */
export function jevAvailable(): boolean {
  const s = getJevSettings();
  return s.enabled && s.hasKey;
}

/** Injectable transport, for tests. */
export type JevFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * One request, all questions in parallel on the server side. Null on any
 * failure; the reason goes to the log once per call so a dead key is
 * visible without failing anything.
 */
export async function jevAsk(
  state: unknown,
  questions: Record<string, JevQuestion>,
  opts: { timeoutMs?: number; fetchImpl?: JevFetch; model?: string } = {},
): Promise<JevResponse | null> {
  const settings = getJevSettings();
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) return null;
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('jev timeout')), opts.timeoutMs ?? settings.timeoutMs);
  try {
    const doFetch: JevFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>);
    const res = await doFetch(JEV_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ state, model: opts.model ?? settings.model, questions }),
      signal: ac.signal,
    });
    if (!res.ok) {
      console.warn(`[jev] HTTP ${res.status} — falling back to the default route`);
      return null;
    }
    const body = await res.json() as { model?: string; answers?: Record<string, JevAnswer>; usage?: JevResponse['usage'] };
    if (!body || typeof body !== 'object' || !body.answers || typeof body.answers !== 'object') {
      console.warn('[jev] malformed body (no answers) — falling back to the default route');
      return null;
    }
    return { model: String(body.model ?? settings.model), answers: body.answers, usage: body.usage, ms: Date.now() - t0 };
  } catch (err) {
    console.warn(`[jev] ${(err as Error).message} after ${Date.now() - t0}ms — falling back to the default route`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
