/**
 * /admin/indexing/* — AI change reports and the focus set
 * (docs/proposals/lazy-incremental-indexing.md 3.11, D2, D9; phase 1b).
 *
 *   POST /admin/indexing/report        X-Fantom-Hook-Token only (no Basic Auth)
 *   GET  /admin/indexing/context       X-Fantom-Hook-Token only (no Basic Auth)
 *   POST /admin/indexing/report-token  Basic Auth, admin: new token, shown once
 *   GET  /admin/indexing/focus         Basic Auth: the focus set
 *
 * The report and context paths are the only routes of the admin router that
 * skip Basic Auth: routes.ts registers them with registerIndexingHookRoute()
 * BEFORE the auth middleware, and the handlers always answer (never call
 * next), so only exactly `POST /indexing/report` and `GET /indexing/context`
 * are exempt; every other method and path still meets Basic Auth. The hook
 * files then hold no admin password. `context` (claudePlugin/ SessionStart
 * hook) returns project names and roots, nothing from the code itself.
 *
 * The token is 32 random bytes; the config keeps only its sha256
 * (`indexing.reportToken.sha256`), written through atomicWriteConfigFile.
 * No token configured → every report is refused. The clear value is
 * returned once and never logged.
 */

import * as crypto from 'crypto';
import type { Router, Request, Response } from 'express';
import { atomicWriteConfigFile, readConfigFileWithRecovery } from '../config/index.js';
import { loadLazyConfig, runtimeConfigPath } from '../indexing/lazyConfig.js';
import { createLogger } from '../utils/index.js';
import type { LazyIndexScheduler } from '../indexing/scheduler.js';
import type { PrismaClient } from '@prisma/client';
import { buildSessionContext } from './sessionContext.js';

const logger = createLogger('lazy-index');

export const HOOK_TOKEN_HEADER = 'x-fantom-hook-token';

export interface IndexingRouteOptions {
  /** Config file holding the token hash (tests point this at a temp file). */
  configPath?: () => string;
  /** Scheduler for the rekey routes (tests); default the boot runtime. */
  scheduler?: () => Pick<LazyIndexScheduler, 'enqueueRekey' | 'prismaClient'> | null;
  /** Prisma client for the context route (tests); default the shared client. */
  prisma?: () => PrismaClient;
}

function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function hashReportToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Stored sha256 hex of the report token, or null when none is set. */
export function readReportTokenHash(configPath = runtimeConfigPath()): string | null {
  const file = readConfigFileWithRecovery(configPath);
  const h = file?.indexing?.reportToken?.sha256;
  return typeof h === 'string' && /^[0-9a-f]{64}$/.test(h) ? h : null;
}

/** Constant-time check of a presented token against the stored hash. */
export function verifyReportToken(presented: unknown, storedHash: string | null): boolean {
  if (!storedHash || typeof presented !== 'string' || presented.length === 0 || presented.length > 512) return false;
  const a = Buffer.from(hashReportToken(presented), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * New token: 32 random bytes (base64url). Stores only the hash, through the
 * crash-safe writer, touching only `indexing.reportToken`. Replaces any old
 * token (the old one stops working).
 */
export function createReportToken(configPath = runtimeConfigPath()): { token: string; createdAt: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  const createdAt = new Date().toISOString();
  const file = readConfigFileWithRecovery(configPath) ?? {};
  const indexing = isObj(file.indexing) ? file.indexing : {};
  indexing.reportToken = { sha256: hashReportToken(token), createdAt };
  file.indexing = indexing;
  atomicWriteConfigFile(configPath, file);
  return { token, createdAt };
}

function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err); }

/**
 * POST /indexing/report. Register BEFORE the Basic Auth middleware; the
 * handler answers every request itself.
 */
export function registerIndexingHookRoute(router: Router, opts: IndexingRouteOptions = {}): void {
  const cfgPath = opts.configPath ?? runtimeConfigPath;
  router.post('/indexing/report', async (req: Request, res: Response) => {
    try {
      if (!verifyReportToken(req.get(HOOK_TOKEN_HEADER), readReportTokenHash(cfgPath()))) {
        return res.status(401).json({ error: 'Invalid or missing report token' });
      }
      const b = isObj(req.body) ? req.body : {};
      const files = Array.isArray(b.files) ? b.files : typeof b.file === 'string' ? [b.file] : [];
      if (files.length === 0) return res.status(400).json({ error: 'files must be a non-empty array' });
      const { reportChanges } = await import('../indexing/focusTools.js');
      const result = await reportChanges({
        files, cwd: b.cwd, sessionId: b.sessionId, client: b.client, intent: b.intent,
        projectId: b.projectId, projectPath: b.projectPath,
      });
      return res.status(202).json(result);
    } catch (err) {
      logger.warn(`[focus] report failed: ${errMsg(err)}`);
      return res.status(400).json({ error: errMsg(err) });
    }
  });

  // GET /indexing/context?cwd=<abs path>: the SessionStart hook of the
  // Claude Code plugin. Same token as the report route; answers itself.
  router.get('/indexing/context', async (req: Request, res: Response) => {
    try {
      if (!verifyReportToken(req.get(HOOK_TOKEN_HEADER), readReportTokenHash(cfgPath()))) {
        return res.status(401).json({ error: 'Invalid or missing report token' });
      }
      const cwd = typeof req.query.cwd === 'string' ? req.query.cwd.trim() : '';
      if (!cwd) return res.status(400).json({ error: 'cwd is required' });
      const prisma = opts.prisma ? opts.prisma() : (await import('../db/prisma.js')).getPrismaClient();
      const { focusSnapshot } = await import('../indexing/focusTools.js');
      const ctx = await buildSessionContext({
        prisma,
        cwd,
        lazyConfig: loadLazyConfig(cfgPath()),
        focusCount: async (pid) => (await focusSnapshot()).files.filter(f => f.projectId === pid).length,
      });
      res.setHeader('Cache-Control', 'no-store');
      return res.json(ctx);
    } catch (err) {
      logger.warn(`[focus] context failed: ${errMsg(err)}`);
      return res.status(500).json({ error: errMsg(err) });
    }
  });
}

/** Routes behind Basic Auth. Register AFTER the auth middleware. */
export function registerIndexingRoutes(router: Router, opts: IndexingRouteOptions = {}): void {
  const cfgPath = opts.configPath ?? runtimeConfigPath;

  router.post('/indexing/report-token', (req: Request, res: Response) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    try {
      const { token, createdAt } = createReportToken(cfgPath());
      logger.info(`[focus] report token replaced by ${req.user.username}`);
      return res.json({
        token,
        createdAt,
        header: 'X-Fantom-Hook-Token',
        note: 'Shown once; the server keeps only its sha256. Creating a new token revokes this one.',
      });
    } catch (err) {
      return res.status(500).json({ error: errMsg(err) });
    }
  });

  router.get('/indexing/report-token', (_req: Request, res: Response) => {
    const file = readConfigFileWithRecovery(cfgPath());
    const t = file?.indexing?.reportToken;
    return res.json({ configured: readReportTokenHash(cfgPath()) !== null, createdAt: t?.createdAt ?? null });
  });

  router.get('/indexing/focus', async (_req: Request, res: Response) => {
    try {
      const { focusSnapshot } = await import('../indexing/focusTools.js');
      return res.json(await focusSnapshot());
    } catch (err) {
      return res.status(500).json({ error: errMsg(err) });
    }
  });

  // Stable symbol keys (lazy-incremental-indexing.md 3.8): re-key ONE project.
  // By hand only; runs in the scheduler's runNow lane whether the lazy flag
  // is on or not, yields while a heavy job holds the lock. Progress: the
  // index_tasks row (kind 'rekey') and GET /indexing/rekey/:projectId.
  router.post('/indexing/rekey/:projectId', async (req: Request, res: Response) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId) || projectId <= 0) return res.status(400).json({ error: 'projectId must be a positive integer' });
    try {
      const { getLazyIndexScheduler } = await import('../indexing/runtime.js');
      const sched = (opts.scheduler ?? getLazyIndexScheduler)();
      if (!sched) return res.status(503).json({ error: 'lazy indexing runtime not started yet; retry after boot' });
      const r = await sched.enqueueRekey(projectId);
      logger.info(`[rekey] project=${projectId} enqueued by ${req.user?.username ?? '?'} (task ${r.taskId}, ${r.action})`);
      return res.status(202).json({ projectId, ...r });
    } catch (err) {
      return res.status(500).json({ error: errMsg(err) });
    }
  });

  router.get('/indexing/rekey/:projectId', async (req: Request, res: Response) => {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId) || projectId <= 0) return res.status(400).json({ error: 'projectId must be a positive integer' });
    try {
      const { getLazyIndexScheduler } = await import('../indexing/runtime.js');
      const sched = (opts.scheduler ?? getLazyIndexScheduler)();
      const prisma = sched?.prismaClient;
      if (!prisma) return res.status(503).json({ error: 'lazy indexing runtime not started yet' });
      const project = await prisma.fantomProject.findUnique({ where: { id: projectId }, select: { keyScheme: true, rekeyedAt: true } });
      if (!project) return res.status(404).json({ error: 'project not found' });
      const task = await prisma.indexTask.findFirst({ where: { projectId, kind: 'rekey' }, orderBy: { id: 'desc' } });
      const links = await prisma.symbolLink.count({ where: { projectId, kind: 'rekey' } });
      return res.json({ projectId, keyScheme: project.keyScheme, rekeyedAt: project.rekeyedAt, links, task });
    } catch (err) {
      return res.status(500).json({ error: errMsg(err) });
    }
  });
}
