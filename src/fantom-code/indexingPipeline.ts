/**
 * Indexing Pipeline Orchestrator
 *
 * Manages the full indexing lifecycle with:
 * - Named stages with progress tracking
 * - Per-project concurrency locks
 * - Stage-level checkpoints
 * - Cancellation support
 * - Stage timing diagnostics
 */

import type { PrismaClient } from '@prisma/client';
import { createLogger } from '../utils/index.js';
import { CodeIndexingService } from './codeIndexingService.js';
import { checkStaleness } from '../graph/stalenessChecker.js';
import { getOrDetectCommunities, clearCommunityCache } from '../graph/communityDetection.js';
import { getOrTraceProcessFlows, clearProcessCache } from '../graph/processTracer.js';
import { getSemanticSearchService } from '../embedding/semanticSearchService.js';
import { isLadybugInitialized } from '../graph/ladybugConnection.js';
import { EventEmitter } from 'events';

const logger = createLogger('indexing-pipeline');

// ============================================
// Types
// ============================================

export type PipelineStage =
  | 'discovery'
  | 'parsing'
  | 'graph-building'
  | 'community-detection'
  | 'process-tracing'
  | 'embedding-generation'
  | 'vector-indexing'
  | 'verification'
  | 'complete';

export interface StageProgress {
  stage: PipelineStage;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
  message?: string;
  itemsProcessed?: number;
  itemsTotal?: number;
}

export interface PipelineProgress {
  projectId: number;
  projectName: string;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
  currentStage: PipelineStage | null;
  stages: StageProgress[];
  startedAt?: Date;
  completedAt?: Date;
  totalDurationMs?: number;
  error?: string;
}

export interface PipelineOptions {
  skipIfFresh?: boolean;       // Skip if staleness check says 'fresh'
  skipEmbeddings?: boolean;    // Skip embedding generation
  skipCommunities?: boolean;   // Skip community detection
  skipProcessTracing?: boolean; // Skip process flow tracing
  projectPath?: string;        // Override project path
}

// ============================================
// Stage definitions
// ============================================

const ALL_STAGES: PipelineStage[] = [
  'discovery',
  'parsing',
  'graph-building',
  'community-detection',
  'process-tracing',
  'embedding-generation',
  'vector-indexing',
  'verification',
  'complete'
];

// ============================================
// Indexing Pipeline
// ============================================

// Per-project locks
const projectLocks = new Map<number, Promise<PipelineProgress>>();

// Active stop flags
const stopFlags = new Map<number, boolean>();

// Pipeline event emitter for SSE progress
export const pipelineEvents = new EventEmitter();

// Most recent progress snapshot per project. Lets first-paint of the dashboard
// resolve to the live state without waiting for the next SSE event.
const latestProgressByProject = new Map<number, PipelineProgress>();
pipelineEvents.on('progress', (p: PipelineProgress) => {
  if (p && typeof p.projectId === 'number') {
    latestProgressByProject.set(p.projectId, p);
  }
});

export class IndexingPipeline {
  private prisma: PrismaClient;
  private indexingService: CodeIndexingService;
  private progress: PipelineProgress;

  constructor(prisma: PrismaClient, indexingService: CodeIndexingService, projectId: number, projectName: string) {
    this.prisma = prisma;
    this.indexingService = indexingService;
    this.progress = {
      projectId,
      projectName,
      status: 'idle',
      currentStage: null,
      stages: ALL_STAGES.map(stage => ({
        stage,
        status: 'pending' as const,
      }))
    };
  }

  /**
   * Run the full indexing pipeline.
   * Respects per-project locks to prevent concurrent runs.
   */
  async run(options: PipelineOptions = {}): Promise<PipelineProgress> {
    const projectId = this.progress.projectId;

    // Check for existing lock
    if (projectLocks.has(projectId)) {
      logger.warn(`Pipeline already running for project ${projectId}`);
      return this.progress;
    }

    // Set lock
    const runPromise = this.executeStages(options);
    projectLocks.set(projectId, runPromise);

    try {
      return await runPromise;
    } finally {
      projectLocks.delete(projectId);
      stopFlags.delete(projectId);
    }
  }

  private async executeStages(options: PipelineOptions): Promise<PipelineProgress> {
    const projectId = this.progress.projectId;
    this.progress.status = 'running';
    this.progress.startedAt = new Date();
    this.emitProgress();

    try {
      // Stage 1: Discovery (staleness check)
      await this.runStage('discovery', async () => {
        if (options.skipIfFresh) {
          const staleness = await checkStaleness(this.prisma, projectId, options.projectPath);
          if (staleness.status === 'fresh') {
            return { message: 'Index is fresh, skipping reindex', skip: true };
          }
          return { message: `Index is ${staleness.status}, ${staleness.changedFileCount} files changed` };
        }
        return { message: 'Staleness check skipped, proceeding with full index' };
      });

      // Check if discovery said to skip
      const discoveryStage = this.getStage('discovery');
      if (discoveryStage?.message?.includes('skipping reindex')) {
        this.skipRemainingStages('discovery');
        this.progress.status = 'completed';
        this.progress.completedAt = new Date();
        this.progress.totalDurationMs = Date.now() - this.progress.startedAt!.getTime();
        this.emitProgress();
        return this.progress;
      }

      if (this.shouldStop(projectId)) return this.cancelled();

      // Stages 2 + 3: Parsing + Graph Building, driven by rebuildGraph callbacks
      // so the bar advances per-file rather than 0 → 100 at completion.
      await this.runParsingAndGraphBuilding(projectId);

      if (this.shouldStop(projectId)) return this.cancelled();

      // Stage 4: Community Detection
      if (options.skipCommunities) {
        this.markSkipped('community-detection');
      } else {
        await this.runStage('community-detection', async () => {
          const useLB = await isLadybugInitialized();
          if (!useLB) return { message: 'Skipped (LadybugDB not available)' };
          clearCommunityCache(projectId);
          const result = await getOrDetectCommunities(projectId);
          return { message: `${result.communityCount} communities detected (modularity: ${result.modularity.toFixed(3)})` };
        });
      }

      if (this.shouldStop(projectId)) return this.cancelled();

      // Stage 5: Process Tracing
      if (options.skipProcessTracing) {
        this.markSkipped('process-tracing');
      } else {
        await this.runStage('process-tracing', async () => {
          const useLB = await isLadybugInitialized();
          if (!useLB) return { message: 'Skipped (LadybugDB not available)' };
          clearProcessCache(projectId);
          const result = await getOrTraceProcessFlows(projectId);
          return { message: `${result.processCount} processes from ${result.entryPointCount} entry points` };
        });
      }

      if (this.shouldStop(projectId)) return this.cancelled();

      // Stage 6 + 7: Embedding Generation + Vector Indexing
      if (options.skipEmbeddings) {
        this.markSkipped('embedding-generation');
        this.markSkipped('vector-indexing');
      } else {
        await this.runStage('embedding-generation', async () => {
          const semanticSearch = getSemanticSearchService(this.prisma);
          const result = await semanticSearch.buildProjectEmbeddings(projectId);
          return { message: `${result.processed} embeddings generated, ${result.errors} errors` };
        });

        await this.runStage('vector-indexing', async () => {
          return { message: 'Vector indexing completed during embedding generation' };
        });
      }

      if (this.shouldStop(projectId)) return this.cancelled();

      // Stage 8: Verification — count nodes/edges directly in Ladybug.
      await this.runStage('verification', async () => {
        const { ladybugQuery } = await import('../graph/ladybugConnection.js');
        const [nc, ec] = await Promise.all([
          ladybugQuery<{ c: number }>(projectId, `MATCH (n:CodeNode {project_id: ${projectId}}) RETURN count(n) AS c`
          ),
          ladybugQuery<{ c: number }>(projectId, `MATCH (n:CodeNode {project_id: ${projectId}})-[e:CodeEdge]->() RETURN count(e) AS c`
          ),
        ]);
        const nodeCount = Number(nc[0]?.c ?? 0);
        const edgeCount = Number(ec[0]?.c ?? 0);
        if (nodeCount === 0 && edgeCount === 0) return { message: 'No build stats found' };
        return { message: `Verified: ${nodeCount} nodes, ${edgeCount} edges` };
      });

      // Stage 9: Complete
      await this.runStage('complete', async () => {
        return { message: 'Pipeline completed successfully' };
      });

      this.progress.status = 'completed';
      this.progress.completedAt = new Date();
      this.progress.totalDurationMs = Date.now() - this.progress.startedAt!.getTime();
      this.emitProgress();

      logger.info(`Pipeline completed for project ${projectId} in ${this.progress.totalDurationMs}ms`);
      return this.progress;

    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.progress.status = 'failed';
      this.progress.error = errMsg;
      this.progress.completedAt = new Date();
      this.progress.totalDurationMs = Date.now() - this.progress.startedAt!.getTime();
      this.emitProgress();
      logger.error(`Pipeline failed for project ${projectId}: ${errMsg}`);
      return this.progress;
    }
  }

  /**
   * Combined parsing + graph-building stage driven by rebuildGraph callbacks.
   * The single rebuildGraph call drives both stage bars: parsing advances per
   * file, then graph-building runs once parsing is done.
   */
  private async runParsingAndGraphBuilding(projectId: number): Promise<void> {
    const parsingStage = this.getStage('parsing');
    const graphStage = this.getStage('graph-building');
    if (!parsingStage || !graphStage) return;

    parsingStage.status = 'running';
    parsingStage.startedAt = new Date();
    this.progress.currentStage = 'parsing';
    this.emitProgress();

    try {
      const result = await this.indexingService.rebuildGraph(projectId, (ev) => {
        if (ev.phase === 'scanning') {
          parsingStage.message = 'Scanning files...';
          this.emitProgress();
          return;
        }
        if (ev.phase === 'parsing') {
          parsingStage.itemsTotal = ev.filesTotal;
          parsingStage.itemsProcessed = ev.filesProcessed;
          this.emitProgress();
          return;
        }
        if (ev.phase === 'graph-building') {
          // Transition: finalize parsing, start graph-building.
          if (parsingStage.status === 'running') {
            parsingStage.status = 'completed';
            parsingStage.completedAt = new Date();
            parsingStage.durationMs =
              parsingStage.completedAt.getTime() - (parsingStage.startedAt?.getTime() ?? Date.now());
            parsingStage.message = `${ev.parsedCount} files parsed`;
            graphStage.status = 'running';
            graphStage.startedAt = new Date();
            graphStage.itemsTotal = ev.parsedCount;
            graphStage.itemsProcessed = 0;
            this.progress.currentStage = 'graph-building';
          }
          if (ev.nodeCount !== undefined) {
            graphStage.itemsProcessed = ev.parsedCount;
            graphStage.message = `${ev.nodeCount} nodes, ${ev.edgeCount} edges`;
          }
          this.emitProgress();
        }
      });

      // Finalize graph-building stage.
      graphStage.status = 'completed';
      graphStage.completedAt = new Date();
      graphStage.durationMs =
        graphStage.completedAt.getTime() - (graphStage.startedAt?.getTime() ?? Date.now());
      graphStage.message = `${result.nodeCount} nodes, ${result.edgeCount} edges, ${result.unresolvedCount} unresolved`;
      graphStage.itemsProcessed = result.nodeCount + result.edgeCount;
      this.emitProgress();
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      if (parsingStage.status === 'running') {
        parsingStage.status = 'failed';
        parsingStage.completedAt = new Date();
        parsingStage.message = errMsg;
      }
      if (graphStage.status === 'running' || graphStage.status === 'pending') {
        graphStage.status = 'failed';
        graphStage.completedAt = new Date();
        graphStage.message = errMsg;
      }
      this.emitProgress();
      throw error;
    }
  }

  private async runStage(
    stage: PipelineStage,
    fn: () => Promise<{ message: string; skip?: boolean; itemsProcessed?: number; itemsTotal?: number }>
  ): Promise<void> {
    const stageProgress = this.progress.stages.find(s => s.stage === stage);
    if (!stageProgress) return;

    stageProgress.status = 'running';
    stageProgress.startedAt = new Date();
    this.progress.currentStage = stage;
    this.emitProgress();

    try {
      const result = await fn();
      stageProgress.status = result.skip ? 'skipped' : 'completed';
      stageProgress.completedAt = new Date();
      stageProgress.durationMs = stageProgress.completedAt.getTime() - stageProgress.startedAt.getTime();
      stageProgress.message = result.message;
      stageProgress.itemsProcessed = result.itemsProcessed;
      stageProgress.itemsTotal = result.itemsTotal;
      this.emitProgress();
    } catch (error) {
      stageProgress.status = 'failed';
      stageProgress.completedAt = new Date();
      stageProgress.durationMs = stageProgress.completedAt.getTime() - stageProgress.startedAt.getTime();
      stageProgress.message = error instanceof Error ? error.message : String(error);
      this.emitProgress();
      throw error;
    }
  }

  private getStage(stage: PipelineStage): StageProgress | undefined {
    return this.progress.stages.find(s => s.stage === stage);
  }

  private markSkipped(stage: PipelineStage): void {
    const s = this.progress.stages.find(sp => sp.stage === stage);
    if (s) {
      s.status = 'skipped';
      s.message = 'Skipped by options';
    }
  }

  private skipRemainingStages(after: PipelineStage): void {
    let found = false;
    for (const s of this.progress.stages) {
      if (s.stage === after) { found = true; continue; }
      if (found && s.status === 'pending') {
        s.status = 'skipped';
        s.message = 'Skipped (index is fresh)';
      }
    }
  }

  private shouldStop(projectId: number): boolean {
    return stopFlags.get(projectId) === true;
  }

  private cancelled(): PipelineProgress {
    this.progress.status = 'cancelled';
    this.progress.completedAt = new Date();
    this.progress.totalDurationMs = Date.now() - (this.progress.startedAt?.getTime() || Date.now());
    this.emitProgress();
    return this.progress;
  }

  private emitProgress(): void {
    pipelineEvents.emit('progress', { ...this.progress });
  }

  getProgress(): PipelineProgress {
    return { ...this.progress };
  }
}

// ============================================
// Public API
// ============================================

/**
 * Run the indexing pipeline for a project.
 * Returns immediately if a pipeline is already running for this project.
 */
export async function runIndexingPipeline(
  prisma: PrismaClient,
  indexingService: CodeIndexingService,
  projectId: number,
  projectName: string,
  options: PipelineOptions = {}
): Promise<PipelineProgress> {
  if (projectLocks.has(projectId)) {
    logger.warn(`Pipeline already running for project ${projectId}`);
    return {
      projectId,
      projectName,
      status: 'running',
      currentStage: null,
      stages: []
    };
  }

  const pipeline = new IndexingPipeline(prisma, indexingService, projectId, projectName);
  return pipeline.run(options);
}

/**
 * Request cancellation of a running pipeline.
 */
export function cancelIndexingPipeline(projectId: number): boolean {
  if (!projectLocks.has(projectId)) return false;
  stopFlags.set(projectId, true);
  return true;
}

/**
 * Check if a pipeline is currently running for a project.
 */
export function isPipelineRunning(projectId: number): boolean {
  return projectLocks.has(projectId);
}

/**
 * Last known PipelineProgress snapshot for a project. Returns null if the
 * pipeline has not run since process start.
 */
export function getLatestPipelineProgress(projectId: number): PipelineProgress | null {
  return latestProgressByProject.get(projectId) ?? null;
}

/**
 * Project IDs of all pipelines currently running.
 */
export function listRunningPipelines(): number[] {
  return Array.from(projectLocks.keys());
}
