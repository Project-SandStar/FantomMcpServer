# `config/` — runtime configuration

Everything in this directory except the `*.example.json` templates and this
README is **git-ignored**. Real config files contain credentials, the sidecar
registry (internal hosts and ports), and per-project settings, and must never be
committed.

| File | Purpose | Created by |
|---|---|---|
| `fantomMcpServer-config.json` | Runtime settings: port, cache, search, semantic search, sidecars, LLM providers, debug | The server, on first start (defaults) and whenever you save settings in the dashboard |
| `users.json` | Dashboard / admin users (password hashes) | The server, on first start, with a default `admin` / `admin` user — **change it** in the dashboard |
| `backups/` | Backup archives produced by the dashboard | The backup feature |

## Getting started

You do not need to create anything by hand. Start the server once:

```bash
npm install
npm run build
npm run start:http
```

Then open the dashboard at `http://localhost:3848/dashboard/`, log in as
`admin` / `admin`, change the password, and adjust settings there. The server
writes `fantomMcpServer-config.json` atomically on every change.

To pre-seed a configuration instead, copy the template and edit it:

```bash
cp config/fantomMcpServer-config.example.json config/fantomMcpServer-config.json
```

## Environment overrides

| Variable | Default | Description |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `stdio` for MCP clients, `http` for the dashboard and OAuth |
| `MCP_PORT` | `3848` | HTTP port when `MCP_TRANSPORT=http` |
| `ADMIN_USER` / `ADMIN_PASS` | `admin` / `admin` | Basic Auth for the admin API (also accepts users from `users.json`) |
| `FANTOM_SIDECAR_WS_PORT` | `3003` | Port GPU sidecars use to register over WebSocket |
| `FANTOM_SIDECAR_SUPERSEDED_GRACE_MS` | `45000` | How long a superseded sidecar socket is kept before it is closed; `0` = immediately |
| `MCP_SESSION_IDLE_MS` | `86400000` | Idle timeout for MCP HTTP sessions |
| `GROQ_API_KEY`, `ANTHROPIC_API_KEY` | unset | Only needed for the optional LLM-backed tools |

See `.env.example` at the repository root for the full list.
