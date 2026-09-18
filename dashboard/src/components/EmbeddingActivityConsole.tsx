'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * Live "Embedding Activity" console for the dashboard home page.
 *
 * Polls /admin/vectors/auto-pipeline/status every 2s and renders the backend
 * ring buffer (`recentEvents`) as a scrolling, monospace terminal-style panel
 * (newest-last, auto-scrolled to the bottom). The dark panel intentionally
 * contrasts with the page's white cards.
 *
 * A one-line header shows the current phase, doneProjects/totalProjects, the
 * running sidecar, and an amber STALE badge when staleMs > 2 min.
 *
 * Reflects ALL embedding work, model-agnostic (nothing here filters by model
 * name or dimensions):
 *  (a) the auto pipeline (autoPipelineBus events — the status endpoint),
 *  (b) background re-embed jobs (server overlays `reembedJob` into the status;
 *      we also poll /vectors/re-embed/jobs every 3 s while one runs, for the
 *      cancel button and as a fallback for older servers),
 *  (c) standalone buildProjectEmbeddings runs (`activeRuns` from the bus).
 */

const KIND_COLOR: Record<string, string> = {
  done: 'text-emerald-400',
  failed: 'text-red-400',
  skipped: 'text-gray-500',
  start: 'text-indigo-400',
  phase: 'text-cyan-400',
  stale: 'text-amber-400',
};

function hhmmss(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return d.toTimeString().slice(0, 8);
}

export function EmbeddingActivityConsole() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['auto-pipeline-status'],
    queryFn: () => api.getAutoPipelineStatus(),
    refetchInterval: 2_000,
  });

  // Background re-embed jobs: fast poll while one is running (cancel button +
  // fallback when the server does not overlay `reembedJob` into the status).
  const { data: jobsData } = useQuery({
    queryKey: ['reembed-jobs'],
    queryFn: () => api.listReembedJobs(),
    refetchInterval: (q) => {
      const jobs = (q.state.data as { jobs?: Array<{ status: string }> } | undefined)?.jobs ?? [];
      return jobs.some((j) => j.status === 'running' || j.status === 'queued') ? 3_000 : 15_000;
    },
  });
  const polledJob = jobsData?.jobs?.find((j) => j.status === 'running' || j.status === 'queued');

  // Per-project sidecar attribution from /vectors/stats, used to annotate the
  // currently-running project when the live status doesn't carry a sidecar name.
  const { data: stats } = useQuery({
    queryKey: ['vector-stats'],
    queryFn: () => api.getVectorStats(),
    refetchInterval: 10_000,
  });

  const [cancelling, setCancelling] = useState(false);

  const logRef = useRef<HTMLDivElement>(null);
  const events = data?.recentEvents ?? [];

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length, data?.lastProgressAt]);

  // Re-embed job: prefer the server overlay, fall back to the polled job list.
  const job = data?.reembedJob
    ?? (polledJob
      ? {
          id: polledJob.id, scope: polledJob.scope, status: polledJob.status, startedAt: polledJob.startedAt,
          totalProjects: polledJob.totalProjects, doneProjects: polledJob.doneProjects,
          currentProjectId: polledJob.currentProjectId, currentProjectName: undefined as string | undefined,
          generated: polledJob.generated, deleted: polledJob.deleted, errors: polledJob.errors.length,
          model: polledJob.model, dimensions: polledJob.dimensions, cancelRequested: polledJob.cancelRequested,
        }
      : undefined);
  const jobScopeLabel = job ? (job.scope === 'all' ? 'full' : `project ${job.scope.projectId}`) : '';

  const phase = job ? (data?.phaseLabel ?? `re-embed (${jobScopeLabel})`) : (data?.phaseLabel ?? data?.currentPhase ?? 'idle');
  const done = job ? job.doneProjects : (data?.doneProjects ?? 0);
  const total = job ? job.totalProjects : (data?.totalProjects ?? 0);
  const staleMs = data?.staleMs ?? 0;
  const isStale = staleMs > 120_000;
  const staleMin = Math.round(staleMs / 60_000);

  // Prefer the live status sidecar; fall back to per-project attribution.
  const currentProjectId = job?.currentProjectId ?? data?.currentProjectId;
  const currentProject = stats?.projects?.find((p) => p.id === currentProjectId);
  const currentProjectName = job?.currentProjectName ?? data?.currentProjectName ?? currentProject?.name;
  const attributedSidecar = currentProject?.embeddingSidecarName;
  const servedBy = currentProject?.embeddingServedBy?.map((s) => `${s.name}=${s.texts}`).join(', ');
  const sidecar = data?.currentSidecarName ?? attributedSidecar ?? undefined;

  const run = data?.activeRuns?.find((r) => r.projectId === currentProjectId) ?? data?.activeRuns?.[0];

  const onCancel = async () => {
    if (!job || cancelling) return;
    setCancelling(true);
    try {
      await api.cancelReembedJob(job.id);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['reembed-jobs'] }),
        qc.invalidateQueries({ queryKey: ['auto-pipeline-status'] }),
      ]);
    } catch (err) {
      console.error('[EmbeddingActivity] cancel failed', err);
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="mt-8 bg-white rounded-lg shadow p-6">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-y-2">
        <h2 className="text-lg font-semibold text-gray-900">Embedding Activity</h2>
        <div className="flex items-center gap-2 text-sm flex-wrap">
          <span className="text-gray-500">
            phase <span className="font-mono text-gray-800">{phase}</span>
          </span>
          {data?.heavyJob && (
            <span
              className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-800 border border-amber-200"
              title={`Heavy-job lock held since ${data.heavyJob.since}${data.heavyJobQueue?.length ? ` · queued: ${data.heavyJobQueue.map(q => `${q.kind} (${q.label})`).join(', ')}` : ''}`}
            >
              lock: {data.heavyJob.kind} ({data.heavyJob.label}){data.heavyJobQueue?.length ? ` · +${data.heavyJobQueue.length} queued` : ''}
            </span>
          )}
          <span className="text-gray-400">·</span>
          <span className="text-gray-500">
            <span className="font-mono text-gray-800">{done}</span>/{total} projects
          </span>
          {job && (
            <>
              <span className="text-gray-400">·</span>
              <span className="text-gray-500">
                <span className="font-mono text-gray-800">+{job.generated.toLocaleString()}</span> vectors
              </span>
            </>
          )}
          {run && !job && run.total > 0 && (
            <>
              <span className="text-gray-400">·</span>
              <span className="text-gray-500">
                <span className="font-mono text-gray-800">{run.processed}</span>/{run.total} nodes
              </span>
            </>
          )}
          {currentProjectName && (job || data?.running) && (
            <>
              <span className="text-gray-400">·</span>
              <span className="text-gray-500">
                now <span className="font-mono text-gray-800">{currentProjectName}</span>
                {currentProjectId != null && <span className="text-gray-400"> (#{currentProjectId})</span>}
              </span>
            </>
          )}
          {(sidecar || servedBy) && (
            <>
              <span className="text-gray-400">·</span>
              <span className="text-gray-500">
                via <span className="font-mono text-gray-800">{servedBy ?? sidecar}</span>
              </span>
            </>
          )}
          {job && job.errors > 0 && (
            <span className="ml-1 inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 border border-red-200">
              {job.errors} error{job.errors === 1 ? '' : 's'}
            </span>
          )}
          {isStale && (
            <span className="ml-1 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 border border-amber-200">
              STALE {staleMin}m
            </span>
          )}
          {job && (
            <button
              type="button"
              onClick={onCancel}
              disabled={cancelling || job.cancelRequested}
              className="ml-2 inline-flex items-center rounded-md border border-red-300 bg-white px-2 py-0.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
              title="Stop the running re-embed job after the current batch"
            >
              {job.cancelRequested ? 'cancelling…' : cancelling ? 'cancel…' : 'Cancel re-embed'}
            </button>
          )}
        </div>
      </div>

      <div
        ref={logRef}
        className="h-64 overflow-y-auto rounded-md bg-gray-900 p-3 font-mono text-xs leading-relaxed"
      >
        {isLoading && <div className="text-gray-500">loading activity…</div>}
        {!isLoading && events.length === 0 && !job && (
          <div className="text-gray-500">no embedding activity yet</div>
        )}
        {events.map((e, i) => (
          <div key={`${e.ts}-${i}`} className={KIND_COLOR[e.kind] ?? 'text-gray-300'}>
            <span className="text-gray-600">[{hhmmss(e.ts)}]</span>{' '}
            {e.message}
            {e.sidecar && <span className="text-gray-600"> ({e.sidecar})</span>}
          </div>
        ))}
        {job && (
          <div className="text-cyan-400">
            <span className="text-gray-600">[{hhmmss(new Date().toISOString())}]</span>{' '}
            re-embed job {jobScopeLabel}: {job.doneProjects}/{job.totalProjects} projects, +{job.generated.toLocaleString()} vectors
            {currentProjectName ? `, embedding ${currentProjectName}` : ''}
            {job.model ? ` [${job.model}${job.dimensions ? ` ${job.dimensions}d` : ''}]` : ''}
            {job.errors > 0 ? ` — ${job.errors} error${job.errors === 1 ? '' : 's'}` : ''}
            {job.cancelRequested ? ' — cancel requested' : ''}
          </div>
        )}
      </div>
    </div>
  );
}
