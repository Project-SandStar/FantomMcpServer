/**
 * Type definitions for Fantom MCP Server
 */

/**
 * Fantom documentation item representing a type, slot, or example
 */
export interface FantomDocItem {
  id: string;
  type: 'type' | 'slot' | 'example' | 'guide';
  name: string;
  qualifiedName?: string; // e.g., "sys::Str"
  pod?: string; // Pod name
  parent?: string; // Parent type for slots
  signature?: string;
  description: string;
  codeExample?: string;
  url: string;
  keywords: string[];
}

/**
 * Result from searching Fantom documentation
 */
export interface SearchResult {
  item: FantomDocItem;
  score: number;
  relevance: string;
}

/**
 * Fantom code element parsed from .fan files
 */
export interface FantomCodeElement {
  id: string;
  type: 'class' | 'mixin' | 'enum' | 'method' | 'field';
  name: string;
  qualifiedName: string;
  pod?: string;
  parent?: string;
  signature?: string;
  docComment?: string;
  filePath: string;
  lineNumber: number;
  modifiers: string[];
}

/**
 * Index entry for search
 */
export interface IndexEntry {
  id: string;
  content: string;
  metadata: Record<string, any>;
}

/**
 * Configuration for the Fantom MCP server
 */
export interface FantomConfig {
  cacheDir: string;
  searchSettings: {
    maxResults: number;
    minScore: number;
    useOrLogic?: boolean;  // Use OR logic for multi-word queries (default: true)
  };
  semanticSearch?: {
    minScore?: number;       // Min vector similarity (0-1, default: 0.5)
    graphWeight?: number;    // Graph score weight (0-1, default: 0.3)
    defaultLimit?: number;   // Default max results (default: 10)
    includeGraphContext?: boolean;  // Include caller/callee context (default: true)
    // Legacy single-model config (still supported, maps to codeModel)
    embeddingModel?: string;
    embeddingDimensions?: number;
    // Dual-model config: separate models for code and documentation
    codeModel?: string;           // Code search model (default: Xenova/bge-small-en-v1.5)
    codeDimensions?: number;      // Code vector dimensions (default: 384)
    docsModel?: string;           // Doc search model (default: Xenova/jina-embeddings-v2-base-en)
    docsDimensions?: number;      // Doc vector dimensions (default: 768)
    embeddingThreads?: number;    // ONNX inference threads (default: 2, higher = faster but more CPU)
    embeddingBatchSize?: number;  // Texts per batch (default: 16, higher = faster but more memory)
    // Retrieval quality (query-time only; no re-embed)
    queryInstruction?: 'auto' | 'off' | string;  // 'auto' = model-based (Qwen3-Embedding gets "Instruct: …\nQuery: …")
    hybrid?: { enabled: boolean; vectorWeight?: number; keywordWeight?: number };  // RRF vector ⊕ FlexSearch (k=60)
    rerank?: 'auto' | 'on' | 'off';  // cross-encoder over fused top-50; 'auto' = when a `reranker` sidecar is usable
    // Embedding text v3 (EMBED_TEXT_VERSION 3): one `kind: file` vector per
    // indexed file and one `kind: project` vector per project (default true).
    embedFileChunks?: boolean;
    embedProjectChunks?: boolean;
  };
  auth?: {
    accessTokenTtl?: number;   // Access token TTL in seconds (default: 3600 = 1 hour)
    refreshTokenTtl?: number;  // Refresh token TTL in seconds (default: 2592000 = 30 days)
    authCodeTtl?: number;      // Authorization code TTL in seconds (default: 600 = 10 minutes)
  };
}

/**
 * Cache metadata
 */
export interface CacheMetadata {
  version: string;
  timestamp: number;
  itemCount: number;
  source: string;
}

/**
 * Cached documentation index
 */
export interface CachedIndex {
  metadata: CacheMetadata;
  items: FantomDocItem[];
}

/**
 * Workflow resource definition
 */
export interface WorkflowResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  content: string;
}

/**
 * Fantom validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  line?: number;
  column?: number;
  message: string;
  code?: string;
}

export interface ValidationWarning {
  line?: number;
  column?: number;
  message: string;
  code?: string;
}

/**
 * Execution result for Fantom code
 */
export interface ExecutionResult {
  success: boolean;
  output?: string;
  error?: string;
  exitCode: number;
  executionTime: number;
}
