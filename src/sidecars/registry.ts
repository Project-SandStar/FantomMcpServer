import * as path from 'path';
import { randomUUID } from 'crypto';
import type { Sidecar, SidecarCapabilityKind } from '../admin/types.js';
import { atomicWriteConfigFile, readConfigFileWithRecovery } from '../config/index.js';

const CONFIG_PATH = path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');

// The registry rewrites this file on EVERY sidecar heartbeat/registration, and
// it reads-full → modifies .sidecars → writes-full. The previous readConfig
// returned {} on any parse failure, so one corrupt/torn read made the next
// write persist ONLY {sidecars}, wiping semanticSearch + all dashboard settings
// (and clobbering the good .backup). Both now go through the shared crash-safe
// helpers: read recovers from .backup, write is atomic and won't overwrite a
// good backup with a corrupt primary.
function readConfig(): any {
  return readConfigFileWithRecovery(CONFIG_PATH);
}

function writeConfig(cfg: any): void {
  atomicWriteConfigFile(CONFIG_PATH, cfg);
}

/** Migrate the legacy {type, model} shape to {capabilities}. Idempotent. */
function migrate(s: any): Sidecar {
  if (s && s.capabilities && !s.type) return s as Sidecar;
  const out: any = { ...s };
  const legacyType = s?.type as SidecarCapabilityKind | undefined;
  const legacyModel = s?.model as string | undefined;
  out.capabilities = out.capabilities ?? {};
  if (legacyType) {
    out.capabilities[legacyType] = out.capabilities[legacyType] ?? {
      available: true,
      models: legacyModel ? [legacyModel] : [],
    };
  }
  delete out.type;
  delete out.model;
  return out as Sidecar;
}

export function listSidecars(filter?: { capability?: SidecarCapabilityKind; enabled?: boolean }): Sidecar[] {
  const cfg = readConfig();
  const all: Sidecar[] = (Array.isArray(cfg.sidecars) ? cfg.sidecars : []).map(migrate);
  return all.filter(s => {
    if (filter?.capability && !s.capabilities?.[filter.capability]?.available) return false;
    if (filter?.enabled !== undefined && s.enabled !== filter.enabled) return false;
    return true;
  });
}

export function getSidecar(id: string): Sidecar | null {
  return listSidecars().find(s => s.id === id) ?? null;
}

/**
 * Find the best sidecar for a capability kind, optionally filtered by model.
 * Preference order:
 *   1. enabled
 *   2. capability available
 *   3. (if model given) capabilities[kind].models includes(model)
 *   4. higher gpuPercent first
 *   5. lower activeRequests first
 */
const FRESHNESS_MS = 5 * 60_000;

function isFreshAndHealthy(s: Sidecar, now = Date.now()): boolean {
  if (s.healthStatus === 'unhealthy') return false;
  if (!s.lastSeen) return true; // manual / http-ping entries never heartbeat
  const seen = Date.parse(s.lastSeen);
  return !Number.isFinite(seen) || now - seen <= FRESHNESS_MS;
}

export function getSidecarForCapability(
  kind: SidecarCapabilityKind,
  model?: string,
  /** Optional veto (e.g. a sidecar with an active embedding capability fault). */
  skip?: (s: Sidecar) => boolean,
): Sidecar | null {
  const cands = listSidecars({ capability: kind, enabled: true }).filter(s => {
    if (skip && skip(s)) return false;
    if (!model) return true;
    return s.capabilities[kind]?.models?.includes(model);
  });
  cands.sort((a, b) => {
    // A peer that is unhealthy or has been silent for a long time sorts last,
    // so a stale registry entry never wins over a live one.
    const au = isFreshAndHealthy(a) ? 0 : 1;
    const bu = isFreshAndHealthy(b) ? 0 : 1;
    if (au !== bu) return au - bu;
    const ag = a.capabilities[kind]?.gpuPercent ?? 0;
    const bg = b.capabilities[kind]?.gpuPercent ?? 0;
    if (ag !== bg) return bg - ag;
    return (a.activeRequests ?? 0) - (b.activeRequests ?? 0);
  });
  return cands[0] ?? null;
}

export function listAvailableModels(kind: SidecarCapabilityKind): string[] {
  const set = new Set<string>();
  for (const s of listSidecars({ capability: kind, enabled: true })) {
    for (const m of s.capabilities[kind]?.models ?? []) set.add(m);
  }
  return [...set];
}

export function createSidecar(input: Omit<Sidecar, 'id'>): Sidecar {
  const cfg = readConfig();
  const sidecars: Sidecar[] = (Array.isArray(cfg.sidecars) ? cfg.sidecars : []).map(migrate);
  const sc: Sidecar = {
    id: randomUUID(),
    healthStatus: 'unknown',
    ...input,
    capabilities: input.capabilities ?? {},
  };
  sidecars.push(sc);
  cfg.sidecars = sidecars;
  writeConfig(cfg);
  return sc;
}

export function updateSidecar(id: string, patch: Partial<Sidecar>): Sidecar | null {
  const cfg = readConfig();
  const sidecars: Sidecar[] = (Array.isArray(cfg.sidecars) ? cfg.sidecars : []).map(migrate);
  const idx = sidecars.findIndex(s => s.id === id);
  if (idx < 0) return null;
  sidecars[idx] = { ...sidecars[idx], ...patch, id };
  cfg.sidecars = sidecars;
  writeConfig(cfg);
  return sidecars[idx];
}

export function deleteSidecar(id: string): boolean {
  const cfg = readConfig();
  const sidecars: Sidecar[] = (Array.isArray(cfg.sidecars) ? cfg.sidecars : []).map(migrate);
  const next = sidecars.filter(s => s.id !== id);
  if (next.length === sidecars.length) return false;
  cfg.sidecars = next;
  writeConfig(cfg);
  return true;
}

export function sidecarUrl(s: Sidecar): string {
  return `${s.protocol}://${s.host}:${s.port}`;
}

export function sidecarServiceUrl(s: Sidecar, kind: SidecarCapabilityKind): string {
  const cap = s.capabilities[kind];
  const port = cap?.port ?? s.port;
  return `${s.protocol}://${s.host}:${port}`;
}

/**
 * Merge a capabilities snapshot into a sidecar. Used by both /health probing
 * and WebSocket register/heartbeat handlers.
 */
export function mergeCapabilities(
  id: string,
  capabilities: Sidecar['capabilities'],
  source: NonNullable<Sidecar['capabilitiesSource']>,
): Sidecar | null {
  return updateSidecar(id, {
    capabilities,
    capabilitiesSource: source,
    lastSeen: new Date().toISOString(),
    healthStatus: 'healthy',
  });
}

export interface HealthResult {
  id: string;
  status: 'healthy' | 'unhealthy';
  lastHealthCheck: string;
  responseTimeMs: number;
  capabilities?: Sidecar['capabilities'];
  error?: string;
}

/**
 * GET <sidecar>/health. The sidecar SHOULD respond with
 *   { ok: true, capabilities: {...} }
 * but a bare 200 also counts as healthy. If capabilities are present, they
 * replace the stored snapshot.
 */
export async function pingSidecar(id: string, timeoutMs = 5000): Promise<HealthResult | null> {
  const sc = getSidecar(id);
  if (!sc) return null;
  const url = `${sidecarUrl(sc)}/health`;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status: 'healthy' | 'unhealthy' = 'unhealthy';
  let error: string | undefined;
  let capabilities: Sidecar['capabilities'] | undefined;
  try {
    const headers: Record<string, string> = {};
    if (sc.authToken) headers['Authorization'] = `Bearer ${sc.authToken}`;
    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    if (res.ok) {
      status = 'healthy';
      try {
        const body = await res.json() as any;
        if (body && typeof body === 'object' && body.capabilities) {
          capabilities = body.capabilities;
        }
      } catch { /* not JSON; still healthy */ }
    } else {
      error = `HTTP ${res.status}`;
    }
  } catch (e: any) {
    error = e?.message ?? String(e);
  } finally {
    clearTimeout(timer);
  }
  const responseTimeMs = Date.now() - started;
  const lastHealthCheck = new Date().toISOString();
  const patch: Partial<Sidecar> = { healthStatus: status, lastHealthCheck, responseTimeMs };
  if (capabilities && status === 'healthy') {
    patch.capabilities = capabilities;
    patch.capabilitiesSource = 'http-ping';
    patch.lastSeen = lastHealthCheck;
  }
  updateSidecar(id, patch);
  return { id, status, lastHealthCheck, responseTimeMs, capabilities, error };
}
