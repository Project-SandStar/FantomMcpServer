# MCP Tools Status Report

Last tested: 2026-01-19
Last updated: 2026-01-19 (workspace indexing + doc fixes applied)

## Summary

| Category | Working | Partial | Broken | Total |
|----------|---------|---------|--------|-------|
| Documentation (docs_*) | 8 | 0 | 0 | 8 |
| Code Analysis (code_*) | 8 | 0 | 0 | 8 |
| Code Generation (gen_*) | 8 | 0 | 0 | 8 |
| Project Management (project_*) | 6 | 2 | 0 | 8 |
| Analytics (analytics_*) | 8 | 0 | 0 | 8 |
| Core Tools | 3 | 1 | 0 | 4 |
| Explorer (explorer_*) | 8 | 0 | 0 | 8 |
| **TOTAL** | **49** | **3** | **0** | **52** |

---

## Recent Fixes Applied

### Fixed on 2026-01-19

1. **Documentation tools - Local doc parsing** - All 8 docs_* tools now working
   - Implemented local documentation parsing from SkySpark `doc/` folder
   - Uses `skysparkDocScanner.ts` to scan doc directories
   - Uses `docHtmlExtractor.ts` to extract content from HTML files
   - Caches parsed docs in `.cache/flexsearch-local-{instanceId}.json`
   - Tools: `docs_search`, `docs_getType`, `docs_getPod`, `docs_listPods`, `docs_refreshIndex`, `docs_searchBySignature`, `docs_getExamples`, `docs_findRelated`

2. **Code Analysis - Workspace indexing** - All 4 partial tools now working
   - Injected `FantomCodeIndexer` into `CodeAnalysisAgent`
   - Auto-indexes projects from database on agent initialization
   - **code_findDefinition**: Now searches workspace index after local file
   - **code_findReferences**: Finds references via extends, mixins, return types, parameters
   - **code_getCompletions**: Adds workspace types and public functions to completions
   - **code_getCallHierarchy**: Analyzes call relationships using indexed functions/types

### Fixed on 2026-01-18

1. **Explorer tools routing** - All 8 explorer tools now working
   - Fixed `ExplorerOrchestrationAgent` to register its own tools in `toolRegistry`
   - Fixed `doExecuteTool()` to handle self-execution

2. **project_migrate4x** - Now dynamically creates migrator if not configured
   - Removed early return error when `this.migrator` is null
   - Creates `SkySpark4xMigrator` instance dynamically

3. **gen_pod template variable** - Fixed `${options.name}` interpolation
   - Changed single quotes to template literal in Main.fan body

4. **analytics_trackCustomEvent** - Was actually working
   - Test used wrong parameter; requires `eventType` (documented in schema)

5. **gen_method return type** - Was actually working
   - Test used `returns` instead of correct parameter `returnType`

---

## Documentation Tools (docs_*)

**Status**: ✅ All working - Local doc parsing implemented on 2026-01-19

| Tool | Status | Notes |
|------|--------|-------|
| docs_search | WORKING | Searches local instance documentation |
| docs_getType | WORKING | Gets type info from indexed docs |
| docs_getPod | WORKING | Gets pod documentation |
| docs_listPods | WORKING | Lists all indexed pods |
| docs_refreshIndex | WORKING | Re-parses local docs from SkySpark `doc/` folder |
| docs_searchBySignature | WORKING | Searches by function signature |
| docs_getExamples | WORKING | Gets code examples |
| docs_findRelated | WORKING | Finds related documentation |

**Implementation**: Uses `LocalDocsParser` to scan and parse HTML documentation from SkySpark/Haxall installations. Results cached in `.cache/flexsearch-local-{instanceId}.json`.

---

## Code Analysis Tools (code_*)

**Status**: ✅ All working - Workspace indexing implemented on 2026-01-19

| Tool | Status | Notes |
|------|--------|-------|
| code_parse | WORKING | Parses Fantom source, returns AST with symbols |
| code_getSymbols | WORKING | Extracts symbols from source code |
| code_validateSyntax | WORKING | Validates Fantom syntax correctly |
| code_extractDependencies | WORKING | Extracts `using` statements from code |
| code_findDefinition | WORKING | Searches local file then workspace index |
| code_findReferences | WORKING | Finds references via extends, mixins, types |
| code_getCompletions | WORKING | Includes workspace types and public functions |
| code_getCallHierarchy | WORKING | Analyzes call relationships from indexed data |

**Implementation**: `CodeAnalysisAgent` now uses `FantomCodeIndexer` for workspace-level analysis. Projects are auto-indexed on agent initialization.

---

## Code Generation Tools (gen_*)

| Tool | Status | Notes |
|------|--------|-------|
| gen_class | WORKING | Generates Fantom class code |
| gen_method | WORKING | Use `returnType` parameter (not `returns`) |
| gen_field | WORKING | Generates field declarations |
| gen_pod | WORKING | Template variable fixed |
| gen_enum | WORKING | Generates enum classes |
| gen_mixin | WORKING | Generates mixin code |
| gen_test | WORKING | Generates test class code |
| gen_buildScript | WORKING | Generates build.fan script |

All code generation tools are fully working.

---

## Project Management Tools (project_*)

| Tool | Status | Notes |
|------|--------|-------|
| project_setPrimary | WORKING | Sets primary project context |
| project_getPrimary | WORKING | Gets current primary context |
| project_detectEnvironment | WORKING | Detects SkySpark environment |
| project_listProjects | WORKING | Lists configured projects |
| project_getConfig | WORKING | Gets project configuration |
| project_migrate4x | WORKING | Now creates migrator dynamically |
| project_commitMigration | PARTIAL | Requires valid git repository path |
| project_rollbackMigration | PARTIAL | Requires valid git repository path |

---

## Analytics Tools (analytics_*)

| Tool | Status | Notes |
|------|--------|-------|
| analytics_getUsage | WORKING | Returns tool usage statistics |
| analytics_getTopSearches | WORKING | Returns search history |
| analytics_getToolMetrics | WORKING | Returns performance metrics |
| analytics_clearData | WORKING | Clears analytics data |
| analytics_exportData | WORKING | Exports analytics data |
| analytics_getSessionStats | WORKING | Returns session statistics |
| analytics_getDatabaseInfo | WORKING | Returns database info |
| analytics_trackCustomEvent | WORKING | Use `eventType` parameter |

All analytics tools are fully working.

---

## Core Tools

| Tool | Status | Notes |
|------|--------|-------|
| getFantomType | PARTIAL | Works but core types not indexed |
| listFantomPods | WORKING | Returns 69 pods |
| refreshIndex | WORKING | Refreshes documentation index |
| generateFantomCode | WORKING | Generates Fantom code |

---

## Explorer Tools (explorer_*)

| Tool | Status | Notes |
|------|--------|-------|
| explorer_listTools | WORKING | Lists all 48 MCP tools |
| explorer_getToolSchema | WORKING | Returns tool input schema |
| explorer_executeTool | WORKING | Executes tools with validation |
| explorer_getAgentStatus | WORKING | Returns agent status |
| explorer_browseCategories | WORKING | Browse tools by category |
| explorer_getSystemHealth | WORKING | Returns system health |
| explorer_searchTools | WORKING | Search tools by name/description |
| explorer_getWorkflows | WORKING | Lists available workflows |

All explorer tools are now fully working after the routing fix.

---

## Remaining Issues

### Partial (3 tools)
1. **project_commitMigration** - Requires valid git repository path
2. **project_rollbackMigration** - Requires valid git repository path
3. **getFantomType** - Core types not indexed (works with indexed docs)

### All Major Issues Resolved ✅

The following issues have been fixed:
- ✅ **Documentation tools** - Local doc parsing from SkySpark `doc/` folder (2026-01-19)
- ✅ **Workspace indexing** - Cross-file code analysis enabled (2026-01-19)
- ✅ **Explorer tools** - Routing fixed (2026-01-18)
- ✅ **Code generation** - Template variables fixed (2026-01-18)
- ✅ **Migration tools** - Dynamic migrator creation (2026-01-18)
