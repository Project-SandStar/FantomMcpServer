'use client';

import { useState, useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, AstCacheOverview } from '@/lib/api';
import dynamic from 'next/dynamic';

// Dynamically import GraphViewer to avoid SSR issues with Cytoscape
const GraphViewer = dynamic(
  () => import('@/components/GraphViewer').then(mod => mod.GraphViewer),
  { ssr: false, loading: () => <GraphLoading /> }
);

// ============================================
// Types
// ============================================

import type { GraphData } from '@/components/GraphViewer';

type GraphType = 'subgraph' | 'callers' | 'callees' | 'impact' | 'project' | 'modules';
type LayoutType = 'cose' | 'dagre' | 'breadthfirst' | 'circle' | 'concentric' | 'grid';

interface NodeSearchResult {
  id: string;
  name: string;
  qualifiedName: string;
  nodeType: string;
  filePath: string;
  lineStart: number;
  projectId: number;
}

// ============================================
// Loading Component
// ============================================

function GraphLoading() {
  return (
    <div className="flex items-center justify-center h-96 bg-gray-50 rounded-lg">
      <div className="flex flex-col items-center space-y-4">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
        <div className="text-gray-500">Loading graph viewer...</div>
      </div>
    </div>
  );
}

// ============================================
// API Functions
// ============================================

async function searchNodes(query: string, projectId?: number): Promise<{ nodes: NodeSearchResult[] }> {
  const apiBase = typeof window !== 'undefined' ? localStorage.getItem('server_url') || '' : '';
  const username = typeof window !== 'undefined' ? localStorage.getItem('admin_user') || 'admin' : 'admin';
  const password = typeof window !== 'undefined' ? localStorage.getItem('admin_pass') || 'admin' : 'admin';
  const authHeader = 'Basic ' + btoa(`${username}:${password}`);

  const params = new URLSearchParams({ q: query });
  if (projectId) params.append('projectId', projectId.toString());

  const response = await fetch(`${apiBase}/admin/graph/nodes/search?${params}`, {
    headers: { 'Authorization': authHeader }
  });

  if (!response.ok) throw new Error('Failed to search nodes');
  return response.json();
}

async function fetchGraphData(
  nodeId: string | null,
  qualifiedName: string | null,
  projectId: number | null,
  graphType: GraphType,
  depth: number,
  maxNodes: number
): Promise<GraphData> {
  const apiBase = typeof window !== 'undefined' ? localStorage.getItem('server_url') || '' : '';
  const username = typeof window !== 'undefined' ? localStorage.getItem('admin_user') || 'admin' : 'admin';
  const password = typeof window !== 'undefined' ? localStorage.getItem('admin_pass') || 'admin' : 'admin';
  const authHeader = 'Basic ' + btoa(`${username}:${password}`);

  const params = new URLSearchParams({
    graphType,
    depth: depth.toString(),
    maxNodes: maxNodes.toString()
  });

  if (nodeId) params.append('nodeId', nodeId);
  if (qualifiedName) params.append('qualifiedName', qualifiedName);
  if (projectId) params.append('projectId', projectId.toString());

  // Use the indexer-based endpoint which works with in-memory indexed data
  const response = await fetch(`${apiBase}/admin/graph/visualize-indexer?${params}`, {
    headers: { 'Authorization': authHeader }
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to fetch graph data');
  }
  return response.json();
}

// ============================================
// Graph Viewer Page
// ============================================

type NodeTypeFilter = 'all' | 'class' | 'method' | 'function' | 'interface';

export default function GraphViewerPage() {
  // State
  const [selectedProject, setSelectedProject] = useState<number | null>(null);
  const [selectedProjectName, setSelectedProjectName] = useState<string>('');
  const [projectSearchQuery, setProjectSearchQuery] = useState('');
  const [showProjectDropdown, setShowProjectDropdown] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNodeName, setSelectedNodeName] = useState<string>('');
  const [graphType, setGraphType] = useState<GraphType>('subgraph');
  const [layout, setLayout] = useState<LayoutType>('cose');
  const [depth, setDepth] = useState(2);
  const [maxNodes, setMaxNodes] = useState(500);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearchResults, setShowSearchResults] = useState(false);
  const [selectedLanguage, setSelectedLanguage] = useState<string | null>(null);
  const [searchNodeType, setSearchNodeType] = useState<NodeTypeFilter>('all');
  const [minConnections, setMinConnections] = useState(0); // Minimum edge count filter
  const [showIsolatedNodes, setShowIsolatedNodes] = useState(true); // Show nodes with 0 connections
  const [showDetailedStats, setShowDetailedStats] = useState(false); // Toggle detailed statistics panel

  // Fetch projects (code projects from AST cache)
  const { data: astData } = useQuery({
    queryKey: ['all-ast-cache'],
    queryFn: api.getAllAstCache,
  });

  // Get unique projects from pods
  const projects = astData?.pods
    ?.filter(p => p.hasAstCache && p.projectId)
    ?.map(p => ({
      id: p.projectId!,
      name: p.podName,
      podId: p.podId
    }))
    ?.filter((p, i, arr) => arr.findIndex(x => x.id === p.id) === i) || [];

  // Filter projects client-side based on search query
  const filteredProjects = useMemo(() => {
    if (!projectSearchQuery.trim()) return projects;
    const query = projectSearchQuery.toLowerCase().trim();
    return projects.filter(p => p.name.toLowerCase().includes(query));
  }, [projects, projectSearchQuery]);

  // Fetch all nodes when dropdown is open - filter client-side for responsiveness
  const { data: allNodes, isLoading: isLoadingNodes } = useQuery({
    queryKey: ['all-nodes', selectedProject],
    queryFn: () => searchNodes('*', selectedProject ?? undefined),
    enabled: selectedProject !== null && showSearchResults,
    staleTime: 30000,  // Cache for 30 seconds
  });

  // Filter nodes client-side based on search query and type filter
  const filteredNodes = useMemo(() => {
    if (!allNodes?.nodes) return [];

    let results = allNodes.nodes;

    // Filter by node type
    if (searchNodeType !== 'all') {
      results = results.filter(node => node.nodeType === searchNodeType);
    }

    // Filter by search query (case-insensitive)
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      results = results.filter(node =>
        node.name.toLowerCase().includes(query) ||
        node.qualifiedName.toLowerCase().includes(query)
      );
    }

    return results;
  }, [allNodes, searchQuery, searchNodeType]);

  // Fetch graph data
  const needsProjectOnly = graphType === 'project' || graphType === 'modules';
  const { data: graphData, isLoading: isLoadingGraph, error: graphError, refetch: refetchGraph } = useQuery({
    queryKey: ['graph-data', selectedNodeId, selectedProject, graphType, depth, maxNodes],
    queryFn: () => fetchGraphData(
      selectedNodeId,
      null,
      needsProjectOnly ? selectedProject : null,
      graphType,
      depth,
      maxNodes
    ),
    enabled: Boolean(selectedNodeId) || (needsProjectOnly && Boolean(selectedProject)),
  });

  // Handlers
  const handleProjectSelect = useCallback((project: { id: number; name: string }) => {
    setSelectedProject(project.id);
    setSelectedProjectName(project.name);
    setProjectSearchQuery('');
    setShowProjectDropdown(false);
    // Clear node selection when project changes
    setSelectedNodeId(null);
    setSelectedNodeName('');
  }, []);

  const handleNodeSelect = useCallback((node: NodeSearchResult) => {
    setSelectedNodeId(node.id);
    setSelectedNodeName(node.name);
    setSearchQuery('');
    setShowSearchResults(false);
  }, []);

  const handleGraphNodeClick = useCallback((node: { id: string; label: string }) => {
    // Could update selection or show details
    console.log('Clicked node:', node);
  }, []);

  const handleGraphNodeDoubleClick = useCallback((node: { id: string }) => {
    // Navigate to this node as the new focal point
    setSelectedNodeId(node.id);
  }, []);

  // Convert graph data to DOT format
  const convertToDot = useCallback((data: typeof graphData): string => {
    if (!data) return '';

    const lines: string[] = ['digraph G {'];
    lines.push('  // Graph settings');
    lines.push('  rankdir=TB;');
    lines.push('  node [fontname="Arial", fontsize=10];');
    lines.push('  edge [fontname="Arial", fontsize=8];');
    lines.push('');

    // Node type to shape mapping
    const nodeShapes: Record<string, string> = {
      class: 'box',
      interface: 'box',
      method: 'ellipse',
      function: 'ellipse',
      field: 'diamond',
      type: 'box',
      file: 'folder',
      'css-rule': 'note',
      default: 'ellipse'
    };

    // Node type to color mapping
    const nodeColors: Record<string, string> = {
      class: '#4B8BBE',
      interface: '#9B59B6',
      method: '#306998',
      function: '#2ECC71',
      field: '#9B59B6',
      type: '#4B8BBE',
      file: '#607D8B',
      'css-rule': '#264DE4',
      default: '#95A5A6'
    };

    // Edge type to style mapping
    const edgeStyles: Record<string, { style: string; color: string }> = {
      calls: { style: 'solid', color: '#2C3E50' },
      extends: { style: 'dashed', color: '#E74C3C' },
      implements: { style: 'dotted', color: '#3498DB' },
      contains: { style: 'solid', color: '#95A5A6' },
      imports: { style: 'dashed', color: '#00BCD4' },
      'uses-css': { style: 'dotted', color: '#E91E63' },
      default: { style: 'solid', color: '#666666' }
    };

    // Add nodes
    lines.push('  // Nodes');
    for (const node of data.elements.nodes) {
      if (node.data.isGroup) continue; // Skip group nodes

      const id = node.data.id.replace(/[^a-zA-Z0-9_]/g, '_');
      const label = (node.data.label || node.data.id).replace(/"/g, '\\"');
      const shape = nodeShapes[node.data.nodeType] || nodeShapes.default;
      const color = nodeColors[node.data.nodeType] || nodeColors.default;

      lines.push(`  "${id}" [label="${label}", shape=${shape}, style=filled, fillcolor="${color}40", color="${color}"];`);
    }
    lines.push('');

    // Add edges
    lines.push('  // Edges');
    for (const edge of data.elements.edges) {
      const source = edge.data.source.replace(/[^a-zA-Z0-9_]/g, '_');
      const target = edge.data.target.replace(/[^a-zA-Z0-9_]/g, '_');
      const edgeType = edge.data.edgeType || 'default';
      const style = edgeStyles[edgeType] || edgeStyles.default;

      lines.push(`  "${source}" -> "${target}" [label="${edgeType}", style=${style.style}, color="${style.color}"];`);
    }

    lines.push('}');
    return lines.join('\n');
  }, []);

  const handleExport = useCallback(async (format: 'json' | 'dot') => {
    if (!graphData) return;

    let content: string;
    let filename: string;
    let mimeType: string;

    if (format === 'json') {
      content = JSON.stringify(graphData, null, 2);
      filename = `graph-${selectedNodeName || 'export'}.json`;
      mimeType = 'application/json';
    } else {
      // Convert to DOT format for GraphViz
      content = convertToDot(graphData);
      filename = `graph-${selectedNodeName || 'export'}.dot`;
      mimeType = 'text/vnd.graphviz';
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [graphData, selectedNodeName, convertToDot]);

  // Calculate detailed graph statistics
  const graphStats = useMemo(() => {
    if (!graphData) return null;

    const nodes = graphData.elements.nodes;
    const edges = graphData.elements.edges;

    // Edge type distribution
    const edgeTypeCounts = new Map<string, number>();
    for (const edge of edges) {
      const type = edge.data.edgeType || 'unknown';
      edgeTypeCounts.set(type, (edgeTypeCounts.get(type) || 0) + 1);
    }

    // Node type distribution
    const nodeTypeCounts = new Map<string, number>();
    for (const node of nodes) {
      if (!node.data.isGroup) {
        const type = node.data.nodeType || 'unknown';
        nodeTypeCounts.set(type, (nodeTypeCounts.get(type) || 0) + 1);
      }
    }

    // Calculate connectivity metrics
    const nodeEdgeCounts = new Map<string, number>();
    for (const node of nodes) {
      if (!node.data.isGroup) {
        nodeEdgeCounts.set(node.data.id, 0);
      }
    }
    for (const edge of edges) {
      nodeEdgeCounts.set(edge.data.source, (nodeEdgeCounts.get(edge.data.source) || 0) + 1);
      nodeEdgeCounts.set(edge.data.target, (nodeEdgeCounts.get(edge.data.target) || 0) + 1);
    }

    // Find top connected nodes (hubs)
    const nodeConnections = Array.from(nodeEdgeCounts.entries())
      .map(([id, count]) => {
        const node = nodes.find(n => n.data.id === id);
        return { id, count, name: node?.data.label || id, type: node?.data.nodeType || 'unknown' };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Calculate average connections
    const totalConnections = Array.from(nodeEdgeCounts.values()).reduce((a, b) => a + b, 0);
    const avgConnections = nodeEdgeCounts.size > 0 ? totalConnections / nodeEdgeCounts.size : 0;

    // Count isolated nodes (0 connections)
    const isolatedCount = Array.from(nodeEdgeCounts.values()).filter(c => c === 0).length;

    return {
      edgeTypes: Array.from(edgeTypeCounts.entries()).sort((a, b) => b[1] - a[1]),
      nodeTypes: Array.from(nodeTypeCounts.entries()).sort((a, b) => b[1] - a[1]),
      topHubs: nodeConnections,
      avgConnections: avgConnections.toFixed(1),
      maxConnections: nodeConnections[0]?.count || 0,
      isolatedCount
    };
  }, [graphData]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Graph Viewer</h1>
          <p className="text-gray-600 mt-1">
            Visualize code relationships - call graphs, dependencies, and impact analysis
          </p>
        </div>
        {graphData && (
          <div className="flex gap-2">
            <button
              onClick={() => handleExport('json')}
              className="px-3 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Export JSON
            </button>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Project Selector Combobox */}
          <div className="relative">
            <label className="block text-sm font-medium text-gray-700 mb-1">Project</label>
            <div
              className={`flex items-center w-full border rounded-lg bg-white transition-colors ${
                showProjectDropdown ? 'border-blue-500 ring-2 ring-blue-500' : 'border-gray-300'
              }`}
            >
              {/* Search Icon */}
              <div className="pl-3 text-gray-400">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>

              {/* Input */}
              <input
                type="text"
                value={showProjectDropdown ? projectSearchQuery : (selectedProjectName || '')}
                onChange={(e) => {
                  setProjectSearchQuery(e.target.value);
                  if (!showProjectDropdown) setShowProjectDropdown(true);
                }}
                onFocus={() => {
                  setShowProjectDropdown(true);
                  setProjectSearchQuery('');
                }}
                onBlur={(e) => {
                  // Delay to allow click on dropdown items
                  setTimeout(() => {
                    if (!e.currentTarget.contains(document.activeElement)) {
                      setShowProjectDropdown(false);
                    }
                  }, 200);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setShowProjectDropdown(false);
                    e.currentTarget.blur();
                  }
                }}
                placeholder={selectedProjectName ? '' : 'Search projects...'}
                className="flex-1 px-2 py-2 bg-transparent focus:outline-none"
              />

              {/* Clear button (when project selected) */}
              {selectedProjectName && !showProjectDropdown && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedProject(null);
                    setSelectedProjectName('');
                    setProjectSearchQuery('');
                    setSelectedNodeId(null);
                    setSelectedNodeName('');
                  }}
                  className="p-1.5 mr-1 hover:bg-gray-100 rounded text-gray-400 hover:text-gray-600"
                  title="Clear selection"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}

              {/* Dropdown arrow */}
              <button
                onClick={() => setShowProjectDropdown(!showProjectDropdown)}
                className="p-2 text-gray-400 hover:text-gray-600"
              >
                <svg className={`w-5 h-5 transition-transform ${showProjectDropdown ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            </div>

            {/* Dropdown */}
            {showProjectDropdown && (
              <div className="absolute z-20 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-xl max-h-64 overflow-y-auto">
                {filteredProjects.length > 0 ? (
                  <div className="py-1">
                    {/* Results count header */}
                    <div className="px-3 py-2 bg-gray-50 text-xs text-gray-500 border-b border-gray-100 sticky top-0">
                      {projectSearchQuery ? (
                        <span>
                          <strong>{filteredProjects.length}</strong> {filteredProjects.length === 1 ? 'result' : 'results'} for "{projectSearchQuery}"
                        </span>
                      ) : (
                        <span>
                          <strong>{filteredProjects.length}</strong> projects available
                        </span>
                      )}
                    </div>
                    {/* Project list */}
                    {filteredProjects.map(project => (
                      <button
                        key={project.id}
                        onClick={() => handleProjectSelect(project)}
                        className={`w-full text-left px-3 py-2 hover:bg-blue-50 transition-colors ${
                          selectedProject === project.id ? 'bg-blue-100' : ''
                        }`}
                      >
                        <div className="font-medium text-gray-900">{project.name}</div>
                        <div className="text-xs text-gray-500">ID: {project.id}</div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="p-4 text-center text-gray-500">
                    {projectSearchQuery ? (
                      <span>No projects matching "{projectSearchQuery}"</span>
                    ) : (
                      <span>No projects available</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Graph Type */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Graph Type</label>
            <select
              value={graphType}
              onChange={(e) => setGraphType(e.target.value as GraphType)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="subgraph">Subgraph (Both directions)</option>
              <option value="callers">Callers (Who calls this?)</option>
              <option value="callees">Callees (What does this call?)</option>
              <option value="impact">Impact Analysis</option>
              <option value="project">Full Project</option>
              <option value="modules">📁 Module Dependencies</option>
            </select>
          </div>

          {/* Layout */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Layout</label>
            <select
              value={layout}
              onChange={(e) => setLayout(e.target.value as LayoutType)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="cose">Force-Directed (COSE)</option>
              <option value="dagre">Hierarchical (Dagre)</option>
              <option value="breadthfirst">Breadth-First</option>
              <option value="concentric">Concentric</option>
              <option value="circle">Circle</option>
              <option value="grid">Grid</option>
            </select>
          </div>

          {/* Depth & Max Nodes */}
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-1">
                Depth
                <span
                  className="inline-flex items-center justify-center w-4 h-4 text-xs bg-gray-200 text-gray-600 rounded-full cursor-help"
                  title="Number of relationship levels to traverse. Depth 1 = direct connections only. Depth 2 = connections of connections. Higher depth shows more of the call graph but may be slower."
                >
                  ?
                </span>
              </label>
              <input
                type="number"
                min={1}
                max={30}
                value={depth}
                onChange={(e) => setDepth(Math.min(30, Math.max(1, parseInt(e.target.value, 10) || 2)))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-1">
                Max Nodes
                <span
                  className="inline-flex items-center justify-center w-4 h-4 text-xs bg-gray-200 text-gray-600 rounded-full cursor-help"
                  title="Maximum number of nodes to show in the graph. GPU-accelerated rendering supports up to 10,000 nodes."
                >
                  ?
                </span>
              </label>
              <input
                type="number"
                min={10}
                max={10000}
                step={100}
                value={maxNodes}
                onChange={(e) => setMaxNodes(Math.min(10000, Math.max(10, parseInt(e.target.value, 10) || 100)))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
          </div>

          {/* Min Connections Filter */}
          <div className="mt-3">
            <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-1">
              Min Connections
              <span
                className="inline-flex items-center justify-center w-4 h-4 text-xs bg-gray-200 text-gray-600 rounded-full cursor-help"
                title="Filter nodes by minimum number of connections. Higher values show only highly-connected hub nodes. Useful for finding important code."
              >
                ?
              </span>
            </label>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={10}
                value={minConnections}
                onChange={(e) => setMinConnections(parseInt(e.target.value, 10))}
                className="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
              />
              <span className="text-sm font-medium text-gray-700 w-6 text-center">{minConnections}</span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showIsolatedNodes}
                  onChange={(e) => setShowIsolatedNodes(e.target.checked)}
                  disabled={minConnections > 0}
                  className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500 disabled:opacity-50"
                />
                <span className={`text-xs ${minConnections > 0 ? 'text-gray-400' : 'text-gray-600'}`}>
                  Show isolated nodes (0 connections)
                </span>
              </label>
            </div>
          </div>
        </div>

        {/* Node Search Combobox (when not project/modules graph type) */}
        {graphType !== 'project' && graphType !== 'modules' && selectedProject && (
          <div className="mt-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Select a node
            </label>
            <div className="flex gap-2">
              {/* Type Filter Dropdown */}
              <select
                value={searchNodeType}
                onChange={(e) => setSearchNodeType(e.target.value as NodeTypeFilter)}
                className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white text-sm min-w-[120px]"
              >
                <option value="all">All types</option>
                <option value="class">Classes</option>
                <option value="method">Methods</option>
                <option value="function">Functions</option>
                <option value="interface">Interfaces</option>
              </select>

              {/* Combobox */}
              <div className="relative flex-1">
                <div
                  className={`flex items-center w-full border rounded-lg bg-white transition-colors ${
                    showSearchResults ? 'border-blue-500 ring-2 ring-blue-500' : 'border-gray-300'
                  }`}
                >
                  {/* Search Icon */}
                  <div className="pl-3 text-gray-400">
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                  </div>

                  {/* Input */}
                  <input
                    type="text"
                    value={showSearchResults ? searchQuery : (selectedNodeName || '')}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      if (!showSearchResults) setShowSearchResults(true);
                    }}
                    onFocus={() => {
                      setShowSearchResults(true);
                      setSearchQuery('');
                    }}
                    onBlur={(e) => {
                      // Delay to allow click on dropdown items
                      setTimeout(() => {
                        if (!e.currentTarget.contains(document.activeElement)) {
                          setShowSearchResults(false);
                        }
                      }, 200);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setShowSearchResults(false);
                        e.currentTarget.blur();
                      }
                    }}
                    placeholder={selectedNodeName ? '' : `Search ${searchNodeType === 'all' ? 'nodes' : searchNodeType + 's'}...`}
                    className="flex-1 px-2 py-2 bg-transparent focus:outline-none"
                  />

                  {/* Clear button (when node selected) */}
                  {selectedNodeName && !showSearchResults && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedNodeId(null);
                        setSelectedNodeName('');
                        setSearchQuery('');
                      }}
                      className="p-1.5 mr-1 hover:bg-gray-100 rounded text-gray-400 hover:text-gray-600"
                      title="Clear selection"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}

                  {/* Dropdown arrow */}
                  <button
                    onClick={() => setShowSearchResults(!showSearchResults)}
                    className="p-2 text-gray-400 hover:text-gray-600"
                  >
                    <svg className={`w-5 h-5 transition-transform ${showSearchResults ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                </div>

                {/* Dropdown - shows all nodes, filters as you type */}
                {showSearchResults && (
                  <div className="absolute z-20 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-xl max-h-96 overflow-y-auto">
                    {isLoadingNodes ? (
                      <div className="p-4 text-center text-gray-500">
                        <div className="inline-block animate-spin rounded-full h-5 w-5 border-2 border-gray-300 border-t-blue-600 mr-2"></div>
                        Loading nodes...
                      </div>
                    ) : filteredNodes.length > 0 ? (
                      <div className="py-1">
                        {/* Results count header */}
                        <div className="px-3 py-2 bg-gray-50 text-xs text-gray-500 border-b border-gray-100 sticky top-0">
                          {searchQuery ? (
                            <span>
                              <strong>{filteredNodes.length}</strong> {filteredNodes.length === 1 ? 'result' : 'results'} for "{searchQuery}"
                            </span>
                          ) : (
                            <span>
                              <strong>{filteredNodes.length}</strong> {searchNodeType === 'all' ? 'nodes' : searchNodeType + 's'} available
                            </span>
                          )}
                        </div>

                        {/* Node list */}
                        {filteredNodes.slice(0, 100).map((node, index) => (
                          <button
                            key={node.id}
                            onClick={() => handleNodeSelect(node)}
                            className={`w-full px-3 py-2 text-left hover:bg-blue-50 flex items-center gap-3 ${
                              index > 0 ? 'border-t border-gray-100' : ''
                            }`}
                          >
                            <span
                              className="px-2 py-0.5 text-xs rounded font-medium shrink-0"
                              style={{
                                backgroundColor: getNodeTypeColor(node.nodeType) + '20',
                                color: getNodeTypeColor(node.nodeType)
                              }}
                            >
                              {node.nodeType}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="font-medium text-gray-900 truncate">{node.name}</div>
                              <div className="text-xs text-gray-500 font-mono truncate">{node.qualifiedName}</div>
                            </div>
                          </button>
                        ))}

                        {/* Show more indicator */}
                        {filteredNodes.length > 100 && (
                          <div className="px-3 py-2 text-xs text-gray-500 text-center border-t border-gray-100 bg-gray-50">
                            Showing 100 of {filteredNodes.length}. Type to filter.
                          </div>
                        )}
                      </div>
                    ) : allNodes?.nodes?.length === 0 ? (
                      <div className="p-4 text-center text-gray-500">
                        No nodes found in this project
                      </div>
                    ) : searchQuery ? (
                      <div className="p-4 text-center text-gray-500">
                        No {searchNodeType === 'all' ? 'nodes' : searchNodeType + 's'} matching "{searchQuery}"
                      </div>
                    ) : (
                      <div className="p-4 text-center text-gray-500">
                        No {searchNodeType === 'all' ? 'nodes' : searchNodeType + 's'} available
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Selected Node Chip */}
            {selectedNodeName && (
              <div className="mt-2 flex items-center gap-2">
                <span className="text-xs text-gray-500">Selected:</span>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-blue-50 text-blue-700 rounded-full text-sm font-medium">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                  {selectedNodeName}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Error Message */}
      {graphError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
          {graphError instanceof Error ? graphError.message : 'Failed to load graph'}
        </div>
      )}

      {/* Graph Visualization */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        {isLoadingGraph ? (
          <GraphLoading />
        ) : graphData ? (
          <GraphViewer
            data={graphData}
            layout={layout}
            onNodeClick={handleGraphNodeClick}
            onNodeDoubleClick={handleGraphNodeDoubleClick}
            height="600px"
            selectedLanguage={selectedLanguage ?? undefined}
            onLanguageSelect={setSelectedLanguage}
            minConnections={minConnections}
            showIsolatedNodes={showIsolatedNodes}
          />
        ) : (
          <div className="flex items-center justify-center h-96 bg-gray-50">
            <div className="text-center text-gray-500">
              <svg className="w-16 h-16 mx-auto mb-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
              <p className="text-lg font-medium">No graph data</p>
              <p className="text-sm mt-1">
                {graphType === 'project'
                  ? 'Select a project to visualize its code graph'
                  : 'Select a project and search for a node to start'}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Graph Stats */}
      {graphData?.metadata && (
        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-gray-700">{graphData.metadata.title}</h3>
              {graphData.metadata.description && (
                <p className="text-xs text-gray-500 mt-1">{graphData.metadata.description}</p>
              )}
            </div>
            <div className="flex items-center gap-4">
              <div className="flex gap-4 text-sm">
                <div className="text-center">
                  <div className="text-lg font-bold text-blue-600">{graphData.metadata.nodeCount}</div>
                  <div className="text-xs text-gray-500">Nodes</div>
                </div>
                <div className="text-center">
                  <div className="text-lg font-bold text-green-600">{graphData.metadata.edgeCount}</div>
                  <div className="text-xs text-gray-500">Edges</div>
                </div>
              </div>
              <button
                onClick={() => setShowDetailedStats(!showDetailedStats)}
                className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
              >
                {showDetailedStats ? '▼ Hide' : '▶ Details'}
              </button>
            </div>
          </div>

          {/* Detailed Statistics Panel */}
          {showDetailedStats && graphStats && (
            <div className="mt-4 pt-4 border-t border-gray-200 grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Edge Type Breakdown */}
              <div>
                <h4 className="text-xs font-semibold text-gray-600 mb-2">Edge Types</h4>
                <div className="space-y-1">
                  {graphStats.edgeTypes.map(([type, count]) => (
                    <div key={type} className="flex justify-between text-xs">
                      <span className="text-gray-600">{type}</span>
                      <span className="font-medium text-gray-900">{count}</span>
                    </div>
                  ))}
                  {graphStats.edgeTypes.length === 0 && (
                    <div className="text-xs text-gray-400">No edges</div>
                  )}
                </div>
              </div>

              {/* Node Type Breakdown */}
              <div>
                <h4 className="text-xs font-semibold text-gray-600 mb-2">Node Types</h4>
                <div className="space-y-1">
                  {graphStats.nodeTypes.map(([type, count]) => (
                    <div key={type} className="flex justify-between text-xs">
                      <span className="text-gray-600">{type}</span>
                      <span className="font-medium text-gray-900">{count}</span>
                    </div>
                  ))}
                  {graphStats.nodeTypes.length === 0 && (
                    <div className="text-xs text-gray-400">No nodes</div>
                  )}
                </div>
              </div>

              {/* Connectivity Metrics */}
              <div>
                <h4 className="text-xs font-semibold text-gray-600 mb-2">Connectivity</h4>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-gray-600">Avg connections</span>
                    <span className="font-medium text-gray-900">{graphStats.avgConnections}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">Max connections</span>
                    <span className="font-medium text-gray-900">{graphStats.maxConnections}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">Isolated nodes</span>
                    <span className="font-medium text-gray-900">{graphStats.isolatedCount}</span>
                  </div>
                </div>

                {/* Top Hubs */}
                {graphStats.topHubs.length > 0 && (
                  <div className="mt-3">
                    <h5 className="text-xs font-semibold text-gray-600 mb-1">Top Hubs</h5>
                    <div className="space-y-1">
                      {graphStats.topHubs.slice(0, 3).map((hub, i) => (
                        <div key={hub.id} className="flex justify-between text-xs">
                          <span className="text-gray-600 truncate max-w-[120px]" title={hub.name}>
                            {i + 1}. {hub.name}
                          </span>
                          <span className="font-medium text-blue-600">{hub.count}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Language Filter Buttons - Single Select */}
          {graphData.metadata.languageGroups && graphData.metadata.languageGroups.length > 0 && (
            <div className="mt-4 pt-4 border-t border-gray-100">
              <h4 className="text-xs font-medium text-gray-600 mb-2">Language</h4>
              <div className="flex flex-wrap gap-2">
                {graphData.metadata.languageGroups.map(group => {
                  const isSelected = selectedLanguage === group.language;
                  return (
                    <button
                      key={group.language}
                      onClick={() => setSelectedLanguage(group.language)}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg transition-all cursor-pointer border-2 ${
                        isSelected
                          ? 'border-current shadow-sm'
                          : 'border-transparent hover:border-gray-200 opacity-60 hover:opacity-100'
                      }`}
                      style={{
                        backgroundColor: `${group.color}${isSelected ? '25' : '10'}`,
                        color: group.color
                      }}
                    >
                      <div
                        className="w-3 h-3 rounded-full border-2"
                        style={{
                          backgroundColor: isSelected ? group.color : 'transparent',
                          borderColor: group.color
                        }}
                      />
                      <span className="text-sm font-medium">
                        {group.label}
                      </span>
                      <span className="text-xs opacity-70">({group.count})</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Helper function for node type colors
function getNodeTypeColor(nodeType: string): string {
  const colors: Record<string, string> = {
    type: '#4B8BBE',
    method: '#306998',
    constructor: '#FFE873',
    field: '#9B59B6',
    function: '#2ECC71',
  };
  return colors[nodeType] || '#95A5A6';
}
