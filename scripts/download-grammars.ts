#!/usr/bin/env npx tsx
/**
 * Script to download all tree-sitter WASM grammar files
 */

import { downloadAllGrammars, getGrammarDownloader } from '../src/parser/treeSitter/grammarDownloader.js';

async function main() {
  console.log('Downloading tree-sitter grammars...\n');

  const downloader = getGrammarDownloader();
  const grammarsPath = downloader.getGrammarsPath();
  console.log(`Grammars directory: ${grammarsPath}\n`);

  const results = await downloadAllGrammars();

  console.log('\nResults:');
  console.log('========');

  let successCount = 0;
  let failCount = 0;

  for (const [lang, success] of results) {
    const status = success ? '✓' : '✗';
    console.log(`  ${status} ${lang}`);
    if (success) successCount++;
    else failCount++;
  }

  console.log(`\nDownloaded: ${successCount}/${successCount + failCount}`);

  // Show available grammars
  console.log('\nAvailable grammars:');
  const available = downloader.getAvailableGrammars();
  console.log(`  ${available.join(', ')}`);

  // Show missing grammars
  const missing = downloader.getMissingGrammars();
  if (missing.length > 0) {
    console.log('\nMissing grammars:');
    console.log(`  ${missing.join(', ')}`);
  }
}

main().catch(console.error);
