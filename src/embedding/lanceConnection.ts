/**
 * LanceDB Connection Singleton
 *
 * Manages a single LanceDB connection to .cache/fantomvector.db
 * with two tables:
 *   - code_vectors: code embeddings (384d default, small/fast model)
 *   - docs_vectors: documentation embeddings (768d default, larger model)
 */

import { connect, type Connection, type Table } from '@lancedb/lancedb';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../utils/index.js';
import { DEFAULT_DIMENSIONS } from './embeddingService.js';
import { getCachePath } from '../utils/installRoot.js';
import { EMBED_TEXT_V3 } from './embeddingText.js';

const logger = createLogger('lance-connection');

// Two physical slots for code vectors + an active-slot pointer. A full
// re-embed builds into the INACTIVE slot and atomically flips the pointer on
// validated success (promoteCodeTable) — readers keep serving the old slot for
// the whole multi-hour rebuild, and an interrupted build leaves the live slot
// untouched (no empty/corruption window). LanceDB has no renameTable, hence the
// pointer indirection. Default/legacy slot is 'code_vectors'.
export const CODE_TABLE_NAME = 'code_vectors';
export const CODE_TABLE_NAME_B = 'code_vectors_b';
export const DOCS_TABLE_NAME = 'docs_vectors';
// Keep legacy export for backward compatibility
export const TABLE_NAME = CODE_TABLE_NAME;

const DEFAULT_DOCS_DIMENSIONS = 768;

// Resolve the configured embedding dimension at table-creation time.
// LanceDB locks the vector column's listSize when the first row is
// written, so picking the wrong number here means every subsequent
// query against the table fails with "no vector column found to match
// query vector dimension". Read from settings.semanticSearch.{code,docs}Dimensions
// first; fall back to env vars then DEFAULT_DIMENSIONS.
function resolveCodeDims(): number {
  const fromEnv = parseInt(process.env.CODE_EMBEDDING_DIMENSIONS || process.env.EMBEDDING_DIMENSIONS || '');
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  try {
    const cfgPath = path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      const d = cfg?.semanticSearch?.codeDimensions;
      if (Number.isFinite(d) && d > 0) return Number(d);
    }
  } catch { /* fall through to default */ }
  return DEFAULT_DIMENSIONS;
}

function resolveDocsDims(): number {
  const fromEnv = parseInt(process.env.DOCS_EMBEDDING_DIMENSIONS || '');
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  try {
    const cfgPath = path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      const d = cfg?.semanticSearch?.docsDimensions;
      if (Number.isFinite(d) && d > 0) return Number(d);
    }
  } catch { /* fall through to default */ }
  return DEFAULT_DOCS_DIMENSIONS;
}

let connection: Connection | null = null;
let codeTable: Table | null = null;
let codeTableName: string | null = null; // which slot the cached codeTable points at
let docsTable: Table | null = null;

function getLanceDbPath(): string {
  return getCachePath('fantomvector.db');
}

// ── Active-slot pointer (blue-green code-vector table) ──────────────────────
function activePointerPath(): string {
  return path.join(getLanceDbPath(), '.active-code-table');
}
/** Which code slot readers serve. Crash-safe: defaults to the legacy slot if
 *  the pointer is missing/garbage (never an unknown table name). */
export function getActiveCodeTableName(): string {
  try {
    const p = activePointerPath();
    if (fs.existsSync(p)) {
      const name = fs.readFileSync(p, 'utf-8').trim();
      if (name === CODE_TABLE_NAME || name === CODE_TABLE_NAME_B) return name;
    }
  } catch { /* default below */ }
  return CODE_TABLE_NAME;
}
/** The slot NOT currently active — where a shadow re-embed builds. */
export function getInactiveCodeTableName(): string {
  return getActiveCodeTableName() === CODE_TABLE_NAME ? CODE_TABLE_NAME_B : CODE_TABLE_NAME;
}
function writeActiveCodeTableName(name: string): void {
  const p = activePointerPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, name);
  fs.renameSync(tmp, p); // atomic flip
}

/**
 * Columns added by the v3 text layout (EMBED_TEXT_VERSION 3). LanceDB locks a
 * table's schema at creation, so they only exist on tables created by this
 * build — the full re-embed's shadow-swap path creates one; an existing v2
 * table is never migrated in place. `VectorStore` checks `codeTableHasV3Columns`
 * and writes v2-shaped rows (chunk 0 only) into an older table.
 *   row_id          `${node_id}` for chunk 0, `${node_id}#${chunk_index}` otherwise
 *   chunk_index / chunk_count  position of this row within its node
 *   line_start / line_end      this chunk's own source range
 *   qualified_name / file_path denormalised so file/project rows (no CodeNode)
 *                              can be turned into search results
 */
export const CODE_TABLE_V3_COLUMNS = ['row_id', 'chunk_index', 'chunk_count', 'line_start', 'line_end', 'qualified_name', 'file_path'] as const;

const v3ColumnCache = new Map<string, boolean>();

/** Whether `table` carries the v3 columns (cached per table name). */
export async function codeTableHasV3Columns(table: Table, cacheKey?: string): Promise<boolean> {
  const key = cacheKey ?? (table as unknown as { name?: string }).name ?? '';
  if (key && v3ColumnCache.has(key)) return v3ColumnCache.get(key)!;
  let has = false;
  try {
    const schema = await table.schema();
    const names = new Set(schema.fields.map((f: { name: string }) => f.name));
    has = CODE_TABLE_V3_COLUMNS.every((c) => names.has(c));
  } catch { has = false; }
  if (key) v3ColumnCache.set(key, has);
  return has;
}

/** Create a fresh empty code-vectors table in `name` at `dims`. */
async function createEmptyCodeTable(conn: Connection, name: string, dims: number): Promise<Table> {
  logger.info(`Creating ${name} table in LanceDB at ${dims}d${EMBED_TEXT_V3 ? ' (text layout v3 columns)' : ''}`);
  const seed: Record<string, unknown> = {
    node_id: '__init__', vector: new Array(dims).fill(0), project_id: 0,
    node_type: '__init__', model: '__init__', dimensions: dims, created_at: new Date().toISOString(),
  };
  if (EMBED_TEXT_V3) {
    Object.assign(seed, {
      row_id: '__init__', chunk_index: 0, chunk_count: 1, line_start: 0, line_end: 0,
      qualified_name: '__init__', file_path: '__init__',
    });
  }
  const t = await conn.createTable(name, [seed]);
  await t.delete("node_id = '__init__'");
  v3ColumnCache.set(name, EMBED_TEXT_V3);
  return t;
}

/**
 * Get or create the LanceDB connection
 */
export async function getLanceConnection(): Promise<Connection> {
  if (!connection) {
    const dbPath = getLanceDbPath();
    logger.debug(`Connecting to LanceDB at ${dbPath}`);
    connection = await connect(dbPath);
  }
  return connection;
}

/**
 * Get or create the code_vectors table.
 */
export async function getLanceTable(): Promise<Table> {
  const active = getActiveCodeTableName();
  // Reuse the cached handle only if it still points at the active slot — a
  // promote() flips the pointer, after which readers must reopen the new slot.
  if (codeTable && codeTable.isOpen() && codeTableName === active) {
    return codeTable;
  }
  if (codeTable) { try { codeTable.close(); } catch { /* ignore */ } codeTable = null; }

  const conn = await getLanceConnection();
  const tableNames = await conn.tableNames();
  codeTable = tableNames.includes(active)
    ? await conn.openTable(active)
    : await createEmptyCodeTable(conn, active, resolveCodeDims());
  codeTableName = active;
  return codeTable;
}

/**
 * Open the INACTIVE code slot as a FRESH empty table for a shadow re-embed.
 * Drops any stale data in that slot first. The live (active) slot is untouched,
 * so readers keep serving it while the shadow builds. Returns the handle + name.
 */
export async function openShadowCodeTable(resume = false): Promise<{ table: Table; name: string; resumed: boolean }> {
  const conn = await getLanceConnection();
  const name = getInactiveCodeTableName();
  const names = await conn.tableNames();
  const dims = resolveCodeDims();

  // RESUME: a full re-embed is hours long, and a restart (deploy, crash) used
  // to throw away every finished project because this always recreated the
  // slot empty. When asked to resume, reuse the existing shadow if it is
  // still usable — same vector width and the v3 columns — so the job can skip
  // the projects already in it. Anything unusable is recreated from scratch.
  if (resume && names.includes(name)) {
    try {
      const existing = await conn.openTable(name);
      const schema = await existing.schema();
      const vec = (schema.fields ?? []).find((f: { name: string }) => f.name === 'vector') as
        { type?: { listSize?: number } } | undefined;
      const width = vec?.type?.listSize;
      const hasV3 = await codeTableHasV3Columns(existing, name);
      if (width === dims && hasV3) {
        const rows = await existing.countRows().catch(() => 0);
        logger.info(`Resuming shadow slot '${name}' at ${dims}d with ${rows} existing rows`);
        return { table: existing, name, resumed: true };
      }
      logger.warn(`Shadow slot '${name}' not resumable (width=${width} want=${dims}, v3=${hasV3}) — rebuilding empty`);
      try { existing.close(); } catch { /* ignore */ }
    } catch (e) {
      logger.warn(`Shadow slot '${name}' could not be opened for resume: ${(e as Error).message} — rebuilding empty`);
    }
  }

  if (names.includes(name)) { try { await conn.dropTable(name); } catch { /* ignore */ } }
  const table = await createEmptyCodeTable(conn, name, dims);
  return { table, name, resumed: false };
}

/**
 * Open a code slot READ-ONLY by name, without touching the cached active-slot
 * handle. Used by progress reporting to count rows in the shadow slot while a
 * re-embed builds into it — readers of the live slot are unaffected. Returns
 * null when that slot does not exist yet.
 */
export async function openCodeSlotReadonly(name: string): Promise<Table | null> {
  if (name !== CODE_TABLE_NAME && name !== CODE_TABLE_NAME_B) {
    throw new Error(`openCodeSlotReadonly: invalid slot '${name}'`);
  }
  const conn = await getLanceConnection();
  const names = await conn.tableNames();
  if (!names.includes(name)) return null;
  try { return await conn.openTable(name); } catch { return null; }
}

/**
 * Compact a code table and prune superseded versions.
 *
 * Every stored chunk appends a new fragment and a new manifest version, and
 * nothing ever merged them: a full re-embed reached ~9,978 fragments and
 * ~19,600 versions, at which point each append costs hundreds of ms and the
 * GPUs sit idle waiting on the write path. Measured append cost against
 * fragment count: 12ms @200, 25ms @600, 81ms @1,200 — roughly linear.
 *
 * Failures are swallowed so compaction can never fail a rebuild.
 *
 * SERIALIZED against appends. This used to be safe simply because the rebuild
 * was one project at a time and stores were serialized by the scheduler's
 * `onChunk` chain. Now that projects run concurrently, N workers can be
 * appending while a compaction starts — and optimize() rewriting fragments
 * under a concurrent append is a manifest-conflict this codebase has no
 * retry for. It therefore takes the same per-table write slot as every
 * append and delete (vectorWriteQueue), so it can never overlap one.
 */
/**
 * Build the ANN index on a code table's vector column.
 *
 * Without one, LanceDB answers every search by BRUTE FORCE — it reads the
 * whole column. On the live table that is 211,975 rows x 2560 float32, about
 * 2.2 GB per query, and an ask fans out across the primary project plus its
 * neighbours: measured at 30 s of a 45 s budget spent in retrieval alone,
 * which left no time for the RLM stage and starved the thing that makes the
 * answer good.
 *
 * No index was ever created — `_indices` was empty and nothing in this
 * codebase called `createIndex`. It went unnoticed because a brute-force scan
 * is CORRECT, just slow, and the table only recently grew large enough for the
 * difference to dominate.
 *
 * IVF_PQ, cosine: the distance the query path already uses, and PQ keeps the
 * index small enough to stay in page cache on a box that has hit a 4 GB guard
 * twice. `numPartitions` follows the usual sqrt(rows) rule of thumb, clamped
 * so a small table does not get a partition per handful of rows.
 *
 * Training reads a sample of the table and is CPU-heavy, so it runs on the
 * write queue like compaction — it must not overlap an append.
 */
export async function ensureCodeVectorIndex(
  table: Table,
  opts: { label?: string; rows?: number; force?: boolean } = {},
): Promise<{ built: boolean; reason: string }> {
  const label = opts.label ?? 'code';
  try {
    const existing = await table.listIndices();
    if (!opts.force && existing.some(i => i.columns.includes('vector'))) {
      return { built: false, reason: `already indexed (${existing.map(i => i.name).join(', ')})` };
    }
    const rows = opts.rows ?? await table.countRows();
    // Below this an index costs more than the scan it replaces.
    if (rows < 5_000) return { built: false, reason: `only ${rows} rows — a scan is cheaper` };

    const numPartitions = Math.max(1, Math.min(4096, Math.round(Math.sqrt(rows))));
    // 2560 dims / 64 sub-vectors = 40 dims each, which divides evenly. A
    // sub-vector count that does not divide the width is rejected outright.
    const numSubVectors = 64;
    const t0 = Date.now();
    logger.info(`[lance] building IVF_PQ on ${label}: ${rows} rows, ${numPartitions} partitions…`);
    const { Index } = await import('@lancedb/lancedb');
    const { enqueueTableWrite } = await import('./vectorWriteQueue.js');
    await enqueueTableWrite(table, () => table.createIndex('vector', {
      config: Index.ivfPq({ numPartitions, numSubVectors, distanceType: 'cosine' }),
      replace: true,
    }));
    const ms = Date.now() - t0;
    logger.info(`[lance] IVF_PQ on ${label} built in ${(ms / 1000).toFixed(1)}s`);
    return { built: true, reason: `IVF_PQ ${numPartitions}x${numSubVectors} in ${(ms / 1000).toFixed(1)}s` };
  } catch (err) {
    // Never fatal: an unindexed table still answers, just slowly.
    const message = (err as Error).message;
    logger.warn(`[lance] index build on ${label} failed (searches stay brute-force): ${message}`);
    return { built: false, reason: `failed: ${message}` };
  }
}

export async function compactCodeTable(table: Table, label = 'code'): Promise<void> {
  const { enqueueTableWrite } = await import('./vectorWriteQueue.js');
  return enqueueTableWrite(table, () => compactCodeTableSerialized(table, label));
}

async function compactCodeTableSerialized(table: Table, label: string): Promise<void> {
  const t0 = Date.now();
  try {
    const res = await (table as unknown as {
      optimize: (o?: { cleanupOlderThan?: Date }) => Promise<{
        compaction?: { fragmentsRemoved?: number; fragmentsAdded?: number };
        prune?: { oldVersionsRemoved?: number };
      }>;
    }).optimize({ cleanupOlderThan: new Date(Date.now() - 10 * 60_000) });
    const c = res?.compaction, pr = res?.prune;
    logger.info(`[compact] ${label}: ${c?.fragmentsRemoved ?? 0} fragments → ${c?.fragmentsAdded ?? 0}, ${pr?.oldVersionsRemoved ?? 0} old versions pruned (${Date.now() - t0}ms)`);
  } catch (e) {
    logger.warn(`[compact] ${label} failed (continuing): ${(e as Error).message}`);
  }
}

/**
 * Inspect the inactive slot — the "pending shadow" a paused or interrupted
 * rebuild left behind. Returns null when the slot is absent or empty.
 *
 * This is what makes a pause legible instead of looking like a wipe: the
 * dashboard can say "225,008 vectors across 324 projects are banked and
 * waiting" rather than falling back to the stale active slot's numbers.
 */
export async function getPendingShadowCodeTable(): Promise<
  { name: string; rows: number; projects: number } | null
> {
  try {
    const name = getInactiveCodeTableName();
    const table = await openCodeSlotReadonly(name);
    if (!table) return null;
    const rows = await table.countRows().catch(() => 0);
    if (rows === 0) return null;
    let projects = 0;
    try {
      const seen = new Set<number>();
      for await (const batch of table.query().select(['project_id']) as any) {
        const col = batch.getChild?.('project_id');
        if (!col) continue;
        for (const v of col) if (v !== null && v !== undefined) seen.add(Number(v));
      }
      projects = seen.size;
    } catch { /* the row count alone is still useful */ }
    return { name, rows, projects };
  } catch {
    return null;
  }
}

/**
 * Drop the pending shadow. THE ONLY IRREVERSIBLE ACTION in the rebuild flow —
 * every other exit path (pause, stop, error, partial) keeps it. Callers must
 * have shown the operator how many vectors and projects this destroys.
 */
export async function dropShadowCodeTable(): Promise<{ dropped: boolean; name: string; rows: number }> {
  const conn = await getLanceConnection();
  const name = getInactiveCodeTableName();
  const names = await conn.tableNames();
  if (!names.includes(name)) return { dropped: false, name, rows: 0 };
  let rows = 0;
  try { rows = await (await conn.openTable(name)).countRows(); } catch { /* best effort */ }
  await conn.dropTable(name);
  logger.warn(`DISCARDED shadow code-vector slot '${name}' — ${rows} vectors destroyed (operator-confirmed)`);
  return { dropped: true, name, rows };
}

/**
 * Atomically promote a freshly-built shadow slot to active: flip the pointer
 * (atomic rename), invalidate the cached handle so readers reopen the new slot,
 * then drop the now-stale old slot. Call ONLY after a validated-complete build —
 * never on a partial shadow.
 */
export async function promoteCodeTable(shadowName: string): Promise<void> {
  if (shadowName !== CODE_TABLE_NAME && shadowName !== CODE_TABLE_NAME_B) {
    throw new Error(`promoteCodeTable: invalid slot '${shadowName}'`);
  }
  const old = getActiveCodeTableName();
  writeActiveCodeTableName(shadowName);
  if (codeTable) { try { codeTable.close(); } catch { /* ignore */ } codeTable = null; codeTableName = null; }
  if (old !== shadowName) {
    try { const conn = await getLanceConnection(); await conn.dropTable(old); }
    catch (e) { logger.warn(`promoteCodeTable: dropping old slot '${old}' failed: ${(e as Error).message}`); }
  }
  logger.info(`Promoted code-vector slot '${shadowName}' to active (was '${old}')`);
}

/**
 * Get or create the docs_vectors table.
 */
export async function getDocsLanceTable(): Promise<Table> {
  if (docsTable && docsTable.isOpen()) {
    return docsTable;
  }

  const conn = await getLanceConnection();
  const tableNames = await conn.tableNames();

  if (tableNames.includes(DOCS_TABLE_NAME)) {
    docsTable = await conn.openTable(DOCS_TABLE_NAME);

    // Migrate: if table lacks instance_id column, drop and recreate
    try {
      const schema = await docsTable.schema();
      const fieldNames = schema.fields.map((f: { name: string }) => f.name);
      if (!fieldNames.includes('instance_id')) {
        logger.info('Migrating docs_vectors table: adding instance_id and language columns');
        docsTable.close();
        await conn.dropTable(DOCS_TABLE_NAME);
        docsTable = null;
        // Fall through to create below
      }
    } catch (e) {
      logger.warn(`Schema check failed, recreating docs_vectors: ${e}`);
      try { docsTable?.close(); } catch { /* ignore */ }
      try { await conn.dropTable(DOCS_TABLE_NAME); } catch { /* ignore */ }
      docsTable = null;
    }
  }

  if (!docsTable) {
    const dims = resolveDocsDims();
    logger.info(`Creating docs_vectors table in LanceDB at ${dims}d (from settings.semanticSearch.docsDimensions)`);
    docsTable = await conn.createTable(DOCS_TABLE_NAME, [{
      doc_id: '__init__',
      vector: new Array(dims).fill(0),
      pod: '__init__',
      doc_type: '__init__',
      title: '__init__',
      url: '',
      instance_id: 0,
      language: '__init__',
      model: '__init__',
      dimensions: dims,
      created_at: new Date().toISOString(),
    }]);
    await docsTable.delete("doc_id = '__init__'");
  }

  return docsTable;
}

/**
 * Get table stats for both tables
 */
export async function getLanceTableStats(): Promise<{
  code: { rows: number; model?: string; dimensions?: number };
  docs: { rows: number; model?: string; dimensions?: number };
}> {
  const stats = {
    code: { rows: 0, model: undefined as string | undefined, dimensions: undefined as number | undefined },
    docs: { rows: 0, model: undefined as string | undefined, dimensions: undefined as number | undefined },
  };

  // Read dimensions from the Arrow schema's vector column (FixedSizeList
  // listSize), NOT from the per-row metadata `dimensions` field. Those
  // two can drift apart: a re-embed run may write new metadata values
  // into rows of an old fixed-size column (Lance locks listSize at table
  // creation). When that happens, re-embed/:projectId reads matching
  // metadata vs configured, decides not to drop the table, and writes
  // mismatched-dim rows on top of the stale schema.
  const dimsFromSchema = (table: { schema: () => Promise<{ fields?: Array<{ name: string; type: { listSize?: number } }> }> }): Promise<number | undefined> =>
    table.schema().then(schema => {
      const vec = (schema.fields ?? []).find(f => f.name === 'vector');
      const sz = vec?.type?.listSize;
      return typeof sz === 'number' ? sz : undefined;
    }).catch(() => undefined);

  try {
    const codeT = await getLanceTable();
    stats.code.rows = await codeT.countRows();
    stats.code.dimensions = await dimsFromSchema(codeT);
    if (stats.code.rows > 0) {
      const sample = await codeT.query().select(['model', 'dimensions']).limit(1).toArray();
      if (sample.length > 0) {
        stats.code.model = sample[0].model as string;
        const metaDim = sample[0].dimensions as number | undefined;
        if (typeof metaDim === 'number' && metaDim !== stats.code.dimensions) {
          console.warn(`[lance] code_vectors metadata drift: per-row dimensions=${metaDim} but column listSize=${stats.code.dimensions}. Schema is authoritative — drop+recreate the table to align.`);
        }
      }
    }
  } catch { /* table may not exist yet */ }

  try {
    const docsT = await getDocsLanceTable();
    stats.docs.rows = await docsT.countRows();
    stats.docs.dimensions = await dimsFromSchema(docsT);
    if (stats.docs.rows > 0) {
      const sample = await docsT.query().select(['model', 'dimensions']).limit(1).toArray();
      if (sample.length > 0) {
        stats.docs.model = sample[0].model as string;
        const metaDim = sample[0].dimensions as number | undefined;
        if (typeof metaDim === 'number' && metaDim !== stats.docs.dimensions) {
          console.warn(`[lance] docs_vectors metadata drift: per-row dimensions=${metaDim} but column listSize=${stats.docs.dimensions}. Schema is authoritative — drop+recreate the table to align.`);
        }
      }
    }
  } catch { /* table may not exist yet */ }

  return stats;
}

/**
 * Close the LanceDB connection and reset state
 */
export async function closeLanceConnection(): Promise<void> {
  if (codeTable) {
    codeTable.close();
    codeTable = null;
  }
  if (docsTable) {
    docsTable.close();
    docsTable = null;
  }
  connection = null;
  logger.debug('LanceDB connection closed');
}

/**
 * Reset table references (e.g. after restore)
 */
export function resetLanceTable(): void {
  if (codeTable) {
    codeTable.close();
    codeTable = null;
  }
  if (docsTable) {
    docsTable.close();
    docsTable = null;
  }
}

/**
 * Drop the code_vectors table entirely. Use when changing embedding dimensions
 * — LanceDB locks dimensions per column, so a model switch from 384d to 1024d
 * (or back) requires recreating the table.
 */
export async function dropCodeVectorsTable(): Promise<void> {
  const conn = await getLanceConnection();
  if (codeTable) { try { codeTable.close(); } catch { /* ignore */ } codeTable = null; codeTableName = null; }
  // Drop the ACTIVE slot (which may be code_vectors or code_vectors_b after a
  // promote) — not the hardcoded legacy name.
  const active = getActiveCodeTableName();
  const names = await conn.tableNames();
  if (names.includes(active)) {
    await conn.dropTable(active);
  }
}

export async function dropDocsVectorsTable(): Promise<void> {
  const conn = await getLanceConnection();
  if (docsTable) { try { docsTable.close(); } catch {} docsTable = null; }
  const names = await conn.tableNames();
  if (names.includes(DOCS_TABLE_NAME)) {
    await conn.dropTable(DOCS_TABLE_NAME);
  }
}
