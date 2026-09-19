/**
 * Trio record reader backed by the vendored `tree-sitter-trio` grammar.
 *
 * Replaces the hand-written line loop that `TrioParser` used to split records:
 * the grammar gives exact line numbers per record and per tag, recognises
 * `Zinc:` / `Trio:` / `[` / `{` blocks, comments, and separators the same way
 * haxall's TrioReader.fan does, and reports ERROR nodes instead of silently
 * mis-splitting.
 *
 * The parser is a process-wide singleton, loaded once (like the Axon grammar
 * in `src/axon/axonTreeSitter.ts`). `parseTrio` is synchronous after
 * `initTrioGrammar` has resolved. Trees live in wasm memory and are deleted
 * after extraction.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Node as TsNode, Parser as TsParser } from 'web-tree-sitter';
import { getInstallRoot } from '../../utils/installRoot.js';
import { createLogger } from '../../utils/index.js';

const logger = createLogger('trio-grammar');

/** Marker tag (a name with no value, e.g. `func`). */
export const TRIO_MARKER: unique symbol = Symbol('trio-marker');

export type TrioValue = string | boolean | typeof TRIO_MARKER | TrioRecord | null;

export interface TrioRecord {
  [key: string]: TrioValue;
}

/** How a tag's value was written in the file. */
export type TrioTagKind = 'marker' | 'scalar' | 'text' | 'zinc' | 'trio' | 'list' | 'dict';

export interface ParsedTrioRecord {
  /** Tag name to value, same shape TrioParser has always consumed. */
  tags: TrioRecord;
  /** 1-based line of the record's first tag. */
  line: number;
  /** 1-based line of the record's last line. */
  endLine: number;
  /** 1-based line of each tag's `name` token. */
  tagLines: Record<string, number>;
  /** How each tag's value was written. */
  tagKinds: Record<string, TrioTagKind>;
}

export interface TrioParseIssue {
  line: number;
  message: string;
}

export interface TrioParseResult {
  records: ParsedTrioRecord[];
  issues: TrioParseIssue[];
}

let parser: TsParser | null = null;
let loadError: string | null = null;
let loadingPromise: Promise<boolean> | null = null;
let loadedFrom: string | null = null;

/**
 * Candidate grammar locations, in order. The copy vendored next to the other
 * indexer grammars wins; the grammar's own build output is the dev fallback.
 */
function grammarCandidates(): string[] {
  const root = getInstallRoot();
  return [
    path.join(root, 'src', 'parser', 'treeSitter', 'grammars', 'tree-sitter-trio.wasm'),
    path.join(root, 'build', 'parser', 'treeSitter', 'grammars', 'tree-sitter-trio.wasm'),
    path.join(root, 'tree-sitter-trio', 'tree-sitter-trio.wasm'),
  ];
}

/** Load the grammar once. Safe to call repeatedly and concurrently. */
export function initTrioGrammar(): Promise<boolean> {
  if (parser) return Promise.resolve(true);
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    const wasm = grammarCandidates().find(p => fs.existsSync(p));
    if (!wasm) {
      loadError = `tree-sitter-trio.wasm not found (looked in ${grammarCandidates().join(', ')})`;
      logger.warn(`Trio grammar unavailable — ${loadError}`);
      return false;
    }
    try {
      const { Parser, Language } = await import('web-tree-sitter');
      await Parser.init();
      const lang = await Language.load(wasm);
      const p = new Parser();
      p.setLanguage(lang);
      parser = p as unknown as TsParser;
      loadedFrom = wasm;
      loadError = null;
      logger.info(`Loaded Trio tree-sitter grammar from ${wasm}`);
      return true;
    } catch (e) {
      loadError = (e as Error).message;
      logger.error(`Failed to load the Trio grammar: ${loadError}`);
      return false;
    } finally {
      loadingPromise = null;
    }
  })();
  return loadingPromise;
}

export function trioGrammarReady(): boolean { return parser !== null; }

export function trioGrammarStatus(): { ready: boolean; loadedFrom: string | null; error: string | null } {
  return { ready: parser !== null, loadedFrom, error: loadError };
}

/** Test hook: drop the loaded grammar. */
export function resetTrioGrammar(): void { parser = null; loadedFrom = null; loadError = null; }

/**
 * Parse Trio text into records. Returns null when the grammar is not loaded;
 * call `initTrioGrammar` first.
 */
export function parseTrio(text: string): TrioParseResult | null {
  if (!parser) return null;
  // A scalar tag must be newline-terminated in the grammar; files written by
  // hand or by single-record exports often lack the final newline.
  if (text.length > 0 && !text.endsWith('\n')) text += '\n';
  const tree = parser.parse(text);
  if (!tree) return null;
  try {
    const records: ParsedTrioRecord[] = [];
    for (const rec of tree.rootNode.namedChildren) {
      if (!rec || rec.type !== 'record') continue;
      const parsed = readRecord(rec);
      if (parsed) records.push(parsed);
    }
    const issues: TrioParseIssue[] = [];
    if (tree.rootNode.hasError) collectIssues(tree.rootNode, issues);
    return { records, issues };
  } finally {
    tree.delete();
  }
}

function readRecord(rec: TsNode): ParsedTrioRecord | null {
  const tags: TrioRecord = {};
  const tagLines: Record<string, number> = {};
  const tagKinds: Record<string, TrioTagKind> = {};
  let first: number | null = null;

  for (const child of rec.namedChildren) {
    if (!child) continue;
    if (child.type !== 'tag' && child.type !== 'block_tag') continue;
    const nameNode = child.childForFieldName('name');
    if (!nameNode) continue;
    const name = nameNode.text;
    const line = child.startPosition.row + 1;
    if (first === null) first = line;

    let value: TrioValue;
    let kind: TrioTagKind;
    if (child.type === 'tag') {
      const valueNode = child.childForFieldName('value');
      if (!valueNode) {
        value = TRIO_MARKER;
        kind = 'marker';
      } else {
        value = scalarValue(valueNode);
        kind = 'scalar';
      }
    } else {
      const kindNode = child.childForFieldName('kind');
      const textNode = child.childForFieldName('value');
      const body = textNode ? dedentBlock(textNode.text) : '';
      switch (kindNode?.type) {
        case 'trio_block': {
          kind = 'trio';
          value = nestedRecord(body);
          break;
        }
        case 'zinc_block': kind = 'zinc'; value = body; break;
        case 'list_block': kind = 'list'; value = `[\n${body}`; break;
        case 'dict_block': kind = 'dict'; value = `{\n${body}`; break;
        default: kind = 'text'; value = body; break;
      }
    }

    tags[name] = value;
    tagLines[name] = line;
    tagKinds[name] = kind;
  }

  if (first === null) return null;
  return {
    tags,
    line: first,
    // The indented_text token swallows its trailing newline, so the end row can
    // land on the line after the record. Clamp to the last line with content.
    endLine: Math.max(first, rec.endPosition.row + (rec.endPosition.column === 0 ? 0 : 1)),
    tagLines,
    tagKinds,
  };
}

function scalarValue(node: TsNode): TrioValue {
  // Belt and braces for CRLF files: no scalar may keep a trailing CR/space.
  const text = node.text.replace(/[\s\r]+$/, '');
  switch (node.type) {
    case 'bool':
      return text === 'true' || text === 'T';
    case 'str':
    case 'uri':
      // Strip the delimiters only; escapes are kept verbatim, as before.
      return text.length >= 2 ? text.substring(1, text.length - 1) : text;
    default:
      return text;
  }
}

/** Parse a `Trio:` block body as a nested record (first record only, like TrioReader). */
function nestedRecord(body: string): TrioRecord | null {
  if (!parser || body.trim().length === 0) return null;
  const nested = parseTrio(body);
  if (!nested || nested.records.length === 0) return null;
  return nested.records[0].tags;
}

/**
 * Strip the common indent from an `indented_text` token. The token starts with
 * the newline that follows `name:`; every later line is blank, indented, or a
 * single character. Mirrors the old TrioReader port: minimum indent over
 * non-blank lines, trailing whitespace removed, trailing blank lines dropped.
 */
export function dedentBlock(token: string): string {
  const lines = token.replace(/\r/g, '').split('\n');
  if (lines.length > 0 && lines[0] === '') lines.shift();
  let minIndent = Infinity;
  for (const l of lines) {
    if (l.trim().length === 0) continue;
    const indent = l.length - l.trimStart().length;
    if (indent < minIndent) minIndent = indent;
  }
  if (minIndent === Infinity) minIndent = 0;
  const out = lines.map(l => (l.length <= minIndent ? '' : l.substring(minIndent)).trimEnd());
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

function collectIssues(node: TsNode, out: TrioParseIssue[]): void {
  if (node.type === 'ERROR' || node.isMissing) {
    out.push({
      line: node.startPosition.row + 1,
      message: node.isMissing ? `missing ${node.type}` : `unexpected text: ${node.text.split('\n')[0].substring(0, 80)}`,
    });
    return;
  }
  if (!node.hasError) return;
  for (const c of node.children) {
    if (c) collectIssues(c, out);
  }
}
