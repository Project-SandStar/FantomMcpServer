# MCP Fantom: Code Intelligence Enhancement Specification

**Version:** 1.0
**Date:** 2026-02-01
**Status:** Planning

---

## Executive Summary

This specification outlines the implementation of 5 major features to bring CodeGraph-level code intelligence to MCP Fantom:

1. **Semantic Knowledge Graph** - SQLite-based graph database for code relationships
2. **Call Graph Analysis** - Track and query function call relationships
3. **Impact Analysis** - Calculate change blast radius
4. **Semantic Vector Search** - Meaning-based code search with local embeddings (NO external service)
5. **Tree-sitter Multi-language Parsing** - Universal AST parsing for 15+ languages
6. **Hybrid Search Architecture** - FlexSearch (hot/instant) + SQLite FTS5 (cold/deep)

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Database Schema Extension](#2-database-schema-extension)
3. [Call Detection Implementation](#3-call-detection-implementation)
4. [Graph Traversal Queries](#4-graph-traversal-queries)
5. [Semantic Vector Search](#5-semantic-vector-search)
6. [Tree-sitter Integration](#6-tree-sitter-integration)
7. [MCP Tool Definitions](#7-mcp-tool-definitions)
8. [Agent Framework Extension](#8-agent-framework-extension)
9. [Search Integration](#9-search-integration)
10. [Hybrid Search Architecture](#10-hybrid-search-architecture)
11. [Local Embeddings (No External Service)](#11-local-embeddings-no-external-service)
12. [Implementation Tasks](#12-implementation-tasks)

---

## 1. Architecture Overview

### Current State

```
┌─────────────────────────────────────────────────────────────┐
│                     MCP Fantom Server                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │ FlexSearch   │    │ Prisma/SQLite│    │ Fantom Parser│  │
│  │ (Text Index) │    │ (Metadata)   │    │ (Regex-based)│  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│                                                              │
│  MISSING: Graph DB, Call Detection, Vectors, Tree-sitter    │
└─────────────────────────────────────────────────────────────┘
```

### Target State

```
┌─────────────────────────────────────────────────────────────────────┐
│                        MCP Fantom Server                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │ FlexSearch   │  │ Prisma/SQLite│  │ Fantom Parser│              │
│  │ (Text Index) │  │ (Metadata)   │  │ (Regex-based)│              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
│         │                 │                  │                       │
│         │    ┌────────────┴──────────────────┤                       │
│         │    │                               │                       │
│         ▼    ▼                               ▼                       │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    NEW: Code Graph Layer                     │   │
│  ├─────────────────────────────────────────────────────────────┤   │
│  │                                                              │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │   │
│  │  │ Graph Store  │  │ Vector Store │  │ Tree-sitter  │       │   │
│  │  │ (Nodes/Edges)│  │ (Embeddings) │  │ (Multi-lang) │       │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘       │   │
│  │         │                 │                  │               │   │
│  │         └─────────────────┼──────────────────┘               │   │
│  │                           ▼                                  │   │
│  │              ┌──────────────────────┐                        │   │
│  │              │ Unified Search API   │                        │   │
│  │              │ Text + Graph + Vector│                        │   │
│  │              └──────────────────────┘                        │   │
│  │                                                              │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                 NEW: Graph Analysis Agent                    │   │
│  │  Tools: getCallers, getCallees, getImpact, findPath, etc.   │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Database Schema Extension

### New Prisma Models

Add to `prisma/schema.prisma`:

```prisma
// ============================================
// Code Graph - Nodes (Code Symbols)
// ============================================

model CodeNode {
  id            String   @id @default(uuid())
  projectId     Int      @map("project_id")

  // Identity
  nodeType      String   @map("node_type")      // "type", "function", "field", "enum"
  name          String                          // Simple name
  qualifiedName String   @map("qualified_name") // Full path

  // Location
  filePath      String   @map("file_path")
  lineStart     Int      @map("line_start")
  lineEnd       Int?     @map("line_end")

  // Metadata
  signature     String?
  documentation String?
  returnType    String?  @map("return_type")
  modifiers     String?                         // JSON: ["public", "static"]

  // Flags
  isPublic      Boolean  @default(true) @map("is_public")
  isStatic      Boolean  @default(false) @map("is_static")
  isAbstract    Boolean  @default(false) @map("is_abstract")

  // Timestamps
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")

  // Relations
  project       FantomProject @relation(fields: [projectId], references: [id], onDelete: Cascade)
  outgoingEdges CodeEdge[]    @relation("EdgeSource")
  incomingEdges CodeEdge[]    @relation("EdgeTarget")
  vector        CodeVector?

  @@unique([projectId, qualifiedName])
  @@index([projectId])
  @@index([nodeType])
  @@index([qualifiedName])
  @@index([filePath])
  @@map("code_nodes")
}

// ============================================
// Code Graph - Edges (Relationships)
// ============================================

model CodeEdge {
  id            String   @id @default(uuid())

  sourceId      String   @map("source_id")
  targetId      String   @map("target_id")
  edgeType      String   @map("edge_type")      // "calls", "extends", "implements", "uses"

  // Call location (for call edges)
  lineNumber    Int?     @map("line_number")

  // Metadata
  isResolved    Boolean  @default(true) @map("is_resolved")
  metadata      String?                         // JSON for extra context

  createdAt     DateTime @default(now()) @map("created_at")

  // Relations
  source        CodeNode @relation("EdgeSource", fields: [sourceId], references: [id], onDelete: Cascade)
  target        CodeNode @relation("EdgeTarget", fields: [targetId], references: [id], onDelete: Cascade)

  @@unique([sourceId, targetId, edgeType, lineNumber])
  @@index([sourceId])
  @@index([targetId])
  @@index([edgeType])
  @@index([sourceId, edgeType])
  @@index([targetId, edgeType])
  @@map("code_edges")
}

// ============================================
// Unresolved References (for later resolution)
// ============================================

model UnresolvedRef {
  id            String   @id @default(uuid())

  fromNodeId    String   @map("from_node_id")
  referenceName String   @map("reference_name")
  refType       String   @map("ref_type")       // "calls", "extends", etc.
  lineNumber    Int      @map("line_number")

  candidates    String?                         // JSON array of possible matches

  createdAt     DateTime @default(now()) @map("created_at")

  @@index([fromNodeId])
  @@index([referenceName])
  @@map("unresolved_refs")
}

// ============================================
// Vector Embeddings for Semantic Search
// ============================================

model CodeVector {
  id            String   @id @default(uuid())
  nodeId        String   @unique @map("node_id")

  embedding     Bytes                           // Float32Array as BLOB
  model         String   @default("all-MiniLM-L6-v2")
  dimensions    Int      @default(384)

  createdAt     DateTime @default(now()) @map("created_at")

  // Relations
  node          CodeNode @relation(fields: [nodeId], references: [id], onDelete: Cascade)

  @@index([model])
  @@map("code_vectors")
}

// ============================================
// Update FantomProject with graph stats
// ============================================

// Add to existing FantomProject model:
// nodeCount      Int?     @map("node_count")
// edgeCount      Int?     @map("edge_count")
// lastGraphBuild DateTime? @map("last_graph_build")
// codeNodes      CodeNode[]
```

### Edge Types

| Edge Type | Description | Example |
|-----------|-------------|---------|
| `calls` | Function A calls function B | `Foo.bar() -> Baz.qux()` |
| `extends` | Class extends parent | `MyClass extends Base` |
| `implements` | Class implements mixin | `MyClass : Mixin1, Mixin2` |
| `contains` | Type contains member | `MyClass contains myMethod` |
| `uses` | Function uses type | `foo() uses Str` |
| `returns` | Function returns type | `parse() returns Str` |
| `parameters` | Function has param type | `foo(Str s)` |
| `overrides` | Method overrides parent | `override Void foo()` |

### Node Types

| Node Type | Description |
|-----------|-------------|
| `type` | Class, mixin, enum, facet |
| `function` | Top-level function |
| `method` | Class method |
| `field` | Class field |
| `constructor` | Constructor method |
| `parameter` | Function parameter |

---

## 3. Call Detection Implementation

### Approach: Extend Existing Fantom Parser

**File:** `src/fantom-code/codeParser.ts`

The current parser already extracts full method bodies in the `sourceCode` field. We need to add call detection.

### New Types

**File:** `src/fantom-code/types.ts`

```typescript
export interface FunctionCall {
  calledName: string;              // Simple name: "foo"
  calledQualifiedName?: string;    // Resolved: "myPod::MyClass.foo"
  calleeNodeId?: string;           // Reference to CodeNode
  lineNumber: number;
  columnNumber?: number;
  isStatic: boolean;
  isDynamic: boolean;              // Uses -> operator
  isConstructor: boolean;
  arguments?: string[];            // Argument types if known
  resolved: boolean;
}

export interface FantomFunction {
  // ... existing fields ...

  // NEW: Call tracking
  calls: FunctionCall[];           // Outgoing calls
  callerCount?: number;            // Cached count of incoming calls
}
```

### Call Extraction Regex Patterns

**File:** `src/fantom-code/callExtractor.ts` (NEW)

```typescript
export class FantomCallExtractor {
  // Pattern: Direct function call - foo()
  private static DIRECT_CALL = /\b([a-zA-Z_]\w*)\s*\(/g;

  // Pattern: Method call - obj.method() or this.method()
  private static METHOD_CALL = /(?:this|super|([a-zA-Z_]\w*))\s*\.\s*([a-zA-Z_]\w*)\s*\(/g;

  // Pattern: Static call - Type.method()
  private static STATIC_CALL = /([A-Z]\w*)\s*\.\s*([a-zA-Z_]\w*)\s*\(/g;

  // Pattern: Qualified call - pod::Type.method()
  private static QUALIFIED_CALL = /([a-zA-Z_]\w*)::([A-Z]\w*)\.([a-zA-Z_]\w*)\s*\(/g;

  // Pattern: Dynamic call - obj->method()
  private static DYNAMIC_CALL = /([a-zA-Z_]\w*)\s*->\s*([a-zA-Z_]\w*)\s*\(/g;

  // Pattern: Constructor - Type() or Type.make()
  private static CONSTRUCTOR_CALL = /([A-Z]\w*)\s*(?:\(\)|\.make\s*\()/g;

  extractCalls(methodBody: string, startLine: number): FunctionCall[] {
    const calls: FunctionCall[] = [];
    const lines = methodBody.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = startLine + i;

      // Skip comments
      if (line.trim().startsWith('//')) continue;

      // Extract different call types
      this.extractDirectCalls(line, lineNumber, calls);
      this.extractMethodCalls(line, lineNumber, calls);
      this.extractStaticCalls(line, lineNumber, calls);
      this.extractQualifiedCalls(line, lineNumber, calls);
      this.extractDynamicCalls(line, lineNumber, calls);
      this.extractConstructorCalls(line, lineNumber, calls);
    }

    return this.deduplicateCalls(calls);
  }

  private extractDirectCalls(line: string, lineNumber: number, calls: FunctionCall[]): void {
    // ... pattern matching implementation
  }

  // ... other extraction methods
}
```

### Integration with Code Parser

**File:** `src/fantom-code/codeParser.ts` - Modify `parseMethod()`

```typescript
private parseMethod(content: string, match: RegExpExecArray): FantomFunction {
  // ... existing parsing ...

  const methodBody = this.extractMethodBody(content, match.index);
  const callExtractor = new FantomCallExtractor();
  const calls = callExtractor.extractCalls(methodBody, lineNumber);

  return {
    // ... existing fields ...
    sourceCode: methodBody,
    calls: calls,  // NEW
  };
}
```

---

## 4. Graph Traversal Queries

### Graph Query Manager

**File:** `src/graph/GraphQueryManager.ts` (NEW)

```typescript
import { PrismaClient } from '@prisma/client';

export class GraphQueryManager {
  constructor(private prisma: PrismaClient) {}

  /**
   * Find all functions that call a given function (incoming calls)
   */
  async getCallers(
    nodeId: string,
    maxDepth: number = 1
  ): Promise<CallerResult[]> {
    if (maxDepth === 1) {
      // Direct callers only - simple query
      return this.prisma.codeEdge.findMany({
        where: {
          targetId: nodeId,
          edgeType: 'calls'
        },
        include: {
          source: true
        }
      });
    }

    // Transitive callers - use recursive CTE
    const result = await this.prisma.$queryRaw`
      WITH RECURSIVE callers(id, name, qualified_name, depth, path) AS (
        -- Base case: direct callers
        SELECT
          n.id,
          n.name,
          n.qualified_name,
          1 AS depth,
          '|' || ${nodeId} || '|' || n.id || '|' AS path
        FROM code_edges e
        JOIN code_nodes n ON e.source_id = n.id
        WHERE e.target_id = ${nodeId}
          AND e.edge_type = 'calls'

        UNION ALL

        -- Recursive case
        SELECT
          n.id,
          n.name,
          n.qualified_name,
          c.depth + 1,
          c.path || n.id || '|' AS path
        FROM code_edges e
        JOIN code_nodes n ON e.source_id = n.id
        JOIN callers c ON e.target_id = c.id
        WHERE e.edge_type = 'calls'
          AND c.depth < ${maxDepth}
          AND c.path NOT LIKE '%|' || n.id || '|%'  -- Cycle prevention
      )
      SELECT DISTINCT id, name, qualified_name, MIN(depth) as depth
      FROM callers
      GROUP BY id
      ORDER BY depth, name
    `;

    return result;
  }

  /**
   * Find all functions called by a given function (outgoing calls)
   */
  async getCallees(
    nodeId: string,
    maxDepth: number = 1
  ): Promise<CalleeResult[]> {
    if (maxDepth === 1) {
      return this.prisma.codeEdge.findMany({
        where: {
          sourceId: nodeId,
          edgeType: 'calls'
        },
        include: {
          target: true
        }
      });
    }

    // Transitive callees - use recursive CTE
    const result = await this.prisma.$queryRaw`
      WITH RECURSIVE callees(id, name, qualified_name, depth, path) AS (
        SELECT
          n.id,
          n.name,
          n.qualified_name,
          1 AS depth,
          '|' || ${nodeId} || '|' || n.id || '|' AS path
        FROM code_edges e
        JOIN code_nodes n ON e.target_id = n.id
        WHERE e.source_id = ${nodeId}
          AND e.edge_type = 'calls'

        UNION ALL

        SELECT
          n.id,
          n.name,
          n.qualified_name,
          c.depth + 1,
          c.path || n.id || '|' AS path
        FROM code_edges e
        JOIN code_nodes n ON e.target_id = n.id
        JOIN callees c ON e.source_id = c.id
        WHERE e.edge_type = 'calls'
          AND c.depth < ${maxDepth}
          AND c.path NOT LIKE '%|' || n.id || '|%'
      )
      SELECT DISTINCT id, name, qualified_name, MIN(depth) as depth
      FROM callees
      GROUP BY id
      ORDER BY depth, name
    `;

    return result;
  }

  /**
   * Calculate impact radius - all code affected by changes to a node
   */
  async getImpactRadius(
    nodeId: string,
    maxDepth: number = 3
  ): Promise<ImpactResult> {
    // Get all incoming edges (everything that depends on this node)
    const result = await this.prisma.$queryRaw`
      WITH RECURSIVE impact(id, name, qualified_name, edge_type, depth, path) AS (
        -- Base case: direct dependents
        SELECT
          n.id,
          n.name,
          n.qualified_name,
          e.edge_type,
          1 AS depth,
          '|' || ${nodeId} || '|' || n.id || '|' AS path
        FROM code_edges e
        JOIN code_nodes n ON e.source_id = n.id
        WHERE e.target_id = ${nodeId}

        UNION ALL

        -- Recursive case: transitive dependents
        SELECT
          n.id,
          n.name,
          n.qualified_name,
          e.edge_type,
          i.depth + 1,
          i.path || n.id || '|' AS path
        FROM code_edges e
        JOIN code_nodes n ON e.source_id = n.id
        JOIN impact i ON e.target_id = i.id
        WHERE i.depth < ${maxDepth}
          AND i.path NOT LIKE '%|' || n.id || '|%'
      )
      SELECT
        id,
        name,
        qualified_name,
        edge_type,
        MIN(depth) as min_depth,
        GROUP_CONCAT(DISTINCT edge_type) as edge_types
      FROM impact
      GROUP BY id
      ORDER BY min_depth, name
    `;

    return {
      focalNode: nodeId,
      affectedNodes: result,
      totalAffected: result.length,
      maxDepthReached: maxDepth
    };
  }

  /**
   * Find path between two nodes
   */
  async findPath(
    fromId: string,
    toId: string,
    edgeTypes?: string[]
  ): Promise<PathResult | null> {
    const edgeFilter = edgeTypes?.length
      ? `AND e.edge_type IN (${edgeTypes.map(t => `'${t}'`).join(',')})`
      : '';

    const result = await this.prisma.$queryRaw`
      WITH RECURSIVE paths(current_id, depth, path, edge_path) AS (
        SELECT
          ${fromId} AS current_id,
          0 AS depth,
          '|' || ${fromId} || '|' AS path,
          '' AS edge_path

        UNION ALL

        SELECT
          e.target_id,
          p.depth + 1,
          p.path || e.target_id || '|',
          p.edge_path || e.edge_type || '|'
        FROM code_edges e
        JOIN paths p ON e.source_id = p.current_id
        WHERE p.depth < 10
          AND p.path NOT LIKE '%|' || e.target_id || '|%'
          ${edgeFilter}
      )
      SELECT path, edge_path, depth
      FROM paths
      WHERE current_id = ${toId}
      ORDER BY depth
      LIMIT 1
    `;

    return result[0] || null;
  }

  /**
   * Detect circular dependencies
   */
  async detectCycles(projectId: number): Promise<CycleResult[]> {
    const result = await this.prisma.$queryRaw`
      WITH RECURSIVE cycle_finder(node_id, start_id, path, depth) AS (
        -- Start from each node
        SELECT
          id AS node_id,
          id AS start_id,
          '|' || id || '|' AS path,
          0 AS depth
        FROM code_nodes
        WHERE project_id = ${projectId}

        UNION ALL

        SELECT
          e.target_id,
          c.start_id,
          c.path || e.target_id || '|',
          c.depth + 1
        FROM code_edges e
        JOIN cycle_finder c ON e.source_id = c.node_id
        WHERE c.depth < 20
          AND (
            e.target_id = c.start_id  -- Found cycle back to start
            OR c.path NOT LIKE '%|' || e.target_id || '|%'
          )
      )
      SELECT DISTINCT path
      FROM cycle_finder
      WHERE node_id = start_id AND depth > 0
      ORDER BY depth
      LIMIT 100
    `;

    return result;
  }
}

// Result types
interface CallerResult {
  id: string;
  name: string;
  qualifiedName: string;
  depth: number;
  filePath?: string;
  lineNumber?: number;
}

interface CalleeResult {
  id: string;
  name: string;
  qualifiedName: string;
  depth: number;
}

interface ImpactResult {
  focalNode: string;
  affectedNodes: Array<{
    id: string;
    name: string;
    qualifiedName: string;
    edgeTypes: string[];
    minDepth: number;
  }>;
  totalAffected: number;
  maxDepthReached: number;
}

interface PathResult {
  path: string[];
  edgeTypes: string[];
  depth: number;
}

interface CycleResult {
  path: string[];
  length: number;
}
```

---

## 5. Semantic Vector Search

### Dependencies

```bash
npm install @huggingface/transformers sqlite-vec better-sqlite3
```

### Embedding Service

**File:** `src/vectors/EmbeddingService.ts` (NEW)

```typescript
import { pipeline, Pipeline } from '@huggingface/transformers';

export class EmbeddingService {
  private static instance: EmbeddingService;
  private extractor: Pipeline | null = null;
  private loading: Promise<Pipeline> | null = null;

  readonly MODEL = 'Xenova/all-MiniLM-L6-v2';
  readonly DIMENSIONS = 384;

  static getInstance(): EmbeddingService {
    if (!EmbeddingService.instance) {
      EmbeddingService.instance = new EmbeddingService();
    }
    return EmbeddingService.instance;
  }

  async initialize(): Promise<void> {
    if (this.extractor) return;
    if (this.loading) {
      await this.loading;
      return;
    }

    this.loading = pipeline('feature-extraction', this.MODEL, {
      quantized: true
    });

    this.extractor = await this.loading;
    this.loading = null;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.extractor) {
      await this.initialize();
    }

    const response = await this.extractor!(texts, {
      pooling: 'mean',
      normalize: true
    });

    return response.tolist().map((arr: number[]) => new Float32Array(arr));
  }

  async embedSingle(text: string): Promise<Float32Array> {
    const results = await this.embed([text]);
    return results[0];
  }

  /**
   * Prepare code node for embedding
   */
  prepareNodeText(node: {
    name: string;
    nodeType: string;
    qualifiedName: string;
    signature?: string;
    documentation?: string;
  }): string {
    const parts: string[] = [];

    parts.push(`${node.nodeType}: ${node.name}`);

    if (node.qualifiedName !== node.name) {
      parts.push(`path: ${node.qualifiedName}`);
    }

    if (node.signature) {
      parts.push(`signature: ${node.signature}`);
    }

    if (node.documentation) {
      parts.push(`documentation: ${node.documentation}`);
    }

    // Truncate to stay under token limit
    return parts.join('\n').slice(0, 500);
  }
}
```

### Vector Store

**File:** `src/vectors/VectorStore.ts` (NEW)

```typescript
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export class VectorStore {
  private db: Database.Database;
  private useVSS: boolean = false;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initializeSchema();
  }

  private initializeSchema(): void {
    // Try to load sqlite-vec extension
    try {
      sqliteVec.load(this.db);
      this.useVSS = true;

      // Create VSS virtual table
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_nodes USING vec0(
          embedding float[384]
        );

        CREATE TABLE IF NOT EXISTS vec_map (
          rowid INTEGER PRIMARY KEY,
          node_id TEXT NOT NULL UNIQUE
        );
      `);
    } catch (err) {
      console.warn('sqlite-vec not available, using fallback cosine similarity');
      this.useVSS = false;
    }
  }

  async insert(nodeId: string, embedding: Float32Array): Promise<void> {
    if (this.useVSS) {
      const insertMap = this.db.prepare(`
        INSERT OR REPLACE INTO vec_map (node_id) VALUES (?)
      `);
      const info = insertMap.run(nodeId);

      const insertVec = this.db.prepare(`
        INSERT OR REPLACE INTO vec_nodes (rowid, embedding) VALUES (?, ?)
      `);
      insertVec.run(info.lastInsertRowid, embedding.buffer);
    }

    // Also store in Prisma table for persistence
  }

  async search(
    queryEmbedding: Float32Array,
    limit: number = 10,
    minScore: number = 0.3
  ): Promise<VectorSearchResult[]> {
    if (this.useVSS) {
      const results = this.db.prepare(`
        SELECT
          vec_map.node_id,
          vec_nodes.distance
        FROM vec_nodes
        JOIN vec_map ON vec_map.rowid = vec_nodes.rowid
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT ?
      `).all(queryEmbedding.buffer, limit * 2);  // Over-fetch for filtering

      return results
        .map(row => ({
          nodeId: row.node_id,
          distance: row.distance,
          score: 1 / (1 + row.distance)  // Convert distance to similarity
        }))
        .filter(r => r.score >= minScore)
        .slice(0, limit);
    }

    // Fallback: brute-force cosine similarity
    return this.bruteForceSearch(queryEmbedding, limit, minScore);
  }

  private bruteForceSearch(
    query: Float32Array,
    limit: number,
    minScore: number
  ): VectorSearchResult[] {
    // Implementation with manual cosine similarity
    // ... (see earlier research)
  }

  close(): void {
    this.db.close();
  }
}

interface VectorSearchResult {
  nodeId: string;
  score: number;
  distance?: number;
}
```

### Semantic Search Integration

**File:** `src/search/semanticSearch.ts` (NEW)

```typescript
import { EmbeddingService } from '../vectors/EmbeddingService';
import { VectorStore } from '../vectors/VectorStore';
import { GraphQueryManager } from '../graph/GraphQueryManager';

export class SemanticSearchService {
  private embedder: EmbeddingService;
  private vectorStore: VectorStore;
  private graphQuery: GraphQueryManager;

  async search(
    query: string,
    options: SemanticSearchOptions = {}
  ): Promise<SemanticSearchResult[]> {
    const {
      limit = 10,
      minScore = 0.3,
      includeGraph = true,
      nodeTypes
    } = options;

    // 1. Embed the query
    const queryEmbedding = await this.embedder.embedSingle(query);

    // 2. Vector similarity search
    const vectorResults = await this.vectorStore.search(
      queryEmbedding,
      limit,
      minScore
    );

    // 3. Enrich with graph context if requested
    if (includeGraph) {
      for (const result of vectorResults) {
        const callers = await this.graphQuery.getCallers(result.nodeId, 1);
        const callees = await this.graphQuery.getCallees(result.nodeId, 1);
        result.callerCount = callers.length;
        result.calleeCount = callees.length;
      }
    }

    return vectorResults;
  }

  async indexNode(node: CodeNode): Promise<void> {
    const text = this.embedder.prepareNodeText(node);
    const embedding = await this.embedder.embedSingle(text);
    await this.vectorStore.insert(node.id, embedding);
  }

  async reindexAll(nodes: CodeNode[]): Promise<void> {
    const BATCH_SIZE = 32;

    for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
      const batch = nodes.slice(i, i + BATCH_SIZE);
      const texts = batch.map(n => this.embedder.prepareNodeText(n));
      const embeddings = await this.embedder.embed(texts);

      for (let j = 0; j < batch.length; j++) {
        await this.vectorStore.insert(batch[j].id, embeddings[j]);
      }
    }
  }
}

interface SemanticSearchOptions {
  limit?: number;
  minScore?: number;
  includeGraph?: boolean;
  nodeTypes?: string[];
}

interface SemanticSearchResult {
  nodeId: string;
  score: number;
  node?: CodeNode;
  callerCount?: number;
  calleeCount?: number;
}
```

---

## 6. Tree-sitter Integration

### Dependencies

```bash
npm install tree-sitter tree-sitter-javascript tree-sitter-typescript tree-sitter-python tree-sitter-go tree-sitter-rust tree-sitter-java
```

### Tree-sitter Manager

**File:** `src/parser/TreeSitterManager.ts` (NEW)

```typescript
import Parser, { Query, SyntaxNode, Tree } from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import { typescript, tsx } from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import Go from 'tree-sitter-go';
import Rust from 'tree-sitter-rust';
import Java from 'tree-sitter-java';

interface LanguageConfig {
  grammar: any;
  extensions: string[];
  callQuery: string;
  functionQuery: string;
}

export class TreeSitterManager {
  private parser: Parser;
  private languages: Map<string, LanguageConfig> = new Map();
  private queryCache: Map<string, Query> = new Map();

  constructor() {
    this.parser = new Parser();
    this.registerLanguages();
  }

  private registerLanguages(): void {
    // JavaScript
    this.languages.set('javascript', {
      grammar: JavaScript,
      extensions: ['.js', '.mjs', '.cjs'],
      callQuery: `
        (call_expression
          function: (identifier) @call.direct)
        (call_expression
          function: (member_expression
            property: (property_identifier) @call.method))
      `,
      functionQuery: `
        (function_declaration name: (identifier) @function.name) @function
        (arrow_function) @arrow
      `
    });

    // TypeScript
    this.languages.set('typescript', {
      grammar: typescript,
      extensions: ['.ts'],
      callQuery: `
        (call_expression
          function: (identifier) @call.direct)
        (call_expression
          function: (member_expression
            property: (property_identifier) @call.method))
      `,
      functionQuery: `
        (function_declaration name: (identifier) @function.name) @function
        (method_definition name: (property_identifier) @method.name) @method
      `
    });

    // Python
    this.languages.set('python', {
      grammar: Python,
      extensions: ['.py'],
      callQuery: `
        (call function: (identifier) @call.direct)
        (call function: (attribute attribute: (identifier) @call.method))
      `,
      functionQuery: `
        (function_definition name: (identifier) @function.name) @function
        (class_definition name: (identifier) @class.name) @class
      `
    });

    // Go
    this.languages.set('go', {
      grammar: Go,
      extensions: ['.go'],
      callQuery: `
        (call_expression function: (identifier) @call.direct)
        (call_expression function: (selector_expression field: (field_identifier) @call.method))
      `,
      functionQuery: `
        (function_declaration name: (identifier) @function.name) @function
        (method_declaration name: (field_identifier) @method.name) @method
      `
    });

    // More languages...
  }

  parse(code: string, language: string): Tree | null {
    const config = this.languages.get(language);
    if (!config) return null;

    this.parser.setLanguage(config.grammar);
    return this.parser.parse(code);
  }

  extractCalls(code: string, language: string): ExtractedCall[] {
    const tree = this.parse(code, language);
    if (!tree) return [];

    const config = this.languages.get(language)!;
    const query = this.getOrCreateQuery(language, 'call', config.callQuery);

    const calls: ExtractedCall[] = [];
    for (const match of query.matches(tree.rootNode)) {
      for (const capture of match.captures) {
        calls.push({
          name: capture.node.text,
          type: capture.name.includes('method') ? 'method' : 'function',
          line: capture.node.startPosition.row + 1,
          column: capture.node.startPosition.column
        });
      }
    }

    tree.delete();
    return calls;
  }

  getLanguageForExtension(ext: string): string | undefined {
    for (const [lang, config] of this.languages) {
      if (config.extensions.includes(ext)) {
        return lang;
      }
    }
    return undefined;
  }

  private getOrCreateQuery(language: string, type: string, queryString: string): Query {
    const key = `${language}:${type}`;
    if (!this.queryCache.has(key)) {
      const config = this.languages.get(language)!;
      this.queryCache.set(key, new Query(config.grammar, queryString));
    }
    return this.queryCache.get(key)!;
  }
}

interface ExtractedCall {
  name: string;
  type: 'function' | 'method';
  line: number;
  column: number;
}
```

### Integration with Existing Parser

**File:** `src/parser/CodeAnalyzer.ts` (NEW)

```typescript
import { TreeSitterManager } from './TreeSitterManager';
import { FantomCodeParser } from '../fantom-code/codeParser';
import path from 'path';

export class CodeAnalyzer {
  private treeSitter: TreeSitterManager;
  private fantomParser: FantomCodeParser;

  constructor() {
    this.treeSitter = new TreeSitterManager();
    this.fantomParser = new FantomCodeParser();
  }

  async analyzeFile(filePath: string, content: string): Promise<AnalysisResult> {
    const ext = path.extname(filePath);

    // Use Fantom parser for .fan files
    if (ext === '.fan') {
      return this.fantomParser.parse(content, filePath);
    }

    // Use tree-sitter for other languages
    const language = this.treeSitter.getLanguageForExtension(ext);
    if (language) {
      return {
        functions: this.treeSitter.extractFunctions(content, language),
        calls: this.treeSitter.extractCalls(content, language),
        language
      };
    }

    return { functions: [], calls: [], language: 'unknown' };
  }
}
```

---

## 7. MCP Tool Definitions

### New Tools to Add

**File:** `src/index.ts` - Add to `handleListTools()`

```typescript
// Graph Analysis Tools
{
  name: 'getFantomCallers',
  description: 'Find all functions that call a given function (incoming call graph)',
  inputSchema: {
    type: 'object',
    properties: {
      qualifiedName: {
        type: 'string',
        description: 'Qualified name (e.g., "myPod::MyClass.myMethod")'
      },
      maxDepth: {
        type: 'number',
        description: 'Maximum traversal depth (default: 1, max: 10)',
        default: 1
      },
      includeTests: {
        type: 'boolean',
        description: 'Include test functions in results',
        default: false
      }
    },
    required: ['qualifiedName']
  }
},
{
  name: 'getFantomCallees',
  description: 'Find all functions called by a given function (outgoing call graph)',
  inputSchema: {
    type: 'object',
    properties: {
      qualifiedName: {
        type: 'string',
        description: 'Qualified name of the function to analyze'
      },
      maxDepth: {
        type: 'number',
        description: 'Maximum traversal depth (default: 1, max: 10)',
        default: 1
      }
    },
    required: ['qualifiedName']
  }
},
{
  name: 'getFantomImpact',
  description: 'Calculate the impact radius of changing a function (all affected code)',
  inputSchema: {
    type: 'object',
    properties: {
      qualifiedName: {
        type: 'string',
        description: 'Qualified name of the function to analyze'
      },
      maxDepth: {
        type: 'number',
        description: 'Maximum depth to traverse (default: 3)',
        default: 3
      },
      includeIndirect: {
        type: 'boolean',
        description: 'Include indirect dependencies (type usage, etc.)',
        default: true
      }
    },
    required: ['qualifiedName']
  }
},
{
  name: 'findFantomPath',
  description: 'Find dependency path between two functions/types',
  inputSchema: {
    type: 'object',
    properties: {
      from: {
        type: 'string',
        description: 'Source qualified name'
      },
      to: {
        type: 'string',
        description: 'Target qualified name'
      },
      edgeTypes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter by edge types (calls, extends, uses)',
        default: []
      }
    },
    required: ['from', 'to']
  }
},
{
  name: 'detectFantomCycles',
  description: 'Detect circular dependencies in a project',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'number',
        description: 'Project ID to analyze'
      },
      maxCycleLength: {
        type: 'number',
        description: 'Maximum cycle length to detect',
        default: 10
      }
    },
    required: ['projectId']
  }
},
{
  name: 'searchFantomSemantic',
  description: 'Semantic search for code by meaning (not just text matching)',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural language query (e.g., "authentication logic")'
      },
      limit: {
        type: 'number',
        description: 'Maximum results',
        default: 10
      },
      minScore: {
        type: 'number',
        description: 'Minimum similarity score (0-1)',
        default: 0.3
      },
      includeGraph: {
        type: 'boolean',
        description: 'Include caller/callee counts in results',
        default: true
      }
    },
    required: ['query']
  }
}
```

---

## 8. Agent Framework Extension

### New Graph Analysis Agent

**File:** `src/agents/graphAnalysis/GraphAnalysisAgent.ts` (NEW)

```typescript
import { BaseAgent } from '../base/BaseAgent';
import { GraphQueryManager } from '../../graph/GraphQueryManager';
import { SemanticSearchService } from '../../search/semanticSearch';

export class GraphAnalysisAgent extends BaseAgent {
  readonly name = 'graph-analysis';
  readonly description = 'Code dependency graph analysis and semantic search';
  readonly category = 'analysis';

  private graphQuery: GraphQueryManager;
  private semanticSearch: SemanticSearchService;

  getTools(): ToolDefinition[] {
    return [
      this.createToolDefinition(
        'graph_getCallers',
        'Find all functions that call a given function',
        { /* schema */ },
        ['callers', 'call-graph', 'incoming', 'who-calls'],
        ['Find what uses this function', 'Trace call sources']
      ),
      this.createToolDefinition(
        'graph_getCallees',
        'Find all functions called by a given function',
        { /* schema */ },
        ['callees', 'call-graph', 'outgoing', 'calls-what'],
        ['Find function dependencies', 'Trace call targets']
      ),
      this.createToolDefinition(
        'graph_getImpact',
        'Calculate impact radius of changes',
        { /* schema */ },
        ['impact', 'change-analysis', 'blast-radius', 'affected'],
        ['Assess change risk', 'Find affected code']
      ),
      this.createToolDefinition(
        'graph_findPath',
        'Find dependency path between two symbols',
        { /* schema */ },
        ['path', 'dependency', 'route', 'connection'],
        ['How are these connected', 'Trace dependency chain']
      ),
      this.createToolDefinition(
        'graph_detectCycles',
        'Detect circular dependencies',
        { /* schema */ },
        ['cycle', 'circular', 'dependency-loop'],
        ['Find architectural issues', 'Detect bad dependencies']
      ),
      this.createToolDefinition(
        'graph_semanticSearch',
        'Search code by meaning using embeddings',
        { /* schema */ },
        ['semantic', 'meaning', 'natural-language', 'ai-search'],
        ['Find code by description', 'Natural language code search']
      ),
      this.createToolDefinition(
        'graph_getMetrics',
        'Get centrality and complexity metrics',
        { /* schema */ },
        ['metrics', 'centrality', 'complexity', 'importance'],
        ['Find critical code', 'Identify hotspots']
      ),
      this.createToolDefinition(
        'graph_buildIndex',
        'Build or rebuild the code graph index',
        { /* schema */ },
        ['index', 'build', 'refresh', 'reindex'],
        ['Update graph after changes', 'Initialize graph']
      )
    ];
  }

  async executeTool(toolName: string, params: Record<string, any>): Promise<ToolResult> {
    const startTime = Date.now();

    switch (toolName) {
      case 'graph_getCallers':
        return this.doGetCallers(params, startTime);
      case 'graph_getCallees':
        return this.doGetCallees(params, startTime);
      case 'graph_getImpact':
        return this.doGetImpact(params, startTime);
      case 'graph_findPath':
        return this.doFindPath(params, startTime);
      case 'graph_detectCycles':
        return this.doDetectCycles(params, startTime);
      case 'graph_semanticSearch':
        return this.doSemanticSearch(params, startTime);
      case 'graph_getMetrics':
        return this.doGetMetrics(params, startTime);
      case 'graph_buildIndex':
        return this.doBuildIndex(params, startTime);
      default:
        return this.createToolResult(false, null, `Unknown tool: ${toolName}`, startTime);
    }
  }

  private async doGetCallers(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const { qualifiedName, maxDepth = 1 } = params;

    const node = await this.findNodeByQualifiedName(qualifiedName);
    if (!node) {
      return this.createToolResult(false, null, `Node not found: ${qualifiedName}`, startTime);
    }

    const callers = await this.graphQuery.getCallers(node.id, maxDepth);

    return this.createToolResult(true, {
      targetFunction: {
        name: node.name,
        qualifiedName: node.qualifiedName,
        filePath: node.filePath
      },
      callers: callers.map(c => ({
        name: c.name,
        qualifiedName: c.qualifiedName,
        depth: c.depth,
        filePath: c.filePath,
        line: c.lineNumber
      })),
      callerCount: callers.length,
      maxDepth
    }, undefined, startTime);
  }

  // ... other tool implementations
}
```

### Register in Agent Framework

**File:** `src/agents/index.ts` - Modify `createAgentFramework()`

```typescript
import { GraphAnalysisAgent } from './graphAnalysis/GraphAnalysisAgent';

export function createAgentFramework(options: AgentFrameworkOptions): AgentFramework {
  const eventBus = new AgentEventBus();

  // ... existing agents ...

  // NEW: Graph Analysis Agent
  const graphAnalysis = new GraphAnalysisAgent({
    eventBus,
    graphQuery: options.graphQuery,
    semanticSearch: options.semanticSearch
  });

  orchestration.registerAgent(graphAnalysis);

  return {
    // ... existing ...
    graphAnalysis
  };
}
```

---

## 9. Search Integration

### Unified Search with Graph and Vector

**File:** `src/search/unifiedSearch.ts` (NEW)

```typescript
import { SearchIndex } from './index';
import { GraphQueryManager } from '../graph/GraphQueryManager';
import { SemanticSearchService } from './semanticSearch';

export class UnifiedSearchService {
  constructor(
    private textSearch: SearchIndex,
    private graphQuery: GraphQueryManager,
    private semanticSearch: SemanticSearchService
  ) {}

  async search(query: string, options: UnifiedSearchOptions = {}): Promise<UnifiedSearchResult[]> {
    const {
      mode = 'hybrid',  // 'text', 'semantic', 'graph', 'hybrid'
      limit = 10,
      includeGraph = true
    } = options;

    const results: UnifiedSearchResult[] = [];

    // 1. Text search (fast)
    if (mode === 'text' || mode === 'hybrid') {
      const textResults = await this.textSearch.search(query, limit);
      for (const r of textResults) {
        results.push({
          ...r,
          source: 'text',
          textScore: r.score
        });
      }
    }

    // 2. Semantic search (meaning-based)
    if (mode === 'semantic' || mode === 'hybrid') {
      const semanticResults = await this.semanticSearch.search(query, { limit });
      for (const r of semanticResults) {
        const existing = results.find(x => x.nodeId === r.nodeId);
        if (existing) {
          existing.semanticScore = r.score;
          existing.combinedScore = (existing.textScore || 0) * 0.6 + r.score * 0.4;
        } else {
          results.push({
            nodeId: r.nodeId,
            source: 'semantic',
            semanticScore: r.score,
            combinedScore: r.score * 0.4
          });
        }
      }
    }

    // 3. Enrich with graph context
    if (includeGraph) {
      for (const result of results) {
        const [callers, callees] = await Promise.all([
          this.graphQuery.getCallers(result.nodeId, 1),
          this.graphQuery.getCallees(result.nodeId, 1)
        ]);
        result.callerCount = callers.length;
        result.calleeCount = callees.length;
        result.graphCentrality = callers.length + callees.length;
      }

      // Boost results with high graph centrality
      for (const result of results) {
        if (result.graphCentrality > 5) {
          result.combinedScore = (result.combinedScore || 0) + 0.1;
        }
      }
    }

    // Sort by combined score
    results.sort((a, b) => (b.combinedScore || 0) - (a.combinedScore || 0));

    return results.slice(0, limit);
  }
}

interface UnifiedSearchOptions {
  mode?: 'text' | 'semantic' | 'graph' | 'hybrid';
  limit?: number;
  includeGraph?: boolean;
  nodeTypes?: string[];
}

interface UnifiedSearchResult {
  nodeId: string;
  source: 'text' | 'semantic' | 'graph';
  textScore?: number;
  semanticScore?: number;
  combinedScore?: number;
  callerCount?: number;
  calleeCount?: number;
  graphCentrality?: number;
  node?: any;
}
```

### Extend Existing searchVersionedApi Tool

**File:** `src/search/versionedApiSearch.ts` - Add graph mode

```typescript
export interface SearchVersionedApiInput {
  // ... existing fields ...

  // NEW: Graph search options
  searchMode?: 'text' | 'semantic' | 'hybrid';
  includeGraphContext?: boolean;
  graphQuery?: {
    startNode?: string;
    traversalType?: 'callers' | 'callees' | 'impact';
    maxDepth?: number;
  };
}
```

---

## 10. Hybrid Search Architecture (FlexSearch + FTS5)

### The Problem with Single-Layer Search

Currently MCP Fantom uses FlexSearch (in-memory) which is:
- Fast for autocomplete and fuzzy matching
- Limited by available RAM
- Loses index on restart (must reload from cache)

### The Solution: Two-Tier Hybrid Architecture

Combine **FlexSearch** (hot/instant) with **SQLite FTS5** (cold/deep) for best of both worlds.

```
┌─────────────────────────────────────────────────────────────────┐
│                        User Query                                │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    FlexSearch (Hot Layer)                        │
│  • In-memory, instant response (<1ms)                           │
│  • Fuzzy matching, typo tolerance                                │
│  • Holds: names, signatures, qualified names (lightweight)       │
│  • Use for: autocomplete, search-as-you-type                    │
└─────────────────────────────────────────────────────────────────┘
                               │
                    (If user needs deep search)
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    SQLite FTS5 (Cold Layer)                      │
│  • Disk-based, persistent                                        │
│  • Boolean queries (AND/OR/NOT), exact matching                 │
│  • Holds: full documentation, source code, descriptions         │
│  • Use for: full-text search, complex queries, snippets          │
└─────────────────────────────────────────────────────────────────┘
```

### Role Assignment

| Layer | Location | Data | Best For |
|-------|----------|------|----------|
| **FlexSearch** | Memory | Lightweight: id, name, qualifiedName, signature | Instant autocomplete, fuzzy matching |
| **FTS5** | SQLite disk | Full content: docs, source, descriptions | Deep search, boolean queries, snippets |

### Implementation Strategy

#### Step 1: Add FTS5 Tables to SQLite

```sql
-- Full-text search for code nodes
CREATE VIRTUAL TABLE code_nodes_fts USING fts5(
  name,
  qualified_name,
  signature,
  documentation,
  content='code_nodes',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 1'
);

-- Triggers to keep FTS5 in sync
CREATE TRIGGER code_nodes_ai AFTER INSERT ON code_nodes BEGIN
  INSERT INTO code_nodes_fts(rowid, name, qualified_name, signature, documentation)
  VALUES (new.rowid, new.name, new.qualified_name, new.signature, new.documentation);
END;

CREATE TRIGGER code_nodes_ad AFTER DELETE ON code_nodes BEGIN
  INSERT INTO code_nodes_fts(code_nodes_fts, rowid, name, qualified_name, signature, documentation)
  VALUES ('delete', old.rowid, old.name, old.qualified_name, old.signature, old.documentation);
END;

CREATE TRIGGER code_nodes_au AFTER UPDATE ON code_nodes BEGIN
  INSERT INTO code_nodes_fts(code_nodes_fts, rowid, name, qualified_name, signature, documentation)
  VALUES ('delete', old.rowid, old.name, old.qualified_name, old.signature, old.documentation);
  INSERT INTO code_nodes_fts(rowid, name, qualified_name, signature, documentation)
  VALUES (new.rowid, new.name, new.qualified_name, new.signature, new.documentation);
END;
```

#### Step 2: Hydrate FlexSearch from FTS5

```typescript
// On startup: Load lightweight data into FlexSearch
async function hydrateFlexSearch(): Promise<void> {
  const nodes = await prisma.$queryRaw`
    SELECT id, name, qualified_name, signature
    FROM code_nodes
    LIMIT 50000
  `;

  for (const node of nodes) {
    flexSearchIndex.add(node);
  }
}
```

#### Step 3: Query Routing

```typescript
async function search(query: string, options: SearchOptions) {
  if (options.mode === 'autocomplete' || query.length < 3) {
    // Use FlexSearch for instant results
    return flexSearchIndex.search(query, { limit: 10 });
  }

  if (options.mode === 'deep' || options.boolean) {
    // Use FTS5 for full search
    const results = await prisma.$queryRaw`
      SELECT *, bm25(code_nodes_fts) as rank
      FROM code_nodes_fts
      WHERE code_nodes_fts MATCH ${query}
      ORDER BY rank
      LIMIT ${options.limit || 20}
    `;
    return results;
  }

  // Hybrid: FlexSearch first, then FTS5 for refinement
  const quick = flexSearchIndex.search(query, { limit: 5 });
  const deep = await fts5Search(query, { limit: 15 });
  return deduplicateAndMerge(quick, deep);
}
```

### Benefits of Hybrid Approach

| Feature | FlexSearch Only | FTS5 Only | **Hybrid** |
|---------|-----------------|-----------|------------|
| Speed | Instant | Fast (disk I/O) | **Instant for autocomplete** |
| Typos | Excellent | Poor | **Excellent** |
| Scale | Limited (RAM) | Unlimited | **Unlimited** |
| Persistence | None (cache) | Built-in | **Both** |
| Boolean queries | Limited | Excellent | **Excellent** |
| Snippets/Highlights | No | Yes | **Yes** |

---

## 11. Local Embeddings (No External Service Required)

### Clarification: @huggingface/transformers is 100% LOCAL

The semantic search feature uses `@huggingface/transformers` which runs **entirely on your machine**:

```
┌─────────────────────────────────────────────────────────────────┐
│                    How Local Embeddings Work                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  First Run:                                                     │
│  ┌────────────────┐     ┌─────────────────┐                    │
│  │ HuggingFace    │ ──► │ ~/.cache/       │  Download once     │
│  │ Hub (Internet) │     │ huggingface/    │  (~20-80MB)        │
│  └────────────────┘     └─────────────────┘                    │
│                                                                  │
│  Subsequent Runs (NO INTERNET NEEDED):                          │
│  ┌────────────────┐     ┌─────────────────┐     ┌────────────┐ │
│  │ Your Code      │ ──► │ Local ONNX      │ ──► │ Embeddings │ │
│  │ "auth login"   │     │ Runtime         │     │ [0.1, ...] │ │
│  └────────────────┘     └─────────────────┘     └────────────┘ │
│                                                                  │
│  Privacy: Your code NEVER leaves your machine                   │
│  Performance: ~5-14k embeddings/sec on CPU                      │
│  Storage: Models cached in ~/.cache/huggingface/                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Key Points

| Question | Answer |
|----------|--------|
| Does it require an API key? | **No** |
| Does it send code to a server? | **No** - 100% local |
| Does it need internet after first run? | **No** - model is cached |
| What model is used? | `Xenova/all-MiniLM-L6-v2` (384 dimensions) |
| Is it fast? | **Yes** - ~5,000+ embeddings/second on CPU |
| Memory usage? | ~100-200MB for the model |

### How It Compares to External Services

| Aspect | OpenAI Embeddings | **Local Embeddings** |
|--------|-------------------|----------------------|
| Privacy | Code sent to OpenAI | Code stays local |
| Cost | $0.0001/1K tokens | Free |
| Latency | Network roundtrip | <1ms |
| Offline | No | Yes |
| Rate limits | Yes | No |
| Quality | Excellent | Very Good |

### Implementation

```typescript
import { pipeline } from '@huggingface/transformers';

// One-time initialization (downloads model if not cached)
const extractor = await pipeline(
  'feature-extraction',
  'Xenova/all-MiniLM-L6-v2',
  { quantized: true }  // Smaller model, faster loading
);

// Generate embeddings (runs locally, no network)
const embedding = await extractor('function parseConfig()', {
  pooling: 'mean',
  normalize: true
});
// Returns: Float32Array(384) [0.0234, -0.0891, ...]
```

---

## 12. Implementation Tasks

See accompanying task list for detailed, interconnected implementation tasks.

### Task Dependencies Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        PHASE 1: Foundation                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  [T1] Prisma Schema ──────────────────────────────────────────────┐ │
│       Extension                                                    │ │
│           │                                                        │ │
│           ▼                                                        │ │
│  [T2] Call Extraction ───► [T3] Graph Builder ───► [T4] Index     │ │
│       (Fantom Parser)           (Nodes/Edges)        Integration   │ │
│                                                                    │ │
└────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        PHASE 2: Graph Queries                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  [T5] Graph Query Manager ◄─── depends on T1, T3                    │
│           │                                                         │
│           ├───► [T6] getCallers Query                               │
│           ├───► [T7] getCallees Query                               │
│           ├───► [T8] getImpact Query                                │
│           └───► [T9] findPath Query                                 │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        PHASE 3: Semantic Search                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  [T10] Embedding Service ───► [T11] Vector Store                    │
│            │                          │                             │
│            └──────────┬───────────────┘                             │
│                       ▼                                             │
│              [T12] Semantic Search Service                          │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      PHASE 4: MCP Integration                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  [T13] MCP Tool Schemas ◄─── depends on T5-T12                      │
│            │                                                        │
│            ▼                                                        │
│  [T14] Tool Implementations ───► [T15] Agent Registration           │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      PHASE 5: Tree-sitter (Optional)                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  [T16] Tree-sitter Setup ───► [T17] Language Configs                │
│                                      │                              │
│                                      ▼                              │
│                          [T18] Multi-lang Parser Integration        │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      PHASE 6: Unified Search                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  [T19] Unified Search Service ◄─── depends on T5, T12, existing     │
│            │                                                        │
│            ▼                                                        │
│  [T20] Extend searchVersionedApi with graph mode                    │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Appendix A: File Structure

```
src/
├── graph/                          # NEW
│   ├── index.ts
│   ├── GraphQueryManager.ts
│   ├── GraphBuilder.ts
│   └── types.ts
├── vectors/                        # NEW
│   ├── index.ts
│   ├── EmbeddingService.ts
│   ├── VectorStore.ts
│   └── types.ts
├── parser/
│   ├── TreeSitterManager.ts        # NEW
│   ├── CodeAnalyzer.ts             # NEW
│   └── ... existing
├── fantom-code/
│   ├── callExtractor.ts            # NEW
│   ├── codeParser.ts               # MODIFY
│   ├── types.ts                    # MODIFY
│   └── ... existing
├── search/
│   ├── semanticSearch.ts           # NEW
│   ├── unifiedSearch.ts            # NEW
│   ├── versionedApiSearch.ts       # MODIFY
│   └── ... existing
├── agents/
│   ├── graphAnalysis/              # NEW
│   │   └── GraphAnalysisAgent.ts
│   ├── index.ts                    # MODIFY
│   └── ... existing
└── index.ts                        # MODIFY (add tools)

prisma/
└── schema.prisma                   # MODIFY (add models)
```

---

## Appendix B: Estimated Effort

| Phase | Description | Estimated Effort |
|-------|-------------|------------------|
| Phase 1 | Foundation (Schema, Call Detection, Graph Builder) | 3-4 days |
| Phase 2 | Graph Queries (Callers, Callees, Impact, Path) | 2-3 days |
| Phase 3 | Semantic Search (Embeddings, Vector Store) | 2-3 days |
| Phase 4 | MCP Integration (Tools, Agent) | 1-2 days |
| Phase 5 | Tree-sitter (Optional multi-language) | 2-3 days |
| Phase 6 | Unified Search Integration | 1-2 days |
| **Total** | | **11-17 days** |

---

## Appendix C: Dependencies to Install

```bash
# Graph queries (already have Prisma)
# No new deps needed for graph queries

# Semantic search
npm install @huggingface/transformers sqlite-vec

# Tree-sitter (optional)
npm install tree-sitter tree-sitter-javascript tree-sitter-typescript \
  tree-sitter-python tree-sitter-go tree-sitter-rust tree-sitter-java
```
