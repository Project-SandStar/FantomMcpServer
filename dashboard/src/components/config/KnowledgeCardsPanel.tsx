'use client';

/**
 * Settings page, tab "Knowledge Graph Cards" (/dashboard/config/#knowledge-cards).
 * Settings are saved with range checks on the server (PUT /admin/knowledge-cards).
 * The status table polls every 10 s; the form is filled once from the server
 * so the poll never overwrites what the user is typing.
 */
import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import {
  knowledgeCardsApi, type KnowledgeCardSettings, type KnowledgeCardModel, type KnowledgeCardEstimate,
} from '@/lib/api';

const inputCls = 'w-full px-3 py-2 border border-gray-300 rounded-lg font-mono text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent';
const labelCls = 'block text-sm font-medium text-gray-700 mb-1';
const helpCls = 'text-xs text-gray-500 mt-1';

type NumField = 'minLines' | 'maxCardsPerProject' | 'minConfidence' | 'matchThreshold' | 'dailyCapUsd' | 'concurrency' | 'sidecarPerHostLimit';
const NUM_FIELDS: Array<{ f: NumField; label: string; help: string }> = [
  { f: 'minLines', label: 'Minimum size (lines)', help: 'Smaller classes and functions get no card.' },
  { f: 'maxCardsPerProject', label: 'Most cards per project', help: 'Highest fan-in first.' },
  { f: 'minConfidence', label: 'Minimum confidence to serve', help: '0 to 1. Cards below this are never used.' },
  { f: 'matchThreshold', label: 'Match threshold', help: 'Cosine similarity the best card must reach before the fast path answers.' },
  { f: 'dailyCapUsd', label: 'Daily spend cap (USD)', help: 'Card building stops for the day at this amount.' },
  { f: 'concurrency', label: 'Cards in flight', help: 'Each card also waits for an OpenRouter bulk worker (or a sidecar slot).' },
  { f: 'sidecarPerHostLimit', label: 'Sidecar calls per host', help: 'Sidecar models only: card calls one sidecar GPU runs at once, so other roles keep working.' },
];

function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="flex items-center gap-3 cursor-pointer">
      <button type="button" disabled={disabled} onClick={() => onChange(!on)}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${on ? 'bg-blue-600' : 'bg-gray-300'} ${disabled ? 'opacity-50' : ''}`}>
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${on ? 'translate-x-6' : 'translate-x-1'}`} />
      </button>
      <span className="text-sm text-gray-700">{label}</span>
    </label>
  );
}

function modelLabel(m: KnowledgeCardModel): string {
  if (m.source === 'sidecar') {
    const name = m.container ?? m.id.replace(/^sidecar\//, '');
    const served = m.models?.length ? ` · ${m.models.join(' / ')}` : '';
    if (!m.live) return `${name}${served} (sidecar, free) — unavailable: ${m.reason ?? 'no online sidecar runs it'}`;
    const n = m.hosts?.length ?? 0;
    // Live: the list refetches every 10 s and hosts change hour by hour.
    return `${name}${served} (sidecar, free) — $0 / local · on ${n} host${n === 1 ? '' : 's'} now (${m.hosts!.join(', ')})`;
  }
  if (!m.live) return `${m.id} — unavailable: ${m.reason ?? 'not listed on OpenRouter'}`;
  return `${m.id} · $${m.inPerM.toFixed(3)} in / $${m.outPerM.toFixed(3)} out per M · ${Math.round(m.context / 1000)}k ctx`;
}

function ModelSelect({ value, models, onChange, label, disabled }: {
  value: string; models: KnowledgeCardModel[]; onChange: (v: string) => void; label: string; disabled?: boolean;
}) {
  // Blocked-for-this-account models stay listed, disabled, with the reason.
  const cloud = models.filter(m => m.source !== 'sidecar' && (m.live || m.id === value || !!m.reason));
  // Sidecar models are always listed; one with no live host is disabled with
  // its reason, unless it is the saved value (kept selectable so a save does
  // not change it).
  const sidecar = models.filter(m => m.source === 'sidecar');
  const known = [...cloud, ...sidecar].some(m => m.id === value);
  return (
    <div>
      <label className={labelCls}>{label}</label>
      <select className={inputCls} value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>
        {!known && <option value={value}>{value}</option>}
        <optgroup label="OpenRouter">
          {cloud.map(m => <option key={m.id} value={m.id} disabled={!m.live && m.id !== value}>{modelLabel(m)}</option>)}
        </optgroup>
        {sidecar.length > 0 && (
          <optgroup label="Sidecar (local GPU)">
            {sidecar.map(m => (
              <option key={m.id} value={m.id} disabled={!m.live && m.id !== value}
                title={m.offline?.length ? `Offline on the Sidecars tab: ${m.offline.join(', ')}` : undefined}>{modelLabel(m)}</option>
            ))}
          </optgroup>
        )}
      </select>
    </div>
  );
}

export function KnowledgeCardsPanel() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['knowledge-cards'], queryFn: knowledgeCardsApi.get, refetchInterval: 10000 });
  const [draft, setDraft] = useState<KnowledgeCardSettings | null>(null);
  const [nums, setNums] = useState<Record<NumField, string>>({} as Record<NumField, string>);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [estimates, setEstimates] = useState<Record<number, KnowledgeCardEstimate | string>>({});

  const fill = (s: KnowledgeCardSettings) => {
    setDraft(s);
    setNums(Object.fromEntries(NUM_FIELDS.map(({ f }) => [f, String(s[f] ?? "")])) as Record<NumField, string>);
  };
  useEffect(() => { if (q.data && !draft) fill(q.data.settings); }, [q.data, draft]);

  const save = useMutation({
    mutationFn: () => {
      if (!draft || !q.data) throw new Error('not loaded');
      // Send only the fields changed on this form, compared with the server's
      // current values: the server applies a partial update, so a field the
      // user did not touch (e.g. useForAsks) is never overwritten.
      const base = q.data.settings as unknown as Record<string, unknown>;
      const next: Record<string, unknown> = { ...draft };
      for (const { f } of NUM_FIELDS) next[f] = nums[f] === '' ? base[f] : Number(nums[f]);
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(next)) {
        if (JSON.stringify(v) !== JSON.stringify(base[k])) body[k] = v;
      }
      return knowledgeCardsApi.save(body as Partial<KnowledgeCardSettings>);
    },
    onSuccess: r => { fill(r.settings); setError(null); setSaved(true); setTimeout(() => setSaved(false), 2500); qc.invalidateQueries({ queryKey: ['knowledge-cards'] }); },
    onError: (e: Error) => { setError(e.message); setSaved(false); },
  });

  const estimate = async (id: number) => {
    setEstimates(e => ({ ...e, [id]: '…' }));
    try { const r = await knowledgeCardsApi.estimate(id); setEstimates(e => ({ ...e, [id]: r })); }
    catch (err) { setEstimates(e => ({ ...e, [id]: (err as Error).message })); }
  };
  const build = useMutation({
    mutationFn: (id: number) => knowledgeCardsApi.build(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['knowledge-cards'] }),
    onError: (e: Error) => setError(e.message),
  });

  if (q.isLoading || !draft) return <div className="text-sm text-gray-500">Loading…</div>;
  if (q.error) return <div className="text-sm text-red-600">{(q.error as Error).message}</div>;
  const data = q.data!;
  const set = <K extends keyof KnowledgeCardSettings>(k: K, v: KnowledgeCardSettings[K]) => setDraft({ ...draft, [k]: v });
  const projectName = (id: number) => data.projects.find(p => p.id === id)?.name ?? `#${id}`;
  const shownProjects = draft.projectScope === 'list' ? draft.projectIds : [...new Set(data.status.map(s => s.projectId))];

  return (
    <div className="space-y-6">
      <p className="text-sm"><a href="/dashboard/knowledge-cards/" className="text-blue-700 hover:underline">Open the Knowledge Card viewer</a> to read, search and compare cards.</p>
      <section className="space-y-3">
        <Toggle on={draft.enabled} onChange={v => set('enabled', v)} label="Enable card building" disabled={!isAdmin} />
        <Toggle on={draft.useForAsks} onChange={v => set('useForAsks', v)} label="Use cards to answer asks (fast path)" disabled={!isAdmin} />
        <Toggle on={draft.checkPass} onChange={v => set('checkPass', v)} label="Check pass (a second model checks every claim)" disabled={!isAdmin} />
        <Toggle on={draft.autoRefresh} onChange={v => set('autoRefresh', v)} label="Auto-refresh stale cards after re-index" disabled={!isAdmin} />
      </section>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <ModelSelect label="Writer model" value={draft.writerModel} models={data.models} onChange={v => set('writerModel', v)} disabled={!isAdmin} />
        <ModelSelect label="Checker model" value={draft.checkerModel} models={data.models} onChange={v => set('checkerModel', v)} disabled={!isAdmin} />
        <ModelSelect label="Answer model (fast path)" value={draft.answerModel} models={data.models} onChange={v => set('answerModel', v)} disabled={!isAdmin} />
      </section>

      <section className="space-y-2">
        <label className={labelCls}>Projects</label>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="radio" checked={draft.projectScope === 'all'} onChange={() => set('projectScope', 'all')} disabled={!isAdmin} /> All</label>
          <label className="flex items-center gap-2"><input type="radio" checked={draft.projectScope === 'list'} onChange={() => set('projectScope', 'list')} disabled={!isAdmin} /> Chosen list</label>
        </div>
        {draft.projectScope === 'list' && (
          <select multiple className={`${inputCls} h-40`} disabled={!isAdmin}
            value={draft.projectIds.map(String)}
            onChange={e => set('projectIds', Array.from(e.target.selectedOptions).map(o => Number(o.value)))}>
            {data.projects.map(p => <option key={p.id} value={p.id}>{p.name} (#{p.id})</option>)}
          </select>
        )}
      </section>

      <section className="space-y-2">
        <label className={labelCls}>What gets a card</label>
        <div className="flex flex-wrap gap-6">
          {(['projects', 'pods', 'classes', 'functions'] as const).map(k => (
            <Toggle key={k} on={draft.kinds[k]} label={k === 'functions' ? 'public functions' : k} disabled={!isAdmin}
              onChange={v => set('kinds', { ...draft.kinds, [k]: v })} />
          ))}
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {NUM_FIELDS.map(({ f, label, help }) => {
          const r = data.limits[f];
          return (
            <div key={f}>
              <label className={labelCls}>{label}</label>
              <input className={inputCls} type="number" min={r?.min} max={r?.max} step={r?.step ?? 1} value={nums[f] ?? ''}
                disabled={!isAdmin} onChange={e => setNums({ ...nums, [f]: e.target.value })} />
              <p className={helpCls}>{help}{r ? ` Range ${r.min}–${r.max}, default ${r.def}.` : ''}</p>
            </div>
          );
        })}
      </section>

      {isAdmin && (
        <div className="flex items-center gap-3">
          <button onClick={() => save.mutate()} disabled={save.isPending}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          {saved && <span className="text-sm text-green-600">Saved</span>}
          {error && <span className="text-sm text-red-600">{error}</span>}
        </div>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-gray-800">Status</h3>
        <p className="text-xs text-gray-500">
          Spend today: ${data.spendToday.usd.toFixed(4)} of ${draft.dailyCapUsd.toFixed(2)}
          {data.runs.filter(r => r.state === 'running').map(r => ` · building ${projectName(r.projectId)} (${r.writerModel}): ${r.built}/${r.targets}`).join('')}
        </p>
        <table className="w-full text-sm border border-gray-200 rounded">
          <thead className="bg-gray-50 text-left text-xs text-gray-600">
            <tr><th className="p-2">Project</th><th className="p-2">Writer</th><th className="p-2">Total</th><th className="p-2">Fresh</th>
              <th className="p-2">Stale</th><th className="p-2">Check</th><th className="p-2">Flagged</th><th className="p-2">Last built</th>
              <th className="p-2">Cost</th><th className="p-2"></th></tr>
          </thead>
          <tbody>
            {shownProjects.length === 0 && <tr><td className="p-2 text-gray-500" colSpan={10}>No cards yet. Choose projects above, save, then Build now.</td></tr>}
            {shownProjects.map(pid => {
              const rows = data.status.filter(s => s.projectId === pid);
              const est = estimates[pid];
              const actions = isAdmin && (
                <div className="flex flex-col gap-1 items-end">
                  <div className="flex gap-2">
                    <button className="text-xs px-2 py-1 border rounded" onClick={() => estimate(pid)}>Estimate</button>
                    <button className="text-xs px-2 py-1 bg-blue-600 text-white rounded disabled:opacity-50"
                      disabled={build.isPending || !draft.enabled} title={draft.enabled ? '' : 'Enable card building first'}
                      onClick={() => build.mutate(pid)}>Build now</button>
                  </div>
                  {est && <span className="text-xs text-gray-500">{typeof est === 'string' ? est : `${est.targets} cards ≈ $${est.estimateUsd.toFixed(3)}`}</span>}
                </div>
              );
              if (rows.length === 0) {
                return <tr key={pid} className="border-t"><td className="p-2">{projectName(pid)}</td><td className="p-2 text-gray-400" colSpan={8}>no cards</td><td className="p-2">{actions}</td></tr>;
              }
              return rows.map((s, i) => (
                <tr key={`${pid}-${s.writerModel}`} className="border-t">
                  <td className="p-2">{i === 0 ? projectName(pid) : ''}</td>
                  <td className="p-2 font-mono text-xs">{s.writerModel}</td>
                  <td className="p-2">{s.total}</td><td className="p-2 text-green-700">{s.fresh}</td>
                  <td className="p-2 text-amber-700">{s.stale}</td><td className="p-2">{s.check}</td>
                  <td className="p-2 text-red-700">{s.flagged}</td>
                  <td className="p-2 text-xs">{s.lastBuilt ? new Date(s.lastBuilt).toLocaleString() : '—'}</td>
                  <td className="p-2 text-xs">${s.costUsd.toFixed(4)}</td>
                  <td className="p-2">{i === 0 ? actions : null}</td>
                </tr>
              ));
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
