#!/usr/bin/env node
// Measure tree-sitter-trio against a corpus of real .trio files (see CORPUS.md).
//   node tree-sitter-trio/scripts/corpus.mjs <wasm> <listfile> [--top N] [--all]
// Prints files / clean / with ERROR / with MISSING, then the worst files with their first 3 error positions.
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(repo, 'package.json'));
const [wasmPath, listFile, ...rest] = process.argv.slice(2);
let top = 30, all = false;
for (let i = 0; i < rest.length; i++) { if (rest[i] === '--top') top = Number(rest[++i]); else if (rest[i] === '--all') all = true; }
const files = fs.readFileSync(listFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
const TS = require(path.join(repo, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.cjs'));
await TS.Parser.init();
const lang = await TS.Language.load(path.resolve(wasmPath));
const parser = new TS.Parser(); parser.setLanguage(lang);
function measure(file) {
  const src = fs.readFileSync(file, 'utf8');
  const tree = parser.parse(src);
  let errors = 0, missing = 0; const first = []; const lines = src.split('\n');
  const stack = [tree.rootNode];
  while (stack.length) {
    const n = stack.pop(); const isErr = n.type === 'ERROR';
    if (isErr) errors++; if (n.isMissing) missing++;
    if ((isErr || n.isMissing) && first.length < 3) {
      const { row, column } = n.startPosition;
      first.push({ row: row + 1, column: column + 1, kind: n.isMissing ? `MISSING ${n.type}` : 'ERROR', excerpt: (lines[row] ?? '').slice(column, column + 70).replace(/\t/g, ' ').replace(/\r/g,'\\r') });
    }
    for (let i = n.childCount - 1; i >= 0; i--) stack.push(n.child(i));
  }
  tree.delete();
  return { file, errors, missing, first };
}
let clean = 0, withError = 0, withMissing = 0; const worst = [];
for (const f of files) {
  let r; try { r = measure(f); } catch (e) { r = { file: f, errors: 1, missing: 0, first: [{ row: 0, column: 0, kind: 'READ', excerpt: String(e.message) }] }; }
  if (r.errors === 0 && r.missing === 0) clean++; else { if (r.errors) withError++; if (r.missing) withMissing++; worst.push(r); }
}
console.log(`wasm: ${wasmPath}`);
console.log(`files ${files.length}  clean ${clean} (${(100*clean/files.length).toFixed(1)}%)  with ERROR ${withError}  with MISSING ${withMissing}`);
worst.sort((a, b) => (b.errors + b.missing) - (a.errors + a.missing) || a.file.localeCompare(b.file));
const shown = all ? worst : worst.slice(0, top);
if (shown.length) console.log(`\n${all ? 'all' : `top ${shown.length}`} non-clean files (${worst.length} total):`);
for (const w of shown) {
  console.log(`${String(w.errors).padStart(4)} err ${String(w.missing).padStart(3)} miss  ${w.file.replace(process.env.HOME, '~')}`);
  if (!all) for (const f of w.first) console.log(`      ${f.row}:${f.column} ${f.kind}: ${f.excerpt}`);
}
