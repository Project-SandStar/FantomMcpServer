'use client';

import { useEffect, useMemo, useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, BackupInfo, GraphNodeSearchResult } from '@/lib/api';
import { SearchableComboBox, ComboBoxOption } from '@/components/ui/SearchableComboBox';

interface SchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: { type: string };
}

interface InputSchema {
  type: string;
  properties: Record<string, SchemaProperty>;
  required?: string[];
}

interface ParameterFormProps {
  schema: InputSchema;
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  onSubmit?: () => void;
  /** Optional project ID for type/function name lookups */
  projectId?: number;
}

// Helper to check if a parameter name represents an instance ID
function isInstanceIdParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'instanceid' || lower === 'instance_id';
}

// Helper to check if a parameter name represents a project ID
function isProjectIdParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'projectid' || lower === 'project_id';
}

// Helper to check if a parameter name represents a type/function name that should use combo box
function isTypeOrFunctionNameParam(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === 'qualifiedname' ||
    lower === 'classname' ||
    lower === 'typename' ||
    lower === 'functionname' ||
    lower === 'name'
  );
}

// Helper to check if a parameter name represents a node ID (UUID) parameter
function isNodeIdParam(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === 'nodeid' ||
    lower === 'node_id' ||
    lower === 'fromnodeid' ||
    lower === 'from_node_id' ||
    lower === 'tonodeid' ||
    lower === 'to_node_id' ||
    lower === 'focalnodeid' ||
    lower === 'focal_node_id'
  );
}

// Parameter names that should use the backup combo box
const BACKUP_PARAM_NAMES = ['backupId', 'backup', 'backupName'];

// Check if a parameter name should use the backup combo box
function isBackupParameter(paramName: string): boolean {
  return BACKUP_PARAM_NAMES.some(
    (name) => paramName.toLowerCase() === name.toLowerCase()
  );
}

// Format backup date for display
function formatBackupDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Convert backups to combo box options
function backupsToOptions(backups: BackupInfo[]) {
  return backups.map((backup) => ({
    value: backup.id,
    label: `${backup.metadata?.description || backup.id} - ${formatBackupDate(backup.createdAt)}`,
    description: `ID: ${backup.id} | File: ${backup.filename}`,
  }));
}

// Predefined options for specific parameters when they don't have enum values
const PARAMETER_OPTIONS: Record<string, string[]> = {
  nodeType: ['class', 'method', 'function', 'interface', 'field', 'type', 'enum', 'mixin', 'css-rule', 'file'],
  language: ['fantom', 'typescript', 'javascript', 'axon', 'css', 'vue', 'dart'],
  graphType: ['subgraph', 'callers', 'callees', 'impact', 'project', 'modules'],
};

// Helper to get predefined options for a parameter
function getPredefinedOptions(name: string): { value: string; label: string }[] | null {
  const options = PARAMETER_OPTIONS[name];
  if (!options) return null;
  return options.map((opt) => ({ value: opt, label: opt }));
}

// Convert graph nodes to combo box options (using qualifiedName as value)
function graphNodesToOptions(nodes: GraphNodeSearchResult[]): { value: string; label: string; description: string }[] {
  return nodes.map((node) => ({
    value: node.qualifiedName,
    label: node.name,
    description: `${node.nodeType} - ${node.qualifiedName}`,
  }));
}

// Convert graph nodes to combo box options using node ID (UUID) as value
function graphNodesToIdOptions(nodes: GraphNodeSearchResult[]): { value: string; label: string; description: string }[] {
  return nodes.map((node) => ({
    value: node.id,
    label: `${node.name} (${node.nodeType})`,
    description: `ID: ${node.id.slice(0, 8)}... | ${node.qualifiedName}`,
  }));
}

// Helper to check if a parameter name is version-related
function isVersionParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'version' || lower === 'compatiblewith' || lower.includes('version');
}

// Helper to check if a parameter name represents a pod
function isPodParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'pod' || lower === 'podname' || lower === 'podid' || lower === 'pod_name';
}

// Helper to check if a parameter name represents a user ID/reference
function isUserParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'userid' || lower === 'user' || lower === 'username' || lower === 'owner';
}

// Constants for path suggestions
const PATH_STORAGE_KEY = 'mcp-dashboard-recent-paths';
const MAX_RECENT_PATHS = 20;

// Check if a parameter name indicates it's a path-related field
function isPathParameter(key: string, propType: string): boolean {
  if (propType !== 'string') return false;
  const lowerKey = key.toLowerCase();
  return (
    lowerKey.includes('path') ||
    lowerKey.includes('dir') ||
    lowerKey.includes('directory') ||
    lowerKey.includes('folder') ||
    lowerKey.includes('file')
  );
}

// Get recent paths from localStorage
function getRecentPaths(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = localStorage.getItem(PATH_STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

// Save a path to recent paths in localStorage
function saveRecentPath(path: string): void {
  if (typeof window === 'undefined' || !path) return;
  try {
    const recent = getRecentPaths();
    // Remove if already exists (to move to front)
    const filtered = recent.filter((p) => p !== path);
    // Add to front
    const updated = [path, ...filtered].slice(0, MAX_RECENT_PATHS);
    localStorage.setItem(PATH_STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Ignore storage errors
  }
}

// Default path suggestions for Mac
const DEFAULT_PATH_SUGGESTIONS: ComboBoxOption[] = [
  { value: '/Users/', label: '/Users/', description: 'User home directories' },
  { value: '/tmp/', label: '/tmp/', description: 'Temporary files' },
  { value: '/var/log/', label: '/var/log/', description: 'System logs' },
  { value: '/usr/local/', label: '/usr/local/', description: 'Local installations' },
  { value: '/opt/', label: '/opt/', description: 'Optional packages' },
  { value: './', label: './', description: 'Current directory' },
  { value: '../', label: '../', description: 'Parent directory' },
];

// Build path options combining recent paths and defaults
function buildPathOptions(): ComboBoxOption[] {
  const recentPaths = getRecentPaths();
  const recentOptions: ComboBoxOption[] = recentPaths.map((path) => ({
    value: path,
    label: path,
    description: 'Recent',
  }));

  // Combine recent paths with defaults, avoiding duplicates
  const allOptions = [...recentOptions];
  for (const defaultOpt of DEFAULT_PATH_SUGGESTIONS) {
    if (!recentPaths.includes(defaultOpt.value as string)) {
      allOptions.push(defaultOpt);
    }
  }

  return allOptions;
}

export function ParameterForm({ schema, values, onChange, onSubmit, projectId }: ParameterFormProps) {
  const properties = schema.properties || {};
  const required = schema.required || [];

  // State to trigger re-render when path options change
  const [pathOptionsKey, setPathOptionsKey] = useState(0);

  // Check if we have any type/function name parameters that need the graph nodes lookup
  const hasTypeOrFunctionParams = useMemo(() => {
    return Object.entries(properties).some(
      ([key, prop]) => isTypeOrFunctionNameParam(key) && prop.type === 'string'
    );
  }, [properties]);

  // Check if we have any node ID parameters that need the graph nodes lookup
  const hasNodeIdParams = useMemo(() => {
    return Object.entries(properties).some(
      ([key, prop]) => isNodeIdParam(key) && prop.type === 'string'
    );
  }, [properties]);

  // Fetch instances for instanceId combo boxes
  const { data: instancesData, isLoading: instancesLoading } = useQuery({
    queryKey: ['instances'],
    queryFn: api.getInstances,
    staleTime: 60000,
  });

  const instanceOptions = (instancesData?.instances || []).map((inst) => ({
    label: inst.name,
    value: inst.id,
  }));

  // Fetch projects for projectId combo boxes (from AST cache which has pods with projectId)
  const { data: astCacheData, isLoading: projectsLoading } = useQuery({
    queryKey: ['all-ast-cache'],
    queryFn: api.getAllAstCache,
    staleTime: 60000,
  });

  // Convert AST cache pods to project options (filter to only those with projectId)
  const projectOptions = (astCacheData?.pods || [])
    .filter((pod) => pod.hasAstCache && pod.projectId)
    .map((pod) => ({
      value: pod.projectId as number,
      label: pod.podName,
      description: pod.instanceName
        ? `${pod.instanceName} - ID: ${pod.projectId}`
        : `ID: ${pod.projectId}`,
    }))
    // Remove duplicates by projectId
    .filter((opt, index, arr) => arr.findIndex((o) => o.value === opt.value) === index);

  // Check if we need to fetch backups based on schema properties
  const hasBackupParam = Object.keys(properties).some(isBackupParameter);

  // Fetch backups for backup combo boxes
  const { data: backupsData, isLoading: backupsLoading } = useQuery({
    queryKey: ['backups'],
    queryFn: api.listBackups,
    staleTime: 30000,
    enabled: hasBackupParam,
  });

  const backupOptions = backupsToOptions(backupsData?.backups || []);

  // Check if we need to fetch users based on schema properties
  const hasUserParam = Object.keys(properties).some(isUserParam);

  // Fetch users for user combo boxes
  const { data: usersData, isLoading: usersLoading } = useQuery({
    queryKey: ['users'],
    queryFn: api.getUsers,
    staleTime: 60000,
    enabled: hasUserParam,
  });

  // Convert users to combo box options (username as label, id as value)
  const userOptions = (usersData?.users || []).map((user) => ({
    value: user.id,
    label: user.username,
    description: `Role: ${user.role}`,
  }));

  // Fetch graph nodes for type/function name and nodeId lookups
  // Only fetch when we have type/function name parameters OR nodeId parameters
  const { data: graphNodesData, isLoading: graphNodesLoading } = useQuery({
    queryKey: ['graph-nodes-all', projectId],
    queryFn: () => api.searchGraphNodes('*', projectId),
    enabled: hasTypeOrFunctionParams || hasNodeIdParams,
    staleTime: 60000,
  });

  // Convert graph nodes to combo box options (using qualifiedName as value)
  const graphNodeOptions = useMemo(() => {
    if (!graphNodesData?.nodes) return [];
    return graphNodesToOptions(graphNodesData.nodes);
  }, [graphNodesData]);

  // Convert graph nodes to combo box options (using node ID/UUID as value)
  const nodeIdOptions = useMemo(() => {
    if (!graphNodesData?.nodes) return [];
    return graphNodesToIdOptions(graphNodesData.nodes);
  }, [graphNodesData]);

  // Check if we need to fetch pods based on schema properties
  const hasPodParam = Object.keys(properties).some(isPodParam);

  // Fetch Fantom pods for pod-related combo boxes
  const { data: podsData, isLoading: podsLoading } = useQuery({
    queryKey: ['fantom-pods'],
    queryFn: () => api.getFantomPods(),
    staleTime: 60000,
    enabled: hasPodParam,
  });

  // Convert pods to combo box options (pod name as both label and value)
  const podOptions = (podsData?.pods || []).map((pod) => ({
    value: pod.name,
    label: pod.name,
    description: pod.description || pod.path,
  }));

  // Check if we need to fetch versions based on schema properties
  const hasVersionParam = Object.keys(properties).some(isVersionParam);

  // Fetch Fantom versions for version-related combo boxes
  const { data: versionsData, isLoading: versionsLoading } = useQuery({
    queryKey: ['fantom-versions'],
    queryFn: api.getFantomVersions,
    staleTime: 60000,
    enabled: hasVersionParam,
  });

  // Convert versions to combo box options (version string as both label and value)
  const versionOptions = (versionsData?.versions || []).map((ver) => ({
    value: ver.version,
    label: ver.version,
  }));

  // Build path options (memoized but depends on pathOptionsKey to refresh)
  const pathOptions = useMemo(() => {
    return buildPathOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathOptionsKey]);

  // Handle path change - save to recent paths
  const handlePathChange = useCallback((key: string, newValue: string | number | null) => {
    const pathValue = newValue ? String(newValue) : undefined;
    onChange({ ...values, [key]: pathValue });

    // Save to recent paths if it's a valid path
    if (pathValue && pathValue.length > 1) {
      saveRecentPath(pathValue);
      // Trigger re-render to update path options
      setPathOptionsKey((prev) => prev + 1);
    }
  }, [onChange, values]);

  // Initialize default values
  useEffect(() => {
    const defaults: Record<string, unknown> = {};
    let hasDefaults = false;

    for (const [key, prop] of Object.entries(properties)) {
      if (prop.default !== undefined && values[key] === undefined) {
        defaults[key] = prop.default;
        hasDefaults = true;
      }
    }

    if (hasDefaults) {
      onChange({ ...values, ...defaults });
    }
  }, [schema]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleChange = (key: string, value: unknown) => {
    onChange({ ...values, [key]: value });
  };

  const propertyEntries = Object.entries(properties);

  if (propertyEntries.length === 0) {
    return (
      <div className="text-sm text-gray-500 italic py-4">
        This tool requires no parameters.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {propertyEntries.map(([key, prop]) => {
        const isRequired = required.includes(key);
        const value = values[key];

        return (
          <div key={key}>
            <label
              htmlFor={`param-${key}`}
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              {key}
              {isRequired && <span className="text-red-500 ml-1">*</span>}
            </label>

            {/* Enum/select input */}
            {prop.enum ? (
              <select
                id={`param-${key}`}
                value={(value as string) || ''}
                onChange={(e) => handleChange(key, e.target.value || undefined)}
                className="w-full rounded-md border border-gray-300 bg-white py-2 pl-3 pr-10 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="">Select...</option>
                {prop.enum.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            ) : prop.type === 'boolean' ? (
              /* Boolean checkbox */
              <div className="flex items-center">
                <input
                  id={`param-${key}`}
                  type="checkbox"
                  checked={!!value}
                  onChange={(e) => handleChange(key, e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="ml-2 text-sm text-gray-600">
                  {value ? 'true' : 'false'}
                </span>
              </div>
            ) : isInstanceIdParam(key) && (prop.type === 'number' || prop.type === 'integer') ? (
              /* Instance ID combo box */
              <SearchableComboBox
                options={instanceOptions}
                value={value as number | undefined}
                onChange={(newValue) => handleChange(key, newValue)}
                placeholder={instancesLoading ? 'Loading instances...' : 'Select an instance...'}
                disabled={instancesLoading}
              />
            ) : isProjectIdParam(key) && (prop.type === 'number' || prop.type === 'integer') ? (
              /* Project ID combo box */
              <SearchableComboBox
                options={projectOptions}
                value={value as number | null}
                onChange={(newValue) => handleChange(key, newValue)}
                placeholder={projectsLoading ? 'Loading projects...' : 'Select a project...'}
                isLoading={projectsLoading}
                disabled={projectsLoading}
              />
            ) : isBackupParameter(key) && prop.type === 'string' ? (
              /* Backup ID combo box */
              <SearchableComboBox
                options={backupOptions}
                value={(value as string) || null}
                onChange={(newValue) => handleChange(key, newValue)}
                placeholder={backupsLoading ? 'Loading backups...' : 'Select a backup...'}
                isLoading={backupsLoading}
                disabled={backupsLoading}
                emptyOptionsMessage="No backups available"
              />
            ) : isUserParam(key) && prop.type === 'string' ? (
              /* User combo box */
              <SearchableComboBox
                options={userOptions}
                value={(value as string) || null}
                onChange={(newValue) => handleChange(key, newValue)}
                placeholder={usersLoading ? 'Loading users...' : 'Select a user...'}
                isLoading={usersLoading}
                disabled={usersLoading}
                emptyOptionsMessage="No users available"
              />
            ) : isPathParameter(key, prop.type) ? (
              /* Path parameter combo box with free text */
              <SearchableComboBox
                options={pathOptions}
                value={(value as string) || null}
                onChange={(newValue) => handlePathChange(key, newValue)}
                placeholder="Enter or select a path..."
                searchPlaceholder="Type a path or search..."
                allowFreeText={true}
                emptySearchMessage="Type a path or select from suggestions"
                emptyOptionsMessage="Type a custom path"
              />
            ) : isNodeIdParam(key) && prop.type === 'string' ? (
              /* Node ID (UUID) combo box with searchable dropdown */
              <SearchableComboBox
                options={nodeIdOptions}
                value={(value as string | null) ?? null}
                onChange={(newValue) => handleChange(key, newValue)}
                placeholder={graphNodesLoading ? 'Loading nodes...' : 'Search or select a code node...'}
                isLoading={graphNodesLoading}
                searchPlaceholder="Search by name, type, or ID..."
                emptySearchMessage="No matching code nodes"
                emptyOptionsMessage={projectId ? 'No nodes indexed for this project' : 'Select a project to see available nodes'}
                clearable={true}
                allowFreeText={true}
              />
            ) : isTypeOrFunctionNameParam(key) && prop.type === 'string' ? (
              /* Type/Function name combo box with searchable dropdown */
              <SearchableComboBox
                options={graphNodeOptions}
                value={(value as string | null) ?? null}
                onChange={(newValue) => handleChange(key, newValue)}
                placeholder={graphNodesLoading ? 'Loading types/functions...' : 'Search or enter a name...'}
                isLoading={graphNodesLoading}
                searchPlaceholder="Search types and functions..."
                emptySearchMessage="No matching types or functions"
                emptyOptionsMessage={projectId ? 'No types/functions indexed for this project' : 'Select a project to see available types/functions'}
                clearable={true}
              />
            ) : prop.type === 'number' || prop.type === 'integer' ? (
              /* Number input */
              <input
                id={`param-${key}`}
                type="number"
                value={value !== undefined ? String(value) : ''}
                onChange={(e) =>
                  handleChange(
                    key,
                    e.target.value ? Number(e.target.value) : undefined
                  )
                }
                placeholder={prop.default !== undefined ? `Default: ${prop.default}` : undefined}
                className="w-full rounded-md border border-gray-300 py-2 px-3 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            ) : prop.type === 'array' ? (
              /* Array/textarea input (JSON) */
              <textarea
                id={`param-${key}`}
                value={value ? JSON.stringify(value, null, 2) : ''}
                onChange={(e) => {
                  try {
                    const parsed = e.target.value ? JSON.parse(e.target.value) : undefined;
                    handleChange(key, parsed);
                  } catch {
                    // Keep raw value for editing
                  }
                }}
                placeholder="Enter JSON array, e.g. [&quot;item1&quot;, &quot;item2&quot;]"
                rows={3}
                className="w-full rounded-md border border-gray-300 py-2 px-3 text-sm font-mono shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            ) : key.toLowerCase().includes('code') ||
              key.toLowerCase().includes('body') ||
              key.toLowerCase().includes('content') ? (
              /* Code/multiline textarea */
              <textarea
                id={`param-${key}`}
                value={(value as string) || ''}
                onChange={(e) => handleChange(key, e.target.value || undefined)}
                placeholder={prop.description || `Enter ${key}...`}
                rows={6}
                className="w-full rounded-md border border-gray-300 py-2 px-3 text-sm font-mono shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            ) : isPodParam(key) && prop.type === 'string' ? (
              /* Pod name combo box */
              <SearchableComboBox
                options={podOptions}
                value={(value as string) || null}
                onChange={(newValue) => handleChange(key, newValue || undefined)}
                placeholder={podsLoading ? 'Loading pods...' : 'Select a pod...'}
                isLoading={podsLoading}
                searchPlaceholder="Search pods..."
                emptySearchMessage="No matching pods"
                emptyOptionsMessage="No pods available"
              />
            ) : isVersionParam(key) && prop.type === 'string' ? (
              /* Version combo box */
              <SearchableComboBox
                options={versionOptions}
                value={(value as string) || null}
                onChange={(newValue) => handleChange(key, newValue || undefined)}
                placeholder={versionsLoading ? 'Loading versions...' : 'Select a version...'}
                isLoading={versionsLoading}
                searchPlaceholder="Search versions..."
                emptySearchMessage="No matching versions"
                emptyOptionsMessage="No versions available"
              />
            ) : getPredefinedOptions(key) ? (
              /* Predefined options combo box (nodeType, language, graphType) */
              <SearchableComboBox
                options={getPredefinedOptions(key)!}
                value={(value as string) || null}
                onChange={(newValue) => handleChange(key, newValue || undefined)}
                placeholder={`Select ${key}...`}
              />
            ) : (
              /* Default text input */
              <input
                id={`param-${key}`}
                type="text"
                value={(value as string) || ''}
                onChange={(e) => handleChange(key, e.target.value || undefined)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && onSubmit) {
                    e.preventDefault();
                    onSubmit();
                  }
                }}
                placeholder={prop.description || `Enter ${key}...`}
                className="w-full rounded-md border border-gray-300 py-2 px-3 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            )}

            {/* Description */}
            {prop.description && (
              <p className="mt-1 text-xs text-gray-500">{prop.description}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
