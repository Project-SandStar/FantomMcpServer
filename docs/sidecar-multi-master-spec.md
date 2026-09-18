# Sound Suite Sidecar — Multi-Master Support

**Repo:** `court-lens-mcp/sideCar`
**Goal:** Let one sidecar (one GPU host) be reachable from multiple independent consumer apps simultaneously (e.g. Sound Suite *and* Fantom MCP). Today the sidecar binds to exactly one master; switching masters drops the previous tunnel.
**Constraint:** Wire format unchanged where possible — existing single-master masters keep working without code changes.

---

## 1. Current behavior

`state.ts:184`
```ts
serverUrl: null as string | null,
```

`ws-client.ts:640-650` — single WS connect:
```ts
export function connectWebSocket(): void {
  if (!state.serverUrl) return;
  const serverHost = new URL(state.serverUrl).hostname;
  const wsUrl = `ws://${serverHost}:${wsPort}/sidecar`;
  const ws = new WebSocket(wsUrl);
  // …state.ws = ws…
}
```

`ws-client.ts:177-190` — master pushes a new URL, *overwrites* the old one:
```ts
if (typeof payload.serverUrl === 'string' && payload.serverUrl) {
  if (state.serverUrl !== payload.serverUrl) {
    log.info(`Master pushed serverUrl: ${state.serverUrl} → ${payload.serverUrl}`);
    state.serverUrl = payload.serverUrl;
  }
}
```

HTTP fallbacks (heartbeat, poll, result, update-check) all target the single `state.serverUrl`:

| Purpose | File:line | URL |
|---|---|---|
| Heartbeat (HTTP) | `ws-client.ts:520` | `${state.serverUrl}/api/admin/gpu/sidecars/heartbeat` |
| Command poll (HTTP) | `ws-client.ts:553` | `${state.serverUrl}/api/admin/gpu/sidecars/poll` |
| Command result (HTTP) | `ws-client.ts:588` | `${state.serverUrl}/api/admin/gpu/sidecars/result` |
| Update check | `ws-client.ts:617-627` | `${state.serverUrl}` |

Reconnect, disconnect, and tracker state all assume one tunnel.

---

## 2. Proposed model

Replace the single `serverUrl: string | null` with a **map of masters keyed by their `serverUrl`**, each carrying its own WS, HTTP-fallback timers, and connection mode.

### New shape (in `state.ts`)

```ts
export interface MasterConnection {
  serverUrl: string;                 // canonical key, e.g. "https://fantom.local:3848"
  ws: WebSocket | null;
  connectionMode: 'websocket' | 'http' | 'disconnected';
  wsReconnectDelay: number;
  wsReconnectTimer: NodeJS.Timeout | null;
  heartbeatTimer: NodeJS.Timeout | null;
  pollTimer: NodeJS.Timeout | null;
  lastSeenServerVersion?: string;
  lastHeartbeatAt?: number;
  // Per-master command bookkeeping (so commands from master A
  // don't leak result frames back to master B):
  pendingCommands: Map<string, PendingCommand>;
  authToken?: string;                // optional, see §6
}

// Replace this on `state`:
//   serverUrl: string | null
// with:
masters: new Map<string, MasterConnection>(),
```

Helper:
```ts
function ensureMaster(url: string): MasterConnection {
  let m = state.masters.get(url);
  if (!m) {
    m = createMasterConnection(url);
    state.masters.set(url, m);
  }
  return m;
}
```

The **WS server side** of soundsuite (the master) does not change — each master still sees a normal one-to-one WS connection. Only the *sidecar* learns to fan out.

---

## 3. Lifecycle changes (in `ws-client.ts`)

Every function that reads/writes `state.serverUrl` becomes per-master:

### 3.1 Connect (`connectWebSocket`, line 640)

```ts
export function connectAllMasters(): void {
  for (const m of state.masters.values()) connectMaster(m);
}

function connectMaster(m: MasterConnection): void {
  if (m.ws && m.ws.readyState === m.ws.OPEN) return;
  const wsUrl = `ws://${new URL(m.serverUrl).hostname}:${wsPort}/sidecar`;
  const ws = new WebSocket(wsUrl);
  m.ws = ws;
  ws.on('open', () => {
    m.connectionMode = 'websocket';
    m.wsReconnectDelay = 1000;
    sendRegister(m);    // existing logic, parameterized on m
  });
  ws.on('message', (data) => handleFrame(m, data));
  ws.on('close', () => scheduleReconnect(m));
  ws.on('error', () => scheduleReconnect(m));
}
```

`scheduleReconnect`, `disconnectWebSocket` become per-master.

### 3.2 Heartbeat / poll / result (lines 515-588)

Each becomes a loop over `state.masters`:
```ts
function startHeartbeats(): void {
  for (const m of state.masters.values()) startHeartbeat(m);
}

async function sendHeartbeat(m: MasterConnection): Promise<void> {
  if (m.connectionMode === 'websocket' && m.ws?.readyState === m.ws.OPEN) {
    m.ws.send(JSON.stringify({ type: 'heartbeat', ...buildHeartbeatBody() }));
  } else {
    await httpPost(`${m.serverUrl}/api/admin/gpu/sidecars/heartbeat`, buildHeartbeatBody(), m.authToken);
  }
}
```

Same pattern for `pollCommands(m)` and `postResult(m, commandId, result)`.

### 3.3 Command bookkeeping (already in `ws-client.ts`)

Today's `pendingCommands` map is module-global. Move it onto `MasterConnection` so a result frame from master A never resolves a promise queued by master B. The frame handler dispatches by master:

```ts
function handleFrame(m: MasterConnection, data: WebSocket.RawData) {
  const msg = JSON.parse(data.toString());
  switch (msg.type) {
    case 'command': enqueueCommand(m, msg); break;
    case 'config-push': applyConfig(m, msg.payload); break;  // see §4
    // …
  }
}
```

### 3.4 Master-pushed serverUrl reassignment (line 187-190)

Today: master sends `{type:'config', payload:{serverUrl}}` and the sidecar switches. Change this to be additive:
- If the payload includes a NEW URL not in `state.masters`, **add** it as another master and connect.
- If it refers to the *current* master and the URL is being renamed, update that entry's key.
- Never silently drop other masters.

Add an explicit revoke message: `{type:'config', payload:{revokeServerUrl: '…'}}` that the master can send to disconnect itself; or expose admin POST `/api/masters/:url` (DELETE) on the sidecar.

---

## 4. Configuration

### 4.1 Bootstrap from disk

Today `state.serverUrl` is loaded once from `~/.config/sidecar.json` (or wherever `state.ts` reads it). Change the schema:

```jsonc
{
  // Back-compat: still read singular field if present, push into the array.
  "serverUrl": "https://soundsuite.master/",         // optional, legacy
  "masters": [
    "https://soundsuite.master/",
    "https://fantom.local:3848/"
  ],
  "authTokens": {                                    // see §6
    "https://fantom.local:3848/": "fantom-bearer-…"
  }
}
```

On startup:
```ts
const cfg = loadConfigFromDisk();
const urls = new Set<string>([
  ...(cfg.masters ?? []),
  ...(cfg.serverUrl ? [cfg.serverUrl] : []),
]);
for (const u of urls) ensureMaster(u);
connectAllMasters();
```

### 4.2 Runtime add/remove via HTTP

New endpoints on the sidecar (Next.js routes under `/api/`):

| Method | Path | Body | Effect |
|---|---|---|---|
| `GET` | `/api/masters` | — | Lists `[{ serverUrl, mode, lastSeen, version }]` |
| `POST` | `/api/masters` | `{ serverUrl, authToken? }` | Adds + connects |
| `DELETE` | `/api/masters/:encodedUrl` | — | Disconnects + removes |

Persist the resulting list back to the config file.

### 4.3 Env-var override (optional)

```
SIDECAR_MASTERS=https://soundsuite.master/,https://fantom.local:3848/
```
parsed as comma-separated list and merged with the disk config.

---

## 5. Wire format compatibility

No change for masters that still use the single-master flow:

- The sidecar still sends `register`, `heartbeat`, `command`/`result` frames in the same shape.
- Each master still receives them as if it were the only one. The sidecar duplicates what it broadcasts.
- The only field a master *might* care about is the `agentUrl` (the sidecar's self-identifier) — keep it identical across masters so each master tracks the same sidecar identity.

If two masters end up sharing a sidecar, they will independently command it. Existing per-role concurrency (`activeRequests`, `idleTimerActive` in `RoleStatus`) already serializes correctly because it lives on the sidecar, not on a master.

---

## 6. Authentication (recommended add-on)

Today the sidecar endpoints have no auth (CORS=`*`). With multiple masters this is now a real footgun — anyone on the network can register itself. Add an optional `Authorization: Bearer <token>` check on:

- `POST /api/masters`
- `DELETE /api/masters/:url`
- The HTTP-fallback endpoints if you want them gated

`MasterConnection.authToken` is included in every outbound HTTP call from the sidecar so the master can verify it back.

A per-master shared secret in the config file is the simplest first step.

---

## 7. Files to change

| File | Change |
|---|---|
| `sideCar/src/lib/state.ts` | Replace `serverUrl: string \| null` with `masters: Map<string, MasterConnection>`. Add `MasterConnection` interface. Migrate persistence read/write. |
| `sideCar/src/lib/ws-client.ts` | Replace every `state.serverUrl`/`state.ws` reference with per-master accessors. Split `connectWebSocket`, `sendHeartbeat`, `pollCommands`, `postResult`, `scheduleReconnect`, `disconnectWebSocket` into per-master variants plus loop wrappers. Move `pendingCommands` onto `MasterConnection`. Update `applyConfig` to be additive (§3.4). |
| `sideCar/src/app/api/masters/route.ts` *(new)* | `GET` / `POST` handlers. |
| `sideCar/src/app/api/masters/[serverUrl]/route.ts` *(new)* | `DELETE` handler. |
| `sideCar/src/app/api/status/route.ts` | Include `masters: [...]` array in the snapshot so each master sees the full list of who else is connected. |
| `sideCar/src/lib/config.ts` (or wherever the JSON config is read) | Read both `serverUrl` (legacy) and `masters[]`; write `masters[]` from now on. |

Approximate diff size: **~250–400 LOC**, mostly mechanical.

---

## 8. Acceptance tests

1. **Single master, legacy config** — start with old `{serverUrl:"…"}` config; verify behavior identical to today.
2. **Two masters from disk** — `masters: [A, B]`; both receive `register` frame; both heartbeat every 5 s; killing master A's WS does not affect master B.
3. **Runtime add** — `POST /api/masters {serverUrl: "…C"}` on a running sidecar adds C without dropping A or B.
4. **Runtime remove** — `DELETE /api/masters/<urlencoded-A>` closes A, leaves B and C.
5. **Independent commanding** — A sends `command:start{role:embedding}`; B sends `command:stop{role:embedding}` 1 s later. Both receive their own `result` frame in the right order; neither sees the other's frame.
6. **Reconnect isolation** — A's master process restarts (closing its WS). The sidecar reconnects to A only; B's tunnel is untouched.
7. **Heartbeat HTTP fallback per-master** — block WS to A only (firewall the master's port). A flips to `http` mode; B stays on `websocket`.

---

## 9. Open questions

- **Auth model.** Per-master Bearer is the easy answer. Anything fancier (mTLS, OAuth) is out of scope for v1.
- **Pull conflicts.** If A and B both ask for `pull(role=embedding)` of different models simultaneously, the sidecar today serializes via the single role lock. That stays correct — second pull queues. Worth documenting.
- **Status fan-out.** Should `/api/status` be different per master (only show models that master cares about), or the same global view? Simpler: same global view; let masters filter.
- **Idle-timeout precedence.** If A configures `idleTimeouts.embedding=300` and B configures `60`, which wins? Recommend: each master's config writes are namespaced by master URL; the effective timeout is the *max* across active masters (so no master's expectations are broken by another's tighter timer). Spec this explicitly.

---

## 10. Suggested rollout

1. Land §3 (per-master loops + pendingCommands move) behind a feature flag `SIDECAR_MULTIMASTER=1`. Default off; existing single-`serverUrl` path untouched.
2. Add §4.1 (config schema, additive).
3. Add §4.2 endpoints.
4. Flip the flag default to on after one stable week.
5. Drop the legacy code path one release later.
