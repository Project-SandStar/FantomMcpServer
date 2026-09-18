'use client';

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api, type AskEvent } from '@/lib/api';
import dynamic from 'next/dynamic';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { SearchableComboBox } from '@/components/ui/SearchableComboBox';
import { AxonSearchResults } from '@/components/AxonSearchResults';
import { ProjectDependenciesPanel } from '@/components/ProjectDependenciesPanel';
import { ProjectsSidebar, ProjectsSidebarEntry } from '@/components/ProjectsSidebar';

// Dynamically import VectorScatter to avoid SSR issues with D3
const VectorScatter = dynamic(
  () => import('@/components/VectorScatter').then(mod => mod.VectorScatter),
  { ssr: false, loading: () => <ScatterLoading /> }
);

// ============================================
// Types
// ============================================

interface VectorPoint {
  id: string;
  name: string;
  qualifiedName: string;
  nodeType: string;
  filePath: string;
  lineStart: number;
  x: number;
  y: number;
  score?: number;
}

interface SemanticSearchResult {
  nodeId: string;
  name: string;
  qualifiedName: string;
  nodeType: string;
  filePath: string;
  lineStart: number;
  signature?: string;
  documentation?: string;
  semanticScore: number;
  graphScore: number;
  combinedScore: number;
  callerCount?: number;
  calleeCount?: number;
  containsCount?: number;
  usedByCount?: number;
  extendsCount?: number;
  implementsCount?: number;
}

interface VectorStats {
  nodeCounts?: { source: 'snapshot' | 'partial'; stale: number; missing: number; refreshing: boolean; queued: number };
  totalVectors: number;
  totalNodes: number;
  coveragePercent: string;
  projects: Array<{
    id: number;
    name: string;
    nodeCount: number;
    vectorCount: number;
  }>;
}

// ============================================
// Loading Component
// ============================================

function ScatterLoading() {
  return (
    <div className="flex items-center justify-center h-96 bg-gray-50 rounded-lg">
      <div className="flex flex-col items-center space-y-4">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600"></div>
        <div className="text-gray-500">Loading vector viewer...</div>
      </div>
    </div>
  );
}

// ============================================
// API Functions
// ============================================

async function performSemanticSearch(
  query: string,
  projectId?: number,
  limit: number = 20,
  rerank: boolean = true,
): Promise<{ results: SemanticSearchResult[] }> {
  const apiBase = typeof window !== 'undefined' ? localStorage.getItem('server_url') || '' : '';
  const username = typeof window !== 'undefined' ? localStorage.getItem('admin_user') || 'admin' : 'admin';
  const password = typeof window !== 'undefined' ? localStorage.getItem('admin_pass') || 'admin' : 'admin';
  const authHeader = 'Basic ' + btoa(`${username}:${password}`);

  const response = await fetch(`${apiBase}/admin/vectors/search`, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json'
    },
    // rerank 'on' forces the cross-encoder pass (local GPU or OpenRouter per
    // policy); 'off' keeps the fused vector+keyword order.
    body: JSON.stringify({ query, projectId, limit, rerank: rerank ? 'on' : 'off' })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Search failed');
  }
  return response.json();
}

async function fetchProjectVectors(projectId: number): Promise<{ nodes: VectorPoint[] }> {
  const apiBase = typeof window !== 'undefined' ? localStorage.getItem('server_url') || '' : '';
  const username = typeof window !== 'undefined' ? localStorage.getItem('admin_user') || 'admin' : 'admin';
  const password = typeof window !== 'undefined' ? localStorage.getItem('admin_pass') || 'admin' : 'admin';
  const authHeader = 'Basic ' + btoa(`${username}:${password}`);

  const response = await fetch(`${apiBase}/admin/vectors/project/${projectId}`, {
    headers: { 'Authorization': authHeader }
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to fetch vectors');
  }
  return response.json();
}

async function fetchVectorStats(): Promise<VectorStats> {
  const apiBase = typeof window !== 'undefined' ? localStorage.getItem('server_url') || '' : '';
  const username = typeof window !== 'undefined' ? localStorage.getItem('admin_user') || 'admin' : 'admin';
  const password = typeof window !== 'undefined' ? localStorage.getItem('admin_pass') || 'admin' : 'admin';
  const authHeader = 'Basic ' + btoa(`${username}:${password}`);

  const response = await fetch(`${apiBase}/admin/vectors/stats`, {
    headers: { 'Authorization': authHeader }
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to fetch stats');
  }
  return response.json();
}

interface GenerateVectorsResult {
  success: boolean;
  projectId: number;
  totalNodes?: number;
  generated?: number;
  errorCount?: number;
  message?: string;
}

async function generateVectors(projectId: number): Promise<GenerateVectorsResult> {
  const apiBase = typeof window !== 'undefined' ? localStorage.getItem('server_url') || '' : '';
  const username = typeof window !== 'undefined' ? localStorage.getItem('admin_user') || 'admin' : 'admin';
  const password = typeof window !== 'undefined' ? localStorage.getItem('admin_pass') || 'admin' : 'admin';
  const authHeader = 'Basic ' + btoa(`${username}:${password}`);

  const response = await fetch(`${apiBase}/admin/vectors/generate/${projectId}`, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ batchSize: 25 })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to generate vectors');
  }
  return response.json();
}

// ============================================
// Vector Viewer Page
// ============================================

// Common semantic search suggestions
const SEARCH_SUGGESTIONS = [
  { value: 'function that handles authentication', label: 'Authentication handlers' },
  { value: 'error handling and exception', label: 'Error handling' },
  { value: 'database query or SQL', label: 'Database queries' },
  { value: 'API endpoint or route handler', label: 'API endpoints' },
  { value: 'user input validation', label: 'Input validation' },
  { value: 'file read write operations', label: 'File I/O operations' },
  { value: 'caching or memoization', label: 'Caching logic' },
  { value: 'async await promise', label: 'Async operations' },
  { value: 'logging or debugging', label: 'Logging/debugging' },
  { value: 'configuration or settings', label: 'Configuration' },
];

export default function VectorViewerPage() {
  // State
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedProject, setSelectedProject] = useState<number | null>(null);
  const [selectedProjectName, setSelectedProjectName] = useState<string>('');
  const [selectedResult, setSelectedResult] = useState<SemanticSearchResult | null>(null);
  const [colorBy, setColorBy] = useState<'nodeType' | 'score'>('nodeType');
  const [viewMode, setViewMode] = useState<'search' | 'project'>('search');
  const [mode, setMode] = useState<'vector' | 'rerank' | 'rlm'>('vector');
  // Stage toggles for the Fantom search + Answer. Remembered per browser.
  // rerankOn: cross-encoder pass on every retrieval. rlmDeep: the Answer runs
  // the RLM tool loop (full budget, ~60–120s) instead of retrieval-only (~20–40s).
  const [rerankOn, setRerankOn] = useState(true);
  const [rlmDeep, setRlmDeep] = useState(false);
  useEffect(() => {
    try {
      const r = localStorage.getItem('vv_rerank'); if (r !== null) setRerankOn(r === '1');
      const d = localStorage.getItem('vv_rlm_deep'); if (d !== null) setRlmDeep(d === '1');
    } catch { /* storage unavailable — defaults stand */ }
  }, []);
  useEffect(() => { try { localStorage.setItem('vv_rerank', rerankOn ? '1' : '0'); } catch { /* ignore */ } }, [rerankOn]);
  useEffect(() => { try { localStorage.setItem('vv_rlm_deep', rlmDeep ? '1' : '0'); } catch { /* ignore */ } }, [rlmDeep]);
  // Source selector: Fantom code (code_vectors) or Axon functions (axon_vectors).
  const [source, setSource] = useState<'fantom' | 'axon'>('fantom');
  const [axonProject, setAxonProject] = useState<string>('');

  // Axon projects for the project selector (only fetched when the Axon source is active).
  const { data: axonProjects } = useQuery({
    queryKey: ['axon-projects'],
    queryFn: api.axonProjects,
    enabled: source === 'axon',
  });
  const axonProjectOptions = useMemo(() => (axonProjects?.projects ?? []).map(p => ({
    value: p.projectId,
    label: p.projectId,
    description: `${p.vectors} vectors / ${p.functionsFound} functions`,
  })), [axonProjects]);

  // Axon search — one endpoint, mode selects vector / rerank / rlm server-side.
  const axonSearchMutation = useMutation({
    mutationFn: ({ query, projectId, mode: m }: { query: string; projectId?: string; mode: 'vector' | 'rerank' | 'rlm' }) =>
      api.axonSearch({ query, projectId, mode: m, limit: 30 }),
  });

  // Fetch vector stats
  const { data: vectorStats, isLoading: isLoadingStats, refetch: refetchStats } = useQuery({
    queryKey: ['vector-stats'],
    // Overrides the dashboard-wide 10s default. This call costs ~0.7-1.0s of
    // server time (per-project counts over a 212k-row table) and the number
    // it returns changes only while an embed job is running. Polled every
    // 10s it was ~10% of the server's wall time from one open tab.
    refetchInterval: 30_000,
    staleTime: 20_000,
    queryFn: fetchVectorStats,
  });

  // Left-column project list, same component as /graph-3d and /fantom-pods.
  // Fed from the stats payload the page already polls — no extra request.
  // `id: 0` is the synthetic "All projects" row (search supports it).
  const sidebarEntries = useMemo<ProjectsSidebarEntry<number>[]>(() => {
    const rows = [...(vectorStats?.projects ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    const all: ProjectsSidebarEntry<number> = {
      id: 0,
      label: 'All projects',
      sublabel: `${rows.length} projects`,
      count: vectorStats?.totalVectors,
    };
    return [all, ...rows.map((p): ProjectsSidebarEntry<number> => {
      const pct = p.nodeCount > 0 ? Math.round((p.vectorCount / p.nodeCount) * 100) : 0;
      return {
        id: p.id,
        label: p.name,
        count: p.vectorCount,
        sublabel: p.vectorCount === 0
          ? (p.nodeCount > 0 ? `no vectors · ${p.nodeCount.toLocaleString()} nodes` : 'no vectors')
          : `${p.vectorCount.toLocaleString()} / ${p.nodeCount.toLocaleString()} · ${pct}%`,
        tone: p.vectorCount === 0 ? 'warn' : undefined,
      };
    })];
  }, [vectorStats]);

  // Shareable selection: ?projectId= in the URL, read once the project list
  // is known, written on every select (replaceState — no navigation, no
  // scroll jump).
  const urlProjectApplied = useRef(false);

  // Combine search suggestions with recent searches from localStorage
  const searchOptions = useMemo(() => {
    const recent = typeof window !== 'undefined'
      ? JSON.parse(localStorage.getItem('vector_search_history') || '[]').slice(0, 5)
      : [];
    const recentOptions = recent.map((q: string) => ({
      value: q,
      label: q,
      description: 'Recent search'
    }));
    return [
      ...recentOptions,
      ...SEARCH_SUGGESTIONS.map(s => ({ ...s, description: 'Suggested' }))
    ];
  }, []);

  // Save search to history
  const saveSearchHistory = useCallback((query: string) => {
    if (typeof window === 'undefined') return;
    const history = JSON.parse(localStorage.getItem('vector_search_history') || '[]');
    const updated = [query, ...history.filter((q: string) => q !== query)].slice(0, 10);
    localStorage.setItem('vector_search_history', JSON.stringify(updated));
  }, []);

  // Semantic search mutation
  const searchMutation = useMutation({
    mutationFn: ({ query, projectId, rerank }: { query: string; projectId?: number; rerank: boolean }) =>
      performSemanticSearch(query, projectId, 30, rerank),
  });

  // RLM Answer (synthesized, cited answer) mutation
  const askStartedAt = useRef<number | null>(null);
  const [askElapsedMs, setAskElapsedMs] = useState(0);
  const askMutation = useMutation({
    // "RLM search" off: fast retrieval-only answer (~20–40s). On: the same
    // full-budget RLM investigation the MCP tool runs (~60–120s); the ticker
    // and stage timings make the wait legible.
    mutationFn: ({ query, projectId, rlm, rerank, askId }: { query: string; projectId?: number; rlm: boolean; rerank: boolean; askId: string }) =>
      api.ask({ query, projectId, fast: !rlm, rlm, rerank, askId }),
    onMutate: (vars) => {
      askStartedAt.current = performance.now(); setAskElapsedMs(0);
      setAskFeedId(vars.askId); setAskEvents([]); setThinkingOpen(true);
    },
  });
  // Live "thinking" feed: what the RLM is asking and what came back, polled
  // once a second while the ask runs, plus one final read after it settles.
  const [askFeedId, setAskFeedId] = useState<string | null>(null);
  const [askEvents, setAskEvents] = useState<AskEvent[]>([]);
  const [thinkingOpen, setThinkingOpen] = useState(true);
  const askEventsSeq = useRef(0);
  useEffect(() => {
    if (!askFeedId) return;
    askEventsSeq.current = 0;
    let stopped = false;
    let inFlight = false;
    const pull = async () => {
      if (inFlight) return; // two polls racing before the cursor moved duplicated lines
      inFlight = true;
      try {
        const r = await api.getAskEvents(askFeedId, askEventsSeq.current);
        if (stopped || r.events.length === 0) return;
        askEventsSeq.current = Math.max(askEventsSeq.current, r.events[r.events.length - 1].seq);
        setAskEvents(prev => {
          const seen = new Set(prev.map(e => e.seq));
          return [...prev, ...r.events.filter(e => !seen.has(e.seq))];
        });
      } catch { /* feed is best-effort */ } finally { inFlight = false; }
    };
    void pull();
    const id = setInterval(pull, 1000);
    return () => { stopped = true; clearInterval(id); };
  }, [askFeedId]);
  useEffect(() => {
    // One last read once the answer landed, so the tail of the feed is complete.
    if (askMutation.isPending || !askFeedId) return;
    const t = setTimeout(() => { void api.getAskEvents(askFeedId, askEventsSeq.current).then(r => {
      if (r.events.length) { askEventsSeq.current = r.events[r.events.length - 1].seq; setAskEvents(prev => { const seen = new Set(prev.map(e => e.seq)); return [...prev, ...r.events.filter(e => !seen.has(e.seq))]; }); }
    }).catch(() => {}); }, 300);
    return () => clearTimeout(t);
  }, [askMutation.isPending, askFeedId]);
  // Tick while an ask is in flight so the wait is a number, not a spinner.
  useEffect(() => {
    if (!askMutation.isPending) return;
    const id = setInterval(() => {
      if (askStartedAt.current !== null) setAskElapsedMs(Math.round(performance.now() - askStartedAt.current));
    }, 250);
    return () => clearInterval(id);
  }, [askMutation.isPending]);

  // Vector generation mutation
  const generateMutation = useMutation({
    mutationFn: (projectId: number) => generateVectors(projectId),
    onSuccess: () => {
      refetchStats();  // Refresh stats after generation
    }
  });

  // Fetch project vectors
  const { data: projectVectors, isLoading: isLoadingVectors } = useQuery({
    queryKey: ['project-vectors', selectedProject],
    queryFn: async () => {
      const t0 = performance.now();
      const data = await fetchProjectVectors(selectedProject!);
      // Timed here, at the fetch, so the number is the request and not the
      // render — "loading vector is slow" turned out to be neither, and the
      // page should be able to say so itself.
      return { ...data, loadMs: Math.round(performance.now() - t0) };
    },
    enabled: viewMode === 'project' && selectedProject !== null,
  });

  // Handlers
  const handleSearch = useCallback(() => {
    if (searchQuery.trim()) {
      saveSearchHistory(searchQuery.trim());
      if (source === 'axon') {
        axonSearchMutation.mutate({ query: searchQuery, projectId: axonProject || undefined, mode });
        return;
      }
      // Always run vector search so the scatter/list stay populated and
      // citations can resolve to a selectable result.
      searchMutation.mutate({
        query: searchQuery,
        projectId: selectedProject ?? undefined,
        rerank: rerankOn,
      });
      // In Answer mode, also synthesize a cited answer.
      if (mode === 'rlm') {
        askMutation.mutate({
          query: searchQuery,
          projectId: selectedProject ?? undefined,
          rlm: rlmDeep,
          rerank: rerankOn,
          askId: (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64),
        });
      }
    }
  }, [searchQuery, selectedProject, searchMutation, askMutation, mode, saveSearchHistory, source, axonProject, axonSearchMutation, rerankOn, rlmDeep]);

  const handleProjectSelect = useCallback((projectId: number | null) => {
    setSelectedProject(projectId);
    const project = vectorStats?.projects.find(p => p.id === projectId);
    setSelectedProjectName(project?.name || '');
    try {
      const url = new URL(window.location.href);
      if (projectId) url.searchParams.set('projectId', String(projectId));
      else url.searchParams.delete('projectId');
      window.history.replaceState(null, '', url.toString());
    } catch { /* non-browser or blocked history — selection still works */ }
  }, [vectorStats?.projects]);
  useEffect(() => {
    if (urlProjectApplied.current || !vectorStats?.projects) return;
    urlProjectApplied.current = true;
    try {
      const raw = new URLSearchParams(window.location.search).get('projectId');
      const id = raw ? Number(raw) : NaN;
      if (Number.isFinite(id) && vectorStats.projects.some(p => p.id === id)) handleProjectSelect(id);
    } catch { /* ignore */ }
  }, [vectorStats?.projects, handleProjectSelect]);

  const handleCitationClick = useCallback((nodeId: string) => {
    const match = searchMutation.data?.results.find(r => r.nodeId === nodeId);
    if (match) {
      setSelectedResult(match);
      if (typeof document !== 'undefined') {
        document.getElementById(`result-${nodeId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [searchMutation.data?.results]);

  const handlePointClick = useCallback((point: VectorPoint) => {
    // Find matching result if in search mode
    const match = searchMutation.data?.results.find(r => r.nodeId === point.id);
    if (match) {
      setSelectedResult(match);
    }
  }, [searchMutation.data?.results]);

  // Convert search results to vector points for scatter plot
  const searchPoints: VectorPoint[] = searchMutation.data?.results.map((r, i) => ({
    id: r.nodeId,
    name: r.name,
    qualifiedName: r.qualifiedName,
    nodeType: r.nodeType,
    filePath: r.filePath,
    lineStart: r.lineStart,
    // Spread results in a semi-circle based on score
    x: Math.cos((1 - r.combinedScore) * Math.PI) * (1 - r.combinedScore) + Math.random() * 0.1,
    y: Math.sin((1 - r.combinedScore) * Math.PI) * r.combinedScore + Math.random() * 0.1,
    score: r.combinedScore
  })) || [];

  // Highlighted point IDs (selected result)
  const highlightedIds = selectedResult ? new Set([selectedResult.nodeId]) : undefined;

  return (
    <div className="flex flex-col lg:flex-row gap-4">
      <ProjectsSidebar
        entries={sidebarEntries}
        selectedId={selectedProject ?? 0}
        onSelect={(id) => handleProjectSelect(id || null)}
        emptyMessage={isLoadingStats ? 'Loading projects…' : 'No projects indexed'}
        fillHeight
        filterable
        filterPlaceholder="Filter projects…"
      />
    <div className="flex-1 min-w-0 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Vector Viewer</h1>
          <p className="text-gray-600 mt-1">
            Semantic code search and embedding visualization
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
        {/* Source Toggle (search mode): Fantom code vectors vs Axon function vectors */}
        {viewMode === 'search' && (
          <div className="flex rounded-lg border border-gray-300 overflow-hidden" title="Search source">
            <button
              onClick={() => setSource('fantom')}
              className={`px-3 py-2 text-sm font-medium transition-colors ${source === 'fantom' ? 'bg-gray-800 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
            >
              Fantom code
            </button>
            <button
              onClick={() => setSource('axon')}
              className={`px-3 py-2 text-sm font-medium font-mono transition-colors ${source === 'axon' ? 'bg-[#10161d] text-[#5ee1a2]' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
            >
              Axon
            </button>
          </div>
        )}
        {/* View Mode Toggle */}
        <div className="flex rounded-lg border border-gray-300 overflow-hidden">
          <button
            onClick={() => setViewMode('search')}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              viewMode === 'search'
                ? 'bg-purple-600 text-white'
                : 'bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            Semantic Search
          </button>
          <button
            onClick={() => setViewMode('project')}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              viewMode === 'project'
                ? 'bg-purple-600 text-white'
                : 'bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            Project Vectors
          </button>
        </div>
        </div>
      </div>

      {/* Stats Summary */}
      {vectorStats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-white rounded-lg shadow p-4">
            <div className="text-sm text-purple-600 font-medium">Total Vectors</div>
            <div className="text-2xl font-bold text-purple-800">{vectorStats.totalVectors}</div>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <div className="text-sm text-blue-600 font-medium">Total Nodes</div>
            <div className="text-2xl font-bold text-blue-800">{vectorStats.totalNodes}</div>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <div className="text-sm text-green-600 font-medium">Coverage</div>
            <div className="text-2xl font-bold text-green-800">{vectorStats.coveragePercent}%</div>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <div className="text-sm text-gray-600 font-medium">Projects</div>
            <div className="text-2xl font-bold text-gray-800">{vectorStats.projects.length}</div>
            {vectorStats.nodeCounts?.source === 'partial' && (
              <div className="text-xs text-amber-700 mt-1" title="Node counts are read from a snapshot; projects whose graph changed (or were never measured) are being re-counted in the background. Coverage for those rows is provisional.">
                node counts refreshing · {vectorStats.nodeCounts.queued} pending
              </div>
            )}
          </div>
        </div>
      )}

      {/* No Vectors Warning */}
      {vectorStats && vectorStats.totalVectors === 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <svg className="w-6 h-6 text-amber-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div className="flex-1">
              <h3 className="font-semibold text-amber-800">No Vector Embeddings Generated</h3>
              <p className="text-sm text-amber-700 mt-1">
                Semantic search requires vector embeddings to be generated for your code.
                You have <strong>{vectorStats.totalNodes.toLocaleString()}</strong> indexed nodes across <strong>{vectorStats.projects.length}</strong> projects that can be embedded.
              </p>
              {vectorStats.projects.length > 0 && (
                <div className="mt-3">
                  <label className="block text-sm font-medium text-amber-800 mb-1">Select a project to generate vectors:</label>
                  <div className="flex gap-2">
                    <select
                      className="flex-1 px-3 py-2 border border-amber-300 rounded-lg bg-white text-amber-900 focus:ring-2 focus:ring-amber-500"
                      onChange={(e) => {
                        if (e.target.value) {
                          generateMutation.mutate(parseInt(e.target.value, 10));
                        }
                      }}
                      disabled={generateMutation.isPending}
                    >
                      <option value="">Choose project...</option>
                      {vectorStats.projects.filter(p => p.nodeCount > 0).map(p => (
                        <option key={p.id} value={p.id}>{p.name} ({p.nodeCount} nodes)</option>
                      ))}
                    </select>
                    {generateMutation.isPending && (
                      <div className="flex items-center gap-2 text-amber-700">
                        <div className="animate-spin h-5 w-5 border-2 border-amber-600 border-t-transparent rounded-full"></div>
                        <span className="text-sm">Generating...</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
              {generateMutation.isSuccess && (
                <div className="mt-2 text-sm text-green-700 bg-green-50 p-2 rounded">
                  ✓ Generated {generateMutation.data.generated} vectors for project
                </div>
              )}
              {generateMutation.isError && (
                <div className="mt-2 text-sm text-red-700 bg-red-50 p-2 rounded">
                  Error: {generateMutation.error instanceof Error ? generateMutation.error.message : 'Generation failed'}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Generation Controls (when vectors exist) */}
      {vectorStats && vectorStats.totalVectors > 0 && selectedProject && (
        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-gray-700">Vector Status for Selected Project</h3>
              {(() => {
                const project = vectorStats.projects.find(p => p.id === selectedProject);
                if (!project) return null;
                const coverage = project.nodeCount > 0 ? Math.round((project.vectorCount / project.nodeCount) * 100) : 0;
                return (
                  <p className="text-sm text-gray-500 mt-1">
                    {project.vectorCount} / {project.nodeCount} nodes have embeddings ({coverage}% coverage)
                  </p>
                );
              })()}
            </div>
            <button
              onClick={() => generateMutation.mutate(selectedProject)}
              disabled={generateMutation.isPending}
              className="px-4 py-2 bg-purple-600 text-white text-sm rounded-lg hover:bg-purple-700 disabled:opacity-50 transition-colors flex items-center gap-2"
            >
              {generateMutation.isPending ? (
                <>
                  <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full"></div>
                  Generating...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Generate Vectors
                </>
              )}
            </button>
          </div>
          {generateMutation.isSuccess && generateMutation.data.projectId === selectedProject && (
            <div className="mt-2 text-sm text-green-700 bg-green-50 p-2 rounded">
              ✓ Generated {generateMutation.data.generated} new vectors
            </div>
          )}
        </div>
      )}

      {/* Related projects (ask scope): dependencies + dependents searched with the selected project */}
      {selectedProject && (
        <ProjectDependenciesPanel projectId={selectedProject} showDeclared={false} className="shadow" />
      )}

      {/* Controls */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Axon Project Selector (search mode, Axon source) */}
          {viewMode === 'search' && source === 'axon' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Axon Project <span className="text-gray-400 font-normal">(instance/project)</span></label>
              <SearchableComboBox
                options={[{ value: '', label: 'All Axon projects', description: `${axonProjects?.totals.vectors ?? 0} vectors` }, ...axonProjectOptions]}
                value={axonProject}
                onChange={(val) => setAxonProject(val ? String(val) : '')}
                placeholder="All Axon projects"
                searchPlaceholder="Search Axon projects..."
                isLoading={source === 'axon' && !axonProjects}
              />
            </div>
          )}
          {/* Project selection lives in the left sidebar (Fantom projects). */}

          {/* Search Input Combobox (Search Mode) */}
          {viewMode === 'search' && (
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Natural Language Query
              </label>
              <div className="flex gap-2">
                <div className="flex-1">
                  <SearchableComboBox
                    options={searchOptions}
                    value={searchQuery}
                    onChange={(val) => setSearchQuery(val?.toString() || '')}
                    placeholder="e.g., function that handles user authentication..."
                    searchPlaceholder="Type or select a query..."
                    allowFreeText
                    clearable
                  />
                </div>
                <select
                  value={mode}
                  onChange={(e) => setMode(e.target.value as 'vector' | 'rerank' | 'rlm')}
                  className="rounded-md border border-gray-300 py-2 px-3 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  title="Search mode"
                >
                  {source === 'axon' ? (
                    <>
                      <option value="vector">Vector only</option>
                      <option value="rerank">Vector + Reranker</option>
                      <option value="rlm">Vector + RLM</option>
                    </>
                  ) : (
                    <>
                      <option value="vector">Search only</option>
                      <option value="rlm">Search + Answer</option>
                    </>
                  )}
                </select>
                {source === 'fantom' && (
                  <div className="flex items-center gap-3 text-sm text-gray-700 whitespace-nowrap">
                    <label
                      className="flex items-center gap-1.5 cursor-pointer"
                      title="Cross-encoder rerank of the retrieved candidates — local GPU or OpenRouter per the routing policy. Off keeps the fused vector+keyword order."
                    >
                      <input type="checkbox" className="rounded border-gray-300" checked={rerankOn} onChange={(e) => setRerankOn(e.target.checked)} />
                      Reranker
                    </label>
                    <label
                      className={`flex items-center gap-1.5 ${mode === 'rlm' ? 'cursor-pointer' : 'opacity-50'}`}
                      title={mode === 'rlm'
                        ? 'Answer runs the RLM investigation loop (tool calls over search + call graph): deeper, cited answers, ~60–120s. Off: answer from retrieval only, ~20–40s.'
                        : 'Select "Search + Answer" to use the RLM'}
                    >
                      <input type="checkbox" className="rounded border-gray-300" checked={rlmDeep} disabled={mode !== 'rlm'} onChange={(e) => setRlmDeep(e.target.checked)} />
                      RLM search
                    </label>
                  </div>
                )}
                <button
                  onClick={handleSearch}
                  disabled={!searchQuery.trim() || searchMutation.isPending || askMutation.isPending || axonSearchMutation.isPending}
                  className="px-6 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 transition-colors"
                >
                  {searchMutation.isPending || askMutation.isPending || axonSearchMutation.isPending ? 'Searching...' : 'Search'}
                </button>
              </div>
            </div>
          )}

          {/* Color By (Project Mode) */}
          {viewMode === 'project' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Color By</label>
              <select
                value={colorBy}
                onChange={(e) => setColorBy(e.target.value as 'nodeType' | 'score')}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
              >
                <option value="nodeType">Node Type</option>
                <option value="score">Similarity Score</option>
              </select>
            </div>
          )}
        </div>
      </div>

      {/* Axon results (search mode, Axon source) — the Fantom panels below are hidden */}
      {viewMode === 'search' && source === 'axon' && (
        <AxonSearchResults
          data={axonSearchMutation.data}
          isPending={axonSearchMutation.isPending}
          error={axonSearchMutation.error}
          mode={mode}
        />
      )}

      {/* Search Error */}
      {source === 'fantom' && searchMutation.error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
          {searchMutation.error instanceof Error ? searchMutation.error.message : 'Search failed'}
        </div>
      )}

      {/* RLM Answer Panel */}
      {viewMode === 'search' && source === 'fantom' && mode === 'rlm' && (askMutation.isPending || askMutation.data || askMutation.error) && (
        <div className="bg-white rounded-lg shadow border border-purple-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between bg-purple-50">
            <h3 className="font-semibold text-gray-900">Answer</h3>
            {askMutation.data && (
              <div className="flex items-center gap-2 text-xs">
                <span className="px-2 py-0.5 rounded-full bg-purple-100 text-purple-800 font-medium">
                  {askMutation.data.provider} · {askMutation.data.model}
                </span>
                {askMutation.data.historyIncluded && (
                  <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 font-medium">history</span>
                )}
                <span className="text-gray-500">{askMutation.data.usedResults} sources</span>
                {askMutation.data.timings && (
                  <span
                    className={`px-2 py-0.5 rounded-full font-mono ${askMutation.data.timings.overBudget > 0 ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-700'}`}
                    title={`retrieval ${(askMutation.data.timings.retrievalMs / 1000).toFixed(1)}s · RLM ${(askMutation.data.timings.rlmMs / 1000).toFixed(1)}s · synthesis ${(askMutation.data.timings.synthesisMs / 1000).toFixed(1)}s · budget ${(askMutation.data.timings.budgetMs / 1000).toFixed(0)}s${askMutation.data.timings.fast ? ' (fast)' : ''} · RLM ${askMutation.data.timings.rlm ? 'on' : 'off'} · reranker ${askMutation.data.timings.rerank ? 'on' : 'off'}${askMutation.data.timings.overBudget > 0 ? ` · over by ${(askMutation.data.timings.overBudget / 1000).toFixed(1)}s` : ''}`}
                  >
                    {(askMutation.data.timings.totalMs / 1000).toFixed(1)}s
                    <span className="text-gray-400"> · r{(askMutation.data.timings.retrievalMs / 1000).toFixed(1)} rlm{(askMutation.data.timings.rlmMs / 1000).toFixed(1)} s{(askMutation.data.timings.synthesisMs / 1000).toFixed(1)}</span>
                  </span>
                )}
                {askMutation.data.timings && !askMutation.data.timings.rlm && (
                  <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-500" title="Turn on “RLM search” for the investigation loop">no RLM</span>
                )}
                {askMutation.data.timings && !askMutation.data.timings.rerank && (
                  <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">no reranker</span>
                )}
              </div>
            )}
          </div>
          <div className="p-4">
            {(askMutation.isPending || askEvents.length > 0) && (
              <div className="mb-3">
                <button
                  type="button"
                  onClick={() => setThinkingOpen(o => !o)}
                  className="flex items-center gap-2 text-gray-600 text-sm"
                  title="What the answer pipeline is doing: stages, the RLM's plan, each question it asks and what came back"
                >
                  <span className={`inline-block h-3 w-3 rounded-full ${askMutation.isPending ? 'bg-purple-400 animate-pulse' : 'bg-gray-300'}`} />
                  <span className="font-medium">{askMutation.isPending ? 'Thinking…' : 'Thinking'}</span>
                  {askMutation.isPending && <span className="font-mono text-gray-400">{(askElapsedMs / 1000).toFixed(1)}s</span>}
                  <span className="text-xs text-gray-400">{askEvents.filter(e => e.kind === 'ask').length} question{askEvents.filter(e => e.kind === 'ask').length === 1 ? '' : 's'} · {thinkingOpen ? 'hide' : 'show'}</span>
                </button>
                {thinkingOpen && (
                  <ol className="mt-2 max-h-72 overflow-y-auto rounded border border-gray-100 bg-gray-50 p-2 space-y-1 text-xs font-mono">
                    {askEvents.length === 0 && <li className="text-gray-400">waiting for the first step…</li>}
                    {askEvents.map((e) => {
                      const t = `${(e.t / 1000).toFixed(1)}s`;
                      if (e.kind === 'ask') {
                        const ans = askEvents.find(a => a.kind === 'answer' && a.id === e.id);
                        return (
                          <li key={e.seq} className="text-gray-800">
                            <span className="text-gray-400">{t}</span> <span className="text-purple-700">asking</span> {e.text}
                            {e.detail && <span className="text-gray-500"> — {e.detail}</span>}
                            {ans ? (
                              <div className="pl-10 text-emerald-700">→ {ans.text}{ans.ms !== undefined ? ` (${(ans.ms / 1000).toFixed(1)}s)` : ''}{ans.detail ? <span className="text-gray-500"> · {ans.detail}</span> : null}</div>
                            ) : (
                              <div className="pl-10 text-gray-400 animate-pulse">→ answering…</div>
                            )}
                          </li>
                        );
                      }
                      if (e.kind === 'answer') return null;
                      if (e.kind === 'plan') return (
                        <li key={e.seq} className="text-gray-700"><span className="text-gray-400">{t}</span> <span className="text-blue-700">plan</span> {e.text}
                          {e.items && e.items.length > 0 && <ul className="pl-10 list-disc text-gray-500">{e.items.map((it, i) => <li key={i}>{it}</li>)}</ul>}
                        </li>
                      );
                      if (e.kind === 'thought') return <li key={e.seq} className="text-gray-600 italic"><span className="text-gray-400 not-italic">{t}</span> {e.text}</li>;
                      if (e.kind === 'error') return <li key={e.seq} className="text-red-700"><span className="text-gray-400">{t}</span> {e.text}</li>;
                      return <li key={e.seq} className="text-gray-500"><span className="text-gray-400">{t}</span> {e.kind === 'stage' ? '' : `${e.kind} · `}{e.text}</li>;
                    })}
                  </ol>
                )}
              </div>
            )}
            {askMutation.isPending ? null : askMutation.error ? (
              <p className="text-sm text-red-700">
                {askMutation.error instanceof Error ? askMutation.error.message : 'Failed to synthesize an answer'}
              </p>
            ) : askMutation.data ? (
              <>
                <div className="prose prose-sm max-w-none text-gray-800">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{askMutation.data.answer}</ReactMarkdown>
                </div>
                {askMutation.data.citations.length > 0 && (
                  <div className="mt-4 border-t border-gray-100 pt-3">
                    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Sources</h4>
                    <ol className="space-y-1">
                      {askMutation.data.citations.map((c, i) => {
                        const inResults = !!searchMutation.data?.results.find(r => r.nodeId === c.nodeId);
                        return (
                          <li key={`${c.nodeId}-${i}`}>
                            <button
                              onClick={() => handleCitationClick(c.nodeId)}
                              disabled={!inResults}
                              className={`text-left text-xs ${inResults ? 'text-purple-700 hover:underline cursor-pointer' : 'text-gray-500 cursor-default'}`}
                            >
                              <span className="font-medium">{i + 1}. {c.qualifiedName}</span>
                              <span className="text-gray-400"> — {c.filePath}:{c.lineStart}</span>
                              {c.project && (
                                <span className="ml-1 rounded bg-blue-50 px-1 py-0.5 text-[10px] text-blue-700" title="Related project in the ask scope">{c.project}</span>
                              )}
                              {c.via === 'rlm' && (
                                <span className="ml-1 rounded bg-amber-50 px-1 py-0.5 text-[10px] text-amber-700" title="Found by the investigation model's tool calls, not in the initial search hits">found by RLM</span>
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                )}
              </>
            ) : null}
          </div>
        </div>
      )}

      {/* Main Content (Fantom source, or project-vectors mode) */}
      <div className={`grid grid-cols-1 lg:grid-cols-3 gap-6 ${viewMode === 'search' && source === 'axon' ? 'hidden' : ''}`}>
        {/* Scatter Plot */}
        <div className="lg:col-span-2 bg-white rounded-lg shadow overflow-hidden">
          {viewMode === 'search' ? (
            searchMutation.isPending ? (
              <ScatterLoading />
            ) : (
              <VectorScatter
                data={searchPoints}
                highlightIds={highlightedIds}
                onPointClick={handlePointClick}
                height={500}
                colorBy="score"
                sizeBy="score"
              />
            )
          ) : (
            isLoadingVectors ? (
              <ScatterLoading />
            ) : (
              <VectorScatter
                data={projectVectors?.nodes || []}
                onPointClick={handlePointClick}
                height={500}
                colorBy={colorBy}
              />
            )
          )}
        </div>

        {/* Results Panel */}
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="p-4 border-b border-gray-200">
            <h3 className="font-semibold text-gray-900">
              {viewMode === 'search' ? 'Search Results' : 'Project Nodes'}
            </h3>
            <p className="text-xs text-gray-500 mt-1">
              {viewMode === 'search'
                ? `${searchMutation.data?.results.length || 0} results`
                : `${projectVectors?.nodes.length || 0} nodes with embeddings${projectVectors?.loadMs !== undefined ? ` · loaded in ${projectVectors.loadMs} ms` : ''}`}
            </p>
          </div>

          <div className="max-h-96 overflow-y-auto">
            {viewMode === 'search' && searchMutation.data?.results.map((result) => (
              <button
                key={result.nodeId}
                id={`result-${result.nodeId}`}
                onClick={() => setSelectedResult(result)}
                className={`w-full text-left p-3 border-b border-gray-100 hover:bg-gray-50 transition-colors ${
                  selectedResult?.nodeId === result.nodeId ? 'bg-purple-50' : ''
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className="px-1.5 py-0.5 text-xs rounded font-medium"
                    style={{
                      backgroundColor: getNodeTypeColor(result.nodeType) + '20',
                      color: getNodeTypeColor(result.nodeType)
                    }}
                  >
                    {result.nodeType}
                  </span>
                  <span className="font-medium text-gray-900 truncate">{result.name}</span>
                </div>
                <p className="text-xs text-gray-500 font-mono truncate">{result.qualifiedName}</p>
                <div className="flex items-center gap-3 mt-2">
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-gray-400">Score:</span>
                    <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-yellow-400 to-green-500 rounded-full"
                        style={{ width: `${result.combinedScore * 100}%` }}
                      />
                    </div>
                    <span className="text-xs text-gray-600">{(result.combinedScore * 100).toFixed(0)}%</span>
                  </div>
                </div>
              </button>
            ))}

            {viewMode === 'project' && !isLoadingVectors && projectVectors?.nodes.slice(0, 50).map((node) => (
              <div
                key={node.id}
                className="p-3 border-b border-gray-100"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className="px-1.5 py-0.5 text-xs rounded font-medium"
                    style={{
                      backgroundColor: getNodeTypeColor(node.nodeType) + '20',
                      color: getNodeTypeColor(node.nodeType)
                    }}
                  >
                    {node.nodeType}
                  </span>
                  <span className="font-medium text-gray-900 truncate">{node.name}</span>
                </div>
                <p className="text-xs text-gray-500 font-mono truncate">{node.qualifiedName}</p>
              </div>
            ))}

            {viewMode === 'search' && !searchMutation.data?.results.length && !searchMutation.isPending && (
              <div className="p-8 text-center text-gray-500">
                <p>Enter a query to search</p>
              </div>
            )}

            {viewMode === 'project' && !selectedProject && (
              <div className="p-8 text-center text-gray-500">
                <p>Select a project to view vectors</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Selected Result Details */}
      {selectedResult && (
        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-2">
                <span
                  className="px-2 py-1 text-sm rounded font-medium"
                  style={{
                    backgroundColor: getNodeTypeColor(selectedResult.nodeType) + '20',
                    color: getNodeTypeColor(selectedResult.nodeType)
                  }}
                >
                  {selectedResult.nodeType}
                </span>
                <h3 className="text-lg font-semibold text-gray-900">{selectedResult.name}</h3>
              </div>
              <p className="text-sm text-gray-600 font-mono mb-2">{selectedResult.qualifiedName}</p>
              <p className="text-xs text-gray-400">{selectedResult.filePath}:{selectedResult.lineStart}</p>

              {selectedResult.signature && (
                <pre className="mt-3 p-3 bg-gray-50 rounded-lg text-sm font-mono overflow-x-auto">
                  {selectedResult.signature}
                </pre>
              )}

              {selectedResult.documentation && (
                <p className="mt-3 text-sm text-gray-600">{selectedResult.documentation}</p>
              )}

              <div className="flex gap-6 mt-4">
                <div>
                  <span className="text-xs text-gray-500">Semantic Score</span>
                  <div className="flex items-center gap-2">
                    <div className="w-20 h-2 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-purple-500 rounded-full"
                        style={{ width: `${selectedResult.semanticScore * 100}%` }}
                      />
                    </div>
                    <span className="text-sm font-medium">{(selectedResult.semanticScore * 100).toFixed(0)}%</span>
                  </div>
                </div>
                <div>
                  <span className="text-xs text-gray-500">Graph Score</span>
                  <div className="flex items-center gap-2">
                    <div className="w-20 h-2 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-500 rounded-full"
                        style={{ width: `${selectedResult.graphScore * 100}%` }}
                      />
                    </div>
                    <span className="text-sm font-medium">{(selectedResult.graphScore * 100).toFixed(0)}%</span>
                  </div>
                </div>
                {selectedResult.callerCount !== undefined && (
                  <div className="text-center">
                    <span className="text-xs text-gray-500">Callers</span>
                    <p className="text-lg font-semibold text-gray-800">{selectedResult.callerCount}</p>
                  </div>
                )}
                {selectedResult.calleeCount !== undefined && (
                  <div className="text-center">
                    <span className="text-xs text-gray-500">Callees</span>
                    <p className="text-lg font-semibold text-gray-800">{selectedResult.calleeCount}</p>
                  </div>
                )}
                {(selectedResult.containsCount ?? 0) > 0 && (
                  <div className="text-center">
                    <span className="text-xs text-gray-500">Members</span>
                    <p className="text-lg font-semibold text-gray-800">{selectedResult.containsCount}</p>
                  </div>
                )}
                {(selectedResult.usedByCount ?? 0) > 0 && (
                  <div className="text-center">
                    <span className="text-xs text-gray-500">Used By</span>
                    <p className="text-lg font-semibold text-gray-800">{selectedResult.usedByCount}</p>
                  </div>
                )}
                {(selectedResult.extendsCount ?? 0) > 0 && (
                  <div className="text-center">
                    <span className="text-xs text-gray-500">Subtypes</span>
                    <p className="text-lg font-semibold text-gray-800">{selectedResult.extendsCount}</p>
                  </div>
                )}
                {(selectedResult.implementsCount ?? 0) > 0 && (
                  <div className="text-center">
                    <span className="text-xs text-gray-500">Implementors</span>
                    <p className="text-lg font-semibold text-gray-800">{selectedResult.implementsCount}</p>
                  </div>
                )}
              </div>
            </div>
            <button
              onClick={() => setSelectedResult(null)}
              className="p-2 hover:bg-gray-100 rounded-lg"
            >
              <svg className="w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
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
