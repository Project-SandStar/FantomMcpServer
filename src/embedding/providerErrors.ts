/**
 * Tell a provider that is OUT OF CREDITS apart from one that is only busy.
 *
 * Gemini answers 429 RESOURCE_EXHAUSTED for both a short rate limit and an
 * exhausted quota or billing account. Before this, both read as
 * "Gemini HTTP 429: {" in the log and the ask fell back to OpenRouter in
 * silence, so nobody learned the account had no credits (2026-11-03).
 *
 * The kind comes from the status AND the body: quota/billing text, or a
 * QuotaFailure whose quota id is per-day or per-project, means credits; a
 * short retryDelay with a per-minute quota means "try again soon".
 */

export type ProviderErrorKind = 'quota-exhausted' | 'rate-limited' | 'auth-invalid' | 'other';

/** Kinds that will fail again on the next call: stop using that provider for a while. */
export function isHardKind(k: ProviderErrorKind): boolean {
  return k === 'quota-exhausted' || k === 'auth-invalid';
}

export interface ProviderWarning {
  kind: 'provider-quota-exhausted' | 'provider-rate-limited' | 'provider-auth-invalid' | 'provider-failed';
  provider: string;
  message: string;
  /** HTTP status the provider returned, when known. */
  status?: number;
  /** Short cause for a plain failure, e.g. "bad model ID". */
  reason?: string;
}

/** An HTTP failure from a provider's own API, already classified. */
export class ProviderHttpError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly body: string;
  readonly kind: ProviderErrorKind;
  constructor(provider: string, status: number, body: string) {
    super(`${providerLabel(provider)} HTTP ${status}: ${body}`);
    this.name = 'ProviderHttpError';
    this.provider = provider;
    this.status = status;
    this.body = body;
    this.kind = classifyProviderError(status, body);
  }
}

/** A rejected key. Gemini answers 400 API_KEY_INVALID, not 401. */
const AUTH_TEXT = [
  /API_KEY_INVALID/,
  /API key not valid/i,
  /invalid[ _-]?x-api-key/i,
  /authentication_error/i,
  /invalid (api )?key/i,
  /incorrect api key/i,
  /no auth credentials/i,
];

const QUOTA_TEXT = [
  /exceeded your current quota/i,
  /\bbilling\b/i,
  /\bcredits?\b/i,
  /credit balance/i,
  /prepayment/i,
  /insufficient[_ ](quota|funds|balance)/i,
  /payment required/i,
  /out of (credits|tokens|funds)/i,
  /spend(ing)? limit/i,
];

/** Gemini quota ids that mean a long window, not a per-minute burst. */
const LONG_QUOTA_ID = /PerDay|per_day|daily/i;
const SHORT_QUOTA_ID = /PerMinute|per_minute|PerSecond/i;

export function classifyProviderError(status: number, body: string): ProviderErrorKind {
  const text = body ?? '';
  if (status === 401 || status === 403) {
    // 403 with billing text is a disabled billing account, not a bad key.
    if (status === 403 && QUOTA_TEXT.some(r => r.test(text))) return 'quota-exhausted';
    return 'auth-invalid';
  }
  if (status === 400 && AUTH_TEXT.some(r => r.test(text))) return 'auth-invalid';
  if (status === 402) return 'quota-exhausted';
  if (status === 429 || /RESOURCE_EXHAUSTED/.test(text)) {
    if (QUOTA_TEXT.some(r => r.test(text))) {
      // "exceeded your current quota" plus a per-minute quota id is a rate
      // limit Google words like a quota; per-day or no window means credits.
      const ids = [...text.matchAll(/"quotaId"\s*:\s*"([^"]+)"/g)].map(m => m[1]);
      if (ids.length > 0 && ids.every(id => SHORT_QUOTA_ID.test(id)) && !ids.some(id => LONG_QUOTA_ID.test(id))) {
        return 'rate-limited';
      }
      return 'quota-exhausted';
    }
    const ids = [...text.matchAll(/"quotaId"\s*:\s*"([^"]+)"/g)].map(m => m[1]);
    if (ids.some(id => LONG_QUOTA_ID.test(id))) return 'quota-exhausted';
    return 'rate-limited';
  }
  // Anthropic: 400 "Your credit balance is too low".
  if (status === 400 && /credit balance is too low/i.test(text)) return 'quota-exhausted';
  return 'other';
}

/** Classify any error thrown by a provider call. */
export function classifyError(err: unknown): { provider?: string; status?: number; kind: ProviderErrorKind } {
  if (err instanceof ProviderHttpError) return { provider: err.provider, status: err.status, kind: err.kind };
  const msg = err instanceof Error ? err.message : String(err);
  // "OpenRouter /chat/completions failed: 402 {...}" from the sidecar route.
  const m = /(\b[1-5]\d\d)\b[\s:]*([\s\S]*)/.exec(msg.replace(/^.*?failed:\s*/, ''));
  if (m) {
    const status = Number(m[1]);
    const kind = classifyProviderError(status, m[2]);
    if (kind !== 'other') return { status, kind };
  }
  if (QUOTA_TEXT.slice(0, 5).some(r => r.test(msg)) && /\b(402|429)\b|insufficient|credit/i.test(msg)) {
    return { kind: 'quota-exhausted' };
  }
  return { kind: 'other' };
}

export function providerLabel(provider: string): string {
  switch (provider) {
    case 'gemini': return 'Gemini';
    case 'anthropic': return 'Anthropic';
    case 'groq': return 'Groq';
    case 'openrouter': return 'OpenRouter';
    case 'sidecar': return 'the local sidecar';
    default: return provider;
  }
}

/** The user-facing warning for a classified failure. `fallback` names what answered instead, if anything. */
export function warningFor(provider: string, kind: ProviderErrorKind, status?: number, fallback?: string, reason?: string): ProviderWarning {
  const name = providerLabel(provider);
  const tail = fallback ? ` This answer came from ${fallback}.` : '';
  const where = 'Config → LLM providers';
  switch (kind) {
    case 'quota-exhausted':
      return {
        kind: 'provider-quota-exhausted', provider, status,
        message: `${name} has no credits left. Add credits or pick another provider in ${where}.${tail}`,
      };
    case 'rate-limited':
      return {
        kind: 'provider-rate-limited', provider, status,
        message: `${name} is rate-limiting requests right now. Try again in a minute.${tail}`,
      };
    case 'auth-invalid':
      return {
        kind: 'provider-auth-invalid', provider, status,
        message: `${name} rejected the API key. Update it in ${where}.${tail}`,
      };
    default:
      return {
        kind: 'provider-failed', provider, status, ...(reason ? { reason } : {}),
        message: `${name} failed (${reason ?? (status ? `HTTP ${status}` : 'error')}).${tail}`,
      };
  }
}

/** The classifier kind behind a warning (inverse of warningFor). */
export function kindOfWarning(w: ProviderWarning): ProviderErrorKind {
  switch (w.kind) {
    case 'provider-quota-exhausted': return 'quota-exhausted';
    case 'provider-rate-limited': return 'rate-limited';
    case 'provider-auth-invalid': return 'auth-invalid';
    default: return 'other';
  }
}

/** A short cause for a failure the classifier calls 'other', for the popup. */
export function shortFailureReason(err: unknown): string | undefined {
  const msg = err instanceof Error ? err.message : String(err);
  if (/is not a valid model ID|not allow-listed|model .*not found/i.test(msg)) return 'bad model ID';
  if (/did not finish within|deadline|timed? ?out/i.test(msg)) return 'timed out';
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|no WS tunnel/i.test(msg)) return 'unreachable';
  const m = /\b([45]\d\d)\b/.exec(msg);
  return m ? `HTTP ${m[1]}` : undefined;
}

/**
 * Finish the warnings once synthesis is done: name what answered instead, or
 * say that nothing could. `usedProvider` 'none' = citations-only.
 */
export function finalizeWarnings(warnings: ProviderWarning[], usedProvider: string, usedModel?: string): ProviderWarning[] {
  const model = usedModel && usedModel !== usedProvider && usedModel !== 'unavailable' ? usedModel : undefined;
  const answeredBy = usedProvider === 'none'
    ? undefined
    : usedProvider === 'sidecar'
      ? `local ${model ?? 'sidecar model'}`
      : `${providerLabel(usedProvider)}${model ? ` (${model})` : ''}`;
  return warnings.map((w) => {
    if (answeredBy && w.provider !== usedProvider) return warningFor(w.provider, kindOfWarning(w), w.status, answeredBy, w.reason);
    if (!answeredBy) return { ...w, message: `${w.message} No other provider could answer, so no answer was written.` };
    return w;
  });
}

// ─── Remember exhausted providers ─────────────────────────────────────────

const DEFAULT_EXHAUSTED_TTL_MS = 30 * 60_000;
const exhausted = new Map<string, { at: number; until: number; status?: number; kind: ProviderErrorKind }>();

function ttlMs(): number {
  const v = Number(process.env.FANTOM_PROVIDER_EXHAUSTED_TTL_MS);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_EXHAUSTED_TTL_MS;
}

/**
 * Remember that a provider is out of credits (or its key is rejected), so
 * later asks skip it at once. Saving the key again clears the mark.
 */
export function markProviderExhausted(
  provider: string, status?: number, now = Date.now(), kind: ProviderErrorKind = 'quota-exhausted',
): void {
  const ttl = ttlMs();
  if (ttl === 0) return;
  exhausted.set(provider, { at: now, until: now + ttl, status, kind });
  const what = kind === 'auth-invalid' ? 'rejected the API key' : 'is out of credits';
  console.warn(`[provider-quota] ${providerLabel(provider)} ${what} — skipping it for ${Math.round(ttl / 60_000)} min.`);
}

/** Null when the provider is usable; otherwise why, when it was marked and when the mark ends. */
export function providerExhaustedState(
  provider: string, now = Date.now(),
): { since: string; until: string; status?: number; kind: ProviderErrorKind } | null {
  const e = exhausted.get(provider);
  if (!e) return null;
  if (e.until <= now) { exhausted.delete(provider); return null; }
  return { since: new Date(e.at).toISOString(), until: new Date(e.until).toISOString(), status: e.status, kind: e.kind };
}

export function clearProviderExhausted(provider?: string): void {
  if (provider) exhausted.delete(provider); else exhausted.clear();
}
