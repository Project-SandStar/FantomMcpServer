'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { getApiBase } from '@/lib/api';

type DebugConfig = {
  enabled?: boolean;
  segments?: Record<string, boolean>;
  levelMin?: 'debug' | 'info' | 'warn' | 'error';
  captureCrash?: boolean;
  maxFileMb?: number;
};

interface Props {
  config: DebugConfig;
  onChange: (next: DebugConfig) => void;
}

const QUICK_FILTERS = ['error', 'warn', 'FAIL', 'TIMEOUT', 'RSS_GUARD', 'EMBED', 'LADYBUG'];

function authHeaderValue(): string {
  if (typeof window === 'undefined') return 'Basic ' + btoa('admin:admin');
  const u = localStorage.getItem('admin_user') || 'admin';
  const p = localStorage.getItem('admin_pass') || 'admin';
  return 'Basic ' + btoa(`${u}:${p}`);
}

export function DebugLogPanel({ config, onChange }: Props) {
  const enabled = config.enabled ?? false;
  const segments = config.segments ?? {};
  const levelMin = config.levelMin ?? 'info';
  const captureCrash = config.captureCrash ?? true;
  const maxFileMb = config.maxFileMb ?? 100;

  const [lines, setLines] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [paused, setPaused] = useState(false);
  const [logSize, setLogSize] = useState<number | null>(null);
  const [streamErr, setStreamErr] = useState<string | null>(null);
  // Source picker: '_crash' = the SIGKILL-survivable forensic file (default),
  // 'all' = the combined async file, or any specific segment tag.
  const [source, setSource] = useState<string>('_crash');
  const [seenSegments, setSeenSegments] = useState<string[]>([]);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Fetch the segment list once and refresh when the panel re-mounts.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${getApiBase()}/admin/debug/segments`, {
          headers: { Authorization: authHeaderValue() },
        });
        if (!r.ok) return;
        const j = await r.json();
        if (!cancelled) setSeenSegments((j.segments as string[]) ?? []);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [enabled]);

  // Initial tail load + open SSE stream when enabled. Re-runs when the
  // operator changes the source picker so the viewer follows the chosen
  // file/segment.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const apiBase = getApiBase();
    setLines([]);
    setStreamErr(null);

    const isCrashOrAll = source === '_crash' || source === 'all';
    const tailUrl = isCrashOrAll
      ? `${apiBase}/admin/debug/log?tail=500&source=${source === 'all' ? 'all' : 'crash'}`
      : `${apiBase}/admin/debug/log/${encodeURIComponent(source)}?tail=500`;
    const streamUrl = isCrashOrAll
      ? `${apiBase}/admin/debug/log/stream?source=${source === 'all' ? 'all' : 'crash'}`
      : `${apiBase}/admin/debug/log/${encodeURIComponent(source)}/stream`;

    (async () => {
      try {
        const r = await fetch(tailUrl, { headers: { Authorization: authHeaderValue() } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (cancelled) return;
        setLines((j.lines as string[]).filter(Boolean));
        setLogSize(j.size ?? null);
      } catch (e) {
        setStreamErr(e instanceof Error ? e.message : 'tail failed');
      }
    })();

    const es = new EventSource(streamUrl, { withCredentials: true });
    es.onmessage = (ev) => {
      try {
        const { line } = JSON.parse(ev.data) as { line: string };
        if (line) setLines((prev) => (prev.length > 5000 ? [...prev.slice(-4000), line] : [...prev, line]));
      } catch { /* ignore */ }
    };
    es.onerror = () => {
      setStreamErr('stream disconnected, retrying…');
    };
    return () => {
      cancelled = true;
      es.close();
    };
  }, [enabled, source]);

  useEffect(() => {
    if (paused) return;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, paused]);

  const filtered = useMemo(() => {
    if (!search.trim()) return lines;
    const q = search.toLowerCase();
    return lines.filter((l) => l.toLowerCase().includes(q));
  }, [lines, search]);

  const toggleSegment = (tag: string, value: boolean) => {
    onChange({ ...config, segments: { ...segments, [tag]: value } });
  };

  const downloadHref = source === '_crash' || source === 'all'
    ? `${getApiBase()}/admin/debug/log/download`
    : `${getApiBase()}/admin/debug/log/${encodeURIComponent(source)}/download`;

  return (
    <div className="space-y-4">
      {/* Top row: master toggle + level + size cap + capture-crash */}
      <div className="flex items-center gap-3 flex-wrap">
        <label className="inline-flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onChange({ ...config, enabled: e.target.checked })}
            className="w-4 h-4"
          />
          <span className="text-sm font-medium text-gray-700">Enable debug file logging</span>
        </label>

        <label className="inline-flex items-center gap-2 text-sm text-gray-700">
          Min level
          <select
            value={levelMin}
            disabled={!enabled}
            onChange={(e) => onChange({ ...config, levelMin: e.target.value as DebugConfig['levelMin'] })}
            className="px-2 py-1 border border-gray-300 rounded-md text-sm"
          >
            <option value="debug">debug</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>
        </label>

        <label className="inline-flex items-center gap-2 text-sm text-gray-700">
          Max file size (MB)
          <input
            type="number"
            min={0}
            max={4096}
            value={maxFileMb}
            disabled={!enabled}
            onChange={(e) => onChange({ ...config, maxFileMb: parseInt(e.target.value) || 0 })}
            className="w-20 px-2 py-1 border border-gray-300 rounded-md text-sm"
          />
        </label>

        <label className="inline-flex items-center gap-2 cursor-pointer text-sm">
          <input
            type="checkbox"
            checked={captureCrash}
            disabled={!enabled}
            onChange={(e) => onChange({ ...config, captureCrash: e.target.checked })}
            className="w-4 h-4"
          />
          <span className="text-gray-700">Capture crash forensics</span>
        </label>
      </div>

      {!enabled && (
        <div className="bg-gray-50 border border-gray-200 rounded-md p-4 text-sm text-gray-600">
          Debug file logging is off. The server will not write any files in <code className="bg-gray-100 px-1 rounded">logs/</code>.
          Stderr is still captured by the start script to <code className="bg-gray-100 px-1 rounded">logs/server.log</code>.
        </div>
      )}

      {/* Segment grid: which tags emit per-segment files when enabled */}
      {enabled && (
        <div className="bg-white border border-gray-200 rounded-md p-3">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-medium text-gray-900">Segments</h4>
            <span className="text-xs text-gray-500">
              none enabled → all writes go to <code className="bg-gray-100 px-1 rounded">logs/all.log</code>
            </span>
          </div>
          {seenSegments.length === 0 ? (
            <p className="text-xs text-gray-500">no segments observed yet — emit a log line to populate this list</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1">
              {seenSegments.map((tag) => (
                <label key={tag} className="inline-flex items-center gap-2 text-xs cursor-pointer hover:bg-gray-50 px-1 py-0.5 rounded">
                  <input
                    type="checkbox"
                    checked={!!segments[tag]}
                    onChange={(e) => toggleSegment(tag, e.target.checked)}
                    className="w-3.5 h-3.5"
                  />
                  <span className="font-mono text-gray-700 truncate">{tag}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Viewer controls */}
      {enabled && (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <label className="inline-flex items-center gap-2 text-sm text-gray-700">
              View
              <select
                value={source}
                onChange={(e) => setSource(e.target.value)}
                className="px-2 py-1 border border-gray-300 rounded-md text-sm"
              >
                <option value="_crash">_crash (forensic)</option>
                <option value="all">all (combined async)</option>
                {seenSegments.map((tag) => (
                  <option key={tag} value={tag}>{tag}</option>
                ))}
              </select>
            </label>

            <a
              href={downloadHref}
              className="px-3 py-1.5 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-sm"
            >
              Download
            </a>
            <button
              onClick={() => setLines([])}
              className="px-3 py-1.5 bg-gray-200 text-gray-800 rounded-md hover:bg-gray-300 text-sm"
            >
              Clear viewer
            </button>
            <button
              onClick={() => setPaused((p) => !p)}
              className={`px-3 py-1.5 rounded-md text-sm ${paused ? 'bg-amber-500 text-white hover:bg-amber-600' : 'bg-gray-200 text-gray-800 hover:bg-gray-300'}`}
            >
              {paused ? 'Resume scroll' : 'Pause scroll'}
            </button>
            {logSize != null && (
              <span className="text-xs text-gray-500">
                file: {(logSize / 1024 / 1024).toFixed(1)} MB
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter lines (substring, case-insensitive)…"
              className="flex-1 min-w-[240px] px-3 py-2 border border-gray-300 rounded-md text-sm font-mono"
            />
            <span className="text-xs text-gray-500">
              {filtered.length} / {lines.length}
            </span>
            <div className="flex gap-1 flex-wrap">
              {QUICK_FILTERS.map((q) => (
                <button
                  key={q}
                  onClick={() => setSearch(q)}
                  className="px-2 py-1 bg-gray-100 hover:bg-gray-200 text-xs rounded font-mono"
                >
                  {q}
                </button>
              ))}
              {search && (
                <button
                  onClick={() => setSearch('')}
                  className="px-2 py-1 bg-red-100 hover:bg-red-200 text-red-700 text-xs rounded"
                >
                  clear
                </button>
              )}
            </div>
          </div>

          {streamErr && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
              {streamErr}
            </div>
          )}

          <div
            ref={containerRef}
            onMouseEnter={() => setPaused(true)}
            onMouseLeave={() => setPaused(false)}
            className="h-[500px] overflow-auto bg-gray-900 text-gray-100 text-xs font-mono p-3 rounded-md"
          >
            {filtered.length === 0 && (
              <div className="text-gray-500">no lines{search ? ` match "${search}"` : ''}</div>
            )}
            {filtered.map((l, i) => {
              const lower = l.toLowerCase();
              const cls =
                lower.includes('error') || lower.includes('fail') || lower.includes('uncaught')
                  ? 'text-red-300'
                  : lower.includes('warn') || lower.includes('timeout')
                    ? 'text-amber-300'
                    : lower.includes('ladybug_open') || lower.includes('embed_loop')
                      ? 'text-cyan-300'
                      : 'text-gray-100';
              return (
                <div key={i} className={`whitespace-pre-wrap break-all ${cls}`}>
                  {l}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
