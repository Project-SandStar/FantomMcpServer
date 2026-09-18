'use client';

import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, FantomInstance, FantomPodWithInstance } from '@/lib/api';
import SearchableComboBox, { ComboBoxOption } from '@/components/ui/SearchableComboBox';

interface VersionedApiSearchFormProps {
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  onSubmit?: () => void;
}

// Search modes
const SEARCH_MODES = [
  { value: 'all', label: 'All (API + Code + Samples)' },
  { value: 'api', label: 'API Documentation' },
  { value: 'code', label: 'Source Code (AST)' },
  { value: 'samples', label: 'Code Samples' },
];

// Element types
const ELEMENT_TYPES = [
  { value: '', label: 'All Types' },
  { value: 'type', label: 'Type (class/mixin)' },
  { value: 'slot', label: 'Slot' },
  { value: 'function', label: 'Function' },
  { value: 'method', label: 'Method' },
  { value: 'field', label: 'Field' },
  { value: 'tag', label: 'Tag' },
  { value: 'example', label: 'Example' },
  { value: 'guide', label: 'Guide' },
];

// Languages
const LANGUAGES = [
  { value: '', label: 'All Languages' },
  { value: 'fantom', label: 'Fantom' },
  { value: 'axon', label: 'Axon' },
];

// Data sources
const DATA_SOURCES = [
  { value: 'local', label: 'Local Docs', description: 'Cached instance documentation' },
  { value: 'fantom-source', label: 'Fantom Source', description: 'AST-indexed source code' },
];

export function VersionedApiSearchForm({ values, onChange, onSubmit }: VersionedApiSearchFormProps) {
  // Fetch instances from the API
  const { data: instancesData } = useQuery({
    queryKey: ['instances'],
    queryFn: api.getInstances,
    staleTime: 60000,
  });

  // Fetch pods from the API (for pod filter dropdown)
  const { data: podsData } = useQuery({
    queryKey: ['pods'],
    queryFn: api.getPods,
    staleTime: 60000,
  });

  // Fetch fantom pods (registered pods with instance info)
  const { data: fantomPodsData } = useQuery({
    queryKey: ['fantom-pods', 'with-instance'],
    queryFn: () => api.getFantomPods({ includeInstance: true }),
    staleTime: 60000,
  });

  const instances = instancesData?.instances || [];
  const pods = podsData?.pods || [];
  const fantomPods = fantomPodsData?.pods || [];

  // Extract unique versions from instances
  const availableVersions = useMemo(() => {
    const versions = new Set<string>();
    instances.forEach((inst: FantomInstance) => {
      if (inst.version) versions.add(inst.version);
    });
    return Array.from(versions).sort((a, b) => b.localeCompare(a));
  }, [instances]);

  // Convert instances to ComboBoxOption format
  const instanceOptions: ComboBoxOption[] = useMemo(() => {
    return instances.map((inst: FantomInstance) => ({
      value: inst.id,
      label: inst.name,
      description: `${inst.type} ${inst.version}`,
    }));
  }, [instances]);

  // Convert pods to ComboBoxOption format
  const podOptions: ComboBoxOption[] = useMemo(() => {
    return pods.map((pod: string) => ({
      value: pod,
      label: pod,
    }));
  }, [pods]);

  // Convert versions to ComboBoxOption format
  const versionOptions: ComboBoxOption[] = useMemo(() => {
    return availableVersions.map((ver) => ({
      value: ver,
      label: ver,
    }));
  }, [availableVersions]);

  // Convert search modes to ComboBoxOption format
  const searchModeOptions: ComboBoxOption[] = useMemo(() => {
    return SEARCH_MODES.map((mode) => ({
      value: mode.value,
      label: mode.label,
    }));
  }, []);

  // Convert element types to ComboBoxOption format
  const elementTypeOptions: ComboBoxOption[] = useMemo(() => {
    return ELEMENT_TYPES.map((t) => ({
      value: t.value,
      label: t.label,
    }));
  }, []);

  // Convert languages to ComboBoxOption format
  const languageOptions: ComboBoxOption[] = useMemo(() => {
    return LANGUAGES.map((lang) => ({
      value: lang.value,
      label: lang.label,
    }));
  }, []);

  // Initialize defaults
  useEffect(() => {
    if (values.mode === undefined) {
      onChange({ ...values, mode: 'all', limit: 10 });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleChange = (key: string, value: unknown) => {
    const newValues = { ...values, [key]: value };

    // Clear version if instanceId is set (instance provides version)
    if (key === 'instanceId' && value) {
      delete newValues.version;
    }

    onChange(newValues);
  };

  const handleSourcesChange = (source: string, checked: boolean) => {
    const currentSources = (values.sources as string[]) || [];
    let newSources: string[];

    if (checked) {
      newSources = [...currentSources, source];
    } else {
      newSources = currentSources.filter(s => s !== source);
    }

    // If empty, set to undefined to use defaults
    handleChange('sources', newSources.length > 0 ? newSources : undefined);
  };

  const selectedSources = (values.sources as string[]) || [];

  return (
    <div className="space-y-5">
      {/* Query - Required */}
      <div>
        <label htmlFor="query" className="block text-sm font-medium text-gray-700 mb-1">
          Search Query <span className="text-red-500">*</span>
        </label>
        <input
          id="query"
          type="text"
          value={(values.query as string) || ''}
          onChange={(e) => handleChange('query', e.target.value || undefined)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && onSubmit) {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder="e.g., readAll, HttpClient, Bool.and"
          className="w-full rounded-md border border-gray-300 py-2 px-3 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
      </div>

      {/* Mode - SearchableComboBox */}
      <div>
        <SearchableComboBox
          label="Search Mode"
          options={searchModeOptions}
          value={(values.mode as string) || 'all'}
          onChange={(val) => handleChange('mode', val || 'all')}
          placeholder="Select search mode..."
          searchPlaceholder="Filter modes..."
          clearable={false}
        />
        <p className="mt-1 text-xs text-gray-500">Which data sources to search</p>
      </div>

      {/* Version Context Section */}
      <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
        <h4 className="text-sm font-medium text-gray-700 mb-3">Version Context</h4>
        <p className="text-xs text-gray-500 mb-3">
          Select an instance OR enter a version. Results will be filtered to match.
        </p>

        <div className="grid grid-cols-2 gap-4">
          {/* Instance SearchableComboBox */}
          <SearchableComboBox
            label="Instance"
            options={instanceOptions}
            value={(values.instanceId as number) || null}
            onChange={(val) => handleChange('instanceId', val || undefined)}
            placeholder="Select instance..."
            searchPlaceholder="Search instances..."
            emptyOptionsMessage="No instances registered"
          />

          {/* Version SearchableComboBox (alternative to instance) */}
          <SearchableComboBox
            label="Or Version"
            options={versionOptions}
            value={(values.version as string) || null}
            onChange={(val) => handleChange('version', val || undefined)}
            placeholder="Any version"
            searchPlaceholder="Search versions..."
            disabled={!!values.instanceId}
            emptyOptionsMessage="No versions available"
          />
        </div>
      </div>

      {/* Data Sources - Checkboxes */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Data Sources
        </label>
        <div className="space-y-2">
          {DATA_SOURCES.map((source) => (
            <label key={source.value} className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={selectedSources.length === 0 || selectedSources.includes(source.value)}
                onChange={(e) => handleSourcesChange(source.value, e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
              />
              <div>
                <span className="text-sm text-gray-700">{source.label}</span>
                <p className="text-xs text-gray-500">{source.description}</p>
              </div>
            </label>
          ))}
        </div>

        {/* Show registered pods */}
        {fantomPods.length > 0 && (
          <div className="mt-3 pt-3 border-t border-gray-200">
            <p className="text-xs font-medium text-gray-600 mb-2">
              Registered Pods ({fantomPods.length})
            </p>
            <div className="flex flex-wrap gap-1">
              {fantomPods.map((pod: FantomPodWithInstance) => (
                <span
                  key={pod.id}
                  className="px-2 py-0.5 text-xs bg-blue-100 text-blue-800 rounded"
                  title={`${pod.path}${pod.instance ? ` • ${pod.instance.name}` : ''}`}
                >
                  {pod.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {fantomPods.length === 0 && (
          <div className="mt-3 pt-3 border-t border-gray-200">
            <p className="text-xs text-gray-500">
              No pods registered.{' '}
              <a href="/fantom-pods" className="text-indigo-600 hover:underline">
                Go to Fantom Pods
              </a>
              {' '}to add pods.
            </p>
          </div>
        )}
      </div>

      {/* Filters Section */}
      <div className="border border-gray-200 rounded-lg p-4">
        <h4 className="text-sm font-medium text-gray-700 mb-3">Filters</h4>

        <div className="grid grid-cols-2 gap-4">
          {/* Pod Filter */}
          <SearchableComboBox
            label="Pod"
            options={podOptions}
            value={(values.pod as string) || null}
            onChange={(val) => handleChange('pod', val || undefined)}
            placeholder="All pods"
            searchPlaceholder="Search pods..."
            emptyOptionsMessage="No pods indexed"
          />

          {/* Type Filter */}
          <SearchableComboBox
            label="Element Type"
            options={elementTypeOptions}
            value={(values.type as string) || ''}
            onChange={(val) => handleChange('type', val || undefined)}
            placeholder="All Types"
            searchPlaceholder="Filter types..."
            clearable={true}
          />

          {/* Language Filter */}
          <SearchableComboBox
            label="Language"
            options={languageOptions}
            value={(values.language as string) || ''}
            onChange={(val) => handleChange('language', val || undefined)}
            placeholder="All Languages"
            searchPlaceholder="Filter languages..."
            clearable={true}
          />

          {/* Limit - keep as simple select since it has few fixed options */}
          <div>
            <label htmlFor="limit" className="block text-sm font-medium text-gray-700 mb-1">
              Max Results
            </label>
            <select
              id="limit"
              value={(values.limit as number) || 10}
              onChange={(e) => handleChange('limit', Number(e.target.value))}
              className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-3 pr-10 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value={5}>5</option>
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={30}>30</option>
              <option value={50}>50</option>
            </select>
          </div>
        </div>
      </div>

      {/* Summary of current search */}
      <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-3">
        <p className="text-xs text-indigo-800">
          Searching for <strong>&quot;{String(values.query || '...')}&quot;</strong>
          {' '}in <strong>{String((values.mode as string) || 'all')}</strong> mode
          {values.instanceId ? (
            <span> • Instance #{String(values.instanceId)}</span>
          ) : null}
          {values.version && !values.instanceId ? (
            <span> • Version {String(values.version)}</span>
          ) : null}
          {values.pod ? (
            <span> • Pod: {String(values.pod)}</span>
          ) : null}
        </p>
      </div>
    </div>
  );
}
