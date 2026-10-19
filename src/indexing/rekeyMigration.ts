/**
 * Re-key one project to stable symbol keys (lazy-incremental-indexing.md
 * 3.8, phase 2). Run by hand per project: POST /admin/indexing/rekey/:id
 * enqueues a `rekey` task, the scheduler's runNow lane runs it.
 *
 * Steps, each safe to repeat:
 *   1. fantom_projects.key_scheme = 2 (never set back: from here every parse
 *      of the project writes stable ids).
 *   2. Forced re-parse with stable keys, graph rebuilt with the new ids
 *      (symbol_key / body_sha on CodeNode), no embedding. The parse returns
 *      legacy id → new id per symbol.
 *   3. symbol_links kind 'rekey' (old_key = legacy id, new_key = symbol key,
 *      new_node_id = new id), rewritten as a whole for the project.
 *   4. code_vectors: in pages of 256 links, copy the legacy rows to the new
 *      ids, verify every copied (node, chunk) is present, then delete those
 *      legacy rows. Each copied vector also seeds embed_cache. No provider
 *      call: a vector is only ever copied.
 *   5. fantom_projects.rekeyed_at = now. A second run is a no-op.
 *
 * Resume: a crash anywhere repeats from step 2. The legacy ids come from
 * the parsers (unchanged), so the map is the same; rows already copied are
 * skipped, rows already deleted are simply not found.
 *
 * The task holds the heavy-job lock for its whole run, so lazy parse and
 * embed workers and the embed watchdog stand down until it ends; it yields
 * when another heavy job holds the lock.
 */

import type { PrismaClient } from '@prisma/client';
import type { Table } from '@lancedb/lancedb';
import { createLogger } from '../utils/index.js';
import { KEY_SCHEME_STABLE, type SymbolIdMapping } from '../fantom-code/symbolKey.js';
import type { EmbedCache } from '../embedding/embedCache.js';
import { textHash } from '../embedding/embedCache.js';
import { EMBED_TEXT_VERSION } from '../embedding/embeddingText.js';
import { enqueueTableWrite } from '../embedding/vectorWriteQueue.js';

const logger = createLogger('rekey');

export const REKEY_PAGE = 256;

export interface RekeyDeps {
  prisma: PrismaClient;
  /** The active code_vectors table. */
  vectors: () => Promise<Table>;
  /** embed_cache to seed; null = do not seed. */
  cache: EmbedCache | null;
  /**
   * Forced re-parse + graph rebuild of the project with stable keys and no
   * embedding; `onSymbolKeys` receives legacy → new per parsed file.
   */
  reindex: (projectId: number, onSymbolKeys: (m: SymbolIdMapping[]) => void) => Promise<{ runId?: number | null; errors?: number }>;
  /** Take the heavy-job lock: release function, or the holder's label when busy. */
  acquireHeavy: (label: string) => (() => void) | string;
  pageSize?: number;
}

export interface RekeyResult {
  status: 'done' | 'already';
  projectId: number;
  symbols: number;
  links: number;
  /** Vector rows copied to a new id. */
  copied: number;
  /** Rows the new id already had (an earlier, interrupted run). */
  alreadyNew: number;
  /** Legacy rows deleted after the copy was verified. */
  deletedLegacy: number;
  /** Symbols with no vector under either id (embedded by the next embed run). */
  noVector: number;
  cacheSeeded: number;
  runId: number | null;
  parseErrors: number;
  ms: number;
}

export type RekeyOutcome = RekeyResult | { status: 'yielded'; holder: string };

function sqlList(ids: string[]): string {
  return ids.map(id => `'${id.replace(/'/g, "''")}'`).join(',');
}

type VecRow = Record<string, unknown> & { node_id: string; chunk_index?: number; vector: unknown };

function plain(r: unknown): VecRow {
  const o = (typeof (r as { toJSON?: unknown }).toJSON === 'function' ? (r as { toJSON(): unknown }).toJSON() : { ...(r as object) }) as VecRow;
  const v = o.vector as unknown;
  o.vector = v instanceof Float32Array ? Array.from(v) : Array.isArray(v) ? v : Array.from(v as Iterable<number>);
  return o;
}

const chunkOf = (r: { chunk_index?: unknown }) => Number(r.chunk_index ?? 0) || 0;

export async function runRekey(deps: RekeyDeps, projectId: number): Promise<RekeyOutcome> {
  const t0 = Date.now();
  const { prisma } = deps;
  const project = await prisma.fantomProject.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, keyScheme: true, rekeyedAt: true },
  });
  if (!project) throw new Error(`project ${projectId} not found`);
  const empty = { projectId, symbols: 0, links: 0, copied: 0, alreadyNew: 0, deletedLegacy: 0, noVector: 0, cacheSeeded: 0, runId: null, parseErrors: 0 };
  if (project.rekeyedAt && project.keyScheme >= KEY_SCHEME_STABLE) {
    return { status: 'already', ...empty, ms: Date.now() - t0 };
  }

  const lock = deps.acquireHeavy(`rekey project ${projectId}`);
  if (typeof lock === 'string') return { status: 'yielded', holder: lock };
  try {
    // 1. Marker first: never goes back to 1.
    if (project.keyScheme < KEY_SCHEME_STABLE) {
      await prisma.fantomProject.update({ where: { id: projectId }, data: { keyScheme: KEY_SCHEME_STABLE } });
    }

    // 2. Re-parse with stable keys; the graph is rebuilt with the new ids.
    const byLegacy = new Map<string, SymbolIdMapping>();
    const run = await deps.reindex(projectId, ms => {
      for (const m of ms) if (m.legacyId && m.legacyId !== m.newId) byLegacy.set(m.legacyId, m);
    });
    logger.info(`[rekey] project=${projectId} parsed: ${byLegacy.size} symbols (run ${run.runId ?? '?'})`);

    // 3. symbol_links, rewritten as a whole (idempotent).
    await prisma.symbolLink.deleteMany({ where: { projectId, kind: 'rekey' } });
    const all = [...byLegacy.values()];
    for (let i = 0; i < all.length; i += 500) {
      await prisma.symbolLink.createMany({
        data: all.slice(i, i + 500).map(m => ({
          projectId, kind: 'rekey', oldKey: m.legacyId, newKey: m.symbolKey, newNodeId: m.newId, runId: run.runId ?? null,
        })),
      });
    }

    // 4. Copy vectors page by page.
    const table = await deps.vectors();
    const cols = new Set((await table.schema()).fields.map(f => f.name));
    const page = Math.max(1, deps.pageSize ?? REKEY_PAGE);
    const res = { ...empty, symbols: all.length, links: all.length, runId: run.runId ?? null, parseErrors: run.errors ?? 0 };
    for (let i = 0; i < all.length; i += page) {
      const slice = all.slice(i, i + page);
      const legacyIds = slice.map(m => m.legacyId);
      const newIds = slice.map(m => m.newId);
      const legacyRows = (await table.query()
        .where(`project_id = ${projectId} AND node_id IN (${sqlList(legacyIds)})`)
        .toArray()).map(plain);
      const presentNew = async () => {
        const rows = await table.query()
          .where(`project_id = ${projectId} AND node_id IN (${sqlList(newIds)})`)
          .select(cols.has('chunk_index') ? ['node_id', 'chunk_index'] : ['node_id'])
          .toArray();
        return new Set((rows as Array<{ node_id: string; chunk_index?: number }>).map(r => `${r.node_id}#${chunkOf(r)}`));
      };
      const before = await presentNew();
      const copies: VecRow[] = [];
      const hasLegacy = new Set<string>();
      for (const r of legacyRows) {
        const m = byLegacy.get(r.node_id);
        if (!m) continue;
        hasLegacy.add(m.newId);
        const ci = chunkOf(r);
        if (before.has(`${m.newId}#${ci}`)) { res.alreadyNew++; continue; }
        const c: VecRow = { ...r, node_id: m.newId };
        if (cols.has('row_id')) c.row_id = ci === 0 ? m.newId : `${m.newId}#${ci}`;
        if (cols.has('qualified_name') && !c.qualified_name) c.qualified_name = m.qualifiedName;
        copies.push(c);
      }
      if (copies.length > 0) {
        await enqueueTableWrite(table, () => table.add(copies));
        res.copied += copies.length;
      }
      const newWithRow = new Set([...before].map(k => k.slice(0, k.lastIndexOf('#'))));
      for (const m of slice) {
        if (!hasLegacy.has(m.newId) && !newWithRow.has(m.newId)) res.noVector++;
      }
      if (legacyRows.length === 0) continue;

      // Verify, then delete only the legacy rows whose every chunk is present.
      const after = await presentNew();
      const ok = new Set<string>();
      const bad = new Set<string>();
      for (const r of legacyRows) {
        const m = byLegacy.get(r.node_id);
        if (!m) continue;
        if (after.has(`${m.newId}#${chunkOf(r)}`)) ok.add(r.node_id); else bad.add(r.node_id);
      }
      for (const b of bad) ok.delete(b);
      if (bad.size > 0) {
        throw new Error(`rekey copy not verified for ${bad.size} symbol(s) of project ${projectId} (page ${i / page + 1}); legacy rows kept`);
      }
      if (ok.size > 0) {
        const delIds = [...ok];
        await enqueueTableWrite(table, () => table.delete(`project_id = ${projectId} AND node_id IN (${sqlList(delIds)})`));
        res.deletedLegacy += legacyRows.filter(r => ok.has(r.node_id)).length;
      }

      // Seed embed_cache from the copied rows (text + model stored with the vector).
      if (deps.cache && cols.has('text') && cols.has('model')) {
        const byModel = new Map<string, Array<{ hash: string; vector: number[] }>>();
        for (const r of legacyRows) {
          const text = typeof r.text === 'string' ? r.text : '';
          const model = typeof r.model === 'string' ? r.model : '';
          if (!text || !model) continue;
          const list = byModel.get(model) ?? [];
          list.push({ hash: textHash(text), vector: r.vector as number[] });
          byModel.set(model, list);
        }
        for (const [model, entries] of byModel) {
          try { res.cacheSeeded += await deps.cache.store(model, EMBED_TEXT_VERSION, entries); } catch (err) {
            logger.warn(`[rekey] cache seed failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }

    // 5. Done.
    await prisma.fantomProject.update({ where: { id: projectId }, data: { rekeyedAt: new Date() } });
    const out: RekeyResult = { status: 'done', ...res, ms: Date.now() - t0 };
    logger.info(`[rekey] project=${projectId} done: ${JSON.stringify(out)}`);
    return out;
  } finally {
    lock();
  }
}
