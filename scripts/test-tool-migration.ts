#!/usr/bin/env tsx
/**
 * Test: Migration tools (safe, non-destructive tests only)
 * Tests: migrateSkySpark4x (dry-run), commitMigration, rollbackMigration
 * Usage: npx tsx scripts/test-tool-migration.ts
 */

import { mcpSession, callTool, printResult } from './lib/mcp-test-helpers.js';

async function main() {
  await mcpSession(async () => {
    console.log('=== Migration Tools (Safe Tests) ===\n');

    // commitMigration and rollbackMigration should fail gracefully when no migration is active
    console.log('1. commitMigration (no active migration - expect graceful error)');
    const r1 = await callTool('commitMigration', { message: 'test commit' });
    printResult(r1);

    console.log('\n2. rollbackMigration (no active migration - expect graceful error)');
    const r2 = await callTool('rollbackMigration', {});
    printResult(r2);

    // migrateSkySpark4x dry-run would need a valid GitLab URL, so we just test that
    // the tool responds with a proper error for invalid input
    console.log('\n3. migrateSkySpark4x (invalid URL - expect validation error)');
    const r3 = await callTool('migrateSkySpark4x', {
      gitlabUrl: 'invalid-url',
      projectName: 'test',
      workDir: '/tmp/test-migration',
      skysparkBinPath: '/nonexistent/bin',
      dryRun: true,
    });
    printResult(r3);
  });
}

main().catch(console.error);
