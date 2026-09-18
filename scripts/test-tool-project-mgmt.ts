#!/usr/bin/env tsx
/**
 * Test: Project Management tools
 * Tests: listFantomProjects, getFantomCodeStats, listCompatiblePods
 * Usage: npx tsx scripts/test-tool-project-mgmt.ts
 */

import { mcpSession, callTool, printResult } from './lib/mcp-test-helpers.js';

async function main() {
  await mcpSession(async () => {
    console.log('=== Project Management Tools ===\n');

    console.log('1. listFantomProjects');
    const r1 = await callTool('listFantomProjects', {});
    printResult(r1);

    console.log('\n2. getFantomCodeStats');
    const r2 = await callTool('getFantomCodeStats', {});
    printResult(r2);

    console.log('\n3. listCompatiblePods - version 4.0.3');
    const r3 = await callTool('listCompatiblePods', { version: '4.0.3' });
    printResult(r3);

    console.log('\n4. listCompatiblePods - version 3.1.12');
    const r4 = await callTool('listCompatiblePods', { version: '3.1.12' });
    printResult(r4);
  });
}

main().catch(console.error);
