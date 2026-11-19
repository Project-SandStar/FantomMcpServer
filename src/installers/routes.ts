/**
 * /admin/installers/* — "Check & add Haxall / SkySpark" on the Instances page
 * and the "Installer sources" settings. Behind the admin Basic Auth.
 *
 *   GET  /installers/settings              settings + which secrets are set
 *   PUT  /installers/settings              save (secrets: string=set, null=remove)
 *   GET  /installers/haxall/check          GitHub releases vs instances
 *   POST /installers/haxall/install        { version }            -> job
 *   POST /installers/haxall/:id/compile    rebuild that instance's home -> job
 *   POST /installers/haxall/:id/set-home   find <path>/home (bin+lib) and save it
 *   GET  /installers/skyspark/check        source installers vs instances
 *   POST /installers/skyspark/install      { version }            -> job
 *   GET  /installers/jobs                  recent jobs (no logs)
 *   GET  /installers/jobs/active           the running job or { status: 'none' }
 *   GET  /installers/jobs/:id?since=N      job + log lines from N on
 *   POST /installers/jobs/:id/cancel
 */

import type { Router, Request, Response } from 'express';
import { getFantomDatabase } from '../fantom/database.js';
import {
  cancelInstallerJob, getActiveInstallerJob, getInstallerJob, InstallerBusyError, jobLogSince,
  listInstallerJobs, startInstallerJob,
} from './jobs.js';
import { getInstallerSettingsView, saveInstallerSettings } from './settings.js';
import { checkHaxall, buildHaxall, compileInstanceHome, detectHome } from './haxall.js';
import { checkSkyspark, installSkyspark } from './skyspark.js';
import { updateInstancePath } from './common.js';
import { startInstallerAutoCheck } from './autoCheck.js';

const VERSION_RE = /^\d+\.\d+\.\d+$/;

function fail(res: Response, e: unknown): void {
  if (e instanceof InstallerBusyError) {
    res.status(409).json({ error: e.message, jobId: e.active.id });
    return;
  }
  res.status(500).json({ error: (e as Error).message });
}

async function getInstance(id: number) {
  const db = getFantomDatabase();
  await db.initialize();
  return db.getInstanceById(id);
}

export function registerInstallerRoutes(router: Router): void {
  startInstallerAutoCheck();

  router.get('/installers/settings', (_req: Request, res: Response): void => {
    try { res.json(getInstallerSettingsView()); } catch (e) { fail(res, e); }
  });

  router.put('/installers/settings', (req: Request, res: Response): void => {
    try { res.json(saveInstallerSettings(req.body)); } catch (e) { fail(res, e); }
  });

  router.get('/installers/haxall/check', async (_req: Request, res: Response): Promise<void> => {
    try { res.json(await checkHaxall()); } catch (e) { fail(res, e); }
  });

  router.post('/installers/haxall/install', (req: Request, res: Response): void => {
    const version = String(req.body?.version ?? '');
    if (!VERSION_RE.test(version)) { res.status(400).json({ error: 'version (x.y.z) is required' }); return; }
    try {
      const job = startInstallerJob('haxall-install', `Build Haxall ${version}`, ctx => buildHaxall(ctx, version));
      res.status(202).json({ jobId: job.id });
    } catch (e) { fail(res, e); }
  });

  router.post('/installers/haxall/:id/compile', async (req: Request, res: Response): Promise<void> => {
    try {
      const inst = await getInstance(parseInt(String(req.params.id), 10));
      if (!inst) { res.status(404).json({ error: 'Instance not found' }); return; }
      if (inst.type !== 'haxall') { res.status(400).json({ error: 'Compile home is for Haxall instances' }); return; }
      if (!inst.version || !VERSION_RE.test(inst.version)) { res.status(400).json({ error: 'Instance needs a version (x.y.z)' }); return; }
      const job = startInstallerJob('haxall-compile', `Compile home for ${inst.name}`, ctx => compileInstanceHome(ctx, inst));
      res.status(202).json({ jobId: job.id });
    } catch (e) { fail(res, e); }
  });

  router.post('/installers/haxall/:id/set-home', async (req: Request, res: Response): Promise<void> => {
    try {
      const inst = await getInstance(parseInt(String(req.params.id), 10));
      if (!inst) { res.status(404).json({ error: 'Instance not found' }); return; }
      const home = detectHome(inst.path);
      if (!home) { res.status(404).json({ error: `No home found under ${inst.path} (looked for home/ or a folder with bin/ and lib/). Use "Compile home".` }); return; }
      if (home === inst.path) { res.json({ changed: false, path: home }); return; }
      const updated = await updateInstancePath(inst.id, home);
      res.json({ changed: true, path: updated.path });
    } catch (e) { fail(res, e); }
  });

  router.get('/installers/skyspark/check', async (_req: Request, res: Response): Promise<void> => {
    try { res.json(await checkSkyspark()); } catch (e) { fail(res, e); }
  });

  router.post('/installers/skyspark/install', (req: Request, res: Response): void => {
    const version = String(req.body?.version ?? '');
    if (!VERSION_RE.test(version)) { res.status(400).json({ error: 'version (x.y.z) is required' }); return; }
    try {
      const job = startInstallerJob('skyspark-install', `Install SkySpark ${version}`, ctx => installSkyspark(ctx, version));
      res.status(202).json({ jobId: job.id });
    } catch (e) { fail(res, e); }
  });

  router.get('/installers/jobs', (_req: Request, res: Response): void => {
    res.json({ jobs: listInstallerJobs() });
  });

  router.get('/installers/jobs/active', (_req: Request, res: Response): void => {
    const j = getActiveInstallerJob();
    if (!j) { res.json({ status: 'none' }); return; }
    const { log: _l, ...rest } = j;
    res.json(rest);
  });

  router.get('/installers/jobs/:id', (req: Request, res: Response): void => {
    const job = getInstallerJob(String(req.params.id));
    if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
    const since = Math.max(0, parseInt(String(req.query.since ?? '0'), 10) || 0);
    const { log: _l, ...rest } = job;
    const { lines, next } = jobLogSince(job, since);
    res.json({ ...rest, lines, next });
  });

  router.post('/installers/jobs/:id/cancel', (req: Request, res: Response): void => {
    if (cancelInstallerJob(String(req.params.id))) res.json({ success: true });
    else res.status(404).json({ error: 'No running job with that id' });
  });
}
