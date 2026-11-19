/**
 * Session context for AI clients (claudePlugin/ SessionStart hook).
 *
 *   GET /admin/indexing/context?cwd=<abs path>   X-Fantom-Hook-Token only
 *
 * Answers: which registered project the client's working directory belongs
 * to (longest-prefix rule, same as reportChanges), how fresh its index is,
 * and the list of registered project roots so the hook can still say
 * "this is project X" from its cache when the server is down.
 *
 * Pure apart from the Prisma reads; the route is in indexingRoutes.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { PrismaClient } from '@prisma/client';
import { projectForPath } from '../indexing/focusSet.js';
import { isLazyEnabledFor, type LazyIndexingConfig } from '../indexing/lazyConfig.js';
import { versionGroupForProject } from '../projects/versionGroup.js';
import { getInstallRoot } from '../utils/installRoot.js';
import { mapPath } from '../utils/pathMapping.js';
import { mirrorRoot } from '../indexing/mirror.js';

export interface SessionContextRun {
  id: number;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  filesParsed: number;
  changeSource: string | null;
  error: string | null;
}

export interface SessionContextProject {
  id: number;
  name: string;
  path: string;
  language: string;
  parserType: string;
  /** `key` is the selector form (`haxall/4.0.6`), `label` the display form. */
  versionGroup: { key: string; label: string };
  lazy: boolean;
  autoIndex: boolean;
  indexMode: string;
  functionCount: number;
  typeCount: number;
  /**
   * Symbols and files from indexed_files (sum of per-file symbol counts).
   * functionCount/typeCount can lag or be overwritten by a partial run; this
   * total is the one the hook shows when it is larger. 0 when unknown.
   */
  symbolCount: number;
  fileCount: number;
  lastIndexed: string | null;
  lastRun: SessionContextRun | null;
  /** Files of this project in the focus set (recently read/edited by AIs). */
  focusFiles: number;
  /** The client's folder for this project (differs from `path` on a remote server). */
  clientRoot?: string;
}

export interface SessionContextProjectRef {
  id: number;
  name: string;
  path: string;
  language: string;
}

export interface SessionContext {
  ok: true;
  version: string;
  now: string;
  cwd: string;
  project: SessionContextProject | null;
  projects: SessionContextProjectRef[];
}

let versionCache: string | null = null;

/** Server version from package.json (cached). */
export function serverVersion(): string {
  if (versionCache) return versionCache;
  let v = 'unknown';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(getInstallRoot(), 'package.json'), 'utf8'));
    if (typeof pkg.version === 'string') v = pkg.version;
  } catch {
    /* no package.json: keep 'unknown' */
  }
  versionCache = v;
  return v;
}

export interface SessionContextArgs {
  prisma: PrismaClient;
  cwd: string;
  lazyConfig: LazyIndexingConfig;
  /** Focus-set file count for a project; default 0 (tests, boot). */
  focusCount?: (projectId: number) => Promise<number>;
  version?: string;
}

/**
 * Project for a CLIENT working directory. The client (a Mac running Claude
 * Code) sends its own path, but a remote server stores the sidecar mirror
 * path: /Users/dev/Code/mcpfantom is /mirror/mac-dev/mcpfantom here.
 * Order: exact prefix, then pathMappings (mapPath), then the mirror layout
 * {mirror}/{sidecar}/{rootName}/{sub...} matched against the cwd segments.
 * The mirror step only answers when one project wins (no tie across
 * sidecars). `clientRoot` is the client-side folder of the project, so the
 * hook can tell the agent which local folder the server paths mean.
 */
export function projectForClientPath<P extends { id: number; path: string }>(
  rows: P[], cwd: string, mirror: string = mirrorRoot(),
): { project: P; clientRoot: string } | null {
  const direct = projectForPath(rows, cwd);
  if (direct) return { project: direct, clientRoot: path.resolve(direct.path) };

  const mapped = mapPath(cwd);
  if (mapped && mapped !== cwd) {
    const viaMap = projectForPath(rows, mapped);
    if (viaMap) return { project: viaMap, clientRoot: cwd.slice(0, cwd.length - (mapped.length - path.resolve(viaMap.path).length)) || cwd };
  }

  const segs = cwd.split(/[\\/]+/).filter(Boolean);
  const mirrorPrefix = path.resolve(mirror) + '/';
  let best: { project: P; len: number; clientRoot: string } | null = null;
  let tie = false;
  for (const r of rows) {
    const root = path.resolve(r.path);
    if (!root.startsWith(mirrorPrefix)) continue;
    const tail = root.slice(mirrorPrefix.length).split('/').filter(Boolean).slice(1); // drop {sidecar}
    if (tail.length === 0) continue;
    // Find the tail as a run of cwd segments; the cwd may go deeper.
    for (let i = 0; i + tail.length <= segs.length; i++) {
      if (!tail.every((t, k) => segs[i + k] === t)) continue;
      const clientRoot = '/' + segs.slice(0, i + tail.length).join('/');
      if (!best || tail.length > best.len) { best = { project: r, len: tail.length, clientRoot }; tie = false; }
      else if (tail.length === best.len && best.project.id !== r.id) tie = true;
      break;
    }
  }
  return best && !tie ? { project: best.project, clientRoot: best.clientRoot } : null;
}

function iso(d: Date | null | undefined): string | null {
  return d instanceof Date ? d.toISOString() : null;
}

export async function buildSessionContext(a: SessionContextArgs): Promise<SessionContext> {
  const rows = await a.prisma.fantomProject.findMany({
    select: {
      id: true, name: true, path: true, language: true, parserType: true,
      autoIndex: true, indexMode: true, functionCount: true, typeCount: true, lastIndexed: true,
      instance: { select: { type: true, version: true } },
    },
    orderBy: { id: 'asc' },
  });
  const cwd = path.resolve(a.cwd);
  const match = projectForClientPath(rows, cwd);
  const hit = match?.project ?? null;

  let project: SessionContextProject | null = null;
  if (hit) {
    const run = await (a.prisma as any).indexRun.findFirst({
      where: { projectId: hit.id },
      orderBy: { startedAt: 'desc' },
      select: { id: true, trigger: true, startedAt: true, finishedAt: true, filesParsed: true, changeSource: true, errorMessage: true },
    }) as { id: number; trigger: string; startedAt: Date; finishedAt: Date | null; filesParsed: number; changeSource: string | null; errorMessage: string | null } | null;

    let focusFiles = 0;
    if (a.focusCount) {
      try { focusFiles = await a.focusCount(hit.id); } catch { focusFiles = 0; }
    }
    let symbolCount = 0;
    let fileCount = 0;
    try {
      const agg = await (a.prisma as any).indexedFile.aggregate({
        where: { projectId: hit.id },
        _sum: { symbolCount: true },
        _count: { _all: true },
      });
      symbolCount = Number(agg?._sum?.symbolCount ?? 0);
      fileCount = Number(agg?._count?._all ?? 0);
    } catch { /* older schema or test double: keep 0 */ }
    const vg = versionGroupForProject({ name: hit.name, path: hit.path, instance: hit.instance });
    project = {
      id: hit.id,
      name: hit.name,
      path: hit.path,
      language: hit.language,
      parserType: hit.parserType,
      versionGroup: { key: vg.key, label: vg.label },
      lazy: isLazyEnabledFor(hit.id, a.lazyConfig),
      autoIndex: hit.autoIndex,
      indexMode: hit.indexMode,
      functionCount: hit.functionCount,
      typeCount: hit.typeCount,
      symbolCount,
      fileCount,
      lastIndexed: iso(hit.lastIndexed),
      lastRun: run
        ? {
            id: run.id,
            trigger: run.trigger,
            startedAt: run.startedAt.toISOString(),
            finishedAt: iso(run.finishedAt),
            filesParsed: run.filesParsed,
            changeSource: run.changeSource,
            error: run.errorMessage,
          }
        : null,
      focusFiles,
      clientRoot: match?.clientRoot,
    };
  }

  return {
    ok: true,
    version: a.version ?? serverVersion(),
    now: new Date().toISOString(),
    cwd,
    project,
    projects: rows.map(r => ({ id: r.id, name: r.name, path: r.path, language: r.language })),
  };
}
