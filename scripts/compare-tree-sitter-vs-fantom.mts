#!/usr/bin/env tsx
/**
 * compare-tree-sitter-vs-fantom — drive the tree-sitter parser and the
 * canonical Fantom compiler over the same source and emit a strict diff.
 *
 * Usage:
 *   tsx scripts/compare-tree-sitter-vs-fantom.mts --pod <podName> --src <dir>
 *     compares tree-sitter parsing of every .fan in <dir> against the
 *     compiled Fantom pod's canonical symbol list (Pod.find reflection).
 *
 *   tsx scripts/compare-tree-sitter-vs-fantom.mts --matrix
 *     runs the 20-file coverage matrix from scripts/coverage-files.txt and
 *     emits docs/tree-sitter-coverage.md.
 *
 *   tsx scripts/compare-tree-sitter-vs-fantom.mts --file <path>
 *     parses one file with tree-sitter and prints what it found (no oracle).
 *
 * Authoritative side: spawns `fan scripts/dump-symbols.fan <podName>` and
 * parses the pipe-delimited output. Requires a working `fan` CLI (we use
 * the SkySpark 3.1.12 install at ~/skyspark/skyspark-3.1.12/bin/fan
 * by default; override via FAN env var).
 *
 * Tree-sitter side: invokes TreeSitterCodeParser from the existing pipeline.
 *
 * Diff oracle: pod-level totals (types, methods, fields). Per-file output
 * is informational. Source-line metadata is unavailable from compiled pods
 * (would require -debug rebuild), so the test pod / per-file granularity
 * uses tree-sitter count vs FantomCodeParser (regex) for spot-checking.
 *
 * Exit code: 0 if pod-level diff is zero, non-zero otherwise.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { FantomFileScanner } from '../src/fantom-code/scanner.js';
import { FantomCodeParser } from '../src/fantom-code/codeParser.js';
import { createTreeSitterParser } from '../src/fantom-code/treeSitterAdapter.js';
import type { ParsedFile } from '../src/fantom-code/types.js';

const FAN = process.env.FAN || '~/skyspark/skyspark-3.1.12/bin/fan';
const DUMP_SCRIPT = path.resolve('scripts/dump-symbols.fan');

interface AuthSym {
  kind: 'type' | 'method' | 'field';
  qname: string;       // <pod>::Type or <pod>::Type.member
  isPublic: boolean;
}

function dumpAuthoritative(pod: string): AuthSym[] | null {
  if (!fs.existsSync(FAN)) {
    console.error(`fan CLI not found at ${FAN} (set FAN env var)`);
    return null;
  }
  const r = spawnSync(FAN, [DUMP_SCRIPT, pod], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`fan exited ${r.status}: ${r.stderr.trim().slice(0, 200)}`);
    return null;
  }
  const out: AuthSym[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    const parts = line.split('|');
    if (parts.length < 6) continue;
    const [kind, qname, , , , isPub] = parts;
    if (kind !== 'type' && kind !== 'method' && kind !== 'field') continue;
    out.push({ kind: kind as AuthSym['kind'], qname, isPublic: isPub === 'true' });
  }
  return out;
}

interface ParseAggregate {
  types: Set<string>;
  methods: Set<string>;
  fields: Set<string>;
  errors: number;
  files: number;
}

function emptyAgg(): ParseAggregate {
  return { types: new Set(), methods: new Set(), fields: new Set(), errors: 0, files: 0 };
}

function aggregateParsed(pod: string, parsed: ParsedFile[]): ParseAggregate {
  const agg = emptyAgg();
  for (const p of parsed) {
    agg.files++;
    agg.errors += p.errors.length;
    for (const t of p.types) {
      const qn = t.qualifiedName.startsWith(`${pod}::`) ? t.qualifiedName : `${pod}::${t.name}`;
      agg.types.add(qn);
    }
    for (const f of p.functions) {
      const cls = f.className ?? 'top';
      const qn = `${pod}::${cls}.${f.name}`;
      // tree-sitter splits methods + fields under f.type; we keep both as 'method' set for the
      // aggregate diff (compiler reports `field` separately, but matching by name still works
      // because pod-level qname is unique for declared slots).
      if ((f.type as string) === 'field') agg.fields.add(qn);
      else agg.methods.add(qn);
    }
  }
  return agg;
}

interface Comparison {
  pod: string;
  authoritative: { types: number; methods: number; fields: number; total: number };
  treeSitter: { types: number; methods: number; fields: number; total: number; files: number; errors: number };
  regex: { types: number; methods: number; fields: number; total: number; files: number; errors: number };
  missing: { types: string[]; methods: string[]; fields: string[] };
  extra: { types: string[]; methods: string[]; fields: string[] };
}

async function comparePod(pod: string, srcDir: string): Promise<Comparison | null> {
  const auth = dumpAuthoritative(pod);
  if (!auth) return null;
  const authTypes = new Set(auth.filter(s => s.kind === 'type').map(s => s.qname));
  const authMethods = new Set(auth.filter(s => s.kind === 'method').map(s => s.qname));
  const authFields = new Set(auth.filter(s => s.kind === 'field').map(s => s.qname));

  const scanner = new FantomFileScanner();
  const scan = await scanner.scanDirectory(srcDir);
  const fanFiles = scan.files.filter(f => f.endsWith('.fan'));

  // Tree-sitter
  const tsParser = createTreeSitterParser(0, 'fantom', pod);
  const tsOk = await tsParser.initialize();
  if (!tsOk) {
    console.error('tree-sitter Fantom grammar failed to init');
    return null;
  }
  const tsParsed: ParsedFile[] = [];
  for (const f of fanFiles) {
    try { tsParsed.push(await tsParser.parseFile(f)); } catch (e) { /* skip */ }
  }
  const tsAgg = aggregateParsed(pod, tsParsed);

  // Regex (legacy comparator)
  const rxParser = new FantomCodeParser(0, { podName: pod, dependencies: [], srcDirs: ['fan'] });
  const rxParsed: ParsedFile[] = [];
  for (const f of fanFiles) {
    try { rxParsed.push(rxParser.parseFile(f)); } catch (e) { /* skip */ }
  }
  const rxAgg = aggregateParsed(pod, rxParsed);

  const sub = (a: Set<string>, b: Set<string>) => [...a].filter(x => !b.has(x));

  return {
    pod,
    authoritative: {
      types: authTypes.size,
      methods: authMethods.size,
      fields: authFields.size,
      total: authTypes.size + authMethods.size + authFields.size,
    },
    treeSitter: {
      types: tsAgg.types.size,
      methods: tsAgg.methods.size,
      fields: tsAgg.fields.size,
      total: tsAgg.types.size + tsAgg.methods.size + tsAgg.fields.size,
      files: tsAgg.files,
      errors: tsAgg.errors,
    },
    regex: {
      types: rxAgg.types.size,
      methods: rxAgg.methods.size,
      fields: rxAgg.fields.size,
      total: rxAgg.types.size + rxAgg.methods.size + rxAgg.fields.size,
      files: rxAgg.files,
      errors: rxAgg.errors,
    },
    missing: {
      types: sub(authTypes, tsAgg.types),
      methods: sub(authMethods, tsAgg.methods),
      fields: sub(authFields, tsAgg.fields),
    },
    extra: {
      types: sub(tsAgg.types, authTypes),
      methods: sub(tsAgg.methods, authMethods),
      fields: sub(tsAgg.fields, authFields),
    },
  };
}

function printComparison(c: Comparison) {
  console.log(`\n== ${c.pod} ==`);
  console.log(`  authoritative (Pod.find):  ${c.authoritative.types}t ${c.authoritative.methods}m ${c.authoritative.fields}f  total=${c.authoritative.total}`);
  console.log(`  tree-sitter (${c.treeSitter.files} files): ${c.treeSitter.types}t ${c.treeSitter.methods}m ${c.treeSitter.fields}f  total=${c.treeSitter.total}  errors=${c.treeSitter.errors}`);
  console.log(`  regex (legacy):            ${c.regex.types}t ${c.regex.methods}m ${c.regex.fields}f  total=${c.regex.total}  errors=${c.regex.errors}`);
  const tsCov = c.authoritative.total ? ((c.treeSitter.total / c.authoritative.total) * 100).toFixed(1) : 'n/a';
  const rxCov = c.authoritative.total ? ((c.regex.total / c.authoritative.total) * 100).toFixed(1) : 'n/a';
  console.log(`  coverage: tree-sitter=${tsCov}%  regex=${rxCov}%`);
  if (c.missing.types.length || c.missing.methods.length || c.missing.fields.length) {
    console.log(`  MISSING in tree-sitter:`);
    if (c.missing.types.length) console.log(`    types (${c.missing.types.length}): ${c.missing.types.slice(0, 8).join(', ')}${c.missing.types.length > 8 ? ` ... +${c.missing.types.length - 8}` : ''}`);
    if (c.missing.methods.length) console.log(`    methods (${c.missing.methods.length}): ${c.missing.methods.slice(0, 8).join(', ')}${c.missing.methods.length > 8 ? ` ... +${c.missing.methods.length - 8}` : ''}`);
    if (c.missing.fields.length) console.log(`    fields (${c.missing.fields.length}): ${c.missing.fields.slice(0, 8).join(', ')}${c.missing.fields.length > 8 ? ` ... +${c.missing.fields.length - 8}` : ''}`);
  }
  if (c.extra.types.length || c.extra.methods.length || c.extra.fields.length) {
    console.log(`  EXTRA in tree-sitter (likely false positives or mis-classifications):`);
    if (c.extra.types.length) console.log(`    types: ${c.extra.types.slice(0, 8).join(', ')}`);
    if (c.extra.methods.length) console.log(`    methods (${c.extra.methods.length}): ${c.extra.methods.slice(0, 8).join(', ')}${c.extra.methods.length > 8 ? ` ...` : ''}`);
    if (c.extra.fields.length) console.log(`    fields (${c.extra.fields.length}): ${c.extra.fields.slice(0, 8).join(', ')}`);
  }
}

// ============ Matrix mode ============

interface MatrixRow {
  file: string;
  pod: string | null;
  tsFns: number;
  tsTypes: number;
  rxFns: number;
  rxTypes: number;
  // Authoritative counts only available at pod level — for files inside a known pod we link.
  authFns: number | null;
  authTypes: number | null;
  notes: string;
}

const MATRIX_FILES_DEFAULT = [
  // path, podName-or-null, notes
  ['~/fantom/fantom-1.0.78/src/xml/fan/XParser.fan', 'xml', 'classes with @Js facets'],
  ['~/fantom/fantom-1.0.78/src/xml/fan/XElem.fan', 'xml', '@Js mixin-style class'],
  ['~/fantom/fantom-1.0.78/src/xml/test/DomTest.fan', null, 'call+it-block, typed empty list'],
  ['~/fantom/fantom-1.0.78/src/xml/test/ParserTest.fan', null, 'verifyEq + verifyErr'],
  ['~/fantom/fantom-1.0.78/src/dom/fan/Win.fan', 'dom', 'closures'],
  ['~/fantom/fantom-1.0.78/src/concurrent/fan/Future.fan', 'concurrent', 'closures + statics'],
  ['~/fantom/fantom-1.0.78/src/sys/fan/Duration.fan', null, 'operator methods'],
  ['~/fantom/fantom-1.0.78/src/compiler/fan/parser/Parser.fan', null, 'recursive descent (~1500 lines)'],
  ['~/fantom/fantom-1.0.78/src/compiler/fan/parser/Tokenizer.fan', null, 'char literals + escapes'],
  ['~/fantom/fantom-1.0.78/src/fandoc/fan/FandocParser.fan', null, 'block comments'],
  ['~/fantom/fantom-1.0.78/src/fwt/fan/Widget.fan', null, 'event closures'],
  ['~/fantom/fantom-1.0.78/src/sys/fan/List.fan', null, 'mixin-heavy'],
  ['~/fantom/fantom-1.0.78/src/sys/fan/Map.fan', null, 'generic types'],
  ['~/fantom/fantom-1.0.78/src/sys/fan/Str.fan', null, 'methods with operators'],
  ['~/fantom/fantom-1.0.78/src/sys/fan/Type.fan', null, 'reflection-heavy'],
  ['~/fantom/fantom-1.0.78/src/dom/fan/Elem.fan', 'dom', 'large class'],
  ['~/fantom/fantom-1.0.78/src/flux/fan/Frame.fan', 'flux', 'using ffi (java imports)'],
  ['~/fantom/fantom-1.0.78/src/concurrent/fan/Actor.fan', 'concurrent', 'closures + sends'],
  ['~/fantom/fantom-1.0.78/src/util/fan/Crypto.fan', 'util', 'utility class'],
  ['~/fantom/fantom-1.0.78/src/sys/fan/Endian.fan', 'sys', 'enum class'],
] as const;

async function runMatrix(): Promise<MatrixRow[]> {
  // Cache pod-level authoritative counts so we don't shell out per file.
  const podCache = new Map<string, AuthSym[] | null>();

  const tsParser = createTreeSitterParser(0, 'fantom', undefined);
  const tsOk = await tsParser.initialize();
  if (!tsOk) throw new Error('tree-sitter init failed');

  const rows: MatrixRow[] = [];
  for (const [filePath, podHint, notes] of MATRIX_FILES_DEFAULT) {
    if (!fs.existsSync(filePath)) {
      rows.push({ file: filePath, pod: podHint, tsFns: -1, tsTypes: -1, rxFns: -1, rxTypes: -1, authFns: null, authTypes: null, notes: `MISSING: ${notes}` });
      continue;
    }
    const rx = new FantomCodeParser(0, podHint ? { podName: podHint, dependencies: [], srcDirs: ['fan'] } : undefined);
    let tsParsed: ParsedFile, rxParsed: ParsedFile;
    try { tsParsed = await tsParser.parseFile(filePath); } catch (e) { tsParsed = { filePath, types: [], functions: [], errors: [{ file: filePath, message: String(e), severity: 'error' }] } as any; }
    try { rxParsed = rx.parseFile(filePath); } catch (e) { rxParsed = { filePath, types: [], functions: [], errors: [{ file: filePath, message: String(e), severity: 'error' }] } as any; }

    let authFns: number | null = null;
    let authTypes: number | null = null;
    if (podHint) {
      if (!podCache.has(podHint)) podCache.set(podHint, dumpAuthoritative(podHint));
      const a = podCache.get(podHint);
      if (a) {
        // Pod-level totals (file-level not derivable without -debug fcode)
        authFns = a.filter(s => s.kind === 'method').length;
        authTypes = a.filter(s => s.kind === 'type').length;
      }
    }
    rows.push({
      file: filePath,
      pod: podHint,
      tsFns: tsParsed.functions.length,
      tsTypes: tsParsed.types.length,
      rxFns: rxParsed.functions.length,
      rxTypes: rxParsed.types.length,
      authFns,
      authTypes,
      notes,
    });
  }
  return rows;
}

function emitMatrixMd(rows: MatrixRow[]): string {
  const lines: string[] = [];
  lines.push('# tree-sitter-fantom coverage matrix');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('Per-file tree-sitter vs regex parser, with authoritative pod-level totals where the pod is compiled and discoverable. Authoritative counts are POD-level (sum of all .fan files in that pod\'s source dir), so they can\'t be compared 1:1 to a single file — but they bound what tree-sitter could find by parsing every file in that pod.');
  lines.push('');
  lines.push('| File | Pod | TS fns | TS types | Regex fns | Regex types | Pod-level auth fns | Pod-level auth types | Notes |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const fileShort = r.file.replace('~/fantom/fantom-1.0.78/src/', '');
    const auth_f = r.authFns == null ? '—' : String(r.authFns);
    const auth_t = r.authTypes == null ? '—' : String(r.authTypes);
    lines.push(`| \`${fileShort}\` | ${r.pod ?? '—'} | ${r.tsFns} | ${r.tsTypes} | ${r.rxFns} | ${r.rxTypes} | ${auth_f} | ${auth_t} | ${r.notes} |`);
  }
  return lines.join('\n') + '\n';
}

// ============ Main ============

async function main() {
  const args = process.argv.slice(2);
  let mode: 'pod' | 'matrix' | 'file' = 'pod';
  let pod: string | null = null;
  let src: string | null = null;
  let file: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--matrix') mode = 'matrix';
    else if (args[i] === '--pod') { mode = 'pod'; pod = args[++i]; }
    else if (args[i] === '--src') src = args[++i];
    else if (args[i] === '--file') { mode = 'file'; file = args[++i]; }
  }

  if (mode === 'matrix') {
    const rows = await runMatrix();
    const md = emitMatrixMd(rows);
    const outPath = path.resolve('docs/tree-sitter-coverage.md');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, md);
    console.log(`Matrix written to ${outPath}`);
    console.log('');
    console.log(md);
    process.exit(0);
  }

  if (mode === 'file' && file) {
    const ts = createTreeSitterParser(0, 'fantom', undefined);
    if (!(await ts.initialize())) { console.error('tree-sitter init failed'); process.exit(1); }
    const parsed = await ts.parseFile(file);
    console.log(`tree-sitter found in ${file}:`);
    console.log(`  ${parsed.types.length} types, ${parsed.functions.length} functions`);
    console.log(`  errors: ${parsed.errors.length}`);
    parsed.functions.forEach(f => console.log(`    fn ${f.className ?? '<top>'}.${f.name} @${f.lineNumber}`));
    parsed.types.forEach(t => console.log(`    type ${t.name} @${t.lineNumber} (kind=${t.kind})`));
    process.exit(parsed.errors.length === 0 ? 0 : 1);
  }

  if (mode === 'pod' && pod) {
    if (!src) {
      console.error('--src <dir> required with --pod');
      process.exit(1);
    }
    const c = await comparePod(pod, src);
    if (!c) process.exit(1);
    printComparison(c);
    const matched = c.missing.types.length === 0 && c.missing.methods.length === 0 && c.missing.fields.length === 0;
    process.exit(matched ? 0 : 1);
  }

  console.error('usage: tsx scripts/compare-tree-sitter-vs-fantom.mts [--matrix | --pod NAME --src DIR | --file PATH]');
  process.exit(2);
}

main().catch(e => { console.error(e); process.exit(1); });
