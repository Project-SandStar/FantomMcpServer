'use client';

import { useState, useCallback, useMemo } from 'react';
import type { McpToolCallDetails } from '@/lib/mcp';

interface McpResponseViewerProps {
  details: McpToolCallDetails | null;
  loading?: boolean;
  error?: string | null;
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

function getSourceBadge(item: Record<string, unknown>): SourceBadge | null {
  if (item.source && typeof item.source === 'string') {
    return SOURCE_BADGES[item.source] || {
      label: item.source,
      color: 'text-gray-700',
      bgColor: 'bg-gray-100'
    };
  }
  if (item.url && typeof item.url === 'string') {
    const url = item.url as string;
    if (url.startsWith('file://') || url.includes('/doc/')) {
      return SOURCE_BADGES['local-docs'];
    }
  }
  if (item.filePath || item.path) {
    return SOURCE_BADGES['code'];
  }
  return null;
}

/**
 * Render a single result item as a card
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
          {pod && <div className="text-xs text-gray-500 mt-0.5">{pod}</div>}
          {description && (
            <p className="text-sm text-gray-400 mt-1 line-clamp-2">{description}</p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * JSON syntax highlighter
 */
function JsonHighlight({ json }: { json: string }) {
  const parts: React.ReactNode[] = [];
  let key = 0;

  const regex = /("(?:[^"\\]|\\.)*")\s*:|("(?:[^"\\]|\\.)*")|(\b(?:true|false|null)\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(json)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<span key={key++} className="text-gray-400">{json.slice(lastIndex, match.index)}</span>);
    }

    if (match[1]) {
      parts.push(<span key={key++} className="text-blue-400">{match[1]}</span>);
      parts.push(<span key={key++} className="text-gray-400">:</span>);
    } else if (match[2]) {
      parts.push(<span key={key++} className="text-green-400">{match[2]}</span>);
    } else if (match[3]) {
      parts.push(<span key={key++} className="text-purple-400">{match[3]}</span>);
    } else if (match[4]) {
      parts.push(<span key={key++} className="text-orange-400">{match[4]}</span>);
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < json.length) {
    parts.push(<span key={key++} className="text-gray-400">{json.slice(lastIndex)}</span>);
  }

  return <>{parts}</>;
}

export function McpResponseViewer({ details, loading, error }: McpResponseViewerProps) {
  const [tab, setTab] = useState<'parsed' | 'raw' | 'llm'>('parsed');
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, []);

  // Extract result items for card view
  const resultItems = useMemo(() => {
    if (!details?.parsedResult || typeof details.parsedResult !== 'object') return null;

    const result = details.parsedResult as Record<string, unknown>;

    // Check for content array (MCP ToolResult format)
    if (result.content && Array.isArray(result.content)) {
      const textContent = result.content.find(
        (c: { type: string; text?: string }) => c.type === 'text'
      );
      if (textContent?.text) {
        try {
          const parsed = JSON.parse(textContent.text);
          if (Array.isArray(parsed.results)) return parsed.results;
          if (Array.isArray(parsed.items)) return parsed.items;
          if (Array.isArray(parsed)) return parsed;
        } catch {
          // Not JSON, return null
        }
      }
    }

    if (Array.isArray(result.results)) return result.results;
    if (Array.isArray(result.items)) return result.items;
    if (Array.isArray(details.parsedResult)) return details.parsedResult;
    return null;
  }, [details]);

  // Format parsed result for display
  const parsedJson = useMemo(() => {
    if (!details?.parsedResult) return '';
    // Try to extract text content and parse it
    const result = details.parsedResult as Record<string, unknown>;
    if (result.content && Array.isArray(result.content)) {
      const textContent = result.content.find(
        (c: { type: string; text?: string }) => c.type === 'text'
      );
      if (textContent?.text) {
        try {
          return JSON.stringify(JSON.parse(textContent.text), null, 2);
        } catch {
          return textContent.text;
        }
      }
    }
    return JSON.stringify(details.parsedResult, null, 2);
  }, [details]);

  const rawJson = useMemo(() => {
    if (!details?.rawResponse) return '';
    return JSON.stringify(details.rawResponse, null, 2);
  }, [details]);

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 bg-gray-900 rounded-lg">
        <div className="flex items-center gap-2 text-gray-400">
          <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <span>Executing tool...</span>
        </div>
      </div>
    );
  }

  // Error state
  if (error || details?.isError) {
    const errorMessage = error || (details?.parsedResult as Record<string, unknown>)?.error || 'Unknown error';
    return (
      <div className="bg-red-900/20 border border-red-500/50 rounded-lg p-4">
        <div className="flex items-center gap-2 text-red-400 font-medium mb-2">
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Error
        </div>
        <pre className="text-red-300 text-sm whitespace-pre-wrap font-mono">{String(errorMessage)}</pre>
      </div>
    );
  }

  // Empty state
  if (!details) {
    return (
      <div className="flex items-center justify-center h-64 bg-gray-900 rounded-lg">
        <div className="text-gray-500 text-sm">
          Select a tool and execute it to see results here.
        </div>
      </div>
    );
  }

  const hasCardView = resultItems && resultItems.length > 0;
  const resultCount = resultItems?.length ?? 0;

  return (
    <div className="relative">
      {/* Toolbar with tabs */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1 bg-gray-800 rounded-md p-0.5">
          <button
            onClick={() => setTab('parsed')}
            className={`px-3 py-1.5 text-xs rounded transition-colors ${
              tab === 'parsed' ? 'bg-gray-600 text-white' : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            Parsed Results {hasCardView && `(${resultCount})`}
          </button>
          <button
            onClick={() => setTab('raw')}
            className={`px-3 py-1.5 text-xs rounded transition-colors ${
              tab === 'raw' ? 'bg-gray-600 text-white' : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            Raw MCP Response
          </button>
          <button
            onClick={() => setTab('llm')}
            className={`px-3 py-1.5 text-xs rounded transition-colors ${
              tab === 'llm' ? 'bg-gray-600 text-white' : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            LLM View
          </button>
        </div>

        {/* Copy button and execution time */}
        <div className="flex items-center gap-3">
          {details.executionTime > 0 && (
            <span className="text-xs text-gray-500">
              {details.executionTime}ms
            </span>
          )}
          <button
            onClick={() => handleCopy(tab === 'raw' ? rawJson : parsedJson)}
            className="px-3 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors"
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>

      {/* Parsed view with optional card view */}
      {tab === 'parsed' && (
        <div className="bg-gray-900 rounded-lg overflow-hidden">
          {hasCardView && resultItems && (
            <div className="p-4 overflow-auto max-h-[500px]">
              {resultItems.map((item: unknown, index: number) => (
                <ResultItemCard key={index} item={item as Record<string, unknown>} index={index} />
              ))}
            </div>
          )}
          {!hasCardView && (
            <div className="p-4 overflow-auto max-h-[500px]">
              <pre className="text-sm font-mono leading-relaxed">
                <JsonHighlight json={parsedJson} />
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Raw MCP response view */}
      {tab === 'raw' && (
        <div className="bg-gray-900 rounded-lg overflow-hidden">
          <div className="px-4 py-2 bg-gray-800 border-b border-gray-700">
            <p className="text-xs text-gray-400">
              Complete JSON-RPC response from MCP server (this is what the LLM protocol layer receives)
            </p>
          </div>
          <div className="p-4 overflow-auto max-h-[500px]">
            <pre className="text-sm font-mono leading-relaxed">
              <JsonHighlight json={rawJson} />
            </pre>
          </div>
        </div>
      )}

      {/* LLM view - explains the MCP response structure */}
      {tab === 'llm' && (
        <div className="bg-gray-900 rounded-lg overflow-hidden">
          <div className="p-4">
            <h4 className="text-sm font-semibold text-gray-300 mb-3">What the LLM Receives</h4>

            <div className="space-y-4">
              {/* Response structure explanation */}
              <div className="bg-gray-800 rounded-lg p-3">
                <h5 className="text-xs font-medium text-blue-400 mb-2">MCP ToolResult Structure</h5>
                <pre className="text-xs font-mono text-gray-300">
{`{
  "content": [
    {
      "type": "text",
      "text": "<JSON string with search results>"
    }
  ],
  "isError": false
}`}
                </pre>
              </div>

              {/* Key insight */}
              <div className="bg-blue-900/30 border border-blue-700/50 rounded-lg p-3">
                <h5 className="text-xs font-medium text-blue-400 mb-1">Key Insight</h5>
                <p className="text-sm text-gray-300">
                  The actual search results are <span className="text-yellow-400">JSON-encoded as a string</span> inside
                  the <code className="text-green-400">text</code> field. The LLM must parse this string to access
                  the data.
                </p>
              </div>

              {/* Result count */}
              {resultCount > 0 && (
                <div className="bg-gray-800 rounded-lg p-3">
                  <h5 className="text-xs font-medium text-green-400 mb-1">Results Summary</h5>
                  <p className="text-sm text-gray-300">
                    This response contains <span className="text-yellow-400 font-semibold">{resultCount}</span> result items
                    that the LLM can process.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
