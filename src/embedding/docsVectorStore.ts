/**
 * Docs Vector Store - ANN search for documentation embeddings via LanceDB
 *
 * Stores documentation embeddings in LanceDB docs_vectors table
 * and provides approximate nearest neighbor search using cosine distance.
 *
 * Schema: doc_id, vector, pod, doc_type, title, url, model, dimensions, created_at
 */

import { createLogger } from '../utils/index.js';
import { EmbeddingService } from './embeddingService.js';
import { selectEmbeddingProvider, type EmbeddingProvider } from './providers/embeddingProvider.js';
import { getDocsLanceTable } from './lanceConnection.js';

const logger = createLogger('docs-vector-store');

// ============================================
// Types
// ============================================

export interface DocVectorRecord {
  docId: string;
  pod: string;
  docType: string;   // 'type' | 'slot' | 'pod' | 'chapter'
  title: string;
  url: string;
  instanceId?: number;
  language?: string;  // 'fantom' | 'axon'
}

export interface DocSearchResult {
  docId: string;
  pod: string;
  docType: string;
  title: string;
  url: string;
  score: number;
  distance: number;
}

export interface DocSearchOptions {
  pod?: string;
  docType?: string;
  instanceId?: number;
  language?: string;
  limit?: number;
  minScore?: number;
}

// ============================================
// Docs Vector Store Class
// ============================================

/**
 * What produced this row, recorded on the row itself.
 *
 * Takes the provider as an argument rather than reading `this.embeddingService`
 * because that getter is the single-pick LOCAL selector. Under "OpenRouter
 * only" the pipeline embeds with a cloud provider, so reading the getter would
 * label a 2560d cloud vector with the local model's name and 1024 dims — a row
 * that misreports both what wrote it and how wide it is, while the vector
 * beside it says otherwise. The code table had the same attribution hole and
 * it is not worth reopening here.
 *
 * Callers that do not pass one get the old behaviour, which is correct for
 * them: they are the local paths that did the embedding through that getter.
 */
function stampOf(p: EmbeddingProvider): { model: string; dimensions: number } {
  return { model: p.getModelName(), dimensions: p.getDimensions() };
}

export class DocsVectorStore {
  private _embeddingService: EmbeddingProvider | null;

  constructor(embeddingService?: EmbeddingProvider | EmbeddingService) {
    this._embeddingService = embeddingService ? (embeddingService as EmbeddingProvider) : null;
  }

  private get embeddingService(): EmbeddingProvider {
    if (!this._embeddingService) this._embeddingService = selectEmbeddingProvider('docs');
    return this._embeddingService;
  }

  /**
   * Store embedding for a documentation item (upsert: delete then add)
   */
  async storeEmbedding(
    doc: DocVectorRecord,
    embedding: Float32Array,
    producedBy?: EmbeddingProvider,
  ): Promise<void> {
    const table = await getDocsLanceTable();

    // Delete existing record if any
    try {
      await table.delete(`doc_id = '${escSql(doc.docId)}'`);
    } catch { /* ignore if not exists */ }

    await table.add([{
      doc_id: doc.docId,
      vector: Array.from(embedding),
      pod: doc.pod,
      doc_type: doc.docType,
      title: doc.title,
      url: doc.url,
      instance_id: doc.instanceId ?? 0,
      language: doc.language ?? '',
      ...stampOf(producedBy ?? this.embeddingService),
      created_at: new Date().toISOString(),
    }]);
  }

  /**
   * Store embeddings for multiple docs (batched)
   */
  async storeEmbeddings(
    items: Array<{ doc: DocVectorRecord; embedding: Float32Array }>,
    producedBy?: EmbeddingProvider,
  ): Promise<number> {
    const table = await getDocsLanceTable();
    let stored = 0;
    const stamp = stampOf(producedBy ?? this.embeddingService);

    const batchSize = 100;
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const records: Array<Record<string, unknown>> = [];
      const deleteIds: string[] = [];

      for (const item of batch) {
        deleteIds.push(item.doc.docId);
        records.push({
          doc_id: item.doc.docId,
          vector: Array.from(item.embedding),
          pod: item.doc.pod,
          doc_type: item.doc.docType,
          title: item.doc.title,
          url: item.doc.url,
          instance_id: item.doc.instanceId ?? 0,
          language: item.doc.language ?? '',
          ...stamp,
          created_at: new Date().toISOString(),
        });
      }

      if (records.length === 0) continue;

      // Delete existing records
      if (deleteIds.length > 0) {
        const idList = deleteIds.map(id => `'${escSql(id)}'`).join(', ');
        try {
          await table.delete(`doc_id IN (${idList})`);
        } catch { /* ignore */ }
      }

      await table.add(records);
      stored += records.length;
    }

    logger.debug(`Stored ${stored} doc embeddings`);
    return stored;
  }

  /**
   * Search for similar documentation using vector similarity
   */
  async search(
    queryEmbedding: Float32Array,
    options: DocSearchOptions = {}
  ): Promise<DocSearchResult[]> {
    const { pod, docType, instanceId, language, limit = 10, minScore = 0.5 } = options;

    const table = await getDocsLanceTable();

    const rowCount = await table.countRows();
    if (rowCount === 0) return [];

    let query = table.vectorSearch(Array.from(queryEmbedding))
      .distanceType('cosine')
      .select(['doc_id', 'pod', 'doc_type', 'title', 'url'])
      .limit(limit * 2);

    const filters: string[] = [];
    if (pod) filters.push(`pod = '${escSql(pod)}'`);
    if (docType) filters.push(`doc_type = '${escSql(docType)}'`);
    if (instanceId !== undefined) filters.push(`instance_id = ${instanceId}`);
    if (language) filters.push(`language = '${escSql(language)}'`);

    if (filters.length > 0) {
      query = query.where(filters.join(' AND '));
    }

    const rawResults = await query.toArray();

    const results: DocSearchResult[] = [];
    for (const row of rawResults) {
      const distance: number = row._distance ?? 0;
      const score = 1 - distance;

      if (score >= minScore) {
        results.push({
          docId: row.doc_id,
          pod: row.pod,
          docType: row.doc_type,
          title: row.title,
          url: row.url,
          score,
          distance,
        });
      }
    }

    return results.slice(0, limit);
  }

  /**
   * Search docs by text query.
   *
   * Goes through `selectQueryEmbeddingProvider`, NOT `this.embeddingService`.
   * That getter is the single-pick selector, which never constructs a cloud
   * provider: under "OpenRouter only" it would encode the query on the local
   * Q4_K_M model against a table built entirely from full-precision cloud
   * vectors — the measured 0.976 mismatch, applied to every docs search, with
   * no error to attribute it to. The code path was fixed for exactly this
   * reason (`vectorStore.searchByText`); this is the docs half.
   *
   * Under the three GPU-serving policies the selector resolves to the same
   * local provider the getter would have returned, so nothing changes there.
   */
  async searchByText(
    query: string,
    options: DocSearchOptions = {}
  ): Promise<DocSearchResult[]> {
    const { selectQueryEmbeddingProvider } = await import('./providers/embeddingProvider.js');
    const provider = await selectQueryEmbeddingProvider('docs');
    await provider.initialize();
    // Query-side instruction for instruction-tuned models (Qwen3-Embedding);
    // stored doc vectors are raw, so no re-embed is needed.
    const { applyQueryInstruction } = await import('./queryInstruction.js');
    const queryText = applyQueryInstruction(query, provider.getModelName(), 'docs');
    const queryEmbedding = await provider.embed(queryText);
    return this.search(queryEmbedding, options);
  }

  /**
   * Count total doc vectors stored
   */
  async count(pod?: string): Promise<number> {
    const table = await getDocsLanceTable();
    if (pod) {
      return table.countRows(`pod = '${escSql(pod)}'`);
    }
    return table.countRows();
  }

  /**
   * Delete all vectors for a pod
   */
  async deletePodVectors(pod: string): Promise<number> {
    const table = await getDocsLanceTable();
    const countBefore = await table.countRows(`pod = '${escSql(pod)}'`);
    if (countBefore > 0) {
      await table.delete(`pod = '${escSql(pod)}'`);
    }
    return countBefore;
  }

  /**
   * Delete all vectors for an instance
   */
  async deleteInstanceVectors(instanceId: number): Promise<number> {
    const table = await getDocsLanceTable();
    const countBefore = await table.countRows(`instance_id = ${instanceId}`);
    if (countBefore > 0) {
      await table.delete(`instance_id = ${instanceId}`);
    }
    return countBefore;
  }

  /**
   * Delete a single doc vector
   */
  async deleteEmbedding(docId: string): Promise<void> {
    const table = await getDocsLanceTable();
    try {
      await table.delete(`doc_id = '${escSql(docId)}'`);
    } catch { /* ignore if not exists */ }
  }

  /**
   * Get all doc IDs that have vectors for an instance (for incremental embedding)
   */
  async getInstanceDocIds(instanceId: number): Promise<Set<string>> {
    const table = await getDocsLanceTable();
    const rows = await table.query()
      .select(['doc_id'])
      .where(`instance_id = ${instanceId}`)
      .toArray();
    return new Set(rows.map((r: Record<string, unknown>) => r.doc_id as string));
  }

  /**
   * Get vector counts grouped by pod
   */
  async countByPod(): Promise<Map<string, number>> {
    const table = await getDocsLanceTable();
    const rows = await table.query()
      .select(['pod'])
      .toArray();

    const counts = new Map<string, number>();
    for (const row of rows) {
      const p = row.pod as string;
      counts.set(p, (counts.get(p) || 0) + 1);
    }
    return counts;
  }

  /**
   * Get the embedding service (for external use)
   */
  getEmbeddingService(): EmbeddingProvider {
    return this.embeddingService;
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

let docsStoreInstance: DocsVectorStore | null = null;

/**
 * Get or create the docs vector store singleton
 */
export function getDocsVectorStore(): DocsVectorStore {
  if (!docsStoreInstance) {
    docsStoreInstance = new DocsVectorStore();
  }
  return docsStoreInstance;
}

/**
 * Reset the docs vector store (for testing)
 */
export function resetDocsVectorStore(): void {
  docsStoreInstance = null;
}
