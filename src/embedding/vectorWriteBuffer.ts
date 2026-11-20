/**
 * Bounded write buffer with grouped commits, per LanceDB table (ORDW-05).
 *
 * Producers (embed workers) hand in rows grouped by their delete key (the base
 * `node_id` for code, `doc_id` for docs). The buffer:
 *
 *  - BOUNDS the backlog: a producer waits until the table's buffer holds fewer
 *    than `maxPendingRows` rows (a call larger than the limit is admitted only
 *    when the buffer is empty). Waiters wake in FIFO order. Rows are never
 *    dropped.
 *  - GROUPS commits: the single writer per table (the `vectorWriteQueue`
 *    chain) takes up to `writeBatchRows` rows per commit: one delete + one add
 *    instead of one each per 100 rows. One group (all chunk rows of one node)
 *    is never split across two commits; if two producers bring the same group
 *    into one commit, the later rows win (as the old delete-then-add order did).
 *  - KEEPS ORDER against direct writes on the same table (`deleteProjectVectors`
 *    and friends): every direct `enqueueWrite` starts a new epoch, and one
 *    drain job per epoch commits only that epoch's rows.
 *  - LIMITS a failure's reach: when a grouped add fails, each producer's part is
 *    committed again on its own and only the failing producers get the error
 *    (their rows still in the buffer are dropped from it, as the old code
 *    stopped at the failed sub-batch). Capacity is always released.
 */

import { enqueueOnChain, writeEpoch, tableKey, vectorWriteQueueStats } from './vectorWriteQueue.js';
import { getVectorWriteSettings, VECTOR_WRITE_CONCURRENCY } from './vectorWriteSettings.js';

/** Rows that replace each other as one unit: delete by `key`, then add `rows`. */
export interface RowGroup<R = Record<string, unknown>> {
  key: string;
  rows: R[];
}

/**
 * Commit one batch: delete every group key, then add every row, in one delete
 * + one add. Must throw when the add fails.
 */
export type CommitFn<R = Record<string, unknown>> = (table: unknown, groups: RowGroup<R>[]) => Promise<void>;

interface Ticket {
  epoch: number;
  table: unknown;
  commit: CommitFn<any>;
  groups: RowGroup<any>[];
  cursor: number;      // next group to hand to the writer
  untakenRows: number; // rows not yet handed to the writer
  inflight: number;    // commits holding this ticket's rows
  stored: number;
  failed?: unknown;
  resolve: (n: number) => void;
  reject: (e: unknown) => void;
}

interface Waiter { rows: number; wake: () => void }

interface TableState {
  key: string;
  pending: Ticket[];
  bufferRows: number;
  waiters: Waiter[];
  drainEpochs: Set<number>;
  // stats
  commits: number;
  failedCommits: number;
  rowsWritten: number;
  lastCommitMs: number;
  totalCommitMs: number;
  producerWaitMs: number;
  recent: Array<{ at: number; rows: number }>;
}

const RATE_WINDOW_MS = 60_000;
const states = new Map<string, TableState>();

function stateOf(key: string): TableState {
  let st = states.get(key);
  if (!st) {
    st = {
      key, pending: [], bufferRows: 0, waiters: [], drainEpochs: new Set(),
      commits: 0, failedCommits: 0, rowsWritten: 0, lastCommitMs: 0, totalCommitMs: 0,
      producerWaitMs: 0, recent: [],
    };
    states.set(key, st);
  }
  return st;
}

function hasRoom(st: TableState, rows: number, max: number): boolean {
  return st.bufferRows === 0 || st.bufferRows + rows <= max;
}

/** Wake waiters in order while they fit; each woken waiter's rows are counted at once. */
function wakeWaiters(st: TableState): void {
  if (st.waiters.length === 0) return;
  const { maxPendingRows } = getVectorWriteSettings();
  while (st.waiters.length && hasRoom(st, st.waiters[0].rows, maxPendingRows)) {
    const w = st.waiters.shift()!;
    st.bufferRows += w.rows;
    w.wake();
  }
}

function releaseRows(st: TableState, rows: number): void {
  st.bufferRows = Math.max(0, st.bufferRows - rows);
  wakeWaiters(st);
}

/** Reserve `rows` in the buffer; the room check and the count are one synchronous step. */
async function reserve(st: TableState, rows: number): Promise<void> {
  const { maxPendingRows } = getVectorWriteSettings();
  if (st.waiters.length === 0 && hasRoom(st, rows, maxPendingRows)) {
    st.bufferRows += rows;
    return;
  }
  const t0 = Date.now();
  await new Promise<void>(wake => st.waiters.push({ rows, wake }));
  st.producerWaitMs += Date.now() - t0;
}

/**
 * Resolve when `table`'s buffer has room for `rows` more rows. Does not
 * reserve: a worker pool calls this before it takes its next job, and the
 * store call itself reserves.
 */
export async function waitForRoom(table: unknown, rows: number): Promise<void> {
  const st = stateOf(tableKey(table));
  if (st.waiters.length === 0 && hasRoom(st, rows, getVectorWriteSettings().maxPendingRows)) return;
  const t0 = Date.now();
  await new Promise<void>(resolve => {
    const poll = () => {
      if (st.waiters.length === 0 && hasRoom(st, rows, getVectorWriteSettings().maxPendingRows)) resolve();
      else st.waiters.push({ rows: 0, wake: () => setImmediate(poll) });
    };
    poll();
  });
  st.producerWaitMs += Date.now() - t0;
}

/**
 * Hand rows to `table`'s buffer and resolve with the number of rows stored once
 * they are committed. Waits first while the buffer is full. Rejects with the
 * commit error when this caller's rows could not be written.
 */
export async function submitRows<R>(table: unknown, commit: CommitFn<R>, groups: RowGroup<R>[]): Promise<number> {
  const live = groups.filter(g => g.rows.length > 0);
  const rows = live.reduce((n, g) => n + g.rows.length, 0);
  if (rows === 0) return 0;
  const key = tableKey(table);
  const st = stateOf(key);
  await reserve(st, rows);
  // Epoch is read AFTER the wait: these rows are ordered by when they enter
  // the buffer, as before they were ordered by when they entered the chain.
  const epoch = writeEpoch(key);
  return new Promise<number>((resolve, reject) => {
    st.pending.push({
      epoch, table, commit: commit as CommitFn<any>, groups: live, cursor: 0, untakenRows: rows,
      inflight: 0, stored: 0, resolve, reject,
    });
    scheduleDrain(st, epoch);
  });
}

function scheduleDrain(st: TableState, epoch: number): void {
  if (st.drainEpochs.has(epoch)) return;
  st.drainEpochs.add(epoch);
  // drain() never rejects; the catch is a guard against an unhandled rejection.
  void enqueueOnChain(st.key, () => drain(st, epoch)).catch(() => undefined);
}

interface Part { ticket: Ticket; groups: RowGroup<any>[]; rows: number }

/** Take the next batch of one epoch: same table handle and commit fn, at most writeBatchRows. */
function takeBatch(st: TableState, epoch: number): Part[] | null {
  const head = st.pending.find(t => t.epoch === epoch && !t.failed && t.cursor < t.groups.length);
  if (!head) return null;
  const { writeBatchRows } = getVectorWriteSettings();
  const parts: Part[] = [];
  let total = 0;
  for (const t of st.pending) {
    if (t.epoch !== epoch || t.failed || t.cursor >= t.groups.length) continue;
    if (t.table !== head.table || t.commit !== head.commit) break;
    const part: Part = { ticket: t, groups: [], rows: 0 };
    while (t.cursor < t.groups.length) {
      const g = t.groups[t.cursor];
      if (total > 0 && total + g.rows.length > writeBatchRows) break;
      part.groups.push(g);
      part.rows += g.rows.length;
      total += g.rows.length;
      t.cursor++;
    }
    if (part.groups.length) {
      t.untakenRows -= part.rows;
      t.inflight++;
      parts.push(part);
    }
    if (total >= writeBatchRows || t.cursor < t.groups.length) break;
  }
  return parts;
}

/** Later groups with the same key replace earlier ones in the same commit. */
function dedupe(parts: Part[]): RowGroup<any>[] {
  const byKey = new Map<string, RowGroup<any>>();
  for (const p of parts) for (const g of p.groups) {
    byKey.delete(g.key); // keep the insertion order of the LAST occurrence
    byKey.set(g.key, g);
  }
  return [...byKey.values()];
}

function failTicket(st: TableState, t: Ticket, err: unknown): void {
  if (t.failed) return;
  t.failed = err;
  // Rows not yet handed to the writer are dropped from the buffer; the
  // producer has the error and decides what to do (as with the old throw).
  if (t.untakenRows > 0) { const n = t.untakenRows; t.untakenRows = 0; t.cursor = t.groups.length; releaseRows(st, n); }
}

function settleTicket(st: TableState, t: Ticket): void {
  if (t.inflight > 0) return;
  if (!t.failed && t.cursor < t.groups.length) return;
  const i = st.pending.indexOf(t);
  if (i >= 0) st.pending.splice(i, 1);
  if (t.failed) t.reject(t.failed); else t.resolve(t.stored);
}

function recordCommit(st: TableState, ms: number, rows: number, ok: boolean): void {
  st.lastCommitMs = ms;
  if (!ok) { st.failedCommits++; return; }
  st.commits++;
  st.totalCommitMs += ms;
  st.rowsWritten += rows;
  const now = Date.now();
  st.recent.push({ at: now, rows });
  while (st.recent.length && now - st.recent[0].at > RATE_WINDOW_MS) st.recent.shift();
}

async function runCommit(st: TableState, table: unknown, commit: CommitFn<any>, groups: RowGroup<any>[]): Promise<void> {
  const rows = groups.reduce((n, g) => n + g.rows.length, 0);
  const t0 = Date.now();
  try {
    await commit(table, groups);
    recordCommit(st, Date.now() - t0, rows, true);
  } catch (err) {
    recordCommit(st, Date.now() - t0, rows, false);
    throw err;
  }
}

async function commitBatch(st: TableState, parts: Part[]): Promise<void> {
  const { table, commit } = parts[0].ticket;
  try {
    await runCommit(st, table, commit, dedupe(parts));
    for (const p of parts) p.ticket.stored += p.rows;
  } catch (err) {
    if (parts.length === 1) {
      failTicket(st, parts[0].ticket, err);
    } else {
      // One producer's bad rows must not cost the others: commit each part
      // on its own, in order (a later part's delete still replaces an
      // earlier part's rows of the same key).
      for (const p of parts) {
        try {
          await runCommit(st, table, commit, p.groups);
          p.ticket.stored += p.rows;
        } catch (e) {
          failTicket(st, p.ticket, e);
        }
      }
    }
  } finally {
    for (const p of parts) p.ticket.inflight--;
    releaseRows(st, parts.reduce((n, p) => n + p.rows, 0));
    for (const p of parts) settleTicket(st, p.ticket);
  }
}

async function drain(st: TableState, epoch: number): Promise<void> {
  try {
    for (;;) {
      const parts = takeBatch(st, epoch);
      if (!parts || parts.length === 0) break;
      await commitBatch(st, parts);
    }
  } catch {
    // commitBatch handles its own errors; nothing may escape the chain job.
  } finally {
    st.drainEpochs.delete(epoch);
    // Anything of this epoch left behind (should not happen) gets a new job.
    if (st.pending.some(t => t.epoch === epoch && !t.failed && t.cursor < t.groups.length)) scheduleDrain(st, epoch);
  }
}

// ============================================
// Stats
// ============================================

export interface VectorWriteTableStats {
  table: string;
  /** Jobs on the table's write chain (drains + direct writes). */
  queued: number;
  bufferRows: number;
  waitingProducers: number;
  pendingCalls: number;
  commits: number;
  failedCommits: number;
  rowsWritten: number;
  lastCommitMs: number;
  meanCommitMs: number;
  rowsPerSec: number;
  producerWaitMs: number;
}

export interface VectorWriteStats {
  maxPendingRows: number;
  writeBatchRows: number;
  writeConcurrency: number;
  rateWindowSec: number;
  tables: VectorWriteTableStats[];
  totals: Omit<VectorWriteTableStats, 'table'>;
}

/**
 * Write-path stats for the OpenRouter page: the buffer per table plus the
 * chain depth (`queued`, same number as `vectorWriteQueueStats`).
 */
export function getVectorWriteStats(): VectorWriteStats {
  const { maxPendingRows, writeBatchRows } = getVectorWriteSettings();
  const now = Date.now();
  const depth = new Map(vectorWriteQueueStats().map(q => [q.table, q.queued]));
  for (const k of depth.keys()) stateOf(k);
  const tables: VectorWriteTableStats[] = [...states.values()].map(st => {
    const recentRows = st.recent.filter(r => now - r.at <= RATE_WINDOW_MS).reduce((n, r) => n + r.rows, 0);
    return {
      table: st.key,
      queued: depth.get(st.key) ?? 0,
      bufferRows: st.bufferRows,
      waitingProducers: st.waiters.length,
      pendingCalls: st.pending.length,
      commits: st.commits,
      failedCommits: st.failedCommits,
      rowsWritten: st.rowsWritten,
      lastCommitMs: st.lastCommitMs,
      meanCommitMs: st.commits ? Math.round(st.totalCommitMs / st.commits) : 0,
      rowsPerSec: Math.round((recentRows / (RATE_WINDOW_MS / 1000)) * 10) / 10,
      producerWaitMs: st.producerWaitMs,
    };
  });
  const sum = (f: (t: VectorWriteTableStats) => number) => tables.reduce((n, t) => n + f(t), 0);
  const commits = sum(t => t.commits);
  const totalMs = [...states.values()].reduce((n, st) => n + st.totalCommitMs, 0);
  const last = [...states.values()].reduce((m, st) => Math.max(m, st.lastCommitMs), 0);
  return {
    maxPendingRows, writeBatchRows, writeConcurrency: VECTOR_WRITE_CONCURRENCY,
    rateWindowSec: RATE_WINDOW_MS / 1000,
    tables,
    totals: {
      queued: sum(t => t.queued),
      bufferRows: sum(t => t.bufferRows),
      waitingProducers: sum(t => t.waitingProducers),
      pendingCalls: sum(t => t.pendingCalls),
      commits,
      failedCommits: sum(t => t.failedCommits),
      rowsWritten: sum(t => t.rowsWritten),
      lastCommitMs: last,
      meanCommitMs: commits ? Math.round(totalMs / commits) : 0,
      rowsPerSec: Math.round(sum(t => t.rowsPerSec) * 10) / 10,
      producerWaitMs: sum(t => t.producerWaitMs),
    },
  };
}

/** Test seam. */
export function __resetVectorWriteBufferForTest(): void {
  states.clear();
}
