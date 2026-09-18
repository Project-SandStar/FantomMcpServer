# MCP Explorer Implementation Plan for Fantom MCP Server

## Executive Summary

This document outlines a comprehensive implementation plan for an **MCP Explorer** feature set for the Fantom MCP Server, designed to mirror the functionality of the Axon MCP Server's explorer capabilities. The MCP Explorer will provide web-based UIs for:

1. **Server Settings Management** - Configure all server parameters through a web interface
2. **MCP Tool Explorer** - Interactive tool testing and querying interface
3. **Enhanced Dashboard** - Extended monitoring, analytics, and management pages

---

## Feature Parity Analysis

### Current State: Fantom MCP Server

| Feature | Status | Location |
|---------|--------|----------|
| Home/Status Page | Implemented | `dashboard/src/app/page.tsx` |
| Cache Management | Implemented | `dashboard/src/app/cache/page.tsx` |
| Admin API (status, cache, logs, primary-project) | Implemented | `src/admin/routes.ts` |
| Usage Tracking (SQLite) | Implemented | `src/usage/usageTracker.ts` |
| MCP Tools (8 primary + 48 agent tools) | Implemented | `src/index.ts` |
| Workflow Resources | Implemented | `src/workflows/` |
| **MCP Explorer UI** | **Not Implemented** | - |
| **Settings Page** | **Not Implemented** | - |
| **Usage Analytics Page** | **Not Implemented** | - |
| **Logs Page** | **Not Implemented** | - |
| **Docs Browser** | **Not Implemented** | - |

### Target State: Axon MCP Server Features to Replicate

| Feature | Priority | Complexity |
|---------|----------|------------|
| MCP Explorer (Tool Testing) | **Critical** | High |
| Settings/Config Page | **Critical** | Medium |
| Usage Analytics Page | High | Medium |
| Logs Page (SSE Stream) | High | Low |
| Documentation Browser | Medium | Medium |
| Enhanced Navigation | High | Low |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     Dashboard (Next.js)                          │
├──────────┬──────────┬──────────┬──────────┬──────────┬──────────┤
│  Home    │ Explorer │ Settings │  Usage   │   Logs   │   Docs   │
│          │          │          │          │          │          │
│ Status   │ Tool     │ Paths    │ Charts   │ SSE      │ Search   │
│ Stats    │ Selector │ Cache    │ Tables   │ Stream   │ Browse   │
│ Memory   │ Params   │ Search   │ Export   │ Filter   │ Preview  │
└──────────┴────┬─────┴────┬─────┴────┬─────┴────┬─────┴────┬─────┘
                │          │          │          │          │
                ▼          ▼          ▼          ▼          ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Admin API (Express)                       │
├─────────────────────────────────────────────────────────────────┤
│  /admin/status       /admin/settings     /admin/usage           │
│  /admin/cache        /admin/config       /admin/logs (SSE)      │
│  /admin/tools        /admin/pods         /admin/docs            │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                     MCP Protocol Layer                           │
├─────────────────────────────────────────────────────────────────┤
│  POST /mcp (JSON-RPC)    GET /mcp (SSE)    mcp-session-id header │
└─────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: MCP Explorer Page (Critical)

### 1.1 Overview

The MCP Explorer is an interactive tool testing interface that allows users to:
- Select any MCP tool from a categorized dropdown
- Fill in tool parameters with intelligent input types
- Execute tools and view JSON results
- Copy results to clipboard

### 1.2 File Structure

```
dashboard/src/
├── app/
│   └── explorer/
│       └── page.tsx          # Main explorer page
├── components/
│   ├── explorer/
│   │   ├── ToolSelector.tsx     # Categorized tool dropdown
│   │   ├── ParameterForm.tsx    # Dynamic parameter inputs
│   │   ├── ResultViewer.tsx     # JSON output with syntax highlighting
│   │   └── ToolCategories.ts    # Tool category definitions
│   └── ui/
│       ├── JsonHighlighter.tsx  # Syntax highlighting component
│       └── CopyButton.tsx       # Copy to clipboard
└── lib/
    └── mcp.ts                   # MCP session management
```

### 1.3 Tool Categories

Based on current Fantom MCP Server tools:

```typescript
export const toolCategories = {
  search: {
    label: 'Search Tools',
    tools: [
      'searchFantomDocs',
      'searchHaxallDocs',
    ],
  },
  retrieve: {
    label: 'Retrieve Tools',
    tools: [
      'getFantomType',
      'listFantomPods',
    ],
  },
  index: {
    label: 'Index Management',
    tools: [
      'refreshIndex',
    ],
  },
  migration: {
    label: 'Migration Tools',
    tools: [
      'migrateSkySpark4x',
      'commitMigration',
      'rollbackMigration',
    ],
  },
  generation: {
    label: 'Code Generation',
    tools: [
      'generateFantomCode',
    ],
  },
  // Agent tools (48 tools across 6 agents)
  documentation: {
    label: 'Documentation Agent',
    tools: [], // Populated from agent registry
  },
  codeAnalysis: {
    label: 'Code Analysis Agent',
    tools: [],
  },
  codeGeneration: {
    label: 'Code Generation Agent',
    tools: [],
  },
  projectManagement: {
    label: 'Project Management Agent',
    tools: [],
  },
  analytics: {
    label: 'Analytics Agent',
    tools: [],
  },
  orchestration: {
    label: 'Orchestration Agent',
    tools: [],
  },
};
```

### 1.4 MCP Session Management

```typescript
// dashboard/src/lib/mcp.ts
const MCP_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3847';

let sessionId: string | null = null;

export async function ensureMcpSession(): Promise<string> {
  if (sessionId) return sessionId;

  const response = await fetch(`${MCP_BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'fantom-explorer', version: '1.0.0' },
      },
    }),
  });

  sessionId = response.headers.get('mcp-session-id');
  if (!sessionId) throw new Error('Failed to establish MCP session');

  // Parse SSE response for initialization result
  await parseSSEResponse(response);

  return sessionId;
}

export async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const session = await ensureMcpSession();

  const response = await fetch(`${MCP_BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'mcp-session-id': session,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });

  if (response.status === 400) {
    // Session expired, reset and retry
    sessionId = null;
    return callMcpTool(toolName, args);
  }

  return parseSSEResponse(response);
}

function parseSSEResponse(response: Response): Promise<unknown> {
  // Parse Server-Sent Events format response
  return response.text().then((text) => {
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = JSON.parse(line.slice(6));
        if (data.result) return data.result;
        if (data.error) throw new Error(data.error.message);
      }
    }
    throw new Error('No result in response');
  });
}
```

### 1.5 Explorer Page Component

```typescript
// dashboard/src/app/explorer/page.tsx
'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ToolSelector } from '@/components/explorer/ToolSelector';
import { ParameterForm } from '@/components/explorer/ParameterForm';
import { ResultViewer } from '@/components/explorer/ResultViewer';
import { callMcpTool } from '@/lib/mcp';
import { api } from '@/lib/api';

export default function ExplorerPage() {
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
  const [parameters, setParameters] = useState<Record<string, unknown>>({});
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetch available tools from admin API
  const { data: toolsData } = useQuery({
    queryKey: ['tools'],
    queryFn: () => api.getTools(),
  });

  const handleExecute = async () => {
    if (!selectedTool) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const result = await callMcpTool(selectedTool, parameters);
      setResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const selectedToolSchema = toolsData?.tools.find(
    (t) => t.name === selectedTool
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Left Panel: Tool Selection & Parameters */}
      <div className="space-y-6">
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold mb-4">MCP Tool Explorer</h2>

          <ToolSelector
            tools={toolsData?.tools || []}
            selected={selectedTool}
            onSelect={setSelectedTool}
          />

          {selectedToolSchema && (
            <div className="mt-6">
              <p className="text-sm text-gray-600 mb-4">
                {selectedToolSchema.description}
              </p>

              <ParameterForm
                schema={selectedToolSchema.inputSchema}
                values={parameters}
                onChange={setParameters}
              />
            </div>
          )}

          <button
            onClick={handleExecute}
            disabled={!selectedTool || loading}
            className="mt-6 w-full bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Executing...' : 'Execute Tool'}
          </button>
        </div>
      </div>

      {/* Right Panel: Results */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Results</h2>
        <ResultViewer result={result} error={error} />
      </div>
    </div>
  );
}
```

### 1.6 Required Admin API Additions

```typescript
// Add to src/admin/routes.ts

// GET /admin/tools - List all available MCP tools with schemas
router.get('/tools', (_req: Request, res: Response) => {
  try {
    const tools = context.getAvailableTools();
    res.json({ tools });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get tools' });
  }
});

// GET /admin/tools/:name - Get specific tool schema
router.get('/tools/:name', (req: Request, res: Response) => {
  try {
    const tool = context.getToolByName(req.params.name);
    if (!tool) {
      res.status(404).json({ error: 'Tool not found' });
      return;
    }
    res.json(tool);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get tool' });
  }
});
```

---

## Phase 2: Settings/Config Page (Critical)

### 2.1 Overview

Full configuration management interface allowing users to modify:
- Documentation paths and crawl settings
- Cache configuration
- Search settings
- Usage database management

### 2.2 File Structure

```
dashboard/src/app/
└── config/
    └── page.tsx              # Settings page

dashboard/src/components/
└── settings/
    ├── PathSettings.tsx      # Documentation paths
    ├── CacheSettings.tsx     # Cache configuration
    ├── SearchSettings.tsx    # Search parameters
    └── DatabaseManager.tsx   # Usage DB management
```

### 2.3 Settings Page Structure

```typescript
// dashboard/src/app/config/page.tsx
'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface FantomSettings {
  docsPath: string;
  codePath: string;
  cacheDir: string;
  crawlSettings: {
    maxDepth: number;
    delayMs: number;
    timeout: number;
  };
  searchSettings: {
    maxResults: number;
    minScore: number;
  };
  cache: {
    enabled: boolean;
    maxAge: number;
  };
}

export default function ConfigPage() {
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: api.getSettings,
  });

  const { data: dbInfo } = useQuery({
    queryKey: ['usage-database'],
    queryFn: api.getUsageDatabase,
  });

  const updateMutation = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const [formData, setFormData] = useState<FantomSettings | null>(null);

  useEffect(() => {
    if (settings) setFormData(settings);
  }, [settings]);

  const handleSave = () => {
    if (formData) {
      updateMutation.mutate(formData);
    }
  };

  if (isLoading || !formData) {
    return <div>Loading settings...</div>;
  }

  return (
    <div className="space-y-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Server Configuration</h1>
        <p className="text-gray-600">Configure your Fantom MCP Server settings</p>
      </div>

      {/* Path Configuration */}
      <section className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Path Configuration</h2>
        <div className="grid grid-cols-1 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Docs Path
            </label>
            <input
              type="text"
              value={formData.docsPath}
              onChange={(e) => setFormData({ ...formData, docsPath: e.target.value })}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
            />
            <p className="mt-1 text-sm text-gray-500">
              URL or path to Fantom documentation
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Code Path
            </label>
            <input
              type="text"
              value={formData.codePath}
              onChange={(e) => setFormData({ ...formData, codePath: e.target.value })}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
            />
          </div>
        </div>
      </section>

      {/* Crawl Settings */}
      <section className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Crawl Settings</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Max Depth
            </label>
            <input
              type="number"
              value={formData.crawlSettings.maxDepth}
              onChange={(e) => setFormData({
                ...formData,
                crawlSettings: { ...formData.crawlSettings, maxDepth: parseInt(e.target.value) }
              })}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Delay (ms)
            </label>
            <input
              type="number"
              value={formData.crawlSettings.delayMs}
              onChange={(e) => setFormData({
                ...formData,
                crawlSettings: { ...formData.crawlSettings, delayMs: parseInt(e.target.value) }
              })}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Timeout (ms)
            </label>
            <input
              type="number"
              value={formData.crawlSettings.timeout}
              onChange={(e) => setFormData({
                ...formData,
                crawlSettings: { ...formData.crawlSettings, timeout: parseInt(e.target.value) }
              })}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
            />
          </div>
        </div>
      </section>

      {/* Cache Settings */}
      <section className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Cache Settings</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex items-center">
            <input
              type="checkbox"
              checked={formData.cache.enabled}
              onChange={(e) => setFormData({
                ...formData,
                cache: { ...formData.cache, enabled: e.target.checked }
              })}
              className="h-4 w-4 rounded border-gray-300"
            />
            <label className="ml-2 block text-sm text-gray-700">
              Enable Caching
            </label>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Max Age (hours)
            </label>
            <input
              type="number"
              value={formData.cache.maxAge / 3600000}
              onChange={(e) => setFormData({
                ...formData,
                cache: { ...formData.cache, maxAge: parseFloat(e.target.value) * 3600000 }
              })}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
            />
          </div>
        </div>
      </section>

      {/* Search Settings */}
      <section className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Search Settings</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Max Results
            </label>
            <input
              type="number"
              value={formData.searchSettings.maxResults}
              onChange={(e) => setFormData({
                ...formData,
                searchSettings: { ...formData.searchSettings, maxResults: parseInt(e.target.value) }
              })}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Min Score
            </label>
            <input
              type="number"
              step="0.1"
              min="0"
              max="1"
              value={formData.searchSettings.minScore}
              onChange={(e) => setFormData({
                ...formData,
                searchSettings: { ...formData.searchSettings, minScore: parseFloat(e.target.value) }
              })}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
            />
          </div>
        </div>
      </section>

      {/* Usage Database */}
      <section className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Usage Database</h2>
        {dbInfo && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            <div>
              <p className="text-sm text-gray-500">Tool Events</p>
              <p className="text-2xl font-semibold">{dbInfo.toolEvents}</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Search Events</p>
              <p className="text-2xl font-semibold">{dbInfo.searchEvents}</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Database Size</p>
              <p className="text-2xl font-semibold">{formatBytes(dbInfo.size)}</p>
            </div>
          </div>
        )}
        <div className="flex gap-4">
          <button
            onClick={() => api.clearUsageData()}
            className="px-4 py-2 bg-yellow-100 text-yellow-800 rounded-md hover:bg-yellow-200"
          >
            Clear All Data
          </button>
          <button
            onClick={() => api.resetUsageDatabase()}
            className="px-4 py-2 bg-red-100 text-red-800 rounded-md hover:bg-red-200"
          >
            Delete & Reset Database
          </button>
        </div>
      </section>

      {/* Save Button */}
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={updateMutation.isPending}
          className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
        >
          {updateMutation.isPending ? 'Saving...' : 'Save Settings'}
        </button>
      </div>
    </div>
  );
}
```

### 2.4 Required Admin API Additions

```typescript
// Add to src/admin/routes.ts

// GET /admin/settings - Read server settings
router.get('/settings', (_req: Request, res: Response) => {
  try {
    const configPath = path.join(context.configDir, 'fantomMcpServer-config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      res.json(config);
    } else {
      // Return defaults
      res.json(context.getDefaultConfig());
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to read settings' });
  }
});

// PUT /admin/settings - Update server settings
router.put('/settings', async (req: Request, res: Response) => {
  try {
    const configPath = path.join(context.configDir, 'fantomMcpServer-config.json');

    // Create backup
    if (fs.existsSync(configPath)) {
      const backup = configPath + '.backup';
      fs.copyFileSync(configPath, backup);
    }

    fs.writeFileSync(configPath, JSON.stringify(req.body, null, 2));

    // Trigger config reload
    await context.reloadConfig();

    res.json({ success: true, message: 'Settings saved' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// GET /admin/usage/database - Get database info
router.get('/usage/database', async (_req: Request, res: Response) => {
  try {
    const info = await context.getUsageDatabaseInfo();
    res.json(info);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get database info' });
  }
});

// POST /admin/usage/clear - Clear usage data
router.post('/usage/clear', async (_req: Request, res: Response) => {
  try {
    await context.clearUsageData();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to clear usage data' });
  }
});

// POST /admin/usage/reset - Reset usage database
router.post('/usage/reset', async (_req: Request, res: Response) => {
  try {
    await context.resetUsageDatabase();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to reset database' });
  }
});
```

---

## Phase 3: Additional Dashboard Pages (High Priority)

### 3.1 Usage Analytics Page

```
dashboard/src/app/usage/page.tsx
```

Features:
- 7-day activity chart (using Chart.js or Recharts)
- Tool usage breakdown pie chart
- Popular search terms table
- Zero-result searches table
- Export data button

### 3.2 Logs Page

```
dashboard/src/app/logs/page.tsx
```

Features:
- Real-time SSE log stream
- Log level filtering (info, warn, error)
- Search/filter logs
- Auto-scroll with pause option
- Export logs button

```typescript
// dashboard/src/app/logs/page.tsx
'use client';

import { useState, useEffect, useRef } from 'react';

export default function LogsPage() {
  const [logs, setLogs] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const username = localStorage.getItem('admin_user') || 'admin';
    const password = localStorage.getItem('admin_pass') || 'admin';

    const eventSource = new EventSource(
      `${API_BASE}/admin/logs?auth=${btoa(`${username}:${password}`)}`
    );

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      setLogs((prev) => [...prev.slice(-499), data.message]);
    };

    return () => eventSource.close();
  }, []);

  useEffect(() => {
    if (autoScroll) {
      logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

  const filteredLogs = filter
    ? logs.filter((log) => log.toLowerCase().includes(filter.toLowerCase()))
    : logs;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <input
          type="text"
          placeholder="Filter logs..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex-1 rounded-md border-gray-300 shadow-sm"
        />
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          Auto-scroll
        </label>
      </div>

      <div className="bg-gray-900 rounded-lg p-4 h-[600px] overflow-auto font-mono text-sm">
        {filteredLogs.map((log, i) => (
          <div key={i} className="text-gray-300 hover:bg-gray-800">
            {log}
          </div>
        ))}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}
```

### 3.3 Documentation Browser Page

```
dashboard/src/app/docs/page.tsx
```

Features:
- Search input with real-time results
- Pod/type tree navigation
- Documentation preview panel
- Link to full documentation

### 3.4 Enhanced Navigation

Update `dashboard/src/components/nav.tsx`:

```typescript
const navigation = [
  { name: 'Home', href: '/', icon: HomeIcon },
  { name: 'Explorer', href: '/explorer', icon: BeakerIcon },
  { name: 'Settings', href: '/config', icon: CogIcon },
  { name: 'Usage', href: '/usage', icon: ChartBarIcon },
  { name: 'Cache', href: '/cache', icon: ArchiveIcon },
  { name: 'Logs', href: '/logs', icon: DocumentTextIcon },
  { name: 'Docs', href: '/docs', icon: BookOpenIcon },
];
```

---

## Phase 4: API Client Extensions

### 4.1 Updated API Client

```typescript
// dashboard/src/lib/api.ts

export interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface UsageStats {
  totalToolCalls: number;
  totalSearches: number;
  toolBreakdown: Record<string, number>;
  popularSearches: Array<{ query: string; count: number }>;
  zeroResultSearches: Array<{ query: string; count: number }>;
  dailyStats: Array<{ date: string; toolCalls: number; searches: number }>;
}

export interface UsageDatabaseInfo {
  path: string;
  size: number;
  toolEvents: number;
  searchEvents: number;
}

export const api = {
  // Existing
  getStatus: () => apiRequest<ServerStatus>('/status'),
  getCaches: () => apiRequest<CacheInfo[]>('/cache'),
  clearCache: (name?: string) => apiRequest('/cache/clear', { method: 'POST', body: { name } }),

  // New: Tools
  getTools: () => apiRequest<{ tools: Tool[] }>('/tools'),
  getTool: (name: string) => apiRequest<Tool>(`/tools/${name}`),

  // New: Settings
  getSettings: () => apiRequest<FantomSettings>('/settings'),
  updateSettings: (settings: FantomSettings) =>
    apiRequest('/settings', { method: 'PUT', body: settings }),

  // New: Usage
  getUsage: (days = 7) => apiRequest<UsageStats>(`/usage?days=${days}`),
  getUsageDatabase: () => apiRequest<UsageDatabaseInfo>('/usage/database'),
  clearUsageData: () => apiRequest('/usage/clear', { method: 'POST' }),
  resetUsageDatabase: () => apiRequest('/usage/reset', { method: 'POST' }),

  // New: Pods
  getPods: () => apiRequest<{ pods: string[] }>('/pods'),

  // New: Docs
  searchDocs: (query: string) => apiRequest(`/docs/search?q=${encodeURIComponent(query)}`),
  getDoc: (qualifiedName: string) => apiRequest(`/docs/${encodeURIComponent(qualifiedName)}`),
};
```

---

## Phase 5: Backend Extensions

### 5.1 AdminContext Interface Updates

```typescript
// src/admin/types.ts

export interface AdminContext {
  configDir: string;

  // Existing
  getServerStatus: () => ServerStatus;
  getCacheInfo: () => CacheInfo[];
  clearCache: (name?: string) => Promise<void>;
  getLogBuffer: () => string[];
  getPrimaryProject: () => PrimaryProjectContext | null;
  setPrimaryProject: (instance: string, project: string, setBy: string) => Promise<PrimaryProjectContext>;
  getUsageStats?: (days: number) => Promise<UsageStats>;

  // New: Tools
  getAvailableTools: () => Tool[];
  getToolByName: (name: string) => Tool | null;

  // New: Settings
  getDefaultConfig: () => FantomSettings;
  reloadConfig: () => Promise<void>;

  // New: Usage Database
  getUsageDatabaseInfo: () => Promise<UsageDatabaseInfo>;
  clearUsageData: () => Promise<void>;
  resetUsageDatabase: () => Promise<void>;

  // New: Documentation
  searchDocs: (query: string) => SearchResult[];
  getDocByName: (qualifiedName: string) => FantomDocItem | null;
  getPods: () => string[];
}
```

### 5.2 Index.ts Updates

Add tool registry for admin API:

```typescript
// In src/index.ts, after tool definitions

function getAvailableTools(): Tool[] {
  const primaryTools = [
    { name: 'searchFantomDocs', description: '...', inputSchema: {...} },
    { name: 'searchHaxallDocs', description: '...', inputSchema: {...} },
    // ... all tools
  ];

  // Include agent tools
  const agentTools = agents.flatMap((agent) =>
    agent.getTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }))
  );

  return [...primaryTools, ...agentTools];
}
```

---

## Implementation Timeline (Phases)

### Phase 1: MCP Explorer (Core Feature)
- Create `/explorer` page with tool selector
- Implement MCP session management
- Build parameter form with dynamic inputs
- Add JSON result viewer with syntax highlighting
- Add `/admin/tools` endpoint

### Phase 2: Settings Page
- Create `/config` page
- Implement settings form with all sections
- Add `/admin/settings` GET/PUT endpoints
- Add usage database management

### Phase 3: Additional Pages
- Create `/usage` analytics page with charts
- Create `/logs` page with SSE stream
- Create `/docs` browser page
- Update navigation component

### Phase 4: Polish
- Add error handling and loading states
- Add form validation
- Add success/error notifications
- Add responsive design improvements
- Add keyboard shortcuts

---

## Testing Strategy

### Unit Tests
- API client functions
- MCP session management
- Form validation logic

### Integration Tests
- Admin API endpoints
- MCP tool execution
- Settings persistence

### E2E Tests
- Explorer workflow (select tool → fill params → execute → view results)
- Settings workflow (load → modify → save → verify)
- Log streaming

---

## Dependencies to Add

```json
// dashboard/package.json additions
{
  "dependencies": {
    "recharts": "^2.12.0",        // Charts for usage analytics
    "@heroicons/react": "^2.1.0", // Icons for navigation
    "react-json-view-lite": "^1.0.0" // JSON viewer
  }
}
```

---

## Security Considerations

1. **Authentication**: All admin endpoints protected by Basic Auth
2. **CORS**: Configure properly for dashboard origin
3. **Input Validation**: Validate all settings before saving
4. **Rate Limiting**: Consider adding for tool execution
5. **Session Management**: Implement session timeouts for MCP

---

## Summary

This implementation plan provides a complete roadmap for adding MCP Explorer capabilities to the Fantom MCP Server, mirroring the Axon MCP Server's functionality:

1. **MCP Explorer** - Interactive tool testing with 56+ tools
2. **Settings Page** - Full server configuration management
3. **Usage Analytics** - Visual analytics and reporting
4. **Logs Viewer** - Real-time log streaming
5. **Docs Browser** - Documentation search and preview

The architecture leverages existing infrastructure (Admin API, Usage Tracking, HTTP transport) while adding new dashboard pages and API endpoints to enable comprehensive server management through a web interface.
