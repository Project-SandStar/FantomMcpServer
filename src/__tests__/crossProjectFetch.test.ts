import { describe, it, expect } from '@jest/globals';
import { SemanticSearchService } from '../embedding/semanticSearchService.js';

/** search() over 3 projects with every I/O dependency stubbed. */
function svc() {
  const s = Object.create(SemanticSearchService.prototype) as SemanticSearchService;
  const r = s as unknown as Record<string, unknown>;
  const log: string[] = [];
  r.queryEncoder = async () => ({ initialize: async () => undefined, getModelName: () => 'm' });
  r.embedQueryCached = async () => [0.1, 0.2];
  const rows = [1, 2, 3].flatMap(pid => [0, 1].map(k => ({
    nodeId: `n${pid}${k}`, score: 0.9 - pid / 10 - k / 100, distance: 0.1, projectId: pid,
    qualifiedName: `p::N${pid}${k}`, filePath: `/p${pid}.fan`, nodeType: 'method', lineStart: 1,
  })));
  r.vectorStore = { search: async () => rows };
  // n21 is a stale vector id: the graph only knows it as g21 (same name + file).
  r.fetchNodesByIds = async (ids: string[], pid?: number) => { log.push(`fetch:${pid}`); return ids.filter(id => id !== 'n21').map(id =>
    ({ id, name: id, qualifiedName: id, nodeType: 'method', filePath: 'f', lineStart: 1, signature: null, documentation: null })); };
  r.fetchNodesByQn = async (qns: string[], pid?: number) => { log.push(`qn:${pid}:${qns.join(',')}`);
    return qns.includes('p::N21') ? [{ id: 'g21', name: 'N21', qualifiedName: 'p::N21', nodeType: 'method', filePath: '/p2.fan', lineStart: 1, signature: null, documentation: null }] : []; };
  r.graph = (pid?: number) => ({
    getMetricsBatch: async (ids: string[]) => { log.push(`metrics:${pid}:${ids.length}`);
      return new Map(ids.map(id => [id, { nodeId: id, callerCount: 2, calleeCount: 1, incomingEdgeCount: 2, outgoingEdgeCount: 1, containsCount: 0, usedByCount: 0, extendsCount: 0, implementsCount: 0, depth: 0 }])); },
    getRelatedBatch: async () => new Map(),
  });
  r.maybeRerank = async (_q: string, hits: unknown[]) => hits;
  r.resultCacheKey = async () => undefined;
  return { s, log };
}

describe('cross-project search: fetch and metrics in one visit per project', () => {
  it('one fetch + one metrics batch per project, no second metrics pass', async () => {
    const { s, log } = svc();
    const out = await s.search('q', { hybrid: false, includeGraphContext: false, limit: 10, minScore: 0 });
    expect(out).toHaveLength(6);
    expect(out.every(h => h.callerCount === 2)).toBe(true);
    expect(log.filter(l => l.startsWith('fetch:')).sort()).toEqual(['fetch:1', 'fetch:2', 'fetch:3']);
    expect(log.filter(l => l.startsWith('metrics:')).sort()).toEqual(['metrics:1:2', 'metrics:2:2', 'metrics:3:2']);
    // The stale row was re-joined in the same visit: one by-name lookup, then its metrics in that batch.
    expect(log.filter(l => l.startsWith('qn:'))).toEqual(['qn:2:p::N21']);
    expect(out.map(h => h.nodeId)).toContain('g21');
    expect(log.indexOf('qn:2:p::N21')).toBeLessThan(log.indexOf('metrics:2:2'));
  });
});

describe('whole-result cache', () => {
  it('second identical search is served from the cache; a new table version misses', async () => {
    const { s, log } = svc();
    let version = 1;
    (s as unknown as Record<string, unknown>).resultCacheKey = async (q: string, o: unknown) => JSON.stringify([q, o, version]);
    const opts = { hybrid: false, includeGraphContext: false, limit: 10, minScore: 0 };
    const a = await s.search('cache me', opts);
    const n = log.length;
    const b = await s.search('cache me', opts);
    expect(log.length).toBe(n);
    expect(b).toEqual(a);
    b[0].name = 'mutated';
    expect((await s.search('cache me', opts))[0].name).not.toBe('mutated');
    version = 2;
    await s.search('cache me', opts);
    expect(log.length).toBeGreaterThan(n);
  });
  it('a capped search is not stored', async () => {
    const { s, log } = svc();
    const r = s as unknown as Record<string, unknown>;
    r.resultCacheKey = async () => 'k-capped';
    const real = r.searchUncached as (q: string, o: { onGraphCapped?: (i: unknown) => void }) => Promise<unknown>;
    r.searchUncached = async function (this: unknown, q: string, o: { onGraphCapped?: (i: unknown) => void }) {
      const out = await real.call(this, q, o); o.onGraphCapped?.({ afterMs: 1, skippedRelated: 1, metricsCut: false }); return out;
    };
    await s.search('capped', { hybrid: false, includeGraphContext: false, minScore: 0 });
    const n = log.length;
    await s.search('capped', { hybrid: false, includeGraphContext: false, minScore: 0 });
    expect(log.length).toBeGreaterThan(n);
  });
});
