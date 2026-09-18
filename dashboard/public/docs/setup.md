# Setup Guide

This guide takes a fresh checkout of the Fantom MCP Server to a running server with the dashboard, a database, and an AI assistant connected. For per-client wiring details (Claude Code, Claude Desktop, VS Code) see **Installation**.

## What you get

| Component | Port | Purpose |
|---|---|---|
| MCP server (HTTP transport) | 3848 | `POST /mcp` for AI assistants, `/health`, admin API, dashboard |
| Dashboard | 3848 `/dashboard/` | Configure the server, index projects, watch embedding and sidecars |
| Sidecar relay (WebSocket) | 3003 `/sidecar` | GPU sidecars register here (optional, see **Sidecars**) |
| MCP server (stdio transport) | — | One process per AI client, spawned by the client |

Everything the server creates at runtime lives under `config/`, `.cache/` and `logs/`. None of it is tracked by git.

## Prerequisites

- **Node.js 18 or newer** (20 LTS recommended). Check with `node -v`.
- **npm 9 or newer**.
- **Git**.
- Optional: a **Fantom, Haxall or SkySpark installation** on the same machine if you want to index its source and documentation (for example `~/fantom/fantom-1.0.82` or `~/haxall/haxall-4.0.x`).
- Optional: a **GPU host running the SideCar** for fast embeddings, reranking and the RLM question-answering tool. Without one the server falls back to a small in-process embedding model.

## One-command setup

```bash
git clone https://github.com/Project-SandStar/FantomMcpServer.git
cd FantomMcpServer
./setup.sh
```

`setup.sh` runs these steps and stops at the first failure:

1. `npm install` (also runs `prisma generate` through the `postinstall` hook).
2. Creates `.env` from `.env.example` if you do not have one.
3. Creates the SQLite database at `.cache/fantom.db` and applies the schema (`prisma migrate deploy`).
4. Downloads the Tree-sitter grammars if `src/parser/treeSitter/grammars/` is empty.
5. Builds the server (`npm run build`).
6. Builds the dashboard (`cd dashboard && npm install && npm run build`). Skip this with `./setup.sh --no-dashboard`.

Then start it:

```bash
npm run start:http
```

Open `http://localhost:3848/dashboard/` and log in with **admin / admin**. Change the password on the Users page before you expose the server to a network.

## Manual setup

If you prefer to run the steps yourself:

```bash
npm install
cp .env.example .env
npm run db:setup          # prisma migrate deploy → creates .cache/fantom.db
npm run grammars:download # only if the grammars folder is empty
npm run build
npm run dashboard:install && npm run dashboard:build
npm run start:http
```

## Configuration files

| File | Created by | Contents |
|---|---|---|
| `.env` | you (from `.env.example`) | `DATABASE_URL`, optional API keys, transport defaults |
| `config/fantomMcpServer-config.json` | the server, on first start and on every dashboard save | Port, cache, search and semantic-search settings, sidecar registry, LLM providers, debug flags |
| `config/users.json` | the server, on first start | Dashboard users with password hashes. Default user `admin` / `admin` |
| `.cache/fantom.db` | `npm run db:setup` | Prisma SQLite: instances, pods, projects, index runs, OAuth |
| `.cache/graph/<id>.db` | indexing | One LadybugDB graph per code project |
| `.cache/fantomvector.db/` | embedding | LanceDB vector tables for code and docs |

A sanitized template of the runtime config is in `config/fantomMcpServer-config.example.json`. You normally do not edit the real file by hand; the dashboard writes it atomically.

### DATABASE_URL

Prisma resolves a relative `file:` URL against the `prisma/` directory, not the working directory. That is why the default is:

```
DATABASE_URL="file:../.cache/fantom.db"
```

If the variable is missing the server uses that same default and creates the `.cache/` directory itself. When an AI assistant spawns the server over stdio from another working directory, pass an absolute `DATABASE_URL` in the client's `env` block (see **Installation**).

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `stdio` for MCP clients, `http` for dashboard, admin API and OAuth |
| `MCP_PORT` | `3848` | HTTP port when `MCP_TRANSPORT=http` |
| `ADMIN_USER` / `ADMIN_PASS` | `admin` / `admin` | Basic Auth for the admin API; dashboard users from `config/users.json` also work |
| `FANTOM_SIDECAR_WS_PORT` | `3003` | Port sidecars connect to; also editable on the Config page |
| `FANTOM_PUBLIC_HOST` | unset | Host name or IP that sidecars can reach this server on; used by "Register as master" |
| `GROQ_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` | unset | Only for the optional LLM-backed tools (askCodebase answer synthesis, code generation help) |
| `MCP_SESSION_IDLE_MS` | `86400000` | Idle timeout for MCP HTTP sessions |
| `DEBUG` | unset | Set to `fantom-mcp:*` for verbose logs |

## First steps in the dashboard

1. **Change the admin password** (Users).
2. **Add a Fantom, Haxall or SkySpark instance** (Instances) by pointing at its install directory. The server discovers pods and documentation from it.
3. **Index code projects** (Projects). Each indexed project gets a graph database and, when an embedding provider is available, vectors for semantic search. The home page shows progress.
4. **Optional: register a sidecar** (Config → Sidecars) to move embeddings and reranking to a GPU. See **Sidecars**.
5. **Connect your AI assistant** using the snippets on the **Installation** page.

## Running as a service

| Method | Commands |
|---|---|
| Foreground | `npm run start:http` |
| Background script with logs in `logs/server.log` | `./scripts/start-server.sh`, `./scripts/stop-server.sh`, `./scripts/status-server.sh` |
| PM2 | `npm run daemon:start`, `npm run daemon:stop`, `npm run daemon:logs` |

The start script rotates `logs/server.log` (three generations) so the previous run's last lines survive a restart. Enable **Debug → crash capture** in the dashboard to also record signals and exits in `logs/_crash.log`.

## Upgrading

```bash
git pull
npm install
npm run db:setup      # applies any new migrations
npm run build && npm run dashboard:build
./scripts/stop-server.sh && ./scripts/start-server.sh
```

Your `config/`, `.cache/` and `logs/` directories are untouched by an upgrade.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Unable to open the database file` on start | The database was never created. Run `npm run db:setup`. |
| Prisma-backed tools fail only when spawned by an AI client | The client's working directory is not the server directory. Set an absolute `DATABASE_URL` in the client config. |
| Dashboard shows a blank page | The dashboard was not built. Run `npm run dashboard:build`. |
| `Server already running on port 3848` | A previous instance is alive. `./scripts/status-server.sh` shows it; `./scripts/stop-server.sh` stops it. |
| Embedding shows `+0 vectors` with many errors | No usable embedding provider. Check Config → Sidecars, or leave the sidecar settings off to use the in-process model. |
| A project is stuck with `graph rebuild produced 0 nodes (quarantined)` | Its graph database is corrupt. The server purges and rebuilds it automatically on the next open; a forced reindex from the Projects page does it immediately. |
| Memory grows steadily | Check Config → Debug → connection pool (`/admin/graph/connection-pool`) for close failures, and the RSS shown on the home page. |

Logs: `logs/server.log` (current run), `logs/server.log.1` to `.3` (previous runs), `logs/_crash.log` (signals and exits when crash capture is on).
