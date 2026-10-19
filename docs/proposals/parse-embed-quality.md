# Parse and embed quality audit

Status: draft (2026-10-15). Read-only audit: no code changed, no admin API calls, no jobs.
Evidence: source reads, `sqlite3 .cache/fantom.db`, `/tmp/fantom-mcp-dev.log` (17,798 lines).

Related proposals (not repeated here):
- [lazy-incremental-indexing.md](lazy-incremental-indexing.md): `index_version` for the file-hash gate (item 5).
- [ast-viewer-revamp.md](ast-viewer-revamp.md): the viewer UI (item 6 is about which extractor it calls).
- [code-history.md](code-history.md)

## Ranking (impact x effort)

| # | Item | Impact | Effort |
|---|------|--------|--------|
| 1 | Contextual retrieval is silently off: every context call fails (400) | High | S |
| 2 | Language detection runs only on admin reindex; MCP add/refresh, boot auto-cache, watcher skip it | High | S |
| 3 | Fantom-tagged projects parse `.js`/`.css` with regex: 893/1325 `.js` files have 0 symbols | High | M |
| 4 | Deferred embeds: retry loop wastes a full context pass per try; lag not measurable (no timestamps) | Med | S |
| 5 | File-hash gate skips files after a parser change | Med | M (see lazy-indexing) |
| 6 | Two TS extractors; AST viewer and `/tree-sitter/*` show a different extractor than the indexer | Med | M |
| 7 | Function `qualifiedName` is not file-scoped: cross-file collisions in vectors and call resolution | Med | S |
| 8 | `index_runs.error_message` is never written; parse errors invisible | Med | S |
| 9 | Vue: template-only components and component identity lost | Med | S |
| 10 | Markdown sections embedded as kind `field`, doc text capped at 800 chars | Low-Med | S |
| 11 | Extraction gaps: `export default defineConfig({...})`, Python decorators, Go receivers, Rust `impl` | Low-Med | M |
| 12 | Three copies of language detection | Low | S |

## Findings

### 1. Contextual retrieval silently off (High / S)

`embedContextualizer.ts:189-190` sends every per-file context request through
`openRouterChat(..., { role: 'rlm-sandbox' })`. The routed model is
`direct:gemini:gemini-3.8-flash`, and OpenRouter rejects it:

```
[WARN:embed-context] project 375 session.ts: every sidecar refused the chat call — Alpers-Mac-mini.local:
OpenRouter /chat/completions failed: 400 {"error":{"message":"direct:gemini:gemini-3.8-flash is not …
[INFO:embed-context] project 375: 0 context(s) written, 0 cached, 2574 without, 227 request(s) over 159 file(s), $0.0000, 32.3s
```
(log lines 6059, 7162, 13159: three runs, 0 contexts each.)

A `direct:` id (openRouterModels.ts:302) means "call the provider API directly"; the
contextualizer passes it to the OpenRouter endpoint instead. Every node embeds without
context, yet the run reports success.

Fix: resolve `direct:<provider>:<model>` through the same direct-provider path
`answerSynthesis`/`rlmToolLoop` use (commit f06637a), or pick a non-direct model for this
role. Fail fast after N consecutive 400s on the same model (one bad id cost 227 requests,
~32 s per run). Surface `contexts written / without` in the embed job status, and warn when
`written == 0`.

### 2. Language detection only on admin reindex (High / S)

`syncProjectLanguage` (`src/admin/routes.ts:354`) runs on the admin reindex routes only
(`routes.ts:3842, 5098, 5133, 5174`). Other entry points:

- MCP `addFantomProject` (`src/index.ts:5265-5296`): `language || 'fantom'`, no detection,
  path stored raw (no `~` expansion). A TS repo added without `language` becomes fantom/regex.
- `createProject` (`src/fantom/database.ts:703`): stores `input.path` as given; the path
  conflict check compares raw strings, so `~/x` and `/Users/…/x` register twice.
- Boot pod auto-cache (`src/index.ts:1325-1341`): own `detectPrimaryLanguage(pod.path)` on an
  unexpanded path. A `~/` pod path scans nothing → fantom/regex. This is the original bug.
- `migrateProjectPaths` (`database.ts:1410`) fixes `~` paths at boot only, after the language
  was already wrong; it does not re-detect.
- MCP `refreshFantomProject`, watcher, and `autoIndex` paths call the indexer without
  `syncProjectLanguage`. The runtime guard (`codeIndexingService.ts:205-233`) only promotes
  regex→tree-sitter for a non-fantom language; a TS project tagged `fantom` stays wrong.

Evidence it happens: log line 3946,
`Project 375 (Quickbook MCP Server) language fantom/regex → typescript/tree-sitter-wasm (re-detected from files)`.

Fix: move `normalizePath` + `detectProjectLanguage` + `syncProjectLanguage` out of
`routes.ts` into `src/projects/projectLanguage.ts`. Expand `~` inside `createProject` (and
`updateProject`) so no caller can store it. Call `syncProjectLanguage` at the top of
`runIndex` (`src/fantom-code/runIndex.ts:69`), which every trigger shares. In
`addFantomProject`, detect when `language` is omitted.

### 3. Fantom projects parse `.js`/`.css` with regex (High / M)

`indexed_files` by extension (files / files with 0 symbols):

| ext | files | 0 symbols |
|-----|-------|-----------|
| js | 1325 | 893 |
| css | 172 | 172 |
| trio | 202 | 157 |
| cs | 1056 | 204 |
| php | 93 | 58 |
| scss / html / json | 27 | 27 |

Most empty `.js` are Fantom runtime files in fantom-language projects, e.g.
`fantom-1.0.83/src/sys/js/fan/Uri.js` (41 KB, 0 symbols); projects 57/90/260/300
(`fantom.1.0.8x.sys`) have 90/165 empty `.js`. Language is per project; a fantom/regex
project runs every file through the Fantom regex. The tree-sitter path already routes per
extension (`treeSitterAdapter.ts:376-380`), but only when `useTreeSitter` is on.

Fix: route per file, not per project: `.fan` → Fantom parser, anything with a loaded grammar
→ tree-sitter adapter, else skip (and do not count as parsed). `trio` empties: check
`trioParser.ts` against `.trio` files that hold only non-func records (likely fine, but
157/202 needs a spot check). CSS/SCSS/HTML/JSON giving 0 symbols is expected; exclude them from
"parsed" counts so coverage is honest.

### 4. Deferred embeds and the watchdog (Med / S)

Checker body: `routes.ts:10303-10350` (`registerEmbedMissingChecker`); tick:
`autoPipelineBus.ts:399` (`tickEmbedMissingWatchdog`, 60 s interval, 2 consecutive hits,
5-min gap `EMBED_MISSING_GAP_MS`). Routes: `POST /admin/vectors/build-missing` and
`/vectors/build-missing/:projectId` (`routes.ts:10469, 10423`). The checker reports
`hasMissing:false` while `getHeavyJob()` or a shadow re-embed is active, then counts
graph nodes vs vectors per project (skipping failure-backoff projects).

It does pick them up. Project 375 timeline (log line numbers):
- 3183, 3464, 4266: `embeddings for project 375 deferred — heavy job axon-index (all) owns the fleet`
- 6062, 7165: embed loop starts, runs the full context pass (~30 s, item 1), then
  `aborting at batch 1/52|60 — heavy job axon-index (all) owns the fleet`
- 9092: `Boot embedding pipeline yielding to axon-index (all) — 117 project(s) left`
- 13593-13784: batches 41-60/60 finish; vectors land.

Problems:
- The heavy-job check runs after contextualisation, so each failed try burns a context pass.
  Check `getHeavyJob()` before `contextualize`.
- `axon-index (all)` restarted at least 5 times (jobs 94e83c78, 1798c805, 17f2d97c, 48652278,
  845605cb). Each restart re-blocks code embedding (see memory note on axon autoIndex re-running
  on tsx reload).
- The log has no timestamps, so the lag is not measurable. Minimum lag by design is
  2 ticks + heavy job duration, up to +5 min after a prior trigger. Add ISO timestamps to the
  dev logger, and record `deferredAt` per project so the watchdog can report the real lag.
- Consider a "heavy job finished" event that fires the starter at once instead of waiting for
  two 60 s ticks.

### 5. File-hash gate after a parser change (Med / M)

The `indexed_files` mtime+sha256 gate skips unchanged files, so parser fixes (items 3, 9, 11)
never reach existing files. `syncProjectLanguage` works around it by deleting the project's
`indexed_files` rows (`routes.ts:372-374`). Covered by `index_version` in
[lazy-incremental-indexing.md](lazy-incremental-indexing.md). Add: bump the version on any
change to `treeSitterAdapter.ts` / `languageRegistry.ts` mappings / `embeddingText.ts` layout.

### 6. Two TS extractors (Med / M)

- Indexer: `src/fantom-code/treeSitterAdapter.ts` (1234 lines; `extractFunction`, named
  callbacks, test blocks, markdown, Vue).
- `ASTExtractor` (`src/parser/treeSitter/astExtractor.ts`, 1044 lines) is used only by
  `TreeSitterParser` (`treeSitterParser.ts:20,49`), reached through `getTreeSitterParser()` at
  `routes.ts:6363, 6630, 11041, 11117, 11172` (`/tree-sitter/ast`, `/tree-sitter/parse`,
  `/tree-sitter/extract-functions`, AST viewer).

So the AST viewer and the extract-functions debug route show what the indexer does NOT
produce (no callbacks, no test blocks, no markdown, no anonymous-callback filter). Bugs
fixed in one do not reach the other.

Fix: make `/tree-sitter/extract-functions` and the viewer call the adapter's
`parseFile`; keep `TreeSitterParser` only for raw tree / grammar listing; delete
`ASTExtractor`'s symbol extraction. Pair with [ast-viewer-revamp.md](ast-viewer-revamp.md).

### 7. Function qualifiedName collisions (Med / S)

`buildQualifiedName` (`treeSitterAdapter.ts:873-875`) returns `pod::name`. Types get a
file-scoped name (comment at 877-881), functions do not. Node ids stay unique
(`generateFunctionId` hashes `filePath:qualifiedName:line`, `types.ts:275`), but
`qualified_name` in LanceDB (`vectorStore.ts:279`) and name-based call resolution see many
`pod::index`, `pod::setup`, `pod::it: renders` from different files. Name lookups
(`getFantomFunction`, callers by name) return an arbitrary one; callee resolution picks by
language tie-break (`codeIndexingService.ts:1578-1583`).

Fix: for non-Fantom languages, qualify functions as `pod::<relpath>::<Class>.<name>`
(class when nested). Keep `name` short for display. Prefer same-file, then imported-file
candidates when resolving calls (imports are already extracted). Needs item 5 to roll out.

Not measured: top unresolved call references (needs a graph query; the per-project LadybugDB
files were not opened to avoid locking a live store). Suggested query once safe:
`MATCH (n:CodeNode)-[e:CodeEdge {edge_type:'calls'}]->(t) WHERE t.unresolved RETURN t.name, count(*) ORDER BY 2 DESC LIMIT 30`
(adjust to the real unresolved-target schema).

### 8. index_runs never records errors (Med / S)

```
language | runs | with error_message | files_parsed | files_skipped
fantom   | 1316 | 0 | 24137 | 20923
typescript | 55 | 0 | 13853 | 3368
vue      |   42 | 0 |  1077 |  7525
trio     |   60 | 0 |    25 |   275
php      |    7 | 0 |    93 |   372
```

No run has ever stored an error. Cause: the full-index path's final update
(`codeIndexingService.ts:875-886`) never sets `errorMessage`; only the incremental path
(`codeIndexingService.ts:1222`) does, and it keeps `severity === 'error'` only. Tree-sitter
syntax errors arrive as `type: 'syntax'` → `'error'` (`treeSitterAdapter.ts:907`), so they
are lost on full runs. The log has 0 `parse error` / `Failed to parse` lines. Parse error
rates per language are therefore not knowable today.

Fix: add `files_with_errors` and `error_nodes` (count of tree-sitter `ERROR`/`MISSING`
nodes) to `index_runs`, and `parse_errors` to `indexed_files`. Show them per language on the
dashboard. This also tells which grammars extract poorly.

### 9. Vue gaps (Med / S)

`parseVueFile` (`treeSitterAdapter.ts:299-345`) parses `<script>` and `<style>` only:
- A template-only component yields no symbol (4 of 62 `.vue` files have 0 symbols).
- No component symbol for the file itself (name from filename or `defineOptions({name})`),
  so "where is `<LinesTable>` used" has no target. Template tags are not turned into `uses`
  edges.
- `<script setup>` + `<script>` both parse, fine; `lang="tsx"` falls to javascript.

Fix: emit one `class`-kind node per `.vue` file named after the file; scan the template for
PascalCase/kebab tags and emit `calls`/`uses` edges to matching components.

### 10. Markdown section embedding (Low-Med / S)

`parseMarkdownFile` (`treeSitterAdapter.ts:1094-1145`) stores sections as `type: 'field'`
tagged `markdown, docs`, `documentation = sectionText.slice(0, 800)`. In
`embeddingText.ts:252` `field` maps to kind label `field`, so a doc section embeds as
"field <Heading>" with code-shaped header (imports, signature `## Heading`). v3 chunking
(`CHUNK_LINES = 40`, `CHUNK_OVERLAP = 10`, `embeddingText.ts:210-211`) reads the real line
span, so long sections are chunked, but the 800-char `documentation` is also prepended to
every chunk (`DOC_MAX_CHARS_V3`), duplicating text.

Fix: add a `section` node type with kind label `doc`; for it skip imports/signature/graph
context, put the heading path (`Setup > OAuth > Tokens`) on line 1 and the body below; do
not repeat `documentation` when it equals the body. Chunk on paragraph boundaries, not fixed
40 lines. Synthetic callback symbols (`computed`, `it: …`) embed like functions; add the
callee (`computed`, `describe`) to the header so "test for X" queries match.

### 11. Other extraction gaps (Low-Med / M)

- `export default defineConfig({...})` / `export default {...}`: no function node, so config
  files have no symbol. Emit one `field` node `default` (or file name) for an exported object.
- React: `const C = () => <jsx/>` is captured via `variable_declarator`; `memo(() => …)` and
  `forwardRef(...)` are caught only if the callback-name path matches (`treeSitterAdapter.ts:642-660`
  handles `call.parent.type === 'variable_declarator'`, so yes); `export default function()`
  with no name is dropped.
- Python: `decorated_definition` is not referenced anywhere; the inner `function_definition` is
  found, but its decorators (`@app.route`, `@pytest.fixture`) and start line are lost.
- Go: `method_declaration` is mapped (`languageRegistry.ts:98`) but the receiver type is not
  used for the qualified name, so `(*Server).Start` and `(*Client).Start` collide (item 7).
- Rust: `function_item` mapped (`languageRegistry.ts:112`); methods inside `impl_item` are not
  qualified with the impl type.
- `test.each`/`describe.each(...)(name, fn)`: callee is a call, not a member; the title lookup
  fails and the block is unnamed.

### 12. Three copies of language detection (Low / S)

`detectProjectLanguage` (`routes.ts:326`), `detectPrimaryLanguage` (`index.ts:~1300-1330`),
and `addFantomProject`'s default. They already disagree (routes ignores json/yaml/markdown;
index.ts counts raw extensions). Folding into one module is part of item 2.
