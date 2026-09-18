/**
 * Event bus for inter-agent communication
 * Implements publish-subscribe pattern for decoupled agent interaction
 */

import { AgentEvent, EventHandler, AgentEventBusInterface } from './types.js';
import { createLogger } from '../../utils/index.js';

const logger = createLogger('AgentEventBus');

export class AgentEventBus implements AgentEventBusInterface {
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private globalHandlers: Set<EventHandler> = new Set();
  private eventHistory: AgentEvent[] = [];
  private maxHistorySize: number;

  constructor(options: { maxHistorySize?: number } = {}) {
    this.maxHistorySize = options.maxHistorySize ?? 100;
  }

  /**
   * Publish an event to all subscribers
   */
  publish(event: AgentEvent): void {
    logger.debug(`Publishing event: ${event.type} from ${event.source}`);

    // Add timestamp if not present
    if (!event.timestamp) {
      event.timestamp = new Date();
    }

    // Store in history
    this.eventHistory.push(event);
    if (this.eventHistory.length > this.maxHistorySize) {
      this.eventHistory.shift();
    }

    // Notify type-specific handlers
    const typeHandlers = this.handlers.get(event.type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        this.safeExecute(handler, event);
      }
    }

    // Notify global handlers
    for (const handler of this.globalHandlers) {
      this.safeExecute(handler, event);
    }
  }

  /**
   * Subscribe to a specific event type
   */
  subscribe(eventType: string, handler: EventHandler): void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);
    logger.debug(`Subscribed to event type: ${eventType}`);
  }

  /**
   * Unsubscribe from a specific event type
   */
  unsubscribe(eventType: string, handler: EventHandler): void {
    const typeHandlers = this.handlers.get(eventType);
    if (typeHandlers) {
      typeHandlers.delete(handler);
      logger.debug(`Unsubscribed from event type: ${eventType}`);
    }
  }

  /**
   * Subscribe to all events
   */
  subscribeAll(handler: EventHandler): void {
    this.globalHandlers.add(handler);
    logger.debug('Subscribed to all events');
  }

  /**
   * Unsubscribe from all events
   */
  unsubscribeAll(handler: EventHandler): void {
    this.globalHandlers.delete(handler);
    logger.debug('Unsubscribed from all events');
  }

  /**
   * Get recent event history
   */
  getHistory(limit?: number): AgentEvent[] {
    const count = limit ?? this.eventHistory.length;
    return this.eventHistory.slice(-count);
  }

  /**
   * Get events by type
   */
  getEventsByType(eventType: string, limit?: number): AgentEvent[] {
    const filtered = this.eventHistory.filter(e => e.type === eventType);
    return limit ? filtered.slice(-limit) : filtered;
  }

  /**
   * Get events from a specific source
   */
  getEventsBySource(source: string, limit?: number): AgentEvent[] {
    const filtered = this.eventHistory.filter(e => e.source === source);
    return limit ? filtered.slice(-limit) : filtered;
  }

  /**
   * Clear event history
   */
  clearHistory(): void {
    this.eventHistory = [];
    logger.debug('Event history cleared');
  }

  /**
   * Get subscriber count for an event type
   */
  getSubscriberCount(eventType?: string): number {
    if (eventType) {
      const handlers = this.handlers.get(eventType);
      return (handlers?.size ?? 0) + this.globalHandlers.size;
    }
    let total = this.globalHandlers.size;
    for (const handlers of this.handlers.values()) {
      total += handlers.size;
    }
    return total;
  }

  /**
   * Safely execute handler with error catching
   */
  private safeExecute(handler: EventHandler, event: AgentEvent): void {
    try {
      const result = handler(event);
      if (result instanceof Promise) {
        result.catch(err => {
          logger.error(`Async handler error for event ${event.type}:`, err);
        });
      }
    } catch (err) {
      logger.error(`Handler error for event ${event.type}:`, err);
    }
  }
}

// Event type constants for type safety
export const AgentEvents = {
  // Documentation Agent events
  DOCS_INDEX_UPDATED: 'docs.indexUpdated',
  DOCS_SEARCH_PERFORMED: 'docs.searchPerformed',
  DOCS_TYPE_FETCHED: 'docs.typeFetched',

  // Code Analysis Agent events
  CODE_PARSED: 'code.parsed',
  CODE_SYMBOLS_EXTRACTED: 'code.symbolsExtracted',
  CODE_VALIDATED: 'code.validated',

  // Code Generation Agent events
  CODE_GENERATED: 'gen.codeGenerated',
  CODE_TEMPLATE_APPLIED: 'gen.templateApplied',

  // Project Management Agent events
  PROJECT_CHANGED: 'project.changed',
  PROJECT_MIGRATED: 'project.migrated',
  PROJECT_CONFIG_UPDATED: 'project.configUpdated',

  // Analytics Agent events
  ANALYTICS_RECORDED: 'analytics.recorded',
  ANALYTICS_EXPORTED: 'analytics.exported',

  // Explorer Orchestration Agent events
  TOOL_EXECUTED: 'explorer.toolExecuted',
  SESSION_CREATED: 'explorer.sessionCreated',
  SESSION_TERMINATED: 'explorer.sessionTerminated',
  HEALTH_CHANGED: 'explorer.healthChanged',

  // System events
  AGENT_INITIALIZED: 'system.agentInitialized',
  AGENT_ERROR: 'system.agentError',
  AGENT_STOPPED: 'system.agentStopped',
} as const;

export type AgentEventType = typeof AgentEvents[keyof typeof AgentEvents];
