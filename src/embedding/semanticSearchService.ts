/**
 * Semantic Search Service - Combines embeddings with graph intelligence
 *
 * Provides enhanced code search that:
 * 1. Uses vector embeddings for semantic similarity
 * 2. Enriches results with graph context (callers, callees, related types)
 * 3. Re-ranks results based on graph importance
 */

import type { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';
import { createLogger } from '../utils/index.js';
import { selectEmbeddingProvider, isSidecarUsable, embedBatchFanout, type EmbeddingProvider } from './providers/embeddingProvider.js';
import { getEmbedCache } from './embedCache.js';
import { getHeavyJob } from './embedGate.js';
import { getSidecar } from '../sidecars/registry.js';
import { workerSplitOf } from '../openrouter/workerAttribution.js';
import { VectorStore, getVectorStore, type VectorSearchResult } from './vectorStore.js';
import { LadybugQueryManager, getLadybugQueryManager } from '../graph/ladybugQueryManager.js';
import type { GraphMetrics } from '../graph/types.js';
import { ladybugQuery } from '../graph/ladybugConnection.js';
import { applyQueryInstruction } from './queryInstruction.js';
import { embedRunStarted, embedRunProgress, embedRunFinished } from './autoPipelineBus.js';
import {
  rrfFuse, countChangedPositions, readHybridSettings, readRerankMode, readRerankCodeChars, rerankerSidecarUsable,
  keywordQueryVariants, HYBRID_CANDIDATES, type RerankMode, type ResultSources,
} from './hybridSearch.js';
import { buildEmbeddingItems, EMBED_TEXT_V3, type EmbeddingItem, type EmbeddingTextNode } from './embeddingText.js';

/**
 * v4 contextualiser step shared by every embed path (project build, shadow
 * re-embed, incremental reindex): LLM `about:` sentences merged in front of
 * the graph context. Advisory — any failure returns the graph context alone.
 */
export async function withLlmContext(
  projectId: number,
  nodes: Array<EmbeddingTextNode & { id: string }>,
  graphContext: Map<string, string>,
): Promise<Map<string, string>> {
  try {
    const { readContextualizeSettings, contextualizeNodes, mergeContexts } = await import('./embedContextualizer.js');
    if (!readContextualizeSettings().enabled) return graphContext;
    const { contexts } = await contextualizeNodes(projectId, nodes);
    return contexts.size ? mergeContexts(graphContext, contexts) : graphContext;
  } catch (err) {
    logger.warn(`[contextualize] project=${projectId} skipped: ${(err as Error).message.split('\n')[0].slice(0, 160)}`);
    return graphContext;
  }
}
import { buildEmbeddingContext } from './embeddingContext.js';
import { buildSyntheticItems } from './embedSynthetic.js';
import { graphSetting, projectFanout } from '../graph/graphSettings.js';

const logger = createLogger('semantic-search');

// ============================================
// Process-wide embed semaphore
// ============================================
// Caps concurrent buildProjectEmbeddings calls regardless of which endpoint
// initiated them. Reads settings.semanticSearch.parallelProjects fresh on
// each acquire so live config edits take effect on the next project.
function readParallelProjects(): number {
  try {
    const cfgPath = path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      const n = cfg?.semanticSearch?.parallelProjects;
      if (Number.isFinite(n) && n > 0) return Math.min(8, Math.max(1, Number(n)));
    }
  } catch { /* fall through */ }
  return 1;
}

let embedInFlight = 0;
const embedWaiters: Array<() => void> = [];

function semCrash(s: string): void {
  // Routed through logSink so writes are gated on settings.debug.enabled.
  // Imported lazily because this module is loaded before logSink in some
  // ESM resolution orders during tsx-watch dev mode.
  try {
    const { crashWrite } = require('../utils/logSink.js');
    crashWrite('EMBED_SEM', s);
  } catch { /* swallow */ }
}

async function acquireEmbedSlot(): Promise<void> {
  const limit = readParallelProjects();
  if (embedInFlight < limit) {
    embedInFlight++;
    semCrash(`ACQUIRE_FAST inFlight=${embedInFlight} limit=${limit} waiters=${embedWaiters.length}`);
    return;
  }
  semCrash(`ACQUIRE_BLOCK inFlight=${embedInFlight} limit=${limit} waiters=${embedWaiters.length}`);
  const acquireStart = Date.now();
  await new Promise<void>(resolve => embedWaiters.push(resolve));
  embedInFlight++;
  semCrash(`ACQUIRE_RESUME inFlight=${embedInFlight} waitedMs=${Date.now() - acquireStart}`);
}

function releaseEmbedSlot(): void {
  embedInFlight = Math.max(0, embedInFlight - 1);
  const next = embedWaiters.shift();
  semCrash(`RELEASE inFlight=${embedInFlight} waiters=${embedWaiters.length} woke=${next ? 1 : 0}`);
  if (next) next();
}

// ============================================
// Types
// ============================================

export interface SemanticSearchResult {
  nodeId: string;
  name: string;
  qualifiedName: string;
  nodeType: string;
  filePath: string;
  /** Citation line. With v3 chunked vectors this is the START OF THE BEST
   *  CHUNK, not necessarily the symbol's declaration line. */
  lineStart: number;
  /** End of the cited chunk (v3 rows only). */
  lineEnd?: number;
  /** Which chunk of the node matched (0 = declaration + doc) and how many exist. */
  chunkIndex?: number;
  chunkCount?: number;
  signature?: string;
  documentation?: string;

  // Scoring
  semanticScore: number;  // Vector similarity (0-1)
  graphScore: number;     // Graph importance (0-1)
  combinedScore: number;  // Weighted combination
  llmScore?: number;      // LLM rerank score (when reranker enabled)
  crossEncoderScore?: number;  // Cross-encoder relevance (when reranked)
  keywordScore?: number;  // FlexSearch symbol score (keyword-sourced hits)
  score?: number;         // Final ranking score (RRF-fused, normalized 0-1; = combinedScore)
  sources?: ResultSources;     // ['vector'] | ['keyword'] | ['bm25'] | ['both']

  // Graph context
  callerCount?: number;
  calleeCount?: number;
  containsCount?: number;    // Methods/fields contained (for types)
  usedByCount?: number;      // Nodes that reference this type
  extendsCount?: number;     // Subtypes that extend this
  implementsCount?: number;  // Types that implement this
  /** Project the hit lives in (cross-project searches). */
  projectId?: number;
  /** Same symbol (qualified name + file name) in other versions of the pod,
   *  folded under this best-ranked hit in all-projects searches. */
  alsoIn?: Array<{ projectId: number; label: string; nodeId: string; filePath: string; lineStart: number }>;
  /** Start of the matched chunk text; only set for the reranker, removed before results are returned. */
  chunkText?: string;
  relatedNodes?: Array<{
    id: string;
    name: string;
    relationship: string;
  }>;
}

/** Whole-search result cache: 64 MB cap (size = JSON length), 10 min TTL. */
const resultCache = new LRUCache<string, SemanticSearchResult[]>({
  maxSize: 64 * 1024 * 1024,
  sizeCalculation: v => Math.max(1, JSON.stringify(v).length),
  ttl: 10 * 60_000,
});
/** Drop every cached search result (index changed). */
export function clearSearchResultCache(): void { resultCache.clear(); }
export function searchResultCacheStats(): { entries: number; bytes: number } {
  return { entries: resultCache.size, bytes: resultCache.calculatedSize };
}

/**
 * Fold version copies: hits with the same qualified name and the same file
 * name in DIFFERENT projects collapse into the first (best-ranked) one, which
 * lists the others in `alsoIn`. Order of the remaining hits is kept. Hits
 * without a project, or from the same project as the leader, never fold.
 */
export function groupVersionCopies<T extends { nodeId: string; qualifiedName: string; filePath: string; lineStart: number; projectId?: number; alsoIn?: SemanticSearchResult['alsoIn'] }>(
  hits: T[], labelOf: (projectId: number) => string,
): T[] {
  const leaders = new Map<string, T>();
  const out: T[] = [];
  for (const h of hits) {
    if (h.projectId === undefined || !h.qualifiedName) { out.push(h); continue; }
    const key = `${h.qualifiedName}\u001f${(h.filePath || '').split('/').pop()}`;
    const lead = leaders.get(key);
    const seen = lead && (lead.projectId === h.projectId || lead.alsoIn?.some(a => a.projectId === h.projectId));
    if (!lead || seen) {
      if (!lead) leaders.set(key, h);
      out.push(h);
      continue;
    }
    (lead.alsoIn ??= []).push({ projectId: h.projectId, label: labelOf(h.projectId), nodeId: h.nodeId, filePath: h.filePath, lineStart: h.lineStart });
  }
  return out;
}

/** Embed-cache text version for QUERY vectors (documents use 1..N). */
export const QUERY_VECTOR_TEXT_VERSION = -1;

/** Saved query vectors in memory: model → (sha256 of query text → vector). */
const SAVED_QUERY_VECTORS_MAX = 5_000;
const savedQueryVectors = new Map<string, Map<string, Float32Array>>();
let savedQueryCount = 0;
function rememberQueryVector(model: string, hash: string, vec: Float32Array): void {
  if (savedQueryCount >= SAVED_QUERY_VECTORS_MAX) return;
  const m = savedQueryVectors.get(model) ?? new Map<string, Float32Array>();
  if (!m.has(hash)) savedQueryCount++;
  m.set(hash, vec);
  savedQueryVectors.set(model, m);
}

/**
 * Boot warm-up for the query path: choose the query encoder once (1.9 s on a
 * cold process, 10 ms after) and load the saved query vectors into memory, so
 * the first search neither waits for provider discovery nor reads the embed
 * cache table. Best effort; never throws.
 */
export async function warmSearchAtBoot(): Promise<{ encoderMs: number; vectors: number; loadMs: number; encoderOk: boolean; vectorsOk: boolean }> {
  const t0 = Date.now();
  let encoderOk = true;
  try {
    const { selectQueryEmbeddingProvider } = await import('./providers/embeddingProvider.js');
    await selectQueryEmbeddingProvider('code');
  } catch (e) { encoderOk = false; logger.debug(`[search] boot encoder choice failed: ${(e as Error).message}`); }
  const encoderMs = Date.now() - t0;
  const t1 = Date.now();
  let vectorsOk = true;
  try {
    const loaded = await getEmbedCache().loadVersion(QUERY_VECTOR_TEXT_VERSION, SAVED_QUERY_VECTORS_MAX);
    for (const [model, m] of loaded) for (const [h, v] of m) rememberQueryVector(model, h, v);
  } catch (e) { vectorsOk = false; logger.debug(`[search] loading saved query vectors failed: ${(e as Error).message}`); }
  return { encoderMs, vectors: savedQueryCount, loadMs: Date.now() - t1, encoderOk, vectorsOk };
}

let warmupRun: Promise<void> | null = null;
/** The warm-up attempt running right now (not the retry wait between attempts). */
let warmupAttempt: Promise<unknown> | null = null;
/** Longest a query waits for an in-flight boot warm-up before embedding. */
const WARMUP_WAIT_MS = 1_500;
let warmupDone = false;
/**
 * Run warmSearchAtBoot as soon as the HTTP server is up, retrying while the
 * encoder or the embed cache is not ready yet (cloud keys, sidecars and the
 * vector db come up during init). Single-flight: a second call (e.g. after
 * init) joins the run in flight or does nothing once done. Never throws.
 */
export function startSearchWarmup(
  log: (msg: string) => void,
  opts: { attempts?: number; delayMs?: number; warm?: typeof warmSearchAtBoot } = {},
): Promise<void> {
  if (warmupDone) return Promise.resolve();
  if (warmupRun) return warmupRun;
  const attempts = opts.attempts ?? 12;
  const delayMs = opts.delayMs ?? 15_000;
  const warm = opts.warm ?? warmSearchAtBoot;
  warmupRun = (async () => {
    for (let i = 1; i <= attempts; i++) {
      try {
        const attempt = warm();
        warmupAttempt = attempt;
        const r = await attempt.finally(() => { if (warmupAttempt === attempt) warmupAttempt = null; });
        if (r.encoderOk && r.vectorsOk) {
          warmupDone = true;
          log(`Search warm-up: encoder ${r.encoderMs}ms, ${r.vectors} saved query vectors in ${r.loadMs}ms (attempt ${i})`);
          return;
        }
        if (i === attempts) log(`Search warm-up incomplete after ${i} attempts (encoder ${r.encoderOk ? 'ok' : 'not ready'}, saved vectors ${r.vectorsOk ? 'ok' : 'not ready'}); searches resolve them on first use`);
      } catch { /* warm never throws; belt and braces */ }
      if (i < attempts) await new Promise(res => setTimeout(res, delayMs).unref?.());
    }
  })().finally(() => { warmupRun = null; });
  return warmupRun;
}
/** Test seam. */
export function __resetSearchWarmup(): void { warmupRun = null; warmupDone = false; warmupAttempt = null; }

/** Test seam. */
export function __resetSavedQueryVectors(): void { savedQueryVectors.clear(); savedQueryCount = 0; }

/**
 * Stale-id rescue: the graph node for a vector row whose id no longer exists.
 * Same qualified name AND file; among overloads/duplicates, the one whose
 * declaration line is nearest the row's line. Undefined when none match.
 */
export function matchStaleRow<N extends { qualifiedName: string; filePath: string; lineStart: number }>(
  row: { qualifiedName?: string; filePath?: string; lineStart?: number },
  nodes: N[],
): N | undefined {
  const cands = nodes.filter(n => n.qualifiedName === row.qualifiedName && n.filePath === row.filePath);
  if (cands.length === 0) return undefined;
  const line = row.lineStart ?? 0;
  return cands.reduce((a, b) => Math.abs(b.lineStart - line) < Math.abs(a.lineStart - line) ? b : a);
}

/** Run `fn` over `items`, at most `limit` at once. */
export async function forEachBounded<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export interface SemanticSearchOptions {
  projectId?: number;
  /** Restrict to these projects (a version group, see src/projects/versionGroup.ts).
   *  Used only when projectId is not set; hits are enriched from each hit's own
   *  per-project graph db, like an unscoped search. */
  projectIds?: number[];
  nodeType?: string;
  limit?: number;
  minScore?: number;
  includeGraphContext?: boolean;  // Include callers/callees in results
  /**
   * Wall-clock time (ms since epoch) after which the graph step (metrics +
   * related nodes) stops: hits still come back, without graph data. The
   * graph step was measured at 103 s of one ask while indexing ran. A
   * LadybugDB read cannot be cancelled, so an abandoned one finishes in the
   * background; no NEW graph read starts after the deadline.
   */
  graphDeadlineAt?: number;
  /** Told once when `graphDeadlineAt` cut the graph step short. */
  onGraphCapped?: (info: { afterMs: number; skippedRelated: number; metricsCut: boolean }) => void;
  /**
   * Pull per-hit caller/callee COUNTS from the graph (default true). They feed
   * the graph score and the result's metrics; the RLM loop never reads them
   * (formatHitForRlm renders name/type/file/snippet) yet paid for them: 50
   * candidates over ~50 project stores = open → evict → reopen against a
   * 16-connection pool, 4–10 s per search, 136 opens per ask (2026-09-30).
   * false → zero metrics, graphWeight contributes 0, no graph store is opened.
   */
  includeGraphMetrics?: boolean;
  graphWeight?: number;           // Weight for graph score (0-1, default 0.3)
  llmReranker?: import('./llmReranker.js').LLMRerankerOptions;
  crossEncoderReranker?: import('./crossEncoderReranker.js').CrossEncoderRerankerOptions;
  /** Per-request override of semanticSearch.hybrid.enabled (RRF vector ⊕ keyword). */
  hybrid?: boolean;
  /** Per-request override of semanticSearch.rerank ('auto' | 'on' | 'off'). */
  rerank?: RerankMode;
  /** Per-request override of semanticSearch.rerankCodeChars (0 = off). */
  rerankCodeChars?: number;
  /** Per-request (A/B only): which part of the chunk text the reranker reads. */
  rerankCodeMode?: 'all' | 'body' | 'missing-doc';
  /** Per-request (A/B only): cross-encoder weight in the final score (default 0.7). */
  rerankXeWeight?: number;
  /** Cross-project searches: fold version copies of one symbol under the
   *  best hit (default true). Ignored for single-project searches. */
  groupVersions?: boolean;
}

// ============================================
// Semantic Search Service
// ============================================

export class SemanticSearchService {
  private _embeddingService: EmbeddingProvider | null = null;
  private vectorStore: VectorStore;
  // Used only for project metadata (name/path/README) of the v3 file/project rows.
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    // Provider resolution is lazy — strict-sidecar mode would otherwise
    // throw at agent construction (before the boot-time sidecar gate has
    // resolved). The first call to `embeddingService` getter resolves it
    // and propagates errors through the caller's try/catch instead.
    this.vectorStore = getVectorStore(prisma);
    this.prisma = prisma;
  }

  private _embeddingServiceAt = 0;
  private static readonly PROVIDER_TTL_MS = 60_000;

  private get embeddingService(): EmbeddingProvider {
    // Re-resolve periodically and whenever the bound sidecar is no longer
    // usable. A provider cached once at first use kept pointing at a sidecar
    // whose host had gone away (EHOSTDOWN on every query for hours) even though
    // the registry had long since marked it stale and a healthy replacement
    // had registered.
    const cur = this._embeddingService as (EmbeddingProvider & { getSidecarId?: () => string }) | undefined;
    const age = Date.now() - this._embeddingServiceAt;
    let stale = !cur || age > SemanticSearchService.PROVIDER_TTL_MS;
    if (!stale && cur?.getSidecarId) {
      const sc = getSidecar(cur.getSidecarId());
      if (!sc || !isSidecarUsable(sc)) stale = true;
    }
    if (stale) {
      this._embeddingService = selectEmbeddingProvider('code');
      this._embeddingServiceAt = Date.now();
    }
    return this._embeddingService!;
  }

  private _queryEncoder: EmbeddingProvider | null = null;
  private _queryEncoderAt = 0;

  /**
   * The encoder used to embed a QUERY — not the same question as which
   * provider builds the corpus.
   *
   * It was the same question until "OpenRouter only" existed, because
   * `selectEmbeddingProvider` never constructs a cloud provider: whatever the
   * policy, every query was embedded on a local host. Under a cloud-built
   * index that is the 0.976-cosine mismatch applied to every search, forever,
   * with no error to attribute the bad ranking to. So this asks the policy,
   * and under "OpenRouter only" it throws `CloudOnlyUnavailableError` rather
   * than handing back something that runs.
   *
   * The staleness check is INSIDE the resolve, not around it: a provider
   * cached past a policy change has the same shape of bug as one cached past
   * a host going away, which is what the TTL was added for in the first place.
   */
  private async queryEncoder(): Promise<EmbeddingProvider> {
    const cur = this._queryEncoder as (EmbeddingProvider & { getSidecarId?: () => string }) | null;
    const age = Date.now() - this._queryEncoderAt;
    let stale = !cur || age > SemanticSearchService.PROVIDER_TTL_MS;
    if (!stale && cur?.getSidecarId) {
      const id = cur.getSidecarId();
      // A cloud provider's id is `or:<sidecarId>:<role>` and has no registry
      // row of its own; its health is the gate's verdict, re-read on resolve.
      if (!id.startsWith('or:')) {
        const sc = getSidecar(id);
        if (!sc || !isSidecarUsable(sc)) stale = true;
      }
    }
    if (stale) {
      const { selectQueryEmbeddingProvider } = await import('./providers/embeddingProvider.js');
      // Deliberately not wrapped: a CloudOnlyUnavailableError must reach the
      // caller. Swallowing it here and using the previous encoder would be the
      // silent local fallback this exists to prevent.
      this._queryEncoder = await selectQueryEmbeddingProvider('code');
      this._queryEncoderAt = Date.now();
    }
    return this._queryEncoder!;
  }

  /** Per-project query manager when projectId given; otherwise legacy. */
  private graph(projectId?: number): LadybugQueryManager {
    return projectId !== undefined
      ? getLadybugQueryManager(projectId)
      : getLadybugQueryManager();
  }

  /**
   * Search for code using natural language query
   */
  async search(
    query: string,
    options: SemanticSearchOptions = {}
  ): Promise<SemanticSearchResult[]> {
    // Whole-result cache. Keyed by query, every option that changes the
    // answer, the code table version and the rerank/hybrid settings. A capped
    // (partial) search is never stored. Cleared on any table swap/reset.
    // Resolve the query encoder first: a policy refusal (cloud-only, none
    // available) must surface even for a cached query, and the model is part
    // of the key.
    const encoder = await this.queryEncoder();
    const key = await this.resultCacheKey(query, options, encoder.getModelName());
    if (key) {
      const hit = resultCache.get(key);
      if (hit) { logger.info(`[search] "${query.slice(0, 40)}" project=${options.projectId ?? 'all'} result cache hit`); return structuredClone(hit); }
    }
    let capped = false;
    const out = await this.searchUncached(query, {
      ...options,
      onGraphCapped: info => { capped = true; options.onGraphCapped?.(info); },
    });
    if (key && !capped) resultCache.set(key, structuredClone(out));
    return out;
  }

  /** Cache key for `search`, or undefined (no caching) if the table is unreadable. */
  private async resultCacheKey(query: string, options: SemanticSearchOptions, model = ''): Promise<string | undefined> {
    // Unit tests must not open the real vector table; cache tests stub this.
    if (process.env.JEST_WORKER_ID) return undefined;
    try {
      const { getLanceTable, getActiveCodeTableName, codeTableGeneration } = await import('./lanceConnection.js');
      const version = await (await getLanceTable()).version();
      const { graphDeadlineAt: _d, onGraphCapped: _c, ...rest } = options;
      return JSON.stringify([query, rest, model, getActiveCodeTableName(), version, codeTableGeneration(), readRerankMode(), readHybridSettings(), readRerankCodeChars()]);
    } catch { return undefined; }
  }

  private async searchUncached(
    query: string,
    options: SemanticSearchOptions = {}
  ): Promise<SemanticSearchResult[]> {
    const {
      projectId,
      nodeType,
      limit = 10,
      // No default here: the store applies `semanticSearch.minScore` if set,
      // else no absolute floor. The old 0.3 was calibrated for jina-code; with
      // qwen3-embedding cloud vectors real hits score 0.20–0.34 and the floor
      // returned zero rows for valid queries (see readMinScore()).
      minScore,
      includeGraphContext = true,
      includeGraphMetrics = true,
      graphWeight = 0.3
    } = options;

    logger.debug(`Semantic search: "${query}" (project=${projectId}, type=${nodeType})`);

    // Hybrid (vector ⊕ keyword, RRF) — per-request override > runtime setting.
    const hybridCfg = readHybridSettings();
    const codeChars = options.rerankCodeChars ?? readRerankCodeChars();
    const hybridOn = options.hybrid ?? hybridCfg.enabled;

    // 1. Generate query embedding. Instruction-tuned models (Qwen3-Embedding)
    //    get the task instruction on the QUERY side only; documents were
    //    embedded raw, so this needs no re-embed.
    //
    //    Under "OpenRouter only" this resolves to a cloud provider and costs a
    //    round trip per search rather than milliseconds; if none can serve it
    //    throws, and the search fails with the reason named. That is
    //    deliberate — encoding the query locally against a cloud-built index
    //    would return ranked results that look fine and are not.
    const provider = await this.queryEncoder();
    await provider.initialize();
    const queryText = applyQueryInstruction(query, provider.getModelName(), 'code');
    // Embed a query ONCE. An RLM tool call searches the asked project and
    // every workspace sibling with the same string; without this the same
    // text went to the cloud embedder five times per call, fifteen times
    // across three concurrent calls, and round-2 searches took 51s.
    const tEmbed0 = Date.now();
    const queryEmbedding = await this.embedQueryCached(provider, queryText);
    const embedMs = Date.now() - tEmbed0;

    // 2. Vector search. Hybrid mode pulls a fixed candidate pool (top 50) so the
    //    fusion + reranker have enough to work with; legacy mode keeps limit*2.
    const tAnn0 = Date.now();
    const projectIds = projectId === undefined && options.projectIds?.length ? options.projectIds : undefined;
    let vectorResults = await this.vectorStore.search(queryEmbedding, {
      projectId,
      projectIds,
      nodeType,
      limit: hybridOn ? Math.max(HYBRID_CANDIDATES, limit) : limit * 2,
      minScore,
      // Chunk text only when the reranker reads it (extra column I/O otherwise).
      ...(codeChars > 0 ? { includeText: true } : {}),
    });

    const annMs = Date.now() - tAnn0;
    // 2b. Keyword (FlexSearch symbol index) candidates — same project scope.
    const tKw0 = Date.now();
    let keywordHits: SemanticSearchResult[] = [];
    if (hybridOn) {
      try {
        keywordHits = await this.keywordCandidates(query, { projectId, projectIds, nodeType, limit: HYBRID_CANDIDATES, graphWeight, includeGraphMetrics });
      } catch (err) {
        logger.warn(`[hybrid] keyword search failed, vector-only: ${(err as Error).message}`);
      }
    }
    const keywordMs = Date.now() - tKw0;
    // 2c. BM25 over the stored embed text (v4 tables; empty otherwise). Exact
    //     identifiers and tags — `ph.lib`, `xeto.bindings`, an error string —
    //     that the vector leg blurs and the symbol index never saw.
    const tBm0 = Date.now();
    let bm25Results: VectorSearchResult[] = [];
    if (hybridOn) {
      try {
        bm25Results = await this.vectorStore.textSearch(query, { projectId, projectIds, nodeType, limit: HYBRID_CANDIDATES, ...(codeChars > 0 ? { includeText: true } : {}) });
      } catch (err) {
        logger.warn(`[hybrid] bm25 search failed, continuing without it: ${(err as Error).message}`);
      }
    }
    const bm25Ms = Date.now() - tBm0;

    logger.info(`[search] "${query.slice(0, 60)}" project=${projectId ?? (projectIds ? `group(${projectIds.length})` : 'all')} vector=${vectorResults.length} keyword=${keywordHits.length} bm25=${bm25Results.length} dims=${queryEmbedding?.length ?? 0} embedMs=${embedMs} annMs=${annMs} keywordMs=${keywordMs} bm25Ms=${bm25Ms}`);
    if (vectorResults.length === 0 && keywordHits.length === 0 && bm25Results.length === 0) {
      return [];
    }

    // BM25 hits join the graph the same way vector hits do (node details,
    // metrics, chunk citation). Rows the vector leg already returned keep
    // the vector's score; the rest carry a semanticScore of 0 and earn their
    // place through the fusion rank only.
    const vectorIds = new Set(vectorResults.map(r => r.nodeId));
    const bm25Only = bm25Results.filter(r => !vectorIds.has(r.nodeId)).map(r => ({ ...r, score: 0, distance: 1 }));
    const bm25Order = new Map(bm25Results.map((r, i) => [r.nodeId, i]));
    const joinedVector = [...vectorResults, ...bm25Only];

    // 3. Fetch node details. For a project-scoped search use that project's db.
    //    For a CROSS-project search (projectId undefined) the legacy shared db
    //    is stale/partial and drops most nodes (→ empty answers), so enrich each
    //    hit from the per-project db it actually lives in, keyed by the
    //    project_id LanceDB stored on the vector row.
    vectorResults = joinedVector;
    const tFetch0 = Date.now();
    const nodeIds = vectorResults.map(r => r.nodeId);
    let nodes: Awaited<ReturnType<typeof this.fetchNodesByIds>>;
    // Projects whose graph store failed the node fetch. Their hits fall back
    // to the vector row's own columns instead of being dropped.
    const graphFailed = new Set<number | undefined>();
    // Metrics read during the cross-project fetch, per project.
    const earlyMetrics = new Map<number, Map<string, GraphMetrics>>();
    // Stale-id rescue state (see 3b). Cross-project searches fill it during
    // the fetch; projects already handled there are skipped in 3b.
    const rekeyed = new Map<string, string>(); // vector id → graph id
    const rescuedPids = new Set<number | undefined>();
    const isStaleCandidate = (vr: (typeof vectorResults)[number]) => !!vr.qualifiedName && !!vr.filePath
      && vr.nodeType !== 'file' && vr.nodeType !== 'project';
    const fetchOrDegrade = async (ids: string[], pid?: number) => {
      try {
        return await this.fetchNodesByIds(ids, pid);
      } catch (err) {
        graphFailed.add(pid);
        logger.warn(`[search] graph node fetch failed for project ${pid ?? 'shared'}; using vector rows only: ${(err as Error).message}`);
        return [];
      }
    };
    if (projectId !== undefined) {
      nodes = await fetchOrDegrade(nodeIds, projectId);
    } else {
      const byProject = new Map<number, string[]>();
      const noPid: string[] = [];
      for (const vr of vectorResults) {
        if (typeof vr.projectId === 'number') {
          const arr = byProject.get(vr.projectId) ?? [];
          arr.push(vr.nodeId);
          byProject.set(vr.projectId, arr);
        } else {
          noPid.push(vr.nodeId);
        }
      }
      nodes = [];
      // A few projects at a time (projectFanout, <= half the pool cap), not one after another:
      // an all-project search spans dozens of per-project stores.
      // Metrics are read in the same visit, while the store is open: a second
      // pass over dozens of stores re-opens each one (pool cap 8 → evicted).
      // The stale-id rescue runs in this visit too, so each store opens once.
      await forEachBounded([...byProject], projectFanout(), async ([pid, ids]) => {
        const found = await fetchOrDegrade(ids, pid);
        nodes.push(...found);
        if (graphFailed.has(pid)) return;
        const have = new Set(found.map(n => n.id));
        const stale = vectorResults.filter(vr => vr.projectId === pid && isStaleCandidate(vr) && !have.has(vr.nodeId));
        if (stale.length > 0) {
          const byQn = await this.fetchNodesByQn(stale.map(r => r.qualifiedName as string), pid).catch(() => []);
          for (const vr of stale) {
            const best = matchStaleRow(vr, byQn);
            if (!best) continue;
            rekeyed.set(vr.nodeId, best.id);
            if (!have.has(best.id)) { have.add(best.id); found.push(best); nodes.push(best); }
          }
        }
        rescuedPids.add(pid);
        const dl = options.graphDeadlineAt;
        if (includeGraphMetrics && found.length > 0 && (dl === undefined || Date.now() < dl)) {
          try { earlyMetrics.set(pid, await this.graph(pid).getMetricsBatch(found.map(n => n.id))); }
          catch { /* the metrics pass below retries this project */ }
        }
      });
      if (noPid.length > 0) {
        nodes.push(...await fetchOrDegrade(noPid));
      }
    }

    const nodeMap = new Map(nodes.map(n => [n.id, n]));

    // 3b. Stale-id rescue. Vector rows embedded before .fan moved to the
    //     tree-sitter parser (e6627ce) carry md5(file:qn) ids; the rebuilt graph
    //     uses md5(file:qn:line). Re-join those rows on (qualified_name,
    //     file_path), picking the node nearest the row's line, and re-key the
    //     hit to the graph id so metrics/related work.
    {
      const stale = vectorResults.filter(vr => !nodeMap.has(vr.nodeId) && isStaleCandidate(vr)
        && !rekeyed.has(vr.nodeId)
        && !rescuedPids.has(projectId ?? vr.projectId)
        && !graphFailed.has(projectId ?? vr.projectId));
      const byPid = new Map<number | undefined, typeof stale>();
      for (const vr of stale) {
        const pid = projectId ?? vr.projectId;
        const arr = byPid.get(pid) ?? [];
        arr.push(vr);
        byPid.set(pid, arr);
      }
      await forEachBounded([...byPid], projectFanout(), async ([pid, rows]) => {
        const found = await this.fetchNodesByQn(rows.map(r => r.qualifiedName as string), pid).catch(() => []);
        for (const vr of rows) {
          const best = matchStaleRow(vr, found);
          if (!best) continue;
          rekeyed.set(vr.nodeId, best.id);
          nodeMap.set(best.id, best);
        }
      });
      if (rekeyed.size > 0) {
        vectorResults = vectorResults.map(vr => rekeyed.has(vr.nodeId) ? { ...vr, nodeId: rekeyed.get(vr.nodeId)! } : vr);
        // Two chunks of one stale symbol can now share an id: keep the best.
        const seen = new Set<string>();
        vectorResults = vectorResults.filter(vr => {
          const k = `${vr.projectId ?? ''}:${vr.nodeId}:${vr.chunkIndex ?? 0}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }
    }
    // Per-node project for cross-project metrics/related-node enrichment.
    const pidByNode = new Map(vectorResults.map(r => [r.nodeId, r.projectId]));

    // 4. Calculate graph scores and build results
    const results: SemanticSearchResult[] = [];
    // Join accounting: a vector hit whose node_id is not in this project's
    // graph db is dropped below. When that happens to EVERY hit the caller
    // sees "no results" for a query the index answered — so say so, with
    // what was dropped, instead of returning [] silently.
    const dropped: Array<{ id: string; type?: string; qn?: string }> = [];
    const noGraph: Array<{ id: string; type?: string; qn?: string }> = [];
    // Metrics for every joined node in ONE batch per project (2 queries),
    // not getMetrics() per hit (9 queries each, in a loop).
    const metricsMaps = new Map<number, Map<string, GraphMetrics>>();
    const fetchMs = Date.now() - tFetch0;
    const tJoin0 = Date.now();
    const graphDeadlineAt = options.graphDeadlineAt;
    let metricsCut = false;
    let skippedRelated = 0;
    const syntheticIds = new Set<string>();
    // Wait for `work` until the graph deadline; past it, give up and return
    // `fallback`. The abandoned read keeps running, so its rejection is caught.
    const untilGraphDeadline = async <T,>(work: Promise<T>, fallback: T): Promise<{ v: T; cut: boolean }> => {
      if (graphDeadlineAt === undefined) return { v: await work, cut: false };
      const ms = graphDeadlineAt - Date.now();
      if (ms <= 0) { work.catch(() => undefined); return { v: fallback, cut: true }; }
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<{ v: T; cut: boolean }>(res => { timer = setTimeout(() => res({ v: fallback, cut: true }), ms); });
      try {
        return await Promise.race([work.then(v => ({ v, cut: false })), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
        work.catch(() => undefined);
      }
    };
    if (includeGraphMetrics) {
      const idsByPid = new Map<number, string[]>();
      for (const vr of vectorResults) {
        const node = nodeMap.get(vr.nodeId);
        if (!node) continue;
        const pid = projectId ?? pidByNode.get(vr.nodeId) ?? -1;
        const arr = idsByPid.get(pid) ?? [];
        arr.push(node.id);
        idsByPid.set(pid, arr);
      }
      // Bounded fan-out. A version-group search (50 candidates over up to 62
      // per-project graph dbs) fired one open per project at once; with the
      // pool capped at FANTOM_GRAPH_MAX_OPEN=8 that is open → evict → reopen
      // for the whole batch. Four at a time keeps every open inside the cap.
      // Projects whose metrics the fetch already read: keep those, and query
      // only the ids it did not cover (nodes found by the stale-id rescue).
      for (const [pid, ids] of [...idsByPid]) {
        const early = earlyMetrics.get(pid);
        if (!early) continue;
        metricsMaps.set(pid, early);
        const rest = ids.filter(id => !early.has(id));
        if (rest.length === 0) idsByPid.delete(pid); else idsByPid.set(pid, rest);
      }
      const pids = [...idsByPid];
      const METRICS_CONCURRENCY = projectFanout();
      const allMetrics = (async () => {
        for (let i = 0; i < pids.length; i += METRICS_CONCURRENCY) {
          if (graphDeadlineAt !== undefined && Date.now() > graphDeadlineAt) { metricsCut = true; return; }
          await Promise.all(pids.slice(i, i + METRICS_CONCURRENCY).map(async ([pid, ids]) => {
            try {
              const m = await this.graph(pid === -1 ? undefined : pid).getMetricsBatch(ids);
              const prev = metricsMaps.get(pid);
              if (prev) for (const [k, v] of m) prev.set(k, v); else metricsMaps.set(pid, m);
            } catch { if (!metricsMaps.has(pid)) metricsMaps.set(pid, new Map()); }
          }));
        }
      })();
      if ((await untilGraphDeadline(allMetrics, undefined)).cut) metricsCut = true;
    }
    const metricsMs = Date.now() - tJoin0;
    const zeroMetrics = (id: string): GraphMetrics => ({
      nodeId: id, incomingEdgeCount: 0, outgoingEdgeCount: 0, callerCount: 0, calleeCount: 0,
      containsCount: 0, usedByCount: 0, extendsCount: 0, implementsCount: 0, depth: 0,
    });

    for (const vr of vectorResults) {
      let node = nodeMap.get(vr.nodeId);
      // v3 file:/project: rows have no CodeNode — build the hit from the row's
      // denormalised columns (qualified_name / file_path) instead of dropping it.
      // Same when the hit's graph store failed: keep the vector hit.
      // A symbol row whose node is gone from the graph (stale id that the
      // rescue above could not re-join) is also kept, without graph data: the
      // row still names the file and the matched chunk.
      const synthetic = !node && !!vr.qualifiedName;
      if (!node) {
        if (!synthetic) { dropped.push({ id: vr.nodeId, type: vr.nodeType, qn: vr.qualifiedName }); continue; }
        if (vr.nodeType !== 'file' && vr.nodeType !== 'project' && !graphFailed.has(projectId ?? vr.projectId)) {
          noGraph.push({ id: vr.nodeId, type: vr.nodeType, qn: vr.qualifiedName });
        }
        const qn = vr.qualifiedName as string;
        node = {
          id: vr.nodeId,
          name: vr.nodeType === 'file' ? (qn.split('::').pop() || qn).split('/').pop() || qn : qn,
          qualifiedName: qn,
          nodeType: vr.nodeType as string,
          filePath: vr.filePath ?? '',
          lineStart: 1,
          signature: null,
          documentation: null,
        };
      }

      // Enrich from the hit's own project db when doing a cross-project search.
      const enrichPid = projectId ?? pidByNode.get(vr.nodeId);

      // Get graph metrics (none for synthetic rows — nothing in the graph).
      const metrics = synthetic
        ? zeroMetrics(node.id)
        : (metricsMaps.get(enrichPid ?? -1)?.get(node.id) ?? zeroMetrics(node.id));

      // Calculate graph score based on node type
      const isTypeNode = ['type', 'class', 'mixin', 'enum', 'facet'].includes(node.nodeType);
      const graphScore = isTypeNode
        ? this.calculateTypeGraphScore(metrics)
        : this.calculateGraphScore(metrics.callerCount);

      // Combine scores
      const combinedScore = (1 - graphWeight) * vr.score + graphWeight * graphScore;

      const result: SemanticSearchResult = {
        nodeId: node.id,
        name: node.name,
        qualifiedName: node.qualifiedName,
        nodeType: node.nodeType,
        filePath: node.filePath,
        // v3: cite the chunk that matched (its own range), else the declaration.
        lineStart: vr.lineStart ?? node.lineStart ?? 1,
        lineEnd: vr.lineEnd,
        chunkIndex: vr.chunkIndex,
        chunkCount: vr.chunkCount,
        chunkText: codeChars > 0 ? vr.text?.slice(0, codeChars) : undefined,
        signature: node.signature ?? undefined,
        documentation: node.documentation ?? undefined,
        semanticScore: vr.score,
        graphScore,
        combinedScore,
        callerCount: metrics.callerCount,
        calleeCount: metrics.calleeCount,
        containsCount: metrics.containsCount,
        usedByCount: metrics.usedByCount,
        extendsCount: metrics.extendsCount,
        implementsCount: metrics.implementsCount,
      };

      // Graph context (related nodes) is fetched after rerank, for the final
      // hits only, in one batch per project — see `attachRelated` below.
      if (synthetic) syntheticIds.add(node.id);

      results.push(result);
    }
    if (dropped.length > 0 || noGraph.length > 0 || rekeyed.size > 0) {
      const sample = [...dropped, ...noGraph].slice(0, 4).map(d => `${d.type ?? '?'}:${d.qn ?? d.id}`).join(', ');
      logger.info(
        `[search] "${query.slice(0, 60)}" project=${projectId ?? 'all'}: vector=${vectorResults.length} joined=${results.length} `
        + `rekeyed=${rekeyed.size} (stale id, re-joined on name+file) kept-without-graph=${noGraph.length} `
        + `dropped=${dropped.length} (node_id not in graph db)${sample ? ` e.g. ${sample}` : ''}`,
      );
    }

    // 5. Sort vector hits by combined score, then fuse with keyword hits (RRF).
    results.sort((a, b) => b.combinedScore - a.combinedScore);
    let ordered: SemanticSearchResult[];
    if (hybridOn) {
      const keyOf = (r: SemanticSearchResult) => r.nodeId || `${r.filePath}:${r.lineStart}`;
      // The vector list is the vector-sourced joined results in score order;
      // the bm25 list is the joined results the FTS returned, in FTS order.
      const vectorList = results.filter(r => vectorIds.has(r.nodeId));
      const bm25List = results
        .filter(r => bm25Order.has(r.nodeId))
        .sort((a, b) => (bm25Order.get(a.nodeId) ?? 0) - (bm25Order.get(b.nodeId) ?? 0));
      const fused = rrfFuse<SemanticSearchResult>([
        { source: 'vector', weight: hybridCfg.vectorWeight, items: vectorList, key: keyOf },
        { source: 'keyword', weight: hybridCfg.keywordWeight, items: keywordHits, key: keyOf },
        ...(bm25List.length ? [{ source: 'bm25' as const, weight: hybridCfg.bm25Weight, items: bm25List, key: keyOf }] : []),
      ]);
      // Secondary dedupe: a vector node and a symbol hit can carry different
      // ids for the same file:line (e.g. re-indexed under a new hash).
      const seenLoc = new Set<string>();
      ordered = [];
      for (const e of fused) {
        const loc = `${e.item.filePath}:${e.item.lineStart}`;
        if (seenLoc.has(loc)) continue;
        seenLoc.add(loc);
        const r = { ...e.item };
        // Keyword-only hits have no vector score; if the same node came from
        // both lists keep the vector's semanticScore (representative = vector).
        r.score = e.normalized;
        r.combinedScore = e.normalized;
        r.sources = e.sources;
        ordered.push(r);
      }
      ordered = ordered.slice(0, HYBRID_CANDIDATES);
      logger.debug(`[hybrid] vector=${vectorList.length} keyword=${keywordHits.length} bm25=${bm25List.length} fused=${ordered.length} (vw=${hybridCfg.vectorWeight} kw=${hybridCfg.keywordWeight} bw=${hybridCfg.bm25Weight})`);
    } else {
      ordered = results.map(r => ({ ...r, score: r.combinedScore, sources: ['vector'] as ResultSources }));
      ordered = ordered.slice(0, HYBRID_CANDIDATES);
    }

    // 6. Cross-encoder re-rank of the candidate pool (sidecar, e.g.
    //    Qwen3-Reranker-8B on vLLM). Default 'auto': on whenever a usable
    //    sidecar advertises capability `reranker`; falls back to fused order
    //    on any error. Explicit per-request `crossEncoderReranker.enabled`
    //    or rerank:'on' forces it; 'off' disables.
    const joinMs = Date.now() - tJoin0;
    const tRerank0 = Date.now();
    ordered = await this.maybeRerank(query, ordered, options, limit);
    const rerankMs = Date.now() - tRerank0;
    // Cross-project: fold version copies AFTER rerank (scores unchanged), so
    // freed top-N slots go to other answers.
    let folded = 0;
    if (projectId === undefined && options.groupVersions !== false) {
      for (const r of ordered) if (r.projectId === undefined) r.projectId = pidByNode.get(r.nodeId);
      const labels = await import('../projects/versionGroup.js').then(m => m.getProjectVersionGroups()).catch(() => new Map());
      const before = ordered.length;
      ordered = groupVersionCopies(ordered, pid => labels.get(pid)?.label ?? `project ${pid}`);
      folded = before - ordered.length;
    }
    ordered = ordered.slice(0, limit);
    for (const r of ordered) delete r.chunkText;

    // 7. Optional LLM re-ranking
    if (options.llmReranker?.enabled) {
      const { llmRerank } = await import('./llmReranker.js');
      ordered = await llmRerank(query, ordered, options.llmReranker);
    }

    // 8. Related nodes (callers/callees) for the FINAL hits only, two queries
    //    per project. Neither reranker reads them. Before, this ran per
    //    candidate (~100) before fusion as two serialized recursive queries
    //    each: 47-52 s of a 55-61 s search on project 11.
    const tRel0 = Date.now();
    let relatedQueries = 0;
    if (includeGraphContext) {
      const r = await this.attachRelated(ordered, {
        pidOf: (id) => projectId ?? pidByNode.get(id),
        skip: syntheticIds,
        graphDeadlineAt,
        untilGraphDeadline,
      });
      skippedRelated += r.skipped;
      relatedQueries = r.queries;
    }
    const relatedMs = Date.now() - tRel0;
    if (metricsCut || skippedRelated > 0) {
      const afterMs = graphDeadlineAt !== undefined ? Math.max(0, graphDeadlineAt - tJoin0) : joinMs;
      logger.warn(`[search] "${query.slice(0, 40)}" project=${projectId ?? 'all'}: graph step capped after ${afterMs}ms (metrics ${metricsCut ? 'cut' : 'done'}, related skipped for ${skippedRelated} hit(s))`);
      try { options.onGraphCapped?.({ afterMs, skippedRelated, metricsCut }); } catch { /* listener */ }
    }
    logger.info(`[search] "${query.slice(0, 40)}" project=${projectId ?? 'all'} phases: fetch ${fetchMs}ms (${rekeyed.size} rekeyed, ${folded} version copies folded) join ${joinMs}ms (metrics ${metricsMs}ms) rerank ${rerankMs}ms related ${relatedMs}ms (${ordered.length} hits, ${relatedQueries} queries) total ${Date.now() - tEmbed0}ms`);
    return ordered;
  }

  /** Wait for `work` until `deadlineAt`; past it, return `fallback` (cut). */
  private async untilDeadline<T>(deadlineAt: number | undefined, work: Promise<T>, fallback: T): Promise<{ v: T; cut: boolean }> {
    if (deadlineAt === undefined) return { v: await work, cut: false };
    const ms = deadlineAt - Date.now();
    if (ms <= 0) { work.catch(() => undefined); return { v: fallback, cut: true }; }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<{ v: T; cut: boolean }>(res => { timer = setTimeout(() => res({ v: fallback, cut: true }), ms); });
    try {
      return await Promise.race([work.then(v => ({ v, cut: false })), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      work.catch(() => undefined);
    }
  }

  /**
   * Attach `relatedNodes` to `hits` in place: one getRelatedBatch (2 queries)
   * per project, four projects at a time (the graph pool cap is 8). Hits in
   * `skip` (synthetic file/project rows) and hits with no known project in a
   * cross-project search get none. A project whose lookup fails or misses the
   * graph deadline counts its hits as skipped; the search still returns.
   */
  private async attachRelated(
    hits: SemanticSearchResult[],
    opts: {
      pidOf: (nodeId: string) => number | undefined;
      skip: Set<string>;
      graphDeadlineAt?: number;
      untilGraphDeadline: <T>(work: Promise<T>, fallback: T) => Promise<{ v: T; cut: boolean }>;
    },
  ): Promise<{ skipped: number; queries: number }> {
    const byPid = new Map<number, SemanticSearchResult[]>();
    for (const h of hits) {
      if (!h.nodeId || opts.skip.has(h.nodeId)) continue;
      const pid = opts.pidOf(h.nodeId);
      if (pid === undefined) continue;
      const arr = byPid.get(pid) ?? [];
      arr.push(h);
      byPid.set(pid, arr);
    }
    let skipped = 0;
    let queries = 0;
    const groups = [...byPid];
    const CONCURRENCY = projectFanout();
    for (let i = 0; i < groups.length; i += CONCURRENCY) {
      await Promise.all(groups.slice(i, i + CONCURRENCY).map(async ([pid, group]) => {
        if (opts.graphDeadlineAt !== undefined && Date.now() > opts.graphDeadlineAt) { skipped += group.length; return; }
        queries += 2;
        const work = this.graph(pid === -1 ? undefined : pid).getRelatedBatch(group.map(h => h.nodeId), graphSetting('relatedLimit')).catch((err: Error) => {
          logger.warn(`[search] related nodes skipped for project ${pid}: ${err.message}`);
          return undefined;
        });
        const r = await opts.untilGraphDeadline(work, undefined);
        if (r.cut || !r.v) { skipped += group.length; return; }
        for (const h of group) h.relatedNodes = r.v.get(h.nodeId) ?? [];
      }));
    }
    return { skipped, queries };
  }

  private static readonly QUERY_EMBED_TTL_MS = 10 * 60_000;
  private static readonly QUERY_EMBED_MAX = 500;
  private queryEmbedCache = new Map<string, { vec: Float32Array; at: number }>();
  private queryEmbedInFlight = new Map<string, Promise<Float32Array>>();

  /** Query embedding, memoised per (model, instructed text) with single-flight. */
  private async embedQueryCached(provider: { getModelName(): string; embed(t: string): Promise<Float32Array> }, queryText: string): Promise<Float32Array> {
    const key = `${provider.getModelName()}|${queryText}`;
    const now = Date.now();
    const hit = this.queryEmbedCache.get(key);
    if (hit && now - hit.at < SemanticSearchService.QUERY_EMBED_TTL_MS) {
      // refresh LRU position
      this.queryEmbedCache.delete(key); this.queryEmbedCache.set(key, hit);
      return hit.vec;
    }
    const pending = this.queryEmbedInFlight.get(key);
    if (pending) return pending;
    const p = (async () => {
      try {
        // Persistent tier: the embed cache table (LanceDB) under a query-only
        // text version, so query vectors survive restarts. Best effort, capped.
        // Read from memory only: warmSearchAtBoot loads the saved set once.
        const qHash = createHash('sha256').update(queryText).digest('hex');
        // A search right after boot can beat the warm-up: wait for it briefly
        // (the saved-vector load is ~0.6 s) rather than pay a full embed.
        if (warmupAttempt) await Promise.race([warmupAttempt, new Promise(r => setTimeout(r, WARMUP_WAIT_MS))]);
        const persisted = savedQueryVectors.get(provider.getModelName())?.get(qHash);
        if (persisted && persisted.length > 0) {
          this.queryEmbedCache.set(key, { vec: persisted, at: Date.now() });
          return persisted;
        }
        const vec = await provider.embed(queryText);
        if (vec && vec.length > 0) {
          rememberQueryVector(provider.getModelName(), qHash, vec);
          void getEmbedCache().store(provider.getModelName(), QUERY_VECTOR_TEXT_VERSION, [{ hash: qHash, vector: vec }]).catch(() => 0);
          this.queryEmbedCache.set(key, { vec, at: Date.now() });
          while (this.queryEmbedCache.size > SemanticSearchService.QUERY_EMBED_MAX) {
            const oldest = this.queryEmbedCache.keys().next().value as string;
            this.queryEmbedCache.delete(oldest);
          }
        }
        return vec;
      } finally {
        this.queryEmbedInFlight.delete(key);
      }
    })();
    this.queryEmbedInFlight.set(key, p);
    return p;
  }

  /**
   * Decide + run the cross-encoder pass over the candidate pool. Returns the
   * input unchanged when reranking is off / unavailable / fails.
   */
  private async maybeRerank(
    query: string,
    candidates: SemanticSearchResult[],
    options: SemanticSearchOptions,
    limit: number,
  ): Promise<SemanticSearchResult[]> {
    if (candidates.length === 0) return candidates;
    const xe = options.crossEncoderReranker;
    const mode: RerankMode = options.rerank ?? (xe?.enabled === true ? 'on' : readRerankMode());
    if (mode === 'off') return candidates;

    // A local reranker sidecar OR a cloud-routable one (the OpenRouter reranker
    // container, when the policy allows cloud). Bailing on "no local sidecar"
    // alone silently disabled reranking under "OpenRouter only": every ask
    // logged "forced on but no usable reranker sidecar" while a configured
    // cloud reranker sat idle. rerankLocalFirst does the actual routing.
    const sidecar = rerankerSidecarUsable();
    const { selectVirtualReranker, getLastRerankAttribution } = await import('./rerankRouter.js');
    const cloud = sidecar ? null : selectVirtualReranker();
    if (!sidecar && !cloud) {
      if (mode === 'on') logger.warn('[rerank] forced on but no usable reranker (no local sidecar, no cloud-routable reranker) — keeping fused order');
      else logger.info('[rerank] skipped (auto: no usable reranker)');
      return candidates;
    }

    const topK = Math.min(xe?.topK ?? HYBRID_CANDIDATES, candidates.length);
    const t0 = Date.now();
    try {
      const { crossEncoderRerank } = await import('./crossEncoderReranker.js');
      const reranked = await crossEncoderRerank(query, candidates, {
        enabled: true,
        model: xe?.model,
        topK,
        timeoutMs: xe?.timeoutMs ?? 8_000,
        sidecar: sidecar ?? undefined,
        codeChars: options.rerankCodeChars ?? readRerankCodeChars(),
        ...(options.rerankCodeMode ? { codeMode: options.rerankCodeMode } : {}),
        ...(typeof options.rerankXeWeight === 'number' ? { xeWeight: options.rerankXeWeight } : {}),
      });
      const keyOf = (r: SemanticSearchResult) => r.nodeId || `${r.filePath}:${r.lineStart}`;
      const n = Math.min(limit, reranked.length);
      const changed = countChangedPositions(candidates, reranked, keyOf, n);
      const applied = reranked.some(r => typeof (r as any).crossEncoderScore === 'number');
      logger.info(`[rerank] n=${topK} → top${n} changed ${changed} positions${applied ? '' : ' (reranker returned no scores; fused order kept)'} servedBy=${getLastRerankAttribution()?.servedBy ?? sidecar?.name ?? cloud?.providerName} path=${getLastRerankAttribution()?.path ?? '?'} mode=${mode} ms=${Date.now() - t0}`);
      return reranked;
    } catch (err) {
      logger.warn(`[rerank] failed after ${Date.now() - t0}ms, keeping fused order: ${(err as Error).message}`);
      return candidates;
    }
  }

  /**
   * Keyword candidates from the FlexSearch symbol index mapped to the
   * SemanticSearchResult shape. Function/type ids are the same 16-char hashes
   * the graph uses for CodeNode ids, so `nodeId` lines up with vector hits.
   */
  private async keywordCandidates(
    query: string,
    opts: { projectId?: number; projectIds?: number[]; nodeType?: string; limit: number; graphWeight: number; includeGraphMetrics?: boolean },
  ): Promise<SemanticSearchResult[]> {
    const { getFantomFunctionSearchIndex } = await import('../fantom-code/searchIndex.js');
    const index = getFantomFunctionSearchIndex();
    // The symbol index is prefix-tokenized ("rete" matches ReteEditorMixin) but
    // a LONGER query token never matches a shorter symbol ("retejs" ≠ "rete").
    // Try the raw query first, then library-style variants (strip js/ts/vue
    // suffixes, split camel/kebab) and finally shorter prefixes, until we have
    // a reasonable candidate pool. Results are merged best-first, deduped by id.
    const seen = new Set<string>();
    const hits: ReturnType<typeof index.search> = [];
    for (const variant of keywordQueryVariants(query)) {
      const more = index.search(variant, { limit: opts.limit, projectId: opts.projectId, projectIds: opts.projectIds });
      for (const h of more) {
        const id = (h.function as { id: string }).id;
        if (seen.has(id)) continue;
        seen.add(id);
        hits.push(h);
      }
      if (hits.length >= Math.min(opts.limit, 10)) break;
    }
    // Same batching as the vector join: one metrics query pair per project.
    const kwMetrics = new Map<number, Map<string, GraphMetrics>>();
    if (opts.includeGraphMetrics !== false) {
      const idsByPid = new Map<number, string[]>();
      for (const h of hits) {
        const f = h.function as unknown as { id: string; projectId: number };
        const pid = opts.projectId ?? (Number.isFinite(Number(f.projectId)) ? Number(f.projectId) : undefined);
        if (pid === undefined) continue;
        const arr = idsByPid.get(pid) ?? []; arr.push(f.id); idsByPid.set(pid, arr);
      }
      await Promise.all([...idsByPid].map(async ([pid, ids]) => {
        try { kwMetrics.set(pid, await this.graph(pid).getMetricsBatch(ids)); } catch { kwMetrics.set(pid, new Map()); }
      }));
    }
    const out: SemanticSearchResult[] = [];
    for (const h of hits) {
      const f = h.function as unknown as {
        id: string; projectId: number; name: string; qualifiedName: string; filePath: string;
        lineNumber?: number; lineStart?: number; signature?: string; documentation?: string;
        description?: string; category?: string; type?: string; className?: string;
      };
      const isType = f.category === 'type';
      const nodeType = isType
        ? ((f.signature ?? '').split(/\s+/)[0] || 'type')   // "class Foo" → class
        : (f.className ? 'method' : (f.type ?? 'function'));
      if (opts.nodeType && nodeType !== opts.nodeType) continue;
      const lineStart = f.lineStart ?? f.lineNumber ?? 0;

      // Graph score from the hit's own project db (best effort).
      let graphScore = 0;
      let callerCount: number | undefined;
      let calleeCount: number | undefined;
      const pid = opts.projectId ?? (Number.isFinite(Number(f.projectId)) ? Number(f.projectId) : undefined);
      if (pid !== undefined) {
        try {
          const m = kwMetrics.get(pid)?.get(f.id) ?? { callerCount: 0, calleeCount: 0 } as GraphMetrics;
          callerCount = m.callerCount;
          calleeCount = m.calleeCount;
          graphScore = isType ? this.calculateTypeGraphScore(m) : this.calculateGraphScore(m.callerCount);
        } catch { /* node may not be in the graph yet */ }
      }

      out.push({
        nodeId: f.id,
        name: f.name,
        qualifiedName: f.qualifiedName,
        nodeType,
        filePath: f.filePath,
        lineStart,
        signature: f.signature || undefined,
        documentation: f.documentation || f.description || undefined,
        semanticScore: 0,
        graphScore,
        combinedScore: opts.graphWeight * graphScore,
        keywordScore: h.score,
        callerCount,
        calleeCount,
        sources: ['keyword'],
      });
    }
    return out;
  }

  /**
   * Find similar code to a given node
   */
  async findSimilar(
    nodeId: string,
    options: SemanticSearchOptions = {}
  ): Promise<SemanticSearchResult[]> {
    const { limit = 5 } = options;

    // Get the node's embedding
    const embedding = await this.vectorStore.getEmbedding(nodeId);
    if (!embedding) {
      logger.warn(`No embedding found for node: ${nodeId}`);
      return [];
    }

    // Search for similar, excluding the source node
    const results = await this.vectorStore.search(embedding, {
      ...options,
      limit: limit + 1  // Extra to account for self-match
    });

    // Filter out the source node and get full results
    const filteredResults = results.filter(r => r.nodeId !== nodeId);

    // Convert to full results
    return this.enrichResults(filteredResults.slice(0, limit), options);
  }

  /**
   * Build embeddings for all nodes in a project (skips nodes already in LanceDB)
   */
  async buildProjectEmbeddings(projectId: number): Promise<{
    processed: number;
    errors: number;
    /** Nodes left unembedded because a heavy job took the fleet (not errors). */
    yielded?: number;
  }> {
    const queuedAt = Date.now();
    await acquireEmbedSlot();
    const waitedMs = Date.now() - queuedAt;
    logger.info(`[embed-semaphore] acquired project=${projectId} inFlight=${embedInFlight} limit=${readParallelProjects()} waitedMs=${waitedMs}`);
    try {
      return await this._buildProjectEmbeddingsImpl(projectId);
    } finally {
      releaseEmbedSlot();
      logger.info(`[embed-semaphore] released project=${projectId} inFlight=${embedInFlight}`);
    }
  }

  private async _buildProjectEmbeddingsImpl(projectId: number): Promise<{
    processed: number;
    errors: number;
    yielded?: number;
  }> {
    const { crashWrite } = await import('../utils/logSink.js');
    const ssCrash = (s: string) => crashWrite('BPE', `project=${projectId} ${s}`);
    const memTagBPE = () => {
      const m = process.memoryUsage();
      return `rss=${Math.round(m.rss / 1024 / 1024)}MB heap=${Math.round(m.heapUsed / 1024 / 1024)}MB`;
    };
    ssCrash(`ENTER ${memTagBPE()}`);
    logger.info(`Building embeddings for project ${projectId}`);

    // ── Which provider, and may we even ask for a local one? ─────────────
    //
    // ORDER MATTERS HERE. `selectEmbeddingProviderForProject` resolves a LOCAL
    // provider, and under strict-sidecar mode it THROWS when no local sidecar
    // advertises the model. That is correct under every GPU-serving policy and
    // wrong under "OpenRouter only", where the GPUs are excluded on purpose:
    // the throw happened before the cloud branch below ever ran, so a re-embed
    // died with `[strict-sidecar] no enabled sidecar advertises capability
    // 'embedding'` while five verified cloud providers sat idle.
    //
    // So the policy is read FIRST and the local resolution is skipped entirely
    // when the corpus is cloud-only. The model name then comes from the
    // configured cloud model rather than from a local provider we are about to
    // exclude — asking a provider we will not use what to call the model was
    // only ever an accident of the order these two lines were written in.
    ssCrash(`PROVIDER_RESOLVE_START`);
    const { selectEmbeddingProviderForProject, embeddingRoutingPolicy: _routing } =
      await import('./providers/embeddingProvider.js');
    let cloudOnlyCorpus = false;
    try {
      cloudOnlyCorpus = !(await _routing('code')).localServes;
    } catch { /* unreadable policy → the pre-cloud path, as before */ }

    let projectProvider: EmbeddingProvider | null = null;
    let desiredModel: string;
    if (cloudOnlyCorpus) {
      const { getOpenRouterSettings } = await import('../sidecars/openRouterConfig.js');
      const configured = getOpenRouterSettings().allowedModels['code-embedding']?.model;
      if (!configured) {
        throw new Error(
          '[openrouter-only] code embedding is on "OpenRouter only" but no cloud model is configured for '
          + 'it — pick one under Model Selection on the config page before re-embedding.',
        );
      }
      desiredModel = configured;
      ssCrash(`PROVIDER_RESOLVE_SKIPPED_CLOUD_ONLY model=${desiredModel}`);
      logger.info(
        `[buildProjectEmbeddings] project ${projectId} → "OpenRouter only": the sidecar GPUs are excluded, `
        + `corpus model ${desiredModel}`,
      );
    } else {
      // Per-project override may pin this project to a different sidecar/model.
      // Falls back to this.embeddingService (the global provider) when no override.
      projectProvider = selectEmbeddingProviderForProject('code', projectId);
      desiredModel = projectProvider.getModelName();
      const usingOverride = desiredModel !== this.embeddingService.getModelName();
      ssCrash(`PROVIDER_RESOLVE_DONE model=${desiredModel} dim=${projectProvider.getDimensions()} override=${usingOverride}`);
      if (usingOverride) {
        logger.info(`[buildProjectEmbeddings] project ${projectId} → override model ${desiredModel} (${projectProvider.getDimensions()}d)`);
      }
    }

    // Get all nodes for the project (Ladybug-authoritative). Forced GC
    // right before the native Kuzu call drops V8 heap to minimum so the
    // FFI's transient allocation has the most headroom — this is the
    // moment macOS Jetsam was killing us mid-fetch on large projects.
    if (typeof (globalThis as any).gc === 'function') {
      try { (globalThis as any).gc(); ssCrash(`GC_PRE_LADYBUG ${memTagBPE()}`); } catch { /* ignore */ }
    }
    ssCrash(`LADYBUG_QUERY_START`);
    const ladyStart = Date.now();
    // Page the result set so Kuzu doesn't have to materialize all rows in a
    // single native allocation. Empirically the per-row cost is dominated
    // by signature + documentation strings; pages of 500 keep peak well
    // under what tripped Jetsam on 1.7k-row pulls.
    const PAGE = 500;
    let allNodes: Array<{ id: string; name: string; qualifiedName: string; signature: string | null; documentation: string | null; filePath: string | null; lineStart: number | null; lineEnd: number | null; nodeType: string | null }> = [];
    try {
      let offset = 0;
      while (true) {
        const pageStart = Date.now();
        ssCrash(`LADYBUG_PAGE_START offset=${offset} ${memTagBPE()}`);
        // file_path + line_start/line_end let buildCodeEmbeddingText append the
        // source body (the A/B-validated quality lever for the code embedder).
        const pageRows = await ladybugQuery<{ id: string; name: string; qn: string; sig: string; doc: string; fp: string; ls: number; le: number; nt: string }>(projectId,
          `MATCH (n:CodeNode {project_id: ${projectId}})
           RETURN n.id AS id, n.name AS name, n.qualified_name AS qn, n.signature AS sig, n.documentation AS doc,
                  n.file_path AS fp, n.line_start AS ls, n.line_end AS le, n.node_type AS nt
           SKIP ${offset} LIMIT ${PAGE}`
        );
        ssCrash(`LADYBUG_PAGE_OK offset=${offset} rows=${pageRows.length} ms=${Date.now() - pageStart}`);
        for (const r of pageRows) {
          allNodes.push({ id: r.id, name: r.name, qualifiedName: r.qn, signature: r.sig || null, documentation: r.doc || null, filePath: r.fp || null, lineStart: r.ls != null ? Number(r.ls) : null, lineEnd: r.le != null ? Number(r.le) : null, nodeType: r.nt || null });
        }
        if (pageRows.length < PAGE) break;
        offset += PAGE;
        // GC between pages when the project is large — keeps the FFI
        // result buffer from accumulating across iterations.
        if (typeof (globalThis as any).gc === 'function') {
          try { (globalThis as any).gc(); } catch { /* ignore */ }
        }
      }
      ssCrash(`LADYBUG_QUERY_OK rows=${allNodes.length} ms=${Date.now() - ladyStart}`);
    } catch (err) {
      ssCrash(`LADYBUG_QUERY_FAIL ms=${Date.now() - ladyStart} err=${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

    // Fallback: when LadybugDB has no nodes for this project (often because
    // an earlier reindex hit cross-project hash collisions), pull from the
    // in-memory FantomCodeIndexer. This unblocks semanticCodeSearch even
    // when the graph build silently produced zero nodes — see round-7 report.
    if (allNodes.length === 0) {
      ssCrash(`INMEM_FALLBACK_START`);
      try {
        const { getFantomCodeIndexer } = await import('../fantom-code/indexer.js');
        const indexer = getFantomCodeIndexer();
        const fns = indexer.getAllFunctions().filter(
          (f) => Number((f as any).projectId) === Number(projectId),
        );
        const types = indexer.getAllTypes().filter(
          (t) => Number((t as any).projectId) === Number(projectId),
        );
        ssCrash(`INMEM_FALLBACK_FOUND fns=${fns.length} types=${types.length}`);
        if (fns.length + types.length > 0) {
          logger.info(
            `[buildProjectEmbeddings] LadybugDB empty for project ${projectId}; falling back to in-memory indexer (+${fns.length} fns, +${types.length} types)`,
          );
          allNodes = [
            ...types.map((t) => ({
              id: t.id,
              name: t.name,
              qualifiedName: t.qualifiedName,
              signature: null,
              documentation: t.documentation || null,
              filePath: (t as any).filePath ?? null,
              lineStart: (t as any).lineNumber ?? null,
              lineEnd: (t as any).lineEnd ?? null,
              nodeType: (t as any).kind ?? 'class',
            })),
            ...fns.map((f) => ({
              id: f.id,
              name: f.name,
              qualifiedName: f.qualifiedName,
              signature: f.signature || null,
              documentation: f.documentation || null,
              filePath: (f as any).filePath ?? null,
              lineStart: (f as any).lineNumber ?? null,
              lineEnd: (f as any).lineEnd ?? null,
              nodeType: (f as any).type ?? 'method',
            })),
          ];
        }
      } catch (err) {
        logger.warn(
          `[buildProjectEmbeddings] in-memory fallback failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Skip nodes that already have vectors in LanceDB
    ssCrash(`EXISTING_IDS_START`);
    const exStart = Date.now();
    let existingIds: Set<string>;
    try {
      existingIds = await this.vectorStore.getNodeIdsForProject(projectId);
      ssCrash(`EXISTING_IDS_OK count=${existingIds.size} ms=${Date.now() - exStart}`);
    } catch (err) {
      ssCrash(`EXISTING_IDS_FAIL ms=${Date.now() - exStart} err=${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    const nodes = allNodes.filter(n => !existingIds.has(n.id));
    ssCrash(`NODES_TO_EMBED total=${allNodes.length} existing=${existingIds.size} new=${nodes.length}`);

    // v3: one row per indexed file + one per project (embedSynthetic.ts). Only
    // the missing ones — their ids are in existingIds like any node's.
    let syntheticItems: EmbeddingItem[] = [];
    if (EMBED_TEXT_V3 && allNodes.length > 0) {
      try {
        syntheticItems = (await buildSyntheticItems(this.prisma, projectId, allNodes)).filter(i => !existingIds.has(i.nodeId));
      } catch (err) {
        logger.warn(`[buildProjectEmbeddings] synthetic file/project rows skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (nodes.length === 0 && syntheticItems.length === 0 && allNodes.length > 0) {
      logger.info(`All ${allNodes.length} nodes already have embeddings for project ${projectId}`);
      return { processed: 0, errors: 0 };
    }

    if (nodes.length < allNodes.length) {
      logger.info(`Skipping ${allNodes.length - nodes.length} nodes with existing embeddings`);
    }

    // v3: graph context pre-pass (paged, per project — never per node), then
    // expand each node into its chunk items. Node ids stay the same; a long
    // symbol just yields several texts.
    // v4: an LLM-written `about:` sentence per node goes in front of the graph
    // line (cached per content hash; a failure just leaves the v3 text).
    const graphContext = await buildEmbeddingContext(projectId, nodes);
    const context = await withLlmContext(projectId, nodes, graphContext);
    const workItems: EmbeddingItem[] = [...buildEmbeddingItems(nodes, context), ...syntheticItems];
    ssCrash(`ITEMS_TO_EMBED nodes=${nodes.length} items=${workItems.length} synthetic=${syntheticItems.length}`);

    let processed = 0;
    let errors = 0;
    embedRunStarted(projectId, nodes.length); // dashboard "Embedding Activity" (autoPipelineBus)

    // Capture which sidecar (if any) is actually serving this project so
    // we can persist the attribution after success. We resolve once at
    // the top of the loop; the per-batch fanout below may use multiple,
    // but the "primary" assignment is what the dashboard surfaces.
    let attributionSidecar: { name?: string; host?: string; model?: string; inProcess: boolean } = { inProcess: true };
    try {
      const { getSidecarForCapability } = await import('../sidecars/registry.js');
      // Under "OpenRouter only" no local sidecar serves this project, so there
      // is no local attribution to resolve — the per-provider `onServed`
      // accounting in the fan-out below records which cloud provider produced
      // what, which is the attribution that is actually true for this run.
      const model = cloudOnlyCorpus ? desiredModel : projectProvider!.getModelName();
      if (cloudOnlyCorpus) throw new Error('cloud-only: no local attribution');
      // Prefer the dedicated code embedder (own port) before the general one.
      const sc = getSidecarForCapability('embedding-code', model)
        ?? getSidecarForCapability('embedding', model)
        ?? getSidecarForCapability('embedding-code')
        ?? getSidecarForCapability('embedding');
      if (sc) {
        const cap = sc.capabilities['embedding-code'] ?? sc.capabilities.embedding;
        attributionSidecar = {
          name: sc.name,
          host: `${sc.host}:${sc.port}`,
          model: cap?.loaded ?? cap?.models?.[0] ?? model,
          inProcess: false,
        };
      }
    } catch { /* status only */ }

    // Resolve all available embedding sidecars so we can fan a single
    // project's batches across them in parallel. Falls back to the single
    // projectProvider when only zero or one sidecar is present.
    const { selectAllEmbeddingProviders, selectAllEmbeddingProvidersWithCloud } =
      await import('./providers/embeddingProvider.js');
    // `desiredModel` and `cloudOnlyCorpus` are resolved once at the top of this
    // method now — the policy has to be known BEFORE a local provider is
    // resolved, not after, because resolving one throws under strict-sidecar
    // mode when the GPUs are excluded by policy.
    //
    // Under "OpenRouter only" the local pool is not merely deprioritised, it is
    // not in the pool — and `projectProvider` is a local provider, so the
    // single-provider branch has to be taken out of reach too. The cloud
    // selector throws when it cannot serve; that error propagates and the
    // project is recorded as failed rather than quietly rebuilt on local
    // vectors that the query encoder will no longer match.
    const fanout = cloudOnlyCorpus
      ? await selectAllEmbeddingProvidersWithCloud('code', desiredModel)
      : selectAllEmbeddingProviders('code', desiredModel);
    if (cloudOnlyCorpus && fanout.length === 0) {
      // Belt to the selector's braces. If this were ever reachable, the
      // `useFanout` test below would fall through to `projectProvider`, which
      // is local — writing local rows into a cloud-built index, which is the
      // one outcome this policy has to make impossible.
      throw new Error(
        '[openrouter-only] no OpenRouter-backed provider is cleared to embed and the sidecar GPUs are '
        + `excluded by policy — refusing to build project ${projectId} on local vectors the cloud query `
        + 'encoder would not match.',
      );
    }
    const useFanout = cloudOnlyCorpus ? fanout.length >= 1 : fanout.length >= 2;
    if (useFanout) {
      logger.info(
        `[buildProjectEmbeddings] fanout enabled — ${fanout.length} `
        + `${cloudOnlyCorpus ? 'cloud provider(s) ("OpenRouter only"; the GPUs are excluded)' : 'sidecars'}: `
        + `${fanout.map(p => (p as { getSidecarName?: () => string }).getSidecarName?.() ?? p.getModelName()).join(', ')}`,
      );
    }

    // Which sidecar actually returned vectors, by number of texts served. With
    // fan-out + failover the sidecar Fantom *selected* (attributionSidecar above)
    // can serve none of the chunks — the Macs refusing embeddings had the
    // dashboard crediting them for projects BASWS35 embedded entirely.
    const servedBy = new Map<string, { name: string; host?: string; texts: number }>();
    const credit = (p: unknown, n: number, vecs?: Float32Array[]): void => {
      const prov = p as { getSidecarName?: () => string; getSidecarId?: () => string };
      // Direct OpenRouter: credit each pool worker (worker1 … workerN).
      const split = workerSplitOf(vecs);
      if (split) {
        for (const [name, k] of Object.entries(split)) {
          const w = servedBy.get(name) ?? { name, host: undefined, texts: 0 };
          w.texts += k;
          servedBy.set(name, w);
        }
        return;
      }
      const name = typeof prov.getSidecarName === 'function' ? prov.getSidecarName() : 'in-process';
      const cur = servedBy.get(name) ?? { name, host: undefined, texts: 0 };
      if (!cur.host && typeof prov.getSidecarId === 'function') {
        try {
          const sc = getSidecar(prov.getSidecarId());
          if (sc) cur.host = `${sc.host}:${sc.port}`;
        } catch { /* registry lookup is best effort */ }
      }
      cur.texts += n;
      servedBy.set(name, cur);
    };

    // Process in batches
    const batchSize = 50;
    const crashLine = (s: string) => crashWrite('EMBED_LOOP', `project=${projectId} ${s}`);
    crashLine(`START nodes=${nodes.length} items=${workItems.length} batchSize=${batchSize} fanout=${useFanout ? fanout.length : 1}`);
    let yielded = 0;
    for (let i = 0; i < workItems.length; i += batchSize) {
      // A heavy job (full re-embed, forced reindex, Axon index) owns the
      // sidecar fleet while it runs: stop this pipeline/watchdog run at the
      // next batch instead of competing with it for hours (2026-09-14: three
      // boot-pipeline projects kept embedding into the OLD table beside the
      // v3 shadow rebuild, and the rebuild fell to 1.5 vectors/s).
      const heavy = getHeavyJob();
      if (heavy) {
        logger.warn(`[embed-loop] project=${projectId} aborting at batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(workItems.length / batchSize)} — heavy job ${heavy.kind} (${heavy.label}) owns the fleet`);
        crashLine(`ABORT heavy job ${heavy.kind} (${heavy.label})`);
        yielded = workItems.length - i;
        break;
      }
      const batch = workItems.slice(i, i + batchSize);
      const texts = batch.map(item => item.text);
      const batchNo = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(workItems.length / batchSize);
      const memBefore = process.memoryUsage();
      const batchStart = Date.now();
      logger.info(`[embed-loop] batch ${batchNo}/${totalBatches} START project=${projectId} size=${batch.length} rss=${Math.round(memBefore.rss / 1024 / 1024)}MB heap=${Math.round(memBefore.heapUsed / 1024 / 1024)}MB`);
      crashLine(`BATCH START ${batchNo}/${totalBatches} size=${batch.length} rss=${Math.round(memBefore.rss / 1024 / 1024)}MB`);

      try {
        let embeddings: Float32Array[];
        const embedStart = Date.now();
        if (useFanout) {
          // Speed-weighted split with per-chunk failover (shared helper; the
          // GPU host takes proportionally more of each batch than a Mac).
          // embed_cache (3.5): only texts the cache does not hold reach a provider.
          embeddings = (await getEmbedCache().embedThrough(desiredModel, texts,
            miss => embedBatchFanout(fanout, miss, (p, n, v) => credit(p, n, v)))).vectors;
        } else {
          // Unreachable under "OpenRouter only": `useFanout` is
          // `fanout.length >= 1` there and the selector throws rather than
          // returning an empty pool, so this branch only runs when a local
          // provider was resolved. Asserted rather than assumed — falling
          // through here with a local provider is precisely how local rows
          // would get into a cloud-built index.
          if (!projectProvider) {
            throw new Error(
              '[openrouter-only] the single-provider embed path was reached with the GPUs excluded by '
              + 'policy — refusing to embed rather than write local vectors into a cloud-built index.',
            );
          }
          const single = projectProvider;
          embeddings = (await getEmbedCache().embedThrough(desiredModel, texts, async miss => {
            const v = await single.embedBatch(miss);
            credit(single, miss.length, v);
            return v;
          })).vectors;
        }
        const embedMs = Date.now() - embedStart;
        crashLine(`BATCH EMBED OK ${batchNo}/${totalBatches} ms=${embedMs}`);

        const items = batch.map((item, idx) => ({ ...item, embedding: embeddings[idx] }));

        const storeStart = Date.now();
        crashLine(`STORE START ${batchNo}/${totalBatches} items=${items.length}`);
        // Pass projectId so storeEmbeddings resolves node metadata from the
        // SAME per-project graph db we read `allNodes` from above — otherwise
        // the (stale) shared db drops nodes and embeddings never persist.
        //
        // The 4th argument is what produced these vectors. Without it the store
        // labels the row from its own single-pick LOCAL selector, which throws
        // under "OpenRouter only" — losing a batch that was already embedded —
        // and would otherwise stamp a cloud vector with a local model's name.
        // Under every GPU-serving policy this is `projectProvider`, which is
        // what that getter would have resolved anyway.
        await this.vectorStore.storeEmbeddings(items, projectId, undefined, projectProvider ?? fanout[0]);
        const storeMs = Date.now() - storeStart;
        const totalMs = Date.now() - batchStart;
        const memAfter = process.memoryUsage();
        const heapDelta = Math.round((memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024);
        const rssDelta = Math.round((memAfter.rss - memBefore.rss) / 1024 / 1024);
        logger.info(`[embed-loop] batch ${batchNo}/${totalBatches} OK project=${projectId} embed=${embedMs}ms store=${storeMs}ms total=${totalMs}ms heapΔ=${heapDelta}MB rssΔ=${rssDelta}MB`);
        crashLine(`BATCH OK ${batchNo}/${totalBatches} embed=${embedMs}ms store=${storeMs}ms heapΔ=${heapDelta}MB rssΔ=${rssDelta}MB`);
        processed += batch.length;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error && err.stack ? err.stack.split('\n').slice(0, 6).join(' | ') : '';
        logger.error(`[embed-loop] batch ${batchNo}/${totalBatches} FAIL project=${projectId} err=${msg}`);
        crashLine(`BATCH FAIL ${batchNo}/${totalBatches} err=${msg} stack=${stack}`);
        errors += batch.length;
      }
      embedRunProgress(projectId, processed, errors); // dashboard "Embedding Activity" (autoPipelineBus)

      // Log progress
      if ((i + batchSize) % 500 === 0 || i + batchSize >= workItems.length) {
        logger.debug(`Processed ${Math.min(i + batchSize, workItems.length)}/${workItems.length} embedding items`);
      }
    }
    crashLine(`DONE processed=${processed} errors=${errors}`);
    embedRunFinished(projectId, processed, errors); // dashboard "Embedding Activity" (autoPipelineBus)

    // Update build stats
    await this.updateVectorStats(projectId, processed);

    // Persist per-project embedding attribution so the dashboard can show
    // which sidecar (or in-process fallback) served this project. Only
    // record on success so failed runs don't overwrite a known-good
    // attribution.
    if (processed > 0 || errors === 0) {
      try {
        const { recordProjectEmbedding } = await import('./projectEmbeddingMeta.js');
        // Attribute to the sidecar that served the most texts; fall back to the
        // selected one only when nothing was recorded (e.g. zero nodes).
        const served = Array.from(servedBy.values()).sort((a, b) => b.texts - a.texts);
        const top = served[0];
        if (served.length && top.name !== attributionSidecar.name) {
          logger.info(`[buildProjectEmbeddings] project=${projectId} selected ${attributionSidecar.name ?? 'in-process'} but vectors came from ${served.map(s => `${s.name}=${s.texts}`).join(', ')}`);
        }
        recordProjectEmbedding({
          projectId,
          sidecarName: top ? (top.name === 'in-process' ? null : top.name) : (attributionSidecar.name ?? null),
          sidecarHost: top ? (top.host ?? null) : (attributionSidecar.host ?? null),
          sidecarModel: attributionSidecar.model ?? desiredModel,
          inProcess: top ? top.name === 'in-process' : attributionSidecar.inProcess,
          selectedSidecarName: attributionSidecar.name ?? null,
          servedBy: served.map(s => ({ name: s.name, texts: s.texts })),
          embeddedAt: new Date().toISOString(),
          lastProcessed: processed,
        });
      } catch (err) {
        logger.warn(`[buildProjectEmbeddings] failed to record attribution: ${(err as Error).message}`);
      }
    }

    return yielded ? { processed, errors, yielded } : { processed, errors };
  }

  // Embedding text is now built by the shared buildCodeEmbeddingText
  // (./embeddingText.ts), which also appends the source body — see that file.

  /**
   * Calculate graph importance score
   */
  private calculateGraphScore(callerCount: number): number {
    // Logarithmic scaling: more callers = more important
    // 0 callers = 0.1, 1 caller = 0.5, 10 callers = 0.8, 100+ callers = 1.0
    if (callerCount === 0) return 0.1;
    return Math.min(1.0, 0.3 + 0.3 * Math.log10(callerCount + 1));
  }

  /**
   * Calculate graph score for type-level nodes using all relationships
   * Types don't have call edges, so we use contains/usedBy/extends/implements
   */
  private calculateTypeGraphScore(metrics: GraphMetrics): number {
    // Weighted importance: usedBy (references) > contains (members) > extends/implements
    const totalRelevance =
      metrics.usedByCount * 2 +
      metrics.containsCount +
      metrics.extendsCount * 3 +
      metrics.implementsCount * 3;

    if (totalRelevance === 0) return 0.1;
    // Scale: 1 edge = 0.3, 5 edges = 0.5, 20+ edges = 0.8, 50+ = 1.0
    return Math.min(1.0, 0.2 + 0.3 * Math.log10(totalRelevance + 1));
  }

  /**
   * Enrich vector search results with full node data
   */
  private async enrichResults(
    vectorResults: Array<{ nodeId: string; score: number }>,
    options: SemanticSearchOptions
  ): Promise<SemanticSearchResult[]> {
    const { graphWeight = 0.3, includeGraphContext = false } = options;

    const nodeIds = vectorResults.map(r => r.nodeId);
    const nodes = options.projectId !== undefined
      ? await this.fetchNodesByIds(nodeIds, options.projectId)
      : await this.fetchNodesByIds(nodeIds);

    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const results: SemanticSearchResult[] = [];

    // Metrics for all hits in one batch (2 queries), not getMetrics() per
    // hit (9 queries each). Graph counts only adjust the score; a failed or
    // capped lookup scores 0.
    const graphDeadlineAt = options.graphDeadlineAt;
    const joinedIds = vectorResults.map(r => r.nodeId).filter(id => nodeMap.has(id));
    const metricsWork = this.graph(options.projectId).getMetricsBatch(joinedIds)
      .catch(() => new Map<string, GraphMetrics>());
    const metricsRes = await this.untilDeadline(graphDeadlineAt, metricsWork, new Map<string, GraphMetrics>());
    const metricsMap = metricsRes.v;

    for (const vr of vectorResults) {
      const node = nodeMap.get(vr.nodeId);
      if (!node) continue;

      const metrics = metricsMap.get(node.id) ?? { callerCount: 0, calleeCount: 0 };
      const graphScore = this.calculateGraphScore(metrics.callerCount);
      const combinedScore = (1 - graphWeight) * vr.score + graphWeight * graphScore;

      const result: SemanticSearchResult = {
        nodeId: node.id,
        name: node.name,
        qualifiedName: node.qualifiedName,
        nodeType: node.nodeType,
        filePath: node.filePath,
        lineStart: node.lineStart,
        signature: node.signature ?? undefined,
        documentation: node.documentation ?? undefined,
        semanticScore: vr.score,
        graphScore,
        combinedScore,
        callerCount: metrics.callerCount,
        calleeCount: metrics.calleeCount
      };

      results.push(result);
    }

    // Related nodes in one batch (2 queries), not two recursive queries per hit.
    if (includeGraphContext) {
      const pid = options.projectId;
      const r = await this.attachRelated(results, {
        pidOf: () => pid ?? -1,
        skip: new Set(),
        graphDeadlineAt,
        untilGraphDeadline: (work, fallback) => this.untilDeadline(graphDeadlineAt, work, fallback),
      });
      if (metricsRes.cut || r.skipped > 0) {
        logger.warn(`[findSimilar] graph step capped (metrics ${metricsRes.cut ? 'cut' : 'done'}, related skipped for ${r.skipped} hit(s))`);
      }
    }

    return results;
  }

  /**
   * Update vector build stats
   */
  private async fetchNodesByIds(
    nodeIds: string[],
    projectId?: number,
  ): Promise<Array<{
    id: string; name: string; qualifiedName: string; nodeType: string;
    filePath: string; lineStart: number; signature: string | null; documentation: string | null;
  }>> {
    if (nodeIds.length === 0) return [];
    // Ladybug-authoritative. Chunk the WHERE-OR list to stay within parser limits.
    const out: Array<{
      id: string; name: string; qualifiedName: string; nodeType: string;
      filePath: string; lineStart: number; signature: string | null; documentation: string | null;
    }> = [];
    for (let i = 0; i < nodeIds.length; i += 500) {
      const conditions = nodeIds.slice(i, i + 500).map(id => `n.id = '${id}'`).join(' OR ');
      const cypher =
        `MATCH (n:CodeNode) WHERE ${conditions}
         RETURN n.id AS id, n.name AS name, n.qualified_name AS qn, n.node_type AS nt,
                n.file_path AS fp, n.line_start AS ls, n.signature AS sig, n.documentation AS doc`;
      const rows = projectId !== undefined
        ? await ladybugQuery<{
            id: string; name: string; qn: string; nt: string; fp: string; ls: number; sig: string; doc: string;
          }>(projectId, cypher)
        : await ladybugQuery<{
            id: string; name: string; qn: string; nt: string; fp: string; ls: number; sig: string; doc: string;
          }>(cypher);
      for (const r of rows) {
        out.push({
          id: r.id, name: r.name, qualifiedName: r.qn, nodeType: r.nt,
          filePath: r.fp, lineStart: Number(r.ls),
          signature: r.sig || null, documentation: r.doc || null
        });
      }
    }
    return out;
  }

  /** Graph nodes by qualified name (stale-id rescue), chunked like fetchNodesByIds. */
  private async fetchNodesByQn(
    qns: string[],
    projectId?: number,
  ): Promise<Array<{
    id: string; name: string; qualifiedName: string; nodeType: string;
    filePath: string; lineStart: number; signature: string | null; documentation: string | null;
  }>> {
    const uniq = [...new Set(qns.filter(Boolean))];
    const out: Awaited<ReturnType<SemanticSearchService['fetchNodesByIds']>> = [];
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    for (let i = 0; i < uniq.length; i += 300) {
      const list = uniq.slice(i, i + 300).map(q => `'${esc(q)}'`).join(', ');
      const cypher =
        `MATCH (n:CodeNode) WHERE n.qualified_name IN [${list}]
         RETURN n.id AS id, n.name AS name, n.qualified_name AS qn, n.node_type AS nt,
                n.file_path AS fp, n.line_start AS ls, n.signature AS sig, n.documentation AS doc`;
      type Row = { id: string; name: string; qn: string; nt: string; fp: string; ls: number; sig: string; doc: string };
      const rows = projectId !== undefined ? await ladybugQuery<Row>(projectId, cypher) : await ladybugQuery<Row>(cypher);
      for (const r of rows) {
        out.push({ id: r.id, name: r.name, qualifiedName: r.qn, nodeType: r.nt, filePath: r.fp,
          lineStart: Number(r.ls), signature: r.sig || null, documentation: r.doc || null });
      }
    }
    return out;
  }

  private async updateVectorStats(_projectId: number, _vectorCount: number): Promise<void> {
    // graphBuildStats table is being dropped with the Prisma graph schema.
    // Vector counts can be read directly from LanceDB via vectorStore.count()
    // when needed; caching them in a separate stats row was overhead that
    // nothing currently reads.
  }
}

// ============================================
// Factory Function
// ============================================

let serviceInstance: SemanticSearchService | null = null;

/**
 * Get or create the semantic search service
 */
export function getSemanticSearchService(prisma: PrismaClient): SemanticSearchService {
  if (!serviceInstance) {
    serviceInstance = new SemanticSearchService(prisma);
  }
  return serviceInstance;
}

/**
 * Reset the service (for testing)
 */
export function resetSemanticSearchService(): void {
  serviceInstance = null;
}
