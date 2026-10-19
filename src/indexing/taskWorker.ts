/**
 * One `run(task)` per task kind (lazy-incremental-indexing.md 3.3, phase 1).
 *
 * - parse / full-reindex: trigger 'git' (a HEAD move), 'report' or 'auto'
 *   (a scan) and the change-set metadata on the run row. Phase 3: a parse
 *   of a git / dirty / report set on a stable-key project (key_scheme 2)
 *   patches only the gated files (runPatch → graphPatch.ts). Everything
 *   else runs indexProject over the project (its hash gate decides). A
 *   full-reindex of a stable-key project is `force` + `keepVectors`; on a
 *   legacy project it is not forced (force would drop the vectors, memory
 *   forced-reindex-drops-vectors).
 *   On success the (project, root) base moves to the diffed commit; a
 *   failure leaves it, so the next event diffs from the same base.
 * - embed: buildProjectEmbeddings(projectId), today's call, now durable.
 *
 * Back-pressure (no attempt spent): any heavy job or a shadow/live rebuild,
 * the memory guard, or the project being indexed by another path → yield.
 */

import type { PrismaClient, IndexTask } from '@prisma/client';
import { createLogger } from '../utils/index.js';
import type { RunIndexOptions, RunIndexResult, RunPatchOptions } from '../fantom-code/runIndex.js';
import { KEY_SCHEME_STABLE } from '../fantom-code/symbolKey.js';
import { gateCandidates, type ProjectScanInfo } from './changeDetector.js';
import { sampleProcessMemory, memoryDelta, type MemoryGuard } from './memoryGuard.js';
import { safeParse, type TaskQueue } from './taskQueue.js';
import type { EmbedPayload, ParsePayload } from './types.js';
import type { RekeyOutcome } from './rekeyMigration.js';

const logger = createLogger('lazy-index');

export interface WorkerDeps {
  prisma: PrismaClient;
  queue: TaskQueue;
  memory: MemoryGuard;
  runIndex: (projectId: number, opts: RunIndexOptions) => Promise<RunIndexResult>;
  buildEmbeddings: (projectId: number) => Promise<{ processed: number; errors: number; yielded?: number }>;
  /** Label of the heavy job / rebuild that owns the fleet, or null. */
  heavyJobBusy: () => string | null;
  isProjectIndexing: (projectId: number) => boolean;
  heavyJobPollMs: number;
  /** The `rekey` task (rekeyMigration.ts); absent = the kind fails. */
  rekey?: (projectId: number) => Promise<RekeyOutcome>;
  /**
   * File-level graph patch (3.4, phase 3; runIndex.ts runPatch). Absent or
   * `graphPatch.enabled: false` = every parse goes through runIndex.
   */
  runPatch?: (projectId: number, opts: RunPatchOptions) => Promise<RunIndexResult & { patched: boolean; patch?: Record<string, unknown> }>;
  graphPatchEnabled?: () => boolean;
  /** `vector-gc` task (3.5, phase 4; embedPatch.ts gcVectors). */
  vectorGc?: (projectId: number) => Promise<{ vectorsDeleted: number; stateDeleted: number }>;
  /** `cache-prune` task (3.5): LRU prune of embed_cache to the disk cap. */
  cachePrune?: () => Promise<Record<string, unknown>>;
}

/** Change sources a patch handles; scan-only sources keep the project gate. */
const PATCH_SOURCES = new Set(['git', 'dirty']);

export type WorkerOutcome = 'done' | 'yielded' | 'failed' | 'retry' | 'cancelled';

/** Back-pressure checks shared by every kind. Returns the yield reason or null. */
function backPressure(d: WorkerDeps, projectId: number): { reason: string; detail?: string; delayMs?: number } | null {
  const heavy = d.heavyJobBusy();
  if (heavy) return { reason: 'heavy-job', detail: heavy };
  if (d.memory.check().paused) {
    const s = d.memory.state().sample;
    return { reason: 'memory', detail: `rss=${s.rssMb}MB heap=${s.heapMb}MB` };
  }
  if (d.isProjectIndexing(projectId)) return { reason: 'project-busy', delayMs: 5_000 };
  return null;
}

export async function runTask(d: WorkerDeps, task: IndexTask): Promise<WorkerOutcome> {
  const bp = backPressure(d, task.projectId);
  if (bp) {
    const st = await d.queue.yieldTask(task.id, { reason: bp.reason, detail: bp.detail, delayMs: bp.delayMs ?? d.heavyJobPollMs });
    logger.info(`[lazy-index] task ${task.id} ${task.kind} project=${task.projectId} yielded (${bp.reason}${bp.detail ? `: ${bp.detail}` : ''})`);
    return st === 'cancelled' ? 'cancelled' : 'yielded';
  }
  const before = sampleProcessMemory();
  try {
    let result: Record<string, unknown>;
    let runId: number | null = null;
    if (task.kind === 'embed') {
      const r = await d.buildEmbeddings(task.projectId);
      if (r.yielded) {
        // The batch loop stood down for a heavy job: retry later, no attempt.
        await d.queue.yieldTask(task.id, { reason: 'heavy-job', detail: `${r.yielded} nodes left`, delayMs: d.heavyJobPollMs });
        return 'yielded';
      }
      result = { processed: r.processed, errors: r.errors };
      runId = (safeParse(task.payload) as EmbedPayload).runId ?? null;
    } else if (task.kind === 'rekey') {
      if (!d.rekey) throw new Error('rekey is not wired in this process');
      const r = await d.rekey(task.projectId);
      if (r.status === 'yielded') {
        await d.queue.yieldTask(task.id, { reason: 'heavy-job', detail: r.holder, delayMs: d.heavyJobPollMs });
        return 'yielded';
      }
      result = { ...r };
      runId = r.runId;
    } else if (task.kind === 'vector-gc') {
      if (!d.vectorGc) throw new Error('vector-gc is not wired in this process');
      result = { ...(await d.vectorGc(task.projectId)) };
    } else if (task.kind === 'cache-prune') {
      // Back-pressure above already yielded while a heavy job runs (3.5: prune only when idle).
      if (!d.cachePrune) throw new Error('cache-prune is not wired in this process');
      result = await d.cachePrune();
    } else if (task.kind === 'parse' || task.kind === 'full-reindex') {
      const out = await runParse(d, task);
      result = out.result;
      runId = out.runId;
    } else {
      throw new Error(`unknown task kind ${task.kind}`);
    }
    await d.queue.complete(task.id, { ...result, mem: memoryDelta(before, sampleProcessMemory()) }, runId);
    return 'done';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const st = await d.queue.fail(task.id, msg);
    logger.warn(`[lazy-index] task ${task.id} ${task.kind} project=${task.projectId} failed (${st}): ${msg}`);
    return st === 'failed' ? 'failed' : 'retry';
  }
}

async function runParse(d: WorkerDeps, task: IndexTask): Promise<{ result: Record<string, unknown>; runId: number | null }> {
  const p = safeParse(task.payload) as ParsePayload;
  const project = await d.prisma.fantomProject.findUnique({
    where: { id: task.projectId },
    select: { id: true, name: true, path: true, language: true, parserType: true, keyScheme: true },
  });
  if (!project) throw new Error(`project ${task.projectId} not found`);

  // What the gate says about the candidate list (for the exit check and the
  // dashboard; indexProject applies the same gate again over the project).
  let gate: { changed: number; added: number; removed: number; unchanged: number } | null = null;
  let gated: { changed: string[]; removed: string[] } | null = null;
  if (!p.full && (p.paths?.length || p.removed?.length)) {
    const g = await gateCandidates(d.prisma, project as ProjectScanInfo, p.paths ?? [], p.removed ?? []);
    gate = { changed: g.changed.length, added: g.added.length, removed: g.removed.length, unchanged: g.unchanged };
    gated = { changed: g.changed, removed: g.removed };
  }

  const git = p.git;
  const last = git?.commits?.length ? git.commits[git.commits.length - 1] : null;
  const checkout = p.checkout ?? (!!git && (git.headMove.kind === 'switch' || git.headMove.kind === 'unknown'));
  const trigger: RunIndexOptions['trigger'] = p.source === 'git' ? 'git' : p.trigger === 'report' ? 'report' : 'auto';
  const lazy: NonNullable<RunIndexOptions['lazy']> = {
    changeSource: task.kind === 'full-reindex' && p.source !== 'git' ? 'forced' : p.source,
    gitFromCommit: git?.fromCommit ?? null,
    gitCommit: git?.toCommit ?? null,
    gitBranch: git?.branch ?? null,
    headMove: git?.headMove.kind ?? null,
    gitDirty: git?.dirty ?? false,
    gitHeadTime: last && last.sha === git?.toCommit ? new Date(last.authorTime * 1000) : null,
    checkout,
  };
  const stable = (project.keyScheme ?? 1) >= KEY_SCHEME_STABLE;

  // Phase 3: a git / dirty / report change set below the share threshold
  // (the planner already turned bigger ones into full-reindex) on a
  // stable-key project patches just its files. Anything else stays on the
  // whole-project path.
  const usePatch = task.kind === 'parse' && !p.full && stable && !!d.runPatch &&
    (d.graphPatchEnabled?.() ?? true) && (PATCH_SOURCES.has(p.source) || p.trigger === 'report') &&
    !!gated && gated.changed.length + gated.removed.length > 0;

  let patchInfo: Record<string, unknown> | undefined;
  let r: RunIndexResult;
  if (usePatch) {
    const pr = await d.runPatch!(task.projectId, { paths: gated!.changed, removed: gated!.removed, trigger, lazy });
    patchInfo = pr.patch ?? { refused: true };
    r = pr;
  } else {
    // A full-reindex on a stable-key project rebuilds the graph and keeps
    // the vectors (3.2.6, D4): ids survive, the embed task fills the gaps.
    const fullKeep = task.kind === 'full-reindex' && stable;
    r = await d.runIndex(task.projectId, { trigger, lazy, ...(fullKeep ? { force: true, keepVectors: true } : {}) });
  }
  if (!r.success) throw new Error(`index run ${r.runId ?? '?'} finished with ${r.indexResult.errors} hard error(s)`);

  // Move the base only now: parse finished without hard errors (3.2.2 step 7).
  if (git && p.rootId != null) {
    await d.prisma.projectGitState.updateMany({
      where: { projectId: task.projectId, rootId: p.rootId },
      data: { lastIndexedCommit: git.toCommit, lastIndexedBranch: git.branch },
    });
  }
  logger.info(
    `[lazy-index] task ${task.id} ${task.kind} project=${project.name} run=${r.runId ?? '?'} ` +
    `source=${p.source}${git ? ` ${git.headMove.kind} ${git.fromCommit?.slice(0, 8) ?? 'seed'}..${git.toCommit.slice(0, 8)}` : ''} ` +
    `candidates=${p.paths?.length ?? 0}+${p.removed?.length ?? 0} parsed=${r.indexResult.filesProcessed}${r.noChange ? ' (no change)' : ''}`,
  );
  return {
    runId: r.runId ?? null,
    result: {
      runId: r.runId ?? null,
      noChange: r.noChange ?? false,
      candidates: { paths: p.paths?.length ?? 0, removed: p.removed?.length ?? 0, renamed: p.renamed?.length ?? 0, full: !!p.full },
      gate,
      ...(patchInfo ? { patch: patchInfo } : {}),
      changedFiles: r.changedFiles ?? [],
      removedFiles: r.removedFiles ?? [],
      filesProcessed: r.indexResult.filesProcessed,
      headMove: git?.headMove.kind ?? null,
      checkout,
      commits: git?.commits?.length ?? 0,
    },
  };
}
