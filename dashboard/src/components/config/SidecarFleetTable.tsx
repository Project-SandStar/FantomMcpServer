'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  api, Sidecar, SidecarContainerInfo, LoadedModelInfo,
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

/** Which path served the last rerank. Cloud calls go from Fantom to OpenRouter directly. */
function LastRerankLine({
  lastRerank,
}: {
  lastRerank: { path: string; servedBy: string; model: string; at: string; ms: number };
}) {
  return (
    <div className="px-3 py-2 text-xs border border-gray-200 rounded-md bg-gray-50 text-gray-700">
      Last rerank served by <span className="font-medium">{lastRerank.servedBy}</span>{' '}
      <span className={lastRerank.path === 'local' ? 'text-green-700' : 'text-violet-700'}>({lastRerank.path})</span>{' '}
      · {lastRerank.model} · {lastRerank.ms}ms
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
  if (sidecars.length === 0 && !data?.lastRerank) return null;

  return (
    <div className="space-y-3 mb-4">
      <h3 className="text-sm font-semibold text-gray-900">Fleet (live containers)</h3>
      {sidecars.map(s => <FleetForSidecar key={s.id} sidecar={s} />)}
      {data?.lastRerank && <LastRerankLine lastRerank={data.lastRerank} />}
    </div>
  );
}
