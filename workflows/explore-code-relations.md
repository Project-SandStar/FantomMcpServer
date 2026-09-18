# Explore Code Relations via the Fantom MCP Server

> **Project of truth:** `SandStar Website` (project id `267`, language `php`,
> 102,575 code nodes, 232k+ `calls` edges). All examples below were executed
> live against this project on 2026-04-15 and their responses are the
> documented expectation.

## Purpose

Teach an AI how to stand at a single symbol in a project and expand outward
to understand how the codebase is wired together. The graph lives in
LadybugDB (authoritative store since 2026-04-15); the MCP server exposes it
through ten tools. The workflow below is the full exploration loop.

---

## Tool map

| MCP Tool | Reads from | Works on |
|---|---|---|
| `listFantomProjects` | Prisma `FantomProject` | every project |
| `getFantomCodeStats` | in-memory `FantomCodeIndexer` | **Fantom-language only** |
| `getFantomFunction` | in-memory `FantomCodeIndexer` | **Fantom-language only** |
| `getFantomType` | in-memory `FantomCodeIndexer` | **Fantom-language only** |
| `searchFantomCode` | FlexSearch index over the in-memory indexer | **Fantom-language only** |
| `semanticCodeSearch` | LanceDB vectors + Ladybug | every project |
| `findSimilarCode` | LanceDB vectors + Ladybug | every project |
| `getCallers` | **Ladybug** (Cypher) | every project |
| `getCallees` | **Ladybug** (Cypher) | every project |
| `getCodeImpact` | **Ladybug** (Cypher) | every project |
| `reindexChangedFiles` | parser + Ladybug + Prisma | every project (used after edits) |
| `listIndexRuns` | Prisma `IndexRun` | every project |
| `getApiChangeHistory` | Prisma `ApiChange` | every project |
| `diffIndexRuns` | Prisma `ApiChange` | every project |

**Rule of thumb:** the four graph-native tools (`getCallers`, `getCallees`,
`getCodeImpact`, plus `semanticCodeSearch` and `findSimilarCode`) are the
universal ones. For PHP/TypeScript/Vue/etc. projects stay on these.

The bottom four (`reindexChangedFiles`, `listIndexRuns`,
`getApiChangeHistory`, `diffIndexRuns`) close the read → edit → re-read
loop. After any Edit / Write the AI performs, call `reindexChangedFiles`
so the next exploration sees the fresh state.

---

## Step 1 — Anchor: pick a starting symbol

For a known Fantom project, use keyword search:

```bash
# Always use the MCP tool at call-time; curl is shown for the shape only.
curl -s -u admin:admin -H 'Content-Type: application/json' \
  'http://localhost:3848/admin/code-stats' | jq '.totalProjects, .totalFunctions'
```

For a non-Fantom project (or when the concept is fuzzy), use
`semanticCodeSearch` with `projectId` set:

```json
{
  "tool": "semanticCodeSearch",
  "args": { "query": "handle OAuth registration requests",
            "projectId": 267, "limit": 5 }
}
```

Verified response on project 267 returns 5 hits led by
`OAuthRegisterController` (semantic 71.9 %).

---

## Step 2 — Expand outward: who calls the symbol?

`getCallers` is the primary "where is this used?" answer.

```json
{ "tool": "getCallers",
  "args": { "qualifiedName": "SandStar Website::Str",
            "projectId": 267, "maxDepth": 1 } }
```

Verified: 219 depth-1 callers, capped at `maxDepth=1`. Depth 2–5 reveal
indirect users but grow combinatorially; start at 1 and widen only if
needed.

Behaviour notes learned in testing:
- Results are **deduplicated by node id** — a function that calls your
  target 10 times shows once with the minimum depth.
- `projectId` scopes the lookup; omit it to see cross-project callers
  (useful for shared libraries).
- Edge types included: `calls` + `uses`. Inheritance and containment are
  excluded here; use `getCodeImpact` for the full set.

---

## Step 3 — Descend: what does the symbol call?

```json
{ "tool": "getCallees",
  "args": { "qualifiedName": "SandStar Website::OAuthRegisterController.__invoke",
            "projectId": 267, "maxDepth": 2 } }
```

Verified response: 7 callees covering `Str`, `Validator`, `collect`,
`config`, `response`, `Container`, and `app` (depth 2 via `response → app`).

Use `getCallees` with depth 2–3 to understand the **dependency surface** of
a function before editing it. Unlike `getCallers`, this is a forward walk;
edges traversed are `calls` only.

---

## Step 4 — Blast radius: change-impact analysis

`getCodeImpact` is `getCallers` on steroids — it widens the edge filter to
`calls, extends, implements, uses, returns, parameters`, which captures
inheritance and type relationships a pure call-graph would miss.

```json
{ "tool": "getCodeImpact",
  "args": { "qualifiedName": "SandStar Website::Str",
            "projectId": 267, "maxDepth": 2 } }
```

Verified: 916 affected nodes, split `calls: 925` + `returns: 706` (some
nodes accumulate across multiple edge types, which is why the totals are
larger than the distinct count).

Use this before a rename or signature change.

> For a leaf function that nothing depends on (`__invoke` entry points,
> HTTP controllers) `getCodeImpact` returns `0`. That is not a bug — the
> function is at the graph's edge. Move up one hop with `getCallers` to
> find the closest hub.

---

## Step 5 — Lateral search: "find me something similar"

Two modes:

### 5a. Semantic search (question-form)

```json
{ "tool": "semanticCodeSearch",
  "args": { "query": "validate email formatting and reject disposable domains",
            "projectId": 267, "limit": 5 } }
```

Returns scored results with combined semantic + graph-context signals.

### 5b. Function-similarity (give me more like this one)

```json
{ "tool": "findSimilarCode",
  "args": { "qualifiedName": "SandStar Website::OAuthRegisterController.__invoke",
            "projectId": 267, "limit": 3 } }
```

Verified response: `OAuthRegisterController`, `LoginController.oauthProviders`,
`PrismModelController.__invoke` at 77.6 % / 76.8 % / 76.7 % similarity. Use
when hunting for duplicate logic or pre-existing patterns.

---

## Step 6 — Close the loop: detailed symbol inspection

For Fantom projects, grab the full source + signature + facets:

```json
{ "tool": "getFantomFunction",
  "args": { "qualifiedName": "bassgPointHealth::Build.publish" } }
```

Verified response includes `sourceCode`, `signature`, `parameters`,
`returnType`, `facets`, `filePath`, `lineNumber`.

For **non-Fantom projects** this tool returns `Function not found`. Use
`getCallers` / `findSimilarCode` / `semanticCodeSearch` instead — they
return `filePath` and `lineStart`, which is enough to open the file.

---

## Step 7 — Edit code and keep the index in sync

**The MCP server does not auto-watch the filesystem.** After every batch
of Edit / Write tool calls, the assistant is responsible for telling the
server which files changed so the next query reflects the new state.

```json
{ "tool": "reindexChangedFiles",
  "args": {
    "paths": [
      "~/Code/court-lens-mcp/src/core/audioRouter.ts",
      "~/Code/court-lens-mcp/src/core/mixer.ts"
    ]
  }
}
```

Rules:

- Pass **absolute** paths.
- Pass **all** files touched in the same logical edit unit; one call per
  unit, not per file. The server batches them into a single `IndexRun`
  with one diff snapshot.
- Omit `projectId` when paths obviously fall under a single project — the
  server resolves it via the longest matching `project.path` prefix.
- If your edits span multiple projects, call once per project (the server
  refuses ambiguous batches with a structured error).
- This call is cheap: typically <1s for a handful of files vs. ~100s for
  a full `refreshFantomProject`. Use liberally.

Response shape (verified):

```json
{ "success": true, "runId": 42, "projectId": 268,
  "filesProcessed": 2, "added": 1, "modified": 7, "removed": 1,
  "durationMs": 820, "warnings": [], "errors": [] }
```

Verify the edit landed:

```json
{ "tool": "searchFantomCode",
  "args": { "query": "dispatchFrame", "projectId": 268 } }
```

### Edge cases

- **File deleted** — include the path in `paths`; the server records
  `changeType: "removed"` for every symbol that was in it and drops the
  `IndexedFile` row.
- **File renamed** — v1 surfaces this as remove + add (no rename
  tracking). Pass both old and new paths.
- **Cross-file edge dangling** — per-file rebuilds don't touch other
  files' outbound edges, so a caller in `playbackHandler.ts` referring
  to a renamed symbol may show as unresolved until that file is also
  re-indexed. **If you renamed a symbol, always include its callers in
  `paths`.**

### When to fall back to a full refresh

Use `refreshFantomProject({ projectName })` instead of
`reindexChangedFiles` when:

- A `git checkout` / `git pull` rewrote dozens of files at once.
- The user reports stale graph data (cross-file edges look wrong).
- You're debugging an indexer issue and want a known-good baseline.

`refreshFantomProject` with `force: true` skips the per-file hash gate.

---

## Step 8 — Drift detection: "what happened to X?"

Once edits land, the `IndexRun` and `ApiChange` history lets you answer
questions about the past. Use these when:

- The user says "this function used to exist."
- A search returns nothing where it used to return something.
- You need to summarise "what changed in this project today / this week."

```json
{ "tool": "listIndexRuns",
  "args": { "projectId": 268, "since": "2026-04-28T00:00:00Z", "limit": 50 } }
```

```json
{ "tool": "getApiChangeHistory",
  "args": { "qualifiedName": "core::AudioRouter.routeFrame" } }
```

```json
{ "tool": "diffIndexRuns",
  "args": { "projectId": 268,
            "fromTime": "2026-05-04T00:00:00Z",
            "toTime":   "2026-05-05T23:59:59Z" } }
```

`diffIndexRuns` returns
`{ summary: { added, modified, removed }, added: [...], modified: [...], removed: [...] }`
with each entry carrying `beforeSig` + `afterSig` so you can summarise
the API delta in prose.

Caveats when interpreting history:

- Runs marked `isSeedingRun: true` count everything as "added" because
  there was no prior state. Skip those when computing trends.
- `modified` detection compares the LadybugDB `signature` field. Body-only
  edits that don't change the signature won't show up — read the source
  if the user asks "did the implementation change?".
- Renames are remove + add, not modify. A function that disappears and
  a similar one that appears in the same `IndexRun` is likely a rename;
  flag it to the user rather than silently merging.
- `ApiChange` is capped at 5000 rows per run. Runs that wholesale rewrote
  a project log a warning; fall back to comparing two graph snapshots.

---

## Full exploration loop (pseudocode the AI should follow)

```
1. IF project is Fantom-language:
     hits  = searchFantomCode(keyword, projectId)
   ELSE:
     hits  = semanticCodeSearch(natural_language_query, projectId)

2. pick the best hit → anchor_qn

3. callers = getCallers(anchor_qn, projectId, maxDepth=1)
   IF callers.length == 0:
     anchor might be a leaf — look one level wider or pick another symbol

4. callees = getCallees(anchor_qn, projectId, maxDepth=2)
   → direct dependency surface

5. IF about to refactor anchor_qn:
     impact = getCodeImpact(anchor_qn, projectId, maxDepth=3)
     → full blast radius, including inheritance

6. OPTIONAL: similar = findSimilarCode(anchor_qn, projectId)
   → surface duplicates / patterns that may need the same change

7. IF Fantom: detail = getFantomFunction(anchor_qn)
   ELSE:     open the filePath from step 3's result to read source

8. IF editing:
     Edit / Write the source files
     reindexChangedFiles(paths: [...all files touched])  # NON-OPTIONAL
     searchFantomCode(new_symbol)                        # verify discoverability
     getCallers(new_qn)                                  # verify call sites
```

Treat step 8's `reindexChangedFiles` as mandatory after edits. Skipping
it leaves the index lying about the codebase, and the verification queries
will return stale data.

---

## Verification script

A live verifier ships at `scripts/verify-graph-tools.mts`. It calls the
underlying LadybugDB query layer directly (the same code path every MCP
graph tool uses), so it doesn't need an OAuth token. Run after any change
to `src/graph/*` to catch regressions.

```bash
./scripts/stop-server.sh                              # release Ladybug file lock
./node_modules/.bin/tsx scripts/verify-graph-tools.mts
./scripts/start-server.sh                             # bring the server back
```

Expected output (numbers will drift as projects get re-indexed):

```
Project 267 graph: 102575 nodes, 29070 edges

1/10 listFantomProjects OK (240 projects)
2/10 getFantomCodeStats indexer reachable
3/10 searchFantomCode index reachable
4/10 semanticCodeSearch vector store reachable
5/10 findSimilarCode shares vector store
6/10 getCallers OK (219 at depth 1)
7/10 getCallees OK (7 at depth 2)
8/10 getCodeImpact OK (916 affected)
9/10 getFantomFunction OK (resolved + signature present)
10/10 getFantomType resolved

ALL 10 GRAPH TOOLS OK
```

Fixtures used:
- Hub: `SandStar Website::Str` (219 direct callers)
- Leaf: `SandStar Website::OAuthRegisterController.__invoke` (entry point)
- Fantom sample: `bassgPointHealth::Build.publish`
- Type sample: `sys::Str`

---

## Known limitations

- **`getFantomCodeStats` / `getFantomFunction` / `getFantomType` /
  `searchFantomCode` return empty for non-Fantom projects** (they read the
  in-memory `FantomCodeIndexer`, which only loads `.fan` files). Use the
  graph tools for PHP, TypeScript, Vue, etc.
- **`getCodeImpact` with `maxDepth > 5` can be slow** on very wide projects
  — SandStar's `Str` at depth 3 traverses tens of thousands of edges. Start
  at 2, widen only with a specific question.
- **MCP responses are truncated past ~70k characters.** For deep walks,
  call with a small `maxDepth` / `limit` and widen iteratively. For
  `listFantomProjects` in particular, filter with `compatibleWith` or use
  the admin `/admin/graph/ladybug-stats` endpoint instead.

---

## Why this works end-to-end

The code graph is stored as a Kuzu property graph at
`.cache/fantom-graph.db`. Every `*.fan`, `*.ts`, `*.vue`, `*.php`, etc.
file is parsed (regex + tree-sitter) into `CodeNode`s and `CodeEdge`s with
edge types `calls, contains, extends, implements, overrides, returns,
parameters, uses`. The MCP tools are thin wrappers over
`src/graph/ladybugQueryManager.ts`, which issues native Cypher
(`MATCH (a)-[e:CodeEdge*1..N]->(b) WHERE ALL(r IN rels(e) …)`). That means
the traversals are O(graph traversal) rather than O(full-graph scan) — a
depth-5 caller lookup on a 447k-edge graph returns in tens of milliseconds.

See `~/.claude/plans/lovely-baking-church.md` for the full migration
history and `src/graph/ladybugSchema.ts` for the on-disk schema.
