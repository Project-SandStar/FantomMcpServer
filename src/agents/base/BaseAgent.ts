/**
 * Abstract base class for all MCP Explorer agents
 * Provides common functionality for lifecycle, tools, and event handling
 */

import {
  AgentStatus,
  AgentInitOptions,
  AgentEventBusInterface,
  LoggerInterface,
  ToolDefinition,
  ToolResult,
  AgentEvent,
} from './types.js';
import { AgentEvents } from './AgentEventBus.js';
import { createLogger } from '../../utils/index.js';

export abstract class BaseAgent {
  /** Unique name identifier for this agent */
  abstract readonly name: string;

  /** Human-readable description */
  abstract readonly description: string;

  /** Tool category this agent belongs to */
  abstract readonly category: string;

  protected eventBus: AgentEventBusInterface;
  protected logger: LoggerInterface;
  protected config: Record<string, any>;

  protected _status: AgentStatus['status'] = 'initializing';
  protected _initialized: boolean = false;
  protected _lastActivity?: Date;
  protected _error?: string;

  private initializationPromise?: Promise<void>;

  constructor(options: AgentInitOptions) {
    this.eventBus = options.eventBus;
    this.logger = options.logger ?? createLogger(this.constructor.name);
    this.config = options.config ?? {};
  }

  /**
   * Initialize the agent - must be implemented by subclasses
   */
  protected abstract doInitialize(): Promise<void>;

  /**
   * Get tools provided by this agent - must be implemented by subclasses
   */
  abstract getTools(): ToolDefinition[];

  /**
   * Execute a tool - must be implemented by subclasses
   */
  abstract executeTool(toolName: string, params: Record<string, any>): Promise<ToolResult>;

  /**
   * Clean up resources - can be overridden by subclasses
   */
  protected async doShutdown(): Promise<void> {
    // Default: no cleanup needed
  }

  /**
   * Initialize the agent (public entry point)
   */
  async initialize(): Promise<void> {
    if (this._initialized) {
      return;
    }

    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = this.performInitialization();
    return this.initializationPromise;
  }

  private async performInitialization(): Promise<void> {
    try {
      this._status = 'initializing';
      this.logger.info(`Initializing ${this.name} agent...`);

      await this.doInitialize();

      this._initialized = true;
      this._status = 'ready';
      this._lastActivity = new Date();

      this.publishEvent(AgentEvents.AGENT_INITIALIZED, {
        agent: this.name,
        toolCount: this.getTools().length,
      });

      this.logger.info(`${this.name} agent initialized successfully`);
    } catch (err) {
      this._status = 'error';
      this._error = err instanceof Error ? err.message : String(err);

      this.publishEvent(AgentEvents.AGENT_ERROR, {
        agent: this.name,
        error: this._error,
      });

      this.logger.error(`Failed to initialize ${this.name} agent:`, err);
      throw err;
    }
  }

  /**
   * Shutdown the agent
   */
  async shutdown(): Promise<void> {
    if (!this._initialized) {
      return;
    }

    try {
      this.logger.info(`Shutting down ${this.name} agent...`);
      await this.doShutdown();
      this._status = 'stopped';
      this._initialized = false;

      this.publishEvent(AgentEvents.AGENT_STOPPED, {
        agent: this.name,
      });

      this.logger.info(`${this.name} agent shut down`);
    } catch (err) {
      this.logger.error(`Error shutting down ${this.name} agent:`, err);
      throw err;
    }
  }

  /**
   * Get agent status
   */
  getStatus(): AgentStatus {
    return {
      name: this.name,
      status: this._status,
      initialized: this._initialized,
      lastActivity: this._lastActivity,
      error: this._error,
      metadata: {
        category: this.category,
        toolCount: this._initialized ? this.getTools().length : 0,
      },
    };
  }

  /**
   * Check if agent is ready for tool execution
   */
  isReady(): boolean {
    return this._initialized && this._status === 'ready';
  }

  /**
   * Wait for initialization to complete
   */
  async waitForReady(): Promise<void> {
    if (this._initialized) {
      return;
    }

    if (this.initializationPromise) {
      await this.initializationPromise;
    }
  }

  /**
   * Publish an event to the event bus
   */
  protected publishEvent(type: string, payload: any): void {
    this.eventBus.publish({
      type,
      source: this.name,
      timestamp: new Date(),
      payload,
    });
  }

  /**
   * Subscribe to an event type
   */
  protected subscribeToEvent(type: string, handler: (event: AgentEvent) => void | Promise<void>): void {
    this.eventBus.subscribe(type, handler);
  }

  /**
   * Update last activity timestamp
   */
  protected updateActivity(): void {
    this._lastActivity = new Date();
  }

  /**
   * Set agent to busy status during long operations
   */
  protected setBusy(): void {
    this._status = 'busy';
  }

  /**
   * Set agent back to ready status
   */
  protected setReady(): void {
    this._status = 'ready';
  }

  /**
   * Helper to create tool result
   */
  protected createToolResult(success: boolean, data?: any, error?: string, startTime?: number): ToolResult {
    return {
      success,
      data,
      error,
      executionTime: startTime ? Date.now() - startTime : 0,
    };
  }

  /**
   * Helper to validate required parameters
   */
  protected validateParams(params: Record<string, any>, required: string[]): string | null {
    for (const param of required) {
      if (params[param] === undefined || params[param] === null) {
        return `Missing required parameter: ${param}`;
      }
    }
    return null;
  }

  /**
   * Create tool definition helper
   */
  protected createToolDefinition(
    name: string,
    description: string,
    inputSchema: Record<string, any>,
    keywords?: string[],
    useCases?: string[],
    relatedTools?: string[]
  ): ToolDefinition {
    return {
      name,
      description,
      agent: this.name,
      category: this.category as any,
      inputSchema,
      keywords,
      useCases,
      relatedTools,
    };
  }
}
