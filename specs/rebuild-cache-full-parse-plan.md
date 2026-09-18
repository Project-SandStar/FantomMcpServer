# Rebuild Cache → Full Pod Parse Plan

Target URL that currently shows empty: `http://localhost:3848/dashboard/ast-viewer/?podId=demoProjReset-3.1.8-3.1.12`

## 1. Current State (verified by code inspection)

### What already works
| Concern | Status | Reference |
|---|---|---|
| Trio file reading | ✅ Implemented | `src/fantom-code/trioParser.ts` (661 lines, TrioReader port of SkySpark's TrioReader.fan) |
| Axon `src:` extraction from func records | ✅ | `trioParser.ts:212-245` (`extractAxonParams`, `extractAxonCalls`) |
| Tree-sitter Axon parser hookup | ✅ (with regex fallback) | `trioParser.ts:514-533`; grammar at `tree-sitter-axon/grammar.js`; injected from `codeIndexingService.ts:548,564` |
| View records (`view:` + `src:`) | ✅ Stored as `FantomTypeDef` (kind=class), subview methods extracted | `trioParser.ts:336-395, 486-602` |
| App records (`app:` + `dis:`) | ✅ Stored as `FantomTypeDef` with facets `['app','trio','axon']` | `trioParser.ts:isAppRecord` |
| AST viewer page | ✅ Renders | `dashboard/src/app/ast-viewer/page.tsx` |
| AST API endpoints | ✅ Exist | `GET /admin/ast-cache`, `GET /admin/fantom-pods/:id/ast`, `POST /admin/fantom-pods/:id/ast` in `src/admin/routes.ts:3882-4500` |
| Code graph persistence | ✅ LadybugDB (`.cache/fantom-graph.db/`) — primary; FantomCodeIndexer regex fallback | `admin/routes.ts:4068-4233` |

### What is broken / missing
1. **Reindex returns `0 functions, 0 types`** for `demoProjReset-3.1.8-3.1.12`. Likely causes (in order of probability):
   - **Stale-hash short-circuit**: `CodeIndexingService.indexProject()` skips files whose content hash matches last index; the reindex endpoint does not pass `force=true`. `runIndex.ts:107-120` then reports 0/0/0 and skips Prisma stats update.
   - **Path mismatch**: project's `path` points at a directory with no `.fan`/`.trio` files (scanner finds nothing). Need to log scan roots + glob counts.
   - **Silent parser failure**: TrioParser logs but does not surface per-file errors to the reindex response (the "1 errors" in the user message).
2. **AST viewer shows empty** because nothing was indexed into LadybugDB for that pod ID — direct consequence of (1).
3. **Templates not distinguished**: trio `def:^template` / `template:` records are not currently isolated as their own kind; today they would only be picked up if they happen to match the view/app shape.
4. **Per-function AST not persisted**: tree-sitter produces an AST per axon source, but only the extracted *symbols* (params, call list) are stored. The raw AST/CST is not retained, so an "AST viewer" can show structure but not the parsed tree.
5. **No "force rebuild" surface** in dashboard: the "Reindex" button is the no-op stale-check path. There is no UI that says "ignore hash, reparse everything for this pod".

## 2. Plan — make "Rebuild Cache" a full reparse

### 2.1 Backend: force-rebuild path
- Add `force?: boolean` to the reindex request body in `POST /admin/fantom-pods/:id/ast` and `POST /admin/code-projects/:id/reindex` (routes.ts).
- Thread it through `context.reindexProject(projectId, { force })` → `runIndex({ force })` → `CodeIndexingService.indexProject({ force })`.
- In `CodeIndexingService.indexProject`, when `force=true`:
  - Skip the file-hash stale check (parse every discovered `.fan` / `.trio`).
  - Before insert, delete existing LadybugDB nodes/edges where `projectId = X` (clean slate; avoid duplicate-key fallbacks).
  - Reset `lastIndexedHash` rows for this project so next non-force run also re-evaluates.
- Return a structured report instead of just counts:
  ```json
  { "filesScanned": N, "filesParsed": N, "trioRecords": N,
    "functions": N, "types": N, "views": N, "apps": N, "templates": N,
    "errors": [{ "file": "...", "message": "..." }] }
  ```

### 2.2 Trio parser: cover templates explicitly
- In `trioParser.ts`, add `isTemplateRecord(rec)` matching `template` marker or `def:^template` and emit a distinct `FantomTypeDef` with `facets: ['template','trio','axon']` (or a new `kind: 'template'` if downstream tolerates it).
- Same treatment for any record carrying `src:` that is not already func/view/app — surface as `kind: 'axon-snippet'` so they appear in the AST viewer rather than being dropped.
- Add per-file error capture: wrap `parseFile` body and accumulate `{ file, line, message }` into the indexer report instead of `console.error` only.

### 2.3 Axon AST: persist the parsed tree
- In `codeIndexingService.ts` where tree-sitter parses each `src:`, also serialize a compact AST (s-expression or JSON of `{type, children, range}`) and write it onto the node row (new LadybugDB property `axonAst: string`).
- Cap size (e.g. 64 KB) and skip parse-failed bodies — keep raw `src` for fallback display.
- Surface via `GET /admin/fantom-pods/:id/ast?include=tree` so the viewer can render the tree on demand.

### 2.4 AST viewer page
- Show the report from §2.1 at the top: scanned/parsed/errors counts and an expandable error list.
- Add a "Force rebuild this pod" button that hits the new `{ force: true }` path with a confirm dialog.
- For each function/view/template node, add an "AST" disclosure that fetches `?include=tree&nodeId=…` and renders the persisted tree.
- Empty-state copy: when `hasAstCache:false`, link directly to the force-rebuild action with the resolved `projectId` so the user does not have to navigate elsewhere.

### 2.5 Diagnostics for the immediate `demoProjReset-3.1.8-3.1.12` failure
Before shipping the above, run these to confirm the cause:
1. `GET /admin/fantom-pods/demoProjReset-3.1.8-3.1.12` → confirm pod row exists and `path` is set.
2. `ls <pod path>` → count `.trio` / `.fan` files actually present.
3. Tail server log during reindex → look for the "1 errors" message and capture the file name.
4. Inspect LadybugDB for `projectId` = this pod's project (if any). If no project is linked, the AST endpoint returns the "create project" message — wire the dashboard to auto-create / link a project on first reindex.

## 3. Acceptance criteria
- Clicking **Rebuild Cache** (or new **Force Rebuild**) on `demoProjReset-3.1.8-3.1.12`:
  - Parses every `.trio` / `.fan` under the pod path regardless of hashes.
  - Emits non-zero `functions` / `types` / `views` / `templates` (or a structured error list explaining why).
  - Populates LadybugDB so the AST viewer renders functions, views, templates, and (when expanded) the per-function tree-sitter AST.
- A re-run without `force` is a no-op (current behavior preserved).
- Error from any single file does not abort the whole pod; errors are returned in the response and visible in the UI.

## 4. Suggested implementation order
1. §2.5 diagnostics — confirm root cause (don't build on a wrong assumption).
2. §2.1 `force` flag + report shape (smallest change that fixes the empty viewer).
3. §2.2 templates + per-file error capture.
4. §2.4 UI surfacing of report + force button.
5. §2.3 persist axon AST (largest change; do last).
