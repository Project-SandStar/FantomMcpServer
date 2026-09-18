# Design Specification
# Fantom MCP Server Modernization

**Version:** 1.0
**Date:** 2026-01-15
**Based on:** PRD v1.0
**Status:** Draft

---

## 1. System Architecture

### 1.1 Component Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│                           Fantom MCP Server                                 │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │                        Entry Point (index.ts)                        │  │
│  │  ┌─────────────────────────────────────────────────────────────┐   │  │
│  │  │                   FantomMCPServer Class                      │   │  │
│  │  │                                                              │   │  │
│  │  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │   │  │
│  │  │  │ run()       │  │ initialize()│  │ setupHandlers│        │   │  │
│  │  │  │ - stdio     │  │ - cache     │  │ - tools      │        │   │  │
│  │  │  │ - http      │  │ - parsers   │  │ - resources  │        │   │  │
│  │  │  │ - select    │  │ - search    │  │ - for server │        │   │  │
│  │  │  └─────────────┘  └─────────────┘  └─────────────┘        │   │  │
│  │  │                                                              │   │  │
│  │  │  ┌──────────────────────────────────────────────────────┐  │   │  │
│  │  │  │             HTTP Server (Express)                     │  │   │  │
│  │  │  │  GET /health  POST/GET/DELETE /mcp  /admin  /dashboard│  │   │  │
│  │  │  └──────────────────────────────────────────────────────┘  │   │  │
│  │  │                                                              │   │  │
│  │  │  ┌──────────────────────────────────────────────────────┐  │   │  │
│  │  │  │             Session Management                        │  │   │  │
│  │  │  │  httpTransports: Map<string, StreamableHTTPTransport> │  │   │  │
│  │  │  │  httpSessions: Map<string, Server>                    │  │   │  │
│  │  │  └──────────────────────────────────────────────────────┘  │   │  │
│  │  └──────────────────────────────────────────────────────────────┘   │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐         │
│  │   admin/    │ │   cache/    │ │  config/    │ │  parser/    │         │
│  │  routes.ts  │ │  index.ts   │ │  index.ts   │ │  index.ts   │         │
│  │  types.ts   │ │             │ │             │ │  Smart*.ts  │         │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘         │
│                                                                             │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐         │
│  │  search/    │ │ migration/  │ │   tools/    │ │   usage/    │         │
│  │  index.ts   │ │  index.ts   │ │ generate*.ts│ │ tracker.ts  │         │
│  │             │ │             │ │             │ │ store.ts    │         │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘         │
│                                                                             │
│  ┌─────────────┐ ┌─────────────┐                                          │
│  │  utils/     │ │ workflows/  │                                          │
│  │  index.ts   │ │ manager.ts  │                                          │
│  └─────────────┘ └─────────────┘                                          │
│                                                                             │
└────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Request Flow (HTTP Mode)

```
                                    ┌─────────────────┐
                                    │  MCP Client     │
                                    │  (Claude/VS)    │
                                    └────────┬────────┘
                                             │
                           ┌─────────────────┴─────────────────┐
                           │            HTTP Request           │
                           │         (mcp-session-id)          │
                           └─────────────────┬─────────────────┘
                                             │
                                             ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                          Express HTTP Server                                │
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ GET /health  │  │ POST /mcp    │  │ GET /mcp     │  │ DELETE /mcp  │  │
│  │              │  │              │  │              │  │              │  │
│  │ Return JSON  │  │ Route to     │  │ SSE Stream   │  │ Terminate    │  │
│  │ status       │  │ session      │  │ for notifs   │  │ session      │  │
│  └──────────────┘  └──────┬───────┘  └──────────────┘  └──────────────┘  │
│                           │                                                │
│                           ▼                                                │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │                    Session Router                                   │  │
│  │                                                                     │  │
│  │   No session ID + initialize request?                              │  │
│  │   ├─ YES: Create new session                                       │  │
│  │   │       ├─ Generate UUID                                         │  │
│  │   │       ├─ Create new Server instance                            │  │
│  │   │       ├─ Setup handlers on new server                          │  │
│  │   │       ├─ Create StreamableHTTPServerTransport                  │  │
│  │   │       ├─ Connect server to transport                           │  │
│  │   │       └─ Store in httpTransports/httpSessions                  │  │
│  │   │                                                                 │  │
│  │   └─ NO: Lookup existing session                                   │  │
│  │          ├─ Found: Route to session's transport                    │  │
│  │          └─ Not found: Return 400 error                            │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└────────────────────────────────────────────────────────────────────────────┘
```

### 1.3 Initialization Sequence

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Server Startup Sequence                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. FantomMCPServer Constructor                                             │
│     ├─ Load configuration                                                    │
│     ├─ Create MCP Server instance                                           │
│     ├─ Initialize component instances (parser, search, cache, etc.)         │
│     └─ Setup tool/resource handlers on main server                          │
│                                                                              │
│  2. run() Method Called                                                      │
│     │                                                                        │
│     ├─ HTTP Mode (MCP_TRANSPORT=http)                                        │
│     │   ├─ Start Express server immediately (non-blocking)                  │
│     │   │   ├─ /health endpoint available                                    │
│     │   │   ├─ /mcp endpoint ready for connections                          │
│     │   │   ├─ /admin routes mounted                                         │
│     │   │   └─ /dashboard static files served                               │
│     │   │                                                                    │
│     │   └─ Run initialize() in background (Promise)                         │
│     │       └─ Tools wait for initializationComplete before execution       │
│     │                                                                        │
│     └─ Stdio Mode (default)                                                  │
│         ├─ Connect StdioServerTransport immediately                         │
│         │   └─ Server responds to ping/list tools                           │
│         │                                                                    │
│         └─ Run initialize() in background (Promise)                         │
│             └─ Tools wait for initializationComplete                        │
│                                                                              │
│  3. initialize() Method (Background)                                         │
│     ├─ Initialize cache manager                                              │
│     ├─ Try load from cache                                                   │
│     │   ├─ Success: Load cached items into search index                     │
│     │   └─ Miss: Crawl and parse documentation                              │
│     ├─ Build search index                                                    │
│     ├─ Save to cache                                                         │
│     ├─ Initialize usage tracker                                              │
│     ├─ Load workflows                                                        │
│     ├─ Set initializationComplete = true                                    │
│     └─ Log completion time                                                   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Component Design

### 2.1 FantomMCPServer Class (Refactored)

```typescript
// src/index.ts

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { Application, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

class FantomMCPServer {
  // Core MCP server (used for stdio, template for HTTP sessions)
  private server: Server;

  // Existing components (preserved)
  private config: FantomConfig;
  private cacheManager: CacheManager;
  private searchIndex: SearchIndex;
  private smartHaxallParser: SmartDocsParser;

  // HTTP Transport Components (NEW)
  private httpTransports: Map<string, StreamableHTTPServerTransport> = new Map();
  private httpSessions: Map<string, Server> = new Map();
  private expressApp?: Application;

  // Initialization state (NEW)
  private initializationComplete: boolean = false;
  private initializationPromise?: Promise<void>;

  // Primary project context (NEW - shared across all clients)
  private primaryContext: {
    instance: string;
    project: string;
    setBy: 'vscode' | 'dashboard' | 'api' | 'startup';
    timestamp: Date;
  } | null = null;

  // Logging buffer for dashboard (NEW)
  private logBuffer: string[] = [];
  private readonly maxLogBuffer = 500;
  private startTime = Date.now();

  // Usage tracking (NEW)
  private usageTracker: UsageTracker;

  // Workflow manager (NEW)
  private workflowManager: WorkflowManager;

  constructor() {
    this.config = loadConfig();
    this.server = new Server(
      { name: 'mcp-fantom', version: '0.2.0' },
      { capabilities: { tools: {}, resources: {} } }
    );

    // Initialize existing components
    this.cacheManager = new CacheManager(this.config);
    this.searchIndex = new SearchIndex();
    this.smartHaxallParser = new SmartDocsParser('https://haxall.io/doc/');

    // Initialize new components
    this.usageTracker = new UsageTracker();
    this.workflowManager = new WorkflowManager(path.join(process.cwd(), 'workflows'));

    // Setup handlers on main server (for stdio mode)
    this.setupHandlers();
  }

  /**
   * Setup handlers on a specific server instance
   * Used for both main server (stdio) and session servers (HTTP)
   */
  private setupHandlersOnServer(server: Server): void {
    // ListToolsRequestSchema handler
    // CallToolRequestSchema handler
    // ListResourcesRequestSchema handler
    // ReadResourceRequestSchema handler
  }

  private setupHandlers(): void {
    this.setupHandlersOnServer(this.server);
  }

  /**
   * Setup handlers for a new HTTP session
   */
  private setupHandlersForServer(sessionServer: Server): void {
    this.setupHandlersOnServer(sessionServer);
  }

  /**
   * Log message and add to buffer for dashboard
   */
  private log(message: string): void {
    console.error(message);
    this.logBuffer.push(`[${new Date().toISOString()}] ${message}`);
    if (this.logBuffer.length > this.maxLogBuffer) {
      this.logBuffer.shift();
    }
  }

  /**
   * Background initialization
   */
  async initialize(): Promise<void> {
    this.log('Initializing Fantom MCP server...');

    await this.cacheManager.initialize();

    const cachedItems = await this.cacheManager.loadDocsIndex();
    if (cachedItems && cachedItems.length > 0) {
      this.log('Loading documentation from cache...');
      await this.searchIndex.addItems(cachedItems);
    } else {
      this.log('Crawling and parsing Fantom documentation...');
      const parser = new FantomDocsParser(this.config);
      const items = await parser.parseAll();
      await this.searchIndex.addItems(items);
      await this.cacheManager.saveDocsIndex(items);
    }

    await this.usageTracker.initialize();
    this.workflowManager.loadWorkflows();

    this.log('Server initialized successfully');
  }

  /**
   * Start HTTP server for multi-client support
   */
  private async startHttpServer(): Promise<void> {
    const app = express();
    app.use(express.json());
    const port = parseInt(process.env.MCP_PORT || '3847');

    this.expressApp = app;

    // Health check
    app.get('/health', (_req, res) => {
      res.json({
        status: 'ok',
        initialized: this.initializationComplete,
        uptime: process.uptime(),
        functionsIndexed: this.searchIndex.getStats().totalItems,
        activeSessions: this.httpTransports.size
      });
    });

    // MCP endpoint - POST (messages)
    app.post('/mcp', async (req, res) => { /* ... */ });

    // MCP endpoint - GET (SSE notifications)
    app.get('/mcp', async (req, res) => { /* ... */ });

    // MCP endpoint - DELETE (terminate session)
    app.delete('/mcp', async (req, res) => { /* ... */ });

    // Admin API
    const adminRouter = createAdminRouter(this.createAdminContext());
    app.use('/admin', adminRouter);

    // Dashboard static files
    const dashboardPath = path.join(process.cwd(), 'dashboard', 'out');
    if (fs.existsSync(dashboardPath)) {
      app.use('/dashboard', express.static(dashboardPath));
      app.get('/dashboard{/*path}', (_req, res) => {
        res.sendFile(path.join(dashboardPath, 'index.html'));
      });
    }

    return new Promise((resolve) => {
      app.listen(port, () => {
        this.log(`HTTP Server listening on port ${port}`);
        resolve();
      });
    });
  }

  /**
   * Main entry point - handles both transport modes
   */
  async run(): Promise<void> {
    const transportMode = process.env.MCP_TRANSPORT || 'stdio';

    if (transportMode === 'http') {
      // HTTP mode: Start server first, then initialize in background
      await this.startHttpServer();
      this.log('HTTP MCP Server started - initialization starting...');

      this.initializationPromise = this.initialize().then(() => {
        this.initializationComplete = true;
      });

      // Keep process alive
      await new Promise(() => {});
    } else {
      // Stdio mode: Connect transport first, then initialize in background
      const transport = new StdioServerTransport();
      await this.server.connect(transport);

      this.initializationPromise = this.initialize().then(() => {
        this.initializationComplete = true;
      });
    }
  }

  /**
   * Create context for admin router
   */
  private createAdminContext(): AdminContext {
    return {
      getServerStatus: () => this.getServerStatus(),
      getCacheInfo: () => this.getCacheInfo(),
      clearCache: (name) => this.clearCache(name),
      getLogBuffer: () => this.logBuffer,
      getPrimaryProject: () => this.primaryContext,
      setPrimaryProject: async (instance, project, setBy) => {
        this.primaryContext = { instance, project, setBy, timestamp: new Date() };
        savePrimaryProject(instance, project);
        return this.primaryContext;
      },
      configDir: path.join(process.cwd(), 'config'),
      cacheDir: this.config.cacheDir
    };
  }
}
```

### 2.2 Admin Router

```typescript
// src/admin/routes.ts

import { Router, Request, Response, NextFunction } from 'express';
import { AdminContext, AdminCredentials } from './types.js';

function basicAuth(credentials: AdminCredentials) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Basic ')) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Fantom MCP Admin"');
      return res.status(401).json({ error: 'Authentication required' });
    }

    const base64 = authHeader.split(' ')[1];
    const [username, password] = Buffer.from(base64, 'base64').toString().split(':');

    if (username === credentials.username && password === credentials.password) {
      return next();
    }

    return res.status(401).json({ error: 'Invalid credentials' });
  };
}

function loadCredentials(configDir: string): AdminCredentials {
  const configPath = path.join(configDir, 'admin.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.username && config.password) return config;
    } catch (e) { /* fall through */ }
  }
  return {
    username: process.env.ADMIN_USER || 'admin',
    password: process.env.ADMIN_PASS || 'admin'
  };
}

export function createAdminRouter(context: AdminContext): Router {
  const router = Router();
  const credentials = loadCredentials(context.configDir);

  router.use(basicAuth(credentials));

  // Pretty-print JSON
  router.use((_req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = (data) => {
      res.type('application/json');
      return res.send(JSON.stringify(data, null, 2));
    };
    next();
  });

  // API index
  router.get('/', (_req, res) => {
    res.json({
      name: 'Fantom MCP Admin API',
      version: '1.0.0',
      endpoints: { /* ... */ }
    });
  });

  // Status
  router.get('/status', (_req, res) => {
    res.json(context.getServerStatus());
  });

  // Cache
  router.get('/cache', (_req, res) => {
    res.json(context.getCacheInfo());
  });

  router.post('/cache/clear', async (req, res) => {
    const { name } = req.body || {};
    await context.clearCache(name);
    res.json({ success: true, cleared: name || 'all' });
  });

  // Logs (SSE stream)
  router.get('/logs', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const logs = context.getLogBuffer();
    for (const log of logs) {
      res.write(`data: ${JSON.stringify({ message: log })}\n\n`);
    }

    const interval = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 30000);

    req.on('close', () => clearInterval(interval));
  });

  // Primary Project
  router.get('/primary-project', (_req, res) => {
    const project = context.getPrimaryProject();
    if (!project) {
      return res.json({ error: 'No primary project set' });
    }
    res.json(project);
  });

  router.post('/primary-project', async (req, res) => {
    const { instance, project, setBy } = req.body;
    if (!instance || !project) {
      return res.status(400).json({ error: 'Missing instance or project' });
    }
    const result = await context.setPrimaryProject(instance, project, setBy || 'api');
    res.json({ success: true, ...result });
  });

  // Usage (if usage tracker available)
  router.get('/usage', async (req, res) => {
    const days = parseInt(req.query.days as string) || 7;
    const stats = await context.getUsageStats?.(days) || {};
    res.json(stats);
  });

  return router;
}
```

### 2.3 Admin Types

```typescript
// src/admin/types.ts

export interface AdminCredentials {
  username: string;
  password: string;
}

export interface ServerStatus {
  status: 'running' | 'starting' | 'error';
  uptime: number;
  memory: {
    used: number;
    total: number;
    percentage: number;
  };
  initialized: boolean;
  version: string;
  stats: {
    docsIndexed: number;
    activeSessions: number;
  };
}

export interface CacheInfo {
  name: string;
  path: string;
  size: number;
  lastModified: string;
  age: number;
}

export interface PrimaryProjectContext {
  instance: string;
  project: string;
  setBy: 'vscode' | 'dashboard' | 'api' | 'startup';
  timestamp: Date | null;
}

export interface AdminContext {
  getServerStatus: () => ServerStatus;
  getCacheInfo: () => CacheInfo[];
  clearCache: (name?: string) => Promise<void>;
  getLogBuffer: () => string[];
  getPrimaryProject: () => PrimaryProjectContext | null;
  setPrimaryProject: (
    instance: string,
    project: string,
    setBy?: 'vscode' | 'dashboard' | 'api' | 'startup'
  ) => Promise<PrimaryProjectContext>;
  getUsageStats?: (days: number) => Promise<UsageStats>;
  configDir: string;
  cacheDir: string;
}
```

### 2.4 Usage Tracker

```typescript
// src/usage/usageTracker.ts

import Database from 'better-sqlite3';
import { ToolEvent, SearchEvent, UsageStats } from './types.js';

export class UsageTracker {
  private db: Database.Database;
  private dbPath: string;

  constructor(cacheDir: string = '.cache') {
    this.dbPath = path.join(cacheDir, 'usage.db');
  }

  async initialize(): Promise<void> {
    this.db = new Database(this.dbPath);
    this.createTables();
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_name TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        duration_ms INTEGER,
        success INTEGER NOT NULL,
        error_message TEXT,
        session_id TEXT
      );

      CREATE TABLE IF NOT EXISTS search_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query TEXT NOT NULL,
        source TEXT NOT NULL,
        result_count INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        session_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_tool_timestamp ON tool_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_search_timestamp ON search_events(timestamp);
    `);
  }

  trackToolCall(event: ToolEvent): void {
    const stmt = this.db.prepare(`
      INSERT INTO tool_events (tool_name, timestamp, duration_ms, success, error_message, session_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      event.toolName,
      event.timestamp.toISOString(),
      event.durationMs,
      event.success ? 1 : 0,
      event.errorMessage,
      event.sessionId
    );
  }

  trackSearch(event: SearchEvent): void {
    const stmt = this.db.prepare(`
      INSERT INTO search_events (query, source, result_count, timestamp, session_id)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      event.query,
      event.source,
      event.resultCount,
      event.timestamp.toISOString(),
      event.sessionId
    );
  }

  async getStats(days: number = 7): Promise<UsageStats> {
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString();

    const toolCounts = this.db.prepare(`
      SELECT tool_name, COUNT(*) as count
      FROM tool_events
      WHERE timestamp >= ?
      GROUP BY tool_name
      ORDER BY count DESC
    `).all(sinceStr) as { tool_name: string; count: number }[];

    const topSearches = this.db.prepare(`
      SELECT query, COUNT(*) as count
      FROM search_events
      WHERE timestamp >= ?
      GROUP BY query
      ORDER BY count DESC
      LIMIT 20
    `).all(sinceStr) as { query: string; count: number }[];

    const totalTools = this.db.prepare(`
      SELECT COUNT(*) as count FROM tool_events WHERE timestamp >= ?
    `).get(sinceStr) as { count: number };

    const totalSearches = this.db.prepare(`
      SELECT COUNT(*) as count FROM search_events WHERE timestamp >= ?
    `).get(sinceStr) as { count: number };

    return {
      totalToolCalls: totalTools.count,
      totalSearches: totalSearches.count,
      toolUsage: Object.fromEntries(toolCounts.map(t => [t.tool_name, t.count])),
      topSearches,
      periodStart: sinceStr,
      periodEnd: new Date().toISOString()
    };
  }

  async clearData(): Promise<void> {
    this.db.exec('DELETE FROM tool_events; DELETE FROM search_events;');
  }

  async getDatabaseInfo(): Promise<{ path: string; sizeBytes: number; recordCounts: object }> {
    const stats = fs.statSync(this.dbPath);
    const toolCount = (this.db.prepare('SELECT COUNT(*) as c FROM tool_events').get() as any).c;
    const searchCount = (this.db.prepare('SELECT COUNT(*) as c FROM search_events').get() as any).c;

    return {
      path: this.dbPath,
      sizeBytes: stats.size,
      recordCounts: {
        toolEvents: toolCount,
        searchEvents: searchCount
      }
    };
  }
}

// Singleton instance
let instance: UsageTracker | null = null;

export function getUsageTracker(cacheDir?: string): UsageTracker {
  if (!instance) {
    instance = new UsageTracker(cacheDir);
  }
  return instance;
}
```

### 2.5 Usage Types

```typescript
// src/usage/types.ts

export interface ToolEvent {
  toolName: string;
  timestamp: Date;
  durationMs?: number;
  success: boolean;
  errorMessage?: string;
  sessionId?: string;
}

export interface SearchEvent {
  query: string;
  source: 'fantom' | 'haxall';
  resultCount: number;
  timestamp: Date;
  sessionId?: string;
}

export interface UsageStats {
  totalToolCalls: number;
  totalSearches: number;
  toolUsage: Record<string, number>;
  topSearches: Array<{ query: string; count: number }>;
  periodStart: string;
  periodEnd: string;
}
```

### 2.6 Workflow Manager

```typescript
// src/workflows/workflowManager.ts

import * as fs from 'fs';
import * as path from 'path';

export interface WorkflowMetadata {
  id: string;
  title: string;
  description: string;
}

export interface Workflow {
  uri: string;
  metadata: WorkflowMetadata;
  fullContent: string;
}

export class WorkflowManager {
  private workflows: Map<string, Workflow> = new Map();
  private workflowDir: string;

  constructor(workflowDir: string) {
    this.workflowDir = workflowDir;
  }

  loadWorkflows(): void {
    if (!fs.existsSync(this.workflowDir)) return;

    const files = fs.readdirSync(this.workflowDir).filter(f => f.endsWith('.md'));

    for (const file of files) {
      const filePath = path.join(this.workflowDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const id = file.replace('.md', '');

      // Extract title from first heading
      const titleMatch = content.match(/^#\s+(.+)$/m);
      const title = titleMatch ? titleMatch[1] : id;

      // Extract description from first paragraph
      const descMatch = content.match(/^#.*\n\n(.+?)(?:\n\n|$)/s);
      const description = descMatch ? descMatch[1].substring(0, 200) : '';

      this.workflows.set(id, {
        uri: `workflow://${id}`,
        metadata: { id, title, description },
        fullContent: content
      });
    }
  }

  getWorkflowList(): Workflow[] {
    return Array.from(this.workflows.values());
  }

  getWorkflow(id: string): Workflow | undefined {
    return this.workflows.get(id);
  }
}
```

---

## 3. Data Models

### 3.1 Configuration Schema

```typescript
// Enhanced fantom-config.json schema

interface FantomConfigSchema {
  // Existing fields
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

  // New fields
  primaryProject?: {
    instance: string;
    project: string;
  };
  server: {
    port: number;
    transport: 'stdio' | 'http';
  };
  admin: {
    credentialsFile: string;
  };
  usage: {
    enabled: boolean;
    databasePath: string;
  };
}
```

### 3.2 Admin Credentials Schema

```json
// config/admin.json
{
  "username": "admin",
  "password": "your-secure-password"
}
```

### 3.3 Database Schema (SQLite)

```sql
-- .cache/usage.db

CREATE TABLE tool_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_name TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  duration_ms INTEGER,
  success INTEGER NOT NULL,
  error_message TEXT,
  session_id TEXT
);

CREATE TABLE search_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  source TEXT NOT NULL,
  result_count INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  session_id TEXT
);

CREATE TABLE daily_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  tool_calls INTEGER DEFAULT 0,
  searches INTEGER DEFAULT 0,
  sessions INTEGER DEFAULT 0
);

-- Indexes for performance
CREATE INDEX idx_tool_timestamp ON tool_events(timestamp);
CREATE INDEX idx_tool_name ON tool_events(tool_name);
CREATE INDEX idx_search_timestamp ON search_events(timestamp);
CREATE INDEX idx_search_query ON search_events(query);
CREATE INDEX idx_daily_date ON daily_stats(date);
```

---

## 4. API Specifications

### 4.1 Health Endpoint

```
GET /health

Response 200:
{
  "status": "ok",
  "initialized": true,
  "uptime": 3600.5,
  "functionsIndexed": 1523,
  "activeSessions": 2
}
```

### 4.2 MCP Endpoint

```
POST /mcp
Headers:
  Content-Type: application/json
  mcp-session-id: <uuid> (optional for initialize)

Request Body (JSON-RPC):
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "searchFantomDocs",
    "arguments": { "query": "Str" }
  }
}

Response 200:
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": { ... }
}

Response Headers (on initialize):
  mcp-session-id: <new-uuid>
```

```
GET /mcp
Headers:
  mcp-session-id: <uuid>

Response: SSE Stream
  data: { "jsonrpc": "2.0", "method": "...", "params": { ... } }
```

```
DELETE /mcp
Headers:
  mcp-session-id: <uuid>

Response 200:
{
  "status": "terminated"
}
```

### 4.3 Admin API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /admin | API index |
| GET | /admin/status | Server status |
| GET | /admin/cache | List cache files |
| POST | /admin/cache/clear | Clear cache |
| GET | /admin/logs | SSE log stream |
| GET | /admin/usage | Usage statistics |
| GET | /admin/usage/tools | Tool breakdown |
| GET | /admin/usage/searches | Search analytics |
| POST | /admin/usage/clear | Clear usage data |
| GET | /admin/primary-project | Get active project |
| POST | /admin/primary-project | Set active project |
| GET | /admin/config | List config files |
| GET | /admin/config/:name | Read config |
| PUT | /admin/config/:name | Update config |

---

## 5. Dashboard Design

### 5.1 Technology Stack

- **Framework:** Next.js 14 (App Router)
- **Styling:** Tailwind CSS
- **State:** TanStack Query (React Query)
- **Export:** Static HTML (`next export`)

### 5.2 Page Structure

```
dashboard/
├── src/
│   ├── app/
│   │   ├── page.tsx              # Home - server status
│   │   ├── cache/
│   │   │   └── page.tsx          # Cache management
│   │   ├── logs/
│   │   │   └── page.tsx          # Real-time logs
│   │   ├── usage/
│   │   │   └── page.tsx          # Usage analytics
│   │   ├── config/
│   │   │   └── page.tsx          # Configuration
│   │   └── layout.tsx            # Root layout with nav
│   ├── components/
│   │   ├── nav.tsx               # Navigation sidebar
│   │   ├── status-card.tsx       # Status display card
│   │   ├── cache-list.tsx        # Cache file list
│   │   ├── log-viewer.tsx        # Log stream viewer
│   │   └── usage-chart.tsx       # Usage chart
│   └── lib/
│       └── api.ts                # API client
├── package.json
├── next.config.ts
└── tailwind.config.ts
```

### 5.3 API Client

```typescript
// dashboard/src/lib/api.ts

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3847';

async function apiRequest<T>(endpoint: string, options: ApiOptions = {}): Promise<T> {
  const username = localStorage.getItem('admin_user') || 'admin';
  const password = localStorage.getItem('admin_pass') || 'admin';
  const authHeader = 'Basic ' + btoa(`${username}:${password}`);

  const response = await fetch(`${API_BASE}/admin${endpoint}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 401) {
    throw new Error('Authentication required');
  }

  return response.json();
}

export const api = {
  getStatus: () => apiRequest<ServerStatus>('/status'),
  getCaches: () => apiRequest<CacheInfo[]>('/cache'),
  clearCache: (name?: string) => apiRequest('/cache/clear', { method: 'POST', body: { name } }),
  getUsage: (days = 7) => apiRequest<UsageStats>(`/usage?days=${days}`),
  getPrimaryProject: () => apiRequest<PrimaryProject>('/primary-project'),
  setPrimaryProject: (instance: string, project: string) =>
    apiRequest('/primary-project', { method: 'POST', body: { instance, project, setBy: 'dashboard' } }),
};
```

---

## 6. Operational Scripts

### 6.1 Start Server Script

```bash
#!/bin/bash
# scripts/start-server.sh

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="/tmp/fantom-mcp-server.log"
MCP_PORT=${MCP_PORT:-3847}

cd "$SERVER_DIR" || exit 1

# Check if already running
if lsof -ti :$MCP_PORT >/dev/null 2>&1; then
    echo "Server already running on port $MCP_PORT"
    exit 1
fi

# Build if needed
if [ ! -f "$SERVER_DIR/build/index.js" ]; then
    echo "Building server..."
    npm run build || exit 1
fi

# Clear log
> "$LOG_FILE"

# Export environment
export MCP_TRANSPORT=http
export MCP_PORT

# Start server
nohup node --max-old-space-size=4096 "$SERVER_DIR/build/index.js" >> "$LOG_FILE" 2>&1 &
SERVER_PID=$!

# Wait for health check
echo "Starting Fantom MCP Server..."
for i in {1..10}; do
    sleep 1
    if curl -s "http://localhost:$MCP_PORT/health" >/dev/null 2>&1; then
        break
    fi
    echo -n "."
done
echo ""

# Verify
if curl -s "http://localhost:$MCP_PORT/health" >/dev/null 2>&1; then
    echo "Server started!"
    echo ""
    echo "  MCP Endpoint:  http://localhost:$MCP_PORT/mcp"
    echo "  Health Check:  http://localhost:$MCP_PORT/health"
    echo "  Admin API:     http://localhost:$MCP_PORT/admin"
    echo "  Dashboard:     http://localhost:$MCP_PORT/dashboard"
    echo ""
    echo "  PID: $SERVER_PID"
    echo "  Logs: $LOG_FILE"
else
    echo "Failed to start. Check logs: $LOG_FILE"
    tail -20 "$LOG_FILE"
    exit 1
fi
```

### 6.2 Stop Server Script

```bash
#!/bin/bash
# scripts/stop-server.sh

MCP_PORT=${MCP_PORT:-3847}

PID=$(lsof -ti :$MCP_PORT)
if [ -z "$PID" ]; then
    echo "No server running on port $MCP_PORT"
    exit 0
fi

echo "Stopping server (PID: $PID)..."
kill $PID
sleep 2

if lsof -ti :$MCP_PORT >/dev/null 2>&1; then
    echo "Force killing..."
    kill -9 $PID
fi

echo "Server stopped"
```

### 6.3 Status Script

```bash
#!/bin/bash
# scripts/status-server.sh

MCP_PORT=${MCP_PORT:-3847}

if ! lsof -ti :$MCP_PORT >/dev/null 2>&1; then
    echo "Server is NOT running"
    exit 1
fi

echo "Server is running"
curl -s "http://localhost:$MCP_PORT/health" | python3 -m json.tool
```

---

## 7. Package.json Updates

```json
{
  "name": "mcp-fantom",
  "version": "0.2.0",
  "scripts": {
    "build": "tsc && node scripts/copy-workflows.cjs",
    "dev": "tsx src/index.ts",
    "start": "node build/index.js",
    "start:http": "MCP_TRANSPORT=http MCP_PORT=3847 node --max-old-space-size=4096 build/index.js",
    "stop": "bash scripts/stop-server.sh",
    "status": "bash scripts/status-server.sh",
    "test": "jest",
    "test:search": "node test-search.cjs",
    "test:cache": "node test-cache.cjs",
    "clean": "rm -rf build .cache",
    "daemon:start": "MCP_TRANSPORT=http MCP_PORT=3847 pm2 start build/index.js --name fantom-mcp --node-args='--max-old-space-size=4096'",
    "daemon:stop": "pm2 stop fantom-mcp",
    "daemon:restart": "pm2 restart fantom-mcp",
    "daemon:logs": "pm2 logs fantom-mcp",
    "dashboard:dev": "cd dashboard && npm run dev",
    "dashboard:build": "cd dashboard && npm run build",
    "dashboard:install": "cd dashboard && npm install"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.18.0",
    "better-sqlite3": "^11.0.0",
    "cheerio": "^1.0.0",
    "dotenv": "^16.4.5",
    "express": "^5.2.1",
    "flexsearch": "^0.7.43",
    "fs-extra": "^11.2.0",
    "node-fetch": "^3.3.2"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/express": "^5.0.6",
    "@types/fs-extra": "^11.0.4",
    "@types/node": "^20.11.30",
    "tsx": "^4.7.1",
    "typescript": "^5.4.3"
  }
}
```

---

## 8. Testing Strategy

### 8.1 Unit Tests

- UsageTracker methods
- WorkflowManager loading
- Admin router endpoints
- Session management

### 8.2 Integration Tests

- HTTP transport initialization
- Session lifecycle (create, use, terminate)
- Admin API with authentication
- Tool execution through HTTP

### 8.3 Manual Testing Checklist

- [ ] Start server in HTTP mode
- [ ] Health endpoint returns valid JSON
- [ ] Connect MCP client via HTTP
- [ ] Execute search tool
- [ ] Check usage tracked in database
- [ ] Admin API requires auth
- [ ] Dashboard loads and displays status
- [ ] Clear cache via admin API
- [ ] Multiple clients connect simultaneously
- [ ] Session cleanup on disconnect

---

## 9. Migration Path

### 9.1 Backward Compatibility

- Stdio mode remains default
- All existing tools preserved
- Configuration file format unchanged (with additions)
- Existing cache format compatible

### 9.2 Upgrade Steps

1. Update dependencies in package.json
2. Create config/admin.json
3. Create scripts/ directory with operational scripts
4. Build and test in stdio mode first
5. Test HTTP mode
6. Build and deploy dashboard
7. Update documentation

---

*End of Design Specification*
