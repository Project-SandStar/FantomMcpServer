# Code Analysis Tools

Tools for parsing, analyzing, and validating Fantom source code.

## Tools

### code_parse
Parse a Fantom source file and extract its structure.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| filePath | string | Yes | Path to the Fantom file |
| includeComments | boolean | No | Include comments in output |

**Example:**
```json
{
  "filePath": "/path/to/MyClass.fan",
  "includeComments": true
}
```

**Returns:** AST with classes, methods, fields, and their metadata.

---

### code_getSymbols
Get all symbols (classes, methods, fields) from a file or project.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| filePath | string | No | Specific file path |
| projectId | number | No | Project ID to scan |

**Example:**
```json
{
  "projectId": 1
}
```

---

### code_findDefinition
Find the definition of a symbol at a specific location.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| filePath | string | Yes | File containing the reference |
| line | number | Yes | Line number |
| column | number | Yes | Column number |

**Example:**
```json
{
  "filePath": "/path/to/file.fan",
  "line": 10,
  "column": 15
}
```

---

### code_findReferences
Find all references to a symbol.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| symbolName | string | Yes | Name of the symbol |
| projectId | number | No | Limit to specific project |

**Example:**
```json
{
  "symbolName": "MyClass.doSomething",
  "projectId": 1
}
```

---

### code_getCompletions
Get code completion suggestions at a specific location.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| filePath | string | Yes | File path |
| line | number | Yes | Line number |
| column | number | Yes | Column number |
| prefix | string | No | Partial text to complete |

**Example:**
```json
{
  "filePath": "/path/to/file.fan",
  "line": 10,
  "column": 5,
  "prefix": "str."
}
```

---

### code_validateSyntax
Validate the syntax of Fantom code.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| code | string | Yes | Fantom code to validate |
| filePath | string | No | Optional file path for context |

**Example:**
```json
{
  "code": "class MyClass { Int x := 0 }"
}
```

---

### code_extractDependencies
Extract pod dependencies from a file or project.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| filePath | string | No | Specific file |
| projectId | number | No | Project ID |

**Example:**
```json
{
  "projectId": 1
}
```

---

### code_getCallHierarchy
Get the call hierarchy for a method.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| methodName | string | Yes | Fully qualified method name |
| direction | string | No | "incoming" or "outgoing" |

**Example:**
```json
{
  "methodName": "MyClass.process",
  "direction": "outgoing"
}
```

---

## Test Results

| Tool | Status | Notes |
|------|--------|-------|
| code_parse | - | - |
| code_getSymbols | - | - |
| code_findDefinition | - | - |
| code_findReferences | - | - |
| code_getCompletions | - | - |
| code_validateSyntax | - | - |
| code_extractDependencies | - | - |
| code_getCallHierarchy | - | - |

---

## Project dependencies and ask scope

The server keeps a directed graph of relations between indexed code projects in the
`project_dependencies` table ("from project depends on to project"). Rows are recomputed after
every index run (`runIndex`), when a project is created, and on demand; `manual` rows are never
touched by a rebuild and `enabled=false` rows keep their flag across rebuilds.

| kind | derived from | confidence |
|------|--------------|------------|
| `build.fan-depends` | `<project>/build.fan` (plus `pod/*`, `src/*` sub-pods) `depends = [...]`; the pod name is mapped to an indexed project by `podName` — same instance first, then the instance's Fantom build (`fantom.<version>.<pod>`), then standalone pods, then the newest version | 1.0 |
| `package.json` | `dependencies` / `devDependencies` matched to an indexed project by name, `podName`, its own package.json name, or a `file:` / `link:` / `workspace:` path | 1.0 |
| `cross-project-edges` | `cross_project_edges` grouped per (source, target) with at least 5 resolved call edges, one row per direction | min(1, edges / 20) |
| `workspace-sibling` | other indexed projects in the same parent directory (direct children, at most 8) | 0.5 |
| `manual` | added in the dashboard or via the API | 1.0 |

Names that do not resolve to an indexed project (e.g. `rete`, `vuex`) are stored on the project as
`libraries` and summarised in `summary`; the ask's plan note uses them to say which project holds a
library.

**How the ask uses it** — `answerCodeQuestion` (`POST /admin/vectors/ask`, MCP `askCodebase`) calls
`getProjectScope(projectId)`: the primary project plus its enabled dependencies *and* dependents,
deduped, ordered by confidence, capped at 4 related projects (`semanticSearch.answerSynthesis.maxScopeProjects`).
Every search stays scoped to exactly one project — the cap bounds the number of per-project graph
connections an ask opens. Related hits are tagged `[project: name]` and the RLM plan is told each
project's kind, direction, language and libraries. If a project has no rows yet, same-directory
siblings are used as a fallback.

**Endpoints** (Basic Auth): `GET /admin/code-projects/:id/dependencies` → `{project, dependsOn, dependents, declared, scope}`;
`POST /admin/code-projects/:id/dependencies {toProjectId}` (manual); `PATCH …/dependencies/:depId {enabled}`;
`DELETE …/dependencies/:depId` (manual only, `?force=1` for automatic rows); `POST …/dependencies/rebuild`;
`POST /admin/code-projects/dependencies/rebuild-all`; `GET /admin/project-dependencies/summary` (per-project counts).
In the dashboard, the Pods & Projects page shows `↑n ↓m` per row (click to expand the panel: lists, kind
badges with the raw source on hover, enabled toggles, manual add, declared build.fan / package.json entries
with unresolved ones greyed) and a "Rebuild All Dependencies" button; the Vector Viewer shows the same panel
for the selected project.

---

## Semantic search: embedding text layout v3

Every code vector is built from a text the embedding model sees, not from the raw file. The layout
is versioned (`EMBED_TEXT_VERSION` in `src/embedding/embeddingText.ts`); `GET /admin/vectors/model-status`
reports `code.textVersion` with the projects whose vectors were written with an older layout.

**v3 layout (one text per chunk):**

```
kind: method
file: rete nodes | imports: rete, types, sedona
sedonaWebEditor src rete nodes.ts createSedonaNode
createSedonaNode(component: SedonaComponentModel, services: unknown, appId: string, …): SedonaNode
context: in <EnclosingClass>; calls: getSocket, addInput; called by: loadComponentNode
<documentation, up to 800 chars, comment markers removed>
<exact source span of the symbol — import lines, blank runs and trailing spaces removed>
```

- `kind:` comes from the graph `node_type` (function, method, class, mixin, field, type, comment, file, project)
  so kind words in a question match.
- `context:` is derived from the per-project code graph in one paged query per project (never per node),
  at most 5 names per list.
- The body is the parser's **exact span** (`line_start`–`line_end`; tree-sitter for TS/JS/Vue, brace
  matching for Fantom). A span longer than 40 lines is embedded as **overlapping 40-line windows with a
  10-line overlap**; each window is its own LanceDB row (`row_id = <nodeId>#<chunk>`, chunk 0 keeps the
  plain node id; `node_id` is the node on every row). Search groups rows by node, keeps the best chunk, and
  cites that chunk's own `lineStart`/`lineEnd` (`chunkIndex` is returned too).
- One `kind: file` row per indexed file (path tokens, imports, top-level symbols with kinds, file head) with
  `node_id = file:<sha1(path)>` and `qualifiedName = <project>::<relative path>`, and one `kind: project` row
  (`project:<id>`: name, language, README head, build.fan / package.json description and depends, libraries).
  Toggle with `semanticSearch.embedFileChunks` / `semanticSearch.embedProjectChunks` (default on).
- Noise control: a leading license/copyright comment is dropped, import/using/require lines are left out of
  bodies (they are in the header), blank-line runs are collapsed; each chunk stays ≤ 4000 characters.

**A full re-embed is required.** LanceDB fixes a table's columns at creation, so the chunk/line columns
(`row_id`, `chunk_index`, `chunk_count`, `line_start`, `line_end`, `qualified_name`, `file_path`) only exist on
a table created by a v3 build — the full re-embed (`POST /admin/vectors/re-embed/start` with `projectId: 0`)
builds a fresh shadow table and swaps it in. Until then, single-project re-embeds and the auto-embed watchdog
write v2-shaped rows (chunk 0 only) into the existing table and `model-status` keeps reporting those projects
as stale. Re-index projects first so the graph carries real `line_end` values; without them the body falls back
to the old 25-line window.
