/**
 * Project dependencies — persisted, directed edges between indexed code
 * projects ("fromProject depends on toProject"), stored in
 * `project_dependencies` (Prisma model ProjectDependency).
 *
 * Why: the ask pipeline (answerSynthesis.answerCodeQuestion) scopes every
 * search to ONE project. A question about a Fantom backend often needs its Vue
 * frontend. Instead of guessing from directory layout, the relations are
 * computed once per index run from real signals and read back through
 * `getProjectScope()`.
 *
 * Automatic kinds (recomputed by `rebuildProjectDependencies`; rows of these
 * kinds that are no longer derived are deleted; `enabled=false` survives):
 *
 *   build.fan-depends    <path>/build.fan (and pod/*, src/* sub-pods) `depends`
 *                        entries whose pod name maps to an indexed project.
 *                        Mapping rule — see `resolvePodToProject()`.
 *   package.json         dependencies/devDependencies whose name equals an
 *                        indexed project's name / podName / own package.json
 *                        name, or whose `file:` / `link:` / `workspace:` path
 *                        resolves to an indexed project's path.
 *   cross-project-edges  cross_project_edges GROUP BY (source, target) with
 *                        >= CROSS_EDGE_MIN_CALLS edges; one row per direction,
 *                        confidence min(1, calls/20).
 *   workspace-sibling    other indexed projects that are direct children of
 *                        the same parent directory (<= MAX_WORKSPACE_SIBLINGS).
 *
 * `manual` rows are created by the admin API / dashboard and never touched by
 * a rebuild.
 *
 * Side products written to FantomProject: `libraries` (JSON string[] of
 * third-party package.json / build.fan names that are NOT indexed projects)
 * and `summary` (one-liner for the ask's scope note).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../db/prisma.js';
import { parseBuildFanDepends, dependPodName } from '../fantom-code/fantomBuildIndexer.js';
import { createLogger } from '../utils/index.js';

const logger = createLogger('project-deps');

// ============================================
// Constants and types
// ============================================

export const DEPENDENCY_KINDS = [
  'build.fan-depends',
  'package.json',
  'cross-project-edges',
  'workspace-sibling',
  'manual',
] as const;
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];

/** Kinds that `rebuildProjectDependencies` owns (adds/updates/removes). */
export const AUTO_KINDS: DependencyKind[] = [
  'build.fan-depends',
  'package.json',
  'cross-project-edges',
  'workspace-sibling',
];

export const CONFIDENCE: Record<DependencyKind, number> = {
  'build.fan-depends': 1.0,
  'package.json': 1.0,
  'cross-project-edges': 1.0, // scaled: min(1, calls / 20)
  'workspace-sibling': 0.5,
  manual: 1.0,
};

/** Kind priority for tie-breaking (lower = stronger). */
const KIND_RANK: Record<DependencyKind, number> = {
  manual: 0,
  'cross-project-edges': 1,
  'package.json': 2,
  'build.fan-depends': 3,
  'workspace-sibling': 4,
};

export const MAX_WORKSPACE_SIBLINGS = 8;
export const CROSS_EDGE_MIN_CALLS = 5;
export const CROSS_EDGE_FULL_CONFIDENCE_CALLS = 20;
/** Default cap on related projects returned by getProjectScope (memory guard). */
export const DEFAULT_MAX_SCOPE_PROJECTS = 4;

/** Fantom core pods that every pod depends on; excluded from `libraries`. */
const FANTOM_CORE_PODS = new Set(['sys', 'concurrent', 'util', 'inet', 'web', 'wisp', 'xml', 'compiler', 'build']);

export interface RebuildResult {
  projectId: number;
  added: number;
  updated: number;
  removed: number;
  /** Number of derived (desired) rows per kind, e.g. { "workspace-sibling": 1 }. */
  kinds: Record<string, number>;
  libraries: string[];
  durationMs: number;
}

export interface RebuildAllResult {
  projects: number;
  failed: number;
  added: number;
  updated: number;
  removed: number;
  kinds: Record<string, number>;
  durationMs: number;
  errors: Array<{ projectId: number; error: string }>;
}

export interface ScopeProject {
  id: number;
  name: string;
  language: string;
  /** Strongest kind linking this project to the primary. */
  kind: DependencyKind | string;
  /** Every kind that links it (a sibling may also be a call target). */
  kinds: string[];
  /** 'depends-on' = primary depends on it; 'dependent' = it depends on the primary. */
  direction: 'depends-on' | 'dependent';
  confidence: number;
  libraries: string[];
  summary: string | null;
}

export interface ProjectScope {
  primary: { id: number; name: string; language: string; libraries: string[]; summary: string | null };
  related: ScopeProject[];
  /** True when no persisted rows existed and same-directory siblings were used instead. */
  fallback: boolean;
}

export interface DeclaredDependency {
  /** Raw entry, e.g. "haystack 3.0+" or "rete" (package.json). */
  raw: string;
  name: string;
  /** Where it was declared: "build.fan", "pod/sweExt/build.fan", "package.json:dependencies". */
  from: string;
  /** Indexed project it resolved to, or null (third-party / not indexed). */
  resolvedProjectId: number | null;
  resolvedProjectName: string | null;
}

type ProjectRow = {
  id: number;
  name: string;
  path: string;
  instanceId: number | null;
  buildId: number | null;
  podName: string | null;
  language: string;
};

interface DesiredRow {
  fromProjectId: number;
  toProjectId: number;
  kind: DependencyKind;
  source: string | null;
  confidence: number;
}

// ============================================
// Helpers
// ============================================

function normPath(p: string): string {
  return path.resolve(p).replace(/\/+$/, '');
}

function parentDir(p: string): string {
  return path.dirname(normPath(p));
}

function rowKey(r: { fromProjectId: number; toProjectId: number; kind: string }): string {
  return `${r.fromProjectId}:${r.toProjectId}:${r.kind}`;
}

/** Natural version compare on the version-looking parts of two project names (newest first). */
function compareVersionDesc(a: string, b: string): number {
  const va = (a.match(/\d+(?:\.\d+)+/) ?? [''])[0].split('.').map(Number);
  const vb = (b.match(/\d+(?:\.\d+)+/) ?? [''])[0].split('.').map(Number);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] ?? -1) - (va[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

function readJsonSafe(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function readTextSafe(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

/** build.fan files belonging to a project: its own plus one level of pod/* and src/* sub-pods. */
function listBuildFanFiles(projectPath: string): Array<{ file: string; label: string }> {
  const out: Array<{ file: string; label: string }> = [];
  const root = path.join(projectPath, 'build.fan');
  if (fs.existsSync(root)) out.push({ file: root, label: 'build.fan' });
  for (const sub of ['pod', 'src']) {
    const dir = path.join(projectPath, sub);
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries.slice(0, 50)) {
      const f = path.join(dir, e, 'build.fan');
      if (fs.existsSync(f)) out.push({ file: f, label: `${sub}/${e}/build.fan` });
    }
  }
  return out;
}

// ============================================
// Project catalogue (loaded once per rebuild)
// ============================================

class ProjectCatalogue {
  readonly byId = new Map<number, ProjectRow>();
  readonly byPath = new Map<string, ProjectRow>();
  readonly byPodName = new Map<string, ProjectRow[]>();
  readonly byLowerName = new Map<string, ProjectRow[]>();
  /** pods.name → pods.path (for pods without a FantomProject.podName match). */
  readonly podPaths = new Map<string, string[]>();
  /** instance id → Fantom runtime version it ships (e.g. "1.0.82"). */
  readonly instanceFantomVersion = new Map<number, string>();
  private pkgNames: Map<string, ProjectRow[]> | null = null;

  constructor(
    projects: ProjectRow[],
    pods: Array<{ name: string; path: string }>,
    instances: Array<{ id: number; fantomVersion: string | null }> = [],
  ) {
    for (const i of instances) if (i.fantomVersion) this.instanceFantomVersion.set(i.id, i.fantomVersion);
    for (const p of projects) {
      this.byId.set(p.id, p);
      this.byPath.set(normPath(p.path), p);
      if (p.podName) {
        const list = this.byPodName.get(p.podName) ?? [];
        list.push(p);
        this.byPodName.set(p.podName, list);
      }
      const ln = p.name.toLowerCase();
      const nl = this.byLowerName.get(ln) ?? [];
      nl.push(p);
      this.byLowerName.set(ln, nl);
    }
    for (const pod of pods) {
      const list = this.podPaths.get(pod.name) ?? [];
      list.push(normPath(pod.path));
      this.podPaths.set(pod.name, list);
    }
  }

  static async load(prisma: PrismaClient): Promise<ProjectCatalogue> {
    const [projects, pods, instances] = await Promise.all([
      prisma.fantomProject.findMany({
        select: { id: true, name: true, path: true, instanceId: true, buildId: true, podName: true, language: true },
      }),
      prisma.pod.findMany({ select: { name: true, path: true } }),
      prisma.instance.findMany({ select: { id: true, fantomVersion: true } }),
    ]);
    return new ProjectCatalogue(projects, pods, instances);
  }

  all(): ProjectRow[] {
    return [...this.byId.values()];
  }

  /**
   * package.json `name` of every non-Fantom project (lazy; only a handful of
   * TS/JS/Vue projects exist so this is cheap).
   */
  packageNames(): Map<string, ProjectRow[]> {
    if (this.pkgNames) return this.pkgNames;
    const m = new Map<string, ProjectRow[]>();
    for (const p of this.byId.values()) {
      if (p.language === 'fantom') continue;
      const pkg = readJsonSafe(path.join(p.path, 'package.json'));
      const name = typeof pkg?.name === 'string' ? pkg.name.toLowerCase() : null;
      if (!name) continue;
      const list = m.get(name) ?? [];
      list.push(p);
      m.set(name, list);
    }
    this.pkgNames = m;
    return m;
  }
}

/**
 * Pod-name → project mapping rule (build.fan `depends`).
 *
 * Candidates are projects whose `podName` equals the pod name exactly
 * (project names such as "Haxall 4.0.4:core/def" or "fantom.1.0.82.sys" all
 * carry the bare pod name in `podName`). If none, `pods.name` is looked up and
 * matched to a project by path.
 *
 * Ranking when several instances/builds ship the same pod:
 *   0. same instance as the from-project
 *   1. same Fantom build as the from-project, or the Fantom source build the
 *      from-project's instance runs on (instances.fantom_version →
 *      "fantom.<version>.<pod>", e.g. Haxall 4.0.4 → fantom.1.0.82.sys)
 *   2. standalone project (no instance, no build) — the user's own pods
 *   3. anything else
 * Ties are broken by the newest version embedded in the project name
 * (e.g. "Haxall 4.0.6:…" beats "Haxall 4.0.4:…"), then by highest id.
 */
export function resolvePodToProject(cat: ProjectCatalogue, from: ProjectRow, podName: string): ProjectRow | null {
  let candidates = cat.byPodName.get(podName) ?? [];
  if (candidates.length === 0) {
    const paths = cat.podPaths.get(podName) ?? [];
    candidates = paths.map(p => cat.byPath.get(p)).filter((p): p is ProjectRow => !!p);
  }
  candidates = candidates.filter(c => c.id !== from.id);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const runtimeVersion = from.instanceId != null ? cat.instanceFantomVersion.get(from.instanceId) : undefined;
  const runtimeName = runtimeVersion ? `fantom.${runtimeVersion}.${podName}` : null;
  const rank = (c: ProjectRow): number => {
    if (from.instanceId != null && c.instanceId === from.instanceId) return 0;
    if (from.buildId != null && c.buildId === from.buildId) return 1;
    if (runtimeName && c.name === runtimeName) return 1;
    if (c.instanceId == null && c.buildId == null) return 2;
    return 3;
  };
  return [...candidates].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    const v = compareVersionDesc(a.name, b.name);
    if (v !== 0) return v;
    return b.id - a.id;
  })[0];
}

// ============================================
// Derivation per source
// ============================================

function deriveBuildFan(cat: ProjectCatalogue, from: ProjectRow): { rows: DesiredRow[]; declared: DeclaredDependency[]; libs: string[] } {
  const rows: DesiredRow[] = [];
  const declared: DeclaredDependency[] = [];
  const libs = new Set<string>();
  const seenTo = new Set<number>();
  for (const { file, label } of listBuildFanFiles(from.path)) {
    const content = readTextSafe(file);
    if (!content) continue;
    for (const entry of parseBuildFanDepends(content)) {
      const podName = dependPodName(entry);
      if (!podName) continue;
      const target = resolvePodToProject(cat, from, podName);
      declared.push({
        raw: entry,
        name: podName,
        from: label,
        resolvedProjectId: target?.id ?? null,
        resolvedProjectName: target?.name ?? null,
      });
      if (!target) {
        if (!FANTOM_CORE_PODS.has(podName)) libs.add(podName);
        continue;
      }
      if (seenTo.has(target.id)) continue;
      seenTo.add(target.id);
      rows.push({
        fromProjectId: from.id,
        toProjectId: target.id,
        kind: 'build.fan-depends',
        source: label === 'build.fan' ? entry : `${label}: ${entry}`,
        confidence: CONFIDENCE['build.fan-depends'],
      });
    }
  }
  return { rows, declared, libs: [...libs] };
}

function derivePackageJson(cat: ProjectCatalogue, from: ProjectRow): { rows: DesiredRow[]; declared: DeclaredDependency[]; libs: string[] } {
  const rows: DesiredRow[] = [];
  const declared: DeclaredDependency[] = [];
  const libs = new Set<string>();
  const pkg = readJsonSafe(path.join(from.path, 'package.json'));
  if (!pkg) return { rows, declared, libs: [] };
  const seenTo = new Set<number>();
  for (const section of ['dependencies', 'devDependencies'] as const) {
    const deps = pkg[section];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, specRaw] of Object.entries(deps)) {
      const spec = typeof specRaw === 'string' ? specRaw : '';
      let target: ProjectRow | undefined;
      // Local path dependency → match by resolved path.
      const m = /^(?:file|link|workspace):(.*)$/.exec(spec);
      if (m && m[1] && m[1] !== '*' && !/^[\^~]/.test(m[1])) {
        target = cat.byPath.get(normPath(path.resolve(from.path, m[1])));
      }
      if (!target) {
        const lower = name.toLowerCase();
        const cands = [
          ...(cat.byLowerName.get(lower) ?? []),
          ...(cat.byPodName.get(name) ?? []),
          ...(cat.packageNames().get(lower) ?? []),
        ].filter(c => c.id !== from.id);
        target = cands[0];
      }
      declared.push({
        raw: spec ? `${name}@${spec}` : name,
        name,
        from: `package.json:${section}`,
        resolvedProjectId: target?.id ?? null,
        resolvedProjectName: target?.name ?? null,
      });
      if (!target) {
        if (section === 'dependencies' && !name.startsWith('@types/')) libs.add(name);
        continue;
      }
      if (seenTo.has(target.id)) continue;
      seenTo.add(target.id);
      rows.push({
        fromProjectId: from.id,
        toProjectId: target.id,
        kind: 'package.json',
        source: `package.json:${section}.${name}`,
        confidence: CONFIDENCE['package.json'],
      });
    }
  }
  return { rows, declared, libs: [...libs] };
}

async function deriveCrossProjectEdges(prisma: PrismaClient, cat: ProjectCatalogue, from: ProjectRow): Promise<DesiredRow[]> {
  const rows: DesiredRow[] = [];
  const [outgoing, incoming] = await Promise.all([
    prisma.crossProjectEdge.groupBy({
      by: ['targetProjectId'],
      where: { sourceProjectId: from.id },
      _count: { _all: true },
    }),
    prisma.crossProjectEdge.groupBy({
      by: ['sourceProjectId'],
      where: { targetProjectId: from.id },
      _count: { _all: true },
    }),
  ]);
  const push = (fromId: number, toId: number, calls: number) => {
    if (calls < CROSS_EDGE_MIN_CALLS || fromId === toId) return;
    if (!cat.byId.has(fromId) || !cat.byId.has(toId)) return;
    rows.push({
      fromProjectId: fromId,
      toProjectId: toId,
      kind: 'cross-project-edges',
      source: `cross_project_edges:${calls}`,
      confidence: Math.min(1, calls / CROSS_EDGE_FULL_CONFIDENCE_CALLS),
    });
  };
  for (const g of outgoing) push(from.id, g.targetProjectId, g._count._all);
  for (const g of incoming) push(g.sourceProjectId, from.id, g._count._all);
  return rows;
}

/** Direct children of the same parent directory, excluding the project itself. */
export function workspaceSiblingsOf(projects: Iterable<ProjectRow>, from: { id: number; path: string }): ProjectRow[] {
  const parent = parentDir(from.path);
  if (!parent || parent === normPath(from.path) || parent === '/') return [];
  const out: ProjectRow[] = [];
  for (const p of projects) {
    if (p.id === from.id) continue;
    if (parentDir(p.path) === parent) out.push(p);
  }
  return out.sort((a, b) => a.id - b.id).slice(0, MAX_WORKSPACE_SIBLINGS);
}

function deriveWorkspace(cat: ProjectCatalogue, from: ProjectRow): DesiredRow[] {
  return workspaceSiblingsOf(cat.all(), from).map(sib => ({
    fromProjectId: from.id,
    toProjectId: sib.id,
    kind: 'workspace-sibling' as const,
    source: parentDir(from.path),
    confidence: CONFIDENCE['workspace-sibling'],
  }));
}

function buildSummary(p: ProjectRow, libs: string[]): string {
  const lang = p.language || 'fantom';
  const parts: string[] = [];
  parts.push(lang === 'fantom' ? `Fantom pod${p.podName ? ` ${p.podName}` : ''}` : `${lang} project`);
  if (libs.length) parts.push(`libs: ${libs.slice(0, 8).join(', ')}`);
  return parts.join('; ');
}

// ============================================
// Public API
// ============================================

/**
 * Declared dependencies (build.fan + package.json) with their resolution to
 * indexed projects — used by the dashboard's pod graph (unresolved = greyed).
 */
export async function getDeclaredDependencies(projectId: number, prismaArg?: PrismaClient): Promise<DeclaredDependency[]> {
  const prisma = prismaArg ?? getPrismaClient();
  const cat = await ProjectCatalogue.load(prisma);
  const from = cat.byId.get(projectId);
  if (!from) return [];
  return [...deriveBuildFan(cat, from).declared, ...derivePackageJson(cat, from).declared];
}

/**
 * Recompute the automatic dependency rows of one project (idempotent).
 * Rows of automatic kinds that are no longer derived are deleted; rows that
 * still apply keep their `enabled` flag (so an operator's off-switch survives);
 * `manual` rows are never touched. Also refreshes FantomProject.libraries /
 * summary.
 */
export async function rebuildProjectDependencies(
  projectId: number,
  opts: { prisma?: PrismaClient; catalogue?: ProjectCatalogue } = {},
): Promise<RebuildResult> {
  const started = Date.now();
  const prisma = opts.prisma ?? getPrismaClient();
  const cat = opts.catalogue ?? (await ProjectCatalogue.load(prisma));
  const from = cat.byId.get(projectId);
  if (!from) throw new Error(`Project not found: ${projectId}`);

  const bf = deriveBuildFan(cat, from);
  const pj = derivePackageJson(cat, from);
  const cross = await deriveCrossProjectEdges(prisma, cat, from);
  const ws = deriveWorkspace(cat, from);

  const desired = new Map<string, DesiredRow>();
  for (const r of [...bf.rows, ...pj.rows, ...cross, ...ws]) desired.set(rowKey(r), r);

  // Existing automatic rows this rebuild owns: everything outgoing of the
  // automatic kinds, plus incoming cross-project-edges rows (both directions
  // are derived from the same table, so we own both).
  const existing = await prisma.projectDependency.findMany({
    where: {
      OR: [
        { fromProjectId: projectId, kind: { in: AUTO_KINDS } },
        { toProjectId: projectId, kind: 'cross-project-edges' },
      ],
    },
  });
  const existingByKey = new Map(existing.map(e => [rowKey(e), e]));

  const toCreate: DesiredRow[] = [];
  const toUpdate: Array<{ id: number; source: string | null; confidence: number }> = [];
  for (const [key, want] of desired) {
    const have = existingByKey.get(key);
    if (!have) toCreate.push(want);
    else if (have.source !== want.source || have.confidence !== want.confidence) {
      toUpdate.push({ id: have.id, source: want.source, confidence: want.confidence });
    }
  }
  const staleIds = existing.filter(e => !desired.has(rowKey(e))).map(e => e.id);

  // One transaction per project: a single createMany instead of N inserts
  // (rebuild-all over ~340 projects writes ~5k rows; per-row writes took >2 min).
  let removed = 0;
  await prisma.$transaction(async tx => {
    if (toCreate.length) await tx.projectDependency.createMany({ data: toCreate });
    for (const u of toUpdate) {
      await tx.projectDependency.update({ where: { id: u.id }, data: { source: u.source, confidence: u.confidence } });
    }
    if (staleIds.length) {
      const del = await tx.projectDependency.deleteMany({ where: { id: { in: staleIds } } });
      removed = del.count;
    }
  });
  const added = toCreate.length;
  const updated = toUpdate.length;

  const libraries = [...new Set([...pj.libs, ...bf.libs])].sort();
  try {
    await prisma.fantomProject.update({
      where: { id: projectId },
      data: { libraries: JSON.stringify(libraries), summary: buildSummary(from, libraries) },
    });
  } catch (err) {
    logger.warn(`libraries/summary update failed for project ${projectId}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const kinds: Record<string, number> = {};
  for (const r of desired.values()) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;

  const durationMs = Date.now() - started;
  logger.info(
    `rebuilt dependencies for project ${projectId} (${from.name}): +${added} ~${updated} -${removed} ` +
      `[${Object.entries(kinds).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}] in ${durationMs}ms`,
  );
  return { projectId, added, updated, removed, kinds, libraries, durationMs };
}

/** Rebuild every indexed project sequentially (one catalogue load). */
export async function rebuildAllProjectDependencies(prismaArg?: PrismaClient): Promise<RebuildAllResult> {
  const started = Date.now();
  const prisma = prismaArg ?? getPrismaClient();
  const cat = await ProjectCatalogue.load(prisma);
  const totals: RebuildAllResult = { projects: 0, failed: 0, added: 0, updated: 0, removed: 0, kinds: {}, durationMs: 0, errors: [] };
  for (const p of cat.all()) {
    try {
      const r = await rebuildProjectDependencies(p.id, { prisma, catalogue: cat });
      totals.projects++;
      totals.added += r.added;
      totals.updated += r.updated;
      totals.removed += r.removed;
      for (const [k, v] of Object.entries(r.kinds)) totals.kinds[k] = (totals.kinds[k] ?? 0) + v;
    } catch (err) {
      totals.failed++;
      totals.errors.push({ projectId: p.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  totals.durationMs = Date.now() - started;
  logger.info(`rebuild-all: ${totals.projects} projects, +${totals.added} ~${totals.updated} -${totals.removed} in ${totals.durationMs}ms`);
  return totals;
}

/**
 * Best-effort hook for the indexing pipeline: never throws.
 */
export async function rebuildProjectDependenciesSafe(projectId: number, prisma?: PrismaClient): Promise<RebuildResult | null> {
  try {
    return await rebuildProjectDependencies(projectId, { prisma });
  } catch (err) {
    logger.warn(`dependency rebuild skipped for project ${projectId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function parseLibraries(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The projects an ask scoped to `projectId` should search: the primary plus
 * its enabled dependencies AND dependents, deduped, ordered by confidence
 * (then number of linking kinds, then kind strength) and capped at
 * `maxProjects` (default 4 — every downstream search stays project-scoped,
 * one projectId per query; the cap bounds the number of per-project graph
 * connections an ask opens).
 *
 * Fallback: when the table holds no row for the project at all (never
 * rebuilt), same-parent-directory siblings are returned as
 * `workspace-sibling` so behaviour never regresses below the old heuristic.
 */
export async function getProjectScope(
  projectId: number,
  opts: { maxProjects?: number; prisma?: PrismaClient; fallbackToWorkspace?: boolean } = {},
): Promise<ProjectScope | null> {
  const prisma = opts.prisma ?? getPrismaClient();
  const maxProjects = Math.max(0, opts.maxProjects ?? DEFAULT_MAX_SCOPE_PROJECTS);
  const sel = { id: true, name: true, language: true, libraries: true, summary: true, path: true } as const;
  const me = await prisma.fantomProject.findUnique({ where: { id: projectId }, select: sel });
  if (!me) return null;
  const primary = { id: me.id, name: me.name, language: me.language, libraries: parseLibraries(me.libraries), summary: me.summary ?? null };

  const rows = await prisma.projectDependency.findMany({
    where: { OR: [{ fromProjectId: projectId }, { toProjectId: projectId }] },
    include: { fromProject: { select: sel }, toProject: { select: sel } },
  });

  type Agg = ScopeProject & { rank: number };
  const agg = new Map<number, Agg>();
  for (const r of rows) {
    if (!r.enabled) continue;
    const isOut = r.fromProjectId === projectId;
    const other = isOut ? r.toProject : r.fromProject;
    if (other.id === projectId) continue;
    const rank = KIND_RANK[r.kind as DependencyKind] ?? 9;
    const cur = agg.get(other.id);
    if (!cur) {
      agg.set(other.id, {
        id: other.id,
        name: other.name,
        language: other.language,
        kind: r.kind,
        kinds: [r.kind],
        direction: isOut ? 'depends-on' : 'dependent',
        confidence: r.confidence,
        libraries: parseLibraries(other.libraries),
        summary: other.summary ?? null,
        rank,
      });
    } else {
      if (!cur.kinds.includes(r.kind)) cur.kinds.push(r.kind);
      if (r.confidence > cur.confidence || (r.confidence === cur.confidence && rank < cur.rank)) {
        cur.confidence = Math.max(cur.confidence, r.confidence);
        cur.kind = r.kind;
        cur.rank = rank;
        cur.direction = isOut ? 'depends-on' : 'dependent';
      }
    }
  }

  let related: ScopeProject[] = [...agg.values()]
    .sort((a, b) => b.confidence - a.confidence || b.kinds.length - a.kinds.length || a.rank - b.rank || a.id - b.id)
    .map(({ rank: _rank, ...rest }) => rest);

  let fallback = false;
  if (rows.length === 0 && (opts.fallbackToWorkspace ?? true)) {
    fallback = true;
    const parent = parentDir(me.path);
    const cands = await prisma.fantomProject.findMany({
      where: { path: { startsWith: parent + '/' }, id: { not: projectId } },
      select: { ...sel, instanceId: true, buildId: true, podName: true },
      take: 50,
    });
    related = workspaceSiblingsOf(cands, me).map(s => {
      const full = cands.find(c => c.id === s.id)!;
      return {
        id: s.id,
        name: s.name,
        language: s.language,
        kind: 'workspace-sibling',
        kinds: ['workspace-sibling'],
        direction: 'depends-on' as const,
        confidence: CONFIDENCE['workspace-sibling'],
        libraries: parseLibraries(full.libraries),
        summary: full.summary ?? null,
      };
    });
  }

  return { primary, related: related.slice(0, maxProjects), fallback };
}

/**
 * Dependencies of one project in both directions with names — the admin
 * GET /code-projects/:id/dependencies payload.
 */
export async function listProjectDependencies(projectId: number, prismaArg?: PrismaClient) {
  const prisma = prismaArg ?? getPrismaClient();
  const sel = { id: true, name: true, language: true, path: true } as const;
  const project = await prisma.fantomProject.findUnique({ where: { id: projectId }, select: { ...sel, libraries: true, summary: true } });
  if (!project) return null;
  const rows = await prisma.projectDependency.findMany({
    where: { OR: [{ fromProjectId: projectId }, { toProjectId: projectId }] },
    include: { fromProject: { select: sel }, toProject: { select: sel } },
    orderBy: [{ confidence: 'desc' }, { id: 'asc' }],
  });
  const shape = (r: (typeof rows)[number], other: { id: number; name: string; language: string; path: string }) => ({
    id: r.id,
    projectId: other.id,
    name: other.name,
    language: other.language,
    path: other.path,
    kind: r.kind,
    source: r.source,
    confidence: r.confidence,
    enabled: r.enabled,
    createdAt: r.createdAt,
  });
  return {
    project: { ...project, libraries: parseLibraries(project.libraries) },
    dependsOn: rows.filter(r => r.fromProjectId === projectId).map(r => shape(r, r.toProject)),
    dependents: rows.filter(r => r.toProjectId === projectId).map(r => shape(r, r.fromProject)),
  };
}

/**
 * Per-project counts for every project (dashboard list badges) plus a
 * path → projectId map so pod rows can be matched to their project.
 */
export async function summarizeProjectDependencies(prismaArg?: PrismaClient) {
  const prisma = prismaArg ?? getPrismaClient();
  const [projects, out, inc] = await Promise.all([
    prisma.fantomProject.findMany({ select: { id: true, name: true, path: true, podName: true } }),
    prisma.projectDependency.groupBy({ by: ['fromProjectId'], where: { enabled: true }, _count: { _all: true } }),
    prisma.projectDependency.groupBy({ by: ['toProjectId'], where: { enabled: true }, _count: { _all: true } }),
  ]);
  const counts: Record<number, { dependsOn: number; dependents: number }> = {};
  for (const p of projects) counts[p.id] = { dependsOn: 0, dependents: 0 };
  for (const g of out) if (counts[g.fromProjectId]) counts[g.fromProjectId].dependsOn = g._count._all;
  for (const g of inc) if (counts[g.toProjectId]) counts[g.toProjectId].dependents = g._count._all;
  const byPath: Record<string, number> = {};
  for (const p of projects) byPath[normPath(p.path)] = p.id;
  return { counts, byPath, projects: projects.map(p => ({ id: p.id, name: p.name, podName: p.podName })) };
}
