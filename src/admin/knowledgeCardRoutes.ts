/**
 * /admin/knowledge-cards/* — the "Knowledge Graph Cards" config tab.
 * Register AFTER the Basic Auth middleware.
 *
 *   GET  /knowledge-cards            settings, limits, model options (live prices), status per project
 *   PUT  /knowledge-cards            save settings (range-checked)
 *   POST /knowledge-cards/estimate   {projectId, writerModel?, limit?} → targets + USD estimate
 *   POST /knowledge-cards/build      {projectId, writerModel?, limit?, onlyStale?} → start a build
 *   POST /knowledge-cards/stop       {projectId, writerModel?}
 *   POST /knowledge-cards/ask        {query, projectId?, projectIds?, writerModel?} → card path only (test)
 *   POST /knowledge-cards/scan       {projectId} → re-hash sources, mark stale / check
 *   POST /knowledge-cards/test-stale {projectId} → corrupt one stored hash, report the result
 *   GET  /knowledge-cards/cards?projectId=&writerModel=&limit=  list cards
 *
 * The OpenRouter key never appears in a reply or a log line.
 */
import type { Router, Request, Response } from 'express';
import {
  getCardSettings, saveCardSettings, validateCardInput, validateModelChoices,
  CARD_LIMITS, CARD_MODEL_OPTIONS,
} from '../knowledge/cardSettings.js';
import { sidecarModelOptions } from '../knowledge/cardSidecar.js';

interface ModelInfo {
  id: string; inPerM: number; outPerM: number; context: number; live: boolean;
  /** 'sidecar' = a local model on the sidecars (free); absent = OpenRouter. */
  source?: 'openrouter' | 'sidecar';
  /** Sidecar: container name (e.g. ss-completion), the model(s) it serves, offline hosts. */
  container?: string;
  models?: string[];
  offline?: string[];
  hosts?: string[];
  /** Why the option cannot be chosen now (sidecar offline, or blocked for this OpenRouter account). */
  reason?: string;
}

/**
 * Models the account may use (`/models/user`, honours ZDR / privacy settings);
 * null when unknown (no key, or the call failed). Cached with the catalogue.
 */
let userIds: Set<string> | null = null;
async function refreshUserIds(): Promise<void> {
  try {
    const { userModelIds } = await import('../openrouter/client.js');
    const ids = await userModelIds();
    userIds = ids.size ? ids : null;
  } catch { /* keep the last known set */ }
}

/** Mark OpenRouter options this account cannot use as not live, with the reason. */
export function applyAccountBlocks<T extends { id: string; live: boolean; reason?: string }>(list: T[], allowed: Set<string> | null, learned: (id: string) => string | undefined): T[] {
  return list.map(m => {
    const why = learned(m.id) ?? (allowed && m.live && !allowed.has(m.id) ? 'blocked for this account by OpenRouter (ZDR / privacy settings)' : undefined);
    return why ? { ...m, live: false, reason: why } : m;
  });
}

let modelCache: { at: number; list: ModelInfo[] } | null = null;
/** Every id in OpenRouter's catalogue (null until a fetch works). */
let catalogueIds: Set<string> | null = null;
const MODEL_CACHE_MS = 30 * 60_000;

/** The dropdown options, checked against OpenRouter's public model list. */
async function liveModelOptions(): Promise<ModelInfo[]> {
  if (modelCache && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.list;
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(15_000) });
    const j = await r.json() as { data?: Array<{ id: string; context_length?: number; pricing?: { prompt?: string; completion?: string } }> };
    const byId = new Map((j.data ?? []).map(m => [m.id, m]));
    if (byId.size) catalogueIds = new Set(byId.keys());
    const list = CARD_MODEL_OPTIONS.map(id => {
      const m = byId.get(id);
      return m
        ? { id, inPerM: Number(m.pricing?.prompt ?? 0) * 1e6, outPerM: Number(m.pricing?.completion ?? 0) * 1e6, context: m.context_length ?? 0, live: true }
        : { id, inPerM: 0, outPerM: 0, context: 0, live: false };
    });
    await refreshUserIds();
    modelCache = { at: Date.now(), list };
    return list;
  } catch {
    // Offline: offer the list unchecked rather than nothing.
    return CARD_MODEL_OPTIONS.map(id => ({ id, inPerM: 0, outPerM: 0, context: 0, live: false }));
  }
}

/** OpenRouter options plus the sidecar models (live state read fresh each call). */
async function allModelOptions(): Promise<ModelInfo[]> {
  const sidecar: ModelInfo[] = (await sidecarModelOptions()).map(o => ({
    id: o.id, inPerM: 0, outPerM: 0, context: 0, live: o.live, source: 'sidecar',
    container: o.container, models: o.models, hosts: o.hosts, offline: o.offline,
    ...(o.reason ? { reason: o.reason } : {}),
  }));
  const { accountBlockedReason } = await import('../knowledge/cardSettings.js');
  return [...applyAccountBlocks(await liveModelOptions(), userIds, accountBlockedReason), ...sidecar];
}

/** Live checks for model ids in a request body (only fields that differ from `current`). */
async function modelChoiceProblems(body: Record<string, unknown>, current = getCardSettings()): Promise<string[]> {
  await liveModelOptions(); // fills catalogueIds when OpenRouter is reachable
  return validateModelChoices(body, current, catalogueIds);
}

function priceMap(list: ModelInfo[]): Record<string, { in: number; out: number }> {
  return Object.fromEntries(list.filter(m => m.live).map(m => [m.id, { in: m.inPerM, out: m.outPerM }]));
}

async function projectName(id: number): Promise<string> {
  try {
    const { getPrismaClient } = await import('../db/prisma.js');
    const p = await getPrismaClient().fantomProject.findUnique({ where: { id }, select: { name: true } });
    return p?.name ?? `project ${id}`;
  } catch { return `project ${id}`; }
}

function intParam(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function registerKnowledgeCardRoutes(router: Router): void {
  router.get('/knowledge-cards', async (_req: Request, res: Response): Promise<void> => {
    try {
      const { listCards, cardTableExists } = await import('../knowledge/cardStore.js');
      const { buildRuns, spendToday } = await import('../knowledge/cardBuilder.js');
      const models = await allModelOptions();
      const status = new Map<string, { projectId: number; writerModel: string; total: number; fresh: number; stale: number; check: number; flagged: number; lastBuilt: string; costUsd: number }>();
      if (await cardTableExists()) {
        for (const c of await listCards()) {
          const k = `${c.projectId}|${c.writerModel}`;
          const s = status.get(k) ?? { projectId: c.projectId, writerModel: c.writerModel, total: 0, fresh: 0, stale: 0, check: 0, flagged: 0, lastBuilt: '', costUsd: 0 };
          s.total++;
          s[c.status]++;
          if (c.builtAt > s.lastBuilt) s.lastBuilt = c.builtAt;
          s.costUsd += c.writerCostUsd + c.checkerCostUsd;
          status.set(k, s);
        }
      }
      const { getPrismaClient } = await import('../db/prisma.js');
      const projects = await getPrismaClient().fantomProject.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
      res.json({
        settings: getCardSettings(),
        limits: CARD_LIMITS,
        models,
        projects,
        status: [...status.values()].map(s => ({ ...s, costUsd: Math.round(s.costUsd * 10000) / 10000 })),
        runs: buildRuns(),
        spendToday: spendToday(),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/knowledge-cards', async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const problems = validateCardInput(body);
    if (problems.length) { res.status(400).json({ error: problems.join('; '), problems }); return; }
    const live = await modelChoiceProblems(body);
    if (live.length) { res.status(400).json({ error: live.join('; '), problems: live }); return; }
    try {
      res.json({ settings: saveCardSettings(body) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/knowledge-cards/estimate', async (req: Request, res: Response): Promise<void> => {
    const projectId = intParam(req.body?.projectId);
    if (!projectId) { res.status(400).json({ error: 'projectId is required' }); return; }
    try {
      const { selectTargets } = await import('../knowledge/cardFacts.js');
      const { estimateCost } = await import('../knowledge/cardBuilder.js');
      const s = getCardSettings();
      const limit = intParam(req.body?.limit) ?? s.maxCardsPerProject;
      const targets = await selectTargets(projectId, { ...s, maxCardsPerProject: limit }, await projectName(projectId));
      const writer = typeof req.body?.writerModel === 'string' ? req.body.writerModel : s.writerModel;
      const byKind: Record<string, number> = {};
      for (const t of targets) byKind[t.kind] = (byKind[t.kind] ?? 0) + 1;
      res.json({ projectId, writerModel: writer, targets: targets.length, byKind, estimateUsd: estimateCost(targets.length, s, priceMap(await liveModelOptions()), writer) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/knowledge-cards/build', async (req: Request, res: Response): Promise<void> => {
    const projectId = intParam(req.body?.projectId);
    if (!projectId) { res.status(400).json({ error: 'projectId is required' }); return; }
    const s = getCardSettings();
    const writer = typeof req.body?.writerModel === 'string' && req.body.writerModel.trim() ? req.body.writerModel.trim() : s.writerModel;
    const { capReached, startBuild, buildIsFree } = await import('../knowledge/cardBuilder.js');
    if (writer !== s.writerModel) {
      const bad = await modelChoiceProblems({ writerModel: writer }, s);
      if (bad.length) { res.status(400).json({ error: bad.join('; ') }); return; }
    }
    try {
      const { assertSidecarModelLive } = await import('../knowledge/cardSidecar.js');
      await assertSidecarModelLive(writer);
      if (s.checkPass) await assertSidecarModelLive(s.checkerModel);
    } catch (err) { res.status(409).json({ error: (err as Error).message }); return; }
    if (!buildIsFree(s, writer) && capReached(s)) { res.status(402).json({ error: `daily card spend cap $${s.dailyCapUsd} reached` }); return; }
    try {
      const run = startBuild(projectId, {
        writerModel: writer,
        limit: intParam(req.body?.limit) ?? undefined,
        onlyStale: req.body?.onlyStale === true,
        projectName: await projectName(projectId),
      });
      res.json({ run });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/knowledge-cards/stop', async (req: Request, res: Response): Promise<void> => {
    const projectId = intParam(req.body?.projectId);
    if (!projectId) { res.status(400).json({ error: 'projectId is required' }); return; }
    const { stopBuild } = await import('../knowledge/cardBuilder.js');
    res.json({ stopping: stopBuild(projectId, typeof req.body?.writerModel === 'string' ? req.body.writerModel : undefined) });
  });

  router.post('/knowledge-cards/ask', async (req: Request, res: Response): Promise<void> => {
    const query = req.body?.query;
    if (typeof query !== 'string' || !query.trim()) { res.status(400).json({ error: 'query is required' }); return; }
    try {
      const { answerFromCards } = await import('../knowledge/cardAnswer.js');
      const ids: number[] = Array.isArray(req.body?.projectIds)
        ? req.body.projectIds.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
        : intParam(req.body?.projectId) ? [intParam(req.body.projectId)!] : [];
      res.json(await answerFromCards(query, {
        projectIds: ids.length ? ids : undefined,
        writerModel: typeof req.body?.writerModel === 'string' ? req.body.writerModel : undefined,
      }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/knowledge-cards/scan', async (req: Request, res: Response): Promise<void> => {
    const projectId = intParam(req.body?.projectId);
    if (!projectId) { res.status(400).json({ error: 'projectId is required' }); return; }
    try {
      const { scanProjectStaleness } = await import('../knowledge/cardStaleness.js');
      res.json(await scanProjectStaleness(projectId));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** Staleness test: change one fresh card's stored hash, then check it is marked stale and not served. */
  router.post('/knowledge-cards/test-stale', async (req: Request, res: Response): Promise<void> => {
    const projectId = intParam(req.body?.projectId);
    if (!projectId) { res.status(400).json({ error: 'projectId is required' }); return; }
    try {
      const { cardsForProject, setCardSources, cardsByNodeIds } = await import('../knowledge/cardStore.js');
      const { verifyFresh } = await import('../knowledge/cardStaleness.js');
      const card = (await cardsForProject(projectId)).find(c => c.status === 'fresh' && c.sources.length > 0);
      if (!card) { res.status(404).json({ error: 'no fresh card with sources in this project' }); return; }
      const before = (await verifyFresh([card])).fresh.length === 1;
      await setCardSources(card.rowId, card.sources.map((s, i) => (i === 0 ? { ...s, hash: '0'.repeat(64) } : s)));
      const [changed] = await cardsByNodeIds(projectId, [card.nodeId], card.writerModel);
      const r = await verifyFresh([changed]);
      const [after] = await cardsByNodeIds(projectId, [card.nodeId], card.writerModel);
      res.json({
        rowId: card.rowId, qualifiedName: card.qualifiedName,
        servableBefore: before, servableAfter: r.fresh.length === 1, statusAfter: after?.status,
        note: 'the card stays stale until a rebuild (POST /knowledge-cards/build with onlyStale:true)',
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/knowledge-cards/cards', async (req: Request, res: Response): Promise<void> => {
    const projectId = intParam(req.query.projectId);
    if (!projectId) { res.status(400).json({ error: 'projectId is required' }); return; }
    try {
      const { cardsForProject } = await import('../knowledge/cardStore.js');
      const limit = Math.min(intParam(req.query.limit) ?? 50, 1000);
      const writer = typeof req.query.writerModel === 'string' ? req.query.writerModel : undefined;
      const cards = (await cardsForProject(projectId, writer)).slice(0, limit);
      res.json({ cards });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
