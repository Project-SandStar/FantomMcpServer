/**
 * MCP Explorer Agent Framework
 *
 * This module provides a 7-agent architecture for the Fantom MCP Explorer:
 *
 * 1. Documentation Agent - Search and retrieve documentation
 * 2. Code Analysis Agent - Parse and analyze Fantom source code
 * 3. Code Generation Agent - Generate Fantom code artifacts
 * 4. Project Management Agent - Handle project operations and migrations
 * 5. Analytics Agent - Track usage and performance metrics
 * 6. Explorer Orchestration Agent - Coordinate all agents and route requests
 * 7. Graph Analysis Agent - Code graph intelligence and semantic search
 */

// Base framework
export * from './base/index.js';

// Individual agents
export { DocumentationAgent } from './documentation/index.js';
export { CodeAnalysisAgent } from './codeAnalysis/index.js';
export { CodeGenerationAgent } from './codeGeneration/index.js';
export { ProjectManagementAgent } from './projectManagement/index.js';
export { AnalyticsAgent } from './analytics/index.js';
export { ExplorerOrchestrationAgent } from './orchestration/index.js';
export { GraphAnalysisAgent, createGraphAnalysisAgent } from './graphAnalysis/index.js';

// Re-export types for convenience
export type {
  AgentStatus,
  SystemHealth,
  ToolDefinition,
  ToolResult,
  IndexStats,
  UsageStats,
  ToolMetrics,
  PrimaryProjectContext,
  MigrationResult,
  SessionInfo,
  WorkflowInfo,
} from './base/types.js';

import { AgentEventBus, AgentEventBusInterface } from './base/index.js';
import { DocumentationAgent } from './documentation/index.js';
import { CodeAnalysisAgent } from './codeAnalysis/index.js';
import { CodeGenerationAgent } from './codeGeneration/index.js';
import { ProjectManagementAgent } from './projectManagement/index.js';
import { AnalyticsAgent } from './analytics/index.js';
import { ExplorerOrchestrationAgent } from './orchestration/index.js';
import { GraphAnalysisAgent } from './graphAnalysis/index.js';
import { SearchIndex } from '../search/index.js';
import { CacheManager } from '../cache/index.js';

/**
 * Options for creating the agent framework
 */
export interface AgentFrameworkOptions {
  searchIndex?: SearchIndex;
  cacheManager?: CacheManager;
  usageTracker?: any;
  workflowManager?: any;
  migrator?: any;
  codeIndexer?: any; // FantomCodeIndexer for workspace-level code analysis
  getPrimaryProject?: () => any;
  setPrimaryProject?: (context: any) => Promise<void>;
  onPrimaryProjectChange?: (context: any) => void;
}

/**
 * The complete agent framework with all 7 agents
 */
export interface AgentFramework {
  eventBus: AgentEventBusInterface;
  documentation: DocumentationAgent;
  codeAnalysis: CodeAnalysisAgent;
  codeGeneration: CodeGenerationAgent;
  projectManagement: ProjectManagementAgent;
  analytics: AnalyticsAgent;
  orchestration: ExplorerOrchestrationAgent;
  graphAnalysis: GraphAnalysisAgent;
  initialize: () => Promise<void>;
  shutdown: () => Promise<void>;
  getAllTools: () => any[];
}

/**
 * Create and configure the complete agent framework
 */
export function createAgentFramework(options: AgentFrameworkOptions = {}): AgentFramework {
  // Create shared event bus
  const eventBus = new AgentEventBus({ maxHistorySize: 500 });

  // Create all 6 agents
  const documentation = new DocumentationAgent({
    eventBus,
    searchIndex: options.searchIndex,
  });

  const codeAnalysis = new CodeAnalysisAgent({
    eventBus,
    codeIndexer: options.codeIndexer,
  });

  const codeGeneration = new CodeGenerationAgent({
    eventBus,
  });

  const projectManagement = new ProjectManagementAgent({
    eventBus,
    migrator: options.migrator,
    getPrimaryProjectExternal: options.getPrimaryProject,
    setPrimaryProjectExternal: options.setPrimaryProject,
    onPrimaryProjectChange: options.onPrimaryProjectChange,
  });

  const analytics = new AnalyticsAgent({
    eventBus,
    usageTracker: options.usageTracker,
  });

  const orchestration = new ExplorerOrchestrationAgent({
    eventBus,
    workflowManager: options.workflowManager,
  });

  const graphAnalysis = new GraphAnalysisAgent({
    eventBus,
  });

  // Register all agents with the orchestrator
  orchestration.registerAgent(documentation);
  orchestration.registerAgent(codeAnalysis);
  orchestration.registerAgent(codeGeneration);
  orchestration.registerAgent(projectManagement);
  orchestration.registerAgent(analytics);
  orchestration.registerAgent(graphAnalysis);

  return {
    eventBus,
    documentation,
    codeAnalysis,
    codeGeneration,
    projectManagement,
    analytics,
    orchestration,
    graphAnalysis,

    /**
     * Initialize all agents.
     *
     * Per-agent failures are isolated: a single agent's bad init (e.g.
     * GraphAnalysisAgent when the embedding sidecar is offline) must NOT
     * collapse the whole framework. Rejections are logged; healthy agents
     * still come up.
     */
    async initialize(): Promise<void> {
      const entries: Array<[string, Promise<void>]> = [
        ['documentation', documentation.initialize()],
        ['codeAnalysis', codeAnalysis.initialize()],
        ['codeGeneration', codeGeneration.initialize()],
        ['projectManagement', projectManagement.initialize()],
        ['analytics', analytics.initialize()],
        ['orchestration', orchestration.initialize()],
        ['graphAnalysis', graphAnalysis.initialize()],
      ];
      const results = await Promise.allSettled(entries.map(([, p]) => p));
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === 'rejected') {
          const [name] = entries[i];
          // eslint-disable-next-line no-console
          console.error(`[agentFramework] ${name} init failed (continuing without it):`, r.reason);
        }
      }
    },

    /**
     * Shutdown all agents. Same isolation rule — one stuck shutdown must
     * not block the others (and must not throw past the awaiter).
     */
    async shutdown(): Promise<void> {
      const entries: Array<[string, Promise<void>]> = [
        ['documentation', documentation.shutdown()],
        ['codeAnalysis', codeAnalysis.shutdown()],
        ['codeGeneration', codeGeneration.shutdown()],
        ['projectManagement', projectManagement.shutdown()],
        ['analytics', analytics.shutdown()],
        ['orchestration', orchestration.shutdown()],
        ['graphAnalysis', graphAnalysis.shutdown()],
      ];
      const results = await Promise.allSettled(entries.map(([, p]) => p));
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === 'rejected') {
          const [name] = entries[i];
          // eslint-disable-next-line no-console
          console.error(`[agentFramework] ${name} shutdown error:`, r.reason);
        }
      }
    },

    /**
     * Get all tools from all agents
     */
    getAllTools(): any[] {
      return orchestration.getAllTools();
    },
  };
}

/**
 * Get agent info summary
 */
export function getAgentInfo(): Array<{ name: string; description: string; toolCount: number }> {
  return [
    {
      name: 'documentation',
      description: 'Search and retrieve documentation from cached docs and local sources',
      toolCount: 8,
    },
    {
      name: 'code-analysis',
      description: 'Static analysis for Fantom source code including parsing and AST',
      toolCount: 8,
    },
    {
      name: 'code-generation',
      description: 'Generate Fantom code artifacts including classes, methods, and pods',
      toolCount: 8,
    },
    {
      name: 'project-management',
      description: 'Handle SkySpark project operations and migration workflows',
      toolCount: 8,
    },
    {
      name: 'analytics',
      description: 'Track and report on tool usage and system performance',
      toolCount: 8,
    },
    {
      name: 'explorer',
      description: 'Central coordinator for request routing and tool discovery',
      toolCount: 8,
    },
    {
      name: 'graph-analysis',
      description: 'Code graph intelligence: call graphs, impact analysis, semantic search',
      toolCount: 12,
    },
  ];
}
