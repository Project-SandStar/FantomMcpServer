/**
 * Change set → queued task (lazy-incremental-indexing.md 3.2.2 step 6,
 * 3.2.3 consequences, 3.2.6 thresholds). Pure: the scheduler enqueues the
 * result.
 */

import { isSwitchLike } from './gitReflog.js';
import { changeCount } from './changeDetector.js';
import { MAX_PAYLOAD_PATHS } from './taskQueue.js';
import { PRIORITY, type ChangeSet, type ParsePayload, type TaskKind } from './types.js';

export interface PlanOptions {
  isPrimary: boolean;
  /** indexed_files rows of the project (the share denominator). */
  projectFiles: number;
  maxChangedShareForIncremental: number;
  maxFilesPerDiff: number;
  rewriteAsSwitchFiles: number;
}

export interface TaskPlan {
  kind: TaskKind;
  priority: number;
  payload: ParsePayload;
  /** Counts only (RunDiff.checkout): switch, unknown, or a big rewrite. */
  checkout: boolean;
}

/** null = nothing to index (the caller may still move the base commit). */
export function planForChangeSet(cs: ChangeSet, o: PlanOptions): TaskPlan | null {
  const n = changeCount(cs);
  if (n === 0) return null;
  const checkout = cs.git ? isSwitchLike(cs.git.headMove, n, o.rewriteAsSwitchFiles) : false;
  const priority = checkout ? PRIORITY.background : (o.isPrimary ? PRIORITY.primary : PRIORITY.normal);
  const base: ParsePayload = {
    source: cs.source,
    rootId: cs.rootId,
    paths: [...cs.added, ...cs.modified, ...cs.renamed.map(r => r.to)],
    removed: [...cs.removed, ...cs.renamed.map(r => r.from)],
    renamed: cs.renamed,
    ...(cs.git ? { git: cs.git } : {}),
    checkout,
  };
  const overCap = n > o.maxFilesPerDiff || base.paths.length + base.removed.length > MAX_PAYLOAD_PATHS;
  const share = o.projectFiles > 0 ? n / o.projectFiles : 0;
  // A seeding project (no rows) is a scan, not a share question.
  if (overCap || (o.projectFiles > 0 && share > o.maxChangedShareForIncremental)) {
    return {
      kind: 'full-reindex',
      priority: PRIORITY.background,
      checkout,
      payload: {
        ...base,
        // Above the cap the path list is dropped (3.2.6, 3.10 budget).
        paths: overCap ? [] : base.paths,
        removed: overCap ? [] : base.removed,
        renamed: overCap ? [] : base.renamed,
        full: true,
        reason: overCap ? `${n} files > maxFilesPerDiff ${o.maxFilesPerDiff}` : `share ${(share * 100).toFixed(0)}% > ${(o.maxChangedShareForIncremental * 100).toFixed(0)}%`,
      },
    };
  }
  return { kind: 'parse', priority, checkout, payload: base };
}
