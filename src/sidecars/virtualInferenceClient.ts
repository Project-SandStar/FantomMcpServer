/**
 * Client for the sidecar's virtual-inference commands.
 *
 * The sidecar spends its OWN pushed OpenRouter key on our behalf; Fantom
 * never holds, logs or transports a key. Transport is the existing Sound
 * Suite master WS tunnel: we send `{type:'command', id, action, ...payload}`
 * and the sidecar's ws-client hands the whole frame through as the payload
 * (`payload: msg as Record<string, unknown>`), so a flat spread is correct —
 * verified against sideCar/src/lib/ws-client.ts.
 *
 * Actions:
 *   virtual-embed  → { source:'local' } | { source:'openrouter', embeddings, model, dims, totalTokens? }
 *   virtual-rerank → { source:'local' } | { source:'openrouter', results, model, totalTokens? }
 *
 * `{ source: 'local' }` is NOT an error: it means the sidecar's routing for
 * this (master, role) said to stay local. Callers treat it as "no cloud
 * capacity right now" and fall back rather than failing.
 *
 * `localAvailable: false` is always sent. Fantom has already decided locally
 * that it wants the cloud path (for rerank: no healthy local reranker, or the
 * local request failed; for embedding: the OR provider is a peer in the
 * fan-out). Without it a `local-first` role resolves straight back to local.
 */

import { sendCommandToSidecar } from './soundsuiteMaster.js';
import type { VirtualContainer } from './virtualContainers.js';

export interface VirtualEmbedResponse {
  source: 'local' | 'openrouter';
  embeddings?: number[][];
  model?: string;
  dims?: number;
  totalTokens?: number;
}

export interface VirtualRerankResponse {
  source: 'local' | 'openrouter';
  results?: Array<{ index: number; relevance_score: number }>;
  model?: string;
  totalTokens?: number;
}

export class VirtualInferenceUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VirtualInferenceUnavailable';
  }
}

function unwrap(raw: unknown, action: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') {
    throw new VirtualInferenceUnavailable(`${action}: no WS tunnel to the sidecar (command returned null)`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.error === 'string' && obj.error) throw new Error(`${action}: ${obj.error}`);
  return obj;
}

/**
 * Ask a sidecar to embed `texts` on OpenRouter under Fantom's master slot.
 * `requestedModel` is always sent for embeddings: a silent model substitution
 * is the exact failure that splits a vector space, so we would rather be
 * refused loudly than served a different model than the one we verified.
 */
export async function virtualEmbed(
  vc: VirtualContainer,
  texts: string[],
  timeoutMs = 120_000,
): Promise<VirtualEmbedResponse> {
  const raw = await sendCommandToSidecar(vc.sidecarId, 'virtual-embed', {
    role: vc.role,
    texts,
    localAvailable: false,
    localErrorReason: 'fantom fan-out: this provider is the cloud peer, not a local fallback',
    model: vc.model,
  }, timeoutMs);
  const obj = unwrap(raw, 'virtual-embed');
  if (obj.source !== 'openrouter') {
    throw new VirtualInferenceUnavailable(
      `virtual-embed on ${vc.providerName}: sidecar routed to local (role '${vc.role}' is not cloud-routable `
      + `for Fantom's master slot — check the OpenRouter config pushed to that slot)`,
    );
  }
  return obj as unknown as VirtualEmbedResponse;
}

/**
 * Ask a sidecar to rerank on OpenRouter. `requestedModel` is sent only when
 * strict mode is on: the sidecar's allow-list is authoritative and a mismatch
 * is a hard refusal, so by default we take whatever the slot allow-lists and
 * warn separately when it is not the model we would have picked.
 */
export async function virtualRerank(
  vc: VirtualContainer,
  query: string,
  documents: string[],
  opts: { topN?: number; requestedModel?: string; timeoutMs?: number } = {},
): Promise<VirtualRerankResponse> {
  const payload: Record<string, unknown> = {
    role: vc.role,
    query,
    documents,
    localAvailable: false,
    localErrorReason: 'fantom: no healthy local reranker, or the local request failed',
  };
  if (opts.topN) payload.topN = opts.topN;
  if (opts.requestedModel) payload.model = opts.requestedModel;

  const raw = await sendCommandToSidecar(vc.sidecarId, 'virtual-rerank', payload, opts.timeoutMs ?? 60_000);
  const obj = unwrap(raw, 'virtual-rerank');
  if (obj.source !== 'openrouter') {
    throw new VirtualInferenceUnavailable(
      `virtual-rerank on ${vc.providerName}: sidecar routed to local (role 'reranker' is not cloud-routable `
      + `for Fantom's master slot)`,
    );
  }
  return obj as unknown as VirtualRerankResponse;
}

/**
 * Ask a sidecar to read the OpenRouter key's OWN limits on our behalf.
 *
 * Fantom holds no key, so `GET https://openrouter.ai/api/v1/key` (and
 * `/api/v1/credits`) can only be reached through the sidecar that holds one.
 * Only the numbers come back; the key never crosses.
 *
 * IMPORTANT — this action does not exist in the sidecar yet. `ws-client.ts`
 * answers an unrecognised action with `{ error: 'Unknown action: ...' }`, so
 * today every call lands in the `unsupported` branch and the budget falls
 * back to its conservative configured default. That is the intended
 * fail-safe: we never assume headroom we could not read. Adding
 * `virtual-key-info` to the sidecar's switch is the one genuine sidecar-side
 * change this feature still wants.
 */
export interface VirtualKeyInfo {
  /** Requests allowed per `intervalSeconds`, as reported by OpenRouter. */
  requests?: number;
  intervalSeconds?: number;
  /** Spend ceiling and usage, for display only. */
  limit?: number | null;
  usage?: number;
  limitRemaining?: number | null;
  isFreeTier?: boolean;
  /**
   * The `rate_limit` object exactly as OpenRouter returned it, plus the
   * envelope's scalar keys, for display and diagnosis. Carries NO secret — the
   * key never crosses the tunnel, and `/key` does not echo it.
   *
   * It exists because the parsed number was not believable and could not be
   * checked: a funded $100 account reported `discoveredRequestsPerMinute: 1`,
   * and `{requests, interval}` has no representation of 1/min that is also
   * consistent with `{requests:1, interval:"10s"}` (6/min) — so the field had
   * to be seen, not inferred. Nothing in the budget's arithmetic reads this;
   * it is evidence.
   */
  rawRateLimit?: unknown;
  /** Top-level keys present in the envelope, so a field that moved or was
   *  removed upstream is visible without dumping values. */
  envelopeKeys?: string[];
}

export type KeyInfoOutcome =
  | { ok: true; info: VirtualKeyInfo }
  | { ok: false; unsupported: boolean; reason: string };

function parseInterval(raw: unknown): number | undefined {
  // OpenRouter reports e.g. "10s", "1m", or a bare number of seconds.
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw !== 'string') return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(raw.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  switch ((m[2] ?? 's').toLowerCase()) {
    case 'ms': return n / 1000;
    case 'm': return n * 60;
    case 'h': return n * 3600;
    default: return n;
  }
}

export async function virtualKeyInfo(
  vc: Pick<VirtualContainer, 'sidecarId' | 'providerName'>,
  timeoutMs = 15_000,
): Promise<KeyInfoOutcome> {
  let raw: unknown;
  try {
    raw = await sendCommandToSidecar(vc.sidecarId, 'virtual-key-info', {}, timeoutMs);
  } catch (err) {
    return { ok: false, unsupported: false, reason: (err as Error).message };
  }
  if (!raw || typeof raw !== 'object') {
    return { ok: false, unsupported: false, reason: 'no WS tunnel to the sidecar' };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.error === 'string' && obj.error) {
    return { ok: false, unsupported: /unknown action/i.test(obj.error), reason: obj.error };
  }
  // Accept either the raw OpenRouter envelope ({data:{...}}) or a flattened
  // one, so a future sidecar can pass the upstream body straight through.
  const d = (obj.data && typeof obj.data === 'object' ? obj.data : obj) as Record<string, unknown>;
  const rl = (d.rate_limit ?? d.rateLimit) as Record<string, unknown> | undefined;
  const requests = typeof rl?.requests === 'number' ? rl.requests : undefined;
  const intervalSeconds = parseInterval(rl?.interval);
  const envelopeKeys = Object.keys(d).sort();
  if (requests === undefined || intervalSeconds === undefined) {
    // NOT fatal any more. `rate_limit` is absent from OpenRouter's documented
    // `/api/v1/key` shape (the docs send you to the `X-RateLimit-*` headers on
    // a 429 instead), so an envelope without it is the expected modern case —
    // and the credits in the very same envelope are still worth having. Return
    // them with no rate figure and let the budget size itself from the balance.
    return {
      ok: true,
      info: {
        ...creditsFrom(d),
        rawRateLimit: rl ?? null,
        envelopeKeys,
      },
    };
  }
  return {
    ok: true,
    info: {
      requests,
      intervalSeconds,
      rawRateLimit: rl,
      envelopeKeys,
      ...creditsFrom(d),
    },
  };
}

/**
 * Pull the spend figures out of a `/key` (+ merged `/credits`) envelope.
 *
 * ACCOUNT balance first, per-key cap second. `/key`'s `limit` is the KEY's own
 * spend cap and is null when it has none — reading only that reported "no
 * credits" on an account holding $100. The sidecar merges `/credits`
 * (`total_credits`, `total_usage`) into the same envelope.
 */
function creditsFrom(d: Record<string, unknown>): Pick<VirtualKeyInfo, 'limit' | 'usage' | 'limitRemaining' | 'isFreeTier'> {
  return {
    limit: (d.total_credits ?? d.limit ?? null) as number | null,
    usage: typeof d.total_usage === 'number'
      ? d.total_usage
      : (typeof d.usage === 'number' ? d.usage : undefined),
    limitRemaining: (
      typeof d.total_credits === 'number' && typeof d.total_usage === 'number'
        ? d.total_credits - d.total_usage
        : (d.limit_remaining ?? d.limitRemaining ?? null)
    ) as number | null,
    isFreeTier: d.is_free_tier === true || d.isFreeTier === true,
  };
}
