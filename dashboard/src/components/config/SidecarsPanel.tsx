'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, Sidecar, SidecarCapabilityKind, SidecarCapabilityState } from '@/lib/api';
import { SidecarFleetTable } from './SidecarFleetTable';
import { MasterWsPortControl } from './MasterWsPortControl';

const inputClass = "w-full rounded-md border border-gray-300 py-2 px-3 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";
const labelClass = "block text-xs font-medium text-gray-600 mb-1";

const KINDS: SidecarCapabilityKind[] = ['embedding', 'embedding-code', 'llm', 'reranker', 'ocr', 'rlm'];

type Draft = {
  name: string;
  host: string;
  port: number;
  protocol: 'http' | 'https';
  authToken: string;
  enabled: boolean;
};

const EMPTY: Draft = {
  name: '',
  host: '',
  port: 8098,
  protocol: 'http',
  authToken: '',
  enabled: true,
};

function sidecarToDraft(s: Sidecar): Draft {
  return {
    name: s.name,
    host: s.host,
    port: s.port,
    protocol: s.protocol,
    authToken: s.authToken ?? '',
    enabled: s.enabled,
  };
}

function CapabilityBadge({ kind, cap }: { kind: SidecarCapabilityKind; cap?: SidecarCapabilityState }) {
  if (!cap?.available) return null;
  const loaded = cap.loaded ? ` · ${cap.loaded}` : '';
  return (
    <span className="text-[10px] font-mono px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded">
      {kind}({cap.models?.length ?? 0}){loaded}
    </span>
  );
}

function sourceColor(src?: string): string {
  if (src === 'ws-register' || src === 'ws-heartbeat') return 'bg-green-100 text-green-800';
  if (src === 'http-ping') return 'bg-blue-100 text-blue-800';
  return 'bg-gray-100 text-gray-700';
}

function CapabilityDetail({ kind, cap }: { kind: SidecarCapabilityKind; cap: SidecarCapabilityState }) {
  return (
    <div className="text-xs bg-gray-50 rounded px-2 py-1.5 space-y-0.5">
      <div className="font-mono text-gray-700"><span className="font-semibold">{kind}</span></div>
      <div className="text-gray-600">
        models: <span className="font-mono">{cap.models?.length ? cap.models.join(', ') : '—'}</span>
      </div>
      {cap.loaded !== undefined && (
        <div className="text-gray-600">loaded: <span className="font-mono text-blue-700">{cap.loaded ?? 'none'}</span></div>
      )}
      {cap.gpuPercent !== undefined && (
        <div className="text-gray-600">gpu%: <span className="font-mono">{cap.gpuPercent}</span></div>
      )}
      {cap.endpoint && (
        <div className="text-gray-600">endpoint: <span className="font-mono">{cap.endpoint}</span></div>
      )}
    </div>
  );
}

function LiveCapabilitySummary({ sidecars }: { sidecars: Sidecar[] }) {
  const enabled = sidecars.filter(s => s.enabled);
  const wsCount = enabled.filter(s => s.wsConnected).length;
  return (
    <div className="border border-gray-200 rounded-md p-3 bg-gray-50/50 mb-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-gray-900">Live capabilities (WS)</h3>
        <span className="text-xs text-gray-500">
          {wsCount}/{enabled.length} sidecar{enabled.length === 1 ? '' : 's'} connected
        </span>
      </div>
      {wsCount === 0 && (
        <p className="text-xs text-gray-500 italic">
          No sidecar has connected to <code className="bg-gray-100 px-1 rounded">ws://&lt;this-host&gt;:3848/ws/sidecars</code>.
          Capabilities below come from manual config or HTTP <code className="bg-gray-100 px-1 rounded">/health</code> probing.
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        {(['embedding','embedding-code','reranker','llm','ocr','rlm'] as SidecarCapabilityKind[]).map(kind => {
          const offering = enabled.filter(s => s.capabilities?.[kind]?.available);
          if (offering.length === 0) return (
            <div key={kind} className="text-xs text-gray-400 italic px-2 py-1">{kind}: none</div>
          );
          return (
            <div key={kind} className="text-xs space-y-1">
              <div className="font-semibold text-gray-700 capitalize">{kind}</div>
              {offering.map(s => {
                const cap = s.capabilities[kind]!;
                return (
                  <div key={s.id} className="bg-white border border-gray-200 rounded px-2 py-1">
                    <div className="flex items-center gap-2">
                      <span className={`inline-block w-1.5 h-1.5 rounded-full ${
                        s.wsConnected ? 'bg-green-500' : s.healthStatus === 'healthy' ? 'bg-blue-500' : 'bg-gray-300'
                      }`} />
                      <span className="font-medium">{s.name}</span>
                      <span className={`text-[10px] px-1 rounded ${sourceColor(s.capabilitiesSource)}`}>
                        {s.capabilitiesSource ?? 'unknown'}
                      </span>
                    </div>
                    <div className="text-gray-600 font-mono pl-3.5">
                      {cap.models?.length ? cap.models.join(', ') : '—'}
                      {cap.loaded ? <span className="text-blue-700"> · loaded {cap.loaded}</span> : ''}
                      {cap.gpuPercent !== undefined ? <span className="text-gray-500"> · gpu {cap.gpuPercent}%</span> : ''}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function SidecarsPanel() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['sidecars'],
    queryFn: () => api.listSidecars(),
    refetchInterval: 5000,
  });

  const createMut = useMutation({
    // Capabilities are not part of the manual form — sidecars announce them via the WS register / heartbeat frames.
    mutationFn: (d: Draft) =>
      api.createSidecar({
        name: d.name,
        host: d.host,
        port: d.port,
        protocol: d.protocol,
        authToken: d.authToken || undefined,
        enabled: d.enabled,
        capabilities: {},
      }),
    onSuccess: () => {
      setDraft(EMPTY);
      qc.invalidateQueries({ queryKey: ['sidecars'] });
    },
  });

  const updateMut = useMutation({
    // Don't touch capabilities here — the live heartbeat owns them.
    mutationFn: ({ id, d }: { id: string; d: Draft }) =>
      api.updateSidecar(id, {
        name: d.name,
        host: d.host,
        port: d.port,
        protocol: d.protocol,
        authToken: d.authToken || undefined,
        enabled: d.enabled,
      }),
    onSuccess: () => {
      setEditingId(null);
      setDraft(EMPTY);
      qc.invalidateQueries({ queryKey: ['sidecars'] });
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteSidecar(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sidecars'] }),
  });

  const pingMut = useMutation({
    mutationFn: (id: string) => api.pingSidecar(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sidecars'] }),
  });
  const clearFaultMut = useMutation({
    mutationFn: (id: string) => api.clearSidecarEmbedFault(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sidecars'] }),
  });

  const startEdit = (s: Sidecar) => {
    setEditingId(s.id);
    setDraft(sidecarToDraft(s));
  };

  const submit = () => {
    if (!draft.name || !draft.host || !draft.port) return;
    if (editingId) updateMut.mutate({ id: editingId, d: draft });
    else createMut.mutate(draft);
  };

  return (
    <div className="space-y-5">
      <MasterWsPortControl />
      <SidecarFleetTable />
      <div>
        <h3 className="text-sm font-semibold text-gray-900 mb-2">
          Registered Sidecars {data ? `(${data.total})` : ''}
        </h3>
        {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
        {data && data.sidecars.length === 0 && (
          <p className="text-sm text-gray-500 italic">No sidecars registered. Add one below.</p>
        )}
        {data && data.sidecars.length > 0 && <LiveCapabilitySummary sidecars={data.sidecars} />}
        <div className="space-y-2">
          {data?.sidecars.map(s => (
            <div key={s.id} className="border border-gray-200 rounded-md p-3 text-sm">
              <div className="flex items-center gap-3">
                <span className={`inline-block w-2 h-2 rounded-full ${
                  s.healthStatus === 'healthy' ? 'bg-green-500'
                  : s.healthStatus === 'unhealthy' ? 'bg-red-500'
                  : 'bg-gray-300'
                }`} title={s.healthStatus ?? 'unknown'} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-gray-900 truncate">{s.name}</span>
                    {!s.enabled && <span className="text-xs text-gray-400">disabled</span>}
                    {s.wsConnected
                      ? <span className="text-[10px] font-medium px-1.5 py-0.5 bg-green-100 text-green-800 rounded">WS live</span>
                      : <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded">no WS</span>}
                    {s.embedFault && (
                      <span
                        className="text-[10px] font-medium px-1.5 py-0.5 bg-red-100 text-red-800 rounded"
                        title={`${s.embedFault.kind} / ${s.embedFault.model}: ${s.embedFault.reason}`}
                      >
                        {s.embedFault.code === 'embeddings-unsupported' ? 'embeddings refused' : s.embedFault.code} ×{s.embedFault.occurrences}
                      </span>
                    )}
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${sourceColor(s.capabilitiesSource)}`}>
                      {s.capabilitiesSource ?? 'unknown'}
                    </span>
                    {KINDS.map(k => (
                      <CapabilityBadge key={k} kind={k} cap={s.capabilities?.[k]} />
                    ))}
                  </div>
                  <div className="text-xs text-gray-500 font-mono truncate">
                    {s.protocol}://{s.host}:{s.port}
                    {s.responseTimeMs !== undefined ? ` · ${s.responseTimeMs}ms` : ''}
                    {s.activeRequests !== undefined ? ` · ${s.activeRequests} active` : ''}
                    {s.lastSeen ? ` · seen ${new Date(s.lastSeen).toLocaleTimeString()}` : ''}
                  </div>
                  {s.embedFault && (
                    <div className="mt-1 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-800">
                      <div className="font-medium">
                        {s.embedFault.kind} refused for <span className="font-mono">{s.embedFault.model}</span>
                        <span className="text-red-600"> — {s.embedFault.reason}</span>
                      </div>
                      <div className="mt-0.5 text-red-700">{s.embedFault.remedy}</div>
                      <div className="mt-0.5 text-red-600">
                        Skipped for embeddings until {new Date(s.embedFault.expiresAt).toLocaleTimeString()} ·{' '}
                        <button onClick={() => clearFaultMut.mutate(s.id)} disabled={clearFaultMut.isPending} className="underline">
                          probe again now
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <button onClick={() => pingMut.mutate(s.id)} disabled={pingMut.isPending}
                  className="text-xs px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded">Ping</button>
                <button onClick={() => startEdit(s)}
                  className="text-xs px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded">Edit</button>
                <button onClick={() => { if (confirm(`Delete "${s.name}"?`)) deleteMut.mutate(s.id); }}
                  className="text-xs px-2 py-1 bg-red-50 hover:bg-red-100 text-red-700 rounded">Delete</button>
              </div>
              {(() => {
                const present = KINDS.filter(k => s.capabilities?.[k]?.available);
                if (present.length === 0) return null;
                return (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {present.map(k => (
                      <CapabilityDetail key={k} kind={k} cap={s.capabilities[k]!} />
                    ))}
                  </div>
                );
              })()}
            </div>
          ))}
        </div>
      </div>

      <div className="border-t border-gray-200 pt-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">
          {editingId ? 'Edit Sidecar' : 'Add Sidecar'}
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClass}>Name</label>
            <input className={inputClass} value={draft.name}
              onChange={e => setDraft({ ...draft, name: e.target.value })}
              placeholder="gpu-01" />
          </div>
          <div>
            <label className={labelClass}>Host / IP</label>
            <input className={inputClass} value={draft.host}
              onChange={e => setDraft({ ...draft, host: e.target.value })}
              placeholder="10.0.0.5 or sidecar.local" />
          </div>
          <div>
            <label className={labelClass}>Port</label>
            <input type="number" className={inputClass} value={draft.port}
              onChange={e => setDraft({ ...draft, port: parseInt(e.target.value, 10) || 0 })} />
          </div>
          <div>
            <label className={labelClass}>Protocol</label>
            <select className={inputClass} value={draft.protocol}
              onChange={e => setDraft({ ...draft, protocol: e.target.value as 'http' | 'https' })}>
              <option value="http">http</option>
              <option value="https">https</option>
            </select>
          </div>
          <div className="col-span-2">
            <label className={labelClass}>Auth token (optional, Bearer)</label>
            <input className={inputClass} value={draft.authToken}
              onChange={e => setDraft({ ...draft, authToken: e.target.value })} />
          </div>
          <div className="col-span-2 flex items-center gap-2">
            <input type="checkbox" checked={draft.enabled}
              onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />
            <span className="text-sm text-gray-700">Enabled</span>
          </div>
        </div>

        <p className="mt-3 text-xs text-gray-500 italic">
          Capabilities (embedding / llm / reranker / ocr) are discovered automatically from the sidecar&apos;s
          WS heartbeat — no manual entry needed.
        </p>

        <div className="mt-4 flex gap-2">
          <button onClick={submit}
            disabled={createMut.isPending || updateMut.isPending}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 text-sm font-medium">
            {editingId ? 'Save changes' : 'Add sidecar'}
          </button>
          {editingId && (
            <button onClick={() => { setEditingId(null); setDraft(EMPTY); }}
              className="px-4 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 text-sm">Cancel</button>
          )}
        </div>
      </div>
    </div>
  );
}
