/**
 * Change detection without git (lazy-incremental-indexing.md 3.2.5) and the
 * hash gate for a candidate list (git, scan).
 *
 * - scanProject: the safety-net mtime scan. stat every file the project's
 *   scanner lists; sha256 only when mtime or size moved (or always, for
 *   `scan.shaAlwaysProjects` and a 'sha' scan). indexed_files is read in
 *   pages of `scan.pageRows`, so memory per project stays bounded.
 * - gateCandidates: the same rule for a short list of paths (a git diff),
 *   so a commit of a file the scan already indexed costs no parse.
 *
 * Both use the include list of the project's own scanner and the shared
 * exclude dirs, so git, scan and indexProject agree on what a source file is.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { DEFAULT_EXCLUDE_DIRS } from '../fantom-code/excludeDirs.js';
import { FantomFileScanner } from '../fantom-code/scanner.js';
import { createMultiLanguageScanner } from '../fantom-code/treeSitterAdapter.js';
import { indexVersionFor } from '../fantom-code/indexVersion.js';
import { createKeyBaseResolver, KEY_SCHEME_STABLE, storedKeyBase } from '../fantom-code/symbolKey.js';
import type { SupportedLanguage } from '../parser/treeSitter/types.js';
import type { ChangeSet, ChangeSource } from './types.js';

export interface ProjectScanInfo {
  id: number;
  name: string;
  path: string;
  language: string | null;
  parserType: string | null;
  /** fantom_projects.key_scheme; 2 = stable keys, the key base is part of the gate. */
  keyScheme?: number | null;
}

export interface SourceScanner {
  accepts(filePath: string): boolean;
  scanDirectory(dir: string): Promise<{ files: string[] }>;
}

function isFanLike(language: string): boolean {
  return language === 'fantom' || language === 'trio' || language === 'axon';
}

/** The scanner indexProject would use for this project (codeIndexingService.ts). */
export function scannerFor(language: string | null): SourceScanner {
  const lang = language || 'fantom';
  return isFanLike(lang) ? new FantomFileScanner() : createMultiLanguageScanner(lang as SupportedLanguage);
}

/** The parserType indexProject ends up with (it promotes regex for non-Fantom languages). */
export function effectiveParserType(p: { language: string | null; parserType: string | null }): string {
  const lang = p.language || 'fantom';
  const pt = p.parserType || 'regex';
  return !isFanLike(lang) && pt === 'regex' ? 'tree-sitter-wasm' : pt;
}

/** True when any directory segment of `rel` is an excluded dir (node_modules, .claude, ...). */
export function hasExcludedSegment(rel: string): boolean {
  const parts = rel.split(/[\\/]/);
  parts.pop(); // the file name itself
  return parts.some(p => DEFAULT_EXCLUDE_DIRS.has(p));
}

/** Keep the paths the project's scanner would index. `abs` paths, `projectPath` absolute. */
export function filterSourcePaths(paths: string[], projectPath: string, scanner: Pick<SourceScanner, 'accepts'>): string[] {
  return paths.filter(p => {
    const rel = path.relative(projectPath, p);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
    return !hasExcludedSegment(rel) && scanner.accepts(p);
  });
}

async function sha256(file: string): Promise<{ sha: string; size: number } | null> {
  try {
    const buf = await fsp.readFile(file);
    return { sha: createHash('sha256').update(buf).digest('hex'), size: buf.byteLength };
  } catch {
    return null;
  }
}

interface Row { filePath: string; mtimeMs: bigint; byteSize: number; contentSha: string; indexVersion: string | null; keyBase?: string | null }

/** Stored key base per path for a stable-key project, or null (key base not gated). */
function keyBaseGate(project: ProjectScanInfo): ((fp: string) => string) | null {
  if ((project.keyScheme ?? 1) < KEY_SCHEME_STABLE) return null;
  const resolve = createKeyBaseResolver(project.path);
  return fp => storedKeyBase(resolve(fp), project.path);
}

/** Compare one path on disk with its indexed_files row. */
async function compare(fp: string, row: Row | undefined, parserType: string, shaAlways: boolean, keyBase: ((fp: string) => string) | null = null): Promise<'added' | 'modified' | 'removed' | 'unchanged'> {
  let st;
  try { st = await fsp.stat(fp); } catch { return row ? 'removed' : 'unchanged'; }
  if (!st.isFile()) return row ? 'removed' : 'unchanged';
  if (!row) return 'added';
  if (row.indexVersion !== indexVersionFor(fp, parserType)) return 'modified';
  // A file keyed against another git root re-parses (3.6, 3.8).
  if (keyBase && (row.keyBase ?? '') !== keyBase(fp)) return 'modified';
  if (!shaAlways && Number(row.mtimeMs) === Math.floor(st.mtimeMs) && Number(row.byteSize) === st.size) return 'unchanged';
  const h = await sha256(fp);
  if (!h) return 'removed';
  return h.sha === row.contentSha ? 'unchanged' : 'modified';
}

export interface GateResult {
  changed: string[];
  added: string[];
  removed: string[];
  unchanged: number;
}

/**
 * Hash gate for a candidate list: which of `paths` differ from indexed_files,
 * and which of `removed` still have a row. Rows are read for the listed paths
 * only (chunks of 500).
 */
export async function gateCandidates(
  prisma: PrismaClient,
  project: ProjectScanInfo,
  paths: string[],
  removed: string[],
  opts: { shaAlways?: boolean } = {},
): Promise<GateResult> {
  const parserType = effectiveParserType(project);
  const kb = keyBaseGate(project);
  const all = [...new Set([...paths, ...removed])];
  const rows = new Map<string, Row>();
  for (let i = 0; i < all.length; i += 500) {
    const chunk = all.slice(i, i + 500);
    const found = await prisma.indexedFile.findMany({
      where: { projectId: project.id, filePath: { in: chunk } },
      select: { filePath: true, mtimeMs: true, byteSize: true, contentSha: true, indexVersion: true, keyBase: true },
    });
    for (const r of found) rows.set(r.filePath, r as Row);
  }
  const out: GateResult = { changed: [], added: [], removed: [], unchanged: 0 };
  for (const fp of all) {
    const c = await compare(fp, rows.get(fp), parserType, opts.shaAlways === true, kb);
    if (c === 'added') { out.added.push(fp); out.changed.push(fp); }
    else if (c === 'modified') out.changed.push(fp);
    else if (c === 'removed') out.removed.push(fp);
    else out.unchanged++;
  }
  return out;
}

/**
 * Safety-net scan of a whole project. `source` is 'mtime' (stat, hash on a
 * moved mtime/size) or 'sha' (hash every file).
 */
export async function scanProject(
  prisma: PrismaClient,
  project: ProjectScanInfo,
  opts: { source?: ChangeSource; pageRows?: number; scanner?: SourceScanner } = {},
): Promise<ChangeSet> {
  const t0 = Date.now();
  const source = opts.source ?? 'mtime';
  const shaAlways = source === 'sha';
  const parserType = effectiveParserType(project);
  const scanner = opts.scanner ?? scannerFor(project.language);
  const kb = keyBaseGate(project);
  const { files } = await scanner.scanDirectory(project.path);
  const onDisk = new Set(files);
  const seen = new Set<string>();
  const cs: ChangeSet = {
    projectId: project.id, rootId: null, source,
    added: [], modified: [], removed: [], renamed: [], unchanged: 0,
    scannedAt: new Date().toISOString(), scanMs: 0,
  };
  const pageRows = Math.max(100, opts.pageRows ?? 5_000);
  let cursor: number | undefined;
  for (;;) {
    const page = await prisma.indexedFile.findMany({
      where: { projectId: project.id },
      orderBy: { id: 'asc' },
      take: pageRows,
      ...(cursor !== undefined ? { skip: 1, cursor: { id: cursor } } : {}),
      select: { id: true, filePath: true, mtimeMs: true, byteSize: true, contentSha: true, indexVersion: true, keyBase: true },
    });
    if (page.length === 0) break;
    for (const r of page) {
      seen.add(r.filePath);
      if (!onDisk.has(r.filePath)) { cs.removed.push(r.filePath); continue; }
      const c = await compare(r.filePath, r as Row, parserType, shaAlways, kb);
      if (c === 'modified') cs.modified.push(r.filePath);
      else if (c === 'removed') cs.removed.push(r.filePath);
      else cs.unchanged++;
    }
    cursor = page[page.length - 1].id;
    if (page.length < pageRows) break;
  }
  for (const f of files) if (!seen.has(f)) cs.added.push(f);
  cs.scanMs = Date.now() - t0;
  return cs;
}

export function changeCount(cs: Pick<ChangeSet, 'added' | 'modified' | 'removed' | 'renamed'>): number {
  return cs.added.length + cs.modified.length + cs.removed.length + cs.renamed.length;
}
