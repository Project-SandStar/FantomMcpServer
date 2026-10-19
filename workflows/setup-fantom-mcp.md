# Set Up the Fantom MCP Server — connect a client, report changes, keep the index live

> **Claude Code users:** install the plugin instead of the manual steps below.
> It adds the MCP server, the edit-report hook and the session context in one
> go: `npm run plugin:install` in the mcpfantom repo, then `/fantom-mcp:doctor`.
> See `claudePlugin/README.md`. The manual hook below is for other clients.

> **Why this exists:** the server only knows about code it has indexed. Git
> commits and a slow scan catch changes eventually; an AI client that reports
> its own edits makes them visible within a second, and tells the server
> *why* the code changed. This workflow sets up a client so that happens
> automatically.

## Purpose

Connect an AI client (Claude Code or any MCP client) to the Fantom MCP
server, add the project, and wire change reporting:

```
  AI edits a file ──► PostToolUse hook ──► POST /admin/indexing/report
                  └─► (other clients) reportChanges tool
                                   │
                                   ▼
          focus set + parse task (priority 10) ──► hash gate ──► graph + vectors
```

Reports are **hints**. The server still compares file hashes; a missed or
wrong report costs nothing but freshness.

---

## 1. Run the server

| Mode | Command | Port |
|---|---|---|
| Development (tsx watch) | `npm run start:dev` (macOS: `npm run start:dev:launchd`) | `:3848` |
| Production build | `npm run build && npm run start:http` | `:3847` |
| Single client over stdio | `npm run dev` | — |

Check it: `curl -s http://localhost:3848/health`.

## 2. Connect the client

**Claude Code** (HTTP transport):

```bash
claude mcp add --transport http fantom-mcp http://localhost:3848/mcp
```

**Any MCP client** (`mcpServers` JSON):

```json
{
  "mcpServers": {
    "fantom-mcp": { "type": "http", "url": "http://localhost:3848/mcp" }
  }
}
```

For stdio, use `"command": "node", "args": ["/abs/path/build/index.js"]`.
Tool calls can run long (`askCodebase` up to 120 s); do not set a short
client `timeout`.

## 3. Add the project

Call `addFantomProject({ path: "/abs/path/to/repo" })`, or add it on the
dashboard **Pods & Projects** page. The language is detected from the files
and re-checked on every reindex; one project may hold several languages
(TypeScript + Vue + markdown are all indexed).

Nested git repos (a repo inside a folder of another repo) are tracked
separately: each file belongs to the deepest repo that contains it.

## 4. Turn on lazy indexing for the project

Lazy indexing reindexes on git commits, merges and checkouts, and scans
folders without git every 5 minutes. It is off by default and enabled per
project in `config/fantomMcpServer-config.json`:

```json
{ "indexing": { "lazy": { "enabled": true, "projects": [275] } } }
```

The server re-reads this every 30 s; no restart. Set `"enabled": false` to
stop it. A large change set (≥ 40 % of files) becomes a low-priority full
reindex that waits for other heavy jobs.

## 5. Report AI changes automatically (Claude Code hook)

Create a report token once (dashboard **Indexing → Report token**, or
`POST /admin/indexing/report-token`). The server stores only its hash.
Put the token where the hook can read it, outside any repo:

```bash
mkdir -p ~/.fantom-mcp && printf '%s' '<token>' > ~/.fantom-mcp/report-token
chmod 600 ~/.fantom-mcp/report-token
```

Add the hook to `~/.claude/settings.json` (all projects) or the project's
`.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "/abs/path/to/mcpfantom/scripts/hooks/fantom-report-change.sh",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

What the hook does (`scripts/hooks/fantom-report-change.sh`):

- Reads the hook JSON from stdin: `tool_input.file_path` (or
  `notebook_path`), `cwd`, `session_id`.
- POSTs `{ files, cwd, sessionId, client: "claude-code" }` to
  `$FANTOM_URL/admin/indexing/report` (default `http://localhost:3848`) with
  the `X-Fantom-Hook-Token` header.
- Uses `curl -m 2 … || true`: it never blocks or fails the edit. If the
  server is down the ping is lost and the next scan or commit catches up.

Settings: `FANTOM_URL` overrides the server URL; `FANTOM_REPORT_TOKEN` or
`~/.fantom-mcp/report-token` holds the token. A file outside every indexed
project is ignored by the server.

Check it: edit a file in an indexed project, then
`GET /admin/indexing/focus` lists it and `listIndexRuns` shows a run with
`trigger = "report"`.

## 6. Other MCP clients: call `reportChanges`

Clients without hooks should follow this rule:

> After you write or edit files in an indexed project, call
> `reportChanges({ files: [<abs paths>], intent: "<one line: why>" })`.
> Batch the files of one logical change into one call.

`intent` is kept with the change and later helps summarize the commit in
code history. Prefer `reportChanges` (asynchronous, cheap) for routine
edits; use `reindexChangedFiles` (synchronous parse + embed) only when the
next step needs the new code in search at once — see
`workflow://ai-coding-loop`.

## 7. What the server does with it

- **Focus set:** files the AI reads, searches or edits are remembered for
  30 minutes. Before a tool answers about one of them, the server checks
  the file and re-parses it if it changed, so answers about code being
  edited are not stale.
- **Suggestions:** answers about a focus symbol may carry a `related`
  block: callers, callees, tests that name it, and recent changes to the
  same files.
- **Uncommitted edits** are parsed so search follows the working tree; only
  committed code is summarized into history.

---

## Gotchas

- The hook fires on the client's edit tools only. Files changed by shell
  commands (`sed`, code generators, `git checkout`) are caught by the git
  watcher and the scan, not the hook.
- Reports for a project without lazy indexing are accepted and parsed, but
  the project gets no commit watching or scan until it is enabled.
- Never put the report token in a repo or in the hook command line; read it
  from the file or the environment.
- Admin Basic Auth credentials do not belong in hooks; the report endpoint
  takes only the report token.
