'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, getApiBase, ReembedJob } from '@/lib/api';

function authHeaderValue(): string {
  if (typeof window === 'undefined') return 'Basic ' + btoa('admin:admin');
  const u = localStorage.getItem('admin_user') || 'admin';
  const p = localStorage.getItem('admin_pass') || 'admin';
  return 'Basic ' + btoa(`${u}:${p}`);
}

function StatusBadge({ status }: { status: ReembedJob['status'] }) {
  const colors: Record<ReembedJob['status'], string> = {
    queued: 'bg-gray-200 text-gray-800',
    running: 'bg-blue-100 text-blue-800',
    done: 'bg-green-100 text-green-800',
    error: 'bg-red-100 text-red-800',
    // Paused is neither a failure nor a loss: the vectors are kept and the
    // job is resumable. Cancelled means the shadow was discarded.
    paused: 'bg-sky-100 text-sky-800',
    cancelled: 'bg-amber-100 text-amber-800',
  };
  return (
    <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${colors[status]}`}>
      {status}
    </span>
  );
}

function JobLogPanel({ jobId }: { jobId: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [paused, setPaused] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Initial tail load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.getJobLog(jobId, 1000);
        if (!cancelled) setLines(r.lines.filter(Boolean));
      } catch { /* ignore */ }
    })();

    // SSE follow.
    const es = new EventSource(`${getApiBase()}/admin/jobs/${jobId}/log/stream`, { withCredentials: true });
    es.onmessage = (ev) => {
      try {
        const { line } = JSON.parse(ev.data) as { line: string };
        if (line) setLines(prev => (prev.length > 5000 ? [...prev.slice(-4000), line] : [...prev, line]));
      } catch { /* ignore */ }
    };
    return () => { cancelled = true; es.close(); };
  }, [jobId]);

  useEffect(() => {
    if (paused) return;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, paused]);

  const filtered = useMemo(() => {
    if (!filter.trim()) return lines;
    const q = filter.toLowerCase();
    return lines.filter(l => l.toLowerCase().includes(q));
  }, [lines, filter]);

  return (
    <div className="space-y-2">
      <div className="flex gap-2 items-center">
        <input
          type="text"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="filter substring…"
          className="flex-1 px-3 py-1.5 border border-gray-300 rounded-md text-sm font-mono"
        />
        <span className="text-xs text-gray-500">{filtered.length}/{lines.length}</span>
        {['WORKER_', 'EMBED_LOOP', 'BPE', 'EMBED REQ', 'PROJECT_FAIL', 'PROJECT_OK'].map(q => (
          <button key={q} onClick={() => setFilter(q)} className="px-2 py-1 bg-gray-100 hover:bg-gray-200 text-xs rounded font-mono">
            {q}
          </button>
        ))}
        <button onClick={() => setFilter('')} className="px-2 py-1 bg-red-50 hover:bg-red-100 text-red-700 text-xs rounded">clear</button>
        <button
          onClick={() => setPaused(p => !p)}
          className={`px-2 py-1 rounded text-xs ${paused ? 'bg-amber-500 text-white' : 'bg-gray-100 text-gray-800'}`}
        >
          {paused ? 'resume scroll' : 'pause scroll'}
        </button>
      </div>
      <div
        ref={containerRef}
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        className="h-[420px] overflow-auto bg-gray-900 text-gray-100 text-xs font-mono p-3 rounded-md"
      >
        {filtered.length === 0 && (
          <div className="text-gray-500">no log lines{filter ? ` match "${filter}"` : ' for this job yet'}</div>
        )}
        {filtered.map((l, i) => {
          const lower = l.toLowerCase();
          const cls =
            lower.includes('project_fail') || lower.includes('error') || lower.includes('uncaught') || lower.includes('req fail')
              ? 'text-red-300'
              : lower.includes('warn') || lower.includes('timeout')
                ? 'text-amber-300'
                : lower.includes('worker_') || lower.includes('embed_loop')
                  ? 'text-cyan-300'
                  : lower.includes('bpe ')
                    ? 'text-emerald-300'
                    : lower.includes('embed_sem')
                      ? 'text-violet-300'
                      : 'text-gray-100';
          return <div key={i} className={`whitespace-pre-wrap break-all ${cls}`}>{l}</div>;
        })}
      </div>
    </div>
  );
}

export default function JobsPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['jobs'],
    queryFn: api.listJobs,
    refetchInterval: 1500,
  });

  // The pending shadow drives the Pause banner and both confirmations: a
  // destructive action has to be able to say how much it destroys.
  const { data: shadow } = useQuery({
    queryKey: ['shadow-state'],
    queryFn: api.getShadowState,
    refetchInterval: 5_000,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['jobs'] });
    queryClient.invalidateQueries({ queryKey: ['shadow-state'] });
    queryClient.invalidateQueries({ queryKey: ['vector-stats'] });
  };

  /** DISCARD — halts the job and destroys the shadow. Irreversible. */
  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.cancelReembedJob(id),
    onSuccess: invalidate,
  });

  /** PAUSE — halts the job and keeps the shadow. */
  const pauseMutation = useMutation({
    mutationFn: (id: string) => api.pauseReembedJob(id),
    onSuccess: invalidate,
  });

  const resumeMutation = useMutation({
    mutationFn: () => api.resumeReembedJob(),
    onSuccess: invalidate,
  });

  const promoteMutation = useMutation({
    mutationFn: () => api.promoteShadowAnyway(),
    onSuccess: invalidate,
  });

  const jobs = data?.jobs ?? [];
  const selected = jobs.find(j => j.id === selectedId) ?? jobs[0];
  useEffect(() => {
    if (!selectedId && jobs.length > 0) setSelectedId(jobs[0].id);
  }, [jobs, selectedId]);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Jobs</h1>
        <p className="text-gray-600 mt-1">Live view of background embed jobs and per-job logs.</p>
      </div>

      {isLoading && <div className="text-gray-500">Loading…</div>}
      {error && <div className="text-red-600">Failed to load jobs: {String((error as Error).message)}</div>}

      {!isLoading && jobs.length === 0 && (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-6 text-sm text-gray-600">
          No jobs yet. Hit Resume Embed on the Home page to create one.
        </div>
      )}

      {jobs.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-[400px_1fr] gap-4">
          <div className="space-y-2">
            {jobs.map(j => {
              const isSel = selected?.id === j.id;
              const pct = j.totalProjects > 0 ? Math.round((j.doneProjects / j.totalProjects) * 100) : 0;
              return (
                <button
                  key={j.id}
                  onClick={() => setSelectedId(j.id)}
                  className={`w-full text-left p-3 rounded-lg border transition-colors ${isSel ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white hover:bg-gray-50'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <code className="text-xs text-gray-700 truncate">{j.id.slice(0, 8)}…</code>
                    <StatusBadge status={j.status} />
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    scope: {typeof j.scope === 'string' ? j.scope : `project ${j.scope.projectId}`}
                  </div>
                  <div className="mt-2 text-sm text-gray-800">
                    {j.doneProjects}/{j.totalProjects} projects
                    {j.currentProjectId !== undefined && j.status === 'running' && (
                      <span className="ml-2 text-blue-700">→ pid {j.currentProjectId}</span>
                    )}
                  </div>
                  <div className="mt-2 h-1.5 bg-gray-100 rounded overflow-hidden">
                    <div className="h-full bg-blue-500" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    generated: {j.generated} · errors: {j.errors.length}
                  </div>
                  <div className="mt-1 text-xs text-gray-400">
                    {new Date(j.startedAt).toLocaleTimeString()}{j.finishedAt ? ` → ${new Date(j.finishedAt).toLocaleTimeString()}` : ''}
                  </div>
                </button>
              );
            })}
          </div>

          {selected && (
            <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">Job {selected.id.slice(0, 8)}</h2>
                  <code className="text-xs text-gray-500">{selected.id}</code>
                </div>
                <div className="flex gap-2 items-center">
                  <StatusBadge status={selected.status} />
                  {/* Pause keeps the vectors; Discard destroys them. Only the
                      second is irreversible, so only it confirms — and its
                      confirmation states the exact cost. */}
                  {(selected.status === 'queued' || selected.status === 'running') && (
                    <button
                      onClick={() => pauseMutation.mutate(selected.id)}
                      disabled={pauseMutation.isPending || selected.pauseRequested}
                      title="Stop work and keep every vector written so far. Resume picks up where this left off."
                      className="px-3 py-1 bg-sky-600 text-white rounded-md hover:bg-sky-700 disabled:opacity-50 text-sm"
                    >
                      {selected.pauseRequested ? 'pausing…' : 'Pause'}
                    </button>
                  )}
                  {(selected.status === 'queued' || selected.status === 'running' || selected.status === 'paused') && (
                    <button
                      onClick={() => {
                        const banked = shadow?.pending;
                        const what = banked
                          ? `${banked.rows.toLocaleString()} vectors across ${banked.projects} projects`
                          : 'every vector written by this rebuild';
                        if (confirm(
                          `Discard permanently destroys ${what}.\n\n`
                          + 'This cannot be undone and is the only irreversible action here — '
                          + 'Pause keeps the work and Resume continues it.\n\nDiscard anyway?',
                        )) cancelMutation.mutate(selected.id);
                      }}
                      disabled={cancelMutation.isPending || selected.cancelRequested}
                      title="Stop work AND delete the vectors written so far. Irreversible."
                      className="px-3 py-1 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 text-sm"
                    >
                      {selected.cancelRequested ? 'discarding…' : 'Discard'}
                    </button>
                  )}
                </div>
              </div>

              {/* A paused job must show its progress next to the banked work,
                  or a pause reads as a wipe — which is exactly how a stop that
                  preserved 225,008 rows across 324 projects was misread. */}
              {selected.status === 'paused' && (
                <div className="bg-sky-50 border border-sky-200 rounded-md p-3 text-sm space-y-2">
                  <div className="text-sky-900">
                    <strong>Paused — nothing was lost.</strong>{' '}
                    {selected.doneProjects}/{selected.totalProjects} projects complete
                    {shadow?.pending && (
                      <>, <strong>{shadow.pending.rows.toLocaleString()}</strong> vectors across{' '}
                      <strong>{shadow.pending.projects}</strong> projects banked in{' '}
                      <code className="text-xs">{shadow.pending.name}</code></>
                    )}. The live table is untouched and still serving searches.
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    <button
                      onClick={() => resumeMutation.mutate()}
                      disabled={resumeMutation.isPending || shadow?.jobRunning}
                      title="Continue from the banked vectors, skipping projects already complete."
                      className="px-3 py-1 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 text-sm"
                    >{resumeMutation.isPending ? 'Resuming…' : 'Resume'}</button>
                    {shadow?.pending && shadow.canPromoteAnyway && (
                      <button
                        onClick={() => {
                          const missing = Math.max(0, selected.totalProjects - shadow.pending!.projects);
                          if (confirm(
                            `Promote ${shadow.pending!.rows.toLocaleString()} vectors across `
                            + `${shadow.pending!.projects} projects to the live table.\n\n`
                            + (missing > 0
                              ? `${missing} project(s) will have NO vectors until you run a fill-missing pass.\n\n`
                              : '')
                            + 'Promote anyway?',
                          )) promoteMutation.mutate();
                        }}
                        disabled={promoteMutation.isPending}
                        title="Ship this shadow now rather than leaving the work unreachable behind a completeness check."
                        className="px-3 py-1 bg-violet-600 text-white rounded-md hover:bg-violet-700 disabled:opacity-50 text-sm"
                      >{promoteMutation.isPending ? 'Promoting…' : 'Promote anyway'}</button>
                    )}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <div className="bg-gray-50 p-2 rounded">
                  <div className="text-xs text-gray-500">Total projects</div>
                  <div className="font-semibold">{selected.totalProjects}</div>
                </div>
                <div className="bg-gray-50 p-2 rounded">
                  <div className="text-xs text-gray-500">Done</div>
                  <div className="font-semibold">{selected.doneProjects}</div>
                </div>
                <div className="bg-gray-50 p-2 rounded">
                  <div className="text-xs text-gray-500">Generated</div>
                  <div className="font-semibold">{selected.generated}</div>
                </div>
                <div className="bg-gray-50 p-2 rounded">
                  <div className="text-xs text-gray-500">Errors</div>
                  <div className="font-semibold">{selected.errors.length}</div>
                </div>
              </div>

              {selected.errors.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-md p-2 text-xs text-red-800 max-h-32 overflow-auto space-y-1">
                  {selected.errors.slice(-10).map((e, i) => (
                    <div key={i} className="font-mono">project {e.projectId}: {e.message}</div>
                  ))}
                </div>
              )}

              <div>
                <div className="text-sm font-medium text-gray-700 mb-2">Live log</div>
                <JobLogPanel jobId={selected.id} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
