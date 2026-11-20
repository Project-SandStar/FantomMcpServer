'use client';

/**
 * Settings page, tab "Graph" (/dashboard/config/#graph): graph-store tuning
 * knobs and live pool stats. Precedence per knob: saved here > env var > code
 * default. Each row shows the effective value and where it came from; "Reset"
 * clears the saved value so the env var (or default) applies again.
 * Server: GET/PUT /admin/graph/settings (src/admin/graphSettingsRoutes.ts).
 */
import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { graphSettingsApi, type GraphKnobView, type GraphSettingsView } from '@/lib/api';

const inputCls = 'w-32 px-2 py-1 border border-gray-300 rounded font-mono text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent';

const APPLY_LABEL: Record<GraphKnobView['apply'], { text: string; cls: string; title: string }> = {
  live: { text: 'live', cls: 'bg-green-100 text-green-800', title: 'Takes effect at once.' },
  'next-open': { text: 'next open', cls: 'bg-amber-100 text-amber-800', title: 'Applies when a store is next opened; open stores keep their current pool.' },
  restart: { text: 'restart', cls: 'bg-red-100 text-red-800', title: 'Needs a server restart.' },
};

const SOURCE_CLS: Record<GraphKnobView['source'], string> = {
  saved: 'bg-blue-100 text-blue-800',
  env: 'bg-purple-100 text-purple-800',
  default: 'bg-gray-100 text-gray-700',
};

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="p-3 border border-gray-200 rounded-lg bg-white">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-lg font-semibold font-mono">{value}</div>
      {sub && <div className="text-xs text-gray-500">{sub}</div>}
    </div>
  );
}

function fmtMb(n: number | null): string {
  if (n === null) return 'n/a';
  return n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${n} MB`;
}

export function GraphPanel() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['graph-settings'], queryFn: graphSettingsApi.get, refetchInterval: 5000 });
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const fill = (v: GraphSettingsView) => setInputs(Object.fromEntries(v.knobs.map(k => [k.name, String(k.value)])));
  // Fill the form once; the 5 s poll only refreshes the stats.
  useEffect(() => { if (q.data && !loaded) { fill(q.data); setLoaded(true); } }, [q.data, loaded]);

  const save = useMutation({
    mutationFn: (patch: Record<string, number | null>) => graphSettingsApi.save(patch),
    onSuccess: (v) => {
      fill(v); setError(null); setNotice('Saved.'); setTimeout(() => setNotice(null), 2500);
      qc.setQueryData(['graph-settings'], v);
    },
    onError: (e: Error) => { setError(e.message); setNotice(null); },
  });

  if (q.isLoading) return <div className="text-sm text-gray-500">Loading graph settings…</div>;
  if (q.error || !q.data) return <div className="text-sm text-red-600">Could not load graph settings: {(q.error as Error)?.message}</div>;
  const v = q.data;

  const changed = v.knobs.filter(k => inputs[k.name] !== undefined && inputs[k.name] !== String(k.value));
  const saveChanged = () => {
    const patch: Record<string, number | null> = {};
    for (const k of changed) patch[k.name] = Number(inputs[k.name]);
    save.mutate(patch);
  };
  const w = v.memory.warning;

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-600">
        Tuning for the per-project LadybugDB graph stores. Order: value saved here, then the env var, then the code default.
        The ask retrieval cap lives on the OpenRouter tab (RLM pipeline).
      </p>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-800">Live pool</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Open stores" value={`${v.pool.open} / ${v.pool.cap}`} sub={`${v.pool.busy} busy`} />
          <Stat label="Evictions since boot" value={String(v.pool.evictions)} sub={`${v.pool.reopens} reopens, ${v.pool.opens} opens`} />
          <Stat label="Buffer pools (open)" value={fmtMb(v.pool.poolMiBTotal)} sub="sum of pool MiB per open store" />
          <Stat label="Process RSS" value={fmtMb(v.memory.rssMb)}
            sub={v.memory.approxMbPerOpenStore !== null ? `~${v.memory.approxMbPerOpenStore} MB per open store (whole process / open)` : 'no store open'} />
          <Stat label="Container memory" value={fmtMb(v.memory.containerMb)} sub="cgroup memory.current (n/a outside a container)" />
          <Stat label="Memory limit" value={fmtMb(v.memory.memLimitMb)} />
          <Stat label="RSS guard" value={v.memory.guardMb > 0 ? fmtMb(v.memory.guardMb) : 'off'} sub="process exits (137) above this" />
          <Stat label="RSS if pool is full" value={fmtMb(w.projectedMb)} sub={`estimate: cap x ~${v.memory.estMbPerStore} MB`} />
        </div>
        {w.message && (
          <div className={`p-3 rounded-lg text-sm ${w.level === 'danger' ? 'bg-red-50 text-red-800 border border-red-200' : 'bg-amber-50 text-amber-800 border border-amber-200'}`}>
            {w.message}
          </div>
        )}
        {(v.pool.closeFailures.connection > 0 || v.pool.closeFailures.database > 0) && (
          <div className="text-xs text-red-700">
            Close failures: {v.pool.closeFailures.connection} connection, {v.pool.closeFailures.database} database (each orphans that store&apos;s memory).
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-800">Settings</h3>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b">
                <th className="py-2 pr-3">Setting</th>
                <th className="py-2 pr-3">Value</th>
                <th className="py-2 pr-3">Source</th>
                <th className="py-2 pr-3">Range</th>
                <th className="py-2 pr-3">Applies</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {v.knobs.map(k => {
                const a = APPLY_LABEL[k.apply];
                return (
                  <tr key={k.name} className="border-b align-top">
                    <td className="py-2 pr-3">
                      <div className="font-medium text-gray-800">{k.label}</div>
                      <div className="text-xs text-gray-500 max-w-md">{k.help}</div>
                      <div className="text-xs text-gray-400 font-mono">
                        {k.env}{k.envValue !== null ? `=${k.envValue}` : ' (unset)'} · default {k.default ?? k.autoLabel}
                      </div>
                    </td>
                    <td className="py-2 pr-3">
                      <input type="number" className={inputCls} min={k.min} max={k.max} step={k.step ?? 'any'}
                        disabled={!isAdmin} value={inputs[k.name] ?? ''}
                        onChange={e => setInputs(s => ({ ...s, [k.name]: e.target.value }))} />
                    </td>
                    <td className="py-2 pr-3">
                      <span className={`px-2 py-0.5 rounded text-xs ${SOURCE_CLS[k.source]}`}>{k.source}</span>
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs text-gray-600">{k.min} – {k.max}</td>
                    <td className="py-2 pr-3">
                      <span className={`px-2 py-0.5 rounded text-xs ${a.cls}`} title={a.title}>{a.text}</span>
                    </td>
                    <td className="py-2">
                      {k.saved !== null && isAdmin && (
                        <button type="button" onClick={() => save.mutate({ [k.name]: null })} disabled={save.isPending}
                          className="text-xs text-blue-600 hover:underline disabled:opacity-50"
                          title="Clear the saved value; the env var or default applies again.">
                          Reset
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex items-center gap-3">
          <button type="button" onClick={saveChanged} disabled={!isAdmin || save.isPending || changed.length === 0}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm">
            {save.isPending ? 'Saving…' : changed.length ? `Save ${changed.length} change${changed.length > 1 ? 's' : ''}` : 'Save'}
          </button>
          {changed.length > 0 && (
            <button type="button" onClick={() => fill(v)} className="text-sm text-gray-600 hover:underline">Discard</button>
          )}
          {notice && <span className="text-sm text-green-700">{notice}</span>}
          {error && <span className="text-sm text-red-700">{error}</span>}
          {!isAdmin && <span className="text-xs text-gray-500">Admin role needed to change settings.</span>}
        </div>
        <p className="text-xs text-gray-500">
          Lowering the open-stores cap closes idle stores at once; busy stores close when their query ends. &quot;Next open&quot; settings
          reach each store the next time it is opened. &quot;Restart&quot; settings need a server restart.
        </p>
      </section>
    </div>
  );
}
