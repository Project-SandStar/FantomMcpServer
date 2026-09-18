/**
 * Centralized project lifecycle: removing a project means clearing it from
 * EVERY store that holds derived data, not just the Prisma row. The admin
 * DELETE route was leaking LadybugDB nodes, LanceDB vectors, and in-memory
 * FlexSearch entries; this helper is the single correct path.
 */

import type { PrismaClient } from '@prisma/client';
import { getFantomCodeIndexer } from './indexer.js';
import { clearProjectGraph } from '../graph/ladybugSchema.js';
import { getVectorStore } from '../embedding/vectorStore.js';

export type StepStatus = 'ok' | 'failed' | 'skipped';

export interface RemoveProjectResult {
  success: boolean;
  projectId: number;
  projectName: string;
  inMemoryCleared: boolean;
  graphNodesDeleted: number;
  vectorsDeleted: number;
  prismaRowDeleted: boolean;
  steps: {
    inMemory: StepStatus;
    graph: StepStatus;
    vectors: StepStatus;
    prismaRow: StepStatus;
  };
  errors: string[];
}

/**
 * Wipe every trace of a project. Pass keepRow:true to clear all derived data
 * but leave the FantomProject row (and its IndexedFile/IndexRun/ApiChange
 * rows via cascade — actually those go too because they cascade off
 * FantomProject only when the row is deleted, so keepRow=true preserves
 * them too).
 *
 * Order matters: in-memory → graph → vectors → Prisma row. Each step is
 * best-effort; if one fails we capture the error and continue so partial
 * cleanup makes progress.
 */
export async function removeProject(
  prisma: PrismaClient,
  projectId: number,
  opts: { keepRow?: boolean; force?: boolean } = {},
): Promise<RemoveProjectResult> {
  const errors: string[] = [];
  const steps: RemoveProjectResult['steps'] = {
    inMemory: 'skipped',
    graph: 'skipped',
    vectors: 'skipped',
    prismaRow: 'skipped',
  };
  let graphNodesDeleted = 0;
  let vectorsDeleted = 0;
  let prismaRowDeleted = false;

  // Resolve name up front for the result.
  const row = await prisma.fantomProject.findUnique({
    where: { id: projectId },
    select: { id: true, name: true },
  });
  if (!row) {
    throw new Error(`Project ${projectId} not found`);
  }
  const projectName = row.name;

  // 1. In-memory FlexSearch / FantomCodeIndexer
  let inMemoryCleared = false;
  try {
    getFantomCodeIndexer().clearProject(projectId);
    inMemoryCleared = true;
    steps.inMemory = 'ok';
  } catch (err) {
    steps.inMemory = 'failed';
    errors.push(`indexer.clearProject failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. LadybugDB (Kuzu) graph
  try {
    const r = await clearProjectGraph(projectId);
    graphNodesDeleted = r.nodesDeleted;
    steps.graph = 'ok';
  } catch (err) {
    steps.graph = 'failed';
    errors.push(`clearProjectGraph failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. LanceDB vectors
  try {
    const vs = getVectorStore(prisma);
    vectorsDeleted = await vs.deleteProjectVectors(projectId);
    steps.vectors = 'ok';
  } catch (err) {
    steps.vectors = 'failed';
    errors.push(`deleteProjectVectors failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. Prisma row. By default we ABORT the row deletion if any prior step
  // errored — leaving a partially-cleaned project with the row intact is
  // safer than removing the row and orphaning graph/vector data the user
  // can no longer find. Pass force:true to delete despite earlier failures.
  const cascadeFailed =
    steps.inMemory === 'failed' ||
    steps.graph === 'failed' ||
    steps.vectors === 'failed';

  if (!opts.keepRow) {
    if (cascadeFailed && !opts.force) {
      steps.prismaRow = 'skipped';
      errors.push(
        'prisma row delete skipped — earlier cascade step failed. Re-run with force:true to delete anyway.',
      );
    } else {
      try {
        await prisma.fantomProject.delete({ where: { id: projectId } });
        prismaRowDeleted = true;
        steps.prismaRow = 'ok';
      } catch (err) {
        steps.prismaRow = 'failed';
        errors.push(`prisma.fantomProject.delete failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else {
    // keepRow=true → reset stats so the row reflects the cleared state.
    try {
      await prisma.fantomProject.update({
        where: { id: projectId },
        data: { functionCount: 0, typeCount: 0, lastIndexed: null },
      });
    } catch (err) {
      errors.push(`fantomProject stats reset failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Also wipe the per-file hash cache so the next reindex re-seeds.
    try {
      await prisma.indexedFile.deleteMany({ where: { projectId } });
    } catch (err) {
      errors.push(`indexedFile.deleteMany failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const success =
    errors.length === 0 &&
    (opts.keepRow ? true : prismaRowDeleted);

  return {
    success,
    projectId,
    projectName,
    inMemoryCleared,
    graphNodesDeleted,
    vectorsDeleted,
    prismaRowDeleted,
    steps,
    errors,
  };
}
