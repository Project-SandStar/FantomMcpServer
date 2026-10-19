/**
 * Focus set: the files the MCP clients are working on right now
 * (lazy-incremental-indexing.md 3.11.1, phase 1b).
 *
 * In memory only: a restart empties it, which is correct (the sessions are
 * gone). Entries are (projectId, relPath) with lastTouchedAt; an entry expires
 * after `focus.ttlMs` without a touch, and the set keeps at most
 * `focus.maxFiles` entries (least recently touched goes first). A Map keeps
 * insertion order, so delete + set on every touch makes it an LRU.
 */

import * as path from 'path';
import { DEFAULT_LAZY_CONFIG, type FocusConfig, type LazyIndexingConfig } from './lazyConfig.js';

export interface FocusEntry {
  projectId: number;
  /** Path relative to the project root, '/' separated. */
  relPath: string;
  lastTouchedAt: number;
  /** How many times a tool named this file since it entered the set. */
  touches: number;
}

export interface FocusProject { id: number; path: string }

function keyOf(projectId: number, relPath: string): string { return `${projectId}\0${relPath}`; }

export class FocusSet {
  private readonly entries = new Map<string, FocusEntry>();

  constructor(
    private cfg: Pick<FocusConfig, 'ttlMs' | 'maxFiles'> = DEFAULT_LAZY_CONFIG.focus,
    private readonly now: () => number = Date.now,
  ) {}

  setConfig(cfg: Pick<FocusConfig, 'ttlMs' | 'maxFiles'>): void {
    this.cfg = cfg;
    this.prune();
  }

  touch(projectId: number, relPath: string): FocusEntry {
    const k = keyOf(projectId, relPath);
    const old = this.entries.get(k);
    const e: FocusEntry = { projectId, relPath, lastTouchedAt: this.now(), touches: (old && !this.expired(old) ? old.touches : 0) + 1 };
    this.entries.delete(k);
    this.entries.set(k, e);
    this.prune();
    return e;
  }

  /** Live entry for the file, or undefined. Does not count as a touch. */
  get(projectId: number, relPath: string): FocusEntry | undefined {
    const e = this.entries.get(keyOf(projectId, relPath));
    if (!e) return undefined;
    if (this.expired(e)) { this.entries.delete(keyOf(projectId, relPath)); return undefined; }
    return e;
  }

  has(projectId: number, relPath: string): boolean { return !!this.get(projectId, relPath); }

  /** Live entries, most recently touched first. */
  list(): FocusEntry[] {
    this.prune();
    return [...this.entries.values()].reverse();
  }

  /** Project ids that hold at least one live focus file. */
  projectIds(): number[] {
    return [...new Set(this.list().map(e => e.projectId))];
  }

  size(): number { this.prune(); return this.entries.size; }

  clear(): void { this.entries.clear(); }

  private expired(e: FocusEntry): boolean { return this.now() - e.lastTouchedAt > this.cfg.ttlMs; }

  /** Drop expired entries (oldest first, so stop at the first live one), then trim to the cap. */
  private prune(): void {
    for (const [k, e] of this.entries) {
      if (!this.expired(e)) break;
      this.entries.delete(k);
    }
    const over = this.entries.size - Math.max(1, this.cfg.maxFiles);
    if (over > 0) {
      let n = 0;
      for (const k of this.entries.keys()) {
        if (n++ >= over) break;
        this.entries.delete(k);
      }
    }
  }
}

let focusSet: FocusSet | null = null;

/** Process-wide focus set. */
export function getFocusSet(): FocusSet {
  if (!focusSet) focusSet = new FocusSet();
  return focusSet;
}

/** Tests only. */
export function resetFocusSet(set: FocusSet | null = null): void { focusSet = set; }

/**
 * The project whose path is the longest prefix of `absPath`, or null.
 * Same rule as reindexChangedFiles and listFunctionsInFile.
 */
export function projectForPath<P extends FocusProject>(projects: P[], absPath: string): P | null {
  const p = path.resolve(absPath);
  let best: P | null = null;
  for (const pr of projects) {
    const root = path.resolve(pr.path);
    if (p !== root && !p.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) continue;
    if (!best || root.length > path.resolve(best.path).length) best = pr;
  }
  return best;
}

/** '/'-separated path of `absPath` below `projectPath`, or null when outside it. */
export function relPathIn(projectPath: string, absPath: string): string | null {
  const rel = path.relative(path.resolve(projectPath), path.resolve(absPath));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * Dirty-tree scope "focus" (3.11.1 use 2): the project roots that hold focus
 * files. Empty unless `dirty.projects` is 'focus'. Phase 1b has no dirty
 * watcher yet; the watcher of 3.2.4 will read this.
 */
export function focusDirtyRoots(
  cfg: Pick<LazyIndexingConfig, 'dirty'>,
  projects: FocusProject[],
  set: FocusSet = getFocusSet(),
): string[] {
  if (cfg.dirty.projects !== 'focus') return [];
  const ids = new Set(set.projectIds());
  return [...new Set(projects.filter(p => ids.has(p.id)).map(p => path.resolve(p.path)))];
}
