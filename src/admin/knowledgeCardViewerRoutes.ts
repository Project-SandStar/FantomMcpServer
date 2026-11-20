/**
 * /admin/knowledge-cards/viewer/* — read-only routes for the Knowledge Card
 * viewer page (dashboard/src/app/knowledge-cards/page.tsx).
 *
 *   GET /knowledge-cards/viewer/list?projectId=<id>|all&writerModel=&kind=&mark=&q=&sort=&offset=&limit=
 *       slim rows (no vectors, no claims/sources/links JSON), paged, plus totals
 *   GET /knowledge-cards/viewer/card?rowId=
 *       one full card, live fresh/stale per source, neighbour cards (from the
 *       stored graph links), and every writer's card for the same node
 *   GET /knowledge-cards/viewer/ids?projectId=&...   every row id matching the filters (select all)
 *   GET /knowledge-cards/viewer/counts               per-project counts + running builds (projects column)
 *   POST /knowledge-cards/viewer/export {rowIds}     full cards without vectors (export, read-only)
 *   GET /knowledge-cards/viewer/source?rowId=&i=
 *       the source lines of one card source (addressed by card + index, never
 *       by a free path)
 *
 * Nothing here writes to the cards table: freshness is checked with
 * sha256File, never verifyFresh (which marks cards stale). No graph reads:
 * fan-in is the count of caller links stored on the card.
 */
import fs from 'fs';
import type { Router, Request, Response } from 'express';
import type { KnowledgeCard } from '../knowledge/cardStore.js';

export type CardMark = 'good' | 'low' | 'stale' | 'failed';
export type CardSort = 'fanin' | 'confidence' | 'newest';

export interface CardListRow {
  rowId: string; nodeId: string; projectId: number; kind: string; name: string; qualifiedName: string;
  filePath: string; lineStart: number; lineEnd: number; snippet: string; writerModel: string; checkerModel: string;
  builtAt: string; confidence: number; checkResult: string; firstCheck: string; attempts: number;
  status: string; mark: CardMark; fanIn: number; claims: number; costUsd: number;
}

/** good / low confidence / stale / failed check, from the stored status. */
export function cardMark(c: Pick<KnowledgeCard, 'status' | 'confidence'>, minConfidence: number): CardMark {
  if (c.status === 'flagged') return 'failed';
  if (c.status === 'stale' || c.status === 'check') return 'stale';
  return c.confidence < minConfidence ? 'low' : 'good';
}

/** Callers recorded on the card; project and pod cards sort first. */
export function cardFanIn(c: Pick<KnowledgeCard, 'kind' | 'links'>): number {
  if (c.kind === 'project') return Number.MAX_SAFE_INTEGER;
  if (c.kind === 'pod') return Number.MAX_SAFE_INTEGER - 1;
  return c.links.filter(l => l.relation === 'caller').length;
}

export function toListRow(c: KnowledgeCard, minConfidence: number): CardListRow {
  const body = c.text.split('\n').slice(1).join(' ').replace(/\s+/g, ' ').trim();
  return {
    rowId: c.rowId, nodeId: c.nodeId, projectId: c.projectId, kind: c.kind, name: c.name, qualifiedName: c.qualifiedName,
    filePath: c.filePath, lineStart: c.lineStart, lineEnd: c.lineEnd, snippet: body.slice(0, 220),
    writerModel: c.writerModel, checkerModel: c.checkerModel, builtAt: c.builtAt, confidence: c.confidence,
    checkResult: c.checkResult, firstCheck: c.firstCheck, attempts: c.attempts, status: c.status,
    mark: cardMark(c, minConfidence), fanIn: cardFanIn(c), claims: c.claims.length,
    costUsd: Math.round((c.writerCostUsd + c.checkerCostUsd) * 1e6) / 1e6,
  };
}

export interface ListQuery { kind?: string; mark?: string; q?: string; sort?: CardSort; offset?: number; limit?: number }

/** Rows matching the filters, sorted (no paging). */
export function matchCards(cards: KnowledgeCard[], query: ListQuery, minConfidence: number) {
  const rows = cards.map(c => ({ c, r: toListRow(c, minConfidence) }));
  const needle = (query.q ?? '').trim().toLowerCase();
  const hit = rows.filter(({ c, r }) =>
    (!query.kind || r.kind === query.kind)
    && (!query.mark || r.mark === query.mark)
    && (!needle || c.text.toLowerCase().includes(needle) || c.qualifiedName.toLowerCase().includes(needle) || c.filePath.toLowerCase().includes(needle)));
  const sort = query.sort ?? 'fanin';
  hit.sort((a, b) =>
    sort === 'confidence' ? b.r.confidence - a.r.confidence || b.r.fanIn - a.r.fanIn
      : sort === 'newest' ? (b.r.builtAt > a.r.builtAt ? 1 : b.r.builtAt < a.r.builtAt ? -1 : 0)
        : b.r.fanIn - a.r.fanIn || b.r.confidence - a.r.confidence);
  return { rows, hit };
}

/** Filter, sort and page; totals count the whole (writer-filtered) project. */
export function filterCards(cards: KnowledgeCard[], query: ListQuery, minConfidence: number) {
  const { rows, hit } = matchCards(cards, query, minConfidence);
  const totals = { cards: rows.length, good: 0, low: 0, stale: 0, failed: 0, fresh: 0, check: 0, flagged: 0, spentUsd: 0, lastBuilt: '' };
  for (const { c, r } of rows) {
    totals[r.mark]++;
    if (c.status === 'fresh') totals.fresh++;
    if (c.status === 'check') totals.check++;
    if (c.status === 'flagged') totals.flagged++;
    totals.spentUsd += c.writerCostUsd + c.checkerCostUsd;
    if (c.builtAt > totals.lastBuilt) totals.lastBuilt = c.builtAt;
  }
  totals.spentUsd = Math.round(totals.spentUsd * 10000) / 10000;
  // Status counts under the kind / search filters (for the status buttons).
  const { hit: forMarks } = matchCards(cards, { ...query, mark: undefined }, minConfidence);
  const marks = { all: forMarks.length, good: 0, low: 0, stale: 0, failed: 0 };
  for (const { r } of forMarks) marks[r.mark]++;
  const offset = Math.max(0, query.offset ?? 0);
  const limit = Math.min(Math.max(1, query.limit ?? 50), 200);
  const kinds: Record<string, number> = {};
  for (const { r } of rows) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
  return { total: hit.length, offset, limit, rows: hit.slice(offset, offset + limit).map(x => x.r), totals, kinds, marks };
}

/** Most row ids the ids route returns (select-all across pages). */
export const MAX_SELECT_IDS = 20_000;

function intParam(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : null;
}
const strParam = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** projectId query: a positive id, 'all', or null (missing / bad). */
export function projectScopeParam(v: unknown): number | 'all' | null {
  if (v === 'all') return 'all';
  const n = intParam(v);
  return n && n > 0 ? n : null;
}

/** Most row ids one POST may carry (the server's JSON body limit is 100 kB). */
export const MAX_IDS_PER_REQUEST = 1000;

/** rowIds from a body: non-empty list of strings, at most MAX_IDS_PER_REQUEST; else an error text. */
export function rowIdsParam(v: unknown): string[] | string {
  if (!Array.isArray(v) || v.length === 0) return 'rowIds must be a non-empty list';
  const ids = [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 600))];
  if (ids.length !== new Set(v).size) return 'rowIds must be strings';
  if (ids.length > MAX_IDS_PER_REQUEST) return `at most ${MAX_IDS_PER_REQUEST} row ids per request; send them in parts`;
  return ids;
}

async function scopedCards(scope: number | 'all', req: Request) {
  const { cardsForProject, listCards } = await import('../knowledge/cardStore.js');
  const all = scope === 'all' ? await listCards() : await cardsForProject(scope);
  const writers = [...new Set(all.map(c => c.writerModel))].sort();
  const writer = strParam(req.query.writerModel);
  const sortRaw = strParam(req.query.sort);
  const sort: CardSort = sortRaw === 'confidence' || sortRaw === 'newest' ? sortRaw : 'fanin';
  return { all, writers, writer, query: { kind: strParam(req.query.kind), mark: strParam(req.query.mark), q: strParam(req.query.q), sort } as ListQuery };
}

export interface ProjectCountRow {
  projectId: number; name: string; total: number; good: number; low: number; stale: number; failed: number;
  /** Running build / rebuild work for this project: cards done of cards planned. */
  building: { built: number; targets: number } | null;
}

/** Counts per project (projects with cards plus the card project list) and an "all" row. */
export function projectCounts(input: {
  rows: Array<{ projectId: number; status: string; confidence: number }>;
  minConfidence: number;
  projects: Array<{ id: number; name: string }>;
  listed: number[];
  runs: Array<{ projectId: number; built: number; targets: number }>;
  jobs: Array<{ state: string; groups: Array<{ projectId: number; cards: number; built: number; state: string }> }>;
}) {
  const names = new Map(input.projects.map(p => [p.id, p.name]));
  const by = new Map<number, ProjectCountRow>();
  const row = (id: number) => {
    let r = by.get(id);
    if (!r) { r = { projectId: id, name: names.get(id) ?? `project ${id}`, total: 0, good: 0, low: 0, stale: 0, failed: 0, building: null }; by.set(id, r); }
    return r;
  };
  for (const c of input.rows) {
    const r = row(c.projectId);
    r.total++;
    r[cardMark({ status: c.status as KnowledgeCard['status'], confidence: c.confidence }, input.minConfidence)]++;
  }
  for (const id of input.listed) row(id);
  // Every indexed project gets a row, so projects with no cards yet show as "not started".
  for (const p of input.projects) row(p.id);
  const addBuild = (id: number, built: number, targets: number) => {
    const r = row(id);
    r.building = { built: (r.building?.built ?? 0) + built, targets: (r.building?.targets ?? 0) + targets };
  };
  for (const run of input.runs) addBuild(run.projectId, run.built, run.targets);
  for (const j of input.jobs) {
    if (j.state !== 'running' && j.state !== 'queued') continue;
    for (const g of j.groups) if (g.state === 'running' || g.state === 'waiting') addBuild(g.projectId, g.built, g.cards);
  }
  const projects = [...by.values()].sort((a, b) => a.name.localeCompare(b.name) || a.projectId - b.projectId);
  const all = { total: 0, good: 0, low: 0, stale: 0, failed: 0, building: projects.some(p => p.building) };
  for (const p of projects) { all.total += p.total; all.good += p.good; all.low += p.low; all.stale += p.stale; all.failed += p.failed; }
  return { all, projects, rebuilds: input.jobs.filter(j => j.state === 'running' || j.state === 'queued').length };
}

export function registerKnowledgeCardViewerRoutes(router: Router): void {
  router.get('/knowledge-cards/viewer/list', async (req: Request, res: Response): Promise<void> => {
    const scope = projectScopeParam(req.query.projectId);
    if (scope === null) { res.status(400).json({ error: 'projectId is required (a project id or "all")' }); return; }
    try {
      const { getCardSettings } = await import('../knowledge/cardSettings.js');
      const s = getCardSettings();
      const { all, writers, writer, query } = await scopedCards(scope, req);
      const out = filterCards(writer ? all.filter(c => c.writerModel === writer) : all, {
        ...query, offset: intParam(req.query.offset) ?? 0, limit: intParam(req.query.limit) ?? 50,
      }, s.minConfidence);
      res.json({ projectId: scope, writerModel: writer ?? null, writers, minConfidence: s.minConfidence, ...out });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** Every row id matching the filters, across pages (select all). */
  router.get('/knowledge-cards/viewer/ids', async (req: Request, res: Response): Promise<void> => {
    const scope = projectScopeParam(req.query.projectId);
    if (scope === null) { res.status(400).json({ error: 'projectId is required (a project id or "all")' }); return; }
    try {
      const { getCardSettings } = await import('../knowledge/cardSettings.js');
      const { all, writer, query } = await scopedCards(scope, req);
      const { hit } = matchCards(writer ? all.filter(c => c.writerModel === writer) : all, query, getCardSettings().minConfidence);
      res.json({ total: hit.length, truncated: hit.length > MAX_SELECT_IDS, rowIds: hit.slice(0, MAX_SELECT_IDS).map(x => x.r.rowId) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** Full cards (no vectors) for export, by row id. At most 1000 per call (JSON body limit). */
  router.post('/knowledge-cards/viewer/export', async (req: Request, res: Response): Promise<void> => {
    const ids = rowIdsParam(req.body?.rowIds);
    if (typeof ids === 'string') { res.status(400).json({ error: ids }); return; }
    try {
      const { cardsByRowIds } = await import('../knowledge/cardStore.js');
      const { getCardSettings } = await import('../knowledge/cardSettings.js');
      const s = getCardSettings();
      const byId = new Map((await cardsByRowIds(ids)).map(c => [c.rowId, c]));
      res.json({ cards: ids.map(id => byId.get(id)).filter((c): c is KnowledgeCard => !!c).map(c => ({ ...c, mark: cardMark(c, s.minConfidence) })) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** Per-project counts for the projects column; no card text is loaded. */
  router.get('/knowledge-cards/viewer/counts', async (_req: Request, res: Response): Promise<void> => {
    try {
      const { cardStatusRows } = await import('../knowledge/cardStore.js');
      const { getCardSettings } = await import('../knowledge/cardSettings.js');
      const { buildRuns } = await import('../knowledge/cardBuilder.js');
      const { rebuildQueue } = await import('../knowledge/cardRebuild.js');
      const s = getCardSettings();
      let projects: Array<{ id: number; name: string }> = [];
      try {
        const { getPrismaClient } = await import('../db/prisma.js');
        projects = await getPrismaClient().fantomProject.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
      } catch { /* names fall back to ids */ }
      const runs = buildRuns().filter(r => r.state === 'running');
      const jobs = (await rebuildQueue()).list();
      res.json(projectCounts({
        rows: await cardStatusRows(), minConfidence: s.minConfidence, projects,
        listed: s.projectScope === 'list' ? s.projectIds : [], runs, jobs,
      }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/knowledge-cards/viewer/card', async (req: Request, res: Response): Promise<void> => {
    const rowId = strParam(req.query.rowId);
    if (!rowId) { res.status(400).json({ error: 'rowId is required' }); return; }
    try {
      const { listCards, cardsByNodeIds } = await import('../knowledge/cardStore.js');
      const { getCardSettings } = await import('../knowledge/cardSettings.js');
      const { sha256File, localPath } = await import('../knowledge/cardFacts.js');
      const s = getCardSettings();
      const [card] = await listCards(`row_id = '${rowId.replace(/'/g, "''")}'`, 1);
      if (!card) { res.status(404).json({ error: 'card not found' }); return; }
      const hashes = new Map<string, string | null>();
      const sources = card.sources.map((src, i) => {
        if (!hashes.has(src.file)) hashes.set(src.file, sha256File(localPath(src.file)));
        const now = hashes.get(src.file) ?? null;
        return { ...src, index: i, readable: now !== null, fresh: now === src.hash };
      });
      // Neighbour cards: same writer first, any writer as fallback.
      const linkIds = [...new Set(card.links.map(l => l.nodeId))].slice(0, 200);
      const nb = await cardsByNodeIds(card.projectId, linkIds);
      const byNode = new Map<string, KnowledgeCard>();
      for (const c of nb) {
        const cur = byNode.get(c.nodeId);
        if (!cur || (c.writerModel === card.writerModel && cur.writerModel !== card.writerModel)) byNode.set(c.nodeId, c);
      }
      const links = card.links.map(l => {
        const c = byNode.get(l.nodeId);
        return { ...l, card: c ? { rowId: c.rowId, mark: cardMark(c, s.minConfidence), writerModel: c.writerModel, confidence: c.confidence } : null };
      });
      const variants = (await cardsByNodeIds(card.projectId, [card.nodeId]))
        .sort((a, b) => a.writerModel.localeCompare(b.writerModel))
        .map(c => ({ ...c, mark: cardMark(c, s.minConfidence) }));
      res.json({ card: { ...card, mark: cardMark(card, s.minConfidence), fanIn: cardFanIn(card) }, sources, links, variants, minConfidence: s.minConfidence });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/knowledge-cards/viewer/source', async (req: Request, res: Response): Promise<void> => {
    const rowId = strParam(req.query.rowId);
    const i = intParam(req.query.i) ?? 0;
    if (!rowId) { res.status(400).json({ error: 'rowId is required' }); return; }
    try {
      const { listCards } = await import('../knowledge/cardStore.js');
      const { localPath } = await import('../knowledge/cardFacts.js');
      const [card] = await listCards(`row_id = '${rowId.replace(/'/g, "''")}'`, 1);
      if (!card) { res.status(404).json({ error: 'card not found' }); return; }
      // Index 0..n-1 are the card sources; n means the card's own span.
      const src = i < card.sources.length ? card.sources[i]
        : i === card.sources.length && card.filePath ? { file: card.filePath, lineStart: card.lineStart, lineEnd: card.lineEnd } : null;
      if (!src) { res.status(404).json({ error: 'no such source' }); return; }
      let text: string;
      try { text = fs.readFileSync(localPath(src.file), 'utf-8'); } catch { res.status(404).json({ error: 'file not readable on the server', file: src.file }); return; }
      const all = text.split('\n');
      const from = Math.max(1, (src.lineStart || 1) - 3);
      const to = Math.min(all.length, Math.max(from, (src.lineEnd || src.lineStart || 1) + 3, from + 10), from + 400);
      res.json({ file: src.file, lineStart: src.lineStart, lineEnd: src.lineEnd, from, to, lines: all.slice(from - 1, to) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
