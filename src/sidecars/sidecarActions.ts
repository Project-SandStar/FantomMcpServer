import type { Sidecar } from '../admin/types.js';
import { sidecarUrl } from './registry.js';

export type SidecarAction = 'start' | 'stop' | 'acquire' | 'release' | 'pull' | 'pull-and-load';

interface ActionPayload { role: string; model?: string }

async function postJson<T>(url: string, body: unknown, authToken?: string, timeoutMs = 300_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await res.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
    return parsed as T;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson<T>(url: string, authToken?: string, timeoutMs = 10_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {};
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const res = await fetch(url, { method: 'GET', headers, signal: ctrl.signal });
    const text = await res.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
    return parsed as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Mirror the soundsuite sidecar's GET /status snapshot. */
export interface SidecarStatusSnapshot {
  agentUrl?: string;
  hostname?: string;
  mode?: string;
  containers?: Record<string, {
    name: string;
    status: string;
    image?: string;
    model?: string | null;
    type?: 'ollama' | 'vllm' | 'utility';
    config?: { image?: string; model?: string | null; port?: number; vram?: number; type?: string; gpuOnly?: boolean };
    loadedModels?: Array<{ name: string; size?: string; gpuPercent?: number; processor?: string; until?: string }>;
  }>;
  roles?: Record<string, { activeRequests?: number; idleTimerActive?: boolean; lastAcquire?: string | null; lastRelease?: string | null }>;
  gpus?: Array<{ index: number; name?: string; memoryMb?: number; tempC?: number }>;
  vram?: { totalMb: number; freeMb: number; usedMb: number; perRole?: Record<string, { actualMb: number; budgetMb: number; priority?: string; gpuOnly?: boolean }> };
  freeVram?: number;
  totalVram?: number;
  containerNames?: string[];
  version?: string;
}

// Older sidecars expose GET /status; the current Next.js-based sidecar serves
// the same snapshot at /api/status and returns its HTML 404 page for /status.
// Try both so a route mismatch is not reported as "couldn't reach".
const STATUS_PATHS = ['/api/status', '/status'] as const;

export async function fetchSidecarStatus(s: Sidecar): Promise<SidecarStatusSnapshot> {
  let lastErr: unknown;
  for (const p of STATUS_PATHS) {
    try {
      const snap = await getJson<unknown>(`${sidecarUrl(s)}${p}`, s.authToken);
      // An HTML body (e.g. a framework 404 page) parses as a string — not a snapshot.
      if (snap && typeof snap === 'object') return snap as SidecarStatusSnapshot;
      lastErr = new Error(`${p} returned a non-JSON body`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function dispatchSidecarAction(
  s: Sidecar,
  action: SidecarAction,
  payload: ActionPayload,
): Promise<unknown> {
  const timeout = action === 'pull-and-load' || action === 'pull' ? 600_000 : 60_000;

  // Prefer the WS tunnel if the sidecar is connected as one of our masters —
  // works through NAT, no extra inbound port required on the sidecar.
  try {
    const { sendCommandToSidecar } = await import('./soundsuiteMaster.js');
    const wsAction = action === 'pull' || action === 'pull-and-load' ? 'start' : action;
    const result = await sendCommandToSidecar(s.id, wsAction, { role: payload.role, ...(payload.model ? { model: payload.model } : {}) }, timeout);
    if (result !== null) return result;
  } catch (err) {
    // WS path failed mid-flight; fall through to HTTP.
    console.warn('[sidecar-action] WS dispatch failed, falling back to HTTP:', (err as Error).message);
  }

  // HTTP fallback. Sidecar exposes start/stop/acquire/release; pull is
  // implicit on /start for ollama roles.
  const path = action === 'pull' || action === 'pull-and-load' ? '/start' : `/${action}`;
  return postJson(`${sidecarUrl(s)}${path}`, payload, s.authToken, timeout);
}
