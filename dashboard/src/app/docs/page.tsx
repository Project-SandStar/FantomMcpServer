'use client';

import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, FantomInstance, LocalDocItem, DocPodInfo, DocStatus, EmbedJobProgress, ModelStatusResponse } from '@/lib/api';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';

export default function DocsExplorerPage() {
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDoc, setSelectedDoc] = useState<LocalDocItem | null>(null);
  const [selectedInstanceId, setSelectedInstanceId] = useState<number | 'all'>('all');
  const [filterPod, setFilterPod] = useState<string>('');
  const [filterType, setFilterType] = useState<string>('');
  const [filterLanguage, setFilterLanguage] = useState<string>('');
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<LocalDocItem[]>([]);
  const [searchMeta, setSearchMeta] = useState<{ searchMethod?: string; keywordMatches?: number; vectorMatches?: number; vectorsAvailable?: number } | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const debouncedQuery = useDebouncedValue(searchQuery, 300);

  // Fetch all instances
  const { data: instancesData, isLoading: instancesLoading } = useQuery({
    queryKey: ['instances'],
    queryFn: api.getInstances,
  });

  const instances = instancesData?.instances || [];

  // Get first instance with cache as default
  const { data: firstInstanceStatus } = useQuery({
    queryKey: ['doc-status-first'],
    queryFn: async () => {
      if (instances.length === 0) return null;
      // Check each instance for cached docs
      for (const inst of instances) {
        try {
          const status = await api.getInstanceDocStatus(inst.id);
          if (status.hasCache) return inst.id;
        } catch {
          continue;
        }
      }
      return instances[0]?.id || null;
    },
    enabled: instances.length > 0 && selectedInstanceId === 'all',
  });

  // Auto-select first instance with cache
  useEffect(() => {
    if (firstInstanceStatus && selectedInstanceId === 'all') {
      setSelectedInstanceId(firstInstanceStatus);
    }
  }, [firstInstanceStatus, selectedInstanceId]);

  // Get selected instance
  const selectedInstance = useMemo(() => {
    if (selectedInstanceId === 'all') return null;
    return instances.find(i => i.id === selectedInstanceId) || null;
  }, [instances, selectedInstanceId]);

  // Fetch doc pods for selected instance
  const { data: docPodsData } = useQuery({
    queryKey: ['doc-pods', selectedInstanceId],
    queryFn: () => selectedInstanceId !== 'all' ? api.getInstanceDocPods(selectedInstanceId) : null,
    enabled: selectedInstanceId !== 'all',
  });

  const pods = docPodsData?.pods || [];

  // Fetch vector stats
  const { data: vectorStats } = useQuery({
    queryKey: ['vector-stats'],
    queryFn: api.getVectorStats,
  });

  // Fetch doc status for selected instance
  const { data: docStatus, isLoading: docStatusLoading } = useQuery({
    queryKey: ['doc-status', selectedInstanceId],
    queryFn: () => selectedInstanceId !== 'all' ? api.getInstanceDocStatus(selectedInstanceId) : null,
    enabled: selectedInstanceId !== 'all',
  });

  // Embed docs mutation
  const [isEmbedding, setIsEmbedding] = useState(false);
  const [embedResult, setEmbedResult] = useState<{ embedded: number; duration: number } | null>(null);
  const [embedJobId, setEmbedJobId] = useState<string | null>(null);

  const embedDocsMutation = useMutation({
    mutationFn: (instanceId: number) => api.embedInstanceDocs(instanceId, false),
    onSuccess: (data) => {
      setEmbedResult({ embedded: data.embedded, duration: data.duration });
      setIsEmbedding(false);
      queryClient.invalidateQueries({ queryKey: ['vector-stats'] });
    },
    onError: () => {
      setIsEmbedding(false);
    },
  });

  // Index docs mutation — also triggers embedding after success
  const indexDocsMutation = useMutation({
    mutationFn: (instanceId: number) => api.indexInstanceDocs(instanceId, undefined, true),
    onSuccess: (_data, instanceId) => {
      queryClient.invalidateQueries({ queryKey: ['doc-status', selectedInstanceId] });
      queryClient.invalidateQueries({ queryKey: ['doc-pods', selectedInstanceId] });
      // Auto-embed vectors after reindex
      setIsEmbedding(true);
      setEmbedResult(null);
      embedDocsMutation.mutate(instanceId);
    },
  });

  // Clear cache mutation
  const clearCacheMutation = useMutation({
    mutationFn: (instanceId: number) => api.clearInstanceDocCache(instanceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['doc-status', selectedInstanceId] });
      queryClient.invalidateQueries({ queryKey: ['doc-pods', selectedInstanceId] });
      setSearchResults([]);
    },
  });

  // Embed all docs mutation (background job)
  const embedAllDocsMutation = useMutation({
    mutationFn: () => api.embedAllDocs(false),
    onSuccess: (data) => {
      setEmbedJobId(data.jobId);
      setIsEmbedding(true);
    },
    onError: () => {
      setIsEmbedding(false);
    },
  });

  // Poll embed job progress
  const { data: embedJobProgress } = useQuery({
    queryKey: ['embed-job', embedJobId],
    queryFn: () => embedJobId ? api.getEmbedJobStatus(embedJobId) : null,
    enabled: !!embedJobId && isEmbedding,
    refetchInterval: 2000,
  });

  // Check for active job on mount AND keep polling so jobs kicked off
  // outside this tab (e.g. from /admin/docs/embed-all on another tab,
  // or the boot-time auto-embed pipeline) surface here too.
  const { data: activeEmbedJob } = useQuery({
    queryKey: ['active-docs-embed-job'],
    queryFn: () => api.getActiveEmbedJob(),
    refetchInterval: 2000,
  });
  useEffect(() => {
    if (activeEmbedJob && 'jobId' in activeEmbedJob && activeEmbedJob.status === 'running') {
      setEmbedJobId(activeEmbedJob.jobId);
      setIsEmbedding(true);
    }
  }, [activeEmbedJob]);

  // Vector model status — surfaces the docs embedding model + stored row
  // count + mismatch warning. Refreshes every 5s so the panel reflects
  // model changes saved on the config page.
  const { data: modelStatus } = useQuery({
    queryKey: ['docs-model-status'],
    queryFn: () => api.getModelStatus(),
    refetchInterval: 5000,
  });

  // Handle job completion
  useEffect(() => {
    if (embedJobProgress && embedJobProgress.status !== 'none') {
      const progress = embedJobProgress as EmbedJobProgress;
      if (progress.status === 'completed' || progress.status === 'error') {
        setIsEmbedding(false);
        queryClient.invalidateQueries({ queryKey: ['vector-stats'] });
        if (progress.status === 'completed' && progress.completedAt && progress.startedAt) {
          setEmbedResult({
            embedded: progress.totalEmbedded,
            duration: progress.completedAt - progress.startedAt,
          });
        }
      }
    }
  }, [embedJobProgress, queryClient]);

  // Clear embeddings mutation
  const clearEmbeddingsMutation = useMutation({
    mutationFn: () => api.clearDocEmbeddings(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vector-stats'] });
    },
  });

  // Index all docs mutation — also triggers embedding after success
  const indexAllDocsMutation = useMutation({
    mutationFn: api.indexAllDocs,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['doc-status'] });
      queryClient.invalidateQueries({ queryKey: ['doc-pods'] });
      queryClient.invalidateQueries({ queryKey: ['doc-status-first'] });
      // Auto-embed vectors after index all
      embedAllDocsMutation.mutate();
    },
  });

  // Perform search when query changes or filters are applied
  useEffect(() => {
    const performSearch = async () => {
      if (selectedInstanceId === 'all') {
        if (debouncedQuery.length >= 2) {
          setSearchError('Please select an instance to search');
        } else {
          setSearchError(null);
        }
        setSearchResults([]);
        return;
      }

      // If no query but filter is selected, use a wildcard search (empty query returns all)
      const hasActiveFilter = filterPod || filterType || filterLanguage;
      const searchQuery = debouncedQuery.length >= 2 ? debouncedQuery : (hasActiveFilter ? '*' : '');

      if (!searchQuery) {
        setSearchResults([]);
        setSearchError(null);
        return;
      }

      setIsSearching(true);
      setSearchError(null);

      try {
        const result = await api.searchInstanceDocs(selectedInstanceId, searchQuery, {
          pod: filterPod || undefined,
          type: filterType || undefined,
          language: filterLanguage as 'fantom' | 'axon' | undefined,
          limit: 100,
        });
        setSearchResults(result.results);
        setSearchMeta({
          searchMethod: result.searchMethod,
          keywordMatches: result.keywordMatches,
          vectorMatches: result.vectorMatches,
          vectorsAvailable: result.vectorsAvailable,
        });
      } catch (error) {
        setSearchError(error instanceof Error ? error.message : 'Search failed');
        setSearchResults([]);
        setSearchMeta(null);
      } finally {
        setIsSearching(false);
      }
    };

    performSearch();
  }, [debouncedQuery, selectedInstanceId, filterPod, filterType, filterLanguage]);

  // Get type badge color
  const getTypeBadgeColor = (type: string): string => {
    switch (type) {
      case 'type':
        return 'bg-blue-100 text-blue-800';
      case 'function':
        return 'bg-purple-100 text-purple-800';
      case 'slot':
        return 'bg-green-100 text-green-800';
      case 'chapter':
        return 'bg-orange-100 text-orange-800';
      case 'tag':
        return 'bg-yellow-100 text-yellow-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  // Get retrieval source badge
  const getRetrievalBadge = (source: string): { color: string; label: string } => {
    switch (source) {
      case 'keyword':
        return { color: 'bg-amber-100 text-amber-800', label: 'KW' };
      case 'vector':
        return { color: 'bg-indigo-100 text-indigo-800', label: 'VEC' };
      case 'both':
        return { color: 'bg-emerald-100 text-emerald-800', label: 'KW+VEC' };
      default:
        return { color: 'bg-gray-100 text-gray-800', label: source };
    }
  };

  // Get language badge color
  const getLanguageBadgeColor = (language: string): string => {
    switch (language) {
      case 'axon':
        return 'bg-purple-100 text-purple-800';
      case 'fantom':
        return 'bg-blue-100 text-blue-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Docs Explorer</h1>
          <p className="text-gray-600 mt-1">
            Search and browse Fantom/SkySpark/Haxall documentation from your local instances
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => indexAllDocsMutation.mutate()}
            disabled={indexAllDocsMutation.isPending || instances.length === 0}
            className="px-4 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {indexAllDocsMutation.isPending ? (
              <>
                <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Indexing All...
              </>
            ) : (
              <>
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
                Index All Docs
              </>
            )}
          </button>
          <button
          onClick={() => {
            setEmbedResult(null);
            embedAllDocsMutation.mutate();
          }}
          disabled={embedAllDocsMutation.isPending || isEmbedding || instances.length === 0}
          className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {isEmbedding || embedAllDocsMutation.isPending ? (
            <>
              <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Embedding...
            </>
          ) : (
            <>
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
              Embed All Vectors
            </>
          )}
        </button>
          <button
            onClick={async () => {
              if (
                !confirm(
                  'Drop the docs_vectors table and re-embed ALL cached docs with the currently configured embedding model? This is needed when the configured model dimensions differ from what was previously stored (e.g. switching from jina 768d to qwen3 1024d). Will run in the background.',
                )
              )
                return;
              try {
                setEmbedResult(null);
                const r = await api.reEmbedDocsWithCurrentModel();
                setIsEmbedding(true);
                setEmbedJobId(r.jobId);
              } catch (e) {
                alert('Re-embed failed: ' + (e instanceof Error ? e.message : String(e)));
              }
            }}
            disabled={isEmbedding || embedAllDocsMutation.isPending || clearEmbeddingsMutation.isPending}
            className="px-3 py-2 text-sm font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 rounded-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            title="Drop docs_vectors table and re-embed all cached docs with the currently configured model"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Re-embed with current model
          </button>
          <button
            onClick={() => {
              if (confirm('Delete all doc embedding vectors? You can re-embed after.')) {
                clearEmbeddingsMutation.mutate();
              }
            }}
            disabled={clearEmbeddingsMutation.isPending || isEmbedding}
            className="px-3 py-2 text-sm font-medium text-red-700 bg-red-50 hover:bg-red-100 rounded-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            title="Clear all doc embedding vectors"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>

      {/* Docs vector model + live embed status */}
      <DocsEmbedStatusPanel
        modelStatus={modelStatus}
        progress={embedJobProgress as EmbedJobProgress | undefined}
        activeJob={activeEmbedJob}
      />

      {/* Index All Docs Result */}
      {indexAllDocsMutation.isSuccess && indexAllDocsMutation.data && (
        <div className="mb-6 bg-green-50 border border-green-200 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <svg className="h-5 w-5 text-green-600 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <h3 className="text-sm font-medium text-green-800">Documentation indexed successfully</h3>
              <p className="text-sm text-green-700 mt-1">
                {indexAllDocsMutation.data.indexed} instances indexed, {indexAllDocsMutation.data.skipped} skipped (already cached), {indexAllDocsMutation.data.errors} errors.
                Total: {indexAllDocsMutation.data.totalItems.toLocaleString()} docs.
                {isEmbedding && (
                  <span className="ml-1 text-indigo-700">Embedding vectors in background...</span>
                )}
                {!isEmbedding && embedResult && (
                  <span className="ml-1 text-indigo-700">{embedResult.embedded.toLocaleString()} vectors generated.</span>
                )}
              </p>
            </div>
          </div>
        </div>
      )}
      {indexAllDocsMutation.isError && (
        <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <svg className="h-5 w-5 text-red-600 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <h3 className="text-sm font-medium text-red-800">Failed to index documentation</h3>
              <p className="text-sm text-red-700 mt-1">
                {indexAllDocsMutation.error?.message || 'An error occurred'}
              </p>
            </div>
          </div>
        </div>
      )}
      {/* Embed Progress Bar */}
      {isEmbedding && embedJobProgress && embedJobProgress.status !== 'none' && (
        <div className="mb-6 bg-indigo-50 border border-indigo-200 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <svg className="animate-spin h-5 w-5 text-indigo-600 mt-0.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <div className="flex-1">
              <h3 className="text-sm font-medium text-indigo-800">
                Embedding vectors... Instance {(embedJobProgress as EmbedJobProgress).instancesDone + 1}/{(embedJobProgress as EmbedJobProgress).instancesTotal}
              </h3>
              <div className="mt-2 w-full bg-indigo-200 rounded-full h-2">
                <div
                  className="bg-indigo-600 h-2 rounded-full transition-all duration-500"
                  style={{ width: `${(embedJobProgress as EmbedJobProgress).totalItems > 0 ? Math.round(((embedJobProgress as EmbedJobProgress).processedItems / (embedJobProgress as EmbedJobProgress).totalItems) * 100) : 0}%` }}
                />
              </div>
              <p className="text-xs text-indigo-600 mt-1">
                {(embedJobProgress as EmbedJobProgress).processedItems.toLocaleString()} / {(embedJobProgress as EmbedJobProgress).totalItems.toLocaleString()} docs
                {(embedJobProgress as EmbedJobProgress).totalAlreadyExists > 0 && (
                  <span className="ml-2">({(embedJobProgress as EmbedJobProgress).totalAlreadyExists.toLocaleString()} already embedded, skipped)</span>
                )}
                {(embedJobProgress as EmbedJobProgress).totalEmbedded > 0 && (
                  <span className="ml-2">| {(embedJobProgress as EmbedJobProgress).totalEmbedded.toLocaleString()} new vectors</span>
                )}
              </p>
            </div>
          </div>
        </div>
      )}
      {/* Embed completed result */}
      {!isEmbedding && embedResult && !indexAllDocsMutation.isSuccess && (
        <div className="mb-6 bg-indigo-50 border border-indigo-200 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <svg className="h-5 w-5 text-indigo-600 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <h3 className="text-sm font-medium text-indigo-800">Vectors embedded successfully</h3>
              <p className="text-sm text-indigo-700 mt-1">
                {embedResult.embedded.toLocaleString()} new vectors in {(embedResult.duration / 1000).toFixed(1)}s
              </p>
            </div>
          </div>
        </div>
      )}
      {clearEmbeddingsMutation.isSuccess && (
        <div className="mb-6 bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <svg className="h-5 w-5 text-yellow-600 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <h3 className="text-sm font-medium text-yellow-800">Doc embeddings cleared</h3>
              <p className="text-sm text-yellow-700 mt-1">
                {clearEmbeddingsMutation.data?.deleted.toLocaleString()} vectors deleted. Click &quot;Embed All Vectors&quot; to regenerate.
              </p>
            </div>
          </div>
        </div>
      )}
      {embedAllDocsMutation.isError && (
        <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <svg className="h-5 w-5 text-red-600 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <h3 className="text-sm font-medium text-red-800">Failed to embed vectors</h3>
              <p className="text-sm text-red-700 mt-1">
                {embedAllDocsMutation.error?.message || 'An error occurred'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="bg-white rounded-lg shadow p-4 mb-6">
        <div className="flex flex-wrap items-center gap-4">
          {/* Instance Filter */}
          <div className="flex items-center gap-2">
            <label htmlFor="instance-filter" className="text-sm font-medium text-gray-700">
              Instance
            </label>
            <select
              id="instance-filter"
              value={selectedInstanceId}
              onChange={(e) => {
                const val = e.target.value;
                setSelectedInstanceId(val === 'all' ? 'all' : parseInt(val));
                setSearchResults([]);
                setSelectedDoc(null);
                setFilterPod('');
              }}
              className="rounded-md border border-gray-300 bg-white py-1.5 pl-3 pr-8 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              disabled={instancesLoading}
            >
              <option value="all">Select Instance...</option>
              {instances.map((inst) => (
                <option key={inst.id} value={inst.id}>
                  {inst.name} ({inst.type} {inst.version})
                </option>
              ))}
            </select>
          </div>

          {/* Pod Filter */}
          {pods.length > 0 && (
            <div className="flex items-center gap-2">
              <label htmlFor="pod-filter" className="text-sm font-medium text-gray-700">
                Pod
              </label>
              <select
                id="pod-filter"
                value={filterPod}
                onChange={(e) => setFilterPod(e.target.value)}
                className="rounded-md border border-gray-300 bg-white py-1.5 pl-3 pr-8 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="">All Pods</option>
                {pods.map((pod) => (
                  <option key={pod.name} value={pod.name}>
                    {pod.name} ({pod.fileCount})
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Type Filter */}
          <div className="flex items-center gap-2">
            <label htmlFor="type-filter" className="text-sm font-medium text-gray-700">
              Type
            </label>
            <select
              id="type-filter"
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="rounded-md border border-gray-300 bg-white py-1.5 pl-3 pr-8 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">All Types</option>
              <option value="type">Types</option>
              <option value="function">Functions</option>
              <option value="slot">Slots</option>
              <option value="chapter">Chapters</option>
              <option value="tag">Tags</option>
            </select>
          </div>

          {/* Language Filter */}
          <div className="flex items-center gap-2">
            <label htmlFor="language-filter" className="text-sm font-medium text-gray-700">
              Language
            </label>
            <select
              id="language-filter"
              value={filterLanguage}
              onChange={(e) => setFilterLanguage(e.target.value)}
              className="rounded-md border border-gray-300 bg-white py-1.5 pl-3 pr-8 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">All</option>
              <option value="fantom">Fantom</option>
              <option value="axon">Axon</option>
            </select>
          </div>

          {/* Clear Filters */}
          {(filterPod || filterType || filterLanguage) && (
            <button
              onClick={() => {
                setFilterPod('');
                setFilterType('');
                setFilterLanguage('');
              }}
              className="text-xs text-blue-600 hover:text-blue-800 underline"
            >
              Clear filters
            </button>
          )}
        </div>

        {/* Instance info and doc actions */}
        {selectedInstance && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <div className="flex items-center justify-between">
              <div className="text-sm text-gray-500">
                <span className="font-medium">{selectedInstance.name}</span>
                <span className="mx-2">|</span>
                <span>{selectedInstance.type} {selectedInstance.version}</span>
                <span className="mx-2">|</span>
                <span>{pods.length} pods indexed</span>
                {docStatus && (
                  <>
                    <span className="mx-2">|</span>
                    <span className={docStatus.hasCache ? 'text-green-600' : 'text-yellow-600'}>
                      {docStatus.hasCache ? `${docStatus.itemCount} docs cached` : 'Not cached'}
                    </span>
                  </>
                )}
                {vectorStats?.docs && (
                  <>
                    <span className="mx-2">|</span>
                    <span className={vectorStats.docs.totalVectors > 0 ? 'text-indigo-600' : 'text-gray-400'}>
                      {vectorStats.docs.totalVectors > 0
                        ? `${vectorStats.docs.totalVectors} vectors`
                        : 'No vectors'}
                    </span>
                    {vectorStats.tables?.docs?.model && (
                      <span className="text-xs text-gray-400 ml-1">
                        ({vectorStats.tables.docs.model.split('/').pop()})
                      </span>
                    )}
                  </>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => indexDocsMutation.mutate(selectedInstance.id)}
                  disabled={indexDocsMutation.isPending}
                  className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                >
                  {indexDocsMutation.isPending ? (
                    <>
                      <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Indexing...
                    </>
                  ) : (
                    <>
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      {docStatus?.hasCache ? 'Re-index Docs' : 'Index Docs'}
                    </>
                  )}
                </button>
                {docStatus?.hasCache && (
                  <button
                    onClick={() => clearCacheMutation.mutate(selectedInstance.id)}
                    disabled={clearCacheMutation.isPending}
                    className="px-3 py-1.5 text-sm font-medium text-yellow-700 bg-yellow-100 hover:bg-yellow-200 rounded-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                  >
                    {clearCacheMutation.isPending ? (
                      <>
                        <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        Clearing...
                      </>
                    ) : (
                      <>
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                        Clear Cache
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
            {(indexDocsMutation.isError || clearCacheMutation.isError) && (
              <div className="mt-2 text-sm text-red-600">
                {indexDocsMutation.error?.message || clearCacheMutation.error?.message || 'An error occurred'}
              </div>
            )}
            {indexDocsMutation.isSuccess && (
              <div className="mt-2 text-sm text-green-600">
                Docs indexed successfully!
                {isEmbedding && (
                  <span className="ml-2 text-indigo-600">
                    Embedding vectors...
                  </span>
                )}
                {embedResult && (
                  <span className="ml-2 text-indigo-600">
                    {embedResult.embedded} vectors generated in {(embedResult.duration / 1000).toFixed(1)}s
                  </span>
                )}
              </div>
            )}
            {embedDocsMutation.isError && (
              <div className="mt-2 text-sm text-yellow-600">
                Vector embedding failed (keyword search still works)
              </div>
            )}
          </div>
        )}
      </div>

      {/* Search */}
      <div className="bg-white rounded-lg shadow p-4 mb-6">
        <div className="relative">
          <input
            type="text"
            placeholder={selectedInstanceId === 'all'
              ? "Select an instance first..."
              : "Search documentation (min 2 characters)..."}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            disabled={selectedInstanceId === 'all'}
            className="w-full rounded-md border border-gray-300 py-3 pl-10 pr-4 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-500"
          />
          <svg
            className="absolute left-3 top-3.5 h-5 w-5 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          {isSearching && (
            <div className="absolute right-3 top-3.5">
              <svg
                className="animate-spin h-5 w-5 text-blue-500"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Search Results */}
        <div className="bg-white rounded-lg shadow">
          <div className="p-4 border-b border-gray-200">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900">
                Search Results
                {searchResults.length > 0 && (
                  <span className="ml-2 text-sm font-normal text-gray-500">
                    ({searchResults.length} found)
                  </span>
                )}
              </h2>
              {searchMeta && searchResults.length > 0 && (
                <div className="flex items-center gap-2 text-xs">
                  <span className={`px-2 py-0.5 rounded-full ${
                    searchMeta.searchMethod === 'hybrid'
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-gray-100 text-gray-600'
                  }`}>
                    {searchMeta.searchMethod === 'hybrid' ? 'Hybrid' : 'Keyword'}
                  </span>
                  {searchMeta.searchMethod === 'hybrid' && (
                    <span className="text-gray-400">
                      KW:{searchMeta.keywordMatches} VEC:{searchMeta.vectorMatches}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="max-h-[600px] overflow-auto">
            {searchError ? (
              <div className="p-4 text-red-600 text-sm">
                {searchError}
              </div>
            ) : searchResults.length === 0 ? (
              <div className="p-8 text-center text-gray-500">
                {selectedInstanceId === 'all'
                  ? 'Select an instance to search documentation'
                  : debouncedQuery.length < 2 && !filterPod && !filterType && !filterLanguage
                  ? 'Enter a search term or select a filter to browse'
                  : 'No results found'}
              </div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {searchResults.map((doc, i) => (
                  <li key={i}>
                    <button
                      onClick={() => setSelectedDoc(doc)}
                      className={`w-full text-left p-4 hover:bg-gray-50 transition-colors ${
                        selectedDoc?.qualifiedName === doc.qualifiedName
                          ? 'bg-blue-50'
                          : ''
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full ${getTypeBadgeColor(
                            doc.type
                          )}`}
                        >
                          {doc.type}
                        </span>
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full ${getLanguageBadgeColor(
                            doc.language
                          )}`}
                        >
                          {doc.language}
                        </span>
                        <span className="text-xs text-gray-400">{doc.pod}</span>
                        {doc.retrieval && (
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full ${getRetrievalBadge(doc.retrieval.source).color}`}
                            title={`KW rank: ${doc.retrieval.keywordRank ?? '-'} | VEC rank: ${doc.retrieval.vectorRank ?? '-'} | KW score: ${doc.retrieval.keywordScore.toFixed(2)} | VEC score: ${doc.retrieval.vectorScore.toFixed(2)} | Fused: ${doc.retrieval.fusedScore.toFixed(4)}`}
                          >
                            {getRetrievalBadge(doc.retrieval.source).label}
                          </span>
                        )}
                      </div>
                      <div className="font-medium text-gray-900">{doc.name}</div>
                      <div className="text-sm text-gray-500 truncate">
                        {doc.qualifiedName}
                      </div>
                      {doc.description && (
                        <div className="text-sm text-gray-600 mt-1 line-clamp-2">
                          {doc.description}
                        </div>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Detail Panel */}
        <div className="bg-white rounded-lg shadow">
          <div className="p-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">Details</h2>
          </div>

          <div className="p-4">
            {selectedDoc ? (
              <div className="space-y-4">
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${getTypeBadgeColor(
                        selectedDoc.type
                      )}`}
                    >
                      {selectedDoc.type}
                    </span>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${getLanguageBadgeColor(
                        selectedDoc.language
                      )}`}
                    >
                      {selectedDoc.language}
                    </span>
                    <span className="text-sm text-gray-500">{selectedDoc.pod}</span>
                  </div>
                  <h3 className="text-xl font-semibold text-gray-900">
                    {selectedDoc.name}
                  </h3>
                  <p className="text-sm font-mono text-gray-500 mt-1">
                    {selectedDoc.qualifiedName}
                  </p>
                </div>

                {selectedDoc.signature && (
                  <div>
                    <h4 className="text-sm font-medium text-gray-700 mb-1">
                      Signature
                    </h4>
                    <pre className="bg-gray-100 p-2 rounded text-sm font-mono overflow-x-auto">
                      {selectedDoc.signature}
                    </pre>
                  </div>
                )}

                {selectedDoc.description && (
                  <div>
                    <h4 className="text-sm font-medium text-gray-700 mb-1">
                      Description
                    </h4>
                    <p className="text-gray-600">{selectedDoc.description}</p>
                  </div>
                )}

                {selectedDoc.url && (
                  <div>
                    <a
                      href={selectedDoc.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-700 text-sm"
                    >
                      View full documentation
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                        />
                      </svg>
                    </a>
                  </div>
                )}

                {selectedDoc.version && (
                  <div className="text-sm text-gray-500">
                    Version: {selectedDoc.version}
                  </div>
                )}

                <div className="pt-4 border-t border-gray-200">
                  <h4 className="text-sm font-medium text-gray-700 mb-2">
                    Raw Data
                  </h4>
                  <pre className="bg-gray-900 text-gray-100 p-3 rounded-lg text-xs overflow-auto max-h-48">
                    {JSON.stringify(selectedDoc, null, 2)}
                  </pre>
                </div>
              </div>
            ) : (
              <div className="text-center text-gray-500 py-8">
                Select a search result to view details
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Pods Quick Access */}
      {pods.length > 0 && (
        <div className="mt-6 bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Available Pods ({pods.length})
          </h2>
          <div className="flex flex-wrap gap-2">
            {pods.map((pod) => (
              <button
                key={pod.name}
                onClick={() => {
                  setFilterPod(pod.name);
                  setSearchQuery(pod.name);
                }}
                className={`px-3 py-1 rounded-full text-sm transition-colors ${
                  pod.isAxonLib
                    ? 'bg-purple-100 hover:bg-purple-200 text-purple-700'
                    : pod.category === 'core'
                    ? 'bg-blue-100 hover:bg-blue-200 text-blue-700'
                    : pod.category === 'lib'
                    ? 'bg-green-100 hover:bg-green-200 text-green-700'
                    : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                }`}
              >
                {pod.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Docs vector model + live embed status panel ─────────────────────────
// Mirrors the home-page GlobalProgressPanel style: a model card + a live
// progress block when an embed job is active. The progress data is the
// same `EmbedJobProgress` shape used by the home page so operators get a
// consistent view of what's running.
interface DocsEmbedStatusPanelProps {
  modelStatus?: ModelStatusResponse;
  progress?: EmbedJobProgress;
  activeJob: EmbedJobProgress | { status: 'none' } | null | undefined;
}

function DocsEmbedStatusPanel({ modelStatus, progress, activeJob }: DocsEmbedStatusPanelProps) {
  const docs = modelStatus?.docs;
  const isRunning = !!progress && progress.status === 'running';
  // When this tab hasn't kicked off a job locally, fall back to the
  // server-side "active job" poll so externally-triggered embed runs
  // (auto-pipeline, another tab) still surface here.
  const live: EmbedJobProgress | null = isRunning
    ? progress!
    : (activeJob && 'jobId' in activeJob && activeJob.status === 'running' ? activeJob : null);
  const pct = live && live.totalItems > 0
    ? Math.min(100, Math.round((live.processedItems / live.totalItems) * 100))
    : null;

  return (
    <div className="mb-6 grid grid-cols-1 lg:grid-cols-[1fr_2fr] gap-4">
      {/* Model card */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Docs Embedding Model</h3>
        {docs ? (
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between gap-3">
              <span className="text-gray-500">Configured</span>
              <code className="font-mono text-gray-900 truncate" title={docs.configuredModel}>
                {docs.configuredModel}
              </code>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-gray-500">Dimensions</span>
              <span className="text-gray-900">{docs.configuredDimensions}d</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-gray-500">Stored vectors</span>
              <span className="text-gray-900">{docs.storedRows.toLocaleString()}</span>
            </div>
            {docs.storedModel && docs.storedModel !== docs.configuredModel && (
              <div className="mt-2 text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded px-2 py-1">
                Stored vectors use <code className="font-mono">{docs.storedModel}</code> ({docs.storedDimensions}d) — re-embed with current model to align.
              </div>
            )}
            {docs.mismatch && docs.storedModel === docs.configuredModel && (
              <div className="mt-2 text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded px-2 py-1">
                Dimension mismatch detected — re-embed required.
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-gray-500">Loading model status…</p>
        )}
      </div>

      {/* Live status card */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-900">Embedding Status</h3>
          {live ? (
            <span className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-800">
              <span className="animate-pulse w-1.5 h-1.5 rounded-full bg-blue-500" />
              running
            </span>
          ) : (
            <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">idle</span>
          )}
        </div>

        {live ? (
          <div className="space-y-2 text-sm">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Stat label="Instances" value={`${live.instancesDone}/${live.instancesTotal}`} />
              <Stat label="Items" value={`${live.processedItems.toLocaleString()} / ${live.totalItems.toLocaleString()}`} />
              <Stat label="Embedded" value={live.totalEmbedded.toLocaleString()} highlight="emerald" />
              <Stat label="Skipped" value={live.totalSkipped.toLocaleString()} />
            </div>
            {pct !== null && (
              <div>
                <div className="flex justify-between text-xs text-gray-600 mb-1">
                  <span>Progress</span>
                  <span>{pct}%</span>
                </div>
                <div className="h-2 bg-gray-100 rounded overflow-hidden">
                  <div className="h-full bg-blue-500 transition-all" style={{ width: `${pct}%` }} />
                </div>
              </div>
            )}
            {live.startedAt && (
              <p className="text-xs text-gray-500">
                started {new Date(live.startedAt).toLocaleTimeString()} · jobId <code className="font-mono">{live.jobId.slice(0, 8)}</code>
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-gray-500">
            No embed job running. Click <span className="font-medium text-indigo-700">Embed All Vectors</span> above to start.
          </p>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string | number; highlight?: 'emerald' }) {
  return (
    <div className="bg-gray-50 rounded p-2">
      <div className="text-xs text-gray-500 uppercase tracking-wide">{label}</div>
      <div className={`text-sm font-semibold ${highlight === 'emerald' ? 'text-emerald-700' : 'text-gray-900'}`}>{value}</div>
    </div>
  );
}
