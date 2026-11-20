import { describe, it, expect } from '@jest/globals';
import { cardMark, cardFanIn, filterCards } from '../admin/knowledgeCardViewerRoutes.js';
import type { KnowledgeCard } from '../knowledge/cardStore.js';

function card(p: Partial<KnowledgeCard>): KnowledgeCard {
  return {
    rowId: 'r', nodeId: 'n', projectId: 1, kind: 'function', name: 'f', qualifiedName: 'a::f', filePath: 'a.fan',
    lineStart: 1, lineEnd: 10, text: 'function a::f\nDoes things.', claims: [], links: [], sources: [],
    writerModel: 'openai/gpt-oss-20b', checkerModel: 'x/y', builtAt: '2026-11-01T00:00:00Z', confidence: 0.9,
    checkResult: 'pass', firstCheck: 'pass', attempts: 1, writerCostUsd: 0.001, checkerCostUsd: 0.001,
    status: 'fresh', embedModel: '', ...p,
  };
}

describe('knowledge card viewer helpers', () => {
  it('maps status and confidence to the four marks', () => {
    expect(cardMark({ status: 'fresh', confidence: 0.9 }, 0.8)).toBe('good');
    expect(cardMark({ status: 'fresh', confidence: 0.5 }, 0.8)).toBe('low');
    expect(cardMark({ status: 'stale', confidence: 0.9 }, 0.8)).toBe('stale');
    expect(cardMark({ status: 'check', confidence: 0.9 }, 0.8)).toBe('stale');
    expect(cardMark({ status: 'flagged', confidence: 0.9 }, 0.8)).toBe('failed');
  });

  it('fan-in counts caller links; project and pod cards sort first', () => {
    const links = [
      { nodeId: 'a', name: 'a', relation: 'caller' as const },
      { nodeId: 'b', name: 'b', relation: 'callee' as const },
      { nodeId: 'c', name: 'c', relation: 'caller' as const },
    ];
    expect(cardFanIn({ kind: 'function', links })).toBe(2);
    expect(cardFanIn({ kind: 'project', links: [] })).toBeGreaterThan(cardFanIn({ kind: 'pod', links: [] }));
  });

  it('filters, searches, sorts and pages; totals cover all cards', () => {
    const cards = [
      card({ rowId: '1', confidence: 0.95, builtAt: '2026-11-01', links: [{ nodeId: 'x', name: 'x', relation: 'caller' }] }),
      card({ rowId: '2', kind: 'class', confidence: 0.6, builtAt: '2026-11-03', text: 'class Poller\nPolls points.' }),
      card({ rowId: '3', status: 'flagged', confidence: 0.2, builtAt: '2026-11-02' }),
    ];
    const all = filterCards(cards, {}, 0.8);
    expect(all.totals).toMatchObject({ cards: 3, good: 1, low: 1, failed: 1, fresh: 2, flagged: 1 });
    expect(all.rows[0].rowId).toBe('1');
    expect(all.rows[0]).not.toHaveProperty('claims_json');
    expect(filterCards(cards, { sort: 'newest' }, 0.8).rows.map(r => r.rowId)).toEqual(['2', '3', '1']);
    expect(filterCards(cards, { sort: 'confidence' }, 0.8).rows[2].rowId).toBe('3');
    expect(filterCards(cards, { kind: 'class' }, 0.8).total).toBe(1);
    expect(filterCards(cards, { mark: 'failed' }, 0.8).rows[0].rowId).toBe('3');
    expect(filterCards(cards, { q: 'polls' }, 0.8).rows.map(r => r.rowId)).toEqual(['2']);
    const page = filterCards(cards, { offset: 1, limit: 1 }, 0.8);
    expect(page.total).toBe(3);
    expect(page.rows.length).toBe(1);
  });
});
