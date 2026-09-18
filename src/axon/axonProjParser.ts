/**
 * Parser for the Axon MCP server's synced project folder:
 *
 *   proj/<instance>/<project>/.sync-metadata.json
 *   proj/<instance>/<project>/func/<name>.trio   (metadata + `src:` block)
 *   proj/<instance>/<project>/func/<name>.axon   (bare source)
 *
 * Produces `AxonFunctionRecord`s and the embedding text for each. Pure
 * filesystem + string work — no LanceDB, no network — so it is unit-testable
 * and reusable by the validate endpoint, the indexer, and the MCP tools.
 *
 * Confidentiality: records are derived data. Nothing here copies files out of
 * `proj/`; callers must never persist bodies outside `.cache/`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  parseAxonSignature, buildAxonEmbeddingChunks, buildAxonEmbeddingText as buildTextFromInput,
  type AxonParam, type AxonEmbeddingChunk,
} from './axonEmbeddingText.js';
import { extractAxonCallNames } from './axonTreeSitter.js';

export type AxonRecordSource = 'proj' | 'library';

export interface AxonProjectRef {
  /** `${instance}/${project}` — stable string id used across routes and LanceDB. */
  projectId: string;
  /** Which tree the project comes from: synced `proj/` or the offline library. */
  source: AxonRecordSource;
  instance: string;
  project: string;
  /** Absolute path of the project folder. */
  dir: string;
  functionCount: number;
  lastSync?: string;
}

export interface AxonFunctionRecord {
  /** 16-hex md5 of `${instance}/${project}/${name}` — the LanceDB node_id. */
  id: string;
  source: AxonRecordSource;
  projectId: string;
  instance: string;
  project: string;
  name: string;
  /** `${instance}/${project}::${name}` — display name. */
  qualifiedName: string;
  params: string[];
  /** Structured parameters (name, default, optional type) from the lambda header. */
  paramDefs: AxonParam[];
  /** From .sync-metadata.json signature.returnType (Grid/Dict/List/Str/Number) when known. */
  returnType?: string;
  /** Rendered signature, e.g. `ahuBadOAT(ahu, dates, tolerance = null) => Grid` */
  signature: string;
  /** dis/help/doc from the trio record + description from .sync-metadata.json. */
  doc: string;
  /** Source body (trio `src:` block or the .axon file). */
  body: string;
  /** Path relative to the `proj/` dir (portable across projectPath changes). */
  relPath: string;
  /** Absolute path of the .axon file (or .trio when no .axon exists). */
  filePath: string;
  trioPath?: string;
  lineStart: number;
  lineEnd: number;
  /** Trio marker/meta tags: ruleOn:ahu, sparkRule, kpiRule, author:x … */
  tags: string[];
  /** Function names this function calls (from .sync-metadata.json when present). */
  calls: string[];
  /** Functions in the same project that call this one (inverse of `calls`). */
  calledBy: string[];
  /**
   * Names called from the body that are NOT functions of this project — Axon
   * builtins (`hisRead`, `foldCol`) and cross-project helpers.
   *
   * Kept separate from `calls` on purpose. `calls` means "project functions",
   * `calledBy` is built by matching those names against in-project records,
   * and both are surfaced to users and MCP callers; folding every identifier
   * followed by a paren into `calls` would quietly change what that field
   * means everywhere it is read.
   */
  uses: string[];
  /** 1-based line in `filePath` where `body` line 1 lives. */
  bodyLineOffset: number;
  /** Content hash of body+doc so re-index can skip unchanged functions later. */
  hash: string;
  modified?: string;
}

export interface AxonScanSummary {
  projDir: string;
  exists: boolean;
  instances: string[];
  projects: AxonProjectRef[];
  totalFunctions: number;
}

const FUNC_DIR = 'func';
export const AXON_EMBED_MAX_CHARS = 4000;

export function axonProjectId(instance: string, project: string): string {
  return `${instance}/${project}`;
}

export function axonFunctionId(instance: string, project: string, name: string): string {
  return createHash('md5').update(`${instance}/${project}/${name}`).digest('hex').slice(0, 16);
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isHidden(name: string): boolean {
  return name.startsWith('.');
}

/** List instances/projects under `projDir` without parsing function bodies. */
export function scanAxonProj(projDir: string): AxonScanSummary {
  const exists = fs.existsSync(projDir) && fs.statSync(projDir).isDirectory();
  const summary: AxonScanSummary = { projDir, exists, instances: [], projects: [], totalFunctions: 0 };
  if (!exists) return summary;

  for (const inst of safeReaddir(projDir)) {
    if (!inst.isDirectory() || isHidden(inst.name)) continue;
    const instDir = path.join(projDir, inst.name);
    let sawProject = false;
    for (const proj of safeReaddir(instDir)) {
      if (!proj.isDirectory() || isHidden(proj.name)) continue;
      const dir = path.join(instDir, proj.name);
      const funcDir = path.join(dir, FUNC_DIR);
      const files = safeReaddir(funcDir).filter(f => f.isFile());
      const names = new Set<string>();
      for (const f of files) {
        if (f.name.endsWith('.trio') || f.name.endsWith('.axon')) {
          names.add(f.name.replace(/\.(trio|axon)$/, ''));
        }
      }
      if (names.size === 0 && !fs.existsSync(funcDir)) continue;
      sawProject = true;
      const meta = readSyncMetadata(dir);
      summary.projects.push({
        source: 'proj',
        projectId: axonProjectId(inst.name, proj.name),
        instance: inst.name,
        project: proj.name,
        dir,
        functionCount: names.size,
        lastSync: meta?.lastSync,
      });
      summary.totalFunctions += names.size;
    }
    if (sawProject) summary.instances.push(inst.name);
  }
  summary.projects.sort((a, b) => a.projectId.localeCompare(b.projectId));
  return summary;
}

interface SyncMetadata {
  instance?: string;
  project?: string;
  lastSync?: string;
  functionCount?: number;
  functions?: Record<string, {
    name?: string;
    hash?: string;
    synced?: string;
    signature?: { parameters?: Array<{ name: string; required?: boolean }>; returnType?: string };
    dependencies?: { functions?: string[]; tags?: string[] };
    documentation?: { description?: string; examples?: string[]; notes?: string[] };
  }>;
}

function readSyncMetadata(projectDir: string): SyncMetadata | null {
  try {
    const p = path.join(projectDir, '.sync-metadata.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as SyncMetadata;
  } catch {
    return null;
  }
}

// ── Trio parsing ────────────────────────────────────────────────────────────

export interface TrioRecord {
  /** Scalar tags (quoted strings unquoted, markers → '✔'). */
  tags: Record<string, string>;
  /** The `src:` block with the 2-space indent stripped. */
  src?: string;
  /** 1-based line in the trio file where the src block starts. */
  srcLine?: number;
}

/**
 * Minimal trio reader for the shape the Axon sync writes: `key:value` at
 * column 0; quoted values may span lines until a closing quote; `key:` followed
 * by indented lines is a block (the `src:` block). Tolerant — never throws.
 */
export function parseTrio(text: string): TrioRecord {
  const lines = text.split(/\r?\n/);
  const rec: TrioRecord = { tags: {} };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line);
    if (!m) {
      // Bare marker tag on its own line (trio `func`, `sparkRule`, …).
      const marker = /^([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(line);
      if (marker && !line.startsWith(' ')) rec.tags[marker[1]] = '✔';
      i++;
      continue;
    }
    const key = m[1];
    const rest = m[2];
    if (rest.trim() === '') {
      // Block value: consume following indented lines.
      const block: string[] = [];
      const start = i + 1;
      let j = start;
      while (j < lines.length && (lines[j].startsWith('  ') || lines[j].trim() === '')) {
        block.push(lines[j].startsWith('  ') ? lines[j].slice(2) : lines[j]);
        j++;
      }
      // Trim trailing blank lines
      while (block.length && block[block.length - 1].trim() === '') block.pop();
      if (key === 'src') {
        rec.src = block.join('\n');
        rec.srcLine = start + 1;
      } else {
        rec.tags[key] = block.join('\n');
      }
      i = j;
      continue;
    }
    if (rest.startsWith('"')) {
      // Quoted string, possibly multi-line.
      let buf = rest.slice(1);
      let j = i;
      while (!/"\s*$/.test(buf) && j + 1 < lines.length) {
        j++;
        buf += '\n' + lines[j];
      }
      rec.tags[key] = buf.replace(/"\s*$/, '').replace(/\\n/g, '\n').replace(/\\"/g, '"');
      i = j + 1;
      continue;
    }
    rec.tags[key] = rest.trim();
    i++;
  }
  return rec;
}

/** Back-compat helper: parameter names + header line from a body. */
export function extractAxonParams(src: string): { params: string[]; line: number } {
  const sig = parseAxonSignature('f', src);
  return { params: sig.params.map(p => p.name), line: sig.headerLine };
}

const IGNORED_TAGS = new Set(['name', 'src', 'mod', 'dis', 'help', 'doc', 'id']);

/** Parse every function of one project. */
export function parseAxonProject(projDir: string, ref: AxonProjectRef): AxonFunctionRecord[] {
  const funcDir = path.join(ref.dir, FUNC_DIR);
  const meta = readSyncMetadata(ref.dir);
  const names = new Map<string, { trio?: string; axon?: string }>();
  for (const f of safeReaddir(funcDir)) {
    if (!f.isFile()) continue;
    if (f.name.endsWith('.trio')) {
      const n = f.name.slice(0, -5);
      names.set(n, { ...(names.get(n) ?? {}), trio: path.join(funcDir, f.name) });
    } else if (f.name.endsWith('.axon')) {
      const n = f.name.slice(0, -5);
      names.set(n, { ...(names.get(n) ?? {}), axon: path.join(funcDir, f.name) });
    }
  }

  const out: AxonFunctionRecord[] = [];
  for (const [fileName, files] of names) {
    try {
      const rec = parseOneFunction(projDir, ref, fileName, files, meta);
      if (rec) out.push(rec);
    } catch {
      /* tolerate a malformed file; the indexer reports counts */
    }
  }
  resolveCallEdges(out);
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Split each record's raw call candidates into `calls` (functions of this
 * project) and `uses` (everything else), then build the inverse `calledBy`.
 *
 * Shared by both parsers. The offline library has no `.sync-metadata.json` at
 * all, so before this its 2,034 functions carried `calls: []` and `calledBy:
 * []` — no call context in the embedding text, and nothing in the UI.
 */
/**
 * Axon keywords and operators the sync metadata lists as "dependencies".
 * `lightsOnAndUnoccupied` had `and` in its `dependencies.functions`.
 */
const NOT_A_FUNCTION = new Set([
  'and', 'or', 'not', 'do', 'end', 'if', 'else', 'try', 'catch', 'while',
  'return', 'throw', 'null', 'true', 'false', 'defcomp',
]);

export function resolveCallEdges(records: AxonFunctionRecord[]): void {
  const byName = new Map(records.map(r => [r.name, r] as const));
  for (const r of records) {
    // Candidates from BOTH sources. The sync metadata is not a filtered list
    // of project functions — `lightsOnAndUnoccupied` came back with
    // `hisFindPeriods`, `foldCol`, `addMeta` and even `and` in its
    // `dependencies.functions` — so trusting it wholesale for `calls` is what
    // made that field mean "some names, mixed" rather than what it says.
    const candidates = [...r.calls, ...r.uses];
    const calls: string[] = [];
    const uses: string[] = [];
    for (const n of candidates) {
      if (n === r.name) continue;                       // self-recursion is not an edge
      if (NOT_A_FUNCTION.has(n)) continue;
      if (calls.includes(n) || uses.includes(n)) continue;
      if (byName.has(n)) calls.push(n);                 // a function of this project
      else uses.push(n);                                // builtin or cross-project
    }
    r.calls = calls;
    r.uses = uses;
  }
  // Inverse call map within the project (callers are not stored by the sync).
  for (const r of records) {
    for (const callee of r.calls) {
      const target = byName.get(callee);
      if (target && target !== r && !target.calledBy.includes(r.name)) target.calledBy.push(r.name);
    }
  }
  for (const r of records) { r.calledBy.sort(); r.uses.sort(); }
}

function parseOneFunction(
  projDir: string,
  ref: AxonProjectRef,
  fileName: string,
  files: { trio?: string; axon?: string },
  meta: SyncMetadata | null,
): AxonFunctionRecord | null {
  let trio: TrioRecord | null = null;
  if (files.trio) {
    trio = parseTrio(fs.readFileSync(files.trio, 'utf-8'));
  }
  let body = '';
  let bodyFile = files.axon ?? files.trio!;
  let lineOffset = 0;
  if (files.axon) {
    body = fs.readFileSync(files.axon, 'utf-8');
  } else if (trio?.src !== undefined) {
    body = trio.src;
    lineOffset = (trio.srcLine ?? 1) - 1;
    bodyFile = files.trio!;
  }
  body = body.replace(/\s+$/, '');
  if (!body && !trio) return null;

  const name = trio?.tags.name || fileName;
  const m = meta?.functions?.[name];
  const sig = parseAxonSignature(name, body, m?.signature);
  const params = sig.params.map(p => p.name);
  const line = sig.headerLine;

  const docParts: string[] = [];
  if (trio?.tags.dis) docParts.push(trio.tags.dis);
  if (trio?.tags.doc) docParts.push(trio.tags.doc);
  if (trio?.tags.help) docParts.push(trio.tags.help);
  if (m?.documentation?.description) docParts.push(m.documentation.description);
  const doc = dedupeLines(docParts.join('\n')).trim();

  const tags: string[] = [];
  if (trio) {
    for (const [k, v] of Object.entries(trio.tags)) {
      if (IGNORED_TAGS.has(k)) continue;
      if (v === '✔' || v === '' || v === 'M') tags.push(k);
      else tags.push(`${k}:${v.split('\n')[0].slice(0, 60)}`);
    }
  }

  const bodyLines = body ? body.split('\n').length : 0;
  const hash = createHash('md5').update(body).update(' ').update(doc).digest('hex').slice(0, 16);

  return {
    id: axonFunctionId(ref.instance, ref.project, name),
    source: 'proj',
    projectId: ref.projectId,
    instance: ref.instance,
    project: ref.project,
    name,
    qualifiedName: `${ref.projectId}::${name}`,
    params,
    paramDefs: sig.params,
    returnType: sig.returnType,
    signature: sig.text,
    doc,
    body,
    relPath: path.relative(projDir, bodyFile),
    filePath: bodyFile,
    trioPath: files.trio,
    lineStart: lineOffset + line,
    lineEnd: lineOffset + Math.max(bodyLines, line),
    tags,
    // Metadata dependencies are authoritative when the sync provided them
    // (they can name functions outside this project). `resolveCallEdges`
    // below adds what the SOURCE shows and splits off the builtins.
    calls: m?.dependencies?.functions ?? [],
    calledBy: [],
    uses: extractAxonCallNames(body),
    bodyLineOffset: lineOffset + 1,
    hash,
    modified: trio?.tags.mod,
  };
}

function dedupeLines(s: string): string {
  const seen = new Set<string>();
  return s.split('\n').filter(l => {
    const k = l.trim();
    if (!k) return true;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).join('\n');
}

/** Parse all projects (or the given projectIds) under `projDir`. */
export function parseAllAxonProjects(projDir: string, projectIds?: string[]): Map<string, AxonFunctionRecord[]> {
  const scan = scanAxonProj(projDir);
  const want = projectIds ? new Set(projectIds) : null;
  const out = new Map<string, AxonFunctionRecord[]>();
  for (const ref of scan.projects) {
    if (want && !want.has(ref.projectId)) continue;
    out.set(ref.projectId, parseAxonProject(projDir, ref));
  }
  return out;
}

// ── Embedding text (delegates to the Axon embedding text model) ─────────────

function toEmbeddingInput(r: AxonFunctionRecord) {
  return {
    instance: r.instance, project: r.project, name: r.name, qualifiedName: r.qualifiedName,
    relPath: r.relPath, body: r.body, doc: r.doc, tags: r.tags,
    signature: { name: r.name, params: r.paramDefs, returnType: r.returnType, text: r.signature, headerLine: r.lineStart - r.bodyLineOffset + 1 },
    calls: r.calls, calledBy: r.calledBy, uses: r.uses, bodyLineOffset: r.bodyLineOffset,
  };
}

/** All embedding chunks (one per 40-line window) for a function. */
export function buildAxonEmbeddingChunksFor(r: AxonFunctionRecord): AxonEmbeddingChunk[] {
  return buildAxonEmbeddingChunks(toEmbeddingInput(r));
}

/** Chunk 0 text — see src/axon/axonEmbeddingText.ts for the layout. */
export function buildAxonEmbeddingText(r: AxonFunctionRecord): string {
  return buildTextFromInput(toEmbeddingInput(r));
}

/** Validation payload for `GET /admin/axon/validate`. */
export function validateAxonProjectPath(projectPath: string): {
  projectPath: string;
  exists: boolean;
  packageJson: boolean;
  serverEntry: boolean;
  projDir: string;
  projExists: boolean;
  instances: string[];
  projects: Array<{ projectId: string; instance: string; project: string; functionCount: number; lastSync?: string }>;
  totalFunctions: number;
  problems: string[];
} {
  const problems: string[] = [];
  const exists = fs.existsSync(projectPath) && fs.statSync(projectPath).isDirectory();
  const packageJson = exists && fs.existsSync(path.join(projectPath, 'package.json'));
  const serverEntry = exists && fs.existsSync(path.join(projectPath, 'dist', 'index.js'));
  const projDir = path.join(projectPath, 'proj');
  const scan = scanAxonProj(projDir);
  if (!exists) problems.push('Path does not exist or is not a directory');
  if (exists && !packageJson) problems.push('No package.json — is this the axon-mcp-server checkout?');
  if (exists && !serverEntry) problems.push('dist/index.js missing — run `npm run build` in the Axon server first');
  if (exists && !scan.exists) problems.push('proj/ folder missing — no synced SkySpark projects to index');
  if (scan.exists && scan.projects.length === 0) problems.push('proj/ contains no <instance>/<project>/func folders');
  return {
    projectPath,
    exists,
    packageJson,
    serverEntry,
    projDir,
    projExists: scan.exists,
    instances: scan.instances,
    projects: scan.projects.map(p => ({
      projectId: p.projectId, instance: p.instance, project: p.project,
      functionCount: p.functionCount, lastSync: p.lastSync,
    })),
    totalFunctions: scan.totalFunctions,
    problems,
  };
}
