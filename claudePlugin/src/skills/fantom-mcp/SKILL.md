---
name: fantom-mcp
description: Fantom, Axon, Haxall, SkySpark and Xeto code knowledge from the Fantom MCP server (semantic search, call graph, impact, change history, docs, 3.x to 4.0 migration). Use it before grepping or guessing an API in a registered project. Tools are deferred - ToolSearch("fantom", 30) first.
---

# Fantom MCP: which tool, when

The server holds an index of every registered project: symbols, a call graph,
vectors for semantic search, docs, and the change history of each symbol.
The SessionStart hook of this plugin tells you whether the current directory
is a registered project and gives its `projectId`. If it did not, call
`listFantomProjects` and match the path, or run `/fantom-mcp:doctor`.

The tools are deferred. Load them once per session:

```
ToolSearch("fantom", 30)
```

| You want to | Call | Notes |
|---|---|---|
| Understand how something works, where it lives | `askCodebase` | `query`, `projectId`. Deep answer with citations, 60 to 120 s. `useRlm: false` for a 20 s answer. |
| Find a function, type, field by name or words | `searchFantomCode` | `query`, `projectId` or `versionGroup`. Fast. |
| Find code by meaning ("retry with backoff") | `semanticCodeSearch` | `query`, `projectId`. |
| Read one symbol | `getFantomFunction`, `getFantomType` | `qualifiedName` like `pod::Type.method`. |
| See everything in one file | `listFunctionsInFile` | `filePath`, `projectId`. Re-parses a changed focus file first. |
| Know what breaks if you change a symbol | `getCallers` then `getCodeImpact` | Always before editing a shared function. |
| Follow a call chain down | `getCallees`, `getCodeNeighbors` | |
| Know what changed and why | `whatChangedRecently`, `getSymbolHistory`, `explainSymbolChange` | `projectId`, `hoursAgo` or `since: "-7d"`. |
| Compare two index runs or two times | `diffIndexRuns`, `diffByTime`, `compareSnapshots` | |
| Read Fantom, Haxall or SkySpark docs | `searchLocalDocs` | Docs of the instance the project belongs to. |
| Axon functions | `axonSearch`, `axonFunction` | |
| Move SkySpark 3.x code to 4.0 | `searchVersionedApi`, `migrateSkySpark4x` | Then the `/fantom-mcp:wf-skyspark-4x-migration` workflow. |
| Pick the right product line | `listVersionGroups` | `versionGroup: "haxall 4.0.6"` or `"skyspark 3.1"`. |
| Check or fix the index | `getIndexHealth`, `refreshFantomProject`, `reindexChangedFiles` | |
| Register this directory | `/fantom-mcp:add-project` | |

Rules:

- Edits you make with Edit or Write are reported to the server by the plugin
  hook. Call `reportChanges` only for files changed by shell commands,
  generators or git.
- When the server returns nothing, say "not in the index" rather than guess a
  Fantom or Axon API from memory. Fantom pods differ by version.
- Scope every call with `projectId` (or `versionGroup`) when you know it. An
  unscoped search across 300+ projects is slow and noisy.
- A failing tool with a connection error means the server is down. Run
  `/fantom-mcp:doctor` and tell the user. Do not retry in a loop.

Workflows (full guides, load on demand): `/fantom-mcp:wf-ai-coding-loop`,
`wf-create-pod`, `wf-unit-testing`, `wf-skyspark-4x-migration`,
`wf-xeto-spec-guide`, `wf-haxall-basics`, `wf-haxall-coding-standards`,
`wf-haxall-methods-workflow`, `wf-connector-workflow`,
`wf-create-skyspark-extension`, `wf-api-migration-reference`, `wf-use-fanr`,
`wf-explore-code-relations`, `wf-setup-fantom-mcp`.
