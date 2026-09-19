/**
 * Trio parsing through the vendored tree-sitter-trio grammar.
 *
 * Runs against the real wasm. If it is missing the suite says so and skips
 * rather than passing green on the legacy line-loop fallback.
 */

import { jest } from '@jest/globals';
import { initTrioGrammar, trioGrammarStatus, parseTrio, dedentBlock, TRIO_MARKER } from '../parser/treeSitter/trioGrammar.js';
import { TrioParser } from '../fantom-code/trioParser.js';

jest.setTimeout(30_000);

const SAMPLE = [
  '// library header comment',            // 1
  'name: add',                            // 2
  'func',                                 // 3
  'doc: "Adds two numbers"',              // 4
  'src:',                                 // 5
  '  // sum',                             // 6
  '  (a, b) => do',                       // 7
  '    x: a + b',                         // 8
  '',                                     // 9
  '    x.toStr()',                        // 10
  '  end',                                // 11
  '---',                                  // 12
  'name: "quoted"',                       // 13
  'func',                                 // 14
  'enabled: falseToTrue',                 // 15
  'flag: false',                          // 16
  'ref: @p:demo:r:abc "Site"',            // 17
  'src:',                                 // 18
  '  () => now()',                        // 19
  '---',                                  // 20
  'view: myView',                         // 21
  'dis: "My View"',                       // 22
  'appName: myApp',                       // 23
  'src:',                                 // 24
  '  view: {inherit:"table"}',            // 25
  '  sub1: Trio:',                        // 26
  '    view: {inherit:"chart"}',          // 27
  '    data: {expr:"readAll(site)"}',     // 28
  '---',                                  // 29
  'app: myApp',                           // 30
  'dis: "My App"',                        // 31
  'icon: "cog"',                          // 32
  '---',                                  // 33
  'dis: "grid holder"',                   // 34
  'grid: Zinc:',                          // 35
  '  ver:"3.0"',                          // 36
  '  a,b',                                // 37
  '  1,2',                                // 38
  'tags: [',                              // 39
  '  "x",',                               // 40
  '  "y"',                                // 41
  ']',                                    // 42
  'nested: Trio:',                        // 43
  '  inner: 1',                           // 44
  '  marker',                             // 45
  '',                                     // 46
].join('\n');

describe('tree-sitter-trio', () => {
  let ready = false;
  beforeAll(async () => { ready = await initTrioGrammar(); });

  test('grammar loads', () => {
    const st = trioGrammarStatus();
    if (!ready) console.warn(`SKIPPED: trio grammar unavailable — ${st.error}`);
    expect(ready).toBe(true);
  });

  test('records, lines, and block kinds', () => {
    if (!ready) return;
    const res = parseTrio(SAMPLE)!;
    expect(res.issues).toEqual([]);
    expect(res.records.map(r => r.line)).toEqual([2, 13, 21, 30, 34]);

    const fn = res.records[0];
    expect(fn.tags['func']).toBe(TRIO_MARKER);
    expect(fn.tags['doc']).toBe('Adds two numbers');
    expect(fn.tagLines['src']).toBe(5);
    expect(fn.tagKinds['src']).toBe('text');
    expect(fn.tags['src']).toBe('// sum\n(a, b) => do\n  x: a + b\n\n  x.toStr()\nend');

    const q = res.records[1];
    expect(q.tags['name']).toBe('quoted');
    expect(q.tags['enabled']).toBe('falseToTrue');
    expect(q.tags['flag']).toBe(false);
    expect(q.tags['ref']).toBe('@p:demo:r:abc "Site"');

    const misc = res.records[4];
    expect(misc.tagKinds['grid']).toBe('zinc');
    expect(misc.tags['grid']).toBe('ver:"3.0"\na,b\n1,2');
    expect(misc.tagKinds['tags']).toBe('list');
    // the lone `]` is a single-character line at column 0, so nothing dedents
    expect(misc.tags['tags']).toBe('[\n  "x",\n  "y"\n]');
    expect(misc.tagKinds['nested']).toBe('trio');
    expect(misc.tags['nested']).toEqual({ inner: '1', marker: TRIO_MARKER });
  });

  test('syntax problems surface as issues, not silent record shifts', () => {
    if (!ready) return;
    const res = parseTrio('name: ok\nfunc\n---\n  stray indented line\nname: two\n')!;
    expect(res.issues.length).toBeGreaterThan(0);
    expect(res.records.map(r => r.tags['name'])).toContain('two');
  });

  test('CRLF files keep no carriage return in names or values', () => {
    if (!ready) return;
    const crlf = 'name: add\r\nfunc\r\n// note\r\ndis: "x"\r\ntags: [1, 2]\r\nsrc:\r\n  () => 1\r\n---\r\nname: two\r\n';
    const res = parseTrio(crlf)!;
    expect(res.issues).toEqual([]);
    expect(res.records.map(r => r.tags['name'])).toEqual(['add', 'two']);
    expect(res.records[0].tags['dis']).toBe('x');
    expect(res.records[0].tags['tags']).toBe('[1, 2]');
    expect(res.records[0].tags['src']).toBe('() => 1');
    expect(JSON.stringify(res.records)).not.toContain('\\r');
  });

  test('dedentBlock strips the common indent and trailing blanks', () => {
    expect(dedentBlock('\n    a\n\n      b\n  \n')).toBe('a\n\n  b');
    expect(dedentBlock('\n')).toBe('');
  });
});

describe('TrioParser via grammar', () => {
  let ready = false;
  beforeAll(async () => { ready = await initTrioGrammar(); });

  test('functions, views, and apps with exact line numbers', async () => {
    if (!ready) return;
    const parser = new TrioParser(1, 'demo');
    const parsed = await parser.parseString(SAMPLE, 'lib/funcs.trio');
    expect(parsed.errors).toEqual([]);

    expect(parsed.functions.map(f => [f.name, f.lineNumber])).toEqual([['add', 2], ['quoted', 13]]);
    const add = parsed.functions[0];
    expect(add.qualifiedName).toBe('demo::add');
    expect(add.parameters.map(p => p.name)).toEqual(['a', 'b']);
    expect(add.sourceCode).toContain('x.toStr()');
    expect(add.description).toBe('sum');
    // regex call extraction (no axon tree-sitter passed): now() sits on file line 19
    const quoted = parsed.functions[1];
    expect(quoted.calls?.find(c => c.calledName === 'now')?.lineNumber).toBe(19);

    const view = parsed.types.find(t => t.name === 'myView')!;
    expect(view.lineNumber).toBe(21);
    expect(view.methods.map(m => [m.name, m.lineNumber, m.returnType])).toEqual([['sub1', 26, 'chart']]);

    const app = parsed.types.find(t => t.name === 'myApp')!;
    expect(app.lineNumber).toBe(30);
    expect(app.qualifiedName).toBe('demo::app_myApp');
  });
});
