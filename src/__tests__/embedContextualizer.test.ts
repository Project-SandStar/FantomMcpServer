/**
 * v4 contextualiser: prompt shape, reply parsing, content-hash cache, and
 * the merge order (LLM sentence before the graph line). The chat transport is
 * injected; nothing reaches the network. Source files live in a temp dir.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseContextReply, buildContextUserPrompt, mergeContexts, nodeContentHash, contextualizeNodes,
  CONTEXT_MAX_CHARS, type ContextChat,
} from '../embedding/embedContextualizer.js';

describe('parseContextReply', () => {
  it('reads a bare JSON object and keeps only the asked ids', () => {
    const m = parseContextReply('{"a":"Handles the HTTP session lifecycle for the web extension, called by WebMod on each request.","b":"short","zzz":"not asked"}', ['a', 'b']);
    expect([...m.keys()]).toEqual(['a']);
  });
  it('tolerates a fence and prose around the object', () => {
    const m = parseContextReply('Sure:\n```json\n{"x": "Builds the Xeto binding table used by ph.lib lookups when a pod declares xeto.bindings in its build index."}\n```\nDone.', ['x']);
    expect(m.get('x')).toMatch(/xeto\.bindings/);
  });
  it('caps a runaway sentence and drops non-strings', () => {
    const long = 'w '.repeat(500);
    const m = parseContextReply(JSON.stringify({ a: long, b: 42 }), ['a', 'b']);
    expect(m.get('a')!.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
    expect(m.has('b')).toBe(false);
  });
  it('is empty on junk', () => {
    expect(parseContextReply('no json here', ['a']).size).toBe(0);
  });
  it('reads one object per line (the shape deepseek produced on 2026-09-29)', () => {
    const t = '{"49d77e7b20b668cb": "BassgConedViewDashboardLib is a const class providing dashboard view functions using axon and haystack."}\n{"3c9b59dddfd5f3d0": "getPass is a static Axon method that takes a haystack Ref userRef and fetches a user password."}';
    const m = parseContextReply(t, ['49d77e7b20b668cb', '3c9b59dddfd5f3d0']);
    expect(m.size).toBe(2);
    expect(m.get('3c9b59dddfd5f3d0')).toMatch(/^getPass is a static/);
  });
  it('salvages a pair cut off by max_tokens and one broken by an unescaped quote', () => {
    const t = '{"aaaaaaaaaaaaaaaa": "Reads the "pod" index tags ph.lib and xeto.bindings for the hx runtime at boot.", "bbbbbbbbbbbbbbbb": "Stops the extension and releases its actor pool when the runtime shuts do';
    const m = parseContextReply(t, ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']);
    expect(m.get('aaaaaaaaaaaaaaaa')).toMatch(/ph\.lib and xeto\.bindings/);
    expect(m.get('bbbbbbbbbbbbbbbb')).toMatch(/^Stops the extension/);
  });
  it('accepts keys that echo the "id " prefix from the prompt', () => {
    const m = parseContextReply('{"id 9cf85a1c6925f1dd": "EcobeeRemoteSensorCapability is a const class in the hxEcobee connector describing a remote sensor capability."}', ['9cf85a1c6925f1dd']);
    expect(m.get('9cf85a1c6925f1dd')).toMatch(/^EcobeeRemoteSensorCapability/);
  });
  it('unescapes JSON escapes inside a sentence', () => {
    const m = parseContextReply('{"cccccccccccccccc": "Matches the pattern \\"/api/{proj}/rec\\" and returns the id, else null for the obix web module."}', ['cccccccccccccccc']);
    expect(m.get('cccccccccccccccc')).toContain('"/api/{proj}/rec"');
  });
});

describe('buildContextUserPrompt', () => {
  it('lists every symbol with its id, kind, signature and lines', () => {
    const p = buildContextUserPrompt({
      filePath: 'src/core/hx/fan/Ext.fan', pod: 'hx', fileText: 'class Ext {}',
      nodes: [{ id: 'n1', qualifiedName: 'hx::Ext.onStart', kind: 'method', signature: 'Void onStart()', lineStart: 10, lineEnd: 20 }],
    });
    expect(p).toContain('id n1: method hx::Ext.onStart — Void onStart() (lines 10-20)');
    expect(p).toContain('<file>\nclass Ext {}\n</file>');
    expect(p).toContain('Library/pod: hx');
  });
});

describe('mergeContexts', () => {
  it('puts the LLM sentence first, keeps graph-only and llm-only nodes', () => {
    const out = mergeContexts(new Map([['a', 'context: in Ext; calls: x'], ['g', 'context: in G']]), new Map([['a', 'Starts the ext.'], ['l', 'Only llm.']]));
    expect(out.get('a')).toBe('about: Starts the ext.\ncontext: in Ext; calls: x');
    expect(out.get('g')).toBe('context: in G');
    expect(out.get('l')).toBe('about: Only llm.');
  });
});

describe('contextualizeNodes', () => {
  let dir: string;
  let file: string;
  const origCwd = process.cwd();
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxz-'));
    file = path.join(dir, 'Ext.fan');
    fs.writeFileSync(file, ['class Ext {', '  Void onStart() { log.info("hi") }', '  Void onStop() {}', '}'].join('\n'));
    process.chdir(dir); // cache lands in <dir>/.cache/embed-context
  });
  afterAll(() => { process.chdir(origCwd); fs.rmSync(dir, { recursive: true, force: true }); });

  const nodes = [
    { id: 'n1', qualifiedName: 'hx::Ext.onStart', nodeType: 'method', signature: 'Void onStart()', filePath: '', lineStart: 2, lineEnd: 2 },
    { id: 'n2', qualifiedName: 'hx::Ext.onStop', nodeType: 'method', signature: 'Void onStop()', filePath: '', lineStart: 3, lineEnd: 3 },
  ];

  it('asks once per file, caches by content hash, and re-uses the cache', async () => {
    const withFile = nodes.map((n) => ({ ...n, filePath: file }));
    let calls = 0;
    const chat: ContextChat = async (_s, user) => {
      calls++;
      expect(user).toContain('id n1:');
      expect(user).toContain('id n2:');
      return { text: JSON.stringify({ n1: 'Starts the extension and its actor pool; called once by the runtime at boot.', n2: 'Stops the extension; the runtime calls it on shutdown or ext disable.' }), costUsd: 0.0001 };
    };
    const a = await contextualizeNodes(275, withFile, { chat });
    expect(calls).toBe(1);
    expect(a.stats).toMatchObject({ nodes: 2, cached: 0, requested: 2, written: 2, failed: 0, requests: 1, files: 1 });
    expect(a.contexts.get('n1')).toMatch(/^Starts the extension/);

    const b = await contextualizeNodes(275, withFile, { chat });
    expect(calls).toBe(1); // cache hit, no request
    expect(b.stats).toMatchObject({ cached: 2, requested: 0 });
    expect(b.contexts.get('n2')).toMatch(/^Stops the extension/);
  });

  it('re-contextualises a node whose span changed and leaves the rest cached', async () => {
    fs.writeFileSync(file, ['class Ext {', '  Void onStart() { log.info("hi"); warm() }', '  Void onStop() {}', '}'].join('\n'));
    const withFile = nodes.map((n) => ({ ...n, filePath: file }));
    let askedIds: string[] = [];
    const chat: ContextChat = async (_s, user) => {
      askedIds = [...user.matchAll(/id (n\d):/g)].map((m) => m[1]);
      return { text: JSON.stringify({ n1: 'Starts the extension, warms caches, and spawns the actor pool at boot.' }), costUsd: null };
    };
    const r = await contextualizeNodes(275, withFile, { chat });
    expect(askedIds).toEqual(['n1']);
    expect(r.stats).toMatchObject({ cached: 1, requested: 1, written: 1 });
  });

  it('asks once more for the ids a reply left out', async () => {
    const f = path.join(dir, 'Retry.fan');
    fs.writeFileSync(f, 'class Retry { Void a() {} Void b() {} }');
    const asked: string[][] = [];
    const chat: ContextChat = async (_s, user) => {
      const ids = [...user.matchAll(/id (r\d):/g)].map((m) => m[1]);
      asked.push(ids);
      // First reply names only r1; the retry gets r2 alone and answers it.
      const body = ids.length === 2 ? { r1: 'Method a of Retry, a no-op placeholder used by the retry tests in this pod.' } : { r2: 'Method b of Retry, the second no-op placeholder the retry test asks for on its own.' };
      return { text: JSON.stringify(body), costUsd: null };
    };
    const r = await contextualizeNodes(277, [
      { id: 'r1', qualifiedName: 'x::Retry.a', nodeType: 'method', filePath: f, lineStart: 1, lineEnd: 1 },
      { id: 'r2', qualifiedName: 'x::Retry.b', nodeType: 'method', filePath: f, lineStart: 1, lineEnd: 1 },
    ], { chat });
    expect(asked).toEqual([['r1', 'r2'], ['r2']]);
    expect(r.stats).toMatchObject({ written: 2, failed: 0, requests: 2 });
  });

  it('a failed request leaves nodes without context and never throws', async () => {
    const other = path.join(dir, 'Other.fan');
    fs.writeFileSync(other, 'class Other {}');
    const r = await contextualizeNodes(276, [{ id: 'o1', qualifiedName: 'x::Other', nodeType: 'class', filePath: other, lineStart: 1, lineEnd: 1 }], {
      chat: async () => { throw new Error('every sidecar refused'); },
    });
    expect(r.contexts.size).toBe(0);
    expect(r.stats.failed).toBe(1);
  });

  it('nodeContentHash changes with the span and the signature', () => {
    const lines = ['a', 'b', 'c'];
    const h1 = nodeContentHash({ qualifiedName: 'q', signature: 's', lineStart: 1, lineEnd: 2 }, lines);
    const h2 = nodeContentHash({ qualifiedName: 'q', signature: 's', lineStart: 1, lineEnd: 2 }, ['a', 'B', 'c']);
    const h3 = nodeContentHash({ qualifiedName: 'q', signature: 't', lineStart: 1, lineEnd: 2 }, lines);
    expect(h1).not.toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toBe(nodeContentHash({ qualifiedName: 'q', signature: 's', lineStart: 1, lineEnd: 2 }, lines));
  });
});
