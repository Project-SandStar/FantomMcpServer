import { jest } from '@jest/globals';

/**
 * Regression test for the two halves of /dashboard/config#openrouter
 * contradicting each other.
 *
 * `GET /admin/openrouter` reported 15 virtual providers registered on Fantom's
 * slot, keyPushed true, all 5 sidecars connected. `GET /admin/openrouter/credits`
 * simultaneously returned ok:false "no OpenRouter virtual containers are
 * registered for Fantom's master slot yet", so Remaining / Total credits /
 * Total usage rendered as em-dashes and the budget sat on its fallback of 4.
 *
 * The cause was a precondition mismatch: the credits path called
 * `listVirtualContainers()`, which drops every `local-only` row, while the page
 * built its list from the unfiltered source. With all roles local-only, one saw
 * zero and the other saw fifteen.
 *
 * The principle the fix encodes: credits and the account rate limit are
 * properties of the KEY, not of any role's routing policy. Under the routing
 * dropdown "SideCar only" is a perfectly normal state in which to still want
 * your balance — and discovering the ceiling BEFORE spending against it is the
 * entire point.
 */

// Loosely typed on purpose: these stand in for modules with rich signatures
// and the assertions here are about WHICH of them gets called, not shapes.
type AnyFn = (...args: any[]) => any;
const listAllVirtualContainers = jest.fn<AnyFn>();
const listVirtualContainers = jest.fn<AnyFn>();
const virtualKeyInfo = jest.fn<AnyFn>();
const getOpenRouterSettings = jest.fn<AnyFn>();
const listSidecars = jest.fn<AnyFn>();
const isSoundSuiteSidecarConnected = jest.fn<AnyFn>();

jest.unstable_mockModule('../sidecars/virtualContainers.js', () => ({
  listAllVirtualContainers, listVirtualContainers,
}));
jest.unstable_mockModule('../sidecars/virtualInferenceClient.js', () => ({ virtualKeyInfo }));
jest.unstable_mockModule('../sidecars/openRouterConfig.js', () => ({ getOpenRouterSettings }));
jest.unstable_mockModule('../sidecars/registry.js', () => ({ listSidecars }));
jest.unstable_mockModule('../sidecars/soundsuiteMaster.js', () => ({ isSoundSuiteSidecarConnected }));

const {
  refreshCloudBudgetFromKey, cloudBudgetStats,
  __resetCloudBudgetForTest, __resetCloudDiscoveryForTest,
} = await import('../embedding/providers/cloudBudget.js');

/** 15 containers, every one of them local-only — the production state. */
const LOCAL_ONLY_FLEET = Array.from({ length: 15 }, (_, i) => ({
  sidecarId: `sc-${i % 5}`,
  providerName: `host${i % 5}-OR-CodeEmbedding`,
  role: 'code-embedding',
  mode: 'local-only',
  model: 'qwen/qwen3-embedding-4b',
}));

beforeEach(() => {
  __resetCloudBudgetForTest();
  __resetCloudDiscoveryForTest();
  jest.clearAllMocks();

  listAllVirtualContainers.mockReturnValue(LOCAL_ONLY_FLEET);
  // The filtered view is empty, exactly as in production.
  listVirtualContainers.mockReturnValue([]);
  getOpenRouterSettings.mockReturnValue({ keyPushed: true, keyLast4: 'e180', allowedModels: {}, modeByRole: {} });
  listSidecars.mockReturnValue(
    Array.from({ length: 5 }, (_, i) => ({ id: `sc-${i}`, name: `host${i}`, enabled: true })),
  );
  isSoundSuiteSidecarConnected.mockReturnValue(true);
  virtualKeyInfo.mockResolvedValue({
    ok: true,
    info: { requests: 100, intervalSeconds: 10, limit: 25, usage: 3.5, limitRemaining: 21.5 },
  });
});

describe('containers registered + key pushed implies the credits probe is attempted', () => {
  it('probes even when every container is local-only', async () => {
    const stats = await refreshCloudBudgetFromKey(true);

    expect(virtualKeyInfo).toHaveBeenCalled();
    expect(stats.discovery.ok).toBe(true);
    // The specific message that used to be returned instead of a probe.
    expect(stats.discovery.reason ?? '').not.toMatch(/no OpenRouter virtual containers are registered/);
  });

  it('never uses the local-only-filtered list as its precondition', async () => {
    await refreshCloudBudgetFromKey(true);
    // The filtered view is the fan-out's question ("who can serve?"), not the
    // key's ("what is my balance?"). Using it here is the bug.
    expect(listVirtualContainers).not.toHaveBeenCalled();
  });

  it('fills in the credits the page was rendering as em-dashes', async () => {
    const stats = await refreshCloudBudgetFromKey(true);
    expect(stats.credits).toEqual({ remaining: 21.5, totalCredits: 25, totalUsage: 3.5 });
  });

  it('lifts the budget off its fallback of 4', async () => {
    const stats = await refreshCloudBudgetFromKey(true);
    // 100 requests / 10s = 600 rpm; at the 2s seed latency that is 20.
    expect(stats.discoveredRequestsPerMinute).toBe(600);
    expect(stats.discoveredConcurrency).toBe(20);
    expect(stats.source).toBe('discovered');
    expect(cloudBudgetStats().ceilingConcurrency).toBe(20);
  });

  it('still reads the balance when the operator has chosen SideCar only', async () => {
    // "SideCar only" for every role is a normal, supported state — and the one
    // you are most likely to be in while deciding whether to turn cloud on.
    listAllVirtualContainers.mockReturnValue([]);
    const stats = await refreshCloudBudgetFromKey(true);
    expect(virtualKeyInfo).toHaveBeenCalled();
    expect(stats.discovery.ok).toBe(true);
  });
});

describe('the preconditions it DOES keep', () => {
  it('says so plainly when no key has been pushed', async () => {
    getOpenRouterSettings.mockReturnValue({ keyPushed: false, allowedModels: {}, modeByRole: {} });
    const stats = await refreshCloudBudgetFromKey(true);
    expect(virtualKeyInfo).not.toHaveBeenCalled();
    expect(stats.discovery.reason).toMatch(/no OpenRouter key has been pushed/);
  });

  it('distinguishes "no tunnel" from "no key"', async () => {
    listAllVirtualContainers.mockReturnValue([]);
    isSoundSuiteSidecarConnected.mockReturnValue(false);
    const stats = await refreshCloudBudgetFromKey(true);
    expect(virtualKeyInfo).not.toHaveBeenCalled();
    expect(stats.discovery.reason).toMatch(/no sidecar has an open WS tunnel/i);
  });

  it('falls back conservatively when the sidecar build cannot answer', async () => {
    virtualKeyInfo.mockResolvedValue({ ok: false, unsupported: true, reason: 'Unknown action: virtual-key-info' });
    const stats = await refreshCloudBudgetFromKey(true);
    expect(stats.discovery.ok).toBe(false);
    expect(stats.discovery.unsupported).toBe(true);
    expect(stats.source).toBe('fallback');
    // Never assume headroom we could not read.
    expect(stats.ceilingConcurrency).toBe(4);
  });

  it('only asks one sidecar once one answers — they all hold the same key', async () => {
    await refreshCloudBudgetFromKey(true);
    expect(virtualKeyInfo).toHaveBeenCalledTimes(1);
  });
});
