/**
 * Jev routing gate: request shape, answer parsing, and the advisory contract
 * (no key / failure / low confidence → null or not decisive). Transport is
 * injected; nothing here reaches the network.
 */
import { decisionFromAnswers, decideAskRoute, ASK_ROUTE_QUESTIONS, namedSymbolsInHits } from '../embedding/jevGates.js';

describe('namedSymbolsInHits', () => {
  it('finds question identifiers among hit leaves', () => {
    expect(namedSymbolsInHits('Where is versionGroupForProject defined?', ['versionGroup::versionGroupForProject', 'versionGroup::parseVersionSelector']))
      .toEqual(['versionGroupForProject']);
  });
  it('matches dotted names and is case-insensitive', () => {
    expect(namedSymbolsInHits('what does Ext.onStart do', ['hx::Ext.onStart'])).toEqual(['Ext.onStart']);
    expect(namedSymbolsInHits('parseversionselector?', ['versionGroup::parseVersionSelector'])).toEqual(['parseversionselector']);
  });
  it('is empty when nothing named is in the hits', () => {
    expect(namedSymbolsInHits('why does the ask degrade to citations only', ['answerSynthesis::answerCodeQuestion'])).toEqual([]);
  });
});
import { jevAsk, type JevFetch } from '../embedding/providers/jevClient.js';

const fakeFetch = (status: number, body: unknown, capture?: (init: { body: string }) => void): JevFetch =>
  async (_url, init) => { capture?.(init); return { ok: status >= 200 && status < 300, status, json: async () => body }; };

describe('decisionFromAnswers', () => {
  it('reads choice + noul into a decision', () => {
    const d = decisionFromAnswers({
      route: { type: 'choice', choice: 'direct', confidence: 0.91, probabilities: { direct: 0.95, rlm: 0.05 } },
      identifier: { type: 'noul', noul: 0.8 },
    }, 0.7, 'jev-1.13.0', 210);
    expect(d).toMatchObject({ route: 'direct', confidence: 0.91, identifier: true, identifierProbability: 0.8, decisive: true, model: 'jev-1.13.0', ms: 210 });
  });
  it('is not decisive below minConfidence', () => {
    const d = decisionFromAnswers({ route: { type: 'choice', choice: 'rlm', confidence: 0.55, probabilities: {} } }, 0.7, 'm', 1);
    expect(d?.decisive).toBe(false);
    expect(d?.route).toBe('rlm');
  });
  it('rejects an unknown option or a missing route', () => {
    expect(decisionFromAnswers({ route: { type: 'choice', choice: 'maybe', confidence: 1, probabilities: {} } }, 0.7, 'm', 1)).toBeNull();
    expect(decisionFromAnswers({ identifier: { type: 'noul', noul: 1 } }, 0.7, 'm', 1)).toBeNull();
  });
});

describe('jevAsk / decideAskRoute', () => {
  const env = process.env;
  beforeEach(() => { process.env = { ...env }; });
  afterEach(() => { process.env = env; });

  it('returns null without a key and never calls the transport', async () => {
    delete process.env.TYPESAFE_API_KEY;
    let called = false;
    const r = await jevAsk('x', ASK_ROUTE_QUESTIONS, { fetchImpl: fakeFetch(200, {}, () => { called = true; }) });
    expect(r).toBeNull();
    expect(called).toBe(false);
  });

  it('sends state, model and both questions with a bearer key', async () => {
    process.env.TYPESAFE_API_KEY = 'k-test';
    let sent: { body: string } | null = null;
    const r = await jevAsk({ question: 'q' }, ASK_ROUTE_QUESTIONS, {
      model: 'jev-latest',
      fetchImpl: fakeFetch(200, { model: 'jev-1.13.0', answers: { route: { type: 'choice', choice: 'rlm', confidence: 0.8, probabilities: {} } } }, (i) => { sent = i; }),
    });
    expect(r?.model).toBe('jev-1.13.0');
    const body = JSON.parse((sent as unknown as { body: string }).body);
    expect(body.model).toBe('jev-latest');
    expect(body.state).toEqual({ question: 'q' });
    expect(Object.keys(body.questions).sort()).toEqual(['identifier', 'route']);
    expect(body.questions.route.type).toBe('choice');
    expect(Object.keys(body.questions.route.criteria).sort()).toEqual(['direct', 'rlm']);
  });

  it('returns null on HTTP errors and malformed bodies', async () => {
    process.env.TYPESAFE_API_KEY = 'k-test';
    expect(await jevAsk('x', ASK_ROUTE_QUESTIONS, { fetchImpl: fakeFetch(429, { error: 'rate' }) })).toBeNull();
    expect(await jevAsk('x', ASK_ROUTE_QUESTIONS, { fetchImpl: fakeFetch(200, { nope: true }) })).toBeNull();
  });

  it('decideAskRoute is null when the provider is not enabled in settings', async () => {
    process.env.TYPESAFE_API_KEY = 'k-test';
    // The test config has no llmProviders.typesafe.enabled, so the gate stays off.
    const d = await decideAskRoute({ question: 'where is Ext.onStart defined?', hits: [] }, { fetchImpl: fakeFetch(200, {}) });
    expect(d).toBeNull();
  });
});
