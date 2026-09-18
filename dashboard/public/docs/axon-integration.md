# Axon Integration

Fantom MCP can attach the **Axon MCP server** (the SkySpark/Axon assistant that syncs
customer project functions into `proj/<instance>/<project>/func`) as a second data source:

- it connects to the Axon server as an MCP **client** and proxies its tools,
- it **embeds every synced Axon function** through the same sidecar fleet and the same
  Code Search model as Fantom code, into a separate LanceDB table `axon_vectors`,
- it exposes search in the dashboard (Vector Search → source *Axon*) and as MCP tools.

## Two sources

| source | where | project id | notes |
|--------|-------|-----------|-------|
| `proj` | `<projectPath>/proj/<instance>/<project>/func/*.trio\|*.axon` | `<instance>/<project>` | synced by the Axon MCP server; trio metadata, `.sync-metadata.json` callees/return types |
| `library` | `<libraryPath>/<folder>/**/*.axon` + multi-record `*.trio` backups | `library/<folder>` | offline library of former projects; name = file name (or trio `name:`), doc = leading `/* … */` or `//` comment, sub-folders become `folder:<x>` tags; same-named files in different sub-folders stay distinct; trio records that duplicate an `.axon` file are skipped |

Both sources land in the same `axon_vectors` table (`source` column) and share the model, the
text layout and the status/jobs machinery. Search (`/admin/axon/search`, `axonSearch`, the RLM
`axon_search` tool) takes `source: 'proj' | 'library' | 'all'` (default all) and results carry
`source`; the Explorer shows a proj/library badge and a source filter.

## Settings (`Settings → axon`, or Dashboard → Axon)

| key | default | meaning |
|-----|---------|---------|
| `projectPath` | _(unset)_ | Root of the Axon server checkout. Everything (proj folder, spawn cwd) derives from it. Set it here or via `AXON_PROJECT_PATH`. |
| `libraryPath` | _(unset)_ | Offline Axon library root (one folder per former project). Set it here or via `AXON_LIBRARY_PATH`. |
| `enabled` | `true` | Internal MCP client (lazy connect on first use) for callers/callees enrichment; indexing and search never depend on it. No dashboard controls — the Axon page shows one read-only "Axon server: reachable/unreachable" line. |
| `transport` | `http` | `http` connects to `url` (a running Axon daemon); `stdio` spawns `command args` with cwd = projectPath. JSON-only settings. |
| `command` / `args` | `node --max-old-space-size=4096 dist/index.js` | stdio launch line. |
| `url` | `http://localhost:3847/mcp` | StreamableHTTP endpoint (http transport). |
| `autoIndex` | `false` | Start an index job at boot once a sidecar advertises the code model. |

**Transport choice.** `http` reuses an already-running Axon daemon (`npm run start:http` in the
Axon checkout, default `http://localhost:3847/mcp`) and answers instantly. `stdio` spawns a fresh
Axon instance with cwd = projectPath: it needs the 8 GB heap from the Axon `npm start` line and
spends several minutes discovering SkySpark instances before tool calls answer. Fantom spawns it
with `DOTENV_CONFIG_QUIET=true` because the Axon server's dotenv banner would otherwise corrupt the
stdio JSON-RPC stream.

**There is no Axon embedding-model setting.** Axon vectors always use
`semanticSearch.codeModel` / `codeDimensions` (the *Code Search* picker on the Settings page —
today `qwen3-embedding:4b`, 2560d). If you change the code model, the Axon page shows a
*dims mismatch* warning and search fails until you run **re-index (force)**. A populated
table is never dropped automatically.

## Embedding text model (v1)

Every Axon function is embedded from a fixed text layout (`src/axon/axonEmbeddingText.ts`,
`AXON_EMBED_TEXT_VERSION = 1`), aligned with Fantom's code layout v3:

```
kind: axon-function
project: myProj | instance: myInstance | file: my instance my proj kpi kwh delta prev year | tags: ruleOn:site, kpiRule
myInstance myProj kpiKwhDeltaPrevYear
kpiKwhDeltaPrevYear(site, dates) => Grid
context: calls: foldCol, energyBaselinePrevYear, as; called by: …
doc: kWh Δ Prev Year (kWh/°daysF) …
(site, dates) => do
  …body, comment-only lines stripped…
end
```

- Signature: parameter names and **defaults** from the lambda header (`(ahu, dates, tolerance: null)`
  → `tolerance = null`; Axon has no declared types), return type from `.sync-metadata.json`.
- Doc: `dis`, `doc`, `help` trio tags + the sync description, cleaned, ≤ 800 chars.
- Context: callees from the sync metadata; callers = the inverse within the project.
- Long bodies → overlapping 40-line windows (10-line overlap), one vector row per chunk
  (`row_id = <fn>#<i>`); search dedupes to the best chunk per function.
- Columns stored per row: signature, params (JSON), return_type, tags, doc, line_start/end,
  chunk_index/count, embed_text_version, model, dimensions — so results and the RLM tool show
  the signature without re-reading files.

The Axon page's function drawer shows the exact rendered text for any function.

## Dashboard

- **Axon** page: connection status, config form with *validate path*, model in use, per-project
  table (functions / vectors / coverage / last run) with **embed** / **re-index**, **embed all**,
  jobs strip, and a per-function drawer (embedded ✔/✖ + embedding text).
- **Vector Search** page: source selector *Fantom code | Axon* and modes *Vector only*,
  *Vector + Reranker* (sidecar cross-encoder, top 50), *Vector + RLM* (top hits seed the RLM
  gather loop with `axon_search` / `axon_function` tools; returns a drafted answer + citations).
- Home page: compact `$ axon --status` card.

## Admin API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/axon/status` | settings, MCP client state, model/dims, table stats, totals, active job |
| GET | `/admin/axon/validate?path=` | inspect a candidate projectPath (projects, function counts, problems) |
| GET | `/admin/axon/projects` | per-project embedding status |
| GET | `/admin/axon/projects/:instance/:project/functions?page&pageSize&q` | function list with `embedded` flag |
| POST | `/admin/axon/index` `{projectId?, force?}` | start an index job |
| GET | `/admin/axon/jobs` · POST `/admin/axon/jobs/:id/cancel` | jobs |
| POST | `/admin/axon/search` `{query, projectId?, mode, limit}` | vector / rerank / rlm search |
| POST | `/admin/axon/connect` · `/disconnect` · GET `/tools` · POST `/tool` | MCP client control and proxy |
| GET | `/admin/axon/sample-text?projectId&name` | rendered embedding text (debug) |

## MCP tools

- `axonSearch {query, projectId?, mode?, limit?}` — local `axon_vectors` search; falls back to the
  Axon server's `semanticCodeSearch` when the table is empty.
- `axonFunction {name, projectId?, includeSource?}` — signature, params, doc, tags, source, callees,
  in-project callers, plus `getCallers` from the Axon server when connected.

## Heavy-job lock

Axon indexing, the code re-embed job and forced code reindexes share one exclusive lock
(`GET /admin/embeddings/heavy-job`). A re-embed or forced reindex started while another heavy job
runs answers **409** with the holder; an Axon index job **queues** (`status: queued`, "waiting for
…") and starts automatically when the lock frees. The auto-embed watchdog stands down while any
heavy job holds the lock. The Embedding Activity console shows the holder as a `lock:` badge; the
Axon page shows "indexing paused: … running" while a code job holds it.

## Status files

- `.cache/axon-embedding-meta.json` — per project: functionsFound, vectorsWritten, rowsWritten,
  model, dimensions, embedTextVersion, lastRun, errors, per-function hashes.
- `.cache/fantomvector.db/axon_vectors` — the LanceDB table.

Nothing from `proj/` is copied into this repository; only derived vectors and metadata live
under `.cache/`.
