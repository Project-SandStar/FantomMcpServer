'use client';

/**
 * Knowledge Card viewer (/dashboard/knowledge-cards/).
 * Three columns on wide screens (app menu, projects, cards); stacks on narrow ones.
 * Lists come from /admin/knowledge-cards/viewer/*, paged on the server (no
 * vectors reach the browser); the projects column reads /viewer/counts only.
 * Writes only on a click: "Build now" (existing build route), and the admin bulk
 * tools "Rebuild selected" / "Delete selected" (each asks in a page dialog).
 * The ask preview uses the card path only and never changes settings.
 * URL keys: projectId (all | id), writer, mark, kind, sort, q, card (row id);
 * see lib/knowledgeCardsState.ts.
 */
import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  knowledgeCardViewerApi, knowledgeCardsApi,
  type KnowledgeCardMark, type KnowledgeCardFull, type KnowledgeCardDetail, type KnowledgeCardRebuildJob,
} from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import {
  parseViewerUrl, patchViewerUrl, cardRowId, toggleId, togglePage, chunk, cardsToMarkdown,
  type ViewerUrlState, type MarkFilter, type ExportCard,
} from '@/lib/knowledgeCardsState';

const inputCls = 'w-full min-w-0 px-2 py-1.5 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500';
const btnCls = 'px-3 py-1.5 rounded-md text-sm font-medium disabled:opacity-50';
const PAGE = 40;

const MARKS: Record<KnowledgeCardMark, { label: string; cls: string; dot: string }> = {
  good: { label: 'good', cls: 'bg-green-100 text-green-800', dot: 'bg-green-500' },
  low: { label: 'low confidence', cls: 'bg-amber-100 text-amber-800', dot: 'bg-amber-500' },
  stale: { label: 'stale', cls: 'bg-gray-200 text-gray-800', dot: 'bg-gray-500' },
  failed: { label: 'failed check', cls: 'bg-red-100 text-red-800', dot: 'bg-red-500' },
};

function Mark({ m }: { m: KnowledgeCardMark }) {
  const s = MARKS[m] ?? MARKS.stale;
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${s.cls}`}><span className={`h-2 w-2 rounded-full ${s.dot}`} />{s.label}</span>;
}

const shortModel = (m: string) => m.split('/').pop() || m;
const day = (iso: string) => (iso ? iso.slice(0, 16).replace('T', ' ') : '-');
const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Card text with each [file:line] turned into a link that opens the source. */
function CardText({ text, onOpen }: { text: string; onOpen: (file: string, line: number) => void }) {
  const lines = text.split('\n');
  return (
    <div className="text-sm text-gray-800 space-y-1 break-words">
      {lines.map((ln, i) => {
        const parts = ln.split(/(\[[^\]\s]+:\d+\])/g);
        return (
          <p key={i} className={i === 0 ? 'font-semibold' : ''}>
            {parts.map((p, j) => {
              const m = /^\[([^\]\s]+):(\d+)\]$/.exec(p);
              if (!m) return <span key={j}>{p}</span>;
              return (
                <button key={j} type="button" onClick={() => onOpen(m[1], Number(m[2]))}
                  className="font-mono text-xs text-blue-700 hover:underline break-all text-left">[{m[1].split('/').slice(-2).join('/')}:{m[2]}]</button>
              );
            })}
          </p>
        );
      })}
    </div>
  );
}

function SourceView({ rowId, index, focusLine, onClose }: { rowId: string; index: number; focusLine?: number; onClose: () => void }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ['kc-source', rowId, index],
    queryFn: () => knowledgeCardViewerApi.source(rowId, index),
  });
  return (
    <div className="border border-gray-300 rounded-md bg-gray-50 min-w-0">
      <div className="flex items-center justify-between gap-2 px-2 py-1 border-b border-gray-200">
        <span className="font-mono text-xs break-all min-w-0">{data?.file ?? '...'}{data ? `:${data.lineStart}-${data.lineEnd}` : ''}</span>
        <button type="button" onClick={onClose} className="text-xs text-gray-600 hover:text-gray-900 shrink-0">close</button>
      </div>
      {isLoading && <p className="p-2 text-xs text-gray-500">Loading...</p>}
      {error && <p className="p-2 text-xs text-red-700">{(error as Error).message}</p>}
      {data && (
        <pre className="text-xs overflow-x-auto max-h-80 p-2 font-mono">
          {data.lines.map((l, i) => {
            const n = data.from + i;
            const hot = focusLine ? n === focusLine : n >= data.lineStart && n <= data.lineEnd;
            return <div key={n} className={hot ? 'bg-yellow-100' : ''}><span className="select-none text-gray-400 inline-block w-10 text-right mr-2">{n}</span>{l}</div>;
          })}
        </pre>
      )}
    </div>
  );
}

function CardBody({ card, detail }: { card: KnowledgeCardFull; detail?: KnowledgeCardDetail }) {
  const [open, setOpen] = useState<{ index: number; line?: number } | null>(null);
  const openFile = (file: string, line: number) => {
    const i = card.sources.findIndex(s => s.file === file || s.file.endsWith(file) || file.endsWith(s.file));
    setOpen({ index: i >= 0 ? i : card.sources.length, line });
  };
  return (
    <div className="space-y-3 min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <Mark m={card.mark} />
        <span className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-800">{card.kind}</span>
        <span className="text-xs text-gray-600">confidence {pct(card.confidence)}</span>
        {(card.filePath || card.sources.length > 0) && (
          <button type="button" className="text-xs px-2 py-0.5 rounded bg-gray-100 hover:bg-gray-200 text-gray-800"
            onClick={() => setOpen({ index: card.filePath ? card.sources.length : 0 })}>Open in code</button>
        )}
      </div>
      <CardText text={card.text} onOpen={openFile} />
      {open && <SourceView rowId={card.rowId} index={open.index} focusLine={open.line} onClose={() => setOpen(null)} />}
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-700">
        <div className="min-w-0"><dt className="inline text-gray-500">Writer: </dt><dd className="inline break-all">{card.writerModel} · {day(card.builtAt)}</dd></div>
        <div className="min-w-0"><dt className="inline text-gray-500">Checker: </dt><dd className="inline break-all">{card.checkerModel || 'none'} · {card.checkResult} · {pct(card.confidence)}</dd></div>
        <div><dt className="inline text-gray-500">Claims kept: </dt><dd className="inline">{card.claims.length} <span className="text-gray-400">(cut claims not recorded yet)</span></dd></div>
        {detail && detail.card.rowId === card.rowId && card.kind !== 'project' && card.kind !== 'pod' && (
          <div><dt className="inline text-gray-500">Fan-in: </dt><dd className="inline">{detail.card.fanIn} <span className="text-gray-400">(counted from caller links on the card)</span></dd></div>
        )}
        <div><dt className="inline text-gray-500">First check: </dt><dd className="inline">{card.firstCheck} · {card.attempts} attempt{card.attempts === 1 ? '' : 's'}{card.attempts > 1 ? ' (claims cut and rewritten)' : ''}</dd></div>
        <div><dt className="inline text-gray-500">Cost: </dt><dd className="inline">${(card.writerCostUsd + card.checkerCostUsd).toFixed(5)}</dd></div>
      </dl>
      {detail && detail.card.rowId === card.rowId && (
        <>
          <section>
            <h4 className="text-xs font-semibold text-gray-700 mb-1">Sources</h4>
            <ul className="space-y-1">
              {detail.sources.map(s => (
                <li key={s.index} className="text-xs flex flex-wrap items-center gap-2 min-w-0">
                  <span className={`px-1.5 rounded ${s.fresh ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>{s.fresh ? 'fresh' : s.readable ? 'stale' : 'not readable'}</span>
                  <button type="button" className="font-mono text-blue-700 hover:underline break-all text-left min-w-0" onClick={() => setOpen({ index: s.index })}>{s.file}:{s.lineStart}-{s.lineEnd}</button>
                  <span className="font-mono text-gray-500 break-all" title={s.hash}>{s.hash.slice(0, 12)}</span>
                </li>
              ))}
              {detail.sources.length === 0 && <li className="text-xs text-gray-500">No sources stored.</li>}
            </ul>
          </section>
          <Links detail={detail} />
        </>
      )}
    </div>
  );
}

function Links({ detail }: { detail: KnowledgeCardDetail }) {
  const router = useRouter();
  const sp = useSearchParams();
  const groups = useMemo(() => {
    const g: Record<string, KnowledgeCardDetail['links']> = {};
    for (const l of detail.links) (g[l.relation] ??= []).push(l);
    return g;
  }, [detail.links]);
  const go = (rowId: string) => {
    const p = new URLSearchParams(sp.toString());
    p.set('card', rowId);
    router.replace(`?${p}`, { scroll: false });
  };
  if (!detail.links.length) return <p className="text-xs text-gray-500">No graph links on this card.</p>;
  return (
    <section className="space-y-2">
      <h4 className="text-xs font-semibold text-gray-700">Linked cards (from graph edges)</h4>
      {Object.entries(groups).map(([rel, list]) => (
        <div key={rel}>
          <div className="text-xs text-gray-500">{rel} ({list.length})</div>
          <ul className="flex flex-wrap gap-1 mt-1">
            {list.slice(0, 40).map(l => (
              <li key={l.nodeId} className="min-w-0 max-w-full">
                {l.card
                  ? <button type="button" onClick={() => go(l.card!.rowId)} className="text-xs px-2 py-0.5 rounded border border-blue-200 bg-blue-50 text-blue-800 hover:bg-blue-100 break-all text-left">{l.name}</button>
                  : <span className="text-xs px-2 py-0.5 rounded border border-gray-200 text-gray-500 break-all inline-block" title="no card for this node">{l.name}</span>}
              </li>
            ))}
            {list.length > 40 && <li className="text-xs text-gray-500">+{list.length - 40} more</li>}
          </ul>
        </div>
      ))}
    </section>
  );
}

function CardPanel({ rowId, compare, isAdmin, onClose, onRebuild }: {
  rowId: string; compare: boolean; isAdmin: boolean; onClose: () => void; onRebuild: (rowIds: string[]) => void;
}) {
  const { data, error, isLoading } = useQuery({ queryKey: ['kc-card', rowId], queryFn: () => knowledgeCardViewerApi.card(rowId) });
  if (isLoading) return <div className="p-4 text-sm text-gray-500">Loading card...</div>;
  if (error || !data) return <div className="p-4 text-sm text-red-700">{(error as Error)?.message ?? 'No card'}</div>;
  const c = data.card;
  return (
    <div className="space-y-4 min-w-0">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold text-gray-900 break-all">{c.qualifiedName || c.name}</h3>
          {c.filePath && <p className="font-mono text-xs text-gray-500 break-all">{c.filePath}:{c.lineStart}-{c.lineEnd}</p>}
        </div>
        <button type="button" onClick={onClose} className="text-sm text-gray-500 hover:text-gray-900 shrink-0">close</button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link className={`${btnCls} bg-gray-100 hover:bg-gray-200 text-gray-800`}
          href={`/graph-3d?projectId=${c.projectId}`} title="Opens the project graph; the 3D view takes no node id">Open in graph</Link>
        {isAdmin && (
          <button type="button" className={`${btnCls} bg-amber-100 hover:bg-amber-200 text-amber-900`}
            title={`Rebuilds this card only, with its writer ${c.writerModel}`} onClick={() => onRebuild([c.rowId])}>
            Rebuild this card
          </button>
        )}
      </div>
      {compare ? (
        data.variants.length < 2
          ? <><p className="text-xs text-gray-500">Only one writer has a card for this node.</p><CardBody card={c} detail={data} /></>
          : (
            <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
              {data.variants.map(v => (
                <div key={v.rowId} className="border border-gray-200 rounded-md p-3 min-w-0">
                  <div className="text-xs font-semibold text-gray-700 mb-2 break-all">{v.writerModel}</div>
                  <CardBody card={v} detail={v.rowId === c.rowId ? data : undefined} />
                </div>
              ))}
            </div>
          )
      ) : <CardBody card={c} detail={data} />}
    </div>
  );
}

function AskPreview({ projectId, writer, onPick }: { projectId: number | null; writer: string; onPick: (rowId: string) => void }) {
  const [q, setQ] = useState('');
  const ask = useMutation({ mutationFn: (query: string) => knowledgeCardViewerApi.ask(query, projectId ?? undefined, writer || undefined) });
  const r = ask.data;
  return (
    <section className="bg-white border border-gray-200 rounded-lg p-3 space-y-2 min-w-0">
      <h3 className="text-sm font-semibold text-gray-800">Ask preview</h3>
      <p className="text-xs text-gray-500">Shows what the card path would answer. Works with &quot;use cards to answer asks&quot; off, and does not change it.</p>
      <form className="flex flex-col sm:flex-row gap-2" onSubmit={e => { e.preventDefault(); if (q.trim()) ask.mutate(q.trim()); }}>
        <input className={inputCls} value={q} onChange={e => setQ(e.target.value)} placeholder="How does the connector poll points?" />
        <button type="submit" className={`${btnCls} bg-blue-600 text-white hover:bg-blue-700 shrink-0`} disabled={ask.isPending || !q.trim()}>{ask.isPending ? 'Asking...' : 'Ask'}</button>
      </form>
      {ask.error && <p className="text-xs text-red-700">{(ask.error as Error).message}</p>}
      {r && (
        <div className="space-y-2 text-sm min-w-0">
          <p className="text-xs text-gray-600">
            {r.answered ? 'Answered from cards' : `Would fall back: ${r.reason ?? 'unknown'}`}
            {r.bestScore !== undefined ? ` · best match ${r.bestScore.toFixed(3)}` : ''} · {r.timings.totalMs} ms
            {r.model ? ` · ${shortModel(r.model)}` : ''}{r.costUsd ? ` · $${r.costUsd.toFixed(5)}` : ''}
          </p>
          {r.cards && r.cards.length > 0 && (
            <ul className="space-y-1">
              {r.cards.map(c => (
                <li key={cardRowId(c.projectId, c.nodeId, c.writerModel)} className="text-xs flex flex-wrap gap-2 min-w-0">
                  <span className="font-mono text-gray-500">{c.score.toFixed(3)}</span>
                  <button type="button" className="text-blue-700 hover:underline break-all text-left min-w-0"
                    onClick={() => onPick(cardRowId(c.projectId, c.nodeId, c.writerModel))}>{c.qualifiedName}</button>
                </li>
              ))}
            </ul>
          )}
          {r.answer && <pre className="whitespace-pre-wrap break-words text-sm bg-gray-50 border border-gray-200 rounded p-2 font-sans">{r.answer}</pre>}
        </div>
      )}
    </section>
  );
}

/** In-page confirm dialog (no browser alert). */
function ConfirmDialog({ title, body, okLabel, danger, busy, onOk, onCancel }: {
  title: string; body: string; okLabel: string; danger?: boolean; busy?: boolean; onOk: () => void; onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-4 space-y-3">
        <h3 className="font-semibold text-gray-900">{title}</h3>
        <p className="text-sm text-gray-700 whitespace-pre-wrap break-words">{body}</p>
        <div className="flex justify-end gap-2">
          <button type="button" className={`${btnCls} bg-gray-100 hover:bg-gray-200`} onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" disabled={busy}
            className={`${btnCls} text-white ${danger ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'}`} onClick={onOk}>
            {busy ? 'Working...' : okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const STATUS_BUTTONS: Array<{ key: MarkFilter; label: string }> = [
  { key: '', label: 'All' }, { key: 'good', label: 'Good' }, { key: 'low', label: 'Low confidence' },
  { key: 'stale', label: 'Stale' }, { key: 'failed', label: 'Failed check' },
];

type Pending = { kind: 'build' } | { kind: 'rebuild'; ids: string[] } | { kind: 'delete'; ids: string[] };

function JobLine({ job, onStop }: { job: KnowledgeCardRebuildJob; onStop: () => void }) {
  const active = job.state === 'running' || job.state === 'queued';
  const done = job.built + job.skippedCount;
  return (
    <div className="text-xs text-gray-700 flex flex-wrap items-center gap-2 min-w-0">
      <span className={`px-1.5 rounded ${active ? 'bg-blue-100 text-blue-800' : job.state === 'done' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>rebuild {job.state}</span>
      <span>{done}/{job.requested} · built {job.built} · skipped {job.skippedCount}{job.flagged ? ` · flagged ${job.flagged}` : ''} · ${job.costUsd.toFixed(4)}</span>
      {job.error && <span className="text-red-700 break-all">{job.error}</span>}
      {job.groups.filter(g => g.error).slice(0, 2).map(g => <span key={`${g.projectId}:${g.writerModel}`} className="text-red-700 break-all">{shortModel(g.writerModel)}: {g.error}</span>)}
      {active && <button type="button" className="text-red-700 hover:underline" onClick={onStop}>stop</button>}
    </div>
  );
}

function ViewerInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const qc = useQueryClient();
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const url = parseViewerUrl(sp);
  const { projectId: scope, mark, kind, sort, card: cardId } = url;
  // No writer choice on this page: builds and lists follow the saved settings
  // (Config → Knowledge cards). An old `?writer=` in the URL is ignored.
  const writer = '';
  const cardSettings = useQuery({ queryKey: ['kc-settings'], queryFn: () => knowledgeCardsApi.get(), staleTime: 30_000 });
  const savedWriter = cardSettings.data?.settings.writerModel;
  const savedChecker = cardSettings.data?.settings.checkerModel;
  const numericProject = typeof scope === 'number' ? scope : null;
  const [text, setText] = useState(url.q);
  const [offset, setOffset] = useState(0);
  const [compare, setCompare] = useState(false);
  const [projSearch, setProjSearch] = useState('');
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [onlyStale, setOnlyStale] = useState(false);
  const [onlyBuilding, setOnlyBuilding] = useState(false);
  // Show: all projects, only those with cards, or only those not started yet.
  const [projShow, setProjShow] = useState<'all' | 'started' | 'notStarted'>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [myJobs, setMyJobs] = useState<string[]>([]);

  const setUrl = (patch: Partial<Record<keyof ViewerUrlState, string | number | null>>) =>
    router.replace(`?${patchViewerUrl(sp.toString(), patch)}`, { scroll: false });

  useEffect(() => {
    const t = setTimeout(() => { if (text !== url.q) setUrl({ q: text }); }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  const filterKey = `${scope}|${writer}|${kind}|${mark}|${sort}|${url.q}`;
  useEffect(() => { setOffset(0); setSelected(new Set()); }, [filterKey]);
  // No project in the URL: show all projects (a card= deep link keeps working).
  useEffect(() => {
    if (scope === null) setUrl({ projectId: 'all' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  const counts = useQuery({ queryKey: ['kc-counts'], queryFn: knowledgeCardViewerApi.counts, refetchInterval: 5_000 });
  const jobs = useQuery({
    queryKey: ['kc-rebuild-jobs'], queryFn: knowledgeCardViewerApi.rebuildJobs, enabled: isAdmin,
    refetchInterval: q => ((q.state.data?.jobs ?? []).some(j => j.state === 'running' || j.state === 'queued') ? 2_000 : 10_000),
  });
  const shownJobs = (jobs.data?.jobs ?? []).filter(j => myJobs.includes(j.id) || j.state === 'running' || j.state === 'queued');
  const activeJobs = shownJobs.filter(j => j.state === 'running' || j.state === 'queued').length;
  useEffect(() => {
    if (activeJobs === 0 && myJobs.length) { qc.invalidateQueries({ queryKey: ['kc-list'] }); qc.invalidateQueries({ queryKey: ['kc-card'] }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJobs]);

  const list = useQuery({
    queryKey: ['kc-list', scope, writer, kind, mark, sort, url.q, offset],
    queryFn: () => knowledgeCardViewerApi.list({ projectId: scope!, writerModel: writer || undefined, kind, mark, q: url.q, sort, offset, limit: PAGE }),
    enabled: scope !== null,
    placeholderData: prev => prev,
  });
  const build = useMutation({
    mutationFn: () => knowledgeCardViewerApi.build(numericProject!, writer || undefined),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['kc-counts'] }); },
  });

  const projects = useMemo(() => {
    const needle = projSearch.trim().toLowerCase();
    return (counts.data?.projects ?? []).filter(p =>
      (!needle || p.name.toLowerCase().includes(needle) || String(p.projectId).includes(needle))
      && (!onlyFailed || p.failed > 0) && (!onlyStale || p.stale > 0) && (!onlyBuilding || !!p.building)
      && (projShow === 'all' || (projShow === 'started' ? p.total > 0 || !!p.building : p.total === 0 && !p.building)))
      // Projects with cards first, then the ones not started, each by name.
      .sort((a, b) => Number(b.total > 0 || !!b.building) - Number(a.total > 0 || !!a.building) || a.name.localeCompare(b.name));
  }, [counts.data, projSearch, onlyFailed, onlyStale, onlyBuilding, projShow]);
  const startedCount = (counts.data?.projects ?? []).filter(p => p.total > 0 || p.building).length;
  const notStartedCount = (counts.data?.projects.length ?? 0) - startedCount;
  const current = numericProject ? counts.data?.projects.find(p => p.projectId === numericProject) : undefined;
  const t = list.data?.totals;
  const marks = list.data?.marks;
  const pageIds = (list.data?.rows ?? []).map(r => r.rowId);
  const pageAllOn = pageIds.length > 0 && pageIds.every(id => selected.has(id));
  const matching = list.data?.total ?? 0;
  const markLabel = STATUS_BUTTONS.find(b => b.key === mark)?.label.toLowerCase();

  const selectAll = async () => {
    setBusy(true); setNotice(null);
    try {
      const r = await knowledgeCardViewerApi.ids({ projectId: scope!, writerModel: writer || undefined, kind, mark, q: url.q });
      setSelected(new Set(r.rowIds));
      if (r.truncated) setNotice({ ok: false, text: `Selected the first ${r.rowIds.length} of ${r.total} cards (limit).` });
    } catch (err) { setNotice({ ok: false, text: (err as Error).message }); } finally { setBusy(false); }
  };

  const runPending = async () => {
    if (!pending) return;
    setBusy(true); setNotice(null);
    try {
      if (pending.kind === 'build') {
        build.mutate();
      } else if (pending.kind === 'rebuild') {
        const ids: string[] = [];
        for (const part of chunk(pending.ids)) ids.push((await knowledgeCardViewerApi.rebuild(part)).job.id);
        setMyJobs(prev => [...ids, ...prev].slice(0, 30));
        setNotice({ ok: true, text: `Rebuild queued: ${pending.ids.length} card(s).` });
        qc.invalidateQueries({ queryKey: ['kc-rebuild-jobs'] });
      } else {
        let n = 0;
        for (const part of chunk(pending.ids)) n += (await knowledgeCardViewerApi.deleteCards(part)).deleted;
        setNotice({ ok: true, text: `Deleted ${n} card(s).` });
        if (cardId && pending.ids.includes(cardId)) setUrl({ card: null });
        setSelected(new Set());
        qc.invalidateQueries({ queryKey: ['kc-list'] });
        qc.invalidateQueries({ queryKey: ['kc-counts'] });
      }
    } catch (err) {
      setNotice({ ok: false, text: (err as Error).message });
    } finally { setBusy(false); setPending(null); }
  };

  const exportCards = async (format: 'json' | 'md') => {
    setBusy(true); setNotice(null);
    try {
      let ids = [...selected];
      if (!ids.length) ids = (await knowledgeCardViewerApi.ids({ projectId: scope!, writerModel: writer || undefined, kind, mark, q: url.q })).rowIds;
      const cards: ExportCard[] = [];
      for (const part of chunk(ids)) cards.push(...(await knowledgeCardViewerApi.exportCards(part)).cards);
      const base = `knowledge-cards-${scope}-${new Date().toISOString().slice(0, 10)}`;
      if (format === 'json') download(`${base}.json`, JSON.stringify(cards, null, 2), 'application/json');
      else download(`${base}.md`, cardsToMarkdown(cards), 'text/markdown');
      setNotice({ ok: true, text: `Exported ${cards.length} card(s).` });
    } catch (err) { setNotice({ ok: false, text: (err as Error).message }); } finally { setBusy(false); }
  };

  const dialog = pending && (
    pending.kind === 'build'
      ? { title: 'Build cards', okLabel: 'Build', danger: false,
        body: `Build cards for ${current?.name ?? `project ${numericProject}`}${writer ? ` with ${writer}` : ''}? This can spend OpenRouter credit.` }
      : pending.kind === 'rebuild'
        ? { title: 'Rebuild cards', okLabel: `Rebuild ${pending.ids.length}`, danger: false,
          body: `Rebuild ${pending.ids.length} card(s), each with its own writer model? This can spend OpenRouter credit (daily cap applies).` }
        : { title: 'Delete cards', okLabel: `Delete ${pending.ids.length}`, danger: true,
          body: `Delete ${pending.ids.length} card(s)? This cannot be undone; a later build writes them again.` }
  );

  const projRow = (key: string, active: boolean, onClick: () => void, name: string, count: number, sub?: React.ReactNode) => (
    <li key={key}>
      <button type="button" onClick={onClick}
        className={`w-full text-left px-2 py-1.5 rounded-md min-w-0 ${active ? 'bg-blue-50 text-blue-900' : 'hover:bg-gray-50 text-gray-800'}`}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium break-all min-w-0">{name}</span>
          <span className="text-xs text-gray-600 shrink-0">{count}</span>
        </div>
        {sub}
      </button>
    </li>
  );

  return (
    <div className="space-y-4 max-w-full overflow-x-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold text-gray-900">Knowledge Cards</h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[16rem_minmax(0,1fr)] gap-4 items-start">
        {/* Projects column */}
        <aside className="bg-white border border-gray-200 rounded-lg p-3 space-y-2 min-w-0">
          <h2 className="text-sm font-semibold text-gray-800">Projects</h2>
          <input className={inputCls} value={projSearch} onChange={e => setProjSearch(e.target.value)} placeholder="Search projects" />
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-700">
            <label className="flex items-center gap-1"><input type="checkbox" checked={onlyFailed} onChange={e => setOnlyFailed(e.target.checked)} /> has failed</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={onlyStale} onChange={e => setOnlyStale(e.target.checked)} /> has stale</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={onlyBuilding} onChange={e => setOnlyBuilding(e.target.checked)} /> building now</label>
          </div>
          <div className="flex flex-wrap gap-1 text-xs">
            {([['all', `All ${counts.data?.projects.length ?? 0}`], ['started', `With cards ${startedCount}`], ['notStarted', `Not started ${notStartedCount}`]] as const).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setProjShow(k)}
                className={`px-2 py-0.5 rounded-md border ${projShow === k ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'}`}>{label}</button>
            ))}
          </div>
          {counts.error && <p className="text-xs text-red-700">{(counts.error as Error).message}</p>}
          <ul className="space-y-0.5 max-h-[70vh] overflow-y-auto">
            {projRow('all', scope === 'all', () => setUrl({ projectId: 'all', card: null }), 'All projects', counts.data?.all.total ?? 0)}
            {projects.map(p => projRow(String(p.projectId), scope === p.projectId, () => setUrl({ projectId: p.projectId, card: null }),
              `${p.name} (${p.projectId})`, p.total,
              <div className="flex flex-wrap gap-2 text-xs text-gray-500">
                {p.total === 0 && !p.building && <span className="text-gray-400 italic">not started</span>}
                {p.total > 0 && <span className={p.failed ? 'text-red-700' : ''} title="failed check">✕{p.failed}</span>}
                {p.total > 0 && <span title="stale">○{p.stale}</span>}
                {p.building && <span className="text-blue-700" title="building">⟳ {p.building.built}/{p.building.targets}</span>}
              </div>))}
            {counts.data && projects.length === 0 && <li className="text-xs text-gray-500 px-2">No project matches.</li>}
          </ul>
        </aside>

        {/* Cards column */}
        <div className="space-y-4 min-w-0">
          <section className="bg-white border border-gray-200 rounded-lg p-3 space-y-3 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-gray-900 break-all min-w-0 mr-auto">
                {scope === 'all' ? 'All projects' : current ? `${current.name} (#${current.projectId})` : numericProject ? `Project #${numericProject}` : ''}
              </h2>
              <span className="text-xs text-gray-600 min-w-0 break-all" title="From Config → Knowledge cards. Change it there.">
                Writer <b className="text-gray-900">{savedWriter ?? '…'}</b>
                {savedChecker && <> · checker <b className="text-gray-900">{savedChecker}</b></>}
              </span>
              <button type="button" className={`${btnCls} bg-blue-600 text-white hover:bg-blue-700`}
                disabled={!numericProject || build.isPending || !!current?.building}
                title={numericProject ? undefined : 'Pick one project to build'} onClick={() => setPending({ kind: 'build' })}>
                {current?.building ? `Building ${current.building.built}/${current.building.targets}` : 'Build now'}
              </button>
              <Link href="/config/#knowledge-cards" className={`${btnCls} bg-gray-100 hover:bg-gray-200 text-gray-800`} title="Card settings">⚙</Link>
              <label className="flex items-center gap-1 text-sm text-gray-700">
                <input type="checkbox" checked={compare} onChange={e => setCompare(e.target.checked)} /> Compare writers
              </label>
            </div>
            {build.error && <p className="text-xs text-red-700">{(build.error as Error).message}</p>}
            {build.isSuccess && <p className="text-xs text-green-700">Build started: {build.data.run.targets} target(s).</p>}
            {t && (
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-700">
                <span><b>{t.cards}</b> cards</span>
                <span><b>{t.good}</b> good</span>
                <span><b>{t.low}</b> low</span>
                <span><b>{t.stale}</b> stale</span>
                <span><b>{t.failed}</b> failed</span>
                <span>spent <b>${t.spentUsd.toFixed(4)}</b></span>
                <span>last build <b>{day(t.lastBuilt)}</b></span>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-xs text-gray-600 mr-1">Status:</span>
              {STATUS_BUTTONS.map(b => {
                const n = marks ? (b.key ? marks[b.key] : marks.all) : undefined;
                const on = mark === b.key;
                return (
                  <button key={b.key || 'all'} type="button" onClick={() => setUrl({ mark: b.key })}
                    className={`px-2 py-1 rounded-md text-xs font-medium border ${on ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'}`}>
                    {b.label}{n !== undefined ? ` ${n}` : ''}
                  </button>
                );
              })}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-[auto_auto_minmax(0,1fr)] gap-2">
              <select className={inputCls} value={kind} onChange={e => setUrl({ kind: e.target.value })}>
                <option value="">All kinds</option>
                {Object.entries(list.data?.kinds ?? {}).map(([k, n]) => <option key={k} value={k}>{k} ({n})</option>)}
              </select>
              <select className={inputCls} value={sort} onChange={e => setUrl({ sort: e.target.value })}>
                <option value="fanin">Most used (fan-in)</option>
                <option value="confidence">Confidence</option>
                <option value="newest">Newest</option>
              </select>
              <input className={inputCls} value={text} onChange={e => setText(e.target.value)} placeholder="Search cards" />
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <button type="button" className={`${btnCls} bg-gray-100 hover:bg-gray-200`} disabled={busy || !matching} onClick={selectAll}>
                Select all {matching} {markLabel && mark ? markLabel : 'matching'}
              </button>
              {selected.size > 0 && <button type="button" className="text-xs text-gray-600 hover:underline" onClick={() => setSelected(new Set())}>Clear ({selected.size})</button>}
              {isAdmin && (
                <>
                  <button type="button" className={`${btnCls} bg-amber-100 hover:bg-amber-200 text-amber-900`} disabled={busy || !selected.size}
                    onClick={() => setPending({ kind: 'rebuild', ids: [...selected] })}>Rebuild selected ({selected.size})</button>
                  <button type="button" className={`${btnCls} bg-red-50 hover:bg-red-100 text-red-800`} disabled={busy || !selected.size}
                    onClick={() => setPending({ kind: 'delete', ids: [...selected] })}>Delete selected</button>
                </>
              )}
              <span className="text-xs text-gray-600">Export {selected.size ? `${selected.size} selected` : 'all matching'}:</span>
              <button type="button" className={`${btnCls} bg-gray-100 hover:bg-gray-200`} disabled={busy || (!selected.size && !matching)} onClick={() => exportCards('json')}>JSON</button>
              <button type="button" className={`${btnCls} bg-gray-100 hover:bg-gray-200`} disabled={busy || (!selected.size && !matching)} onClick={() => exportCards('md')}>Markdown</button>
            </div>
            {notice && <p className={`text-xs ${notice.ok ? 'text-green-700' : 'text-red-700'}`}>{notice.text}</p>}
            {shownJobs.slice(0, 5).map(j => (
              <JobLine key={j.id} job={j} onStop={() => { knowledgeCardViewerApi.stopRebuild(j.id).then(() => jobs.refetch()); }} />
            ))}
          </section>

          <AskPreview projectId={numericProject} writer={writer} onPick={rowId => setUrl({ card: rowId })} />

          <div className={`grid grid-cols-1 ${cardId ? 'xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]' : ''} gap-4`}>
            <section className="bg-white border border-gray-200 rounded-lg p-3 space-y-2 min-w-0">
              {list.error && <p className="text-xs text-red-700">{(list.error as Error).message}</p>}
              {list.isLoading && <p className="text-xs text-gray-500">Loading cards...</p>}
              {pageIds.length > 0 && (
                <label className="flex items-center gap-2 text-xs text-gray-600 px-1">
                  <input type="checkbox" checked={pageAllOn} onChange={() => setSelected(togglePage(selected, pageIds))} /> This page
                </label>
              )}
              <ul className="divide-y divide-gray-100">
                {(list.data?.rows ?? []).map(r => (
                  <li key={r.rowId} className={`flex items-start gap-2 ${cardId === r.rowId ? 'bg-blue-50' : ''}`}>
                    <input type="checkbox" className="mt-3 ml-1 shrink-0" aria-label={`select ${r.qualifiedName || r.name}`}
                      checked={selected.has(r.rowId)} onChange={() => setSelected(toggleId(selected, r.rowId))} />
                    <button type="button" onClick={() => setUrl({ card: r.rowId })} className="flex-1 text-left py-2 px-1 hover:bg-gray-50 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Mark m={r.mark} />
                        <span className="text-xs text-gray-500">{r.kind}</span>
                        <span className="text-xs text-gray-500">{pct(r.confidence)}</span>
                        {r.kind !== 'project' && r.kind !== 'pod' && <span className="text-xs text-gray-500">fan-in {r.fanIn}</span>}
                        {!writer && <span className="text-xs text-gray-400 break-all">{shortModel(r.writerModel)}</span>}
                        <span className="text-xs text-gray-400">{day(r.builtAt)}</span>
                        {scope === 'all' && <span className="text-xs text-gray-400">#{r.projectId}</span>}
                      </div>
                      <div className="text-sm font-medium text-gray-900 break-all">{r.qualifiedName || r.name}</div>
                      <div className="text-xs text-gray-600 line-clamp-2 break-words">{r.snippet}</div>
                    </button>
                  </li>
                ))}
                {list.data && list.data.rows.length === 0 && <li className="py-3 text-sm text-gray-500">No cards match.</li>}
              </ul>
              {list.data && list.data.total > PAGE && (
                <div className="flex items-center justify-between gap-2 text-xs text-gray-600">
                  <button type="button" className={`${btnCls} bg-gray-100`} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
                  <span>{offset + 1}-{Math.min(offset + PAGE, list.data.total)} of {list.data.total}</span>
                  <button type="button" className={`${btnCls} bg-gray-100`} disabled={offset + PAGE >= list.data.total} onClick={() => setOffset(offset + PAGE)}>Next</button>
                </div>
              )}
            </section>
            {cardId && (
              <section className="bg-white border border-gray-200 rounded-lg p-3 min-w-0">
                <CardPanel rowId={cardId} compare={compare} isAdmin={isAdmin} onClose={() => setUrl({ card: null })}
                  onRebuild={ids => setPending({ kind: 'rebuild', ids })} />
              </section>
            )}
          </div>
        </div>
      </div>

      {dialog && (
        <ConfirmDialog title={dialog.title} body={dialog.body} okLabel={dialog.okLabel} danger={dialog.danger} busy={busy}
          onOk={runPending} onCancel={() => setPending(null)} />
      )}
    </div>
  );
}

export default function KnowledgeCardsPage() {
  return (
    <Suspense fallback={<div className="p-4 text-sm text-gray-500">Loading...</div>}>
      <ViewerInner />
    </Suspense>
  );
}
