/**
 * Cross-encoder rerank stage for semantic search results.
 *
 * Routing lives in `rerankRouter.ts`: LOCAL FIRST (a usable sidecar with
 * capability `reranker` — gpu-01's vLLM Qwen3-Reranker-8B, probing the
 * Cohere-style /v1/rerank then vLLM's /v1/score), with an OpenRouter-backed
 * virtual container as fallback when no local reranker is usable or the local
 * request fails.
 *
 * This stage runs AFTER vector retrieval + graph enrichment but BEFORE the
 * LLM rerank. On any failure (no backend, network error, parse error) the
 * input results are returned unchanged — reranking is an improvement, never a
 * dependency.
 */

import type { SemanticSearchResult } from './semanticSearchService.js';
import type { Sidecar } from '../admin/types.js';
import { createHash } from 'crypto';
import { rerankLocalFirst } from './rerankRouter.js';

export interface CrossEncoderRerankerOptions {
  enabled: boolean;
  /** Pin the LOCAL model. The OpenRouter path takes its model from the
   *  sidecar's per-master allow-list, which is authoritative there. */
  model?: string;
  topK?: number;     // candidates to send to the reranker (default 50)
  /** Characters of each hit's chunk text to include (0 = names/signature/doc only). */
  codeChars?: number;
  /** Which part of the chunk text to add (default 'all'). */
  codeMode?: RerankCodeMode;
  /** Weight of the cross-encoder score vs the fused score (default 0.7). */
  xeWeight?: number;
  timeoutMs?: number; // default 8 s — fall back to the input order on timeout
  /**
   * Pre-selected sidecar from the caller's own probe. The router re-resolves
   * through `rerankerSidecarUsable()` (same 60 s cache, same health and fault
   * rules), so this is now only a hint that a local reranker was seen; it is
   * accepted for source compatibility and not used to bypass the router.
   */
  sidecar?: Sidecar;
}

const DEFAULT_TIMEOUT_MS = 8_000;

/** In-memory LRU of cross-encoder scores, (model, query, doc text) → score. */
const SCORE_CACHE_MAX = 20_000;
const SCORE_CACHE_TTL_MS = 30 * 60_000;
const scoreCache = new Map<string, { s: number; at: number }>();
let lastRerankModel = '';
function scoreKey(model: string, query: string, doc: string): string {
  return createHash('sha1').update(`${model}\u001f${query}\u001f${doc}`).digest('hex');
}
function scoreCacheGet(k: string): number | undefined {
  const e = scoreCache.get(k);
  if (!e) return undefined;
  if (Date.now() - e.at > SCORE_CACHE_TTL_MS) { scoreCache.delete(k); return undefined; }
  scoreCache.delete(k); scoreCache.set(k, e);
  return e.s;
}
function scoreCacheSet(k: string, s: number): void {
  scoreCache.set(k, { s, at: Date.now() });
  while (scoreCache.size > SCORE_CACHE_MAX) scoreCache.delete(scoreCache.keys().next().value as string);
}
/** Test seam. */
export function __clearRerankScoreCache(): void { scoreCache.clear(); lastRerankModel = ''; }
const DEFAULT_TOP_K = 50;

/** How the chunk text is added: 'all' = as stored (preamble + body);
 *  'body' = code only (no kind/file/imports/name/signature/doc lines, no
 *  leading comments or imports); 'missing-doc' = body, only for hits that
 *  have no doc comment. */
export type RerankCodeMode = 'all' | 'body' | 'missing-doc';

const PREAMBLE_RE = /^(kind: |file: )/;
const LEAD_SKIP_RE = /^\s*(\/\/|\/\*|\*|\*\*|#|import\s|using\s|package\s|from\s+\S+\s+import\s)/;
/** Code body of a stored chunk: drop the embed preamble and leading
 *  comments/imports. */
export function chunkBody(r: Pick<SemanticSearchResult, 'chunkText' | 'qualifiedName' | 'signature' | 'documentation'>): string {
  const lines = (r.chunkText ?? '').split('\n');
  const nameLine = (r.qualifiedName ?? '').replace(/::/g, ' ').replace(/\./g, ' ').trim();
  const sig = (r.signature ?? '').replace(/\s+/g, ' ').trim();
  const doc = (r.documentation ?? '').trim();
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t || PREAMBLE_RE.test(t) || t === nameLine || (sig && t === sig) || (doc && doc.includes(t)) || LEAD_SKIP_RE.test(t)) { i++; continue; }
    break;
  }
  return lines.slice(i).join('\n').trim();
}

function candidateText(r: SemanticSearchResult, codeChars = 0, mode: RerankCodeMode = 'all'): string {
  // Send the most distinguishing fields the model can score against; with
  // codeChars > 0 also part of the matched chunk (the code itself).
  let code = '';
  if (codeChars > 0) {
    if (mode === 'all') code = r.chunkText ?? '';
    else if (mode === 'body' || !r.documentation?.trim()) code = chunkBody(r);
  }
  return [
    r.qualifiedName || r.name,
    r.signature ?? '',
    r.documentation?.slice(0, 800) ?? '',
    code.slice(0, codeChars),
  ].filter(Boolean).join('\n');
}
export const __candidateTextForTest = candidateText;

export async function crossEncoderRerank(
  query: string,
  results: SemanticSearchResult[],
  options: CrossEncoderRerankerOptions,
): Promise<SemanticSearchResult[]> {
  if (!options.enabled || results.length === 0) return results;

  const topK = Math.min(options.topK ?? DEFAULT_TOP_K, results.length);
  const candidates = results.slice(0, topK);
  const documents = candidates.map(r => candidateText(r, options.codeChars ?? 0, options.codeMode ?? 'all'));

  // Score cache: a cross-encoder scores each (query, document) pair on its
  // own, so cached pairs are skipped and only the rest go to the reranker.
  const modelKey = options.model ?? lastRerankModel;
  const keys = documents.map(d => scoreKey(modelKey, query, d));
  const scores: Array<number | undefined> = keys.map(k => scoreCacheGet(k));
  const missIdx = scores.map((v, i) => (v === undefined ? i : -1)).filter(i => i >= 0);
  if (missIdx.length > 0) {
    const outcome = await rerankLocalFirst(query, missIdx.map(i => documents[i]), {
      model: options.model,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (!outcome) return results;
    // A different model than the cached scores came from: do not mix them.
    if (outcome.model && outcome.model !== modelKey && missIdx.length < documents.length) {
      lastRerankModel = outcome.model;
      scoreCache.clear();
      return crossEncoderRerank(query, results, options);
    }
    if (outcome.model) lastRerankModel = outcome.model;
    missIdx.forEach((di, j) => {
      const sc = outcome.scores[j];
      scores[di] = typeof sc === 'number' ? sc : undefined;
      if (typeof sc === 'number') scoreCacheSet(scoreKey(outcome.model || modelKey, query, documents[di]), sc);
    });
  }
  const outcome = { scores };

  // Apply scores to the head; preserve the tail (results beyond topK).
  const head = candidates.map(r => ({ ...r }));
  for (let i = 0; i < head.length; i++) {
    const score = outcome.scores[i];
    if (typeof score !== 'number') continue;
    (head[i] as any).crossEncoderScore = score;
    // Equal-weight blend so the cross-encoder dominates but the graph score
    // still nudges ties.
    const w = options.xeWeight ?? 0.7;
    head[i].combinedScore = w * score + (1 - w) * head[i].combinedScore;
  }
  head.sort((a, b) => b.combinedScore - a.combinedScore);

  return [...head, ...results.slice(topK)];
}
