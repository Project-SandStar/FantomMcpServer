/**
 * Axon EMBEDDING TEXT MODEL — the exact text layout every Axon function vector
 * is built from. Aligned with Fantom's code layout v3 (src/embedding/embeddingText.ts,
 * EMBED_TEXT_VERSION 3): kind line, header line, name, signature, context,
 * cleaned doc, body; overlapping 40-line windows for long bodies; noise stripping.
 *
 *   kind: axon-function
 *   project: <project> | instance: <instance> | file: <path tokens> | tags: <trio tags>
 *   <instance>/<project>::<funcName>
 *   <funcName>(<p1>, <p2> = <default>, …) => <ReturnType>
 *   cells: target, date, out, occ {bind}, threshold {bindTuning}   (defcomp only)
 *   context: calls: a, b, c; called by: x, y            (≤5 each; omitted when unknown)
 *   uses: hisRead, hisFindPeriods, foldCol              (Axon builtins, ≤8)
 *   doc: <cleaned dis/doc/help, ≤800 chars>              (chunk 0 only)
 *   <body: Axon source, ≤4000 chars per chunk, split at STATEMENT boundaries>
 *
 * Signature model (Axon lambdas have no declared parameter types — `p: v` is a
 * DEFAULT VALUE in Axon, not a type). Types are rendered only when present in
 * the sync metadata; the return type comes from `.sync-metadata.json`
 * (`signature.returnType`, e.g. Grid/Dict/List/Str/Number) when available.
 *
 * Bump AXON_EMBED_TEXT_VERSION whenever this layout changes; the indexer records
 * it per project in `.cache/axon-embedding-meta.json`, the row carries it in
 * `embed_text_version`, and `getAxonTableStats()` reports a table still holding
 * an older layout the same way it reports a dims mismatch.
 *
 * ── v2 (2026-09-18): structure, not line windows ──────────────────────────
 *
 * v1 cut long bodies into blind 40-line windows. 35% of this corpus (2,399 of
 * 6,886 bodies) is longer than that, so a third of all functions were being
 * embedded as fragments cut mid-expression — and 2,715 bodies use multi-line
 * dot chains, which is exactly the shape a fixed window bisects worst.
 *
 * v2 splits at STATEMENT boundaries found by `axonSyntax.scanAxon`, packing
 * whole statements up to the same budget. When the scan cannot make sense of a
 * body (4.8% — Axon forms the scanner does not model) it falls back to v1
 * windows rather than split on a structure it does not trust.
 *
 * Two other v2 changes, both about signal rather than shape:
 *   • comments are KEPT. v1 dropped every comment-only line; Fantom's own
 *     `cleanBodyLines` never did that, and in Axon rule functions the comments
 *     ("// get periods when lights are on") are the best natural-language
 *     description of the code there is.
 *   • `defcomp` cells are surfaced. 23% of bodies are defcomps, which are not
 *     lambdas — `parseAxonSignature` finds no parameters, so they rendered as
 *     `name()` with their whole interface invisible.
 */

import {
  cleanDocumentation, CHUNK_LINES, CHUNK_OVERLAP,
} from '../embedding/embeddingText.js';
import { axonStatementUnits, parseDefcompCells, type AxonUnit } from './axonTreeSitter.js';

export const AXON_EMBED_TEXT_VERSION = 2;

export const AXON_DOC_MAX_CHARS = 800;
export const AXON_CHUNK_BODY_MAX_CHARS = 4000;
export const AXON_TOTAL_MAX_CHARS = 4000;
const CONTEXT_MAX_NAMES = 5;
const HEADER_TAGS_MAX = 8;
const CELLS_MAX = 12;
const USES_MAX = 8;

export interface AxonParam {
  name: string;
  /** Only when a type is known (sync metadata); Axon source never declares one. */
  type?: string;
  /** Default value expression as written in the source (e.g. `null`, `"AHU"`, `thisMonth`). */
  default?: string;
  required: boolean;
}

export interface AxonSignature {
  name: string;
  params: AxonParam[];
  returnType?: string;
  /** Rendered signature line, e.g. `ahuBadOAT(ahu, dates, tolerance = null) => Grid` */
  text: string;
  /** 1-based line (within the body) of the lambda header, 1 when not found. */
  headerLine: number;
}

/** The record fields the text model needs (subset of AxonFunctionRecord). */
export interface AxonEmbeddingInput {
  instance: string;
  project: string;
  name: string;
  qualifiedName: string;
  relPath: string;
  body: string;
  doc: string;
  tags: string[];
  signature: AxonSignature;
  calls: string[];
  calledBy: string[];
  /** Axon builtins the body calls (not project functions) — the `uses:` line. */
  uses?: string[];
  /** 1-based line in `filePath` where `body` line 1 lives (for chunk line ranges). */
  bodyLineOffset: number;
}

export interface AxonEmbeddingChunk {
  chunkIndex: number;
  chunkCount: number;
  lineStart: number;
  lineEnd: number;
  text: string;
}

// ── Signature parsing ───────────────────────────────────────────────────────

/** Split a parameter list on top-level commas (respects nested brackets/quotes). */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0, quote: string | null = null, cur = '';
  for (const ch of s) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map(p => p.trim()).filter(Boolean);
}

/**
 * Parse `(a, b: null, c: "AHU") => …` from the first non-comment expression of
 * an Axon body. Returns an empty param list (and headerLine 1) when the body is
 * not a lambda (rare: constant defs).
 */
export function parseAxonSignature(
  name: string,
  body: string,
  meta?: { parameters?: Array<{ name: string; required?: boolean; type?: string }>; returnType?: string },
): AxonSignature {
  // A `defcomp` is not a lambda: it has CELLS, not parameters. 23% of this
  // corpus is defcomps, and every one of them used to render as `name()` —
  // its entire interface invisible to both the reader and the embedding.
  const cells = parseDefcompCells(body);
  if (cells.length) {
    const cellParams: AxonParam[] = cells.map(c => ({
      name: c.name,
      // The meta KEY is the useful part: readonly, bind, bindTuning.
      type: /^\{\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(c.meta)?.[1],
      required: false,
    }));
    const rendered = cellParams.map(p => (p.type ? `${p.name}: ${p.type}` : p.name)).join(', ');
    return {
      name,
      params: cellParams,
      returnType: meta?.returnType && /^[A-Za-z][A-Za-z0-9_]*$/.test(meta.returnType) ? meta.returnType : undefined,
      text: `${name}[${rendered}]`,
      headerLine: cells[0].line + 1,
    };
  }

  const lines = body.split(/\r?\n/);
  let params: AxonParam[] = [];
  let headerLine = 1;
  let found = false;
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (inBlock) { if (l.includes('*/')) inBlock = false; continue; }
    if (/^\s*\/\*/.test(l)) { if (!l.includes('*/')) inBlock = true; continue; }
    if (/^\s*\/\//.test(l) || l.trim() === '') continue;
    // Header may span lines: join up to 4 lines until we see `=>`.
    let probe = l;
    let j = i;
    while (!/=>/.test(probe) && j + 1 < lines.length && j - i < 4) { j++; probe += ' ' + lines[j]; }
    const m = /^\s*\(([^]*?)\)\s*=>/.exec(probe);
    if (m) {
      params = splitTopLevel(m[1]).map(p => {
        const dm = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^]*)$/.exec(p);
        if (dm) return { name: dm[1], default: dm[2].trim(), required: false };
        return { name: p.replace(/[^A-Za-z0-9_]/g, ''), required: true };
      }).filter(p => p.name);
      headerLine = i + 1;
      found = true;
    }
    break; // only the first expression can be the lambda header
  }
  if (!found && meta?.parameters?.length) {
    params = meta.parameters.map(p => ({ name: p.name, type: p.type, required: p.required !== false }));
  } else if (meta?.parameters?.length) {
    // Merge known types from metadata onto parsed params (by name).
    const byName = new Map(meta.parameters.map(p => [p.name, p] as const));
    for (const p of params) { const mp = byName.get(p.name); if (mp?.type) p.type = mp.type; }
  }
  const returnType = meta?.returnType && /^[A-Za-z][A-Za-z0-9_]*$/.test(meta.returnType) ? meta.returnType : undefined;
  const rendered = params.map(p => {
    let s = p.name;
    if (p.type) s += `: ${p.type}`;
    if (p.default !== undefined) s += ` = ${p.default}`;
    return s;
  }).join(', ');
  const text = `${name}(${rendered})` + (returnType ? ` => ${returnType}` : '');
  return { name, params, returnType, text, headerLine };
}

// ── Text builder ────────────────────────────────────────────────────────────

const GENERIC_PATH_TOKENS = new Set(['func', 'proj', 'axon', 'trio']);

function pathTokens(relPath: string): string {
  return relPath
    .replace(/\.(axon|trio)$/, '')
    .split(/[\\/]/)
    .flatMap(seg => seg.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_.]+/g, ' ').toLowerCase().split(/\s+/))
    .filter(t => t.length > 1 && !GENERIC_PATH_TOKENS.has(t))
    .join(' ');
}

function nameTokens(qualifiedName: string): string {
  return qualifiedName.replace(/::/g, ' ').replace(/[\/.]/g, ' ');
}

/** Header line: project | instance | file tokens | tags. */
export function axonHeaderLine(r: Pick<AxonEmbeddingInput, 'instance' | 'project' | 'relPath' | 'tags'>): string {
  const parts = [`project: ${r.project}`, `instance: ${r.instance}`];
  const pt = pathTokens(r.relPath);
  if (pt) parts.push(`file: ${pt}`);
  if (r.tags.length) parts.push(`tags: ${r.tags.slice(0, HEADER_TAGS_MAX).join(', ')}`);
  return parts.join(' | ');
}

/** Context line from callees/callers (≤5 names each); '' when both unknown. */
export function axonContextLine(calls: string[], calledBy: string[]): string {
  const parts: string[] = [];
  if (calls.length) parts.push(`calls: ${calls.slice(0, CONTEXT_MAX_NAMES).join(', ')}`);
  if (calledBy.length) parts.push(`called by: ${calledBy.slice(0, CONTEXT_MAX_NAMES).join(', ')}`);
  return parts.length ? `context: ${parts.join('; ')}` : '';
}

/**
 * Body noise control for Axon: trailing whitespace and runs of blank lines.
 *
 * v1 also dropped every comment-only line. That was a mistake worth naming:
 * Fantom's `cleanBodyLines` — the layout this one is aligned with — strips
 * imports and blank runs but never comments, because a comment is the one
 * piece of natural language sitting next to the code. In Axon rule functions
 * it is often the ONLY description of intent ("// compute intersection and
 * filter out periods under threshold"), and a question is far more likely to
 * be phrased in those words than in `hisPeriodIntersection`.
 */
export function cleanAxonBodyLines(lines: string[]): string[] {
  const out: string[] = [];
  let blank = 0;
  for (const raw of lines) {
    const l = raw.replace(/\s+$/, '');
    if (l.trim() === '') { if (++blank > 1) continue; } else blank = 0;
    out.push(l);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  while (out.length && out[0].trim() === '') out.shift();
  return out;
}

/** `cells: target, date, out {readonly}, occ {bind}` for a defcomp; '' otherwise. */
export function axonCellsLine(body: string): string {
  const cells = parseDefcompCells(body);
  if (!cells.length) return '';
  const parts = cells.slice(0, CELLS_MAX).map(c => {
    // The full meta is noise (`{bind:"occupied and sp and siteRef=={{…}}"}`);
    // its KEY is the signal — readonly, bind, bindTuning.
    const key = /^\{\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(c.meta)?.[1];
    return key ? `${c.name} {${key}}` : c.name;
  });
  return `cells: ${parts.join(', ')}`;
}

/** `uses: hisRead, foldCol` — the Axon builtins a body calls; '' when none. */
export function axonUsesLine(uses: string[]): string {
  if (!uses.length) return '';
  return `uses: ${uses.slice(0, USES_MAX).join(', ')}`;
}

/** Build the embedding chunks for one Axon function. Chunk 0 carries the doc. */
export function buildAxonEmbeddingChunks(r: AxonEmbeddingInput): AxonEmbeddingChunk[] {
  const preamble: string[] = [
    'kind: axon-function',
    axonHeaderLine(r),
    nameTokens(r.qualifiedName),
    r.signature.text.replace(/\s+/g, ' ').trim(),
  ];
  const cells = axonCellsLine(r.body);
  if (cells) preamble.push(cells);
  const ctx = axonContextLine(r.calls, r.calledBy);
  if (ctx) preamble.push(ctx);
  const uses = axonUsesLine(r.uses ?? []);
  if (uses) preamble.push(uses);
  const doc = cleanDocumentation(r.doc, AXON_DOC_MAX_CHARS);

  const spanLines = r.body ? r.body.split(/\r?\n/) : [];
  const windows = axonChunkWindows(r.body, spanLines.length);

  return windows.map((w, i) => {
    const parts = [...preamble];
    if (i === 0 && doc) parts.push(`doc: ${doc}`);
    let body = cleanAxonBodyLines(spanLines.slice(w.from, w.to)).join('\n');
    if (body.length > AXON_CHUNK_BODY_MAX_CHARS) body = body.slice(0, AXON_CHUNK_BODY_MAX_CHARS);
    if (body) parts.push(body);
    let text = parts.join('\n');
    if (text.length > AXON_TOTAL_MAX_CHARS) text = text.slice(0, AXON_TOTAL_MAX_CHARS);
    return {
      chunkIndex: i,
      chunkCount: windows.length,
      lineStart: r.bodyLineOffset + w.from,
      lineEnd: spanLines.length ? r.bodyLineOffset + w.to - 1 : r.bodyLineOffset,
      text,
    };
  });
}

/** Single-string entry point: chunk 0. */
export function buildAxonEmbeddingText(r: AxonEmbeddingInput): string {
  return buildAxonEmbeddingChunks(r)[0].text;
}

// ── Chunk windows ───────────────────────────────────────────────────────────

/**
 * Plan the line windows a body is split into.
 *
 * Statement-aligned when `axonSyntax` can make sense of the body, fixed
 * windows when it cannot. Both return raw, 0-based, end-exclusive line ranges
 * over the UNCLEANED body: chunk line numbers are published to LanceDB as
 * `line_start`/`line_end` and used to pull the snippet back out of the real
 * file, so boundaries must be computed on the same lines the file has.
 * Cleaning happens when the text is rendered, never before.
 */
export function axonChunkWindows(body: string, lineCount: number): AxonUnit[] {
  if (lineCount <= CHUNK_LINES) return [{ from: 0, to: lineCount }];

  const units = axonStatementUnits(body);
  if (units && units.length > 1) {
    const packed = packUnits(body, contiguous(units, lineCount));
    if (packed.length) return packed;
  }
  return fixedWindows(lineCount);
}

/**
 * Turn statement ranges into a contiguous partition of the whole body.
 *
 * The AST's statement nodes are not a cover: the `(a, b) => do` header, the
 * closing `end`, and the blank lines between statements belong to no
 * statement at all. Taken literally, those lines would appear in NO chunk —
 * silently unindexed code. So the statements are used for their BOUNDARIES
 * and each range is stretched to meet its neighbour.
 */
function contiguous(units: AxonUnit[], to: number, from = 0): AxonUnit[] {
  const sorted = [...units].sort((a, b) => a.from - b.from);
  const out: AxonUnit[] = [];
  let cursor = from;
  for (const u of sorted) {
    const end = Math.min(Math.max(u.to, cursor + 1), to);
    if (cursor >= to) break;
    out.push({ from: cursor, to: end });
    cursor = end;
  }
  if (out.length === 0) return [{ from, to }];
  if (cursor < to) out[out.length - 1].to = to;
  return out;
}

/** v1 behaviour: overlapping fixed windows. The fallback, and the short path. */
function fixedWindows(lineCount: number): AxonUnit[] {
  const out: AxonUnit[] = [];
  const step = CHUNK_LINES - CHUNK_OVERLAP;
  for (let s = 0; s < lineCount; s += step) {
    const e = Math.min(lineCount, s + CHUNK_LINES);
    out.push({ from: s, to: e });
    if (e >= lineCount) break;
  }
  return out;
}

/**
 * Greedily pack whole statements into windows within the line/char budget.
 *
 * A single statement over budget (a 200-line `do` block) is descended into
 * with the same scanner and packed recursively; if it still will not divide,
 * that one statement falls back to fixed windows so one pathological block
 * cannot drag the whole function onto the v1 path.
 */
function packUnits(body: string, units: AxonUnit[], depth = 0): AxonUnit[] {
  const lines = body.split(/\r?\n/);
  const charsOf = (u: AxonUnit): number =>
    lines.slice(u.from, u.to).reduce((n, l) => n + l.length + 1, 0);

  const out: AxonUnit[] = [];
  let cur: AxonUnit | null = null;
  let curChars = 0;

  const flush = (): void => { if (cur) { out.push(cur); cur = null; curChars = 0; } };

  for (const u of units) {
    const uLines = u.to - u.from;
    const uChars = charsOf(u);

    if (uLines > CHUNK_LINES || uChars > AXON_CHUNK_BODY_MAX_CHARS) {
      flush();
      out.push(...splitOversized(body, u, depth));
      continue;
    }
    if (cur && (cur.to - cur.from + uLines > CHUNK_LINES
                || curChars + uChars > AXON_CHUNK_BODY_MAX_CHARS)) {
      flush();
    }
    if (!cur) { cur = { from: u.from, to: u.to }; curChars = uChars; }
    else { cur.to = u.to; curChars += uChars; }
  }
  flush();
  return out;
}

/** One statement that exceeds the budget: descend, or fall back to windows. */
function splitOversized(body: string, u: AxonUnit, depth: number): AxonUnit[] {
  const lines = body.split(/\r?\n/);
  if (depth < 3) {
    const slice = lines.slice(u.from, u.to).join('\n');
    const inner = axonStatementUnits(slice);
    if (inner && inner.length > 1) {
      // Re-base onto the outer body's numbering, then make the inner ranges a
      // contiguous cover of THIS statement — the nested block's own header and
      // closing line belong to no inner statement either, and skipping that
      // step left 215 functions with a line in no chunk at all.
      const rebased = inner.map(i => ({ from: u.from + i.from, to: u.from + i.to }));
      return packUnits(body, contiguous(rebased, u.to, u.from), depth + 1);
    }
  }
  const out: AxonUnit[] = [];
  const step = CHUNK_LINES - CHUNK_OVERLAP;
  for (let s = u.from; s < u.to; s += step) {
    const e = Math.min(u.to, s + CHUNK_LINES);
    out.push({ from: s, to: e });
    if (e >= u.to) break;
  }
  return out;
}
