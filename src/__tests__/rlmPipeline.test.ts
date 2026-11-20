/**
 * RLM pipeline settings (Fantom RLM / Jev checks / ss-rlm-sandbox) and the
 * pure decisions an ask makes from them.
 */

import { jest } from '@jest/globals';

let stored: any = {};
const written: any[] = [];
jest.unstable_mockModule('../sidecars/registry.js', () => ({
  listSidecars: jest.fn(() => []),
  getSidecar: jest.fn(),
  sidecarUrl: jest.fn(),
}));
jest.unstable_mockModule('../sidecars/soundsuiteMaster.js', () => ({
  pushConfigToSidecar: jest.fn(() => true),
  isSoundSuiteSidecarConnected: jest.fn(() => true),
}));
jest.unstable_mockModule('../config/index.js', () => ({
  atomicWriteConfigFile: jest.fn((_p: string, cfg: any) => { written.push(JSON.parse(JSON.stringify(cfg))); stored = cfg; }),
  readConfigFileWithRecovery: jest.fn(() => JSON.parse(JSON.stringify(stored))),
}));

const {
  defaultRlmPipeline, sanitizeRlmPipeline, mergeRlmPipeline, decideSandbox, describeSettings, noTimeReason,
} = await import('../embedding/rlmPipeline.js');
const { getOpenRouterSettings, saveOpenRouterSettings } = await import('../sidecars/openRouterConfig.js');
const { sandboxHeaders, sandboxRequestBody } = await import('../embedding/rlmSandbox.js');

describe('defaults and sanitize', () => {
  it('defaults keep today\'s behaviour, with the sandbox as backup', () => {
    expect(defaultRlmPipeline()).toEqual({
      fantomRlm: true, jevEnabled: true, jevPlanCoverage: true, jevEvidence: true,
      sandboxMode: 'backup', retrievalCapSec: 30, sandboxMinSec: 25,
    });
  });

  it('a missing or garbage value reads as the defaults', () => {
    expect(sanitizeRlmPipeline(undefined)).toEqual(defaultRlmPipeline());
    expect(sanitizeRlmPipeline('nope')).toEqual(defaultRlmPipeline());
    expect(sanitizeRlmPipeline({ sandboxMode: 'sometimes', fantomRlm: 'maybe', budgetSec: 'x' })).toEqual(defaultRlmPipeline());
  });

  it('clamps times into range', () => {
    const p = sanitizeRlmPipeline({ budgetSec: 5, retrievalCapSec: 10_000, sandboxMinSec: '40' });
    expect(p.budgetSec).toBe(20);
    expect(p.retrievalCapSec).toBe(600);
    expect(p.sandboxMinSec).toBe(40);
  });

  it('accepts on/off strings as well as booleans', () => {
    expect(sanitizeRlmPipeline({ fantomRlm: 'off', jevEnabled: false }).fantomRlm).toBe(false);
    expect(sanitizeRlmPipeline({ fantomRlm: 'off', jevEnabled: false }).jevEnabled).toBe(false);
  });
});

describe('merge: an untouched control never overwrites a stored value', () => {
  const base = { ...defaultRlmPipeline(), sandboxMode: 'always' as const, fantomRlm: false, budgetSec: 90 };

  it('no patch, or an empty one, changes nothing', () => {
    expect(mergeRlmPipeline(base, undefined)).toEqual(base);
    expect(mergeRlmPipeline(base, {})).toEqual(base);
  });

  it('empty strings and nulls leave fields alone', () => {
    expect(mergeRlmPipeline(base, { budgetSec: '', sandboxMode: '', fantomRlm: null })).toEqual(base);
  });

  it('a sent field overrides only itself', () => {
    const m = mergeRlmPipeline(base, { sandboxMode: 'backup' });
    expect(m).toEqual({ ...base, sandboxMode: 'backup' });
  });
});

describe('persistence', () => {
  beforeEach(() => { stored = {}; written.length = 0; });

  it('reads defaults when nothing is stored', () => {
    expect(getOpenRouterSettings().rlmPipeline).toEqual(defaultRlmPipeline());
  });

  it('survives a save and read back, alongside the other fields', () => {
    const s = getOpenRouterSettings();
    s.rlmSandboxModel = 'deepseek/deepseek-v4-flash';
    s.rlmPipeline = { ...defaultRlmPipeline(), sandboxMode: 'always', budgetSec: 150 };
    saveOpenRouterSettings(s);
    const back = getOpenRouterSettings();
    expect(back.rlmPipeline).toEqual({ ...defaultRlmPipeline(), sandboxMode: 'always', budgetSec: 150 });
    expect(back.rlmSandboxModel).toBe('deepseek/deepseek-v4-flash');
    expect(written.at(-1).semanticSearch.openRouter).not.toHaveProperty('apiKey');
  });

  it('drops sidecar-push-era keys and keeps the pool numbers on save', () => {
    stored = { semanticSearch: { openRouter: { apiKey: 'sk-or-v1-OLDKEY12345678', keyPushed: true, workerCount: 4 }, virtualContainers: { enabled: true } } };
    saveOpenRouterSettings(getOpenRouterSettings());
    const or = written.at(-1).semanticSearch.openRouter;
    expect(or).not.toHaveProperty('apiKey');
    expect(or).not.toHaveProperty('keyPushed');
    expect(or.workerCount).toBe(4);
    expect(written.at(-1).semanticSearch).not.toHaveProperty('virtualContainers');
  });
});

describe('sandbox decision', () => {
  const base = { msLeft: 60_000, budgetMs: 120_000, minSandboxMs: 25_000, hasModel: true };

  it('off never runs', () => {
    for (const fantom of ['useful', 'empty', 'failed', 'no-host'] as const) {
      expect(decideSandbox({ ...base, mode: 'off', fantom })).toMatchObject({ run: false, status: 'off' });
    }
  });

  it('backup is not needed when Fantom RLM found evidence', () => {
    expect(decideSandbox({ ...base, mode: 'backup', fantom: 'useful' }))
      .toEqual({ run: false, status: 'skipped', reason: 'backup not needed — Fantom RLM found evidence' });
  });

  it('backup runs when Fantom RLM had no host, failed or found nothing', () => {
    expect(decideSandbox({ ...base, mode: 'backup', fantom: 'no-host' })).toMatchObject({ run: true, reason: 'backup: no Fantom RLM host' });
    expect(decideSandbox({ ...base, mode: 'backup', fantom: 'failed' })).toMatchObject({ run: true, reason: 'backup: Fantom RLM failed' });
    expect(decideSandbox({ ...base, mode: 'backup', fantom: 'empty' })).toMatchObject({ run: true });
  });

  it('backup does not stand in for a loop turned off in settings or skipped for time', () => {
    expect(decideSandbox({ ...base, mode: 'backup', fantom: 'off' })).toMatchObject({ run: false, status: 'skipped' });
    expect(decideSandbox({ ...base, mode: 'backup', fantom: 'no-time' })).toMatchObject({ run: false, status: 'skipped' });
  });

  it('never runs when Jev or the ask said RLM is not needed', () => {
    expect(decideSandbox({ ...base, mode: 'always', fantom: 'not-needed' })).toMatchObject({ run: false, reason: 'RLM not needed for this ask' });
  });

  it('always runs in place of the loop', () => {
    expect(decideSandbox({ ...base, mode: 'always', fantom: 'replaced' })).toEqual({ run: true, status: 'ran', reason: 'always instead of Fantom RLM' });
  });

  it('needs time and a model', () => {
    expect(decideSandbox({ ...base, mode: 'always', fantom: 'replaced', msLeft: 10_000 }))
      .toEqual({ run: false, status: 'skipped', reason: 'no time left (10s of 120s; needs 25s)' });
    expect(decideSandbox({ ...base, mode: 'backup', fantom: 'no-host', hasModel: false }))
      .toMatchObject({ run: false, reason: 'no sandbox model set' });
    expect(decideSandbox({ ...base, mode: 'always', fantom: 'replaced', hasSandboxKey: false }))
      .toMatchObject({ run: false, reason: 'sandbox off: no sandbox key' });
  });
});

describe('stage reasons', () => {
  it('no-time reason names what was left, of what, and what was needed', () => {
    expect(noTimeReason(-17_000, 120_000, 20_000)).toBe('no time left (0s of 120s; needs 20s)');
    expect(noTimeReason(12_400, 120_000, 20_000)).toBe('no time left (12s of 120s; needs 20s)');
  });

  it('settings line covers each engine and the budget split', () => {
    const line = describeSettings({
      p: defaultRlmPipeline(), rlmRoute: 'aggregate', rlmModel: 'deepseek/deepseek-v4-flash',
      jevAvailable: true, minConfidence: 0.7, sandboxModel: 'deepseek/deepseek-v4-flash',
      budgetMs: 120_000, retrievalCapMs: 30_000, answerReserveMs: 14_000,
    });
    expect(line).toBe(
      'Fantom RLM on (route aggregate, deepseek/deepseek-v4-flash) · Jev on ≥70% · '
      + 'sandbox only as backup (deepseek/deepseek-v4-flash) · budget 120s: search ≤30s · RLM ~76s · answer 14s',
    );
  });

  it('says why Jev cannot run, and that "always" keeps only the route gate', () => {
    const line = describeSettings({
      p: { ...defaultRlmPipeline(), sandboxMode: 'always' }, rlmRoute: 'local',
      jevAvailable: false, jevWhyNot: 'no TYPESAFE_API_KEY', minConfidence: 0.7,
      budgetMs: 120_000, retrievalCapMs: 30_000, answerReserveMs: 14_000,
    });
    expect(line).toContain('Fantom RLM replaced by sandbox');
    expect(line).toContain('Jev on but no TYPESAFE_API_KEY');
  });
});

describe('sandbox request', () => {
  it('sends identity, domain code, and the ask/project tags', () => {
    expect(sandboxHeaders('http://m:3848', 'ask1', 11)).toEqual({
      'Content-Type': 'application/json',
      'X-SoundSuite-Master': 'http://m:3848',
      'X-FantomMCP-Master': 'http://m:3848',
      'X-SoundSuite-Domain': 'code',
      'X-FantomMCP-Domain': 'code',
      'X-FantomMCP-Ask': 'ask1',
      'X-FantomMCP-Project': '11',
    });
  });

  it('is non-streaming and carries the whole question with its context', () => {
    const b = sandboxRequestBody('who calls foo?', '[1] foo');
    expect(b.stream).toBe(false);
    const msgs = b.messages as Array<{ role: string; content: string }>;
    expect(msgs.at(-1)!.content).toContain('QUESTION: who calls foo?');
    expect(msgs.at(-1)!.content).toContain('[1] foo');
  });
});
