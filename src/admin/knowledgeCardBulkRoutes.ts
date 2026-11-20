/**
 * /admin/knowledge-cards/* bulk tools for the viewer page. Admin role only.
 *
 *   POST /knowledge-cards/rebuild        {rowIds} → {job}  rebuild exactly these cards, each with its own writer
 *   GET  /knowledge-cards/rebuild/jobs   recent rebuild jobs (newest first)
 *   GET  /knowledge-cards/rebuild/:id    one job's progress
 *   POST /knowledge-cards/rebuild/:id/stop
 *   POST /knowledge-cards/delete         {rowIds} → {deleted}
 *
 * At most MAX_IDS_PER_REQUEST ids per POST (JSON body limit); the page sends
 * larger selections in parts.
 */
import type { Router, Request, Response, NextFunction } from 'express';
import type { RebuildQueue } from '../knowledge/cardRebuild.js';
import { rowIdsParam } from './knowledgeCardViewerRoutes.js';

export interface BulkRouteDeps {
  queue(): Promise<RebuildQueue>;
  deleteCards(rowIds: string[]): Promise<number>;
  /** Free builds skip the cap; others are refused up front when the day's cap is spent. */
  capBlocked(): Promise<string | null>;
}

const defaultDeps: BulkRouteDeps = {
  queue: async () => (await import('../knowledge/cardRebuild.js')).rebuildQueue(),
  deleteCards: async ids => (await import('../knowledge/cardStore.js')).deleteCards(ids),
  capBlocked: async () => {
    const { getCardSettings, isSidecarModelId } = await import('../knowledge/cardSettings.js');
    const { capReached } = await import('../knowledge/cardBuilder.js');
    const s = getCardSettings();
    // Per-writer checks happen in the job; here only the case where nothing can run.
    if (capReached(s) && s.checkPass && !isSidecarModelId(s.checkerModel)) return `daily card spend cap $${s.dailyCapUsd} reached`;
    return null;
  },
};

export function adminOnly(req: Request, res: Response, next: NextFunction): void {
  const u = (req as any).user;
  if (res.locals.apiTokenOk || u?.role === 'admin') { next(); return; }
  res.status(u ? 403 : 401).json({ error: u ? 'Admin access required' : 'Authentication required' });
}

export function registerKnowledgeCardBulkRoutes(router: Router, deps: Partial<BulkRouteDeps> = {}): void {
  const d: BulkRouteDeps = { ...defaultDeps, ...deps };

  router.post('/knowledge-cards/rebuild', adminOnly, async (req: Request, res: Response): Promise<void> => {
    const ids = rowIdsParam(req.body?.rowIds);
    if (typeof ids === 'string') { res.status(400).json({ error: ids }); return; }
    try {
      const blocked = await d.capBlocked();
      if (blocked) { res.status(402).json({ error: blocked }); return; }
      res.json({ job: (await d.queue()).start(ids) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/knowledge-cards/rebuild/jobs', adminOnly, async (_req: Request, res: Response): Promise<void> => {
    res.json({ jobs: (await d.queue()).list() });
  });

  router.get('/knowledge-cards/rebuild/:id', adminOnly, async (req: Request, res: Response): Promise<void> => {
    const job = (await d.queue()).get(String(req.params.id));
    if (!job) { res.status(404).json({ error: 'no such job' }); return; }
    res.json({ job });
  });

  router.post('/knowledge-cards/rebuild/:id/stop', adminOnly, async (req: Request, res: Response): Promise<void> => {
    res.json({ stopping: (await d.queue()).stop(String(req.params.id)) });
  });

  router.post('/knowledge-cards/delete', adminOnly, async (req: Request, res: Response): Promise<void> => {
    const ids = rowIdsParam(req.body?.rowIds);
    if (typeof ids === 'string') { res.status(400).json({ error: ids }); return; }
    try {
      res.json({ deleted: await d.deleteCards(ids) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
