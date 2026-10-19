# Code history: change records, summaries, embeddings, project copy

Proposal, 2026-10-16. Research only; no code changed.

Goal (Alper): keep a history of how the code changed over time, per project,
folder, file and function. Summarize each change with an LLM. Embed each
summary with its time, project, folder and function so search and `askCodebase`
can answer "what changed in auth last week" and "why did function X change".

Decisions (final):

1. **Only committed code is summarized.** Uncommitted edits are parsed and diffed
   (session changes, see `docs/proposals/lazy-incremental-indexing.md`). They get no
   LLM summary, no mirror line and no vector. When the commit lands, its files and
   symbols are summarized with commit, author and subject attached.
2. **Primary store in the server** (`.cache/history.db`). MCP tools, admin API,
   dashboard, vectors and cross-project search read from it.
3. **Project copy.** After each run the server writes a readable mirror to
   `<gitRoot>/.fantomMCP/summary/`. A person or an AI can grep it without the server.
4. **Import.** When the server has no history for a project but finds a mirror, it
   loads it. New machine, fresh clone, teammate's clone. Dedupe by content-hash id.
5. **The project copy is committed to git.** Not gitignored by default.
6. **One symbol key, shared with lazy indexing** (`lazy-incremental-indexing.md` 3.8, D5):
   portable `symbolKey = sha1(relPath | normalizedQn | paramSig? | ordinal?)`, no project id,
   no line numbers. Store id `nodeIdFor(projectId, key) = sha1(projectId | key)[:16]`.
   Renames and moves are linked by `body_sha` in the `symbol_links` table of that design;
   history defines no second link table.

## 1. What exists today

| Piece | Where | State |
|---|---|---|
| Run row | `index_runs` (`.cache/fantom.db`, Prisma) | 1,480 rows. Has `trigger`, files scanned/parsed/skipped, `added/modified/removed_count`, `is_seeding_run`, `force`, `git_commit`, `git_branch`. |
| Git capture | `src/fantom-code/codeIndexingService.ts:375-390` | `git rev-parse HEAD` + branch, 2 s timeout, best effort. 191 runs have a commit (28 commits, 11 projects). |
| File hash gate | `codeIndexingService.ts:326-373`, `indexed_files` | 12,906 rows: `mtime_ms`, `content_sha256`, `byte_size`, `symbol_count`. Only the current state. No old sha kept. |
| Symbol diff | `codeIndexingService.ts:459-485` (prev set from LadybugDB) and `773-850` (new set from parse) | Compares `qualifiedName` and `signature` only. Writes `api_changes`, cap 5,000 rows per run. |
| Edge diff | `codeIndexingService.ts:700-750` | Writes `edge_changes` (57,263 rows). |
| Incremental path | `reindexChangedFiles` → `codeIndexingService.ts:950-1260` | Same diff per file; re-embeds the touched files' nodes right away. |
| Read tools | `src/fantom-code/timeTravelTools.ts`, `timeTravelDiff.ts` | MCP: `whatChangedRecently`, `getSymbolHistory`, `explainSymbolChange` (heuristic label, no LLM), `diffByTime`, `getActivitySummary`, `compareSnapshots`, `getApiChangeHistory`, `diffIndexRuns`. |
| Admin | `src/admin/routes.ts:3183` `/code-projects/:id/index-runs`, `:3317` `/code-projects/:id/diff`, `/file-symbols?atTime` | Read `api_changes` only. |
| Dashboard | `dashboard/src/components/timeline/*` (`IndexRunStrip`, `HistoryPanel`, `PlaybackControls`), used in `ast-viewer` with `?asOf=` | Run strip and a diff list. No summaries, no folder view, no search. |
| Git impact | `src/graph/changeDetector.ts` | `git diff` → touched symbols → graph blast radius. Ad hoc, not stored. |
| LLM helper | `src/sidecars/openRouterChat.ts:118` `openRouterChat(system, user, {maxTokens, timeoutMs, temperature, role})` | Returns `{text, model, costUsd, servedBy}`. The operator pins the model per role on the SoundSuite master; the caller cannot pick one. |
| LLM cache pattern | `src/embedding/embedContextualizer.ts` | One request per FILE, JSON reply per node, cache `.cache/embed-context/<pid>.json` keyed by node id → `{hash, context}`. Reuse this shape. |
| Vectors | `src/embedding/vectorStore.ts` (`code_vectors`), `docsVectorStore.ts`, `src/axon/axonLance.ts` | LanceDB, one table per domain. Row columns: `node_id, project_id, node_type, chunk_index, line_start, line_end, qualified_name, file_path, vector`. Filters go into `.where()` before ANN. |
| SQLite driver | `better-sqlite3` (in `package.json`, used by `src/backup/backupManager.ts`) | Available for a second DB file. |

### Problems in the data (measured on `.cache/fantom.db`)

- `api_changes` has 216,763 rows (~35 MB). 212,353 are `removed`, 4,252 `added`, 158 `modified`.
- 41 runs hit the 5,000 cap with only `removed` rows (114,376 rows). Cause: for non-Fantom
  projects the previous set uses graph names (`sedonaWebEditor::Build`) and the new set uses parser names
  (`/abs/path/file.ts::getAppSaxInfo`). The names never match, so every force run reports the whole
  project as removed and never as re-added.
- `modified` fires only on a signature change. A body-only edit is invisible.
- `kind` is `function|type|field` on add and `class|method|constructor|...` (graph `node_type`) on remove.
- Node ids are `md5(filePath:qualifiedName:line)` (`src/fantom-code/types.ts:275`). A line shift
  changes the id. Ids cannot be the history key.
- Main DB is 283 MB, `journal_mode = delete` (no WAL). Prisma is the only writer.

The feature needs a correct diff first. Everything else is built on that.

## 2. Scope: working tree vs commits

Two kinds of change, two owners.

| | Session change (lazy-indexing design) | History record (this design) |
|---|---|---|
| Source | the working tree, each index run | a git commit, parent → commit |
| Diff | symbol diff vs the last indexed state + unified file diff | symbol diff between the two blobs + line counts |
| Store | lazy-indexing session store | `.cache/history.db` |
| LLM summary | no | yes |
| Mirror `.fantomMCP` | no | yes |
| Vector | no | yes |
| Who asks | the AI during an edit session: "what did I just change" | anyone: "what changed in auth last week", "why did X change" |
| Lifetime | until the commit lands or the session store expires | retention in section 8 |

### 2.1 One run, step by step

1. The indexer parses the working tree and writes session changes (not this design).
2. History reads the project's repos (section 6.11). Per repo it compares `HEAD` with the repo's
   `last_commit` in `history.db`:
   - `HEAD == last_commit`: nothing to do.
   - `HEAD` descends from `last_commit` (`git merge-base --is-ancestor`): new commits. Go to step 3.
   - Otherwise (checkout, rebase, amend, reset): a **checkout run**. Set `last_commit = HEAD`,
     write a run row with counts, no records. Commits on the new branch are summarized as they
     land from here on; older ones only on request (backfill, section 4).
3. `git rev-list --reverse --topo-order --no-merges <last_commit>..HEAD -- <projectPathInRepo>`,
   capped at `codeHistory.maxCommitsPerRun` (default 50; the rest is queued as backfill). Merge
   commits get a commit row for the timeline, no file records: their changes are the merged
   commits. Conflict-resolution hunks are an accepted gap.
4. Per commit: `git diff-tree -r -M --no-commit-id <commit>` gives, per file, the change kind
   (A/M/D/R with rename score), the old and new git blob ids and paths. One call per commit.
5. Per file: the before symbols come from `git show <parent>:<path>`, the after symbols from
   `git show <commit>:<path>`. Both parses are cached by blob id (`parsed_blobs`). When the
   working tree file the indexer just parsed has the same `content_sha256` as the commit blob,
   the indexer's parse is reused and the file is flagged `indexedFromWorkingTree`. Otherwise
   history parses the blob itself (P0 needs a parse-from-string entry; the tree-sitter adapter
   takes source text, the file walker is the disk reader).
6. Symbol diff by symbol key and `body_sha`. Records written, summarizer woken, mirror written
   after the summaries are done. `last_commit = HEAD`.

Commits that arrive by `pull` or `merge` take the same path. A teammate's server has usually
summarized them already; the import (section 6.6) runs before the summarizer, and a record whose
id already has a summary is not summarized again. That is the main cost saver for teams.

### 2.2 Projects without git

No commits, so no history records, no summaries, no mirror. The AI sees session changes
(the lazy-indexing store compares edit times and gives diffs). Opt-in later:
`codeHistory.nonGit = 'none' | 'mtime-batches'` (treat each index run as a pseudo-commit), default
`none`. Open question.

### 2.3 Adding a project with a long history

At add time, history seeds `last_commit = HEAD` and summarizes nothing. The user can ask for
`POST /admin/history/:projectId/backfill?commits=N|since=YYYY-MM-DD`, which runs under the daily
budget. Default off, so adding a 10-year repo costs nothing.

## 3. The change record

Levels: commit → file → symbol, plus a folder rollup per commit. All paths are relative. All ids
are content hashes, so the same change gets the same id on every machine.

### 3.1 Commit

One row per commit seen: sha, first parent, author name, author time (`%at`), subject, branch at
the time of the run, counts. `at` of every record below is the commit's author time: the time of the
change, the same in every clone, stable on a rebuild.

### 3.2 File

One record per file in the commit's diff-tree.

- `kind`: `added | modified | removed | renamed` (renamed from git's `-M`, score ≥ 50%; a rename
  with edits is `renamed` with symbol records inside).
- `blobBefore`, `blobAfter`: git blob ids (40-hex). Cheap, deterministic, the same in every clone.
- `linesAdded`, `linesRemoved` from `git diff --numstat` of the pair.
- `commit`, `author`, `subject` from the commit row.
- `indexedFromWorkingTree`: the after side was parsed by the indexer earlier, not from the blob.
- id = `sha1('file' | repoPath | blobBefore | blobAfter)`.

### 3.3 Symbol

One record per symbol that changed in a changed file.

- **Key** = `symbolKey(relPath, normalizedQn, paramSig?, ordinal?)` from
  `src/fantom-code/symbolKey.ts` (lazy-indexing 3.8, D5). `sha1` of the four parts joined by
  `\u001f`; `paramSig` only when a file has two symbols with the same name and the parser gives
  parameter types; `ordinal` as a last resort. No project id, no line numbers, and `relPath` is
  in the key for Fantom too. The key is the same for a session change and the later history
  record, so the dashboard can show "edited at 14:02, committed at 15:10" on one symbol.
- **Store id** = `nodeIdFor(projectId, key) = sha1(projectId | key)[:16]`. The graph node id and
  the LanceDB `node_id`. History stores the portable key and derives the store id when it needs
  a graph node.
- **`relPath` base, decided 2026-10-15:** relative to the **owning git root** when the file is
  inside one (longest root wins, section 6.11), else relative to the project root. D5
  (`lazy-incremental-indexing.md` line 31) says the same. `symbolKey()` does not change; only
  the base the caller passes does. So `relPath` and `repo_path` are the same value for files in
  a repo, and the key is the same in every clone, in a nested repo cloned on its own, and in two
  projects that add the same repo at different subfolders; their mirror lines dedupe on import.
  The mirror line carries `key` as computed; import stores it as is and recomputes nothing.
  `file_path` (project-relative) is kept only for display and project-scoped queries (folder
  tree, `folder LIKE`); it is never part of the key.
- **A project that gains or loses a `.git`** (`git init` in a subfolder, a submodule removed)
  changes the base of every file under that root, so those files re-key. The next run sees the
  old keys gone and the new keys added with the same `body_sha`, and links each pair
  `old → new` in `symbol_links` (kind `rebase`); `getSymbolHistory` follows the link, and the
  history records keep their old keys. No summaries are made for a re-key: it is not a code
  change.
- **Record id** (dedupe across clones, no server ids):
  `id = sha1('symbol' | key | beforeBodySha | afterBodySha | beforeSig | afterSig)`.
- `body_sha = sha256(symbol source lines, whitespace-trimmed)`. Stored on the graph node and in
  `vector_state` by the lazy-indexing design; history stores it on the record.
- `modified`: same key, different body or signature. `signatureChanged` is a flag.
- `moved`: a gone key and a new key with the same `body_sha` in another file of the same commit.
  `renamed`: same, in the same file. Both carry `linkedKey` (the old key) and `key` (the new).
  The link itself is a `symbol_links (project_id, old_key, new_key, kind, run_id, at)` row, the
  Prisma table from lazy-indexing 3.8; history writes no second table and `getSymbolHistory`
  follows the same rows. A move or rename with an edit in the same commit is `removed` +
  `added` (exact body match only; fuzzy linking is an open question).
- Keep `beforeSig`, `afterSig`, both line ranges, both file paths, both body shas.

### 3.4 Blobs and parsed blobs (server only)

`parsed_blobs(blob_id, parser_version, symbols_json)` caches a parse of one git blob: symbols,
signatures, line ranges, body shas. The summarizer slices bodies out of `git show <blob>` when it
needs source, so there is no source copy in the server. The old `blobs` table of earlier drafts is
dropped: git is the source. Non-git projects have no history records (section 2.2).

### 3.5 Interface to the indexing queue

The lazy/incremental queue owns parsing. History is a consumer. One call after the run row has
`finishedAt` and before embedding starts:

```ts
// src/history/recordRunHistory.ts
export interface RunDiff {
  runId: number; projectId: number; projectPath: string; trigger: IndexTrigger;
  startedAt: Date; finishedAt: Date; isSeedingRun: boolean; force: boolean;
  repos: RepoState[];                      // every git root the project touches
  sessionFiles: SessionFile[];             // what the indexer parsed from the working tree
}
export interface RepoState {
  root: string;                            // absolute path of the git root
  head: string; branch: string; dirty: boolean;
}
export interface SessionFile {
  path: string;                            // relative to projectPath
  contentSha256: string;
  symbols: ParsedSymbol[];                 // key, qualifiedName, kind, signature, bodySha, lines
}
export async function recordRunHistory(diff: RunDiff): Promise<void>;

// what history builds per commit (also the import shape)
export interface CommitDiff {
  repoRoot: string; commit: string; parent: string | null;
  author: string; at: number; subject: string; branch: string;
  files: FileDiff[];
}
export interface FileDiff {
  repoPath: string; projectRelPath: string;
  kind: 'added' | 'modified' | 'removed' | 'renamed'; fromPath?: string;
  blobBefore?: string; blobAfter?: string; linesAdded: number; linesRemoved: number;
  indexedFromWorkingTree: boolean;
  symbols: SymbolDiff[];
}
export interface SymbolDiff {
  key: string; linkedKey?: string; qualifiedName: string; kind: string;   // kind = graph node_type; linkedKey = old key on moved|renamed (same name as lazy-indexing SymbolDiff.linkedKey)
  change: 'added' | 'modified' | 'removed' | 'moved' | 'renamed';
  signatureChanged: boolean;
  beforeSig?: string; afterSig?: string; beforeBodySha?: string; afterBodySha?: string;
  lineStart?: number; lineEnd?: number; beforeLineStart?: number; beforeLineEnd?: number;
  beforeFilePath?: string;
}
```

Rules: idempotent (`INSERT OR IGNORE` on `(project_id, id)`), so a retry or a re-delivery is safe.
Seeding, `force` and checkout runs write a run row with counts only. The indexer must exclude
`.fantomMCP/**` from parsing, or the mirror indexes itself. `recordRunHistory` emits
`history:commits-recorded` on `autoPipelineBus` so the summarizer wakes.

## 4. LLM summaries

Only committed records. Four levels, built bottom-up. Only the symbol level sees source.

| Level | Input | Output | Requests |
|---|---|---|---|
| symbol | before/after body from the blobs (unified diff when > 120 lines), signatures, file path, commit subject | 1-2 sentences: what changed, why it looks like it changed | 0 per symbol: symbols are batched per file |
| file | all symbol summaries of the file + line counts + subject | 1-3 sentences | 1 per changed file, same request as its symbols (JSON reply, like `embedContextualizer`) |
| folder | file summaries under the folder, depth 1-2 | 1-3 sentences | 1 per folder with ≥ 2 changed files in the commit |
| commit | folder/file summaries + counts + subject | short paragraph | 1 per commit |

Cost control:

- Cache key for a symbol = the record id (body-sha pair + signatures). The same change seen twice
  (a rebase, a merge that repeats a branch's commits, a teammate's import) costs nothing. File,
  folder and commit keys = sha of their sorted child ids.
- Skip seeding, force and checkout runs. A commit with more than
  `codeHistory.summarize.maxSymbolsPerCommit` (default 400) symbols gets file summaries from
  signatures only, no bodies.
- Budgets: `maxUsdPerDay` (default 1.0) and `maxRequestsPerRun`. When hit, rows get
  `state = 'deferred'`; a watchdog retries next day. Backfill (section 2.3) shares the budget.
- Model: `openRouterChat` with a new role `code-history` so the operator can pin a cheap model on
  the master. Until the role exists on the fleet, `role: 'rlm-sandbox'` (as `embedContextualizer`).
  Cost goes to `.cache/usage.db` from `costUsd`.
- Runs in the background under the heavy-job gate (`embedGate.ts`, `waitForHeavyJob`), so it never
  competes with a re-embed.
- Summaries are not deterministic: two machines that summarize the same change get different
  text. Dedupe is by record id; the first text seen wins (section 6.6).

Redaction, before the prompt and again on the reply (section 6.8). The prompt also says: describe
the change, do not quote literal values.

Estimate: a typical commit touches ~6 files with symbol changes. 6 requests of ~3k tokens in,
600 out on a flash-class model ≈ < $0.01. 15 commits on a busy day ≈ $0.10/day.

## 5. Primary store: `.cache/history.db`

Recommendation: a separate SQLite file, opened with `better-sqlite3`, `journal_mode = WAL`,
`synchronous = NORMAL`, schema version in `PRAGMA user_version`.

Why not tables in the main DB:

- Size and growth. The main DB is 283 MB and already carries 35 MB of change rows, 53% of it
  noise. History grows with every commit and needs its own retention and `VACUUM`.
- Write contention. The main DB runs without WAL. The summarizer and the importer write in the
  background while the indexer writes runs. Two busy writers on one non-WAL file mean
  `SQLITE_BUSY` and retries inside Prisma. A second file removes that.
- No Prisma migration. `prisma migrate dev` has wiped `fantom.db` before (safety rail in
  CLAUDE.md). `CREATE TABLE IF NOT EXISTS` plus a `user_version` bump at boot is safer and matches
  `usage.db`.
- Backup and reset are independent. A history reset does not touch projects, pods or settings.

```sql
PRAGMA user_version = 1;

CREATE TABLE project_repos (                   -- every git root a project touches
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL,
  root_abs TEXT NOT NULL, root_rel TEXT NOT NULL,     -- root relative to the project path ('.', 'vendor/haxall', '../..')
  last_commit TEXT, last_branch TEXT, mirror_state TEXT NOT NULL DEFAULT 'ok',   -- ok|read-only|disabled
  UNIQUE(project_id, root_abs)
);

CREATE TABLE runs (                            -- bookkeeping per index run / import
  id INTEGER PRIMARY KEY, index_run_id INTEGER, project_id INTEGER NOT NULL,
  source TEXT NOT NULL,                        -- index | import | backfill
  started_at INTEGER NOT NULL, finished_at INTEGER,
  is_seeding INTEGER NOT NULL DEFAULT 0, force INTEGER NOT NULL DEFAULT 0, checkout INTEGER NOT NULL DEFAULT 0,
  commits_seen INTEGER NOT NULL DEFAULT 0, files_changed INTEGER NOT NULL DEFAULT 0, symbols_changed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE commits (
  project_id INTEGER NOT NULL, repo_id INTEGER NOT NULL REFERENCES project_repos(id),
  sha TEXT NOT NULL, parent TEXT, author TEXT, at INTEGER NOT NULL, subject TEXT, branch TEXT,
  is_merge INTEGER NOT NULL DEFAULT 0, run_id INTEGER REFERENCES runs(id),
  files_changed INTEGER NOT NULL, symbols_changed INTEGER NOT NULL,
  record_id TEXT NOT NULL,                     -- sha1('commit' | sha): the mirror id
  summary_key TEXT REFERENCES summaries(key),
  PRIMARY KEY(project_id, sha)
);
CREATE INDEX commits_project_time ON commits(project_id, at);

CREATE TABLE file_changes (
  project_id INTEGER NOT NULL, id TEXT NOT NULL,         -- content-hash record id
  repo_id INTEGER NOT NULL, commit_sha TEXT NOT NULL,
  file_path TEXT NOT NULL, folder TEXT NOT NULL,          -- relative to the project path (queries)
  repo_path TEXT NOT NULL,                                -- relative to the git root (mirror)
  change_kind TEXT NOT NULL, from_path TEXT,
  blob_before TEXT, blob_after TEXT, lines_added INTEGER, lines_removed INTEGER,
  symbols_added INTEGER, symbols_modified INTEGER, symbols_removed INTEGER,
  at INTEGER NOT NULL, indexed_from_working_tree INTEGER NOT NULL DEFAULT 0,
  summary_key TEXT REFERENCES summaries(key),
  PRIMARY KEY(project_id, id)
);
CREATE INDEX fc_project_folder_time ON file_changes(project_id, folder, at);
CREATE INDEX fc_path ON file_changes(project_id, file_path);
CREATE INDEX fc_commit ON file_changes(project_id, commit_sha);

CREATE TABLE symbol_changes (
  project_id INTEGER NOT NULL, id TEXT NOT NULL,
  file_change_id TEXT NOT NULL, commit_sha TEXT NOT NULL,
  symbol_key TEXT NOT NULL,                               -- portable symbolKey (D5), no project id
  linked_key TEXT,                                        -- old key on moved|renamed; the link row is Prisma symbol_links
  qualified_name TEXT NOT NULL, kind TEXT NOT NULL,
  change_kind TEXT NOT NULL,                              -- added|modified|removed|moved|renamed
  signature_changed INTEGER NOT NULL DEFAULT 0,
  before_sig TEXT, after_sig TEXT, before_body_sha TEXT, after_body_sha TEXT,
  before_file_path TEXT, line_start INTEGER, line_end INTEGER, before_line_start INTEGER, before_line_end INTEGER,
  at INTEGER NOT NULL,
  summary_key TEXT REFERENCES summaries(key),
  PRIMARY KEY(project_id, id)
);
CREATE INDEX sc_key ON symbol_changes(symbol_key, at);
CREATE INDEX sc_project_time ON symbol_changes(project_id, at);

CREATE TABLE folder_changes (                             -- rollup per commit, for the tree view
  project_id INTEGER NOT NULL, id TEXT NOT NULL, commit_sha TEXT NOT NULL, folder TEXT NOT NULL,
  files_changed INTEGER NOT NULL, symbols_changed INTEGER NOT NULL, at INTEGER NOT NULL,
  summary_key TEXT REFERENCES summaries(key),
  PRIMARY KEY(project_id, id)
);

CREATE TABLE parsed_blobs (                               -- parse cache per git blob, never mirrored
  blob_id TEXT NOT NULL, parser_version TEXT NOT NULL, language TEXT NOT NULL,
  symbols_json TEXT NOT NULL, last_used_at INTEGER NOT NULL,
  PRIMARY KEY(blob_id, parser_version)
);

CREATE TABLE summaries (
  key TEXT PRIMARY KEY,                                   -- = the record id it summarizes
  level TEXT NOT NULL,                                    -- symbol|file|folder|commit
  text TEXT, model TEXT, cost_usd REAL, created_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',                  -- pending|done|deferred|failed|imported
  redacted INTEGER NOT NULL DEFAULT 0,
  embedded_at INTEGER,                                    -- null until in history_vectors
  mirrored_at INTEGER                                     -- null until written to .fantomMCP
);

CREATE VIRTUAL TABLE summaries_fts USING fts5(
  key UNINDEXED, level UNINDEXED, project_id UNINDEXED,
  text, qualified_name, file_path, folder, subject,
  tokenize = 'porter unicode61'
);

CREATE TABLE mirror_files (                               -- import bookkeeping per shard file
  repo_id INTEGER NOT NULL, rel_path TEXT NOT NULL, sha256 TEXT NOT NULL,
  imported_at INTEGER NOT NULL, records INTEGER NOT NULL, skipped INTEGER NOT NULL,
  PRIMARY KEY(repo_id, rel_path)
);
```

Size: a change row is ~300 B. 30 symbol changes per commit × 15 commits/day ≈ 135 KB/day. One
year ≈ 50 MB plus the parse cache, before pruning.

## 6. Project copy: `<gitRoot>/.fantomMCP/summary/`

A readable mirror of the committed records and their summaries. Summary text only: no vectors,
no source bodies. Committed to git. The server writes it; people and AIs grep it.

### 6.1 Layout

```
<gitRoot>/.fantomMCP/
  manifest.json                  # {"schema":1,"generator":"fantom-mcp-server","shard":{"by":"month+folder","depth":2}}
  .gitignore                     # ".lock" and ".local/" — the only files not committed
  .gitattributes                 # "summary/**/*.jsonl merge=union"
  summary/
    README.md                    # what this is, the record format, grep examples (static)
    2026-10/                     # month of the commit author time `at`, UTC
      commits.jsonl              # one line per commit
      src__hx__auth.jsonl        # file + symbol + folder records for src/hx/auth/** (one per line)
      src__hx__api.jsonl
      test__hx.jsonl
      _root_.jsonl               # files in the repo root
      digest.md                  # human-readable month view, derived from the jsonl files
    2026-09/
      …
  .local/                        # gitignored scratch (lock state, last-import marker)
```

The shard name is the first `depth` path segments joined with `__` (`shardDepth`, default 2, per
project override). A folder rollup for `src/hx/auth` goes into the same shard. Other per-project
data can sit beside `summary/` later (`notes/`, `config.json`).

### 6.2 Record format

One JSON object per line, fixed key order, no pretty print, UTF-8, `\n` line ends. `null` fields
are omitted. Paths are relative to the git root. No absolute paths, no server ids, no project ids,
no index-run timestamps.

```json
{"id":"4f0c9a…","v":1,"level":"symbol","key":"c3a97e…","kind":"modified","sig":true,"file":"src/hx/auth/AuthLib.fan","folder":"src/hx/auth","symbol":"hxAuth::AuthLib.login","symbolKind":"method","at":"2026-10-14T09:12:33Z","commit":"37013ac0","author":"Alper","branch":"main","before":"Str login(Str user, Str pass)","after":"Str login(Str user, Str pass, Bool strict := true)","bodyBefore":"9e1c…","bodyAfter":"a77d…","lines":[120,148],"summary":"login() now checks session expiry before the password check and returns 401 on expiry.","redacted":false}
{"id":"b17e…","v":1,"level":"file","kind":"modified","file":"src/hx/auth/AuthLib.fan","folder":"src/hx/auth","at":"2026-10-14T09:12:33Z","commit":"37013ac0","author":"Alper","branch":"main","blobBefore":"3c0f…","blobAfter":"d8e2…","linesAdded":12,"linesRemoved":3,"symbols":{"added":0,"modified":2,"removed":0},"summary":"Session expiry is enforced in login and refresh."}
{"id":"9c2d…","v":1,"level":"folder","folder":"src/hx/auth","at":"2026-10-14T09:12:33Z","commit":"37013ac0","files":3,"symbolsChanged":5,"summary":"Auth now rejects expired sessions; tests cover refresh."}
```

`commits.jsonl`:

```json
{"id":"e4a1…","v":1,"level":"commit","at":"2026-10-14T09:12:33Z","commit":"37013ac0","parent":"c21b9f00","branch":"main","author":"Alper","subject":"auth: reject expired sessions","files":6,"symbols":14,"folders":["src/hx/auth","test/hx"],"summary":"…"}
```

How the mirror relates to the server keys: a symbol line carries `key` (the portable
`symbolKey`, section 3.3, the same in every clone), `file`, `symbol`, `bodyBefore` and
`bodyAfter`. The server stores `key` as is and derives the graph node id with
`nodeIdFor(projectId, key)`. A moved or renamed line adds `fromKey`, `fromFile` or `fromSymbol`;
on import `fromKey → key` becomes a `symbol_links` row. `id` is the content hash from section 3
(facts only, not the summary text, so it is known at diff time and equal in every clone). `commit`, `author`, `branch` are
metadata, not in the hash. `author` is the git author name, already in the repo; a project can
turn it off (`codeHistory.mirror.author = false`).

### 6.3 Determinism and diffs

- Append-only. A line, once written, is never changed. A run appends its new records, sorted by
  `(at, id)`, to the end of the shard files. A git diff of a run is N added lines.
- The server writes a record exactly once, after its summary is `done`, `failed` (then `summary`
  is omitted) or skipped. It never re-appends records from its own store, so a mirror never
  "grows back" after a checkout (section 6.5).
- The lines for commit N land in the working tree after N is summarized, so they are committed
  with commit N+1 or later. The `commit` field ties a line to its commit wherever the line was
  committed. The last commit of a branch always has its lines pending in the working tree.
- `digest.md` of the current month is derived from that month's jsonl files plus the records just
  appended, grouped by commit, sorted by `(at, id)`. Its content is a function of the file set, so
  a rebuild gives the same bytes. Only the current month's digest changes.
- Files are written atomically: write `name.jsonl.tmp`, `fsync`, rename. A crash leaves the old
  file intact.

### 6.4 Merge-friendly layout and git conflicts

- Two branches touch the same jsonl file only when both change the same folder shard in the same
  month. `.gitattributes` sets `merge=union` for `summary/**/*.jsonl`, so git keeps the lines of
  both sides without a conflict. Order inside a file is not a contract: readers treat a file as
  a set keyed by `id`.
- `digest.md` is not union-merged. On a conflict, take either side; the server regenerates it on
  the next run from the merged jsonl files.
- A user without the attributes file sees a normal "both added" conflict at the end of the file.
  Resolution: keep both sides. Duplicate lines are harmless (dedupe by id). The importer skips any
  line that is not valid JSON (conflict markers) and logs the path once.
- A rebase or cherry-pick carries the lines with the commit that holds them. The `commit` field
  then names the pre-rebase hash. The id is still the key, and the content id of the rebased
  change is the same unless the "before" body differs on the new base. Known limitation: a
  digest link to a rewritten commit goes stale.

### 6.5 Branch switches

A checkout rolls `.fantomMCP/summary/` back to that branch's state, as it rolls back the code.
That is correct: the files describe that branch. The server store keeps everything.

- The run after a checkout is a checkout run (section 2.1): counts only, no records, no mirror
  write. A branch switch never logs hundreds of removed symbols.
- `branch` is stored on every record, and the dashboard filters by it.
- Catch-up (records with `mirrored_at = NULL`, from a lock failure or a read-only period) is
  written only when the record's `commit` is an ancestor of the current HEAD. Records from another
  branch wait for that branch.

### 6.6 Import and reconcile

The importer runs at project add, at boot, and before each mirror write, per repo.

1. List `summary/*/*.jsonl`. Skip files whose sha256 matches `mirror_files` (unchanged since the
   last import). A `git pull` or a checkout changes shas, so teammate records are picked up.
2. Parse line by line. Skip bad JSON (log once per file). Skip lines whose `file` is outside the
   project's path inside the repo (section 6.11). Dedupe by `id`: a known id is skipped, first
   seen wins, also for summary text.
3. New records get `commits` rows (from `commits.jsonl`, or a stub from the line's `commit`/`at`),
   `symbol_key` taken from the line (it is portable; the node id is `nodeIdFor(projectId, key)`),
   a `symbol_links` row for each `fromKey`, `summaries.state = 'imported'`,
   `mirrored_at = now` (it came from the mirror), `embedded_at = NULL` so the background embedder
   picks it up.
4. Record counts in `mirror_files`.

So several clones converge: each clone commits its own lines; `merge=union` keeps all; every server
imports the union and dedupes by id. A commit that a teammate already summarized is imported, not
summarized again.

### 6.7 Size budget, retention, compaction

- A symbol line is ~500 B; a file line ~300 B. An active project with 15 commits a day and 30
  symbol changes per commit writes ~4 MB/month of JSONL, ~1 MB in git's packed form.
- `codeHistory.mirror.maxBytesPerMonth` (default 4 MB): above it, the rest of the month gets
  file-level lines only (symbol records stay in the server). `maxTotalMb` (default 50): above it,
  the dashboard shows a warning and the mirror switches to file-level lines for all months.
- No automatic rewrite of old months. Rewrites churn git history; the repo keeps what was
  committed.
- Explicit archive action (`POST /admin/history/:projectId/mirror/archive?before=YYYY`): moves
  months older than a year into `summary/archive/<YYYY>.jsonl` with file-level lines only and one
  `digest.md` for the year. One rare commit, done by a person on purpose.
- Server retention (section 8) does not touch the mirror. Deleting a project from the server never
  deletes files in the user's repo.

### 6.8 Privacy

Committed summaries derive from code and travel with the repo, so they must contain nothing the
code does not already contain, and no secrets even if the code does.

- Skip list (`codeHistory.redact.skipFiles`, default `.env*`, `*.pem`, `*.key`, `*.p12`,
  `*secret*`, `*credential*`, `id_rsa*`): these files get a file line with no summary and no
  symbol lines.
- Redaction (`codeHistory.redact.patterns`, built-ins plus user regexes) runs on the prompt input
  and on the reply: `sk-…`, `AKIA…`, `ghp_…`, `xox[bp]-…`, JWTs (`eyJ…`), hex/base64 runs ≥ 32
  chars, `password|token|secret|apikey\s*[:=]\s*\S+`, URLs with user info, private IPs
  (`10.`, `192.168.`, `172.16-31.`, `100.64-127.`), hostnames ending in `.local`/`.lan`/`.internal`.
  Matches become `«redacted»`; the record gets `redacted: true`.
- The server stores the same redacted text. One text, no un-redacted copy.
- The LLM prompt forbids quoting literal values.

### 6.9 Read-only roots, network folders, moved projects, locking

- Writable check at project add and at each write: `fs.access(root, W_OK)`, `mkdir -p`, write and
  remove a temp file. On `EACCES`/`EROFS`/`EPERM`: `mirror_state = 'read-only'` for the repo, one
  log line per boot, a badge on the project card, server store unaffected. Records keep
  `mirrored_at = NULL` and are written by catch-up when the root becomes writable.
- Network folders: atomic temp-and-rename writes; no file is held open; a write timeout of 10 s
  marks the run's mirror write as deferred.
- A moved project: paths in records are relative, so the mirror moves with the folder. After the
  server's `project.path` is updated, the importer sees known ids and does nothing.
- Two servers or machines on one folder (NAS, shared checkout): `summary/.lock`, created with
  `O_EXCL`, holding `host pid time`; stale after 60 s. On failure the mirror write is skipped for
  this run (records stay `mirrored_at = NULL`) and the next run catches up. Both servers import
  each other's records by id, so neither loses anything.
- `codeHistory.mirror.enabled` (default true) per project turns the mirror off; the import still
  runs so a clone that already has files is read.

### 6.10 Grep without the server

```bash
# everything in src/hx/auth in the last two months
cat .fantomMCP/summary/2026-{09,10}/src__hx__auth.jsonl | jq -r '[.at,.level,.kind,.symbol // .file,.summary] | @tsv'

# every change of one function, oldest first
grep -h '"symbol":"hxAuth::AuthLib.login"' .fantomMCP/summary/*/*.jsonl | jq -r '[.at,.commit,.summary]|@tsv' | sort

# which folders changed in a commit
grep -l '"commit":"37013ac0"' .fantomMCP/summary/2026-10/*.jsonl

# read the month
open .fantomMCP/summary/2026-10/digest.md
```

An AI client without the MCP server reads `README.md` for the format and uses `grep`/`jq`.

### 6.11 Nested git repos and projects that span repos

Each git repo tracks its own files, so each file's history and mirror belong to the repo that
owns it.

- Owner of a file = the nearest ancestor directory with a `.git` (directory or file, so
  submodules and worktrees count). Longest git root wins. Computed once per directory and cached
  per run.
- `project_repos` holds every root a project touches. Each root has its own `last_commit`, its
  own `git rev-list`/`diff-tree` pass, its own lock, its own `.fantomMCP/summary/`, and its own
  import.
- **Project root is a repo with nested repos** (`<project>/.git` plus `<project>/vendor/haxall/.git`):
  files under `vendor/haxall/` mirror into `vendor/haxall/.fantomMCP/summary/` with paths
  relative to `vendor/haxall`; everything else mirrors into `<project>/.fantomMCP/summary/`. The
  server stores `file_path` relative to the project for queries (`vendor/haxall/src/x.fan`) and
  `repo_path` for the mirror (`src/x.fan`). A commit in the outer repo that only bumps a
  submodule pointer lists the submodule path as a file; it is skipped (not a source file).
- **Project root is inside a bigger repo** (`<repo>/src/hx` added as a project): the owner is
  above the project. The mirror goes to `<repo>/.fantomMCP/summary/` with repo-relative paths
  (`src/hx/...`); `git rev-list` is limited with `-- src/hx`; the importer only loads lines whose
  `file` starts with `src/hx/`. Two projects inside one repo share one mirror folder and one
  `commits.jsonl`; the commit lines dedupe by id.
- **Project root is not a repo but contains repos** (a workspace folder): each repo as above.
  Files outside every repo get session changes only, no history.
- Keys use the repo-relative `relPath` (section 3.3, decided), so a nested repo cloned on its
  own elsewhere produces the same keys and record ids as when seen through the outer project, and
  its mirror lines dedupe on import. Two projects that include the same file keep separate graph
  nodes because the store id adds the project id. Files outside every repo use the
  project-relative path as `relPath`. When a folder gains or loses a `.git`, the files under it
  re-key and are linked old → new in `symbol_links` (section 3.3).

## 7. Query surface and vectors

### 7.1 SQL and FTS on the server

```sql
-- what changed in auth last week
SELECT sc.at, sc.change_kind, sc.qualified_name, f.file_path, c.sha, c.subject, s.text
FROM symbol_changes sc
JOIN file_changes f ON f.project_id = sc.project_id AND f.id = sc.file_change_id
JOIN commits c ON c.project_id = sc.project_id AND c.sha = sc.commit_sha
LEFT JOIN summaries s ON s.key = sc.summary_key
WHERE sc.project_id = ? AND f.folder LIKE 'src/hx/auth%'
  AND sc.at >= (strftime('%s','now','-7 days') * 1000)
ORDER BY sc.at DESC;

-- why did function X change (every commit that touched one symbol, across renames)
-- step 1, Prisma (fantom.db): follow symbol_links old_key <-> new_key from X's key
--         until the set is closed; this is the key set K
-- step 2, history.db:
SELECT sc.at, sc.change_kind, sc.signature_changed, sc.before_sig, sc.after_sig,
       c.sha, c.author, c.subject, s.text
FROM symbol_changes sc
JOIN commits c ON c.project_id = sc.project_id AND c.sha = sc.commit_sha
LEFT JOIN summaries s ON s.key = sc.summary_key
WHERE sc.project_id = ? AND sc.symbol_key IN (/* K */)
ORDER BY sc.at;

-- full text across summaries, one project, a date range, one change kind
SELECT fts.key, fts.level, fts.file_path, bm25(summaries_fts) AS rank
FROM summaries_fts fts
JOIN symbol_changes sc ON sc.summary_key = fts.key
WHERE summaries_fts MATCH 'session AND expir*'
  AND fts.project_id = ? AND sc.change_kind = 'modified' AND sc.at BETWEEN ? AND ?
ORDER BY rank LIMIT 20;

-- folder tree counts for a range
SELECT folder, COUNT(*) files, SUM(symbols_added+symbols_modified+symbols_removed) symbols
FROM file_changes WHERE project_id = ? AND at BETWEEN ? AND ? GROUP BY folder;
```

### 7.2 MCP tool and admin API

`searchCodeHistory({ query?, projectId?, versionGroup?, folder?, symbol?, file?, since?, until?,
changeKind?, level?, branch?, commit?, author?, mode?: 'hybrid'|'fts'|'exact', limit })` in
`src/history/historySearch.ts`. `exact` = SQL only; `fts` = FTS5 + filters; `hybrid` (default when
`query` is set) = vector ⊕ FTS with RRF, then hydrate from `history.db`. Committed changes only.

The working tree is a separate answer: `whatChangedRecently` merges history (committed, with
summaries) and session changes (uncommitted, diffs only, from the lazy-indexing store), each row
labeled `committed | working-tree`. `explainSymbolChange` returns the stored summary for a committed
change, the unified diff for a session change, and the old heuristic label when neither exists.
`getSymbolHistory` and `diffByTime` read `history.db` when the project has rows there, else
`api_changes`.

Admin, in a new `src/admin/historyRoutes.ts` (not in `routes.ts`, which is over the size limit):

```
GET  /admin/history/:projectId/commits?since&until&branch&author&limit
GET  /admin/history/:projectId/folders?since&until
GET  /admin/history/:projectId/files?folder&since&until&limit
GET  /admin/history/symbol/:symbolKey
GET  /admin/history/commit/:projectId/:sha
GET  /admin/history/search?q&projectId&folder&since&until&kind&mode
GET  /admin/history/diff?projectId&symbolChangeId      # before/after from git blobs
POST /admin/history/summarize/:projectId/:sha          # manual (re)run
POST /admin/history/:projectId/backfill?commits|since  # older commits, under budget
GET  /admin/history/status                             # queue, budget used, deferred, backfill pending
GET  /admin/history/:projectId/mirror                  # per repo: writable?, last write, bytes, pending catch-up
POST /admin/history/:projectId/mirror/import           # force a re-import of the project copy
POST /admin/history/:projectId/mirror/catch-up         # write pending records now
POST /admin/history/:projectId/mirror/archive?before=YYYY
```

### 7.3 Vectors stay in the server

New LanceDB table `history_vectors` in `.cache/fantomvector.db/`, same provider and dims as
`code_vectors` (`selectAllEmbeddingProviders('code')`, `embedBatchFanout`), so a code question and a
change summary live in one space. Committed records only. Vectors are never written to the project
copy: they are large, binary, model-specific and rebuildable. Rows are keyed by the record id, so a
record imported from a teammate's clone is embedded here like a local one.

Row: `id` (record id), `project_id`, `level`, `change_kind`, `file_path`, `folder`,
`qualified_name`, `symbol_key`, `at` (epoch ms), `commit`, `author`, `branch`, `text`, `vector`.

Embedded text, in the style of embedding text v3 (`src/embedding/embeddingText.ts`):

```
kind: change/modified
project: haxall
file: src/hx/auth/AuthLib.fan
folder: src/hx/auth
symbol: hxAuth::AuthLib.login
when: 2026-10-14
commit: 37013ac0 "auth: reject expired sessions" (Alper)
summary: login() now checks session expiry before the password check and returns 401 on expiry.
before: Str login(Str user, Str pass)
after:  Str login(Str user, Str pass, Bool strict := true)
```

Batch per run after the summarizer pass. Build the ANN index with `scripts/build-vector-index.mjs`
as for the other tables, never in-process.

### 7.4 How a question runs

1. Resolve scope: `versionGroup` → project ids (`src/projects/versionGroup.ts`).
2. Prefilter in LanceDB: `project_id IN (...) AND at BETWEEN ... AND folder LIKE 'src/hx/auth%' AND change_kind = ...`,
   then ANN, flat-scan fallback on 0 rows (same pattern as `vectorStore.search`).
3. FTS5 with the same filters; RRF fuse (`hybridSearch.ts`); optional rerank (`crossEncoderReranker.ts`).
4. Hydrate from `history.db`: file, symbol, commit, before/after signatures.

"What changed in auth last week": `since = now-7d`; `folder` from the question when the RLM names
one, else a vector hit on "auth". Result: file and symbol summaries by commit, newest first.
"Why did function X change": exact path first (`symbol_key`, widened through `symbol_links`
across renames), then one vector
query with X's name for related changes in the same commits (callers, tests). If X has an
uncommitted edit, the answer adds the session diff, labeled as such.

`askCodebase`: add a `history_search` `RlmToolSpec` (`rlmToolLoop.ts`) so the plan/gather step can
pull changes, and let `answerSynthesis.ts` cite them as `[n] change: <file> @ <commit> <date>`. The
Jev gate can send "when/why/what changed" questions straight to history.

## 8. Server retention and pruning

Settings under `codeHistory` in `config/fantomMcpServer-config.json` (through `atomicWriteConfigFile`):

| Setting | Default | Rule |
|---|---|---|
| `retentionDays` | 365 | Delete `symbol_changes`, `file_changes`, `folder_changes` and their `history_vectors` rows older than this. |
| `minCommitsPerProject` | 50 | Never prune below this many commits per project. |
| `parsedBlobRetentionDays` | 90 | Delete a `parsed_blobs` row not used for this long. It is a cache; git still has the blob. |
| `keepCommitRows` | forever | `commits` rows are ~150 B; keep them and their commit summary. |

A nightly job (`src/history/historyPrune.ts`) runs under the heavy-job gate: delete,
`PRAGMA wal_checkpoint(TRUNCATE)`, `VACUUM` when free pages exceed 25%. Deleting a project cascades
by `project_id` in `history.db` (the main DB cascade does not reach this file, so `deleteProject`
must call `pruneProjectHistory(projectId)`). The project copy is never pruned by the server
(section 6.7). A pruned record that still exists in the project copy is re-imported only if the
user asks (`mirror/import` with `includeOld=true`).

One-off cleanup, outside this feature: the 114k noise rows in `api_changes` (runs with 5,000
`removed` and 0 `added`) can go after a backup of `fantom.db`.

## 9. Rebuild and repair

- Lost or corrupt `history.db`: delete it; boot creates the schema; the importer reloads every
  project copy (facts and summaries, state `imported`); the embedder refills `history_vectors`.
  The parse cache and cost data are gone; nothing else.
- Lost project copy (deleted folder, bad merge): `POST /admin/history/:projectId/mirror/rebuild`
  rewrites the mirror from the server store for the current branch (records whose commit is an
  ancestor of HEAD), sorted by `(at, id)`. This is the one operation that rewrites existing files;
  it is manual.
- Schema version in `manifest.json` (`schema`) and in each line (`v`). A reader that sees a higher
  `v` than it knows skips the line and logs. A writer never mixes versions in one file: a schema
  bump starts a new month directory, and old files are read with the old parser.
- `history.db` version in `user_version`; migrations are forward-only SQL in `src/history/migrations/`.

## 10. Dashboard

New page `dashboard/src/app/history/page.tsx`, one route, three panes:

1. Left: project picker (version-group aware, reuse the vector-viewer sidebar) and a folder tree
   with counts for the chosen range (`folder_changes`). Branch and author filters.
2. Top: time range, a commit strip (a new `CommitStrip`, modeled on `IndexRunStrip`), a thin
   "working tree" strip from the session store (diffs only, no summaries), a search box backed by
   `/admin/history/search`, and the mirror badge per repo (writable, read-only, pending catch-up,
   size).
3. Main: commits newest first. A commit shows its summary, author, subject, folders, then its file
   and symbol rows with summaries and change kinds. Click a symbol → drawer with the symbol's whole
   history (committed and, if any, the current uncommitted diff) and a before/after view from git
   blobs. Click a commit → the commit summary and a link to the month's `digest.md`.

Hooks into pages that exist: `ast-viewer` `TimelineSection` gets a "why" button per changed symbol
(`explainSymbolChange`); `vector-viewer` gets a "history" tab on a node.

## 11. Phased rollout

| Phase | Work | Touches |
|---|---|---|
| P0 Shared key and commit diff | `symbolKey()` / `nodeIdFor()` from `src/fantom-code/symbolKey.ts` (lazy-indexing D5) in the parser output, `relPath` relative to the owning git root (3.3, decided); `body_sha`; one `kind` vocabulary; parse-from-string; `git diff-tree` per commit; `parsed_blobs`; moved/renamed by body sha; checkout detection; `.fantomMCP/**` excluded from indexing; `RunDiff`/`CommitDiff`. | `codeIndexingService.ts`, parser output. Coordinate with the lazy-indexing agent: the key and `RunDiff` are where both designs meet. |
| P1 Server store | `src/history/historyDb.ts` (open, schema, `user_version`), `recordRunHistory`, `project_repos`, FTS. `historyRoutes.ts` read endpoints. Time-travel tools read `history.db` when it has rows. | new `src/history/`, `index.ts` tool wiring |
| P2 Summaries | `historySummarizer.ts`: batching, cache, budgets, role, redaction, usage cost, backfill endpoint. `explainSymbolChange` returns summaries. | new, `usage` |
| P3 Project copy | `historyMirror.ts` (write, lock, atomic files, digest, `.gitattributes`, `.gitignore`, README, manifest, per-repo roots), `historyImport.ts` (parse, dedupe, path filter, `mirror_files`), catch-up, mirror status endpoints. | new |
| P4 Vectors | `history_vectors`, `searchCodeHistory`, RLM tool, `/admin/history/search`. | `src/history/historySearch.ts`, `rlmToolLoop.ts`, `answerSynthesis.ts` |
| P5 Dashboard | `/history` page, working-tree strip, ast-viewer and vector-viewer hooks. | `dashboard/` |
| P6 Retention | prune job, settings, project-delete hook, archive action. Stop writing `api_changes`/`edge_changes` from the main path once every reader is on `history.db`; drop the tables after a backup. | `historyPrune.ts`, `codeIndexingService.ts` |

Tests: `src/__tests__/history*.test.ts` with an in-memory `better-sqlite3`, a temp git repo made
with `git init` + commits (nested repo case included), and a fixture `RunDiff`; mirror tests on a
temp dir (write, re-import, union-merged file with duplicates and a conflict marker, read-only dir);
summarizer tests mock `openRouterChat` (as `embedContextualizer` tests do). Run with `npm test`.

## Open questions

- Non-git projects: `none` (default) or `mtime-batches` as pseudo-commits (section 2.2).
- Fuzzy move/rename linking when the body changed in the same commit (section 3.3).
- Edge changes: keep `edge_changes` in the main DB (graph diff, used by `compareSnapshots`) or move
  them too? Proposal: move in P6 as `edge_changes` in `history.db`, same shape; not mirrored.
- Role name `code-history` needs a role on the SoundSuite master; until then `rlm-sandbox`.
- Rebase: the `commit` field in a mirror line can name a rewritten hash (section 6.4). Accept, or
  add a `supersedes` line type later.
