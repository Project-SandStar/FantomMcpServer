# Changelog

All notable changes to FantomMcpServer. Public releases are snapshots; see
`scripts/release-public.sh`.

## 1.1.9 — 2026-11-20

### Knowledge cards for AI coders
- **New MCP tools `getKnowledgeCard` and `listKnowledgeCards`.** A short,
  checked summary of a symbol (what it does, callers and callees from the code
  graph, claims with file:line) in one fast call, with no model call. Stale,
  flagged or low-confidence cards are never shown as fact. Each card lists the
  sha256 every source file had when it was built.
- **Claude plugin** tells the model about the new tools (skill table and
  session-start hint).
- **Cards on local models.** Writer, checker and answer can use the sidecar
  `ss-completion` (qwen3.5:9b), at no cost. Each call picks whichever host
  serves the model at that moment. Thinking is turned off for card calls.
- **Card builds retry the embedding step** on timeouts, 429 and 5xx (up to
  15 min) instead of failing the whole build.
- **Rebuild uses the saved writer** and replaces the old card, so no paid model
  is called by accident.
- **Knowledge Cards page.** Projects column lists every project ("not
  started" when it has no cards), status filters, select all, rebuild /
  delete / export selected, compare writers, ask preview. The page shows the
  saved writer and checker instead of a writer picker.

### Search
- **IVF_HNSW_SQ vector index** (recall@10 1.00, was 0.71) with a 4 GB index
  cache; English stemming and stop words in the keyword index; version copies
  of one symbol grouped in all-project searches; query-vector, rerank-score and
  whole-result caches; graph fetch batched per project.
- **Memory:** 24 GB container, guard 21.6 GB, `MALLOC_ARENA_MAX=2`; the
  dashboard Memory Usage card shows RSS against the guard.
- **Dashboard:** Graph settings tab, LadybugDB on the Storage tab, OpenRouter
  worker labels for embedding rows.

### Fantom calls OpenRouter itself
- **No sidecar hop.** Embeddings, rerank, answers, the RLM loop and the Test
  buttons go straight to OpenRouter with the key in Fantom's secrets store.
  The key never leaves the server, except to the ss-rlm-sandbox slot.
- **Worker pool.** One worker is one bulk request in flight (default 6, max
  8). Searches and asks have their own lane and never wait behind a re-embed.
  On a 429 the pool halves and ramps back. If the event loop lags over 100 ms
  it uses fewer workers. Big replies are parsed off the main thread.
- **Write buffer.** Vector writes hold at most 2000 rows per table and commit
  1000 at a time; the graph lookup runs outside the write slot.
- **Stored vectors stay valid.** Same model and provider pin. A new check
  re-embeds 10 stored rows and needs cosine 0.99 or more.
- **Decision model.** The OpenRouter page can pick Jev or Clef (via
  OpenRouter) for the routing gates. Default stays Jev.
- **OpenRouter page.** Shows workers, lag, write buffer, sandbox slots and
  Verify. The Re-push button, slot health box and budget box are gone.
- Sidecars only get Fantom's ss-rlm-sandbox slot (key, model, domain).

## 1.1.8 — 2026-11-19

### Installers for Haxall and SkySpark
- **Check & add Haxall.** The Instances page checks GitHub for Haxall
  releases. For each missing version it gets the source from the release
  tag, compiles `home/`, builds the docs and adds the instance.
- **Check & add SkySpark.** The page reads SkySpark zips from a file share
  set in the admin settings, installs the missing versions and runs
  `bin/fan docgen`. Docgen needs no license. 3.x needs `bin/setup` first,
  which runs only when the EULA setting is on.
- **Set home and Compile home.** Each instance can point to a new `home/`
  folder or rebuild it, with a live job log.
- **Installer sources.** Settings > Fantom Source holds the JDK path, a
  daily auto-check switch, and per product the source, paths and oldest
  version. The share password and GitHub token go to the secrets store.
- **Build script.** `scripts/haxall/` holds the Haxall build script with no
  personal paths. It no longer skips `docker.pod`.
- **Docker image.** Adds JDK 17, rsync, curl and unzip. Skips the
  onnxruntime-node CUDA download, which now returns 404.

### Dashboard
- **Instances page.** Compact cards, an "+ Add" menu, an actions menu, and
  docs and code counts (pods, functions, types) on each card.
- **Embed one instance.** The Docs and Instance Docs pages embed only the
  chosen instance, not all docs. The vector label no longer shows the count
  of every instance.

### Parsers
- **tree-sitter.** New Fantom, Axon and Trio grammars, tested on real
  code. `.fan` files go to the tree-sitter Fantom parser. The Docker image
  ships the grammars.
- **Indexing.** Each file goes to its parser by extension. The pod comes
  from the nearest `build.fan`.

### Search index and server
- **One pass per project.** Only one index pass runs per project at a time,
  and a re-sync covers only that project. New `remove` and `reindexFiles`
  tools.
- **Remote folders.** Client folders map to `/mirror` projects on the
  server.
- **Caddy.** `CADDY_EXTRA_PROXIES` adds more HTTPS ports on the same
  NetBird name.

## 1.1.7 — 2026-11-03

### OpenRouter page
- **Test per role.** The OpenRouter config page has a Test button per role
  and a Test all button. Each test goes down the same path the role uses for
  a real request and shows the provider's own error text.

### Provider errors
- **Failure kinds.** A provider is marked by the kind of failure, not only
  as out of credits. When an earlier provider already failed, a later plain
  failure is named too, with a short reason.

### Tests
- **Timeouts.** The suite-wide timeout is 30s. Suites that spawn git, a
  hook script or an HTTP server exceeded 5s in a full parallel run.

## 1.1.6 — 2026-11-03

### RLM runs again on mixed LAN and NetBird fleets
- **Master URL per sidecar host.** Each sidecar files this master under the
  address it saw the tunnel come from. A LAN host and a NetBird host hold
  different spellings, so sending one URL to every host was a 404 on the
  other host and the RLM loop never ran. The loop and the OpenRouter chat
  client now send each host its own recorded address.

### Ask path
- **Reverify after reconnect.** The ask path re-checks the provider after a
  sidecar reconnect and reads JSON responses safely. A provider quota error
  shows a popup in the dashboard.
- **Live key test per provider.** The LLM providers page tests each key
  against its own provider.

### Graph store
- **Memory budget.** Query threads are capped and buffer pools are sized by
  the memory budget. A LadybugDB WAL assertion is treated as on-disk
  corruption, so the store rebuilds instead of crashing in a loop.

### Deploy
- **Docker scripts.** `scripts/docker` is in git. Each stack's `<stack>-net`
  owns the network, so the app container can restart alone.

## 1.1.5 — 2026-10-31

### Workflows come from the server
- **New tools.** `listWorkflows({scope?, projectId?, query?})` lists the
  workflows the caller may see (global, instance, project, personal).
  `getWorkflow({name, section?, maxChars?})` returns one workflow, or one
  section, plus its headings. Same access rules as `workflow://` resources.
- **Plugin.** The `wf-*` skills no longer copy the workflow text. Each one
  tells Claude to call `getWorkflow` on the server, so dashboard edits and
  project workflows reach Claude. Hooks and the `fantom-mcp` skill say:
  never read local workflow files.

### No built-in server names
- **Axon GitLab library.** The GitLab URL and repository have no default.
  Set them on the Axon page, or with `AXON_GITLAB_URL` / `AXON_GITLAB_REPO`.
- **NetBird.** The management URL default is the NetBird cloud
  (`https://api.netbird.io:443`); `NETBIRD_MANAGEMENT_URL` changes it. The
  HTTPS domain has no default; `NETBIRD_HTTPS_DOMAIN` sets one. HTTPS needs a
  domain before you can turn it on. Saved settings are not changed.

## 1.1.3 — 2026-10-27

### Agents use Fantom MCP first
- **Server instructions.** Every MCP client gets short routing text at
  connect time: search the index before grep.
- **Plugin.** The session-start message shows the real index size and
  health. A new `search-hint` hook adds a one-line tip when grep, rg or
  find runs in a registered project.

### Call graph
- **Short names.** `getCallers` and `getCodeImpact` accept a short name
  (`balanceCheck`), not only the full qualified name.
- **Same-name functions.** Two functions with the same name in different
  files (e.g. `parse` in each statement parser) both stay in the graph.
  Before, the second was dropped with all its call links.
- **No false "degraded".** A CHECKPOINT with no WAL on disk is skipped,
  and its "Error renaming file <id>.db.wal" no longer marks the project
  degraded. It had blocked every edge write of a rebuild.

### Index counts and search
- **Whole-project counts.** An incremental run and `rebuild-graph` store
  the project's full function and type counts, not only the parsed
  files'. Files a run did not parse keep their per-file symbol counts.
- **Name search after a graph rebuild.** `rebuild-graph` reloads the
  in-memory index, so new and renamed symbols are searchable.
- **Health check.** `missingFromSearch` compares functions with
  functions; it counted every type as missing.

## 1.1.2 — 2026-10-19

### Claude Code plugin
- **Install from git.** `claudePlugin/dist` is committed and the repo root
  has a marketplace, so the plugin installs straight from this repository.
  It is also listed in the public Project Sandstar MCP marketplace
  (`Project-SandStar/project-sandstar-mcp-marketplace`) with `axon-mcp`.
- **Docs.** README: install steps. `docs/CLAUDE_PLUGIN.md`: setup, the
  mcp-proxy, how users update and how maintainers ship a change.

### Release
- **Stricter audit.** `scripts/release-public.sh` checks the whole
  overlay (CGNAT) address range and internal company hosts.
- `scripts/diag-sidecar-host.sh`: read-only WS tunnel report for a sidecar
  host; `MASTER` is required.

## 1.1.1 — 2026-10-18

### Claude Code plugin
- **`claudePlugin/`.** One install covers every registered project. Hooks
  report edits (`PostToolUse`), inject the current project's index state
  and tool routing at session start, and add a one-line tool hint per
  prompt. Skills: `fantom-mcp` (routing), `/fantom-mcp:doctor`, `status`,
  `ask`, `impact`, `add-project`, plus one `wf-*` skill per workflow file.
  CLI `dist/bin/fantom-mcp.mjs`: `setup`, `doctor`, `status`, `token`,
  `clean-legacy`, `disconnect`. `npm run plugin:{build,test,install}`.
- **`GET /admin/indexing/context?cwd=`** (hook token): the project for a
  directory, its index state and the registered roots.
- Usage tracker records the HTTP `mcp-session-id` per tool call.

### Lazy incremental indexing (phases 0 to 4)
- Durable task queue, git-triggered change detection, memory guard.
- Focus set and `reportChanges` tool; `POST /admin/indexing/report` with a
  per-install report token, no Basic Auth.
- Stable symbol keys without line numbers, embed cache, per-project rekey.
- File-level graph patch by key, `pending_refs`, vectors kept across a
  partial reindex.
- Incremental embedding (`vector_state`, `embedPatch`, vector GC, cache
  prune); incremental Axon embedding, boot only on change, named 409s.
- Parser/extractor version in the hash gate; every source language scanned;
  markdown heading sections, named callbacks and test blocks as symbols.

### Graph and server
- Per-project buffer pool sized from the store file (5 x MiB, 24 to 128);
  CHECKPOINT around edge builds; every project store closed on shutdown.
- AST viewer can delete one index run (history rows and its vectors).
- Workflows: dashboard editor and admin routes for the MCP workflow resources.
- Contextualizer: direct provider models use the provider's own API.

## 1.1.0 — 2026-10-01

### Retrieval quality
- **Contextual retrieval.** Every code chunk is embedded with a one-line
  LLM-written context (`EMBED_TEXT_VERSION 4`) that says where it sits and
  what it is for, so a search for a concept finds the function that
  implements it, not only the one that names it. Contexts are cached per
  project and reused across re-embeds; 20 nodes per request, one retry.
- **Model switch to `qwen/qwen3-embedding-8b` (4096d)** for code, docs and
  Axon vectors, pinned to one upstream provider. The 4B model's only host
  answered "model busy" under load; the 8B lane fans out across the
  configured sidecars and is checked for vector compatibility (cosine ≥ 0.99
  against a reference) before it may serve.
- **Version groups.** A project belongs to a product/version line
  (`haxall 4.0.6`, `skyspark 3.1`, a range such as `skyspark 3.1.1-3.1.12`);
  `searchFantomCode`, `semanticCodeSearch`, `askCodebase` and the dashboard
  take a `versionGroup` filter. The sidebar and the 3D graph show the tree.

### askCodebase (RLM loop)
- **Jev routing gates** (TypeSafe, advisory, one typed judgment each,
  ~1 s, fractions of a cent). Gate 1 decides whether a question needs the
  investigation loop at all, given the retrieval hits and the identifiers
  from the question that appear in them. Gate 2 scores the research plan's
  coverage and appends a search for each identifier the plan missed —
  `search_symbols` for a symbol, `search_files` for an indexed file name,
  `search_code` for a file the code generates (`funcs.xeto`, `doc.md`).
  Gate 3 judges whether the gathered evidence answers the question before
  the model drafts, and nudges one more search when a named symbol is
  absent. Every gate is null-safe: no key, a timeout or an uncertain answer
  leaves the loop as it was. Enabled from the LLM Providers page
  (`llmProviders.typesafe`, key `TYPESAFE_API_KEY`).
- **The plan parses.** Thinking models spent the whole `max_tokens` on
  chain-of-thought and returned an empty plan on every deep ask; reasoning
  is now off for the plan and every loop round, in each endpoint's dialect.
- **Provider-direct RLM models.** The RLM dropdown on the OpenRouter page
  also offers Gemini 3.8 / 3.7 / 3.5 Flash and Claude Sonnet 5.5 / Opus 5.5 /
  Haiku 4.5 on the provider's own API with the key from the LLM Providers
  page — no sidecar, no OpenRouter — shown only while that key is present.
  The loop and the final write-up both run there. Per-provider request
  shaping (Gemini's `thought_signature` on replayed tool calls and
  `reasoning_effort`; Anthropic's rejected `temperature`) is handled.
  Measured on the same question: 78 s on DeepSeek V4 Flash via OpenRouter →
  48 s on Gemini 3.8 Flash direct, longer answer, same citations; about
  1.4 ¢ per deep ask.
- **Loop cost cut.** No cross-encoder rerank and no per-hit graph metrics
  inside the loop (the model never read them; a search fell from 18–34 s to
  1–9 s); tool calls are bounded by the deadline instead of overrunning it;
  the forced-final draft round is skipped once evidence is gathered
  (synthesis writes the answer; the draft was empty every time).
- Synthesis tier and routing: LLM work goes only to sidecars that run the
  `rlm-sandbox` role.

### Embedding pipeline
- Live re-embed into the active table (no shadow) that **resumes**: a
  restart skips every project already complete and clears a half-written
  one. Five projects run at once; the dashboard pins them to the top of the
  table and names all of them.
- Scheduler: an upstream 429 re-queues a chunk without counting against the
  lane; a lane parked by one bad probe is re-probed; a gate refusal counts
  as a lane failure and falls back to the next lane.
- `build-missing` counts against the graph's node count (Prisma's ran ~30 %
  high, so a six-project fill walked all 318).
- The docs table is read-probed on open — a dropped table left a stale
  catalogue entry and a re-embed wrote 0 of 45,123 items.

### Stability
- **LadybugDB SIGSEGV fixed.** Two callers missing the connection cache at
  once opened two native databases on one file; the second replaced the
  first, which was freed under a running auto-checkpoint
  (`BufferManager::pin`). Opens are now single-flight per project, the
  engine's auto-checkpoint is off (we checkpoint on close and at shutdown),
  and a connection is never closed under a live query.
- Every project graph store is pre-flighted at boot; a corrupt file is
  quarantined (never deleted) and the project rebuilt.
- Sidecar registry: a register frame matches by hostname so a re-pointed
  entry is reused; an HTTP-fallback heartbeat never creates an entry.
- `scripts/start-dev-launchd.sh` starts the dev server as a launchd job so
  it holds the macOS Local Network permission a terminal-spawned process
  inherits as denied.

### Dashboard
- Vector Viewer remembers every filter per browser and restores it on
  refresh (`?projectId=` / `?vg=` in the URL still win); "Reset filters".
- Project table: default sort by id (queue order), in-flight projects pinned
  on top with an "embedding" chip; "Last run" column; "Embed missing"
  refuses while a job is running.
- LLM Providers: Claude Opus 5.5 / Sonnet 5.5 / Haiku 4.5; Gemini 3.6 Flash
  and 3.5 Flash Lite. An env-only API key is persisted to `.env` when its
  provider is saved.

## 1.0.1 — 2026-09-19

### Parsing
- **Trio files are parsed with a real grammar.** A new `tree-sitter-trio`
  grammar (`tree-sitter-trio/`, wasm vendored under
  `src/parser/treeSitter/grammars/`) replaces the hand-written line loop in
  `TrioParser`. Every record and tag now carries its exact line number, so
  function, view, subview and call line numbers in `.trio` files are real
  instead of estimated. `Zinc:`, `Trio:`, `[` and `{` blocks, nested `Trio:`
  records, comments and separators follow haxall's `TrioReader`. Malformed
  lines are reported as parse warnings instead of silently shifting every
  later record. Axon `src:` bodies are still handed to the Axon grammar; their
  call line numbers are now shifted to file lines.
- Grammar fixes found by running the new reader against the old one over
  3401 real `.trio` files (3398 parse clean, symbol counts identical):
  an indented block that ends the file without a trailing newline keeps its
  body; quoted strings may span lines (SkySpark project exports write `help:`
  and `src:` that way); CRLF files keep no carriage return in names or
  values.
- **Fantom grammar:** `try`, `catch` and `finally` accept a single statement
  without braces, as the language does. Files that used the brace-less form
  produced ERROR nodes and lost the definitions that followed; verified over
  8025 `.fan` files with no regressions.
- `trio` is registered as an indexer language (registry mappings, grammar
  list, file-extension detection).

### Indexing
- A project reindex reports `success: false` only for hard parse errors.
  Warnings (for example a `key=value` config file that happens to be named
  `.trio`) are returned as a separate `warnings` count.

### Tooling
- `ast-grep` configuration (`sgconfig.yml`, rules in `.ast-grep/rules`) with
  the in-repo Fantom, Axon, Xeto and Trio grammars registered as custom
  languages. `ast-grep run -l axon` also searches `src:` blocks inside `.trio`
  files through a language injection.
- Sidecar WebSocket diagnostics: per-agent close counters and tunnel-fault
  state in the WS status, a `ws-probe` admin route, per-message deflate.
- `scripts/release-public.sh` audits with POSIX ERE (BSD `grep` has no `-P`;
  the forbidden-files check used to pass silently) and takes the release
  notes for a version from this file.

## 1.0.0 — 2026-09-18

First public snapshot release.
