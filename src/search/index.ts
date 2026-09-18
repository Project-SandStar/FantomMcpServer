import FlexSearch from 'flexsearch';
import type { FantomDocItem, SearchResult } from '../types/index.js';
import { createLogger } from '../utils/index.js';

const logger = createLogger('search');

/**
 * Search index manager using FlexSearch
 */
export class SearchIndex {
  private index: any; // FlexSearch Document type
  private items: Map<string, FantomDocItem> = new Map();

  constructor() {
    // Initialize FlexSearch with optimal settings for documentation
    this.index = new (FlexSearch as any).Document({
      document: {
        id: 'id',
        index: ['name', 'qualifiedName', 'description', 'signature', 'keywords'],
        store: true,
      },
      tokenize: 'forward',
      context: {
        resolution: 9,
        depth: 2,
        bidirectional: true,
      },
      optimize: true,
      cache: 100,
    });
  }

  /**
   * Add items to the index
   */
  async addItems(items: FantomDocItem[]): Promise<void> {
    logger.info(`Indexing ${items.length} items...`);

    for (const item of items) {
      // Store item
      this.items.set(item.id, item);

      // Add to search index
      await this.index.addAsync(item.id, {
        id: item.id,
        name: item.name,
        qualifiedName: item.qualifiedName || '',
        description: item.description,
        signature: item.signature || '',
        keywords: item.keywords.join(' '),
      } as any);
    }

    logger.info(`Indexed ${items.length} items`);
  }

  /**
   * Search the index with OR logic for multi-word queries
   * Each word is searched separately and results are combined with smart scoring
   */
  async search(query: string, limit: number = 10): Promise<SearchResult[]> {
    logger.debug(`Searching for: "${query}"`);

    try {
      // Parse query into words for OR logic
      const queryWords = query.trim().split(/\s+/).filter(w => w.length > 0);
      const useOrLogic = queryWords.length > 1;

      // Collect results with field info
      const resultMap = new Map<string, { fields: Set<string>; matchedWords: Set<string> }>();

      if (useOrLogic) {
        // OR logic: search each word separately
        for (const word of queryWords) {
          const wordResults = await this.index.searchAsync(word, {
            limit: limit * 3,
            enrich: true,
          });

          for (const fieldResults of wordResults) {
            if (!fieldResults.result) continue;
            for (const result of fieldResults.result) {
              const id = String(result.id);
              if (!resultMap.has(id)) {
                resultMap.set(id, { fields: new Set(), matchedWords: new Set() });
              }
              resultMap.get(id)!.fields.add(fieldResults.field as string);
              resultMap.get(id)!.matchedWords.add(word.toLowerCase());
            }
          }
        }
      } else {
        // Single word: search as-is
        const results = await this.index.searchAsync(query, {
          limit: limit * 3,
          enrich: true,
        });

        for (const fieldResults of results) {
          if (!fieldResults.result) continue;
          for (const result of fieldResults.result) {
            const id = String(result.id);
            if (!resultMap.has(id)) {
              resultMap.set(id, { fields: new Set(), matchedWords: new Set() });
            }
            resultMap.get(id)!.fields.add(fieldResults.field as string);
            resultMap.get(id)!.matchedWords.add(query.toLowerCase());
          }
        }
      }

      // Score and build results
      const searchResults: SearchResult[] = [];

      for (const [id, data] of resultMap) {
        const item = this.items.get(id);
        if (!item) continue;

        // Calculate relevance score with OR logic awareness
        const score = this.calculateScore(query, item, Array.from(data.fields), queryWords, data.matchedWords);

        searchResults.push({
          item,
          score,
          relevance: this.getRelevanceLabel(score),
        });
      }

      // Sort by score
      searchResults.sort((a, b) => b.score - a.score);

      logger.debug(`Found ${searchResults.length} results`);
      return searchResults.slice(0, limit);
    } catch (error) {
      logger.error('Search error:', error);
      return [];
    }
  }

  /**
   * Search by type
   */
  async searchByType(type: string, limit: number = 10): Promise<FantomDocItem[]> {
    const items = Array.from(this.items.values()).filter(item => item.type === type);
    return items.slice(0, limit);
  }

  /**
   * Search by pod
   */
  async searchByPod(pod: string, limit: number = 50): Promise<FantomDocItem[]> {
    const items = Array.from(this.items.values()).filter(item => item.pod === pod);
    return items.slice(0, limit);
  }

  /**
   * Get item by ID
   */
  getItem(id: string): FantomDocItem | undefined {
    return this.items.get(id);
  }

  /**
   * Get all items
   */
  getAllItems(): FantomDocItem[] {
    return Array.from(this.items.values());
  }

  /**
   * Calculate relevance score with smarter multi-word matching
   */
  private calculateScore(
    query: string,
    item: FantomDocItem,
    fields: string[],
    queryWords: string[],
    matchedWords: Set<string>
  ): number {
    let score = 0.5; // Base score

    const queryLower = query.toLowerCase();
    const nameLower = item.name.toLowerCase();
    const qualifiedLower = (item.qualifiedName || '').toLowerCase();
    const descLower = (item.description || '').toLowerCase();

    // Exact name match - highest score
    if (nameLower === queryLower) {
      score += 1.5;
    }
    // Qualified name match
    else if (qualifiedLower === queryLower) {
      score += 1.2;
    }
    // Name starts with query
    else if (nameLower.startsWith(queryLower)) {
      score += 0.9;
    }
    // Name contains query
    else if (nameLower.includes(queryLower)) {
      score += 0.6;
    }

    // Multi-word query scoring (OR logic bonus)
    if (queryWords.length > 1) {
      // Bonus for matching multiple query words
      const wordMatchRatio = matchedWords.size / queryWords.length;
      score += wordMatchRatio * 0.8;

      // Extra bonus if ALL words match
      if (matchedWords.size === queryWords.length) {
        score += 0.5;
      }

      // Check how many words appear in name vs description
      let nameMatches = 0;
      let descMatches = 0;
      for (const word of queryWords) {
        if (nameLower.includes(word)) nameMatches++;
        if (descLower.includes(word)) descMatches++;
      }

      // Name matches are more valuable
      score += nameMatches * 0.3;
      score += descMatches * 0.1;
    }

    // Keyword match
    const keywordMatches = item.keywords.filter(k =>
      queryWords.some(w => k.toLowerCase().includes(w))
    ).length;
    score += keywordMatches * 0.2;

    // Field boost - matches in multiple fields indicate higher relevance
    const fieldSet = new Set(fields);
    if (fieldSet.has('name')) score += 0.4;
    if (fieldSet.has('qualifiedName')) score += 0.3;
    if (fieldSet.has('signature')) score += 0.2;
    if (fieldSet.size > 2) score += 0.2; // Multi-field match bonus

    // Type boost (prioritize types over slots)
    if (item.type === 'type') {
      score += 0.3;
    }

    // Has code example boost
    if (item.codeExample) {
      score += 0.15;
    }

    return Math.min(score, 3.0); // Cap at 3.0
  }

  /**
   * Get relevance label from score
   */
  private getRelevanceLabel(score: number): string {
    if (score >= 2.0) return 'exact';
    if (score >= 1.5) return 'high';
    if (score >= 1.0) return 'medium';
    return 'low';
  }

  /**
   * Clear the index
   */
  clear(): void {
    this.items.clear();
    logger.info('Index cleared');
  }

  /**
   * Get index statistics
   */
  getStats(): { totalItems: number; byType: Record<string, number>; byPod: Record<string, number> } {
    const stats = {
      totalItems: this.items.size,
      byType: {} as Record<string, number>,
      byPod: {} as Record<string, number>,
    };

    for (const item of this.items.values()) {
      stats.byType[item.type] = (stats.byType[item.type] || 0) + 1;
      if (item.pod) {
        stats.byPod[item.pod] = (stats.byPod[item.pod] || 0) + 1;
      }
    }

    return stats;
  }
}


// Hybrid Search Architecture
export * from "./hybridSearch.js";
export * from "./fts5Setup.js";
export * from "./fts5Search.js";
export * from "./hybridSearchService.js";
export * from "./unifiedSearchService.js";

// Docs Hybrid Search (keyword + semantic vector with RRF)
export type { HybridSearchMeta, HybridResultItem } from "./docsHybridSearchService.js";
export {
  hybridSearchLocalDocs,
  hybridSearchLocalDocsWithMeta,
  getDocsHybridSearchService
} from "./docsHybridSearchService.js";
