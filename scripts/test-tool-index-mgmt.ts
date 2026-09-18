#!/usr/bin/env tsx
/**
 * Test: Index Management tool
 * Tests: indexInstanceDocs
 * Usage: npx tsx scripts/test-tool-index-mgmt.ts
 */

import { mcpSession, callTool, printResult } from './lib/mcp-test-helpers.js';

async function main() {
  await mcpSession(async () => {
    console.log('=== Index Management Tool ===\n');

    console.log('1. indexInstanceDocs - instance 1');
    const r1 = await callTool('indexInstanceDocs', { instanceId: 1 });
    printResult(r1);

    console.log('\n2. indexInstanceDocs - nonexistent instance');
    const r2 = await callTool('indexInstanceDocs', { instanceId: 99999 });
    printResult(r2);

    console.log('\n3. indexInstanceDocs - with specific pods');
    const r3 = await callTool('indexInstanceDocs', { instanceId: 1, pods: ['sys'], forceRefresh: false });
    printResult(r3);
  });
}

main().catch(console.error);
