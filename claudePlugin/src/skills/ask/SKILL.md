---
name: ask
description: Ask the Fantom MCP server a question about the current project's code (askCodebase with citations). Usage - /fantom-mcp:ask how does the connector poll points
argument-hint: <question about this codebase>
---

Answer this question from the index, not from memory:

> $ARGUMENTS

Steps:

1. `ToolSearch("fantom", 30)` if the Fantom tools are not loaded yet.
2. Take the `projectId` from the Fantom MCP session context at the top of this
   session. If there is none, call `listFantomProjects` and pick the project
   whose path contains `${CLAUDE_PROJECT_DIR}`. If none matches, say so and
   offer `/fantom-mcp:add-project`.
3. Call `askCodebase` with `query` = the question and that `projectId`. It can
   take up to 120 s. Pass `useRlm: false` only when the user asked for a quick
   answer.
4. Report the answer with the file and symbol citations the tool returned.
   When the tool found nothing, say "not in the index" and suggest
   `searchFantomCode` with other words, or `refreshFantomProject` if the index
   is stale.
