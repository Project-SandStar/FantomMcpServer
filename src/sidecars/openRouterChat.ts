/**
 * Chat completions through the sidecar's OpenRouter route.
 *
 * Fantom has no direct OpenRouter client and deliberately never gets one: the
 * key lives on the sidecar, per master, and is never sent here. A chat request
 * goes out over HTTP to any sidecar's `/api/v1/chat/completions`, which
 * resolves OUR model from OUR config and spends OUR budget.
 *
 * ── Why HTTP and not a WS action ──────────────────────────────────────────
 *
 * The sidecar has `virtual-embed`, `virtual-rerank` and `virtual-key-info` as
 * WS actions and no chat equivalent. The HTTP route exists because the RLM
 * sandbox needs it, and it works for us for the same reason — the identity
 * problem it solves is ours too.
 *
 * ── Identity ──────────────────────────────────────────────────────────────
 *
 * Every sidecar in this fleet holds keys from BOTH masters, so an HTTP caller
 * that does not identify itself gets a 409 rather than a guess. The headers
 * come from `masterIdentityHeaders()`, which is shared with the RLM path so
 * the two cannot drift — and the URL is read from the same source the config
 * push is keyed by, because a mismatch there is a 404 that reads as "no config
 * pushed" rather than "wrong spelling".
 *
 * ── Which model answers ───────────────────────────────────────────────────
 *
 * Not ours to choose. The route pins the model from the caller's own
 * `allowedModels['rlm-sandbox']` and strips `model` from the body
 * (`CALLER_MAY_NOT_SET`), so a request cannot talk its way onto a model the
 * operator did not authorise. Pick the model on the config page; this module
 * reports back which one answered.
 */

import { listSidecars } from './registry.js';

/** The sidecar's OpenRouter-facing HTTP port. */
const SIDECAR_API_PORT = 8098;
const DEFAULT_TIMEOUT_MS = 90_000;

export class OpenRouterChatUnavailable extends Error {
  readonly code = 'openrouter-chat-unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'OpenRouterChatUnavailable';
  }
}

/**
 * This master's canonical URL — the string the sidecar files our config under.
 *
 * Read from the same place the push is keyed by, never rebuilt from parts. A
 * trailing slash or `localhost` where the push said an IP resolves to a
 * different map key and returns 404, which reads as "you pushed no config".
 */
export async function canonicalMasterUrl(): Promise<string | undefined> {
  try {
    const { getVirtualContainersConfig, getSlotStatus } = await import('./virtualContainers.js');
    return getVirtualContainersConfig().masterServerUrl
      ?? getSlotStatus().find(s => s.serverUrl)?.serverUrl;
  } catch {
    return undefined;
  }
}

/**
 * Identity (and domain) headers for any HTTP call into the sidecar fleet.
 *
 * Both spellings of each: the sidecar and the sandbox accept
 * `X-SoundSuite-*` and `X-FantomMCP-*` and take the first present, so sending
 * both means neither side has to redeploy in step with the other. `domain` is
 * hardcoded `code` for the same reason the config push hardcodes it — it is a
 * fact about this software, not a setting.
 */
export function masterIdentityHeaders(masterUrl: string): Record<string, string> {
  return {
    'X-FantomMCP-Master': masterUrl,
    'X-SoundSuite-Master': masterUrl,
    'X-FantomMCP-Domain': 'code',
  };
}

/**
 * Minimum a single attempt is allowed before the deadline can cut it.
 *
 * There used to be a hard 10s per-host CAP here, and it produced a failover
 * loop that could not succeed: a generation that needed 12s was killed at 10s
 * and restarted on the next host, which was killed at whatever was left. Both
 * hosts were WORKING. Failover is for a host that is down — refused, 5xx,
 * 409, unreachable — and those fail in milliseconds. A host that is still
 * generating is not a failure, and cutting it off cannot be made to help.
 *
 * So an attempt now gets the whole remaining window, and the deadline is the
 * caller's budget, not a per-host guess.
 */
const HARD_FAILURE_RETRY = true;
/** The host that answered last time goes first next time. */
let lastGoodHost: string | null = null;

export interface OpenRouterChatResult {
  text: string;
  /** The model the sidecar actually used — it chooses, we do not. */
  model: string;
  /** USD for this call, as OpenRouter reported it. Null when not returned. */
  costUsd: number | null;
  servedBy: string;
}

/**
 * One non-streaming completion.
 *
 * `stream` is never sent: the route rejects it with a 400 rather than hang a
 * caller waiting for SSE that never arrives, and nothing here wants tokens
 * as they arrive.
 */
export async function openRouterChat(
  system: string,
  user: string,
  opts: { maxTokens?: number; timeoutMs?: number; temperature?: number } = {},
): Promise<OpenRouterChatResult> {
  const masterUrl = await canonicalMasterUrl();
  if (!masterUrl) {
    throw new OpenRouterChatUnavailable(
      'this master has no canonical URL known to the fleet, so the sidecar cannot tell whose key to '
      + 'spend — check that a config push has reached at least one sidecar.',
    );
  }
  // Any enabled sidecar will do: the route is a thin proxy and the key it uses
  // is ours regardless of which host answers. Trying them in turn means one
  // unreachable host does not fail the request.
  const all = listSidecars({ enabled: true });
  if (all.length === 0) throw new OpenRouterChatUnavailable('no enabled sidecar is registered.');
  // Try the host that answered last time first. Registry order put the same
  // host first every call, so when that host was slow every request paid for
  // it before failing over — if it failed over at all.
  const hosts = lastGoodHost
    ? [...all.filter(h => h.name === lastGoodHost), ...all.filter(h => h.name !== lastGoodHost)]
    : all;

  const body = JSON.stringify({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: opts.maxTokens ?? 1024,
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
  });

  const errors: string[] = [];
  // ONE deadline for the whole call, not one per host.
  //
  // `timeoutMs` was applied per attempt, so a caller asking for 8s against a
  // five-host fleet could wait 40s — and did: a synthesis given 8.6s of a 45s
  // budget took 29s and pushed the whole answer to 65s, past the MCP client
  // it was budgeted for. A timeout that the caller cannot reason about is
  // worse than none, because it reads as a guarantee.
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  for (const host of hosts) {
    const remaining = deadline - Date.now();
    if (remaining <= 250) {
      errors.push(`${host.name}: skipped, deadline reached`);
      continue;
    }
    const url = `${host.protocol}://${host.host}:${SIDECAR_API_PORT}/api/v1/chat/completions`;
    const ac = new AbortController();
    // The attempt gets the whole remaining window. See HARD_FAILURE_RETRY.
    const attemptMs = remaining;
    const timer = setTimeout(() => ac.abort(new Error(`deadline (${attemptMs}ms)`)), attemptMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...masterIdentityHeaders(masterUrl) },
        body,
        signal: ac.signal,
      });
      const json = await res.json().catch(() => null) as any;
      if (!res.ok) {
        // The route returns an OpenAI error envelope, and its messages are
        // written to be actionable (409 names both masters, 503 says which
        // model is missing). Surface it rather than the status alone.
        const msg = json?.error?.message ?? `HTTP ${res.status}`;
        errors.push(`${host.name}: ${String(msg).slice(0, 200)}`);
        continue;
      }
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) {
        errors.push(`${host.name}: empty completion`);
        continue;
      }
      lastGoodHost = host.name;
      return {
        text,
        model: json?.model ?? 'openrouter',
        costUsd: typeof json?.usage?.cost === 'number' ? json.usage.cost : null,
        servedBy: host.name,
      };
    } catch (err) {
      const msg = (err as Error).message;
      errors.push(`${host.name}: ${msg.slice(0, 120)}`);
      // A timeout means the window is spent; there is no second host to give
      // it to. Say that plainly instead of listing four hosts as "skipped".
      if (/deadline|abort/i.test(msg)) {
        throw new OpenRouterChatUnavailable(
          `${host.name} did not finish within the ${Math.round(attemptMs / 1000)}s window (it was answering, not refusing) — `
          + `raise semanticSearch.answerSynthesis.synthesisMaxMs (the upstream-hang safety net)${errors.length > 1 ? `; earlier: ${errors.slice(0, -1).join('; ')}` : ''}`,
        );
      }
      if (!HARD_FAILURE_RETRY) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new OpenRouterChatUnavailable(`every sidecar refused the chat call — ${errors.join('; ')}`);
}
