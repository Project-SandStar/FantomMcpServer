/**
 * Path mapping admin routes: GET/PUT /admin/path-mappings.
 * See src/utils/pathMapping.ts. Register AFTER the auth middleware.
 */
import type { Router, Request, Response, NextFunction } from 'express';
import {
  getPathMappingsWithSource, savePathMappings, checkPathMappings, sanitizePathMappings,
} from '../utils/pathMapping.js';

function adminOnly(req: Request, res: Response, next: NextFunction): void {
  const u = (req as any).user;
  if (res.locals.apiTokenOk || u?.role === 'admin') { next(); return; }
  res.status(u ? 403 : 401).json({ error: u ? 'Admin access required' : 'Authentication required' });
}

export function registerPathMappingRoutes(router: Router): void {
  router.get('/path-mappings', (_req: Request, res: Response): void => {
    const { env, saved } = getPathMappingsWithSource();
    res.json({ env: checkPathMappings(env), saved: checkPathMappings(saved) });
  });

  router.put('/path-mappings', adminOnly, (req: Request, res: Response): void => {
    const rows = req.body?.mappings;
    if (!Array.isArray(rows)) { res.status(400).json({ error: 'mappings must be an array of {from, to}' }); return; }
    const clean = sanitizePathMappings(rows);
    if (clean.length !== rows.length) { res.status(400).json({ error: 'each mapping needs a non-empty, different from and to' }); return; }
    const saved = savePathMappings(clean);
    res.json({ success: true, saved: checkPathMappings(saved) });
  });
}
