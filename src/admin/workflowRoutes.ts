/**
 * Admin routes for the MCP workflow resources (`workflows/*.md`, served as
 * `workflow://<id>`). Mounted from createAdminRouter with a single call so
 * src/admin/routes.ts stays untouched otherwise.
 *
 *   GET    /admin/workflows                 list (metadata, no body)
 *   GET    /admin/workflows/:id             one workflow with full markdown
 *   PUT    /admin/workflows/:id {content}   save an existing workflow
 *   POST   /admin/workflows {id, content}   create a new workflow
 *   DELETE /admin/workflows/:id             delete a workflow file
 *   POST   /admin/workflows/:id/optimize {content?, instructions?}
 *          LLM rewrite proposal; never saved — the dashboard shows it and
 *          the user decides
 *
 * Every write goes through WorkflowManager.saveWorkflow, which reloads and
 * fires the change listeners, so MCP clients get `resources/list_changed`.
 */

import type { Router, Request, Response, RequestHandler } from 'express';
import type { WorkflowManager, Workflow } from '../workflows/workflowManager.js';
import { isValidWorkflowId } from '../workflows/workflowManager.js';
import { openRouterChat, OpenRouterChatUnavailable } from '../sidecars/openRouterChat.js';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

function toListItem(w: Workflow) {
  return {
    id: w.metadata.id,
    uri: w.uri,
    title: w.metadata.title,
    description: w.metadata.description,
    mtimeMs: w.mtimeMs,
    sizeBytes: w.sizeBytes,
    lines: w.fullContent.split('\n').length,
  };
}

const OPTIMIZE_SYSTEM = `You improve MCP workflow documents. A workflow is a markdown file that an AI coding
assistant reads as a step-by-step guide for Fantom / Haxall / SkySpark work.

Rewrite the document so an AI assistant can follow it better:
- keep the first "# Title" heading and the first paragraph as a one-paragraph summary
  (they become the resource name and description);
- clear numbered steps, exact commands, file paths and API names;
- cut repetition and filler; keep every technical fact, command and code block that is correct;
- do not invent APIs, flags or file paths.

Return ONLY the full rewritten markdown. No preamble, no code fence around the whole document.`;

export function registerWorkflowRoutes(
  router: Router,
  getManager: () => WorkflowManager | undefined,
  requireAdmin: RequestHandler,
): void {
  const manager = (res: Response): WorkflowManager | undefined => {
    const wm = getManager();
    if (!wm) res.status(503).json({ error: 'Workflow manager not available' });
    return wm;
  };

  router.get('/workflows', (_req: Request, res: Response): void => {
    const wm = manager(res);
    if (!wm) return;
    const workflows = wm.getWorkflowList().map(toListItem).sort((a, b) => a.title.localeCompare(b.title));
    res.json({ count: workflows.length, workflows });
  });

  router.get('/workflows/:id', (req: Request, res: Response): void => {
    const wm = manager(res);
    if (!wm) return;
    const w = wm.getWorkflow(String(req.params.id));
    if (!w) { res.status(404).json({ error: 'Workflow not found' }); return; }
    res.json({ workflow: toListItem(w), fullContent: w.fullContent });
  });

  router.put('/workflows/:id', requireAdmin, (req: Request, res: Response): void => {
    const wm = manager(res);
    if (!wm) return;
    const content = req.body?.content;
    if (typeof content !== 'string' || !content.trim()) {
      res.status(400).json({ error: 'Missing or empty "content" in body' });
      return;
    }
    if (!wm.hasWorkflow(String(req.params.id))) { res.status(404).json({ error: 'Workflow not found' }); return; }
    try {
      const w = wm.saveWorkflow(String(req.params.id), content, true);
      res.json({ workflow: toListItem(w), fullContent: w.fullContent });
    } catch (e) {
      res.status(500).json({ error: 'Failed to save workflow', details: errMsg(e) });
    }
  });

  router.post('/workflows', requireAdmin, (req: Request, res: Response): void => {
    const wm = manager(res);
    if (!wm) return;
    const id = String(req.body?.id ?? '').trim();
    const content = req.body?.content;
    if (!isValidWorkflowId(id)) {
      res.status(400).json({ error: 'Invalid id: letters, digits, - and _ only (max 80)' });
      return;
    }
    if (typeof content !== 'string' || !content.trim()) {
      res.status(400).json({ error: 'Missing or empty "content" in body' });
      return;
    }
    if (wm.hasWorkflow(id)) { res.status(409).json({ error: `Workflow "${id}" already exists` }); return; }
    try {
      const w = wm.saveWorkflow(id, content, false);
      res.status(201).json({ workflow: toListItem(w), fullContent: w.fullContent });
    } catch (e) {
      res.status(500).json({ error: 'Failed to create workflow', details: errMsg(e) });
    }
  });

  router.delete('/workflows/:id', requireAdmin, (req: Request, res: Response): void => {
    const wm = manager(res);
    if (!wm) return;
    try {
      if (!wm.deleteWorkflow(String(req.params.id))) { res.status(404).json({ error: 'Workflow not found' }); return; }
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to delete workflow', details: errMsg(e) });
    }
  });

  router.post('/workflows/:id/optimize', requireAdmin, async (req: Request, res: Response): Promise<void> => {
    const wm = manager(res);
    if (!wm) return;
    const w = wm.getWorkflow(String(req.params.id));
    if (!w) { res.status(404).json({ error: 'Workflow not found' }); return; }
    // The editor may hold unsaved text; optimize that, not the file on disk.
    const content = typeof req.body?.content === 'string' && req.body.content.trim()
      ? req.body.content as string
      : w.fullContent;
    const instructions = typeof req.body?.instructions === 'string' ? req.body.instructions.trim() : '';
    const user = (instructions ? `Extra instructions from the editor: ${instructions}\n\n` : '')
      + `Workflow id: ${w.metadata.id}\n\n---- DOCUMENT START ----\n${content}\n---- DOCUMENT END ----`;
    try {
      const r = await openRouterChat(OPTIMIZE_SYSTEM, user, { maxTokens: 16000, timeoutMs: 180_000, temperature: 0.2 });
      // Models sometimes wrap the whole answer in a fence despite the prompt.
      const text = r.text.trim().replace(/^```(?:markdown|md)?\s*\n([\s\S]*)\n```$/, '$1');
      res.json({ proposed: text, model: r.model, costUsd: r.costUsd });
    } catch (e) {
      const unavailable = e instanceof OpenRouterChatUnavailable;
      res.status(unavailable ? 503 : 500).json({
        error: unavailable ? 'No LLM route available for optimize' : 'Optimize failed',
        details: errMsg(e),
      });
    }
  });
}
