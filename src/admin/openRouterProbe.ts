/**
 * "Test" on the OpenRouter config page.
 *
 * One live round trip per role, down the SAME path the role uses when it
 * serves a real request: the embedders and the reranker go over the WS tunnel
 * to every sidecar that advertises the role for this master; the code
 * assistant goes through the sidecar's OpenRouter chat proxy; RLM resolves its
 * endpoint exactly as the loop does. A pass here means the role works end to
 * end with the key the sidecars hold. A failure carries the provider's own
 * text — "poolside/laguna-s-2.1:free is no longer available on OpenRouter",
 * "fetch failed" from a host the master cannot reach — because that is the
 * sentence the operator needs when the page says "configured" and nothing
 * answers.
 *
 * Only what is SAVED AND PUSHED is tested. An unsaved dropdown choice is not
 * on the sidecars yet, so testing it would test nothing.
 */
import type { VirtualContainer, VirtualRole } from '../sidecars/virtualContainers.js';
import type { VirtualEmbedResponse, VirtualRerankResponse } from '../sidecars/virtualInferenceClient.js';
import type { OpenRouterChatResult } from '../sidecars/openRouterChat.js';
import type { ProbeResult } from './llmProviderProbe.js';

export const OPENROUTER_PROBE_ROLES: readonly VirtualRole[] =
  ['code-embedding', 'embedding', 'reranker', 'code-assistant', 'rlm'];

export interface OpenRouterProbeResult {
  role: VirtualRole;
  ok: boolean;
  /** Whole probe, all sidecars in parallel. */
  ms: number;
  /** Model asked for (the pushed one). Null when no request was made. */
  model: string | null;
  /** Model the server says it used, when it reports one and it differs. */
  servedModel?: string | null;
  /** Where the request went: provider names, the proxy host, or the RLM route. */
  route: string;
  /** Per-sidecar outcome on success, the error text on failure. */
  message: string;
  status?: number;
}

export interface OpenRouterProbeDeps {
  enabled?: () => boolean;
  storedModel?: (role: VirtualRole) => string | undefined;
  listContainers?: (role: VirtualRole) => VirtualContainer[];
  embed?: (vc: VirtualContainer, texts: string[], timeoutMs: number) => Promise<VirtualEmbedResponse>;
  rerank?: (vc: VirtualContainer, query: string, docs: string[], opts: { timeoutMs?: number }) => Promise<VirtualRerankResponse>;
  chat?: (system: string, user: string, opts: { maxTokens?: number; timeoutMs?: number; role?: string }) => Promise<OpenRouterChatResult>;
  rlm?: () => Promise<ProbeResult>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const PING_SYSTEM = 'Reply with the single word OK.';
const PING_USER = 'ping';
const PING_TEXTS = ['connectivity probe from the OpenRouter page', 'second text so a batch of two comes back'];
const PING_DOCS = ['a document about ping', 'a document about something else'];

function clip(s: string, n = 300): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

async function defaults(deps: OpenRouterProbeDeps): Promise<Required<Omit<OpenRouterProbeDeps, 'timeoutMs'>> & { timeoutMs: number }> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const need = !deps.enabled || !deps.storedModel || !deps.listContainers;
  const cfg = need ? await import('../sidecars/virtualContainers.js') : null;
  const or = !deps.storedModel ? await import('../sidecars/openRouterConfig.js') : null;
  const inf = (!deps.embed || !deps.rerank) ? await import('../sidecars/virtualInferenceClient.js') : null;
  const chatMod = !deps.chat ? await import('../sidecars/openRouterChat.js') : null;
  const probeMod = !deps.rlm ? await import('./llmProviderProbe.js') : null;
  return {
    enabled: deps.enabled ?? (() => cfg!.getVirtualContainersConfig().enabled),
    storedModel: deps.storedModel ?? ((role) => role === 'rlm'
      ? or!.getOpenRouterSettings().rlmSandboxModel
      : or!.getOpenRouterSettings().allowedModels[role]?.model),
    listContainers: deps.listContainers ?? ((role) => cfg!.listVirtualContainers(role)),
    embed: deps.embed ?? ((vc, texts, t) => inf!.virtualEmbed(vc, texts, t)),
    rerank: deps.rerank ?? ((vc, q, d, o) => inf!.virtualRerank(vc, q, d, o)),
    chat: deps.chat ?? ((s, u, o) => chatMod!.openRouterChat(s, u, o)),
    rlm: deps.rlm ?? (() => probeMod!.probeProvider('rlm', { timeoutMs })),
    timeoutMs,
  };
}

function disabled(role: VirtualRole): OpenRouterProbeResult {
  return {
    role, ok: false, ms: 0, model: null, route: 'not sent',
    message: 'OpenRouter is disabled on this page, so nothing calls out. Enable it and save first.',
  };
}

/**
 * Embedders and the reranker: every sidecar that advertises the role is asked
 * at once. The role passes when at least one answers, which is the same bar
 * the fan-out applies; the message still names each host so a half-dead
 * fleet is visible.
 */
async function probeContainers(
  role: VirtualRole,
  vcs: VirtualContainer[],
  call: (vc: VirtualContainer) => Promise<{ model?: string | null; detail: string }>,
): Promise<OpenRouterProbeResult> {
  if (!vcs.length) {
    return {
      role, ok: false, ms: 0, model: null, route: 'no provider',
      message: `no sidecar advertises an OpenRouter ${role} provider for this master. `
        + 'Check that the key push reached the sidecars (Connection above) and that the routing policy is not "local only".',
    };
  }
  const t0 = Date.now();
  const outs = await Promise.all(vcs.map(async (vc) => {
    const s = Date.now();
    try {
      const r = await call(vc);
      return { vc, ok: true, ms: Date.now() - s, detail: r.detail, model: r.model ?? null };
    } catch (err) {
      return { vc, ok: false, ms: Date.now() - s, detail: clip((err as Error).message), model: null };
    }
  }));
  const asked = vcs[0].model ?? null;
  const served = outs.find(o => o.ok && o.model && o.model !== asked)?.model ?? null;
  return {
    role,
    ok: outs.some(o => o.ok),
    ms: Date.now() - t0,
    model: asked,
    servedModel: served,
    route: vcs.map(v => v.providerName).join(', '),
    message: outs.map(o => `${o.vc.sidecarName}: ${o.ok ? '✓' : '×'} ${o.ms} ms ${o.detail}`).join(' · '),
  };
}

async function probeEmbed(role: 'code-embedding' | 'embedding', d: Awaited<ReturnType<typeof defaults>>): Promise<OpenRouterProbeResult> {
  return probeContainers(role, d.listContainers(role), async (vc) => {
    const r = await d.embed(vc, PING_TEXTS, d.timeoutMs);
    const n = r.embeddings?.length ?? 0;
    const dims = r.dims ?? r.embeddings?.[0]?.length ?? 0;
    if (n !== PING_TEXTS.length || !dims) throw new Error(`returned ${n} vectors (${dims}d) for ${PING_TEXTS.length} texts`);
    return { model: r.model, detail: `${n} vectors · ${dims}d${vc.dims && vc.dims !== dims ? ` (expected ${vc.dims}d)` : ''}` };
  });
}

async function probeRerank(d: Awaited<ReturnType<typeof defaults>>): Promise<OpenRouterProbeResult> {
  return probeContainers('reranker', d.listContainers('reranker'), async (vc) => {
    const r = await d.rerank(vc, 'ping', PING_DOCS, { timeoutMs: d.timeoutMs });
    const n = r.results?.length ?? 0;
    if (!n) throw new Error('returned no ranked results');
    return { model: r.model, detail: `${n} ranked · top index ${r.results![0].index}` };
  });
}

/** The chat proxy picks the host and the slot's allow-listed model itself. */
async function probeChat(d: Awaited<ReturnType<typeof defaults>>): Promise<OpenRouterProbeResult> {
  const t0 = Date.now();
  const asked = d.storedModel('code-assistant') ?? null;
  try {
    const out = await d.chat(PING_SYSTEM, PING_USER, { maxTokens: 16, timeoutMs: d.timeoutMs, role: 'code-assistant' });
    return {
      role: 'code-assistant', ok: true, ms: Date.now() - t0, model: asked,
      servedModel: out.model && out.model !== asked ? out.model : null,
      route: `sidecar OpenRouter chat proxy on ${out.servedBy}`,
      message: clip(out.text) || 'replied with no text',
    };
  } catch (err) {
    return {
      role: 'code-assistant', ok: false, ms: Date.now() - t0, model: asked,
      route: 'sidecar OpenRouter chat proxy', message: clip((err as Error).message),
    };
  }
}

async function probeRlm(d: Awaited<ReturnType<typeof defaults>>): Promise<OpenRouterProbeResult> {
  const r = await d.rlm();
  return { role: 'rlm', ok: r.ok, ms: r.ms, model: r.model, servedModel: r.servedModel, route: r.route, message: r.message, status: r.status };
}

export async function probeOpenRouterRole(role: VirtualRole, deps: OpenRouterProbeDeps = {}): Promise<OpenRouterProbeResult> {
  const d = await defaults(deps);
  // RLM with a `direct:` model needs no OpenRouter at all, so it is exempt.
  if (role !== 'rlm' && !d.enabled()) return disabled(role);
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
