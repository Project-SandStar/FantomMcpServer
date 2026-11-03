/**
 * Automatic OpenRouter re-push, and the per-slot health the dashboard warns on.
 *
 * The sidecar scopes its OpenRouter config per master URL and keeps it in
 * memory. Two everyday events leave Fantom's slot "unset" with no error:
 *   - the sidecar restarts (config lost), and
 *   - Fantom moves to a new URL (e.g. the Docker deployment), so the sidecar
 *     opens a fresh, empty slot for it.
 * Under "OpenRouter only" that silently stops every embed with
 * `no-cloud-provider-discovered`, while the dashboard still says a key "is
 * stored" because `keyPushed` is one flag for the whole server.
 *
 * `autoPushUnsetSlots` runs after each discovery poll and re-pushes the stored
 * config, WITH the key, to just the sidecars whose slot reports "unset". A push
 * without a key would be dropped by the sidecar, so with no key available it
 * does nothing and `describeSlotHealth` says why. It never writes the config
 * file (that file has three co-writers already) and each sidecar has a
 * cooldown so an ignored push is not repeated every poll.
 */
import { listSidecars } from './registry.js';
import { pushConfigToSidecar, isSoundSuiteSidecarConnected } from './soundsuiteMaster.js';
import { getSlotStatus, getVirtualContainersConfig } from './virtualContainers.js';
import {
  availablePushKey,
  buildOpenRouterPushPayload,
  getOpenRouterSettings,
  type PushKeySource,
} from './openRouterConfig.js';

/** Minimum gap between two automatic pushes to the same sidecar. */
export const AUTO_PUSH_COOLDOWN_MS = 5 * 60_000;

const lastAutoPush = new Map<string, { at: number; ok: boolean }>();
let loggedNoKey = false;

export interface AutoPushOutcome {
  sidecarId: string;
  name: string;
  pushed: boolean;
  reason?: string;
}

/** Test seam. */
export function __resetAutoPushForTest(): void {
  lastAutoPush.clear();
  loggedNoKey = false;
}

/**
 * Re-push the stored config, with the key, to every connected sidecar whose
 * slot for Fantom reports "unset". Returns what it did, for logs and tests.
 */
export function autoPushUnsetSlots(now: number = Date.now()): AutoPushOutcome[] {
  if (!getVirtualContainersConfig().enabled) return [];
  const settings = getOpenRouterSettings();
  if (Object.keys(settings.allowedModels).length === 0) return [];

  const unset = getSlotStatus().filter(s => s.openrouter !== 'configured');
  if (unset.length === 0) {
    loggedNoKey = false;
    return [];
  }

  const key = availablePushKey();
  if (!key) {
    if (!loggedNoKey) {
      loggedNoKey = true;
      console.warn(
        `[openrouter] ${unset.length} sidecar slot(s) for Fantom report openrouter="unset" and no key is `
        + 'available to re-key them. Paste the key on the config page\'s OpenRouter section, or set '
        + 'FANTOM_OPENROUTER_API_KEY in the server env so this re-push happens on its own.',
      );
    }
    return [];
  }
  loggedNoKey = false;

  const byId = new Map(listSidecars({ enabled: true }).map(s => [s.id, s]));
  const { payload } = buildOpenRouterPushPayload(settings, key.key);
  const out: AutoPushOutcome[] = [];
  for (const slot of unset) {
    const sc = byId.get(slot.sidecarId);
    if (!sc) continue;
    const prev = lastAutoPush.get(sc.id);
    if (prev && now - prev.at < AUTO_PUSH_COOLDOWN_MS) continue;
    if (!isSoundSuiteSidecarConnected(sc.id)) {
      out.push({ sidecarId: sc.id, name: sc.name, pushed: false, reason: 'no open WS tunnel' });
      continue;
    }
    const ok = pushConfigToSidecar(sc.id, payload);
    lastAutoPush.set(sc.id, { at: now, ok });
    out.push({ sidecarId: sc.id, name: sc.name, pushed: ok, reason: ok ? undefined : 'send failed' });
  }

  const pushed = out.filter(o => o.pushed).map(o => o.name);
  if (pushed.length > 0) {
    console.log(
      `[openrouter] auto-push: slot was "unset" on ${pushed.join(', ')} — re-pushed the stored config with `
      + `the ${key.source === 'env' ? 'FANTOM_OPENROUTER_API_KEY env' : 'stored'} key`,
    );
  }
  return out;
}

export interface SlotHealth {
  /** Enabled sidecars whose slot for Fantom reports "unset". */
  unset: Array<{ sidecarId: string; name: string; serverUrl?: string; lastAutoPushAt: number | null }>;
  /** Enabled, WS-connected sidecars with no slot reading at all (status probe failed). */
  unknown: Array<{ sidecarId: string; name: string }>;
  /** Where an automatic push would take the key from; null = none, so no auto-push. */
  keySource: PushKeySource | null;
  /** True when the stored `keyPushed` flag contradicts the fleet: a key "is stored" but slots are unset. */
  keyFlagStale: boolean;
}

/**
 * Per-slot view for the dashboard. Returns null before the first discovery
 * poll has recorded any slot, so a fresh boot does not flash a false warning.
 */
export function describeSlotHealth(keyPushed: boolean): SlotHealth | null {
  if (!getVirtualContainersConfig().enabled) return null;
  const slots = getSlotStatus();
  if (slots.length === 0) return null;
  const sidecars = listSidecars({ enabled: true });
  const nameOf = new Map(sidecars.map(s => [s.id, s.name]));
  const seen = new Set(slots.map(s => s.sidecarId));

  const unset = slots
    .filter(s => s.openrouter !== 'configured' && nameOf.has(s.sidecarId))
    .map(s => ({
      sidecarId: s.sidecarId,
      name: nameOf.get(s.sidecarId)!,
      serverUrl: s.serverUrl,
      lastAutoPushAt: lastAutoPush.get(s.sidecarId)?.at ?? null,
    }));
  const unknown = sidecars
    .filter(s => !seen.has(s.id) && isSoundSuiteSidecarConnected(s.id))
    .map(s => ({ sidecarId: s.id, name: s.name }));

  return {
    unset,
    unknown,
    keySource: availablePushKey()?.source ?? null,
    keyFlagStale: keyPushed && unset.length > 0,
  };
}
