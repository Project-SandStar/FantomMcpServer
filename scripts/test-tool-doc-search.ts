#!/usr/bin/env tsx
/**
 * Test: Documentation & Search tools
 * Tests: getFantomType, listFantomPods, searchLocalDocs, searchVersionedApi,
 *        listLocalPods, getLocalDocStatus
 * Usage: npx tsx scripts/test-tool-doc-search.ts
 */

import { mcpSession, callTool, printResult } from './lib/mcp-test-helpers.js';

async function main() {
  await mcpSession(async () => {
    console.log('=== Documentation & Search Tools ===\n');

    console.log('1. getFantomType - sys::Str');
    const r1 = await callTool('getFantomType', { qualifiedName: 'sys::Str' });
    printResult(r1);

    console.log('\n2. getFantomType - nonexistent type');
    const r2 = await callTool('getFantomType', { qualifiedName: 'fake::NoExist' });
    printResult(r2);

    console.log('\n3. listFantomPods');
    const r3 = await callTool('listFantomPods', {});
    printResult(r3);

    console.log('\n4. searchLocalDocs - "point"');
    const r4 = await callTool('searchLocalDocs', { query: 'point' });
    printResult(r4);

    console.log('\n5. searchVersionedApi - "Str" mode=api');
    const r5 = await callTool('searchVersionedApi', { query: 'Str', mode: 'api', limit: 5 });
    printResult(r5);

    console.log('\n6. searchVersionedApi - "readAll" mode=all');
    const r6 = await callTool('searchVersionedApi', { query: 'readAll', mode: 'all', limit: 3 });
    printResult(r6);

    console.log('\n7. listLocalPods - instance 1');
    const r7 = await callTool('listLocalPods', { instanceId: 1 });
    printResult(r7);

    console.log('\n8. getLocalDocStatus - instance 1');
    const r8 = await callTool('getLocalDocStatus', { instanceId: 1 });
    printResult(r8);
  });
}

main().catch(console.error);
