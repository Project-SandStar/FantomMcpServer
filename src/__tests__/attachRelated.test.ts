import { describe, it, expect } from '@jest/globals';
import { SemanticSearchService, type SemanticSearchResult } from '../embedding/semanticSearchService.js';

type Rel = Array<{ id: string; name: string; relationship: 'caller' | 'callee' }>;

/** A service with no constructor side effects and a stubbed per-project graph. */
function svcWith(lookup: (pid: number, ids: string[]) => Promise<Map<string, Rel>>) {
  const svc = Object.create(SemanticSearchService.prototype) as SemanticSearchService;
  const calls: Array<{ pid: number; ids: string[] }> = [];
  (svc as unknown as { graph: (pid: number) => unknown }).graph = (pid: number) => ({
    getRelatedBatch: (ids: string[]) => { calls.push({ pid, ids }); return lookup(pid, ids); },
  });
  const attach = (svc as unknown as {
    attachRelated: (h: SemanticSearchResult[], o: unknown) => Promise<{ skipped: number; queries: number }>;
  }).attachRelated.bind(svc);
  return { attach, calls };
}

const hit = (nodeId: string): SemanticSearchResult =>
  ({ nodeId, name: nodeId, qualifiedName: nodeId, nodeType: 'method', filePath: 'f', lineStart: 1, semanticScore: 0, graphScore: 0, combinedScore: 0 });

const noDeadline = async <T,>(work: Promise<T>) => ({ v: await work, cut: false });

describe('SemanticSearchService.attachRelated', () => {
  const pids: Record<string, number> = { a: 1, b: 1, c: 2, s: 1 };
  const pidOf = (id: string) => pids[id];

  it('one batch per project; skips synthetic hits and hits with no project', async () => {
    const { attach, calls } = svcWith(async (_pid, ids) =>
      new Map(ids.map(id => [id, [{ id: 'z', name: 'z', relationship: 'caller' as const }]])));
    const hits = [hit('a'), hit('b'), hit('c'), hit('s'), hit('nopid')];
    const r = await attach(hits, { pidOf, skip: new Set(['s']), untilGraphDeadline: noDeadline });
    expect(calls.map(c => c.pid).sort()).toEqual([1, 2]);
    expect(calls.find(c => c.pid === 1)!.ids).toEqual(['a', 'b']);
    expect(r).toEqual({ skipped: 0, queries: 4 });
    expect(hits[0].relatedNodes).toHaveLength(1);
    expect(hits[3].relatedNodes).toBeUndefined();
    expect(hits[4].relatedNodes).toBeUndefined();
  });

  it('deadline already past: no graph call, hits counted as skipped', async () => {
    const { attach, calls } = svcWith(async () => new Map());
    const r = await attach([hit('a'), hit('c')], { pidOf, skip: new Set(), graphDeadlineAt: Date.now() - 1, untilGraphDeadline: noDeadline });
    expect(calls).toHaveLength(0);
    expect(r.skipped).toBe(2);
  });

  it('a failed lookup skips that project only and does not throw', async () => {
    const { attach } = svcWith(async (pid, ids) => {
      if (pid === 2) throw new Error('buffer pool full');
      return new Map(ids.map(id => [id, [] as Rel]));
    });
    const hits = [hit('a'), hit('c')];
    const r = await attach(hits, { pidOf, skip: new Set(), untilGraphDeadline: noDeadline });
    expect(r.skipped).toBe(1);
    expect(hits[0].relatedNodes).toEqual([]);
    expect(hits[1].relatedNodes).toBeUndefined();
  });

  it('a lookup cut by the deadline counts its hits as skipped', async () => {
    const { attach } = svcWith(async () => new Map());
    const cut = async <T,>(work: Promise<T>, fallback: T) => { work.catch(() => undefined); return { v: fallback, cut: true }; };
    const r = await attach([hit('a'), hit('b')], { pidOf, skip: new Set(), untilGraphDeadline: cut });
    expect(r.skipped).toBe(2);
  });
});

describe('SemanticSearchService.enrichResults (findSimilar path)', () => {
  it('one metrics batch + one related batch for all hits; missing nodes dropped', async () => {
    const svc = Object.create(SemanticSearchService.prototype) as SemanticSearchService;
    const calls: string[] = [];
    const s = svc as unknown as Record<string, unknown>;
    s.fetchNodesByIds = async (ids: string[]) => ids.filter(i => i !== 'gone').map(id =>
      ({ id, name: id, qualifiedName: id, nodeType: 'method', filePath: 'f', lineStart: 1, signature: null, documentation: null }));
    s.graph = () => ({
      getMetricsBatch: async (ids: string[]) => { calls.push('metrics:' + ids.join(',')); return new Map(ids.map(id => [id, { callerCount: id === 'a' ? 5 : 0, calleeCount: 1 }])); },
      getRelatedBatch: async (ids: string[]) => { calls.push('related:' + ids.join(',')); return new Map(ids.map(id => [id, [{ id: 'z', name: 'z', relationship: 'caller' }]])); },
    });
    const enrich = (s.enrichResults as (v: unknown, o: unknown) => Promise<SemanticSearchResult[]>).bind(svc);
    const out = await enrich([{ nodeId: 'a', score: 0.9 }, { nodeId: 'gone', score: 0.8 }, { nodeId: 'b', score: 0.7 }], { projectId: 7, includeGraphContext: true });
    expect(calls).toEqual(['metrics:a,b', 'related:a,b']);
    expect(out.map(r => r.nodeId)).toEqual(['a', 'b']);
    expect(out[0].callerCount).toBe(5);
    expect(out[1].relatedNodes).toHaveLength(1);
  });
});
