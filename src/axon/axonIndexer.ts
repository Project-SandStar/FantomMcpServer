/**
 * Axon indexer: parse `proj/` → embedding text → sidecar fleet → `axon_vectors`.
 *
 * - Embeds through the EXISTING provider layer
 *   (`selectAllEmbeddingProvidersWithCloud`) with the Code Search model, so the
 *   pool obeys the same code-embedding routing policy `code_vectors` is built
 *   under — including "OpenRouter only", where the GPUs are excluded and the
 *   verified cloud providers ARE the fleet. Providers are fanned out
 *   round-robin, a faulted provider is skipped and its batch retried on
 *   another.
 * - Per-project status is persisted to `.cache/axon-embedding-meta.json`.
 * - Jobs are in-memory (same shape as the re-embed jobs) and listed by
 *   `GET /admin/axon/jobs`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../utils/index.js';
import { getCachePath } from '../utils/installRoot.js';
import { waitForHeavyJob, setHeavyJobProgress, type HeavyJobHolder } from '../embedding/embedGate.js';
import type { EmbedCache } from '../embedding/embedCache.js';
import {
  selectAllEmbeddingProvidersWithCloud,
  embedBatchFanout, type EmbeddingProvider,
} from '../embedding/providers/embeddingProvider.js';
import { getAxonSettings, getAxonProjDir, getAxonLibraryDir, resolveAxonEmbeddingModel } from './axonSettings.js';
import { initAxonGrammar, axonGrammarStatus } from './axonTreeSitter.js';
import {
  buildAxonEmbeddingChunksFor,
  type AxonFunctionRecord, type AxonProjectRef, type AxonRecordSource,
} from './axonProjParser.js';
import { scanAllAxonProjects, parseAnyAxonProject, isLibraryProjectId } from './axonLibraryParser.js';
import { AXON_EMBED_TEXT_VERSION, type AxonEmbeddingChunk } from './axonEmbeddingText.js';
import {
  ensureAxonTableForWrite, deleteAxonProjectVectors, deleteAxonFunctionVectors, countAxonVectorsByProject,
  listAxonVectorIds, getAxonTableStats, type AxonVectorRow,
} from './axonLance.js';

const logger = createLogger('axon-indexer');

// ── Persisted meta ──────────────────────────────────────────────────────────

export interface AxonProjectMeta {
  projectId: string;
  source?: AxonRecordSource;
  instance: string;
  project: string;
  functionsFound: number;
  /** Functions with at least one vector row. */
  vectorsWritten: number;
  /** Total rows (chunks) written. */
  rowsWritten?: number;
  model: string;
  dimensions: number;
  /** Layout version of src/axon/axonEmbeddingText.ts used for this run. */
  embedTextVersion?: number;
  lastRun: string;
  durationMs?: number;
  errors: string[];
  /** function name → content hash at last successful embed */
  hashes?: Record<string, string>;
}

interface AxonMeta {
  version: 1;
  projects: Record<string, AxonProjectMeta>;
}

function metaPath(): string {
  return getCachePath('axon-embedding-meta.json');
}

export function readAxonMeta(): AxonMeta {
  try {
    const p = metaPath();
    if (fs.existsSync(p)) {
      const m = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (m && m.projects) return m as AxonMeta;
    }
  } catch { /* fall through */ }
  return { version: 1, projects: {} };
}

function writeAxonMeta(meta: AxonMeta): void {
  const p = metaPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, p);
}

// ── Jobs ────────────────────────────────────────────────────────────────────

export interface AxonJob {
  id: string;
  kind: 'axon-index';
  scope: { projectId?: string; source?: AxonRecordSource | 'all'; force: boolean };
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  projectsTotal: number;
  projectsDone: number;
  currentProject?: string;
  functionsTotal: number;
  functionsEmbedded: number;
  model: string;
  dimensions: number;
  providers: string[];
  errors: Array<{ projectId?: string; message: string; at: string }>;
  cancelRequested?: boolean;
  /** While `queued`: the heavy job we are waiting for (code re-embed / forced reindex). */
  waitingFor?: HeavyJobHolder | null;
  /** Phase 4 (3.12): unchanged projects skipped without a provider call. */
  projectsSkipped?: number;
  functionsSkipped?: number;
  functionsDeleted?: number;
  /** Per-project outcome, live (Axon page). */
  projectStats?: AxonProjectRunStat[];
}

export interface AxonProjectRunStat {
  projectId: string;
  status: 'skipped' | 'embedding' | 'done' | 'error';
  functions: number;
  skipped: number;
  embedded: number;
  deleted: number;
  /** Texts the provider embedded (embed_cache misses). */
  providerTexts: number;
  errors: number;
}

/** What changed in one project since its meta entry (3.12 item 1). */
export interface AxonProjectPlan {
  /** Functions to (re-)embed. */
  changed: AxonFunctionRecord[];
  /** Function names whose rows go: changed + removed. */
  deleteNames: string[];
  unchanged: number;
  removed: string[];
  /** Nothing to do. */
  skip: boolean;
  /** Model, dims or text layout differ: every function is changed. */
  full: boolean;
}

/**
 * Compare parsed records with the meta entry: per-function hash plus
 * AXON_EMBED_TEXT_VERSION, model and dims. `vectorIds` (optional) are the
 * node ids that have rows; a function without one counts as changed.
 */
export function planAxonProject(
  records: AxonFunctionRecord[],
  pm: AxonProjectMeta | undefined,
  model: string,
  dimensions: number,
  opts: { force?: boolean; vectorIds?: Set<string> } = {},
): AxonProjectPlan {
  const full = !!opts.force || !pm || !pm.hashes || pm.model !== model || pm.dimensions !== dimensions
    || pm.embedTextVersion !== AXON_EMBED_TEXT_VERSION;
  const old = full ? {} : pm!.hashes!;
  const names = new Set(records.map(r => r.name));
  const changed = records.filter(r => old[r.name] !== r.hash || (opts.vectorIds !== undefined && !opts.vectorIds.has(r.id)));
  const removed = Object.keys(pm?.hashes ?? {}).filter(n => !names.has(n));
  return {
    changed,
    deleteNames: [...new Set([...changed.map(r => r.name), ...removed])],
    unchanged: records.length - changed.length,
    removed,
    skip: !full && changed.length === 0 && removed.length === 0,
    full,
  };
}

/**
 * Cheap boot scan (3.12 item 2): parse every project and compare hashes with
 * the meta file. No provider, no vector table, no heavy-job lock.
 */
export async function scanAxonChanges(source: AxonRecordSource | 'all' = 'all'): Promise<{ changed: string[]; projects: number }> {
  await initAxonGrammar();
  const { model, dimensions } = resolveAxonEmbeddingModel();
  const meta = readAxonMeta();
  const refs = scanAllAxonProjects(source);
  const changed: string[] = [];
  for (const ref of refs) {
    try {
      if (!planAxonProject(parseAnyAxonProject(ref), meta.projects[ref.projectId], model, dimensions).skip) changed.push(ref.projectId);
    } catch {
      changed.push(ref.projectId);
    }
  }
  return { changed, projects: refs.length };
}

/** embed_cache key space for Axon text (kept apart from code text versions). */
const AXON_CACHE_TEXT_VERSION = 1000 + AXON_EMBED_TEXT_VERSION;

const jobs = new Map<string, AxonJob>();
let activeJobId: string | null = null;

export function listAxonJobs(): AxonJob[] {
  return [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 50);
}
export function getAxonJob(id: string): AxonJob | undefined { return jobs.get(id); }
export function getActiveAxonJob(): AxonJob | undefined {
  return activeJobId ? jobs.get(activeJobId) : undefined;
}
export function cancelAxonJob(id: string): AxonJob | undefined {
  const j = jobs.get(id);
  if (j && (j.status === 'queued' || j.status === 'running')) j.cancelRequested = true;
  return j;
}

function pruneJobs(): void {
  const finished = [...jobs.values()]
    .filter(j => j.status !== 'running' && j.status !== 'queued')
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  while (finished.length > 30) jobs.delete(finished.shift()!.id);
}

// ── Provider fan-out ────────────────────────────────────────────────────────

export interface AxonIndexOptions {
  projectId?: string;
  /** Limit the run to these projects (boot scan: the changed ones). */
  projectIds?: string[];
  /** Limit a whole-tree run to one source (default both). */
  source?: AxonRecordSource | 'all';
  force?: boolean;
  /** Test hook: bypass the sidecar registry. */
  providers?: EmbeddingProvider[];
  /** Test hook: embed_cache (null = no cache). Default: the shared cache. */
  cache?: EmbedCache | null;
  batchSize?: number;
}

function providerLabel(p: EmbeddingProvider): string {
  const anyP = p as any;
  const sc = anyP.sidecar;
  if (sc) return `${sc.name}@${sc.host}:${sc.port}`;
  // A cloud provider has no `sidecar` field, and falling through to the
  // constructor name rendered a four-provider cloud fan-out as four identical
  // "VirtualEmbeddingProvider" entries in the jobs panel. `getSidecarName()`
  // is what the rest of the codebase credits them by (`BASWS35-OR-CodeEmbedding`).
  const named = anyP.getSidecarName?.();
  if (typeof named === 'string' && named) return named;
  return p.constructor?.name ?? 'provider';
}

/**
 * Embed `texts` in batches through main's `embedBatchFanout` (rate-weighted
 * proportional split across the given providers). A provider fault surfaces
 * as the batch error → the project fails cleanly (nothing is written until
 * every vector of the project is present and dimension-checked).
 */
async function embedFanout(
  texts: string[],
  providers: EmbeddingProvider[],
  batchSize: number,
  onProgress: (done: number) => void,
  isCancelled: () => boolean,
): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  // One fan-out call per `batchSize × providers` texts so every provider gets
  // a full batch and progress/cancel checks happen between calls.
  const step = Math.max(1, batchSize * Math.max(1, providers.length));
  for (let i = 0; i < texts.length; i += step) {
    if (isCancelled()) throw new Error('cancelled');
    const slice = texts.slice(i, i + step);
    const vecs = await embedBatchFanout(providers, slice, (p, n) => {
      logger.debug(`axon embed: ${providerLabel(p)} served ${n}`);
    });
    if (vecs.length !== slice.length) throw new Error(`fan-out returned ${vecs.length} vectors for ${slice.length} texts`);
    out.push(...vecs);
    onProgress(out.length);
  }
  return out;
}

// ── Main entry ──────────────────────────────────────────────────────────────

/** Start an index run in the background and return the job immediately. */
export function startAxonIndex(opts: AxonIndexOptions = {}): AxonJob {
  const activeStatus = activeJobId ? jobs.get(activeJobId)?.status : undefined;
  if (activeStatus === 'running' || activeStatus === 'queued') {
    const a = jobs.get(activeJobId!)!;
    throw new Error(`Axon indexing job ${activeJobId} is already ${activeStatus} (project ${Math.min(a.projectsDone + 1, a.projectsTotal || 1)}/${a.projectsTotal}, `
      + `${a.functionsEmbedded}/${a.functionsTotal} functions, started ${a.startedAt.slice(11, 16)}). Wait for it or cancel it on the Axon page.`);
  }
  const { model, dimensions } = resolveAxonEmbeddingModel();
  const job: AxonJob = {
    id: randomUUID().slice(0, 8),
    kind: 'axon-index',
    scope: { projectId: opts.projectId, source: opts.source ?? 'all', force: !!opts.force },
    status: 'queued',
    startedAt: new Date().toISOString(),
    projectsTotal: 0, projectsDone: 0,
    functionsTotal: 0, functionsEmbedded: 0,
    model, dimensions, providers: [], errors: [],
  };
  jobs.set(job.id, job);
  activeJobId = job.id;
  pruneJobs();
  void runAxonIndex(job, opts).catch(err => {
    job.status = 'error';
    job.errors.push({ message: (err as Error).message, at: new Date().toISOString() });
    job.finishedAt = new Date().toISOString();
  }).finally(() => { if (activeJobId === job.id) activeJobId = null; });
  return job;
}

/** Run an index job to completion (exported for the self-test script). */
export async function runAxonIndex(job: AxonJob, opts: AxonIndexOptions = {}): Promise<AxonJob> {
  const settings = getAxonSettings();
  const projDir = getAxonProjDir(settings);
  const { model, dimensions } = resolveAxonEmbeddingModel();
  const isCancelled = () => !!job.cancelRequested;
  const lockLabel = opts.projectId ?? (opts.projectIds ? `${opts.projectIds.length} changed project(s)` : opts.source ?? 'all');
  job.projectsSkipped = 0; job.functionsSkipped = 0; job.functionsDeleted = 0; job.projectStats = [];

  // Heavy-job lock per project (3.12 item 3): taken only for a project that
  // has work, released after it, so a waiting code embed (hand-over) or a
  // lazy task runs between projects. While waiting the job is `queued`.
  let releaseHeavy: (() => void) | null = null;
  const publish = () => setHeavyJobProgress('axon-index', {
    page: '/axon', jobId: job.id, projectsDone: job.projectsDone, projectsTotal: job.projectsTotal,
    itemsDone: job.functionsEmbedded + (job.functionsSkipped ?? 0), itemsTotal: job.functionsTotal, itemsLabel: 'functions',
    providers: job.providers, startedAt: job.startedAt, currentProject: job.currentProject,
  });
  const takeLock = async (): Promise<boolean> => {
    const abort = new AbortController();
    const poll = setInterval(() => { if (job.cancelRequested) abort.abort(); }, 1000);
    poll.unref?.();
    try {
      releaseHeavy = await waitForHeavyJob('axon-index', lockLabel, {
        signal: abort.signal,
        onWaiting: (h) => { job.status = 'queued'; job.waitingFor = h; },
      });
      job.status = 'running';
      return true;
    } catch {
      return false;
    } finally {
      clearInterval(poll);
      job.waitingFor = null;
    }
  };
  const dropLock = () => {
    setHeavyJobProgress('axon-index', null);
    const r = releaseHeavy;
    releaseHeavy = null;
    r?.();
  };

  job.status = 'running';
  try {
    // The grammar must be up BEFORE any row is written. Without it the text
    // builder silently produces v1-style line windows — which would still be
    // tagged `embed_text_version: 2`, so no staleness check could ever tell
    // them from real v2 rows. Refuse with a named reason instead.
    if (!(await initAxonGrammar())) {
      const g = axonGrammarStatus();
      throw new Error(
        `the Axon tree-sitter grammar is not loaded (${g.error ?? 'unknown reason'}) — refusing to write `
        + `embed_text_version ${AXON_EMBED_TEXT_VERSION} rows built from line windows instead of statements`,
      );
    }

    const all = scanAllAxonProjects(opts.source ?? 'all');
    if (all.length === 0) {
      throw new Error(`no Axon projects found under proj (${projDir}) or library (${getAxonLibraryDir(settings)}) — check axon.projectPath / axon.libraryPath`);
    }
    const wanted = opts.projectIds ? new Set(opts.projectIds) : null;
    const refs: AxonProjectRef[] = opts.projectId
      ? all.filter(p => p.projectId === opts.projectId)
      : wanted ? all.filter(p => wanted.has(p.projectId)) : all;
    if (opts.projectId && refs.length === 0) throw new Error(`unknown Axon project '${opts.projectId}'`);
    job.projectsTotal = refs.length;
    job.functionsTotal = refs.reduce((n, r) => n + r.functionCount, 0);

    const batchSize = opts.batchSize ?? readBatchSize();
    const meta = readAxonMeta();
    const cache = opts.cache !== undefined ? opts.cache : await loadEmbedCache();
    let table: Awaited<ReturnType<typeof ensureAxonTableForWrite>> | null = null;

    for (const ref of refs) {
      if (isCancelled()) { job.status = 'cancelled'; break; }
      job.currentProject = ref.projectId;
      const t0 = Date.now();
      const prev = meta.projects[ref.projectId];
      const stat: AxonProjectRunStat = { projectId: ref.projectId, status: 'embedding', functions: 0, skipped: 0, embedded: 0, deleted: 0, providerTexts: 0, errors: 0 };
      job.projectStats!.push(stat);
      const pm: AxonProjectMeta = {
        projectId: ref.projectId, source: ref.source, instance: ref.instance, project: ref.project,
        functionsFound: 0, vectorsWritten: 0, rowsWritten: 0, model, dimensions,
        embedTextVersion: AXON_EMBED_TEXT_VERSION,
        lastRun: new Date().toISOString(), errors: [], hashes: {},
      };
      try {
        const records = parseAnyAxonProject(ref);
        pm.functionsFound = stat.functions = records.length;
        const plan = planAxonProject(records, prev, model, dimensions, { force: opts.force });
        if (plan.skip) {
          // Unchanged (3.12 item 1): no provider, no lock, no table write.
          stat.status = 'skipped';
          stat.skipped = records.length;
          job.projectsSkipped!++;
          job.functionsSkipped! += records.length;
          job.projectsDone++;
          continue;
        }

        // Lock for this project only (item 3).
        if (!(await takeLock())) { job.status = 'cancelled'; stat.status = 'error'; break; }
        // Providers refreshed per project (item 4): one that passed the vector
        // gate mid-run joins here. Policy-aware: under "OpenRouter only" this
        // is the verified cloud pool (it throws with a named reason when that
        // pool cannot serve).
        const providers = opts.providers ?? await selectAllEmbeddingProvidersWithCloud('code', model);
        if (providers.length === 0) {
          throw new Error(`no embedding provider advertises model ${model} (capability embedding-code/embedding) — sidecar fleet offline?`);
        }
        job.providers = providers.map(providerLabel);
        for (const p of providers) { try { await p.initialize(); } catch { /* sidecar providers are no-ops */ } }
        // Table at the configured dims; refuses to drop a populated mismatched table unless force.
        table ??= await ensureAxonTableForWrite(!!opts.force);
        publish();

        // One embedding unit per chunk of a changed function.
        const units: Array<{ record: AxonFunctionRecord; chunk: AxonEmbeddingChunk }> = [];
        for (const r of plan.changed) for (const c of buildAxonEmbeddingChunksFor(r)) units.push({ record: r, chunk: c });
        const texts = units.map(u => u.chunk.text);
        const embeddedBefore = job.functionsEmbedded;
        const n = plan.changed.length;
        const fanout = (xs: string[]) => {
          stat.providerTexts += xs.length;
          return embedFanout(xs, providers, batchSize, d => {
            job.functionsEmbedded = embeddedBefore + Math.round(d * n / Math.max(1, units.length));
            publish();
          }, isCancelled);
        };
        const vectors = units.length === 0 ? []
          : cache && cache.isEnabled()
            ? (await cache.embedThrough(model, texts, fanout, AXON_CACHE_TEXT_VERSION)).vectors
            : await fanout(texts);
        // Validate dims before touching the table.
        const bad = vectors.findIndex(v => !v || v.length !== dimensions);
        if (bad >= 0) {
          throw new Error(`provider returned ${vectors[bad]?.length ?? 0}d vectors but code model ${model} is configured at ${dimensions}d — fix semanticSearch.codeDimensions`);
        }
        // Full (force, model/dims/layout change): replace the project's rows.
        // Otherwise delete only the rows of changed and removed functions.
        if (plan.full) await deleteAxonProjectVectors(ref.projectId);
        else await deleteAxonFunctionVectors(ref.projectId, plan.deleteNames);
        const rows: AxonVectorRow[] = units.map((u, i) => toRow(u.record, u.chunk, vectors[i], model, dimensions));
        for (let i = 0; i < rows.length; i += 500) await table.add(rows.slice(i, i + 500) as unknown as Record<string, unknown>[]);
        pm.vectorsWritten = records.length;
        pm.rowsWritten = rows.length; // rows written by this run
        for (const r of records) pm.hashes![r.name] = r.hash;
        stat.embedded = n;
        stat.skipped = plan.unchanged;
        stat.deleted = plan.full ? 0 : plan.removed.length;
        stat.status = 'done';
        job.functionsEmbedded = embeddedBefore + n;
        job.functionsSkipped! += plan.unchanged;
        job.functionsDeleted! += stat.deleted;
      } catch (err) {
        const msg = (err as Error).message;
        stat.status = 'error';
        stat.errors++;
        pm.errors.push(msg);
        job.errors.push({ projectId: ref.projectId, message: msg, at: new Date().toISOString() });
        logger.error(`Axon index failed for ${ref.projectId}: ${msg}`);
        if (/all .* provider\(s\) faulted|cancelled|no providers left|configured at/.test(msg)) {
          pm.durationMs = Date.now() - t0;
          meta.projects[ref.projectId] = { ...pm, hashes: prev?.hashes };
          writeAxonMeta(meta);
          throw err; // fleet is gone / cancelled — stop the whole run
        }
        // Keep the old hashes: the next run retries exactly this project.
        pm.hashes = prev?.hashes;
      } finally {
        dropLock(); // yield between projects
      }
      pm.durationMs = Date.now() - t0;
      meta.projects[ref.projectId] = pm;
      writeAxonMeta(meta);
      job.projectsDone++;
    }
    if (job.status === 'running') job.status = 'done';
    logger.info(`Axon index job ${job.id}: ${job.projectsSkipped} project(s) skipped, ${job.functionsEmbedded} function(s) embedded, ${job.functionsDeleted} deleted, ${job.errors.length} error(s)`);
  } catch (err) {
    const msg = (err as Error).message;
    job.status = msg === 'cancelled' ? 'cancelled' : 'error';
    if (job.status === 'error' && !job.errors.some(e => e.message === msg)) {
      job.errors.push({ message: msg, at: new Date().toISOString() });
    }
  } finally {
    job.currentProject = undefined;
    job.finishedAt = new Date().toISOString();
    dropLock();
  }
  return job;
}

async function loadEmbedCache(): Promise<EmbedCache | null> {
  try {
    const { getEmbedCache } = await import('../embedding/embedCache.js');
    return getEmbedCache();
  } catch { return null; }
}

function readBatchSize(): number {
  try {
    const p = path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');
    const c = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const n = Number(c?.semanticSearch?.embeddingBatchSize);
    return Number.isFinite(n) && n > 0 ? n : 16;
  } catch { return 16; }
}

function toRow(r: AxonFunctionRecord, c: AxonEmbeddingChunk, v: Float32Array, model: string, dims: number): AxonVectorRow {
  return {
    row_id: c.chunkIndex === 0 ? r.id : `${r.id}#${c.chunkIndex}`,
    node_id: r.id,
    source: r.source,
    vector: Array.from(v),
    project_id: r.projectId,
    instance: r.instance,
    project: r.project,
    name: r.name,
    qualified_name: r.qualifiedName,
    signature: r.signature,
    params: JSON.stringify(r.paramDefs),
    return_type: r.returnType ?? '',
    tags: r.tags.join(','),
    doc: r.doc.slice(0, 800),
    rel_path: r.relPath,
    line_start: c.chunkIndex === 0 ? r.lineStart : c.lineStart,
    line_end: c.chunkIndex === 0 && c.chunkCount === 1 ? r.lineEnd : c.lineEnd,
    chunk_index: c.chunkIndex,
    chunk_count: c.chunkCount,
    embed_text_version: AXON_EMBED_TEXT_VERSION,
    hash: r.hash,
    model,
    dimensions: dims,
    created_at: new Date().toISOString(),
  };
}

// ── Status views ────────────────────────────────────────────────────────────

export interface AxonProjectStatus {
  projectId: string;
  source: AxonRecordSource;
  instance: string;
  project: string;
  functionsFound: number;
  /** Functions with a vector (chunk 0 row present). */
  vectors: number;
  /** Total chunk rows. */
  rows: number;
  embeddedPercent: number;
  lastRun?: string;
  lastSync?: string;
  model?: string;
  dimensions?: number;
  embedTextVersion?: number;
  /** True when the project's vectors were built with an older text layout. */
  embedTextStale?: boolean;
  errors: string[];
}

export async function getAxonProjectsStatus(): Promise<{
  projDir: string;
  libraryDir: string;
  projects: AxonProjectStatus[];
  totals: { projects: number; functions: number; vectors: number; embeddedPercent: number };
  bySource: Record<AxonRecordSource, { projects: number; functions: number; vectors: number; embeddedPercent: number }>;
  table: Awaited<ReturnType<typeof getAxonTableStats>>;
  embedTextVersion: number;
}> {
  const projDir = getAxonProjDir();
  const libraryDir = getAxonLibraryDir();
  const refs = scanAllAxonProjects('all');
  const meta = readAxonMeta();
  let counts = new Map<string, { functions: number; rows: number }>();
  try { counts = await countAxonVectorsByProject(); } catch (e) { logger.warn(`count vectors failed: ${(e as Error).message}`); }
  const table = await getAxonTableStats();

  const projects: AxonProjectStatus[] = refs.map(p => {
    const m = meta.projects[p.projectId];
    const c = counts.get(p.projectId) ?? { functions: 0, rows: 0 };
    const vectors = c.functions;
    return {
      projectId: p.projectId, source: p.source, instance: p.instance, project: p.project,
      functionsFound: p.functionCount, vectors, rows: c.rows,
      embeddedPercent: p.functionCount ? Math.round((Math.min(vectors, p.functionCount) / p.functionCount) * 1000) / 10 : 0,
      lastRun: m?.lastRun, lastSync: p.lastSync, model: m?.model, dimensions: m?.dimensions,
      embedTextVersion: m?.embedTextVersion,
      embedTextStale: m?.embedTextVersion !== undefined && m.embedTextVersion !== AXON_EMBED_TEXT_VERSION,
      errors: m?.errors ?? [],
    };
  });
  const tally = (list: AxonProjectStatus[]) => {
    const functions = list.reduce((n, p) => n + p.functionsFound, 0);
    const vectors = list.reduce((n, p) => n + Math.min(p.vectors, p.functionsFound), 0);
    return { projects: list.length, functions, vectors, embeddedPercent: functions ? Math.round((vectors / functions) * 1000) / 10 : 0 };
  };
  return {
    projDir, libraryDir, projects, table, embedTextVersion: AXON_EMBED_TEXT_VERSION,
    totals: tally(projects),
    bySource: { proj: tally(projects.filter(p => p.source === 'proj')), library: tally(projects.filter(p => p.source === 'library')) },
  };
}

export async function listAxonProjectFunctions(projectId: string, opts: { page?: number; pageSize?: number; q?: string } = {}): Promise<{
  projectId: string;
  total: number;
  page: number;
  pageSize: number;
  embedded: number;
  functions: Array<{
    id: string; name: string; signature: string; params: string[]; returnType?: string; doc: string;
    filePath: string; lineStart: number; lineEnd: number; tags: string[]; calls: string[]; calledBy: string[];
    embedded: boolean; modified?: string;
  }>;
}> {
  const ref = scanAllAxonProjects(isLibraryProjectId(projectId) ? 'library' : 'proj').find(p => p.projectId === projectId);
  if (!ref) throw new Error(`unknown Axon project '${projectId}'`);
  const records = parseAnyAxonProject(ref);
  const ids = await listAxonVectorIds(projectId);
  const q = (opts.q ?? '').toLowerCase().trim();
  const filtered = q ? records.filter(r => r.name.toLowerCase().includes(q) || r.doc.toLowerCase().includes(q)) : records;
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, opts.pageSize ?? 50));
  const slice = filtered.slice((page - 1) * pageSize, page * pageSize);
  return {
    projectId, total: filtered.length, page, pageSize,
    embedded: records.filter(r => ids.has(r.id)).length,
    functions: slice.map(r => ({
      id: r.id, name: r.name, signature: r.signature, params: r.params, returnType: r.returnType,
      doc: r.doc.slice(0, 300), filePath: r.filePath, lineStart: r.lineStart, lineEnd: r.lineEnd,
      tags: r.tags, calls: r.calls, calledBy: r.calledBy, embedded: ids.has(r.id), modified: r.modified,
    })),
  };
}

/** Find one function by name (optionally within a project) from the parsed tree. */
export function findAxonFunction(name: string, projectId?: string, source: AxonRecordSource | 'all' = 'all'): AxonFunctionRecord[] {
  const out: AxonFunctionRecord[] = [];
  for (const ref of scanAllAxonProjects(source)) {
    if (projectId && ref.projectId !== projectId) continue;
    const hit = parseAnyAxonProject(ref).find(r => r.name === name);
    if (hit) out.push(hit);
  }
  return out;
}

/** Boot hook: when `autoIndex` is on and providers exist, kick a run once. */
export function maybeAutoIndexAtBoot(): void {
  const s = getAxonSettings();
  if (!s.enabled || !s.autoIndex) return;
  // 3.12 item 2: cheap hash scan first. No change → no job, no lock, no
  // provider poll. Changes → a job scoped to the changed projects.
  void (async () => {
    let changed: string[];
    try {
      const r = await scanAxonChanges('all');
      changed = r.changed;
      if (changed.length === 0) {
        logger.info(`Axon autoIndex: ${r.projects} project(s) unchanged — no job`);
        return;
      }
      logger.info(`Axon autoIndex: ${changed.length}/${r.projects} project(s) changed`);
    } catch (e) {
      logger.warn(`Axon autoIndex scan failed: ${(e as Error).message}`);
      return;
    }
    pollProvidersThenIndex(changed);
  })();
}

function pollProvidersThenIndex(projectIds: string[]): void {
  const { model } = resolveAxonEmbeddingModel();
  // Providers register over WS after boot (and cloud providers have to pass
  // verification first); poll briefly before giving up. The cloud selector
  // THROWS while the pool cannot serve — inside an interval that would be an
  // unhandled rejection, so a throw is caught and read as "not ready yet".
  let attempts = 0;
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return; // a slow verification round must not stack calls
    inFlight = true;
    attempts++;
    void (async () => {
      let providers: EmbeddingProvider[] = [];
      let why = '';
      try {
        providers = await selectAllEmbeddingProvidersWithCloud('code', model);
      } catch (e) {
        why = (e as Error).message;
      }
      if (providers.length > 0) {
        clearInterval(timer);
        try {
          const job = startAxonIndex({ projectIds });
          logger.info(`Axon autoIndex started job ${job.id} with ${providers.length} provider(s)`);
        } catch (e) { logger.warn(`Axon autoIndex not started: ${(e as Error).message}`); }
      } else if (attempts >= 20) {
        clearInterval(timer);
        logger.info(`Axon autoIndex skipped — no provider can embed ${model} after ${attempts} checks${why ? `: ${why}` : ''}`);
      }
    })().finally(() => { inFlight = false; });
  }, 30_000);
  timer.unref?.();
}
