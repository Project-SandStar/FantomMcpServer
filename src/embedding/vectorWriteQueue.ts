/**
 * Single-writer serialization for LanceDB.
 *
 * LanceDB commits a new manifest version per append. There is no
 * commit-conflict handling anywhere in this codebase — no retry, no
 * optimistic-concurrency loop, nothing that catches a version collision. So
 * two concurrent appends to the same table will collide, and the loser's rows
 * are simply lost (or the append throws and the batch is counted as an error,
 * which is how a "successful" run ends up short).
 *
 * That was survivable while project embedding was strictly sequential. It is
 * not survivable once projects run concurrently. The design is therefore:
 *
 *   **PARALLEL EMBED, SINGLE-WRITER STORE.**
 *
 * Embedding — the expensive, network-bound part — runs across as many
 * projects and providers as we like. Every *write* funnels through one
 * serialized queue per table. Appends are milliseconds next to embedding, so
 * a single writer is not the bottleneck; a corrupted manifest would be.
 *
 * Scope note: the queue is keyed per TABLE, not globally. The live slot and
 * an in-flight shadow rebuild are different tables with different manifests,
 * so serializing them against each other would needlessly halve throughput
 * during a rebuild. Compaction/optimize, when it exists, must be submitted
 * through `enqueueWrite` for the same table so it never runs concurrently
 * with an append.
 */

/** table key → tail of that table's write chain. */
const chains = new Map<string, Promise<unknown>>();
const depths = new Map<string, number>();

export interface WriteQueueStats {
  table: string;
  queued: number;
}

export function vectorWriteQueueStats(): WriteQueueStats[] {
  return [...depths.entries()].map(([table, queued]) => ({ table, queued }));
}

/**
 * Derive a stable key for a LanceDB table handle. Falls back to a single
 * shared key when the handle exposes no name — serializing too much is a
 * throughput cost; serializing too little is data loss.
 */
export function tableKey(table: unknown): string {
  const n = (table as { name?: unknown })?.name;
  if (typeof n === 'string' && n) return n;
  if (typeof n === 'function') {
    try {
      const v = (n as () => unknown).call(table);
      if (typeof v === 'string' && v) return v;
    } catch { /* fall through */ }
  }
  return '__default__';
}

/**
 * Run `fn` with exclusive access to `key`'s write slot. Submissions run in
 * call order; a rejection does not poison the chain for later writers.
 */
export function enqueueWrite<T>(key: string, fn: () => Promise<T>): Promise<T> {
  depths.set(key, (depths.get(key) ?? 0) + 1);
  const prior = chains.get(key) ?? Promise.resolve();
  // `.then(settle, settle)` so one failed write does not reject every write
  // queued behind it.
  const run = prior.then(() => fn(), () => fn());
  chains.set(key, run.then(() => undefined, () => undefined));
  return run.finally(() => {
    const d = (depths.get(key) ?? 1) - 1;
    if (d <= 0) depths.delete(key); else depths.set(key, d);
  });
}

/** Convenience wrapper for a LanceDB table handle. */
export function enqueueTableWrite<T>(table: unknown, fn: () => Promise<T>): Promise<T> {
  return enqueueWrite(tableKey(table), fn);
}

/** Test seam. */
export function __resetVectorWriteQueueForTest(): void {
  chains.clear();
  depths.clear();
}
