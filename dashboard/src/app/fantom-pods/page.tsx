'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, FantomPod, FantomPodWithInstance, CreatePodInput, FantomInstance } from '@/lib/api';
import { ProjectsSidebar, ProjectsSidebarEntry } from '@/components/ProjectsSidebar';
import { DependencyCounts, ProjectDependenciesPanel } from '@/components/ProjectDependenciesPanel';

/** Normalise a filesystem path the same way the server's dependency summary does (no trailing slash). */
function normPathKey(p: string): string {
  return p.replace(/\/+$/, '');
}

// Group pods by instance type/version
interface PodGroup {
  key: string;
  label: string;
  instanceId?: number;
  instanceType?: string;
  instanceVersion?: string;
  pods: FantomPodWithInstance[];
}

function groupPodsByInstance(pods: FantomPodWithInstance[], instances: FantomInstance[]): PodGroup[] {
  const groups: Map<string, PodGroup> = new Map();

  for (const pod of pods) {
    let key: string;
    let label: string;
    let instanceId: number | undefined;
    let instanceType: string | undefined;
    let instanceVersion: string | undefined;

    if (pod.instance) {
      const version = pod.instance.version || 'unknown';
      key = `${pod.instance.type}-${version}-${pod.instance.id}`;
      label = `${pod.instance.name} (${pod.instance.type} ${version})`;
      instanceId = pod.instance.id;
      instanceType = pod.instance.type;
      instanceVersion = pod.instance.version;
    } else {
      key = 'unassigned';
      label = 'Unassigned Pods';
    }

    if (!groups.has(key)) {
      groups.set(key, { key, label, instanceId, instanceType, instanceVersion, pods: [] });
    }
    groups.get(key)!.pods.push(pod);
  }

  // Sort groups: assigned instances first (sorted by type then version), unassigned last
  return Array.from(groups.values()).sort((a, b) => {
    if (a.key === 'unassigned') return 1;
    if (b.key === 'unassigned') return -1;
    // Sort by type, then version
    if (a.instanceType !== b.instanceType) {
      return (a.instanceType || '').localeCompare(b.instanceType || '');
    }
    return (a.instanceVersion || '').localeCompare(b.instanceVersion || '');
  });
}

export default function FantomPodsPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingPod, setEditingPod] = useState<FantomPod | null>(null);
  const [selectedPodForCompile, setSelectedPodForCompile] = useState<FantomPod | null>(null);
  const [selectedPodForLogs, setSelectedPodForLogs] = useState<FantomPod | null>(null);
  const [filterInstanceId, setFilterInstanceId] = useState<number | 'all' | 'unassigned'>('all');
  const [filterVersion, setFilterVersion] = useState<string>('all');
  const [formData, setFormData] = useState<CreatePodInput>({
    name: '',
    path: '',
    buildFile: 'build.fan',
    description: '',
    defaultInstanceId: undefined,
    compatMinVersion: '',
    compatMaxVersion: '',
    compatVersions: [],
  });
  const [versionTagInput, setVersionTagInput] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [compileOutput, setCompileOutput] = useState<string | null>(null);
  // Project dependencies (ask scope): which pod/project row has its panel expanded.
  const [expandedDepsProject, setExpandedDepsProject] = useState<number | null>(null);

  // Per-project dependency counts (↑ depends on / ↓ used by) + path → projectId map for pod rows
  const { data: depSummary } = useQuery({
    queryKey: ['project-dependency-summary'],
    queryFn: api.getProjectDependencySummary,
    staleTime: 30_000,
  });
  const projectIdForPod = (pod: FantomPod): number | undefined =>
    depSummary?.byPath?.[normPathKey(pod.path)] ??
    depSummary?.projects?.find(p => p.podName === pod.name)?.id;

  const rebuildAllDepsMutation = useMutation({
    mutationFn: () => api.rebuildAllProjectDependencies(),
    onSuccess: (r) => {
      const kinds = Object.entries(r.kinds).map(([k, v]) => `${k} ${v}`).join(', ');
      setSuccess(`Dependencies rebuilt for ${r.projects} projects: +${r.added} ~${r.updated} -${r.removed}${kinds ? ` (${kinds})` : ''} in ${(r.durationMs / 1000).toFixed(1)} s${r.failed ? ` — ${r.failed} failed` : ''}`);
      queryClient.invalidateQueries({ queryKey: ['project-dependency-summary'] });
      queryClient.invalidateQueries({ queryKey: ['project-dependencies'] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to rebuild dependencies'),
  });

  // Fetch pods with instance info
  const { data: podsData, isLoading } = useQuery({
    queryKey: ['fantom-pods', 'with-instance'],
    queryFn: () => api.getFantomPods({ includeInstance: true }),
  });

  // Fetch instances for dropdown
  const { data: instancesData } = useQuery({
    queryKey: ['instances'],
    queryFn: api.getInstances,
  });

  // Fetch active instance
  const { data: activeInstanceData } = useQuery({
    queryKey: ['active-instance'],
    queryFn: api.getActiveInstance,
  });

  // Fetch build files for selected pod
  const { data: buildFilesData } = useQuery({
    queryKey: ['build-files', selectedPodForCompile?.id],
    queryFn: () => api.getBuildFiles(selectedPodForCompile!.id),
    enabled: !!selectedPodForCompile,
  });

  // Fetch compile logs for selected pod
  const { data: compileLogsData } = useQuery({
    queryKey: ['compile-logs', selectedPodForLogs?.id],
    queryFn: () => api.getCompileLogs(selectedPodForLogs!.id),
    enabled: !!selectedPodForLogs,
  });

  // Create mutation
  const createMutation = useMutation({
    mutationFn: api.createFantomPod,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fantom-pods'] });
      setShowAddForm(false);
      resetForm();
      setSuccess('Pod created successfully');
      setTimeout(() => setSuccess(null), 3000);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to create pod');
    },
  });

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<CreatePodInput> }) =>
      api.updateFantomPod(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fantom-pods'] });
      setEditingPod(null);
      resetForm();
      setSuccess('Pod updated successfully');
      setTimeout(() => setSuccess(null), 3000);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to update pod');
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: api.deleteFantomPod,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fantom-pods'] });
      setSuccess('Pod deleted successfully');
      setTimeout(() => setSuccess(null), 3000);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to delete pod');
    },
  });

  // Compile mutation
  const compileMutation = useMutation({
    mutationFn: ({
      podId,
      instanceId,
      buildFile,
    }: {
      podId: number;
      instanceId?: number;
      buildFile?: string;
    }) => api.compilePod(podId, instanceId, buildFile),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['compile-logs'] });
      if (result.success) {
        setSuccess('Compilation successful!');
        setCompileOutput(result.output);
      } else {
        setError('Compilation failed');
        setCompileOutput(result.error || result.output);
      }
      setTimeout(() => setSuccess(null), 5000);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Compilation failed');
    },
  });

  // AST-cache-and-navigate mutation: ensures graph nodes/edges exist for this
  // pod (creates FantomProject + indexes + builds graph), then opens the AST
  // viewer. Without this the pod would not appear in /graph-3d until the
  // server was restarted or the cache was manually built.
  const astNavigateMutation = useMutation({
    mutationFn: (podId: string | number) => api.createPodAstCache(podId),
    onSuccess: (_result, podId) => {
      queryClient.invalidateQueries({ queryKey: ['fantom-pods'] });
      queryClient.invalidateQueries({ queryKey: ['code-projects'] });
      queryClient.invalidateQueries({ queryKey: ['projects-list'] });
      queryClient.invalidateQueries({ queryKey: ['all-ast-cache'] });
      router.push(`/ast-viewer?podId=${encodeURIComponent(String(podId))}`);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to build AST cache');
      setTimeout(() => setError(null), 5000);
    },
  });

  // Index all pods for search mutation
  const indexAllMutation = useMutation({
    mutationFn: () => api.indexAllPodsAst(),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['fantom-pods'] });
      queryClient.invalidateQueries({ queryKey: ['code-stats'] });
      setSuccess(`Indexed ${result.created} new pods (${result.alreadyExists} already existed)`);
      setTimeout(() => setSuccess(null), 5000);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to index pods');
    },
  });

  const resetForm = () => {
    setFormData({
      name: '',
      path: '',
      buildFile: 'build.fan',
      description: '',
      defaultInstanceId: undefined,
      compatMinVersion: '',
      compatMaxVersion: '',
      compatVersions: [],
    });
    setVersionTagInput('');
    setError(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!formData.name.trim() || !formData.path.trim()) {
      setError('Name and path are required');
      return;
    }

    if (editingPod) {
      updateMutation.mutate({ id: editingPod.id, data: formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  const handleEdit = (pod: FantomPod) => {
    setEditingPod(pod);
    setFormData({
      name: pod.name,
      path: pod.path,
      buildFile: pod.buildFile,
      description: pod.description || '',
      defaultInstanceId: pod.defaultInstanceId,
      compatMinVersion: pod.compatMinVersion || '',
      compatMaxVersion: pod.compatMaxVersion || '',
      compatVersions: pod.compatVersions || [],
    });
    setVersionTagInput('');
    setShowAddForm(true);
    setError(null);
  };

  const handleDelete = (pod: FantomPod) => {
    if (confirm(`Are you sure you want to delete "${pod.name}"?`)) {
      deleteMutation.mutate(pod.id);
    }
  };

  const handleCancel = () => {
    setShowAddForm(false);
    setEditingPod(null);
    resetForm();
  };

  const handleCompile = (pod: FantomPod, buildFile?: string, instanceId?: number) => {
    setCompileOutput(null);
    compileMutation.mutate({
      podId: pod.id,
      instanceId,
      buildFile,
    });
  };

  const allPods = podsData?.pods || [];
  const instances = instancesData?.instances || [];
  const activeInstance = activeInstanceData?.active ? activeInstanceData.instance : null;
  const buildFiles = buildFilesData?.buildFiles || [];
  const compileLogs = compileLogsData?.logs || [];

  // Get unique versions from instances for the filter dropdown
  const availableVersions = useMemo(() => {
    const versions = new Set<string>();
    for (const instance of instances) {
      if (instance.version) {
        versions.add(instance.version);
      }
    }
    return Array.from(versions).sort((a, b) => {
      // Sort versions numerically (e.g., 3.1.10 < 3.1.12 < 4.0.4)
      const partsA = a.split('.').map(Number);
      const partsB = b.split('.').map(Number);
      for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
        const numA = partsA[i] || 0;
        const numB = partsB[i] || 0;
        if (numA !== numB) return numA - numB;
      }
      return 0;
    });
  }, [instances]);

  // Helper function to compare version strings
  const compareVersions = (v1: string, v2: string): number => {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const num1 = parts1[i] || 0;
      const num2 = parts2[i] || 0;
      if (num1 !== num2) return num1 - num2;
    }
    return 0;
  };

  // Check if a pod is compatible with a given version
  const isPodCompatibleWithVersion = (pod: FantomPodWithInstance, version: string): boolean => {
    // If no compatibility info is set, consider it compatible with all versions
    if (!pod.compatMinVersion && !pod.compatMaxVersion && (!pod.compatVersions || pod.compatVersions.length === 0)) {
      return true;
    }

    // Check specific versions first
    if (pod.compatVersions && pod.compatVersions.length > 0) {
      return pod.compatVersions.includes(version);
    }

    // Check version range
    if (pod.compatMinVersion && compareVersions(version, pod.compatMinVersion) < 0) {
      return false;
    }
    if (pod.compatMaxVersion && compareVersions(version, pod.compatMaxVersion) > 0) {
      return false;
    }

    return true;
  };

  // Filter pods based on selected instance and version
  const filteredPods = useMemo(() => {
    let result = allPods;

    // Filter by instance
    if (filterInstanceId === 'unassigned') {
      result = result.filter(p => !p.instance);
    } else if (filterInstanceId !== 'all') {
      result = result.filter(p => p.instance?.id === filterInstanceId);
    }

    // Filter by version compatibility
    if (filterVersion !== 'all') {
      result = result.filter(p => isPodCompatibleWithVersion(p, filterVersion));
    }

    return result;
  }, [allPods, filterInstanceId, filterVersion]);

  // Group pods by instance
  const podGroups = useMemo(() => {
    return groupPodsByInstance(filteredPods, instances);
  }, [filteredPods, instances]);

  // For backwards compatibility
  const pods = filteredPods;

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'success':
        return 'bg-green-100 text-green-800';
      case 'failure':
        return 'bg-red-100 text-red-800';
      case 'running':
        return 'bg-yellow-100 text-yellow-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  // Get version compatibility display text for a pod
  const getVersionCompatText = (pod: FantomPodWithInstance): string | null => {
    // Specific versions take precedence
    if (pod.compatVersions && pod.compatVersions.length > 0) {
      if (pod.compatVersions.length <= 3) {
        return pod.compatVersions.join(', ');
      }
      return `${pod.compatVersions.slice(0, 2).join(', ')} +${pod.compatVersions.length - 2}`;
    }

    // Version range
    if (pod.compatMinVersion && pod.compatMaxVersion) {
      return `${pod.compatMinVersion} - ${pod.compatMaxVersion}`;
    }
    if (pod.compatMinVersion) {
      return `>= ${pod.compatMinVersion}`;
    }
    if (pod.compatMaxVersion) {
      return `<= ${pod.compatMaxVersion}`;
    }

    return null;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading pods...</div>
      </div>
    );
  }

  // Projects panel entries (mirror of the instance filter dropdown).
  const projectFilterEntries: ProjectsSidebarEntry<number | 'all' | 'unassigned'>[] = [
    { id: 'all', label: 'All Pods', count: allPods.length },
    {
      id: 'unassigned',
      label: 'Unassigned',
      count: allPods.filter((p) => !p.instance).length,
    },
    ...instances.map((instance) => ({
      id: instance.id,
      label: instance.name,
      sublabel: `${instance.type}${instance.version ? ' ' + instance.version : ''}`,
      count: allPods.filter((p) => p.instance?.id === instance.id).length,
    })),
  ];

  return (
    <div className="flex flex-col lg:flex-row gap-4">
      <ProjectsSidebar
        entries={projectFilterEntries}
        selectedId={filterInstanceId}
        onSelect={setFilterInstanceId}
      />

      {/* Main Content Column */}
      <div className="flex-1 min-w-0">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Pods & Projects</h1>
          <p className="text-gray-600 mt-1">
            Manage and compile pod or project sources
          </p>
        </div>
        {!showAddForm && (
          <div className="flex gap-2">
            <button
              onClick={() => rebuildAllDepsMutation.mutate()}
              disabled={rebuildAllDepsMutation.isPending}
              className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50 transition-colors"
              title="Recompute build.fan / package.json / cross-project-edges / workspace dependencies for every indexed project"
            >
              {rebuildAllDepsMutation.isPending ? 'Rebuilding…' : 'Rebuild All Dependencies'}
            </button>
            <button
              onClick={() => indexAllMutation.mutate()}
              disabled={indexAllMutation.isPending}
              className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 transition-colors"
              title="Index all pods for searchVersionedApi"
            >
              {indexAllMutation.isPending ? 'Indexing...' : 'Index All for Search'}
            </button>
            <button
              onClick={() => {
                setShowAddForm(true);
                setEditingPod(null);
                resetForm();
              }}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
            >
              Add Pod
            </button>
          </div>
        )}
      </div>

      {/* Filter and Instance Info Bar */}
      <div className="mb-6 p-3 bg-gray-50 rounded-lg text-sm flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div>
            <span className="text-gray-600">Active Instance: </span>
            {activeInstance ? (
              <span className="font-medium">
                {activeInstance.name} ({activeInstance.type})
              </span>
            ) : (
              <span className="text-gray-500">None selected</span>
            )}
          </div>
          <a href="/instances" className="text-blue-600 hover:underline">
            Manage Instances
          </a>
        </div>

        {/* Filter Dropdowns */}
        <div className="flex items-center gap-4 flex-wrap">
          {/* Instance Filter */}
          <div className="flex items-center gap-2">
            <label htmlFor="instance-filter" className="text-gray-600">
              Instance:
            </label>
            <select
              id="instance-filter"
              value={filterInstanceId}
              onChange={(e) => {
                const val = e.target.value;
                if (val === 'all') setFilterInstanceId('all');
                else if (val === 'unassigned') setFilterInstanceId('unassigned');
                else setFilterInstanceId(parseInt(val, 10));
              }}
              className="rounded-md border border-gray-300 py-1.5 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="all">All Pods ({allPods.length})</option>
              <option value="unassigned">Unassigned ({allPods.filter(p => !p.instance).length})</option>
              {instances.map((instance) => {
                const count = allPods.filter(p => p.instance?.id === instance.id).length;
                return (
                  <option key={instance.id} value={instance.id}>
                    {instance.name} ({instance.type} {instance.version || ''}) - {count} pods
                  </option>
                );
              })}
            </select>
          </div>

          {/* Version Filter */}
          <div className="flex items-center gap-2">
            <label htmlFor="version-filter" className="text-gray-600">
              Version:
            </label>
            <select
              id="version-filter"
              value={filterVersion}
              onChange={(e) => setFilterVersion(e.target.value)}
              className="rounded-md border border-gray-300 py-1.5 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="all">All Versions</option>
              {availableVersions.map((version) => (
                <option key={version} value={version}>
                  {version}
                </option>
              ))}
            </select>
            {filterVersion !== 'all' && (
              <span className="text-xs text-gray-500">
                ({filteredPods.length} compatible)
              </span>
            )}
          </div>
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

      {/* Compile Output */}
      {compileOutput && (
        <div className="mb-6 bg-gray-900 rounded-lg p-4 text-sm">
          <div className="flex justify-between items-center mb-2">
            <span className="text-gray-400 text-xs uppercase">Compilation Output</span>
            <button
              onClick={() => setCompileOutput(null)}
              className="text-gray-400 hover:text-white"
            >
              Close
            </button>
          </div>
          <pre className="text-green-400 font-mono whitespace-pre-wrap overflow-x-auto max-h-64 overflow-y-auto">
            {compileOutput}
          </pre>
        </div>
      )}

      {/* Add/Edit Form */}
      {showAddForm && (
        <div className="mb-6 bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold mb-4">
            {editingPod ? 'Edit Pod' : 'Add New Pod'}
          </h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Name *
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="e.g., myPod"
                  className="w-full rounded-md border border-gray-300 py-2 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Build File
                </label>
                <input
                  type="text"
                  value={formData.buildFile}
                  onChange={(e) => setFormData({ ...formData, buildFile: e.target.value })}
                  placeholder="build.fan"
                  className="w-full rounded-md border border-gray-300 py-2 px-3 text-sm font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Path *
              </label>
              <input
                type="text"
                value={formData.path}
                onChange={(e) => setFormData({ ...formData, path: e.target.value })}
                placeholder="e.g., ~/Code/myPod"
                className="w-full rounded-md border border-gray-300 py-2 px-3 text-sm font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Default Instance
                </label>
                <select
                  value={formData.defaultInstanceId || ''}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      defaultInstanceId: e.target.value ? parseInt(e.target.value, 10) : undefined,
                    })
                  }
                  className="w-full rounded-md border border-gray-300 py-2 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">Use active instance</option>
                  {instances.map((instance) => (
                    <option key={instance.id} value={instance.id}>
                      {instance.name} ({instance.type})
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-gray-500">
                  Preferred instance for compiling this pod
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description
                </label>
                <input
                  type="text"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="Optional description"
                  className="w-full rounded-md border border-gray-300 py-2 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>

            {/* Version Compatibility Section */}
            <div className="border-t pt-4 mt-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">
                Compatible Versions
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Min Version
                  </label>
                  <input
                    type="text"
                    value={formData.compatMinVersion || ''}
                    onChange={(e) => setFormData({ ...formData, compatMinVersion: e.target.value })}
                    placeholder="e.g., 3.1.10"
                    className="w-full rounded-md border border-gray-300 py-2 px-3 text-sm font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Max Version
                  </label>
                  <input
                    type="text"
                    value={formData.compatMaxVersion || ''}
                    onChange={(e) => setFormData({ ...formData, compatMaxVersion: e.target.value })}
                    placeholder="e.g., 3.1.12"
                    className="w-full rounded-md border border-gray-300 py-2 px-3 text-sm font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Specific Versions
                </label>
                <div className="flex gap-2 mb-2">
                  <input
                    type="text"
                    value={versionTagInput}
                    onChange={(e) => setVersionTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        const version = versionTagInput.trim();
                        if (version && !formData.compatVersions?.includes(version)) {
                          setFormData({
                            ...formData,
                            compatVersions: [...(formData.compatVersions || []), version],
                          });
                          setVersionTagInput('');
                        }
                      }
                    }}
                    placeholder="e.g., 3.1.12 (press Enter to add)"
                    className="flex-1 rounded-md border border-gray-300 py-2 px-3 text-sm font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const version = versionTagInput.trim();
                      if (version && !formData.compatVersions?.includes(version)) {
                        setFormData({
                          ...formData,
                          compatVersions: [...(formData.compatVersions || []), version],
                        });
                        setVersionTagInput('');
                      }
                    }}
                    className="px-3 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 text-sm"
                  >
                    Add
                  </button>
                </div>
                {formData.compatVersions && formData.compatVersions.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {formData.compatVersions.map((version) => (
                      <span
                        key={version}
                        className="inline-flex items-center gap-1 px-2 py-1 bg-blue-100 text-blue-800 text-sm rounded-md font-mono"
                      >
                        {version}
                        <button
                          type="button"
                          onClick={() => {
                            setFormData({
                              ...formData,
                              compatVersions: formData.compatVersions?.filter((v) => v !== version),
                            });
                          }}
                          className="text-blue-600 hover:text-blue-800"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <p className="mt-1 text-xs text-gray-500">
                  Use version range (min/max) OR specific versions. Specific versions take precedence if set.
                </p>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={createMutation.isPending || updateMutation.isPending}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {createMutation.isPending || updateMutation.isPending
                  ? 'Saving...'
                  : editingPod
                  ? 'Update Pod'
                  : 'Add Pod'}
              </button>
              <button
                type="button"
                onClick={handleCancel}
                className="px-4 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Compile Modal */}
      {selectedPodForCompile && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-lg p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold mb-4">
              Compile: {selectedPodForCompile.name}
            </h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Build File
                </label>
                <select
                  id="compile-build-file"
                  defaultValue={selectedPodForCompile.buildFile}
                  className="w-full rounded-md border border-gray-300 py-2 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  {buildFiles.length > 0 ? (
                    buildFiles.map((file) => (
                      <option key={file} value={file}>
                        {file}
                      </option>
                    ))
                  ) : (
                    <option value={selectedPodForCompile.buildFile}>
                      {selectedPodForCompile.buildFile}
                    </option>
                  )}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Instance
                </label>
                <select
                  id="compile-instance"
                  defaultValue={selectedPodForCompile.defaultInstanceId || activeInstance?.id || ''}
                  className="w-full rounded-md border border-gray-300 py-2 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">Use active instance</option>
                  {instances.map((instance) => (
                    <option key={instance.id} value={instance.id}>
                      {instance.name} ({instance.type})
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => {
                  const buildFileEl = document.getElementById('compile-build-file') as HTMLSelectElement;
                  const instanceEl = document.getElementById('compile-instance') as HTMLSelectElement;
                  handleCompile(
                    selectedPodForCompile,
                    buildFileEl.value,
                    instanceEl.value ? parseInt(instanceEl.value, 10) : undefined
                  );
                  setSelectedPodForCompile(null);
                }}
                disabled={compileMutation.isPending}
                className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 transition-colors"
              >
                {compileMutation.isPending ? 'Compiling...' : 'Compile'}
              </button>
              <button
                onClick={() => setSelectedPodForCompile(null)}
                className="px-4 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Compile Logs Modal */}
      {selectedPodForLogs && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-lg p-6 w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold">
                Compile History: {selectedPodForLogs.name}
              </h3>
              <button
                onClick={() => setSelectedPodForLogs(null)}
                className="text-gray-500 hover:text-gray-700"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="overflow-y-auto flex-1">
              {compileLogs.length === 0 ? (
                <p className="text-gray-500 text-center py-8">No compilation history</p>
              ) : (
                <div className="space-y-3">
                  {compileLogs.map((log) => (
                    <div key={log.id} className="border rounded-lg p-3">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs px-2 py-0.5 rounded ${getStatusColor(log.status)}`}>
                            {log.status}
                          </span>
                          <span className="text-sm font-mono">{log.buildFile}</span>
                        </div>
                        <div className="text-xs text-gray-500">
                          {log.durationMs ? `${(log.durationMs / 1000).toFixed(2)}s` : ''}
                        </div>
                      </div>
                      <div className="text-xs text-gray-500">
                        {new Date(log.startedAt).toLocaleString()}
                      </div>
                      {(log.output || log.error) && (
                        <details className="mt-2">
                          <summary className="text-xs text-blue-600 cursor-pointer hover:underline">
                            View output
                          </summary>
                          <pre className="mt-2 p-2 bg-gray-100 rounded text-xs font-mono whitespace-pre-wrap overflow-x-auto max-h-32 overflow-y-auto">
                            {log.error || log.output}
                          </pre>
                        </details>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Pods List - Grouped by Instance */}
      {pods.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-8 text-center">
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
            {filterInstanceId === 'all' ? 'No pods configured' : 'No pods in this filter'}
          </h3>
          <p className="text-gray-500 mb-4">
            {filterInstanceId === 'all'
              ? 'Add a Fantom pod project to start compiling.'
              : 'Try selecting a different instance filter or add new pods.'}
          </p>
          {filterInstanceId === 'all' && (
            <button
              onClick={() => setShowAddForm(true)}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
            >
              Add Your First Pod
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          {podGroups.map((group) => (
            <div key={group.key} className="space-y-3">
              {/* Instance Group Header */}
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-semibold text-gray-800">
                  {group.label}
                </h2>
                <span className="text-sm text-gray-500">
                  ({group.pods.length} pod{group.pods.length !== 1 ? 's' : ''})
                </span>
                {group.instanceType && (
                  <span className={`text-xs px-2 py-0.5 rounded ${
                    group.instanceType === 'skyspark' ? 'bg-blue-100 text-blue-700' :
                    group.instanceType === 'haxall' ? 'bg-green-100 text-green-700' :
                    'bg-gray-100 text-gray-700'
                  }`}>
                    {group.instanceType}
                  </span>
                )}
                {group.instanceVersion && (
                  <span className="text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded font-mono">
                    v{group.instanceVersion}
                  </span>
                )}
              </div>

              {/* Pods in this group */}
              <div className="space-y-2 pl-2 border-l-2 border-gray-200">
                {group.pods.map((pod) => {
                  const versionCompatText = getVersionCompatText(pod);
                  const podProjectId = projectIdForPod(pod);
                  return (
                  <div key={pod.id} className="bg-white rounded-lg shadow p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <h3 className="font-semibold text-gray-900">{pod.name}</h3>
                          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded font-mono">
                            {pod.buildFile}
                          </span>
                          <DependencyCounts
                            projectId={podProjectId}
                            summary={depSummary}
                            active={podProjectId != null && expandedDepsProject === podProjectId}
                            onClick={() => podProjectId != null && setExpandedDepsProject(expandedDepsProject === podProjectId ? null : podProjectId)}
                          />
                          {versionCompatText && (
                            <span
                              className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded font-mono"
                              title={pod.compatVersions?.length
                                ? `Compatible versions: ${pod.compatVersions.join(', ')}`
                                : `Version range: ${pod.compatMinVersion || 'any'} to ${pod.compatMaxVersion || 'any'}`
                              }
                            >
                              v{versionCompatText}
                            </span>
                          )}
                        </div>
                        <div className="text-sm text-gray-600 font-mono mb-1">{pod.path}</div>
                        {pod.description && (
                          <div className="text-xs text-gray-500">{pod.description}</div>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setSelectedPodForCompile(pod)}
                          disabled={compileMutation.isPending}
                          className="px-3 py-1.5 text-sm bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 transition-colors"
                        >
                          Compile
                        </button>
                        <button
                          onClick={() => astNavigateMutation.mutate(pod.id)}
                          disabled={astNavigateMutation.isPending && astNavigateMutation.variables === pod.id}
                          className="px-3 py-1.5 text-sm bg-purple-50 text-purple-700 rounded hover:bg-purple-100 disabled:opacity-60 transition-colors"
                          title="Build AST cache + graph and open viewer"
                        >
                          {astNavigateMutation.isPending && astNavigateMutation.variables === pod.id
                            ? 'Building…'
                            : 'AST'}
                        </button>
                        <button
                          onClick={() => setSelectedPodForLogs(pod)}
                          className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors"
                        >
                          History
                        </button>
                        <button
                          onClick={() => handleEdit(pod)}
                          className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDelete(pod)}
                          disabled={deleteMutation.isPending}
                          className="px-3 py-1.5 text-sm bg-red-50 text-red-700 rounded hover:bg-red-100 transition-colors"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    {podProjectId != null && expandedDepsProject === podProjectId && (
                      <ProjectDependenciesPanel projectId={podProjectId} showDeclared className="mt-3" />
                    )}
                  </div>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Other Projects: FantomProject rows that are not backed by a
              FantomPod (typically MCP-added projects or non-Fantom code
              projects). Without this section they are invisible here. */}
          {podsData?.projects && podsData.projects.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-semibold text-gray-800">
                  Other Projects
                </h2>
                <span className="text-sm text-gray-500">
                  ({podsData.projects.length} project{podsData.projects.length !== 1 ? 's' : ''})
                </span>
                <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded">
                  code
                </span>
              </div>
              <div className="space-y-2 pl-2 border-l-2 border-gray-200">
                {podsData.projects.map((proj) => (
                  <div key={`proj-${proj.id}`} className="bg-white rounded-lg shadow p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <h3 className="font-semibold text-gray-900 truncate">{proj.name}</h3>
                          <span className="text-xs px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">
                            {proj.language}
                          </span>
                          <span className="text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                            {proj.parserType === 'tree-sitter-wasm' || proj.parserType === 'tree-sitter'
                              ? 'Tree-sitter'
                              : 'Regex'}
                          </span>
                          {proj.functionCount + proj.typeCount > 0 ? (
                            <span className="text-xs text-gray-500">
                              {proj.functionCount} fns · {proj.typeCount} types
                            </span>
                          ) : (
                            <span className="text-xs text-amber-700">not indexed</span>
                          )}
                          <DependencyCounts
                            projectId={proj.id}
                            summary={depSummary}
                            active={expandedDepsProject === proj.id}
                            onClick={() => setExpandedDepsProject(expandedDepsProject === proj.id ? null : proj.id)}
                          />
                        </div>
                        <p className="text-sm text-gray-500 font-mono truncate">{proj.path}</p>
                        {proj.description && (
                          <p className="text-sm text-gray-600 mt-1">{proj.description}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => router.push(`/ast-viewer?projectId=${proj.id}`)}
                          className="px-3 py-1.5 text-sm bg-purple-50 text-purple-700 rounded hover:bg-purple-100 transition-colors"
                        >
                          View AST
                        </button>
                      </div>
                    </div>
                    {expandedDepsProject === proj.id && (
                      <ProjectDependenciesPanel projectId={proj.id} showDeclared className="mt-3" />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}
