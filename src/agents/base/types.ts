/**
 * Shared type definitions for the MCP Explorer agent framework
 */

/**
 * Agent status information
 */
export interface AgentStatus {
  name: string;
  status: 'initializing' | 'ready' | 'busy' | 'error' | 'stopped';
  initialized: boolean;
  lastActivity?: Date;
  error?: string;
  metadata?: Record<string, any>;
}

/**
 * System health aggregation
 */
export interface SystemHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  agents: Record<string, AgentStatus>;
  uptime: number;
  memoryUsage: MemoryInfo;
  activeSessions: number;
  timestamp: Date;
}

export interface MemoryInfo {
  heapUsed: number;
  heapTotal: number;
  external: number;
  rss: number;
}

/**
 * Tool definition for MCP registration
 */
export interface ToolDefinition {
  name: string;
  description: string;
  agent: string;
  category: ToolCategory;
  inputSchema: Record<string, any>;
  examples?: ToolExample[];
  // For tool search discoverability
  keywords?: string[];        // Searchable keywords
  useCases?: string[];        // Common use cases
  relatedTools?: string[];    // Related tool names
}

export interface ToolExample {
  description: string;
  params: Record<string, any>;
}

export type ToolCategory =
  | 'documentation'
  | 'code-analysis'
  | 'code-generation'
  | 'project-management'
  | 'analytics'
  | 'explorer';

/**
 * Tool execution result
 */
export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
  executionTime: number;
}

/**
 * Agent event for inter-agent communication
 */
export interface AgentEvent {
  type: string;
  source: string;
  timestamp: Date;
  payload: any;
}

export type EventHandler = (event: AgentEvent) => void | Promise<void>;

/**
 * Agent initialization options
 */
export interface AgentInitOptions {
  eventBus: AgentEventBusInterface;
  logger?: LoggerInterface;
  config?: Record<string, any>;
}

/**
 * Event bus interface for dependency injection
 */
export interface AgentEventBusInterface {
  publish(event: AgentEvent): void;
  subscribe(eventType: string, handler: EventHandler): void;
  unsubscribe(eventType: string, handler: EventHandler): void;
  subscribeAll(handler: EventHandler): void;
  unsubscribeAll(handler: EventHandler): void;
}

/**
 * Logger interface for dependency injection
 */
export interface LoggerInterface {
  debug(...args: any[]): void;
  info(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
}

/**
 * Documentation search options
 */
export interface DocSearchOptions {
  sources?: DocSource[];
  type?: 'type' | 'slot' | 'example' | 'guide';
  pod?: string;
  limit?: number;
  minScore?: number;
}

export type DocSource = 'fantom' | 'haxall' | 'local' | 'project';

/**
 * Index statistics
 */
export interface IndexStats {
  totalItems: number;
  byType: Record<string, number>;
  byPod: Record<string, number>;
  bySource: Record<string, number>;
  lastUpdated: Date;
}

/**
 * Code parse result
 */
export interface ParseResult {
  success: boolean;
  ast?: ASTNode;
  errors: ParseError[];
  symbols: Symbol[];
  executionTime: number;
}

export interface ASTNode {
  type: string;
  name?: string;
  children?: ASTNode[];
  location?: SourceLocation;
  [key: string]: any;
}

export interface ParseError {
  line: number;
  column: number;
  message: string;
  code?: string;
}

export interface Symbol {
  name: string;
  type: SymbolType;
  qualifiedName: string;
  location: SourceLocation;
  signature?: string;
  docComment?: string;
  modifiers?: string[];
}

export type SymbolType = 'class' | 'mixin' | 'enum' | 'method' | 'field' | 'facet' | 'const';

export interface SourceLocation {
  file?: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

/**
 * Code generation options
 */
export interface GeneratedCode {
  code: string;
  filename: string;
  valid: boolean;
  errors?: string[];
}

export interface PodStructure {
  name: string;
  files: Record<string, string>;
  structure: string;
}

/**
 * Project context
 */
export interface PrimaryProjectContext {
  instance: string;
  project: string;
  setBy: 'vscode' | 'dashboard' | 'api' | 'startup' | 'agent';
  timestamp: Date;
}

/**
 * Migration result
 */
export interface MigrationResult {
  success: boolean;
  branch: string;
  filesChanged: string[];
  filesCreated: string[];
  compilationSuccess: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Usage statistics
 */
export interface UsageStats {
  totalToolCalls: number;
  totalSearches: number;
  toolUsage: Record<string, number>;
  topSearches: Array<{ query: string; count: number }>;
  periodStart: string;
  periodEnd: string;
}

/**
 * Tool metrics
 */
export interface ToolMetrics {
  name: string;
  callCount: number;
  successRate: number;
  avgDuration: number;
  errorRate: number;
}

/**
 * Session information
 */
export interface SessionInfo {
  id: string;
  createdAt: Date;
  lastActivity: Date;
  metadata?: Record<string, any>;
}

/**
 * Workflow resource
 */
export interface WorkflowInfo {
  id: string;
  name: string;
  description: string;
  category?: string;
  uri: string;
}
