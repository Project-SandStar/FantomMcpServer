import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const calls: string[][] = [];
let model = 'm1';
jest.unstable_mockModule('../embedding/rerankRouter.js', () => ({
  rerankLocalFirst: async (_q: string, docs: string[]) => {
    calls.push(docs);
    return { scores: docs.map(d => d.length / 100), model, path: 'local', servedBy: 't', ms: 1 };
  },
}));
const { crossEncoderRerank, __clearRerankScoreCache } = await import('../embedding/crossEncoderReranker.js');

const hit = (id: string, qn: string) => ({ nodeId: id, name: qn, qualifiedName: qn, nodeType: 'method', filePath: 'f', lineStart: 1,
  semanticScore: 0.5, graphScore: 0, combinedScore: 0.5 }) as any;

describe('cross-encoder score cache', () => {
  beforeEach(() => { calls.length = 0; model = 'm1'; __clearRerankScoreCache(); });
  it('second identical rerank sends nothing; same order and scores', async () => {
    const hits = [hit('a', 'p::A'), hit('b', 'p::Bbbbbb'), hit('c', 'p::Cc')];
    const r1 = await crossEncoderRerank('q', hits, { enabled: true });
    const r2 = await crossEncoderRerank('q', hits, { enabled: true });
    expect(calls).toHaveLength(1);
    expect(r2.map((h: any) => [h.nodeId, h.crossEncoderScore])).toEqual(r1.map((h: any) => [h.nodeId, h.crossEncoderScore]));
  });
  it('only uncached documents are sent', async () => {
    await crossEncoderRerank('q', [hit('a', 'p::A')], { enabled: true });
    await crossEncoderRerank('q', [hit('a', 'p::A'), hit('d', 'p::D')], { enabled: true });
    expect(calls).toEqual([['p::A'], ['p::D']]);
  });
  it('another query does not reuse scores', async () => {
    await crossEncoderRerank('q1', [hit('a', 'p::A')], { enabled: true });
    await crossEncoderRerank('q2', [hit('a', 'p::A')], { enabled: true });
    expect(calls).toHaveLength(2);
  });
  it('model change: cached scores dropped, all re-scored by the new model', async () => {
    await crossEncoderRerank('q', [hit('a', 'p::A')], { enabled: true });
    model = 'm2';
    await crossEncoderRerank('q', [hit('a', 'p::A'), hit('d', 'p::D')], { enabled: true });
    expect(calls).toEqual([['p::A'], ['p::D'], ['p::A', 'p::D']]);
  });
});
