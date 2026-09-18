/**
 * OpenRouter "virtual container" discovery.
 *
 * Sound Suite sidecar 2.4.2+ can route a role to OpenRouter instead of its
 * local model. Each such (master, role) pair is a *virtual container*: real
 * serving capacity with no GPU and no VRAM. Fantom treats each one as a
 * SEPARATE logical provider named `<PCName>-OR-<Role>` (e.g.
 * `BASWS35-OR-CodeEmbedding`) so embedding can fan out over local GPUs *and*
 * cloud at the same time, and so rerank has a backend at all.
 *
 * ── Where the data lives (verified against live sidecars 2026-09-15) ───────
 *
 * The sidecar exposes virtual containers ONLY in its HTTP `GET /api/status`,
 * nested per master:
 *
 *   masters: [
 *     { serverUrl, wsPort, virtualInference: { openrouter, modeByRole, … },
 *       virtualContainers: [ { role, model, provider, dims, mode, … } ] },
 *     …
 *   ]
 *
 * Two consequences that shape this module:
 *
 * 1. **The WS heartbeat does NOT carry it.** The `statusData` the sidecar
 *    pushes to us is a trimmed snapshot (agentUrl, hostname, containers,
 *    roles, gpus, vram, tasks …) with no `masters` key at all — confirmed by
 *    reading the live master's own /api/admin/gpu/sidecars/snapshot. So
 *    discovery has to poll `/api/status` over HTTP; mining the heartbeat
 *    would silently find nothing forever.
 *
 * 2. **Capacity is scoped to the master that owns it.** virtual-inference.ts
 *    keys every OpenRouter config by `serverUrl` (`G.byMaster`), and an absent
 *    entry means local-only for every role. A master's key and allow-list are
 *    never applied to a request that arrived under a different master's slot.
 *    Today the live sidecars have OpenRouter configured for the Sound Suite
 *    master (:3000) and `"openrouter": "unset"` for Fantom's slot (:3848).
 *    Parsing the *other* master's virtualContainers into Fantom providers
 *    would manufacture exactly the phantom capacity the task doc warns about:
 *    they would fail at request time with a `local` routing decision. So we
 *    filter `masters[]` down to OUR OWN slot and accept finding nothing.
 *
 * Ownership is matched on `wsPort` — the sidecar records the master's wsPort
 * during the `master-identity` handshake, and Fantom's own listener port is
 * authoritative and local (`sidecarMasterWsPort`, default 3003). An explicit
 * `masterServerUrl` in config overrides it when the deployment needs one.
 *
 * Key hygiene: nothing here reads, stores, logs or transports an OpenRouter
 * API key. The sidecar holds it; Fantom only ever names a provider and model.
 */

import * as fs from 'fs';
import * as path from 'path';
import { listSidecars, getSidecar, sidecarUrl } from './registry.js';
import type { Sidecar } from '../admin/types.js';

const RUNTIME_CONFIG_PATH = path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');

export type VirtualRoutingMode = 'local-only' | 'local-first' | 'cloud-only';
export const VIRTUAL_ROUTING_MODES: VirtualRoutingMode[] = ['local-only', 'local-first', 'cloud-only'];

/**
 * Sidecar role names, as they appear in the virtual-container rows.
 *
 * `code-assistant` is a CHAT-completion role, unlike the other three. It is
 * carried here because the sidecar treats `role` as an opaque string in its
 * virtual-inference config, so the model, mode and allow-list push, store and
 * report exactly like the others — but NOTHING SERVES IT YET: `ws-client.ts`
 * has `virtual-embed`, `virtual-rerank` and `virtual-key-info` and no chat
 * action. See openRouterModels.ts for what is still needed.
 */
export type VirtualRole = 'embedding' | 'code-embedding' | 'reranker' | 'code-assistant' | 'rlm';
export const VIRTUAL_ROLES: VirtualRole[] = ['embedding', 'code-embedding', 'reranker', 'code-assistant', 'rlm'];

/** Roles whose requests Fantom can actually issue today. */
/**
 * `rlm` is servable even though no `<PC>-OR-Rlm` container exists: the role is
 * served by `ss-rlm-sandbox`, a container the SIDECAR runs, reached over HTTP
 * on :8101 rather than through a virtual provider. What `servable` answers is
 * "does anything actually execute this role", and for rlm the answer is yes —
 * see docs/tasks/ss-rlm-sandbox-2026-09-15.md.
 *
 * `code-assistant` remains the only unservable role: nothing issues its
 * requests under any policy.
 */
export const SERVABLE_VIRTUAL_ROLES: VirtualRole[] = ['embedding', 'code-embedding', 'reranker', 'rlm'];

/** False for a role the sidecar can be configured for but cannot yet serve. */
export function isRoleServable(role: VirtualRole): boolean {
  return (SERVABLE_VIRTUAL_ROLES as string[]).includes(role);
}

/**
 * One OpenRouter-backed provider, as Fantom sees it. Mirrors the sidecar's
 * `VirtualContainerInfo` plus the Fantom-side identity (sidecarId, provider
 * name) and where the row came from.
 */
export interface VirtualContainer {
  /** Registry id of the host sidecar — the WS tunnel we send commands down. */
  sidecarId: string;
  /** Registry name of the host sidecar, e.g. `mcpserver.local`. */
  sidecarName: string;
  /** `<PCName>-OR-<Role>`, e.g. `mcpserver-OR-CodeEmbedding`. */
  providerName: string;
  role: VirtualRole;
  /** OpenRouter model slug, e.g. `qwen/qwen3-embedding-4b`. */
  model: string;
  /** Pinned upstream provider. Embeddings REQUIRE one (two upstreams serving
   *  the same model can return different vectors); rerank does not. */
  upstreamProvider?: string;
  dims?: number;
  mode: VirtualRoutingMode;
  /** 'sidecar' = advertised by the sidecar for our own master slot.
   *  'config'  = declared locally in the allow-list while the sidecar side
   *              has not been configured yet. Never trusted for embedding
   *              until the compatibility gate passes. */
  source: 'sidecar' | 'config';
  served?: number;
  /** Epoch ms of the last request this container served, or null. */
  lastServedAt?: number | null;
  failures?: number;
  lastError?: string | null;
  lastDurationMs?: number | null;
  state?: 'idle' | 'serving' | 'failed';
  /** Master slot this row belongs to — always Fantom's own. Shown in the
   *  admin table so an operator can see at a glance that it is ours and not
   *  the Sound Suite master's. */
  serverUrl?: string;
  /** When this row was last refreshed from /api/status (ms epoch). */
  observedAt?: number;
}

/** A locally declared virtual container, used until the sidecar advertises. */
export interface DeclaredVirtualContainer {
  /** Sidecar name or PCName (`.local` optional). */
  sidecar: string;
  role: VirtualRole;
  model: string;
  provider?: string;
  dims?: number;
  mode?: VirtualRoutingMode;
}

export interface VirtualContainersConfig {
  /** Master feature flag. Default true — discovery is harmless when the
   *  sidecar advertises nothing for our slot (it yields zero providers). */
  enabled: boolean;
  /** Restrict to these PCNames. Empty/absent = allow every discovered host. */
  allowList?: string[];
  /** Locally declared rows — the escape hatch for "the field has not landed
   *  on the sidecar yet". Off unless populated. */
  declared?: DeclaredVirtualContainer[];
  /** Exact serverUrl of Fantom's master slot, if wsPort matching is wrong. */
  masterServerUrl?: string;
  /** How often to re-poll /api/status, ms. Default 60s. */
  pollIntervalMs?: number;
  /** Rerank model Fantom wants. The sidecar's allow-list is authoritative;
   *  this is what we *ask* for and what we warn against when it differs. */
  rerankModel?: string;
  /** If true, send `model` as `requestedModel` on virtual-rerank — the
   *  sidecar then hard-refuses anything not allow-listed. Default false so a
   *  sidecar allow-list that names a different model still serves. */
  strictRerankModel?: boolean;
  /** In-flight depth per OR embedding provider. OpenRouter rate limits are
   *  per-account, so start conservative. Default 8. */
  embedMaxInFlight?: number;
}

/**
 * Default rerank model. `qwen/qwen3-reranker-8b` is what the Sound Suite
 * master slot already pins in this environment, so it is proven here — and it
 * is the only reranker size on OpenRouter with a provider actually serving it.
 *
 * It is configurable (`virtualContainers.rerankModel`, and the dropdown on the
 * config page) should another reranker become usable on this account.
 */
export const DEFAULT_OR_RERANK_MODEL = 'qwen/qwen3-reranker-8b';
export const DEFAULT_OR_EMBED_MAX_IN_FLIGHT = 8;
const DEFAULT_POLL_INTERVAL_MS = 60_000;

function readRuntimeConfig(): any {
  try {
    if (!fs.existsSync(RUNTIME_CONFIG_PATH)) return {};
    return JSON.parse(fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf-8')) ?? {};
  } catch {
    return {};
  }
}

export function getVirtualContainersConfig(): VirtualContainersConfig {
  const raw = readRuntimeConfig()?.semanticSearch?.virtualContainers ?? {};
  return {
    // OFF by default. Cloud routing costs real money against a shared key, so
    // it is opt-in: until the operator ticks "Enable OpenRouter" on the config
    // page, discovery returns nothing and every role stays local.
    enabled: raw.enabled === true,
    allowList: Array.isArray(raw.allowList) ? raw.allowList.map(String) : undefined,
    declared: Array.isArray(raw.declared) ? raw.declared as DeclaredVirtualContainer[] : undefined,
    masterServerUrl: typeof raw.masterServerUrl === 'string' ? raw.masterServerUrl : undefined,
    pollIntervalMs: typeof raw.pollIntervalMs === 'number' && raw.pollIntervalMs > 0
      ? raw.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS,
    rerankModel: typeof raw.rerankModel === 'string' && raw.rerankModel
      ? raw.rerankModel : DEFAULT_OR_RERANK_MODEL,
    strictRerankModel: raw.strictRerankModel === true,
    embedMaxInFlight: typeof raw.embedMaxInFlight === 'number' && raw.embedMaxInFlight > 0
      ? raw.embedMaxInFlight : DEFAULT_OR_EMBED_MAX_IN_FLIGHT,
  };
}

/** Fantom's own Sound Suite master WS port. Mirrors soundsuiteMaster's
 *  resolution order so ownership matching can't drift from the listener. */
export function readMasterWsPort(): number {
  const fromEnv = process.env.FANTOM_SIDECAR_WS_PORT;
  if (fromEnv && Number.isFinite(Number(fromEnv))) return Number(fromEnv);
  const cfg = readRuntimeConfig();
  if (typeof cfg?.sidecarMasterWsPort === 'number' && cfg.sidecarMasterWsPort > 0) {
    return cfg.sidecarMasterWsPort;
  }
  return 3003;
}

// ─── Naming ────────────────────────────────────────────────────────────────

/** Sidecar hostname → PCName: strip a trailing `.local` (case-insensitive). */
export function pcName(hostname: string): string {
  return hostname.replace(/\.local$/i, '');
}

const ROLE_LABEL: Record<VirtualRole, string> = {
  'embedding': 'Embedding',
  'code-embedding': 'CodeEmbedding',
  'reranker': 'Reranker',
  'code-assistant': 'CodeAssistant',
  // Named for consistency, though no `<PC>-OR-Rlm` provider is created: the
  // role is served by the sidecar's own ss-rlm-sandbox container over HTTP,
  // not by a virtual provider Fantom registers.
  'rlm': 'Rlm',
};

/** `<PCName>-OR-<Role>`, e.g. `BASWS35-OR-CodeEmbedding`. */
export function virtualProviderName(sidecarName: string, role: VirtualRole): string {
  return `${pcName(sidecarName)}-OR-${ROLE_LABEL[role]}`;
}

// ─── Parsing ───────────────────────────────────────────────────────────────

function asRole(v: unknown): VirtualRole | null {
  return typeof v === 'string' && (VIRTUAL_ROLES as string[]).includes(v) ? v as VirtualRole : null;
}

function asMode(v: unknown): VirtualRoutingMode {
  return typeof v === 'string' && (VIRTUAL_ROUTING_MODES as string[]).includes(v)
    ? v as VirtualRoutingMode
    : 'local-only';
}

export interface MasterSlotMatch {
  serverUrl?: string;
  openrouter?: 'configured' | 'unset';
  modeByRole?: Record<string, VirtualRoutingMode>;
  rows: VirtualContainer[];
}

/**
 * Pull OUR master slot's virtual containers out of a `/api/status` payload.
 *
 * Exported for tests and for the admin surface, which reports the full
 * picture (including the other master's configured-but-not-ours capacity) so
 * an operator can see *why* Fantom has no cloud providers.
 */
export function parseOwnVirtualContainers(
  status: unknown,
  sidecar: Pick<Sidecar, 'id' | 'name'>,
  opts: { wsPort: number; masterServerUrl?: string } = { wsPort: 3003 },
): MasterSlotMatch {
  const masters = (status as any)?.masters;
  if (!Array.isArray(masters)) return { rows: [] };

  const own = masters.find((m: any) => {
    if (!m || typeof m !== 'object') return false;
    if (opts.masterServerUrl) return m.serverUrl === opts.masterServerUrl;
    return Number(m.wsPort) === Number(opts.wsPort);
  });
  if (!own) return { rows: [] };

  const rows: VirtualContainer[] = [];
  const containers = Array.isArray(own.virtualContainers) ? own.virtualContainers : [];
  const now = Date.now();
  for (const c of containers) {
    const role = asRole(c?.role);
    if (!role) continue;
    if (typeof c?.model !== 'string' || !c.model) continue;
    rows.push({
      sidecarId: sidecar.id,
      sidecarName: sidecar.name,
      providerName: virtualProviderName(sidecar.name, role),
      role,
      model: c.model,
      upstreamProvider: typeof c.provider === 'string' && c.provider ? c.provider : undefined,
      dims: typeof c.dims === 'number' && c.dims > 0 ? c.dims : undefined,
      mode: asMode(c.mode),
      source: 'sidecar',
      serverUrl: typeof own.serverUrl === 'string' ? own.serverUrl : undefined,
      served: typeof c.served === 'number' ? c.served : 0,
      lastServedAt: typeof c.lastServedAt === 'number' ? c.lastServedAt : null,
      failures: typeof c.failures === 'number' ? c.failures : 0,
      lastError: typeof c.lastError === 'string' ? c.lastError : null,
      lastDurationMs: typeof c.lastDurationMs === 'number' ? c.lastDurationMs : null,
      state: c.state === 'serving' || c.state === 'failed' ? c.state : 'idle',
      observedAt: now,
    });
  }
  return {
    serverUrl: typeof own.serverUrl === 'string' ? own.serverUrl : undefined,
    openrouter: own?.virtualInference?.openrouter === 'configured' ? 'configured' : 'unset',
    modeByRole: own?.virtualInference?.modeByRole ?? {},
    rows,
  };
}

// ─── Store ─────────────────────────────────────────────────────────────────

/** sidecarId → discovered rows. In-memory only: this is volatile fleet state
 *  and must NOT churn `fantomMcpServer-config.json`, which has three
 *  co-writers already and a history of losing dashboard settings to a torn
 *  read/write cycle. */
const discovered = new Map<string, VirtualContainer[]>();
/** sidecarId → last observed openrouter presence for our slot, for admin. */
const slotStatus = new Map<string, { serverUrl?: string; openrouter: 'configured' | 'unset'; at: number }>();

export function recordDiscovered(sidecarId: string, match: MasterSlotMatch): void {
  discovered.set(sidecarId, match.rows);
  slotStatus.set(sidecarId, {
    serverUrl: match.serverUrl,
    openrouter: match.openrouter ?? 'unset',
    at: Date.now(),
  });
}

export function forgetDiscovered(sidecarId: string): void {
  discovered.delete(sidecarId);
  slotStatus.delete(sidecarId);
}

/** Test seam. */
export function __resetVirtualContainersForTest(): void {
  discovered.clear();
  slotStatus.clear();
}

export function getSlotStatus(): Array<{ sidecarId: string; serverUrl?: string; openrouter: string; at: number }> {
  return [...slotStatus.entries()].map(([sidecarId, v]) => ({ sidecarId, ...v }));
}

function allowed(cfg: VirtualContainersConfig, sidecarName: string): boolean {
  if (!cfg.allowList || cfg.allowList.length === 0) return true;
  const want = pcName(sidecarName).toLowerCase();
  return cfg.allowList.some(a => pcName(a).toLowerCase() === want);
}

function declaredRows(cfg: VirtualContainersConfig): VirtualContainer[] {
  if (!cfg.declared || cfg.declared.length === 0) return [];
  const sidecars = listSidecars({ enabled: true });
  const out: VirtualContainer[] = [];
  for (const d of cfg.declared) {
    const role = asRole(d.role);
    if (!role || typeof d.model !== 'string' || !d.model) continue;
    const want = pcName(String(d.sidecar ?? '')).toLowerCase();
    const sc = sidecars.find(s => pcName(s.name).toLowerCase() === want);
    if (!sc) continue;
    out.push({
      sidecarId: sc.id,
      sidecarName: sc.name,
      providerName: virtualProviderName(sc.name, role),
      role,
      model: d.model,
      upstreamProvider: d.provider,
      dims: d.dims,
      mode: asMode(d.mode ?? 'local-first'),
      source: 'config',
    });
  }
  return out;
}

/**
 * Every virtual container Fantom may use right now, optionally narrowed to a
 * role. Discovered rows win over declared ones for the same (sidecar, role).
 *
 * `local-only` rows are excluded: the sidecar will refuse to serve them over
 * OpenRouter, so surfacing them as providers would be a phantom by another
 * name. Callers wanting the raw picture use `listAllVirtualContainers`.
 */
export function listVirtualContainers(role?: VirtualRole): VirtualContainer[] {
  return listAllVirtualContainers(role).filter(v => v.mode !== 'local-only');
}

export function listAllVirtualContainers(role?: VirtualRole): VirtualContainer[] {
  const cfg = getVirtualContainersConfig();
  if (!cfg.enabled) return [];

  const byKey = new Map<string, VirtualContainer>();
  for (const row of declaredRows(cfg)) byKey.set(`${row.sidecarId}:${row.role}`, row);
  for (const rows of discovered.values()) {
    for (const row of rows) byKey.set(`${row.sidecarId}:${row.role}`, row);
  }

  const out: VirtualContainer[] = [];
  for (const row of byKey.values()) {
    if (role && row.role !== role) continue;
    if (!allowed(cfg, row.sidecarName)) continue;
    const sc = getSidecar(row.sidecarId);
    if (!sc || !sc.enabled) continue;
    out.push(row);
  }
  // Stable order so fan-out chunking and logs are reproducible.
  out.sort((a, b) => a.providerName.localeCompare(b.providerName));
  return out;
}

// ─── Discovery poll ────────────────────────────────────────────────────────

/**
 * Probe one sidecar's `/api/status` and record our slot's virtual containers.
 * Returns the parsed match, or null when the sidecar is unreachable.
 */
export async function refreshVirtualContainers(
  sidecarId: string,
  timeoutMs = 8_000,
): Promise<MasterSlotMatch | null> {
  const sc = getSidecar(sidecarId);
  if (!sc) return null;
  const cfg = getVirtualContainersConfig();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {};
    if (sc.authToken) headers['Authorization'] = `Bearer ${sc.authToken}`;
    const res = await fetch(`${sidecarUrl(sc)}/api/status`, { headers, signal: ctrl.signal });
    if (!res.ok) return null;
    const json = await res.json();
    const match = parseOwnVirtualContainers(json, sc, {
      wsPort: readMasterWsPort(),
      masterServerUrl: cfg.masterServerUrl,
    });
    recordDiscovered(sidecarId, match);
    return match;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshAllVirtualContainers(): Promise<VirtualContainer[]> {
  const cfg = getVirtualContainersConfig();
  if (!cfg.enabled) return [];
  const sidecars = listSidecars({ enabled: true });
  await Promise.all(sidecars.map(s => refreshVirtualContainers(s.id).catch(() => null)));
  const rows = listVirtualContainers();
  if (rows.length === 0) {
    const unset = getSlotStatus().filter(s => s.openrouter !== 'configured').length;
    if (unset > 0) {
      console.log(
        `[virtual-containers] no OpenRouter capacity for Fantom's master slot (wsPort=${readMasterWsPort()}): `
        + `${unset} sidecar(s) report openrouter="unset" for it. The sidecar scopes its OpenRouter key and `
        + `allow-list per master, so capacity configured for another master is deliberately not usable here. `
        + `Push an OpenRouter config (apiKey, allowedModels, modeByRole) to Fantom's master slot on each sidecar.`,
      );
    }
  } else {
    console.log(`[virtual-containers] ${rows.length} provider(s): ${rows.map(r => `${r.providerName}(${r.model}, ${r.mode})`).join(', ')}`);
  }
  return rows;
}

let pollTimer: NodeJS.Timeout | null = null;

export function startVirtualContainerDiscovery(): void {
  if (pollTimer) return;
  const cfg = getVirtualContainersConfig();
  if (!cfg.enabled) {
    console.log('[virtual-containers] disabled — tick "Enable OpenRouter" in the config page\'s '
      + 'OpenRouter section (semanticSearch.virtualContainers.enabled) to turn cloud routing on');
    return;
  }
  void refreshAllVirtualContainers().catch(() => {});
  pollTimer = setInterval(() => {
    void refreshAllVirtualContainers().catch(() => {});
  }, cfg.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  pollTimer.unref?.();
}

export function stopVirtualContainerDiscovery(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
