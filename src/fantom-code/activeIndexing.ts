/**
 * In-memory registry of projects with an index pass running right now.
 *
 * `index_runs.finished_at IS NULL` does not mean "in progress": a run that
 * crashed (or died with the process) keeps a NULL finished_at forever. The
 * only reliable signal is this process's own bookkeeping, so
 * CodeIndexingService.indexProject / reindexFiles mark the project here for
 * the length of the pass. Counted, not a Set: two passes of one project can
 * overlap (indexProject has no project lock).
 */

const active = new Map<number, number>();

/** Mark `projectId` as indexing. Returns the (idempotent) end function. */
export function beginProjectIndexing(projectId: number): () => void {
  active.set(projectId, (active.get(projectId) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const n = (active.get(projectId) ?? 1) - 1;
    if (n <= 0) active.delete(projectId);
    else active.set(projectId, n);
  };
}

export function isProjectIndexing(projectId: number): boolean {
  return (active.get(projectId) ?? 0) > 0;
}

export function _resetActiveIndexingForTests(): void {
  active.clear();
}
