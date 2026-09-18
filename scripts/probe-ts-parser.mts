#!/usr/bin/env tsx
/**
 * Probe the TS extractor directly. Confirms the recursive walker captures
 * arrow functions, exports, const-decl functions — which the original
 * direct-children-only loop missed.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

async function main() {
  const { TreeSitterParser } = await import('../src/parser/treeSitter/treeSitterParser.js');
  const sample = `
// Module-scoped declarations the legacy walker missed
export function exportedDecl(a: number): number { return a + 1; }

function plainDecl() {}

export const arrowExport = (x: string) => x.length;

const inlineConst = function inlineFnExpr() { return 42; };

const namedArrow = (y: number) => y * 2;

export default function defaultExportFn() {}

// A class — its methods should NOT pollute the top-level pass
export class Sample {
  constructor() {}
  doThing() {}
  async asyncMethod() {}
  arrowProp = () => 'x';
}

// Interface methods also shouldn't appear at the top level
export interface IFace {
  iMethod(): void;
}
`;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fantom-probe-'));
  const file = path.join(tmpDir, 'sample.ts');
  await fs.writeFile(file, sample);

  const parser = new TreeSitterParser();
  await parser.initialize();
  const result = await parser.parseFile(file, sample);
  await fs.rm(tmpDir, { recursive: true, force: true });

  console.log('functions found:', result.functions.length);
  for (const f of result.functions) console.log('  -', f.name, '@', f.lineNumber);

  const types = (result as any).types ?? (result as any).classes ?? [];
  console.log('types found:', types.length);
  for (const t of types) {
    console.log('  -', t.name, '(methods:', (t.methods ?? []).length, ')');
    for (const m of t.methods ?? []) console.log('     .', m.name);
  }

  // Assertions
  const fnNames = result.functions.map((f) => f.name);
  const expected = [
    'exportedDecl',
    'plainDecl',
    'arrowExport',
    'inlineConst',
    'namedArrow',
    'defaultExportFn',
  ];
  const missing = expected.filter((n) => !fnNames.includes(n));
  if (missing.length) {
    console.error(`FAIL — missing top-level functions: ${missing.join(', ')}`);
    process.exit(1);
  }
  // Class and interface methods must NOT appear at top level
  const polluted = ['doThing', 'asyncMethod', 'iMethod'].filter((n) =>
    fnNames.includes(n),
  );
  if (polluted.length) {
    console.error(`FAIL — class/interface methods leaked into top level: ${polluted.join(', ')}`);
    process.exit(1);
  }
  console.log('OK — all 6 expected top-level functions present, no leakage');
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
