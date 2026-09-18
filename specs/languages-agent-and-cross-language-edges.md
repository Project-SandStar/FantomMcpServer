# LanguagesAgent + Fantom↔Axon Edge Mapping (deferred design notes)

Captured for later. Not on the active backlog (task #5 was deleted on 2026-05-24).

## Part A — Cross-language edges: what we do today

Edge creation lives in `src/graph/ladybugGraphBuilder.ts`. Two paths exist:

1. **Streaming builder** (`createPendingEdges`, lines 437-458): queues edges with `targetName` + context, then `resolveReference(name, ctx)` looks up a node id. If unresolved → counted in `stats.unresolvedCount`.
2. **Batch resolver** (`buildEdgesFromIndexerData`, lines 950-1000): per function, tries in order:
   - `Type.make` then `Type` for constructors
   - `Target.method` when `target` is capitalized
   - `className.method` when target is `this`/`super`
   - bare `calledName` via `resolveByName(...)`

### What this means for fantom ↔ axon

- The `resolveByName` lookup pool is **a single name index built from all CodeNodes in the project**, regardless of language. So:
  - An axon function whose body calls `read(...)` (extracted from a trio `src:` field) WILL get a `calls` edge to a fantom method named `read` if both live in the same project. ✅
  - A fantom method calling `someAxonFunc()` WILL get an edge to the axon node if their qualified names match. ✅
- **But there are three real gaps:**
  1. **Name collisions are silent.** If a fantom method and an axon func share `calledName`, the first one inserted wins. There's no language-tag tiebreaker, no warning logged. Cross-language code with overloaded names will mis-resolve.
  2. **Cross-project resolution is opt-in.** `resolveAllReferences()` (codeIndexingService.ts:1358-1362) is now a noop ("Ladybug resolves references inline during each build"). So axon in `demoProjReset` calling `pointWrite` defined in `haystack` pod will be unresolved unless both are in the same project.
  3. **Axon→fantom call extraction is regex-based** when tree-sitter isn't available (`trioParser.ts:248 extractAxonCalls`). The regex misses dotted calls (`obj.method`), chained pipes (`x | f`), and Axon-specific syntax like `do…end` blocks. Tree-sitter is preferred but used only when the grammar loaded successfully.

### Concrete improvements (not yet tasked)

- **Language-aware tiebreaker in `resolveByName`**: when multiple nodes match, prefer same-language target, then prefer most-recently-modified, then log a `multi-match` warning so the user sees the ambiguity.
- **Re-enable cross-project resolution** as an explicit phase after all projects index. Today `resolveAllReferences()` returns 0 — re-implement it on top of Ladybug as a name-index query across the per-project DBs.
- **Edge property `cross_language: bool`** on `calls` edges. Easy to add; lets the dashboard color fantom↔axon edges differently and lets a query like "show me all axon→fantom calls in this pod" work without joining nodes back.

## Part A.1 — Cross-project edges, Phase 2 storage decision (open)

Phase 1 (this session): `buildCrossProjectNameIndex()` exists on `CodeIndexingService` and is exposed at `GET /admin/graph/cross-project-name-index`. It returns a `Map<name, candidates[]>` covering every per-project Ladybug DB. No edges are written yet.

Phase 2 — actually persisting cross-project edges — requires a storage decision. Kuzu REL TABLE requires both endpoints in the same DB, so cross-project edges can't live in any single per-project `.cache/graph/<id>.db`. Four options, pick before implementing:

1. **Replicate target nodes into source project's DB**. Pro: query parity — existing per-project graph queries "just work" because the target node is local. Con: denormalized; on target re-index the local copy goes stale; doubles storage for popular targets.

2. **Shared legacy DB (`.cache/fantom-graph.db`) holds cross-project edges + lightweight node mirrors**. Pro: single place to query; matches the legacy single-DB shape some code still uses. Con: re-introduces the singleton lock contention we just escaped (PID-file fights); also needs node mirrors so MATCH still works.

3. **Separate Prisma SQLite table `cross_project_edges`** (columns: source_qn, source_project_id, source_language, target_qn, target_project_id, target_language, edge_type, line_number, confidence). Pro: no Kuzu constraints; trivial to query with familiar SQL; survives per-project Ladybug rebuilds. Con: lives outside the graph DB so graph traversals (`MATCH ... )-[*]->( ...`) can't follow them — only direct lookups.

4. **Per-project edge with "shadow" target node carrying `is_external: true` + `target_project_id`**. Pro: graph traversal works locally with a single edge type marker. Con: needs garbage-collection when the real target moves/disappears; bloats per-project node counts; ambiguous semantics for callers/callees queries.

**Decision: Option 3 (Prisma table) — shipped.** `model CrossProjectEdge` lives in `prisma/schema.prisma`; `cross_project_edges` table created via `prisma db push`. Populated by `CodeIndexingService.resolveCrossProjectEdges(projectIds)` and exposed at:
- `POST /admin/graph/resolve-cross-project` `{projectIds?:number[]}` — runs Phase 2 and returns `{edgesWritten, sourceNodesScanned, duplicatesSkipped, ambiguousSkipped}`.
- `GET /admin/code-projects/:id/cross-project-edges?role=source|target|both&limit=N` — list persisted edges.

Known limitation of the current resolver: per-project DBs do not persist unresolved call sites, so Phase 2 derives candidates by tokenizing each function's `signature` field with `/[A-Za-z_]\w*/g` and looking each identifier up in the global name index, skipping STOPWORDS. False positives are possible. Future hardening: persist unresolved call targets on the CodeNode during indexing (new property `unresolved_calls STRING` JSON array), then replay them in Phase 2 instead of tokenizing signatures.

## Part B — LanguagesAgent (deferred)

If/when we build it, the agent should expose four MCP tools (see `src/agents/` for the pattern; register via `ExplorerOrchestrationAgent`):

| Tool | Purpose |
|---|---|
| `listProjectLanguages(projectId)` | `[{language, fileCount, functionCount, typeCount, parserType, sample}]`. Same source data as `GET /admin/code-projects/:id/languages`. |
| `getAxonFunctionsInProject(projectId)` | All axon function records extracted from trio `src:` fields + lib-axon files: `{name, params, body, callers, callees, sourceFile}`. |
| `getProjectStructure(projectId)` | `{pods, templates, views, apps, axonFunctions, fantomTypes}` counts + sample names — so AI can describe a pod ("6 axon functions across 1 view and 1 template"). |
| `searchAxonInProject(projectId, query)` | Semantic search restricted to one project's axon corpus (LanceDB `code_vectors` filtered by `project_id` AND `language='axon'`). |

**Prerequisite**: task #6 (promote axon as a distinct language). Without that, `listProjectLanguages` returns the same 3 buckets the dashboard shows now (trio/fantom/markdown) and axon stays invisible.

**Why a dedicated agent rather than just endpoints**: lets the AI ask compound questions ("which projects use axon and have no tests?") without the caller hand-orchestrating multiple admin REST calls.
