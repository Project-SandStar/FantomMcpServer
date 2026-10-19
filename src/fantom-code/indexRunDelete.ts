/**
 * Delete one IndexRun ("delete this parse") — the planner and the executor
 * behind GET/DELETE /admin/code-projects/:id/index-runs/:runId.
 *
 * What a run owns, and so what a delete removes:
 *   - its `index_runs` row and the `api_changes` / `edge_changes` rows it wrote
 *     (the per-run history the timeline, diffs and getSymbolHistory read);
 *   - the code vectors of symbols this run added / modified / removed, when no
 *     LATER run changed that symbol again and no later run was forced (a forced
 *     reindex re-embeds every symbol, so nothing of this run is left in Lance).
 *     The embed-missing watchdog (or "Resume" / build-missing) re-embeds them.
 *
 * What it does NOT touch: the LadybugDB graph. A full run rebuilds it with
 * clearProject=true, so graph nodes are not versioned per run — the graph is
 * always "the latest parse". Deleting the LATEST run therefore keeps the
 * graph as is and instead drops that run's `indexed_files` rows, so the next
 * reindex re-parses those files (the hash gate would otherwise skip them) and
 * the re-embed works from a fresh parse. Nothing is re-parsed here.
 *
 * Refused (409): the project's only run (no history left to fall back on —
 * use reindex / clearProjectIndex instead), and any run while the project is
 * indexing (a running pass rewrites `indexed_files` at its end).
 */

import type { PrismaClient } from '@prisma/client';

/** One project run, as the planner needs it. */
export interface RunSummary {
  id: number;
  startedAt: Date;
  finishedAt: Date | null;
  force: boolean;
  isSeedingRun: boolean;
  trigger: string;
  errorMessage: string | null;
}

export interface RunChange {
  qualifiedName: string;
  changeType: string; // added | modified | removed
  filePath: string;
}

export interface IndexRunDeletePlan {
  projectId: number;
  runId: number;
  run: {
    startedAt: string;
    finishedAt: string | null;
    trigger: string;
    force: boolean;
    isSeedingRun: boolean;
    errorMessage: string | null;
  };
  isLatest: boolean;
  isOnly: boolean;
  /** finished_at is NULL and no pass is running → the run crashed. */
  unfinished: boolean;
  apiChanges: { added: number; modified: number; removed: number; total: number; capped: boolean };
  edgeChanges: number;
  /** Qualified names whose vectors get deleted (this run is their last change). */
  vectorQualifiedNames: string[];
  /** Why no vectors are touched, when that is the case. */
  vectorSkipReason: string | null;
  /** Latest run only: `indexed_files` paths dropped so the next reindex re-parses them. */
  reparseFiles: string[];
  /** Set when the delete must be refused; HTTP 409 with this text. */
  refusal: string | null;
}

/** Matches MAX_CHANGE_ROWS in codeIndexingService — a run at the cap was truncated. */
export const API_CHANGE_ROW_CAP = 5000;

/** Runs started after `target` (ties broken by id, matching insertion order). */
function laterRuns(target: RunSummary, runs: RunSummary[]): RunSummary[] {
  const t = target.startedAt.getTime();
  return runs.filter(r => r.id !== target.id && (r.startedAt.getTime() > t || (r.startedAt.getTime() === t && r.id > target.id)));
}

/**
 * Pure planner. `changedLater` = qualified names (from `changes`) that a
 * later run of the same project also recorded a change for.
 */
export function planIndexRunDelete(input: {
  projectId: number;
  target: RunSummary;
  runs: RunSummary[];
  changes: RunChange[];
  edgeChangeCount: number;
  changedLater: Set<string>;
  projectIndexing: boolean;
}): IndexRunDeletePlan {
  const { projectId, target, runs, changes, edgeChangeCount, changedLater, projectIndexing } = input;
  const later = laterRuns(target, runs);
  const isLatest = later.length === 0;
  const isOnly = runs.length <= 1;

  const counts = { added: 0, modified: 0, removed: 0 };
  for (const c of changes) {
    if (c.changeType === 'added') counts.added++;
    else if (c.changeType === 'modified') counts.modified++;
    else if (c.changeType === 'removed') counts.removed++;
  }

  let vectorSkipReason: string | null = null;
  let vectorQualifiedNames: string[] = [];
  const laterForced = later.find(r => r.force && r.finishedAt);
  if (laterForced) {
    vectorSkipReason = `run #${laterForced.id} was a forced reindex after this one and re-embedded every symbol`;
  } else if (changes.length === 0) {
    vectorSkipReason = target.isSeedingRun
      ? 'a seeding run records no per-symbol changes'
      : 'this run recorded no symbol changes';
  } else {
    // Removed rows included: a stale vector of a symbol this run removed goes
    // too — unless a later run re-added it (changedLater filters that out).
    vectorQualifiedNames = [...new Set(changes.map(c => c.qualifiedName))].filter(qn => !changedLater.has(qn));
    if (vectorQualifiedNames.length === 0) vectorSkipReason = 'every symbol this run changed was changed again by a later run';
  }

  const reparseFiles = isLatest ? [...new Set(changes.map(c => c.filePath))].sort() : [];

  let refusal: string | null = null;
  if (projectIndexing) refusal = 'This project is being indexed right now. Retry when the run finishes.';
  else if (isOnly) refusal = 'This is the only indexing run of the project; deleting it would leave no history. Reindex the project instead.';

  return {
    projectId,
    runId: target.id,
    run: {
      startedAt: target.startedAt.toISOString(),
      finishedAt: target.finishedAt?.toISOString() ?? null,
      trigger: target.trigger,
      force: target.force,
      isSeedingRun: target.isSeedingRun,
      errorMessage: target.errorMessage,
    },
    isLatest,
    isOnly,
    unfinished: target.finishedAt == null && !projectIndexing,
    apiChanges: { ...counts, total: changes.length, capped: changes.length >= API_CHANGE_ROW_CAP },
    edgeChanges: edgeChangeCount,
    vectorQualifiedNames,
    vectorSkipReason,
    reparseFiles,
    refusal,
  };
}

const IN_CHUNK = 500;

function chunks<T>(items: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Load everything the planner needs from Prisma. Null when the run is not this project's. */
export async function loadIndexRunDeletePlan(
  prisma: PrismaClient,
  projectId: number,
  runId: number,
  projectIndexing: boolean,
): Promise<IndexRunDeletePlan | null> {
  const p = prisma as any;
  const runs: RunSummary[] = await p.indexRun.findMany({
    where: { projectId },
    select: { id: true, startedAt: true, finishedAt: true, force: true, isSeedingRun: true, trigger: true, errorMessage: true },
  });
  const target = runs.find(r => r.id === runId);
  if (!target) return null;

  const [changes, edgeChangeCount] = await Promise.all([
    p.apiChange.findMany({ where: { runId }, select: { qualifiedName: true, changeType: true, filePath: true } }) as Promise<RunChange[]>,
    p.edgeChange.count({ where: { runId } }) as Promise<number>,
  ]);

  const laterIds = laterRuns(target, runs).map(r => r.id);
  const changedLater = new Set<string>();
  if (laterIds.length > 0 && changes.length > 0) {
    const qns = [...new Set(changes.map(c => c.qualifiedName))];
    for (const part of chunks(qns)) {
      const rows: Array<{ qualifiedName: string }> = await p.apiChange.findMany({
        where: { projectId, runId: { in: laterIds }, qualifiedName: { in: part } },
        select: { qualifiedName: true },
        distinct: ['qualifiedName'],
      });
      for (const r of rows) changedLater.add(r.qualifiedName);
    }
  }

  return planIndexRunDelete({ projectId, target, runs, changes, edgeChangeCount, changedLater, projectIndexing });
}

function escSql(value: string): string {
  return value.replace(/'/g, "''");
}

/** Lance filters, one per chunk of qualified names. Empty on a v2 table (no qualified_name column). */
async function vectorFilters(plan: IndexRunDeletePlan): Promise<{ table: import('@lancedb/lancedb').Table; filters: string[] } | null> {
  if (plan.vectorQualifiedNames.length === 0) return null;
  const { getLanceTable, codeTableHasV3Columns, getActiveCodeTableName } = await import('../embedding/lanceConnection.js');
  const table = await getLanceTable();
  if (!(await codeTableHasV3Columns(table, getActiveCodeTableName()))) return null;
  const filters = chunks(plan.vectorQualifiedNames).map(part =>
    `project_id = ${plan.projectId} AND qualified_name IN (${part.map(q => `'${escSql(q)}'`).join(', ')})`);
  return { table, filters };
}

/** Vector rows (all chunks) the delete would remove. */
export async function countRunVectors(plan: IndexRunDeletePlan): Promise<number> {
  const vf = await vectorFilters(plan);
  if (!vf) return 0;
  let n = 0;
  for (const f of vf.filters) n += await vf.table.countRows(f);
  return n;
}

export interface IndexRunDeleteResult {
  runId: number;
  apiChangesDeleted: number;
  edgeChangesDeleted: number;
  vectorsDeleted: number;
  indexedFilesCleared: number;
}

/**
 * Carry out a plan. Lance first, then one SQLite transaction: if the vector
 * delete fails, the run's rows are still there and the delete can be retried.
 * The caller holds the heavy-job lock and has checked `plan.refusal`.
 */
export async function executeIndexRunDelete(prisma: PrismaClient, plan: IndexRunDeletePlan): Promise<IndexRunDeleteResult> {
  let vectorsDeleted = 0;
  const vf = await vectorFilters(plan);
  if (vf) {
    const { enqueueTableWrite } = await import('../embedding/vectorWriteQueue.js');
    vectorsDeleted = await enqueueTableWrite(vf.table, async () => {
      let n = 0;
      for (const f of vf.filters) {
        const before = await vf.table.countRows(f);
        if (before > 0) await vf.table.delete(f);
        n += before;
      }
      return n;
    });
  }

  const p = prisma as any;
  const [apiDel, edgeDel, filesDel] = await prisma.$transaction([
    p.apiChange.deleteMany({ where: { runId: plan.runId } }),
    p.edgeChange.deleteMany({ where: { runId: plan.runId } }),
    p.indexedFile.deleteMany({ where: { projectId: plan.projectId, filePath: { in: plan.reparseFiles } } }),
    p.indexRun.delete({ where: { id: plan.runId } }),
  ]);

  return {
    runId: plan.runId,
    apiChangesDeleted: apiDel.count,
    edgeChangesDeleted: edgeDel.count,
    vectorsDeleted,
    indexedFilesCleared: filesDel.count,
  };
}
