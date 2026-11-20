/**
 * Answer fast path from knowledge cards.
 *
 * vector + FTS over cards → keep fresh cards at or above minConfidence whose
 * sources still hash the same → if the best cosine reaches matchThreshold, a
 * fast model answers from the 3-5 best cards plus their graph-neighbour cards.
 * Otherwise the caller falls back to the normal ask path.
 */
import { chat } from '../openrouter/client.js';
import { openRouterPool } from '../openrouter/workerPool.js';
import { selectQueryEmbeddingProvider } from '../embedding/providers/embeddingProvider.js';
import { applyQueryInstruction } from '../embedding/queryInstruction.js';
import { getCardSettings, isSidecarModelId, type KnowledgeCardSettings } from './cardSettings.js';
import { sidecarCardChat, SidecarCardModelError } from './cardSidecar.js';
import { searchCards, cardsByNodeIds, type KnowledgeCard } from './cardStore.js';
import { verifyFresh } from './cardStaleness.js';

export interface CardAnswer {
  answered: boolean;
  /** Why it fell back, when it did. */
  reason?: string;
  answer?: string;
  cards?: Array<{ nodeId: string; projectId: number; qualifiedName: string; filePath: string; lineStart: number; score: number; builtAt: string; writerModel: string }>;
  citations?: Array<{ nodeId: string; qualifiedName: string; filePath: string; lineStart: number }>;
  model?: string;
  costUsd?: number | null;
  bestScore?: number;
  builtAt?: string;
  timings: { searchMs: number; answerMs: number; totalMs: number };
}

const ANSWER_SYSTEM = `Answer the question using ONLY the knowledge cards given. Each card lists facts with [file:line].
Cite file:line for each fact you use. If the cards do not answer the question, reply exactly: NOT_IN_CARDS
Be short and direct.`;

export async function answerFromCards(
  query: string,
  opts: { projectIds?: number[]; writerModel?: string; settings?: KnowledgeCardSettings; topK?: number } = {},
): Promise<CardAnswer> {
  const t0 = Date.now();
  const s = opts.settings ?? getCardSettings();
  const timings = { searchMs: 0, answerMs: 0, totalMs: 0 };
  const done = (r: Omit<CardAnswer, 'timings'>): CardAnswer => {
    timings.totalMs = Date.now() - t0;
    return { ...r, timings };
  };
  const encoder = await selectQueryEmbeddingProvider('code');
  const vec = await encoder.embed(applyQueryInstruction(query, encoder.getModelName(), 'code'));
  const hits = await searchCards(vec, query, { projectIds: opts.projectIds, writerModel: opts.writerModel, limit: 12 });
  const good = hits.filter(h => h.card.confidence >= s.minConfidence && h.card.status === 'fresh');
  const { fresh } = await verifyFresh(good.map(h => h.card));
  const freshIds = new Set(fresh.map(c => c.rowId));
  const top = good.filter(h => freshIds.has(h.card.rowId)).slice(0, opts.topK ?? 5);
  timings.searchMs = Date.now() - t0;
  const bestScore = top.reduce((m, h) => Math.max(m, h.score), 0);
  if (!top.length) return done({ answered: false, reason: hits.length ? 'no fresh card above the confidence floor' : 'no cards matched', bestScore });
  if (bestScore < s.matchThreshold) return done({ answered: false, reason: `best match ${bestScore.toFixed(2)} < threshold ${s.matchThreshold}`, bestScore });

  // Graph-neighbour cards: links come from graph edges, not model text.
  const neighbours: KnowledgeCard[] = [];
  const byProject = new Map<number, string[]>();
  for (const h of top.slice(0, 3)) {
    const ids = h.card.links.slice(0, 6).map(l => l.nodeId);
    byProject.set(h.card.projectId, [...(byProject.get(h.card.projectId) ?? []), ...ids]);
  }
  const have = new Set(top.map(h => h.card.nodeId));
  for (const [pid, ids] of byProject) {
    const found = await cardsByNodeIds(pid, [...new Set(ids)].filter(i => !have.has(i)), opts.writerModel);
    const ok = found.filter(c => c.status === 'fresh' && c.confidence >= s.minConfidence);
    neighbours.push(...(await verifyFresh(ok)).fresh.slice(0, 4));
  }
  const used = [...top.map(h => h.card), ...neighbours];
  const ctx = used.map((c, i) => `CARD ${i + 1} (${c.kind} ${c.qualifiedName}):\n${c.text}`).join('\n\n');
  const ta = Date.now();
  const userMsg = `${ctx}\n\nQUESTION: ${query}`;
  const builtAt = used.map(c => c.builtAt).sort()[0]?.slice(0, 10) ?? '';
  const cards = top.map(h => ({
    nodeId: h.card.nodeId, projectId: h.card.projectId, qualifiedName: h.card.qualifiedName, filePath: h.card.filePath,
    lineStart: h.card.lineStart, score: Math.round(h.score * 1000) / 1000, builtAt: h.card.builtAt, writerModel: h.card.writerModel,
  }));
  let out: { text: string; model: string; costUsd: number | null };
  if (isSidecarModelId(s.answerModel)) {
    // Sidecar answer model: no OpenRouter call and no paid fallback. A busy or
    // missing host means the caller takes the normal ask path.
    try {
      out = await sidecarCardChat(ANSWER_SYSTEM, userMsg, s.answerModel, { maxTokens: 900, timeoutMs: 60_000, lane: 'interactive' });
    } catch (err) {
      if (!(err instanceof SidecarCardModelError)) throw err;
      timings.answerMs = Date.now() - ta;
      return done({ answered: false, reason: `sidecar answer model: ${err.message}`, cards, bestScore, model: s.answerModel, costUsd: 0 });
    }
  } else {
    out = await openRouterPool().submit({
      role: 'knowledge-answer', lane: 'interactive', projectId: top[0].card.projectId,
      run: () => chat([{ role: 'system', content: ANSWER_SYSTEM }, { role: 'user', content: userMsg }], {
        role: 'code-assistant', model: s.answerModel, maxTokens: 900, temperature: 0.1, timeoutMs: 60_000,
      }),
    });
  }
  timings.answerMs = Date.now() - ta;
  if (!out.text.trim() || /NOT_IN_CARDS/.test(out.text)) {
    return done({ answered: false, reason: 'answer model said the cards do not cover it', cards, bestScore, model: out.model, costUsd: out.costUsd });
  }
  return done({
    answered: true,
    answer: `${out.text.trim()}\n\n(from knowledge cards, built ${builtAt})`,
    cards,
    citations: used.filter(c => c.filePath).map(c => ({ nodeId: c.nodeId, qualifiedName: c.qualifiedName, filePath: c.filePath, lineStart: c.lineStart })),
    model: out.model, costUsd: out.costUsd, bestScore, builtAt,
  });
}
