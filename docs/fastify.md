# Fastify Integration Plan — mcpfantom

> **Status as of 2026-06-07** — this doc is now annotated against the live codebase. The Sidecar / LLM / remote-embeddings plan (second half) is **fully shipped**; the Fastify migration and the parsing/boot-hydration speedups are unstarted. Speedup multipliers were the plan's **unvalidated projections** — one has now been **measured** (see below), and it overturns the plan's priorities.
>
> **Legend:** ✅ DONE · 🚧 PARTIAL · ⬜ NOT STARTED

## ⚡ Measured: parse/embed/write split (2026-06-07)

One `force` reindex of a mid-size pod (**Haxall 4.0.4:ext/hxPy**, id 212 — 381 fns, 30 types, 26 files, 351 nodes, 432 edges) on the live server (port **3848**), captured from `logs/server.log`:

| Scope | Cost | Share |
|---|---|---|
| **Within blocking `indexProject` = 13,134 ms** | | |
| ↳ parse + scan + persist | ~610 ms | **~5%** |
| ↳ **graph-build (Kuzu writes)** | **12,524 ms** | **~95%** |
| **Embedding** (separate, *overlapping* phase) | ~9.2 s of batch work, contention-dominated | n/a (parallel) |

**The dominant cost is graph-write, not parsing or embedding** — the opposite of the plan's assumption.

- **Why:** the reindex builder `LadybugGraphBuilder.buildFromFiles` issues **per-row awaited Kuzu round-trips** — per-type/member/function `CREATE` + per-edge `createPendingEdges`. With 351 nodes + 432 edges + **913 unresolved-edge `MATCH`es** ≈ **~1,700 sequential queries / 12,524 ms ≈ 7.4 ms each** — matching the code's own probe (`806 ms / 100 = 8 ms` per single `CREATE`). So it's intrinsic per-row latency, not machine contention.
- **Embedding is already parallel & remote:** routed to **3 sidecars** (`qwen3-embedding:0.6b`, dim 1024) with 3-way fanout. The 7.7 s "embed-semaphore wait" was contention from the background embed-missing watchdog, not intrinsic cost. **Phase C (local embedding pool) is moot.**
- **Caveat:** single sample on a contended box (background watchdog active). The *structural* conclusion (per-row graph writes dominate) is robust; the exact ms are not. A clean repeat needs the watchdog paused.

## Status Scorecard

| Area | Status | Evidence |
|---|---|---|
| **Track A — Fastify migration** | ⬜ NOT STARTED | No `fastify`/`@fastify/express`/`fastify-sse-v2` dep; no `src/admin/fastify/` tree; pure Express (`src/index.ts:145`, `:2682-2683`, `:2821`); port **3847** (`src/config/index.ts:161`), not 3848 |
| `routes.ts` scale | stale fact | now **10,295 lines / 171 routes** (doc originally said 8,592 / 124) |
| **Track B Phase A** — Pino + boot hydration parallelism | ⬜ NOT STARTED | custom logger, not Pino (`src/utils/index.ts:1-60`); sequential boot loop (`src/index.ts:593-622`) |
| **Track B Phase B** — parsing worker pool | ⬜ — **low value** (measured ~5%) | serial parse loop (`codeIndexingService.ts:1285-1310`), but parsing is only ~5% of reindex time — see Measured section |
| **Track B Phase C** — local embedding worker pool | ⬜ — **moot** | embedding already remote + 3-way sidecar fanout; not a bottleneck |
| **Track B Phase D** — Kuzu batched writes | ✅ DONE | `buildFromFiles` now batches node + edge writes via `createNodesFromBatch`/`createEdgesFromBatch` (UNWIND, batch 200); edge-resolution maps preserved |
| **★ NEW top lever** — batch the reindex graph writes | ✅ DONE & VERIFIED | implemented in `buildFromFiles`; rebuild of project 212 reproduced the exact **351 nodes / 432 edges** golden baseline in **4.23s** (vs ~12.5s per-row under load) |
| `scripts/bench-reindex.ts` | ⬜ NOT STARTED | does not exist |
| **Sidecar Registry / LLM rerank / remote embeddings** (entire second plan) | ✅ DONE | shipped in commit `1a71bf6`, exceeds original spec — see [the dedicated section](#sidecar-registry-llm-augmented-search-embeddings-sidecar--shipped) |
| **Indexing timing harness** | ✅ exists | per-stage `durationMs` (`indexingPipeline.ts:312-333`), SSE `GET /indexing/progress` (`routes.ts:9847-9868`), `GET /admin/indexing/state/:projectId` |

---

## Context

The mcpfantom backend has two compounding problems:

1. **Code organization.** `src/admin/routes.ts` is **~10,295 lines, 171 routes** (this doc originally cited ~8,592 / 124 — it has grown since) in a single Express router. Auth, validation, error handling, and SSE plumbing repeat across handlers. Adding features touches a giant file; AI-assisted edits load 30k+ tokens of context per turn.
2. **Background work is largely sequential.** `rebuildGraph()` parses files one-at-a-time, embeddings run batch-by-batch on a single thread in-process, and boot hydration walks ~241 projects in series. There is zero use of `worker_threads`, `piscina`, `p-limit`, or `p-queue` anywhere in the codebase. *(Kuzu graph writes are the exception — those are now batched; see Track B Phase D ✅.)*

Fastify addresses the first: feature-scoped plugin encapsulation for organization + lifecycle hooks for worker-pool plugins. The migration runs side-by-side with Express via `@fastify/express`, so it ships incrementally — one feature per PR, no big-bang rewrite.

The speedup work (worker pools, Pino, Kuzu batching) is framework-agnostic — it lands as Track B and exposes pools via factory singletons, ready for Fastify plugin wrappers when Track A reaches each feature.

**Intended outcome:** smaller per-feature files (~200–500 lines each), explicit JSON Schema validation on every endpoint, parallel parsing/embedding for faster indexing, and a clean exit ramp to NestJS-on-Fastify if the app keeps growing.

> **Note on the current server:** it still listens on port **3847** (`src/config/index.ts:161`). The "3848" used throughout this plan is the *proposed* Fastify socket — it does not exist yet.

---

## Two Tracks, Run in Parallel

### Track A — Fastify Migration (organization) — ⬜ NOT STARTED

> No `fastify`, `@fastify/express`, or `fastify-sse-v2` in `package.json`; no `src/admin/fastify/` directory; the admin router is still pure Express (`createAdminRouter` wired at `src/index.ts:2682-2683`, `app.listen` at `:2821`). Everything below is unbuilt.

**Approach:** Fastify-on-top with `@fastify/express` fallback. Fastify owns the listen socket on port 3848. Each feature plugin claims its routes; everything else falls through to the existing Express router until ported. Single port, single shutdown, SSE works native.

**File layout (proposed — does not exist yet):**

```
src/admin/
  routes.ts                       # legacy — shrinks each PR, deleted at phase 5
  userStore.ts                    # unchanged
  fastify/
    app.ts                        # buildAdminFastify factory
    plugins/
      services.ts                 # decorate prisma, ladybug, lance, embeddings, ...
      auth.ts                     # Basic Auth preHandler (reuses UserStore.authenticatePublic)
      sse.ts                      # fastify-sse-v2 register + helpers
      errors.ts                   # ProjectPathConflictError → 409 mapper
      workerPools.ts              # Track B: pool decorators + onClose drain
    features/
      system.plugin.ts            # ~6 routes
      settings.plugin.ts          # ~10
      users.plugin.ts             # ~6
      tools.plugin.ts             # ~2
      fantomVersions.plugin.ts    # ~4
      fantomBuilds.plugin.ts      # ~5
      backups.plugin.ts           # ~6
      activeInstance.plugin.ts    # ~4
      primaryProject.plugin.ts    # ~3
      instances.plugin.ts         # ~10
      docs.plugin.ts              # ~12 (incl. embed-status SSE)
      fantomPods.plugin.ts        # ~6
      compile.plugin.ts           # ~4
      codeProjects.plugin.ts      # ~10
      indexing.plugin.ts          # ~10 (incl. /indexing/progress SSE)
      treeSitter.plugin.ts        # ~5
      ast.plugin.ts               # ~6
      vectors.plugin.ts           # ~8
      graph.plugin.ts             # ~10
```

**Bootstrap (sketch in `src/index.ts`):**

```ts
const fastify = Fastify({ bodyLimit: 32 * 1024 * 1024 });
await fastify.register(import('@fastify/express'));
await fastify.register(servicesPlugin);     // app.prisma, app.ladybug, ...
await fastify.register(authPlugin);
await fastify.register(sseSupport);
await fastify.register(workerPoolsPlugin);  // app.parsingPool, app.embeddingPool
await fastify.register(systemPlugin,        { prefix: '/admin' });
await fastify.register(codeProjectsPlugin,  { prefix: '/admin' });
// fallback for unmigrated routes:
fastify.use('/admin', createAdminRouter(this.createAdminContext()));
fastify.use('/dashboard', express.static(dashboardPath));
fastify.use('/mcp', mcpExpressHandler);
fastify.use('/health', healthHandler);
await fastify.listen({ port, host: '0.0.0.0' });
```

**Pilot ports (Phase 1):** `system` (trivial GET, helper reuse, `/logs` SSE) + `codeProjects` (exercises `ProjectPathConflictError` → 409 from a recent fix).

**Shared infrastructure must land first in Phase 1:** `services.ts`, `auth.ts`, `sse.ts`, `errors.ts`, type augmentation for `app.prisma` etc.

**Migration phases (single developer) — all ⬜ NOT STARTED:**

| Phase     | Features                                                                                      | Days     | Status |
| --------- | --------------------------------------------------------------------------------------------- | -------- | ------ |
| 1         | Bootstrap, services/auth/sse/errors plugins, pilots: system + codeProjects                    | 3        | ⬜ |
| 2         | settings, users, tools, fantomVersions, fantomBuilds, backups, activeInstance, primaryProject | 4        | ⬜ |
| 3         | instances, docs (incl. embed-status SSE)                                                       | 3        | ⬜ |
| 4         | fantomPods, compile, indexing (incl. progress SSE)                                            | 4        | ⬜ |
| 5         | treeSitter, ast, vectors, graph; delete legacy routes.ts and @fastify/express fallback        | 5        | ⬜ |
| **Total** |                                                                                               | **~19 days** | |

**Skip / defer permanently:**

- `/mcp` — `StreamableHTTPServerTransport` binds Express req/res internals; rewrite is high-risk, low-value
- `/health` — 5-line liveness, no win
- `/dashboard` static — `express.static` is fine
- `/admin/oauth/*` (currently inlined in `src/index.ts`, not in `routes.ts`) — separate PR after Phase 5
- Stdio MCP transport path — never instantiates Fastify; untouched

**Rollback (<5 min):** each plugin is one `await fastify.register(...)` line. Comment it out → Express fallback reclaims those paths because legacy `routes.ts` keeps definitions until Phase 5. Add `ADMIN_FASTIFY_DISABLE=feature1,feature2` env switch for config-only rollback.

---

### Track B — Background Speedup (parallelism)

**Worker pool dependency:** `piscina`. Built on `worker_threads`, native backpressure, simple Promise API. Reject `workerpool` (older API), `workerd` (wrong runtime). *(Not yet added — no worker-pool dep in `package.json`.)*

**File structure (proposed — `src/workers/` does not exist yet):**

```
src/workers/
  parse.worker.ts      # default async (filePath: string) => ParsedFile
  embed.worker.ts      # default async (texts: string[]) => number[][]
  pool.ts              # getParsingPool(), getEmbeddingPool(), drainPools()
```

`pool.ts` would export module-level singletons (factory pattern, like existing `getXxx()`). Stdio MCP mode imports them directly — no Fastify dependency. Fastify mode wraps them via `src/admin/fastify/plugins/workerPools.ts` with `app.decorate` + `onClose` drain.

> ⚠️ **All speedup multipliers below (20×, 60s→18s, ~CPU-count×, ~4×, ~10×, ~3× overall) are the plan's _unvalidated projections_.** No benchmark has been run; `scripts/bench-reindex.ts` does not exist. The instrumentation to measure them *does* exist — see **How to measure** at the end of this track.

#### Phase A — Pino + boot hydration parallelism — ⬜ NOT STARTED

> Logger is a custom `console.error`-based `Logger` class (`src/utils/index.ts:1-60`), not Pino — no `pino`/`pino-pretty` dep. Boot hydration is a sequential `for (const project of projects) { … await hydrateIndexerFromLadybug() }` loop (`src/index.ts:593-622`).

- Swap logger in `src/utils/index.ts` → `pino` (with `pino-pretty` in dev). Boot logs go from ~10s of console writes to ~50ms async. *(projection: ~20× boot log throughput)*
- Parallelize `initializeCodeIndex` in `src/index.ts`: replace the sequential loop with `pLimit(4)` over `hydrateIndexerFromLadybug`. Kuzu supports concurrent reads. *(projection: 60s → ~18s for 241 projects)*

#### Phase B — Parsing worker pool — ⬜ NOT STARTED (⚠️ measured ~5% of reindex — low value)

> **Measurement update:** the 2026-06-07 reindex showed parse+scan+persist at only ~610 ms of 13,134 ms (~5%). The "biggest local lever" framing below is **falsified** — parallelizing parsing optimizes the cheap phase. The real lever is batching graph writes (see ★ below).


> Serial parse loop at `src/fantom-code/codeIndexingService.ts:1285-1310` (`for (let i = 0; i < files.length; i++) { … await parseFile() }`); parsing is single-threaded on a 10-core box. No `src/workers/`, no `piscina`/`p-limit`.

- Refactor `rebuildGraph` to dispatch each file to the parsing pool with `pLimit(CPU-1)` outer cap.
- Each worker holds its own tree-sitter parser instance (init once per worker, reused across files).
- Preserve the per-file progress callback (still throttled every 25 files).
- Threshold: small repos (<50 files) skip the pool and parse inline — worker init cost > parse cost.
- *(projection: project with 4500 functions parses in ~CPU-count× less wall time)*

#### Phase C — Embedding worker pool — ⬜ NOT STARTED, **superseded by shipped remote-sidecar embedding**

> No local `worker_threads` embedding pool exists. **But the bigger lever already ships:** out-of-process embedding onto a remote (GPU) machine via `HttpSidecarProvider` (`src/embedding/providers/embeddingProvider.ts:65-161`), plus multi-sidecar fan-out via `selectAllEmbeddingProviders`. That delivers more than a local thread pool would, and it's already in production (opt-in). **Recommendation: drop this phase** — configure a sidecar instead. The only residual local win is that in-process embedding uses `EMBEDDING_THREADS=2` of 10 cores (`embeddingService.ts:48`), which is a cheap env-var bump, not a worker pool.

- ~~Refactor `embedAll` to run 4 batches in parallel via an embedding pool.~~ — obsolete; remote sidecar path covers this.

#### Phase D / ★ Batch the reindex graph writes — ✅ DONE & VERIFIED (2026-06-08)

> The real win the original plan missed — now implemented. `LadybugGraphBuilder.buildFromFiles` was refactored to:
> 1. Collect all type/member/function nodes (still populating `nodeByQualifiedName` in order, so edge resolution is unchanged) and write them via `createNodesFromBatch()` (UNWIND, batch 200).
> 2. Buffer edges via `collectEdge()` and flush through a new `createEdgesFromBatch()` (`UNWIND $rows MATCH (a),(b) CREATE`), replacing the per-edge `createPendingEdges` round-trips. Unresolved edges are filtered before the write (the 913-MATCH storm is gone).
>
> Single-writer preserved (batching only — Kuzu WAL safety). **Verified:** rebuild of project 212 reproduced the exact **351 nodes / 432 edges** baseline in **4.23 s** (no edges dropped), vs the ~12.5 s per-row build measured under load on 2026-06-07.

#### Combined expected speedup *(projection)*: ~7s per-project reindex → ~2–3s = ~3× overall — **unmeasured.**

#### How to measure (harness already exists)

Before committing to the parsing-pool work, measure the actual parse-vs-embed-vs-write split — the instrumentation is already in place:

- Per-stage `durationMs` is computed for every pipeline stage (`src/fantom-code/indexingPipeline.ts:312-333`) and the total at completion.
- `GET /indexing/progress` (`src/admin/routes.ts:9847-9868`) is an SSE stream of the full `PipelineProgress` (per-stage `startedAt`/`completedAt`/`durationMs`).
- `GET /admin/indexing/state/:projectId` returns the latest snapshot for first-paint.
- Files/sec is logged every 25 files during parsing.
- The graph builder logs its own `durationMs` (`ladybugGraphBuilder.ts`).
- **Optional:** add `scripts/bench-reindex.ts` (⬜ — doesn't exist) to run `indexProject` on a mid-size pod (axon, ~500 fns) and print stage deltas.

**Risks (with mitigations) — for the unbuilt worker-pool phases (B):**

- Worker crash → `Promise.allSettled` + inline-parse fallback per file
- Memory blow-up → cap `maxThreads` at `min(7, configured)`; current `--max-old-space-size=4096` is sufficient
- Tree-sitter WASM thread safety → each worker has own parser; safe
- Worker init > parse cost on small repos → 50-file threshold
- Pino async-exit log loss → `pino.final()` + flush on SIGTERM

---

## Critical Files

**Track A (Fastify) — ⬜ all unbuilt:**

- `src/index.ts` — bootstrap: replace `app.use('/admin', ...)` block (`:2682-2683`) with Fastify wiring
- `src/admin/routes.ts` — shrinks per-PR; deleted at Phase 5
- `src/admin/userStore.ts` — reused unchanged by `auth.ts` plugin (`authenticatePublic`)
- `src/admin/fastify/**` — new tree (does not exist)
- `src/fantom-code/indexingPipeline.ts` — `pipelineEvents` (line 97) consumed by `indexing.plugin.ts` SSE handler
- `src/graph/ladybugConnection.ts` — `closeLadybugConnection` (with CHECKPOINT) wired into `services.ts` `onClose` hook

**Track B (Speedup):**

- ⬜ `src/fantom-code/codeIndexingService.ts:1285-1310` — parsing loop refactor (Phase B)
- ✅ `src/graph/ladybugGraphBuilder.ts:640-720` — UNWIND batch writes (Phase D, **done**)
- ⬜/superseded `src/embedding/embeddingService.ts:138` — in-process batch loop (Phase C — prefer sidecar)
- ⬜ `src/index.ts:593-622` — boot hydration parallelism + Pino swap (Phase A)
- ⬜ `src/utils/index.ts:1-60` — Pino logger (Phase A)
- ⬜ `src/workers/**` — new tree (does not exist)

**Reuse (already exists):**

- `getPrismaClient` (`src/db/prisma.ts`), `getLadybugConnection` (`src/graph/ladybugConnection.ts`), `getLanceConnection` (`src/embedding/lanceConnection.ts`) — to be exposed via `app.decorate`
- `getCodeIndexingService` (`src/fantom-code/codeIndexingService.ts`) — `hydrateIndexerFromLadybug` is public
- `pipelineEvents`, `getLatestPipelineProgress`, `listRunningPipelines` (`src/fantom-code/indexingPipeline.ts`)

---

## Recommended Execution Order

> Updated for current state: Phase D is **done**, Phase C is **dropped** (use a sidecar). Remaining work, lowest-risk first:

1. **Track B Phase A (1 day)** — Pino + boot hydration parallelism. Lowest risk, ships before any Fastify work, immediately observable boot-time win.
2. **Measure first (½ day)** — capture the parse/embed/write split via `/indexing/progress` on a mid-size project, so the Phase B decision rests on real numbers.
3. **Track A Phase 1 (3 days)** — Fastify bootstrap + shared plugins + pilot ports (system, codeProjects).
4. **Track B Phase B (2 days)** — parsing worker pool, *if* step 2 confirms parsing dominates. Plumbed via Track A's `workerPools.ts` plugin once Phase 1 is in.
5. **Track A Phases 2–4 (11 days)** — port the easy/medium feature buckets.
6. **Track A Phase 5 (5 days)** — port the hard buckets (treeSitter, ast, vectors, graph), delete legacy `routes.ts`, remove `@fastify/express` fallback.

**Remaining: ~22 dev-days** (down from the original ~24 — Phase D banked, Phase C dropped). Each phase is independently shippable and revertible.

---

## Verification

**Per Track A phase:**

- Snapshot tests — `curl` every route in the migrating feature against current Express, save to `tests/fixtures/<feature>.json`. Replay against Fastify, byte-diff.
- Dashboard smoke — Playwright script loads each panel served by the migrated feature.
- SSE — `tests/sse-replay.ts` connects, triggers a known job, asserts ≥1 `data:` frame within 30s.
- Auth parity — 401 without header, 401 wrong creds, 200 correct creds.

**Per Track B phase:**

- Run `scripts/bench-reindex.ts` (once written) before and after each phase, compare deltas
- Boot time: log start-to-`initializeCodeIndex`-complete timestamp; expect monotonic improvement
- Memory: monitor RSS during reindex; expect <2GB for 4500-fn project on 4-worker pool

**End-to-end:**

- `MCP_TRANSPORT=stdio` mode still works (regression check: stdio path bypasses Fastify entirely)
- Graceful shutdown still CHECKPOINTs Kuzu (regression check: `lsof | grep fantom-graph` after `kill -SIGTERM`; WAL should be empty/small)
- Dashboard at `http://localhost:3848/dashboard/` continues to work without JS changes *(note: current port is 3847)*

---

## Out of Scope (this plan)

- NestJS port (separate decision after Track A completes; see prior conversation)
- Migration to a Bull/Redis-backed queue (current per-project `Map` locks are fine until multi-process scaling is needed)
- OpenAPI spec generation from routes (could add `@fastify/swagger` post-Phase 5)
- Replacing the dashboard's hand-written API client with a generated typed client (depends on OpenAPI)
- The MCP `/mcp` endpoint refactor — stays on Express

---

## Is It Worth It? (updated recommendation)

The picture has shifted materially since this doc was first written:

- **Track A (Fastify)** is the only large remaining lever, and it delivers **zero runtime/embedding benefit** — it's purely developer-velocity and AI-context-cost. But that benefit is the *most certain* thing here: every AI-assisted edit currently loads ~30k tokens against a **10,295-line / 171-route** router. If "structurally clean backend + cheaper AI edits" is the goal, this is the lowest-risk path. If raw indexing speed is the goal, Fastify does nothing for it.
- **Embedding throughput** — your stated concern — is already addressable **today** with no new code: configure a sidecar (the remote-embedding path and multi-sidecar fan-out are shipped). Track B Phase C is therefore obsolete.
- **Remaining real indexing wall-time levers** are **Phase A (boot hydration)** and **Phase B (parsing pool)**. Phase D (Kuzu batching) is already banked.
- The **3×/4×/10× numbers are projections, not measurements.** Measure the parse/embed/write split first (the harness exists) — if embedding dominates, lean on the sidecar; if parsing dominates, Phase B is worth it; if neither is large, skip the worker pools entirely.

**Bottom line (now measured):** the parse/embed/write split was measured on 2026-06-07 — **graph-write dominates at ~95%**, parsing is ~5%, embedding is already remote+parallel. This rewrites the priority list:

1. **★ Batch the reindex graph writes** (NEW, unplanned) — the only change targeting the measured 95%. Wire the existing UNWIND node-batcher + a batched-edge writer into `buildFromFiles` and fix the 913-unresolved-edge MATCH storm. Highest ROI by far; ~1 day.
2. **Track A (Fastify)** — highest-*confidence* benefit but **zero** runtime gain; pure maintainability / AI-context-cost on a 10,295-line / 171-route router.
3. ~~Phase B (parsing pool)~~ — optimizes the ~5% phase; **skip** unless graph writes are already batched and parsing later shows up.
4. ~~Phase C (embedding pool)~~ — moot; embedding is already remote + 3-way sidecar fanout.
5. **Phase A (boot hydration + Pino)** — independent, low-risk boot-time win; still worth it.

---

## NestJS Exit Ramp (future)

Once Track A lands, each feature plugin maps cleanly onto a NestJS module. Example port of the `code-projects` feature:

```ts
// NestJS version
@Controller('admin/code-projects')
@UseGuards(BasicAuthGuard)
export class CodeProjectsController {
  constructor(private svc: CodeProjectsService) {}

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateProjectDto) {
    return this.svc.create(dto);  // ProjectPathConflictError → 409 via global filter
  }
}
```

The service stays identical, the schema becomes a DTO with `class-validator` decorators, the try/catch moves into a global exception filter (one file, one time). Per-module port time: ~1–2 hours each.

Compare to porting from `routes.ts` directly: you have to detangle the 10k-line file and wire it into Nest at the same time. Per-module port from there: ~half a day each, with much higher chance of missing edge cases.

**Recommendation:** Take the Fastify step first. Even if you decide later not to go to NestJS at all, the Fastify state is strictly better than today's Express. It's the lowest-risk path to "structurally clean backend."

---

# Sidecar Registry, LLM-Augmented Search, Embeddings Sidecar — ✅ SHIPPED

> **This entire plan is implemented** (commit `1a71bf6` "embeddings: sidecar-routed pipeline with cross-encoder + LLM rerank", refined since). It is preserved here as an **as-built reference**, with per-item DONE markers. The implementation **exceeds** the original spec: it adds an OCR capability kind, a cross-encoder reranker stage, WS master-registration, per-project embedding overrides, and multi-sidecar parallel fan-out.
>
> **Key nuance:** in-process embedding remains the **default**; sidecar routing is **opt-in** (`*FromSidecar` flag / strict mode in `selectEmbeddingProvider`).

## Context

The Fantom MCP server originally ran everything in-process: HuggingFace transformer embeddings (bge-small-en 384d for code, jina-v2-base 768d for docs), LanceDB queries, and semantic search re-ranking via graph weights only. This plan added a path to delegate compute to remote machines, LLM-augmented relevance, and a registry of helper services. **All three are now live.**

1. ✅ **Advanced semantic search** — optional LLM re-rank / query rewrite using user-provided Groq, Anthropic Claude, or Google Gemini API keys, selectable per query or per server default.
2. ✅ **Sidecar integration** — the Sound Suite / court-lens-mcp sidecar pattern, ported so embeddings can move out-of-process onto a remote GPU machine while LanceDB stays local.
3. ✅ **IP-addressable sidecar registry** — backend CRUD for sidecar endpoints surfaced as a dashboard tab.

The outcome is a single layered abstraction (`SidecarRegistry` → typed providers `EmbeddingProvider` / `LLMProvider`) that keeps in-process behavior as the default and makes remote sidecars opt-in via config.

## Files (as-built)

**Backend:**

- ✅ `src/admin/types.ts:92-224` — `Sidecar`, `SidecarCapabilityKind` (`embedding|llm|reranker|ocr`), `SidecarCapabilityState`, `LLMProviderConfig`; `FantomSettings` extended with `sidecars[]`, `llmProviders`, `semanticSearch.{llmReranker,crossEncoderReranker}`.
- ✅ `src/sidecars/registry.ts` — `getSidecarForCapability`, `listSidecars`, `getSidecar`, `createSidecar`/`updateSidecar`/`deleteSidecar`, `pingSidecar`, `sidecarServiceUrl`, `mergeCapabilities`, in-memory cache backed by config JSON.
- ✅ `src/admin/routes.ts:10013-10289` — full sidecar CRUD + `/sidecars/:id/health`, `/status`, `/actions/:action`, `/register-as-master`; `GET/POST /settings/llm-providers` (masked keys via `maskKey()`, `.env` writes).
- ✅ `src/embedding/providers/embeddingProvider.ts` — `EmbeddingProvider` interface; `InProcessCodeProvider` / `InProcessDocsProvider` / `HttpSidecarProvider`; `selectEmbeddingProvider()` (in-process default), `selectEmbeddingProviderForProject()`, `selectAllEmbeddingProviders()` (multi-sidecar fan-out).
- ✅ `src/embedding/llmReranker.ts` — orchestrator; `callGroq` / `callAnthropic` / `callGemini` + sidecar routing.
- ✅ `src/embedding/{sidecarLlmClient,crossEncoderReranker,sidecarRerankerClient}.ts` — sidecar LLM + reranker clients (Cohere `/v1/rerank` + vLLM `/v1/score`).
- ✅ `src/embedding/semanticSearchService.ts:242-252` — cross-encoder then LLM rerank, each gated on `.enabled`, after graph enrichment.

**Dashboard:**

- ✅ `dashboard/src/lib/api.ts` — `Sidecar`, `SidecarCapabilityKind/State`, `LLMProvider*` types + `apiRequest` wrappers (`listSidecars`, `createSidecar`, `pingSidecar`, `getLLMProviders`, `saveLLMProviders`, …).
- ✅ `dashboard/src/app/config/page.tsx:43-57` — `sidecars` (🛰) and `llm-providers` (🤖) tabs; `SidecarsPanel.tsx`, `LLMProvidersPanel.tsx`.

## Reused existing patterns (as designed)

- ✅ Settings persistence via `updateSettings()` (merges, backs up, writes `config/fantomMcpServer-config.json`).
- ✅ OAuth-style secret writes to `.env` for `GROQ_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, masked in GET responses (`sk-****`).
- ✅ Health endpoint shape `{ id, status, lastHealthCheck, responseTimeMs }`.
- ✅ Admin auth — every route wraps `basicAuthWithUserStore`.
- ✅ Sidecar wire format matches the soundsuite sidecar (`/health`, `/api/embed`) so an unmodified court-lens sideCar can be pointed at Fantom.

## Schemas (as-built)

```ts
// src/admin/types.ts
export type SidecarCapabilityKind = 'embedding' | 'llm' | 'reranker' | 'ocr';

export interface SidecarCapabilityState {
  available: boolean;
  models: string[];
  loaded?: boolean;
  gpuPercent?: number;
  endpoint?: string;
  port?: number;
}

export interface Sidecar {
  id: string;
  name: string;
  host: string;          // IP or hostname
  port: number;
  protocol: 'http' | 'https';
  authToken?: string;    // optional Bearer
  enabled: boolean;
  capabilities: Partial<Record<SidecarCapabilityKind, SidecarCapabilityState>>;
  healthStatus?: 'healthy' | 'unhealthy' | 'unknown';
  responseTimeMs?: number;
  lastSeen?: string;
  lastHealthCheck?: string;
  activeRequests?: number;
}

export interface LLMProviderConfig {
  enabled: boolean;
  model?: string;
  // apiKey is NOT in this object — read from process.env at runtime
}

// FantomSettings (extended):
sidecars?: Sidecar[];
llmProviders?: {
  defaultProvider?: 'groq' | 'anthropic' | 'gemini';
  groq?: LLMProviderConfig;
  anthropic?: LLMProviderConfig;
  gemini?: LLMProviderConfig;
};
semanticSearch?: {
  llmReranker?: { enabled: boolean; provider?: 'groq' | 'anthropic' | 'gemini'; model?: string; topK?: number; fromSidecar?: boolean };
  crossEncoderReranker?: { enabled: boolean; model?: string; topK?: number };
};
```

## Admin endpoints (as-built)

| Method | Path                                  | Status | Purpose                                            |
| ------ | ------------------------------------- | ------ | -------------------------------------------------- |
| GET    | /admin/sidecars                       | ✅ | list (filter by `?capability=`, `?enabled=`), adds `wsConnected` |
| POST   | /admin/sidecars                       | ✅ | create                                             |
| PUT    | /admin/sidecars/:id                   | ✅ | partial update                                     |
| DELETE | /admin/sidecars/:id                   | ✅ | remove                                             |
| POST   | /admin/sidecars/:id/health            | ✅ | ping `/health`, persist result                     |
| GET    | /admin/sidecars/:id/status            | ✅ | live container snapshot (WS heartbeat / HTTP fallback) |
| POST   | /admin/sidecars/:id/actions/:action   | ✅ | start/stop/acquire/release/pull/pull-and-load      |
| POST   | /admin/sidecars/:id/register-as-master | ✅ | register Fantom as master (WS)                    |
| GET    | /admin/sidecars/models                | ✅ | available models for a capability kind             |
| GET    | /admin/settings/llm-providers         | ✅ | masked keys + enabled flags                        |
| POST   | /admin/settings/llm-providers         | ✅ | write keys to `.env`, non-secret to JSON           |

## Resolution flow at call time (as-built)

```
SemanticSearchService.search()
├─ embeddingProvider.embed(query)
│    └─ selectEmbeddingProvider('code')        // in-process default; HttpSidecarProvider if codeFromSidecar / sidecar advertises model
├─ vector retrieval (LanceDB, local)
├─ graph enrichment / sort
├─ crossEncoderRerank(query, ordered)          // if semanticSearch.crossEncoderReranker.enabled  (sidecar)
└─ llmRerank(query, ordered)                   // if semanticSearch.llmReranker.enabled           (groq/anthropic/gemini or sidecar)
```
