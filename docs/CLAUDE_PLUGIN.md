# Install the Claude Code plugin

The plugin (`claudePlugin/`) connects Claude Code to the Fantom MCP server for
every registered project. Full reference: `claudePlugin/README.md`.

## How it connects

```
Claude Code ── MCP ──▶ mcp-proxy :9191 /fantom/mcp ──▶ server :3848 /mcp
Claude Code ── hooks ─────────────────────────────────▶ server :3848 /admin/indexing/*
```

- MCP tools go through **mcp-proxy** on `:9191`. The proxy keeps the Claude
  Code connection open while the server restarts, and it adds the OAuth
  token itself.
- The hooks (session context, change reports) go straight to `:3848`. The
  proxy forwards only `/fantom/mcp`.

## 1. Start the server

```bash
npm run start:dev:launchd        # macOS; elsewhere npm run start:dev
```

Check: `curl -s localhost:3848/health`.

## 2. Start mcp-proxy

The proxy is a separate repo (`mcp-proxy`). Its `config.json` must map
`/fantom/mcp` to `http://localhost:3848/mcp`.

```bash
cd <mcp-proxy checkout>
npm install
./scripts/start.sh               # background, PID in .mcp-proxy.pid
```

Check: `lsof -nP -iTCP:9191 -sTCP:LISTEN` shows a `node` process.

**Start it at login.** `start.sh` does not survive a reboot. If the proxy is
not running when Claude Code starts, the plugin server fails with
`ECONNREFUSED` and stays down for that session. Use PM2:

```bash
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
```

or a LaunchAgent that runs `scripts/start.sh`.

## 3. Install the plugin

From the root of this repo:

```bash
npm run plugin:install                    # build, add marketplace, install, report token, doctor
npm run plugin:install -- --remove-legacy # also remove old `claude mcp add` entries and the old hook
```

From another machine, without a checkout:

```bash
claude plugin marketplace add <git url of this repo>   # or the Project Sandstar MCP marketplace repo
claude plugin install fantom-mcp@fantom-mcp            # fantom-mcp@project-sandstar-mcp from project-sandstar-mcp
```

Remove the old setup. While a manual `fantom-mcp` entry from `claude mcp add`
exists, Claude Code uses it and hides the plugin's server.

## 4. Check it

```bash
claude mcp list | grep fantom
# plugin:fantom-mcp:fantom: http://localhost:9191/fantom/mcp (HTTP) - ✔ Connected
```

In a session: `/fantom-mcp:doctor`, then `/mcp` shows `fantom` connected.

## After a change to the plugin

```bash
npm run plugin:build
```

Then start a new session or run `/reload-plugins`. You do not need to
install again. Commit `claudePlugin/dist` with the change so git installs get it.

## When it fails

| You see | Cause | Fix |
|---|---|---|
| `plugin:fantom-mcp:fantom` failed: `ECONNREFUSED` | The proxy on `:9191` was not running when the session started | Start the proxy, then reconnect in `/mcp` or start a new session |
| SessionStart says "the server … did not answer" | `:3848` is down or busy with a heavy job. The hooks do not use the proxy | Start the server, or wait for the job. `GET /admin/heavy-job` shows it |
| Tools hang, proxy log shows reconnects | The server is restarting | Wait. The proxy reconnects on its own |
| Every edit is reported twice | The old `fantom-report-change.sh` hook is still in `~/.claude/settings.json` | `node claudePlugin/dist/bin/fantom-mcp.mjs clean-legacy` |
