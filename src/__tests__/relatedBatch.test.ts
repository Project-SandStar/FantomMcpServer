import { describe, it, expect } from '@jest/globals';
import { LadybugQueryManager } from '../graph/ladybugQueryManager.js';

/** A query manager whose Cypher reads are answered from fixed edge lists. */
function fakeManager(edges: Array<{ from: string; to: string; type: string }>, names: Record<string, string>) {
  const m = new LadybugQueryManager(1);
  const calls: string[] = [];
  (m as unknown as { q: (c: string) => Promise<unknown[]> }).q = async (cypher: string) => {
    calls.push(cypher);
    const ids = [...cypher.matchAll(/'([^']+)'/g)].map(x => x[1]);
    if (cypher.includes('t.id IN')) {
      return edges
        .filter(e => ids.includes(e.to) && (e.type === 'calls' || e.type === 'uses'))
        .map(e => ({ tid: e.to, id: e.from, name: names[e.from] }));
    }
    return edges
      .filter(e => ids.includes(e.from) && e.type === 'calls')
      .map(e => ({ sid: e.from, id: e.to, name: names[e.to] }));
  };
  return { m, calls };
}

describe('LadybugQueryManager.getRelatedBatch', () => {
  const names: Record<string, string> = { a: 'alpha', b: 'beta', c: 'gamma', d: 'delta', e: 'eps', x: 'x' };
  const edges = [
    { from: 'a', to: 'x', type: 'calls' },
    { from: 'b', to: 'x', type: 'uses' },
    { from: 'c', to: 'x', type: 'calls' },
    { from: 'd', to: 'x', type: 'calls' },
    { from: 'd', to: 'x', type: 'calls' },      // duplicate edge → one caller
    { from: 'e', to: 'x', type: 'contains' },   // not a caller
    { from: 'x', to: 'b', type: 'calls' },
    { from: 'x', to: 'a', type: 'uses' },       // not a callee (calls only)
  ];

  it('two queries for many nodes; callers then callees, deduped, name-sorted, cut to limit', async () => {
    const { m, calls } = fakeManager(edges, names);
    const out = await m.getRelatedBatch(['x', 'a', 'x'], 3);
    expect(calls).toHaveLength(2);
    expect(out.get('x')).toEqual([
      { id: 'a', name: 'alpha', relationship: 'caller' },
      { id: 'b', name: 'beta', relationship: 'caller' },
      { id: 'd', name: 'delta', relationship: 'caller' },
      { id: 'b', name: 'beta', relationship: 'callee' },
    ]);
    // x→a is `uses`: x is a caller of a (callers take uses), not a's callee.
    expect(out.get('a')).toEqual([
      { id: 'x', name: 'x', relationship: 'caller' },
      { id: 'x', name: 'x', relationship: 'callee' },
    ]);
  });

  it('no ids → no queries', async () => {
    const { m, calls } = fakeManager(edges, names);
    expect((await m.getRelatedBatch([])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
