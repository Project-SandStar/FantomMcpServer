/**
 * Code-vector rows: build them OUTSIDE the table's write slot, commit them
 * inside it (ORDW-05).
 *
 * `prepareCodeRowGroups` does the slow part (v3/v4 column probes, graph
 * lookup of node metadata in chunks of 500, row building) before anything is
 * queued, so the LadybugDB query no longer holds the table's write lock.
 * `commitCodeRowGroups` is the commit function the write buffer calls: one
 * delete of every base `node_id` in the batch, then one add of their rows.
 */

import { recordEmbedTextVersion } from './embedTextVersions.js';
import { crashWrite } from '../utils/logSink.js';
import { codeTableHasV3Columns, codeTableHasV4Columns } from './lanceConnection.js';
import { ladybugQuery } from '../graph/ladybugConnection.js';
import { EMBED_TEXT_VERSION, EMBED_TEXT_V3, EMBED_TEXT_V4 } from './embeddingText.js';
import type { RowGroup } from './vectorWriteBuffer.js';
import type { StoreEmbeddingItem } from './vectorStore.js';

function vsCrash(line: string): void {
  crashWrite('VSTORE', line);
}
function memTag(): string {
  const m = process.memoryUsage();
  return `rss=${Math.round(m.rss / 1024 / 1024)}MB heap=${Math.round(m.heapUsed / 1024 / 1024)}MB ext=${Math.round(m.external / 1024 / 1024)}MB`;
}
function escSql(s: string): string {
  return s.replace(/'/g, "''");
}

const LOOKUP_CHUNK = 500;

/**
 * Turn store items into row groups, one group per base node id (all its chunk
 * rows), in first-seen order. Items whose node is not found are skipped, as
 * before. Throws when the graph lookup fails (as before).
 */
export async function prepareCodeRowGroups(
  items: StoreEmbeddingItem[],
  projectId: number | undefined,
  table: import('@lancedb/lancedb').Table,
  v3CacheKey: string | undefined,
  stamp: { model: string; dimensions: number },
): Promise<RowGroup[]> {
  // v3 rows (chunks, line range, qualified_name/file_path) need the v3
  // columns; a table created before EMBED_TEXT_VERSION 3 gets v2-shaped rows
  // (chunk 0 only) and the project stays recorded at version 2 → model-status
  // shows it stale until a full re-embed builds a fresh table.
  const v3 = EMBED_TEXT_V3 && await codeTableHasV3Columns(table, v3CacheKey);
  if (EMBED_TEXT_V3 && !v3) items = items.filter(i => !i.chunkIndex);
  // v4 (`text` column) likewise only on a table created by a v4 build.
  const v4 = EMBED_TEXT_V4 && v3 && await codeTableHasV4Columns(table, v3CacheKey);
  if (items.length) recordEmbedTextVersion(projectId, v4 ? EMBED_TEXT_VERSION : v3 ? Math.min(EMBED_TEXT_VERSION, 3) : Math.min(EMBED_TEXT_VERSION, 2));

  // Look up denormalized fields for nodes that did not bring their own
  // (Ladybug-authoritative). Items with `nodeType` skip the lookup when the
  // caller gave the projectId — file:/project: rows have no CodeNode at all.
  const nodeIds = Array.from(new Set(items.filter(i => !i.nodeType || projectId == null).map(i => i.nodeId)));
  const nodeMap = new Map<string, { projectId: number; nodeType: string }>();
  const lookupStart = Date.now();
  for (let i = 0; i < nodeIds.length; i += LOOKUP_CHUNK) {
    const chunkNo = Math.floor(i / LOOKUP_CHUNK) + 1;
    const totalChunks = Math.ceil(nodeIds.length / LOOKUP_CHUNK);
    vsCrash(`LOOKUP_START chunk=${chunkNo}/${totalChunks} ids=${Math.min(LOOKUP_CHUNK, nodeIds.length - i)} ${memTag()}`);
    const conditions = nodeIds.slice(i, i + LOOKUP_CHUNK).map(id => `n.id = '${id}'`).join(' OR ');
    try {
      // CRITICAL: route to the SAME per-project db the embedder read its
      // nodes from when the projectId is known; the single-arg ladybugQuery
      // hits the stale shared db and found-nothing rows were dropped.
      const rows = projectId != null
        ? await ladybugQuery<{ id: string; pid: number; nt: string }>(
            projectId,
            `MATCH (n:CodeNode {project_id: ${projectId}}) WHERE ${conditions} RETURN n.id AS id, n.project_id AS pid, n.node_type AS nt`,
          )
        : await ladybugQuery<{ id: string; pid: number; nt: string }>(
            `MATCH (n:CodeNode) WHERE ${conditions} RETURN n.id AS id, n.project_id AS pid, n.node_type AS nt`,
          );
      for (const r of rows) nodeMap.set(r.id, { projectId: Number(r.pid), nodeType: r.nt });
      vsCrash(`LOOKUP_OK chunk=${chunkNo}/${totalChunks} rows=${rows.length}`);
    } catch (err) {
      vsCrash(`LOOKUP_FAIL chunk=${chunkNo}/${totalChunks} err=${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }
  vsCrash(`LOOKUP_DONE total=${nodeMap.size}/${nodeIds.length} ms=${Date.now() - lookupStart}`);

  const groups = new Map<string, RowGroup>();
  let skipped = 0;
  for (const item of items) {
    const node = nodeMap.get(item.nodeId);
    const pid = node?.projectId ?? (item.nodeType ? projectId : undefined);
    const nodeType = node?.nodeType ?? item.nodeType;
    if (pid == null || !nodeType) { skipped++; continue; }
    const rec: Record<string, unknown> = {
      node_id: item.nodeId,
      vector: Array.from(item.embedding),
      project_id: pid,
      node_type: nodeType,
      ...stamp,
      created_at: new Date().toISOString(),
    };
    if (v3) {
      const ci = item.chunkIndex ?? 0;
      Object.assign(rec, {
        row_id: ci === 0 ? item.nodeId : `${item.nodeId}#${ci}`,
        chunk_index: ci,
        chunk_count: item.chunkCount ?? 1,
        line_start: item.lineStart ?? 0,
        line_end: item.lineEnd ?? item.lineStart ?? 0,
        qualified_name: item.qualifiedName ?? '',
        file_path: item.filePath ?? '',
      });
    }
    if (v4) rec.text = item.text ?? '';
    let g = groups.get(item.nodeId);
    if (!g) { g = { key: item.nodeId, rows: [] }; groups.set(item.nodeId, g); }
    g.rows.push(rec);
  }
  if (skipped) vsCrash(`PREPARE SKIP items=${skipped} reason=no-matched-nodes`);
  return [...groups.values()];
}

/**
 * Commit one batch to a code table: one delete of every base node id (this
 * also removes stale chunks of a node that got shorter), then one add. Same
 * failure rules as before: a failed delete is logged and the add goes on; a
 * failed add throws.
 */
export async function commitCodeRowGroups(table: unknown, groups: RowGroup[]): Promise<void> {
  const t = table as import('@lancedb/lancedb').Table;
  const ids = groups.map(g => g.key);
  const records = groups.flatMap(g => g.rows);
  if (records.length === 0) return;
  vsCrash(`COMMIT START records=${records.length} delete=${ids.length}`);
  const delStart = Date.now();
  try {
    await t.delete(`node_id IN (${ids.map(id => `'${escSql(id)}'`).join(', ')})`);
    vsCrash(`DELETE_OK ids=${ids.length} ms=${Date.now() - delStart}`);
  } catch (err) {
    vsCrash(`DELETE_FAIL ids=${ids.length} err=${err instanceof Error ? err.message : String(err)}`);
  }
  const addStart = Date.now();
  try {
    await t.add(records);
    vsCrash(`ADD_OK records=${records.length} ms=${Date.now() - addStart} ${memTag()}`);
  } catch (err) {
    vsCrash(`ADD_FAIL records=${records.length} err=${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}
