/**
 * Admin routes for the Axon integration. Mounted from createAdminRouter with a
 * single call so src/admin/routes.ts stays untouched otherwise.
 *
 *   GET  /admin/axon/status                          MCP client health + table + totals
 *   GET  /admin/axon/validate?path=                  inspect a candidate projectPath
 *   GET  /admin/axon/projects                        per-project embedding status
 *   GET  /admin/axon/projects/:instance/:project/functions?page&pageSize&q
 *   POST /admin/axon/index {projectId?, force?}      start an index job
 *   GET  /admin/axon/jobs                            list jobs
 *   POST /admin/axon/jobs/:id/cancel
 *   POST /admin/axon/search {query, projectId?, mode, limit}
 *   POST /admin/axon/connect | /disconnect           manual MCP control
 *   GET  /admin/axon/tools                           tool list from the Axon server
 *   POST /admin/axon/tool {name, args}               proxy one tool call
 *   GET  /admin/axon/sample-text?projectId&name      rendered embedding text (debug)
 */

import type { Router, Request, Response } from 'express';
import { getAxonSettings, resolveAxonEmbeddingModel } from '../axon/axonSettings.js';
import { axonGrammarStatus, initAxonGrammar } from '../axon/axonTreeSitter.js';
import { validateAxonProjectPath, buildAxonEmbeddingChunksFor } from '../axon/axonProjParser.js';
import { validateAxonLibraryPath, scanAllAxonProjects, parseAnyAxonProject } from '../axon/axonLibraryParser.js';
import { getAxonMcpClient } from '../axon/axonMcpClient.js';
import {
  startAxonIndex, listAxonJobs, getAxonJob, cancelAxonJob, getActiveAxonJob,
  getAxonProjectsStatus, listAxonProjectFunctions,
} from '../axon/axonIndexer.js';
import { axonSearch, type AxonSearchMode } from '../axon/axonSearch.js';
import { AXON_EMBED_TEXT_VERSION } from '../axon/axonEmbeddingText.js';
import { getHeavyJob, getHeavyJobQueue } from '../embedding/embedGate.js';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export function registerAxonRoutes(router: Router): void {
  router.get('/axon/status', async (_req: Request, res: Response): Promise<void> => {
    try {
      const settings = getAxonSettings();
      // Warm it here too: the preview routes (`sample-text`, `functions`) are
      // sync, and a cold grammar would show them line-window chunks while the
      // indexer produced statement chunks.
      void initAxonGrammar();
      const client = getAxonMcpClient();
      const mcp = client.getStatus();
      // Opportunistic connect when enabled so the status page shows a live state.
      if (settings.enabled && !mcp.connected && !mcp.connecting) {
        client.ensureConnected().catch(() => { /* surfaced via lastError */ });
      }
      const status = await getAxonProjectsStatus();
      res.json({
        settings,
        mcp: client.getStatus(),
        embedding: {
          ...resolveAxonEmbeddingModel(),
          embedTextVersion: AXON_EMBED_TEXT_VERSION,
          // The grammar is what makes chunks statement-shaped; without it an
          // index run refuses to start, so its state belongs on this page.
          grammar: axonGrammarStatus(),
        },
        table: status.table,
        totals: status.totals,
        activeJob: getActiveAxonJob() ?? null,
        heavyJob: getHeavyJob(),
        heavyJobQueue: getHeavyJobQueue(),
      });
    } catch (e) {
      res.status(500).json({ error: errMsg(e) });
    }
  });

  router.get('/axon/validate', (req: Request, res: Response): void => {
    const kind = req.query.kind === 'library' ? 'library' : 'proj';
    const fallback = kind === 'library' ? getAxonSettings().libraryPath : getAxonSettings().projectPath;
    const p = typeof req.query.path === 'string' && req.query.path.trim() ? req.query.path.trim() : fallback;
    try {
      res.json(kind === 'library' ? { kind, ...validateAxonLibraryPath(p) } : { kind, ...validateAxonProjectPath(p) });
    } catch (e) {
      res.status(500).json({ error: errMsg(e) });
    }
  });

  router.get('/axon/projects', async (_req: Request, res: Response): Promise<void> => {
    try {
      res.json(await getAxonProjectsStatus());
    } catch (e) {
      res.status(500).json({ error: errMsg(e) });
    }
  });

  router.get('/axon/projects/:instance/:project/functions', async (req: Request, res: Response): Promise<void> => {
    try {
      const projectId = `${req.params.instance}/${req.params.project}`;
      const page = parseInt(String(req.query.page ?? '1'), 10);
      const pageSize = parseInt(String(req.query.pageSize ?? '50'), 10);
      const q = typeof req.query.q === 'string' ? req.query.q : undefined;
      res.json(await listAxonProjectFunctions(projectId, { page, pageSize, q }));
    } catch (e) {
      res.status(404).json({ error: errMsg(e) });
    }
  });

  router.post('/axon/index', (req: Request, res: Response): void => {
    try {
      const { projectId, force, source } = (req.body ?? {}) as { projectId?: string; force?: boolean; source?: 'proj' | 'library' | 'all' };
      const job = startAxonIndex({ projectId: projectId || undefined, force: !!force, source: source === 'proj' || source === 'library' ? source : 'all' });
      res.json({ success: true, job });
    } catch (e) {
      res.status(409).json({ error: errMsg(e) });
    }
  });

  router.get('/axon/jobs', (_req: Request, res: Response): void => {
    res.json({ jobs: listAxonJobs(), active: getActiveAxonJob() ?? null });
  });

  router.get('/axon/jobs/:id', (req: Request, res: Response): void => {
    const j = getAxonJob(String(req.params.id));
    if (!j) { res.status(404).json({ error: 'job not found' }); return; }
    res.json(j);
  });

  router.post('/axon/jobs/:id/cancel', (req: Request, res: Response): void => {
    const j = cancelAxonJob(String(req.params.id));
    if (!j) { res.status(404).json({ error: 'job not found' }); return; }
    res.json({ success: true, job: j });
  });

  router.post('/axon/search', async (req: Request, res: Response): Promise<void> => {
    try {
      const { query, projectId, mode, limit, source } = (req.body ?? {}) as {
        query?: string; projectId?: string; mode?: AxonSearchMode; limit?: number; source?: 'proj' | 'library' | 'all';
      };
      if (!query || typeof query !== 'string') { res.status(400).json({ error: 'query is required' }); return; }
      const m: AxonSearchMode = mode === 'rerank' || mode === 'rlm' ? mode : 'vector';
      const out = await axonSearch(query, {
        projectId: projectId || undefined,
        source: source === 'proj' || source === 'library' ? source : 'all',
        mode: m,
        limit: limit !== undefined ? Math.min(parseInt(String(limit), 10) || 20, 100) : 20,
      });
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: errMsg(e) });
    }
  });

  router.post('/axon/connect', async (_req: Request, res: Response): Promise<void> => {
    try {
      await getAxonMcpClient().ensureConnected();
      res.json({ success: true, mcp: getAxonMcpClient().getStatus() });
    } catch (e) {
      res.status(502).json({ error: errMsg(e), mcp: getAxonMcpClient().getStatus() });
    }
  });

  router.post('/axon/disconnect', async (_req: Request, res: Response): Promise<void> => {
    await getAxonMcpClient().disconnect('admin');
    res.json({ success: true, mcp: getAxonMcpClient().getStatus() });
  });

  router.get('/axon/tools', async (_req: Request, res: Response): Promise<void> => {
    try {
      await getAxonMcpClient().ensureConnected();
      res.json({ tools: getAxonMcpClient().listTools() });
    } catch (e) {
      res.status(502).json({ error: errMsg(e), tools: [] });
    }
  });

  router.post('/axon/tool', async (req: Request, res: Response): Promise<void> => {
    try {
      const { name, args } = (req.body ?? {}) as { name?: string; args?: Record<string, unknown> };
      if (!name) { res.status(400).json({ error: 'name is required' }); return; }
      const out = await getAxonMcpClient().callTool(name, args ?? {});
      res.json({ name, isError: out.isError, text: out.text });
    } catch (e) {
      res.status(502).json({ error: errMsg(e) });
    }
  });

  // Debug: the exact text a function embeds from (all chunks).
  router.get('/axon/sample-text', (req: Request, res: Response): void => {
    try {
      const projectId = String(req.query.projectId ?? '');
      const name = String(req.query.name ?? '');
      const ref = scanAllAxonProjects('all').find(p => p.projectId === projectId);
      if (!ref) { res.status(404).json({ error: `unknown project ${projectId}` }); return; }
      const records = parseAnyAxonProject(ref);
      const rec = name ? records.find(r => r.name === name) : records[0];
      if (!rec) { res.status(404).json({ error: `unknown function ${name}` }); return; }
      res.json({
        embedTextVersion: AXON_EMBED_TEXT_VERSION,
        function: { id: rec.id, name: rec.name, signature: rec.signature, params: rec.paramDefs, returnType: rec.returnType, tags: rec.tags, lineStart: rec.lineStart, lineEnd: rec.lineEnd },
        chunks: buildAxonEmbeddingChunksFor(rec),
      });
    } catch (e) {
      res.status(500).json({ error: errMsg(e) });
    }
  });
}
