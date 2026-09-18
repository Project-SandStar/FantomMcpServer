'use client';

/** Compact Axon integration status for the dashboard home page. */

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function AxonStatusCard() {
  const { data, error } = useQuery({ queryKey: ['axon-status'], queryFn: api.axonStatus, refetchInterval: 10000, retry: 1 });
  if (error || !data) return null;
  const { mcp, totals, embedding, table, activeJob } = data;
  const state = mcp.connected ? 'connected' : mcp.connecting ? 'connecting' : mcp.enabled ? 'disconnected' : 'disabled';
  const stateColor = mcp.connected ? 'bg-emerald-500' : mcp.enabled ? 'bg-red-500' : 'bg-gray-400';
  return (
    <div className="mt-8 bg-[#10161d] border border-[#1f2a36] rounded-lg p-5 text-[#d7e0ea]">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="font-mono text-sm text-[#5ee1a2]">$ axon --status</h2>
        <Link href="/axon" className="font-mono text-xs border border-[#2a3846] px-2 py-1 hover:border-[#5ee1a2] hover:text-[#5ee1a2]">open →</Link>
      </div>
      <div className="mt-3 grid grid-cols-2 md:grid-cols-5 gap-4 font-mono text-xs">
        <div>
          <div className="text-[#7f93a8]">mcp</div>
          <div className="flex items-center gap-2 mt-1"><span className={`inline-block h-2 w-2 rounded-full ${stateColor}`} />{state}</div>
        </div>
        <div><div className="text-[#7f93a8]">tools</div><div className="mt-1">{mcp.toolCount}</div></div>
        <div><div className="text-[#7f93a8]">projects / functions</div><div className="mt-1">{totals.projects} / {totals.functions}</div></div>
        <div><div className="text-[#7f93a8]">embedded</div><div className={`mt-1 ${totals.embeddedPercent >= 100 ? 'text-[#5ee1a2]' : ''}`}>{totals.embeddedPercent}% <span className="text-[#7f93a8]">({totals.vectors})</span></div></div>
        <div><div className="text-[#7f93a8]">model</div><div className="mt-1 truncate" title={`${embedding.model} @ ${embedding.dimensions}d`}>{embedding.model} <span className="text-[#7f93a8]">@{embedding.dimensions}d</span></div></div>
      </div>
      {(table.dimsMismatch && table.rows > 0) && (
        <div className="mt-3 font-mono text-xs text-[#ffcc66]">⚠ axon_vectors dims ({table.tableDimensions}d) ≠ code model ({table.configuredDimensions}d) — re-index required</div>
      )}
      {activeJob && (
        <div className="mt-3 font-mono text-xs text-[#7f93a8]">● job {activeJob.id} {activeJob.status} · {activeJob.projectsDone}/{activeJob.projectsTotal} projects · {activeJob.functionsEmbedded}/{activeJob.functionsTotal} fns</div>
      )}
      {mcp.lastError && !mcp.connected && (
        <div className="mt-3 font-mono text-xs text-[#ff6b6b] truncate" title={mcp.lastError}>{mcp.lastError}</div>
      )}
    </div>
  );
}
