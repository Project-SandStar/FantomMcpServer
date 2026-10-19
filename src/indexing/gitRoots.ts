/**
 * Git root registry (lazy-incremental-indexing.md 3.2.1, 3.2.9, 3.2.11).
 *
 * Per project: the root above the project path (walk up to the first `.git`
 * entry) plus every repo nested inside the project (a `git clone` into a
 * sub-folder, a vendored tool). Each is resolved with one
 * `git rev-parse --show-toplevel --git-dir --git-common-dir`, which handles
 * plain repos, linked worktrees and submodules alike, and stored in
 * `git_roots` with `parent_root_id` = the nearest registered root above it.
 * One `project_git_state` row per (project, root) pair holds the base commit
 * of the next diff.
 *
 * Ownership rule (D3): the longest root that is a prefix of a path owns it.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { PrismaClient, GitRoot } from '@prisma/client';
import { DEFAULT_EXCLUDE_DIRS } from '../fantom-code/excludeDirs.js';
import { git, isGitAvailable } from './gitExec.js';
import { createLogger } from '../utils/index.js';

const logger = createLogger('lazy-index');

export interface ResolvedRoot {
  root: string;
  gitDir: string;
  gitCommonDir: string;
}

/** `a` equals `b` or lies under it (path-segment boundary, no trailing slash games). */
export function isUnder(a: string, b: string): boolean {
  if (a === b) return true;
  const base = b.endsWith(path.sep) ? b : b + path.sep;
  return a.startsWith(base);
}

/** Longest root that contains `p` (D3), or null. */
export function ownerOf<T extends { root: string }>(p: string, roots: T[]): T | null {
  let best: T | null = null;
  for (const r of roots) {
    if (isUnder(p, r.root) && (!best || r.root.length > best.root.length)) best = r;
  }
  return best;
}

/** Nearest root strictly above `root` (its parent in git_roots). */
export function parentOf<T extends { root: string }>(root: string, roots: T[]): T | null {
  return ownerOf(path.dirname(root), roots.filter(r => r.root !== root));
}

/** Roots strictly inside `root` — the `:(exclude)` list of its diff and log. */
export function innerRootsOf<T extends { root: string }>(root: string, roots: T[]): T[] {
  return roots.filter(r => r.root !== root && isUnder(r.root, root));
}

/**
 * Pathspecs for one project under one root: the project's part of the root,
 * minus every inner root (3.2.11, belt and braces: git does not list inner
 * files, but a file committed to the outer repo before the inner `.git`
 * appeared would be).
 */
export function pathspecsFor(projectPath: string, root: string, allRoots: Array<{ root: string }>): string[] {
  const scope = isUnder(projectPath, root) ? projectPath : root; // root inside the project → whole root
  const rel = path.relative(root, scope);
  const specs = [rel === '' ? '.' : rel];
  for (const inner of innerRootsOf(root, allRoots)) {
    if (!isUnder(inner.root, scope)) continue;
    specs.push(`:(exclude)${path.relative(root, inner.root)}/`);
  }
  return specs;
}

/** project_git_state.sub_path: project path relative to the root ("" = root, or root inside the project). */
export function subPathFor(projectPath: string, root: string): string {
  return isUnder(projectPath, root) ? path.relative(root, projectPath) : '';
}

/** Walk up from `start` to the first directory holding a `.git` entry (dir or file). */
export function findGitEntryUp(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * Directories below `projectPath` (not the path itself) that hold a `.git`
 * entry. Bounded walk: skips DEFAULT_EXCLUDE_DIRS (node_modules, .claude,
 * worktrees, ...) and symlinks, stops at maxDepth and maxDirs.
 */
export function discoverNestedGitDirs(projectPath: string, maxDepth = 8, maxDirs = 20_000): string[] {
  const found: string[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || visited >= maxDirs) return;
    visited++;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (DEFAULT_EXCLUDE_DIRS.has(e.name)) continue;
      const sub = path.join(dir, e.name);
      if (fs.existsSync(path.join(sub, '.git'))) found.push(sub);
      walk(sub, depth + 1);
    }
  };
  walk(path.resolve(projectPath), 0);
  return found;
}

/** One spawn: toplevel, git dir and common dir, all absolute and real. */
export async function resolveRoot(dir: string): Promise<ResolvedRoot | null> {
  try {
    const r = await git(dir, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'], { retries: 1 });
    const [top, gitDir, common] = r.stdout.split('\n').map(s => s.trim());
    if (!top || !gitDir || !common) return null;
    const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
    return { root: real(top), gitDir: real(gitDir), gitCommonDir: real(common) };
  } catch {
    return null;
  }
}

export interface ProjectRef { id: number; name: string; path: string }

export interface ProjectRootsResult {
  mode: 'git' | 'scan';
  roots: GitRoot[];
}

/**
 * Resolve and register the roots of one project; prune the project's
 * project_git_state rows for roots that no longer apply; drop root rows no
 * project uses any more (cascade). Sets fantom_projects.index_mode.
 */
export async function syncProjectRoots(
  prisma: PrismaClient,
  project: ProjectRef,
  opts: { discoverNested?: boolean } = {},
): Promise<ProjectRootsResult> {
  const projectPath = (() => { try { return fs.realpathSync(project.path); } catch { return path.resolve(project.path); } })();
  const resolved: ResolvedRoot[] = [];
  if (await isGitAvailable() && fs.existsSync(projectPath)) {
    const outerDir = findGitEntryUp(projectPath);
    if (outerDir) {
      const r = await resolveRoot(outerDir);
      if (r) resolved.push(r);
    }
    if (opts.discoverNested !== false) {
      for (const d of discoverNestedGitDirs(projectPath)) {
        const r = await resolveRoot(d);
        // A nested dir that resolves to an outer toplevel (a stray .git file) is not a root.
        if (r && r.root !== resolved[0]?.root && isUnder(r.root, projectPath)) resolved.push(r);
      }
    }
  }

  // Upsert outermost first so parents exist before children point at them.
  resolved.sort((a, b) => a.root.length - b.root.length);
  const rows: GitRoot[] = [];
  for (const r of resolved) {
    const existing = await prisma.gitRoot.findMany({ select: { id: true, root: true } });
    const parent = parentOf(r.root, existing);
    const row = await prisma.gitRoot.upsert({
      where: { root: r.root },
      create: { root: r.root, gitDir: r.gitDir, gitCommonDir: r.gitCommonDir, parentRootId: parent?.id ?? null },
      update: { gitDir: r.gitDir, gitCommonDir: r.gitCommonDir, parentRootId: parent?.id ?? null },
    });
    rows.push(row);
    await prisma.projectGitState.upsert({
      where: { projectId_rootId: { projectId: project.id, rootId: row.id } },
      create: { projectId: project.id, rootId: row.id, subPath: subPathFor(projectPath, r.root) },
      update: { subPath: subPathFor(projectPath, r.root) },
    });
  }

  // A repo whose .git vanished: drop this project's state for it; the outer
  // root takes the paths back (3.2.11).
  const keep = rows.map(r => r.id);
  await prisma.projectGitState.deleteMany({ where: { projectId: project.id, rootId: { notIn: keep } } });
  await pruneUnusedRoots(prisma);

  const mode = rows.length > 0 ? 'git' : 'scan';
  await prisma.fantomProject.update({ where: { id: project.id }, data: { indexMode: mode } }).catch(() => undefined);
  if (rows.length > 1) {
    logger.info(`[lazy-index] project ${project.name}: ${rows.length} git roots (${rows.map(r => r.root).join(', ')})`);
  }
  return { mode, roots: rows };
}

/** Delete root rows with no project_git_state row (children re-parent on the next sync). */
export async function pruneUnusedRoots(prisma: PrismaClient): Promise<number> {
  const unused = await prisma.gitRoot.findMany({ where: { states: { none: {} } }, select: { id: true } });
  if (unused.length === 0) return 0;
  const r = await prisma.gitRoot.deleteMany({ where: { id: { in: unused.map(u => u.id) } } });
  return r.count;
}
