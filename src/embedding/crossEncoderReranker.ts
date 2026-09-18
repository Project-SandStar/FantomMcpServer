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
import { rerankLocalFirst } from './rerankRouter.js';

export interface CrossEncoderRerankerOptions {
  enabled: boolean;
  /** Pin the LOCAL model. The OpenRouter path takes its model from the
   *  sidecar's per-master allow-list, which is authoritative there. */
  model?: string;
  topK?: number;     // candidates to send to the reranker (default 50)
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
const DEFAULT_TOP_K = 50;

function candidateText(r: SemanticSearchResult): string {
  // Send the most distinguishing fields the model can score against.
  return [
    r.qualifiedName || r.name,
    r.signature ?? '',
    r.documentation?.slice(0, 800) ?? '',
  ].filter(Boolean).join('\n');
}

export async function crossEncoderRerank(
  query: string,
  results: SemanticSearchResult[],
  options: CrossEncoderRerankerOptions,
): Promise<SemanticSearchResult[]> {
  if (!options.enabled || results.length === 0) return results;

  const topK = Math.min(options.topK ?? DEFAULT_TOP_K, results.length);
  const candidates = results.slice(0, topK);
  const documents = candidates.map(candidateText);

  const outcome = await rerankLocalFirst(query, documents, {
    model: options.model,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (!outcome) return results;

  // Apply scores to the head; preserve the tail (results beyond topK).
  const head = candidates.map(r => ({ ...r }));
  for (let i = 0; i < head.length; i++) {
    const score = outcome.scores[i];
    if (typeof score !== 'number') continue;
    (head[i] as any).crossEncoderScore = score;
    // Equal-weight blend so the cross-encoder dominates but the graph score
    // still nudges ties.
    head[i].combinedScore = 0.7 * score + 0.3 * head[i].combinedScore;
  }
  head.sort((a, b) => b.combinedScore - a.combinedScore);

  return [...head, ...results.slice(topK)];
}
