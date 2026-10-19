/**
 * Stable symbol keys (docs/proposals/lazy-incremental-indexing.md 3.8, D5;
 * shared with docs/proposals/code-history.md 3.3).
 *
 * One definition, two derived values:
 *   - symbolKey: portable, the same in every clone of the repo. No project id,
 *     no absolute path, no line number.
 *   - nodeIdFor: the store id (graph node id, LanceDB node_id). 16 hex chars,
 *     so every column, index and regex that holds today's 16-char id works.
 *
 * Projects are moved to the new ids one at a time by the `rekey` task
 * (src/indexing/rekeyMigration.ts). Until then a project keeps its legacy
 * ids (`fantom_projects.key_scheme = 1`): the parsers still produce them and
 * applySymbolKeys() is only called for key scheme 2.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { FantomFunction, FantomTypeDef, ParsedFile } from './types.js';

/** fantom_projects.key_scheme after a re-key. 1 = legacy md5(path:qn:line) ids. */
export const KEY_SCHEME_STABLE = 2;

const SEP = '\u001f';

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

/** Portable key: relPath (forward slashes, from the key base) + normalized qn (+ overload parts). */
export function symbolKey(relPath: string, normalizedQn: string, paramSig?: string, ordinal?: number): string {
  return sha1([relPath, normalizedQn, paramSig ?? '', ordinal ?? 0].join(SEP));
}

/** Store id: unique across the fleet. */
export function nodeIdFor(projectId: number, key: string): string {
  return sha1(`${projectId}${SEP}${key}`).slice(0, 16);
}

/**
 * The pre-phase-2 id formula (types.ts generateFunctionId/generateTypeId).
 * Kept for the re-key map only.
 */
export function legacyNodeId(absPath: string, qualifiedName: string, lineNumber?: number): string {
  const key = lineNumber != null ? `${absPath}:${qualifiedName}:${lineNumber}` : `${absPath}:${qualifiedName}`;
  return createHash('md5').update(key).digest('hex').substring(0, 16);
}

/**
 * sha256 of the symbol's source span, whitespace-normalized: every line
 * trimmed, blank lines dropped. Re-indenting or moving the symbol keeps it.
 */
export function bodySha(lines: string[]): string {
  const norm = lines.map(l => l.trim()).filter(l => l.length > 0).join('\n');
  return createHash('sha256').update(norm).digest('hex');
}

/**
 * Key base resolver for one project: the owning git root of a file (the
 * nearest directory holding a `.git` entry, so a nested repo wins over the
 * outer one — longest root), else the project root. Memoized per directory.
 */
export function createKeyBaseResolver(projectRoot: string): (absPath: string) => string {
  const root = path.resolve(projectRoot);
  const memo = new Map<string, string | null>();
  const gitRootOf = (dir: string): string | null => {
    const hit = memo.get(dir);
    if (hit !== undefined) return hit;
    let found: string | null;
    if (fs.existsSync(path.join(dir, '.git'))) {
      found = dir;
    } else {
      const up = path.dirname(dir);
      found = up === dir ? null : gitRootOf(up);
    }
    memo.set(dir, found);
    return found;
  };
  return (absPath: string) => gitRootOf(path.dirname(path.resolve(absPath))) ?? root;
}

/** One-shot form of createKeyBaseResolver. */
export function keyBaseFor(absPath: string, projectRoot: string): string {
  return createKeyBaseResolver(projectRoot)(absPath);
}

/** indexed_files.key_base: '' when the base is the project root, else the absolute git root. */
export function storedKeyBase(base: string, projectRoot: string): string {
  return path.resolve(base) === path.resolve(projectRoot) ? '' : base;
}

/** File path relative to the key base, forward slashes. */
export function relPathFor(absPath: string, base: string): string {
  return path.relative(base, absPath).split(path.sep).join('/');
}

/**
 * Qualified name without anything machine-specific. Parsers without a pod
 * namespace use the absolute file path as namespace (`/abs/x.ts::Foo`); the
 * key already holds relPath, so that prefix goes.
 */
export function normalizeQn(qualifiedName: string, absPath: string): string {
  const prefix = `${absPath}::`;
  return qualifiedName.split(prefix).join('');
}

export interface SymbolIdMapping {
  legacyId: string;
  newId: string;
  symbolKey: string;
  bodySha: string;
  qualifiedName: string;
  filePath: string;
}

type Sym = FantomFunction | FantomTypeDef;

/**
 * Rewrite the ids of one parsed file to stable ids, in place, and set
 * `symbolKey` / `bodySha` on every symbol. Returns legacy → new per symbol.
 *
 * Duplicates (same normalized qn in one file): parameter types decide when
 * the parser gives them and they differ; the position among the remaining
 * same-name siblings (file order) is the last resort. A symbol listed twice
 * (a method in its type and in `functions`) is one symbol: same qn, same line.
 */
export function applySymbolKeys(
  parsed: ParsedFile,
  ctx: { projectId: number; keyBase: string; source?: string },
): SymbolIdMapping[] {
  const abs = parsed.filePath;
  const rel = relPathFor(abs, ctx.keyBase);
  let lines: string[] | null = null;
  const sourceLines = (): string[] => {
    if (lines) return lines;
    let text = ctx.source;
    if (text == null) { try { text = fs.readFileSync(abs, 'utf-8'); } catch { text = ''; } }
    lines = text.split(/\r?\n/);
    return lines;
  };

  // Every distinct symbol, file order (by line, then listing order).
  const all: Sym[] = [];
  for (const t of parsed.types) {
    all.push(t);
    for (const m of t.methods) all.push(m);
    for (const f of t.fields) all.push(f);
  }
  for (const f of parsed.functions) all.push(f);

  const identity = (s: Sym) => `${s.qualifiedName}${SEP}${s.lineNumber ?? ''}${SEP}${'kind' in s ? 't' : 'f'}`;
  const distinct = new Map<string, Sym[]>();
  for (const s of all) {
    const id = identity(s);
    const g = distinct.get(id);
    if (g) g.push(s); else distinct.set(id, [s]);
  }
  const reps = [...distinct.values()].map(g => g[0]);
  const order = new Map(reps.map((s, i) => [s, i]));
  reps.sort((a, b) => ((a.lineNumber ?? 0) - (b.lineNumber ?? 0)) || (order.get(a)! - order.get(b)!));

  const byQn = new Map<string, Sym[]>();
  for (const s of reps) {
    const qn = normalizeQn(s.qualifiedName, abs);
    const g = byQn.get(qn);
    if (g) g.push(s); else byQn.set(qn, [s]);
  }

  const out: SymbolIdMapping[] = [];
  for (const [qn, group] of byQn) {
    const sigOf = (s: Sym): string =>
      'parameters' in s && Array.isArray(s.parameters) ? s.parameters.map(p => p.type || '?').join(',') : '';
    const multi = group.length > 1;
    const seen = new Map<string, number>();
    for (const s of group) {
      const sig = multi ? sigOf(s) : '';
      const n = seen.get(sig) ?? 0;
      seen.set(sig, n + 1);
      const key = symbolKey(rel, qn, sig || undefined, n || undefined);
      const newId = nodeIdFor(ctx.projectId, key);
      const start = Math.max(1, s.lineNumber ?? 1);
      const end = Math.max(start, s.lineEnd ?? start);
      const sha = bodySha(sourceLines().slice(start - 1, end));
      for (const twin of distinct.get(identity(s))!) {
        const legacyId = twin.id;
        twin.id = newId;
        twin.symbolKey = key;
        twin.bodySha = sha;
        if (twin === s) out.push({ legacyId, newId, symbolKey: key, bodySha: sha, qualifiedName: s.qualifiedName, filePath: abs });
      }
    }
  }
  return out;
}
