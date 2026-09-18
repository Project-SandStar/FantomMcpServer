/**
 * Per-Project LadybugDB Connection Manager (C1 of the per-project graph
 * migration — see specs/per-project-graph-migration.md).
 *
 * Today: this module is ADDITIVE. The existing singleton at
 * src/graph/ladybugConnection.ts is unchanged; nothing yet routes through
 * here. Subsequent commits (C2-C4) wave-convert callers to use
 * `projectQuery(projectId, cypher)` etc., at which point this becomes
 * the only graph-DB connection layer.
 *
 * Shape: Map<projectId, Entry> with LRU eviction. One Kuzu/LadybugDB per
 * project, located at `<installRoot>/.cache/graph/<projectId>.db`.
 *
 * Why per-project:
 *  - Eliminates lock contention between concurrent reindexes on different
 *    projects (the round-9 pain class).
 *  - Localizes IO panics / corruption — one bad DB does not poison all 241.
 *  - Hash collisions across projects become impossible (per-DB id namespace).
 *  - Drop-project becomes `rm -rf <pid>.db`, not Cypher DELETE traversals.
 *  - Schema migration scales linearly via lazy schema init at first use.
 *
 * Engine: LadybugDB (`@ladybugdb/core`), v0.16.x. A maintained Kuzu fork.
 * If we ever swap engines, only the internals of this module need to
 * change — the `projectQuery(pid, cypher)` interface stays.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Database, Connection } from '@ladybugdb/core';
import { createLogger } from '../utils/index.js';
import { getCachePath } from '../utils/installRoot.js';

const logger = createLogger('project-graph-conn');

interface Entry {
  projectId: number;
  database: InstanceType<typeof Database>;
  connection: InstanceType<typeof Connection>;
  /** Promise that resolves once the project's schema is initialized.
   *  Awaited by every query so the first writer doesn't race the schema. */
  schemaReady: Promise<void>;
  lastUsed: number;
  inFlight: number;
  /** Per-connection serialization gate. Each Kuzu `Database` owns ONE fixed
   *  buffer pool; concurrent queries on the same `Connection` each PIN frames,
   *  and when their combined pinned working set exceeds the pool the buffer
   *  manager throws "buffer pool is full and no memory could be freed" (every
   *  frame is pinned, so nothing is evictable). Verified empirically: 8 hot
   *  queries fired via Promise.all on one 24 MiB connection reproduce the
   *  exact production OOM; chaining them through this gate clears it. So all
   *  query/execute work for a project is run strictly one-at-a-time by tail-
   *  chaining onto this promise. Kuzu's own threading still parallelizes a
   *  single query internally; we only forbid OVERLAPPING queries. */
  queryGate: Promise<unknown>;
  /** Hits incremented on degradation; once tripped, queries fail fast. */
  degraded: boolean;
  degradedReason: string | null;
  pidfile: string;
  dbPath: string;
}

const entries = new Map<number, Entry>();

/** Default cap on simultaneously-open project DBs. Each entry holds a native
 *  file handle + Kuzu lock + buffer manager + virtual mmap. The old cap of 2
 *  was set when nothing reaped idle connections; now evictLruIfNeeded reaps ALL
 *  idle ones, so boot hydration (sequential, reaped between projects) stays at
 *  ~1-2 regardless. The cap only bounds the CONCURRENT working set — and the
 *  big one is a cross-project RLM `ask`, whose enrichment touches up to topK
 *  (~8) distinct projects at once; at cap=2 it thrashed (open/evict/reopen) and
 *  the query timed out. 16 fits that working set + embedding concurrency. The
 *  64 MiB pools are lazily resident (enrichment count-queries barely fill them;
 *  only a full rebuild does, and that's one project at a time), so the real RSS
 *  cost is far below 16×64 MiB. Tunable via FANTOM_GRAPH_MAX_OPEN. */
const DEFAULT_MAX_OPEN = 16;
function getMaxOpen(): number {
  const raw = process.env.FANTOM_GRAPH_MAX_OPEN;
  if (!raw) return DEFAULT_MAX_OPEN;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_OPEN;
}

function isIoError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /IO exception|Cannot read from file|Could not set lock|Corrupted wal/i.test(
    msg,
  );
}

function getProjectDbPath(projectId: number): string {
  if (!Number.isInteger(projectId) || projectId <= 0) {
    throw new Error(
      `getProjectDbPath: projectId must be a positive integer, got ${projectId}`,
    );
  }
  // Subdir keeps all project DBs under one parent so `rm -rf .cache/graph`
  // is a clean reset.
  const dir = getCachePath('graph');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${projectId}.db`);
}

/** All on-disk files Kuzu may leave next to <id>.db (WAL, WAL checkpoint marker, shadow-paging, tmp, pidfile). */
function projectDbSiblings(dbPath: string): string[] {
  // `.wal.checkpoint` is written during checkpointing; a process killed mid-way
  // leaves it truncated (seen: 9 bytes) and every subsequent open fails with
  // "Reading past the end of the file … .wal.checkpoint". It MUST be purged
  // with the rest or the recreated DB inherits the same failure.
  return [dbPath, `${dbPath}.wal`, `${dbPath}.wal.checkpoint`, `${dbPath}.shadow`, `${dbPath}.tmp`, `${dbPath}.pid`];
}

/**
 * Delete a project's graph DB and ALL Kuzu sidecar files. Used to recover from
 * an unrecoverable DB (e.g. an un-replayable WAL after an interrupted write →
 * "IO exception: Cannot open file …<id>.db.shadow: No such file or directory").
 * The code graph is regenerable from source, so this is lossless once the
 * project is reindexed/rebuilt.
 */
function purgeProjectDbFiles(projectId: number): void {
  const dbPath = getProjectDbPath(projectId);
  for (const f of projectDbSiblings(dbPath)) {
    try {
      if (fs.existsSync(f)) fs.rmSync(f, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
}

/**
 * Distinguish on-disk corruption we can recover from by delete+rebuild from a
 * transient lock held by another live process (which must NOT trigger a purge).
 */
function isUnrecoverableDbError(msg: string): boolean {
  // Never purge on a live-process lock — that's contention, not corruption.
  if (/\block\b|another .*process|already (open|in use)|held by pid/i.test(msg)) return false;
  // Match ONLY true on-disk corruption signatures seen on OPEN. Deliberately
  // narrow: a bare "IO exception" / "cannot open file" can be a transient mmap
  // or filesystem hiccup, and purging a healthy graph on that loses real data
  // (it has to be rebuilt from source). The canonical interrupted-WAL symptom
  // is the missing shadow-paging file (".shadow"); a truncated WAL checkpoint
  // marker surfaces as "Reading past the end of the file …<id>.db.wal.checkpoint";
  // the rest are explicit corruption markers.
  return /\.shadow|\.wal\.checkpoint|reading past the end of the file|unexpected end of file|wal.*(replay|recover|corrupt)|corrupt|checksum|truncated|malformed|database is (invalid|damaged)/i.test(msg);
}

/**
 * Projects whose graph DB was auto-reset to empty after corruption — they need
 * their graph rebuilt from source before they hold meaningful data. The
 * auto-embed pipeline consumes this to self-heal (rebuild then embed).
 */
const projectsNeedingGraphRebuild = new Set<number>();
export function projectNeedsGraphRebuild(projectId: number): boolean {
  return projectsNeedingGraphRebuild.has(projectId);
}
export function clearProjectGraphRebuildFlag(projectId: number): void {
  projectsNeedingGraphRebuild.delete(projectId);
}

/**
 * Pre-flight pidfile check. Per-project: two processes touching DIFFERENT
 * projects no longer conflict, only same-project access does. Returns the
 * pidfile path so the caller can write its own PID after the lock acquires.
 *
 * Throws "Another fantom-mcp process holds project N" with an actionable
 * message instead of letting the user discover the problem via opaque
 * native panics.
 */
function checkProjectPidfile(projectId: number, dbPath: string): string {
  const pidfile = `${dbPath}.pid`;
  try {
    if (fs.existsSync(pidfile)) {
      const recorded = parseInt(fs.readFileSync(pidfile, 'utf-8').trim(), 10);
      if (!Number.isNaN(recorded) && recorded !== process.pid) {
        let alive = false;
        try {
          process.kill(recorded, 0);
          alive = true;
        } catch {
          alive = false;
        }
        if (alive) {
          throw new Error(
            `Another fantom-mcp process (PID ${recorded}) holds the LadybugDB ` +
              `lock for project ${projectId} at ${dbPath}. Stop it first ` +
              `(kill ${recorded}) or scope your work to a different project.`,
          );
        }
        // Stale pidfile — fall through and overwrite.
      }
    }
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.startsWith('Another fantom-mcp process')
    ) {
      throw err;
    }
    // Read failures are non-fatal — assume no live owner.
  }
  return pidfile;
}

/**
 * Evict the least-recently-used entry that isn't currently serving a query.
 * If all entries are busy, returns false; the caller proceeds beyond cap
 * (preferable to throwing on a hot path).
 */
// Close-failure counters (surfaced via getProjectConnectionPoolStats).
const closeFailures = { connection: 0, database: 0 };
let closesSinceGc = 0;

async function evictLruIfNeeded(): Promise<void> {
  const max = getMaxOpen();
  // Reap ALL idle connections above the cap, not just one. Previously we closed
  // a single victim per call, so a burst of opens (boot hydration over 241
  // projects, or getProjectNodeCounts over 243) accumulated idle connections
  // far past the cap — each pins a 64 MiB Kuzu buffer pool, so ~140 open →
  // "Buffer manager exception: the buffer pool is full and no memory could be
  // freed". Looping keeps the live set near the cap.
  while (entries.size >= max) {
    let victim: Entry | null = null;
    for (const e of entries.values()) {
      if (e.inFlight > 0) continue;
      if (!victim || e.lastUsed < victim.lastUsed) victim = e;
    }
    if (!victim) {
      logger.debug(
        `LRU eviction: all ${entries.size} project connections busy ` +
          `(cap ${max}); proceeding above cap until traffic settles.`,
      );
      return;
    }
    await closeProjectConnection(victim.projectId);
  }
}

/**
 * Schema DDL — same shape as the single-DB version in ladybugSchema.ts but
 * scoped to one project's DB. Idempotent; CREATE TABLE IF NOT EXISTS.
 * Kept here (not imported) so this module is self-contained — when C2 lands
 * and `ladybugSchema.ts` becomes per-project too, we can dedupe.
 */
const PROJECT_SCHEMA_DDL: string[] = [
  `CREATE NODE TABLE IF NOT EXISTS CodeNode(
    id STRING,
    project_id INT64,
    node_type STRING,
    name STRING,
    qualified_name STRING,
    file_path STRING,
    line_start INT64,
    line_end INT64,
    col_start INT64,
    col_end INT64,
    signature STRING,
    documentation STRING,
    return_type STRING,
    modifiers STRING,
    facets STRING,
    parent_type STRING,
    is_public BOOLEAN,
    is_static BOOLEAN,
    is_abstract BOOLEAN,
    is_virtual BOOLEAN,
    is_override BOOLEAN,
    is_exported BOOLEAN,
    language STRING,
    PRIMARY KEY (id)
  )`,
  `CREATE REL TABLE IF NOT EXISTS CodeEdge(
    FROM CodeNode TO CodeNode,
    edge_type STRING,
    line_number INT64,
    col_number INT64,
    is_resolved BOOLEAN,
    confidence DOUBLE,
    metadata STRING,
    cross_language BOOLEAN
  )`,
];

/**
 * Lightweight, idempotent migrations to run after the base DDL — covers
 * columns added to existing tables after the DB was first created. Each
 * step must tolerate both "column already exists" and "table does not yet
 * exist" without aborting the others.
 */
const PROJECT_SCHEMA_MIGRATIONS: string[] = [
  `ALTER TABLE CodeEdge ADD cross_language BOOLEAN DEFAULT false`,
];

async function initProjectSchema(conn: InstanceType<typeof Connection>): Promise<void> {
  for (const ddl of PROJECT_SCHEMA_DDL) {
    try {
      await conn.query(ddl);
    } catch (err) {
      const msg = String(err);
      if (msg.includes('already exists')) continue;
      throw err;
    }
  }
  for (const ddl of PROJECT_SCHEMA_MIGRATIONS) {
    try {
      await conn.query(ddl);
    } catch (err) {
      const msg = String(err).toLowerCase();
      // Kuzu reports column-already-exists in several phrasings depending on
      // version — accept any of them, only re-raise truly unexpected errors.
      if (
        msg.includes('already exists') ||
        msg.includes('already has property') ||
        msg.includes('duplicate')
      ) continue;
      // Some Kuzu versions don't support ALTER on REL TABLE at all; that's
      // not fatal — the column write will fail and we'll handle it there.
      if (msg.includes('not supported') || msg.includes('syntax')) continue;
      throw err;
    }
  }
}

/**
 * Get or open the connection for a specific project. Creates the entry,
 * runs schema init, and writes the pidfile on first acquire. Subsequent
 * calls return the cached connection.
 */
export async function getProjectConnection(
  projectId: number,
): Promise<InstanceType<typeof Connection>> {
  const existing = entries.get(projectId);
  if (existing) {
    if (existing.degraded) {
      throw new Error(
        `Project ${projectId} graph DB degraded: ${existing.degradedReason ?? 'unknown'}`,
      );
    }
    existing.lastUsed = Date.now();
    return existing.connection;
  }

  await evictLruIfNeeded();

  const dbPath = getProjectDbPath(projectId);
  const pidfile = checkProjectPidfile(projectId, dbPath);

  let database: InstanceType<typeof Database>;
  let connection: InstanceType<typeof Connection>;
  const openDatabase = async (): Promise<{ database: InstanceType<typeof Database>; connection: InstanceType<typeof Connection> }> => {
    // Cap the virtual mapping per-project DB. Kuzu's default reserves
    // 8 TiB (2^43 bytes) of sparse mmap; the previous 4 GiB cap was still
    // 16× too generous for our per-project workload (>95% of project
    // graphs are <50 MB). On macOS, every reserved mmap region — even
    // when only sparsely populated — contributes to the kernel's memory
    // pressure calculation, and Jetsam silently SIGKILLs the largest
    // non-foreground process when transient pressure spikes during embed.
    // 256 MiB still gives 5× headroom over the largest observed graph
    // (~50 MB for 2.5k-node fantom.compiler) and drops total reserved
    // virtual address space from ~800 GiB across 200 DBs to ~50 GiB.
    // Override via FANTOM_GRAPH_DB_MAX_MIB env if a project ever exceeds.
    const maxMiBEnv = Number(process.env.FANTOM_GRAPH_DB_MAX_MIB);
    const PROJECT_DB_MAX_SIZE = (Number.isFinite(maxMiBEnv) && maxMiBEnv > 0 ? maxMiBEnv : 256) * 1024 * 1024;
    // Buffer pool sizing is a tug-of-war: too small → "Buffer manager: buffer
    // pool is full" on heavier queries; too large × the open-connection cap
    // (16) → ~1 GB of native buffers and macOS Jetsam SIGKILLs the process
    // during boot hydration. 24 MiB × 16 ≈ 384 MiB is the balance — small
    // enough to survive Jetsam, and transient pool-full errors now self-heal
    // via projectQuery's free-idle-and-retry. Override via FANTOM_GRAPH_DB_BUFFER_MIB.
    const bufMiBEnv = Number(process.env.FANTOM_GRAPH_DB_BUFFER_MIB);
    const PROJECT_DB_BUFFER_SIZE = (Number.isFinite(bufMiBEnv) && bufMiBEnv > 0 ? bufMiBEnv : 24) * 1024 * 1024;
    const db = new Database(
      dbPath,
      PROJECT_DB_BUFFER_SIZE,
      true,                  // enableCompression
      false,                 // readOnly
      PROJECT_DB_MAX_SIZE,
    );
    await db.init();
    const conn = new Connection(db);
    await conn.init();
    return { database: db, connection: conn };
  };
  try {
    ({ database, connection } = await openDatabase());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isUnrecoverableDbError(msg)) {
      // SELF-HEAL: the on-disk DB is corrupt/unrecoverable — typically an
      // un-replayable WAL from an interrupted write ("Cannot open …<id>.db.shadow").
      // Instead of throwing on every open (a 60s crash loop), purge the DB +
      // all Kuzu sidecars and retry once with a fresh empty DB. The graph is
      // regenerable; we flag the project so the auto-embed pipeline rebuilds it
      // from source on its next pass.
      logger.warn(`Project ${projectId} DB unrecoverable (${msg}); purging corrupt files and recreating empty`);
      purgeProjectDbFiles(projectId);
      projectsNeedingGraphRebuild.add(projectId);
      try {
        ({ database, connection } = await openDatabase());
        logger.warn(`Project ${projectId} graph DB reset to EMPTY after corruption — flagged for rebuild from source`);
      } catch (err2) {
        const msg2 = err2 instanceof Error ? err2.message : String(err2);
        logger.error(`Project ${projectId} DB still unreadable after reset: ${msg2}`);
        throw err2;
      }
    } else {
      logger.error(`Failed to open project ${projectId} DB at ${dbPath}: ${msg}`);
      throw err;
    }
  }
  fs.writeFileSync(pidfile, String(process.pid), 'utf-8');

  // Lazy schema init — the first query awaits this. Storing the promise
  // (not awaiting it here) lets us race-protect: every query awaits the
  // SAME promise, so the second writer can't bypass schema readiness.
  const schemaReady = initProjectSchema(connection).catch((err) => {
    logger.error(`Schema init failed for project ${projectId}: ${err}`);
    throw err;
  });

  const entry: Entry = {
    projectId,
    database,
    connection,
    schemaReady,
    lastUsed: Date.now(),
    inFlight: 0,
    queryGate: Promise.resolve(),
    degraded: false,
    degradedReason: null,
    pidfile,
    dbPath,
  };
  entries.set(projectId, entry);
  const mem = process.memoryUsage();
  const rssMb = Math.round(mem.rss / 1024 / 1024);
  const heapMb = Math.round(mem.heapUsed / 1024 / 1024);
  logger.info(`LadybugDB connection opened for project ${projectId} at ${dbPath} | open=${entries.size} rss=${rssMb}MB heap=${heapMb}MB`);
  // Mirror to crash log so silent SIGKILLs (Jetsam OOM under mmap pressure)
  // leave us a breadcrumb identifying the last opened connection. Routed
  // through logSink so the master debug toggle gates this write.
  try {
    const { crashWrite } = await import('../utils/logSink.js');
    crashWrite('LADYBUG_OPEN', `project=${projectId} open=${entries.size} rss=${rssMb}MB heap=${heapMb}MB path=${dbPath}`);
  } catch { /* swallow */ }
  return connection;
}

/** A Kuzu buffer-manager OOM ("buffer pool is full and no memory could be
 *  freed"). NOTE: this is NOT recoverable by freeing other connections' pools
 *  or GC — each Database's pool is independent and construction-fixed. The real
 *  cause is concurrent queries pinning frames on one connection; `runSerialized`
 *  prevents that. We keep this predicate only to log the residual single-query
 *  case distinctly. */
function isBufferPoolError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /buffer pool is full|Buffer manager exception|Unable to allocate memory/i.test(m);
}

/**
 * Run `op` against a project entry with STRICT per-connection serialization.
 *
 * ROOT CAUSE this guards against (verified by reproduction, not theory): a
 * Kuzu/LadybugDB `Database` owns ONE fixed-size buffer pool. Two queries
 * running concurrently on the same `Connection` each pin buffer frames; the
 * union of their pinned frames can exceed the 24 MiB pool, and because every
 * frame is pinned by a live query NOTHING is evictable → the buffer manager
 * throws "Unable to allocate memory! The buffer pool is full and no memory
 * could be freed!". This is NOT helped by freeing OTHER projects' pools or by
 * `global.gc()` (each Database's pool is independent and construction-fixed),
 * and `spill_to_disk` does NOT cover this case either (empirically verified —
 * spill only spills column-chunk scans, not the concurrent pinned set).
 *
 * The fix is to never let two operations overlap on one connection: every
 * op tail-chains onto `entry.queryGate`. Kuzu still parallelizes a single
 * query across its own worker threads; we only forbid OVERLAP. Serializing
 * is correct (not merely safe) because a single project's graph DB has no
 * cross-query transaction that benefits from interleaving here.
 */
async function runSerialized<R>(
  projectId: number,
  op: (entry: Entry) => Promise<R>,
): Promise<R> {
  const entry = await getEntryForQuery(projectId);
  await entry.schemaReady;
  // Reserve the in-flight slot NOW, while we wait in the queue — not when the
  // op starts. The LRU evictor skips entries with inFlight > 0, but an op that
  // was queued behind another had inFlight 0 until its turn; under boot
  // hydration (pool above cap) the entry could be evicted in that window and
  // the op then ran on a closed connection ("Connection is closed.").
  entry.inFlight++;
  const run = async (): Promise<R> => {
    // The reservation above keeps the LRU evictor away, but an explicit close
    // (boot hydration's closeProjectGraphDatabase, resetProjectGraphDatabase)
    // drains for at most 5 s and then closes regardless. If our entry is no
    // longer the live one by the time we run, re-acquire a fresh connection
    // instead of querying a closed one ("Connection is closed.").
    let live = entry;
    if (entries.get(projectId) !== entry) {
      entry.inFlight = Math.max(0, entry.inFlight - 1);
      live = await getEntryForQuery(projectId);
      await live.schemaReady;
      live.inFlight++;
      logger.debug(`[projectGraph] project ${projectId}: connection replaced while queued; re-acquired`);
    }
    try {
      const out = await op(live);
      live.lastUsed = Date.now();
      return out;
    } catch (err) {
      if (isBufferPoolError(err)) {
        // With serialization in place this should be unreachable for normal
        // workloads; if it still fires, the SINGLE query's own working set
        // genuinely exceeds the pool — log loudly so it surfaces as a real
        // signal rather than being masked by a retry that cannot help.
        logger.error(
          `[projectGraph] buffer-pool OOM on project ${projectId} even under ` +
            `serialization — a single query's working set exceeds the ` +
            `${process.env.FANTOM_GRAPH_DB_BUFFER_MIB ?? 24} MiB pool.`,
        );
      } else if (isIoError(err)) {
        markProjectDegraded(projectId, err);
      }
      throw err;
    } finally {
      live.inFlight = Math.max(0, live.inFlight - 1);
    }
  };
  // Tail-chain: wait for whatever is already queued/running on this connection,
  // then run. `.then(run, run)` ensures we proceed even if the prior op
  // rejected. We advance the gate to our own settlement (success OR failure)
  // so a thrown query never wedges the chain.
  const next = entry.queryGate.then(run, run);
  entry.queryGate = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export async function projectQuery<T = Record<string, unknown>>(
  projectId: number,
  cypher: string,
): Promise<T[]> {
  return runSerialized(projectId, async (entry) => {
    const result = await entry.connection.query(cypher);
    const qr = Array.isArray(result) ? result[0] : result;
    try {
      const rows = await qr.getAll();
      return rows as T[];
    } finally {
      // CRITICAL: a QueryResult pins buffer-manager pages until closed. Leaving
      // it open leaks those pins; across the ~dozens of graph queries in one
      // `ask`/enrichment pass they accumulate until the 24 MiB per-project pool
      // is exhausted → "Buffer manager exception: buffer pool is full and no
      // memory could be freed" — even fully serialized (the pins are the leak,
      // not concurrency). Empirically: 37 unclosed queries OOM a 24 MiB pool;
      // closing each lets 200+ run. Close ALL results when query() returns an
      // array (multi-statement) too, not just the first.
      closeResults(result);
    }
  });
}

/** Close every QueryResult a query() call produced (array = multi-statement),
 *  releasing its pinned buffer-manager pages. Best-effort; never throws. */
function closeResults(result: unknown): void {
  const list = Array.isArray(result) ? result : [result];
  for (const qr of list) {
    try {
      (qr as { close?: () => void })?.close?.();
    } catch {
      /* best-effort — a close failure must not mask the query outcome */
    }
  }
}

/**
 * Run a Cypher statement that returns no rows (DDL / CREATE / DELETE).
 */
export async function projectExecute(
  projectId: number,
  cypher: string,
): Promise<void> {
  await runSerialized(projectId, async (entry) => {
    const result = await entry.connection.query(cypher);
    closeResults(result);
  });
}

async function getEntryForQuery(projectId: number): Promise<Entry> {
  await getProjectConnection(projectId);
  const entry = entries.get(projectId);
  if (!entry) throw new Error(`Internal: project ${projectId} entry missing`);
  if (entry.degraded) {
    throw new Error(
      `Project ${projectId} graph DB degraded: ${entry.degradedReason ?? 'unknown'}`,
    );
  }
  return entry;
}

export function markProjectDegraded(projectId: number, err: unknown): void {
  const entry = entries.get(projectId);
  if (!entry || entry.degraded) return;
  entry.degraded = true;
  entry.degradedReason = err instanceof Error ? err.message : String(err);
  logger.error(
    `Project ${projectId} graph DB marked degraded — further queries fail fast: ${entry.degradedReason}`,
  );
}

export function isProjectDegraded(projectId: number): boolean {
  return entries.get(projectId)?.degraded ?? false;
}

/**
 * Close one project's connection: CHECKPOINT, close native handles, unlink
 * the pidfile, drop from the map.
 */
export async function closeProjectConnection(projectId: number): Promise<void> {
  const entry = entries.get(projectId);
  if (!entry) return;

  // Wait for any in-flight queries to drain. Bounded — emergency timeout.
  const drainStart = Date.now();
  while (entry.inFlight > 0 && Date.now() - drainStart < 5000) {
    await new Promise((r) => setTimeout(r, 25));
  }

  // CHECKPOINT folds the WAL into the main file. A read-only session leaves no
  // WAL, and the engine then fails the checkpoint with "Error renaming
  // <id>.db.wal … No such file or directory" — harmless, but it was logging a
  // warning on ~a third of all evictions. Only checkpoint when there is a WAL.
  if (fs.existsSync(`${entry.dbPath}.wal`)) {
    try {
      await entry.connection.query('CHECKPOINT;');
    } catch (err) {
      logger.warn(`CHECKPOINT failed for project ${projectId}: ${err}`);
    }
  }
  // Close the Connection BEFORE the Database. Closing only the Database leaves
  // the connection's native state (buffer-pool pins, client context) alive
  // until V8 finalizes the wrapper — measured at ~3–7 MB retained per
  // open/evict cycle. With ~1000 evictions/hour across 340 project DBs that
  // grew RSS 1 GB → 4.4 GB in 12 minutes and got the process SIGKILLed (137).
  // Closing the connection first makes the cycle memory-flat (verified with an
  // isolated 120-open repro: 110 MB flat vs 1020 MB and climbing).
  // A close that THROWS must not be silent: the entry is dropped from the map
  // below regardless, so a Database whose native close failed is orphaned with
  // its buffer pool and mmap forever — exactly a per-eviction leak of DB-file
  // size. Log it, fall back to the sync close, and count it for /connection-pool.
  try {
    await entry.connection.close();
  } catch (err) {
    closeFailures.connection++;
    logger.warn(`Connection close failed for project ${projectId}: ${err instanceof Error ? err.message : String(err)}; trying closeSync`);
    try { entry.connection.closeSync(); } catch { /* give up */ }
  }
  try {
    await entry.database.close();
  } catch (err) {
    closeFailures.database++;
    logger.warn(`Database close failed for project ${projectId}: ${err instanceof Error ? err.message : String(err)}; trying closeSync`);
    try { entry.database.closeSync(); } catch { /* known LadybugDB cleanup SIGSEGV class */ }
  }
  // The native handles are released when V8 finalizes the wrappers; with a
  // large, stable heap that can be a long time (measured ~0.75 MB retained per
  // open/close with an 800 MB heap vs flat with a forced GC every 16 closes).
  // `--expose-gc` is set in scripts/start-server.sh; no-op otherwise.
  closesSinceGc++;
  if (closesSinceGc >= 16 && typeof global.gc === 'function') {
    closesSinceGc = 0;
    try { global.gc(); } catch { /* ignore */ }
  }
  try {
    if (fs.existsSync(entry.pidfile)) fs.unlinkSync(entry.pidfile);
  } catch {
    /* best-effort */
  }
  entries.delete(projectId);
  logger.debug(`Closed project ${projectId} graph DB connection`);
}

/**
 * Public alias: force-evict a project's open Kuzu DB. Used by the boot-time
 * auto-embed loop in src/index.ts to release native memory between projects
 * instead of waiting for LRU pressure. Native handles + bufferManager +
 * virtual mappings don't get reclaimed until close() runs.
 */
export async function closeProjectGraphDatabase(projectId: number): Promise<void> {
  await closeProjectConnection(projectId);
}

/**
 * Close every open project connection. Used at graceful shutdown.
 */
export async function closeAllProjectConnections(): Promise<void> {
  const ids = [...entries.keys()];
  await Promise.all(ids.map((id) => closeProjectConnection(id)));
}

/**
 * Drop a project's entire graph DB. Used by `clearProjectIndex` /
 * full-reindex flows. Closes the connection first, then `rm -rf`s the
 * Kuzu directory + pidfile.
 */
export async function resetProjectGraphDatabase(projectId: number): Promise<void> {
  await closeProjectConnection(projectId);
  // Remove the DB AND all Kuzu sidecars (.wal/.shadow/.tmp/.pid) — leaving a
  // stale .wal behind would make the next open fail to recover.
  purgeProjectDbFiles(projectId);
  logger.info(`Project ${projectId} graph DB + sidecars removed (${getProjectDbPath(projectId)})`);
}

/** Snapshot for /admin/graph/connection-pool — surfaces LRU state. */
export function getProjectConnectionPoolStats(): {
  open: number;
  closeFailures: { connection: number; database: number };
  cap: number;
  entries: Array<{
    projectId: number;
    lastUsedAgoMs: number;
    inFlight: number;
    degraded: boolean;
    dbPath: string;
  }>;
} {
  const now = Date.now();
  return {
    open: entries.size,
    cap: getMaxOpen(),
    closeFailures: { ...closeFailures },
    entries: [...entries.values()].map((e) => ({
      projectId: e.projectId,
      lastUsedAgoMs: now - e.lastUsed,
      inFlight: e.inFlight,
      degraded: e.degraded,
      dbPath: e.dbPath,
    })),
  };
}
