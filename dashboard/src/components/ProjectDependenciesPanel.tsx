'use client';

/**
 * Project dependencies (ask scope) — shared by the Pods & Projects page and
 * the vector viewer. Shows "Depends on" / "Used by" with kind badges (raw
 * source on hover), confidence, an enabled toggle (PATCH), manual add/delete,
 * a per-project "Rebuild dependencies" button and, optionally, the declared
 * build.fan / package.json entries with their resolution (unresolved greyed).
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, DeclaredDependency, ProjectDependencyRow, ProjectDependencySummary } from '@/lib/api';

const KIND_STYLE: Record<string, string> = {
  'build.fan-depends': 'bg-blue-100 text-blue-700',
  'package.json': 'bg-emerald-100 text-emerald-700',
  'cross-project-edges': 'bg-orange-100 text-orange-700',
  'workspace-sibling': 'bg-slate-100 text-slate-600',
  manual: 'bg-purple-100 text-purple-700',
};

const KIND_LABEL: Record<string, string> = {
  'build.fan-depends': 'build.fan',
  'package.json': 'package.json',
  'cross-project-edges': 'cross-project-edges',
  'workspace-sibling': 'workspace',
  manual: 'manual',
};

export function KindBadge({ kind, source }: { kind: string; source?: string | null }) {
  return (
    <span
      className={`text-[11px] px-1.5 py-0.5 rounded font-mono whitespace-nowrap ${KIND_STYLE[kind] ?? 'bg-gray-100 text-gray-600'}`}
      title={source ? `${kind}: ${source}` : kind}
    >
      {KIND_LABEL[kind] ?? kind}
    </span>
  );
}

/** "↑3 ↓2" connectivity badge for list rows (enabled relations only). */
export function DependencyCounts({
  projectId,
  summary,
  onClick,
  active,
}: {
  projectId: number | undefined;
  summary: ProjectDependencySummary | undefined;
  onClick?: () => void;
  active?: boolean;
}) {
  const c = projectId != null ? summary?.counts?.[projectId] : undefined;
  const up = c?.dependsOn ?? 0;
  const down = c?.dependents ?? 0;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={projectId == null}
      title={projectId == null ? 'Not an indexed project' : `Depends on ${up} · used by ${down} — click to show related projects`}
      className={`text-xs px-2 py-0.5 rounded font-mono border transition-colors ${
        active ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
      } disabled:opacity-40`}
    >
      ↑{up} ↓{down}
    </button>
  );
}

function formatRebuild(r: { added: number; updated: number; removed: number; kinds: Record<string, number>; durationMs: number }): string {
  const kinds = Object.entries(r.kinds).map(([k, v]) => `${KIND_LABEL[k] ?? k} ${v}`).join(', ');
  return `+${r.added} ~${r.updated} -${r.removed}${kinds ? ` (${kinds})` : ''} in ${r.durationMs} ms`;
}

function DependencyList({
  title,
  rows,
  projectId,
  emptyText,
}: {
  title: string;
  rows: ProjectDependencyRow[];
  projectId: number;
  emptyText: string;
}) {
  const queryClient = useQueryClient();
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['project-dependencies', projectId] });
    queryClient.invalidateQueries({ queryKey: ['project-dependency-summary'] });
  };
  const toggle = useMutation({
    mutationFn: ({ depId, enabled }: { depId: number; enabled: boolean }) => api.setDependencyEnabled(projectId, depId, enabled),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (depId: number) => api.deleteDependency(projectId, depId),
    onSuccess: invalidate,
  });

  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">
        {title} <span className="font-normal text-gray-400">({rows.length})</span>
      </h4>
      {rows.length === 0 ? (
        <p className="text-xs text-gray-400">{emptyText}</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((r) => (
            <li
              key={r.id}
              className={`flex items-center gap-2 text-sm rounded px-2 py-1 ${r.enabled ? 'bg-gray-50' : 'bg-gray-50 opacity-50'}`}
            >
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-indigo-600"
                checked={r.enabled}
                title={r.enabled ? 'Enabled — in ask scope. Uncheck to switch off (kept across rebuilds).' : 'Disabled — not in ask scope'}
                onChange={(e) => toggle.mutate({ depId: r.id, enabled: e.target.checked })}
                disabled={toggle.isPending}
              />
              <span className="font-medium text-gray-800 truncate" title={r.path ?? undefined}>
                {r.name ?? `#${r.projectId}`}
              </span>
              {r.language && <span className="text-[11px] text-gray-400">{r.language}</span>}
              <KindBadge kind={r.kind} source={r.source} />
              <span className="text-[11px] text-gray-400 font-mono ml-auto" title="confidence">
                {Math.round(r.confidence * 100)}%
              </span>
              {r.kind === 'manual' && (
                <button
                  type="button"
                  onClick={() => remove.mutate(r.id)}
                  disabled={remove.isPending}
                  className="text-[11px] text-red-600 hover:text-red-800"
                  title="Delete this manual dependency"
                >
                  remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DeclaredList({ declared }: { declared: DeclaredDependency[] }) {
  const groups = useMemo(() => {
    const m = new Map<string, DeclaredDependency[]>();
    for (const d of declared) {
      const list = m.get(d.from) ?? [];
      list.push(d);
      m.set(d.from, list);
    }
    return [...m.entries()];
  }, [declared]);
  if (declared.length === 0) return null;
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">
        Declared <span className="font-normal text-gray-400">(build.fan / package.json — grey = not an indexed project)</span>
      </h4>
      <div className="space-y-1">
        {groups.map(([from, items]) => (
          <div key={from} className="flex flex-wrap items-center gap-1 text-xs">
            <span className="font-mono text-gray-500 mr-1">{from}:</span>
            {items.map((d) => (
              <span
                key={`${from}:${d.raw}`}
                title={d.resolvedProjectName ? `${d.raw} → ${d.resolvedProjectName} (#${d.resolvedProjectId})` : `${d.raw} — not indexed`}
                className={`px-1.5 py-0.5 rounded font-mono ${
                  d.resolvedProjectId != null ? 'bg-blue-50 text-blue-800 border border-blue-200' : 'bg-gray-100 text-gray-400'
                }`}
              >
                {d.name}
                {d.resolvedProjectName && <span className="text-blue-500"> → {d.resolvedProjectName}</span>}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ProjectDependenciesPanel({
  projectId,
  showDeclared = true,
  className = '',
}: {
  projectId: number;
  showDeclared?: boolean;
  className?: string;
}) {
  const queryClient = useQueryClient();
  /**
   * Collapsed by default.
   *
   * Expanded, this panel is tall enough to push whatever the operator clicks
   * next off-screen — pick a project, the dependency list unfurls, and the
   * next project in the list has jumped somewhere below the fold. The panel is
   * for CHANGING relationships, which is occasional; browsing projects is the
   * common path and should not pay for it.
   *
   * Per project, deliberately: opening it for one project and then selecting
   * another re-collapses, because the answer to "do I want to edit this
   * project's dependencies" is almost always no again.
   */
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [projectId]);
  const [addTarget, setAddTarget] = useState<number | ''>('');
  const [message, setMessage] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['project-dependencies', projectId],
    // Collapsed by default now, and a collapsed panel has no reason to poll
    // two endpoints every 10s on the dashboard-wide default.
    enabled: open,
    queryFn: () => api.getProjectDependencies(projectId),
  });
  const { data: projectsData } = useQuery({
    queryKey: ['code-projects'],
    // Collapsed by default now, and a collapsed panel has no reason to poll
    // two endpoints every 10s on the dashboard-wide default.
    enabled: open,
    queryFn: api.getCodeProjects,
    staleTime: 60_000,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['project-dependencies', projectId] });
    queryClient.invalidateQueries({ queryKey: ['project-dependency-summary'] });
  };

  const rebuild = useMutation({
    mutationFn: () => api.rebuildProjectDependencies(projectId),
    onSuccess: (r) => {
      setMessage(`Rebuilt: ${formatRebuild(r)}`);
      invalidate();
    },
    onError: (e) => setMessage(`Rebuild failed: ${e instanceof Error ? e.message : String(e)}`),
  });
  const addManual = useMutation({
    mutationFn: (toProjectId: number) => api.addManualDependency(projectId, toProjectId),
    onSuccess: (r) => {
      setMessage(`Added manual dependency → ${r.name ?? r.toProjectId}`);
      setAddTarget('');
      invalidate();
    },
    onError: (e) => setMessage(`Add failed: ${e instanceof Error ? e.message : String(e)}`),
  });

  const linked = useMemo(() => {
    const s = new Set<number>([projectId]);
    for (const r of data?.dependsOn ?? []) if (r.projectId != null) s.add(r.projectId);
    return s;
  }, [data, projectId]);
  const addOptions = (projectsData?.projects ?? []).filter((p) => !linked.has(p.id)).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className={`border border-gray-200 rounded-lg p-3 bg-white ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          aria-expanded={open}
          className="flex items-center gap-1.5 text-left min-w-0 flex-1 group"
          title={open ? 'Collapse' : 'Expand to view or change this project\u2019s dependencies'}
        >
          <span
            aria-hidden
            className={`text-gray-400 group-hover:text-gray-600 transition-transform ${open ? 'rotate-90' : ''}`}
          >
            ▶
          </span>
          <span className="min-w-0">
            <h3 className="text-sm font-semibold text-gray-800">
              Related projects (ask scope)
              {/* The counts stay visible while collapsed — the number is the
                  part worth seeing at a glance; the list is not. */}
              {data && (
                <span className="ml-1.5 font-normal text-gray-500">
                  ↑{data.dependsOn.length} ↓{data.dependents.length}
                </span>
              )}
            </h3>
            {open && data?.project?.summary && (
              <p className="text-xs text-gray-500 truncate">{data.project.summary}</p>
            )}
          </span>
        </button>
        {open && (
          <button
            type="button"
            onClick={() => rebuild.mutate()}
            disabled={rebuild.isPending}
            className="px-3 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50 shrink-0"
            title="Recompute build.fan / package.json / cross-project-edges / workspace relations for this project"
          >
            {rebuild.isPending ? 'Rebuilding…' : 'Rebuild dependencies'}
          </button>
        )}
      </div>

      {open && message && (
        <div className="mb-2 text-xs text-indigo-800 bg-indigo-50 rounded px-2 py-1 flex justify-between">
          <span>{message}</span>
          <button type="button" className="text-indigo-400 hover:text-indigo-700" onClick={() => setMessage(null)}>×</button>
        </div>
      )}

      {open && isLoading && <p className="text-xs text-gray-400 mt-2">Loading…</p>}
      {open && error && <p className="text-xs text-red-600">{error instanceof Error ? error.message : 'Failed to load dependencies'}</p>}

      {open && data && (
        <div className="space-y-3 mt-2">
          {/* Scope preview: what an ask scoped to this project will search */}
          <div className="flex flex-wrap items-center gap-1 text-xs">
            <span className="text-gray-500 mr-1">Ask searches:</span>
            <span className="px-1.5 py-0.5 rounded bg-indigo-600 text-white font-medium">{data.project.name}</span>
            {data.scope.map((s) => (
              <span
                key={s.id}
                className="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-800 border border-indigo-200"
                title={`${s.kinds.join(' + ')} · ${s.direction === 'dependent' ? 'depends on this project' : 'this project depends on it'} · ${Math.round(s.confidence * 100)}%${s.libraries.length ? ` · libs: ${s.libraries.slice(0, 6).join(', ')}` : ''}`}
              >
                {s.direction === 'dependent' ? '↓ ' : '↑ '}{s.name}
                <span className="text-indigo-400"> · {KIND_LABEL[s.kind] ?? s.kind}</span>
              </span>
            ))}
            {data.scope.length === 0 && <span className="text-gray-400">only this project</span>}
            {data.scopeFallback && (
              <span className="text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded" title="No persisted rows yet — same-directory siblings are used until the first rebuild">
                fallback: directory siblings
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <DependencyList title="Depends on" rows={data.dependsOn} projectId={projectId} emptyText="No dependencies recorded." />
            <DependencyList title="Used by" rows={data.dependents} projectId={projectId} emptyText="No dependents recorded." />
          </div>

          {/* Add manual dependency */}
          <div className="flex items-center gap-2 text-xs">
            <span className="text-gray-500">Add manual dependency:</span>
            <select
              className="border border-gray-300 rounded px-2 py-1 text-xs max-w-xs"
              value={addTarget}
              onChange={(e) => setAddTarget(e.target.value ? Number(e.target.value) : '')}
            >
              <option value="">Select a project…</option>
              {addOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.language ?? 'fantom'})
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={addTarget === '' || addManual.isPending}
              onClick={() => addTarget !== '' && addManual.mutate(addTarget)}
              className="px-2 py-1 bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50"
            >
              Add
            </button>
          </div>

          {showDeclared && <DeclaredList declared={data.declared} />}
        </div>
      )}
    </div>
  );
}
