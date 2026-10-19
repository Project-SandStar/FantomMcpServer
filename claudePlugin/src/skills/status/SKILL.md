---
name: status
description: One-screen Fantom MCP status - server, endpoint, token, and the index state of the current project.
---

Fantom MCP status for `${CLAUDE_PROJECT_DIR}`:

```
!`node "${CLAUDE_SKILL_DIR}/../../bin/fantom-mcp.mjs" status --cwd "${CLAUDE_PROJECT_DIR}" 2>&1 || true`
```

If the block above is empty (shell injection is off), run it yourself:

```
node "${CLAUDE_SKILL_DIR}/../../bin/fantom-mcp.mjs" status --cwd "${CLAUDE_PROJECT_DIR}"
```

Show the lines as they are. If the server is DOWN, point to `/fantom-mcp:doctor`.
If the directory is not registered, offer `/fantom-mcp:add-project`.
