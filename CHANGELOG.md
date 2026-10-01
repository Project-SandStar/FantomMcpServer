# Changelog

All notable changes to FantomMcpServer. Public releases are snapshots; see
`scripts/release-public.sh`.

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
