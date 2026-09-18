/**
 * In-memory background job tracker for /admin/vectors/re-embed.
 *
 * The synchronous endpoint is kept for back-compat. The new async path
 * registers a job, kicks off the actual loop in the next tick, and returns
 * the jobId immediately. Clients poll GET /admin/vectors/re-embed/jobs/:id
 * for progress.
 */

import { randomUUID } from 'crypto';

export interface ReembedJobError {
  projectId: number;
  message: string;
}

export interface ReembedJob {
  id: string;
  scope: 'all' | { projectId: number };
  /**
   * `paused` and `cancelled` are deliberately distinct, and the difference is
   * what happens to the shadow table, not what happens to the loop:
   *
   *   paused    — loop halted, shadow KEPT, resumable. Reversible.
   *   cancelled — loop halted, shadow DROPPED. Irreversible; operator-confirmed.
   *
   * Both used to be spelled "cancelled". The shadow was already kept on every
   * exit path, so no data was lost — but a stop that preserved 225,008 rows
   * across 324 projects still read as total data loss.
   */
  status: 'queued' | 'running' | 'paused' | 'done' | 'error' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  totalProjects: number;
  doneProjects: number;
  currentProjectId?: number;
  generated: number;
  deleted: number;
  errors: ReembedJobError[];
  model?: string;
  dimensions?: number;
  droppedTableForDimChange?: boolean;
  previousDimensions?: number | null;
  /** Halt the loop AND discard the shadow. The only destructive flag. */
  cancelRequested: boolean;
  /** Halt the loop and KEEP the shadow, so a resume can continue from it. */
  pauseRequested: boolean;
  /** True when this job resumed an existing shadow rather than rebuilding. */
  resumed?: boolean;
  /** Projects skipped on resume because they were already complete. */
  skippedProjects?: number;
  /** Shadow slot this job is building into, for the pending-shadow banner. */
  shadowTable?: string | null;
  errorMessage?: string;
}

const jobs = new Map<string, ReembedJob>();
const MAX_RECENT = 20;

export function createJob(scope: ReembedJob['scope']): ReembedJob {
  const job: ReembedJob = {
    id: randomUUID(),
    scope,
    status: 'queued',
    startedAt: new Date().toISOString(),
    totalProjects: 0,
    doneProjects: 0,
    generated: 0,
    deleted: 0,
    errors: [],
    cancelRequested: false,
    pauseRequested: false,
  };
  jobs.set(job.id, job);
  // Trim oldest finished jobs. A `paused` job is NOT finished — it is waiting
  // to be resumed, and trimming it would hide banked work.
  const finished =[...jobs.values()].filter(j => j.status === 'done' || j.status === 'error' || j.status === 'cancelled');
  if (finished.length > MAX_RECENT) {
    finished
      .sort((a, b) => Date.parse(a.finishedAt ?? a.startedAt) - Date.parse(b.finishedAt ?? b.startedAt))
      .slice(0, finished.length - MAX_RECENT)
      .forEach(j => jobs.delete(j.id));
  }
  return job;
}

export function getJob(id: string): ReembedJob | undefined {
  return jobs.get(id);
}

export function listJobs(): ReembedJob[] {
  return [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function updateJob(id: string, patch: Partial<ReembedJob>): ReembedJob | undefined {
  const j = jobs.get(id);
  if (!j) return;
  Object.assign(j, patch);
  return j;
}

/**
 * DISCARD: halt the loop and drop the shadow. Irreversible — the caller is
 * responsible for having confirmed it with the operator and for having told
 * them how many vectors and projects it destroys.
 */
export function requestCancel(id: string): ReembedJob | undefined {
  const j = jobs.get(id);
  if (!j) return;
  if (j.status === 'queued' || j.status === 'running' || j.status === 'paused') {
    j.cancelRequested = true;
  }
  return j;
}

/**
 * PAUSE: halt the loop and KEEP the shadow. Reversible — a resume continues
 * from the banked rows, skipping projects already complete.
 */
export function requestPause(id: string): ReembedJob | undefined {
  const j = jobs.get(id);
  if (!j) return;
  if (j.status === 'queued' || j.status === 'running') {
    j.pauseRequested = true;
  }
  return j;
}

/** A job waiting to be resumed, if any. */
export function findPausedJob(): ReembedJob | undefined {
  return listJobs().find(j => j.status === 'paused');
}

/** A job currently occupying the single re-embed slot. `paused` does NOT
 *  count — the whole point of pausing is to free the fleet. */
export function findActiveJob(): ReembedJob | undefined {
  return listJobs().find(j => j.status === 'running' || j.status === 'queued');
}

/** Test seam. */
export function __resetJobsForTest(): void {
  jobs.clear();
}

export function appendError(id: string, err: ReembedJobError): void {
  const j = jobs.get(id);
  if (!j) return;
  j.errors.push(err);
  // Cap to avoid memory blowup on a noisy run.
  if (j.errors.length > 500) j.errors.splice(0, j.errors.length - 500);
}
