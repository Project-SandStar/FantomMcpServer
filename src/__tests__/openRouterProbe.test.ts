/**
 * The OpenRouter page "Test" probes. Each pins one thing the page relies on:
 * a disabled integration fails before any request, a role with no provider
 * says so, an embed pass counts vectors and width, one dead host in a fleet
 * is named but does not fail the role, the chat proxy error text is carried
 * through, and the rlm target is delegated to the LLM Providers probe.
 */
import { describe, it, expect } from '@jest/globals';
import {
  probeOpenRouterRole, probeOpenRouterRoles, isOpenRouterProbeRole, OPENROUTER_PROBE_ROLES,
  type OpenRouterProbeDeps,
} from '../admin/openRouterProbe.js';
import type { VirtualContainer } from '../sidecars/virtualContainers.js';

function vc(sidecarName: string, role: VirtualContainer['role'], model = 'qwen/qwen3-embedding-4b'): VirtualContainer {
  return {
    sidecarId: `id-${sidecarName}`, sidecarName, providerName: `${sidecarName}-OR-${role}`,
    role, model, dims: 2560, mode: 'cloud-only', source: 'sidecar',
  };
}

const base: OpenRouterProbeDeps = {
  enabled: () => true,
  storedModel: (role) => (role === 'rlm' ? 'deepseek/deepseek-v4-flash' : 'qwen/qwen3-embedding-4b'),
  listContainers: () => [],
  embed: async () => { throw new Error('embed not stubbed'); },
  rerank: async () => { throw new Error('rerank not stubbed'); },
  chat: async () => { throw new Error('chat not stubbed'); },
  rlm: async () => ({ target: 'rlm', ok: true, ms: 5, model: 'deepseek/deepseek-v4-flash', route: 'sidecar OpenRouter route http://x', message: 'OK' }),
};

describe('openRouterProbe', () => {
  it('lists the five roles and validates names', () => {
    expect([...OPENROUTER_PROBE_ROLES]).toEqual(['code-embedding', 'embedding', 'reranker', 'code-assistant', 'rlm']);
    expect(isOpenRouterProbeRole('reranker')).toBe(true);
    expect(isOpenRouterProbeRole('ocr')).toBe(false);
  });

  it('fails without a request when OpenRouter is disabled, except rlm', async () => {
    let called = false;
    const deps: OpenRouterProbeDeps = { ...base, enabled: () => false, listContainers: () => { called = true; return []; } };
    const r = await probeOpenRouterRole('embedding', deps);
    expect(called).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('disabled');
    const rlm = await probeOpenRouterRole('rlm', deps);
    expect(rlm.ok).toBe(true);
  });

  it('says when no sidecar advertises the role', async () => {
    const r = await probeOpenRouterRole('code-embedding', base);
    expect(r.ok).toBe(false);
    expect(r.route).toBe('no provider');
    expect(r.message).toContain('no sidecar advertises');
  });

  it('passes an embed with the vector count and width', async () => {
    const r = await probeOpenRouterRole('code-embedding', {
      ...base,
      listContainers: () => [vc('gpu01', 'code-embedding')],
      embed: async () => ({ source: 'openrouter', embeddings: [[1, 2], [3, 4]], dims: 2, model: 'qwen/qwen3-embedding-4b' }),
    });
    expect(r.ok).toBe(true);
    expect(r.model).toBe('qwen/qwen3-embedding-4b');
    expect(r.route).toBe('gpu01-OR-code-embedding');
    expect(r.message).toContain('2 vectors · 2d (expected 2560d)');
  });

  it('names a dead host but passes the role when another answers', async () => {
    const r = await probeOpenRouterRole('reranker', {
      ...base,
      listContainers: () => [vc('gpu01', 'reranker'), vc('mini', 'reranker')],
      rerank: async (c) => {
        if (c.sidecarName === 'gpu01') throw new Error('virtual-rerank: no WS tunnel to the sidecar (command returned null)');
        return { source: 'openrouter', results: [{ index: 1, relevance_score: 0.9 }], model: 'x' };
      },
    });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('gpu01: ×');
    expect(r.message).toContain('no WS tunnel');
    expect(r.message).toContain('mini: ✓');
  });

  it("carries the chat proxy's own error text", async () => {
    const r = await probeOpenRouterRole('code-assistant', {
      ...base,
      chat: async () => { throw new Error('every sidecar refused the chat call — BASWS35: poolside/laguna-s-2.1:free is no longer available on OpenRouter'); },
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('no longer available on OpenRouter');
  });

  it('reports the chat host and served model on a pass', async () => {
    const r = await probeOpenRouterRole('code-assistant', {
      ...base,
      chat: async () => ({ text: 'OK', model: 'other/model', costUsd: null, servedBy: 'BASWS35' }),
    });
    expect(r.ok).toBe(true);
    expect(r.route).toContain('BASWS35');
    expect(r.servedModel).toBe('other/model');
  });

  it('runs several roles at once and keeps their order', async () => {
    const rs = await probeOpenRouterRoles(['rlm', 'embedding'], base);
    expect(rs.map(r => r.role)).toEqual(['rlm', 'embedding']);
  });
});
