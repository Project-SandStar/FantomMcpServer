'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatRunAnchor, formatRelative } from '@/lib/time';

interface HistoryPanelProps {
  projectId: number;
  atTime: string | null; // null = "current"
  compareToCurrent?: boolean;
}

// Banner-style component that shows the resolved IndexRun anchor + change
// counts + collapsible warnings list.
export function HistoryPanel({
  projectId,
  atTime,
  compareToCurrent = false,
}: HistoryPanelProps) {
  const [warningsOpen, setWarningsOpen] = useState(false);

  const { data: diff } = useQuery({
    queryKey: ['project-diff', projectId, atTime ?? 'current', 'now'],
    queryFn: () => api.getProjectDiff(projectId, atTime!, undefined),
    enabled: projectId > 0 && !!atTime && compareToCurrent,
  });

  if (!atTime) {
    return (
      <div className="px-3 py-2 bg-blue-50 border border-blue-200 rounded text-sm text-blue-800">
        Showing <strong>current state</strong>. Pick a time above to view history.
      </div>
    );
  }

  const counts = diff?.totals ?? null;
  const fromAnchor = diff?.fromRun ?? null;

  return (
    <div className="px-3 py-2 bg-amber-50 border border-amber-200 rounded text-sm text-amber-900">
      <div className="flex flex-wrap items-center gap-2">
        <span>
          Showing state as of{' '}
          <strong>{formatRunAnchor(atTime)}</strong>{' '}
          <span className="text-xs text-amber-700">({formatRelative(atTime)})</span>
        </span>
        {fromAnchor && (
          <span className="text-xs">
            anchored to run #{fromAnchor.id} ({formatRunAnchor(fromAnchor.occurredAt)})
          </span>
        )}
        {counts && (
          <span className="text-xs">
            since then: <span className="text-emerald-700">+{counts.added}</span>{' '}
            <span className="text-yellow-700">~{counts.modified}</span>{' '}
            <span className="text-red-700">-{counts.removed}</span>
          </span>
        )}
        <button
          type="button"
          onClick={() => setWarningsOpen((v) => !v)}
          className="text-xs underline ml-auto"
        >
          {warningsOpen ? 'hide' : 'show'} caveats
        </button>
      </div>
      {warningsOpen && (
        <ul className="text-xs text-amber-800 mt-2 list-disc list-inside space-y-0.5">
          <li>Symbols deleted before the earliest indexing run aren&apos;t visible.</li>
          <li>Line positions for older symbols may be approximate (line columns are populated only for recent changes).</li>
          <li>Edge history isn&apos;t tracked yet — graph edges reflect the current build.</li>
          <li>Time resolution is per-IndexRun. For finer-grained history, see git log of the project root.</li>
        </ul>
      )}
    </div>
  );
}
