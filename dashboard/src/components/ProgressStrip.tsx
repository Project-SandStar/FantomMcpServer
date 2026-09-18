'use client';

import { useQuery } from '@tanstack/react-query';
import { getApiBase } from '@/lib/api';

// Per-project AST + Vector progress strip used at the top of the AST viewer.
// Polls /admin/indexing/state/:projectId (cheap, in-memory snapshot) while a
// pipeline is running so the bar advances per-file. When idle, falls back to
// /admin/vectors/stats to show steady-state coverage.

interface IndexingState {
  projectId: number;
  running: boolean;
  snapshot: {
    projectName: string;
    status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
    currentStage: string | null;
    stages: Array<{
      stage: string;
      status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
      itemsProcessed?: number;
      itemsTotal?: number;
      message?: string;
    }>;
    error?: string;
  } | null;
}

interface VectorStats {
  totalVectors: number;
  totalNodes: number;
  coveragePercent: string;
  projects: Array<{
    id: number;
    name: string;
    nodeCount: number;
    vectorCount: number;
    embeddingModel?: string | null;
    embeddingDimensions?: number | null;
    embeddingSidecarName?: string | null;
    embeddingSidecarHost?: string | null;
    embeddingSidecarModel?: string | null;
    embeddedInProcess?: boolean | null;
    embeddedAt?: string | null;
  }>;
}

function authHeader(): string {
  const u = typeof window !== 'undefined' ? localStorage.getItem('admin_user') || 'admin' : 'admin';
  const p = typeof window !== 'undefined' ? localStorage.getItem('admin_pass') || 'admin' : 'admin';
  return 'Basic ' + btoa(`${u}:${p}`);
}

async function fetchIndexingState(projectId: number): Promise<IndexingState> {
  const res = await fetch(`${getApiBase()}/admin/indexing/state/${projectId}`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) throw new Error(`indexing/state ${res.status}`);
  return res.json();
}

async function fetchVectorStats(): Promise<VectorStats> {
  const res = await fetch(`${getApiBase()}/admin/vectors/stats`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) throw new Error(`vectors/stats ${res.status}`);
  return res.json();
}

interface ProgressStripProps {
  projectId: number | null;
  /** When true, hide chrome around the strip (used when embedded inline). */
  compact?: boolean;
  /** Aggregate label override; when present, treats projectId as scope hint only. */
  aggregateLabel?: string;
}

export function ProgressStrip({ projectId, compact, aggregateLabel }: ProgressStripProps) {
  const { data: state } = useQuery({
    queryKey: ['indexing-state', projectId],
    queryFn: () => (projectId ? fetchIndexingState(projectId) : Promise.resolve(null)),
    enabled: projectId != null,
    // Poll fast while running, slower when idle. Refetch interval is updated by
    // returning a number from the function form of refetchInterval.
    refetchInterval: (q) => {
      const d = q.state.data as IndexingState | null | undefined;
      return d?.running ? 1500 : 30_000;
    },
  });

  const { data: vectors } = useQuery({
    queryKey: ['vector-stats'],
    queryFn: fetchVectorStats,
    refetchInterval: 30_000,
  });

  // Resolve numbers for the two bars.
  const running = state?.running ?? false;
  const stages = state?.snapshot?.stages ?? [];
  const parsing = stages.find((s) => s.stage === 'parsing');
  const graphBuilding = stages.find((s) => s.stage === 'graph-building');

  // AST bar source of truth:
  //   - while running: parsing or graph-building stage's itemsProcessed/Total
  //   - when idle:    100% if project has nodes, 0% otherwise
  let astNum = 0;
  let astDen = 0;
  let astLabel = '';
  if (running && parsing && (parsing.status === 'running' || parsing.status === 'completed')) {
    if (parsing.status === 'running') {
      astNum = parsing.itemsProcessed ?? 0;
      astDen = parsing.itemsTotal ?? 0;
      astLabel = `parsing ${astNum}/${astDen} files`;
    } else if (graphBuilding && graphBuilding.status !== 'pending') {
      astNum = graphBuilding.itemsProcessed ?? 0;
      astDen = graphBuilding.itemsTotal ?? 0;
      astLabel = graphBuilding.status === 'running' ? `building graph ${astNum}/${astDen}` : 'graph built';
      if (graphBuilding.status === 'completed') {
        astNum = astDen = 1;
      }
    }
  } else if (projectId && vectors) {
    const proj = vectors.projects.find((p) => p.id === projectId);
    const nodes = proj?.nodeCount ?? 0;
    astNum = nodes > 0 ? 1 : 0;
    astDen = 1;
    astLabel = nodes > 0 ? `${nodes.toLocaleString()} nodes indexed` : 'not indexed';
  }
  const astPct = astDen > 0 ? Math.min(100, Math.round((astNum / astDen) * 100)) : 0;

  // Vectors bar: vectorCount / nodeCount for the project.
  let vecNum = 0;
  let vecDen = 0;
  let vecModel: string | null = null;
  let vecDims: number | null = null;
  let vecSidecarName: string | null = null;
  let vecSidecarHost: string | null = null;
  let vecInProcess: boolean | null = null;
  if (projectId && vectors) {
    const proj = vectors.projects.find((p) => p.id === projectId);
    vecNum = proj?.vectorCount ?? 0;
    vecDen = proj?.nodeCount ?? 0;
    vecModel = proj?.embeddingModel ?? null;
    vecDims = proj?.embeddingDimensions ?? null;
    vecSidecarName = proj?.embeddingSidecarName ?? null;
    vecSidecarHost = proj?.embeddingSidecarHost ?? null;
    vecInProcess = proj?.embeddedInProcess ?? null;
  }
  const vecPct = vecDen > 0 ? Math.min(100, Math.round((vecNum / vecDen) * 100)) : 0;

  // Header line.
  const errorMsg = state?.snapshot?.error;
  const failed = state?.snapshot?.status === 'failed';
  const stageLabel = state?.snapshot?.currentStage ?? null;

  let statusPill: { text: string; bg: string; fg: string };
  if (failed) {
    statusPill = { text: `failed: ${errorMsg ?? 'see logs'}`, bg: 'bg-red-100', fg: 'text-red-800' };
  } else if (running) {
    statusPill = { text: `running${stageLabel ? `: ${stageLabel}` : ''}`, bg: 'bg-amber-100', fg: 'text-amber-800' };
  } else if (astPct === 100 && vecPct === 100) {
    statusPill = { text: 'fresh', bg: 'bg-emerald-100', fg: 'text-emerald-800' };
  } else if (astPct === 100 && vecPct < 100) {
    statusPill = { text: 'parsed, partial embeddings', bg: 'bg-sky-100', fg: 'text-sky-800' };
  } else {
    statusPill = { text: 'idle', bg: 'bg-gray-100', fg: 'text-gray-700' };
  }

  if (projectId == null) {
    return null;
  }

  // Collapsed happy-path: both bars 100% and not running.
  const collapsedHappy = !running && !failed && astPct === 100 && vecPct === 100;

  if (collapsedHappy && !aggregateLabel) {
    return (
      <div
        className={`flex items-center gap-3 text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2 ${compact ? '' : 'mb-4'}`}
      >
        <span aria-hidden>✓</span>
        <span>
          Index fresh — {(vecDen).toLocaleString()} nodes, 100% embedded
        </span>
        {vecModel && (
          <span className="ml-auto text-xs font-mono px-1.5 py-0.5 bg-emerald-100 text-emerald-800 rounded" title="Embedding model used for stored vectors">
            {vecModel}{vecDims ? ` · ${vecDims}d` : ''}
          </span>
        )}
        {(vecSidecarName || vecInProcess) && (
          <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${vecInProcess ? 'bg-gray-200 text-gray-700' : 'bg-blue-100 text-blue-800'}`}
            title="Where this project was last embedded">
            {vecInProcess ? 'in-process' : `${vecSidecarName ?? '?'}${vecSidecarHost ? ` ${vecSidecarHost}` : ''}`}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className={`bg-white border border-gray-200 rounded-md px-4 py-3 ${compact ? '' : 'mb-4'}`}
      data-testid="progress-strip"
    >
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-medium text-gray-800">
          {aggregateLabel ?? 'Indexing Progress'}
        </div>
        <span className={`text-xs px-2 py-0.5 rounded ${statusPill.bg} ${statusPill.fg}`}>
          {statusPill.text}
        </span>
      </div>

      {/* AST bar */}
      <div className="mb-2">
        <div className="flex items-center justify-between text-xs text-gray-600 mb-0.5">
          <span>AST Parse</span>
          <span>
            {astPct}% {astLabel ? `· ${astLabel}` : ''}
          </span>
        </div>
        <div className="w-full h-2 bg-gray-100 rounded overflow-hidden">
          <div
            className="h-full bg-purple-500 transition-all"
            style={{ width: `${astPct}%` }}
          />
        </div>
      </div>

      {/* Vectors bar */}
      <div>
        <div className="flex items-center justify-between text-xs text-gray-600 mb-0.5">
          <span className="flex items-center gap-2">
            Vectors
            {vecModel && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 bg-blue-50 text-blue-800 rounded" title="Embedding model used for stored vectors">
                {vecModel}{vecDims ? ` · ${vecDims}d` : ''}
              </span>
            )}
            {(vecSidecarName || vecInProcess) && (
              <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${vecInProcess ? 'bg-gray-200 text-gray-700' : 'bg-blue-50 text-blue-800'}`}
                title="Where this project was last embedded">
                {vecInProcess ? 'in-process' : `${vecSidecarName ?? '?'}${vecSidecarHost ? ` ${vecSidecarHost}` : ''}`}
              </span>
            )}
          </span>
          <span>
            {vecPct}% · {vecNum.toLocaleString()}/{vecDen.toLocaleString()} embedded
          </span>
        </div>
        <div className="w-full h-2 bg-gray-100 rounded overflow-hidden">
          <div
            className="h-full bg-teal-500 transition-all"
            style={{ width: `${vecPct}%` }}
          />
        </div>
      </div>
    </div>
  );
}
