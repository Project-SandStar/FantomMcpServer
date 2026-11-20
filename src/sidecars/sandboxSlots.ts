/**
 * Fantom's sandbox slot on each sidecar.
 *
 * Fantom calls OpenRouter itself for every role (2026-11-19). The one thing a
 * sidecar still needs from us is what ss-rlm-sandbox (the container on its
 * :8101) needs to run a whole-question session for Fantom: our key, the
 * sandbox model and our domain. The sidecar files that per master URL
 * (`openrouter.enc.json`) and the sandbox calls OpenRouter directly with it,
 * so the spend lands on our key.
 *
 * Payload, a strict subset of the old role push (an old sidecar accepts it,
 * a new one ignores roles it no longer serves):
 *   { openrouter: { apiKey, allowedModels: { 'rlm-sandbox': { model } }, domain: 'code' } }
 * or `{ openrouter: null }` (clears our slot) when there is no sandbox key or
 * model. The key is the SANDBOX key (FANTOM_OPENROUTER_SANDBOX_KEY), never the
 * main key: the sandbox runs model-written code next to the key.
 *
 * This module also reads each sidecar's `/api/status` once a minute to learn
 * the master URL it files us under (needed for the identity headers on every
 * sandbox call) and whether our slot is set; an unset slot (sidecar restart)
 * is re-pushed with the key, at most once per 5 minutes per sidecar.
 */
import { listSidecars, getSidecar, sidecarUrl } from './registry.js';
import { pushConfigToSidecar, isSoundSuiteSidecarConnected } from './soundsuiteMaster.js';
import { readConfigFileWithRecovery } from '../config/index.js';
import { sandboxKey } from '../openrouter/key.js';
import path from 'path';

const POLL_MS = 60_000;
const REPUSH_COOLDOWN_MS = 5 * 60_000;

export interface SandboxSlot {
  sidecarId: string;
  name: string;
  serverUrl?: string;
  openrouter: 'configured' | 'unset' | 'unknown';
  at: number;
  lastPushAt?: number;
  lastPushOk?: boolean;
}

const slots = new Map<string, SandboxSlot>();
let timer: NodeJS.Timeout | null = null;

function readConfig(): any {
  try { return readConfigFileWithRecovery(path.join(process.cwd(), 'config', 'fantomMcpServer-config.json')); } catch { return {}; }
}

export function readMasterWsPort(): number {
  const fromEnv = process.env.FANTOM_SIDECAR_WS_PORT;
  if (fromEnv && Number.isFinite(Number(fromEnv))) return Number(fromEnv);
  const cfg = readConfig();
  if (typeof cfg?.sidecarMasterWsPort === 'number' && cfg.sidecarMasterWsPort > 0) return cfg.sidecarMasterWsPort;
  return 3003;
}

/** Optional override when matching by WS port is wrong for a deployment. */
function configuredMasterUrl(): string | undefined {
  const s = readConfig()?.semanticSearch;
  const v = s?.openRouter?.masterServerUrl ?? s?.virtualContainers?.masterServerUrl;
  return typeof v === 'string' && v ? v : undefined;
}

/** The sandbox model the sidecar should run for us (an OpenRouter id), or null. */
export function sandboxModelForPush(): string | null {
  const raw = readConfig()?.semanticSearch?.openRouter?.rlmSandboxModel;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  // A `direct:<provider>:<model>` id runs on that provider's own API; the
  // sandbox needs an OpenRouter model, so it gets the default instead.
  if (raw.startsWith('direct:')) return DEFAULT_SANDBOX_MODEL;
  return raw.trim();
}
export const DEFAULT_SANDBOX_MODEL = 'deepseek/deepseek-v4-flash';

/**
 * Pure: the `config` frame payload. `sandboxApiKey` must be the sandbox key.
 * Without a key or a model the slot is cleared (`null`): a push with no
 * apiKey would make the sidecar keep the key it already holds, which may be
 * the main key from an older Fantom.
 */
export function buildSandboxPushPayload(model: string | null, sandboxApiKey?: string | null): Record<string, unknown> {
  if (!model || !sandboxApiKey) return { openrouter: null };
  return {
    openrouter: {
      apiKey: sandboxApiKey,
      allowedModels: { 'rlm-sandbox': { model } },
      domain: 'code',
    },
  };
}

/** Why the sandbox is off for Fantom, or null when it can run. */
export function sandboxOffReason(): string | null {
  if (!sandboxKey()) return 'sandbox off: no sandbox key';
  if (!sandboxModelForPush()) return 'sandbox off: no sandbox model';
  return null;
}

/** Parse our own master entry out of a sidecar `/api/status` reply. */
export function parseOwnSlot(status: unknown, opts: { wsPort: number; masterServerUrl?: string }): { serverUrl?: string; openrouter: 'configured' | 'unset' } | null {
  const masters = (status as any)?.masters;
  if (!Array.isArray(masters)) return null;
  const own = masters.find((m: any) => {
    if (!m || typeof m !== 'object') return false;
    if (opts.masterServerUrl) return m.serverUrl === opts.masterServerUrl;
    return Number(m.wsPort) === Number(opts.wsPort);
  });
  if (!own) return null;
  const state = own?.virtualInference?.openrouter ?? own?.sandbox?.openrouter ?? own?.openrouter;
  return {
    serverUrl: typeof own.serverUrl === 'string' ? own.serverUrl : undefined,
    openrouter: state === 'configured' ? 'configured' : 'unset',
  };
}

/** Push the sandbox slot to one sidecar. */
export function pushSandboxSlot(sidecarId: string): boolean {
  const sc = getSidecar(sidecarId);
  if (!sc || !isSoundSuiteSidecarConnected(sidecarId)) return false;
  const ok = pushConfigToSidecar(sidecarId, buildSandboxPushPayload(sandboxModelForPush(), sandboxKey()));
  const prev = slots.get(sidecarId);
  slots.set(sidecarId, { ...(prev ?? { sidecarId, name: sc.name, openrouter: 'unknown', at: Date.now() }), lastPushAt: Date.now(), lastPushOk: ok });
  return ok;
}

/** Push to every connected sidecar (OpenRouter page save). */
export function pushSandboxSlotsToAll(): Array<{ sidecarId: string; name: string; pushed: boolean }> {
  return listSidecars({ enabled: true }).map(sc => ({ sidecarId: sc.id, name: sc.name, pushed: pushSandboxSlot(sc.id) }));
}

async function refreshOne(sidecarId: string, timeoutMs = 8_000): Promise<void> {
  const sc = getSidecar(sidecarId);
  if (!sc) return;
  try {
    const headers: Record<string, string> = {};
    if (sc.authToken) headers['Authorization'] = `Bearer ${sc.authToken}`;
    const res = await fetch(`${sidecarUrl(sc)}/api/status`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return;
    const own = parseOwnSlot(await res.json(), { wsPort: readMasterWsPort(), masterServerUrl: configuredMasterUrl() });
    const prev = slots.get(sidecarId);
    const next: SandboxSlot = {
      ...(prev ?? {}), sidecarId, name: sc.name,
      serverUrl: own?.serverUrl ?? prev?.serverUrl,
      openrouter: own ? own.openrouter : 'unknown',
      at: Date.now(),
    };
    slots.set(sidecarId, next);
    // A sidecar restart empties our slot: re-key it with the sandbox key.
    // A slot that is set while we have no sandbox key may hold the main key
    // from an older Fantom: clear it.
    const due = !next.lastPushAt || Date.now() - next.lastPushAt > REPUSH_COOLDOWN_MS;
    const canRun = sandboxOffReason() === null;
    if (own && due && ((own.openrouter === 'unset' && canRun) || (own.openrouter === 'configured' && !canRun))) {
      const ok = pushSandboxSlot(sidecarId);
      console.log(`[sandbox-slot] ${sc.name}: slot was ${own.openrouter}, ${canRun ? 're-pushed the sandbox config' : 'cleared it (no sandbox key)'} (${ok ? 'sent' : 'not sent'})`);
    }
  } catch {
    /* unreachable host: keep the last known state */
  }
}

export async function refreshAllSandboxSlots(): Promise<SandboxSlot[]> {
  await Promise.all(listSidecars({ enabled: true }).map(s => refreshOne(s.id).catch(() => undefined)));
  return getSandboxSlots();
}

export function getSandboxSlots(): SandboxSlot[] {
  return [...slots.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function startSandboxSlotPoll(): void {
  if (timer) return;
  void refreshAllSandboxSlots().catch(() => undefined);
  timer = setInterval(() => { void refreshAllSandboxSlots().catch(() => undefined); }, POLL_MS);
  timer.unref?.();
}

export function stopSandboxSlotPoll(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function __resetSandboxSlotsForTest(): void { slots.clear(); stopSandboxSlotPoll(); }

/**
 * The master URL a sidecar files us under. Per host: a LAN host and a NetBird
 * host can file the same master under different addresses.
 */
export function canonicalMasterUrl(sidecarId?: string): string | undefined {
  const own = sidecarId ? slots.get(sidecarId)?.serverUrl : undefined;
  return own ?? configuredMasterUrl() ?? getSandboxSlots().find(s => s.serverUrl)?.serverUrl;
}

/** Identity and domain headers for any call into the sandbox. Both spellings. */
export function masterIdentityHeaders(masterUrl: string): Record<string, string> {
  return {
    'X-FantomMCP-Master': masterUrl,
    'X-SoundSuite-Master': masterUrl,
    'X-FantomMCP-Domain': 'code',
  };
}
