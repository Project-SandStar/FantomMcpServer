#!/usr/bin/env tsx
/**
 * Test: findSimilarCode tool
 * Usage: npx tsx scripts/test-tool-find-similar.ts
 */

import { mcpSession, callTool, printResult, discoverGraphNodeQN } from './lib/mcp-test-helpers.js';

async function main() {
  await mcpSession(async () => {
    console.log('=== findSimilarCode Tests ===\n');

    const testQN = await discoverGraphNodeQN();
    console.log(`Using discovered qualified name: ${testQN}\n`);

    // Test 1: By qualified name
    console.log(`1. Find similar to ${testQN}`);
    const r1 = await callTool('findSimilarCode', { qualifiedName: testQN, limit: 5 });
    printResult(r1);

    // Test 2: With project filter
    console.log('\n2. With projectId filter');
    const r2 = await callTool('findSimilarCode', { qualifiedName: testQN, projectId: 1, limit: 3 });
    printResult(r2);

    // Test 3: Missing parameters (should error gracefully)
    console.log('\n3. Missing nodeId and qualifiedName (expect error)');
    const r3 = await callTool('findSimilarCode', {});
    printResult(r3);
  });
}

main().catch(console.error);
