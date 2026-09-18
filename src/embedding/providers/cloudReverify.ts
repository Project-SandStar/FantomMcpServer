/**
 * Re-verify the cloud embedding pool when the fleet comes back.
 *
 * ── The failure this removes ─────────────────────────────────────────────
 *
 * Every server restart drops all five sidecar WS tunnels. If anything asks
 * for a cloud provider in the seconds before they reconnect, the compatibility
 * gate probes, gets `virtual-embed: no WS tunnel to the sidecar`, and records
 * that as a REFUSAL. The refusal is sticky — that is correct for "cosine below
 * the floor", which is a fact about the provider — but it is wrong for "I
 * could not reach it just now", which is a fact about the moment.
 *
 * So the tunnels came back and the gate stayed shut, and every search and ask
 * returned "no OpenRouter-backed provider has passed the vector-compatibility
 * gate" until someone hand-ran a re-verify. That happened five times in one
 * session, after every dev-mode restart. The recovery was the same each time
 * and it was never anything a person should have had to do.
 *
 * ── What this does ───────────────────────────────────────────────────────
 *
 * When a sidecar registers, drop only the TRANSIENT refusals — kind
 * `probe-failed`, which is "the check could not run" — and schedule a
 * re-verification. Verdicts about the vectors themselves are kept: a provider
 * that disagreed with its peer at 0.976 is still wrong after it reconnects.
 *
 * Debounced, because after a restart all five register within seconds and
 * five back-to-back verify passes would each probe five providers. One pass,
 * a few seconds after the last register, is the right amount of work.
 */

import { listVirtualContainers } from '../../sidecars/virtualContainers.js';
import {
  clearTransientRefusals, verifyVectorCompatibility, cloudReference, selectCloudReference,
} from './vectorCompatibility.js';
import { embeddingRoutingPolicy, tableDimsFor } from './embeddingProvider.js';

/** Wait this long after the LAST register before verifying, so a fleet that
 *  reconnects in a burst is verified once, not once per sidecar. */
const DEBOUNCE_MS = 8_000;

let timer: NodeJS.Timeout | null = null;
let running: Promise<void> | null = null;
let pendingReasons: string[] = [];

/** Called from the WS register handler. Cheap; the work is deferred. */
export function onSidecarReconnected(sidecarName: string): void {
  const cleared = clearTransientRefusals();
  if (cleared > 0) {
    console.log(
      `[cloud-reverify] ${sidecarName} registered — cleared ${cleared} transient refusal(s) `
      + '(probe-failed) so the pool is re-checked rather than left shut on a stale "no tunnel".',
    );
  }
  pendingReasons.push(sidecarName);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const reasons = pendingReasons;
    pendingReasons = [];
    void runReverify(`reconnect: ${[...new Set(reasons)].join(', ')}`);
  }, DEBOUNCE_MS);
}

/**
 * One verification pass over the cloud embedding pool, cloud-reference regime.
 *
 * Mirrors the cloud-only branch of POST /admin/sidecars/virtual/verify. Only
 * the cloud-ref regime is run here on purpose: under a GPU-serving policy the
 * gate compares cloud against a LOCAL host, and a reconnect does not change
 * which local host is the reference — the route handles that case when an
 * operator asks. Under "OpenRouter only", which is the live configuration,
 * a reconnect is exactly the event that should re-open the gate.
 */
export async function runReverify(reason: string): Promise<void> {
  if (running) return running; // coalesce: a pass already in flight covers this
  running = (async () => {
    const t0 = Date.now();
    try {
      let cloudOnly = false;
      try { cloudOnly = !(await embeddingRoutingPolicy('code')).localServes; } catch { /* below */ }
      if (!cloudOnly) {
        console.log(`[cloud-reverify] skipped (${reason}): policy is not "OpenRouter only", the gate compares against a local reference.`);
        return;
      }
      const rows = listVirtualContainers('code-embedding');
      if (rows.length === 0) {
        console.log(`[cloud-reverify] skipped (${reason}): no cloud-routable code-embedding provider registered yet.`);
        return;
      }
      const expectedDims = tableDimsFor('code');
      // Anchor order — the same pairing the fan-out uses.
      const ordered = [...rows].sort((a, b) => a.providerName.localeCompare(b.providerName));
      let ok = 0;
      for (const vc of ordered) {
        const peer = selectCloudReference(vc, ordered);
        const rep = await verifyVectorCompatibility(vc, peer ? cloudReference(peer) : null, expectedDims, { regime: 'cloud-ref' });
        if (rep.ok) ok++;
      }
      console.log(`[cloud-reverify] ${reason}: ${ok}/${ordered.length} verified in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (err) {
      console.warn(`[cloud-reverify] ${reason}: pass failed — ${(err as Error).message}`);
    } finally {
      running = null;
    }
  })();
  return running;
}
