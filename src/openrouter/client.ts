/**
 * Fantom's own OpenRouter client: embeddings, rerank, chat, key info.
 *
 * Request shapes match the sidecar client it replaces
 * (court-lens-mcp sideCar/src/lib/openrouter-client.ts):
 *  - embeddings are always pinned: `provider: {order: [pin], allow_fallbacks: false}`.
 *    Two upstreams for one model can return different vectors; an unpinned
 *    call could split the vector space. No pin = refuse before the call.
 *  - a reply of the wrong width is refused (a wrong-width vector corrupts the table).
 *  - chat asks for `usage: {include: true}` and never streams.
 *
 * Every error carries `status` and, for 429, `retryAfterMs`. No message ever
 * holds the key (`redactKey`).
 */
import { orFetch, OPENROUTER_BASE_URL, type OrResponse } from './http.js';
import { openRouterKey, redactKey } from './key.js';
import { parseEmbeddings } from './parsePool.js';
import {
  noteCallStarted, noteCallFinished, isRoleCapped,
} from '../sidecars/openRouterActivity.js';
import type { FantomRole } from '../sidecars/openRouterModels.js';

export class OpenRouterError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;
  readonly code: string;
  constructor(message: string, status: number, opts: { retryAfterMs?: number; code?: string } = {}) {
    super(redactKey(message));
    this.name = 'OpenRouterError';
    this.status = status;
    this.retryAfterMs = opts.retryAfterMs;
    this.code = opts.code ?? (status === 429 ? 'rate-limited' : status === 0 ? 'network' : 'http');
  }
}

export class OpenRouterNoKeyError extends OpenRouterError {
  constructor() { super('No OpenRouter API key is stored on this server. Add one on the OpenRouter page.', 401, { code: 'no-key' }); }
}

export const X_TITLE = 'Fantom MCP';

function headers(key: string): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    'X-Title': X_TITLE,
  };
  const ref = process.env.FANTOM_OPENROUTER_REFERER?.trim();
  if (ref) h['HTTP-Referer'] = ref;
  return h;
}

function requireKey(): string {
  const k = openRouterKey();
  if (!k) throw new OpenRouterNoKeyError();
  return k;
}

function retryAfter(res: OrResponse): number | undefined {
  const v = res.headers.get('retry-after');
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

async function errorFrom(path: string, res: OrResponse): Promise<OpenRouterError> {
  let detail = '';
  try {
    const t = await res.text();
    try {
      const j = JSON.parse(t) as { error?: { message?: string } | string };
      detail = typeof j.error === 'string' ? j.error : j.error?.message ?? t;
    } catch { detail = t; }
  } catch { /* body unreadable */ }
  detail = detail.replace(/\s+/g, ' ').slice(0, 300);
  const ra = retryAfter(res);
  const raText = res.status === 429 && ra !== undefined ? ` retry-after ${Math.round(ra)}ms` : '';
  return new OpenRouterError(`OpenRouter ${path} HTTP ${res.status}${raText}${detail ? `: ${detail}` : ''}`, res.status, { retryAfterMs: ra });
}

async function send(path: string, method: 'GET' | 'POST', body: unknown, timeoutMs: number, base = OPENROUTER_BASE_URL): Promise<OrResponse> {
  const key = requireKey();
  let res: OrResponse;
  try {
    res = await orFetch(`${base}${path}`, {
      method,
      headers: headers(key),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const e = err as Error;
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    throw new OpenRouterError(
      timedOut ? `OpenRouter ${path} timed out after ${timeoutMs}ms` : `OpenRouter ${path} network error: ${e?.message ?? String(err)}`,
      0, { code: timedOut ? 'timeout' : 'network' },
    );
  }
  if (!res.ok) throw await errorFrom(path, res);
  return res;
}

async function sendJson<T>(path: string, method: 'GET' | 'POST', body: unknown, timeoutMs: number, base?: string): Promise<T> {
  const res = await send(path, method, body, timeoutMs, base);
  const text = await res.text();
  try { return JSON.parse(text) as T; } catch { throw new OpenRouterError(`OpenRouter ${path} returned non-JSON`, res.status); }
}

/** Run `fn` with the role's daily cap and activity counters around it. */
async function tracked<T>(
  role: FantomRole,
  model: string,
  fn: () => Promise<T>,
  usage: (out: T) => { tokens?: number },
): Promise<T> {
  if (isRoleCapped(role)) {
    throw new OpenRouterError(`[spend-cap] role '${role}' reached its daily OpenRouter cap; raise or clear it on the OpenRouter page`, 402, { code: 'capped' });
  }
  const t0 = Date.now();
  noteCallStarted(role);
  try {
    const out = await fn();
    noteCallFinished(role, { servedBy: 'fantom', model, tokens: usage(out).tokens, durationMs: Date.now() - t0, success: true });
    return out;
  } catch (err) {
    noteCallFinished(role, { servedBy: 'fantom', model, durationMs: Date.now() - t0, success: false, error: (err as Error).message.slice(0, 200) });
    throw err;
  }
}

// ── Embeddings ─────────────────────────────────────────────────────────────

export interface EmbedOptions {
  role: 'code-embedding' | 'embedding';
  model: string;
  /** Upstream pin. Required. */
  pin: string;
  expectedDims?: number;
  timeoutMs?: number;
}

export interface EmbedResult {
  vectors: Float32Array[];
  model: string;
  dims: number;
  totalTokens?: number;
  ms: number;
}

export async function embed(texts: string[], opts: EmbedOptions): Promise<EmbedResult> {
  if (!opts.pin) {
    throw new OpenRouterError(`refusing to embed with ${opts.model}: no upstream pin (an unpinned route can split the vector space)`, 400, { code: 'no-pin' });
  }
  if (texts.length === 0) return { vectors: [], model: opts.model, dims: opts.expectedDims ?? 0, ms: 0 };
  return tracked(opts.role, opts.model, async () => {
    const t0 = Date.now();
    const res = await send('/embeddings', 'POST', {
      model: opts.model,
      input: texts,
      provider: { order: [opts.pin], allow_fallbacks: false },
    }, opts.timeoutMs ?? 120_000);
    const parsed = await parseEmbeddings(await res.arrayBuffer());
    if (parsed.error) throw new OpenRouterError(`OpenRouter /embeddings: ${parsed.error}`, 502);
    if (parsed.vectors.length !== texts.length) {
      throw new OpenRouterError(`OpenRouter /embeddings returned ${parsed.vectors.length} vectors for ${texts.length} texts`, 502);
    }
    const dims = parsed.vectors[0]?.length ?? 0;
    if (opts.expectedDims && dims !== opts.expectedDims) {
      throw new OpenRouterError(
        `OpenRouter ${opts.model} returned ${dims}-dim vectors but ${opts.expectedDims} was expected; refusing them`,
        502, { code: 'wrong-dims' },
      );
    }
    return { vectors: parsed.vectors, model: opts.model, dims, totalTokens: parsed.totalTokens, ms: Date.now() - t0 };
  }, r => ({ tokens: r.totalTokens }));
}

// ── Rerank ─────────────────────────────────────────────────────────────────

export interface RerankResult {
  results: Array<{ index: number; relevance_score: number }>;
  model: string;
  totalTokens?: number;
  ms: number;
}

export async function rerank(
  query: string,
  documents: string[],
  opts: { model: string; pin?: string; topN?: number; timeoutMs?: number },
): Promise<RerankResult> {
  return tracked('reranker', opts.model, async () => {
    const t0 = Date.now();
    const body: Record<string, unknown> = { model: opts.model, query, documents };
    if (opts.topN) body.top_n = opts.topN;
    if (opts.pin) body.provider = { order: [opts.pin], allow_fallbacks: true };
    const j = await sendJson<{ results?: Array<{ index: number; relevance_score: number }>; model?: string; usage?: { total_tokens?: number } }>(
      '/rerank', 'POST', body, opts.timeoutMs ?? 60_000,
    );
    if (!Array.isArray(j.results)) throw new OpenRouterError('OpenRouter /rerank reply has no results', 502);
    return { results: j.results, model: j.model ?? opts.model, totalTokens: j.usage?.total_tokens, ms: Date.now() - t0 };
  }, r => ({ tokens: r.totalTokens }));
}

// ── Chat ───────────────────────────────────────────────────────────────────

export interface ChatOptions {
  role: 'code-assistant' | 'rlm';
  model: string;
  maxTokens?: number;
  temperature?: number;
  /** Thinking models: off unless asked (they spend max_tokens on reasoning). */
  reasoning?: boolean;
  tools?: unknown[];
  toolChoice?: unknown;
  timeoutMs?: number;
  /** Anything else OpenRouter accepts (top_p, seed, response_format, provider, …). */
  extra?: Record<string, unknown>;
}

export interface ChatResult {
  /** The raw OpenAI-shaped reply (choices, usage, model). */
  raw: Record<string, any>;
  text: string;
  model: string;
  costUsd: number | null;
  totalTokens?: number;
  finishReason?: string;
  ms: number;
}

export async function chat(messages: unknown[], opts: ChatOptions): Promise<ChatResult> {
  return tracked(opts.role, opts.model, async () => {
    const t0 = Date.now();
    const body: Record<string, unknown> = {
      ...(opts.extra ?? {}),
      model: opts.model,
      messages,
      usage: { include: true },
      reasoning: { enabled: opts.reasoning === true },
    };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.tools?.length) body.tools = opts.tools;
    if (opts.toolChoice !== undefined) body.tool_choice = opts.toolChoice;
    delete body.stream;
    const raw = await sendJson<Record<string, any>>('/chat/completions', 'POST', body, opts.timeoutMs ?? 120_000);
    if (raw.error) {
      const msg = typeof raw.error === 'string' ? raw.error : raw.error?.message ?? 'error';
      throw new OpenRouterError(`OpenRouter /chat/completions: ${msg}`, Number(raw.error?.code) || 502);
    }
    const choice = raw.choices?.[0];
    const cost = typeof raw.usage?.cost === 'number' ? raw.usage.cost : null;
    return {
      raw,
      text: typeof choice?.message?.content === 'string' ? choice.message.content : '',
      model: typeof raw.model === 'string' ? raw.model : opts.model,
      costUsd: cost,
      totalTokens: raw.usage?.total_tokens,
      finishReason: choice?.finish_reason,
      ms: Date.now() - t0,
    };
  }, r => ({ tokens: r.totalTokens }));
}

// ── Key info ───────────────────────────────────────────────────────────────

export interface KeyInfo {
  label?: string;
  limit?: number | null;
  limitRemaining?: number | null;
  usage?: number;
  isFreeTier?: boolean;
  totalCredits?: number;
  totalUsage?: number;
  rateLimit?: { requests?: number; interval?: string };
}

export async function keyInfo(timeoutMs = 15_000): Promise<KeyInfo> {
  const k = await sendJson<{ data?: Record<string, any> }>('/key', 'GET', undefined, timeoutMs);
  const d = k.data ?? {};
  const out: KeyInfo = {
    label: typeof d.label === 'string' ? d.label.replace(/sk-or-[A-Za-z0-9_-]+/g, 'sk-or-…') : undefined,
    limit: d.limit ?? null,
    limitRemaining: d.limit_remaining ?? null,
    usage: typeof d.usage === 'number' ? d.usage : undefined,
    isFreeTier: d.is_free_tier === true,
    rateLimit: d.rate_limit,
  };
  try {
    const c = await sendJson<{ data?: { total_credits?: number; total_usage?: number } }>('/credits', 'GET', undefined, timeoutMs);
    out.totalCredits = c.data?.total_credits;
    out.totalUsage = c.data?.total_usage;
  } catch { /* /credits needs a provisioning key on some accounts */ }
  return out;
}

/**
 * Model ids this key may use: OpenRouter's catalogue filtered by the
 * account's provider preferences and privacy settings (e.g. ZDR). A model in
 * the public list but not here is refused for this account.
 */
export async function userModelIds(timeoutMs = 15_000): Promise<Set<string>> {
  const j = await sendJson<{ data?: Array<{ id?: string }> }>('/models/user', 'GET', undefined, timeoutMs);
  return new Set((j.data ?? []).map(m => m.id).filter((x): x is string => typeof x === 'string'));
}

/** True for a 429 or a rate-limit message. */
export function isRateLimited(err: unknown): boolean {
  if (err instanceof OpenRouterError) return err.status === 429;
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /\b429\b/.test(msg) || /rate[ _-]?limit/i.test(msg) || /too many requests/i.test(msg);
}

/** Errors worth one retry: network, timeout, 5xx, 429. Not 4xx (bad request, no key, cap). */
export function isRetryable(err: unknown): boolean {
  if (!(err instanceof OpenRouterError)) return true;
  return err.status === 0 || err.status === 429 || err.status >= 500;
}
