/**
 * Sound Suite master-side handler. Mirrors the wire protocol of court-lens-mcp
 * so Fantom MCP can be listed as one of the multi-master sidecar's masters.
 *
 *  ws://<this-host>:<port>/sidecar     — WS endpoint (sidecar-initiated)
 *  POST /api/admin/gpu/sidecars/heartbeat   — HTTP fallback heartbeat
 *  POST /api/admin/gpu/sidecars/poll        — HTTP fallback command poll
 *  POST /api/admin/gpu/sidecars/result      — HTTP fallback command result
 *
 * Frames the master receives:
 *   { type:'register',  agentUrl, hostname, containers }
 *   { type:'heartbeat', containers, activeRequests, statusData:{...} }
 *   { type:'result',    id, error?, ...result }
 *
 * Frames the master emits:
 *   { type:'registered', ok:true }
 *   { type:'command', id, action, role?, ...payload }   (queued; sent when WS open)
 *   { type:'config',  payload:{ idleTimeouts?, minOnline?, registry?, serverUrl? } }
 *
 * We don't issue commands today — Fantom's actions go through HTTP. But we
 * DO mine the heartbeat for capability data and surface it via the existing
 * Sidecar registry + fleet-table snapshot cache.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage } from 'http';
import * as fs from 'fs';
import * as path from 'path';
import type { Express, Request, Response } from 'express';
import type { Socket } from 'net';
import {
  listSidecars,
  getSidecar,
  createSidecar,
  updateSidecar,
  mergeCapabilities,
} from './registry.js';
import type { Sidecar, SidecarCapabilityKind } from '../admin/types.js';

const WS_PATH = '/sidecar';

interface RoleContainerSnapshot {
  name?: string;
  status?: string;
  image?: string;
  model?: string | null;
  type?: 'ollama' | 'vllm' | 'utility';
  config?: { image?: string; model?: string | null; port?: number; vram?: number; type?: string; gpuOnly?: boolean };
  loadedModels?: Array<{ name: string; size?: string; gpuPercent?: number; processor?: string; until?: string }>;
}

interface HeartbeatStatusData {
  agentUrl?: string;
  hostname?: string;
  mode?: string;
  containers?: Record<string, RoleContainerSnapshot>;
  roles?: Record<string, { activeRequests?: number; idleTimerActive?: boolean; lastAcquire?: string | null; lastRelease?: string | null }>;
  gpus?: Array<{ index: number; name?: string; memoryMb?: number; tempC?: number }>;
  vram?: { totalMb?: number; freeMb?: number; usedMb?: number; perRole?: Record<string, { actualMb?: number; budgetMb?: number; priority?: string; gpuOnly?: boolean }> };
  freeVram?: number;
  totalVram?: number;
  containerNames?: string[];
  version?: string;
  agent?: { version?: string; uptime?: number };
  masters?: Array<{ serverUrl?: string; wsPort?: number; connectionMode?: string }>;
  lastConfigPushAt?: number | string;
}

interface RegisterFrame {
  type: 'register';
  agentUrl: string;
  hostname?: string;
  containers?: string[];
}
interface HeartbeatFrame {
  type: 'heartbeat';
  containers?: unknown;
  activeRequests?: number;
  statusData?: HeartbeatStatusData;
}
interface ResultFrame { type: 'result'; id: string; error?: string; [k: string]: unknown }

// agentUrl → live WS
const liveByAgentUrl = new Map<string, WebSocket>();
// agentUrl → most recent statusData snapshot (drives the dashboard fleet table)
const snapshotByAgentUrl = new Map<string, HeartbeatStatusData>();
// agentUrl → sidecarId we resolved them to
const sidecarIdByAgentUrl = new Map<string, string>();

// Outstanding command/result correlations. Master sends `{type:'command',id,...}`,
// sidecar replies with `{type:'result',id,...}` — we resolve the matching promise.
interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  agentUrl: string;
  timer: NodeJS.Timeout;
}
const pendingByCommandId = new Map<string, Pending>();

const ROLE_KIND_MAP: Record<string, SidecarCapabilityKind> = {
  embedding: 'embedding',
  reranker: 'reranker',
  completion: 'llm',
  ocr: 'ocr',
  // The dedicated Recursive Language Model (ss-rlm, mit-oasys/rlm-qwen3-8b on
  // vLLM, port 8100). Previously dropped here — so a sidecar running only
  // ss-rlm (e.g. gpu-02) surfaced NO capabilities. Map it so the RLM endpoint
  // is discoverable. The capability's `port` comes from the container config
  // (8100), distinct from the 8098 agent port.
  rlm: 'rlm',
  // Code-specialized embedding model (ss-code-embedding, e.g. jina-code-
  // embeddings-1.5b on Ollama). It runs as its OWN service on its OWN port
  // (11437, vs the general embedder's 11434), so it gets its OWN capability
  // kind — NOT folded into 'embedding'. A capability carries one port; folding
  // both models under 'embedding' would make qwen3 requests hit jina-code's
  // port (or vice-versa). Code embedding routing prefers this kind and falls
  // back to 'embedding' (see embeddingProvider.capabilityKindsFor).
  'code-embedding': 'embedding-code',
};

/**
 * Convert a soundsuite heartbeat statusData snapshot into our
 * Sidecar.capabilities shape, role-by-role.
 */
/** Roles we've already warned about being unmapped — log each at most once. */
const warnedUnmappedRoles = new Set<string>();

function snapshotToCapabilities(snap: HeartbeatStatusData): Sidecar['capabilities'] {
  const out: Sidecar['capabilities'] = {};
  for (const [role, c] of Object.entries(snap.containers ?? {})) {
    const kind = ROLE_KIND_MAP[role];
    if (!kind) {
      // Surfacing-gap breadcrumb: a heartbeat role we don't map is silently
      // dropped (no capability, no error) — exactly how ss-rlm and
      // ss-code-embedding were invisible until mapped. Log the raw key ONCE per
      // role (heartbeats repeat every few seconds, so unconditional logging
      // floods the log) so a new role is diagnosable without spam.
      if (!warnedUnmappedRoles.has(role)) {
        warnedUnmappedRoles.add(role);
        console.log(`[soundsuite-master] unmapped sidecar role '${role}' — not surfaced as a capability (add to ROLE_KIND_MAP if intended)`);
      }
      continue;
    }
    const configured = c.config?.model ?? c.model ?? undefined;
    const loaded = c.loadedModels?.[0];
    // UNION with any capability already built for this kind: multiple roles can
    // map to one kind (ss-embedding + ss-code-embedding → 'embedding'). A plain
    // `out[kind] = {...}` would clobber the first role's models with the
    // second's. Seed the set from the prior models so both survive.
    const prev = out[kind];
    const models = new Set<string>(prev?.models ?? []);
    if (configured) models.add(configured);
    for (const m of c.loadedModels ?? []) if (m?.name) models.add(m.name);
    out[kind] = {
      available: (prev?.available ?? false) || c.status === 'running',
      models: [...models],
      loaded: loaded?.name ?? prev?.loaded ?? null,
      gpuPercent: loaded?.gpuPercent ?? prev?.gpuPercent,
      port: c.config?.port ?? prev?.port,
    };
  }
  return out;
}

/**
 * Find or create a sidecar entry for the agentUrl the sidecar reported.
 * Match by host:port; if not found, auto-register a new entry so the sidecar
 * appears in the dashboard immediately.
 */
function resolveOrCreateSidecar(agentUrl: string, hostname?: string): Sidecar {
  const cached = sidecarIdByAgentUrl.get(agentUrl);
  if (cached) {
    const sc = getSidecar(cached);
    if (sc) return sc;
  }
  let url: URL;
  try { url = new URL(agentUrl); } catch { url = new URL(`http://${agentUrl}`); }
  const host = url.hostname;
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  const protocol: 'http' | 'https' = url.protocol === 'https:' ? 'https' : 'http';
  const match = listSidecars().find(s => s.host === host && s.port === port);
  if (match) {
    sidecarIdByAgentUrl.set(agentUrl, match.id);
    return match;
  }
  const sc = createSidecar({
    name: hostname || `${host}:${port}`,
    host, port, protocol,
    enabled: true,
    capabilities: {},
    capabilitiesSource: 'ws-register',
  });
  // Persist a stable sidecarId we can match next time without a registry lookup.
  sidecarIdByAgentUrl.set(agentUrl, sc.id);
  return sc;
}

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function applyHeartbeatToRegistry(agentUrl: string, frame: HeartbeatFrame): void {
  const snap = frame.statusData ?? {};
  if (snap) snapshotByAgentUrl.set(agentUrl, snap);
  const sc = resolveOrCreateSidecar(agentUrl, snap.hostname);
  const capabilities = snapshotToCapabilities(snap);
  mergeCapabilities(sc.id, capabilities, 'ws-heartbeat');
  if (typeof frame.activeRequests === 'number') {
    updateSidecar(sc.id, { activeRequests: frame.activeRequests });
  }
}

function handleFrame(ws: WebSocket, agentUrlRef: { url: string | null }, raw: string): void {
  let msg: RegisterFrame | HeartbeatFrame | ResultFrame;
  try { msg = JSON.parse(raw); }
  catch { send(ws, { type: 'error', message: 'invalid JSON' }); return; }

  if (!msg || typeof msg !== 'object' || !msg.type) {
    send(ws, { type: 'error', message: 'missing type' });
    return;
  }

  if (msg.type === 'register') {
    const reg = msg as RegisterFrame;
    if (!reg.agentUrl) { send(ws, { type: 'error', message: 'register: missing agentUrl' }); return; }
    agentUrlRef.url = reg.agentUrl;
    // A sidecar that reconnects re-registers from the same agentUrl. The
    // superseded socket drops out of every map and would stay ESTABLISHED
    // until TCP gives up — one leaked FD per reconnect. Terminate it now when
    // SUPERSEDED_GRACE_MS is 0, otherwise mark it for the liveness sweep (see
    // the constant's comment for why the grace exists).
    const prev = liveByAgentUrl.get(reg.agentUrl) as (WebSocket & LivenessState) | undefined;
    if (prev && prev !== ws) {
      if (SUPERSEDED_GRACE_MS === 0) {
        console.log(`[soundsuite-master] re-register from ${reg.agentUrl}; terminating superseded socket`);
        try { prev.terminate(); } catch { /* already gone */ }
        noteSupersede(reg.agentUrl);
      } else if (prev.supersededAt === undefined) {
        prev.supersededAt = Date.now();
        console.log(`[soundsuite-master] re-register from ${reg.agentUrl}; previous socket marked superseded`);
        noteSupersede(reg.agentUrl);
      }
    }
    liveByAgentUrl.set(reg.agentUrl, ws);
    scheduleSilentRegistrationCheck(reg.agentUrl, Date.now());
    const sc = resolveOrCreateSidecar(reg.agentUrl, reg.hostname);
    updateSidecar(sc.id, {
      lastSeen: new Date().toISOString(),
      healthStatus: 'healthy',
      capabilitiesSource: 'ws-register',
    });
    send(ws, { type: 'registered', ok: true });
    // A sidecar coming back is exactly the event that should re-open the
    // cloud gate. Dynamic import: this module sits under virtualContainers,
    // which the reverify module imports, and a static import here would be a
    // cycle. Fire-and-forget — registration must never wait on a probe.
    void import('../embedding/providers/cloudReverify.js')
      .then(m => m.onSidecarReconnected(sc.name))
      .catch(err => console.warn(`[soundsuite-master] reverify hook failed: ${(err as Error).message}`));
    return;
  }

  if (msg.type === 'heartbeat') {
    const url = agentUrlRef.url;
    if (!url) {
      send(ws, { type: 'error', message: 'heartbeat before register' });
      return;
    }
    lastHeartbeatAt.set(url, Date.now());
    applyHeartbeatToRegistry(url, msg as HeartbeatFrame);
    ensureMasterSlotWsPort(ws, url, (msg as HeartbeatFrame).statusData);
    return;
  }

  if (msg.type === 'result') {
    const result = msg as ResultFrame;
    const p = pendingByCommandId.get(result.id);
    if (!p) {
      // Unknown id — ignore (no-op, sidecar may have replayed).
      return;
    }
    clearTimeout(p.timer);
    pendingByCommandId.delete(result.id);
    if (result.error) p.reject(new Error(String(result.error)));
    else {
      const { type: _t, id: _i, error: _e, ...rest } = result;
      p.resolve(rest);
    }
    return;
  }
}

/**
 * Send a command frame to a sidecar over its open WS and resolve when the
 * matching result frame arrives. Returns null if no WS is currently open
 * for that sidecarId; caller should fall back to HTTP.
 */
export async function sendCommandToSidecar(
  sidecarId: string,
  action: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 60_000,
): Promise<unknown | null> {
  // Find the agentUrl bound to this sidecarId.
  let agentUrl: string | null = null;
  for (const [url, id] of sidecarIdByAgentUrl) if (id === sidecarId) { agentUrl = url; break; }
  if (!agentUrl) return null;
  const ws = liveByAgentUrl.get(agentUrl);
  if (!ws || ws.readyState !== ws.OPEN) return null;

  const id = `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingByCommandId.delete(id);
      reject(new Error(`sendCommandToSidecar: timeout after ${timeoutMs}ms (action=${action})`));
    }, timeoutMs);
    pendingByCommandId.set(id, { resolve, reject, agentUrl: agentUrl!, timer });
    try {
      ws.send(JSON.stringify({ type: 'command', id, action, ...payload }));
    } catch (err) {
      clearTimeout(timer);
      pendingByCommandId.delete(id);
      reject(err as Error);
    }
  });
}

function readMasterHttpPort(): number {
  const fromEnv = Number(process.env.MCP_PORT);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  try {
    const cfg = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), 'config', 'fantomMcpServer-config.json'), 'utf-8'));
    if (typeof cfg?.port === 'number' && cfg.port > 0) return cfg.port;
  } catch { /* fall through */ }
  return 3848;
}

// agentUrl → last time we pushed a master-identity correction
const identityPushedAt = new Map<string, number>();

/**
 * Interop hazard guard. The sidecar resolves a master's relay port as
 * `m.wsPort ?? 3002`. Fantom and Sound Suite commonly run on the SAME host,
 * so a Fantom master slot with no wsPort silently connects to Sound Suite's
 * relay (3002), registers there under the same agentUrl, and the two masters'
 * slots evict each other. The heartbeat's statusData.masters tells us how the
 * sidecar sees us; if the slot whose serverUrl points at our HTTP port carries
 * a different wsPort, push a `master-identity` frame that keeps the sidecar's
 * own serverUrl (so no new slot is created) and corrects only the port.
 */
function ensureMasterSlotWsPort(ws: WebSocket, agentUrl: string, snap: HeartbeatStatusData | undefined): void {
  const masters = snap?.masters;
  if (!Array.isArray(masters) || masters.length === 0 || dedicatedPort == null) return;
  const httpPort = readMasterHttpPort();
  const ours = masters.filter(m => {
    try { return Number(new URL(String(m.serverUrl)).port || 80) === httpPort; } catch { return false; }
  });
  for (const m of ours) {
    if (m.wsPort === dedicatedPort) continue;
    const now = Date.now();
    if (now - (identityPushedAt.get(agentUrl) ?? 0) < 60_000) return;
    identityPushedAt.set(agentUrl, now);
    wsDiag.wsPortCorrections++;
    console.warn(`[soundsuite-master] ${agentUrl} has our master slot ${m.serverUrl} with wsPort=${m.wsPort ?? 'unset'} (expected ${dedicatedPort}); sending master-identity to correct it`);
    send(ws, { type: 'master-identity', canonicalUrl: m.serverUrl, wsPort: dedicatedPort });
  }
}

/**
 * Push a `config` frame to a sidecar over its open WS.
 *
 * Unlike `sendCommandToSidecar` this is fire-and-forget: the sidecar's
 * `config` / `config-push` handler applies the payload and does not reply
 * with a matching `result` frame, so waiting for one would always time out.
 *
 * Frame shape is `{ type:'config', payload:{…} }` — the sidecar routes it
 * through the same handler as a `config` command, reading `msg.payload`.
 *
 * Returns false when no WS is open for that sidecar.
 */
export function pushConfigToSidecar(sidecarId: string, payload: Record<string, unknown>): boolean {
  let agentUrl: string | null = null;
  for (const [url, id] of sidecarIdByAgentUrl) if (id === sidecarId) { agentUrl = url; break; }
  if (!agentUrl) return false;
  const ws = liveByAgentUrl.get(agentUrl);
  if (!ws || ws.readyState !== ws.OPEN) return false;
  ws.send(JSON.stringify({ type: 'config', id: `cfg-${Date.now().toString(36)}`, payload }));
  return true;
}

/** Whether we currently hold an open WS tunnel to this sidecar. */
/** TCP-level view of a sidecar's live socket — which direction is stalling.
 *  bytesRead = what the sidecar has delivered to us on this socket;
 *  writableLength = what we have written that the kernel could not yet send
 *  (grows when the peer's ACKs never come back). */
export function socketStatsForSidecarId(sidecarId: string): { readyState: number; bufferedAmount: number; bytesRead: number; bytesWritten: number; writableLength: number; extensions: string } | null {
  const url = agentUrlForSidecarId(sidecarId);
  const ws = url ? liveByAgentUrl.get(url) : undefined;
  if (!ws) return null;
  const sock = (ws as unknown as { _socket?: { bytesRead?: number; bytesWritten?: number; writableLength?: number } })._socket;
  return {
    readyState: ws.readyState,
    bufferedAmount: ws.bufferedAmount,
    bytesRead: sock?.bytesRead ?? -1,
    bytesWritten: sock?.bytesWritten ?? -1,
    writableLength: sock?.writableLength ?? -1,
    extensions: ws.extensions || '',
  };
}

/** The agentUrl a registry id last registered under (null if never seen on the WS). */
export function agentUrlForSidecarId(sidecarId: string): string | null {
  for (const [url, id] of sidecarIdByAgentUrl) if (id === sidecarId) return url;
  return null;
}

export function isSoundSuiteSidecarConnected(sidecarId: string): boolean {
  for (const [url, id] of sidecarIdByAgentUrl) {
    if (id !== sidecarId) continue;
    const ws = liveByAgentUrl.get(url);
    return !!ws && ws.readyState === ws.OPEN;
  }
  return false;
}

function readMasterWsPort(): number {
  const fromEnv = process.env.FANTOM_SIDECAR_WS_PORT;
  if (fromEnv && Number.isFinite(Number(fromEnv))) return Number(fromEnv);
  try {
    const cfg = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), 'config', 'fantomMcpServer-config.json'), 'utf-8'));
    if (typeof cfg?.sidecarMasterWsPort === 'number' && cfg.sidecarMasterWsPort > 0) {
      return cfg.sidecarMasterWsPort;
    }
  } catch { /* fall through */ }
  return 3003;
}

let dedicatedHttp: HttpServer | null = null;
let dedicatedWss: WebSocketServer | null = null;
let dedicatedPort: number | null = null;
let dedicatedError: string | null = null;
let livenessSweep: NodeJS.Timeout | null = null;

// Ping every client on this cadence; a client that has not answered the
// previous ping by the next sweep is half-open and gets terminated.
const LIVENESS_SWEEP_MS = 30_000;
// A connected socket must send its register frame within this window.
const HANDSHAKE_TIMEOUT_MS = 30_000;

// How long a socket superseded by a newer registration from the same agentUrl
// is kept before the liveness sweep terminates it. 0 = terminate immediately.
//
// Why a grace exists: sidecar clients < 2.3.82 opened a NEW socket to the
// master while their previous one was still open (connectMaster did not check
// for an OPEN/CONNECTING socket), and their close handler tore down the live
// connection whenever ANY of their sockets closed. Terminating the superseded
// socket immediately therefore produced a reconnect loop (measured 2026-09-13:
// 221 reconnects / 90 s across four peers). Sidecar 2.3.82 enforces
// one-socket-per-master client-side, so the supersede path goes quiet with a
// current fleet — but this master will face sidecars it cannot upgrade and
// third-party clients, so tolerating an over-eager client stays the correct
// posture at this trust boundary. Keep the grace; do not turn the sweep into a
// pong-only liveness check: an orphaned-but-alive socket answers protocol
// pings, so only the unconditional terminate after the grace bounds descriptors.
// See the sidecar repo: docs/MCP-Improvements/REPORT-v17-master-socket-obligations.md.
//
// Default 45 s (aligned with the Sound Suite master): the sweep runs every 30 s
// either way, and 45 s holds an order of magnitude fewer orphans than 2 min.
// Override with FANTOM_SIDECAR_SUPERSEDED_GRACE_MS.
const SUPERSEDED_GRACE_MS = (() => {
  const v = Number(process.env.FANTOM_SIDECAR_SUPERSEDED_GRACE_MS);
  return Number.isFinite(v) && v >= 0 ? v : 45_000;
})();

// Sidecar client version from which supersedes are NOT expected background
// noise (one-socket-per-master enforced client-side). Frequent supersedes from
// such a sidecar indicate a remaining reconnect trigger or a client regression.
const ONE_SOCKET_CLIENT_MIN_VERSION = [2, 3, 82] as const;
const SUPERSEDE_WINDOW_MS = 10 * 60_000;
const SUPERSEDE_WARN_THRESHOLD = 3;
// agentUrl → timestamps of supersedes inside the window
const supersedesByAgentUrl = new Map<string, number[]>();
// agentUrl → last time we warned (rate-limit to once per window)
const supersedeWarnedAt = new Map<string, number>();

function parseVersion(v: string | undefined): number[] | null {
  if (!v) return null;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function versionAtLeast(v: number[] | null, min: readonly number[]): boolean {
  if (!v) return false;
  for (let i = 0; i < min.length; i++) {
    if (v[i] !== min[i]) return v[i] > min[i];
  }
  return true;
}

// agentUrl → time of the last heartbeat frame we received over WS
const lastHeartbeatAt = new Map<string, number>();
// agentUrl → last time we warned about a silent (register-only) sidecar
const silentWarnedAt = new Map<string, number>();
// How long after a register we expect the first heartbeat (client sends every 5 s).
const FIRST_HEARTBEAT_DEADLINE_MS = 30_000;
// Diagnostic counters surfaced by getMasterWsListenerStatus().
const wsDiag = {
  silentRegistrations: 0, supersedeWarnings: 0, wsPortCorrections: 0,
  /** Per agentUrl: how often its socket closed, the last close code, its lifetime and heartbeats delivered. */
  closesByAgent: new Map<string, { closes: number; lastCode: number; lastLifeS: number; heartbeatsLast: number }>(),
};

/**
 * A sidecar that registers but never heartbeats is a specific, recognisable
 * failure: its client believes it is connected (register went through) but the
 * larger heartbeat frames never arrive here — a path that drops large frames
 * (PMTU blackhole over a VPN), or a client whose status builder throws so its
 * heartbeat send fails and it reconnects every ~15 s (3 failures × 5 s). Both
 * look identical from the master: register, silence, register, …
 */
function scheduleSilentRegistrationCheck(agentUrl: string, registeredAt: number): void {
  const t = setTimeout(() => {
    const hb = lastHeartbeatAt.get(agentUrl) ?? 0;
    if (hb >= registeredAt) return;
    if (!liveByAgentUrl.has(agentUrl)) return; // it went away; nothing to diagnose
    wsDiag.silentRegistrations++;
    const now = Date.now();
    if (now - (silentWarnedAt.get(agentUrl) ?? 0) < SUPERSEDE_WINDOW_MS) return;
    silentWarnedAt.set(agentUrl, now);
    console.warn(`[soundsuite-master] ${agentUrl} registered ${Math.round((now - registeredAt) / 1000)}s ago but has sent no heartbeat — register frames arrive, larger heartbeat frames do not. Check the network path for dropped large frames (MTU) or the sidecar log for "WS heartbeat failed"; its status will be probed over HTTP instead`);
  }, FIRST_HEARTBEAT_DEADLINE_MS);
  t.unref?.();
}

/** Record a supersede for diagnostics; warn when a fixed client still churns. */
function noteSupersede(agentUrl: string): void {
  const now = Date.now();
  const list = (supersedesByAgentUrl.get(agentUrl) ?? []).filter(t => now - t < SUPERSEDE_WINDOW_MS);
  list.push(now);
  supersedesByAgentUrl.set(agentUrl, list);
  const ver = parseVersion(snapshotByAgentUrl.get(agentUrl)?.agent?.version ?? snapshotByAgentUrl.get(agentUrl)?.version);
  if (!versionAtLeast(ver, ONE_SOCKET_CLIENT_MIN_VERSION)) return;
  if (list.length < SUPERSEDE_WARN_THRESHOLD) return;
  const last = supersedeWarnedAt.get(agentUrl) ?? 0;
  if (now - last < SUPERSEDE_WINDOW_MS) return;
  supersedeWarnedAt.set(agentUrl, now);
  wsDiag.supersedeWarnings++;
  console.warn(`[soundsuite-master] ${agentUrl} (sidecar ${ver!.join('.')}) superseded its socket ${list.length}× in ${SUPERSEDE_WINDOW_MS / 60_000} min — clients >= ${ONE_SOCKET_CLIENT_MIN_VERSION.join('.')} enforce one socket per master, so this points at a remaining reconnect trigger or a client regression`);
}

// A peer must miss this many consecutive pings before it is treated as dead.
// One miss is not evidence of death: sidecars do long synchronous work on their
// event loop (Docker calls, pulling a model into VRAM, OCR), and the ws library
// can only answer a ping when the loop is free. A 30 s+ stall during a model
// load would otherwise be read as a dead peer, terminated, and the sidecar —
// which believes the socket is live — would reconnect and re-register.
const MAX_MISSED_PONGS = 3; // × LIVENESS_SWEEP_MS ≈ 90 s

type LivenessState = { isAlive?: boolean; missedPongs?: number; supersededAt?: number };

function bindDedicatedListener(port: number, attachConnection: (wss: WebSocketServer) => void): void {
  // Tear down any existing listener first. wss.close() does NOT close the
  // client sockets that are already connected, so terminate them explicitly.
  if (livenessSweep) { clearInterval(livenessSweep); livenessSweep = null; }
  if (dedicatedWss) {
    for (const client of dedicatedWss.clients) { try { client.terminate(); } catch {} }
    try { dedicatedWss.close(); } catch {}
    dedicatedWss = null;
  }
  if (dedicatedHttp) {
    try { dedicatedHttp.close(); } catch {}
    dedicatedHttp = null;
  }
  dedicatedError = null;

  // permessage-deflate: the sidecar's heartbeat carries `buildFullStatus()`
  // every 5s — a multi-KB JSON. BASWS34's NetBird path delivered the small
  // register frame and then NONE of those heartbeats (0 of 36 in a 3-minute
  // baseline; BASWS35 on the same config delivered 36/36), so the sidecar's
  // own "heartbeat send failed 3× → terminate → reconnect" fired every ~30s —
  // 1,199 reconnects in a day. The `ws` client offers the extension by
  // default; accepting it here compresses that JSON ~10× so it fits the path.
  // Threshold keeps register/pong/small results raw; no context takeover
  // keeps per-socket zlib memory bounded across five long-lived tunnels.
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: {
      threshold: 512,
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      zlibDeflateOptions: { level: 3 },
      concurrencyLimit: 8,
    },
  });
  attachConnection(wss);

  // Standard ws liveness sweep: mark alive on pong, ping on each tick, and
  // terminate anything that stayed silent for a whole interval.
  livenessSweep = setInterval(() => {
    const now = Date.now();
    for (const client of wss.clients) {
      const c = client as WebSocket & LivenessState;
      if (c.isAlive === false) {
        c.missedPongs = (c.missedPongs ?? 0) + 1;
        if (c.missedPongs >= MAX_MISSED_PONGS) {
          console.log(`[soundsuite-master] terminating unresponsive WS client (${c.missedPongs} consecutive missed pongs)`);
          try { c.terminate(); } catch {}
          continue;
        }
      } else {
        c.missedPongs = 0;
      }
      if (c.supersededAt !== undefined && now - c.supersededAt > SUPERSEDED_GRACE_MS) {
        console.log('[soundsuite-master] terminating superseded WS client after grace period');
        try { c.terminate(); } catch {}
        continue;
      }
      c.isAlive = false;
      try { c.ping(); } catch {}
    }
  }, LIVENESS_SWEEP_MS);
  livenessSweep.unref?.();

  const http = createHttpServer((_req: IncomingMessage, res) => {
    // Tiny health line so operators can confirm the listener.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, role: 'fantom-soundsuite-master', wsPath: WS_PATH }));
  });
  http.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = req.url ?? '';
    const p = url.split('?')[0];
    if (p !== WS_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  http.on('error', (err: Error) => {
    dedicatedError = err.message;
    console.error(`[soundsuite-master] dedicated listener error: ${err.message}`);
  });
  http.listen(port, () => {
    console.log(`[soundsuite-master] dedicated WS listener on :${port}${WS_PATH}`);
  });

  dedicatedHttp = http;
  dedicatedWss = wss;
  dedicatedPort = port;
}

function attachConnectionHandlers(wss: WebSocketServer): void {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const remote = req.socket.remoteAddress;
    const connectedAt = Date.now();
    const seen = { frames: 0, heartbeats: 0 };
    console.log(`[soundsuite-master] WS connect from ${remote} url=${req.url} ext=${ws.extensions || 'none'}`);
    const agentUrlRef: { url: string | null } = { url: null };
    (ws as WebSocket & LivenessState).isAlive = true;
    ws.on('pong', () => { (ws as WebSocket & LivenessState).isAlive = true; });
    // Bounded handshake: a socket that never sends a register frame is not a
    // sidecar we can route to, and it would otherwise survive the liveness
    // sweep indefinitely (TCP-level pongs are answered by the ws library even
    // for an idle client). Close it if nothing registered within the window.
    const handshakeTimer = setTimeout(() => {
      if (agentUrlRef.url) return;
      console.log(`[soundsuite-master] no register frame from ${remote} within ${HANDSHAKE_TIMEOUT_MS / 1000}s; closing`);
      try { ws.terminate(); } catch {}
    }, HANDSHAKE_TIMEOUT_MS);
    handshakeTimer.unref?.();
    ws.once('close', () => clearTimeout(handshakeTimer));
    ws.on('message', data => {
      const text = typeof data === 'string' ? data : data.toString('utf-8');
      const peek = text.slice(0, 120);
      seen.frames++;
      if (peek.startsWith('{"type":"heartbeat"')) seen.heartbeats++;
      console.log(`[soundsuite-master] frame from ${agentUrlRef.url ?? remote}: ${peek}`);
      try { handleFrame(ws, agentUrlRef, text); }
      catch (err) { console.error('[soundsuite-master] frame error:', err); }
    });
    ws.on('close', (code: number, reason: Buffer) => {
      // Who closed, after how long, having delivered what. Until this line
      // existed the master had no record of a sidecar socket ending at all,
      // and BASWS34's reconnect loop was invisible from this side.
      const who = agentUrlRef.url ?? remote ?? 'unknown';
      const life = ((Date.now() - connectedAt) / 1000).toFixed(0);
      const churn = wsDiag.closesByAgent.get(who) ?? { closes: 0, lastCode: 0, lastLifeS: 0, heartbeatsLast: 0 };
      churn.closes++; churn.lastCode = code; churn.lastLifeS = Number(life); churn.heartbeatsLast = seen.heartbeats;
      wsDiag.closesByAgent.set(who, churn);
      console.log(`[soundsuite-master] WS closed ${who} code=${code}${reason?.length ? ` reason=${reason.toString('utf-8').slice(0, 60)}` : ''} after ${life}s frames=${seen.frames} heartbeats=${seen.heartbeats} closes=${churn.closes}`);
      if (agentUrlRef.url) {
        const cur = liveByAgentUrl.get(agentUrlRef.url);
        if (cur === ws) liveByAgentUrl.delete(agentUrlRef.url);
        const id = sidecarIdByAgentUrl.get(agentUrlRef.url);
        if (id) updateSidecar(id, { healthStatus: 'unknown' });
      }
    });
    ws.on('error', () => {
      if (agentUrlRef.url) {
        const cur = liveByAgentUrl.get(agentUrlRef.url);
        if (cur === ws) liveByAgentUrl.delete(agentUrlRef.url);
      }
    });
  });
}

export function attachSoundSuiteMaster(_httpServer: HttpServer, app: Express): void {
  const port = readMasterWsPort();
  bindDedicatedListener(port, attachConnectionHandlers);

  // ─── HTTP fallback endpoints ─────────────────────────────────────────────
  // Sidecar uses these when WS isn't reachable. No auth gate today (matches
  // the rest of /api/* on the sidecar and on Fantom MCP).

  app.post('/api/admin/gpu/sidecars/heartbeat', (req: Request, res: Response): void => {
    const body = req.body ?? {};
    const agentUrl: string | undefined = body.agentUrl ?? body.statusData?.agentUrl;
    console.log(`[soundsuite-master] HTTP heartbeat from ${req.ip} agentUrl=${agentUrl ?? 'MISSING'}`);
    if (!agentUrl) { res.status(400).json({ error: 'missing agentUrl' }); return; }
    applyHeartbeatToRegistry(agentUrl, body as HeartbeatFrame);
    res.json({ ok: true, commands: [] });
  });

  app.post('/api/admin/gpu/sidecars/poll', (_req: Request, res: Response): void => {
    // We don't queue commands; always return empty.
    res.json({ commands: [] });
  });

  app.post('/api/admin/gpu/sidecars/result', (_req: Request, res: Response): void => {
    res.json({ ok: true });
  });

  // Useful for the dashboard fleet table — read the cached heartbeat snapshot
  // without round-tripping to the sidecar's HTTP /status endpoint.
  app.get('/api/admin/gpu/sidecars/snapshot', (_req: Request, res: Response): void => {
    const out: Record<string, HeartbeatStatusData> = {};
    for (const [url, snap] of snapshotByAgentUrl) out[url] = snap;
    res.json({ snapshots: out });
  });

  console.log(`[soundsuite-master] HTTP fallback on app /api/admin/gpu/sidecars/{heartbeat,poll,result,snapshot}`);
}

/** Restart the dedicated WS listener on a new port. Returns status info. */
export function restartMasterWsListener(port: number): { port: number; ok: boolean; error?: string } {
  bindDedicatedListener(port, attachConnectionHandlers);
  return { port, ok: !dedicatedError, error: dedicatedError ?? undefined };
}

export function getMasterWsListenerStatus(): { port: number | null; listening: boolean; error: string | null; clients: number; registered: number; peers: Array<{ agentUrl: string; lastHeartbeatAgoMs: number | null; supersedesLast10m: number }>; diagnostics: Omit<typeof wsDiag, 'closesByAgent'> & { closes: Record<string, { closes: number; lastCode: number; lastLifeS: number; heartbeatsLast: number; tunnelFault: boolean }> } } {
  return {
    port: dedicatedPort,
    listening: !!dedicatedHttp && (dedicatedHttp as any).listening === true,
    error: dedicatedError,
    // Real socket count vs. the number of distinct agentUrls that registered.
    // If `clients` runs away from `registered`, sockets are leaking again.
    clients: dedicatedWss?.clients.size ?? 0,
    registered: liveByAgentUrl.size,
    // Per-peer heartbeat freshness and the diagnostic counters.
    peers: [...liveByAgentUrl.keys()].map(u => ({
      agentUrl: u,
      lastHeartbeatAgoMs: lastHeartbeatAt.has(u) ? Date.now() - (lastHeartbeatAt.get(u) as number) : null,
      supersedesLast10m: (supersedesByAgentUrl.get(u) ?? []).filter(t => Date.now() - t < SUPERSEDE_WINDOW_MS).length,
    })),
    diagnostics: (() => {
      const { closesByAgent, ...rest } = wsDiag;
      // Per agent: repeated short-lived sockets that never delivered a
      // heartbeat = the tunnel carries the register frame and nothing else
      // (BASWS34, 2026-09-18: 1,200+ closes, code 1006 at ~25s, 0 heartbeats).
      const closes = Object.fromEntries([...closesByAgent].map(([url, c]) => [url, {
        ...c, tunnelFault: c.closes >= 3 && c.heartbeatsLast === 0 && c.lastLifeS < 120,
      }]));
      return { ...rest, closes };
    })(),
  };
}

/** Used by the existing /admin/sidecars/:id/status route to short-circuit
 *  the HTTP probe when we already have a fresh WS heartbeat snapshot. */
export function getCachedSnapshotBySidecarId(sidecarId: string): HeartbeatStatusData | null {
  for (const [agentUrl, id] of sidecarIdByAgentUrl) {
    if (id !== sidecarId) continue;
    const snap = snapshotByAgentUrl.get(agentUrl);
    if (snap) return snap;
  }
  return null;
}
