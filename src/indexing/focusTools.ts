/**
 * Focus set and AI change reports, the parts the MCP tools and the admin
 * routes call (lazy-incremental-indexing.md 3.11, phase 1b).
 *
 *   focusCheck     — before a tool answers about a file: if it is already a
 *                    focus file and changed on disk, re-parse it (priority-10
 *                    parse, waits up to focus.freshWaitMs, else stale: true);
 *                    then touch it.
 *   focusRelated   — the optional `related` block for a focus symbol.
 *   reportChanges  — the AI says what it wrote: touch, enqueue one parse per
 *                    project (deduped), run it now. Works with the lazy flag
 *                    off and for projects off the allow-list.
 *
 * Everything is a hint: the hash gate in indexProject still decides what
 * changed. Until the phase 5 session tables exist, intent and sessionId live
 * on the task payload (`reports`), which links to the run (trigger 'report').
 */

import * as fs from 'fs';
import * as path from 'path';
import type { PrismaClient } from '@prisma/client';
import { createLogger } from '../utils/index.js';
import { loadLazyConfig, type LazyIndexingConfig } from './lazyConfig.js';
import { getFocusSet, projectForPath, relPathIn, type FocusSet } from './focusSet.js';
import { filterSourcePaths, gateCandidates, scannerFor, type ProjectScanInfo } from './changeDetector.js';
import { TaskQueue } from './taskQueue.js';
import { PRIORITY, type ChangeReport, type ParsePayload } from './types.js';

const logger = createLogger('lazy-index');

/** Max files one report may name; the rest go to unknownFiles. */
export const MAX_REPORT_FILES = 200;
const CONFIG_TTL_MS = 5_000;
const PROJECTS_TTL_MS = 30_000;

/** What focusTools needs from the scheduler (LazyIndexScheduler). */
export interface FocusRunner {
  readonly taskQueue: TaskQueue;
  runNow(projectId: number): Promise<string>;
}

export interface GraphLike {
  getCallers(nodeId: string, maxDepth?: number): Promise<Array<{ qualifiedName: string; filePath: string; lineNumber?: number; depth: number }>>;
  getCallees(nodeId: string, maxDepth?: number): Promise<Array<{ qualifiedName: string; filePath: string; lineNumber?: number; depth: number }>>;
}

export interface FocusDeps {
  prisma: PrismaClient;
  runner: () => FocusRunner | null;
  config?: () => LazyIndexingConfig;
  set?: FocusSet;
  graph?: (projectId: number) => GraphLike;
  now?: () => number;
}

type ProjectRow = ProjectScanInfo;

let deps: FocusDeps | null = null;
let cfgCache: { at: number; cfg: LazyIndexingConfig } | null = null;
let projCache: { at: number; rows: ProjectRow[] } | null = null;

/** Wire the module (src/index.ts at boot, tests with fakes). */
export function configureFocus(d: FocusDeps | null): void {
  deps = d;
  cfgCache = null;
  projCache = null;
}

async function defaultDeps(): Promise<FocusDeps> {
  if (deps) return deps;
  const [{ getPrismaClient }, { getLazyIndexScheduler }] = await Promise.all([
    import('../db/prisma.js'),
    import('./runtime.js'),
  ]);
  deps = { prisma: getPrismaClient(), runner: getLazyIndexScheduler };
  return deps;
}

function nowOf(d: FocusDeps): number { return (d.now ?? Date.now)(); }

function configOf(d: FocusDeps): LazyIndexingConfig {
  const t = nowOf(d);
  if (cfgCache && t - cfgCache.at < CONFIG_TTL_MS) return cfgCache.cfg;
  const cfg = (d.config ?? loadLazyConfig)();
  cfgCache = { at: t, cfg };
  setOf(d).setConfig(cfg.focus);
  return cfg;
}

function setOf(d: FocusDeps): FocusSet { return d.set ?? getFocusSet(); }

async function projectsOf(d: FocusDeps): Promise<ProjectRow[]> {
  const t = nowOf(d);
  if (projCache && t - projCache.at < PROJECTS_TTL_MS) return projCache.rows;
  const rows = await d.prisma.fantomProject.findMany({
    select: { id: true, name: true, path: true, language: true, parserType: true, keyScheme: true },
  });
  projCache = { at: t, rows };
  return rows;
}

function queueOf(d: FocusDeps, cfg: LazyIndexingConfig): TaskQueue {
  const r = d.runner();
  if (r) return r.taskQueue;
  // Scheduler not started yet (boot): the row waits for the first runNow/tick.
  return new TaskQueue(d.prisma, {
    owner: `focus:pid:${process.pid}`,
    leaseMs: cfg.leaseMs,
    maxAttempts: cfg.retry.maxAttempts,
    backoffMs: cfg.retry.backoffMs,
    backoffCapMs: cfg.retry.backoffCapMs,
    heavyJobPollMs: cfg.yield.heavyJobPollMs,
  });
}

/** Resolve a file to its project and relative path. */
async function locate(d: FocusDeps, filePath: string, projectId?: number): Promise<{ project: ProjectRow; abs: string; rel: string } | null> {
  if (!filePath) return null;
  const projects = await projectsOf(d);
  let project: ProjectRow | null = null;
  if (projectId) {
    project = projects.find(p => p.id === projectId) ?? null;
  }
  const abs = path.isAbsolute(filePath) ? path.resolve(filePath) : project ? path.resolve(project.path, filePath) : null;
  if (!abs) return null;
  if (!project || relPathIn(project.path, abs) === null) project = projectForPath(projects, abs);
  if (!project) return null;
  const rel = relPathIn(project.path, abs);
  return rel === null ? null : { project, abs, rel };
}

// ── fresh answers (3.11.1 use 1) ──────────────────────────────────────────

export interface FocusCheck {
  projectId: number | null;
  /** A changed focus file was re-parsed before this answer. */
  refreshed: boolean;
  /** The file changed but the re-parse did not finish within freshWaitMs. */
  stale: boolean;
  /** The file is a focus file (it was named before this call). */
  focus: boolean;
}

const NO_CHECK: FocusCheck = { projectId: null, refreshed: false, stale: false, focus: false };

/**
 * Call before a tool answers about `filePath`. Only a file already in the
 * focus set is checked (one stat; sha only when mtime/size moved). Then the
 * file is touched. Never throws: a failure answers as before.
 */
export async function focusCheck(filePath: string | null | undefined, projectId?: number): Promise<FocusCheck> {
  if (!filePath) return NO_CHECK;
  try {
    const d = await defaultDeps();
    const cfg = configOf(d);
    const loc = await locate(d, filePath, projectId);
    if (!loc) return NO_CHECK;
    const set = setOf(d);
    const focus = set.has(loc.project.id, loc.rel);
    let refreshed = false, stale = false;
    if (focus) {
      const g = await gateCandidates(d.prisma, loc.project, [loc.abs], []);
      if (g.changed.length || g.removed.length) {
        const done = await enqueueAndWait(d, cfg, loc.project, g.changed, g.removed, null);
        refreshed = done; stale = !done;
      }
    }
    set.touch(loc.project.id, loc.rel);
    return { projectId: loc.project.id, refreshed, stale, focus };
  } catch (err) {
    logger.warn(`[focus] check of ${filePath} failed: ${err instanceof Error ? err.message : String(err)}`);
    return NO_CHECK;
  }
}

/** Touch files without a fresh check (reindexChangedFiles: it parses them itself). */
export async function focusTouch(filePaths: string[], projectId?: number): Promise<void> {
  try {
    const d = await defaultDeps();
    configOf(d);
    for (const f of filePaths.slice(0, MAX_REPORT_FILES)) {
      const loc = await locate(d, f, projectId);
      if (loc) setOf(d).touch(loc.project.id, loc.rel);
    }
  } catch (err) {
    logger.warn(`[focus] touch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Enqueue (or merge into) the project's priority-10 parse and run it now.
 * True when it finished within focus.freshWaitMs.
 */
async function enqueueAndWait(
  d: FocusDeps, cfg: LazyIndexingConfig, project: ProjectRow,
  paths: string[], removed: string[], report: ChangeReport | null,
): Promise<boolean> {
  const { taskId } = await enqueueParse(d, cfg, project.id, paths, removed, report);
  const runner = d.runner();
  if (taskId == null || !runner) return false;
  const run = runner.runNow(project.id).then(out => out === 'done').catch(() => false);
  if (cfg.focus.freshWaitMs <= 0) return false;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>(res => { timer = setTimeout(() => res(false), cfg.focus.freshWaitMs); });
  try {
    return await Promise.race([run, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function enqueueParse(
  d: FocusDeps, cfg: LazyIndexingConfig, projectId: number,
  paths: string[], removed: string[], report: ChangeReport | null,
): Promise<{ taskId: number | null; action: string }> {
  const payload: ParsePayload = {
    source: 'dirty', rootId: null, paths, removed, renamed: [],
    ...(report ? { trigger: 'report' as const, reports: [report] } : {}),
  };
  const r = await queueOf(d, cfg).enqueue({ projectId, kind: 'parse', priority: PRIORITY.primary, payload });
  return { taskId: r.id, action: r.action };
}

// ── reportChanges (3.11.2) ────────────────────────────────────────────────

export interface ReportInput {
  files: unknown;
  projectId?: unknown;
  projectPath?: unknown;
  /** Base for relative paths when no project is named (hook: the client cwd). */
  cwd?: unknown;
  intent?: unknown;
  sessionId?: unknown;
  client?: unknown;
}

export interface ReportResult {
  projectId: number | null;
  queued: number;
  taskId: number | null;
  unknownFiles: string[];
  /** One row per project when the files span more than one. */
  projects?: Array<{ projectId: number; queued: number; taskId: number | null }>;
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/[\r\n]+/g, ' ').trim();
  return s ? s.slice(0, max) : undefined;
}

export async function reportChanges(input: ReportInput): Promise<ReportResult> {
  const d = await defaultDeps();
  const cfg = configOf(d);
  const raw = Array.isArray(input.files) ? input.files.filter((f): f is string => typeof f === 'string' && f.trim() !== '') : [];
  if (raw.length === 0) throw new Error('files must be a non-empty array of paths');
  const projects = await projectsOf(d);

  let named: ProjectRow | null = null;
  const pid = Number(input.projectId);
  if (Number.isInteger(pid) && pid > 0) {
    named = projects.find(p => p.id === pid) ?? null;
    if (!named) throw new Error(`Project not found: ${pid}`);
  } else if (typeof input.projectPath === 'string' && input.projectPath.trim()) {
    named = projectForPath(projects, input.projectPath.trim());
    if (!named) throw new Error(`No registered project matches projectPath: ${input.projectPath}`);
  }
  const base = named?.path ?? (typeof input.cwd === 'string' && path.isAbsolute(input.cwd) ? input.cwd : null);

  const unknownFiles: string[] = raw.slice(MAX_REPORT_FILES);
  const groups = new Map<number, { project: ProjectRow; paths: string[]; removed: string[]; rel: string[] }>();
  for (const f of raw.slice(0, MAX_REPORT_FILES)) {
    const abs = path.isAbsolute(f) ? path.resolve(f) : base ? path.resolve(base, f) : null;
    const project = abs ? (named ? (relPathIn(named.path, abs) !== null ? named : null) : projectForPath(projects, abs)) : null;
    if (!abs || !project) { unknownFiles.push(f); continue; }
    if (filterSourcePaths([abs], project.path, scannerFor(project.language)).length === 0) { unknownFiles.push(f); continue; }
    let g = groups.get(project.id);
    if (!g) { g = { project, paths: [], removed: [], rel: [] }; groups.set(project.id, g); }
    if (fs.existsSync(abs)) g.paths.push(abs); else g.removed.push(abs);
    g.rel.push(relPathIn(project.path, abs)!);
  }

  const set = setOf(d);
  const intent = str(input.intent, 500);
  const sessionId = str(input.sessionId, 200);
  const client = str(input.client, 64);
  const rows: NonNullable<ReportResult['projects']> = [];
  for (const g of groups.values()) {
    for (const r of g.rel) set.touch(g.project.id, r);
    const report: ChangeReport = {
      at: new Date(nowOf(d)).toISOString(), files: [...new Set(g.rel)],
      ...(intent ? { intent } : {}), ...(sessionId ? { sessionId } : {}), ...(client ? { client } : {}),
    };
    const { taskId, action } = await enqueueParse(d, cfg, g.project.id, [...new Set(g.paths)], [...new Set(g.removed)], report);
    rows.push({ projectId: g.project.id, queued: report.files.length, taskId });
    logger.info(`[focus] report project=${g.project.name} files=${report.files.length} task=${taskId ?? '-'} (${action})${client ? ` client=${client}` : ''}`);
    const runner = d.runner();
    if (runner && taskId != null) void runner.runNow(g.project.id).catch(() => undefined);
  }
  const first = rows[0];
  return {
    projectId: first?.projectId ?? named?.id ?? null,
    queued: rows.reduce((n, r) => n + r.queued, 0),
    taskId: first?.taskId ?? null,
    unknownFiles,
    ...(rows.length > 1 ? { projects: rows } : {}),
  };
}

// ── suggestions (3.11.1 use 3) ────────────────────────────────────────────

export interface RelatedItem {
  kind: 'caller' | 'callee' | 'test' | 'change';
  qualifiedName: string;
  filePath: string;
  line?: number;
  /** change: added | modified | removed, with the time. */
  detail?: string;
}

const MAX_RELATED = 10;
const TEST_PATH = /(^|[\\/])(tests?|__tests__|spec)[\\/]|\.(test|spec)\.[^\\/]+$|Test\.fan$/i;

export function isTestPath(p: string): boolean { return TEST_PATH.test(p); }

/**
 * `related` block for a focus symbol: callers and callees (depth 1), tests
 * that reach it (callers up to depth 3 in test paths), and changes to the
 * same file in the last hour. At most 10 items; undefined when
 * focus.suggest is off, the file is not a focus file, or nothing is found.
 */
export async function focusRelated(args: {
  projectId: number | null | undefined;
  nodeId: string | null | undefined;
  filePath: string | null | undefined;
}): Promise<RelatedItem[] | undefined> {
  if (!args.projectId || !args.filePath) return undefined;
  try {
    const d = await defaultDeps();
    const cfg = configOf(d);
    if (!cfg.focus.suggest) return undefined;
    const loc = await locate(d, args.filePath, args.projectId);
    if (!loc || !setOf(d).has(loc.project.id, loc.rel)) return undefined;
    const graph = d.graph
      ? d.graph(loc.project.id)
      : (await import('../graph/ladybugQueryManager.js')).getLadybugQueryManager(loc.project.id);

    const out: RelatedItem[] = [];
    const seen = new Set<string>();
    const add = (it: RelatedItem): void => {
      const k = `${it.kind}\0${it.qualifiedName}\0${it.filePath}\0${it.detail ?? ''}`;
      if (out.length < MAX_RELATED && !seen.has(k)) { seen.add(k); out.push(it); }
    };
    if (args.nodeId) {
      const [callers, callees] = await Promise.all([
        graph.getCallers(args.nodeId, 3).catch(() => []),
        graph.getCallees(args.nodeId, 1).catch(() => []),
      ]);
      const tests = callers.filter(c => isTestPath(c.filePath));
      for (const c of tests.slice(0, 3)) add({ kind: 'test', qualifiedName: c.qualifiedName, filePath: c.filePath, line: c.lineNumber });
      for (const c of callers.filter(c => c.depth === 1 && !isTestPath(c.filePath)).slice(0, 3)) add({ kind: 'caller', qualifiedName: c.qualifiedName, filePath: c.filePath, line: c.lineNumber });
      for (const c of callees.filter(c => c.depth === 1).slice(0, 2)) add({ kind: 'callee', qualifiedName: c.qualifiedName, filePath: c.filePath, line: c.lineNumber });
    }
    const since = new Date(nowOf(d) - 3_600_000);
    const changes = await d.prisma.apiChange.findMany({
      where: { projectId: loc.project.id, filePath: { in: [loc.abs, loc.rel] }, occurredAt: { gte: since } },
      orderBy: { occurredAt: 'desc' },
      take: MAX_RELATED,
      select: { qualifiedName: true, changeType: true, filePath: true, lineStart: true, occurredAt: true },
    });
    for (const c of changes) add({ kind: 'change', qualifiedName: c.qualifiedName, filePath: c.filePath, line: c.lineStart ?? undefined, detail: `${c.changeType} ${c.occurredAt.toISOString()}` });
    return out.length ? out : undefined;
  } catch (err) {
    logger.warn(`[focus] related failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * Graph tools (getCallers, getCallees, getCodeImpact) name a symbol, not a
 * file: find its file in the in-memory index, run focusCheck, and (with
 * `suggest`) the related block. Returns the text lines to append.
 */
export async function focusForSymbol(args: {
  projectId?: number | null;
  nodeId?: string | null;
  qualifiedName?: string | null;
  suggest?: boolean;
}): Promise<string[]> {
  try {
    const { getFantomCodeIndexer } = await import('../fantom-code/indexer.js');
    const idx = getFantomCodeIndexer();
    const func = (args.nodeId ? idx.getFunction(args.nodeId) : undefined)
      ?? (args.qualifiedName ? idx.getFunctionByQualifiedName(args.qualifiedName) : undefined);
    if (!func?.filePath) return [];
    const fx = await focusCheck(func.filePath, args.projectId ?? func.projectId);
    const related = args.suggest && fx.focus
      ? await focusRelated({ projectId: fx.projectId, nodeId: func.id, filePath: func.filePath })
      : undefined;
    return relatedLines(related, fx.stale);
  } catch {
    return [];
  }
}

/** Text lines for tools that answer in plain text. */
export function relatedLines(related: RelatedItem[] | undefined, stale: boolean): string[] {
  const lines: string[] = [];
  if (stale) lines.push('', 'stale: true (the file changed; its re-parse is still running)');
  if (related?.length) {
    lines.push('', 'Related:');
    for (const r of related) {
      lines.push(`- [${r.kind}] ${r.qualifiedName} ${r.filePath}${r.line ? `:${r.line}` : ''}${r.detail ? ` (${r.detail})` : ''}`);
    }
  }
  return lines;
}

/** GET /admin/indexing/focus. */
export async function focusSnapshot(): Promise<{ ttlMs: number; maxFiles: number; suggest: boolean; dirtyProjects: unknown; files: Array<{ projectId: number; relPath: string; lastTouchedAt: string; touches: number }> }> {
  const d = await defaultDeps();
  const cfg = configOf(d);
  return {
    ttlMs: cfg.focus.ttlMs,
    maxFiles: cfg.focus.maxFiles,
    suggest: cfg.focus.suggest,
    dirtyProjects: cfg.dirty.projects,
    files: setOf(d).list().map(e => ({ projectId: e.projectId, relPath: e.relPath, lastTouchedAt: new Date(e.lastTouchedAt).toISOString(), touches: e.touches })),
  };
}
