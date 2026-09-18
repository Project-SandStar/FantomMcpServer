// Get API base URL from localStorage or env
export function getApiBase(): string {
  if (typeof window !== 'undefined') {
    const serverUrl = localStorage.getItem('server_url');
    if (serverUrl) return serverUrl;
  }
  return process.env.NEXT_PUBLIC_API_URL || '';
}

// Set API base URL (stored in localStorage)
export function setApiBase(url: string): void {
  if (typeof window !== 'undefined') {
    if (url) {
      localStorage.setItem('server_url', url);
    } else {
      localStorage.removeItem('server_url');
    }
  }
}

// Dashboard settings interface
export interface DashboardSettings {
  serverUrl: string | null;
}

// Fetch dashboard settings from server (persisted across origins)
export async function fetchDashboardSettings(baseUrl?: string): Promise<DashboardSettings> {
  const apiBase = baseUrl || getApiBase();
  const username = typeof window !== 'undefined' ? localStorage.getItem('admin_user') || 'admin' : 'admin';
  const password = typeof window !== 'undefined' ? localStorage.getItem('admin_pass') || 'admin' : 'admin';
  const authHeader = 'Basic ' + btoa(`${username}:${password}`);

  const response = await fetch(`${apiBase}/admin/settings/dashboard`, {
    headers: {
      'Authorization': authHeader,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch dashboard settings: ${response.statusText}`);
  }

  return response.json();
}

// Save dashboard settings to server (persisted across origins)
export async function saveDashboardSettings(settings: { serverUrl: string | null }): Promise<{ success: boolean; serverUrl: string | null; message: string }> {
  const apiBase = getApiBase();
  const username = typeof window !== 'undefined' ? localStorage.getItem('admin_user') || 'admin' : 'admin';
  const password = typeof window !== 'undefined' ? localStorage.getItem('admin_pass') || 'admin' : 'admin';
  const authHeader = 'Basic ' + btoa(`${username}:${password}`);

  const response = await fetch(`${apiBase}/admin/settings/dashboard`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
    },
    body: JSON.stringify(settings),
  });

  if (!response.ok) {
    throw new Error(`Failed to save dashboard settings: ${response.statusText}`);
  }

  return response.json();
}

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
}

async function apiRequest<T>(endpoint: string, options: ApiOptions = {}): Promise<T> {
  const { method = 'GET', body } = options;
  const apiBase = getApiBase();

  const username = typeof window !== 'undefined' ? localStorage.getItem('admin_user') || 'admin' : 'admin';
  const password = typeof window !== 'undefined' ? localStorage.getItem('admin_pass') || 'admin' : 'admin';
  const authHeader = 'Basic ' + btoa(`${username}:${password}`);

  const response = await fetch(`${apiBase}/admin${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Authentication required');
    }
    throw new Error(`API error: ${response.statusText}`);
  }

  return response.json();
}

// ============================================
// Type Definitions
// ============================================

export interface ServerStatus {
  status: 'running' | 'starting' | 'error';
  uptime: number;
  memory: { used: number; total: number; percentage: number; heapTotal?: number; rss?: number; external?: number };
  initialized: boolean;
  version: string;
  serverPath: string;
  port: number;
  stats: { docsIndexed: number; activeSessions: number };
}

export interface CacheInfo {
  name: string;
  path: string;
  size: number;
  lastModified: string;
  age: number;
  storageType?: 'json-cache' | 'sqlite' | 'lancedb';
  metadata?: {
    version: string;
    source: string;
    itemCount: number;
    timestamp: number;
    byType?: Record<string, number>;
    byPod?: Record<string, number>;
  };
}

export interface McpTool {
  name: string;
  description: string;
  category: string;
  mcpExposed?: boolean;
  inputSchema: {
    type: string;
    properties: Record<string, {
      type: string;
      description?: string;
      enum?: string[];
      default?: unknown;
    }>;
    required?: string[];
  };
}

export interface ToolsResponse {
  count: number;
  tools: McpTool[];
}

export interface FantomSettings {
  port: number;
  cacheDir: string;
  searchSettings: {
    maxResults: number;
    minScore: number;
    useOrLogic?: boolean;
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
    parallelProjects?: number;
    llmReranker?: {
      enabled: boolean;
      provider?: LLMProviderName;
      model?: string;
      topK?: number;
      fromSidecar?: boolean;
    };
    crossEncoderReranker?: {
      enabled: boolean;
      model?: string;
      topK?: number;
    };
    /** 'auto' = Qwen3-Embedding models get "Instruct: …\nQuery: …" on the query; 'off' never; other string = custom task. */
    queryInstruction?: 'auto' | 'off' | string;
    /** RRF (k=60) fusion of vector top-50 and FlexSearch symbol top-50. */
    hybrid?: { enabled: boolean; vectorWeight?: number; keywordWeight?: number };
    /** Cross-encoder over the fused top-50: 'auto' = when a `reranker` sidecar is usable. */
    rerank?: 'auto' | 'on' | 'off';
    answerSynthesis?: {
      enabled: boolean;
      provider?: 'auto' | 'groq' | 'anthropic' | 'gemini' | 'sidecar';
      model?: string;
      heavyModel?: string;
      lightModel?: string;
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
  sidecarMasterWsPort?: number;
  rssGuardMb?: number;
  debug?: {
    enabled?: boolean;
    segments?: Record<string, boolean>;
    levelMin?: 'debug' | 'info' | 'warn' | 'error';
    captureCrash?: boolean;
    maxFileMb?: number;
  };
  llmProviders?: {
    defaultProvider?: LLMProviderName;
    groq?: LLMProviderConfig;
    anthropic?: LLMProviderConfig;
    gemini?: LLMProviderConfig;
  };
  /** Axon MCP server integration. Embedding model is NOT here: Axon vectors
   *  always use semanticSearch.codeModel / codeDimensions. */
  axon?: AxonSettings;
}

// ============================================
// Axon integration
// ============================================

export type AxonRecordSource = 'proj' | 'library';

/** One exclusive in-process lock shared by code re-embed, forced code reindex and Axon index jobs. */
export interface HeavyJobHolder {
  kind: 'code-reembed' | 'code-reindex' | 'axon-index';
  label: string;
  since: string;
}

export interface AxonSettings {
  projectPath: string;
  libraryPath: string;
  enabled: boolean;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  url: string;
  autoIndex: boolean;
}

export interface AxonMcpStatus {
  enabled: boolean;
  connected: boolean;
  connecting: boolean;
  transport: 'stdio' | 'http';
  projectPath: string;
  command?: string;
  url?: string;
  toolCount: number;
  toolNames: string[];
  lastError?: string;
  lastConnectedAt?: string;
  lastDisconnectedAt?: string;
  reconnectAttempts: number;
  serverInfo?: { name?: string; version?: string };
  pid?: number;
}

export interface AxonTableStats {
  exists: boolean;
  rows: number;
  schemaCurrent?: boolean;
  tableDimensions?: number;
  tableModel?: string;
  configuredModel: string;
  configuredDimensions: number;
  dimsMismatch: boolean;
  modelMismatch: boolean;
  /** Layout version recorded on the rows, and whether it is behind the code. */
  tableTextVersion?: number;
  textVersionStale?: boolean;
}

export interface AxonJob {
  id: string;
  kind: 'axon-index';
  scope: { projectId?: string; source?: AxonRecordSource | 'all'; force: boolean };
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  projectsTotal: number;
  projectsDone: number;
  currentProject?: string;
  functionsTotal: number;
  functionsEmbedded: number;
  model: string;
  dimensions: number;
  providers: string[];
  errors: Array<{ projectId?: string; message: string; at: string }>;
  cancelRequested?: boolean;
  /** While queued: the heavy job (code re-embed / forced reindex) it waits for. */
  waitingFor?: HeavyJobHolder | null;
}

export interface AxonStatusResponse {
  settings: AxonSettings;
  mcp: AxonMcpStatus;
  embedding: {
    model: string; dimensions: number; embedTextVersion: number;
    grammar?: { ready: boolean; loadedFrom: string | null; error: string | null };
  };
  table: AxonTableStats;
  totals: { projects: number; functions: number; vectors: number; embeddedPercent: number };
  activeJob: AxonJob | null;
  heavyJob?: HeavyJobHolder | null;
  heavyJobQueue?: HeavyJobHolder[];
}

export interface AxonValidateResponse {
  projectPath: string;
  exists: boolean;
  packageJson: boolean;
  serverEntry: boolean;
  projDir: string;
  projExists: boolean;
  instances: string[];
  projects: Array<{ projectId: string; instance: string; project: string; functionCount: number; lastSync?: string }>;
  totalFunctions: number;
  problems: string[];
}

export interface AxonLibraryValidateResponse {
  kind: 'library';
  libraryPath: string;
  exists: boolean;
  folders: Array<{ projectId: string; project: string; functionCount: number }>;
  totalFunctions: number;
  problems: string[];
}

export interface AxonProjectStatus {
  projectId: string;
  source: AxonRecordSource;
  instance: string;
  project: string;
  functionsFound: number;
  vectors: number;
  rows: number;
  embeddedPercent: number;
  lastRun?: string;
  lastSync?: string;
  model?: string;
  dimensions?: number;
  embedTextVersion?: number;
  embedTextStale?: boolean;
  errors: string[];
}

export interface AxonProjectsResponse {
  projDir: string;
  libraryDir: string;
  projects: AxonProjectStatus[];
  totals: { projects: number; functions: number; vectors: number; embeddedPercent: number };
  bySource: Record<AxonRecordSource, { projects: number; functions: number; vectors: number; embeddedPercent: number }>;
  table: AxonTableStats;
  embedTextVersion: number;
}

export interface AxonFunctionRow {
  id: string;
  name: string;
  signature: string;
  params: string[];
  returnType?: string;
  doc: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  tags: string[];
  calls: string[];
  calledBy: string[];
  embedded: boolean;
  modified?: string;
}

export interface AxonFunctionsResponse {
  projectId: string;
  total: number;
  page: number;
  pageSize: number;
  embedded: number;
  functions: AxonFunctionRow[];
}

export interface AxonSearchResult {
  nodeId: string;
  source: AxonRecordSource;
  name: string;
  qualifiedName: string;
  nodeType: 'axon-function';
  filePath: string;
  lineStart: number;
  lineEnd: number;
  signature?: string;
  documentation?: string;
  params?: Array<{ name: string; type?: string; default?: string; required: boolean }>;
  returnType?: string;
  tags?: string[];
  projectId: string;
  instance: string;
  project: string;
  semanticScore: number;
  graphScore: number;
  combinedScore: number;
  rerankScore?: number;
}

export interface AxonSearchResponse {
  query: string;
  mode: 'vector' | 'rerank' | 'rlm';
  source: 'axon';
  count: number;
  results: AxonSearchResult[];
  model: string;
  degraded?: 'no-reranker' | 'no-rlm' | 'empty-table';
  answer?: string;
  citations?: Array<{ nodeId: string; source: AxonRecordSource; qualifiedName: string; filePath: string; lineStart: number; project: string }>;
  provider?: string;
  rlm?: { model: string | null; rounds: number; toolCalls: number };
}

export type SidecarCapabilityKind = 'embedding' | 'embedding-code' | 'llm' | 'reranker' | 'ocr' | 'rlm';
export type LLMProviderName = 'groq' | 'anthropic' | 'gemini';

export interface SidecarCapabilityState {
  available: boolean;
  models: string[];
  loaded?: string | null;
  gpuPercent?: number;
  endpoint?: string;
  port?: number;
}

export type VirtualRole = 'embedding' | 'code-embedding' | 'reranker' | 'code-assistant' | 'rlm';
export type VirtualRoutingMode = 'local-only' | 'local-first' | 'cloud-only';

/**
 * An OpenRouter-backed provider — cloud capacity a sidecar serves for a role
 * instead of its local model. It hangs off a host but is NOT that host's GPU:
 * no VRAM, no gpuPercent. Named `<PCName>-OR-<Role>`.
 */
export interface VirtualContainer {
  sidecarId: string;
  sidecarName: string;
  providerName: string;
  role: VirtualRole;
  model: string;
  /** Pinned upstream. Required for embedding roles; rerank needs none. */
  upstreamProvider?: string;
  dims?: number;
  mode: VirtualRoutingMode;
  source: 'sidecar' | 'config';
  served?: number;
  lastServedAt?: number | null;
  failures?: number;
  lastError?: string | null;
  lastDurationMs?: number | null;
  state?: 'idle' | 'serving' | 'failed';
  /** Master slot this row belongs to — always Fantom's own. */
  serverUrl?: string;
  cloudBacked?: true;
}

/**
 * Whether a sidecar has OpenRouter configured for FANTOM's master slot.
 * `unset` is the usual reason the virtual list is empty: the sidecar scopes
 * its key and allow-list per master, so capacity configured for another
 * master is deliberately unusable here.
 */
export interface MasterSlotStatus {
  sidecarId: string;
  serverUrl?: string;
  openrouter: string;
  at: number;
}

/**
 * A vector-space verdict. Distinct from `Sidecar.embedFault`, which is a
 * TTL-expiring RUNTIME fault — a vector verdict never expires, because
 * "these vectors are not interchangeable" does not become false after an hour.
 */
export interface VectorVerification {
  key: string;
  providerName: string;
  ok: true;
  /** Absent for a SOLE cloud provider under "OpenRouter only": there was no
   *  peer to compare it with, so no cosine was measured. */
  minCosine?: number;
  meanCosine?: number;
  dims: number;
  samples: number;
  at: string;
  /** What the verdict was reached against — a local host, or a cloud peer
   *  under "OpenRouter only". The two are different claims. */
  reference?: VerificationRegime;
  referenceName?: string;
}

export type VerificationRegime = 'local-ref' | 'cloud-ref';

export interface VectorRefusal {
  key: string;
  providerName: string;
  kind: 'vector-incompatible' | 'dimension-mismatch' | 'no-provider-pin' | 'probe-failed';
  reason: string;
  at: string;
  minCosine?: number;
  dims?: number;
  reference?: VerificationRegime;
  referenceName?: string;
}

export interface CompatibilityReport {
  key: string;
  providerName: string;
  ok: boolean;
  minCosine?: number;
  meanCosine?: number;
  dims?: number;
  expectedDims: number;
  samples: number;
  reason: string;
  cosines?: number[];
  reference?: VerificationRegime;
  referenceName?: string;
}

export interface OpenRouterRoleConfig {
  model: string;
  provider?: string;
  dims?: number;
  note?: string;
}

export interface OpenRouterSettings {
  allowedModels: Partial<Record<VirtualRole, OpenRouterRoleConfig>>;
  modeByRole: Partial<Record<VirtualRole, VirtualRoutingMode>>;
  /** Whether a key has ever been pushed. Never the key itself. */
  keyPushed?: boolean;
  keyLast4?: string;
  lastPushedAt?: string;
  lastPushedTo?: string[];
}

export interface OpenRouterIssue { role?: VirtualRole; message: string }
export interface OpenRouterPushResult { sidecarId: string; name: string; pushed: boolean; reason?: string }

/** One role's dropdown: options already formatted "<Label> · <dims>d [· drop-in]". */
export interface OpenRouterCatalogueEntry {
  role: VirtualRole;
  label: string;
  options: Array<{ id: string; label: string; dims?: number }>;
  /** The line under the picker: local model, width, re-index consequence. */
  hint: string;
  /** False for a role the sidecar can be configured for but cannot yet serve. */
  servable?: boolean;
}

export interface OpenRouterRoleActivity {
  role: VirtualRole;
  callsToday: number;
  tokensToday: number;
  spendTodayUsd: number;
  inFlight: number;
  lastCall: { at: number; durationMs: number; success: boolean; servedBy: string; error?: string } | null;
  callsByServedBy: Record<string, number>;
  dailyCapUsd?: number;
  capped: boolean;
}

/** The global permit pool. The unit is CONCURRENT CLOUD REQUESTS. */
export interface CloudBudgetStats {
  effectiveConcurrency: number;
  ceilingConcurrency: number;
  inFlight: number;
  queued: number;
  queuedProjects: number;
  state: 'steady' | 'ramping' | 'backing-off';
  rateLimitHits: number;
  /** What `/key`'s `rate_limit` implied, verbatim — believable or not. */
  discoveredRequestsPerMinute: number | null;
  /** The RPM actually gated on. null when nothing was discovered, or when what
   *  was discovered is not believed for a funded account. */
  enforcedRequestsPerMinute?: number | null;
  /** False when a reported RPM was discarded as implausible (a $100 account
   *  reporting 1/min, which held the whole cloud fan-out to one request a
   *  minute until it was distrusted). */
  rateLimitTrusted?: boolean;
  discoveredConcurrency: number | null;
  /** Ceiling implied by the account holding credits, when no rate figure is
   *  believable. */
  creditsDerivedConcurrency?: number | null;
  manualConcurrency: number | null;
  source: 'manual' | 'discovered' | 'credits' | 'fallback';
  /** One sentence naming where the ceiling came from. Render it — a budget
   *  number with no stated provenance is how a 1/min limit survived. */
  sourceDetail?: string;
  meanLatencyMs: number;
  requestsLastMinute: number;
  backoffUntil: string | null;
  discovery: {
    ok: boolean; reason?: string; unsupported?: boolean; at: string | null;
    /** `/key`'s `rate_limit` exactly as OpenRouter returned it. */
    rawRateLimit?: unknown;
    envelopeKeys?: string[];
  };
  credits: { remaining: number | null; totalCredits: number | null; totalUsage: number | null } | null;
  unit?: string;
  maxAllowed?: number;
  conservativeDefault?: number;
}

export interface OpenRouterActivityResponse {
  nowMs: number;
  activity: OpenRouterRoleActivity[];
  spendToday: number;
  dailyCaps: Partial<Record<VirtualRole, number>>;
  budget: CloudBudgetStats;
  lastRerank: {
    path: 'local' | 'openrouter'; servedBy: string; model: string; at: string; ms: number;
    localProbeTtlMs: number; localProbeNote: string;
  } | null;
}

/**
 * The operator-facing routing choice. The sidecar's
 * local-only/local-first/cloud-only vocabulary is an implementation detail and
 * is never rendered — see src/sidecars/routingPolicy.ts.
 */
export type RoutingPolicy = 'aggregate' | 'backup' | 'local' | 'cloud';

export interface PolicyDrift {
  role: VirtualRole;
  policy: RoutingPolicy;
  wantMode: string;
  /** What the fleet actually reports, where it disagrees. */
  actualModes: string[];
  /** Stored, but never reached the sidecars — so NOT in effect. */
  pending: boolean;
}

export interface PolicyNote {
  role: VirtualRole;
  /** False for the reranker: one call, nothing to spread across providers. */
  aggregateMeaningful: boolean;
  joinsFanOut: boolean;
}

export interface OpenRouterConfigResponse {
  settings: OpenRouterSettings;
  isDefault: boolean;
  keyPushed: boolean;
  /** Last 4 chars of the stored key, for the masked placeholder. Never the key. */
  keyLast4: string | null;
  /** Cloud routing is opt-in; while false everything stays local. */
  enabled: boolean;
  catalogue: OpenRouterCatalogueEntry[];
  policyByRole: Partial<Record<VirtualRole, RoutingPolicy>>;
  policyOptions: Array<{ id: RoutingPolicy; label: string }>;
  /**
   * The choices to offer for each role. Every role now offers all four;
   * the per-role shape stays because it is the hook for the next policy that
   * is legal for one role and not another.
   */
  policyOptionsByRole?: Partial<Record<VirtualRole, Array<{ id: RoutingPolicy; label: string }>>>;
  policyDrift: PolicyDrift[];
  policyNotes: PolicyNote[];
  /**
   * Who produced the rows now in code_vectors, from
   * projectEmbeddingMeta.servedBy. Choosing "OpenRouter only" invalidates
   * every locally-built one, so this is what lets the panel say how much work
   * is at stake instead of warning in the abstract.
   */
  storedVectorOrigin: {
    local: { providers: string[]; texts: number; projects: number };
    cloud: { providers: string[]; texts: number; projects: number };
  };
  codeTableDims: number;
  /**
   * The width each embedding table is committed to. LanceDB locks the vector
   * column at creation, so a model of a different width cannot write into the
   * table — this is what the width warning under each picker is computed from.
   */
  tableDims?: Partial<Record<VirtualRole, number>>;
  /**
   * RLM sandbox fallback — this master's own setting. `wired: false` while
   * Fantom's ss-rlm-sandbox half is unimplemented, so the panel badges the
   * controls rather than presenting them as live.
   */
  rlm?: {
    wired: boolean;
    model: string;
    mode: 'local-only' | 'local-first';
    options: Array<{ id: string; label: string }>;
    modeOptions: Array<{ id: 'local-only' | 'local-first'; label: string }>;
    hint: string;
  };
  activity: OpenRouterRoleActivity[];
  spendToday: number;
  dailyCaps: Partial<Record<VirtualRole, number>>;
  budget: CloudBudgetStats;
  issues: OpenRouterIssue[];
  masterWsPort: number;
  masterServerUrl: string | null;
  slots: MasterSlotStatus[];
  virtual: VirtualContainer[];
  sidecars: Array<{ id: string; name: string; host: string; port: number; wsConnected: boolean }>;
}

export interface SidecarListResponse {
  sidecars: Sidecar[];
  total: number;
  virtual?: VirtualContainer[];
  virtualTotal?: number;
  masterWsPort?: number;
  slots?: MasterSlotStatus[];
  lastRerank?: { path: 'local' | 'openrouter'; servedBy: string; model: string; at: string; ms: number } | null;
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
  /** Set while the sidecar's runtime refuses to embed with its advertised model. */
  embedFault?: {
    kind: string;
    model: string;
    code: 'embeddings-unsupported' | 'model-missing' | 'other';
    reason: string;
    remedy: string;
    at: string;
    expiresAt: string;
    occurrences: number;
  } | null;
  responseTimeMs?: number;
  activeRequests?: number;
  wsConnected?: boolean;
}

export interface LLMProviderConfig {
  enabled: boolean;
  model?: string;
}

export interface LoadedModelInfo {
  name: string;
  size?: string;
  gpuPercent?: number;
  processor?: string;
  until?: string;
}

export interface SidecarContainerInfo {
  name: string;
  status: string;
  image?: string;
  model?: string | null;
  type?: 'ollama' | 'vllm' | 'utility';
  config?: { image?: string; model?: string | null; port?: number; vram?: number; type?: string; gpuOnly?: boolean };
  loadedModels?: LoadedModelInfo[];
}

export interface SidecarStatusSnapshot {
  agentUrl?: string;
  hostname?: string;
  mode?: string;
  containers?: Record<string, SidecarContainerInfo>;
  roles?: Record<string, { activeRequests?: number; idleTimerActive?: boolean; lastAcquire?: string | null; lastRelease?: string | null }>;
  gpus?: Array<{ index: number; name?: string; memoryMb?: number; tempC?: number }>;
  vram?: { totalMb: number; freeMb: number; usedMb: number; perRole?: Record<string, { actualMb: number; budgetMb: number; priority?: string; gpuOnly?: boolean }> };
  freeVram?: number;
  totalVram?: number;
  containerNames?: string[];
  version?: string;
}

export type AutoPipelinePhase = 'idle' | 'waiting-for-sidecar' | 'running' | 'done';

export interface FailedProject {
  projectId: number;
  projectName: string;
  error: string;
  at: string;
}

export interface AutoPipelineStatus {
  running: boolean;
  currentPhase: AutoPipelinePhase;
  totalProjects: number;
  doneProjects: number;
  skipped: number;
  currentProjectId?: number;
  currentProjectName?: string;
  currentNodes?: number;
  currentSidecarName?: string;
  currentSidecarHost?: string;
  currentSidecarModel?: string;
  totalProcessed: number;
  totalErrors: number;
  failedProjects: FailedProject[];
  sidecarWaitDeadline?: string;
  sidecarReady?: boolean;
  startedAt?: string;
  finishedAt?: string;
  recentEvents?: Array<{
    ts: string;
    kind: string;
    projectId?: number;
    projectName?: string;
    message: string;
    sidecar?: string;
  }>;
  staleMs?: number;
  lastProgressAt?: string;
  /** Human phase: 'idle' | 'running' | 'embedding (project N)' | 're-embed (full|project N)'. */
  phaseLabel?: string;
  /** Heavy-job lock holder (code-reembed | code-reindex | axon-index) and FIFO queue. */
  heavyJob?: HeavyJobHolder | null;
  heavyJobQueue?: HeavyJobHolder[];
  /** buildProjectEmbeddings runs in flight (pipeline-owned or standalone). */
  activeRuns?: Array<{
    projectId: number; projectName?: string; total: number; processed: number; errors: number;
    startedAt: string; sidecar?: string; pipelineOwned: boolean;
  }>;
  /** Running background re-embed job overlaid by the server (see /vectors/re-embed/jobs). */
  reembedJob?: {
    id: string; scope: 'all' | { projectId: number }; status: string; startedAt: string;
    totalProjects: number; doneProjects: number; currentProjectId?: number; currentProjectName?: string;
    generated: number; deleted: number; errors: number; model?: string; dimensions?: number; cancelRequested: boolean;
  };
}

export interface ReembedJob {
  id: string;
  scope: 'all' | { projectId: number };
  /**
   * `paused` keeps the shadow and stays resumable; `cancelled` means the
   * shadow was discarded. Both halt the loop — the difference is entirely
   * whether the banked vectors survive.
   */
  status: 'queued' | 'running' | 'paused' | 'done' | 'error' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  totalProjects: number;
  doneProjects: number;
  currentProjectId?: number;
  generated: number;
  deleted: number;
  errors: Array<{ projectId: number; message: string }>;
  model?: string;
  dimensions?: number;
  droppedTableForDimChange?: boolean;
  previousDimensions?: number | null;
  /** Halt AND discard the shadow. The only destructive flag. */
  cancelRequested: boolean;
  /** Halt and KEEP the shadow. */
  pauseRequested: boolean;
  resumed?: boolean;
  skippedProjects?: number;
  shadowTable?: string | null;
  errorMessage?: string;
}

export interface SidecarHealth {
  id: string;
  status: 'healthy' | 'unhealthy';
  lastHealthCheck: string;
  responseTimeMs: number;
  error?: string;
}

export interface LLMProvidersResponse {
  defaultProvider: LLMProviderName | null;
  groq: { enabled: boolean; model: string | null; apiKey: string | null; hasKey: boolean };
  anthropic: { enabled: boolean; model: string | null; apiKey: string | null; hasKey: boolean };
  gemini: { enabled: boolean; model: string | null; apiKey: string | null; hasKey: boolean };
}

export interface RecentSearch {
  query: string;
  source: string;
  resultCount: number;
  timestamp: string;
}

export interface UsageStats {
  totalToolCalls: number;
  totalSearches: number;
  toolUsage: Record<string, number>;
  topSearches: Array<{ query: string; count: number }>;
  recentSearches: RecentSearch[];
  periodStart: string;
  periodEnd: string;
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
  projectsEnabled: number;
  indexedFunctions: number;
}

export interface BackfillLadybugProjectResult {
  projectId: number;
  projectName: string;
  prismaNodes: number;
  prismaEdges: number;
  ladybugNodesCreated: number;
  ladybugNodesSkipped: number;
  ladybugEdgesCreated: number;
  ladybugEdgesSkipped: number;
  orphanEdgesDropped: number;
  durationMs: number;
  error?: string;
}

export interface BackfillLadybugResult {
  success: boolean;
  dryRun: boolean;
  projectCount: number;
  totalDurationMs: number;
  totals: {
    prismaNodes: number;
    prismaEdges: number;
    ladybugNodesCreated: number;
    ladybugEdgesCreated: number;
    orphanEdgesDropped: number;
    failed: number;
  };
  results: BackfillLadybugProjectResult[];
}

export interface DocSearchResult {
  name: string;
  qualifiedName: string;
  type: string;
  pod: string;
  description: string;
  url: string;
  score: number;
}

export interface PodsResponse {
  count: number;
  pods: string[];
}

// ============================================
// Fantom Instance and Pod Types
// ============================================

export type InstanceType = 'fantom' | 'skyspark' | 'haxall';

export interface FantomInstance {
  id: number;
  name: string;
  path: string;
  type: InstanceType;
  version?: string;
  fanExecutable: string;
  description?: string;
  sourcePath?: string;
  fantomVersion?: string;       // Fantom version used by this instance (e.g., "1.0.82")
  fantomSourcePath?: string;    // Path to Fantom source (e.g., "~/fantom/fantom-1.0.82")
  docSourceInstanceId?: number; // For Haxall: reference to SkySpark instance for documentation
  isValid: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateInstanceInput {
  name: string;
  path: string;
  type?: InstanceType;
  version?: string;
  fanExecutable?: string;
  description?: string;
  sourcePath?: string;
  fantomVersion?: string;
  fantomSourcePath?: string;
  docSourceInstanceId?: number | null;
}

// Response from GET /admin/instances/skyspark
export interface SkySarkInstancesResponse {
  instances: FantomInstance[];
  matchingVersion: FantomInstance[];
  otherVersions: FantomInstance[];
}

// Fantom Version types
export interface FantomVersion {
  version: string;
  path: string;
  hasSource: boolean;
}

export interface DetectFantomVersionResult {
  detectedVersion: string | null;
  sourceAvailable: boolean;
  sourcePath: string | null;
}

// Fantom Build types (for source code indexing)
export interface FantomBuild {
  id: number;
  version: string;
  path: string;
  hasSource: boolean;
  podCount: number;
  functionCount: number;
  typeCount: number;
  lastIndexed?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FantomBuildProject {
  id: number;
  name: string;
  path: string;
  podName?: string;
  functionCount: number;
  typeCount: number;
  lastIndexed?: string;
}

export interface CreateFantomBuildInput {
  version: string;
  path: string;
  hasSource?: boolean;
  isActive?: boolean;
}

export interface FantomBuildIndexResult {
  success: boolean;
  buildId: number;
  version: string;
  podsIndexed: number;
  totalFunctions: number;
  totalTypes: number;
  duration: number;
  errors: string[];
  podStats: Array<{
    podName: string;
    projectId: number;
    functionsIndexed: number;
    typesIndexed: number;
  }>;
}

export interface FantomPod {
  id: number;
  name: string;
  path: string;
  buildFile: string;
  description?: string;
  defaultInstanceId?: number;
  compatMinVersion?: string;  // Minimum compatible version e.g., "3.1.10"
  compatMaxVersion?: string;  // Maximum compatible version e.g., "3.1.12"
  compatVersions?: string[];  // Specific compatible versions e.g., ["3.1.10", "3.1.11", "3.1.12"]
  createdAt: string;
  updatedAt: string;
}

// FantomProject rows that don't have a backing FantomPod — surfaced on the
// Pods & Projects page so MCP-added or non-Fantom code projects are visible.
export interface OrphanProject {
  id: number;
  name: string;
  path: string;
  podName: string | null;
  instanceId: number | null;
  language: string;
  parserType: string;
  description: string | null;
  autoIndex: boolean;
  functionCount: number;
  typeCount: number;
  lastIndexed: string | null;
}

// Pod with instance info (for grouped display)
export interface FantomPodWithInstance extends FantomPod {
  instance?: {
    id: number;
    name: string;
    type: InstanceType;
    version?: string;
  };
}

export interface CreatePodInput {
  name: string;
  path: string;
  buildFile?: string;
  description?: string;
  defaultInstanceId?: number;
  compatMinVersion?: string;  // Minimum compatible version e.g., "3.1.10"
  compatMaxVersion?: string;  // Maximum compatible version e.g., "3.1.12"
  compatVersions?: string[];  // Specific compatible versions e.g., ["3.1.10", "3.1.11", "3.1.12"]
}

export interface CompileLog {
  id: number;
  podId: number;
  instanceId: number;
  buildFile: string;
  status: 'success' | 'failure' | 'running';
  output?: string;
  error?: string;
  durationMs?: number;
  startedAt: string;
  completedAt?: string;
}

export interface CompileResult {
  success: boolean;
  logId: number;
  output: string;
  error?: string;
  durationMs: number;
}

// ============================================
// Local Documentation Types
// ============================================

export interface DocPodInfo {
  name: string;
  category: 'core' | 'lib' | 'doc';
  fileCount: number;
  isAxonLib?: boolean;
}

export interface DocStatus {
  instanceId: number;
  hasCache: boolean;
  cacheFile?: string;
  itemCount?: number;
  lastIndexed?: string;
  docPath?: string;
  podCount?: number;
}

export interface DocIndexResult {
  success: boolean;
  instanceId: number;
  version?: string;
  itemCount: number;
  duration: number;
  podStats: Record<string, number>;
  errors: string[];
}

export interface DocRetrievalInfo {
  source: 'keyword' | 'vector' | 'both';
  keywordRank: number | null;
  vectorRank: number | null;
  keywordScore: number;
  vectorScore: number;
  fusedScore: number;
}

export interface LocalDocItem {
  name: string;
  qualifiedName: string;
  type: 'type' | 'function' | 'tag' | 'slot' | 'chapter';
  pod: string;
  description: string;
  signature?: string;
  url: string;
  language: 'fantom' | 'axon';
  instanceId?: number;
  version?: string;
  retrieval?: DocRetrievalInfo;
}

export interface LocalDocSearchResult {
  query: string;
  instanceId?: number;
  count: number;
  searchMethod?: 'keyword-only' | 'hybrid';
  keywordMatches?: number;
  vectorMatches?: number;
  vectorsAvailable?: number;
  results: LocalDocItem[];
}

export interface EmbedJobProgress {
  jobId: string;
  status: 'running' | 'completed' | 'error' | 'none';
  startedAt?: number;
  completedAt?: number;
  currentInstance?: number;
  instancesTotal: number;
  instancesDone: number;
  totalEmbedded: number;
  totalSkipped: number;
  totalAlreadyExists: number;
  totalItems: number;
  processedItems: number;
  results: Array<{
    instanceId: number;
    totalItems: number;
    embedded: number;
    skipped: number;
    alreadyExists: number;
    duration: number;
    error?: string;
  }>;
  error?: string;
}

// ============================================
// Source Code Indexing Types (Haxall/SkySpark)
// ============================================

export interface SourceStatus {
  instanceId: number;
  hasSourcePath: boolean;
  sourcePath?: string;
  hasCache: boolean;
  cacheFile?: string;
  lastIndexed?: string;
  podCount?: number;
  totalFunctions?: number;
  totalTypes?: number;
}

export interface SourcePodInfo {
  name: string;
  path: string;
  fileCount: number;
  functionCount: number;
  typeCount: number;
}

export interface SourceIndexResult {
  success: boolean;
  instanceId: number;
  sourcePath: string;
  podsIndexed: number;
  totalFunctions: number;
  totalTypes: number;
  duration: number;
  errors?: string[];
  results?: Array<{
    podName: string;
    projectId: number;
    action: 'created' | 'reindexed';
    functionsIndexed: number;
    typesIndexed: number;
  }>;
  diagnostics?: {
    totalDirectories: number;
    skippedCount: number;
    skipped: Array<{ name: string; reason: string }>;
    expectedStructure: string;
  };
}

// ============================================
// AST Cache Types
// ============================================

export interface AstParameter {
  name: string;
  type: string;
  defaultValue?: string;
}

export interface AstFunction {
  id: string;
  name: string;
  qualifiedName: string;
  type: 'method' | 'field' | 'constructor';
  className?: string;
  filePath: string;
  lineNumber?: number;
  signature?: string;
  returnType?: string;
  parameters: AstParameter[];
  description?: string;
  category: string;
  isPublic: boolean;
  isStatic: boolean;
  isAbstract: boolean;
}

export interface AstType {
  id: string;
  name: string;
  qualifiedName: string;
  kind: 'class' | 'mixin' | 'enum' | 'facet';
  filePath: string;
  lineNumber?: number;
  extends?: string;
  mixins: string[];
  isPublic: boolean;
  isAbstract: boolean;
  documentation?: string;
  methodCount: number;
  fieldCount: number;
}

export interface PodAstData {
  podId: number;
  podName: string;
  podPath: string;
  hasAstCache: boolean;
  message?: string;
  projectId?: number;
  projectName?: string;
  lastIndexed?: string;
  summary?: {
    totalFunctions: number;
    totalTypes: number;
    totalClasses: number;
  };
  types?: AstType[];
  functions?: AstFunction[];
  functionsByClass?: Record<string, AstFunction[]>;
}

export interface CreateAstCacheResult {
  success: boolean;
  message: string;
  projectId: number;
  indexResult?: {
    functionsIndexed: number;
    typesIndexed: number;
    filesProcessed: number;
    errors: number;
    duration: number;
  };
}

export interface CodeSample {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
}

export type SourceType = 'pod' | 'source' | 'fantom-build';

export type ParserType = 'regex' | 'tree-sitter-wasm' | 'tree-sitter';
export type ProjectLanguage = 'fantom' | 'typescript' | 'javascript' | 'python' | 'java' | 'go' | 'rust' | 'dart' | 'polymer' | string;

export interface AstCacheOverview {
  count: number;
  pods: Array<{
    podId: string;  // Stable ID format: {podName}-{minVersion}-{maxVersion} or fantom.{version}.{podName}
    podName: string;
    podPath: string;
    hasAstCache: boolean;
    projectId?: number;
    lastIndexed?: string;
    sourceType?: SourceType;
    language?: ProjectLanguage;       // Language: fantom, typescript, dart, etc.
    parserType?: ParserType;          // Parser: regex or tree-sitter-wasm
    instanceId?: number;
    instanceName?: string;
    instanceType?: string;
    instanceVersion?: string;
    compatMinVersion?: string;   // Minimum compatible version e.g., "3.1.10"
    compatMaxVersion?: string;   // Maximum compatible version e.g., "3.1.12"
    fantomBuildId?: number;
    fantomBuildVersion?: string;
    summary?: {
      totalFunctions: number;
      totalTypes: number;
      totalClasses: number;
    };
  }>;
}

// Language breakdown for multi-language projects
export interface LanguageBreakdown {
  language: string;
  fileCount: number;
  functionCount: number;
  typeCount: number;
  sampleFiles: string[];
  sampleCode?: string;
}

export interface LanguageBreakdownResponse {
  projectId: number;
  projectName: string;
  totalFiles: number;
  totalFunctions: number;
  totalTypes: number;
  primaryLanguage: string;
  parserType: string;
  languages: LanguageBreakdown[];
}

// Tree-sitter function extraction result
export interface ExtractedFunctionItem {
  name: string;
  qualifiedName: string;
  type: 'function' | 'method' | 'class' | 'interface';
  filePath: string;
  lineStart: number;
  lineEnd: number;
  signature?: string;
  language: string;
}

export interface ExtractFunctionsResponse {
  success: boolean;
  mode: 'single' | 'project';
  projectPath?: string;
  languages?: string[];
  filesProcessed: number;
  filesFound: number;
  functions: ExtractedFunctionItem[];
  totalParseTime: number;
  errors?: Array<{ file: string; errors: any[] }>;
}

// ============================================
// API Client
// ============================================

export const api = {
  // Status
  getStatus: () => apiRequest<ServerStatus>('/status'),

  // Axon MCP server integration
  axonStatus: () => apiRequest<AxonStatusResponse>('/axon/status'),
  axonValidate: (path: string) => apiRequest<AxonValidateResponse>(`/axon/validate?path=${encodeURIComponent(path)}`),
  axonValidateLibrary: (path: string) => apiRequest<AxonLibraryValidateResponse>(`/axon/validate?kind=library&path=${encodeURIComponent(path)}`),
  axonProjects: () => apiRequest<AxonProjectsResponse>('/axon/projects'),
  axonProjectFunctions: (projectId: string, page = 1, pageSize = 50, q = '') =>
    apiRequest<AxonFunctionsResponse>(`/axon/projects/${projectId}/functions?page=${page}&pageSize=${pageSize}&q=${encodeURIComponent(q)}`),
  axonIndex: (body: { projectId?: string; force?: boolean; source?: AxonRecordSource | 'all' }) =>
    apiRequest<{ success: boolean; job: AxonJob }>('/axon/index', { method: 'POST', body }),
  axonJobs: () => apiRequest<{ jobs: AxonJob[]; active: AxonJob | null }>('/axon/jobs'),
  getHeavyJob: () => apiRequest<{ holder: HeavyJobHolder | null; queue: HeavyJobHolder[]; shadowReembedActive: boolean }>('/embeddings/heavy-job'),
  axonCancelJob: (id: string) => apiRequest<{ success: boolean; job: AxonJob }>(`/axon/jobs/${id}/cancel`, { method: 'POST' }),
  axonSearch: (body: { query: string; projectId?: string; source?: AxonRecordSource | 'all'; mode?: 'vector' | 'rerank' | 'rlm'; limit?: number }) =>
    apiRequest<AxonSearchResponse>('/axon/search', { method: 'POST', body }),
  axonConnect: () => apiRequest<{ success: boolean; mcp: AxonMcpStatus }>('/axon/connect', { method: 'POST' }),
  axonDisconnect: () => apiRequest<{ success: boolean; mcp: AxonMcpStatus }>('/axon/disconnect', { method: 'POST' }),
  axonSampleText: (projectId: string, name: string) =>
    apiRequest<{ embedTextVersion: number; function: { name: string; signature: string }; chunks: Array<{ chunkIndex: number; chunkCount: number; lineStart: number; lineEnd: number; text: string }> }>(
      `/axon/sample-text?projectId=${encodeURIComponent(projectId)}&name=${encodeURIComponent(name)}`),

  // Cache
  getCaches: () => apiRequest<CacheInfo[]>('/cache'),
  clearCache: (name?: string) => apiRequest('/cache/clear', { method: 'POST', body: { name } }),

  // Tools
  getTools: () => apiRequest<ToolsResponse>('/tools'),
  getTool: (name: string) => apiRequest<McpTool>(`/tools/${encodeURIComponent(name)}`),

  // Settings
  getSettings: () => apiRequest<FantomSettings>('/settings'),
  updateSettings: (settings: Partial<FantomSettings>) =>
    apiRequest<{ success: boolean; message: string }>('/settings', { method: 'PUT', body: settings }),

  // Sidecars
  listSidecars: (params?: { capability?: SidecarCapabilityKind; enabled?: boolean }) => {
    const qs = new URLSearchParams();
    if (params?.capability) qs.set('capability', params.capability);
    if (params?.enabled !== undefined) qs.set('enabled', String(params.enabled));
    const q = qs.toString();
    return apiRequest<SidecarListResponse>(`/sidecars${q ? `?${q}` : ''}`);
  },

  // OpenRouter virtual-inference config. The API key is write-only across
  // this surface: it goes out on POST and is never returned by GET.
  getOpenRouterConfig: () => apiRequest<OpenRouterConfigResponse>('/openrouter'),
  pushOpenRouterConfig: (body: {
    apiKey?: string;
    allowedModels?: Partial<Record<VirtualRole, OpenRouterRoleConfig>>;
    enabled?: boolean;
    dailyCaps?: Partial<Record<VirtualRole, number | ''>>;
    /** modeByRole is DERIVED server-side and is never sent from here. */
    policyByRole?: Partial<Record<VirtualRole, RoutingPolicy>>;
    modeByRole?: Partial<Record<VirtualRole, VirtualRoutingMode>>;
    /**
     * Omit — or send blank — to leave the stored value alone. The server
     * treats blank as "no change" on purpose: posting `''` for an untouched
     * control is what silently clears a configured model on Sound Suite's
     * equivalent page.
     */
    rlmSandboxModel?: string;
    rlmFallbackMode?: 'local-only' | 'local-first';
    force?: boolean;
  }) =>
    apiRequest<{
      ok: boolean; pushedCount: number; results: OpenRouterPushResult[];
      issues: OpenRouterIssue[]; note: string;
      policyByRole: Partial<Record<VirtualRole, RoutingPolicy>>;
    }>(
      '/openrouter', { method: 'POST', body },
    ),
  getOpenRouterActivity: () => apiRequest<OpenRouterActivityResponse>('/openrouter/activity'),
  getOpenRouterCredits: () =>
    apiRequest<{ ok: boolean; reason?: string; credits: CloudBudgetStats['credits']; spendToday: number; budget: CloudBudgetStats }>(
      '/openrouter/credits',
    ),
  /** The manual ceiling, in CONCURRENT CLOUD REQUESTS. '' clears it. */
  setOpenRouterBudget: (maxConcurrent: number | '') =>
    apiRequest<{ ok: boolean; budget: CloudBudgetStats }>(
      '/openrouter/budget', { method: 'POST', body: { maxConcurrent } },
    ),
  rePushOpenRouterConfig: () =>
    apiRequest<{ ok: boolean; pushedCount: number; results: OpenRouterPushResult[] }>(
      '/openrouter/repush', { method: 'POST' },
    ),
  refreshVirtualContainers: () =>
    apiRequest<{ ok: boolean; virtual: VirtualContainer[]; slots: MasterSlotStatus[] }>(
      '/sidecars/virtual/refresh', { method: 'POST' },
    ),
  getVirtualVerification: () =>
    apiRequest<{ verified: VectorVerification[]; refusals: VectorRefusal[] }>('/sidecars/virtual/verification'),
  verifyVirtualContainers: () =>
    apiRequest<{
      reports: CompatibilityReport[];
      expectedDims?: number;
      /** The local host, or the cloud peer, the candidates were measured against. */
      reference?: string;
      /** Which reference the policy selected — see src/embedding/providers/vectorCompatibility.ts. */
      regime?: VerificationRegime;
      policy?: RoutingPolicy;
      note?: string;
    }>('/sidecars/virtual/verify', { method: 'POST' }),
  listSidecarModels: (kind: SidecarCapabilityKind = 'embedding') =>
    apiRequest<{ kind: SidecarCapabilityKind; models: string[] }>(`/sidecars/models?kind=${kind}`),
  getMasterWsPort: () =>
    apiRequest<{ configuredPort: number; listener: { port: number | null; listening: boolean; error: string | null } }>(`/sidecars/master-ws-port`),
  setMasterWsPort: (port: number) =>
    apiRequest<{ port: number; restart: { port: number; ok: boolean; error?: string } }>(`/sidecars/master-ws-port`, { method: 'POST', body: { port } }),
  createSidecar: (input: Omit<Sidecar, 'id' | 'lastHealthCheck' | 'healthStatus' | 'responseTimeMs' | 'capabilitiesSource' | 'lastSeen' | 'activeRequests'>) =>
    apiRequest<Sidecar>('/sidecars', { method: 'POST', body: input }),
  updateSidecar: (id: string, patch: Partial<Sidecar>) =>
    apiRequest<Sidecar>(`/sidecars/${id}`, { method: 'PUT', body: patch }),
  deleteSidecar: (id: string) =>
    apiRequest<{ success: boolean }>(`/sidecars/${id}`, { method: 'DELETE' }),
  pingSidecar: (id: string) =>
    apiRequest<SidecarHealth>(`/sidecars/${id}/health`, { method: 'POST' }),
  clearSidecarEmbedFault: (id: string) =>
    apiRequest<{ cleared: number }>(`/sidecars/${id}/embed-fault/clear`, { method: 'POST' }),
  getSidecarStatus: (id: string) =>
    apiRequest<{ id: string; snapshot: SidecarStatusSnapshot; source?: 'ws-heartbeat' | 'http-status' }>(`/sidecars/${id}/status`),
  sidecarAction: (id: string, action: 'start' | 'stop' | 'acquire' | 'release' | 'pull' | 'pull-and-load', role: string, model?: string) =>
    apiRequest<{ id: string; action: string; role: string; result: unknown }>(`/sidecars/${id}/actions/${action}`, {
      method: 'POST', body: { role, model },
    }),
  registerSidecarAsMaster: (id: string, masterUrl?: string, authToken?: string) =>
    apiRequest<{ ok: boolean; masterUrl: string; wsPort: number; sidecarResponse: unknown }>(
      `/sidecars/${id}/register-as-master`,
      { method: 'POST', body: { masterUrl, authToken } },
    ),
  unregisterSidecarAsMaster: (id: string, masterUrl?: string) =>
    apiRequest<{ ok: boolean; masterUrl: string }>(
      `/sidecars/${id}/unregister-as-master`,
      { method: 'POST', body: { masterUrl } },
    ),

  // Boot-time auto-embedding pipeline status
  getAutoPipelineStatus: () =>
    apiRequest<AutoPipelineStatus>(`/vectors/auto-pipeline/status`),

  startAutoEmbed: (projectIds?: number[]) =>
    apiRequest<{ queued: number | string }>(`/vectors/auto-embed/start`, {
      method: 'POST', body: projectIds ? { projectIds } : {},
    }),

  // Fill-missing: incremental embedding (no destructive delete first)
  buildMissingForProject: (projectId: number) =>
    apiRequest<{ ok: boolean; projectId: number; processed: number; errors: number }>(
      `/vectors/build-missing/${projectId}`, { method: 'POST' },
    ),
  buildMissingAll: (force = false) =>
    apiRequest<{ jobId: string; projectsToProcess: number }>(
      `/vectors/build-missing`, { method: 'POST', body: { force } },
    ),

  // Re-embed jobs (background)
  /**
   * Start a re-embed. A full (projectId 0) non-resume start rebuilds the
   * inactive slot from scratch, destroying anything a pause banked there — so
   * the server answers 409 with `wouldDestroy` unless `confirm` is set. Pass
   * it only after showing the user that count.
   */
  startReembedJob: (projectId: number = 0, batchSize: number = 50, confirm: boolean = false) =>
    apiRequest<{ jobId: string; scope: 'all' | { projectId: number } }>(
      `/vectors/re-embed/start`,
      { method: 'POST', body: { projectId, batchSize, confirm } },
    ),
  /** Continue a paused/partial rebuild from the vectors already banked. */
  resumeReembedJob: () =>
    apiRequest<{ jobId: string; scope: 'all' | { projectId: number } }>(
      `/vectors/re-embed/start`,
      { method: 'POST', body: { projectId: 0, resume: true } },
    ),
  getShadowState: () => apiRequest<ShadowStateResponse>('/vectors/shadow'),
  discardShadow: () =>
    apiRequest<{ ok: boolean; dropped: boolean; name: string; rows: number }>(
      '/vectors/shadow/discard', { method: 'POST', body: { confirm: true } },
    ),
  promoteShadowAnyway: () =>
    apiRequest<{ ok: boolean; promoted: string; vectors: number; projects: number; missingProjects: number; note: string }>(
      '/vectors/shadow/promote-anyway', { method: 'POST', body: { confirm: true } },
    ),
  getReembedJob: (id: string) =>
    apiRequest<ReembedJob>(`/vectors/re-embed/jobs/${id}`),
  listReembedJobs: () =>
    apiRequest<{ jobs: ReembedJob[] }>(`/vectors/re-embed/jobs`),
  /** DISCARD — halts the job AND drops the shadow. Irreversible. */
  autoEmbedState: () =>
    apiRequest<{ autoEmbedDisabled: boolean; running: boolean; phase?: string }>('/vectors/auto-embed/state'),
  setAutoEmbed: (enabled: boolean) =>
    apiRequest<{ ok: boolean; autoEmbedDisabled: boolean; note: string }>(
      `/vectors/auto-embed/${enabled ? 'resume' : 'stop'}`,
      { method: 'POST' },
    ),
  cancelReembedJob: (id: string) =>
    apiRequest<{ ok: boolean; status: string; cancelRequested: boolean; destructive: boolean }>(
      `/vectors/re-embed/jobs/${id}/cancel`,
      { method: 'POST' },
    ),
  /** PAUSE — halts the job and KEEPS the shadow. Reversible. */
  pauseReembedJob: (id: string) =>
    apiRequest<{ ok: boolean; status: string; pauseRequested: boolean; destructive: boolean; note: string }>(
      `/vectors/re-embed/jobs/${id}/pause`,
      { method: 'POST' },
    ),

  // /admin/jobs/* — unified jobs surface used by /dashboard/jobs page
  listJobs: () => apiRequest<{ jobs: ReembedJob[] }>('/jobs'),
  getJob: (id: string) => apiRequest<ReembedJob>(`/jobs/${id}`),
  cancelJob: (id: string) => apiRequest<ReembedJob>(`/jobs/${id}/cancel`, { method: 'POST' }),
  getJobLog: (id: string, tail = 500) =>
    apiRequest<{ jobId: string; lines: string[]; size?: number }>(`/jobs/${id}/log?tail=${tail}`),

  // LLM Providers
  getLLMProviders: () => apiRequest<LLMProvidersResponse>('/settings/llm-providers'),
  saveLLMProviders: (body: {
    defaultProvider?: LLMProviderName | null;
    groq?: { enabled?: boolean; model?: string; apiKey?: string };
    anthropic?: { enabled?: boolean; model?: string; apiKey?: string };
    gemini?: { enabled?: boolean; model?: string; apiKey?: string };
  }) => apiRequest<{ success: boolean; restartRequired: boolean }>('/settings/llm-providers', { method: 'POST', body }),

  // Usage
  getUsage: (days = 7) => apiRequest<UsageStats>(`/usage?days=${days}`),
  getUsageDatabase: () => apiRequest<UsageDatabaseInfo>('/usage/database'),
  clearUsageData: () => apiRequest<{ success: boolean }>('/usage/clear', { method: 'POST' }),
  resetUsageDatabase: () => apiRequest<{ success: boolean }>('/usage/reset', { method: 'POST' }),

  // Documentation
  searchDocs: (query: string, limit = 20) =>
    apiRequest<{ query: string; count: number; results: DocSearchResult[] }>(
      `/docs/search?q=${encodeURIComponent(query)}&limit=${limit}`
    ),
  getPods: () => apiRequest<PodsResponse>('/pods'),

  // Primary Project
  getPrimaryProject: () => apiRequest<{ instance: string; project: string } | { error: string }>('/primary-project'),
  setPrimaryProject: (instance: string, project: string) =>
    apiRequest<{ success: boolean }>('/primary-project', { method: 'POST', body: { instance, project, setBy: 'dashboard' } }),

  // Logs (SSE - special handling needed)
  getLogsUrl: () => {
    const username = typeof window !== 'undefined' ? localStorage.getItem('admin_user') || 'admin' : 'admin';
    const password = typeof window !== 'undefined' ? localStorage.getItem('admin_pass') || 'admin' : 'admin';
    return `${getApiBase()}/admin/logs?auth=${btoa(`${username}:${password}`)}`;
  },

  // ============================================
  // Fantom Instances
  // ============================================
  getInstances: () => apiRequest<{ count: number; instances: FantomInstance[] }>('/instances'),
  getInstance: (id: number) => apiRequest<FantomInstance>(`/instances/${id}`),
  createInstance: (input: CreateInstanceInput) =>
    apiRequest<FantomInstance>('/instances', { method: 'POST', body: input }),
  updateInstance: (id: number, input: Partial<CreateInstanceInput>) =>
    apiRequest<FantomInstance>(`/instances/${id}`, { method: 'PUT', body: input }),
  deleteInstance: (id: number) =>
    apiRequest<{ success: boolean }>(`/instances/${id}`, { method: 'DELETE' }),
  validateInstance: (id: number) =>
    apiRequest<{ isValid: boolean; error?: string }>(`/instances/${id}/validate`, { method: 'POST' }),
  getSkySarkInstances: (version?: string) =>
    apiRequest<SkySarkInstancesResponse>(`/instances/skyspark${version ? `?version=${encodeURIComponent(version)}` : ''}`),

  // Active Instance
  getActiveInstance: () => apiRequest<{ active: boolean; instance?: FantomInstance; message?: string }>('/active-instance'),
  setActiveInstance: (instanceId: number | null) =>
    apiRequest<{ success: boolean; instance?: FantomInstance }>('/active-instance', {
      method: 'POST',
      body: { instanceId },
    }),

  // ============================================
  // Fantom Pods
  // ============================================
  getFantomPods: (options?: { instanceId?: number; includeInstance?: boolean; unassigned?: boolean }) => {
    const params = new URLSearchParams();
    if (options?.instanceId) params.append('instanceId', options.instanceId.toString());
    if (options?.includeInstance) params.append('includeInstance', 'true');
    if (options?.unassigned) params.append('unassigned', 'true');
    const queryString = params.toString();
    return apiRequest<{
      count: number;
      pods: FantomPodWithInstance[];
      instanceId?: number;
      filter?: string;
      projects?: OrphanProject[];
      projectCount?: number;
    }>(`/fantom-pods${queryString ? `?${queryString}` : ''}`);
  },
  getFantomPod: (id: number) => apiRequest<FantomPod>(`/fantom-pods/${id}`),
  createFantomPod: (input: CreatePodInput) =>
    apiRequest<FantomPod>('/fantom-pods', { method: 'POST', body: input }),
  updateFantomPod: (id: number, input: Partial<CreatePodInput>) =>
    apiRequest<FantomPod>(`/fantom-pods/${id}`, { method: 'PUT', body: input }),
  deleteFantomPod: (id: number) =>
    apiRequest<{ success: boolean }>(`/fantom-pods/${id}`, { method: 'DELETE' }),
  getBuildFiles: (id: number) =>
    apiRequest<{ podId: number; path: string; buildFiles: string[] }>(`/fantom-pods/${id}/build-files`),
  getCompileLogs: (id: number, limit = 20) =>
    apiRequest<{ podId: number; count: number; logs: CompileLog[] }>(`/fantom-pods/${id}/compile-logs?limit=${limit}`),

  // ============================================
  // Compilation
  // ============================================
  compilePod: (podId: number, instanceId?: number, buildFile?: string) =>
    apiRequest<CompileResult>('/compile', {
      method: 'POST',
      body: { podId, instanceId, buildFile },
    }),
  getCompileLog: (logId: number) => apiRequest<CompileLog>(`/compile/${logId}`),
  getRunningCompilations: () =>
    apiRequest<{ count: number; compilations: CompileLog[] }>('/compile/running'),

  // ============================================
  // Instance Documentation
  // ============================================
  getInstanceDocStatus: (instanceId: number) =>
    apiRequest<DocStatus>(`/instances/${instanceId}/docs`),
  indexInstanceDocs: (instanceId: number, pods?: string[], forceRefresh = false) =>
    apiRequest<DocIndexResult>(`/instances/${instanceId}/docs/index`, {
      method: 'POST',
      body: { pods, forceRefresh },
    }),
  searchInstanceDocs: (instanceId: number, query: string, options?: {
    pod?: string;
    type?: string;
    language?: 'fantom' | 'axon';
    limit?: number;
  }) => {
    const params = new URLSearchParams({ q: query });
    if (options?.pod) params.append('pod', options.pod);
    if (options?.type) params.append('type', options.type);
    if (options?.language) params.append('language', options.language);
    if (options?.limit) params.append('limit', options.limit.toString());
    return apiRequest<LocalDocSearchResult>(`/instances/${instanceId}/docs/search?${params}`);
  },
  getInstanceDocPods: (instanceId: number) =>
    apiRequest<{ instanceId: number; count: number; pods: DocPodInfo[] }>(`/instances/${instanceId}/docs/pods`),
  clearInstanceDocCache: (instanceId: number) =>
    apiRequest<{ success: boolean; instanceId: number; cacheCleared: boolean }>(
      `/instances/${instanceId}/docs/cache`,
      { method: 'DELETE' }
    ),
  indexAllDocs: () =>
    apiRequest<{
      success: boolean;
      totalInstances: number;
      indexed: number;
      skipped: number;
      errors: number;
      totalItems: number;
      results: Array<{
        instanceId: number;
        name: string;
        success: boolean;
        itemCount?: number;
        duration?: number;
        error?: string;
        skipped?: boolean;
      }>;
    }>('/docs/index-all', { method: 'POST' }),
  embedInstanceDocs: (instanceId: number, forceRefresh = false) =>
    apiRequest<{
      success: boolean;
      instanceId: number;
      totalItems: number;
      embedded: number;
      skipped: number;
      duration: number;
      error?: string;
    }>(`/instances/${instanceId}/docs/embed`, {
      method: 'POST',
      body: { forceRefresh },
    }),
  embedAllDocs: (forceRefresh = false) =>
    apiRequest<{
      success: boolean;
      jobId: string;
      alreadyRunning: boolean;
      progress?: EmbedJobProgress;
    }>('/docs/embed-all', {
      method: 'POST',
      body: { forceRefresh },
    }),
  getEmbedJobStatus: (jobId: string) =>
    apiRequest<EmbedJobProgress>(`/docs/embed-status/${jobId}`),
  getActiveEmbedJob: () =>
    apiRequest<EmbedJobProgress | { status: 'none' }>('/docs/embed-status/active'),
  clearDocEmbeddings: () =>
    apiRequest<{ success: boolean; deleted: number }>('/docs/embed-clear', {
      method: 'POST',
    }),

  // ============================================
  // Instance Source Code (Haxall/SkySpark src)
  // ============================================
  getInstanceSourceStatus: (instanceId: number) =>
    apiRequest<SourceStatus>(`/instances/${instanceId}/source`),
  indexInstanceSource: (instanceId: number) =>
    apiRequest<SourceIndexResult>(`/instances/${instanceId}/source/index`, { method: 'POST' }),
  getInstanceSourcePods: (instanceId: number) =>
    apiRequest<{ instanceId: number; count: number; pods: SourcePodInfo[] }>(`/instances/${instanceId}/source/pods`),

  // ============================================
  // AST Cache
  // ============================================
  getAllAstCache: () => apiRequest<AstCacheOverview>('/ast-cache'),
  getPodAstData: (podId: string | number) =>
    apiRequest<PodAstData>(`/fantom-pods/${encodeURIComponent(String(podId))}/ast`),
  createPodAstCache: (podId: string | number) =>
    apiRequest<CreateAstCacheResult>(`/fantom-pods/${encodeURIComponent(String(podId))}/ast`, { method: 'POST' }),
  reindexProject: (projectId: number, opts?: { force?: boolean }) =>
    apiRequest<{
      success: boolean;
      project: { id: number; name: string };
      noChange?: boolean;
      indexResult: { functionsIndexed: number; typesIndexed: number; filesProcessed: number; errors: number; duration: number };
    }>(
      `/code-projects/${projectId}/reindex${opts?.force ? '?force=true' : ''}`,
      { method: 'POST' }
    ),
  indexAllPodsAst: (opts?: { force?: boolean }) =>
    apiRequest<{
      success: boolean;
      processed: number;
      podsProcessed: number;
      projectsProcessed: number;
      created: number;
      alreadyExists: number;
      indexedOk: number;
      indexErrors: number;
      orphanIndexed?: number;
      orphanErrors?: number;
      force?: boolean;
      results: Array<{
        source?: 'pod' | 'project';
        podId?: number;
        name?: string;
        podName?: string;
        projectId: number;
        action: 'created' | 'exists';
        indexed: boolean;
        functionsIndexed?: number;
        typesIndexed?: number;
        error?: string;
      }>;
    }>('/fantom-pods/index-all-ast', { method: 'POST', body: { force: opts?.force === true } }),
  getLanguageBreakdown: (podId: string | number) =>
    apiRequest<LanguageBreakdownResponse>(`/fantom-pods/${encodeURIComponent(String(podId))}/languages`),

  // ============================================
  // Fantom Source Folder Settings
  // ============================================
  getFantomSourceFolder: () =>
    apiRequest<{ path: string | null }>('/settings/fantom-source-folder'),
  setFantomSourceFolder: (path: string) =>
    apiRequest<{ success: boolean; path: string }>('/settings/fantom-source-folder', {
      method: 'POST',
      body: { path },
    }),

  // ============================================
  // Fantom Versions
  // ============================================
  getFantomVersions: () =>
    apiRequest<{ sourceFolder?: string; versions: FantomVersion[]; message?: string }>('/fantom-versions'),
  detectFantomVersion: (path: string) =>
    apiRequest<DetectFantomVersionResult>('/detect-fantom-version', {
      method: 'POST',
      body: { path },
    }),

  // ============================================
  // Fantom Builds (Source Code Indexing)
  // ============================================
  getFantomBuilds: () =>
    apiRequest<{ builds: FantomBuild[] }>('/fantom-builds'),
  getFantomBuild: (id: number) =>
    apiRequest<{ build: FantomBuild; projects: FantomBuildProject[] }>(`/fantom-builds/${id}`),
  createFantomBuild: (input: CreateFantomBuildInput) =>
    apiRequest<{ build: FantomBuild }>('/fantom-builds', { method: 'POST', body: input }),
  scanFantomBuilds: () =>
    apiRequest<{ sourceFolder: string; registered: number; builds: Array<{ version: string; path: string; hasSource: boolean }> }>(
      '/fantom-builds/scan',
      { method: 'POST' }
    ),
  indexFantomBuild: (id: number) =>
    apiRequest<FantomBuildIndexResult>(`/fantom-builds/${id}/index`, { method: 'POST' }),
  clearFantomBuildIndex: (id: number) =>
    apiRequest<{ success: boolean; buildId: number; version: string; clearedProjects: number; message: string }>(
      `/fantom-builds/${id}/clear`,
      { method: 'POST' }
    ),
  deleteFantomBuild: (id: number) =>
    apiRequest<{ success: boolean; message: string }>(`/fantom-builds/${id}`, { method: 'DELETE' }),
  indexAllFantomBuilds: () =>
    apiRequest<{
      success: boolean;
      totalBuilds: number;
      indexed: number;
      skipped: number;
      totalPods: number;
      totalFunctions: number;
      totalTypes: number;
      results: Array<{
        buildId: number;
        version: string;
        success: boolean;
        podsIndexed?: number;
        totalFunctions?: number;
        totalTypes?: number;
        duration?: number;
        error?: string;
      }>;
    }>('/fantom-builds/index-all', { method: 'POST' }),

  // ============================================
  // Code Index Management
  // ============================================
  getCodeStats: () => apiRequest<CodeStats>('/code-stats'),
  reindexCode: () => apiRequest<ReindexResult>('/reindex', { method: 'POST' }),
  rebuildGraphs: () => apiRequest<{ success: boolean; projects: number; totalNodes: number; totalEdges: number; resolved: number }>('/graph/rebuild', { method: 'POST' }),
  backfillLadybug: (options: { projectId?: number | 'all'; dryRun?: boolean } = {}) => {
    const params = new URLSearchParams();
    params.set('projectId', String(options.projectId ?? 'all'));
    if (options.dryRun) params.set('dryRun', 'true');
    return apiRequest<BackfillLadybugResult>(`/graph/backfill-ladybug?${params.toString()}`, { method: 'POST' });
  },

  // ============================================
  // OAuth Settings
  // ============================================
  getOAuthSettings: () => apiRequest<OAuthSettings>('/settings/oauth'),
  setOAuthEnabled: (enabled: boolean) =>
    apiRequest<OAuthSettingsResult>('/settings/oauth', {
      method: 'POST',
      body: { enabled },
    }),

  // ============================================
  // User Management
  // ============================================
  getCurrentUser: () => apiRequest<UserPublic>('/users/me'),
  getUsers: () => apiRequest<{ users: UserPublic[] }>('/users'),
  createUser: (username: string, password: string, role: 'admin' | 'user' = 'user') =>
    apiRequest<{ success: boolean; user: UserPublic }>('/users', {
      method: 'POST',
      body: { username, password, role },
    }),
  updateUserPassword: (username: string, password: string) =>
    apiRequest<{ success: boolean; message: string }>(`/users/${username}/password`, {
      method: 'PUT',
      body: { password },
    }),
  updateUserRole: (username: string, role: 'admin' | 'user') =>
    apiRequest<{ success: boolean; message: string }>(`/users/${username}/role`, {
      method: 'PUT',
      body: { role },
    }),
  deleteUser: (username: string) =>
    apiRequest<{ success: boolean; message: string }>(`/users/${username}`, {
      method: 'DELETE',
    }),

  // ============================================
  // Backup/Restore
  // ============================================
  listBackups: () =>
    apiRequest<{ count: number; backups: BackupInfo[] }>('/backups'),
  getBackup: (id: string) =>
    apiRequest<BackupInfo>(`/backups/${id}`),
  createBackup: (options?: CreateBackupOptions) =>
    apiRequest<{ success: boolean; backup: BackupResult }>('/backups', {
      method: 'POST',
      body: options || {},
    }),
  restoreBackup: (id: string, options?: Partial<RestoreOptions>) =>
    apiRequest<RestoreResult>(`/backups/${id}/restore`, {
      method: 'POST',
      body: { confirm: true, ...options },
    }),
  deleteBackup: (id: string) =>
    apiRequest<{ success: boolean; message: string }>(`/backups/${id}`, {
      method: 'DELETE',
    }),
  downloadBackupUrl: (id: string): string => {
    const username = typeof window !== 'undefined' ? localStorage.getItem('admin_user') || 'admin' : 'admin';
    const password = typeof window !== 'undefined' ? localStorage.getItem('admin_pass') || 'admin' : 'admin';
    return `${getApiBase()}/admin/backups/${id}/download?auth=${btoa(`${username}:${password}`)}`;
  },

  // ============================================
  // Tree-sitter Code Parser
  // ============================================
  getTreeSitterGrammars: () =>
    apiRequest<{ supported: string[]; available: string[]; missing: string[] }>('/tree-sitter/grammars'),
  parseCode: (code: string, language: string) =>
    apiRequest<{
      success: boolean;
      language: string;
      parseTime: number;
      classes: any[];
      functions: any[];
      interfaces: any[];
      imports: any[];
      exports: any[];
      errors: any[];
    }>('/tree-sitter/parse', {
      method: 'POST',
      body: { code, language },
    }),
  extractFunctions: (projectPath: string, languages: string[]) =>
    apiRequest<ExtractFunctionsResponse>('/tree-sitter/extract-functions', {
      method: 'POST',
      body: { projectPath, languages },
    }),

  // ============================================
  // Graph Visualization
  // ============================================
  getGraphVisualization: (params: {
    nodeId?: string;
    qualifiedName?: string;
    projectId?: number;
    graphType?: 'subgraph' | 'callers' | 'callees' | 'impact' | 'project';
    depth?: number;
    maxNodes?: number;
  }) => {
    const searchParams = new URLSearchParams();
    if (params.nodeId) searchParams.append('nodeId', params.nodeId);
    if (params.qualifiedName) searchParams.append('qualifiedName', params.qualifiedName);
    if (params.projectId) searchParams.append('projectId', params.projectId.toString());
    if (params.graphType) searchParams.append('graphType', params.graphType);
    if (params.depth) searchParams.append('depth', params.depth.toString());
    if (params.maxNodes) searchParams.append('maxNodes', params.maxNodes.toString());
    return apiRequest<GraphVisualizationData>(`/graph/visualize?${searchParams}`);
  },

  searchGraphNodes: (query: string, projectId?: number, limit?: number) => {
    const searchParams = new URLSearchParams({ q: query });
    if (projectId) searchParams.append('projectId', projectId.toString());
    if (limit) searchParams.append('limit', limit.toString());
    return apiRequest<{ count: number; nodes: GraphNodeSearchResult[] }>(`/graph/nodes/search?${searchParams}`);
  },

  // ============================================
  // Vector/Semantic Search
  // ============================================
  semanticSearch: (query: string, options?: { projectId?: number; nodeType?: string; limit?: number; includeGraphContext?: boolean }) =>
    apiRequest<SemanticSearchResponse>('/vectors/search', {
      method: 'POST',
      body: { query, ...options },
    }),

  /** RLM Answer: synthesize a cited answer from vector search results via an LLM. */
  /**
   * `fast: true` skips the RLM gather stage — ~15s instead of ~45s. The
   * dashboard always sends it: a person is watching a spinner. The MCP tool
   * calls answerCodeQuestion directly and keeps the full budget, so it still
   * gets the RLM-found citations.
   */
  ask: (body: { query: string; projectId?: number; provider?: string; model?: string; topK?: number; fast?: boolean; rlm?: boolean; rerank?: boolean; askId?: string }) =>
    apiRequest<AskAnswerResponse>('/vectors/ask', {
      method: 'POST',
      body,
    }),

  /** Live "thinking" feed for an ask started with `askId`. */
  getAskEvents: (askId: string, since = 0) =>
    apiRequest<{ events: AskEvent[]; done: boolean; known: boolean }>(`/vectors/ask/${encodeURIComponent(askId)}/events?since=${since}`),

  getProjectVectors: (projectId: number, limit?: number) => {
    const searchParams = new URLSearchParams();
    if (limit) searchParams.append('limit', limit.toString());
    return apiRequest<ProjectVectorsResponse>(`/vectors/project/${projectId}?${searchParams}`);
  },

  getVectorStats: () =>
    apiRequest<VectorStatsResponse>('/vectors/stats'),

  getModelStatus: () =>
    apiRequest<ModelStatusResponse>('/vectors/model-status'),

  reEmbed: (projectId: number) =>
    apiRequest<{ success: boolean; projects: number; deleted: number; generated: number; errors: number; model: string; dimensions: number }>(`/vectors/re-embed/${projectId}`, { method: 'POST' }),

  reEmbedAll: () =>
    apiRequest<{ success: boolean; projects: number; deleted: number; generated: number; errors: number; model: string; dimensions: number }>('/vectors/re-embed/0', { method: 'POST' }),

  /** Non-destructive incremental embed: embeds only nodes that don't yet have a
   *  vector (resume-where-left-off) and does NOT drop existing vectors. Contrast
   *  with reEmbed, which is a destructive full regenerate. */
  resumeProject: (projectId: number) =>
    apiRequest<{ ok?: boolean; processed?: number; message?: string; [k: string]: unknown }>(`/vectors/build-missing/${projectId}`, { method: 'POST' }),

  /** Drop the docs_vectors LanceDB table and re-embed every cached doc with
   *  the currently configured embedding model. Required when changing model
   *  dimensions (e.g. jina 768d → qwen3 1024d) — embed-clear only deletes
   *  rows; the table's column dimensions stay locked to the prior model. */
  reEmbedDocsWithCurrentModel: () =>
    apiRequest<{ success: boolean; droppedTable: boolean; jobId: string; message: string }>(
      '/docs/re-embed',
      { method: 'POST' },
    ),

  // ============================================
  // Code Projects
  // ============================================
  getCodeProjects: () =>
    apiRequest<{ count: number; projects: CodeProject[] }>('/code-projects'),
  getCodeProject: (id: number) =>
    apiRequest<CodeProject>(`/code-projects/${id}`),
  createCodeProject: (input: CreateCodeProjectInput) =>
    apiRequest<CodeProject>('/code-projects', { method: 'POST', body: input }),
  updateCodeProject: (id: number, input: UpdateCodeProjectInput) =>
    apiRequest<CodeProject>(`/code-projects/${id}`, { method: 'PUT', body: input }),
  deleteCodeProject: (id: number) =>
    apiRequest<{ success: boolean }>(`/code-projects/${id}`, { method: 'DELETE' }),
  getCodeProjectLanguages: (id: number) =>
    apiRequest<LanguageBreakdownResponse>(`/code-projects/${id}/languages`),

  // ============================================
  // Project dependencies (ask scope)
  // ============================================
  getProjectDependencies: (id: number) =>
    apiRequest<ProjectDependenciesResponse>(`/code-projects/${id}/dependencies`),
  getProjectDependencySummary: () =>
    apiRequest<ProjectDependencySummary>('/project-dependencies/summary'),
  addManualDependency: (id: number, toProjectId: number, source?: string) =>
    apiRequest<ProjectDependencyRow>(`/code-projects/${id}/dependencies`, { method: 'POST', body: { toProjectId, kind: 'manual', source } }),
  setDependencyEnabled: (id: number, depId: number, enabled: boolean) =>
    apiRequest<ProjectDependencyRow>(`/code-projects/${id}/dependencies/${depId}`, { method: 'PATCH', body: { enabled } }),
  deleteDependency: (id: number, depId: number, force = false) =>
    apiRequest<{ success: boolean; id: number }>(`/code-projects/${id}/dependencies/${depId}${force ? '?force=1' : ''}`, { method: 'DELETE' }),
  rebuildProjectDependencies: (id: number) =>
    apiRequest<RebuildDependenciesResult>(`/code-projects/${id}/dependencies/rebuild`, { method: 'POST' }),
  rebuildAllProjectDependencies: () =>
    apiRequest<RebuildAllDependenciesResult>('/code-projects/dependencies/rebuild-all', { method: 'POST' }),

  // ============================================
  // Time-travel: IndexRun history + diff
  // ============================================

  listIndexRuns: (projectId: number, limit = 30) =>
    apiRequest<{
      total: number;
      offset: number;
      limit: number;
      runs: Array<{
        id: number;
        startedAt: string | null;
        finishedAt: string | null;
        durationMs: number;
        trigger: string;
        filesScanned: number;
        filesParsed: number;
        filesSkipped: number;
        addedCount: number;
        modifiedCount: number;
        removedCount: number;
        isSeedingRun: boolean;
        force: boolean;
        errorMessage: string | null;
        gitCommit: string | null;
        gitBranch: string | null;
      }>;
    }>(`/code-projects/${projectId}/index-runs?limit=${limit}`),

  getProjectDiff: (projectId: number, from: string, to?: string, scope?: string) => {
    const params = new URLSearchParams({ from });
    if (to) params.set('to', to);
    if (scope) params.set('scope', scope);
    return apiRequest<{
      projectId: number;
      from: string;
      to: string;
      fromRun: { id: number; occurredAt: string; trigger: string | null } | null;
      toRun: { id: number; occurredAt: string; trigger: string | null } | 'current' | null;
      totals: { added: number; modified: number; removed: number };
      files: Array<{
        path: string;
        added: Array<{ qualifiedName: string; name: string; kind: string; lineStart: number | null }>;
        modified: Array<{ qualifiedName: string; name: string; kind: string; lineStart: number | null; beforeSig: string | null; afterSig: string | null }>;
        removed: Array<{ qualifiedName: string; name: string; kind: string; lineStart: number | null }>;
      }>;
      truncated: boolean;
    }>(`/code-projects/${projectId}/diff?${params.toString()}`);
  },

  // ============================================
  // Static Option Getters (for combo boxes)
  // ============================================

  /** Get list of node types for filtering */
  getNodeTypes: (): Promise<{ nodeTypes: readonly string[] }> =>
    Promise.resolve({ nodeTypes: NODE_TYPES }),

  /** Get list of supported languages for filtering */
  getLanguages: (): Promise<{ languages: readonly string[] }> =>
    Promise.resolve({ languages: SUPPORTED_LANGUAGES }),

  // ============================================
  // Convenience Aliases (for combo box data)
  // ============================================

  /** Alias for getCodeProjects - list all Fantom/code projects */
  listFantomProjects: () =>
    apiRequest<{ count: number; projects: CodeProject[] }>('/code-projects'),

  /** Search code nodes (alias for searchGraphNodes with simpler interface) */
  searchNodes: (query: string, projectId?: number, limit = 20) => {
    const searchParams = new URLSearchParams({ q: query });
    if (projectId) searchParams.append('projectId', projectId.toString());
    searchParams.append('limit', limit.toString());
    return apiRequest<{ count: number; nodes: GraphNodeSearchResult[] }>(`/graph/nodes/search?${searchParams}`);
  },

  // ============================================
  // Embedding Model Management
  // ============================================
  getEmbeddingModelStatuses: () =>
    apiRequest<ModelStatusListResponse>('/models/status'),
};

/**
 * Download an embedding model with real-time SSE progress.
 * Returns when the download completes or errors.
 */
export async function downloadEmbeddingModel(
  modelId: string,
  onProgress?: (data: { status: string; progress?: number; file?: string; modelId: string; error?: string }) => void,
): Promise<void> {
  const apiBase = getApiBase();
  const username = typeof window !== 'undefined' ? localStorage.getItem('admin_user') || 'admin' : 'admin';
  const password = typeof window !== 'undefined' ? localStorage.getItem('admin_pass') || 'admin' : 'admin';
  const authHeader = 'Basic ' + btoa(`${username}:${password}`);

  const response = await fetch(`${apiBase}/admin/models/download`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
    },
    body: JSON.stringify({ modelId }),
  });

  if (!response.ok) {
    throw new Error(`Download failed: ${response.statusText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          onProgress?.(data);
          if (data.status === 'error') {
            throw new Error(data.error || 'Download failed');
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }
  }
}

// ============================================
// Graph Visualization Types
// ============================================

export interface GraphVisualizationData {
  elements: {
    nodes: Array<{
      data: {
        id: string;
        label: string;
        qualifiedName: string;
        nodeType: string;
        filePath: string;
        lineStart: number;
        color?: string;
        isFocal?: boolean;
      };
    }>;
    edges: Array<{
      data: {
        id: string;
        source: string;
        target: string;
        edgeType: string;
        color?: string;
      };
    }>;
  };
  metadata?: {
    title?: string;
    description?: string;
    nodeCount: number;
    edgeCount: number;
    focalNodeId?: string;
  };
}

export interface GraphNodeSearchResult {
  id: string;
  name: string;
  qualifiedName: string;
  nodeType: string;
  filePath: string;
  lineStart: number;
  projectId: number;
}

// ============================================
// Vector/Semantic Search Types
// ============================================

export interface SemanticSearchResult {
  nodeId: string;
  name: string;
  qualifiedName: string;
  nodeType: string;
  filePath: string;
  lineStart: number;
  signature?: string;
  documentation?: string;
  semanticScore: number;
  graphScore: number;
  combinedScore: number;
  callerCount?: number;
  calleeCount?: number;
  relatedNodes?: Array<{
    id: string;
    name: string;
    relationship: string;
  }>;
}

export interface SemanticSearchResponse {
  query: string;
  count: number;
  results: SemanticSearchResult[];
}

/** Per-stage timing returned by /vectors/ask, so a slow answer explains itself. */
export interface AskEvent {
  seq: number;
  t: number;
  kind: 'stage' | 'plan' | 'round' | 'ask' | 'answer' | 'thought' | 'done' | 'error';
  text: string;
  id?: string;
  detail?: string;
  items?: string[];
  ms?: number;
}

export interface AskTimings {
  retrievalMs: number;
  rlmMs: number;
  synthesisMs: number;
  totalMs: number;
  budgetMs: number;
  fast: boolean;
  rlm: boolean;
  rerank: boolean;
  overBudget: number;
}

export interface AskAnswerResponse {
  timings?: AskTimings;
  answer: string;
  citations: Array<{
    nodeId: string;
    qualifiedName: string;
    filePath: string;
    lineStart: number;
    /** Set when the item comes from a related (dependency) project. */
    project?: string;
    /** 'seed' = initial semantic hit; 'rlm' = found by the investigation model. */
    via?: 'seed' | 'rlm';
  }>;
  usedResults: number;
  provider: string;
  model: string;
  historyIncluded: boolean;
  complexity?: 'simple' | 'complex' | null;
  rlm?: { used: boolean; model?: string | null; rounds?: number; toolCalls?: number; citations?: number };
}

export interface ProjectVectorPoint {
  id: string;
  name: string;
  qualifiedName: string;
  nodeType: string;
  filePath: string;
  lineStart: number;
  x: number;
  y: number;
}

export interface ProjectVectorsResponse {
  projectId: number;
  count: number;
  nodes: ProjectVectorPoint[];
}

export interface VectorStatsResponse {
  /** Per-project node-count provenance: 'partial' while the background
   *  worker is still measuring some projects (rows show a stale/Prisma count). */
  nodeCounts?: { source: 'snapshot' | 'partial'; stale: number; missing: number; refreshing: boolean; queued: number };
  totalVectors: number;
  totalNodes: number;
  coveragePercent: string;
  projects: Array<{
    id: number;
    name: string;
    nodeCount: number;
    vectorCount: number;
    embeddingModel?: string | null;
    embeddingDimensions?: number | null;
    // Per-project embedding attribution (from projectEmbeddingMeta.json)
    embeddingSidecarName?: string | null;
    embeddingSidecarHost?: string | null;
    embeddingSidecarModel?: string | null;
    /** Sidecar Fantom selected before the run; differs from embeddingSidecarName after failover. */
    embeddingSelectedSidecarName?: string | null;
    /** Who actually returned vectors in the last run, by texts served (descending). */
    embeddingServedBy?: Array<{ name: string; texts: number }> | null;
    embeddedInProcess?: boolean | null;
    embeddedAt?: string | null;
  }>;
  docs?: {
    totalVectors: number;
    byPod: Record<string, number>;
  };
  tables?: {
    code: { rows: number; model?: string; dimensions?: number };
    docs: { rows: number; model?: string; dimensions?: number };
  };
  /** Which slot the per-project numbers came from, plus what a paused or
   *  partial rebuild banked in the inactive one. */
  shadow?: {
    building: boolean;
    table: string | null;
    activeTable: string;
    activeVectors: number;
    vectors: number;
    /**
     * WHICH TABLE `totalVectors` / `coveragePercent` were counted from. The
     * endpoint counts the shadow slot while a rebuild builds and the active
     * slot otherwise, and the flag that decides it is cleared by a restart —
     * so the figure can change table between two polls. Render the table name
     * beside the number; a coverage figure whose source is unnamed reads as
     * data loss (it did, on 2026-09-15: 100% → 70%, nothing lost).
     */
    countedFrom?: 'active' | 'shadow';
    countedTable?: string;
    /** Rows in the active slot (what semantic search serves). */
    activeRows?: number;
    /** Rows in the inactive slot — a shadow being built, or one banked. */
    shadowRows?: number;
    /** Code vectors across BOTH slots. Does not move when the displayed
     *  figure changes table, which is what makes a flip legible. */
    rowsOnDisk?: number;
    /** An un-promoted rebuild waiting in the inactive slot. */
    pending: { table: string; rows: number } | null;
    /** The paused job that banked it, so the banner can show progress. */
    job: Pick<ReembedJob, 'id' | 'status' | 'doneProjects' | 'totalProjects' | 'startedAt'> | null;
    canResume: boolean;
    canDiscard: boolean;
    canPromoteAnyway: boolean;
  };
  /** Real fan-out split — provider name → texts embedded, local and cloud. */
  fanout?: Array<{ provider: string; texts: number; projects: number; cloud: boolean }>;
}

/** Full detail of the pending shadow, including the project count a destructive
 *  confirmation needs. Separate from /vectors/stats because counting distinct
 *  projects is a column scan, too costly for a 10 s dashboard poll. */
export interface ShadowStateResponse {
  pending: {
    name: string;
    rows: number;
    projects: number;
    job?: Pick<ReembedJob, 'id' | 'status' | 'doneProjects' | 'totalProjects' | 'startedAt'>;
  } | null;
  canResume?: boolean;
  canDiscard?: boolean;
  canPromoteAnyway?: boolean;
  jobRunning: boolean;
}

export interface ModelStatusResponse {
  code: {
    configuredModel: string;
    configuredDimensions: number;
    storedModel: string | null;
    storedDimensions: number | null;
    storedRows: number;
    mismatch: boolean;
  };
  docs: {
    configuredModel: string;
    configuredDimensions: number;
    storedModel: string | null;
    storedDimensions: number | null;
    storedRows: number;
    mismatch: boolean;
  };
}

// ============================================
// Embedding Model Types
// ============================================

export interface EmbeddingModelStatus {
  modelId: string;
  name: string;
  category: 'code' | 'docs';
  dimensions: number;
  estimatedSize: string;
  downloaded: boolean;
  sizeOnDisk: number;
}

export interface ModelStatusListResponse {
  models: EmbeddingModelStatus[];
}

// ============================================
// Code Project Types
// ============================================

// ============================================
// Project dependencies (ask scope)
// ============================================

export type DependencyKind = 'build.fan-depends' | 'package.json' | 'cross-project-edges' | 'workspace-sibling' | 'manual';

export interface ProjectDependencyRow {
  id: number;
  fromProjectId?: number;
  toProjectId?: number;
  /** The OTHER project of the relation (as seen from the requested project). */
  projectId?: number;
  name?: string;
  language?: string;
  path?: string;
  kind: DependencyKind | string;
  source: string | null;
  confidence: number;
  enabled: boolean;
  createdAt?: string;
}

export interface DeclaredDependency {
  raw: string;
  name: string;
  from: string;
  resolvedProjectId: number | null;
  resolvedProjectName: string | null;
}

export interface ScopeProject {
  id: number;
  name: string;
  language: string;
  kind: string;
  kinds: string[];
  direction: 'depends-on' | 'dependent';
  confidence: number;
  libraries: string[];
  summary: string | null;
}

export interface ProjectDependenciesResponse {
  project: { id: number; name: string; language: string; path: string; libraries: string[]; summary: string | null };
  dependsOn: ProjectDependencyRow[];
  dependents: ProjectDependencyRow[];
  declared: DeclaredDependency[];
  scope: ScopeProject[];
  scopeFallback: boolean;
}

export interface ProjectDependencySummary {
  counts: Record<number, { dependsOn: number; dependents: number }>;
  byPath: Record<string, number>;
  projects: Array<{ id: number; name: string; podName: string | null }>;
}

export interface RebuildDependenciesResult {
  projectId: number;
  added: number;
  updated: number;
  removed: number;
  kinds: Record<string, number>;
  libraries: string[];
  durationMs: number;
}

export interface RebuildAllDependenciesResult {
  projects: number;
  failed: number;
  added: number;
  updated: number;
  removed: number;
  kinds: Record<string, number>;
  durationMs: number;
  errors: Array<{ projectId: number; error: string }>;
}

export interface CodeProject {
  id: number;
  name: string;
  path: string;
  instanceId?: number;
  buildId?: number;
  podName?: string;
  description?: string;
  functionCount: number;
  typeCount: number;
  lastIndexed?: string;
  autoIndex: boolean;
  language?: string;
  parserType?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCodeProjectInput {
  name: string;
  path: string;
  instanceId?: number;
  podName?: string;
  description?: string;
  autoIndex?: boolean;
}

export interface UpdateCodeProjectInput {
  name?: string;
  path?: string;
  instanceId?: number;
  podName?: string;
  description?: string;
  autoIndex?: boolean;
}

// ============================================
// Static Options for Combo Boxes
// ============================================

/** Node types used in code graph */
export const NODE_TYPES = [
  'class',
  'interface',
  'method',
  'function',
  'constructor',
  'field',
  'enum',
  'mixin',
  'type',
  'facet',
  'const',
] as const;

export type NodeType = typeof NODE_TYPES[number];

/** Supported programming languages for code parsing */
export const SUPPORTED_LANGUAGES = [
  'typescript',
  'javascript',
  'python',
  'java',
  'go',
  'rust',
  'c',
  'cpp',
  'csharp',
  'ruby',
  'php',
  'kotlin',
  'swift',
  'scala',
  'fantom',
  'html',
  'css',
  'json',
  'vue',
  'dart',
  'polymer',
] as const;

export type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];

// ============================================
// User Types
// ============================================

export interface UserPublic {
  id: string;
  username: string;
  role: 'admin' | 'user';
  createdAt: string;
  lastLogin?: string;
}

// ============================================
// Backup Types
// ============================================

export interface BackupMetadata {
  id: string;
  createdAt: string;
  serverVersion: string;
  formatVersion: string;
  description?: string;
  createdBy?: string;
  contents: BackupContents;
}

export interface BackupContents {
  configFiles: string[];
  database: boolean;
  databaseStats?: DatabaseBackupStats;
  searchIndexes: boolean;
  searchIndexFiles?: string[];
}

export interface DatabaseBackupStats {
  instances: number;
  pods: number;
  projects: number;
  oauthClients: number;
  settings: number;
}

export interface BackupInfo {
  id: string;
  filename: string;
  createdAt: string;
  size: number;
  path: string;
  metadata: BackupMetadata;
}

export interface BackupResult {
  success: boolean;
  backupId: string;
  path: string;
  size: number;
  metadata: BackupMetadata;
  warnings?: string[];
  errors?: string[];
}

export interface RestoreResult {
  success: boolean;
  backupId: string;
  restoredItems: string[];
  skippedItems: string[];
  preRestoreBackupId?: string;
  warnings?: string[];
  errors?: string[];
  requiresRestart: boolean;
}

export interface CreateBackupOptions {
  includeSearchIndexes?: boolean;
  includeDatabase?: boolean;
  description?: string;
}

export interface RestoreOptions {
  confirm: boolean;
  restoreConfig?: boolean;
  restoreDatabase?: boolean;
  restoreSearchIndexes?: boolean;
  createBackupBeforeRestore?: boolean;
}

// ============================================
// OAuth Types
// ============================================

export interface OAuthSettings {
  runtimeEnabled: boolean;
  configuredEnabled: boolean | null;
  requiresRestart: boolean;
  message: string;
}

export interface OAuthSettingsResult {
  success: boolean;
  configuredEnabled: boolean;
  runtimeEnabled: boolean;
  requiresRestart: boolean;
  message: string;
}
