/**
 * Embedding Service - Local embeddings using @huggingface/transformers
 *
 * This service runs entirely locally with no external API calls.
 * It uses the transformers.js library to generate embeddings for:
 * - Code snippets and signatures
 * - Documentation text
 * - Search queries
 *
 * Default model: all-MiniLM-L6-v2 (384 dimensions)
 */

import { createLogger } from '../utils/index.js';

const logger = createLogger('embedding-service');

// Type definitions for transformers.js
// We use dynamic imports to avoid issues if the package isn't installed
type Pipeline = (texts: string[], options?: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array }>;

// ============================================
// Constants
// ============================================

export const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const DEFAULT_DIMENSIONS = 384;

// Text preprocessing limits
const MAX_TOKENS = 256;  // MiniLM has 256 token limit
const ESTIMATED_CHARS_PER_TOKEN = 4;
const MAX_CHARS = MAX_TOKENS * ESTIMATED_CHARS_PER_TOKEN;

// ============================================
// Embedding Service Class
// ============================================

export class EmbeddingService {
  private pipeline: Pipeline | null = null;
  private modelName: string;
  private dimensions: number;
  private threads: number;
  private batchSize: number;
  private initPromise: Promise<void> | null = null;

  constructor(modelName: string = DEFAULT_MODEL, dimensions: number = DEFAULT_DIMENSIONS, options?: { threads?: number; batchSize?: number }) {
    this.modelName = modelName;
    this.dimensions = dimensions;
    this.threads = options?.threads ?? parseInt(process.env.EMBEDDING_THREADS || '2', 10);
    this.batchSize = options?.batchSize ?? parseInt(process.env.EMBEDDING_BATCH_SIZE || '16', 10);
  }

  /**
   * Initialize the embedding pipeline
   * Lazy initialization - only loads model when first needed
   */
  async initialize(): Promise<void> {
    if (this.pipeline) return;

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize();
    await this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    logger.info(`Loading embedding model: ${this.modelName}`);

    try {
      // Dynamic import of transformers
      const { pipeline, env } = await import('@huggingface/transformers');
      const { MODELS_DIR } = await import('./modelManager.js');

      // Use persistent cache dir (survives npm install)
      env.cacheDir = MODELS_DIR;

      // Limit ONNX threads to avoid 500% CPU spikes
      // onnxruntime-node uses native OpenMP — controlled via OMP_NUM_THREADS
      // Must be set before first ONNX session is created
      if (!process.env.OMP_NUM_THREADS) {
        process.env.OMP_NUM_THREADS = String(this.threads);
      }
      logger.info(`ONNX threads: ${process.env.OMP_NUM_THREADS} (OMP_NUM_THREADS), batch size: ${this.batchSize}`);

      // Create feature extraction pipeline
      this.pipeline = await pipeline('feature-extraction', this.modelName, {
        dtype: 'q8',  // Use quantized model for faster inference
        cache_dir: MODELS_DIR,
      } as any) as unknown as Pipeline;

      logger.info(`Embedding model loaded successfully`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to load embedding model: ${errMsg}`);
      throw new Error(`Embedding service initialization failed: ${errMsg}`);
    }
  }

  /**
   * Generate embedding for a single text
   */
  async embed(text: string): Promise<Float32Array> {
    await this.initialize();

    if (!this.pipeline) {
      throw new Error('Embedding pipeline not initialized');
    }

    // Preprocess and truncate text
    const processedText = this.preprocessText(text);

    // Generate embedding
    const output = await this.pipeline([processedText], {
      pooling: 'mean',
      normalize: true
    });

    return new Float32Array(output.data);
  }

  /**
   * Generate embeddings for multiple texts (batched)
   */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    await this.initialize();

    if (!this.pipeline) {
      throw new Error('Embedding pipeline not initialized');
    }

    // Preprocess all texts
    const processedTexts = texts.map(t => this.preprocessText(t));

    const batchSize = this.batchSize;
    const embeddings: Float32Array[] = [];

    for (let i = 0; i < processedTexts.length; i += batchSize) {
      const batch = processedTexts.slice(i, i + batchSize);

      const output = await this.pipeline(batch, {
        pooling: 'mean',
        normalize: true
      });

      // Split the flattened output into individual embeddings
      const data = output.data;
      for (let j = 0; j < batch.length; j++) {
        const start = j * this.dimensions;
        const embedding = new Float32Array(data.slice(start, start + this.dimensions));
        embeddings.push(embedding);
      }
    }

    return embeddings;
  }

  /**
   * Generate embedding for code (with code-specific preprocessing)
   */
  async embedCode(code: string, context?: {
    signature?: string;
    className?: string;
    documentation?: string;
  }): Promise<Float32Array> {
    // Build enriched text from code and context
    let text = '';

    if (context?.className) {
      text += `class ${context.className}: `;
    }

    if (context?.signature) {
      text += context.signature + ' ';
    }

    if (context?.documentation) {
      // Add first sentence of documentation
      const firstSentence = context.documentation.split(/[.!?]/)[0];
      text += firstSentence + ' ';
    }

    // Add code snippet (truncated)
    text += this.truncateCode(code);

    return this.embed(text);
  }

  /**
   * Preprocess text for embedding
   */
  private preprocessText(text: string): string {
    if (!text) return '';

    // Normalize whitespace
    let processed = text.replace(/\s+/g, ' ').trim();

    // Truncate to max length
    if (processed.length > MAX_CHARS) {
      processed = processed.substring(0, MAX_CHARS);
    }

    return processed;
  }

  /**
   * Truncate code for embedding while preserving structure
   */
  private truncateCode(code: string): string {
    if (!code) return '';

    // Remove comments
    let processed = code.replace(/\/\/.*$/gm, '');
    processed = processed.replace(/\/\*[\s\S]*?\*\//g, '');

    // Normalize whitespace
    processed = processed.replace(/\s+/g, ' ').trim();

    // Truncate
    if (processed.length > MAX_CHARS / 2) {
      processed = processed.substring(0, MAX_CHARS / 2);
    }

    return processed;
  }

  /**
   * Calculate cosine similarity between two embeddings
   */
  cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
      throw new Error(`Embedding dimension mismatch: ${a.length} vs ${b.length}`);
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    if (magnitude === 0) return 0;

    return dotProduct / magnitude;
  }

  /**
   * Convert Float32Array to Buffer for storage
   */
  embeddingToBuffer(embedding: Float32Array): Buffer {
    return Buffer.from(embedding.buffer);
  }

  /**
   * Convert Buffer back to Float32Array
   */
  bufferToEmbedding(buffer: Buffer): Float32Array {
    return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
  }

  /**
   * Get the model name
   */
  getModelName(): string {
    return this.modelName;
  }

  /**
   * Get the embedding dimensions
   */
  getDimensions(): number {
    return this.dimensions;
  }

  /**
   * Check if the service is initialized
   */
  isReady(): boolean {
    return this.pipeline !== null;
  }
}

// ============================================
// Factory Functions
// ============================================

// Defaults for docs embedding (larger model, higher dimensions)
export const DEFAULT_DOCS_MODEL = 'Xenova/jina-embeddings-v2-base-en';
export const DEFAULT_DOCS_DIMENSIONS = 768;

let serviceInstance: EmbeddingService | null = null;
let docsServiceInstance: EmbeddingService | null = null;

/**
 * Read semanticSearch config from config file (if available)
 */
function readSemanticConfig(): Record<string, any> {
  try {
    const fs = require('fs');
    const path = require('path');
    const configPath = path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return config.semanticSearch || {};
    }
  } catch { /* ignore */ }
  return {};
}

/**
 * Get or create the code embedding service singleton
 * Reads model/dimensions from config file or env vars
 */
export function getEmbeddingService(): EmbeddingService {
  if (!serviceInstance) {
    const cfg = readSemanticConfig();
    const model = process.env.EMBEDDING_MODEL || cfg.codeModel || undefined;
    const dims = process.env.EMBEDDING_DIMENSIONS ? parseInt(process.env.EMBEDDING_DIMENSIONS) : cfg.codeDimensions || undefined;
    const threads = process.env.EMBEDDING_THREADS ? parseInt(process.env.EMBEDDING_THREADS) : cfg.embeddingThreads || 2;
    const batchSize = process.env.EMBEDDING_BATCH_SIZE ? parseInt(process.env.EMBEDDING_BATCH_SIZE) : cfg.embeddingBatchSize || 16;
    serviceInstance = new EmbeddingService(model, dims, { threads, batchSize });
  }
  return serviceInstance;
}

/**
 * Get or create the docs embedding service singleton
 * Uses a separate, larger model for documentation embeddings
 */
export function getDocsEmbeddingService(): EmbeddingService {
  if (!docsServiceInstance) {
    const cfg = readSemanticConfig();
    const model = process.env.DOCS_EMBEDDING_MODEL || cfg.docsModel || DEFAULT_DOCS_MODEL;
    const dims = process.env.DOCS_EMBEDDING_DIMENSIONS ? parseInt(process.env.DOCS_EMBEDDING_DIMENSIONS) : cfg.docsDimensions || DEFAULT_DOCS_DIMENSIONS;
    const threads = process.env.EMBEDDING_THREADS ? parseInt(process.env.EMBEDDING_THREADS) : cfg.embeddingThreads || 2;
    const batchSize = process.env.EMBEDDING_BATCH_SIZE ? parseInt(process.env.EMBEDDING_BATCH_SIZE) : cfg.embeddingBatchSize || 16;
    docsServiceInstance = new EmbeddingService(model, dims, { threads, batchSize });
  }
  return docsServiceInstance;
}

/**
 * Reset the embedding service (for testing)
 */
export function resetEmbeddingService(): void {
  serviceInstance = null;
  docsServiceInstance = null;
}
