/**
 * LadybugDB Connection Singleton
 *
 * Manages a single LadybugDB (KuzuDB successor) connection for the code graph.
 * Database stored at .cache/fantom-graph.db
 *
 * All LadybugDB APIs are async: hasNext(), getNext(), getAll(), getColumnNames().
 */

import * as fs from 'fs';
import { execSync } from 'child_process';
import { Database, Connection } from '@ladybugdb/core';
import { createLogger } from '../utils/index.js';
import { getCachePath } from '../utils/installRoot.js';

const logger = createLogger('ladybug-connection');

let database: InstanceType<typeof Database> | null = null;
let connection: InstanceType<typeof Connection> | null = null;
let initialized = false;
// Caches the last successful health check; null means "not yet verified this run"
let healthyAt: number | null = null;
const HEALTH_CACHE_MS = 30_000;

/**
 * Circuit breaker: once we observe a Kuzu IO error (file corruption, lock
 * problems, etc.) further queries are short-circuited to throw a friendly
 * error instead of re-entering native code that can SIGSEGV the whole node
 * process. Cleared on resetLadybugDatabase().
 */
let degraded = false;
let degradedReason: string | null = null;

function isIoError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /IO exception|Cannot read from file|Could not set lock|Corrupted wal/i.test(msg);
}

export function isLadybugDegraded(): boolean {
  return degraded;
}

export function getLadybugDegradedReason(): string | null {
  return degradedReason;
}

export function markLadybugDegraded(err: unknown): void {
  if (degraded) return;
  degraded = true;
  degradedReason = err instanceof Error ? err.message : String(err);
  logger.error(`LadybugDB degraded — further queries will fail fast: ${degradedReason}`);
}

function getDbPath(): string {
  // Always resolve via the install root so launching the server from a
  // different cwd (e.g. a client project directory) doesn't create a stray
  // graph DB next to the user's source tree.
  return getCachePath('fantom-graph.db');
}

/**
 * Inspect a PID's command line + listening ports to decide whether it is
 * safe for us to terminate. Fail-closed: any uncertainty returns reasons.
 */
function inspectKillCandidate(pid: number): { safe: boolean; reasons: string[]; cmd: string; ports: number[] } {
  const reasons: string[] = [];
  let cmd = '';
  let ports: number[] = [];
  try {
    cmd = execSync(`ps -o command= -p ${pid}`, { encoding: 'utf-8', timeout: 2000 }).trim();
  } catch {
    reasons.push('cannot read command line via ps');
    return { safe: false, reasons, cmd, ports };
  }
  if (!/mcpfantom/.test(cmd)) {
    reasons.push(`command line does not contain "mcpfantom": ${cmd.slice(0, 120)}`);
  }
  try {
    const out = execSync(`lsof -nP -iTCP -sTCP:LISTEN -a -p ${pid}`, { encoding: 'utf-8', timeout: 2000 });
    ports = Array.from(out.matchAll(/:(\d+)\s+\(LISTEN\)/g)).map(m => parseInt(m[1]!, 10));
  } catch {
    // lsof exits 1 when no matches — that's fine, leaves ports empty.
  }
  // Hard deny-list: never kill anything serving these ports.
  // 9191 = mcp-proxy (axon/fantom/sedona/xeto). Extendable via env.
  const denylist = new Set<number>([9191]);
  const envDeny = process.env.LADYBUG_KILL_PORT_DENYLIST;
  if (envDeny) {
    for (const p of envDeny.split(',')) {
      const n = parseInt(p.trim(), 10);
      if (!Number.isNaN(n)) denylist.add(n);
    }
  }
  const blockedPorts = ports.filter(p => denylist.has(p));
  if (blockedPorts.length > 0) {
    reasons.push(`listening on protected port(s): ${blockedPorts.join(', ')}`);
  }
  if (pid === process.pid) {
    reasons.push('PID is the current process');
  }
  return { safe: reasons.length === 0, reasons, cmd, ports };
}

/**
 * Best-effort termination of a stale Ladybug lock-holder. Opt-in via
 * LADYBUG_KILL_STALE=1. All safety guards from inspectKillCandidate apply.
 * Returns true if the process is no longer alive when we return.
 */
function killStaleHolder(pid: number, dbPath: string): boolean {
  const check = inspectKillCandidate(pid);
  if (!check.safe) {
    logger.warn(
      `LADYBUG_KILL_STALE refused to kill PID ${pid} holding ${dbPath}: ${check.reasons.join('; ')}`,
    );
    return false;
  }
  logger.info(`LADYBUG_KILL_STALE sending SIGTERM to PID ${pid} (${check.cmd.slice(0, 80)})`);
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; }
    const wait = Date.now() + 200;
    while (Date.now() < wait) { /* spin briefly */ }
  }
  try { process.kill(pid, 0); } catch { return true; }
  logger.warn(`PID ${pid} survived SIGTERM after 3s — escalating to SIGKILL`);
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  try { process.kill(pid, 0); return false; } catch { return true; }
}

/**
 * Get or create the LadybugDB database + connection.
 * First call initializes the database and runs schema creation.
 */
export async function getLadybugConnection(): Promise<InstanceType<typeof Connection>> {
  if (connection && initialized) {
    return connection;
  }

  const dbPath = getDbPath();
  logger.debug(`Connecting to LadybugDB at ${dbPath}`);

  // PID-file singleton — Kuzu holds an exclusive lock on the .db, so a
  // second fantom-mcp process spawned while one is running will throw
  // "Could not set lock on file" deep inside native code. Pre-flight that
  // by checking a sibling pidfile; if a live PID is recorded, fail with a
  // clear, actionable error instead of letting the user discover the
  // problem via opaque "Internal Server Error" in admin tools.
  try {
    const pidfile = `${dbPath}.pid`;
    if (fs.existsSync(pidfile)) {
      const recorded = parseInt(fs.readFileSync(pidfile, 'utf-8').trim(), 10);
      if (!Number.isNaN(recorded) && recorded !== process.pid) {
        let alive = false;
        try { process.kill(recorded, 0); alive = true; } catch { alive = false; }
        if (alive) {
          // Opt-in: try to terminate the stale holder if env says so AND
          // the safety guards pass. Otherwise fail loud with the usual
          // actionable error.
          if (process.env.LADYBUG_KILL_STALE === '1' && killStaleHolder(recorded, dbPath)) {
            try { fs.unlinkSync(pidfile); } catch { /* ignore */ }
            logger.info(`LADYBUG_KILL_STALE successfully cleared lock from PID ${recorded}`);
          } else {
            const msg =
              `Another fantom-mcp server is already running (PID ${recorded}) ` +
              `and holds the LadybugDB lock at ${dbPath}. ` +
              `Stop it first (kill ${recorded}) or connect to its HTTP endpoint ` +
              `instead of spawning a second instance.`;
            logger.error(msg);
            throw new Error(msg);
          }
        }
        // Stale pidfile — fall through and overwrite.
      }
    }
    fs.writeFileSync(pidfile, String(process.pid), 'utf-8');
  } catch (err) {
    // Re-throw "another instance" errors; suppress write-failure noise.
    if (err instanceof Error && err.message.startsWith('Another fantom-mcp')) throw err;
  }

  try {
    // The shared/legacy graph DB holds ALL projects' nodes (100k+). Created
    // with no buffer-pool argument it used Kuzu's default, which is too small
    // for cross-project queries (semantic search / RLM `ask` with no projectId
    // enrich against this DB) → "Buffer manager exception: buffer pool is full".
    // Give it an explicit, generous pool. Env: FANTOM_LADYBUG_BUFFER_MIB.
    const mainBufMiB = Number(process.env.FANTOM_LADYBUG_BUFFER_MIB);
    const MAIN_BUFFER_SIZE = (Number.isFinite(mainBufMiB) && mainBufMiB > 0 ? mainBufMiB : 512) * 1024 * 1024;
    const MAIN_DB_MAX_SIZE = 8 * 1024 * 1024 * 1024; // 8 GiB sparse mmap cap
    database = new Database(dbPath, MAIN_BUFFER_SIZE, true, false, MAIN_DB_MAX_SIZE);
    await database.init();
    connection = new Connection(database);
    await connection.init();
  } catch (err) {
    if (isIoError(err)) markLadybugDegraded(err);
    throw err;
  }

  initialized = true;
  logger.info(`LadybugDB connection established at ${dbPath}`);
  return connection;
}

/**
 * Execute a Cypher query and return all results as an array of objects.
 *
 * Two forms (per-project migration C2):
 *   ladybugQuery(cypher)              — legacy: shared singleton DB
 *   ladybugQuery(projectId, cypher)   — per-project DB at .cache/graph/<pid>.db
 *
 * Callers should migrate to the two-arg form. Once all callers are converted
 * (commits C3 / C4 / C5), the legacy form is removed in C5.
 */
export async function ladybugQuery<T = Record<string, unknown>>(
  cypherOrProjectId: string | number,
  cypherIfPid?: string,
): Promise<T[]> {
  if (typeof cypherOrProjectId === 'number') {
    if (typeof cypherIfPid !== 'string') {
      throw new Error('ladybugQuery(projectId, cypher) — second argument (cypher) is required');
    }
    const { projectQuery } = await import('./projectGraphConnection.js');
    return projectQuery<T>(cypherOrProjectId, cypherIfPid);
  }
  // legacy single-arg path (shared .cache/fantom-graph.db)
  if (degraded) {
    throw new Error(`LadybugDB degraded: ${degradedReason ?? 'unknown'}`);
  }
  try {
    const conn = await getLadybugConnection();
    const result = await conn.query(cypherOrProjectId);
    const qr = Array.isArray(result) ? result[0] : result;
    try {
      const rows = await qr.getAll();
      return rows as T[];
    } finally {
      // Release pinned buffer pages — see projectGraphConnection.closeResults.
      closeLbResults(result);
    }
  } catch (err) {
    if (isIoError(err)) markLadybugDegraded(err);
    throw err;
  }
}

/** Close every QueryResult a query() returned, freeing its pinned buffer
 *  pages. Best-effort; never throws. (Shared-DB twin of projectGraphConnection's.) */
function closeLbResults(result: unknown): void {
  const list = Array.isArray(result) ? result : [result];
  for (const qr of list) {
    try { (qr as { close?: () => void })?.close?.(); } catch { /* best-effort */ }
  }
}

/**
 * Execute a Cypher query that returns no results (DDL, CREATE, DELETE).
 *
 * Two forms (per-project migration C2):
 *   ladybugExecute(cypher)            — legacy: shared singleton DB
 *   ladybugExecute(projectId, cypher) — per-project DB at .cache/graph/<pid>.db
 */
export async function ladybugExecute(
  cypherOrProjectId: string | number,
  cypherIfPid?: string,
): Promise<void> {
  if (typeof cypherOrProjectId === 'number') {
    if (typeof cypherIfPid !== 'string') {
      throw new Error('ladybugExecute(projectId, cypher) — second argument (cypher) is required');
    }
    const { projectExecute } = await import('./projectGraphConnection.js');
    return projectExecute(cypherOrProjectId, cypherIfPid);
  }
  // legacy single-arg path (shared .cache/fantom-graph.db)
  if (degraded) {
    throw new Error(`LadybugDB degraded: ${degradedReason ?? 'unknown'}`);
  }
  try {
    const conn = await getLadybugConnection();
    const result = await conn.query(cypherOrProjectId);
    closeLbResults(result);
  } catch (err) {
    if (isIoError(err)) markLadybugDegraded(err);
    throw err;
  }
}

/**
 * Real health check: confirms the connection is open AND the CodeNode table
 * exists by running a trivial count query. Result is cached for HEALTH_CACHE_MS
 * to avoid per-request ping overhead on hot paths.
 *
 * Returns false (instead of throwing) when Ladybug is unavailable so callers
 * can gracefully fall back to Prisma during the migration window.
 */
export async function isLadybugInitialized(): Promise<boolean> {
  if (!initialized || !connection) return false;
  if (healthyAt !== null && Date.now() - healthyAt < HEALTH_CACHE_MS) {
    return true;
  }
  try {
    const result = await connection.query('MATCH (n:CodeNode) RETURN count(n) LIMIT 1');
    const qr = Array.isArray(result) ? result[0] : result;
    await qr.getAll();
    closeLbResults(result);
    healthyAt = Date.now();
    return true;
  } catch (err) {
    logger.warn(`Ladybug health check failed: ${err}`);
    healthyAt = null;
    return false;
  }
}

/**
 * Get basic stats about the graph database.
 */
export async function getLadybugStats(): Promise<{
  nodes: number;
  edges: number;
  dbPath: string;
}> {
  const dbPath = getDbPath();
  if (!initialized) {
    return { nodes: 0, edges: 0, dbPath };
  }

  try {
    const nodeResult = await ladybugQuery<{ total: number }>(
      'MATCH (n:CodeNode) RETURN count(n) AS total'
    );
    const edgeResult = await ladybugQuery<{ total: number }>(
      'MATCH ()-[e:CodeEdge]->() RETURN count(e) AS total'
    );
    return {
      nodes: nodeResult[0]?.total ?? 0,
      edges: edgeResult[0]?.total ?? 0,
      dbPath,
    };
  } catch {
    // Tables may not exist yet
    return { nodes: 0, edges: 0, dbPath };
  }
}

/**
 * Close the LadybugDB connection and reset state.
 */
export async function closeLadybugConnection(): Promise<void> {
  if (database) {
    // Explicit CHECKPOINT before close: flushes WAL into the main DB file so
    // the next process opens with an empty WAL. Without this, an abrupt exit
    // (or close that doesn't checkpoint) leaves a partial WAL that the next
    // open recovers — and recovery itself is the bug surface that has
    // produced "Corrupted wal file. Read out invalid WAL record type." here.
    if (connection) {
      try {
        await connection.query('CHECKPOINT;');
      } catch (err) {
        logger.warn(`CHECKPOINT before close failed: ${err}`);
      }
    }
    // Close the Connection before the Database — see closeProjectConnection in
    // projectGraphConnection.ts: a Database closed under a live Connection
    // retains native memory until the wrapper is finalized.
    if (connection) {
      try { await connection.close(); } catch { /* best effort */ }
    }
    try {
      await database.close();
    } catch {
      // Ignore close errors (SIGSEGV on cleanup is a known LadybugDB issue)
    }
    database = null;
    connection = null;
    initialized = false;
    healthyAt = null;
    // Remove our pidfile so a follow-up process can take the lock.
    try {
      const pidfile = `${getDbPath()}.pid`;
      if (fs.existsSync(pidfile)) fs.unlinkSync(pidfile);
    } catch { /* best-effort */ }
    logger.debug('LadybugDB connection closed');
  }
}

/**
 * Reset the graph database by dropping and recreating all tables.
 * Used during full reindex.
 */
export async function resetLadybugDatabase(): Promise<void> {
  await closeLadybugConnection();

  const dbPath = getDbPath();
  if (fs.existsSync(dbPath)) {
    fs.rmSync(dbPath, { recursive: true, force: true });
    logger.info('LadybugDB database directory removed for fresh start');
  }
}
