/**
 * ss-rlm-sandbox, as a whole-question engine.
 *
 * The container on a sidecar's :8101 runs one complete recursive session per
 * call (measured at 26-28 s). So it gets the WHOLE question once, with the
 * retrieved context as its seed, never one call per loop turn — nesting it per
 * turn timed out every time (commit 0fa026e).
 *
 * Contract (court-lens-mcp docs/ss-rlm-sandbox, docker/rlm-sandbox/server.py):
 *   POST :8101/v1/chat/completions, non-streaming only (stream:true → 400)
 *   identity: X-SoundSuite-Master (+ X-FantomMCP-Master alias) — the canonical
 *     master URL this sidecar files us under; wrong or missing → 409/404
 *   domain:   X-SoundSuite-Domain / X-FantomMCP-Domain = code
 *   errors:   502 with the session's error text
 *
 * The container's code tools (search_code etc. → /api/rlm-tools) are not
 * built on its side yet, so today it reasons over the seed context only. We
 * still send X-FantomMCP-Ask and X-FantomMCP-Project so the callbacks can be
 * tagged to this ask the day they arrive.
 */

import type { Sidecar } from '../admin/types.js';

export const SANDBOX_PORT = 8101;
const HEALTH_TIMEOUT_MS = 3_000;

export interface SandboxHostHealth {
  id: string;
  name: string;
  hasRole: boolean;
  healthy: boolean;
  ms?: number;
  model?: string;
  error?: string;
}

function baseFor(sc: Sidecar): string {
  return `${sc.protocol ?? 'http'}://${sc.host}:${SANDBOX_PORT}`;
}

async function probe(sc: Sidecar, hasRole: boolean, fetchImpl: typeof fetch): Promise<SandboxHostHealth> {
  const t0 = Date.now();
  try {
    const r = await fetchImpl(`${baseFor(sc)}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; model?: string };
    return { id: sc.id, name: sc.name, hasRole, healthy: r.ok && j.ok !== false, ms: Date.now() - t0, model: j.model, error: r.ok ? undefined : `HTTP ${r.status}` };
  } catch (err) {
    return { id: sc.id, name: sc.name, hasRole, healthy: false, ms: Date.now() - t0, error: (err as Error).message };
  }
}

/** Health of every host that runs the rlm-sandbox role, in routing order. */
export async function sandboxHostHealth(fetchImpl: typeof fetch = fetch): Promise<SandboxHostHealth[]> {
  const { hostsForRole } = await import('../sidecars/sidecarRoles.js');
  const ranked = (await hostsForRole('rlm-sandbox', { strict: true })).filter(h => h.hasRole);
  return Promise.all(ranked.map(h => probe(h.sidecar, h.hasRole, fetchImpl)));
}

export type SandboxResult =
  | { ok: true; text: string; ms: number; host: string }
  | { ok: false; reason: string; ms: number; host?: string; timedOut?: boolean };

export interface SandboxAskInput {
  question: string;
  /** Retrieved code, numbered as the final answer will cite it. */
  context: string;
  /** Hard limit for the call; aborts after this. */
  deadlineMs: number;
  askId?: string;
  projectId?: number;
  /** Called with the host chosen, before the long call starts. */
  onHost?: (name: string) => void;
  fetchImpl?: typeof fetch;
}

const SANDBOX_INSTRUCTIONS =
  'You are investigating a codebase question. The CONTEXT holds numbered code search results. '
  + 'Work through it, then write a short draft answer that names the exact symbols and files that '
  + 'answer the question and cites the context numbers as [n]. Say plainly what the context does not show.';

/** Pure: the request body. Exported for tests. */
export function sandboxRequestBody(question: string, context: string): Record<string, unknown> {
  return {
    messages: [
      { role: 'system', content: SANDBOX_INSTRUCTIONS },
      { role: 'user', content: `QUESTION: ${question}\n\nCONTEXT:\n${context || '(no results found)'}` },
    ],
    max_tokens: 2048,
    stream: false,
  };
}

/** Pure: the headers. Exported for tests. */
export function sandboxHeaders(masterUrl: string, askId?: string, projectId?: number): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-SoundSuite-Master': masterUrl,
    'X-FantomMCP-Master': masterUrl,
    'X-SoundSuite-Domain': 'code',
    'X-FantomMCP-Domain': 'code',
    ...(askId ? { 'X-FantomMCP-Ask': askId } : {}),
    ...(projectId !== undefined ? { 'X-FantomMCP-Project': String(projectId) } : {}),
  };
}

/**
 * Send the whole question to the first healthy sandbox host. Never throws:
 * every failure comes back as `{ ok: false, reason }` so the caller can report
 * it and answer from the retrieved context.
 */
export async function runSandboxAsk(input: SandboxAskInput): Promise<SandboxResult> {
  const t0 = Date.now();
  const fetchImpl = input.fetchImpl ?? fetch;
  const elapsed = () => Date.now() - t0;
  let hosts: SandboxHostHealth[];
  try {
    hosts = await sandboxHostHealth(fetchImpl);
  } catch (err) {
    return { ok: false, reason: `cannot list sandbox hosts: ${(err as Error).message}`, ms: elapsed() };
  }
  if (!hosts.length) return { ok: false, reason: 'no sidecar runs the rlm-sandbox role', ms: elapsed() };
  const healthy = hosts.find(h => h.healthy);
  if (!healthy) {
    return { ok: false, reason: `no healthy sandbox host (${hosts.map(h => `${h.name}: ${h.error ?? 'down'}`).join('; ')})`, ms: elapsed() };
  }
  const { listSidecars } = await import('../sidecars/registry.js');
  const sc = listSidecars({ enabled: true }).find(s => s.id === healthy.id);
  if (!sc) return { ok: false, reason: `sandbox host ${healthy.name} vanished`, ms: elapsed(), host: healthy.name };
  const { canonicalMasterUrl } = await import('../sidecars/sandboxSlots.js');
  const masterUrl = await canonicalMasterUrl(sc.id);
  if (!masterUrl) return { ok: false, reason: 'no master URL known to identify Fantom to the sandbox', ms: elapsed(), host: sc.name };

  const left = input.deadlineMs - elapsed();
  if (left <= 1_000) return { ok: false, reason: 'deadline passed before the call', ms: elapsed(), host: sc.name, timedOut: true };
  input.onHost?.(sc.name);
  try {
    const r = await fetchImpl(`${baseFor(sc)}/v1/chat/completions`, {
      method: 'POST',
      headers: sandboxHeaders(masterUrl, input.askId, input.projectId),
      body: JSON.stringify(sandboxRequestBody(input.question, input.context)),
      signal: AbortSignal.timeout(left),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      let msg = t;
      try { msg = (JSON.parse(t)?.error?.message ?? JSON.parse(t)?.error ?? t) as string; } catch { /* plain text */ }
      return { ok: false, reason: `HTTP ${r.status}: ${String(msg).slice(0, 200)}`, ms: elapsed(), host: sc.name };
    }
    const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = (j.choices?.[0]?.message?.content ?? '').trim();
    if (!text) return { ok: false, reason: 'empty answer', ms: elapsed(), host: sc.name };
    return { ok: true, text, ms: elapsed(), host: sc.name };
  } catch (err) {
    const e = err as Error;
    const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
    return { ok: false, reason: timedOut ? `timed out after ${Math.round(elapsed() / 1000)}s` : e.message, ms: elapsed(), host: sc.name, timedOut };
  }
}
