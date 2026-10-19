/**
 * Durable task queue on `index_tasks` (lazy-incremental-indexing.md 3.3).
 *
 * - Dedupe: one claimable (pending or yielded) row per (project, kind) via
 *   `dedupe_key = "<projectId>:<kind>"`. A new git change set replaces the
 *   pending candidate list (it is always diffed from last_indexed_commit, so
 *   the newest is complete); other sources union into it. A claimed row
 *   drops its key so the next change makes a fresh row.
 * - A pending full-reindex cancels the project's pending parse and embed
 *   rows; a parse enqueued behind a pending full-reindex is skipped.
 * - Claim: one transaction, lowest priority first, then oldest nextRunAt.
 *   The lease is for crash recovery only: workers are in-process, so every
 *   `running` row owned by another process is stale at boot.
 * - Retry: attempts++, nextRunAt = now + backoffMs * 2^(attempts-1), capped;
 *   after maxAttempts the row is `failed`.
 * - Yield: back-pressure (heavy-job lock, memory guard). No attempt is
 *   spent, nextRunAt = now + heavyJobPollMs, priority -1 (floor 1) so a
 *   project cannot starve behind newer work.
 */

import type { PrismaClient, IndexTask, Prisma } from '@prisma/client';
import { PRIORITY, type ParsePayload, type TaskKind, type TaskState } from './types.js';

/** Above this many candidate paths a payload becomes a full scan (3.10 budget). */
export const MAX_PAYLOAD_PATHS = 5_000;

export interface TaskQueueOptions {
  owner: string;
  leaseMs: number;
  maxAttempts: number;
  backoffMs: number;
  backoffCapMs: number;
  heavyJobPollMs: number;
  now?: () => Date;
}

export interface EnqueueInput {
  projectId: number;
  kind: TaskKind;
  priority?: number;
  payload?: unknown;
  parentId?: number | null;
  runId?: number | null;
}

export interface EnqueueResult {
  id: number | null;
  action: 'created' | 'merged' | 'skipped';
  /** Rows cancelled by a full-reindex. */
  cancelled?: number;
}

export interface YieldInput {
  /** 'heavy-job' | 'memory' | 'project-busy' | ... — stored in result.paused. */
  reason: string;
  delayMs?: number;
  detail?: string;
}

export type Tx = Prisma.TransactionClient;

const CLAIMABLE: TaskState[] = ['pending', 'yielded'];

export function dedupeKeyFor(projectId: number, kind: TaskKind): string {
  return `${projectId}:${kind}`;
}

function uniq(xs: string[]): string[] { return [...new Set(xs)]; }

/**
 * Merge a newer payload into an older pending one (3.2.6). Pure.
 * Non-parse payloads: the newer one wins.
 */
export function mergePayload(older: any, newer: any): any {
  if (!older || typeof older !== 'object') return newer ?? {};
  if (!newer || typeof newer !== 'object') return older;
  if (!('paths' in older) && !('paths' in newer)) return { ...older, ...newer };
  const o = older as ParsePayload, n = newer as ParsePayload;
  let paths: string[], removed: string[], renamed: ParsePayload['renamed'];
  if (n.source === 'git' && o.source === 'git') {
    // Newest git set is complete from the same base: replace.
    paths = n.paths ?? []; removed = n.removed ?? []; renamed = n.renamed ?? [];
  } else {
    paths = uniq([...(o.paths ?? []), ...(n.paths ?? [])]);
    removed = uniq([...(o.removed ?? []), ...(n.removed ?? [])]);
    const seen = new Set<string>();
    renamed = [...(o.renamed ?? []), ...(n.renamed ?? [])].filter(r => {
      const k = `${r.from}\0${r.to}`; if (seen.has(k)) return false; seen.add(k); return true;
    });
  }
  // A path both removed and present again is a candidate, not a removal.
  const present = new Set(paths);
  removed = removed.filter(p => !present.has(p));
  let full = !!(o.full || n.full);
  if (paths.length + removed.length > MAX_PAYLOAD_PATHS) { full = true; paths = []; removed = []; renamed = []; }
  return {
    ...o, ...n,
    // A git context always comes from the newest git set; a scan's context
    // (from = to = HEAD) never replaces a real diff's.
    source: n.source === 'git' || o.source === 'git' ? 'git' : n.source,
    git: n.source === 'git' ? (n.git ?? o.git) : o.source === 'git' ? (o.git ?? n.git) : (n.git ?? o.git),
    rootId: n.rootId ?? o.rootId ?? null,
    paths, removed, renamed, full,
    ...mergeReports(o, n),
  };
}

/** Max change reports kept on one task payload (3.11.2). */
export const MAX_PAYLOAD_REPORTS = 50;

function mergeReports(o: ParsePayload, n: ParsePayload): Pick<ParsePayload, 'trigger' | 'reports'> {
  const reports = [...(o.reports ?? []), ...(n.reports ?? [])].slice(-MAX_PAYLOAD_REPORTS);
  const trigger = o.trigger ?? n.trigger;
  return { ...(trigger ? { trigger } : {}), ...(reports.length ? { reports } : {}) };
}

export function backoffDelayMs(attemptsAfterFailure: number, baseMs: number, capMs: number): number {
  return Math.min(capMs, baseMs * Math.pow(2, Math.max(0, attemptsAfterFailure - 1)));
}

export class TaskQueue {
  private readonly now: () => Date;

  constructor(private readonly prisma: PrismaClient, private readonly opts: TaskQueueOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  get owner(): string { return this.opts.owner; }

  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    const priority = input.priority ?? PRIORITY.normal;
    const payload = input.payload ?? {};
    return this.prisma.$transaction(async tx => {
      let cancelled = 0;
      if (input.kind === 'full-reindex') {
        // A full rebuild covers every pending parse and the embed it would make.
        const r = await tx.indexTask.updateMany({
          where: { projectId: input.projectId, kind: { in: ['parse', 'embed'] }, state: { in: CLAIMABLE } },
          data: { state: 'cancelled', dedupeKey: null, finishedAt: this.now(), error: 'superseded by full-reindex' },
        });
        cancelled = r.count;
      } else if (input.kind === 'parse') {
        const full = await tx.indexTask.findUnique({ where: { dedupeKey: dedupeKeyFor(input.projectId, 'full-reindex') } });
        if (full) {
          // The pending full rebuild keeps the newest git context for its base move.
          const p = (payload as ParsePayload);
          if (p.git) {
            const fp = safeParse(full.payload);
            await tx.indexTask.update({ where: { id: full.id }, data: { payload: JSON.stringify({ ...fp, git: p.git, rootId: p.rootId ?? fp.rootId ?? null }) } });
          }
          return { id: full.id, action: 'skipped' as const };
        }
      }
      const key = dedupeKeyFor(input.projectId, input.kind);
      const existing = await tx.indexTask.findUnique({ where: { dedupeKey: key } });
      if (existing) {
        const merged = mergePayload(safeParse(existing.payload), payload);
        await tx.indexTask.update({
          where: { id: existing.id },
          data: {
            payload: JSON.stringify(merged),
            priority: Math.min(existing.priority, priority),
            runId: input.runId ?? existing.runId,
            parentId: input.parentId ?? existing.parentId,
          },
        });
        return { id: existing.id, action: 'merged' as const, cancelled };
      }
      const row = await tx.indexTask.create({
        data: {
          projectId: input.projectId,
          kind: input.kind,
          priority,
          payload: JSON.stringify(payload),
          dedupeKey: key,
          maxAttempts: this.opts.maxAttempts,
          nextRunAt: this.now(),
          parentId: input.parentId ?? null,
          runId: input.runId ?? null,
        },
      });
      return { id: row.id, action: 'created' as const, cancelled };
    });
  }

  /** Claim the next due task of one of `kinds`, or null. */
  async claim(kinds: TaskKind[]): Promise<IndexTask | null> {
    const now = this.now();
    return this.prisma.$transaction(async tx => {
      const row = await tx.indexTask.findFirst({
        where: { state: { in: CLAIMABLE }, kind: { in: kinds }, nextRunAt: { lte: now } },
        orderBy: [{ priority: 'asc' }, { nextRunAt: 'asc' }, { id: 'asc' }],
      });
      if (!row) return null;
      // Guarded update: a row another claimer took in between is not ours.
      const r = await tx.indexTask.updateMany({
        where: { id: row.id, state: { in: CLAIMABLE } },
        data: {
          state: 'running',
          dedupeKey: null,
          leaseOwner: this.opts.owner,
          leaseUntil: new Date(now.getTime() + this.opts.leaseMs),
          startedAt: now,
          error: null,
        },
      });
      if (r.count !== 1) return null;
      return tx.indexTask.findUnique({ where: { id: row.id } });
    });
  }

  /**
   * Claim one known row now, ignoring nextRunAt and priority order: a focus
   * refresh or a change report runs its own task at once (3.11). Null when
   * the row is not claimable (another worker took it, or it is finished).
   */
  async claimById(id: number): Promise<IndexTask | null> {
    const now = this.now();
    const r = await this.prisma.indexTask.updateMany({
      where: { id, state: { in: CLAIMABLE } },
      data: {
        state: 'running',
        dedupeKey: null,
        leaseOwner: this.opts.owner,
        leaseUntil: new Date(now.getTime() + this.opts.leaseMs),
        startedAt: now,
        error: null,
      },
    });
    if (r.count !== 1) return null;
    return this.prisma.indexTask.findUnique({ where: { id } });
  }

  async renewLease(id: number): Promise<void> {
    await this.prisma.indexTask.updateMany({
      where: { id, state: 'running', leaseOwner: this.opts.owner },
      data: { leaseUntil: new Date(this.now().getTime() + this.opts.leaseMs) },
    });
  }

  async complete(id: number, result?: unknown, runId?: number | null): Promise<void> {
    await this.prisma.indexTask.update({
      where: { id },
      data: {
        state: 'done', leaseOwner: null, leaseUntil: null, finishedAt: this.now(),
        result: result === undefined ? null : JSON.stringify(result),
        ...(runId != null ? { runId } : {}),
      },
    });
  }

  /** A hard failure: retry with backoff, or `failed` after maxAttempts. */
  async fail(id: number, error: string): Promise<TaskState> {
    return this.prisma.$transaction(async tx => {
      const row = await tx.indexTask.findUnique({ where: { id } });
      if (!row) return 'failed' as TaskState;
      const attempts = row.attempts + 1;
      if (attempts >= row.maxAttempts) {
        await tx.indexTask.update({
          where: { id },
          data: { state: 'failed', attempts, error: error.slice(0, 4000), leaseOwner: null, leaseUntil: null, finishedAt: this.now() },
        });
        return 'failed' as TaskState;
      }
      const next = new Date(this.now().getTime() + backoffDelayMs(attempts, this.opts.backoffMs, this.opts.backoffCapMs));
      await tx.indexTask.update({
        where: { id },
        data: { state: 'pending', attempts, error: error.slice(0, 4000), nextRunAt: next, leaseOwner: null, leaseUntil: null },
      });
      return this.reattach(tx, id);
    });
  }

  /** Back-pressure: give the row back without spending an attempt. */
  async yieldTask(id: number, y: YieldInput): Promise<TaskState> {
    return this.prisma.$transaction(async tx => {
      const row = await tx.indexTask.findUnique({ where: { id } });
      if (!row) return 'cancelled' as TaskState;
      await tx.indexTask.update({
        where: { id },
        data: {
          state: 'yielded',
          priority: Math.max(1, row.priority - 1),
          nextRunAt: new Date(this.now().getTime() + (y.delayMs ?? this.opts.heavyJobPollMs)),
          leaseOwner: null, leaseUntil: null,
          result: JSON.stringify({ paused: y.reason, detail: y.detail ?? null, at: this.now().toISOString() }),
        },
      });
      return this.reattach(tx, id);
    });
  }

  /**
   * Boot / tick recovery: a `running` row whose owner is another process, or
   * whose lease ran out, goes back to `pending` with attempts + 1.
   */
  async recoverStaleLeases(): Promise<number> {
    const now = this.now();
    const stale = await this.prisma.indexTask.findMany({
      where: {
        state: 'running',
        OR: [{ leaseOwner: { not: this.opts.owner } }, { leaseOwner: null }, { leaseUntil: { lt: now } }],
      },
      select: { id: true },
    });
    for (const s of stale) {
      await this.fail(s.id, 'lease expired (worker gone)');
    }
    return stale.length;
  }

  async counts(): Promise<Record<string, number>> {
    const rows = await this.prisma.indexTask.groupBy({ by: ['state'], _count: { _all: true } });
    const out: Record<string, number> = {};
    for (const r of rows) out[r.state] = r._count._all;
    return out;
  }

  async get(id: number): Promise<IndexTask | null> {
    return this.prisma.indexTask.findUnique({ where: { id } });
  }

  /**
   * Give a re-queued row its dedupe key back. If a newer claimable row took
   * the key meanwhile, fold this row into it and cancel this one.
   */
  private async reattach(tx: Tx, id: number): Promise<TaskState> {
    const row = await tx.indexTask.findUnique({ where: { id } });
    if (!row) return 'cancelled';
    const key = dedupeKeyFor(row.projectId, row.kind as TaskKind);
    const holder = await tx.indexTask.findUnique({ where: { dedupeKey: key } });
    if (!holder) {
      // A pending full-reindex supersedes a re-queued parse or embed — only
      // those: a rekey is not covered by a rebuild and was being cancelled.
      if (row.kind === 'parse' || row.kind === 'embed') {
        const full = await tx.indexTask.findUnique({ where: { dedupeKey: dedupeKeyFor(row.projectId, 'full-reindex') } });
        if (full) {
          await tx.indexTask.update({ where: { id }, data: { state: 'cancelled', finishedAt: this.now(), error: 'superseded by full-reindex' } });
          return 'cancelled';
        }
      }
      await tx.indexTask.update({ where: { id }, data: { dedupeKey: key } });
      return row.state as TaskState;
    }
    if (holder.id === id) return row.state as TaskState;
    await tx.indexTask.update({
      where: { id: holder.id },
      data: {
        payload: JSON.stringify(mergePayload(safeParse(row.payload), safeParse(holder.payload))),
        priority: Math.min(holder.priority, row.priority),
      },
    });
    await tx.indexTask.update({ where: { id }, data: { state: 'cancelled', finishedAt: this.now(), error: `merged into task ${holder.id}` } });
    return 'cancelled';
  }
}

export function safeParse(s: string | null | undefined): any {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}
