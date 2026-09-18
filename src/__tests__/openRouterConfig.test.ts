/**
 * Validation of the OpenRouter config Fantom pushes to its own master slot.
 *
 * The point of validating before the push is that a bad config does not fail
 * loudly — the sidecar quietly falls back to local and logs a
 * misconfiguration, so the symptom is "cloud capacity never appears" days
 * later. Catching it in the form is much cheaper.
 */

import { jest } from '@jest/globals';

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
  atomicWriteConfigFile: jest.fn(),
  readConfigFileWithRecovery: jest.fn(() => ({})),
}));

const { validateOpenRouterSettings, defaultOpenRouterSettings } =
  await import('../sidecars/openRouterConfig.js');

describe('defaults', () => {
  const d = defaultOpenRouterSettings();

  it('proposes the reranker that is actually served on this account', () => {
    // 8B is the only reranker size on OpenRouter with a provider serving it,
    // and it is what the Sound Suite slot already pins here.
    expect(d.allowedModels.reranker!.model).toBe('qwen/qwen3-reranker-8b');
    // It carries no price commentary: this is the intended choice, not a
    // fallback to apologise for.
    expect(d.allowedModels.reranker).not.toHaveProperty('note');
  });

  it('pins an upstream for both embedding roles at 2560d', () => {
    for (const role of ['embedding', 'code-embedding'] as const) {
      expect(d.allowedModels[role]!.provider).toBeTruthy();
      expect(d.allowedModels[role]!.dims).toBe(2560);
    }
  });

  it('never pushes local-first — it would resolve straight back to the local GPU', () => {
    // The sidecar mode is DERIVED from the routing policy now. Neither of the
    // two cloud-using policies can be local-first:
    //   AGGREGATE — the virtual provider exists to ADD capacity. Fantom already
    //     has that host's GPU in the fan-out as its own provider, so
    //     local-first would give two providers on one device: contention
    //     instead of capacity, and the cloud never reached.
    //   BACKUP — Fantom has already decided local failed before it calls the
    //     sidecar. If the sidecar fell back too, it would answer locally every
    //     time and OpenRouter would never serve a request.
    for (const mode of Object.values(d.modeByRole)) {
      expect(mode).not.toBe('local-first');
    }
  });

  it('proposes aggregate for the embedders and backup for rerank', () => {
    expect(d.policyByRole!['code-embedding']).toBe('aggregate');
    expect(d.policyByRole!.embedding).toBe('aggregate');
    // Rerank is one call with no fan-out to join.
    expect(d.policyByRole!.reranker).toBe('backup');
  });

  it('emits a mode for every role, so none is read as disabled', () => {
    // An omitted role reads as local-only on the sidecar. Writing {} once left
    // 15 configured providers unable to call OpenRouter at all.
    expect(Object.keys(d.modeByRole).sort()).toEqual(['code-assistant', 'code-embedding', 'embedding', 'reranker', 'rlm']);
  });

  it('validates clean when a key is supplied', () => {
    expect(validateOpenRouterSettings(d, { hasKey: true })).toEqual([]);
  });
});

describe('validation', () => {
  it('requires a key on the very first push, because the sidecar ignores a keyless one', () => {
    const issues = validateOpenRouterSettings(defaultOpenRouterSettings(), { hasKey: false });
    expect(issues.some(i => /API key/i.test(i.message))).toBe(true);
  });

  it('accepts a keyless re-push once a key has been pushed before', () => {
    const s = { ...defaultOpenRouterSettings(), keyPushed: true };
    expect(validateOpenRouterSettings(s, { hasKey: false })).toEqual([]);
  });

  it('rejects an embedding role with no pinned upstream', () => {
    const s = {
      allowedModels: { 'code-embedding': { model: 'qwen/qwen3-embedding-4b', dims: 2560 } },
      modeByRole: { 'code-embedding': 'local-first' as const },
      keyPushed: true,
    };
    const issues = validateOpenRouterSettings(s, { hasKey: false });
    expect(issues).toHaveLength(1);
    expect(issues[0].role).toBe('code-embedding');
    expect(issues[0].message).toMatch(/split the vector space/);
  });

  it('does NOT require a pin for rerank — it is stateless', () => {
    const s = {
      allowedModels: { reranker: { model: 'qwen/qwen3-reranker-8b' } },
      modeByRole: { reranker: 'cloud-only' as const },
      keyPushed: true,
    };
    expect(validateOpenRouterSettings(s, { hasKey: false })).toEqual([]);
  });

  it('rejects a cloud-routable role with no model mapped', () => {
    const s = { allowedModels: {}, modeByRole: { reranker: 'cloud-only' as const }, keyPushed: true };
    const issues = validateOpenRouterSettings(s, { hasKey: false });
    expect(issues[0].message).toMatch(/no OpenRouter model is mapped/);
  });

  it('ignores a local-only role entirely — it never reaches OpenRouter', () => {
    const s = { allowedModels: {}, modeByRole: { reranker: 'local-only' as const }, keyPushed: true };
    expect(validateOpenRouterSettings(s, { hasKey: false })).toEqual([]);
  });

  it('rejects an embedding width that does not match the 2560d table', () => {
    const s = {
      allowedModels: { 'code-embedding': { model: 'm', provider: 'DeepInfra', dims: 1024 } },
      modeByRole: { 'code-embedding': 'local-first' as const },
      keyPushed: true,
    };
    const issues = validateOpenRouterSettings(s, { hasKey: false });
    expect(issues.some(i => /1024d/.test(i.message) && /2560d/.test(i.message))).toBe(true);
  });
});


describe('validation knows which roles own a vector space', () => {
  it('does not demand a vector pin from the chat role', () => {
    // `role !== 'reranker'` was a fine proxy for "is an embedding role" while
    // there were three roles, and became wrong the moment a fourth arrived:
    // it asked a chat model to pin an upstream so its vectors would not split,
    // for a role that produces no vectors.
    const issues = validateOpenRouterSettings({
      allowedModels: { 'code-assistant': { model: 'poolside/laguna-s-2.1' } },
      modeByRole: { 'code-assistant': 'cloud-only' },
      keyPushed: true,
    } as any, { hasKey: true });
    expect(issues).toEqual([]);
  });

  it('still demands one from the embedding roles', () => {
    for (const role of ['embedding', 'code-embedding'] as const) {
      const issues = validateOpenRouterSettings({
        allowedModels: { [role]: { model: 'qwen/qwen3-embedding-4b' } },
        modeByRole: { [role]: 'cloud-only' },
        keyPushed: true,
      } as any, { hasKey: true });
      expect(issues.map(i => i.message).join(' ')).toMatch(/no pinned upstream provider/);
    }
  });

  it('still lets rerank go unpinned — it is stateless', () => {
    const issues = validateOpenRouterSettings({
      allowedModels: { reranker: { model: 'qwen/qwen3-reranker-8b' } },
      modeByRole: { reranker: 'cloud-only' },
      keyPushed: true,
    } as any, { hasKey: true });
    expect(issues).toEqual([]);
  });

  it('does not apply the 2560d width rule to a chat model', () => {
    const issues = validateOpenRouterSettings({
      allowedModels: { 'code-assistant': { model: 'qwen/qwen3-coder', dims: 999 } },
      modeByRole: { 'code-assistant': 'cloud-only' },
      keyPushed: true,
    } as any, { hasKey: true });
    expect(issues).toEqual([]);
  });
});


describe('chat models stay out of the single-rate spend table', () => {
  it('estimates zero rather than 8x wrong, until token counts are split', async () => {
    const { estimateSpendUsd } = await import('../sidecars/openRouterActivity.js');
    // One rate cannot price a two-rate model from a combined token count.
    // Pricing a 50k-input/500-output call at the OUTPUT rate would read
    // $0.505 against a true ~$0.068 — enough to trip a cap set from the real
    // price list. Zero is wrong in the harmless direction, and accurate today
    // because nothing issues the call.
    expect(estimateSpendUsd('openai/gpt-5.1-codex', 50_500)).toBe(0);
    expect(estimateSpendUsd('qwen/qwen3-coder', 10_000)).toBe(0);
    // The one-directional models are still priced exactly.
    expect(estimateSpendUsd('qwen/qwen3-embedding-4b', 1_000_000)).toBeCloseTo(0.02);
  });
});
