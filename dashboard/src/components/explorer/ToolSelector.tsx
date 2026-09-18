'use client';

import { useMemo, useState } from 'react';
import type { McpTool } from '@/lib/api';

interface ToolSelectorProps {
  tools: McpTool[];
  selected: string | null;
  onSelect: (toolName: string | null) => void;
  mcpFilter?: 'all' | 'mcp' | 'dashboard';
}

// Quick-scope chips that mirror common pod/project-scoped tool searches.
// Inspired by Anthropic's tool-search-tool discovery pattern:
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
const SCOPE_CHIPS: Array<{ id: string; label: string; match: (t: McpTool) => boolean }> = [
  { id: 'pods', label: 'Pods', match: (t) => /\bpod\b/i.test(t.name) || /\bpod\b/i.test(t.description || '') },
  { id: 'projects', label: 'Projects', match: (t) => /project/i.test(t.name) || /project/i.test(t.description || '') },
  { id: 'search', label: 'Search', match: (t) => t.category === 'search' || /search/i.test(t.name) },
  { id: 'graph', label: 'Graph', match: (t) => t.category === 'graph' || /graph|callers|callees|impact/i.test(t.name) },
];

// Category display names and order
const categoryInfo: Record<string, { label: string; order: number }> = {
  search: { label: 'Search Tools', order: 1 },
  retrieve: { label: 'Retrieve Tools', order: 2 },
  graph: { label: 'Graph Tools', order: 3 },
  index: { label: 'Index Management', order: 4 },
  generation: { label: 'Code Generation', order: 5 },
  migration: { label: 'Migration Tools', order: 6 },
  management: { label: 'Management Tools', order: 7 },
  analytics: { label: 'Analytics Tools', order: 8 },
  doc: { label: 'Documentation Agent', order: 9 },
  code: { label: 'Code Analysis Agent', order: 10 },
  gen: { label: 'Code Generation Agent', order: 11 },
  proj: { label: 'Project Management Agent', order: 12 },
  explorer: { label: 'Orchestration Agent', order: 13 },
  other: { label: 'Other Tools', order: 99 },
};

export function ToolSelector({ tools, selected, onSelect, mcpFilter = 'all' }: ToolSelectorProps) {
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<string | null>(null);

  // Filter tools by MCP exposure, scope chip, then free-text search.
  const filteredTools = useMemo(() => {
    let result = tools;
    if (mcpFilter === 'mcp') result = result.filter(t => t.mcpExposed);
    else if (mcpFilter === 'dashboard') result = result.filter(t => !t.mcpExposed);

    if (scope) {
      const chip = SCOPE_CHIPS.find(c => c.id === scope);
      if (chip) result = result.filter(chip.match);
    }

    const q = search.trim().toLowerCase();
    if (q) {
      result = result.filter(t =>
        t.name.toLowerCase().includes(q) ||
        (t.description || '').toLowerCase().includes(q) ||
        (t.category || '').toLowerCase().includes(q)
      );
    }
    return result;
  }, [tools, mcpFilter, scope, search]);

  // Group tools by category
  const groupedTools = useMemo(() => {
    const groups: Record<string, McpTool[]> = {};

    for (const tool of filteredTools) {
      const category = tool.category || 'other';
      if (!groups[category]) {
        groups[category] = [];
      }
      groups[category].push(tool);
    }

    // Sort categories by order
    const sortedCategories = Object.keys(groups).sort((a, b) => {
      const orderA = categoryInfo[a]?.order ?? 50;
      const orderB = categoryInfo[b]?.order ?? 50;
      return orderA - orderB;
    });

    return sortedCategories.map((category) => ({
      category,
      label: categoryInfo[category]?.label || category,
      tools: groups[category].sort((a, b) => a.name.localeCompare(b.name)),
      mcpCount: groups[category].filter(t => t.mcpExposed).length,
    }));
  }, [filteredTools]);

  return (
    <div>
      <label htmlFor="tool-select" className="block text-sm font-medium text-gray-700 mb-2">
        Select Tool
      </label>

      {/* Search-by-description (Anthropic tool-search-tool style) */}
      <div className="mb-2">
        <input
          id="tool-search"
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tools by name or description..."
          className="w-full rounded-md border border-gray-300 bg-white py-2 px-3 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <div className="mt-2 flex flex-wrap gap-1">
          <button
            type="button"
            onClick={() => setScope(null)}
            className={`px-2 py-0.5 rounded-full text-xs border ${
              scope === null
                ? 'bg-blue-50 text-blue-700 border-blue-200'
                : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
            }`}
          >
            All
          </button>
          {SCOPE_CHIPS.map((chip) => (
            <button
              key={chip.id}
              type="button"
              onClick={() => setScope(scope === chip.id ? null : chip.id)}
              className={`px-2 py-0.5 rounded-full text-xs border ${
                scope === chip.id
                  ? 'bg-blue-50 text-blue-700 border-blue-200'
                  : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
              }`}
            >
              {chip.label}
            </button>
          ))}
        </div>
      </div>

      <select
        id="tool-select"
        value={selected || ''}
        onChange={(e) => onSelect(e.target.value || null)}
        className="w-full rounded-md border border-gray-300 bg-white py-2 pl-3 pr-10 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      >
        <option value="">Choose a tool...</option>
        {groupedTools.map(({ category, label, tools: categoryTools, mcpCount }) => {
          const dashboardCount = categoryTools.length - mcpCount;
          const suffix = mcpCount === categoryTools.length
            ? 'all MCP'
            : dashboardCount === categoryTools.length
              ? 'dashboard only'
              : `${mcpCount} MCP, ${dashboardCount} dashboard`;
          return (
            <optgroup key={category} label={`${label} (${categoryTools.length}) \u2014 ${suffix}`}>
              {categoryTools.map((tool) => (
                <option key={tool.name} value={tool.name}>
                  {tool.mcpExposed ? '\u2713 ' : '\u25cb '}{tool.name}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>

      {/* Tool count summary */}
      <div className="mt-2 flex items-center gap-3 text-xs text-gray-500">
        <span>{filteredTools.length} tools across {groupedTools.length} categories</span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
          MCP = available to Claude
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full bg-gray-400" />
          Dashboard only
        </span>
      </div>
    </div>
  );
}
