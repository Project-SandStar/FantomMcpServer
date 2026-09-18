#!/usr/bin/env tsx
/**
 * Test: Code Search tools (keyword-based)
 * Tests: searchFantomCode, getFantomFunction
 * Usage: npx tsx scripts/test-tool-code-search.ts
 */

import { mcpSession, callTool, printResult } from './lib/mcp-test-helpers.js';

async function main() {
  await mcpSession(async () => {
    console.log('=== Code Search Tools ===\n');

    console.log('1. searchFantomCode - "make"');
    const r1 = await callTool('searchFantomCode', { query: 'make', limit: 5 });
    printResult(r1);

    console.log('\n2. searchFantomCode - "toStr" with projectId');
    const r2 = await callTool('searchFantomCode', { query: 'toStr', projectId: 1, limit: 3 });
    printResult(r2);

    console.log('\n3. getFantomFunction - sys::Str.toStr');
    const r3 = await callTool('getFantomFunction', { qualifiedName: 'sys::Str.toStr' });
    printResult(r3);

    console.log('\n4. getFantomFunction - nonexistent');
    const r4 = await callTool('getFantomFunction', { qualifiedName: 'fake::Nothing.noMethod' });
    printResult(r4);
  });
}

main().catch(console.error);
