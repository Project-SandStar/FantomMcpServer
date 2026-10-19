# Fantom MCP as a Claude Code plugin

One install, every registered project. The plugin connects Claude Code to the
Fantom MCP server, reports your edits so the index stays live, and tells the
model at session start which project it is in and which tools to use.

Design notes: `docs/proposals/claude-code-plugin.md`.

## What is in it

| Part | File | What it does |
|---|---|---|
| MCP server | `src/.mcp.json` | HTTP connection to `${user_config.mcp_url}`. Default `http://localhost:9191/fantom/mcp`: the local mcp-proxy, so the connector stays up while the server restarts. The proxy adds the OAuth token itself. |
| SessionStart hook | `src/hooks/session-start.mjs` | One GET to `/admin/indexing/context?cwd=…`. Injects: project name and id, language, version group, lazy indexing on or off, index age, last run, focus files, and the tool routing line. Caches the project list for the other hooks. Silent in directories the server does not know. |
| PostToolUse hook | `src/hooks/report-change.mjs` | Edit, Write, MultiEdit, NotebookEdit: POST the file to `/admin/indexing/report`. Replaces `scripts/hooks/fantom-report-change.sh`. 2 s cap, never blocks. |
| UserPromptSubmit hook | `src/hooks/prompt-hint.mjs` | No network. One short hint naming the right tool ("who calls X" → getCallers + getCodeImpact). |
| Skills | `src/skills/` | `fantom-mcp` (routing table, always on), `/fantom-mcp:doctor`, `/fantom-mcp:status`, `/fantom-mcp:ask`, `/fantom-mcp:impact`, `/fantom-mcp:add-project`. |
| CLI | `src/bin/fantom-mcp.mjs` | `setup`, `doctor`, `status`, `token`, `clean-legacy`, `disconnect`. The `dist/package.json` has it as `bin`, so a published package gives `npx fantom-mcp-plugin setup`. |
| Workflow skills | generated | One `wf-<name>` skill per `workflows/*.md`, made by the build. `workflows/` stays the single source. |
| Doctor | `src/bin/doctor.mjs` | Server, proxy, token, plugin install, legacy duplicates, project for the cwd. `--json` for scripts. |

Always-on cost: about 470 tokens of skill descriptions. The full skill bodies
load only when invoked.

## Server side

The plugin needs one new route in the server, added with it:

```
GET /admin/indexing/context?cwd=<abs path>    X-Fantom-Hook-Token
```

It answers with the project of that directory (longest path prefix), its index
state, and the list of registered project roots. Same token and same
no-Basic-Auth mount as `POST /admin/indexing/report`. Code:
`src/admin/sessionContext.ts`, route in `src/admin/indexingRoutes.ts`, test in
`src/__tests__/sessionContextRoute.test.ts`.

The tool usage tracker now records the HTTP `mcp-session-id`, so the
dashboard can count sessions, not only calls.

## Layout

```
claudePlugin/
  .claude-plugin/marketplace.json   local marketplace "fantom-mcp", source ./dist
  src/                              the plugin source
    .claude-plugin/plugin.json      manifest + userConfig (mcp_url, server_url, report_token)
    .mcp.json  hooks/  skills/  bin/
  scripts/build.mjs                 src/ + workflows/*.md -> dist/
  scripts/install-local.sh          build, marketplace add, install, token, doctor
  scripts/uninstall-local.sh
  scripts/test.sh                   build + validate, unit tests, live checks
  test/hooks.test.mjs               hooks and doctor against a fake server
  dist/                             build output (gitignored); this is the plugin
```

## Install from this checkout

```
npm run plugin:install
```

Or step by step:

```
node claudePlugin/scripts/build.mjs --check         # dist/ + claude plugin validate
claude plugin marketplace add "$(pwd)/claudePlugin"     # from the repo root
claude plugin install fantom-mcp@fantom-mcp --scope user
```

The install script also makes sure a report token exists. It reads
`config/admin.json`, calls `POST /admin/indexing/report-token`, saves the token
to `~/.fantom-mcp/report-token` (mode 600) and stores it as the plugin option
`report_token`. Note: minting a token replaces the old one.

Then remove the old setup. While a manual `fantom-mcp` entry from
`claude mcp add` exists, Claude Code keeps it and suppresses the plugin's own
server (`plugin:fantom-mcp:fantom`), so the `mcp_url` option does nothing. The
old `settings.json` hook reports every edit twice.

```
node claudePlugin/dist/bin/fantom-mcp.mjs clean-legacy --dry-run   # list
node claudePlugin/dist/bin/fantom-mcp.mjs clean-legacy             # user entry, every local-scope entry, settings.json hook (backups kept)
```

`npm run plugin:install -- --remove-legacy` does the same during setup.

## CLI

`node claudePlugin/dist/bin/fantom-mcp.mjs <command>`. Built-ins only, Node 20+.

| Command | Does |
|---|---|
| `setup [--marketplace <dir\|owner/repo\|url>] [--scope user] [--server-url] [--mcp-url] [--admin-config admin.json] [--remove-legacy] [--no-doctor]` | Health, marketplace add, install, token (reads `config/admin.json` of the checkout, else prompts), plugin options, legacy check, doctor. |
| `doctor [--json] [--cwd dir]` | The checklist. Exit 1 on a real problem. |
| `status [--json] [--cwd dir]` | Server, endpoint, token source, project and index age in six lines. |
| `token [--rotate] [--admin-config admin.json]` | Shows whether a token exists. `--rotate` mints a new one, saves it to `~/.fantom-mcp/report-token` and the plugin option. The old token stops working. |
| `clean-legacy [--dry-run]` | Removes the manual MCP entries (user and every local scope) and the shell hook. Backs up each file it edits. |
| `disconnect [--purge-token]` | Uninstalls the plugin and the marketplace. |

A directory marketplace is read in place: Claude Code loads `dist/` from this
checkout (the copy under `~/.claude/plugins/cache/` is only a snapshot from
install time). After `npm run plugin:build`, start a new session or run
`/reload-plugins`. No reinstall.

## Test

```
npm run plugin:test            # build, validate, unit tests, live checks (server up)
cd claudePlugin && npm test    # unit tests only
```

Unit tests start a fake server and run every hook and the doctor as Claude
Code would, with `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` and the
`CLAUDE_PLUGIN_OPTION_*` variables set. The live part feeds real hook JSON for
this repo to the built hooks against the running server.

In a session: `/fantom-mcp:doctor`, then `/mcp` should show `fantom` connected.

## Configure

`claude plugin configure fantom-mcp@fantom-mcp`, or `/plugin` in a session.

| Option | Default | Use |
|---|---|---|
| `mcp_url` | `http://localhost:9191/fantom/mcp` | Set to `http://localhost:3848/mcp` to skip the proxy. The server then asks for OAuth sign-in in `/mcp`. |
| `server_url` | `http://localhost:3848` | Health, change reports, session context. Not through the proxy: it only forwards `/fantom/mcp`. |
| `report_token` | none | Falls back to `FANTOM_REPORT_TOKEN`, then `~/.fantom-mcp/report-token`. |

## Share with others

`dist/` is committed, and the repo root has a marketplace
(`.claude-plugin/marketplace.json`, source `./claudePlugin/dist`). Anyone with
access to this repo can install the plugin:

```
claude plugin marketplace add <git url of this repo>
claude plugin install fantom-mcp@fantom-mcp
```

Or use the Project Sandstar MCP marketplace repo, which lists this plugin and the Axon
MCP plugin together (`fantom-mcp@project-sandstar-mcp`). Use one source, not both.

After a change: `npm run plugin:build`, then commit `claudePlugin/dist` with
the source. Others get it with `claude plugin marketplace update`.

The server must be reachable from their machine, and they need their own
report token from the dashboard.
