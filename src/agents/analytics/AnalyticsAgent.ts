/**
 * Analytics Agent
 * Tracks and reports on tool usage, search patterns, session metrics, and system performance
 */

import {
  BaseAgent,
  ToolDefinition,
  ToolResult,
  UsageStats,
  ToolMetrics,
  AgentEvents,
} from '../base/index.js';

interface ToolEvent {
  toolName: string;
  timestamp: Date;
  duration: number;
  success: boolean;
  sessionId?: string;
}

interface SearchEvent {
  query: string;
  timestamp: Date;
  resultCount: number;
  source?: string;
}

export class AnalyticsAgent extends BaseAgent {
  readonly name = 'analytics';
  readonly description = 'Track and report on tool usage, search patterns, and system performance';
  readonly category = 'analytics';

  // In-memory storage (can be replaced with UsageTracker for SQLite persistence)
  private toolEvents: ToolEvent[] = [];
  private searchEvents: SearchEvent[] = [];
  private maxEvents = 10000;

  // External usage tracker for SQLite persistence
  private usageTracker?: any;

  constructor(options: any) {
    super(options);
    this.usageTracker = options.usageTracker;
  }

  protected async doInitialize(): Promise<void> {
    this.logger.info('Initializing Analytics Agent...');

    // Subscribe to events from other agents
    this.subscribeToEvent(AgentEvents.TOOL_EXECUTED, (event) => {
      this.recordToolCall(event.payload);
    });

    this.subscribeToEvent(AgentEvents.DOCS_SEARCH_PERFORMED, (event) => {
      this.recordSearch(event.payload);
    });
  }

  getTools(): ToolDefinition[] {
    return [
      this.createToolDefinition(
        'analytics_getUsage',
        'Get usage statistics for a time period',
        {
          type: 'object',
          properties: {
            days: { type: 'number', description: 'Number of days to look back (default: 7)' },
            breakdown: {
              type: 'string',
              enum: ['daily', 'hourly', 'total'],
              description: 'Breakdown type (default: total)',
            },
          },
        },
        ['usage', 'statistics', 'stats', 'metrics', 'report', 'activity'],
        ['viewing usage statistics', 'checking tool activity', 'monitoring server usage'],
        ['analytics_getToolMetrics', 'analytics_getSessionStats']
      ),

      this.createToolDefinition(
        'analytics_getTopSearches',
        'Get top search queries',
        {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Maximum results (default: 10)' },
            source: { type: 'string', description: 'Filter by documentation source' },
          },
        },
        ['search', 'queries', 'popular', 'top', 'trending', 'frequent'],
        ['finding popular searches', 'viewing search trends', 'understanding user queries'],
        ['analytics_getUsage']
      ),

      this.createToolDefinition(
        'analytics_getToolMetrics',
        'Get performance metrics for tools',
        {
          type: 'object',
          properties: {
            toolName: { type: 'string', description: 'Specific tool name (optional)' },
            period: { type: 'number', description: 'Number of days (default: 7)' },
          },
        },
        ['performance', 'metrics', 'tools', 'duration', 'success', 'errors'],
        ['checking tool performance', 'monitoring success rates', 'identifying slow tools'],
        ['analytics_getUsage', 'explorer_getSystemHealth']
      ),

      this.createToolDefinition(
        'analytics_getSessionStats',
        'Get session statistics',
        {
          type: 'object',
          properties: {
            days: { type: 'number', description: 'Number of days (default: 7)' },
          },
        },
        ['sessions', 'users', 'connections', 'activity', 'stats'],
        ['viewing session activity', 'monitoring user sessions', 'checking connection stats'],
        ['analytics_getUsage']
      ),

      this.createToolDefinition(
        'analytics_exportData',
        'Export analytics data',
        {
          type: 'object',
          properties: {
            format: {
              type: 'string',
              enum: ['json', 'csv'],
              description: 'Export format (default: json)',
            },
            period: { type: 'number', description: 'Number of days to export (default: 30)' },
          },
        },
        ['export', 'download', 'backup', 'data', 'csv', 'json'],
        ['exporting analytics data', 'backing up usage data', 'downloading reports'],
        ['analytics_getUsage']
      ),

      this.createToolDefinition(
        'analytics_clearData',
        'Clear analytics data',
        {
          type: 'object',
          properties: {
            before: { type: 'string', description: 'Clear data before this date (ISO format)' },
          },
        },
        ['clear', 'delete', 'cleanup', 'purge', 'reset'],
        ['clearing old analytics', 'cleaning up data', 'resetting statistics'],
        ['analytics_getDatabaseInfo']
      ),

      this.createToolDefinition(
        'analytics_getDatabaseInfo',
        'Get analytics database information',
        {
          type: 'object',
          properties: {},
        },
        ['database', 'storage', 'size', 'info', 'status'],
        ['checking database status', 'viewing storage info', 'monitoring database size'],
        ['analytics_clearData']
      ),

      this.createToolDefinition(
        'analytics_trackCustomEvent',
        'Track a custom analytics event',
        {
          type: 'object',
          properties: {
            eventType: { type: 'string', description: 'Event type identifier' },
            data: { type: 'object', description: 'Event data payload' },
          },
          required: ['eventType'],
        },
        ['track', 'event', 'custom', 'log', 'record'],
        ['tracking custom events', 'logging user actions', 'recording custom metrics'],
        ['analytics_getUsage']
      ),
    ];
  }

  async executeTool(toolName: string, params: Record<string, any>): Promise<ToolResult> {
    const startTime = Date.now();
    this.updateActivity();

    try {
      switch (toolName) {
        case 'analytics_getUsage':
          return this.doGetUsage(params, startTime);

        case 'analytics_getTopSearches':
          return this.doGetTopSearches(params, startTime);

        case 'analytics_getToolMetrics':
          return this.doGetToolMetrics(params, startTime);

        case 'analytics_getSessionStats':
          return this.doGetSessionStats(params, startTime);

        case 'analytics_exportData':
          return this.doExportData(params, startTime);

        case 'analytics_clearData':
          return this.doClearData(params, startTime);

        case 'analytics_getDatabaseInfo':
          return this.doGetDatabaseInfo(params, startTime);

        case 'analytics_trackCustomEvent':
          return this.doTrackCustomEvent(params, startTime);

        default:
          return this.createToolResult(false, null, `Unknown tool: ${toolName}`, startTime);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error executing ${toolName}:`, err);
      return this.createToolResult(false, null, error, startTime);
    }
  }

  // Tool implementations

  private async doGetUsage(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const days = params.days ?? 7;
    // const _breakdown = params.breakdown ?? 'total'; // For future daily/hourly breakdown
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Filter events within the period
    const filteredTools = this.toolEvents.filter(e => e.timestamp >= cutoff);
    const filteredSearches = this.searchEvents.filter(e => e.timestamp >= cutoff);

    // Calculate tool usage breakdown
    const toolUsage: Record<string, number> = {};
    for (const event of filteredTools) {
      toolUsage[event.toolName] = (toolUsage[event.toolName] || 0) + 1;
    }

    // Calculate top searches
    const searchCounts: Record<string, number> = {};
    for (const event of filteredSearches) {
      searchCounts[event.query] = (searchCounts[event.query] || 0) + 1;
    }

    const topSearches = Object.entries(searchCounts)
      .map(([query, count]) => ({ query, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const stats: UsageStats = {
      totalToolCalls: filteredTools.length,
      totalSearches: filteredSearches.length,
      toolUsage,
      topSearches,
      periodStart: cutoff.toISOString(),
      periodEnd: new Date().toISOString(),
    };

    return this.createToolResult(true, stats, undefined, startTime);
  }

  private async doGetTopSearches(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const limit = params.limit ?? 10;
    const source = params.source;

    let searches = [...this.searchEvents];
    if (source) {
      searches = searches.filter(e => e.source === source);
    }

    const searchCounts: Record<string, number> = {};
    for (const event of searches) {
      searchCounts[event.query] = (searchCounts[event.query] || 0) + 1;
    }

    const topSearches = Object.entries(searchCounts)
      .map(([query, count]) => ({ query, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);

    return this.createToolResult(true, {
      topSearches,
      totalUniqueQueries: Object.keys(searchCounts).length,
      totalSearches: searches.length,
    }, undefined, startTime);
  }

  private async doGetToolMetrics(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const { toolName, period = 7 } = params;
    const cutoff = new Date(Date.now() - period * 24 * 60 * 60 * 1000);

    let events = this.toolEvents.filter(e => e.timestamp >= cutoff);
    if (toolName) {
      events = events.filter(e => e.toolName === toolName);
    }

    // Group by tool
    const toolGroups: Record<string, ToolEvent[]> = {};
    for (const event of events) {
      if (!toolGroups[event.toolName]) {
        toolGroups[event.toolName] = [];
      }
      toolGroups[event.toolName].push(event);
    }

    // Calculate metrics for each tool
    const metrics: ToolMetrics[] = Object.entries(toolGroups).map(([name, toolEvents]) => {
      const successful = toolEvents.filter(e => e.success).length;
      const durations = toolEvents.map(e => e.duration);
      const avgDuration = durations.length > 0
        ? durations.reduce((a, b) => a + b, 0) / durations.length
        : 0;

      return {
        name,
        callCount: toolEvents.length,
        successRate: toolEvents.length > 0 ? successful / toolEvents.length : 0,
        avgDuration: Math.round(avgDuration),
        errorRate: toolEvents.length > 0 ? (toolEvents.length - successful) / toolEvents.length : 0,
      };
    });

    return this.createToolResult(true, {
      metrics: metrics.sort((a, b) => b.callCount - a.callCount),
      period: `${period} days`,
    }, undefined, startTime);
  }

  private async doGetSessionStats(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const days = params.days ?? 7;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const events = this.toolEvents.filter(e => e.timestamp >= cutoff);
    const sessions = new Set(events.map(e => e.sessionId).filter(Boolean));

    return this.createToolResult(true, {
      uniqueSessions: sessions.size,
      totalEvents: events.length,
      period: `${days} days`,
      avgEventsPerSession: sessions.size > 0 ? Math.round(events.length / sessions.size) : 0,
    }, undefined, startTime);
  }

  private async doExportData(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const format = params.format ?? 'json';
    const period = params.period ?? 30;
    const cutoff = new Date(Date.now() - period * 24 * 60 * 60 * 1000);

    const toolData = this.toolEvents.filter(e => e.timestamp >= cutoff);
    const searchData = this.searchEvents.filter(e => e.timestamp >= cutoff);

    if (format === 'json') {
      return this.createToolResult(true, {
        exportFormat: 'json',
        period: `${period} days`,
        data: {
          toolEvents: toolData,
          searchEvents: searchData,
        },
      }, undefined, startTime);
    }

    // CSV format
    const toolCsv = [
      'toolName,timestamp,duration,success,sessionId',
      ...toolData.map(e =>
        `${e.toolName},${e.timestamp.toISOString()},${e.duration},${e.success},${e.sessionId || ''}`
      ),
    ].join('\n');

    const searchCsv = [
      'query,timestamp,resultCount,source',
      ...searchData.map(e =>
        `"${e.query.replace(/"/g, '""')}",${e.timestamp.toISOString()},${e.resultCount},${e.source || ''}`
      ),
    ].join('\n');

    return this.createToolResult(true, {
      exportFormat: 'csv',
      period: `${period} days`,
      toolEventsCsv: toolCsv,
      searchEventsCsv: searchCsv,
    }, undefined, startTime);
  }

  private async doClearData(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    let clearedToolEvents = 0;
    let clearedSearchEvents = 0;

    if (params.before) {
      const beforeDate = new Date(params.before);
      const originalToolCount = this.toolEvents.length;
      const originalSearchCount = this.searchEvents.length;

      this.toolEvents = this.toolEvents.filter(e => e.timestamp >= beforeDate);
      this.searchEvents = this.searchEvents.filter(e => e.timestamp >= beforeDate);

      clearedToolEvents = originalToolCount - this.toolEvents.length;
      clearedSearchEvents = originalSearchCount - this.searchEvents.length;
    } else {
      clearedToolEvents = this.toolEvents.length;
      clearedSearchEvents = this.searchEvents.length;
      this.toolEvents = [];
      this.searchEvents = [];
    }

    return this.createToolResult(true, {
      success: true,
      clearedToolEvents,
      clearedSearchEvents,
      remainingToolEvents: this.toolEvents.length,
      remainingSearchEvents: this.searchEvents.length,
    }, undefined, startTime);
  }

  private async doGetDatabaseInfo(_params: Record<string, any>, startTime: number): Promise<ToolResult> {
    return this.createToolResult(true, {
      storageType: this.usageTracker ? 'sqlite' : 'in-memory',
      toolEventCount: this.toolEvents.length,
      searchEventCount: this.searchEvents.length,
      maxEvents: this.maxEvents,
      memoryUsage: {
        toolEventsApprox: `${Math.round(JSON.stringify(this.toolEvents).length / 1024)} KB`,
        searchEventsApprox: `${Math.round(JSON.stringify(this.searchEvents).length / 1024)} KB`,
      },
    }, undefined, startTime);
  }

  private async doTrackCustomEvent(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const validationError = this.validateParams(params, ['eventType']);
    if (validationError) {
      return this.createToolResult(false, null, validationError, startTime);
    }

    this.publishEvent(AgentEvents.ANALYTICS_RECORDED, {
      eventType: params.eventType,
      data: params.data || {},
      timestamp: new Date(),
    });

    return this.createToolResult(true, {
      success: true,
      eventType: params.eventType,
      recorded: new Date().toISOString(),
    }, undefined, startTime);
  }

  // Public methods for recording events

  recordToolCall(event: Partial<ToolEvent>): void {
    const toolEvent: ToolEvent = {
      toolName: event.toolName || 'unknown',
      timestamp: event.timestamp || new Date(),
      duration: event.duration || 0,
      success: event.success ?? true,
      sessionId: event.sessionId,
    };

    this.toolEvents.push(toolEvent);

    // Trim old events
    if (this.toolEvents.length > this.maxEvents) {
      this.toolEvents = this.toolEvents.slice(-this.maxEvents);
    }
  }

  recordSearch(event: Partial<SearchEvent>): void {
    const searchEvent: SearchEvent = {
      query: event.query || '',
      timestamp: event.timestamp || new Date(),
      resultCount: event.resultCount || 0,
      source: event.source,
    };

    this.searchEvents.push(searchEvent);

    // Trim old events
    if (this.searchEvents.length > this.maxEvents) {
      this.searchEvents = this.searchEvents.slice(-this.maxEvents);
    }
  }

  // Public accessor for stats
  getQuickStats(): { toolEvents: number; searchEvents: number } {
    return {
      toolEvents: this.toolEvents.length,
      searchEvents: this.searchEvents.length,
    };
  }
}
