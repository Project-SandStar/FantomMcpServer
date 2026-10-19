/**
 * GET /admin/heavy-job (lazy-incremental-indexing.md 3.12 item 6): what holds
 * the heavy-job lock, in one human sentence plus progress, for the dashboard
 * banner. POST /admin/heavy-job/cancel cancels an Axon job (the one kind
 * with a cancel path here); other kinds answer with their own page.
 */

import type { Router, Request, Response } from 'express';
import { getHeavyJobStatus } from '../embedding/embedGate.js';

export function registerHeavyJobRoutes(router: Router): void {
  router.get('/heavy-job', (_req: Request, res: Response): void => {
    res.json(getHeavyJobStatus());
  });

  router.post('/heavy-job/cancel', async (_req: Request, res: Response): Promise<void> => {
    const s = getHeavyJobStatus();
    if (!s.holder) { res.status(404).json({ error: 'no heavy job is running' }); return; }
    if (s.holder.kind === 'axon-index') {
      const { getActiveAxonJob, cancelAxonJob } = await import('../axon/axonIndexer.js');
      const j = getActiveAxonJob();
      if (j) { cancelAxonJob(j.id); res.json({ success: true, cancelled: j.id }); return; }
    }
    res.status(409).json({ error: `${s.message}. Cancel it on ${s.progress?.page ?? 'its own page'}.`, page: s.progress?.page ?? null });
  });
}
