#!/usr/bin/env node
// Measure a tree-sitter wasm grammar against a corpus of files.
//
//   node scripts/axon-grammar-corpus.mjs [--wasm <path>] [--top N] [--all] <part>=<list-or-root> ...
//
// Each positional argument is `<part name>=<path>`. The path is either a text file with one
// file path per line, or a directory root (every .axon under it is used).
// Prints, per part: files, clean files (no ERROR and no MISSING), files with ERROR, files with
// MISSING; then the worst files overall with their first 3 error locations.
// `--all` lists every non-clean file (one line each) instead of only the top N.
// Same approach as scripts/fantom-grammar-corpus.mjs, defaulting to the Axon wasm.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

const args = process.argv.slice(2);
let wasmPath = path.join(repo, 'tree-sitter-axon', 'tree-sitter-axon.wasm');
let top = 30;
let listAll = false;
const parts = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--wasm') wasmPath = path.resolve(args[++i]);
  else if (a === '--top') top = Number(args[++i]);
  else if (a === '--all') listAll = true;
  else {
    const eq = a.indexOf('=');
    if (eq < 0) { console.error(`bad argument ${a}; expected part=path`); process.exit(2); }
    parts.push({ name: a.slice(0, eq), source: path.resolve(a.slice(eq + 1)) });
  }
}
if (parts.length === 0) {
  console.error('usage: axon-grammar-corpus.mjs [--wasm p] [--top N] [--all] part=listfile|root ...');
  process.exit(2);
}

const SKIP = new Set(['node_modules', '.git', 'build', 'out']);
function walk(dir, acc) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p, acc); }
    else if (e.isFile() && e.name.endsWith('.axon')) acc.push(p);
  }
  return acc;
}

function filesFor(source) {
  const st = fs.statSync(source);
  if (st.isDirectory()) return walk(source, []).sort();
  return fs.readFileSync(source, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
}

const TS = require(path.join(repo, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.cjs'));
await TS.Parser.init();
const lang = await TS.Language.load(wasmPath);
const parser = new TS.Parser();
parser.setLanguage(lang);

function measure(file) {
  const src = fs.readFileSync(file, 'utf8');
  const tree = parser.parse(src);
  let errors = 0;
  let missing = 0;
  const first = [];
  const lines = src.split('\n');
  const stack = [tree.rootNode];
  while (stack.length) {
    const n = stack.pop();
    const isErr = n.type === 'ERROR';
    if (isErr) errors++;
    if (n.isMissing) missing++;
    if ((isErr || n.isMissing) && first.length < 3) {
      const { row, column } = n.startPosition;
      const excerpt = (lines[row] ?? '').slice(column, column + 60).replace(/\t/g, ' ');
      first.push({ row: row + 1, column: column + 1, kind: n.isMissing ? `MISSING ${n.type}` : 'ERROR', excerpt });
    }
    for (let i = n.childCount - 1; i >= 0; i--) stack.push(n.child(i));
  }
  tree.delete();
  return { file, errors, missing, first };
}

const worst = [];
const summary = [];
for (const part of parts) {
  const files = filesFor(part.source);
  let clean = 0;
  let withError = 0;
  let withMissing = 0;
  for (const f of files) {
    let r;
    try { r = measure(f); } catch (e) { r = { file: f, errors: 1, missing: 0, first: [{ row: 0, column: 0, kind: 'READ', excerpt: String(e.message) }] }; }
    if (r.errors === 0 && r.missing === 0) clean++;
    else {
      if (r.errors > 0) withError++;
      if (r.missing > 0) withMissing++;
      worst.push({ part: part.name, ...r });
    }
  }
  summary.push({ part: part.name, files: files.length, clean, withError, withMissing });
}

const pct = (a, b) => (b === 0 ? '-' : `${((100 * a) / b).toFixed(1)}%`);
console.log(`wasm: ${wasmPath}`);
console.log('part'.padEnd(20) + 'files'.padStart(7) + 'clean'.padStart(7) + 'clean%'.padStart(8) + 'ERROR'.padStart(7) + 'MISSING'.padStart(9));
for (const s of summary) {
  console.log(s.part.padEnd(20) + String(s.files).padStart(7) + String(s.clean).padStart(7) + pct(s.clean, s.files).padStart(8)
    + String(s.withError).padStart(7) + String(s.withMissing).padStart(9));
}

worst.sort((a, b) => (b.errors + b.missing) - (a.errors + a.missing) || a.file.localeCompare(b.file));
const shown = listAll ? worst : worst.slice(0, top);
if (shown.length) console.log(`\n${listAll ? 'all' : `top ${shown.length}`} non-clean files (${worst.length} total):`);
for (const w of shown) {
  const rel = w.file.replace(process.env.HOME ?? '', '~');
  console.log(`${String(w.errors).padStart(4)} err ${String(w.missing).padStart(3)} miss  ${rel}  [${w.part}]`);
  if (!listAll) for (const f of w.first) console.log(`      ${f.row}:${f.column} ${f.kind}: ${f.excerpt}`);
}
