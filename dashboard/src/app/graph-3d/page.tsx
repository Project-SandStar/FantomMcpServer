'use client';

import { useState, useCallback, useMemo, useRef, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { getApiBase } from '@/lib/api';
import { ProjectsSidebar, ProjectsSidebarEntry } from '@/components/ProjectsSidebar';
import { TimelinePicker } from '@/components/timeline/TimelinePicker';
import { IndexRunStrip } from '@/components/timeline/IndexRunStrip';
import { PlaybackControls } from '@/components/timeline/PlaybackControls';

// 3d-force-graph uses Three.js - must be client-only
const ForceGraph3D = dynamic(() => import('react-force-graph-3d'), {
  ssr: false,
  loading: () => <GraphLoading />,
});

// ============================================
// Constants
// ============================================

const COMMUNITY_COLORS = [
  '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231',
  '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabebe',
  '#469990', '#e6beff', '#9a6324', '#fffac8', '#800000',
  '#aaffc3', '#808000', '#ffd8b1', '#000075', '#a9a9a9',
];

const EDGE_COLORS: Record<string, string> = {
  calls: '#4a90d9',
  extends: '#2ecc71',
  implements: '#e67e22',
  contains: '#95a5a6',
  uses: '#9b59b6',
  returns: '#1abc9c',
  overrides: '#e74c3c',
  parameters: '#34495e',
};

const NODE_TYPE_SHAPES: Record<string, string> = {
  class: 'sphere',
  mixin: 'sphere',
  enum: 'sphere',
  method: 'box',
  field: 'cone',
  constructor: 'cylinder',
  function: 'box',
};

const LANGUAGE_COLORS: Record<string, string> = {
  fantom: '#1E88E5',
  typescript: '#3178C6',
  javascript: '#F7DF1E',
  css: '#264DE4',
  dart: '#0175C2',
  vue: '#42B883',
  python: '#3776AB',
  java: '#ED8B00',
  go: '#00ADD8',
  rust: '#DEA584',
  kotlin: '#7F52FF',
  swift: '#FA7343',
  default: '#95A5A6',
};

// ============================================
// Types
// ============================================

interface GraphNode {
  id: string;
  name: string;
  qualifiedName: string;
  nodeType: string;
  filePath: string;
  lineStart: number;
  isPublic: boolean;
  isStatic: boolean;
  community: number;
  callerCount: number;
  language: string;
}

interface GraphEdge {
  source: string;
  target: string;
  edgeType: string;
  confidence: number;
  lineNumber: number;
}

interface GraphDataResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    nodeCount: number;
    edgeCount: number;
    communityCount: number;
    languageGroups?: Array<{ language: string; count: number; color: string }>;
  };
}

// ============================================
// API
// ============================================

async function fetchGraphData(
  projectId: number,
  edgeTypes: string[],
  includeCommunities: boolean,
  atTime?: string | null,
): Promise<GraphDataResponse & { atTime?: string | null; warnings?: string[] }> {
  const apiBase = getApiBase();
  const username = typeof window !== 'undefined' ? localStorage.getItem('admin_user') || 'admin' : 'admin';
  const password = typeof window !== 'undefined' ? localStorage.getItem('admin_pass') || 'admin' : 'admin';

  const params = new URLSearchParams({
    projectId: String(projectId),
    includeCommunities: String(includeCommunities),
  });
  if (edgeTypes.length > 0) {
    params.set('includeEdgeTypes', edgeTypes.join(','));
  }
  if (atTime) params.set('atTime', atTime);

  const res = await fetch(`${apiBase}/admin/graph/data?${params}`, {
    headers: {
      Authorization: 'Basic ' + btoa(`${username}:${password}`),
    },
  });

  if (!res.ok) throw new Error(`API error: ${res.statusText}`);
  return res.json();
}

async function fetchGraphDiff(
  projectId: number,
  from: string,
  to?: string | null,
): Promise<{
  totals: { added: number; modified: number; removed: number };
  files: Array<{
    path: string;
    added: Array<{ qualifiedName: string; name: string; kind: string }>;
    modified: Array<{ qualifiedName: string; name: string; kind: string }>;
    removed: Array<{ qualifiedName: string; name: string; kind: string }>;
  }>;
  edges: {
    added: Array<{ sourceQn: string; targetQn: string; edgeType: string }>;
    removed: Array<{ sourceQn: string; targetQn: string; edgeType: string }>;
    truncated: boolean;
  };
  truncated: boolean;
}> {
  const apiBase = getApiBase();
  const username = typeof window !== 'undefined' ? localStorage.getItem('admin_user') || 'admin' : 'admin';
  const password = typeof window !== 'undefined' ? localStorage.getItem('admin_pass') || 'admin' : 'admin';
  const params = new URLSearchParams({ from });
  if (to) params.set('to', to);
  const res = await fetch(`${apiBase}/admin/code-projects/${projectId}/diff?${params}`, {
    headers: { Authorization: 'Basic ' + btoa(`${username}:${password}`) },
  });
  if (!res.ok) throw new Error(`API error: ${res.statusText}`);
  return res.json();
}

async function rebuildProjectGraph(projectId: number): Promise<{
  success: boolean;
  projectId: number;
  projectName: string;
  nodeCount: number;
  edgeCount: number;
}> {
  const apiBase = getApiBase();
  const username = typeof window !== 'undefined' ? localStorage.getItem('admin_user') || 'admin' : 'admin';
  const password = typeof window !== 'undefined' ? localStorage.getItem('admin_pass') || 'admin' : 'admin';
  const res = await fetch(`${apiBase}/admin/code-projects/${projectId}/rebuild-graph`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(`${username}:${password}`) },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(detail || `Rebuild failed: ${res.status}`);
  }
  return res.json();
}

async function fetchProjects(): Promise<Array<{ id: number; name: string }>> {
  const apiBase = getApiBase();
  const username = typeof window !== 'undefined' ? localStorage.getItem('admin_user') || 'admin' : 'admin';
  const password = typeof window !== 'undefined' ? localStorage.getItem('admin_pass') || 'admin' : 'admin';

  const res = await fetch(`${apiBase}/admin/code-projects`, {
    headers: {
      Authorization: 'Basic ' + btoa(`${username}:${password}`),
    },
  });

  if (!res.ok) return [];
  const data = await res.json();
  return data.projects || [];
}

// ============================================
// Loading / Empty States
// ============================================

function GraphLoading() {
  return (
    <div className="flex items-center justify-center h-96 bg-gray-900 rounded-lg">
      <div className="flex flex-col items-center space-y-4">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-400" />
        <div className="text-gray-400">Loading 3D graph...</div>
      </div>
    </div>
  );
}

// ============================================
// Inspector Panel
// ============================================

function NodeInspector({
  node,
  edges,
  onClose,
}: {
  node: GraphNode;
  edges: GraphEdge[];
  onClose: () => void;
}) {
  const callers = edges.filter(e => e.target === node.id);
  const callees = edges.filter(e => e.source === node.id);

  return (
    <div className="absolute top-4 right-4 w-80 bg-gray-800 text-white rounded-lg shadow-xl p-4 z-10 max-h-[80vh] overflow-y-auto">
      <div className="flex justify-between items-start mb-3">
        <h3 className="font-bold text-sm truncate flex-1">{node.name}</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-white ml-2">X</button>
      </div>

      <div className="space-y-2 text-xs">
        <div>
          <span className="text-gray-400">Type:</span>{' '}
          <span className="text-blue-300">{node.nodeType}</span>
        </div>
        <div>
          <span className="text-gray-400">Qualified:</span>{' '}
          <span className="text-green-300 break-all">{node.qualifiedName}</span>
        </div>
        <div>
          <span className="text-gray-400">File:</span>{' '}
          <span className="text-yellow-300 break-all">{node.filePath}:{node.lineStart}</span>
        </div>
        {node.community >= 0 && (
          <div>
            <span className="text-gray-400">Community:</span>{' '}
            <span
              className="inline-block w-3 h-3 rounded-full mr-1"
              style={{ backgroundColor: COMMUNITY_COLORS[node.community % COMMUNITY_COLORS.length] }}
            />
            #{node.community}
          </div>
        )}
        <div>
          <span className="text-gray-400">Callers:</span> {callers.length}{' '}
          <span className="text-gray-400">Callees:</span> {callees.length}
        </div>

        {callers.length > 0 && (
          <div className="mt-2">
            <div className="text-gray-400 font-semibold mb-1">Called by:</div>
            {callers.slice(0, 8).map((e, i) => (
              <div key={i} className="text-gray-300 truncate pl-2">
                {typeof e.source === 'object' ? (e.source as any).name : e.source}
              </div>
            ))}
            {callers.length > 8 && (
              <div className="text-gray-500 pl-2">...+{callers.length - 8} more</div>
            )}
          </div>
        )}

        {callees.length > 0 && (
          <div className="mt-2">
            <div className="text-gray-400 font-semibold mb-1">Calls:</div>
            {callees.slice(0, 8).map((e, i) => (
              <div key={i} className="text-gray-300 truncate pl-2">
                {typeof e.target === 'object' ? (e.target as any).name : e.target}
              </div>
            ))}
            {callees.length > 8 && (
              <div className="text-gray-500 pl-2">...+{callees.length - 8} more</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================
// Main Page
// ============================================

const ALL_EDGE_TYPES = ['calls', 'extends', 'implements', 'contains', 'uses', 'returns', 'overrides', 'parameters'];
const ALL_NODE_TYPES = ['class', 'mixin', 'enum', 'method', 'field', 'constructor', 'function'];

export default function Graph3DPage() {
  // useSearchParams requires a Suspense boundary in Next.js app router.
  return (
    <Suspense fallback={<GraphLoading />}>
      <Graph3DPageInner />
    </Suspense>
  );
}

function Graph3DPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Read initial shareable state from URL. Keys: projectId, lang, atTime,
  // mode (snapshot|diff), from, to.
  const urlProjectId = (() => {
    const raw = searchParams.get('projectId');
    if (!raw) return 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  })();
  const urlLang = searchParams.get('lang');
  const urlAtTime = searchParams.get('atTime');
  const urlMode = searchParams.get('mode') === 'diff' ? 'diff' : 'snapshot';
  const urlFrom = searchParams.get('from');
  const urlTo = searchParams.get('to');
  const [projectId, setProjectId] = useState<number>(urlProjectId);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [enabledEdgeTypes, setEnabledEdgeTypes] = useState<Set<string>>(new Set(ALL_EDGE_TYPES));
  const [enabledNodeTypes, setEnabledNodeTypes] = useState<Set<string>>(new Set(ALL_NODE_TYPES));
  const [showCommunities, setShowCommunities] = useState(true);
  const [nodeSizeBy, setNodeSizeBy] = useState<'callerCount' | 'fixed'>('callerCount');
  const [selectedLanguage, setSelectedLanguage] = useState<string | null>(urlLang);
  // Time-travel state
  const [timeMode, setTimeMode] = useState<'snapshot' | 'diff'>(urlMode);
  const [atTime, setAtTime] = useState<string | null>(urlAtTime);
  const [compareFrom, setCompareFrom] = useState<string | null>(urlFrom);
  const [compareTo, setCompareTo] = useState<string | null>(urlTo);
  const [rebuildState, setRebuildState] = useState<{
    status: 'idle' | 'running' | 'success' | 'error';
    message?: string;
  }>({ status: 'idle' });
  const graphRef = useRef<any>(null);
  const queryClient = useQueryClient();

  // Fetch projects
  const { data: projects } = useQuery({
    queryKey: ['projects-list'],
    queryFn: fetchProjects,
  });

  // Auto-select first project
  const activeProjectId = projectId || (projects?.[0]?.id ?? 0);

  // Keep URL in sync with shareable state. Single effect handles all keys —
  // only writes when something changed to avoid ping-pong with back/forward.
  // scroll:false preserves camera position.
  useEffect(() => {
    if (!activeProjectId) return;
    const params = new URLSearchParams(searchParams.toString());
    const setOrDelete = (k: string, v: string | null | undefined) => {
      if (v == null || v === '') params.delete(k);
      else params.set(k, String(v));
    };
    setOrDelete('projectId', String(activeProjectId));
    setOrDelete('lang', selectedLanguage);
    // Only persist time fields relevant to the current mode so URLs stay tidy.
    setOrDelete('mode', timeMode === 'diff' ? 'diff' : null);
    setOrDelete('atTime', timeMode === 'snapshot' ? atTime : null);
    setOrDelete('from', timeMode === 'diff' ? compareFrom : null);
    setOrDelete('to', timeMode === 'diff' ? compareTo : null);
    const next = params.toString();
    if (next === searchParams.toString()) return;
    router.replace(next ? `?${next}` : '?', { scroll: false });
  }, [
    activeProjectId, selectedLanguage, timeMode, atTime, compareFrom, compareTo,
    router, searchParams,
  ]);

  // Sync the other direction: if URL changes (back/forward), update state.
  useEffect(() => {
    const raw = searchParams.get('projectId');
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n > 0 && n !== projectId) setProjectId(n);
    }
    const lang = searchParams.get('lang');
    if (lang !== selectedLanguage) setSelectedLanguage(lang);
    const mode = searchParams.get('mode') === 'diff' ? 'diff' : 'snapshot';
    if (mode !== timeMode) setTimeMode(mode);
    const at = searchParams.get('atTime');
    if (at !== atTime) setAtTime(at);
    const from = searchParams.get('from');
    if (from !== compareFrom) setCompareFrom(from);
    const to = searchParams.get('to');
    if (to !== compareTo) setCompareTo(to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Fetch graph data — atTime drives snapshot reconstruction
  const { data: graphData, isLoading, error } = useQuery({
    queryKey: ['graph-3d-data', activeProjectId, showCommunities, timeMode === 'snapshot' ? atTime : null],
    queryFn: () => fetchGraphData(activeProjectId, [], showCommunities, timeMode === 'snapshot' ? atTime : null),
    enabled: activeProjectId > 0,
    staleTime: 60_000,
  });

  // Diff data only fetched in diff mode with both endpoints set
  const { data: diffData } = useQuery({
    queryKey: ['graph-3d-diff', activeProjectId, compareFrom, compareTo],
    queryFn: () => fetchGraphDiff(activeProjectId, compareFrom!, compareTo),
    enabled: timeMode === 'diff' && activeProjectId > 0 && !!compareFrom,
    staleTime: 60_000,
  });

  // Build a qualifiedName → changeType map for diff overlay coloring.
  const diffOverlay = useMemo(() => {
    if (timeMode !== 'diff' || !diffData) return null;
    const m = new Map<string, 'added' | 'modified' | 'removed'>();
    for (const f of diffData.files) {
      for (const e of f.added) m.set(e.qualifiedName, 'added');
      for (const e of f.modified) m.set(e.qualifiedName, 'modified');
      for (const e of f.removed) m.set(e.qualifiedName, 'removed');
    }
    return m;
  }, [timeMode, diffData]);

  // Filter and transform data for the graph
  const forceGraphData = useMemo(() => {
    if (!graphData) return { nodes: [], links: [] };

    const filteredNodes = graphData.nodes.filter(n =>
      enabledNodeTypes.has(n.nodeType) &&
      (!selectedLanguage || n.language === selectedLanguage)
    );
    const nodeIds = new Set(filteredNodes.map(n => n.id));

    const filteredEdges = graphData.edges.filter(
      e => enabledEdgeTypes.has(e.edgeType) && nodeIds.has(e.source) && nodeIds.has(e.target)
    );

    const DIFF_COLORS = {
      added: '#10b981',
      modified: '#f59e0b',
      removed: '#ef4444',
    };
    return {
      nodes: filteredNodes.map(n => {
        const change = diffOverlay?.get(n.qualifiedName);
        const baseColor = showCommunities && n.community >= 0
          ? COMMUNITY_COLORS[n.community % COMMUNITY_COLORS.length]
          : (LANGUAGE_COLORS[n.language] || LANGUAGE_COLORS.default);
        return {
          ...n,
          val: nodeSizeBy === 'callerCount' ? Math.max(1, n.callerCount * 2) : 3,
          changeType: change ?? null,
          color: change ? DIFF_COLORS[change] : (timeMode === 'diff' ? '#6b7280' : baseColor),
        };
      }),
      links: filteredEdges.map(e => ({
        ...e,
        color: EDGE_COLORS[e.edgeType] || '#666',
      })),
    };
  }, [graphData, enabledEdgeTypes, enabledNodeTypes, showCommunities, nodeSizeBy, selectedLanguage, diffOverlay, timeMode]);

  const handleNodeClick = useCallback((node: any) => {
    setSelectedNode(node as GraphNode);
    // Focus camera on clicked node
    if (graphRef.current) {
      const distance = 200;
      const distRatio = 1 + distance / Math.hypot(node.x, node.y, node.z);
      graphRef.current.cameraPosition(
        { x: node.x * distRatio, y: node.y * distRatio, z: node.z * distRatio },
        node,
        1000
      );
    }
  }, []);

  const toggleEdgeType = (type: string) => {
    setEnabledEdgeTypes(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const toggleNodeType = (type: string) => {
    setEnabledNodeTypes(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const handleRebuildGraph = useCallback(async () => {
    if (!activeProjectId) return;
    setRebuildState({ status: 'running' });
    try {
      const result = await rebuildProjectGraph(activeProjectId);
      setRebuildState({
        status: 'success',
        message: `Rebuilt: ${result.nodeCount} nodes, ${result.edgeCount} edges`,
      });
      queryClient.invalidateQueries({ queryKey: ['graph-3d-data', activeProjectId] });
    } catch (err) {
      setRebuildState({
        status: 'error',
        message: err instanceof Error ? err.message : 'Rebuild failed',
      });
    }
  }, [activeProjectId, queryClient]);

  const sidebarEntries: ProjectsSidebarEntry<number>[] = (projects ?? []).map(
    (p) => ({ id: p.id, label: p.name })
  );

  return (
    <div className="flex flex-col lg:flex-row gap-4">
      <ProjectsSidebar
        entries={sidebarEntries}
        selectedId={activeProjectId || null}
        onSelect={(id) => setProjectId(id)}
        emptyMessage="No projects indexed"
        fillHeight
        filterable
        filterPlaceholder="Filter projects…"
      />

      <div className="flex-1 min-w-0 space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold text-gray-900">3D Code Graph</h1>
        <div className="flex items-center gap-3">
          <button
            onClick={handleRebuildGraph}
            disabled={!activeProjectId || rebuildState.status === 'running'}
            className={`px-3 py-1.5 text-sm rounded border font-medium ${
              rebuildState.status === 'running'
                ? 'bg-gray-300 border-gray-300 text-gray-600 cursor-not-allowed'
                : 'bg-amber-600 border-amber-700 text-white hover:bg-amber-700'
            }`}
            title="Re-parse source files and rewrite Ladybug nodes/edges for the active project"
          >
            {rebuildState.status === 'running' ? 'Rebuilding…' : 'Rebuild Ladybug Edges'}
          </button>
          {rebuildState.status === 'success' && (
            <span className="text-xs text-emerald-700">{rebuildState.message}</span>
          )}
          {rebuildState.status === 'error' && (
            <span className="text-xs text-red-600">{rebuildState.message}</span>
          )}
          {graphData && (
            <div className="text-sm text-gray-500">
              {forceGraphData.nodes.length} nodes, {forceGraphData.links.length} edges
              {graphData.stats.communityCount > 0 && `, ${graphData.stats.communityCount} communities`}
            </div>
          )}
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white rounded-lg shadow p-4 flex flex-wrap gap-4 items-center">
        {/* Edge type filters */}
        <div>
          <label className="text-xs text-gray-500 block mb-1">Edge Types</label>
          <div className="flex gap-1 flex-wrap">
            {ALL_EDGE_TYPES.map(type => (
              <button
                key={type}
                onClick={() => toggleEdgeType(type)}
                className={`px-2 py-0.5 text-xs rounded border ${
                  enabledEdgeTypes.has(type)
                    ? 'text-white border-transparent'
                    : 'text-gray-400 border-gray-300 bg-white'
                }`}
                style={enabledEdgeTypes.has(type) ? { backgroundColor: EDGE_COLORS[type] } : {}}
              >
                {type}
              </button>
            ))}
          </div>
        </div>

        {/* Node type filters */}
        <div>
          <label className="text-xs text-gray-500 block mb-1">Node Types</label>
          <div className="flex gap-1 flex-wrap">
            {ALL_NODE_TYPES.map(type => (
              <button
                key={type}
                onClick={() => toggleNodeType(type)}
                className={`px-2 py-0.5 text-xs rounded border ${
                  enabledNodeTypes.has(type)
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'text-gray-400 border-gray-300 bg-white'
                }`}
              >
                {type}
              </button>
            ))}
          </div>
        </div>

        {/* Language filter */}
        {graphData?.stats.languageGroups && graphData.stats.languageGroups.length > 1 && (
          <div>
            <label className="text-xs text-gray-500 block mb-1">Language</label>
            <div className="flex gap-1 flex-wrap">
              <button
                onClick={() => setSelectedLanguage(null)}
                className={`px-2 py-0.5 text-xs rounded border ${
                  selectedLanguage === null
                    ? 'bg-gray-700 text-white border-gray-700'
                    : 'text-gray-400 border-gray-300 bg-white'
                }`}
              >
                All ({graphData.stats.nodeCount})
              </button>
              {graphData.stats.languageGroups.map(lg => (
                <button
                  key={lg.language}
                  onClick={() => setSelectedLanguage(selectedLanguage === lg.language ? null : lg.language)}
                  className={`px-2 py-0.5 text-xs rounded border ${
                    selectedLanguage === lg.language
                      ? 'text-white border-transparent'
                      : 'text-gray-400 border-gray-300 bg-white'
                  }`}
                  style={selectedLanguage === lg.language ? { backgroundColor: lg.color } : {}}
                >
                  <span
                    className="inline-block w-2 h-2 rounded-full mr-1"
                    style={{ backgroundColor: lg.color }}
                  />
                  {lg.language.charAt(0).toUpperCase() + lg.language.slice(1)} ({lg.count})
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Toggles */}
        <div className="flex gap-3 items-center">
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={showCommunities}
              onChange={e => setShowCommunities(e.target.checked)}
            />
            Communities
          </label>
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={nodeSizeBy === 'callerCount'}
              onChange={e => setNodeSizeBy(e.target.checked ? 'callerCount' : 'fixed')}
            />
            Size by callers
          </label>
        </div>
      </div>

      {/* Time travel controls */}
      {activeProjectId > 0 && (
        <div className="bg-white rounded-lg shadow p-3 space-y-2">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setTimeMode('snapshot')}
              className={`px-3 py-1 text-sm rounded ${timeMode === 'snapshot' ? 'bg-blue-600 text-white' : 'bg-white border border-gray-300 text-gray-700'}`}
            >
              Snapshot
            </button>
            <button
              onClick={() => setTimeMode('diff')}
              className={`px-3 py-1 text-sm rounded ${timeMode === 'diff' ? 'bg-blue-600 text-white' : 'bg-white border border-gray-300 text-gray-700'}`}
            >
              Diff range
            </button>
            <span className="text-xs text-gray-500 ml-2">
              {timeMode === 'snapshot'
                ? 'Picks the project as it was at a single moment.'
                : 'Compares two moments — colored nodes show added (green), modified (yellow), removed (red).'}
            </span>
          </div>
          {timeMode === 'snapshot' ? (
            <div className="flex flex-wrap items-center gap-4">
              <TimelinePicker value={atTime} onChange={setAtTime} label="As of" />
              <PlaybackControls projectId={activeProjectId} onTick={setAtTime} />
            </div>
          ) : (
            <div className="flex flex-wrap gap-4">
              <TimelinePicker value={compareFrom} onChange={setCompareFrom} label="From" />
              <TimelinePicker value={compareTo} onChange={setCompareTo} label="To" />
            </div>
          )}
          <IndexRunStrip
            projectId={activeProjectId}
            selectedIso={timeMode === 'snapshot' ? atTime : null}
            onSelect={(iso) => {
              if (timeMode === 'snapshot') setAtTime(iso);
              else if (!compareFrom) setCompareFrom(iso);
              else setCompareTo(iso);
            }}
            selectedFrom={timeMode === 'diff' ? compareFrom : undefined}
            selectedTo={timeMode === 'diff' ? compareTo : undefined}
          />
          {timeMode === 'diff' && diffData && (
            <div className="text-xs text-gray-700">
              <span className="text-emerald-700">+{diffData.totals.added}</span>{' '}
              <span className="text-yellow-700">~{diffData.totals.modified}</span>{' '}
              <span className="text-red-700">-{diffData.totals.removed}</span>{' '}
              {diffData.truncated && <span className="text-amber-600">(truncated to 5000)</span>}
            </div>
          )}
          {graphData?.warnings && graphData.warnings.length > 0 && (
            <ul className="text-xs text-amber-700 list-disc list-inside space-y-0.5">
              {graphData.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Graph */}
      <div className="bg-gray-900 rounded-lg shadow relative" style={{ height: 'calc(100vh - 240px)' }}>
        {isLoading && <GraphLoading />}
        {error && (
          <div className="flex items-center justify-center h-full text-red-400">
            Error: {error instanceof Error ? error.message : 'Failed to load graph data'}
          </div>
        )}
        {!isLoading && !error && forceGraphData.nodes.length > 0 && (
          <>
            <ForceGraph3D
              ref={graphRef}
              graphData={forceGraphData}
              nodeLabel={(node: any) => `${node.qualifiedName} (${node.nodeType})`}
              nodeColor={(node: any) => node.color}
              nodeVal={(node: any) => node.val}
              nodeOpacity={0.9}
              linkColor={(link: any) => link.color}
              linkOpacity={0.4}
              linkWidth={1}
              linkDirectionalArrowLength={3}
              linkDirectionalArrowRelPos={1}
              onNodeClick={handleNodeClick}
              backgroundColor="#111827"
              width={typeof window !== 'undefined' ? Math.max(400, window.innerWidth - 340 - 350) : 800}
              height={typeof window !== 'undefined' ? window.innerHeight - 240 : 600}
            />
            {selectedNode && graphData && (
              <NodeInspector
                node={selectedNode}
                edges={graphData.edges}
                onClose={() => setSelectedNode(null)}
              />
            )}
          </>
        )}
        {!isLoading && !error && forceGraphData.nodes.length === 0 && activeProjectId > 0 && (
          <div className="flex items-center justify-center h-full text-gray-400">
            No graph data. Build a project graph first.
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

// ============================================
// Helpers
// ============================================

function getNodeTypeColor(nodeType: string): string {
  const colors: Record<string, string> = {
    class: '#4a90d9',
    mixin: '#9b59b6',
    enum: '#e67e22',
    method: '#2ecc71',
    field: '#f1c40f',
    constructor: '#e74c3c',
    function: '#1abc9c',
  };
  return colors[nodeType] || '#95a5a6';
}
