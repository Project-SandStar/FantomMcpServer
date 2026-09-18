/**
 * File-scoped symbol queries: "what's in this file?" and "what's adjacent
 * to function X?", with optional point-in-time reconstruction via
 * IndexRun + ApiChange history.
 *
 * Backed by LadybugDB for current-state queries, Prisma ApiChange for
 * time-travel. ApiChange now records lineStart/lineEnd (added 2026-05-06)
 * so historical ordering is accurate within an IndexRun's resolution.
 */

import type { PrismaClient } from '@prisma/client';
import { ladybugQuery } from '../graph/ladybugConnection.js';

export interface FileSymbol {
  id: string;
  qualifiedName: string;
  name: string;
  nodeType: string; // 'class' | 'function' | 'method' | 'field' | ...
  lineStart: number | null;
  lineEnd: number | null;
  parentType: string | null;
  signature: string | null;
  /** True when this symbol was reconstructed from ApiChange history rather
   * than the live LadybugDB graph (e.g. it was deleted before atTime). */
  historicalOnly?: boolean;
  /** True when atTime is mid-edit and the symbol's location may have
   * shifted since — line numbers are best-effort. */
  locationApproximate?: boolean;
}

export interface ListFileSymbolsResult {
  symbols: FileSymbol[];
  total: number;
  filePath: string;
  projectId: number;
  atTime?: string;
  warnings: string[];
}

export interface NeighborsResult {
  anchor: FileSymbol;
  before: FileSymbol[];
  after: FileSymbol[];
  filePath: string;
  projectId: number;
  atTime?: string;
  warnings: string[];
}

const escFp = (fp: string) => fp.replace(/'/g, "\\'");

async function fetchCurrentFileSymbols(
  projectId: number,
  filePath: string,
): Promise<FileSymbol[]> {
  const { isLadybugDegraded } = await import('../graph/ladybugConnection.js');
  if (isLadybugDegraded()) return [];
  try {
    const rows = await ladybugQuery<{
      id: string; qn: string; name: string; nt: string;
      ls: number | null; le: number | null;
      pt: string | null; sig: string | null;
    }>(
      projectId,
      `MATCH (n:CodeNode {file_path: '${escFp(filePath)}'})
       RETURN n.id AS id, n.qualified_name AS qn, n.name AS name,
              n.node_type AS nt, n.line_start AS ls, n.line_end AS le,
              n.parent_type AS pt, n.signature AS sig`,
    );
    return rows.map((r) => ({
      id: r.id,
      qualifiedName: r.qn,
      name: r.name,
      nodeType: r.nt,
      lineStart: r.ls != null ? Number(r.ls) : null,
      lineEnd: r.le != null ? Number(r.le) : null,
      parentType: r.pt || null,
      signature: r.sig || null,
    }));
  } catch {
    return [];
  }
}

/**
 * Reconstruct the symbol list for a file at a given timestamp by replaying
 * ApiChange rows backward from current state. Returns the symbols (with
 * potentially stale lineStart) plus warnings about any approximations.
 */
async function reconstructAtTime(
  prisma: PrismaClient,
  projectId: number,
  filePath: string,
  atTime: Date,
): Promise<{ symbols: FileSymbol[]; warnings: string[] }> {
  const warnings: string[] = [];
  const current = await fetchCurrentFileSymbols(projectId, filePath);
  const map = new Map<string, FileSymbol>();
  for (const s of current) map.set(s.qualifiedName, s);

  const changes = await (prisma as any).apiChange.findMany({
    where: {
      projectId,
      filePath,
      occurredAt: { gt: atTime },
    },
    orderBy: { occurredAt: 'desc' },
  });

  for (const c of changes) {
    const qn = c.qualifiedName as string;
    if (c.changeType === 'added') {
      // Was added after T → didn't exist at T.
      map.delete(qn);
    } else if (c.changeType === 'removed') {
      // Was removed after T → existed at T with the captured signature.
      map.set(qn, {
        id: `historical:${qn}`,
        qualifiedName: qn,
        name: qn.split('.').pop() ?? qn,
        nodeType: c.kind ?? 'function',
        lineStart: c.lineStart != null ? Number(c.lineStart) : null,
        lineEnd: c.lineEnd != null ? Number(c.lineEnd) : null,
        parentType: null,
        signature: c.beforeSig ?? null,
        historicalOnly: true,
      });
    } else if (c.changeType === 'modified') {
      // Was modified after T → restore prior signature; line position may
      // have shifted, so flag.
      const existing = map.get(qn);
      if (existing) {
        existing.signature = c.beforeSig ?? existing.signature;
        if (c.lineStart != null) existing.lineStart = Number(c.lineStart);
        if (c.lineEnd != null) existing.lineEnd = Number(c.lineEnd);
        existing.locationApproximate = true;
      }
    }
  }

  // Some historical symbols may lack lineStart (changes recorded before
  // the line columns were added). Flag the gap so callers don't treat
  // them as authoritative.
  const missingLine = [...map.values()].filter((s) => s.lineStart == null);
  if (missingLine.length > 0) {
    warnings.push(
      `${missingLine.length} symbol(s) have no recorded line position at this snapshot — appended at end`,
    );
  }

  const symbols = [...map.values()].sort((a, b) => {
    const al = a.lineStart ?? Number.MAX_SAFE_INTEGER;
    const bl = b.lineStart ?? Number.MAX_SAFE_INTEGER;
    if (al !== bl) return al - bl;
    return a.qualifiedName.localeCompare(b.qualifiedName);
  });

  return { symbols, warnings };
}

export async function listFunctionsInFile(
  prisma: PrismaClient,
  args: {
    filePath: string;
    projectId?: number;
    atTime?: string | Date;
    limit?: number;
    offset?: number;
  },
): Promise<ListFileSymbolsResult> {
  const limit = Math.min(args.limit ?? 100, 1000);
  const offset = Math.max(args.offset ?? 0, 0);
  const warnings: string[] = [];

  // Resolve projectId by longest-prefix match on the file path if not given.
  let projectId = args.projectId;
  if (!projectId) {
    const projects = await prisma.fantomProject.findMany({
      select: { id: true, path: true },
    });
    const sorted = projects.sort((a, b) => b.path.length - a.path.length);
    const match = sorted.find((p) =>
      args.filePath === p.path ||
      args.filePath.startsWith(p.path.replace(/\/?$/, '/')),
    );
    if (!match) {
      throw new Error(`No registered project matches filePath: ${args.filePath}`);
    }
    projectId = match.id;
  }

  let symbols: FileSymbol[];
  let atTimeIso: string | undefined;
  if (args.atTime) {
    const t = typeof args.atTime === 'string' ? new Date(args.atTime) : args.atTime;
    if (isNaN(t.getTime())) throw new Error(`Invalid atTime: ${args.atTime}`);
    atTimeIso = t.toISOString();
    const r = await reconstructAtTime(prisma, projectId, args.filePath, t);
    symbols = r.symbols;
    warnings.push(...r.warnings);
  } else {
    let live = await fetchCurrentFileSymbols(projectId, args.filePath);
    // Fallback: if LadybugDB has no rows for this (project, file) — typical
    // for projects that were only indexed via the legacy regex parser, or
    // where graph build hit cross-project hash collisions — pull from the
    // in-memory FantomCodeIndexer instead.
    if (live.length === 0) {
      try {
        const { getFantomCodeIndexer } = await import('./indexer.js');
        const indexer = getFantomCodeIndexer();
        const fns = indexer.getAllFunctions().filter(
          (f) => Number((f as any).projectId) === Number(projectId) && f.filePath === args.filePath,
        );
        const types = indexer.getAllTypes().filter(
          (t) => Number((t as any).projectId) === Number(projectId) && t.filePath === args.filePath,
        );
        if (fns.length + types.length > 0) {
          warnings.push('LadybugDB graph empty for this file; reading from in-memory index instead. Run a full reindex to populate the graph.');
          live = [
            ...types.map((t) => ({
              id: t.id,
              qualifiedName: t.qualifiedName,
              name: t.name,
              nodeType: (t.kind as string) ?? 'class',
              lineStart: t.lineNumber ?? null,
              lineEnd: null,
              parentType: null,
              signature: null,
            })),
            ...fns.map((f) => ({
              id: f.id,
              qualifiedName: f.qualifiedName,
              name: f.name,
              nodeType: (f.type as string) ?? 'method',
              lineStart: f.lineNumber ?? null,
              lineEnd: null,
              parentType: f.className ?? null,
              signature: f.signature ?? null,
            })),
          ];
        }
      } catch {
        // best-effort fallback
      }
    }
    symbols = live.sort((a, b) => {
      const al = a.lineStart ?? Number.MAX_SAFE_INTEGER;
      const bl = b.lineStart ?? Number.MAX_SAFE_INTEGER;
      if (al !== bl) return al - bl;
      return a.qualifiedName.localeCompare(b.qualifiedName);
    });
  }

  const total = symbols.length;
  const sliced = symbols.slice(offset, offset + limit);

  return {
    symbols: sliced,
    total,
    filePath: args.filePath,
    projectId,
    atTime: atTimeIso,
    warnings,
  };
}

export async function getCodeNeighbors(
  prisma: PrismaClient,
  args: {
    qualifiedName: string;
    projectId?: number;
    atTime?: string | Date;
    count?: number;
  },
): Promise<NeighborsResult> {
  const count = Math.max(1, Math.min(args.count ?? 2, 20));
  const warnings: string[] = [];

  // Find the anchor symbol. Three lookup shapes are tried in order so callers
  // who pass any of "MockRedis.ping" / "<filePath>::MockRedis.ping" /
  // "<podName>::MockRedis.ping" all resolve to the same node.
  const projectScope = args.projectId ? `project_id: ${args.projectId}, ` : '';
  const escQn = escFp(args.qualifiedName);
  const select =
    `RETURN n.project_id AS pid, n.file_path AS fp, n.line_start AS ls,
            n.node_type AS nt, n.name AS name, n.signature AS sig,
            n.parent_type AS pt, n.id AS id LIMIT 5`;
  const mapRow = (r: any) => ({ ...r, ls: r.ls != null ? Number(r.ls) : null, pid: Number(r.pid) });

  // Helper: route to per-project DB when args.projectId is given, else legacy.
  // Cross-project lookups (no projectId) stay on the shared DB until callers
  // are audited — same backward-compat strategy as the rest of C2-C4.
  const lq = async (cypher: string) =>
    args.projectId !== undefined
      ? ladybugQuery<any>(args.projectId, cypher)
      : ladybugQuery<any>(cypher);

  // Pass 1: exact match
  let anchorRows: Array<{ pid: number; fp: string; ls: number | null; nt: string; name: string; sig: string | null; pt: string | null; id: string }> =
    (await lq(
      `MATCH (n:CodeNode {${projectScope}qualified_name: '${escQn}'}) ${select}`,
    )).map(mapRow);

  // Pass 2: bare "Class.method" against any stored "*::Class.method"
  if (anchorRows.length === 0 && !args.qualifiedName.includes('::')) {
    anchorRows = (await lq(
      `MATCH (n:CodeNode {${projectScope.replace(/, $/, '')}})
       WHERE ENDS_WITH(n.qualified_name, '::${escQn}') ${select.replace('LIMIT 5', 'LIMIT 5')}`,
    )).map(mapRow).filter(() => true);
  }

  // Pass 3: pod-prefixed "X::Class.method" — strip the "<X>::" and try the suffix.
  if (anchorRows.length === 0 && args.qualifiedName.includes('::')) {
    const suffix = args.qualifiedName.split('::').slice(1).join('::');
    if (suffix) {
      const escSuffix = escFp(suffix);
      anchorRows = (await lq(
        `MATCH (n:CodeNode {${projectScope.replace(/, $/, '')}})
         WHERE n.qualified_name = '${escSuffix}' OR ENDS_WITH(n.qualified_name, '::${escSuffix}') ${select.replace('LIMIT 5', 'LIMIT 5')}`,
      )).map(mapRow);
    }
  }

  if (anchorRows.length === 0) {
    throw new Error(`Symbol not found: ${args.qualifiedName}`);
  }
  if (anchorRows.length > 1) {
    const projects = anchorRows.map((r) => r.pid);
    throw new Error(
      `Symbol ${args.qualifiedName} matches ${anchorRows.length} projects (${projects.join(',')}). Pass projectId to disambiguate.`,
    );
  }
  const a = anchorRows[0];
  const projectId = a.pid;

  // Pull the whole file's symbols (live or reconstructed).
  let symbols: FileSymbol[];
  let atTimeIso: string | undefined;
  if (args.atTime) {
    const t = typeof args.atTime === 'string' ? new Date(args.atTime) : args.atTime;
    atTimeIso = t.toISOString();
    const r = await reconstructAtTime(prisma, projectId, a.fp, t);
    symbols = r.symbols;
    warnings.push(...r.warnings);
  } else {
    symbols = await fetchCurrentFileSymbols(projectId, a.fp);
    symbols.sort((x, y) => {
      const xl = x.lineStart ?? Number.MAX_SAFE_INTEGER;
      const yl = y.lineStart ?? Number.MAX_SAFE_INTEGER;
      if (xl !== yl) return xl - yl;
      return x.qualifiedName.localeCompare(y.qualifiedName);
    });
  }

  const idx = symbols.findIndex((s) => s.qualifiedName === args.qualifiedName);
  if (idx === -1) {
    // Anchor was deleted before atTime — surface a clear warning and use
    // the live anchor info as the response shape.
    warnings.push('anchor symbol absent at atTime; returning empty neighbor windows');
    return {
      anchor: {
        id: a.id,
        qualifiedName: args.qualifiedName,
        name: a.name,
        nodeType: a.nt,
        lineStart: a.ls,
        lineEnd: null,
        parentType: a.pt || null,
        signature: a.sig || null,
        historicalOnly: true,
      },
      before: [],
      after: [],
      filePath: a.fp,
      projectId,
      atTime: atTimeIso,
      warnings,
    };
  }

  const before = symbols.slice(Math.max(0, idx - count), idx);
  const after = symbols.slice(idx + 1, idx + 1 + count);

  return {
    anchor: symbols[idx],
    before,
    after,
    filePath: a.fp,
    projectId,
    atTime: atTimeIso,
    warnings,
  };
}
