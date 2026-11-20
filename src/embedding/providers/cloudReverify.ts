/**
 * Re-run the vector gate for Fantom's own OpenRouter embedding providers.
 *
 * Since 2026-11-19 Fantom calls OpenRouter itself, so a sidecar reconnect no
 * longer affects the gate. What is left: before a re-embed starts, and on the
 * Verify button, drop TRANSIENT refusals (`probe-failed`: the check could not
 * run, e.g. a network blip or a 429) and check again against stored rows.
 * Verdicts about the vectors themselves (cosine below the floor, wrong width)
 * are kept.
 */
import { clearTransientRefusals, verifyVectorCompatibility, storedReference, type CompatibilityReport } from './vectorCompatibility.js';
import { tableDimsFor, type EmbeddingTarget } from './embeddingProvider.js';

let running: Promise<CompatibilityReport[]> | null = null;

/** Check both embedding roles directly. Coalesces concurrent calls. */
export async function runReverify(reason: string): Promise<CompatibilityReport[]> {
  if (running) return running;
  running = (async () => {
    const t0 = Date.now();
    const reports: CompatibilityReport[] = [];
    try {
      clearTransientRefusals();
      const { hasOpenRouterKey } = await import('../../openrouter/key.js');
      if (!hasOpenRouterKey()) {
        console.log(`[cloud-reverify] skipped (${reason}): no OpenRouter key stored.`);
        return reports;
      }
      const { cloudRoleModel } = await import('../../openrouter/roles.js');
      const { DirectOpenRouterEmbeddingProvider } = await import('../../openrouter/embeddingProvider.js');
      const { sampleStoredRows } = await import('../../openrouter/storedSample.js');
      for (const [role, target] of [['code-embedding', 'code'], ['embedding', 'docs']] as Array<['code-embedding' | 'embedding', EmbeddingTarget]>) {
        const rm = cloudRoleModel(role);
        if (!rm) continue;
        const dims = tableDimsFor(target);
        const p = new DirectOpenRouterEmbeddingProvider({ ...rm, role }, dims);
        const rows = await sampleStoredRows(rm.model);
        reports.push(await verifyVectorCompatibility(
          p, rows.length ? storedReference(rows, `${rows.length} stored rows`) : null, dims, { regime: 'stored-ref' },
        ));
      }
      const ok = reports.filter(r => r.ok).length;
      console.log(`[cloud-reverify] ${reason}: ${ok}/${reports.length} verified in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (err) {
      console.warn(`[cloud-reverify] ${reason}: pass failed — ${(err as Error).message}`);
    } finally {
      running = null;
    }
    return reports;
  })();
  return running;
}
