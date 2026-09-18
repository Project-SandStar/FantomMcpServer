'use client';

import { useState, useCallback, useMemo } from 'react';

interface ResultViewerProps {
  result: unknown;
  error: string | null;
  loading?: boolean;
}

// Source badge configuration
interface SourceBadge {
  label: string;
  color: string;
  bgColor: string;
}

const SOURCE_BADGES: Record<string, SourceBadge> = {
  'local-docs': { label: 'Local Docs', color: 'text-orange-700', bgColor: 'bg-orange-100' },
  'code': { label: 'Code', color: 'text-purple-700', bgColor: 'bg-purple-100' },
};

/**
 * Get source badge for a result item
 */
function getSourceBadge(item: Record<string, unknown>): SourceBadge | null {
  // Check for explicit source field
  if (item.source && typeof item.source === 'string') {
    return SOURCE_BADGES[item.source] || {
      label: item.source,
      color: 'text-gray-700',
      bgColor: 'bg-gray-100'
    };
  }

  // Infer from URL or other fields - only check for local docs
  if (item.url && typeof item.url === 'string') {
    const url = item.url as string;
    if (url.startsWith('file://') || url.includes('/doc/')) {
      return SOURCE_BADGES['local-docs'];
    }
  }

  // Check for file paths (code results)
  if (item.filePath || item.path) {
    return SOURCE_BADGES['code'];
  }

  // Check for type indicators
  if (item.type === 'function' || item.type === 'method' || item.type === 'class') {
    if (item.filePath) {
      return SOURCE_BADGES['code'];
    }
  }

  return null;
}

/**
 * Simple JSON syntax highlighter
 */
function highlightJson(json: string): React.ReactNode {
  // Split into tokens and colorize
  const parts: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  const regex = /("(?:[^"\\]|\\.)*")\s*:|("(?:[^"\\]|\\.)*")|(\b(?:true|false|null)\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(json)) !== null) {
    // Add text before match
    if (match.index > lastIndex) {
      parts.push(
        <span key={key++} className="text-gray-400">
          {json.slice(lastIndex, match.index)}
        </span>
      );
    }

    if (match[1]) {
      // Property key
      parts.push(
        <span key={key++} className="text-blue-400">
          {match[1]}
        </span>
      );
      parts.push(
        <span key={key++} className="text-gray-400">
          :
        </span>
      );
    } else if (match[2]) {
      // String value
      parts.push(
        <span key={key++} className="text-green-400">
          {match[2]}
        </span>
      );
    } else if (match[3]) {
      // Boolean or null
      parts.push(
        <span key={key++} className="text-purple-400">
          {match[3]}
        </span>
      );
    } else if (match[4]) {
      // Number
      parts.push(
        <span key={key++} className="text-orange-400">
          {match[4]}
        </span>
      );
    }

    lastIndex = regex.lastIndex;
  }

  // Add remaining text
  if (lastIndex < json.length) {
    parts.push(
      <span key={key++} className="text-gray-400">
        {json.slice(lastIndex)}
      </span>
    );
  }

  return parts;
}

/**
 * Render a single result item with source badge
 */
function ResultItemCard({ item, index }: { item: Record<string, unknown>; index: number }) {
  const badge = getSourceBadge(item);
  const name = (item.name || item.qualifiedName || item.title || `Result ${index + 1}`) as string;
  const description = (item.description || item.doc || '') as string;
  const type = (item.type || item.kind || '') as string;
  const pod = (item.pod || item.module || '') as string;

  return (
    <div className="border border-gray-700 rounded-lg p-3 mb-2 bg-gray-800/50">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-blue-400 font-medium truncate">{name}</span>
            {type && (
              <span className="text-xs text-gray-500 bg-gray-700 px-1.5 py-0.5 rounded">
                {type}
              </span>
            )}
            {badge && (
              <span className={`text-xs px-1.5 py-0.5 rounded ${badge.bgColor} ${badge.color}`}>
                {badge.label}
              </span>
            )}
          </div>
          {pod && (
            <div className="text-xs text-gray-500 mt-0.5">{pod}</div>
          )}
          {description && (
            <p className="text-sm text-gray-400 mt-1 line-clamp-2">{description}</p>
          )}
        </div>
      </div>
    </div>
  );
}

export function ResultViewer({ result, error, loading }: ResultViewerProps) {
  const [copied, setCopied] = useState(false);
  const [viewMode, setViewMode] = useState<'json' | 'cards'>('json');

  const handleCopy = useCallback(() => {
    if (!result) return;

    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [result]);

  // Check if result has a results array that can be displayed as cards
  const resultItems = useMemo(() => {
    if (!result || typeof result !== 'object') return null;
    const obj = result as Record<string, unknown>;

    // Check for common result array patterns
    if (Array.isArray(obj.results)) {
      return obj.results as Record<string, unknown>[];
    }
    if (Array.isArray(obj.items)) {
      return obj.items as Record<string, unknown>[];
    }
    if (Array.isArray(result)) {
      return result as Record<string, unknown>[];
    }
    return null;
  }, [result]);

  const hasCardView = resultItems && resultItems.length > 0;

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 bg-gray-900 rounded-lg">
        <div className="flex items-center gap-2 text-gray-400">
          <svg
            className="animate-spin h-5 w-5"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
          <span>Executing tool...</span>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="bg-red-900/20 border border-red-500/50 rounded-lg p-4">
        <div className="flex items-center gap-2 text-red-400 font-medium mb-2">
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          Error
        </div>
        <pre className="text-red-300 text-sm whitespace-pre-wrap font-mono">{error}</pre>
      </div>
    );
  }

  // Empty state
  if (result === null || result === undefined) {
    return (
      <div className="flex items-center justify-center h-64 bg-gray-900 rounded-lg">
        <div className="text-gray-500 text-sm">
          Select a tool and execute it to see results here.
        </div>
      </div>
    );
  }

  // Format result
  const formattedResult =
    typeof result === 'string' ? result : JSON.stringify(result, null, 2);

  // Get result count for display
  const resultCount = resultItems?.length ?? 0;

  return (
    <div className="relative">
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-2">
        {/* View mode toggle */}
        {hasCardView && (
          <div className="flex items-center gap-1 bg-gray-800 rounded-md p-0.5">
            <button
              onClick={() => setViewMode('cards')}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                viewMode === 'cards'
                  ? 'bg-gray-600 text-white'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              Cards ({resultCount})
            </button>
            <button
              onClick={() => setViewMode('json')}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                viewMode === 'json'
                  ? 'bg-gray-600 text-white'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              JSON
            </button>
          </div>
        )}
        {!hasCardView && <div />}

        {/* Copy button */}
        <button
          onClick={handleCopy}
          className="px-3 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>

      {/* Card view */}
      {hasCardView && viewMode === 'cards' && (
        <div className="bg-gray-900 rounded-lg p-4 overflow-auto max-h-[600px]">
          {resultItems.map((item, index) => (
            <ResultItemCard key={index} item={item} index={index} />
          ))}
        </div>
      )}

      {/* JSON view */}
      {(!hasCardView || viewMode === 'json') && (
        <div className="bg-gray-900 rounded-lg p-4 overflow-auto max-h-[600px]">
          <pre className="text-sm font-mono leading-relaxed">
            {highlightJson(formattedResult)}
          </pre>
        </div>
      )}
    </div>
  );
}
