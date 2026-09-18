/**
 * Authoritative per-project CodeNode counts.
 *
 * The embedder (`buildProjectEmbeddings`) reads its node set from the
 * PER-PROJECT graph db (`.cache/graph/<id>.db`) via `ladybugQuery(projectId, …)`.
 * Coverage math, the embed-missing watchdog, and the auto-embed skip-check must
 * use the SAME source — NOT Prisma `functionCount + typeCount` (which counts a
 * different universe and is inflated, e.g. 411 vs 351 real graph nodes) and NOT
 * the legacy SHARED db (stale/partial). Using mismatched denominators is why
 * coverage never reconciled and the watchdog never went quiet.
 *
 * ── Why this is a snapshot and not a TTL cache ──────────────────────────────
 *
 * A count is one query, but the query needs an OPEN Kuzu connection and the
 * pool holds 8 (`FANTOM_GRAPH_MAX_OPEN`). A pass over 340 projects is ~340
 * opens, each paying Kuzu's per-connection init. Measured from logs/all.log,
 * 2026-09-18: a cold pass takes 45–130s, and there were 52 of them. With a
 * 10-minute in-memory TTL that pass ran INSIDE `/admin/vectors/stats` every
 * ten minutes and on every restart — the dashboard's project list "sat over
 * 30 seconds" exactly that often.
 *
 * Now:
 *  - counts persist in `.cache/projectNodeCounts.json`, each with a
 *    FINGERPRINT of the graph file (mtime+size). A matching fingerprint means
 *    the count is still right, whatever its wall-clock age; a changed file
 *    means "refresh". There is no timer.
 *  - `getProjectNodeCountsNonBlocking()` (the stats route) answers from the
 *    snapshot immediately and queues anything missing/stale for ONE
 *    low-priority background worker (concurrency 1: it must not thrash the
 *    pool while the user is working). The route never waits for a graph open.
 *  - `getProjectNodeCounts()` (embed planning, coverage) stays blocking so its
 *    callers still get a number they can plan on — but a valid snapshot entry
 *    satisfies it without an open, so it is fast for everything that has not
 *    changed.
 *  - `invalidateProjectNodeCount()` is still the write-side hook after a
 *    reindex; it drops the entry and queues a refresh.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ladybugQuery } from './ladybugConnection.js';

interface Entry {
  count: number;
  /** When the count was measured (informational). */
  ts: number;
  /** `${mtimeMs}:${size}` of the graph file at measurement, null if unknown. */
  fingerprint: string | null;
}

const cache = new Map<number, Entry>();
const SNAPSHOT_PATH = path.join(process.cwd(), '.cache', 'projectNodeCounts.json');
let snapshotOverride: string | null = null;
/** Test seam — redirect the snapshot so a test never touches `.cache/`. */
export function __setSnapshotPathForTest(p: string | null): void {
  snapshotOverride = p; cache.clear(); loaded = false;
}
function snapshotPath(): string { return snapshotOverride ?? SNAPSHOT_PATH; }

function graphDbPath(projectId: number): string {
  return path.join(process.cwd(), '.cache', 'graph', `${projectId}.db`);
}
/**
 * SIZE ONLY, not mtime. Kuzu checkpoints when the pooled connection closes,
 * which touches the file's mtime a second or so AFTER our count query — so an
 * mtime fingerprint invalidated itself and the worker re-measured all 340
 * projects forever (532 measurements in the first pass, "stale: 340" at the
 * start of the second). Measured 2026-09-18: a read-only open/close leaves
 * the size byte-identical; a real rebuild does not. Explicit
 * `invalidateProjectNodeCount()` from the graph writers covers the rare
 * same-size rewrite.
 */
function fingerprintOf(projectId: number): string | null {
  try {
    const st = fs.statSync(graphDbPath(projectId));
    return `size:${st.size}`;
  } catch {
    return null;
  }
}

// ── snapshot ────────────────────────────────────────────────────────────────
let loaded = false;
function loadSnapshot(): void {
  if (loaded) return;
  loaded = true;
  try {
    const p = snapshotPath();
    if (!fs.existsSync(p)) return;
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, Entry>;
    for (const [k, v] of Object.entries(raw)) {
      const id = Number(k);
      if (Number.isFinite(id) && typeof v?.count === 'number') cache.set(id, v);
    }
  } catch (err) {
    console.warn('[projectNodeCounts] snapshot unreadable, starting empty:', (err as Error).message);
  }
}
let saveTimer: NodeJS.Timeout | null = null;
function saveSnapshotSoon(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const p = snapshotPath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const out: Record<string, Entry> = {};
      for (const [id, e] of cache) out[String(id)] = e;
      const tmp = `${p}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(out));
      fs.renameSync(tmp, p);
    } catch (err) {
      console.warn('[projectNodeCounts] snapshot save failed:', (err as Error).message);
    }
  }, 1_500);
  saveTimer.unref?.();
}

/** A cached entry is usable when the graph file has not changed since it was
 *  measured. An entry with no fingerprint (file missing at the time) is only
 *  trusted while the file is still missing. */
function isValid(projectId: number, e: Entry | undefined): boolean {
  if (!e) return false;
  return fingerprintOf(projectId) === e.fingerprint;
}

async function measure(projectId: number): Promise<number> {
  const rows = await ladybugQuery<{ c: number }>(
    projectId,
    `MATCH (n:CodeNode {project_id: ${projectId}}) RETURN count(n) AS c`,
  );
  const count = Number(rows[0]?.c ?? 0);
  // Fingerprint AFTER the query: opening the db can touch the file, and the
  // post-open state is what later reads will see.
  cache.set(projectId, { count, ts: Date.now(), fingerprint: fingerprintOf(projectId) });
  saveSnapshotSoon();
  return count;
}

// ── background refresh ──────────────────────────────────────────────────────
const queue = new Set<number>();
let worker: Promise<void> | null = null;
let lastPass: { started: number; finished: number | null; refreshed: number; failed: number } | null = null;

function scheduleRefresh(ids: number[]): void {
  for (const id of ids) queue.add(id);
  if (worker || queue.size === 0) return;
  worker = (async () => {
    const started = Date.now();
    let refreshed = 0, failed = 0;
    lastPass = { started, finished: null, refreshed, failed };
    try {
      while (queue.size > 0) {
        const id = queue.values().next().value as number;
        queue.delete(id);
        // Something may have measured it meanwhile (a blocking caller).
        if (isValid(id, cache.get(id))) continue;
        try { await measure(id); refreshed++; } catch { failed++; }
        lastPass = { started, finished: null, refreshed, failed };
      }
    } finally {
      lastPass = { started, finished: Date.now(), refreshed, failed };
      if (refreshed + failed > 0) {
        console.log(`[projectNodeCounts] background refresh: ${refreshed} measured, ${failed} failed, ${((Date.now() - started) / 1000).toFixed(1)}s`);
      }
      worker = null;
      if (queue.size > 0) scheduleRefresh([]);
    }
  })();
}

/** Drop the cached count for a project — call after a reindex/graph rebuild.
 *  Queues a background re-measure so the next poll already has it. */
export function invalidateProjectNodeCount(projectId: number): void {
  loadSnapshot();
  cache.delete(projectId);
  saveSnapshotSoon();
  scheduleRefresh([projectId]);
}

/** CodeNode count for one project. Blocking: measures if the snapshot is
 *  missing or the graph file changed; otherwise no db open at all. */
export async function getProjectNodeCount(projectId: number): Promise<number> {
  loadSnapshot();
  const hit = cache.get(projectId);
  if (hit && isValid(projectId, hit)) return hit.count;
  try {
    return await measure(projectId);
  } catch {
    return hit?.count ?? 0;
  }
}

/** Batched, BLOCKING per-project counts with bounded concurrency — for callers
 *  that plan work on the number (embed jobs, coverage). Valid snapshot entries
 *  are served without an open, so this is fast for unchanged projects. */
export async function getProjectNodeCounts(
  projectIds: number[],
  concurrency = 3,
): Promise<Map<number, number>> {
  loadSnapshot();
  const out = new Map<number, number>();
  const todo: number[] = [];
  for (const id of projectIds) {
    const hit = cache.get(id);
    if (hit && isValid(id, hit)) out.set(id, hit.count); else todo.push(id);
  }
  let i = 0;
  const run = async (): Promise<void> => {
    while (i < todo.length) {
      const id = todo[i++];
      out.set(id, await getProjectNodeCount(id));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length || 1) }, run));
  return out;
}

export interface NodeCountsStatus {
  /** 'snapshot' when every id was answered from a valid entry; 'partial' when
   *  some were stale/missing and are being refreshed in the background. */
  source: 'snapshot' | 'partial';
  /** Ids answered with a stale value (graph file changed since measured). */
  stale: number;
  /** Ids with no value at all (caller should fall back to Prisma counts). */
  missing: number;
  refreshing: boolean;
  queued: number;
  lastPass: { started: number; finished: number | null; refreshed: number; failed: number } | null;
}

/**
 * NON-BLOCKING per-project counts for the dashboard. Never opens a graph db:
 * valid entries are returned, stale entries are returned as-is (a count from
 * before the last reindex beats a 30s stall), missing ones are 0 — and
 * everything stale/missing is queued for the background worker.
 */
export function getProjectNodeCountsNonBlocking(
  projectIds: number[],
): { counts: Map<number, number>; status: NodeCountsStatus } {
  loadSnapshot();
  const counts = new Map<number, number>();
  const refresh: number[] = [];
  let stale = 0, missing = 0;
  for (const id of projectIds) {
    const hit = cache.get(id);
    if (hit && isValid(id, hit)) { counts.set(id, hit.count); continue; }
    if (hit) { counts.set(id, hit.count); stale++; } else { counts.set(id, 0); missing++; }
    refresh.push(id);
  }
  if (refresh.length) scheduleRefresh(refresh);
  return {
    counts,
    status: {
      source: refresh.length === 0 ? 'snapshot' : 'partial',
      stale, missing,
      refreshing: worker !== null,
      queued: queue.size,
      lastPass,
    },
  };
}
