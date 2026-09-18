'use client';

import { Suspense, useState, useCallback, useMemo } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, AstType, AstFunction, AstCacheOverview, SourceType, FantomInstance, LanguageBreakdownResponse, LanguageBreakdown, ExtractedFunctionItem } from '@/lib/api';
import { ProgressStrip } from '@/components/ProgressStrip';
import { TimelineSection } from '@/components/timeline/TimelineSection';

// Type for a pod in the overview
type PodOverviewItem = AstCacheOverview['pods'][number];

// ============================================
// Pod Card Component for Overview Grid
// ============================================
function PodCard({
  pod,
  onViewDetails,
  onCreateCache,
  isCreating,
  onEmbedMissing,
  isEmbedding,
  onDelete,
  isDeleting,
  deleteError,
}: {
  pod: PodOverviewItem;
  onViewDetails: (podId: string) => void;
  onCreateCache: (podId: string) => void;
  isCreating: boolean;
  onEmbedMissing?: (projectId: number) => void;
  isEmbedding?: boolean;
  onDelete?: (projectId: number, podName: string) => void;
  isDeleting?: boolean;
  deleteError?: string | null;
}) {
  const truncatePath = (path: string, maxLength = 40) => {
    if (path.length <= maxLength) return path;
    return '...' + path.slice(-maxLength);
  };

  // Get source type badge styling
  const getSourceTypeBadge = () => {
    if (pod.sourceType === 'source') {
      return { bg: 'bg-teal-100', text: 'text-teal-700', label: 'Source' };
    }
    if (pod.sourceType === 'fantom-build') {
      return { bg: 'bg-orange-100', text: 'text-orange-700', label: 'Fantom' };
    }
    return { bg: 'bg-indigo-100', text: 'text-indigo-700', label: 'Pod' };
  };

  // Get language badge styling
  const getLanguageBadge = () => {
    const lang = (pod as { language?: string }).language || 'fantom';
    const badges: Record<string, { bg: string; text: string; label: string }> = {
      fantom: { bg: 'bg-purple-100', text: 'text-purple-700', label: 'Fantom' },
      axon: { bg: 'bg-amber-100', text: 'text-amber-800', label: 'Axon' },
      trio: { bg: 'bg-indigo-100', text: 'text-indigo-700', label: 'Trio' },
      typescript: { bg: 'bg-blue-100', text: 'text-blue-700', label: 'TS' },
      javascript: { bg: 'bg-yellow-100', text: 'text-yellow-700', label: 'JS' },
      python: { bg: 'bg-green-100', text: 'text-green-700', label: 'Python' },
      dart: { bg: 'bg-cyan-100', text: 'text-cyan-700', label: 'Dart' },
      polymer: { bg: 'bg-pink-100', text: 'text-pink-700', label: 'Polymer' },
      java: { bg: 'bg-red-100', text: 'text-red-700', label: 'Java' },
      go: { bg: 'bg-sky-100', text: 'text-sky-700', label: 'Go' },
      rust: { bg: 'bg-orange-100', text: 'text-orange-700', label: 'Rust' },
    };
    return badges[lang] || { bg: 'bg-gray-100', text: 'text-gray-700', label: lang };
  };

  // Get parser type badge styling
  const getParserBadge = () => {
    const parser = (pod as { parserType?: string }).parserType || 'regex';
    if (parser === 'tree-sitter-wasm' || parser === 'tree-sitter') {
      return { bg: 'bg-emerald-100', text: 'text-emerald-700', label: 'Tree-sitter' };
    }
    return { bg: 'bg-slate-100', text: 'text-slate-600', label: 'Regex' };
  };

  const sourceTypeBadge = getSourceTypeBadge();
  const languageBadge = getLanguageBadge();
  const parserBadge = getParserBadge();

  return (
    <div className="bg-white rounded-lg shadow p-4 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <h3 className="font-semibold text-gray-900 truncate">{pod.podName}</h3>
            {pod.sourceType && (
              <span className={`px-1.5 py-0.5 text-xs rounded ${sourceTypeBadge.bg} ${sourceTypeBadge.text}`}>
                {sourceTypeBadge.label}
              </span>
            )}
            {/* Language badge */}
            <span className={`px-1.5 py-0.5 text-xs rounded ${languageBadge.bg} ${languageBadge.text}`}>
              {languageBadge.label}
            </span>
            {/* Parser type badge */}
            <span className={`px-1.5 py-0.5 text-xs rounded ${parserBadge.bg} ${parserBadge.text}`} title="Parser type">
              {parserBadge.label}
            </span>
            {pod.fantomBuildVersion && (
              <span className="px-1.5 py-0.5 text-xs rounded bg-orange-50 text-orange-600">
                Fantom {pod.fantomBuildVersion}
              </span>
            )}
            {pod.instanceVersion && !pod.fantomBuildVersion && (
              <span className="px-1.5 py-0.5 text-xs rounded bg-blue-50 text-blue-600">
                v{pod.instanceVersion}
              </span>
            )}
          </div>
          {/* Version compatibility info */}
          {(pod.compatMinVersion || pod.compatMaxVersion) && (
            <div className="flex items-center gap-1 mb-1">
              <span className="text-xs text-gray-400">Compat:</span>
              <span className="text-xs font-mono text-green-600">
                {pod.compatMinVersion === pod.compatMaxVersion
                  ? pod.compatMinVersion
                  : `${pod.compatMinVersion || '?'} - ${pod.compatMaxVersion || '?'}`}
              </span>
            </div>
          )}
          <p className="text-xs text-gray-500 font-mono truncate" title={pod.podPath}>
            {truncatePath(pod.podPath)}
          </p>
          {pod.instanceName && (
            <p className="text-xs text-gray-400 mt-0.5">
              Instance: {pod.instanceName}{pod.instanceVersion && ` (${pod.instanceVersion})`}
            </p>
          )}
        </div>
        <span
          className={`ml-2 flex-shrink-0 px-2 py-1 text-xs rounded-full font-medium ${
            pod.hasAstCache
              ? 'bg-green-100 text-green-700'
              : 'bg-gray-100 text-gray-600'
          }`}
        >
          {pod.hasAstCache ? 'Cached' : 'Not Cached'}
        </span>
      </div>

      {pod.hasAstCache && pod.summary ? (
        <div className="grid grid-cols-3 gap-2 mb-3">
          <div className="text-center p-2 bg-purple-50 rounded">
            <div className="text-lg font-bold text-purple-700">
              {pod.summary.totalFunctions}
            </div>
            <div className="text-xs text-purple-600">Functions</div>
          </div>
          <div className="text-center p-2 bg-blue-50 rounded">
            <div className="text-lg font-bold text-blue-700">
              {pod.summary.totalTypes}
            </div>
            <div className="text-xs text-blue-600">Types</div>
          </div>
          <div className="text-center p-2 bg-green-50 rounded">
            <div className="text-lg font-bold text-green-700">
              {pod.summary.totalClasses}
            </div>
            <div className="text-xs text-green-600">Classes</div>
          </div>
        </div>
      ) : (
        <div className="mb-3 p-4 bg-gray-50 rounded text-center text-sm text-gray-500">
          No AST data available
        </div>
      )}

      {pod.lastIndexed && (
        <div className="text-xs text-gray-500 mb-3">
          Last indexed: {new Date(pod.lastIndexed).toLocaleDateString()}{' '}
          {new Date(pod.lastIndexed).toLocaleTimeString()}
        </div>
      )}

      <div className="flex gap-2">
        {pod.hasAstCache ? (
          <button
            onClick={() => onViewDetails(pod.podId)}
            className="flex-1 px-3 py-2 bg-purple-600 text-white text-sm rounded hover:bg-purple-700 transition-colors"
          >
            View Details
          </button>
        ) : (
          <button
            onClick={() => onCreateCache(pod.podId)}
            disabled={isCreating}
            className="flex-1 px-3 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {isCreating ? 'Creating...' : 'Create Cache'}
          </button>
        )}
        {onEmbedMissing && pod.projectId !== undefined && (
          <button
            onClick={() => onEmbedMissing(pod.projectId!)}
            disabled={isEmbedding}
            className="px-3 py-2 bg-amber-50 hover:bg-amber-100 text-amber-700 text-sm rounded disabled:opacity-50 transition-colors"
            title="Fill in any un-embedded nodes for this project (incremental, no delete)"
          >
            {isEmbedding ? '…' : 'Embed missing'}
          </button>
        )}
        {onDelete && pod.projectId !== undefined && (
          <button
            onClick={() => onDelete(pod.projectId!, pod.podName)}
            disabled={isDeleting}
            className="px-3 py-2 bg-red-50 hover:bg-red-100 text-red-700 text-sm rounded disabled:opacity-50 transition-colors"
            title="Delete this code project (graph + vectors + row). Files on disk untouched."
          >
            {isDeleting ? '…' : 'Delete'}
          </button>
        )}
      </div>
      {deleteError && (
        <div className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
          Delete failed: {deleteError}
        </div>
      )}
    </div>
  );
}

// ============================================
// Overview Component - Shows all pods
// ============================================
function AstOverview({
  onSelectPod,
}: {
  onSelectPod: (podId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [searchFilter, setSearchFilter] = useState('');
  const [sourceTypeFilter, setSourceTypeFilter] = useState<'all' | 'pod' | 'source' | 'fantom-build'>('all');
  const [instanceFilter, setInstanceFilter] = useState<number | 'all'>('all');
  const [fantomVersionFilter, setFantomVersionFilter] = useState<string>('all');
  const [instanceVersionFilter, setInstanceVersionFilter] = useState<string>('all');
  const [compatVersionFilter, setCompatVersionFilter] = useState<string>('all');
  const [languageFilter, setLanguageFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(24);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [creatingPodId, setCreatingPodId] = useState<string | null>(null);

  // Fetch all pods with AST status
  const { data: astData, isLoading, refetch } = useQuery({
    queryKey: ['all-ast-cache'],
    queryFn: api.getAllAstCache,
  });

  // Fetch instances for the filter dropdown
  const { data: instancesData } = useQuery({
    queryKey: ['instances'],
    queryFn: api.getInstances,
  });

  // Create AST cache mutation
  const createAstCacheMutation = useMutation({
    mutationFn: (podId: string) => api.createPodAstCache(podId),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['all-ast-cache'] });
      setSuccess(
        `AST cache created: ${result.indexResult?.functionsIndexed || 0} functions, ${result.indexResult?.typesIndexed || 0} types`
      );
      setCreatingPodId(null);
      refetch();
      setTimeout(() => setSuccess(null), 5000);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to create AST cache');
      setCreatingPodId(null);
      setTimeout(() => setError(null), 5000);
    },
  });

  // Index all pods + projects (skip-if-fresh). Hash-gate honored, so unchanged
  // projects short-circuit fast.
  const indexAllMutation = useMutation({
    mutationFn: () => api.indexAllPodsAst({ force: false }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['all-ast-cache'] });
      const ok = result.indexedOk ?? 0;
      const errs = result.indexErrors ?? 0;
      const total = result.processed ?? 0;
      const podsP = result.podsProcessed ?? 0;
      const projP = result.projectsProcessed ?? 0;
      const failed = (result.results ?? []).filter((r) => r.error).slice(0, 3);
      const failedSummary = failed.length > 0
        ? ` · failures: ${failed.map((f) => `${f.name ?? f.podName}: ${(f.error || '').slice(0, 60)}`).join(' | ')}`
        : '';
      const msg = errs > 0
        ? `Indexed ${ok}/${total} (${errs} failed) — ${podsP} pods + ${projP} other projects${failedSummary}`
        : `Indexed ${total} entries: ${podsP} pods + ${projP} other projects (${result.created} new pod-projects, ${result.alreadyExists} existing)`;
      if (errs > 0) {
        setError(msg);
        setTimeout(() => setError(null), 12000);
      } else {
        setSuccess(msg);
        setTimeout(() => setSuccess(null), 6000);
      }
      refetch();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to index all pods + projects');
      setTimeout(() => setError(null), 8000);
    },
  });

  // Force reindex EVERY pod and project, bypassing the hash-gate. Slower but
  // exhaustive — used after grammar / parser fixes that change extracted symbols.
  const reindexAllMutation = useMutation({
    mutationFn: () => api.indexAllPodsAst({ force: true }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['all-ast-cache'] });
      const ok = result.indexedOk ?? 0;
      const errs = result.indexErrors ?? 0;
      const total = result.processed ?? 0;
      const podsP = result.podsProcessed ?? 0;
      const projP = result.projectsProcessed ?? 0;
      const failed = (result.results ?? []).filter((r) => r.error).slice(0, 3);
      const failedSummary = failed.length > 0
        ? ` · failures: ${failed.map((f) => `${f.name ?? f.podName}: ${(f.error || '').slice(0, 60)}`).join(' | ')}`
        : '';
      const msg = errs > 0
        ? `Force-reindexed ${ok}/${total} (${errs} failed) — ${podsP} pods + ${projP} other projects${failedSummary}`
        : `Force-reindexed ${total} entries: ${podsP} pods + ${projP} other projects`;
      if (errs > 0) {
        setError(msg);
        setTimeout(() => setError(null), 12000);
      } else {
        setSuccess(msg);
        setTimeout(() => setSuccess(null), 6000);
      }
      refetch();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to reindex all');
      setTimeout(() => setError(null), 8000);
    },
  });

  const handleCreateCache = (podId: string) => {
    setCreatingPodId(podId);
    createAstCacheMutation.mutate(podId);
  };

  const [embeddingProjectId, setEmbeddingProjectId] = useState<number | null>(null);
  const embedMissingMutation = useMutation({
    mutationFn: (projectId: number) => api.buildMissingForProject(projectId),
    onMutate: (projectId) => setEmbeddingProjectId(projectId),
    onSettled: () => setEmbeddingProjectId(null),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['vector-stats'] }),
  });
  const handleEmbedMissing = (projectId: number) => embedMissingMutation.mutate(projectId);

  const [deletingProjectId, setDeletingProjectId] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState<{ projectId: number; message: string } | null>(null);
  const deleteProjectMutation = useMutation({
    mutationFn: (projectId: number) => api.deleteCodeProject(projectId),
    onMutate: (projectId) => { setDeletingProjectId(projectId); setDeleteError(null); },
    onSettled: () => setDeletingProjectId(null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['all-ast-cache'] });
      queryClient.invalidateQueries({ queryKey: ['code-projects'] });
    },
    onError: (err: unknown, projectId) => {
      const msg = err instanceof Error ? err.message : String(err);
      setDeleteError({ projectId, message: msg });
    },
  });
  const handleDeleteProject = (projectId: number, podName: string) => {
    const ok = window.confirm(
      `Delete project "${podName}"?\n\nThis removes graph nodes, vectors, and the project registration. Files on disk are untouched.`,
    );
    if (!ok) return;
    deleteProjectMutation.mutate(projectId);
  };

  // Get unique instances from pods for filter
  const availableInstances = useMemo(() => {
    if (!astData?.pods) return [];
    const instanceMap = new Map<number, string>();
    astData.pods.forEach((pod) => {
      if (pod.instanceId && pod.instanceName) {
        instanceMap.set(pod.instanceId, pod.instanceName);
      }
    });
    return Array.from(instanceMap.entries()).map(([id, name]) => ({ id, name }));
  }, [astData?.pods]);

  // Get unique Fantom versions from pods for filter
  const availableFantomVersions = useMemo(() => {
    if (!astData?.pods) return [];
    const versions = new Set<string>();
    astData.pods.forEach((pod) => {
      if (pod.fantomBuildVersion) {
        versions.add(pod.fantomBuildVersion);
      }
    });
    return Array.from(versions).sort((a, b) => {
      // Sort versions in descending order (newest first)
      const aParts = a.split('.').map(Number);
      const bParts = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        if (bParts[i] !== aParts[i]) return bParts[i] - aParts[i];
      }
      return 0;
    });
  }, [astData?.pods]);

  // Get unique instance versions from pods for filter (for pod and source types)
  const availableInstanceVersions = useMemo(() => {
    if (!astData?.pods) return [];
    const versions = new Set<string>();
    astData.pods.forEach((pod) => {
      if (pod.instanceVersion && pod.sourceType !== 'fantom-build') {
        versions.add(pod.instanceVersion);
      }
    });
    return Array.from(versions).sort((a, b) => {
      // Sort versions in descending order (newest first)
      const aParts = a.split('.').map(Number);
      const bParts = b.split('.').map(Number);
      for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const aNum = aParts[i] || 0;
        const bNum = bParts[i] || 0;
        if (bNum !== aNum) return bNum - aNum;
      }
      return 0;
    });
  }, [astData?.pods]);

  // Get unique compatibility versions from pods for filter
  const availableCompatVersions = useMemo(() => {
    if (!astData?.pods) return [];
    const versions = new Set<string>();
    astData.pods.forEach((pod) => {
      // Collect all versions that pods are compatible with
      if (pod.compatMinVersion) versions.add(pod.compatMinVersion);
      if (pod.compatMaxVersion) versions.add(pod.compatMaxVersion);
      if (pod.instanceVersion) versions.add(pod.instanceVersion);
    });
    return Array.from(versions).sort((a, b) => {
      // Sort versions in descending order (newest first)
      const aParts = a.split('.').map(Number);
      const bParts = b.split('.').map(Number);
      for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const aNum = aParts[i] || 0;
        const bNum = bParts[i] || 0;
        if (bNum !== aNum) return bNum - aNum;
      }
      return 0;
    });
  }, [astData?.pods]);

  // Get unique languages from pods for filter
  const availableLanguages = useMemo(() => {
    if (!astData?.pods) return [];
    const languages = new Map<string, number>();
    astData.pods.forEach((pod) => {
      const lang = (pod as { language?: string }).language || 'fantom';
      languages.set(lang, (languages.get(lang) || 0) + 1);
    });
    // Sort by count (most common first), then alphabetically
    return Array.from(languages.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([lang]) => lang);
  }, [astData?.pods]);

  // Helper: Compare semver versions (returns -1 if a < b, 0 if equal, 1 if a > b)
  const compareVersions = (a: string, b: string): number => {
    const aParts = a.split('.').map(Number);
    const bParts = b.split('.').map(Number);
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const aNum = aParts[i] || 0;
      const bNum = bParts[i] || 0;
      if (aNum < bNum) return -1;
      if (aNum > bNum) return 1;
    }
    return 0;
  };

  // Helper: Check if a version is within a range
  const isVersionInRange = (version: string, minVersion?: string, maxVersion?: string): boolean => {
    if (!minVersion && !maxVersion) return true;
    if (minVersion && compareVersions(version, minVersion) < 0) return false;
    if (maxVersion && compareVersions(version, maxVersion) > 0) return false;
    return true;
  };

  // Filter pods based on search, source type, instance, and versions
  const filteredPods = useMemo(() => {
    if (!astData?.pods) return [];

    return astData.pods.filter((pod) => {
      // Text search filter
      if (searchFilter.trim()) {
        const query = searchFilter.toLowerCase();
        if (!pod.podName.toLowerCase().includes(query) &&
            !pod.podPath.toLowerCase().includes(query)) {
          return false;
        }
      }

      // Source type filter
      if (sourceTypeFilter !== 'all') {
        if (pod.sourceType !== sourceTypeFilter) {
          return false;
        }
      }

      // Instance filter
      if (instanceFilter !== 'all') {
        if (pod.instanceId !== instanceFilter) {
          return false;
        }
      }

      // Fantom version filter (for fantom-build pods)
      if (fantomVersionFilter !== 'all') {
        if (pod.fantomBuildVersion !== fantomVersionFilter) {
          return false;
        }
      }

      // Instance version filter (for pod and source types)
      if (instanceVersionFilter !== 'all') {
        if (pod.sourceType === 'fantom-build') {
          return false; // Fantom build pods don't have instance versions
        }
        if (pod.instanceVersion !== instanceVersionFilter) {
          return false;
        }
      }

      // Compatibility version filter (show pods compatible with selected version)
      if (compatVersionFilter !== 'all') {
        // For fantom-build pods, check fantomBuildVersion
        if (pod.sourceType === 'fantom-build') {
          if (pod.fantomBuildVersion !== compatVersionFilter) {
            return false;
          }
        } else {
          // For other pods, check if the selected version is within their compat range
          // If no compat range, use instanceVersion as both min and max
          const minVer = pod.compatMinVersion || pod.instanceVersion;
          const maxVer = pod.compatMaxVersion || pod.instanceVersion;
          if (!isVersionInRange(compatVersionFilter, minVer, maxVer)) {
            return false;
          }
        }
      }

      // Language filter
      if (languageFilter !== 'all') {
        const podLang = (pod as { language?: string }).language || 'fantom';
        if (podLang !== languageFilter) {
          return false;
        }
      }

      return true;
    });
  }, [astData?.pods, searchFilter, sourceTypeFilter, instanceFilter, fantomVersionFilter, instanceVersionFilter, compatVersionFilter, languageFilter]);

  // Paginated pods
  const paginatedPods = useMemo(() => {
    const startIndex = (currentPage - 1) * pageSize;
    return filteredPods.slice(startIndex, startIndex + pageSize);
  }, [filteredPods, currentPage, pageSize]);

  // Total pages
  const totalPages = Math.ceil(filteredPods.length / pageSize);

  // Reset to page 1 when filters change
  const resetToFirstPage = () => setCurrentPage(1);

  // Calculate stats (based on all pods, not filtered)
  const stats = useMemo(() => {
    if (!astData?.pods) return { total: 0, cached: 0, notCached: 0, podCode: 0, sourceCode: 0, fantomBuild: 0, byLanguage: {} as Record<string, number> };
    const cached = astData.pods.filter((p) => p.hasAstCache).length;
    const podCode = astData.pods.filter((p) => p.sourceType === 'pod' || !p.sourceType).length;
    const sourceCode = astData.pods.filter((p) => p.sourceType === 'source').length;
    const fantomBuild = astData.pods.filter((p) => p.sourceType === 'fantom-build').length;

    // Count by language
    const byLanguage: Record<string, number> = {};
    astData.pods.forEach((pod) => {
      const lang = (pod as { language?: string }).language || 'fantom';
      byLanguage[lang] = (byLanguage[lang] || 0) + 1;
    });

    return {
      total: astData.pods.length,
      cached,
      notCached: astData.pods.length - cached,
      podCode,
      sourceCode,
      fantomBuild,
      byLanguage,
    };
  }, [astData?.pods]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center space-y-4">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600"></div>
          <div className="text-gray-500">Loading AST cache data...</div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">AST Browser</h1>
          <p className="text-gray-600 mt-1">
            Browse and manage AST cache for all Fantom pods
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => indexAllMutation.mutate()}
            disabled={indexAllMutation.isPending || reindexAllMutation.isPending}
            className="px-4 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 disabled:opacity-50 transition-colors"
            title="Walk every pod + project, skip ones whose source hasn't changed"
          >
            {indexAllMutation.isPending ? 'Indexing...' : 'Index All Pods & Projects'}
          </button>
          <button
            onClick={() => {
              if (confirm(
                'Reindex EVERY pod and project from scratch (bypass hash-gate)?\n\n' +
                'Use this after grammar or parser changes — it forces every file to re-parse. ' +
                'Slower than the regular Index button.'
              )) {
                reindexAllMutation.mutate();
              }
            }}
            disabled={indexAllMutation.isPending || reindexAllMutation.isPending}
            className="px-4 py-2 bg-amber-600 text-white rounded-md hover:bg-amber-700 disabled:opacity-50 transition-colors"
            title="Force re-parse every pod + project, bypassing the hash-gate"
          >
            {reindexAllMutation.isPending ? 'Reindexing...' : 'Reindex All Pods & Projects'}
          </button>
        </div>
      </div>

      {/* Status messages */}
      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-800">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg text-green-800">
          {success}
        </div>
      )}

      {/* Stats Summary */}
      <div className="grid grid-cols-3 md:grid-cols-6 gap-4 mb-6">
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-600 font-medium">Total</div>
          <div className="text-2xl font-bold text-gray-800">{stats.total}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-green-600 font-medium">Cached</div>
          <div className="text-2xl font-bold text-green-700">{stats.cached}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-500 font-medium">Not Cached</div>
          <div className="text-2xl font-bold text-gray-600">{stats.notCached}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-indigo-600 font-medium">Pod Code</div>
          <div className="text-2xl font-bold text-indigo-700">{stats.podCode}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-teal-600 font-medium">Source Code</div>
          <div className="text-2xl font-bold text-teal-700">{stats.sourceCode}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-orange-600 font-medium">Fantom Build</div>
          <div className="text-2xl font-bold text-orange-700">{stats.fantomBuild}</div>
        </div>
      </div>

      {/* Language Breakdown - shown when multiple languages exist */}
      {availableLanguages.length > 1 && (
        <div className="mb-6 bg-white rounded-lg shadow p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-gray-700">Languages</h3>
            <span className="text-xs text-gray-500">{availableLanguages.length} languages indexed</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {availableLanguages.map((lang) => {
              const count = stats.byLanguage[lang] || 0;
              const isActive = languageFilter === lang;
              const langColors: Record<string, { bg: string; activeBg: string; text: string }> = {
                fantom: { bg: 'bg-purple-50', activeBg: 'bg-purple-200', text: 'text-purple-700' },
                typescript: { bg: 'bg-blue-50', activeBg: 'bg-blue-200', text: 'text-blue-700' },
                javascript: { bg: 'bg-yellow-50', activeBg: 'bg-yellow-200', text: 'text-yellow-700' },
                python: { bg: 'bg-green-50', activeBg: 'bg-green-200', text: 'text-green-700' },
                dart: { bg: 'bg-cyan-50', activeBg: 'bg-cyan-200', text: 'text-cyan-700' },
                polymer: { bg: 'bg-pink-50', activeBg: 'bg-pink-200', text: 'text-pink-700' },
                java: { bg: 'bg-red-50', activeBg: 'bg-red-200', text: 'text-red-700' },
                go: { bg: 'bg-sky-50', activeBg: 'bg-sky-200', text: 'text-sky-700' },
                rust: { bg: 'bg-orange-50', activeBg: 'bg-orange-200', text: 'text-orange-700' },
              };
              const colors = langColors[lang] || { bg: 'bg-gray-50', activeBg: 'bg-gray-200', text: 'text-gray-700' };
              return (
                <button
                  key={lang}
                  onClick={() => { setLanguageFilter(isActive ? 'all' : lang); resetToFirstPage(); }}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    isActive ? colors.activeBg : colors.bg
                  } ${colors.text} hover:opacity-80 ${isActive ? 'ring-2 ring-offset-1 ring-purple-400' : ''}`}
                >
                  {lang.charAt(0).toUpperCase() + lang.slice(1)}
                  <span className="ml-1.5 opacity-75">({count})</span>
                </button>
              );
            })}
            {languageFilter !== 'all' && (
              <button
                onClick={() => { setLanguageFilter('all'); resetToFirstPage(); }}
                className="px-3 py-1.5 rounded-lg text-sm font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
              >
                Show All
              </button>
            )}
          </div>
        </div>
      )}

      {/* Search/Filter */}
      <div className="mb-6 bg-white rounded-lg shadow p-4">
        <div className="flex flex-col gap-4">
          {/* First row: Search */}
          <div className="w-full">
            <input
              type="text"
              placeholder="Search for project..."
              value={searchFilter}
              onChange={(e) => { setSearchFilter(e.target.value); resetToFirstPage(); }}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
            />
          </div>

          {/* Second row: Filter controls */}
          <div className="flex flex-col md:flex-row gap-4">
            <div className="flex flex-wrap gap-3">
              <select
                value={sourceTypeFilter}
                onChange={(e) => { setSourceTypeFilter(e.target.value as 'all' | 'pod' | 'source' | 'fantom-build'); resetToFirstPage(); }}
                className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
              >
                <option value="all">All Types</option>
                <option value="pod">Pod Code</option>
                <option value="source">Source Code</option>
                <option value="fantom-build">Fantom Build</option>
              </select>
            {availableInstances.length > 0 && (
              <select
                value={instanceFilter === 'all' ? 'all' : instanceFilter.toString()}
                onChange={(e) => { setInstanceFilter(e.target.value === 'all' ? 'all' : parseInt(e.target.value)); resetToFirstPage(); }}
                className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
              >
                <option value="all">All Instances</option>
                {availableInstances.map((inst) => (
                  <option key={inst.id} value={inst.id}>
                    {inst.name}
                  </option>
                ))}
              </select>
            )}
            {availableFantomVersions.length > 0 && (
              <select
                value={fantomVersionFilter}
                onChange={(e) => { setFantomVersionFilter(e.target.value); resetToFirstPage(); }}
                className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
              >
                <option value="all">All Fantom Versions</option>
                {availableFantomVersions.map((version) => (
                  <option key={version} value={version}>
                    Fantom {version}
                  </option>
                ))}
              </select>
            )}
            {availableInstanceVersions.length > 0 && (
              <select
                value={instanceVersionFilter}
                onChange={(e) => { setInstanceVersionFilter(e.target.value); resetToFirstPage(); }}
                className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
              >
                <option value="all">All Instance Versions</option>
                {availableInstanceVersions.map((version) => (
                  <option key={version} value={version}>
                    Instance v{version}
                  </option>
                ))}
              </select>
            )}
            {availableCompatVersions.length > 0 && (
              <select
                value={compatVersionFilter}
                onChange={(e) => { setCompatVersionFilter(e.target.value); resetToFirstPage(); }}
                className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
              >
                <option value="all">All Compatible</option>
                {availableCompatVersions.map((version) => (
                  <option key={version} value={version}>
                    Compat {version}
                  </option>
                ))}
              </select>
            )}
            {availableLanguages.length > 1 && (
              <select
                value={languageFilter}
                onChange={(e) => { setLanguageFilter(e.target.value); resetToFirstPage(); }}
                className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
              >
                <option value="all">All Languages</option>
                {availableLanguages.map((lang) => (
                  <option key={lang} value={lang}>
                    {lang.charAt(0).toUpperCase() + lang.slice(1)} ({stats.byLanguage[lang] || 0})
                  </option>
                ))}
              </select>
            )}
            <select
              value={pageSize.toString()}
              onChange={(e) => { setPageSize(parseInt(e.target.value)); resetToFirstPage(); }}
              className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
            >
              <option value="12">12 per page</option>
              <option value="24">24 per page</option>
              <option value="48">48 per page</option>
              <option value="96">96 per page</option>
            </select>
            </div>
          </div>

          {/* Active filters row */}
          {(searchFilter || sourceTypeFilter !== 'all' || instanceFilter !== 'all' || fantomVersionFilter !== 'all' || instanceVersionFilter !== 'all' || compatVersionFilter !== 'all' || languageFilter !== 'all') && (
            <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-gray-100">
              <span className="text-sm text-gray-500">Active filters:</span>
              {searchFilter && (
                <span className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 text-gray-700 text-xs rounded-full">
                  Search: &quot;{searchFilter}&quot;
                  <button onClick={() => { setSearchFilter(''); resetToFirstPage(); }} className="hover:text-red-600">&times;</button>
                </span>
              )}
              {sourceTypeFilter !== 'all' && (
                <span className="inline-flex items-center gap-1 px-2 py-1 bg-indigo-100 text-indigo-700 text-xs rounded-full">
                  Type: {sourceTypeFilter}
                  <button onClick={() => { setSourceTypeFilter('all'); resetToFirstPage(); }} className="hover:text-red-600">&times;</button>
                </span>
              )}
              {instanceFilter !== 'all' && (
                <span className="inline-flex items-center gap-1 px-2 py-1 bg-teal-100 text-teal-700 text-xs rounded-full">
                  Instance: {availableInstances.find(i => i.id === instanceFilter)?.name || instanceFilter}
                  <button onClick={() => { setInstanceFilter('all'); resetToFirstPage(); }} className="hover:text-red-600">&times;</button>
                </span>
              )}
              {fantomVersionFilter !== 'all' && (
                <span className="inline-flex items-center gap-1 px-2 py-1 bg-orange-100 text-orange-700 text-xs rounded-full">
                  Fantom: {fantomVersionFilter}
                  <button onClick={() => { setFantomVersionFilter('all'); resetToFirstPage(); }} className="hover:text-red-600">&times;</button>
                </span>
              )}
              {instanceVersionFilter !== 'all' && (
                <span className="inline-flex items-center gap-1 px-2 py-1 bg-blue-100 text-blue-700 text-xs rounded-full">
                  Instance v{instanceVersionFilter}
                  <button onClick={() => { setInstanceVersionFilter('all'); resetToFirstPage(); }} className="hover:text-red-600">&times;</button>
                </span>
              )}
              {compatVersionFilter !== 'all' && (
                <span className="inline-flex items-center gap-1 px-2 py-1 bg-green-100 text-green-700 text-xs rounded-full">
                  Compat: {compatVersionFilter}
                  <button onClick={() => { setCompatVersionFilter('all'); resetToFirstPage(); }} className="hover:text-red-600">&times;</button>
                </span>
              )}
              {languageFilter !== 'all' && (
                <span className="inline-flex items-center gap-1 px-2 py-1 bg-purple-100 text-purple-700 text-xs rounded-full">
                  Language: {languageFilter}
                  <button onClick={() => { setLanguageFilter('all'); resetToFirstPage(); }} className="hover:text-red-600">&times;</button>
                </span>
              )}
              <button
                onClick={() => {
                  setSearchFilter('');
                  setSourceTypeFilter('all');
                  setInstanceFilter('all');
                  setFantomVersionFilter('all');
                  setInstanceVersionFilter('all');
                  setCompatVersionFilter('all');
                  setLanguageFilter('all');
                  resetToFirstPage();
                }}
                className="ml-auto text-xs text-red-600 hover:text-red-800 font-medium"
              >
                Clear All Filters
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Pods Grid */}
      {filteredPods.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-8 text-center">
          {searchFilter || sourceTypeFilter !== 'all' || instanceFilter !== 'all' || fantomVersionFilter !== 'all' || instanceVersionFilter !== 'all' || compatVersionFilter !== 'all' || languageFilter !== 'all' ? (
            <p className="text-gray-500">No pods match your filters</p>
          ) : (
            <>
              <svg
                className="w-16 h-16 mx-auto text-gray-400 mb-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                />
              </svg>
              <h3 className="text-lg font-medium text-gray-900 mb-2">
                No pods or projects found
              </h3>
              <p className="text-gray-500">
                Add entries in the Pods & Projects section or index source code to enable AST caching.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {paginatedPods.map((pod) => (
            <PodCard
              key={pod.podId}
              pod={pod}
              onViewDetails={onSelectPod}
              onCreateCache={handleCreateCache}
              isCreating={creatingPodId === pod.podId}
              onEmbedMissing={handleEmbedMissing}
              isEmbedding={embeddingProjectId === pod.projectId}
              onDelete={handleDeleteProject}
              isDeleting={deletingProjectId === pod.projectId}
              deleteError={deleteError && deleteError.projectId === pod.projectId ? deleteError.message : null}
            />
          ))}
        </div>
      )}

      {/* Pagination Controls */}
      {filteredPods.length > 0 && totalPages > 1 && (
        <div className="mt-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="text-sm text-gray-500">
            Showing {((currentPage - 1) * pageSize) + 1} - {Math.min(currentPage * pageSize, filteredPods.length)} of {filteredPods.length} pods
            {filteredPods.length !== stats.total && ` (filtered from ${stats.total})`}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCurrentPage(1)}
              disabled={currentPage === 1}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              First
            </button>
            <button
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Prev
            </button>
            <span className="px-4 py-1.5 text-sm font-medium">
              Page {currentPage} of {totalPages}
            </span>
            <button
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next
            </button>
            <button
              onClick={() => setCurrentPage(totalPages)}
              disabled={currentPage === totalPages}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Last
            </button>
          </div>
        </div>
      )}

      {/* Single page results count (when only one page) */}
      {filteredPods.length > 0 && totalPages === 1 && filteredPods.length !== stats.total && (
        <div className="mt-4 text-sm text-gray-500 text-center">
          Showing {filteredPods.length} of {stats.total} pods (filtered)
        </div>
      )}
    </div>
  );
}

// ============================================
// Detail View Component - Shows single pod AST data
// Helper: Get language from file path extension
function getLanguageFromFilePath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const extensionMap: Record<string, string> = {
    fan: 'fantom',
    // Functions stored in .trio files are axon function records (TrioParser
    // emits FantomFunction for each `func`+`src:` record). Treat as axon so
    // the AST viewer labels and counts them under the "axon" bucket.
    trio: 'axon',
    axon: 'axon',
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    vue: 'vue',
    dart: 'dart',
    py: 'python',
    java: 'java',
    kt: 'kotlin',
    go: 'go',
    rs: 'rust',
    html: 'html',
    css: 'css',
    scss: 'css',
    json: 'json',
    xml: 'xml',
    rb: 'ruby',
    php: 'php',
    swift: 'swift',
    cs: 'csharp',
    cpp: 'cpp',
    c: 'c',
    h: 'c',
    hpp: 'cpp',
  };
  return extensionMap[ext] || 'other';
}

// Language color configuration
const LANGUAGE_COLORS: Record<string, { bg: string; activeBg: string; text: string; badge: string }> = {
  fantom: { bg: 'bg-purple-50', activeBg: 'bg-purple-200', text: 'text-purple-700', badge: 'bg-purple-100' },
  axon:   { bg: 'bg-amber-50',  activeBg: 'bg-amber-200',  text: 'text-amber-800',  badge: 'bg-amber-100'  },
  trio:   { bg: 'bg-indigo-50', activeBg: 'bg-indigo-200', text: 'text-indigo-700', badge: 'bg-indigo-100' },
  typescript: { bg: 'bg-blue-50', activeBg: 'bg-blue-200', text: 'text-blue-700', badge: 'bg-blue-100' },
  javascript: { bg: 'bg-yellow-50', activeBg: 'bg-yellow-200', text: 'text-yellow-700', badge: 'bg-yellow-100' },
  python: { bg: 'bg-green-50', activeBg: 'bg-green-200', text: 'text-green-700', badge: 'bg-green-100' },
  dart: { bg: 'bg-cyan-50', activeBg: 'bg-cyan-200', text: 'text-cyan-700', badge: 'bg-cyan-100' },
  vue: { bg: 'bg-emerald-50', activeBg: 'bg-emerald-200', text: 'text-emerald-700', badge: 'bg-emerald-100' },
  polymer: { bg: 'bg-pink-50', activeBg: 'bg-pink-200', text: 'text-pink-700', badge: 'bg-pink-100' },
  java: { bg: 'bg-red-50', activeBg: 'bg-red-200', text: 'text-red-700', badge: 'bg-red-100' },
  go: { bg: 'bg-sky-50', activeBg: 'bg-sky-200', text: 'text-sky-700', badge: 'bg-sky-100' },
  rust: { bg: 'bg-orange-50', activeBg: 'bg-orange-200', text: 'text-orange-700', badge: 'bg-orange-100' },
  kotlin: { bg: 'bg-violet-50', activeBg: 'bg-violet-200', text: 'text-violet-700', badge: 'bg-violet-100' },
  html: { bg: 'bg-rose-50', activeBg: 'bg-rose-200', text: 'text-rose-700', badge: 'bg-rose-100' },
  css: { bg: 'bg-indigo-50', activeBg: 'bg-indigo-200', text: 'text-indigo-700', badge: 'bg-indigo-100' },
  other: { bg: 'bg-gray-50', activeBg: 'bg-gray-200', text: 'text-gray-700', badge: 'bg-gray-100' },
};

// ============================================
function AstDetailView({
  podId,
  onBack,
}: {
  podId: string;  // Stable ID format: {podName}-{minVersion}-{maxVersion}
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<'types' | 'functions' | 'languages'>('types');
  const [searchQuery, setSearchQuery] = useState('');
  const [languageFilter, setLanguageFilter] = useState<string>('all');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [compareToCurrent, setCompareToCurrent] = useState(false);

  // Time-travel anchor — kept in URL so it's shareable.
  const asOf = searchParams.get('asOf');
  const setAsOf = useCallback(
    (iso: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (iso) params.set('asOf', iso);
      else params.delete('asOf');
      const qs = params.toString();
      router.replace(qs ? `?${qs}` : '?', { scroll: false });
    },
    [router, searchParams],
  );

  // Fetch AST data for the pod
  const {
    data: astData,
    isLoading,
    error: fetchError,
    refetch,
  } = useQuery({
    queryKey: ['pod-ast', podId],
    queryFn: () => api.getPodAstData(podId),
  });

  // Fetch language breakdown for the pod
  const {
    data: languageData,
    isLoading: isLoadingLanguages,
  } = useQuery({
    queryKey: ['pod-languages', podId],
    queryFn: () => api.getLanguageBreakdown(podId),
    enabled: !!astData?.hasAstCache,
  });

  // Create AST cache mutation
  const createAstCacheMutation = useMutation({
    mutationFn: (id: string) => api.createPodAstCache(id),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['pod-ast', podId] });
      queryClient.invalidateQueries({ queryKey: ['pod-languages', podId] });
      queryClient.invalidateQueries({ queryKey: ['all-ast-cache'] });
      setSuccess(
        `AST cache created: ${result.indexResult?.functionsIndexed || 0} functions, ${result.indexResult?.typesIndexed || 0} types`
      );
      refetch();
      setTimeout(() => setSuccess(null), 5000);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to create AST cache');
      setTimeout(() => setError(null), 5000);
    },
  });

  // Reindex project mutation
  const reindexMutation = useMutation({
    mutationFn: (id: number) => api.reindexProject(id),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['pod-ast', podId] });
      queryClient.invalidateQueries({ queryKey: ['pod-languages', podId] });
      queryClient.invalidateQueries({ queryKey: ['all-ast-cache'] });
      const idx = result?.indexResult ?? { functionsIndexed: 0, typesIndexed: 0, filesProcessed: 0, errors: 0, duration: 0 };
      const fn = idx.functionsIndexed ?? 0;
      const ty = idx.typesIndexed ?? 0;
      const errs = idx.errors ?? 0;
      const dur = idx.duration ? `${(idx.duration / 1000).toFixed(2)}s` : '?';
      const noChange = result?.noChange === true;
      if (errs > 0) {
        setError(`Reindex completed with ${errs} errors: ${fn} functions, ${ty} types (${dur}). Check server log for details.`);
        setTimeout(() => setError(null), 12000);
      } else if (noChange) {
        // Hash-gate skipped re-parse — index is already current. Use the
        // force-reindex variant if the user wants to bypass this.
        setSuccess(`Index is up to date — no source files changed since last run. Use "Force Reindex" to bypass the hash-gate.`);
        setTimeout(() => setSuccess(null), 6000);
      } else if (fn === 0 && ty === 0) {
        setError(`Reindex produced 0 functions / 0 types — parser may have failed. Check server log.`);
        setTimeout(() => setError(null), 12000);
      } else {
        setSuccess(`Reindexed: ${fn} functions, ${ty} types in ${dur}`);
        setTimeout(() => setSuccess(null), 5000);
      }
      refetch();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to reindex');
      setTimeout(() => setError(null), 8000);
    },
  });

  // State for dynamically extracted functions from tree-sitter
  const [extractedFunctions, setExtractedFunctions] = useState<ExtractedFunctionItem[]>([]);
  const [isExtractingFunctions, setIsExtractingFunctions] = useState(false);
  const [extractedLanguage, setExtractedLanguage] = useState<string | null>(null);

  // Extract functions mutation
  const extractFunctionsMutation = useMutation({
    mutationFn: ({ projectPath, languages }: { projectPath: string; languages: string[] }) =>
      api.extractFunctions(projectPath, languages),
    onSuccess: (result) => {
      setExtractedFunctions(result.functions);
      setExtractedLanguage(languageFilter !== 'all' ? languageFilter : 'all');
      setSuccess(
        `Extracted ${result.functions.length} items from ${result.filesProcessed} files`
      );
      setIsExtractingFunctions(false);
      setTimeout(() => setSuccess(null), 5000);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to extract functions');
      setIsExtractingFunctions(false);
      setTimeout(() => setError(null), 5000);
    },
  });

  // Handle extracting functions for selected language
  const handleExtractFunctions = useCallback(() => {
    if (!astData?.podPath) return;

    const languages = languageFilter !== 'all' ? [languageFilter] : [];
    if (languages.length === 0) {
      setError('Please select a specific language to extract functions');
      setTimeout(() => setError(null), 3000);
      return;
    }

    setIsExtractingFunctions(true);
    setExtractedFunctions([]);
    extractFunctionsMutation.mutate({ projectPath: astData.podPath, languages });
  }, [astData?.podPath, languageFilter, extractFunctionsMutation]);

  // Clear extracted functions when language filter changes
  const handleLanguageFilterChange = useCallback((newFilter: string) => {
    setLanguageFilter(newFilter);
    // Clear extracted functions if the filter changes
    if (extractedLanguage && newFilter !== extractedLanguage) {
      setExtractedFunctions([]);
      setExtractedLanguage(null);
    }
  }, [extractedLanguage]);

  // Filter types based on search query AND language
  const filteredTypes = useCallback(
    (types: AstType[] | undefined) => {
      if (!types) return [];
      let result = types;

      // Filter by language
      if (languageFilter !== 'all') {
        result = result.filter(t => getLanguageFromFilePath(t.filePath) === languageFilter);
      }

      // Filter by search
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        result = result.filter(
          (t) =>
            t.name.toLowerCase().includes(query) ||
            t.qualifiedName.toLowerCase().includes(query) ||
            t.documentation?.toLowerCase().includes(query)
        );
      }

      return result;
    },
    [searchQuery, languageFilter]
  );

  // Filter functions based on search query AND language
  const filteredFunctions = useCallback(
    (functions: AstFunction[] | undefined) => {
      if (!functions) return [];
      let result = functions;

      // Filter by language
      if (languageFilter !== 'all') {
        result = result.filter(f => getLanguageFromFilePath(f.filePath) === languageFilter);
      }

      // Filter by search
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        result = result.filter(
          (f) =>
            f.name.toLowerCase().includes(query) ||
            f.qualifiedName.toLowerCase().includes(query) ||
            f.className?.toLowerCase().includes(query) ||
            f.description?.toLowerCase().includes(query)
        );
      }

      return result;
    },
    [searchQuery, languageFilter]
  );

  const handleCreateAstCache = () => {
    createAstCacheMutation.mutate(podId);
  };

  const handleReindex = () => {
    if (astData?.projectId) {
      reindexMutation.mutate(astData.projectId);
    }
  };

  // Get kind badge color
  const getKindColor = (kind: string) => {
    switch (kind) {
      case 'class':
        return 'bg-blue-100 text-blue-700';
      case 'mixin':
        return 'bg-purple-100 text-purple-700';
      case 'enum':
        return 'bg-green-100 text-green-700';
      case 'facet':
        return 'bg-yellow-100 text-yellow-700';
      default:
        return 'bg-gray-100 text-gray-700';
    }
  };

  // Get function type badge color
  const getFunctionTypeColor = (type: string) => {
    switch (type) {
      case 'method':
        return 'bg-purple-100 text-purple-700';
      case 'field':
        return 'bg-blue-100 text-blue-700';
      case 'constructor':
        return 'bg-green-100 text-green-700';
      default:
        return 'bg-gray-100 text-gray-700';
    }
  };

  // Get category badge color
  const getCategoryColor = (category: string) => {
    const colors: Record<string, string> = {
      public: 'bg-green-50 text-green-700',
      private: 'bg-red-50 text-red-700',
      protected: 'bg-yellow-50 text-yellow-700',
      internal: 'bg-orange-50 text-orange-700',
    };
    return colors[category?.toLowerCase()] || 'bg-gray-100 text-gray-700';
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center space-y-4">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600"></div>
          <div className="text-gray-500">Loading AST data...</div>
        </div>
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <h2 className="text-red-800 font-medium">Error loading AST data</h2>
        <p className="text-red-600 mt-1">
          {fetchError instanceof Error ? fetchError.message : 'Unknown error'}
        </p>
        <button
          onClick={onBack}
          className="mt-4 px-4 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 transition-colors"
        >
          Back to Overview
        </button>
      </div>
    );
  }

  const types = filteredTypes(astData?.types);
  const functions = filteredFunctions(astData?.functions);

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-4 mb-2">
          <button
            onClick={onBack}
            className="p-2 hover:bg-gray-200 rounded-lg transition-colors"
            title="Back to Overview"
          >
            <svg
              className="w-5 h-5 text-gray-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 19l-7-7m0 0l7-7m-7 7h18"
              />
            </svg>
          </button>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              AST Viewer: {astData?.podName || 'Unknown Pod'}
            </h1>
            <p className="text-gray-600 font-mono text-sm mt-1">
              {astData?.podPath || 'No path available'}
            </p>
          </div>
        </div>
      </div>

      {/* AST + Vector progress for this project */}
      <ProgressStrip projectId={astData?.projectId ?? null} />

      {/* Time-travel: pick a moment, see the project as it was then */}
      {astData?.projectId ? (
        <TimelineSection
          projectId={astData.projectId}
          atTime={asOf}
          onChange={setAsOf}
          compareToCurrent={compareToCurrent}
          onCompareToggle={setCompareToCurrent}
        />
      ) : null}

      {/* Status messages */}
      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-800">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg text-green-800">
          {success}
        </div>
      )}

      {/* No AST Cache */}
      {!astData?.hasAstCache ? (
        <div className="bg-white rounded-lg shadow p-8">
          <div className="flex flex-col items-center justify-center space-y-4">
            <svg
              className="w-20 h-20 text-gray-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
              />
            </svg>
            <h3 className="text-lg font-medium text-gray-900">No AST Cache Found</h3>
            <p className="text-gray-500 text-center max-w-md">
              {astData?.message ||
                'No AST cache exists for this pod. Create a code project to enable AST parsing and indexing.'}
            </p>
            <button
              onClick={handleCreateAstCache}
              disabled={createAstCacheMutation.isPending}
              className="px-6 py-3 bg-purple-600 text-white rounded-md hover:bg-purple-700 disabled:opacity-50 transition-colors"
            >
              {createAstCacheMutation.isPending ? 'Creating AST Cache...' : 'Create AST Cache'}
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Summary Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div className="bg-white rounded-lg shadow p-4">
              <div className="text-sm text-blue-600 font-medium">Types</div>
              <div className="text-2xl font-bold text-blue-800">
                {astData.summary?.totalTypes || 0}
              </div>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <div className="text-sm text-purple-600 font-medium">Functions</div>
              <div className="text-2xl font-bold text-purple-800">
                {astData.summary?.totalFunctions || 0}
              </div>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <div className="text-sm text-green-600 font-medium">Classes</div>
              <div className="text-2xl font-bold text-green-800">
                {astData.summary?.totalClasses || 0}
              </div>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <div className="text-sm text-gray-600 font-medium">Last Indexed</div>
              <div className="text-lg font-semibold text-gray-800">
                {astData.lastIndexed
                  ? new Date(astData.lastIndexed).toLocaleDateString()
                  : 'Never'}
              </div>
              {astData.lastIndexed && (
                <div className="text-xs text-gray-500">
                  {new Date(astData.lastIndexed).toLocaleTimeString()}
                </div>
              )}
            </div>
          </div>

          {/* Language Breakdown - shown when multiple languages detected */}
          {languageData && languageData.languages.length > 0 && (
            <div className="mb-6 bg-white rounded-lg shadow p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-gray-700">
                  Languages in Project
                  {languageData.languages.length > 1 && (
                    <span className="ml-2 text-xs text-gray-500">
                      ({languageData.languages.length} languages, {languageData.totalFiles} files)
                    </span>
                  )}
                </h3>
                {languageData.parserType && (
                  <span className={`px-2 py-1 text-xs rounded ${
                    languageData.parserType === 'tree-sitter-wasm' || languageData.parserType === 'tree-sitter'
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-slate-100 text-slate-600'
                  }`}>
                    {languageData.parserType === 'tree-sitter-wasm' || languageData.parserType === 'tree-sitter'
                      ? 'Tree-sitter'
                      : 'Regex'} Parser
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-2 mb-3">
                {/* All languages button */}
                <button
                  onClick={() => handleLanguageFilterChange('all')}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    languageFilter === 'all'
                      ? 'bg-gray-800 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  All ({languageData.totalFunctions + languageData.totalTypes})
                </button>
                {/* Per-language buttons */}
                {languageData.languages.map((lang) => {
                  const colors = LANGUAGE_COLORS[lang.language] || LANGUAGE_COLORS.other;
                  const isActive = languageFilter === lang.language;
                  return (
                    <button
                      key={lang.language}
                      onClick={() => handleLanguageFilterChange(isActive ? 'all' : lang.language)}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                        isActive ? colors.activeBg : colors.bg
                      } ${colors.text} hover:opacity-80 ${isActive ? 'ring-2 ring-offset-1 ring-purple-400' : ''}`}
                    >
                      {lang.language.charAt(0).toUpperCase() + lang.language.slice(1)}
                      <span className="ml-1.5 opacity-75">
                        ({lang.fileCount} {lang.fileCount === 1 ? 'file' : 'files'})
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Language details when filtered */}
              {languageFilter !== 'all' && (
                <div className="mt-3 pt-3 border-t border-gray-100">
                  {(() => {
                    const selectedLang = languageData.languages.find(l => l.language === languageFilter);
                    if (!selectedLang) return null;
                    const colors = LANGUAGE_COLORS[selectedLang.language] || LANGUAGE_COLORS.other;
                    return (
                      <div className={`p-3 rounded-lg ${colors.bg}`}>
                        <div className="flex items-center justify-between mb-2">
                          <span className={`font-medium ${colors.text}`}>
                            {selectedLang.language.charAt(0).toUpperCase() + selectedLang.language.slice(1)} Files
                          </span>
                          <div className="flex gap-3 text-sm">
                            <span className={colors.text}>
                              {selectedLang.functionCount} functions
                            </span>
                            <span className={colors.text}>
                              {selectedLang.typeCount} types
                            </span>
                          </div>
                        </div>
                        {/* Sample files */}
                        {selectedLang.sampleFiles.length > 0 && (
                          <div className="mt-2">
                            <div className="text-xs text-gray-500 mb-1">Sample files:</div>
                            <div className="flex flex-wrap gap-1">
                              {selectedLang.sampleFiles.map((file, idx) => (
                                <span
                                  key={idx}
                                  className="text-xs font-mono bg-white bg-opacity-50 px-2 py-0.5 rounded"
                                  title={file}
                                >
                                  {file.split('/').pop()}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                        {/* Sample code */}
                        {selectedLang.sampleCode && (
                          <div className="mt-2">
                            <div className="text-xs text-gray-500 mb-1">Sample signature:</div>
                            <code className="text-xs font-mono bg-white bg-opacity-50 px-2 py-1 rounded block overflow-x-auto">
                              {selectedLang.sampleCode}
                            </code>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          )}

          {/* Search and Actions */}
          <div className="bg-white rounded-lg shadow p-4 mb-6">
            <div className="flex flex-col md:flex-row gap-4">
              <div className="flex-1">
                <input
                  type="text"
                  placeholder={languageFilter !== 'all'
                    ? `Search ${languageFilter} types and functions...`
                    : 'Search types and functions...'}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleReindex}
                  disabled={reindexMutation.isPending || !astData.projectId}
                  className="px-4 py-2 bg-emerald-600 text-white rounded-md hover:bg-emerald-700 disabled:opacity-50 transition-colors"
                  title="Resume indexing this pod — skips files unchanged since last run (hash-gated)."
                >
                  {reindexMutation.isPending ? 'Resuming...' : 'Resume Index'}
                </button>
                <button
                  onClick={handleReindex}
                  disabled={reindexMutation.isPending || !astData.projectId}
                  className="px-4 py-2 bg-yellow-600 text-white rounded-md hover:bg-yellow-700 disabled:opacity-50 transition-colors"
                >
                  {reindexMutation.isPending ? 'Reindexing...' : 'Reindex'}
                </button>
                <button
                  onClick={handleCreateAstCache}
                  disabled={createAstCacheMutation.isPending}
                  className="px-4 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 disabled:opacity-50 transition-colors"
                >
                  {createAstCacheMutation.isPending ? 'Creating...' : 'Rebuild Cache'}
                </button>
              </div>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex gap-2 mb-4">
            <button
              onClick={() => setActiveTab('types')}
              className={`px-6 py-3 rounded-lg font-medium transition-colors ${
                activeTab === 'types'
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-gray-700 hover:bg-gray-50 shadow'
              }`}
            >
              Types ({types.length}
              {languageFilter !== 'all' && astData.types && types.length !== astData.types.length && (
                <span className="opacity-75">/{astData.types.length}</span>
              )})
            </button>
            <button
              onClick={() => setActiveTab('functions')}
              className={`px-6 py-3 rounded-lg font-medium transition-colors ${
                activeTab === 'functions'
                  ? 'bg-purple-600 text-white'
                  : 'bg-white text-gray-700 hover:bg-gray-50 shadow'
              }`}
            >
              Functions ({functions.length}
              {languageFilter !== 'all' && astData.functions && functions.length !== astData.functions.length && (
                <span className="opacity-75">/{astData.functions.length}</span>
              )})
            </button>
            {languageData && languageData.languages.length > 1 && (
              <button
                onClick={() => setActiveTab('languages')}
                className={`px-6 py-3 rounded-lg font-medium transition-colors ${
                  activeTab === 'languages'
                    ? 'bg-emerald-600 text-white'
                    : 'bg-white text-gray-700 hover:bg-gray-50 shadow'
                }`}
              >
                Languages ({languageData.languages.length})
              </button>
            )}
          </div>

          {/* Content based on active tab */}
          <div className="space-y-4">
            {activeTab === 'types' && (
              <>
                {types.length === 0 ? (
                  <div className="bg-white rounded-lg shadow p-8 text-center">
                    <p className="text-gray-500">
                      {searchQuery || languageFilter !== 'all' ? 'No types match your filters' : 'No types found'}
                    </p>
                  </div>
                ) : (
                  types.map((type) => (
                    <div
                      key={type.id}
                      className="bg-white rounded-lg shadow p-4 hover:shadow-md transition-shadow"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          {/* Header */}
                          <div className="flex items-center gap-2 mb-2 flex-wrap">
                            <span
                              className={`px-2 py-1 rounded text-xs font-medium ${getKindColor(
                                type.kind
                              )}`}
                            >
                              {type.kind}
                            </span>
                            {/* Language badge */}
                            {(() => {
                              const lang = getLanguageFromFilePath(type.filePath);
                              const colors = LANGUAGE_COLORS[lang] || LANGUAGE_COLORS.other;
                              return (
                                <span className={`px-1.5 py-0.5 text-xs rounded ${colors.badge} ${colors.text}`}>
                                  {lang}
                                </span>
                              );
                            })()}
                            <span className="text-lg font-semibold text-gray-900">
                              {type.name}
                            </span>
                            {type.isPublic && (
                              <span className="px-2 py-0.5 text-xs bg-green-50 text-green-600 rounded">
                                public
                              </span>
                            )}
                            {type.isAbstract && (
                              <span className="px-2 py-0.5 text-xs bg-orange-50 text-orange-600 rounded">
                                abstract
                              </span>
                            )}
                          </div>

                          {/* Qualified Name */}
                          <div className="text-sm text-gray-500 font-mono mb-2">
                            {type.qualifiedName}
                          </div>

                          {/* Extends and Mixins */}
                          <div className="flex flex-wrap gap-4 mb-2 text-sm">
                            {type.extends && (
                              <div className="text-gray-600">
                                <span className="text-gray-400">extends</span>{' '}
                                <span className="font-mono font-medium">{type.extends}</span>
                              </div>
                            )}
                            {type.mixins && type.mixins.length > 0 && (
                              <div className="text-gray-600">
                                <span className="text-gray-400">mixins</span>{' '}
                                <span className="font-mono font-medium">
                                  {type.mixins.join(', ')}
                                </span>
                              </div>
                            )}
                          </div>

                          {/* Method and Field counts */}
                          <div className="flex gap-4 text-sm text-gray-600 mb-2">
                            <span className="flex items-center gap-1">
                              <svg
                                className="w-4 h-4"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M4 6h16M4 10h16M4 14h16M4 18h16"
                                />
                              </svg>
                              {type.methodCount} methods
                            </span>
                            <span className="flex items-center gap-1">
                              <svg
                                className="w-4 h-4"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"
                                />
                              </svg>
                              {type.fieldCount} fields
                            </span>
                          </div>

                          {/* File location */}
                          <div className="text-xs text-gray-400 font-mono">
                            {type.filePath.split('/').pop()}
                            {type.lineNumber ? `:${type.lineNumber}` : ''}
                          </div>

                          {/* Documentation preview */}
                          {type.documentation && (
                            <div className="mt-3 p-3 bg-gray-50 rounded-lg text-sm text-gray-600">
                              {type.documentation.substring(0, 300)}
                              {type.documentation.length > 300 && '...'}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </>
            )}

            {activeTab === 'functions' && (
              <>
                {/* Extract Functions Button - Show when a specific language is selected and no cached functions */}
                {languageFilter !== 'all' && functions.length === 0 && extractedFunctions.length === 0 && (
                  <div className="bg-white rounded-lg shadow p-6 mb-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="font-medium text-gray-900">
                          No indexed functions for {languageFilter}
                        </h3>
                        <p className="text-sm text-gray-500 mt-1">
                          Use tree-sitter to parse and extract functions from {languageFilter} files in this project.
                        </p>
                      </div>
                      <button
                        onClick={handleExtractFunctions}
                        disabled={isExtractingFunctions}
                        className="px-4 py-2 bg-emerald-600 text-white rounded-md hover:bg-emerald-700 disabled:opacity-50 transition-colors flex items-center gap-2"
                      >
                        {isExtractingFunctions ? (
                          <>
                            <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
                            Extracting...
                          </>
                        ) : (
                          <>
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                            </svg>
                            Extract {languageFilter.charAt(0).toUpperCase() + languageFilter.slice(1)} Functions
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                )}

                {/* Loading state for extraction */}
                {isExtractingFunctions && (
                  <div className="bg-white rounded-lg shadow p-8 text-center">
                    <div className="flex flex-col items-center space-y-4">
                      <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-600"></div>
                      <p className="text-gray-500">Parsing {languageFilter} files with tree-sitter...</p>
                    </div>
                  </div>
                )}

                {/* Display extracted functions from tree-sitter */}
                {!isExtractingFunctions && extractedFunctions.length > 0 && extractedLanguage === languageFilter && (
                  <>
                    <div className="bg-emerald-50 rounded-lg p-3 mb-4 flex items-center justify-between">
                      <div className="flex items-center gap-2 text-emerald-700">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <span className="font-medium">
                          Extracted {extractedFunctions.length} items using tree-sitter
                        </span>
                      </div>
                      <button
                        onClick={() => { setExtractedFunctions([]); setExtractedLanguage(null); }}
                        className="text-sm text-emerald-600 hover:text-emerald-800"
                      >
                        Clear
                      </button>
                    </div>

                    {/* Group extracted functions by file */}
                    {(() => {
                      const byFile = new Map<string, ExtractedFunctionItem[]>();
                      const filtered = searchQuery
                        ? extractedFunctions.filter(f =>
                            f.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                            f.qualifiedName.toLowerCase().includes(searchQuery.toLowerCase()) ||
                            (f.signature?.toLowerCase().includes(searchQuery.toLowerCase()))
                          )
                        : extractedFunctions;

                      for (const fn of filtered) {
                        const existing = byFile.get(fn.filePath) || [];
                        existing.push(fn);
                        byFile.set(fn.filePath, existing);
                      }

                      return Array.from(byFile.entries()).map(([filePath, fileFunctions]) => {
                        const fileName = filePath.split('/').pop() || filePath;
                        const colors = LANGUAGE_COLORS[languageFilter] || LANGUAGE_COLORS.other;

                        return (
                          <div key={filePath} className="bg-white rounded-lg shadow mb-4 overflow-hidden">
                            <div className={`px-4 py-2 ${colors.bg} border-b flex items-center justify-between`}>
                              <div className="flex items-center gap-2">
                                <span className={`font-mono text-sm font-medium ${colors.text}`}>{fileName}</span>
                                <span className="text-xs text-gray-500">({fileFunctions.length} items)</span>
                              </div>
                              <span className="text-xs font-mono text-gray-400" title={filePath}>
                                ...{filePath.slice(-50)}
                              </span>
                            </div>
                            <div className="divide-y divide-gray-100">
                              {fileFunctions.map((fn, idx) => (
                                <div key={`${fn.qualifiedName}-${idx}`} className="px-4 py-3 hover:bg-gray-50">
                                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                                      fn.type === 'class' ? 'bg-blue-100 text-blue-700' :
                                      fn.type === 'interface' ? 'bg-purple-100 text-purple-700' :
                                      fn.type === 'method' ? 'bg-green-100 text-green-700' :
                                      'bg-gray-100 text-gray-700'
                                    }`}>
                                      {fn.type}
                                    </span>
                                    <span className="font-semibold text-gray-900">{fn.name}</span>
                                    <span className="text-xs text-gray-400 font-mono">line {fn.lineStart}</span>
                                  </div>
                                  {fn.signature && (
                                    <div className="text-sm font-mono text-gray-600 bg-gray-50 px-2 py-1 rounded overflow-x-auto">
                                      {fn.signature}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </>
                )}

                {/* Display cached functions (original behavior) */}
                {!isExtractingFunctions && (functions.length > 0 || (extractedFunctions.length === 0 && !isExtractingFunctions && languageFilter === 'all')) && (
                  <>
                    {functions.length === 0 ? (
                      <div className="bg-white rounded-lg shadow p-8 text-center">
                        <p className="text-gray-500">
                          {searchQuery || languageFilter !== 'all' ? 'No functions match your filters' : 'No functions found'}
                        </p>
                      </div>
                    ) : (
                      functions.map((func) => (
                        <div
                          key={func.id}
                          className="bg-white rounded-lg shadow p-4 hover:shadow-md transition-shadow"
                        >
                          <div className="flex items-start justify-between">
                            <div className="flex-1">
                              {/* Header */}
                              <div className="flex items-center gap-2 mb-2 flex-wrap">
                                <span
                                  className={`px-2 py-1 rounded text-xs font-medium ${getFunctionTypeColor(
                                    func.type
                                  )}`}
                                >
                                  {func.type}
                                </span>
                                {/* Language badge */}
                                {(() => {
                                  const lang = getLanguageFromFilePath(func.filePath);
                                  const colors = LANGUAGE_COLORS[lang] || LANGUAGE_COLORS.other;
                                  return (
                                    <span className={`px-1.5 py-0.5 text-xs rounded ${colors.badge} ${colors.text}`}>
                                      {lang}
                                    </span>
                                  );
                                })()}
                                <span className="text-lg font-semibold text-gray-900">
                                  {func.name}
                                </span>
                                {func.isPublic && (
                                  <span className="px-2 py-0.5 text-xs bg-green-50 text-green-600 rounded">
                                    public
                                  </span>
                                )}
                                {func.isStatic && (
                                  <span className="px-2 py-0.5 text-xs bg-blue-50 text-blue-600 rounded">
                                    static
                                  </span>
                                )}
                                {func.isAbstract && (
                                  <span className="px-2 py-0.5 text-xs bg-orange-50 text-orange-600 rounded">
                                    abstract
                                  </span>
                                )}
                              </div>

                              {/* Class it belongs to */}
                              {func.className && (
                                <div className="text-sm text-gray-600 mb-2">
                                  <span className="text-gray-400">in class</span>{' '}
                                  <span className="font-mono font-medium">{func.className}</span>
                                </div>
                              )}

                              {/* Signature */}
                              {func.signature && (
                                <div className="text-sm text-gray-700 font-mono bg-gray-50 p-2 rounded mb-2 overflow-x-auto">
                                  {func.signature}
                                </div>
                              )}

                              {/* Return type and parameters */}
                              <div className="flex flex-wrap gap-4 mb-2 text-sm">
                                {func.returnType && (
                                  <div className="text-gray-600">
                                    <span className="text-gray-400">returns</span>{' '}
                                    <span className="font-mono font-medium">{func.returnType}</span>
                                  </div>
                                )}
                                {func.parameters && func.parameters.length > 0 && (
                                  <div className="text-gray-600">
                                    <span className="text-gray-400">params</span>{' '}
                                    <span className="font-mono">
                                      {func.parameters
                                        .map(
                                          (p) =>
                                            `${p.type} ${p.name}${p.defaultValue ? ` = ${p.defaultValue}` : ''}`
                                        )
                                        .join(', ')}
                                    </span>
                                  </div>
                                )}
                              </div>

                              {/* Category badge and file location */}
                              <div className="flex items-center gap-4 text-xs">
                                {func.category && (
                                  <span
                                    className={`px-2 py-1 rounded ${getCategoryColor(func.category)}`}
                                  >
                                    {func.category}
                                  </span>
                                )}
                                <span className="text-gray-400 font-mono">
                                  {func.filePath.split('/').pop()}
                                  {func.lineNumber ? `:${func.lineNumber}` : ''}
                                </span>
                              </div>

                              {/* Description */}
                              {func.description && (
                                <div className="mt-3 p-3 bg-gray-50 rounded-lg text-sm text-gray-600">
                                  {func.description.substring(0, 300)}
                                  {func.description.length > 300 && '...'}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </>
                )}
              </>
            )}

            {/* Languages Tab */}
            {activeTab === 'languages' && languageData && (
              <div className="space-y-4">
                {languageData.languages.length === 0 ? (
                  <div className="bg-white rounded-lg shadow p-8 text-center">
                    <p className="text-gray-500">No language data available</p>
                  </div>
                ) : (
                  <>
                    {/* Summary */}
                    <div className="bg-white rounded-lg shadow p-4">
                      <h3 className="font-medium text-gray-900 mb-3">Project Language Summary</h3>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div className="text-center p-3 bg-gray-50 rounded-lg">
                          <div className="text-2xl font-bold text-gray-700">{languageData.totalFiles}</div>
                          <div className="text-sm text-gray-500">Total Files</div>
                        </div>
                        <div className="text-center p-3 bg-gray-50 rounded-lg">
                          <div className="text-2xl font-bold text-gray-700">{languageData.languages.length}</div>
                          <div className="text-sm text-gray-500">Languages</div>
                        </div>
                        <div className="text-center p-3 bg-gray-50 rounded-lg">
                          <div className="text-2xl font-bold text-gray-700">{languageData.totalFunctions}</div>
                          <div className="text-sm text-gray-500">Functions</div>
                        </div>
                        <div className="text-center p-3 bg-gray-50 rounded-lg">
                          <div className="text-2xl font-bold text-gray-700">{languageData.totalTypes}</div>
                          <div className="text-sm text-gray-500">Types</div>
                        </div>
                      </div>
                    </div>

                    {/* Per-language breakdown */}
                    {languageData.languages.map((lang) => {
                      const colors = LANGUAGE_COLORS[lang.language] || LANGUAGE_COLORS.other;
                      return (
                        <div
                          key={lang.language}
                          className="bg-white rounded-lg shadow p-4 hover:shadow-md transition-shadow"
                        >
                          <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-3">
                              <span className={`px-3 py-1.5 rounded-lg font-medium ${colors.badge} ${colors.text}`}>
                                {lang.language.charAt(0).toUpperCase() + lang.language.slice(1)}
                              </span>
                              <span className="text-gray-600">
                                {lang.fileCount} {lang.fileCount === 1 ? 'file' : 'files'}
                              </span>
                            </div>
                            <button
                              onClick={() => {
                                handleLanguageFilterChange(lang.language);
                                setActiveTab('functions');
                              }}
                              className="px-3 py-1 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors"
                            >
                              View Functions
                            </button>
                          </div>

                          <div className="grid grid-cols-2 gap-4 mb-3">
                            <div className={`p-3 rounded-lg ${colors.bg}`}>
                              <div className={`text-xl font-bold ${colors.text}`}>{lang.functionCount}</div>
                              <div className="text-sm text-gray-600">Functions</div>
                            </div>
                            <div className={`p-3 rounded-lg ${colors.bg}`}>
                              <div className={`text-xl font-bold ${colors.text}`}>{lang.typeCount}</div>
                              <div className="text-sm text-gray-600">Types</div>
                            </div>
                          </div>

                          {/* Sample files */}
                          {lang.sampleFiles.length > 0 && (
                            <div className="mb-3">
                              <div className="text-xs text-gray-500 mb-1">Sample files:</div>
                              <div className="flex flex-wrap gap-2">
                                {lang.sampleFiles.map((file, idx) => (
                                  <span
                                    key={idx}
                                    className="text-xs font-mono bg-gray-100 px-2 py-1 rounded"
                                    title={file}
                                  >
                                    {file.split('/').pop()}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Sample code */}
                          {lang.sampleCode && (
                            <div>
                              <div className="text-xs text-gray-500 mb-1">Sample signature:</div>
                              <code className={`text-sm font-mono ${colors.bg} px-3 py-2 rounded block overflow-x-auto`}>
                                {lang.sampleCode}
                              </code>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            )}
          </div>

          {/* Results count */}
          <div className="mt-4 text-sm text-gray-500 text-center">
            {activeTab === 'languages' ? (
              `Showing ${languageData?.languages.length || 0} languages`
            ) : (
              <>
                Showing {activeTab === 'types' ? types.length : functions.length} of{' '}
                {activeTab === 'types'
                  ? astData.types?.length || 0
                  : astData.functions?.length || 0}{' '}
                {activeTab}
                {(searchQuery || languageFilter !== 'all') && ' (filtered)'}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ============================================
// Main Component with routing logic
// ============================================
function AstViewerContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  // Get podId as string (supports stable ID format: podName-minVersion-maxVersion)
  const podId = searchParams.get('podId');

  const handleSelectPod = (selectedPodId: string) => {
    router.push(`/ast-viewer?podId=${encodeURIComponent(selectedPodId)}`);
  };

  const handleBack = () => {
    router.push('/ast-viewer');
  };

  // If podId is specified, show detail view
  if (podId) {
    return <AstDetailView podId={podId} onBack={handleBack} />;
  }

  // Otherwise show overview
  return <AstOverview onSelectPod={handleSelectPod} />;
}

export default function AstViewerPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-64">
          <div className="flex flex-col items-center space-y-4">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600"></div>
            <div className="text-gray-500">Loading...</div>
          </div>
        </div>
      }
    >
      <AstViewerContent />
    </Suspense>
  );
}
