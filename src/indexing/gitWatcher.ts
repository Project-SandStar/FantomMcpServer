/**
 * HEAD watcher per git root (lazy-incremental-indexing.md 3.2.1).
 *
 * Watch directories, not files: git writes HEAD through HEAD.lock + rename,
 * so a watcher on the file loses the inode on macOS; the directory sees the
 * rename. `logs/HEAD` is appended in place. Per root:
 *   - fs.watch(gitDir), filter HEAD          (checkout, detach)
 *   - fs.watch(gitDir/logs), filter HEAD     (every commit, reset, merge, ...)
 *   - fs.watch(root), filter .git            (a worktree/submodule .git file
 *                                             appears or changes → re-resolve)
 * Three fds per root, all `persistent: false`. Events are debounced by
 * `debounceMs`; while a rebase/merge/cherry-pick is in progress the event
 * waits and re-checks every `inProgressPollMs`. Above `maxRoots` (or after a
 * watcher error such as EMFILE) a root is polled: one stat of logs/HEAD every
 * `pollMs`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/index.js';
import { gitOperationInProgress } from './gitChangeSource.js';

const logger = createLogger('lazy-index');

export interface WatchedRoot {
  id: number;
  root: string;
  gitDir: string;
}

export interface GitWatcherOptions {
  debounceMs: number;
  inProgressPollMs: number;
  pollMs: number;
  maxRoots: number;
  /** A settled HEAD move under this root. */
  onHeadMove: (rootId: number) => void;
  /** The root's `.git` entry appeared, vanished or changed. */
  onRootChanged?: (rootId: number) => void;
  /** Watch mode changed (fsevents → poll); stored in git_roots.watch_mode. */
  onModeChange?: (rootId: number, mode: 'fsevents' | 'poll') => void;
}

interface Entry {
  root: WatchedRoot;
  watchers: fs.FSWatcher[];
  mode: 'fsevents' | 'poll';
  timer: NodeJS.Timeout | null;
  lastStat: string;
}

function statKey(file: string): string {
  try { const s = fs.statSync(file); return `${s.size}:${s.mtimeMs}`; } catch { return 'missing'; }
}

/** Poll fingerprint of one root: logs/HEAD plus HEAD. */
function headKey(gitDir: string): string {
  return statKey(path.join(gitDir, 'logs', 'HEAD')) + '|' + statKey(path.join(gitDir, 'HEAD'));
}

export class GitWatcher {
  private readonly entries = new Map<number, Entry>();
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: GitWatcherOptions) {}

  /** Watch exactly this set of roots (adds new ones, closes dropped ones). */
  sync(roots: WatchedRoot[]): void {
    const want = new Map(roots.map(r => [r.id, r]));
    for (const [id, e] of this.entries) {
      const r = want.get(id);
      if (!r || r.gitDir !== e.root.gitDir || r.root !== e.root.root) this.unwatch(id);
    }
    for (const r of roots) {
      if (this.entries.has(r.id)) continue;
      const watched = [...this.entries.values()].filter(e => e.mode === 'fsevents').length;
      this.add(r, watched < this.opts.maxRoots ? 'fsevents' : 'poll');
    }
    this.ensurePoll();
  }

  /** Number of open fs.watch handles (logged by the scheduler). */
  fdCount(): number {
    let n = 0;
    for (const e of this.entries.values()) n += e.watchers.length;
    return n;
  }

  modes(): Record<number, 'fsevents' | 'poll'> {
    const out: Record<number, 'fsevents' | 'poll'> = {};
    for (const [id, e] of this.entries) out[id] = e.mode;
    return out;
  }

  close(): void {
    for (const id of [...this.entries.keys()]) this.unwatch(id);
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  /** Fire the debounced event by hand (tests, a hook ping later). */
  trigger(rootId: number): void { this.schedule(rootId); }

  private add(root: WatchedRoot, mode: 'fsevents' | 'poll'): void {
    const e: Entry = { root, watchers: [], mode, timer: null, lastStat: headKey(root.gitDir) };
    this.entries.set(root.id, e);
    if (mode === 'fsevents') this.openWatchers(e);
    this.opts.onModeChange?.(root.id, e.mode);
  }

  private openWatchers(e: Entry): void {
    const onErr = (err: unknown) => this.degrade(e, err);
    const watch = (dir: string, filter: string, cb: () => void) => {
      try {
        const w = fs.watch(dir, { persistent: false }, (_ev, filename) => {
          if (filename == null || String(filename) === filter) cb();
        });
        w.on('error', onErr);
        e.watchers.push(w);
      } catch (err) {
        // logs/ may not exist yet in a fresh repo: the gitDir watcher still sees HEAD.
        if (dir.endsWith(`${path.sep}logs`) && (err as NodeJS.ErrnoException).code === 'ENOENT') return;
        onErr(err);
      }
    };
    watch(e.root.gitDir, 'HEAD', () => this.schedule(e.root.id));
    watch(path.join(e.root.gitDir, 'logs'), 'HEAD', () => this.schedule(e.root.id));
    watch(e.root.root, '.git', () => this.opts.onRootChanged?.(e.root.id));
  }

  private degrade(e: Entry, err: unknown): void {
    if (e.mode === 'poll') return;
    logger.warn(`[lazy-index] git watcher on ${e.root.root} failed (${err instanceof Error ? err.message : String(err)}); polling every ${this.opts.pollMs}ms`);
    for (const w of e.watchers) try { w.close(); } catch { /* ignore */ }
    e.watchers = [];
    e.mode = 'poll';
    this.opts.onModeChange?.(e.root.id, 'poll');
    this.ensurePoll();
  }

  private unwatch(id: number): void {
    const e = this.entries.get(id);
    if (!e) return;
    for (const w of e.watchers) try { w.close(); } catch { /* ignore */ }
    if (e.timer) clearTimeout(e.timer);
    this.entries.delete(id);
  }

  private ensurePoll(): void {
    const anyPoll = [...this.entries.values()].some(e => e.mode === 'poll');
    if (anyPoll && !this.pollTimer) {
      this.pollTimer = setInterval(() => this.poll(), this.opts.pollMs);
      this.pollTimer.unref?.();
    } else if (!anyPoll && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private poll(): void {
    for (const e of this.entries.values()) {
      if (e.mode !== 'poll') continue;
      const k = headKey(e.root.gitDir);
      if (k !== e.lastStat) { e.lastStat = k; this.schedule(e.root.id); }
    }
  }

  private schedule(rootId: number, delay = this.opts.debounceMs): void {
    const e = this.entries.get(rootId);
    if (!e) return;
    if (e.timer) clearTimeout(e.timer);
    e.timer = setTimeout(() => {
      e.timer = null;
      // A rebase with 50 picks yields one event: wait for the final line.
      if (gitOperationInProgress(e.root.gitDir)) { this.schedule(rootId, this.opts.inProgressPollMs); return; }
      try { this.opts.onHeadMove(rootId); } catch (err) {
        logger.warn(`[lazy-index] onHeadMove(${rootId}) threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, delay);
    e.timer.unref?.();
  }
}
