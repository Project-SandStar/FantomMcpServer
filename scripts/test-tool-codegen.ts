#!/usr/bin/env tsx
/**
 * Test: Code Generation tool
 * Tests: generateFantomCode
 * Usage: npx tsx scripts/test-tool-codegen.ts
 */

import { mcpSession, callTool, printResult } from './lib/mcp-test-helpers.js';

async function main() {
  await mcpSession(async () => {
    console.log('=== Code Generation Tool ===\n');

    console.log('1. Generate a class');
    const r1 = await callTool('generateFantomCode', {
      type: 'class',
      name: 'Sensor',
      pod: 'hvac',
      extends: 'Obj',
      fields: [
        { name: 'id', type: 'Int' },
        { name: 'label', type: 'Str' },
        { name: 'value', type: 'Float', defaultValue: '0f' },
      ],
      methods: [
        { name: 'read', returnType: 'Float', body: 'return value' },
        { name: 'display', returnType: 'Str', body: 'return "$label: $value"' },
      ],
    });
    printResult(r1, 1000);

    console.log('\n2. Generate a method');
    const r2 = await callTool('generateFantomCode', {
      type: 'method',
      name: 'parseCsv',
      pod: 'util',
      returnType: 'Str[]',
      params: [{ name: 'input', type: 'Str' }],
      body: 'return input.split(",")',
    });
    printResult(r2, 1000);

    console.log('\n3. Generate an enum');
    const r3 = await callTool('generateFantomCode', {
      type: 'enum',
      name: 'Priority',
      pod: 'core',
      values: ['low', 'medium', 'high', 'critical'],
    });
    printResult(r3, 1000);

    console.log('\n4. Generate a pod');
    const r4 = await callTool('generateFantomCode', {
      type: 'pod',
      name: 'myApp',
      depends: ['sys', 'inet', 'web'],
    });
    printResult(r4, 1000);
  });
}

main().catch(console.error);
