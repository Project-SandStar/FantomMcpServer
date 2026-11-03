/**
 * Automatic OpenRouter re-push to sidecar slots that report "unset".
 *
 * The live failure this guards: Fantom moved to Docker (new master URL), every
 * sidecar opened an empty slot for it, `keyPushed` stayed true from the old
 * deployment, and "OpenRouter only" refused every embed. A keyless re-push
 * does not help — the sidecar drops it — so the push must carry a key.
 */
import { jest } from '@jest/globals';
import * as nodePath from 'path';
import * as nodeOs from 'os';

let CONFIG: any = {};
jest.unstable_mockModule('../config/index.js', () => ({
  atomicWriteConfigFile: jest.fn((_p: string, cfg: any) => { CONFIG = cfg; }),
  readConfigFileWithRecovery: jest.fn(() => CONFIG),
  isDebugEnabled: jest.fn(() => false),
}));

jest.unstable_mockModule('fs', () => {
  const real = jest.requireActual('fs') as any;
  return {
    ...real,
    default: real,
    existsSync: (p: string) => (String(p).endsWith('fantomMcpServer-config.json') ? true : real.existsSync(p)),
    readFileSync: (p: string, enc?: any) =>
      (String(p).endsWith('fantomMcpServer-config.json') ? JSON.stringify(CONFIG) : real.readFileSync(p, enc)),
  };
});

const pushConfigToSidecar = jest.fn((_id: string, _payload: any) => true);
const connected = new Set<string>(['sc-a', 'sc-b', 'sc-c']);
jest.unstable_mockModule('../sidecars/soundsuiteMaster.js', () => ({
  pushConfigToSidecar,
  isSoundSuiteSidecarConnected: jest.fn((id: string) => connected.has(id)),
}));

const SIDECARS = [
  { id: 'sc-a', name: 'BASWS35', enabled: true },
  { id: 'sc-b', name: 'mcpserver.local', enabled: true },
  { id: 'sc-c', name: 'BASWS41-gpu01', enabled: true },
] as any[];
jest.unstable_mockModule('../sidecars/registry.js', () => ({
  listSidecars: jest.fn(() => SIDECARS),
  getSidecar: jest.fn((id: string) => SIDECARS.find(s => s.id === id) ?? null),
  sidecarUrl: jest.fn(() => 'http://127.0.0.1:8098'),
}));

const TMP_CACHE = (jest.requireActual('fs') as any).mkdtempSync(
  nodePath.join(nodeOs.tmpdir(), 'fantom-secrets-'),
);
jest.unstable_mockModule('../utils/installRoot.js', () => ({
  getInstallRoot: jest.fn(() => TMP_CACHE),
  getCacheDir: jest.fn(() => TMP_CACHE),
}));

const { autoPushUnsetSlots, describeSlotHealth, __resetAutoPushForTest, AUTO_PUSH_COOLDOWN_MS } =
  await import('../sidecars/openRouterAutoPush.js');
const { recordDiscovered, __resetVirtualContainersForTest } = await import('../sidecars/virtualContainers.js');
const { pushOpenRouterConfig, rePushStoredConfig } = await import('../sidecars/openRouterConfig.js');
const { __resetSecretsStoreForTest, readStoredSecret, deleteStoredSecret, applyStoredSecretsToEnv } =
  await import('../config/secretsStore.js');

function freshConfig(): void {
  CONFIG = {
    semanticSearch: {
      virtualContainers: { enabled: true },
      openRouter: {
        allowedModels: { 'code-embedding': { model: 'qwen/qwen3-embedding-8b', provider: 'Nebius', dims: 4096 } },
        policyByRole: { 'code-embedding': 'cloud' },
        keyPushed: true,
        keyLast4: '498a',
      },
    },
  };
}

function slot(id: string, openrouter: 'configured' | 'unset'): void {
  recordDiscovered(id, { rows: [], openrouter, serverUrl: 'http://192.0.2.10:3848' } as any);
}

beforeEach(() => {
  freshConfig();
  __resetAutoPushForTest();
  __resetVirtualContainersForTest();
  __resetSecretsStoreForTest();
  deleteStoredSecret('FANTOM_OPENROUTER_API_KEY');
  delete process.env.FANTOM_OPENROUTER_API_KEY;
  pushConfigToSidecar.mockClear();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('autoPushUnsetSlots', () => {
  it('does nothing without a key: a keyless push is dropped by an empty slot', () => {
    slot('sc-a', 'unset');
    expect(autoPushUnsetSlots()).toEqual([]);
    expect(pushConfigToSidecar).not.toHaveBeenCalled();
  });

  it('pushes the env key to unset slots only', () => {
    process.env.FANTOM_OPENROUTER_API_KEY = 'sk-or-v1-envkey';
    slot('sc-a', 'unset');
    slot('sc-b', 'configured');
    const out = autoPushUnsetSlots();
    expect(out.map(o => o.sidecarId)).toEqual(['sc-a']);
    expect(pushConfigToSidecar).toHaveBeenCalledTimes(1);
    const [id, payload] = pushConfigToSidecar.mock.calls[0];
    expect(id).toBe('sc-a');
    expect(payload.openrouter.apiKey).toBe('sk-or-v1-envkey');
    expect(payload.openrouter.modeByRole['code-embedding']).toBe('cloud-only');
  });

  it('stores a pasted key on the server; it wins over the env and survives a restart', () => {
    process.env.FANTOM_OPENROUTER_API_KEY = 'sk-or-v1-envkey';
    pushOpenRouterConfig(CONFIG.semanticSearch.openRouter, 'sk-or-v1-pasted');
    expect(readStoredSecret('FANTOM_OPENROUTER_API_KEY')).toBe('sk-or-v1-pasted');
    expect(JSON.stringify(CONFIG)).not.toContain('pasted');
    // "Restart": env file value back in process.env, then boot applies the store.
    __resetSecretsStoreForTest();
    process.env.FANTOM_OPENROUTER_API_KEY = 'sk-or-v1-envkey';
    applyStoredSecretsToEnv();
    expect(process.env.FANTOM_OPENROUTER_API_KEY).toBe('sk-or-v1-pasted');
    slot('sc-a', 'configured');
    expect(describeSlotHealth(true)!.keySource).toBe('stored');
  });

  it('prefers the key last pasted on the dashboard over the env', () => {
    process.env.FANTOM_OPENROUTER_API_KEY = 'sk-or-v1-envkey';
    pushOpenRouterConfig(CONFIG.semanticSearch.openRouter, 'sk-or-v1-pasted');
    pushConfigToSidecar.mockClear();
    slot('sc-a', 'unset');
    autoPushUnsetSlots();
    expect(pushConfigToSidecar.mock.calls[0][1].openrouter.apiKey).toBe('sk-or-v1-pasted');
  });

  it('waits out the cooldown before pushing the same sidecar again', () => {
    process.env.FANTOM_OPENROUTER_API_KEY = 'sk-or-v1-envkey';
    slot('sc-a', 'unset');
    autoPushUnsetSlots(1_000);
    autoPushUnsetSlots(1_000 + 60_000);
    expect(pushConfigToSidecar).toHaveBeenCalledTimes(1);
    autoPushUnsetSlots(1_000 + AUTO_PUSH_COOLDOWN_MS);
    expect(pushConfigToSidecar).toHaveBeenCalledTimes(2);
  });

  it('never writes the config file', () => {
    process.env.FANTOM_OPENROUTER_API_KEY = 'sk-or-v1-envkey';
    slot('sc-a', 'unset');
    const before = JSON.stringify(CONFIG);
    autoPushUnsetSlots();
    expect(JSON.stringify(CONFIG)).toBe(before);
    expect(before).not.toContain('envkey');
  });

  it('is off while OpenRouter is disabled', () => {
    process.env.FANTOM_OPENROUTER_API_KEY = 'sk-or-v1-envkey';
    CONFIG.semanticSearch.virtualContainers.enabled = false;
    slot('sc-a', 'unset');
    expect(autoPushUnsetSlots()).toEqual([]);
  });
});

describe('rePushStoredConfig', () => {
  it('carries the available key, and the key never lands in the config file', () => {
    process.env.FANTOM_OPENROUTER_API_KEY = 'sk-or-v1-envkey';
    rePushStoredConfig();
    expect(pushConfigToSidecar.mock.calls[0][1].openrouter.apiKey).toBe('sk-or-v1-envkey');
    expect(JSON.stringify(CONFIG)).not.toContain('envkey');
  });
});

describe('describeSlotHealth', () => {
  it('is null before the first poll, so a fresh boot shows no false warning', () => {
    expect(describeSlotHealth(true)).toBeNull();
  });

  it('flags the stale keyPushed flag and lists unset and unread slots', () => {
    slot('sc-a', 'unset');
    slot('sc-b', 'configured');
    const h = describeSlotHealth(true)!;
    expect(h.unset.map(s => s.name)).toEqual(['BASWS35']);
    expect(h.unknown.map(s => s.name)).toEqual(['BASWS41-gpu01']);
    expect(h.keyFlagStale).toBe(true);
    expect(h.keySource).toBeNull();
  });

  it('reports the env key as the auto-push source', () => {
    process.env.FANTOM_OPENROUTER_API_KEY = 'sk-or-v1-envkey';
    slot('sc-a', 'configured');
    const h = describeSlotHealth(true)!;
    expect(h.keyFlagStale).toBe(false);
    expect(h.keySource).toBe('env');
  });
});
