'use client';

import { useState, useMemo } from 'react';

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: {
    properties?: Record<string, unknown>;
  };
}

interface SearchToolConfig {
  name: string;
  title: string;
  icon: React.ReactNode;
  color: string;
  bgColor: string;
  borderColor: string;
  keyParams: string[];
  examplePrompt: string;
  defaultParams?: Record<string, unknown>;
}

// Configuration for known search tools - matched by tool name pattern
const SEARCH_TOOL_CONFIGS: Record<string, Omit<SearchToolConfig, 'name'>> = {
  searchVersionedApi: {
    title: 'Versioned API Search',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
      </svg>
    ),
    color: 'text-indigo-600',
    bgColor: 'bg-indigo-50',
    borderColor: 'border-indigo-200',
    keyParams: ['query', 'mode', 'version', 'instanceId'],
    examplePrompt: 'Use searchVersionedApi to find "readAll" API compatible with SkySpark 3.1.12',
    defaultParams: { mode: 'all', limit: 10 },
  },
  searchLocalDocs: {
    title: 'Search Local Docs',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    ),
    color: 'text-blue-600',
    bgColor: 'bg-blue-50',
    borderColor: 'border-blue-200',
    keyParams: ['query', 'instanceType', 'pod', 'limit'],
    examplePrompt: 'Use searchLocalDocs to find documentation about "readAll" in SkySpark',
  },
  searchFantomCode: {
    title: 'Search Fantom Code',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
      </svg>
    ),
    color: 'text-purple-600',
    bgColor: 'bg-purple-50',
    borderColor: 'border-purple-200',
    keyParams: ['query', 'type', 'pod', 'limit'],
    examplePrompt: 'Use searchFantomCode to find all classes that implement "Point"',
  },
  searchAll: {
    title: 'Search All',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
    ),
    color: 'text-green-600',
    bgColor: 'bg-green-50',
    borderColor: 'border-green-200',
    keyParams: ['query', 'sources', 'limit'],
    examplePrompt: 'Use searchAll to find "point" across local docs and code',
    defaultParams: { sources: ['local-docs', 'code'] },
  },
};

// Default config for unknown search tools
const DEFAULT_SEARCH_CONFIG: Omit<SearchToolConfig, 'name' | 'title'> = {
  icon: (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
    </svg>
  ),
  color: 'text-gray-600',
  bgColor: 'bg-gray-50',
  borderColor: 'border-gray-200',
  keyParams: ['query', 'limit'],
  examplePrompt: 'Search for relevant results',
};

interface SearchToolsSectionProps {
  tools: McpTool[];
  onSelectTool: (toolName: string, params?: Record<string, unknown>) => void;
  selectedTool: string | null;
}

export function SearchToolsSection({ tools, onSelectTool, selectedTool }: SearchToolsSectionProps) {
  const [copiedPrompt, setCopiedPrompt] = useState<string | null>(null);

  // Find search tools from the available tools list
  const searchTools = useMemo(() => {
    // Look for tools with "search" in the name (case insensitive)
    const found = tools.filter(t =>
      t.name.toLowerCase().includes('search')
    );

    // Map to our display format with configs
    return found.map(tool => {
      const config = SEARCH_TOOL_CONFIGS[tool.name];
      if (config) {
        return {
          name: tool.name,
          description: tool.description || '',
          ...config,
        };
      }
      // Use default config for unknown search tools
      return {
        name: tool.name,
        title: tool.name,
        description: tool.description || '',
        ...DEFAULT_SEARCH_CONFIG,
      };
    });
  }, [tools]);

  const handleCopyPrompt = (prompt: string, toolName: string) => {
    navigator.clipboard.writeText(prompt).then(() => {
      setCopiedPrompt(toolName);
      setTimeout(() => setCopiedPrompt(null), 2000);
    });
  };

  if (searchTools.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
        <h2 className="text-lg font-semibold text-gray-900 mb-2">Search Tools</h2>
        <p className="text-sm text-gray-500">No search tools available. Tools with "search" in their name will appear here.</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Search Tools</h2>
          <p className="text-sm text-gray-500">Primary tools for searching local cached documentation and code</p>
        </div>
        <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded">
          {searchTools.length} tools
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {searchTools.map((tool) => {
          const isSelected = selectedTool === tool.name;

          return (
            <div
              key={tool.name}
              className={`rounded-lg border-2 p-4 transition-all cursor-pointer ${
                isSelected
                  ? `${tool.borderColor} ${tool.bgColor} ring-2 ring-offset-1`
                  : 'border-gray-200 hover:border-gray-300 hover:shadow-sm'
              }`}
              onClick={() => onSelectTool(tool.name, tool.defaultParams)}
            >
              {/* Header */}
              <div className="flex items-start gap-3 mb-3">
                <div className={`p-2 rounded-lg ${tool.bgColor} ${tool.color}`}>
                  {tool.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-gray-900 truncate">{tool.title}</h3>
                  <code className="text-xs text-gray-500">{tool.name}</code>
                </div>
              </div>

              {/* Description */}
              <p className="text-sm text-gray-600 mb-3 line-clamp-3">
                {tool.description}
              </p>

              {/* Key Parameters */}
              <div className="mb-3">
                <span className="text-xs text-gray-500">Key parameters:</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {tool.keyParams.map((param) => (
                    <code
                      key={param}
                      className="text-xs bg-gray-100 text-gray-700 px-1.5 py-0.5 rounded"
                    >
                      {param}
                    </code>
                  ))}
                </div>
              </div>

              {/* Example Prompt */}
              <div className="bg-gray-50 rounded p-2 mb-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-gray-500">Example LLM prompt:</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCopyPrompt(tool.examplePrompt, tool.name);
                    }}
                    className="text-xs text-blue-600 hover:text-blue-800"
                  >
                    {copiedPrompt === tool.name ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <p className="text-xs text-gray-700 italic">"{tool.examplePrompt}"</p>
              </div>

              {/* Action Button */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectTool(tool.name, tool.defaultParams);
                }}
                className={`w-full py-2 px-3 rounded-md text-sm font-medium transition-colors ${
                  isSelected
                    ? `${tool.bgColor} ${tool.color} border ${tool.borderColor}`
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                {isSelected ? 'Selected' : 'Use This Tool'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
