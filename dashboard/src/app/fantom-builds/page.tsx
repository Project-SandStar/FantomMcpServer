'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { api, FantomBuild, FantomBuildProject, FantomBuildIndexResult } from '@/lib/api';

// ============================================
// Build Card Component
// ============================================
interface BuildCardProps {
  build: FantomBuild;
  isExpanded: boolean;
  isIndexing: boolean;
  isClearingIndex: boolean;
  onToggleExpand: () => void;
  onIndex: () => void;
  onClearIndex: () => void;
  onDelete: () => void;
  isDeletePending: boolean;
}

function BuildCard({
  build,
  isExpanded,
  isIndexing,
  isClearingIndex,
  onToggleExpand,
  onIndex,
  onClearIndex,
  onDelete,
  isDeletePending,
}: BuildCardProps) {
  const { data: buildDetails } = useQuery({
    queryKey: ['fantom-build', build.id],
    queryFn: () => api.getFantomBuild(build.id),
    enabled: isExpanded,
  });

  return (
    <div className="bg-white rounded-lg shadow hover:shadow-md transition-shadow">
      {/* Card Header */}
      <div
        className="p-4 cursor-pointer"
        onClick={onToggleExpand}
      >
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <h3 className="text-lg font-semibold text-gray-900">
                Fantom {build.version}
              </h3>
              {build.hasSource ? (
                <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-green-100 text-green-700">
                  Source Available
                </span>
              ) : (
                <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-gray-100 text-gray-600">
                  No Source
                </span>
              )}
              {build.isActive && (
                <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-blue-100 text-blue-700">
                  Active
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-gray-500 font-mono truncate">
              {build.path}
            </p>
          </div>

          {/* Stats */}
          <div className="flex items-center gap-4 ml-4">
            {build.podCount > 0 && (
              <>
                <div className="text-center">
                  <div className="text-lg font-semibold text-purple-600">{build.podCount}</div>
                  <div className="text-xs text-gray-500">Pods</div>
                </div>
                <div className="text-center">
                  <div className="text-lg font-semibold text-blue-600">
                    {build.functionCount.toLocaleString()}
                  </div>
                  <div className="text-xs text-gray-500">Functions</div>
                </div>
                <div className="text-center">
                  <div className="text-lg font-semibold text-green-600">
                    {build.typeCount.toLocaleString()}
                  </div>
                  <div className="text-xs text-gray-500">Types</div>
                </div>
              </>
            )}

            {/* Expand Icon */}
            <svg
              className={`w-5 h-5 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </div>
      </div>

      {/* Expanded Details */}
      {isExpanded && (
        <div className="px-4 pb-4 border-t border-gray-100 pt-4 space-y-4">
          {/* Action Buttons */}
          <div className="flex gap-2">
            {build.hasSource && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onIndex();
                }}
                disabled={isIndexing}
                className="px-3 py-1.5 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isIndexing ? (
                  <>
                    <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Indexing...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    {build.lastIndexed ? 'Re-index' : 'Index Source Code'}
                  </>
                )}
              </button>
            )}
            {build.lastIndexed && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClearIndex();
                }}
                disabled={isClearingIndex || isIndexing}
                className="px-3 py-1.5 text-sm font-medium rounded-lg bg-yellow-50 text-yellow-700 hover:bg-yellow-100 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isClearingIndex ? (
                  <>
                    <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Clearing...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                    Clear Index
                  </>
                )}
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              disabled={isDeletePending}
              className="px-3 py-1.5 text-sm font-medium rounded-lg bg-red-50 text-red-600 hover:bg-red-100 disabled:opacity-50"
            >
              Delete
            </button>
          </div>

          {/* Build Info */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="p-3 bg-gray-50 rounded-lg">
              <div className="text-xs text-gray-500">Status</div>
              <div className={`font-semibold ${build.lastIndexed ? 'text-green-600' : 'text-gray-400'}`}>
                {build.lastIndexed ? 'Indexed' : 'Not Indexed'}
              </div>
            </div>
            {build.lastIndexed && (
              <div className="p-3 bg-gray-50 rounded-lg col-span-3">
                <div className="text-xs text-gray-500">Last Indexed</div>
                <div className="font-medium text-gray-700">
                  {new Date(build.lastIndexed).toLocaleString()}
                </div>
              </div>
            )}
          </div>

          {/* Projects List */}
          {buildDetails?.projects && buildDetails.projects.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-gray-700">
                Indexed Pods ({buildDetails.projects.length})
              </h4>
              <div className="max-h-64 overflow-y-auto border border-gray-200 rounded-lg">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Pod Name
                      </th>
                      <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Functions
                      </th>
                      <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Types
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {buildDetails.projects.map((project: FantomBuildProject) => (
                      <tr key={project.id} className="hover:bg-gray-50">
                        <td className="px-3 py-2 text-sm text-gray-900">
                          <Link
                            href={`/ast-viewer?podId=${encodeURIComponent(project.name)}`}
                            className="text-blue-600 hover:underline"
                          >
                            {project.podName || project.name}
                          </Link>
                        </td>
                        <td className="px-3 py-2 text-sm text-right text-gray-600">
                          {project.functionCount.toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-sm text-right text-gray-600">
                          {project.typeCount.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================
// Main Page Component
// ============================================
export default function FantomBuildsPage() {
  const queryClient = useQueryClient();
  const [expandedBuildId, setExpandedBuildId] = useState<number | null>(null);
  const [indexingBuildId, setIndexingBuildId] = useState<number | null>(null);
  const [lastIndexResult, setLastIndexResult] = useState<FantomBuildIndexResult | null>(null);

  // Fetch Fantom builds
  const { data: buildsData, isLoading, error, refetch } = useQuery({
    queryKey: ['fantom-builds'],
    queryFn: api.getFantomBuilds,
    staleTime: 30000,
  });

  // Fetch Fantom source folder
  const { data: sourceFolderData } = useQuery({
    queryKey: ['fantom-source-folder'],
    queryFn: api.getFantomSourceFolder,
    staleTime: 60000,
  });

  // Scan for builds mutation
  const scanMutation = useMutation({
    mutationFn: api.scanFantomBuilds,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fantom-builds'] });
    },
  });

  // Index all builds mutation
  const indexAllMutation = useMutation({
    mutationFn: api.indexAllFantomBuilds,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fantom-builds'] });
      queryClient.invalidateQueries({ queryKey: ['ast-cache'] });
    },
  });

  // Index build mutation
  const indexMutation = useMutation({
    mutationFn: (buildId: number) => api.indexFantomBuild(buildId),
    onSuccess: (result) => {
      setLastIndexResult(result);
      setIndexingBuildId(null);
      queryClient.invalidateQueries({ queryKey: ['fantom-builds'] });
      queryClient.invalidateQueries({ queryKey: ['fantom-build', result.buildId] });
      queryClient.invalidateQueries({ queryKey: ['ast-cache'] });
    },
    onError: () => {
      setIndexingBuildId(null);
    },
  });

  // Delete build mutation
  const deleteMutation = useMutation({
    mutationFn: (buildId: number) => api.deleteFantomBuild(buildId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fantom-builds'] });
    },
  });

  // Clear index mutation
  const [clearingBuildId, setClearingBuildId] = useState<number | null>(null);
  const clearIndexMutation = useMutation({
    mutationFn: (buildId: number) => api.clearFantomBuildIndex(buildId),
    onSuccess: (result) => {
      setClearingBuildId(null);
      queryClient.invalidateQueries({ queryKey: ['fantom-builds'] });
      queryClient.invalidateQueries({ queryKey: ['fantom-build', result.buildId] });
      queryClient.invalidateQueries({ queryKey: ['ast-cache'] });
    },
    onError: () => {
      setClearingBuildId(null);
    },
  });

  const handleIndexBuild = (buildId: number) => {
    setIndexingBuildId(buildId);
    setLastIndexResult(null);
    indexMutation.mutate(buildId);
  };

  const handleClearIndex = (buildId: number) => {
    if (confirm('Clear index for this build? This will remove all indexed projects and functions.')) {
      setClearingBuildId(buildId);
      clearIndexMutation.mutate(buildId);
    }
  };

  const builds = buildsData?.builds || [];

  if (error) {
    return (
      <div className="space-y-6">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <h2 className="text-red-800 font-medium">Failed to load Fantom builds</h2>
          <p className="text-red-600 mt-1">
            {error instanceof Error ? error.message : 'Unknown error'}
          </p>
          <button
            onClick={() => refetch()}
            className="mt-2 px-3 py-1 text-sm bg-red-100 text-red-700 rounded hover:bg-red-200"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Fantom Builds</h1>
          <p className="text-gray-600 mt-1">
            Index Fantom source code for enhanced code intelligence. Projects use naming: <code className="text-sm bg-gray-100 px-1 rounded">fantom.version.podName</code>
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => scanMutation.mutate()}
            disabled={scanMutation.isPending || !sourceFolderData?.path}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {scanMutation.isPending ? (
              <>
                <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Scanning...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                Scan Builds
              </>
            )}
          </button>
          <button
            onClick={() => indexAllMutation.mutate()}
            disabled={indexAllMutation.isPending || builds.length === 0}
            className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {indexAllMutation.isPending ? (
              <>
                <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Indexing...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
                </svg>
                Index Fantom Code
              </>
            )}
          </button>
        </div>
      </div>

      {/* Source Folder Info */}
      {sourceFolderData?.path ? (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            <span className="text-sm text-blue-800">
              <span className="font-medium">Fantom Source Folder:</span>{' '}
              <code className="font-mono text-xs bg-blue-100 px-1 rounded">{sourceFolderData.path}</code>
            </span>
          </div>
          <p className="mt-1 text-xs text-blue-600">
            Configure this in <Link href="/config" className="underline">Settings</Link>
          </p>
        </div>
      ) : (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span className="text-sm text-yellow-800">
              No Fantom source folder configured
            </span>
          </div>
          <p className="mt-1 text-xs text-yellow-700">
            Configure the Fantom source folder in <Link href="/config" className="underline font-medium">Settings</Link> to enable scanning for builds.
          </p>
        </div>
      )}

      {/* Last Index Result */}
      {lastIndexResult && (
        <div className={`border rounded-lg p-4 ${lastIndexResult.success ? 'bg-green-50 border-green-200' : 'bg-yellow-50 border-yellow-200'}`}>
          <div className="flex items-center justify-between">
            <div>
              <h3 className={`font-medium ${lastIndexResult.success ? 'text-green-800' : 'text-yellow-800'}`}>
                {lastIndexResult.success ? 'Indexing Complete' : 'Indexing Completed with Errors'}
              </h3>
              <p className={`text-sm ${lastIndexResult.success ? 'text-green-600' : 'text-yellow-700'}`}>
                Fantom {lastIndexResult.version}: {lastIndexResult.podsIndexed} pods, {lastIndexResult.totalFunctions.toLocaleString()} functions, {lastIndexResult.totalTypes.toLocaleString()} types in {(lastIndexResult.duration / 1000).toFixed(2)}s
              </p>
              {lastIndexResult.errors.length > 0 && (
                <details className="mt-2">
                  <summary className="text-sm text-yellow-700 cursor-pointer">
                    {lastIndexResult.errors.length} errors (click to expand)
                  </summary>
                  <pre className="mt-2 text-xs bg-yellow-100 p-2 rounded overflow-x-auto max-h-32">
                    {lastIndexResult.errors.slice(0, 10).join('\n')}
                    {lastIndexResult.errors.length > 10 && `\n... and ${lastIndexResult.errors.length - 10} more`}
                  </pre>
                </details>
              )}
            </div>
            <button
              onClick={() => setLastIndexResult(null)}
              className="text-gray-400 hover:text-gray-600"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Scan Result */}
      {scanMutation.data && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <h3 className="font-medium text-blue-800">Scan Complete</h3>
          <p className="text-sm text-blue-600">
            Found {scanMutation.data.registered} Fantom installations in {scanMutation.data.sourceFolder}
          </p>
        </div>
      )}

      {/* Index All Result */}
      {indexAllMutation.data && (
        <div className={`border rounded-lg p-4 ${indexAllMutation.data.indexed > 0 ? 'bg-green-50 border-green-200' : 'bg-yellow-50 border-yellow-200'}`}>
          <h3 className={`font-medium ${indexAllMutation.data.indexed > 0 ? 'text-green-800' : 'text-yellow-800'}`}>
            Index All Complete
          </h3>
          <p className={`text-sm ${indexAllMutation.data.indexed > 0 ? 'text-green-600' : 'text-yellow-700'}`}>
            Indexed {indexAllMutation.data.indexed} of {indexAllMutation.data.totalBuilds} builds: {indexAllMutation.data.totalPods?.toLocaleString() || 0} pods, {indexAllMutation.data.totalFunctions?.toLocaleString() || 0} functions, {indexAllMutation.data.totalTypes?.toLocaleString() || 0} types
          </p>
          {indexAllMutation.data.results && indexAllMutation.data.results.length > 0 && (
            <details className="mt-2">
              <summary className={`text-sm cursor-pointer ${indexAllMutation.data.indexed > 0 ? 'text-green-700' : 'text-yellow-700'}`}>
                Details ({indexAllMutation.data.results.length} builds)
              </summary>
              <ul className="mt-2 text-xs space-y-1">
                {indexAllMutation.data.results.map((r) => (
                  <li key={r.buildId} className={r.success ? 'text-green-600' : 'text-red-600'}>
                    Fantom {r.version}: {r.success ? `${r.podsIndexed} pods, ${r.totalFunctions?.toLocaleString()} functions` : r.error}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {/* Loading State */}
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <svg className="animate-spin h-8 w-8 mx-auto text-blue-500" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <p className="mt-2 text-gray-500">Loading Fantom builds...</p>
          </div>
        </div>
      )}

      {/* Builds List */}
      {!isLoading && builds.length === 0 && (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-8 text-center">
          <svg className="w-12 h-12 mx-auto text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
          <h3 className="mt-4 text-lg font-medium text-gray-900">No Fantom Builds Found</h3>
          <p className="mt-1 text-gray-500">
            Click "Scan for Builds" to discover Fantom installations in your source folder.
          </p>
        </div>
      )}

      {!isLoading && builds.length > 0 && (
        <div className="space-y-4">
          {builds.map((build) => (
            <BuildCard
              key={build.id}
              build={build}
              isExpanded={expandedBuildId === build.id}
              isIndexing={indexingBuildId === build.id}
              isClearingIndex={clearingBuildId === build.id}
              onToggleExpand={() => setExpandedBuildId(expandedBuildId === build.id ? null : build.id)}
              onIndex={() => handleIndexBuild(build.id)}
              onClearIndex={() => handleClearIndex(build.id)}
              onDelete={() => {
                if (confirm(`Delete Fantom ${build.version}? This will remove the build record but not the source files.`)) {
                  deleteMutation.mutate(build.id);
                }
              }}
              isDeletePending={deleteMutation.isPending}
            />
          ))}
        </div>
      )}

      {/* Summary Stats */}
      {builds.length > 0 && (
        <div className="bg-gray-50 rounded-lg p-4">
          <h3 className="text-sm font-medium text-gray-700 mb-3">Summary</h3>
          <div className="grid grid-cols-4 gap-4">
            <div className="text-center">
              <div className="text-2xl font-bold text-gray-900">{builds.length}</div>
              <div className="text-xs text-gray-500">Builds</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-purple-600">
                {builds.reduce((sum, b) => sum + b.podCount, 0)}
              </div>
              <div className="text-xs text-gray-500">Total Pods</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-blue-600">
                {builds.reduce((sum, b) => sum + b.functionCount, 0).toLocaleString()}
              </div>
              <div className="text-xs text-gray-500">Total Functions</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600">
                {builds.reduce((sum, b) => sum + b.typeCount, 0).toLocaleString()}
              </div>
              <div className="text-xs text-gray-500">Total Types</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
