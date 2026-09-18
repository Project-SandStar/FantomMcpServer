#!/usr/bin/env tsx
/**
 * compare-parsers — run the regex and tree-sitter parsers over the same set
 * of Fantom files and emit a side-by-side diff so the user can ground-truth
 * which symbols are real and which one parser is missing or hallucinating.
 *
 * Usage:
 *   tsx scripts/compare-parsers.mts <projectId>
 *   tsx scripts/compare-parsers.mts --path ~/fantom/fantom-1.0.78/src/xml
 *   tsx scripts/compare-parsers.mts --file /path/to/Foo.fan
 *
 * Output:
 *   - Per-file counts (regex vs tree-sitter)
 *   - Symbols only in regex, only in tree-sitter (with qualifiedName + line)
 *   - Project-level totals
 *
 * No DB writes. Pure parser comparison.
 */

import * as fs from 'fs';
import * as path from 'path';
import { FantomCodeParser } from '../src/fantom-code/codeParser.js';
import { createTreeSitterParser } from '../src/fantom-code/treeSitterAdapter.js';
import { FantomFileScanner } from '../src/fantom-code/scanner.js';
import { getPrismaClient } from '../src/db/prisma.js';
import type { ParsedFile, FantomFunction, FantomTypeDef } from '../src/fantom-code/types.js';

interface SymbolKey {
  kind: 'type' | 'function';
  qualifiedName: string;
  filePath: string;
  line: number;
}

// Dedupe by qualifiedName + file (NOT line — the two parsers report
// different anchor lines for the same symbol; see compareLine helper for
// the per-symbol line diff).
function fnKey(f: FantomFunction): string {
  return `${f.qualifiedName}@${path.basename(f.filePath)}`;
}
function typeKey(t: FantomTypeDef): string {
  return `${t.qualifiedName}@${path.basename(t.filePath)}`;
}
function fnLine(f: FantomFunction): number { return f.lineNumber; }
function typeLine(t: FantomTypeDef): number { return t.lineNumber; }

function summarize(parsed: ParsedFile) {
  const fnSet = new Set(parsed.functions.map(fnKey));
  const typeSet = new Set(parsed.types.map(typeKey));
  return { fnSet, typeSet, fnCount: parsed.functions.length, typeCount: parsed.types.length };
}

function diff<T>(a: Set<T>, b: Set<T>): T[] {
  return [...a].filter(x => !b.has(x));
}

async function main() {
  const args = process.argv.slice(2);
  let projectPath: string | null = null;
  let podName: string | null = null;
  let projectId: number | null = null;
  let singleFile: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--path') projectPath = args[++i];
    else if (args[i] === '--file') singleFile = args[++i];
    else if (!isNaN(Number(args[i]))) projectId = Number(args[i]);
  }

  if (singleFile) {
    if (!fs.existsSync(singleFile)) {
      console.error(`File not found: ${singleFile}`);
      process.exit(1);
    }
    projectPath = path.dirname(singleFile);
  }

  if (projectId !== null && !projectPath) {
    const prisma = getPrismaClient();
    const project = await prisma.fantomProject.findUnique({ where: { id: projectId } });
    if (!project) {
      console.error(`Project ${projectId} not found in DB`);
      process.exit(1);
    }
    projectPath = project.path;
    podName = project.podName;
    console.log(`Loaded project ${projectId}: ${project.name}`);
    console.log(`  Path:       ${project.path}`);
    console.log(`  Language:   ${project.language}`);
    console.log(`  ParserType: ${project.parserType}`);
    console.log(`  DB stats:   ${project.functionCount} fns, ${project.typeCount} types`);
    console.log('');
  }

  if (!projectPath) {
    console.error('Usage: tsx scripts/compare-parsers.mts <projectId|--path DIR|--file FILE>');
    process.exit(1);
  }

  // Discover .fan files
  let files: string[];
  if (singleFile) {
    files = [singleFile];
  } else {
    const scanner = new FantomFileScanner();
    const scan = await scanner.scanDirectory(projectPath);
    files = scan.files.filter(f => f.endsWith('.fan'));
    if (!podName && scan.projectMeta?.podName) podName = scan.projectMeta.podName;
  }
  console.log(`Comparing parsers on ${files.length} .fan file(s) from ${projectPath}`);
  console.log('---');

  // Set up both parsers
  const dummyProjectId = projectId ?? 0;
  const podMeta = podName ? { podName, dependencies: [], srcDirs: ['fan'] } : undefined;
  const regex = new FantomCodeParser(dummyProjectId, podMeta);
  const ts = createTreeSitterParser(dummyProjectId, 'fantom', podMeta?.podName);
  const tsOk = await ts.initialize();
  if (!tsOk) {
    console.error('Tree-sitter Fantom grammar failed to initialize. Run `npm run build` and confirm src/parser/treeSitter/grammars/tree-sitter-fantom.wasm exists.');
    process.exit(1);
  }

  // Aggregate accumulators
  const allRegexFns = new Set<string>();
  const allTsFns = new Set<string>();
  const allRegexTypes = new Set<string>();
  const allTsTypes = new Set<string>();

  let regexTotalFns = 0, tsTotalFns = 0;
  let regexTotalTypes = 0, tsTotalTypes = 0;

  // Per-file diff
  for (const file of files) {
    const rel = path.relative(projectPath, file);
    let r: ParsedFile, t: ParsedFile;
    try { r = regex.parseFile(file); } catch (e) { console.log(`  REGEX FAIL ${rel}: ${e instanceof Error ? e.message : e}`); continue; }
    try { t = await ts.parseFile(file); } catch (e) { console.log(`  TS    FAIL ${rel}: ${e instanceof Error ? e.message : e}`); continue; }

    const rs = summarize(r);
    const ts2 = summarize(t);

    regexTotalFns += rs.fnCount; tsTotalFns += ts2.fnCount;
    regexTotalTypes += rs.typeCount; tsTotalTypes += ts2.typeCount;

    rs.fnSet.forEach(x => allRegexFns.add(x));
    ts2.fnSet.forEach(x => allTsFns.add(x));
    rs.typeSet.forEach(x => allRegexTypes.add(x));
    ts2.typeSet.forEach(x => allTsTypes.add(x));

    const onlyR_fn = diff(rs.fnSet, ts2.fnSet);
    const onlyT_fn = diff(ts2.fnSet, rs.fnSet);
    const onlyR_t = diff(rs.typeSet, ts2.typeSet);
    const onlyT_t = diff(ts2.typeSet, rs.typeSet);

    // For symbols present in BOTH, compute average line-number drift so we
    // can confirm regex/ts agree on identity even when anchor lines differ.
    const fnLineMap = new Map<string, { r: number; t: number }>();
    for (const f of r.functions) fnLineMap.set(fnKey(f), { r: f.lineNumber, t: -1 });
    for (const f of t.functions) {
      const k = fnKey(f);
      const e = fnLineMap.get(k);
      if (e) e.t = f.lineNumber;
    }
    const drifts: number[] = [];
    for (const [, v] of fnLineMap) if (v.r >= 0 && v.t >= 0) drifts.push(v.t - v.r);
    const avgDrift = drifts.length ? (drifts.reduce((a, b) => a + b, 0) / drifts.length).toFixed(1) : 'n/a';

    const same = onlyR_fn.length === 0 && onlyT_fn.length === 0 && onlyR_t.length === 0 && onlyT_t.length === 0;
    const flag = same ? '✓' : '✗';

    console.log(`${flag} ${rel}  regex=[${rs.fnCount}fn ${rs.typeCount}t] ts=[${ts2.fnCount}fn ${ts2.typeCount}t]  agree=${drifts.length} fns (avg line drift ${avgDrift})`);

    if (!same) {
      if (onlyR_t.length) console.log(`    types only in REGEX:  ${onlyR_t.join(', ')}`);
      if (onlyT_t.length) console.log(`    types only in TS:     ${onlyT_t.join(', ')}`);
      if (onlyR_fn.length) {
        console.log(`    fns only in REGEX (${onlyR_fn.length}) — likely false positives or members tree-sitter missed:`);
        onlyR_fn.slice(0, 12).forEach(x => console.log(`      ${x}`));
        if (onlyR_fn.length > 12) console.log(`      ... +${onlyR_fn.length - 12} more`);
      }
      if (onlyT_fn.length) {
        console.log(`    fns only in TS    (${onlyT_fn.length}) — real methods regex missed:`);
        onlyT_fn.slice(0, 12).forEach(x => console.log(`      ${x}`));
        if (onlyT_fn.length > 12) console.log(`      ... +${onlyT_fn.length - 12} more`);
      }
    }
  }

  console.log('---');
  console.log('Project totals (sums across files):');
  console.log(`  REGEX:        ${regexTotalFns} fns, ${regexTotalTypes} types`);
  console.log(`  TREE-SITTER:  ${tsTotalFns} fns, ${tsTotalTypes} types`);
  console.log(`  delta (regex - ts): ${regexTotalFns - tsTotalFns} fns, ${regexTotalTypes - tsTotalTypes} types`);
  console.log('');
  console.log('Distinct symbols across project (deduped):');
  console.log(`  REGEX:        ${allRegexFns.size} fns, ${allRegexTypes.size} types`);
  console.log(`  TREE-SITTER:  ${allTsFns.size} fns, ${allTsTypes.size} types`);
  console.log(`  only in REGEX: ${diff(allRegexFns, allTsFns).length} fns, ${diff(allRegexTypes, allTsTypes).length} types`);
  console.log(`  only in TS:    ${diff(allTsFns, allRegexFns).length} fns, ${diff(allTsTypes, allRegexTypes).length} types`);

  // Spot-check ground truth: grep raw method-like definitions
  console.log('');
  console.log('Ground-truth heuristics (grep-derived, treat as upper bounds):');
  let topClasses = 0, topMethods = 0;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    // Top-level class/mixin/enum (not nested)
    topClasses += (text.match(/^(?:@\w+\s+)*(?:abstract\s+|final\s+|const\s+|public\s+|internal\s+)*(?:class|mixin|enum\s+class|facet\s+class)\s+\w+/gm) || []).length;
    // Method definitions that start with a type and an identifier and an open paren — INSIDE a class body (best-effort)
    topMethods += (text.match(/^\s+(?:@\w+\s+)*(?:abstract\s+|virtual\s+|override\s+|static\s+|native\s+|once\s+|new\s+|public\s+|private\s+|protected\s+|internal\s+)*(?:Void|Str|Int|Bool|Obj|This|[A-Z]\w*)\??\s+\w+\s*\(/gm) || []).length;
  }
  console.log(`  grep top-level classes/mixins/enums: ${topClasses}`);
  console.log(`  grep method-like signatures:         ${topMethods}`);
  console.log('');
  console.log('Tree-sitter is generally more accurate when its count is lower than regex —');
  console.log('regex tends to over-match (locals, multi-line, false positives).');
  console.log('Where tree-sitter misses what regex finds, the regex hit may be a real');
  console.log('method the AST grammar does not yet model — open and inspect.');

  await getPrismaClient().$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
