/**
 * Tiny in-memory bus for the boot-time auto-embedding pipeline. The pipeline
 * iterates projects → buildProjectEmbeddings; this module exposes its
 * current state so the dashboard's home-page widget can render it as
 * "indexing now" alongside the legacy in-process indexer and the new
 * background re-embed jobs.
 */

export type AutoPipelinePhase = 'idle' | 'waiting-for-sidecar' | 'running' | 'done';

export interface FailedProject {
  projectId: number;
  projectName: string;
  error: string;
  at: string;
}

export type AutoPipelineEventKind = 'start' | 'done' | 'skipped' | 'failed' | 'phase' | 'stale';

export interface AutoPipelineEvent {
  ts: string;
  kind: AutoPipelineEventKind;
  projectId?: number;
  projectName?: string;
  message: string;
  sidecar?: string;
}

export interface AutoPipelineStatus {
  running: boolean;
  currentPhase: AutoPipelinePhase;
  totalProjects: number;
  doneProjects: number;
  skipped: number;
  currentProjectId?: number;
  currentProjectName?: string;
  currentNodes?: number;
  /** Sidecar currently doing the embedding for the active project. */
  currentSidecarName?: string;
  currentSidecarHost?: string;
  currentSidecarModel?: string;
  totalProcessed: number;
  totalErrors: number;
  failedProjects: FailedProject[];
  /** When in `waiting-for-sidecar`, the timeout deadline (ISO). */
  sidecarWaitDeadline?: string;
  /** When the wait resolved successfully (true) or timed out (false). */
  sidecarReady?: boolean;
  startedAt?: string;
  finishedAt?: string;
  /** Bounded ring buffer of recent lifecycle events (oldest first). */
  recentEvents?: AutoPipelineEvent[];
  /** Last time doneProjects/totalProcessed advanced (ISO). */
  lastProgressAt?: string;
  /** ms since lastProgressAt while running; undefined when idle/done. */
  staleMs?: number;
  /** Human phase for the dashboard header: 'idle' | 'running' | 'embedding (project N)' |
   *  're-embed (full|project N)' (the latter is overlaid by the admin route from reembedJobs). */
  phaseLabel?: string;
  /** buildProjectEmbeddings runs in flight right now (pipeline-owned or standalone). */
  activeRuns?: EmbedRunSnapshot[];
}

export interface EmbedRunSnapshot {
  projectId: number;
  projectName?: string;
  total: number;
  processed: number;
  errors: number;
  startedAt: string;
  sidecar?: string;
  /** true when the auto pipeline loop owns this run (it already emits start/done). */
  pipelineOwned: boolean;
}

const state: AutoPipelineStatus = {
  running: false,
  currentPhase: 'idle',
  totalProjects: 0,
  doneProjects: 0,
  skipped: 0,
  totalProcessed: 0,
  totalErrors: 0,
  failedProjects: [],
};

const MAX_FAILED = 100;

// ---------------------------------------------------------------------------
// Recent-events ring buffer + progress tracking.
//
// Deliberately independent of the per-run `state` reset (autoPipelineStarting /
// autoPipelineWaitingForSidecar wipe doneProjects/failedProjects). The "stale
// for Nm, restarting" story spans a restart, so the event log must survive a
// new run kicking off. lastProgressAtMs is kept as a number for cheap diffing.
// ---------------------------------------------------------------------------
const MAX_EVENTS = 200;
const recentEvents: AutoPipelineEvent[] = [];
let lastProgressAtMs: number | undefined;

function pushEvent(
  kind: AutoPipelineEventKind,
  message: string,
  extra?: { projectId?: number; projectName?: string; sidecar?: string },
): void {
  recentEvents.push({
    ts: new Date().toISOString(),
    kind,
    message,
    projectId: extra?.projectId,
    projectName: extra?.projectName,
    sidecar: extra?.sidecar,
  });
  if (recentEvents.length > MAX_EVENTS) {
    recentEvents.splice(0, recentEvents.length - MAX_EVENTS);
  }
}

function markProgress(): void {
  lastProgressAtMs = Date.now();
}

export function getAutoPipelineStatus(): AutoPipelineStatus {
  const activeRuns = [...embedRuns.values()].map(r => ({ ...r }));
  const standalone = activeRuns.filter(r => !r.pipelineOwned);
  const busy = state.running || activeRuns.length > 0;
  let phaseLabel: string = state.currentPhase;
  if (!state.running && standalone.length > 0) {
    const r = standalone[0];
    phaseLabel = `embedding (project ${r.projectId}${standalone.length > 1 ? ` +${standalone.length - 1}` : ''})`;
  }
  return {
    ...state,
    // A standalone run (build-missing, reindexChangedFiles, MCP tool) is real
    // embedding work: surface it as running with its own counts so the
    // dashboard never shows "idle · 0/0" while the GPU is busy.
    running: busy,
    ...(standalone.length > 0 && !state.running
      ? {
          totalProjects: standalone.length,
          doneProjects: 0,
          currentProjectId: standalone[0].projectId,
          currentProjectName: standalone[0].projectName,
          currentNodes: standalone[0].total,
          currentSidecarName: standalone[0].sidecar ?? state.currentSidecarName,
        }
      : {}),
    failedProjects: [...state.failedProjects],
    recentEvents: [...recentEvents],
    lastProgressAt: lastProgressAtMs ? new Date(lastProgressAtMs).toISOString() : undefined,
    staleMs: busy && lastProgressAtMs ? Date.now() - lastProgressAtMs : undefined,
    phaseLabel,
    activeRuns,
  };
}

// ---------------------------------------------------------------------------
// Per-run tracking for buildProjectEmbeddings (SemanticSearchService).
//
// The pipeline loop (index.ts boot pipeline, /vectors/auto-embed/start) emits
// start/done per project itself. buildProjectEmbeddings is ALSO called outside
// that loop (build-missing, reindexChangedFiles, MCP buildProjectEmbeddings)
// and those runs were invisible to the dashboard. These hooks record every run;
// when the pipeline owns the current project we only track progress (no
// duplicate start/done events or doneProjects double counting).
// ---------------------------------------------------------------------------
const embedRuns = new Map<number, EmbedRunSnapshot>();

export function embedRunStarted(projectId: number, total: number, projectName?: string, sidecar?: string): void {
  const pipelineOwned = state.running && state.currentProjectId === projectId;
  embedRuns.set(projectId, {
    projectId,
    projectName: projectName ?? (pipelineOwned ? state.currentProjectName : undefined),
    total, processed: 0, errors: 0,
    startedAt: new Date().toISOString(),
    sidecar: sidecar ?? (pipelineOwned ? state.currentSidecarName : undefined),
    pipelineOwned,
  });
  markProgress();
  if (!pipelineOwned) {
    pushEvent('start', `embedding project #${projectId}${projectName ? ` ${projectName}` : ''} (${total} nodes)`, { projectId, projectName, sidecar });
  }
}

export function embedRunProgress(projectId: number, processed: number, errors: number, sidecar?: string): void {
  const r = embedRuns.get(projectId);
  if (!r) return;
  r.processed = processed;
  r.errors = errors;
  if (sidecar) r.sidecar = sidecar;
  markProgress();
}

export function embedRunFinished(projectId: number, processed: number, errors: number): void {
  const r = embedRuns.get(projectId);
  embedRuns.delete(projectId);
  markProgress();
  if (r && !r.pipelineOwned) {
    pushEvent(errors > 0 && processed === 0 ? 'failed' : 'done',
      `project #${projectId}${r.projectName ? ` ${r.projectName}` : ''} done: +${processed} vectors${errors ? `, ${errors} errors` : ''}`,
      { projectId, projectName: r.projectName, sidecar: r.sidecar });
  }
}

export function autoPipelineWaitingForSidecar(totalProjects: number, timeoutMs: number): void {
  state.running = true;
  state.currentPhase = 'waiting-for-sidecar';
  state.totalProjects = totalProjects;
  state.doneProjects = 0;
  state.skipped = 0;
  state.totalProcessed = 0;
  state.totalErrors = 0;
  state.failedProjects = [];
  state.startedAt = new Date().toISOString();
  state.finishedAt = undefined;
  // Strict sidecar mode waits forever (timeoutMs = Infinity); an infinite
  // date throws RangeError "Invalid time value" and killed the whole boot
  // pipeline before any project embedded (2026-09-14).
  state.sidecarWaitDeadline = Number.isFinite(timeoutMs) ? new Date(Date.now() + timeoutMs).toISOString() : undefined;
  state.sidecarReady = undefined;
  markProgress();
  pushEvent('phase', `waiting for embedding sidecar (${totalProjects} projects queued)`);
}

export function autoPipelineSidecarReady(ready: boolean): void {
  state.sidecarReady = ready;
}

export function autoPipelineStarting(totalProjects: number): void {
  state.running = true;
  state.currentPhase = 'running';
  state.totalProjects = totalProjects;
  state.doneProjects = 0;
  state.skipped = 0;
  state.totalProcessed = 0;
  state.totalErrors = 0;
  state.failedProjects = [];
  state.startedAt = state.startedAt ?? new Date().toISOString();
  state.finishedAt = undefined;
  markProgress();
  pushEvent('phase', `auto-embed pipeline started (${totalProjects} projects)`);
}

export function autoPipelineProjectStarting(
  projectId: number,
  projectName: string,
  nodes: number,
  sidecar?: { name?: string; host?: string; model?: string },
): void {
  state.currentProjectId = projectId;
  state.currentProjectName = projectName;
  state.currentNodes = nodes;
  state.currentSidecarName = sidecar?.name;
  state.currentSidecarHost = sidecar?.host;
  state.currentSidecarModel = sidecar?.model;
  pushEvent('start', `embedding ${projectName} (#${projectId})`, {
    projectId,
    projectName,
    sidecar: sidecar?.name,
  });
}

export function autoPipelineProjectDone(processed: number, errors: number): void {
  state.doneProjects += 1;
  state.totalProcessed += processed;
  state.totalErrors += errors;
  markProgress();
  pushEvent('done', `${state.currentProjectName ?? 'project'} done: +${processed} vectors`, {
    projectId: state.currentProjectId,
    projectName: state.currentProjectName,
    sidecar: state.currentSidecarName,
  });
}

export function autoPipelineProjectSkipped(projectId: number, projectName: string): void {
  state.doneProjects += 1;
  state.skipped += 1;
  state.currentProjectId = projectId;
  state.currentProjectName = projectName;
  markProgress();
  pushEvent('skipped', `${projectName} (#${projectId}) skipped`, { projectId, projectName });
}

export function autoPipelineProjectFailed(projectId: number, projectName: string, error: string): void {
  state.doneProjects += 1;
  state.totalErrors += 1;
  state.failedProjects.push({ projectId, projectName, error, at: new Date().toISOString() });
  // Cap to avoid unbounded growth on a pathological run.
  if (state.failedProjects.length > MAX_FAILED) {
    state.failedProjects.splice(0, state.failedProjects.length - MAX_FAILED);
  }
  markProgress();
  pushEvent('failed', `${projectName} (#${projectId}) failed: ${error}`, { projectId, projectName });
}

/** The boot pipeline threw: leave a visible 'done' state with the error
 *  instead of a phase stuck at 'waiting-for-sidecar' (which made the home
 *  page say "Waiting for embedding sidecar" and the retry watchdog re-fire
 *  the starter every 35 s). */
export function autoPipelineFailed(message: string): void {
  state.currentPhase = 'done';
  state.finishedAt = new Date().toISOString();
  state.sidecarReady = undefined;
  pushEvent('failed', `pipeline failed: ${message}`);
}

export function autoPipelineFinished(): void {
  state.running = false;
  state.currentPhase = 'done';
  state.currentProjectId = undefined;
  state.currentProjectName = undefined;
  state.currentNodes = undefined;
  state.finishedAt = new Date().toISOString();
  pushEvent('phase', `pipeline finished: ${state.doneProjects}/${state.totalProjects} done, +${state.totalProcessed} vectors, ${state.totalErrors} errors`);
}

// ============================================
// Sidecar-detect watchdog
// ============================================
// When the boot-time gate parks the pipeline in `waiting-for-sidecar`, we
// don't want the operator to have to click "Re-trigger now" once the
// sidecar finally registers. The watchdog polls every N seconds and, on
// the first observation that an embedding-capable sidecar is present,
// invokes the registered starter callback. The starter is registered by
// the admin routes module (which knows how to actually run the auto-embed
// pipeline) at boot, so this file stays free of pipeline knowledge.

export type AutoEmbedStarter = () => Promise<void> | void;
let registeredStarter: AutoEmbedStarter | null = null;

/** Called once at boot by the routes module so the watchdog can fire the
 *  same code path the manual "Re-trigger now" button uses. */
export function registerAutoEmbedStarter(fn: AutoEmbedStarter): void {
  registeredStarter = fn;
}

let watchdogTimer: NodeJS.Timeout | null = null;
let lastTriggerAt = 0;
const MIN_TRIGGER_GAP_MS = 30_000;
let consecutiveDetected = 0;
const REQUIRED_HITS = 2;

/** Start the periodic watchdog. Idempotent — calling twice is a no-op. */
export function startSidecarRetryWatchdog(intervalMs = 5_000): void {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    void tickSidecarRetryWatchdog();
  }, intervalMs);
  // Don't keep the event loop alive just for this poll.
  watchdogTimer.unref?.();
}

export function stopSidecarRetryWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

// ============================================
// Embed-missing watchdog
// ============================================
// Different from the sidecar watchdog above: this one runs when the
// pipeline is in `idle` or `done` state and detects projects whose
// embedded-vector count is below their node count. If at least one
// embedding-capable sidecar is registered AND no other run is in flight,
// it fires the same starter that the manual "Embed Missing" / "Resume
// Embed" button uses. Spares the operator the repeated manual click.

let missingChecker: (() => Promise<{ hasMissing: boolean; missingCount: number; sidecarReady: boolean }>) | null = null;

/** Called once at boot by the routes module so the watchdog can poll
 *  the prisma + LanceDB layers without importing them itself. */
export function registerEmbedMissingChecker(
  fn: () => Promise<{ hasMissing: boolean; missingCount: number; sidecarReady: boolean }>,
): void {
  missingChecker = fn;
}

let embedMissingTimer: NodeJS.Timeout | null = null;
let embedMissingLastTriggerAt = 0;
const EMBED_MISSING_GAP_MS = 5 * 60_000;        // don't re-trigger for 5 min after a run kicks off
let embedMissingConsecutiveHits = 0;
const EMBED_MISSING_REQUIRED_HITS = 2;

export function startEmbedMissingWatchdog(intervalMs = 60_000): void {
  if (embedMissingTimer) return;
  embedMissingTimer = setInterval(() => { void tickEmbedMissingWatchdog(); }, intervalMs);
  embedMissingTimer.unref?.();
}

export function stopEmbedMissingWatchdog(): void {
  if (embedMissingTimer) {
    clearInterval(embedMissingTimer);
    embedMissingTimer = null;
  }
}

export async function tickEmbedMissingWatchdog(): Promise<void> {
  // Don't interrupt a run already in progress.
  if (state.currentPhase === 'running' || state.currentPhase === 'waiting-for-sidecar') {
    embedMissingConsecutiveHits = 0;
    return;
  }
  if (!missingChecker || !registeredStarter) return;

  let report;
  try { report = await missingChecker(); } catch { return; }
  if (!report.hasMissing || !report.sidecarReady) {
    embedMissingConsecutiveHits = 0;
    return;
  }
  embedMissingConsecutiveHits += 1;
  if (embedMissingConsecutiveHits < EMBED_MISSING_REQUIRED_HITS) return;
  if (Date.now() - embedMissingLastTriggerAt < EMBED_MISSING_GAP_MS) return;

  embedMissingLastTriggerAt = Date.now();
  embedMissingConsecutiveHits = 0;
  const idleMin = lastProgressAtMs ? Math.round((Date.now() - lastProgressAtMs) / 60_000) : null;
  pushEvent(
    'stale',
    idleMin != null
      ? `stale for ${idleMin}m, ${report.missingCount} missing vectors — restarting embed`
      : `${report.missingCount} missing vectors detected — restarting embed`,
  );
  try { await registeredStarter(); } catch { /* operator can retry manually */ }
}

/** Internal: one tick of the watchdog. Exported for tests / forced runs. */
export async function tickSidecarRetryWatchdog(): Promise<void> {
  // Only act while we're actually parked at the gate. Other phases
  // (running, done, idle) should be left alone.
  if (state.currentPhase !== 'waiting-for-sidecar') {
    consecutiveDetected = 0;
    return;
  }
  if (!registeredStarter) return;

  // Debounce: require two consecutive hits before triggering, so a
  // briefly-flapping sidecar registration doesn't kick off a doomed
  // pipeline run.
  let detected = false;
  try {
    const { getSidecarForCapability } = await import('../sidecars/registry.js');
    detected = getSidecarForCapability('embedding') !== null;
    if (!detected) {
      // Under "OpenRouter only" no local sidecar will ever register — the GPUs
      // are excluded by policy — so a watchdog waiting for one keeps the
      // pipeline parked forever on a fleet that is working as configured. The
      // cloud pool is verified where it is used, not here.
      const { localEmbedderRequired } = await import('./providers/embeddingProvider.js');
      if (!(await localEmbedderRequired('code'))) detected = true;
    }
  } catch { /* registry unavailable; skip this tick */ }

  if (!detected) {
    consecutiveDetected = 0;
    return;
  }
  consecutiveDetected += 1;
  if (consecutiveDetected < REQUIRED_HITS) return;

  // Throttle so we don't spam the starter when the registry flips
  // available → unavailable → available repeatedly.
  if (Date.now() - lastTriggerAt < MIN_TRIGGER_GAP_MS) return;
  lastTriggerAt = Date.now();
  consecutiveDetected = 0;
  pushEvent('stale', 'embedding sidecar came online — starting parked pipeline');
  try {
    await registeredStarter();
  } catch { /* swallow — operator can retry manually */ }
}
