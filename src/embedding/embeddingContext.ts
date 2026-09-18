/**
 * Graph context for the embedding text (EMBED_TEXT_VERSION 3).
 *
 * Produces, per node, one line
 *   `context: in <EnclosingClass>; calls: a, b, c; called by: x, y`
 * (≤5 names each, names only) from the per-project code graph. The whole
 * project is read with a handful of PAGED Cypher queries — one over `calls`
 * edges, one over nodes' `parent_type` — never one query per node, so the
 * pre-pass costs O(pages) round trips regardless of node count.
 *
 * Write sites run this once per project (or once per reindex batch) and hand
 * the Map to buildEmbeddingItems / buildCodeEmbeddingText via `context`.
 */
import { ladybugQuery } from '../graph/ladybugConnection.js';
import { createLogger } from '../utils/index.js';
import { EMBED_TEXT_V3 } from './embeddingText.js';

const logger = createLogger('embedding-context');

export const CONTEXT_MAX_NAMES = 5;
const PAGE = 5000;

export interface EmbeddingContextOptions {
  /** Restrict the edge scan to nodes in these files (either endpoint). Used by
   *  the incremental reindex so a 3-file edit doesn't walk a 100k-edge graph. */
  filePaths?: string[];
  /** Max names per list (default 5). */
  maxNames?: number;
}

function cypherList(values: string[]): string {
  return values.map((v) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(', ');
}

function pushName(list: string[], name: string | null | undefined, max: number): void {
  if (!name) return;
  const n = String(name).trim();
  if (!n || list.includes(n) || list.length >= max) return;
  list.push(n);
}

/** Format one context line; '' when there is nothing to say. */
export function formatContextLine(parts: { parent?: string | null; calls: string[]; calledBy: string[] }): string {
  const segs: string[] = [];
  if (parts.parent) segs.push(`in ${parts.parent}`);
  if (parts.calls.length) segs.push(`calls: ${parts.calls.join(', ')}`);
  if (parts.calledBy.length) segs.push(`called by: ${parts.calledBy.join(', ')}`);
  return segs.length ? `context: ${segs.join('; ')}` : '';
}

/**
 * Build nodeId → context line for `nodes` of `projectId`. Missing graph or a
 * failed query yields an empty Map (the text simply has no context line); the
 * embedding must never fail because the graph is unavailable.
 */
export async function buildEmbeddingContext(
  projectId: number,
  nodes: Array<{ id: string }>,
  opts: EmbeddingContextOptions = {},
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!EMBED_TEXT_V3 || nodes.length === 0) return out;
  const max = opts.maxNames ?? CONTEXT_MAX_NAMES;
  const wanted = new Set(nodes.map((n) => n.id));
  const parent = new Map<string, string>();
  const calls = new Map<string, string[]>();
  const calledBy = new Map<string, string[]>();
  const t0 = Date.now();
  let edgeRows = 0;
  let nodeRows = 0;

  const fileFilter = opts.filePaths && opts.filePaths.length > 0
    ? `(a.file_path IN [${cypherList(opts.filePaths)}] OR b.file_path IN [${cypherList(opts.filePaths)}])`
    : '';

  try {
    // 1. Enclosing type — CodeNode.parent_type is denormalised on every member.
    const nodeFilter = opts.filePaths && opts.filePaths.length > 0
      ? ` AND n.file_path IN [${cypherList(opts.filePaths)}]`
      : '';
    for (let offset = 0; ; offset += PAGE) {
      const rows = await ladybugQuery<{ id: string; pt: string }>(
        projectId,
        `MATCH (n:CodeNode {project_id: ${projectId}}) WHERE n.parent_type <> ''${nodeFilter}
         RETURN n.id AS id, n.parent_type AS pt SKIP ${offset} LIMIT ${PAGE}`,
      );
      nodeRows += rows.length;
      for (const r of rows) if (wanted.has(r.id) && r.pt) parent.set(r.id, String(r.pt));
      if (rows.length < PAGE) break;
    }

    // 2. Call edges, both directions from one scan.
    for (let offset = 0; ; offset += PAGE) {
      const rows = await ladybugQuery<{ src: string; sn: string; dst: string; dn: string }>(
        projectId,
        `MATCH (a:CodeNode {project_id: ${projectId}})-[e:CodeEdge]->(b:CodeNode)
         WHERE e.edge_type = 'calls'${fileFilter ? ` AND ${fileFilter}` : ''}
         RETURN a.id AS src, a.name AS sn, b.id AS dst, b.name AS dn SKIP ${offset} LIMIT ${PAGE}`,
      );
      edgeRows += rows.length;
      for (const r of rows) {
        if (wanted.has(r.src)) {
          const l = calls.get(r.src) ?? [];
          pushName(l, r.dn, max);
          calls.set(r.src, l);
        }
        if (wanted.has(r.dst)) {
          const l = calledBy.get(r.dst) ?? [];
          pushName(l, r.sn, max);
          calledBy.set(r.dst, l);
        }
      }
      if (rows.length < PAGE) break;
    }
  } catch (err) {
    logger.warn(`buildEmbeddingContext(project ${projectId}) graph unavailable — embedding without context: ${err instanceof Error ? err.message : String(err)}`);
  }

  for (const n of nodes) {
    const line = formatContextLine({ parent: parent.get(n.id), calls: calls.get(n.id) ?? [], calledBy: calledBy.get(n.id) ?? [] });
    if (line) out.set(n.id, line);
  }
  logger.debug(`buildEmbeddingContext project=${projectId} nodes=${nodes.length} withContext=${out.size} parentRows=${nodeRows} callEdges=${edgeRows} ms=${Date.now() - t0}`);
  return out;
}
