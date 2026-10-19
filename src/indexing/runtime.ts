/**
 * Boot wiring for lazy indexing (lazy-incremental-indexing.md section 4).
 * src/index.ts calls startLazyIndexing() once the boot code index is ready
 * and stopLazyIndexing() on shutdown; everything else lives in this folder.
 *
 * The scheduler is created even with the flag off: it re-reads the config
 * every 30 s, so `indexing.lazy.enabled = true` takes effect without a
 * restart, and `false` stops the watchers and workers (rollback, section 5).
 */

import type { PrismaClient } from '@prisma/client';
import { createLogger } from '../utils/index.js';
import { LazyIndexScheduler } from './scheduler.js';

const logger = createLogger('lazy-index');
let scheduler: LazyIndexScheduler | null = null;

export function getLazyIndexScheduler(): LazyIndexScheduler | null { return scheduler; }

export async function startLazyIndexing(prisma: PrismaClient): Promise<LazyIndexScheduler> {
  if (scheduler) return scheduler;
  const [{ runIndex, runPatch, setLazyEmbedEnqueuer }, { getFantomDatabase }, embedGate, { isProjectIndexing }, { loadLazyConfig }] = await Promise.all([
    import('../fantom-code/runIndex.js'),
    import('../fantom/database.js'),
    import('../embedding/embedGate.js'),
    import('../fantom-code/activeIndexing.js'),
    import('./lazyConfig.js'),
  ]);
  const db = getFantomDatabase();
  scheduler = new LazyIndexScheduler({
    prisma,
    worker: {
      runIndex: (projectId, opts) => runIndex(db, prisma, projectId, opts),
      runPatch: (projectId, opts) => runPatch(prisma, projectId, opts),
      graphPatchEnabled: () => loadLazyConfig().graphPatch.enabled !== false,
      buildEmbeddings: async projectId => {
        const { getSemanticSearchService } = await import('../embedding/semanticSearchService.js');
        return getSemanticSearchService(prisma).buildProjectEmbeddings(projectId);
      },
      heavyJobBusy: () => {
        const h = embedGate.getHeavyJob();
        if (h) return `${h.kind} (${h.label})`;
        return embedGate.isShadowReembedActive() ? 'vector rebuild' : null;
      },
      isProjectIndexing,
      vectorGc: async projectId => {
        const { gcVectors, liveOrphanDeps } = await import('./embedPatch.js');
        return gcVectors(liveOrphanDeps(prisma), projectId);
      },
      cachePrune: async () => {
        const { getEmbedCache, embedCacheCapBytes } = await import('../embedding/embedCache.js');
        const cap = await embedCacheCapBytes(loadLazyConfig().embedPatch?.cacheMaxMb ?? 0);
        return { capBytes: cap, ...(await getEmbedCache().prune(cap)) };
      },
      rekey: async projectId => {
        const [{ runRekey }, { getLanceTable }, { getEmbedCache }, { KEY_SCHEME_STABLE }] = await Promise.all([
          import('./rekeyMigration.js'),
          import('../embedding/lanceConnection.js'),
          import('../embedding/embedCache.js'),
          import('../fantom-code/symbolKey.js'),
        ]);
        return runRekey({
          prisma,
          vectors: getLanceTable,
          cache: getEmbedCache(),
          reindex: async (id, onSymbolKeys) => {
            const r = await runIndex(db, prisma, id, {
              trigger: 'manual', force: true, buildGraph: true, buildEmbeddings: false,
              keyScheme: KEY_SCHEME_STABLE, onSymbolKeys,
            });
            return { runId: r.runId ?? null, errors: r.indexResult.errors };
          },
          acquireHeavy: label => {
            if (embedGate.isShadowReembedActive()) return 'vector rebuild';
            try { return embedGate.acquireHeavyJob('code-reindex', label); } catch (err) {
              return err instanceof Error ? err.message : String(err);
            }
          },
        }, projectId);
      },
    },
  });
  setLazyEmbedEnqueuer((projectId, runId) => scheduler ? scheduler.enqueueEmbed(projectId, runId) : Promise.resolve(false));
  try {
    await scheduler.start();
  } catch (err) {
    logger.warn(`[lazy-index] start failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return scheduler;
}

export async function stopLazyIndexing(): Promise<void> {
  if (!scheduler) return;
  const { setLazyEmbedEnqueuer } = await import('../fantom-code/runIndex.js');
  setLazyEmbedEnqueuer(null);
  await scheduler.stop();
  scheduler = null;
}
