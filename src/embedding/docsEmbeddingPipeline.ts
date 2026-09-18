/**
 * Docs Embedding Pipeline
 *
 * Converts cached LocalDocItem[] into vector embeddings stored in the
 * docs_vectors LanceDB table via DocsVectorStore.
 *
 * Features:
 * - Incremental: skips docs that already have vectors (unless forceRefresh)
 * - Background jobs: runs async with progress tracking
 * - Progress reporting: tracks per-instance and overall progress
 */

import { createLogger } from '../utils/index.js';
/**
 * The provider for docs WRITES, resolved against the routing policy.
 *
 * Kept next to its one caller rather than in embeddingProvider.ts because it
 * is a single-writer pick, not a fan-out: the docs pipeline embeds one batch
 * at a time into one table, so it wants the anchor provider, not a pool. The
 * anchor is the provider every other cloud one was verified against, so it is
 * the one the table's existing cloud rows agree with.
 */
async function selectDocsWriteProvider() {
  const { selectQueryEmbeddingProvider } = await import('./providers/embeddingProvider.js');
  return selectQueryEmbeddingProvider('docs');
}
import { getDocsVectorStore, type DocVectorRecord } from './docsVectorStore.js';
import { loadCachedDocs } from '../parser/local/localDocsParser.js';
import type { LocalDocItem } from '../parser/local/types.js';

const logger = createLogger('docs-embedding-pipeline');

// ============================================
// Types
// ============================================

export interface EmbedDocsOptions {
  forceRefresh?: boolean;
  batchSize?: number;
}

export interface EmbedDocsResult {
  instanceId: number;
  totalItems: number;
  embedded: number;
  skipped: number;
  alreadyExists: number;
  duration: number;
  error?: string;
}

export interface EmbedJobProgress {
  jobId: string;
  status: 'running' | 'completed' | 'error';
  startedAt: number;
  completedAt?: number;
  currentInstance?: number;
  instancesTotal: number;
  instancesDone: number;
  totalEmbedded: number;
  totalSkipped: number;
  totalAlreadyExists: number;
  totalItems: number;
  processedItems: number;
  results: EmbedDocsResult[];
  error?: string;
}

// In-memory job store (jobs are ephemeral, cleared on restart)
const activeJobs = new Map<string, EmbedJobProgress>();

// ============================================
// Job Management
// ============================================

export function getEmbedJobProgress(jobId: string): EmbedJobProgress | null {
  return activeJobs.get(jobId) || null;
}

export function getActiveEmbedJob(): EmbedJobProgress | null {
  for (const job of activeJobs.values()) {
    if (job.status === 'running') return job;
  }
  return null;
}

function generateJobId(): string {
  return `embed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================
// Embedding Text Builder
// ============================================

/**
 * Build the text to embed for a doc item.
 * Combines qualifiedName + signature + description (truncated) + keywords
 * to give the embedding model rich semantic context.
 */
export function buildDocEmbeddingText(item: LocalDocItem): string {
  const parts: string[] = [];

  // Qualified name provides structural context (e.g. "sys::Bool")
  if (item.qualifiedName) {
    parts.push(item.qualifiedName);
  }

  // Signature captures API shape
  if (item.signature) {
    parts.push(item.signature);
  }

  // Description provides semantic meaning (truncated to 300 chars)
  if (item.description) {
    const desc = item.description.substring(0, 300);
    parts.push(desc);
  }

  // Keywords for additional context
  if (item.keywords && item.keywords.length > 0) {
    parts.push(item.keywords.join(' '));
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

// ============================================
// Instance Embedding
// ============================================

/**
 * Embed documentation for a single instance.
 * Incremental by default: skips docs that already have vectors.
 * Set forceRefresh=true to delete and re-embed everything.
 */
export async function embedInstanceDocs(
  instanceId: number,
  options: EmbedDocsOptions = {},
  progressCallback?: (processed: number, total: number) => void
): Promise<EmbedDocsResult> {
  const startTime = Date.now();
  const { forceRefresh = false, batchSize = 50 } = options;

  logger.info(`Embedding docs for instance ${instanceId} (forceRefresh=${forceRefresh})`);

  // Load cached docs
  const items = loadCachedDocs(instanceId);
  if (!items || items.length === 0) {
    return {
      instanceId,
      totalItems: 0,
      embedded: 0,
      skipped: 0,
      alreadyExists: 0,
      duration: Date.now() - startTime,
      error: 'No cached docs found. Index docs first with POST /admin/instances/:id/docs/index'
    };
  }

  const store = getDocsVectorStore();
  // The provider that WRITES the docs table has to obey the routing policy,
  // not just the one that queries it. `selectEmbeddingProvider` never
  // constructs a cloud provider, so under "OpenRouter only" this loop would
  // have gone on writing local Q4_K_M vectors into a table the query encoder
  // now searches with a full-precision cloud vector — one local row in a
  // cloud-built index is precisely the poisoning the policy exists to prevent,
  // and it is invisible because nothing errors.
  //
  // Under the three GPU-serving policies this resolves to the same local
  // provider as before. Under "OpenRouter only" it resolves to the verified
  // cloud pool, or throws `CloudOnlyUnavailableError` with a named reason —
  // which is the correct outcome: refusing to build is better than building
  // something unusable.
  const embeddingService = await selectDocsWriteProvider();

  // If force refresh, delete existing vectors for this instance
  if (forceRefresh) {
    const deleted = await store.deleteInstanceVectors(instanceId);
    if (deleted > 0) {
      logger.info(`Deleted ${deleted} existing vectors for instance ${instanceId}`);
    }
  }

  // Get existing doc IDs for incremental embedding
  let existingDocIds = new Set<string>();
  if (!forceRefresh) {
    existingDocIds = await store.getInstanceDocIds(instanceId);
    logger.info(`Instance ${instanceId}: ${existingDocIds.size} vectors already exist, ${items.length} total docs`);
  }

  // Initialize embedding service
  await embeddingService.initialize();

  let embedded = 0;
  let skipped = 0;
  let alreadyExists = 0;
  let processed = 0;

  // Process in batches
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);

    // Build texts for the batch, skipping existing vectors
    const texts: string[] = [];
    const validItems: LocalDocItem[] = [];

    for (const item of batch) {
      // Skip if vector already exists (incremental)
      if (existingDocIds.has(item.id)) {
        alreadyExists++;
        processed++;
        continue;
      }

      const text = buildDocEmbeddingText(item);
      if (text.length < 5) {
        skipped++;
        processed++;
        continue;
      }
      texts.push(text);
      validItems.push(item);
    }

    if (texts.length === 0) {
      progressCallback?.(processed, items.length);
      continue;
    }

    // Generate embeddings for the batch
    const embeddings = await embeddingService.embedBatch(texts);

    // Build records for storage
    const records: Array<{ doc: DocVectorRecord; embedding: Float32Array }> = [];
    for (let j = 0; j < validItems.length; j++) {
      const item = validItems[j];
      records.push({
        doc: {
          docId: item.id,
          pod: item.pod,
          docType: item.type,
          title: item.name,
          url: item.url,
          instanceId: item.instanceId,
          language: item.language
        },
        embedding: embeddings[j]
      });
    }

    // Store in LanceDB, labelled with the provider that actually produced
    // these vectors — which under "OpenRouter only" is not the local one the
    // store would otherwise name.
    const stored = await store.storeEmbeddings(records, embeddingService);
    embedded += stored;
    processed += validItems.length;

    progressCallback?.(processed, items.length);

    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(items.length / batchSize);
    logger.debug(`Instance ${instanceId} batch ${batchNum}/${totalBatches}: embedded ${stored}, skipped ${alreadyExists} existing`);
  }

  const duration = Date.now() - startTime;
  logger.info(`Instance ${instanceId}: embedded ${embedded} new, ${alreadyExists} already existed, ${skipped} skipped (${duration}ms)`);

  return {
    instanceId,
    totalItems: items.length,
    embedded,
    skipped,
    alreadyExists,
    duration
  };
}

// ============================================
// All Instances Embedding (Synchronous)
// ============================================

/**
 * Embed documentation for all instances that have cached docs.
 */
export async function embedAllInstanceDocs(
  options: EmbedDocsOptions = {}
): Promise<{
  results: EmbedDocsResult[];
  totalEmbedded: number;
  totalDuration: number;
}> {
  const startTime = Date.now();
  const results: EmbedDocsResult[] = [];
  let totalEmbedded = 0;

  // Dynamically import to avoid circular dependencies
  const { getFantomDatabase } = await import('../fantom/database.js');
  const db = getFantomDatabase();
  await db.initialize();
  const instances = await db.getAllInstances();

  for (const instance of instances) {
    try {
      const result = await embedInstanceDocs(instance.id, options);
      results.push(result);
      totalEmbedded += result.embedded;
    } catch (error) {
      results.push({
        instanceId: instance.id,
        totalItems: 0,
        embedded: 0,
        skipped: 0,
        alreadyExists: 0,
        duration: 0,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    results,
    totalEmbedded,
    totalDuration: Date.now() - startTime
  };
}

// ============================================
// Background Job (Non-blocking)
// ============================================

/**
 * Start embedding all docs in the background.
 * Returns immediately with a jobId. Poll getEmbedJobProgress(jobId) for status.
 */
export function startEmbedAllBackground(
  options: EmbedDocsOptions = {}
): string {
  // Check if a job is already running
  const existing = getActiveEmbedJob();
  if (existing) {
    return existing.jobId;
  }

  const jobId = generateJobId();

  const progress: EmbedJobProgress = {
    jobId,
    status: 'running',
    startedAt: Date.now(),
    instancesTotal: 0,
    instancesDone: 0,
    totalEmbedded: 0,
    totalSkipped: 0,
    totalAlreadyExists: 0,
    totalItems: 0,
    processedItems: 0,
    results: [],
  };

  activeJobs.set(jobId, progress);

  // Run in background (fire-and-forget)
  runEmbedJob(jobId, options).catch(err => {
    logger.error(`Embed job ${jobId} failed: ${err}`);
    const job = activeJobs.get(jobId);
    if (job) {
      job.status = 'error';
      job.error = err instanceof Error ? err.message : String(err);
      job.completedAt = Date.now();
    }
  });

  return jobId;
}

async function runEmbedJob(jobId: string, options: EmbedDocsOptions): Promise<void> {
  const progress = activeJobs.get(jobId)!;

  const { getFantomDatabase } = await import('../fantom/database.js');
  const db = getFantomDatabase();
  await db.initialize();
  const instances = await db.getAllInstances();

  progress.instancesTotal = instances.length;

  // Count total items across all instances
  for (const instance of instances) {
    const items = loadCachedDocs(instance.id);
    progress.totalItems += items?.length || 0;
  }

  for (const instance of instances) {
    progress.currentInstance = instance.id;

    try {
      const result = await embedInstanceDocs(instance.id, options, (processed, _total) => {
        // Update progress on each batch
        const job = activeJobs.get(jobId);
        if (job) {
          // Recalculate processedItems from completed instances + current progress
          const completedItems = job.results.reduce((sum, r) => sum + r.totalItems, 0);
          job.processedItems = completedItems + processed;
        }
      });

      progress.results.push(result);
      progress.instancesDone++;
      progress.totalEmbedded += result.embedded;
      progress.totalSkipped += result.skipped;
      progress.totalAlreadyExists += result.alreadyExists;
      // Update processedItems to include this completed instance
      progress.processedItems = progress.results.reduce((sum, r) => sum + r.totalItems, 0);
    } catch (error) {
      const errResult: EmbedDocsResult = {
        instanceId: instance.id,
        totalItems: 0,
        embedded: 0,
        skipped: 0,
        alreadyExists: 0,
        duration: 0,
        error: error instanceof Error ? error.message : String(error)
      };
      progress.results.push(errResult);
      progress.instancesDone++;
    }
  }

  progress.status = 'completed';
  progress.completedAt = Date.now();
  progress.currentInstance = undefined;

  logger.info(`Embed job ${jobId} completed: ${progress.totalEmbedded} new vectors, ${progress.totalAlreadyExists} already existed`);

  // Clean up old jobs after 10 minutes
  setTimeout(() => activeJobs.delete(jobId), 10 * 60 * 1000);
}
