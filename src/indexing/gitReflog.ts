/**
 * Reflog reading and HEAD-move classification (lazy-incremental-indexing.md
 * 3.2.3). Pure apart from readReflogTail.
 *
 * `logs/HEAD` lines: `<old-sha> <new-sha> <ident> <ts> <tz>\t<message>`.
 * The newest consumed line's message gives the kind; the ancestry check
 * (`merge-base --is-ancestor from to`) gives `linear`.
 */

import * as fs from 'fs';
import { createHash } from 'crypto';
import type { HeadMove, HeadMoveKind } from './types.js';

export interface ReflogEntry {
  oldSha: string;
  newSha: string;
  /** Unix seconds. */
  ts: number;
  message: string;
  /** "<ts> <new-sha> <line-hash>", stored in git_roots.last_reflog_ident. */
  ident: string;
}

const LINE = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) (.*?) (\d+) ([+-]\d{4})\t(.*)$/;

export function parseReflogLine(line: string): ReflogEntry | null {
  const m = LINE.exec(line);
  if (!m) return null;
  const ts = Number(m[4]);
  // "<ts> <new-sha>" alone repeats when a checkout lands on the same commit
  // within the same second; a short hash of the whole line tells them apart.
  const h = createHash('sha1').update(line).digest('hex').slice(0, 8);
  return { oldSha: m[1], newSha: m[2], ts, message: m[6], ident: `${ts} ${m[2]} ${h}` };
}

/** Last `tail` lines of `<gitDir>/logs/HEAD`, read from the end (bounded). */
export function readReflogTail(gitDir: string, tail: number): ReflogEntry[] {
  const file = `${gitDir}/logs/HEAD`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    // ~200 bytes a line; read a window, never the whole file.
    const want = Math.min(size, Math.max(16_384, tail * 512));
    const buf = Buffer.alloc(want);
    fs.readSync(fd, buf, 0, want, size - want);
    let text = buf.toString('utf8');
    if (want < size) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
    const lines = text.split('\n').filter(Boolean).slice(-tail);
    return lines.map(parseReflogLine).filter((e): e is ReflogEntry => e !== null);
  } catch {
    return [];
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** Entries newer than the stored ident; all of them when it is unknown or rotated out. */
export function entriesSince(entries: ReflogEntry[], lastIdent: string | null): ReflogEntry[] {
  if (!lastIdent) return entries;
  const i = entries.map(e => e.ident).lastIndexOf(lastIdent);
  return i < 0 ? entries : entries.slice(i + 1);
}

/** Intermediate steps of a rebase / pull --rebase: the final line decides. */
const IGNORED = /^(rebase( -i)? \((start|pick|reword|edit|squash|fixup|continue|skip)\)|pull --rebase \((start|pick)\))/;

/** Kind from one reflog message (the table in 3.2.3), or null for an ignored step. */
export function kindFromMessage(message: string): HeadMoveKind | null {
  const m = message.trim();
  if (IGNORED.test(m)) return null;
  if (/^commit \(amend\):/.test(m)) return 'rewrite';
  if (/^commit \(merge\):/.test(m)) return 'integrate';
  if (/^(commit:|commit \(initial\):|cherry-pick:|revert:|am:)/.test(m)) return 'edit';
  if (/^(rebase( -i)? \((finish|abort)\)|pull --rebase \((finish)\))/.test(m)) return 'rewrite';
  if (/^(merge [^:]+:|pull( [^:]*)?:)/.test(m)) return 'integrate';
  if (/^(checkout: moving from|reset: moving to|Branch: renamed|clone:|initial pull)/.test(m)) return 'switch';
  return 'unknown';
}

/**
 * Classify a move from the new reflog entries and the ancestry check.
 * - no new entries and HEAD unchanged → 'none';
 * - the newest non-ignored message gives the kind;
 * - edit/integrate with linear = false → rewrite;
 * - switch stays switch even when linear; unknown is handled as switch by callers.
 */
export function classifyHeadMove(newEntries: ReflogEntry[], linear: boolean, headChanged: boolean): HeadMove {
  let kind: HeadMoveKind | null = null;
  let reflog = '';
  for (let i = newEntries.length - 1; i >= 0; i--) {
    const k = kindFromMessage(newEntries[i].message);
    if (k !== null) { kind = k; reflog = newEntries[i].message; break; }
  }
  if (kind === null) {
    if (!headChanged) return { kind: 'none', reflog: '', linear: true };
    // HEAD moved with no readable reflog (core.logAllRefUpdates=false, rotated).
    kind = 'unknown';
  }
  if ((kind === 'edit' || kind === 'integrate') && !linear) kind = 'rewrite';
  return { kind, reflog, linear };
}

/** A switch, an unknown move or a big rewrite is "counts only" with priority 90. */
export function isSwitchLike(move: HeadMove, changedFiles: number, rewriteAsSwitchFiles: number): boolean {
  if (move.kind === 'switch' || move.kind === 'unknown') return true;
  return move.kind === 'rewrite' && changedFiles > rewriteAsSwitchFiles;
}
