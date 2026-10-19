# Fantom MCP as a Claude Code plugin

> **Status 2026-10-17: built.** The plugin lives in `claudePlugin/` (see its
> `README.md`). Differences from the plan below: the plugin directory is
> `claudePlugin/` not `plugin/`; the MCP URL defaults to the mcp-proxy at
> `http://localhost:9191/fantom/mcp` (the proxy holds the OAuth token and keeps
> the connector up while `:3848` restarts); the server gained
> `GET /admin/indexing/context` for the SessionStart hook; install and test are
> `npm run plugin:install` and `npm run plugin:test`. The CLI of section 4.6
> is `dist/bin/fantom-mcp.mjs` (`setup`, `doctor`, `status`, `token`,
> `clean-legacy`, `disconnect`); `dist/package.json` exposes it as `bin`, so
> publishing `dist/` gives `npx fantom-mcp-plugin setup`. Not published yet.

Status: proposal, 2026-10-17. Written from the code and the local database while the
server was down. Nothing here is built yet.

## 1. Short answer

Yes, this is possible. A Claude Code plugin is a directory with a manifest, hooks, skills
and an MCP server entry. context-mode is built that way. Fantom MCP can use the same shape.

The server stays a separate service on `:3848`. The plugin is a thin client:

- one MCP server entry that points at the running server,
- four hooks (report edits, inject context at session start, prompt hints, optional grep hint),
- one routing skill plus the existing workflows as slash commands,
- one setup command (`npx fantom-mcp setup`) that does the install end to end.

The main gain is not new server features. It is that every Claude Code session on the
machine learns, before the first prompt, that the server exists, which project the current
directory is, and when to call it. Today only this repo's `CLAUDE.md` says that.

## 2. How context-mode does it

| Piece | File in context-mode | What it does |
|---|---|---|
| Manifest | `.claude-plugin/plugin.json` | `name`, `version`, inline `mcpServers` (`node ${CLAUDE_PLUGIN_ROOT}/start.mjs`), `skills: ./skills/` |
| Marketplace | `.claude-plugin/marketplace.json` | One entry, `source: "./"`. Install: `claude plugin marketplace add mksglu/context-mode`, then `claude plugin install context-mode@context-mode` |
| Hooks | `hooks/hooks.json` | PreToolUse (Bash, WebFetch, Read, Grep, Agent, `mcp__`), PostToolUse (most tools), UserPromptSubmit, SessionStart, PreCompact, Stop. Each runs `node ${CLAUDE_PLUGIN_ROOT}/hooks/<event>.mjs` |
| Skills | `skills/` | 8 skills. `context-mode` is the routing skill: it tells the model when to use which tool. The rest are `/ctx-doctor`, `/ctx-stats`, `/ctx-upgrade`, ... |
| CLI | npm package `@context-mode/cli` (0.7.0) | `npx @context-mode/cli setup` writes gateway settings into `~/.claude/settings.json` with a diff and a backup. It also has `login`, `status`, `doctor`, `logout`, `disconnect`. It does **not** install the plugin; the plugin comes from the marketplace |

Cost, from `claude plugin details context-mode@context-mode`: about 942 always-on tokens
per session, almost all from skill descriptions. Hooks cost no model tokens.

The lesson: context-mode gets used because a skill and hooks nudge the model on every turn,
not because its tools are better known.

## 3. Where Fantom MCP stands today

### 3.1 How it is wired

- **Connection**: `claude mcp add --transport http fantom-mcp http://localhost:9191/fantom/mcp`,
  stored per project in `~/.claude.json` (three project entries on this machine). `:9191` is
  `mcp-proxy` (`~/Code/mcp-proxy/config.json`), which gets an admin OAuth grant from
  `:3848/admin/oauth/token-grant` and forwards to `:3848/mcp`. `claude mcp list` now shows
  `fantom-mcp ... tools fetch failed` because the server is down.
- **Change reporting**: `scripts/hooks/fantom-report-change.sh`, added by hand to
  `~/.claude/settings.json` as a PostToolUse hook on `Edit|Write|MultiEdit|NotebookEdit`.
  Token in `~/.fantom-mcp/report-token`. Setup is documented in `workflows/setup-fantom-mcp.md`.
- **Instructions**: only `CLAUDE.md` in this repo tells the model to call `askCodebase`,
  `searchFantomCode`, `getCallers` first. Other repos (SoundSuite, Fantom projects) have nothing.
- **Workflows**: 14 files in `workflows/*.md` are served as `workflow://` MCP resources.
  Claude Code only reads a resource when asked; it never loads them on its own.
- **Tools**: 44 unique MCP tools (84 `name:` entries in `src/index.ts` plus
  `reportChanges`; most tools are listed twice), about 1.7k tokens of descriptions. With `ENABLE_TOOL_SEARCH=true` (set in your
  `~/.claude/settings.json`), every MCP tool is deferred. The model must call `ToolSearch`
  before it can use one.
- **Server capabilities**: `tools` and `resources` only. No `prompts`, no `instructions`
  string in the `Server` constructor, so a client gets no guidance at connect time.

### 3.2 Real usage

From `tool_events` in `.cache/fantom.db` (the server's own usage tracker):

| Month | Tool calls |
|---|---|
| 2026-01 | 272 |
| 2026-02 | 160 |
| 2026-03 | 11 |
| 2026-04 | 20 |
| 2026-05 | 134 |
| 2026-06 | 30 |
| 2026-07 | 0 |
| 2026-08 | 0 |
| 2026-09 | 38 |
| 2026-10 | 42 |

707 calls in ten months. `session_id` is NULL in all 707 rows and there is no `client`
column, so we cannot tell which repo or client made a call.

| Tool | Calls |
|---|---|
| searchFantomCode | 230 |
| searchLocalDocs | 132 |
| searchVersionedApi | 119 |
| semanticCodeSearch | 49 |
| docs_search (old name) | 33 |
| getCallers | 30 |
| askCodebase | 21 |
| getCodeImpact | 13 |
| findSimilarCode | 12 |
| getCallees | 12 |

Reading: search tools get used when the model already knows about them. The graph tools and
`askCodebase`, which are the expensive features, are rare. Three causes:

1. **Discovery**: nothing outside this repo tells the model the server exists.
2. **Friction**: tool search plus 42 tools plus a proxy with OAuth. One failed `ToolSearch`
   and the model falls back to grep.
3. **Setup**: hook, token and project registration are manual steps in a markdown file.

A plugin fixes all three. It does not fix a server that is down; hooks must fail open.

## 4. Proposed plugin

### 4.1 Layout

```
mcpfantom/
  .claude-plugin/marketplace.json     # entry "fantom-mcp", source "./plugin"
  plugin/
    .claude-plugin/plugin.json
    .mcp.json                         # http → ${user_config.server_url}/mcp
    hooks/hooks.json
    hooks/report-change.mjs           # port of scripts/hooks/fantom-report-change.sh
    hooks/session-start.mjs           # health + project context → additionalContext
    hooks/prompt-hint.mjs             # keyword hint, no network
    hooks/grep-hint.mjs               # optional, phase 2
    skills/fantom-mcp/SKILL.md        # routing skill (always-on description)
    skills/fantom-doctor/SKILL.md     # /fantom-mcp:doctor
    skills/fantom-workflows/SKILL.md  # index of the 14 workflows
    skills/<workflow>/SKILL.md        # generated from workflows/*.md at build
    bin/fantom-mcp-cli.mjs            # setup | doctor | status | token | disconnect
    package.json                      # small, no deps, "bin"
```

Why a subdirectory and not the repo root (context-mode uses the root): the plugin must stay
small. The server has native dependencies (LanceDB, LadybugDB, tree-sitter) and runs as a
service. An install copies the plugin directory into `~/.claude/plugins/cache/`; it must not
need `npm install` or a build. The marketplace entry uses a relative `source`, so a GitHub
install clones the public snapshot and takes `plugin/`.

For local development: `claude plugin marketplace add <path to the checkout>`. With a
local path source, Claude Code reads the files in place; edits apply after `/reload-plugins`.

### 4.2 Manifest

```json
{
  "name": "fantom-mcp",
  "version": "1.1.0",
  "description": "Working knowledge of Fantom, Axon, Haxall and SkySpark code: semantic search, call graph, impact, change history, docs, 3.x→4.0 migration.",
  "author": { "name": "Alper" },
  "homepage": "https://github.com/<public-repo>#readme",
  "license": "MIT",
  "skills": "./skills/",
  "hooks": "./hooks/hooks.json",
  "mcpServers": "./.mcp.json",
  "userConfig": {
    "server_url": {
      "type": "string",
      "title": "Fantom MCP server URL",
      "description": "Base URL of the running server, no trailing slash.",
      "default": "http://localhost:3848"
    },
    "report_token": {
      "type": "string",
      "title": "Report token",
      "description": "Token from Dashboard → Indexing → Report token. Lets the edit hook tell the server which files changed.",
      "sensitive": true
    },
    "mcp_token": {
      "type": "string",
      "title": "MCP bearer token (only if OAUTH_ENABLED=true on the server)",
      "description": "Leave empty when the server runs without OAuth.",
      "sensitive": true
    }
  }
}
```

Rules that matter (from the plugin manifest reference, Claude Code 2.1.302):

- `${user_config.KEY}` is substituted in MCP server config and in exec-form hook `args`.
  Shell-form hook commands may **not** use it; they read `CLAUDE_PLUGIN_OPTION_<KEY>` from
  the environment instead. `sensitive: true` stores the value in secure storage, not in
  `settings.json`, and masks it in the dialog.
- Every component path starts with `./` and must stay inside the plugin root.
- `claude plugin validate ./plugin` is the check. It also validates each MCP entry and warns
  on `http://` to a non-loopback host. `localhost` is fine.
- Tool names become `mcp__plugin_fantom-mcp_fantom-mcp__askCodebase`
  (`mcp__plugin_<plugin>_<server>__<tool>`), the same pattern as
  `mcp__plugin_context-mode_context-mode__ctx_search`.

### 4.3 MCP server entry (`plugin/.mcp.json`)

```json
{
  "mcpServers": {
    "fantom-mcp": {
      "type": "http",
      "url": "${user_config.server_url}/mcp"
    }
  }
}
```

Direct to `:3848`, no proxy. When the server runs with `OAUTH_ENABLED=true`, add
`"headers": { "Authorization": "Bearer ${user_config.mcp_token}" }` and let the setup command
mint the token from `/admin/oauth/token-grant`, the same grant `mcp-proxy` uses today. Two
entries in `.mcp.json` (one with, one without the header) would show duplicate tools, so the
setup command should write the header only when OAuth is on. Keep `:9191` for the other
upstreams (axon, sedona); it is not needed for Fantom once the plugin is in.

### 4.4 Hooks (`plugin/hooks/hooks.json`)

| Event | Matcher | Script | Behaviour | Cap |
|---|---|---|---|---|
| PostToolUse | `Edit\|Write\|MultiEdit\|NotebookEdit` | `report-change.mjs` | Same body as `scripts/hooks/fantom-report-change.sh`: POST `{ files, cwd, sessionId, client: "claude-code-plugin" }` to `/admin/indexing/report` with `X-Fantom-Hook-Token` from `CLAUDE_PLUGIN_OPTION_REPORT_TOKEN`. Silent on any error. | 2 s |
| SessionStart | `startup\|resume\|clear\|compact` | `session-start.mjs` | GET `/health`, then GET `/admin/context?cwd=<cwd>` (new, see 4.7). Emit `hookSpecificOutput.additionalContext`, about 8 lines: server up or down, project id and name for this cwd, index health, lazy indexing on or off, vector coverage, the 3 newest changes, and the one-line rule "call `ToolSearch("fantom-mcp", 30)` then `askCodebase` before grepping Fantom/Axon code". If the server is down: one line naming the URL and `/fantom-mcp:doctor`. | 3 s |
| UserPromptSubmit | `""` | `prompt-hint.mjs` | Keyword match only (`axon`, `fantom`, `.fan`, `skyspark`, `haxall`, `xeto`, `trio`, `pod`, `who calls`, `impact`, `migrate`). On a hit, `additionalContext` with the one right tool for the question. No network. | 1 s |
| PreToolUse (phase 2) | `Grep\|Glob` | `grep-hint.mjs` | If the pattern or path targets `.fan`, `.axon`, `.trio`, `.xeto` inside an indexed project, return `additionalContext` suggesting `searchFantomCode` with the project's `versionGroup`. Never `deny`. | 1 s |
| Stop (optional) | `""` | `session-end.mjs` | POST `/admin/indexing/session-end` so code history can group one session's edits. | 2 s |

No PreCompact hook. No hook touches the network on UserPromptSubmit: that event blocks the
prompt until the hook returns.

Existing manual hook: the setup command removes the `fantom-report-change.sh` entry from
`~/.claude/settings.json` when it installs the plugin, or the server receives every edit twice.

### 4.5 Skills

| Skill | Kind | Content |
|---|---|---|
| `fantom-mcp` | routing, always-on description (~300 tokens) | When to use what: `askCodebase` for "how does X work"; `searchFantomCode` scoped by `versionGroup` for API lookups; `getCallers` and `getCodeImpact` before editing a symbol; `whatChangedRecently` and `getSymbolHistory` for "why did this change"; `searchVersionedApi` for 3.x→4.0 questions; `reportChanges` after edits when the hook is not present. Say "nothing found" rather than guess a Fantom API. Mentions `ToolSearch("fantom-mcp", 30)` because tools are deferred. |
| `/fantom-mcp:doctor` | command | Runs `bin/fantom-mcp-cli.mjs doctor` and shows the checklist. |
| `/fantom-mcp:ask <question>` | command | `askCodebase` for the project of the cwd. |
| `/fantom-mcp:impact <symbol>` | command | `getCodeImpact` plus `getCallers`, formatted as a blast-radius list. |
| `/fantom-mcp:add-project` | command | `addFantomProject` for the cwd, then enable lazy indexing. |
| `fantom-workflows` | index skill (~150 tokens) | Lists the 14 workflows in one line each so the model knows they exist. |
| `/fantom-mcp:create-pod`, `/fantom-mcp:skyspark-4x-migration`, `/fantom-mcp:unit-testing`, ... | generated | One `SKILL.md` per `workflows/*.md`, made at build by extending `scripts/copy-workflows.cjs`. `workflows/` stays the single source. |

Token budget: keep the always-on total under 600 (context-mode is 942). The generated
workflow skills get a one-line `description` each, or ship only the `fantom-workflows` index
and load the full text on invoke. Check with `claude plugin details fantom-mcp@fantom-mcp`.

### 4.6 Setup command: `npx fantom-mcp setup`

Mirrors `@context-mode/cli`: show what will change, back up, do it, print one line per step,
end with `Ready`. Node 20, no dependencies.

| Command | Steps |
|---|---|
| `setup` | 1. GET `<url>/health`; stop with a clear line if down. 2. `claude plugin marketplace add <github-or-path>`. 3. `claude plugin install fantom-mcp@fantom-mcp --scope user`. 4. Prompt admin user and password (never stored), POST `/admin/indexing/report-token`, then `claude plugin configure fantom-mcp --values-stdin` with `server_url` and `report_token`. Also write `~/.fantom-mcp/report-token` (mode 600) for non-plugin clients. 5. If OAuth is on, mint the MCP token via `/admin/oauth/token-grant`. 6. Remove the old `claude mcp` entry and the manual hook from `settings.json`, with a diff. 7. If the cwd is a git repo the server does not know, offer `addFantomProject` and lazy indexing. |
| `doctor` | Health, plugin installed and enabled (`claude plugin list --json`), report token accepted (dry POST), hook present, cwd project indexed, vector coverage, index health. Exit 0 or 1. |
| `status [--json]` | Server URL, version, project for cwd, last index run, calls today. |
| `token` | Rotate the report token. |
| `disconnect` | Uninstall the plugin, delete the local token files, restore the backed-up settings. |

Packaging: a separate small npm package built from `plugin/` (name `mcp-fantom` is free on
npm; `@fantom-mcp/cli` is the cleaner shape). The server package stays unpublished.

### 4.7 Server-side changes needed

- **`GET /admin/context?cwd=`**: one call for the SessionStart hook. Returns
  `{ up, version, project: { id, name, versionGroup, lazy }, health, vectorCoverage, recentChanges[3] }`.
  New module `src/admin/contextRoutes.ts`, mounted from `routes.ts`, not written into it.
- **Usage tracker**: record `session_id` (from the `mcp-session-id` header) and a `client`
  column. Today 0 of 707 rows carry a session, so plugin adoption cannot be measured.
- **`instructions`** string on the `Server` constructor: the five-line routing rule, so every
  MCP client gets it at connect time, not only Claude Code.
- **Release**: `plugin/` and `.claude-plugin/marketplace.json` ship in the public tree.
  `scripts/release-public.sh` already audits for internal hosts; add `plugin/` to the audited
  set. Bump the plugin `version` with the server version.
- Optional: dashboard page "Clients" that lists sessions by `client` and shows the last hook
  report per session.

## 5. What it gives

- **One install per machine**: `npx fantom-mcp setup`. No hand edits of `settings.json`,
  no `claude mcp add` per project, no proxy.
- **Every repo, not one**: user-scope install makes the hooks and the routing skill active in
  SoundSuite, Fantom projects and new checkouts. Today the instructions live only here.
- **Context before the first prompt**: the model knows the server is up and which project the
  cwd is, with its version group, before it reads any file.
- **Nudges every turn**: the routing skill and the prompt hint are what made context-mode
  "used". The expensive features (`askCodebase`, graph tools) are the ones that gain.
- **Workflows become slash commands**: 14 workflows that are invisible as MCP resources become
  `/fantom-mcp:create-pod` and friends.
- **Versioned and measurable**: marketplace updates, `claude plugin details` for token cost,
  `claude plugin validate` in CI, `tool_events` by session and client for adoption.
- **Safer secrets**: report and MCP tokens live in secure storage via `sensitive: true`, not in
  a settings file or a hook command line.

## 6. Costs and risks

- **Always-on tokens**: every skill description loads in every session. Keep it under 600.
- **Deferred tools**: with `ENABLE_TOOL_SEARCH=true` the model must `ToolSearch` first. The
  skill must say so. Plugin tool names are long.
- **Permission rules and docs** that name `mcp__fantom-mcp__*` or `mcp__axon-mcp__*` must change
  to `mcp__plugin_fantom-mcp_fantom-mcp__*`. `CLAUDE.md` in this repo and in SoundSuite too.
- **Duplicate connections**: a plugin plus a leftover `claude mcp add` entry gives two copies of
  every tool. Setup must remove the old entry.
- **Hooks must fail open**: server down means silence, never a blocked edit or prompt.
  UserPromptSubmit has a 30 s default timeout and stalls the session if the hook hangs; the
  keyword hook does no I/O.
- **Public tree**: the plugin ships publicly. No internal hostnames, no tokens, no LAN addresses.
- **Cache copy vs local path**: a GitHub install copies files; a local path reads in place.
  Use the local path during development, the GitHub marketplace for everyone else.

## 7. Phases

| Phase | Work | Done when |
|---|---|---|
| 0 | `plugin/` with manifest, `.mcp.json`, hook port, routing skill; root `marketplace.json`; `claude plugin validate ./plugin`; install from the local path; remove the old `claude mcp` entry and manual hook on this machine | `claude plugin list` shows `fantom-mcp`, edits reach `/admin/indexing/focus`, `askCodebase` works through the plugin |
| 1 | `GET /admin/context`, SessionStart hook, prompt hint, usage tracker `session_id` + `client` | A new session in SoundSuite shows the context block; `tool_events` rows carry sessions |
| 2 | Workflow skills generated at build, `fantom-workflows` index, `/fantom-mcp:doctor`, grep hint | `claude plugin details` under 600 always-on tokens |
| 3 | `bin/fantom-mcp-cli.mjs` (`setup`, `doctor`, `status`, `token`, `disconnect`), npm publish, GitHub marketplace via `scripts/release-public.sh` | A clean machine goes from nothing to `Ready` with one command |

## 8. How to measure

- `tool_events` per month, per client, per session. Target for the first month after
  phase 1: calls from at least two repos other than `mcpfantom`, and `askCodebase` plus graph
  tools above 20 % of calls (today about 11 %).
- `claude plugin details fantom-mcp@fantom-mcp`: always-on tokens under 600.
- Hook wall time from Claude Code's hook log: SessionStart under 1 s with the server up.

## 9. Open questions

- Direct `:3848` with optional bearer, or keep the `:9191` proxy for Fantom too? Direct is
  simpler and one less process; the proxy stays for the other upstreams either way.
- Ship all 14 workflow skills or only the index skill plus on-demand load? Decide by token
  cost after phase 2.
- Plugin name `fantom-mcp` and server name `fantom-mcp` give the prefix
  `mcp__plugin_fantom-mcp_fantom-mcp__`. A shorter server key (`fantom`) gives
  `mcp__plugin_fantom-mcp_fantom__`. Pick before phase 0; renaming later breaks permission rules.
