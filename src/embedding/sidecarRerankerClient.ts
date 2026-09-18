/**
 * Generic cross-encoder rerank client. Sends a (query, documents[]) pair to a
 * reranker backend and returns scores aligned to the input order. Used by code
 * search, docs search and Axon search.
 *
 * Routing lives in `rerankRouter.ts`: LOCAL FIRST (a usable sidecar with
 * capability `reranker`, probing /v1/rerank then /v1/score), with an
 * OpenRouter-backed virtual container as fallback when no local reranker is
 * usable or the local request fails. Returns null on any failure so callers
 * can skip rerank gracefully — unchanged contract, so every existing call
 * site keeps working and gains the cloud fallback for free.
 */

import { rerankLocalFirst, type RerankPath } from './rerankRouter.js';

export interface SidecarRerankOptions {
  model?: string;
  timeoutMs?: number;
}

export interface SidecarRerankResult {
  /** Score per document, aligned to the input order. */
  scores: number[];
  /** The model that actually produced the scores. */
  model: string;
  /** Which backend served it — `local` or `openrouter`. */
  path?: RerankPath;
  /** Local sidecar name, or the `<PCName>-OR-Reranker` provider name. */
  servedBy?: string;
}

export async function callSidecarReranker(
  query: string,
  documents: string[],
  options: SidecarRerankOptions = {},
): Promise<SidecarRerankResult | null> {
  if (documents.length === 0) return { scores: [], model: options.model ?? '' };
  const outcome = await rerankLocalFirst(query, documents, options);
  if (!outcome) return null;
  return {
    scores: outcome.scores,
    model: outcome.model,
    path: outcome.path,
    servedBy: outcome.servedBy,
  };
}
