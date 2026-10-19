/**
 * Lazy indexing scheduler (lazy-incremental-indexing.md 3.1, 3.3, 3.10).
 *
 * Owns, for the projects on the `indexing.lazy` allow-list:
 *   - the git roots and one GitWatcher (3.2.1); a settled HEAD move runs
 *     computeRootChanges for the root (serialised per root) and enqueues one
 *     task per project with changes;
 *   - the boot check: every root is diffed once at activation, so a commit
 *     made while the server was down is indexed now;
 *   - the safety-net scans (3.2.5): 5 min for scan-mode projects, 30 min for
 *     git projects, at most `scan.concurrency` at once, never while a parse
 *     for the same project runs; also the baseline (a git project whose base
 *     is NULL gets HEAD once a scan finds nothing to do);
 *   - the dispatch tick: memory guard first, then one parse worker
 *     (parse + full-reindex) and one embed worker claim from the queue.
 * The config is re-read every `CONFIG_RELOAD_MS`: turning the flag off stops
 * the watchers and the workers; turning it on starts them, no restart.
 */

import * as fs from 'fs';
import type { PrismaClient, GitRoot } from '@prisma/client';
import { createLogger } from '../utils/index.js';
import { loadPrimaryProject } from '../config/index.js';
import { loadLazyConfig, type LazyIndexingConfig } from './lazyConfig.js';
import { MemoryGuard } from './memoryGuard.js';
import { TaskQueue, dedupeKeyFor } from './taskQueue.js';
import { GitWatcher } from './gitWatcher.js';
import { syncProjectRoots, ownerOf, isUnder } from './gitRoots.js';
import { computeRootChanges, type GitProjectInput } from './gitChangeSource.js';
import { changeCount, scanProject, scannerFor, type ProjectScanInfo } from './changeDetector.js';
import { planForChangeSet } from './taskPlanner.js';
import { setGitConcurrency, isGitAvailable } from './gitExec.js';
import { runTask, type WorkerDeps, type WorkerOutcome } from './taskWorker.js';
import { PRIORITY, type ChangeSet, type ChangeSource, type GitContext } from './types.js';

const logger = createLogger('lazy-index');
const CONFIG_RELOAD_MS = 30_000;

export interface SchedulerDeps {
  prisma: PrismaClient;
  /** Everything a worker needs except prisma/queue/memory (built here). */
  worker: Omit<WorkerDeps, 'prisma' | 'queue' | 'memory' | 'heavyJobPollMs'>;
  loadConfig?: () => LazyIndexingConfig;
  owner?: string;
}

type ProjectRow = ProjectScanInfo & { indexMode: string };

export class LazyIndexScheduler {
  private cfg: LazyIndexingConfig;
  private readonly memory: MemoryGuard;
  private queue: TaskQueue;
  private watcher: GitWatcher | null = null;
  private active = false;
  private tickTimer: NodeJS.Timeout | null = null;
  private configTimer: NodeJS.Timeout | null = null;
  private readonly rootChains = new Map<number, Promise<void>>();
  private readonly nextScanAt = new Map<number, number>();
  private readonly runningProjects = new Set<number>();
  private scansRunning = 0;
  private parseBusy = 0;
  private embedBusy = 0;
  private lastTickLog = 0;
  private nextGcAt = 0;
  /** runNow lane (3.11): one task at a time, outside the tick. */
  private nowChain: Promise<unknown> = Promise.resolve();
  private readonly nowRetry = new Map<string, NodeJS.Timeout>();
  private readonly owner: string;

  constructor(private readonly deps: SchedulerDeps) {
    this.cfg = (deps.loadConfig ?? loadLazyConfig)();
    this.owner = deps.owner ?? `pid:${process.pid}:${Date.now()}`;
    this.memory = new MemoryGuard(this.cfg.memory);
    this.queue = this.makeQueue();
  }

  get taskQueue(): TaskQueue { return this.queue; }
  get prismaClient(): PrismaClient { return this.deps.prisma; }
  get memoryGuard(): MemoryGuard { return this.memory; }
  isActive(): boolean { return this.active; }

  /** True when the flag is on and the project is on the allow-list. */
  isEnabledFor(projectId: number): boolean {
    return this.active && (this.cfg.projects === 'all' || this.cfg.projects.includes(projectId));
  }

  async start(): Promise<void> {
    await this.applyConfig();
    this.configTimer = setInterval(() => { void this.reloadConfig(); }, CONFIG_RELOAD_MS);
    this.configTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.configTimer) { clearInterval(this.configTimer); this.configTimer = null; }
    for (const t of this.nowRetry.values()) clearTimeout(t);
    this.nowRetry.clear();
    this.deactivate();
  }

  /**
   * Run the project's pending `parse` task now (focus refresh, change report;
   * 3.11). Works with the flag off and for projects off the allow-list: the
   * report is the trigger, not a watcher. Serialised in its own lane. A task
   * that yields (heavy job, memory, project busy) is retried on a timer when
   * the tick will not pick it up.
   */
  runNow(projectId: number, kind: 'parse' | 'rekey' = 'parse'): Promise<WorkerOutcome | 'busy' | 'none'> {
    const run = this.nowChain.then(() => this.runNowOnce(projectId, kind));
    this.nowChain = run.catch(() => undefined);
    return run;
  }

  private async runNowOnce(projectId: number, kind: 'parse' | 'rekey'): Promise<WorkerOutcome | 'busy' | 'none'> {
    const pending = await this.deps.prisma.indexTask.findUnique({ where: { dedupeKey: dedupeKeyFor(projectId, kind) } });
    if (!pending) return 'none';
    let out: WorkerOutcome | 'busy' = 'busy';
    if (!this.runningProjects.has(projectId)) {
      const task = await this.queue.claimById(pending.id);
      if (!task) return 'none';
      this.runningProjects.add(projectId);
      try {
        out = await runTask({
          ...this.deps.worker,
          prisma: this.deps.prisma,
          queue: this.queue,
          memory: this.memory,
          heavyJobPollMs: this.cfg.yield.heavyJobPollMs,
        }, task);
      } finally {
        this.runningProjects.delete(projectId);
      }
    }
    // The tick never claims a rekey task: it is retried here even with the flag on.
    const retryKey = `${projectId}:${kind}`;
    if ((out === 'busy' || out === 'yielded' || out === 'retry') && (kind === 'rekey' || !this.isEnabledFor(projectId)) && !this.nowRetry.has(retryKey)) {
      const delay = out === 'busy' ? 5_000 : out === 'retry' ? this.cfg.retry.backoffMs : this.cfg.yield.heavyJobPollMs;
      const t = setTimeout(() => {
        this.nowRetry.delete(retryKey);
        void this.runNow(projectId, kind).catch(() => undefined);
      }, delay);
      t.unref?.();
      this.nowRetry.set(retryKey, t);
    }
    return out;
  }

  /**
   * Queue and start the re-key of one project (3.8). By hand only: nothing
   * enqueues `rekey` on its own. Runs in the runNow lane, flag on or off.
   */
  async enqueueRekey(projectId: number): Promise<{ taskId: number | null; action: string }> {
    const r = await this.queue.enqueue({ projectId, kind: 'rekey', priority: PRIORITY.background, payload: {} });
    void this.runNow(projectId, 'rekey').catch(err => {
      logger.warn(`[lazy-index] rekey project=${projectId} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return { taskId: r.id, action: r.action };
  }

  /** Embed stage of runIndex as a durable task (runIndex.ts setLazyEmbedEnqueuer). */
  async enqueueEmbed(projectId: number, runId: number | null): Promise<boolean> {
    if (!this.isEnabledFor(projectId)) return false;
    await this.queue.enqueue({ projectId, kind: 'embed', priority: 50, payload: { runId }, runId });
    return true;
  }

  // ── config ────────────────────────────────────────────────────────────────

  private makeQueue(): TaskQueue {
    return new TaskQueue(this.deps.prisma, {
      owner: this.owner,
      leaseMs: this.cfg.leaseMs,
      maxAttempts: this.cfg.retry.maxAttempts,
      backoffMs: this.cfg.retry.backoffMs,
      backoffCapMs: this.cfg.retry.backoffCapMs,
      heavyJobPollMs: this.cfg.yield.heavyJobPollMs,
    });
  }

  private async reloadConfig(): Promise<void> {
    try {
      const before = JSON.stringify(this.cfg);
      this.cfg = (this.deps.loadConfig ?? loadLazyConfig)();
      if (JSON.stringify(this.cfg) !== before) await this.applyConfig();
    } catch (err) {
      logger.warn(`[lazy-index] config reload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async applyConfig(): Promise<void> {
    this.memory.setThresholds(this.cfg.memory);
    setGitConcurrency(this.cfg.git.concurrency);
    this.queue = this.makeQueue();
    const want = this.cfg.enabled && (this.cfg.projects === 'all' || this.cfg.projects.length > 0);
    if (!want) {
      if (this.active) logger.info('[lazy-index] disabled: watchers and workers stopped');
      this.deactivate();
      return;
    }
    if (!this.active) await this.activate();
    else await this.syncRoots();
  }

  private async activate(): Promise<void> {
    this.active = true;
    const recovered = await this.queue.recoverStaleLeases();
    if (recovered) logger.info(`[lazy-index] recovered ${recovered} task(s) from a previous process`);
    this.watcher = new GitWatcher({
      debounceMs: this.cfg.git.debounceMs,
      inProgressPollMs: this.cfg.git.inProgressPollMs,
      pollMs: this.cfg.git.pollMs,
      maxRoots: this.cfg.git.watch.maxRoots,
      onHeadMove: rootId => { void this.handleRoot(rootId, 'event'); },
      onRootChanged: rootId => { void this.resyncRootProjects(rootId); },
      onModeChange: (rootId, mode) => {
        void this.deps.prisma.gitRoot.update({ where: { id: rootId }, data: { watchMode: mode } }).catch(() => undefined);
      },
    });
    const roots = await this.syncRoots();
    logger.info(`[lazy-index] active: projects=${this.cfg.projects === 'all' ? 'all' : this.cfg.projects.join(',')} roots=${roots.length} fds=${this.watcher.fdCount()}`);
    // Boot check (3.2.1): HEAD vs each project's base, for every root.
    for (const r of roots) void this.handleRoot(r.id, 'boot');
    this.tickTimer = setInterval(() => { void this.tick(); }, this.cfg.tickMs);
    this.tickTimer.unref?.();
  }

  private deactivate(): void {
    this.active = false;
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    this.watcher?.close();
    this.watcher = null;
    this.nextScanAt.clear();
  }

  // ── projects and roots ───────────────────────────────────────────────────

  private async projects(): Promise<ProjectRow[]> {
    const where = this.cfg.projects === 'all' ? {} : { id: { in: this.cfg.projects } };
    return this.deps.prisma.fantomProject.findMany({
      where,
      select: { id: true, name: true, path: true, language: true, parserType: true, keyScheme: true, indexMode: true },
    });
  }

  /** Resolve roots for every allowed project and point the watcher at them. */
  private async syncRoots(): Promise<GitRoot[]> {
    const projects = await this.projects();
    const ids = new Set<number>();
    if (this.cfg.git.enabled && await isGitAvailable()) {
      for (const p of projects) {
        try {
          const r = await syncProjectRoots(this.deps.prisma, p, { discoverNested: this.cfg.git.discoverNestedRoots });
          for (const root of r.roots) ids.add(root.id);
        } catch (err) {
          logger.warn(`[lazy-index] root resolve failed for ${p.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    const roots = ids.size ? await this.deps.prisma.gitRoot.findMany({ where: { id: { in: [...ids] } } }) : [];
    this.watcher?.sync(roots.map(r => ({ id: r.id, root: r.root, gitDir: r.gitDir })));
    // Stagger the first scans: one every 10 s.
    const now = Date.now();
    projects.forEach((p, i) => { if (!this.nextScanAt.has(p.id)) this.nextScanAt.set(p.id, now + 10_000 * (i + 1)); });
    for (const id of [...this.nextScanAt.keys()]) if (!projects.some(p => p.id === id)) this.nextScanAt.delete(id);
    return roots;
  }

  private async resyncRootProjects(rootId: number): Promise<void> {
    if (!this.active) return;
    logger.info(`[lazy-index] .git changed under root ${rootId}: re-resolving`);
    await this.syncRoots();
  }

  // ── git events ───────────────────────────────────────────────────────────

  /** Serialise per root: one diff at a time for a root. */
  handleRoot(rootId: number, why: 'event' | 'boot' | 'retry'): Promise<void> {
    const prev = this.rootChains.get(rootId) ?? Promise.resolve();
    const next = prev.then(() => this.processRoot(rootId, why)).catch(err => {
      logger.warn(`[lazy-index] root ${rootId} (${why}) failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.rootChains.set(rootId, next);
    return next;
  }

  private async processRoot(rootId: number, why: string): Promise<void> {
    if (!this.active) return;
    const prisma = this.deps.prisma;
    const root = await prisma.gitRoot.findUnique({ where: { id: rootId } });
    if (!root) return;
    const allowed = new Set((await this.projects()).map(p => p.id));
    const states = await prisma.projectGitState.findMany({
      where: { rootId },
      include: { project: { select: { id: true, name: true, path: true, language: true, parserType: true, keyScheme: true } } },
    });
    const inputs: GitProjectInput[] = [];
    const byId = new Map<number, ProjectScanInfo>();
    for (const s of states) {
      if (!allowed.has(s.projectId)) continue;
      byId.set(s.projectId, s.project);
      inputs.push({
        projectId: s.projectId,
        projectPath: s.project.path,
        projectReal: realpath(s.project.path),
        lastIndexedCommit: s.lastIndexedCommit,
        scanner: scannerFor(s.project.language),
      });
    }
    if (inputs.length === 0) return;
    const allRoots = await prisma.gitRoot.findMany({ select: { root: true } });
    const res = await computeRootChanges(root, allRoots, inputs, {
      reflogTail: this.cfg.git.reflogTail,
      maxCommitsPerRun: this.cfg.git.maxCommitsPerRun,
      retries: this.cfg.git.retries,
      retryMs: this.cfg.git.retryMs,
    });
    await prisma.gitRoot.update({
      where: { id: rootId },
      data: {
        lastHeadSeen: res.toCommit ?? root.lastHeadSeen,
        lastReflogIdent: res.reflogIdent,
        lastHeadMove: JSON.stringify(res.headMove),
        gitError: res.error ?? null,
      },
    });
    for (const pc of res.projects) {
      const project = byId.get(pc.projectId)!;
      switch (pc.kind) {
        case 'unchanged':
          await prisma.projectGitState.update({
            where: { projectId_rootId: { projectId: pc.projectId, rootId } },
            data: { lastIndexedBranch: pc.branch },
          });
          break;
        case 'in-progress':
          setTimeout(() => { void this.handleRoot(rootId, 'retry'); }, this.cfg.git.inProgressPollMs).unref?.();
          break;
        case 'seed':
        case 'sha-scan':
          // Never indexed through git, or the base is gone: the scan decides,
          // then the base becomes HEAD (3.2.2 steps 2-3).
          await this.scanAndEnqueue(project, pc.kind === 'seed' ? 'mtime' : 'sha', { rootId, git: pc.git });
          break;
        case 'changes': {
          const cs = pc.changeSet;
          if (changeCount(cs) === 0) {
            // Commits that touched no source file of this project: move the base.
            await this.moveBase(pc.projectId, rootId, cs.git!);
            break;
          }
          await this.enqueueChangeSet(cs, project.name);
          break;
        }
      }
    }
    if (why !== 'event') logger.debug?.(`[lazy-index] root ${root.root} checked (${why}) head=${res.toCommit?.slice(0, 8) ?? '-'}`);
  }

  private async moveBase(projectId: number, rootId: number, git: GitContext): Promise<void> {
    await this.deps.prisma.projectGitState.updateMany({
      where: { projectId, rootId },
      data: { lastIndexedCommit: git.toCommit, lastIndexedBranch: git.branch },
    });
  }

  private async enqueueChangeSet(cs: ChangeSet, projectName: string): Promise<void> {
    const prisma = this.deps.prisma;
    const projectFiles = await prisma.indexedFile.count({ where: { projectId: cs.projectId } });
    const primary = loadPrimaryProject();
    const plan = planForChangeSet(cs, {
      isPrimary: !!primary && primary.project === projectName,
      projectFiles,
      maxChangedShareForIncremental: this.cfg.maxChangedShareForIncremental,
      maxFilesPerDiff: this.cfg.git.maxFilesPerDiff,
      rewriteAsSwitchFiles: this.cfg.git.rewriteAsSwitchFiles,
    });
    if (!plan) return;
    const r = await this.queue.enqueue({ projectId: cs.projectId, kind: plan.kind, priority: plan.priority, payload: plan.payload });
    logger.info(
      `[lazy-index] ${cs.source} change set project=${projectName}: +${cs.added.length} ~${cs.modified.length} -${cs.removed.length} R${cs.renamed.length}` +
      `${cs.git ? ` ${cs.git.headMove.kind} ${cs.git.fromCommit?.slice(0, 8) ?? 'seed'}..${cs.git.toCommit.slice(0, 8)}` : ''}` +
      ` → ${plan.kind} p${plan.priority} task ${r.id ?? '-'} (${r.action})`,
    );
  }

  // ── scans ────────────────────────────────────────────────────────────────

  /**
   * One scan of a project; enqueue what it finds. `gitHint` comes from a
   * seed / missing-base event; otherwise a git project gets a context with
   * from = to = HEAD of the root that owns the project path.
   */
  private async scanAndEnqueue(
    project: ProjectScanInfo,
    source: ChangeSource,
    gitHint?: { rootId: number; git: GitContext },
  ): Promise<void> {
    if (this.runningProjects.has(project.id)) return; // the next tick or event retries
    const prisma = this.deps.prisma;
    const shaAlways = this.cfg.scan.shaAlwaysProjects.includes(project.id);
    const cs = await scanProject(prisma, project, { source: shaAlways ? 'sha' : source, pageRows: this.cfg.scan.pageRows });
    let ctx = gitHint;
    if (!ctx) ctx = await this.headContext(project);
    if (ctx) { cs.rootId = ctx.rootId; cs.git = ctx.git; }
    await prisma.projectGitState.updateMany({ where: { projectId: project.id }, data: { lastScanAt: new Date() } });
    if (changeCount(cs) === 0) {
      // Baseline (section 5): nothing to do → the base becomes HEAD.
      if (ctx) await this.baseline(project.id);
      return;
    }
    await this.enqueueChangeSet(cs, project.name);
  }

  /** Every root of the project with a NULL base and a known HEAD gets that HEAD. */
  private async baseline(projectId: number): Promise<void> {
    const states = await this.deps.prisma.projectGitState.findMany({ where: { projectId, lastIndexedCommit: null }, include: { root: true } });
    for (const s of states) {
      const head = await readHead(s.root.root);
      if (head) {
        await this.deps.prisma.projectGitState.update({
          where: { projectId_rootId: { projectId, rootId: s.rootId } },
          data: { lastIndexedCommit: head.sha, lastIndexedBranch: head.branch },
        });
      }
    }
  }

  private async headContext(project: ProjectScanInfo): Promise<{ rootId: number; git: GitContext } | undefined> {
    const states = await this.deps.prisma.projectGitState.findMany({ where: { projectId: project.id }, include: { root: true } });
    if (states.length === 0) return undefined;
    const real = realpath(project.path);
    const owner = ownerOf(real, states.map(s => s.root)) ?? states.map(s => s.root).find(r => isUnder(r.root, real));
    if (!owner) return undefined;
    const head = await readHead(owner.root);
    if (!head) return undefined;
    return {
      rootId: owner.id,
      git: {
        root: owner.root, gitDir: owner.gitDir, gitCommonDir: owner.gitCommonDir,
        fromCommit: head.sha, toCommit: head.sha, branch: head.branch,
        headMove: { kind: 'none', reflog: '', linear: true }, dirty: false, commits: [],
      },
    };
  }

  private dueScans(projects: ProjectRow[]): void {
    const now = Date.now();
    for (const p of projects) {
      if (this.scansRunning >= this.cfg.scan.concurrency) return;
      const due = this.nextScanAt.get(p.id) ?? now;
      if (due > now || this.runningProjects.has(p.id)) continue;
      const interval = p.indexMode === 'git' ? this.cfg.scan.gitIntervalMs : this.cfg.scan.intervalMs;
      this.nextScanAt.set(p.id, now + interval);
      this.scansRunning++;
      void (async () => {
        try {
          // A safety-net scan of a git project also re-discovers nested roots (3.2.11).
          if (p.indexMode === 'git') await this.syncRoots();
          await this.scanAndEnqueue(p, 'mtime');
        } catch (err) {
          logger.warn(`[lazy-index] scan of ${p.name} failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          this.scansRunning--;
        }
      })();
    }
  }

  // ── dispatch ─────────────────────────────────────────────────────────────

  async tick(): Promise<void> {
    if (!this.active) return;
    const mem = this.memory.check();
    const now = Date.now();
    if (now - this.lastTickLog > 600_000) {
      this.lastTickLog = now;
      const counts = await this.queue.counts().catch(() => ({}));
      logger.info(`[lazy-index] tick: queue=${JSON.stringify(counts)} rss=${mem.sample.rssMb}MB heap=${mem.sample.heapMb}MB fds=${this.watcher?.fdCount() ?? 0}${mem.paused ? ' PAUSED(memory)' : ''}`);
    }
    try {
      const projects = await this.projects();
      this.dueScans(projects);
      await this.dueGc(projects);
    } catch (err) {
      logger.warn(`[lazy-index] scan scheduling failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (mem.paused) return; // claim nothing while above the line (3.10)
    if (this.parseBusy < Math.max(1, this.cfg.workers.parse)) void this.dispatch(['parse', 'full-reindex'], 'parse');
    if (this.embedBusy < Math.max(1, this.cfg.workers.embed)) void this.dispatch(['embed', 'vector-gc', 'cache-prune'], 'embed');
  }

  /**
   * Phase 4 (3.5): every `embedPatch.gcIntervalMs` a background `vector-gc`
   * per project and one `cache-prune` (on the first project's row). Both
   * yield while a heavy job runs (worker back-pressure).
   */
  private async dueGc(projects: ProjectRow[]): Promise<void> {
    const ep = this.cfg.embedPatch;
    if (!ep?.enabled || projects.length === 0) return;
    const now = Date.now();
    if (now < this.nextGcAt) return;
    const first = this.nextGcAt === 0;
    this.nextGcAt = now + Math.max(60_000, ep.gcIntervalMs);
    if (first) return; // not at boot: the first round waits one interval
    for (const p of projects) {
      await this.queue.enqueue({ projectId: p.id, kind: 'vector-gc', priority: PRIORITY.background, payload: {} });
    }
    await this.queue.enqueue({ projectId: projects[0].id, kind: 'cache-prune', priority: PRIORITY.background, payload: {} });
  }

  private async dispatch(kinds: Array<'parse' | 'full-reindex' | 'embed' | 'vector-gc' | 'cache-prune'>, lane: 'parse' | 'embed'): Promise<void> {
    if (lane === 'parse') this.parseBusy++; else this.embedBusy++;
    try {
      const task = await this.queue.claim(kinds);
      if (!task) return;
      if (lane === 'parse') this.runningProjects.add(task.projectId);
      try {
        await runTask({
          ...this.deps.worker,
          prisma: this.deps.prisma,
          queue: this.queue,
          memory: this.memory,
          heavyJobPollMs: this.cfg.yield.heavyJobPollMs,
        }, task);
      } finally {
        if (lane === 'parse') this.runningProjects.delete(task.projectId);
      }
    } catch (err) {
      logger.warn(`[lazy-index] ${lane} dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (lane === 'parse') this.parseBusy--; else this.embedBusy--;
    }
  }
}

function realpath(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}

async function readHead(root: string): Promise<{ sha: string; branch: string | null } | null> {
  const { git } = await import('./gitExec.js');
  try {
    const sha = (await git(root, ['rev-parse', '--verify', '-q', 'HEAD'], { retries: 1 })).stdout.trim();
    if (!sha) return null;
    const b = await git(root, ['symbolic-ref', '-q', '--short', 'HEAD'], { okCodes: [1], retries: 1 });
    return { sha, branch: b.code === 0 ? b.stdout.trim() || null : null };
  } catch {
    return null;
  }
}
