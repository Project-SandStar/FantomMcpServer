/**
 * Parser for the OFFLINE Axon library (`axon.libraryPath`): former customer
 * projects we no longer connect to, one top-level folder per project.
 *
 *   <libraryPath>/<folder>/**\/<fn>.axon      one function per file, name = file name,
 *                                             optional leading /* … *\/ or // doc comment
 *   <libraryPath>/<folder>/**\/*.trio         multi-record trio backups (`---` separated;
 *                                             records with name:+src: are functions;
 *                                             bare marker lines are tags) — rule-doc trio
 *                                             files without src: are ignored
 *
 * Records use the same `AxonFunctionRecord` shape as the synced proj folder with
 * `source: 'library'`, `instance: 'library'`, `project: <folder>`, so
 * qualifiedName reads `library/<folder>::<fn>`. Confidential customer code —
 * derived vectors/metadata only ever land under `.cache/`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  parseTrio, axonFunctionId, scanAxonProj, parseAxonProject, resolveCallEdges,
  type AxonFunctionRecord, type AxonProjectRef, type AxonScanSummary, type TrioRecord,
} from './axonProjParser.js';
import { parseAxonSignature } from './axonEmbeddingText.js';
import { extractAxonCallNames } from './axonTreeSitter.js';
import { getAxonProjDir, getAxonLibraryDir } from './axonSettings.js';

export const LIBRARY_INSTANCE = 'library';
const SKIP_DIRS = new Set(['node_modules', '.git', '.vscode', '.idea']);

function safeReaddir(dir: string): fs.Dirent[] {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/** Recursively list .axon and .trio files under a folder (hidden dirs skipped). */
function walk(dir: string, out: { axon: string[]; trio: string[] }, depth = 0): void {
  if (depth > 8) return;
  for (const e of safeReaddir(dir)) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (e.isFile()) {
      if (e.name.endsWith('.axon')) out.axon.push(p);
      else if (e.name.endsWith('.trio')) out.trio.push(p);
    }
  }
}

/**
 * One embeddable unit of a library folder. `.axon` files are keyed by their
 * relative path (same-named functions in different site sub-folders stay
 * distinct — <some folder> has 26 of those); trio backup records are keyed by
 * `<trio file>#<name>` and dropped when an `.axon` file of that name already
 * exists in the folder (the backups duplicate the files).
 */
interface LibUnit {
  kind: 'axon' | 'trio';
  key: string;
  name: string;
  file: string;
  recText?: string;
  recStartLine?: number;
}

function sanitizeName(n: string): string {
  return n.replace(/[^A-Za-z0-9_]/g, '_');
}

function collectUnits(dir: string): LibUnit[] {
  const files = { axon: [] as string[], trio: [] as string[] };
  walk(dir, files);
  const units: LibUnit[] = [];
  const axonNames = new Set<string>();
  for (const f of files.axon.sort()) {
    const name = sanitizeName(path.basename(f, '.axon'));
    axonNames.add(name);
    units.push({ kind: 'axon', key: path.relative(dir, f).replace(/\.axon$/, ''), name, file: f });
  }
  const seenTrio = new Set<string>();
  for (const t of files.trio.sort()) {
    let text: string;
    try { text = fs.readFileSync(t, 'utf-8'); } catch { continue; }
    let lineCursor = 1;
    for (const recText of splitTrioRecords(text)) {
      const startLine = lineCursor;
      lineCursor += recText.split(/\r?\n/).length + 1;
      if (!/^src:/m.test(recText) || !/^name:/m.test(recText)) continue;
      const m = /^name:"?([^"\n]*)"?/m.exec(recText);
      const name = sanitizeName((m?.[1] ?? '').trim());
      if (!name || axonNames.has(name) || seenTrio.has(name)) continue;
      seenTrio.add(name);
      units.push({ kind: 'trio', key: `${path.relative(dir, t)}#${name}`, name, file: t, recText, recStartLine: startLine });
    }
  }
  return units;
}

/** Count functions in a folder without parsing bodies (for scan/validate). */
function countFolder(dir: string): { total: number } {
  return { total: collectUnits(dir).length };
}

export function scanAxonLibrary(libDir: string): AxonScanSummary {
  const exists = fs.existsSync(libDir) && fs.statSync(libDir).isDirectory();
  const summary: AxonScanSummary = { projDir: libDir, exists, instances: [], projects: [], totalFunctions: 0 };
  if (!exists) return summary;
  for (const e of safeReaddir(libDir)) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const dir = path.join(libDir, e.name);
    const functionCount = countFolder(dir).total;
    if (functionCount === 0) continue; // folders with no functions (docs only) are skipped
    summary.projects.push({
      projectId: `${LIBRARY_INSTANCE}/${e.name}`,
      instance: LIBRARY_INSTANCE,
      project: e.name,
      dir,
      functionCount,
      source: 'library',
    });
    summary.totalFunctions += functionCount;
  }
  if (summary.projects.length) summary.instances.push(LIBRARY_INSTANCE);
  summary.projects.sort((a, b) => a.projectId.localeCompare(b.projectId));
  return summary;
}

/** Split a trio file into records on `---` lines. */
export function splitTrioRecords(text: string): string[] {
  return text.split(/\r?\n---+\s*(?:\r?\n|$)/).map(r => r.replace(/^\s*\n/, '')).filter(r => r.trim().length > 0);
}

/**
 * Leading doc comment of a bare .axon file: a `/* … *\/` block or a run of `//`
 * lines before the first code line. Returns { doc, codeStartLine (1-based) }.
 */
export function extractLeadingDoc(body: string): { doc: string; codeStartLine: number } {
  const lines = body.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length) return { doc: '', codeStartLine: 1 };
  const docLines: string[] = [];
  if (lines[i].trim().startsWith('/*')) {
    let j = i;
    while (j < lines.length) {
      const l = lines[j];
      docLines.push(l.replace(/^\s*\/\*+-*/, '').replace(/\*+\/\s*$/, '').replace(/^\s*\*+\s?/, ''));
      if (l.includes('*/')) break;
      j++;
    }
    i = j + 1;
  } else if (lines[i].trim().startsWith('//')) {
    let j = i;
    while (j < lines.length && lines[j].trim().startsWith('//')) {
      docLines.push(lines[j].replace(/^\s*\/\/+[-=*]*\s?/, ''));
      j++;
    }
    i = j;
  } else {
    return { doc: '', codeStartLine: i + 1 };
  }
  while (i < lines.length && lines[i].trim() === '') i++;
  const doc = docLines.map(l => l.replace(/\s+$/, '')).join('\n').replace(/^[\s-=*]+|[\s-=*]+$/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return { doc, codeStartLine: Math.min(i + 1, lines.length) };
}

const IGNORED_TAGS = new Set(['name', 'src', 'mod', 'dis', 'help', 'doc', 'id']);

function trioTags(rec: TrioRecord): string[] {
  const tags: string[] = [];
  for (const [k, v] of Object.entries(rec.tags)) {
    if (IGNORED_TAGS.has(k)) continue;
    if (v === '✔' || v === '' || v === 'M') tags.push(k);
    else tags.push(`${k}:${v.split('\n')[0].slice(0, 60)}`);
  }
  return tags;
}

function makeRecord(opts: {
  ref: AxonProjectRef; libDir: string; key: string; name: string; body: string; doc: string; tags: string[];
  filePath: string; bodyLineOffset: number; modified?: string;
}): AxonFunctionRecord {
  const { ref, libDir, name } = opts;
  const body = opts.body.replace(/\s+$/, '');
  const sig = parseAxonSignature(name, body);
  const bodyLines = body ? body.split('\n').length : 0;
  return {
    // Keyed by file path so same-named functions in different sub-folders stay distinct.
    id: axonFunctionId(ref.instance, ref.project, opts.key),
    source: 'library',
    projectId: ref.projectId,
    instance: ref.instance,
    project: ref.project,
    name,
    qualifiedName: `${ref.projectId}::${name}`,
    params: sig.params.map(p => p.name),
    paramDefs: sig.params,
    returnType: sig.returnType,
    signature: sig.text,
    doc: opts.doc,
    body,
    relPath: path.relative(libDir, opts.filePath),
    filePath: opts.filePath,
    trioPath: opts.filePath.endsWith('.trio') ? opts.filePath : undefined,
    lineStart: opts.bodyLineOffset + sig.headerLine,
    lineEnd: opts.bodyLineOffset + Math.max(bodyLines, sig.headerLine),
    tags: opts.tags,
    // The library has no sync metadata; the source is the only evidence of
    // what a function calls. `resolveCallEdges` splits these into project
    // functions vs builtins once the whole folder is parsed.
    calls: [],
    calledBy: [],
    uses: extractAxonCallNames(body),
    bodyLineOffset: opts.bodyLineOffset + 1,
    hash: createHash('md5').update(body).update(' ').update(opts.doc).digest('hex').slice(0, 16),
    modified: opts.modified,
  };
}

/** Parse one library folder into records (see LibUnit for the dedupe rules). */
export function parseAxonLibraryProject(libDir: string, ref: AxonProjectRef): AxonFunctionRecord[] {
  const out: AxonFunctionRecord[] = [];
  for (const u of collectUnits(ref.dir)) {
    try {
      if (u.kind === 'axon') {
        const raw = fs.readFileSync(u.file, 'utf-8');
        const { doc, codeStartLine } = extractLeadingDoc(raw);
        const body = raw.split(/\r?\n/).slice(codeStartLine - 1).join('\n');
        if (!body.trim() && !doc) continue; // empty / comment-only file
        const sub = path.relative(ref.dir, path.dirname(u.file)).split(path.sep).filter(x => x && x !== '.');
        out.push(makeRecord({ ref, libDir, key: u.key, name: u.name, body, doc, tags: sub.map(x => `folder:${x}`), filePath: u.file, bodyLineOffset: codeStartLine - 1 }));
      } else {
        const rec = parseTrio(u.recText!);
        if (rec.src === undefined) continue;
        const docParts = [rec.tags.dis, rec.tags.doc, rec.tags.help].filter(Boolean) as string[];
        out.push(makeRecord({
          ref, libDir, key: u.key, name: u.name, body: rec.src, doc: docParts.join('\n').trim(), tags: trioTags(rec),
          filePath: u.file, bodyLineOffset: (u.recStartLine ?? 1) - 1 + ((rec.srcLine ?? 1) - 1), modified: rec.tags.mod,
        }));
      }
    } catch { /* skip unreadable unit */ }
  }
  resolveCallEdges(out);
  out.sort((a, b) => a.name.localeCompare(b.name) || a.relPath.localeCompare(b.relPath));
  return out;
}

// ── Cross-source helpers (proj + library) ───────────────────────────────────

export type AxonSource = 'proj' | 'library';

export function isLibraryProjectId(projectId: string): boolean {
  return projectId.startsWith(`${LIBRARY_INSTANCE}/`);
}

/** Scan both sources. `source` narrows to one. */
export function scanAllAxonProjects(source: AxonSource | 'all' = 'all'): AxonProjectRef[] {
  const out: AxonProjectRef[] = [];
  if (source !== 'library') out.push(...scanAxonProj(getAxonProjDir()).projects.map(p => ({ ...p, source: 'proj' as const })));
  if (source !== 'proj') out.push(...scanAxonLibrary(getAxonLibraryDir()).projects);
  return out;
}

/** Parse a project of either source. */
export function parseAnyAxonProject(ref: AxonProjectRef): AxonFunctionRecord[] {
  return ref.source === 'library'
    ? parseAxonLibraryProject(getAxonLibraryDir(), ref)
    : parseAxonProject(getAxonProjDir(), ref);
}

/** Validation payload for `GET /admin/axon/validate?kind=library`. */
export function validateAxonLibraryPath(libraryPath: string): {
  libraryPath: string;
  exists: boolean;
  folders: Array<{ projectId: string; project: string; functionCount: number }>;
  totalFunctions: number;
  problems: string[];
} {
  const problems: string[] = [];
  const exists = fs.existsSync(libraryPath) && fs.statSync(libraryPath).isDirectory();
  if (!exists) problems.push('Path does not exist or is not a directory');
  const scan = exists ? scanAxonLibrary(libraryPath) : null;
  if (scan && scan.projects.length === 0) problems.push('No folders with .axon files or trio function records found');
  return {
    libraryPath,
    exists,
    folders: (scan?.projects ?? []).map(p => ({ projectId: p.projectId, project: p.project, functionCount: p.functionCount })),
    totalFunctions: scan?.totalFunctions ?? 0,
    problems,
  };
}
