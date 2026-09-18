'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

const inputClass = "w-24 rounded-md border border-gray-300 py-1.5 px-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

export function MasterWsPortControl() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['master-ws-port'],
    queryFn: () => api.getMasterWsPort(),
    refetchInterval: 5000,
  });
  const [draft, setDraft] = useState<number>(3003);
  useEffect(() => {
    if (data?.configuredPort !== undefined) setDraft(data.configuredPort);
  }, [data?.configuredPort]);

  const mut = useMutation({
    mutationFn: (port: number) => api.setMasterWsPort(port),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['master-ws-port'] }),
  });

  const listener = data?.listener;
  const indicator =
    !listener ? 'gray'
    : listener.error ? 'red'
    : listener.listening ? 'green'
    : 'amber';
  const dot = {
    gray: 'bg-gray-300',
    red: 'bg-red-500',
    amber: 'bg-amber-500',
    green: 'bg-green-500',
  }[indicator];

  return (
    <div className="border border-gray-200 rounded-md p-3 bg-white mb-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Sidecar master WS port</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Sidecars open <code className="bg-gray-100 px-1 rounded">ws://&lt;this-host&gt;:&lt;port&gt;/sidecar</code> to register with Fantom.
            Configure the same port in each sidecar&apos;s master entry as <code className="bg-gray-100 px-1 rounded">wsPort</code>.
            Default <code className="bg-gray-100 px-1 rounded">3003</code> (avoids Sound Suite&apos;s 3002).
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`inline-block w-2 h-2 rounded-full ${dot}`}
            title={listener?.error ?? (listener?.listening ? 'listening' : 'not listening')} />
          <input type="number" min={1} max={65535} className={inputClass}
            value={draft}
            onChange={e => setDraft(parseInt(e.target.value, 10) || 0)} />
          <button
            onClick={() => mut.mutate(draft)}
            disabled={mut.isPending || isLoading || draft === data?.configuredPort}
            className="text-xs px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded"
          >
            {mut.isPending ? 'Saving…' : 'Save & restart'}
          </button>
        </div>
      </div>
      {listener?.error && (
        <p className="mt-2 text-xs text-red-600">Listener error: <span className="font-mono">{listener.error}</span></p>
      )}
      {listener?.listening && listener.port !== undefined && (
        <p className="mt-1 text-xs text-gray-500">
          Listening on <code className="bg-gray-100 px-1 rounded">:{listener.port}/sidecar</code>
          {data?.configuredPort !== listener.port && (
            <span className="ml-2 text-amber-600">(configured {data?.configuredPort} — restart pending)</span>
          )}
        </p>
      )}
    </div>
  );
}
