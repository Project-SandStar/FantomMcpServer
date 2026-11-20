/**
 * LanceDB table `knowledge_cards`: one row per (project, graph node, writer
 * model). The vector uses the code embedding model and width (same as
 * code_vectors), so a query vector from the code encoder matches it. A BM25
 * index on `text` backs the keyword leg.
 *
 * Never drops a populated table. Rows are replaced by row_id.
 */
import type { Table } from '@lancedb/lancedb';
import { getLanceConnection } from '../embedding/lanceConnection.js';
import { tableDimsFor } from '../embedding/providers/embeddingProvider.js';
import { createLogger } from '../utils/index.js';

const logger = createLogger('knowledge-cards');

export const CARD_TABLE_NAME = 'knowledge_cards';

export type CardStatus = 'fresh' | 'stale' | 'check' | 'flagged';
export type CardKind = 'project' | 'pod' | 'class' | 'function';

export interface CardSource {
  file: string;
  /** sha256 of the whole file when the card was built. */
  hash: string;
  lineStart: number;
  lineEnd: number;
  symbol?: string;
}

export interface CardClaim { text: string; file: string; line: number }

export interface CardLink { nodeId: string; name: string; relation: 'caller' | 'callee' | 'contains' | 'contained-by' | 'extends' | 'implements' }

export interface KnowledgeCard {
  rowId: string;
  nodeId: string;
  projectId: number;
  kind: CardKind;
  name: string;
  qualifiedName: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  text: string;
  claims: CardClaim[];
  links: CardLink[];
  sources: CardSource[];
  writerModel: string;
  checkerModel: string;
  builtAt: string;
  confidence: number;
  /** Final check verdict: pass | fail | skipped. */
  checkResult: string;
  /** Verdict of the FIRST check, before any rewrite (failure-rate metric). */
  firstCheck: string;
  attempts: number;
  writerCostUsd: number;
  checkerCostUsd: number;
  status: CardStatus;
  embedModel: string;
}

interface CardRow {
  row_id: string; node_id: string; project_id: number; kind: string; name: string; qualified_name: string;
  file_path: string; line_start: number; line_end: number; text: string; claims_json: string; links_json: string;
  sources_json: string; writer_model: string; checker_model: string; built_at: string; confidence: number;
  check_result: string; first_check: string; attempts: number; writer_cost: number; checker_cost: number;
  status: string; embed_model: string; vector: number[];
}

export function cardRowId(projectId: number, nodeId: string, writerModel: string): string {
  return `${projectId}:${nodeId}:${writerModel}`;
}

function toRow(c: KnowledgeCard, vector: Float32Array | number[]): CardRow {
  return {
    row_id: c.rowId, node_id: c.nodeId, project_id: c.projectId, kind: c.kind, name: c.name,
    qualified_name: c.qualifiedName, file_path: c.filePath, line_start: c.lineStart, line_end: c.lineEnd,
    text: c.text, claims_json: JSON.stringify(c.claims), links_json: JSON.stringify(c.links),
    sources_json: JSON.stringify(c.sources), writer_model: c.writerModel, checker_model: c.checkerModel,
    built_at: c.builtAt, confidence: c.confidence, check_result: c.checkResult, first_check: c.firstCheck,
    attempts: c.attempts, writer_cost: c.writerCostUsd, checker_cost: c.checkerCostUsd, status: c.status,
    embed_model: c.embedModel, vector: Array.from(vector),
  };
}

function parse<T>(s: unknown, def: T): T {
  if (typeof s !== 'string' || !s) return def;
  try { return JSON.parse(s) as T; } catch { return def; }
}

export function fromRow(r: Record<string, any>): KnowledgeCard {
  return {
    rowId: String(r.row_id), nodeId: String(r.node_id), projectId: Number(r.project_id), kind: r.kind as CardKind,
    name: String(r.name ?? ''), qualifiedName: String(r.qualified_name ?? ''), filePath: String(r.file_path ?? ''),
    lineStart: Number(r.line_start ?? 0), lineEnd: Number(r.line_end ?? 0), text: String(r.text ?? ''),
    claims: parse(r.claims_json, []), links: parse(r.links_json, []), sources: parse(r.sources_json, []),
    writerModel: String(r.writer_model ?? ''), checkerModel: String(r.checker_model ?? ''),
    builtAt: String(r.built_at ?? ''), confidence: Number(r.confidence ?? 0), checkResult: String(r.check_result ?? ''),
    firstCheck: String(r.first_check ?? ''), attempts: Number(r.attempts ?? 0),
    writerCostUsd: Number(r.writer_cost ?? 0), checkerCostUsd: Number(r.checker_cost ?? 0),
    status: (r.status ?? 'stale') as CardStatus, embedModel: String(r.embed_model ?? ''),
  };
}

const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;

let table: Table | null = null;
let ftsDirty = true;

export async function cardTableExists(): Promise<boolean> {
  const conn = await getLanceConnection();
  return (await conn.tableNames()).includes(CARD_TABLE_NAME);
}

/** Open, or create at the code embedding width. */
export async function getCardTable(): Promise<Table> {
  if (table && table.isOpen()) return table;
  const conn = await getLanceConnection();
  if ((await conn.tableNames()).includes(CARD_TABLE_NAME)) {
    table = await conn.openTable(CARD_TABLE_NAME);
    return table;
  }
  const dims = tableDimsFor('code');
  logger.info(`Creating ${CARD_TABLE_NAME} at ${dims}d`);
  const init: KnowledgeCard = {
    rowId: '__init__', nodeId: '__init__', projectId: 0, kind: 'function', name: '', qualifiedName: '', filePath: '',
    lineStart: 0, lineEnd: 0, text: '', claims: [], links: [], sources: [], writerModel: '', checkerModel: '',
    builtAt: '', confidence: 0, checkResult: '', firstCheck: '', attempts: 0, writerCostUsd: 0, checkerCostUsd: 0,
    status: 'stale', embedModel: '',
  };
  table = await conn.createTable(CARD_TABLE_NAME, [toRow(init, new Array(dims).fill(0)) as unknown as Record<string, unknown>]);
  await table.delete("row_id = '__init__'");
  return table;
}

/** Insert or replace cards (by row_id). */
export async function upsertCards(items: Array<{ card: KnowledgeCard; vector: Float32Array | number[] }>): Promise<void> {
  if (items.length === 0) return;
  const t = await getCardTable();
  const rows = items.map(i => toRow(i.card, i.vector) as unknown as Record<string, unknown>);
  await t.mergeInsert('row_id').whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(rows);
  ftsDirty = true;
}

/** (Re)build the BM25 index on `text` when rows changed since the last build. */
export async function ensureCardTextIndex(force = false): Promise<void> {
  if (!force && !ftsDirty) return;
  const t = await getCardTable();
  if ((await t.countRows()) === 0) return;
  const { Index } = await import('@lancedb/lancedb');
  await t.createIndex('text', {
    config: Index.fts({ withPosition: false, stem: false, lowercase: true, baseTokenizer: 'simple' }),
    replace: true,
  });
  ftsDirty = false;
}

const LIST_COLUMNS = [
  'row_id', 'node_id', 'project_id', 'kind', 'name', 'qualified_name', 'file_path', 'line_start', 'line_end', 'text',
  'claims_json', 'links_json', 'sources_json', 'writer_model', 'checker_model', 'built_at', 'confidence',
  'check_result', 'first_check', 'attempts', 'writer_cost', 'checker_cost', 'status', 'embed_model',
];

export async function listCards(where?: string, limit = 100_000): Promise<KnowledgeCard[]> {
  if (!(await cardTableExists())) return [];
  const t = await getCardTable();
  let q = t.query().select(LIST_COLUMNS).limit(limit);
  if (where) q = q.where(where);
  return (await q.toArray()).map(fromRow);
}

export async function cardsForProject(projectId: number, writerModel?: string): Promise<KnowledgeCard[]> {
  const w = `project_id = ${Math.trunc(projectId)}` + (writerModel ? ` AND writer_model = ${sqlStr(writerModel)}` : '');
  return listCards(w);
}

export async function cardsByNodeIds(projectId: number, nodeIds: string[], writerModel?: string): Promise<KnowledgeCard[]> {
  if (nodeIds.length === 0) return [];
  const ids = nodeIds.slice(0, 500).map(sqlStr).join(',');
  const w = `project_id = ${Math.trunc(projectId)} AND node_id IN (${ids})` + (writerModel ? ` AND writer_model = ${sqlStr(writerModel)}` : '');
  return listCards(w);
}

/** Set status on given row ids. */
export async function setCardStatus(rowIds: string[], status: CardStatus): Promise<number> {
  if (rowIds.length === 0) return 0;
  const t = await getCardTable();
  let n = 0;
  for (let i = 0; i < rowIds.length; i += 200) {
    const part = rowIds.slice(i, i + 200);
    await t.update({ where: `row_id IN (${part.map(sqlStr).join(',')})`, values: { status } });
    n += part.length;
  }
  return n;
}

/** Cards by row id (chunks of 200). */
export async function cardsByRowIds(rowIds: string[]): Promise<KnowledgeCard[]> {
  const ids = [...new Set(rowIds)];
  if (ids.length === 0) return [];
  const out: KnowledgeCard[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    out.push(...await listCards(`row_id IN (${ids.slice(i, i + 200).map(sqlStr).join(',')})`));
  }
  return out;
}

/** Delete cards by row id (chunks of 200). Returns how many rows existed. An empty list deletes nothing. */
export async function deleteCards(rowIds: string[]): Promise<number> {
  const ids = [...new Set(rowIds)];
  if (ids.length === 0 || !(await cardTableExists())) return 0;
  const t = await getCardTable();
  let n = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const where = `row_id IN (${ids.slice(i, i + 200).map(sqlStr).join(',')})`;
    n += await t.countRows(where);
    await t.delete(where);
  }
  ftsDirty = true;
  return n;
}

/** Slim rows for counts (no text, no JSON, no vectors). */
export interface CardStatusRow { projectId: number; status: CardStatus; confidence: number; writerModel: string }
export async function cardStatusRows(): Promise<CardStatusRow[]> {
  if (!(await cardTableExists())) return [];
  const t = await getCardTable();
  const rows = await t.query().select(['project_id', 'status', 'confidence', 'writer_model']).limit(10_000_000).toArray();
  return rows.map(r => ({
    projectId: Number(r.project_id), status: (r.status ?? 'stale') as CardStatus,
    confidence: Number(r.confidence ?? 0), writerModel: String(r.writer_model ?? ''),
  }));
}

/** Overwrite the sources of one card (staleness test helper). */
export async function setCardSources(rowId: string, sources: CardSource[]): Promise<void> {
  const t = await getCardTable();
  await t.update({ where: `row_id = ${sqlStr(rowId)}`, values: { sources_json: JSON.stringify(sources) } });
}

export interface CardHit { card: KnowledgeCard; score: number; via: 'vector' | 'fts' | 'both' }

/**
 * Hybrid search: vector (cosine) + BM25, fused. `score` is the cosine
 * similarity when the vector leg found the card, else 0 (FTS only).
 */
export async function searchCards(
  vector: Float32Array | null,
  text: string,
  opts: { projectIds?: number[]; writerModel?: string; limit?: number } = {},
): Promise<CardHit[]> {
  if (!(await cardTableExists())) return [];
  const t = await getCardTable();
  const limit = opts.limit ?? 10;
  const parts: string[] = [];
  if (opts.projectIds?.length) parts.push(`project_id IN (${opts.projectIds.map(n => Math.trunc(n)).join(',')})`);
  if (opts.writerModel) parts.push(`writer_model = ${sqlStr(opts.writerModel)}`);
  const where = parts.join(' AND ');
  const byId = new Map<string, CardHit>();
  if (vector) {
    let q = t.vectorSearch(vector).distanceType('cosine').select([...LIST_COLUMNS, '_distance']).limit(limit * 2);
    if (where) q = q.where(where);
    for (const r of await q.toArray()) {
      const sim = 1 - Number(r._distance ?? 1);
      byId.set(String(r.row_id), { card: fromRow(r), score: sim, via: 'vector' });
    }
  }
  const terms = text.replace(/[^A-Za-z0-9_.]+/g, ' ').trim();
  if (terms) {
    try {
      await ensureCardTextIndex();
      let q = t.query().fullTextSearch(terms, { columns: 'text' }).select(LIST_COLUMNS).limit(limit * 2);
      if (where) q = q.where(where);
      for (const r of await q.toArray()) {
        const id = String(r.row_id);
        const hit = byId.get(id);
        if (hit) hit.via = 'both';
        else byId.set(id, { card: fromRow(r), score: 0, via: 'fts' });
      }
    } catch (err) {
      logger.warn(`card FTS leg failed: ${(err as Error).message}`);
    }
  }
  // Fused order: cards both legs found first, then by cosine.
  return [...byId.values()]
    .sort((a, b) => (Number(b.via === 'both') - Number(a.via === 'both')) || b.score - a.score)
    .slice(0, limit);
}

export function __resetCardTableForTest(): void { table = null; ftsDirty = true; }
