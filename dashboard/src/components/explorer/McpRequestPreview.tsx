'use client';

import { useMemo, useState } from 'react';

interface McpRequestPreviewProps {
  toolName: string | null;
  parameters: Record<string, unknown>;
}

/**
 * Shows a live preview of the JSON-RPC request that will be sent to the MCP server
 * Updates in real-time as the user fills in parameters
 */
export function McpRequestPreview({ toolName, parameters }: McpRequestPreviewProps) {
  const [copied, setCopied] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  // Build the request object
  const request = useMemo(() => {
    if (!toolName) return null;

    // Filter out empty/undefined parameters
    const cleanParams: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parameters)) {
      if (value !== undefined && value !== '' && value !== null) {
        cleanParams[key] = value;
      }
    }

    return {
      jsonrpc: '2.0',
      id: '<request_id>',
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: cleanParams,
      },
    };
  }, [toolName, parameters]);

  const requestJson = useMemo(() => {
    if (!request) return '';
    return JSON.stringify(request, null, 2);
  }, [request]);

  const handleCopy = () => {
    navigator.clipboard.writeText(requestJson).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  if (!toolName) {
    return (
      <div className="bg-gray-900 rounded-lg p-4 border border-gray-700">
        <div className="text-sm text-gray-500 italic">
          Select a tool to preview the MCP request
        </div>
      </div>
    );
  }

  return (
    <div className="bg-gray-900 rounded-lg border border-gray-700 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-800 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="text-gray-400 hover:text-gray-200 transition-colors"
          >
            <svg
              className={`w-4 h-4 transform transition-transform ${collapsed ? '' : 'rotate-90'}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
          <h3 className="text-sm font-medium text-gray-300">MCP Request Preview</h3>
          <span className="text-xs text-gray-500">(what gets sent to server)</span>
        </div>
        <button
          onClick={handleCopy}
          className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>

      {/* Content */}
      {!collapsed && (
        <div className="p-4 overflow-auto max-h-64">
          <pre className="text-sm font-mono">
            <JsonHighlight json={requestJson} />
          </pre>
        </div>
      )}

      {/* Footer explanation */}
      {!collapsed && (
        <div className="px-4 py-2 bg-gray-800/50 border-t border-gray-700">
          <p className="text-xs text-gray-500">
            This is the JSON-RPC 2.0 request sent via POST to <code className="text-gray-400">/mcp</code>
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Simple JSON syntax highlighter component
 */
function JsonHighlight({ json }: { json: string }) {
  const parts: React.ReactNode[] = [];
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

  return <>{parts}</>;
}
