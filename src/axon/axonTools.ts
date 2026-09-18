/**
 * Fantom MCP tools that surface the Axon integration:
 *   axonSearch   — semantic search over the locally embedded Axon functions
 *                  (falls back to the Axon server's own semanticCodeSearch when
 *                  axon_vectors is empty or has no provider for the query).
 *   axonFunction — function detail from the parsed proj tree + callers /
 *                  usage from the Axon MCP server when connected.
 *
 * Registered from src/index.ts via AXON_TOOL_DEFINITIONS (tool lists) and
 * handleAxonTool (CallTool switch) so the additions there stay one line each.
 */

import { axonSearch, type AxonSearchMode } from './axonSearch.js';
import { findAxonFunction } from './axonIndexer.js';
import { getAxonMcpClient } from './axonMcpClient.js';
import { getAxonSettings } from './axonSettings.js';

export const AXON_TOOL_NAMES = ['axonSearch', 'axonFunction'] as const;
export type AxonToolName = typeof AXON_TOOL_NAMES[number];

export interface AxonToolDefinition {
  name: AxonToolName;
  description: string;
  category: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] };
}

export const AXON_TOOL_DEFINITIONS: AxonToolDefinition[] = [
  {
    name: 'axonSearch',
    description:
      'Semantic search over the customer SkySpark/Axon functions synced by the Axon MCP server ' +
      '(proj/<instance>/<project>/func). Uses the same code embedding model as Fantom code search. ' +
      'Modes: vector (default), rerank (cross-encoder), rlm (drafted answer with citations). ' +
      'Falls back to the Axon server\'s own semanticCodeSearch when no local vectors exist.',
    category: 'search',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language or concept query' },
        projectId: { type: 'string', description: 'Axon project id "<instance>/<project>" or "library/<folder>" (optional)' },
        source: { type: 'string', enum: ['proj', 'library', 'all'], description: 'proj = synced SkySpark projects, library = offline Axon library, all (default)' },
        mode: { type: 'string', enum: ['vector', 'rerank', 'rlm'], description: 'Search mode (default vector)' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'axonFunction',
    description:
      'Detail for one Axon function by name: signature, parameters, doc, tags, source, callees, ' +
      'in-project callers, and (when the Axon MCP server is connected) callers/usage from its call graph.',
    category: 'search',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact Axon function name' },
        projectId: { type: 'string', description: 'Axon project id "<instance>/<project>" to disambiguate (optional)' },
        includeSource: { type: 'boolean', description: 'Include the full source (default true)' },
      },
      required: ['name'],
    },
  },
];

export function isAxonTool(name: string): name is AxonToolName {
  return (AXON_TOOL_NAMES as readonly string[]).includes(name);
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

export async function handleAxonTool(name: AxonToolName, args: Record<string, unknown>): Promise<ToolResult> {
  if (name === 'axonSearch') return handleAxonSearch(args);
  return handleAxonFunction(args);
}

async function handleAxonSearch(args: Record<string, unknown>): Promise<ToolResult> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return text('axonSearch: "query" is required', true);
  const projectId = typeof args.projectId === 'string' ? args.projectId : undefined;
  const mode = (['vector', 'rerank', 'rlm'] as const).includes(args.mode as AxonSearchMode) ? (args.mode as AxonSearchMode) : 'vector';
  const limit = typeof args.limit === 'number' ? args.limit : 10;
  const source = args.source === 'proj' || args.source === 'library' ? args.source : 'all';

  let local: Awaited<ReturnType<typeof axonSearch>> | null = null;
  let localError: string | null = null;
  try {
    local = await axonSearch(query, { projectId, source, mode, limit });
  } catch (e) {
    localError = (e as Error).message;
  }

  if (local && local.results.length > 0) {
    const lines: string[] = [`Found ${local.count} Axon functions (mode ${local.mode}, model ${local.model}${local.degraded ? `, degraded: ${local.degraded}` : ''}):\n`];
    if (local.answer) {
      lines.push('## Answer', local.answer, '');
      if (local.citations?.length) {
        lines.push('Sources:');
        local.citations.forEach((c, i) => lines.push(`  [${i + 1}] ${c.qualifiedName} — ${c.filePath}:${c.lineStart}`));
        lines.push('');
      }
    }
    for (const r of local.results) {
      lines.push(`## ${r.qualifiedName} [${r.source}]`);
      lines.push(`   Score: ${(r.combinedScore * 100).toFixed(1)}%${r.rerankScore !== undefined ? ` (rerank ${r.rerankScore.toFixed(3)})` : ''}`);
      lines.push(`   Signature: ${r.signature || '(none)'}`);
      lines.push(`   File: ${r.filePath}:${r.lineStart}`);
      if (r.tags?.length) lines.push(`   Tags: ${r.tags.join(', ')}`);
      if (r.documentation) lines.push(`   Doc: ${r.documentation.slice(0, 200).replace(/\n/g, ' ')}`);
      lines.push('');
    }
    return text(lines.join('\n'));
  }

  // Fallback: the Axon server's own semantic search (its primary project only).
  const settings = getAxonSettings();
  if (!settings.enabled) {
    return text(
      `No local Axon vectors matched${localError ? ` (${localError})` : ''} and the Axon MCP client is disabled. ` +
      'Enable it under Dashboard → Axon, then run "Embed all".',
      true,
    );
  }
  try {
    const out = await getAxonMcpClient().callTool('semanticCodeSearch', { query, limit });
    const note = local?.degraded === 'empty-table'
      ? 'axon_vectors is empty — showing the Axon server\'s semanticCodeSearch (primary project only). Run an Axon index for cross-project search.\n\n'
      : `Local search unavailable (${localError ?? 'no results'}); Axon server semanticCodeSearch:\n\n`;
    return text(note + out.text, out.isError);
  } catch (e) {
    return text(`axonSearch failed: local ${localError ?? 'no results'}; Axon server: ${(e as Error).message}`, true);
  }
}

async function handleAxonFunction(args: Record<string, unknown>): Promise<ToolResult> {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) return text('axonFunction: "name" is required', true);
  const projectId = typeof args.projectId === 'string' ? args.projectId : undefined;
  const includeSource = args.includeSource !== false;

  const hits = findAxonFunction(name, projectId);
  const lines: string[] = [];
  if (hits.length === 0) {
    lines.push(`No local Axon function named "${name}"${projectId ? ` in ${projectId}` : ''} (checked proj/ under ${getAxonSettings().projectPath}).`);
  } else {
    if (hits.length > 1 && !projectId) lines.push(`Found "${name}" in ${hits.length} projects: ${hits.map(h => h.projectId).join(', ')} — showing the first 3.\n`);
    for (const h of hits.slice(0, 3)) {
      lines.push(`## ${h.qualifiedName}`);
      lines.push(`   Signature: ${h.signature}`);
      if (h.paramDefs.length) lines.push(`   Params: ${h.paramDefs.map(p => p.name + (p.default !== undefined ? ` = ${p.default}` : '')).join(', ')}`);
      if (h.returnType) lines.push(`   Returns: ${h.returnType}`);
      lines.push(`   File: ${h.filePath}:${h.lineStart}-${h.lineEnd}`);
      if (h.tags.length) lines.push(`   Tags: ${h.tags.join(', ')}`);
      if (h.modified) lines.push(`   Modified: ${h.modified}`);
      if (h.doc) lines.push(`   Doc: ${h.doc.slice(0, 600)}`);
      if (h.calls.length) lines.push(`   Calls: ${h.calls.join(', ')}`);
      if (h.calledBy.length) lines.push(`   Called by (same project): ${h.calledBy.join(', ')}`);
      if (includeSource) lines.push('', '```axon', h.body.slice(0, 6000), '```');
      lines.push('');
    }
  }

  // Enrich from the Axon server's graph when connected/enabled.
  if (getAxonSettings().enabled) {
    const client = getAxonMcpClient();
    // getCallers advertises {functionName} but the deployed Axon build's graph
    // handler answers "Either nodeId or qualifiedName is required" — so fall
    // back to findFunctionUsage (textual call sites) whenever it errors.
    let callersOk = false;
    try {
      const callers = await client.callTool('getCallers', { functionName: name, limit: 20 }, 30_000);
      if (callers.text && !callers.isError) {
        lines.push('## Callers (Axon server call graph)', callers.text.slice(0, 3000), '');
        callersOk = true;
      }
    } catch { /* fall through to usage */ }
    if (!callersOk) {
      try {
        const usage = await client.callTool('findFunctionUsage', { functionName: name, limit: 10, includeContext: true }, 30_000);
        if (usage.text) lines.push('## Call sites (Axon server findFunctionUsage)', usage.text.slice(0, 3000));
      } catch (e) {
        lines.push(`(Axon server call-graph lookup unavailable: ${(e as Error).message})`);
      }
    }
  }
  return text(lines.join('\n'), hits.length === 0 && lines.length <= 1);
}
