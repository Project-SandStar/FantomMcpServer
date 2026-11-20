import { describe, it, expect } from '@jest/globals';
import { lookupCard, formatLookup, listCardSummaries, readStatus, type LookupDeps } from '../knowledge/cardLookup.js';
import { handleKnowledgeCardTool } from '../knowledge/cardMcpTools.js';
import type { KnowledgeCard } from '../knowledge/cardStore.js';

function card(o: Partial<KnowledgeCard>): KnowledgeCard {
  return {
    rowId: 'r', nodeId: 'n', projectId: 1, kind: 'class', name: 'X', qualifiedName: 'p::X', filePath: 'src/X.fan',
    lineStart: 1, lineEnd: 9, text: 'X keeps the tuning for a connector. More text.', claims: [{ text: 'X is a class', file: 'src/X.fan', line: 1 }],
    links: [], sources: [{ file: 'src/X.fan', hash: 'h1', lineStart: 1, lineEnd: 9 }],
    writerModel: 'sidecar/ss-completion', checkerModel: 'sidecar/ss-completion', builtAt: '2026-11-20T10:00:00Z',
    confidence: 0.95, checkResult: 'pass', firstCheck: 'pass', attempts: 1, writerCostUsd: 0, checkerCostUsd: 0,
    status: 'fresh', embedModel: 'e', ...o,
  } as KnowledgeCard;
}

function deps(cards: KnowledgeCard[], hashes: Record<string, string | null> = {}): LookupDeps {
  return {
    cardsForProject: async () => cards,
    fileHash: f => (f in hashes ? hashes[f] : 'h1'),
    minConfidence: () => 0.8,
    savedWriter: () => 'sidecar/ss-completion',
  };
}

const tuning = card({ rowId: 'a', nodeId: 'a', name: 'ConnTuning', qualifiedName: 'hxConn::ConnTuning',
  links: [{ nodeId: 'b', name: 'ConnPoint.tuning', relation: 'caller' }, { nodeId: 'z', name: 'Etc.dictGet', relation: 'callee' }] });
const point = card({ rowId: 'b', nodeId: 'b', name: 'tuning', qualifiedName: 'hxConn::ConnPoint.tuning', kind: 'function', text: 'Returns the point tuning. Rest.' });

describe('knowledge card lookup', () => {
  it('finds a card by qualified name with neighbours, and shows source hashes', async () => {
    const r = await lookupCard(deps([tuning, point]), { projectId: 1, symbol: 'hxConn::ConnTuning' });
    expect(r.found).toBe(true);
    expect(r.card?.readStatus).toBe('fresh');
    expect(r.neighbours.map(n => [n.relation, n.name, n.summary])).toEqual([
      ['caller', 'hxConn::ConnPoint.tuning', 'Returns the point tuning.'],
      ['callee', 'Etc.dictGet', null],
    ]);
    expect(r.missingNeighbours).toEqual(['Etc.dictGet']);
    const text = formatLookup(r, 'hxConn::ConnTuning');
    expect(text).toContain('X keeps the tuning');
    expect(text).toContain('sha256=h1');
  });

  it('matches a plain name and asks to pick when several match', async () => {
    const other = card({ rowId: 'c', nodeId: 'c', name: 'ConnTuning', qualifiedName: 'other::ConnTuning' });
    expect((await lookupCard(deps([tuning]), { projectId: 1, symbol: 'ConnTuning' })).found).toBe(true);
    const r = await lookupCard(deps([tuning, other]), { projectId: 1, symbol: 'ConnTuning' });
    expect(r.found).toBe(false);
    expect(r.candidates?.map(c => c.qualifiedName).sort()).toEqual(['hxConn::ConnTuning', 'other::ConnTuning']);
  });

  it('marks a card stale when its source file changed, and does not show it as fact', async () => {
    const d = deps([tuning], { 'src/X.fan': 'h2' });
    expect(readStatus(tuning, d)).toBe('stale');
    const text = formatLookup(await lookupCard(d, { projectId: 1, symbol: 'hxConn::ConnTuning' }), 'x');
    expect(text).toContain('Not shown as fact: its source code changed');
    expect(text).not.toContain('X keeps the tuning');
  });

  it('flagged and low-confidence cards are not fact', () => {
    const d = deps([]);
    expect(readStatus(card({ status: 'flagged' }), d)).toBe('flagged');
    expect(readStatus(card({ confidence: 0.5 }), d)).toBe('low-confidence');
  });

  it('prefers the saved writer when a node has two cards', async () => {
    const paid = card({ rowId: 'p', nodeId: 'a', qualifiedName: 'hxConn::ConnTuning', writerModel: 'z-ai/glm', builtAt: '2026-11-21T00:00:00Z', text: 'GLM text.' });
    const r = await lookupCard(deps([paid, tuning]), { projectId: 1, symbol: 'hxConn::ConnTuning' });
    expect(r.card?.writerModel).toBe('sidecar/ss-completion');
  });

  it('lists cards with status counts and filters', async () => {
    const out = await listCardSummaries(deps([tuning, point, card({ rowId: 'f', nodeId: 'f', qualifiedName: 'p::F', status: 'flagged' })]), { projectId: 1 });
    expect(out.total).toBe(3);
    expect(out.byStatus).toEqual({ fresh: 2, stale: 0, flagged: 1, 'low-confidence': 0 });
    const flagged = await listCardSummaries(deps([tuning, card({ rowId: 'f', nodeId: 'f', qualifiedName: 'p::F', status: 'flagged' })]), { projectId: 1, status: 'flagged' });
    expect(flagged.rows.map(r => r.qualifiedName)).toEqual(['p::F']);
  });

  it('MCP handler: needs symbol or file, uses the default project, reports no card', async () => {
    const d = deps([tuning]);
    expect((await handleKnowledgeCardTool('getKnowledgeCard', {}, d, async () => 1)).isError).toBe(true);
    expect((await handleKnowledgeCardTool('getKnowledgeCard', { symbol: 'Nope' }, d, async () => 1)).content[0].text).toMatch(/No knowledge card/);
    expect((await handleKnowledgeCardTool('getKnowledgeCard', { symbol: 'x' }, d, async () => null)).isError).toBe(true);
    const list = await handleKnowledgeCardTool('listKnowledgeCards', { projectId: 1 }, d);
    expect(list.content[0].text).toContain('1 card(s) in project 1');
  });
});
