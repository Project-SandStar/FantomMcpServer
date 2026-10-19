/**
 * Shared indexing entry point. Every caller (MCP add/refresh, admin reindex,
 * incremental reindex, file-watch) routes through here so we never again split
 * the pipeline between FantomCodeIndexer (legacy regex) and CodeIndexingService
 * (modern multi-language).
 *
 * Responsibilities:
 *   1. Look up the FantomProject row.
 *   2. Run CodeIndexingService.indexProject (parse + IndexRun + ApiChange + graph).
 *   3. Update Prisma stats.
 *   4. Rebuild FlexSearch from the in-memory indexer.
 *   5. Return a uniform IndexResult shape for tool responses.
 *
 * Trigger taxonomy (used as IndexRun.trigger):
 *   mcp-add        — addFantomProject MCP tool
 *   mcp-refresh    — refreshFantomProject MCP tool
 *   mcp-incremental — reindexChangedFiles MCP tool
 *   admin-reindex  — POST /admin/code-projects/:id/reindex
 *   git            — lazy indexing: a HEAD move (src/indexing/taskWorker.ts)
 *   auto           — lazy indexing: the safety-net mtime scan
 *   report         — lazy indexing: an AI change report (reportChanges, hook)
 *   manual         — anything else (scripts, default fall-through)
 *
 * Embedding: with `indexing.lazy.enabled` and the project on the allow-list,
 * the embed stage is a durable `embed` row in index_tasks (the embed worker
 * still calls buildProjectEmbeddings). Otherwise it runs inline as before.
 */

import type { PrismaClient } from '@prisma/client';
import type { FantomDatabase } from '../fantom/database.js';
import { getCodeIndexingService, type LazyRunMeta } from './codeIndexingService.js';
import { getFantomCodeIndexer } from './indexer.js';
import { getFantomFunctionSearchIndex } from './searchIndex.js';
import type { SymbolIdMapping } from './symbolKey.js';

export type IndexTrigger =
  | 'mcp-add'
  | 'mcp-refresh'
  | 'mcp-incremental'
  | 'admin-reindex'
  | 'file-watch'
  | 'git'
  | 'auto'
  | 'report'
  | 'manual';

export interface RunIndexOptions {
  trigger?: IndexTrigger;
  buildGraph?: boolean;
  buildEmbeddings?: boolean;
  forceParser?: 'tree-sitter' | 'regex';
  /** Skip the file-hash stale gate and reparse every file. */
  force?: boolean;
  /**
   * With force: rebuild the graph but keep the project's vectors (3.2.6, D4).
   * Stable-key ids survive a rebuild, so the embed pass only fills the gaps.
   * Without it force drops the vectors (the admin "drop and rebuild").
   */
  keepVectors?: boolean;
  /** Lazy indexing task context, written on the IndexRun row. */
  lazy?: LazyRunMeta;
  /** Key scheme override and legacy → stable id sink (rekey task, symbolKey.ts). */
  keyScheme?: number;
  onSymbolKeys?: (mappings: SymbolIdMapping[]) => void;
}

/**
 * Set by src/indexing/runtime.ts while the lazy scheduler runs. Returns true
 * when it queued the embed stage for this project (lazy flag + allow-list),
 * false when runIndex must embed inline as before.
 */
type EmbedEnqueuer = (projectId: number, runId: number | null) => Promise<boolean>;
let embedEnqueuer: EmbedEnqueuer | null = null;
export function setLazyEmbedEnqueuer(fn: EmbedEnqueuer | null): void { embedEnqueuer = fn; }

export interface RunIndexResult {
  success: boolean;
  project: { id: number; name: string; path: string };
  /** True when the hash-gate short-circuited and no files were re-parsed. */
  noChange?: boolean;
  /** index_runs row of this run. */
  runId?: number;
  /** Paths the hash gate marked changed / removed (capped). */
  changedFiles?: string[];
  removedFiles?: string[];
  indexResult: {
    functionsIndexed: number;
    typesIndexed: number;
    filesProcessed: number;
    errors: number;
    warnings: number;
    duration: number;
  };
}

export interface RunPatchOptions {
  /** Changed + added files (absolute). */
  paths: string[];
  /** Files gone from disk (absolute). */
  removed: string[];
  trigger?: IndexTrigger;
  lazy?: LazyRunMeta;
}

/**
 * Lazy `parse` task on a stable-key project (3.4, phase 3): patch the graph
 * for just these files (CodeIndexingService.reindexFiles → graphPatch), keep
 * FlexSearch in sync, and hand the changed nodes to the embed stage (their
 * stale vectors are already dropped; the embed pass fills the gaps).
 * `patched: false` when the patch refused (preload cap): the files were
 * rebuilt the pre-phase-3 way, which is still correct.
 */
export async function runPatch(
  prisma: PrismaClient,
  projectId: number,
  opts: RunPatchOptions,
): Promise<RunIndexResult & { patched: boolean; patch?: Record<string, unknown> }> {
  const service = getCodeIndexingService(prisma);
  const r = await service.reindexFiles({
    projectId, paths: opts.paths, removed: opts.removed,
    trigger: (opts.trigger ?? 'auto') as any, lazy: opts.lazy, embed: false,
  });
  try {
    getFantomFunctionSearchIndex().rebuild(getFantomCodeIndexer());
  } catch { /* best-effort, as in runIndex */ }

  const needsEmbed = !r.patch || r.patch.changedIds.length > 0;
  if (needsEmbed) {
    void (async () => {
      try {
        if (embedEnqueuer && await embedEnqueuer(projectId, r.runId).catch(() => false)) return;
        const { getHeavyJob } = await import('../embedding/embedGate.js');
        if (getHeavyJob()) return; // the watchdog embeds it later
        const { getSemanticSearchService } = await import('../embedding/semanticSearchService.js');
        await getSemanticSearchService(prisma).buildProjectEmbeddings(projectId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[runPatch] embedding failed for project ${projectId}:`, err);
      }
    })();
  }

  const hardErrors = r.errors.filter(e => e.severity === 'error').length;
  const p = r.patch;
  return {
    success: hardErrors === 0,
    project: { id: projectId, name: r.projectName, path: '' },
    noChange: false,
    runId: r.runId,
    changedFiles: r.changedFiles,
    removedFiles: r.removedFiles,
    patched: !!p,
    ...(p ? {
      patch: {
        created: p.nodesCreated, updated: p.nodesUpdated, unchanged: p.nodesUnchanged, deleted: p.nodesDeleted,
        edges: p.edgesCreated, repointed: p.incomingRepointed, lost: p.incomingLost, links: p.links.length,
        pendingAdded: p.pendingAdded, pendingResolved: p.pendingResolved, vectorsDropped: r.vectorsDropped,
        embedNodes: p.changedIds.length, ms: p.durationMs,
      },
    } : {}),
    indexResult: {
      functionsIndexed: r.functionsIndexed,
      typesIndexed: r.typesIndexed,
      filesProcessed: r.filesProcessed,
      errors: hardErrors,
      warnings: r.errors.length - hardErrors,
      duration: r.duration,
    },
  };
}

export async function runIndex(
  db: FantomDatabase,
  prisma: PrismaClient,
  projectId: number,
  opts: RunIndexOptions = {},
): Promise<RunIndexResult> {
  const project = await db.getProjectById(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const projectLanguage = project.language || 'fantom';
  const projectParserType = project.parserType || 'regex';

  const service = getCodeIndexingService(prisma);

  const extProject = {
    id: project.id,
    name: project.name,
    path: project.path,
    instanceId: project.instanceId,
    podMeta: project.podName
      ? { podName: project.podName, dependencies: [], srcDirs: ['fan'] }
      : undefined,
    functionCount: 0,
    typeCount: 0,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    language: projectLanguage,
    parserType: projectParserType,
  };

  // Don't pass forceParser by default — let CodeIndexingService respect
  // the Prisma-stored parserType. Hardcoding 'tree-sitter' here previously
  // overrode 'tree-sitter-wasm' values stored in Prisma, which then caused
  // some downstream branches to behave as if regex were active.
  // (Caller can still override explicitly via opts.forceParser.)
  const result = await service.indexProject(extProject, {
    forceParser: opts.forceParser,
    buildGraph: opts.buildGraph ?? true,
    buildEmbeddings: opts.buildEmbeddings ?? true,
    trigger: opts.trigger ?? 'manual',
    force: opts.force ?? false,
    keepVectors: opts.keepVectors ?? false,
    lazy: opts.lazy,
    keyScheme: opts.keyScheme,
    onSymbolKeys: opts.onSymbolKeys,
  } as any);

  // Critical: only update Prisma stats when this run actually parsed something.
  // CodeIndexingService returns 0/0/0 on stale-check short-circuit. Writing
  // those zeroes would clobber the prior correct counts and silently drop the
  // project to "0 functions" until the next forced reindex. The same logic
  // skips the update when filesProcessed=0 (e.g. empty directory).
  const isNoOp =
    (result as any).noChange === true ||
    (result.functionsIndexed === 0 &&
      result.typesIndexed === 0 &&
      result.filesProcessed === 0);
  if (!isNoOp) {
    await db.updateProjectIndexStats(
      project.id,
      result.functionsIndexed,
      result.typesIndexed,
    );
  }

  // Project dependency rows (ask scope) are refreshed inside
  // CodeIndexingService.indexProject / reindexFiles — the single hook that
  // every indexing entry point passes through (see refreshProjectDependencies).

  // Keep FlexSearch in sync so searchFantomCode reflects what was just parsed.
  // The CodeIndexingService writes to Prisma + LadybugDB but does not touch
  // the in-memory FlexSearch index — that population happens here.
  try {
    const codeIndexer = getFantomCodeIndexer();
    const searchIndex = getFantomFunctionSearchIndex();
    searchIndex.rebuild(codeIndexer);
  } catch {
    // FlexSearch rebuild is best-effort; never block on it.
  }

  // Auto-build vector embeddings so semanticCodeSearch works immediately.
  // Run in background — embedding 1000s of nodes takes minutes and we don't
  // want addFantomProject to block on it. Errors are logged, not surfaced.
  //
  // Critically, re-fire on stale-check too: when files haven't changed but
  // the prior run's embeddings are missing (e.g. graph was rebuilt after
  // an orphan sweep), we still need to backfill vectors. The buildProject
  // Embeddings call is idempotent — it skips nodes that already have
  // vectors, so the cost is a single LanceDB lookup.
  if (opts.buildEmbeddings !== false) {
    void (async () => {
      try {
        // When the caller forced a full reparse, the LadybugDB node IDs may
        // differ from those baked into existing LanceDB rows (e.g. after a
        // graph rebuild). Drop the project's vectors first so the rebuild
        // re-embeds against current node IDs — otherwise semantic search
        // returns 0 hits because fetchNodesByIds can't resolve stale IDs.
        if (opts.force === true && opts.keepVectors !== true) {
          try {
            const { getVectorStore } = await import('../embedding/vectorStore.js');
            const vs = getVectorStore(prisma);
            const dropped = await vs.deleteProjectVectors(project.id);
            // eslint-disable-next-line no-console
            console.log(`[runIndex] dropped ${dropped} stale vectors for project ${project.id} (force reindex)`);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[runIndex] vector drop failed for project ${project.id}:`, err);
          }
        }
        // Lazy indexing: a durable `embed` task instead of the fire-and-forget
        // call below; the queue yields it while a heavy job runs.
        if (embedEnqueuer && await embedEnqueuer(project.id, result.runId ?? null).catch(() => false)) {
          return;
        }
        const { getHeavyJob } = await import('../embedding/embedGate.js');
        const heavy = getHeavyJob();
        if (heavy) {
          // eslint-disable-next-line no-console
          console.log(`[runIndex] embeddings for project ${project.id} deferred — heavy job ${heavy.kind} (${heavy.label}) owns the fleet; the watchdog embeds it later`);
        } else {
          const { getSemanticSearchService } = await import('../embedding/semanticSearchService.js');
          const svc = getSemanticSearchService(prisma);
          const r = await svc.buildProjectEmbeddings(project.id);
          // eslint-disable-next-line no-console
          console.log(`[runIndex] embeddings for project ${project.id}: ${r.processed} processed, ${r.errors} errors${r.yielded ? `, ${r.yielded} yielded to a heavy job` : ''}`);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[runIndex] embedding build failed for project ${project.id}:`, err);
      }
    })();
  }

  // Warnings (e.g. a key=value file named .trio that the trio grammar
  // flags line by line) do not fail the run; only severity 'error' does.
  const hardErrors = result.errors.filter(e => e.severity === 'error').length;

  return {
    success: hardErrors === 0,
    project: { id: project.id, name: project.name, path: project.path },
    // Surface `noChange` so the dashboard can distinguish "hash-gate skipped
    // re-parse — index is up to date" from "parser produced 0 results — bug".
    // Without this flag, every hash-gated reindex looked like a parser failure.
    noChange: isNoOp,
    runId: result.runId,
    changedFiles: result.changedFiles,
    removedFiles: result.removedFiles,
    indexResult: {
      functionsIndexed: result.functionsIndexed,
      typesIndexed: result.typesIndexed,
      filesProcessed: result.filesProcessed,
      errors: hardErrors,
      warnings: result.errors.length - hardErrors,
      duration: result.duration,
    },
  };
}
