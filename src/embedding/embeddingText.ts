/**
 * Canonical builder for the text fed to the CODE embedding model.
 *
 * History: this used to be `qualifiedName + signature + doc[:200]`. But most
 * nodes have no doc, so we were embedding ~just the name+signature — handing a
 * code-specialized model (jina-code) almost no code. A scoped A/B on project
 * 265 showed that appending the actual SOURCE BODY meaningfully improves
 * retrieval, especially for behavioral/conceptual queries (e.g. "websocket
 * reconnect with backoff" surfaces the methods that IMPLEMENT it — getRetryDelay
 * / scheduleReconnect / attemptReconnect — instead of fields merely NAMED
 * "reconnect"). So the body is now included.
 *
 * The body is read from the file by line range. When the parser gave a real
 * span (`lineEnd > lineStart`) we slice exactly that; otherwise a fixed window
 * from `lineStart` (v1/v2 behaviour, still the fallback for graphs built before
 * `line_end` was populated).
 *
 * Used by EVERY code-embedding site (buildProjectEmbeddings, reindexFiles and
 * both re-embed routes) so re-embed and the auto-pipeline produce identical
 * vectors. All v3 behaviour is gated on EMBED_TEXT_VERSION so an older layout
 * can be restored by flipping the constant.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Version of the text layout fed to the embedding model. Bump whenever the
 * text a node embeds to changes shape (not the model), so model-status can
 * tell which projects still hold vectors built from an older layout.
 *   1 — qualifiedName + signature + doc + body
 *   2 — + header line: file path tokens and the file's import specifiers
 *       ("file: src rete nodes | imports: rete, rete-vue-plugin, ./types").
 *       Motivation: `createSedonaNode` in src/rete/nodes.ts never mentions
 *       "rete" in its own name or body; the question does. The header lets
 *       a path/library word in the question reach the code under that path.
 *   3 — (2026-09-14) exact spans + multi-chunk + graph context + kind label:
 *       • first line `kind: function|method|class|mixin|field|type|…` so kind
 *         words in a question match;
 *       • `context: in <Class>; calls: a, b; called by: x, y` from the graph
 *         (buildEmbeddingContext pre-pass, ≤5 names each);
 *       • documentation cap 800 chars (was 200), comment markers stripped
 *         (fandoc `**`, JSDoc slash-star / leading-star / star-slash, `//`);
 *       • body = the exact parser span; spans over 40 lines are embedded as
 *         overlapping 40-line windows (10-line overlap), one vector row per
 *         chunk (row_id `${nodeId}#${i}`, chunk 0 keeps the plain id);
 *       • noise control: license header stripped, import/using lines dropped
 *         from bodies, blank runs collapsed, trailing whitespace trimmed;
 *       • one `kind: file` row per indexed file and one `kind: project` row
 *         per project (see embedSynthetic.ts).
 *       Requires a FULL re-embed: the chunk/line columns only exist on a
 *       freshly created LanceDB table (the shadow-swap path creates one).
 */
export const EMBED_TEXT_VERSION = 3;

/** True when the v3 layout (chunks, context, kind label, file/project rows) is active. */
export const EMBED_TEXT_V3 = EMBED_TEXT_VERSION >= 3;

export interface EmbeddingTextNode {
  qualifiedName: string;
  name?: string | null;
  signature?: string | null;
  documentation?: string | null;
  filePath?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  /** Graph node_type (method, class, field, …) — drives the `kind:` line (v3). */
  nodeType?: string | null;
  /** Pre-computed graph context line from buildEmbeddingContext (v3). */
  context?: string | null;
}

/** One embedding unit for a node. A short node has exactly one chunk. */
export interface EmbeddingChunk {
  chunkIndex: number;
  chunkCount: number;
  /** This chunk's own source range (1-based, inclusive). */
  lineStart: number;
  lineEnd: number;
  text: string;
}

/** A chunk ready for `VectorStore.storeEmbeddings` once `embedding` is attached. */
export interface EmbeddingItem extends EmbeddingChunk {
  nodeId: string;
  nodeType: string;
  qualifiedName: string;
  filePath: string;
}

const HEADER_IMPORTS_MAX_CHARS = 120;
const HEADER_PATH_SEGMENTS = 4;
const HEADER_SCAN_LINES = 120;
const HEADER_CACHE_MAX = 4000;
const GENERIC_PATH_TOKENS = new Set(['src', 'lib', 'fan', 'app', 'index', 'main', 'js', 'ts', 'vue', 'tsx', 'jsx', 'py', 'java']);
const CORE_FANTOM_PODS = new Set(['sys', 'concurrent', 'util', 'inet', 'web', 'wisp', 'xml']);

/** Per-file header cache: the header depends only on the file, and a file
 *  holds many nodes. Keyed by path, invalidated by mtime. */
const headerCache = new Map<string, { mtimeMs: number; header: string }>();

function splitIdentifier(token: string): string[] {
  return token
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_.]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1 && !GENERIC_PATH_TOKENS.has(t));
}

/** "src/rete/computedSocketPosition.ts" → "rete computed socket position". */
export function pathTokensForEmbedding(filePath: string): string {
  const segs = filePath.split(/[\\/]/).filter(Boolean).slice(-HEADER_PATH_SEGMENTS);
  if (!segs.length) return '';
  const last = segs[segs.length - 1].replace(/\.[^.]+$/, '');
  const out: string[] = [];
  for (const s of [...segs.slice(0, -1), last]) for (const t of splitIdentifier(s)) if (!out.includes(t)) out.push(t);
  return out.join(' ');
}

const IMPORT_LINE_RE = /^\s*(?:import\b|export\s+(?:type\s+)?\*?\s*(?:\{[^}]*\})?\s*from\b|using\s+[A-Za-z0-9_.:]+\s*$|(?:const|let|var)\s+[\w{}\s,:]+=\s*require\()/;

/** Import / using specifiers from the head of the file (TS/JS/Vue, Fantom,
 *  Python). Relative imports keep their basename ("./types" → "types");
 *  core Fantom pods are dropped as noise. Capped at 120 chars. */
export function importSpecifiersForEmbedding(source: string): string {
  const lines = source.split('\n', HEADER_SCAN_LINES);
  const specs: string[] = [];
  const push = (raw: string): void => {
    let s = raw.trim();
    if (!s) return;
    if (s.startsWith('.')) s = path.basename(s).replace(/\.[^.]+$/, '');
    if (!s || CORE_FANTOM_PODS.has(s) || specs.includes(s)) return;
    specs.push(s);
  };
  for (const line of lines) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^\s*(?:import|export)\b[^'"]*from\s*['"]([^'"]+)['"]/))) push(m[1]);
    else if ((m = line.match(/^\s*import\s*['"]([^'"]+)['"]/))) push(m[1]);
    else if ((m = line.match(/require\(\s*['"]([^'"]+)['"]\s*\)/))) push(m[1]);
    else if ((m = line.match(/^\s*using\s+([A-Za-z0-9_.]+)/))) push(m[1].split('::')[0]);
    else if ((m = line.match(/^\s*(?:from\s+([A-Za-z0-9_.]+)\s+import|import\s+([A-Za-z0-9_.]+))/))) push((m[1] ?? m[2] ?? '').split('.')[0]);
  }
  let out = '';
  for (const s of specs) {
    const next = out ? `${out}, ${s}` : s;
    if (next.length > HEADER_IMPORTS_MAX_CHARS) break;
    out = next;
  }
  return out;
}

/** Header line for every node in a file: path tokens + import specifiers. */
export function fileHeaderForEmbedding(filePath?: string | null): string {
  if (!filePath) return '';
  try {
    const st = fs.statSync(filePath);
    const cached = headerCache.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.header;
    const tokens = pathTokensForEmbedding(filePath);
    let imports = '';
    if (st.size < 2_000_000) imports = importSpecifiersForEmbedding(fs.readFileSync(filePath, 'utf-8'));
    const header = `file: ${tokens}${imports ? ` | imports: ${imports}` : ''}`;
    if (headerCache.size >= HEADER_CACHE_MAX) headerCache.clear();
    headerCache.set(filePath, { mtimeMs: st.mtimeMs, header });
    return header;
  } catch {
    return '';
  }
}

// ── Source access (cached per file) ─────────────────────────────────────────

const SOURCE_CACHE_MAX = 64;
const SOURCE_MAX_BYTES = 4_000_000;
const sourceCache = new Map<string, { mtimeMs: number; lines: string[] }>();

/** Lines of a file, cached by mtime. A file holds many nodes and each node
 *  (and each chunk) needs its lines; v2 re-read the file per node. */
export function readSourceLines(filePath?: string | null): string[] | null {
  try {
    if (!filePath) return null;
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size > SOURCE_MAX_BYTES) return null;
    const cached = sourceCache.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.lines;
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    if (sourceCache.size >= SOURCE_CACHE_MAX) sourceCache.delete(sourceCache.keys().next().value as string);
    sourceCache.set(filePath, { mtimeMs: st.mtimeMs, lines });
    return lines;
  } catch {
    return null;
  }
}

// ── Budgets ─────────────────────────────────────────────────────────────────

const BODY_MAX_LINES = 25;        // v1/v2 window; v3 fallback when no real span
const BODY_MAX_CHARS = 1200;      // v1/v2 body cap
const TOTAL_MAX_CHARS = 4000;     // jina-code context + payload budget (per chunk in v3)
export const CHUNK_LINES = 40;    // v3: span longer than this → multiple chunks
export const CHUNK_OVERLAP = 10;  // v3: lines shared between neighbouring chunks
const CHUNK_BODY_MAX_CHARS = 3000;
const DOC_MAX_CHARS_V2 = 200;
const DOC_MAX_CHARS_V3 = 800;

/** Read the source body for a node by line range. Exact span when lineEnd is
 *  accurate, else a fixed window from lineStart. Best-effort; '' on any error.
 *  (v2 semantics; kept for callers that want the single-window body.) */
export function readBodyForEmbedding(
  filePath?: string | null,
  lineStart?: number | null,
  lineEnd?: number | null,
): string {
  try {
    if (!filePath || !lineStart || lineStart < 1) return '';
    const lines = readSourceLines(filePath);
    if (!lines) return '';
    const start = lineStart - 1;
    const hasRealEnd = typeof lineEnd === 'number' && lineEnd > lineStart;
    const end = hasRealEnd
      ? Math.min(lines.length, start + Math.min(lineEnd - lineStart + 1, BODY_MAX_LINES))
      : Math.min(lines.length, start + BODY_MAX_LINES);
    let body = lines.slice(start, end).join('\n');
    if (body.length > BODY_MAX_CHARS) body = body.slice(0, BODY_MAX_CHARS);
    return body;
  } catch {
    return '';
  }
}

// ── v3 helpers: kind label, doc cleaning, noise control ─────────────────────

/** Graph node_type → the kind word placed on the first line. */
export function kindLabel(nodeType?: string | null): string {
  switch ((nodeType || '').toLowerCase()) {
    case 'function': return 'function';
    case 'method':
    case 'constructor': return 'method';
    case 'class': return 'class';
    case 'mixin':
    case 'interface': return 'mixin';
    case 'field':
    case 'property':
    case 'variable': return 'field';
    case 'enum':
    case 'facet':
    case 'struct':
    case 'type':
    case 'typedef': return 'type';
    case 'comment': return 'comment';
    case 'file': return 'file';
    case 'project': return 'project';
    case '': return 'symbol';
    default: return nodeType!.toLowerCase();
  }
}

/** Strip comment markers (fandoc `**`, JSDoc slash-star markers, `//`, `#`) and
 *  collapse whitespace so the model sees prose, not decoration. */
export function cleanDocumentation(doc?: string | null, cap = DOC_MAX_CHARS_V3): string {
  if (!doc) return '';
  const lines = doc.split('\n').map((l) => l
    .replace(/^\s*\/\*\*+\s?/, '')
    .replace(/\s*\*+\/\s*$/, '')
    .replace(/^\s*\*+\s?/, '')
    .replace(/^\s*\/\/+\s?/, '')
    .replace(/^\s*#+\s?/, '')
    .replace(/\s+$/, ''));
  const out = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return out.length > cap ? out.slice(0, cap) : out;
}

// Deliberately narrow: a module doc that merely mentions "license" must survive.
const LICENSE_RE = /copyright|©|\(c\)\s*\d{4}|all rights reserved|spdx-license-identifier|licensed under|licen[cs]e(d)?\s+(under|at|by|to)|permission is hereby granted|apache license|mit license|bsd license|gnu (general|lesser) public|proprietary and confidential/i;

/** Drop a leading license/copyright comment block (`/* … *\/`, `//…`, `**…`,
 *  `#…` runs). Only the FIRST comment block is considered and only when it
 *  mentions a license/copyright word; a normal file doc comment is kept. */
export function stripLicenseHeader(lines: string[]): string[] {
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length) return lines;
  const first = lines[i].trim();
  let end = -1;
  if (first.startsWith('/*')) {
    for (let j = i; j < Math.min(lines.length, i + 80); j++) {
      if (lines[j].includes('*/')) { end = j; break; }
    }
  } else if (/^(\/\/|\*\*|#)/.test(first)) {
    const marker = first.startsWith('//') ? '//' : first.startsWith('**') ? '**' : '#';
    let j = i;
    while (j < lines.length && lines[j].trim().startsWith(marker)) j++;
    end = j - 1;
  }
  if (end < 0) return lines;
  const block = lines.slice(i, end + 1).join('\n');
  if (!LICENSE_RE.test(block)) return lines;
  return lines.slice(end + 1);
}

/** Body noise control: trailing whitespace, import/using/require lines
 *  (already in the header), runs of blank lines. */
export function cleanBodyLines(lines: string[]): string[] {
  const out: string[] = [];
  let blank = 0;
  for (const raw of lines) {
    const l = raw.replace(/\s+$/, '');
    if (IMPORT_LINE_RE.test(l)) continue;
    if (l.trim() === '') {
      if (++blank > 1) continue;
    } else {
      blank = 0;
    }
    out.push(l);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  while (out.length && out[0].trim() === '') out.shift();
  return out;
}

function nameTokens(qualifiedName: string): string {
  return qualifiedName.replace(/::/g, ' ').replace(/\./g, ' ');
}

// ── Chunk builder ───────────────────────────────────────────────────────────

/** v1/v2 text — single window, unchanged from EMBED_TEXT_VERSION 2. */
function buildV2Text(node: EmbeddingTextNode): string {
  const parts: string[] = [];
  const header = fileHeaderForEmbedding(node.filePath);
  if (header) parts.push(header);
  parts.push(nameTokens(node.qualifiedName));
  if (node.signature) parts.push(node.signature);
  if (node.documentation) parts.push(node.documentation.slice(0, DOC_MAX_CHARS_V2));
  const body = readBodyForEmbedding(node.filePath, node.lineStart, node.lineEnd);
  if (body) parts.push(body);
  const text = parts.join('\n');
  return text.length > TOTAL_MAX_CHARS ? text.slice(0, TOTAL_MAX_CHARS) : text;
}

/**
 * Split a node into its embedding chunks (v3). A node whose span is at most
 * CHUNK_LINES lines (or has no real span) is one chunk; longer spans become
 * overlapping windows. Every chunk repeats the kind/header/name/signature/
 * context preamble so each vector stands on its own; the documentation is only
 * in chunk 0 (it describes the whole symbol, and the budget is per chunk).
 */
export function buildCodeEmbeddingChunks(node: EmbeddingTextNode): EmbeddingChunk[] {
  const ls = typeof node.lineStart === 'number' && node.lineStart > 0 ? node.lineStart : 1;
  if (!EMBED_TEXT_V3) {
    return [{ chunkIndex: 0, chunkCount: 1, lineStart: ls, lineEnd: node.lineEnd && node.lineEnd > ls ? node.lineEnd : ls, text: buildV2Text(node) }];
  }

  const preamble: string[] = [`kind: ${kindLabel(node.nodeType)}`];
  const header = fileHeaderForEmbedding(node.filePath);
  if (header) preamble.push(header);
  preamble.push(nameTokens(node.qualifiedName));
  if (node.signature) preamble.push(node.signature.replace(/\s+/g, ' ').trim());
  if (node.context) preamble.push(node.context);
  const doc = cleanDocumentation(node.documentation, DOC_MAX_CHARS_V3);

  // Source span.
  const lines = readSourceLines(node.filePath);
  let spanLines: string[] = [];
  let spanStart = ls;
  if (lines && node.lineStart && node.lineStart >= 1) {
    const start = node.lineStart - 1;
    const hasRealEnd = typeof node.lineEnd === 'number' && node.lineEnd > node.lineStart;
    const end = hasRealEnd
      ? Math.min(lines.length, node.lineEnd as number)
      : Math.min(lines.length, start + BODY_MAX_LINES);
    spanLines = lines.slice(start, end);
    if (start === 0) {
      const stripped = stripLicenseHeader(spanLines);
      spanStart += spanLines.length - stripped.length;
      spanLines = stripped;
    }
  }

  // Windows over the span.
  const windows: Array<{ from: number; to: number }> = [];
  if (spanLines.length <= CHUNK_LINES) {
    windows.push({ from: 0, to: spanLines.length });
  } else {
    const step = CHUNK_LINES - CHUNK_OVERLAP;
    for (let s = 0; s < spanLines.length; s += step) {
      const e = Math.min(spanLines.length, s + CHUNK_LINES);
      windows.push({ from: s, to: e });
      if (e >= spanLines.length) break;
    }
  }

  const chunks: EmbeddingChunk[] = windows.map((w, i) => {
    const parts = [...preamble];
    if (i === 0 && doc) parts.push(doc);
    let body = cleanBodyLines(spanLines.slice(w.from, w.to)).join('\n');
    if (body.length > CHUNK_BODY_MAX_CHARS) body = body.slice(0, CHUNK_BODY_MAX_CHARS);
    if (body) parts.push(body);
    let text = parts.join('\n');
    if (text.length > TOTAL_MAX_CHARS) text = text.slice(0, TOTAL_MAX_CHARS);
    return {
      chunkIndex: i,
      chunkCount: windows.length,
      lineStart: spanStart + w.from,
      lineEnd: spanLines.length ? spanStart + w.to - 1 : spanStart,
      text,
    };
  });
  return chunks;
}

/** Build the embedding text for a node — chunk 0 of buildCodeEmbeddingChunks.
 *  Kept as the single-string entry point for callers that embed one text per
 *  node (v2-compatible signature). */
export function buildCodeEmbeddingText(node: EmbeddingTextNode): string {
  return buildCodeEmbeddingChunks(node)[0].text;
}

/**
 * Expand graph nodes into embedding items (one per chunk). `context` is the
 * Map from buildEmbeddingContext; missing entries just omit the context line.
 */
export function buildEmbeddingItems(
  nodes: Array<EmbeddingTextNode & { id: string }>,
  context?: Map<string, string> | null,
): EmbeddingItem[] {
  const items: EmbeddingItem[] = [];
  for (const n of nodes) {
    const ctx = context?.get(n.id) ?? n.context ?? null;
    const chunks = buildCodeEmbeddingChunks({ ...n, context: ctx });
    for (const c of chunks) {
      items.push({
        ...c,
        nodeId: n.id,
        nodeType: n.nodeType || 'symbol',
        qualifiedName: n.qualifiedName,
        filePath: n.filePath || '',
      });
    }
  }
  return items;
}

// ── File- and project-level texts (v3) ──────────────────────────────────────

export function fileNodeId(filePath: string): string {
  return `file:${crypto.createHash('sha1').update(filePath).digest('hex')}`;
}

export function projectNodeId(projectId: number): string {
  return `project:${projectId}`;
}

export interface FileEmbeddingInput {
  filePath: string;
  /** Path relative to the project root, used for the qualified name. */
  relativePath: string;
  projectName: string;
  /** Top-level / exported symbols in the file with their kinds. */
  symbols: Array<{ name: string; kind: string }>;
}

const FILE_SYMBOLS_MAX = 60;
const FILE_HEAD_LINES = 30;

/** `kind: file` text: path tokens, imports, symbol list with kinds and the
 *  first lines of the file (after the license header) for a top-of-file doc. */
export function buildFileEmbeddingText(input: FileEmbeddingInput): string {
  const parts: string[] = ['kind: file'];
  const header = fileHeaderForEmbedding(input.filePath);
  parts.push(header || `file: ${pathTokensForEmbedding(input.filePath)}`);
  parts.push(`${input.projectName} ${input.relativePath.replace(/[\\/]/g, ' ')}`);
  const seen = new Set<string>();
  const syms: string[] = [];
  for (const s of input.symbols) {
    const key = `${s.kind}:${s.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    syms.push(`${kindLabel(s.kind)} ${s.name}`);
    if (syms.length >= FILE_SYMBOLS_MAX) break;
  }
  if (syms.length) parts.push(`symbols: ${syms.join(', ')}`);
  const lines = readSourceLines(input.filePath);
  if (lines) {
    const head = cleanBodyLines(stripLicenseHeader(lines).slice(0, FILE_HEAD_LINES));
    if (head.length) parts.push(head.join('\n'));
  }
  const text = parts.join('\n');
  return text.length > TOTAL_MAX_CHARS ? text.slice(0, TOTAL_MAX_CHARS) : text;
}

export interface ProjectEmbeddingInput {
  name: string;
  language?: string | null;
  description?: string | null;
  readme?: string | null;
  depends?: string[];
  libraries?: string[];
  path?: string | null;
}

const README_MAX_CHARS = 1500;

/** `kind: project` text: name, language, description, README head, depends, libraries. */
export function buildProjectEmbeddingText(input: ProjectEmbeddingInput): string {
  const parts: string[] = ['kind: project', `project: ${input.name}`];
  if (input.language) parts.push(`language: ${input.language}`);
  if (input.path) parts.push(`path: ${pathTokensForEmbedding(input.path)}`);
  if (input.description) parts.push(cleanDocumentation(input.description, 600));
  if (input.depends?.length) parts.push(`depends: ${input.depends.slice(0, 40).join(', ')}`);
  if (input.libraries?.length) parts.push(`libraries: ${input.libraries.slice(0, 40).join(', ')}`);
  if (input.readme) {
    const readme = cleanDocumentation(input.readme.replace(/\r/g, ''), README_MAX_CHARS);
    if (readme) parts.push(readme);
  }
  const text = parts.join('\n');
  return text.length > TOTAL_MAX_CHARS ? text.slice(0, TOTAL_MAX_CHARS) : text;
}
