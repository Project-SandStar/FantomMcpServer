/**
 * File-level graph patch (docs/proposals/lazy-incremental-indexing.md 3.4,
 * phase 3). Replaces "clear the file, rebuild the file" in reindexFiles with a
 * diff by key against the per-project LadybugDB store:
 *
 *   1. Preload the name index of every node outside the patched files, so
 *      references from the parsed files resolve across files (G4).
 *   2. Diff each file's nodes by key: symbol_key for a re-keyed project
 *      (key_scheme 2), file + qualified name for a legacy one. Same key and
 *      same id → update the properties in place; incoming edges survive
 *      because the node survives. New key → create. Gone key → delete.
 *      Outgoing edges of the patched files are always deleted and recreated
 *      from the parse.
 *   3. Renames and moves: a gone key and a new key with the same body_sha
 *      (or the same body once the new name is swapped back to the old one,
 *      since the span includes the declaration line) are linked in
 *      symbol_links (kind 'rename' in the same file, 'move' across files);
 *      the incoming edges of the old node from unpatched files are re-pointed
 *      to the new id before the old node goes. A legacy id that changed with
 *      the line number is re-pointed the same way, without a link.
 *   4. Dangling references go to pending_refs and resolve when a later patch
 *      adds a matching symbol. Incoming edges of a deleted symbol become
 *      pending_refs too (and EdgeChange 'removed' rows), so they come back
 *      with the symbol.
 *
 * Writes use the same batched UNWIND helpers as a full build (200 rows per
 * statement, CHECKPOINT folds), so a patch stays inside the per-project
 * buffer pool; the store is checkpointed at the end.
 */

import * as fs from 'fs';
import type { PrismaClient } from '@prisma/client';
import { createLogger } from '../utils/index.js';
import type { ParsedFile } from '../fantom-code/types.js';
import { bodySha } from '../fantom-code/symbolKey.js';
import { ladybugExecute, ladybugQuery } from '../graph/ladybugConnection.js';
import {
  LadybugGraphBuilder,
  checkpointQuietly,
  createEdgesFromBatch,
  createNodesFromBatch,
  ensureSymbolKeyColumns,
  type LadybugEdgeInput,
  type LadybugNodeInput,
} from '../graph/ladybugGraphBuilder.js';
import { invalidateProjectNodeCount } from '../graph/projectNodeCounts.js';
import type { UnresolvedRef } from '../graph/types.js';

const logger = createLogger('graph-patch');

export const DEFAULT_MAX_PRELOAD_NODES = 200_000;
export const DEFAULT_MAX_PENDING_REFS = 50_000;
const IN_CHUNK = 200;
const SET_BATCH = 200;
const SQL_BATCH = 80;

export interface GraphPatchInput {
  projectId: number;
  /** Parsed files of the change set; each one replaces its file's nodes. */
  parsedFiles: ParsedFile[];
  /** Files gone from disk: all their nodes are removed. */
  removedPaths?: string[];
  /** pending_refs, symbol_links and edge_changes; null = graph only. */
  prisma?: PrismaClient | null;
  runId?: number | null;
  /** Above this many nodes in the store the patch refuses (status 'too-large'). */
  maxPreloadNodes?: number;
  maxPendingRefs?: number;
}

export interface SymbolLinkRow {
  oldKey: string;
  newKey: string;
  oldId: string;
  newId: string;
  kind: 'rename' | 'move';
}

export interface GraphPatchResult {
  status: 'patched' | 'too-large';
  storeNodes: number;
  preloaded: number;
  nodesCreated: number;
  nodesUpdated: number;
  nodesUnchanged: number;
  nodesDeleted: number;
  edgesCreated: number;
  /** Incoming edges from unpatched files moved to a renamed / re-id'd node. */
  incomingRepointed: number;
  /** Incoming edges from unpatched files whose target is gone (now pending_refs). */
  incomingLost: number;
  /** Ids whose embed text may differ: created, plus updated with a body / signature / doc change. */
  changedIds: string[];
  /** Ids whose stored vectors are stale: updated-with-change and deleted. */
  staleVectorIds: string[];
  deletedIds: string[];
  links: SymbolLinkRow[];
  unresolved: number;
  pendingAdded: number;
  pendingResolved: number;
  durationMs: number;
}

interface OldNode {
  id: string; qn: string; name: string; nt: string; fp: string;
  ls: number; le: number; sig: string; doc: string; rt: string;
  mods: string; facets: string; pt: string;
  key: string; sha: string;
}

interface IncomingEdge {
  sid: string; sqn: string; sfp: string; skey: string;
  tid: string; tqn: string; tname: string;
  et: string; ln: number; cn: number; r: boolean; c: number; m: string; x: boolean;
}

function esc(val: string | undefined | null): string {
  if (val == null) return '';
  return val.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

const inList = (xs: string[]) => xs.map(x => `'${esc(x)}'`).join(', ');

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Last name segment: "pod::Type.slot" → "slot", "Type" → "Type". */
export function targetTail(name: string): string {
  const afterPod = name.includes('::') ? name.slice(name.lastIndexOf('::') + 2) : name;
  return afterPod.includes('.') ? afterPod.slice(afterPod.lastIndexOf('.') + 1) : afterPod;
}

const isPoolFull = (err: unknown) => /buffer pool is full|unable to allocate memory/i.test(String(err));

/** ladybugExecute with one CHECKPOINT-and-retry on a full buffer pool. */
async function exec(projectId: number, cypher: string): Promise<void> {
  try {
    await ladybugExecute(projectId, cypher);
  } catch (err) {
    if (!isPoolFull(err)) throw err;
    await checkpointQuietly(projectId);
    await ladybugExecute(projectId, cypher);
  }
}

async function hasKeyColumns(projectId: number): Promise<boolean> {
  const rows = await ladybugQuery<{ name: string }>(projectId, `CALL TABLE_INFO('CodeNode') RETURN name`);
  const names = new Set(rows.map(r => r.name));
  return names.has('symbol_key') && names.has('body_sha');
}

function diffKeyOfRow(n: LadybugNodeInput): string {
  return n.symbolKey ? `k:${n.symbolKey}` : `q:${n.filePath}\u001f${n.qualifiedName}`;
}
function diffKeyOfOld(n: OldNode): string {
  return n.key ? `k:${n.key}` : `q:${n.fp}\u001f${n.qn}`;
}

/** Properties a patch writes on an updated node (same set as renderNodeRow). */
function setRow(n: LadybugNodeInput, keyed: boolean): string {
  const keyProps = keyed ? `, symbol_key: '${esc(n.symbolKey ?? '')}', body_sha: '${esc(n.bodySha ?? '')}'` : '';
  return `{id: '${esc(n.id)}', name: '${esc(n.name)}', qn: '${esc(n.qualifiedName)}', fp: '${esc(n.filePath)}', ` +
    `nt: '${esc(n.nodeType)}', ls: ${n.lineStart ?? 1}, le: ${n.lineEnd ?? n.lineStart ?? 1}, ` +
    `sig: '${esc(n.signature ?? '')}', doc: '${esc(n.documentation ?? '')}', rt: '${esc(n.returnType ?? '')}', ` +
    `mods: '${esc(n.modifiers ?? '')}', facets: '${esc(n.facets ?? '')}', pt: '${esc(n.parentType ?? '')}', ` +
    `pub: ${n.isPublic ?? true}, st: ${n.isStatic ?? false}, ab: ${n.isAbstract ?? false}, ` +
    `vi: ${n.isVirtual ?? false}, ov: ${n.isOverride ?? false}${keyProps}}`;
}

/** Does the node differ from its stored copy in anything a patch writes? */
function differs(o: OldNode, n: LadybugNodeInput, keyed: boolean): boolean {
  return o.ls !== (n.lineStart ?? 1) || o.le !== (n.lineEnd ?? n.lineStart ?? 1) ||
    o.qn !== n.qualifiedName || o.name !== n.name || o.sig !== (n.signature ?? '') ||
    o.doc !== (n.documentation ?? '') || o.rt !== (n.returnType ?? '') ||
    o.mods !== (n.modifiers ?? '') || o.facets !== (n.facets ?? '') || o.pt !== (n.parentType ?? '') ||
    o.nt !== n.nodeType || (keyed && (o.sha !== (n.bodySha ?? '') || o.key !== (n.symbolKey ?? '')));
}

/** Did the embed text's inputs change (body, signature, doc)? A line shift does not count. */
function contentChanged(o: OldNode, n: LadybugNodeInput): boolean {
  // Legacy store (no body_sha): the body is unknown, so assume it changed.
  if (!o.sha || !n.bodySha) return true;
  return o.sha !== n.bodySha || o.sig !== (n.signature ?? '') || o.doc !== (n.documentation ?? '') ||
    o.qn !== n.qualifiedName || o.nt !== n.nodeType;
}

/**
 * Patch the graph for a set of changed files. Never throws on a refused patch:
 * status 'too-large' means nothing was written and the caller should run a
 * full reindex.
 */
export async function patchProjectGraph(input: GraphPatchInput): Promise<GraphPatchResult> {
  const t0 = Date.now();
  const { projectId, parsedFiles, prisma = null, runId = null } = input;
  const maxPreload = input.maxPreloadNodes ?? DEFAULT_MAX_PRELOAD_NODES;
  const maxPending = input.maxPendingRefs ?? DEFAULT_MAX_PENDING_REFS;
  const patched = new Set<string>([...parsedFiles.map(p => p.filePath), ...(input.removedPaths ?? [])]);
  const patchedList = [...patched];

  const result: GraphPatchResult = {
    status: 'patched', storeNodes: 0, preloaded: 0,
    nodesCreated: 0, nodesUpdated: 0, nodesUnchanged: 0, nodesDeleted: 0,
    edgesCreated: 0, incomingRepointed: 0, incomingLost: 0,
    changedIds: [], staleVectorIds: [], deletedIds: [], links: [],
    unresolved: 0, pendingAdded: 0, pendingResolved: 0, durationMs: 0,
  };

  // ── 1. Size check, then preload the names of every node outside the patch.
  const countRows = await ladybugQuery<{ c: number }>(projectId, `MATCH (n:CodeNode) RETURN count(n) AS c`);
  result.storeNodes = Number(countRows[0]?.c ?? 0);
  if (result.storeNodes > maxPreload) {
    result.status = 'too-large';
    result.durationMs = Date.now() - t0;
    logger.info(`[graph-patch] project ${projectId}: ${result.storeNodes} nodes > maxPreloadNodes ${maxPreload}; full reindex instead`);
    return result;
  }

  const builder = new LadybugGraphBuilder(projectId);
  const nameRows = await ladybugQuery<{ id: string; qn: string; fp: string }>(
    projectId, `MATCH (n:CodeNode) RETURN n.id AS id, n.qualified_name AS qn, n.file_path AS fp`,
  );
  result.preloaded = builder.preloadExistingNames(
    nameRows.filter(r => !patched.has(r.fp)).map(r => [r.qn, r.id] as [string, string]),
  );
  const fileOfId = new Map(nameRows.map(r => [r.id, r.fp]));

  const plan = await builder.planFiles(parsedFiles);
  const newRows: LadybugNodeInput[] = [];
  {
    const seen = new Set<string>();
    for (const n of plan.nodeRows) if (!seen.has(n.id)) { seen.add(n.id); newRows.push(n); }
  }

  let keyed = await hasKeyColumns(projectId);
  if (!keyed && newRows.some(n => !!n.symbolKey)) {
    await ensureSymbolKeyColumns(projectId);
    keyed = true;
  }

  // ── 2. Old nodes of the patched files, diffed by key.
  const old: OldNode[] = [];
  const keyCols = keyed ? `, n.symbol_key AS key, n.body_sha AS sha` : '';
  for (const part of chunks(patchedList, IN_CHUNK)) {
    const rows = await ladybugQuery<Record<string, unknown>>(projectId,
      `MATCH (n:CodeNode) WHERE n.file_path IN [${inList(part)}]
       RETURN n.id AS id, n.qualified_name AS qn, n.name AS name, n.node_type AS nt, n.file_path AS fp,
              n.line_start AS ls, n.line_end AS le, n.signature AS sig, n.documentation AS doc,
              n.return_type AS rt, n.modifiers AS mods, n.facets AS facets, n.parent_type AS pt${keyCols}`);
    for (const r of rows) {
      old.push({
        id: String(r.id), qn: String(r.qn ?? ''), name: String(r.name ?? ''), nt: String(r.nt ?? ''),
        fp: String(r.fp ?? ''), ls: Number(r.ls ?? 1), le: Number(r.le ?? r.ls ?? 1),
        sig: String(r.sig ?? ''), doc: String(r.doc ?? ''), rt: String(r.rt ?? ''),
        mods: String(r.mods ?? ''), facets: String(r.facets ?? ''), pt: String(r.pt ?? ''),
        key: String(r.key ?? ''), sha: String(r.sha ?? ''),
      });
    }
  }
  const oldByKey = new Map<string, OldNode>();
  const oldExtra: OldNode[] = [];
  for (const o of old) {
    const k = diffKeyOfOld(o);
    if (oldByKey.has(k)) oldExtra.push(o); else oldByKey.set(k, o);
  }

  const updates: LadybugNodeInput[] = [];
  const creates: LadybugNodeInput[] = [];
  const repoint = new Map<string, string>(); // old id → new id
  const matchedOld = new Set<string>();
  const changed = new Set<string>();
  const stale = new Set<string>();
  for (const n of newRows) {
    const o = oldByKey.get(diffKeyOfRow(n));
    if (o && o.id === n.id) {
      matchedOld.add(o.id);
      if (differs(o, n, keyed)) { updates.push(n); result.nodesUpdated++; } else result.nodesUnchanged++;
      if (contentChanged(o, n)) { changed.add(n.id); stale.add(n.id); }
    } else if (o) {
      // Same key, different id: a legacy id that moved with its line number.
      matchedOld.add(o.id);
      repoint.set(o.id, n.id);
      creates.push(n);
      changed.add(n.id);
    } else {
      creates.push(n);
      changed.add(n.id);
    }
  }
  const gone = [...oldByKey.values(), ...oldExtra].filter(o => !matchedOld.has(o.id));

  // ── 3. Renames and moves among gone / created keyed nodes.
  const createdKeyed = creates.filter(n => n.symbolKey && n.bodySha && !repoint.has(n.id));
  const goneKeyed = gone.filter(o => o.key && o.sha);
  const linkedGone = new Set<string>();
  const linkedNew = new Set<string>();
  const link = (o: OldNode, n: LadybugNodeInput) => {
    linkedGone.add(o.id); linkedNew.add(n.id);
    repoint.set(o.id, n.id);
    result.links.push({
      oldKey: o.key, newKey: n.symbolKey!, oldId: o.id, newId: n.id,
      kind: o.fp === n.filePath ? 'rename' : 'move',
    });
  };
  {
    const count = <T>(xs: T[], f: (x: T) => string) => {
      const m = new Map<string, T[]>();
      for (const x of xs) { const k = f(x); const g = m.get(k); if (g) g.push(x); else m.set(k, [x]); }
      return m;
    };
    const goneBySha = count(goneKeyed, o => o.sha);
    const newBySha = count(createdKeyed, n => n.bodySha!);
    for (const [sha, gs] of goneBySha) {
      const ns = newBySha.get(sha);
      if (gs.length === 1 && ns?.length === 1) link(gs[0], ns[0]);
    }
    // Renamed: the span holds the declaration, so swap the new name back.
    const lines = new Map<string, string[]>();
    const linesOf = (fp: string) => {
      let l = lines.get(fp);
      if (!l) { try { l = fs.readFileSync(fp, 'utf-8').split(/\r?\n/); } catch { l = []; } lines.set(fp, l); }
      return l;
    };
    for (const n of createdKeyed) {
      if (linkedNew.has(n.id)) continue;
      const cands = goneKeyed.filter(o => !linkedGone.has(o.id) && o.nt === n.nodeType && o.name && o.name !== n.name);
      if (cands.length === 0) continue;
      const start = Math.max(1, n.lineStart ?? 1);
      const span = linesOf(n.filePath).slice(start - 1, Math.max(start, n.lineEnd ?? start));
      if (span.length === 0) continue;
      const re = new RegExp(`\\b${n.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
      const hits = cands.filter(o => bodySha(span.map(s => s.replace(re, o.name))) === o.sha);
      if (hits.length === 1) link(hits[0], n);
    }
  }

  // Gone nodes plus the old side of every re-id'd pair.
  const deleteSet = new Set([...gone.map(o => o.id), ...repoint.keys()]);
  for (const id of deleteSet) stale.add(id);

  // ── 4. Incoming edges of nodes about to go, from files outside the patch.
  const incoming: IncomingEdge[] = [];
  if (deleteSet.size > 0) {
    const skey = keyed ? `, a.symbol_key AS skey` : '';
    for (const part of chunks([...deleteSet], IN_CHUNK)) {
      const rows = await ladybugQuery<Record<string, unknown>>(projectId,
        `MATCH (a:CodeNode)-[e:CodeEdge]->(b:CodeNode) WHERE b.id IN [${inList(part)}]
         RETURN a.id AS sid, a.qualified_name AS sqn, a.file_path AS sfp${skey},
                b.id AS tid, b.qualified_name AS tqn, b.name AS tname,
                e.edge_type AS et, e.line_number AS ln, e.col_number AS cn, e.is_resolved AS r,
                e.confidence AS c, e.metadata AS m, e.cross_language AS x`);
      for (const r of rows) {
        if (patched.has(String(r.sfp))) continue; // recreated from the parse
        incoming.push({
          sid: String(r.sid), sqn: String(r.sqn ?? ''), sfp: String(r.sfp ?? ''), skey: String(r.skey ?? ''),
          tid: String(r.tid), tqn: String(r.tqn ?? ''), tname: String(r.tname ?? ''),
          et: String(r.et ?? 'calls'), ln: Number(r.ln ?? 0), cn: Number(r.cn ?? 0),
          r: r.r == null ? true : Boolean(r.r), c: Number(r.c ?? 1), m: String(r.m ?? ''), x: Boolean(r.x ?? false),
        });
      }
    }
  }

  // ── 5. Writes. Outgoing edges of the patched files go first.
  for (const part of chunks(patchedList, IN_CHUNK)) {
    await exec(projectId, `MATCH (a:CodeNode)-[e:CodeEdge]->() WHERE a.file_path IN [${inList(part)}] DELETE e`);
  }
  const keyAssign = keyed ? `, n.symbol_key = row.symbol_key, n.body_sha = row.body_sha` : '';
  for (const part of chunks(updates, SET_BATCH)) {
    await exec(projectId,
      `UNWIND [${part.map(n => setRow(n, keyed)).join(',\n')}] AS row
       MATCH (n:CodeNode {id: row.id})
       SET n.name = row.name, n.qualified_name = row.qn, n.file_path = row.fp, n.node_type = row.nt,
           n.line_start = row.ls, n.line_end = row.le, n.signature = row.sig, n.documentation = row.doc,
           n.return_type = row.rt, n.modifiers = row.mods, n.facets = row.facets, n.parent_type = row.pt,
           n.is_public = row.pub, n.is_static = row.st, n.is_abstract = row.ab, n.is_virtual = row.vi,
           n.is_override = row.ov${keyAssign}`);
  }
  if (creates.length > 0) {
    // A node id that survives elsewhere (same id, other file) is skipped by
    // createNodesFromBatch; delete-before-create keeps the patch idempotent.
    result.nodesCreated = (await createNodesFromBatch(creates)).created;
  }

  // Outgoing edges from the parse, plus re-pointed incoming edges.
  const edgeRows: LadybugEdgeInput[] = [...plan.edgeRows];
  const lost: IncomingEdge[] = [];
  for (const e of incoming) {
    const to = repoint.get(e.tid);
    if (to) {
      edgeRows.push({
        sourceId: e.sid, targetId: to, edgeType: e.et, lineNumber: e.ln, colNumber: e.cn,
        isResolved: e.r, confidence: e.c, metadata: e.m, crossLanguage: e.x,
      });
      result.incomingRepointed++;
    } else {
      lost.push(e);
    }
  }
  result.incomingLost = lost.length;
  if (edgeRows.length > 0) result.edgesCreated = (await createEdgesFromBatch(projectId, edgeRows)).created;

  for (const part of chunks([...deleteSet], IN_CHUNK)) {
    await exec(projectId, `MATCH (n:CodeNode) WHERE n.id IN [${inList(part)}] DETACH DELETE n`);
  }
  result.nodesDeleted = deleteSet.size;

  // ── 6. pending_refs, symbol_links, edge_changes (SQLite).
  const unresolved = builder.unresolvedRefRows();
  result.unresolved = unresolved.length;
  // Lost incoming edges wait for their target under its old name.
  for (const e of lost) {
    unresolved.push({
      sourceId: e.sid, sourceFile: e.sfp, sourceKey: e.skey, targetName: e.tqn, edgeType: e.et,
      line: e.ln, col: e.cn, confidence: e.c, className: '',
    });
  }
  if (prisma) {
    try {
      await writeSqlSide(prisma, projectId, runId, patchedList, unresolved, lost, result);
      // Re-resolve pending refs of other files whose target name now exists.
      const tails = [...new Set([...creates, ...updates].map(n => targetTail(n.qualifiedName)).concat(creates.map(n => n.name)))];
      const resolved = await resolvePendingRefs(prisma, projectId, builder, tails, patched, fileOfId);
      result.pendingResolved = resolved.edges.length;
      if (resolved.edges.length > 0) result.edgesCreated += (await createEdgesFromBatch(projectId, resolved.edges)).created;
      await trimPendingRefs(prisma, projectId, maxPending);
    } catch (err) {
      logger.warn(`[graph-patch] project ${projectId}: pending_refs / symbol_links write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await checkpointQuietly(projectId);
  invalidateProjectNodeCount(projectId);

  result.changedIds = [...changed];
  result.staleVectorIds = [...stale];
  result.deletedIds = [...deleteSet];
  result.durationMs = Date.now() - t0;
  logger.info(
    `[graph-patch] project ${projectId}: files=${patchedList.length} preload=${result.preloaded} ` +
    `+${result.nodesCreated} ~${result.nodesUpdated} =${result.nodesUnchanged} -${result.nodesDeleted} ` +
    `edges=${result.edgesCreated} repointed=${result.incomingRepointed} lost=${result.incomingLost} ` +
    `links=${result.links.length} pending +${result.pendingAdded} resolved=${result.pendingResolved} in ${result.durationMs}ms`,
  );
  return result;
}

async function writeSqlSide(
  prisma: PrismaClient, projectId: number, runId: number | null, patchedList: string[],
  unresolved: UnresolvedRef[], lost: IncomingEdge[], result: GraphPatchResult,
): Promise<void> {
  // The patched files' own rows are rewritten from this parse.
  for (const part of chunks(patchedList, 400)) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM pending_refs WHERE project_id = ? AND source_file IN (${part.map(() => '?').join(',')})`,
      projectId, ...part,
    );
  }
  result.pendingAdded = await insertPendingRefs(prisma, projectId, unresolved);

  for (const l of result.links) {
    await prisma.symbolLink.upsert({
      where: { projectId_kind_oldKey: { projectId, kind: l.kind, oldKey: l.oldKey } },
      create: { projectId, kind: l.kind, oldKey: l.oldKey, newKey: l.newKey, newNodeId: l.newId, runId },
      update: { newKey: l.newKey, newNodeId: l.newId, runId, at: new Date() },
    });
  }

  if (runId != null && lost.length > 0) {
    await prisma.edgeChange.createMany({
      data: lost.map(e => ({ runId, projectId, sourceQn: e.sqn, targetQn: e.tqn, edgeType: e.et, changeType: 'removed' })),
    });
  }
}

/** Insert pending_refs rows (raw SQL: works before `prisma generate`). */
export async function insertPendingRefs(prisma: PrismaClient, projectId: number, refs: UnresolvedRef[]): Promise<number> {
  let n = 0;
  for (const part of chunks(refs, SQL_BATCH)) {
    const params: unknown[] = [];
    for (const r of part) {
      params.push(projectId, r.sourceFile, r.sourceKey ?? '', r.sourceId, r.targetName, targetTail(r.targetName),
        r.edgeType, r.line ?? 0, r.col ?? 0, r.confidence ?? 1, r.className ?? '');
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO pending_refs (project_id, source_file, source_key, source_id, target_name, target_tail, edge_type, line, col, confidence, class_name)
       VALUES ${part.map(() => '(?,?,?,?,?,?,?,?,?,?,?)').join(',')}`,
      ...params,
    );
    n += part.length;
  }
  return n;
}

/** Replace every pending_refs row of a project (a full rebuild). */
export async function replacePendingRefs(prisma: PrismaClient, projectId: number, refs: UnresolvedRef[], max = DEFAULT_MAX_PENDING_REFS): Promise<number> {
  await prisma.$executeRawUnsafe(`DELETE FROM pending_refs WHERE project_id = ?`, projectId);
  // Keep the newest `max` (file order is as good as any for a seed).
  return insertPendingRefs(prisma, projectId, refs.length > max ? refs.slice(refs.length - max) : refs);
}

async function trimPendingRefs(prisma: PrismaClient, projectId: number, max: number): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<Array<{ c: number | bigint }>>(
    `SELECT count(*) AS c FROM pending_refs WHERE project_id = ?`, projectId);
  const over = Number(rows[0]?.c ?? 0) - max;
  if (over <= 0) return;
  await prisma.$executeRawUnsafe(
    `DELETE FROM pending_refs WHERE id IN (SELECT id FROM pending_refs WHERE project_id = ? ORDER BY id ASC LIMIT ?)`,
    projectId, over,
  );
}

async function resolvePendingRefs(
  prisma: PrismaClient, projectId: number, builder: LadybugGraphBuilder, tails: string[],
  patched: Set<string>, fileOfId: Map<string, string>,
): Promise<{ edges: LadybugEdgeInput[] }> {
  const edges: LadybugEdgeInput[] = [];
  const resolvedIds: number[] = [];
  for (const part of chunks(tails.filter(Boolean), 400)) {
    const rows = await prisma.$queryRawUnsafe<Array<{
      id: number; source_file: string; source_id: string; target_name: string; edge_type: string;
      line: number; col: number; confidence: number; class_name: string;
    }>>(
      `SELECT id, source_file, source_id, target_name, edge_type, line, col, confidence, class_name
       FROM pending_refs WHERE project_id = ? AND target_tail IN (${part.map(() => '?').join(',')})`,
      projectId, ...part,
    );
    for (const r of rows) {
      if (patched.has(r.source_file)) continue; // tried against this parse already
      if (!fileOfId.has(r.source_id)) continue;  // source node gone; its file's next patch drops the row
      const target = builder.resolveName(r.target_name, r.class_name ? { className: r.class_name } : undefined);
      if (!target) continue;
      edges.push({
        sourceId: r.source_id, targetId: target, edgeType: r.edge_type,
        lineNumber: Number(r.line), colNumber: Number(r.col), confidence: Number(r.confidence),
        metadata: JSON.stringify({ targetName: r.target_name, via: 'pending_refs' }),
      });
      resolvedIds.push(Number(r.id));
    }
  }
  for (const part of chunks(resolvedIds, 400)) {
    await prisma.$executeRawUnsafe(`DELETE FROM pending_refs WHERE id IN (${part.map(() => '?').join(',')})`, ...part);
  }
  return { edges };
}
