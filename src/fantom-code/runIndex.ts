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
 *   manual         — anything else (scripts, default fall-through)
 */

import type { PrismaClient } from '@prisma/client';
import type { FantomDatabase } from '../fantom/database.js';
import { getCodeIndexingService } from './codeIndexingService.js';
import { getFantomCodeIndexer } from './indexer.js';
import { getFantomFunctionSearchIndex } from './searchIndex.js';

export type IndexTrigger =
  | 'mcp-add'
  | 'mcp-refresh'
  | 'mcp-incremental'
  | 'admin-reindex'
  | 'file-watch'
  | 'manual';

export interface RunIndexOptions {
  trigger?: IndexTrigger;
  buildGraph?: boolean;
  buildEmbeddings?: boolean;
  forceParser?: 'tree-sitter' | 'regex';
  /** Skip the file-hash stale gate and reparse every file. */
  force?: boolean;
}

export interface RunIndexResult {
  success: boolean;
  project: { id: number; name: string; path: string };
  /** True when the hash-gate short-circuited and no files were re-parsed. */
  noChange?: boolean;
  indexResult: {
    functionsIndexed: number;
    typesIndexed: number;
    filesProcessed: number;
    errors: number;
    duration: number;
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
        if (opts.force === true) {
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

  return {
    success: result.errors.length === 0,
    project: { id: project.id, name: project.name, path: project.path },
    // Surface `noChange` so the dashboard can distinguish "hash-gate skipped
    // re-parse — index is up to date" from "parser produced 0 results — bug".
    // Without this flag, every hash-gated reindex looked like a parser failure.
    noChange: isNoOp,
    indexResult: {
      functionsIndexed: result.functionsIndexed,
      typesIndexed: result.typesIndexed,
      filesProcessed: result.filesProcessed,
      errors: result.errors.length,
      duration: result.duration,
    },
  };
}
