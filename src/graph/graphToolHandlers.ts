/**
 * Graph Tool Handlers - Implementation of graph analysis MCP tools
 *
 * Processes tool calls for:
 * - Call graph navigation (callers, callees)
 * - Impact analysis
 * - Semantic search
 * - Graph management
 */

import type { PrismaClient } from '@prisma/client';
import { createLogger } from '../utils/index.js';
import { LadybugQueryManager, getLadybugQueryManager } from './ladybugQueryManager.js';
import { isLadybugInitialized } from './ladybugConnection.js';
import { getOrDetectCommunities, clearCommunityCache } from './communityDetection.js';
import { getOrTraceProcessFlows, findProcessesForFunction, clearProcessCache } from './processTracer.js';
import { assessChangeImpact } from './changeDetector.js';
import { checkStaleness } from './stalenessChecker.js';
import {
  SemanticSearchService,
  getSemanticSearchService
} from '../embedding/semanticSearchService.js';
import { isGraphTool } from './graphTools.js';
import {
  GraphDSLParser,
  GraphQueryExecutor,
  createDSLParser,
  createQueryExecutor
} from './graphQueryDSL.js';
import {
  GraphVisualizationService,
  getGraphVisualizationService
} from './graphVisualization.js';
import type { CodeIndexingService } from '../fantom-code/codeIndexingService.js';

const logger = createLogger('graph-tool-handlers');

// ============================================
// Types
// ============================================

export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface GraphToolHandlerContext {
  prisma: PrismaClient;
  indexingService?: CodeIndexingService;
}

// ============================================
// Graph Tool Handler
// ============================================

export class GraphToolHandler {
  private prisma: PrismaClient;
  // Single query manager (Ladybug-authoritative). During the migration the
  // dual-path `useLadybug() ? ladybugQM : queryManager` branches in this file
  // now point both paths at the same instance; Stage 3 removes the dead
  // branches, Stage 4 drops the Prisma graph schema.
  private queryManager: LadybugQueryManager;
  private ladybugQM: LadybugQueryManager;
  private semanticSearch: SemanticSearchService;
  private indexingService?: CodeIndexingService;
  private dslParser: GraphDSLParser;
  private queryExecutor: GraphQueryExecutor;
  private visualization: GraphVisualizationService;

  constructor(context: GraphToolHandlerContext) {
    this.prisma = context.prisma;
    this.ladybugQM = getLadybugQueryManager();
    this.queryManager = this.ladybugQM;
    this.semanticSearch = getSemanticSearchService(context.prisma);
    this.indexingService = context.indexingService;
    this.dslParser = createDSLParser();
    this.queryExecutor = createQueryExecutor(context.prisma);
    this.visualization = getGraphVisualizationService(context.prisma);
  }

  /**
   * Check if LadybugDB is available for graph traversal queries.
   * Falls back to SQLite/Prisma if not initialized.
   */
  private async useLadybug(): Promise<boolean> {
    try {
      return await isLadybugInitialized();
    } catch {
      return false;
    }
  }

  /**
   * Check if this handler can process a tool
   */
  canHandle(toolName: string): boolean {
    return isGraphTool(toolName);
  }

  /**
   * Handle a graph tool call
   */
  async handle(toolName: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    try {
      switch (toolName) {
        case 'getCallers':
          return await this.handleGetCallers(args);
        case 'getCallees':
          return await this.handleGetCallees(args);
        case 'getCodeImpact':
          return await this.handleGetCodeImpact(args);
        case 'findCodePath':
          return await this.handleFindCodePath(args);
        case 'semanticCodeSearch':
          return await this.handleSemanticSearch(args);
        case 'findSimilarCode':
          return await this.handleFindSimilar(args);
        case 'getGraphMetrics':
          return await this.handleGetMetrics(args);
        case 'getMostCalledFunctions':
          return await this.handleGetMostCalled(args);
        case 'getMostComplexFunctions':
          return await this.handleGetMostComplex(args);
        case 'buildProjectGraph':
          return await this.handleBuildGraph(args);
        case 'buildProjectEmbeddings':
          return await this.handleBuildEmbeddings(args);
        case 'getGraphStats':
          return await this.handleGetStats(args);
        case 'detectCycles':
          return await this.handleDetectCycles(args);
        case 'queryGraph':
          return await this.handleQueryGraph(args);
        case 'findConstrainedPath':
          return await this.handleFindConstrainedPath(args);
        case 'getStronglyConnectedComponents':
          return await this.handleGetSCC(args);
        case 'getPageRank':
          return await this.handleGetPageRank(args);
        case 'getBetweennessCentrality':
          return await this.handleGetCentrality(args);
        case 'exportGraphVisualization':
          return await this.handleExportVisualization(args);
        case 'listCommunities':
          return await this.handleListCommunities(args);
        case 'getProcessFlow':
          return await this.handleGetProcessFlow(args);
        case 'findProcessesForFunction':
          return await this.handleFindProcessesForFunction(args);
        case 'detectChanges':
          return await this.handleDetectChanges(args);
        case 'checkStaleness':
          return await this.handleCheckStaleness(args);
        case 'getProjectFunctions':
          return await this.handleGetProjectFunctions(args);
        case 'getProjectTypes':
          return await this.handleGetProjectTypes(args);
        default:
          return this.errorResult(`Unknown graph tool: ${toolName}`);
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Graph tool error (${toolName}): ${errMsg}`);
      return this.errorResult(errMsg);
    }
  }

  // ============================================
  // Tool Handlers
  // ============================================

  private async handleGetCallers(args: Record<string, unknown>): Promise<ToolCallResult> {
    const nodeId = await this.resolveNodeId(args);
    if (!nodeId) {
      return this.errorResult('Either nodeId or qualifiedName is required');
    }

    const maxDepth = (args.maxDepth as number) || 5;
    const useLB = await this.useLadybug();
    const callers = useLB
      ? await this.ladybugQM.getCallers(nodeId, maxDepth)
      : await this.queryManager.getCallers(nodeId, maxDepth);

    if (callers.length === 0) {
      return this.textResult('No callers found for this function.');
    }

    const engine = useLB ? ' (LadybugDB)' : '';
    const lines = [`Found ${callers.length} callers${engine}:\n`];
    for (const caller of callers) {
      const conf = caller.confidence != null ? ` (${(caller.confidence * 100).toFixed(0)}% conf)` : '';
      const flags = [
        caller.isStatic ? 'static' : '',
        caller.isDynamic ? 'dynamic' : '',
        caller.isConstructor ? 'ctor' : ''
      ].filter(Boolean).join(', ');
      const flagStr = flags ? ` [${flags}]` : '';
      lines.push(`- [depth ${caller.depth}] ${caller.qualifiedName}${conf}${flagStr}`);
      lines.push(`  File: ${caller.filePath}${caller.lineNumber ? `:${caller.lineNumber}` : ''}`);
    }

    return this.textResult(lines.join('\n'));
  }

  private async handleGetCallees(args: Record<string, unknown>): Promise<ToolCallResult> {
    const nodeId = await this.resolveNodeId(args);
    if (!nodeId) {
      return this.errorResult('Either nodeId or qualifiedName is required');
    }

    const maxDepth = (args.maxDepth as number) || 5;
    const useLB = await this.useLadybug();
    const callees = useLB
      ? await this.ladybugQM.getCallees(nodeId, maxDepth)
      : await this.queryManager.getCallees(nodeId, maxDepth);

    if (callees.length === 0) {
      return this.textResult('No callees found for this function.');
    }

    const lines = [`Found ${callees.length} callees:\n`];
    for (const callee of callees) {
      const conf = callee.confidence != null ? ` (${(callee.confidence * 100).toFixed(0)}% conf)` : '';
      const flags = [
        callee.isStatic ? 'static' : '',
        callee.isDynamic ? 'dynamic' : '',
        callee.isConstructor ? 'ctor' : ''
      ].filter(Boolean).join(', ');
      const flagStr = flags ? ` [${flags}]` : '';
      lines.push(`- [depth ${callee.depth}] ${callee.qualifiedName}${conf}${flagStr}`);
      lines.push(`  File: ${callee.filePath}${callee.lineNumber ? `:${callee.lineNumber}` : ''}`);
    }

    return this.textResult(lines.join('\n'));
  }

  private async handleGetCodeImpact(args: Record<string, unknown>): Promise<ToolCallResult> {
    const nodeId = await this.resolveNodeId(args);
    if (!nodeId) {
      return this.errorResult('Either nodeId or qualifiedName is required');
    }

    const maxDepth = (args.maxDepth as number) || 10;
    const useLB = await this.useLadybug();
    const impact = useLB
      ? await this.ladybugQM.getImpact(nodeId, maxDepth)
      : await this.queryManager.getImpact(nodeId, maxDepth);

    const lines = [
      `Impact Analysis for: ${impact.focalNode.qualifiedName}\n`,
      `Total affected nodes: ${impact.totalAffected}`,
      `Max depth reached: ${impact.maxDepthReached}`,
      '\nBreakdown by relationship:'
    ];

    for (const [edgeType, count] of Object.entries(impact.breakdown)) {
      if (count > 0) {
        lines.push(`  - ${edgeType}: ${count}`);
      }
    }

    if (impact.affectedNodes.length > 0) {
      lines.push('\nAffected nodes:');
      for (const node of impact.affectedNodes.slice(0, 20)) {
        lines.push(`  - [depth ${node.minDepth}] ${node.qualifiedName}`);
        lines.push(`    Relationships: ${node.edgeTypes.join(', ')}`);
      }
      if (impact.affectedNodes.length > 20) {
        lines.push(`  ... and ${impact.affectedNodes.length - 20} more`);
      }
    }

    return this.textResult(lines.join('\n'));
  }

  private async handleFindCodePath(args: Record<string, unknown>): Promise<ToolCallResult> {
    const fromId = await this.resolveNodeId({
      nodeId: args.fromNodeId,
      qualifiedName: args.fromQualifiedName
    });
    const toId = await this.resolveNodeId({
      nodeId: args.toNodeId,
      qualifiedName: args.toQualifiedName
    });

    if (!fromId || !toId) {
      return this.errorResult('Both source and target nodes are required');
    }

    const maxDepth = (args.maxDepth as number) || 10;
    const useLB = await this.useLadybug();
    const path = useLB
      ? await this.ladybugQM.findPath(fromId, toId, maxDepth)
      : await this.queryManager.findPath(fromId, toId, maxDepth);

    if (!path.found) {
      return this.textResult('No path found between the specified nodes.');
    }

    const lines = [`Path found (${path.depth} hops):\n`];
    for (let i = 0; i < path.path.length; i++) {
      const node = path.path[i];
      lines.push(`${i + 1}. ${node.qualifiedName}`);
      if (i < path.edges.length) {
        lines.push(`   --> [${path.edges[i]}]`);
      }
    }

    return this.textResult(lines.join('\n'));
  }

  private async handleSemanticSearch(args: Record<string, unknown>): Promise<ToolCallResult> {
    const query = args.query as string;
    if (!query) {
      return this.errorResult('Query is required');
    }

    const results = await this.semanticSearch.search(query, {
      projectId: args.projectId as number | undefined,
      nodeType: args.nodeType as string | undefined,
      limit: (args.limit as number) || 10,
      includeGraphContext: args.includeGraphContext !== false
    });

    if (results.length === 0) {
      return this.textResult('No matching code found.');
    }

    const lines = [`Found ${results.length} results:\n`];
    for (const result of results) {
      lines.push(`## ${result.qualifiedName}`);
      lines.push(`   Score: ${(result.combinedScore * 100).toFixed(1)}% (semantic: ${(result.semanticScore * 100).toFixed(1)}%, graph: ${(result.graphScore * 100).toFixed(1)}%)`);
      lines.push(`   Type: ${result.nodeType}`);
      lines.push(`   File: ${result.filePath}:${result.lineStart}`);
      if (result.signature) {
        lines.push(`   Signature: ${result.signature}`);
      }
      if (result.callerCount !== undefined) {
        lines.push(`   Callers: ${result.callerCount}, Callees: ${result.calleeCount}`);
      }
      if (result.relatedNodes && result.relatedNodes.length > 0) {
        lines.push(`   Related: ${result.relatedNodes.map(n => n.name).join(', ')}`);
      }
      lines.push('');
    }

    return this.textResult(lines.join('\n'));
  }

  private async handleFindSimilar(args: Record<string, unknown>): Promise<ToolCallResult> {
    const nodeId = await this.resolveNodeId(args);
    if (!nodeId) {
      return this.errorResult('Either nodeId or qualifiedName is required');
    }

    const results = await this.semanticSearch.findSimilar(nodeId, {
      projectId: args.projectId as number | undefined,
      limit: (args.limit as number) || 5
    });

    if (results.length === 0) {
      return this.textResult('No similar code found.');
    }

    const lines = [`Found ${results.length} similar functions:\n`];
    for (const result of results) {
      lines.push(`- ${result.qualifiedName} (${(result.semanticScore * 100).toFixed(1)}% similar)`);
      lines.push(`  File: ${result.filePath}:${result.lineStart}`);
    }

    return this.textResult(lines.join('\n'));
  }

  private async handleGetMetrics(args: Record<string, unknown>): Promise<ToolCallResult> {
    const nodeId = await this.resolveNodeId(args);
    if (!nodeId) {
      return this.errorResult('Either nodeId or qualifiedName is required');
    }

    const useLB = await this.useLadybug();
    const metrics = useLB
      ? await this.ladybugQM.getMetrics(nodeId)
      : await this.queryManager.getMetrics(nodeId);

    const lines = [
      `Graph Metrics for node: ${nodeId}\n`,
      `Incoming edges: ${metrics.incomingEdgeCount}`,
      `Outgoing edges: ${metrics.outgoingEdgeCount}`,
      `Caller count: ${metrics.callerCount}`,
      `Callee count: ${metrics.calleeCount}`,
      `Contains count: ${metrics.containsCount}`,
      `Hierarchy depth: ${metrics.depth}`
    ];

    return this.textResult(lines.join('\n'));
  }

  private async handleGetMostCalled(args: Record<string, unknown>): Promise<ToolCallResult> {
    const projectId = args.projectId as number;
    if (!projectId) {
      return this.errorResult('projectId is required');
    }

    const limit = (args.limit as number) || 10;
    const useLB = await this.useLadybug();
    const results = useLB
      ? await this.ladybugQM.getMostCalledFunctions(projectId, limit)
      : await this.queryManager.getMostCalledFunctions(projectId, limit);

    if (results.length === 0) {
      return this.textResult('No functions found in the project graph.');
    }

    const lines = [`Top ${results.length} most-called functions:\n`];
    for (let i = 0; i < results.length; i++) {
      const func = results[i];
      lines.push(`${i + 1}. ${func.qualifiedName} (${func.callerCount} callers)`);
    }

    return this.textResult(lines.join('\n'));
  }

  private async handleGetMostComplex(args: Record<string, unknown>): Promise<ToolCallResult> {
    const projectId = args.projectId as number;
    if (!projectId) {
      return this.errorResult('projectId is required');
    }

    const limit = (args.limit as number) || 10;
    const useLB = await this.useLadybug();
    const results = useLB
      ? await this.ladybugQM.getMostComplexFunctions(projectId, limit)
      : await this.queryManager.getMostComplexFunctions(projectId, limit);

    if (results.length === 0) {
      return this.textResult('No functions found in the project graph.');
    }

    const lines = [`Top ${results.length} functions with most outgoing calls:\n`];
    for (let i = 0; i < results.length; i++) {
      const func = results[i];
      lines.push(`${i + 1}. ${func.qualifiedName} (${func.calleeCount} callees)`);
    }

    return this.textResult(lines.join('\n'));
  }

  private async handleBuildGraph(args: Record<string, unknown>): Promise<ToolCallResult> {
    const projectId = args.projectId as number;
    if (!projectId) {
      return this.errorResult('projectId is required');
    }

    if (!this.indexingService) {
      return this.errorResult('Indexing service not available');
    }

    const result = await this.indexingService.rebuildGraph(projectId);

    const lines = [
      `Graph build complete for project ${projectId}`,
      `Nodes created: ${result.nodeCount}`,
      `Edges created: ${result.edgeCount}`,
      `Unresolved refs: ${result.unresolvedCount}`,
      `Duration: ${result.durationMs}ms`
    ];

    if (result.errors.length > 0) {
      lines.push('\nErrors:');
      for (const err of result.errors) {
        lines.push(`  - ${err}`);
      }
    }

    // Optionally rebuild embeddings
    if (args.rebuildEmbeddings) {
      const embedResult = await this.semanticSearch.buildProjectEmbeddings(projectId);
      lines.push(`\nEmbeddings: ${embedResult.processed} processed, ${embedResult.errors} errors`);
    }

    return this.textResult(lines.join('\n'));
  }

  private async handleBuildEmbeddings(args: Record<string, unknown>): Promise<ToolCallResult> {
    const projectId = args.projectId as number;
    if (!projectId) {
      return this.errorResult('projectId is required');
    }

    const result = await this.semanticSearch.buildProjectEmbeddings(projectId);

    return this.textResult(
      `Embeddings built for project ${projectId}\n` +
      `Processed: ${result.processed}\n` +
      `Errors: ${result.errors}`
    );
  }

  private async handleGetStats(args: Record<string, unknown>): Promise<ToolCallResult> {
    const projectId = args.projectId as number | undefined;
    const { ladybugQuery: lbq } = await import('./ladybugConnection.js');

    if (projectId) {
      const [nc, ec] = await Promise.all([
        lbq<{ c: number }>(`MATCH (n:CodeNode {project_id: ${projectId}}) RETURN count(n) AS c`),
        lbq<{ c: number }>(`MATCH (n:CodeNode {project_id: ${projectId}})-[e:CodeEdge]->() RETURN count(e) AS c`),
      ]);
      const nodeCount = Number(nc[0]?.c ?? 0);
      const edgeCount = Number(ec[0]?.c ?? 0);
      if (nodeCount === 0 && edgeCount === 0) {
        return this.textResult(`No graph data found for project ${projectId}`);
      }
      const project = await this.prisma.fantomProject.findUnique({
        where: { id: projectId },
        select: { lastIndexed: true },
      });
      return this.textResult(
        `Graph Stats for Project ${projectId}\n` +
        `Nodes: ${nodeCount}\n` +
        `Edges: ${edgeCount}\n` +
        `Last build: ${project?.lastIndexed?.toISOString() ?? 'never'}`
      );
    }

    // All projects.
    const rows = await lbq<{ pid: number; c: number }>(
      `MATCH (n:CodeNode) RETURN n.project_id AS pid, count(n) AS c ORDER BY pid`
    );
    if (rows.length === 0) {
      return this.textResult('No graph data found');
    }
    const lines = ['Graph Stats (all projects):\n'];
    let totalNodes = 0;
    for (const r of rows) {
      const c = Number(r.c);
      lines.push(`Project ${r.pid}: ${c} nodes`);
      totalNodes += c;
    }
    const edgeTotal = await lbq<{ c: number }>(
      'MATCH ()-[e:CodeEdge]->() RETURN count(e) AS c'
    );
    lines.push(`\nTotals: ${totalNodes} nodes, ${Number(edgeTotal[0]?.c ?? 0)} edges`);
    return this.textResult(lines.join('\n'));
  }

  private async handleDetectCycles(args: Record<string, unknown>): Promise<ToolCallResult> {
    const projectId = args.projectId as number;
    if (!projectId) {
      return this.errorResult('projectId is required');
    }

    const maxCycles = (args.maxCycles as number) || 10;
    const useLB = await this.useLadybug();
    const cycles = useLB
      ? await this.ladybugQM.detectCycles(projectId, maxCycles)
      : await this.queryManager.detectCycles(projectId, maxCycles);

    if (cycles.length === 0) {
      return this.textResult('No circular dependencies detected in this project. ✓');
    }

    const lines = [`Found ${cycles.length} circular dependencies:\n`];
    for (let i = 0; i < cycles.length; i++) {
      const cycle = cycles[i];
      lines.push(`Cycle ${i + 1} (${cycle.length} nodes):`);
      for (let j = 0; j < cycle.nodeNames.length; j++) {
        const nodeName = cycle.nodeNames[j];
        const arrow = j < cycle.nodeNames.length - 1 ? ' →' : ' → [back to start]';
        lines.push(`  ${j + 1}. ${nodeName}${arrow}`);
      }
      lines.push('');
    }

    lines.push('Recommendation: Review these cycles for potential refactoring to reduce coupling.');

    return this.textResult(lines.join('\n'));
  }

  private async handleQueryGraph(args: Record<string, unknown>): Promise<ToolCallResult> {
    const queryText = args.query as string;
    if (!queryText) {
      return this.errorResult('query is required');
    }

    try {
      // Parse the DSL query
      const query = this.dslParser.parse(queryText);

      // Apply project filter if provided separately
      if (args.projectId && !query.projectId) {
        query.projectId = args.projectId as number;
      }

      // Execute the query
      const result = await this.queryExecutor.execute(query);

      if (!result.success) {
        return this.errorResult(result.error || 'Query execution failed');
      }

      if (result.results.length === 0) {
        return this.textResult(`No results found for query: ${queryText}`);
      }

      const lines = [
        `Query: ${queryText}`,
        `Results: ${result.totalCount} (showing ${result.results.length})`,
        `Execution time: ${result.executionTimeMs}ms\n`
      ];

      for (const node of result.results) {
        lines.push(`- ${node.qualifiedName || node.name}`);
        lines.push(`  Type: ${node.nodeType}, File: ${node.filePath}:${node.lineStart}`);
        if (node.depth !== undefined) {
          lines.push(`  Depth: ${node.depth}${node.edgeType ? `, Edge: ${node.edgeType}` : ''}`);
        }
      }

      return this.textResult(lines.join('\n'));
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      return this.errorResult(`Query parse error: ${errMsg}`);
    }
  }

  private async handleFindConstrainedPath(args: Record<string, unknown>): Promise<ToolCallResult> {
    const from = args.from as string;
    const to = args.to as string;

    if (!from || !to) {
      return this.errorResult('Both from and to are required');
    }

    const maxDepth = (args.maxDepth as number) || 15;
    const edgeTypes = (args.edgeTypes as string[]) || ['calls'];
    const mustPass = (args.mustPass as string[]) || [];
    const mustAvoid = (args.mustAvoid as string[]) || [];

    // Resolve from and to node IDs
    const useLBResolve = await this.useLadybug();
    const fromNode = useLBResolve
      ? await this.ladybugQM.getNodeByQualifiedName(from)
      : await this.queryManager.getNodeByQualifiedName(from);
    const toNode = useLBResolve
      ? await this.ladybugQM.getNodeByQualifiedName(to)
      : await this.queryManager.getNodeByQualifiedName(to);

    if (!fromNode) {
      return this.errorResult(`Source node not found: ${from}`);
    }
    if (!toNode) {
      return this.errorResult(`Target node not found: ${to}`);
    }

    // Note: edgeTypes filtering would require dynamic SQL which is complex with Prisma
    // For now, we filter edges in post-processing if needed
    void edgeTypes; // Mark as intentionally unused for now

    // Find paths with constraints
    let results: Array<{ path: string; edges: string; depth: number }>;
    const useLBPathFind = await this.useLadybug();
    if (useLBPathFind) {
      // Use LadybugDB Cypher variable-length path
      const pathResult = await this.ladybugQM.findPath(fromNode.id, toNode.id, maxDepth);
      if (pathResult.found) {
        results = [{
          path: pathResult.path.map(n => n.id).join(','),
          edges: pathResult.edges.join(','),
          depth: pathResult.depth
        }];
      } else {
        results = [];
      }
    } else {
      results = await this.prisma.$queryRaw<Array<{
        path: string;
        edges: string;
        depth: number;
      }>>`
        WITH RECURSIVE paths AS (
          SELECT
            ${fromNode.id} as current_id,
            ${fromNode.id} as path,
            '' as edges,
            0 as depth
          UNION ALL
          SELECT
            e.target_id,
            p.path || ',' || e.target_id,
            CASE WHEN p.edges = '' THEN e.edge_type ELSE p.edges || ',' || e.edge_type END,
            p.depth + 1
          FROM paths p
          INNER JOIN code_edges e ON e.source_id = p.current_id
          WHERE p.depth < ${maxDepth}
            AND INSTR(p.path, e.target_id) = 0
        )
        SELECT path, edges, depth
        FROM paths
        WHERE current_id = ${toNode.id}
        ORDER BY depth ASC
        LIMIT 10
      `;
    }

    if (results.length === 0) {
      return this.textResult(`No path found from ${from} to ${to}`);
    }

    // Filter paths by constraints
    let validPaths = results;

    if (mustPass.length > 0 || mustAvoid.length > 0) {
      // Get node IDs for constraint nodes
      const allConstraints = [...mustPass, ...mustAvoid];
      // Search by qualified-name pattern in LadybugDB (authoritative).
      const patternResults = await Promise.all(
        allConstraints.map(c => this.ladybugQM.findNodesByPattern(c, undefined, 5))
      );
      const constraintNodes: Array<{ id: string; name: string; qualifiedName: string }> =
        patternResults.flat().map(r => ({ id: r.id, name: r.name, qualifiedName: r.qualifiedName }));

      const mustPassIds = new Set(
        constraintNodes
          .filter(n => mustPass.includes(n.qualifiedName) || mustPass.includes(n.name))
          .map(n => n.id)
      );
      const mustAvoidIds = new Set(
        constraintNodes
          .filter(n => mustAvoid.includes(n.qualifiedName) || mustAvoid.includes(n.name))
          .map(n => n.id)
      );

      validPaths = results.filter(result => {
        const pathIds = result.path.split(',');

        // Check mustPass
        for (const id of mustPassIds) {
          if (!pathIds.includes(id)) return false;
        }

        // Check mustAvoid
        for (const id of mustAvoidIds) {
          if (pathIds.includes(id)) return false;
        }

        return true;
      });
    }

    if (validPaths.length === 0) {
      return this.textResult(`No path found that satisfies all constraints`);
    }

    // Get node details for the best path
    const bestPath = validPaths[0];
    const pathIds = bestPath.path.split(',');

    // Ladybug-authoritative node enrichment for the chosen path.
    const nodes: Array<{ id: string; name: string; qualifiedName: string; filePath: string; lineStart: number }> =
      await this.ladybugQM.findNodesByIds(pathIds);

    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const edges = bestPath.edges ? bestPath.edges.split(',') : [];

    const lines = [
      `Path found from ${from} to ${to}`,
      `Length: ${bestPath.depth} hops`,
      `Paths found: ${validPaths.length}\n`
    ];

    for (let i = 0; i < pathIds.length; i++) {
      const node = nodeMap.get(pathIds[i]);
      if (node) {
        lines.push(`${i + 1}. ${node.qualifiedName}`);
        lines.push(`   ${node.filePath}:${node.lineStart}`);
        if (i < edges.length) {
          lines.push(`   --> [${edges[i]}]`);
        }
      }
    }

    return this.textResult(lines.join('\n'));
  }

  private async handleGetSCC(args: Record<string, unknown>): Promise<ToolCallResult> {
    const projectId = args.projectId as number;
    if (!projectId) {
      return this.errorResult('projectId is required');
    }

    const minSize = (args.minSize as number) || 2;
    const useLB = await this.useLadybug();
    const sccs = useLB
      ? await this.ladybugQM.getStronglyConnectedComponents(projectId, minSize)
      : await this.queryManager.getStronglyConnectedComponents(projectId, minSize);

    if (sccs.length === 0) {
      return this.textResult('No strongly connected components found (no circular dependencies detected). ✓');
    }

    const lines = [`Found ${sccs.length} strongly connected components:\n`];
    for (const scc of sccs) {
      lines.push(`Component #${scc.id} (${scc.size} nodes):`);
      for (const node of scc.nodes.slice(0, 10)) {
        lines.push(`  - ${node.qualifiedName}`);
      }
      if (scc.nodes.length > 10) {
        lines.push(`  ... and ${scc.nodes.length - 10} more`);
      }
      lines.push('');
    }

    lines.push('These components contain mutually recursive or cyclically dependent code.');
    return this.textResult(lines.join('\n'));
  }

  private async handleGetPageRank(args: Record<string, unknown>): Promise<ToolCallResult> {
    const projectId = args.projectId as number;
    if (!projectId) {
      return this.errorResult('projectId is required');
    }

    const iterations = (args.iterations as number) || 20;
    const limit = (args.limit as number) || 20;

    const useLB = await this.useLadybug();
    const results = useLB
      ? await this.ladybugQM.getPageRank(projectId, iterations, 0.85, limit)
      : await this.queryManager.getPageRank(projectId, iterations, 0.85, limit);

    if (results.length === 0) {
      return this.textResult('No nodes found in the project graph.');
    }

    const lines = [`Top ${results.length} functions by PageRank:\n`];
    const maxRank = results[0].pageRank;

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const normalizedScore = ((r.pageRank / maxRank) * 100).toFixed(1);
      lines.push(`${i + 1}. ${r.qualifiedName}`);
      lines.push(`   Score: ${normalizedScore}% (raw: ${r.pageRank.toFixed(6)})`);
    }

    lines.push('\nHigher PageRank indicates more "important" functions - called by other important functions.');
    return this.textResult(lines.join('\n'));
  }

  private async handleGetCentrality(args: Record<string, unknown>): Promise<ToolCallResult> {
    const projectId = args.projectId as number;
    if (!projectId) {
      return this.errorResult('projectId is required');
    }

    const limit = (args.limit as number) || 20;

    const useLB = await this.useLadybug();
    const results = useLB
      ? await this.ladybugQM.getBetweennessCentrality(projectId, 100, limit)
      : await this.queryManager.getBetweennessCentrality(projectId, 100, limit);

    if (results.length === 0) {
      return this.textResult('No nodes found in the project graph.');
    }

    const lines = [`Top ${results.length} functions by Betweenness Centrality:\n`];
    const maxCentrality = results[0].centrality || 1;

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const normalizedScore = ((r.centrality / maxCentrality) * 100).toFixed(1);
      lines.push(`${i + 1}. ${r.qualifiedName}`);
      lines.push(`   Centrality: ${normalizedScore}% (raw: ${r.centrality.toFixed(2)})`);
    }

    lines.push('\nHigh centrality = bottleneck/bridge function connecting different code areas.');
    return this.textResult(lines.join('\n'));
  }

  private async handleExportVisualization(args: Record<string, unknown>): Promise<ToolCallResult> {
    const graphType = (args.graphType as string) || 'subgraph';
    const format = (args.format as string) || 'dot';
    const depth = (args.depth as number) || 3;
    const maxNodes = (args.maxNodes as number) || 100;
    const layout = (args.layout as string) || 'hierarchical';
    const title = args.title as string | undefined;

    const exportOptions = {
      format: format as 'dot' | 'json' | 'd3' | 'cytoscape',
      maxNodes,
      layout: layout as 'hierarchical' | 'force' | 'radial' | 'circular',
      title
    };

    let result: string;

    if (graphType === 'project') {
      const projectId = args.projectId as number;
      if (!projectId) {
        return this.errorResult('projectId is required for project graph export');
      }
      result = await this.visualization.exportProjectGraph(projectId, exportOptions);
    } else {
      // Need a focal node for other graph types
      const nodeId = await this.resolveNodeId(args);
      if (!nodeId) {
        return this.errorResult('Either nodeId or qualifiedName is required');
      }

      switch (graphType) {
        case 'callers':
          result = await this.visualization.exportCallerGraph(nodeId, depth, exportOptions);
          break;
        case 'callees':
          result = await this.visualization.exportCalleeGraph(nodeId, depth, exportOptions);
          break;
        case 'impact':
          result = await this.visualization.exportImpactGraph(nodeId, depth, exportOptions);
          break;
        case 'subgraph':
        default:
          result = await this.visualization.exportSubgraph(nodeId, depth, exportOptions);
          break;
      }
    }

    // For DOT format, include helpful usage info
    if (format === 'dot') {
      const header = [
        `// Graph exported in DOT format`,
        `// To render: dot -Tsvg graph.dot -o graph.svg`,
        `// Or: dot -Tpng graph.dot -o graph.png`,
        `// Online viewer: https://dreampuf.github.io/GraphvizOnline/`,
        ``
      ].join('\n');
      result = header + result;
    }

    return this.textResult(result);
  }

  // ============================================
  // Helper Methods
  // ============================================

  /**
   * Resolve node ID from either nodeId or qualifiedName
   */
  private async resolveNodeId(args: Record<string, unknown>): Promise<string | null> {
    if (args.nodeId) {
      return args.nodeId as string;
    }

    if (args.qualifiedName) {
      const useLB = await this.useLadybug();
      if (useLB) {
        const node = await this.ladybugQM.getNodeByQualifiedName(
          args.qualifiedName as string,
          args.projectId as number | undefined
        );
        return node?.id || null;
      }
      const node = await this.queryManager.getNodeByQualifiedName(
        args.qualifiedName as string,
        args.projectId as number | undefined
      );
      return node?.id || null;
    }

    return null;
  }

  private async handleListCommunities(args: Record<string, unknown>): Promise<ToolCallResult> {
    const projectId = args.projectId as number;
    if (!projectId) {
      return this.errorResult('projectId is required');
    }

    const useLB = await this.useLadybug();
    if (!useLB) {
      return this.errorResult('Community detection requires LadybugDB to be initialized. Run a graph build first.');
    }

    const resolution = (args.resolution as number) || 1.0;
    const minSize = (args.minSize as number) || 2;
    const refresh = args.refresh as boolean;

    if (refresh) {
      clearCommunityCache(projectId);
    }

    const result = await getOrDetectCommunities(projectId, {
      resolution,
      minCommunitySize: minSize
    });

    if (result.communityCount === 0) {
      return this.textResult('No communities detected. The project may have too few nodes or no inter-node edges.');
    }

    const lines = [
      `Community Detection Results (Louvain, resolution=${resolution}):`,
      `Modularity: ${result.modularity.toFixed(3)}`,
      `Communities found: ${result.communityCount}`,
      `Duration: ${result.durationMs}ms\n`
    ];

    for (const community of result.communities.slice(0, 20)) {
      lines.push(`Community #${community.id} (${community.size} members):`);
      for (const node of community.nodes.slice(0, 10)) {
        lines.push(`  - [${node.nodeType}] ${node.qualifiedName}`);
      }
      if (community.nodes.length > 10) {
        lines.push(`  ... and ${community.nodes.length - 10} more`);
      }
      lines.push('');
    }

    if (result.communities.length > 20) {
      lines.push(`... and ${result.communities.length - 20} more communities`);
    }

    return this.textResult(lines.join('\n'));
  }

  private async handleGetProcessFlow(args: Record<string, unknown>): Promise<ToolCallResult> {
    const projectId = args.projectId as number;
    if (!projectId) {
      return this.errorResult('projectId is required');
    }

    const useLB = await this.useLadybug();
    if (!useLB) {
      return this.errorResult('Process flow tracing requires LadybugDB to be initialized.');
    }

    const maxDepth = (args.maxDepth as number) || 10;
    const minSteps = (args.minSteps as number) || 3;
    const refresh = args.refresh as boolean;

    if (refresh) {
      clearProcessCache(projectId);
    }

    const result = await getOrTraceProcessFlows(projectId, { maxDepth, minSteps });

    if (result.processCount === 0) {
      return this.textResult('No execution flows detected. The project may lack recognizable entry points.');
    }

    const lines = [
      `Process Flow Tracing Results:`,
      `Entry points discovered: ${result.entryPointCount}`,
      `Execution flows found: ${result.processCount}`,
      `Duration: ${result.durationMs}ms\n`
    ];

    for (const proc of result.processes.slice(0, 15)) {
      lines.push(`Flow #${proc.id}: ${proc.name} (${proc.stepCount} steps, ${proc.flowType})`);
      for (const step of proc.steps) {
        lines.push(`  ${step.stepIndex + 1}. [${step.nodeType}] ${step.qualifiedName}`);
      }
      lines.push('');
    }

    if (result.processes.length > 15) {
      lines.push(`... and ${result.processes.length - 15} more flows`);
    }

    return this.textResult(lines.join('\n'));
  }

  private async handleFindProcessesForFunction(args: Record<string, unknown>): Promise<ToolCallResult> {
    const projectId = args.projectId as number;
    if (!projectId) {
      return this.errorResult('projectId is required');
    }

    const useLB = await this.useLadybug();
    if (!useLB) {
      return this.errorResult('Process flow lookup requires LadybugDB to be initialized.');
    }

    const nodeId = await this.resolveNodeId(args);
    if (!nodeId) {
      return this.errorResult('Either nodeId or qualifiedName is required');
    }

    const result = await getOrTraceProcessFlows(projectId);
    const matches = findProcessesForFunction(result, nodeId);

    if (matches.length === 0) {
      return this.textResult('This function does not appear in any traced execution flow.');
    }

    const lines = [`Function appears in ${matches.length} execution flow(s):\n`];
    for (const proc of matches.slice(0, 20)) {
      const stepIdx = proc.steps.findIndex(s => s.nodeId === nodeId);
      lines.push(`Flow #${proc.id}: ${proc.name} (step ${stepIdx + 1} of ${proc.stepCount})`);
      // Show context: step before, target, step after
      for (const step of proc.steps) {
        const marker = step.nodeId === nodeId ? '>>>' : '   ';
        lines.push(`  ${marker} ${step.stepIndex + 1}. ${step.qualifiedName}`);
      }
      lines.push('');
    }

    return this.textResult(lines.join('\n'));
  }

  private async handleDetectChanges(args: Record<string, unknown>): Promise<ToolCallResult> {
    const projectId = args.projectId as number;
    if (!projectId) {
      return this.errorResult('projectId is required');
    }

    const useLB = await this.useLadybug();
    if (!useLB) {
      return this.errorResult('Change detection requires LadybugDB to be initialized.');
    }

    const projectPath = (args.projectPath as string) || process.cwd();
    const scope = (args.scope as 'staged' | 'unstaged' | 'head' | 'branch' | 'commit') || 'head';
    const ref = args.ref as string | undefined;

    const result = await assessChangeImpact(projectPath, projectId, scope, ref);

    const lines = [
      `Change Impact Analysis (scope: ${scope}):`,
      result.summary,
      ''
    ];

    if (result.changes.length > 0) {
      lines.push(`Changed files (${result.changes.length}):`);
      for (const change of result.changes.slice(0, 15)) {
        lines.push(`  [${change.status}] ${change.filePath} (${change.lineRanges.length} hunks)`);
      }
      if (result.changes.length > 15) {
        lines.push(`  ... and ${result.changes.length - 15} more`);
      }
      lines.push('');
    }

    if (result.affectedSymbols.length > 0) {
      lines.push(`Affected symbols (${result.affectedSymbols.length}):`);
      for (const sym of result.affectedSymbols.slice(0, 20)) {
        lines.push(`  [${sym.changeType}] ${sym.qualifiedName} (${sym.nodeType})`);
        lines.push(`    ${sym.filePath}:${sym.lineStart}`);
      }
      if (result.affectedSymbols.length > 20) {
        lines.push(`  ... and ${result.affectedSymbols.length - 20} more`);
      }
      lines.push('');
    }

    if (result.impact) {
      lines.push(`Downstream impact: ${result.impact.totalAffected} node(s)`);
      for (const [edgeType, count] of Object.entries(result.impact.breakdown)) {
        if (count > 0) lines.push(`  - ${edgeType}: ${count}`);
      }
      lines.push('');
    }

    if (result.processesAffected > 0) {
      lines.push(`Execution flows affected: ${result.processesAffected}`);
    }

    lines.push(`\nRisk: ${result.riskLevel.toUpperCase()} (${result.riskScore}/100)`);

    return this.textResult(lines.join('\n'));
  }

  private async handleCheckStaleness(args: Record<string, unknown>): Promise<ToolCallResult> {
    const projectId = args.projectId as number;
    if (!projectId) {
      return this.errorResult('projectId is required');
    }

    const projectPath = args.projectPath as string | undefined;
    const result = await checkStaleness(this.prisma, projectId, projectPath);

    const lines = [
      `Graph Staleness Check for Project ${projectId}:`,
      `Status: ${result.status.toUpperCase()}`,
    ];

    if (result.lastBuildAt) {
      lines.push(`Last build: ${result.lastBuildAt.toISOString()}`);
    }
    if (result.latestCommitAt) {
      lines.push(`Latest commit: ${result.latestCommitAt.toISOString()}`);
    }
    if (result.staleSinceSeconds != null && result.staleSinceSeconds > 0) {
      const hours = Math.floor(result.staleSinceSeconds / 3600);
      const mins = Math.floor((result.staleSinceSeconds % 3600) / 60);
      lines.push(`Stale for: ${hours}h ${mins}m`);
    }
    if (result.changedFileCount > 0) {
      lines.push(`\nChanged files (${result.changedFileCount}):`);
      for (const f of result.changedFiles.slice(0, 20)) {
        lines.push(`  - ${f}`);
      }
      if (result.changedFileCount > 20) {
        lines.push(`  ... and ${result.changedFileCount - 20} more`);
      }
    }

    if (result.status === 'stale') {
      lines.push('\nRecommendation: Run buildProjectGraph to update the index.');
    }

    return this.textResult(lines.join('\n'));
  }

  // ============================================
  // AST Viewer Handlers
  // ============================================

  private async handleGetProjectFunctions(args: Record<string, unknown>): Promise<ToolCallResult> {
    const projectId = args.projectId as number;
    if (!projectId) return this.errorResult('projectId is required');

    const nodeTypes = args.nodeTypes
      ? (args.nodeTypes as string).split(',').map(s => s.trim())
      : ['method', 'field', 'constructor', 'function'];

    const functions = await this.ladybugQM.getNodesByProject(projectId, nodeTypes);

    if (functions.length === 0) {
      return this.textResult(`No functions found for project ${projectId}. Ensure the project has been indexed with buildProjectGraph.`);
    }

    // Group by parent type
    const byClass: Record<string, typeof functions> = {};
    const standalone: typeof functions = [];
    for (const f of functions) {
      if (f.parentType) {
        if (!byClass[f.parentType]) byClass[f.parentType] = [];
        byClass[f.parentType].push(f);
      } else {
        standalone.push(f);
      }
    }

    const lines: string[] = [
      `Project ${projectId}: ${functions.length} functions/fields across ${Object.keys(byClass).length} classes`,
      ''
    ];

    for (const [className, members] of Object.entries(byClass)) {
      lines.push(`## ${className} (${members.length} members)`);
      for (const m of members) {
        const vis = m.isPublic ? 'public' : 'private';
        const mods = [m.isStatic ? 'static' : '', m.isAbstract ? 'abstract' : ''].filter(Boolean).join(' ');
        lines.push(`  ${m.nodeType} ${vis}${mods ? ' ' + mods : ''} ${m.name}${m.signature ? ': ' + m.signature : ''}`);
        lines.push(`    file: ${m.filePath}:${m.lineStart}  id: ${m.id}`);
      }
      lines.push('');
    }

    if (standalone.length > 0) {
      lines.push(`## Standalone functions (${standalone.length})`);
      for (const f of standalone) {
        lines.push(`  ${f.nodeType} ${f.name}${f.signature ? ': ' + f.signature : ''}`);
        lines.push(`    file: ${f.filePath}:${f.lineStart}  id: ${f.id}`);
      }
    }

    return this.textResult(lines.join('\n'));
  }

  private async handleGetProjectTypes(args: Record<string, unknown>): Promise<ToolCallResult> {
    const projectId = args.projectId as number;
    if (!projectId) return this.errorResult('projectId is required');

    const [types, relationships] = await Promise.all([
      this.ladybugQM.getTypesByProject(projectId),
      this.ladybugQM.getTypeRelationships(projectId),
    ]);

    if (types.length === 0) {
      return this.textResult(`No types found for project ${projectId}. Ensure the project has been indexed with buildProjectGraph.`);
    }

    // Build relationship maps
    const extendsMap = new Map<string, string[]>();
    const implementsMap = new Map<string, string[]>();
    for (const rel of relationships) {
      const map = rel.edgeType === 'extends' ? extendsMap : implementsMap;
      if (!map.has(rel.sourceId)) map.set(rel.sourceId, []);
      map.get(rel.sourceId)!.push(rel.targetName);
    }

    const lines: string[] = [
      `Project ${projectId}: ${types.length} types`,
      ''
    ];

    for (const t of types) {
      const ext = extendsMap.get(t.id);
      const impl = implementsMap.get(t.id);
      const vis = t.isPublic ? 'public' : 'private';
      const abs = t.isAbstract ? ' abstract' : '';
      let line = `${t.nodeType}${abs} ${vis} ${t.name}`;
      if (ext?.length) line += ` extends ${ext.join(', ')}`;
      if (impl?.length) line += ` implements ${impl.join(', ')}`;
      lines.push(line);
      lines.push(`  file: ${t.filePath}:${t.lineStart}  id: ${t.id}  lang: ${t.language || 'unknown'}`);
      if (t.documentation) {
        lines.push(`  doc: ${t.documentation.substring(0, 100)}${t.documentation.length > 100 ? '...' : ''}`);
      }
    }

    return this.textResult(lines.join('\n'));
  }

  private textResult(text: string): ToolCallResult {
    return {
      content: [{ type: 'text', text }]
    };
  }

  private errorResult(message: string): ToolCallResult {
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true
    };
  }
}

// ============================================
// Factory Function
// ============================================

let handlerInstance: GraphToolHandler | null = null;

/**
 * Get or create the graph tool handler
 */
export function getGraphToolHandler(context: GraphToolHandlerContext): GraphToolHandler {
  if (!handlerInstance) {
    handlerInstance = new GraphToolHandler(context);
  }
  return handlerInstance;
}

/**
 * Reset the handler (for testing)
 */
export function resetGraphToolHandler(): void {
  handlerInstance = null;
}
