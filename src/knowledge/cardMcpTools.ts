/**
 * MCP tools `getKnowledgeCard` and `listKnowledgeCards` (GKC-02 / GKC-03).
 * Read-only: no model call, no build. Registered from src/index.ts with one
 * line in the tool list and one case in the call handler.
 */
import { lookupCard, formatLookup, listCardSummaries, liveLookupDeps, type LookupDeps, type CardReadStatus } from './cardLookup.js';

const PROJECT_DOC = 'Project id (see listProjects). Defaults to the primary project.';

export const KNOWLEDGE_CARD_TOOL_DEFS = [
  {
    name: 'getKnowledgeCard',
    description:
      'Short, checked summary of one symbol (class, method, pod, project) from the knowledge cards: what it does, ' +
      'where it lives, its callers and callees from the code graph, and claims with file:line. Use it before editing a ' +
      'symbol you have not read. Stale, flagged or low-confidence cards are never shown as fact; the reply says which. ' +
      'Each card lists the sha256 every source file had when it was built (compare with `shasum -a 256 <file>`). ' +
      'No card yet: use getFantomFunction / getFantomType / searchFantomCode.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Qualified name ("hxConn::ConnTuning", "ConnTuning.pollTime") or a plain name.' },
        file: { type: 'string', description: 'Instead of symbol: a file path (or its end); returns the card of its main type.' },
        projectId: { type: 'number', description: PROJECT_DOC },
        neighbours: { type: 'string', enum: ['none', 'callers', 'callees', 'both'], description: 'Graph neighbours to add (default both).' },
        maxNeighbours: { type: 'number', description: 'Default 5, max 20.' },
      },
    },
  },
  {
    name: 'listKnowledgeCards',
    description:
      'List the knowledge cards of a project (optionally one file or kind): name, kind, status (fresh / stale / ' +
      'flagged / low-confidence), confidence and a one-line summary. Shows what is covered before calling getKnowledgeCard.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: PROJECT_DOC },
        file: { type: 'string', description: 'Only cards whose file path ends with this.' },
        kind: { type: 'string', enum: ['project', 'pod', 'class', 'function'] },
        status: { type: 'string', enum: ['fresh', 'stale', 'flagged', 'low-confidence'] },
        limit: { type: 'number', description: 'Default 50, max 200.' },
        offset: { type: 'number' },
      },
    },
  },
];

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

async function defaultProjectId(): Promise<number | null> {
  try {
    const { getPrismaClient } = await import('../db/prisma.js');
    const { resolveProjectId } = await import('../utils/dbBootstrap.js');
    const id = await resolveProjectId(getPrismaClient() as never, {});
    return typeof id === 'number' ? id : null;
  } catch { return null; }
}

export async function handleKnowledgeCardTool(
  name: string, args: Record<string, unknown> = {}, deps?: LookupDeps, pidFallback: () => Promise<number | null> = defaultProjectId,
): Promise<ToolResult> {
  const d = deps ?? await liveLookupDeps();
  const projectId = typeof args.projectId === 'number' ? args.projectId : await pidFallback();
  if (!projectId) return { content: [{ type: 'text', text: 'projectId is required (no primary project set).' }], isError: true };
  try {
    if (name === 'getKnowledgeCard') {
      const symbol = typeof args.symbol === 'string' ? args.symbol : undefined;
      const file = typeof args.file === 'string' ? args.file : undefined;
      if (!symbol && !file) return { content: [{ type: 'text', text: 'Give symbol or file.' }], isError: true };
      const neighbours = (['none', 'callers', 'callees', 'both'] as const).find(n => n === args.neighbours) ?? 'both';
      const r = await lookupCard(d, { projectId, symbol, file, neighbours, maxNeighbours: typeof args.maxNeighbours === 'number' ? args.maxNeighbours : 5 });
      return { content: [{ type: 'text', text: formatLookup(r, symbol ?? file ?? '') }] };
    }
    if (name === 'listKnowledgeCards') {
      const status = (['fresh', 'stale', 'flagged', 'low-confidence'] as const).find(s => s === args.status) as CardReadStatus | undefined;
      const out = await listCardSummaries(d, {
        projectId, status,
        file: typeof args.file === 'string' ? args.file : undefined,
        kind: typeof args.kind === 'string' ? args.kind : undefined,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
        offset: typeof args.offset === 'number' ? args.offset : undefined,
      });
      if (out.total === 0) return { content: [{ type: 'text', text: `No knowledge cards match in project ${projectId}.` }] };
      const s = out.byStatus;
      const head = `${out.total} card(s) in project ${projectId} · fresh ${s.fresh} · stale ${s.stale} · flagged ${s.flagged} · low ${s['low-confidence']}`;
      const lines = out.rows.map(r => `- ${r.qualifiedName} (${r.kind}, ${r.readStatus}, ${r.confidence.toFixed(2)})${r.summary ? `: ${r.summary}` : ''}`);
      return { content: [{ type: 'text', text: [head, ...lines].join('\n') }] };
    }
    return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
  } catch (err) {
    return { content: [{ type: 'text', text: `Knowledge cards unavailable: ${(err as Error).message}` }], isError: true };
  }
}
