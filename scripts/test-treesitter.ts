#!/usr/bin/env npx tsx
/**
 * Test script to verify tree-sitter parser works with downloaded grammars
 */

import { getTreeSitterParser } from '../src/parser/treeSitter/index.js';

const testCases = {
  typescript: `
interface User {
  id: number;
  name: string;
}

function greet(user: User): string {
  return \`Hello, \${user.name}!\`;
}
`,
  javascript: `
class Calculator {
  add(a, b) {
    return a + b;
  }
}
`,
  python: `
def factorial(n):
    if n <= 1:
        return 1
    return n * factorial(n - 1)
`,
  vue: `
<template>
  <div class="container">
    <h1>{{ title }}</h1>
    <button @click="handleClick">Click me</button>
  </div>
</template>
`,
  json: `
{
  "name": "test",
  "version": "1.0.0",
  "dependencies": {}
}
`,
  html: `
<!DOCTYPE html>
<html>
  <head><title>Test</title></head>
  <body><h1>Hello World</h1></body>
</html>
`,
  fantom: `
class Calculator {
  Int add(Int a, Int b) {
    return a + b
  }

  static Void main(Str[] args) {
    calc := Calculator()
    echo(calc.add(2, 3))
  }
}
`
};

async function main() {
  console.log('Testing tree-sitter parser...\n');

  const parser = await getTreeSitterParser();

  console.log('Supported languages:', parser.getSupportedLanguages().join(', '));
  console.log('Available grammars:', parser.getAvailableGrammars().join(', '));
  console.log();

  for (const [lang, code] of Object.entries(testCases)) {
    console.log(`Testing ${lang}...`);

    try {
      const result = await parser.parseSource(code.trim(), lang as any, {
        extractDocs: true,
        extractCalls: true
      });

      if (result.success) {
        console.log(`  ✓ Parsed successfully`);
        console.log(`    - Classes: ${result.classes.length}`);
        console.log(`    - Functions: ${result.functions.length}`);
        console.log(`    - Imports: ${result.imports.length}`);
        console.log(`    - Parse time: ${result.parseTime}ms`);
      } else {
        console.log(`  ✗ Parse failed: ${result.errors.map(e => e.message).join(', ')}`);
      }
    } catch (error) {
      console.log(`  ✗ Error: ${error}`);
    }
    console.log();
  }
}

main().catch(console.error);
