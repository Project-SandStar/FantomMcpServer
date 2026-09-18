/**
 * LadybugDB Graph Builder
 *
 * Writes code graph (CodeNode + CodeEdge) to LadybugDB instead of SQLite/Prisma.
 * Called alongside the existing GraphBuilder during indexing — both stores
 * receive the same data. The Prisma GraphBuilder remains the source of truth
 * for metadata queries; LadybugDB handles graph traversal queries.
 *
 * Uses the same 16-char MD5 hash IDs as Prisma (generateFunctionId/generateTypeId).
 */

import { createLogger } from '../utils/index.js';
import {
  generateFunctionId,
  generateTypeId,
} from '../fantom-code/types.js';
import type {
  FantomFunction,
  FantomTypeDef,
  FunctionCall,
  ParsedFile
} from '../fantom-code/types.js';
import type { NodeType, GraphBuildResult } from './types.js';
import { ladybugExecute } from './ladybugConnection.js';
import { initLadybugSchema, clearProjectGraph } from './ladybugSchema.js';
import { invalidateProjectNodeCount } from './projectNodeCounts.js';

const logger = createLogger('ladybug-graph-builder');

/** Detect language from file extension */
function langFromPath(fp: string): string {
  if (fp.endsWith('.trio') || fp.endsWith('.axon')) return 'axon';
  if (fp.endsWith('.fan') || fp.endsWith('.fwt')) return 'fantom';
  return 'fantom';
}

// ============================================
// Type Mappings (same as graphBuilder.ts)
// ============================================

function mapFunctionTypeToNodeType(type: string): NodeType {
  switch (type) {
    case 'method': return 'method';
    case 'field': return 'field';
    case 'constructor': return 'constructor';
    default: return 'method';
  }
}

function mapTypeDefKindToNodeType(kind: string): NodeType {
  switch (kind) {
    case 'class': return 'class';
    case 'mixin': return 'mixin';
    case 'enum': return 'enum';
    case 'facet': return 'facet';
    default: return 'class';
  }
}

// ============================================
// Escape helper
// ============================================

/** Escape single quotes for Cypher string literals */
function esc(val: string | undefined | null): string {
  if (val == null) return '';
  return val.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// ============================================
// Pending edge type
// ============================================

interface PendingEdge {
  sourceId: string;
  targetName: string;
  edgeType: string;
  lineNumber?: number;
  colNumber?: number;
  confidence: number;
  metadata?: Record<string, unknown>;
  context?: { className?: string };
}

// ============================================
// LadybugGraphBuilder Class
// ============================================

export class LadybugGraphBuilder {
  private projectId: number;
  private nodeByQualifiedName = new Map<string, string>();
  private pendingEdges: PendingEdge[] = [];
  // Build-wide edge dedup (survives across queued + direct createEdge calls)
  private emittedEdgeKeys = new Set<string>();
  // Deferred write buffers — populated as nodes/edges are *registered* in the
  // in-memory maps, then flushed via batched UNWIND in buildFromFiles. The
  // per-row DB writes that createTypeNode/createFunctionNode/createEdge used
  // to do synchronously now defer here so we pay one round-trip per 200 rows
  // instead of one per row (~25x faster, see createNodesFromBatch probe).
  private nodeRows: LadybugNodeInput[] = [];
  private edgeRows: LadybugEdgeInput[] = [];

  private stats = {
    nodesCreated: 0,
    edgesCreated: 0,
    failedEdges: 0,
    unresolvedCount: 0,
    errors: [] as string[]
  };

  constructor(projectId: number) {
    this.projectId = projectId;
  }

  /**
   * Build graph from multiple parsed files
   */
  async buildFromFiles(
    parsedFiles: ParsedFile[],
    options: { clearProject?: boolean } = {},
  ): Promise<GraphBuildResult> {
    const { clearProject = true } = options;
    const startTime = Date.now();
    logger.info(`[LadybugDB] Building graph for project ${this.projectId} from ${parsedFiles.length} files (clearProject=${clearProject})`);

    try {
      // Ensure schema exists
      await initLadybugSchema();

      // Clear existing project data only when doing a full rebuild.
      // Per-file rebuilds skip this — caller is expected to have already
      // run clearFileGraph(projectId, filePath) for each affected file.
      if (clearProject) {
        await clearProjectGraph(this.projectId);
      }

      // First pass: create all type nodes
      for (const file of parsedFiles) {
        for (const typeDef of file.types) {
          await this.createTypeNode(typeDef);
        }
      }

      // Second pass: create member nodes + containment edges
      for (const file of parsedFiles) {
        for (const typeDef of file.types) {
          await this.createMemberNodes(typeDef);
        }
      }

      // Third pass: top-level / module-scoped functions (no parent type).
      // These dominate TypeScript / JavaScript / Python codebases, and were
      // previously dropped from the graph because we only walked file.types.
      for (const file of parsedFiles) {
        if (!file.functions || file.functions.length === 0) continue;
        for (const func of file.functions) {
          // Skip if a same-qualifiedName node was already created as a member.
          if (this.nodeByQualifiedName.has(func.qualifiedName)) continue;
          await this.createFunctionNode(func, '');
        }
      }

      // Flush all collected node rows in batched UNWIND writes. Nodes must
      // land before edges so the per-edge MATCH can resolve both endpoints.
      const nodeResult = await createNodesFromBatch(this.nodeRows);
      this.stats.nodesCreated = nodeResult.created;

      // Fourth pass: resolve pending edges against the in-memory maps and
      // collect resolvable rows (unresolved ones bump unresolvedCount).
      await this.createPendingEdges();

      // Flush all collected edge rows in batched UNWIND writes.
      const edgeResult = await createEdgesFromBatch(this.projectId, this.edgeRows);
      this.stats.edgesCreated = edgeResult.created;

      const result: GraphBuildResult = {
        projectId: this.projectId,
        success: this.stats.errors.length === 0,
        nodeCount: this.stats.nodesCreated,
        edgeCount: this.stats.edgesCreated,
        unresolvedCount: this.stats.unresolvedCount,
        durationMs: Date.now() - startTime,
        errors: this.stats.errors
      };

      logger.info(
        `[LadybugDB] Graph built: ${result.nodeCount} nodes, ${result.edgeCount} edges, ` +
        `${this.stats.failedEdges} failed, ${result.unresolvedCount} unresolved in ${result.durationMs}ms`
      );
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.stats.errors.push(errorMsg);
      logger.error(`[LadybugDB] Graph build failed: ${errorMsg}`);

      return {
        projectId: this.projectId,
        success: false,
        nodeCount: this.stats.nodesCreated,
        edgeCount: this.stats.edgesCreated,
        unresolvedCount: this.stats.unresolvedCount,
        durationMs: Date.now() - startTime,
        errors: this.stats.errors
      };
    }
  }

  /**
   * Create a CodeNode for a type definition
   */
  private async createTypeNode(typeDef: FantomTypeDef): Promise<string> {
    const id = typeDef.id || generateTypeId(typeDef.filePath, typeDef.qualifiedName, typeDef.lineNumber);
    const nodeType = mapTypeDefKindToNodeType(typeDef.kind);
    const modifiers = this.buildModifiers(typeDef);

    // Defer the DB write — collect a row matching the exact column set the old
    // single-CREATE used. createNodesFromBatch handles dedup against the DB and
    // duplicate-key fallback; we just register the row + the in-memory map here.
    this.nodeRows.push({
      id,
      projectId: this.projectId,
      nodeType,
      name: typeDef.name,
      qualifiedName: typeDef.qualifiedName,
      filePath: typeDef.filePath,
      lineStart: typeDef.lineNumber || 1,
      // Real span when the parser knows it (tree-sitter endPosition / Fantom
      // brace match); == lineStart otherwise, which embeddingText treats as
      // "unknown" and falls back to a window.
      lineEnd: Math.max(typeDef.lineEnd || 0, typeDef.lineNumber || 1),
      colStart: 0,
      colEnd: 0,
      signature: '',
      documentation: typeDef.documentation,
      returnType: '',
      modifiers: JSON.stringify(modifiers),
      facets: typeDef.facets ? JSON.stringify(typeDef.facets) : '[]',
      parentType: '',
      isPublic: typeDef.isPublic ?? true,
      isStatic: false,
      isAbstract: typeDef.isAbstract ?? false,
      isVirtual: false,
      isOverride: false,
      isExported: false,
      language: langFromPath(typeDef.filePath),
    });

    this.nodeByQualifiedName.set(typeDef.qualifiedName, id);

    // Queue inheritance edges
    if (typeDef.extends) {
      this.pendingEdges.push({
        sourceId: id,
        targetName: typeDef.extends,
        edgeType: 'extends',
        confidence: 1.0,
        metadata: { targetName: typeDef.extends }
      });
    }

    for (const mixin of typeDef.mixins) {
      this.pendingEdges.push({
        sourceId: id,
        targetName: mixin,
        edgeType: 'implements',
        confidence: 1.0,
        metadata: { targetName: mixin }
      });
    }

    return id;
  }

  /**
   * Create CodeNodes for type members
   */
  private async createMemberNodes(typeDef: FantomTypeDef): Promise<void> {
    const typeNodeId = this.nodeByQualifiedName.get(typeDef.qualifiedName);
    if (!typeNodeId) return;

    for (const method of typeDef.methods) {
      await this.createFunctionNode(method, typeNodeId);
    }
    for (const field of typeDef.fields) {
      await this.createFunctionNode(field, typeNodeId);
    }
  }

  /**
   * Create a CodeNode for a function/method/field
   */
  private async createFunctionNode(func: FantomFunction, parentTypeId: string): Promise<string> {
    const id = func.id || generateFunctionId(func.filePath, func.qualifiedName, func.lineNumber);
    const nodeType = mapFunctionTypeToNodeType(func.type);
    const modifiers = this.buildFunctionModifiers(func);

    // Defer the DB write — collect a row matching the exact column set the old
    // single-CREATE used. createNodesFromBatch handles dedup + duplicate-key.
    this.nodeRows.push({
      id,
      projectId: this.projectId,
      nodeType,
      name: func.name,
      qualifiedName: func.qualifiedName,
      filePath: func.filePath,
      lineStart: func.lineNumber || 1,
      lineEnd: Math.max(func.lineEnd || 0, func.lineNumber || 1),
      colStart: 0,
      colEnd: 0,
      signature: func.signature,
      documentation: func.documentation,
      returnType: func.returnType,
      modifiers: JSON.stringify(modifiers),
      facets: func.facets ? JSON.stringify(func.facets) : '[]',
      parentType: func.className,
      isPublic: func.isPublic ?? true,
      isStatic: func.isStatic ?? false,
      isAbstract: func.isAbstract ?? false,
      isVirtual: func.isVirtual ?? false,
      isOverride: func.isOverride ?? false,
      isExported: false,
      language: langFromPath(func.filePath),
    });

    this.nodeByQualifiedName.set(func.qualifiedName, id);

    // Containment edge: type -> member. Skip for top-level/module-scoped
    // functions where there is no parent type (parentTypeId === '').
    // Deferred: collect the edge row instead of writing inline — the target
    // node row hasn't been flushed yet, so an inline MATCH would silently
    // find nothing and drop the edge.
    if (parentTypeId) {
      this.collectEdge(parentTypeId, id, 'contains', undefined, undefined, 1.0);
    }

    // Returns edge
    if (func.returnType && func.returnType !== 'Void') {
      this.pendingEdges.push({
        sourceId: id,
        targetName: func.returnType,
        edgeType: 'returns',
        confidence: 1.0,
        metadata: { targetName: func.returnType }
      });
    }

    // Override edge
    if (func.isOverride && func.className) {
      this.pendingEdges.push({
        sourceId: id,
        targetName: `${func.className}.${func.name}`,
        edgeType: 'overrides',
        confidence: 0.8,
        metadata: { methodName: func.name, className: func.className }
      });
    }

    // Call edges
    if (func.calls && func.calls.length > 0) {
      for (const call of func.calls) {
        this.queueCallEdge(id, call, func.className);
      }
    }

    // 'uses' edges for parameter types (#23)
    if (func.parameters && func.parameters.length > 0) {
      for (const param of func.parameters) {
        if (param.type && param.type !== 'Void' && param.type !== 'Obj') {
          this.pendingEdges.push({
            sourceId: id,
            targetName: param.type,
            edgeType: 'parameters',
            confidence: 1.0,
            metadata: { paramName: param.name, paramType: param.type }
          });
        }
      }
    }

    // 'uses' edges for field types (#23)
    if (func.type === 'field' && func.returnType && func.returnType !== 'Void' && func.returnType !== 'Obj') {
      this.pendingEdges.push({
        sourceId: id,
        targetName: func.returnType,
        edgeType: 'uses',
        confidence: 0.9,
        metadata: { fieldType: func.returnType }
      });
    }

    return id;
  }

  /**
   * Queue a call edge
   */
  private queueCallEdge(sourceId: string, call: FunctionCall, className?: string): void {
    const targetName = call.calledQualifiedName ||
                       (call.target ? `${call.target}.${call.calledName}` : call.calledName);

    // Enhanced confidence scoring (#20)
    let confidence: number;
    if (call.isDynamic) {
      confidence = 0.7;
    } else if (call.isConstructor) {
      confidence = 0.95;
    } else if (call.calledQualifiedName) {
      // Fully qualified = high confidence
      confidence = 1.0;
    } else if (call.target && className && call.target === className) {
      // Same-class call
      confidence = 0.85;
    } else if (call.target) {
      // Has explicit target (import-resolved)
      confidence = 0.9;
    } else {
      // Simple name, fuzzy match
      confidence = 0.5;
    }

    this.pendingEdges.push({
      sourceId,
      targetName,
      edgeType: 'calls',
      lineNumber: call.lineNumber,
      colNumber: call.colNumber,
      confidence,
      metadata: {
        calledName: call.calledName,
        target: call.target,
        isStatic: call.isStatic,
        isDynamic: call.isDynamic,
        isConstructor: call.isConstructor
      },
      context: { className }
    });
  }

  /**
   * Resolve pending edges and create them in LadybugDB.
   * Deduplicates on (sourceId|targetId|edgeType|lineNumber) — the same key
   * the Prisma graph builder uses — so re-indexing or duplicate parses don't
   * inflate edge counts once Ladybug becomes authoritative.
   */
  private async createPendingEdges(): Promise<void> {
    const seen = new Set<string>();
    for (const edge of this.pendingEdges) {
      const targetId = this.resolveReference(edge.targetName, edge.context);
      if (!targetId) {
        this.stats.unresolvedCount++;
        continue;
      }
      const key = `${edge.sourceId}|${targetId}|${edge.edgeType}|${edge.lineNumber ?? 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.collectEdge(
        edge.sourceId, targetId, edge.edgeType,
        edge.lineNumber, edge.colNumber, edge.confidence,
        edge.metadata
      );
    }
  }

  /**
   * Collect a single resolved edge row for the batched UNWIND writer.
   * Preserves the build-wide dedup (emittedEdgeKeys) that the old per-row
   * createEdge enforced — the same (source|target|type|line) key — so queued
   * pending edges and the inline 'contains' edge can't double-emit. The actual
   * MATCH+CREATE happens later in createEdgesFromBatch; rows whose endpoints
   * don't resolve are filtered out *before* this point in createPendingEdges
   * (unresolvedCount) or, for inline 'contains', are guaranteed to exist
   * because both endpoint node rows were already registered.
   */
  private collectEdge(
    sourceId: string, targetId: string, edgeType: string,
    lineNumber?: number, colNumber?: number, confidence = 1.0,
    metadata?: Record<string, unknown>,
    crossLanguage = false,
  ): void {
    const key = `${sourceId}|${targetId}|${edgeType}|${lineNumber ?? 0}`;
    if (this.emittedEdgeKeys.has(key)) return;
    this.emittedEdgeKeys.add(key);
    this.edgeRows.push({
      sourceId,
      targetId,
      edgeType,
      lineNumber: lineNumber ?? 0,
      colNumber: colNumber ?? 0,
      isResolved: true,
      confidence,
      metadata: metadata ? JSON.stringify(metadata) : '',
      crossLanguage,
    });
  }

  /**
   * Try to resolve a reference to a known node
   */
  private resolveReference(name: string, context?: { className?: string }): string | undefined {
    // Exact match
    if (this.nodeByQualifiedName.has(name)) {
      return this.nodeByQualifiedName.get(name);
    }

    // Handle "this.method" → resolve via context class
    if (name.startsWith('this.') && context?.className) {
      const methodName = name.substring(5);
      const suffix = `.${context.className}.${methodName}`;
      for (const [qn, id] of this.nodeByQualifiedName) {
        if (qn.endsWith(suffix) || qn === `${context.className}.${methodName}`) {
          return id;
        }
      }
    }

    // Try pod-qualified match: "Str" → "sys::Str"
    for (const [qn, id] of this.nodeByQualifiedName) {
      if (qn.endsWith(`::${name}`)) return id;
    }

    // Try within same class context
    if (!name.includes('.') && !name.includes('::') && context?.className) {
      const suffix = `.${context.className}.${name}`;
      for (const [qn, id] of this.nodeByQualifiedName) {
        if (qn.endsWith(suffix)) return id;
      }
    }

    // Unique simple name match
    if (!name.includes('.') && !name.includes('::')) {
      const matches: string[] = [];
      for (const [qn, id] of this.nodeByQualifiedName) {
        if (qn.endsWith(`.${name}`)) matches.push(id);
      }
      if (matches.length === 1) return matches[0];
    }

    return undefined;
  }

  // ============================================
  // Modifier helpers (same as graphBuilder.ts)
  // ============================================

  private buildModifiers(typeDef: FantomTypeDef): string[] {
    const m: string[] = [];
    if (typeDef.isPublic) m.push('public');
    else m.push('internal');
    if (typeDef.isAbstract) m.push('abstract');
    if (typeDef.isFinal) m.push('final');
    if (typeDef.isConst) m.push('const');
    return m;
  }

  private buildFunctionModifiers(func: FantomFunction): string[] {
    const m: string[] = [];
    if (func.isPublic) m.push('public');
    else m.push('private');
    if (func.isStatic) m.push('static');
    if (func.isAbstract) m.push('abstract');
    if (func.isVirtual) m.push('virtual');
    if (func.isOverride) m.push('override');
    return m;
  }
}

/**
 * Build LadybugDB graph for a project from parsed files.
 * Call this alongside buildProjectGraph() during indexing.
 */
export async function buildLadybugGraph(
  projectId: number,
  parsedFiles: ParsedFile[],
  options: { clearProject?: boolean } = {},
): Promise<GraphBuildResult> {
  const builder = new LadybugGraphBuilder(projectId);
  try {
    return await builder.buildFromFiles(parsedFiles, options);
  } finally {
    // A (re)build changes the node set; the snapshot's size fingerprint may
    // not notice a same-size rewrite, so say so explicitly.
    invalidateProjectNodeCount(projectId);
  }
}

// ============================================
// Module-level batch helpers
// ============================================
// Used by ingestion paths that bypass GraphBuilder (tree-sitter, axon, haxall
// sync) and today call prisma.codeNode.createMany / prisma.codeEdge.createMany
// directly. These helpers mirror the Prisma column names and fill in the
// Ladybug-only fields (language, confidence) with sensible defaults.

export interface LadybugNodeInput {
  id: string;
  projectId: number;
  nodeType: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  lineStart?: number | null;
  lineEnd?: number | null;
  colStart?: number | null;
  colEnd?: number | null;
  signature?: string | null;
  documentation?: string | null;
  returnType?: string | null;
  modifiers?: string | null;
  facets?: string | null;
  parentType?: string | null;
  isPublic?: boolean | null;
  isStatic?: boolean | null;
  isAbstract?: boolean | null;
  isVirtual?: boolean | null;
  isOverride?: boolean | null;
  isExported?: boolean | null;
  language?: string | null;
}

export interface LadybugEdgeInput {
  sourceId: string;
  targetId: string;
  edgeType: string;
  lineNumber?: number | null;
  colNumber?: number | null;
  isResolved?: boolean | null;
  confidence?: number | null;
  metadata?: string | Record<string, unknown> | null;
  crossLanguage?: boolean | null;
}

// Size tuned to keep Cypher query strings comfortably under any parser limits
// while still capturing >95% of the UNWIND speedup (see probe: 100 nodes in
// 32ms via UNWIND vs 806ms via single CREATE — 25× improvement).
const BATCH_UNWIND_SIZE = 200;

/** Render a row object as a Cypher map literal with the full CodeNode shape. */
function renderNodeRow(n: LadybugNodeInput): string {
  const language = n.language ?? langFromPath(n.filePath);
  return `{
    id: '${esc(n.id)}',
    project_id: ${n.projectId},
    node_type: '${esc(n.nodeType)}',
    name: '${esc(n.name)}',
    qualified_name: '${esc(n.qualifiedName)}',
    file_path: '${esc(n.filePath)}',
    line_start: ${n.lineStart ?? 1},
    line_end: ${n.lineEnd ?? n.lineStart ?? 1},
    col_start: ${n.colStart ?? 0},
    col_end: ${n.colEnd ?? 0},
    signature: '${esc(n.signature ?? '')}',
    documentation: '${esc(n.documentation ?? '')}',
    return_type: '${esc(n.returnType ?? '')}',
    modifiers: '${esc(n.modifiers ?? '')}',
    facets: '${esc(n.facets ?? '')}',
    parent_type: '${esc(n.parentType ?? '')}',
    is_public: ${n.isPublic ?? true},
    is_static: ${n.isStatic ?? false},
    is_abstract: ${n.isAbstract ?? false},
    is_virtual: ${n.isVirtual ?? false},
    is_override: ${n.isOverride ?? false},
    is_exported: ${n.isExported ?? false},
    language: '${esc(language)}'
  }`;
}

/**
 * Batch-create nodes. Dedupes by id within the batch and against what's
 * already in Ladybug, so callers can re-submit the same payload safely.
 * Uses UNWIND of map literals to write in batches of BATCH_UNWIND_SIZE.
 */
export async function createNodesFromBatch(
  nodes: LadybugNodeInput[]
): Promise<{ created: number; skipped: number }> {
  if (nodes.length === 0) return { created: 0, skipped: 0 };
  // Per-project routing: every node in a single batch must share a projectId.
  const projectId = nodes[0].projectId;
  for (const n of nodes) {
    if (n.projectId !== projectId) {
      throw new Error(`createNodesFromBatch: mixed project IDs in batch (${projectId} vs ${n.projectId}). Split caller into per-project batches.`);
    }
  }

  // Intra-batch dedup
  const seen = new Set<string>();
  const deduped = nodes.filter(n => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });

  // Existence check in Ladybug — chunk the IN list too so query doesn't blow up
  const existingIds = new Set<string>();
  const { ladybugQuery } = await import('./ladybugConnection.js');
  for (let i = 0; i < deduped.length; i += 500) {
    const idList = deduped.slice(i, i + 500).map(n => `'${esc(n.id)}'`).join(', ');
    const rows = await ladybugQuery<{ id: string }>(
      projectId,
      `MATCH (n:CodeNode) WHERE n.id IN [${idList}] RETURN n.id AS id`
    );
    for (const r of rows) existingIds.add(r.id);
  }

  const toCreate = deduped.filter(n => !existingIds.has(n.id));

  let created = 0;
  for (let i = 0; i < toCreate.length; i += BATCH_UNWIND_SIZE) {
    const batch = toCreate.slice(i, i + BATCH_UNWIND_SIZE);
    const rowsCypher = batch.map(renderNodeRow).join(',\n    ');
    try {
      await ladybugExecute(
        projectId,
        `UNWIND [
    ${rowsCypher}
        ] AS row
        CREATE (n:CodeNode {
          id: row.id,
          project_id: row.project_id,
          node_type: row.node_type,
          name: row.name,
          qualified_name: row.qualified_name,
          file_path: row.file_path,
          line_start: row.line_start,
          line_end: row.line_end,
          col_start: row.col_start,
          col_end: row.col_end,
          signature: row.signature,
          documentation: row.documentation,
          return_type: row.return_type,
          modifiers: row.modifiers,
          facets: row.facets,
          parent_type: row.parent_type,
          is_public: row.is_public,
          is_static: row.is_static,
          is_abstract: row.is_abstract,
          is_virtual: row.is_virtual,
          is_override: row.is_override,
          is_exported: row.is_exported,
          language: row.language
        })`
      );
      created += batch.length;
    } catch (err) {
      // If a batch hits a duplicate-key error, fall back to per-row so one
      // bad row doesn't poison an otherwise-valid chunk. This mirrors how
      // graphBuilder.ts:622-645 handles Prisma batch failures.
      const msg = String(err);
      if (msg.includes('duplicated primary key') || msg.includes('already exists')) {
        for (const n of batch) {
          try {
            await ladybugExecute(projectId, `CREATE (n:CodeNode ${renderNodeRow(n)})`);
            created++;
          } catch { /* skip duplicates */ }
        }
      } else {
        logger.warn(`[LadybugDB] UNWIND node batch failed: ${msg.slice(0, 200)}`);
      }
    }
  }
  return { created, skipped: deduped.length - created };
}

/** Render an edge row as a Cypher map literal. */
function renderEdgeRow(e: LadybugEdgeInput, includeCrossLang = true): string {
  const metadata = typeof e.metadata === 'string'
    ? e.metadata
    : (e.metadata ? JSON.stringify(e.metadata) : '');
  const baseProps = `sourceId: '${esc(e.sourceId)}',
    targetId: '${esc(e.targetId)}',
    edge_type: '${esc(e.edgeType)}',
    line_number: ${e.lineNumber ?? 0},
    col_number: ${e.colNumber ?? 0},
    is_resolved: ${e.isResolved ?? true},
    confidence: ${e.confidence ?? 1.0},
    metadata: '${esc(metadata)}'`;
  return `{
    ${baseProps}${includeCrossLang ? `,\n    cross_language: ${e.crossLanguage ?? false}` : ''}
  }`;
}

/**
 * Batch-create edges. Dedupes by (sourceId, targetId, edgeType, lineNumber)
 * within the batch. Uses UNWIND of map literals with MATCH+CREATE; edges
 * whose source or target isn't present in Ladybug are silently dropped by
 * the MATCH.
 */
export async function createEdgesFromBatch(
  projectId: number,
  edges: LadybugEdgeInput[]
): Promise<{ created: number; skipped: number }> {
  if (edges.length === 0) return { created: 0, skipped: 0 };

  // Intra-batch dedup
  const seen = new Set<string>();
  const deduped = edges.filter(e => {
    const key = `${e.sourceId}|${e.targetId}|${e.edgeType}|${e.lineNumber ?? 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Track whether cross_language is known to be unavailable for this project
  // (older DB created before the column existed AND the migration didn't take).
  // We'll drop the column from edge writes after the first failure attributed
  // to it, so the rest of the batch still lands.
  let crossLangSupported = true;
  let created = 0;
  for (let i = 0; i < deduped.length; i += BATCH_UNWIND_SIZE) {
    const batch = deduped.slice(i, i + BATCH_UNWIND_SIZE);
    const rowsCypher = batch.map(e => renderEdgeRow(e, crossLangSupported)).join(',\n    ');
    const propsBlock = crossLangSupported
      ? `edge_type: row.edge_type,
          line_number: row.line_number,
          col_number: row.col_number,
          is_resolved: row.is_resolved,
          confidence: row.confidence,
          metadata: row.metadata,
          cross_language: row.cross_language`
      : `edge_type: row.edge_type,
          line_number: row.line_number,
          col_number: row.col_number,
          is_resolved: row.is_resolved,
          confidence: row.confidence,
          metadata: row.metadata`;
    try {
      await ladybugExecute(
        projectId,
        `UNWIND [
    ${rowsCypher}
        ] AS row
        MATCH (a:CodeNode {id: row.sourceId}), (b:CodeNode {id: row.targetId})
        CREATE (a)-[:CodeEdge { ${propsBlock} }]->(b)`
      );
      created += batch.length;
    } catch (err) {
      const msg = String(err).toLowerCase();
      if (crossLangSupported && /cross_language|property.*not.*exist|unknown.*propert/.test(msg)) {
        logger.warn(`[LadybugDB] project ${projectId}: cross_language column missing — disabling for this run`);
        crossLangSupported = false;
        i -= BATCH_UNWIND_SIZE; // retry this batch without cross_language
        continue;
      }
      // Fall back to per-row so bad rows don't poison the chunk.
      logger.warn(`[LadybugDB] UNWIND edge batch failed, falling back per-row: ${String(err).slice(0, 200)}`);
      for (const e of batch) {
        try {
          await ladybugExecute(
            projectId,
            `MATCH (a:CodeNode {id: '${esc(e.sourceId)}'}), (b:CodeNode {id: '${esc(e.targetId)}'})
             CREATE (a)-[:CodeEdge ${renderEdgeRow(e, crossLangSupported)}]->(b)`
          );
          created++;
        } catch { /* skip */ }
      }
    }
  }
  return { created, skipped: deduped.length - created };
}

/**
 * Compute structural / call edges from in-memory FantomCodeIndexer data and
 * insert them into LadybugDB. Used at boot, after createNodesFromBatch has
 * synced nodes for a Fantom project — that path inserts nodes only and would
 * leave the graph permanently edge-less until an explicit /reindex.
 *
 * Edge kinds emitted:
 *   - extends      type → resolved-extends-target
 *   - implements   type → mixin (one per entry)
 *   - contains     parent-type → method/field
 *   - calls        function/method → resolved callee
 *
 * Resolution strategy is deliberately conservative — if a name doesn't match
 * exactly one known node, the edge is skipped (counts toward `unresolved`).
 * The full LadybugGraphBuilder pipeline does fancier scoping; this helper is
 * the boot-time fast-path equivalent.
 */
export async function buildEdgesFromIndexerData(
  projectId: number,
  types: Array<{
    id: string; qualifiedName: string; name: string;
    language?: string;
    extends?: string | null; mixins?: string[];
    methods?: Array<{ id: string; qualifiedName: string; language?: string }>;
    fields?: Array<{ id: string; qualifiedName: string; language?: string }>;
  }>,
  functions: Array<{
    id: string; qualifiedName: string; name: string;
    language?: string;
    className?: string | null; lineNumber?: number;
    calls?: Array<{
      calledName: string; target?: string | null;
      lineNumber?: number; colNumber?: number;
      isStatic?: boolean; isConstructor?: boolean;
    }>;
  }>,
): Promise<{ edgesCreated: number; unresolved: number; multiMatch: number }> {
  // Build resolution maps:
  //  - byQn:   exact qualifiedName → id (e.g. "pod::Type.method", "pod::Type")
  //  - byTail: short tail (Type.method, Type, method) → [id, ...]
  //
  // Fantom call extractor records bare names (e.g. "ensureOpen") and a
  // target ("super", "this", "Type", or null). Resolution priority:
  //   1. exact qn match
  //   2. tail "<className>.<calledName>" within the project
  //   3. tail ".<calledName>" or just "<calledName>" — only if exactly one
  //      candidate remains (otherwise too ambiguous, skip).
  const byQn = new Map<string, string>();
  const byTail = new Map<string, string[]>();
  // Track each candidate id's pod (extracted from "pod::…" qualifiedName) and
  // language, so the resolver can prefer same-language / same-pod targets
  // when a bare name matches multiple candidates.
  const idMeta = new Map<string, { language: string; pod: string }>();
  const addTail = (key: string, id: string) => {
    const arr = byTail.get(key);
    if (arr) arr.push(id); else byTail.set(key, [id]);
  };
  const podOf = (qn: string): string => qn.includes('::') ? qn.split('::', 1)[0]! : '';
  const recordMeta = (id: string, qn: string, language?: string) => {
    if (idMeta.has(id)) return;
    idMeta.set(id, { language: (language || 'fantom').toLowerCase(), pod: podOf(qn) });
  };

  for (const t of types) {
    if (!t.id || !t.qualifiedName) continue;
    byQn.set(t.qualifiedName, t.id);
    recordMeta(t.id, t.qualifiedName, t.language);
    addTail(t.name, t.id);
    const stripped = t.qualifiedName.includes('::')
      ? t.qualifiedName.split('::').slice(1).join('::')
      : t.qualifiedName;
    if (stripped !== t.qualifiedName) byQn.set(stripped, t.id);
  }
  for (const f of functions) {
    if (!f.id || !f.qualifiedName) continue;
    byQn.set(f.qualifiedName, f.id);
    recordMeta(f.id, f.qualifiedName, f.language);
    if (f.className) addTail(`${f.className}.${f.name}`, f.id);
    addTail(f.name, f.id);
    const stripped = f.qualifiedName.includes('::')
      ? f.qualifiedName.split('::').slice(1).join('::')
      : f.qualifiedName;
    if (stripped !== f.qualifiedName) byQn.set(stripped, f.id);
  }

  let multiMatch = 0;
  const resolveByName = (
    raw: string,
    ctx?: { callerLang?: string; callerPod?: string },
  ): string | null => {
    if (!raw) return null;
    const direct = byQn.get(raw);
    if (direct) return direct;
    const arr = byTail.get(raw);
    if (!arr || arr.length === 0) return null;
    if (arr.length === 1) return arr[0]!;
    // Ambiguous: apply tiebreakers — same language, then same pod, then
    // deterministic (lowest id). Always log the ambiguity.
    const cl = (ctx?.callerLang || 'fantom').toLowerCase();
    const cp = ctx?.callerPod || '';
    const scored = arr.map(id => {
      const m = idMeta.get(id);
      const sameLang = m && m.language === cl ? 1 : 0;
      const samePod = m && cp && m.pod === cp ? 1 : 0;
      return { id, sameLang, samePod };
    });
    scored.sort((a, b) =>
      (b.sameLang - a.sameLang) ||
      (b.samePod - a.samePod) ||
      (a.id < b.id ? -1 : 1),
    );
    multiMatch++;
    logger.warn(
      `[LadybugDB] multi-match for "${raw}" (caller lang=${cl}, pod=${cp || '?'}): ` +
      `${arr.length} candidates → picked ${scored[0]!.id}`,
    );
    return scored[0]!.id;
  };

  const edges: LadybugEdgeInput[] = [];
  let unresolved = 0;

  // 1. extends / implements (mixins) on types
  const isCrossLang = (sourceLang: string | undefined, targetId: string): boolean => {
    const sl = (sourceLang || 'fantom').toLowerCase();
    const tl = (idMeta.get(targetId)?.language || 'fantom').toLowerCase();
    return sl !== tl;
  };
  for (const t of types) {
    if (!t.id) continue;
    const tctx = { callerLang: t.language, callerPod: podOf(t.qualifiedName) };
    if (t.extends) {
      const tgt = resolveByName(t.extends, tctx);
      if (tgt) {
        edges.push({ sourceId: t.id, targetId: tgt, edgeType: 'extends', confidence: 1.0,
          crossLanguage: isCrossLang(t.language, tgt) });
      } else {
        unresolved++;
      }
    }
    for (const mx of t.mixins ?? []) {
      const tgt = resolveByName(mx, tctx);
      if (tgt) {
        edges.push({ sourceId: t.id, targetId: tgt, edgeType: 'implements', confidence: 1.0,
          crossLanguage: isCrossLang(t.language, tgt) });
      } else {
        unresolved++;
      }
    }
  }

  // 2. contains (parent type → member)
  for (const t of types) {
    if (!t.id) continue;
    for (const m of t.methods ?? []) {
      if (m.id) edges.push({ sourceId: t.id, targetId: m.id, edgeType: 'contains', confidence: 1.0 });
    }
    for (const f of t.fields ?? []) {
      if (f.id) edges.push({ sourceId: t.id, targetId: f.id, edgeType: 'contains', confidence: 1.0 });
    }
  }

  // 3. calls (functions/methods → resolved callees)
  for (const fn of functions) {
    if (!fn.id || !fn.calls || fn.calls.length === 0) continue;
    const ctx = { callerLang: fn.language, callerPod: podOf(fn.qualifiedName) };
    for (const c of fn.calls) {
      // Try Type.method first when target looks like a class name (capitalized
      // identifier) or when caller has a className and target is "this"/"super".
      let candidate: string | null = null;
      const target = c.target ?? '';

      // Constructor: "Type.make()" — target acts as the class.
      if (c.isConstructor && target) {
        candidate = resolveByName(`${target}.make`, ctx) || resolveByName(target, ctx);
      }
      if (!candidate && target && /^[A-Z]/.test(target)) {
        candidate = resolveByName(`${target}.${c.calledName}`, ctx);
      }
      if (!candidate && fn.className && (target === 'this' || target === 'super' || !target)) {
        candidate = resolveByName(`${fn.className}.${c.calledName}`, ctx);
      }
      if (!candidate) {
        candidate = resolveByName(c.calledName, ctx);
      }
      if (candidate) {
        edges.push({
          sourceId: fn.id,
          targetId: candidate,
          edgeType: 'calls',
          lineNumber: c.lineNumber ?? null,
          colNumber: c.colNumber ?? null,
          confidence: 0.8,
          crossLanguage: isCrossLang(fn.language, candidate),
        });
      } else {
        unresolved++;
      }
    }
  }

  if (edges.length === 0) {
    logger.info(`[LadybugDB] buildEdgesFromIndexerData(${projectId}): no edges resolved (unresolved=${unresolved}, multiMatch=${multiMatch})`);
    return { edgesCreated: 0, unresolved, multiMatch };
  }

  // Drop existing edges (per-project DB is implicitly scoped) so a re-sync
  // produces a consistent count instead of layering duplicates on top.
  await ladybugExecute(
    projectId,
    `MATCH (n:CodeNode)-[e:CodeEdge]->() DELETE e`,
  );
  const { created } = await createEdgesFromBatch(projectId, edges);
  logger.info(
    `[LadybugDB] buildEdgesFromIndexerData(${projectId}): ${created} edges created (resolved ${edges.length}/${edges.length + unresolved}, multiMatch=${multiMatch})`,
  );
  return { edgesCreated: created, unresolved, multiMatch };
}
