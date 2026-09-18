'use client';

import { TimelinePicker } from './TimelinePicker';
import { IndexRunStrip } from './IndexRunStrip';
import { HistoryPanel } from './HistoryPanel';

interface TimelineSectionProps {
  projectId: number;
  atTime: string | null;
  onChange: (iso: string | null) => void;
  compareToCurrent?: boolean;
  onCompareToggle?: (next: boolean) => void;
}

// Composite for the AST viewer. One drop-in section that gives the user the
// picker + run strip + anchor banner. The graph-3D variant uses these
// pieces individually plus the diff-range tab.
export function TimelineSection({
  projectId,
  atTime,
  onChange,
  compareToCurrent = false,
  onCompareToggle,
}: TimelineSectionProps) {
  if (!projectId || projectId <= 0) return null;
  return (
    <section className="space-y-2 my-4">
      <div className="flex flex-wrap items-center gap-3">
        <TimelinePicker value={atTime} onChange={onChange} />
        {onCompareToggle && (
          <label className="flex items-center gap-1 text-xs text-gray-700">
            <input
              type="checkbox"
              checked={compareToCurrent}
              onChange={(e) => onCompareToggle(e.target.checked)}
            />
            Compare to current
          </label>
        )}
      </div>
      <IndexRunStrip projectId={projectId} selectedIso={atTime} onSelect={onChange} />
      <HistoryPanel projectId={projectId} atTime={atTime} compareToCurrent={compareToCurrent} />
    </section>
  );
}
