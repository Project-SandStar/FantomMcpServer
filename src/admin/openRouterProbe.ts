/**
 * "Test" on the OpenRouter config page.
 *
 * One live round trip per role, down the SAME path the role uses for a real
 * request. Since 2026-11-19 that is Fantom's own OpenRouter client with the
 * key in Fantom's secrets store: no sidecar is involved, so this works with
 * every sidecar down. RLM resolves its endpoint exactly as the loop does.
 * A failure carries OpenRouter's own text, because that is the sentence the
 * operator needs when the page says "configured" and nothing answers.
 *
 * Only what is SAVED is tested.
 */
import type { VirtualRole } from '../openrouter/roleTypes.js';
import type { CloudRoleModel } from '../openrouter/roles.js';
import type { OpenRouterChatResult } from '../sidecars/openRouterChat.js';
import type { ProbeResult } from './llmProviderProbe.js';

export const OPENROUTER_PROBE_ROLES: readonly VirtualRole[] =
  ['code-embedding', 'embedding', 'reranker', 'code-assistant', 'rlm'];

export interface OpenRouterProbeResult {
  role: VirtualRole;
  ok: boolean;
  ms: number;
  model: string | null;
  servedModel?: string | null;
  route: string;
  message: string;
  status?: number;
}

export interface OpenRouterProbeDeps {
  hasKey?: () => boolean;
  roleModel?: (role: VirtualRole) => CloudRoleModel | null;
  embed?: (m: CloudRoleModel, texts: string[], timeoutMs: number) => Promise<{ vectors: ArrayLike<number>[]; model: string; dims: number }>;
  rerank?: (m: CloudRoleModel, query: string, docs: string[], timeoutMs: number) => Promise<{ results: Array<{ index: number; relevance_score: number }>; model: string }>;
  chat?: (system: string, user: string, opts: { maxTokens?: number; timeoutMs?: number; model?: string }) => Promise<OpenRouterChatResult>;
  rlm?: () => Promise<ProbeResult>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const PING_SYSTEM = 'Reply with the single word OK.';
const PING_USER = 'ping';
const PING_TEXTS = ['connectivity probe from the OpenRouter page', 'second text so a batch of two comes back'];
const PING_DOCS = ['a document about ping', 'a document about something else'];
const ROUTE = 'direct to OpenRouter';

function clip(s: string, n = 300): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

type Resolved = Required<Omit<OpenRouterProbeDeps, 'timeoutMs'>> & { timeoutMs: number };

async function defaults(deps: OpenRouterProbeDeps): Promise<Resolved> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const keyMod = !deps.hasKey ? await import('../openrouter/key.js') : null;
  const rolesMod = !deps.roleModel ? await import('../openrouter/roles.js') : null;
  const client = (!deps.embed || !deps.rerank) ? await import('../openrouter/client.js') : null;
  const chatMod = !deps.chat ? await import('../sidecars/openRouterChat.js') : null;
  const probeMod = !deps.rlm ? await import('./llmProviderProbe.js') : null;
  return {
    hasKey: deps.hasKey ?? (() => keyMod!.hasOpenRouterKey()),
    roleModel: deps.roleModel ?? ((role) => rolesMod!.cloudRoleModel(role)),
    embed: deps.embed ?? ((m, texts, t) => client!.embed(texts, {
      role: m.role as 'code-embedding' | 'embedding', model: m.model, pin: m.pin ?? '', expectedDims: m.dims, timeoutMs: t,
    })),
    rerank: deps.rerank ?? ((m, q, d, t) => client!.rerank(q, d, { model: m.model, pin: m.pin, timeoutMs: t })),
    chat: deps.chat ?? ((s, u, o) => chatMod!.openRouterChat(s, u, o)),
    rlm: deps.rlm ?? (() => probeMod!.probeProvider('rlm', { timeoutMs })),
    timeoutMs,
  };
}

function noKey(role: VirtualRole): OpenRouterProbeResult {
  return {
    role, ok: false, ms: 0, model: null, route: 'not sent',
    message: 'No OpenRouter key is stored on this server. Paste one and save first.',
  };
}

function noModel(role: VirtualRole): OpenRouterProbeResult {
  return { role, ok: false, ms: 0, model: null, route: 'not sent', message: `no OpenRouter model is saved for ${role}.` };
}

async function timed(
  role: VirtualRole,
  m: CloudRoleModel,
  call: () => Promise<{ model?: string | null; detail: string }>,
): Promise<OpenRouterProbeResult> {
  const t0 = Date.now();
  try {
    const r = await call();
    return {
      role, ok: true, ms: Date.now() - t0, model: m.model,
      servedModel: r.model && r.model !== m.model ? r.model : null,
      route: `${ROUTE}${m.pin ? ` (pinned to ${m.pin})` : ''}`,
      message: r.detail,
    };
  } catch (err) {
    const status = (err as { status?: number }).status;
    return {
      role, ok: false, ms: Date.now() - t0, model: m.model, route: ROUTE,
      message: clip((err as Error).message), ...(status ? { status } : {}),
    };
  }
}

async function probeEmbed(role: 'code-embedding' | 'embedding', d: Resolved): Promise<OpenRouterProbeResult> {
  const m = d.roleModel(role);
  if (!m) return noModel(role);
  return timed(role, m, async () => {
    const r = await d.embed(m, PING_TEXTS, d.timeoutMs);
    const n = r.vectors?.length ?? 0;
    const dims = r.dims ?? r.vectors?.[0]?.length ?? 0;
    if (n !== PING_TEXTS.length || !dims) throw new Error(`returned ${n} vectors (${dims}d) for ${PING_TEXTS.length} texts`);
    return { model: r.model, detail: `${n} vectors · ${dims}d${m.dims && m.dims !== dims ? ` (expected ${m.dims}d)` : ''}` };
  });
}

async function probeRerank(d: Resolved): Promise<OpenRouterProbeResult> {
  const m = d.roleModel('reranker');
  if (!m) return noModel('reranker');
  return timed('reranker', m, async () => {
    const r = await d.rerank(m, 'ping', PING_DOCS, d.timeoutMs);
    const n = r.results?.length ?? 0;
    if (!n) throw new Error('returned no ranked results');
    return { model: r.model, detail: `${n} ranked · top index ${r.results[0].index}` };
  });
}

async function probeChat(d: Resolved): Promise<OpenRouterProbeResult> {
  const m = d.roleModel('code-assistant');
  const t0 = Date.now();
  const asked = m?.model ?? null;
  try {
    const out = await d.chat(PING_SYSTEM, PING_USER, { maxTokens: 16, timeoutMs: d.timeoutMs, ...(asked ? { model: asked } : {}) });
    return {
      role: 'code-assistant', ok: true, ms: Date.now() - t0, model: asked ?? out.model,
      servedModel: asked && out.model && out.model !== asked ? out.model : null,
      route: ROUTE,
      message: clip(out.text) || 'replied with no text',
    };
  } catch (err) {
    return { role: 'code-assistant', ok: false, ms: Date.now() - t0, model: asked, route: ROUTE, message: clip((err as Error).message) };
  }
}

async function probeRlm(d: Resolved): Promise<OpenRouterProbeResult> {
  const r = await d.rlm();
  return { role: 'rlm', ok: r.ok, ms: r.ms, model: r.model, servedModel: r.servedModel, route: r.route, message: r.message, status: r.status };
}

export async function probeOpenRouterRole(role: VirtualRole, deps: OpenRouterProbeDeps = {}): Promise<OpenRouterProbeResult> {
  const d = await defaults(deps);
  if (role !== 'rlm' && !d.hasKey()) return noKey(role);
  switch (role) {
    case 'code-embedding':
    case 'embedding': return probeEmbed(role, d);
    case 'reranker': return probeRerank(d);
    case 'code-assistant': return probeChat(d);
    case 'rlm': return probeRlm(d);
  }
}

export async function probeOpenRouterRoles(roles: readonly VirtualRole[], deps: OpenRouterProbeDeps = {}): Promise<OpenRouterProbeResult[]> {
  return Promise.all(roles.map(r => probeOpenRouterRole(r, deps)));
}

export function isOpenRouterProbeRole(s: unknown): s is VirtualRole {
  return typeof s === 'string' && (OPENROUTER_PROBE_ROLES as readonly string[]).includes(s);
}
