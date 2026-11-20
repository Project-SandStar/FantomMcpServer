/**
 * The sidecar fleet as the dashboard Sidecars tab sees it (GET /admin/sidecars):
 * registry entries plus live WS state (own /ws/sidecars socket or a fresh
 * heartbeat on the Sound Suite master relay) and any embed capability fault.
 *
 * Other features that need "which hosts are up" (e.g. knowledge-card sidecar
 * models) read this, so they show exactly what that tab shows.
 */
import type { Sidecar, SidecarCapabilityKind } from '../admin/types.js';
import { listSidecars, isFreshAndHealthy } from './registry.js';

export interface FleetSidecar extends Sidecar {
  wsConnected: boolean;
  embedFault: unknown;
}

export async function listFleetSidecars(filter?: { capability?: SidecarCapabilityKind; enabled?: boolean }): Promise<FleetSidecar[]> {
  const { isSidecarConnected } = await import('./wsServer.js');
  const { getEmbedFault } = await import('../embedding/providers/embedFaults.js');
  // Sidecars ≥2.x connect to the Sound Suite master relay (ws://:3003/sidecar),
  // not to /ws/sidecars, so ask that listener too: a peer whose last heartbeat
  // over the relay is under 90 s old counts as WS-connected.
  let relayPeers: Array<{ agentUrl: string; lastHeartbeatAgoMs: number | null }> = [];
  try {
    const { getMasterWsListenerStatus } = await import('./soundsuiteMaster.js');
    relayPeers = getMasterWsListenerStatus().peers;
  } catch { /* relay not running */ }
  const relayConnected = (host: string): boolean =>
    relayPeers.some(p => p.agentUrl.includes(`//${host}:`) && p.lastHeartbeatAgoMs !== null && p.lastHeartbeatAgoMs < 90_000);
  return listSidecars(filter).map(s => ({
    ...s,
    wsConnected: isSidecarConnected(s.id) || relayConnected(s.host),
    // Capability fault: up and heartbeating, but its runtime refuses to embed
    // with the advertised model (see embedFaults.ts). null when none.
    embedFault: getEmbedFault(s.id),
  }));
}

/** Online the way the Sidecars tab means it: enabled, not unhealthy, and WS-connected or a fresh healthy heartbeat. */
export function fleetHostOnline(s: FleetSidecar): boolean {
  if (!s.enabled || s.healthStatus === 'unhealthy') return false;
  return s.wsConnected || (s.healthStatus === 'healthy' && isFreshAndHealthy(s));
}

export interface CompletionContainer {
  /** Container name from the heartbeat, e.g. `ss-completion`. */
  container: string;
  /** Model it serves (heartbeat container model, else the `llm` capability). */
  model: string | null;
  /** Heartbeat container status (`running`, `exited`…); null when no snapshot. */
  status: string | null;
}

/**
 * The `completion` role (ss-completion container) on one host, from the same
 * heartbeat snapshot the Sidecars tab fleet table shows, falling back to the
 * `llm` capability that the heartbeat mapped it to.
 */
export async function completionContainerOf(s: Sidecar): Promise<CompletionContainer | null> {
  type Snap = { containers?: Record<string, { name?: string; status?: string; model?: string | null; config?: { model?: string | null } }> };
  let snap: Snap | null = null;
  try {
    const { getCachedSnapshotBySidecarId } = await import('./soundsuiteMaster.js');
    snap = getCachedSnapshotBySidecarId(s.id) as Snap | null;
  } catch { /* relay not running */ }
  const c = snap?.containers?.completion;
  const cap = s.capabilities?.llm;
  if (c) {
    return {
      container: c.name ?? 'ss-completion',
      model: c.model ?? c.config?.model ?? cap?.loaded ?? cap?.models?.[0] ?? null,
      status: c.status ?? null,
    };
  }
  if (cap?.available) return { container: 'ss-completion', model: cap.loaded ?? cap.models?.[0] ?? null, status: null };
  // Listed but not available (the Sidecars tab shows it greyed out): keep it
  // so the card picker can name it as offline.
  if (cap?.models?.length) return { container: 'ss-completion', model: cap.loaded ?? cap.models[0] ?? null, status: 'unavailable' };
  return null;
}
