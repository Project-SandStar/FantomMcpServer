# AST viewer revamp

Status: proposal (2026-10-15). Scope: `dashboard/src/app/ast-viewer/page.tsx` (2260 lines) and the admin routes it calls. No code was changed for this document.

Example URL: `http://localhost:3848/dashboard/ast-viewer/?podId=Quickbook+MCP+Server-0.0.0-0.0.0&asOf=2026-10-15T22:11:42.464Z`

User complaint: "UI is very clunky. I click on typescript and it has a list of languages again. We should treat the top part as chip filters and add more filters for file type, and completely revamp this page."

---

## 1. Current structure

### 1.1 Components in `page.tsx`

| Lines | Component | Role |
|---|---|---|
| 16 | `PodCard` | one card in the overview grid |
| 230 | `AstOverview` | pod list with 7 local filters + pagination |
| 1025 | `getLanguageFromFilePath` | client-side ext → language map (copy of the server map at `src/admin/routes.ts:5250-5280`) |
| 1064 | `LANGUAGE_COLORS` | Tailwind colours per language (a second inline copy lives at 708-718) |
| 1084 | `AstDetailView` | the page the user complains about |
| 2221 | `AstViewerContent` | route switch on `?podId` |
| 2245 | `AstViewerPage` | Suspense wrapper |

### 1.2 `AstDetailView` state and data

State (`page.tsx:1094-1099`, `1191-1193`):

- `activeTab: 'types' | 'functions' | 'languages'`
- `searchQuery` (substring, client side)
- `languageFilter: string` — one value or `'all'`
- `compareToCurrent`, `error`, `success`
- `extractedFunctions`, `isExtractingFunctions`, `extractedLanguage` — a side path that runs tree-sitter on the fly, not the index

Only `asOf` lives in the URL (`page.tsx:1101-1112`, `router.replace`). Every other filter is lost on reload, back, or share.

Fetches:

| Query key | Endpoint | Note |
|---|---|---|
| `['pod-ast', podId]` (1120) | `GET /fantom-pods/:id/ast` (`routes.ts:4383-4680`) | returns every type and function of the project in one JSON. No `limit`, no `asOf`. |
| `['pod-languages', podId]` (1129) | `GET /fantom-pods/:id/languages` (`routes.ts:5231-5420`) | scans the **disk** (`detectLanguagesInDirectory`, ~5367) and counts symbols from the in-memory `FantomCodeIndexer` (5370), not LadybugDB. `sampleFiles` is always `[]` (5408). |
| mutations | `createPodAstCache`, `reindexProject`, `extractFunctions` | |

Filtering is done in the browser (`filteredTypes` 1242-1266, `filteredFunctions` 1269-1294): language is derived again from the file path, because `AstFunction`/`AstType` in `dashboard/src/lib/api.ts:1341-1373` have no `language` field even though the server sends one (`routes.ts:4600`).

### 1.3 Layout, top to bottom (`page.tsx:1396-2210`)

1. Header: back button, pod name, path (1396-1411)
2. `ProgressStrip` (1414)
3. `TimelineSection` (1417-1425): `TimelinePicker` + `IndexRunStrip` + `HistoryPanel` (`dashboard/src/components/timeline/TimelineSection.tsx:29-42`)
4. Error / success banners (1428-1437)
5. Four stat cards: Types, Functions, Classes, Last Indexed (1473-1505)
6. **"Languages in Project" card** (1508-1618): "All" + one chip per language with `fileCount`. Single select. When one is active, a details panel opens under it (1565-1616) with "Sample files" (always empty) and one sample signature.
7. Search input + three buttons: Resume Index, Reindex, Rebuild Cache (1621-1659)
8. **Tabs**: Types (n), Functions (n), **Languages (n)** (1662-1701)
9. Tab body:
   - Types: one big card per type, all rendered (1705-1831)
   - Functions: "Extract <lang> Functions" box when the language has no indexed symbols (1836-1870); extracted-by-file list (1880-1960); one big card per function, all rendered (1960-2090)
   - **Languages tab** (2092-2190): "Project Language Summary" stat grid, then **one card per language again** with the same file counts, sample files, sample code
10. Footer "Showing X of Y" (2196-2210)

---

## 2. Concrete UX problems

### P1. The language list appears three times, and two of them are not filters

- Chips in "Languages in Project" (`page.tsx:1531-1562`) are a filter.
- Clicking a chip opens a details card (`1565-1616`) that repeats the language name, counts, an always-empty "Sample files" row and one signature. This is what the user sees as "a list of languages again".
- The Languages tab (`1689-1700`, body `2092-2190`) renders the full language list a third time, with no filter action at all.
- The overview page does the same: chips at `705-744` **and** a `<select>` for the same state at `828-841`.

### P2. Chips are single select

`handleLanguageFilterChange` (`1232-1239`) stores one string. You cannot see TypeScript + Vue together, which is the normal case for a `.ts` + `.vue` project.

### P3. Chip counts and tab counts use different units and different sources

- Chip label shows `fileCount` from a disk scan (`routes.ts:~5367`); tab labels show symbol counts from LadybugDB (`routes.ts:4566-4567`).
- The disk scan lists languages that have zero indexed symbols (`json`, `html`, `css`). Clicking one gives an empty list and the "Extract Functions" prompt (`1836-1870`), which runs a different parser and shows results that are not in the index. Dead end.

### P4. `asOf` does not change the symbol list

`asOf` is in the URL (`1102`) and drives `TimelineSection`, but the `pod-ast` query key (`1121`) ignores it and `GET /fantom-pods/:id/ast` has no `asOf`/`atTime` handling at all (zero matches in `routes.ts:4375-4975`). The user's example URL shows **current** symbols with a banner that says 2026-10-15. Only the per-file `GET /code-projects/:id/file-symbols?atTime` (`routes.ts:3333`, `src/fantom-code/fileSymbols.ts:161`) and the graph route (`routes.ts:5806-5860`) replay history.

### P5. No filter for kind, file type, path, tag or visibility

Markdown sections (`kind: 'field'`, `tags: ['markdown','docs']`, `src/fantom-code/treeSitterAdapter.ts:1135`) and test blocks (`it: …`, `describe: …`, `treeSitterAdapter.ts:46, 650-658`) land in the Functions tab between real functions, with a "field" badge. There is no way to show or hide them.

Tags are generated (`src/fantom-code/types.ts:436-472`) but never written to the graph: `CodeNode` (`src/graph/ladybugSchema.ts:28-52`) has `modifiers` and `facets`, no `tags`.

### P6. Filters and selection are not in the URL

Overview filters (`236-246`) and detail `searchQuery`/`languageFilter`/`activeTab` are local state. `handleSelectPod` (`2228`) pushes `/ast-viewer?podId=` and `handleBack` (`2232`) pushes `/ast-viewer`, so even `asOf` is dropped on navigation.

### P7. Everything renders at once

`/ast` returns the whole project; the page maps every type and function to a tall card (`1714`, `1960`). For a 5k-symbol project that is thousands of DOM nodes and a slow filter on each keystroke (`searchQuery` has no debounce).

### P8. Two buttons, one action

"Resume Index" (`1635-1642`) and "Reindex" (`1643-1649`) both call `handleReindex` → `api.reindexProject(id)`. The tooltip promises a hash-gated resume vs a full run; the code does not deliver that.

### P9. Duplicated code

- ext → language map: `page.tsx:1025-1063` and `routes.ts:5250-5280`
- colours: `page.tsx:708-718` and `1064`
- pod stable-id → project resolver: ~70 lines copied in `/ast` (`4383-4540`) and `/languages` (`5239-5365`)
- `functionsByClass` is built by the server (`4607-4610`) and never read by the page

---

## 3. Proposed design

### 3.1 Principles

1. One control per concept. Languages, file types, kinds, folders and search are **chips in one bar**. No duplicate tab, card or select.
2. Chips are multi-select. OR inside a group, AND across groups. Each chip shows a live count that reflects the other active filters (faceted search).
3. The server filters, counts and pages. The browser never holds the full project.
4. The whole view is a URL. Reload, back and share all restore it.
5. `asOf` is honoured end to end: the run picker changes the symbol list, the facets and the file tree.

### 3.2 Wireframe

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ ← Pods   Quickbook MCP Server   ~/Code/quickbook-mcp          [⋯ Index actions ▾] │
│ ProgressStrip ─────────────────────────────────────────────────────────────────── │
├──────────────────────────────────────────────────────────────────────────────────┤
│ Run  [● Current ▾]  ◂ run #41 2026-10-15 22:11 · 5f3a2c1 · +12 ~3 -0 ▸  ☐ Diff vs now │
│ 🔍 [ search name / signature / doc ………………………………… ]                        1 234 symbols │
├──────────────────────────────────────────────────────────────────────────────────┤
│ Language  [TypeScript 812] [Vue 196] [JavaScript 40] [Python 31] [Markdown 155]  │
│ File      [.ts 790] [.tsx 22] [.vue 196] [.mjs 40] [.py 31] [.md 155]            │
│ Kind      [function 640] [method 310] [class 48] [field 29] [computed 61]        │
│           [test 88] [doc section 155]                                            │
│ Vis       [public 980] [exported 450]                     Path [src/ 1 010] [tests/ 88] [docs/ 136]  ✕ Clear │
├──────────────┬──────────────────────────────────────┬────────────────────────────┤
│ FILES        │ SYMBOLS  (812)        sort: file ▾   │ DETAIL                     │
│ ▾ src/ 1010  │ src/server/index.ts                  │ createServer()             │
│   ▾ server/  │   ƒ createServer     :12  exported   │ src/server/index.ts:12-58  │
│     index.ts │   ƒ registerTools    :60             │ TypeScript · function      │
│     tools.ts │   ƒ shutdown         :98             │ public exported            │
│   ▾ ui/      │ src/ui/Badge.vue                     │ ─────────────────────────  │
│     Badge.vue│   ◇ badge (computed) :9              │ (params) → ReturnType      │
│ ▾ tests/ 88  │ tests/server.test.ts                 │ Doc …                      │
│ ▾ docs/ 136  │   ✓ describe: server :3              │ Tags  function exported    │
│              │   ✓ it: boots        :5              │ Callers 3 · Callees 7 →graph│
│              │   …(virtualized)                     │ Source (lines 12-58) ▸     │
│              │                                      │ History: added run #38 …   │
└──────────────┴──────────────────────────────────────┴────────────────────────────┘
```

- The bar is sticky. Chip groups wrap; a group with one value is hidden.
- Clicking a file in the tree adds a `path=` filter (exact file). Clicking a folder adds a folder prefix. Both show up as chips in the Path group.
- Chip counts recompute from the facets endpoint on every change (debounced 150 ms).
- Changing the run (asOf) refetches facets, tree and list with the same filters.
- "Diff vs now" keeps the existing `HistoryPanel` behaviour, collapsed under the run row.
- Index actions move into one menu: Resume (hash-gated), Force reindex, Rebuild cache. Each gets a distinct API call.

### 3.3 Component breakdown

Split `page.tsx` into a folder. Target: no file over ~400 lines.

```
dashboard/src/app/ast-viewer/
  page.tsx                      Suspense + route switch only (~40 lines)
  overview/AstOverview.tsx      existing overview, moved; later adopts the same FilterBar
  overview/PodCard.tsx
  detail/AstDetailView.tsx      layout shell: header, run row, FilterBar, 3 panes
  detail/useAstFilters.ts       URL <-> filter state (parse, serialize, set, clear)
  detail/useAstQueries.ts       react-query hooks: project, facets, symbols, detail
  detail/RunPicker.tsx          "Current ▾" + runs list (wraps TimelinePicker + listIndexRuns)
  detail/FilterBar.tsx          groups of FacetChip, Clear, result count
  detail/FileTree.tsx           folders/files with counts, from facets.tree
  detail/SymbolList.tsx         virtualized rows, grouped by file or flat, sort
  detail/SymbolRow.tsx          one line: icon by kind, name, line, badges
  detail/SymbolDetail.tsx       right pane
  detail/IndexActionsMenu.tsx   Resume / Force / Rebuild
dashboard/src/components/ui/
  FacetChip.tsx                 toggle chip with count, colour, active ring
  FacetGroup.tsx                label + chips + "more…" when > 8
dashboard/src/lib/
  languages.ts                  LANGUAGE_COLORS, ext → language (one copy, also for fantom-pods page)
  api.ts                        new calls (3.5); add `language`, `tags`, `lineEnd` to AstFunction/AstType
```

New dependency: `@tanstack/react-virtual` (same family as the react-query already in use). No state library; URL is the store.

### 3.4 URL state

All on `/dashboard/ast-viewer/`:

| Param | Type | Example | Meaning |
|---|---|---|---|
| `podId` | string | `Quickbook+MCP+Server-0.0.0-0.0.0` | as today |
| `asOf` | ISO | `2026-10-15T22:11:42.464Z` | as today; absent = current |
| `lang` | csv | `typescript,vue` | language chips |
| `ext` | csv | `.ts,.vue` | file-type chips |
| `kind` | csv | `function,test,doc` | kind chips (see 3.6 for the vocabulary) |
| `vis` | csv | `public,exported` | visibility chips |
| `path` | csv | `src/,tests/server.test.ts` | folder prefixes or exact files |
| `q` | string | `create` | search text (debounced 250 ms before it hits the URL) |
| `sort` | enum | `file` \| `name` \| `line` | list order |
| `group` | enum | `file` \| `flat` | list grouping |
| `sel` | string | `3f9c…` (16-char node id) | selected symbol → detail pane |
| `diff` | `1` | | "Diff vs now" open |

Rules:

- Absent param = no filter. Empty groups are never written.
- `useAstFilters()` reads `useSearchParams`, exposes `{filters, set(key, value), toggle(group, value), clear()}`, writes with `router.replace(…, {scroll:false})` as the page already does for `asOf` (`page.tsx:1103-1112`).
- `handleBack` and `handleSelectPod` keep the rest of the query string instead of rebuilding it.
- Overview page gets `q`, `lang`, `source`, `instance`, `page` the same way.

### 3.5 Backend changes

Put all of this in a new module `src/admin/astViewerRoutes.ts` registered like `registerWorkflowRoutes` (`routes.ts:7`, `12696`). `routes.ts` is already far over the file-size rail. All endpoints are read-only; none starts an index or an embed.

**a) `resolvePodProject(idParam)`** — extract the stable-id / fantom-build / numeric resolver that is copied in `/ast` (`4383-4540`) and `/languages` (`5239-5365`) into `src/admin/podProjectResolver.ts`. Add:

`GET /fantom-pods/:id/project` → `{ projectId, projectName, projectPath, podName, hasAstCache, language, parserType, lastIndexed }`

The page resolves once, then uses `/code-projects/:id/*` for everything else.

**b) `GET /code-projects/:id/symbol-facets?asOf&lang&ext&kind&vis&path&q`**

```json
{
  "asOf": null,
  "total": 1234,
  "languages":  [{"value":"typescript","count":812}, …],
  "extensions": [{"value":".ts","count":790}, …],
  "kinds":      [{"value":"function","count":640}, …],
  "visibility": [{"value":"public","count":980}, {"value":"exported","count":450}],
  "tree": { "name":"", "count":1234, "children":[{"name":"src","path":"src/","count":1010,"children":[…],"files":[{"path":"src/server/index.ts","count":3}]}]},
  "warnings": []
}
```

Each group's counts are computed with every **other** group's filter applied (so a Language chip count answers "how many if I also pick this"). One pass over the project's node list; cache the node list per `(projectId, asOf)` for 30 s in memory.

**c) `GET /code-projects/:id/symbols?asOf&lang&ext&kind&vis&path&q&sort&limit&offset`**

`{ asOf, total, offset, limit, items: [{ id, name, qualifiedName, kind, language, ext, filePath, lineStart, lineEnd, signature, parentType, isPublic, isStatic, isExported, tags, docPreview }] }`

Source: `getLadybugQueryManager().getNodesByProject(id, [all node types])` + `getTypesByProject` (`src/graph/ladybugQueryManager.ts:841, 899`). `limit` default 200, max 2000, configurable (no hard-coded stage limit).

**d) `asOf` for (b) and (c)** — generalise the per-file replay in `src/fantom-code/fileSymbols.ts:94-110` to project scope: load `api_changes` with `occurredAt > asOf`, walk newest → oldest, re-add `removed`, drop `added`, restore `beforeSig` for `modified`. The graph route already does this (`routes.ts:5806-5860`); move that code into `src/fantom-code/symbolsAt.ts` and call it from all three places. Return `warnings` when a replayed symbol has no line numbers (same as `FileSymbol.locationUncertain`).

**e) `GET /code-projects/:id/symbols/:symbolId?asOf`** → full documentation, parameters, `extends`/`mixins`, caller/callee counts (existing graph queries), `history` (api_changes rows for the qualified name), and `source` (lines `lineStart..lineEnd` read from disk; omitted when `asOf` is set and the signature changed since).

**f) Kind and tag vocabulary** — the graph has no `tags` column. Two steps:

1. Now: `deriveSymbolTags(node)` on the server: ext `.md` → `doc`; name matches `/^(describe|it|test|suite): /` → `test`; `field` in `.vue`/`.ts`/`.js` with no `parentType` → `computed` (what `treeSitterAdapter.ts:642-660` produces). The `kind` facet uses `nodeType` plus these derived values.
2. Next index: add `tags STRING` to `CodeNode` with `ALTER TABLE … ADD` (precedent `ladybugSchema.ts:107`, `projectGraphConnection.ts:402`), write `JSON.stringify(func.tags)` next to `modifiers` in `ladybugGraphBuilder.ts:313`, read it in `getNodesByProject`. Then `deriveSymbolTags` only fills gaps for nodes indexed before the column existed.

**g) Retire for this page** — `GET /fantom-pods/:id/ast` (whole-project dump) and `GET /fantom-pods/:id/languages` (disk scan). Keep them for other callers until nothing uses them; then delete `functionsByClass`.

**h) Index actions** — expose a real hash-gated resume vs force: `POST /code-projects/:id/reindex?force=0|1` if the existing endpoint does not already take it. Not part of the read path; do it in phase 5.

### 3.6 Chip vocabulary

| Group | Values | Source |
|---|---|---|
| Language | from `CodeNode.language`, fallback ext map | server |
| File | `path.extname(filePath)` | server |
| Kind | `function, method, constructor, class, mixin, enum, facet, field, computed, test, doc` | `nodeType` + derived tags |
| Vis | `public, private, static, abstract, exported, override` | `modifiers` JSON |
| Path | top-level folders by default; any folder or file once clicked in the tree | server tree |

---

## 4. Phased plan

| Phase | Work | Effort |
|---|---|---|
| 0. Quick wins | Add `asOf` to the `pod-ast` query key (`page.tsx:1121`). Add `language`, `tags`, `lineEnd` to `AstFunction`/`AstType` in `api.ts`. Hide the Languages tab and the chip details card. Move colours + ext map to `lib/languages.ts`. | 0.5 d |
| 1. Backend read path | `podProjectResolver.ts`, `symbolsAt.ts` (project-scope replay), `astViewerRoutes.ts` with `/project`, `/symbol-facets`, `/symbols`, `/symbols/:id`. Jest tests with a small fixture graph; one test per filter group and one for `asOf`. | 2 d |
| 2. New detail page | `useAstFilters`, `FacetChip`/`FacetGroup`, `FilterBar`, `RunPicker`, `SymbolList` (flat, virtualized), `SymbolDetail`, `IndexActionsMenu`. Delete tabs, Languages card, Extract-Functions path. Overview untouched. | 2.5 d |
| 3. Tree and polish | `FileTree` pane from `facets.tree`, group-by-file mode, keyboard up/down + Enter, `sel` in URL, deep links from graph viewer and fantom-pods page. | 1.5 d |
| 4. Tags in the graph | `ALTER TABLE CodeNode ADD tags`, builder write, reader, drop heuristics after the next full index. Overview page moves to the same chip bar and URL params. | 1 d |
| 5. Cleanup | Real resume vs force reindex calls. Remove `/fantom-pods/:id/ast` + `/languages` use, `functionsByClass`, duplicate maps. `npm run dashboard:build`, jev-browser smoke of the example URL. | 0.5 d |

Total about 8 days. Phases 0 and 1 can run in parallel with phase 2 if the frontend mocks the two new endpoints first.

Risks:

- Phase 1 touches `src/`; the dev server restarts on save. Do not save while an embed job holds the lock (memory: `no-src-edits-during-embed`).
- `asOf` replay cost grows with the number of `api_changes` rows after the anchor. Cache per `(projectId, asOf)`; add an index on `(project_id, occurred_at)` — it already exists (`prisma/schema.prisma:265`).
- The `ALTER TABLE` in phase 4 runs on every per-project graph file at open; follow the `cross_language` pattern and ignore "already exists".
