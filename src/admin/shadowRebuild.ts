/**
 * Helpers for the code-vector rebuild: a project-level work queue, an honest
 * halt vocabulary, and the promotion decision.
 *
 * These layer ON TOP of the rebuild loop in routes.ts; they do not replace
 * any of it. The loop already owns the heavy-job lock, the shadow-slot swap,
 * resume with partial-project clearing, the pipelined per-provider scheduler,
 * per-project attribution and periodic compaction. What was missing was the
 * three things below.
 *
 * ── 1. Projects as the unit of assignment ──────────────────────────────────
 *
 * The loop was `for (const pid of projectIds)`: one project at a time, the
 * whole fleet waiting on each project's graph-context pre-pass before any
 * provider saw a text. Fanning one project's texts across providers does not
 * fix that — the gap between projects is dead time for everyone.
 *
 * Workers now pull from a shared queue. `queue.shift()` IS the atomic claim:
 * Node runs this on one thread and there is no await between the check and
 * the take, so two workers cannot observe the same head. The claim happens
 * before any work starts and is released on completion AND on failure.
 *
 * Concurrency is bounded and low. Each in-flight project holds its whole node
 * set plus graph context; three concurrent forced reindexes once tripped the
 * RSS guard at 4,002 MB (exit 137). Default 3, capped at 8.
 *
 * ── 2. Pause is not Discard ────────────────────────────────────────────────
 *
 * Both halt the loop. The difference is what happens to the shadow:
 *
 *   paused    — shadow KEPT, resumable, progress still visible. Reversible.
 *   cancelled — shadow DROPPED. Irreversible, operator-confirmed.
 *
 * Main already keeps the shadow on every exit path; what it lacked was the
 * vocabulary. Calling a stop that preserved 225,008 rows across 324 projects
 * "cancelled" is how it read as total data loss.
 *
 * ── 3. Promote anyway ──────────────────────────────────────────────────────
 *
 * Promotion required every project to finish, so stopping at 324/340 banked
 * nothing usable — 95% of a rebuild stayed unreachable behind a completeness
 * check. That is what made pausing feel unsafe.
 */

import { getJob, updateJob, appendError, type ReembedJob } from './reembedJobs.js';

export const DEFAULT_MAX_CONCURRENT_PROJECTS = 3;
export const MAX_CONCURRENT_PROJECTS_CAP = 8;

export function resolveMaxConcurrentProjects(cfg: any): number {
  const raw = cfg?.semanticSearch?.maxConcurrentProjects;
  if (!Number.isFinite(raw) || Number(raw) <= 0) return DEFAULT_MAX_CONCURRENT_PROJECTS;
  return Math.max(1, Math.min(MAX_CONCURRENT_PROJECTS_CAP, Number(raw)));
}

export type HaltReason = 'paused' | 'cancelled' | null;

/** Which halt (if any) the job is asking for. Discard wins over pause — the
 *  destructive intent is the explicit one. */
export function haltRequested(jobId: string): HaltReason {
  const j = getJob(jobId);
  if (!j) return null;
  if (j.cancelRequested) return 'cancelled';
  if (j.pauseRequested) return 'paused';
  return null;
}

export interface ProjectQueue {
  /** Atomically claim the next project, or undefined when drained. */
  claim(): number | undefined;
  /** Release a claim on completion or failure. */
  release(pid: number): void;
  readonly remaining: number;
  readonly inFlight: number;
  /** Claimed but never released — a worker died mid-project. Process-local;
   *  the shadow's own row counts are the durable record of completion, which
   *  is what makes such a project claimable again by a later resume. */
  readonly orphaned: number[];
}

export function createProjectQueue(projectIds: number[]): ProjectQueue {
  const queue = [...projectIds];
  const claimed = new Set<number>();
  return {
    claim(): number | undefined {
      // No await between the shift and the add — this is the atomic section.
      const pid = queue.shift();
      if (pid === undefined) return undefined;
      claimed.add(pid);
      return pid;
    },
    release(pid: number): void { claimed.delete(pid); },
    get remaining() { return queue.length; },
    get inFlight() { return claimed.size; },
    get orphaned() { return [...claimed]; },
  };
}

/** Finalize a halted job: pause keeps the shadow, discard drops it. */
export async function finalizeHalt(
  jobId: string,
  reason: Exclude<HaltReason, null>,
  shadowName: string | null,
  writeTable?: unknown,
): Promise<void> {
  if (reason === 'paused') {
    updateJob(jobId, { status: 'paused', currentProjectId: undefined, shadowTable: shadowName });
    const j = getJob(jobId);
    console.log(
      `[reembed] PAUSED job=${jobId} progress=${j?.doneProjects ?? 0}/${j?.totalProjects ?? 0} — `
      + `shadow slot '${shadowName ?? 'n/a'}' KEPT. Resume with POST /admin/vectors/re-embed/start {projectId:0, resume:true}.`,
    );
    return;
  }
  updateJob(jobId, { status: 'cancelled', finishedAt: new Date().toISOString(), currentProjectId: undefined });
  if (shadowName) {
    try {
      const { dropShadowCodeTable } = await import('../embedding/lanceConnection.js');
      // embedTextsPipelined drains its in-flight chunks before resolving, and
      // each of those still calls onChunk -> storeEmbeddings. Those writes are
      // already queued against this table. Take the same write slot for the
      // drop so we cannot delete the table out from under an append that is
      // mid-flight; the rows die with the table either way, but the append
      // must not fault on a handle whose manifest just vanished.
      const { enqueueTableWrite } = await import('../embedding/vectorWriteQueue.js');
      const r = writeTable
        ? await enqueueTableWrite(writeTable, () => dropShadowCodeTable())
        : await dropShadowCodeTable();
      appendError(jobId, { projectId: 0, message: `shadow '${r.name}' DISCARDED — ${r.rows} vectors destroyed (operator-confirmed)` });
    } catch (err) {
      appendError(jobId, { projectId: 0, message: `discard failed: ${(err as Error).message}` });
    }
  }
}

export interface PromoteDecision {
  promote: boolean;
  reason: string;
}

/**
 * Whether a shadow may be promoted.
 *
 * `force` is the "Promote anyway" action: it accepts a substantially-complete
 * shadow rather than banking nothing. The caller MUST have shown the operator
 * that the missing projects will have no vectors until a fill-missing run.
 */
export function decidePromotion(
  done: number,
  total: number,
  rows: number,
  force = false,
): PromoteDecision {
  if (rows <= 0) return { promote: false, reason: 'shadow is empty' };
  if (done >= total) return { promote: true, reason: `complete (${done}/${total})` };
  if (force) {
    return {
      promote: true,
      reason: `forced at ${done}/${total} projects, ${rows} rows — the ${total - done} missing project(s) will have `
        + 'NO vectors until a fill-missing run',
    };
  }
  return { promote: false, reason: `incomplete (${done}/${total}); live table kept` };
}

/** Snapshot for the dashboard's pending-shadow banner. */
export interface PendingShadowView {
  name: string;
  rows: number;
  projects: number;
  job?: Pick<ReembedJob, 'id' | 'status' | 'doneProjects' | 'totalProjects' | 'startedAt'>;
  canResume: boolean;
  canDiscard: boolean;
  canPromoteAnyway: boolean;
}
