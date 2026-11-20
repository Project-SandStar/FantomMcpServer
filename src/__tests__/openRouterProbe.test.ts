/**
 * The OpenRouter page "Test" probes. Each pins one thing the page relies on:
 * no stored key fails before any request (except rlm, which has its own
 * probe), a role with no model says so, an embed pass counts vectors and
 * width, the pin is shown in the route, the chat error text is carried
 * through, and the rlm target is delegated to the LLM Providers probe.
 */
import { describe, it, expect } from '@jest/globals';
import {
  probeOpenRouterRole, probeOpenRouterRoles, isOpenRouterProbeRole, OPENROUTER_PROBE_ROLES,
  type OpenRouterProbeDeps,
} from '../admin/openRouterProbe.js';
import type { CloudRoleModel } from '../openrouter/roles.js';
import type { VirtualRole } from '../openrouter/roleTypes.js';

function rm(role: VirtualRole, model = 'qwen/qwen3-embedding-4b', extra: Partial<CloudRoleModel> = {}): CloudRoleModel {
  return { role, providerName: `Fantom-OR-${role}`, model, ...extra };
}

const base: OpenRouterProbeDeps = {
  hasKey: () => true,
  roleModel: () => null,
  embed: async () => { throw new Error('embed not stubbed'); },
  rerank: async () => { throw new Error('rerank not stubbed'); },
  chat: async () => { throw new Error('chat not stubbed'); },
  rlm: async () => ({ target: 'rlm', ok: true, ms: 5, model: 'deepseek/deepseek-v4-flash', route: 'sandbox', message: 'OK' }),
};

describe('openRouterProbe', () => {
  it('lists the five roles and validates names', () => {
    expect([...OPENROUTER_PROBE_ROLES]).toEqual(['code-embedding', 'embedding', 'reranker', 'code-assistant', 'rlm']);
    expect(isOpenRouterProbeRole('reranker')).toBe(true);
    expect(isOpenRouterProbeRole('ocr')).toBe(false);
  });

  it('fails without a request when no key is stored, except rlm', async () => {
    let called = false;
    const deps: OpenRouterProbeDeps = {
      ...base, hasKey: () => false,
      roleModel: (role) => { called = true; return rm(role); },
    };
    const r = await probeOpenRouterRole('embedding', deps);
    expect(called).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.route).toBe('not sent');
    expect(r.message).toMatch(/No OpenRouter key/);
    const rlm = await probeOpenRouterRole('rlm', deps);
    expect(rlm.ok).toBe(true);
  });

  it('says when no model is saved for the role', async () => {
    const r = await probeOpenRouterRole('code-embedding', base);
    expect(r.ok).toBe(false);
    expect(r.route).toBe('not sent');
    expect(r.message).toContain('no OpenRouter model is saved for code-embedding');
  });

  it('passes an embed with the vector count, width and pin', async () => {
    let seen: CloudRoleModel | undefined;
    const r = await probeOpenRouterRole('code-embedding', {
      ...base,
      roleModel: (role) => rm(role, 'qwen/qwen3-embedding-4b', { pin: 'DeepInfra', dims: 2560 }),
      embed: async (m) => { seen = m; return { vectors: [[1, 2], [3, 4]], dims: 2, model: 'qwen/qwen3-embedding-4b' }; },
    });
    expect(seen?.pin).toBe('DeepInfra');
    expect(r.ok).toBe(true);
    expect(r.model).toBe('qwen/qwen3-embedding-4b');
    expect(r.route).toBe('direct to OpenRouter (pinned to DeepInfra)');
    expect(r.message).toContain('2 vectors · 2d (expected 2560d)');
  });

  it('fails an embed that returns the wrong number of vectors', async () => {
    const r = await probeOpenRouterRole('embedding', {
      ...base,
      roleModel: (role) => rm(role),
      embed: async () => ({ vectors: [[1, 2]], dims: 2, model: 'm' }),
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/returned 1 vectors/);
  });

  it('carries the HTTP status of a failed rerank', async () => {
    const r = await probeOpenRouterRole('reranker', {
      ...base,
      roleModel: (role) => rm(role, 'qwen/qwen3-reranker-8b'),
      rerank: async () => { throw Object.assign(new Error('OpenRouter /rerank HTTP 429'), { status: 429 }); },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(429);
    expect(r.message).toContain('HTTP 429');
  });

  it('passes a rerank with the ranked count', async () => {
    const r = await probeOpenRouterRole('reranker', {
      ...base,
      roleModel: (role) => rm(role, 'qwen/qwen3-reranker-8b'),
      rerank: async () => ({ results: [{ index: 1, relevance_score: 0.9 }], model: 'qwen/qwen3-reranker-8b' }),
    });
    expect(r.ok).toBe(true);
    expect(r.message).toBe('1 ranked · top index 1');
  });

  it("carries the chat call's own error text", async () => {
    const r = await probeOpenRouterRole('code-assistant', {
      ...base,
      chat: async () => { throw new Error('OpenRouter /chat/completions HTTP 404: poolside/laguna-s-2.1:free is no longer available on OpenRouter'); },
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('no longer available on OpenRouter');
  });

  it('asks for the saved chat model and reports the served model on a pass', async () => {
    let asked: string | undefined;
    const r = await probeOpenRouterRole('code-assistant', {
      ...base,
      roleModel: (role) => rm(role, 'qwen/qwen3-coder'),
      chat: async (_s, _u, o) => { asked = o.model; return { text: 'OK', model: 'other/model', costUsd: null, servedBy: 'fantom' }; },
    });
    expect(asked).toBe('qwen/qwen3-coder');
    expect(r.ok).toBe(true);
    expect(r.route).toBe('direct to OpenRouter');
    expect(r.servedModel).toBe('other/model');
  });

  it('runs several roles at once and keeps their order', async () => {
    const rs = await probeOpenRouterRoles(['rlm', 'embedding'], base);
    expect(rs.map(r => r.role)).toEqual(['rlm', 'embedding']);
  });
});
