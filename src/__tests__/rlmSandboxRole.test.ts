/**
 * `rlm` as a routing role, and the ss-rlm-sandbox contract it encodes.
 *
 * The role is unusual in two ways that these tests pin down, because both are
 * easy to "simplify" back into a bug:
 *
 *  1. The three sidecar modes mean what they say here. For the embedding roles
 *     the wire mode is an encoding with a trap in it (BACKUP pushes cloud-only
 *     so the sidecar does not resolve straight back to the same GPU); for rlm
 *     the sandbox documents local-only / local-first / cloud-only literally.
 *
 *  2. The role name and the model key are deliberately different strings.
 *     `rlm` is the policy role; `rlm-sandbox` is the key the sidecar reads the
 *     hosted model under. Collapsing them produces a config that saves, pushes
 *     and serves nothing.
 */

import { describe, it, expect } from '@jest/globals';
import {
  POLICY_ROLES, modesFromPolicies, effectiveBehaviour,
  aggregateIsMeaningful, policiesFor,
} from '../sidecars/routingPolicy.js';
import { VIRTUAL_ROLES, isRoleServable } from '../sidecars/virtualContainers.js';
import { catalogueFor, RLM_CATALOGUE } from '../sidecars/openRouterModels.js';

describe('rlm is a first-class routing role', () => {
  it('is in both role lists, so the policy machinery covers it', () => {
    expect(POLICY_ROLES).toContain('rlm');
    expect(VIRTUAL_ROLES).toContain('rlm');
  });

  it('offers all four policies — "OpenRouter only" included', () => {
    // The whole point of the request: the sandbox supports cloud-only, so
    // withholding it here would be the "stores cleanly, changes nothing"
    // failure the policySupported hook exists to prevent.
    expect(policiesFor('rlm')).toEqual(['aggregate', 'backup', 'local', 'cloud']);
  });

  it('is servable: something actually executes it', () => {
    // No <PC>-OR-Rlm virtual provider exists — the sidecar runs the container
    // and Fantom reaches it over HTTP — but the role is served, so the UI must
    // not badge it "not wired up yet" the way it does code-assistant.
    expect(isRoleServable('rlm')).toBe(true);
    expect(isRoleServable('code-assistant')).toBe(false);
  });
});

describe('the rlm wire modes are read literally by the sandbox', () => {
  it('maps each policy to the mode ss-rlm-sandbox documents', () => {
    expect(effectiveBehaviour('rlm', 'local').sidecarMode).toBe('local-only');
    expect(effectiveBehaviour('rlm', 'backup').sidecarMode).toBe('local-first');
    expect(effectiveBehaviour('rlm', 'cloud').sidecarMode).toBe('cloud-only');
  });

  it('degrades aggregate to backup — one session cannot be split', () => {
    expect(aggregateIsMeaningful('rlm')).toBe(false);
    const b = effectiveBehaviour('rlm', 'aggregate');
    expect(b.joinsFanOut).toBe(false);
    expect(b.allowsFallback).toBe(true);
  });

  it('excludes the GPUs only under cloud', () => {
    expect(effectiveBehaviour('rlm', 'cloud').localServes).toBe(false);
    for (const p of ['aggregate', 'backup', 'local'] as const) {
      expect(effectiveBehaviour('rlm', p).localServes).toBe(true);
    }
  });

  it('defaults to local, so nobody opts into per-session cost by accident', async () => {
    // Every other role's cloud fallback is one request; an RLM session is a
    // multi-round recursive loop. The proposed default must not be the
    // expensive one. (sanitizePolicies fills gaps with DEFAULT_POLICY, which is
    // a different question — that is "what does an unset field mean", and it
    // stays aggregate for every role.)
    const { defaultOpenRouterSettings } = await import('../sidecars/openRouterConfig.js');
    expect(defaultOpenRouterSettings().policyByRole!.rlm).toBe('local');
    expect(defaultOpenRouterSettings().modeByRole.rlm).toBe('local-only');
  });

  it('emits a mode for rlm, so the sidecar never infers one', () => {
    expect(modesFromPolicies({}).rlm).toBeTruthy();
  });
});

describe('the rlm model comes from the sandbox catalogue', () => {
  it('offers only models that can drive a tool-use loop', () => {
    expect(catalogueFor('rlm')).toEqual(RLM_CATALOGUE);
    expect(RLM_CATALOGUE.length).toBeGreaterThan(0);
    // A model without reasoning tends to answer after one round instead of
    // converging, which reads as a weak answer rather than a misconfiguration.
    for (const m of RLM_CATALOGUE) {
      expect(m.tools).toBe(true);
      expect(m.reasoning).toBe(true);
    }
  });
});
