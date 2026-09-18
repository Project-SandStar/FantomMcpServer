'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  api, Sidecar, SidecarContainerInfo, LoadedModelInfo,
  VirtualContainer, MasterSlotStatus, VectorRefusal, VectorVerification,
} from '@/lib/api';

const ROLE_ORDER = ['embedding', 'completion', 'ocr', 'reranker', 'cuda'];

function PsCell({ container }: { container: SidecarContainerInfo }) {
  if (container.status !== 'running') return <span className="text-gray-300">—</span>;
  const m: LoadedModelInfo | undefined = container.loadedModels?.[0];
  if (!m) {
    if (container.config?.gpuOnly) return <span className="text-amber-600 text-xs">not loaded (GPU required)</span>;
    return <span className="text-gray-400 text-xs">not loaded</span>;
  }
  const gpuPct = m.gpuPercent ?? (m.processor === 'GPU' ? 100 : 0);
  const color =
    gpuPct >= 99 ? 'text-green-700'
    : gpuPct > 0 ? 'text-amber-600'
    : 'text-red-600';
  const proc = m.processor ?? (gpuPct >= 99 ? 'GPU' : gpuPct > 0 ? 'GPU/CPU' : 'CPU');
  return (
    <div className={`text-xs font-mono ${color}`}>
      {m.name}
      <div className="text-[10px] text-gray-500">
        ({proc} {gpuPct}%{m.size ? ` ${m.size}` : ''})
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const style =
    status === 'running' ? 'bg-green-100 text-green-800'
    : status === 'exited' ? 'bg-gray-100 text-gray-700'
    : status === 'not_found' ? 'bg-red-50 text-red-700'
    : 'bg-amber-50 text-amber-700';
  return <span className={`text-xs px-2 py-0.5 rounded ${style}`}>{status}</span>;
}

function FleetForSidecar({ sidecar }: { sidecar: Sidecar }) {
  const qc = useQueryClient();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, error: queryError } = useQuery({
    queryKey: ['sidecar-status', sidecar.id],
    queryFn: () => api.getSidecarStatus(sidecar.id),
    refetchInterval: 10_000,
    retry: 1,
  });

  const registerMut = useMutation({
    mutationFn: () => api.registerSidecarAsMaster(sidecar.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sidecars'] }),
    onError: (err: any) => setError(`Register failed: ${err?.message ?? err}`),
  });

  const actMut = useMutation({
    mutationFn: ({ action, role, model }: { action: 'start' | 'stop' | 'pull' | 'pull-and-load'; role: string; model?: string }) =>
      api.sidecarAction(sidecar.id, action, role, model),
    onMutate: ({ action, role }) => { setPendingKey(`${role}:${action}`); setError(null); },
    onSettled: () => { setPendingKey(null); },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sidecar-status', sidecar.id] }); },
    onError: (err: any) => { setError(err?.message ?? String(err)); },
  });

  if (isLoading) return <div className="text-xs text-gray-500 p-3">Loading status from {sidecar.name}…</div>;
  if (queryError) return (
    <div className="text-xs text-red-600 p-3">
      Couldn&apos;t reach {sidecar.name} at <code>{sidecar.host}:{sidecar.port}/status</code>.
    </div>
  );

  const containers = data?.snapshot.containers ?? {};
  const roles = Object.keys(containers).sort(
    (a, b) => (ROLE_ORDER.indexOf(a) + 1 || 999) - (ROLE_ORDER.indexOf(b) + 1 || 999),
  );
  if (roles.length === 0) {
    return <div className="text-xs text-gray-500 p-3">No containers reported by {sidecar.name}.</div>;
  }

  const isPending = (role: string, action: string) => pendingKey === `${role}:${action}` && actMut.isPending;

  return (
    <div className="border border-gray-200 rounded-md overflow-hidden">
      <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
        <div className="text-sm font-medium text-gray-900 flex items-center gap-2 flex-wrap">
          <span>{sidecar.name}</span>
          {data?.snapshot.hostname && (
            <span className="text-xs font-mono px-1.5 py-0.5 bg-blue-50 text-blue-800 rounded">
              {data.snapshot.hostname}
            </span>
          )}
          <span className="text-xs text-gray-500 font-mono">{sidecar.host}:{sidecar.port}</span>
          {data?.snapshot.mode && (
            <span className="text-xs text-gray-500">· {data.snapshot.mode}</span>
          )}
          {data?.source && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${
              data.source === 'ws-heartbeat' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'
            }`}>
              {data.source}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="text-xs text-gray-500">
            {data?.snapshot.gpus?.length ? `${data.snapshot.gpus.length} GPU` : ''}
            {data?.snapshot.totalVram ? ` · ${(data.snapshot.totalVram / 1024).toFixed(1)} GB VRAM` : ''}
            {data?.snapshot.freeVram !== undefined ? ` · ${(data.snapshot.freeVram / 1024).toFixed(1)} GB free` : ''}
          </div>
          {data?.source !== 'ws-heartbeat' && (
            <button
              onClick={() => registerMut.mutate()}
              disabled={registerMut.isPending}
              title="Push Fantom to this sidecar's /api/masters list so it heartbeats us over WS"
              className="text-xs px-2 py-1 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded disabled:opacity-50"
            >
              {registerMut.isPending ? '…' : 'Register as master'}
            </button>
          )}
        </div>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-xs text-gray-600">
          <tr>
            <th className="text-left px-3 py-2 font-medium">Role</th>
            <th className="text-left px-3 py-2 font-medium">Container</th>
            <th className="text-left px-3 py-2 font-medium">Model</th>
            <th className="text-left px-3 py-2 font-medium">PS</th>
            <th className="text-left px-3 py-2 font-medium">Status</th>
            <th className="text-right px-3 py-2 font-medium">Action</th>
          </tr>
        </thead>
        <tbody>
          {roles.map(role => {
            const c = containers[role];
            const isOllama = c.type === 'ollama' || c.config?.type === 'ollama';
            const running = c.status === 'running';
            return (
              <tr key={role} className="border-t border-gray-100">
                <td className="px-3 py-2 font-medium text-gray-900">{role}</td>
                <td className="px-3 py-2 text-xs font-mono text-gray-700">{c.name}</td>
                <td className="px-3 py-2 text-xs font-mono text-gray-700">{c.model ?? c.config?.model ?? <span className="text-gray-400">none</span>}</td>
                <td className="px-3 py-2"><PsCell container={c} /></td>
                <td className="px-3 py-2"><StatusPill status={c.status} /></td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1.5">
                    {running ? (
                      <button
                        disabled={actMut.isPending}
                        onClick={() => actMut.mutate({ action: 'stop', role })}
                        className="text-xs px-2 py-1 bg-red-50 hover:bg-red-100 text-red-700 rounded disabled:opacity-50"
                      >{isPending(role, 'stop') ? '…' : 'Stop'}</button>
                    ) : (
                      <button
                        disabled={actMut.isPending}
                        onClick={() => actMut.mutate({ action: 'start', role })}
                        className="text-xs px-2 py-1 bg-green-50 hover:bg-green-100 text-green-700 rounded disabled:opacity-50"
                      >{isPending(role, 'start') ? '…' : 'Start'}</button>
                    )}
                    {isOllama && c.model && (
                      <>
                        <button
                          disabled={actMut.isPending}
                          onClick={() => actMut.mutate({ action: 'pull', role })}
                          className="text-xs px-2 py-1 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded disabled:opacity-50"
                        >{isPending(role, 'pull') ? '…' : 'Pull'}</button>
                        <button
                          disabled={actMut.isPending}
                          onClick={() => actMut.mutate({ action: 'pull-and-load', role })}
                          className="text-xs px-2 py-1 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded disabled:opacity-50"
                        >{isPending(role, 'pull-and-load') ? '…' : 'Pull & Load'}</button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {error && <div className="px-3 py-2 text-xs text-red-600 bg-red-50 border-t border-red-100">Action failed: {error}</div>}
    </div>
  );
}

function ModePill({ mode }: { mode: VirtualContainer['mode'] }) {
  const style =
    mode === 'cloud-only' ? 'bg-violet-100 text-violet-800'
    : mode === 'local-first' ? 'bg-sky-100 text-sky-800'
    : 'bg-gray-100 text-gray-600';
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${style}`}>{mode}</span>;
}

/**
 * Cloud-backed providers. Kept visually distinct from the container tables
 * above because they are NOT that host's GPU — they have no VRAM and no
 * gpuPercent, and a reader who confuses the two will think a Mac grew a
 * second accelerator.
 */
function VirtualContainersPanel({
  virtual, slots, masterWsPort, lastRerank,
}: {
  virtual: VirtualContainer[];
  slots: MasterSlotStatus[];
  masterWsPort?: number;
  lastRerank?: { path: string; servedBy: string; model: string; at: string; ms: number } | null;
}) {
  const qc = useQueryClient();
  const [reports, setReports] = useState<string | null>(null);

  const { data: verification } = useQuery({
    queryKey: ['virtual-verification'],
    queryFn: () => api.getVirtualVerification(),
    refetchInterval: 30_000,
  });

  const refreshMut = useMutation({
    mutationFn: () => api.refreshVirtualContainers(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sidecars'] }),
  });

  const verifyMut = useMutation({
    mutationFn: () => api.verifyVirtualContainers(),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['virtual-verification'] });
      // The note is context for the reports, not a replacement for them — it
      // only stood in for them when there were none to show.
      setReports([
        r.reports.length === 0 ? (r.note ?? '') : '',
        r.reference
          ? `reference: ${r.reference}${r.regime === 'cloud-ref' ? ' (a cloud peer — this role is on "OpenRouter only")' : ''}`
          : '',
        ...r.reports.map(x =>
          `${x.providerName}: ${x.ok ? 'PASS' : 'REFUSED'} — ${x.reason}`
          + (x.minCosine !== undefined ? ` (min cosine ${x.minCosine.toFixed(6)}, ${x.dims}d)` : '')),
        r.reports.length > 0 ? (r.note ?? '') : '',
      ].filter(Boolean).join('\n'));
    },
    onError: (e: unknown) => setReports(`Verification failed: ${(e as Error)?.message ?? e}`),
  });

  const refusedBy = new Map<string, VectorRefusal>((verification?.refusals ?? []).map(f => [f.providerName, f]));
  const okBy = new Map<string, VectorVerification>((verification?.verified ?? []).map(v => [v.providerName, v]));
  const unconfigured = slots.filter(s => s.openrouter !== 'configured');

  return (
    <div className="border border-violet-200 rounded-md overflow-hidden">
      <div className="px-3 py-2 bg-violet-50 border-b border-violet-200 flex items-center justify-between">
        <div className="text-sm font-medium text-gray-900">
          Cloud-backed providers <span className="text-xs font-normal text-gray-600">(OpenRouter · no GPU, no VRAM)</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refreshMut.mutate()}
            disabled={refreshMut.isPending}
            className="text-xs px-2 py-1 bg-white hover:bg-gray-50 text-gray-700 border border-gray-200 rounded disabled:opacity-50"
          >{refreshMut.isPending ? '…' : 'Rediscover'}</button>
          <button
            onClick={() => verifyMut.mutate()}
            disabled={verifyMut.isPending}
            title="Embed 10 probe texts locally and on OpenRouter and compare. Touches no vector table and starts no job."
            className="text-xs px-2 py-1 bg-violet-100 hover:bg-violet-200 text-violet-800 rounded disabled:opacity-50"
          >{verifyMut.isPending ? 'Verifying…' : 'Verify vectors'}</button>
        </div>
      </div>

      {virtual.length === 0 ? (
        <div className="px-3 py-3 text-xs text-gray-600 space-y-1">
          <div>No OpenRouter capacity is available to Fantom.</div>
          {unconfigured.length > 0 && (
            <div className="text-gray-500">
              {unconfigured.length} sidecar(s) report <code>openrouter: &quot;unset&quot;</code> for Fantom&apos;s
              master slot{masterWsPort ? ` (wsPort ${masterWsPort})` : ''}. The sidecar scopes its OpenRouter key and
              allow-list <em>per master</em>, so capacity configured for another master is deliberately not usable
              here. Push one from the OpenRouter page.
            </div>
          )}
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-violet-50/50 text-xs text-gray-600">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Provider</th>
              <th className="text-left px-3 py-2 font-medium">Role</th>
              <th className="text-left px-3 py-2 font-medium">Model</th>
              <th className="text-left px-3 py-2 font-medium">Upstream</th>
              <th className="text-left px-3 py-2 font-medium">Mode</th>
              <th className="text-left px-3 py-2 font-medium">Vectors</th>
              <th className="text-right px-3 py-2 font-medium">Served</th>
            </tr>
          </thead>
          <tbody>
            {virtual.map(v => {
              const refusal = refusedBy.get(v.providerName);
              const ok = okBy.get(v.providerName);
              const isEmbed = v.role !== 'reranker';
              return (
                <tr key={v.providerName} className="border-t border-gray-100">
                  <td className="px-3 py-2 font-medium text-gray-900">
                    {v.providerName}
                    <div className="text-[10px] text-gray-500">
                      via {v.sidecarName}{v.source === 'config' ? ' · declared locally' : ''}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-700">{v.role}</td>
                  <td className="px-3 py-2 text-xs font-mono text-gray-700">{v.model}</td>
                  <td className="px-3 py-2 text-xs text-gray-600">{v.upstreamProvider ?? <span className="text-gray-400">unpinned</span>}</td>
                  <td className="px-3 py-2"><ModePill mode={v.mode} /></td>
                  <td className="px-3 py-2 text-xs">
                    {!isEmbed ? (
                      <span className="text-gray-400" title="Rerank is stateless — it shares no vector space, so there is nothing to verify.">n/a</span>
                    ) : ok ? (
                      // A sole cloud provider under "OpenRouter only" has no
                      // peer to compare with, so there is no cosine to show.
                      // Printing one anyway would claim a measurement that was
                      // never taken.
                      <span
                        className="text-green-700"
                        title={
                          ok.minCosine !== undefined
                            ? `min cosine ${ok.minCosine} vs ${ok.referenceName ?? 'the reference'}`
                              + ` (${ok.reference ?? 'local-ref'}), ${ok.dims}d`
                            : `${ok.dims}d, pinned upstream — sole cloud provider, so nothing was compared`
                        }
                      >
                        {ok.minCosine !== undefined
                          ? `verified ${ok.minCosine.toFixed(4)}`
                          : 'verified · dims + pin'}
                      </span>
                    ) : refusal ? (
                      <span className="text-red-700" title={refusal.reason}>refused · {refusal.kind}</span>
                    ) : (
                      <span className="text-amber-600" title="Not yet verified — it will not serve any text until it passes.">unverified</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-gray-700">
                    {v.served ?? 0}
                    {v.failures ? <span className="text-red-600"> · {v.failures} failed</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {lastRerank && (
        <div className="px-3 py-2 text-xs border-t border-gray-100 bg-gray-50 text-gray-700">
          Last rerank served by <span className="font-medium">{lastRerank.servedBy}</span>{' '}
          <span className={lastRerank.path === 'local' ? 'text-green-700' : 'text-violet-700'}>({lastRerank.path})</span>{' '}
          · {lastRerank.model} · {lastRerank.ms}ms
        </div>
      )}
      {reports && (
        <pre className="px-3 py-2 text-[11px] whitespace-pre-wrap border-t border-gray-100 bg-gray-50 text-gray-700">{reports}</pre>
      )}
    </div>
  );
}

export function SidecarFleetTable() {
  const { data, isLoading } = useQuery({
    queryKey: ['sidecars'],
    queryFn: () => api.listSidecars({ enabled: true }),
    refetchInterval: 10_000,
  });

  if (isLoading) return null;
  const sidecars = data?.sidecars ?? [];
  const virtual = data?.virtual ?? [];
  const slots = data?.slots ?? [];
  if (sidecars.length === 0 && virtual.length === 0) return null;

  return (
    <div className="space-y-3 mb-4">
      <h3 className="text-sm font-semibold text-gray-900">Fleet (live containers)</h3>
      {sidecars.map(s => <FleetForSidecar key={s.id} sidecar={s} />)}
      <VirtualContainersPanel
        virtual={virtual}
        slots={slots}
        masterWsPort={data?.masterWsPort}
        lastRerank={data?.lastRerank}
      />
    </div>
  );
}
