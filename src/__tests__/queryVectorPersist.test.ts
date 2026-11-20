import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { SemanticSearchService, QUERY_VECTOR_TEXT_VERSION, warmSearchAtBoot, __resetSavedQueryVectors } from '../embedding/semanticSearchService.js';
import { __setEmbedCacheForTest, type EmbedCache } from '../embedding/embedCache.js';

function fakeCache() {
  const rows = new Map<string, Float32Array>(); // `${model}|${version}|${hash}`
  const lookup = jest.fn(async () => new Map());
  const c = {
    lookup,
    store: async (m: string, v: number, es: Array<{ hash: string; vector: Float32Array }>) => { for (const e of es) rows.set(`${m}|${v}|${e.hash}`, e.vector); return es.length; },
    loadVersion: async (v: number) => {
      const out = new Map<string, Map<string, Float32Array>>();
      for (const [k, vec] of rows) { const [m, ver, h] = k.split('|'); if (Number(ver) !== v) continue; const mm = out.get(m) ?? new Map(); mm.set(h, vec); out.set(m, mm); }
      return out;
    },
  };
  return { c: c as unknown as EmbedCache, rows, lookup };
}
const call = (s: SemanticSearchService, p: unknown, t: string) =>
  ((s as unknown as Record<string, (p: unknown, t: string) => Promise<Float32Array>>).embedQueryCached).call(s, p, t);
const mk = () => { const s = Object.create(SemanticSearchService.prototype) as SemanticSearchService;
  const r = s as unknown as Record<string, unknown>; r.queryEmbedCache = new Map(); r.queryEmbedInFlight = new Map(); return s; };

describe('saved query vectors', () => {
  afterEach(() => { __setEmbedCacheForTest(null); __resetSavedQueryVectors(); });
  it('after a restart, the boot load serves the vector from memory: no embed, no table lookup', async () => {
    const { c, rows, lookup } = fakeCache();
    __setEmbedCacheForTest(c);
    let embeds = 0;
    const provider = { getModelName: () => 'qm', embed: async () => { embeds++; return new Float32Array([1, 2, 3]); } };
    expect(Array.from(await call(mk(), provider, 'parse a zinc grid'))).toEqual([1, 2, 3]);
    await new Promise(r => setTimeout(r, 0));
    expect([...rows.keys()][0]).toContain(`qm|${QUERY_VECTOR_TEXT_VERSION}|`);
    __resetSavedQueryVectors(); // "restart": memory gone, table kept
    const w = await warmSearchAtBoot();
    expect(w.vectors).toBe(1);
    expect(Array.from(await call(mk(), provider, 'parse a zinc grid'))).toEqual([1, 2, 3]);
    expect(embeds).toBe(1);
    expect(lookup).not.toHaveBeenCalled();
  });
  it('not loaded yet: embeds, never reads the table on the query path', async () => {
    const { c, lookup } = fakeCache();
    __setEmbedCacheForTest(c);
    let embeds = 0;
    const provider = { getModelName: () => 'qm', embed: async () => { embeds++; return new Float32Array([4]); } };
    await call(mk(), provider, 'q');
    expect(embeds).toBe(1);
    expect(lookup).not.toHaveBeenCalled();
  });
});

import { startSearchWarmup, __resetSearchWarmup } from '../embedding/semanticSearchService.js';
describe('startSearchWarmup', () => {
  afterEach(() => __resetSearchWarmup());
  const r = (encoderOk: boolean, vectorsOk = true) => ({ encoderMs: 1, vectors: 0, loadMs: 1, encoderOk, vectorsOk });
  it('retries until the encoder is ready, then logs once', async () => {
    const seq = [r(false), r(false), r(true)]; let n = 0; const logs: string[] = [];
    await startSearchWarmup(m => logs.push(m), { attempts: 5, delayMs: 1, warm: async () => seq[n++] });
    expect(n).toBe(3);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('attempt 3');
  });
  it('gives up after the attempt budget without throwing', async () => {
    let n = 0; const logs: string[] = [];
    await startSearchWarmup(m => logs.push(m), { attempts: 2, delayMs: 1, warm: async () => { n++; return r(false, false); } });
    expect(n).toBe(2);
    expect(logs[0]).toContain('incomplete');
  });
  it('single-flight; a call after success does nothing', async () => {
    let n = 0; const warm = async () => { n++; await new Promise(res => setTimeout(res, 5)); return r(true); };
    await Promise.all([startSearchWarmup(() => undefined, { warm }), startSearchWarmup(() => undefined, { warm })]);
    await startSearchWarmup(() => undefined, { warm });
    expect(n).toBe(1);
  });
});
