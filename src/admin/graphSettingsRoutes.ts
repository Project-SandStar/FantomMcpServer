/**
 * /admin/graph/settings — the "Graph" config tab (/dashboard/config/#graph).
 *
 *   GET /graph/settings   knobs (effective value + source + range + apply mode),
 *                         live pool stats, memory and RSS-guard figures
 *   PUT /graph/settings   { <knob>: number | null }  null clears a saved value
 *   GET /graph/storage    graph DB card on the Storage tab: engine, version,
 *                         path, store count, size on disk, open / cap
 *
 * Precedence: saved dashboard value > env var > code default
 * (src/graph/graphSettings.ts). Saving a new pool cap closes idle stores above
 * it at once; busy stores close when their query ends.
 */
import type { Router, Request, Response } from 'express';
import {
  GRAPH_KNOBS, GRAPH_KNOB_NAMES, getSavedGraphSettings, resolveAllGraphKnobs,
  saveGraphSettings, validateGraphPatch, type GraphKnobDef,
} from '../graph/graphSettings.js';
import { resolveRssGuardMb, readContainerMemoryMiB } from '../utils/rssGuard.js';
import { readMemoryLimitMiB } from '../graph/graphPoolSizing.js';

/** Rough RSS per open project store, MiB (pool + engine + mmap), measured on the live host. */
export const EST_MIB_PER_STORE = 105;
/** Warn when the projected RSS passes this share of the guard. */
export const WARN_FRACTION = 0.85;

export interface GraphMemoryWarning {
  level: 'ok' | 'warn' | 'danger';
  projectedMb: number;
  guardMb: number;
  message: string | null;
}

/**
 * Pure: projected RSS if the pool fills to `cap` stores. Base = RSS now minus
 * what the open stores are estimated to hold.
 */
export function graphMemoryWarning(rssMb: number, open: number, cap: number, guardMb: number, perStore = EST_MIB_PER_STORE): GraphMemoryWarning {
  const base = Math.max(0, rssMb - open * perStore);
  const projectedMb = Math.round(base + cap * perStore);
  if (!(guardMb > 0)) return { level: 'ok', projectedMb, guardMb, message: null };
  if (projectedMb >= guardMb) {
    return { level: 'danger', projectedMb, guardMb, message: `A full pool (${cap} x ~${perStore} MB) puts RSS near ${projectedMb} MB, above the ${guardMb} MB guard. The process would exit (137).` };
  }
  if (projectedMb >= guardMb * WARN_FRACTION) {
    return { level: 'warn', projectedMb, guardMb, message: `A full pool (${cap} x ~${perStore} MB) puts RSS near ${projectedMb} MB, within ${Math.round((1 - projectedMb / guardMb) * 100)}% of the ${guardMb} MB guard.` };
  }
  return { level: 'ok', projectedMb, guardMb, message: null };
}

async function buildView() {
  const saved = getSavedGraphSettings();
  const eff = resolveAllGraphKnobs(saved);
  const knobs = GRAPH_KNOB_NAMES.map((name) => {
    const d: GraphKnobDef = GRAPH_KNOBS[name];
    return {
      name, env: d.env, label: d.label, help: d.help, apply: d.apply,
      min: d.min, max: d.max, step: d.step ?? (d.integer ? 1 : undefined), integer: d.integer,
      default: d.def, autoLabel: d.autoLabel ?? null,
      saved: saved[name] ?? null,
      envValue: process.env[d.env] ?? null,
      value: eff[name].value, source: eff[name].source,
    };
  });
  const { getProjectConnectionPoolStats } = await import('../graph/projectGraphConnection.js');
  const pool = getProjectConnectionPoolStats();
  const rssMb = Math.round(process.memoryUsage().rss / 1048576);
  const guardMb = resolveRssGuardMb();
  const pools = pool.entries.map(e => e.poolMiB).filter((n): n is number => typeof n === 'number');
  return {
    knobs,
    pool: {
      open: pool.open, cap: pool.cap, opens: pool.opens, evictions: pool.evictions, reopens: pool.reopens,
      closeFailures: pool.closeFailures,
      busy: pool.entries.filter(e => e.inFlight > 0).length,
      poolMiBTotal: pools.reduce((a, b) => a + b, 0),
      entries: pool.entries.map(e => ({ projectId: e.projectId, lastUsedAgoMs: e.lastUsedAgoMs, inFlight: e.inFlight, degraded: e.degraded, poolMiB: e.poolMiB })),
    },
    memory: {
      rssMb,
      containerMb: readContainerMemoryMiB(),
      memLimitMb: readMemoryLimitMiB(),
      guardMb,
      estMbPerStore: EST_MIB_PER_STORE,
      approxMbPerOpenStore: pool.open > 0 ? Math.round(rssMb / pool.open) : null,
      warning: graphMemoryWarning(rssMb, pool.open, pool.cap, guardMb),
    },
  };
}

export function registerGraphSettingsRoutes(router: Router): void {
  router.get('/graph/storage', async (_req: Request, res: Response): Promise<void> => {
    try {
      const { getGraphStorageInfo } = await import('../graph/graphStorageInfo.js');
      const { getProjectConnectionPoolStats } = await import('../graph/projectGraphConnection.js');
      const pool = getProjectConnectionPoolStats();
      res.json({ ...getGraphStorageInfo(), pool: { open: pool.open, cap: pool.cap } });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/graph/settings', async (_req: Request, res: Response): Promise<void> => {
    try {
      res.json(await buildView());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/graph/settings', async (req: Request, res: Response): Promise<void> => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'body must be an object of { setting: number | null }' });
      return;
    }
    const { problems, next } = validateGraphPatch(body as Record<string, unknown>, getSavedGraphSettings());
    if (problems.length) { res.status(400).json({ error: problems.join('; '), problems }); return; }
    try {
      saveGraphSettings(next);
      res.json(await buildView());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
