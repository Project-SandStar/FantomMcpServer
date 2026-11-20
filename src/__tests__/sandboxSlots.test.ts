/**
 * The one thing Fantom still pushes to a sidecar: the rlm-sandbox slot.
 * Fantom calls OpenRouter itself for every other role, so the payload must
 * carry the sandbox model and nothing else, and Fantom must find its own
 * master entry in a sidecar's /api/status.
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../sidecars/registry.js', () => ({
  listSidecars: jest.fn(() => []),
  getSidecar: jest.fn((id: string) => (id === 'sc1' ? { id: 'sc1', name: 'host1' } : null)),
  sidecarUrl: jest.fn(() => 'http://sc:8098'),
}));
const pushConfigToSidecar = jest.fn((_id: string, _p: unknown) => true);
jest.unstable_mockModule('../sidecars/soundsuiteMaster.js', () => ({
  pushConfigToSidecar,
  isSoundSuiteSidecarConnected: jest.fn(() => true),
}));
let CONFIG: any = {};
jest.unstable_mockModule('../config/index.js', () => ({
  readConfigFileWithRecovery: jest.fn(() => CONFIG),
  atomicWriteConfigFile: jest.fn(),
}));
jest.unstable_mockModule('../config/secretsStore.js', () => ({
  SECRET_NAMES: ['FANTOM_OPENROUTER_API_KEY', 'FANTOM_OPENROUTER_SANDBOX_KEY'],
  readStoredSecret: jest.fn(() => null),
  secretSource: jest.fn(() => null),
  storeSecret: jest.fn(),
  deleteStoredSecret: jest.fn(() => false),
  applyStoredSecretsToEnv: jest.fn(() => []),
  __resetSecretsStoreForTest: jest.fn(),
}));

const {
  buildSandboxPushPayload, parseOwnSlot, masterIdentityHeaders, sandboxModelForPush,
  canonicalMasterUrl, DEFAULT_SANDBOX_MODEL, __resetSandboxSlotsForTest,
  pushSandboxSlot, sandboxOffReason,
} = await import('../sidecars/sandboxSlots.js');

const MAIN = 'sk-or-v1-MAINKEY0-00000000-000000';
const SANDBOX = 'sk-or-v1-SANDBOXK-EY000000-00000';
beforeEach(() => {
  CONFIG = {}; __resetSandboxSlotsForTest(); pushConfigToSidecar.mockClear();
  delete process.env.FANTOM_OPENROUTER_API_KEY; delete process.env.FANTOM_OPENROUTER_SANDBOX_KEY;
});

describe('sandbox key: the sandbox never gets the main key', () => {
  it('pushes the sandbox key, not the main key', () => {
    process.env.FANTOM_OPENROUTER_API_KEY = MAIN;
    process.env.FANTOM_OPENROUTER_SANDBOX_KEY = SANDBOX;
    CONFIG = { semanticSearch: { openRouter: { rlmSandboxModel: 'deepseek/deepseek-v4-flash' } } };
    expect(pushSandboxSlot('sc1')).toBe(true);
    const sent = JSON.stringify(pushConfigToSidecar.mock.calls[0][1]);
    expect(sent).toContain(SANDBOX);
    expect(sent).not.toContain(MAIN);
    expect(sandboxOffReason()).toBeNull();
  });

  it('with only the main key set, clears the slot and sends no key at all', () => {
    process.env.FANTOM_OPENROUTER_API_KEY = MAIN;
    CONFIG = { semanticSearch: { openRouter: { rlmSandboxModel: 'deepseek/deepseek-v4-flash' } } };
    pushSandboxSlot('sc1');
    const p = pushConfigToSidecar.mock.calls[0][1];
    expect(p).toEqual({ openrouter: null });
    expect(JSON.stringify(p)).not.toContain('sk-or');
    expect(sandboxOffReason()).toBe('sandbox off: no sandbox key');
  });
});

describe('buildSandboxPushPayload', () => {
  it('is exactly the key, the rlm-sandbox model and the code domain', () => {
    expect(buildSandboxPushPayload('deepseek/deepseek-v4-flash', 'sk-or-v1-FAKEKEY1234567890')).toEqual({
      openrouter: {
        apiKey: 'sk-or-v1-FAKEKEY1234567890',
        allowedModels: { 'rlm-sandbox': { model: 'deepseek/deepseek-v4-flash' } },
        domain: 'code',
      },
    });
  });

  it('clears the slot (openrouter: null) when there is no sandbox key', () => {
    for (const k of [null, undefined, '']) {
      expect(buildSandboxPushPayload('m', k)).toEqual({ openrouter: null });
    }
  });

  it('never names another role, and sends no mode or policy', () => {
    const p = buildSandboxPushPayload('m', 'k') as any;
    expect(Object.keys(p.openrouter.allowedModels)).toEqual(['rlm-sandbox']);
    expect(Object.keys(p.openrouter).sort()).toEqual(['allowedModels', 'apiKey', 'domain']);
    const s = JSON.stringify(p);
    for (const role of ['code-embedding', '"embedding"', 'reranker', 'code-assistant', 'modeByRole']) expect(s).not.toContain(role);
  });

  it('clears the slot when no sandbox model is set', () => {
    expect(buildSandboxPushPayload(null, 'k')).toEqual({ openrouter: null });
  });
});

describe('sandboxModelForPush', () => {
  it('reads the saved model, and maps a direct:<provider> model to a real OpenRouter one', () => {
    expect(sandboxModelForPush()).toBeNull();
    CONFIG = { semanticSearch: { openRouter: { rlmSandboxModel: ' qwen/qwen3-coder ' } } };
    expect(sandboxModelForPush()).toBe('qwen/qwen3-coder');
    CONFIG = { semanticSearch: { openRouter: { rlmSandboxModel: 'direct:gemini:gemini-3.8-flash' } } };
    expect(sandboxModelForPush()).toBe(DEFAULT_SANDBOX_MODEL);
  });
});

describe('parseOwnSlot', () => {
  const status = {
    masters: [
      { serverUrl: 'http://other:3848', wsPort: 3004, virtualInference: { openrouter: 'configured' } },
      { serverUrl: 'http://fantom:3848', wsPort: 3003, virtualInference: { openrouter: 'unset' } },
      { serverUrl: 'http://third:3848', wsPort: 3005, sandbox: { openrouter: 'configured' } },
    ],
  };

  it('finds the entry by ws port', () => {
    expect(parseOwnSlot(status, { wsPort: 3003 })).toEqual({ serverUrl: 'http://fantom:3848', openrouter: 'unset' });
    expect(parseOwnSlot(status, { wsPort: 3005 })).toEqual({ serverUrl: 'http://third:3848', openrouter: 'configured' });
  });

  it('prefers the configured master URL over the port', () => {
    expect(parseOwnSlot(status, { wsPort: 3003, masterServerUrl: 'http://other:3848' }))
      .toEqual({ serverUrl: 'http://other:3848', openrouter: 'configured' });
  });

  it('returns null when Fantom is not in the list or the body has no masters', () => {
    expect(parseOwnSlot(status, { wsPort: 9999 })).toBeNull();
    expect(parseOwnSlot(status, { wsPort: 3003, masterServerUrl: 'http://nope' })).toBeNull();
    expect(parseOwnSlot({}, { wsPort: 3003 })).toBeNull();
    expect(parseOwnSlot(null, { wsPort: 3003 })).toBeNull();
  });

  it('reads an entry with no openrouter state as unset', () => {
    expect(parseOwnSlot({ masters: [{ wsPort: '3003' }] }, { wsPort: 3003 }))
      .toEqual({ serverUrl: undefined, openrouter: 'unset' });
  });
});

describe('master identity', () => {
  it('sends the master URL under both header names, with the code domain', () => {
    expect(masterIdentityHeaders('http://fantom:3848')).toEqual({
      'X-FantomMCP-Master': 'http://fantom:3848',
      'X-SoundSuite-Master': 'http://fantom:3848',
      'X-FantomMCP-Domain': 'code',
    });
  });

  it('takes the canonical URL from config when no slot has been seen', () => {
    expect(canonicalMasterUrl('sc1')).toBeUndefined();
    CONFIG = { semanticSearch: { openRouter: { masterServerUrl: 'http://fantom:3848' } } };
    expect(canonicalMasterUrl('sc1')).toBe('http://fantom:3848');
  });
});
