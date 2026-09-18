/**
 * Embedding Module - Local vector embeddings for semantic search
 *
 * Uses @huggingface/transformers (transformers.js) for 100% local inference.
 * No external API calls required.
 */

export {
  EmbeddingService,
  getEmbeddingService,
  getDocsEmbeddingService,
  resetEmbeddingService,
  DEFAULT_MODEL,
  DEFAULT_DIMENSIONS,
  DEFAULT_DOCS_MODEL,
  DEFAULT_DOCS_DIMENSIONS
} from './embeddingService.js';

export type {
  VectorSearchResult,
  VectorSearchOptions
} from './vectorStore.js';

export {
  VectorStore,
  getVectorStore,
  resetVectorStore
} from './vectorStore.js';

export type {
  DocVectorRecord,
  DocSearchResult,
  DocSearchOptions
} from './docsVectorStore.js';

export {
  DocsVectorStore,
  getDocsVectorStore,
  resetDocsVectorStore
} from './docsVectorStore.js';

export type {
  SemanticSearchResult,
  SemanticSearchOptions
} from './semanticSearchService.js';

export {
  SemanticSearchService,
  getSemanticSearchService,
  resetSemanticSearchService
} from './semanticSearchService.js';

export {
  getLanceConnection,
  getLanceTable,
  getDocsLanceTable,
  getLanceTableStats,
  closeLanceConnection,
  resetLanceTable
} from './lanceConnection.js';

export type {
  EmbedDocsOptions,
  EmbedDocsResult
} from './docsEmbeddingPipeline.js';

export {
  embedInstanceDocs,
  embedAllInstanceDocs,
  buildDocEmbeddingText
} from './docsEmbeddingPipeline.js';
