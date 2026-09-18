'use client';

import { useState, useCallback, useMemo, useEffect, Suspense, useRef } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api, McpTool, FantomInstance } from '@/lib/api';
import { callMcpToolWithDetails, McpToolCallDetails } from '@/lib/mcp';
import {
  isAuthenticated as checkMcpAuth,
  logout as mcpLogout,
  checkOAuthEnabled,
  autoAuthenticate,
} from '@/lib/mcpAuth';
import { ToolSelector } from '@/components/explorer/ToolSelector';
import { ParameterForm } from '@/components/explorer/ParameterForm';
import { VersionedApiSearchForm } from '@/components/explorer/VersionedApiSearchForm';
import { SchemaViewer } from '@/components/explorer/SchemaViewer';
import { McpRequestPreview } from '@/components/explorer/McpRequestPreview';
import { McpResponseViewer } from '@/components/explorer/McpResponseViewer';
import { SearchToolsSection } from '@/components/explorer/SearchToolsSection';
import { LlmPromptHelper } from '@/components/explorer/LlmPromptHelper';
import { AxonExplorerSearch } from '@/components/explorer/AxonExplorerSearch';

// Filter types
type InstanceTypeFilter = 'all' | 'skyspark' | 'haxall' | 'fantom';
type LanguageFilter = 'all' | 'fantom' | 'axon';
type SourceTypeFilter = 'all' | 'documentation' | 'code';
type VersionFilter = 'all' | string;
type McpFilter = 'all' | 'mcp' | 'dashboard';

// Loading fallback for Suspense
function ExplorerLoading() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="text-gray-500">Loading explorer...</div>
    </div>
  );
}

// Wrap the page in Suspense for useSearchParams
export default function ExplorerPage() {
  return (
    <Suspense fallback={<ExplorerLoading />}>
      <ExplorerContent />
    </Suspense>
  );
}

function ExplorerContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  // Get initial tool from URL
  const toolFromUrl = searchParams.get('tool');

  // Track if URL-based initialization has happened
  const initializedFromUrl = useRef(false);

  const [selectedTool, setSelectedTool] = useState<string | null>(toolFromUrl);
  const [parameters, setParameters] = useState<Record<string, unknown>>({});
  const [callDetails, setCallDetails] = useState<McpToolCallDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // OAuth authentication state
  const [mcpAuthenticated, setMcpAuthenticated] = useState<boolean>(false);
  const [oauthEnabled, setOauthEnabled] = useState<boolean | null>(null);
  const [authLoading, setAuthLoading] = useState(false);

  // Filter states
  const [instanceTypeFilter, setInstanceTypeFilter] = useState<InstanceTypeFilter>('all');
  const [languageFilter, setLanguageFilter] = useState<LanguageFilter>('all');
  const [sourceTypeFilter, setSourceTypeFilter] = useState<SourceTypeFilter>('all');
  const [versionFilter, setVersionFilter] = useState<VersionFilter>('all');
  const [instanceIdFilter, setInstanceIdFilter] = useState<number | 'all'>('all');
  const [mcpFilter, setMcpFilter] = useState<McpFilter>('all');

  // View toggle for schema section - persist in localStorage (default: hidden)
  const [showSchemaViewer, setShowSchemaViewer] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('explorer-showSchemaViewer');
      return saved === 'true'; // Default to false (hidden) if not set
    }
    return false;
  });

  // Persist showSchemaViewer to localStorage when it changes
  useEffect(() => {
    localStorage.setItem('explorer-showSchemaViewer', String(showSchemaViewer));
  }, [showSchemaViewer]);

  // Check OAuth status and auto-authenticate on mount
  useEffect(() => {
    const checkAndAutoAuth = async () => {
      // Check if OAuth is enabled on the server
      const enabled = await checkOAuthEnabled();
      setOauthEnabled(enabled);

      if (enabled) {
        // Try auto-authentication (uses stored admin credentials)
        setAuthLoading(true);
        try {
          const authenticated = await autoAuthenticate();
          setMcpAuthenticated(authenticated);
        } catch (err) {
          console.error('[Explorer] Auto-auth failed:', err);
          setMcpAuthenticated(false);
        } finally {
          setAuthLoading(false);
        }
      }
    };
    checkAndAutoAuth();
  }, []);

  // Handle OAuth logout
  const handleMcpLogout = () => {
    mcpLogout();
    setMcpAuthenticated(false);
  };

  // Handle re-authentication (tries auto-auth again)
  const handleReauthenticate = async () => {
    setAuthLoading(true);
    setError(null);
    try {
      const authenticated = await autoAuthenticate();
      setMcpAuthenticated(authenticated);
      if (!authenticated) {
        setError('Re-authentication failed. Please check your credentials.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Re-authentication failed');
    } finally {
      setAuthLoading(false);
    }
  };

  // Fetch available tools from admin API
  const { data: toolsData, isLoading: toolsLoading, error: toolsError } = useQuery({
    queryKey: ['tools'],
    queryFn: api.getTools,
    staleTime: 60000,
  });

  // Fetch instances to get available versions
  const { data: instancesData } = useQuery({
    queryKey: ['instances'],
    queryFn: api.getInstances,
    staleTime: 60000,
  });

  // Get unique versions from instances
  const availableVersions = useMemo(() => {
    const instances = instancesData?.instances || [];
    const versions = new Set<string>();
    instances.forEach((inst: FantomInstance) => {
      if (inst.version) versions.add(inst.version);
    });
    return Array.from(versions).sort((a, b) => b.localeCompare(a));
  }, [instancesData]);

  // Get instances filtered by type and version
  const filteredInstances = useMemo(() => {
    const instances = instancesData?.instances || [];
    return instances.filter((inst: FantomInstance) => {
      if (instanceTypeFilter !== 'all' && inst.type !== instanceTypeFilter) return false;
      if (versionFilter !== 'all' && inst.version !== versionFilter) return false;
      return true;
    });
  }, [instancesData, instanceTypeFilter, versionFilter]);

  const tools = toolsData?.tools || [];
  const selectedToolSchema = tools.find((t) => t.name === selectedTool);

  // Compute filter-based default parameters
  const getFilterBasedParams = useCallback((toolName: string): Record<string, unknown> => {
    const params: Record<string, unknown> = {};

    if (instanceTypeFilter !== 'all') {
      if (toolName === 'searchLocalDocs' || toolName === 'searchAll') {
        params.instanceType = instanceTypeFilter;
      }
    }

    if (instanceIdFilter !== 'all') {
      if (toolName === 'searchLocalDocs' || toolName === 'searchFantomCode' || toolName === 'indexInstanceDocs' || toolName === 'searchVersionedApi') {
        params.instanceId = instanceIdFilter;
      }
    }

    if (languageFilter !== 'all') {
      if (toolName === 'searchLocalDocs' || toolName === 'searchAll' || toolName === 'searchVersionedApi') {
        params.language = languageFilter;
      }
    }

    if (sourceTypeFilter !== 'all') {
      if (toolName === 'searchAll') {
        if (sourceTypeFilter === 'documentation') {
          params.sources = ['local-docs'];
        } else if (sourceTypeFilter === 'code') {
          params.sources = ['code'];
        }
      }
      if (toolName === 'searchVersionedApi') {
        if (sourceTypeFilter === 'documentation') {
          params.sources = ['local'];
        } else if (sourceTypeFilter === 'code') {
          params.sources = ['fantom-source'];
        }
      }
    }

    // Default mode for searchVersionedApi
    if (toolName === 'searchVersionedApi') {
      params.mode = 'all';
      params.limit = 10;

      // Pass version filter if set
      if (versionFilter !== 'all') {
        params.version = versionFilter;
      }
    }

    return params;
  }, [instanceTypeFilter, instanceIdFilter, languageFilter, sourceTypeFilter, versionFilter]);

  // Handle tool selection - also updates URL
  const handleToolSelect = useCallback((toolName: string | null, defaultParams?: Record<string, unknown>) => {
    setSelectedTool(toolName);
    const filterParams = toolName ? getFilterBasedParams(toolName) : {};
    setParameters({ ...filterParams, ...defaultParams });
    setCallDetails(null);
    setError(null);

    // Update URL with selected tool
    const params = new URLSearchParams(searchParams.toString());
    if (toolName) {
      params.set('tool', toolName);
    } else {
      params.delete('tool');
    }
    router.push(`/explorer?${params.toString()}`, { scroll: false });
  }, [getFilterBasedParams, router, searchParams]);

  // Initialize parameters when tool is loaded from URL (only once)
  useEffect(() => {
    // Skip if already initialized or no tool in URL
    if (initializedFromUrl.current || !toolFromUrl || !toolsData?.tools) {
      return;
    }

    const toolExists = toolsData.tools.some((t: McpTool) => t.name === toolFromUrl);
    if (toolExists) {
      const filterParams = getFilterBasedParams(toolFromUrl);
      setParameters(filterParams);
      initializedFromUrl.current = true;
    }
  }, [toolFromUrl, toolsData, getFilterBasedParams]);

  // Handle filter changes - update both filter state and parameters
  const handleFilterChange = useCallback((
    filterType: 'instanceType' | 'language' | 'sourceType' | 'version' | 'instanceId',
    value: string | number
  ) => {
    if (filterType === 'instanceType') {
      setInstanceTypeFilter(value as InstanceTypeFilter);
      setInstanceIdFilter('all');
    } else if (filterType === 'language') {
      setLanguageFilter(value as LanguageFilter);
    } else if (filterType === 'sourceType') {
      setSourceTypeFilter(value as SourceTypeFilter);
    } else if (filterType === 'version') {
      setVersionFilter(value as VersionFilter);
      setInstanceIdFilter('all');
      // Also update parameters if searchVersionedApi is selected
      if (selectedTool === 'searchVersionedApi') {
        setParameters(prev => ({
          ...prev,
          version: value === 'all' ? undefined : value,
          instanceId: undefined // Clear instanceId when version is set
        }));
      }
    } else if (filterType === 'instanceId') {
      setInstanceIdFilter(value === 'all' ? 'all' : Number(value));
      // Also update parameters for tools that use instanceId
      if (selectedTool === 'searchVersionedApi' || selectedTool === 'searchLocalDocs' || selectedTool === 'searchFantomCode') {
        setParameters(prev => ({
          ...prev,
          instanceId: value === 'all' ? undefined : Number(value),
          version: undefined // Clear version when instanceId is set
        }));
      }
    }
  }, [selectedTool]);

  // Execute the selected tool with detailed capture
  const handleExecute = async (retryAfterReauth = false) => {
    if (!selectedTool) return;

    setLoading(true);
    setError(null);
    if (!retryAfterReauth) {
      setCallDetails(null);
    }

    try {
      // Filter out undefined parameters
      const cleanParams: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(parameters)) {
        if (value !== undefined && value !== '') {
          cleanParams[key] = value;
        }
      }

      const details = await callMcpToolWithDetails(selectedTool, cleanParams);

      // Check if authentication is required - try to auto-reauthenticate
      if ('needsAuth' in details && details.needsAuth) {
        setMcpAuthenticated(false);
        // Try auto-reauthentication
        const reauthed = await autoAuthenticate();
        if (reauthed) {
          setMcpAuthenticated(true);
          // Automatically retry the request after successful re-authentication
          if (!retryAfterReauth) {
            setLoading(false);
            return handleExecute(true);
          }
          // If retry also failed, show error
          setError('Re-authentication succeeded but request still failed. Please try again.');
        } else {
          setError('Authentication required. Your session may have expired.');
        }
        return;
      }

      setCallDetails(details);

      if (details.isError) {
        // Error is handled by McpResponseViewer
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error occurred';
      // Handle OAuth required error - try to auto-reauthenticate
      if (message === 'OAUTH_REQUIRED') {
        setMcpAuthenticated(false);
        const reauthed = await autoAuthenticate();
        if (reauthed) {
          setMcpAuthenticated(true);
          // Automatically retry the request after successful re-authentication
          if (!retryAfterReauth) {
            setLoading(false);
            return handleExecute(true);
          }
          // If retry also failed, show error
          setError('Re-authentication succeeded but request still failed. Please try again.');
        } else {
          setError('Authentication required. Your session may have expired.');
        }
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  };

  // Clear results
  const handleClear = () => {
    setCallDetails(null);
    setError(null);
  };

  if (toolsLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading tools...</div>
      </div>
    );
  }

  if (toolsError) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <h2 className="text-red-800 font-medium">Failed to load tools</h2>
        <p className="text-red-600 mt-1">
          {toolsError instanceof Error ? toolsError.message : 'Unknown error'}
        </p>
        <p className="text-red-500 text-sm mt-2">
          Make sure the MCP server is running with HTTP transport (MCP_TRANSPORT=http).
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header with OAuth Status */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">MCP Explorer</h1>
          <p className="text-gray-600 mt-1">
            {tools.filter(t => t.mcpExposed).length} MCP tools / {tools.length} total.{' '}
            Test and explore tools. See exactly what LLMs receive.
          </p>
        </div>

        {/* OAuth Authentication Status */}
        {oauthEnabled && (
          <div className="flex items-center gap-3">
            {authLoading ? (
              <div className="flex items-center gap-2 px-3 py-1.5 bg-blue-50 border border-blue-200 rounded-full">
                <svg className="animate-spin h-3 w-3 text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <span className="text-sm text-blue-700 font-medium">Authenticating...</span>
              </div>
            ) : mcpAuthenticated ? (
              <>
                <div className="flex items-center gap-2 px-3 py-1.5 bg-green-50 border border-green-200 rounded-full">
                  <div className="h-2 w-2 rounded-full bg-green-500" />
                  <span className="text-sm text-green-700 font-medium">MCP Authenticated</span>
                </div>
                <button
                  onClick={handleMcpLogout}
                  className="text-sm text-gray-500 hover:text-gray-700"
                >
                  Logout
                </button>
              </>
            ) : (
              <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-full">
                <div className="h-2 w-2 rounded-full bg-amber-500" />
                <span className="text-sm text-amber-700 font-medium">Auth Required</span>
              </div>
            )}
          </div>
        )}

        {/* OAuth checking/disabled state */}
        {oauthEnabled === null && (
          <div className="text-sm text-gray-400">Checking OAuth status...</div>
        )}
        {oauthEnabled === false && (
          <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-full">
            <div className="h-2 w-2 rounded-full bg-gray-400" />
            <span className="text-sm text-gray-600">OAuth Disabled</span>
          </div>
        )}
      </div>

      {/* OAuth Required Warning */}
      {oauthEnabled && !mcpAuthenticated && !authLoading && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <svg className="h-5 w-5 text-amber-600 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div className="flex-1">
              <h3 className="text-sm font-medium text-amber-800">Authentication Required</h3>
              <p className="text-sm text-amber-700 mt-1">
                Auto-authentication failed. This may happen if your session expired or credentials changed.
              </p>
              <button
                onClick={handleReauthenticate}
                disabled={authLoading}
                className="mt-2 px-3 py-1.5 text-sm bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50 transition-colors"
              >
                {authLoading ? 'Authenticating...' : 'Retry Authentication'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Search Tools Section - Prominent cards for main search tools */}
      <SearchToolsSection
        tools={tools}
        onSelectTool={handleToolSelect}
        selectedTool={selectedTool}
      />

      {/* Filters Section */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="flex flex-wrap items-center gap-4">
          <h3 className="text-sm font-medium text-gray-700">Filters:</h3>

          {/* MCP / Dashboard Filter */}
          <div className="flex items-center gap-1 bg-gray-100 rounded-md p-0.5">
            {(['all', 'mcp', 'dashboard'] as const).map((value) => (
              <button
                key={value}
                onClick={() => setMcpFilter(value)}
                className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                  mcpFilter === value
                    ? value === 'mcp'
                      ? 'bg-green-600 text-white'
                      : value === 'dashboard'
                        ? 'bg-gray-600 text-white'
                        : 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                {value === 'all' ? 'All' : value === 'mcp' ? 'MCP Only' : 'Dashboard Only'}
              </button>
            ))}
          </div>

          {/* Instance Type Filter */}
          <div className="flex items-center gap-2">
            <label htmlFor="instance-type-filter" className="text-sm text-gray-600">Type</label>
            <select
              id="instance-type-filter"
              value={instanceTypeFilter}
              onChange={(e) => handleFilterChange('instanceType', e.target.value)}
              className="rounded-md border border-gray-300 bg-white py-1.5 pl-3 pr-8 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="all">All Types</option>
              <option value="skyspark">SkySpark</option>
              <option value="haxall">Haxall</option>
              <option value="fantom">Fantom</option>
            </select>
          </div>

          {/* Version Filter */}
          <div className="flex items-center gap-2">
            <label htmlFor="version-filter" className="text-sm text-gray-600">Version</label>
            <select
              id="version-filter"
              value={versionFilter}
              onChange={(e) => handleFilterChange('version', e.target.value)}
              className="rounded-md border border-gray-300 bg-white py-1.5 pl-3 pr-8 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="all">All Versions</option>
              {availableVersions.map((version) => (
                <option key={version} value={version}>{version}</option>
              ))}
            </select>
          </div>

          {/* Instance Filter */}
          {filteredInstances.length > 0 && (
            <div className="flex items-center gap-2">
              <label htmlFor="instance-filter" className="text-sm text-gray-600">Instance</label>
              <select
                id="instance-filter"
                value={instanceIdFilter}
                onChange={(e) => handleFilterChange('instanceId', e.target.value)}
                className="rounded-md border border-gray-300 bg-white py-1.5 pl-3 pr-8 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="all">All Instances ({filteredInstances.length})</option>
                {filteredInstances.map((inst: FantomInstance) => (
                  <option key={inst.id} value={inst.id}>
                    {inst.name} ({inst.type} {inst.version})
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Language Filter */}
          <div className="flex items-center gap-2">
            <label htmlFor="language-filter" className="text-sm text-gray-600">Language</label>
            <select
              id="language-filter"
              value={languageFilter}
              onChange={(e) => handleFilterChange('language', e.target.value)}
              className="rounded-md border border-gray-300 bg-white py-1.5 pl-3 pr-8 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="all">All</option>
              <option value="fantom">Fantom</option>
              <option value="axon">Axon</option>
            </select>
          </div>

          {/* Source Type Filter */}
          <div className="flex items-center gap-2">
            <label htmlFor="source-type-filter" className="text-sm text-gray-600">Source</label>
            <select
              id="source-type-filter"
              value={sourceTypeFilter}
              onChange={(e) => handleFilterChange('sourceType', e.target.value)}
              className="rounded-md border border-gray-300 bg-white py-1.5 pl-3 pr-8 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="all">All</option>
              <option value="documentation">Documentation</option>
              <option value="code">Code</option>
            </select>
          </div>

          {/* Clear filters */}
          {(instanceTypeFilter !== 'all' || languageFilter !== 'all' || sourceTypeFilter !== 'all' || versionFilter !== 'all' || instanceIdFilter !== 'all' || mcpFilter !== 'all') && (
            <button
              onClick={() => {
                setInstanceTypeFilter('all');
                setLanguageFilter('all');
                setSourceTypeFilter('all');
                setVersionFilter('all');
                setInstanceIdFilter('all');
                setMcpFilter('all');
              }}
              className="text-xs text-blue-600 hover:text-blue-800 underline"
            >
              Clear filters
            </button>
          )}
        </div>

        {/* Active filter summary */}
        {(instanceTypeFilter !== 'all' || versionFilter !== 'all' || instanceIdFilter !== 'all' || languageFilter !== 'all' || mcpFilter !== 'all') && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <div className="flex flex-wrap gap-2">
              {mcpFilter !== 'all' && (
                <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                  mcpFilter === 'mcp' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                }`}>
                  {mcpFilter === 'mcp' ? 'MCP Tools Only' : 'Dashboard Tools Only'}
                </span>
              )}
              {instanceTypeFilter !== 'all' && (
                <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                  Type: {instanceTypeFilter}
                </span>
              )}
              {versionFilter !== 'all' && (
                <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                  Version: {versionFilter}
                </span>
              )}
              {instanceIdFilter !== 'all' && (
                <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
                  Instance ID: {instanceIdFilter}
                </span>
              )}
              {languageFilter !== 'all' && (
                <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-orange-100 text-orange-800">
                  Language: {languageFilter}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Language = Axon: semantic search over embedded Axon functions (proj + offline library) */}
      {languageFilter === 'axon' && <AxonExplorerSearch />}

      {/* Main content - two column layout */}
      <div className={`grid grid-cols-1 lg:grid-cols-2 gap-6 ${languageFilter === 'axon' ? 'hidden' : ''}`}>
        {/* Left Panel: Tool Selection & Configuration */}
        <div className="space-y-6">
          {/* Tool Selection */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Tool Selection</h2>

            <ToolSelector
              tools={tools}
              selected={selectedTool}
              onSelect={(name) => handleToolSelect(name)}
              mcpFilter={mcpFilter}
            />

            {selectedToolSchema && (
              <div className="mt-6">
                {/* Tool description with MCP badge */}
                <div className="mb-4 p-3 bg-blue-50 rounded-lg">
                  <div className="flex items-center gap-2 mb-1">
                    {selectedToolSchema.mcpExposed ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                        Available to Claude
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                        <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
                        Dashboard Only
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-blue-800">{selectedToolSchema.description}</p>
                </div>

                {/* Schema Viewer Toggle */}
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-md font-medium text-gray-700">Parameters</h3>
                  <button
                    onClick={() => setShowSchemaViewer(!showSchemaViewer)}
                    className="text-xs text-blue-600 hover:text-blue-800"
                  >
                    {showSchemaViewer ? 'Hide Schema' : 'Show Schema'}
                  </button>
                </div>

                {/* Schema Viewer - Rich parameter visualization */}
                {showSchemaViewer && (
                  <div className="mb-4">
                    <SchemaViewer
                      toolName={selectedToolSchema.name}
                      schema={selectedToolSchema.inputSchema}
                      description={selectedToolSchema.description}
                    />
                  </div>
                )}

                {/* Parameter Form - Use specialized form for searchVersionedApi */}
                {selectedTool === 'searchVersionedApi' ? (
                  <VersionedApiSearchForm
                    values={parameters}
                    onChange={setParameters}
                    onSubmit={() => handleExecute()}
                  />
                ) : (
                  <ParameterForm
                    schema={selectedToolSchema.inputSchema}
                    values={parameters}
                    onChange={setParameters}
                    onSubmit={() => handleExecute()}
                  />
                )}
              </div>
            )}

            {/* Action buttons */}
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => handleExecute()}
                disabled={!selectedTool || loading}
                className="flex-1 bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Executing...
                  </span>
                ) : (
                  'Execute Tool'
                )}
              </button>
              {(callDetails !== null || error) && (
                <button
                  onClick={handleClear}
                  className="px-4 py-2 text-gray-600 bg-gray-100 rounded-md hover:bg-gray-200 transition-colors"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* MCP Request Preview - Live JSON-RPC preview */}
          <McpRequestPreview
            toolName={selectedTool}
            parameters={parameters}
          />

          {/* LLM Prompt Helper */}
          <LlmPromptHelper
            toolName={selectedTool}
            toolDescription={selectedToolSchema?.description}
            parameters={parameters}
          />
        </div>

        {/* Right Panel: Results with Raw/Parsed tabs */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Results</h2>
          <McpResponseViewer
            details={callDetails}
            loading={loading}
            error={error}
          />
        </div>
      </div>
    </div>
  );
}
