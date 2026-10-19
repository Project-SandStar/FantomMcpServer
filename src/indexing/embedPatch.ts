/**
 * Incremental embedding (lazy-incremental-indexing.md 3.5, phase 4).
 *
 * `embedPatch` takes the embedding items of the nodes of some files and:
 *   1. hashes each node's text (all chunks) and compares it with its
 *      `vector_state` row (text_hash + text_version + model): same = skip;
 *   2. embeds the rest through `embed_cache`, so text seen before (a symbol
 *      that moved, a branch switched back) costs no provider call;
 *   3. stores the vectors and upserts `vector_state`;
 *   4. deletes orphans: state rows of these files that no node claims.
 *
 * `gcVectors` (the `vector-gc` task) and `countOrphans` (getIndexHealth)
 * compare a whole project's vectors with its graph.
 *
 * Every store access is a dependency, so tests run with mocks. vector_state
 * is read and written with raw SQL: it works before `prisma generate` runs.
 */

import { createHash } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { createLogger } from '../utils/index.js';
import { EMBED_TEXT_VERSION, fileNodeId, type EmbeddingItem } from '../embedding/embeddingText.js';
import type { EmbedCache } from '../embedding/embedCache.js';
import type { StoreEmbeddingItem } from '../embedding/vectorStore.js';

const logger = createLogger('embed-patch');
const SQL_CHUNK = 400;

export interface VectorStateRow {
  nodeId: string;
  projectId: number;
  filePath: string;
  qualifiedName: string;
  symbolKey: string;
  bodySha: string;
  textHash: string;
  textVersion: number;
  model: string;
  chunkCount: number;
}

export interface EmbedPatchDeps {
  prisma: PrismaClient;
  /** Model that writes the rows (cache key and state). */
  model: string;
  textVersion?: number;
  /** Provider call for texts the cache does not have. */
  embed(texts: string[]): Promise<Float32Array[]>;
  cache?: EmbedCache | null;
  store(items: StoreEmbeddingItem[]): Promise<number>;
  deleteVectors(nodeIds: string[]): Promise<number>;
  batchSize?: number;
}

export interface EmbedPatchInput {
  projectId: number;
  items: EmbeddingItem[];
  /** symbol_key / body_sha per node id, when the graph has them. */
  keys?: Map<string, { symbolKey: string; bodySha: string }>;
  /** Files whose complete node set is in `items`: their other state rows are orphans. */
  filePaths?: string[];
  /** Files that are gone: all their state rows (and vectors) are orphans. */
  removedPaths?: string[];
  /** Ids whose vector was dropped already: embed even when the state matches. */
  mustEmbed?: Set<string>;
  runId?: number | null;
}

export interface EmbedPatchResult {
  nodes: number;
  unchanged: number;
  embeddedNodes: number;
  /** Texts sent to the provider (cache misses). */
  providerTexts: number;
  cacheHits: number;
  rowsStored: number;
  orphansDeleted: number;
}

/** Hash of a node's full embed text: every chunk, in order. */
export function nodeTextHash(chunks: Array<{ chunkIndex: number; text: string }>): string {
  const h = createHash('sha256');
  for (const c of [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex)) h.update(c.text).update('\u001e');
  return h.digest('hex');
}

function chunked<T>(xs: T[], n = SQL_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

const marks = (n: number) => new Array(n).fill('?').join(',');

function toRow(r: any): VectorStateRow {
  return {
    nodeId: r.node_id, projectId: Number(r.project_id), filePath: r.file_path, qualifiedName: r.qualified_name,
    symbolKey: r.symbol_key, bodySha: r.body_sha, textHash: r.text_hash, textVersion: Number(r.text_version),
    model: r.model, chunkCount: Number(r.chunk_count),
  };
}

export async function readVectorState(prisma: PrismaClient, projectId: number, nodeIds: string[]): Promise<Map<string, VectorStateRow>> {
  const out = new Map<string, VectorStateRow>();
  for (const ids of chunked([...new Set(nodeIds)])) {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM vector_state WHERE project_id = ? AND node_id IN (${marks(ids.length)})`, projectId, ...ids);
    for (const r of rows) out.set(r.node_id, toRow(r));
  }
  return out;
}

export async function readVectorStateForFiles(prisma: PrismaClient, projectId: number, filePaths: string[]): Promise<VectorStateRow[]> {
  const out: VectorStateRow[] = [];
  for (const fps of chunked([...new Set(filePaths)])) {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM vector_state WHERE project_id = ? AND file_path IN (${marks(fps.length)})`, projectId, ...fps);
    out.push(...rows.map(toRow));
  }
  return out;
}

export async function readAllVectorStateIds(prisma: PrismaClient, projectId: number): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ node_id: string }>>(
    `SELECT node_id FROM vector_state WHERE project_id = ?`, projectId);
  return rows.map(r => r.node_id);
}

export async function upsertVectorState(prisma: PrismaClient, rows: Array<VectorStateRow & { runId?: number | null }>): Promise<void> {
  for (const r of rows) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO vector_state (node_id, project_id, file_path, qualified_name, symbol_key, body_sha, text_hash, text_version, model, chunk_count, embedded_at, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
       ON CONFLICT(node_id) DO UPDATE SET project_id = excluded.project_id, file_path = excluded.file_path,
         qualified_name = excluded.qualified_name, symbol_key = excluded.symbol_key, body_sha = excluded.body_sha,
         text_hash = excluded.text_hash, text_version = excluded.text_version, model = excluded.model,
         chunk_count = excluded.chunk_count, embedded_at = CURRENT_TIMESTAMP, run_id = excluded.run_id`,
      r.nodeId, r.projectId, r.filePath, r.qualifiedName, r.symbolKey, r.bodySha, r.textHash, r.textVersion, r.model, r.chunkCount, r.runId ?? null);
  }
}

export async function deleteVectorState(prisma: PrismaClient, projectId: number, nodeIds: string[]): Promise<number> {
  let n = 0;
  for (const ids of chunked([...new Set(nodeIds)])) {
    n += await prisma.$executeRawUnsafe(
      `DELETE FROM vector_state WHERE project_id = ? AND node_id IN (${marks(ids.length)})`, projectId, ...ids);
  }
  return n;
}

export async function embedPatch(deps: EmbedPatchDeps, input: EmbedPatchInput): Promise<EmbedPatchResult> {
  const textVersion = deps.textVersion ?? EMBED_TEXT_VERSION;
  const B = deps.batchSize ?? 50;
  const res: EmbedPatchResult = { nodes: 0, unchanged: 0, embeddedNodes: 0, providerTexts: 0, cacheHits: 0, rowsStored: 0, orphansDeleted: 0 };

  // Group chunks per node.
  const byNode = new Map<string, EmbeddingItem[]>();
  for (const it of input.items) {
    const l = byNode.get(it.nodeId);
    if (l) l.push(it); else byNode.set(it.nodeId, [it]);
  }
  res.nodes = byNode.size;
  const state = await readVectorState(deps.prisma, input.projectId, [...byNode.keys()]);

  const todo: Array<{ nodeId: string; chunks: EmbeddingItem[]; hash: string }> = [];
  for (const [nodeId, chunks] of byNode) {
    const hash = nodeTextHash(chunks);
    const s = state.get(nodeId);
    if (s && s.textHash === hash && s.textVersion === textVersion && s.model === deps.model && !input.mustEmbed?.has(nodeId)) {
      res.unchanged++;
      continue;
    }
    todo.push({ nodeId, chunks, hash });
  }

  // Embed changed text through the cache, a batch of chunks at a time.
  const work = todo.flatMap(t => t.chunks);
  const cache = deps.cache && deps.cache.isEnabled() ? deps.cache : null;
  const vectors = new Map<EmbeddingItem, Float32Array>();
  for (let i = 0; i < work.length; i += B) {
    const batch = work.slice(i, i + B);
    const texts = batch.map(b => b.text);
    let vecs: Float32Array[];
    if (cache) {
      const r = await cache.embedThrough(deps.model, texts, async miss => {
        res.providerTexts += miss.length;
        return deps.embed(miss);
      }, textVersion);
      vecs = r.vectors;
      res.cacheHits += r.hits;
    } else {
      res.providerTexts += texts.length;
      vecs = await deps.embed(texts);
    }
    batch.forEach((b, j) => { if (vecs[j]) vectors.set(b, vecs[j]); });
  }

  // Store per node (all chunks or none), then record the state.
  const stored: Array<VectorStateRow & { runId?: number | null }> = [];
  const items: StoreEmbeddingItem[] = [];
  for (const t of todo) {
    if (!t.chunks.every(c => vectors.has(c))) continue;
    for (const c of t.chunks) items.push({ ...c, embedding: vectors.get(c)! });
    const first = t.chunks[0];
    const k = input.keys?.get(t.nodeId);
    stored.push({
      nodeId: t.nodeId, projectId: input.projectId, filePath: first.filePath ?? '', qualifiedName: first.qualifiedName ?? '',
      symbolKey: k?.symbolKey ?? '', bodySha: k?.bodySha ?? '', textHash: t.hash, textVersion, model: deps.model,
      chunkCount: t.chunks.length, runId: input.runId ?? null,
    });
  }
  for (let i = 0; i < items.length; i += B) res.rowsStored += await deps.store(items.slice(i, i + B));
  await upsertVectorState(deps.prisma, stored);
  res.embeddedNodes = stored.length;

  // Orphans: state rows of these files that no current node claims.
  const scope = [...(input.filePaths ?? []), ...(input.removedPaths ?? [])];
  if (scope.length > 0) {
    const rows = await readVectorStateForFiles(deps.prisma, input.projectId, scope);
    const orphanIds = rows.map(r => r.nodeId).filter(id => !byNode.has(id));
    for (const fp of input.removedPaths ?? []) orphanIds.push(fileNodeId(fp));
    if (orphanIds.length > 0) {
      res.orphansDeleted = await deps.deleteVectors([...new Set(orphanIds)]);
      await deleteVectorState(deps.prisma, input.projectId, orphanIds);
    }
  }
  logger.info(`embedPatch project=${input.projectId}: ${res.nodes} nodes, ${res.unchanged} unchanged, ${res.embeddedNodes} embedded (${res.providerTexts} provider texts, ${res.cacheHits} cache hits), ${res.orphansDeleted} orphan rows deleted`);
  return res;
}

// ── project-wide orphan check (vector-gc, getIndexHealth) ─────────────────

export interface OrphanDeps {
  prisma: PrismaClient;
  /** Node ids and file paths in the project's graph. */
  graph(projectId: number): Promise<{ ids: Set<string>; filePaths: Set<string> }>;
  /** Node ids that have a vector row. */
  vectorIds(projectId: number): Promise<Set<string>>;
  deleteVectors(projectId: number, nodeIds: string[]): Promise<number>;
}

export interface OrphanReport {
  /** Vector node ids no graph node (or file) claims. */
  vectorOrphans: string[];
  /** vector_state rows no graph node (or file) claims. */
  stateOrphans: string[];
}

function claimed(id: string, ids: Set<string>, fileIds: Set<string>): boolean {
  if (id.startsWith('project:')) return true;
  if (id.startsWith('file:')) return fileIds.has(id);
  return ids.has(id);
}

export async function findOrphans(deps: OrphanDeps, projectId: number): Promise<OrphanReport> {
  const g = await deps.graph(projectId);
  // An empty graph (failed open, mid-rebuild) must never read as "every vector is an orphan".
  if (g.ids.size === 0) return { vectorOrphans: [], stateOrphans: [] };
  const fileIds = new Set([...g.filePaths].map(fileNodeId));
  const vec = await deps.vectorIds(projectId);
  const st = await readAllVectorStateIds(deps.prisma, projectId).catch(() => [] as string[]);
  return {
    vectorOrphans: [...vec].filter(id => !claimed(id, g.ids, fileIds)),
    stateOrphans: st.filter(id => !claimed(id, g.ids, fileIds)),
  };
}

/** The `vector-gc` task: delete what `findOrphans` finds. */
export async function gcVectors(deps: OrphanDeps, projectId: number): Promise<{ vectorsDeleted: number; stateDeleted: number }> {
  const o = await findOrphans(deps, projectId);
  const vectorsDeleted = o.vectorOrphans.length ? await deps.deleteVectors(projectId, o.vectorOrphans) : 0;
  const stateDeleted = o.stateOrphans.length ? await deleteVectorState(deps.prisma, projectId, o.stateOrphans) : 0;
  if (vectorsDeleted || stateDeleted) logger.info(`vector-gc project=${projectId}: ${vectorsDeleted} vector rows, ${stateDeleted} state rows deleted`);
  return { vectorsDeleted, stateDeleted };
}

/** Production wiring of OrphanDeps (graph + code_vectors). */
export function liveOrphanDeps(prisma: PrismaClient): OrphanDeps {
  return {
    prisma,
    async graph(projectId) {
      const { ladybugQuery } = await import('../graph/ladybugConnection.js');
      const rows = await ladybugQuery<{ id: string; fp: string }>(projectId,
        `MATCH (n:CodeNode {project_id: ${projectId}}) RETURN n.id AS id, n.file_path AS fp`);
      return { ids: new Set(rows.map(r => r.id)), filePaths: new Set(rows.map(r => r.fp).filter(Boolean)) };
    },
    async vectorIds(projectId) {
      const { getVectorStore } = await import('../embedding/vectorStore.js');
      return getVectorStore(prisma).getNodeIdsForProject(projectId);
    },
    async deleteVectors(projectId, ids) {
      const { getVectorStore } = await import('../embedding/vectorStore.js');
      return getVectorStore(prisma).deleteNodeVectors(projectId, ids);
    },
  };
}
