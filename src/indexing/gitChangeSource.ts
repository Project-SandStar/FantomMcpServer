/**
 * From a HEAD move to change sets (lazy-incremental-indexing.md 3.2.2, 3.2.7).
 *
 * Per root, on a settled event:
 *   1. `rev-parse HEAD` → toCommit; `symbolic-ref -q --short HEAD` → branch.
 *   2. Per (project, root) pair: fromCommit = last_indexed_commit.
 *      equal → nothing to do (branch name only); null → seed through a scan.
 *   3. `cat-file -e <from>^{commit}` fails → sha scan.
 *   4. `diff --raw -M -z from to -- <project path> ':(exclude)<inner>/'`
 *      (--raw instead of --name-status: same letters plus the modes);
 *      entries split per project by longest project path (a nested project
 *      owns its files); paths outside the scanner's include list or under
 *      an exclude dir are dropped; mode-160000 entries (submodules) too.
 *   5. Classify the move from the reflog plus `merge-base --is-ancestor`,
 *      and list the commits with one `git log`.
 * The result is one GitProjectChange per project; the scheduler turns it
 * into a task (taskPlanner.ts).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { GitRoot } from '@prisma/client';
import { git, GitError } from './gitExec.js';
import { classifyHeadMove, entriesSince, readReflogTail, type ReflogEntry } from './gitReflog.js';
import { innerRootsOf, isUnder, pathspecsFor } from './gitRoots.js';
import { filterSourcePaths, type SourceScanner } from './changeDetector.js';
import type { ChangeSet, CommitMeta, GitContext, HeadMove, RenamedPath } from './types.js';

export interface DiffEntry {
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X';
  path: string;
  /** Rename / copy source. */
  from?: string;
  similarity?: number;
}

/**
 * Parse `git diff --name-status -M -z` output: `<status>\0<path>\0` or, for
 * R/C, `<status><score>\0<from>\0<to>\0`.
 */
export function parseNameStatusZ(out: string): DiffEntry[] {
  const parts = out.split('\0');
  const entries: DiffEntry[] = [];
  for (let i = 0; i < parts.length; ) {
    const st = parts[i++];
    if (!st) continue;
    const letter = st[0] as DiffEntry['status'];
    if (letter === 'R' || letter === 'C') {
      const from = parts[i++], to = parts[i++];
      if (from === undefined || to === undefined) break;
      entries.push({ status: letter, path: to, from, similarity: Number(st.slice(1)) || 0 });
    } else {
      const p = parts[i++];
      if (p === undefined) break;
      entries.push({ status: letter, path: p });
    }
  }
  return entries;
}

export interface MappedDiff {
  added: string[];
  modified: string[];
  removed: string[];
  renamed: RenamedPath[];
  /** A `U` entry: a merge or rebase is still in progress. */
  unmerged: boolean;
}

/** Status letters → change lists (3.2.2 step 4). Paths stay as given. */
export function mapDiffEntries(entries: DiffEntry[]): MappedDiff {
  const m: MappedDiff = { added: [], modified: [], removed: [], renamed: [], unmerged: false };
  for (const e of entries) {
    switch (e.status) {
      case 'A': case 'C': m.added.push(e.path); break;
      case 'M': case 'T': m.modified.push(e.path); break;
      case 'D': m.removed.push(e.path); break;
      case 'R': m.renamed.push({ from: e.from!, to: e.path, similarity: e.similarity ?? 0 }); break;
      case 'U': m.unmerged = true; break;
      default: break;
    }
  }
  return m;
}

/** Parse the `git log` format used below (record separator \x1e, field separator \x1f). */
export function parseLog(out: string): Array<Omit<CommitMeta, 'files'> & { files: string[] }> {
  const commits: CommitMeta[] = [];
  for (const rec of out.split('\x1e')) {
    const t = rec.replace(/^\n+/, '');
    if (!t.trim()) continue;
    const [head, ...fileLines] = t.split('\n');
    const [sha, parents, author, at, subject] = head.split('\x1f');
    if (!sha) continue;
    commits.push({
      sha, parents: parents ? parents.split(' ').filter(Boolean) : [],
      author: author ?? '', authorTime: Number(at) || 0, subject: subject ?? '',
      files: fileLines.map(s => s.trim()).filter(Boolean),
    });
  }
  return commits;
}

export interface GitProjectInput {
  projectId: number;
  /** Configured project path (the prefix indexed_files uses). */
  projectPath: string;
  /** Real path of projectPath (git reports real paths under the root). */
  projectReal: string;
  lastIndexedCommit: string | null;
  scanner: Pick<SourceScanner, 'accepts'>;
}

export type GitProjectChange =
  | { projectId: number; kind: 'unchanged'; toCommit: string; branch: string | null }
  | { projectId: number; kind: 'seed'; git: GitContext }
  | { projectId: number; kind: 'sha-scan'; git: GitContext; reason: string }
  | { projectId: number; kind: 'in-progress' }
  | { projectId: number; kind: 'changes'; changeSet: ChangeSet };

export interface RootEventResult {
  rootId: number;
  toCommit: string | null;
  branch: string | null;
  headMove: HeadMove;
  /** Newest consumed reflog ident, to store in git_roots.last_reflog_ident. */
  reflogIdent: string | null;
  projects: GitProjectChange[];
  error?: string;
}

export interface GitSourceOptions {
  reflogTail: number;
  maxCommitsPerRun: number;
  retries: number;
  retryMs: number;
}

/** In-progress markers (3.2.1): hold the event until they are gone. */
export function gitOperationInProgress(gitDir: string): boolean {
  for (const f of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG']) {
    if (fs.existsSync(path.join(gitDir, f))) return true;
  }
  return false;
}

/** Map a root-relative git path to the project's configured path prefix. */
function toProjectPath(root: string, rel: string, p: GitProjectInput): string {
  const real = path.join(root, rel);
  return path.join(p.projectPath, path.relative(p.projectReal, real));
}

/**
 * Compute the change sets for every project of one root. `allRoots` is the
 * full git_roots list (inner roots become excludes).
 */
export async function computeRootChanges(
  root: Pick<GitRoot, 'id' | 'root' | 'gitDir' | 'gitCommonDir' | 'lastReflogIdent'>,
  allRoots: Array<{ root: string }>,
  projects: GitProjectInput[],
  opts: GitSourceOptions,
): Promise<RootEventResult> {
  const g = (args: string[], okCodes?: number[]) => git(root.root, args, { retries: opts.retries, retryMs: opts.retryMs, okCodes });
  const res: RootEventResult = {
    rootId: root.id, toCommit: null, branch: null,
    headMove: { kind: 'none', reflog: '', linear: true }, reflogIdent: root.lastReflogIdent ?? null, projects: [],
  };
  if (gitOperationInProgress(root.gitDir)) {
    res.projects = projects.map(p => ({ projectId: p.projectId, kind: 'in-progress' as const }));
    return res;
  }
  let toCommit: string;
  try {
    toCommit = (await g(['rev-parse', '--verify', '-q', 'HEAD'])).stdout.trim();
  } catch (err) {
    // Empty repo (no commit yet) or a broken one: nothing to diff.
    res.error = err instanceof GitError ? err.message : String(err);
    return res;
  }
  const branchOut = await g(['symbolic-ref', '-q', '--short', 'HEAD'], [1]);
  const branch = branchOut.code === 0 ? branchOut.stdout.trim() || null : null;
  res.toCommit = toCommit;
  res.branch = branch;

  const entries: ReflogEntry[] = entriesSince(readReflogTail(root.gitDir, opts.reflogTail), root.lastReflogIdent ?? null);
  if (entries.length > 0) res.reflogIdent = entries[entries.length - 1].ident;

  // Projects with the same base share one diff and one log.
  const byBase = new Map<string, GitProjectInput[]>();
  for (const p of projects) {
    const from = p.lastIndexedCommit;
    const ctxBase = (from: string | null, move: HeadMove): GitContext => ({
      root: root.root, gitDir: root.gitDir, gitCommonDir: root.gitCommonDir,
      fromCommit: from, toCommit, branch, headMove: move, dirty: false, commits: [],
    });
    if (from === toCommit) { res.projects.push({ projectId: p.projectId, kind: 'unchanged', toCommit, branch }); continue; }
    if (from === null) {
      res.projects.push({ projectId: p.projectId, kind: 'seed', git: ctxBase(null, classifyHeadMove(entries, false, true)) });
      continue;
    }
    const exists = await g(['cat-file', '-e', `${from}^{commit}`], [1, 128]);
    if (exists.code !== 0) {
      res.projects.push({ projectId: p.projectId, kind: 'sha-scan', git: ctxBase(from, classifyHeadMove(entries, false, true)), reason: `base ${from.slice(0, 12)} missing` });
      continue;
    }
    const list = byBase.get(from) ?? [];
    list.push(p);
    byBase.set(from, list);
  }

  for (const [from, group] of byBase) {
    const linearOut = await g(['merge-base', '--is-ancestor', from, toCommit], [1, 128]);
    const move = classifyHeadMove(entries, linearOut.code === 0, true);
    res.headMove = move;

    // One pathspec set for the group: each project's part, minus inner roots.
    const specs = new Set<string>();
    for (const p of group) for (const s of pathspecsFor(p.projectReal, root.root, allRoots)) specs.add(s);
    const diffOut = await g(['-c', 'core.quotePath=false', 'diff', '--raw', '-M', '-z', '--no-ext-diff', '--no-abbrev', from, toCommit, '--', ...specs]);
    const entriesRaw = parseRawZ(diffOut.stdout);
    const mapped = mapDiffEntries(entriesRaw.filter(e => e.status !== 'X'));
    if (mapped.unmerged) {
      for (const p of group) res.projects.push({ projectId: p.projectId, kind: 'in-progress' });
      continue;
    }
    const logOut = await g([
      '-c', 'core.quotePath=false', 'log', `--max-count=${opts.maxCommitsPerRun + 1}`,
      '--format=%x1e%H%x1f%P%x1f%an%x1f%at%x1f%s', '--name-only', `${from}..${toCommit}`, '--', ...specs,
    ]);
    let commits = parseLog(logOut.stdout);
    let forcedSwitch = false;
    if (commits.length > opts.maxCommitsPerRun) {
      commits = commits.slice(0, opts.maxCommitsPerRun);
      forcedSwitch = true;
    }
    commits.reverse(); // git log is newest first; the context is oldest first
    const groupMove: HeadMove = forcedSwitch ? { ...move, kind: 'switch' } : move;

    // Inner roots are excluded above; projects nested in each other split by longest path.
    const inner = innerRootsOf(root.root, allRoots);
    const ownerProject = (realAbs: string): GitProjectInput | null => {
      if (inner.some(r => isUnder(realAbs, r.root))) return null;
      let best: GitProjectInput | null = null;
      for (const p of group) {
        const scope = isUnder(p.projectReal, root.root) ? p.projectReal : root.root;
        if (isUnder(realAbs, scope) && (!best || p.projectReal.length > best.projectReal.length)) best = p;
      }
      return best;
    };
    for (const p of group) {
      const own = (rel: string) => ownerProject(path.join(root.root, rel)) === p;
      const conv = (rels: string[]) => filterSourcePaths(rels.filter(own).map(r => toProjectPath(root.root, r, p)), p.projectPath, p.scanner);
      const renamed: RenamedPath[] = [];
      const extraRemoved: string[] = [];
      const extraAdded: string[] = [];
      for (const r of mapped.renamed) {
        const fromOk = own(r.from), toOk = own(r.to);
        const from = fromOk ? conv([r.from])[0] : undefined;
        const to = toOk ? conv([r.to])[0] : undefined;
        if (from && to) renamed.push({ from, to, similarity: r.similarity });
        else if (from) extraRemoved.push(from); // moved out of the project or out of the include list
        else if (to) extraAdded.push(to);
      }
      const projCommits = commits.map(c => ({
        ...c, files: conv(c.files),
      })).filter(c => c.files.length > 0);
      const cs: ChangeSet = {
        projectId: p.projectId, rootId: root.id, source: 'git',
        added: [...conv(mapped.added), ...extraAdded],
        modified: conv(mapped.modified),
        removed: [...conv(mapped.removed), ...extraRemoved],
        renamed, unchanged: 0,
        git: {
          root: root.root, gitDir: root.gitDir, gitCommonDir: root.gitCommonDir,
          fromCommit: from, toCommit, branch, headMove: groupMove, dirty: false, commits: projCommits,
        },
        scannedAt: new Date().toISOString(), scanMs: 0,
      };
      res.projects.push({ projectId: p.projectId, kind: 'changes', changeSet: cs });
    }
  }
  return res;
}

/**
 * `--raw -z` output: `:<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>\0[<to>\0]`.
 * Used instead of plain --name-status so a submodule entry (mode 160000) can
 * be told apart and dropped (3.2.2 step 4). Returned with status 'X'.
 */
export function parseRawZ(out: string): DiffEntry[] {
  if (!out.startsWith(':')) return parseNameStatusZ(out);
  const parts = out.split('\0');
  const entries: DiffEntry[] = [];
  for (let i = 0; i < parts.length; ) {
    const meta = parts[i++];
    if (!meta || !meta.startsWith(':')) continue;
    const [srcMode, dstMode, , , st] = meta.slice(1).split(' ');
    const letter = (st?.[0] ?? 'X') as DiffEntry['status'];
    const sub = srcMode === '160000' || dstMode === '160000';
    if (letter === 'R' || letter === 'C') {
      const from = parts[i++], to = parts[i++];
      if (from === undefined || to === undefined) break;
      entries.push({ status: sub ? 'X' : letter, path: to, from, similarity: Number(st.slice(1)) || 0 });
    } else {
      const p = parts[i++];
      if (p === undefined) break;
      entries.push({ status: sub ? 'X' : letter, path: p });
    }
  }
  return entries;
}
