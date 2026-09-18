/**
 * Explorer Orchestration Agent
 * Central coordinator for request routing, tool discovery, session management, and Explorer API
 */

import {
  BaseAgent,
  ToolDefinition,
  ToolResult,
  SystemHealth,
  AgentStatus,
  SessionInfo,
  WorkflowInfo,
  AgentEvents,
} from '../base/index.js';

interface RegisteredAgent {
  agent: BaseAgent;
  tools: ToolDefinition[];
}

export class ExplorerOrchestrationAgent extends BaseAgent {
  readonly name = 'explorer';
  readonly description = 'Central coordinator for request routing, tool discovery, and Explorer API';
  readonly category = 'explorer';

  private registeredAgents: Map<string, RegisteredAgent> = new Map();
  private toolRegistry: Map<string, { agent: string; tool: ToolDefinition }> = new Map();
  private sessions: Map<string, SessionInfo> = new Map();

  // External dependencies
  private workflowManager?: any;
  private startTime: Date;

  constructor(options: any) {
    super(options);
    this.workflowManager = options.workflowManager;
    this.startTime = new Date();
  }

  protected async doInitialize(): Promise<void> {
    this.logger.info('Initializing Explorer Orchestration Agent...');

    // Register this orchestrator's own tools in the toolRegistry
    for (const tool of this.getTools()) {
      this.toolRegistry.set(tool.name, { agent: this.name, tool });
    }

    this.logger.info(`Registered agents: ${this.registeredAgents.size}`);
    this.logger.info(`Total tools: ${this.toolRegistry.size}`);
  }

  /**
   * Register an agent with the orchestrator
   */
  registerAgent(agent: BaseAgent): void {
    const tools = agent.getTools();

    this.registeredAgents.set(agent.name, { agent, tools });

    // Register tools in the tool registry
    for (const tool of tools) {
      this.toolRegistry.set(tool.name, { agent: agent.name, tool });
    }

    this.logger.info(`Registered agent: ${agent.name} with ${tools.length} tools`);
  }

  /**
   * Get a registered agent by name
   */
  getAgent<T extends BaseAgent>(name: string): T | undefined {
    const registered = this.registeredAgents.get(name);
    return registered?.agent as T | undefined;
  }

  getTools(): ToolDefinition[] {
    return [
      this.createToolDefinition(
        'explorer_listTools',
        'List all available MCP tools from all agents',
        {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              enum: ['documentation', 'code-analysis', 'code-generation', 'project-management', 'analytics', 'explorer'],
              description: 'Filter by tool category',
            },
            agent: { type: 'string', description: 'Filter by agent name' },
          },
        },
        ['list', 'tools', 'available', 'all', 'capabilities', 'inventory'],
        ['listing all available tools', 'viewing tool inventory', 'exploring capabilities'],
        ['explorer_searchTools', 'explorer_browseCategories']
      ),

      this.createToolDefinition(
        'explorer_getToolSchema',
        'Get the input schema for a specific tool',
        {
          type: 'object',
          properties: {
            toolName: { type: 'string', description: 'Name of the tool' },
          },
          required: ['toolName'],
        },
        ['schema', 'parameters', 'input', 'args', 'definition', 'spec'],
        ['getting tool parameters', 'viewing input schema', 'understanding tool interface'],
        ['explorer_listTools', 'explorer_executeTool']
      ),

      this.createToolDefinition(
        'explorer_executeTool',
        'Execute a tool with parameter validation',
        {
          type: 'object',
          properties: {
            toolName: { type: 'string', description: 'Name of the tool to execute' },
            params: { type: 'object', description: 'Tool parameters' },
          },
          required: ['toolName'],
        },
        ['execute', 'run', 'call', 'invoke', 'tool'],
        ['executing a tool', 'running tool with parameters', 'invoking tool action'],
        ['explorer_getToolSchema', 'explorer_listTools']
      ),

      this.createToolDefinition(
        'explorer_getAgentStatus',
        'Get status of a specific agent',
        {
          type: 'object',
          properties: {
            agentName: { type: 'string', description: 'Name of the agent' },
          },
          required: ['agentName'],
        },
        ['agent', 'status', 'health', 'state', 'check'],
        ['checking agent status', 'viewing agent health', 'monitoring agent state'],
        ['explorer_getSystemHealth']
      ),

      this.createToolDefinition(
        'explorer_getSystemHealth',
        'Get overall system health including all agents',
        {
          type: 'object',
          properties: {},
        },
        ['health', 'system', 'status', 'memory', 'uptime', 'monitoring'],
        ['checking system health', 'monitoring server status', 'viewing overall health'],
        ['explorer_getAgentStatus', 'analytics_getToolMetrics']
      ),

      this.createToolDefinition(
        'explorer_browseCategories',
        'Browse tool categories with counts',
        {
          type: 'object',
          properties: {},
        },
        ['categories', 'browse', 'groups', 'organize', 'overview'],
        ['browsing tool categories', 'viewing category overview', 'exploring tool groups'],
        ['explorer_listTools', 'explorer_searchTools']
      ),

      this.createToolDefinition(
        'explorer_searchTools',
        'Search tools by name, description, keywords, or use case. Returns ranked results with relevance scores.',
        {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural language search query' },
            category: {
              type: 'string',
              enum: ['documentation', 'code-analysis', 'code-generation', 'project-management', 'analytics', 'explorer'],
              description: 'Filter by category',
            },
            limit: { type: 'number', description: 'Max results (default: 10)' },
          },
          required: ['query'],
        },
        ['search', 'find', 'discover', 'lookup', 'tool', 'capability'],
        ['finding the right tool for a task', 'discovering available capabilities', 'tool discovery'],
        ['explorer_listTools', 'explorer_browseCategories']
      ),

      this.createToolDefinition(
        'explorer_getWorkflows',
        'Get available workflow resources',
        {
          type: 'object',
          properties: {
            category: { type: 'string', description: 'Filter by workflow category' },
          },
        },
        ['workflows', 'guides', 'tutorials', 'resources', 'help'],
        ['finding workflow guides', 'viewing available tutorials', 'getting help resources'],
        ['explorer_listTools']
      ),
    ];
  }

  async executeTool(toolName: string, params: Record<string, any>): Promise<ToolResult> {
    const startTime = Date.now();
    this.updateActivity();

    try {
      switch (toolName) {
        case 'explorer_listTools':
          return this.doListTools(params, startTime);

        case 'explorer_getToolSchema':
          return this.doGetToolSchema(params, startTime);

        case 'explorer_executeTool':
          return this.doExecuteTool(params, startTime);

        case 'explorer_getAgentStatus':
          return this.doGetAgentStatus(params, startTime);

        case 'explorer_getSystemHealth':
          return this.doGetSystemHealth(params, startTime);

        case 'explorer_browseCategories':
          return this.doBrowseCategories(params, startTime);

        case 'explorer_searchTools':
          return this.doSearchTools(params, startTime);

        case 'explorer_getWorkflows':
          return this.doGetWorkflows(params, startTime);

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

  private async doListTools(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const { category, agent } = params;

    let tools = Array.from(this.toolRegistry.values());

    if (category) {
      tools = tools.filter(t => t.tool.category === category);
    }

    if (agent) {
      tools = tools.filter(t => t.agent === agent);
    }

    // Group by category
    const grouped: Record<string, any[]> = {};
    for (const { agent: agentName, tool } of tools) {
      const cat = tool.category;
      if (!grouped[cat]) {
        grouped[cat] = [];
      }
      grouped[cat].push({
        name: tool.name,
        description: tool.description,
        agent: agentName,
      });
    }

    return this.createToolResult(true, {
      totalTools: tools.length,
      byCategory: grouped,
      categories: Object.keys(grouped),
    }, undefined, startTime);
  }

  private async doGetToolSchema(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const validationError = this.validateParams(params, ['toolName']);
    if (validationError) {
      return this.createToolResult(false, null, validationError, startTime);
    }

    const entry = this.toolRegistry.get(params.toolName);
    if (!entry) {
      return this.createToolResult(false, null, `Tool not found: ${params.toolName}`, startTime);
    }

    return this.createToolResult(true, {
      name: entry.tool.name,
      description: entry.tool.description,
      agent: entry.agent,
      category: entry.tool.category,
      inputSchema: entry.tool.inputSchema,
      examples: entry.tool.examples,
    }, undefined, startTime);
  }

  private async doExecuteTool(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const validationError = this.validateParams(params, ['toolName']);
    if (validationError) {
      return this.createToolResult(false, null, validationError, startTime);
    }

    const { toolName, params: toolParams = {} } = params;

    const entry = this.toolRegistry.get(toolName);
    if (!entry) {
      return this.createToolResult(false, null, `Tool not found: ${toolName}`, startTime);
    }

    let result: ToolResult;

    // Handle this orchestrator's own tools (self-execution)
    if (entry.agent === this.name) {
      result = await this.executeTool(toolName, toolParams);
    } else {
      // Execute tool from registered agent
      const registered = this.registeredAgents.get(entry.agent);
      if (!registered) {
        return this.createToolResult(false, null, `Agent not found: ${entry.agent}`, startTime);
      }
      result = await registered.agent.executeTool(toolName, toolParams);
    }

    // Publish execution event
    this.publishEvent(AgentEvents.TOOL_EXECUTED, {
      toolName,
      agent: entry.agent,
      success: result.success,
      duration: result.executionTime,
    });

    return result;
  }

  private async doGetAgentStatus(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const validationError = this.validateParams(params, ['agentName']);
    if (validationError) {
      return this.createToolResult(false, null, validationError, startTime);
    }

    const registered = this.registeredAgents.get(params.agentName);
    if (!registered) {
      return this.createToolResult(false, null, `Agent not found: ${params.agentName}`, startTime);
    }

    const status = registered.agent.getStatus();

    return this.createToolResult(true, {
      agent: params.agentName,
      status,
      toolCount: registered.tools.length,
    }, undefined, startTime);
  }

  private async doGetSystemHealth(_params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const agents: Record<string, AgentStatus> = {};
    let allHealthy = true;

    for (const [name, { agent }] of this.registeredAgents) {
      const status = agent.getStatus();
      agents[name] = status;
      if (status.status !== 'ready') {
        allHealthy = false;
      }
    }

    // Also include this orchestrator
    agents[this.name] = this.getStatus();

    const memoryUsage = process.memoryUsage();
    const uptime = Date.now() - this.startTime.getTime();

    const health: SystemHealth = {
      status: allHealthy ? 'healthy' : 'degraded',
      agents,
      uptime,
      memoryUsage: {
        heapUsed: memoryUsage.heapUsed,
        heapTotal: memoryUsage.heapTotal,
        external: memoryUsage.external,
        rss: memoryUsage.rss,
      },
      activeSessions: this.sessions.size,
      timestamp: new Date(),
    };

    return this.createToolResult(true, health, undefined, startTime);
  }

  private async doBrowseCategories(_params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const categories: Record<string, { count: number; agents: string[] }> = {};

    for (const { agent, tool } of this.toolRegistry.values()) {
      const cat = tool.category;
      if (!categories[cat]) {
        categories[cat] = { count: 0, agents: [] };
      }
      categories[cat].count++;
      if (!categories[cat].agents.includes(agent)) {
        categories[cat].agents.push(agent);
      }
    }

    return this.createToolResult(true, {
      categories: Object.entries(categories).map(([name, data]) => ({
        name,
        toolCount: data.count,
        agents: data.agents,
      })),
      totalCategories: Object.keys(categories).length,
    }, undefined, startTime);
  }

  private async doSearchTools(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const validationError = this.validateParams(params, ['query']);
    if (validationError) {
      return this.createToolResult(false, null, validationError, startTime);
    }

    const { query, category, limit = 10 } = params;
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter((t: string) => t.length > 1);

    const scored: Array<{ tool: ToolDefinition; agent: string; score: number; matches: string[] }> = [];

    for (const { agent, tool } of this.toolRegistry.values()) {
      // Skip if category filter doesn't match
      if (category && tool.category !== category) continue;

      let score = 0;
      const matches: string[] = [];

      // Name exact match (highest)
      if (tool.name.toLowerCase() === queryLower) {
        score += 100;
        matches.push('exact_name');
      }
      // Name contains query
      else if (tool.name.toLowerCase().includes(queryLower)) {
        score += 50;
        matches.push('name');
      }

      // Description matches
      const descLower = tool.description.toLowerCase();
      for (const term of queryTerms) {
        if (descLower.includes(term)) {
          score += 10;
          matches.push(`desc:${term}`);
        }
      }

      // Keywords match (if present)
      if (tool.keywords) {
        for (const kw of tool.keywords) {
          const kwLower = kw.toLowerCase();
          if (queryTerms.some((t: string) => kwLower.includes(t) || t.includes(kwLower))) {
            score += 20;
            matches.push(`keyword:${kw}`);
          }
        }
      }

      // Use cases match (if present)
      if (tool.useCases) {
        for (const uc of tool.useCases) {
          const ucLower = uc.toLowerCase();
          if (queryTerms.some((t: string) => ucLower.includes(t))) {
            score += 15;
            matches.push(`useCase:${uc}`);
          }
        }
      }

      // Parameter names match
      const props = tool.inputSchema.properties || {};
      for (const [propName] of Object.entries(props)) {
        if (propName.toLowerCase().includes(queryLower)) {
          score += 5;
          matches.push(`param:${propName}`);
        }
      }

      if (score > 0) {
        scored.push({ tool, agent, score, matches });
      }
    }

    // Sort by score descending, take top N
    scored.sort((a, b) => b.score - a.score);
    const topResults = scored.slice(0, limit);

    return this.createToolResult(true, {
      query,
      totalMatches: scored.length,
      results: topResults.map(r => ({
        name: r.tool.name,
        description: r.tool.description,
        category: r.tool.category,
        agent: r.agent,
        score: r.score,
        matchedOn: r.matches,
      })),
      suggestion: topResults.length > 0
        ? `Use "${topResults[0].tool.name}" for: ${topResults[0].tool.description}`
        : 'No matching tools found',
    }, undefined, startTime);
  }

  private async doGetWorkflows(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const workflows: WorkflowInfo[] = [];

    if (this.workflowManager) {
      const workflowList = this.workflowManager.getWorkflowList?.() || [];

      for (const wf of workflowList) {
        // Workflow has: uri, metadata: { id, title, description }, fullContent
        const meta = wf.metadata || {};
        // Category filter not currently supported (workflows don't have categories yet)
        if (!params.category) {
          workflows.push({
            id: meta.id || wf.uri?.replace('workflow://', ''),
            name: meta.title || meta.id,
            description: meta.description || '',
            category: 'workflow',
            uri: wf.uri || `workflow://${meta.id}`,
          });
        }
      }
    }

    return this.createToolResult(true, {
      workflows,
      count: workflows.length,
    }, undefined, startTime);
  }

  // Session management

  createSession(metadata?: Record<string, any>): string {
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    this.sessions.set(sessionId, {
      id: sessionId,
      createdAt: new Date(),
      lastActivity: new Date(),
      metadata,
    });

    this.publishEvent(AgentEvents.SESSION_CREATED, { sessionId });

    return sessionId;
  }

  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  terminateSession(sessionId: string): boolean {
    const existed = this.sessions.delete(sessionId);

    if (existed) {
      this.publishEvent(AgentEvents.SESSION_TERMINATED, { sessionId });
    }

    return existed;
  }

  // Public accessors

  getAllTools(): ToolDefinition[] {
    const allTools: ToolDefinition[] = [];

    // Add tools from all registered agents
    for (const { tools } of this.registeredAgents.values()) {
      allTools.push(...tools);
    }

    // Add orchestrator's own tools
    allTools.push(...this.getTools());

    return allTools;
  }

  getRegisteredAgentNames(): string[] {
    return Array.from(this.registeredAgents.keys());
  }

  getToolCount(): number {
    return this.toolRegistry.size + this.getTools().length;
  }
}
