/**
 * Admin routes for deleting one indexing run ("delete this parse" in the AST
 * viewer). Mounted from createAdminRouter with a single call. Semantics live
 * in src/fantom-code/indexRunDelete.ts.
 *
 *   GET    /admin/code-projects/:id/index-runs/:runId/delete-preview
 *   DELETE /admin/code-projects/:id/index-runs/:runId
 *
 * Both answer 404 when the run is not this project's. DELETE answers 409 when
 * the plan refuses (only run, project indexing) or another heavy job holds
 * the lock (same body shape as POST /code-projects/:id/reindex).
 */

import type { Router, Request, Response } from 'express';
import { isProjectIndexing } from '../fantom-code/activeIndexing.js';
import { loadIndexRunDeletePlan, countRunVectors, executeIndexRunDelete } from '../fantom-code/indexRunDelete.js';

function parseIds(req: Request): { projectId: number; runId: number } | null {
  const projectId = parseInt(req.params.id as string, 10);
  const runId = parseInt(req.params.runId as string, 10);
  if (!Number.isFinite(projectId) || !Number.isFinite(runId)) return null;
  return { projectId, runId };
}

export function registerIndexRunRoutes(router: Router): void {
  router.get('/code-projects/:id/index-runs/:runId/delete-preview', async (req: Request, res: Response): Promise<void> => {
    try {
      const ids = parseIds(req);
      if (!ids) { res.status(400).json({ error: 'Invalid project or run id' }); return; }
      const { getPrismaClient } = await import('../db/prisma.js');
      const plan = await loadIndexRunDeletePlan(getPrismaClient(), ids.projectId, ids.runId, isProjectIndexing(ids.projectId));
      if (!plan) { res.status(404).json({ error: 'Index run not found for this project' }); return; }
      // Vector count is advisory (Lance may be busy); a failure leaves it null.
      let vectorRows: number | null = null;
      try { vectorRows = await countRunVectors(plan); } catch { /* shown as unknown */ }
      const { vectorQualifiedNames, ...rest } = plan;
      res.json({ ...rest, vectorSymbols: vectorQualifiedNames.length, vectorRows });
    } catch (error) {
      console.error('[Admin] Failed to preview index-run delete:', error);
      res.status(500).json({ error: 'Failed to preview index-run delete', details: String(error) });
    }
  });

  router.delete('/code-projects/:id/index-runs/:runId', async (req: Request, res: Response): Promise<void> => {
    const ids = parseIds(req);
    if (!ids) { res.status(400).json({ error: 'Invalid project or run id' }); return; }
    // Heavy-job lock: no delete under a re-embed / forced reindex / Axon index
    // (they read and write the same vectors). 409 + holder, like reindex.
    const { acquireHeavyJob, HeavyJobBusyError } = await import('../embedding/embedGate.js');
    let release: (() => void) | null = null;
    try {
      release = acquireHeavyJob('code-reindex', `project ${ids.projectId}: delete run #${ids.runId}`);
    } catch (e) {
      if (e instanceof HeavyJobBusyError) {
        res.status(409).json({ error: e.humanMessage, heavyJob: e.holder });
        return;
      }
      res.status(500).json({ error: 'Failed to delete index run', details: String(e) });
      return;
    }
    try {
      const { getPrismaClient } = await import('../db/prisma.js');
      const prisma = getPrismaClient();
      const plan = await loadIndexRunDeletePlan(prisma, ids.projectId, ids.runId, isProjectIndexing(ids.projectId));
      if (!plan) { res.status(404).json({ error: 'Index run not found for this project' }); return; }
      if (plan.refusal) { res.status(409).json({ error: plan.refusal }); return; }
      const result = await executeIndexRunDelete(prisma, plan);
      console.log(`[Admin] Deleted index run #${ids.runId} of project ${ids.projectId}: `
        + `${result.apiChangesDeleted} api changes, ${result.edgeChangesDeleted} edge changes, `
        + `${result.vectorsDeleted} vectors, ${result.indexedFilesCleared} files marked for re-parse`);
      res.json({ success: true, isLatest: plan.isLatest, ...result });
    } catch (error) {
      console.error('[Admin] Failed to delete index run:', error);
      res.status(500).json({ error: 'Failed to delete index run', details: String(error) });
    } finally {
      release?.();
    }
  });
}
