/**
 * Cloudflare Clef — a System One decision model served by OpenRouter. Same
 * request and answer shape as TypeSafe Jev, so the gates in jevGates.ts can
 * use either one (see decisionModel.ts).
 *
 * `POST https://openrouter.ai/api/alpha/decisions`, Bearer = the OpenRouter
 * key (`FANTOM_OPENROUTER_API_KEY`). Body `{ model, state, questions }`; the
 * reply is `{ id, model, provider, answers, usage }`. Clef does not accept
 * /chat/completions.
 *
 * Note: Workers AI reads only about the first 2K tokens of a text state.
 *
 * Like jevAsk, `clefAsk` returns null on any failure and never throws. The
 * key never goes into a log line or an error message.
 */
import type { JevAnswer, JevFetch, JevQuestion, JevResponse } from './jevClient.js';

export const CLEF_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
export const CLEF_MODELS = ['cloudflare/clef', 'cloudflare/clef-flash'] as const;
export const CLEF_DEFAULT_MODEL = 'cloudflare/clef';
const DEFAULT_TIMEOUT_MS = 4_000;

export function clefKey(): string | undefined {
  const k = process.env.FANTOM_OPENROUTER_API_KEY?.trim();
  return k ? k : undefined;
}

/** Accepts 'clef', 'clef-flash' or the full 'cloudflare/…' id. */
export function normalizeClefModel(model: unknown): string | null {
  if (typeof model !== 'string') return null;
  const m = model.trim();
  if (!m) return null;
  const full = m.includes('/') ? m : `cloudflare/${m}`;
  return /^[a-z0-9._-]+\/[a-z0-9._:-]+$/i.test(full) ? full : null;
}

/** Remove the key from any text that leaves this module. */
export function scrubKey(text: string, key = clefKey()): string {
  let out = text;
  if (key) out = out.split(key).join('[redacted]');
  return out.replace(/sk-or-[A-Za-z0-9_-]{8,}/g, '[redacted]');
}

export type ClefResult =
  | { ok: true; res: JevResponse; provider?: string }
  | { ok: false; error: string; status?: number; ms: number };

/**
 * One call with a reason on failure. `clefAsk` wraps it to null; the test
 * route uses it to show why a call failed.
 */
export async function clefAskDetailed(
  state: unknown,
  questions: Record<string, JevQuestion>,
  opts: { timeoutMs?: number; fetchImpl?: JevFetch; model?: string } = {},
): Promise<ClefResult> {
  const t0 = Date.now();
  const key = clefKey();
  if (!key) return { ok: false, error: 'no OpenRouter key (FANTOM_OPENROUTER_API_KEY)', ms: 0 };
  const model = normalizeClefModel(opts.model) ?? CLEF_DEFAULT_MODEL;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('clef timeout')), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const doFetch: JevFetch = opts.fetchImpl ?? (async (url, init) => (await import('../../openrouter/http.js')).orFetch(url, init as any) as unknown as ReturnType<JevFetch>);
    const res = await doFetch(CLEF_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'X-Title': 'FantomMcpServer',
      },
      body: JSON.stringify({ model, state, questions }),
      signal: ac.signal,
    });
    let body: unknown = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      const msg = (body as { error?: { message?: unknown } } | null)?.error?.message;
      const detail = typeof msg === 'string' ? `: ${msg.slice(0, 200)}` : '';
      return { ok: false, status: res.status, error: scrubKey(`HTTP ${res.status}${detail}`, key), ms: Date.now() - t0 };
    }
    const b = body as { model?: string; provider?: string; answers?: Record<string, JevAnswer>; usage?: JevResponse['usage'] } | null;
    if (!b || typeof b !== 'object' || !b.answers || typeof b.answers !== 'object') {
      return { ok: false, error: 'malformed body (no answers)', ms: Date.now() - t0 };
    }
    return {
      ok: true,
      provider: typeof b.provider === 'string' ? b.provider : undefined,
      res: { model: String(b.model ?? model), answers: b.answers, usage: b.usage, ms: Date.now() - t0 },
    };
  } catch (err) {
    const aborted = ac.signal.aborted;
    const msg = aborted ? 'timeout' : (err as Error)?.message ?? String(err);
    return { ok: false, error: scrubKey(msg, key), ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

/** Same contract as jevAsk: null on any failure, one log line with the reason. */
export async function clefAsk(
  state: unknown,
  questions: Record<string, JevQuestion>,
  opts: { timeoutMs?: number; fetchImpl?: JevFetch; model?: string } = {},
): Promise<JevResponse | null> {
  const r = await clefAskDetailed(state, questions, opts);
  if (r.ok) return r.res;
  if (r.ms > 0 || r.status) console.warn(`[clef] ${r.error} after ${r.ms}ms — falling back to the default route`);
  return null;
}
