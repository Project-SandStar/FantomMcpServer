/**
 * Admin routes for workflows (markdown files, scoped; see src/workflows/).
 *
 *   GET    /admin/workflows?scope=&scopeId=        list the workflows this user may view
 *   GET    /admin/workflows/item?id=               one workflow with full markdown
 *   PUT    /admin/workflows/item?id= {content, expectedMtimeMs}   save (409 when stale)
 *   POST   /admin/workflows {scope, scopeId, slug, content}       create
 *   DELETE /admin/workflows/item?id=               delete (moved to .trash)
 *   POST   /admin/workflows/copy {id, scope, scopeId, slug?}      copy (e.g. built-in → project)
 *   GET    /admin/workflows/history?id=            change log (who, when, what)
 *   POST   /admin/workflows/optimize {id, content?, instructions?}  LLM proposal, never saved
 *   GET    /admin/workflows/members/:projectId     project members
 *   PUT    /admin/workflows/members/:projectId {username, role}   admin only
 *   DELETE /admin/workflows/members/:projectId/:username          admin only
 *
 * Old routes `/admin/workflows/:id` (global slug) still work.
 * Ids with a scope contain '/', so they go in the `id` query parameter.
 * All checks go through WorkflowAcl.canView / canEdit / canCreate.
 */

import type { Router, Request, Response, RequestHandler } from 'express';
import type { WorkflowManager, Workflow, WorkflowScope } from '../workflows/workflowManager.js';
import { isValidWorkflowId, parseWorkflowId, makeWorkflowId, WorkflowConflictError } from '../workflows/workflowManager.js';
import type { WorkflowAcl, WorkflowUser, MemberRole } from '../workflows/workflowAccess.js';
import { openRouterChat, OpenRouterChatUnavailable } from '../sidecars/openRouterChat.js';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

const SCOPES: WorkflowScope[] = ['global', 'instance', 'project', 'personal'];

const OPTIMIZE_SYSTEM = `You improve MCP workflow documents. A workflow is a markdown file that an AI coding
assistant reads as a step-by-step guide for Fantom / Haxall / SkySpark work.

Rewrite the document so an AI assistant can follow it better:
- keep the first "# Title" heading and the first paragraph as a one-paragraph summary
  (they become the resource name and description);
- clear numbered steps, exact commands, file paths and API names;
- cut repetition and filler; keep every technical fact, command and code block that is correct;
- do not invent APIs, flags or file paths.

Return ONLY the full rewritten markdown. No preamble, no code fence around the whole document.`;

/** The logged-in user (Basic auth / session), or the API-token caller as admin. */
export function workflowUserOf(req: Request, res: Response): WorkflowUser | null {
  const u = (req as any).user as { username?: string; role?: string } | undefined;
  if (u?.username) return { username: u.username, role: u.role === 'admin' ? 'admin' : 'user' };
  if (res.locals.apiTokenOk) return { username: 'api-token', role: 'admin' };
  return null;
}

export function registerWorkflowRoutes(
  router: Router,
  getManager: () => WorkflowManager | undefined,
  requireAdmin: RequestHandler,
  getAcl: () => WorkflowAcl | undefined = () => undefined,
): void {
  const ctx = (req: Request, res: Response): { wm: WorkflowManager; acl: WorkflowAcl; user: WorkflowUser } | null => {
    const wm = getManager();
    const acl = getAcl();
    if (!wm || !acl) { res.status(503).json({ error: 'Workflow manager not available' }); return null; }
    const user = workflowUserOf(req, res);
    if (!user) { res.status(401).json({ error: 'Authentication required' }); return null; }
    return { wm, acl, user };
  };

  const item = (w: Workflow, acl: WorkflowAcl, user: WorkflowUser) => ({
    id: w.metadata.id,
    uri: w.uri,
    title: w.metadata.title,
    description: w.metadata.description,
    scope: w.scope,
    scopeId: w.scopeId,
    slug: w.slug,
    builtin: w.builtin,
    owner: acl.getOwner(w.metadata.id) ?? (w.scope === 'personal' ? w.scopeId : w.builtin ? 'built-in' : ''),
    canEdit: acl.canEdit(user, w),
    mtimeMs: w.mtimeMs,
    sizeBytes: w.sizeBytes,
    lines: w.fullContent.split('\n').length,
  });

  const idOf = (req: Request): string => String(req.query.id ?? req.params.id ?? '');

  router.get('/workflows', (req: Request, res: Response): void => {
    const c = ctx(req, res);
    if (!c) return;
    const scope = typeof req.query.scope === 'string' ? req.query.scope : '';
    const scopeId = typeof req.query.scopeId === 'string' ? req.query.scopeId : '';
    const lastEdit = new Map<string, { user: string; at: string }>();
    for (const e of c.wm.getHistory(undefined, 5000)) if (!lastEdit.has(e.id)) lastEdit.set(e.id, { user: e.user, at: e.at });
    const workflows = c.wm.getWorkflowList()
      .filter(w => c.acl.canView(c.user, w))
      .filter(w => !scope || w.scope === scope)
      .filter(w => !scopeId || w.scopeId === scopeId)
      .map(w => ({ ...item(w, c.acl, c.user), lastEdit: lastEdit.get(w.metadata.id) ?? null }))
      .sort((a, b) => a.title.localeCompare(b.title));
    res.json({
      count: workflows.length,
      workflows,
      dir: c.wm.getDir(),
      dirExists: c.wm.dirExists(),
      user: c.user,
      myProjects: c.user.role === 'admin' ? null : c.acl.projectsOf(c.user),
    });
  });

  router.get('/workflows/history', (req: Request, res: Response): void => {
    const c = ctx(req, res);
    if (!c) return;
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    if (id) {
      const w = c.wm.getWorkflow(id);
      const p = parseWorkflowId(id);
      // A deleted file has no Workflow; check the scope from the id.
      if (!p || !c.acl.canView(c.user, w ?? p)) { res.status(404).json({ error: 'Workflow not found' }); return; }
      res.json({ entries: c.wm.getHistory(id) });
      return;
    }
    const entries = c.wm.getHistory(undefined, 500).filter(e => { const p = parseWorkflowId(e.id); return p && c.acl.canView(c.user, p); });
    res.json({ entries });
  });

  router.get('/workflows/members/:projectId', (req: Request, res: Response): void => {
    const c = ctx(req, res);
    if (!c) return;
    const pid = String(req.params.projectId);
    if (c.user.role !== 'admin' && !c.acl.projectRole(c.user, pid)) { res.status(403).json({ error: 'Not a member of this project' }); return; }
    res.json({ projectId: pid, members: c.acl.getMembers(pid) });
  });

  router.put('/workflows/members/:projectId', requireAdmin, (req: Request, res: Response): void => {
    const c = ctx(req, res);
    if (!c) return;
    const pid = String(req.params.projectId);
    const username = String(req.body?.username ?? '').trim();
    const role = req.body?.role as MemberRole;
    if (!/^\d+$/.test(pid) || !username || (role !== 'viewer' && role !== 'editor')) {
      res.status(400).json({ error: 'Need a numeric projectId, a username and role viewer|editor' });
      return;
    }
    c.acl.setMember(pid, username, role);
    c.wm.recordChange({ at: new Date().toISOString(), user: c.user.username, action: 'members', id: `project/${pid}/-`, detail: { username, role } });
    res.json({ projectId: pid, members: c.acl.getMembers(pid) });
  });

  router.delete('/workflows/members/:projectId/:username', requireAdmin, (req: Request, res: Response): void => {
    const c = ctx(req, res);
    if (!c) return;
    const pid = String(req.params.projectId);
    const username = String(req.params.username);
    if (!c.acl.removeMember(pid, username)) { res.status(404).json({ error: 'Not a member' }); return; }
    c.wm.recordChange({ at: new Date().toISOString(), user: c.user.username, action: 'members', id: `project/${pid}/-`, detail: { username, removed: true } });
    res.json({ projectId: pid, members: c.acl.getMembers(pid) });
  });

  const getOne = (req: Request, res: Response): void => {
    const c = ctx(req, res);
    if (!c) return;
    const w = c.wm.getWorkflow(idOf(req));
    if (!w || !c.acl.canView(c.user, w)) { res.status(404).json({ error: 'Workflow not found' }); return; }
    res.json({ workflow: item(w, c.acl, c.user), fullContent: w.fullContent });
  };

  const putOne = (req: Request, res: Response): void => {
    const c = ctx(req, res);
    if (!c) return;
    const id = idOf(req);
    const w = c.wm.getWorkflow(id);
    if (!w || !c.acl.canView(c.user, w)) { res.status(404).json({ error: 'Workflow not found' }); return; }
    if (!c.acl.canEdit(c.user, w)) { res.status(403).json({ error: 'You may not edit this workflow' }); return; }
    const content = req.body?.content;
    if (typeof content !== 'string' || !content.trim()) { res.status(400).json({ error: 'Missing or empty "content" in body' }); return; }
    const expected = typeof req.body?.expectedMtimeMs === 'number' ? req.body.expectedMtimeMs : undefined;
    try {
      const saved = c.wm.saveWorkflow(id, content, true, { user: c.user.username, expectedMtimeMs: expected });
      res.json({ workflow: item(saved, c.acl, c.user), fullContent: saved.fullContent });
    } catch (e) {
      if (e instanceof WorkflowConflictError) { res.status(409).json({ error: errMsg(e) }); return; }
      res.status(500).json({ error: 'Failed to save workflow', details: errMsg(e) });
    }
  };

  const deleteOne = (req: Request, res: Response): void => {
    const c = ctx(req, res);
    if (!c) return;
    const id = idOf(req);
    const w = c.wm.getWorkflow(id);
    if (!w || !c.acl.canView(c.user, w)) { res.status(404).json({ error: 'Workflow not found' }); return; }
    if (!c.acl.canEdit(c.user, w)) { res.status(403).json({ error: 'You may not delete this workflow' }); return; }
    try {
      c.wm.deleteWorkflow(id, c.user.username);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to delete workflow', details: errMsg(e) });
    }
  };

  const create = (req: Request, res: Response, content: string, scope: WorkflowScope, scopeId: string, slug: string, action: 'create' | 'copy'): void => {
    const c = ctx(req, res);
    if (!c) return;
    if (!SCOPES.includes(scope)) { res.status(400).json({ error: `scope must be one of ${SCOPES.join(', ')}` }); return; }
    if (scope === 'personal' && !scopeId) scopeId = c.user.username;
    const id = makeWorkflowId(scope, scope === 'global' ? '' : scopeId, slug);
    if (!isValidWorkflowId(slug) || !parseWorkflowId(id)) { res.status(400).json({ error: 'Invalid id: letters, digits, - and _ only (max 80); project/instance ids are numbers' }); return; }
    if (!c.acl.canCreate(c.user, scope, scopeId)) { res.status(403).json({ error: 'You may not create workflows here' }); return; }
    if (typeof content !== 'string' || !content.trim()) { res.status(400).json({ error: 'Missing or empty "content" in body' }); return; }
    if (c.wm.hasWorkflow(id)) { res.status(409).json({ error: `Workflow "${id}" already exists` }); return; }
    try {
      const w = c.wm.saveWorkflow(id, content, false, { user: c.user.username, action });
      c.acl.setOwner(id, c.user.username);
      res.status(201).json({ workflow: item(w, c.acl, c.user), fullContent: w.fullContent });
    } catch (e) {
      res.status(500).json({ error: 'Failed to create workflow', details: errMsg(e) });
    }
  };

  router.get('/workflows/item', getOne);
  router.put('/workflows/item', putOne);
  router.delete('/workflows/item', deleteOne);

  router.post('/workflows', (req: Request, res: Response): void => {
    const b = req.body ?? {};
    // Old body {id, content} = global.
    const scope = (b.scope ?? 'global') as WorkflowScope;
    create(req, res, b.content, scope, String(b.scopeId ?? ''), String(b.slug ?? b.id ?? '').trim(), 'create');
  });

  router.post('/workflows/copy', (req: Request, res: Response): void => {
    const c = ctx(req, res);
    if (!c) return;
    const src = c.wm.getWorkflow(String(req.body?.id ?? ''));
    if (!src || !c.acl.canView(c.user, src)) { res.status(404).json({ error: 'Workflow not found' }); return; }
    create(req, res, src.fullContent, req.body?.scope as WorkflowScope, String(req.body?.scopeId ?? ''), String(req.body?.slug ?? src.slug), 'copy');
  });

  const optimize = async (req: Request, res: Response): Promise<void> => {
    const c = ctx(req, res);
    if (!c) return;
    const w = c.wm.getWorkflow(String(req.params.id ?? req.body?.id ?? req.query.id ?? ''));
    if (!w || !c.acl.canView(c.user, w)) { res.status(404).json({ error: 'Workflow not found' }); return; }
    if (!c.acl.canEdit(c.user, w)) { res.status(403).json({ error: 'You may not edit this workflow' }); return; }
    const content = typeof req.body?.content === 'string' && req.body.content.trim() ? req.body.content as string : w.fullContent;
    const instructions = typeof req.body?.instructions === 'string' ? req.body.instructions.trim() : '';
    const user = (instructions ? `Extra instructions from the editor: ${instructions}\n\n` : '')
      + `Workflow id: ${w.metadata.id}\n\n---- DOCUMENT START ----\n${content}\n---- DOCUMENT END ----`;
    try {
      const r = await openRouterChat(OPTIMIZE_SYSTEM, user, { maxTokens: 16000, timeoutMs: 180_000, temperature: 0.2 });
      const text = r.text.trim().replace(/^```(?:markdown|md)?\s*\n([\s\S]*)\n```$/, '$1');
      res.json({ proposed: text, model: r.model, costUsd: r.costUsd });
    } catch (e) {
      const unavailable = e instanceof OpenRouterChatUnavailable;
      res.status(unavailable ? 503 : 500).json({ error: unavailable ? 'No LLM route available for optimize' : 'Optimize failed', details: errMsg(e) });
    }
  };
  router.post('/workflows/optimize', optimize);

  // Old routes (global slug in the path).
  router.get('/workflows/:id', getOne);
  router.put('/workflows/:id', putOne);
  router.delete('/workflows/:id', deleteOne);
  router.post('/workflows/:id/optimize', optimize);
}
