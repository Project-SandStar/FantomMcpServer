/**
 * Routing policy — the operator-facing vocabulary for how a role uses cloud.
 *
 * The sidecar speaks `local-only | local-first | cloud-only`. That is an
 * IMPLEMENTATION DETAIL and is deliberately not exposed: it describes what one
 * sidecar does with one request, which is not the question an operator is
 * asking. They are asking whether the GPUs and the cloud work together, take
 * turns, or whether either one is off.
 *
 * ── The `rlm` role reads these literally ──────────────────────────────────
 *
 * For every other role the sidecar mode is an encoding with a trap in it (see
 * below). For `rlm` it is not: `ss-rlm-sandbox` documents exactly these three
 * modes and means them at face value — `local-only` never uses the sandbox,
 * `local-first` uses it only when no sidecar runs `ss-rlm`, `cloud-only`
 * always uses it and never probes for `ss-rlm`. So LOCAL/BACKUP/CLOUD map
 * one-to-one and AGGREGATE degrades to BACKUP, there being one session and
 * one endpoint to hold it.
 *
 *   AGGREGATE  "SideCar + OpenRouter"            — both at once, capacity adds up
 *   BACKUP     "SideCar + OpenRouter as backup"  — local serves, cloud covers failure
 *   LOCAL      "SideCar only"                    — nothing calls out
 *   CLOUD      "OpenRouter only"                 — the GPUs do not serve this role
 *
 * ── Why CLOUD exists, having been refused once ────────────────────────────
 *
 * It was left out deliberately while the premise held that cloud ADDS to the
 * sidecars. That premise broke on a measurement: local Ollama serves
 * `qwen3-embedding:4b` as Q4_K_M and the hosted providers run full precision,
 * and the pairwise cosine between them is 0.976 — against 0.9986 between two
 * LOCAL hosts. They are not one vector space, so the compatibility gate
 * (correctly) refuses every cloud provider and AGGREGATE is inert: the option
 * exists and nothing can ever use it.
 *
 * With one index there are only two ways out — run fp16 locally, or build the
 * whole index on cloud. CLOUD is the second. It is not "aggregate with the
 * GPUs turned off": it changes what the index IS, and three things follow that
 * no other policy needs.
 *
 *   1. `localServes` is false, so local providers are excluded from the
 *      fan-out outright rather than deprioritised.
 *   2. The QUERY encoder must come from the cloud pool too. A cloud-built
 *      corpus searched with a Q4 local query vector is the same 0.976
 *      mismatch applied to 100% of queries — strictly worse than mixing, and
 *      invisible, because it returns plausible results and no error.
 *   3. The compatibility gate changes its REFERENCE. Agreement with a local
 *      Q4 model is not a property anyone wants of a cloud-built index, and
 *      requiring it would block the exact configuration this policy exists to
 *      enable. See `vectorCompatibility.ts`.
 *
 * ── The encoding, and the trap in it ─────────────────────────────────────
 *
 * AGGREGATE pushes `cloud-only` to the sidecar. That looks backwards until you
 * follow the request: the virtual provider's ONLY job is to add capacity that
 * the local provider does not already have. Fantom already has that host's GPU
 * in the fan-out as its own provider. If the virtual container were
 * `local-first`, the sidecar would resolve it straight back to the same GPU —
 * two providers pointing at one device, so the scheduler would hand out twice
 * the work and get contention instead of capacity, and the cloud would never
 * be reached at all.
 *
 * BACKUP also pushes `cloud-only`, for the same reason from the other end.
 * Fantom decides when local has failed (that is what `rerankLocalFirst` does);
 * by the time it asks the sidecar, falling back to local is exactly the wrong
 * answer. If BOTH layers implemented the fallback, the sidecar would answer
 * every request locally and OpenRouter would never serve one — which is why
 * `virtualInferenceClient` always sends `localAvailable: false`.
 *
 * So the sidecar mode does not distinguish AGGREGATE from BACKUP. The
 * difference is entirely on Fantom's side, and it is one question: does the
 * virtual provider JOIN THE FAN-OUT, or is it held in reserve?
 */

import type { VirtualRole } from './virtualContainers.js';

export type RoutingPolicy = 'aggregate' | 'backup' | 'local' | 'cloud';
export type VirtualRoutingMode = 'local-only' | 'local-first' | 'cloud-only';

export const ROUTING_POLICIES: RoutingPolicy[] = ['aggregate', 'backup', 'local', 'cloud'];

/** Aggregate is the default: the user asked for capacity, not a failover. */
export const DEFAULT_POLICY: RoutingPolicy = 'aggregate';

export const POLICY_LABEL: Record<RoutingPolicy, string> = {
  aggregate: 'SideCar + OpenRouter',
  backup: 'SideCar + OpenRouter as backup',
  local: 'SideCar only',
  cloud: 'OpenRouter only',
};

export interface PolicyBehaviour {
  /** What the sidecar is told. See the module header for why BACKUP is not
   *  `local-first`. */
  sidecarMode: VirtualRoutingMode;
  /** Does the virtual provider pull chunks alongside the local GPUs? */
  joinsFanOut: boolean;
  /** May Fantom fall back to cloud when local is absent/unhealthy/failing? */
  allowsFallback: boolean;
  /**
   * May the local GPUs serve this role AT ALL?
   *
   * True for every policy except CLOUD — including LOCAL, where local is the
   * only thing that serves. This is not the inverse of "cloud is on": it is
   * the question the fan-out and the query encoder both have to ask, and
   * before CLOUD existed the answer was unconditionally yes, which is why
   * nothing asked it.
   */
  localServes: boolean;
}

export function behaviourOf(policy: RoutingPolicy): PolicyBehaviour {
  switch (policy) {
    case 'aggregate':
      // A peer in the fan-out. Not a fallback — it is not waiting for local to
      // fail, it is working at the same time.
      return { sidecarMode: 'cloud-only', joinsFanOut: true, allowsFallback: false, localServes: true };
    case 'backup':
      return { sidecarMode: 'cloud-only', joinsFanOut: false, allowsFallback: true, localServes: true };
    case 'local':
      // Excluded from the fan-out as well as refused by the sidecar. Either
      // alone would be enough; both means a stale discovery row cannot quietly
      // duplicate local work.
      return { sidecarMode: 'local-only', joinsFanOut: false, allowsFallback: false, localServes: true };
    case 'cloud':
      // Same wire mode as AGGREGATE — the sidecar has always been able to do
      // this, and pushing `cloud-only` is exactly what it already receives.
      // The whole difference is `localServes: false`, on Fantom's side.
      //
      // `allowsFallback` is false and means something different here than it
      // does under LOCAL: there is nothing to fall back FROM, because cloud is
      // the primary. Ask `cloudMayServe()`, not `allowsFallback`, when the
      // question is "may this role call out at all".
      return { sidecarMode: 'cloud-only', joinsFanOut: true, allowsFallback: false, localServes: false };
  }
}

/**
 * Reranking has no fan-out — it is one call over one document set, so there is
 * nothing to spread across providers. AGGREGATE therefore behaves exactly as
 * BACKUP for this role, and the UI says so rather than pretending otherwise.
 */
export function aggregateIsMeaningful(role: VirtualRole): boolean {
  // Neither rerank nor a chat completion has a fan-out to spread across: each
  // is one call whose result is not divisible between providers. `rlm` is the
  // same shape — one recursive session against one endpoint, which cannot be
  // split across two sandboxes — so AGGREGATE degrades to BACKUP there too.
  return role !== 'reranker' && role !== 'code-assistant' && role !== 'rlm';
}

export function effectiveBehaviour(role: VirtualRole, policy: RoutingPolicy): PolicyBehaviour {
  const b = behaviourOf(policy);

  // ── `rlm` does not use the embedding encoding ──────────────────────────
  //
  // BACKUP pushes `cloud-only` for every other role, and the module header
  // explains why: Fantom decides when local has failed, so telling the sidecar
  // to try local first would make it answer locally and never reach OpenRouter.
  //
  // ss-rlm-sandbox is the opposite. It resolves the fallback ITSELF and reads
  // the three modes at face value — `cloud-only` means "always the sandbox,
  // never probe for ss-rlm". So pushing the embedding encoding here would turn
  // "SideCar + OpenRouter as backup" into "OpenRouter only": the GPUs would
  // stop serving a role the operator explicitly asked them to serve first, and
  // every session would spend money that a running ss-rlm would have made free.
  //
  // AGGREGATE lands on the same mode, having already degraded to BACKUP just
  // below — one recursive session cannot be split across two endpoints.
  if (role === 'rlm') {
    const sidecarMode: VirtualRoutingMode =
      policy === 'local' ? 'local-only'
        : policy === 'cloud' ? 'cloud-only'
          : 'local-first';
    return { ...b, sidecarMode, joinsFanOut: false, allowsFallback: policy !== 'local', localServes: policy !== 'cloud' };
  }
  // Only AGGREGATE degrades. CLOUD deliberately passes through untouched: a
  // single-call role still has no fan-out to spread, but degrading it to
  // "local first, cloud as backup" would put the GPUs back in the path of a
  // policy whose entire content is that they are not.
  if (!aggregateIsMeaningful(role) && policy === 'aggregate') {
    return { ...b, joinsFanOut: false, allowsFallback: true };
  }
  return b;
}

/**
 * May OpenRouter serve this role at all?
 *
 * The three pre-CLOUD policies encoded this as `joinsFanOut || allowsFallback`,
 * and every caller that asked the question asked it that way. CLOUD breaks
 * that spelling: it sets `allowsFallback: false` because cloud is the primary,
 * not the reserve — so a caller still reading `allowsFallback` would conclude
 * that "OpenRouter only" means "never call OpenRouter", which is as exactly
 * backwards as a bug gets. Ask this instead.
 */
export function cloudMayServe(role: VirtualRole, policy: RoutingPolicy): boolean {
  const b = effectiveBehaviour(role, policy);
  return b.joinsFanOut || b.allowsFallback || !b.localServes;
}

/** True when the GPUs are excluded from this role entirely — the CLOUD policy. */
export function isCloudOnlyPolicy(role: VirtualRole, policy: RoutingPolicy): boolean {
  return !effectiveBehaviour(role, policy).localServes;
}

/**
 * Is this policy actually IMPLEMENTED end to end for this role?
 *
 * Nothing fails this today, and the function is kept anyway.
 *
 * It existed to refuse CLOUD for the docs `embedding` role, because the docs
 * vectors had no cloud path at all: `selectAllEmbeddingProvidersWithCloud`
 * returned the local pool unchanged for a non-code target and so did the
 * query encoder. Storing "OpenRouter only" there would have saved cleanly,
 * pushed `cloud-only`, reported no drift — and changed nothing, while the
 * queries went on being encoded locally with no indication. That is exactly
 * the silent failure the policy exists to eliminate, so it was refused rather
 * than warned about.
 *
 * That path is now wired: both embedding targets resolve their pool and their
 * query encoder through the same policy reader, and the docs write paths go
 * through it too. So the refusal is gone.
 *
 * What did NOT go away is the width question, and it must not be confused
 * with this one. `docs_vectors` is 1024d (qwen3-embedding:0.6b) and no hosted
 * model is 1024d, so choosing CLOUD for docs means rebuilding that table at
 * the selected model's width. That is a REAL consequence of a legitimate
 * choice, disclosed at the point of choice and refused loudly by the
 * compatibility gate until the widths agree — not a reason to hide the option.
 * A policy that is merely expensive is the operator's call; a policy that
 * silently does nothing is not.
 *
 * The hook stays because the next unimplemented combination should be caught
 * here rather than discovered in production, and because `sanitizePolicies`
 * is the only check a hand-edited config file passes through.
 */
export function policySupported(_role: VirtualRole, _policy: RoutingPolicy): boolean {
  return true;
}

/** The choices to offer for one role. */
export function policiesFor(role: VirtualRole): RoutingPolicy[] {
  return ROUTING_POLICIES.filter(p => policySupported(role, p));
}

/**
 * Kept as a local list rather than importing VIRTUAL_ROLES: this module is on
 * the rerank path via a static import, and virtualContainers pulls in the
 * registry and the WS master. `routingPolicy.test.ts` asserts the two lists
 * stay in step, so the duplication cannot rot silently.
 */
export const POLICY_ROLES: VirtualRole[] = ['embedding', 'code-embedding', 'reranker', 'code-assistant', 'rlm'];

export type PolicyByRole = Partial<Record<VirtualRole, RoutingPolicy>>;

export function isRoutingPolicy(v: unknown): v is RoutingPolicy {
  return typeof v === 'string' && (ROUTING_POLICIES as string[]).includes(v);
}

/**
 * Fill EVERY role. An omitted role must never be read as "disabled": the
 * sidecar treats a missing mode as `local-only`, so writing `{}` once left 15
 * configured providers that could never call OpenRouter, with nothing in the
 * UI to say why.
 */
export function sanitizePolicies(raw: unknown, fallback: RoutingPolicy = DEFAULT_POLICY): Required<PolicyByRole> {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = {} as Required<PolicyByRole>;
  for (const role of POLICY_ROLES) {
    const v = src[role];
    // A policy that is valid but not implemented for this role is rejected
    // here as well as hidden in the UI. Hiding an option only stops the next
    // person choosing it; a config file edited by hand, or written before the
    // option was withdrawn, reaches this function and nothing else.
    out[role] = isRoutingPolicy(v) && policySupported(role, v) ? v : fallback;
  }
  return out;
}

/** The `modeByRole` to push, derived from policy — never authored directly. */
export function modesFromPolicies(policies: PolicyByRole): Record<VirtualRole, VirtualRoutingMode> {
  const full = sanitizePolicies(policies);
  const out = {} as Record<VirtualRole, VirtualRoutingMode>;
  for (const role of Object.keys(full) as VirtualRole[]) {
    out[role] = effectiveBehaviour(role, full[role]!).sidecarMode;
  }
  return out;
}

/**
 * Migrate a legacy `modeByRole` entry to a policy.
 *
 * `cloud-only` is ambiguous — AGGREGATE and BACKUP both push it — so this has
 * to choose, and it chooses the CONSERVATIVE one. The live config reached this
 * branch with `cloud-only` on both embedding roles, set by hand while
 * debugging; reading that as AGGREGATE would enrol cloud providers in the
 * embedding fan-out on a config where nobody picked that, before the
 * compatibility gate has cleared any of them. BACKUP costs nothing if it is
 * wrong and the operator can opt up in one click.
 *
 * Fresh configs are unaffected: they have no modes to migrate and take
 * DEFAULT_POLICY (aggregate).
 *
 * CLOUD pushes `cloud-only` too, so it is now the THIRD policy this one wire
 * value could have come from — and it is never the answer. Migrating a legacy
 * mode into "OpenRouter only" would take the GPUs out of a role on a config
 * where nobody asked for that, and would invalidate the stored vectors. The
 * conservative choice gets more conservative, not less: still BACKUP.
 */
export function policyFromMode(mode: VirtualRoutingMode): RoutingPolicy | null {
  if (mode === 'local-only') return 'local';
  if (mode === 'cloud-only') return 'backup';
  return null; // 'local-first' is never something we push
}

export interface PolicyDrift {
  role: VirtualRole;
  policy: RoutingPolicy;
  /** What we would push for this policy. */
  wantMode: VirtualRoutingMode;
  /** What the sidecars actually report, where they disagree. */
  actualModes: string[];
  pending: boolean;
}

/**
 * Compare the stored policy against what the fleet is ACTUALLY running.
 *
 * This exists because a stored setting that never reached the sidecars looks
 * identical to one in effect. That is not hypothetical: modes were changed to
 * cloud-only and all 15 virtual providers went on reporting `local-only`,
 * because nothing re-pushed — the setting was inert and the page said it was
 * fine. Live container modes are the ground truth here, not our own
 * bookkeeping about what we last sent.
 */
export function detectPolicyDrift(
  policies: PolicyByRole,
  containers: Array<{ role: VirtualRole; mode: string; providerName: string }>,
): PolicyDrift[] {
  const full = sanitizePolicies(policies);
  const out: PolicyDrift[] = [];
  for (const role of Object.keys(full) as VirtualRole[]) {
    const wantMode = effectiveBehaviour(role, full[role]!).sidecarMode;
    const rows = containers.filter(c => c.role === role);
    const mismatched = rows.filter(c => c.mode !== wantMode);
    out.push({
      role,
      policy: full[role]!,
      wantMode,
      actualModes: [...new Set(mismatched.map(c => c.mode))],
      // No containers at all is not drift — there is nothing to disagree with.
      pending: rows.length > 0 && mismatched.length > 0,
    });
  }
  return out;
}
