/**
 * Shapes shared by the lazy indexing modules
 * (docs/proposals/lazy-incremental-indexing.md 3.2, 3.3).
 */

export type ChangeSource = 'git' | 'dirty' | 'mtime' | 'sha' | 'version' | 'forced';

export type HeadMoveKind = 'none' | 'edit' | 'integrate' | 'rewrite' | 'switch' | 'unknown';

export interface HeadMove {
  kind: HeadMoveKind;
  /** Reflog message of the newest consumed line ('' when none was read). */
  reflog: string;
  /** fromCommit is an ancestor of toCommit. */
  linear: boolean;
}

export interface CommitMeta {
  sha: string;
  parents: string[];
  author: string;
  /** Unix seconds. */
  authorTime: number;
  subject: string;
  /** Absolute paths, filtered to the project. */
  files: string[];
}

export interface GitContext {
  root: string;
  gitDir: string;
  gitCommonDir: string;
  /** Last indexed commit; null on the first git-aware run. */
  fromCommit: string | null;
  toCommit: string;
  branch: string | null;
  headMove: HeadMove;
  dirty: boolean;
  /** Oldest first, capped at git.maxCommitsPerRun. */
  commits: CommitMeta[];
}

export interface RenamedPath { from: string; to: string; similarity: number }

export interface ChangeSet {
  projectId: number;
  /** git_roots.id that owns these paths; null for scan-mode projects. */
  rootId: number | null;
  source: ChangeSource;
  /** Absolute paths. */
  added: string[];
  modified: string[];
  removed: string[];
  renamed: RenamedPath[];
  unchanged: number;
  git?: GitContext;
  scannedAt: string;
  scanMs: number;
}

/** 'rekey': stable symbol keys for one project (3.8), enqueued by hand only. */
export type TaskKind = 'parse' | 'full-reindex' | 'embed' | 'rekey' | 'vector-gc' | 'cache-prune';
export type TaskState = 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'yielded';

/** Payload of a `parse` or `full-reindex` task. */
export interface ParsePayload {
  source: ChangeSource;
  rootId: number | null;
  /** Candidate paths (added + modified + rename targets); the gate decides. */
  paths: string[];
  removed: string[];
  renamed: RenamedPath[];
  /** Candidate list unknown or over the cap: scan the whole project. */
  full?: boolean;
  git?: GitContext;
  /** Why a full-reindex was chosen (share, maxFilesPerDiff, ...). */
  reason?: string;
  /** Counts only (RunDiff.checkout): switch, unknown, or a big rewrite (taskPlanner). */
  checkout?: boolean;
  /** 'report': the AI said it changed these files (3.11.2); the run gets trigger 'report'. */
  trigger?: 'report';
  /**
   * AI change reports merged into this task, oldest first (capped). Holds
   * intent and sessionId until the phase 5 session tables exist (3.11.4).
   */
  reports?: ChangeReport[];
}

export interface ChangeReport {
  at: string;
  files: string[];
  intent?: string;
  sessionId?: string;
  client?: string;
}

export interface EmbedPayload {
  /** index_runs row the embed belongs to (dashboard link only in phase 1). */
  runId?: number | null;
}

export const PRIORITY = { primary: 10, normal: 50, background: 90 } as const;
