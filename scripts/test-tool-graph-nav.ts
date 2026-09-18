#!/usr/bin/env tsx
/**
 * Test: getCallers, getCallees, getCodeImpact tools
 * Usage: npx tsx scripts/test-tool-graph-nav.ts
 */

import { mcpSession, callTool, printResult, discoverGraphNodeQN } from './lib/mcp-test-helpers.js';

async function main() {
  await mcpSession(async () => {
    console.log('=== Graph Navigation Tools Tests ===\n');

    const testQN = await discoverGraphNodeQN();
    console.log(`Using discovered qualified name: ${testQN}\n`);

    // Test getCallers
    console.log(`1. getCallers for ${testQN}`);
    const r1 = await callTool('getCallers', { qualifiedName: testQN, maxDepth: 2 });
    printResult(r1);

    console.log(`\n2. getCallers with maxDepth=1`);
    const r2 = await callTool('getCallers', { qualifiedName: testQN, maxDepth: 1 });
    printResult(r2);

    // Test getCallees
    console.log(`\n3. getCallees for ${testQN}`);
    const r3 = await callTool('getCallees', { qualifiedName: testQN, maxDepth: 2 });
    printResult(r3);

    // Test getCodeImpact
    console.log(`\n4. getCodeImpact for ${testQN}`);
    const r4 = await callTool('getCodeImpact', { qualifiedName: testQN, maxDepth: 3 });
    printResult(r4);

    // Test error case
    console.log('\n5. getCallers with no params (expect error)');
    const r5 = await callTool('getCallers', {});
    printResult(r5);
  });
}

main().catch(console.error);
