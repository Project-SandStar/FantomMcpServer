/**
 * The two Jev gates inside the RLM loop: plan coverage and evidence
 * sufficiency. Pure parts only — the facts computed in code that Jev is
 * given, and how an answer becomes a decision. Transport is covered by
 * jevGates.test.ts.
 */
import {
  identifiersNotInPlan,
  evidenceSymbolsAndFiles,
  toolForIdentifier,
  coverageFromScore,
  planDecisionFromAnswers,
  evidenceDecisionFromAnswers,
  PLAN_CHECK_QUESTIONS,
} from '../embedding/jevGates.js';

describe('PLAN_CHECK_QUESTIONS shape', () => {
  it('sends score criteria as a list (an object is a 422 from the API)', () => {
    const q = PLAN_CHECK_QUESTIONS.coverage as { type: string; criteria: unknown };
    expect(q.type).toBe('score');
    expect(Array.isArray(q.criteria)).toBe(true);
    expect((q.criteria as unknown[]).length).toBe(3);
  });
});

describe('identifiersNotInPlan', () => {
  it('names the identifiers the plan never searches for', () => {
    const q = 'How does ConnPoller.onStart schedule polls and where does pollMode come from?';
    expect(identifiersNotInPlan(q, ['poll schedule', 'ConnPoller'])).toEqual(['pollMode']);
  });
  it('accepts a leaf match for a dotted name', () => {
    expect(identifiersNotInPlan('what does Ext.onStart do', ['onStart'])).toEqual([]);
  });
  it('ignores plain English words', () => {
    expect(identifiersNotInPlan('where is the connector started', ['connector start'])).toEqual([]);
  });
});

describe('toolForIdentifier', () => {
  it('routes a symbol to search_symbols whatever the lookup says', () => {
    expect(toolForIdentifier('ConnPoller.onStart')).toBe('search_symbols');
    expect(toolForIdentifier('pollMode', () => true)).toBe('search_symbols');
    expect(toolForIdentifier('ph.lib')).toBe('search_symbols'); // a tag, not a file
  });
  it('routes an indexed file name to search_files and a generated one to search_code', () => {
    const indexed = (id: string) => id === 'ConnExt.fan';
    expect(toolForIdentifier('ConnExt.fan', indexed)).toBe('search_files');
    expect(toolForIdentifier('funcs.xeto', indexed)).toBe('search_code'); // convert4 writes it; only a literal in source
    expect(toolForIdentifier('doc.md', indexed)).toBe('search_code');
  });
  it('falls back to search_files for a file name when no lookup is given', () => {
    expect(toolForIdentifier('funcs.xeto')).toBe('search_files');
  });
});

describe('evidenceSymbolsAndFiles', () => {
  it('reads the `name (type) path:line` header of each block', () => {
    const ev =
      'hxConn::ConnPoller.onStart (method) /src/ext/hxConn/fan/ConnPoller.fan:24\n  Void onStart() { ... }\n\n' +
      'hxConn::ConnExt.onStart (method) /src/ext/hxConn/fan/ConnExt.fan:102\n  body\n\n' +
      'not a hit header\nstuff';
    const { symbols, files } = evidenceSymbolsAndFiles(ev);
    expect(symbols).toEqual(['hxConn::ConnPoller.onStart', 'hxConn::ConnExt.onStart']);
    expect(files).toEqual(['/src/ext/hxConn/fan/ConnPoller.fan', '/src/ext/hxConn/fan/ConnExt.fan']);
  });
  it('is empty for empty evidence', () => {
    expect(evidenceSymbolsAndFiles('')).toEqual({ symbols: [], files: [] });
  });
});

describe('coverageFromScore', () => {
  it('maps a best-first criteria index to 0–1', () => {
    expect(coverageFromScore(0, 3)).toBe(1);
    expect(coverageFromScore(1, 3)).toBe(0.5);
    expect(coverageFromScore(2, 3)).toBe(0);
    expect(coverageFromScore(1.04, 3)).toBeCloseTo(0.48, 2); // the API returns fractional indexes
    expect(coverageFromScore(9, 3)).toBe(0);                 // clamped
  });
});

describe('planDecisionFromAnswers', () => {
  it('is decisive at or above minConfidence and carries the missing kind', () => {
    // score is an INDEX into the 3-item criteria list: 1 = the middle criterion = 0.5 coverage
    const d = planDecisionFromAnswers(
      { coverage: { type: 'score', score: 1, confidence: 0.9 }, missing: { type: 'choice', choice: 'identifier', confidence: 0.8, probabilities: {} } },
      ['pollMode'], 0.7, 'jev-1', 300,
    );
    expect(d).toMatchObject({ coverage: 0.5, missing: 'identifier', identifiersNotSearched: ['pollMode'], decisive: true });
  });
  it('is not decisive below minConfidence and treats an unknown missing kind as none', () => {
    const d = planDecisionFromAnswers(
      { coverage: { type: 'score', score: 0, confidence: 0.5 }, missing: { type: 'choice', choice: 'weird', confidence: 0.5, probabilities: {} } },
      [], 0.7, 'jev-1', 300,
    );
    expect(d).toMatchObject({ coverage: 1, missing: 'none', decisive: false });
  });
  it('rejects an answer without a numeric score', () => {
    expect(planDecisionFromAnswers({ coverage: { type: 'score', confidence: 0.9 } }, [], 0.7, 'jev-1', 1)).toBeNull();
  });
});

describe('evidenceDecisionFromAnswers', () => {
  it('reads the noul yes-probability and is decisive when far from 0.5', () => {
    const d = evidenceDecisionFromAnswers({ sufficient: { type: 'noul', noul: 0.08 } }, ['pollMode'], 0.7, 'jev-1', 200);
    expect(d).toMatchObject({ sufficient: false, probability: 0.08, decisive: true, namedSymbolsMissing: ['pollMode'] });
  });
  it('is not decisive near 0.5', () => {
    const d = evidenceDecisionFromAnswers({ sufficient: { type: 'noul', noul: 0.6 } }, [], 0.7, 'jev-1', 200);
    expect(d).toMatchObject({ sufficient: true, decisive: false });
  });
  it('rejects a non-noul answer', () => {
    expect(evidenceDecisionFromAnswers({ sufficient: { type: 'choice', choice: 'yes' } }, [], 0.7, 'jev-1', 1)).toBeNull();
  });
});
