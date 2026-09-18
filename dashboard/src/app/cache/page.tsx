'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, CacheInfo, AstCacheOverview } from '@/lib/api';
import { useState } from 'react';
import Link from 'next/link';

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let unitIndex = 0;
  let value = bytes;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatAge(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatDate(timestamp: number | string): string {
  return new Date(timestamp).toLocaleString();
}

function getSourceLabel(source: string): string {
  const labels: Record<string, string> = {
    'fantom-docs': 'Fantom Documentation',
    'haxall-docs': 'Haxall Documentation',
    'fantom-code': 'Fantom Code Index',
    'local-docs': 'Instance Documentation',
  };
  return labels[source] || source;
}

function getSourceColor(source: string): string {
  const colors: Record<string, string> = {
    'fantom-docs': 'bg-blue-100 text-blue-800',
    'haxall-docs': 'bg-green-100 text-green-800',
    'fantom-code': 'bg-purple-100 text-purple-800',
    'local-docs': 'bg-orange-100 text-orange-800',
  };
  return colors[source] || 'bg-gray-100 text-gray-800';
}

export default function CachePage() {
  const queryClient = useQueryClient();
  const [clearingName, setClearingName] = useState<string | null>(null);
  const [expandedCache, setExpandedCache] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'all' | 'files' | 'ast'>('all');

  // Fetch file-based caches
  const {
    data: fileCaches,
    isLoading: fileCachesLoading,
    error: fileCachesError,
  } = useQuery({
    queryKey: ['caches'],
    queryFn: api.getCaches,
    refetchInterval: 10000,
  });

  // Fetch AST caches
  const {
    data: astCaches,
    isLoading: astCachesLoading,
    error: astCachesError,
  } = useQuery({
    queryKey: ['ast-cache'],
    queryFn: api.getAllAstCache,
    refetchInterval: 10000,
  });

  const clearMutation = useMutation({
    mutationFn: (name?: string) => api.clearCache(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['caches'] });
      setClearingName(null);
    },
    onError: () => {
      setClearingName(null);
    },
  });

  const indexAllAstMutation = useMutation({
    mutationFn: () => api.indexAllPodsAst(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ast-cache'] });
    },
  });

  const handleClearCache = (name?: string) => {
    setClearingName(name || 'all');
    clearMutation.mutate(name);
  };

  const isLoading = fileCachesLoading || astCachesLoading;
  const error = fileCachesError || astCachesError;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <h2 className="text-red-800 font-medium">Error loading caches</h2>
        <p className="text-red-600 mt-1">
          {error instanceof Error ? error.message : 'Unknown error'}
        </p>
      </div>
    );
  }

  const totalFileSize = fileCaches?.reduce((sum, cache) => sum + cache.size, 0) || 0;
  const totalFileItems = fileCaches?.reduce((sum, cache) => sum + (cache.metadata?.itemCount || 0), 0) || 0;
  const totalAstFunctions = astCaches?.pods.reduce((sum, pod) => sum + (pod.summary?.totalFunctions || 0), 0) || 0;
  const totalAstTypes = astCaches?.pods.reduce((sum, pod) => sum + (pod.summary?.totalTypes || 0), 0) || 0;
  const cachedPods = astCaches?.pods.filter(p => p.hasAstCache).length || 0;
  const totalPods = astCaches?.pods.length || 0;

  return (
    <div>
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Cache Management</h1>
          <p className="text-gray-600 mt-1">
            Manage cached documentation, AST indexes, and other data
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => indexAllAstMutation.mutate()}
            disabled={indexAllAstMutation.isPending}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {indexAllAstMutation.isPending ? 'Indexing...' : 'Index All AST'}
          </button>
          <button
            onClick={() => handleClearCache()}
            disabled={clearMutation.isPending}
            className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {clearingName === 'all' ? 'Clearing...' : 'Clear File Caches'}
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-500">File Cache Size</div>
          <div className="text-2xl font-bold text-gray-900">{formatBytes(totalFileSize)}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-500">Doc Items Cached</div>
          <div className="text-2xl font-bold text-gray-900">{totalFileItems.toLocaleString()}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-500">AST Pods & Projects Cached</div>
          <div className="text-2xl font-bold text-gray-900">{cachedPods} / {totalPods}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-500">AST Functions</div>
          <div className="text-2xl font-bold text-gray-900">{totalAstFunctions.toLocaleString()}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-500">AST Types</div>
          <div className="text-2xl font-bold text-gray-900">{totalAstTypes.toLocaleString()}</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="-mb-px flex space-x-8">
          {[
            { id: 'all', label: 'All Caches' },
            { id: 'files', label: `File Caches (${fileCaches?.length || 0})` },
            { id: 'ast', label: `AST Caches (${cachedPods})` },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as 'all' | 'files' | 'ast')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                activeTab === tab.id
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* File Caches Section */}
      {(activeTab === 'all' || activeTab === 'files') && (
        <>
          {activeTab === 'all' && <h2 className="text-lg font-semibold text-gray-900 mb-4">File Caches</h2>}
          {!fileCaches || fileCaches.length === 0 ? (
            <div className="bg-gray-50 rounded-lg p-8 text-center mb-6">
              <p className="text-gray-500">No file caches found</p>
              <p className="text-gray-400 text-sm mt-2">
                Caches will be created when you search documentation or index code
              </p>
            </div>
          ) : (
            <div className="space-y-4 mb-6">
              {fileCaches.map((cache) => (
            <div key={cache.name} className="bg-white rounded-lg shadow overflow-hidden">
              {/* Cache Header */}
              <div
                className="p-4 cursor-pointer hover:bg-gray-50 flex items-center justify-between"
                onClick={() => setExpandedCache(expandedCache === cache.name ? null : cache.name)}
              >
                <div className="flex items-center gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-gray-900">{cache.name}</span>
                      {cache.metadata?.source && (
                        <span className={`px-2 py-0.5 text-xs rounded-full ${getSourceColor(cache.metadata.source)}`}>
                          {getSourceLabel(cache.metadata.source)}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      {cache.metadata ? (
                        <span>
                          {cache.metadata.itemCount.toLocaleString()} items • v{cache.metadata.version}
                        </span>
                      ) : (
                        <span className="text-yellow-600">Metadata not available</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-6">
                  <div className="text-right">
                    <div className="text-sm font-medium text-gray-700">{formatBytes(cache.size)}</div>
                    <div className="text-xs text-gray-500">{formatAge(cache.age)}</div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleClearCache(cache.name);
                    }}
                    disabled={clearMutation.isPending}
                    className="px-3 py-1 text-sm text-red-600 hover:bg-red-50 rounded disabled:opacity-50"
                  >
                    {clearingName === cache.name ? 'Clearing...' : 'Clear'}
                  </button>
                  <svg
                    className={`w-5 h-5 text-gray-400 transform transition-transform ${
                      expandedCache === cache.name ? 'rotate-180' : ''
                    }`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </div>

              {/* Expanded Details */}
              {expandedCache === cache.name && (
                <div className="border-t border-gray-100 p-4 bg-gray-50">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Basic Info */}
                    <div>
                      <h4 className="text-sm font-medium text-gray-700 mb-2">Cache Details</h4>
                      <dl className="space-y-1 text-sm">
                        <div className="flex justify-between">
                          <dt className="text-gray-500">Path:</dt>
                          <dd className="text-gray-700 font-mono text-xs truncate max-w-xs" title={cache.path}>
                            {cache.path}
                          </dd>
                        </div>
                        <div className="flex justify-between">
                          <dt className="text-gray-500">Last Modified:</dt>
                          <dd className="text-gray-700">{new Date(cache.lastModified).toLocaleString()}</dd>
                        </div>
                        {cache.metadata && (
                          <>
                            <div className="flex justify-between">
                              <dt className="text-gray-500">Created:</dt>
                              <dd className="text-gray-700">{formatDate(cache.metadata.timestamp)}</dd>
                            </div>
                            <div className="flex justify-between">
                              <dt className="text-gray-500">Version:</dt>
                              <dd className="text-gray-700">{cache.metadata.version}</dd>
                            </div>
                          </>
                        )}
                      </dl>
                    </div>

                    {/* Content Breakdown */}
                    {cache.metadata && (
                      <div>
                        <h4 className="text-sm font-medium text-gray-700 mb-2">Content Breakdown</h4>

                        {/* By Type */}
                        {cache.metadata.byType && Object.keys(cache.metadata.byType).length > 0 && (
                          <div className="mb-3">
                            <div className="text-xs text-gray-500 mb-1">By Type:</div>
                            <div className="flex flex-wrap gap-1">
                              {Object.entries(cache.metadata.byType)
                                .sort(([, a], [, b]) => b - a)
                                .map(([type, count]) => (
                                  <span
                                    key={type}
                                    className="px-2 py-0.5 text-xs bg-gray-200 text-gray-700 rounded"
                                  >
                                    {type}: {count.toLocaleString()}
                                  </span>
                                ))}
                            </div>
                          </div>
                        )}

                        {/* By Pod */}
                        {cache.metadata.byPod && Object.keys(cache.metadata.byPod).length > 0 && (
                          <div>
                            <div className="text-xs text-gray-500 mb-1">
                              By Pod ({Object.keys(cache.metadata.byPod).length} pods):
                            </div>
                            <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
                              {Object.entries(cache.metadata.byPod)
                                .sort(([, a], [, b]) => b - a)
                                .slice(0, 20)
                                .map(([pod, count]) => (
                                  <span
                                    key={pod}
                                    className="px-2 py-0.5 text-xs bg-blue-100 text-blue-700 rounded"
                                  >
                                    {pod}: {count}
                                  </span>
                                ))}
                              {Object.keys(cache.metadata.byPod).length > 20 && (
                                <span className="px-2 py-0.5 text-xs bg-gray-100 text-gray-500 rounded">
                                  +{Object.keys(cache.metadata.byPod).length - 20} more
                                </span>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
            </div>
          )}
        </>
      )}

      {/* AST Caches Section */}
      {(activeTab === 'all' || activeTab === 'ast') && (
        <>
          {activeTab === 'all' && <h2 className="text-lg font-semibold text-gray-900 mb-4">AST Caches (Pod Code Index)</h2>}
          {!astCaches?.pods || astCaches.pods.length === 0 ? (
            <div className="bg-gray-50 rounded-lg p-8 text-center">
              <p className="text-gray-500">No pods or projects registered</p>
              <p className="text-gray-400 text-sm mt-2">
                Add entries in the Pods & Projects page to enable AST caching
              </p>
            </div>
          ) : (
            <div className="bg-white rounded-lg shadow overflow-hidden">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Pod / Source</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Functions</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Types</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Classes</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Last Indexed</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {astCaches.pods.map((pod) => (
                    <tr key={`${pod.sourceType || 'pod'}-${pod.podId}`} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="font-medium text-gray-900">{pod.podName}</div>
                        <div className="text-xs text-gray-500 truncate max-w-xs" title={pod.podPath}>
                          {pod.podPath}
                        </div>
                        {pod.instanceName && (
                          <div className="text-xs text-blue-600 mt-0.5">
                            Instance: {pod.instanceName}
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`px-2 py-1 text-xs rounded-full ${
                          pod.sourceType === 'source'
                            ? 'bg-purple-100 text-purple-800'
                            : 'bg-blue-100 text-blue-800'
                        }`}>
                          {pod.sourceType === 'source' ? 'Source' : 'Pod'}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`px-2 py-1 text-xs rounded-full ${
                          pod.hasAstCache
                            ? 'bg-green-100 text-green-800'
                            : 'bg-gray-100 text-gray-600'
                        }`}>
                          {pod.hasAstCache ? 'Cached' : 'Not Cached'}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                        {pod.summary?.totalFunctions?.toLocaleString() || '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                        {pod.summary?.totalTypes?.toLocaleString() || '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                        {pod.summary?.totalClasses?.toLocaleString() || '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {pod.lastIndexed ? formatDate(pod.lastIndexed) : '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm">
                        {pod.sourceType === 'source' && pod.projectId ? (
                          <Link
                            href={`/ast-viewer?projectId=${pod.projectId}`}
                            className="text-blue-600 hover:text-blue-800"
                          >
                            View Details
                          </Link>
                        ) : pod.podId ? (
                          <Link
                            href={`/ast-viewer?podId=${encodeURIComponent(pod.podId)}`}
                            className="text-blue-600 hover:text-blue-800"
                          >
                            View Details
                          </Link>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {clearMutation.isError && (
        <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-600">
            Failed to clear cache:{' '}
            {clearMutation.error instanceof Error
              ? clearMutation.error.message
              : 'Unknown error'}
          </p>
        </div>
      )}
    </div>
  );
}
