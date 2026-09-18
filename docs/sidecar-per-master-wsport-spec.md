# Sound Suite Sidecar — Per-Master WebSocket Port (Addendum to multi-master spec)

**Repo:** `court-lens-mcp/sideCar`
**Goal:** Let each master in `state.masters` choose its own WS port, so a single sidecar can serve multiple masters that don't all share the same `wsPort`.
**Why:** `ws-client.ts:642` hardcodes `const wsPort = 3002`. When Fantom MCP runs on the same host as Sound Suite, port 3002 is owned by Sound Suite's WS listener — Fantom can't bind it. Fantom's HTTP master endpoint is `:3848` and it can accept WS upgrades on the *same* port. The sidecar therefore needs to learn that for the Fantom master, `wsPort=3848`.
**Default behavior is preserved:** when a master config doesn't specify `wsPort`, the sidecar still uses 3002 — Sound Suite is unaffected.

---

## 1. Current code

`sideCar/src/lib/ws-client.ts:640-643`
```ts
function connectMaster(m: MasterConnection): void {
  // …
  const wsPort = 3002;
  const wsUrl = `ws://${new URL(m.serverUrl).hostname}:${wsPort}/sidecar`;
  // …
}
```

The fixed `3002` is the only thing blocking per-master flexibility.

---

## 2. Schema change

### 2.1 `MasterConnection` (state.ts)

Add an optional `wsPort: number` field:

```ts
export interface MasterConnection {
  serverUrl: string;
  wsPort?: number;                  // NEW — defaults to 3002 when undefined
  ws: WebSocket | null;
  // …existing fields…
}
```

### 2.2 Config file shape (config.ts)

`masters` array entries can already be `string | { serverUrl, authToken? }`. Extend the object form:

```jsonc
{
  "masters": [
    "http://soundsuite.master/",                                  // string → wsPort=3002 default
    { "serverUrl": "http://fantom.master:3848/", "wsPort": 3848 } // object with override
  ]
}
```

`parseMastersField` becomes:
```ts
function parseMastersField(val: unknown): Array<{ serverUrl: string; authToken?: string; wsPort?: number }> {
  if (!Array.isArray(val)) return [];
  return val
    .map(item => {
      if (typeof item === 'string') return { serverUrl: item };
      if (item && typeof item === 'object' && typeof (item as any).serverUrl === 'string') {
        const r: { serverUrl: string; authToken?: string; wsPort?: number } = {
          serverUrl: (item as any).serverUrl,
        };
        if (typeof (item as any).authToken === 'string') r.authToken = (item as any).authToken;
        if (typeof (item as any).wsPort === 'number' && (item as any).wsPort > 0) r.wsPort = (item as any).wsPort;
        return r;
      }
      return null;
    })
    .filter((x): x is { serverUrl: string; authToken?: string; wsPort?: number } => !!x);
}
```

`addMaster(serverUrl, authToken?, wsPort?)` plumbs the new arg into `state.masters.set(serverUrl, { serverUrl, authToken, wsPort, … })`.

### 2.3 Env var (optional)

Today: `SIDECAR_MASTERS=url1,url2`.
Extend syntax to allow `url|wsPort`:
```
SIDECAR_MASTERS=http://soundsuite.master/,http://fantom.master:3848/|3848
```
Parser:
```ts
const env = process.env.SIDECAR_MASTERS;
if (env) {
  for (const tok of env.split(',').map(s => s.trim()).filter(Boolean)) {
    const [serverUrl, wsPortStr] = tok.split('|');
    const wsPort = wsPortStr ? Number(wsPortStr) : undefined;
    addMaster(serverUrl, undefined, Number.isFinite(wsPort) ? wsPort : undefined);
  }
}
```

---

## 3. Code change in `ws-client.ts`

```ts
function connectMaster(m: MasterConnection): void {
  // …
  const wsPort = m.wsPort ?? 3002;        // ← only line that changes
  const wsUrl = `ws://${new URL(m.serverUrl).hostname}:${wsPort}/sidecar`;
  // …
}
```

That's the entire runtime change.

---

## 4. HTTP API

`POST /api/masters` already accepts `{ serverUrl, authToken? }`. Extend body to:
```ts
{ serverUrl: string; authToken?: string; wsPort?: number }
```

The handler validates `wsPort` is a positive integer if present, and passes it to `addMaster()`.

`GET /api/masters` already returns master state. Add `wsPort` to each entry so operators can see the current value:
```jsonc
{
  "masters": [
    { "serverUrl": "...", "connectionMode": "websocket", "lastHeartbeatAt": …, "wsPort": 3002 },
    { "serverUrl": "...", "connectionMode": "websocket", "lastHeartbeatAt": …, "wsPort": 3848 }
  ]
}
```

`DELETE /api/masters/:url` — no change.

---

## 5. Persistence

`saveConfig` already round-trips `masters: [{serverUrl, authToken?}]`. Extend to also serialize `wsPort` when set:
```ts
{
  masters: [...state.masters.values()].map(m => ({
    serverUrl: m.serverUrl,
    ...(m.authToken ? { authToken: m.authToken } : {}),
    ...(m.wsPort ? { wsPort: m.wsPort } : {}),
  })),
  serverUrl: legacyServerUrl(),     // unchanged
}
```

---

## 6. Reconnect behavior

`scheduleReconnect(m)` already iterates per master; nothing changes — each master simply uses its own `m.wsPort` when reconnecting.

When `applyConfig(m, payload)` rekeys a master via `serverUrl` change, it should preserve the existing `m.wsPort`. (Trivially true with current implementation since `rekeyMaster` mutates the key, not the value.)

---

## 7. Wire format

The frames the sidecar SENDS to the master are unchanged. The master's WS server still receives `register`, `heartbeat`, `result` exactly as today. So existing masters that do NOT change their WS port continue to work without any updates on their side.

---

## 8. Acceptance tests

1. **Default port — back-compat.** Master entry `"http://x/"` (string form) connects to `ws://x:3002/sidecar`. Behavior identical to today.
2. **Custom port — string config.** Master entry `{serverUrl:"http://y:3848/", wsPort:3848}` connects to `ws://y:3848/sidecar`.
3. **Mixed fleet.** Sound Suite at port 3002 + Fantom at 3848. Both masters show `connectionMode:'websocket'` after a few heartbeats. Stopping Fantom's WS does not affect Sound Suite (and vice versa).
4. **Runtime add with port.** `POST /api/masters {serverUrl:"http://z:9000/", wsPort:9000}` adds and immediately connects to `ws://z:9000/sidecar`.
5. **Reconnect uses the custom port.** Kill the master, sidecar reconnects to the same `wsPort`, not 3002.
6. **Persisted across restart.** Sidecar restart: `wsPort` survives the round-trip through `saveConfig` / `loadSavedConfig`.

---

## 9. Files to change

| File | Change |
|---|---|
| `sideCar/src/lib/state.ts` | Add `wsPort?: number` to `MasterConnection`. |
| `sideCar/src/lib/ws-client.ts:642` | `const wsPort = 3002;` → `const wsPort = m.wsPort ?? 3002;` |
| `sideCar/src/lib/config.ts` | `parseMastersField` reads `wsPort`. `addMaster` accepts and stores it. `saveConfig` serializes it. Optionally extend env-var parser. |
| `sideCar/src/app/api/masters/route.ts` | `POST` accepts `wsPort` and validates. `GET` returns `wsPort` in each entry. |

Approximate diff size: **~25 LOC**, mostly mechanical.

---

## 10. Operator workflow once shipped

```bash
# Add Fantom MCP as a master (Fantom uses single port for HTTP+WS):
curl -X POST http://192.0.2.10:8098/api/masters \
  -H 'content-type: application/json' \
  -d '{"serverUrl":"http://fantom-host:3848","wsPort":3848}'
```

The sidecar opens `ws://fantom-host:3848/sidecar`, registers, and starts heartbeating Fantom on the same port Fantom uses for everything else.

---

## 11. Open question — why not just per-master HTTP+WS together?

A natural further step is to drop `wsPort` entirely and require WS on the same port as `serverUrl`. That is technically cleaner but breaks Sound Suite's existing two-port deployment. Per-master `wsPort` is the conservative path: zero impact on existing masters, one extra field for new ones.

A future v2 could deprecate `wsPort` once all masters consolidate WS+HTTP on a single port.
