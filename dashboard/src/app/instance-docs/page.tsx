'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, FantomInstance, DocStatus, DocPodInfo, LocalDocItem } from '@/lib/api';

function InstanceDocsContent() {
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const [selectedInstance, setSelectedInstance] = useState<FantomInstance | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<LocalDocItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [filterPod, setFilterPod] = useState<string>('');
  const [filterType, setFilterType] = useState<string>('');
  const [filterLanguage, setFilterLanguage] = useState<string>('');
  const [indexingInstance, setIndexingInstance] = useState<number | null>(null);
  const [isEmbedding, setIsEmbedding] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Fetch all instances
  const { data: instancesData, isLoading: instancesLoading } = useQuery({
    queryKey: ['instances'],
    queryFn: api.getInstances,
  });

  // Auto-select instance from URL parameter
  useEffect(() => {
    const instanceId = searchParams.get('id');
    if (instanceId && instancesData?.instances) {
      const instance = instancesData.instances.find(i => i.id === parseInt(instanceId));
      if (instance && !selectedInstance) {
        setSelectedInstance(instance);
      }
    }
  }, [searchParams, instancesData, selectedInstance]);

  // Fetch vector stats
  const { data: vectorStats } = useQuery({
    queryKey: ['vector-stats'],
    queryFn: api.getVectorStats,
  });

  // Fetch doc status for selected instance
  const { data: docStatus, isLoading: docStatusLoading, refetch: refetchDocStatus } = useQuery({
    queryKey: ['doc-status', selectedInstance?.id],
    queryFn: () => selectedInstance ? api.getInstanceDocStatus(selectedInstance.id) : null,
    enabled: !!selectedInstance,
  });

  // Fetch doc pods for selected instance
  const { data: docPodsData, isLoading: docPodsLoading } = useQuery({
    queryKey: ['doc-pods', selectedInstance?.id],
    queryFn: () => selectedInstance ? api.getInstanceDocPods(selectedInstance.id) : null,
    enabled: !!selectedInstance && !!docStatus?.hasCache,
  });

  // Embed docs mutation
  const embedMutation = useMutation({
    mutationFn: (instanceId: number) => api.embedInstanceDocs(instanceId, true),
    onSuccess: (data) => {
      setIsEmbedding(false);
      setMessage({ type: 'success', text: `Indexed & embedded: ${data.embedded} vectors in ${(data.duration / 1000).toFixed(1)}s` });
    },
    onError: () => {
      setIsEmbedding(false);
    },
  });

  // Index docs mutation — also triggers embedding after success
  const indexMutation = useMutation({
    mutationFn: ({ instanceId, forceRefresh }: { instanceId: number; forceRefresh: boolean }) =>
      api.indexInstanceDocs(instanceId, undefined, forceRefresh),
    onSuccess: (data, variables) => {
      setMessage({ type: 'success', text: `Indexed ${data.itemCount} items in ${data.duration}ms. Embedding vectors...` });
      queryClient.invalidateQueries({ queryKey: ['doc-status', selectedInstance?.id] });
      queryClient.invalidateQueries({ queryKey: ['doc-pods', selectedInstance?.id] });
      setIndexingInstance(null);
      // Auto-embed vectors
      setIsEmbedding(true);
      embedMutation.mutate(variables.instanceId);
    },
    onError: (error) => {
      setMessage({ type: 'error', text: `Indexing failed: ${error}` });
      setIndexingInstance(null);
    },
  });

  // Clear cache mutation
  const clearCacheMutation = useMutation({
    mutationFn: (instanceId: number) => api.clearInstanceDocCache(instanceId),
    onSuccess: () => {
      setMessage({ type: 'success', text: 'Cache cleared successfully' });
      queryClient.invalidateQueries({ queryKey: ['doc-status', selectedInstance?.id] });
      queryClient.invalidateQueries({ queryKey: ['doc-pods', selectedInstance?.id] });
      setSearchResults([]);
    },
    onError: (error) => {
      setMessage({ type: 'error', text: `Failed to clear cache: ${error}` });
    },
  });

  // Search docs
  const handleSearch = async () => {
    if (!selectedInstance || !searchQuery.trim()) return;

    setIsSearching(true);
    try {
      const result = await api.searchInstanceDocs(selectedInstance.id, searchQuery, {
        pod: filterPod || undefined,
        type: filterType || undefined,
        language: filterLanguage as 'fantom' | 'axon' | undefined,
        limit: 50,
      });
      setSearchResults(result.results);
    } catch (error) {
      setMessage({ type: 'error', text: `Search failed: ${error}` });
    } finally {
      setIsSearching(false);
    }
  };

  // Auto-dismiss messages
  if (message) {
    setTimeout(() => setMessage(null), 5000);
  }

  const instances = instancesData?.instances || [];

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">Instance Documentation</h1>
      </div>

      {/* Message */}
      {message && (
        <div className={`p-4 rounded-lg ${message.type === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
          {message.text}
        </div>
      )}

      {/* Instance Selection */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Select Instance</h2>

        {instancesLoading ? (
          <div className="text-gray-500">Loading instances...</div>
        ) : instances.length === 0 ? (
          <div className="text-gray-500">No instances found. Add instances first.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {instances.map((instance) => (
              <button
                key={instance.id}
                onClick={() => {
                  setSelectedInstance(instance);
                  setSearchResults([]);
                  setSearchQuery('');
                }}
                className={`p-4 rounded-lg border-2 text-left transition-colors ${
                  selectedInstance?.id === instance.id
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <div className="font-medium text-gray-900">{instance.name}</div>
                <div className="text-sm text-gray-500">{instance.type} {instance.version}</div>
                <div className="text-xs text-gray-400 truncate">{instance.path}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Selected Instance Details */}
      {selectedInstance && (
        <>
          {/* Doc Status */}
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex justify-between items-start mb-4">
              <div>
                <h2 className="text-lg font-semibold">Documentation Status</h2>
                <p className="text-sm text-gray-500">{selectedInstance.name}</p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setIndexingInstance(selectedInstance.id);
                    indexMutation.mutate({ instanceId: selectedInstance.id, forceRefresh: false });
                  }}
                  disabled={indexingInstance === selectedInstance.id}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  {indexingInstance === selectedInstance.id ? 'Indexing...' : 'Index Docs'}
                </button>
                {docStatus?.hasCache && (
                  <>
                    <button
                      onClick={() => {
                        setIndexingInstance(selectedInstance.id);
                        indexMutation.mutate({ instanceId: selectedInstance.id, forceRefresh: true });
                      }}
                      disabled={indexingInstance === selectedInstance.id}
                      className="px-4 py-2 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 disabled:opacity-50"
                    >
                      Reindex
                    </button>
                    <button
                      onClick={() => clearCacheMutation.mutate(selectedInstance.id)}
                      disabled={clearCacheMutation.isPending}
                      className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
                    >
                      Clear Cache
                    </button>
                  </>
                )}
              </div>
            </div>

            {docStatusLoading ? (
              <div className="text-gray-500">Loading status...</div>
            ) : docStatus ? (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="p-4 bg-gray-50 rounded-lg">
                  <div className="text-sm text-gray-500">Cache Status</div>
                  <div className={`font-semibold ${docStatus.hasCache ? 'text-green-600' : 'text-gray-400'}`}>
                    {docStatus.hasCache ? 'Cached' : 'Not Indexed'}
                  </div>
                </div>
                <div className="p-4 bg-gray-50 rounded-lg">
                  <div className="text-sm text-gray-500">Items Indexed</div>
                  <div className="font-semibold text-gray-900">
                    {docStatus.itemCount?.toLocaleString() || 0}
                  </div>
                </div>
                <div className="p-4 bg-gray-50 rounded-lg">
                  <div className="text-sm text-gray-500">Pods</div>
                  <div className="font-semibold text-gray-900">
                    {docStatus.podCount || 0}
                  </div>
                </div>
                <div className="p-4 bg-gray-50 rounded-lg">
                  <div className="text-sm text-gray-500">Last Indexed</div>
                  <div className="font-semibold text-gray-900 text-sm">
                    {docStatus.lastIndexed ? new Date(docStatus.lastIndexed).toLocaleString() : 'Never'}
                  </div>
                </div>
                <div className="p-4 bg-gray-50 rounded-lg">
                  <div className="text-sm text-gray-500">Doc Vectors</div>
                  <div className={`font-semibold ${vectorStats?.docs?.totalVectors ? 'text-indigo-600' : 'text-gray-400'}`}>
                    {vectorStats?.docs?.totalVectors?.toLocaleString() || 0}
                    {isEmbedding && <span className="ml-1 text-xs text-indigo-400 animate-pulse">embedding...</span>}
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-gray-500">No documentation path found for this instance.</div>
            )}

            {docStatus?.docPath && (
              <div className="mt-4 text-sm text-gray-500">
                <span className="font-medium">Doc Path:</span> {docStatus.docPath}
              </div>
            )}
          </div>

          {/* Pods List */}
          {docStatus?.hasCache && (
            <div className="bg-white rounded-lg shadow p-6">
              <h2 className="text-lg font-semibold mb-4">Indexed Pods ({docPodsData?.count || 0})</h2>

              {docPodsLoading ? (
                <div className="text-gray-500">Loading pods...</div>
              ) : docPodsData?.pods ? (
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
                  {docPodsData.pods.map((pod) => (
                    <div
                      key={pod.name}
                      className={`p-2 rounded border text-sm ${
                        pod.isAxonLib
                          ? 'bg-purple-50 border-purple-200'
                          : pod.category === 'core'
                          ? 'bg-blue-50 border-blue-200'
                          : pod.category === 'lib'
                          ? 'bg-green-50 border-green-200'
                          : 'bg-gray-50 border-gray-200'
                      }`}
                    >
                      <div className="font-medium truncate">{pod.name}</div>
                      <div className="text-xs text-gray-500">{pod.fileCount} files</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-gray-500">No pods found.</div>
              )}
            </div>
          )}

          {/* Search */}
          {docStatus?.hasCache && (
            <div className="bg-white rounded-lg shadow p-6">
              <h2 className="text-lg font-semibold mb-4">Search Documentation</h2>

              <div className="flex flex-wrap gap-4 mb-4">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                  placeholder="Search (e.g., Bool, readAll, abs)"
                  className="flex-1 min-w-[200px] px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <select
                  value={filterPod}
                  onChange={(e) => setFilterPod(e.target.value)}
                  className="px-4 py-2 border rounded-lg"
                >
                  <option value="">All Pods</option>
                  {docPodsData?.pods.map((pod) => (
                    <option key={pod.name} value={pod.name}>{pod.name}</option>
                  ))}
                </select>
                <select
                  value={filterType}
                  onChange={(e) => setFilterType(e.target.value)}
                  className="px-4 py-2 border rounded-lg"
                >
                  <option value="">All Types</option>
                  <option value="type">Types</option>
                  <option value="function">Functions</option>
                  <option value="slot">Slots</option>
                  <option value="chapter">Chapters</option>
                </select>
                <select
                  value={filterLanguage}
                  onChange={(e) => setFilterLanguage(e.target.value)}
                  className="px-4 py-2 border rounded-lg"
                >
                  <option value="">All Languages</option>
                  <option value="fantom">Fantom</option>
                  <option value="axon">Axon</option>
                </select>
                <button
                  onClick={handleSearch}
                  disabled={isSearching || !searchQuery.trim()}
                  className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  {isSearching ? 'Searching...' : 'Search'}
                </button>
              </div>

              {/* Search Results */}
              {searchResults.length > 0 && (
                <div className="border rounded-lg overflow-hidden">
                  <table className="w-full">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-2 text-left text-sm font-medium text-gray-600">Name</th>
                        <th className="px-4 py-2 text-left text-sm font-medium text-gray-600">Type</th>
                        <th className="px-4 py-2 text-left text-sm font-medium text-gray-600">Pod</th>
                        <th className="px-4 py-2 text-left text-sm font-medium text-gray-600">Language</th>
                        <th className="px-4 py-2 text-left text-sm font-medium text-gray-600">Description</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {searchResults.map((item, idx) => (
                        <tr key={idx} className="hover:bg-gray-50">
                          <td className="px-4 py-2">
                            <div className="font-medium text-blue-600">{item.name}</div>
                            <div className="text-xs text-gray-400">{item.qualifiedName}</div>
                          </td>
                          <td className="px-4 py-2">
                            <span className={`px-2 py-1 rounded text-xs ${
                              item.type === 'type' ? 'bg-blue-100 text-blue-700' :
                              item.type === 'function' ? 'bg-purple-100 text-purple-700' :
                              item.type === 'slot' ? 'bg-green-100 text-green-700' :
                              'bg-gray-100 text-gray-700'
                            }`}>
                              {item.type}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-sm text-gray-600">{item.pod}</td>
                          <td className="px-4 py-2">
                            <span className={`px-2 py-1 rounded text-xs ${
                              item.language === 'axon' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'
                            }`}>
                              {item.language}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-sm text-gray-600 max-w-md truncate">
                            {item.description}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {searchResults.length === 0 && searchQuery && !isSearching && (
                <div className="text-center text-gray-500 py-8">
                  No results found for &quot;{searchQuery}&quot;
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function InstanceDocsPage() {
  return (
    <Suspense fallback={<div className="p-6">Loading...</div>}>
      <InstanceDocsContent />
    </Suspense>
  );
}
