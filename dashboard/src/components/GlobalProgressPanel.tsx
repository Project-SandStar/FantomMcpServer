'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { api, getApiBase, ReembedJob, AutoPipelineStatus } from '@/lib/api';

// Global AST + Vector coverage panel for the home dashboard. Shows the 30,000ft
// view across ALL projects. Per-project drill-down lives on the AST viewer.

interface AstCoverage {
  totalProjects: number;
  indexedProjects: number;
  notIndexedProjects: number;
  coveragePercent: number;
  projectsIndexing: number;
  totalNodes: number;
}

interface VectorStats {
  totalVectors: number;
  totalNodes: number;
  coveragePercent: string;
  /** Present while a full re-embed builds into the inactive slot. */
  shadow?: {
    building: boolean;
    table: string | null;
    activeTable: string;
    activeVectors: number;
    vectors: number;
    /**
     * WHICH TABLE the figures above were counted from. The endpoint counts
     * the shadow slot while a rebuild builds and the active slot otherwise,
     * and the flag deciding it is cleared by a restart — so the same number
     * can change table between two polls. Naming it is what keeps a flip from
     * reading as data loss. `rowsOnDisk` (both slots) is the proof beside it:
     * it does not move when the source does.
     */
    countedFrom?: 'active' | 'shadow';
    countedTable?: string;
    activeRows?: number;
    shadowRows?: number;
    rowsOnDisk?: number;
    /** An un-promoted rebuild left in the inactive slot by a stopped run. */
    pending?: { table: string; rows: number } | null;
  };
}

interface IndexingStatus {
  count: number;
  running: Array<{ projectId: number; projectName: string | null; currentStage: string | null }>;
}

function authHeader(): string {
  const u = typeof window !== 'undefined' ? localStorage.getItem('admin_user') || 'admin' : 'admin';
  const p = typeof window !== 'undefined' ? localStorage.getItem('admin_pass') || 'admin' : 'admin';
  return 'Basic ' + btoa(`${u}:${p}`);
}

async function fetchAstCoverage(): Promise<AstCoverage> {
  const res = await fetch(`${getApiBase()}/admin/ast/coverage`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) throw new Error(`ast/coverage ${res.status}`);
  return res.json();
}

async function fetchVectorStats(): Promise<VectorStats> {
  const res = await fetch(`${getApiBase()}/admin/vectors/stats`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) throw new Error(`vectors/stats ${res.status}`);
  return res.json();
}

async function fetchIndexingStatus(): Promise<IndexingStatus> {
  const res = await fetch(`${getApiBase()}/admin/indexing/status`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) throw new Error(`indexing/status ${res.status}`);
  return res.json();
}

export function GlobalProgressPanel() {
  const { data: ast, refetch: refetchAst } = useQuery({
    queryKey: ['ast-coverage'],
    queryFn: fetchAstCoverage,
    refetchInterval: 10_000,
  });

  const { data: vectors, refetch: refetchVectors } = useQuery({
    queryKey: ['vector-stats'],
    queryFn: fetchVectorStats,
    refetchInterval: 10_000,
  });

  const { data: indexing, refetch: refetchIndexing } = useQuery({
    queryKey: ['indexing-status'],
    queryFn: fetchIndexingStatus,
    // Faster refresh while pipelines are running.
    refetchInterval: (q) => {
      const d = q.state.data as IndexingStatus | null | undefined;
      return (d?.count ?? 0) > 0 ? 2000 : 10_000;
    },
  });

  // Background re-embed jobs (vector regeneration). Independent of the
  // legacy in-process indexing pipeline above.
  const { data: reembedJobs, refetch: refetchReembed } = useQuery({
    queryKey: ['reembed-jobs'],
    queryFn: () => api.listReembedJobs(),
    refetchInterval: (q) => {
      const d = q.state.data as { jobs: ReembedJob[] } | null | undefined;
      const running = (d?.jobs ?? []).some(j => j.status === 'running' || j.status === 'queued');
      return running ? 2000 : 10_000;
    },
  });
  const activeReembed = (reembedJobs?.jobs ?? []).filter(j => j.status === 'running' || j.status === 'queued');

  // Boot-time auto-embedding pipeline (the loop that runs on server start).
  const { data: autoPipeline, refetch: refetchAutoPipeline } = useQuery({
    queryKey: ['auto-pipeline-status'],
    queryFn: () => api.getAutoPipelineStatus(),
    refetchInterval: (q) => {
      const d = q.state.data as AutoPipelineStatus | null | undefined;
      return d?.running ? 2000 : 10_000;
    },
  });
  const autoRunning = (autoPipeline?.running ?? false) || autoPipeline?.currentPhase === 'waiting-for-sidecar';

  const astPct = ast?.coveragePercent ?? 0;
  const vecPct = vectors ? Number(vectors.coveragePercent) : 0;
  const totalProjects = ast?.totalProjects ?? 0;
  const indexedProjects = ast?.indexedProjects ?? 0;
  const totalNodes = vectors?.totalNodes ?? 0;
  const totalVectors = vectors?.totalVectors ?? 0;
  const runningCount = indexing?.count ?? 0;
  // During a shadow rebuild the counts describe the table being built, not the
  // one search serves — label it so falling coverage does not read as data loss.
  const rebuilding = vectors?.shadow?.building ?? false;
  // A stopped rebuild leaves a full shadow table that nothing promotes. Without
  // surfacing it the dashboard falls back to the stale active slot and a
  // cancelled run reads as total data loss.
  //
  // The gate used to be `pending.rows > activeVectors`, which hid a banked
  // shadow smaller than the live table — precisely the case where the coverage
  // number DROPS and needs explaining. Any banked rows at all are worth naming.
  const pendingShadow = !rebuilding && (vectors?.shadow?.pending?.rows ?? 0) > 0
    ? vectors!.shadow!.pending!
    : null;
  // Which table the headline figure was counted from. The endpoint counts the
  // shadow slot while a rebuild runs and the active slot otherwise, and a
  // restart clears the flag that decides it — so the same number can change
  // table between two polls. Naming it is the whole fix for "coverage was 100%
  // before restarting".
  const countedTable = vectors?.shadow?.countedTable ?? null;
  const rowsOnDisk = vectors?.shadow?.rowsOnDisk ?? null;

  const refreshAll = () => {
    refetchAst();
    refetchVectors();
    refetchIndexing();
    refetchReembed();
    refetchAutoPipeline();
  };

  const qc = useQueryClient();
  const embedMissingMut = useMutation({
    mutationFn: (force: boolean) => api.buildMissingAll(force),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reembed-jobs'] }),
  });
  // "Force resume": if a heavy job (full re-embed / forced reindex / Axon
  // index) owns the fleet, say so and offer to cancel it and resume filling
  // missing vectors instead of failing with a bare 409.
  const startEmbedMissing = async () => {
    let holder: { kind: string; label: string; since: string } | null = null;
    try { holder = (await api.getHeavyJob()).holder; } catch { /* older server: no lock endpoint */ }
    if (holder) {
      const since = new Date(holder.since).toLocaleTimeString();
      if (!confirm(`A ${holder.kind} job (${holder.label}) has owned the embedding fleet since ${since}.\n\nForce resume: cancel it and embed the ${incompleteCount.toLocaleString()} missing nodes now?\n(A cancelled full re-embed drops its unfinished shadow table; the live vectors are kept.)`)) return;
      embedMissingMut.mutate(true);
      return;
    }
    if (confirm(`Start a background job to embed ${incompleteCount.toLocaleString()} missing nodes across projects? Existing vectors are kept; only un-embedded nodes are filled.`)) {
      embedMissingMut.mutate(false);
    }
  };
  const incompleteCount = vecPct < 100 && totalNodes > 0 ? Math.max(0, totalNodes - totalVectors) : 0;

  return (
    <div className="mt-8 bg-white rounded-lg shadow p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Caching Progress</h2>
          <p className="text-sm text-gray-500">
            Global coverage across all {totalProjects.toLocaleString()} projects
          </p>
        </div>
        <div className="flex items-center gap-3">
          {incompleteCount > 0 && (
            <button
              onClick={() => { void startEmbedMissing(); }}
              disabled={embedMissingMut.isPending}
              className="text-sm px-3 py-1 bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50 transition-colors"
              title={`${incompleteCount.toLocaleString()} nodes still un-embedded`}
            >
              {embedMissingMut.isPending ? 'Starting…' : `Embed missing (${incompleteCount.toLocaleString()})`}
            </button>
          )}
          <button
            onClick={refreshAll}
            className="text-sm px-3 py-1 border border-gray-300 rounded hover:bg-gray-50 transition-colors"
          >
            Refresh
          </button>
          <Link
            href="/ast-viewer"
            className="text-sm text-blue-600 hover:text-blue-800"
          >
            View per-project →
          </Link>
        </div>
      </div>

      {/* AST coverage bar */}
      <div className="mb-4">
        <div className="flex items-center justify-between text-sm text-gray-700 mb-1">
          <span className="font-medium">AST Coverage</span>
          <span className="text-gray-600">
            {astPct.toFixed(1)}% · {indexedProjects.toLocaleString()}/{totalProjects.toLocaleString()} projects indexed
          </span>
        </div>
        <div className="w-full h-3 bg-gray-100 rounded overflow-hidden">
          <div
            className="h-full bg-purple-500 transition-all"
            style={{ width: `${Math.min(100, astPct)}%` }}
          />
        </div>
        <div className="text-xs text-gray-500 mt-1">
          {totalNodes.toLocaleString()} nodes total
        </div>
      </div>

      {/* Vector coverage bar */}
      <div className="mb-2">
        <div className="flex items-center justify-between text-sm text-gray-700 mb-1">
          <span className="font-medium">Vector Coverage</span>
          <span className="text-gray-600">
            {vecPct.toFixed(1)}% · {totalVectors.toLocaleString()}/{totalNodes.toLocaleString()} nodes embedded
            {countedTable && (
              <span
                className="ml-2 text-[11px] text-gray-400"
                title={
                  'The figure is counted from this table. A rebuild in progress is counted from the '
                  + 'shadow slot and everything else from the live slot, so the number can change table '
                  + 'between polls — that is a change of source, not a loss of vectors.'
                }
              >
                counted from <code>{countedTable}</code>
              </span>
            )}
            {rebuilding && (
              <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">
                rebuilding · serving {(vectors?.shadow?.activeVectors ?? 0).toLocaleString()} live
              </span>
            )}
          </span>
        </div>
        <div className="w-full h-3 bg-gray-100 rounded overflow-hidden">
          <div
            className="h-full bg-teal-500 transition-all"
            style={{ width: `${Math.min(100, vecPct)}%` }}
          />
        </div>
        {/* NOT inside the bar track above: that div is `h-3 overflow-hidden`,
            so this banner was being clipped to 12px and never seen. It is the
            one thing on the page that explains a coverage number that fell
            across a restart, and it was invisible for exactly that incident. */}
        {pendingShadow && (
          <div className="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900">
            <strong>{pendingShadow.rows.toLocaleString()} vectors</strong> are built but not live —
            a rebuild in <code>{pendingShadow.table}</code> was stopped before it promoted.
            Nothing is lost; the bar above shows the{' '}
            <code>{vectors?.shadow?.activeTable ?? 'live'}</code> table that search still uses
            {rowsOnDisk !== null && (
              <> ({rowsOnDisk.toLocaleString()} code vectors on disk across both slots)</>
            )}.
            Resume the re-embed to finish and promote it.
          </div>
        )}
      </div>

      {/* Currently indexing (legacy in-process pipeline) */}
      {runningCount > 0 && (
        <div className="mt-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          <span className="font-medium">{runningCount}</span>{' '}
          project{runningCount === 1 ? '' : 's'} indexing now
          {indexing && indexing.running.length > 0 && (
            <span className="text-amber-700">
              {' '}—{' '}
              {indexing.running.slice(0, 3).map((r, i) => (
                <span key={r.projectId}>
                  {i > 0 ? ', ' : ''}
                  {r.projectName ?? `#${r.projectId}`}
                  {r.currentStage ? ` (${r.currentStage})` : ''}
                </span>
              ))}
              {indexing.running.length > 3 && ` +${indexing.running.length - 3} more`}
            </span>
          )}
        </div>
      )}

      {/* Boot-time auto-embedding pipeline */}
      {autoPipeline && autoPipeline.currentPhase === 'waiting-for-sidecar' && (
        <div className="mt-3 text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded px-3 py-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="animate-spin inline-block w-3 h-3 border-2 border-amber-500 border-t-transparent rounded-full" />
            <span>
              Waiting for embedding sidecar to register
              <span className="ml-1 text-xs text-amber-700">
                · auto-checking every 5s
              </span>
              {autoPipeline.sidecarWaitDeadline && (
                <span className="ml-1 text-xs text-amber-700">
                  (timeout {Math.max(0, Math.round((Date.parse(autoPipeline.sidecarWaitDeadline) - Date.now()) / 1000))}s)
                </span>
              )}
            </span>
          </div>
          <button
            onClick={() => api.startAutoEmbed().catch(() => null)}
            className="text-xs px-2 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded"
            title="Force-start the auto-embed pipeline now (the watchdog also auto-retries every 5s)"
          >Re-trigger now</button>
        </div>
      )}

      {autoRunning && autoPipeline && autoPipeline.currentPhase === 'running' && (
        <div className="mt-3 text-sm text-blue-900 bg-blue-50 border border-blue-200 rounded px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <span className="font-medium">Auto-embedding pipeline</span>
              {autoPipeline.currentProjectName && (
                <span className="ml-2 text-xs">
                  · {autoPipeline.currentProjectName}{autoPipeline.currentNodes ? ` (${autoPipeline.currentNodes.toLocaleString()} nodes)` : ''}
                </span>
              )}
            </div>
            <div className="text-xs text-blue-700">
              {autoPipeline.doneProjects}/{autoPipeline.totalProjects} · {autoPipeline.totalProcessed.toLocaleString()} embedded
              {autoPipeline.skipped > 0 ? ` · ${autoPipeline.skipped} skipped` : ''}
              {autoPipeline.totalErrors > 0 ? ` · ${autoPipeline.totalErrors} errors` : ''}
            </div>
          </div>
          {(autoPipeline.currentSidecarHost || autoPipeline.currentSidecarName) && (
            <div className="mt-1 text-xs text-blue-700">
              embedding on{' '}
              {autoPipeline.currentSidecarName && <span className="font-medium">{autoPipeline.currentSidecarName}</span>}
              {autoPipeline.currentSidecarHost && (
                <span className="font-mono ml-1">{autoPipeline.currentSidecarHost}</span>
              )}
              {autoPipeline.currentSidecarModel && (
                <span className="font-mono ml-1 text-blue-500">· {autoPipeline.currentSidecarModel}</span>
              )}
            </div>
          )}
          {autoPipeline.totalProjects > 0 && (
            <div className="mt-1 w-full h-1.5 bg-blue-200 rounded overflow-hidden">
              <div className="h-full bg-blue-600 transition-all" style={{ width: `${Math.min(100, (autoPipeline.doneProjects / autoPipeline.totalProjects) * 100)}%` }} />
            </div>
          )}
        </div>
      )}

      {autoPipeline && autoPipeline.currentPhase === 'done' && autoPipeline.failedProjects.length > 0 && (
        <details className="mt-3 text-sm text-red-900 bg-red-50 border border-red-200 rounded px-3 py-2">
          <summary className="cursor-pointer font-medium">
            {autoPipeline.failedProjects.length} project{autoPipeline.failedProjects.length === 1 ? '' : 's'} failed during auto-embed
          </summary>
          <ul className="mt-2 space-y-1 text-xs font-mono">
            {autoPipeline.failedProjects.slice(0, 25).map(f => (
              <li key={`${f.projectId}-${f.at}`}>
                <span className="text-red-700">#{f.projectId}</span>{' '}
                <span className="text-red-900">{f.projectName}</span>:{' '}
                <span className="text-red-600">{f.error}</span>
              </li>
            ))}
            {autoPipeline.failedProjects.length > 25 && (
              <li className="text-red-700">… +{autoPipeline.failedProjects.length - 25} more</li>
            )}
          </ul>
          <button
            onClick={() => api.startAutoEmbed(autoPipeline.failedProjects.map(f => f.projectId)).catch(() => null)}
            className="mt-2 text-xs px-2 py-1 bg-red-600 hover:bg-red-700 text-white rounded"
          >Retry failed</button>
        </details>
      )}

      {/* Background vector re-embed jobs */}
      {activeReembed.length > 0 && (
        <div className="mt-3 space-y-2">
          {activeReembed.map(j => {
            const total = j.totalProjects || 0;
            const done = j.doneProjects || 0;
            const pct = total > 0 ? (done / total) * 100 : 0;
            return (
              <div key={j.id} className="text-sm text-blue-900 bg-blue-50 border border-blue-200 rounded px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <span className="font-medium">Re-embedding</span>
                    {j.model && <span className="ml-2 font-mono text-xs">{j.model}{j.dimensions ? ` (${j.dimensions}d)` : ''}</span>}
                    {j.scope === 'all' ? <span className="ml-2 text-xs">all projects</span> : <span className="ml-2 text-xs">project #{(j.scope as { projectId: number }).projectId}</span>}
                  </div>
                  <div className="text-xs text-blue-700">
                    {done}/{total} projects · {j.generated.toLocaleString()} vectors · {j.errors.length} errors
                    {j.currentProjectId !== undefined && <span className="ml-1 text-blue-600">· now: #{j.currentProjectId}</span>}
                  </div>
                </div>
                <div className="mt-1 w-full h-1.5 bg-blue-200 rounded overflow-hidden">
                  <div className="h-full bg-blue-600 transition-all" style={{ width: `${Math.min(100, pct)}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* "No projects indexing" line intentionally removed — per-project state lives in the AST viewer table. */}
    </div>
  );
}
