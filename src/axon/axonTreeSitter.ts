/**
 * Axon parsing through the real tree-sitter grammar.
 *
 * The Axon MCP server ships `tree-sitter-axon.wasm` and parses with it; this
 * vendors a copy so Fantom's indexing does not depend on that checkout being
 * present, and so which grammar parsed the corpus is a property of this repo
 * rather than of the machine. Measured over the 6,886-body corpus: 99.04% parse
 * clean, 0.35 ms per function.
 *
 * (The alternative, the Axon server's `parseAxonAst` MCP tool, delegates to a
 * live SkySpark `parseAst` that answers "may not be available on this SkySpark
 * version" — and the offline library must index with no instance at all.)
 *
 * ── Sync use, async load ───────────────────────────────────────────────────
 *
 * `Parser.parse()` is synchronous once `Language.load()` has resolved, so the
 * grammar is loaded ONCE (`initAxonGrammar`) and every parse after that is a
 * plain synchronous call. That matters because the embedding-text builder and
 * the preview routes are sync, and making them async would be viral.
 *
 * Callers that WRITE rows must gate on `axonGrammarReady()` and refuse rather
 * than silently fall back: chunks built without the grammar are line windows
 * but would still be tagged `embed_text_version: 2`, which no staleness check
 * could later tell apart from real v2 rows.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getInstallRoot } from '../utils/installRoot.js';
import { getAxonSettings } from './axonSettings.js';
import { createLogger } from '../utils/index.js';

const logger = createLogger('axon-treesitter');

/** Node types, as named by the grammar (see the Axon server's axonMappings). */
const COMMENT_TYPES = new Set(['line_comment', 'block_comment']);
// `trap_call` is Axon's `->` tag access (`target->costPerHour`), NOT a
// function call. The Axon server's own mapping groups it with the call types,
// but here it would put every tag name into the call graph — `costPerHour`
// was landing in `uses` as if it were a function.
const CALL_TYPES = new Set(['call_expr', 'dot_call']);
const BLOCK_TYPES = new Set(['do_block', 'defcomp_body']);
const CELL_TYPES = new Set(['cell_def', 'defcomp_cell']);

// Minimal structural types — `web-tree-sitter`'s own are not re-exported here
// so this module stays importable from sync code without pulling the runtime.
interface TsNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  namedChildCount: number;
  namedChild(i: number): TsNode | null;
  childForFieldName(f: string): TsNode | null;
  hasError: boolean;
}
interface TsTree { rootNode: TsNode; delete(): void }
interface TsParser { parse(src: string): TsTree | null }

let parser: TsParser | null = null;
let loadError: string | null = null;
let loadingPromise: Promise<boolean> | null = null;

/** Where the grammar was loaded from, for the status endpoint. */
let loadedFrom: string | null = null;

/**
 * Candidate grammar locations, in order.
 *
 * The vendored copy wins: the parse must not change depending on whether an
 * external checkout happens to be on this machine. The Axon server's copy is
 * only a fallback for a dev tree that has not vendored one.
 */
function grammarCandidates(): string[] {
  const out = [path.join(getInstallRoot(), 'assets', 'grammars', 'tree-sitter-axon.wasm')];
  try {
    const s = getAxonSettings();
    if (s.projectPath) {
      out.push(path.join(s.projectPath, 'src', 'parser', 'treeSitter', 'grammars', 'tree-sitter-axon.wasm'));
    }
  } catch { /* settings unreadable: the vendored copy is the answer */ }
  return out;
}

/** Load the grammar once. Safe to call repeatedly and concurrently. */
export function initAxonGrammar(): Promise<boolean> {
  if (parser) return Promise.resolve(true);
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    const wasm = grammarCandidates().find(p => fs.existsSync(p));
    if (!wasm) {
      loadError = `tree-sitter-axon.wasm not found (looked in ${grammarCandidates().join(', ')})`;
      logger.warn(`Axon grammar unavailable — ${loadError}`);
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
      logger.info(`Loaded Axon tree-sitter grammar from ${wasm}`);
      return true;
    } catch (e) {
      loadError = (e as Error).message;
      logger.error(`Failed to load the Axon grammar: ${loadError}`);
      return false;
    } finally {
      loadingPromise = null;
    }
  })();
  return loadingPromise;
}

export function axonGrammarReady(): boolean { return parser !== null; }

export function axonGrammarStatus(): { ready: boolean; loadedFrom: string | null; error: string | null } {
  return { ready: parser !== null, loadedFrom, error: loadError };
}

/** Test hook: drop the loaded grammar. */
export function resetAxonGrammar(): void { parser = null; loadedFrom = null; loadError = null; }

/**
 * Parse a body and hand the tree to `fn`, always freeing it afterwards.
 *
 * The tree lives in wasm memory and is not garbage collected — 4,779 of them
 * per index run would be a leak in a process that already runs under a memory
 * guard. Returns `fallback` when the grammar is unavailable or the parse has
 * errors (66 of 6,886 bodies), so every caller degrades the same way.
 */
function withTree<T>(src: string, fn: (root: TsNode) => T, fallback: T): T {
  if (!parser || !src.trim()) return fallback;
  let tree: TsTree | null = null;
  try {
    tree = parser.parse(src);
    if (!tree || tree.rootNode.hasError) return fallback;
    return fn(tree.rootNode);
  } catch (e) {
    logger.warn(`Axon parse threw: ${(e as Error).message}`);
    return fallback;
  } finally {
    try { tree?.delete(); } catch { /* already freed */ }
  }
}

// ── Statement units ─────────────────────────────────────────────────────────

/** A run of raw source lines that is syntactically whole. `to` is exclusive. */
export interface AxonUnit {
  from: number;
  to: number;
}

/**
 * The statements of a function body, as line ranges.
 *
 * A body is a `lambda` or a `defcomp` wrapping a `do_block`, and it is that
 * block's children that are the real statements. For a `defcomp` the cell
 * declarations are statements too — they are the component's interface.
 *
 * Returns null when the grammar is unavailable or the body did not parse; the
 * caller must then fall back to fixed line windows rather than guess.
 */
export function axonStatementUnits(src: string): AxonUnit[] | null {
  return withTree<AxonUnit[] | null>(src, root => {
    const stmts = statementNodesOf(root);
    if (stmts.length < 2) return null;
    return glueComments(stmts);
  }, null);
}

/** Descend through wrappers to the node whose children are the statements. */
function statementNodesOf(root: TsNode): TsNode[] {
  let host: TsNode = root;
  // Unwrap: source_file → lambda/defcomp → do_block. Each level is a single
  // structural node; the moment a level has several children worth splitting,
  // those are the statements.
  for (let guard = 0; guard < 6; guard++) {
    const named = childrenOf(host);
    const meaty = named.filter(n => !COMMENT_TYPES.has(n.type));
    if (meaty.length !== 1) break;
    const only = meaty[0];
    // Descend into a block, or into the body of a lambda/defcomp.
    const body = only.childForFieldName('body');
    const next = BLOCK_TYPES.has(only.type) ? only
      : (body && BLOCK_TYPES.has(body.type)) ? body
      : (only.type === 'lambda' || only.type === 'defcomp') ? (blockChildOf(only) ?? only)
      : null;
    if (!next || next === host) break;
    host = next;
  }
  // A defcomp's cells sit beside its do_block; keep both, in source order.
  const out = childrenOf(host);
  if (out.length === 1 && BLOCK_TYPES.has(out[0].type)) return childrenOf(out[0]);
  return out;
}

function childrenOf(n: TsNode): TsNode[] {
  const out: TsNode[] = [];
  for (let i = 0; i < n.namedChildCount; i++) {
    const c = n.namedChild(i);
    if (c) out.push(c);
  }
  return out;
}

function blockChildOf(n: TsNode): TsNode | null {
  for (const c of childrenOf(n)) if (BLOCK_TYPES.has(c.type)) return c;
  return null;
}

/**
 * Absorb a comment into the statement it introduces.
 *
 * `line_comment` is a SIBLING of the statement it describes, not a child, so a
 * greedy packer would happily end a chunk on
 * `// get periods when lights are on` and open the next one with the statement
 * that comment is about — undoing the whole point of keeping comments.
 */
function glueComments(nodes: TsNode[]): AxonUnit[] {
  const out: AxonUnit[] = [];
  let pendingFrom: number | null = null;
  for (const n of nodes) {
    const from = n.startPosition.row;
    const to = n.endPosition.row + 1;
    if (COMMENT_TYPES.has(n.type)) {
      if (pendingFrom === null) pendingFrom = from;
      continue;
    }
    out.push({ from: pendingFrom ?? from, to });
    pendingFrom = null;
  }
  // Trailing comments with no statement after them are a unit of their own.
  if (pendingFrom !== null && nodes.length) {
    out.push({ from: pendingFrom, to: nodes[nodes.length - 1].endPosition.row + 1 });
  }
  return out;
}

// ── defcomp cells ───────────────────────────────────────────────────────────

/** One `defcomp` cell declaration: `occ: {bind:"…"}`. */
export interface AxonCell {
  name: string;
  /** The brace body as written, collapsed (may be empty). */
  meta: string;
  /** 0-based line the declaration starts on. */
  line: number;
}

/**
 * The cells of a `defcomp` — its real interface.
 *
 * A defcomp is not a lambda, so signature parsing finds no parameters and 23%
 * of this corpus (1,548 bodies, 8,696 cells) rendered as `name()` with its
 * whole interface invisible to reader and embedding alike.
 */
export function parseDefcompCells(src: string): AxonCell[] {
  return withTree<AxonCell[]>(src, root => {
    const out: AxonCell[] = [];
    const visit = (n: TsNode, depth: number): void => {
      if (depth > 4) return;
      for (const c of childrenOf(n)) {
        if (CELL_TYPES.has(c.type)) {
          const kids = childrenOf(c);
          const name = kids.find(k => k.type === 'identifier')?.text
            ?? c.childForFieldName('name')?.text;
          const meta = kids.find(k => k.type === 'dict')?.text ?? '';
          if (name) out.push({ name, meta: meta.replace(/\s+/g, ' ').trim(), line: c.startPosition.row });
        } else if (c.type === 'defcomp' || c.type === 'defcomp_body') {
          visit(c, depth + 1);
        }
      }
    };
    visit(root, 0);
    return out;
  }, []);
}

// ── Call extraction ─────────────────────────────────────────────────────────

/**
 * Every name used in call position, in source order, de-duplicated.
 *
 * This is the only call context the offline library can have: those projects
 * ship no `.sync-metadata.json`, so `calls` was hard-coded to `[]` for all
 * 2,034 of their functions. The result mixes project functions with Axon
 * builtins (`hisRead`, `foldCol`); `resolveCallEdges` decides which is which.
 */
export function extractAxonCallNames(src: string): string[] {
  return withTree<string[]>(src, root => {
    const seen = new Set<string>();
    const out: string[] = [];
    const visit = (n: TsNode, depth: number): void => {
      if (depth > 60) return;
      if (CALL_TYPES.has(n.type)) {
        const name = calleeName(n);
        if (name && !seen.has(name)) { seen.add(name); out.push(name); }
      }
      for (const c of childrenOf(n)) visit(c, depth + 1);
    };
    visit(root, 0);
    return out;
  }, []);
}

/** The called name: the `name`/`target` field, else the first identifier. */
function calleeName(call: TsNode): string | null {
  const field = call.childForFieldName('name') ?? call.childForFieldName('function');
  const pick = (t: string): string | null => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t) ? t : null);
  if (field) {
    const direct = pick(field.text);
    if (direct) return direct;
    // `a.b.foo()` — the call's own name is the last identifier of the target.
    const ids = childrenOf(field).filter(c => c.type === 'identifier');
    if (ids.length) return pick(ids[ids.length - 1].text);
  }
  for (const c of childrenOf(call)) {
    if (c.type === 'identifier') return pick(c.text);
  }
  return null;
}
