/**
 * Discovery + naming + routing-mode handling for OpenRouter virtual
 * containers.
 *
 * The behaviour these lock down is the one the task doc warns about most
 * loudly: Fantom must only ever see capacity configured for ITS OWN master
 * slot. The live sidecars have OpenRouter configured for the Sound Suite
 * master (:3000) and unset for Fantom's (:3848); parsing the wrong slot would
 * manufacture providers that fail at request time.
 */

import { jest } from '@jest/globals';
import {
  parseOwnVirtualContainers,
  pcName,
  virtualProviderName,
} from '../sidecars/virtualContainers.js';

const SIDECAR = { id: 'sc-1', name: 'BASWS35' };

/** Shape of a real /api/status payload, trimmed to what discovery reads. */
function status(overrides: Partial<{ masters: unknown[] }> = {}) {
  return {
    hostname: '7a531233e3e0',
    masters: [
      {
        serverUrl: 'http://100.114.170.238:3000',
        wsPort: 3002,
        virtualInference: {
          openrouter: 'configured',
          modeByRole: { 'code-embedding': 'local-first', reranker: 'local-first' },
        },
        virtualContainers: [
          { role: 'code-embedding', model: 'qwen/qwen3-embedding-4b', provider: 'DeepInfra', dims: 2560, mode: 'local-first', state: 'idle' },
          { role: 'reranker', model: 'qwen/qwen3-reranker-8b', provider: 'Fireworks', mode: 'local-first', state: 'idle' },
        ],
      },
      {
        serverUrl: 'http://100.114.170.238:3848',
        wsPort: 3003,
        virtualInference: { openrouter: 'unset', modeByRole: {} },
        virtualContainers: [],
      },
    ],
    ...overrides,
  };
}

describe('PCName and provider naming', () => {
  it('strips a trailing .local, case-insensitively', () => {
    expect(pcName('mcpserver.local')).toBe('mcpserver');
    expect(pcName('Alpers-Mac-mini.LOCAL')).toBe('Alpers-Mac-mini');
    expect(pcName('BASWS35')).toBe('BASWS35');
  });

  it('names providers <PCName>-OR-<Role>', () => {
    expect(virtualProviderName('mcpserver.local', 'code-embedding')).toBe('mcpserver-OR-CodeEmbedding');
    expect(virtualProviderName('BASWS35', 'code-embedding')).toBe('BASWS35-OR-CodeEmbedding');
    expect(virtualProviderName('BASWS35', 'reranker')).toBe('BASWS35-OR-Reranker');
    expect(virtualProviderName('BASWS35', 'embedding')).toBe('BASWS35-OR-Embedding');
  });

  it('does not use the sidecar hostname, which is a container id', () => {
    // /api/status reports hostname "7a531233e3e0"; the PCName lives in the
    // registry entry. Naming from the status payload would give
    // `7a531233e3e0-OR-CodeEmbedding`.
    const m = parseOwnVirtualContainers(status(), SIDECAR, { wsPort: 3002 });
    expect(m.rows.every(r => r.providerName.startsWith('BASWS35-OR-'))).toBe(true);
  });
});

describe('master-slot ownership', () => {
  it('returns nothing when our slot has no OpenRouter config, even though another master does', () => {
    const m = parseOwnVirtualContainers(status(), SIDECAR, { wsPort: 3003 });
    expect(m.openrouter).toBe('unset');
    expect(m.rows).toEqual([]);
  });

  it('never borrows another master\'s virtual containers', () => {
    const m = parseOwnVirtualContainers(status(), SIDECAR, { wsPort: 3003 });
    // The :3000 slot has two usable rows. Picking them up would produce
    // phantom providers: the sidecar scopes its key per master and would
    // resolve our request back to `local`.
    expect(m.rows).toHaveLength(0);
  });

  it('reads our slot when it IS configured', () => {
    const payload = status();
    (payload.masters as any[])[1].virtualInference = {
      openrouter: 'configured',
      modeByRole: { 'code-embedding': 'local-first', reranker: 'cloud-only' },
    };
    (payload.masters as any[])[1].virtualContainers = [
      { role: 'code-embedding', model: 'qwen/qwen3-embedding-4b', provider: 'DeepInfra', dims: 2560, mode: 'local-first' },
      { role: 'reranker', model: 'qwen/qwen3-reranker-8b', mode: 'cloud-only' },
    ];
    const m = parseOwnVirtualContainers(payload, SIDECAR, { wsPort: 3003 });
    expect(m.openrouter).toBe('configured');
    expect(m.rows.map(r => r.providerName)).toEqual([
      'BASWS35-OR-CodeEmbedding',
      'BASWS35-OR-Reranker',
    ]);
    expect(m.rows[0].dims).toBe(2560);
    expect(m.rows[0].upstreamProvider).toBe('DeepInfra');
    // Rerank pins no upstream — it is stateless and shares no vector space.
    expect(m.rows[1].upstreamProvider).toBeUndefined();
  });

  it('matches on an explicit serverUrl when given', () => {
    const m = parseOwnVirtualContainers(status(), SIDECAR, {
      wsPort: 9999,
      masterServerUrl: 'http://100.114.170.238:3000',
    });
    expect(m.rows).toHaveLength(2);
  });
});

describe('routing modes', () => {
  const withMode = (mode: string) => {
    const payload = status();
    (payload.masters as any[])[1].virtualContainers = [
      { role: 'code-embedding', model: 'qwen/qwen3-embedding-4b', provider: 'DeepInfra', dims: 2560, mode },
    ];
    return parseOwnVirtualContainers(payload, SIDECAR, { wsPort: 3003 });
  };

  it.each(['local-only', 'local-first', 'cloud-only'])('preserves mode %s', mode => {
    expect(withMode(mode).rows[0].mode).toBe(mode);
  });

  it('treats an unknown or missing mode as local-only, the sidecar default', () => {
    expect(withMode('nonsense').rows[0].mode).toBe('local-only');
    const payload = status();
    (payload.masters as any[])[1].virtualContainers = [
      { role: 'code-embedding', model: 'm', provider: 'p' },
    ];
    expect(parseOwnVirtualContainers(payload, SIDECAR, { wsPort: 3003 }).rows[0].mode).toBe('local-only');
  });
});

describe('malformed payloads', () => {
  it('survives a status with no masters array', () => {
    expect(parseOwnVirtualContainers({ hostname: 'x' }, SIDECAR).rows).toEqual([]);
    expect(parseOwnVirtualContainers(null, SIDECAR).rows).toEqual([]);
    expect(parseOwnVirtualContainers('nope', SIDECAR).rows).toEqual([]);
  });

  it('drops rows with an unknown role or no model', () => {
    const payload = status();
    (payload.masters as any[])[1].virtualContainers = [
      { role: 'completion', model: 'x', mode: 'cloud-only' },   // not a virtual role we use
      { role: 'reranker', mode: 'cloud-only' },                  // no model
      { role: 'reranker', model: 'qwen/qwen3-reranker-8b', mode: 'cloud-only' },
    ];
    const rows = parseOwnVirtualContainers(payload, SIDECAR, { wsPort: 3003 }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe('qwen/qwen3-reranker-8b');
  });
});

afterEach(() => jest.restoreAllMocks());
