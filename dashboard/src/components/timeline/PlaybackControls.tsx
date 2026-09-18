'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface PlaybackControlsProps {
  projectId: number;
  onTick: (atTime: string) => void;
  // When true, only advance to runs with non-zero changes.
  skipEmptyRuns?: boolean;
}

// "Play through history" — animates the snapshot picker through recorded
// IndexRuns at a configurable cadence. Pause/resume + speed slider.
export function PlaybackControls({
  projectId,
  onTick,
  skipEmptyRuns = true,
}: PlaybackControlsProps) {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<0.5 | 1 | 2 | 4>(1);
  const [idx, setIdx] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data } = useQuery({
    queryKey: ['index-runs', projectId, 'playback'],
    queryFn: () => api.listIndexRuns(projectId, 100),
    enabled: projectId > 0,
  });

  // Build the play queue: chronological (oldest → newest), filtered.
  const queue = (() => {
    const all = data?.runs ?? [];
    const sorted = [...all].sort(
      (a, b) =>
        new Date(a.startedAt ?? 0).getTime() -
        new Date(b.startedAt ?? 0).getTime(),
    );
    return skipEmptyRuns
      ? sorted.filter(
          (r) => r.addedCount + r.modifiedCount + r.removedCount > 0,
        )
      : sorted;
  })();

  useEffect(() => {
    if (!playing) {
      if (timerRef.current) clearTimeout(timerRef.current);
      return;
    }
    if (idx >= queue.length) {
      setPlaying(false);
      return;
    }
    const run = queue[idx];
    if (run?.startedAt) onTick(run.startedAt);
    const delay = 800 / speed;
    timerRef.current = setTimeout(() => setIdx((i) => i + 1), delay);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [playing, idx, speed, queue, onTick]);

  if (!data || data.runs.length === 0) return null;

  return (
    <div className="flex items-center gap-3 text-xs">
      <button
        type="button"
        onClick={() => {
          if (!playing) {
            if (idx >= queue.length) setIdx(0);
            setPlaying(true);
          } else {
            setPlaying(false);
          }
        }}
        className="px-2 py-1 border border-gray-300 rounded bg-white hover:bg-gray-50"
        title={playing ? 'Pause' : 'Play history'}
      >
        {playing ? '⏸ Pause' : '▶ Play history'}
      </button>
      <button
        type="button"
        onClick={() => {
          setPlaying(false);
          setIdx(0);
        }}
        className="px-2 py-1 border border-gray-300 rounded bg-white hover:bg-gray-50"
        title="Restart"
      >
        ⏮
      </button>
      <label className="flex items-center gap-1 text-gray-700">
        speed:
        <select
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value) as 0.5 | 1 | 2 | 4)}
          className="border border-gray-300 rounded px-1 py-0.5"
        >
          <option value={0.5}>0.5×</option>
          <option value={1}>1×</option>
          <option value={2}>2×</option>
          <option value={4}>4×</option>
        </select>
      </label>
      <span className="text-gray-500">
        run {Math.min(idx + 1, queue.length)} / {queue.length}
        {skipEmptyRuns && ` (skip empty)`}
      </span>
    </div>
  );
}
