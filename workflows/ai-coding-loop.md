# AI Coding Loop — Learn → Change → Reindex (keep the index live)

> **Why this exists:** The Fantom MCP server is the codebase's *structural
> memory* — a semantic index (LanceDB vectors), a code graph (LadybugDB), and
> keyword search (FlexSearch) over 240+ projects / 156K+ functions. An AI agent
> uses it to **orient before it edits** and to **keep that memory fresh after it
> edits**. Verified live on 2026-06-10 against `sedonaWebEditor` (project id
> `265`).

## Purpose

Teach an AI agent the working loop for changing code through this server:

```
   ┌──────────────────────────────────────────────────────────────┐
   │  1. ORIENT      learn the code's current state (search/graph)  │
   │  2. CHANGE      edit the source files                          │
   │  3. REINDEX     reindexChangedFiles(paths)  ← parse+graph+embed │
   │  4. VERIFY      re-search / impact-check, then loop to 1        │
   └──────────────────────────────────────────────────────────────┘
```

The rule that makes the loop work: **after every code change, call
`reindexChangedFiles` on the paths you touched.** That one call re-parses the
files, rebuilds their graph nodes/edges, **and re-embeds them**, so the next
`semanticCodeSearch` / `askCodebase` reflects your edit instead of going stale.

---

## Tool map

| Step | MCP Tool | Use it to |
|---|---|---|
| **Orient** | `askCodebase(query, projectId)` | Ask a plain-English question, get a cited answer over graph + vectors. Best first call on an unfamiliar area. |
| | `semanticCodeSearch(query, projectId)` | Find code by *meaning* ("parse sax into components") → ranked functions/types with file:line + caller/callee counts. |
| | `searchFantomCode(query)` | Literal keyword/identifier match when you already know a name. |
| | `getCallers` / `getCallees` / `getCodeImpact(nodeId)` | Trace the call graph and blast radius **before** editing. |
| | `getFantomType` / `getFantomFunction` | Pull a symbol's full definition + related slots. |
| **Change** | *(your normal file edits)* | Edit the source. The MCP server does not write code; you do. |
| **Reindex** | `reindexChangedFiles(paths, projectId?)` | **Call after every edit.** Re-parses + rebuilds graph + re-embeds only those files. Returns `{ runId, added, modified, removed, embedded }`. Fast (seconds). |
| | `refreshFantomProject(projectId)` | Full project re-index. Use after large/structural changes (renames, moved files, many files) — also normalizes symbol naming. |
| **Verify** | `getIndexHealth(projectId)` | Audit Prisma / LadybugDB / LanceDB / FlexSearch counts agree after a reindex. |
| | `whatChangedRecently` / `listIndexRuns` | See what the last reindex actually changed. |

`projectId` is optional on `reindexChangedFiles` — the server resolves it from
the longest matching `project.path` prefix. Pass it explicitly when paths could
match more than one project.

---

## The loop, step by step

### 1. ORIENT — learn the current state (before touching anything)
Front-load understanding; it's cheap here and expensive to rebuild by reading
files one by one.
- Start broad: `askCodebase("how does X work?", projectId)` or
  `semanticCodeSearch("<concept>", projectId)`.
- Phrase semantic queries **short and focused** (2–5 concept words: "load from
  sax", not a whole sentence) — that ranks the right code highest.
- Map the change surface: `getCallers` / `getCallees` / `getCodeImpact` on the
  symbols you'll touch, so you know what depends on them.

### 2. CHANGE — edit the code
Make your edits to the source files as normal. Keep a list of the **absolute
paths** you modified — you'll pass them to the reindex in the next step.

### 3. REINDEX — make the change visible to the index
Immediately after saving:
```
reindexChangedFiles({ paths: ["/abs/path/to/Edited.ts", "/abs/path/Other.fan"] })
```
This re-parses those files, rebuilds their graph nodes/edges, and **re-embeds
them** so semantic search is current. Check the response:
- `embedded > 0` → vectors refreshed; `semanticCodeSearch` now reflects the edit.
- `added` / `modified` / `removed` → how the symbol set changed.
- `embedded: 0` with nodes present → the embedding sidecar was unreachable; the
  graph is still fresh and the auto-embed watchdog will backfill vectors shortly
  (or retry the call once the sidecar is up).

### 4. VERIFY — confirm, then loop
- Re-run the `semanticCodeSearch` from step 1 — your new/edited symbol should now
  appear. (Verified: editing + reindexing `AppSaxParser.ts` brought
  `parseAppSax` / `StreamingAppSaxParser` back to the top of results.)
- `getCodeImpact` on what you changed to re-check downstream effects.
- Return to step 1 for the next change. The index stays live across the session.

---

## Worked example (live, project 265)

```
1. semanticCodeSearch("parse sax file into editor components", 265)
   → parseAppSax #1, StreamingAppSaxParser #2, parseSaxContent #3   (orient)
2. <edit ~/Code/2026/swe/sedonaWebEditor/src/services/bulk/AppSaxParser.ts>
3. reindexChangedFiles(["~/Code/2026/swe/sedonaWebEditor/src/services/bulk/AppSaxParser.ts"], 265)
   → { runId: 888, added: 30, removed: 29, embedded: 30, durationMs: 1673 }
4. semanticCodeSearch("parse sax file into editor components", 265)
   → StreamingAppSaxParser #1, parseAppSax #2   (edit reflected ✓)
```

---

## Gotchas

- **Always reindex after editing.** A bare edit leaves the index stale — graph
  *and* vectors. `reindexChangedFiles` is the one call that fixes both.
- **Reindex re-embedding is best-effort.** It needs the code embedding sidecar
  (capability `embedding` / `embedding-code`). If it's down, `embedded: 0` —
  graph is fresh, vectors backfill via the auto-embed watchdog.
- **Cross-file edges can lag.** Incremental reindex only re-parses the listed
  files; references *from other files* into a renamed/moved symbol may stay
  stale until a `refreshFantomProject`. Do a full refresh after big refactors.
- **Symbol-name normalization.** After an incremental reindex a symbol's
  `qualifiedName` may temporarily carry a path prefix instead of
  `projectName::Symbol`; a `refreshFantomProject` normalizes it. Search +
  embeddings work either way.
- **The index lags live edits by exactly one reindex call.** For a file you're
  actively editing, your own reads are the source of truth; the index is for the
  broad, stable corpus and for what *other* code does.
