# Lazy, change-driven, task-based indexing

Status: proposal (research only, no code changed). Date: 2026-10-15, rev 3.1
(decisions folded in: stable symbol keys with the owning git root as the key
base, session diffs, nested git roots, memory budget).

Goal: keep the code graph and the vectors fresh over time without a full
rebuild. Git commits, merges and branch switches are the primary signal.
Uncommitted edits on the project being worked on are parsed from the dirty
tree and kept as diffs the AI can ask about. A slow mtime scan is the safety
net and the only path for folders without git. Parse only the changed files,
patch the graph by stable symbol key, embed only the symbols whose text
changed, hand the commit metadata to code history, and show the lag on the
dashboard.

Read-only sources for every claim below are given as `file:line`. Line numbers
are from the working tree on 2026-10-15. Companion design:
`docs/proposals/code-history.md` (history is a consumer of the runs this
design produces).

---

## 0. Decisions (2026-10-15)

| # | Topic | Decision | Section |
|---|-------|----------|---------|
| D1 | Uncommitted code | Parse the AST of dirty files: graph, search and vectors follow the working tree, so the AI sees the session's changes. No LLM summary for uncommitted code. Only committed code is summarized; code history applies the same rule. | 3.2.4, 3.9 |
| D2 | Hooks | Opt-in per project, with a per-install access token. Off by default. | 3.2.8 |
| D3 | Nested git | Each repo tracks its own files. The longest git root that prefixes a path owns it. The outer root's watcher and diffs exclude paths an inner `.git` owns; the inner repo gets its own watcher and base commit. | 3.2.11 |
| D4 | Large change set | Automatic full reindex, no approval step. Priority 90, behind the heavy-job lock and the credit cap. | 3.2.6 |
| D5 | Symbol ids | Stable symbol keys with no line numbers: `symbolKey = sha1(relPath \| qualified name [\| parameter signature for overloads] [\| ordinal as a last resort])`, store id `nodeIdFor(projectId, key)`. **`relPath` is relative to the owning git root (longest root wins) when the file is inside a repo, and to the project root otherwise**, so the committed `.fantomMCP` mirror key is identical in every clone, including a nested repo or a repo subfolder cloned or indexed alone. Line shifts keep the id. Renames and moves are found by `body_sha` and linked to the old key. Existing vectors are re-keyed through the text-hash embedding cache (zero provider calls); a re-embed happens only on a cache miss. One key shared with code history's `symbol_key`. A project that later gains or loses a `.git` re-keys the files whose base changed, linked old → new in `symbol_links`. | 3.8 |
| D6 | Embedding cache | LanceDB on disk, never loaded whole into memory. LRU by last use. Cap = `min(2 GB, 10 % of free disk)`, configurable. Prune only when no heavy job runs. An RSS/heap guard pauses the queue; every new component has a bounded memory budget. | 3.5, 3.10 |
| D7 | Session changes | Compare edit times **and** keep the changes as diffs: a unified diff per file against the last indexed content plus a symbol-level AST diff per key. Exposed as an MCP tool (`getSessionChanges`, "what changed since `<commit or time>`"). Retention: until the next commit plus N days. | 3.9 |
| D8 | Defaults chosen here (not asked) | Safety-net scan for git projects: 30 min. Dirty-tree watch: the primary project only. Both configurable (`scan.gitIntervalMs`, `dirty.projects`). | 3.2.4, 3.2.5 |

---

D9 (2026-10-16): the server tracks a **focus set** of files the MCP is working
on (fresh answers, dirty-watch scope, related-code suggestions), and AI clients
**report their changes** through a `reportChanges` MCP tool, made automatic
with a Claude Code `PostToolUse` hook. Both are hints; the hash gate decides.
Lands as Phase 1b. See 3.11.

D10 (2026-10-17): Axon embedding embeds only changed functions, runs at boot
only when something changed, holds the heavy-job lock per project, and every
lock refusal says what is running. Lands in Phase 4. See 3.12.

## 1. What exists today

### 1.1 Entry points and triggers

- `runIndex()` is the single entry point for a project run
  (`src/fantom-code/runIndex.ts:60`). It calls
  `CodeIndexingService.indexProject()` and then, unless a heavy job owns the
  fleet, `buildProjectEmbeddings()` in the background (`runIndex.ts:145-179`).
  If a heavy job is active the embed step is skipped with a log line
  "deferred — the watchdog embeds it later" (`runIndex.ts:165-169`).
- `IndexTrigger` lists `'auto' | 'watch' | 'file-watch'` (`runIndex.ts:28-33`,
  `codeIndexingService.ts:65`). **No code path uses them.** A grep for
  `trigger: 'auto'`, `'watch'`, `'file-watch'` in `src/` returns nothing. The
  live triggers are `manual` (boot drain, `src/index.ts:811`), `admin-reindex`
  (`src/index.ts:2554, 2605`), `mcp-add`, `mcp-refresh` (`src/index.ts:5336,
  5380`) and `mcp-incremental` (`src/index.ts:5507`).
- Boot: projects with `autoIndex` are hydrated from LadybugDB
  (`src/index.ts:617, 686-698`). A project that hydrates is **not rescanned**.
  Only projects with an empty or bad graph go to `pendingFirstParse` and run
  `runIndex` with `trigger: 'manual'` (`src/index.ts:700-711, 801-830`). Edits
  made while the server was down are never picked up by themselves.
- There is no file watcher for project source. The only `fs.watch` in the
  server watches `workflows/*.md` (`src/workflows/workflowManager.ts:249`).
  `chokidar` and `@parcel/watcher` are not dependencies (`package.json`).
- Git is already shelled out to in three places, all read-only and none a
  trigger: HEAD and branch per run (`codeIndexingService.ts:378-403`, stored
  in `index_runs.git_commit` / `git_branch`), `git log -1` and
  `git diff --name-only` in `src/graph/stalenessChecker.ts:65, 87`, and the
  diff helper `getChangedFiles()` in `src/graph/changeDetector.ts:63`.
- Fleet shape (read-only query on `.cache/fantom.db`, 2026-10-15): 341
  auto-index projects. 330 have no `.git` above them (SkySpark pod sources,
  extracted builds). 11 git roots, one project each, all with `.git` as a
  directory (no worktree, submodule or nested repo today). Git covers the
  projects people edit; the scan covers the rest by count.
- Change-history MCP tools already exist and read `api_changes` /
  `index_runs`: `whatChangedRecently`, `getSymbolHistory`, `diffByTime`,
  `explainSymbolChange`, `getApiChangeHistory`, `diffIndexRuns`
  (`src/index.ts:2019-2142`). None sees uncommitted edits as a diff.

### 1.2 The hash gate

`indexProject()` (`codeIndexingService.ts:189`) scans, then compares every file
against `indexed_files` (`codeIndexingService.ts:337-372`):

- If `mtime_ms` and `byte_size` match the stored row, the file is marked
  unchanged without a read (`:352-355`).
- Otherwise it reads the file, computes sha256, and marks it changed when the
  sha differs (`:356-361`).
- Removed files = stored rows with no scanned path (`:370-372`).
- If nothing changed and `force` is false, the run short-circuits and records
  an `IndexRun` with `filesSkipped = files.length` (`:409-446`).

If **anything** changed, the run does **not** use `changedFiles` further. It
parses **every** file (`:580-588`, loop over `files`), clears the in-memory
indexer (`:644`), and calls `buildLadybugGraph(project.id, parsedFiles)` with
the default `clearProject = true` (`:663`,
`src/graph/ladybugGraphBuilder.ts:122, 133-134`). This is the "full rebuild for
one changed file" problem.

`indexed_files` schema (`prisma/schema.prisma`, model `IndexedFile`):
`project_id, file_path, mtime_ms, content_sha256, byte_size, symbol_count,
indexed_at`, unique on `(project_id, file_path)`. There is **no parser or
extractor version** in the row. A parser change leaves the gate closed, so the
only way to re-parse was to delete rows by hand.

### 1.3 The incremental path that already exists

`reindexFiles({ projectId, paths })` (`codeIndexingService.ts:965-1310`) is the
MCP `reindexChangedFiles` tool. Per call it:

1. Snapshots old symbols for the given paths from LadybugDB (`:1040-1057`).
2. `clearFileGraph(projectId, fp)` for each path (`:1060-1070`,
   `src/graph/ladybugSchema.ts:191-220`). This deletes the file's nodes and
   **both** incoming and outgoing edges.
3. Parses only those paths (`:1076-1105`), updates the in-memory indexer
   (`:1108-1112`), and calls `buildLadybugGraph(..., { clearProject: false })`
   (`:1119`).
4. Diffs symbols, writes `ApiChange` rows, upserts `indexed_files` (`:1130-1202`).
5. Re-embeds the nodes of the changed files inline, bypassing
   `buildProjectEmbeddings` (`:1245-1290`). It deletes only the file-level
   synthetic vector of removed paths (`:1279`). `storeEmbeddings` replaces rows
   with the same `node_id` (`src/embedding/vectorStore.ts:296-302`).

Two correctness gaps in this path:

- **Cross-file edges are lost.** `LadybugGraphBuilder.resolveReference`
  (`ladybugGraphBuilder.ts:499-540`) only looks in `nodeByQualifiedName`, which
  is filled by the nodes created in **this** run (`:248, :325`). With
  `clearProject: false` the map does not contain the rest of the project, so
  every call from a changed file into an unchanged file is counted as
  "unresolved", and the incoming edges deleted by `clearFileGraph` are never
  recreated.
- **Node ids move with lines.** `generateFunctionId`/`generateTypeId` hash
  `filePath:qualifiedName:lineNumber` (`src/fantom-code/types.ts:275-292`).
  An edit near the top of a file changes the id of every symbol below it. Old
  vectors keep the old `node_id` and become orphans (the code comment at
  `codeIndexingService.ts:1237` says so). New ids have no vector until
  something embeds them. The generators are used by seven files:
  `types.ts`, `codeParser.ts`, `trioParser.ts`, `treeSitterAdapter.ts`,
  `fantom-code/index.ts`, `graph/ladybugSchema.ts`,
  `graph/ladybugGraphBuilder.ts`.

### 1.4 Embedding, locks, watchdogs, memory

- Heavy-job lock: `src/embedding/embedGate.ts`. Kinds `code-reembed |
  code-reindex | axon-index` (`:49`). `acquireHeavyJob` throws
  `HeavyJobBusyError` when busy (`:110-116`); `waitForHeavyJob` queues FIFO
  with a 5 s safety poll (`:125-158`). `getHeavyJob()` / `isHeavyJobActive()`
  are the read side (`:162-171`).
- Embed semaphore: `semanticSearchService.ts:55-80`. Process-wide, limit =
  `semanticSearch.parallelProjects` (1..8, default 1).
- `buildProjectEmbeddings(projectId)` (`semanticSearchService.ts:790`) reads
  all node ids with a vector (`:975-983`) and embeds the rest. It aborts a
  batch loop when a heavy job appears and reports the rest as `yielded`
  (`:1111-1122`).
- Embed-missing watchdog (`src/embedding/autoPipelineBus.ts:386-427`): every
  60 s, needs 2 consecutive "missing" hits and a 5 min gap, then starts the
  auto-embed pipeline. The pipeline stands down when a heavy job or a shadow
  re-embed is active (`src/admin/routes.ts:10125-10130`). Per-project failure
  back-off is 1 min doubling to 1 h (`routes.ts:10109-10111`).
- Embedding text layout version: `EMBED_TEXT_VERSION = 4`
  (`src/embedding/embeddingText.ts:61`), recorded per project by
  `recordEmbedTextVersion` (`src/embedding/embedTextVersions.ts:38`). This is
  the only "version in the data" today, and it covers vectors, not parsing.
- Embed text content (`embeddingText.ts:28-40, 121-174, 340`): kind line,
  a header with the last path segments and the file's import specifiers,
  graph context (`calls: …; called by: …`), the qualified name, signature,
  doc and the body sliced by line range. The text contains **no line
  numbers** and no absolute path. So a line shift leaves the text unchanged;
  a rename, a move to another file, or a change in callers changes it.
- Memory: the server runs at about 1.1 GB RSS. A 4 GB RSS guard has killed it
  before (exit 137, `embedGate.ts:10`). The graph pool holds at most
  `FANTOM_GRAPH_MAX_OPEN` = 8 connections (`projectGraphConnection.ts:84-87`);
  too many opens under load caused a native SIGSEGV (memory
  `ladybug-segv-pool-evict-under-load`). RSS/heap are already logged per
  embed batch (`semanticSearchService.ts:816, 1129-1179`) and per graph pool
  event (`projectGraphConnection.ts:566-568`); nothing acts on them.

### 1.5 What the dashboard shows

- `GET /admin/code-projects/:id/index-runs` (`routes.ts:3183`) returns the last
  N `index_runs` rows (`trigger, filesParsed, durationMs, addedCount ...`).
  `dashboard/src/lib/api.ts:2278` wraps it. No page draws it over time.
- `GET /admin/vectors/stats` (`routes.ts:8686`) gives per-project
  `nodeCount, vectorCount, embeddedAt` and a coverage percent. The vector
  viewer shows coverage (`dashboard/src/app/vector-viewer/page.tsx:738, 816`)
  and polls every 30 s (`:311`).
- `getIndexHealth` (`src/fantom-code/indexHealth.ts:52`) reports
  `missingFromGraph / missingFromVectors / missingFromSearch` for one project
  on demand. Nothing is stored as a time series. There is no "freshness lag"
  and no queue view.

### 1.6 Other pieces to reuse

- Scanner include list and excludes: `src/fantom-code/scanner.ts:17-29`,
  `src/fantom-code/excludeDirs.ts:15, 53` (gitignore aware).
- Markdown already parses through `treeSitterAdapter.ts:371`
  (`parseMarkdownFile`).
- `index_runs` stores `git_commit` and `git_branch` per run
  (`codeIndexingService.ts:378-403`).
- Per-project node count snapshot: `.cache/projectNodeCounts.json`
  (`src/graph/projectNodeCounts.ts:51`).
- Admin route modules outside `routes.ts` have a precedent:
  `src/admin/workflowRoutes.ts`.
- Hand-written Prisma migrations: `prisma/migrations/0_init`,
  `1_project_dependencies`. Apply with `migrate deploy` / `db push`, never
  `migrate dev` (CLAUDE.md safety rail).
- The server logs its own fd count every tick (`src/index.ts:84-88`), useful
  once watchers are added.
- LanceDB writes go through one queue (`src/embedding/vectorWriteQueue.ts:77`,
  `enqueueTableWrite`).

---

## 2. Gaps, in one table

| # | Gap | Where |
|---|-----|-------|
| G1 | No change detection runs on its own. `auto/watch/file-watch` triggers are declared, never fired. Git is read for metadata only. | `runIndex.ts:28-33`, `index.ts:698`, `codeIndexingService.ts:382` |
| G2 | One changed file re-parses every file and rebuilds the whole graph. | `codeIndexingService.ts:588, 644, 663` |
| G3 | Parser or extractor changes do not reopen the hash gate. | `IndexedFile` model, `codeIndexingService.ts:352` |
| G4 | `reindexFiles` drops cross-file edges (incoming and outgoing). | `ladybugSchema.ts:212-216`, `ladybugGraphBuilder.ts:499` |
| G5 | Node ids move with line numbers; old vectors become orphans; new ids wait for the watchdog. Decided: stable keys (D5, 3.8). | `types.ts:275-292`, `codeIndexingService.ts:1237` |
| G6 | Embedding after a run is "fire and forget": deferred when a heavy job runs, then picked up by a 60 s watchdog with a 5 min gap. No durable record of what is owed. | `runIndex.ts:165`, `autoPipelineBus.ts:382-384` |
| G7 | No time series: vectors per run, lag, queue depth. | `routes.ts:3183, 8686` |
| G8 | Code history will need commit, author and subject per file; today it would have to run git on its own. | `code-history.md` 2.1 |
| G9 | Uncommitted edits are invisible as diffs: the AI cannot ask "what changed in this session". | `src/index.ts:2019-2142` |
| G10 | Nothing bounds memory for background work; the only guard is the 4 GB kill. | `embedGate.ts:10` |

---

## 3. Design

### 3.1 Overview

```
 <gitDir>/HEAD, <gitDir>/logs/HEAD ──▶ GitWatcher ───┐  primary: commit, merge, pull, switch, rebase
 source-tree fs events            ──▶ DirtyWatch  ───┤──▶ ChangeSet ──▶ TaskQueue ──▶ Workers ──▶ index_runs
 timer (5 min scan / 30 min git)  ──▶ MtimeScan   ───┤                 (SQLite)    ▲  retry      history (RunDiff)
 post-commit hook (opt-in)        ──▶ /admin/indexing/git-event ──┘               └─ yield      session diffs
                                                                        heavy-job lock, memory guard, credit cap
```

Three sources, one `ChangeSet` shape, one gate. Order of trust: git commit
diff, then dirty-tree status, then the mtime/sha scan. Every source ends in
the same gate (mtime + size, then sha against `indexed_files`, plus the
version check of 3.6), so one set of bytes is never parsed twice whatever the
source that named the file. Every step is a row in `index_tasks`, so a
restart, a heavy job or a sidecar outage only delays work; it never loses it.

### 3.2 Change detection

```ts
interface ChangeSet {
  projectId: number;
  rootId: number | null;           // git root that owns these paths; null for scan-mode projects
  source: 'git' | 'dirty' | 'mtime' | 'sha' | 'version' | 'forced';
  added: string[];                 // on disk, no indexed_files row
  modified: string[];              // row exists, bytes or version differ
  removed: string[];               // row exists, file gone
  renamed: Array<{ from: string; to: string; similarity: number }>;
  unchanged: number;
  git?: GitContext;                // 'git' and 'dirty'; also 'mtime' on a git project
  scannedAt: string; scanMs: number;
}
interface GitContext {
  root: string; gitDir: string; gitCommonDir: string;
  fromCommit: string | null;       // last indexed commit; null on the first git-aware run
  toCommit: string;                // HEAD now
  branch: string | null;           // null when detached
  headMove: HeadMove;              // 3.2.3
  dirty: boolean;                  // working tree had changes when the set was built
  commits: CommitMeta[];           // oldest first, capped (3.2.7); [] for 'dirty'
}
interface CommitMeta { sha: string; parents: string[]; author: string; authorTime: number; subject: string; files: string[] }
interface HeadMove { kind: 'none' | 'edit' | 'integrate' | 'rewrite' | 'switch' | 'unknown'; reflog: string; linear: boolean }
```

#### 3.2.1 Git roots and the watcher

Module `src/indexing/gitWatcher.ts`, root registry in
`src/indexing/gitRoots.ts`. No hook is installed by default; the watcher reads
what git writes anyway.

Resolution, once per project at boot and again when a project is added, its
path changes, or a scan meets a new `.git` entry (3.2.11):

1. Walk up from `project.path` to the first entry named `.git`. None → the
   project is `mode: 'scan'` (3.2.5).
2. One spawn: `git -C <root> rev-parse --show-toplevel --git-dir
   --git-common-dir` (about 20 ms). It resolves the three layouts:
   - plain repo: `gitDir = <root>/.git`, `gitCommonDir` the same;
   - linked worktree: `.git` is a file `gitdir: /main/.git/worktrees/<name>`;
     `HEAD` and `logs/HEAD` live in that directory, objects and refs in
     `gitCommonDir`;
   - submodule: `.git` is a file `gitdir: ../.git/modules/<name>`; same rule.
     A superproject commit that bumps the submodule pointer does not change
     the submodule's tree until `git submodule update` moves the submodule's
     own HEAD, which its own watcher sees.
3. Register the root in `git_roots` (3.2.9) and map the project to it. Pods
   of one repo become several projects under one root and share one watcher.
   Inner repos get their own root with `parentRootId` set (3.2.11).

Watch the directories, not the files: `fs.watch(gitDir, { persistent: false })`
and `fs.watch(path.join(gitDir, 'logs'), ...)`, filter `filename === 'HEAD'`.
Git writes `HEAD` through `HEAD.lock` plus rename, so a watcher on the file
can lose the inode on macOS (kqueue); a watcher on the directory sees the
rename. `logs/HEAD` is appended in place. Two fds per root. A third,
non-recursive watcher on `root` filtered to `.git` catches a worktree or
submodule `.git` file that appears or changes after boot and triggers a
re-resolve.

Debounce: `git.debounceMs` (default 1 000) after the last event. While an
operation is in progress (`<gitDir>/rebase-merge`, `rebase-apply`,
`MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG` exist) the event
waits and re-checks every `git.inProgressPollMs` (5 s). A rebase with 50
picks then yields one event, not 50.

Above `git.watch.maxRoots` (default 200) the extra roots are polled: one
`stat` of `logs/HEAD` per root every `git.pollMs` (10 s). The fd count is in
the server's own tick log (`src/index.ts:84-88`), so a leak is visible.

Boot: for every root compare HEAD with each project's `last_indexed_commit`
(3.2.9). Different → 3.2.2 runs at once. This closes G1 for committed work
done while the server was down; the dirty check (3.2.4) closes it for
uncommitted work on the active project.

#### 3.2.2 From a HEAD move to a change set

Module `src/indexing/gitChangeSource.ts`. All git calls are read-only, run
with `execFile` (no shell, `maxBuffer` 64 MB), one at a time per root,
`git.concurrency` (2) across roots, and retried `git.retries` (5) times every
`git.retryMs` (2 000) on `index.lock` contention with the user's own git.

On a settled event, per root:

1. `git rev-parse HEAD` → `toCommit`; `git symbolic-ref -q --short HEAD` →
   branch, or `null` when detached.
2. Per (project, root) pair under the root: `fromCommit =
   last_indexed_commit`. `fromCommit == toCommit` → nothing to index (HEAD
   moved and came back, or `checkout -b` with no new commit). Only the branch
   name is updated. `fromCommit == null` → the project was never indexed
   through git: a seeding run goes through the scan, then
   `last_indexed_commit = toCommit`.
3. `git cat-file -e <fromCommit>^{commit}`. Missing (gc after a force-push,
   a shallow boundary that moved, a rewritten history) → sha scan (3.2.5) with
   `source: 'sha'`; afterwards `last_indexed_commit = toCommit`.
4. One diff for the root: `git diff --name-status -M -z <fromCommit>
   <toCommit> -- <project paths under the root> ':(exclude)<inner root>/'…`
   (one exclude per inner root, 3.2.11). Split the entries per project by
   longest path prefix (a nested project owns its files). Map the status
   letters: `A` added, `M` and `T` modified, `D` removed, `R<n>` renamed
   (from, to, similarity n), `C<n>` added (the copy), `U` unmerged → the
   operation is still in progress, drop the event and let 3.2.1 re-check.
   Paths outside the scanner's include list (`scanner.ts:17-29`) or under an
   exclude dir (`excludeDirs.ts:15`) are dropped here. A submodule path shows
   as `M` with mode 160000 and is not a file: dropped.
5. Classify the move (3.2.3) and build `commits` (3.2.7) in one `git log`.
6. Emit one `ChangeSet` per project, `source: 'git'`; the scheduler enqueues a
   `parse` task with `trigger: 'git'` (a new `IndexTrigger` value,
   `runIndex.ts:28-33`). Priority 10 for the primary project, 50 otherwise,
   90 for a `switch` (3.2.3).
7. `last_indexed_commit` moves to `toCommit` only when the chain parse →
   graph-patch finished without hard errors. A failed task leaves it, so the
   next event diffs from the same base and nothing is lost. The embed stage
   does not gate it: vectors have their own ledger (`vector_state`, 3.5).

Is `index_runs.git_commit` enough as "last indexed commit"? No. It records
HEAD at the start of **any** run: runs the gate skipped, runs that failed,
dirty-tree runs that never saw that commit's tree, and scan-driven runs that
never diffed. It has no "from" side, and a root with several projects would
need the last row per project anyway. Keep it as the per-run record (the
anchor `code-history.md` 2.1 builds on) and add a per-(project, root)
`project_git_state` row (3.2.9) for the base of the next diff.

Renames: graph = remove the symbols of `from`, parse `to` (3.4). Keys change
because the relative path is in the key (3.8); `body_sha` links the new key
to the old one. Vectors follow 3.5. `indexed_files`: delete `from`, upsert
`to`. The `RunDiff` gets `kind: 'renamed', fromPath` as `code-history.md`
2.5 already defines.

#### 3.2.3 Classify the HEAD move

`logs/HEAD` lines are `<old-sha> <new-sha> <ident> <ts> <tz>\t<message>`. The
watcher reads the last `git.reflogTail` (64) lines and takes those newer than
`git_roots.last_reflog_ident` (`<ts> <new-sha>` of the last consumed line).
The newest line's message gives the kind; one ancestry check gives the
shape: `git merge-base --is-ancestor <fromCommit> <toCommit>` → `linear`.

| Reflog message starts with | kind | Notes |
|---|---|---|
| `commit:`, `commit (initial):`, `cherry-pick:`, `revert:`, `am:` | `edit` | the normal case |
| `commit (amend):`, `rebase (finish):`, `rebase -i (finish):`, `pull --rebase (finish):`, `rebase (abort):` | `rewrite` | history rewritten; the file diff is still exact because `git diff` compares trees |
| `commit (merge):`, `merge <x>:` (Fast-forward or Merge made by ...), `pull:` | `integrate` | can touch many files; the share threshold (3.2.6) applies |
| `checkout: moving from`, `reset: moving to`, `Branch: renamed`, `clone:`, `initial pull` | `switch` | not an edit |
| `rebase (start|pick|reword|edit|squash|continue):`, `pull --rebase (start|pick):` | ignored | intermediate; the in-progress check in 3.2.1 holds the event until the final line |
| anything else | `unknown` | handled as `switch` for safety |

Ancestry overrides the message in one direction: `edit` or `integrate` with
`linear = false` (an amend, a reset, a force-pulled branch) becomes
`rewrite`. A `switch` stays a `switch` even when linear (a fast-forward
`checkout` of a branch ahead of the old one is still a switch for the user).
This is the `checkout` definition in `code-history.md` 2.1 ("HEAD is not a
descendant of the previous run's commit"), with the reflog as the second
signal.

Consequences of a `switch` (and of a `rewrite` whose diff touches more than
`git.rewriteAsSwitchFiles`, default 50, files):

- priority 90, so live edits on another project go first;
- the graph and the vectors still follow the tree: removed files are cleared,
  added files parsed. A stale symbol in search is worse than a slow switch;
- `RunDiff.checkout = true`: history writes the run row and counts only, no
  "removed" records, no summaries, no mirror write (`code-history.md` 5.5);
- the share threshold (3.2.6) may turn it into a `full-reindex`;
- vectors of symbols that vanish stay in the embedding cache (3.5), so
  switching back costs no provider call;
- session-diff rows of the old branch are closed (3.9).

A detached HEAD has `branch = null` and is classified the same way. A checkout
of a tag or a sha is a `switch`. `git stash`, `git restore`, `git checkout --
<file>` change the tree without moving HEAD: the dirty watcher (3.2.4)
handles them.

#### 3.2.4 Uncommitted edits (dirty tree)

People and AI agents edit live; a commit may come hours later or never. The
working tree of the project being worked on is parsed before the commit, so
the graph, FlexSearch and the vectors show the session's state (D1). What is
**not** done for dirty code: LLM summaries. The `RunDiff` carries `git.dirty
= true`; history records the run without summaries and summarizes the same
files when the commit event arrives (3.2.7). The unified and symbol diffs of
the session are kept by 3.9.

- Scope (D8): `dirty.projects` = `'primary'` by default (the primary project
  from `config/fantomMcpServer-config.json`). Other values: an explicit list
  of project ids, or `'active'` (every git root whose source tree had an fs
  event in the last `dirty.activeWindowMs`, 30 min, capped by
  `dirty.watchRoots`, 20). Source-tree watch: `fs.watch(root, { recursive:
  true })`, one FSEvents stream per root on macOS (cheap, no per-directory
  fd). On Linux it is one inotify watch per directory, which is why the
  default is one project. Events under `.git/`, under an inner root
  (3.2.11), under an exclude dir, or for an extension the scanner does not
  include do not count.
- An event starts a `dirty.debounceMs` (2 000) timer; at most one status call
  per `dirty.minIntervalMs` (5 000) per root.
- Status: `git status --porcelain=v2 -z --untracked-files=all`. It respects
  `.gitignore`; 50-300 ms on 10k tracked files (`core.untrackedCache` and
  `core.fsmonitor` in the user's repo make it faster; not required). The
  output is a candidate list, not the truth: the gate (mtime + size, then sha
  against `indexed_files`) decides what is new to the index. Entry types `1`
  (changed), `2` (renamed), `?` (untracked) are candidates; `u` (unmerged) is
  skipped. Git lists an inner repo as one `?` directory entry and does not
  descend into it: those paths belong to the inner root anyway.
- Reverts: the last candidate set is kept in `project_git_state.dirty_paths`
  (capped at `dirty.maxPaths`, 5 000; above it the run is a scan). A path
  that was dirty last time and is clean now (`git checkout -- f`, `git
  stash`, an editor undo) is still a candidate: its bytes changed back, and
  the gate sees a sha that differs from `indexed_files`. Without this rule a
  revert leaves the index on the edited version.
- Output: `ChangeSet` with `source: 'dirty'`, `git.dirty = true`,
  `commits: []`, `fromCommit = toCommit = HEAD`, trigger `'file-watch'`,
  priority 10 for the primary project. Dedupe (3.3) merges a burst of saves
  into one pending `parse` row.

How a dirty run relates to the next commit: the commit event (3.2.2) lists the
same files; the gate finds mtime, size and sha equal to what the dirty run
stored, so `parse` has nothing to do (`filesSkipped`), no graph patch, no
embed. The run row is still written with the commit metadata, and the
`RunDiff` lists those files with their `kind` and
`indexedFromWorkingTree: true`, so history can attach commit, author and
subject to the records it wrote at dirty time and run its summaries now
(`code-history.md` 5.5 keeps uncommitted records per branch; this is the
handshake that closes them). Only files the dirty run did not see (another
agent's commit, a merge, a save after the last status) are parsed; a commit
that holds version 2 when the dirty run saw version 1 is caught by the sha
like any edit.

#### 3.2.5 Fallbacks

| Case | Detection | Interval |
|---|---|---|
| No `.git` above the project (330 of 341 today); network share; `git` binary missing (`git --version` probed once at boot); `core.logAllRefUpdates=false` | mtime scan: `stat` every file, sha256 only when mtime or size moved; the same gate as today (`codeIndexingService.ts:346-372`), moved to `src/indexing/changeDetector.ts` and returned as a `ChangeSet` with `source: 'mtime'` | `scan.intervalMs` 300 000 (5 min), staggered per project, `scan.concurrency` 2 |
| Git project, safety net (a missed event, a dead watcher, a tool that writes the tree without git such as an unzip or an rsync) | same mtime scan; `git` context is `fromCommit = toCommit = HEAD`, `commits = []` | `scan.gitIntervalMs` 1 800 000 (30 min, D8) |
| Old commit missing (gc, force-push, shallow boundary); diff fails; `U` entries persist | sha scan: read and hash every file, compare with `indexed_files.content_sha256`; `source: 'sha'` | on demand; also `POST /admin/indexing/scan/:id?full=1` |
| mtime not reliable (Docker volume, rsync without `--times`, coarse filesystem) | `scan.shaAlwaysProjects` lists the project: every scan is a sha scan | as scan |

Cost of the mtime scan: 20-50 µs per `stat` on APFS; 10k files ≈ 0.3-0.5 s,
100k ≈ 3-5 s. `indexed_files` rows are read in pages of `scan.pageRows`
(5 000), so memory is bounded per project (3.10). The git diff is tree based:
its cost follows the size of the two trees, not the length of the history.

#### 3.2.6 Debounce, coalescing, thresholds

- Per project, one pending `parse` row at a time (dedupe key, 3.3). A new
  **git** change set replaces the pending payload: it is always diffed from
  `last_indexed_commit`, so the newest one is complete. A new **dirty** or
  **scan** change set is unioned into it.
- A scan or status call never runs while a `parse` for the same project is
  `running`; it waits for the next tick.
- `maxChangedShareForIncremental` (0.4): more than 40 % of the project's files
  in one set (branch switch, new pod version extracted over the tree) → a
  `full-reindex` task instead of a patch. **Automatic (D4)**: no approval
  step. Priority 90, so it waits behind live work; it yields while a heavy
  job holds the lock; its embed stage is an ordinary `embed` task under the
  credit cap (3.3), so a big switch spreads its provider calls over hours
  instead of refusing. The dashboard shows the pending count (3.7).
- `git.maxFilesPerDiff` (5 000): above it the set becomes a `full-reindex`
  without a per-file list in the payload.
- `git.maxCommitsPerRun` (500): above it `commits` keeps the newest 500 and
  the move is forced to `switch` (counts only). 500 commits in one move is a
  first pull or a branch switch, not editing.
- A `full-reindex` in this design rebuilds the **graph** and leaves the
  vectors in place (`indexProject({ force: true, keepVectors: true })`, a
  new option). With stable keys (3.8) most nodes keep their id and their
  vector; the embed task reconciles the rest. Today's force path deletes the
  project's vectors first (memory `forced-reindex-drops-vectors`); that
  behaviour stays only for the explicit admin "drop and rebuild".

#### 3.2.7 Interplay with code history

Same event, one git call. After the diff, one
`git log --format=%H%x1f%P%x1f%an%x1f%at%x1f%s --name-only
<fromCommit>..<toCommit> -- <project paths> ':(exclude)<inner root>/'…` (the
call `code-history.md` 2.1 planned to run itself) fills `GitContext.commits`
with sha, parents, author, author time, subject and the files per commit,
filtered per project. For a merge the `-m --first-parent` question is left to
history: the design passes what `git log` lists by default and the parents,
so history can pick.

The `parse` worker hands the context through to the run's `RunDiff`
(`src/history/recordRunHistory.ts`, `code-history.md` 2.5), called after the
run row has `finishedAt` and before the embed task starts: `git.commit =
toCommit`, `git.branch`, `git.dirty`, `git.headTime` (author time of
`toCommit`), `checkout = headMove.kind === 'switch'`. Additions this design
asks for in `RunDiff`:

- `git.fromCommit: string | null` and `git.headMove: HeadMove`;
- `git.commits: CommitMeta[]`, so `FileDiff.at` (change time), author and
  subject per file come from the last commit in `commits` that lists the
  path. History never runs `git log` on its own;
- `FileDiff.indexedFromWorkingTree?: boolean` (3.2.4);
- `SymbolDiff.key` is the stable key of 3.8, the same value history stores as
  `symbol_key`; `SymbolDiff.linkedKey?: string` for a rename or move found by
  `body_sha`.

For `source: 'dirty'` runs `commits` is empty and `git.dirty = true`; history
records `at = mtime_after` as it already plans and does not summarize (D1).
For a `rewrite` the flag is in `headMove.kind`; what history does with an
amended commit is its call.

#### 3.2.8 Optional post-commit hook (opt-in, D2)

The reflog watcher sees every commit within `git.debounceMs`. A hook wins
only that second, and covers a root the watcher cannot see (above the cap, a
remote mount with no fs events). It writes into the user's repo, so it is
opt-in per project: `POST /admin/indexing/hook/:projectId` installs,
`DELETE` removes, state in `git_roots.hook_installed`. Module
`src/indexing/gitHooks.ts`.

Install:

- target dir = `git config core.hooksPath` when set (husky, lefthook), else
  `<gitCommonDir>/hooks`. A hook of that name that exists and has no marker
  gets a marked block appended; else a new file with the marker and
  `chmod 755`. Files written: `post-commit`, `post-merge`, `post-checkout`,
  `post-rewrite` (same one-liner; they cover the moves of 3.2.3 that are not
  plain commits).
- the block, keyed by root so several worktrees of one repo can share the
  hooks directory:

  ```sh
  # >>> fantom-mcp <root> >>>
  curl -s -m 2 -X POST "http://localhost:3848/admin/indexing/git-event" \
    -H "X-Fantom-Hook: <token>" -H "Content-Type: application/json" \
    -d '{"root":"<root>"}' >/dev/null 2>&1 || true
  # <<< fantom-mcp <root> <<<
  ```

  `-m 2` and `|| true`: git never fails or waits because of the server. Host
  and port come from the server's own listen config at install time.
- the token is generated per install (32 random bytes, hex), stored hashed
  in `git_roots.hook_token_hash`; the clear value is written into the hook
  block only. The endpoint accepts only a known root whose hash matches. It
  runs 3.2.2 for that root with no debounce. No Basic Auth: a hook cannot
  hold the dashboard password; the token is the credential. Remove rotates
  the row to `NULL`, so an old block cannot trigger anything.
- remove: delete the marked block; delete the file when nothing but the
  shebang is left.
- server down: the ping is lost, nothing is queued on the git side. The
  reflog watcher sees the move at the next boot (3.2.1). Nothing to replay.

#### 3.2.9 Schema: `git_roots` and `project_git_state`

```prisma
model GitRoot {
  id               Int       @id @default(autoincrement())
  root             String    @unique                     // absolute, resolved
  gitDir           String    @map("git_dir")             // worktree and submodule aware
  gitCommonDir     String    @map("git_common_dir")
  parentRootId     Int?      @map("parent_root_id")      // inner repo → the root that contains it (3.2.11)
  lastHeadSeen     String?   @map("last_head_seen")      // HEAD at the last event, even if the run failed
  lastReflogIdent  String?   @map("last_reflog_ident")   // "<ts> <new-sha>" of the last reflog line consumed
  lastHeadMove     String?   @map("last_head_move")      // JSON HeadMove
  hookInstalled    Boolean   @default(false) @map("hook_installed")
  hookTokenHash    String?   @map("hook_token_hash")
  gitError         String?   @map("git_error")           // last git failure, shown on the dashboard
  watchMode        String    @default("fsevents") @map("watch_mode") // fsevents | poll | off
  updatedAt        DateTime  @updatedAt @map("updated_at")

  parent   GitRoot?  @relation("NestedRoots", fields: [parentRootId], references: [id], onDelete: SetNull)
  children GitRoot[] @relation("NestedRoots")
  states   ProjectGitState[]

  @@index([parentRootId])
  @@map("git_roots")
}

model ProjectGitState {
  projectId          Int       @map("project_id")
  rootId             Int       @map("root_id")             // one row per (project, root); an inner repo adds a row
  subPath            String    @default("") @map("sub_path") // project path relative to the root ("" = the root itself)
  lastIndexedCommit  String?   @map("last_indexed_commit") // base of the next diff
  lastIndexedBranch  String?   @map("last_indexed_branch")
  dirtyPaths         String    @default("[]") @map("dirty_paths") // JSON string[], last status candidates
  lastDirtyAt        DateTime? @map("last_dirty_at")
  lastScanAt         DateTime? @map("last_scan_at")
  updatedAt          DateTime  @updatedAt @map("updated_at")

  project FantomProject @relation(fields: [projectId], references: [id], onDelete: Cascade)
  root    GitRoot       @relation(fields: [rootId], references: [id], onDelete: Cascade)

  @@id([projectId, rootId])
  @@index([rootId])
  @@map("project_git_state")
}
```

A scan-mode project has no `project_git_state` row; `FantomProject` gains
`indexMode String @default("scan")` (`git | scan`) so the dashboard and the
scheduler do not join to find out.

`index_runs` gains `change_source`, `git_from_commit`, `head_move` (kind),
and, with the names `code-history.md` 2.1 uses, `git_dirty`, `git_head_time`,
`checkout`.

#### 3.2.10 Costs and edge cases

| Case | Behaviour |
|---|---|
| Many roots on macOS | 2 fds per root for the git watcher plus 1 non-recursive watcher on `root`; 1 FSEvents stream for the dirty watcher of the primary project. 11 roots today ≈ 34 fds. Above `git.watch.maxRoots` the rest is polled. The fd count is logged every tick (`src/index.ts:84-88`). The launchd job (`npm run start:dev:launchd`) sets the `ulimit -n` that applies. |
| Huge histories | `diff` and `status` cost by tree size; `log` is bounded by the commit range and `git.maxCommitsPerRun`. The first git-aware run on a repo does not call `diff` at all (seeding through the scan, then the base is set). |
| Detached HEAD | `branch = null`; the reflog is still written; moves classify as usual. |
| Shallow clone | `.git/shallow` exists; `diff` works while both commits are inside the boundary; a missing object → sha scan (3.2.2 step 3); a failing `merge-base` → `linear = false` → `rewrite`/`switch`, counts only. The safe side. |
| `git` not installed | probed once at boot; every project `mode: 'scan'`; the dashboard shows "git: not found". |
| Pods in one repo | one watcher per root, one `diff` and one `log` per root, entries split by project prefix. A commit touching three pods makes three change sets, three runs, three history entries; `commits[].files` is filtered per project. |
| Nested repos and nested projects | 3.2.11. |
| `index.lock` contention | read-only commands only (the hooks are the one write, opt-in); retry 5 × 2 s, then `git_error` is set and the scan interval covers it. |
| Watcher died (EMFILE, ENOSPC, unmounted volume) | logged once, `watch_mode = poll`; the safety-net scan still runs. |
| `git worktree add` after boot | the `.git` file appears under a project path; the root watcher re-resolves (3.2.1). |
| Commits by the server itself | none today (the migration tool commits into other repos, `src/migration/index.ts:170-240`); they would be ordinary events. |

#### 3.2.11 Nested git roots and ownership (D3)

A repo inside a folder of another repo (a vendored tool, a sub-project with
its own history, a `git clone` into `examples/`) is not a submodule: the outer
git sees the inner directory as one untracked entry and never lists its
files. Each repo tracks its own files.

Ownership rule: **the longest git root that is a prefix of a path owns it.**
It decides which watcher, which diff, which base commit and which status call
cover the path. The same rule applies to nested *projects* without their own
repo: the deepest project owns the path on the scan side too, so a parent
project no longer indexes a child project's files twice.

Discovery: `FantomFileScanner` already walks the tree and skips the contents
of `.git` (`excludeDirs.ts`); it now reports every `.git` entry (directory or
file) it meets. The registry (`gitRoots.ts`) resolves each one as in 3.2.1
and stores it with `parentRootId` = the nearest registered root above it.
Discovery runs at boot and at every scan, so a repo cloned into a project
folder after boot is picked up by the next safety-net scan (30 min) or at
once by a dirty event that shows a new `?` directory entry holding a `.git`.

Consequences, per outer root with inner roots `I1..In`:

- watcher: the outer root's dirty watcher drops events under any `Ik`; each
  `Ik` has its own HEAD watcher and, when it is inside the primary project,
  its own dirty watcher (one FSEvents stream each; counted against
  `dirty.watchRoots`);
- diff and log: `-- <project paths> ':(exclude)I1/' … ':(exclude)In/'`. The
  exclude is belt and braces: git does not list inner files anyway, but a
  file committed to the outer repo **before** the inner `.git` appeared
  would, and must not;
- base commits: `project_git_state` has one row per (project, root). A
  project that spans the outer root and two inner roots has three rows, three
  bases, three change sets per event cycle, and one `index_runs` row per
  change set (`rootId` in the payload);
- status: the outer `git status` shows `? Ik/` as one entry; it is dropped
  (owned by `Ik`). The inner status lists its own files;
- scan: the mtime scan of the project still covers every file (it is the
  safety net); ownership only decides which git root's context goes into the
  `ChangeSet`;
- removal of an inner `.git` (the user deletes the clone or turns it into
  plain files), or a new `.git` under a project: the next scan or dirty
  event re-resolves ownership; a removed root row is deleted (cascade to its
  `project_git_state`) and the outer root takes the paths back. The files
  under the changed root re-parse once because their key base moved
  (`indexed_files.key_base`, 3.6), and their symbols are re-keyed and linked
  old → new in `symbol_links` (3.8); the vectors come from the cache.

### 3.3 Durable task queue

Module: `src/indexing/taskQueue.ts` (Prisma model `IndexTask`, table
`index_tasks`). Workers: `src/indexing/taskWorker.ts`. Scheduler:
`src/indexing/scheduler.ts`.

Schema:

```prisma
model IndexTask {
  id           Int      @id @default(autoincrement())
  projectId    Int      @map("project_id")
  kind         String   // scan | parse | graph-patch | embed | deps | full-reindex | rekey | vector-gc | cache-prune
  state        String   @default("pending") // pending | running | done | failed | cancelled | yielded
  priority     Int      @default(50)        // lower runs first; 10 primary project, 50 default, 90 switch/backfill/full-reindex
  payload      String   @default("{}")      // JSON: { source, rootId, paths, removed, renamed, git, runId, nodeIds }
  dedupeKey    String?  @map("dedupe_key")  // "<projectId>:<kind>" while pending; NULL once running/done
  attempts     Int      @default(0)
  maxAttempts  Int      @default(5) @map("max_attempts")
  nextRunAt    DateTime @default(now()) @map("next_run_at")
  leaseOwner   String?  @map("lease_owner") // worker id; stale lease = crashed worker
  leaseUntil   DateTime? @map("lease_until")
  parentId     Int?     @map("parent_id")   // parse → graph-patch → embed chain
  runId        Int?     @map("run_id")      // index_runs row this task reports into
  error        String?
  result       String?                      // JSON summary for the dashboard
  createdAt    DateTime @default(now()) @map("created_at")
  startedAt    DateTime? @map("started_at")
  finishedAt   DateTime? @map("finished_at")

  project FantomProject @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@unique([dedupeKey])                       // NULLs are distinct in SQLite → only pending rows dedupe
  @@index([state, priority, nextRunAt])
  @@index([projectId, kind, state])
  @@index([createdAt])
  @@map("index_tasks")
}
```

Rules:

- **Dedupe**: `enqueue()` does `upsert` on `dedupeKey = "<projectId>:<kind>"`.
  If a pending row exists, a git change set replaces its payload, a dirty or
  scan change set unions paths into it (3.2.6). When a worker claims a row it
  sets `dedupeKey = NULL`, so the next change creates a fresh row. A pending
  `full-reindex` for a project cancels its pending `parse` / `graph-patch` /
  `embed` rows.
- **Claim**: one SQLite transaction: `SELECT ... WHERE state='pending' AND
  nextRunAt <= now ORDER BY priority, nextRunAt LIMIT 1` then `UPDATE ... SET
  state='running', leaseOwner, leaseUntil = now + leaseMs`. Prisma gives this
  through an interactive `$transaction`; SQLite's single writer makes it
  safe. Workers are in-process, so a lease is only for crash recovery: at
  boot, rows `running` with `leaseUntil < now` go back to `pending` with
  `attempts + 1`. The memory guard (3.10) is checked before every claim.
- **Retries**: on failure `attempts++`, `nextRunAt = now + backoffMs *
  2^attempts` (base 60 s, cap 1 h, the curve of `routes.ts:10110`). After
  `maxAttempts` the row is `failed` and shown on the dashboard.
- **Yield (back-pressure)**: an `embed` worker checks `getHeavyJob()` and
  `isShadowReembedActive()` before each batch, like
  `semanticSearchService.ts:1118`. If busy it stores progress in `payload`
  (`nodeIds` not yet done), sets `state='yielded'`, `nextRunAt = now +
  heavyJobPollMs` (30 s) and does **not** count an attempt. `parse`,
  `graph-patch`, `full-reindex` and `rekey` workers also yield while a
  `code-reindex` heavy job runs for the same project. A memory-guard pause
  yields the same way. Aging: every yield does `priority -= 1` (floor 1) so a
  project cannot starve behind newer work.
- **Concurrency**: `workers.parse = 1`, `workers.graph = 1`, `workers.embed =
  1`. Graph work opens LadybugDB; the pool cap (`FANTOM_GRAPH_MAX_OPEN`) and
  the known SIGSEGV under multi-worker opens (memory
  `ladybug-segv-pool-evict-under-load`) argue for one graph writer. Embedding
  goes through the existing semaphore (`semanticSearchService.ts:55-80`), so
  a queue embed task counts as one project slot.
- **Credit cap**: `embed.maxTextsPerTick` (2 000) and `embed.maxTextsPerHour`
  (20 000, OpenRouter credits). A task that would cross the cap yields until
  the window resets. Counted from the provider's `embedBatch` calls; cache
  hits (3.5) do not count.

Task chain for one change set:

```
git event / dirty / scan ──▶ parse {source, rootId, paths, removed, renamed, git}
                                 └──▶ graph-patch {runId, paths} ──▶ sessionDiff ──▶ recordRunHistory(RunDiff) ──▶ embed {runId, nodeIds}
                                                                                                               └─▶ deps {projectId}   (only when imports changed)
```

Each stage writes into the same `index_runs` row (`runId` in payload), so the
dashboard sees one run per change set. `trigger` is `'git'` (new value) for a
commit event, `'file-watch'` for the dirty tree, `'auto'` for the scan: the
dormant values finally get used. History is called once per run, after the
graph patch and before the embed task, as `code-history.md` 2.5 asks.

### 3.4 File-level incremental parse and graph patch

Keep `reindexFiles()` as the engine but fix G4 and move the work into
`src/indexing/graphPatch.ts` so it can be unit-tested without the MCP tool.
With stable keys (3.8) the patch is a diff by key, not a clear-and-rebuild of
the file:

1. **Preload the name index.** `LadybugGraphBuilder` gets
   `async preloadExistingNames()` that runs
   `MATCH (n:CodeNode) RETURN n.id, n.qualified_name` and fills
   `nodeByQualifiedName` **before** it creates the new nodes. Called when
   `clearProject === false`. Cost: one query per patch, proportional to project
   size (project 275 ≈ 30 k rows, tens of ms); above
   `graphPatch.maxPreloadNodes` (200 000) the task becomes a `full-reindex`
   (3.10). Resolves outgoing cross-file edges.
2. **Diff the file's nodes by key.** Old = `MATCH (n:CodeNode {file_path:
   $fp})` (id, body_sha, signature, lines). New = the parse. Same key →
   update the node's properties in place (lines, signature, doc, body_sha);
   **incoming edges survive** because the id did not change. New key →
   create. Old key gone → delete the node and its edges (both directions),
   and record `EdgeChange { changeType: 'removed' }` for the incoming ones
   (model already exists). Outgoing edges of the file are always deleted and
   recreated from the parse through `createEdgesFromBatch`.
3. **Renames and moves.** A gone key whose `body_sha` equals a new key's
   `body_sha` (same file: rename; other file in the same run: move) is linked:
   the incoming edges of the old node are re-pointed to the new id before the
   old node is deleted, and the pair goes into the `RunDiff` as `renamed` /
   `moved` with `linkedKey` (3.2.7). Outside the run (the old file was not in
   this change set) the link is found by `vector_state.body_sha` (3.5).
4. **Dangling references.** Store unresolved outgoing references per file in a
   small Prisma table `pending_refs (project_id, source_file, source_key,
   target_name, edge_type, line)`. When a parse adds new symbols, the
   graph-patch worker re-resolves `pending_refs` whose `target_name` now
   matches, in the same project. Bounded: `pendingRefs.maxPerProject` (default
   50 000; older rows are dropped first).
5. **Removed and renamed files** go through the same path: an empty new set
   for the old path, a full new set for the new one, linked by `body_sha`.
6. **In-memory indexer and FlexSearch** are updated per file as
   `reindexFiles` already does (`codeIndexingService.ts:1108-1112`).

What stays a full rebuild: a `full-reindex` task (share threshold, forced
reindex from the admin UI, graph quarantine at boot, preload cap) keeps
calling `indexProject({ force: true, keepVectors: true })`. The incremental
path never replaces it; it only makes it rare.

### 3.5 Incremental embedding, stale-vector invalidation, cache

Module: `src/indexing/embedPatch.ts`. Side table (Prisma) so LanceDB's schema
does not change:

```prisma
model VectorState {
  nodeId        String   @id @map("node_id")      // stable key (3.8), same as LanceDB node_id
  projectId     Int      @map("project_id")
  filePath      String   @map("file_path")
  qualifiedName String   @map("qualified_name")
  bodySha       String   @map("body_sha")         // for rename/move links across runs
  textHash      String   @map("text_hash")        // sha256 of the embed text (all chunks joined)
  textVersion   Int      @map("text_version")     // EMBED_TEXT_VERSION at write time
  model         String                              // provider model id
  chunkCount    Int      @default(1) @map("chunk_count")
  embeddedAt    DateTime @map("embedded_at")
  runId         Int?     @map("run_id")

  @@index([projectId, filePath])
  @@index([projectId, bodySha])
  @@index([projectId, textHash])
  @@map("vector_state")
}
```

Embed task algorithm for a change set (paths P, run R):

1. Load new nodes for P from LadybugDB (the query at
   `codeIndexingService.ts:1248`). Build embed texts with the existing
   `buildEmbeddingItems` + `buildEmbeddingContext` + `buildSyntheticItems`.
   Hash each node's joined text → `textHash`.
2. Load old `vector_state` rows for `projectId` and `filePath IN P` (and the
   `from` paths of renames).
3. Classify every new node:
   - **same key, same hash, same version/model** → nothing. A line shift
     lands here (the text has no line numbers, 1.4).
   - **cache hit** on `(model, textVersion, textHash)` → write the cached
     vector under the key. No provider call. A revert, a branch switch back,
     a file restored from stash land here.
   - **otherwise** → embed. Batches respect `embeddingBatchSize` and the
     credit cap. Written with `storeEmbeddings`, which already deletes rows by
     `node_id` first (`vectorStore.ts:296-302`), and into the cache.
   A rename or a move always changes the text (the qualified name and the
   path tokens are in it), so the link by `body_sha` serves history and the
   graph, not the vector: those symbols re-embed.
4. Old rows for P that no new node claimed → `vectorStore.deleteEmbedding`
   and delete the `vector_state` row. File-level synthetic vectors for removed
   paths as today (`codeIndexingService.ts:1279`).
5. Write `vector_state` for every node touched and bump `index_runs`:
   `vectorsWritten, vectorsReused, vectorsDeleted, embedMs`.

Known, accepted staleness: the graph context line (`calls: …; called by: …`)
makes a symbol's text depend on its neighbours. A change in a caller does not
re-embed the callee until the callee's file changes or `vector-gc` runs; this
is today's behaviour too. `embed.refreshContextNeighbours` (default `false`)
adds the direct graph neighbours of changed nodes to the re-hash set for
projects where that matters.

**Embedding cache (D6).** LanceDB table `embed_cache`, keyed by
`(model, text_version, text_hash)`, columns `vector`, `bytes` (vector size),
`last_used_at`, `created_at`. Rules:

- on disk only: reads are point lookups by key; writes go through
  `enqueueTableWrite` (`vectorWriteQueue.ts:77`); the table is never scanned
  into memory. Search never reads it, so a dead symbol cannot surface
  through it;
- every vector the provider returns is written to it; a delete in step 4
  does not touch it;
- cap: `embed.cache.maxMb` = `min(2 048, 10 % of free disk at boot)`, both
  configurable (`embed.cache.maxMb`, `embed.cache.freeDiskShare`), re-read
  at every prune. Size is tracked as a running sum in
  `.cache/embedCacheStats.json` (like `projectNodeCounts.json`), corrected by
  a `count` query once a day;
- prune: a `cache-prune` task, enqueued by the scheduler when the running sum
  is above the cap, runs **only when no heavy job is active** and no `embed`
  task is running. It deletes the oldest `last_used_at` rows in pages of
  `embed.cache.prunePageRows` (1 000; the page projects `key, last_used_at`
  only, no vector column, so a page is well under 1 MB) until the sum is
  below `cap × 0.9`. It yields like any task;
- `embed.cache.enabled = false` turns it off; the table stays.

Size math: 4096 d × 4 B = 16 KB per text, so 2 GB holds about 130 k texts —
the primary project several times over, not the fleet. That is the right
size for its two jobs: the working set of the projects being edited, and the
per-project re-key migration of 3.8.

The project-wide `buildProjectEmbeddings` stays for backfills and remains the
watchdog's tool. The queue replaces the "fire and forget" at
`runIndex.ts:145-179`: `runIndex` enqueues an `embed` task instead of starting
the build inline, and the watchdog becomes a fallback that enqueues a
`vector-gc` task (`vector_state` rows with no node, nodes with no row) at most
once per hour.

Model or text-version change: `EMBED_TEXT_VERSION` or
`semanticSearch.codeModel` differ from the row → treated as "otherwise", so a
global bump re-embeds lazily per touched file, and the existing shadow
re-embed (`src/admin/shadowRebuild.ts`) stays the tool for a planned full
rebuild.

### 3.6 Parser and extractor versions in the hash gate

New module `src/fantom-code/indexVersion.ts`:

```ts
export const PARSER_SCHEMA_VERSION = 1;          // bump by hand on any extraction rule change
export function grammarFingerprint(): string;    // sha256 of assets/grammars/*.wasm names+sizes+mtimes, computed once at boot
export function extractorVersionFor(ext: string): string;
//  e.g. '.fan'  → `fan:${FAN_EXTRACTOR_VERSION}`     (regex + tree-sitter-fantom rules)
//       '.trio' → `trio:${TRIO_EXTRACTOR_VERSION}:${axonGrammarHash}`
//       '.md'   → `md:${MD_EXTRACTOR_VERSION}`
//       other   → `ts:${TS_EXTRACTOR_VERSION}:${grammarHashFor(ext)}`
export function indexVersionFor(ext: string, parserType: string): string {
  return `${PARSER_SCHEMA_VERSION}:${parserType}:${extractorVersionFor(ext)}`;
}
```

Schema change (`IndexedFile`): add `indexVersion String @default("")
@map("index_version")` and `keyBase String @default("") @map("key_base")`
(the owning git root the file's keys are relative to, `""` = the project
root; 3.8).

Gate rule becomes: unchanged **iff** `mtime == row.mtime AND size == row.size
AND row.indexVersion == indexVersionFor(ext, parserType) AND row.keyBase ==
keyBaseFor(path)`. A version or base miss is a `modified` entry with
`source: 'version'`. Effects:

- New file type (markdown): no row exists → `added`. No hand deletion.
- Rule change for `.fan` only: bump `FAN_EXTRACTOR_VERSION` → only `.fan`
  files re-parse; `.ts` files stay skipped.
- Grammar wasm rebuilt: fingerprint changes → files of that language re-parse.
- `parserType` flip (`regex` → `tree-sitter-wasm`): whole project re-parses,
  which is right.
- The key scheme of 3.8 is part of `PARSER_SCHEMA_VERSION`: bumping it to 2
  is what drives the re-key migration.

The version check runs in the gate, so it applies to every source: a git
diff that names one `.fan` file still re-parses only that file, and the next
safety-net scan catches the rest of the project after a version bump.

Backfill: rows with `index_version = ''` are treated as a version miss on the
first scan after the upgrade. For 340 projects that is a big change set; the
share threshold (3.2.6) turns it into `full-reindex` tasks at priority 90, so
they drain in the background and never block the primary project.

The same constant goes into `index_runs.parser_version` so the dashboard can
show "runs since the parser changed".

### 3.7 Metrics over time and the dashboard

Add columns to `IndexRun`: `parserVersion String?`, `changeSource String?`,
`gitFromCommit String?`, `headMove String?`, `gitDirty Boolean`,
`gitHeadTime DateTime?`, `checkout Boolean`, `vectorsWritten Int`,
`vectorsReused Int`, `vectorsDeleted Int`, `embedMs Int`, `queueWaitMs Int`
(created → started of the first task), `changeDetectedAt DateTime?` (the
reflog timestamp for a git event, the scan time otherwise).
`freshnessLagMs = finishedAt − changeDetectedAt`.

A small time-series table for the things a run row cannot carry:

```prisma
model IndexMetric {
  id        Int      @id @default(autoincrement())
  ts        DateTime @default(now())
  projectId Int?     @map("project_id")   // NULL = fleet-wide
  name      String                         // queue_depth | queue_oldest_age_ms | vectors_total | nodes_total | coverage_pct | lag_ms | commits_behind | cache_mb | rss_mb | heap_mb
  value     Float
  @@index([name, ts])
  @@index([projectId, name, ts])
  @@map("index_metrics")
}
```

Written by the scheduler every tick (default 60 s) for the fleet and for every
project that has a task in flight. Retention: `metrics.retentionDays`
(default 30), pruned by the scheduler once a day.

Admin API, new module `src/admin/indexingRoutes.ts` (keep `routes.ts` from
growing):

- `GET  /admin/indexing/queue?projectId=` — pending/running/yielded/failed
  tasks, oldest age, per kind, and the guard state (`paused: 'memory' |
  'heavy-job' | null`).
- `GET  /admin/indexing/metrics?name=&projectId=&since=` — series for charts.
- `GET  /admin/indexing/freshness` — per project: `mode, roots[] { root, head,
  branch, lastIndexedCommit, commitsBehind, lastHeadMove, hookInstalled,
  gitError }, dirtyPending, sessionFiles, lastChangeSeenAt,
  lastRunFinishedAt, lagMs, pendingFiles, pendingNodes, state`.
- `GET  /admin/indexing/session-changes/:projectId?since=` — the rows of 3.9
  for the dashboard.
- `POST /admin/indexing/scan/:projectId[?full=1]` — scan now (sha scan with
  `full`).
- `POST /admin/indexing/git-event` — hook ping (token auth, 3.2.8).
- `POST|DELETE /admin/indexing/hook/:projectId` — install or remove the hooks.
- `POST /admin/indexing/tasks/:id/retry|cancel`.
- `POST /admin/indexing/pause|resume` — stop the workers; the watchers and
  detectors keep recording changes.

Dashboard (`dashboard/src/app/`):

- `fantom-pods/page.tsx`: a "Freshness" column (lag, colored: green < 10 min,
  amber < 1 h, red), a git cell ("`a1b2c3d` on `main`, indexed", "2 commits
  behind", "dirty: 3 files, 12 symbols changed", "scan mode") and a queue
  badge. The page is already the per-project list the user looks at.
- `vector-viewer/page.tsx`: a sparkline per project from
  `index-runs` (`vectorsWritten`, `vectorsReused`) and a fleet chart from
  `index_metrics` (`vectors_total`, `coverage_pct`, `queue_depth`,
  `cache_mb`, `rss_mb`). Follow the `dataviz` skill for colors and marks.
- `jobs/page.tsx`: an "Indexing queue" tab listing tasks with retry/cancel,
  beside the re-embed jobs it already shows; the guard state on top.
- A "Session changes" panel on the project page: files with +/− lines, the
  symbol list, and the unified diff on click (3.9).
- Polling: queue and freshness at 5 s like the home page (`page.tsx:107`),
  charts at 60 s.

### 3.8 Stable symbol keys (D5)

New module `src/fantom-code/symbolKey.ts`. One definition, two derived
values:

```ts
// Portable part: identical in every clone of the repo. This is what code
// history stores as symbol_key and mirrors into <root>/.fantomMCP/summary/.
export function symbolKey(relPath: string, normalizedQn: string, paramSig?: string, ordinal?: number): string {
  return sha1([relPath, normalizedQn, paramSig ?? '', ordinal ?? 0].join('\u001f'));
}
// Store id: unique across the fleet. Graph node id, LanceDB node_id, FlexSearch doc id.
// 16 hex chars so every column, index and regex that holds today's 16-char id keeps working.
export function nodeIdFor(projectId: number, key: string): string {
  return sha1(`${projectId}\u001f${key}`).slice(0, 16);
}
```

Inputs:

- `relPath`: forward slashes, relative to the **owning git root** (longest
  root wins, 3.2.11) when the file is inside a repo, and to the project root
  otherwise. `gitRoots.keyBaseFor(absPath)` returns the base; the parsers
  receive it with the file. Not the absolute path (today's ids break when a
  project moves). Why the git root and not the project root: the mirror in
  `.fantomMCP/summary/` is committed, so the key must be the same in every
  clone, including a nested repo cloned on its own or a repo subfolder
  registered as a project elsewhere. Two projects that share one repo get the
  same key for the same symbol and distinct node ids through `projectId`.
- `normalizedQn`: the same rule `code-history.md` 2.3 uses — `pod::Type.slot`
  for Fantom, `<file-scoped name>` for the rest (`Class.method`, a top-level
  function name, an Axon `defcomp` name, a markdown heading path).
- `paramSig`: only when a file has two symbols with the same `normalizedQn`
  and the parser gives parameter types (TypeScript overload declarations,
  Dart named constructors). Omitted otherwise, so an added parameter does not
  change the key.
- `ordinal`: last resort for the remaining duplicates (two anonymous
  functions at top level, repeated `describe` blocks): the symbol's position
  among its same-name siblings in file order. Inserting a sibling above
  shifts the ordinals below it; that is rare and is a legitimate "removed +
  added" in the diff.

No line numbers anywhere in the key. A line shift keeps the id, the node,
its edges and its vector.

Renames and moves: the `body_sha` of `code-history.md` 2.3 (`sha256` of the
trimmed source lines) is stored on the graph node and in `vector_state`. A
gone key and a new key with the same `body_sha` are linked (3.4 step 3,
`SymbolDiff.linkedKey`). The graph keeps a `symbol_links (project_id, old_key,
new_key, kind, run_id, at)` Prisma table so `getSymbolHistory` can follow a
symbol across a rename.

Alignment with code history (agreed 2026-10-15): both designs use
`symbolKey` as **the** key with the git-root base above. (a) `projectId` is
outside the portable part, because the mirror in `.fantomMCP/summary/` must
be the same in every clone (`code-history.md` 5.3); the store id adds it.
(b) The key includes `relPath` for Fantom too, so a symbol moved to another
file is a `moved` link, not the same key; history's `moved = same key or
same body_sha in another file` collapses to the `body_sha` half.

Consumers to change (1.3): `types.ts` (`generateFunctionId`/`generateTypeId`
become thin wrappers over `nodeIdFor(symbolKey(...))`), `codeParser.ts`,
`trioParser.ts`, `treeSitterAdapter.ts`, `fantom-code/index.ts`,
`graph/ladybugSchema.ts` (two new node properties `symbol_key`, `body_sha`),
`graph/ladybugGraphBuilder.ts`. The in-memory indexer and FlexSearch take the
id from the parse, so they follow.

Migration (`rekey` task kind, module `src/indexing/rekeyMigration.ts`), one
project at a time, priority 90, behind the heavy-job lock:

1. Resolve the key base per file first: `gitRoots.keyBaseFor(absPath)`
   (3.2.11), so a project under a repo keys against the repo root and a
   nested repo keys against its own root. Then parse the project with the
   new scheme. For every new node compute the **legacy** id as well
   (`md5(absPath:qn:line)`, the old formula, kept in the module as
   `legacyNodeId()` for this purpose only). This gives an exact `legacy id →
   new id` map for every symbol that still parses at the same line, which is
   all of them when the file did not change since the last index.
2. Rebuild the graph with the new ids (`full-reindex` with `keepVectors:
   true`).
3. For every mapped pair: build the embed text for the new node, hash it. If
   the LanceDB row under the legacy id exists, copy its vector to the new id
   (paged, `rekey.pageRows` 256 ≈ 4 MB per page) and write it into the cache
   under the text hash. Zero provider calls.
4. Unmapped new nodes (the file changed in between): cache lookup by text
   hash, then provider. Legacy rows nobody claimed: deleted. `vector_state`
   written for every node.
5. The project's `index_version` rows carry the new `PARSER_SCHEMA_VERSION`,
   so the gate does not re-parse again.

Cost: one parse and one graph rebuild per project (seconds to a minute each,
341 projects over a day or two in the background), one LanceDB copy pass per
project, and provider calls only for files edited between the last index and
the re-key. `api_changes` rows keep their old ids; history starts with the
new key from its first run (`code-history.md` P0 does a fresh seed anyway).

Key base changes later: a project that gains a `.git` (the user runs `git
init` or clones over a plain folder) or loses one (the inner clone is
deleted, 3.2.11) changes the base of the files under that root.
`indexed_files.key_base` (3.6) records the base each file was keyed with;
the gate treats a different base as a version miss, so those files re-parse
on the next event or scan. The graph patch (3.4) then sees every old key
gone and every new key present with the same `body_sha`: it re-points the
incoming edges, writes `symbol_links (old_key → new_key, kind = 'rekey')`
and deletes the old nodes. The embed text does not contain the key or the
base (only the last path segments, 1.4), so the vectors are cache hits:
zero provider calls.

### 3.9 Session changes as diffs (D7)

Module `src/indexing/sessionDiff.ts`. Written by the chain after the graph
patch (3.3) for every run whose source is `dirty`, `git`, `mtime` or `sha`
on a git project, and for every scan-mode run. Two tables in
`.cache/fantom.db`:

```prisma
model SessionFileChange {
  id            Int      @id @default(autoincrement())
  projectId     Int      @map("project_id")
  rootId        Int?     @map("root_id")
  relPath       String   @map("rel_path")
  baseKind      String   @map("base_kind")        // commit | index   (what "last indexed content" is)
  baseCommit    String?  @map("base_commit")      // the commit the diff is against (git projects)
  baseSha       String?  @map("base_sha")         // content sha of the base; NULL = file did not exist
  afterSha      String?  @map("after_sha")        // NULL = file removed
  changeKind    String   @map("change_kind")      // added | modified | removed | renamed
  fromPath      String?  @map("from_path")
  linesAdded    Int      @default(0) @map("lines_added")
  linesRemoved  Int      @default(0) @map("lines_removed")
  unifiedDiff   String?  @map("unified_diff")     // NULL when over diff.maxBytesPerFile; counts still kept
  diffBytes     Int      @default(0) @map("diff_bytes")
  firstSeenAt   DateTime @map("first_seen_at")    // first dirty run that saw the change
  lastSeenAt    DateTime @map("last_seen_at")     // updated on every run that still sees it
  lastRunId     Int?     @map("last_run_id")
  committedIn   String?  @map("committed_in")     // set by the commit event that included the path
  committedAt   DateTime? @map("committed_at")
  expiresAt     DateTime? @map("expires_at")      // committedAt + diff.retentionDays

  @@unique([projectId, relPath, baseCommit])
  @@index([projectId, lastSeenAt])
  @@index([expiresAt])
  @@map("session_file_changes")
}

model SessionSymbolChange {
  id             Int      @id @default(autoincrement())
  projectId      Int      @map("project_id")
  runId          Int      @map("run_id")           // one row per symbol per run → "since <time>" works
  fileChangeId   Int      @map("file_change_id")
  symbolKey      String   @map("symbol_key")       // 3.8
  qualifiedName  String   @map("qualified_name")
  kind           String                              // graph node_type
  changeKind     String   @map("change_kind")      // added | modified | removed | moved | renamed
  signatureChanged Boolean @default(false) @map("signature_changed")
  beforeSig      String?  @map("before_sig")
  afterSig       String?  @map("after_sig")
  beforeBodySha  String?  @map("before_body_sha")
  afterBodySha   String?  @map("after_body_sha")
  linkedKey      String?  @map("linked_key")
  lineStart      Int?     @map("line_start")
  lineEnd        Int?     @map("line_end")
  at             DateTime                            // run time

  @@index([projectId, at])
  @@index([projectId, symbolKey, at])
  @@index([fileChangeId])
  @@map("session_symbol_changes")
}
```

How the diff is made:

- **Base content** for a git project = the file at `last_indexed_commit`.
  Git is the blob store: one `git diff --no-color -U3 <baseCommit> -- <paths
  of this run>` per run gives every unified diff against the commit in one
  call; the output is split per file and stored. No blob table. `added`
  (untracked) files get a diff against empty. The symbol rows come from the
  graph patch's old/new node sets (3.4 step 2), which it already computes.
- **Base content** for a scan-mode project = the last indexed bytes. They
  are not in git, so `index_blobs (sha, bytes BLOB, size, last_used_at)`
  keeps the previous content of each indexed file, gzip, capped per file by
  `diff.maxBytesPerFile` (512 KB) and in total by `diff.blobCapMb` (256; LRU
  by `last_used_at`; a file over the cap gets symbol rows and counts only).
  The diff is Myers over lines in-process (the `diff` npm package if it is
  already a dependency, else a 150-line implementation in the module), one
  file at a time.
- The diff is **cumulative against the base**: a second save of the same
  file replaces `unified_diff` and bumps `last_seen_at`; the symbol rows of
  each run are appended. So "what changed since the last commit" is the
  file table and "what changed since 14:00" is the symbol table joined to
  `index_runs`.
- Commit handshake (3.2.4): the commit event marks the rows of the committed
  paths `committed_in = sha`, `committed_at`, `expires_at = committed_at +
  diff.retentionDays` (7). A `switch` closes every open row of the project
  the same way with `committed_in = 'switch:<toCommit>'`. Rows whose paths
  stay dirty remain open. The scheduler purges rows past `expires_at` once an
  hour; `diff.maxFilesPerProject` (2 000) and `diff.maxSymbolRowsPerProject`
  (50 000) drop the oldest closed rows first, then the oldest open ones.

MCP tool, handler in `src/indexing/sessionChangesTool.ts`, registered in
`src/index.ts` next to `whatChangedRecently` (`:2019`):

```ts
getSessionChanges({
  projectId: number,
  since?: string,            // commit sha (short ok) | ISO time | 'last-commit' (default)
  paths?: string[],          // glob or prefix filter
  includeDiff?: boolean,     // default true; unified diffs, truncated to maxBytes
  includeSymbols?: boolean,  // default true
  maxBytes?: number          // default 64 KB of diff text in the answer
}) → {
  projectId, base: { commit, branch, at }, dirty: boolean,
  files: [{ relPath, changeKind, linesAdded, linesRemoved, firstSeenAt, lastSeenAt, committedIn,
            symbols: [{ symbolKey, qualifiedName, kind, changeKind, signatureChanged, beforeSig, afterSig, linkedKey }],
            unifiedDiff? }],
  truncated: boolean, totals: { files, symbols, linesAdded, linesRemoved }
}
```

`since: <sha>` on a git project is answered from the tables when the sha is
the current base, and from one `git diff <sha> -- <project>` plus the graph
when it is older (bounded by `maxBytes`). The existing tools stay as they
are: `whatChangedRecently` and `diffByTime` read committed history through
`api_changes`; `getSessionChanges` is the working-tree view. The dashboard
panel (3.7) reads `GET /admin/indexing/session-changes/:projectId`.

### 3.10 Memory budget and guard (D6)

Module `src/indexing/memoryGuard.ts`. The server sits at about 1.1 GB RSS;
the hard guard kills at 4 GB (1.4). The scheduler and every worker share one
rule set:

- `memory.rssPauseMb` (2 560) and `memory.heapPauseMb` (1 536): above either,
  the scheduler claims no new task and a running task yields at its next
  checkpoint (`state = 'yielded'`, no attempt counted, `paused: 'memory'` in
  the queue endpoint). `memory.rssResumeMb` (2 048) / `memory.heapResumeMb`
  (1 280): below both, claims resume. Checked every tick and before every
  claim; `rss_mb` / `heap_mb` go into `index_metrics`. A pause longer than
  `memory.alertAfterMs` (10 min) is logged at `warn` and shown on the
  dashboard.
- graph connections: a worker holds at most one project graph open, pinned
  through `projectGraphConnection.ts`, and closes it when the task ends (the
  boot drain does the same, `src/index.ts:823`). The queue never raises the
  number of open graphs above today's `FANTOM_GRAPH_MAX_OPEN`.

Per-component budget (steady state; the number is a cap in config, not a
hope):

| Component | Bound | Mechanism |
|---|---|---|
| `gitRoots` / `gitWatcher` | < 1 MB | strings per root; reflog tail 64 lines |
| `dirtyWatch` | ≤ 5 000 paths ≈ 1 MB | `dirty.maxPaths`; above it the run is a scan |
| `changeDetector` scan | ≤ 10 MB at `scan.concurrency` 2 | `indexed_files` read in pages of `scan.pageRows` (5 000); `stat` results streamed, not collected |
| `gitChangeSource` | 64 MB `execFile` buffer, in practice KBs | `git.maxFilesPerDiff` turns a huge diff into `full-reindex` with no path list |
| `taskQueue` payload | ≤ 0.5 MB paths, ≤ 1 MB `nodeIds` | the same caps; progress lists above 50 k ids are stored as a range, not a list |
| `graphPatch` | ≤ 16 MB name preload, one graph open | `graphPatch.maxPreloadNodes` (200 000) → `full-reindex` above it |
| `embedPatch` | one batch in flight ≈ `embeddingBatchSize` × 24 KB (64 → 1.5 MB) | batches, LanceDB copies in pages of 256 rows (4 MB) |
| `embed_cache` | reads one row; prune pages < 1 MB | key-only projection in the prune; disk cap D6 |
| `sessionDiff` | one file at a time, ≤ 512 KB diff text | `diff.maxBytesPerFile`; blobs on disk, gzip, `diff.blobCapMb` |
| `rekeyMigration` | one project, one page of 256 vectors (4 MB) | sequential; yields to heavy jobs and the memory guard |
| `scheduler` + metrics | < 1 MB | SQLite rows only |

Target: under 64 MB RSS added when idle, under 160 MB while a task runs,
measured per task by the same `process.memoryUsage()` log line the embed
loop already writes (`semanticSearchService.ts:1129-1179`), with the delta
in `index_tasks.result`.

---

### 3.11 Focus set and AI change reports (D9, 2026-10-16)

Two signals from the AI clients themselves, on top of git and the scan. Both
are **hints**: they move work up the queue; the hash gate still decides what
changed. A client that never sends them loses nothing.

#### 3.11.1 Focus set — files the MCP is working on

Every MCP tool call that names a file or a symbol (`getFantomFunction`,
`listFunctionsInFile`, `getCallers`, `semanticCodeSearch` hits the client
opens, `reindexChangedFiles`, `reportChanges`) adds `(projectId, relPath)` to
an in-memory focus set with `lastTouchedAt`. Entries expire after
`focus.ttlMs` (30 min) without a touch. Cap `focus.maxFiles` (500, LRU).

Uses:

1. **Fresh answers.** Before a tool answers about a focus file, `stat` it
   (mtime + size; sha only when those moved). A change re-parses that one file
   through the `parse` path (priority 10) and the answer waits for it, up to
   `focus.freshWaitMs` (3 s); past that the answer carries `stale: true`.
2. **Dirty-tree scope.** `dirty.projects` gains the value `"focus"`: the
   working-tree watch of 3.2.4 covers the roots that hold focus files, so the
   project the AI is editing is watched without picking a primary project.
3. **Suggestions.** Tool answers about a focus symbol get an optional
   `related` block: its callers and callees from the graph, tests that name it
   (test-block symbols, `*.test.*` / `test/` paths), and session changes to the
   same files in the last hour. Bounded to 10 items; off with
   `focus.suggest = false`. Fields on the existing answer, never a separate
   message.

Not persisted: a restart empties the set, which is correct (the session is
gone). `GET /admin/indexing/focus` lists it for the dashboard.

#### 3.11.2 `reportChanges` — the AI says what it changed

New MCP tool:

```ts
reportChanges({
  projectPath?: string,   // or projectId; resolved by longest path prefix
  projectId?: number,
  files: string[],        // absolute or project-relative paths just written
  intent?: string,        // one line: why ("add retry to token refresh")
  sessionId?: string,     // client session, groups reports
})
→ { projectId, queued: number, taskId: number | null, unknownFiles: string[] }
```

Behaviour: add the files to the focus set, enqueue one `parse` task (priority
10, dedupe per project) with the files as a hint, and store `intent` on the
session-change rows those files produce (3.9: `session_file_changes.intent`,
`session_sessions(sessionId, client, startedAt)`). When the commit later
closes those rows, code history reads `intent` as input to the commit summary
(code-history.md §3 summaries) — the reason git does not know.

Why both this and git: git sees a change only at commit; the scan only every
30 min; `reportChanges` lands within a second of the write and carries the
why. Why not trust it alone: the AI forgets to call it, or names the wrong
files. So the parse task runs the hash gate over the named files **and** any
other dirty file in the same root; files it named that did not change are
returned in the reply, nothing else happens to them.

`reindexChangedFiles` stays (it parses and embeds synchronously, for the
loop in `workflows/ai-coding-loop.md`); `reportChanges` is the cheap
asynchronous one and is what hooks call.

#### 3.11.3 Hooks: make reporting automatic

The reliable path is a client hook, not the model remembering:

- **Claude Code:** a `PostToolUse` hook with matcher `Edit|Write|MultiEdit|NotebookEdit`
  runs a small script that reads the hook JSON from stdin (`tool_input.file_path`,
  `cwd`, `session_id`) and POSTs it to `POST /admin/indexing/report` with
  `curl -m 2 … || true`. Never blocks the edit; a down server loses one
  ping and the scan catches up. Shipped as `scripts/hooks/fantom-report-change.sh`.
- **Other MCP clients:** the workflow resource `workflow://setup-fantom-mcp`
  tells the model to call `reportChanges` after each write.
- **Auth:** the hook uses the per-install token of D2 (header
  `X-Fantom-Hook-Token`), not admin Basic Auth, so the hook file holds no
  password.

#### 3.11.4 Rollout

Lands as **Phase 1b**, before Phase 2: focus set, `reportChanges`, the
`/admin/indexing/report` endpoint and the hook script. `intent` storage waits
for the Phase 5 session tables; until then it is logged on the index run
(`index_runs.trigger = 'report'`, intent in the run's payload).

### 3.12 Axon embedding: only what changed, and say what is running (D10, 2026-10-17)

What happens today (`src/axon/axonIndexer.ts`):

- `maybeAutoIndexAtBoot` starts a full Axon job on **every boot**
  (`startAxonIndex({})`, 121 projects, ~5k functions).
- `runAxonJob` re-embeds every function of every project, then
  `deleteAxonProjectVectors` + `table.add`. Per-function `hash` values are
  written to the meta file (`pm.hashes`) but never compared, so an unchanged
  library costs the same as a new one.
- The job takes the shared heavy-job lock for its whole run. Code embeds,
  lazy tasks (`yielded (heavy-job: axon-index (all))`) and the dashboard's
  **Resume embed** (HTTP 409 "Conflict") all wait behind it.
- Providers are picked once at job start. On 2026-10-17 it started with one
  provider (BASWS34-gpu02) while two others were still passing the vector
  gate, and never picked them up.

Changes:

1. **Skip unchanged work.** Per function compare `hash` +
   `AXON_EMBED_TEXT_VERSION` + model + dims with the meta entry. A project
   with no difference is skipped without opening the provider pool. A
   project with differences embeds only the changed functions (through
   `embed_cache`, 3.5) and deletes only the rows of changed or removed
   functions, by `function_name`. `force: true` keeps today's full rebuild.
2. **Boot runs only on change.** Boot does a cheap hash scan (parse and
   hash, no embedding). No change: no job, no lock. Changes: one job for the
   changed projects only, at low priority.
3. **Lock scope.** Take the heavy-job lock per project batch, not for the
   whole run. Between projects, yield to a waiting code embed or lazy task.
4. **Refresh providers per project**, so a provider that passes the vector
   gate mid-run joins the fan-out.
5. **Embed text check.** A `GET /admin/axon/embed-text?project=&fn=`
   endpoint and a dashboard "show embed text" view return the exact chunks
   sent to the embedder. A test pins the v2 layout (statement split, comments
   kept, defcomp cells). Bump `AXON_EMBED_TEXT_VERSION` on any change, which
   (with 1) re-embeds only once.
6. **Say what is running.**
   - Every 409 from the heavy-job lock names the holder: kind, scope,
     project N of M, functions done, providers in use, started at, ETA.
     Example: "Axon indexing is running (project 18/121, 760/4996 functions,
     1 provider, ETA 25 min). Resume embed will start when it finishes, or
     cancel it on the Axon page."
   - The dashboard shows a banner for the current heavy job on every page
     with a link to its page and a Cancel button. **Resume embed** is
     disabled with that text instead of failing with "Conflict".
   - The Axon page shows the per-project table live: skipped
     (unchanged), embedded N, deleted N, errors.

Exit checks: a boot with no Axon changes starts no job and takes no lock;
editing one function re-embeds one function (provider calls = chunks of that
function); a code embed waiting behind Axon starts within one project
boundary; the dashboard names the running job instead of "Conflict".

## 4. Module boundaries

| Path | Role | Touches |
|------|------|---------|
| `src/indexing/gitRoots.ts` (new) | root resolution (worktree, submodule, nested repos, `core.hooksPath`), `git_roots` registry, ownership lookup (longest root wins), discovery from the scanner | Prisma, `FantomFileScanner` |
| `src/indexing/gitWatcher.ts` (new) | dir watchers on `gitDir` and `logs`, debounce, in-progress check, boot HEAD check, fan-out to the projects under a root, polling above the cap | `fs.watch`, `gitRoots`, `gitChangeSource` |
| `src/indexing/gitChangeSource.ts` (new) | `rev-parse`, `cat-file -e`, `diff --name-status -M` with inner-root excludes, reflog read and classify, `merge-base --is-ancestor`, `log` for `commits`, `status --porcelain=v2`, `diff -U3` for session diffs; all read-only, `execFile`, per-root serialisation, retries | `src/graph/changeDetector.ts` (reuse `parseDiffOutput` if it fits) |
| `src/indexing/dirtyWatch.ts` (new) | recursive `fs.watch` on the primary project's root (or the configured set), debounce, calls `gitChangeSource.status`, keeps the last candidate set, drops inner-root paths | `project_git_state.dirty_paths` |
| `src/indexing/changeDetector.ts` (new) | the gate (mtime + size + sha + version) shared by all sources; the mtime and sha scans → `ChangeSet`, paged | reads `indexed_files`; uses `FantomFileScanner`, `excludeDirs`, `indexVersion` |
| `src/indexing/gitHooks.ts` (new) | install/remove marked hook blocks, per-install token (hash in `git_roots`) | — |
| `src/indexing/taskQueue.ts` (new) | enqueue/claim/complete/yield/retry on `index_tasks` | Prisma |
| `src/indexing/scheduler.ts` (new) | tick loop: due scans, worker dispatch, metrics, lease recovery, cache-prune and purge timers; `start()/stop()` from `src/index.ts` boot | `taskQueue`, `gitWatcher`, `dirtyWatch`, `changeDetector`, `memoryGuard`, `embedGate`, `autoPipelineBus` |
| `src/indexing/memoryGuard.ts` (new) | RSS/heap thresholds, pause/resume state, per-task delta | `process.memoryUsage()` |
| `src/indexing/taskWorker.ts` (new) | one `run(task)` per kind; builds the `RunDiff` and calls `recordRunHistory`; calls `sessionDiff` | `graphPatch`, `embedPatch`, `sessionDiff`, `rekeyMigration`, `runIndex` (for `full-reindex`), `rebuildProjectDependencies`, `src/history/recordRunHistory.ts` |
| `src/indexing/graphPatch.ts` (new) | per-file parse + graph diff by key with name preload, in-place node update, incoming-edge survival, rename/move links; extracted from `reindexFiles` | `codeIndexingService` parsers, `ladybugGraphBuilder`, `ladybugSchema`, `symbol_links` |
| `src/indexing/embedPatch.ts` (new) | node classification, cache lookup, embed, `vector_state` upkeep, `vector-gc`, `cache-prune` | `vectorStore`, `embeddingText`, providers, `vectorWriteQueue`, `embed_cache` |
| `src/indexing/sessionDiff.ts` (new) | unified diff per file (git or in-process), symbol rows, commit handshake, retention, blobs for scan-mode projects | `gitChangeSource`, `index_blobs`, Prisma |
| `src/indexing/sessionChangesTool.ts` (new) | `getSessionChanges` MCP handler; `src/index.ts` only registers it | `sessionDiff`, graph |
| `src/indexing/rekeyMigration.ts` (new) | legacy id → new id map, vector copy, cache seed, per-project `rekey` task | `symbolKey`, `vectorStore`, `embed_cache` |
| `src/fantom-code/symbolKey.ts` (new) | `symbolKey`, `nodeIdFor`, `legacyNodeId`, `normalizedQn` per language, `bodySha`; the key base comes from `gitRoots.keyBaseFor` | read by every parser and the graph builder |
| `src/fantom-code/indexVersion.ts` (new) | version constants and fingerprints | read by `changeDetector`, written to `indexed_files`, `index_runs` |
| `src/fantom-code/types.ts`, `codeParser.ts`, `trioParser.ts`, `treeSitterAdapter.ts`, `fantom-code/index.ts` | emit `symbol_key`, `body_sha`, the new id (wrappers keep the call sites) | `symbolKey` |
| `src/graph/ladybugSchema.ts`, `ladybugGraphBuilder.ts` | node properties `symbol_key`, `body_sha`; `preloadExistingNames()`; `updateNodeProps()`; `createEdgesFromBatch` reused | — |
| `src/fantom-code/codeIndexingService.ts` | `indexProject` keeps the full path and gains `keepVectors`; its gate calls `changeDetector` so one implementation exists; `reindexFiles` delegates to `graphPatch` + `embedPatch` | shrink, do not grow (file is 1 739 lines) |
| `src/fantom-code/runIndex.ts` | add `'git'` to `IndexTrigger`; enqueue `embed` task instead of inline build (`:145-179`) | `taskQueue` |
| `src/admin/indexingRoutes.ts` (new) | endpoints in 3.7, mounted from `src/admin/index.ts` | `taskQueue`, `scheduler`, `gitHooks`, `sessionDiff`, Prisma |
| `dashboard/src/lib/api.ts` | wrappers for the new endpoints | — |
| `dashboard/src/app/fantom-pods`, `vector-viewer`, `jobs`, project page | views in 3.7 | — |
| `src/__tests__/indexing/*.test.ts` (new) | queue dedupe/claim/retry/yield/memory-pause; reflog classification table; diff parsing with renames and inner-root excludes; ownership (longest root wins) on a temp tree with a nested `git init`; dirty revert rule; gate on a temp dir; graph patch by key (line shift keeps edges, rename links by body_sha); embed classification and cache; session diff cumulative + commit handshake + purge; symbol key stability and overload/ordinal cases; re-key map on a fixture project | Jest ESM (`npm test`); git tests build temp repos with `git init` in the test |

Config, one block in `config/fantomMcpServer-config.json` (read through
`src/config/index.ts`, written only through `atomicWriteConfigFile`):

```jsonc
"indexing": {
  "lazy": {
    "enabled": false,                    // phase gate
    "git": {
      "enabled": true,
      "debounceMs": 1000, "inProgressPollMs": 5000, "pollMs": 10000,
      "watch": { "maxRoots": 200 },
      "concurrency": 2, "retries": 5, "retryMs": 2000,
      "reflogTail": 64,
      "maxFilesPerDiff": 5000, "maxCommitsPerRun": 500, "rewriteAsSwitchFiles": 50,
      "discoverNestedRoots": true
    },
    "dirty": {
      "enabled": true,
      "projects": "primary",             // "primary" | [ids] | "active"
      "debounceMs": 2000, "minIntervalMs": 5000, "activeWindowMs": 1800000,
      "watchRoots": 20, "maxPaths": 5000
    },
    "scan": {
      "intervalMs": 300000,              // projects without git
      "gitIntervalMs": 1800000,          // safety net for git projects (30 min)
      "concurrency": 2, "pageRows": 5000,
      "shaAlwaysProjects": []
    },
    "maxChangedShareForIncremental": 0.4,
    "workers": { "parse": 1, "graph": 1, "embed": 1 },
    "retry": { "maxAttempts": 5, "backoffMs": 60000, "backoffCapMs": 3600000 },
    "yield": { "heavyJobPollMs": 30000 },
    "memory": { "rssPauseMb": 3584, "heapPauseMb": 2560, "rssResumeMb": 3072, "heapResumeMb": 2048, "alertAfterMs": 600000 },
    "graphPatch": { "maxPreloadNodes": 200000 },
    "embed": {
      "maxTextsPerTick": 2000, "maxTextsPerHour": 20000,
      "refreshContextNeighbours": false,
      "cache": { "enabled": true, "maxMb": 2048, "freeDiskShare": 0.10, "prunePageRows": 1000 }
    },
    "rekey": { "pageRows": 256 },
    "diff": { "enabled": true, "retentionDays": 7, "maxBytesPerFile": 524288, "maxFilesPerProject": 2000, "maxSymbolRowsPerProject": 50000, "blobCapMb": 256 },
    "pendingRefs": { "maxPerProject": 50000 },
    "metrics": { "tickMs": 60000, "retentionDays": 30 }
  }
}
```

---

## 5. Migration and rollout

Database: one hand-written migration `prisma/migrations/2_lazy_indexing/
migration.sql` (adds `index_tasks`, `git_roots`, `project_git_state`,
`vector_state`, `symbol_links`, `pending_refs`, `session_file_changes`,
`session_symbol_changes`, `index_blobs`, `index_metrics`; adds columns to
`fantom_projects`, `indexed_files` and `index_runs` with defaults). Apply with
`npm run db:setup` (`migrate deploy`) after a copy of `.cache/fantom.db`.
Never `migrate dev` / `migrate reset`. LadybugDB gains two node properties
(`symbol_key`, `body_sha`), added by the re-key rebuild, not by an in-place
schema change; LanceDB gains the `embed_cache` table.

Baseline for already-indexed git projects: `last_indexed_commit` starts as
`NULL`. The first safety-net scan that finds no changes sets it to HEAD; a scan
that finds changes runs them first. So no project is diffed from a base it
was never indexed at.

Operational: every phase lands while no embed is running (memory
`no-src-edits-during-embed`: a tsx restart mid-build corrupted a graph WAL).
Check `heavyJob` and `/admin/vectors/shadow` first.

| Phase | Scope | Flag | Exit check |
|-------|-------|------|------------|
| 0 | `indexVersion.ts`, `index_version` column, gate rule. `reindexFiles` unchanged. | none (always on) | `npm test`; a parser bump re-parses only that extension; `index_runs.parser_version` set |
| 1 | `taskQueue`, `scheduler`, `memoryGuard`, `changeDetector` (scan + gate), `gitRoots` + `gitWatcher` + `gitChangeSource` (roots incl. nested, reflog classification, diff, `commits`), `project_git_state`, `'git'` trigger; kinds `full-reindex` and `parse` only; `runIndex` enqueues `embed` but the embed worker still calls `buildProjectEmbeddings(projectId)` (today's behaviour, now durable) | `indexing.lazy.enabled = true` for project 275 only | a commit in `mcpfantom` makes one run with exactly the committed files within debounce + parse time; `git checkout` of another branch makes a priority-90 run with `checkout = true`; a commit made while the server is down is indexed at boot; a `git clone` into a sub-folder gets its own root and the outer diff excludes it; a heavy job → `yielded`; RSS above the pause line → `paused: 'memory'` |
| 2 | `symbolKey.ts`, parsers and graph emit `symbol_key` / `body_sha` / new ids, `rekeyMigration` (`rekey` task), `embed_cache` table, `PARSER_SCHEMA_VERSION = 2` | same flag; `rekey` enqueued per project by hand first, then by the scheduler for the fleet | project 275 re-keyed with zero provider calls on untouched files; `getCallers` / `searchFantomCode` results equal before and after; line-shift edit keeps every id |
| 3 | `graphPatch` by key with name preload, in-place update, rename/move links, `pending_refs`; `reindexFiles` delegates; `keepVectors` on `indexProject` | same flag | edit a callee file: callers keep their edges; insert 10 lines at the top of a file: zero node ids change, zero vectors rewritten |
| 4 | `embedPatch` + `vector_state`; cache lookup; `vector-gc`; `cache-prune` with the disk cap; Axon (3.12): skip unchanged functions, boot runs only on change, per-project lock, provider refresh, embed-text endpoint, named 409s + heavy-job banner | `indexing.lazy.embedPatch = true` | after an edit, provider calls == nodes with changed text; `main → branch → main` costs zero provider calls the second time; orphans = 0 in `getIndexHealth`; cache stays under the cap after a prune; a boot with no Axon change starts no Axon job; the dashboard names the running heavy job instead of "Conflict" |
| 5 | `dirtyWatch` for the primary project; `sessionDiff` tables, commit handshake, purge; `getSessionChanges` MCP tool and admin endpoint; `RunDiff` handshake with history (`indexedFromWorkingTree`, `commits`, `linkedKey`) | `indexing.lazy.dirty.enabled`, `indexing.lazy.diff.enabled` | save a file: run within debounce, `getSessionChanges` shows the unified diff and the symbol rows; commit it: `filesSkipped` = all, rows closed with the sha, history gets commit/author/subject with no extra git call and summarizes only then |
| 6 | `indexingRoutes` (queue, freshness, metrics, scan, git-event, session-changes), `gitHooks` install/remove, dashboard views | — | freshness column shows HEAD vs indexed; hook ping makes a run with no debounce; removal leaves the hook file as it was; session panel shows diffs |
| 7 | enable for all projects (330 scan-mode projects at 5 min, staggered; fleet `rekey` at priority 90) | default `enabled = true` | fleet queue stays empty between ticks; fd count and RSS flat in the tick log |

Rollback for any phase: set the flag off; the scheduler and watchers stop;
the old gate and `admin-reindex` keep working. Tables stay, cost nothing.
Hooks are removed by the endpoint, not by the flag. Phase 2 is the one-way
step: after a project is re-keyed, `PARSER_SCHEMA_VERSION` must not go back
to 1 for it.

---

## 6. Risks

| Risk | Why | Control |
|------|-----|---------|
| Reflog message not in the table (new git version, a tool that writes its own messages) | classification by text prefix | `unknown` is handled as `switch` (counts only, priority 90); the diff is still exact; the message is stored in `last_head_move` so the table can grow |
| HEAD moved, no reflog line (`core.logAllRefUpdates=false`, a bare-ish setup) | watcher on `logs/HEAD` sees nothing | the `gitDir` watcher on `HEAD` still fires; ancestry alone classifies (`linear` → `edit`, else `switch`) |
| Inner repo files indexed twice or by the wrong root | ownership by prefix | longest root wins, tested on a temp tree; the outer diff excludes inner roots; a removed inner `.git` hands the paths back |
| Key collision inside a file | same `normalizedQn`, no parameter types | `paramSig`, then `ordinal`; a collision that survives is logged and the second symbol gets `ordinal + 1`, so the graph never drops a node |
| Re-key map misses symbols | a file edited between the last index and the re-key | cache by text hash, then provider; bounded by the credit cap; the count is in `index_tasks.result` |
| Partial graph patch leaves wrong edges | resolution by qualified name is heuristic (`resolveReference` suffix matches, `ladybugGraphBuilder.ts:517-540`) | `getIndexHealth` diff after every patch in tests; `maxChangedShareForIncremental`; manual "full reindex" stays one click away |
| Credit burn on a big change (branch switch, new pod version, first pull of a large repo, fleet re-key) | each node text is an OpenRouter call | `switch` at priority 90 and counts only; automatic full reindex at low priority; `maxTextsPerHour`; cache; stable keys keep most vectors; dashboard shows the pending count |
| Cache fills the disk | 16 KB per text | `min(2 GB, 10 % free disk)` re-read at every prune; LRU prune in pages; `cache.enabled = false` |
| Memory guard pauses work for long | a leak elsewhere, a big ask | the pause is visible (`paused: 'memory'`, `warn` after 10 min); the thresholds are config; the guard never kills, the 4 GB guard still does |
| Session-diff tables grow | many saves, big files | cumulative per file (one row per path and base), size caps, retention, purge; blobs only for scan-mode projects |
| `git` spawn storms (a script pulls 11 repos at once) | one event per root, each with 4-6 git calls | per-root serialisation, `git.concurrency` 2, debounce; read-only commands |
| Writing hooks into a user's repo | the only write this design makes to a repo | opt-in per project, marked block, `core.hooksPath` respected, remove endpoint, hashed token; never written by the flag alone |
| Hook ping without Basic Auth | hooks cannot hold the dashboard password | per-install token, registered roots only, localhost listen; the ping carries no payload beyond the root path |
| `index.lock` contention with the user's git | status/diff run while the user commits | retries, then `git_error` and the scan interval; never a write |
| `git status` on very large trees | 100k files ≈ 1-2 s per call | one project by default, `minIntervalMs`; the gate makes a slow status harmless, never wrong |
| Dirty run then commit from another machine (pull) | the pulled tree differs from the dirty one | sha gate catches the difference; `integrate` kind |
| LadybugDB crash with concurrent opens | memory `ladybug-segv-pool-evict-under-load`, `graph-pool-oom` | one graph worker, one open graph per worker, closed after each task; graph tasks yield while a heavy job or a boot sync runs |
| tsx watch restarts during a task | `scripts/start-dev.sh` restarts on `src/` edits | leases + `running → pending` at boot; tasks are idempotent (parse by path, embed by key); `last_indexed_commit` moves only after success |
| mtime not reliable (checkout, rsync, Docker volumes) | mtime can move without content change, or content without mtime on coarse filesystems | git is the primary source; size + sha fallback; `shaAlwaysProjects`; forced sha scan endpoint |
| `fs.watch` limits on Linux / network shares | inotify watch count; SMB has no events | git and dirty watchers are nudges; the mtime scan is the truth; one dirty root by default; failures log once and fall back to the interval |
| Queue growth when sidecars are down | embed tasks yield for hours | one row per project and kind (dedupe), so growth is bounded by projects × kinds; dashboard shows oldest age; `pause` endpoint |
| Dedupe race (two enqueues at once) | unique `dedupe_key` | SQLite is single-writer; the upsert retries on `UNIQUE` violation |
| Prisma migration on a live db | CLAUDE.md rail | backup, `migrate deploy`, run while idle |
| Dashboard polling load | more endpoints at 5 s | queue and freshness answers come from `index_tasks`, `git_roots`, `project_git_state` and the node-count snapshot; no graph opens and no git calls on the request path |

---

## 7. Remaining open points

1. Session-diff retention after a commit: 7 days is the default here
   (`diff.retentionDays`). Say if it should be longer.
2. `embed.refreshContextNeighbours` is off by default (callers of a changed
   symbol are not re-embedded). Turn it on for the primary project if asks
   about "called by" feel stale.
