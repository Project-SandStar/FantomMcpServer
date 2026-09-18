'use client';

/**
 * Axon search inside the MCP Explorer (Language filter = Axon).
 * Left card: query, mode (Vector only / + Reranker / + RLM), source, project.
 * Right card: results list in the Explorer's layout + RLM answer/citations +
 * selected function detail. Talks to POST /admin/axon/search.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, type AxonSearchResult } from '@/lib/api';

type Mode = 'vector' | 'rerank' | 'rlm';
type Source = 'all' | 'proj' | 'library';

function SourceBadge({ source }: { source: 'proj' | 'library' }) {
  return source === 'library'
    ? <span className="px-1.5 py-0.5 text-[10px] rounded font-medium bg-amber-50 text-amber-800 border border-amber-200">library</span>
    : <span className="px-1.5 py-0.5 text-[10px] rounded font-medium bg-teal-50 text-teal-700 border border-teal-200">proj</span>;
}

export function AxonExplorerSearch() {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>('vector');
  const [source, setSource] = useState<Source>('all');
  const [projectId, setProjectId] = useState('');
  const [selected, setSelected] = useState<AxonSearchResult | null>(null);

  const projects = useQuery({ queryKey: ['axon-projects'], queryFn: api.axonProjects });
  const projectOptions = useMemo(() => (projects.data?.projects ?? [])
    .filter(p => source === 'all' || p.source === source)
    .map(p => ({ id: p.projectId, label: `${p.projectId} (${p.vectors}/${p.functionsFound})` })), [projects.data, source]);

  const search = useMutation({
    mutationFn: () => api.axonSearch({ query, projectId: projectId || undefined, source, mode, limit: 30 }),
    onSuccess: () => setSelected(null),
  });
  const data = search.data;
  const canRun = query.trim().length > 0 && !search.isPending;

  const pick = (nodeId: string) => {
    const m = data?.results.find(r => r.nodeId === nodeId);
    if (m) setSelected(m);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Left: controls + list */}
      <div className="space-y-6">
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-1">Axon Search</h2>
          <p className="text-sm text-gray-500 mb-4">Semantic search over embedded Axon functions (synced projects + offline library) via <code className="font-mono text-xs">/admin/axon/search</code>.</p>
          <label className="block text-sm font-medium text-gray-700 mb-1">Query</label>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && canRun) search.mutate(); }}
            placeholder="e.g. ahu simultaneous heating and cooling"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
            <div>
              <label className="block text-xs text-gray-600 mb-1">Mode</label>
              <select value={mode} onChange={e => setMode(e.target.value as Mode)} className="w-full rounded-md border border-gray-300 py-1.5 px-2 text-sm">
                <option value="vector">Vector only</option>
                <option value="rerank">Vector + Reranker</option>
                <option value="rlm">Vector + RLM</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">Source</label>
              <select value={source} onChange={e => { setSource(e.target.value as Source); setProjectId(''); }} className="w-full rounded-md border border-gray-300 py-1.5 px-2 text-sm">
                <option value="all">All sources</option>
                <option value="proj">Synced projects (proj)</option>
                <option value="library">Offline library</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">Project</label>
              <select value={projectId} onChange={e => setProjectId(e.target.value)} className="w-full rounded-md border border-gray-300 py-1.5 px-2 text-sm">
                <option value="">All projects</option>
                {projectOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </div>
          </div>
          <div className="mt-4 flex gap-3">
            <button onClick={() => search.mutate()} disabled={!canRun} className="flex-1 bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
              {search.isPending ? 'Searching…' : 'Search Axon'}
            </button>
            {data && <button onClick={() => { search.reset(); setSelected(null); }} className="px-4 py-2 text-gray-600 bg-gray-100 rounded-md hover:bg-gray-200">Clear</button>}
          </div>
          {search.error && <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md p-3">{search.error instanceof Error ? search.error.message : 'Search failed'}</div>}
          {data?.degraded && (
            <div className="mt-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md p-3">
              {data.degraded === 'empty-table' && <>No Axon vectors yet — run <b>embed all</b> on the Axon page.</>}
              {data.degraded === 'no-reranker' && <>No sidecar advertises <code>reranker</code> — vector-only order shown.</>}
              {data.degraded === 'no-rlm' && <>No sidecar advertises <code>rlm</code> — results shown without a drafted answer.</>}
            </div>
          )}
        </div>

        <div className="bg-white rounded-lg shadow">
          <div className="p-4 border-b border-gray-200">
            <h3 className="font-semibold text-gray-900">Functions</h3>
            <p className="text-xs text-gray-500 mt-1">{data ? `${data.count} results · ${data.mode} · ${data.model}` : 'Run a search'}</p>
          </div>
          <div className="max-h-[520px] overflow-y-auto">
            {data?.results.map(r => (
              <button key={r.nodeId} id={`axon-explorer-${r.nodeId}`} onClick={() => setSelected(r)} className={`w-full text-left p-3 border-b border-gray-100 hover:bg-gray-50 ${selected?.nodeId === r.nodeId ? 'bg-blue-50' : ''}`}>
                <div className="flex items-center gap-2">
                  <SourceBadge source={r.source} />
                  <span className="font-medium text-gray-900 truncate">{r.name}</span>
                  <span className="ml-auto text-xs text-gray-500">{(r.combinedScore * 100).toFixed(0)}%</span>
                </div>
                <p className="text-xs text-gray-600 font-mono truncate mt-0.5">{r.signature}</p>
                <p className="text-xs text-gray-400 truncate">{r.projectId}{r.tags?.length ? ` · ${r.tags.slice(0, 3).join(', ')}` : ''}</p>
              </button>
            ))}
            {data && data.results.length === 0 && <div className="p-6 text-center text-gray-500 text-sm">No matches</div>}
          </div>
        </div>
      </div>

      {/* Right: answer + detail */}
      <div className="space-y-6">
        {mode === 'rlm' && (search.isPending || data?.answer) && (
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-gray-900">Answer</h2>
              {data?.rlm && <span className="text-xs text-gray-500">{data.rlm.rounds} rounds · {data.rlm.toolCalls} tool calls</span>}
            </div>
            {search.isPending ? (
              <div className="text-sm text-gray-500">Thinking…</div>
            ) : (
              <>
                <div className="prose prose-sm max-w-none text-gray-800"><ReactMarkdown remarkPlugins={[remarkGfm]}>{data!.answer!}</ReactMarkdown></div>
                {!!data?.citations?.length && (
                  <div className="mt-4 border-t border-gray-100 pt-3">
                    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Sources</h4>
                    <ol className="space-y-1">
                      {data.citations.map((c, i) => (
                        <li key={`${c.nodeId}-${i}`}>
                          <button onClick={() => pick(c.nodeId)} className="text-left text-xs text-blue-700 hover:underline">
                            <span className="font-medium">{i + 1}. {c.qualifiedName}</span>
                            <span className="text-gray-400"> — {c.filePath}:{c.lineStart}</span>
                          </button>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Function</h2>
          {selected ? (
            <dl className="grid grid-cols-1 gap-3 text-sm">
              <div className="flex items-center gap-2">
                <SourceBadge source={selected.source} />
                <span className="font-mono font-semibold text-gray-900">{selected.qualifiedName}</span>
                <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">embedded ✔</span>
              </div>
              <div><dt className="text-xs text-gray-500">Signature</dt><dd className="font-mono text-gray-800">{selected.signature || '(none)'}</dd></div>
              <div className="grid grid-cols-2 gap-3">
                <div><dt className="text-xs text-gray-500">Project / instance</dt><dd className="text-gray-800">{selected.project} / {selected.instance}</dd></div>
                <div><dt className="text-xs text-gray-500">Score</dt><dd className="text-gray-800">{(selected.combinedScore * 100).toFixed(1)}%{selected.rerankScore !== undefined ? ` (rerank ${selected.rerankScore.toFixed(2)})` : ''}</dd></div>
              </div>
              {selected.returnType && <div><dt className="text-xs text-gray-500">Returns</dt><dd className="font-mono text-gray-800">{selected.returnType}</dd></div>}
              {!!selected.tags?.length && <div><dt className="text-xs text-gray-500">Tags</dt><dd className="font-mono text-gray-800">{selected.tags.join(', ')}</dd></div>}
              {selected.documentation && <div><dt className="text-xs text-gray-500">Doc</dt><dd className="text-gray-800 whitespace-pre-wrap">{selected.documentation}</dd></div>}
              <div><dt className="text-xs text-gray-500">File</dt><dd className="font-mono text-xs text-gray-700 break-all">{selected.filePath}:{selected.lineStart}-{selected.lineEnd}</dd></div>
            </dl>
          ) : (
            <p className="text-sm text-gray-500">Select a result to see its signature, doc, tags and location.</p>
          )}
        </div>
      </div>
    </div>
  );
}
