/**
 * WebSocket endpoint for sidecars at /ws/sidecars.
 *
 * Wire format (sidecar-initiated; we never push first):
 *   sidecar → server: { type: 'register',  sidecarId, capabilities }
 *   sidecar → server: { type: 'heartbeat', sidecarId, capabilities?, activeRequests? }
 *   server → sidecar: { type: 'ack', sidecarId, ts }
 *
 * The server maintains a Map<sidecarId, WebSocket> (live tunnels). When a frame
 * arrives, we merge capabilities into the registry and stamp lastSeen.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer, IncomingMessage } from 'http';
import { mergeCapabilities, getSidecar, updateSidecar } from './registry.js';
import type { Sidecar } from '../admin/types.js';

const WS_PATH = '/ws/sidecars';
const STALE_MS = 30_000;

const live = new Map<string, WebSocket>();

interface RegisterMsg {
  type: 'register';
  sidecarId: string;
  capabilities?: Sidecar['capabilities'];
}
interface HeartbeatMsg {
  type: 'heartbeat';
  sidecarId: string;
  capabilities?: Sidecar['capabilities'];
  activeRequests?: number;
}
type IncomingMsg = RegisterMsg | HeartbeatMsg;

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function handle(ws: WebSocket, raw: string): void {
  let msg: IncomingMsg;
  try {
    msg = JSON.parse(raw) as IncomingMsg;
  } catch {
    send(ws, { type: 'error', message: 'invalid JSON' });
    return;
  }
  if (!msg || typeof msg !== 'object' || !msg.type || !msg.sidecarId) {
    send(ws, { type: 'error', message: 'missing type or sidecarId' });
    return;
  }
  if (!getSidecar(msg.sidecarId)) {
    send(ws, { type: 'error', message: `unknown sidecarId ${msg.sidecarId}` });
    return;
  }

  const ts = new Date().toISOString();

  if (msg.type === 'register') {
    if (msg.capabilities) {
      mergeCapabilities(msg.sidecarId, msg.capabilities, 'ws-register');
    } else {
      updateSidecar(msg.sidecarId, { lastSeen: ts, healthStatus: 'healthy' });
    }
    replaceLive(msg.sidecarId, ws);
    send(ws, { type: 'ack', sidecarId: msg.sidecarId, ts });
    return;
  }

  if (msg.type === 'heartbeat') {
    const patch: Partial<Sidecar> = { lastSeen: ts, healthStatus: 'healthy' };
    if (msg.capabilities) {
      patch.capabilities = msg.capabilities;
      patch.capabilitiesSource = 'ws-heartbeat';
    }
    if (typeof msg.activeRequests === 'number') patch.activeRequests = msg.activeRequests;
    updateSidecar(msg.sidecarId, patch);
    replaceLive(msg.sidecarId, ws);
    return;
  }
}

/** Bind a sidecarId to a socket, terminating any superseded socket so a
 *  reconnecting client cannot leave its previous connection ESTABLISHED. */
function replaceLive(sidecarId: string, ws: WebSocket): void {
  const prev = live.get(sidecarId);
  if (prev && prev !== ws) { try { prev.terminate(); } catch { /* already gone */ } }
  live.set(sidecarId, ws);
}

export function attachSidecarWsServer(httpServer: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  // Single shared upgrade dispatcher across all WS endpoints on this server.
  // Other WS attachers (soundsuiteMaster) register additional paths via the
  // dispatcher map below.
  if (!(httpServer as any).__wsDispatcher) {
    const map = new Map<string, WebSocketServer>();
    (httpServer as any).__wsDispatcher = map;
    httpServer.on('upgrade', (req, socket, head) => {
      const url = req.url ?? '';
      const path = url.split('?')[0];
      const target = map.get(path);
      if (!target) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      target.handleUpgrade(req, socket as any, head, ws => {
        target.emit('connection', ws, req);
      });
    });
  }
  ((httpServer as any).__wsDispatcher as Map<string, WebSocketServer>).set(WS_PATH, wss);

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
    ws.on('message', data => {
      const text = typeof data === 'string' ? data : data.toString('utf-8');
      try {
        handle(ws, text);
      } catch (err) {
        console.error('[sidecar-ws] handler error:', err);
      }
    });
    ws.on('close', () => {
      for (const [id, sock] of live) {
        if (sock === ws) live.delete(id);
      }
    });
    ws.on('error', () => {
      for (const [id, sock] of live) {
        if (sock === ws) live.delete(id);
      }
    });
  });

  // Mark stale sidecars unhealthy
  setInterval(() => {
    const now = Date.now();
    for (const [id] of live) {
      const sc = getSidecar(id);
      if (!sc) { live.delete(id); continue; }
      const lastSeenMs = sc.lastSeen ? Date.parse(sc.lastSeen) : 0;
      if (now - lastSeenMs > STALE_MS) {
        updateSidecar(id, { healthStatus: 'unhealthy' });
      }
    }
  }, 5000).unref?.();

  console.log(`[sidecar-ws] listening at ${WS_PATH}`);
  return wss;
}

export function isSidecarConnected(id: string): boolean {
  const ws = live.get(id);
  return !!ws && ws.readyState === ws.OPEN;
}
