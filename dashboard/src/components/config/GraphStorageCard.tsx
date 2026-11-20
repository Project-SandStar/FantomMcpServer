'use client';

/**
 * Storage tab card for the graph database (LadybugDB, one store per project).
 * Server: GET /admin/graph/storage (src/admin/graphSettingsRoutes.ts).
 * Settings live on the Graph tab (#graph).
 */
import { useQuery } from '@tanstack/react-query';
import { graphSettingsApi } from '@/lib/api';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${u[i]}`;
}

export function GraphStorageCard({ onOpenGraphTab }: { onOpenGraphTab?: () => void }) {
  const q = useQuery({ queryKey: ['graph-storage'], queryFn: graphSettingsApi.storage, refetchInterval: 10000, retry: false });
  if (q.isLoading) return <p className="text-gray-500 text-sm">Loading graph database info...</p>;
  if (q.error || !q.data) return <p className="text-red-600 text-sm">Graph database info unavailable: {(q.error as Error)?.message}</p>;
  const g = q.data;
  return (
    <div>
      <h3 className="text-sm font-medium text-gray-900 mb-2">Graph Database (LadybugDB)</h3>
      <div className="bg-white border border-gray-200 rounded-lg px-4 py-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-900">
              {g.engine} <span className="font-mono text-gray-600">{g.package}{g.version ? ` ${g.version}` : ''}</span>
            </p>
            <p className="text-xs text-gray-500 font-mono truncate mt-0.5">{g.stores.path}</p>
          </div>
          <span className="text-sm font-medium text-gray-700 ml-4 flex-shrink-0">{fmtBytes(g.stores.totalBytes)}</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs text-gray-600">
          <div><span className="text-gray-500">Project stores:</span> <b>{g.stores.storeCount.toLocaleString()}</b></div>
          <div><span className="text-gray-500">Open now / cap:</span> <b>{g.pool.open} / {g.pool.cap}</b></div>
          <div><span className="text-gray-500">WAL files:</span> <b>{g.stores.walCount}</b></div>
          <div><span className="text-gray-500">Modified:</span> <b>{g.stores.lastModified ? new Date(g.stores.lastModified).toLocaleString() : 'n/a'}</b></div>
        </div>
        {g.stores.corruptCount > 0 && (
          <p className="text-xs text-amber-700">
            {g.stores.corruptCount} quarantined store file(s) ({fmtBytes(g.stores.corruptBytes)}), not counted above. Delete them by hand when no longer needed.
          </p>
        )}
        {g.shared && (
          <p className="text-xs text-gray-500">
            Legacy shared store: <span className="font-mono">{g.shared.path}</span> ({fmtBytes(g.shared.bytes)})
          </p>
        )}
        <a href="#graph" onClick={(e) => { if (onOpenGraphTab) { e.preventDefault(); onOpenGraphTab(); } }}
          className="inline-block text-xs text-blue-600 hover:underline">
          Graph settings (open-stores cap, buffer pools, threads) →
        </a>
      </div>
    </div>
  );
}
