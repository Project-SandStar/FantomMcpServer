'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ShadowStateResponse, type VectorStatsResponse } from '@/lib/api';

/**
 * Per-project vector coverage table for the dashboard home page.
 *
 * Pulls /admin/vectors/stats (already includes nodeCount, vectorCount, model
 * and dimensions per project) and renders a sortable table with a per-row
 * "Re-embed" button that calls POST /admin/vectors/re-embed/<id>.
 *
 * Shows the model mismatch story plainly: when a project's stored model
 * differs from the configured model, the row is flagged amber and the
 * Re-embed button is highlighted.
 */
/**
 * Banked work from a paused or partial rebuild, plus the three actions on it.
 *
 * The naming is the point. Pause keeps the vectors; Resume continues from
 * them; Discard destroys them and is the only irreversible action here — so
 * only Discard confirms, and its confirmation states the exact cost. A stop
 * that preserved 225,008 rows across 324 projects once read as total data
 * loss because the UI said "cancelled" and the page fell back to the stale
 * active slot's numbers.
 */
function PendingShadowBanner({
  shadow, fanout,
}: {
  shadow?: ShadowStateResponse;
  fanout?: VectorStatsResponse['fanout'];
}) {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['vector-stats'] });
    qc.invalidateQueries({ queryKey: ['reembed-jobs'] });
    qc.invalidateQueries({ queryKey: ['shadow-state'] });
  };
  const resume = useMutation({ mutationFn: () => api.resumeReembedJob(), onSettled: invalidate });
  const discard = useMutation({ mutationFn: () => api.discardShadow(), onSettled: invalidate });
  const promote = useMutation({ mutationFn: () => api.promoteShadowAnyway(), onSettled: invalidate });

  const split = (fanout ?? []).filter(f => f.texts > 0);
  const pending = shadow?.pending;
  if (!pending && split.length === 0) return null;

  return (
    <>
      {pending && (
        <div className="px-6 py-4 bg-sky-50 border-b border-sky-200 text-sm space-y-2">
          <div className="text-sky-900">
            <strong>A rebuild is banked, not lost.</strong>{' '}
            <strong>{pending.rows.toLocaleString()}</strong> vectors across{' '}
            <strong>{pending.projects}</strong> projects are waiting in{' '}
            <code className="text-xs">{pending.name}</code>
            {pending.job && <> · paused at {pending.job.doneProjects}/{pending.job.totalProjects} projects</>}.
            {' '}The live table is untouched and still serving searches.
          </div>
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => resume.mutate()}
              disabled={shadow?.canResume === false || resume.isPending}
              title="Continue from the banked vectors, skipping projects already complete."
              className="px-3 py-1 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 text-sm"
            >{resume.isPending ? 'Resuming…' : 'Resume'}</button>
            <button
              onClick={() => {
                if (confirm(
                  `Promote ${pending.rows.toLocaleString()} vectors across ${pending.projects} projects `
                  + 'to the live table.\n\nAny project missing from this rebuild will have NO vectors '
                  + 'until you run a fill-missing pass.\n\nPromote anyway?',
                )) promote.mutate();
              }}
              disabled={shadow?.canPromoteAnyway === false || promote.isPending}
              title="Ship this shadow now rather than leaving the work unreachable behind a completeness check."
              className="px-3 py-1 bg-violet-600 text-white rounded-md hover:bg-violet-700 disabled:opacity-50 text-sm"
            >{promote.isPending ? 'Promoting…' : 'Promote anyway'}</button>
            <button
              onClick={() => {
                if (confirm(
                  `Discard permanently destroys ${pending.rows.toLocaleString()} vectors across `
                  + `${pending.projects} projects.\n\nThis cannot be undone and is the only irreversible `
                  + 'action here — Resume continues the work instead.\n\nDiscard anyway?',
                )) discard.mutate();
              }}
              disabled={shadow?.canDiscard === false || discard.isPending}
              title="Delete the banked vectors. Irreversible."
              className="px-3 py-1 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 text-sm"
            >{discard.isPending ? 'Discarding…' : 'Discard'}</button>
          </div>
        </div>
      )}
      {split.length > 0 && (
        <div className="px-6 py-2 border-b border-gray-200 text-xs text-gray-600 flex flex-wrap gap-x-4 gap-y-1">
          <span className="font-medium text-gray-700">Fan-out:</span>
          {split.map(f => (
            <span key={f.provider} className={f.cloud ? 'text-violet-700' : ''}>
              {f.provider} {f.texts.toLocaleString()}
              <span className="text-gray-400"> ({f.projects} proj)</span>
            </span>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Is this provider an OpenRouter-backed (cloud) one rather than a local GPU?
 *
 * Virtual providers are named `<PCName>-OR-<Role>` by `virtualProviderName()`
 * on the server, and `getFleetEmbeddingSplit()` uses the same `-OR-` test to
 * set the `cloud` flag on the fleet strip above. The per-project column has no
 * flag to read — `servedBy` carries bare names — so it applies the same rule.
 */
function isCloudProvider(name: string): boolean {
  return name.includes('-OR-');
}

/**
 * How a provider is labelled in the narrow per-project column.
 *
 * Local hosts drop the mDNS `.local` suffix. Cloud providers keep the `-OR`
 * marker (so `BASWS35` the GPU and `BASWS35-OR` the cloud route are never
 * confused for one another) but drop the role suffix, which is the same for
 * every row in this column.
 *
 * The UPSTREAM provider (DeepInfra and friends) is deliberately never
 * rendered: the operator's unit of attribution is the machine whose key and
 * policy served the texts, not whichever backend OpenRouter happened to pick.
 */
function providerLabel(name: string): string {
  if (isCloudProvider(name)) return name.replace(/-OR-.*$/, '-OR');
  return name.replace(/\.local$/, '');
}

export function ProjectVectorTable() {
  const qc = useQueryClient();

  const { data: stats, isLoading } = useQuery({
    queryKey: ['vector-stats'],
    queryFn: () => api.getVectorStats(),
    refetchInterval: 10_000,
  });
  const { data: modelStatus } = useQuery({
    queryKey: ['vectors-model-status'],
    queryFn: () => api.getModelStatus(),
    refetchInterval: 30_000,
  });
  // Separate from /vectors/stats because counting distinct projects in the
  // shadow is a column scan — too costly for the 10 s stats poll, but needed
  // by every destructive confirmation here.
  const { data: shadow } = useQuery({
    queryKey: ['shadow-state'],
    queryFn: () => api.getShadowState(),
    refetchInterval: 15_000,
  });

  const [sort, setSort] = useState<'coverage' | 'nodes' | 'name'>('coverage');
  const [filter, setFilter] = useState<'all' | 'incomplete' | 'mismatch'>('all');
  const [busyId, setBusyId] = useState<number | null>(null);

  const reEmbed = useMutation({
    mutationFn: (projectId: number) => api.reEmbed(projectId),
    onMutate: (id) => setBusyId(id),
    onSettled: () => {
      setBusyId(null);
      qc.invalidateQueries({ queryKey: ['vector-stats'] });
      qc.invalidateQueries({ queryKey: ['vector-coverage'] });
    },
  });

  // Re-embed = destructive full regenerate (drops vectors); Resume = incremental,
  // embeds only missing nodes, safe to click repeatedly.
  const resume = useMutation({
    mutationFn: (projectId: number) => api.resumeProject(projectId),
    onMutate: (id) => setBusyId(id),
    onSettled: () => {
      setBusyId(null);
      qc.invalidateQueries({ queryKey: ['vector-stats'] });
      qc.invalidateQueries({ queryKey: ['vector-coverage'] });
    },
  });

  // Re-embed ALL goes through the async JOB route (not the synchronous
  // /vectors/re-embed/0): a full 243-project rebuild takes tens of minutes and
  // would time out a synchronous HTTP request. The job drops the table on a dim
  // change, then rebuilds in the background; GlobalProgressPanel polls
  // listReembedJobs and renders live progress.
  const reEmbedAll = useMutation({
    // `confirm: true` — the button's own dialog already showed the exact cost
    // of destroying a banked shadow, so the server-side 409 guard would only
    // be a second, blinder prompt.
    mutationFn: () => api.startReembedJob(0, 50, true),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['vector-stats'] });
      qc.invalidateQueries({ queryKey: ['reembed-jobs'] });
      qc.invalidateQueries({ queryKey: ['shadow-state'] });
    },
  });

  const configuredModel = modelStatus?.code.configuredModel ?? null;
  const configuredDims = modelStatus?.code.configuredDimensions ?? null;

  const rows = useMemo(() => {
    const all = stats?.projects ?? [];
    let filtered = all;
    if (filter === 'incomplete') {
      filtered = all.filter(
        (p) => p.nodeCount > 0 && p.vectorCount < p.nodeCount,
      );
    } else if (filter === 'mismatch') {
      filtered = all.filter(
        (p) =>
          p.embeddingModel != null &&
          configuredModel != null &&
          p.embeddingModel !== configuredModel,
      );
    }
    const sorted = [...filtered].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'nodes') return b.nodeCount - a.nodeCount;
      // coverage: lowest first (worst projects on top)
      const aCov = a.nodeCount > 0 ? a.vectorCount / a.nodeCount : 1;
      const bCov = b.nodeCount > 0 ? b.vectorCount / b.nodeCount : 1;
      if (aCov !== bCov) return aCov - bCov;
      return b.nodeCount - a.nodeCount;
    });
    return sorted;
  }, [stats, sort, filter, configuredModel]);

  if (isLoading) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <div className="animate-pulse h-4 bg-gray-200 rounded w-1/3 mb-4" />
        <div className="animate-pulse h-32 bg-gray-100 rounded" />
      </div>
    );
  }

  const totalProjects = stats?.projects.length ?? 0;
  const incomplete = (stats?.projects ?? []).filter(
    (p) => p.nodeCount > 0 && p.vectorCount < p.nodeCount,
  ).length;
  const mismatched = (stats?.projects ?? []).filter(
    (p) =>
      p.embeddingModel != null &&
      configuredModel != null &&
      p.embeddingModel !== configuredModel,
  ).length;

  return (
    <div className="mt-8 bg-white rounded-lg shadow">
      <PendingShadowBanner shadow={shadow} fanout={stats?.fanout} />
      <div className="px-6 py-4 border-b border-gray-200 flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold text-gray-900">
          Vector Coverage by Project
        </h2>
        <span className="text-sm text-gray-500">
          {totalProjects} projects · {incomplete} incomplete
          {configuredModel && (
            <>
              {' '}· model: <span className="font-mono text-xs">{configuredModel}</span>
              {configuredDims && (
                <span className="text-gray-400"> ({configuredDims}d)</span>
              )}
            </>
          )}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
            className="text-sm border border-gray-300 rounded-md px-2 py-1"
          >
            <option value="all">All ({totalProjects})</option>
            <option value="incomplete">Incomplete ({incomplete})</option>
            <option value="mismatch">Model mismatch ({mismatched})</option>
          </select>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
            className="text-sm border border-gray-300 rounded-md px-2 py-1"
          >
            <option value="coverage">Sort: lowest coverage</option>
            <option value="nodes">Sort: most nodes</option>
            <option value="name">Sort: name</option>
          </select>
          <button
            onClick={() => {
              // A fresh full re-embed rebuilds the inactive slot from scratch,
              // which destroys whatever a pause banked there. Say so in the
              // same click, with the count — otherwise this button and the
              // "your work is safe" banner above it contradict each other.
              const banked = shadow?.pending;
              if (
                confirm(
                  `Re-embed ALL ${totalProjects} projects with ${configuredModel ?? 'configured model'}? `
                  + 'This will drop existing vectors and regenerate. May take a while.'
                  + (banked
                    ? `\n\nWARNING: this DESTROYS the ${banked.rows.toLocaleString()} vectors across `
                      + `${banked.projects} projects currently banked in ${banked.name}. `
                      + 'Use Resume above to continue that work instead.'
                    : ''),
                )
              )
                reEmbedAll.mutate();
            }}
            disabled={reEmbedAll.isPending}
            className="text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-md px-3 py-1.5 disabled:opacity-50"
          >
            {reEmbedAll.isPending ? 'Re-embedding all…' : 'Re-embed all'}
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2 text-left font-medium text-gray-500 uppercase tracking-wider">
                Project
              </th>
              <th className="px-4 py-2 text-right font-medium text-gray-500 uppercase tracking-wider">
                Nodes
              </th>
              <th className="px-4 py-2 text-right font-medium text-gray-500 uppercase tracking-wider">
                Vectors
              </th>
              <th className="px-4 py-2 text-left font-medium text-gray-500 uppercase tracking-wider">
                Coverage
              </th>
              <th className="px-4 py-2 text-left font-medium text-gray-500 uppercase tracking-wider">
                Model
              </th>
              <th className="px-4 py-2 text-left font-medium text-gray-500 uppercase tracking-wider">
                Sidecar
              </th>
              <th className="px-4 py-2 text-right font-medium text-gray-500 uppercase tracking-wider">
                Action
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-100">
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                  {filter === 'all' ? 'No projects' : 'No projects match this filter'}
                </td>
              </tr>
            )}
            {rows.map((p) => {
              const coverage =
                p.nodeCount > 0 ? p.vectorCount / p.nodeCount : 0;
              // Clamp displayed % at 100. Underlying ratios > 1.0 happen
              // when nodeCount is stale (e.g. tree-sitter projects whose
              // Prisma counts haven't been written back yet). Showing
              // 5220% is alarming and meaningless; instead we cap at
              // "100%+" with a drift indicator so the operator sees
              // something is off without thinking storage exploded.
              const drift = coverage > 1.05; // 5% slack for rounding
              const pct = drift ? '100%+' : (coverage * 100).toFixed(1) + '%';
              const fullyCovered =
                p.nodeCount > 0 && p.vectorCount >= p.nodeCount;
              const mismatch =
                p.embeddingModel != null &&
                configuredModel != null &&
                p.embeddingModel !== configuredModel;
              const rowClass = drift
                ? 'bg-amber-50/50'
                : mismatch
                ? 'bg-amber-50/50'
                : fullyCovered
                ? ''
                : p.nodeCount > 0
                ? 'bg-gray-50/50'
                : '';
              return (
                <tr key={p.id} className={rowClass}>
                  <td className="px-4 py-2 whitespace-nowrap text-gray-900">
                    <span className="font-mono text-xs text-gray-400 mr-1">
                      #{p.id}
                    </span>
                    {p.name}
                  </td>
                  <td className="px-4 py-2 text-right text-gray-700 tabular-nums">
                    {p.nodeCount.toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-right text-gray-700 tabular-nums">
                    {p.vectorCount.toLocaleString()}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <div className="w-24 bg-gray-200 rounded-full h-1.5">
                        <div
                          className={`h-1.5 rounded-full ${
                            fullyCovered
                              ? 'bg-emerald-500'
                              : coverage > 0
                              ? 'bg-indigo-500'
                              : 'bg-gray-300'
                          }`}
                          style={{ width: `${Math.min(coverage * 100, 100)}%` }}
                        />
                      </div>
                      <span className="text-xs tabular-nums text-gray-600 w-12 text-right">
                        {pct}%
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    {p.embeddingModel ? (
                      <span
                        className={`font-mono text-xs ${
                          mismatch ? 'text-amber-700' : 'text-gray-600'
                        }`}
                        title={mismatch ? `Stored: ${p.embeddingModel} · configured: ${configuredModel}` : undefined}
                      >
                        {p.embeddingModel}
                        {p.embeddingDimensions && (
                          <span className="text-gray-400"> ({p.embeddingDimensions}d)</span>
                        )}
                        {mismatch && <span className="ml-1">⚠</span>}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    {p.embeddedInProcess ? (
                      <span className="text-xs text-gray-500">in-process</span>
                    ) : p.embeddingSidecarName ? (
                      <span
                        className="text-xs text-gray-700"
                        title={[
                          p.embeddingSidecarHost,
                          p.embeddingSidecarModel,
                          p.embeddedAt,
                          p.embeddingServedBy?.length
                            ? `served by: ${p.embeddingServedBy.map((s) => `${s.name} (${s.texts})`).join(', ')}`
                            : null,
                          p.embeddingSelectedSidecarName && p.embeddingSelectedSidecarName !== p.embeddingSidecarName
                            ? `selected ${p.embeddingSelectedSidecarName}, failed over`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      >
                        {/* A project is embedded by the whole fleet, not one
                            host. Showing only the top contributor made the
                            fan-out look like a lock to a single sidecar, so
                            render every host with its share.

                            The gate used to be `> 1`, which sent every
                            single-provider project to the `embeddingSidecarName`
                            fallback below — including a project served entirely
                            by cloud, which then rendered with the LOCAL 🛰. One
                            entry is still a fan-out; render it the same way, so
                            cloud is visible in exactly the case the operator
                            most wants to see it.

                            Per-entry icons rather than one leading icon: 🛰 for
                            a local GPU, ☁ for an OpenRouter-backed provider, in
                            violet to match the fleet strip at the top of this
                            table. An all-cloud row, an all-local row and a
                            mixed row are then each unambiguous. */}
                        {(p.embeddingServedBy?.length ?? 0) > 0 ? (
                          (() => {
                            const by = [...(p.embeddingServedBy ?? [])].sort((a, b) => b.texts - a.texts);
                            const total = by.reduce((n, x) => n + x.texts, 0) || 1;
                            return by.map((x, i) => {
                              const cloud = isCloudProvider(x.name);
                              return (
                                <span key={x.name}>
                                  {i > 0 && <span className="text-gray-300"> · </span>}
                                  <span className={cloud ? 'text-violet-700' : i === 0 ? 'text-gray-700' : 'text-gray-500'}>
                                    {cloud ? '☁' : '🛰'} {providerLabel(x.name)}
                                  </span>
                                  <span className={`ml-0.5 text-[10px] ${cloud ? 'text-violet-400' : 'text-gray-400'}`}>
                                    {Math.round((x.texts / total) * 100)}%
                                  </span>
                                </span>
                              );
                            });
                          })()
                        ) : (
                          /* Rows embedded before `servedBy` existed carry only
                             a single sidecar name. Keep rendering them. */
                          <>
                            {isCloudProvider(p.embeddingSidecarName) ? '☁' : '🛰'}{' '}
                            {providerLabel(p.embeddingSidecarName)}
                          </>
                        )}
                        {/* "failover" means the provider Fantom SELECTED served
                            nothing — not merely that someone else served more.
                            Comparing against the top contributor labelled every
                            fan-out a failover, and with cloud in the pool that is
                            now the common case rather than the exception: the
                            selected sidecar can be second on a perfectly healthy
                            run. Show it only when the selected provider is absent
                            from servedBy entirely. */}
                        {p.embeddingSelectedSidecarName
                          && (p.embeddingServedBy?.length
                            ? !p.embeddingServedBy.some((s) => s.name === p.embeddingSelectedSidecarName)
                            : p.embeddingSelectedSidecarName !== p.embeddingSidecarName) && (
                          <span
                            className="ml-1 rounded bg-amber-50 px-1 text-[10px] text-amber-700"
                            title={`selected ${p.embeddingSelectedSidecarName}, which served no texts`}
                          >failover</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex gap-2 justify-end">
                      <button
                        onClick={() => reEmbed.mutate(p.id)}
                        disabled={busyId === p.id || p.nodeCount === 0}
                        className={`text-xs font-medium rounded-md px-2 py-1 ${
                          mismatch
                            ? 'text-white bg-amber-600 hover:bg-amber-700'
                            : 'text-indigo-700 bg-indigo-50 hover:bg-indigo-100'
                        } disabled:opacity-50 disabled:cursor-not-allowed`}
                        title={
                          p.nodeCount === 0
                            ? 'No nodes to embed'
                            : `Drop and regenerate vectors for ${p.name}`
                        }
                      >
                        {busyId === p.id ? 'Working…' : 'Re-embed'}
                      </button>
                      <button
                        onClick={() => resume.mutate(p.id)}
                        disabled={busyId === p.id || p.nodeCount === 0}
                        className="text-xs font-medium rounded-md px-2 py-1 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 disabled:opacity-50 disabled:cursor-not-allowed"
                        title={`Resume embedding for ${p.name} — fills in only missing vectors, keeps existing ones`}
                      >
                        {busyId === p.id ? 'Working…' : 'Resume'}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
