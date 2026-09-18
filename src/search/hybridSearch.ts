/**
 * Hybrid Search Architecture - FlexSearch + FTS5
 *
 * Design document and implementation for combining:
 * - FlexSearch: In-memory, instant search for hot queries
 * - SQLite FTS5: Disk-based, comprehensive search for cold queries
 *
 * Architecture:
 * ┌─────────────────────────────────────────────────────────────┐
 * │                     Query Router                             │
 * │  (decides FlexSearch vs FTS5 vs Both based on query type)   │
 * └─────────────────────────────────────────────────────────────┘
 *                          │
 *         ┌────────────────┴────────────────┐
 *         ▼                                 ▼
 * ┌───────────────────┐           ┌───────────────────┐
 * │    FlexSearch     │           │   SQLite FTS5     │
 * │  (Hot/In-Memory)  │           │   (Cold/Disk)     │
 * │                   │           │                   │
 * │ - Instant <5ms    │           │ - Deep search     │
 * │ - RAM-limited     │           │ - Unlimited size  │
 * │ - Active queries  │           │ - Boolean ops     │
 * │ - Fuzzy matching  │           │ - Phrase search   │
 * └───────────────────┘           └───────────────────┘
 *         │                                 │
 *         └────────────────┬────────────────┘
 *                          ▼
 *              ┌───────────────────┐
 *              │  Result Merger    │
 *              │  (dedupe, rank)   │
 *              └───────────────────┘
 */


// ============================================
// Types
// ============================================

export type SearchBackend = 'flexsearch' | 'fts5' | 'both';

export interface HybridSearchOptions {
  /** Which backend to use (auto-detected if not specified) */
  backend?: SearchBackend;
  /** Maximum results to return */
  limit?: number;
  /** Minimum score threshold (0-1) */
  minScore?: number;
  /** Enable fuzzy matching */
  fuzzy?: boolean;
  /** Project ID filter */
  projectId?: number;
  /** Search only specific fields */
  fields?: string[];
  /** Use phrase matching (exact match) */
  phrase?: boolean;
  /** Boolean operator for multi-word queries */
  operator?: 'AND' | 'OR';
}

export interface HybridSearchResult<T> {
  /** The matched document */
  item: T;
  /** Relevance score (0-1) */
  score: number;
  /** Which backend found this result */
  source: SearchBackend;
  /** Matched fields */
  matchedFields?: string[];
  /** Highlighted snippets */
  highlights?: Record<string, string>;
}

export interface QueryRouterConfig {
  /** Cache hit rate threshold to prefer FlexSearch */
  cacheHitThreshold: number;
  /** Query length threshold - longer queries prefer FTS5 */
  longQueryThreshold: number;
  /** Time threshold (ms) - fallback to FTS5 if FlexSearch too slow */
  timeoutThreshold: number;
  /** Maximum documents to keep in FlexSearch */
  flexSearchMaxDocs: number;
  /** Enable automatic query routing */
  autoRoute: boolean;
}

// ============================================
// Query Analyzer
// ============================================

export interface QueryAnalysis {
  /** Original query string */
  query: string;
  /** Normalized tokens */
  tokens: string[];
  /** Is this a phrase query (quoted) */
  isPhrase: boolean;
  /** Contains boolean operators */
  hasOperators: boolean;
  /** Contains wildcards */
  hasWildcards: boolean;
  /** Estimated complexity (1-10) */
  complexity: number;
  /** Recommended backend */
  recommendedBackend: SearchBackend;
}

export function analyzeQuery(query: string): QueryAnalysis {
  const tokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
  const isPhrase = query.includes('"');
  const hasOperators = /\b(AND|OR|NOT)\b/i.test(query);
  const hasWildcards = query.includes('*') || query.includes('?');

  // Calculate complexity
  let complexity = 1;
  if (tokens.length > 3) complexity += 2;
  if (isPhrase) complexity += 2;
  if (hasOperators) complexity += 2;
  if (hasWildcards) complexity += 1;

  // Determine recommended backend
  let recommendedBackend: SearchBackend = 'flexsearch';

  // Simple queries: FlexSearch
  if (tokens.length <= 2 && !isPhrase && !hasOperators) {
    recommendedBackend = 'flexsearch';
  }
  // Complex queries: FTS5
  else if (complexity > 5 || isPhrase || hasOperators) {
    recommendedBackend = 'fts5';
  }
  // Medium queries: Both for best results
  else {
    recommendedBackend = 'both';
  }

  return {
    query,
    tokens,
    isPhrase,
    hasOperators,
    hasWildcards,
    complexity,
    recommendedBackend
  };
}

// ============================================
// Result Merger
// ============================================

export interface MergeOptions {
  /** Prefer results from this backend when scores are equal */
  preferBackend?: SearchBackend;
  /** Weight for FlexSearch results (0-1) */
  flexSearchWeight?: number;
  /** Weight for FTS5 results (0-1) */
  fts5Weight?: number;
  /** Maximum total results */
  limit?: number;
}

/**
 * Merge results from multiple backends with deduplication and re-ranking
 */
export function mergeResults<T extends { id: string }>(
  flexSearchResults: HybridSearchResult<T>[],
  fts5Results: HybridSearchResult<T>[],
  options: MergeOptions = {}
): HybridSearchResult<T>[] {
  const {
    preferBackend = 'flexsearch',
    flexSearchWeight = 0.6,
    fts5Weight = 0.4,
    limit = 20
  } = options;

  // Create map for deduplication
  const resultMap = new Map<string, HybridSearchResult<T>>();

  // Add FlexSearch results with weighting
  for (const result of flexSearchResults) {
    const existing = resultMap.get(result.item.id);
    if (existing) {
      // Combine scores
      existing.score = Math.max(
        existing.score,
        result.score * flexSearchWeight
      );
      existing.source = 'both';
    } else {
      resultMap.set(result.item.id, {
        ...result,
        score: result.score * flexSearchWeight,
        source: 'flexsearch'
      });
    }
  }

  // Add FTS5 results with weighting
  for (const result of fts5Results) {
    const existing = resultMap.get(result.item.id);
    if (existing) {
      // Combine scores
      existing.score = Math.max(
        existing.score,
        result.score * fts5Weight
      );
      existing.source = 'both';
      // Merge highlights
      if (result.highlights) {
        existing.highlights = { ...existing.highlights, ...result.highlights };
      }
    } else {
      resultMap.set(result.item.id, {
        ...result,
        score: result.score * fts5Weight,
        source: 'fts5'
      });
    }
  }

  // Sort by score and limit
  const merged = Array.from(resultMap.values())
    .sort((a, b) => {
      // First by score
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      // Then by preferred backend
      if (preferBackend === 'flexsearch') {
        if (a.source === 'flexsearch' && b.source !== 'flexsearch') return -1;
        if (b.source === 'flexsearch' && a.source !== 'flexsearch') return 1;
      } else if (preferBackend === 'fts5') {
        if (a.source === 'fts5' && b.source !== 'fts5') return -1;
        if (b.source === 'fts5' && a.source !== 'fts5') return 1;
      }
      return 0;
    })
    .slice(0, limit);

  return merged;
}

// ============================================
// FTS5 Query Builder
// ============================================

/**
 * Build an FTS5 MATCH query from a search string
 */
export function buildFTS5Query(query: string, options: HybridSearchOptions = {}): string {
  const { operator = 'OR', phrase = false, fuzzy = false } = options;

  // Handle phrase search
  if (phrase || query.includes('"')) {
    return query;  // FTS5 handles quoted phrases natively
  }

  // Tokenize
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length > 1)  // Skip single chars
    .map(t => t.replace(/[^\w*]/g, ''));  // Keep only word chars and wildcards

  if (tokens.length === 0) {
    return '';
  }

  // Handle fuzzy matching with prefix search
  const processedTokens = fuzzy
    ? tokens.map(t => t.includes('*') ? t : `${t}*`)
    : tokens;

  // Build query with operator
  return processedTokens.join(` ${operator} `);
}

/**
 * Build SQL WHERE clause for FTS5 search
 */
export function buildFTS5SQL(
  tableName: string,
  query: string,
  options: HybridSearchOptions = {}
): { sql: string; params: unknown[] } {
  const fts5Query = buildFTS5Query(query, options);

  let sql = `
    SELECT
      rowid,
      *,
      bm25(${tableName}) as score
    FROM ${tableName}
    WHERE ${tableName} MATCH ?
  `;

  const params: unknown[] = [fts5Query];

  if (options.projectId) {
    sql += ' AND project_id = ?';
    params.push(options.projectId);
  }

  if (options.minScore) {
    sql += ' AND bm25(${tableName}) >= ?';
    params.push(-options.minScore);  // BM25 returns negative scores
  }

  sql += ` ORDER BY score LIMIT ?`;
  params.push(options.limit || 20);

  return { sql, params };
}

// ============================================
// Query Router
// ============================================

export class QueryRouter {
  private config: QueryRouterConfig;
  private queryStats: Map<string, { hits: number; avgTime: number }> = new Map();

  constructor(config: Partial<QueryRouterConfig> = {}) {
    this.config = {
      cacheHitThreshold: 0.7,
      longQueryThreshold: 50,
      timeoutThreshold: 100,
      flexSearchMaxDocs: 50000,
      autoRoute: true,
      ...config
    };
  }

  /**
   * Determine the best backend for a query
   */
  route(query: string, options: HybridSearchOptions = {}): SearchBackend {
    // If explicitly specified, use that
    if (options.backend) {
      return options.backend;
    }

    // Auto-routing disabled
    if (!this.config.autoRoute) {
      return 'both';
    }

    // Analyze the query
    const analysis = analyzeQuery(query);

    // Check query stats for cached decision
    const stats = this.queryStats.get(this.normalizeQuery(query));
    if (stats) {
      // High hit rate = FlexSearch
      if (stats.hits > 10 && stats.avgTime < 10) {
        return 'flexsearch';
      }
    }

    // Use query analysis recommendation
    return analysis.recommendedBackend;
  }

  /**
   * Record query performance for future routing decisions
   */
  recordQuery(query: string, _backend: SearchBackend, duration: number): void {
    const normalized = this.normalizeQuery(query);
    const stats = this.queryStats.get(normalized) || { hits: 0, avgTime: 0 };

    stats.hits++;
    stats.avgTime = (stats.avgTime * (stats.hits - 1) + duration) / stats.hits;

    this.queryStats.set(normalized, stats);

    // Limit map size
    if (this.queryStats.size > 1000) {
      const oldest = this.queryStats.keys().next().value;
      if (oldest) this.queryStats.delete(oldest);
    }
  }

  private normalizeQuery(query: string): string {
    return query.toLowerCase().trim().substring(0, 50);
  }
}

// ============================================
// Summary
// ============================================

/**
 * Hybrid Search Implementation Summary:
 *
 * 1. FLEXSEARCH (Hot/In-Memory):
 *    - Already implemented in src/search/index.ts
 *    - Used for: quick lookups, autocomplete, fuzzy search
 *    - Limitations: RAM-bound, no persistence, limited boolean ops
 *
 * 2. FTS5 (Cold/Disk):
 *    - Needs: Prisma raw SQL or sqlite3 direct connection
 *    - Used for: complex queries, phrase search, boolean AND/OR/NOT
 *    - Advantages: persistent, unlimited size, BM25 ranking
 *
 * 3. QUERY ROUTER:
 *    - Analyzes query complexity
 *    - Tracks query performance history
 *    - Routes to optimal backend(s)
 *
 * 4. RESULT MERGER:
 *    - Combines results from both backends
 *    - Deduplicates by ID
 *    - Re-ranks with configurable weights
 *
 * Implementation Steps:
 * 1. ✅ Design hybrid architecture (this file)
 * 2. Add FTS5 virtual tables to SQLite (Task #18)
 * 3. Create FTS5 search adapter
 * 4. Implement unified HybridSearchService
 * 5. Integrate with existing search tools
 */

export default {
  analyzeQuery,
  mergeResults,
  buildFTS5Query,
  buildFTS5SQL,
  QueryRouter
};
