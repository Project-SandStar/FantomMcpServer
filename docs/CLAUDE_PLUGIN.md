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

From another machine, without a checkout, use the public Project Sandstar MCP
marketplace. It holds `fantom-mcp` and `axon-mcp`:

```bash
claude plugin marketplace add Project-SandStar/project-sandstar-mcp-marketplace
claude plugin install fantom-mcp@project-sandstar-mcp
claude plugin install axon-mcp@project-sandstar-mcp       # optional
claude plugin configure fantom-mcp@project-sandstar-mcp   # mcp_url, server_url, report_token
```

Use one source per plugin: the local checkout (`fantom-mcp@fantom-mcp`) or the
marketplace (`fantom-mcp@project-sandstar-mcp`), not both. With both you get
every tool twice.

Remove the old setup. While a manual `fantom-mcp` entry from `claude mcp add`
exists, Claude Code uses it and hides the plugin's server.

## 4. Check it

```bash
claude mcp list | grep fantom
# plugin:fantom-mcp:fantom: http://localhost:9191/fantom/mcp (HTTP) - ✔ Connected
```

In a session: `/fantom-mcp:doctor`, then `/mcp` shows `fantom` connected.

## Update the plugins

### As a user

```bash
claude plugin marketplace update project-sandstar-mcp   # fetch the newest versions
claude plugin update fantom-mcp@project-sandstar-mcp
claude plugin update axon-mcp@project-sandstar-mcp
```

Then start a new session, or run `/reload-plugins`. A local checkout install
(`fantom-mcp@fantom-mcp`) needs no update: it reads `claudePlugin/dist` in
place.

### As a maintainer: ship a change

Where users get each plugin from:

| Plugin | Users install from | A change reaches them after |
|---|---|---|
| `fantom-mcp` | public mirror `FantomMcpServer`, `claudePlugin/dist` | a public release snapshot |
| `axon-mcp` | `AxonMcpServer`, `claudePlugin/dist` | a push to `main` |

The marketplace repo only points at those folders. It does not change for a
plugin update.

**Fantom MCP plugin**

1. Edit `claudePlugin/src/` (or `workflows/*.md` for a workflow skill). Never
   edit `dist/`: the build replaces it.
2. Bump the version in `package.json`, `src/index.ts` and
   `src/axon/axonMcpClient.ts`. The build stamps it into the plugin and both
   marketplace files. Without a new version, `claude plugin update` sees
   nothing new.
3. Build and test:
   ```bash
   npm run plugin:build      # dist/ + claude plugin validate
   npm run plugin:test       # unit tests, live checks when :3848 is up
   ```
4. Try it locally: `/reload-plugins` in a session.
5. Commit the source and `claudePlugin/dist` together, push to `origin`.
6. Publish: `scripts/release-public.sh <ver>` (dry run, audit), then
   `scripts/release-public.sh <ver> --publish`. Never `git push github main`.

**Axon MCP plugin** (in the `axon-mcp-server` repo)

1. Edit `claudePlugin/src/` or `workflows/*.md`.
2. Bump `version` in `package.json`.
3. `npm run plugin:build && npm run plugin:test`.
4. Commit the source and `claudePlugin/dist`, push to `main`.

**The marketplace** changes only to add a plugin, rename one, or move its
source. Validate before you push: `claude plugin validate .` in the
`project-sandstar-mcp-marketplace` repo.

## When it fails

| You see | Cause | Fix |
|---|---|---|
| `plugin:fantom-mcp:fantom` failed: `ECONNREFUSED` | The proxy on `:9191` was not running when the session started | Start the proxy, then reconnect in `/mcp` or start a new session |
| SessionStart says "the server … did not answer" | `:3848` is down or busy with a heavy job. The hooks do not use the proxy | Start the server, or wait for the job. `GET /admin/heavy-job` shows it |
| Tools hang, proxy log shows reconnects | The server is restarting | Wait. The proxy reconnects on its own |
| Every edit is reported twice | The old `fantom-report-change.sh` hook is still in `~/.claude/settings.json` | `node claudePlugin/dist/bin/fantom-mcp.mjs clean-legacy` |
