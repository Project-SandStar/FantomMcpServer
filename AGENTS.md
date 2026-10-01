# AGENTS.md — FantomMcpServer reference

Agent-agnostic project reference for `mcpfantom`. Claude Code loads `CLAUDE.md` (the short,
per-session file) and reads this one only on demand; other agents (Codex, Cursor, …) read this
file directly. Keep the two consistent: rules live in `CLAUDE.md`, reference lives here. Both
files ship in the public release tree — never put internal hostnames or addresses in them.

## What it is

A Model Context Protocol server that gives AI assistants a working knowledge of a Fantom /
Haxall / SkySpark codebase: it indexes Fantom source and Axon functions, embeds them for
semantic search, builds a call graph in an embedded graph database, tracks how symbols changed
between index runs, crawls fantom.org / haxall.io docs, generates Fantom code, and automates the
SkySpark 3.x → 4.0 migration. A Next.js dashboard runs and watches indexing. Everything works
offline except cloud embedding/LLM providers the operator opts into.

## Commands

```bash
npm install                        # also runs prisma generate (postinstall)
npm run build                      # tsc → build/, then scripts/copy-workflows.cjs
npm run dev                        # stdio transport via tsx (single client)
npm run dev:http | dev:http:debug  # http transport, tsx --watch (--inspect)
npm run start:dev | stop:dev | restart:dev   # scripts/start-dev.sh etc. — the :3848 dev instance
npm start | start:http             # compiled build (stdio / http)
npm run stop | status              # scripts/stop-server.sh / status-server.sh (production daemon)
npm run daemon:start|stop|restart|logs       # PM2 (production only, never on :3848)
npm run dashboard:install | dashboard:dev | dashboard:build
npm test | npx jest <path>         # Jest; MUST run via npm test (ESM flag) — see Testing
npm run test:search | test:cache | test:core # smoke scripts in test/smoke
npm run db:generate | db:setup | db:studio   # prisma generate / migrate deploy / studio
npm run grammars:download          # fetch tree-sitter wasm grammars
npm run clean                      # rm -rf build .cache  ⚠ deletes every index
scripts/release-public.sh <ver> [--publish]  # public snapshot release (see Releasing)
```

## Architecture

### Stack

Node.js 20+, TypeScript (ESM, `import.meta`), `@modelcontextprotocol/sdk`, Express for the
HTTP transport and admin API · Prisma + SQLite for metadata (`.cache/fantom.db`) · LadybugDB
(Kuzu) for the code graph · LanceDB for vectors · FlexSearch for crawled docs · tree-sitter
grammars (`assets/grammars/*.wasm`, sources in `tree-sitter-{fantom,axon,xeto,trio}/`) ·
`@huggingface/transformers` for local embedding · Next.js dashboard in `dashboard/`.

### Entry point and transports

`src/index.ts` builds the MCP server and registers every tool. `MCP_TRANSPORT` selects:

- `stdio` (default) — single client, used by Claude Desktop / CLI.
- `http` — StreamableHTTP on `MCP_PORT` (default 3847; the dev instance uses 3848 from
  `config/fantomMcpServer-config.json`). One isolated `Server` per session, session id in the
  `mcp-session-id` header. Endpoints: `GET /health`, `POST|GET|DELETE /mcp`, `/admin/*`
  (Basic Auth), `/dashboard/*` (static export from `dashboard/out/`), OAuth endpoints from
  `src/auth/`.

The server initializes lazily in the background; tool handlers wait for initialization.

### Source modules

| Directory | Role |
|-----------|------|
| `src/fantom-code/` | Fantom/Axon source parser. Generates 16-char MD5 ids via `generateFunctionId` / `generateTypeId` in `types.ts`; every other store must reuse these ids. |
| `src/fantom-parser/`, `src/parser/` | Documentation parsers: `FantomDocsParser` (fantom.org), `SmartDocsParser` (haxall.io, lazy per pod), tree-sitter wrappers in `parser/treeSitter/`. |
| `src/graph/` | LadybugDB graph: `ladybugGraphBuilder.ts`, `projectGraphConnection.ts` (per-project pool), `ladybugQueryManager.ts`, `graphQueryDSL.ts`, `graphToolHandlers.ts`, community detection, change detection, staleness checks. |
| `src/embedding/` | Embedding pipeline and search: `embeddingService.ts`, `vectorStore.ts` (code), `docsVectorStore.ts` (docs), `lanceConnection.ts` (tables + ANN index), `hybridSearch.ts`, `semanticSearchService.ts`, rerankers (`crossEncoderReranker.ts`, `llmReranker.ts`, `rerankRouter.ts`), RLM Q&A (`rlmToolLoop.ts`, `rlmGatherPlan.ts`, `answerSynthesis.ts`), `autoPipelineBus.ts`, `providers/`. |
| `src/axon/` | Axon MCP client, Axon indexing, cloud-policy-aware provider selection. |
| `src/sidecars/` | Remote inference sidecars: `soundsuiteMaster.ts` (WebSocket master), `registry.ts`, `routingPolicy.ts`, `virtualContainers.ts`, `virtualInferenceClient.ts`, OpenRouter config/models/chat/activity. |
| `src/search/` | FlexSearch document index for crawled docs. |
| `src/cache/` | `CacheManager` — persists parsed docs to `.cache/flexsearch-fantom.json`. |
| `src/migration/` | `SkySpark4xMigrator` — tags a git backup, transforms, commit/rollback. |
| `src/tools/` | Fantom code generation (`generateFantom.ts`). |
| `src/admin/` | Express admin router (`routes.ts`, ~190 endpoints, very large — read with offset/limit) and `types.ts`. |
| `src/auth/` | OAuth provider for the HTTP transport. |
| `src/agents/` | In-process agents (analytics, code analysis, code generation, docs, graph analysis, orchestration, project management) built on `agents/base`. |
| `src/config/` | Config loading. `atomicWriteConfigFile` / `readConfigFileWithRecovery` are the only sanctioned way to touch `config/fantomMcpServer-config.json`. |
| `src/db/` | Prisma client singleton. |
| `src/usage/` | SQLite usage analytics (`.cache/usage.db`). |
| `src/workflows/` | Loads `workflows/*.md` as MCP resources (`workflow://<name>`). |
| `src/backup/`, `src/utils/`, `src/types/` | Backups, helpers, shared interfaces (`FantomDocItem`, `SearchResult`, `FantomConfig`). |

### Index data flow

```
project path → fantom-code parser (.fan, Axon .trio/.axon via tree-sitter)
             → CodeNode/CodeEdge → LadybugDB .cache/graph/<projectId>.db
             → embed text (v3: statement-level chunks, comments kept, defcomp cells surfaced)
             → LanceDB code_vectors (+ ANN index)
             → IndexRun / ApiChange / EdgeChange rows in Prisma for history tools
```

- Graph and vector ids are the parser's MD5 ids; callers/callees only resolve when the graph
  builder reuses `typeDef.id` / `func.id` instead of minting new ones.
- Each project has its own graph database; a shared legacy db exists but is stale — always
  query through the per-project connection. Coverage denominators come from the per-project
  `count(CodeNode)`.
- Graph edge types: `calls`, `contains`, `extends`, `implements`, `overrides`, `returns`,
  `uses-css`, `imports`. Cross-project edges are stored in Prisma (`CrossProjectEdge`).
- The boot graph sync is memory-hungry; `FANTOM_GRAPH_MAX_OPEN` caps open graph handles and
  the vector ANN index is built out-of-process (`scripts/build-vector-index.mjs`).

### Storage

| Store | Location | Contents |
|-------|----------|----------|
| Prisma SQLite | `.cache/fantom.db` | `Instance`, `FantomBuild`, `Pod`, `CompileLog`, `FantomProject`, `ProjectDependency`, `IndexedFile`, `IndexRun`, `ApiChange`, `EdgeChange`, `CrossProjectEdge`, `Setting`, `DocIndex`, `ToolEvent`, `SearchEvent`, OAuth tables |
| LadybugDB | `.cache/graph/<projectId>.db` | `CodeNode`, `CodeEdge` (authoritative code graph) |
| LanceDB | `.cache/fantomvector.db/` | `code_vectors` (code, currently `qwen3-embedding:4b`, 2560d, embed text v3), `docs_vectors` (`Xenova/jina-embeddings-v2-base-en`, 768d), `axon_vectors` |
| FlexSearch | `.cache/flexsearch-fantom.json` | crawled fantom.org / haxall.io docs |
| Usage | `.cache/usage.db` | tool and search events |
| Runtime config | `config/fantomMcpServer-config.json` (gitignored) | port, primary project, settings, sidecar registry |

Model changes: `GET /admin/vectors/model-status` detects a stored-vs-configured mismatch;
`POST /admin/vectors/re-embed/:projectId` (0 = all) regenerates. A model switch needs a fresh
table via a full shadow re-embed; boot code must never drop a populated table.

### Embedding and inference providers

Local (`@huggingface/transformers`, model list in `src/embedding/modelManager.ts`), Ollama
(host-native on Macs; Ollama refuses `/api/embed` for GGUFs without a `pooling_type`, which the
server records as an embed capability fault), OpenRouter (cloud; the only "cloud-only" option
in the routing policy), and sidecar-served roles (embedding, reranker, completion) over the
WebSocket master in `src/sidecars/soundsuiteMaster.ts`. Query encoding retries across
providers (`FailoverQueryEncoder`) and only fails over on hard failures; no stage has a
hardcoded limit — every limit is a config safety net.

### askCodebase (RLM Q&A)

`askCodebase` / `POST /admin/vectors/ask` (`query`): resolve dependency scope
(`ProjectDependency`, capped), run the RLM plan/gather loop with a scope note, synthesize with
the configured LLM, promote RLM-found code to numbered citations. Budget defaults to 120 s
(configurable); the dashboard fast path is 20 s. MCP progress notifications are feedback, not a
keepalive — Claude Code has no tool timeout unless `.mcp.json` sets one.

Jev gate (`src/embedding/jevGates.ts`, client `providers/jevClient.ts`): when the caller gave
no `rlm` flag and TypeSafe is enabled (`llmProviders.typesafe`, key `TYPESAFE_API_KEY`), one
Jev request — Choice `direct | rlm` over the question, the top hits and the code-computed
`namedSymbolsFound`, plus a Noul "names an identifier" — decides whether the RLM loop runs.
`direct` at or above `semanticSearch.jev.minConfidence` (0.7) skips it. Advisory: no key,
timeout, HTTP error, malformed body or low confidence keep the default. The decision is in
the result as `jev`, in the ask feed, and in the log as `[jev] route=…`.

### Sidecars

A sidecar is a remote inference host that connects to the master over WebSocket, receives a
registry push, and serves roles. The master only terminates superseded sockets after a grace
period; the client-side close handler must never clobber a live socket. Registry entries are
persisted into the runtime config on heartbeat — through the atomic config writer.

Which roles a host runs is decided on the SoundSuite master's role assignments, not here;
Fantom's config push carries only OpenRouter models/modes. `src/sidecars/sidecarRoles.ts`
(`hostsForRole`) reads the roles each host reports (fresh WS heartbeat snapshot, else HTTP
`/api/status`) and orders hosts for a role; `resolveRlmEndpoint` and `openRouterChat`
(`role: 'rlm-sandbox'`) use it, so a host without the role is never asked to carry LLM work
and never disabled either. `openRouterChat` also sends `reasoning: {enabled: false}` — a
thinking model otherwise spends `max_tokens` on reasoning and returns `content: null`.

## MCP tools (by area)

- **Docs**: `searchFantomDocs`, `searchHaxallDocs`, `searchLocalDocs`, `getFantomType`,
  `listFantomPods`, `listLocalPods`, `listCompatiblePods`, `indexInstanceDocs`,
  `getLocalDocStatus`, `refreshIndex`.
- **Projects / index**: `addFantomProject`, `removeFantomProject`, `listFantomProjects`,
  `searchProjects`, `refreshFantomProject`, `reindexChangedFiles`, `clearProjectIndex`,
  `getIndexHealth`, `getFantomCodeStats`, `listIndexRuns`.
- **Code search**: `searchFantomCode`, `semanticCodeSearch`, `findSimilarCode`,
  `getFantomFunction`, `listFunctionsInFile`, `askCodebase`.
- **Version groups**: `listVersionGroups` lists the product/version lines
  (`haxall/4.0.6`, `skyspark/3.1.12`, `fantom/1.0.83`, `other`; derived from
  `instances.type/version` and `fantom.1.0.NN.*` names in
  `src/projects/versionGroup.ts`). `searchFantomCode`, `semanticCodeSearch`,
  `askCodebase`, `findSimilarCode`, `listFantomProjects`, `searchProjects` take
  `versionGroup` (`"haxall 4.0.6"`, `"skyspark 3.1"`, `"skyspark 3.1.1-3.1.12"`,
  `"haxall"`); with `projectId` the project must be inside the group and
  `askCodebase` keeps its dependency scope inside it. Admin:
  `GET /admin/projects/version-groups`; `POST /admin/vectors/search|ask` accept
  `versionGroup`; `/admin/vectors/stats` rows carry `group`.
- **Graph**: `getCallers`, `getCallees`, `getCodeImpact`, `getCodeNeighbors`.
- **History**: `whatChangedRecently`, `getSymbolHistory`, `explainSymbolChange`,
  `diffIndexRuns`, `diffByTime`, `compareSnapshots`, `getApiChangeHistory`,
  `searchVersionedApi`, `getActivitySummary`.
- **Axon**: `axonSearch`, `axonFunction` (plus the separate `axon-mcp` server in `src/axon/`).
- **Generation / migration**: `generateFantomCode`, `migrateSkySpark4x`, `commitMigration`,
  `rollbackMigration`.
- **Resources**: `workflow://<name>` for each file in `workflows/`.

## Admin API (selected)

All under `/admin`, Basic Auth from `config/admin.json` or `ADMIN_USER` / `ADMIN_PASS`.

| Endpoint | Purpose |
|----------|---------|
| `GET /status`, `GET /health` (root) | server status, memory |
| `GET /cache`, `POST /cache/clear`, `GET /ast-cache` | cache files |
| `GET /logs` | SSE log stream |
| `GET /usage`, `GET /usage/database`, `POST /usage/clear|reset` | analytics |
| `GET|POST /primary-project`, `GET|POST /code-projects` | project registry |
| `GET /indexing/status`, `GET /vectors/auto-pipeline/status`, `GET /vectors/auto-embed/state` | pipeline state |
| `GET /vectors/stats`, `GET /vectors/shadow`, `GET /vectors/model-status`, `GET /vectors/project/:id` | vector store |
| `POST /vectors/re-embed/:projectId`, `GET /vectors/re-embed/jobs[/:id]` | re-embedding jobs |
| `POST /vectors/ask`, `GET /vectors/ask/:askId/events` | RLM Q&A |
| `GET|DELETE /vectors/project-overrides[/:projectId]` | per-project embedding overrides |
| `GET /models/status`, `GET /sidecars/:id/status` | providers and sidecars |

The full list (~190 routes) is in `src/admin/routes.ts`.

## Configuration

- `fantom-config.json` — docs crawl and search defaults.
- `config/*.example.json` — templates; real `config/*.json` files are gitignored (credentials,
  sidecar registry). `config/admin.json` holds admin credentials (default `admin`/`admin`).
- `.env` (see `.env.example`): `FANTOM_CODE_PATH`, `DEBUG`, `CACHE_ENABLED`, `CACHE_TTL`,
  `DATABASE_URL` (relative to `prisma/schema.prisma`).

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_PORT` | `3847` | HTTP port (config file overrides; dev uses 3848) |
| `ADMIN_USER` / `ADMIN_PASS` | `admin` | admin API credentials |
| `CACHE_ENABLED` | `true` | docs cache |
| `FANTOM_GRAPH_MAX_OPEN` | — | cap on concurrently open graph databases |

## Testing

Jest + ts-jest in ESM mode, `testEnvironment: node`, suites in `src/__tests__/` and smoke
scripts in `test/smoke/`. Run through `npm test`, which sets
`NODE_OPTIONS=--experimental-vm-modules`; without it every suite that reaches
`src/config/index.ts` (`import.meta`) fails to compile and Jest reports "Test suite failed to
run" for 12 of 18 suites while the rest pass green. `tsx watch` plus auto-index means a save in
`src/axon/` can trigger a re-embed of every indexed Axon function — stop the dev server before
bulk edits there.

## ast-grep

`sgconfig.yml` registers `typescript`/`tsx`/`javascript` plus custom languages `fantom`
(`.fan`, `.fwt`), `axon`, `xeto`, `trio` from the in-repo grammars, with dylibs at
`~/.ast-grep/parsers/<lang>.dylib` (rebuild: `~/Code/ast-grep/build-parsers.sh`). A language
injection makes `-l axon` also search the `src:` block of Trio function records. Rules live in
`.ast-grep/rules`, tests in `.ast-grep/tests`. Fantom expression patterns need a
`context`/`selector` rule. Grammar caveats: `docs/AXON_GRAMMAR_FAILURES.md`,
`docs/XETO_GRAMMAR_FAILURES.md`, `docs/tree-sitter-coverage.md`.

## Database safety

`prisma migrate dev` and `migrate reset` can drop and recreate every table when they detect
drift. Back up `.cache/fantom.db` first, prefer `migrate deploy` or `db push`, and get explicit
operator confirmation before either destructive command. `skipDuplicates` does not work on
SQLite — dedupe in code and catch the unique-constraint error
(`code_edges(source_id, target_id, edge_type, line_number)`). `npm run clean` deletes the whole
`.cache/` including every graph and vector table.

## Releasing

Two remotes: `origin` (private, full history — contains credential material in old commits) and
`github` (`Project-SandStar/FantomMcpServer`, snapshot commits only). Never push `main` to
`github`. `scripts/release-public.sh <version>` audits the tree (dry run); `--publish` creates
an orphan branch, tag, zip and GitHub release. Bump the version in `package.json`,
`src/index.ts` and `src/axon/axonMcpClient.ts` first; the script refuses on a mismatch. The
script owns the internal-only path list (`docs/reports`, `docs/tasks`, the sidecar findings
doc, `fan/tokens.json`) and the forbidden patterns — extend those lists, never work around
them.

## Directories

```
src/            server (see Source modules)
dashboard/      Next.js admin dashboard; static export in dashboard/out/ served at /dashboard
scripts/        dev/prod server control, release, migrations, probes and smoke tests
workflows/      markdown MCP resources
specs/          design.md, requirements.md, ROADMAP.md, implementation plans
docs/           runbooks, grammar failure logs, reports (docs/tasks, docs/reports internal-only)
prisma/         schema + migrations (db itself lives in .cache/)
assets/grammars tree-sitter wasm grammars used by the indexer
tree-sitter-*/  grammar sources (fantom, axon, xeto, trio)
config/         runtime config (gitignored) and *.example.json templates
.cache/         all databases and caches (gitignored, regenerable)
```
