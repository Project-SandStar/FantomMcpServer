# Per-Project Graph DB Migration

**Status:** in progress (C1 shipped). **Started:** 2026-05-07.

## Why

Today fantom-mcp uses one shared LadybugDB at `<installRoot>/.cache/fantom-graph.db`.
Every CodeNode/CodeEdge has a `project_id` column; queries filter on it.

This shape causes recurring problems:

- **Lock contention.** Kuzu/LadybugDB holds an exclusive file lock; two processes
  or two concurrent reindexes serialize through it. Round 9 surfaced this as
  opaque "Could not set lock on file" errors that crashed unrelated tools.
- **Hash collisions.** Node IDs are `md5(filePath:qn:line)`. Two projects sharing
  a file path collide. We pay for this with `clearOrphanProjectGraphs` (boot-time
  scan over all nodes) and the duplicate-key handler in `ladybugGraphBuilder.ts`.
- **Blast radius.** One project's IO panic / corruption can poison the shared DB
  for all 241 projects (round 7's "SandStar" crash).
- **Drop-project is expensive.** Two-direction Cypher DELETE traversals plus
  edge cleanup vs `rm -rf <project>.db`.

Per-project graph DBs eliminate all four classes.

## Why not also per-project for vectors?

Investigated separately. Recommendation: **keep LanceDB shared.** ANN index
quality benefits from a single large table; cross-project semantic search
(`findSimilar()`) deliberately omits projectId; per-project would require fan-out
+ score-merge for every search. See agent report for details.

## Engine choice

**Stay on LadybugDB.** Kuzu was archived 2025-10-10 (Apple acquisition).
LadybugDB is a maintained Cypher-compatible fork; v0.16.1 shipped 2026-05-04.
MIT, embedded, npm-shipped (`@ladybugdb/core`).

**Documented fallback:** DuckDB + DuckPGQ. If LadybugDB ever stalls, migration
is a one-time Cypher → SQL/PGQ rewrite (~few hundred LOC, mechanical). Per-project
sharding is engine-agnostic — same shape works for either engine.

## Target shape

```
.cache/
├── graph/
│   ├── 50.db/        ← per-project Kuzu DB
│   ├── 100.db/
│   ├── 242.db/
│   └── ...
├── fantomvector.db/  ← shared LanceDB (unchanged)
└── fantom.db         ← Prisma SQLite (unchanged)
```

Connection layer: `Map<projectId, Entry>` with LRU eviction. Default cap: 8 open
DBs (env-tunable: `FANTOM_GRAPH_MAX_OPEN`). On evict: `CHECKPOINT;` then
`close()`, unlink pidfile. Per-project pidfile (`<dbPath>.pid`) gates
process-level conflicts at *project* granularity — multiple processes on
*disjoint* project sets is now legal.

## API

```ts
// Primary low-level API:
projectQuery<T>(projectId: number, cypher: string): Promise<T[]>;
projectExecute(projectId: number, cypher: string): Promise<void>;

// Connection manager:
getProjectConnection(projectId: number): Promise<Connection>;
closeAllProjectConnections(): Promise<void>;
markProjectDegraded(projectId: number, err: unknown): void;
isProjectDegraded(projectId: number): boolean;

// Higher level (cached per-project):
getLadybugQueryManager(projectId: number): LadybugQueryManager;
```

Rationale for first-arg `projectId` (vs context object / AsyncLocalStorage):
every existing call site has projectId in lexical scope, so plumbing is
mechanical; explicit arg makes the project boundary visible at every call;
no magic = easier to debug.

## Migration commits

| # | Scope | What still works after | New code |
|---|---|---|---|
| **C1** | Connection manager (additive — new module, no caller changes) | Everything; old `ladybugQuery(cypher)` unchanged | `src/graph/projectGraphConnection.ts` |
| **C2** | Convert `graph/*` internal callers to `projectQuery/Execute(pid, …)` | Graph-tool integration tests | ~50 sites in `ladybugQueryManager`, `ladybugSchema`, `ladybugGraphBuilder`, `communityDetection`, `processTracer`, `graphVisualization`, `changeDetector` |
| **C3** | Convert `fantom-code/`, `embedding/`, `search/` callers | Indexing pipeline e2e; semantic search e2e | `codeIndexingService`, `fileSymbols`, `vectorStore` (cross-project node lookup → reverse via Lance), `semanticSearchService` |
| **C4** | Convert `admin/routes.ts` + `src/index.ts`; **delete** orphan-sweep + hash-collision guard; remove backward-compat shim from C1 | Admin integration tests; full e2e | Delete `clearOrphanProjectGraphs` (`ladybugSchema.ts:156-210`); delete duplicate-key handler in `ladybugGraphBuilder.ts:228-232` |
| **C5** | One-shot migration script + docs update | Tools to migrate from old shared DB | `scripts/migrate-shared-graph.mjs`; CLAUDE.md |

After C4, no caller touches the old `ladybugQuery(cypher)` form; the shim is removed.

## Cross-project queries — disposition

Today there are ~3 truly cross-project queries:

| Query | New form |
|---|---|
| `ladybugSchema.ts:72` health probe | drop or run against arbitrary project |
| `ladybugSchema.ts:177` distinct project_ids (orphan sweep) | **deleted** (orphans impossible) |
| `ladybugSchema.ts:264` `MATCH (n) DELETE n` (full reset) | `rm -rf .cache/graph/` |
| `ladybugConnection.ts:196` global stats | fan-out: enumerate Prisma projects, sum |
| `admin/routes.ts:3141, 3157, …` admin global counts | fan-out via Prisma project list |
| `graphToolHandlers.ts:527` per-project breakdown | already projectId-aware; trivial |
| `graphQueryDSL.ts` "any project" mode | drop — admin caller iterates project list |
| `vectorStore.ts:96-102` node→project reverse lookup | use Lance's stored `project_id` column instead |

For admin dashboard global stats: store last-known counts in Prisma
(`Project.nodeCount`, `Project.edgeCount`) and refresh on indexing complete.
Render dashboard from Prisma rather than fan-out at request time.

## Backwards compat

**Drop, don't migrate** for dev users. Re-indexing is well-tested.

Provide opt-in `scripts/migrate-shared-graph.mjs`:
1. Open old `.cache/fantom-graph.db` read-only.
2. `MATCH (n:CodeNode) RETURN DISTINCT project_id`.
3. Per pid: ensure `.cache/graph/<pid>.db`, init schema, stream nodes + edges in.
4. On success: rename old DB to `fantom-graph.db.migrated-<ts>`.

Boot-time behavior: if old DB exists and `.cache/graph/` is empty, log a warning
with two options ("run `npm run migrate:graph`" or "delete and reindex"). Never
auto-migrate silently.

## Risks watched in PR review

1. **Schema init race** — first query for a new project must init schema before
   the query runs. Use a per-project `Promise<void>` init latch.
2. **LRU eviction during long queries** — track `inFlight` count per entry; never
   evict an entry with `inFlight > 0`.
3. **vectorStore cross-project lookup** — easy to miss in C3.
4. **Admin fan-out perf** — mitigate via Prisma-cached counts.
5. **Test fixtures** — any test seeding a single graph DB needs per-project paths.
6. **Engine churn** — keep `ladybugConnection.ts` internals thin; `projectQuery(pid, cypher)`
   interface survives an engine swap, internals may not.

## Status

- [x] **C1** (fab193a) — additive connection manager (Map<pid, Entry> + LRU)
- [x] **C2** (9bade0c) — `ladybugQuery` / `ladybugExecute` overload-aware; `clearProjectGraph` + `clearFileGraph` per-project
- [x] **C3** (4bb0ea6) — `graph/*` internal callers: QueryManager / GraphVisualizationService project-bound, GraphBuilder writes to per-project DB, processTracer/communityDetection/changeDetector mechanically converted
- [x] **C4** — `fantom-code/`, `embedding/`, `search/`, key admin handlers + index.ts dispatcher converted; orphan-sweep deleted (now no-op stub); migration script `scripts/migrate-shared-graph.mjs` shipped
- [ ] C5 — final cleanup: remove legacy single-arg form from ladybugConnection.ts after a stabilization window; convert remaining cross-project admin reads (vectorStore.ts node→project lookup is the largest remaining caller)
