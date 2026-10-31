/**
 * MCP tools listWorkflows / getWorkflow: the same workflows (and the same
 * access rules) as the `workflow://` resources, as tools, because Claude Code
 * does not read MCP resources by itself. Workflows live on the server; the
 * plugin skills only point here.
 */

import type { Workflow, WorkflowManager, WorkflowScope } from './workflowManager.js';
import type { WorkflowAcl, WorkflowUser } from './workflowAccess.js';

const SCOPE_ORDER: Record<WorkflowScope, number> = { project: 0, instance: 1, personal: 2, global: 3 };
const SCOPES: WorkflowScope[] = ['global', 'instance', 'project', 'personal'];
const DEFAULT_MAX_CHARS = 60_000;

export interface WorkflowToolDeps {
  manager: WorkflowManager;
  acl: WorkflowAcl;
  /** projectId → instanceId, to show and filter instance workflows. */
  projectInstance?: (projectId: string) => string | null;
}

export interface WorkflowListItem {
  name: string;
  title: string;
  scope: WorkflowScope;
  projectId?: string;
  instanceId?: string;
  owner?: string;
  description: string;
  uri: string;
}

function shortText(s: string, max = 160): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 3).replace(/\s+\S*$/, '') + '...' : t;
}

function toItem(w: Workflow): WorkflowListItem {
  const item: WorkflowListItem = {
    name: w.metadata.id, title: w.metadata.title, scope: w.scope,
    description: shortText(w.metadata.description || ''), uri: w.uri,
  };
  if (w.scope === 'project') item.projectId = w.scopeId;
  if (w.scope === 'instance') item.instanceId = w.scopeId;
  if (w.scope === 'personal') item.owner = w.scopeId;
  return item;
}

function sortWorkflows(a: Workflow, b: Workflow): number {
  return SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || a.metadata.title.localeCompare(b.metadata.title);
}

export function listWorkflowsForUser(
  deps: WorkflowToolDeps,
  user: WorkflowUser,
  args: { scope?: string; projectId?: string | number; query?: string } = {},
): { count: number; workflows: WorkflowListItem[]; hint: string } {
  const scope = args.scope && (SCOPES as string[]).includes(args.scope) ? (args.scope as WorkflowScope) : undefined;
  if (args.scope && !scope) throw new Error(`Unknown scope "${args.scope}". Use one of: ${SCOPES.join(', ')}.`);
  const pid = args.projectId !== undefined && args.projectId !== null && String(args.projectId) !== '' ? String(args.projectId) : '';
  const inst = pid && deps.projectInstance ? deps.projectInstance(pid) : null;
  const words = (args.query || '').toLowerCase().split(/\s+/).filter(Boolean);

  const list = deps.manager.getWorkflowList()
    .filter(w => deps.acl.canView(user, w))
    .filter(w => !scope || w.scope === scope)
    // projectId: that project's workflows, its instance's, plus global and personal
    .filter(w => !pid
      || (w.scope === 'project' && w.scopeId === pid)
      || (w.scope === 'instance' && inst !== null && w.scopeId === inst)
      || w.scope === 'global' || w.scope === 'personal')
    .filter(w => {
      if (!words.length) return true;
      const hay = `${w.metadata.id} ${w.metadata.title} ${w.metadata.description}`.toLowerCase();
      return words.every(t => hay.includes(t));
    })
    .sort(sortWorkflows);

  return {
    count: list.length,
    workflows: list.map(toItem),
    hint: 'Call getWorkflow({name}) with a name from this list. Workflows live on the MCP server; never read local workflow files.',
  };
}

/**
 * Resolve a name the way ReadResource does (`workflow://<id>` or the id),
 * plus a bare slug: global first, else project → instance → personal.
 */
export function resolveWorkflow(deps: WorkflowToolDeps, user: WorkflowUser, name: string): { wf?: Workflow; others: string[] } {
  const raw = String(name || '').trim();
  const id = raw.startsWith('workflow://') ? raw.slice('workflow://'.length) : raw.replace(/\.md$/, '');
  const exact = deps.manager.getWorkflow(id);
  if (id.includes('/')) return exact && deps.acl.canView(user, exact) ? { wf: exact, others: [] } : { others: [] };
  // bare slug: the global id wins (same as workflow://<slug>), else the first
  // visible scoped variant; other visible variants are named.
  const hits = deps.manager.getWorkflowList()
    .filter(w => w.slug === id && deps.acl.canView(user, w))
    .sort(sortWorkflows);
  const wf = exact && deps.acl.canView(user, exact) ? exact : hits[0];
  return { wf, others: hits.filter(w => w !== wf).map(w => w.metadata.id) };
}

export interface WorkflowSection { heading: string; slug: string; level: number }

export function headingSlug(s: string): string {
  return s.toLowerCase().replace(/[`*_]/g, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-');
}

/** Headings outside ``` fences, with their line index. */
function headings(text: string): Array<WorkflowSection & { line: number }> {
  const out: Array<WorkflowSection & { line: number }> = [];
  let fence = false;
  text.split('\n').forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; return; }
    if (fence) return;
    const m = l.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) out.push({ heading: m[2].trim(), slug: headingSlug(m[2]), level: m[1].length, line: i });
  });
  return out;
}

/** One section (heading line up to the next heading of the same or higher level). */
export function pickSection(text: string, section: string): { text: string; heading: string } | null {
  const hs = headings(text);
  const want = section.trim().replace(/^#+\s*/, '');
  const wantLc = want.toLowerCase();
  const wantSlug = headingSlug(want);
  const h = hs.find(x => x.heading.toLowerCase() === wantLc)
    || hs.find(x => x.slug === wantSlug)
    || hs.find(x => x.heading.toLowerCase().includes(wantLc));
  if (!h) return null;
  const lines = text.split('\n');
  const next = hs.find(x => x.line > h.line && x.level <= h.level);
  return { text: lines.slice(h.line, next ? next.line : lines.length).join('\n').trimEnd(), heading: h.heading };
}

export type GetWorkflowResult =
  | { ok: true; name: string; title: string; scope: WorkflowScope; uri: string; section?: string;
      sections: WorkflowSection[]; truncated: boolean; totalChars: number; otherMatches?: string[]; content: string }
  | { ok: false; error: string };

export function getWorkflowForUser(
  deps: WorkflowToolDeps,
  user: WorkflowUser,
  args: { name?: string; section?: string; maxChars?: number },
): GetWorkflowResult {
  if (!args.name || !String(args.name).trim()) return { ok: false, error: 'name is required (see listWorkflows).' };
  const { wf, others } = resolveWorkflow(deps, user, String(args.name));
  if (!wf) {
    return { ok: false, error: `Workflow "${args.name}" not found or not visible to user "${user.username}". Call listWorkflows to see the workflows you may read. Do not read local workflow files.` };
  }
  const full = wf.fullContent;
  const sections = headings(full).map(({ heading, slug, level }) => ({ heading, slug, level }));
  let body = full;
  let sectionName: string | undefined;
  if (args.section) {
    const s = pickSection(full, String(args.section));
    if (!s) return { ok: false, error: `Section "${args.section}" not found in workflow "${wf.metadata.id}". Sections: ${sections.map(x => x.heading).join(' | ')}` };
    body = s.text;
    sectionName = s.heading;
  }
  const max = Number.isFinite(args.maxChars) && (args.maxChars as number) > 0 ? Math.floor(args.maxChars as number) : DEFAULT_MAX_CHARS;
  const truncated = body.length > max;
  const result: GetWorkflowResult = {
    ok: true, name: wf.metadata.id, title: wf.metadata.title, scope: wf.scope, uri: wf.uri,
    sections, truncated, totalChars: body.length,
    content: truncated ? body.slice(0, max) + '\n\n[... truncated: call getWorkflow again with section=<heading> or a larger maxChars]' : body,
  };
  if (sectionName) result.section = sectionName;
  if (others.length) result.otherMatches = others;
  return result;
}

export const WORKFLOW_TOOL_NOTE = 'Workflows live on the MCP server; never read local workflow files.';

export const WORKFLOW_TOOL_DEFS = [
  {
    name: 'listWorkflows',
    description: 'List the workflows (step-by-step guides) you may read: global, instance, project and your personal ones. ' +
      'Returns name, title, scope, project/instance, short description and uri. Then call getWorkflow({name}). ' + WORKFLOW_TOOL_NOTE,
    category: 'retrieve',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['global', 'instance', 'project', 'personal'], description: 'Only this scope' },
        projectId: { type: 'string', description: 'Only workflows that apply to this project (its own, its instance\'s, global, personal)' },
        query: { type: 'string', description: 'Words that must all appear in name, title or description' },
      },
    },
  },
  {
    name: 'getWorkflow',
    description: 'Read one workflow as Markdown, or one section of it. Returns content, the section headings and a truncated flag. ' +
      'name = a name from listWorkflows, a bare slug (e.g. "create-pod") or a workflow:// uri. ' + WORKFLOW_TOOL_NOTE,
    category: 'retrieve',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workflow name, slug or workflow:// uri' },
        section: { type: 'string', description: 'Heading text or heading slug: return only that section' },
        maxChars: { type: 'number', description: `Max characters of content (default ${DEFAULT_MAX_CHARS})` },
      },
      required: ['name'],
    },
  },
];
