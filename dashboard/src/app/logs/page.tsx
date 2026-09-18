'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

// Use relative URLs since dashboard is served from the same server
const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';

interface LogEntry {
  message: string;
  timestamp: string;
}

export default function LogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Connect to SSE stream
  useEffect(() => {
    const username = localStorage.getItem('admin_user') || 'admin';
    const password = localStorage.getItem('admin_pass') || 'admin';
    const authHeader = btoa(`${username}:${password}`);

    // Note: EventSource doesn't support custom headers, so we'll use fetch with ReadableStream
    const controller = new AbortController();

    async function connectToLogs() {
      try {
        const response = await fetch(`${API_BASE}/admin/logs`, {
          headers: {
            'Authorization': `Basic ${authHeader}`,
          },
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Failed to connect: ${response.status}`);
        }

        setConnected(true);
        setError(null);

        const reader = response.body?.getReader();
        if (!reader) return;

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                setLogs((prev) => {
                  const newLogs = [...prev, data as LogEntry];
                  // Keep only last 500 logs
                  if (newLogs.length > 500) {
                    return newLogs.slice(-500);
                  }
                  return newLogs;
                });
              } catch (e) {
                // Ignore parse errors for keepalive messages
              }
            }
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name !== 'AbortError') {
          setError(err.message);
          setConnected(false);
        }
      }
    }

    connectToLogs();

    return () => {
      controller.abort();
    };
  }, []);

  // Auto-scroll effect
  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

  // Handle manual scroll
  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
    if (!isAtBottom && autoScroll) {
      setAutoScroll(false);
    }
  }, [autoScroll]);

  // Clear logs
  const handleClear = () => {
    setLogs([]);
  };

  // Filter logs
  const filteredLogs = filter
    ? logs.filter((log) => log.message.toLowerCase().includes(filter.toLowerCase()))
    : logs;

  // Determine log level color
  const getLogColor = (message: string): string => {
    if (message.includes('error') || message.includes('Error') || message.includes('ERROR')) {
      return 'text-red-400';
    }
    if (message.includes('warn') || message.includes('Warn') || message.includes('WARN')) {
      return 'text-yellow-400';
    }
    if (message.includes('debug') || message.includes('Debug') || message.includes('DEBUG')) {
      return 'text-gray-500';
    }
    return 'text-gray-300';
  };

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Server Logs</h1>
        <p className="text-gray-600 mt-1">Real-time log stream from the MCP server</p>
      </div>

      {/* Controls */}
      <div className="bg-white rounded-lg shadow p-4 mb-4">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex-1 min-w-[200px]">
            <input
              type="text"
              placeholder="Filter logs..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="w-full rounded-md border border-gray-300 py-2 px-3 text-sm shadow-sm focus:border-blue-500 focus:outline-none"
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            Auto-scroll
          </label>

          <button
            onClick={handleClear}
            className="px-4 py-2 text-sm bg-gray-100 text-gray-600 rounded-md hover:bg-gray-200 transition-colors"
          >
            Clear
          </button>

          {/* Connection status */}
          <div className="flex items-center gap-2">
            <span
              className={`w-2.5 h-2.5 rounded-full ${
                connected ? 'bg-green-500' : 'bg-red-500'
              }`}
            />
            <span className="text-sm text-gray-500">
              {connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
        </div>
      </div>

      {/* Error message */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
          <p className="text-red-800 text-sm">{error}</p>
        </div>
      )}

      {/* Log viewer */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="bg-gray-900 rounded-lg p-4 h-[600px] overflow-auto font-mono text-sm"
      >
        {filteredLogs.length === 0 ? (
          <div className="text-gray-500 text-center py-8">
            {logs.length === 0
              ? 'Waiting for logs...'
              : 'No logs match the current filter'}
          </div>
        ) : (
          <div className="space-y-0.5">
            {filteredLogs.map((log, i) => (
              <div
                key={i}
                className={`hover:bg-gray-800 px-2 py-0.5 rounded ${getLogColor(log.message)}`}
              >
                {log.message}
              </div>
            ))}
          </div>
        )}
        <div ref={logsEndRef} />
      </div>

      {/* Stats */}
      <div className="mt-4 text-sm text-gray-500 flex items-center justify-between">
        <span>
          Showing {filteredLogs.length} of {logs.length} logs
        </span>
        {!autoScroll && (
          <button
            onClick={() => setAutoScroll(true)}
            className="text-blue-600 hover:text-blue-700"
          >
            Resume auto-scroll
          </button>
        )}
      </div>
    </div>
  );
}
