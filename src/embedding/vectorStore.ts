/**
 * Vector Store - ANN search for code embeddings via LanceDB
 *
 * Stores embeddings in LanceDB (.cache/fantomvector.db) and provides
 * approximate nearest neighbor search using cosine distance.
 *
 * Denormalizes project_id and node_type from CodeNode for filtered
 * vector search without cross-DB joins.
 */

import { readMinScore } from './hybridSearch.js';
import { recordEmbedTextVersion } from './embedTextVersions.js';
import type { PrismaClient } from '@prisma/client';
import { createLogger } from '../utils/index.js';
import { crashWrite } from '../utils/logSink.js';
import { EmbeddingService } from './embeddingService.js';
import { selectEmbeddingProvider, type EmbeddingProvider } from './providers/embeddingProvider.js';
import { getLanceTable, getActiveCodeTableName, codeTableHasV3Columns, openCodeSlotReadonly } from './lanceConnection.js';
import { ladybugQuery } from '../graph/ladybugConnection.js';
import { EMBED_TEXT_VERSION, EMBED_TEXT_V3 } from './embeddingText.js';

/** Partitions probed when a project/type filter narrows an IVF_PQ search.
 *  ~460 partitions on the 212k-row code table; 20 (the default) misses whole
 *  projects. Tunable: FANTOM_VECTOR_NPROBES. */
const FILTERED_NPROBES = (() => { const n = Number(process.env.FANTOM_VECTOR_NPROBES); return Number.isFinite(n) && n > 0 ? Math.round(n) : 96; })();

const logger = createLogger('vector-store');

function vsCrash(line: string): void {
  crashWrite('VSTORE', line);
}
function memTag(): string {
  const m = process.memoryUsage();
  return `rss=${Math.round(m.rss / 1024 / 1024)}MB heap=${Math.round(m.heapUsed / 1024 / 1024)}MB ext=${Math.round(m.external / 1024 / 1024)}MB`;
}

// ============================================
// Types
// ============================================

export interface VectorSearchResult {
  nodeId: string;
  score: number;  // Cosine similarity (0-1)
  distance: number;  // 1 - score
  projectId?: number; // which project's graph db this node lives in (for enrichment)
  // v3 rows (EMBED_TEXT_VERSION 3, table created with the chunk columns):
  nodeType?: string;
  /** Best-scoring chunk of this node; its own line range is the citation. */
  chunkIndex?: number;
  chunkCount?: number;
  lineStart?: number;
  lineEnd?: number;
  /** Denormalised on the row — the only source for file:/project: rows. */
  qualifiedName?: string;
  filePath?: string;
}

/** One row to store. Chunk/line fields come from buildEmbeddingItems (v3);
 *  legacy callers pass just nodeId + embedding and metadata is looked up in
 *  the graph. `nodeType` given ⇒ no graph lookup needed (file:/project: rows). */
export interface StoreEmbeddingItem {
  nodeId: string;
  embedding: Float32Array;
  chunkIndex?: number;
  chunkCount?: number;
  lineStart?: number;
  lineEnd?: number;
  nodeType?: string;
  qualifiedName?: string;
  filePath?: string;
}

export interface VectorSearchOptions {
  projectId?: number;
  nodeType?: string;
  limit?: number;
  minScore?: number;
}

// ============================================
// Vector Store Class
// ============================================

export class VectorStore {
  // Lazy resolution — strict-sidecar mode would throw at construction
  // time during boot agent init (before the WS heartbeat lands). The
  // first method call resolves the provider and propagates errors
  // through the caller's try/catch instead. An explicit override passed
  // by the caller is honored eagerly.
  private _embeddingService: EmbeddingProvider | null;

  constructor(_prisma: PrismaClient, embeddingService?: EmbeddingProvider | EmbeddingService) {
    this._embeddingService = embeddingService ? (embeddingService as EmbeddingProvider) : null;
  }

  private get embeddingService(): EmbeddingProvider {
    if (!this._embeddingService) this._embeddingService = selectEmbeddingProvider('code');
    return this._embeddingService;
  }

  /**
   * Store embedding for a code node (upsert: delete then add)
   */
  async storeEmbedding(nodeId: string, embedding: Float32Array): Promise<void> {
    const table = await getLanceTable();

    // Look up denormalized fields from CodeNode (Ladybug-authoritative).
    const rows = await ladybugQuery<{ pid: number; nt: string }>(
      `MATCH (n:CodeNode {id: '${nodeId}'}) RETURN n.project_id AS pid, n.node_type AS nt LIMIT 1`
    );
    const node = rows.length > 0
      ? { projectId: Number(rows[0].pid), nodeType: rows[0].nt }
      : null;

    if (!node) {
      logger.warn(`Cannot store embedding: CodeNode ${nodeId} not found`);
      return;
    }

    // Delete existing record if any
    try {
      await table.delete(`node_id = '${escSql(nodeId)}'`);
    } catch { /* ignore if not exists */ }

    await table.add([{
      node_id: nodeId,
      vector: Array.from(embedding),
      project_id: node.projectId,
      node_type: node.nodeType,
      model: this.embeddingService.getModelName(),
      dimensions: this.embeddingService.getDimensions(),
      created_at: new Date().toISOString(),
    }]);
  }

  /**
   * Store embeddings for multiple nodes (batched).
   *
   * SINGLE WRITER. LanceDB commits a new manifest version per append and this
   * codebase has no commit-conflict handling anywhere, so concurrent appends
   * to one table collide and lose rows. That was survivable while the rebuild
   * ran one project at a time and the scheduler's `onChunk` chain serialized
   * stores within it; it is not survivable now that projects run
   * concurrently. Every caller — the per-project workers, the auto-embed
   * pipeline, the legacy routes and compaction — funnels through this one
   * point, so serializing here covers all of them. Embedding stays fully
   * parallel; only the write is serialized, and an append is milliseconds
   * next to the embedding that produced it.
   *
   * The queue is keyed per table, so a shadow rebuild writing the inactive
   * slot never blocks a write to the live one.
   */
  async storeEmbeddings(
    items: StoreEmbeddingItem[],
    projectId?: number,
    targetTable?: import('@lancedb/lancedb').Table,
    producedBy?: EmbeddingProvider,
  ): Promise<number> {
    // targetTable lets a shadow re-embed write into the INACTIVE slot while
    // getLanceTable() (readers) stays on the live/active slot. Default = live.
    const table = targetTable ?? await getLanceTable();
    // The v3-column probe is cached per slot NAME; a shadow table passed in
    // explicitly must not reuse the active slot's cached answer, so the key is
    // undefined for it. Resolved here while we still know which case this is.
    const v3CacheKey = targetTable ? undefined : getActiveCodeTableName();
    const { enqueueTableWrite } = await import('./vectorWriteQueue.js');
    return enqueueTableWrite(table, () => this.storeEmbeddingsSerialized(items, projectId, table, v3CacheKey, producedBy));
  }

  private async storeEmbeddingsSerialized(
    items: StoreEmbeddingItem[],
    projectId: number | undefined,
    table: import('@lancedb/lancedb').Table,
    v3CacheKey: string | undefined,
    producedBy?: EmbeddingProvider,
  ): Promise<number> {
    const t0 = Date.now();
    // What produced these vectors, recorded on each row.
    //
    // `this.embeddingService` is the single-pick LOCAL selector, and it THROWS
    // under strict-sidecar mode when no local sidecar advertises the model —
    // the permanent state under "OpenRouter only". So merely labelling a row
    // used to kill a cloud rebuild from inside the scheduler's onChunk
    // callback, after the vectors had already been computed. The scheduler
    // knows which provider produced each chunk and now passes it in; callers
    // that do not are the local paths, where the getter is both correct and
    // safe to resolve.
    const stamp = producedBy
      ? { model: producedBy.getModelName(), dimensions: producedBy.getDimensions() }
      : { model: this.embeddingService.getModelName(), dimensions: this.embeddingService.getDimensions() };
    vsCrash(`storeEmbeddings ENTER items=${items.length} ${memTag()}`);
    vsCrash(`storeEmbeddings TABLE_OK afterMs=${Date.now() - t0}`);
    let stored = 0;

    // v3 rows (chunks, line range, qualified_name/file_path) need the v3
    // columns; a table created before EMBED_TEXT_VERSION 3 gets v2-shaped rows
    // (chunk 0 only) and the project stays recorded at version 2 → model-status
    // shows it stale until a full re-embed builds a fresh table.
    const v3 = EMBED_TEXT_V3 && await codeTableHasV3Columns(table, v3CacheKey);
    if (EMBED_TEXT_V3 && !v3) items = items.filter(i => !i.chunkIndex);
    // Text-layout bookkeeping for /admin/vectors/model-status (see embedTextVersions.ts).
    if (items.length) recordEmbedTextVersion(projectId, v3 ? EMBED_TEXT_VERSION : Math.min(EMBED_TEXT_VERSION, 2));

    // Look up denormalized fields for nodes that did not bring their own
    // (Ladybug-authoritative). Items with `nodeType` (built by
    // buildEmbeddingItems / buildSyntheticItems) skip the lookup when the
    // caller gave the projectId — file:/project: rows have no CodeNode at all.
    // Chunk the WHERE-OR list so the query stays within parser limits.
    const nodeIds = Array.from(new Set(items.filter(i => !i.nodeType || projectId == null).map(i => i.nodeId)));
    const nodes: Array<{ id: string; projectId: number; nodeType: string }> = [];
    const lookupStart = Date.now();
    for (let i = 0; i < nodeIds.length; i += 500) {
      const chunkNo = Math.floor(i / 500) + 1;
      const totalChunks = Math.ceil(nodeIds.length / 500);
      vsCrash(`LOOKUP_START chunk=${chunkNo}/${totalChunks} ids=${Math.min(500, nodeIds.length - i)} ${memTag()}`);
      const conditions = nodeIds.slice(i, i + 500).map(id => `n.id = '${id}'`).join(' OR ');
      try {
        // CRITICAL: the embedder (buildProjectEmbeddings) reads its node set
        // from the PER-PROJECT graph db (.cache/graph/<id>.db). The single-arg
        // ladybugQuery hits the legacy SHARED db, which is stale/partial — so
        // node-ids embedded from the per-project db were not found here and the
        // resulting vectors were silently dropped (`if (!node) continue`),
        // meaning resume/auto-embed could never converge. When the caller knows
        // the projectId, route the metadata lookup to the SAME per-project db.
        const rows = projectId != null
          ? await ladybugQuery<{ id: string; pid: number; nt: string }>(
              projectId,
              `MATCH (n:CodeNode {project_id: ${projectId}}) WHERE ${conditions} RETURN n.id AS id, n.project_id AS pid, n.node_type AS nt`,
            )
          : await ladybugQuery<{ id: string; pid: number; nt: string }>(
              `MATCH (n:CodeNode) WHERE ${conditions} RETURN n.id AS id, n.project_id AS pid, n.node_type AS nt`,
            );
        for (const r of rows) nodes.push({ id: r.id, projectId: Number(r.pid), nodeType: r.nt });
        vsCrash(`LOOKUP_OK chunk=${chunkNo}/${totalChunks} rows=${rows.length}`);
      } catch (err) {
        vsCrash(`LOOKUP_FAIL chunk=${chunkNo}/${totalChunks} err=${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    }
    vsCrash(`LOOKUP_DONE total=${nodes.length}/${nodeIds.length} ms=${Date.now() - lookupStart}`);
    const nodeMap = new Map(nodes.map(n => [n.id, n]));

    const batchSize = 100;
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const records: Array<Record<string, unknown>> = [];
      const deleteIds: string[] = [];

      for (const item of batch) {
        const node = nodeMap.get(item.nodeId);
        const pid = node?.projectId ?? (item.nodeType ? projectId : undefined);
        const nodeType = node?.nodeType ?? item.nodeType;
        if (pid == null || !nodeType) continue;

        if (!deleteIds.includes(item.nodeId)) deleteIds.push(item.nodeId);
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
        records.push(rec);
      }

      if (records.length === 0) {
        vsCrash(`SUBBATCH SKIP i=${i} reason=no-matched-nodes`);
        continue;
      }

      const subBatchNo = Math.floor(i / batchSize) + 1;
      const totalSubBatches = Math.ceil(items.length / batchSize);
      vsCrash(`SUBBATCH START ${subBatchNo}/${totalSubBatches} records=${records.length} delete=${deleteIds.length}`);

      // Delete existing records. node_id is the BASE id on every chunk row, so
      // this also removes stale chunks of a node that got shorter.
      if (deleteIds.length > 0) {
        const delStart = Date.now();
        const idList = deleteIds.map(id => `'${escSql(id)}'`).join(', ');
        try {
          await table.delete(`node_id IN (${idList})`);
          vsCrash(`DELETE_OK ${subBatchNo}/${totalSubBatches} ids=${deleteIds.length} ms=${Date.now() - delStart}`);
        } catch (err) {
          vsCrash(`DELETE_FAIL ${subBatchNo}/${totalSubBatches} err=${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const addStart = Date.now();
      try {
        await table.add(records);
        vsCrash(`ADD_OK ${subBatchNo}/${totalSubBatches} records=${records.length} ms=${Date.now() - addStart} ${memTag()}`);
      } catch (err) {
        vsCrash(`ADD_FAIL ${subBatchNo}/${totalSubBatches} err=${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
      stored += records.length;
    }

    logger.debug(`Stored ${stored} embeddings`);
    vsCrash(`storeEmbeddings DONE stored=${stored} totalMs=${Date.now() - t0} ${memTag()}`);
    return stored;
  }

  /**
   * Get embedding for a node
   */
  async getEmbedding(nodeId: string): Promise<Float32Array | null> {
    const table = await getLanceTable();
    const v3 = EMBED_TEXT_V3 && await codeTableHasV3Columns(table, getActiveCodeTableName());

    // Chunk 0 represents the node (it carries the doc); other chunks are windows.
    const results = await table.query()
      .where(`node_id = '${escSql(nodeId)}'${v3 ? ' AND chunk_index = 0' : ''}`)
      .select(['vector'])
      .limit(1)
      .toArray();

    if (results.length === 0) return null;

    return new Float32Array(results[0].vector);
  }

  /**
   * Delete embedding for a node
   */
  async deleteEmbedding(nodeId: string): Promise<void> {
    const table = await getLanceTable();
    try {
      await table.delete(`node_id = '${escSql(nodeId)}'`);
    } catch { /* ignore if not exists */ }
  }

  /**
   * Search for similar vectors using cosine similarity via LanceDB ANN
   */
  async search(
    queryEmbedding: Float32Array,
    options: VectorSearchOptions = {}
  ): Promise<VectorSearchResult[]> {
    // No absolute floor by default — see readMinScore(). An explicit
    // options.minScore (per request) still wins over the config knob.
    const minScore = options.minScore ?? readMinScore() ?? 0;
    const { projectId, nodeType, limit = 10 } = options;

    const table = await getLanceTable();

    const rowCount = await table.countRows();
    if (rowCount === 0) return [];

    // v3 tables hold several rows per node (chunks) plus file:/project: rows;
    // over-fetch and group by node_id below, keeping each node's best chunk.
    const v3 = EMBED_TEXT_V3 && await codeTableHasV3Columns(table, getActiveCodeTableName());
    const columns = v3
      ? ['node_id', 'project_id', 'node_type', 'chunk_index', 'chunk_count', 'line_start', 'line_end', 'qualified_name', 'file_path']
      : ['node_id', 'project_id'];

    // Build vector search query with cosine distance
    let query = table.vectorSearch(Array.from(queryEmbedding))
      .distanceType('cosine')
      .select(columns)
      // IVF_PQ distances are codebook estimates; re-score the top candidates
      // against the stored vectors so the scores the caller sees are exact.
      .refineFactor(2)
      .limit(limit * (v3 ? 4 : 2)); // Get extra to collapse chunks (and for an opt-in minScore)

    // Apply filters
    const filters: string[] = [];
    if (projectId) filters.push(`project_id = ${projectId}`);
    if (nodeType) filters.push(`node_type = '${escSql(nodeType)}'`);

    if (filters.length > 0) {
      query = query.where(filters.join(' AND '));
      // IVF_PQ + a project filter: the SDK prefilters, so the search only sees
      // rows of THIS project inside the probed partitions. With the default
      // 20 probes over ~460 partitions a 5,210-row project is often absent
      // from all of them, and a perfectly good query returns NOTHING — the
      // RLM logged "search_code: no results" for "open sax file" on a project
      // whose loadAppSax scored 0.97 for a sibling phrasing. Probe wider when
      // filtered; the per-project candidate set is small so this stays cheap.
      query = query.nprobes(FILTERED_NPROBES);
    }

    let rawResults = await query.toArray();
    if (rawResults.length === 0 && filters.length > 0) {
      // Still nothing: the project's rows sit outside every probed partition.
      // A brute-force scan restricted by the same filter is a few thousand
      // rows — milliseconds — and cannot miss. Log it so index tuning has data.
      const t0 = Date.now();
      rawResults = await table.vectorSearch(Array.from(queryEmbedding))
        .distanceType('cosine')
        .select(columns)
        .limit(limit * (v3 ? 4 : 2))
        .where(filters.join(' AND '))
        .bypassVectorIndex()
        .toArray();
      logger.info(`[vector-search] ANN returned 0 rows under filter "${filters.join(' AND ')}"; flat scan found ${rawResults.length} in ${Date.now() - t0}ms`);
    }

    // LanceDB cosine distance = 1 - cosine_similarity
    const results: VectorSearchResult[] = [];
    const seenNodes = new Set<string>();
    let belowFloor = 0;
    for (const row of rawResults) {
      const distance: number = row._distance ?? 0;
      const score = 1 - distance;
      if (score < minScore) { belowFloor++; continue; }

      const r: VectorSearchResult = {
        nodeId: row.node_id,
        score,
        distance,
        projectId: typeof row.project_id === 'number' ? row.project_id : (typeof row.project_id === 'bigint' ? Number(row.project_id) : undefined),
      };
      if (v3) {
        // Group by node: rows arrive best-first, so the first chunk seen wins.
        if (seenNodes.has(r.nodeId)) continue;
        seenNodes.add(r.nodeId);
        r.nodeType = row.node_type ?? undefined;
        r.chunkIndex = row.chunk_index != null ? Number(row.chunk_index) : undefined;
        r.chunkCount = row.chunk_count != null ? Number(row.chunk_count) : undefined;
        r.lineStart = row.line_start != null && Number(row.line_start) > 0 ? Number(row.line_start) : undefined;
        r.lineEnd = row.line_end != null && Number(row.line_end) > 0 ? Number(row.line_end) : undefined;
        r.qualifiedName = row.qualified_name || undefined;
        r.filePath = row.file_path || undefined;
      }
      results.push(r);
    }

    if (filters.length > 0) {
      const best = rawResults.length ? (1 - (rawResults[0]._distance ?? 0)).toFixed(3) : 'n/a';
      logger.info(`[vector-search] filter="${filters.join(' AND ')}" raw=${rawResults.length} belowFloor(${minScore})=${belowFloor} kept=${results.length} best=${best}`);
    }
    return results.slice(0, limit);
  }

  /**
   * Search for similar code using a text query
   */
  /**
   * A QUERY path, so it resolves its encoder by policy rather than reusing
   * `this.embeddingService` — that getter goes through the single-pick
   * selector, which never constructs a cloud provider, and under "OpenRouter
   * only" would encode the query on a local Q4_K_M model against an index
   * built entirely from full-precision cloud vectors. It has no callers today;
   * routing it now means the next one cannot inherit that hole.
   */
  async searchByText(
    query: string,
    options: VectorSearchOptions = {}
  ): Promise<VectorSearchResult[]> {
    const { selectQueryEmbeddingProvider } = await import('./providers/embeddingProvider.js');
    const provider = await selectQueryEmbeddingProvider('code');
    await provider.initialize();
    const queryEmbedding = await provider.embed(query);
    return this.search(queryEmbedding, options);
  }

  /**
   * Count total vectors stored
   */
  async count(projectId?: number): Promise<number> {
    const table = await getLanceTable();
    // v3: count NODES with vectors (distinct node_id, symbol rows only) so the
    // dashboard's coverage (vectors / CodeNodes) stays a percentage — a node
    // may hold several chunk rows, and file:/project: rows have no CodeNode.
    if (EMBED_TEXT_V3 && await codeTableHasV3Columns(table, getActiveCodeTableName())) {
      const where = `node_type <> 'file' AND node_type <> 'project'${projectId ? ` AND project_id = ${projectId}` : ''}`;
      const rows = await table.query().where(where).select(['node_id']).toArray();
      return new Set(rows.map((r: { node_id: string }) => r.node_id)).size;
    }
    if (projectId) {
      return table.countRows(`project_id = ${projectId}`);
    }
    return table.countRows();
  }

  /**
   * Delete all vectors for a project.
   *
   * `targetTable` lets a resume clear a project's PARTIAL rows out of the
   * shadow slot before redoing it. That clear now runs from N concurrent
   * workers, and a delete is a manifest commit like an append — so it takes
   * the same per-table write slot.
   */
  async deleteProjectVectors(
    projectId: number,
    targetTable?: import('@lancedb/lancedb').Table,
  ): Promise<number> {
    const table = targetTable ?? await getLanceTable();
    const { enqueueTableWrite } = await import('./vectorWriteQueue.js');
    return enqueueTableWrite(table, async () => {
      const countBefore = await table.countRows(`project_id = ${projectId}`);
      if (countBefore > 0) {
        await table.delete(`project_id = ${projectId}`);
      }
      return countBefore;
    });
  }

  /**
   * Get all node IDs that have vectors for a given project
   */
  async getNodeIdsForProject(projectId: number): Promise<Set<string>> {
    const table = await getLanceTable();
    const rows = await table.query()
      .where(`project_id = ${projectId}`)
      .select(['node_id'])
      .toArray();

    return new Set(rows.map((r: { node_id: string }) => r.node_id));
  }

  /**
   * Get vectors with embeddings for a project (for 2D projection in viewer)
   */
  async getProjectVectorsWithEmbeddings(
    projectId: number,
    limit: number = 500
  ): Promise<Array<{ nodeId: string; embedding: Float32Array }>> {
    const table = await getLanceTable();
    const rows = await table.query()
      .where(`project_id = ${projectId}`)
      .select(['node_id', 'vector'])
      .limit(limit)
      .toArray();

    return rows.map((r: { node_id: string; vector: number[] }) => ({
      nodeId: r.node_id,
      embedding: new Float32Array(r.vector),
    }));
  }

  /**
   * Get vector counts grouped by project
   */
  async countByProject(slotName?: string): Promise<Map<number, number>> {
    // slotName lets progress reporting count the SHADOW slot while a full
    // re-embed builds into it; without it the dashboard shows only the stale
    // active slot and every in-progress project appears to be at zero.
    const table = slotName ? await openCodeSlotReadonly(slotName) : await getLanceTable();
    const counts = new Map<number, number>();
    if (!table) return counts;
    if (EMBED_TEXT_V3 && await codeTableHasV3Columns(table, slotName ?? getActiveCodeTableName())) {
      // Distinct symbol nodes per project (see count()).
      const rows = await table.query()
        .where(`node_type <> 'file' AND node_type <> 'project'`)
        .select(['project_id', 'node_id'])
        .toArray();
      const seen = new Map<number, Set<string>>();
      for (const row of rows) {
        const pid = Number(row.project_id);
        const set = seen.get(pid) ?? new Set<string>();
        set.add(row.node_id as string);
        seen.set(pid, set);
      }
      for (const [pid, set] of seen) counts.set(pid, set.size);
      return counts;
    }
    const rows = await table.query()
      .select(['project_id'])
      .toArray();

    for (const row of rows) {
      const pid = row.project_id as number;
      counts.set(pid, (counts.get(pid) || 0) + 1);
    }
    return counts;
  }
}

// ============================================
// Helpers
// ============================================

function escSql(value: string): string {
  return value.replace(/'/g, "''");
}

// ============================================
// Factory Function
// ============================================

let storeInstance: VectorStore | null = null;

/**
 * Get or create the vector store singleton
 */
export function getVectorStore(prisma: PrismaClient): VectorStore {
  if (!storeInstance) {
    storeInstance = new VectorStore(prisma);
  }
  return storeInstance;
}

/**
 * Reset the vector store (for testing)
 */
export function resetVectorStore(): void {
  storeInstance = null;
}
