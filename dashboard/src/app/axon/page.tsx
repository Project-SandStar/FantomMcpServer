'use client';

/**
 * Axon integration page — terminal-inspired dark panel.
 *
 * The MCP client is internal (no connection controls here): a single read-only
 * "Axon server" status line. Sections: status strip · paths (project + library,
 * each with validate) · autoIndex · jobs · two master/detail sections (synced
 * projects, offline library): left = project list with embed / re-index,
 * right = the selected project's functions (filter + pages) and, below, the
 * selected function's signature / doc / rendered embedding text.
 * Indexing/search never depend on the Axon server connection.
 */

import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type AxonSettings,
  type AxonProjectStatus,
  type AxonValidateResponse,
  type AxonLibraryValidateResponse,
  type AxonJob,
  type AxonRecordSource,
  type AxonFunctionRow,
} from '@/lib/api';

const T = {
  bg: 'bg-[#0b0f14]',
  panel: 'bg-[#10161d] border border-[#1f2a36]',
  panelHead: 'bg-[#0d1319] border-b border-[#1f2a36]',
  text: 'text-[#d7e0ea]',
  dim: 'text-[#7f93a8]',
  accent: 'text-[#5ee1a2]',
  warn: 'text-[#ffcc66]',
  err: 'text-[#ff6b6b]',
  input: 'bg-[#0b0f14] border border-[#2a3846] text-[#d7e0ea] placeholder-[#4f6274] focus:border-[#5ee1a2] focus:outline-none',
  btn: 'border border-[#2a3846] text-[#d7e0ea] hover:border-[#5ee1a2] hover:text-[#5ee1a2] disabled:opacity-40 disabled:cursor-not-allowed transition-colors',
  btnPrimary: 'bg-[#5ee1a2] text-[#0b0f14] font-semibold hover:bg-[#7cf0b8] disabled:opacity-40 disabled:cursor-not-allowed transition-colors',
  mono: 'font-mono',
  selected: 'bg-[#13241d] outline outline-1 outline-[#2f6b52]',
};

function Toggle({ value, onChange, label, hint }: { value: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button type="button" onClick={() => onChange(!value)} className="flex items-center gap-3 text-left" title={hint}>
      <span className={`relative inline-flex h-6 w-11 items-center rounded-full border transition-colors ${value ? 'bg-[#5ee1a2] border-[#5ee1a2]' : 'bg-[#0b0f14] border-[#2a3846]'}`}>
        <span className={`inline-block h-4 w-4 transform rounded-full transition-transform ${value ? 'translate-x-6 bg-[#0b0f14]' : 'translate-x-1 bg-[#7f93a8]'}`} />
      </span>
      <span className={`${T.mono} text-sm ${T.text}`}>{label} <span className={T.dim}>= {value ? 'true' : 'false'}</span></span>
    </button>
  );
}

function fmtTime(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function Bar({ pct }: { pct: number }) {
  return (
    <div className="h-1.5 w-20 rounded bg-[#1f2a36] overflow-hidden">
      <div className={`h-full ${pct >= 100 ? 'bg-[#5ee1a2]' : pct > 0 ? 'bg-[#ffcc66]' : 'bg-transparent'}`} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

// ── Master: project list ────────────────────────────────────────────────────

interface ProjectListProps {
  rows: AxonProjectStatus[];
  source: AxonRecordSource;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onIndex: (projectId: string) => void;
  blocked: boolean;
  loading: boolean;
  currentTextVersion?: number;
}

function ProjectList({ rows, source, selectedId, onSelect: select, onIndex, blocked, loading, currentTextVersion }: ProjectListProps) {
  // Keep the selected row in view so it sits next to its (sticky) detail column.
  const onSelect = (id: string) => {
    select(id);
    requestAnimationFrame(() => {
      document.getElementById(`axon-row-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  };
  // Arrow keys move the selection within the section; Enter/Space are native on the buttons.
  const onKey = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const i = rows.findIndex(r => r.projectId === selectedId);
    const next = e.key === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
    if (rows[next]) {
      e.preventDefault();
      onSelect(rows[next].projectId);
      (document.getElementById(`axon-row-${rows[next].projectId}`) as HTMLElement | null)?.focus();
    }
  };
  return (
    <div className="overflow-auto max-h-[560px]">
      <table className={`w-full ${T.mono} text-xs`}>
        <thead className={`${T.dim} text-left sticky top-0 bg-[#10161d] z-10`}>
          <tr className="border-b border-[#1f2a36]">
            <th className="px-3 py-2">{source === 'proj' ? 'instance/project' : 'folder'}</th>
            <th className="px-2 py-2 text-right">fns</th>
            <th className="px-2 py-2 text-right">vec</th>
            <th className="px-2 py-2">coverage</th>
            <th className="px-2 py-2">model</th>
            <th className="px-2 py-2">last run</th>
            <th className="px-2 py-2"></th>
          </tr>
        </thead>
        <tbody onKeyDown={onKey}>
          {rows.map(p => {
            const sel = p.projectId === selectedId;
            return (
              <tr key={p.projectId} className={`border-b border-[#141c25] hover:bg-[#0d1319] ${sel ? T.selected : ''}`}>
                <td className="px-3 py-1.5">
                  <button
                    id={`axon-row-${p.projectId}`}
                    className={`text-left w-full focus:outline-none focus:text-[#5ee1a2] ${sel ? T.accent : ''}`}
                    onClick={() => onSelect(p.projectId)}
                    aria-pressed={sel}
                    title={p.projectId}
                  >
                    {sel ? '▸ ' : '  '}{source === 'library' ? p.project : p.projectId}
                  </button>
                  {p.errors.length > 0 && <span className={`${T.err} ml-2`} title={p.errors.join('\n')}>✖ {p.errors.length}</span>}
                  {p.embedTextStale && <span className={`${T.warn} ml-2`} title={`vectors built with text v${p.embedTextVersion}; current v${currentTextVersion}`}>stale-text</span>}
                </td>
                <td className="px-2 py-1.5 text-right">{p.functionsFound}</td>
                <td className="px-2 py-1.5 text-right">{p.vectors}<span className={T.dim}>/{p.rows}</span></td>
                <td className="px-2 py-1.5"><div className="flex items-center gap-2"><Bar pct={p.embeddedPercent} /><span className={p.embeddedPercent >= 100 ? T.accent : p.embeddedPercent > 0 ? T.warn : T.dim}>{p.embeddedPercent}%</span></div></td>
                <td className={`px-2 py-1.5 ${T.dim} whitespace-nowrap`}>{p.model ? `${p.model} @${p.dimensions}d` : '—'}</td>
                <td className={`px-2 py-1.5 ${T.dim} whitespace-nowrap`}>{fmtTime(p.lastRun)}</td>
                <td className="px-2 py-1.5 text-right whitespace-nowrap">
                  <button className={`px-2 py-0.5 ${T.btn}`} onClick={(e) => { e.stopPropagation(); onIndex(p.projectId); }} disabled={blocked} title={p.vectors ? 'Re-embed this project' : 'Embed this project'}>
                    {p.vectors ? 're-index' : 'embed'}
                  </button>
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr><td colSpan={7} className={`px-3 py-4 ${T.dim}`}>{loading ? 'scanning…' : `no ${source === 'proj' ? 'synced projects' : 'library folders'} found — check the path`}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ── Detail: selected project's functions + selected function ────────────────

function ProjectDetail({ project }: { project: AxonProjectStatus | null }) {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [fn, setFn] = useState<AxonFunctionRow | null>(null);
  const projectId = project?.projectId ?? null;

  // Reset drawer state when the selection changes.
  useEffect(() => { setQ(''); setPage(1); setFn(null); }, [projectId]);

  const functions = useQuery({
    queryKey: ['axon-functions', projectId, page, q],
    queryFn: () => api.axonProjectFunctions(projectId!, page, 50, q),
    enabled: !!projectId,
  });
  const sample = useQuery({
    queryKey: ['axon-sample', projectId, fn?.name],
    queryFn: () => api.axonSampleText(projectId!, fn!.name),
    enabled: !!projectId && !!fn,
  });

  if (!project) {
    return (
      <div className={`h-full min-h-[240px] flex items-center justify-center ${T.mono} text-sm ${T.dim}`}>
        ▸ select a project on the left to see its functions
      </div>
    );
  }

  const pages = functions.data ? Math.max(1, Math.ceil(functions.data.total / functions.data.pageSize)) : 1;
  const onKey = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const list = functions.data?.functions ?? [];
    const i = list.findIndex(f => f.id === fn?.id);
    const next = e.key === 'ArrowDown' ? Math.min(list.length - 1, i + 1) : Math.max(0, i - 1);
    if (list[next]) { e.preventDefault(); setFn(list[next]); (document.getElementById(`axon-fn-${list[next].id}`) as HTMLElement | null)?.focus(); }
  };

  return (
    <div className="flex flex-col h-full">
      <div className={`px-3 py-2 border-b border-[#1f2a36] ${T.mono} text-xs flex items-center gap-3 flex-wrap`}>
        <span className={T.accent}>{project.projectId}</span>
        <span className={T.dim}>{project.functionsFound} fns · {project.vectors} embedded · {project.embeddedPercent}%{project.lastSync ? ` · synced ${fmtTime(project.lastSync)}` : ''}</span>
        <input className={`px-2 py-1 text-xs ${T.mono} ${T.input}`} placeholder="filter name / doc…" value={q} onChange={e => { setQ(e.target.value); setPage(1); }} />
        <span className="ml-auto flex items-center gap-1">
          <span className={T.dim}>{functions.data ? `page ${functions.data.page}/${pages}` : ''}</span>
          <button className={`px-2 py-0.5 ${T.btn}`} onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}>‹</button>
          <button className={`px-2 py-0.5 ${T.btn}`} onClick={() => setPage(p => p + 1)} disabled={page >= pages}>›</button>
        </span>
      </div>

      <div className="overflow-auto max-h-[300px]">
        <table className={`w-full ${T.mono} text-xs`}>
          <thead className={`${T.dim} text-left sticky top-0 bg-[#10161d] z-10`}>
            <tr className="border-b border-[#1f2a36]">
              <th className="px-3 py-2">vec</th>
              <th className="px-2 py-2">function</th>
              <th className="px-2 py-2">signature</th>
              <th className="px-2 py-2">tags</th>
              <th className="px-2 py-2">file:line</th>
            </tr>
          </thead>
          <tbody onKeyDown={onKey}>
            {(functions.data?.functions ?? []).map(f => {
              const sel = fn?.id === f.id;
              return (
                <tr key={f.id} className={`border-b border-[#141c25] hover:bg-[#0d1319] ${sel ? T.selected : ''}`}>
                  <td className="px-3 py-1.5">{f.embedded ? <span className={T.accent}>✔</span> : <span className={T.err}>✖</span>}</td>
                  <td className="px-2 py-1.5">
                    <button id={`axon-fn-${f.id}`} className={`text-left w-full focus:outline-none focus:text-[#5ee1a2] ${sel ? T.accent : ''}`} onClick={() => setFn(f)} aria-pressed={sel}>{f.name}</button>
                  </td>
                  <td className={`px-2 py-1.5 ${T.dim} truncate max-w-[260px]`} title={f.signature}>{f.signature}</td>
                  <td className={`px-2 py-1.5 ${T.dim} truncate max-w-[160px]`} title={f.tags.join(', ')}>{f.tags.slice(0, 3).join(', ')}</td>
                  <td className={`px-2 py-1.5 ${T.dim} whitespace-nowrap`} title={f.filePath}>{f.filePath.split('/').slice(-1)[0]}:{f.lineStart}</td>
                </tr>
              );
            })}
            {functions.isLoading && <tr><td colSpan={5} className={`px-3 py-3 ${T.dim}`}>parsing…</td></tr>}
            {functions.error && <tr><td colSpan={5} className={`px-3 py-3 ${T.err}`}>{String(functions.error)}</td></tr>}
            {functions.data && functions.data.functions.length === 0 && <tr><td colSpan={5} className={`px-3 py-3 ${T.dim}`}>no functions match</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="border-t border-[#1f2a36] p-3 overflow-auto max-h-[420px]">
        {fn ? (
          <div className={`${T.mono} text-xs space-y-2`}>
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`${T.accent} text-sm`}>{fn.name}</span>
              <span className={fn.embedded ? T.accent : T.err}>{fn.embedded ? 'embedded ✔' : 'not embedded ✖'}</span>
              <span className={T.dim}>{fn.filePath}:{fn.lineStart}-{fn.lineEnd}</span>
            </div>
            <div><span className={T.dim}>signature </span>{fn.signature}{fn.returnType ? <span className={T.dim}> ⇒ {fn.returnType}</span> : null}</div>
            {fn.tags.length > 0 && <div><span className={T.dim}>tags </span>{fn.tags.join(', ')}</div>}
            {fn.calls.length > 0 && <div><span className={T.dim}>calls </span>{fn.calls.join(', ')}</div>}
            {fn.calledBy.length > 0 && <div><span className={T.dim}>called by </span>{fn.calledBy.join(', ')}</div>}
            {fn.doc && <div className="whitespace-pre-wrap"><span className={T.dim}>doc </span>{fn.doc}</div>}
            <div className={T.dim}>embedding text · v{sample.data?.embedTextVersion ?? '…'} · {sample.data?.chunks.length ?? 0} chunk(s){sample.isLoading ? ' · loading…' : ''}</div>
            {sample.data?.chunks.map(c => (
              <pre key={c.chunkIndex} className={`${T.mono} text-[11px] leading-snug whitespace-pre-wrap bg-[#0b0f14] border border-[#1f2a36] p-2`}>
                <span className={T.dim}>{`// chunk ${c.chunkIndex + 1}/${c.chunkCount} · lines ${c.lineStart}-${c.lineEnd} · ${c.text.length} chars\n`}</span>{c.text}
              </pre>
            ))}
          </div>
        ) : (
          <div className={`${T.mono} text-xs ${T.dim}`}>▸ select a function to see its signature, doc and the exact text it embeds from</div>
        )}
      </div>
    </div>
  );
}

// ── Section: master/detail ──────────────────────────────────────────────────

interface SectionProps extends ProjectListProps {
  title: string;
  dir?: string;
  totals?: { projects: number; functions: number; vectors: number; embeddedPercent: number };
  onIndexSource: () => void;
}

function SourceSection({ title, dir, totals, onIndexSource, ...list }: SectionProps) {
  const selected = list.rows.find(r => r.projectId === list.selectedId) ?? null;
  return (
    <div className={T.panel}>
      <div className={`${T.panelHead} px-4 py-2 ${T.mono} text-xs ${T.dim} flex items-center justify-between gap-3 flex-wrap`}>
        <span className="truncate">{title} → {dir ?? '…'}</span>
        <span className="flex items-center gap-3">
          <span>{list.rows.length} projects · {totals?.functions ?? 0} fns · {totals?.embeddedPercent ?? 0}% embedded</span>
          <button className={`px-2 py-0.5 ${T.btn}`} onClick={onIndexSource} disabled={list.blocked}>embed {list.source === 'proj' ? 'all projects' : 'whole library'}</button>
        </span>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 items-start">
        <div className="xl:border-r border-[#1f2a36]"><ProjectList {...list} /></div>
        {/* Sticky detail: stays beside the list while it scrolls, never below the tables. */}
        <div className="border-t xl:border-t-0 border-[#1f2a36] xl:sticky xl:top-2 xl:max-h-[calc(100vh-1rem)] overflow-y-auto bg-[#10161d]">
          <ProjectDetail project={selected} />
        </div>
      </div>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function AxonPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState<AxonSettings | null>(null);
  const [validation, setValidation] = useState<AxonValidateResponse | null>(null);
  const [libValidation, setLibValidation] = useState<AxonLibraryValidateResponse | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  // One selection per section.
  const [selectedProj, setSelectedProj] = useState<string | null>(null);
  const [selectedLib, setSelectedLib] = useState<string | null>(null);

  const status = useQuery({ queryKey: ['axon-status'], queryFn: api.axonStatus, refetchInterval: 5000 });
  const projects = useQuery({ queryKey: ['axon-projects'], queryFn: api.axonProjects, refetchInterval: 10000 });
  const jobs = useQuery({ queryKey: ['axon-jobs'], queryFn: api.axonJobs, refetchInterval: 3000 });

  useEffect(() => {
    if (status.data && !form) setForm(status.data.settings);
  }, [status.data, form]);

  const flash = (kind: 'ok' | 'err', text: string) => {
    setMsg({ kind, text });
    setTimeout(() => setMsg(null), kind === 'ok' ? 6000 : 10000);
  };

  const save = useMutation({
    mutationFn: (s: Partial<AxonSettings>) => api.updateSettings({ axon: s } as never),
    onSuccess: () => { flash('ok', 'axon settings saved'); qc.invalidateQueries({ queryKey: ['axon-status'] }); qc.invalidateQueries({ queryKey: ['axon-projects'] }); },
    onError: (e) => flash('err', e instanceof Error ? e.message : 'save failed'),
  });
  const validate = useMutation({ mutationFn: (p: string) => api.axonValidate(p), onSuccess: setValidation, onError: (e) => flash('err', e instanceof Error ? e.message : 'validate failed') });
  const validateLib = useMutation({ mutationFn: (p: string) => api.axonValidateLibrary(p), onSuccess: setLibValidation, onError: (e) => flash('err', e instanceof Error ? e.message : 'validate failed') });
  const index = useMutation({
    mutationFn: (b: { projectId?: string; force?: boolean; source?: AxonRecordSource | 'all' }) => api.axonIndex(b),
    onSuccess: (r) => { flash('ok', `index job ${r.job.id} started (${r.job.scope.projectId ?? r.job.scope.source ?? 'all'}${r.job.scope.force ? ', force' : ''})`); qc.invalidateQueries({ queryKey: ['axon-jobs'] }); },
    onError: (e) => flash('err', e instanceof Error ? e.message : 'index failed'),
  });
  const cancel = useMutation({ mutationFn: (id: string) => api.axonCancelJob(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['axon-jobs'] }) });

  const s = status.data;
  const mcp = s?.mcp;
  const table = s?.table;
  const active: AxonJob | null | undefined = jobs.data?.active ?? s?.activeJob;
  const dimsMismatch = !!table?.dimsMismatch && (table?.rows ?? 0) > 0;
  const schemaStale = !!table?.exists && table.schemaCurrent === false && (table.rows ?? 0) > 0;
  // A stale text layout is NOT blocking: v1 and v2 rows are the same width and
  // a plain re-index rewrites them, so blocking would block the only fix.
  const textStale = !!table?.textVersionStale && (table?.rows ?? 0) > 0;
  // Buttons stay enabled while another heavy job runs — the Axon job queues behind it.
  const blocked = !!active || dimsMismatch || schemaStale;

  const bySource = useMemo(() => {
    const list = [...(projects.data?.projects ?? [])].sort((a, b) => a.projectId.localeCompare(b.projectId));
    return { proj: list.filter(p => p.source === 'proj'), library: list.filter(p => p.source === 'library') };
  }, [projects.data]);

  const serverLine = (() => {
    if (!mcp) return { on: false, text: 'Axon server: …' };
    if (mcp.connected) return { on: true, text: `Axon server: reachable — ${mcp.transport} ${mcp.url ?? mcp.command ?? ''} · ${mcp.toolCount} tools${mcp.serverInfo?.version ? ` · v${mcp.serverInfo.version}` : ''}` };
    if (!mcp.enabled) return { on: false, text: 'Axon server: disabled in settings (axon.enabled=false) — callers/callees enrichment off; indexing and search unaffected' };
    if (mcp.connecting) return { on: false, text: 'Axon server: connecting…' };
    const hint = mcp.transport === 'http'
      ? `start it with \`npm run start:http\` in ${mcp.projectPath} (expected at ${mcp.url})`
      : `stdio spawn failed (${mcp.command}) — check axon.projectPath`;
    return { on: false, text: `Axon server: unreachable — ${hint}${mcp.lastError ? ` · ${mcp.lastError}` : ''}` };
  })();

  return (
    <div className={`${T.bg} ${T.text} -m-6 min-h-screen p-6 space-y-5`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className={`${T.mono} text-xl font-bold ${T.accent}`}>$ axon --status</h1>
          <p className={`${T.dim} text-sm mt-1`}>
            SkySpark project functions (synced <code className={T.mono}>proj/</code> + offline library) embedded with the Code Search model into <code className={T.mono}>axon_vectors</code>.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className={`px-3 py-1.5 text-xs ${T.mono} ${T.btnPrimary}`} onClick={() => index.mutate({})} disabled={blocked} title={dimsMismatch || schemaStale ? 'table needs a forced rebuild — use re-index (force)' : 'Embed every project of both sources'}>embed all</button>
          <button
            className={`px-3 py-1.5 text-xs ${T.mono} ${T.btn} ${dimsMismatch || schemaStale ? 'border-[#ffcc66] text-[#ffcc66]' : ''}`}
            onClick={() => { if (confirm('Drop axon_vectors and re-embed every project of both sources?')) index.mutate({ force: true }); }}
            disabled={index.isPending || !!active}
          >
            re-index (force)
          </button>
        </div>
      </div>

      <div className={`${T.mono} text-xs flex items-center gap-2 ${serverLine.on ? T.accent : T.dim}`}>
        <span className={`inline-block h-2 w-2 rounded-full ${serverLine.on ? 'bg-[#5ee1a2]' : 'bg-[#4f6274]'}`} />
        <span className="truncate" title={serverLine.text}>{serverLine.text}</span>
      </div>
      {/* Heavy-job lock: Axon indexing serialises with code re-embed / forced reindex. */}
      {s?.heavyJob && s.heavyJob.kind !== 'axon-index' && (
        <div className={`${T.mono} text-xs px-3 py-2 border border-[#ffcc66] ${T.warn}`}>
          ⏸ indexing paused: {s.heavyJob.kind === 'code-reembed' ? 'code re-embed' : 'forced code reindex'} ({s.heavyJob.label}) running since {fmtTime(s.heavyJob.since)} — Axon index jobs queue automatically and start when it finishes.
        </div>
      )}

      {msg && (
        <div className={`${T.mono} text-sm px-3 py-2 border ${msg.kind === 'ok' ? 'border-[#5ee1a2] text-[#5ee1a2]' : 'border-[#ff6b6b] text-[#ff6b6b]'}`}>
          {msg.kind === 'ok' ? '✔' : '✖'} {msg.text}
        </div>
      )}

      {/* Status strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <div className={`${T.panel} p-3`}>
          <div className={`${T.dim} text-xs ${T.mono}`}>synced projects</div>
          <div className={`${T.mono} text-2xl`}>{projects.data?.bySource?.proj.projects ?? '—'}</div>
          <div className={`${T.dim} text-[11px] ${T.mono}`}>{projects.data?.bySource?.proj.functions ?? 0} fns · {projects.data?.bySource?.proj.embeddedPercent ?? 0}%</div>
        </div>
        <div className={`${T.panel} p-3`}>
          <div className={`${T.dim} text-xs ${T.mono}`}>library folders</div>
          <div className={`${T.mono} text-2xl`}>{projects.data?.bySource?.library.projects ?? '—'}</div>
          <div className={`${T.dim} text-[11px] ${T.mono}`}>{projects.data?.bySource?.library.functions ?? 0} fns · {projects.data?.bySource?.library.embeddedPercent ?? 0}%</div>
        </div>
        <div className={`${T.panel} p-3`}>
          <div className={`${T.dim} text-xs ${T.mono}`}>embedded</div>
          <div className={`${T.mono} text-2xl ${(s?.totals.embeddedPercent ?? 0) >= 100 ? T.accent : ''}`}>{s?.totals.embeddedPercent ?? 0}%</div>
          <div className={`${T.dim} text-[11px] ${T.mono}`}>{s?.totals.vectors ?? 0}/{s?.totals.functions ?? 0} fns · {table?.rows ?? 0} rows</div>
        </div>
        <div className={`${T.panel} p-3 col-span-2 lg:col-span-3`}>
          <div className={`${T.dim} text-xs ${T.mono}`}>embedding model (from Code Search — read-only)</div>
          <div className={`${T.mono} text-sm mt-1`}>{s?.embedding.model ?? '—'} <span className={T.dim}>@ {s?.embedding.dimensions ?? '—'}d · text v{s?.embedding.embedTextVersion ?? '—'}</span></div>
          <div className={`${T.dim} text-[11px] ${T.mono}`}>table: {table?.exists ? `${table.tableModel ?? '?'} @ ${table.tableDimensions ?? '?'}d` : 'not created'}{active ? ` · job ${active.id} ${active.status}` : ''}</div>
        </div>
      </div>

      {dimsMismatch && (
        <div className={`${T.mono} text-sm px-3 py-2 border border-[#ffcc66] ${T.warn}`}>
          ⚠ axon_vectors holds {table?.rows} rows at {table?.tableDimensions}d but the Code Search model is {table?.configuredModel} ({table?.configuredDimensions}d). Search will fail until you run <b>re-index (force)</b>. Nothing is dropped automatically.
        </div>
      )}
      {schemaStale && (
        <div className={`${T.mono} text-sm px-3 py-2 border border-[#ffcc66] ${T.warn}`}>
          ⚠ axon_vectors was created with an older schema (missing chunk/source columns). Run <b>re-index (force)</b> to rebuild it.
        </div>
      )}
      {textStale && !schemaStale && (
        <div className={`${T.mono} text-sm px-3 py-2 border border-[#ffcc66] ${T.warn}`}>
          ⚠ rows were built from embedding-text layout v{table?.tableTextVersion}; the current layout is v{s?.embedding?.embedTextVersion}.
          Run <b>re-index</b> to rebuild them (v2 splits at statement boundaries and keeps comments).
        </div>
      )}
      {s?.embedding?.grammar && !s.embedding.grammar.ready && (
        <div className={`${T.mono} text-sm px-3 py-2 border border-[#ffcc66] ${T.warn}`}>
          ⚠ the Axon tree-sitter grammar is not loaded{s.embedding.grammar.error ? ` (${s.embedding.grammar.error})` : ''}.
          Indexing refuses to run without it; chunk previews fall back to fixed line windows.
        </div>
      )}

      {/* Paths + Jobs */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className={`${T.panel} lg:col-span-2`}>
          <div className={`${T.panelHead} px-4 py-2 ${T.mono} text-xs ${T.dim}`}>config/fantomMcpServer-config.json → axon</div>
          {form ? (
            <div className="p-4 space-y-4">
              <div>
                <label className={`${T.mono} text-xs ${T.dim}`}>projectPath <span className="opacity-60">(Axon MCP server checkout; proj/ is read from here)</span></label>
                <div className="flex gap-2 mt-1">
                  <input className={`flex-1 px-3 py-2 text-sm ${T.mono} ${T.input}`} value={form.projectPath} onChange={e => setForm({ ...form, projectPath: e.target.value })} spellCheck={false} />
                  <button className={`px-3 py-2 text-xs ${T.mono} ${T.btn}`} onClick={() => validate.mutate(form.projectPath)} disabled={validate.isPending}>{validate.isPending ? 'validating…' : 'validate path'}</button>
                </div>
                {validation && (
                  <div className={`mt-2 p-3 ${T.mono} text-xs border ${validation.problems.length ? 'border-[#ffcc66]' : 'border-[#5ee1a2]'} bg-[#0b0f14] space-y-1`}>
                    <div>
                      <span className={T.dim}>package.json</span> {validation.packageJson ? <span className={T.accent}>ok</span> : <span className={T.err}>missing</span>}
                      <span className={`${T.dim} ml-3`}>dist/index.js</span> {validation.serverEntry ? <span className={T.accent}>ok</span> : <span className={T.err}>missing</span>}
                      <span className={`${T.dim} ml-3`}>proj/</span> {validation.projExists ? <span className={T.accent}>{validation.projects.length} projects · {validation.totalFunctions} functions</span> : <span className={T.err}>missing</span>}
                    </div>
                    {validation.instances.length > 0 && <div><span className={T.dim}>instances:</span> {validation.instances.join(', ')}</div>}
                    {validation.problems.map((p, i) => <div key={i} className={T.warn}>! {p}</div>)}
                  </div>
                )}
              </div>

              <div>
                <label className={`${T.mono} text-xs ${T.dim}`}>libraryPath <span className="opacity-60">(offline Axon library: one folder per former project)</span></label>
                <div className="flex gap-2 mt-1">
                  <input className={`flex-1 px-3 py-2 text-sm ${T.mono} ${T.input}`} value={form.libraryPath} onChange={e => setForm({ ...form, libraryPath: e.target.value })} spellCheck={false} />
                  <button className={`px-3 py-2 text-xs ${T.mono} ${T.btn}`} onClick={() => validateLib.mutate(form.libraryPath)} disabled={validateLib.isPending}>{validateLib.isPending ? 'validating…' : 'validate path'}</button>
                </div>
                {libValidation && (
                  <div className={`mt-2 p-3 ${T.mono} text-xs border ${libValidation.problems.length ? 'border-[#ffcc66]' : 'border-[#5ee1a2]'} bg-[#0b0f14] space-y-1`}>
                    <div>
                      <span className={T.dim}>folder</span> {libValidation.exists ? <span className={T.accent}>ok</span> : <span className={T.err}>missing</span>}
                      <span className={`${T.dim} ml-3`}>detected</span> <span className={T.accent}>{libValidation.folders.length} folders · {libValidation.totalFunctions} functions</span>
                    </div>
                    {libValidation.problems.map((p, i) => <div key={i} className={T.warn}>! {p}</div>)}
                  </div>
                )}
              </div>

              <Toggle value={form.autoIndex} onChange={v => setForm({ ...form, autoIndex: v })} label="autoIndex" hint="Run an index job at boot once sidecars advertise the code model" />

              <div className="flex items-center gap-3 pt-1">
                <button className={`px-4 py-2 text-xs ${T.mono} ${T.btnPrimary}`} onClick={() => save.mutate({ projectPath: form.projectPath, libraryPath: form.libraryPath, autoIndex: form.autoIndex })} disabled={save.isPending}>{save.isPending ? 'saving…' : 'save'}</button>
                <button className={`px-3 py-2 text-xs ${T.mono} ${T.btn}`} onClick={() => { if (s) setForm(s.settings); }}>reset</button>
              </div>
            </div>
          ) : (
            <div className={`p-4 ${T.mono} text-sm ${T.dim}`}>{status.error ? String(status.error) : 'loading…'}</div>
          )}
        </div>

        <div className={T.panel}>
          <div className={`${T.panelHead} px-4 py-2 ${T.mono} text-xs ${T.dim}`}>jobs</div>
          <div className="p-3 space-y-2 max-h-[420px] overflow-y-auto">
            {active && (
              <div className={`${T.mono} text-xs p-2 border border-[#5ee1a2]`}>
                <div className="flex items-center justify-between">
                  <span className={T.accent}>● {active.id} {active.status}</span>
                  <button className={`px-2 py-0.5 ${T.btn}`} onClick={() => cancel.mutate(active.id)} disabled={active.cancelRequested}>{active.cancelRequested ? 'stopping…' : 'stop'}</button>
                </div>
                <div className={T.dim}>{active.scope.projectId ?? active.scope.source ?? 'all'}{active.scope.force ? ' · force' : ''} · {active.projectsDone}/{active.projectsTotal} projects · {active.functionsEmbedded}/{active.functionsTotal} fns</div>
                {active.status === 'queued' && (
                  <div className={T.warn}>⏳ waiting for {active.waitingFor ? `${active.waitingFor.kind} (${active.waitingFor.label}) since ${fmtTime(active.waitingFor.since)}` : 'the heavy-job lock'}</div>
                )}
                {active.currentProject && <div className={T.dim}>→ {active.currentProject}</div>}
                <div className={T.dim}>providers: {active.providers.join(', ') || '—'}</div>
                <Bar pct={active.functionsTotal ? (active.functionsEmbedded / active.functionsTotal) * 100 : 0} />
              </div>
            )}
            {(jobs.data?.jobs ?? []).filter(j => j.id !== active?.id).slice(0, 12).map(j => (
              <div key={j.id} className={`${T.mono} text-xs p-2 border border-[#1f2a36]`}>
                <div className="flex items-center justify-between">
                  <span className={j.status === 'done' ? T.accent : j.status === 'error' ? T.err : T.warn}>{j.status === 'done' ? '✔' : j.status === 'error' ? '✖' : '○'} {j.id} {j.status}</span>
                  <span className={T.dim}>{fmtTime(j.startedAt)}</span>
                </div>
                <div className={T.dim}>{j.scope.projectId ?? j.scope.source ?? 'all'}{j.scope.force ? ' · force' : ''} · {j.projectsDone}/{j.projectsTotal} · {j.functionsEmbedded} fns · {j.model}</div>
                {j.errors.slice(0, 2).map((e, i) => <div key={i} className={`${T.err} truncate`} title={e.message}>{e.projectId ? `${e.projectId}: ` : ''}{e.message}</div>)}
              </div>
            ))}
            {!active && !(jobs.data?.jobs.length) && <div className={`${T.mono} text-xs ${T.dim}`}>no jobs yet</div>}
          </div>
        </div>
      </div>

      <SourceSection
        title="synced projects (proj/)"
        dir={projects.data?.projDir}
        totals={projects.data?.bySource?.proj}
        rows={bySource.proj}
        source="proj"
        selectedId={selectedProj}
        onSelect={setSelectedProj}
        onIndex={(projectId) => index.mutate({ projectId })}
        onIndexSource={() => index.mutate({ source: 'proj' })}
        blocked={blocked}
        loading={projects.isLoading}
        currentTextVersion={projects.data?.embedTextVersion}
      />
      <SourceSection
        title="offline library"
        dir={projects.data?.libraryDir}
        totals={projects.data?.bySource?.library}
        rows={bySource.library}
        source="library"
        selectedId={selectedLib}
        onSelect={setSelectedLib}
        onIndex={(projectId) => index.mutate({ projectId })}
        onIndexSource={() => index.mutate({ source: 'library' })}
        blocked={blocked}
        loading={projects.isLoading}
        currentTextVersion={projects.data?.embedTextVersion}
      />
    </div>
  );
}
