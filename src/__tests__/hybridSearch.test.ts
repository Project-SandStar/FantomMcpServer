import { describe, it, expect } from '@jest/globals';
import { rrfFuse, countChangedPositions, keywordQueryVariants, RRF_K } from '../embedding/hybridSearch.js';

describe('hybridSearch.keywordQueryVariants', () => {
  it('"retejs" yields the raw token first, then "rete" (suffix stripped)', () => {
    const v = keywordQueryVariants('retejs');
    expect(v[0]).toBe('retejs');
    expect(v[1]).toBe('rete');
    expect(v.length).toBeLessThanOrEqual(6);
  });

  it('splits kebab/camel identifiers into words', () => {
    expect(keywordQueryVariants('vue-router')).toContain('vue router');
    expect(keywordQueryVariants('SedonaStateService')).toContain('Sedona State Service');
  });

  it('multi-word queries do not get prefix trimming', () => {
    const v = keywordQueryVariants('load from sax');
    expect(v).toEqual(['load from sax']);
  });

  it('empty query yields no variants', () => {
    expect(keywordQueryVariants('   ')).toEqual([]);
  });
});

type Hit = { id: string };
const key = (h: Hit) => h.id;
const hits = (...ids: string[]): Hit[] => ids.map(id => ({ id }));

describe('hybridSearch.rrfFuse', () => {
  it('uses k=60 and sums weight/(k+rank) per list', () => {
    expect(RRF_K).toBe(60);
    const fused = rrfFuse<Hit>([
      { source: 'vector', weight: 1.0, items: hits('a', 'b'), key },
      { source: 'keyword', weight: 0.7, items: hits('b', 'c'), key },
    ]);
    const byKey = Object.fromEntries(fused.map(e => [e.key, e]));
    expect(byKey.a.score).toBeCloseTo(1.0 / 61, 10);
    expect(byKey.b.score).toBeCloseTo(1.0 / 62 + 0.7 / 61, 10);
    expect(byKey.c.score).toBeCloseTo(0.7 / 62, 10);
  });

  it('an item present in both lists outranks single-list items', () => {
    const fused = rrfFuse<Hit>([
      { source: 'vector', weight: 1.0, items: hits('v1', 'both', 'v3'), key },
      { source: 'keyword', weight: 0.7, items: hits('k1', 'both'), key },
    ]);
    expect(fused[0].key).toBe('both');
    expect(fused[0].sources).toEqual(['both']);
    expect(fused[0].ranks).toEqual({ vector: 2, keyword: 2 });
  });

  it('tags sources per result and keeps the vector item as representative', () => {
    const vec = [{ id: 'x', from: 'vector' }];
    const kw = [{ id: 'x', from: 'keyword' }, { id: 'y', from: 'keyword' }];
    const fused = rrfFuse<{ id: string; from: string }>([
      { source: 'vector', weight: 1, items: vec, key: h => h.id },
      { source: 'keyword', weight: 1, items: kw, key: h => h.id },
    ]);
    const x = fused.find(e => e.key === 'x')!;
    const y = fused.find(e => e.key === 'y')!;
    expect(x.item.from).toBe('vector');
    expect(x.sources).toEqual(['both']);
    expect(y.sources).toEqual(['keyword']);
  });

  it('respects weights: keyword weight 0 makes keyword-only hits sink', () => {
    const fused = rrfFuse<Hit>([
      { source: 'vector', weight: 1.0, items: hits('v1', 'v2'), key },
      { source: 'keyword', weight: 0.0, items: hits('k1'), key },
    ]);
    expect(fused.map(e => e.key)).toEqual(['v1', 'v2', 'k1']);
    expect(fused[2].score).toBe(0);
  });

  it('normalizes so the best attainable score is 1', () => {
    const fused = rrfFuse<Hit>([
      { source: 'vector', weight: 1.0, items: hits('a'), key },
      { source: 'keyword', weight: 0.7, items: hits('a'), key },
    ]);
    expect(fused[0].normalized).toBeCloseTo(1, 10);
    const single = rrfFuse<Hit>([
      { source: 'vector', weight: 1.0, items: hits('a'), key },
      { source: 'keyword', weight: 0.7, items: [], key },
    ]);
    expect(single[0].normalized).toBeCloseTo(1, 10); // empty list contributes nothing to the max
  });

  it('dedupes duplicate keys inside one list (first rank wins)', () => {
    const fused = rrfFuse<Hit>([
      { source: 'vector', weight: 1.0, items: hits('a', 'a', 'b'), key },
    ]);
    expect(fused.map(e => e.key)).toEqual(['a', 'b']);
    expect(fused[0].score).toBeCloseTo(1 / 61, 10);
  });
});

describe('hybridSearch.countChangedPositions', () => {
  it('counts positions whose key differs within the first n', () => {
    const before = hits('a', 'b', 'c', 'd');
    const after = hits('b', 'a', 'c');
    expect(countChangedPositions(before, after, key, 3)).toBe(2);
    expect(countChangedPositions(before, after, key, 4)).toBe(3); // 'd' vs undefined
    expect(countChangedPositions(before, before, key, 4)).toBe(0);
  });
});
