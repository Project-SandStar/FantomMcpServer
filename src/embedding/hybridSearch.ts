/**
 * Hybrid retrieval helpers: reciprocal rank fusion (RRF) of the vector and
 * keyword (FlexSearch symbol) result lists, plus the settings readers and the
 * reranker-availability probe used by SemanticSearchService.search().
 *
 * Everything in here is pure or cheap; the service owns the I/O.
 *
 * Settings (`semanticSearch.*`, runtime config, no restart needed):
 *   hybrid: { enabled: true, vectorWeight: 1.0, keywordWeight: 0.7 }
 *   rerank: 'auto' | 'on' | 'off'   (default 'auto')
 */

import { readRuntimeSemantic, isSidecarUsable } from './providers/embeddingProvider.js';
import { listSidecars } from '../sidecars/registry.js';
import type { Sidecar } from '../admin/types.js';

export type RetrievalSource = 'vector' | 'keyword';
export type ResultSources = Array<'vector' | 'keyword' | 'both'>;

export interface HybridSettings {
  enabled: boolean;
  vectorWeight: number;
  keywordWeight: number;
}

export type RerankMode = 'auto' | 'on' | 'off';

export const DEFAULT_HYBRID: HybridSettings = { enabled: true, vectorWeight: 1.0, keywordWeight: 0.7 };
export const RRF_K = 60;
/** Candidates pulled from each retriever and handed to the reranker. */
export const HYBRID_CANDIDATES = 50;

function num(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : dflt;
}

export function readHybridSettings(): HybridSettings {
  const h = readRuntimeSemantic()?.hybrid;
  if (!h || typeof h !== 'object') return { ...DEFAULT_HYBRID };
  return {
    enabled: typeof h.enabled === 'boolean' ? h.enabled : DEFAULT_HYBRID.enabled,
    vectorWeight: num(h.vectorWeight, DEFAULT_HYBRID.vectorWeight),
    keywordWeight: num(h.keywordWeight, DEFAULT_HYBRID.keywordWeight),
  };
}

/**
 * Optional ABSOLUTE score floor for vector hits — `semanticSearch.vectorScoreFloor`.
 * Default null = no floor: top-k ranking and the reranker decide.
 *
 * Deliberately a NEW key. The runtime config still carries a legacy
 * `semanticSearch.minScore: 0.5` from the bge-small era that this path never
 * read (it hardcoded 0.3); honouring it now would silently reintroduce the
 * failure this replaces. Measured 2026-09-18 with exact (refined) IVF_PQ
 * scores: real hits land at 0.70–0.75, but PQ *estimates* sat at 0.24–0.34,
 * which is how a 0.3 floor returned zero rows for "open sax file".
 */
export function readMinScore(): number | null {
  const v = Number((readRuntimeSemantic() as any)?.vectorScoreFloor);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function readRerankMode(): RerankMode {
  const v = readRuntimeSemantic()?.rerank;
  return v === 'on' || v === 'off' || v === 'auto' ? v : 'auto';
}

// ---------------------------------------------------------------------------
// Keyword query variants
// ---------------------------------------------------------------------------

/**
 * Query variants for the keyword (FlexSearch) leg of hybrid search, best-first.
 * The symbol index is prefix-tokenized ("rete" matches ReteEditorMixin) but a
 * LONGER query token never matches a shorter symbol ("retejs" ≠ "rete"), so:
 * raw query → tokens with library suffixes stripped ("retejs" → "rete",
 * "vue-router" → "vue router") → camel/kebab split → shorter prefixes of a
 * single long token (≥ 4 chars). Duplicates removed, order preserved, max 6.
 */
export function keywordQueryVariants(query: string): string[] {
  const out: string[] = [];
  const push = (s: string) => { const t = s.trim(); if (t && !out.includes(t)) out.push(t); };
  const q = query.trim();
  if (!q) return out;
  push(q);
  const tokens = q.split(/\s+/).filter(Boolean);
  const stripped = tokens.map(t => t.replace(/[-_.]?(jsx?|tsx?|vue|css|scss|mjs|cjs)$/i, ''));
  if (stripped.some((t, i) => t !== tokens[i])) push(stripped.filter(t => t.length >= 2).join(' '));
  const split = q.split(/[-_./:]+|(?<=[a-z0-9])(?=[A-Z])/).filter(t => t.length >= 2);
  if (split.length > tokens.length) push(split.join(' '));
  if (tokens.length === 1) {
    const base = stripped[0] || tokens[0];
    for (let n = Math.min(base.length - 1, 8); n >= 4; n--) push(base.slice(0, n));
  }
  return out.slice(0, 6);
}

// ---------------------------------------------------------------------------
// Reciprocal rank fusion
// ---------------------------------------------------------------------------

export interface RankedList<T> {
  source: RetrievalSource;
  weight: number;
  /** Already ordered best-first. */
  items: T[];
  /** Dedup key for an item (nodeId, or filePath:line as a fallback). */
  key: (item: T) => string;
}

export interface FusedEntry<T> {
  key: string;
  item: T;                    // first-seen representative (vector list wins when both)
  score: number;              // raw RRF score: Σ weight / (k + rank)
  normalized: number;         // score / max attainable (all lists rank 1) → 0..1
  sources: ResultSources;     // ['vector'] | ['keyword'] | ['both']
  ranks: Partial<Record<RetrievalSource, number>>;  // 1-based rank per list
}

/**
 * Fuse ranked lists with RRF: score(d) = Σ_lists weight_l / (k + rank_l(d)).
 * Items present in several lists accumulate; ties broken by best single rank.
 */
export function rrfFuse<T>(lists: Array<RankedList<T>>, k: number = RRF_K): Array<FusedEntry<T>> {
  const acc = new Map<string, FusedEntry<T>>();
  const maxScore = lists.reduce((s, l) => s + (l.items.length ? l.weight / (k + 1) : 0), 0) || 1;

  for (const list of lists) {
    const seenInList = new Set<string>();
    for (let i = 0; i < list.items.length; i++) {
      const item = list.items[i];
      const key = list.key(item);
      if (seenInList.has(key)) continue; // duplicate row inside one list: keep first rank
      seenInList.add(key);
      const rank = i + 1;
      const contrib = list.weight / (k + rank);
      const cur = acc.get(key);
      if (cur) {
        cur.score += contrib;
        cur.ranks[list.source] = rank;
        cur.sources = ['both'];
      } else {
        acc.set(key, {
          key, item, score: contrib, normalized: 0,
          sources: [list.source], ranks: { [list.source]: rank },
        });
      }
    }
  }

  const out = [...acc.values()];
  for (const e of out) e.normalized = Math.min(1, e.score / maxScore);
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ra = Math.min(...Object.values(a.ranks) as number[]);
    const rb = Math.min(...Object.values(b.ranks) as number[]);
    return ra - rb;
  });
  return out;
}

/** How many of the first `n` positions differ between two orderings (by key). */
export function countChangedPositions<T>(before: T[], after: T[], key: (t: T) => string, n: number): number {
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const a = before[i] ? key(before[i]) : undefined;
    const b = after[i] ? key(after[i]) : undefined;
    if (a !== b) changed++;
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Reranker availability (auto mode), cached like the embedding provider TTL
// ---------------------------------------------------------------------------

const RERANKER_TTL_MS = 60_000;
let rerankerCache: { at: number; sidecar: Sidecar | null } | null = null;

/** First usable sidecar advertising capability `reranker`, or null. Cached 60 s. */
export function rerankerSidecarUsable(now = Date.now()): Sidecar | null {
  if (rerankerCache && now - rerankerCache.at < RERANKER_TTL_MS) {
    // Re-validate the cached pick cheaply: if it went stale, re-resolve now.
    if (rerankerCache.sidecar && isSidecarUsable(rerankerCache.sidecar, now)) return rerankerCache.sidecar;
    if (!rerankerCache.sidecar) return null;
  }
  const cands = listSidecars({ capability: 'reranker', enabled: true }).filter(sc => isSidecarUsable(sc, now));
  const pick = cands[0] ?? null;
  rerankerCache = { at: now, sidecar: pick };
  return pick;
}

/** Test hook. */
export function resetRerankerCache(): void { rerankerCache = null; }
