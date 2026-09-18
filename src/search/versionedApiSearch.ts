/**
 * Versioned API Search - Unified MCP Tool
 *
 * A unified MCP tool enabling LLMs to query Fantom API documentation with
 * strict version filtering across three search modalities:
 * 1. API Documentation Search - Types, methods, functions, slots
 * 2. Code Search - AST-indexed definitions and signatures
 * 3. Code Sample Search - Usage examples and patterns
 *
 * Core Constraint: When invoked with version context, results MUST be
 * filtered to that exact version.
 */

import { createLogger } from '../utils/index.js';
import {
  resolveVersion,
  formatVersionContext,
  isVersionFilterCompatible
} from '../utils/versionResolver.js';
import { getFantomDatabase } from '../fantom/database.js';
import { getFantomFunctionSearchIndex } from '../fantom-code/searchIndex.js';
import type { FunctionSearchOptions } from '../fantom-code/types.js';
import { hybridSearchLocalDocsWithMeta, type HybridSearchMeta } from './docsHybridSearchService.js';
import { getCodeSampleExtractor } from './codeSampleExtractor.js';
import type { InstanceType } from '../fantom/types.js';
import { getPrismaClient } from '../db/prisma.js';
import { getSemanticSearchService } from '../embedding/semanticSearchService.js';
import { getLadybugQueryManager } from '../graph/ladybugQueryManager.js';

const logger = createLogger('versioned-api-search');

// ============================================
// Input/Output Types
// ============================================

/**
 * Input schema for searchVersionedApi tool
 */
export interface SearchVersionedApiInput {
  query: string;
  mode?: 'api' | 'code' | 'samples' | 'graph' | 'semantic' | 'all';
  version?: string;
  instanceId?: number;
  projectId?: number;
  sources?: Array<'local' | 'fantom-source'>;
  pod?: string;
  type?: 'type' | 'slot' | 'function' | 'method' | 'field' | 'tag' | 'example' | 'guide';
  language?: 'fantom' | 'axon';
  limit?: number;
  includeDeprecated?: boolean;
  // Graph-specific options
  maxDepth?: number;
  // Semantic-specific options
  includeGraphContext?: boolean;
}

/**
 * Version context in response
 */
export interface VersionContext {
  resolved: string | null;
  source: 'explicit' | 'instance' | 'active' | 'none';
  instanceId?: number;
  instanceName?: string;
  instanceType?: InstanceType;
  warning?: string;
}

/**
 * Summary of search results
 */
export interface SearchSummary {
  totalResults: number;
  resultsByMode: {
    api?: number;
    code?: number;
    samples?: number;
    graph?: number;
    semantic?: number;
  };
  resultsBySource: Record<string, number>;
  searchDuration: number;
  docsHybridSearch?: {
    method: 'keyword-only' | 'hybrid';
    vectorsAvailable: number;
  };
}

/**
 * A unified search result item
 */
export interface VersionedApiResult {
  id: string;
  mode: 'api' | 'code' | 'samples' | 'graph' | 'semantic';
  source: 'local' | 'fantom-source' | 'workflow' | 'graph' | 'semantic';
  sourceLabel?: string; // Human-readable source (e.g., "skyspark-3.1.8", "Fantom 1.0.80")

  name: string;
  qualifiedName?: string;
  pod?: string;
  parent?: string;

  elementType: 'type' | 'slot' | 'function' | 'method' | 'field' | 'tag' | 'example' | 'guide';
  language?: 'fantom' | 'axon';
  signature?: string;
  description?: string;
  url?: string;

  // Code-specific
  filePath?: string;
  lineNumber?: number;
  sourceCode?: string;

  // Sample-specific
  codeExample?: string;
  complexity?: 'simple' | 'medium' | 'complex';

  // Version metadata
  version?: string;
  versionCompatible: boolean;

  score: number;

  // Retrieval provenance (which system found this result)
  retrieval?: {
    source: 'keyword' | 'vector' | 'both';
    keywordRank: number | null;
    vectorRank: number | null;
    keywordScore: number;
    vectorScore: number;
    fusedScore: number;
  };
}

/**
 * Response from searchVersionedApi
 */
export interface SearchVersionedApiResponse {
  query: string;
  mode: 'api' | 'code' | 'samples' | 'graph' | 'semantic' | 'all';

  versionContext: VersionContext;

  summary: SearchSummary;

  results: VersionedApiResult[];
  warnings?: Array<{ source: string; message: string }>;
}

// ============================================
// Main Search Function
// ============================================

/**
 * Execute a unified versioned API search
 */
export async function searchVersionedApi(
  input: SearchVersionedApiInput
): Promise<SearchVersionedApiResponse> {
  const startTime = Date.now();
  const mode = input.mode || 'all';
  const limit = Math.min(input.limit || 10, 50);
  const sources = input.sources || ['local', 'fantom-source'];

  logger.info(`searchVersionedApi: query="${input.query}" mode=${mode} limit=${limit}`);

  // Step 1: Resolve version context
  const versionResolution = await resolveVersion({
    version: input.version,
    instanceId: input.instanceId
  });

  const versionContext = formatVersionContext(versionResolution);
  const targetVersion = versionResolution.version;

  logger.debug(`Version resolved: ${targetVersion} (source: ${versionResolution.source})`);

  // Step 2: Execute parallel searches based on mode
  const results: VersionedApiResult[] = [];
  const warnings: Array<{ source: string; message: string }> = [];
  const resultsByMode: { api?: number; code?: number; samples?: number; graph?: number; semantic?: number } = {};
  const resultsBySource: Record<string, number> = {};

  // Add version resolution warning if any
  if (versionResolution.warning) {
    warnings.push({ source: 'version', message: versionResolution.warning });
  }

  const searchPromises: Promise<void>[] = [];
  let docsHybridMeta: HybridSearchMeta | undefined;

  // API Documentation Search
  if ((mode === 'all' || mode === 'api') && sources.includes('local')) {
    searchPromises.push(
      searchApiDocs(input, targetVersion, limit)
        .then(({ results: apiResults, hybridMeta }) => {
          results.push(...apiResults);
          resultsByMode.api = apiResults.length;
          resultsBySource['local'] = (resultsBySource['local'] || 0) + apiResults.length;
          docsHybridMeta = hybridMeta;
        })
        .catch(err => {
          logger.warn(`API docs search failed: ${err}`);
          warnings.push({ source: 'local', message: String(err) });
        })
    );
  }

  // Code Search
  if ((mode === 'all' || mode === 'code') && sources.includes('fantom-source')) {
    searchPromises.push(
      searchCode(input, targetVersion, limit)
        .then(codeResults => {
          results.push(...codeResults);
          resultsByMode.code = codeResults.length;
          resultsBySource['fantom-source'] = (resultsBySource['fantom-source'] || 0) + codeResults.length;
        })
        .catch(err => {
          logger.warn(`Code search failed: ${err}`);
          warnings.push({ source: 'fantom-source', message: String(err) });
        })
    );
  }

  // Samples Search
  if (mode === 'all' || mode === 'samples') {
    searchPromises.push(
      searchSamples(input, targetVersion, limit)
        .then(sampleResults => {
          results.push(...sampleResults);
          resultsByMode.samples = sampleResults.length;
          for (const r of sampleResults) {
            resultsBySource[r.source] = (resultsBySource[r.source] || 0) + 1;
          }
        })
        .catch(err => {
          logger.warn(`Samples search failed: ${err}`);
          warnings.push({ source: 'samples', message: String(err) });
        })
    );
  }

  // Graph Search (callers/callees)
  if (mode === 'graph') {
    searchPromises.push(
      searchGraph(input, limit)
        .then(graphResults => {
          results.push(...graphResults);
          resultsByMode.graph = graphResults.length;
          resultsBySource['graph'] = graphResults.length;
        })
        .catch(err => {
          logger.warn(`Graph search failed: ${err}`);
          warnings.push({ source: 'graph', message: String(err) });
        })
    );
  }

  // Semantic Search (AI embeddings)
  if (mode === 'all' || mode === 'semantic') {
    searchPromises.push(
      searchSemantic(input, limit)
        .then(semanticResults => {
          results.push(...semanticResults);
          resultsByMode.semantic = semanticResults.length;
          resultsBySource['semantic'] = semanticResults.length;
        })
        .catch(err => {
          logger.warn(`Semantic search failed: ${err}`);
          warnings.push({ source: 'semantic', message: String(err) });
        })
    );
  }

  // Wait for all searches to complete (with timeout)
  await Promise.race([
    Promise.allSettled(searchPromises),
    new Promise<void>(resolve => setTimeout(resolve, 5000)) // 5s timeout
  ]);

  // Step 3: Merge and rank results
  const rankedResults = rankResults(results, input.query, targetVersion);

  // Apply final limit
  const finalResults = rankedResults.slice(0, limit);

  const searchDuration = Date.now() - startTime;

  return {
    query: input.query,
    mode,
    versionContext,
    summary: {
      totalResults: finalResults.length,
      resultsByMode,
      resultsBySource,
      searchDuration,
      ...(docsHybridMeta ? {
        docsHybridSearch: {
          method: docsHybridMeta.searchMethod,
          vectorsAvailable: docsHybridMeta.vectorCount
        }
      } : {})
    },
    results: finalResults,
    warnings: warnings.length > 0 ? warnings : undefined
  };
}

// ============================================
// Individual Search Functions
// ============================================

/**
 * Search API documentation (local instance docs)
 */
async function searchApiDocs(
  input: SearchVersionedApiInput,
  targetVersion: string | null,
  limit: number
): Promise<{ results: VersionedApiResult[]; hybridMeta?: HybridSearchMeta }> {
  const results: VersionedApiResult[] = [];

  // Map element type to LocalDocItem type
  let docType: 'type' | 'function' | 'tag' | 'slot' | 'chapter' | undefined;
  if (input.type) {
    if (input.type === 'method' || input.type === 'field') {
      docType = 'slot';
    } else if (input.type === 'guide') {
      docType = 'chapter';
    } else if (input.type === 'example') {
      docType = undefined; // Not directly mapped
    } else {
      docType = input.type as 'type' | 'function' | 'tag' | 'slot';
    }
  }

  let hybridMeta: HybridSearchMeta | undefined;

  try {
    const searchResult = await hybridSearchLocalDocsWithMeta(input.query, {
      instanceId: input.instanceId,
      pod: input.pod,
      type: docType,
      language: input.language,
      limit: limit * 3 // Get more to filter
    });
    hybridMeta = searchResult;
    const localResults = searchResult.results;

    for (const item of localResults) {
      // Check version compatibility
      const isCompatible = isVersionFilterCompatible(item.version, targetVersion);

      // SKIP incompatible versions when version filter is active
      if (targetVersion && !isCompatible) continue;

      // Build description with version context
      let description = item.description || '';
      if (item.instanceName && item.version) {
        description = description
          ? `${description} [${item.instanceName} ${item.version}]`
          : `[${item.instanceName} ${item.version}]`;
      }

      results.push({
        id: item.id,
        mode: 'api',
        source: 'local',
        sourceLabel: item.instanceName || 'Instance Docs',
        name: item.name,
        qualifiedName: item.qualifiedName,
        pod: item.pod,
        parent: item.parent,
        elementType: mapLocalDocType(item.type),
        language: item.language,
        signature: item.signature,
        description,
        url: item.url,
        version: item.version,
        versionCompatible: isCompatible,
        score: 0, // Will be calculated in ranking
        retrieval: item.source ? {
          source: item.source,
          keywordRank: item.keywordRank,
          vectorRank: item.vectorRank,
          keywordScore: item.keywordScore,
          vectorScore: item.vectorScore,
          fusedScore: item.fusedScore,
        } : undefined
      });

      // Stop if we have enough
      if (results.length >= limit) break;
    }
  } catch (error) {
    logger.warn(`Local docs search error: ${error}`);
  }

  return { results, hybridMeta };
}

/**
 * Search indexed source code
 */
async function searchCode(
  input: SearchVersionedApiInput,
  targetVersion: string | null,
  limit: number
): Promise<VersionedApiResult[]> {
  const results: VersionedApiResult[] = [];
  const searchIndex = getFantomFunctionSearchIndex();

  // Quick check - if index is empty, return early
  if (searchIndex.size === 0) {
    logger.debug('Code search index is empty - skipping code search');
    return results;
  }

  // Map input type to FunctionSearchOptions type
  let funcType: 'method' | 'field' | 'constructor' | undefined;
  if (input.type === 'method') funcType = 'method';
  else if (input.type === 'field') funcType = 'field';
  else if (input.type === 'function') funcType = 'method'; // Functions are methods in Fantom

  const options: FunctionSearchOptions = {
    limit: limit * 3, // Get more to filter
    instanceId: input.instanceId,
    type: funcType,
    isPublic: true, // Default to public only
    compatibleWith: targetVersion || undefined
  };

  const searchResults = searchIndex.search(input.query, options);

  // Get instance info for enriching results
  const db = getFantomDatabase();
  await db.initialize();

  // Cache instance lookups
  const instanceCache = new Map<number, { version?: string; name?: string; type?: string }>();

  for (const result of searchResults) {
    const func = result.function;
    const project = searchIndex.getProject(func.projectId);

    // Get instance info (cached)
    let instanceVersion: string | undefined;
    let instanceName: string | undefined;

    if (project?.instanceId) {
      if (!instanceCache.has(project.instanceId)) {
        const instance = await db.getInstanceById(project.instanceId);
        instanceCache.set(project.instanceId, {
          version: instance?.version,
          name: instance?.name,
          type: instance?.type
        });
      }
      const cached = instanceCache.get(project.instanceId);
      instanceVersion = cached?.version;
      instanceName = cached?.name;
    }

    // Check version compatibility
    const isCompatible = isVersionFilterCompatible(instanceVersion, targetVersion);

    // SKIP incompatible results when version filter is active
    if (targetVersion && !isCompatible) {
      continue;
    }

    // Map function type to element type
    let elementType: VersionedApiResult['elementType'] = 'method';
    if (func.type === 'field') elementType = 'field';
    else if (func.type === 'constructor') elementType = 'method';

    // Build description with version context
    let description = func.description || '';
    if (instanceName && instanceVersion) {
      description = description
        ? `${description} [${instanceName} ${instanceVersion}]`
        : `[${instanceName} ${instanceVersion}]`;
    }

    // Build source label: prefer project name, fall back to instance info
    const podName = project?.podMeta?.podName || project?.name;
    const sourceLabel = podName
      ? `${podName}${instanceVersion ? ` (${instanceVersion})` : ''}`
      : instanceName || 'Fantom Source';

    results.push({
      id: func.id,
      mode: 'code',
      source: 'fantom-source',
      sourceLabel,
      name: func.name,
      qualifiedName: func.qualifiedName,
      pod: podName,
      parent: func.className,
      elementType,
      language: 'fantom',
      signature: func.signature,
      description,
      filePath: func.filePath,
      lineNumber: func.lineNumber,
      sourceCode: func.sourceCode,
      version: instanceVersion,
      versionCompatible: isCompatible,
      score: result.score
    });

    // Stop if we have enough
    if (results.length >= limit) break;
  }

  return results;
}

/**
 * Search code samples (workflows and source examples)
 */
async function searchSamples(
  input: SearchVersionedApiInput,
  targetVersion: string | null,
  limit: number
): Promise<VersionedApiResult[]> {
  const results: VersionedApiResult[] = [];
  const extractor = getCodeSampleExtractor();

  // Check if code index is available for source code samples
  const searchIndex = getFantomFunctionSearchIndex();
  const includeSourceCode = searchIndex.size > 0;

  const searchResult = await extractor.search({
    query: input.query,
    limit,
    version: targetVersion || undefined,
    language: input.language === 'fantom' || input.language === 'axon' ? input.language : 'all',
    includeWorkflows: true,
    includeSourceCode // Only search source code if index has data
  });

  // Convert workflow samples to results
  for (const sample of searchResult.workflowSamples) {
    const isCompatible = isVersionFilterCompatible(sample.version, targetVersion);

    // Skip incompatible versions when filtering
    if (targetVersion && !isCompatible) continue;

    results.push({
      id: sample.id,
      mode: 'samples',
      source: 'workflow',
      sourceLabel: 'Workflow Guide',
      name: sample.workflowTitle,
      elementType: 'example',
      language: sample.language === 'fantom' || sample.language === 'axon' ? sample.language : undefined,
      description: sample.context,
      codeExample: sample.code,
      version: sample.version,
      versionCompatible: isCompatible,
      score: 0
    });
  }

  // Convert source examples to results
  for (const example of searchResult.samples) {
    const isCompatible = isVersionFilterCompatible(example.version, targetVersion);

    if (targetVersion && !isCompatible) continue;

    results.push({
      id: `example-${example.file}-${example.line}`,
      mode: 'samples',
      source: 'fantom-source',
      sourceLabel: example.version ? `Code (${example.version})` : 'Code Sample',
      name: example.description || 'Code Example',
      elementType: 'example',
      language: 'fantom',
      description: example.description,
      filePath: example.file,
      lineNumber: example.line,
      codeExample: example.code,
      complexity: example.complexity,
      version: example.version,
      versionCompatible: isCompatible,
      score: 0
    });
  }

  return results.slice(0, limit);
}

/**
 * Search using code graph (callers, related code)
 */
async function searchGraph(
  input: SearchVersionedApiInput,
  limit: number
): Promise<VersionedApiResult[]> {
  const results: VersionedApiResult[] = [];
  const graphQuery = getLadybugQueryManager();

  try {
    // First, find matching nodes by name pattern
    const nodes = await graphQuery.findNodesByPattern(
      input.query,
      input.projectId,
      limit * 2
    );

    for (const node of nodes.slice(0, limit)) {
      // Get metrics for context
      const metrics = await graphQuery.getMetrics(node.id);

      results.push({
        id: node.id,
        mode: 'graph',
        source: 'graph',
        sourceLabel: 'Code Graph',
        name: node.name,
        qualifiedName: node.qualifiedName,
        elementType: mapNodeType(node.nodeType),
        language: 'fantom',
        filePath: node.filePath,
        description: `Callers: ${metrics.callerCount}, Callees: ${metrics.calleeCount}`,
        version: undefined,
        versionCompatible: true,
        score: calculateGraphScore(metrics.callerCount, metrics.calleeCount)
      });
    }
  } catch (error) {
    logger.warn(`Graph search error: ${error}`);
  }

  return results;
}

/**
 * Search using semantic embeddings (AI-powered)
 */
async function searchSemantic(
  input: SearchVersionedApiInput,
  limit: number
): Promise<VersionedApiResult[]> {
  const results: VersionedApiResult[] = [];
  const prisma = getPrismaClient();
  const semanticSearch = getSemanticSearchService(prisma);

  try {
    const searchResults = await semanticSearch.search(input.query, {
      projectId: input.projectId,
      limit,
      includeGraphContext: input.includeGraphContext ?? true
    });

    for (const r of searchResults) {
      results.push({
        id: r.nodeId,
        mode: 'semantic',
        source: 'semantic',
        sourceLabel: 'Semantic Search',
        name: r.name,
        qualifiedName: r.qualifiedName,
        elementType: mapNodeType(r.nodeType),
        language: 'fantom',
        signature: r.signature,
        description: r.documentation || (r.callerCount !== undefined
          ? `Semantic match (${(r.semanticScore * 100).toFixed(0)}%) - ${r.callerCount} callers`
          : `Semantic match (${(r.semanticScore * 100).toFixed(0)}%)`),
        filePath: r.filePath,
        lineNumber: r.lineStart,
        version: undefined,
        versionCompatible: true,
        score: r.combinedScore
      });
    }
  } catch (error) {
    logger.warn(`Semantic search error: ${error}`);
  }

  return results;
}

/**
 * Map node type to element type
 */
function mapNodeType(nodeType: string): VersionedApiResult['elementType'] {
  switch (nodeType) {
    case 'type': return 'type';
    case 'method': return 'method';
    case 'field': return 'field';
    case 'constructor': return 'method';
    case 'function': return 'function';
    default: return 'function';
  }
}

/**
 * Calculate graph importance score
 */
function calculateGraphScore(callerCount: number, calleeCount: number): number {
  // Functions with more callers are more important
  // Normalize to 0-1 range
  const callerScore = Math.min(1, callerCount / 20);
  const calleeScore = Math.min(1, calleeCount / 30);
  return callerScore * 0.7 + calleeScore * 0.3;
}

// ============================================
// Ranking and Scoring
// ============================================

/**
 * Rank and score results
 */
function rankResults(
  results: VersionedApiResult[],
  query: string,
  targetVersion: string | null
): VersionedApiResult[] {
  const queryLower = query.toLowerCase();

  // Calculate scores
  for (const result of results) {
    let score = result.score || 0;

    // Text relevance (40%)
    score += calculateTextScore(queryLower, result) * 0.4;

    // Version match (25%)
    score += calculateVersionScore(result, targetVersion) * 0.25;

    // Source priority (20%)
    score += getSourcePriority(result.source) * 0.2;

    // Type/completeness (15%)
    score += calculateCompletenessScore(result) * 0.15;

    result.score = Math.round(score * 100) / 100;
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  // Deduplicate by qualifiedName, keeping highest score
  const seen = new Set<string>();
  const deduped: VersionedApiResult[] = [];

  for (const result of results) {
    const key = result.qualifiedName || result.name;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(result);
    }
  }

  return deduped;
}

/**
 * Calculate text relevance score with OR logic for multi-word queries
 */
function calculateTextScore(queryLower: string, result: VersionedApiResult): number {
  let score = 0;

  const nameLower = result.name.toLowerCase();
  const qualifiedLower = (result.qualifiedName || '').toLowerCase();
  const descLower = (result.description || '').toLowerCase();
  const signatureLower = (result.signature || '').toLowerCase();

  // Parse query into words for OR logic
  const queryWords = queryLower.trim().split(/\s+/).filter(w => w.length > 0);

  if (queryWords.length === 1) {
    // Single word query - original logic
    if (nameLower === queryLower) {
      score += 1.0;
    } else if (qualifiedLower === queryLower) {
      score += 0.9;
    } else if (nameLower.startsWith(queryLower)) {
      score += 0.7;
    } else if (nameLower.includes(queryLower)) {
      score += 0.5;
    } else if (descLower.includes(queryLower)) {
      score += 0.3;
    }
  } else {
    // Multi-word query - OR logic with smart scoring
    let matchedWords = 0;
    let nameMatches = 0;
    let descMatches = 0;

    for (const word of queryWords) {
      let wordMatched = false;

      if (nameLower.includes(word)) {
        wordMatched = true;
        nameMatches++;
        score += nameLower === word ? 0.5 : nameLower.startsWith(word) ? 0.4 : 0.3;
      }
      if (qualifiedLower.includes(word)) {
        wordMatched = true;
        score += 0.2;
      }
      if (signatureLower.includes(word)) {
        wordMatched = true;
        score += 0.15;
      }
      if (descLower.includes(word)) {
        wordMatched = true;
        descMatches++;
        score += 0.1;
      }

      if (wordMatched) matchedWords++;
    }

    // Bonus for matching multiple words
    const matchRatio = matchedWords / queryWords.length;
    score += matchRatio * 0.5;

    // Extra bonus if ALL words match
    if (matchedWords === queryWords.length) {
      score += 0.3;
    }

    // Name matches are more valuable
    score += nameMatches * 0.15;
  }

  return score;
}

/**
 * Calculate version match score
 */
function calculateVersionScore(result: VersionedApiResult, targetVersion: string | null): number {
  if (!targetVersion) return 0.5; // Neutral if no version filter

  if (result.versionCompatible) {
    // Exact version match gets full score
    if (result.version === targetVersion) {
      return 1.0;
    }
    // Compatible version gets partial score
    return 0.7;
  }

  return 0; // Not compatible
}

/**
 * Get source priority score
 */
function getSourcePriority(source: string): number {
  const priorities: Record<string, number> = {
    'local': 1.0,           // Local docs are most relevant
    'fantom-source': 0.9,   // Source code is very relevant
    'workflow': 0.7         // Workflow samples are useful
  };
  return priorities[source] || 0.5;
}

/**
 * Calculate completeness score
 */
function calculateCompletenessScore(result: VersionedApiResult): number {
  let score = 0;

  // Has signature
  if (result.signature) score += 0.3;

  // Has description
  if (result.description) score += 0.2;

  // Has source code or example
  if (result.sourceCode || result.codeExample) score += 0.3;

  // Type boost (types are more complete)
  if (result.elementType === 'type') score += 0.2;

  return score;
}

// ============================================
// Helper Functions
// ============================================

/**
 * Map LocalDocItem type to VersionedApiResult elementType
 */
function mapLocalDocType(
  type: 'type' | 'function' | 'tag' | 'slot' | 'example' | 'chapter'
): VersionedApiResult['elementType'] {
  switch (type) {
    case 'type': return 'type';
    case 'function': return 'function';
    case 'tag': return 'tag';
    case 'slot': return 'slot';
    case 'example': return 'example';
    case 'chapter': return 'guide';
    default: return 'type';
  }
}
