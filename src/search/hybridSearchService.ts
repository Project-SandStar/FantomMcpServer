/**
 * Hybrid Search Service
 *
 * Combines FlexSearch (hot/in-memory) with FTS5 (cold/disk) for optimal search.
 * Routes queries to the appropriate backend based on query analysis and history.
 */

import type { PrismaClient } from '@prisma/client';
import { createLogger } from '../utils/index.js';
import {
  QueryRouter,
  analyzeQuery,
  mergeResults,
  type SearchBackend,
  type HybridSearchOptions,
  type HybridSearchResult
} from './hybridSearch.js';
import {
  FTS5SearchAdapter,
  getFTS5SearchAdapter,
  type CodeNodeSearchResult
} from './fts5Search.js';

const logger = createLogger('hybrid-search-service');

// ============================================
// Types
// ============================================

export interface HybridSearchServiceOptions {
  /** FlexSearch instance for in-memory search */
  flexSearch?: any;  // FantomFunctionSearchIndex type
  /** Enable automatic query routing */
  autoRoute?: boolean;
  /** FlexSearch weight in result merging (0-1) */
  flexSearchWeight?: number;
  /** FTS5 weight in result merging (0-1) */
  fts5Weight?: number;
}

export interface SearchStats {
  queryCount: number;
  flexSearchHits: number;
  fts5Hits: number;
  bothHits: number;
  avgDuration: number;
}

// ============================================
// Hybrid Search Service
// ============================================

export class HybridSearchService {
  private fts5Adapter: FTS5SearchAdapter;
  private queryRouter: QueryRouter;
  private flexSearch: any;  // FantomFunctionSearchIndex

  // Configuration
  private flexSearchWeight: number;
  private fts5Weight: number;

  // Stats tracking
  private stats: SearchStats = {
    queryCount: 0,
    flexSearchHits: 0,
    fts5Hits: 0,
    bothHits: 0,
    avgDuration: 0
  };

  constructor(prisma: PrismaClient, options: HybridSearchServiceOptions = {}) {
    this.fts5Adapter = getFTS5SearchAdapter(prisma);
    this.queryRouter = new QueryRouter({ autoRoute: options.autoRoute ?? true });
    this.flexSearch = options.flexSearch;

    this.flexSearchWeight = options.flexSearchWeight ?? 0.6;
    this.fts5Weight = options.fts5Weight ?? 0.4;
  }

  /**
   * Set the FlexSearch instance (for deferred initialization)
   */
  setFlexSearch(flexSearch: any): void {
    this.flexSearch = flexSearch;
  }

  /**
   * Search code nodes using hybrid approach
   */
  async searchCodeNodes(
    query: string,
    options: HybridSearchOptions = {}
  ): Promise<HybridSearchResult<CodeNodeSearchResult>[]> {
    const startTime = Date.now();
    this.stats.queryCount++;

    // Determine backend to use
    const backend = this.queryRouter.route(query, options);

    logger.debug(`Hybrid search: "${query}" -> ${backend}`);

    let flexSearchResults: HybridSearchResult<CodeNodeSearchResult>[] = [];
    let fts5Results: HybridSearchResult<CodeNodeSearchResult>[] = [];

    // Execute searches based on backend selection
    if (backend === 'flexsearch' || backend === 'both') {
      if (this.flexSearch) {
        try {
          flexSearchResults = await this.searchFlexSearch(query, options);
          this.stats.flexSearchHits++;
        } catch (error) {
          logger.warn(`FlexSearch failed, falling back to FTS5: ${error}`);
        }
      }
    }

    if (backend === 'fts5' || backend === 'both') {
      try {
        fts5Results = await this.fts5Adapter.searchCodeNodes(query, options);
        this.stats.fts5Hits++;
      } catch (error) {
        logger.error(`FTS5 search failed: ${error}`);
      }
    }

    // Track dual-backend usage
    if (flexSearchResults.length > 0 && fts5Results.length > 0) {
      this.stats.bothHits++;
    }

    // Merge results
    const results = mergeResults(flexSearchResults, fts5Results, {
      flexSearchWeight: this.flexSearchWeight,
      fts5Weight: this.fts5Weight,
      limit: options.limit
    });

    // Update stats
    const duration = Date.now() - startTime;
    this.stats.avgDuration =
      (this.stats.avgDuration * (this.stats.queryCount - 1) + duration) /
      this.stats.queryCount;

    // Record query for future routing
    this.queryRouter.recordQuery(query, backend, duration);

    return results;
  }

  /**
   * Search using FlexSearch (adapter for FantomFunctionSearchIndex)
   */
  private async searchFlexSearch(
    query: string,
    options: HybridSearchOptions
  ): Promise<HybridSearchResult<CodeNodeSearchResult>[]> {
    if (!this.flexSearch) {
      return [];
    }

    // Use FlexSearch's search method
    const results = await this.flexSearch.search(query, {
      limit: options.limit || 20,
      projectId: options.projectId
    });

    // Convert to HybridSearchResult format
    return results.map((r: any) => ({
      item: {
        id: r.function.id,
        name: r.function.name,
        qualifiedName: r.function.qualifiedName,
        nodeType: r.function.type || 'method',
        filePath: r.function.filePath,
        lineStart: r.function.lineNumber || 1,
        signature: r.function.signature || null,
        documentation: r.function.documentation || null,
        projectId: r.function.projectId,
        score: r.score
      },
      score: r.score,
      source: 'flexsearch' as const,
      matchedFields: r.matchedFields
    }));
  }

  /**
   * Analyze a query without executing it
   */
  analyzeQuery(query: string): ReturnType<typeof analyzeQuery> {
    return analyzeQuery(query);
  }

  /**
   * Get the recommended backend for a query
   */
  getRecommendedBackend(query: string): SearchBackend {
    return this.queryRouter.route(query, {});
  }

  /**
   * Get search statistics
   */
  getStats(): SearchStats {
    return { ...this.stats };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      queryCount: 0,
      flexSearchHits: 0,
      fts5Hits: 0,
      bothHits: 0,
      avgDuration: 0
    };
  }

  /**
   * Get index sizes
   */
  async getIndexSizes(): Promise<{
    flexSearch: number;
    fts5: { codeNodes: number; docs: number };
  }> {
    const fts5 = await this.fts5Adapter.getIndexedCount();

    return {
      flexSearch: this.flexSearch?.getStats?.()?.totalFunctions || 0,
      fts5
    };
  }
}

// ============================================
// Factory Function
// ============================================

let serviceInstance: HybridSearchService | null = null;

/**
 * Get or create the hybrid search service
 */
export function getHybridSearchService(
  prisma: PrismaClient,
  options?: HybridSearchServiceOptions
): HybridSearchService {
  if (!serviceInstance) {
    serviceInstance = new HybridSearchService(prisma, options);
  }
  return serviceInstance;
}

/**
 * Reset the service (for testing)
 */
export function resetHybridSearchService(): void {
  serviceInstance = null;
}
