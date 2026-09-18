/**
 * Time-windowed ApiChange diff.
 *
 * Shared between the admin endpoint (/admin/code-projects/:id/diff) and the
 * MCP tools (whatChangedRecently, diffByTime, etc.) so all callers see the
 * same shape and the same truncation rules.
 */

import type { PrismaClient } from '@prisma/client';

export interface DiffEntry {
  qualifiedName: string;
  name: string;
  kind: string;
  lineStart: number | null;
  lineEnd: number | null;
  beforeSig?: string | null;
  afterSig?: string | null;
}

export interface FileDiff {
  path: string;
  added: DiffEntry[];
  modified: DiffEntry[];
  removed: DiffEntry[];
}

export interface RunAnchor {
  id: number;
  occurredAt: string;
  trigger: string | null;
}

export interface EdgeDelta {
  sourceQn: string;
  targetQn: string;
  edgeType: string;
  changeType: 'added' | 'removed';
  occurredAt: string;
}

export interface ProjectDiff {
  projectId: number;
  from: string;
  to: string;
  fromRun: RunAnchor | null;
  toRun: RunAnchor | 'current' | null;
  totals: { added: number; modified: number; removed: number };
  files: FileDiff[];
  edges: { added: EdgeDelta[]; removed: EdgeDelta[]; truncated: boolean };
  truncated: boolean;
}

const MAX_CHANGES = 5000;

/** Resolve to ISO; accept '-7d' / '-24h' shorthand and 'now' / undefined. */
export function parseTimeArg(input: string | undefined, fallback: Date): Date {
  if (!input || input === 'now' || input === 'current') return fallback;
  const m = input.match(/^-(\d+)([dhms])$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd']!;
    return new Date(Date.now() - n * unitMs);
  }
  const d = new Date(input);
  if (isNaN(d.getTime())) throw new Error(`Invalid timestamp: ${input}`);
  return d;
}

function suffixName(qn: string): string {
  // Recover bare name from "ns::Class.method" or "ns::Class".
  const afterNs = qn.includes('::') ? qn.split('::').slice(1).join('::') : qn;
  return afterNs.includes('.') ? afterNs.split('.').pop()! : afterNs;
}

export interface ProjectDiffOptions {
  /** "file:<path>" | "symbol:<qn>" | "class:<qn-prefix>" — restrict the change set. */
  scope?: string;
  /** Override the cap (default 5000). */
  maxChanges?: number;
}

export async function computeProjectDiff(
  prisma: PrismaClient,
  projectId: number,
  fromIso: string | undefined,
  toIso: string | undefined,
  opts: ProjectDiffOptions = {},
): Promise<ProjectDiff> {
  const now = new Date();
  const from = parseTimeArg(fromIso, new Date(0));
  const to = parseTimeArg(toIso, now);
  const cap = opts.maxChanges ?? MAX_CHANGES;

  // Build scope filter.
  const scopeWhere: Record<string, unknown> = {};
  if (opts.scope) {
    const m = opts.scope.match(/^(file|symbol|class):(.+)$/);
    if (!m) throw new Error(`Invalid scope: ${opts.scope}. Use file:<path>, symbol:<qn>, class:<qn-prefix>.`);
    const [, kind, val] = m;
    if (kind === 'file') scopeWhere.filePath = { startsWith: val };
    else if (kind === 'symbol') scopeWhere.qualifiedName = val;
    else if (kind === 'class') scopeWhere.qualifiedName = { startsWith: `${val}.` };
  }

  // Pull window of changes.
  const rows = await (prisma as any).apiChange.findMany({
    where: { projectId, occurredAt: { gte: from, lte: to }, ...scopeWhere },
    orderBy: { occurredAt: 'asc' },
    take: cap + 1,
  });
  const truncated = rows.length > cap;
  const used = truncated ? rows.slice(0, cap) : rows;

  // Group by file + kind.
  const byFile = new Map<string, FileDiff>();
  let added = 0;
  let modified = 0;
  let removed = 0;
  for (const r of used) {
    const path = r.filePath as string;
    const bucket = byFile.get(path) ?? { path, added: [], modified: [], removed: [] };
    if (!byFile.has(path)) byFile.set(path, bucket);
    const entry: DiffEntry = {
      qualifiedName: r.qualifiedName,
      name: suffixName(r.qualifiedName),
      kind: r.kind,
      lineStart: r.lineStart != null ? Number(r.lineStart) : null,
      lineEnd: r.lineEnd != null ? Number(r.lineEnd) : null,
      beforeSig: r.beforeSig ?? null,
      afterSig: r.afterSig ?? null,
    };
    if (r.changeType === 'added') {
      bucket.added.push(entry);
      added++;
    } else if (r.changeType === 'modified') {
      bucket.modified.push(entry);
      modified++;
    } else if (r.changeType === 'removed') {
      bucket.removed.push(entry);
      removed++;
    }
  }

  // Pick the IndexRun anchors (latest run with startedAt ≤ from / ≤ to).
  const fromRunRow = await (prisma as any).indexRun.findFirst({
    where: { projectId, startedAt: { lte: from } },
    orderBy: { startedAt: 'desc' },
    select: { id: true, startedAt: true, trigger: true },
  });
  const toIsCurrent = !toIso || toIso === 'now' || toIso === 'current' || to >= now;
  const toRunRow = toIsCurrent
    ? null
    : await (prisma as any).indexRun.findFirst({
        where: { projectId, startedAt: { lte: to } },
        orderBy: { startedAt: 'desc' },
        select: { id: true, startedAt: true, trigger: true },
      });

  const anchor = (row: { id: number; startedAt: Date; trigger: string | null } | null): RunAnchor | null =>
    row
      ? {
          id: row.id,
          occurredAt: row.startedAt.toISOString(),
          trigger: row.trigger,
        }
      : null;

  // Pull edge changes too — same window, same scope-by-projectId.
  const MAX_EDGE_DELTAS = 2000;
  const edgeRows = await (prisma as any).edgeChange.findMany({
    where: { projectId, occurredAt: { gte: from, lte: to } },
    orderBy: { occurredAt: 'asc' },
    take: MAX_EDGE_DELTAS + 1,
  });
  const edgeTruncated = edgeRows.length > MAX_EDGE_DELTAS;
  const edgeUsed = edgeTruncated ? edgeRows.slice(0, MAX_EDGE_DELTAS) : edgeRows;
  const addedEdges: EdgeDelta[] = [];
  const removedEdges: EdgeDelta[] = [];
  for (const e of edgeUsed) {
    const delta: EdgeDelta = {
      sourceQn: e.sourceQn,
      targetQn: e.targetQn,
      edgeType: e.edgeType,
      changeType: e.changeType,
      occurredAt: e.occurredAt.toISOString(),
    };
    if (e.changeType === 'added') addedEdges.push(delta);
    else if (e.changeType === 'removed') removedEdges.push(delta);
  }

  return {
    projectId,
    from: from.toISOString(),
    to: to.toISOString(),
    fromRun: anchor(fromRunRow),
    toRun: toIsCurrent ? 'current' : anchor(toRunRow),
    totals: { added, modified, removed },
    files: [...byFile.values()].sort(
      (a, b) =>
        b.added.length + b.modified.length + b.removed.length -
        (a.added.length + a.modified.length + a.removed.length),
    ),
    edges: { added: addedEdges, removed: removedEdges, truncated: edgeTruncated },
    truncated,
  };
}
