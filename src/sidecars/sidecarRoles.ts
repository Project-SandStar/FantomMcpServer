/**
 * Which roles a sidecar actually runs — read from the host, never assumed.
 *
 * Role assignment lives on the SoundSuite master (`/admin/roleassign`); Fantom
 * only observes it. A host reports its roles in the WS heartbeat snapshot
 * (`roles` / `containers`, keyed by role) and in HTTP `GET /api/status`. The
 * heartbeat is preferred; the HTTP probe covers a host whose heartbeat frames
 * never arrive (gpu-02, 2026-09-29: register frames land, 30 KB heartbeats do
 * not) so that host is judged by what it runs, not by what we failed to hear.
 *
 * Callers that need "a sidecar for role X" go through `hostsForRole` and get
 * hosts that run X first. A host without the role is not disabled — it still
 * serves the roles it has — it is simply not asked to do X.
 */
import type { Sidecar } from '../admin/types.js';
import { listSidecars } from './registry.js';
import { getCachedSnapshotBySidecarId, getSidecarHeartbeatAgeMs } from './soundsuiteMaster.js';
import { fetchSidecarStatus } from './sidecarActions.js';

/** A heartbeat older than this no longer says what the host runs now. */
const FRESH_HEARTBEAT_MS = 60_000;
/** HTTP `/api/status` is re-read this often per host when there is no fresh heartbeat. */
const HTTP_STATUS_TTL_MS = 60_000;

interface HttpRolesCache { at: number; roles: Set<string> | null }
const httpCache = new Map<string, HttpRolesCache>();
const httpInFlight = new Map<string, Promise<Set<string> | null>>();

/** For tests. */
export function __resetSidecarRolesCacheForTest(): void {
  httpCache.clear();
  httpInFlight.clear();
}

/**
 * Roles from a status-shaped object: `roles` keys, plus `containers` entries
 * whose status is running (keyed by role, or named `ss-<role>` in the register
 * frame's array form).
 */
export function rolesFromSnapshot(snap: unknown): Set<string> {
  const out = new Set<string>();
  if (!snap || typeof snap !== 'object') return out;
  const s = snap as { roles?: unknown; containers?: unknown };
  if (s.roles && typeof s.roles === 'object') {
    for (const k of Object.keys(s.roles as Record<string, unknown>)) out.add(k);
  }
  const c = s.containers;
  if (Array.isArray(c)) {
    for (const name of c) if (typeof name === 'string' && name.startsWith('ss-')) out.add(name.slice(3));
  } else if (c && typeof c === 'object') {
    for (const [role, v] of Object.entries(c as Record<string, { status?: string; exists?: boolean }>)) {
      const status = v?.status;
      if (status === 'running' || (status === undefined && v?.exists !== false)) out.add(role);
    }
  }
  return out;
}

async function rolesOverHttp(sc: Sidecar): Promise<Set<string> | null> {
  const hit = httpCache.get(sc.id);
  if (hit && Date.now() - hit.at < HTTP_STATUS_TTL_MS) return hit.roles;
  const running = httpInFlight.get(sc.id);
  if (running) return running;
  const p = (async () => {
    try {
      const snap = await fetchSidecarStatus(sc);
      const roles = rolesFromSnapshot(snap);
      httpCache.set(sc.id, { at: Date.now(), roles });
      return roles;
    } catch {
      // Unknown, not empty: an unreachable host is not "a host without roles".
      httpCache.set(sc.id, { at: Date.now(), roles: null });
      return null;
    } finally {
      httpInFlight.delete(sc.id);
    }
  })();
  httpInFlight.set(sc.id, p);
  return p;
}

/**
 * Roles the sidecar runs right now, or null when nothing recent says. Fresh
 * WS heartbeat first; HTTP `/api/status` when the heartbeat is stale or absent.
 */
export async function getSidecarRoles(sc: Sidecar): Promise<Set<string> | null> {
  const age = getSidecarHeartbeatAgeMs(sc.id);
  if (age !== null && age < FRESH_HEARTBEAT_MS) {
    const snap = getCachedSnapshotBySidecarId(sc.id);
    if (snap) {
      const roles = rolesFromSnapshot(snap);
      if (roles.size) return roles;
    }
  }
  return rolesOverHttp(sc);
}

export interface RoleHost {
  sidecar: Sidecar;
  /** The host reports the role as running. */
  hasRole: boolean;
  /** Null when neither a fresh heartbeat nor `/api/status` answered. */
  known: boolean;
  /** WS heartbeat within FRESH_HEARTBEAT_MS. */
  wsFresh: boolean;
}

/**
 * Enabled sidecars ordered for `role`: hosts running it (fresh WS first), then
 * hosts whose roles are unknown, then hosts that report they do not run it.
 * `strict` drops the last group whenever at least one host runs the role.
 */
export async function hostsForRole(role: string, opts: { strict?: boolean } = {}): Promise<RoleHost[]> {
  const all = listSidecars({ enabled: true });
  const rows = await Promise.all(all.map(async (sidecar): Promise<RoleHost> => {
    const roles = await getSidecarRoles(sidecar);
    const age = getSidecarHeartbeatAgeMs(sidecar.id);
    return {
      sidecar,
      hasRole: roles?.has(role) ?? false,
      known: roles !== null,
      wsFresh: age !== null && age < FRESH_HEARTBEAT_MS,
    };
  }));
  const rank = (h: RoleHost): number => (h.hasRole ? (h.wsFresh ? 0 : 1) : h.known ? 3 : 2);
  const ordered = rows.sort((a, b) => rank(a) - rank(b));
  if (opts.strict && ordered.some((h) => h.hasRole)) return ordered.filter((h) => h.hasRole);
  return ordered;
}

/** One line for logs: `rlm-sandbox: gpu-01 ✓ws, BASWS35 ✓ws, mcpserver.local ✓, gpu-02 ✗`. */
export function describeRoleHosts(role: string, hosts: RoleHost[]): string {
  return `${role}: ${hosts.map((h) => `${h.sidecar.name} ${h.hasRole ? (h.wsFresh ? '✓ws' : '✓') : h.known ? '✗' : '?'}`).join(', ') || '(no enabled sidecar)'}`;
}
