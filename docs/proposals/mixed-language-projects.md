# One project for a mixed repo: route each file by extension, one pod per build.fan

Status: draft (2026-11-09). Design only: no code changed.
Evidence: source reads (file:line below), remote rows on the team server
(project 447 `mac-alper-visualytik2026`, typescript, 183 functions; project 448
`mac-alper-visualytik2026-pod`, fantom, `pod/vizExt`, 206 functions).

Related proposals:
- [parse-embed-quality.md](parse-embed-quality.md) items 3, 7, 12 (Fantom projects
  parse `.js` with regex; qualified names not file-scoped; three copies of
  language detection).
- [lazy-incremental-indexing.md](lazy-incremental-indexing.md) §3.6 (hash gate
  and extractor versions), §3.8 (stable symbol keys).

## 1. Goal

A repo whose base is Vue/TypeScript and that holds Fantom pods (`build.fan`,
`.fan`, `.trio`, `.axon` under subfolders) needs ONE project entry. Every
project becomes generic:

1. Each file goes to the parser for its extension.
2. Each Fantom pod under the project gets its own pod name from its `build.fan`.
3. The nested pod project (448) can be removed with nothing lost.
4. Single-language projects keep today's results.

## 2. What happens today

The paste that started this doc had the right picture. The details below
sharpen it.

### 2.1 Every file is scanned, so the scanner is not the gate

Both scanners list `.fan`, `.trio`, `.axon`, `.ts`, `.vue` in every project:
`MultiLanguageScanner` adds every source language and always `.fan`
(`src/fantom-code/treeSitterAdapter.ts:95-117`); `FantomFileScanner` lists
`.ts`, `.vue`, `.css`, `.json` too (`src/fantom-code/scanner.ts:19-35`). Both
honour `.gitignore`.

### 2.2 Two gates decide the parser, both per project

Gate 1, `language` sets `parserType`. Fantom/trio/axon keep `regex`; every
other language is promoted to `tree-sitter-wasm` for the run
(`src/fantom-code/codeIndexingService.ts:334-349`,
`src/indexing/changeDetector.ts:54-57`).

Gate 2, pod metadata is read only when the language is fantom/trio/axon
(`codeIndexingService.ts:376-382`), and only from `<project.path>/build.fan`
(`scanner.ts:94-97`). `findBuildFiles` (`scanner.ts:259`) walks nested
`build.fan` files but nothing on the index path calls it.

Parser objects are built once per project, each with one namespace:

| Parser | Built at | Namespace |
|---|---|---|
| primary tree-sitter | `codeIndexingService.ts:667` | `podMeta?.podName ?? project.podName ?? project.name` |
| axon tree-sitter | `:706` | `podMeta?.podName` (undefined in a TS project) |
| `FantomCodeParser` (regex) | `:718` | `podMeta` (undefined → bare names, `types.ts:309-320`) |
| `TrioParser` | `:720` | `podMeta?.podName` → `'unknown'` (`trioParser.ts:547`) |

### 2.3 The per-file dispatch has three branches and three copies

`codeIndexingService.ts:762-769` (full index) and `:1277-1283` (incremental):
`.trio` → `TrioParser`; else tree-sitter parser if on; else regex.
`rebuildGraphLocked` (`:1681-1685`) has no `.trio` branch and a narrower
scanner gate (`language === 'fantom'`, `:1648`).

### 2.4 What a TypeScript project does with Fantom files

| File | Parser | Namespace | Result |
|---|---|---|---|
| `.fan` | tree-sitter adapter, generic extractor (`treeSitterAdapter.ts:383-386`) | project name | `mac-alper-visualytik2026::vizCommit`, parameters lost |
| `.trio` | `TrioParser`, no pod | `unknown` | `unknown::siteRec` |
| `.axon` | tree-sitter adapter, generic extractor | project name | ok names, weak calls |
| `build.fan` | parsed as a `.fan` source file | project name | noise symbols |

Why the parameter is lost: the generic extractor reads the field `parameters`
or a `formal_parameters` node and child types `required_parameter` etc.
(`treeSitterAdapter.ts:676`, `:756`). The Fantom grammar names them `params`,
`param_list`, `param` (`tree-sitter-fantom/grammar.js:190-232`). The field
`return_type` matches, so the output is `vizCommit(): Grid`. The regex
`FantomCodeParser` reads `Grid vizCommit(Obj diffs)` in full. The Fantom
post-processor exists but only `src/parser/treeSitter/treeSitterParser.ts`
uses it; the indexer never does.

### 2.5 Other facts the design must respect

- Hash gate. `.fan` in a tree-sitter project is stored as
  `ts:2:fantom:<grammar fp>`; `fan-regex:` only when `parserType` is regex
  (`src/fantom-code/indexVersion.ts:91-104`, test
  `src/__tests__/indexVersion.test.ts:36-39`). A routing change that does not
  change this string re-parses nothing.
- A changed `build.fan` is only a changed `.fan` file. Nothing marks the files
  under it as modified (`src/indexing/gitChangeSource.ts:239-247`,
  `src/indexing/focusTools.ts:276`).
- Version group comes from the instance link or a Fantom SDK name/path only
  (`src/projects/versionGroup.ts:110-134`). `build.fan` is not an input.
- Symbol keys are git-root relative and project-free; store ids hash the
  project id under key scheme 2 (`src/fantom-code/symbolKey.ts`). 447 and 448
  differ today because the qualified names differ (project name vs pod), not
  because of the key base.
- Node language is by path and returns `fantom` for `.ts`/`.vue`
  (`src/graph/ladybugGraphBuilder.ts:40-44`), so same-language call resolution
  in a mixed project matches TS calls to Fantom nodes.
- The mirror registry re-creates any listed project at boot and on
  `POST /admin/sidecar-sync/reload` (`src/indexing/mirror.ts:146-156`,
  `src/index.ts:644-654`, `src/admin/sidecarSyncRoutes.ts:211-213`).

## 3. Design

Three designs were drafted and scored by two judges (minimal 62, pod-map 51,
generic 40). The minimal design won; the items marked (graft) come from the
other two. Every rule below is new behaviour.

### 3.1 One router for parser and version tag (graft)

New `src/fantom-code/fileRouter.ts` with one table:

| ext | parser family | version tag |
|---|---|---|
| `.fan` | `FantomCodeParser` (regex) | `fan-regex:<fanRegex>` |
| `.trio` | `TrioParser` (+ axon tree-sitter for `src:` blocks) | `trio:<trio>:<fp axon>` |
| `.axon` | axon tree-sitter if the grammar loads, else regex | `axon:<axon>:<fp>` |
| `.vue` | adapter `parseVueFile` | unchanged |
| `.md` | adapter `parseMarkdownFile` | unchanged |
| other | primary tree-sitter parser if on, else regex | unchanged |

`routeFile(filePath, ctx) -> { kind, extractorVersion }` is called at all
three dispatch sites and by `extractorVersionFor`. The hand-kept "mirrors the
routing" comment (`indexVersion.ts:85-89`) goes away: one table cannot drift.

Build-file rule: `build.fan` is not a source file. The router returns
`skip` for it (today it adds noise symbols in TS projects).

### 3.2 Pod map: one pod per build.fan, for every language

New `src/fantom-code/podParsers.ts`:

- `buildPodMap(scanner, projectPath, rootMeta)`: `findBuildFiles` (depth ≤ 5,
  excluded dirs skipped) → `parseBasicBuildFan` (make it public,
  `scanner.ts:188`) → `Map<absDir, PodMeta>`.
- `podFor(filePath)`: the `PodMeta` of the longest directory prefix, else
  `rootMeta`, else `{ podName: project.podName ?? project.name }`.
  The fallback must be a real object: with `podMeta` undefined the regex parser
  drops the `::` prefix (`codeParser.ts:198`, `types.ts:309-320`), which is
  worse than today.
- `PodParserSet`: one parser instance per (pod dir, kind), created on first
  use. `parse(filePath, primaryParser)` applies the router and the pod map.

The map is built for every project language, in all three paths. The four
other sites that synthesize `podMeta` from the project row
(`src/fantom-code/runIndex.ts:191-193`, `src/index.ts:1439`, `:1454`, `:2689`)
pass it as `rootMeta` and get the same result.

Expected names after the change for project 447:
`bassgViz::VizExt.vizCommit`, signature `Grid vizCommit(Obj diffs)`;
`.trio` records `bassgViz::<name>`; `.ts`/`.vue` keep
`mac-alper-visualytik2026::<name>`.

### 3.3 Hash gate follows the router (graft)

- `extractorVersionFor` returns the router's tag. `.fan` always gets
  `fan-regex:`; `.axon` gets its own family. Bump `trio: 1 → 2` so `.trio`
  rows that carry `unknown::` re-parse once.
- A changed, added or removed `build.fan` expands to every accepted file under
  its directory in `gitChangeSource.ts` (`:239-247`) and `focusTools.ts`
  reportChanges (`:276`). Without this, a pod rename converges only on a
  forced reindex.

### 3.4 Node language by extension (graft)

`langFromPath` returns the router's language (`typescript`, `vue`, `fantom`,
`axon`) so `sameLang` call resolution (`ladybugGraphBuilder.ts:338`, `:418`,
`:779`, `:1149`) means something in a mixed project.

### 3.5 Dependency catalogue knows nested pods

`ProjectCatalogue` (`src/fantom/projectDependencies.ts:244-257`) also lists
nested `build.fan` pod names → parent project. `resolvePodToProject` (`:324`)
then maps `bassgViz` to 447 when 448 is gone.

### 3.6 Version group: per project now, per pod later

Phase 1: a mixed repo gets its SkySpark group by `instanceId` on the project
row (`PUT /admin/code-projects/:id`, `src/admin/routes.ts:3474`). The TS/Vue
code is then also tagged `skyspark 3.1.12`. This is a known cost.

Phase 2 (only if needed): a per-pod `instanceId` on a `pods` row and a
pod filter on graph nodes and vectors (`ladybugSchema.ts:28-52`,
`lanceConnection.ts:117`), with `versionGroup.ts` cache and
`resolveVersionScope` moved to pod granularity.

### 3.7 No `mixed` or `auto` language value

The paste suggested a `mixed`/`auto` setting. This design makes every project
generic, so the setting adds nothing and would touch ~10 more files
(`SupportedLanguage`, two detectors, two MCP tool schemas, the backfill
script, `indexHealth`, `projectDependencies`). `language` stays as the
primary-language hint for the tree-sitter parser and the dashboard. Keep the
value set as it is.

### 3.8 Readers of the single `pod_name` column

These keep reading one pod per project and will show `(none)` or lose a link
for a multi-pod project. Not blocking; list them as follow-ups:

- `src/embedding/answerSynthesis.ts:495` (`pod=(none)` in every askCodebase overview)
- `src/embedding/embedSynthetic.ts:124-128` (pod name baked into synthetic text)
- `dashboard/src/app/fantom-pods/page.tsx:101-103` (pod card → project link by path or `podName`)
- `src/fantom-code/searchIndex.ts:290-291` (`podId` filter means "a project that is one pod")
- `src/admin/routes.ts:11223`, `:11440` (one-off parse routes take the pod from the dir name)

## 4. Change list

| Size | File | Change |
|---|---|---|
| M | `src/fantom-code/fileRouter.ts` (new) | extension → parser family + version tag; `skip` for `build.fan` |
| M | `src/fantom-code/podParsers.ts` (new) | `buildPodMap`, `podFor`, `PodParserSet` |
| S | `src/fantom-code/scanner.ts:188` | `parseBasicBuildFan` public |
| M | `src/fantom-code/codeIndexingService.ts` | three dispatch sites use `PodParserSet`; pod map built for every language; `rebuildGraphLocked` gets `TrioParser` and the same scanner gate as `:377` |
| S | `src/fantom-code/indexVersion.ts` | `extractorVersionFor` reads the router; `trio` 1→2; add `axon` |
| S | `src/indexing/gitChangeSource.ts`, `src/indexing/focusTools.ts` | `build.fan` change expands to its directory |
| S | `src/graph/ladybugGraphBuilder.ts:40-44` | `langFromPath` from the router |
| S | `src/fantom/projectDependencies.ts:244-257` | nested pod names in the catalogue |
| S | `src/fantom-code/projectLifecycle.ts:43-118` | `removeProject` also deletes `cross_project_edges` and `.cache/graph/<id>.db` |
| S | `AGENTS.md` | index flow: per-extension routing, nearest `build.fan` namespace |

No schema change. No stored `language` or `parserType` value changes.

## 5. Migration for 447 and 448, in order

1. Deploy the code. On the next incremental run the gate re-parses: `.fan`
   rows in tree-sitter projects (`fan-regex` vs `ts:2:fantom`), every `.trio`
   row once (trio 2), `.axon` rows in tree-sitter projects (new family).
   `.fan` rows in regex Fantom projects do not re-parse.
2. Set `447.instanceId` to the SkySpark 3.1.12 instance.
3. Forced reindex of 447. Check `getFantomFunction bassgViz::VizExt.vizCommit`
   returns `Grid vizCommit(Obj diffs)` and that `functionCount` rises above
   183 + 206. This also answers the open "183 functions" question.
4. `rebuildProjectDependencies` for 447 and for every project whose `build.fan`
   depends on `bassgViz`; confirm the rows now point at 447.
5. Remove 448 from the mirror list first:
   `DELETE /admin/sidecar-sync/mirror/:name`. Otherwise the registry re-creates
   it at the next boot (`mirror.ts:146-156`).
6. Export or accept the loss of 448 history: `IndexRun`, `ApiChange`,
   `EdgeChange`, `SymbolLink`, `VectorState`, `IndexedFile`, `ProjectGitState`
   cascade on delete and are keyed by project id, so they cannot re-attach.
7. `removeFantomProject 448`. Then hand-delete what it leaves until §4's
   lifecycle fix lands: `cross_project_edges` with 448 on either side,
   `.cache/graph/448.db`. `GitRoot` rows prune on the next `syncRoots`.
8. `POST /admin/vectors/build-missing` for 447 (renamed symbols get new ids).

Symbol ids for the renamed `.fan`/`.trio` nodes in 447 change once
(`project.name::X` → `bassgViz::X`). The incremental path can bridge a rename
with the same body through `graphPatch` (`src/indexing/graphPatch.ts:286-336`)
but a forced full reindex does not run `graphPatch`. If history continuity for
447's Fantom symbols matters, run step 3 as an incremental run instead of a
forced one and verify the `symbol_links` rows.

## 6. Tests

- `fileRouter.test.ts`: every extension maps to one family; `build.fan` → skip;
  version tag per family; `.fan` tag is `fan-regex:` under both parser types.
- `indexVersion.test.ts`: update the case at `:36-39` (`.fan` now equal under
  both parser types); `.axon` own family; trio bumped; other families stable.
- `podParsers.test.ts`: tmp fixture with `pod/vizExt/build.fan`
  (`podName = "bassgViz"`), `pod/other/build.fan`, a root `.ts`, and
  `.fan` + `.trio` + `.axon` under `pod/vizExt`. Assert longest-prefix pod,
  fallback outside pods, one parser per pod dir, `bassgViz::VizExt.vizCommit`
  with `Grid vizCommit(Obj diffs)` and params `[{diffs, Obj}]`, trio records
  never `unknown::`, `.ts` keeps the project-name namespace.
- Regression snapshot: a Fantom regex project with one root `build.fan` gives
  byte-identical qualified names and signatures before and after.
- `codeIndexingService` integration: `indexProject`, `reindexFiles` and
  `rebuildGraph` on the same fixture give the same set of qualified names
  (no test covers dispatch today; this is a new home).
- `lazyIndexGit.test.ts`: a `build.fan` edit under `pod/x` marks every file
  under `pod/x` modified.
- `graphPatch.test.ts`: qn-prefix change with the same body links as a rename.
- `sidecarMirror.test.ts`: `removeProject` then `registerMirrorSpecs` does not
  re-create the row once the mirror entry is gone.
- `projectDependencies.test.ts`: nested pod name resolves to the parent project.
- `searchIndex`: `podId` filter on a multi-pod project (document the limit).
- Run `npm test`, not bare `npx jest`.

## 7. Risks

- Regex `FantomCodeParser` quirks become the only `.fan` path everywhere (a
  field regex at `codeParser.ts:385` matched `return g` in one read). The
  tree-sitter Fantom path was worse (no params, bad calls), so this is a net
  gain, but the quirks now reach TS projects too.
- Fantom projects stored with `parserType = tree-sitter-wasm` move their
  `.fan` files to regex and re-parse once; signatures change from
  `name(p: T): Ret` to `Ret name(T p)`.
- Nested pods inside existing Fantom projects (root `build.fan` plus
  `pod/*/build.fan`) rename from `root::` to `nested::`. Correct, but ids churn.
- Trio bump re-parses every `.trio` file in every project once.
- Phase 1 version group tags the TS/Vue code of 447 as `skyspark 3.1.12`.
- Unverified on the remote DB: `key_scheme` of 447/448, `instanceId` of 448,
  whether the mirror copy holds a `.git` dir, manual dependency rows on 448,
  and whether 448 is in the mirror project list.

## 8. Open questions for the owner

1. Drop the `mixed`/`auto` language value, as §3.7 says?
2. Is one version group per project (phase 1) enough for now?
3. Bump `trio` (one re-parse of every `.trio` file) or let TS projects
   converge on a forced reindex only?
4. Export 448's symbol history before removal, or accept the loss?
5. Should `.axon` in regex-only Fantom projects start using the axon
   tree-sitter parser? Today they go to `FantomCodeParser`; the router above
   changes that.
6. Should the dependency catalogue use the depth-5 `findBuildFiles` instead of
   `listBuildFanFiles` (`pod/*` and `src/*`, one level, cap 50)?
