#!/usr/bin/env tsx
/**
 * Audit which tree-sitter grammar wasm artifacts are present vs configured.
 * Run this when:
 *   - addFantomProject for a non-Fantom language fails with a grammar error
 *   - You suspect silent regex fallback is happening
 *   - You add a new language to languageRegistry.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const grammarDir = path.join(repoRoot, 'src/parser/treeSitter/grammars');

async function main() {
  const { getLanguageRegistry } = await import(
    '../src/parser/treeSitter/languageRegistry.js'
  );
  const registry = getLanguageRegistry();
  await registry.initialize();

  // Read configured languages from the registry's private map. We don't
  // expose this publicly, so reach in for the audit script only.
  const configured = Array.from(((registry as any).languages as Map<string, any>).keys());

  const present: string[] = [];
  const missing: string[] = [];

  for (const lang of configured) {
    const wasmPath = path.join(grammarDir, `tree-sitter-${lang}.wasm`);
    if (fs.existsSync(wasmPath)) present.push(lang);
    else missing.push(lang);
  }

  console.log(`grammar dir: ${grammarDir}`);
  console.log(`\npresent (${present.length}):`);
  for (const l of present) console.log('  ✓', l);
  if (missing.length) {
    console.log(`\nmissing (${missing.length}):`);
    for (const l of missing) console.log('  ✗', l);
    process.exit(1);
  } else {
    console.log('\nall configured languages have a grammar artifact');
  }
}
main().catch((err) => {
  console.error(err);
  process.exit(2);
});
