# Sidecars: how GPU hosts work with the Fantom MCP Server

The Fantom MCP Server does not run large models itself. Anything GPU-heavy, such as embedding thousands of code nodes, reranking search results, or answering questions over a codebase with a recursive language model, is delegated to a **SideCar**: a small agent that runs on a GPU host, manages the model containers there, and reports what it can do. The server keeps a registry of sidecars and routes work to them by capability.

One sidecar serves one GPU host. Any number of applications ("masters") can share the same sidecar; the Fantom MCP Server is one such master.

## The pieces

```
┌───────────────────────────┐                ┌──────────────────────────────────────┐
│ Fantom MCP Server (master)│                │ GPU host                             │
│                           │  ws://:3003    │  SideCar agent            :8098      │
│  sidecar registry ◀───────┼──/sidecar──────┼─▶ register / heartbeat               │
│  (config/*.json)          │                │                                      │
│                           │  http          │  ss-embedding      Ollama   :11434   │
│  embedding fan-out ───────┼──/api/embed────┼─▶ ss-code-embedding Ollama  :11437   │
│  reranker client ─────────┼──/rerank───────┼─▶ ss-reranker      vLLM     :8099    │
│  RLM tool loop ───────────┼──/v1/chat──────┼─▶ ss-rlm           vLLM     :8100    │
│  dashboard fleet table    │                │  ss-ocr, ss-completion, ss-cuda …    │
└───────────────────────────┘                └──────────────────────────────────────┘
```

- **SideCar agent** (port 8098 by default): a Docker container on the GPU host. It starts and stops the model containers, tracks VRAM, exposes `GET /api/status`, and connects out to each master it knows about.
- **Role containers**: one container per role. The agent reports them in every heartbeat. Ports are per role, so each capability the server records carries its own port.
- **Fantom MCP Server as master**: listens on `ws://<server>:3003/sidecar`, records what each sidecar can do, and sends inference requests directly to the role container's port over HTTP.

## Roles and capabilities

The agent speaks in **roles**; the server stores **capabilities**. The mapping lives in `src/sidecars/soundsuiteMaster.ts`.

| Sidecar role | Capability | Default port | Used by |
|---|---|---|---|
| `embedding` | `embedding` | 11434 (Ollama) | Documentation vectors; code vectors when no code embedder exists |
| `code-embedding` | `embedding-code` | 11437 (Ollama) | Code vectors, preferred over `embedding` for code |
| `reranker` | `reranker` | 8099 (vLLM) | Cross-encoder reranking of semantic search results |
| `rlm` | `rlm` | 8100 (vLLM) | `askCodebase` recursive question answering |
| `completion` | `llm` | 11434 (Ollama) | General text generation when configured |
| `ocr` | `ocr` | 11434 (Ollama) | Reserved for document OCR |
| `cuda`, `encoder` | not mapped | — | Infrastructure containers, logged once as unmapped |

Each capability records: whether it is available, the model names it can serve, the model currently loaded, the GPU percentage of that model (100 means fully on GPU, -1 means CPU-only), and the port.

## How a sidecar joins

1. **The sidecar connects to the master.** It opens `ws://<server-host>:3003/sidecar` and sends a `register` frame:
   ```json
   { "type": "register", "agentUrl": "http://10.0.0.5:8098", "hostname": "gpu-01", "containers": ["ss-embedding", "ss-code-embedding"] }
   ```
   The server matches `agentUrl` against its registry by host and port. If there is no entry it creates one automatically, marked healthy with capability source `ws-register`, and replies `{ "type": "registered", "ok": true }`.

2. **Heartbeats every 5 seconds.** Each heartbeat carries `statusData`: containers with their status, loaded models and ports, VRAM totals, GPU list, per-role active requests. The server turns the containers into capabilities, updates `lastSeen`, and caches the snapshot for the dashboard's **Fleet** table.

3. **HTTP fallback.** If the WebSocket cannot be established the sidecar posts the same heartbeat to `POST /api/admin/gpu/sidecars/heartbeat` on the server's HTTP port and polls `POST /api/admin/gpu/sidecars/poll` for commands.

4. **Reconnects.** When a sidecar reconnects and re-registers from the same `agentUrl`, the server marks the previous socket as superseded and the liveness sweep terminates it after a grace period (default 45 seconds, `FANTOM_SIDECAR_SUPERSEDED_GRACE_MS`; 0 terminates immediately). Sidecars from version 2.3.82 enforce one socket per master themselves, so supersedes should be rare; if a sidecar reporting 2.3.82 or newer still supersedes its socket three or more times in ten minutes the server logs a warning, because that now indicates a remaining reconnect trigger or a client regression rather than background noise. The grace itself stays in place for older or third-party clients. A socket that never registers is closed after 30 seconds. Every 30 seconds the server pings all sockets and terminates a socket only after three consecutive unanswered pings (about 90 seconds), because a sidecar that is busy loading a model or talking to Docker can block its event loop for longer than one sweep.

The registry entry is persisted in `config/fantomMcpServer-config.json` under `sidecars`, so it survives restarts. That file is git-ignored because it contains your hosts and ports.

## Telling the sidecar about this server

The sidecar needs to know the master's URL. Three ways:

| Method | How |
|---|---|
| Sidecar environment | Start the sidecar with `MASTER_URL=http://<server-host>:3848` and, for a Fantom master, `wsPort` 3003 in its masters list (`SIDECAR_MASTERS`) |
| Sidecar dashboard | Add a master with the server URL and WebSocket port 3003 |
| Fantom dashboard | Config → Sidecars → add the sidecar by host and port, then **Register as master**. The server calls `POST /api/masters` on the sidecar with its own URL and the WebSocket port. Set `FANTOM_PUBLIC_HOST` to the address the sidecar can reach you on, or type it in the dialog |

Why port 3003: the Sound Suite master uses 3002 for the same relay, and one GPU host often serves both. The port is editable on the Config page under **Sidecar master WS port**; saving it restarts the listener.

## How work is routed

**Embedding.** When a project is embedded, the server collects every enabled sidecar that advertises the configured model under `embedding-code` first and `embedding` second. Sidecars that are marked unhealthy, or whose last heartbeat is older than 5 minutes, are skipped. Each batch of nodes is split across the usable sidecars in parallel. If one sidecar fails a chunk after its own retry, the chunk fails over to the next sidecar before the batch is counted as an error. At most 4 requests are in flight per sidecar and each request may take up to 120 seconds (`semanticSearch.embedMaxInFlightPerSidecar`, `semanticSearch.embedTimeoutMs`). When no sidecar advertises the model the server uses its in-process model, unless `codeFromSidecar` or `docsFromSidecar` is set, in which case it refuses and reports the reason.

**Reranking.** Semantic search asks for a `reranker` capability serving the configured model and posts query and candidates to it. Without one, results keep their vector similarity order.

**askCodebase.** The recursive language model tool asks for an `rlm` capability and streams a tool-calling conversation to it; if none exists it falls back to the configured cloud LLM provider.

**Selection order** when several sidecars qualify: fresh and healthy first, then higher GPU percentage, then fewer active requests.

## What the dashboard shows

- **Config → Sidecars**: the registry, with health, last seen, capabilities and the loaded model per capability. You can add, disable, delete, health-check and register-as-master here.
- **Config → Fleet (live containers)**: the last heartbeat snapshot per sidecar: containers, loaded models, VRAM, GPU. When there is no snapshot yet the server probes the sidecar's `GET /api/status` directly.
- **Config → Sidecar master WS port**: the listener status with `clients` (open sockets) and `registered` (distinct sidecars). If `clients` keeps growing past `registered`, sockets are leaking.
- **Home → Embedding pipeline**: which sidecar served each project and the per-project vector counts.

## Troubleshooting

| Symptom | Meaning |
|---|---|
| `Couldn't reach <name> at host:8098/status` | The server could not fetch a status snapshot. Current sidecars serve `/api/status`; older ones `/status`. Both are tried. Check that the host is reachable from the server, not just from your laptop. |
| Sidecar listed but `healthStatus: unknown` | Its socket closed. It will re-register on its next connect. |
| Sidecar `lastSeen` is hours old but still shows healthy | Registration marks it healthy and only a heartbeat updates it. The embedding fan-out ignores sidecars silent for over 5 minutes; delete stale entries from the registry. |
| Embedding logs `TIMEOUT` and `This operation was aborted` | The model server is overloaded or the request exceeds `embedTimeoutMs`. Lower the batch, raise the timeout, or check the sidecar's GPU. |
| `unmapped sidecar role 'x'` in the log | The sidecar reports a role the server does not know. Harmless; add it to the role map if it should become a capability. |
| Reconnect storm (hundreds of connects per minute) | Set `FANTOM_SIDECAR_SUPERSEDED_GRACE_MS` back to the default; immediate termination requires sidecars that enforce one socket per master (2.3.82 or newer). |
| Log: `has our master slot … with wsPort=unset (expected 3003)` | The sidecar's entry for this server lacks the WebSocket port and would fall back to 3002 (the Sound Suite relay). The server sends a `master-identity` correction automatically; check the sidecar's masters list if it repeats. |
| Log: `registered Ns ago but has sent no heartbeat` | Register frames arrive but the larger heartbeat frames never do. Either the network path drops large frames (compare MTU with a working host) or the sidecar's status builder fails and it reconnects every ~15 s. Check the sidecar log for `WS heartbeat failed`. The master keeps probing the sidecar's `/api/status` over HTTP for the fleet view. |
| Log: `superseded its socket N× in 10 min — clients >= 2.3.82 enforce one socket` | A sidecar that should not churn is churning. Look for what triggers its reconnects (network path, watchdog) or a client regression. |

## Security notes

- The relay on port 3003 has no authentication today; expose it only on trusted networks (a VPN or an overlay network such as Tailscale or NetBird).
- Sidecar registry entries can carry an `authToken`; when set, the server sends it as a Bearer token to the sidecar's HTTP endpoints.
- Model requests go directly to the role container ports (11434, 11437, 8099, 8100). Firewall them to the server's address.
