#!/usr/bin/env node

// ═══════ CRASH FORENSICS — must be first, before any other code ═══════
import * as nodeFs from 'node:fs';
import * as v8 from 'node:v8';
import { crashWrite as logSinkCrashWrite, invalidateLogSinkCache } from './utils/logSink.js';
// Axon MCP server integration (settings section `axon`, proxy tools, indexer boot hook)
import { getAxonSettings } from './axon/axonSettings.js';
import { AXON_TOOL_DEFINITIONS, handleAxonTool, isAxonTool } from './axon/axonTools.js';
import { getAxonMcpClient } from './axon/axonMcpClient.js';
import { maybeAutoIndexAtBoot as maybeAxonAutoIndexAtBoot } from './axon/axonIndexer.js';
import { initAxonGrammar } from './axon/axonTreeSitter.js';
// Local crashLog wrapper preserves the historical "MAIN" tag and adds the
// pid prefix that downstream forensic greps depend on. logSinkCrashWrite()
// already encodes the pid; we pass the message body straight through.
function crashLog(line: string): void {
  logSinkCrashWrite('MAIN', line);
}
function memSnapshot(): string {
  const m = process.memoryUsage();
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)}MB`;
  return `rss=${mb(m.rss)} heap=${mb(m.heapUsed)}/${mb(m.heapTotal)} ext=${mb(m.external)} arr=${mb(m.arrayBuffers)}`;
}
crashLog(`=== FANTOM MCP BOOT === argv=${JSON.stringify(process.argv)} execArgv=${JSON.stringify(process.execArgv)} gcExposed=${typeof (globalThis as any).gc === 'function'} ${memSnapshot()}`);

// Tree-sitter Fantom grammar staleness check — common pitfall during
// active grammar editing: grammar.js gets touched but the compiled
// .wasm doesn't get regenerated, so the parser keeps using stale rules
// and may hang on syntax the new grammar adds. Loudly warn at boot so
// the operator notices before debugging mysterious indexer hangs.
try {
  const cwd = process.cwd();
  const grammarPath = nodeFs.existsSync(`${cwd}/tree-sitter-fantom/grammar.js`)
    ? `${cwd}/tree-sitter-fantom/grammar.js` : null;
  const wasmPath = nodeFs.existsSync(`${cwd}/src/parser/treeSitter/grammars/tree-sitter-fantom.wasm`)
    ? `${cwd}/src/parser/treeSitter/grammars/tree-sitter-fantom.wasm` : null;
  if (grammarPath && wasmPath) {
    const gMtime = nodeFs.statSync(grammarPath).mtimeMs;
    const wMtime = nodeFs.statSync(wasmPath).mtimeMs;
    if (gMtime > wMtime + 60_000) {
      const skewMin = Math.round((gMtime - wMtime) / 60_000);
      crashLog(`GRAMMAR_STALE tree-sitter-fantom/grammar.js is ${skewMin}min newer than tree-sitter-fantom.wasm — wasm may need rebuild`);
      process.stderr.write(
        `[grammar-stale] WARNING: tree-sitter-fantom/grammar.js was modified ${skewMin} min after the compiled tree-sitter-fantom.wasm. ` +
        `Run \`tree-sitter generate && tree-sitter build --wasm\` in tree-sitter-fantom/ and copy the wasm to src/parser/treeSitter/grammars/.\n`,
      );
    }
  }
} catch { /* never block startup on the staleness check */ }
process.on('uncaughtException', (err, origin) => {
  crashLog(`UNCAUGHT_EXCEPTION origin=${origin} ${memSnapshot()}\n  ${err?.stack ?? err}`);
});
process.on('unhandledRejection', (reason: any, promise) => {
  crashLog(`UNHANDLED_REJECTION ${memSnapshot()}\n  reason=${reason?.stack ?? reason}\n  promise=${promise}`);
});

// Capture native stderr so segfaults / abort traps / panics from kuzu,
// web-tree-sitter, lance, etc. survive into the crash log instead of
// vanishing when the process dies.
try {
  const origStderrWrite = process.stderr.write.bind(process.stderr) as (chunk: any, ...args: any[]) => boolean;
  (process.stderr as any).write = (chunk: any, ...args: any[]): boolean => {
    try {
      const text = typeof chunk === 'string' ? chunk : chunk?.toString?.('utf-8') ?? '';
      if (text && text.length > 0) {
        const trimmed = text.length > 4000 ? text.slice(0, 4000) + '…[truncated]' : text;
        logSinkCrashWrite('STDERR', trimmed);
      }
    } catch { /* swallow */ }
    return origStderrWrite(chunk, ...args);
  };
} catch { /* never block startup on instrumentation failure */ }
process.on('beforeExit', (code) => crashLog(`beforeExit code=${code} ${memSnapshot()}`));
process.on('exit', (code) => crashLog(`EXIT code=${code} ${memSnapshot()}`));
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGUSR1', 'SIGUSR2', 'SIGABRT', 'SIGPIPE'] as const) {
  process.on(sig as NodeJS.Signals, () => crashLog(`SIGNAL ${sig} ${memSnapshot()}`));
}
// Periodic memory heartbeat — log every 500ms so the last-tick-before-death
// narrows the suspect window for silent Jetsam kills. Tightened from 2s
// after observed kills happened in the gap between ticks. Also captures
// fd count + a coarse macOS pressure proxy (vm_stat from sysctl).
let lastSysctlAt = 0;
let lastSysctlValue = '';
setInterval(() => {
  let fdCount: number | string = '?';
  try {
    fdCount = nodeFs.readdirSync('/dev/fd').length;
  } catch { /* skip */ }
  let pressure = '';
  try {
    const m = process.memoryUsage();
    pressure = ` ext=${Math.round(m.external / 1024 / 1024)}MB arr=${Math.round(m.arrayBuffers / 1024 / 1024)}MB`;
  } catch { /* skip */ }
  // System memory snapshot via sysctl every ~5s — avoids fork-on-every-tick
  // overhead while still letting us correlate kills with system pressure.
  const now = Date.now();
  if (now - lastSysctlAt > 5000) {
    lastSysctlAt = now;
    try {
      const cp = require('node:child_process');
      const out = cp.execFileSync('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_level'], { timeout: 200, encoding: 'utf-8' });
      lastSysctlValue = String(out).trim();
    } catch { lastSysctlValue = '?'; }
  }
  crashLog(`tick ${memSnapshot()} fds=${fdCount}${pressure} memstatus_level=${lastSysctlValue}`);
}, 500).unref();

// Self-watchdog: when RSS approaches the observed Jetsam ceiling, log
// loudly and exit ourselves with code 137 instead of getting SIGKILLed
// blind. Tunable via FANTOM_RSS_GUARD_MB env var (set to 0 to disable).
//
// Default 4000 MB. The FantomCodeIndexer holds ~110k parsed function/type
// records in memory after boot indexing; with tree-sitter producing
// richer per-record data (typed parameters, modifiers arrays, etc.) the
// post-indexing baseline sits around 2 GB heap — a 2500 MB cap was too
// tight. Real macOS Jetsam pressure typically starts above 4-5 GB on a
// 16 GB machine; a 4 GB guard still catches runaway leaks while letting
// the legitimate baseline breathe.
//
// Resolution order: env var → runtime config (rssGuardMb in
// config/fantomMcpServer-config.json) → 4000 default.
function resolveRssGuardMb(): number {
  const fromEnv = process.env.FANTOM_RSS_GUARD_MB;
  if (fromEnv !== undefined) {
    const n = Number(fromEnv);
    if (Number.isFinite(n)) return n;
  }
  try {
    const cfgPath = require('node:path').join(process.cwd(), 'config', 'fantomMcpServer-config.json');
    if (nodeFs.existsSync(cfgPath)) {
      const cfg = JSON.parse(nodeFs.readFileSync(cfgPath, 'utf-8'));
      if (typeof cfg?.rssGuardMb === 'number' && Number.isFinite(cfg.rssGuardMb)) return cfg.rssGuardMb;
    }
  } catch { /* fallthrough */ }
  return 4000;
}
const RSS_GUARD_MB = resolveRssGuardMb();
if (RSS_GUARD_MB > 0) {
  setInterval(() => {
    const rssMb = process.memoryUsage().rss / 1024 / 1024;
    if (rssMb > RSS_GUARD_MB) {
      crashLog(`RSS_GUARD_TRIPPED rss=${Math.round(rssMb)}MB threshold=${RSS_GUARD_MB}MB`);
      process.exit(137);
    }
  }, 5_000).unref();
}
// ════════════════════════════════════════════════════════════════════════

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { getInstallRoot } from './utils/installRoot.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, getServerPort, atomicWriteConfigFile, readConfigFileWithRecovery } from './config/index.js';
import { CacheManager } from './cache/index.js';
import { SearchIndex } from './search/index.js';
import { createLogger } from './utils/index.js';
import { SkySpark4xMigrator, type MigrationConfig } from './migration/index.js';
import { generateClass, generateMethod, generatePod, validateFantomCode } from './tools/generateFantom.js';
import { createAgentFramework, type AgentFramework, getAgentInfo } from './agents/index.js';
import { createAdminRouter } from './admin/routes.js';
import type { AdminContext, ServerStatus, CacheInfo, PrimaryProjectContext, McpTool, FantomSettings } from './admin/types.js';
import { getBackupManager } from './backup/index.js';
import { getUserStore } from './admin/userStore.js';
import { getUsageTracker } from './usage/usageTracker.js';
import {
  FantomOAuthProvider,
  TokenCleanupJob,
  SUPPORTED_SCOPES,
  renderErrorPage,
  extractBearerToken,
} from './auth/index.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { getPrismaClient } from './db/prisma.js';
import { ladybugQuery, closeLadybugConnection } from './graph/ladybugConnection.js';
import { getFantomDatabase, migrateProjectPaths } from './fantom/database.js';
import {
  getFantomCodeIndexer,
  getFantomFunctionSearchIndex,
  FantomCategory,
  isVersionCompatible
} from './fantom-code/index.js';
import type { FantomProject, FunctionSearchOptions } from './fantom-code/index.js';
import {
  parseInstanceDocs,
  listInstancePods,
  getDocStatus
} from './parser/local/index.js';
import { hybridSearchLocalDocsWithMeta } from './search/docsHybridSearchService.js';
import {
  searchVersionedApi,
  type SearchVersionedApiInput
} from './search/versionedApiSearch.js';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import { join } from 'path';
import * as path from 'path';
import { WorkflowManager } from './workflows/workflowManager.js';
import { getSemanticSearchService, getDocsVectorStore } from './embedding/index.js';
import { getLadybugQueryManager } from './graph/ladybugQueryManager.js';

const logger = createLogger('main');

/**
 * Fantom MCP Server class supporting both stdio and HTTP transport modes
 */
class FantomMCPServer {
  private server: Server;
  private config = loadConfig();
  private cacheManager: CacheManager;
  private searchIndex: SearchIndex;

  // HTTP Transport
  private httpTransports: Map<string, StreamableHTTPServerTransport> = new Map();
  private httpSessions: Map<string, Server> = new Map();
  // Per-session bookkeeping for the admin "live MCP connections" view and the
  // idle sweep. Streamable HTTP has no server-side expiry of its own: a client
  // that vanishes without DELETE /mcp would otherwise hold its transport (and
  // Server instance) until process restart.
  private httpSessionMeta: Map<string, { createdAt: number; lastActivity: number; clientName: string | null; clientVersion: string | null; userId: string | null }> = new Map();
  private mcpSessionSweep: NodeJS.Timeout | null = null;
  private static readonly MCP_SESSION_IDLE_MS = (() => {
    const v = Number(process.env.MCP_SESSION_IDLE_MS);
    return Number.isFinite(v) && v > 0 ? v : 24 * 60 * 60_000; // 24h: generous, only reaps truly abandoned clients
  })();

  private touchMcpSession(sid: string): void {
    const m = this.httpSessionMeta.get(sid);
    if (m) m.lastActivity = Date.now();
  }

  private ensureMcpSessionSweep(): void {
    if (this.mcpSessionSweep) return;
    this.mcpSessionSweep = setInterval(() => {
      const cutoff = Date.now() - FantomMCPServer.MCP_SESSION_IDLE_MS;
      for (const [sid, meta] of this.httpSessionMeta) {
        if (meta.lastActivity > cutoff) continue;
        const transport = this.httpTransports.get(sid);
        this.log(`Reaping idle MCP session ${sid} (idle ${Math.round((Date.now() - meta.lastActivity) / 60_000)}m)`);
        this.httpSessionMeta.delete(sid);
        if (transport) { void transport.close().catch(() => { /* onclose cleans the maps */ }); }
        else { this.httpTransports.delete(sid); this.httpSessions.delete(sid); }
      }
    }, 5 * 60_000);
    this.mcpSessionSweep.unref?.();
  }

  /** Snapshot of live MCP transport sessions for the admin API. */
  private listMcpSessions(): Array<{ sessionId: string; clientName: string | null; clientVersion: string | null; userId: string | null; createdAt: string; lastActivity: string }> {
    const out: Array<{ sessionId: string; clientName: string | null; clientVersion: string | null; userId: string | null; createdAt: string; lastActivity: string }> = [];
    for (const sid of this.httpTransports.keys()) {
      const m = this.httpSessionMeta.get(sid);
      out.push({
        sessionId: sid,
        clientName: m?.clientName ?? null,
        clientVersion: m?.clientVersion ?? null,
        userId: m?.userId ?? null,
        createdAt: new Date(m?.createdAt ?? Date.now()).toISOString(),
        lastActivity: new Date(m?.lastActivity ?? Date.now()).toISOString(),
      });
    }
    return out.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  }

  // Initialization - phased for responsiveness
  private initializationComplete: boolean = false;
  private initializationPromise?: Promise<void>;

  // Phased initialization status
  private initStatus = {
    phase: 'starting' as 'starting' | 'cache' | 'agents' | 'ready' | 'error',
    cacheReady: false,
    agentsReady: false,
    codeIndexReady: false,
    docsIndexReady: false,
    embeddingsReady: false,
    error: null as string | null,
    startTime: Date.now(),
    cacheLoadedAt: null as number | null,
    agentsReadyAt: null as number | null,
    codeIndexReadyAt: null as number | null,
    embeddingsReadyAt: null as number | null,
  };

  // Primary project context
  private primaryContext: {
    instance: string;
    project: string;
    setBy: 'vscode' | 'dashboard' | 'api' | 'startup';
    timestamp: Date;
  } | null = null;

  // Logging
  private logBuffer: string[] = [];
  private readonly maxLogBuffer = 500;
  private startTime = Date.now();

  // MCP Explorer Agent Framework (6 agents)
  private agentFramework: AgentFramework;

  // Workflow Manager for dynamic resource loading
  private workflowManager: WorkflowManager;

  // OAuth 2.1 Support
  private oauthProvider: FantomOAuthProvider | null = null;
  private tokenCleanupJob: TokenCleanupJob | null = null;

  constructor() {
    this.server = new Server(
      {
        name: 'mcp-fantom',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    this.cacheManager = new CacheManager(this.config);
    this.searchIndex = new SearchIndex();

    // Initialize WorkflowManager and load workflows dynamically (before agent framework)
    this.workflowManager = new WorkflowManager(join(process.cwd(), 'workflows'));
    this.workflowManager.loadWorkflows();
    // Watch the workflows/ directory so adding a new .md file makes it
    // available as an MCP resource without restarting the server.
    this.workflowManager.startWatching();
    this.workflowManager.onChange(() => {
      this.log(`Workflows reloaded: ${this.workflowManager.getWorkflowCount()} available`);
      // Notify connected MCP clients that the resource list changed.
      // Best-effort: connectors that don't support the notification ignore it.
      try {
        this.server.sendResourceListChanged();
      } catch (err) {
        this.log(`sendResourceListChanged failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    // Create MCP Explorer Agent Framework with 6 agents
    this.agentFramework = createAgentFramework({
      searchIndex: this.searchIndex,
      cacheManager: this.cacheManager,
      workflowManager: this.workflowManager,
      getPrimaryProject: () => this.primaryContext,
      setPrimaryProject: async (context) => {
        this.primaryContext = context;
      },
      onPrimaryProjectChange: (context) => {
        this.log(`Primary project changed to: ${context.instance}/${context.project}`);
      },
    });

    // Setup handlers on the main server
    this.setupHandlers();
  }

  /**
   * Log a message and add to buffer for dashboard
   */
  private log(message: string): void {
    console.error(message);
    this.logBuffer.push(`[${new Date().toISOString()}] ${message}`);
    if (this.logBuffer.length > this.maxLogBuffer) {
      this.logBuffer.shift();
    }
  }

  // ============================================
  // MCP OAuth Authentication Helpers
  // ============================================

  /**
   * Validate a bearer token for MCP endpoints
   * @returns AuthInfo if valid, null if invalid/missing
   */
  private async validateMcpToken(authHeader: string | undefined): Promise<AuthInfo | null> {
    if (!this.oauthProvider) {
      // OAuth not enabled - allow all requests
      return null;
    }

    const token = extractBearerToken(authHeader);
    if (!token) {
      return null;
    }

    try {
      const authInfo = await this.oauthProvider.verifyAccessToken(token);
      return authInfo;
    } catch (error) {
      this.log(`MCP OAuth validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }

  /**
   * Send OAuth 401 challenge response for MCP endpoints
   */
  private sendMcpOAuthChallenge(res: Response, error?: string, errorDescription?: string): void {
    const port = getServerPort();
    const resourceMetadataUrl = `http://localhost:${port}/.well-known/oauth-protected-resource`;

    let wwwAuth = `Bearer resource_metadata="${resourceMetadataUrl}"`;
    if (error) {
      wwwAuth += `, error="${error}"`;
    }
    if (errorDescription) {
      wwwAuth += `, error_description="${errorDescription}"`;
    }

    res.setHeader('WWW-Authenticate', wwwAuth);
    res.status(401).json({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: errorDescription || 'Authorization required',
      },
      id: null,
    });
  }

  /**
   * Check if OAuth is enabled and required
   */
  private isOAuthRequired(): boolean {
    return process.env.OAUTH_ENABLED === 'true' && this.oauthProvider !== null;
  }

  /**
   * Setup handlers on this server's main instance
   */
  private setupHandlers() {
    this.setupHandlersOnServer(this.server);
  }

  /**
   * Setup handlers for an HTTP session server
   */
  private setupHandlersForServer(sessionServer: Server) {
    this.setupHandlersOnServer(sessionServer);
  }

  /**
   * Setup all MCP handlers on the given server instance
   */
  private setupHandlersOnServer(server: Server) {
    // List available tools
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return this.handleListTools();
    });

    // Handle tool calls
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      // Only wait for critical initialization (cache + agents), not full code indexing
      // This allows tools to respond quickly while background indexing continues
      if (!this.initStatus.agentsReady && this.initializationPromise) {
        // Wait up to 5 seconds for critical init, then proceed anyway
        await Promise.race([
          this.initializationPromise,
          new Promise<void>(resolve => setTimeout(resolve, 5000))
        ]);
      }
      // `extra` carries the client's progressToken (in _meta) and
      // sendNotification — what a tool needs to report progress mid-call.
      return this.handleCallTool(request, extra);
    });

    // List available resources
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      return this.handleListResources();
    });

    // Read resource content
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      return this.handleReadResource(request);
    });
  }

  /**
   * Initialize the server - CRITICAL PHASE ONLY (fast)
   * Heavy operations (code indexing) run in background
   */
  private async initialize(): Promise<void> {
    this.log('Initializing Fantom MCP server (critical phase)...');
    this.initStatus.phase = 'cache';

    try {
      // CRITICAL PHASE 1: Initialize cache (fast)
      await this.cacheManager.initialize();

      // Try to load from cache (fast - just JSON parse)
      const cachedItems = await this.cacheManager.loadDocsIndex();

      if (cachedItems && cachedItems.length > 0) {
        this.log('Loading documentation from cache...');
        await this.searchIndex.addItems(cachedItems);
        this.initStatus.docsIndexReady = true;
      } else {
        this.log('No cached documentation found. Documentation search will be limited.');
      }

      this.initStatus.cacheReady = true;
      this.initStatus.cacheLoadedAt = Date.now();
      const cacheTime = this.initStatus.cacheLoadedAt - this.initStatus.startTime;
      this.log(`Cache loaded in ${cacheTime}ms`);

      const stats = this.searchIndex.getStats();
      this.log(`Index statistics: ${JSON.stringify(stats)}`);

      // CRITICAL PHASE 2: Initialize MCP Explorer Agent Framework
      this.initStatus.phase = 'agents';
      this.log('Initializing MCP Explorer agents...');
      await this.agentFramework.initialize();

      this.initStatus.agentsReady = true;
      this.initStatus.agentsReadyAt = Date.now();
      const agentTime = this.initStatus.agentsReadyAt - this.initStatus.startTime;
      this.log(`Agent framework initialized in ${agentTime}ms: ${this.agentFramework.getAllTools().length} tools available`);

      // Mark critical initialization complete - tools can now respond
      this.initStatus.phase = 'ready';
      this.log('Critical initialization complete - server is responsive');

      // BACKGROUND PHASE: Code indexing runs without blocking
      // This is started separately by startBackgroundInitialization()

    } catch (error) {
      this.initStatus.phase = 'error';
      this.initStatus.error = String(error);
      this.log(`Failed to initialize server: ${error}`);
      throw error;
    }
  }

  /**
   * Start background initialization tasks (non-blocking)
   * Called after critical initialization completes
   */
  private startBackgroundInitialization(): void {
    // Background task 1: Code indexing, followed by embedding generation
    this.log('Starting background code indexing...');
    this.initializeCodeIndex()
      .then(() => {
        this.initStatus.codeIndexReady = true;
        this.initStatus.codeIndexReadyAt = Date.now();
        const totalTime = this.initStatus.codeIndexReadyAt - this.initStatus.startTime;
        this.log(`Background code indexing complete in ${totalTime}ms`);

        // After code indexing completes, generate embeddings
        return this.initializeEmbeddings();
      })
      .then(() => {
        this.initStatus.embeddingsReady = true;
        this.initStatus.embeddingsReadyAt = Date.now();
        const totalTime = this.initStatus.embeddingsReadyAt - this.initStatus.startTime;
        this.log(`Background embedding generation complete in ${totalTime}ms`);
      })
      .catch((err) => {
        this.log(`Background code indexing/embeddings failed: ${err}`);
      });

    // Background task 2: AST caches for pods
    this.initializeAstCachesForPods().catch((err) => {
      this.log(`Background AST cache initialization failed: ${err}`);
    });

    // Background task 3: Doc caches for instances
    this.initializeDocCachesForInstances().catch((err) => {
      this.log(`Background doc cache initialization failed: ${err}`);
    });
  }

  /**
   * Initialize Fantom code index from configured projects
   */
  private async initializeCodeIndex(): Promise<void> {
    try {
      const db = getFantomDatabase();
      await db.initialize();

      // Migrate any project paths still stored with a leading `~/` —
      // pre-fix rows would otherwise scan zero files at index time.
      try {
        const rewritten = await migrateProjectPaths();
        if (rewritten > 0) this.log(`Migrated ${rewritten} project path(s) with leading ~`);
      } catch (err) {
        this.log(`migrateProjectPaths failed (non-fatal): ${err}`);
      }

      // Enable autoIndex for all projects (ensures projects get indexed on startup)
      const enabled = await db.enableAutoIndexForAll();
      if (enabled > 0) {
        this.log(`Enabled autoIndex for ${enabled} project(s)`);
      }

      // Get all projects that should be auto-indexed
      const projects = await db.getAutoIndexProjects();

      if (projects.length === 0) {
        this.log('No Fantom projects configured for indexing');
        return;
      }

      const codeIndexer = getFantomCodeIndexer();
      const searchIndex = getFantomFunctionSearchIndex();

      // (Orphan sweep removed in C4 of the per-project graph migration.
      // With one DB per project, cross-project hash collisions are impossible
      // by construction — see specs/per-project-graph-migration.md.)

      this.log(`Indexing ${projects.length} Fantom project(s)...`);

      // Lazily resolve the multi-language CodeIndexingService — used to
      // hydrate non-Fantom projects' in-memory indexer from LadybugDB so
      // FlexSearch picks them up at boot. Without this, searchFantomCode
      // returns 0 hits for every TS/JS/Python project until the user runs
      // an explicit refreshFantomProject.
      const { getCodeIndexingService } = await import('./fantom-code/index.js');
      const codeIndexingService = getCodeIndexingService(getPrismaClient());

      // Boot invariant: HYDRATE only — never PARSE at boot.
      //
      // Reading CodeNode rows from LadybugDB into the in-memory FantomCodeIndexer
      // is cheap (~100ms, no file I/O). Parsing source files is what spikes the
      // heap (98 ASTs in scope at once for the compiler pod) and gets us killed
      // by macOS Jetsam during the cumulative 242-project sweep. The legacy
      // path called codeIndexer.indexProject for Fantom projects unconditionally,
      // bypassing runIndex's hash-gate, so even unchanged projects re-parsed.
      //
      // Projects that hydrate to 0 rows have never been indexed; queue them and
      // drain serially after the boot loop completes via runIndex (which DOES
      // hash-gate). The deferred drain is best-effort and does not block boot
      // readiness — server is already responsive when we get here.
      const pendingFirstParse: Array<{ id: number; name: string; path: string }> = [];
      let projIdx = 0;
      for (const project of projects) {
        projIdx++;
        const enterRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
        const projLang = (project as any).language || 'fantom';
        crashLog(`BOOT_PROJ_ENTER ${projIdx}/${projects.length} id=${project.id} name=${project.name} lang=${projLang} rss=${enterRss}MB`);
        const enterMs = Date.now();
        try {
          const { isLadybugDegraded } = await import('./graph/ladybugConnection.js');
          if (isLadybugDegraded()) {
            // Circuit breaker tripped — re-entering native Kuzu would SIGSEGV.
            // Skip; searchFantomCode falls back to in-memory state on demand.
            crashLog(`BOOT_PROJ_SKIP id=${project.id} reason=ladybug-degraded`);
            continue;
          }
          crashLog(`BOOT_PROJ_HYDRATE_START id=${project.id} name=${project.name}`);
          let hydratedRows = 0;
          try {
            hydratedRows = await codeIndexingService.hydrateIndexerFromLadybug({
              ...project,
              language: projLang,
              parserType: (project as any).parserType,
            } as any);
            crashLog(`BOOT_PROJ_HYDRATE_DONE id=${project.id} rows=${hydratedRows} ms=${Date.now() - enterMs}`);
          } catch (err) {
            this.log(`    Hydrate failed for ${project.name}: ${err}`);
            crashLog(`BOOT_PROJ_HYDRATE_FAIL id=${project.id} err=${err instanceof Error ? err.message : String(err)}`);
          }
          if (hydratedRows > 0) {
            this.log(`  Hydrated ${project.name} (language=${projLang}) from LadybugDB`);
          } else {
            // Never indexed before — queue for post-boot drain.
            pendingFirstParse.push({ id: project.id, name: project.name, path: project.path });
            crashLog(`BOOT_PROJ_DEFER_PARSE id=${project.id} name=${project.name}`);
          }
        } catch (err) {
          this.log(`    Error hydrating project ${project.name}: ${err}`);
          crashLog(`BOOT_PROJ_FAIL id=${project.id} err=${err instanceof Error ? err.message : String(err)}`);
        }
        const exitRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
        crashLog(`BOOT_PROJ_EXIT ${projIdx}/${projects.length} id=${project.id} ms=${Date.now() - enterMs} rss=${exitRss}MB delta=${exitRss - enterRss}MB`);

        // Eagerly close THIS project's Kuzu DB after boot indexing/hydrate
        // finishes. Without this, the connection stays cached in the LRU
        // (capacity 2) and only gets evicted when the next-next project
        // opens a different DB. Each cached connection holds native mmap +
        // buffer pool — across 60+ projects this accumulates enough OS
        // pressure that macOS Jetsam picks us as the kill victim during
        // a transient native allocation in some later project. Closing
        // now lets Kuzu unmap immediately. Best-effort; never block boot.
        try {
          const { closeProjectGraphDatabase } = await import('./graph/projectGraphConnection.js');
          const closeStart = Date.now();
          await closeProjectGraphDatabase(project.id);
          const closeMs = Date.now() - closeStart;
          if (closeMs > 50 || projIdx % 20 === 0) {
            const rssNow = Math.round(process.memoryUsage().rss / 1024 / 1024);
            crashLog(`BOOT_PROJ_KUZU_CLOSE ${projIdx}/${projects.length} id=${project.id} ms=${closeMs} rss=${rssNow}MB`);
          }
        } catch (err) {
          crashLog(`BOOT_PROJ_KUZU_CLOSE_FAIL id=${project.id} err=${err instanceof Error ? err.message : String(err)}`);
        }

        // Force GC between projects to release parsedFiles ASTs + transient
        // indexProject working state. Requires --expose-gc; without it this
        // is a silent no-op. Without GC, V8's old-space grows monotonically
        // across 242 projects and the cumulative spike crosses macOS Jetsam.
        if (typeof (globalThis as any).gc === 'function') {
          try {
            const beforeGc = process.memoryUsage();
            (globalThis as any).gc();
            const afterGc = process.memoryUsage();
            const reclaimedMb = Math.round((beforeGc.heapUsed - afterGc.heapUsed) / 1024 / 1024);
            const rssAfter = Math.round(afterGc.rss / 1024 / 1024);
            if (reclaimedMb > 5 || projIdx % 20 === 0) {
              crashLog(`BOOT_PROJ_GC ${projIdx}/${projects.length} reclaimed=${reclaimedMb}MB rss=${rssAfter}MB`);
            }
          } catch { /* gc failed; ignore */ }
        }
      }
      crashLog(`BOOT_INDEX_LOOP_DONE projects=${projects.length}`);

      // Build FlexSearch index
      searchIndex.rebuild(codeIndexer);
      this.log(`FlexSearch index built with ${searchIndex.size} functions`);

      // Boot-time sanity check: FlexSearch should be roughly proportional to
      // Prisma's persisted function_count. If it's far smaller (e.g. 0 while
      // Prisma has 100k+ rows) something silently dropped every project at
      // index/hydrate time — log loudly and try a Prisma-driven rehydrate
      // from in-memory indexer state for any project the indexer DOES know
      // about. (Round-9 regression: searchIndexSize=0 globally.)
      try {
        const prisma = getPrismaClient();
        const agg = await prisma.fantomProject.aggregate({ _sum: { functionCount: true } });
        const expected = Number(agg._sum.functionCount ?? 0);
        const actual = searchIndex.size;
        if (expected > 100 && actual < expected / 4) {
          this.log(
            `WARNING: FlexSearch size ${actual} is far below Prisma's ` +
            `${expected} expected functions. Boot loop likely dropped projects ` +
            `silently. Forcing a second rebuild from current indexer state...`,
          );
          searchIndex.rebuild(codeIndexer);
          this.log(`FlexSearch second-rebuild produced ${searchIndex.size} functions`);
          if (searchIndex.size === 0) {
            this.log(
              `ERROR: FlexSearch is still empty after rebuild. The in-memory ` +
              `indexer is empty too. Run /admin/code-projects/:id/reindex on ` +
              `the projects you need, or restart with all .pid files cleared.`,
            );
          }
        }
      } catch (err) {
        this.log(`FlexSearch sanity check failed (non-fatal): ${err}`);
      }

      // Drain deferred first-time parses. Projects whose LadybugDB
      // hydrate returned 0 rows have never been indexed; runIndex parses
      // them now (one at a time, with the same Kuzu-close + GC pattern as
      // the boot hydrate loop) so they appear in search after this method
      // resolves. Server has been responsive since cache+agents readied,
      // so any latency here is invisible to users.
      if (pendingFirstParse.length > 0) {
        this.log(`Deferred first-time parse for ${pendingFirstParse.length} project(s)`);
        crashLog(`BOOT_DRAIN_START count=${pendingFirstParse.length}`);
        const { runIndex } = await import('./fantom-code/runIndex.js');
        let drainIdx = 0;
        for (const p of pendingFirstParse) {
          drainIdx++;
          crashLog(`BOOT_DRAIN_ENTER ${drainIdx}/${pendingFirstParse.length} id=${p.id} name=${p.name}`);
          const t0 = Date.now();
          try {
            const r = await runIndex(db, getPrismaClient(), p.id, { trigger: 'manual' });
            crashLog(`BOOT_DRAIN_DONE id=${p.id} fns=${r.indexResult.functionsIndexed} types=${r.indexResult.typesIndexed} ms=${Date.now() - t0}`);
            this.log(`  First-parse ${p.name}: ${r.indexResult.functionsIndexed} fns, ${r.indexResult.typesIndexed} types`);
          } catch (err) {
            crashLog(`BOOT_DRAIN_FAIL id=${p.id} err=${err instanceof Error ? err.message : String(err)}`);
            this.log(`  First-parse ${p.name} failed: ${err}`);
          }
          try {
            const { closeProjectGraphDatabase } = await import('./graph/projectGraphConnection.js');
            await closeProjectGraphDatabase(p.id);
          } catch { /* best-effort */ }
          if (typeof (globalThis as any).gc === 'function') {
            try { (globalThis as any).gc(); } catch { /* ignore */ }
          }
        }
        crashLog(`BOOT_DRAIN_ALL_DONE count=${pendingFirstParse.length}`);
        // Rebuild FlexSearch so any newly-parsed projects appear in search.
        searchIndex.rebuild(codeIndexer);
        this.log(`FlexSearch rebuilt after deferred drain: ${searchIndex.size} functions`);
      }
    } catch (error) {
      this.log(`Failed to initialize code index: ${error}`);
      // Don't throw - allow server to start without code indexing
    }
  }

  /**
   * Initialize embeddings for all indexed projects
   * Uses SemanticSearchService.buildProjectEmbeddings() to generate vector embeddings
   * Runs in background after code indexing completes
   */
  /**
   * Poll the sidecar registry for an enabled embedding-capable sidecar.
   *
   * In strict mode (codeFromSidecar=true) — wait FOREVER, never resolve
   * false. This prevents the auto-embed pipeline from falling back to
   * Xenova in-process and writing 384d vectors into the 1024d LanceDB
   * table. Logs progress every 30s so operators see it's still waiting.
   *
   * In permissive mode — wait up to timeoutMs, then resolve false so the
   * caller can proceed with whatever provider is available.
   */
  private async waitForSidecarEmbeddingCapability(timeoutMs: number, strict: boolean): Promise<boolean> {
    const { getSidecarForCapability } = await import('./sidecars/registry.js');
    if (getSidecarForCapability('embedding')) return true;

    const deadline = Date.now() + timeoutMs;
    let lastLogAt = Date.now();
    const LOG_EVERY = 30_000;
    while (true) {
      if (getSidecarForCapability('embedding')) return true;
      if (!strict && Date.now() >= deadline) return false;
      const now = Date.now();
      if (now - lastLogAt >= LOG_EVERY) {
        const waitedSec = Math.round((now - (deadline - timeoutMs)) / 1000);
        const tag = strict ? 'strict' : 'permissive';
        crashLog(`AUTO_EMBED gate: still waiting for sidecar (mode=${tag}, waited=${waitedSec}s)`);
        this.log(`Still waiting for embedding sidecar to register (mode=${tag}, waited=${waitedSec}s)`);
        lastLogAt = now;
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }

  private async initializeEmbeddings(): Promise<void> {
    try {
      const prisma = getPrismaClient();
      const semanticSearch = getSemanticSearchService(prisma);
      const codeIndexer = getFantomCodeIndexer();

      // First, ensure all indexed projects have code_nodes entries
      // This creates code_nodes from FantomCodeIndexer data for Fantom projects
      this.log('Syncing indexer data to database for embedding generation...');

      // Get all projects from the database. Only sync Fantom projects via
      // FantomCodeIndexer — non-Fantom projects (TypeScript, etc.) get
      // misindexed by the legacy regex parser (returns ~30 functions for a
      // 4500-function TS codebase) and that bad data overwrites the correct
      // graph just built by the unified CodeIndexingService.
      const allProjects = await prisma.fantomProject.findMany({
        select: { id: true, name: true, functionCount: true, typeCount: true, language: true }
      });

      let projectsSynced = 0;
      for (const project of allProjects) {
        const projLang = (project as any).language || 'fantom';
        if (projLang !== 'fantom') continue;
        // Check if project has code_nodes
        // Ladybug-authoritative existing-node check.
        const cntRows = await ladybugQuery<{ cnt: number }>(
          `MATCH (n:CodeNode {project_id: ${project.id}}) RETURN count(n) AS cnt`
        );
        const existingNodeCount = Number(cntRows[0]?.cnt ?? 0);

        // If Ladybug has no nodes for this project but the indexer has data,
        // sync them directly into Ladybug (no Prisma write path).
        if (existingNodeCount === 0 && (project.functionCount > 0 || project.typeCount > 0)) {
          const indexerFunctions = codeIndexer.getAllFunctions().filter(f => f.projectId === project.id);
          const indexerTypes = codeIndexer.getAllTypes().filter(t => t.projectId === project.id);

          if (indexerFunctions.length > 0 || indexerTypes.length > 0) {
            const { createNodesFromBatch } = await import('./graph/ladybugGraphBuilder.js');
            const nodeInputs = [
              ...indexerFunctions.map(func => ({
                id: func.id,
                name: func.name,
                qualifiedName: func.qualifiedName,
                nodeType: func.type || 'method',
                signature: func.signature || null,
                documentation: func.documentation || null,
                filePath: func.filePath,
                lineStart: func.lineNumber || 0,
                lineEnd: (func.lineNumber || 0) + 10,
                projectId: func.projectId,
                language: 'fantom',
              })),
              ...indexerTypes.map(type => ({
                id: type.id,
                name: type.name,
                qualifiedName: type.qualifiedName,
                nodeType: type.kind || 'class',
                signature: null,
                documentation: type.documentation || null,
                filePath: type.filePath,
                lineStart: type.lineNumber || 0,
                lineEnd: (type.lineNumber || 0) + 50,
                projectId: type.projectId,
                language: 'fantom',
              })),
            ];
            try {
              const result = await createNodesFromBatch(nodeInputs);
              projectsSynced++;
              // After nodes land, build the structural + call edges that the
              // node-only fast path skips. Without this, every Fantom project
              // ends up with N nodes / 0 edges in LadybugDB.
              const { buildEdgesFromIndexerData } = await import('./graph/ladybugGraphBuilder.js');
              const edgeResult = await buildEdgesFromIndexerData(
                project.id,
                indexerTypes as any,
                indexerFunctions as any,
              );
              this.log(`  Synced ${result.created} nodes, ${edgeResult.edgesCreated} edges for ${project.name}`);
              // The node-count snapshot fingerprints by file size; a sync that
              // wrote nodes is a real change and must not wait for one.
              if (result.created > 0) {
                const { invalidateProjectNodeCount } = await import('./graph/projectNodeCounts.js');
                invalidateProjectNodeCount(project.id);
              }
            } catch (syncErr) {
              this.log(`  Warning: Could not sync nodes for ${project.name}: ${syncErr}`);
            }
          }
        }
      }

      if (projectsSynced > 0) {
        this.log(`Synced ${projectsSynced} project(s) to database`);
      }

      // Edge-backfill sweep: projects that already had nodes in LadybugDB
      // skipped the createNodesFromBatch path above and therefore never went
      // through buildEdgesFromIndexerData. For any Fantom project with nodes
      // but zero edges, rebuild edges from the in-memory indexer.
      try {
        const codeIndexer = getFantomCodeIndexer();
        const nodeRows = await ladybugQuery<{ pid: number; nc: number }>(
          `MATCH (n:CodeNode) WHERE n.language = 'fantom'
           RETURN n.project_id AS pid, count(n) AS nc`
        );
        const edgeRows = await ladybugQuery<{ pid: number; ec: number }>(
          `MATCH (n:CodeNode)-[e:CodeEdge]->() WHERE n.language = 'fantom'
           RETURN n.project_id AS pid, count(e) AS ec`
        );
        const edgeByPid = new Map<number, number>();
        for (const r of edgeRows) edgeByPid.set(Number(r.pid), Number(r.ec));
        let backfilled = 0;
        for (const row of nodeRows) {
          const pid = Number(row.pid);
          const nc = Number(row.nc);
          const ec = edgeByPid.get(pid) ?? 0;
          if (nc === 0 || ec > 0) continue;
          const fns = codeIndexer.getAllFunctions().filter(f => f.projectId === pid);
          const types = codeIndexer.getAllTypes().filter(t => t.projectId === pid);
          if (fns.length === 0 && types.length === 0) continue;
          try {
            const { buildEdgesFromIndexerData } = await import('./graph/ladybugGraphBuilder.js');
            const r = await buildEdgesFromIndexerData(pid, types as any, fns as any);
            if (r.edgesCreated > 0) {
              backfilled++;
              this.log(`  Edge-backfilled project ${pid}: ${r.edgesCreated} edges (was 0)`);
            }
          } catch (err) {
            this.log(`  Edge-backfill failed for project ${pid}: ${err}`);
          }
        }
        if (backfilled > 0) {
          this.log(`Edge-backfill complete for ${backfilled} project(s)`);
        }
      } catch (err) {
        this.log(`Edge-backfill sweep failed (non-fatal): ${err}`);
      }

      // Ladybug-authoritative project-node aggregation.
      const pnRows = await ladybugQuery<{ pid: number; cnt: number }>(
        `MATCH (n:CodeNode) RETURN DISTINCT n.project_id AS pid, count(n) AS cnt`
      );
      const projectsWithNodes: Array<{ projectId: number; _count: { id: number } }> =
        pnRows.map(r => ({ projectId: Number(r.pid), _count: { id: Number(r.cnt) } }));

      if (projectsWithNodes.length === 0) {
        this.log('No projects with indexed code - skipping embedding generation');
        return;
      }

      // ─── Phase 8: env-var controls ─────────────────────────────────────
      const AUTO_EMBED_DISABLED = process.env.FANTOM_AUTO_EMBED_DISABLED === '1';
      const SIDECAR_WAIT_MS = Number(process.env.FANTOM_AUTO_EMBED_SIDECAR_WAIT_MS ?? '60000');
      const SKIP_COMPLETE = process.env.FANTOM_AUTO_EMBED_SKIP_COMPLETE !== '0'; // default on
      crashLog(`AUTO_EMBED config: disabled=${AUTO_EMBED_DISABLED} sidecar_wait_ms=${SIDECAR_WAIT_MS} skip_complete=${SKIP_COMPLETE}`);
      if (AUTO_EMBED_DISABLED) {
        this.log('AUTO_EMBED disabled via FANTOM_AUTO_EMBED_DISABLED=1; skipping pipeline');
        return;
      }

      this.log(`Generating embeddings for ${projectsWithNodes.length} project(s)...`);

      const {
        autoPipelineWaitingForSidecar,
        autoPipelineSidecarReady,
        autoPipelineStarting,
        autoPipelineProjectStarting,
        autoPipelineProjectDone,
        autoPipelineProjectSkipped,
        autoPipelineProjectFailed,
        autoPipelineFinished,
      } = await import('./embedding/autoPipelineBus.js');

      // ─── Phase 1.5: dim-safety drop ────────────────────────────────────
      // LanceDB locks the vector column's listSize at table creation. If
      // we keep inserting 1024d qwen3 vectors into a legacy 384d column
      // (originally created for bge-small-en-v1.5), Lance silently
      // truncates them and search-side embeds at 1024d find no matches.
      // Drop the table outright when stored != configured. The same
      // guard exists in /vectors/re-embed/:projectId and runAutoEmbedPipeline,
      // but the boot-time pipeline below has its own loop that doesn't
      // share that body — without this, boot rewrites junk every restart.
      try {
        const { selectEmbeddingProvider } = await import('./embedding/providers/embeddingProvider.js');
        const { getLanceTableStats, dropCodeVectorsTable } = await import('./embedding/lanceConnection.js');
        const { getVectorStore: _gvs, resetVectorStore } = await import('./embedding/vectorStore.js');
        const prov = selectEmbeddingProvider('code');
        await prov.initialize();
        const newDims = prov.getDimensions();
        const stats = await getLanceTableStats();
        const storedDims = stats.code.dimensions ?? null;
        if (storedDims && storedDims !== newDims) {
          if ((stats.code.rows ?? 0) > 0) {
            // NEVER destroy a populated table at boot. 2026-09-14: a restart
            // right after the code model changed (1536d → 2560d) dropped the
            // 209,331-row table here, so search ran on an empty table for the
            // whole rebuild. A populated mismatched table is left alone; the
            // boot pipeline stands down (it must not write mixed dims), model-
            // status reports the mismatch, and the operator runs a full
            // re-embed (shadow-swap, or `live: true` to rebuild in place).
            this.log(`AUTO_EMBED dim mismatch: stored=${storedDims}d (${stats.code.rows} rows), configured=${newDims}d — NOT dropping; run POST /admin/vectors/re-embed/start {projectId:0} to rebuild`);
            crashLog(`AUTO_EMBED_DIM_MISMATCH_KEPT stored=${storedDims} configured=${newDims} rows=${stats.code.rows}`);
            return;
          }
          this.log(`AUTO_EMBED dim safety: stored=${storedDims}d (empty), configured=${newDims}d → recreating code_vectors at the new schema`);
          await dropCodeVectorsTable();
          if (typeof resetVectorStore === 'function') resetVectorStore();
        }
      } catch (err) {
        crashLog(`AUTO_EMBED_DIM_CHECK_FAIL ${err instanceof Error ? err.message : String(err)}`);
      }

      // ─── Phase 2: sidecar-readiness gate ───────────────────────────────
      // Block until at least one enabled sidecar advertises capability
      // 'embedding'. In STRICT mode (codeFromSidecar=true) we wait
      // FOREVER — must not fall back to Xenova because the dimensions
      // would mismatch and corrupt the LanceDB table. In permissive mode
      // we wait up to SIDECAR_WAIT_MS and proceed with in-process.
      const codeFromSidecar = (this.config.semanticSearch as any)?.codeFromSidecar === true;

      // ── "OpenRouter only" has no local sidecar to wait for ─────────────
      //
      // This gate asks the registry for a LOCAL embedding-capable sidecar and,
      // in strict mode, waits FOREVER for one. Under the cloud policy the GPUs
      // are excluded on purpose, so nothing will ever register and the whole
      // pipeline parks at "waiting for embedding sidecar" indefinitely while
      // verified cloud providers sit idle. Skip the gate entirely: the cloud
      // pool is checked where it is used, by a selector that throws with a
      // named reason if it cannot serve.
      const { localEmbedderRequired } = await import('./embedding/providers/embeddingProvider.js');
      const needsLocal = await localEmbedderRequired('code');
      if (!needsLocal) {
        crashLog('AUTO_EMBED gate: skipped — code embedding is on "OpenRouter only" (no local sidecar required)');
        this.log('Code embedding is on "OpenRouter only" — not waiting for a local embedding sidecar.');
        autoPipelineSidecarReady(true);
      } else {
      autoPipelineWaitingForSidecar(projectsWithNodes.length, codeFromSidecar ? Number.POSITIVE_INFINITY : SIDECAR_WAIT_MS);
      const sidecarReady = await this.waitForSidecarEmbeddingCapability(SIDECAR_WAIT_MS, codeFromSidecar);
      autoPipelineSidecarReady(sidecarReady);
      if (sidecarReady) {
        crashLog(`AUTO_EMBED gate: sidecar ready, proceeding (strict=${codeFromSidecar})`);
      } else {
        // Only reachable in permissive mode (strict mode loops forever).
        crashLog(`AUTO_EMBED gate: timeout after ${SIDECAR_WAIT_MS}ms; proceeding with in-process fallback (permissive mode)`);
        this.log(`Warning: no embedding sidecar registered after ${SIDECAR_WAIT_MS}ms — pipeline will fall back to in-process`);
      }
      }

      autoPipelineStarting(projectsWithNodes.length);

      // Per-project memory delta — emits to /tmp/fantom-mcp-crash.log so we
      // can see exactly which project pushes RSS past the cliff.
      function projectMem(label: string, projectId: number, projectName: string): void {
        const m = process.memoryUsage();
        const rss = Math.round(m.rss / 1024 / 1024);
        const heap = Math.round(m.heapUsed / 1024 / 1024);
        const ext = Math.round(m.external / 1024 / 1024);
        logSinkCrashWrite(label, `project=${projectId}/${projectName} rss=${rss}MB heap=${heap}MB ext=${ext}MB`);
      }

      let totalProcessed = 0;
      let totalErrors = 0;
      let totalSkipped = 0;

      // ─── Phase 4 prep: per-project vector counts for skip-complete ─────
      const { getVectorStore } = await import('./embedding/vectorStore.js');
      const vectorStore = getVectorStore(prisma);
      const vectorsByProject = SKIP_COMPLETE ? await vectorStore.countByProject() : new Map<number, number>();

      // ─── Phase 3: strictly serial loop (one project fully completes
      //     before the next starts; no batchSize slicing illusion) ───────
      let bootEmbedIdx = 0;
      for (const projectInfo of projectsWithNodes) {
        bootEmbedIdx += 1;
        const projectId = projectInfo.projectId;
        const nodeCount = projectInfo._count.id;

        const project = await prisma.fantomProject.findUnique({
          where: { id: projectId },
          select: { name: true }
        });
        const projectName = project?.name || `project-${projectId}`;

        // Phase 4: skip projects already 100% embedded
        if (SKIP_COMPLETE) {
          const existing = vectorsByProject.get(projectId) ?? 0;
          if (nodeCount > 0 && existing >= nodeCount) {
            this.log(`  Skipping ${projectName} — already ${existing}/${nodeCount} embedded`);
            autoPipelineProjectSkipped(projectId, projectName);
            totalSkipped++;
            continue;
          }
        }

        // Yield to a heavy job: a full re-embed / forced reindex / Axon index
        // (src/embedding/embedGate.ts) owns the sidecar fleet while it runs.
        // The boot pipeline embedding "missing" vectors into the old live
        // table alongside a shadow rebuild halved the rebuild's throughput and
        // wrote soon-discarded rows (2026-09-14). Stop here; the rebuild (or
        // the watchdog afterwards) covers whatever is left.
        try {
          const { getHeavyJob, isShadowReembedActive } = await import('./embedding/embedGate.js');
          const heavy = getHeavyJob();
          if (heavy || isShadowReembedActive()) {
            const who = heavy ? `${heavy.kind} (${heavy.label})` : 'shadow re-embed';
            this.log(`Boot embedding pipeline yielding to ${who} — ${projectsWithNodes.length - bootEmbedIdx + 1} project(s) left for it / the watchdog`);
            crashLog(`AUTO_EMBED_YIELD to=${who}`);
            break;
          }
        } catch { /* gate unavailable — carry on */ }

        // Resolve which sidecar will serve this project so the dashboard can
        // attribute the work to a device. Cheap call (in-memory registry).
        let assignedSidecar: { name?: string; host?: string; model?: string } | undefined;
        try {
          const { getSidecarForCapability } = await import('./sidecars/registry.js');
          const desiredModel = (this.config.semanticSearch as any)?.codeModel;
          const sc = getSidecarForCapability('embedding', desiredModel) ?? getSidecarForCapability('embedding');
          if (sc) {
            const cap = sc.capabilities.embedding;
            assignedSidecar = {
              name: sc.name,
              host: `${sc.host}:${sc.port}`,
              model: cap?.loaded ?? cap?.models?.[0] ?? desiredModel,
            };
          }
        } catch { /* status-only; safe to skip */ }

        this.log(`  Building embeddings for ${projectName} (${nodeCount} nodes)${assignedSidecar ? ` via ${assignedSidecar.name} ${assignedSidecar.host}` : ''}...`);
        autoPipelineProjectStarting(projectId, projectName, nodeCount, assignedSidecar);
        projectMem('embed-start', projectId, projectName);

        // Phase 5: per-project try/catch with loud reporting via failed list
        try {
          const result = await semanticSearch.buildProjectEmbeddings(projectId);
          projectMem('embed-done', projectId, projectName);
          totalProcessed += result.processed;
          totalErrors += result.errors;
          if (result.yielded) {
            autoPipelineProjectSkipped(projectId, projectName);
            this.log(`    Yielded ${projectName}: ${result.yielded} nodes left to the running heavy job`);
            break;
          }
          autoPipelineProjectDone(result.processed, result.errors);
          this.log(`    Completed: ${result.processed} embeddings (${result.errors} errors)`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.log(`    FAILED ${projectName}: ${errMsg}`);
          crashLog(`AUTO_EMBED_FAILED project=${projectId}/${projectName} ${errMsg}`);
          autoPipelineProjectFailed(projectId, projectName, errMsg);
          totalErrors++;
        }

        // Force-evict this project's Kuzu DB regardless of success/failure.
        // Without this the per-project native footprint accumulates and
        // RSS climbs past the macOS Jetsam ceiling within ~90s.
        try {
          const { closeProjectGraphDatabase } = await import('./graph/projectGraphConnection.js');
          await closeProjectGraphDatabase(projectId);
        } catch (closeErr) {
          this.log(`    Warning: failed to close project ${projectId} graph DB: ${closeErr}`);
        }
      }

      this.log(`Embedding generation complete: ${totalProcessed} embedded · ${totalSkipped} skipped · ${totalErrors} errors`);
      autoPipelineFinished();

    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.log(`Failed to initialize embeddings: ${errMsg}`);
      crashLog(`AUTO_EMBED_PIPELINE_FAILED ${errMsg} ${error instanceof Error && error.stack ? error.stack.split('\n').slice(1, 4).join(' | ') : ''}`);
      try {
        const { autoPipelineFailed } = await import('./embedding/autoPipelineBus.js');
        autoPipelineFailed(errMsg);
      } catch { /* best effort */ }
      // Don't throw - allow server to continue without embeddings
    }
  }

  /**
   * Initialize AST caches for all registered pods that don't have one
   * This runs in the background after server initialization completes
   */
  private async initializeAstCachesForPods(): Promise<void> {
    try {
      const db = getFantomDatabase();
      await db.initialize();

      // Get all registered pods
      const pods = await db.getAllPods();
      if (pods.length === 0) {
        this.log('No pods registered - skipping AST cache initialization');
        return;
      }

      // Get all existing projects
      const projects = await db.getAllProjects();
      const existingPaths = new Set(projects.map(p => p.path));

      // Find pods without AST caches (projects)
      const podsWithoutCache = pods.filter(pod => !existingPaths.has(pod.path));

      if (podsWithoutCache.length === 0) {
        this.log('All pods already have AST caches');
        return;
      }

      this.log(`Creating AST caches for ${podsWithoutCache.length} pod(s)...`);

      const codeIndexer = getFantomCodeIndexer();
      const searchIndex = getFantomFunctionSearchIndex();
      let created = 0;
      let indexed = 0;

      // Inline language detection helper
      const detectPrimaryLanguage = (dirPath: string): { language: string; parserType: string } => {
        const extCounts: Record<string, number> = {};
        const EXT_MAP: Record<string, string> = {
          '.fan': 'fantom', '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript',
          '.jsx': 'javascript', '.vue': 'vue', '.py': 'python', '.java': 'java',
          '.go': 'go', '.rs': 'rust', '.css': 'css', '.dart': 'dart',
          '.cs': 'csharp', '.rb': 'ruby', '.php': 'php', '.kt': 'kotlin',
          '.swift': 'swift', '.scala': 'scala', '.c': 'c', '.cpp': 'cpp', '.h': 'c',
        };
        const scanDir = (p: string) => {
          try {
            const entries = fsSync.readdirSync(p, { withFileTypes: true });
            for (const e of entries) {
              if (e.name.startsWith('.')) continue;
              // Use the shared exclude list — keeps detection in sync with
              // the indexer scanner so vendored .vue / .ts files in
              // node_modules / .next / .turbo never contaminate the count.
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { DEFAULT_EXCLUDE_DIRS } = require('./fantom-code/excludeDirs.js');
              if (DEFAULT_EXCLUDE_DIRS.has(e.name)) continue;
              const full = path.join(p, e.name);
              if (e.isDirectory()) scanDir(full);
              else if (e.isFile()) {
                const ext = path.extname(e.name).toLowerCase();
                const lang = EXT_MAP[ext];
                if (lang) extCounts[lang] = (extCounts[lang] || 0) + 1;
              }
            }
          } catch { /* skip unreadable dirs */ }
        };
        scanDir(dirPath);
        // Pick by count, not by first-match. The legacy short-circuit on
        // `extCounts['vue']` mistagged TS projects with stray .vue files.
        const sorted = Object.entries(extCounts).sort((a, b) => b[1] - a[1]);
        if (sorted.length === 0 || sorted[0][0] === 'fantom') return { language: 'fantom', parserType: 'regex' };
        return { language: sorted[0][0], parserType: 'tree-sitter-wasm' };
      };

      for (const pod of podsWithoutCache) {
        try {
          this.log(`  Creating AST cache for pod: ${pod.name} at ${pod.path}`);

          // Detect language
          const detected = detectPrimaryLanguage(pod.path);

          // Create a new project for this pod
          const project = await db.createProject({
            name: pod.name,
            path: pod.path,
            podName: pod.name,
            instanceId: pod.defaultInstanceId || undefined,
            description: `AST cache for ${pod.name}`,
            autoIndex: true,
            language: detected.language,
            parserType: detected.parserType
          });

          created++;

          let result: { functionsIndexed: number; typesIndexed: number; filesProcessed: number; errors: { file: string; message: string; severity: string }[]; duration: number };

          if (detected.language !== 'fantom') {
            // Use CodeIndexingService for non-Fantom languages
            const { getCodeIndexingService } = await import('./fantom-code/codeIndexingService.js');
            const prisma = getPrismaClient();
            const service = getCodeIndexingService(prisma);

            result = await service.indexProject({
              id: project.id,
              name: project.name,
              path: project.path,
              instanceId: project.instanceId,
              podMeta: project.podName ? { podName: project.podName, dependencies: [], srcDirs: ['fan'] } : undefined,
              functionCount: 0,
              typeCount: 0,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
              language: detected.language,
              parserType: detected.parserType
            }, { forceParser: 'tree-sitter', buildGraph: true });
          } else {
            // Use Fantom-specific indexer
            const indexerProject: FantomProject = {
              id: project.id,
              name: project.name,
              path: project.path,
              instanceId: project.instanceId,
              podMeta: project.podName ? { podName: project.podName, dependencies: [], srcDirs: ['fan'] } : undefined,
              functionCount: 0,
              typeCount: 0,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt
            };

            result = await codeIndexer.indexProject(indexerProject);
          }

          // Update database with stats
          await db.updateProjectIndexStats(project.id, result.functionsIndexed, result.typesIndexed);

          indexed++;
          this.log(`    Indexed (${detected.language}): ${result.functionsIndexed} functions, ${result.typesIndexed} types in ${result.duration}ms`);

          if (result.errors.length > 0) {
            this.log(`    Warnings: ${result.errors.length} parse errors`);
          }
        } catch (err) {
          this.log(`    Error creating AST cache for pod ${pod.name}: ${err}`);
        }
      }

      // Rebuild FlexSearch index if we indexed any new projects
      if (indexed > 0) {
        searchIndex.rebuild(codeIndexer);
        this.log(`FlexSearch index rebuilt with ${searchIndex.size} functions`);
      }

      this.log(`AST cache initialization complete: ${created} created, ${indexed} indexed`);

    } catch (error) {
      this.log(`Failed to initialize AST caches for pods: ${error}`);
      // Don't throw - this is a background task
    }
  }

  /**
   * Initialize documentation caches for all instances that don't have cached docs
   * This runs in the background after server initialization completes
   */
  private async initializeDocCachesForInstances(): Promise<void> {
    try {
      // Dynamically import to avoid circular dependencies
      const { getDocStatus, parseInstanceDocs } = await import('./parser/local/index.js');
      const db = getFantomDatabase();
      await db.initialize();

      const instances = await db.getAllInstances();
      if (instances.length === 0) {
        this.log('No instances registered - skipping doc cache initialization');
        return;
      }

      this.log(`Checking doc caches for ${instances.length} instances...`);

      let cached = 0;
      let indexed = 0;

      for (const instance of instances) {
        try {
          const status = await getDocStatus(instance.id);
          const cachedCount = status.itemCount ?? 0;
          if (status.hasCache && cachedCount > 0) {
            cached++;
            continue;
          }

          // Index docs for this instance
          this.log(`Indexing docs for ${instance.name}...`);
          const result = await parseInstanceDocs({
            instanceId: instance.id,
            forceRefresh: false
          });
          this.log(`Indexed ${result.items.length} docs for ${instance.name}`);
          indexed++;
        } catch (err) {
          this.log(`Failed to index docs for ${instance.name}: ${err}`);
        }
      }

      this.log(`Doc cache initialization complete: ${cached} already cached, ${indexed} newly indexed`);

    } catch (error) {
      this.log(`Failed to initialize doc caches: ${error}`);
      // Don't throw - this is a background task
    }
  }

  /**
   * Get server status for admin dashboard
   */
  private getServerStatus(): ServerStatus {
    const memUsage = process.memoryUsage();
    const stats = this.searchIndex.getStats();

    return {
      status: this.initializationComplete ? 'running' : 'starting',
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      // `heapTotal` is only what V8 has currently reserved and it grows on
      // demand, so heapUsed/heapTotal sits at 80–90% by design and reads as an
      // alarm when nothing is wrong. Report against the real ceiling
      // (--max-old-space-size → heap_size_limit) and surface RSS, which is what
      // the OS kills on.
      memory: (() => {
        const limit = v8.getHeapStatistics().heap_size_limit || memUsage.heapTotal;
        return {
          used: memUsage.heapUsed,
          total: limit,
          percentage: Math.round((memUsage.heapUsed / limit) * 100),
          heapTotal: memUsage.heapTotal,
          rss: memUsage.rss,
          external: memUsage.external,
        };
      })(),
      initialized: this.initializationComplete,
      version: '1.0.0',
      serverPath: path.resolve(dirname(fileURLToPath(import.meta.url)), 'index.js'),
      port: getServerPort(),
      stats: {
        docsIndexed: stats.totalItems || 0,
        activeSessions: this.httpTransports.size,
      },
    };
  }

  /**
   * Get cache information for admin dashboard
   */
  private getCacheInfo(): CacheInfo[] {
    const cacheDir = this.config.cacheDir;
    const caches: CacheInfo[] = [];

    try {
      if (fsSync.existsSync(cacheDir)) {
        const entries = fsSync.readdirSync(cacheDir);

        for (const entry of entries) {
          const entryPath = path.join(cacheDir, entry);
          const stats = fsSync.statSync(entryPath);

          // LanceDB directory (fantomvector.db/)
          if (stats.isDirectory() && entry.endsWith('.db')) {
            const dirSize = this.getDirectorySize(entryPath);
            caches.push({
              name: entry,
              path: entryPath,
              size: dirSize,
              lastModified: stats.mtime.toISOString(),
              age: Date.now() - stats.mtime.getTime(),
              storageType: 'lancedb',
            });
            continue;
          }

          // SQLite database files
          if (entry.endsWith('.db') && stats.isFile()) {
            caches.push({
              name: entry,
              path: entryPath,
              size: stats.size,
              lastModified: stats.mtime.toISOString(),
              age: Date.now() - stats.mtime.getTime(),
              storageType: 'sqlite',
            });
            continue;
          }

          // JSON cache files
          if (entry.endsWith('.json') && stats.isFile()) {
            const cacheInfo: CacheInfo = {
              name: entry,
              path: entryPath,
              size: stats.size,
              lastModified: stats.mtime.toISOString(),
              age: Date.now() - stats.mtime.getTime(),
              storageType: 'json-cache',
            };

            // Try to read cache metadata from file content
            try {
              const content = fsSync.readFileSync(entryPath, 'utf-8');
              const cacheData = JSON.parse(content);

              if (cacheData.metadata) {
                cacheInfo.metadata = {
                  version: cacheData.metadata.version || 'unknown',
                  source: cacheData.metadata.source || entry.replace('.json', ''),
                  itemCount: cacheData.metadata.itemCount || (cacheData.items?.length || 0),
                  timestamp: cacheData.metadata.timestamp || stats.mtime.getTime(),
                };

                // Calculate breakdown by type and pod if items exist
                if (Array.isArray(cacheData.items) && cacheData.items.length > 0) {
                  const byType: Record<string, number> = {};
                  const byPod: Record<string, number> = {};

                  for (const item of cacheData.items) {
                    const type = item.type || 'unknown';
                    byType[type] = (byType[type] || 0) + 1;

                    const pod = item.pod || 'unknown';
                    byPod[pod] = (byPod[pod] || 0) + 1;
                  }

                  cacheInfo.metadata.byType = byType;
                  cacheInfo.metadata.byPod = byPod;
                }
              }
            } catch (parseError) {
              this.log(`Could not read metadata from ${entry}: ${parseError}`);
            }

            caches.push(cacheInfo);
          }
        }
      }
    } catch (error) {
      console.error('Failed to get cache info:', error);
    }

    return caches;
  }

  /**
   * Calculate total size of a directory recursively
   */
  private getDirectorySize(dirPath: string): number {
    let totalSize = 0;
    try {
      const entries = fsSync.readdirSync(dirPath);
      for (const entry of entries) {
        const entryPath = path.join(dirPath, entry);
        const stats = fsSync.statSync(entryPath);
        if (stats.isFile()) {
          totalSize += stats.size;
        } else if (stats.isDirectory()) {
          totalSize += this.getDirectorySize(entryPath);
        }
      }
    } catch {
      // Ignore errors for inaccessible entries
    }
    return totalSize;
  }

  /**
   * Create admin context for routes
   */
  private createAdminContext(): AdminContext {
    // Tool categories for organization
    const toolCategories: Record<string, string[]> = {
      search: ['searchVersionedApi', 'searchLocalDocs', 'searchFantomCode', 'searchAll'],
      retrieve: ['getFantomType', 'listFantomPods'],
      migration: ['migrateSkySpark4x', 'commitMigration', 'rollbackMigration'],
      generation: ['generateFantomCode'],
    };

    // Get category for a tool name
    const getToolCategory = (toolName: string): string => {
      for (const [category, tools] of Object.entries(toolCategories)) {
        if (tools.includes(toolName)) return category;
      }
      // Check if it's an agent tool
      const agentPrefixes = ['doc_', 'code_', 'gen_', 'proj_', 'analytics_', 'explorer_'];
      for (const prefix of agentPrefixes) {
        if (toolName.startsWith(prefix)) {
          return toolName.split('_')[0];
        }
      }
      return 'other';
    };

    return {
      getServerStatus: () => this.getServerStatus(),
      getCacheInfo: () => this.getCacheInfo(),
      clearCache: async (name?: string) => {
        if (name) {
          const cacheDir = this.config.cacheDir;
          const filePath = path.join(cacheDir, name);
          if (fsSync.existsSync(filePath)) {
            fsSync.unlinkSync(filePath);
          }
        } else {
          await this.cacheManager.clearCache();
          this.searchIndex.clear();
        }
      },
      getLogBuffer: () => this.logBuffer,
      getPrimaryProject: () => this.primaryContext,
      setPrimaryProject: async (
        instance: string,
        project: string,
        setBy: 'vscode' | 'dashboard' | 'api' | 'startup' = 'api'
      ): Promise<PrimaryProjectContext> => {
        this.primaryContext = {
          instance,
          project,
          setBy,
          timestamp: new Date(),
        };
        return this.primaryContext;
      },
      configDir: path.join(getInstallRoot(), 'config'),
      cacheDir: this.config.cacheDir,

      // MCP Explorer additions
      getAvailableTools: (): McpTool[] => {
        // Get primary tools from handleListTools structure
        const primaryTools: McpTool[] = [
          {
            name: 'getFantomType',
            description: 'Get detailed information about a specific Fantom type by its qualified name.',
            category: 'retrieve',
            inputSchema: {
              type: 'object',
              properties: {
                qualifiedName: { type: 'string', description: 'Qualified type name (e.g., "sys::Str")' },
              },
              required: ['qualifiedName'],
            },
          },
          {
            name: 'listFantomPods',
            description: 'List all available pods or projects in the indexed documentation.',
            category: 'retrieve',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'migrateSkySpark4x',
            description: 'Automatically migrate a SkySpark 3.x project to 4.0.',
            category: 'migration',
            inputSchema: {
              type: 'object',
              properties: {
                gitlabUrl: { type: 'string', description: 'GitLab SSH URL' },
                projectName: { type: 'string', description: 'Project name' },
                workDir: { type: 'string', description: 'Working directory' },
                skysparkBinPath: { type: 'string', description: 'SkySpark bin directory path' },
                dryRun: { type: 'boolean', description: 'Preview without committing' },
              },
              required: ['gitlabUrl', 'projectName', 'workDir', 'skysparkBinPath'],
            },
          },
          {
            name: 'commitMigration',
            description: 'Commit and push migration changes after review.',
            category: 'migration',
            inputSchema: {
              type: 'object',
              properties: {
                projectPath: { type: 'string', description: 'Full path to the project' },
              },
              required: ['projectPath'],
            },
          },
          {
            name: 'rollbackMigration',
            description: 'Rollback migration changes to pre-migration state.',
            category: 'migration',
            inputSchema: {
              type: 'object',
              properties: {
                projectPath: { type: 'string', description: 'Full path to the project' },
              },
              required: ['projectPath'],
            },
          },
          {
            name: 'generateFantomCode',
            description: 'Generate Fantom code including classes, methods, pods, enums, and mixins.',
            category: 'generation',
            inputSchema: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['class', 'method', 'pod', 'enum', 'mixin'] },
                name: { type: 'string', description: 'Name of the class, method, or pod' },
                pod: { type: 'string', description: 'Pod name (for class/method)' },
                extends: { type: 'string', description: 'Parent class name' },
                validate: { type: 'boolean', description: 'Validate generated code' },
              },
              required: ['type', 'name'],
            },
          },
          {
            name: 'searchVersionedApi',
            description: 'Unified version-aware search across API docs, source code, and code samples. Supports strict version filtering.',
            category: 'search',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search query (e.g., "readAll", "HttpClient")' },
                mode: { type: 'string', enum: ['api', 'code', 'samples', 'all'], description: 'Search modality' },
                version: { type: 'string', description: 'Explicit version (e.g., "3.1.12")' },
                instanceId: { type: 'number', description: 'Instance ID to derive version from' },
                sources: { type: 'array', items: { type: 'string', enum: ['local', 'fantom-source'] }, description: 'Data sources' },
                pod: { type: 'string', description: 'Filter by pod name' },
                type: { type: 'string', enum: ['type', 'slot', 'function', 'method', 'field', 'tag', 'example', 'guide'], description: 'Element type' },
                language: { type: 'string', enum: ['fantom', 'axon'], description: 'Filter by language' },
                limit: { type: 'number', description: 'Max results (1-50)' },
              },
              required: ['query'],
            },
          },
          // Fantom Code Search Tools
          {
            name: 'searchFantomCode',
            description: 'Search indexed source code across pods or projects for functions, methods, and fields.',
            category: 'search',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search query' },
                projectId: { type: 'number', description: 'Filter by project ID' },
                projectName: { type: 'string', description: 'Alternative to projectId — exact name match' },
                instanceId: { type: 'number', description: 'Filter by instance ID' },
                podId: { type: 'number', description: 'Filter by pod ID' },
                category: { type: 'string', description: 'Filter by category' },
                className: { type: 'string', description: 'Filter by class name' },
                type: { type: 'string', enum: ['method', 'field', 'constructor'], description: 'Filter by type' },
                isPublic: { type: 'boolean', description: 'Filter by visibility' },
                limit: { type: 'number', description: 'Max results (default: 20)' },
                compatibleWith: { type: 'string', description: 'Filter to compatible version' },
                dedupBy: { type: 'string', enum: ['none', 'qualifiedName', 'qualifiedNameSignature'], description: 'Collapse duplicate hits (default: qualifiedNameSignature). Helpful when bundled/vendored code produces the same symbol from multiple file paths.' },
              },
              required: ['query'],
            },
          },
          {
            name: 'semanticSearchFantomCode',
            description: 'Vector + graph + cross-encoder semantic search over indexed code. Embeds the query with the configured embedding model (sidecar-backed when configured), retrieves top-K from LanceDB, enriches with graph metrics, then optionally cross-encoder reranks (Qwen3-Reranker-8B etc.) and/or LLM-reranks. Use this for conceptual queries like "where is rate-limiting handled" rather than exact-symbol lookups.',
            category: 'search',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Natural-language query' },
                projectId: { type: 'number', description: 'Restrict to a single project' },
                projectName: { type: 'string', description: 'Alternative to projectId — exact name match' },
                limit: { type: 'number', description: 'Max results returned (default: 10)' },
                minScore: { type: 'number', description: 'Filter cosine similarity below this (default: server-config)' },
                includeGraphContext: { type: 'boolean', description: 'Include caller/callee/related-node metadata (default: true)' },
                useCrossEncoder: { type: 'boolean', description: 'Run cross-encoder rerank stage if a sidecar advertises capability `reranker` (default: server-config)' },
                useLLMRerank: { type: 'boolean', description: 'Run LLM rerank stage using configured provider (default: server-config)' },
              },
              required: ['query'],
            },
          },
          {
            name: 'embedChangedFiles',
            description: 'Re-embed a project after files have changed (file-watcher / CI hook / IDE plugin entry point). Triggers an incremental embedding pass for the project — uses SemanticSearchService.buildProjectEmbeddings which only embeds nodes that don\'t yet have a vector. The optional `files` field is informational; embedding works at the project level (the indexer already knows which nodes are new). When `force=true`, deletes existing project vectors first (full re-embed). Routes through the live sidecar if configured.',
            category: 'index',
            inputSchema: {
              type: 'object',
              properties: {
                projectId: { type: 'number', description: 'Project ID to re-embed' },
                projectName: { type: 'string', description: 'Alternative to projectId — exact name match' },
                files: { type: 'array', items: { type: 'string' }, description: 'Optional list of changed file paths (informational only; embedding is project-scoped)' },
                force: { type: 'boolean', description: 'When true, delete existing vectors first (full re-embed). Default false (incremental)' },
              },
            },
          },
          {
            name: 'getFantomFunction',
            description: 'Get detailed information about a specific Fantom function by its qualified name or ID.',
            category: 'retrieve',
            inputSchema: {
              type: 'object',
              properties: {
                qualifiedName: { type: 'string', description: 'Qualified name (e.g., "myPod::MyClass.myMethod")' },
                id: { type: 'string', description: 'Function ID (alternative to qualifiedName)' },
              },
            },
          },
          {
            name: 'listFunctionsInFile',
            description: 'List every symbol (type / function / method / field) in a single file, ordered by line. Use atTime to snapshot the file as it existed at a past timestamp via the IndexRun + ApiChange history. Best tool for "what is in foo.ts" or "what was in foo.ts last Tuesday".',
            category: 'retrieve',
            inputSchema: {
              type: 'object',
              properties: {
                filePath: { type: 'string', description: 'Absolute file path (or relative to a registered project)' },
                projectId: { type: 'number', description: 'Optional — auto-resolved by longest prefix when omitted' },
                atTime: { type: 'string', description: 'ISO timestamp; reconstructs file state at that moment' },
                limit: { type: 'number', description: 'Max symbols (default 100, max 1000)' },
                offset: { type: 'number', description: 'Pagination offset' },
              },
              required: ['filePath'],
            },
          },
          {
            name: 'getCodeNeighbors',
            description: 'Get the symbols immediately preceding and following a named symbol within its file. Answers "what is right above/below function X" — and with atTime, "what was below it last week". Pass count for window size on each side.',
            category: 'retrieve',
            inputSchema: {
              type: 'object',
              properties: {
                qualifiedName: { type: 'string', description: 'Qualified name of the anchor symbol' },
                projectId: { type: 'number', description: 'Required when qualifiedName matches multiple projects' },
                atTime: { type: 'string', description: 'ISO timestamp for time-travel' },
                count: { type: 'number', description: 'Symbols on each side (default 2, max 20)' },
              },
              required: ['qualifiedName'],
            },
          },
          {
            name: 'searchProjects',
            description: 'Find projects by query — scores name + path + podName + description and returns the top hits. Faster than listFantomProjects when you know the project but not the id. Filters: language, instanceId, hasGraphData, minFunctions.',
            category: 'search',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Substring to score against name, path, podName, description' },
                language: { type: 'string', description: 'Exact language match (e.g. "typescript")' },
                instanceId: { type: 'number', description: 'Filter to one instance' },
                hasGraphData: { type: 'boolean', description: 'Only projects with >0 LadybugDB nodes' },
                minFunctions: { type: 'number', description: 'Skip projects with fewer than N indexed functions' },
                limit: { type: 'number', description: 'Max results (default 20, max 100)' },
              },
            },
          },
          {
            name: 'getIndexHealth',
            description: 'Audit consistency of a project across the four stores (Prisma, LadybugDB graph, LanceDB vectors, FlexSearch search). Returns counts + diffs + warnings so you can see at a glance whether the indexer pipeline is healthy. Use after addFantomProject/refreshFantomProject to verify everything wired up.',
            category: 'diagnostics',
            inputSchema: {
              type: 'object',
              properties: {
                projectId: { type: 'number', description: 'Project ID' },
                projectName: { type: 'string', description: 'Project name (alternative to projectId)' },
              },
            },
          },
          {
            name: 'listFantomProjects',
            description: 'List indexed projects (paged). Default returns 50 compact rows so responses stay under the MCP token cap. Use nameContains/pathContains/language/instanceId to narrow, and offset+limit to page. Pass compact:false for the full record (path, description, timestamps).',
            category: 'retrieve',
            inputSchema: {
              type: 'object',
              properties: {
                compatibleWith: { type: 'string', description: 'Filter to compatible version' },
                limit: { type: 'number', description: 'Max rows (default 50, max 500)' },
                offset: { type: 'number', description: 'Pagination offset (default 0)' },
                pathContains: { type: 'string', description: 'Case-insensitive substring match on path' },
                nameContains: { type: 'string', description: 'Case-insensitive substring match on name' },
                language: { type: 'string', description: 'Exact language match (e.g. "typescript")' },
                instanceId: { type: 'number', description: 'Filter to one instance' },
                compact: { type: 'boolean', description: 'Compact projection (default true). Set false for full record.' },
              },
            },
          },
          {
            name: 'addFantomProject',
            description: 'Add a new Fantom project to index.',
            category: 'management',
            inputSchema: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Project name' },
                path: { type: 'string', description: 'Full path to project directory' },
                instanceId: { type: 'number', description: 'Associated instance ID' },
                podName: { type: 'string', description: 'Pod name (auto-detected from build.fan)' },
                description: { type: 'string', description: 'Project description' },
                autoIndex: { type: 'boolean', description: 'Auto-index on startup' },
                language: { type: 'string', description: 'Source language (fantom, typescript, javascript, python, java, ...). Defaults to "fantom".' },
                parserType: { type: 'string', description: 'Parser type (regex | tree-sitter-wasm). Auto-selected when language is non-Fantom.' },
              },
              required: ['name', 'path'],
            },
          },
          {
            name: 'refreshFantomProject',
            description: 'Re-index a specific Fantom project to pick up code changes.',
            category: 'management',
            inputSchema: {
              type: 'object',
              properties: {
                projectId: { type: 'number', description: 'Project ID to re-index' },
                projectName: { type: 'string', description: 'Project name (alternative to projectId)' },
              },
            },
          },
          {
            name: 'getFantomCodeStats',
            description: 'Get statistics about the Fantom code index including function counts.',
            category: 'analytics',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'removeFantomProject',
            description: 'Fully remove a project: drops the FantomProject row, LadybugDB nodes/edges, LanceDB vectors, in-memory index entries, and (via cascade) IndexedFile/IndexRun/ApiChange rows. Pass projectId or projectName.',
            category: 'management',
            inputSchema: {
              type: 'object',
              properties: {
                projectId: { type: 'number' },
                projectName: { type: 'string', description: 'Alternative to projectId' },
              },
            },
          },
          {
            name: 'clearProjectIndex',
            description: 'Wipe a project\'s derived data (graph, vectors, in-memory index, IndexedFile rows) but keep the FantomProject registration. Useful when fixing excludePatterns: clear → reconfigure → re-index.',
            category: 'management',
            inputSchema: {
              type: 'object',
              properties: {
                projectId: { type: 'number' },
                projectName: { type: 'string', description: 'Alternative to projectId' },
              },
            },
          },
          {
            name: 'reindexChangedFiles',
            description: 'Re-index a specific set of files after edits. Pass the absolute paths you just modified. Faster than refreshFantomProject — only the listed files are re-parsed, their graph nodes rebuilt, AND those nodes re-embedded so semantic search immediately reflects the edit. Call this after every code change to keep the index live. Records one IndexRun (trigger="mcp") with per-symbol ApiChange rows. If projectId is omitted, the server resolves it from the longest matching project.path prefix.',
            category: 'management',
            inputSchema: {
              type: 'object',
              properties: {
                paths: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Absolute file paths just edited',
                },
                projectId: {
                  type: 'number',
                  description: 'Optional. Resolved from path prefix when omitted.',
                },
              },
              required: ['paths'],
            },
          },
          {
            name: 'whatChangedRecently',
            description: 'Convenience wrapper: "what changed in this project in the last N hours?" Returns ApiChange events grouped by file. Default window: 24 hours. Supports kind filter (added | modified | removed). Best first stop for "what broke today".',
            category: 'analytics',
            inputSchema: {
              type: 'object',
              properties: {
                projectId: { type: 'number' },
                projectName: { type: 'string', description: 'Alternative to projectId' },
                hoursAgo: { type: 'number', description: 'Window size in hours (default 24)' },
                kind: { type: 'string', enum: ['added', 'modified', 'removed'] },
              },
            },
          },
          {
            name: 'getSymbolHistory',
            description: 'Full timeline of changes for a single symbol (qualifiedName). Returns chronological events with before/after signatures + summary stats (firstSeen, lastModified, modifyCount, isCurrentlyRemoved, signatureChurn). Use to answer "when did this break" or "what did this look like before".',
            category: 'analytics',
            inputSchema: {
              type: 'object',
              properties: {
                qualifiedName: { type: 'string' },
                projectId: { type: 'number', description: 'Optional — disambiguate when symbol exists in multiple projects' },
                since: { type: 'string', description: 'ISO timestamp or shorthand (-7d, -24h)' },
                until: { type: 'string' },
              },
              required: ['qualifiedName'],
            },
          },
          {
            name: 'diffByTime',
            description: 'Diff between two timestamps (not run IDs — use ISO strings or shorthand like -24h, -7d). Returns counts + samples grouped by file. Optional scope filter: file:<path>, symbol:<qn>, class:<qn-prefix>. More flexible than diffIndexRuns when you know the time but not the run.',
            category: 'analytics',
            inputSchema: {
              type: 'object',
              properties: {
                projectId: { type: 'number' },
                projectName: { type: 'string', description: 'Alternative to projectId' },
                from: { type: 'string', description: 'ISO timestamp or -7d / -24h shorthand' },
                to: { type: 'string', description: 'ISO timestamp, "now", or -1h shorthand' },
                scope: { type: 'string', description: 'Optional filter: file:<path>, symbol:<qn>, class:<qn-prefix>' },
              },
              required: ['from', 'to'],
            },
          },
          {
            name: 'getActivitySummary',
            description: 'Aggregate stats for a project over a time window: totalRuns, totalChanges, byChangeType, byKind, hottestFiles[10], hottestSymbols[10], plus a histogram bucketed by hour|day|week. Default window: 7 days, granularity day.',
            category: 'analytics',
            inputSchema: {
              type: 'object',
              properties: {
                projectId: { type: 'number' },
                projectName: { type: 'string' },
                since: { type: 'string', description: 'ISO or -7d/-24h shorthand' },
                until: { type: 'string' },
                granularity: { type: 'string', enum: ['hour', 'day', 'week'] },
              },
            },
          },
          {
            name: 'compareSnapshots',
            description: 'Paginated qualifiedNames-only diff between two timestamps. Use cursor + pageSize to stream large diffs. Optional section filter (added | modified | removed | all).',
            category: 'analytics',
            inputSchema: {
              type: 'object',
              properties: {
                projectId: { type: 'number' },
                projectName: { type: 'string' },
                from: { type: 'string' },
                to: { type: 'string' },
                cursor: { type: 'string' },
                pageSize: { type: 'number', description: 'Default 200, max 500' },
                section: { type: 'string', enum: ['added', 'modified', 'removed', 'all'] },
              },
              required: ['from', 'to'],
            },
          },
          {
            name: 'explainSymbolChange',
            description: 'For a single ApiChange event (qualifiedName + runId), return the event row + sibling changes in the same file/run + a heuristic label (signature-unchanged-body-change | param-added | param-removed | return-type-changed | renamed-or-moved | added | removed | unknown).',
            category: 'analytics',
            inputSchema: {
              type: 'object',
              properties: {
                qualifiedName: { type: 'string' },
                runId: { type: 'number' },
              },
              required: ['qualifiedName', 'runId'],
            },
          },
          {
            name: 'listIndexRuns',
            description: 'List recent indexing runs for a project (or all projects), with added/modified/removed counts and durations. Use to debug API drift over time.',
            category: 'analytics',
            inputSchema: {
              type: 'object',
              properties: {
                projectId: { type: 'number', description: 'Filter to one project (optional)' },
                since: { type: 'string', description: 'ISO timestamp lower bound on startedAt' },
                until: { type: 'string', description: 'ISO timestamp upper bound on startedAt' },
                trigger: { type: 'string', enum: ['manual', 'auto', 'watch', 'mcp', 'mcp-add', 'mcp-refresh', 'mcp-incremental', 'admin-reindex', 'file-watch'], description: 'Filter by what triggered the run' },
                limit: { type: 'number', description: 'Max results (default: 50, max: 500)' },
              },
            },
          },
          {
            name: 'getApiChangeHistory',
            description: 'Flat list of recorded API changes (added/modified/removed). Filter by qualifiedName to track one symbol over time, or by projectId for all changes within a project.',
            category: 'analytics',
            inputSchema: {
              type: 'object',
              properties: {
                projectId: { type: 'number' },
                qualifiedName: { type: 'string', description: 'Exact qualified name (e.g. "myPod::MyClass.myMethod")' },
                kind: { type: 'string', enum: ['function', 'type', 'field'] },
                changeType: { type: 'string', enum: ['added', 'modified', 'removed'] },
                since: { type: 'string' },
                until: { type: 'string' },
                limit: { type: 'number', description: 'Max results (default: 100, max: 1000)' },
              },
            },
          },
          {
            name: 'diffIndexRuns',
            description: 'Aggregate added/modified/removed symbols between two index runs (or two timestamps) for one project. Net delta — collapses churn (modify+remove on same symbol = removed).',
            category: 'analytics',
            inputSchema: {
              type: 'object',
              properties: {
                projectId: { type: 'number', description: 'Required' },
                fromRunId: { type: 'number' },
                toRunId: { type: 'number' },
                fromTime: { type: 'string', description: 'ISO timestamp; alternative to fromRunId' },
                toTime: { type: 'string', description: 'ISO timestamp; defaults to now' },
              },
              required: ['projectId'],
            },
          },
          {
            name: 'listCompatiblePods',
            description: 'List pods/projects compatible with a specific SkySpark/Haxall version.',
            category: 'retrieve',
            inputSchema: {
              type: 'object',
              properties: {
                version: { type: 'string', description: 'Version to check compatibility' },
                instanceType: { type: 'string', enum: ['skyspark', 'haxall', 'fantom'], description: 'Filter by instance type' },
              },
              required: ['version'],
            },
          },
          // Local Documentation Tools
          {
            name: 'searchLocalDocs',
            description: 'Search local documentation across pods or projects for a given instance.',
            category: 'search',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search query' },
                instanceId: { type: 'number', description: 'Instance ID to search' },
                instanceType: { type: 'string', enum: ['skyspark', 'haxall', 'fantom'], description: 'Filter by instance type' },
                pod: { type: 'string', description: 'Filter by pod name' },
                type: { type: 'string', enum: ['type', 'function', 'tag', 'slot', 'chapter'], description: 'Filter by item type' },
                language: { type: 'string', enum: ['fantom', 'axon'], description: 'Filter by language' },
                limit: { type: 'number', description: 'Max results (default: 20)' },
              },
              required: ['query'],
            },
          },
          {
            name: 'indexInstanceDocs',
            description: 'Index or refresh local documentation for a SkySpark/Fantom instance.',
            category: 'management',
            inputSchema: {
              type: 'object',
              properties: {
                instanceId: { type: 'number', description: 'Instance ID to index' },
                pods: { type: 'array', items: { type: 'string' }, description: 'Specific pods to index' },
                forceRefresh: { type: 'boolean', description: 'Force re-indexing even if cached' },
              },
              required: ['instanceId'],
            },
          },
          {
            name: 'listLocalPods',
            description: 'List available documentation pods or projects for an instance.',
            category: 'retrieve',
            inputSchema: {
              type: 'object',
              properties: {
                instanceId: { type: 'number', description: 'Instance ID' },
              },
              required: ['instanceId'],
            },
          },
          {
            name: 'getLocalDocStatus',
            description: 'Get documentation indexing status for an instance.',
            category: 'analytics',
            inputSchema: {
              type: 'object',
              properties: {
                instanceId: { type: 'number', description: 'Instance ID' },
              },
              required: ['instanceId'],
            },
          },
          {
            name: 'semanticCodeSearch',
            description: 'Search code using natural language via AI embeddings.',
            category: 'search',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Natural language search query' },
                projectId: { type: 'number', description: 'Filter by project ID' },
                projectName: { type: 'string', description: 'Alternative to projectId — exact name match' },
                nodeType: { type: 'string', description: 'Filter by node type (function, method, type)' },
                limit: { type: 'number', description: 'Max results (default: 10)' },
              },
              required: ['query'],
            },
          },
          {
            name: 'askCodebase',
            description:
              'Ask a natural-language question about the codebase and get an intelligent, cited answer ' +
              'synthesized from semantic search, the call graph, and change history.',
            category: 'search',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Natural language question about the codebase' },
                projectId: { type: 'number', description: 'Filter by project ID' },
                useRlm: { type: 'boolean', description: 'Run the RLM investigation loop (tool calls over search + call graph) before answering. Default true: deeper, cited answers, typically 60–120s. false answers from retrieval only (~20–40s).' },
                useReranker: { type: 'boolean', description: 'Cross-encoder rerank of retrieved candidates (default true; routed to local GPU or OpenRouter per policy). false keeps the fused vector+keyword order.' },
              },
              required: ['query'],
            },
          },
          ...AXON_TOOL_DEFINITIONS,
          {
            name: 'findSimilarCode',
            description: 'Find code similar to a given function using vector embeddings.',
            category: 'search',
            inputSchema: {
              type: 'object',
              properties: {
                qualifiedName: { type: 'string', description: 'Qualified name of the function' },
                nodeId: { type: 'string', description: 'Node ID (alternative to qualifiedName)' },
                projectId: { type: 'number', description: 'Filter by project ID' },
                projectName: { type: 'string', description: 'Alternative to projectId — exact name match' },
                limit: { type: 'number', description: 'Max results (default: 5)' },
              },
            },
          },
          {
            name: 'getCallers',
            description: 'Find all functions that call a given function.',
            category: 'graph',
            inputSchema: {
              type: 'object',
              properties: {
                qualifiedName: { type: 'string', description: 'Qualified name of the function' },
                nodeId: { type: 'string', description: 'Node ID (alternative to qualifiedName)' },
                projectId: { type: 'number', description: 'Project ID to scope the lookup' },
                projectName: { type: 'string', description: 'Alternative to projectId — exact name match' },
                maxDepth: { type: 'number', description: 'Max call chain depth (default: 5)' },
              },
            },
          },
          {
            name: 'getCallees',
            description: 'Find all functions called by a given function.',
            category: 'graph',
            inputSchema: {
              type: 'object',
              properties: {
                qualifiedName: { type: 'string', description: 'Qualified name of the function' },
                nodeId: { type: 'string', description: 'Node ID (alternative to qualifiedName)' },
                projectId: { type: 'number', description: 'Project ID to scope the lookup' },
                projectName: { type: 'string', description: 'Alternative to projectId — exact name match' },
                maxDepth: { type: 'number', description: 'Max call chain depth (default: 5)' },
              },
            },
          },
          {
            name: 'getCodeImpact',
            description: 'Analyze the blast radius of changing a function.',
            category: 'graph',
            inputSchema: {
              type: 'object',
              properties: {
                qualifiedName: { type: 'string', description: 'Qualified name of the function' },
                nodeId: { type: 'string', description: 'Node ID (alternative to qualifiedName)' },
                projectId: { type: 'number', description: 'Project ID to scope the analysis' },
                projectName: { type: 'string', description: 'Alternative to projectId — exact name match' },
                maxDepth: { type: 'number', description: 'Max traversal depth (default: 10)' },
              },
            },
          },
        ];

        // Get agent tools
        const agentTools = this.agentFramework.getAllTools().map((tool) => ({
          name: tool.name,
          description: tool.description,
          category: getToolCategory(tool.name),
          inputSchema: tool.inputSchema as McpTool['inputSchema'],
        }));

        return [
          ...primaryTools.map(t => ({ ...t, mcpExposed: true })),
          ...agentTools.map(t => ({ ...t, mcpExposed: false })),
        ];
      },

      getSettings: (): FantomSettings => {
        return {
          port: getServerPort(),
          cacheDir: this.config.cacheDir,
          searchSettings: {
            ...this.config.searchSettings,
            useOrLogic: this.config.searchSettings?.useOrLogic ?? true, // Default to OR logic
          },
          semanticSearch: {
            minScore: this.config.semanticSearch?.minScore ?? 0.5,
            graphWeight: this.config.semanticSearch?.graphWeight ?? 0.3,
            defaultLimit: this.config.semanticSearch?.defaultLimit ?? 10,
            includeGraphContext: this.config.semanticSearch?.includeGraphContext ?? true,
            embeddingModel: this.config.semanticSearch?.embeddingModel,
            embeddingDimensions: this.config.semanticSearch?.embeddingDimensions,
            codeModel: this.config.semanticSearch?.codeModel,
            codeDimensions: this.config.semanticSearch?.codeDimensions,
            docsModel: this.config.semanticSearch?.docsModel,
            docsDimensions: this.config.semanticSearch?.docsDimensions,
            embeddingThreads: this.config.semanticSearch?.embeddingThreads ?? 2,
            embeddingBatchSize: this.config.semanticSearch?.embeddingBatchSize ?? 16,
            // Was omitted here, so the dashboard never received the saved value
            // and the form fell back to its default (1) on every load — the
            // value WAS persisted to disk and used by the backend the whole time.
            parallelProjects: (this.config.semanticSearch as any)?.parallelProjects ?? 1,
            codeFromSidecar: (this.config.semanticSearch as any)?.codeFromSidecar,
            docsFromSidecar: (this.config.semanticSearch as any)?.docsFromSidecar,
            llmReranker: (this.config.semanticSearch as any)?.llmReranker,
            crossEncoderReranker: (this.config.semanticSearch as any)?.crossEncoderReranker,
            queryInstruction: (this.config.semanticSearch as any)?.queryInstruction ?? 'auto',
            hybrid: (this.config.semanticSearch as any)?.hybrid ?? { enabled: true, vectorWeight: 1.0, keywordWeight: 0.7 },
            rerank: (this.config.semanticSearch as any)?.rerank ?? 'auto',
            answerSynthesis: (this.config.semanticSearch as any)?.answerSynthesis ?? { enabled: false, provider: 'auto', heavyModel: 'llama-3.3-70b-versatile', lightModel: 'llama-3.1-8b-instant', topK: 8, includeHistory: true },
          },
          cache: {
            enabled: process.env.CACHE_ENABLED !== 'false',
            maxAge: 86400000, // 24 hours default
          },
          auth: {
            accessTokenTtl: this.config.auth?.accessTokenTtl ?? 3600,        // 1 hour
            refreshTokenTtl: this.config.auth?.refreshTokenTtl ?? 2592000,   // 30 days
            authCodeTtl: this.config.auth?.authCodeTtl ?? 600,               // 10 minutes
          },
          sidecars: (() => {
            try {
              const p = path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');
              if (!fsSync.existsSync(p)) return [];
              const c = JSON.parse(fsSync.readFileSync(p, 'utf-8'));
              return Array.isArray(c.sidecars) ? c.sidecars : [];
            } catch { return []; }
          })(),
          sidecarMasterWsPort: (() => {
            try {
              const p = path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');
              if (!fsSync.existsSync(p)) return 3003;
              const c = JSON.parse(fsSync.readFileSync(p, 'utf-8'));
              return typeof c.sidecarMasterWsPort === 'number' ? c.sidecarMasterWsPort : 3003;
            } catch { return 3003; }
          })(),
          rssGuardMb: (() => {
            try {
              const p = path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');
              if (!fsSync.existsSync(p)) return 4000;
              const c = JSON.parse(fsSync.readFileSync(p, 'utf-8'));
              return typeof c.rssGuardMb === 'number' ? c.rssGuardMb : 4000;
            } catch { return 4000; }
          })(),
          projectEmbeddingOverrides: (() => {
            try {
              const p = path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');
              if (!fsSync.existsSync(p)) return {};
              const c = JSON.parse(fsSync.readFileSync(p, 'utf-8'));
              return c.projectEmbeddingOverrides && typeof c.projectEmbeddingOverrides === 'object' ? c.projectEmbeddingOverrides : {};
            } catch { return {}; }
          })(),
          axon: getAxonSettings(),
          llmProviders: (() => {
            try {
              const p = path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');
              if (!fsSync.existsSync(p)) return {};
              const c = JSON.parse(fsSync.readFileSync(p, 'utf-8'));
              return c.llmProviders ?? {};
            } catch { return {}; }
          })(),
        };
      },

      updateSettings: async (settings: Partial<FantomSettings>): Promise<void> => {
        const configPath = path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');

        // Load existing config through the crash-safe reader (recovers from
        // .backup if the primary was corrupted/clobbered) so a bad read can't
        // make us merge onto {} and wipe everything we don't re-send.
        const existingConfig: any = readConfigFileWithRecovery(configPath);

        // Merge settings
        const newConfig = {
          ...existingConfig,
          ...settings,
          searchSettings: { ...existingConfig.searchSettings, ...settings.searchSettings },
          semanticSearch: { ...existingConfig.semanticSearch, ...settings.semanticSearch },
          cache: { ...existingConfig.cache, ...settings.cache },
          auth: { ...existingConfig.auth, ...settings.auth },
          debug: { ...existingConfig.debug, ...(settings as any).debug },
          llmProviders: { ...existingConfig.llmProviders, ...(settings as any).llmProviders },
          axon: { ...existingConfig.axon, ...(settings as any).axon },
          sidecars: (settings as any).sidecars ?? existingConfig.sidecars,
        };

        // Atomic, crash-safe write (snapshot good→.backup, write tmp, rename):
        // a Jetsam-kill mid-write can't leave truncated JSON that resets all
        // settings on next boot, and a corrupt primary won't overwrite a good
        // backup. Shared with the sidecar registry and savePrimaryProject so
        // every writer of this file is crash-safe.
        atomicWriteConfigFile(configPath, newConfig);

        // Update runtime config
        if (settings.cacheDir) this.config.cacheDir = settings.cacheDir;
        if (settings.searchSettings) {
          this.config.searchSettings = { ...this.config.searchSettings, ...settings.searchSettings };
        }
        if (settings.auth) {
          this.config.auth = { ...this.config.auth, ...settings.auth };
        }
        if (settings.semanticSearch) {
          this.config.semanticSearch = { ...this.config.semanticSearch, ...settings.semanticSearch };
        }

        // Drop the LogSink config cache so the new debug toggle / segments
        // / level / size cap apply on the next log line — without restart.
        invalidateLogSinkCache();

        // Axon MCP client: drop the connection when its section changed so the
        // next call spawns/connects with the new path/transport.
        if ((settings as any).axon) {
          getAxonMcpClient().applySettingsChange().catch(() => { /* logged inside */ });
        }

        this.log('Settings updated');
      },

      getUsageStats: async (days: number) => {
        const tracker = getUsageTracker();
        return tracker.getStats(days);
      },

      getUsageDatabaseInfo: async () => {
        const tracker = getUsageTracker();
        const dbInfo = tracker.getDatabaseInfo();
        const counts = await tracker.getEventCounts();
        return {
          path: dbInfo.path,
          size: dbInfo.sizeBytes,
          toolEvents: counts.toolEvents,
          searchEvents: counts.searchEvents,
        };
      },

      clearUsageData: async () => {
        const tracker = getUsageTracker();
        await tracker.clearData();
        this.log('Usage data cleared');
      },

      resetUsageDatabase: async () => {
        const tracker = getUsageTracker();
        await tracker.resetDatabase();
        this.log('Usage database reset');
      },

      searchDocs: async (query: string, limit: number = 20) => {
        const results = await this.searchIndex.search(query, limit);
        return results.map((r) => ({
          name: r.item.name,
          qualifiedName: r.item.qualifiedName,
          type: r.item.type,
          pod: r.item.pod,
          description: r.item.description,
          url: r.item.url,
          score: r.score,
        }));
      },

      getPods: () => {
        const stats = this.searchIndex.getStats();
        return Object.keys(stats.byPod || {}).sort();
      },

      // Fantom Instance and Pod Management
      getFantomDatabase: async () => {
        const db = getFantomDatabase();
        await db.initialize();
        return db;
      },

      // Fantom Code Indexing — single shared entry point. See runIndex.ts.
      reindexProject: async (projectId: number, opts?: { force?: boolean }) => {
        const db = getFantomDatabase();
        await db.initialize();
        const { runIndex } = await import('./fantom-code/runIndex.js');
        const force = opts?.force === true;
        // A FORCED reindex re-parses + re-embeds the whole project: it takes the
        // shared heavy-job lock (throws HeavyJobBusyError → route answers 409).
        // Incremental reindexes skip the lock.
        const { acquireHeavyJob } = await import('./embedding/embedGate.js');
        const release = force ? acquireHeavyJob('code-reindex', `project ${projectId}`) : null;
        try {
          return await runIndex(db, getPrismaClient(), projectId, {
            trigger: 'admin-reindex',
            force,
          });
        } finally {
          release?.();
        }
      },

      getCodeStats: () => {
        const codeIndexer = getFantomCodeIndexer();
        const searchIndex = getFantomFunctionSearchIndex();
        const stats = codeIndexer.getStats();

        return {
          totalFunctions: stats.totalFunctions,
          totalTypes: stats.totalTypes,
          totalProjects: stats.totalProjects,
          searchIndexSize: searchIndex.size,
          byCategory: stats.byCategory,
          byProject: stats.byProject,
          lastUpdated: stats.lastUpdated
        };
      },

      reindexCode: async () => {
        const db = getFantomDatabase();
        await db.initialize();

        // Enable autoIndex for all projects
        const projectsEnabled = await db.enableAutoIndexForAll();

        // Get all projects that should be auto-indexed
        const projects = await db.getAutoIndexProjects();

        if (projects.length === 0) {
          return { projectsEnabled, indexedFunctions: 0 };
        }

        const codeIndexer = getFantomCodeIndexer();
        const searchIndex = getFantomFunctionSearchIndex();

        for (const project of projects) {
          try {
            const projLang = ((project as unknown as { language?: string }).language || 'fantom').toLowerCase();
            if (projLang !== 'fantom') {
              // Route non-Fantom projects through runIndex so they hit the
              // unified pipeline (tree-sitter + LadybugDB + ApiChange).
              // Sending them to FantomCodeIndexer.indexProject would silently
              // regex-parse TS source and overwrite Prisma stats with garbage
              // 30/1 counts (this regression hit SoundSuite in round 6).
              const { runIndex } = await import('./fantom-code/runIndex.js');
              await runIndex(db, getPrismaClient(), project.id, { trigger: 'admin-reindex' });
              continue;
            }
            const indexerProject: FantomProject = {
              id: project.id,
              name: project.name,
              path: project.path,
              instanceId: project.instanceId,
              podMeta: project.podName ? { podName: project.podName, dependencies: [], srcDirs: ['fan'] } : undefined,
              functionCount: 0,
              typeCount: 0,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt
            };

            const result = await codeIndexer.indexProject(indexerProject);
            await db.updateProjectIndexStats(project.id, result.functionsIndexed, result.typesIndexed);
          } catch (err) {
            // Continue with other projects even if one fails
          }
        }

        // Rebuild FlexSearch index
        searchIndex.rebuild(codeIndexer);

        return { projectsEnabled, indexedFunctions: searchIndex.size };
      },

      rebuildAllGraphs: async () => {
        const prisma = getPrismaClient();
        const { getCodeIndexingService } = await import('./fantom-code/codeIndexingService.js');
        const service = getCodeIndexingService(prisma);
        return service.rebuildAllGraphs();
      },

      // Backup/Restore methods
      createBackup: async (options) => {
        const backupManager = getBackupManager(path.join(getInstallRoot(), 'config'), this.config.cacheDir);
        return backupManager.createBackup(options);
      },

      listBackups: async () => {
        const backupManager = getBackupManager(path.join(getInstallRoot(), 'config'), this.config.cacheDir);
        return backupManager.listBackups();
      },

      getBackup: async (id) => {
        const backupManager = getBackupManager(path.join(getInstallRoot(), 'config'), this.config.cacheDir);
        return backupManager.getBackupInfo(id);
      },

      getBackupPath: async (id) => {
        const backupManager = getBackupManager(path.join(getInstallRoot(), 'config'), this.config.cacheDir);
        return backupManager.getBackupPath(id);
      },

      deleteBackup: async (id) => {
        const backupManager = getBackupManager(path.join(getInstallRoot(), 'config'), this.config.cacheDir);
        return backupManager.deleteBackup(id);
      },

      restoreBackup: async (id, options) => {
        const backupManager = getBackupManager(path.join(getInstallRoot(), 'config'), this.config.cacheDir);
        return backupManager.restoreBackup(id, options);
      },

      // OAuth Token Grant (for auto-authentication)
      getOAuthProvider: () => this.oauthProvider,
    };
  }

  /**
   * Start HTTP server with Express
   */
  private async startHttpServer(): Promise<void> {
    const app = express();
    app.use(express.json());

    // CORS middleware for development (dashboard on different port)
    app.use((req: Request, res: Response, next) => {
      const origin = req.headers.origin;
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, mcp-session-id');
        res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
      next();
    });

    const port = getServerPort();

    // Health check endpoint
    app.get('/health', (_req: Request, res: Response) => {
      const agentHealth = this.agentFramework.orchestration.getStatus();
      const now = Date.now();
      res.json({
        status: 'ok',
        initialized: this.initializationComplete,
        uptime: process.uptime(),
        docsIndexed: this.searchIndex.getStats().totalItems || 0,
        activeSessions: this.httpTransports.size,
        agents: {
          count: 6,
          info: getAgentInfo(),
          totalTools: this.agentFramework.getAllTools().length,
          orchestratorStatus: agentHealth.status,
        },
        // Phased initialization status for monitoring
        initStatus: {
          phase: this.initStatus.phase,
          cacheReady: this.initStatus.cacheReady,
          agentsReady: this.initStatus.agentsReady,
          codeIndexReady: this.initStatus.codeIndexReady,
          docsIndexReady: this.initStatus.docsIndexReady,
          embeddingsReady: this.initStatus.embeddingsReady,
          error: this.initStatus.error,
          timings: {
            cacheLoadMs: this.initStatus.cacheLoadedAt
              ? this.initStatus.cacheLoadedAt - this.initStatus.startTime
              : null,
            agentsReadyMs: this.initStatus.agentsReadyAt
              ? this.initStatus.agentsReadyAt - this.initStatus.startTime
              : null,
            codeIndexMs: this.initStatus.codeIndexReadyAt
              ? this.initStatus.codeIndexReadyAt - this.initStatus.startTime
              : null,
            embeddingsMs: this.initStatus.embeddingsReadyAt
              ? this.initStatus.embeddingsReadyAt - this.initStatus.startTime
              : null,
            elapsedMs: now - this.initStatus.startTime,
          },
        },
      });
    });

    // MCP endpoint - handles POST (messages), GET (SSE stream), DELETE (terminate)
    app.post('/mcp', async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const authHeader = req.headers['authorization'] as string | undefined;
      this.log(`POST /mcp - session: ${sessionId || 'new'}, auth: ${authHeader ? 'present' : 'none'}, body: ${JSON.stringify(req.body).substring(0, 200)}`);

      try {
        // ============================================
        // OAuth Authentication Enforcement
        // ============================================
        if (this.isOAuthRequired()) {
          const authInfo = await this.validateMcpToken(authHeader);

          if (!authInfo) {
            this.log('POST /mcp - OAuth required but no valid token');
            this.sendMcpOAuthChallenge(res, 'invalid_token', 'Valid OAuth token required for MCP access');
            return;
          }

          // Log authenticated user
          this.log(`POST /mcp - Authenticated user: ${authInfo.extra?.userId || 'unknown'}, client: ${authInfo.clientId}`);
        }

        // Check for existing session
        if (sessionId && this.httpTransports.has(sessionId)) {
          const transport = this.httpTransports.get(sessionId)!;
          this.touchMcpSession(sessionId);
          await transport.handleRequest(req, res, req.body);
          return;
        }

        // New session - must be initialize request
        if (!sessionId && isInitializeRequest(req.body)) {
          this.log('New session initialization request');
          const clientInfo = (req.body as { params?: { clientInfo?: { name?: string; version?: string } } })?.params?.clientInfo;
          const initUserId = this.isOAuthRequired()
            ? String((await this.validateMcpToken(authHeader))?.extra?.userId ?? '') || null
            : null;

          // Create a NEW Server instance for this session
          const sessionServer = new Server(
            { name: 'mcp-fantom', version: '1.0.0' },
            { capabilities: { tools: {}, resources: {} } }
          );

          // Set up handlers on this session's server
          this.setupHandlersForServer(sessionServer);

          // Create transport with session callbacks
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid: string) => {
              this.log(`Session initialized: ${sid} client=${clientInfo?.name ?? '?'}@${clientInfo?.version ?? '?'}`);
              this.httpTransports.set(sid, transport);
              this.httpSessions.set(sid, sessionServer);
              const now = Date.now();
              this.httpSessionMeta.set(sid, {
                createdAt: now,
                lastActivity: now,
                clientName: clientInfo?.name ?? null,
                clientVersion: clientInfo?.version ?? null,
                userId: initUserId,
              });
              this.ensureMcpSessionSweep();
            },
          });

          // Handle session close
          transport.onclose = () => {
            const sid = [...this.httpTransports.entries()].find(([_, t]) => t === transport)?.[0];
            if (sid) {
              this.log(`Session closed: ${sid}`);
              this.httpTransports.delete(sid);
              this.httpSessions.delete(sid);
              this.httpSessionMeta.delete(sid);
            }
          };

          // Connect server to transport
          await sessionServer.connect(transport);

          // Handle the initialize request
          await transport.handleRequest(req, res, req.body);
          return;
        }

        // Invalid request
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32600,
            message: 'Bad Request: No valid session ID or not an initialize request',
          },
          id: null,
        });
      } catch (error) {
        console.error('Error handling POST /mcp:', error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          });
        }
      }
    });

    // GET /mcp - SSE stream for server-to-client notifications
    app.get('/mcp', async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const authHeader = req.headers['authorization'] as string | undefined;
      this.log(`GET /mcp - session: ${sessionId || 'none'}, auth: ${authHeader ? 'present' : 'none'}`);

      // OAuth Authentication Enforcement
      if (this.isOAuthRequired()) {
        const authInfo = await this.validateMcpToken(authHeader);
        if (!authInfo) {
          this.log('GET /mcp - OAuth required but no valid token');
          this.sendMcpOAuthChallenge(res, 'invalid_token', 'Valid OAuth token required for MCP SSE stream');
          return;
        }
        this.log(`GET /mcp - Authenticated user: ${authInfo.extra?.userId || 'unknown'}`);
      }

      if (!sessionId || !this.httpTransports.has(sessionId)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Invalid or missing session ID' },
          id: null,
        });
        return;
      }

      const transport = this.httpTransports.get(sessionId)!;
      this.touchMcpSession(sessionId);
      await transport.handleRequest(req, res);
    });

    // DELETE /mcp - terminate session
    app.delete('/mcp', async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const authHeader = req.headers['authorization'] as string | undefined;
      this.log(`DELETE /mcp - session: ${sessionId || 'none'}, auth: ${authHeader ? 'present' : 'none'}`);

      // OAuth Authentication Enforcement
      if (this.isOAuthRequired()) {
        const authInfo = await this.validateMcpToken(authHeader);
        if (!authInfo) {
          this.log('DELETE /mcp - OAuth required but no valid token');
          this.sendMcpOAuthChallenge(res, 'invalid_token', 'Valid OAuth token required to terminate MCP session');
          return;
        }
        this.log(`DELETE /mcp - Authenticated user: ${authInfo.extra?.userId || 'unknown'}`);
      }

      if (!sessionId || !this.httpTransports.has(sessionId)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Invalid or missing session ID' },
          id: null,
        });
        return;
      }

      const transport = this.httpTransports.get(sessionId)!;
      await transport.handleRequest(req, res);
    });

    // Admin API routes (protected by Basic Auth)
    const adminRouter = createAdminRouter(this.createAdminContext());
    app.use('/admin', adminRouter);

    // Retrieval tools for ss-rlm-sandbox. Mounted OUTSIDE the admin router on
    // purpose: /admin is Basic-auth and the sandbox authenticates with a
    // bearer token, so sharing that mount would reject every call. The router
    // carries its own check and refuses everything when no token is
    // configured. See src/admin/rlmToolRoutes.ts.
    const { createRlmToolRouter } = await import('./admin/rlmToolRoutes.js');
    app.use('/api/rlm-tools', createRlmToolRouter());

    // OAuth 2.1 Setup (if OAUTH_ENABLED is set)
    const oauthEnabled = process.env.OAUTH_ENABLED === 'true';
    if (oauthEnabled) {
      this.log('OAuth 2.1 enabled - setting up OAuth routes');
      const prisma = getPrismaClient();
      const userStore = getUserStore(path.join(getInstallRoot(), 'config'));
      const issuerUrl = new URL(`http://localhost:${port}`);

      // Initialize OAuth provider with configurable TTLs (use defaults if not in config)
      this.oauthProvider = new FantomOAuthProvider(prisma, userStore, {
        issuerUrl: issuerUrl.toString(),
        accessTokenTtl: this.config.auth?.accessTokenTtl,    // Falls back to TOKEN_TTL.ACCESS_TOKEN if undefined
        refreshTokenTtl: this.config.auth?.refreshTokenTtl,  // Falls back to TOKEN_TTL.REFRESH_TOKEN if undefined
        authCodeTtl: this.config.auth?.authCodeTtl,          // Falls back to TOKEN_TTL.AUTHORIZATION_CODE if undefined
      });

      // Register MCP OAuth router (handles /authorize, /token, /register, /revoke, /.well-known/*)
      app.use(
        mcpAuthRouter({
          provider: this.oauthProvider,
          issuerUrl,
          scopesSupported: SUPPORTED_SCOPES,
        })
      );

      // Custom login form handler for OAuth authorization flow
      app.use(express.urlencoded({ extended: true }));
      app.post('/oauth/login', async (req: Request, res: Response) => {
        const { auth_id, username, password } = req.body;

        if (!auth_id || !username || !password) {
          const html = renderErrorPage('Invalid Request', 'Missing required fields');
          res.status(400).type('text/html').send(html);
          return;
        }

        const userAgent = req.headers['user-agent'] || undefined;
        const ipAddress = req.ip || req.socket.remoteAddress || undefined;

        const result = await this.oauthProvider!.processAuthorization(
          auth_id,
          username,
          password,
          userAgent,
          ipAddress
        );

        if (result.success) {
          res.redirect(result.redirectUrl);
        } else {
          // Re-render auth page with error
          const html = renderErrorPage('Authentication Failed', result.error);
          res.status(401).type('text/html').send(html);
        }
      });

      // Start token cleanup job
      this.tokenCleanupJob = new TokenCleanupJob(prisma);
      this.tokenCleanupJob.start();

      this.log('OAuth 2.1 routes registered');
    }

    // Live MCP transport sessions (in-memory; one per connected client, per the
    // MCP spec). Distinct from OAuth grants below, which are persisted rows.
    app.get('/admin/mcp/sessions', (_req: Request, res: Response) => {
      const sessions = this.listMcpSessions();
      res.json({ count: sessions.length, idleTimeoutMs: FantomMCPServer.MCP_SESSION_IDLE_MS, sessions });
    });

    // OAuth admin endpoints - always registered so they return 503 when OAuth is disabled
    // instead of 404, allowing the frontend to gracefully handle the disabled state
    app.get('/admin/oauth/sessions', async (_req: Request, res: Response) => {
      if (!this.oauthProvider) {
        res.status(503).json({ error: 'OAuth not enabled' });
        return;
      }
      const sessions = await this.oauthProvider.getSessions();
      res.json({ sessions });
    });

    app.delete('/admin/oauth/sessions/:sessionId', async (req: Request, res: Response) => {
      if (!this.oauthProvider) {
        res.status(503).json({ error: 'OAuth not enabled' });
        return;
      }
      const sessionIdParam = req.params.sessionId as string;
      const success = await this.oauthProvider.revokeSession(sessionIdParam);
      if (success) {
        res.json({ success: true, message: 'Session revoked' });
      } else {
        res.status(404).json({ error: 'Session not found' });
      }
    });

    app.get('/admin/oauth/clients', async (_req: Request, res: Response) => {
      if (!this.oauthProvider) {
        res.status(503).json({ error: 'OAuth not enabled' });
        return;
      }
      const clientsStore = this.oauthProvider.clientsStore as import('./auth/prismaClientsStore.js').PrismaClientsStore;
      const clients = await clientsStore.getAllClients();
      res.json({ clients });
    });

    app.delete('/admin/oauth/clients/:clientId', async (req: Request, res: Response) => {
      if (!this.oauthProvider) {
        res.status(503).json({ error: 'OAuth not enabled' });
        return;
      }
      const clientIdParam = req.params.clientId as string;
      const clientsStore = this.oauthProvider.clientsStore as import('./auth/prismaClientsStore.js').PrismaClientsStore;
      const success = await clientsStore.deleteClient(clientIdParam);
      if (success) {
        // Also revoke all sessions for this client
        await this.oauthProvider.revokeAllSessionsForClient(clientIdParam);
        res.json({ success: true, message: 'Client and sessions revoked' });
      } else {
        res.status(404).json({ error: 'Client not found' });
      }
    });

    app.get('/admin/oauth/stats', async (_req: Request, res: Response) => {
      if (!this.tokenCleanupJob) {
        res.status(503).json({ error: 'OAuth not enabled' });
        return;
      }
      const stats = await this.tokenCleanupJob.getStats();
      res.json(stats);
    });

    // Serve dashboard static files (if built)
    const dashboardPath = path.join(process.cwd(), 'dashboard', 'out');
    // Root redirect: browsers opening http://host:port/ land on the dashboard
    // (or /health when the dashboard has not been built).
    app.get('/', (_req: Request, res: Response) => {
      res.redirect(302, fsSync.existsSync(dashboardPath) ? '/dashboard/' : '/health');
    });
    if (fsSync.existsSync(dashboardPath)) {
      app.use('/dashboard', express.static(dashboardPath));
      // SPA fallback
      app.get('/dashboard{/*path}', (_req: Request, res: Response) => {
        res.sendFile(path.join(dashboardPath, 'index.html'));
      });
    }

    // Start HTTP server
    return new Promise((resolve) => {
      const httpServer = app.listen(port, () => {
        this.log(`StreamableHTTP MCP Server on http://localhost:${port}`);
        this.log(`   MCP endpoint: http://localhost:${port}/mcp`);
        this.log(`   Health check: http://localhost:${port}/health`);
        this.log(`   Admin API: http://localhost:${port}/admin`);
        this.log(`   Sidecar WS: ws://localhost:${port}/ws/sidecars`);
        if (fsSync.existsSync(dashboardPath)) {
          this.log(`   Dashboard: http://localhost:${port}/dashboard`);
        }
        resolve();
      });
      // Attach sidecar WS server (Fantom-native protocol) and Sound Suite
      // master-side handler (so multi-master sidecars can register us).
      void import('./sidecars/wsServer.js').then(m => m.attachSidecarWsServer(httpServer));
      void import('./sidecars/soundsuiteMaster.js').then(m => m.attachSoundSuiteMaster(httpServer, app));
      // Discover OpenRouter-backed "virtual containers". This polls each
      // sidecar's HTTP /api/status rather than mining the WS heartbeat: the
      // heartbeat's statusData is a trimmed snapshot with no `masters` key, so
      // heartbeat-based discovery would silently find nothing forever.
      void import('./sidecars/virtualContainers.js').then(m => m.startVirtualContainerDiscovery());
    });
  }

  /**
   * Run the server - supports both stdio and HTTP transport modes
   */
  async run() {
    const startTime = Date.now();
    const transportMode = process.env.MCP_TRANSPORT || 'stdio';

    if (transportMode === 'http') {
      // HTTP mode: Start HTTP server first, then initialize
      await this.startHttpServer();
      this.log('StreamableHTTP MCP Server started - clients can connect to /mcp');
      this.log('Initialization starting...');
      // Axon: load the tree-sitter grammar up front so the SYNC parse paths
      // (search, the functions/sample-text preview routes) see statement-shaped
      // chunks rather than the line-window fallback. The indexer awaits it
      // separately and refuses to run without it.
      void initAxonGrammar();
      // Axon: optional index run once sidecars registered (no-op unless axon.enabled && autoIndex).
      maybeAxonAutoIndexAtBoot();

      // Run critical initialization (fast), then start background tasks.
      // Do NOT rethrow from the catch: this property is assigned, not awaited,
      // so a rethrow turns into UNHANDLED_REJECTION and crashes the process
      // instead of letting the server limp along with partial functionality.
      this.initializationPromise = this.initialize()
        .then(() => {
          this.initializationComplete = true;
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
          this.log(`Critical initialization complete in ${elapsed}s - server is responsive`);

          // Start all background initialization tasks (code indexing, AST caches, doc caches)
          this.startBackgroundInitialization();
        })
        .catch((error) => {
          this.log(`Initialization error: ${error}`);
          this.log('Server will continue with partial functionality');
          this.initializationComplete = true;
        });

      // Keep the process alive
      await new Promise(() => {});
    } else {
      // STDIO mode: Connect transport FIRST so server can respond to pings immediately
      const transport = new StdioServerTransport();
      await this.server.connect(transport);

      this.log('MCP Server (stdio) connected - ready to accept requests');
      this.log('Initialization continuing in background...');

      // Run critical initialization (fast), then start background tasks.
      // Do NOT rethrow from the catch — see HTTP-mode branch above for why.
      this.initializationPromise = this.initialize()
        .then(() => {
          this.initializationComplete = true;
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
          this.log(`Critical initialization complete in ${elapsed}s - server is responsive`);

          // Start all background initialization tasks (code indexing, AST caches, doc caches)
          this.startBackgroundInitialization();
        })
        .catch((error) => {
          this.log(`Initialization error: ${error}`);
          this.log('Server will continue with partial functionality');
          this.initializationComplete = true;
        });
    }
  }

  /**
   * Handle ListTools request
   */
  private async handleListTools() {
    return {
      tools: [
        {
          name: 'getFantomType',
          description: 'Get detailed information about a specific Fantom type by its qualified name.',
          inputSchema: {
            type: 'object',
            properties: {
              qualifiedName: {
                type: 'string',
                description: 'Qualified type name (e.g., "sys::Str", "inet::HttpClient")',
              },
            },
            required: ['qualifiedName'],
          },
        },
        {
          name: 'listFantomPods',
          description: 'List all available Fantom pods in the indexed documentation.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'migrateSkySpark4x',
          description:
            'Automatically migrate a SkySpark 3.x project from GitLab to 4.0. ' +
            'Clones the repository, creates a 4.0.3 branch, transforms code, generates Xeto specs, ' +
            'validates compilation, and prepares changes for approval before committing.',
          inputSchema: {
            type: 'object',
            properties: {
              gitlabUrl: {
                type: 'string',
                description: 'GitLab SSH URL (e.g., git@gitlab.com:org/project.git)',
              },
              projectName: {
                type: 'string',
                description: 'Project name (will be used as directory name)',
              },
              workDir: {
                type: 'string',
                description: 'Working directory where project will be cloned',
              },
              skysparkBinPath: {
                type: 'string',
                description: 'Path to SkySpark bin directory (e.g., /Users/apple/Downloads/skyspark-4.0.3/bin)',
              },
              dryRun: {
                type: 'boolean',
                description: 'If true, preview changes without committing (default: false)',
                default: false,
              },
            },
            required: ['gitlabUrl', 'projectName', 'workDir', 'skysparkBinPath'],
          },
        },
        {
          name: 'generateFantomCode',
          description:
            'Generate Fantom code including classes, methods, pods, and more. ' +
            'Supports generating complete pod structures, class definitions with fields and methods, ' +
            'mixins, enums, and individual method stubs. Optionally validates generated code.',
          inputSchema: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                description: 'What to generate: "class", "method", "pod", "enum", "mixin"',
                enum: ['class', 'method', 'pod', 'enum', 'mixin'],
              },
              name: {
                type: 'string',
                description: 'Name of the class, method, or pod',
              },
              pod: {
                type: 'string',
                description: 'Pod name (for class/method generation)',
              },
              extends: {
                type: 'string',
                description: 'Parent class name (for classes)',
              },
              mixins: {
                type: 'array',
                description: 'Mixin names (for classes)',
                items: { type: 'string' },
              },
              fields: {
                type: 'array',
                description: 'Field definitions (for classes)',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    type: { type: 'string' },
                    defaultValue: { type: 'string' },
                    isStatic: { type: 'boolean' },
                    isConst: { type: 'boolean' },
                    doc: { type: 'string' },
                  },
                  required: ['name', 'type'],
                },
              },
              methods: {
                type: 'array',
                description: 'Method definitions (for classes)',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    returnType: { type: 'string' },
                    params: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          name: { type: 'string' },
                          type: { type: 'string' },
                          defaultValue: { type: 'string' },
                        },
                        required: ['name', 'type'],
                      },
                    },
                    isStatic: { type: 'boolean' },
                    isAbstract: { type: 'boolean' },
                    isOverride: { type: 'boolean' },
                    doc: { type: 'string' },
                    body: { type: 'string' },
                  },
                  required: ['name'],
                },
              },
              enumValues: {
                type: 'array',
                description: 'Enum value names (for enums)',
                items: { type: 'string' },
              },
              returnType: {
                type: 'string',
                description: 'Return type (for method generation)',
              },
              params: {
                type: 'array',
                description: 'Parameters (for method generation)',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    type: { type: 'string' },
                    defaultValue: { type: 'string' },
                  },
                  required: ['name', 'type'],
                },
              },
              doc: {
                type: 'string',
                description: 'Documentation comment',
              },
              validate: {
                type: 'boolean',
                description: 'Run fan -check validation on generated code (default: false)',
                default: false,
              },
              version: {
                type: 'string',
                description: 'Version for pod generation (default: 1.0.0)',
              },
              description: {
                type: 'string',
                description: 'Description for pod generation',
              },
              depends: {
                type: 'array',
                description: 'Dependencies for pod generation (default: ["sys 1.0"])',
                items: { type: 'string' },
              },
            },
            required: ['type', 'name'],
          },
        },
        {
          name: 'commitMigration',
          description:
            'Commit and push approved migration changes to the 4.0.3 branch. ' +
            'Only call this after reviewing migration results from migrateSkySpark4x.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Full path to the migrated project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'rollbackMigration',
          description:
            'Rollback migration changes and return to pre-migration state. ' +
            'Uses the pre-migration-backup tag.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Full path to the project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        // Fantom Code Search Tools
        {
          name: 'searchFantomCode',
          description:
            'Search indexed Fantom source code for functions, methods, and fields. ' +
            'Searches across all configured Fantom projects including classes, methods, fields, and constructors. ' +
            'Results include podName, instanceName, and instanceType when available.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query (e.g., "connect", "HttpClient", "read")',
              },
              projectId: {
                type: 'number',
                description: 'Filter by project ID',
              },
              projectName: {
                type: 'string',
                description: 'Alternative to projectId — exact name match',
              },
              instanceId: {
                type: 'number',
                description: 'Filter by Fantom instance ID (returns only projects linked to this instance)',
              },
              podId: {
                type: 'number',
                description: 'Filter by specific pod/project ID',
              },
              category: {
                type: 'string',
                description: 'Filter by category',
                enum: Object.values(FantomCategory),
              },
              className: {
                type: 'string',
                description: 'Filter by class name',
              },
              type: {
                type: 'string',
                description: 'Filter by function type',
                enum: ['method', 'field', 'constructor'],
              },
              isPublic: {
                type: 'boolean',
                description: 'Filter by visibility (true = public only)',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of results (default: 20)',
                default: 20,
              },
              compatibleWith: {
                type: 'string',
                description: 'Filter to code from pods compatible with this version (e.g., "3.1.12")',
              },
              dedupBy: {
                type: 'string',
                enum: ['none', 'qualifiedName', 'qualifiedNameSignature'],
                description: 'Collapse duplicate hits (default: qualifiedNameSignature). Bundled/vendored code can produce the same logical symbol from multiple file paths; this collapses them.',
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'getFantomFunction',
          description:
            'Get detailed information about a specific Fantom function by its qualified name or ID.',
          inputSchema: {
            type: 'object',
            properties: {
              qualifiedName: {
                type: 'string',
                description: 'Qualified name (e.g., "myPod::MyClass.myMethod")',
              },
              id: {
                type: 'string',
                description: 'Function ID (alternative to qualifiedName)',
              },
            },
          },
        },
        {
          name: 'listFunctionsInFile',
          description: 'List every symbol in a file ordered by line. Pass atTime (ISO timestamp) to snapshot the file state at a past moment.',
          inputSchema: {
            type: 'object',
            properties: {
              filePath: { type: 'string', description: 'Absolute file path' },
              projectId: { type: 'number' },
              atTime: { type: 'string', description: 'ISO timestamp for time-travel' },
              limit: { type: 'number' },
              offset: { type: 'number' },
            },
            required: ['filePath'],
          },
        },
        {
          name: 'getCodeNeighbors',
          description: 'Get N preceding + N following symbols around a named anchor in the same file. With atTime, returns historical neighbors.',
          inputSchema: {
            type: 'object',
            properties: {
              qualifiedName: { type: 'string' },
              projectId: { type: 'number' },
              atTime: { type: 'string' },
              count: { type: 'number' },
            },
            required: ['qualifiedName'],
          },
        },
        {
          name: 'searchProjects',
          description:
            'Find projects by query. Scores name (highest), path, podName, description and returns the top hits. Use this when you know the project name but not the id — faster than paging through listFantomProjects. Optional filters: language, instanceId, hasGraphData (only projects with LadybugDB nodes), minFunctions.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Substring to score against name/path/podName/description. Empty query returns recent projects sorted by lastIndexed.' },
              language: { type: 'string', description: 'Exact language match (e.g. "typescript")' },
              instanceId: { type: 'number', description: 'Filter to one instance' },
              hasGraphData: { type: 'boolean', description: 'Only projects with >0 LadybugDB nodes' },
              minFunctions: { type: 'number', description: 'Skip projects with fewer than N indexed functions' },
              limit: { type: 'number', description: 'Max results (default 20, max 100)' },
            },
          },
        },
        {
          name: 'getIndexHealth',
          description: 'Audit a project across all four stores (Prisma, LadybugDB, LanceDB, FlexSearch). Returns counts + diffs + warnings. Run after addFantomProject or refreshFantomProject to verify the indexer pipeline is healthy.',
          inputSchema: {
            type: 'object',
            properties: {
              projectId: { type: 'number', description: 'Project ID' },
              projectName: { type: 'string', description: 'Project name (alternative to projectId)' },
            },
          },
        },
        {
          name: 'listFantomProjects',
          description:
            'List indexed projects (paged). Default returns 50 compact rows so responses fit under the MCP token cap. Use nameContains/pathContains/language/instanceId/compatibleWith to narrow; offset+limit to page; compact:false for the full record (path, description, timestamps).',
          inputSchema: {
            type: 'object',
            properties: {
              compatibleWith: {
                type: 'string',
                description: 'Filter to projects from instances compatible with this version (e.g., "3.1.12")',
              },
              limit: { type: 'number', description: 'Max rows (default 50, max 500)' },
              offset: { type: 'number', description: 'Pagination offset (default 0)' },
              pathContains: { type: 'string', description: 'Case-insensitive substring match on path' },
              nameContains: { type: 'string', description: 'Case-insensitive substring match on name' },
              language: { type: 'string', description: 'Exact language match (e.g. "typescript")' },
              instanceId: { type: 'number', description: 'Filter to one instance' },
              compact: { type: 'boolean', description: 'Compact projection (default true). Set false for full record.' },
            },
          },
        },
        {
          name: 'addFantomProject',
          description:
            'Add a new Fantom project to index. The project will be automatically indexed.',
          inputSchema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Project name',
              },
              path: {
                type: 'string',
                description: 'Full path to the project directory',
              },
              instanceId: {
                type: 'number',
                description: 'Associated Fantom instance ID (optional)',
              },
              podName: {
                type: 'string',
                description: 'Pod name (optional, auto-detected from build.fan)',
              },
              description: {
                type: 'string',
                description: 'Project description (optional)',
              },
              autoIndex: {
                type: 'boolean',
                description: 'Auto-index on startup (default: true)',
                default: true,
              },
              language: {
                type: 'string',
                enum: [
                  'fantom', 'trio', 'axon', 'xeto',
                  'typescript', 'javascript', 'python', 'java', 'kotlin',
                  'scala', 'go', 'rust', 'c', 'cpp', 'csharp', 'ruby',
                  'php', 'swift', 'dart', 'html', 'css', 'vue', 'json',
                ],
                description: 'Source language. Defaults to "fantom". Set to "typescript", "python", etc. for non-Fantom projects so the multi-language scanner picks up the right file extensions.',
              },
              parserType: {
                type: 'string',
                enum: ['regex', 'tree-sitter', 'tree-sitter-wasm'],
                description: 'Parser to use. Defaults to "regex" (suitable for Fantom). Use "tree-sitter-wasm" for non-Fantom languages.',
              },
            },
            required: ['name', 'path'],
          },
        },
        {
          name: 'refreshFantomProject',
          description:
            'Re-index a specific Fantom project to pick up code changes.',
          inputSchema: {
            type: 'object',
            properties: {
              projectId: {
                type: 'number',
                description: 'Project ID to re-index',
              },
              projectName: {
                type: 'string',
                description: 'Project name (alternative to projectId)',
              },
            },
          },
        },
        {
          name: 'getFantomCodeStats',
          description:
            'Get statistics about the Fantom code index including function counts by category and project.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'removeFantomProject',
          description:
            'Fully remove a project. Drops the FantomProject row plus all derived data: LadybugDB nodes/edges, LanceDB vectors, in-memory FlexSearch entries, and (via cascade) IndexedFile/IndexRun/ApiChange rows. Pass projectId or projectName.',
          inputSchema: {
            type: 'object',
            properties: {
              projectId: { type: 'number' },
              projectName: { type: 'string', description: 'Alternative to projectId' },
            },
          },
        },
        {
          name: 'clearProjectIndex',
          description:
            'Clear a project\'s derived data (graph, vectors, in-memory index, IndexedFile hash cache) but keep the registration row. Used when the project path is right but the index is polluted (e.g. excludePatterns missed a directory). After clear, re-index to repopulate.',
          inputSchema: {
            type: 'object',
            properties: {
              projectId: { type: 'number' },
              projectName: { type: 'string', description: 'Alternative to projectId' },
            },
          },
        },
        {
          name: 'reindexChangedFiles',
          description:
            'Re-index a specific set of files within a project after edits. Faster than refreshFantomProject — only the listed paths get re-parsed, their graph nodes rebuilt, AND those nodes re-embedded so semantic search immediately reflects the edit. Call this after every code change to keep the index live. Returns runId, addedCount, modifiedCount, removedCount, embeddedCount. If projectId is omitted, the server resolves it by matching the paths against the longest project.path prefix; pass projectId explicitly when paths could ambiguously match multiple projects.',
          inputSchema: {
            type: 'object',
            properties: {
              paths: {
                type: 'array',
                items: { type: 'string' },
                description: 'Absolute paths of files just edited.',
              },
              projectId: {
                type: 'number',
                description: 'Optional. Auto-resolved from path prefix when omitted.',
              },
            },
            required: ['paths'],
          },
        },
        {
          name: 'whatChangedRecently',
          description: 'Convenience wrapper: what changed in this project in the last N hours? Returns ApiChange events grouped by file. Default 24h. Optional kind filter.',
          inputSchema: {
            type: 'object',
            properties: {
              projectId: { type: 'number' },
              projectName: { type: 'string' },
              hoursAgo: { type: 'number' },
              kind: { type: 'string', enum: ['added', 'modified', 'removed'] },
            },
          },
        },
        {
          name: 'getSymbolHistory',
          description: 'Full timeline for one symbol — every add/modify/remove event with before/after signatures, plus summary (firstSeen, lastModified, modifyCount, signatureChurn).',
          inputSchema: {
            type: 'object',
            properties: {
              qualifiedName: { type: 'string' },
              projectId: { type: 'number' },
              since: { type: 'string' },
              until: { type: 'string' },
            },
            required: ['qualifiedName'],
          },
        },
        {
          name: 'diffByTime',
          description: 'Diff between two timestamps (ISO or -7d/-24h shorthand). Optional scope: file:<path>, symbol:<qn>, class:<qn-prefix>.',
          inputSchema: {
            type: 'object',
            properties: {
              projectId: { type: 'number' },
              projectName: { type: 'string' },
              from: { type: 'string' },
              to: { type: 'string' },
              scope: { type: 'string' },
            },
            required: ['from', 'to'],
          },
        },
        {
          name: 'getActivitySummary',
          description: 'Aggregate stats over a time window — totalRuns, totalChanges, byChangeType, byKind, hottestFiles[10], hottestSymbols[10], histogram by hour|day|week.',
          inputSchema: {
            type: 'object',
            properties: {
              projectId: { type: 'number' },
              projectName: { type: 'string' },
              since: { type: 'string' },
              until: { type: 'string' },
              granularity: { type: 'string', enum: ['hour', 'day', 'week'] },
            },
          },
        },
        {
          name: 'compareSnapshots',
          description: 'Paginated qualifiedNames diff between two timestamps. Stream large diffs via cursor + pageSize.',
          inputSchema: {
            type: 'object',
            properties: {
              projectId: { type: 'number' },
              projectName: { type: 'string' },
              from: { type: 'string' },
              to: { type: 'string' },
              cursor: { type: 'string' },
              pageSize: { type: 'number' },
              section: { type: 'string', enum: ['added', 'modified', 'removed', 'all'] },
            },
            required: ['from', 'to'],
          },
        },
        {
          name: 'explainSymbolChange',
          description: 'Heuristic explanation of a single ApiChange event with siblings.',
          inputSchema: {
            type: 'object',
            properties: {
              qualifiedName: { type: 'string' },
              runId: { type: 'number' },
            },
            required: ['qualifiedName', 'runId'],
          },
        },
        {
          name: 'listIndexRuns',
          description:
            'List recent indexing runs. Each run records added/modified/removed counts plus duration so you can debug API drift over time. Filter by projectId, time window, or trigger.',
          inputSchema: {
            type: 'object',
            properties: {
              projectId: { type: 'number', description: 'Filter to one project (optional)' },
              since: { type: 'string', description: 'ISO timestamp lower bound on startedAt' },
              until: { type: 'string', description: 'ISO timestamp upper bound on startedAt' },
              trigger: { type: 'string', enum: ['manual', 'auto', 'watch', 'mcp', 'mcp-add', 'mcp-refresh', 'mcp-incremental', 'admin-reindex', 'file-watch'] },
              limit: { type: 'number', description: 'Default 50, max 500' },
            },
          },
        },
        {
          name: 'getApiChangeHistory',
          description:
            'Flat list of recorded API changes. The qualifiedName filter lets you trace one symbol over time (every add/modify/remove for it).',
          inputSchema: {
            type: 'object',
            properties: {
              projectId: { type: 'number' },
              qualifiedName: {
                type: 'string',
                description: 'Exact qualified name (e.g. "myPod::MyClass.myMethod")',
              },
              kind: { type: 'string', enum: ['function', 'type', 'field'] },
              changeType: { type: 'string', enum: ['added', 'modified', 'removed'] },
              since: { type: 'string' },
              until: { type: 'string' },
              limit: { type: 'number', description: 'Default 100, max 1000' },
            },
          },
        },
        {
          name: 'diffIndexRuns',
          description:
            'Aggregate added/modified/removed symbols between two runs (or two timestamps) for one project. Collapses churn (modify+remove on same symbol = removed) and returns net delta with before/after signatures.',
          inputSchema: {
            type: 'object',
            properties: {
              projectId: { type: 'number' },
              fromRunId: { type: 'number' },
              toRunId: { type: 'number' },
              fromTime: { type: 'string', description: 'ISO; alternative to fromRunId' },
              toTime: { type: 'string', description: 'ISO; defaults to now' },
            },
            required: ['projectId'],
          },
        },
        {
          name: 'listCompatiblePods',
          description:
            'List pods/projects compatible with a specific SkySpark/Haxall version. ' +
            'Returns all pods from instances that are compatible with (version <= target version).',
          inputSchema: {
            type: 'object',
            properties: {
              version: {
                type: 'string',
                description: 'Version to check compatibility (e.g., "3.1.12")',
              },
              instanceType: {
                type: 'string',
                description: 'Filter by instance type',
                enum: ['skyspark', 'haxall', 'fantom'],
              },
            },
            required: ['version'],
          },
        },
        // Local Documentation Tools
        {
          name: 'searchLocalDocs',
          description:
            'Search local SkySpark/Fantom documentation by instance. ' +
            'Searches indexed HTML documentation from the doc/ or var/doc/ folders. ' +
            'Can filter by specific instance ID or by instance type (skyspark, haxall, fantom).',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query (e.g., "Bool", "abs", "readAll")',
              },
              instanceId: {
                type: 'number',
                description: 'Instance ID to search (optional, searches all if not specified)',
              },
              instanceType: {
                type: 'string',
                description: 'Filter by instance type (e.g., search all SkySpark instances)',
                enum: ['skyspark', 'haxall', 'fantom'],
              },
              pod: {
                type: 'string',
                description: 'Filter by pod name (e.g., "sys", "lib-axon")',
              },
              type: {
                type: 'string',
                description: 'Filter by item type',
                enum: ['type', 'function', 'tag', 'slot', 'chapter'],
              },
              language: {
                type: 'string',
                description: 'Filter by language',
                enum: ['fantom', 'axon'],
              },
              limit: {
                type: 'number',
                description: 'Maximum number of results (default: 20)',
                default: 20,
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'indexInstanceDocs',
          description:
            'Index or refresh local documentation for a SkySpark/Fantom instance. ' +
            'Parses HTML files from the doc/ or var/doc/ folder and caches results.',
          inputSchema: {
            type: 'object',
            properties: {
              instanceId: {
                type: 'number',
                description: 'Instance ID to index',
              },
              pods: {
                type: 'array',
                items: { type: 'string' },
                description: 'Specific pods to index (indexes all if empty)',
              },
              forceRefresh: {
                type: 'boolean',
                description: 'Force re-indexing even if cached (default: false)',
                default: false,
              },
            },
            required: ['instanceId'],
          },
        },
        {
          name: 'listLocalPods',
          description:
            'List available documentation pods for a SkySpark/Fantom instance. ' +
            'Returns pods found in the doc/ or var/doc/ folder with file counts.',
          inputSchema: {
            type: 'object',
            properties: {
              instanceId: {
                type: 'number',
                description: 'Instance ID',
              },
            },
            required: ['instanceId'],
          },
        },
        {
          name: 'getLocalDocStatus',
          description:
            'Get documentation indexing status for an instance. ' +
            'Shows cache status, item count, and last indexed time.',
          inputSchema: {
            type: 'object',
            properties: {
              instanceId: {
                type: 'number',
                description: 'Instance ID',
              },
            },
            required: ['instanceId'],
          },
        },
        // Semantic Code Search (LanceDB vector search)
        {
          name: 'semanticCodeSearch',
          description:
            'Search code using natural language. Uses AI embeddings to find semantically similar functions, ' +
            'methods, and types. Best for conceptual queries like "functions that handle HTTP requests" ' +
            'or "error handling for database connections". Results include similarity scores and graph context. ' +
            'Use this when keyword search (searchFantomCode) is too literal.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Natural language search query' },
              projectId: { type: 'number', description: 'Filter by project ID' },
              projectName: { type: 'string', description: 'Alternative to projectId — exact name match' },
              nodeType: { type: 'string', description: 'Filter by node type (function, method, type)' },
              limit: { type: 'number', description: 'Max results (default: 10)', default: 10 },
            },
            required: ['query'],
          },
        },
        // Ask Codebase (RLM grounded Q&A)
        {
          name: 'askCodebase',
          description:
            'Ask a natural-language question about the codebase and get an intelligent, cited answer ' +
            'synthesized from semantic search, the call graph, and change history. ' +
            'Best for "how does X work", "what changed in Y", or "where is Z handled" questions ' +
            'where you want a synthesized explanation rather than a raw result list.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Natural language question about the codebase' },
              projectId: { type: 'number', description: 'Filter by project ID' },
              useRlm: { type: 'boolean', description: 'Run the RLM investigation loop (tool calls over search + call graph) before answering. Default true: deeper, cited answers, typically 60–120s. false answers from retrieval only (~20–40s).' },
              useReranker: { type: 'boolean', description: 'Cross-encoder rerank of retrieved candidates (default true; routed to local GPU or OpenRouter per policy). false keeps the fused vector+keyword order.' },
            },
            required: ['query'],
          },
        },
        // Axon MCP server integration (src/axon/axonTools.ts)
        ...AXON_TOOL_DEFINITIONS,
        // Find Similar Code
        {
          name: 'findSimilarCode',
          description:
            'Find code similar to a given function or method. Uses vector embeddings to find semantically similar ' +
            'code across the indexed codebase. Useful for finding duplicate logic, alternative implementations, ' +
            'or patterns similar to a known function.',
          inputSchema: {
            type: 'object',
            properties: {
              qualifiedName: { type: 'string', description: 'Qualified name of the function to find similar code for (e.g., "myPod::MyType.myMethod")' },
              nodeId: { type: 'string', description: 'Node ID (alternative to qualifiedName)' },
              projectId: { type: 'number', description: 'Filter by project ID' },
              projectName: { type: 'string', description: 'Alternative to projectId — exact name match' },
              limit: { type: 'number', description: 'Max results (default: 5)', default: 5 },
            },
          },
        },
        // Graph Navigation: Get Callers
        {
          name: 'getCallers',
          description:
            'Find all functions that call a given function. Traverses the call graph to show who depends on ' +
            'this code. Useful for understanding usage patterns and impact before refactoring.',
          inputSchema: {
            type: 'object',
            properties: {
              qualifiedName: { type: 'string', description: 'Qualified name of the function (e.g., "myPod::MyType.myMethod")' },
              nodeId: { type: 'string', description: 'Node ID (alternative to qualifiedName)' },
              projectId: { type: 'number', description: 'Project ID to scope the lookup' },
              projectName: { type: 'string', description: 'Alternative to projectId — exact name match' },
              maxDepth: { type: 'number', description: 'Max call chain depth (default: 5)', default: 5 },
            },
          },
        },
        // Graph Navigation: Get Callees
        {
          name: 'getCallees',
          description:
            'Find all functions called by a given function. Traverses the call graph to show dependencies. ' +
            'Useful for understanding what a function relies on and its transitive dependencies.',
          inputSchema: {
            type: 'object',
            properties: {
              qualifiedName: { type: 'string', description: 'Qualified name of the function (e.g., "myPod::MyType.myMethod")' },
              nodeId: { type: 'string', description: 'Node ID (alternative to qualifiedName)' },
              projectId: { type: 'number', description: 'Project ID to scope the lookup' },
              projectName: { type: 'string', description: 'Alternative to projectId — exact name match' },
              maxDepth: { type: 'number', description: 'Max call chain depth (default: 5)', default: 5 },
            },
          },
        },
        // Graph Navigation: Code Impact Analysis
        {
          name: 'getCodeImpact',
          description:
            'Analyze the blast radius of changing a function. Shows all code that would be affected by a change, ' +
            'broken down by relationship type (callers, inheritance, containment). Use before refactoring to ' +
            'understand risk.',
          inputSchema: {
            type: 'object',
            properties: {
              qualifiedName: { type: 'string', description: 'Qualified name of the function to analyze (e.g., "myPod::MyType.myMethod")' },
              nodeId: { type: 'string', description: 'Node ID (alternative to qualifiedName)' },
              projectId: { type: 'number', description: 'Project ID to scope the analysis' },
              projectName: { type: 'string', description: 'Alternative to projectId — exact name match' },
              maxDepth: { type: 'number', description: 'Max traversal depth (default: 10)', default: 10 },
            },
          },
        },
        // Versioned API Search Tool
        {
          name: 'searchVersionedApi',
          description:
            'Unified version-aware search across API docs, source code, and code samples. ' +
            'Supports strict version filtering - when invoked with version context (explicit version or instanceId), ' +
            'results are filtered to that exact version. Use this for version-specific API lookups.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query (e.g., "readAll", "HttpClient", "Bool.and")',
              },
              mode: {
                type: 'string',
                enum: ['api', 'code', 'samples', 'all'],
                default: 'all',
                description: 'Search modality: api (docs), code (AST), samples (examples), or all',
              },
              version: {
                type: 'string',
                description: 'Explicit version override (e.g., "3.1.12", "4.0.3")',
              },
              instanceId: {
                type: 'number',
                description: 'Instance ID to derive version from (alternative to explicit version)',
              },
              sources: {
                type: 'array',
                items: {
                  type: 'string',
                  enum: ['local', 'fantom-source'],
                },
                description: 'Filter by documentation sources (default: all)',
              },
              pod: {
                type: 'string',
                description: 'Filter by pod name',
              },
              type: {
                type: 'string',
                enum: ['type', 'slot', 'function', 'method', 'field', 'tag', 'example', 'guide'],
                description: 'Filter by element type',
              },
              language: {
                type: 'string',
                enum: ['fantom', 'axon'],
                description: 'Filter by language',
              },
              limit: {
                type: 'number',
                default: 10,
                minimum: 1,
                maximum: 50,
                description: 'Maximum number of results (default: 10, max: 50)',
              },
              includeDeprecated: {
                type: 'boolean',
                default: false,
                description: 'Include deprecated items in results',
              },
            },
            required: ['query'],
          },
        },
        // Agent tools removed from MCP listing - still available via admin dashboard explorer
      ],
    };
  }

  /**
   * Handle CallTool request
   */
  private async handleCallTool(request: any, extra?: any) {
    const { name, arguments: args } = request.params;
    const startTime = Date.now();

    // Helper to track tool call
    const trackTool = async (success: boolean, errorMessage?: string) => {
      try {
        const tracker = getUsageTracker();
        await tracker.trackToolCall({
          toolName: name,
          timestamp: new Date(),
          durationMs: Date.now() - startTime,
          success,
          errorMessage,
          sessionId: (request as any).sessionId,
        });
      } catch (e) {
        // Don't fail the tool call if tracking fails
        this.log(`Failed to track tool call: ${e}`);
      }
    };

    try {
      switch (name) {
        case 'getFantomType': {
          const { qualifiedName } = args as { qualifiedName: string };

          this.log(`Getting type: ${qualifiedName}`);

          // Search for exact match
          const results = await this.searchIndex.search(qualifiedName, 10);
          const exactMatch = results.find(
            (r) => r.item.qualifiedName === qualifiedName || r.item.name === qualifiedName
          );

          if (!exactMatch) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ error: `Type not found: ${qualifiedName}` }, null, 2),
                },
              ],
            };
          }

          // Get related slots
          const slots = await this.searchIndex.search(exactMatch.item.name, 50);
          const relatedSlots = slots
            .filter((r) => r.item.type === 'slot' && r.item.parent === exactMatch.item.name)
            .slice(0, 20);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    type: exactMatch.item,
                    slots: relatedSlots.map((r) => ({
                      name: r.item.name,
                      signature: r.item.signature,
                      description: r.item.description,
                    })),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'listFantomPods': {
          // Enhanced pod listing with instance, version, and meaningful counts
          interface PodInfo {
            name: string;
            source: 'cache' | 'database' | 'cache+database';
            counts: {
              docItems: number;    // Documentation items (from search index or DocIndex)
              functions: number;   // Functions indexed from source code
              types: number;       // Types indexed from source code
            };
            instance?: {
              id: number;
              name: string;
              type: 'fantom' | 'skyspark' | 'haxall';
              version?: string;
            };
            compatMinVersion?: string;
            compatMaxVersion?: string;
          }

          const podMap = new Map<string, PodInfo>();

          // 1. Get pods from cached Fantom documentation search index
          const stats = this.searchIndex.getStats();
          for (const [name, count] of Object.entries(stats.byPod)) {
            podMap.set(name, {
              name,
              source: 'cache',
              counts: { docItems: count, functions: 0, types: 0 }
            });
          }

          // 2. Get pods from database with instance info AND counts from DocIndex/FantomProject
          try {
            const db = getFantomDatabase();
            await db.initialize();
            const dbPods = await db.getAllPodsWithCounts();
            for (const pod of dbPods) {
              const existing = podMap.get(pod.name);
              if (existing) {
                // Merge: mark as both sources, add database counts
                existing.source = 'cache+database';
                existing.instance = pod.instance;
                existing.compatMinVersion = pod.compatMinVersion;
                existing.compatMaxVersion = pod.compatMaxVersion;
                // Add database counts (DocIndex docItems, FantomProject functions/types)
                existing.counts.docItems = Math.max(existing.counts.docItems, pod.counts.docItems);
                existing.counts.functions = pod.counts.functions;
                existing.counts.types = pod.counts.types;
              } else {
                podMap.set(pod.name, {
                  name: pod.name,
                  source: 'database',
                  counts: pod.counts,
                  instance: pod.instance,
                  compatMinVersion: pod.compatMinVersion,
                  compatMaxVersion: pod.compatMaxVersion,
                });
              }
            }
          } catch (dbErr) {
            this.log(`Could not get database pods: ${dbErr}`);
          }

          // Sort by total items (docItems + functions + types), then by name
          const pods = Array.from(podMap.values())
            .sort((a, b) => {
              const totalA = a.counts.docItems + a.counts.functions + a.counts.types;
              const totalB = b.counts.docItems + b.counts.functions + b.counts.types;
              if (totalB !== totalA) return totalB - totalA;
              return a.name.localeCompare(b.name);
            });

          // Include active project context for LLM guidance
          const activeProject = this.primaryContext ? {
            instance: this.primaryContext.instance,
            project: this.primaryContext.project,
            note: 'Search database pods matching this instance for project-specific code'
          } : null;

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  activeProject,
                  pods,
                  legend: {
                    source: {
                      'cache': 'From cached documentation',
                      'database': 'User/project pods stored in database',
                      'cache+database': 'Pod exists in both cache and database'
                    },
                    counts: {
                      docItems: 'Documentation items (types, slots, guides) - use searchFantomDocs',
                      functions: 'Functions/methods indexed from source code - use searchFantomFunctions',
                      types: 'Types (classes, mixins, enums) indexed from source code'
                    }
                  }
                }, null, 2),
              },
            ],
          };
        }

        case 'generateFantomCode': {
          const { type, name: genName, validate: shouldValidate = false, ...options } = args as any;

          this.log(`Generating Fantom ${type}: ${genName}`);

          let code = '';
          let files: Record<string, string> = {};
          let structure = '';

          try {
            switch (type) {
              case 'class':
                code = generateClass({
                  name: genName,
                  pod: options.pod,
                  extends: options.extends,
                  mixins: options.mixins,
                  fields: options.fields,
                  methods: options.methods,
                  facets: options.facets,
                  isAbstract: options.isAbstract,
                  doc: options.doc,
                });
                break;

              case 'mixin':
                code = generateClass({
                  name: genName,
                  pod: options.pod,
                  mixins: options.mixins,
                  fields: options.fields,
                  methods: options.methods,
                  facets: options.facets,
                  isMixin: true,
                  doc: options.doc,
                });
                break;

              case 'enum':
                code = generateClass({
                  name: genName,
                  pod: options.pod,
                  isEnum: true,
                  enumValues: options.enumValues,
                  doc: options.doc,
                });
                break;

              case 'method':
                code = generateMethod({
                  name: genName,
                  returnType: options.returnType,
                  params: options.params,
                  isStatic: options.isStatic,
                  isAbstract: options.isAbstract,
                  isOverride: options.isOverride,
                  doc: options.doc,
                  body: options.body,
                });
                break;

              case 'pod':
                const podResult = await generatePod({
                  name: genName,
                  version: options.version,
                  description: options.description,
                  depends: options.depends,
                });
                files = podResult.files;
                structure = podResult.structure;
                break;

              default:
                throw new Error(`Unknown generation type: ${type}`);
            }

            // Validate if requested and not a pod
            let validationResult;
            if (shouldValidate && code) {
              validationResult = await validateFantomCode(code);
            }

            // Format response
            const response: any = {
              success: true,
              type,
              name: genName,
            };

            if (type === 'pod') {
              response.files = files;
              response.structure = structure;
              response.message = `Pod structure generated. Use these files to create your pod.`;
            } else {
              response.code = code;
              response.message = `Generated ${type} '${genName}' successfully.`;
            }

            if (validationResult) {
              response.validation = {
                valid: validationResult.valid,
                errors: validationResult.errors,
              };
            }

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(response, null, 2),
                },
              ],
            };
          } catch (error: any) {
            this.log(`Code generation failed: ${error}`);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      success: false,
                      error: error.message || String(error),
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
        }

        case 'migrateSkySpark4x': {
          const { gitlabUrl, projectName, workDir, skysparkBinPath, dryRun = false } = args as {
            gitlabUrl: string;
            projectName: string;
            workDir: string;
            skysparkBinPath: string;
            dryRun?: boolean;
          };

          this.log(`Starting SkySpark 4.x migration for ${projectName}...`);

          const migrationConfig: MigrationConfig = {
            gitlabUrl,
            projectName,
            workDir,
            libPrefix: 'akbin',
            skysparkBinPath,
            dryRun,
          };

          const migrator = new SkySpark4xMigrator(migrationConfig);
          const result = await migrator.migrate();

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: result.success,
                    branch: result.branch,
                    summary: result.summary,
                    filesChanged: result.filesChanged,
                    filesCreated: result.filesCreated,
                    compilationSuccess: result.compilationSuccess,
                    errors: result.errors,
                    warnings: result.warnings,
                    nextSteps: result.success
                      ? [
                          'Review the changes in the project directory',
                          'Check the compilation output above',
                          'If satisfied, call commitMigration to push changes',
                          'Otherwise, call rollbackMigration to undo changes',
                        ]
                      : [
                          'Review the errors above',
                          'Fix issues manually if needed',
                          'Consider calling rollbackMigration to start over',
                        ],
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'commitMigration': {
          const { projectPath } = args as { projectPath: string };

          if (!projectPath) {
            await trackTool(false, 'projectPath is required');
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'projectPath is required. No active migration to commit.' }, null, 2) }],
              isError: true,
            };
          }

          this.log(`Committing migration for ${projectPath}...`);

          const migrator = new SkySpark4xMigrator({
            gitlabUrl: '',
            projectName: '',
            workDir: projectPath,
            libPrefix: 'akbin',
            skysparkBinPath: '',
          });

          await migrator.commitAndPush();

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    message: 'Migration committed and pushed to origin/4.0.3',
                    nextSteps: [
                      'Create a merge request in GitLab',
                      'Review changes with team',
                      'Merge to main after approval',
                    ],
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'rollbackMigration': {
          const { projectPath } = args as { projectPath: string };

          if (!projectPath) {
            await trackTool(false, 'projectPath is required');
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'projectPath is required. No active migration to rollback.' }, null, 2) }],
              isError: true,
            };
          }

          this.log(`Rolling back migration for ${projectPath}...`);

          const migrator = new SkySpark4xMigrator({
            gitlabUrl: '',
            projectName: '',
            workDir: projectPath,
            libPrefix: 'akbin',
            skysparkBinPath: '',
          });

          await migrator.rollback();

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    message: 'Migration rolled back successfully',
                    note: 'Project returned to pre-migration state',
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // Fantom Code Search Tools
        case 'semanticSearchFantomCode': {
          const {
            query,
            projectId: pidIn,
            projectName,
            limit = 10,
            minScore,
            includeGraphContext,
            useCrossEncoder,
            useLLMRerank,
          } = args as {
            query: string;
            projectId?: number;
            projectName?: string;
            limit?: number;
            minScore?: number;
            includeGraphContext?: boolean;
            useCrossEncoder?: boolean;
            useLLMRerank?: boolean;
          };

          if (!query) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'query is required' }) }] };
          }

          const { getPrismaClient } = await import('./db/prisma.js');
          const { resolveProjectId } = await import('./utils/dbBootstrap.js');
          const { getSemanticSearchService } = await import('./embedding/semanticSearchService.js');

          const prisma = getPrismaClient();
          const pid = await resolveProjectId(prisma as any, { projectId: pidIn, projectName });
          const svc = getSemanticSearchService(prisma);

          const settings = this.createAdminContext().getSettings();
          const sem = (settings.semanticSearch as any) ?? {};
          const xeServer = sem.crossEncoderReranker;
          const llmServer = sem.llmReranker;
          const topProvider = settings.llmProviders?.defaultProvider;

          const results = await (svc as any).search(query, {
            projectId: pid,
            limit,
            minScore: minScore ?? sem.minScore,
            includeGraphContext: includeGraphContext ?? sem.includeGraphContext,
            crossEncoderReranker: (useCrossEncoder ?? xeServer?.enabled)
              ? { enabled: true, model: xeServer?.model, topK: xeServer?.topK }
              : undefined,
            llmReranker: (useLLMRerank ?? llmServer?.enabled)
              ? {
                  enabled: true,
                  provider: llmServer?.provider ?? topProvider,
                  model: llmServer?.model,
                  topK: llmServer?.topK,
                  fromSidecar: llmServer?.fromSidecar,
                }
              : undefined,
          });

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                query,
                projectId: pid,
                count: Array.isArray(results) ? results.length : 0,
                results,
              }, null, 2),
            }],
          };
        }

        case 'searchFantomCode': {
          const { query, projectId: pidIn, projectName, instanceId, podId, category, className, type: funcType, isPublic, limit = 20, compatibleWith, dedupBy = 'qualifiedNameSignature' } = args as {
            query: string;
            projectId?: number;
            projectName?: string;
            instanceId?: number;
            podId?: number;
            category?: string;
            className?: string;
            type?: string;
            isPublic?: boolean;
            limit?: number;
            compatibleWith?: string;
            dedupBy?: 'none' | 'qualifiedName' | 'qualifiedNameSignature';
          };
          const { resolveProjectId } = await import('./utils/dbBootstrap.js');
          const projectId = await resolveProjectId(getPrismaClient(), { projectId: pidIn, projectName });

          this.log(`Searching Fantom code for: "${query}"${instanceId ? ` (instanceId: ${instanceId})` : ''}${podId ? ` (podId: ${podId})` : ''}${compatibleWith ? ` (compatibleWith: ${compatibleWith})` : ''}`);

          const searchIndex = getFantomFunctionSearchIndex();
          // Pull more rows than `limit` so dedup can collapse duplicates
          // and still yield `limit` distinct results.
          const fetchMultiplier = dedupBy === 'none' ? 1 : 3;
          const options: FunctionSearchOptions = {
            limit: Math.min(limit * fetchMultiplier, 500),
            projectId,
            instanceId,
            podId,
            category: category as FantomCategory,
            type: funcType as 'method' | 'field' | 'constructor',
            className,
            isPublic,
            compatibleWith
          };

          let rawResults = searchIndex.search(query, options);

          // Self-heal: if FlexSearch is empty for this project but Prisma has
          // rows, hydrate from LadybugDB and retry once. Closes the race
          // where boot hydration was skipped (older build) or the project
          // was added after startup. Without this, searchFantomCode silently
          // returns 0 hits despite a fully-populated graph.
          if (projectId && rawResults.length === 0) {
            try {
              const prismaClient = getPrismaClient();
              const proj = await prismaClient.fantomProject.findUnique({ where: { id: projectId } });
              const expected = (proj?.functionCount ?? 0) + (proj?.typeCount ?? 0);
              const inMemory = getFantomCodeIndexer().getFunctionsByProject(projectId).length;
              if (proj && expected > 0 && inMemory === 0) {
                this.log(`  searchFantomCode self-heal: hydrating ${proj.name} from LadybugDB (expected ${expected}, in-memory ${inMemory})`);
                const { getCodeIndexingService } = await import('./fantom-code/index.js');
                await getCodeIndexingService(prismaClient).hydrateIndexerFromLadybug({
                  ...proj,
                  language: (proj as { language?: string }).language || 'fantom',
                  parserType: (proj as { parserType?: string }).parserType,
                } as any);
                searchIndex.rebuild(getFantomCodeIndexer());
                rawResults = searchIndex.search(query, options);
              }
            } catch (err) {
              this.log(`  searchFantomCode self-heal failed: ${err}`);
            }
          }

          // Dedup by qualifiedName (+optional signature). Defends against
          // bundled/vendored code producing the same logical symbol from
          // multiple file paths. Highest-score variant wins.
          let results = rawResults;
          if (dedupBy !== 'none') {
            const seen = new Map<string, typeof rawResults[0]>();
            for (const r of rawResults) {
              const key = dedupBy === 'qualifiedName'
                ? r.function.qualifiedName
                : `${r.function.qualifiedName}|${r.function.signature ?? ''}`;
              const existing = seen.get(key);
              if (!existing || r.score > existing.score) {
                seen.set(key, r);
              }
            }
            results = [...seen.values()].sort((a, b) => b.score - a.score);
          }
          results = results.slice(0, limit);

          // Get instance information for enriching results
          const fantomDb = getFantomDatabase();
          const instanceCache = new Map<number, { name: string; type: string } | null>();

          const formatted = await Promise.all(results.map(async r => {
            // Get project info for pod name
            const project = searchIndex.getProject(r.function.projectId);
            const podName = project?.podMeta?.podName || project?.name;

            // Get instance info if project has instanceId
            let instanceName: string | undefined;
            let instanceType: string | undefined;

            if (project?.instanceId) {
              if (!instanceCache.has(project.instanceId)) {
                const instance = await fantomDb.getInstanceById(project.instanceId);
                instanceCache.set(project.instanceId, instance ? { name: instance.name, type: instance.type } : null);
              }
              const cachedInstance = instanceCache.get(project.instanceId);
              if (cachedInstance) {
                instanceName = cachedInstance.name;
                instanceType = cachedInstance.type;
              }
            }

            return {
              id: r.function.id,
              name: r.function.name,
              qualifiedName: r.function.qualifiedName,
              type: r.function.type,
              className: r.function.className,
              signature: r.function.signature,
              description: r.function.description,
              category: r.function.category,
              filePath: r.function.filePath,
              lineNumber: r.function.lineNumber,
              isPublic: r.function.isPublic,
              podName,
              instanceName,
              instanceType,
              score: r.score.toFixed(2),
              matchedFields: r.matchedFields
            };
          }));

          // Track search event
          try {
            const tracker = getUsageTracker();
            await tracker.trackSearch({
              query,
              source: 'code',
              resultCount: results.length,
              timestamp: new Date(),
              sessionId: (request as any).sessionId,
            });
          } catch (e) {
            this.log(`Failed to track search: ${e}`);
          }

          await trackTool(true);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  query,
                  resultsFound: results.length,
                  filters: {
                    ...(projectId !== undefined && { projectId }),
                    ...(instanceId !== undefined && { instanceId }),
                    ...(podId !== undefined && { podId }),
                    ...(category && { category }),
                    ...(className && { className }),
                    ...(funcType && { type: funcType }),
                    ...(isPublic !== undefined && { isPublic }),
                    ...(compatibleWith && { compatibleWith }),
                  },
                  results: formatted
                }, null, 2)
              }
            ]
          };
        }

        case 'embedChangedFiles': {
          const { projectId: pidIn, projectName, files: _files, force } = args as {
            projectId?: number;
            projectName?: string;
            files?: string[];
            force?: boolean;
          };

          const { getPrismaClient } = await import('./db/prisma.js');
          const { resolveProjectId } = await import('./utils/dbBootstrap.js');
          const { getSemanticSearchService } = await import('./embedding/semanticSearchService.js');
          const prisma = getPrismaClient();
          let pid: number;
          try {
            const resolved = await resolveProjectId(prisma as any, { projectId: pidIn, projectName });
            if (typeof resolved !== 'number' || !Number.isFinite(resolved)) {
              return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'projectId or projectName required' }) }] };
            }
            pid = resolved;
          } catch (err) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Cannot resolve project: ${(err as Error).message}` }) }] };
          }

          // When force=true, drop the project's existing vectors first so
          // the next buildProjectEmbeddings re-embeds every node. Default
          // is incremental (only embeds nodes without an existing vector).
          let deleted = 0;
          if (force) {
            const { getVectorStore } = await import('./embedding/vectorStore.js');
            const vs = getVectorStore(prisma);
            try { deleted = await vs.deleteProjectVectors(pid); } catch (e) {
              this.log(`embedChangedFiles: delete failed for project ${pid}: ${e}`);
            }
          }

          const svc = getSemanticSearchService(prisma);
          let result: { processed: number; errors: number };
          try {
            result = await svc.buildProjectEmbeddings(pid);
          } catch (err) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  projectId: pid,
                  error: (err as Error).message,
                  hint: 'Most likely the embedding sidecar is not yet registered; check /admin/sidecars and /admin/vectors/auto-pipeline/status.',
                }, null, 2),
              }],
            };
          }

          // Close the project's Kuzu connection to keep boot-time RSS flat.
          try {
            const { closeProjectGraphDatabase } = await import('./graph/projectGraphConnection.js');
            await closeProjectGraphDatabase(pid);
          } catch { /* best effort */ }

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                projectId: pid,
                processed: result.processed,
                errors: result.errors,
                deleted,
                force: !!force,
              }, null, 2),
            }],
          };
        }

        case 'getFantomFunction': {
          const { qualifiedName, id } = args as { qualifiedName?: string; id?: string };

          this.log(`Getting Fantom function: ${qualifiedName || id}`);

          const codeIndexer = getFantomCodeIndexer();
          let func;

          if (id) {
            func = codeIndexer.getFunction(id);
          } else if (qualifiedName) {
            func = codeIndexer.getFunctionByQualifiedName(qualifiedName);
          }

          if (!func) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    error: `Function not found: ${qualifiedName || id}`
                  }, null, 2)
                }
              ]
            };
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  function: {
                    id: func.id,
                    name: func.name,
                    qualifiedName: func.qualifiedName,
                    type: func.type,
                    className: func.className,
                    signature: func.signature,
                    returnType: func.returnType,
                    parameters: func.parameters,
                    description: func.description,
                    documentation: func.documentation,
                    sourceCode: func.sourceCode,
                    category: func.category,
                    tags: func.tags,
                    filePath: func.filePath,
                    lineNumber: func.lineNumber,
                    isPublic: func.isPublic,
                    isStatic: func.isStatic,
                    isAbstract: func.isAbstract,
                    isOverride: func.isOverride,
                    isVirtual: func.isVirtual,
                    facets: func.facets
                  }
                }, null, 2)
              }
            ]
          };
        }

        case 'listFunctionsInFile': {
          const { filePath, projectId, atTime, limit, offset } = args as {
            filePath: string;
            projectId?: number;
            atTime?: string;
            limit?: number;
            offset?: number;
          };
          const { listFunctionsInFile } = await import('./fantom-code/fileSymbols.js');
          const result = await listFunctionsInFile(getPrismaClient(), {
            filePath, projectId, atTime, limit, offset,
          });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'getCodeNeighbors': {
          const { qualifiedName, projectId, atTime, count } = args as {
            qualifiedName: string;
            projectId?: number;
            atTime?: string;
            count?: number;
          };
          const { getCodeNeighbors } = await import('./fantom-code/fileSymbols.js');
          const result = await getCodeNeighbors(getPrismaClient(), {
            qualifiedName, projectId, atTime, count,
          });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'searchProjects': {
          const {
            query = '',
            language: filterLanguage,
            instanceId: filterInstanceId,
            hasGraphData,
            minFunctions,
            limit = 20,
          } = args as {
            query?: string;
            language?: string;
            instanceId?: number;
            hasGraphData?: boolean;
            minFunctions?: number;
            limit?: number;
          };
          this.log(`searchProjects "${query}" lang=${filterLanguage ?? 'any'} hasGraph=${hasGraphData ?? 'any'}`);

          const db = getFantomDatabase();
          await db.initialize();
          let projects = await db.getAllProjects();

          // Apply scalar filters first.
          if (filterLanguage) {
            const lang = filterLanguage.toLowerCase();
            projects = projects.filter(p => (p as any).language?.toLowerCase() === lang);
          }
          if (typeof filterInstanceId === 'number') {
            projects = projects.filter(p => p.instanceId === filterInstanceId);
          }
          if (typeof minFunctions === 'number') {
            projects = projects.filter(p => p.functionCount >= minFunctions);
          }

          if (hasGraphData) {
            // One LadybugDB query is cheaper than N — pull the per-project node-count map.
            try {
              const { ladybugQuery } = await import('./graph/ladybugConnection.js');
              const rows = await ladybugQuery<{ pid: number; c: number }>(
                'MATCH (n:CodeNode) RETURN n.project_id AS pid, count(n) AS c'
              );
              const haveGraph = new Set<number>(rows.filter(r => Number(r.c) > 0).map(r => Number(r.pid)));
              projects = projects.filter(p => haveGraph.has(p.id));
            } catch (err) {
              this.log(`hasGraphData filter degraded: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          // Score each remaining project. 0 = no match → drop.
          const q = query.trim().toLowerCase();
          const scored = projects.map(p => {
            if (!q) {
              return { p, score: 0.5, matchedOn: [] as string[] };
            }
            const name = p.name.toLowerCase();
            const path = p.path.toLowerCase();
            const pod = (p.podName ?? '').toLowerCase();
            const desc = ((p as any).description ?? '').toLowerCase();
            const matchedOn: string[] = [];
            let score = 0;
            if (name === q) { score = Math.max(score, 1.0); matchedOn.push('name'); }
            else if (name.startsWith(q)) { score = Math.max(score, 0.9); matchedOn.push('name'); }
            else if (name.includes(q)) { score = Math.max(score, 0.7); matchedOn.push('name'); }
            if (pod.includes(q)) { score = Math.max(score, 0.6); matchedOn.push('podName'); }
            if (path.includes(q)) { score = Math.max(score, 0.5); matchedOn.push('path'); }
            if (desc.includes(q)) { score = Math.max(score, 0.3); matchedOn.push('description'); }
            return { p, score, matchedOn };
          });

          let kept = scored.filter(s => s.score > 0);
          if (!q) {
            // Empty query: sort by lastIndexed desc (recency) instead of score.
            kept = scored.slice().sort((a, b) => {
              const at = a.p.lastIndexed ? new Date(a.p.lastIndexed).getTime() : 0;
              const bt = b.p.lastIndexed ? new Date(b.p.lastIndexed).getTime() : 0;
              return bt - at;
            });
          } else {
            kept.sort((a, b) => b.score - a.score);
          }

          const safeLimit = Math.min(Math.max(1, limit), 100);
          const top = kept.slice(0, safeLimit);

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                query,
                count: top.length,
                projects: top.map(({ p, score, matchedOn }) => ({
                  id: p.id,
                  name: p.name,
                  language: (p as any).language ?? 'fantom',
                  path: p.path,
                  functionCount: p.functionCount,
                  typeCount: p.typeCount,
                  lastIndexed: p.lastIndexed,
                  score: Number(score.toFixed(2)),
                  matchedOn,
                })),
              }, null, 2),
            }],
          };
        }

        case 'getIndexHealth': {
          const { projectId: rawPid, projectName } = args as {
            projectId?: number;
            projectName?: string;
          };
          let pid = rawPid;
          if (!pid && projectName) {
            const db = getFantomDatabase();
            await db.initialize();
            const p = await db.getProjectByName(projectName);
            if (!p) throw new Error(`Project not found: ${projectName}`);
            pid = p.id;
          }
          if (!pid) throw new Error('projectId or projectName required');
          const { getIndexHealth } = await import('./fantom-code/indexHealth.js');
          const report = await getIndexHealth(getPrismaClient(), pid);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(report, null, 2),
            }],
          };
        }

        case 'listFantomProjects': {
          const {
            compatibleWith,
            limit = 50,
            offset = 0,
            pathContains,
            nameContains,
            language: filterLanguage,
            instanceId: filterInstanceId,
            compact = true,
          } = args as {
            compatibleWith?: string;
            limit?: number;
            offset?: number;
            pathContains?: string;
            nameContains?: string;
            language?: string;
            instanceId?: number;
            compact?: boolean;
          };

          this.log(
            `Listing Fantom projects${compatibleWith ? ` (compatibleWith: ${compatibleWith})` : ''}` +
            ` limit=${limit} offset=${offset}` +
            (pathContains ? ` pathContains="${pathContains}"` : '') +
            (nameContains ? ` nameContains="${nameContains}"` : '')
          );

          const db = getFantomDatabase();
          await db.initialize();
          let projects = await db.getAllProjects();

          // Apply scalar filters first.
          if (filterLanguage) {
            const lang = filterLanguage.toLowerCase();
            projects = projects.filter(p => (p as any).language?.toLowerCase() === lang);
          }
          if (typeof filterInstanceId === 'number') {
            projects = projects.filter(p => p.instanceId === filterInstanceId);
          }
          if (nameContains) {
            const needle = nameContains.toLowerCase();
            projects = projects.filter(p => p.name.toLowerCase().includes(needle));
          }
          if (pathContains) {
            const needle = pathContains.toLowerCase();
            projects = projects.filter(p => p.path.toLowerCase().includes(needle));
          }

          // Filter by version compatibility if specified
          if (compatibleWith) {
            const instances = await db.getAllInstances();
            const instanceVersionMap = new Map<number, string | undefined>();
            for (const inst of instances) {
              instanceVersionMap.set(inst.id, inst.version);
            }

            projects = projects.filter(p => {
              if (!p.instanceId) return true; // Projects without instance are included
              const instanceVersion = instanceVersionMap.get(p.instanceId);
              if (!instanceVersion) return true; // No version means compatible
              return isVersionCompatible(instanceVersion, compatibleWith);
            });
          }

          // Pagination
          const total = projects.length;
          const safeLimit = Math.min(Math.max(1, limit), 500);
          const safeOffset = Math.max(0, offset);
          const slice = projects.slice(safeOffset, safeOffset + safeLimit);

          // Compact projection by default to keep responses under the token cap.
          const rows = slice.map(p => {
            const ext = p as any;
            if (compact) {
              return {
                id: p.id,
                name: p.name,
                language: ext.language ?? 'fantom',
                functionCount: p.functionCount,
                typeCount: p.typeCount,
                lastIndexed: p.lastIndexed,
              };
            }
            return {
              id: p.id,
              name: p.name,
              path: p.path,
              language: ext.language ?? 'fantom',
              parserType: ext.parserType,
              podName: p.podName,
              instanceId: p.instanceId,
              description: (p as any).description,
              functionCount: p.functionCount,
              typeCount: p.typeCount,
              lastIndexed: p.lastIndexed,
              autoIndex: p.autoIndex,
              createdAt: (p as any).createdAt,
              updatedAt: (p as any).updatedAt,
            };
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  total,
                  offset: safeOffset,
                  limit: safeLimit,
                  hasMore: safeOffset + safeLimit < total,
                  ...(compatibleWith && { compatibleWith }),
                  projects: rows,
                }, null, 2)
              }
            ]
          };
        }

        case 'addFantomProject': {
          const { name: projName, path: projPath, instanceId, podName, description: projDesc, autoIndex = true, language, parserType } = args as {
            name: string;
            path: string;
            instanceId?: number;
            podName?: string;
            description?: string;
            autoIndex?: boolean;
            language?: string;
            parserType?: string;
          };

          // Auto-pick a sensible parserType when language is non-Fantom
          // and the caller didn't specify one.
          const resolvedLanguage = language || 'fantom';
          const resolvedParserType =
            parserType ||
            (resolvedLanguage !== 'fantom' ? 'tree-sitter-wasm' : 'regex');

          this.log(`Adding project: ${projName} at ${projPath} (language: ${resolvedLanguage}, parser: ${resolvedParserType})`);

          const db = getFantomDatabase();
          await db.initialize();

          // Create project record. Refuses if `projPath` is already
          // registered under another project name — see
          // ProjectPathConflictError in src/fantom/database.ts. Without this
          // guard the same directory could be added repeatedly, doubling
          // index storage and splitting the call graph.
          let project;
          try {
            project = await db.createProject({
              name: projName,
              path: projPath,
              instanceId,
              podName,
              description: projDesc,
              autoIndex,
              language: resolvedLanguage,
              parserType: resolvedParserType
            });
          } catch (err) {
            const { ProjectPathConflictError } = await import('./fantom/database.js');
            if (err instanceof ProjectPathConflictError) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      error: 'PROJECT_PATH_CONFLICT',
                      message: err.message,
                      existing: err.existing,
                      hint:
                        `This path is already registered as "${err.existing.name}" (id=${err.existing.id}). ` +
                        `Use refreshFantomProject to re-index it, or removeFantomProject first if you really want a fresh registration.`,
                    }, null, 2),
                  },
                ],
                isError: true,
              };
            }
            throw err;
          }

          // Index the project — route through the unified pipeline so the
          // language + parserType stored above are actually honored. Going
          // through getFantomCodeIndexer() here was the legacy bug where
          // TypeScript projects got parsed by the Fantom regex parser and
          // returned ~30 functions for a 4500-function codebase.
          const { runIndex } = await import('./fantom-code/runIndex.js');
          const result = await runIndex(db, getPrismaClient(), project.id, {
            trigger: 'mcp-add',
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'refreshFantomProject': {
          const { projectId, projectName } = args as { projectId?: number; projectName?: string };

          this.log(`Refreshing Fantom project: ${projectId || projectName}`);

          const db = getFantomDatabase();
          await db.initialize();

          let project;
          if (projectId) {
            project = await db.getProjectById(projectId);
          } else if (projectName) {
            project = await db.getProjectByName(projectName);
          }

          if (!project) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    error: `Project not found: ${projectId || projectName}`
                  }, null, 2)
                }
              ]
            };
          }

          // Re-index through the unified pipeline (CodeIndexingService).
          const { runIndex } = await import('./fantom-code/runIndex.js');
          const result = await runIndex(db, getPrismaClient(), project.id, {
            trigger: 'mcp-refresh',
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'getFantomCodeStats': {
          this.log('Getting Fantom code stats');

          const codeIndexer = getFantomCodeIndexer();
          const searchIndex = getFantomFunctionSearchIndex();
          const stats = codeIndexer.getStats();

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  totalFunctions: stats.totalFunctions,
                  totalTypes: stats.totalTypes,
                  totalProjects: stats.totalProjects,
                  searchIndexSize: searchIndex.size,
                  byCategory: stats.byCategory,
                  byProject: stats.byProject,
                  lastUpdated: stats.lastUpdated
                }, null, 2)
              }
            ]
          };
        }

        case 'removeFantomProject':
        case 'clearProjectIndex': {
          const { projectId: explicitPid, projectName } = args as {
            projectId?: number;
            projectName?: string;
          };
          this.log(`${name}: pid=${explicitPid ?? 'auto'} name=${projectName ?? 'auto'}`);
          const { getPrismaClient } = await import('./db/prisma.js');
          const { removeProject } = await import('./fantom-code/projectLifecycle.js');
          const prisma = getPrismaClient();

          let pid = explicitPid;
          if (!pid && projectName) {
            const row = await prisma.fantomProject.findUnique({
              where: { name: projectName },
              select: { id: true },
            });
            if (!row) throw new Error(`Project not found: ${projectName}`);
            pid = row.id;
          }
          if (!pid) throw new Error('Provide projectId or projectName');

          const result = await removeProject(prisma, pid, {
            keepRow: name === 'clearProjectIndex',
          });

          // Rebuild FlexSearch since in-memory entries changed.
          try {
            const codeIndexer = getFantomCodeIndexer();
            const searchIndex = getFantomFunctionSearchIndex();
            searchIndex.rebuild(codeIndexer);
          } catch { /* best-effort */ }

          return {
            content: [{
              type: 'text',
              text: JSON.stringify(result, null, 2),
            }],
          };
        }

        case 'reindexChangedFiles': {
          const { paths, projectId: explicitPid } = args as {
            paths: string[];
            projectId?: number;
          };
          if (!Array.isArray(paths) || paths.length === 0) {
            throw new Error('paths must be a non-empty array');
          }
          this.log(`reindexChangedFiles: ${paths.length} path(s)${explicitPid ? `, projectId=${explicitPid}` : ' (auto-resolve)'}`);

          const { getPrismaClient } = await import('./db/prisma.js');
          const { CodeIndexingService } = await import('./fantom-code/codeIndexingService.js');
          const prisma = getPrismaClient();

          // Resolve projectId. When explicit, use it. Otherwise pick the
          // project whose .path is the longest prefix of every input path.
          let projectId = explicitPid;
          let resolutionWarnings: string[] = [];
          if (!projectId) {
            const projects = await prisma.fantomProject.findMany({
              select: { id: true, path: true, name: true },
            });
            const sortedByDepth = [...projects].sort(
              (a, b) => b.path.length - a.path.length,
            );
            const matches = paths.map(p => {
              const hit = sortedByDepth.find(pr => p === pr.path || p.startsWith(pr.path.replace(/\/?$/, '/')));
              return hit ? hit.id : null;
            });
            const distinct = new Set(matches.filter(m => m !== null) as number[]);
            if (distinct.size === 0) {
              throw new Error('No registered project matches any of the provided paths');
            }
            if (distinct.size > 1) {
              throw new Error(
                `Paths span ${distinct.size} projects (ids: ${[...distinct].join(',')}). Pass projectId explicitly and call once per project.`,
              );
            }
            projectId = [...distinct][0];
            const unmatched = paths.filter((_, i) => matches[i] === null);
            if (unmatched.length > 0) {
              resolutionWarnings.push(
                `${unmatched.length} path(s) outside any registered project, ignored: ${unmatched.slice(0, 3).join(', ')}${unmatched.length > 3 ? '...' : ''}`,
              );
            }
          }

          const service = new CodeIndexingService(prisma);
          const result = await service.reindexFiles({ projectId: projectId!, paths, trigger: 'mcp-incremental' });

          // Rebuild FlexSearch index after in-memory mutations.
          try {
            const codeIndexer = getFantomCodeIndexer();
            const searchIndex = getFantomFunctionSearchIndex();
            searchIndex.rebuild(codeIndexer);
          } catch (err) {
            this.log(`FlexSearch rebuild failed: ${err instanceof Error ? err.message : String(err)}`);
          }

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: true,
                runId: result.runId,
                projectId: result.projectId,
                projectName: result.projectName,
                filesProcessed: result.filesProcessed,
                added: result.addedCount,
                modified: result.modifiedCount,
                removed: result.removedCount,
                embedded: result.embeddedCount,
                durationMs: result.duration,
                warnings: resolutionWarnings,
                errors: result.errors.slice(0, 20),
              }, null, 2),
            }],
          };
        }

        case 'whatChangedRecently': {
          const { projectId: rawPid, projectName, hoursAgo, kind } = args as {
            projectId?: number; projectName?: string; hoursAgo?: number;
            kind?: 'added' | 'modified' | 'removed';
          };
          const { resolveProjectId } = await import('./utils/dbBootstrap.js');
          const pid = await resolveProjectId(getPrismaClient() as any, { projectId: rawPid, projectName });
          if (!pid) throw new Error('projectId or projectName required');
          const { whatChangedRecently } = await import('./fantom-code/timeTravelTools.js');
          const result = await whatChangedRecently(getPrismaClient(), { projectId: pid, hoursAgo, kind });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'getSymbolHistory': {
          const { qualifiedName, projectId, since, until } = args as {
            qualifiedName: string; projectId?: number; since?: string; until?: string;
          };
          if (!qualifiedName) throw new Error('qualifiedName required');
          const { getSymbolHistory } = await import('./fantom-code/timeTravelTools.js');
          const result = await getSymbolHistory(getPrismaClient(), { qualifiedName, projectId, since, until });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'diffByTime': {
          const { projectId: rawPid, projectName, from, to, scope } = args as {
            projectId?: number; projectName?: string; from: string; to: string; scope?: string;
          };
          if (!from || !to) throw new Error('from and to required');
          const { resolveProjectId } = await import('./utils/dbBootstrap.js');
          const pid = await resolveProjectId(getPrismaClient() as any, { projectId: rawPid, projectName });
          if (!pid) throw new Error('projectId or projectName required');
          const { diffByTime } = await import('./fantom-code/timeTravelTools.js');
          const result = await diffByTime(getPrismaClient(), { projectId: pid, from, to, scope });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'getActivitySummary': {
          const { projectId: rawPid, projectName, since, until, granularity } = args as {
            projectId?: number; projectName?: string;
            since?: string; until?: string;
            granularity?: 'hour' | 'day' | 'week';
          };
          const { resolveProjectId } = await import('./utils/dbBootstrap.js');
          const pid = await resolveProjectId(getPrismaClient() as any, { projectId: rawPid, projectName });
          if (!pid) throw new Error('projectId or projectName required');
          const { getActivitySummary } = await import('./fantom-code/timeTravelTools.js');
          const result = await getActivitySummary(getPrismaClient(), { projectId: pid, since, until, granularity });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'compareSnapshots': {
          const { projectId: rawPid, projectName, from, to, cursor, pageSize, section } = args as {
            projectId?: number; projectName?: string; from: string; to: string;
            cursor?: string; pageSize?: number;
            section?: 'added' | 'modified' | 'removed' | 'all';
          };
          if (!from || !to) throw new Error('from and to required');
          const { resolveProjectId } = await import('./utils/dbBootstrap.js');
          const pid = await resolveProjectId(getPrismaClient() as any, { projectId: rawPid, projectName });
          if (!pid) throw new Error('projectId or projectName required');
          const { compareSnapshots } = await import('./fantom-code/timeTravelTools.js');
          const result = await compareSnapshots(getPrismaClient(), {
            projectId: pid, from, to, cursor, pageSize, section,
          });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'explainSymbolChange': {
          const { qualifiedName, runId } = args as { qualifiedName: string; runId: number };
          if (!qualifiedName || !runId) throw new Error('qualifiedName and runId required');
          const { explainSymbolChange } = await import('./fantom-code/timeTravelTools.js');
          const result = await explainSymbolChange(getPrismaClient(), { qualifiedName, runId });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'listIndexRuns': {
          // Returns recent indexing runs for one or all projects.
          const { projectId, since, until, trigger, limit = 50 } = args as {
            projectId?: number;
            since?: string;
            until?: string;
            trigger?: 'manual' | 'auto' | 'watch' | 'mcp';
            limit?: number;
          };
          this.log(`Listing index runs (projectId=${projectId ?? 'any'}, limit=${limit})`);
          const { getPrismaClient } = await import('./db/prisma.js');
          const prisma = getPrismaClient();
          const where: any = {};
          if (projectId) where.projectId = projectId;
          if (trigger) where.trigger = trigger;
          if (since || until) {
            where.startedAt = {};
            if (since) where.startedAt.gte = new Date(since);
            if (until) where.startedAt.lte = new Date(until);
          }
          const runs = await prisma.indexRun.findMany({
            where,
            orderBy: { startedAt: 'desc' },
            take: Math.min(Math.max(1, limit), 500),
            include: { project: { select: { name: true } } },
          });
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                count: runs.length,
                runs: runs.map(r => ({
                  id: r.id,
                  projectId: r.projectId,
                  projectName: r.project.name,
                  startedAt: r.startedAt,
                  finishedAt: r.finishedAt,
                  trigger: r.trigger,
                  filesScanned: r.filesScanned,
                  filesParsed: r.filesParsed,
                  filesSkipped: r.filesSkipped,
                  durationMs: r.durationMs,
                  added: r.addedCount,
                  modified: r.modifiedCount,
                  removed: r.removedCount,
                  isSeedingRun: r.isSeedingRun,
                  force: r.force,
                  error: r.errorMessage,
                })),
              }, null, 2),
            }],
          };
        }

        case 'getApiChangeHistory': {
          // Per-symbol or per-project flat list of recorded API changes.
          // The qualifiedName filter is the killer feature for tracking
          // a single symbol's lifetime: every add/modify/remove for it.
          const { projectId, qualifiedName, kind, changeType, since, until, limit = 100 } = args as {
            projectId?: number;
            qualifiedName?: string;
            kind?: 'function' | 'type' | 'field';
            changeType?: 'added' | 'modified' | 'removed';
            since?: string;
            until?: string;
            limit?: number;
          };
          this.log(`API change history (projectId=${projectId ?? 'any'}, qn=${qualifiedName ?? 'any'})`);
          const { getPrismaClient } = await import('./db/prisma.js');
          const prisma = getPrismaClient();
          const where: any = {};
          if (projectId) where.projectId = projectId;
          if (qualifiedName) where.qualifiedName = qualifiedName;
          if (kind) where.kind = kind;
          if (changeType) where.changeType = changeType;
          if (since || until) {
            where.occurredAt = {};
            if (since) where.occurredAt.gte = new Date(since);
            if (until) where.occurredAt.lte = new Date(until);
          }
          const changes = await prisma.apiChange.findMany({
            where,
            orderBy: { occurredAt: 'desc' },
            take: Math.min(Math.max(1, limit), 1000),
          });
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                count: changes.length,
                changes: changes.map(c => ({
                  id: c.id,
                  runId: c.runId,
                  projectId: c.projectId,
                  kind: c.kind,
                  qualifiedName: c.qualifiedName,
                  changeType: c.changeType,
                  beforeSig: c.beforeSig,
                  afterSig: c.afterSig,
                  filePath: c.filePath,
                  occurredAt: c.occurredAt,
                })),
              }, null, 2),
            }],
          };
        }

        case 'diffIndexRuns': {
          // Aggregate added/modified/removed between two runs OR two times for one project.
          const { projectId, fromRunId, toRunId, fromTime, toTime } = args as {
            projectId: number;
            fromRunId?: number;
            toRunId?: number;
            fromTime?: string;
            toTime?: string;
          };
          if (!projectId) throw new Error('projectId is required');
          if (!fromRunId && !fromTime) throw new Error('Either fromRunId or fromTime is required');
          this.log(`Diff index runs for project ${projectId}`);
          const { getPrismaClient } = await import('./db/prisma.js');
          const prisma = getPrismaClient();

          // Resolve the time window
          let fromDate: Date, toDate: Date;
          if (fromRunId) {
            const fr = await prisma.indexRun.findUnique({ where: { id: fromRunId } });
            if (!fr) throw new Error(`fromRunId ${fromRunId} not found`);
            fromDate = fr.startedAt;
          } else {
            fromDate = new Date(fromTime!);
          }
          if (toRunId) {
            const tr = await prisma.indexRun.findUnique({ where: { id: toRunId } });
            if (!tr) throw new Error(`toRunId ${toRunId} not found`);
            toDate = tr.startedAt;
          } else if (toTime) {
            toDate = new Date(toTime);
          } else {
            toDate = new Date();
          }

          const changes = await prisma.apiChange.findMany({
            where: {
              projectId,
              occurredAt: { gte: fromDate, lte: toDate },
            },
            orderBy: { occurredAt: 'asc' },
          });

          // Collapse same-symbol churn: if a symbol was modified twice and removed,
          // present the net effect — last beforeSig vs final afterSig.
          const bySymbol = new Map<string, {
            kind: string; first: typeof changes[0]; last: typeof changes[0];
          }>();
          for (const c of changes) {
            const seen = bySymbol.get(c.qualifiedName);
            if (!seen) bySymbol.set(c.qualifiedName, { kind: c.kind, first: c, last: c });
            else seen.last = c;
          }
          const added: any[] = [], modified: any[] = [], removed: any[] = [];
          for (const [qn, v] of bySymbol) {
            const netType =
              v.first.changeType === 'added' && v.last.changeType !== 'removed' ? 'added' :
              v.last.changeType === 'removed' ? 'removed' : 'modified';
            const entry = {
              qualifiedName: qn,
              kind: v.kind,
              filePath: v.last.filePath,
              beforeSig: v.first.beforeSig,
              afterSig: v.last.afterSig,
              firstSeen: v.first.occurredAt,
              lastSeen: v.last.occurredAt,
            };
            if (netType === 'added') added.push(entry);
            else if (netType === 'removed') removed.push(entry);
            else modified.push(entry);
          }
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                projectId,
                fromDate, toDate,
                summary: { added: added.length, modified: modified.length, removed: removed.length },
                added, modified, removed,
              }, null, 2),
            }],
          };
        }

        case 'listCompatiblePods': {
          const { version, instanceType } = args as {
            version: string;
            instanceType?: 'skyspark' | 'haxall' | 'fantom';
          };

          this.log(`Listing pods compatible with version: ${version}${instanceType ? ` (type: ${instanceType})` : ''}`);

          const db = getFantomDatabase();
          await db.initialize();

          // Get all instances and filter by type and version compatibility
          const instances = await db.getAllInstances();
          const compatibleInstances = instances.filter(inst => {
            // Filter by type if specified
            if (instanceType && inst.type !== instanceType) return false;
            // Filter by version compatibility
            if (!inst.version) return true; // No version means compatible
            return isVersionCompatible(inst.version, version);
          });

          // Get all projects and filter to those linked to compatible instances
          const projects = await db.getAllProjects();
          const compatibleProjects = projects.filter(p => {
            if (!p.instanceId) return false; // Only include projects with an instance
            return compatibleInstances.some(inst => inst.id === p.instanceId);
          });

          // Group by instance for better output
          const byInstance = new Map<number, typeof compatibleProjects>();
          for (const proj of compatibleProjects) {
            const instId = proj.instanceId!;
            if (!byInstance.has(instId)) {
              byInstance.set(instId, []);
            }
            byInstance.get(instId)!.push(proj);
          }

          const result = {
            targetVersion: version,
            ...(instanceType && { instanceType }),
            totalCompatibleInstances: compatibleInstances.length,
            totalCompatiblePods: compatibleProjects.length,
            instances: compatibleInstances.map(inst => ({
              id: inst.id,
              name: inst.name,
              type: inst.type,
              version: inst.version,
              pods: (byInstance.get(inst.id) || []).map(p => ({
                id: p.id,
                name: p.name,
                podName: p.podName,
                path: p.path,
                functionCount: p.functionCount,
                typeCount: p.typeCount
              }))
            }))
          };

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2)
              }
            ]
          };
        }

        // Local Documentation Tools
        case 'searchLocalDocs': {
          const { query, instanceId, instanceType, pod, type: itemType, language, limit = 20 } = args as {
            query: string;
            instanceId?: number;
            instanceType?: 'skyspark' | 'haxall' | 'fantom';
            pod?: string;
            type?: string;
            language?: 'fantom' | 'axon';
            limit?: number;
          };

          this.log(`Searching local docs for: "${query}"${instanceType ? ` (type: ${instanceType})` : ''}`);

          // Check if searching a Haxall instance without a doc source
          if (instanceId) {
            const db = getFantomDatabase();
            const instance = await db.getInstanceById(instanceId);
            if (instance?.type === 'haxall' && !instance.docSourceInstanceId) {
              await trackTool(true);
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      query,
                      resultsFound: 0,
                      results: [],
                      warning: 'Haxall instance has no documentation source configured.',
                      suggestion: 'Go to Dashboard > Instances > Edit > Set Documentation Source to link to a SkySpark instance.',
                      hint: 'Haxall 4.x documentation is identical to SkySpark 4.x documentation.'
                    }, null, 2)
                  }
                ]
              };
            }
          }

          const searchResult = await hybridSearchLocalDocsWithMeta(query, {
            instanceId,
            instanceType,
            pod,
            type: itemType as any,
            language,
            limit
          });

          // Track search event
          try {
            const tracker = getUsageTracker();
            await tracker.trackSearch({
              query,
              source: 'local-docs',
              resultCount: searchResult.results.length,
              timestamp: new Date(),
              sessionId: (request as any).sessionId,
            });
          } catch (e) {
            this.log(`Failed to track search: ${e}`);
          }

          await trackTool(true);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  query,
                  filters: {
                    instanceId,
                    instanceType,
                    pod,
                    type: itemType,
                    language
                  },
                  searchMethod: searchResult.searchMethod,
                  keywordMatches: searchResult.keywordResults,
                  vectorMatches: searchResult.vectorResults,
                  vectorsAvailable: searchResult.vectorCount,
                  resultsFound: searchResult.results.length,
                  results: searchResult.results.map(r => ({
                    name: r.name,
                    qualifiedName: r.qualifiedName,
                    type: r.type,
                    pod: r.pod,
                    description: r.description,
                    signature: r.signature,
                    url: r.url,
                    language: r.language,
                    instance: {
                      id: r.instanceId,
                      name: r.instanceName,
                      type: r.instanceType,
                      version: r.version
                    },
                    retrieval: {
                      source: r.source,
                      keywordRank: r.keywordRank,
                      vectorRank: r.vectorRank,
                      keywordScore: r.keywordScore,
                      vectorScore: r.vectorScore,
                      fusedScore: r.fusedScore
                    }
                  }))
                }, null, 2)
              }
            ]
          };
        }

        case 'indexInstanceDocs': {
          const { instanceId, pods, forceRefresh = false } = args as {
            instanceId: number;
            pods?: string[];
            forceRefresh?: boolean;
          };

          this.log(`Indexing docs for instance ${instanceId}`);

          const result = await parseInstanceDocs({
            instanceId,
            pods,
            forceRefresh
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  instanceId: result.instanceId,
                  version: result.version,
                  itemCount: result.items.length,
                  duration: result.duration,
                  podStats: result.podStats,
                  errors: result.errors
                }, null, 2)
              }
            ]
          };
        }

        case 'listLocalPods': {
          const { instanceId } = args as { instanceId: number };

          this.log(`Listing pods for instance ${instanceId}`);

          const pods = await listInstancePods(instanceId);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  instanceId,
                  podCount: pods.length,
                  pods: pods.map(p => ({
                    name: p.name,
                    category: p.category,
                    fileCount: p.fileCount,
                    isAxonLib: p.isAxonLib
                  }))
                }, null, 2)
              }
            ]
          };
        }

        case 'getLocalDocStatus': {
          const { instanceId } = args as { instanceId: number };

          this.log(`Getting doc status for instance ${instanceId}`);

          const status = await getDocStatus(instanceId);

          // Get doc vector count for this instance
          let docVectorCount = 0;
          try {
            const docsStore = getDocsVectorStore();
            docVectorCount = await docsStore.count();
          } catch { /* vectors not available */ }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  instanceId,
                  ...status,
                  vectors: {
                    count: docVectorCount,
                    enabled: docVectorCount > 0
                  }
                }, null, 2)
              }
            ]
          };
        }

        case 'semanticCodeSearch': {
          const ssConfig = this.config.semanticSearch || {};
          const { query, projectId: pidIn, projectName, nodeType, limit = ssConfig.defaultLimit || 10 } = args as {
            query: string;
            projectId?: number;
            projectName?: string;
            nodeType?: string;
            limit?: number;
          };

          this.log(`Semantic code search: "${query}"`);

          const prisma = getPrismaClient();
          const { resolveProjectId } = await import('./utils/dbBootstrap.js');
          const projectId = await resolveProjectId(prisma, { projectId: pidIn, projectName });
          const semanticService = getSemanticSearchService(prisma);
          const results = await semanticService.search(query, {
            projectId,
            nodeType,
            limit,
            minScore: ssConfig.minScore,
            graphWeight: ssConfig.graphWeight,
            includeGraphContext: ssConfig.includeGraphContext ?? true,
          });

          if (results.length === 0) {
            await trackTool(true);
            return {
              content: [{ type: 'text', text: 'No matching code found.' }],
            };
          }

          const lines = [`Found ${results.length} results:\n`];
          for (const result of results) {
            lines.push(`## ${result.qualifiedName}`);
            lines.push(`   Score: ${(result.combinedScore * 100).toFixed(1)}% (semantic: ${(result.semanticScore * 100).toFixed(1)}%, graph: ${(result.graphScore * 100).toFixed(1)}%)`);
            if (result.sources?.length) {
              lines.push(`   Sources: ${result.sources.join(', ')}${typeof result.crossEncoderScore === 'number' ? ` (reranked ${result.crossEncoderScore.toFixed(3)})` : ''}`);
            }
            lines.push(`   Type: ${result.nodeType}`);
            lines.push(`   File: ${result.filePath}:${result.lineStart}`);
            if (result.signature) {
              lines.push(`   Signature: ${result.signature}`);
            }
            if (result.callerCount !== undefined) {
              lines.push(`   Callers: ${result.callerCount}, Callees: ${result.calleeCount}`);
            }
            if (result.relatedNodes && result.relatedNodes.length > 0) {
              lines.push(`   Related: ${result.relatedNodes.map(n => n.name).join(', ')}`);
            }
            lines.push('');
          }

          await trackTool(true);
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
          };
        }

        case 'axonSearch':
        case 'axonFunction': {
          if (!isAxonTool(name)) throw new Error(`Unknown Axon tool: ${name}`);
          this.log(`Axon tool ${name}`);
          const result = await handleAxonTool(name, (args ?? {}) as Record<string, unknown>);
          await trackTool(!result.isError);
          return result;
        }

        case 'askCodebase': {
          const { query, projectId, useRlm, useReranker } = args as { query: string; projectId?: number; useRlm?: boolean; useReranker?: boolean };
          this.log(`Ask codebase: "${query}"${useRlm === false ? ' (no RLM)' : ''}${useReranker === false ? ' (no rerank)' : ''}`);
          const { answerCodeQuestion } = await import('./embedding/answerSynthesis.js');
          // MCP progress: if the client sent a progressToken, stream stage
          // updates back as notifications/progress. Fire-and-forget — a
          // notification that fails to send must never fail the answer.
          const progressToken = extra?._meta?.progressToken;
          const onProgress = progressToken !== undefined && typeof extra?.sendNotification === 'function'
            ? (p: { message: string; progress: number; total: number }) => {
                void extra.sendNotification({
                  method: 'notifications/progress',
                  params: { progressToken, progress: p.progress, total: p.total, message: p.message },
                }).catch(() => {});
              }
            : undefined;
          const result = await answerCodeQuestion(query, { projectId, onProgress, rlm: useRlm, rerank: useReranker });
          const out = [result.answer.trim()];
          if (result.citations.length > 0) {
            out.push('', 'Sources:');
            result.citations.forEach((c, i) => {
              out.push(`[${i + 1}] ${c.qualifiedName} — ${c.filePath}:${c.lineStart}`);
            });
          }
          await trackTool(true);
          return {
            content: [{ type: 'text', text: out.join('\n') }],
          };
        }

        case 'findSimilarCode': {
          const { qualifiedName, nodeId: rawNodeId, projectId: pidIn, projectName, limit = 5 } = args as {
            qualifiedName?: string;
            nodeId?: string;
            projectId?: number;
            projectName?: string;
            limit?: number;
          };
          const { resolveProjectId } = await import('./utils/dbBootstrap.js');
          const projectId = await resolveProjectId(getPrismaClient(), { projectId: pidIn, projectName });

          this.log(`Find similar code: ${qualifiedName || rawNodeId}`);

          const prisma = getPrismaClient();
          let nodeId = rawNodeId;
          if (!nodeId && qualifiedName) {
            const queryManager = getLadybugQueryManager(projectId);
            const node = await queryManager.getNodeByQualifiedName(qualifiedName, projectId);
            nodeId = node?.id || undefined;
          }

          if (!nodeId) {
            await trackTool(false, 'Either nodeId or qualifiedName is required');
            return {
              content: [{ type: 'text', text: 'Either nodeId or qualifiedName is required' }],
              isError: true,
            };
          }

          const semanticService = getSemanticSearchService(prisma);
          const results = await semanticService.findSimilar(nodeId, { projectId, limit });

          if (results.length === 0) {
            await trackTool(true);
            return {
              content: [{ type: 'text', text: 'No similar code found.' }],
            };
          }

          const lines = [`Found ${results.length} similar functions:\n`];
          for (const result of results) {
            lines.push(`- ${result.qualifiedName} (${(result.semanticScore * 100).toFixed(1)}% similar)`);
            lines.push(`  File: ${result.filePath}:${result.lineStart}`);
          }

          await trackTool(true);
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
          };
        }

        case 'getCallers': {
          const { qualifiedName, nodeId: rawNodeId, projectId: pidIn, projectName, maxDepth = 5 } = args as {
            qualifiedName?: string;
            nodeId?: string;
            projectId?: number;
            projectName?: string;
            maxDepth?: number;
          };
          const { resolveProjectId } = await import('./utils/dbBootstrap.js');
          const projectId = await resolveProjectId(getPrismaClient(), { projectId: pidIn, projectName });

          this.log(`Get callers: ${qualifiedName || rawNodeId}`);

          const queryManager = getLadybugQueryManager(projectId);

          let nodeId = rawNodeId;
          if (!nodeId && qualifiedName) {
            const node = await queryManager.getNodeByQualifiedName(qualifiedName, projectId);
            nodeId = node?.id || undefined;
          }

          if (!nodeId) {
            await trackTool(false, 'Either nodeId or qualifiedName is required');
            return {
              content: [{ type: 'text', text: 'Either nodeId or qualifiedName is required' }],
              isError: true,
            };
          }

          const callers = await queryManager.getCallers(nodeId, maxDepth);

          if (callers.length === 0) {
            await trackTool(true);
            return {
              content: [{ type: 'text', text: 'No callers found for this function.' }],
            };
          }

          const lines = [`Found ${callers.length} callers:\n`];
          for (const caller of callers) {
            lines.push(`- [depth ${caller.depth}] ${caller.qualifiedName}`);
            lines.push(`  File: ${caller.filePath}${caller.lineNumber ? `:${caller.lineNumber}` : ''}`);
          }

          await trackTool(true);
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
          };
        }

        case 'getCallees': {
          const { qualifiedName, nodeId: rawNodeId, projectId: pidIn, projectName, maxDepth = 5 } = args as {
            qualifiedName?: string;
            nodeId?: string;
            projectId?: number;
            projectName?: string;
            maxDepth?: number;
          };
          const { resolveProjectId } = await import('./utils/dbBootstrap.js');
          const projectId = await resolveProjectId(getPrismaClient(), { projectId: pidIn, projectName });

          this.log(`Get callees: ${qualifiedName || rawNodeId}`);

          const queryManager = getLadybugQueryManager(projectId);

          let nodeId = rawNodeId;
          if (!nodeId && qualifiedName) {
            const node = await queryManager.getNodeByQualifiedName(qualifiedName, projectId);
            nodeId = node?.id || undefined;
          }

          if (!nodeId) {
            await trackTool(false, 'Either nodeId or qualifiedName is required');
            return {
              content: [{ type: 'text', text: 'Either nodeId or qualifiedName is required' }],
              isError: true,
            };
          }

          const callees = await queryManager.getCallees(nodeId, maxDepth);

          if (callees.length === 0) {
            await trackTool(true);
            return {
              content: [{ type: 'text', text: 'No callees found for this function.' }],
            };
          }

          const lines = [`Found ${callees.length} callees:\n`];
          for (const callee of callees) {
            lines.push(`- [depth ${callee.depth}] ${callee.qualifiedName}`);
            lines.push(`  File: ${callee.filePath}${callee.lineNumber ? `:${callee.lineNumber}` : ''}`);
          }

          await trackTool(true);
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
          };
        }

        case 'getCodeImpact': {
          const { qualifiedName, nodeId: rawNodeId, projectId, maxDepth = 10 } = args as {
            qualifiedName?: string;
            nodeId?: string;
            projectId?: number;
            maxDepth?: number;
          };

          this.log(`Get code impact: ${qualifiedName || rawNodeId}`);

          const queryManager = getLadybugQueryManager(projectId);

          let nodeId = rawNodeId;
          if (!nodeId && qualifiedName) {
            const node = await queryManager.getNodeByQualifiedName(qualifiedName, projectId);
            nodeId = node?.id || undefined;
          }

          if (!nodeId) {
            await trackTool(false, 'Either nodeId or qualifiedName is required');
            return {
              content: [{ type: 'text', text: 'Either nodeId or qualifiedName is required' }],
              isError: true,
            };
          }

          const impact = await queryManager.getImpact(nodeId, maxDepth);

          const lines = [
            `Impact Analysis for: ${impact.focalNode.qualifiedName}\n`,
            `Total affected nodes: ${impact.totalAffected}`,
            `Max depth reached: ${impact.maxDepthReached}`,
            '\nBreakdown by relationship:',
          ];

          for (const [edgeType, count] of Object.entries(impact.breakdown)) {
            if (count > 0) {
              lines.push(`  - ${edgeType}: ${count}`);
            }
          }

          if (impact.affectedNodes.length > 0) {
            lines.push('\nAffected nodes:');
            for (const node of impact.affectedNodes.slice(0, 20)) {
              lines.push(`  - [depth ${node.minDepth}] ${node.qualifiedName}`);
              lines.push(`    Relationships: ${node.edgeTypes.join(', ')}`);
            }
            if (impact.affectedNodes.length > 20) {
              lines.push(`  ... and ${impact.affectedNodes.length - 20} more`);
            }
          }

          await trackTool(true);
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
          };
        }

        case 'searchVersionedApi': {
          const searchInput = args as SearchVersionedApiInput;

          this.log(`searchVersionedApi: query="${searchInput.query}" mode=${searchInput.mode || 'all'} version=${searchInput.version || 'auto'}`);

          const result = await searchVersionedApi(searchInput);

          // Track search event
          try {
            const tracker = getUsageTracker();
            await tracker.trackSearch({
              query: searchInput.query,
              source: 'versioned-api',
              resultCount: result.summary.totalResults,
              timestamp: new Date(),
              sessionId: (request as any).sessionId,
            });
          } catch (e) {
            this.log(`Failed to track search: ${e}`);
          }

          await trackTool(true);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        default: {
          // Try to route to MCP Explorer agents
          const agentTools = this.agentFramework.getAllTools();
          const agentTool = agentTools.find((t) => t.name === name);

          if (agentTool) {
            this.log(`Routing to agent tool: ${name}`);
            const result = await this.agentFramework.orchestration.executeTool(
              'explorer_executeTool',
              { toolName: name, params: args }
            );

            if (result.success) {
              // Track successful agent tool call
              await trackTool(true);
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(result.data, null, 2),
                  },
                ],
              };
            } else {
              // Track failed agent tool call
              await trackTool(false, result.error);
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({ error: result.error }, null, 2),
                  },
                ],
                isError: true,
              };
            }
          }

          throw new Error(`Unknown tool: ${name}`);
        }
      }
    } catch (error) {
      this.log(`Error executing tool ${name}: ${error}`);
      const errorMessage = error instanceof Error ? error.message : String(error);
      await trackTool(false, errorMessage);
      // Classify DB / Prisma errors so the assistant gets an actionable hint
      // (DB locked, schema mismatch, etc.) instead of a raw stack trace.
      const { classifyDbError } = await import('./utils/dbBootstrap.js');
      const hint = classifyDbError(error);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                error: errorMessage,
                tool: name,
                hint: hint !== errorMessage ? hint : undefined,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }

  /**
   * Handle ListResources request - dynamically loads workflows from WorkflowManager
   */
  private async handleListResources() {
    // Dynamically load workflow resources from WorkflowManager
    const workflowResources = this.workflowManager.getWorkflowList().map(workflow => ({
      uri: workflow.uri,
      name: workflow.metadata.title,
      description: workflow.metadata.description,
      mimeType: 'text/markdown',
    }));

    // Static resources (docs and tool-navigator)
    const staticResources = [
      {
        uri: 'docs://migration-tool-guide',
        name: 'Migration Tool Usage Guide',
        description: 'Complete guide for using the automated SkySpark 4.x migration tool',
        mimeType: 'text/markdown',
      },
      {
        uri: 'docs://migration-enhancements',
        name: 'Migration Tool Enhancements',
        description:
          'New features and capabilities of the migration tool (Axon transformation, type detection, settings migration)',
        mimeType: 'text/markdown',
      },
      {
        uri: 'docs://migration-structure-fix',
        name: 'Migration Structure Reference',
        description: 'Correct SkySpark 4.0 structure patterns based on real haxall source code',
        mimeType: 'text/markdown',
      },
      {
        uri: 'tool-navigator://overview',
        name: 'Tool Navigator',
        description: 'Overview of all MCP tools organized by category with quick reference',
        mimeType: 'application/json',
      },
    ];

    return {
      resources: [...workflowResources, ...staticResources],
    };
  }

  /**
   * Handle ReadResource request
   */
  private async handleReadResource(request: any) {
    const uri = request.params.uri;

    try {
      // Handle tool-navigator resource
      if (uri.startsWith('tool-navigator://')) {
        return this.handleToolNavigatorResource(uri);
      }

      let filePath: string;

      if (uri.startsWith('workflow://')) {
        const workflowName = uri.replace('workflow://', '');
        filePath = join(process.cwd(), 'workflows', `${workflowName}.md`);
      } else if (uri.startsWith('docs://')) {
        const docName = uri.replace('docs://', '');
        // Convert kebab-case to SCREAMING_SNAKE_CASE for filename
        const fileName =
          docName
            .split('-')
            .map((w: string) => w.toUpperCase())
            .join('_') + '.md';
        filePath = join(process.cwd(), 'docs', fileName);
      } else {
        throw new Error(`Unknown resource URI scheme: ${uri}`);
      }

      const content = await fs.readFile(filePath, 'utf-8');

      return {
        contents: [
          {
            uri,
            mimeType: 'text/markdown',
            text: content,
          },
        ],
      };
    } catch (error) {
      this.log(`Failed to read resource ${uri}: ${error}`);
      return {
        contents: [
          {
            uri,
            mimeType: 'text/plain',
            text: `Error: Resource not found: ${uri}`,
          },
        ],
      };
    }
  }

  /**
   * Handle tool-navigator resource requests
   */
  private handleToolNavigatorResource(uri: string) {
    // Get all tools from the agent framework
    const allTools = this.agentFramework.getAllTools();

    // Organize tools by category
    const categories: Record<string, {
      description: string;
      tools: string[];
      primaryUseCase: string;
    }> = {
      'documentation': {
        description: 'Search and retrieve Fantom/Haxall documentation',
        tools: allTools.filter(t => t.category === 'documentation').map(t => t.name),
        primaryUseCase: 'Finding API documentation, types, examples',
      },
      'code-generation': {
        description: 'Generate Fantom code artifacts',
        tools: allTools.filter(t => t.category === 'code-generation').map(t => t.name),
        primaryUseCase: 'Creating new classes, methods, pods',
      },
      'code-analysis': {
        description: 'Static analysis for Fantom source code',
        tools: allTools.filter(t => t.category === 'code-analysis').map(t => t.name),
        primaryUseCase: 'Parsing, symbol extraction, code intelligence',
      },
      'project-management': {
        description: 'SkySpark project operations and migration',
        tools: allTools.filter(t => t.category === 'project-management').map(t => t.name),
        primaryUseCase: 'Managing projects, environment detection, migration',
      },
      'analytics': {
        description: 'Usage tracking and performance metrics',
        tools: allTools.filter(t => t.category === 'analytics').map(t => t.name),
        primaryUseCase: 'Monitoring usage, viewing statistics, exporting data',
      },
      'explorer': {
        description: 'Tool discovery and system health',
        tools: allTools.filter(t => t.category === 'explorer').map(t => t.name),
        primaryUseCase: 'Finding tools, checking system status, browsing capabilities',
      },
    };

    // Add primary tools count
    const primaryToolNames = [
      'getFantomType', 'listFantomPods', 'migrateSkySpark4x', 'generateFantomCode',
      'commitMigration', 'rollbackMigration', 'searchFantomCode', 'getFantomFunction',
      'listFantomProjects', 'addFantomProject', 'refreshFantomProject', 'getFantomCodeStats',
      'listCompatiblePods', 'searchLocalDocs', 'indexInstanceDocs', 'listLocalPods',
      'getLocalDocStatus', 'searchAll', 'searchVersionedApi',
    ];

    const content = {
      totalTools: allTools.length + primaryToolNames.length,
      agentTools: allTools.length,
      primaryTools: primaryToolNames.length,
      categories,
      quickReference: {
        search: ['docs_search', 'searchVersionedApi', 'explorer_searchTools', 'searchAll'],
        generate: ['gen_class', 'gen_method', 'gen_pod', 'generateFantomCode'],
        analyze: ['code_parse', 'code_getSymbols', 'code_findDefinition'],
        migrate: ['migrateSkySpark4x', 'project_migrate4x', 'commitMigration', 'rollbackMigration'],
        monitor: ['analytics_getUsage', 'explorer_getSystemHealth', 'analytics_getToolMetrics'],
      },
      usage: {
        toolSearch: 'Use explorer_searchTools with natural language queries to find the right tool',
        categories: 'Use explorer_browseCategories to see tool counts per category',
        schema: 'Use explorer_getToolSchema to get parameter details for any tool',
      },
    };

    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(content, null, 2),
        },
      ],
    };
  }
}

// In stdio transport mode, stdout is the MCP JSON-RPC channel. Any stray
// console.log (e.g. Prisma's internal logger on errors) corrupts the protocol
// stream and causes the client to disconnect. Redirect to stderr.
// process.stdout.write is left untouched so the MCP SDK transport can still
// emit its framed JSON-RPC messages.
if ((process.env.MCP_TRANSPORT || 'stdio') === 'stdio') {
  console.log = console.error;
  console.info = console.error;
}

// Swallow EPIPE on stdout/stderr — can happen when the MCP client closes the
// pipe before a background log (e.g. Prisma's internal console.log) flushes.
// Letting it propagate crashes the process as an unhandled 'error' event.
function isEpipe(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === 'EPIPE';
}

process.stdout.on('error', (err) => {
  if (!isEpipe(err)) throw err;
});
process.stderr.on('error', (err) => {
  if (!isEpipe(err)) throw err;
});

process.on('uncaughtException', (err) => {
  if (isEpipe(err)) return;
  logger.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  if (isEpipe(reason)) return;
  logger.error('Unhandled rejection:', reason);
});

// Graceful shutdown: must CHECKPOINT + close LadybugDB before the process
// exits, otherwise the WAL is left in a half-flushed state and the next
// startup hits "Corrupted wal file. Read out invalid WAL record type."
let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}, flushing LadybugDB and shutting down...`);
  const timeout = setTimeout(() => {
    logger.error('Shutdown timeout exceeded; forcing exit');
    process.exit(1);
  }, 25_000);
  try {
    await closeLadybugConnection();
  } catch (err) {
    logger.error(`Error during LadybugDB close: ${err}`);
  } finally {
    clearTimeout(timeout);
    process.exit(0);
  }
}
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });

// Run the server
// Validate DATABASE_URL before any class instantiation so Prisma client
// doesn't get a chance to lazy-init against bad config and emit a stack
// trace into the MCP transport.
import { validateDatabaseUrl } from './utils/dbBootstrap.js';
try {
  validateDatabaseUrl();
} catch (err) {
  logger.error('Bootstrap failed: ' + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
}

const server = new FantomMCPServer();
server.run().catch((error) => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
