#!/usr/bin/env tsx
/**
 * One-shot DB migration: flip parserType='regex' → 'tree-sitter-wasm' for every
 * non-Fantom project row created before the addFantomProject schema update
 * defaulted parserType correctly.
 *
 * Idempotent. Safe to run multiple times.
 *
 * Usage:
 *   DATABASE_URL="file:/path/to/mcpfantom/.cache/fantom.db" \
 *     ./node_modules/.bin/tsx scripts/backfill-parser-type.mts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const before = await prisma.fantomProject.findMany({
    where: {
      parserType: 'regex',
      NOT: { language: { in: ['fantom', 'trio', 'axon'] } },
    },
    select: { id: true, name: true, language: true, parserType: true },
  });

  if (before.length === 0) {
    console.log('No projects need backfill — all non-Fantom rows already on tree-sitter-wasm.');
    return;
  }

  console.log(`Will flip ${before.length} project(s) to parserType='tree-sitter-wasm':`);
  for (const p of before) {
    console.log(`  #${p.id.toString().padStart(4)} ${p.name} (lang=${p.language})`);
  }

  const result = await prisma.fantomProject.updateMany({
    where: {
      parserType: 'regex',
      NOT: { language: { in: ['fantom', 'trio', 'axon'] } },
    },
    data: { parserType: 'tree-sitter-wasm' },
  });

  console.log(`\nUpdated ${result.count} row(s).`);
  console.log('Re-index any affected project to pick up the new parser:');
  console.log('  reindexChangedFiles or refreshFantomProject (force: true)');
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
