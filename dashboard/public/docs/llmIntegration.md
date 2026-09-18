# LLM Integration Guide

How AI assistants should use the Fantom MCP Server to understand code, discover interdependencies, and work effectively across multi-language projects.

## Overview

The Fantom MCP Server indexes source code across multiple languages (Fantom, TypeScript, JavaScript, Vue, CSS, Dart, and more) and builds a code graph that tracks function calls, type inheritance, imports, and other relationships. This guide explains how to leverage these capabilities when working with a codebase.

## Discovery Workflow

When starting work on an unfamiliar codebase, follow this sequence:

### 1. List Available Projects

```json
{ "tool": "listFantomProjects" }
```

This returns all indexed projects with their IDs, names, paths, language, function counts, and type counts. Use this to understand what code is available.

### 2. Get Code Statistics

```json
{ "tool": "getFantomCodeStats" }
```

Returns aggregate statistics: total functions, types, projects, and search index size. Useful for gauging the scale of the codebase.

### 3. Search for Relevant Code

Use `searchFantomCode` to find functions, methods, and fields by name or keyword:

```json
{
  "tool": "searchFantomCode",
  "query": "handleConnection",
  "limit": 10
}
```

Filter results by project, class, type, or visibility:

```json
{
  "tool": "searchFantomCode",
  "query": "render",
  "projectId": 265,
  "className": "AppView",
  "type": "method"
}
```

### 4. Get Function Details

Once you find a function of interest, get its full details including parameters, return type, and call graph:

```json
{
  "tool": "getFantomFunction",
  "qualifiedName": "sedonaWebEditor::AppView.render"
}
```

This returns the function signature, parameters, documentation, file path, line number, and the list of functions it calls.

## Understanding Code Interdependencies

The server builds a code graph stored in the database with nodes (functions, types, files) and edges (calls, extends, implements, imports). Use the Admin API graph endpoints to explore these relationships.

### Graph Types

| Graph Type | Purpose | Use When |
|------------|---------|----------|
| `project` | Full project dependency overview | Starting analysis of a project |
| `callers` | Who calls this function? | Understanding impact of changes |
| `callees` | What does this function call? | Understanding implementation |
| `impact` | Transitive impact analysis | Assessing blast radius of a change |
| `subgraph` | Neighborhood around a node | Exploring local relationships |
| `modules` | File-level import dependencies | Understanding module structure |

### Edge Types in the Graph

| Edge Type | Meaning |
|-----------|---------|
| `calls` | Function A calls function B |
| `extends` | Type A extends (inherits from) type B |
| `implements` | Type A implements mixin/interface B |
| `contains` | Type A contains method/field B |
| `imports` | File A imports from file B |
| `uses-type` | Function uses a type as parameter or return |
| `field-access` | Method accesses a field via `this.fieldName` |

### Example: Finding All Callers of a Function

To understand what would break if you change `ConnectionManager.connect()`:

1. Search for the function:
   ```json
   { "tool": "searchFantomCode", "query": "connect", "className": "ConnectionManager" }
   ```

2. Use the graph API to find all callers:
   ```
   GET /admin/graph/visualize?qualifiedName=myPod::ConnectionManager.connect&graphType=callers&depth=3
   ```

3. The response contains nodes and edges showing the full call chain leading to that function.

### Example: Understanding a Type Hierarchy

To understand the inheritance structure around a class:

1. Search for the type:
   ```json
   { "tool": "searchFantomCode", "query": "BaseService", "type": "method", "className": "BaseService" }
   ```

2. Use the graph to see extends/implements relationships:
   ```
   GET /admin/graph/visualize?qualifiedName=myPod::BaseService&graphType=subgraph&depth=2
   ```

3. Filter the returned edges for `extends` and `implements` edge types to map the hierarchy.

## Multi-Language Projects

The server supports mixed-language projects. A Vue project will have its TypeScript, JavaScript, CSS, and Fantom files all indexed together under one project.

### How Languages Are Detected

When a project is created, the server scans the directory and detects the primary language:
- If `.vue` files exist, the project is marked as `vue` with `tree-sitter-wasm` parser
- Fantom projects (`.fan` files dominant) use the specialized `regex` parser
- Other languages (TypeScript, Python, Java, etc.) use `tree-sitter-wasm`

### Fantom Files Are Always Indexed

Since this is a Fantom MCP server, `.fan` files are always scanned and parsed regardless of the project's primary language. A Vue project containing Fantom build files will have both Vue/TypeScript functions and Fantom functions indexed.

### Vue File Parsing

Vue single-file components are parsed by extracting embedded blocks:
- `<script lang="ts">` content is parsed as TypeScript
- `<script>` content is parsed as JavaScript
- `<style>` content is parsed as CSS
- Each block's functions and types are attributed to the `.vue` file with correct line offsets

## Unified Search

Use `searchAll` to search across both documentation and code simultaneously:

```json
{
  "tool": "searchAll",
  "query": "HttpClient",
  "sources": ["local-docs", "code"],
  "limit": 10
}
```

This returns results from local SkySpark/Fantom documentation and from indexed source code, letting you see both the API docs and actual implementations.

## Version-Aware Search

Use `searchVersionedApi` for version-specific queries:

```json
{
  "tool": "searchVersionedApi",
  "query": "readAll",
  "mode": "all",
  "version": "3.1.12"
}
```

Modes:
- `api` - Search documentation/API references
- `code` - Search source code
- `samples` - Search code examples
- `all` - Search everything

## Recommended Workflows for Common Tasks

### "I need to modify function X"

1. `searchFantomCode` with the function name
2. `getFantomFunction` for full details
3. Graph API with `graphType=callers` to find everything that calls it
4. Graph API with `graphType=callees` to understand what it depends on
5. Make the change with full knowledge of upstream and downstream impact

### "I need to understand how module Y works"

1. `listFantomProjects` to find the project
2. Graph API with `graphType=project` and the project ID for the full dependency map
3. Graph API with `graphType=modules` for file-level import structure
4. `searchFantomCode` with `projectId` filter to explore specific functions

### "I need to find where type Z is used"

1. `searchFantomCode` for the type name
2. Graph API with `graphType=subgraph` on the type node
3. Filter edges for `extends`, `implements`, and `uses-type` to see all usage patterns

### "I need to assess the impact of changing a class"

1. Find the class via `searchFantomCode`
2. Graph API with `graphType=impact` and `depth=4` for transitive impact analysis
3. Review all affected nodes to understand the blast radius
4. Check each affected function with `getFantomFunction` for context

## CLAUDE.md Integration

Copy the following into your project's `CLAUDE.md` to give Claude Code direct instructions:

```markdown
## Fantom MCP Server

This project is connected to the Fantom MCP Server which indexes code across all languages
(Fantom, TypeScript, JavaScript, Vue, CSS, Python, Java, Go, Rust, Dart, and more) and
builds a code graph tracking interdependencies. Use these tools before reading files directly.

### Search

- `searchFantomCode` - Find functions, methods, and fields by name, class, category, or project.
  Supports filters: `projectId`, `instanceId`, `className`, `type` (method/field/constructor),
  `isPublic`, `compatibleWith`, `limit`.
- `searchAll` - Unified search across documentation and source code simultaneously.
  Specify `sources: ["local-docs", "code"]` to control scope.
- `searchVersionedApi` - Version-aware search across API docs, source code, and code samples.
  Use `mode: "api"|"code"|"samples"|"all"` and `version` for strict version filtering.
- `searchLocalDocs` - Search local SkySpark/Haxall/Fantom documentation by instance.
  Filter by `pod`, `type` (type/function/tag/slot/chapter), `language` (fantom/axon).

### Retrieve

- `getFantomFunction` - Get full details for a function: signature, parameters, return type,
  documentation, file path, line number, and the list of functions it calls.
  Look up by `qualifiedName` (e.g., "myPod::MyClass.myMethod") or `id`.
- `getFantomType` - Get detailed type info including slots, inheritance, and mixins.
  Look up by `qualifiedName` (e.g., "sys::Str").
- `listFantomProjects` - List all indexed projects with IDs, paths, language, and stats.
  Filter with `compatibleWith` for version-specific results.
- `listFantomPods` - List all available pods in the indexed documentation.
- `listCompatiblePods` - List pods compatible with a specific SkySpark/Haxall version.
- `listLocalPods` - List documentation pods available for an instance.
- `getFantomCodeStats` - Aggregate stats: total functions, types, projects, search index size.
- `getLocalDocStatus` - Documentation indexing status for an instance.

### Code Graph (Interdependencies)

The server builds a code graph with nodes (functions, types, files) and edges:
- `calls` - Function A calls function B
- `extends` - Type A inherits from type B
- `implements` - Type A implements mixin/interface B
- `contains` - Type A contains method/field B
- `imports` - File A imports from file B
- `uses-type` - Function uses a type as parameter or return
- `field-access` - Method accesses a field via this.fieldName

**Before modifying any function**, use `searchFantomCode` to find it, then query the graph
to understand its callers (`graphType=callers`) and callees (`graphType=callees`).
Use `graphType=impact` with `depth=3` to assess the blast radius of a change.
Use `graphType=modules` with a `projectId` to see file-level import structure.

### Project Management

- `addFantomProject` - Add a new project to the index (any language, auto-detected).
  Requires `name` and `path`.
- `refreshFantomProject` - Re-index a project to pick up code changes.
  Use after editing source files so the index stays current.
- `indexInstanceDocs` - Index or refresh local documentation for a SkySpark/Fantom instance.

### Code Generation (Fantom)

- `generateFantomCode` - Generate Fantom classes, methods, pods, enums, and mixins.
  Specify `type`, `name`, optional `pod`, `extends`, and `validate`.

### Migration (SkySpark 3.x to 4.0)

- `migrateSkySpark4x` - Automated migration workflow.
- `commitMigration` - Commit and push migration changes after review.
- `rollbackMigration` - Rollback to pre-migration state.

### Workflow

1. Always search before reading files — the index is faster than scanning directories.
2. After finding a function, check its callers and callees via the graph before changing it.
3. After making code changes, call `refreshFantomProject` so the index stays accurate.
4. Use `searchAll` when you need both documentation context and source code results.
5. Use `listCompatiblePods` when working with version-specific features.
```
