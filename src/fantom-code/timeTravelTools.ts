/**
 * MCP-tool helpers backing whatChangedRecently / getSymbolHistory / diffByTime.
 * Pure functions over Prisma — registered as MCP cases in src/index.ts.
 */

import type { PrismaClient } from '@prisma/client';
import { computeProjectDiff, parseTimeArg } from './timeTravelDiff.js';

// ============================================
// getActivitySummary
// ============================================

export interface ActivitySummary {
  projectId: number;
  window: { from: string; to: string; granularity: 'hour' | 'day' | 'week' };
  totalRuns: number;
  totalChanges: number;
  byChangeType: { added: number; modified: number; removed: number };
  byKind: Record<string, number>;
  hottestFiles: Array<{ filePath: string; changes: number }>;
  hottestSymbols: Array<{ qualifiedName: string; changes: number }>;
  histogram: Array<{ bucket: string; added: number; modified: number; removed: number }>;
}

export async function getActivitySummary(
  prisma: PrismaClient,
  args: {
    projectId: number;
    since?: string;
    until?: string;
    granularity?: 'hour' | 'day' | 'week';
  },
): Promise<ActivitySummary> {
  const granularity = args.granularity ?? 'day';
  const to = args.until ? parseTimeArg(args.until, new Date()) : new Date();
  const defaultSpan = granularity === 'hour' ? 86_400_000 : granularity === 'day' ? 7 * 86_400_000 : 90 * 86_400_000;
  const from = args.since ? parseTimeArg(args.since, new Date(to.getTime() - defaultSpan)) : new Date(to.getTime() - defaultSpan);

  const totalRuns = await (prisma as any).indexRun.count({
    where: { projectId: args.projectId, startedAt: { gte: from, lte: to } },
  });

  const where = { projectId: args.projectId, occurredAt: { gte: from, lte: to } };
  const byChangeTypeRows: Array<{ changeType: string; _count: number }> = await (prisma as any).apiChange.groupBy({
    by: ['changeType'],
    where,
    _count: true,
  });
  const byChangeType = { added: 0, modified: 0, removed: 0 };
  for (const r of byChangeTypeRows) {
    if (r.changeType === 'added' || r.changeType === 'modified' || r.changeType === 'removed') {
      byChangeType[r.changeType] = (r._count as any).changeType ?? r._count ?? 0;
    }
  }

  const byKindRows: Array<{ kind: string; _count: number }> = await (prisma as any).apiChange.groupBy({
    by: ['kind'],
    where,
    _count: true,
  });
  const byKind: Record<string, number> = {};
  for (const r of byKindRows) byKind[r.kind] = (r._count as any).kind ?? r._count ?? 0;

  const fileRows: Array<{ filePath: string; _count: number }> = await (prisma as any).apiChange.groupBy({
    by: ['filePath'],
    where,
    _count: true,
    orderBy: { _count: { filePath: 'desc' } },
    take: 10,
  });
  const hottestFiles = fileRows.map((r: any) => ({
    filePath: r.filePath,
    changes: r._count.filePath ?? r._count ?? 0,
  }));

  const symRows: Array<{ qualifiedName: string; _count: number }> = await (prisma as any).apiChange.groupBy({
    by: ['qualifiedName'],
    where,
    _count: true,
    orderBy: { _count: { qualifiedName: 'desc' } },
    take: 10,
  });
  const hottestSymbols = symRows.map((r: any) => ({
    qualifiedName: r.qualifiedName,
    changes: r._count.qualifiedName ?? r._count ?? 0,
  }));

  // Histogram bucketing — pure JS, no raw SQL
  const buckets = new Map<string, { added: number; modified: number; removed: number }>();
  const all: Array<{ occurredAt: Date; changeType: string }> = await (prisma as any).apiChange.findMany({
    where,
    select: { occurredAt: true, changeType: true },
    take: 50_000,
  });
  const bucketKey = (d: Date) => {
    if (granularity === 'hour') return d.toISOString().slice(0, 13) + ':00:00Z';
    if (granularity === 'week') {
      const monday = new Date(d);
      monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return monday.toISOString().slice(0, 10);
    }
    return d.toISOString().slice(0, 10);
  };
  for (const r of all) {
    const key = bucketKey(r.occurredAt);
    const b = buckets.get(key) ?? { added: 0, modified: 0, removed: 0 };
    if (r.changeType === 'added') b.added++;
    else if (r.changeType === 'modified') b.modified++;
    else if (r.changeType === 'removed') b.removed++;
    buckets.set(key, b);
  }
  const histogram = [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bucket, v]) => ({ bucket, ...v }));

  return {
    projectId: args.projectId,
    window: { from: from.toISOString(), to: to.toISOString(), granularity },
    totalRuns,
    totalChanges: byChangeType.added + byChangeType.modified + byChangeType.removed,
    byChangeType,
    byKind,
    hottestFiles,
    hottestSymbols,
    histogram,
  };
}

// ============================================
// compareSnapshots — paginated, qualifiedNames-only
// ============================================

export interface CompareSnapshotsOutput {
  added: string[];
  modified: string[];
  removed: string[];
  counts: { added: number; modified: number; removed: number };
  hasMore: boolean;
  nextCursor: string | null;
}

export async function compareSnapshots(
  prisma: PrismaClient,
  args: {
    projectId: number;
    from: string;
    to: string;
    cursor?: string;
    pageSize?: number;
    section?: 'added' | 'modified' | 'removed' | 'all';
  },
): Promise<CompareSnapshotsOutput> {
  const pageSize = Math.min(args.pageSize ?? 200, 500);
  const fromDate = parseTimeArg(args.from, new Date(0));
  const toDate = parseTimeArg(args.to, new Date());

  const where: Record<string, unknown> = {
    projectId: args.projectId,
    occurredAt: { gte: fromDate, lte: toDate },
  };
  if (args.section && args.section !== 'all') where.changeType = args.section;
  if (args.cursor) {
    const id = parseInt(args.cursor, 10);
    if (!isNaN(id)) where.id = { gt: id };
  }

  const rows: Array<{ id: number; qualifiedName: string; changeType: string }> = await (prisma as any).apiChange.findMany({
    where,
    orderBy: { id: 'asc' },
    select: { id: true, qualifiedName: true, changeType: true },
    take: pageSize + 1,
  });
  const hasMore = rows.length > pageSize;
  const used = hasMore ? rows.slice(0, pageSize) : rows;
  const nextCursor = hasMore ? String(used[used.length - 1].id) : null;

  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  for (const r of used) {
    if (r.changeType === 'added') added.push(r.qualifiedName);
    else if (r.changeType === 'modified') modified.push(r.qualifiedName);
    else if (r.changeType === 'removed') removed.push(r.qualifiedName);
  }

  return {
    added,
    modified,
    removed,
    counts: { added: added.length, modified: modified.length, removed: removed.length },
    hasMore,
    nextCursor,
  };
}

// ============================================
// explainSymbolChange — heuristic on a single change event
// ============================================

export interface ExplainSymbolChange {
  event: {
    id: number;
    runId: number;
    qualifiedName: string;
    changeType: string;
    beforeSig: string | null;
    afterSig: string | null;
    filePath: string;
    occurredAt: string;
  };
  siblingChanges: Array<{
    id: number;
    qualifiedName: string;
    changeType: string;
    beforeSig: string | null;
    afterSig: string | null;
  }>;
  heuristic: {
    label:
      | 'signature-unchanged-body-change'
      | 'param-added'
      | 'param-removed'
      | 'return-type-changed'
      | 'renamed-or-moved'
      | 'added'
      | 'removed'
      | 'unknown';
    detail: string;
  };
}

function countParams(sig: string | null | undefined): number {
  if (!sig) return -1;
  const m = sig.match(/\(([^)]*)\)/);
  if (!m) return -1;
  const inner = m[1].trim();
  if (!inner) return 0;
  return inner.split(',').length;
}

export async function explainSymbolChange(
  prisma: PrismaClient,
  args: { qualifiedName: string; runId: number },
): Promise<ExplainSymbolChange | { error: string; nearestRuns?: number[] }> {
  const event: any = await (prisma as any).apiChange.findFirst({
    where: { qualifiedName: args.qualifiedName, runId: args.runId },
  });
  if (!event) {
    const nearby = await (prisma as any).apiChange.findMany({
      where: { qualifiedName: args.qualifiedName },
      orderBy: { runId: 'desc' },
      select: { runId: true },
      take: 5,
    });
    return {
      error: `No change event for ${args.qualifiedName} in run ${args.runId}`,
      nearestRuns: nearby.map((r: any) => r.runId),
    };
  }

  const siblings: any[] = await (prisma as any).apiChange.findMany({
    where: { runId: args.runId, filePath: event.filePath, NOT: { id: event.id } },
    take: 50,
  });

  let label: ExplainSymbolChange['heuristic']['label'] = 'unknown';
  let detail = '';
  if (event.changeType === 'added') {
    label = 'added';
    detail = 'Symbol first appears in this run.';
  } else if (event.changeType === 'removed') {
    label = 'removed';
    detail = 'Symbol disappears in this run.';
  } else if (event.changeType === 'modified') {
    const beforeParams = countParams(event.beforeSig);
    const afterParams = countParams(event.afterSig);
    if (beforeParams >= 0 && afterParams > beforeParams) {
      label = 'param-added';
      detail = `Parameter count grew ${beforeParams} → ${afterParams}.`;
    } else if (beforeParams >= 0 && afterParams >= 0 && afterParams < beforeParams) {
      label = 'param-removed';
      detail = `Parameter count shrunk ${beforeParams} → ${afterParams}.`;
    } else if (event.beforeSig && event.afterSig && event.beforeSig === event.afterSig) {
      label = 'signature-unchanged-body-change';
      detail = 'Signature matches; body or implementation likely changed.';
    } else {
      const beforeRet = (event.beforeSig || '').match(/[):\->]+\s*(\S+)\s*$/)?.[1];
      const afterRet = (event.afterSig || '').match(/[):\->]+\s*(\S+)\s*$/)?.[1];
      if (beforeRet && afterRet && beforeRet !== afterRet) {
        label = 'return-type-changed';
        detail = `Return type changed: ${beforeRet} → ${afterRet}.`;
      } else {
        label = 'renamed-or-moved';
        detail = 'Signature changed but couldn’t identify the kind of change automatically.';
      }
    }
  }

  return {
    event: {
      id: event.id,
      runId: event.runId,
      qualifiedName: event.qualifiedName,
      changeType: event.changeType,
      beforeSig: event.beforeSig ?? null,
      afterSig: event.afterSig ?? null,
      filePath: event.filePath,
      occurredAt: event.occurredAt.toISOString(),
    },
    siblingChanges: siblings.map((s: any) => ({
      id: s.id,
      qualifiedName: s.qualifiedName,
      changeType: s.changeType,
      beforeSig: s.beforeSig ?? null,
      afterSig: s.afterSig ?? null,
    })),
    heuristic: { label, detail },
  };
}


export interface RecentChangesOutput {
  projectId: number;
  window: { from: string; to: string; hoursAgo: number };
  byFile: Array<{
    path: string;
    changes: Array<{
      qualifiedName: string;
      kind: string;
      changeType: 'added' | 'modified' | 'removed';
      occurredAt: string;
      lineStart: number | null;
    }>;
  }>;
  totalChanges: number;
  truncated: boolean;
}

const MAX_FILES = 30;
const MAX_CHANGES_PER_FILE = 10;

export async function whatChangedRecently(
  prisma: PrismaClient,
  args: {
    projectId: number;
    hoursAgo?: number;
    kind?: 'added' | 'modified' | 'removed';
  },
): Promise<RecentChangesOutput> {
  const hoursAgo = args.hoursAgo ?? 24;
  const to = new Date();
  const from = new Date(to.getTime() - hoursAgo * 3_600_000);

  const where: Record<string, unknown> = {
    projectId: args.projectId,
    occurredAt: { gte: from, lte: to },
  };
  if (args.kind) where.changeType = args.kind;

  const rows = await (prisma as any).apiChange.findMany({
    where,
    orderBy: { occurredAt: 'desc' },
    take: 5000,
  });

  const byFileMap = new Map<string, RecentChangesOutput['byFile'][number]>();
  for (const r of rows) {
    let bucket = byFileMap.get(r.filePath);
    if (!bucket) {
      bucket = { path: r.filePath, changes: [] as RecentChangesOutput['byFile'][number]['changes'] };
      byFileMap.set(r.filePath, bucket);
    }
    if (bucket.changes.length < MAX_CHANGES_PER_FILE) {
      bucket.changes.push({
        qualifiedName: r.qualifiedName,
        kind: r.kind,
        changeType: r.changeType,
        occurredAt: r.occurredAt.toISOString(),
        lineStart: r.lineStart != null ? Number(r.lineStart) : null,
      });
    }
  }

  const sorted = [...byFileMap.values()].sort((a, b) => b.changes.length - a.changes.length);
  const byFile = sorted.slice(0, MAX_FILES);
  const truncated = sorted.length > MAX_FILES || rows.length === 5000;

  return {
    projectId: args.projectId,
    window: { from: from.toISOString(), to: to.toISOString(), hoursAgo },
    byFile,
    totalChanges: rows.length,
    truncated,
  };
}

export interface SymbolHistoryOutput {
  qualifiedName: string;
  events: Array<{
    occurredAt: string;
    runId: number;
    changeType: 'added' | 'modified' | 'removed';
    beforeSig: string | null;
    afterSig: string | null;
    filePath: string;
    lineStart: number | null;
    lineEnd: number | null;
  }>;
  summary: {
    firstSeen: string | null;
    lastModified: string | null;
    modifyCount: number;
    isCurrentlyRemoved: boolean;
    signatureChurn: number;
  } | null;
  truncated: boolean;
}

export async function getSymbolHistory(
  prisma: PrismaClient,
  args: {
    qualifiedName: string;
    projectId?: number;
    since?: string;
    until?: string;
  },
): Promise<SymbolHistoryOutput> {
  const where: Record<string, unknown> = { qualifiedName: args.qualifiedName };
  if (args.projectId) where.projectId = args.projectId;
  if (args.since || args.until) {
    const range: Record<string, Date> = {};
    if (args.since) range.gte = parseTimeArg(args.since, new Date(0));
    if (args.until) range.lte = parseTimeArg(args.until, new Date());
    where.occurredAt = range;
  }

  const rows = await (prisma as any).apiChange.findMany({
    where,
    orderBy: { occurredAt: 'asc' },
    take: 201,
  });
  const truncated = rows.length > 200;
  const events = (truncated ? rows.slice(0, 200) : rows).map((r: any) => ({
    occurredAt: r.occurredAt.toISOString(),
    runId: r.runId,
    changeType: r.changeType,
    beforeSig: r.beforeSig ?? null,
    afterSig: r.afterSig ?? null,
    filePath: r.filePath,
    lineStart: r.lineStart != null ? Number(r.lineStart) : null,
    lineEnd: r.lineEnd != null ? Number(r.lineEnd) : null,
  }));

  let summary: SymbolHistoryOutput['summary'] = null;
  if (events.length > 0) {
    const firstSeen = events.find((e: any) => e.changeType === 'added')?.occurredAt
      ?? events[0].occurredAt;
    const modifyEvents = events.filter((e: any) => e.changeType === 'modified');
    const lastModified = modifyEvents.length
      ? modifyEvents[modifyEvents.length - 1].occurredAt
      : null;
    const isCurrentlyRemoved = events[events.length - 1].changeType === 'removed';
    let signatureChurn = 0;
    let prev: string | null = null;
    for (const e of events) {
      const sig = e.afterSig ?? e.beforeSig ?? null;
      if (prev !== null && sig !== null && prev !== sig) signatureChurn++;
      prev = sig;
    }
    summary = {
      firstSeen,
      lastModified,
      modifyCount: modifyEvents.length,
      isCurrentlyRemoved,
      signatureChurn,
    };
  }

  return { qualifiedName: args.qualifiedName, events, summary, truncated };
}

export async function diffByTime(
  prisma: PrismaClient,
  args: { projectId: number; from: string; to: string; scope?: string },
): Promise<{
  window: { from: string; to: string; runsIncluded: number };
  counts: { added: number; modified: number; removed: number };
  byKind: Record<string, number>;
  samples: {
    added: Array<{ qualifiedName: string; filePath: string; lineStart: number | null }>;
    modified: Array<{ qualifiedName: string; filePath: string; beforeSig: string | null; afterSig: string | null }>;
    removed: Array<{ qualifiedName: string; filePath: string }>;
  };
  truncated: boolean;
}> {
  const diff = await computeProjectDiff(prisma, args.projectId, args.from, args.to, {
    scope: args.scope,
  });

  // Pull all change rows back out for byKind aggregation. (computeProjectDiff
  // already filters & paginates; rebuild byKind here from the per-file data.)
  const byKind: Record<string, number> = {};
  for (const f of diff.files) {
    for (const list of [f.added, f.modified, f.removed]) {
      for (const e of list) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    }
  }

  // Count IndexRuns intersecting the window.
  const fromDate = new Date(diff.from);
  const toDate = new Date(diff.to);
  const runsIncluded = await (prisma as any).indexRun.count({
    where: { projectId: args.projectId, startedAt: { gte: fromDate, lte: toDate } },
  });

  const flatAdded = diff.files.flatMap((f) =>
    f.added.map((e) => ({ qualifiedName: e.qualifiedName, filePath: f.path, lineStart: e.lineStart })),
  );
  const flatMod = diff.files.flatMap((f) =>
    f.modified.map((e) => ({
      qualifiedName: e.qualifiedName,
      filePath: f.path,
      beforeSig: e.beforeSig ?? null,
      afterSig: e.afterSig ?? null,
    })),
  );
  const flatRem = diff.files.flatMap((f) =>
    f.removed.map((e) => ({ qualifiedName: e.qualifiedName, filePath: f.path })),
  );

  return {
    window: { from: diff.from, to: diff.to, runsIncluded },
    counts: diff.totals,
    byKind,
    samples: {
      added: flatAdded.slice(0, 10),
      modified: flatMod.slice(0, 10),
      removed: flatRem.slice(0, 10),
    },
    truncated: diff.truncated,
  };
}
