/**
 * Admin API type definitions for the Fantom MCP Server
 */

export interface AdminCredentials {
  username: string;
  password: string;
}

// User types for authentication
export type UserRole = 'admin' | 'user';

export interface AuthenticatedUser {
  id: string;
  username: string;
  role: UserRole;
  createdAt: string;
  lastLogin?: string;
}

// Extend Express Request to include user
declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthenticatedUser;
  }
}

export interface ServerStatus {
  status: 'running' | 'starting' | 'error';
  uptime: number;
  memory: {
    used: number;        // heapUsed
    total: number;       // heap_size_limit (--max-old-space-size), not heapTotal
    percentage: number;  // used / total
    heapTotal?: number;  // V8's currently reserved heap
    rss?: number;        // resident set size — what the OS kills on
    external?: number;
  };
  initialized: boolean;
  version: string;
  serverPath: string; // Path to build/index.js
  port: number; // HTTP server port
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
  storageType?: 'json-cache' | 'sqlite' | 'lancedb';
  // Enhanced cache content details
  metadata?: {
    version: string;
    source: string;
    itemCount: number;
    timestamp: number;
    byType?: Record<string, number>;
    byPod?: Record<string, number>;
  };
}

export interface PrimaryProjectContext {
  instance: string;
  project: string;
  setBy: 'vscode' | 'dashboard' | 'api' | 'startup';
  timestamp: Date | null;
}

export interface UsageStats {
  totalToolCalls: number;
  totalSearches: number;
  toolUsage: Record<string, number>;
  topSearches: Array<{ query: string; count: number }>;
  periodStart: string;
  periodEnd: string;
}

export interface McpTool {
  name: string;
  description: string;
  category?: string;
  mcpExposed?: boolean;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// 'embedding-code' is a code-specialized embedder (e.g. jina-code) that runs as
// its OWN sidecar service on its OWN port (each Sound Suite role has a distinct
// port: embedding 11434, code-embedding 11437, …) — so it must be a SEPARATE
// capability from the general 'embedding', not folded in: a capability carries a
// single port, and folding would route one model to the other's port.
export type SidecarCapabilityKind = 'embedding' | 'embedding-code' | 'llm' | 'reranker' | 'ocr' | 'rlm';
export type LLMProviderName = 'groq' | 'anthropic' | 'gemini';

export interface SidecarCapabilityState {
  available: boolean;
  models: string[];           // model identifiers the sidecar can serve
  loaded?: string | null;     // currently in VRAM (if known)
  gpuPercent?: number;        // 0-100 (-1 = CPU-only); higher = preferred
  endpoint?: string;          // optional path override (default: /api/embed for embedding)
  port?: number;              // optional service-specific port (default: sidecar.port)
}

export interface Sidecar {
  id: string;
  name: string;
  host: string;
  port: number;
  protocol: 'http' | 'https';
  authToken?: string;
  enabled: boolean;
  capabilities: Partial<Record<SidecarCapabilityKind, SidecarCapabilityState>>;
  capabilitiesSource?: 'ws-register' | 'ws-heartbeat' | 'http-ping' | 'manual';
  lastSeen?: string;
  lastHealthCheck?: string;
  healthStatus?: 'healthy' | 'unhealthy' | 'unknown';
  responseTimeMs?: number;
  activeRequests?: number;
}

export interface LLMProviderConfig {
  enabled: boolean;
  model?: string;
}

export interface FantomSettings {
  port: number;
  cacheDir: string;
  searchSettings: {
    maxResults: number;
    minScore: number;
    useOrLogic: boolean;
  };
  semanticSearch: {
    minScore: number;
    graphWeight: number;
    defaultLimit: number;
    includeGraphContext: boolean;
    embeddingModel?: string;
    embeddingDimensions?: number;
    codeModel?: string;
    codeDimensions?: number;
    docsModel?: string;
    docsDimensions?: number;
    embeddingThreads?: number;
    embeddingBatchSize?: number;
    codeFromSidecar?: boolean;
    docsFromSidecar?: boolean;
    /** How many projects buildProjectEmbeddings runs concurrently in the
     *  build-missing / auto-embed loops. Default 1 (serial). Higher values
     *  saturate sidecar GPUs faster but raise local memory pressure. */
    parallelProjects?: number;
    /** How many projects the full re-embed runs concurrently. Projects are
     *  the unit of assignment: workers pull from one queue so no two ever
     *  duplicate a project. Default 3, capped at 8 — each in-flight project
     *  holds its full node set plus graph context, and three concurrent
     *  forced reindexes once tripped the RSS guard at 4,002 MB (exit 137).
     *  Measure RSS before raising. */
    maxConcurrentProjects?: number;
    /** Sidecar name used as the local reference when verifying a cloud
     *  embedder. Two identical local Ollama stacks serving the same model
     *  measured only ~0.9986 pairwise cosine, so the 0.99 floor has little
     *  headroom and a borderline provider can pass against one host and fail
     *  against another. Naming the reference makes the verdict reproducible;
     *  unset falls back to the first available local provider. */
    verificationReferenceSidecar?: string;
    /** OpenRouter-backed "virtual containers" — cloud capacity a Sound Suite
     *  sidecar (2.4.2+) can serve for a role instead of its local model.
     *  Fantom sees each as a separate provider `<PCName>-OR-<Role>`. */
    virtualContainers?: {
      /** Master switch. Default true; discovery finds nothing when the
       *  sidecar has no OpenRouter config for Fantom's master slot. */
      enabled?: boolean;
      /** Restrict to these PCNames (`.local` optional). Empty = all. */
      allowList?: string[];
      /** Locally declared rows, used only while the sidecar side has not
       *  been configured. Embedding rows still face the compatibility gate. */
      declared?: Array<{
        sidecar: string;
        role: 'embedding' | 'code-embedding' | 'reranker';
        model: string;
        provider?: string;
        dims?: number;
        mode?: 'local-only' | 'local-first' | 'cloud-only';
      }>;
      /** Fantom's serverUrl as the sidecar records it, when matching on the
       *  master wsPort is not enough to identify our slot. */
      masterServerUrl?: string;
      pollIntervalMs?: number;
      /** Rerank model Fantom prefers. Default `qwen/qwen3-reranker-8b`,
       *  which the Sound Suite master slot already pins here and is the only
       *  reranker size on OpenRouter with a provider serving it. The
       *  sidecar's per-master allow-list stays authoritative; this is what we
       *  ask for. */
      rerankModel?: string;
      /** Send the preferred model as a hard requirement, so a sidecar
       *  allow-listing a different one refuses instead of substituting. */
      strictRerankModel?: boolean;
      /** In-flight depth per OR embedding provider (OpenRouter rate limits
       *  are per-account, not per-host). Default 8. */
      embedMaxInFlight?: number;
    };
    /** What Fantom pushes to the fleet as its own OpenRouter config. Never
     *  contains the API key — see src/sidecars/openRouterConfig.ts. */
    openRouter?: {
      allowedModels?: Record<string, { model: string; provider?: string; dims?: number; note?: string }>;
      modeByRole?: Record<string, 'local-only' | 'local-first' | 'cloud-only'>;
      keyPushed?: boolean;
      lastPushedAt?: string;
      lastPushedTo?: string[];
    };
    llmReranker?: {
      enabled: boolean;
      provider?: LLMProviderName;
      model?: string;
      topK?: number;
      fromSidecar?: boolean;   // route to sidecar capability `llm` instead of cloud provider
    };
    crossEncoderReranker?: {
      enabled: boolean;
      model?: string;     // e.g. 'Qwen/Qwen3-Reranker-8B'
      topK?: number;      // candidates to rerank (default 50)
    };
    /** Query-side instruction for instruction-tuned embedders. 'auto' (default)
     *  wraps only Qwen3-Embedding models; 'off' never; any other string is a
     *  custom task text. Documents are never re-embedded. */
    queryInstruction?: 'auto' | 'off' | string;
    /** Hybrid retrieval: RRF (k=60) of vector top-50 and FlexSearch symbol top-50. */
    hybrid?: { enabled: boolean; vectorWeight?: number; keywordWeight?: number };
    /** Cross-encoder rerank of the fused top-50. 'auto' (default) = on when a
     *  usable sidecar advertises capability `reranker`. */
    rerank?: 'auto' | 'on' | 'off';
    answerSynthesis?: {
      enabled: boolean;
      // 'auto' = server routes by query complexity (simple → sidecar qwen3.5:9b,
      // complex → groq llama-3.3-70b). Or pin a specific provider.
      provider?: 'auto' | 'groq' | 'anthropic' | 'gemini' | 'sidecar';
      model?: string;          // used when provider is pinned (not 'auto')
      heavyModel?: string;     // 'auto' complex path (default groq llama-3.3-70b-versatile)
      lightModel?: string;     // 'auto' simple path (default sidecar qwen3.5:9b)
      topK?: number;
      includeHistory?: boolean;
      maxContextChars?: number;
    };
  };
  cache: {
    enabled: boolean;
    maxAge: number;
  };
  auth: {
    accessTokenTtl: number;
    refreshTokenTtl: number;
    authCodeTtl: number;
  };
  sidecars?: Sidecar[];
  /** Port the Sound Suite master listener binds for sidecar WS connections.
   *  The sidecar's per-master wsPort must match this value. Default 3003. */
  sidecarMasterWsPort?: number;
  /** RSS-guard threshold in MB. Self-watchdog calls process.exit(137) when
   *  RSS exceeds this. Set 0 to disable. Default 4000. Takes effect on
   *  server restart (read at module load). */
  rssGuardMb?: number;
  /** Debug controls. Master switch + per-segment routing for in-process
   *  log file writes. When `enabled` is false, the server never opens a
   *  log file — only the shell-redirected stdout/stderr capture (handled
   *  by start-server.sh) reaches disk. Hot-reloaded: changes take effect
   *  on the next log line, no restart needed. */
  debug?: {
    /** Master switch. When false, no in-process file writes happen. */
    enabled?: boolean;
    /** Per-segment enable map. Keys are tags from createLogger(tag).
     *  When empty/unset and `enabled` is true, all segments write to
     *  a single combined `logs/all.log`. When populated, only listed
     *  tags emit per-segment files (`logs/<tag>.log`). Disabled tags
     *  produce no file output at all. */
    segments?: Record<string, boolean>;
    /** Minimum level routed to files. Defaults to 'info'. */
    levelMin?: 'debug' | 'info' | 'warn' | 'error';
    /** Gate for the synchronous crash-forensics path. Defaults to true
     *  when `enabled` is true so SIGKILL diagnostics survive. Operator
     *  can flip off explicitly to keep `logs/_crash.log` from growing. */
    captureCrash?: boolean;
    /** Per-file size cap in megabytes. When a log file reaches this
     *  size it is rotated to `<file>.1` (overwriting any prior `.1`)
     *  and a fresh empty file replaces it. Default 100 MB. Set 0 to
     *  disable rotation. Applies to both the async per-segment files
     *  and the sync crash-forensics file. */
    maxFileMb?: number;
  };
  /** Per-project overrides for the embedding model / sidecar. Lookups in
   *  selectEmbeddingProvider check this map first; entries fall back to the
   *  global codeModel / codeFromSidecar setting when missing. */
  projectEmbeddingOverrides?: Record<string, {
    model?: string;
    sidecarId?: string;
    dimensions?: number;
  }>;
  llmProviders?: {
    defaultProvider?: LLMProviderName;
    groq?: LLMProviderConfig;
    anthropic?: LLMProviderConfig;
    gemini?: LLMProviderConfig;
  };
  /** Axon MCP server integration (src/axon/axonSettings.ts holds the defaults).
   *  The embedding model is NOT configurable here — Axon vectors always use
   *  semanticSearch.codeModel / codeDimensions. */
  axon?: import('../axon/axonSettings.js').AxonSettings;
}

export interface UsageDatabaseInfo {
  path: string;
  size: number;
  toolEvents: number;
  searchEvents: number;
}

export interface CodeStats {
  totalFunctions: number;
  totalTypes: number;
  totalProjects: number;
  searchIndexSize: number;
  byCategory: Record<string, number>;
  byProject: Record<string, number>;
  lastUpdated: string;
}

export interface ReindexResult {
  success: boolean;
  project: {
    id: number;
    name: string;
  };
  indexResult: {
    functionsIndexed: number;
    typesIndexed: number;
    filesProcessed: number;
    errors: number;
    duration: number;
  };
}

// Re-export Fantom instance/pod types from fantom module
export type {
  FantomInstance,
  FantomPod,
  CompileLog,
  CompileRequest,
  CompileResult,
  CreateInstanceInput,
  UpdateInstanceInput,
  CreatePodInput,
  UpdatePodInput,
  InstanceType,
  CompileStatus,
  FantomInstanceSettings
} from '../fantom/types.js';

// Re-export backup types
export type {
  BackupInfo,
  BackupResult,
  RestoreResult,
  CreateBackupOptions,
  RestoreOptions,
} from '../backup/types.js';

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

  // MCP Explorer additions
  getAvailableTools: () => McpTool[];
  getSettings: () => FantomSettings;
  updateSettings: (settings: Partial<FantomSettings>) => Promise<void>;
  getUsageDatabaseInfo?: () => Promise<UsageDatabaseInfo>;
  clearUsageData?: () => Promise<void>;
  resetUsageDatabase?: () => Promise<void>;
  searchDocs?: (query: string, limit?: number) => Promise<unknown[]>;
  getPods?: () => string[];

  // Fantom Instance and Pod Management
  getFantomDatabase?: () => Promise<import('../fantom/database.js').FantomDatabase>;

  // Fantom Code Indexing
  reindexProject?: (projectId: number, opts?: { force?: boolean }) => Promise<ReindexResult>;
  getCodeStats?: () => CodeStats;
  reindexCode?: () => Promise<{ projectsEnabled: number; indexedFunctions: number }>;
  rebuildAllGraphs?: () => Promise<{ projects: number; totalNodes: number; totalEdges: number; resolved: number }>;

  // Backup/Restore
  createBackup?: (options?: import('../backup/types.js').CreateBackupOptions) => Promise<import('../backup/types.js').BackupResult>;
  listBackups?: () => Promise<import('../backup/types.js').BackupInfo[]>;
  getBackup?: (id: string) => Promise<import('../backup/types.js').BackupInfo | null>;
  getBackupPath?: (id: string) => Promise<string | null>;
  deleteBackup?: (id: string) => Promise<boolean>;
  restoreBackup?: (id: string, options: import('../backup/types.js').RestoreOptions) => Promise<import('../backup/types.js').RestoreResult>;

  // OAuth Token Grant (for auto-authentication)
  getOAuthProvider?: () => import('../auth/oauthProvider.js').FantomOAuthProvider | null;
}
