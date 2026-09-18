'use client';

import { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ServerStatus } from '@/lib/api';
import { GlobalProgressPanel } from '@/components/GlobalProgressPanel';
import { ProjectVectorTable } from '@/components/ProjectVectorTable';
import { EmbeddingActivityConsole } from '@/components/EmbeddingActivityConsole';
import { AxonStatusCard } from '@/components/AxonStatusCard';

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);

  return parts.join(' ');
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let unitIndex = 0;
  let value = bytes;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function StatusBadge({ status }: { status: ServerStatus['status'] }) {
  const colors = {
    running: 'bg-green-100 text-green-800',
    starting: 'bg-yellow-100 text-yellow-800',
    error: 'bg-red-100 text-red-800',
  };

  return (
    <span
      className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${colors[status]}`}
    >
      <span
        className={`w-2 h-2 rounded-full mr-2 ${
          status === 'running'
            ? 'bg-green-500'
            : status === 'starting'
              ? 'bg-yellow-500'
              : 'bg-red-500'
        }`}
      />
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function StatCard({
  title,
  value,
  subtitle,
}: {
  title: string;
  value: string | number;
  subtitle?: string;
}) {
  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="text-sm font-medium text-gray-500">{title}</h3>
      <p className="mt-2 text-3xl font-semibold text-gray-900">{value}</p>
      {subtitle && <p className="mt-1 text-sm text-gray-500">{subtitle}</p>}
    </div>
  );
}

export default function Home() {
  const [loadingTooLong, setLoadingTooLong] = useState(false);
  const [resumeMsg, setResumeMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const queryClient = useQueryClient();

  const resumeEmbedMutation = useMutation({
    mutationFn: () => api.buildMissingAll(),
    onSuccess: (r) => {
      setResumeMsg({ kind: 'ok', text: `Resume embed started — job ${r.jobId} (${r.projectsToProcess} projects).` });
      queryClient.invalidateQueries({ queryKey: ['project-vectors'] });
      queryClient.invalidateQueries({ queryKey: ['active-embed-jobs'] });
      setTimeout(() => setResumeMsg(null), 8000);
    },
    onError: (err) => {
      setResumeMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Failed to resume embed' });
      setTimeout(() => setResumeMsg(null), 10000);
    },
  });

  // Poll the unified jobs surface so we know if an embed run is in flight.
  // Stop Embed only makes sense (and the button only enables) when there's
  // a running/queued job — otherwise there's nothing to cancel.
  const { data: jobsList } = useQuery({
    queryKey: ['active-embed-jobs'],
    queryFn: api.listJobs,
    refetchInterval: 3000,
  });
  const activeEmbedJob = jobsList?.jobs.find(
    (j) => j.status === 'running' || j.status === 'queued',
  );

  // Background embedding is NOT a reembed job, so it never appears in
  // `activeEmbedJob` — which is why Stop Embed sat greyed out while the
  // pipeline was quietly filling the live table.
  const { data: autoEmbed } = useQuery({
    queryKey: ['auto-embed-state'],
    queryFn: api.autoEmbedState,
    refetchInterval: 5000,
  });
  const autoEmbedMutation = useMutation({
    mutationFn: (enabled: boolean) => api.setAutoEmbed(enabled),
    onSuccess: (r) => {
      setResumeMsg({
        kind: 'ok',
        text: r.autoEmbedDisabled
          ? 'Auto-embed off. It stays off across restarts; an in-flight run drains at its next project.'
          : 'Auto-embed on. Missing vectors are picked up within 60s.',
      });
      queryClient.invalidateQueries({ queryKey: ['auto-embed-state'] });
      setTimeout(() => setResumeMsg(null), 8000);
    },
  });

  const stopEmbedMutation = useMutation({
    mutationFn: () => {
      if (!activeEmbedJob) throw new Error('No active embed job to stop');
      return api.cancelJob(activeEmbedJob.id);
    },
    onSuccess: (r) => {
      setResumeMsg({
        kind: 'ok',
        text: `Stop requested for job ${r.id} — current batch will finish, then it will halt.`,
      });
      queryClient.invalidateQueries({ queryKey: ['active-embed-jobs'] });
      queryClient.invalidateQueries({ queryKey: ['project-vectors'] });
      setTimeout(() => setResumeMsg(null), 8000);
    },
    onError: (err) => {
      setResumeMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Failed to stop embed' });
      setTimeout(() => setResumeMsg(null), 10000);
    },
  });

  const {
    data: status,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['status'],
    queryFn: api.getStatus,
    refetchInterval: 5000,
    retry: 2,
    retryDelay: 1000,
  });

  // Track if loading is taking too long
  useEffect(() => {
    if (isLoading) {
      const timer = setTimeout(() => setLoadingTooLong(true), 5000);
      return () => clearTimeout(timer);
    } else {
      setLoadingTooLong(false);
    }
  }, [isLoading]);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-64">
        <div className="text-gray-500">Loading...</div>
        {loadingTooLong && (
          <div className="mt-4 text-center">
            <p className="text-gray-400 text-sm">Taking longer than expected...</p>
            <button
              onClick={() => refetch()}
              className="mt-2 px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
            >
              Retry
            </button>
          </div>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <h2 className="text-red-800 font-medium">Error loading status</h2>
        <p className="text-red-600 mt-1">
          {error instanceof Error ? error.message : 'Unknown error'}
        </p>
        <button
          onClick={() => refetch()}
          className="mt-3 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!status) {
    return null;
  }

  return (
    <div>
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Server Status</h1>
          <p className="text-gray-600 mt-1">
            Monitor your Fantom MCP Server health
          </p>
        </div>
        {/* Auto-embed toggle. Persisted server-side, so it survives restarts —
            an in-memory flag would be re-armed by the 60s watchdog tick. */}
        <label
          className="flex items-center gap-2 shrink-0 cursor-pointer select-none rounded-md border border-gray-200 bg-white px-3 py-2"
          title={
            autoEmbed?.autoEmbedDisabled
              ? 'Background embedding is off. Nothing fills the live table until you turn this on.'
              : 'Background embedding is on: missing vectors are filled automatically. That work targets the LIVE table and is discarded whenever a rebuild is promoted.'
          }
        >
          <input
            type="checkbox"
            checked={autoEmbed?.autoEmbedDisabled === false}
            disabled={!autoEmbed || autoEmbedMutation.isPending}
            onChange={(e) => autoEmbedMutation.mutate(e.target.checked)}
            className="h-4 w-4 accent-blue-600 disabled:opacity-40"
          />
          <span className="text-sm text-gray-700">
            Auto-embed
            <span className={`ml-2 text-xs ${autoEmbed?.autoEmbedDisabled === false ? 'text-green-700' : 'text-gray-500'}`}>
              {!autoEmbed
                ? '…'
                : autoEmbed.autoEmbedDisabled
                  ? 'off'
                  : autoEmbed.running ? 'running' : 'on'}
            </span>
          </span>
        </label>
      </div>

      <div className="mb-6">
        <div className="flex items-center gap-4 flex-wrap">
          <span className="text-gray-700 font-medium">Status:</span>
          <StatusBadge status={status.status} />
          {status.version && (
            <span className="text-gray-500 text-sm">v{status.version}</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => resumeEmbedMutation.mutate()}
              disabled={resumeEmbedMutation.isPending}
              className="px-4 py-2 bg-emerald-600 text-white rounded-md hover:bg-emerald-700 disabled:opacity-50 transition-colors text-sm"
              title="Embed only projects/files missing vectors — picks up where a crashed run left off."
            >
              {resumeEmbedMutation.isPending ? 'Resuming...' : 'Resume Embed'}
            </button>
            <button
              onClick={() => {
                if (activeEmbedJob) stopEmbedMutation.mutate();
                else autoEmbedMutation.mutate(false);
              }}
              disabled={
                (!activeEmbedJob && autoEmbed?.autoEmbedDisabled !== false)
                || stopEmbedMutation.isPending
                || autoEmbedMutation.isPending
                || activeEmbedJob?.cancelRequested === true
              }
              className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-sm"
              title={
                activeEmbedJob
                  ? activeEmbedJob.cancelRequested
                    ? `Stop already requested — job ${activeEmbedJob.id} is winding down.`
                    : `Cancel job ${activeEmbedJob.id} — current batch will finish, then halt.`
                  : autoEmbed?.autoEmbedDisabled === false
                    ? 'Turn off background auto-embedding. It writes to the live table and that work is discarded whenever a rebuild is promoted.'
                    : 'Nothing to stop — no embed job and auto-embed is already off.'
              }
            >
              {stopEmbedMutation.isPending
                ? 'Stopping...'
                : activeEmbedJob?.cancelRequested
                  ? 'Stop Pending'
                  : 'Stop Embed'}
            </button>
          </div>
        </div>
        {resumeMsg && (
          <div className={`mt-3 px-3 py-2 rounded-md text-sm ${resumeMsg.kind === 'ok' ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-red-50 text-red-800 border border-red-200'}`}>
            {resumeMsg.text}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard title="Uptime" value={formatUptime(status.uptime)} />
        <StatCard
          title="Memory Usage"
          value={`${status.memory.percentage.toFixed(1)}%`}
          subtitle={
            `heap ${formatBytes(status.memory.used)} / ${formatBytes(status.memory.total)}` +
            (status.memory.rss != null ? ` · RSS ${formatBytes(status.memory.rss)}` : '')
          }
        />
        <StatCard title="Docs Indexed" value={status.stats.docsIndexed} />
        <StatCard title="Active Sessions" value={status.stats.activeSessions} />
      </div>

      <GlobalProgressPanel />

      <EmbeddingActivityConsole />

      <ProjectVectorTable />

      <AxonStatusCard />

      <div className="mt-8 bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          System Information
        </h2>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-sm font-medium text-gray-500">Initialized</dt>
            <dd className="mt-1 text-sm text-gray-900">
              {status.initialized ? 'Yes' : 'No'}
            </dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-gray-500">Version</dt>
            <dd className="mt-1 text-sm text-gray-900">
              {status.version || 'Unknown'}
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
