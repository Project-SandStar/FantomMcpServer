/**
 * Docs Hybrid Search Service
 *
 * Combines keyword search (from the existing localDocsParser scoring logic)
 * with vector/semantic search (via DocsVectorStore) using Reciprocal Rank
 * Fusion (RRF) for scale-invariant result merging.
 *
 * RRF formula: RRF(d) = sum(1 / (k + rank_i(d))) for each retrieval system i
 *
 * Falls back to keyword-only when no vectors exist (backward compatible).
 */

import { createLogger } from '../utils/index.js';
import { getDocsVectorStore } from '../embedding/docsVectorStore.js';
import { getDocsLanceTable } from '../embedding/lanceConnection.js';
import { loadCachedDocs } from '../parser/local/localDocsParser.js';
import { getFantomDatabase } from '../fantom/database.js';
import type { LocalDocItem, LocalDocSearchResult } from '../parser/local/types.js';

const logger = createLogger('docs-hybrid-search');

// ============================================
// Constants
// ============================================

/** RRF smoothing constant — standard value from the literature */
const RRF_K = 60;

/** How many candidates to fetch from each retrieval system before fusing */
const CANDIDATE_MULTIPLIER = 3;

// ============================================
// Types
// ============================================

interface ScoredDocItem {
  item: LocalDocItem & { instanceName: string; instanceType: 'skyspark' | 'haxall' | 'fantom' };
  keywordScore: number;
  matchedWords: number;
}

interface RankedCandidate {
  docId: string;
  item: LocalDocItem & { instanceName: string; instanceType: 'skyspark' | 'haxall' | 'fantom' };
  keywordRank: number | null;
  vectorRank: number | null;
  keywordScore: number;
  vectorScore: number;
  fusedScore: number;
}

// ============================================
// Keyword Search (extracted from localDocsParser)
// ============================================

function keywordSearch(
  query: string,
  items: Array<LocalDocItem & { instanceName: string; instanceType: 'skyspark' | 'haxall' | 'fantom' }>,
  options: { pod?: string; type?: LocalDocItem['type']; language?: string; limit: number }
): ScoredDocItem[] {
  const queryLower = query.toLowerCase();
  const isWildcard = query === '*';
  const queryWords = queryLower.trim().split(/\s+/).filter(w => w.length > 0);

  const results: ScoredDocItem[] = [];

  for (const item of items) {
    // Apply filters
    if (options.pod && item.pod !== options.pod) continue;
    if (options.type && item.type !== options.type) continue;
    if (options.language && item.language !== options.language) continue;

    let score = 0;
    let matchedWords = 0;

    if (!isWildcard) {
      const nameLower = item.name.toLowerCase();
      const qualifiedLower = item.qualifiedName.toLowerCase();
      const descLower = item.description.toLowerCase();

      for (const word of queryWords) {
        if (nameLower.includes(word)) {
          matchedWords++;
          score += nameLower === word ? 2.0 : nameLower.startsWith(word) ? 1.5 : 1.0;
        } else if (qualifiedLower.includes(word)) {
          matchedWords++;
          score += 0.8;
        } else if (descLower.includes(word)) {
          matchedWords++;
          score += 0.5;
        } else if (item.keywords.some(k => k.toLowerCase().includes(word))) {
          matchedWords++;
          score += 0.6;
        }
      }

      if (queryWords.length > 1 && matchedWords === queryWords.length) {
        score += 1.0;
      }

      if (matchedWords === 0) continue;
    }

    results.push({ item, keywordScore: score, matchedWords });
  }

  // Sort by score, then matched words, then shorter names first
  if (isWildcard) {
    results.sort((a, b) => a.item.name.localeCompare(b.item.name));
  } else {
    results.sort((a, b) => {
      if (b.keywordScore !== a.keywordScore) return b.keywordScore - a.keywordScore;
      if (b.matchedWords !== a.matchedWords) return b.matchedWords - a.matchedWords;
      return a.item.name.length - b.item.name.length;
    });
  }

  return results.slice(0, options.limit);
}

// ============================================
// RRF Fusion
// ============================================

function rrfFuse(
  keywordResults: ScoredDocItem[],
  vectorResults: Array<{ docId: string; score: number }>,
  allItemsById: Map<string, LocalDocItem & { instanceName: string; instanceType: 'skyspark' | 'haxall' | 'fantom' }>,
  limit: number
): RankedCandidate[] {
  const candidateMap = new Map<string, RankedCandidate>();

  // Add keyword results with their ranks
  for (let rank = 0; rank < keywordResults.length; rank++) {
    const kr = keywordResults[rank];
    candidateMap.set(kr.item.id, {
      docId: kr.item.id,
      item: kr.item,
      keywordRank: rank + 1,
      vectorRank: null,
      keywordScore: kr.keywordScore,
      vectorScore: 0,
      fusedScore: 1 / (RRF_K + rank + 1)
    });
  }

  // Add vector results with their ranks
  for (let rank = 0; rank < vectorResults.length; rank++) {
    const vr = vectorResults[rank];
    const existing = candidateMap.get(vr.docId);

    if (existing) {
      // Appears in both — add vector contribution
      existing.vectorRank = rank + 1;
      existing.vectorScore = vr.score;
      existing.fusedScore += 1 / (RRF_K + rank + 1);
    } else {
      // Vector-only result — hydrate from the items map
      const item = allItemsById.get(vr.docId);
      if (item) {
        candidateMap.set(vr.docId, {
          docId: vr.docId,
          item,
          keywordRank: null,
          vectorRank: rank + 1,
          keywordScore: 0,
          vectorScore: vr.score,
          fusedScore: 1 / (RRF_K + rank + 1)
        });
      }
    }
  }

  // Sort by fused score descending
  const candidates = Array.from(candidateMap.values());
  candidates.sort((a, b) => b.fusedScore - a.fusedScore);

  return candidates.slice(0, limit);
}

// ============================================
// Hybrid Search
// ============================================

/**
 * Hybrid search combining keyword matching with vector similarity.
 * Falls back to keyword-only when no doc vectors exist.
 */
export async function hybridSearchLocalDocs(
  query: string,
  options: {
    instanceId?: number;
    instanceType?: 'skyspark' | 'haxall' | 'fantom';
    pod?: string;
    type?: LocalDocItem['type'];
    language?: 'fantom' | 'axon';
    limit?: number;
  } = {}
): Promise<LocalDocSearchResult[]> {
  const { instanceId, instanceType, pod, type, language, limit = 20 } = options;
  const db = getFantomDatabase();
  await db.initialize();

  // Get all instances
  const allInstances = await db.getAllInstances();

  // Determine which instances to search (same logic as original)
  let instancesToSearch = allInstances;

  if (instanceId) {
    const targetInstance = allInstances.find(i => i.id === instanceId);
    if (targetInstance?.type === 'haxall') {
      if (targetInstance.docSourceInstanceId) {
        const docSource = allInstances.find(i => i.id === targetInstance.docSourceInstanceId);
        instancesToSearch = docSource ? [docSource] : [];
      } else {
        return [];
      }
    } else {
      instancesToSearch = targetInstance ? [targetInstance] : [];
    }
  }

  if (instanceType) {
    if (instanceType === 'haxall') {
      const haxallInstances = instancesToSearch.filter(i => i.type === 'haxall');
      const linkedDocSourceIds = haxallInstances
        .filter(i => i.docSourceInstanceId)
        .map(i => i.docSourceInstanceId);
      instancesToSearch = allInstances.filter(i => linkedDocSourceIds.includes(i.id));
    } else {
      instancesToSearch = instancesToSearch.filter(i => i.type === instanceType);
    }
  }

  // Collect items from matching instances
  type ItemWithInstance = LocalDocItem & { instanceName: string; instanceType: 'skyspark' | 'haxall' | 'fantom' };
  const items: ItemWithInstance[] = [];
  const itemsById = new Map<string, ItemWithInstance>();

  for (const instance of instancesToSearch) {
    const cached = loadCachedDocs(instance.id);
    if (cached) {
      for (const item of cached) {
        const enriched: ItemWithInstance = {
          ...item,
          instanceName: instance.name,
          instanceType: instance.type as 'skyspark' | 'haxall' | 'fantom'
        };
        items.push(enriched);
        itemsById.set(item.id, enriched);
      }
    }
  }

  // Wildcard query — skip vector search, just return all filtered items
  if (query === '*') {
    const kwResults = keywordSearch(query, items, { pod, type, language, limit });
    return kwResults.map(r => r.item);
  }

  const result = await runHybridPipeline(query, items, itemsById, instancesToSearch, { pod, type, language, limit });
  return result.results;
}

/**
 * Per-result provenance: which retrieval system(s) found this result
 */
export interface HybridResultItem extends LocalDocSearchResult {
  /** Which retrieval system(s) found this result */
  source: 'keyword' | 'vector' | 'both';
  /** Rank in keyword results (null if vector-only) */
  keywordRank: number | null;
  /** Rank in vector results (null if keyword-only) */
  vectorRank: number | null;
  /** Raw keyword score (0 if vector-only) */
  keywordScore: number;
  /** Raw vector similarity score (0 if keyword-only) */
  vectorScore: number;
  /** RRF fused score */
  fusedScore: number;
}

/**
 * Search metadata returned alongside results
 */
export interface HybridSearchMeta {
  searchMethod: 'keyword-only' | 'hybrid';
  keywordResults: number;
  vectorResults: number;
  vectorCount: number;
  results: HybridResultItem[];
}

/**
 * Hybrid search with metadata — used by MCP tools to expose search method info
 */
export async function hybridSearchLocalDocsWithMeta(
  query: string,
  options: {
    instanceId?: number;
    instanceType?: 'skyspark' | 'haxall' | 'fantom';
    pod?: string;
    type?: LocalDocItem['type'];
    language?: 'fantom' | 'axon';
    limit?: number;
  } = {}
): Promise<HybridSearchMeta> {
  const { instanceId, instanceType, pod, type, language, limit = 20 } = options;
  const db = getFantomDatabase();
  await db.initialize();

  const allInstances = await db.getAllInstances();
  let instancesToSearch = allInstances;

  if (instanceId) {
    const targetInstance = allInstances.find(i => i.id === instanceId);
    if (targetInstance?.type === 'haxall') {
      if (targetInstance.docSourceInstanceId) {
        const docSource = allInstances.find(i => i.id === targetInstance.docSourceInstanceId);
        instancesToSearch = docSource ? [docSource] : [];
      } else {
        return { searchMethod: 'keyword-only', keywordResults: 0, vectorResults: 0, vectorCount: 0, results: [] };
      }
    } else {
      instancesToSearch = targetInstance ? [targetInstance] : [];
    }
  }

  if (instanceType) {
    if (instanceType === 'haxall') {
      const haxallInstances = instancesToSearch.filter(i => i.type === 'haxall');
      const linkedDocSourceIds = haxallInstances
        .filter(i => i.docSourceInstanceId)
        .map(i => i.docSourceInstanceId);
      instancesToSearch = allInstances.filter(i => linkedDocSourceIds.includes(i.id));
    } else {
      instancesToSearch = instancesToSearch.filter(i => i.type === instanceType);
    }
  }

  type ItemWithInstance = LocalDocItem & { instanceName: string; instanceType: 'skyspark' | 'haxall' | 'fantom' };
  const items: ItemWithInstance[] = [];
  const itemsById = new Map<string, ItemWithInstance>();

  for (const instance of instancesToSearch) {
    const cached = loadCachedDocs(instance.id);
    if (cached) {
      for (const item of cached) {
        const enriched: ItemWithInstance = {
          ...item,
          instanceName: instance.name,
          instanceType: instance.type as 'skyspark' | 'haxall' | 'fantom'
        };
        items.push(enriched);
        itemsById.set(item.id, enriched);
      }
    }
  }

  if (query === '*') {
    const kwResults = keywordSearch(query, items, { pod, type, language, limit });
    return {
      searchMethod: 'keyword-only',
      keywordResults: kwResults.length,
      vectorResults: 0,
      vectorCount: 0,
      results: kwResults.map((r, i) => ({
        ...r.item,
        source: 'keyword' as const,
        keywordRank: i + 1,
        vectorRank: null,
        keywordScore: r.keywordScore,
        vectorScore: 0,
        fusedScore: 0,
      }))
    };
  }

  return runHybridPipeline(query, items, itemsById, instancesToSearch, { pod, type, language, limit });
}

/**
 * Internal: run the keyword + vector + RRF pipeline
 */
async function runHybridPipeline(
  query: string,
  items: Array<LocalDocItem & { instanceName: string; instanceType: 'skyspark' | 'haxall' | 'fantom' }>,
  itemsById: Map<string, LocalDocItem & { instanceName: string; instanceType: 'skyspark' | 'haxall' | 'fantom' }>,
  instancesToSearch: Array<{ id: number; [key: string]: any }>,
  filters: { pod?: string; type?: LocalDocItem['type']; language?: string; limit: number }
): Promise<HybridSearchMeta> {
  const { pod, type, language, limit } = filters;
  const candidateLimit = limit * CANDIDATE_MULTIPLIER;
  const kwResults = keywordSearch(query, items, { pod, type, language, limit: candidateLimit });

  // Check if vectors exist
  let vectorResults: Array<{ docId: string; score: number }> = [];
  let hasVectors = false;
  let vectorCount = 0;

  try {
    const docsTable = await getDocsLanceTable();
    vectorCount = await docsTable.countRows();
    hasVectors = vectorCount > 0;
  } catch {
    // LanceDB not available — keyword only
  }

  if (hasVectors) {
    try {
      const store = getDocsVectorStore();

      const searchInstanceIds = instancesToSearch.map(i => i.id);
      const vectorInstanceId = searchInstanceIds.length === 1 ? searchInstanceIds[0] : undefined;

      const vResults = await store.searchByText(query, {
        pod,
        language,
        instanceId: vectorInstanceId,
        limit: candidateLimit,
        minScore: 0.3
      });

      vectorResults = vResults.map(r => ({
        docId: r.docId,
        score: r.score
      }));

      if (searchInstanceIds.length > 1) {
        const instanceIdSet = new Set(searchInstanceIds);
        vectorResults = vectorResults.filter(vr => {
          const item = itemsById.get(vr.docId);
          return item && instanceIdSet.has(item.instanceId);
        });
      }

      logger.debug(`Vector search returned ${vectorResults.length} results for "${query}"`);
    } catch (error) {
      logger.warn(`Vector search failed, using keyword only: ${error instanceof Error ? error.stack : error}`);
    }
  }

  // If no vector results, return keyword results directly
  if (vectorResults.length === 0) {
    return {
      searchMethod: 'keyword-only',
      keywordResults: kwResults.length,
      vectorResults: 0,
      vectorCount,
      results: kwResults.slice(0, limit).map((r, i) => ({
        ...r.item,
        source: 'keyword' as const,
        keywordRank: i + 1,
        vectorRank: null,
        keywordScore: r.keywordScore,
        vectorScore: 0,
        fusedScore: 0,
      }))
    };
  }

  // Fuse with RRF
  const fused = rrfFuse(kwResults, vectorResults, itemsById, limit);

  let filtered = fused.filter(c => {
    if (pod && c.item.pod !== pod) return false;
    if (type && c.item.type !== type) return false;
    if (language && c.item.language !== language) return false;
    return true;
  });

  // Optional cross-encoder rerank — reuses the same setting the code-search
  // pipeline uses (semanticSearch.crossEncoderReranker). Both target the
  // sidecar's `reranker` capability (e.g. Qwen3-Reranker-8B on vLLM).
  try {
    const semantic = readSemanticSettings();
    const xe = semantic?.crossEncoderReranker;
    if (xe?.enabled && filtered.length > 1) {
      const { callSidecarReranker } = await import('../embedding/sidecarRerankerClient.js');
      const topK = Math.min(xe.topK ?? 50, filtered.length);
      const head = filtered.slice(0, topK);
      const tail = filtered.slice(topK);
      const docs = head.map(c => buildDocText(c.item));
      const r = await callSidecarReranker(query, docs, { model: xe.model });
      if (r) {
        const scored = head.map((c, i) => ({ c, score: r.scores[i] ?? 0 }));
        // Blend cross-encoder score (70%) with the RRF fused score (30%) so
        // the fused signal still nudges ties.
        scored.sort((a, b) => (0.7 * b.score + 0.3 * b.c.fusedScore) - (0.7 * a.score + 0.3 * a.c.fusedScore));
        filtered = [...scored.map(s => ({ ...s.c, fusedScore: 0.7 * s.score + 0.3 * s.c.fusedScore })), ...tail];
      }
    }
  } catch (err) {
    console.warn('[docs-rerank] cross-encoder failed:', (err as Error).message);
  }

  return {
    searchMethod: 'hybrid',
    keywordResults: kwResults.length,
    vectorResults: vectorResults.length,
    vectorCount,
    results: filtered.map(c => ({
      ...c.item,
      source: (c.keywordRank !== null && c.vectorRank !== null ? 'both' :
               c.keywordRank !== null ? 'keyword' : 'vector') as 'keyword' | 'vector' | 'both',
      keywordRank: c.keywordRank,
      vectorRank: c.vectorRank,
      keywordScore: c.keywordScore,
      vectorScore: c.vectorScore,
      fusedScore: c.fusedScore,
    }))
  };
}

function buildDocText(item: LocalDocItem): string {
  return [
    item.name,
    item.signature ?? '',
    typeof item.description === 'string' ? item.description.slice(0, 800) : '',
  ].filter(Boolean).join('\n');
}

// Lightweight reader for the runtime config — kept inline so this module
// doesn't take a hard dependency on the admin settings layer.
function readSemanticSettings(): any {
  try {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const p = path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'))?.semanticSearch ?? null;
  } catch { return null; }
}

// ============================================
// Singleton
// ============================================

let hybridSearchInstance: { search: typeof hybridSearchLocalDocs } | null = null;

export function getDocsHybridSearchService() {
  if (!hybridSearchInstance) {
    hybridSearchInstance = { search: hybridSearchLocalDocs };
  }
  return hybridSearchInstance;
}
