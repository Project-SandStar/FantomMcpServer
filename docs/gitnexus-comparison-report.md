# GitNexus vs MCP Fantom: Feature Gap Analysis & Improvement Spec

**Date:** 2026-03-11
**Sources:** [GitNexus](https://github.com/abhigyanpatwari/GitNexus), court-lens-mcp, mcpfantom

---

## Executive Summary

GitNexus is a client-side knowledge graph code intelligence engine that builds precomputed relational graphs from codebases using Tree-sitter ASTs, KuzuDB (property graph database), community detection (Leiden algorithm), and hybrid search (BM25 + semantic + RRF). Compared to mcpfantom's current code graph capabilities, GitNexus offers several advanced features that would significantly improve code intelligence for Fantom/Haxall projects.

This report identifies **8 major feature gaps** and proposes concrete implementation tasks.

---

## 1. Feature Comparison Matrix

| Feature | GitNexus | MCP Fantom | court-lens-mcp | Gap Level |
|---------|----------|------------|----------------|-----------|
| **Call graph traversal** | Recursive BFS with confidence scores | Recursive CTE (callers/callees) | N/A | Medium |
| **Confidence scoring on edges** | 3-tier (0.3-0.9) based on resolution method | Binary (resolved/unresolved) | N/A | **Critical** |
| **Process/execution flow tracing** | BFS from entry points through call chains | None | N/A | **Critical** |
| **Community/clustering detection** | Leiden algorithm with cohesion scoring | None | N/A | **High** |
| **Hybrid search (BM25 + semantic)** | RRF fusion with process-grouped results | Separate FlexSearch + vector search | LanceDB native FTS + vector + RRF | **High** |
| **Impact analysis** | Depth-grouped with risk levels (LOW→CRITICAL) | Basic blast radius via recursive CTE | N/A | **Medium** |
| **Git-diff impact mapping** | `detect_changes` maps diffs → affected processes | None | N/A | **Critical** |
| **Multi-file rename refactoring** | Graph + text search with confidence levels | None | N/A | **High** |
| **Multi-repo support** | Central registry, connection pooling | Single instance at a time | N/A | **Medium** |
| **Pipeline stages (UI progress)** | 6-phase pipeline with progress tracking | Background init, no stage visibility | 14-stage pipeline with Redis progress | **High** |
| **Ingestion orchestrator** | Chunked parsing with memory budgets | Serial parse, no orchestration | Full orchestrator with p-queue, heartbeat | **High** |
| **Embedding provider abstraction** | Optional semantic via configurable embedder | Hardcoded HuggingFace models | Abstract base + OpenAI/Claude/Transformers | **Medium** |
| **Staleness detection** | Checks if index is outdated vs git HEAD | None | N/A | **High** |
| **Cypher/graph query language** | Raw Cypher queries on KuzuDB | Custom DSL (graphQueryDSL.ts) | N/A | Low |
| **Agent hooks (pre/post tool)** | Auto-enriches searches, auto-reindexes | None | N/A | **Medium** |
| **FTS index on vectors** | BM25 via KuzuDB FTS | LanceDB FTS on docs_vectors only | LanceDB native FTS + BM25 | **Medium** |
| **Resume/checkpoint support** | N/A | N/A | Checkpoint per stage, resume on failure | **High** |

---

## 2. Critical Gaps in Callers/Callees

### Current mcpfantom Implementation

**Location:** `src/graph/graphQueryManager.ts`

The current implementation uses SQLite recursive CTEs to traverse `code_edges` for callers/callees. It returns:
- Node ID, name, qualified name
- Depth in call chain
- File path, line number
- Edge type (calls, uses)

### What's Missing vs GitNexus

| Missing Feature | GitNexus Has | Impact |
|----------------|--------------|--------|
| **Confidence scores** | 3-tier: Local (0.85), Import (0.9), Fuzzy (0.3-0.5) | Agents can't distinguish reliable vs speculative edges |
| **Resolution reason** | String explaining why edge was resolved | No transparency on edge quality |
| **Process membership** | Which execution flows a symbol participates in | Can't answer "which workflows use this function?" |
| **Community membership** | Which functional cluster a symbol belongs to | Can't answer "which module area is this in?" |
| **Entry point scoring** | Identifies entry points via naming, exports, call ratio | No concept of entry points vs internal helpers |
| **Cross-file import tracking** | ImportMap resolves calls against imported symbols | mcpfantom resolves calls but doesn't track the resolution method |
| **Enclosing function detection** | `findEnclosingFunction` walks AST to find caller | mcpfantom's regex parser has limited scope resolution |

### Deep Dive: Call Metadata is Captured But Not Exposed

The `FantomCallExtractor` (`src/fantom-code/callExtractor.ts`) already captures rich call context:

```typescript
interface FunctionCall {
  calledName: string;
  calledQualifiedName?: string;
  calleeNodeId?: string;
  lineNumber: number;
  colNumber?: number;
  isStatic: boolean;      // Type.method() vs obj.method()
  isDynamic: boolean;     // Uses -> operator (dynamic dispatch)
  isConstructor: boolean; // Type() or Type.make()
  target?: string;        // "this", "SomeType", "someVar"
  resolved: boolean;
}
```

This data IS stored in `CodeEdge.metadata` as JSON, but the `CallerResult`/`CalleeResult` types discard it all. Three fundamentally different calls appear identical:

```fantom
Str.make()        // Static, constructor — stored as generic "calls"
str.trim()        // Instance, method    — stored as generic "calls"
obj->process()    // Dynamic, method     — stored as generic "calls"
```

Additionally:
- **'parameters' edges NOT created** despite being defined in schema
- **'returns' edges created but never queried** in callers/callees
- **Unresolved references hidden** — if a callee can't be resolved, the edge disappears entirely (only stored in `UnresolvedRef` table)
- **No 'uses' edges populated** — `getCallers()` queries for 'uses' edges but `GraphBuilder` never creates them

### Recommended Fixes

**Task 2.1:** Add first-class columns to `code_edges`:
```prisma
confidence    Float  @default(1.0)           // 0.3-0.9 based on resolution
resolution    String @default("exact")       // "local", "import", "fuzzy", "exact"
callTarget    String? @map("call_target")    // "this", "SomeType", "someVar"
isStaticCall  Boolean @default(false)
isDynamicCall Boolean @default(false)
isConstructor Boolean @default(false)
```

**Task 2.2:** Enhance the Fantom code parser to emit confidence scores during edge creation:
- Same-file calls → 0.85
- Import-resolved calls → 0.9
- Fuzzy/global resolution → 0.3-0.5

**Task 2.3:** Return confidence + call metadata in `getCallers`/`getCallees` results:
```typescript
interface CallerResult {
  // ... existing fields ...
  confidence: number;
  resolution: string;
  callTarget?: string;
  isStaticCall: boolean;
  isDynamicCall: boolean;
  isConstructor: boolean;
}
```

**Task 2.4:** Populate missing edge types:
- Create 'uses' edges for type references (field types, parameter types, return types)
- Create 'parameters' edges from function parameters to their types
- Include unresolved refs in results with `confidence: 0` marker

**Task 2.5:** Add missing composite indexes to `code_edges`:
```prisma
@@index([edgeType, isResolved])
@@index([sourceId, edgeType, isResolved])
```

And missing composite indexes to `code_nodes`:
```prisma
@@index([projectId, nodeType])
@@index([projectId, name])
@@index([projectId, filePath, lineStart])
```

---

## 3. Process/Execution Flow Tracing (NEW FEATURE)

### What GitNexus Does

GitNexus traces execution flows from entry points through call chains using BFS:

1. **Entry Point Discovery:** Scores functions by name patterns (`handle*`, `on*`), export status, and call ratio (calls many, called by few)
2. **BFS Tracing:** Traverses CALLS edges forward, limiting branching (max 4), filtering edges below 0.5 confidence
3. **Deduplication:** Removes subset paths, keeps longest per entry-to-terminal pair
4. **Process Nodes:** Stores ordered sequences with step indices and community memberships

### Implementation Plan for mcpfantom

**Task 3.1:** Create `src/graph/processTracer.ts`:
- `discoverEntryPoints(projectId)` — score functions by naming conventions (Fantom: `make`, `main`, `onXxx`, `doXxx`), public API status, and caller-to-callee ratio
- `traceProcess(entryPointId, maxDepth=10, maxBranching=4)` — BFS through call edges, minimum 3 steps
- `deduplicateTraces()` — remove subsets and keep longest per endpoint pair

**Task 3.2:** Add Prisma models:
```prisma
model ProcessFlow {
  id          String @id @default(uuid())
  projectId   Int    @map("project_id")
  name        String
  entryNodeId String @map("entry_node_id")
  terminalNodeId String @map("terminal_node_id")
  stepCount   Int    @map("step_count")
  flowType    String @map("flow_type") // "intra_module" | "cross_module"
  createdAt   DateTime @default(now())
}

model ProcessStep {
  id         String @id @default(uuid())
  processId  String @map("process_id")
  nodeId     String @map("node_id")
  stepIndex  Int    @map("step_index")
}
```

**Task 3.3:** Expose MCP tools:
- `listProcessFlows` — list all traced execution flows for a project
- `getProcessFlow` — get full step-by-step execution path
- `findProcessesForFunction` — which processes include a given function

---

## 4. Community/Clustering Detection (NEW FEATURE)

### What GitNexus Does

Uses Leiden algorithm to group related symbols into functional communities:
- Builds undirected graph from CALLS, EXTENDS, IMPLEMENTS edges
- Computes cohesion scores (internal edge density)
- Generates labels from folder paths or common name prefixes
- Handles large graphs (>10K symbols) with edge filtering and sampling

### Implementation Plan

**Task 4.1:** Add community detection to `src/graph/communityDetector.ts`:
- Use a JS implementation of Leiden/Louvain (e.g., `graphology` + `graphology-communities-louvain`)
- Build graph from code_edges
- Compute communities with cohesion scores

**Task 4.2:** Add Prisma models:
```prisma
model CodeCommunity {
  id         String @id @default(uuid())
  projectId  Int    @map("project_id")
  label      String
  cohesion   Float  @default(0)
  memberCount Int   @map("member_count")
}
```
Add `communityId` field to `CodeNode`.

**Task 4.3:** Expose via MCP:
- `listCommunities` — list all detected communities with cohesion scores
- `getCommunityMembers` — list all symbols in a community

---

## 5. Hybrid Search with RRF Fusion (UPGRADE)

### Current State

mcpfantom has **two separate search systems** that don't fuse results:
1. **FlexSearch** (`src/search/index.ts`) — keyword search on documentation
2. **LanceDB vectors** (`src/embedding/vectorStore.ts`) — semantic search on code embeddings

The `semanticSearchService.ts` enriches vector results with graph context but doesn't combine with keyword search.

### What GitNexus Does

Reciprocal Rank Fusion (RRF): `score = 1 / (K + rank)` where K=60, combining BM25 + semantic results into a single ranked list. Results are organized by execution processes.

### What court-lens-mcp Does

LanceDB native hybrid search with built-in RRF reranker:
```typescript
import { rerankers } from '@lancedb/lancedb';
this.rrfReranker = new rerankers.RRFReranker();
// Uses both vector similarity and FTS index simultaneously
```

### Implementation Plan

**Task 5.1:** Create `src/search/hybridSearchService.ts`:
- Input: query string
- Run BM25 (FlexSearch) and semantic (LanceDB) search in parallel
- Merge results using RRF formula: `1 / (60 + rank)`
- Track which method(s) found each result
- Return unified ranked results

**Task 5.2:** Upgrade LanceDB code vector store to use native FTS index (like court-lens-mcp does):
```typescript
await this.table.createIndex('text', {
  config: lancedb.Index.fts({
    withPosition: true,
    baseTokenizer: 'simple',
    stem: true,
    removeStopWords: true,
  }),
});
```

**Task 5.3:** Add `hybridCodeSearch` MCP tool that returns fused results with source attribution (bm25/semantic/both).

---

## 6. Git-Diff Impact Mapping (NEW FEATURE)

### What GitNexus Does

The `detect_changes` tool:
1. Runs `git diff` (unstaged, staged, or compare modes)
2. Maps changed lines to indexed symbols
3. Traces impacted execution flows
4. Flags high-risk modifications

### Implementation Plan

**Task 6.1:** Create `src/graph/changeDetector.ts`:
- `getUnstagedChanges(projectPath)` — parse `git diff` output
- `mapChangesToSymbols(changes, projectId)` — match changed file:line to code_nodes
- `traceImpactedFlows(affectedNodeIds)` — find all processes containing affected nodes

**Task 6.2:** Expose MCP tool:
- `detectChanges` — input: scope (unstaged/staged/all), optional base_ref
- Returns: changed symbols, affected processes, risk assessment per change

---

## 7. Ingestion Pipeline Orchestrator (UPGRADE)

### Current State

mcpfantom's code indexing is a simple sequential flow:
1. Parse source files (regex-based)
2. Store in Prisma
3. Build graph edges
4. Generate embeddings (background)

No progress tracking, no stage checkpoints, no resume on failure, no memory management.

### What court-lens-mcp Does

Full-featured `IngestionPipeline` orchestrator:
- **14 named stages** with ordered progression
- **Redis-based progress publishing** for real-time UI updates
- **Heartbeat mechanism** (60s interval) to keep progress alive during long stages
- **Checkpoint system** — stores last completed stage per document for resume
- **Stop/cancel support** — user can abort mid-pipeline
- **Batch embedding** with configurable batch size
- **OCR worker pool** with CPU load throttling
- **p-queue** for concurrent task management
- **Stage timing** — records milliseconds per stage for diagnostics

### Current State (Detailed)

The mcpfantom indexing pipeline has **8 critical orchestration gaps** identified:

1. **No dedicated orchestrator** — each component works independently
2. **No concurrency control** — multiple requests can trigger simultaneous indexing (race conditions)
3. **No progress streaming** — long operations appear stuck
4. **No job queue** — all work is synchronous or fire-and-forget
5. **No checkpointing** — complete failure restarts entire operation
6. **No incremental indexing** — code always does full rebuild (unlike embedding pipeline)
7. **No operation audit log** — no indexing history or failure tracking
8. **No dependency resolution triggering** — `resolveAllReferences()` exists but requires manual call

### court-lens-mcp 3-Tier Orchestration Model (to adopt)

**Tier 1: Service Manager** — Central singleton registry managing all service lifecycles
**Tier 2: Job Queue + Worker Pool** — Document processing with:
- Configurable concurrency
- Exponential backoff retry (3 attempts: 1s → 2s → 4s)
- PrismaClient persistence for crash recovery
- PID controller for dynamic worker allocation based on queue depth
**Tier 3: Background Scanner Daemon** — Main event loop with periodic PID ticks (1000ms)

### Implementation Plan

**Task 7.1:** Create `src/fantom-code/indexingPipeline.ts` with named stages:
```typescript
const CODE_INDEX_STAGES = [
  'discovery',          // Find source files
  'parsing',            // Parse ASTs / regex extraction
  'symbol-resolution',  // Resolve cross-file references
  'graph-building',     // Create edges
  'community-detection',// Cluster symbols
  'process-tracing',    // Trace execution flows
  'embedding-generation',// Generate vectors
  'vector-indexing',    // Store in LanceDB
  'verification',       // Validate graph integrity
  'complete',
] as const;
```

**Task 7.2:** Add checkpoint support (from court-lens-mcp pattern):
```typescript
interface IndexCheckpoint {
  lastCompletedStage?: string;
  processedFiles?: number;
  totalFiles?: number;
  errors?: number;
  updatedAt?: string;
}
```
- Store checkpoint in `GraphBuildStats` model
- On restart, resume from last completed stage
- Support incremental re-indexing via file hash comparison

**Task 7.3:** Add progress publishing (from court-lens-mcp Redis pattern):
- Emit events via SSE on `/admin/indexing/progress`
- Heartbeat mechanism (60s) to keep progress alive during long stages
- Dashboard displays current stage, percentage, timing per stage

**Task 7.4:** Add concurrency control:
- Lock per project (prevent concurrent indexing of same project)
- Duplicate operation detection
- Job queue with configurable concurrency

**Task 7.5:** Add stop/cancel support:
- Check for stop flag between stages
- `DocumentStoppedError` pattern from court-lens-mcp
- Clean rollback of partial data

**Task 7.6:** Add retry with exponential backoff:
- Per-stage retry (3 attempts: 1s → 2s → 4s)
- Distinguish retryable vs fatal errors
- Final status stored in `GraphBuildStats`

---

## 8. Staleness Detection (NEW FEATURE)

### What GitNexus Does

Compares index timestamp against `git log --format=%H -1` to determine if the index is outdated. Surfaces staleness info via `gitnexus://repo/{name}/context` resource.

### Implementation Plan

**Task 8.1:** Create `src/graph/stalenessChecker.ts`:
- Compare `GraphBuildStats.lastBuildAt` against latest git commit timestamp
- Check if any files in the project have been modified since last index
- Return staleness status: `fresh`, `stale`, `unknown`

**Task 8.2:** Expose via:
- `GET /admin/projects/:id/staleness` — admin endpoint
- `getProjectStatus` MCP tool enhancement — include staleness info

**Task 8.3:** Optional auto-reindex hook:
- After tool calls that modify code, trigger background re-index if stale

---

## 9. Embedding Provider Abstraction (UPGRADE)

### Current State

mcpfantom has hardcoded embedding providers:
- Code: `bge-small-en-v1.5` (384d) via `@huggingface/transformers`
- Docs: `jina-embeddings-v2-base-en` (768d) via `@huggingface/transformers`

### What court-lens-mcp Does

Abstract `EmbeddingProvider` base class with pluggable implementations:
- `TransformersEmbeddingProvider` — local HuggingFace models
- `OpenAIEmbeddingProvider` — OpenAI API (text-embedding-3-small/large)
- `ClaudeEmbeddingProvider` — Claude API
- `OllamaEmbeddingProvider` — local Ollama models

Each provider implements: `embed(texts)`, `getDimensions()`, `getAvailableModels()`, `getModelName()`.

### Implementation Plan

**Task 9.1:** Create `src/embedding/providers/` directory:
- `base.ts` — abstract `EmbeddingProvider` interface
- `transformers.ts` — current HuggingFace implementation
- `ollama.ts` — Ollama local models (nomic-embed-text, etc.)

**Task 9.2:** Make provider configurable via `config/fantomMcpServer-config.json`:
```json
{
  "embedding": {
    "codeProvider": "transformers",
    "codeModel": "bge-small-en-v1.5",
    "docsProvider": "transformers",
    "docsModel": "jina-embeddings-v2-base-en"
  }
}
```

**Task 9.3:** Add admin endpoint to switch providers and trigger re-embedding.

---

## 10. Implementation Priority & Task Summary

### Phase 1: Critical (Weeks 1-2)
| # | Task | Effort | Files |
|---|------|--------|-------|
| 2.1 | Add confidence/resolution/callTarget columns to code_edges | S | schema.prisma, migration |
| 2.2 | Emit confidence scores during edge creation | M | parser, graphBuilder |
| 2.3 | Return confidence + call metadata in callers/callees results | S | graphQueryManager.ts |
| 2.4 | Populate missing edge types (uses, parameters) | M | graphBuilder.ts |
| 2.5 | Add missing composite indexes | S | schema.prisma |
| 6.1 | Git-diff to symbol mapping | M | new: changeDetector.ts |
| 6.2 | `detectChanges` MCP tool | S | index.ts, graphTools.ts |

### Phase 2: High Priority (Weeks 3-4)
| # | Task | Effort | Files |
|---|------|--------|-------|
| 3.1 | Process/execution flow tracer | L | new: processTracer.ts |
| 3.2 | Process Prisma models | S | schema.prisma |
| 3.3 | Process MCP tools | M | index.ts, graphTools.ts |
| 5.1 | Hybrid search with RRF fusion | M | new: hybridSearchService.ts |
| 5.2 | LanceDB native FTS index | S | vectorStore.ts |
| 5.3 | `hybridCodeSearch` MCP tool | S | index.ts |

### Phase 3: Important (Weeks 5-6)
| # | Task | Effort | Files |
|---|------|--------|-------|
| 4.1 | Community detection (Leiden/Louvain) | L | new: communityDetector.ts |
| 4.2 | Community Prisma models | S | schema.prisma |
| 4.3 | Community MCP tools | S | index.ts |
| 7.1 | Indexing pipeline with named stages | L | new: indexingPipeline.ts |
| 7.2 | Checkpoint/resume support | M | GraphBuildStats model |
| 7.3 | Progress SSE endpoint | M | admin/routes.ts |
| 7.4 | Concurrency control (locks, dedup) | M | indexingPipeline.ts |
| 8.1 | Staleness checker | S | new: stalenessChecker.ts |
| 8.2 | Staleness admin/MCP endpoints | S | admin/routes.ts, index.ts |

### Phase 4: Nice to Have (Week 7+)
| # | Task | Effort | Files |
|---|------|--------|-------|
| 7.5 | Stop/cancel indexing support | M | indexingPipeline.ts |
| 7.6 | Retry with exponential backoff | M | indexingPipeline.ts |
| 8.3 | Auto-reindex hook | S | index.ts |
| 9.1 | Embedding provider abstraction | M | new: providers/*.ts |
| 9.2 | Provider configuration | S | config |
| 9.3 | Provider switching admin endpoint | S | admin/routes.ts |
| 10.1 | MCP Resources for graph data | M | index.ts |
| 10.2 | Graph-aware rename MCP tool | L | new: renameService.ts |
| 10.3 | Claude Code hooks for auto-augmentation | M | .claude/skills/ |

**Effort Key:** S = Small (< 1 day), M = Medium (1-2 days), L = Large (3-5 days)

---

## 11. Additional GitNexus Features Worth Considering

### 11.0.1 Augmentation Engine (Agent Hook System)

GitNexus has a lightweight hook-based system that intercepts agent grep/glob/search commands and enriches results with knowledge graph context. Designed for <500ms cold start, <200ms warm. Uses BM25 only (no embeddings) for speed.

- **PreToolUse hooks**: Auto-augment search results with graph context
- **PostToolUse hooks**: Auto-reindex after git commits
- Ships as `.claude/skills/gitnexus/` with 7 predefined skills

**Recommendation for mcpfantom:** Consider adding Claude Code hooks that automatically augment code searches with graph context. The `agents/` directory already has an agent framework — hooks would make it proactive.

### 11.0.2 Wiki Generator

GitNexus can generate documentation/wiki from the knowledge graph with LLM assistance (`src/core/wiki/`). Uses graph queries to produce architecture overviews.

**Recommendation:** Low priority but valuable. Could auto-generate pod documentation from graph data.

### 11.0.3 Graph-Aware Rename Tool

Unlike find-and-replace, uses the knowledge graph to find all references with confidence levels:
- Graph-resolved references: high confidence (automatic)
- Text-search matches: lower confidence (manual review)

**Recommendation:** Would be very useful for Fantom refactoring. Add as Phase 4 MCP tool.

### 11.0.4 MCP Resources (Not Just Tools)

GitNexus exposes project metadata as **MCP Resources** (not just tools):
- `gitnexus://repos` — repository inventory
- `gitnexus://repo/{name}/context` — stats + staleness
- `gitnexus://repo/{name}/clusters` — community clusters
- `gitnexus://repo/{name}/processes` — execution flows
- `gitnexus://repo/{name}/schema` — graph schema for queries

mcpfantom has workflow resources but no code graph resources. Adding these would give agents instant context without tool calls.

## 12. Architecture: Triple-Database with LadybugDB

### 12.1 KuzuDB is Dead — LadybugDB is its Successor

KuzuDB was **archived on October 10, 2025** (read-only, no new releases). However, the project was reborn as **LadybugDB** under the `LadybugDB/ladybug` GitHub organization:

| | KuzuDB (dead) | LadybugDB (active) | FalkorDB |
|---|---|---|---|
| **Status** | Archived Oct 2025 | Active, v0.15.1 (Mar 2026) | Active, 3.7K stars |
| **Architecture** | Embedded | Embedded (same codebase) | Server (needs Redis 7.4+) |
| **License** | MIT | MIT | SSPL (restrictive) |
| **Cypher** | Yes | Yes | Yes (OpenCypher) |
| **Vectors** | No | Yes (built-in HNSW) | Yes |
| **FTS** | Extension | Built-in | Built-in |
| **WASM** | Yes | Yes | No |
| **Node.js** | `kuzu` (frozen) | `@ladybugdb/core` | `falkordb-ts` |
| **Commits** | 5,231 (frozen) | 5,674 (continued) | 2,184 |
| **Persistence** | Columnar disk | Columnar disk | Redis |

**LadybugDB is KuzuDB continued** — same codebase, same architecture, MIT license, actively maintained. FalkorDB requires a Redis server and has SSPL licensing restrictions. LadybugDB is the clear choice.

### 12.2 Triple-Database Architecture: Separated Concerns

The key insight: **don't sync databases — separate their domains.** Each database owns its concern. The indexing pipeline is the only writer, and it writes to all three once during index operations.

```
┌──────────────────────────────────────────────────────────────────┐
│                        MCP Tools Layer                           │
│  getCallers, semanticSearch, hybridSearch, listProjects, etc.    │
├─────────────┬────────────────────┬───────────────┬───────────────┤
│   SQLite    │    LadybugDB       │    LanceDB    │   FlexSearch  │
│   (Prisma)  │ (@ladybugdb/core)    │ (@lancedb)    │  (in-memory)  │
├─────────────┼────────────────────┼───────────────┼───────────────┤
│ Projects    │ CodeNode tables    │ code_vectors  │ Keyword index │
│ Instances   │ CodeRelation edges │ docs_vectors  │ (doc search)  │
│ Pods        │ Community nodes    │               │               │
│ Builds      │ Process nodes      │               │               │
│ Auth/OAuth  │ Process steps      │               │               │
│ Settings    │ FTS index          │               │               │
│ Usage stats │ Embeddings (opt.)  │               │               │
│ DocIndex    │                    │               │               │
│ GraphBuild  │                    │               │               │
│   Stats     │                    │               │               │
└─────────────┴────────────────────┴───────────────┴───────────────┘
       ↑               ↑                    ↑              ↑
       └───────────────┴────────────────────┘              │
              Indexing Pipeline                    Cache Manager
           (writes to all three)               (loads from .cache/)
```

**Why no sync layer is needed:**
- The indexing pipeline is the **only writer** — it writes to all three stores during a single index operation
- Re-index = clear all three + rebuild from source
- Read queries **never cross databases** — each MCP tool knows which store to query
- The `node_id` (16-char MD5 hash) is the shared key across all stores
- If a vector search result needs graph context, the MCP tool does a second lookup by `node_id` in LadybugDB

### 12.3 What Each Database Owns

**SQLite/Prisma** — Metadata, configuration, and operational state:
- Keep: Instance, FantomBuild, Pod, CompileLog, FantomProject, Setting, DocIndex, ToolEvent, SearchEvent, OAuth models, GraphBuildStats
- **Remove**: CodeNode, CodeEdge, UnresolvedRef (move to LadybugDB)

**LadybugDB** — All graph data and graph queries:
- Node tables: Function, Class, Mixin, Enum, Method, Field, Constructor, Community, Process
- Relationship table: CodeRelation (CALLS, EXTENDS, IMPLEMENTS, CONTAINS, USES, RETURNS, OVERRIDES, MEMBER_OF, STEP_IN_PROCESS)
- All graph traversal: callers, callees, impact, paths, cycles, communities, processes
- Built-in FTS for code symbol search
- Optional: store embeddings directly (LadybugDB has native HNSW vector index)

**LanceDB** — Semantic vector search:
- code_vectors (384d, code embeddings)
- docs_vectors (768d, documentation embeddings)
- Hybrid search (vector + FTS + RRF reranking)
- Documentation semantic search

### 12.4 LadybugDB Schema for mcpfantom

Translating the current Prisma CodeNode/CodeEdge models to LadybugDB Cypher:

```cypher
-- Core code element node tables
CREATE NODE TABLE Function(
  id STRING PRIMARY KEY,
  projectId INT64,
  name STRING,
  qualifiedName STRING,
  filePath STRING,
  lineStart INT64,
  lineEnd INT64,
  colStart INT64,
  colEnd INT64,
  signature STRING,
  documentation STRING,
  returnType STRING,
  modifiers STRING,
  facets STRING,
  parentType STRING,
  isPublic BOOLEAN,
  isStatic BOOLEAN,
  isAbstract BOOLEAN,
  isVirtual BOOLEAN,
  isOverride BOOLEAN,
  isExported BOOLEAN,
  language STRING DEFAULT 'fantom'
);

CREATE NODE TABLE Type(
  id STRING PRIMARY KEY,
  projectId INT64,
  name STRING,
  qualifiedName STRING,
  nodeType STRING,        -- 'class', 'mixin', 'enum', 'facet'
  filePath STRING,
  lineStart INT64,
  lineEnd INT64,
  signature STRING,
  documentation STRING,
  modifiers STRING,
  isPublic BOOLEAN,
  isAbstract BOOLEAN,
  language STRING DEFAULT 'fantom'
);

CREATE NODE TABLE Community(
  id STRING PRIMARY KEY,
  projectId INT64,
  label STRING,
  heuristicLabel STRING,
  cohesion DOUBLE,
  memberCount INT64
);

CREATE NODE TABLE Process(
  id STRING PRIMARY KEY,
  projectId INT64,
  name STRING,
  processType STRING,     -- 'intra_module', 'cross_module'
  stepCount INT64,
  entryNodeId STRING,
  terminalNodeId STRING
);

-- Unified relationship table (like GitNexus)
CREATE REL TABLE CodeRelation(
  FROM Function  TO Function,
  FROM Function  TO Type,
  FROM Type      TO Type,
  FROM Type      TO Function,
  FROM Function  TO Community,
  FROM Type      TO Community,
  FROM Function  TO Process,
  type STRING,            -- 'calls', 'extends', 'implements', 'contains', etc.
  confidence DOUBLE DEFAULT 1.0,
  resolution STRING,      -- 'local', 'import', 'fuzzy', 'exact'
  lineNumber INT64,
  colNumber INT64,
  callTarget STRING,      -- 'this', 'SomeType', 'someVar'
  isStaticCall BOOLEAN DEFAULT FALSE,
  isDynamicCall BOOLEAN DEFAULT FALSE,
  isConstructor BOOLEAN DEFAULT FALSE,
  step INT32 DEFAULT 0    -- For STEP_IN_PROCESS ordering
);
```

### 12.5 Query Migration: SQLite CTEs → Cypher

**getCallers — Before (30-line recursive CTE):**
```sql
WITH RECURSIVE callers AS (
  SELECT n.id, n.name, n.qualified_name, 1 as depth, n.file_path,
         e.line_number, e.edge_type
  FROM code_nodes n
  INNER JOIN code_edges e ON e.source_id = n.id
  WHERE e.target_id = $nodeId AND e.edge_type IN ('calls', 'uses')
  UNION ALL
  SELECT n.id, n.name, n.qualified_name, c.depth + 1, n.file_path,
         e.line_number, e.edge_type
  FROM code_nodes n
  INNER JOIN code_edges e ON e.source_id = n.id
  INNER JOIN callers c ON e.target_id = c.id
  WHERE c.depth < $maxDepth AND e.edge_type IN ('calls', 'uses')
)
SELECT DISTINCT id, name, qualified_name, MIN(depth) as depth,
       file_path, line_number, edge_type
FROM callers GROUP BY id ORDER BY depth ASC
```

**getCallers — After (5-line Cypher):**
```cypher
MATCH path = (caller)-[r:CodeRelation*1..5]->(target)
WHERE target.id = $nodeId
  AND ALL(rel IN relationships(path) WHERE rel.type IN ['calls', 'uses'])
RETURN DISTINCT caller.id, caller.name, caller.qualifiedName,
       length(path) AS depth, caller.filePath,
       r[0].lineNumber AS lineNumber, r[0].confidence AS confidence
ORDER BY depth ASC
```

**getCallees — After:**
```cypher
MATCH path = (source)-[r:CodeRelation*1..5]->(callee)
WHERE source.id = $nodeId
  AND ALL(rel IN relationships(path) WHERE rel.type = 'calls')
RETURN DISTINCT callee.id, callee.name, callee.qualifiedName,
       length(path) AS depth, callee.filePath,
       r[0].confidence AS confidence, r[0].isStaticCall, r[0].isDynamicCall
ORDER BY depth ASC
```

**getImpact — After (with risk levels):**
```cypher
MATCH path = (affected)-[r:CodeRelation*1..10]->(target)
WHERE target.id = $nodeId
  AND ALL(rel IN relationships(path) WHERE rel.type IN ['calls','extends','implements','uses'])
WITH affected, min(length(path)) AS minDepth,
     collect(DISTINCT [rel IN relationships(path) | rel.type]) AS edgeTypes
RETURN affected.id, affected.name, affected.qualifiedName,
       affected.filePath, minDepth, edgeTypes,
       CASE
         WHEN minDepth = 1 THEN 'CRITICAL'
         WHEN minDepth = 2 THEN 'HIGH'
         WHEN minDepth <= 4 THEN 'MEDIUM'
         ELSE 'LOW'
       END AS riskLevel
ORDER BY minDepth ASC
```

**findPath — After:**
```cypher
MATCH path = shortestPath((a)-[r:CodeRelation*..10]->(b))
WHERE a.id = $fromId AND b.id = $toId
RETURN [n IN nodes(path) | n.id] AS nodeIds,
       [n IN nodes(path) | n.name] AS names,
       [r IN relationships(path) | r.type] AS edgeTypes,
       length(path) AS depth
```

**detectCycles — After:**
```cypher
MATCH path = (a)-[r:CodeRelation*2..20]->(a)
WHERE a.projectId = $projectId
  AND ALL(rel IN relationships(path) WHERE rel.type = 'calls')
RETURN [n IN nodes(path) | n.name] AS cycle, length(path) AS length
ORDER BY length ASC
LIMIT 10
```

**Community members — New (not possible with SQLite):**
```cypher
MATCH (n)-[r:CodeRelation]->(c:Community)
WHERE c.id = $communityId AND r.type = 'MEMBER_OF'
RETURN n.id, n.name, n.qualifiedName, n.filePath
ORDER BY n.name
```

**Process flow — New:**
```cypher
MATCH (n)-[r:CodeRelation]->(p:Process)
WHERE p.id = $processId AND r.type = 'STEP_IN_PROCESS'
RETURN n.id, n.name, n.qualifiedName, r.step AS stepIndex
ORDER BY r.step ASC
```

### 12.6 Implementation Plan: LadybugDB Integration

#### Phase 0: Setup (Day 1)

| # | Task | Effort | Details |
|---|------|--------|---------|
| L0.1 | Install `@ladybugdb/core` | S | `npm install @ladybugdb/core` |
| L0.2 | Create `src/graph/ladybugConnection.ts` | S | Singleton: init, close, health check, getConnection |
| L0.3 | Create `src/graph/ladybugSchema.ts` | S | Schema creation queries (from 12.4 above) |
| L0.4 | DB location: `.cache/fantom-graph.db` | S | Single file, alongside `fantom.db` and `fantomvector.db` |

```typescript
// src/graph/ladybugConnection.ts
import Database from '@ladybugdb/core';

let db: Database | null = null;
let conn: any = null;

export async function getLadybugDb(): Promise<Database> {
  if (!db) {
    const dbPath = path.join(process.cwd(), '.cache', 'fantom-graph.db');
    db = new Database(dbPath);
    conn = await db.getConnection();
    await initSchema(conn);
  }
  return db;
}

export async function getLadybugConn() {
  await getLadybugDb();
  return conn;
}

export async function executeCypher(query: string, params?: Record<string, any>) {
  const connection = await getLadybugConn();
  return connection.execute(query, params);
}

export async function closeLadybug() {
  if (conn) { conn.close(); conn = null; }
  if (db) { db.close(); db = null; }
}
```

#### Phase 1: Graph Builder Migration (Days 2-4)

| # | Task | Effort | Details |
|---|------|--------|---------|
| L1.1 | Create `src/graph/ladybugGraphBuilder.ts` | L | New graph builder writing to LadybugDB instead of Prisma |
| L1.2 | Migrate node creation | M | `prisma.codeNode.create` → `CREATE (n:Function {...})` Cypher |
| L1.3 | Migrate edge creation | M | `prisma.codeEdge.create` → `MATCH...CREATE` with confidence, resolution, callTarget |
| L1.4 | Migrate `clearProjectGraph()` | S | `MATCH (n) WHERE n.projectId = $id DETACH DELETE n` |
| L1.5 | Migrate unresolved refs | S | Store as low-confidence edges (confidence: 0.1) instead of separate table |
| L1.6 | Bulk import via CSV | M | Use LadybugDB COPY for faster indexing (like GitNexus does) |

Key difference from current approach: **unresolved references become low-confidence edges** instead of a separate table. This means `getCallers` naturally includes them with a confidence filter:

```cypher
MATCH (caller)-[r:CodeRelation]->(target {id: $nodeId})
WHERE r.type = 'calls' AND r.confidence >= $minConfidence
RETURN caller.name, r.confidence, r.resolution
```

#### Phase 2: Query Manager Migration (Days 5-7)

| # | Task | Effort | Details |
|---|------|--------|---------|
| L2.1 | Create `src/graph/ladybugQueryManager.ts` | L | Rewrite all 6 query methods in Cypher (from 12.5 above) |
| L2.2 | Migrate getCallers | S | 30-line CTE → 5-line Cypher |
| L2.3 | Migrate getCallees | S | Same pattern |
| L2.4 | Migrate getImpact | M | Add risk levels (CRITICAL/HIGH/MEDIUM/LOW) |
| L2.5 | Migrate findPath | S | Use `shortestPath()` built-in |
| L2.6 | Migrate detectCycles | S | Native cycle detection |
| L2.7 | Migrate getMetrics | S | Single Cypher query vs 6 Prisma count queries |
| L2.8 | Update graphToolHandlers.ts | M | Swap `GraphQueryManager` for `LadybugQueryManager` |

#### Phase 3: New Features Enabled by LadybugDB (Days 8-12)

| # | Task | Effort | Details |
|---|------|--------|---------|
| L3.1 | Community detection | L | Leiden via graphology on exported graph, store as Community nodes |
| L3.2 | Process flow tracing | L | BFS from entry points, store as Process nodes with STEP_IN_PROCESS edges |
| L3.3 | `listCommunities` MCP tool | S | Query Community nodes |
| L3.4 | `getProcessFlow` MCP tool | S | Query Process + steps |
| L3.5 | `findProcessesForFunction` MCP tool | S | Match function → Process memberships |
| L3.6 | Native Cypher passthrough tool | S | Replace custom graphQueryDSL with direct Cypher execution |

#### Phase 4: Prisma Schema Cleanup (Day 13)

| # | Task | Effort | Details |
|---|------|--------|---------|
| L4.1 | Remove CodeNode model from Prisma | S | Graph data now in LadybugDB |
| L4.2 | Remove CodeEdge model from Prisma | S | Relationships now in LadybugDB |
| L4.3 | Remove UnresolvedRef model from Prisma | S | Now low-confidence edges |
| L4.4 | Keep GraphBuildStats in Prisma | — | Still tracks indexing metadata |
| L4.5 | Migration script | M | Prisma migrate + data migration for existing installs |

#### Phase 5: 3D Graph Visualization (Days 14-16)

| # | Task | Effort | Details |
|---|------|--------|---------|
| L5.1 | Install `3d-force-graph` in dashboard | S | `cd dashboard && npm install 3d-force-graph` |
| L5.2 | Admin API: `GET /admin/graph/data` | M | Return all nodes + edges as JSON for a project |
| L5.3 | Create `dashboard/pages/graph3d.tsx` | L | React component with 3D force-directed graph |
| L5.4 | Node coloring by community | S | Each community gets a distinct color |
| L5.5 | Node sizing by importance | S | Size by caller count (in-degree) |
| L5.6 | Edge styling by type | S | calls=blue, extends=green, implements=orange |
| L5.7 | Click-to-inspect node details | M | Panel showing callers, callees, file location |
| L5.8 | Filter controls | M | Filter by project, node type, community, edge type |

**3D Visualization Example:**
```typescript
// dashboard/components/Graph3DViewer.tsx
import dynamic from 'next/dynamic';
import { useQuery } from '@tanstack/react-query';

// 3d-force-graph uses Three.js — must be client-only
const ForceGraph3D = dynamic(() => import('react-force-graph-3d'), { ssr: false });

const COMMUNITY_COLORS = [
  '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231',
  '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabebe',
];

const EDGE_COLORS: Record<string, string> = {
  calls: '#4a90d9',
  extends: '#2ecc71',
  implements: '#e67e22',
  contains: '#95a5a6',
  uses: '#9b59b6',
  returns: '#1abc9c',
  overrides: '#e74c3c',
};

export function Graph3DViewer({ projectId }: { projectId: number }) {
  const { data } = useQuery({
    queryKey: ['graph-data', projectId],
    queryFn: () => fetch(`/admin/graph/data?projectId=${projectId}`).then(r => r.json()),
  });

  if (!data) return <div>Loading graph...</div>;

  return (
    <ForceGraph3D
      graphData={{
        nodes: data.nodes.map((n: any) => ({
          id: n.id,
          name: n.name,
          type: n.nodeType,
          community: n.communityId,
          callerCount: n.callerCount,
        })),
        links: data.edges.map((e: any) => ({
          source: e.sourceId,
          target: e.targetId,
          type: e.type,
          confidence: e.confidence,
        })),
      }}
      nodeLabel={node => `${node.name} (${node.type})`}
      nodeColor={node => COMMUNITY_COLORS[node.community % COMMUNITY_COLORS.length]}
      nodeVal={node => Math.max(1, Math.log2(node.callerCount + 1) * 3)}
      linkColor={link => EDGE_COLORS[link.type] || '#cccccc'}
      linkOpacity={0.6}
      linkDirectionalArrowLength={3.5}
      linkDirectionalArrowRelPos={1}
      linkWidth={link => link.confidence > 0.8 ? 1.5 : 0.5}
      enableNodeDrag={true}
      enableNavigationControls={true}
    />
  );
}
```

### 12.7 File Storage Layout After Migration

```
.cache/
├── fantom.db              # SQLite/Prisma (metadata, auth, config)
├── fantom-graph.db        # LadybugDB (graph nodes, edges, communities, processes)
├── fantomvector.db/       # LanceDB directory (code + docs vectors)
│   ├── code_vectors.lance/
│   └── docs_vectors.lance/
├── flexsearch-fantom.json # FlexSearch cache (keyword search)
└── usage.db               # SQLite (usage tracking — legacy)
```

### 12.8 LadybugDB-Specific Advantages Over Current SQLite

| Capability | SQLite (current) | LadybugDB (proposed) |
|------------|------------------|---------------------|
| `getCallers(depth=5)` | 30-line recursive CTE, O(n log n) per hop | 5-line Cypher, O(1) per hop (index-free adjacency) |
| `getCallers(depth=10)` | Noticeably slow | Same performance as depth=5 |
| `shortestPath` | Custom BFS in CTE, string concatenation for paths | Built-in `shortestPath()` function |
| `detectCycles` | CTE with INSTR cycle check (fragile) | Native cycle detection |
| Pattern matching | Not possible | `MATCH (a)-[:CALLS]->(b)-[:EXTENDS]->(c)` |
| Community storage | Would need new Prisma model | Native Community node table |
| Process storage | Would need new Prisma model | Native Process node table |
| Unresolved refs | Separate table, invisible in queries | Low-confidence edges, always visible |
| Cypher queries | Custom DSL translated to SQL | Direct Cypher execution |
| FTS on code symbols | FlexSearch (separate, in-memory) | Built-in FTS (persistent) |
| WASM (browser) | N/A | Possible for dashboard graph queries |

### 12.9 Revised Implementation Priority

The LadybugDB migration **replaces and consolidates** many tasks from the original Phase 1-4 plan:

**New Phase 1: LadybugDB Foundation (Week 1-2)**

| # | Task | Effort | Replaces |
|---|------|--------|----------|
| L0.1-L0.4 | LadybugDB setup + schema | M | — |
| L1.1-L1.6 | Graph builder migration | L | Tasks 2.1-2.5 (confidence, edge metadata, indexes all built into schema) |
| L2.1-L2.8 | Query manager migration | L | Existing graphQueryManager.ts rewrite |

**New Phase 2: New Graph Features (Week 3-4)**

| # | Task | Effort | Replaces |
|---|------|--------|----------|
| L3.1-L3.2 | Communities + process tracing | L | Tasks 3.1-3.2, 4.1-4.2 |
| L3.3-L3.6 | New MCP tools | M | Tasks 3.3, 4.3 |
| 6.1-6.2 | Git-diff impact mapping | M | Unchanged |
| 5.1-5.3 | Hybrid search with RRF | M | Unchanged |

**New Phase 3: Pipeline + Visualization (Week 5-6)**

| # | Task | Effort | Replaces |
|---|------|--------|----------|
| 7.1-7.6 | Indexing pipeline orchestrator | L | Unchanged |
| 8.1-8.2 | Staleness detection | S | Unchanged |
| L5.1-L5.8 | 3D graph visualization | L | New |

**New Phase 4: Polish (Week 7+)**

| # | Task | Effort | Replaces |
|---|------|--------|----------|
| L4.1-L4.5 | Prisma cleanup + migration | M | — |
| 9.1-9.3 | Embedding provider abstraction | M | Unchanged |
| 10.1-10.3 | MCP resources, rename, hooks | L | Unchanged |

### 12.10 Tree-sitter Migration Path

GitNexus supports 12 languages via Tree-sitter. mcpfantom already has `parserType: "tree-sitter-wasm"` in the schema but the primary parser is still regex-based. Tree-sitter would unlock:
- Accurate scope detection (find enclosing function for a call site)
- Better cross-file import resolution
- Language-agnostic AST queries

**Recommendation:** Continue the existing tree-sitter migration. Prioritize Fantom and Axon tree-sitter grammars.

### 12.11 Result Organization by Process

GitNexus organizes search results by execution process (workflow), not just by relevance score. This helps agents understand *which workflow* a match belongs to, not just *what* it matches.

**Recommendation:** After implementing process tracing (Task L3.2), group search results by process membership in hybrid search output.

---

## 13. MCP Tool Gap Summary (Updated)

### Tools GitNexus Has That mcpfantom Lacks

| GitNexus Tool | Description | mcpfantom Equivalent | Status |
|---------------|-------------|---------------------|--------|
| `query` | Hybrid search grouped by processes | `searchFantomCode` + `semanticCodeSearch` (separate) | Needs fusion |
| `context` | 360-degree symbol view (callers, callees, processes) | `getCallers` + `getCallees` (separate, no process info) | Needs enrichment |
| `impact` | Blast radius with depth/risk grouping | `getCodeImpact` (basic, no risk levels) | Needs upgrade |
| `detect_changes` | Git-diff → affected processes mapping | **None** | New feature |
| `rename` | Graph-aware multi-file rename | **None** | New feature |
| `cypher` | Raw graph queries | `graphQuery` (custom DSL) | Adequate |
| `list_repos` | Multi-repo discovery | `listFantomProjects` | Adequate |

### MCP Resources GitNexus Has

| Resource | mcpfantom Equivalent |
|----------|---------------------|
| `gitnexus://repos` | No equivalent resource |
| `gitnexus://repo/{name}/context` | No equivalent (staleness + stats) |
| `gitnexus://repo/{name}/clusters` | **None** (no communities) |
| `gitnexus://repo/{name}/processes` | **None** (no process flows) |
| `gitnexus://repo/{name}/schema` | No equivalent |

**Recommendation:** Add MCP resources for project status, communities, and processes.

---

## Appendix A: court-lens-mcp Patterns to Adopt

### A.1 Pipeline Stage Constants
```typescript
// Shared between backend and frontend
export const CODE_INDEX_STAGES = [...] as const;
export type CodeIndexStage = (typeof CODE_INDEX_STAGES)[number];
```

### A.2 Redis Progress Publishing
```typescript
await redis.hmset(`fantom:index_progress:${projectId}`, {
  stage, detail, progress, stageIndex, totalStages
});
await redis.expire(key, 300);
```

### A.3 LanceDB Hybrid Search with Native RRF
```typescript
const reranker = new rerankers.RRFReranker();
const results = await table
  .search(queryVector)
  .fullTextSearch(ftsQuery)
  .rerank(reranker)
  .limit(limit)
  .toArray();
```

### A.4 Abstract Embedding Provider
```typescript
abstract class EmbeddingProvider {
  abstract embed(texts: string[]): Promise<number[][]>;
  abstract getDimensions(): number;
  abstract getAvailableModels(): string[];
  abstract getModelName(): string;
}
```

### A.5 Checkpoint/Resume
```typescript
interface IndexCheckpoint {
  lastCompletedStage?: string;
  processedFiles?: number;
  totalFiles?: number;
  updatedAt?: string;
}
```