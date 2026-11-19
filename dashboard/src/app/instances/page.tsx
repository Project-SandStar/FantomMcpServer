'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { PathInput } from '@/components/ui/FolderPicker';
import { InstallersPanel, InstallerCheckRequest } from '@/components/InstallersPanel';
import { InstanceCard, ActionMenu } from '@/components/instances/InstanceCard';
import { api, FantomInstance, CreateInstanceInput, InstanceType, FantomVersion } from '@/lib/api';

export default function InstancesPage() {
  const queryClient = useQueryClient();
  const [installerJobId, setInstallerJobId] = useState<string | null>(null);
  const [installerMsg, setInstallerMsg] = useState<string | null>(null);
  const [checkRequest, setCheckRequest] = useState<InstallerCheckRequest>(null);
  const requestCheck = (product: 'haxall' | 'skyspark') => setCheckRequest(r => ({ product, n: (r?.n ?? 0) + 1 }));
  const setHomeMutation = useMutation({
    mutationFn: (id: number) => api.setHaxallHome(id),
    onSuccess: r => {
      setInstallerMsg(r.changed ? `Home set: ${r.path}` : `Home already set: ${r.path}`);
      queryClient.invalidateQueries({ queryKey: ['instances'] });
    },
    onError: e => setInstallerMsg((e as Error).message),
  });
  const compileHomeMutation = useMutation({
    mutationFn: (id: number) => api.compileHaxallHome(id),
    onSuccess: r => { setInstallerJobId(r.jobId); setInstallerMsg(null); },
    onError: e => setInstallerMsg((e as Error).message),
  });
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingInstance, setEditingInstance] = useState<FantomInstance | null>(null);
  const [formData, setFormData] = useState<CreateInstanceInput>({
    name: '',
    path: '',
    type: 'fantom',
    version: '',
    fanExecutable: '',
    description: '',
    sourcePath: '',
    fantomVersion: '',
    fantomSourcePath: '',
    docSourceInstanceId: null,
  });
  const [indexingSource, setIndexingSource] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [fantomVersionWarning, setFantomVersionWarning] = useState<string | null>(null);
  const [isDetectingVersion, setIsDetectingVersion] = useState(false);

  // Fetch instances
  const { data, isLoading } = useQuery({
    queryKey: ['instances'],
    queryFn: api.getInstances,
  });

  // Fetch active instance
  const { data: activeData } = useQuery({
    queryKey: ['active-instance'],
    queryFn: api.getActiveInstance,
  });

  // Fetch available Fantom versions
  const { data: fantomVersionsData } = useQuery({
    queryKey: ['fantom-versions'],
    queryFn: api.getFantomVersions,
    retry: false,
  });

  const availableVersions = fantomVersionsData?.versions || [];

  // Fetch SkySpark instances for doc source selection (only when editing a Haxall instance)
  const { data: skysparkInstancesData } = useQuery({
    queryKey: ['skyspark-instances', formData.version],
    queryFn: () => api.getSkySarkInstances(formData.version || undefined),
    enabled: showAddForm && formData.type === 'haxall',
    retry: false,
  });

  // Create mutation
  const createMutation = useMutation({
    mutationFn: api.createInstance,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['instances'] });
      setShowAddForm(false);
      resetForm();
      setSuccess('Instance created successfully');
      setTimeout(() => setSuccess(null), 3000);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to create instance');
    },
  });

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<CreateInstanceInput> }) =>
      api.updateInstance(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['instances'] });
      setEditingInstance(null);
      resetForm();
      setSuccess('Instance updated successfully');
      setTimeout(() => setSuccess(null), 3000);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to update instance');
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: api.deleteInstance,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['instances'] });
      queryClient.invalidateQueries({ queryKey: ['active-instance'] });
      setSuccess('Instance deleted successfully');
      setTimeout(() => setSuccess(null), 3000);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to delete instance');
    },
  });

  // Validate mutation
  const validateMutation = useMutation({
    mutationFn: api.validateInstance,
    onSuccess: (result, id) => {
      queryClient.invalidateQueries({ queryKey: ['instances'] });
      if (result.isValid) {
        setSuccess('Instance path is valid');
      } else {
        setError(result.error || 'Instance path is invalid');
      }
      setTimeout(() => {
        setSuccess(null);
        setError(null);
      }, 3000);
    },
  });

  // Set active mutation
  const setActiveMutation = useMutation({
    mutationFn: api.setActiveInstance,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['active-instance'] });
      setSuccess('Active instance updated');
      setTimeout(() => setSuccess(null), 3000);
    },
  });

  // Index source code mutation
  const indexSourceMutation = useMutation({
    mutationFn: api.indexInstanceSource,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['source-status'] });
      queryClient.invalidateQueries({ queryKey: ['ast-cache'] });

      if (result.podsIndexed === 0 && result.diagnostics) {
        // Show diagnostic info when no pods were indexed
        const diag = result.diagnostics;
        setError(
          `No pods found. Found ${diag.totalDirectories} directories, but ${diag.skippedCount} were skipped. ` +
          `${diag.expectedStructure}` +
          (diag.skipped.length > 0
            ? `. Skipped: ${diag.skipped.map(s => `${s.name} (${s.reason})`).slice(0, 3).join(', ')}${diag.skipped.length > 3 ? '...' : ''}`
            : '')
        );
      } else {
        setSuccess(
          `Source indexed: ${result.podsIndexed} pods, ${result.totalFunctions} functions, ${result.totalTypes} types in ${(result.duration / 1000).toFixed(2)}s`
        );
        setTimeout(() => setSuccess(null), 5000);
      }
      setIndexingSource(null);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to index source code');
      setIndexingSource(null);
    },
  });

  const resetForm = () => {
    setFormData({
      name: '',
      path: '',
      type: 'fantom',
      version: '',
      fanExecutable: '',
      description: '',
      sourcePath: '',
      fantomVersion: '',
      fantomSourcePath: '',
      docSourceInstanceId: null,
    });
    setError(null);
    setFantomVersionWarning(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!formData.name.trim() || !formData.path.trim()) {
      setError('Name and path are required');
      return;
    }

    if (editingInstance) {
      updateMutation.mutate({ id: editingInstance.id, data: formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  const handleEdit = (instance: FantomInstance) => {
    setEditingInstance(instance);
    setFormData({
      name: instance.name,
      path: instance.path,
      type: instance.type,
      version: instance.version || '',
      fanExecutable: instance.fanExecutable,
      description: instance.description || '',
      sourcePath: instance.sourcePath || '',
      fantomVersion: instance.fantomVersion || '',
      fantomSourcePath: instance.fantomSourcePath || '',
      docSourceInstanceId: instance.docSourceInstanceId || null,
    });
    setShowAddForm(true);
    setError(null);
    setFantomVersionWarning(null);
  };

  const handleIndexSource = (instanceId: number) => {
    setIndexingSource(instanceId);
    indexSourceMutation.mutate(instanceId);
  };


  const handleDelete = (instance: FantomInstance) => {
    if (confirm(`Are you sure you want to delete "${instance.name}"?`)) {
      deleteMutation.mutate(instance.id);
    }
  };

  const handleCancel = () => {
    setShowAddForm(false);
    setEditingInstance(null);
    resetForm();
  };

  const handleDetectFantomVersion = async () => {
    if (!formData.path) {
      setError('Please enter an instance path first');
      return;
    }

    setIsDetectingVersion(true);
    setFantomVersionWarning(null);

    try {
      const result = await api.detectFantomVersion(formData.path);
      if (result.detectedVersion) {
        setFormData(prev => ({
          ...prev,
          fantomVersion: result.detectedVersion || '',
          fantomSourcePath: result.sourcePath || '',
        }));

        if (!result.sourceAvailable) {
          setFantomVersionWarning(
            `Fantom ${result.detectedVersion} detected, but source not found. Configure Fantom Source Folder in Settings.`
          );
        } else {
          setSuccess(`Fantom version ${result.detectedVersion} detected with source available`);
          setTimeout(() => setSuccess(null), 3000);
        }
      } else {
        setFantomVersionWarning('Could not detect Fantom version. You can select one manually.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to detect Fantom version');
    } finally {
      setIsDetectingVersion(false);
    }
  };

  const instances = data?.instances || [];
  const activeInstance = activeData?.active ? activeData.instance : null;

  // Group by product, newest version first.
  const verKey = (v?: string) => (v || '').split(/[.\-]/).map(x => x.padStart(6, '0')).join('.');
  const GROUPS: { type: string; title: string }[] = [
    { type: 'haxall', title: 'Haxall' },
    { type: 'skyspark', title: 'SkySpark' },
    { type: 'fantom', title: 'Fantom' },
  ];
  const groups = [
    ...GROUPS.map(g => ({ ...g, items: instances.filter(i => i.type === g.type) })),
    { type: 'other', title: 'Other', items: instances.filter(i => !GROUPS.some(g => g.type === i.type)) },
  ]
    .filter(g => g.items.length > 0)
    .map(g => ({ ...g, items: [...g.items].sort((a, b) => verKey(b.version).localeCompare(verKey(a.version))) }));


  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading instances...</div>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900">Fantom Instances</h1>
          <p className="text-gray-600 mt-1 text-sm">Fantom, SkySpark and Haxall installations</p>
        </div>
        <div className="flex items-center gap-2">
          <ActionMenu
            label="Add instance"
            trigger={<span className="inline-flex items-center gap-1 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-sm font-medium whitespace-nowrap">+ Add <span aria-hidden>▾</span></span>}
            actions={[
              { label: 'Add manually', onClick: () => { setShowAddForm(true); setEditingInstance(null); resetForm(); } },
              { label: 'Check & add Haxall', onClick: () => requestCheck('haxall'), title: 'Look for new Haxall releases on GitHub' },
              { label: 'Check & add SkySpark', onClick: () => requestCheck('skyspark'), title: 'Look for new SkySpark installers in the installer source' },
            ]}
          />
          <a href="../config/#fantom-source" title="Installer settings" aria-label="Installer settings"
            className="h-9 w-9 flex items-center justify-center rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50">⚙</a>
        </div>
      </div>

      <div className="mb-6 space-y-2 empty:hidden">
        <InstallersPanel jobId={installerJobId} setJobId={setInstallerJobId} request={checkRequest} />
        {installerMsg && <div className="text-sm text-gray-700 bg-gray-50 rounded px-3 py-2">{installerMsg}</div>}
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

      {/* Add/Edit Form */}
      {showAddForm && (
        <div className="mb-6 bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold mb-4">
            {editingInstance ? 'Edit Instance' : 'Add New Instance'}
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
                  placeholder="e.g., SkySpark 3.1.12"
                  className="w-full rounded-md border border-gray-300 py-2 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Type
                </label>
                <select
                  value={formData.type}
                  onChange={(e) =>
                    setFormData({ ...formData, type: e.target.value as InstanceType })
                  }
                  className="w-full rounded-md border border-gray-300 py-2 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="fantom">Fantom</option>
                  <option value="skyspark">SkySpark</option>
                  <option value="haxall">Haxall</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Path *
              </label>
              <PathInput
                value={formData.path}
                onChange={(v) => setFormData({ ...formData, path: v })}
                placeholder="e.g., /mirror/mac-user/skyspark/skyspark-4.0.6"
                pickerTitle="Choose the installation folder (home)"
                inputClassName="flex-1 min-w-0 rounded-md border border-gray-300 py-2 px-3 text-sm font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <p className="mt-1 text-xs text-gray-500">
                Full path to the Fantom/SkySpark/Haxall installation directory
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Version
                </label>
                <input
                  type="text"
                  value={formData.version}
                  onChange={(e) => setFormData({ ...formData, version: e.target.value })}
                  placeholder="e.g., 3.1.12"
                  className="w-full rounded-md border border-gray-300 py-2 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Fan Executable
                </label>
                <input
                  type="text"
                  value={formData.fanExecutable}
                  onChange={(e) => setFormData({ ...formData, fanExecutable: e.target.value })}
                  placeholder="bin/fan (auto-detected)"
                  className="w-full rounded-md border border-gray-300 py-2 px-3 text-sm font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Relative path to fan executable (leave empty for auto-detection)
                </p>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Description
              </label>
              <textarea
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Optional description"
                rows={2}
                className="w-full rounded-md border border-gray-300 py-2 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>

            {/* Source Path - only for haxall/skyspark */}
            {(formData.type === 'haxall' || formData.type === 'skyspark') && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Source Path
                </label>
                <PathInput
                  value={formData.sourcePath ?? ''}
                  onChange={(v) => setFormData({ ...formData, sourcePath: v })}
                  placeholder="e.g., /mirror/mac-user/haxall/src"
                  pickerTitle="Choose the source folder"
                  inputClassName="flex-1 min-w-0 rounded-md border border-gray-300 py-2 px-3 text-sm font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Path to Haxall/SkySpark source code for indexing (optional)
                </p>
              </div>
            )}

            {/* Fantom Version - for skyspark/haxall */}
            {(formData.type === 'haxall' || formData.type === 'skyspark') && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Fantom Version
                </label>
                <div className="flex gap-2">
                  <select
                    value={formData.fantomVersion || ''}
                    onChange={(e) => {
                      const version = e.target.value;
                      const selectedVersion = availableVersions.find((v: FantomVersion) => v.version === version);
                      setFormData({
                        ...formData,
                        fantomVersion: version,
                        fantomSourcePath: selectedVersion?.path || '',
                      });
                      setFantomVersionWarning(null);
                    }}
                    className="flex-1 rounded-md border border-gray-300 py-2 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="">Auto-detect or select...</option>
                    {availableVersions.map((v: FantomVersion) => (
                      <option key={v.version} value={v.version}>
                        {v.version} {v.hasSource ? '(source available)' : ''}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={handleDetectFantomVersion}
                    disabled={isDetectingVersion || !formData.path}
                    className="px-4 py-2 bg-orange-50 text-orange-700 rounded-md hover:bg-orange-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {isDetectingVersion ? 'Detecting...' : 'Detect'}
                  </button>
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  Fantom version used by this instance. Click Detect to auto-detect from config.props.
                </p>
              </div>
            )}

            {/* Fantom Version Warning */}
            {fantomVersionWarning && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                <p className="text-sm text-yellow-800">{fantomVersionWarning}</p>
              </div>
            )}

            {/* Doc Source - only for haxall */}
            {formData.type === 'haxall' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Documentation Source
                </label>
                <select
                  value={formData.docSourceInstanceId || ''}
                  onChange={(e) => setFormData({
                    ...formData,
                    docSourceInstanceId: e.target.value ? parseInt(e.target.value, 10) : null
                  })}
                  className="w-full rounded-md border border-gray-300 py-2 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">No documentation source</option>
                  {skysparkInstancesData?.matchingVersion && skysparkInstancesData.matchingVersion.length > 0 && (
                    <optgroup label="Matching Version">
                      {skysparkInstancesData.matchingVersion.map((inst: FantomInstance) => (
                        <option key={inst.id} value={inst.id}>
                          {inst.name} (v{inst.version})
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {skysparkInstancesData?.otherVersions && skysparkInstancesData.otherVersions.length > 0 && (
                    <optgroup label="Other Versions">
                      {skysparkInstancesData.otherVersions.map((inst: FantomInstance) => (
                        <option key={inst.id} value={inst.id}>
                          {inst.name} {inst.version ? `(v${inst.version})` : ''}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <p className="mt-1 text-xs text-gray-500">
                  Haxall uses SkySpark documentation. Select a matching version for best results.
                </p>
                {skysparkInstancesData?.instances?.length === 0 && (
                  <p className="mt-1 text-xs text-orange-600">
                    No SkySpark instances available. Add a SkySpark instance first.
                  </p>
                )}
              </div>
            )}

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={createMutation.isPending || updateMutation.isPending}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {createMutation.isPending || updateMutation.isPending
                  ? 'Saving...'
                  : editingInstance
                  ? 'Update Instance'
                  : 'Add Instance'}
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

      {/* Instances List */}
      {instances.length === 0 ? (
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
              d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01"
            />
          </svg>
          <h3 className="text-lg font-medium text-gray-900 mb-2">No instances configured</h3>
          <p className="text-gray-500 mb-4">
            Add a Fantom, SkySpark, or Haxall installation to get started.
          </p>
          <button
            onClick={() => setShowAddForm(true)}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
          >
            Add Your First Instance
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map(g => (
            <section key={g.type}>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">{g.title} <span className="text-gray-400">({g.items.length})</span></h2>
              <div className="grid gap-3 grid-cols-1 2xl:grid-cols-2">
                {g.items.map(instance => (
                  <InstanceCard
                    key={instance.id}
                    instance={instance}
                    isActive={activeInstance?.id === instance.id}
                    isIndexingSource={indexingSource === instance.id}
                    installerBusy={!!installerJobId || compileHomeMutation.isPending}
                    onSetActive={() => setActiveMutation.mutate(instance.id)}
                    onValidate={() => validateMutation.mutate(instance.id)}
                    onEdit={() => handleEdit(instance)}
                    onDelete={() => handleDelete(instance)}
                    onIndexSource={() => handleIndexSource(instance.id)}
                    onSetHome={() => setHomeMutation.mutate(instance.id)}
                    onCompileHome={() => compileHomeMutation.mutate(instance.id)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
