/**
 * LanceDB table for Axon function vectors: `axon_vectors`.
 *
 * Lives in the same LanceDB database as `code_vectors` / `docs_vectors`
 * (.cache/fantomvector.db) but is a separate table so a Fantom re-embed and an
 * Axon re-index never have to happen in the same job. Uses the Code Search
 * model/dims (see axonSettings.resolveAxonEmbeddingModel).
 *
 * Safety rules (same as the code path):
 *   - never drop a populated table implicitly; `dropAxonVectorsTable()` is only
 *     called by an explicit forced re-index or when the table is empty.
 *   - a dims mismatch between the table schema and the configured code dims is
 *     REPORTED (`dimsMismatch`) and blocks indexing until forced.
 */

import type { Table } from '@lancedb/lancedb';
import { getLanceConnection } from '../embedding/lanceConnection.js';
import { createLogger } from '../utils/index.js';
import { resolveAxonEmbeddingModel } from './axonSettings.js';
import { AXON_EMBED_TEXT_VERSION } from './axonEmbeddingText.js';

const logger = createLogger('axon-lance');

export const AXON_TABLE_NAME = 'axon_vectors';

let axonTable: Table | null = null;

export interface AxonVectorRow {
  /** `${node_id}#${chunk_index}` — unique per row; chunk 0 keeps the plain node id. */
  row_id: string;
  /** Function id (shared by all chunks of one function). */
  node_id: string;
  /** 'proj' (synced SkySpark project) or 'library' (offline library folder). */
  source: string;
  vector: number[];
  project_id: string;
  instance: string;
  project: string;
  name: string;
  qualified_name: string;
  signature: string;
  /** JSON-encoded AxonParam[] */
  params: string;
  return_type: string;
  /** Comma-joined trio tags */
  tags: string;
  /** Cleaned doc (≤800 chars) */
  doc: string;
  rel_path: string;
  line_start: number;
  line_end: number;
  chunk_index: number;
  chunk_count: number;
  embed_text_version: number;
  hash: string;
  model: string;
  dimensions: number;
  created_at: string;
}

function initRow(dims: number, model: string): AxonVectorRow {
  return {
    row_id: '__init__', node_id: '__init__', source: 'proj', vector: new Array(dims).fill(0), project_id: '__init__',
    instance: '__init__', project: '__init__', name: '__init__', qualified_name: '__init__',
    signature: '', params: '[]', return_type: '', tags: '', doc: '', rel_path: '',
    line_start: 0, line_end: 0, chunk_index: 0, chunk_count: 1, embed_text_version: 0,
    hash: '', model, dimensions: dims, created_at: new Date().toISOString(),
  };
}

export async function axonTableExists(): Promise<boolean> {
  const conn = await getLanceConnection();
  return (await conn.tableNames()).includes(AXON_TABLE_NAME);
}

/** Open (or create at the configured code dims) the axon_vectors table. */
export async function getAxonLanceTable(): Promise<Table> {
  if (axonTable && axonTable.isOpen()) return axonTable;
  const conn = await getLanceConnection();
  const names = await conn.tableNames();
  if (names.includes(AXON_TABLE_NAME)) {
    axonTable = await conn.openTable(AXON_TABLE_NAME);
    // Schema migration: a table created before the chunk columns existed can
    // only be recreated when EMPTY — never drop rows implicitly.
    try {
      const fields = (await axonTable.schema()).fields.map((f: { name: string }) => f.name);
      if ((!fields.includes('row_id') || !fields.includes('source')) && (await axonTable.countRows()) === 0) {
        logger.info(`${AXON_TABLE_NAME} lacks chunk columns and is empty — recreating`);
        axonTable.close(); axonTable = null;
        await conn.dropTable(AXON_TABLE_NAME);
      }
    } catch { /* keep the handle */ }
    if (axonTable) return axonTable;
  }
  const { model, dimensions } = resolveAxonEmbeddingModel();
  logger.info(`Creating ${AXON_TABLE_NAME} at ${dimensions}d (code model ${model})`);
  axonTable = await conn.createTable(AXON_TABLE_NAME, [initRow(dimensions, model) as unknown as Record<string, unknown>]);
  await axonTable.delete("node_id = '__init__'");
  return axonTable;
}

/** Drop the table. Callers must have checked emptiness or hold an explicit force. */
export async function dropAxonVectorsTable(): Promise<void> {
  const conn = await getLanceConnection();
  if (axonTable) { try { axonTable.close(); } catch { /* ignore */ } axonTable = null; }
  const names = await conn.tableNames();
  if (names.includes(AXON_TABLE_NAME)) {
    await conn.dropTable(AXON_TABLE_NAME);
    logger.warn(`Dropped ${AXON_TABLE_NAME}`);
  }
}

export function resetAxonTableHandle(): void {
  if (axonTable) { try { axonTable.close(); } catch { /* ignore */ } axonTable = null; }
}

async function dimsFromSchema(t: Table): Promise<number | undefined> {
  try {
    const schema = await t.schema();
    const f = schema.fields.find((x: { name: string }) => x.name === 'vector') as any;
    const size = f?.type?.listSize;
    return typeof size === 'number' && size > 0 ? size : undefined;
  } catch {
    return undefined;
  }
}

export interface AxonTableStats {
  exists: boolean;
  rows: number;
  /** Whether the schema has the chunk/signature columns of the current layout. */
  schemaCurrent?: boolean;
  /** Dims locked in the table schema (authoritative once rows exist). */
  tableDimensions?: number;
  /** Model recorded on the sampled row. */
  tableModel?: string;
  /** Embedding-text layout version recorded on the sampled row. */
  tableTextVersion?: number;
  /**
   * True when the rows were built from an older embedding-text layout.
   *
   * Reported, never enforced: unlike a dims mismatch, v1 and v2 rows are the
   * same width and a PLAIN re-index rewrites every row, so blocking the run
   * would block the only thing that fixes it. Without this the dashboard had
   * no way to tell v1 rows from v2 rows, and a single-project re-index left a
   * silently mixed table.
   */
  textVersionStale: boolean;
  /** Currently configured code model/dims. */
  configuredModel: string;
  configuredDimensions: number;
  /** True when a populated table has different dims than the configured model. */
  dimsMismatch: boolean;
  modelMismatch: boolean;
}

export async function getAxonTableStats(): Promise<AxonTableStats> {
  const { model, dimensions } = resolveAxonEmbeddingModel();
  const base: AxonTableStats = {
    exists: false, rows: 0, configuredModel: model, configuredDimensions: dimensions,
    dimsMismatch: false, modelMismatch: false, textVersionStale: false,
  };
  if (!(await axonTableExists())) return base;
  try {
    const t = await getAxonLanceTable();
    base.exists = true;
    base.rows = await t.countRows();
    base.tableDimensions = await dimsFromSchema(t);
    try {
      const fields = (await t.schema()).fields.map((f: { name: string }) => f.name);
      base.schemaCurrent = fields.includes('row_id') && fields.includes('chunk_index') && fields.includes('source');
    } catch { base.schemaCurrent = undefined; }
    if (base.rows > 0) {
      const cols = base.schemaCurrent ? ['model', 'dimensions', 'embed_text_version'] : ['model', 'dimensions'];
      const sample = await t.query().select(cols).limit(1).toArray();
      if (sample.length > 0) {
        base.tableModel = String(sample[0].model);
        const v = Number(sample[0].embed_text_version);
        if (Number.isFinite(v) && v > 0) base.tableTextVersion = v;
      }
      base.dimsMismatch = base.tableDimensions !== undefined && base.tableDimensions !== dimensions;
      base.modelMismatch = !!base.tableModel && base.tableModel !== model;
      base.textVersionStale = base.tableTextVersion !== undefined
        && base.tableTextVersion !== AXON_EMBED_TEXT_VERSION;
    } else if (base.tableDimensions !== undefined && base.tableDimensions !== dimensions) {
      // Empty table at the wrong dims: safe to recreate on demand.
      base.dimsMismatch = true;
    }
  } catch (e) {
    logger.warn(`getAxonTableStats failed: ${(e as Error).message}`);
  }
  return base;
}

/**
 * Ensure the table is usable at the configured dims. An EMPTY table at the
 * wrong dims is recreated (no data lost). A POPULATED table at the wrong dims
 * throws unless `force` — the caller (forced re-index) decided to rebuild.
 */
export async function ensureAxonTableForWrite(force: boolean): Promise<Table> {
  const stats = await getAxonTableStats();
  const schemaStale = stats.exists && stats.schemaCurrent === false;
  if (stats.exists && (stats.dimsMismatch || schemaStale)) {
    if (stats.rows > 0 && !force) {
      throw new Error(stats.dimsMismatch
        ? `axon_vectors holds ${stats.rows} rows at ${stats.tableDimensions}d but the code model ` +
          `${stats.configuredModel} is ${stats.configuredDimensions}d — run a forced Axon re-index to rebuild.`
        : `axon_vectors holds ${stats.rows} rows in an older schema (missing chunk/source columns) — run a forced Axon re-index to rebuild.`);
    }
    await dropAxonVectorsTable();
  }
  return getAxonLanceTable();
}

/** node_ids present for a project (to mark functions embedded yes/no). */
export async function listAxonVectorIds(projectId: string): Promise<Set<string>> {
  const out = new Set<string>();
  if (!(await axonTableExists())) return out;
  const t = await getAxonLanceTable();
  const rows = await t.query()
    .where(`project_id = '${projectId.replace(/'/g, "''")}'`)
    .select(['node_id'])
    .limit(100000)
    .toArray();
  for (const r of rows) out.add(String(r.node_id));
  return out;
}

/** Per-project counts: embedded FUNCTIONS (chunk 0 rows) and total rows. */
export async function countAxonVectorsByProject(): Promise<Map<string, { functions: number; rows: number }>> {
  const out = new Map<string, { functions: number; rows: number }>();
  if (!(await axonTableExists())) return out;
  const t = await getAxonLanceTable();
  const stats = await getAxonTableStats();
  const cols = stats.schemaCurrent ? ['project_id', 'chunk_index'] : ['project_id'];
  const rows = await t.query().select(cols).limit(2000000).toArray();
  for (const r of rows) {
    const k = String(r.project_id);
    const e = out.get(k) ?? { functions: 0, rows: 0 };
    e.rows++;
    if (!stats.schemaCurrent || Number(r.chunk_index ?? 0) === 0) e.functions++;
    out.set(k, e);
  }
  return out;
}

export async function deleteAxonProjectVectors(projectId: string): Promise<void> {
  if (!(await axonTableExists())) return;
  const t = await getAxonLanceTable();
  await t.delete(`project_id = '${projectId.replace(/'/g, "''")}'`);
}
