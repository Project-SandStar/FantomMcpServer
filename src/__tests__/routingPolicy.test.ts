import {
  behaviourOf, effectiveBehaviour, modesFromPolicies, sanitizePolicies,
  detectPolicyDrift, policyFromMode, aggregateIsMeaningful, isRoutingPolicy,
  POLICY_LABEL, ROUTING_POLICIES, DEFAULT_POLICY,
  cloudMayServe, isCloudOnlyPolicy, policiesFor, policySupported,
} from '../sidecars/routingPolicy.js';
import { POLICY_ROLES } from '../sidecars/routingPolicy.js';
import { VIRTUAL_ROLES, isRoleServable } from '../sidecars/virtualContainers.js';
import type { VirtualRole } from '../sidecars/virtualContainers.js';

describe('the operator vocabulary', () => {
  it('offers four choices, the fourth being "OpenRouter only"', () => {
    expect(ROUTING_POLICIES).toEqual(['aggregate', 'backup', 'local', 'cloud']);
    expect(ROUTING_POLICIES.map(p => POLICY_LABEL[p])).toEqual([
      'SideCar + OpenRouter',
      'SideCar + OpenRouter as backup',
      'SideCar only',
      'OpenRouter only',
    ]);
  });

  it('still never shows the sidecar wire vocabulary to an operator', () => {
    // "OpenRouter only" is the operator's sentence; `cloud-only` is the wire
    // value it maps to. Leaking the latter into a label would be the same
    // category error the module header refuses.
    const labels = ROUTING_POLICIES.map(p => POLICY_LABEL[p]).join(' ').toLowerCase();
    expect(labels).not.toContain('cloud-only');
    expect(labels).not.toContain('local-first');
    expect(labels).not.toContain('local-only');
  });

  it('defaults to the aggregate policy', () => {
    expect(DEFAULT_POLICY).toBe('aggregate');
  });

  it('rejects anything that is not one of the four', () => {
    expect(isRoutingPolicy('aggregate')).toBe(true);
    expect(isRoutingPolicy('cloud')).toBe(true);
    // The wire mode is not a policy, even now that a policy maps onto it.
    expect(isRoutingPolicy('cloud-only')).toBe(false);
    expect(isRoutingPolicy('local-first')).toBe(false);
    expect(isRoutingPolicy(undefined)).toBe(false);
  });
});

describe('the encoding, and the trap in it', () => {
  it('pushes cloud-only for AGGREGATE — local-first would point back at the same GPU', () => {
    const b = behaviourOf('aggregate');
    // If this were 'local-first' the sidecar would resolve the virtual
    // container back to the host's own GPU, giving two providers on one
    // device: contention, not capacity, and the cloud never reached.
    expect(b.sidecarMode).toBe('cloud-only');
    expect(b.joinsFanOut).toBe(true);
    expect(b.allowsFallback).toBe(false);
  });

  it('pushes cloud-only for BACKUP too — only ONE layer may do the fallback', () => {
    const b = behaviourOf('backup');
    // Fantom decides local has failed before it ever calls the sidecar. If the
    // sidecar also fell back, it would answer locally every time and
    // OpenRouter would never serve a request.
    expect(b.sidecarMode).toBe('cloud-only');
    expect(b.joinsFanOut).toBe(false);
    expect(b.allowsFallback).toBe(true);
  });

  it('excludes cloud entirely for LOCAL, on both sides', () => {
    const b = behaviourOf('local');
    expect(b.sidecarMode).toBe('local-only');
    expect(b.joinsFanOut).toBe(false);
    expect(b.allowsFallback).toBe(false);
  });

  it('never pushes local-first for any policy', () => {
    for (const p of ROUTING_POLICIES) {
      expect(behaviourOf(p).sidecarMode).not.toBe('local-first');
    }
  });
});

describe('"OpenRouter only" — the one policy where the GPUs do not serve', () => {
  it('maps to the cloud-only wire mode the sidecar already honours', () => {
    // No sidecar change was needed for this policy: `cloud-only` is a mode the
    // fleet has been receiving all along, from AGGREGATE and BACKUP.
    expect(behaviourOf('cloud').sidecarMode).toBe('cloud-only');
  });

  it('takes local out of the fan-out — the whole difference from aggregate', () => {
    expect(behaviourOf('cloud').localServes).toBe(false);
    expect(behaviourOf('cloud').joinsFanOut).toBe(true);
  });

  it('leaves the other three policies untouched, local included', () => {
    for (const p of ['aggregate', 'backup', 'local'] as const) {
      expect(behaviourOf(p).localServes).toBe(true);
    }
    // Exactly the assertions that guarded these three before CLOUD existed.
    expect(behaviourOf('aggregate')).toMatchObject({ sidecarMode: 'cloud-only', joinsFanOut: true, allowsFallback: false });
    expect(behaviourOf('backup')).toMatchObject({ sidecarMode: 'cloud-only', joinsFanOut: false, allowsFallback: true });
    expect(behaviourOf('local')).toMatchObject({ sidecarMode: 'local-only', joinsFanOut: false, allowsFallback: false });
  });

  it('says cloud MAY serve, even though allowsFallback is false', () => {
    // The trap: cloud is the PRIMARY here, so there is nothing to fall back
    // from. A caller reading `allowsFallback` would conclude "OpenRouter only"
    // means "never call OpenRouter".
    expect(behaviourOf('cloud').allowsFallback).toBe(false);
    for (const role of POLICY_ROLES) {
      expect(cloudMayServe(role, 'cloud')).toBe(true);
      expect(isCloudOnlyPolicy(role, 'cloud')).toBe(true);
    }
    expect(cloudMayServe('code-embedding', 'local')).toBe(false);
    expect(cloudMayServe('code-embedding', 'aggregate')).toBe(true);
    expect(cloudMayServe('reranker', 'backup')).toBe(true);
  });

  it('does not degrade for a single-call role the way aggregate does', () => {
    // Degrading the reranker to "local first, cloud as backup" would put the
    // GPUs back in the path of a policy whose entire content is that they are
    // not in it.
    for (const role of ['reranker', 'code-assistant'] as VirtualRole[]) {
      expect(aggregateIsMeaningful(role)).toBe(false);
      const b = effectiveBehaviour(role, 'cloud');
      expect(b.localServes).toBe(false);
      expect(b.sidecarMode).toBe('cloud-only');
      expect(cloudMayServe(role, 'cloud')).toBe(true);
    }
  });

  it('round-trips through sanitize and lands as cloud-only on the wire', () => {
    const p = sanitizePolicies({ 'code-embedding': 'cloud' });
    expect(p['code-embedding']).toBe('cloud');
    // Every OTHER role keeps the default rather than being dragged along.
    expect(p.embedding).toBe('aggregate');
    expect(modesFromPolicies(p)['code-embedding']).toBe('cloud-only');
    expect(isRoutingPolicy('cloud')).toBe(true);
  });

  it('is never inferred from a legacy mode — only ever chosen deliberately', () => {
    // cloud-only is now the wire value of THREE policies. Migrating into
    // "OpenRouter only" would take the GPUs out of a role nobody asked to
    // change, and would invalidate that role's stored vectors.
    expect(policyFromMode('cloud-only')).toBe('backup');
    expect(policyFromMode('local-only')).toBe('local');
    expect(policyFromMode('local-first')).toBeNull();
  });

  it('is offered for the docs embedder now that the docs cloud path exists', () => {
    // It used to be withheld here, because nothing routed docs vectors to
    // OpenRouter — not the fan-out, not the query encoder — so storing it
    // would have saved cleanly, pushed cloud-only, reported no drift and
    // changed nothing while queries went on being encoded locally.
    //
    // That path is wired: both embedding targets resolve their pool AND their
    // query encoder through `embeddingRoutingPolicy`, and the docs write paths
    // go through it too. What remains is a width cost, not a silent no-op —
    // docs_vectors is 1024d and every hosted model is wider, so choosing this
    // means rebuilding that table. An expensive choice is the operator's to
    // make; an inert one is not.
    expect(policiesFor('embedding')).toEqual(['aggregate', 'backup', 'local', 'cloud']);
    expect(policiesFor('code-embedding')).toEqual(['aggregate', 'backup', 'local', 'cloud']);
    for (const p of ['aggregate', 'backup', 'local', 'cloud'] as const) {
      expect(policySupported('embedding', p)).toBe(true);
    }
  });

  it('is offered for the reranker and the code assistant', () => {
    // Rerank genuinely honours it — rerankRouter skips the local reranker when
    // localServes is false. code-assistant serves nothing under ANY policy
    // (isRoleServable is false and the UI says so), so CLOUD is not
    // specifically broken for it and is not specially withheld.
    expect(policiesFor('reranker')).toContain('cloud');
    expect(policiesFor('code-assistant')).toContain('cloud');
  });

  it('keeps a hand-edited config that names it for the docs embedder', () => {
    // The mirror of the test above. sanitizePolicies is the only check a
    // config file edited by hand passes through, so while the policy was
    // unimplemented for docs this had to downgrade it to aggregate. Now that
    // it is implemented, silently rewriting the operator's choice would be
    // the bug — the fleet would run a policy the file does not name.
    const p = sanitizePolicies({ embedding: 'cloud', 'code-embedding': 'cloud' });
    expect(p.embedding).toBe('cloud');
    expect(p['code-embedding']).toBe('cloud');
    expect(modesFromPolicies(p).embedding).toBe('cloud-only');
  });

  it('still refuses a policy that is not a policy at all', () => {
    // The hook that used to catch docs+cloud is now a no-op, so this is what
    // keeps sanitizePolicies honest: garbage in a config file falls back to
    // the default rather than reaching the fleet.
    const p = sanitizePolicies({ embedding: 'nonsense', 'code-embedding': 'cloud' });
    expect(p.embedding).toBe('aggregate');
    expect(p['code-embedding']).toBe('cloud');
  });

  it('does not read as drift against a fleet already on cloud-only', () => {
    const drift = detectPolicyDrift(
      { 'code-embedding': 'cloud' },
      [{ role: 'code-embedding' as VirtualRole, mode: 'cloud-only', providerName: 'A-OR-CodeEmbedding' }],
    );
    expect(drift.find(d => d.role === 'code-embedding')!.pending).toBe(false);
  });
});

describe('rerank has no fan-out to aggregate into', () => {
  it('degenerates aggregate to backup for the reranker', () => {
    expect(aggregateIsMeaningful('reranker')).toBe(false);
    const b = effectiveBehaviour('reranker', 'aggregate');
    expect(b.joinsFanOut).toBe(false);
    expect(b.allowsFallback).toBe(true);
  });

  it('leaves the embedding roles alone', () => {
    for (const role of ['embedding', 'code-embedding'] as VirtualRole[]) {
      expect(aggregateIsMeaningful(role)).toBe(true);
      expect(effectiveBehaviour(role, 'aggregate').joinsFanOut).toBe(true);
    }
  });

  it('still keeps "SideCar only" off for the reranker', () => {
    expect(effectiveBehaviour('reranker', 'local').allowsFallback).toBe(false);
  });
});

describe('an omitted role must never read as disabled', () => {
  it('fills every role when the stored map is empty', () => {
    const p = sanitizePolicies({});
    expect(Object.keys(p).sort()).toEqual(['code-assistant', 'code-embedding', 'embedding', 'reranker', 'rlm']);
    for (const v of Object.values(p)) expect(v).toBe('aggregate');
  });

  it('emits a mode for every role, so the sidecar never infers local-only', () => {
    // Writing modeByRole {} is exactly what left 15 configured providers
    // unable to call OpenRouter.
    const modes = modesFromPolicies({});
    expect(Object.keys(modes).sort()).toEqual(['code-assistant', 'code-embedding', 'embedding', 'reranker', 'rlm']);
    for (const m of Object.values(modes)) expect(m).toBeTruthy();
  });

  it('keeps the roles that ARE set and fills only the rest', () => {
    const p = sanitizePolicies({ reranker: 'backup' });
    expect(p.reranker).toBe('backup');
    expect(p['code-embedding']).toBe('aggregate');
  });

  it('ignores junk rather than storing it', () => {
    const p = sanitizePolicies({ reranker: 'cloud-only', embedding: 42 });
    expect(p.reranker).toBe('aggregate');
    expect(p.embedding).toBe('aggregate');
  });

  it('migrates a legacy modeByRole into a policy, choosing the safe reading', () => {
    expect(policyFromMode('local-only')).toBe('local');
    // cloud-only is ambiguous — both aggregate and backup push it. The live
    // config had cloud-only on BOTH embedding roles, set by hand while
    // debugging; reading it as aggregate would put cloud providers into the
    // fan-out on a config where nobody chose that.
    expect(policyFromMode('cloud-only')).toBe('backup');
    // We never push local-first, so it maps to nothing and the default wins.
    expect(policyFromMode('local-first')).toBeNull();
  });

  it('a hand-set cloud-only config does not silently join the fan-out', () => {
    const migrated = sanitizePolicies({
      embedding: policyFromMode('cloud-only'),
      'code-embedding': policyFromMode('cloud-only'),
      reranker: policyFromMode('cloud-only'),
    });
    expect(effectiveBehaviour('code-embedding', migrated['code-embedding']!).joinsFanOut).toBe(false);
    // ...but cloud is still reachable, so nothing that was working stops.
    expect(effectiveBehaviour('code-embedding', migrated['code-embedding']!).sidecarMode).toBe('cloud-only');
  });

  it('a FRESH config still defaults to aggregate, as asked', () => {
    expect(sanitizePolicies(undefined)['code-embedding']).toBe('aggregate');
  });
});

describe('a stored policy that never reached the fleet is not in effect', () => {
  const rows = (mode: string) => [
    { role: 'code-embedding' as VirtualRole, mode, providerName: 'A-OR-CodeEmbedding' },
    { role: 'code-embedding' as VirtualRole, mode, providerName: 'B-OR-CodeEmbedding' },
  ];

  it('flags drift when the fleet still reports the old mode', () => {
    // The exact failure seen in production: stored cloud-only, fleet local-only,
    // nothing re-pushed, and the page showing it as if it were applied.
    const drift = detectPolicyDrift({ 'code-embedding': 'aggregate' }, rows('local-only'));
    const code = drift.find(d => d.role === 'code-embedding')!;
    expect(code.pending).toBe(true);
    expect(code.wantMode).toBe('cloud-only');
    expect(code.actualModes).toEqual(['local-only']);
  });

  it('reports no drift once the fleet agrees', () => {
    const drift = detectPolicyDrift({ 'code-embedding': 'aggregate' }, rows('cloud-only'));
    expect(drift.find(d => d.role === 'code-embedding')!.pending).toBe(false);
  });

  it('does not call an empty fleet drift — there is nothing to disagree with', () => {
    const drift = detectPolicyDrift({ 'code-embedding': 'aggregate' }, []);
    expect(drift.every(d => d.pending === false)).toBe(true);
  });

  it('covers every role even when only one has containers', () => {
    const drift = detectPolicyDrift({}, rows('local-only'));
    expect(drift.map(d => d.role).sort()).toEqual(['code-assistant', 'code-embedding', 'embedding', 'reranker', 'rlm']);
  });
});


describe('the code-assistant role joins the policy machinery', () => {
  it('keeps POLICY_ROLES in step with VIRTUAL_ROLES', () => {
    // routingPolicy deliberately duplicates the role list rather than
    // importing it — it sits on the rerank path and virtualContainers pulls in
    // the registry and the WS master. This is what stops the copy rotting.
    expect([...POLICY_ROLES].sort()).toEqual([...VIRTUAL_ROLES].sort());
  });

  it('gets a policy and a mode like every other role', () => {
    expect(sanitizePolicies({})['code-assistant']).toBe('aggregate');
    expect(modesFromPolicies({})['code-assistant']).toBeTruthy();
  });

  it('has no fan-out to aggregate into — one completion is not divisible', () => {
    expect(aggregateIsMeaningful('code-assistant')).toBe(false);
    const b = effectiveBehaviour('code-assistant', 'aggregate');
    expect(b.joinsFanOut).toBe(false);
    expect(b.allowsFallback).toBe(true);
  });

  it('honours "SideCar only" for it too', () => {
    expect(effectiveBehaviour('code-assistant', 'local').sidecarMode).toBe('local-only');
  });

  it('is reported as not yet servable, so the UI can say so', () => {
    // The sidecar stores and reports the role, but ws-client has no chat
    // action — the setting is real, the data path is not.
    expect(isRoleServable('code-assistant')).toBe(false);
    for (const role of ['embedding', 'code-embedding', 'reranker'] as VirtualRole[]) {
      expect(isRoleServable(role)).toBe(true);
    }
  });
});
