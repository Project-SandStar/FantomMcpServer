/**
 * Embedding-reply parsing: small bodies parse inline, big ones (> 256 KB) on a
 * worker thread so a 100 x 2560d reply does not stall the event loop. If the
 * worker cannot start (e.g. under a test runner), parsing falls back inline.
 * Either way the floats must be identical.
 */
import { afterAll, describe, it, expect } from '@jest/globals';
import {
  parseEmbeddings, parsePoolStats, INLINE_PARSE_MAX_BYTES, __stopParseWorkerForTest,
} from '../openrouter/parsePool.js';

const enc = (o: unknown): ArrayBuffer => new TextEncoder().encode(JSON.stringify(o)).buffer as ArrayBuffer;

function body(n: number, dims: number, shuffle = false) {
  const data = Array.from({ length: n }, (_, i) => ({
    index: i,
    embedding: Array.from({ length: dims }, (_, j) => Math.sin(i * 7919 + j) * 0.123456789),
  }));
  if (shuffle) data.reverse();
  return { data, model: 'qwen/qwen3-embedding-4b', usage: { total_tokens: n * 3, cost: 0.0002 } };
}

afterAll(async () => { await __stopParseWorkerForTest(); });

describe('parseEmbeddings', () => {
  it('parses a small body inline', async () => {
    const before = parsePoolStats().inline;
    const out = await parseEmbeddings(enc(body(2, 4)));
    expect(parsePoolStats().inline).toBe(before + 1);
    expect(out.vectors).toHaveLength(2);
    expect(out.vectors[0]).toBeInstanceOf(Float32Array);
    expect(Array.from(out.vectors[1])).toEqual(Array.from(Float32Array.from(body(2, 4).data[1].embedding)));
    expect(out.model).toBe('qwen/qwen3-embedding-4b');
    expect(out.totalTokens).toBe(6);
    expect(out.cost).toBe(0.0002);
    expect(out.error).toBeUndefined();
  });

  it('sorts rows by index', async () => {
    const out = await parseEmbeddings(enc({ data: [
      { index: 2, embedding: [2] }, { index: 0, embedding: [0] }, { index: 1, embedding: [1] },
    ] }));
    expect(out.vectors.map(v => v[0])).toEqual([0, 1, 2]);
  });

  it('returns the error message of an error body', async () => {
    const a = await parseEmbeddings(enc({ error: { message: 'No endpoints found matching your data policy' } }));
    expect(a.vectors).toEqual([]);
    expect(a.error).toBe('No endpoints found matching your data policy');
    const b = await parseEmbeddings(enc({ error: 'plain string error' }));
    expect(b.error).toBe('plain string error');
    const c = await parseEmbeddings(enc({ nothing: true }));
    expect(c.error).toBe('reply has no data array');
  });

  it('rejects a body that is not JSON', async () => {
    await expect(parseEmbeddings(new TextEncoder().encode('<html>502</html>').buffer as ArrayBuffer)).rejects.toThrow();
  });

  it('parses a big body (> 256 KB) to the same floats as inline, in index order', async () => {
    const big = body(40, 1024, true);
    const inline = await parseEmbeddings(enc(big), { forceInline: true });
    const bytes = enc(big);
    expect(bytes.byteLength).toBeGreaterThan(INLINE_PARSE_MAX_BYTES);
    const s0 = parsePoolStats();
    const out = await parseEmbeddings(bytes);
    const s1 = parsePoolStats();
    // Worker thread or inline fallback: exactly one of them took it.
    expect((s1.offThread - s0.offThread) + (s1.inline - s0.inline)).toBe(1);
    expect(out.vectors).toHaveLength(40);
    for (let i = 0; i < 40; i++) {
      // Realm-safe: a vector posted back from the worker is a Float32Array of
      // another realm under jest's VM, so instanceof does not hold there.
      expect(Object.prototype.toString.call(out.vectors[i])).toBe('[object Float32Array]');
      expect(Array.from(out.vectors[i])).toEqual(Array.from(inline.vectors[i]));
      expect(out.vectors[i][0]).toBeCloseTo(Math.sin(i * 7919) * 0.123456789, 6);
    }
    expect(out.totalTokens).toBe(120);
  });

  it('reports a worker-side error body the same way', async () => {
    const pad = 'x'.repeat(INLINE_PARSE_MAX_BYTES + 10);
    const out = await parseEmbeddings(enc({ error: { message: 'too big' }, pad }));
    expect(out.error).toBe('too big');
    expect(out.vectors).toEqual([]);
  });
});
