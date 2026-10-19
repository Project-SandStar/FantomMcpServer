---
name: doctor
description: Check the Fantom MCP plugin - server, proxy, report token, plugin install, duplicates, and whether the current directory is a registered project.
---

# Fantom MCP doctor

Result for `${CLAUDE_PROJECT_DIR}`:

```
!`node "${CLAUDE_SKILL_DIR}/../../bin/doctor.mjs" --cwd "${CLAUDE_PROJECT_DIR}" 2>&1 || true`
```

If the block above is empty (shell injection is off), run it yourself:

```
node "${CLAUDE_SKILL_DIR}/../../bin/doctor.mjs" --cwd "${CLAUDE_PROJECT_DIR}"
```

Then tell the user, in one short list, what failed and the fix line the doctor
printed. Common cases:

- **server not reachable**: start it in the mcpfantom repo with
  `npm run start:dev` (or `npm run start:dev:launchd` on macOS).
- **mcp endpoint not reachable**: the `:9191` mcp-proxy is down. Start it, or
  set the plugin option `mcp_url` to the server's own `/mcp` URL.
- **no report token**: run `claudePlugin/scripts/install-local.sh` in the
  mcpfantom repo, or create one in Dashboard > Indexing > Report token and set
  the plugin option `report_token`.
- **legacy hook or MCP entry**: the fix is one command, run it for the user
  after they agree: `node "${CLAUDE_SKILL_DIR}/../../bin/fantom-mcp.mjs" clean-legacy`
  (add `--dry-run` to list first). While a manual `fantom-mcp` entry exists,
  Claude Code suppresses the plugin's own MCP server.
- **not a registered project**: offer `/fantom-mcp:add-project`.
