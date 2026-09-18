#!/usr/bin/env tsx
/**
 * Test: semanticCodeSearch tool
 * Usage: npx tsx scripts/test-tool-semantic-search.ts
 */

import { mcpSession, callTool, printResult } from './lib/mcp-test-helpers.js';

async function main() {
  await mcpSession(async () => {
    console.log('=== semanticCodeSearch Tests ===\n');

    // Test 1: Basic natural language query
    console.log('1. Basic NL query: "HTTP connection handling"');
    const r1 = await callTool('semanticCodeSearch', { query: 'HTTP connection handling', limit: 5 });
    printResult(r1);

    // Test 2: Query with project filter
    console.log('\n2. With projectId filter');
    const r2 = await callTool('semanticCodeSearch', { query: 'string parsing', projectId: 1, limit: 3 });
    printResult(r2);

    // Test 3: Query with node type filter
    console.log('\n3. With nodeType filter = "method"');
    const r3 = await callTool('semanticCodeSearch', { query: 'error handling', nodeType: 'method', limit: 3 });
    printResult(r3);

    // Test 4: Empty results query
    console.log('\n4. Unlikely query (expect no results)');
    const r4 = await callTool('semanticCodeSearch', { query: 'xyzzy_nonexistent_concept_12345', limit: 3 });
    printResult(r4);
  });
}

main().catch(console.error);
