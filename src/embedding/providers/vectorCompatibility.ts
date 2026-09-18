/**
 * Vector-space compatibility gate for OpenRouter-backed embedding providers,
 * and the ledger of its verdicts.
 *
 * `code_vectors` is one table: qwen3-embedding:4b at 2560d. Under the current
 * fan-out policy — every healthy provider, local GPU and cloud alike, pulling
 * chunks from the SAME scheduler queue during the same run — local and
 * OpenRouter vectors land in that table interleaved. If the two serving stacks
 * do not produce interchangeable vectors, cosine distance stops being
 * comparable and retrieval degrades silently, with no way to tell which rows
 * came from where.
 *
 * So this is a HARD PRECONDITION, not a warning: a provider that has not
 * passed must never serve a single text.
 *
 * The check:
 *   1. Embed the same probe texts via the OpenRouter route and via a REFERENCE.
 *   2. Pairwise cosine similarity on each corresponding pair.
 *   3. Require min cosine >= 0.99 across every pair.
 *   4. Require the returned dimension to be exactly the configured width.
 *
 * ── The reference is not always local ──────────────────────────────────────
 *
 * Under the three policies where the GPUs serve, the reference MUST be local:
 * cloud vectors land in the same table as local ones during the same run, so
 * agreement with the rows already in it is exactly the property being tested,
 * and comparing cloud against cloud would prove nothing about them.
 *
 * Under "OpenRouter only" (`RoutingPolicy = 'cloud'`) that test is not merely
 * unnecessary, it is wrong. The index is built entirely from cloud vectors;
 * no local vector is ever written to it. Agreement with a Q4_K_M local model
 * is not a property anyone wants of those rows, and requiring it would refuse
 * the one configuration the policy exists to enable — the measured local/cloud
 * cosine is 0.976, well under the 0.99 floor, which is WHY the policy exists.
 *
 * The failure the gate prevents does not go away with the reference. One
 * OpenRouter model slug can be served by different upstreams, and two
 * `<PCName>-OR-*` providers resolving the same model disagreeing with EACH
 * OTHER is precisely the drift that would poison a cloud-built index. So under
 * `cloud` the reference is another cloud provider, and everything else about
 * the gate is unchanged. It is never disabled.
 *
 * ── What the cloud reference does NOT cover, and cannot ────────────────────
 *
 * When exactly ONE cloud provider exists there is no peer, and cross-provider
 * consistency is vacuous: one provider cannot disagree with itself, and it
 * alone writes every row. The gate then checks dimension and the upstream pin
 * and nothing else.
 *
 * That is a real reduction in coverage, and it is worth naming rather than
 * burying. A single pinned upstream can still change its serving stack behind
 * the same pin over time — a host redeploying a different quantisation of the
 * same model slug — and under the local regime the local model would have
 * caught that drift on re-verification. Under a sole-provider cloud regime
 * there is no reference at all, so nothing catches it. The pin is what keeps
 * this narrow: it removes the request-to-request split, leaving only the
 * slower "the upstream changed underneath us" case, which shows up as a
 * retrieval-quality regression rather than an immediate one.
 *
 * ── Why the ledger lives here and not in embedFaults.ts ────────────────────
 *
 * `embedFaults.ts` records a different thing: a sidecar whose *runtime*
 * refuses to embed (Ollama ≥0.3x rejecting a GGUF with no `pooling_type`).
 * Those faults carry a TTL and expire, because the condition is usually a
 * pull in progress or a host an operator is about to fix, and re-probing is
 * the right behaviour.
 *
 * A vector-space verdict must NOT expire. "This provider's vectors are not
 * interchangeable with the rows already in the table" does not become false
 * after an hour, and an expiring verdict would quietly let a poisoning
 * provider back into the fan-out. Two different lifetimes, two different
 * stores — kept apart deliberately, and surfaced as two lists on
 * /admin/sidecars.
 *
 * Verdicts are keyed by (provider, model, pinned upstream, REFERENCE REGIME).
 * Changing the model or the pin produces a different key, which IS the
 * "re-verify when the model or pinned provider changes" rule: the old verdict
 * simply no longer applies.
 *
 * The regime is in the key for the same reason and a sharper one. A verdict
 * reached under `cloud-ref` says "this provider agrees with the other cloud
 * providers" — and under a sole provider, only "its width is right". Neither
 * is evidence that it agrees with a LOCAL host. If the two regimes shared a
 * key, flipping the policy back from "OpenRouter only" to "SideCar +
 * OpenRouter" would find a green verdict already in the ledger and admit an
 * unverified-against-local provider straight into a mixed fan-out: the exact
 * poisoning this module exists to prevent, reintroduced by a dropdown.
 */

import { isSoundSuiteSidecarConnected } from '../../sidecars/soundsuiteMaster.js';
import type { EmbeddingProvider } from './embeddingProvider.js';
import { virtualEmbed } from '../../sidecars/virtualInferenceClient.js';
import type { VirtualContainer } from '../../sidecars/virtualContainers.js';

/** Minimum pairwise cosine for two stacks to count as one vector space. */
export const MIN_COMPATIBLE_COSINE = 0.99;

// ─── Ledger ────────────────────────────────────────────────────────────────

export type VectorVerdictKind =
  | 'vector-incompatible'   // cosine below the floor vs the reference
  | 'dimension-mismatch'    // wrong width for the target table
  | 'no-provider-pin'       // embeddings without a pinned upstream can split the space
  | 'probe-failed';         // could not run the check at all

/**
 * WHAT a provider was checked against, and therefore what a green verdict
 * actually claims.
 *
 *  - `local-ref`  the table holds (or will hold) local rows too, so the claim
 *                 is "interchangeable with the local hosts". Used by every
 *                 policy where the GPUs serve.
 *  - `cloud-ref`  the table is built entirely from cloud vectors, so the claim
 *                 is "agrees with the other cloud providers", or — when there
 *                 is no peer — only "the right width, from a pinned upstream".
 *                 Used by "OpenRouter only".
 *
 * These are not interchangeable claims, which is why the regime is part of the
 * verdict key rather than a note beside it.
 */
export type VerificationRegime = 'local-ref' | 'cloud-ref';

export interface VectorRefusal {
  key: string;
  providerName: string;
  kind: VectorVerdictKind;
  reason: string;
  at: string;
  /** Lowest pairwise cosine observed, when the check actually ran. */
  minCosine?: number;
  dims?: number;
  /** Which regime produced this verdict. */
  reference?: VerificationRegime;
  /** The provider or host it was compared against, when there was one. */
  referenceName?: string;
}

export interface VectorVerification {
  key: string;
  providerName: string;
  ok: true;
  /**
   * Absent ONLY in the sole-cloud-provider case, where there is no peer to
   * compare against and the check is dimension + pin. Reporting a cosine of 1
   * there would claim an agreement that was never measured.
   */
  minCosine?: number;
  meanCosine?: number;
  dims: number;
  samples: number;
  at: string;
  reference: VerificationRegime;
  referenceName?: string;
}

/**
 * Identity of a vector space AND of the claim made about it: the same host
 * serving a different model, the same model behind a different upstream, or
 * the same provider checked against a different kind of reference, are all
 * different verdicts.
 *
 * `reference` is deliberately required. Three call sites compute this key and
 * they must agree; an optional field with a default is how one of them quietly
 * reads the wrong ledger entry.
 */
export function verdictKey(parts: {
  providerName: string;
  model: string;
  upstreamProvider?: string;
  reference: VerificationRegime;
}): string {
  return `${parts.providerName}|${parts.model}|${parts.upstreamProvider ?? '-'}|${parts.reference}`;
}

const refusals = new Map<string, VectorRefusal>();
const verified = new Map<string, VectorVerification>();

/**
 * Probe backoff. A host that keeps failing its probe (BASWS34 re-registered
 * 187 times in one afternoon, and every re-register cleared its transient
 * refusal) must not be re-probed on every reconnect: each re-probe is a 15s
 * timeout, and when it ran inside the query path it added 15s to an ask.
 * Consecutive probe failures double the wait before the next attempt,
 * 30s → 15 min cap; a pass resets it.
 */
const probeFailures = new Map<string, { count: number; lastAt: number }>();
const PROBE_BACKOFF_BASE_MS = 30_000;
const PROBE_BACKOFF_MAX_MS = 15 * 60_000;
function probeBackoffRemainingMs(key: string, now = Date.now()): number {
  const f = probeFailures.get(key);
  if (!f) return 0;
  const wait = Math.min(PROBE_BACKOFF_MAX_MS, PROBE_BACKOFF_BASE_MS * 2 ** Math.min(10, f.count - 1));
  return Math.max(0, f.lastAt + wait - now);
}
/** For dashboards/tests: how long until a probe-failed provider is eligible again. */
export function getProbeBackoff(key: string): { failures: number; remainingMs: number } {
  const f = probeFailures.get(key);
  return { failures: f?.count ?? 0, remainingMs: probeBackoffRemainingMs(key) };
}

export function recordRefusal(r: Omit<VectorRefusal, 'at'>): VectorRefusal {
  const rec: VectorRefusal = { ...r, at: new Date().toISOString() };
  refusals.set(rec.key, rec);
  verified.delete(rec.key);
  if (rec.kind === 'probe-failed') {
    const f = probeFailures.get(rec.key);
    probeFailures.set(rec.key, { count: (f?.count ?? 0) + 1, lastAt: Date.now() });
  } else {
    probeFailures.delete(rec.key);
  }
  console.error(
    `[vector-gate] REFUSING ${rec.providerName} (${rec.kind}): ${rec.reason}`
    + (rec.minCosine !== undefined ? ` minCosine=${rec.minCosine.toFixed(6)}` : '')
    + (rec.dims !== undefined ? ` dims=${rec.dims}` : '')
    + ' — it will not serve any text until it passes verification.',
  );
  return rec;
}

export function recordVerified(v: Omit<VectorVerification, 'at' | 'ok'>): VectorVerification {
  probeFailures.delete(v.key);
  const rec: VectorVerification = { ...v, ok: true, at: new Date().toISOString() };
  verified.set(rec.key, rec);
  refusals.delete(rec.key);
  console.log(
    `[vector-gate] VERIFIED ${rec.providerName}: ${rec.samples} probe texts, `
    + (rec.minCosine !== undefined && rec.meanCosine !== undefined
      ? `minCosine=${rec.minCosine.toFixed(6)} meanCosine=${rec.meanCosine.toFixed(6)} `
        + `vs ${rec.referenceName ?? 'the reference'} (${rec.reference}) `
      // Say plainly that nothing was compared, rather than letting a green
      // badge imply a measurement that never happened.
      : 'no peer to compare against — dimension and upstream pin only, because it is the SOLE cloud '
        + 'provider and every row in the table will come from it. ')
    + `dims=${rec.dims} — cleared to join the fan-out.`,
  );
  return rec;
}

export function getRefusal(key: string): VectorRefusal | null {
  return refusals.get(key) ?? null;
}

export function getVerification(key: string): VectorVerification | null {
  return verified.get(key) ?? null;
}

/**
 * The gate the fan-out asks. Fails CLOSED: a provider that has never been
 * verified is refused exactly like one that failed, because "not yet checked"
 * and "known bad" are indistinguishable from the table's point of view.
 */
export function isClearedToEmbed(key: string): boolean {
  if (refusals.has(key)) return false;
  return verified.has(key);
}

export function listRefusals(): VectorRefusal[] { return [...refusals.values()]; }
export function listVerifications(): VectorVerification[] { return [...verified.values()]; }
export function clearRefusal(key: string): boolean { return refusals.delete(key); }

/**
 * Drop refusals that describe a MOMENT rather than a provider.
 *
 * `probe-failed` means the check could not run — no WS tunnel, a timeout, a
 * null reply. That is true of the instant it was recorded and says nothing
 * about the vectors. Keeping it sticky is how five reconnected sidecars stayed
 * refused until someone hand-ran a verify, after every restart.
 *
 * Everything else is kept: `vector-incompatible`, `dimension-mismatch` and
 * `no-provider-pin` are verdicts about the provider and survive a reconnect.
 */
export function clearTransientRefusals(): number {
  let n = 0;
  const now = Date.now();
  for (const [key, rec] of refusals) {
    if (rec.kind !== 'probe-failed') continue;
    const wait = probeBackoffRemainingMs(key, now);
    if (wait > 0) {
      console.log(`[vector-gate] keeping ${rec.providerName} refused (probe-failed ×${probeFailures.get(key)?.count ?? 1}) — next probe in ${Math.ceil(wait / 1000)}s`);
      continue;
    }
    refusals.delete(key); n++;
  }
  return n;
}

// ─── The check ─────────────────────────────────────────────────────────────

/**
 * Probe texts. Ten short, structurally varied code/doc snippets — the goal is
 * to exercise tokenizer and pooling differences, which is where two serving
 * stacks of the "same" model actually diverge, not to be representative of
 * the corpus.
 */
export const PROBE_TEXTS: string[] = [
  'function add(a: number, b: number): number { return a + b; }',
  'class VectorStore { async storeEmbeddings(items, projectId) { /* ... */ } }',
  'SELECT id, name FROM projects WHERE enabled = 1 ORDER BY name',
  'Reads the documentation cache and rebuilds the FlexSearch index from disk.',
  'export const DEFAULT_TIMEOUT_MS = 30_000;',
  'if err != nil { return fmt.Errorf("open %s: %w", path, err) }',
  'A Fantom pod declares its dependencies in build.fan before compilation.',
  'def normalize(v): n = math.sqrt(sum(x*x for x in v)); return [x/n for x in v]',
  'git rebase --onto main feature~3 feature',
  '# Migration\n\nSkySpark 3.x trio files are rewritten to 4.0 syntax in place.',
];

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface CompatibilityReport {
  key: string;
  providerName: string;
  ok: boolean;
  minCosine?: number;
  meanCosine?: number;
  dims?: number;
  expectedDims: number;
  samples: number;
  reason: string;
  /** Per-pair cosines, in probe order — the numbers to report. */
  cosines?: number[];
  reference: VerificationRegime;
  referenceName?: string;
}

/**
 * What a candidate is measured against.
 *
 * Deliberately narrower than `EmbeddingProvider`: the gate only ever embeds a
 * fixed probe set, and widening it to a full provider is what made it look as
 * though only a local host could ever hold this position.
 */
export interface CompatibilityReference {
  regime: VerificationRegime;
  /** Named in the refusal, so an operator can see WHAT it disagreed with. */
  name: string;
  embedBatch(texts: string[]): Promise<ArrayLike<number>[]>;
}

/** The reference for every policy where the GPUs serve: a host already
 *  writing rows into the live table. */
export function localReference(p: EmbeddingProvider, name?: string): CompatibilityReference {
  return {
    regime: 'local-ref',
    name: name ?? (p as { getSidecarName?: () => string }).getSidecarName?.() ?? p.getModelName(),
    embedBatch: texts => p.embedBatch(texts),
  };
}

/**
 * The reference under "OpenRouter only": a PEER cloud provider.
 *
 * OpenRouter can route one model slug to different upstreams, so two
 * `<PCName>-OR-*` providers disagreeing with each other is the drift that
 * would poison a cloud-built index. That is what this measures — and it is
 * the only thing left to measure once no local vector is ever written.
 */
export function cloudReference(peer: VirtualContainer): CompatibilityReference {
  return {
    regime: 'cloud-ref',
    name: peer.providerName,
    embedBatch: async texts => {
      // A PROBE, not a batch: ~10 short texts. The 120s default is sized for
      // a rebuild batch, and using it here meant one unreachable provider made
      // the whole verify pass take 134s — a health check that takes over two
      // minutes to say "unhealthy" is not a health check. 15s is generous for
      // ten texts and fails fast on a host that is not answering.
      const PROBE_TIMEOUT_MS = 15_000;
      const res = await virtualEmbed(peer, texts, PROBE_TIMEOUT_MS);
      return res.embeddings ?? [];
    },
  };
}

/**
 * Which cloud provider holds the reference position for `vc`, under
 * "OpenRouter only".
 *
 * Only a provider resolving the SAME model slug is a meaningful peer — two
 * different embedding models are supposed to disagree, and comparing them
 * would refuse a correct configuration for the wrong reason.
 *
 * The anchor rule breaks the circularity. Sort the same-model providers by
 * name; the FIRST is the anchor and is verified with no reference at all
 * (dimension + pin), and every other one is verified against the anchor. So
 * the chain is a star, not a cycle, and it is deterministic across restarts —
 * re-verification lands on the same anchor and the same verdict rather than
 * whichever provider happened to probe first.
 *
 * Returns null when `vc` IS the anchor, or when no same-model peer exists.
 * Both mean "there is nothing to hold this one to"; the caller then runs the
 * dimension-and-pin check, and the verdict records that it did.
 */
export function selectCloudReference(
  vc: VirtualContainer,
  rows: VirtualContainer[],
  isLive: (r: VirtualContainer) => boolean = defaultIsLive,
): VirtualContainer | null {
  const sameModel = rows
    .filter(r => r.model === vc.model)
    .sort((a, b) => a.providerName.localeCompare(b.providerName));
  // Anchor on a peer whose sidecar tunnel is OPEN. On 2026-09-18 three of
  // five hosts were down and the alphabetically-first one (the Mac mini) was
  // among them: every other provider was paired against it, every probe
  // failed with "no WS tunnel", and the two live hosts were refused for a
  // fault that was not theirs. Liveness is a hint, not a filter — when
  // nothing is live (tests, cold boot) fall back to the plain ordering so the
  // verdict is still "probe-failed" (transient) rather than silently absent.
  const live = sameModel.filter(isLive);
  const pool = live.length > 0 ? live : sameModel;
  const anchor = pool[0];
  if (!anchor || anchor.providerName === vc.providerName) return null;
  return anchor;
}

function defaultIsLive(r: VirtualContainer): boolean {
  try { return isSoundSuiteSidecarConnected(r.sidecarId); } catch { return false; }
}

/**
 * Run the gate for one OpenRouter-backed provider. Records a verdict and
 * returns the report either way.
 *
 * `reference` decides what a pass CLAIMS — see the module header. Pass `null`
 * only for the sole-cloud-provider case under "OpenRouter only", where there
 * is no peer and cross-provider consistency is vacuous; dimension and the
 * upstream pin are then the whole check, and the verdict says so.
 *
 * A null reference under the local regime is a programming error and is
 * refused: it would clear a provider for a MIXED table having compared it to
 * nothing.
 */
export async function verifyVectorCompatibility(
  vc: VirtualContainer,
  reference: CompatibilityReference | null,
  expectedDims: number,
  opts: { texts?: string[]; minCosine?: number; regime?: VerificationRegime } = {},
): Promise<CompatibilityReport> {
  const texts = opts.texts ?? PROBE_TEXTS;
  const threshold = opts.minCosine ?? MIN_COMPATIBLE_COSINE;
  const regime: VerificationRegime = reference?.regime ?? opts.regime ?? 'local-ref';
  const key = verdictKey({
    providerName: vc.providerName, model: vc.model, upstreamProvider: vc.upstreamProvider, reference: regime,
  });
  const base = {
    key, providerName: vc.providerName, expectedDims, samples: texts.length,
    reference: regime, referenceName: reference?.name,
  };

  if (!reference && regime === 'local-ref') {
    recordRefusal({
      key, providerName: vc.providerName, kind: 'probe-failed', reference: regime,
      reason: 'no reference embedder was supplied, and under this policy local and cloud vectors share one '
        + 'table — clearing a provider without comparing it to anything is exactly what the gate exists to stop',
    });
    return { ...base, ok: false, reason: 'no reference embedder' };
  }

  // An embedding call without a pinned upstream can be served by two different
  // OpenRouter upstreams on consecutive requests, which silently splits the
  // vector space. The sidecar already fails closed on this; refuse here too so
  // we never even probe a provider we could not trust if it passed. This holds
  // under BOTH regimes, and carries more weight under `cloud-ref`, where a
  // sole provider makes the pin the only drift control left.
  if (!vc.upstreamProvider) {
    recordRefusal({
      key, providerName: vc.providerName, kind: 'no-provider-pin', reference: regime,
      reason: 'no pinned OpenRouter upstream provider — two upstreams serving the same model can return '
        + 'different vectors, so an unpinned embedding route can split the vector space between requests',
    });
    return { ...base, ok: false, reason: 'no pinned upstream provider' };
  }

  let referenceVectors: ArrayLike<number>[] | null = null;
  if (reference) {
    try {
      referenceVectors = await reference.embedBatch(texts);
    } catch (err) {
      recordRefusal({
        key, providerName: vc.providerName, kind: 'probe-failed', reference: regime, referenceName: reference.name,
        reason: `the ${regime === 'cloud-ref' ? 'cloud peer' : 'local'} reference embedder ${reference.name} failed, `
          + `so compatibility could not be established: ${(err as Error).message}`,
      });
      return { ...base, ok: false, reason: `reference embed failed: ${(err as Error).message}` };
    }
  }

  let cloudVectors: number[][];
  let dims: number;
  try {
    // Same reasoning as the peer probe above: fail fast, this is ten texts.
    const res = await virtualEmbed(vc, texts, 15_000);
    cloudVectors = res.embeddings ?? [];
    dims = res.dims ?? cloudVectors[0]?.length ?? 0;
  } catch (err) {
    recordRefusal({
      key, providerName: vc.providerName, kind: 'probe-failed', reference: regime,
      reason: `OpenRouter probe failed: ${(err as Error).message}`,
    });
    return { ...base, ok: false, reason: `openrouter probe failed: ${(err as Error).message}` };
  }

  // Width is mandatory under every regime and never relaxes: the table is one
  // fixed number of columns wide whoever wrote the rows.
  if (dims !== expectedDims) {
    recordRefusal({
      key, providerName: vc.providerName, kind: 'dimension-mismatch', reference: regime,
      reason: `returned ${dims}-dim vectors but the target table is ${expectedDims}-dim`,
      dims,
    });
    return { ...base, ok: false, dims, reason: `dimension ${dims} != ${expectedDims}` };
  }

  if (cloudVectors.length !== texts.length) {
    recordRefusal({
      key, providerName: vc.providerName, kind: 'probe-failed', reference: regime,
      reason: `returned ${cloudVectors.length} vectors for ${texts.length} probe texts`,
      dims,
    });
    return { ...base, ok: false, dims, reason: 'vector count mismatch' };
  }

  if (!referenceVectors) {
    // Sole cloud provider under "OpenRouter only". Nothing to disagree with:
    // it writes every row, so there is no second opinion to hold it to.
    recordVerified({
      key, providerName: vc.providerName, dims, samples: texts.length, reference: regime,
    });
    return { ...base, ok: true, dims, reason: 'sole cloud provider: dimension and upstream pin only' };
  }

  const cosines = texts.map((_, i) => cosine(referenceVectors![i], cloudVectors[i]));
  const minCosine = Math.min(...cosines);
  const meanCosine = cosines.reduce((s, c) => s + c, 0) / cosines.length;

  if (minCosine < threshold) {
    recordRefusal({
      key, providerName: vc.providerName, kind: 'vector-incompatible', reference: regime, referenceName: reference!.name,
      reason: regime === 'cloud-ref'
        ? `pairwise cosine against the cloud peer ${reference!.name} fell to ${minCosine.toFixed(6)}, below the `
          + `${threshold} floor — two OpenRouter providers resolving the same model must agree with each other, `
          + 'or the index they build together is not one vector space'
        : `pairwise cosine against the local reference embedder ${reference!.name} fell to ${minCosine.toFixed(6)}, `
          + `below the ${threshold} floor — its vectors are not interchangeable with the rows already in the table, `
          + 'and mixing them would make cosine distance meaningless for every query',
      minCosine, dims,
    });
    return { ...base, ok: false, minCosine, meanCosine, dims, cosines, reason: `min cosine ${minCosine.toFixed(6)} < ${threshold}` };
  }

  recordVerified({
    key, providerName: vc.providerName, minCosine, meanCosine, dims, samples: texts.length,
    reference: regime, referenceName: reference!.name,
  });
  return { ...base, ok: true, minCosine, meanCosine, dims, cosines, reason: 'compatible' };
}

/**
 * Ensure a provider is cleared, running the gate once if it has no verdict.
 * Concurrent callers share one in-flight probe — otherwise the first fan-out
 * batch would fire N simultaneous probes for the same provider.
 */
const inFlight = new Map<string, Promise<CompatibilityReport>>();

export async function ensureVerified(
  vc: VirtualContainer,
  reference: CompatibilityReference | null,
  expectedDims: number,
  regime: VerificationRegime = reference?.regime ?? 'local-ref',
): Promise<boolean> {
  const key = verdictKey({
    providerName: vc.providerName, model: vc.model, upstreamProvider: vc.upstreamProvider, reference: regime,
  });
  if (isClearedToEmbed(key)) return true;

  let p = inFlight.get(key);
  if (!p) {
    p = verifyVectorCompatibility(vc, reference, expectedDims, { regime }).finally(() => inFlight.delete(key));
    inFlight.set(key, p);
  }
  return (await p).ok;
}

/** Test seam. */
export function __resetVectorCompatibilityForTest(): void {
  inFlight.clear();
  refusals.clear();
  verified.clear();
  probeFailures.clear();
}
