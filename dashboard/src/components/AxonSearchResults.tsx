'use client';

/**
 * Axon results for the Vector Viewer: scatter + list + optional RLM answer.
 * Mirrors the Fantom panels' layout so switching source feels the same.
 */

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AxonSearchResponse, AxonSearchResult } from '@/lib/api';

const VectorScatter = dynamic(() => import('@/components/VectorScatter').then(m => m.VectorScatter), { ssr: false });

interface Props {
  data?: AxonSearchResponse;
  isPending: boolean;
  error?: unknown;
  mode: 'vector' | 'rerank' | 'rlm';
}

export function AxonSearchResults({ data, isPending, error, mode }: Props) {
  const [selected, setSelected] = useState<AxonSearchResult | null>(null);

  const points = useMemo(() => (data?.results ?? []).map(r => ({
    id: r.nodeId,
    name: r.name,
    qualifiedName: r.qualifiedName,
    nodeType: r.nodeType,
    filePath: r.filePath,
    lineStart: r.lineStart,
    x: Math.cos((1 - r.combinedScore) * Math.PI) * (1 - r.combinedScore) + Math.random() * 0.1,
    y: Math.sin((1 - r.combinedScore) * Math.PI) * r.combinedScore + Math.random() * 0.1,
    score: r.combinedScore,
  })), [data]);

  const select = (nodeId: string) => {
    const m = data?.results.find(r => r.nodeId === nodeId);
    if (m) {
      setSelected(m);
      if (typeof document !== 'undefined') document.getElementById(`axon-result-${nodeId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  return (
    <div className="space-y-6">
      {error ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">{error instanceof Error ? error.message : 'Axon search failed'}</div>
      ) : null}

      {data?.degraded && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
          {data.degraded === 'empty-table' && <>No Axon vectors yet — run <b>Embed all</b> on the Axon page.</>}
          {data.degraded === 'no-reranker' && <>No sidecar advertises <code>reranker</code> — showing vector-only order.</>}
          {data.degraded === 'no-rlm' && <>No sidecar advertises <code>rlm</code> — showing results without a drafted answer.</>}
        </div>
      )}

      {mode === 'rlm' && (isPending || data?.answer) && (
        <div className="bg-white rounded-lg shadow border border-purple-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between bg-purple-50">
            <h3 className="font-semibold text-gray-900">Answer (Axon)</h3>
            {data?.rlm && <span className="text-xs text-gray-500">{data.rlm.rounds} rounds · {data.rlm.toolCalls} tool calls</span>}
          </div>
          <div className="p-4">
            {isPending ? (
              <div className="flex items-center gap-2 text-gray-500 text-sm"><span className="inline-block h-3 w-3 rounded-full bg-purple-400 animate-pulse" />Thinking…</div>
            ) : data?.answer ? (
              <>
                <div className="prose prose-sm max-w-none text-gray-800"><ReactMarkdown remarkPlugins={[remarkGfm]}>{data.answer}</ReactMarkdown></div>
                {!!data.citations?.length && (
                  <div className="mt-4 border-t border-gray-100 pt-3">
                    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Sources</h4>
                    <ol className="space-y-1">
                      {data.citations.map((c, i) => (
                        <li key={`${c.nodeId}-${i}`}>
                          <button onClick={() => select(c.nodeId)} className="text-left text-xs text-purple-700 hover:underline">
                            <span className="font-medium">{i + 1}. {c.qualifiedName}</span>
                            <span className="text-gray-400"> — {c.filePath}:{c.lineStart}</span>
                          </button>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </>
            ) : null}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white rounded-lg shadow overflow-hidden">
          {isPending ? (
            <div className="flex items-center justify-center h-96 bg-gray-50"><div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600" /></div>
          ) : (
            <VectorScatter data={points} highlightIds={selected ? new Set([selected.nodeId]) : undefined} onPointClick={(p) => select(p.id)} height={500} colorBy="score" sizeBy="score" />
          )}
        </div>
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="p-4 border-b border-gray-200">
            <h3 className="font-semibold text-gray-900">Axon Results</h3>
            <p className="text-xs text-gray-500 mt-1">{data ? `${data.count} results · ${data.mode} · ${data.model}` : 'Enter a query to search'}</p>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {data?.results.map(r => (
              <button
                key={r.nodeId}
                id={`axon-result-${r.nodeId}`}
                onClick={() => setSelected(r)}
                className={`w-full text-left p-3 border-b border-gray-100 hover:bg-gray-50 transition-colors ${selected?.nodeId === r.nodeId ? 'bg-purple-50' : ''}`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className={`px-1.5 py-0.5 text-xs rounded font-medium ${r.source === 'library' ? 'bg-amber-50 text-amber-800' : 'bg-teal-50 text-teal-700'}`}>{r.source === 'library' ? 'library' : 'proj'}</span>
                  <span className="font-medium text-gray-900 truncate">{r.name}</span>
                  <span className="ml-auto text-xs text-gray-400">{r.projectId}</span>
                </div>
                <p className="text-xs text-gray-600 font-mono truncate">{r.signature}</p>
                <div className="flex items-center gap-3 mt-2">
                  <span className="text-xs text-gray-400">Score:</span>
                  <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden"><div className="h-full bg-gradient-to-r from-yellow-400 to-green-500 rounded-full" style={{ width: `${r.combinedScore * 100}%` }} /></div>
                  <span className="text-xs text-gray-600">{(r.combinedScore * 100).toFixed(0)}%</span>
                  {r.rerankScore !== undefined && <span className="text-[10px] text-gray-400">rr {r.rerankScore.toFixed(2)}</span>}
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {selected && (
        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h3 className="font-semibold text-gray-900 font-mono">{selected.qualifiedName}</h3>
              <p className="text-xs text-gray-500 font-mono mt-1">{selected.filePath}:{selected.lineStart}-{selected.lineEnd}</p>
            </div>
            <button onClick={() => setSelected(null)} className="text-gray-400 hover:text-gray-600 text-sm">close</button>
          </div>
          <dl className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <div><dt className="text-xs text-gray-500">Signature</dt><dd className="font-mono text-gray-800">{selected.signature}</dd></div>
            {selected.returnType && <div><dt className="text-xs text-gray-500">Returns</dt><dd className="font-mono text-gray-800">{selected.returnType}</dd></div>}
            {!!selected.tags?.length && <div><dt className="text-xs text-gray-500">Tags</dt><dd className="font-mono text-gray-800">{selected.tags.join(', ')}</dd></div>}
            {selected.documentation && <div className="md:col-span-2"><dt className="text-xs text-gray-500">Doc</dt><dd className="text-gray-800 whitespace-pre-wrap">{selected.documentation}</dd></div>}
          </dl>
        </div>
      )}
    </div>
  );
}
