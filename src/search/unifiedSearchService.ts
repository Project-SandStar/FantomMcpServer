/**
 * Unified Search Service
 *
 * Combines all search capabilities into a single interface:
 * - Text Search: FlexSearch (hot) + FTS5 (cold)
 * - Graph Search: Call graph traversal and analysis
 * - Semantic Search: AI embeddings for concept matching
 *
 * Provides automatic mode selection based on query analysis.
 */

import type { PrismaClient } from '@prisma/client';
import { createLogger } from '../utils/index.js';
import {
  HybridSearchService,
  getHybridSearchService
} from './hybridSearchService.js';
import {
  SemanticSearchService,
  getSemanticSearchService
} from '../embedding/semanticSearchService.js';
import {
  LadybugQueryManager,
  getLadybugQueryManager,
  type CallerResult,
  type ImpactResult
} from '../graph/index.js';
import { analyzeQuery } from './hybridSearch.js';

const logger = createLogger('unified-search');

// ============================================
// Types
// ============================================

export type SearchMode = 'auto' | 'text' | 'semantic' | 'graph' | 'all';

export interface UnifiedSearchOptions {
  /** Search mode: auto detects from query, or force specific mode */
  mode?: SearchMode;
  /** Maximum results per mode */
  limit?: number;
  /** Project ID filter */
  projectId?: number;
  /** Node type filter (type, method, field, constructor) */
  nodeType?: string;
  /** Minimum score threshold (0-1) */
  minScore?: number;
  /** Include graph context in results */
  includeGraph?: boolean;
  /** Include semantic similarity in results */
  includeSemantic?: boolean;
}

export interface UnifiedSearchResult {
  /** Unique ID of the result */
  id: string;
  /** Display name */
  name: string;
  /** Fully qualified name */
  qualifiedName: string;
  /** Type of code element */
  nodeType: string;
  /** File location */
  filePath: string;
  /** Line number */
  lineStart: number;
  /** Function signature if applicable */
  signature?: string;
  /** Documentation excerpt */
  documentation?: string;

  // Scores from different sources
  /** Text search score (0-1) */
  textScore?: number;
  /** Semantic similarity score (0-1) */
  semanticScore?: number;
  /** Graph importance score (0-1) */
  graphScore?: number;
  /** Combined score (0-1) */
  combinedScore: number;

  // Source tracking
  /** Which search modes found this result */
  sources: SearchMode[];

  // Graph context
  /** Number of callers (graph popularity) */
  callerCount?: number;
  /** Related code elements */
  relatedNodes?: Array<{
    id: string;
    name: string;
    relationship: string;
  }>;
}

export interface ModeResults {
  text?: UnifiedSearchResult[];
  semantic?: UnifiedSearchResult[];
  graph?: UnifiedSearchResult[];
}

// ============================================
// Query Mode Detection
// ============================================

/**
 * Detect the best search mode(s) for a query
 */
export function detectSearchMode(query: string): SearchMode[] {
  const analysis = analyzeQuery(query);
  const modes: SearchMode[] = [];

  // Simple queries: text search first
  if (analysis.complexity <= 3) {
    modes.push('text');
  }

  // Natural language queries: semantic search
  if (
    query.split(' ').length >= 3 &&
    !analysis.hasOperators &&
    !analysis.hasWildcards &&
    !/^[A-Z][a-z]+/.test(query)  // Not a type name
  ) {
    modes.push('semantic');
  }

  // Questions about relationships: graph search
  if (
    /\b(call|calls|uses|extends|implements|related|depends)\b/i.test(query) ||
    /\b(who|what|where|which)\b/i.test(query)
  ) {
    modes.push('graph');
  }

  // Complex queries: use all modes
  if (analysis.complexity > 5 || modes.length === 0) {
    return ['text', 'semantic'];
  }

  return modes.length > 0 ? modes : ['text'];
}

// ============================================
// Unified Search Service
// ============================================

export class UnifiedSearchService {
  private hybridSearch: HybridSearchService;
  private semanticSearch: SemanticSearchService;
  private graphQuery: LadybugQueryManager;

  // Score weights for combining results
  private weights = {
    text: 0.4,
    semantic: 0.4,
    graph: 0.2
  };

  constructor(prisma: PrismaClient) {
    this.hybridSearch = getHybridSearchService(prisma);
    this.semanticSearch = getSemanticSearchService(prisma);
    this.graphQuery = getLadybugQueryManager();
  }

  /**
   * Set the FlexSearch instance (for deferred initialization)
   */
  setFlexSearch(flexSearch: any): void {
    this.hybridSearch.setFlexSearch(flexSearch);
  }

  /**
   * Unified search across all modes
   */
  async search(
    query: string,
    options: UnifiedSearchOptions = {}
  ): Promise<UnifiedSearchResult[]> {
    const {
      mode = 'auto',
      limit = 20,
      projectId,
      nodeType,
      minScore = 0.3,
      includeGraph = true,
      includeSemantic = true
    } = options;

    logger.debug(`Unified search: "${query}" mode=${mode}`);

    // Determine which modes to use
    const modes = mode === 'auto' ? detectSearchMode(query) : [mode];

    if (mode === 'all') {
      modes.length = 0;
      modes.push('text', 'semantic', 'graph');
    }

    // Execute searches in parallel
    const [textResults, semanticResults] = await Promise.all([
      modes.includes('text')
        ? this.textSearch(query, { limit, projectId, nodeType })
        : Promise.resolve([]),
      modes.includes('semantic') && includeSemantic
        ? this.semanticSearchResults(query, { limit, projectId, nodeType })
        : Promise.resolve([])
    ]);

    // Merge results
    const merged = this.mergeResults(textResults, semanticResults, {
      limit,
      minScore,
      includeGraph
    });

    return merged;
  }

  /**
   * Text-based search (FlexSearch + FTS5)
   */
  async textSearch(
    query: string,
    options: { limit?: number; projectId?: number; nodeType?: string }
  ): Promise<UnifiedSearchResult[]> {
    const results = await this.hybridSearch.searchCodeNodes(query, {
      limit: options.limit || 20,
      projectId: options.projectId
    });

    return results.map(r => ({
      id: r.item.id,
      name: r.item.name,
      qualifiedName: r.item.qualifiedName,
      nodeType: r.item.nodeType,
      filePath: r.item.filePath,
      lineStart: r.item.lineStart,
      signature: r.item.signature || undefined,
      documentation: r.item.documentation || undefined,
      textScore: r.score,
      combinedScore: r.score,
      sources: ['text'] as SearchMode[]
    }));
  }

  /**
   * Semantic search using AI embeddings
   */
  async semanticSearchResults(
    query: string,
    options: { limit?: number; projectId?: number; nodeType?: string }
  ): Promise<UnifiedSearchResult[]> {
    try {
      const results = await this.semanticSearch.search(query, {
        limit: options.limit || 20,
        projectId: options.projectId,
        nodeType: options.nodeType,
        includeGraphContext: true
      });

      return results.map(r => ({
        id: r.nodeId,
        name: r.name,
        qualifiedName: r.qualifiedName,
        nodeType: r.nodeType,
        filePath: r.filePath,
        lineStart: r.lineStart,
        signature: r.signature,
        documentation: r.documentation,
        semanticScore: r.semanticScore,
        graphScore: r.graphScore,
        combinedScore: r.combinedScore,
        sources: ['semantic'] as SearchMode[],
        callerCount: r.callerCount,
        relatedNodes: r.relatedNodes
      }));
    } catch (error) {
      logger.warn(`Semantic search failed: ${error}`);
      return [];
    }
  }

  /**
   * Get callers using graph search
   */
  async getCallers(
    nodeIdOrName: string,
    options: { maxDepth?: number; projectId?: number }
  ): Promise<CallerResult[]> {
    // Try to resolve as ID first, then as qualified name
    let nodeId = nodeIdOrName;

    if (!nodeIdOrName.match(/^[0-9a-f-]{36}$/i)) {
      const node = await this.graphQuery.getNodeByQualifiedName(
        nodeIdOrName,
        options.projectId
      );
      if (!node) {
        return [];
      }
      nodeId = node.id;
    }

    return this.graphQuery.getCallers(nodeId, options.maxDepth || 5);
  }

  /**
   * Get impact analysis using graph search
   */
  async getImpact(
    nodeIdOrName: string,
    options: { maxDepth?: number; projectId?: number }
  ): Promise<ImpactResult | null> {
    let nodeId = nodeIdOrName;

    if (!nodeIdOrName.match(/^[0-9a-f-]{36}$/i)) {
      const node = await this.graphQuery.getNodeByQualifiedName(
        nodeIdOrName,
        options.projectId
      );
      if (!node) {
        return null;
      }
      nodeId = node.id;
    }

    return this.graphQuery.getImpact(nodeId, options.maxDepth || 10);
  }

  /**
   * Merge results from different search modes
   */
  private mergeResults(
    textResults: UnifiedSearchResult[],
    semanticResults: UnifiedSearchResult[],
    options: { limit: number; minScore: number; includeGraph: boolean }
  ): UnifiedSearchResult[] {
    const resultMap = new Map<string, UnifiedSearchResult>();

    // Add text results
    for (const r of textResults) {
      resultMap.set(r.id, {
        ...r,
        combinedScore: r.textScore! * this.weights.text
      });
    }

    // Merge semantic results
    for (const r of semanticResults) {
      const existing = resultMap.get(r.id);
      if (existing) {
        // Combine scores
        existing.semanticScore = r.semanticScore;
        existing.graphScore = r.graphScore;
        existing.callerCount = r.callerCount;
        existing.relatedNodes = r.relatedNodes;
        existing.sources.push('semantic');
        existing.combinedScore =
          (existing.textScore || 0) * this.weights.text +
          (r.semanticScore || 0) * this.weights.semantic +
          (r.graphScore || 0) * this.weights.graph;
      } else {
        resultMap.set(r.id, {
          ...r,
          combinedScore:
            (r.semanticScore || 0) * this.weights.semantic +
            (r.graphScore || 0) * this.weights.graph
        });
      }
    }

    // Sort by combined score and filter
    const merged = Array.from(resultMap.values())
      .filter(r => r.combinedScore >= options.minScore)
      .sort((a, b) => b.combinedScore - a.combinedScore)
      .slice(0, options.limit);

    return merged;
  }

  /**
   * Get search statistics
   */
  getStats(): {
    hybrid: ReturnType<typeof HybridSearchService.prototype.getStats>;
  } {
    return {
      hybrid: this.hybridSearch.getStats()
    };
  }
}

// ============================================
// Factory Function
// ============================================

let serviceInstance: UnifiedSearchService | null = null;

/**
 * Get or create the unified search service
 */
export function getUnifiedSearchService(prisma: PrismaClient): UnifiedSearchService {
  if (!serviceInstance) {
    serviceInstance = new UnifiedSearchService(prisma);
  }
  return serviceInstance;
}

/**
 * Reset the service (for testing)
 */
export function resetUnifiedSearchService(): void {
  serviceInstance = null;
}
