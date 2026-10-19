/**
 * indexVersionFor: the hash gate re-parses a file when the parser, extractor
 * or grammar that produced it changed. Versions must differ per extractor
 * family and per parser type, and stay stable across calls.
 */

import { indexVersionFor, extractorVersionFor, PARSER_SCHEMA_VERSION } from '../fantom-code/indexVersion.js';

const TS = 'tree-sitter-wasm';

describe('indexVersionFor', () => {
  it('is stable for the same file and parser', () => {
    expect(indexVersionFor('/p/a.ts', TS)).toBe(indexVersionFor('/p/b.ts', TS));
  });

  it('starts with the schema version and parser type', () => {
    expect(indexVersionFor('/p/a.ts', TS).startsWith(`${PARSER_SCHEMA_VERSION}:${TS}:`)).toBe(true);
  });

  it('differs between extractor families', () => {
    const ts = extractorVersionFor('/p/a.ts', TS);
    const md = extractorVersionFor('/p/README.md', TS);
    const vue = extractorVersionFor('/p/App.vue', TS);
    const trio = extractorVersionFor('/p/lib.trio', TS);
    expect(new Set([ts, md, vue, trio]).size).toBe(4);
    expect(md.startsWith('md:')).toBe(true);
    expect(vue.startsWith('vue:')).toBe(true);
    expect(trio.startsWith('trio:')).toBe(true);
  });

  it('differs between languages on the tree-sitter path', () => {
    expect(extractorVersionFor('/p/a.ts', TS)).not.toBe(extractorVersionFor('/p/a.py', TS));
    expect(extractorVersionFor('/p/a.ts', TS)).toContain(':typescript:');
  });

  it('a parser type flip changes the version (regex → tree-sitter re-parses)', () => {
    expect(indexVersionFor('/p/a.fan', 'regex')).not.toBe(indexVersionFor('/p/a.fan', TS));
    expect(extractorVersionFor('/p/a.fan', 'regex')).toMatch(/^fan-regex:/);
  });

  it('is case-insensitive on the extension', () => {
    expect(extractorVersionFor('/p/A.TS', TS)).toBe(extractorVersionFor('/p/a.ts', TS));
  });
});
