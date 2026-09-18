'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatRunAnchor, formatRelative } from '@/lib/time';

interface IndexRunStripProps {
  projectId: number;
  selectedIso: string | null;
  onSelect: (iso: string | null) => void;
  // Optional: render two separate selections (for Diff range mode in graph-3D).
  selectedFrom?: string | null;
  selectedTo?: string | null;
  onRangeSelect?: (which: 'from' | 'to', iso: string) => void;
}

// Horizontal SVG strip showing recent IndexRuns as stacked bars.
// Bar height proportional to addedCount + modifiedCount + removedCount.
// Click → set selection. Hover → tooltip.
export function IndexRunStrip({
  projectId,
  selectedIso,
  onSelect,
  selectedFrom,
  selectedTo,
  onRangeSelect,
}: IndexRunStripProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['index-runs', projectId],
    queryFn: () => api.listIndexRuns(projectId, 30),
    enabled: projectId > 0,
  });

  if (isLoading) return <div className="text-xs text-gray-500 py-2">Loading run history…</div>;
  if (error) return <div className="text-xs text-red-500 py-2">Failed to load runs: {String(error)}</div>;
  if (!data || data.runs.length === 0) {
    return (
      <div className="text-xs text-gray-500 py-2">
        No indexing runs recorded yet. Run a refresh to seed history.
      </div>
    );
  }

  // Reverse so oldest is left, newest is right.
  const runs = [...data.runs].reverse();
  const maxTotal = Math.max(
    1,
    ...runs.map((r) => r.addedCount + r.modifiedCount + r.removedCount),
  );
  const barWidth = 14;
  const gap = 2;
  const height = 56;
  const totalWidth = runs.length * (barWidth + gap);

  return (
    <div className="border border-gray-200 rounded bg-white px-3 py-2">
      <div className="flex items-center justify-between mb-1 text-xs text-gray-500">
        <span>Recent indexing runs (oldest → newest)</span>
        <span>{data.total} total</span>
      </div>
      <div className="overflow-x-auto">
        <svg
          width={totalWidth}
          height={height}
          className="block"
          style={{ minWidth: '100%' }}
        >
          {runs.map((r, i) => {
            const total = r.addedCount + r.modifiedCount + r.removedCount;
            const ratio = total / maxTotal;
            const barH = Math.max(2, ratio * (height - 14));
            const y = height - 14 - barH;
            const x = i * (barWidth + gap);
            const addedH = total ? (r.addedCount / total) * barH : 0;
            const modH = total ? (r.modifiedCount / total) * barH : 0;
            const remH = total ? (r.removedCount / total) * barH : 0;
            const isSelected = r.startedAt && r.startedAt === selectedIso;
            const isFrom = r.startedAt && r.startedAt === selectedFrom;
            const isTo = r.startedAt && r.startedAt === selectedTo;
            const stroke = isSelected ? '#2563eb' : isFrom ? '#10b981' : isTo ? '#f59e0b' : 'transparent';
            return (
              <g
                key={r.id}
                transform={`translate(${x},0)`}
                style={{ cursor: 'pointer' }}
                onClick={() => {
                  if (onRangeSelect && r.startedAt) {
                    // In range mode, set 'from' first, then 'to' on second click.
                    if (!selectedFrom) onRangeSelect('from', r.startedAt);
                    else onRangeSelect('to', r.startedAt);
                  } else {
                    onSelect(r.startedAt);
                  }
                }}
              >
                <title>
                  {`Run #${r.id}\n${formatRunAnchor(r.startedAt)} (${formatRelative(r.startedAt)})\ntrigger: ${r.trigger}\n+${r.addedCount} ~${r.modifiedCount} -${r.removedCount}`}
                </title>
                <rect
                  x={0}
                  y={y - 1}
                  width={barWidth}
                  height={barH + 14}
                  fill={isSelected || isFrom || isTo ? 'rgba(37,99,235,0.08)' : 'transparent'}
                  stroke={stroke}
                  strokeWidth={isSelected || isFrom || isTo ? 1.5 : 0}
                />
                <rect x={1} y={y} width={barWidth - 2} height={addedH} fill="#10b981" />
                <rect x={1} y={y + addedH} width={barWidth - 2} height={modH} fill="#f59e0b" />
                <rect x={1} y={y + addedH + modH} width={barWidth - 2} height={remH} fill="#ef4444" />
                <text
                  x={barWidth / 2}
                  y={height - 2}
                  textAnchor="middle"
                  fontSize={8}
                  fill="#6b7280"
                >
                  {r.id}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="flex items-center gap-3 text-[10px] text-gray-500 mt-1">
        <LegendDot color="#10b981" label="added" />
        <LegendDot color="#f59e0b" label="modified" />
        <LegendDot color="#ef4444" label="removed" />
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className="inline-block w-2 h-2 rounded-sm"
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  );
}
