/**
 * FTS5 Search Adapter
 *
 * Provides full-text search using SQLite FTS5 virtual tables.
 * Supports:
 * - BM25 ranking
 * - Phrase search
 * - Boolean operators (AND, OR, NOT)
 * - Prefix/wildcard search
 */

import type { PrismaClient } from '@prisma/client';
import { createLogger } from '../utils/index.js';
import type { HybridSearchOptions, HybridSearchResult } from './hybridSearch.js';
import { buildFTS5Query } from './hybridSearch.js';

const logger = createLogger('fts5-search');

// ============================================
// Types
// ============================================

export interface CodeNodeSearchResult {
  id: string;
  name: string;
  qualifiedName: string;
  nodeType: string;
  filePath: string;
  lineStart: number;
  signature: string | null;
  documentation: string | null;
  projectId: number;
  score: number;
}

// ============================================
// FTS5 Search Adapter
// ============================================

export class FTS5SearchAdapter {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Search code nodes using FTS5
   */
  async searchCodeNodes(
    query: string,
    options: HybridSearchOptions = {}
  ): Promise<HybridSearchResult<CodeNodeSearchResult>[]> {
    const { limit = 20, projectId, minScore = 0 } = options;

    // Build FTS5 query
    const ftsQuery = buildFTS5Query(query, options);
    if (!ftsQuery) {
      return [];
    }

    try {
      // Execute FTS5 search
      // Note: BM25 returns negative scores, more negative = better match
      let results: CodeNodeSearchResult[];

      if (projectId) {
        results = await this.prisma.$queryRaw<CodeNodeSearchResult[]>`
          SELECT
            n.id,
            n.name,
            n.qualified_name as qualifiedName,
            n.node_type as nodeType,
            n.file_path as filePath,
            n.line_start as lineStart,
            n.signature,
            n.documentation,
            n.project_id as projectId,
            -bm25(code_nodes_fts) as score
          FROM code_nodes_fts fts
          JOIN code_nodes n ON n.rowid = fts.rowid
          WHERE code_nodes_fts MATCH ${ftsQuery}
            AND n.project_id = ${projectId}
          ORDER BY bm25(code_nodes_fts)
          LIMIT ${limit}
        `;
      } else {
        results = await this.prisma.$queryRaw<CodeNodeSearchResult[]>`
          SELECT
            n.id,
            n.name,
            n.qualified_name as qualifiedName,
            n.node_type as nodeType,
            n.file_path as filePath,
            n.line_start as lineStart,
            n.signature,
            n.documentation,
            n.project_id as projectId,
            -bm25(code_nodes_fts) as score
          FROM code_nodes_fts fts
          JOIN code_nodes n ON n.rowid = fts.rowid
          WHERE code_nodes_fts MATCH ${ftsQuery}
          ORDER BY bm25(code_nodes_fts)
          LIMIT ${limit}
        `;
      }

      // Normalize scores to 0-1 range and filter by minScore
      const maxScore = results.length > 0 ? Math.max(...results.map(r => r.score)) : 1;

      return results
        .map(r => ({
          item: r,
          score: maxScore > 0 ? r.score / maxScore : 0,
          source: 'fts5' as const
        }))
        .filter(r => r.score >= minScore);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`FTS5 search failed: ${errMsg}`);

      // Check if FTS5 table doesn't exist
      if (errMsg.includes('no such table')) {
        logger.warn('FTS5 table not found. Run setupFTS5Tables() first.');
      }

      return [];
    }
  }

  /**
   * Get highlighted snippets for search results
   */
  async getHighlights(
    query: string,
    nodeIds: string[]
  ): Promise<Map<string, Record<string, string>>> {
    if (nodeIds.length === 0) return new Map();

    const ftsQuery = buildFTS5Query(query, { fuzzy: false });
    if (!ftsQuery) return new Map();

    try {
      // Get highlights using FTS5 snippet function
      const results = await this.prisma.$queryRaw<Array<{
        id: string;
        nameSnippet: string;
        docSnippet: string;
      }>>`
        SELECT
          n.id,
          snippet(code_nodes_fts, 0, '<mark>', '</mark>', '...', 10) as nameSnippet,
          snippet(code_nodes_fts, 3, '<mark>', '</mark>', '...', 20) as docSnippet
        FROM code_nodes_fts fts
        JOIN code_nodes n ON n.rowid = fts.rowid
        WHERE code_nodes_fts MATCH ${ftsQuery}
          AND n.id IN (${nodeIds.join(',')})
      `;

      const highlights = new Map<string, Record<string, string>>();
      for (const r of results) {
        highlights.set(r.id, {
          name: r.nameSnippet,
          documentation: r.docSnippet
        });
      }

      return highlights;
    } catch (error) {
      logger.error(`Failed to get highlights: ${error}`);
      return new Map();
    }
  }

  /**
   * Search documentation using FTS5
   */
  async searchDocs(
    query: string,
    options: HybridSearchOptions = {}
  ): Promise<HybridSearchResult<{
    title: string;
    content: string;
    podName: string;
    docType: string;
    sourceId: string;
  }>[]> {
    const { limit = 20, minScore = 0 } = options;

    const ftsQuery = buildFTS5Query(query, options);
    if (!ftsQuery) {
      return [];
    }

    try {
      const results = await this.prisma.$queryRaw<Array<{
        rowid: number;
        title: string;
        content: string;
        pod_name: string;
        doc_type: string;
        source_id: string;
        score: number;
      }>>`
        SELECT
          rowid,
          title,
          content,
          pod_name,
          doc_type,
          source_id,
          -bm25(docs_fts) as score
        FROM docs_fts
        WHERE docs_fts MATCH ${ftsQuery}
        ORDER BY bm25(docs_fts)
        LIMIT ${limit}
      `;

      const maxScore = results.length > 0 ? Math.max(...results.map(r => r.score)) : 1;

      return results
        .map(r => ({
          item: {
            title: r.title,
            content: r.content,
            podName: r.pod_name,
            docType: r.doc_type,
            sourceId: r.source_id
          },
          score: maxScore > 0 ? r.score / maxScore : 0,
          source: 'fts5' as const
        }))
        .filter(r => r.score >= minScore);
    } catch (error) {
      logger.error(`FTS5 docs search failed: ${error}`);
      return [];
    }
  }

  /**
   * Count total documents in FTS5 index
   */
  async getIndexedCount(): Promise<{ codeNodes: number; docs: number }> {
    try {
      const codeCount = await this.prisma.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(*) as count FROM code_nodes_fts
      `;
      const docsCount = await this.prisma.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(*) as count FROM docs_fts
      `;

      return {
        codeNodes: Number(codeCount[0].count),
        docs: Number(docsCount[0].count)
      };
    } catch {
      return { codeNodes: 0, docs: 0 };
    }
  }
}

// ============================================
// Factory Function
// ============================================

let adapterInstance: FTS5SearchAdapter | null = null;

/**
 * Get or create the FTS5 search adapter
 */
export function getFTS5SearchAdapter(prisma: PrismaClient): FTS5SearchAdapter {
  if (!adapterInstance) {
    adapterInstance = new FTS5SearchAdapter(prisma);
  }
  return adapterInstance;
}

/**
 * Reset the adapter (for testing)
 */
export function resetFTS5SearchAdapter(): void {
  adapterInstance = null;
}
