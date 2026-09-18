/**
 * Graph Analysis Agent - Provides code graph intelligence tools
 *
 * This agent enables:
 * - Call graph navigation (callers, callees)
 * - Impact analysis (blast radius of changes)
 * - Semantic code search with graph context
 * - Code similarity detection
 */

import { BaseAgent } from '../base/BaseAgent.js';
import type { ToolDefinition, ToolResult, AgentInitOptions } from '../base/types.js';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma.js';
import {
  GraphToolHandler,
  getGraphToolHandler,
  GRAPH_TOOLS
} from '../../graph/index.js';
import { getCodeIndexingService, CodeIndexingService } from '../../fantom-code/codeIndexingService.js';

export class GraphAnalysisAgent extends BaseAgent {
  readonly name = 'GraphAnalysis';
  readonly description = 'Code graph analysis for call graphs, impact analysis, and semantic search';
  readonly category = 'code-intelligence';

  private prisma: PrismaClient | null = null;
  private toolHandler: GraphToolHandler | null = null;
  private indexingService: CodeIndexingService | null = null;

  constructor(options: AgentInitOptions) {
    super(options);
  }

  protected async doInitialize(): Promise<void> {
    this.logger.info('Initializing Graph Analysis Agent...');

    // Get Prisma client
    this.prisma = getPrismaClient();

    // Initialize indexing service
    this.indexingService = getCodeIndexingService(this.prisma);

    // Initialize tool handler
    this.toolHandler = getGraphToolHandler({
      prisma: this.prisma,
      indexingService: this.indexingService
    });

    this.logger.info('Graph Analysis Agent initialized');
  }

  protected async doShutdown(): Promise<void> {
    this.logger.info('Shutting down Graph Analysis Agent...');
    // No specific cleanup needed
  }

  getTools(): ToolDefinition[] {
    return GRAPH_TOOLS.map(tool => this.createToolDefinition(
      tool.name,
      tool.description,
      tool.inputSchema,
      this.getToolKeywords(tool.name),
      this.getToolUseCases(tool.name),
      this.getRelatedTools(tool.name)
    ));
  }

  async executeTool(toolName: string, params: Record<string, unknown>): Promise<ToolResult> {
    const startTime = Date.now();
    this.updateActivity();
    this.setBusy();

    try {
      if (!this.toolHandler) {
        return this.createToolResult(false, null, 'Agent not initialized', startTime);
      }

      if (!this.toolHandler.canHandle(toolName)) {
        return this.createToolResult(false, null, `Unknown tool: ${toolName}`, startTime);
      }

      const result = await this.toolHandler.handle(toolName, params);

      if (result.isError) {
        return this.createToolResult(
          false,
          null,
          result.content[0]?.text || 'Unknown error',
          startTime
        );
      }

      return this.createToolResult(
        true,
        { content: result.content },
        undefined,
        startTime
      );
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Tool execution failed (${toolName}):`, error);
      return this.createToolResult(false, null, errMsg, startTime);
    } finally {
      this.setReady();
    }
  }

  // ============================================
  // Tool Metadata
  // ============================================

  private getToolKeywords(toolName: string): string[] {
    const keywords: Record<string, string[]> = {
      getCallers: ['callers', 'who calls', 'dependencies', 'call graph', 'upstream'],
      getCallees: ['callees', 'calls', 'dependencies', 'call graph', 'downstream'],
      getCodeImpact: ['impact', 'blast radius', 'affected', 'change analysis'],
      findCodePath: ['path', 'connection', 'trace', 'call chain'],
      semanticCodeSearch: ['search', 'find', 'semantic', 'natural language', 'AI'],
      findSimilarCode: ['similar', 'duplicate', 'related', 'like'],
      getGraphMetrics: ['metrics', 'statistics', 'importance', 'complexity'],
      getMostCalledFunctions: ['popular', 'critical', 'central', 'important'],
      getMostComplexFunctions: ['complex', 'coupling', 'dependencies'],
      buildProjectGraph: ['build', 'index', 'graph', 'analyze'],
      buildProjectEmbeddings: ['embeddings', 'vectors', 'semantic', 'AI'],
      getGraphStats: ['stats', 'statistics', 'summary', 'overview']
    };
    return keywords[toolName] || [];
  }

  private getToolUseCases(toolName: string): string[] {
    const useCases: Record<string, string[]> = {
      getCallers: [
        'Find all code that depends on a function before refactoring',
        'Identify callers to understand how a function is used'
      ],
      getCallees: [
        'Understand what dependencies a function has',
        'Trace execution flow from a function'
      ],
      getCodeImpact: [
        'Assess risk before making changes to critical code',
        'Find all affected code when fixing a bug'
      ],
      findCodePath: [
        'Understand how two functions are related',
        'Trace the call path from entry point to a bug location'
      ],
      semanticCodeSearch: [
        'Find functions by describing what they do',
        'Discover relevant code using natural language'
      ],
      findSimilarCode: [
        'Find duplicate or similar implementations',
        'Discover related functions for refactoring'
      ],
      getGraphMetrics: [
        'Identify high-impact functions',
        'Find functions with high coupling'
      ],
      getMostCalledFunctions: [
        'Identify critical code paths',
        'Find code that needs thorough testing'
      ],
      getMostComplexFunctions: [
        'Find candidates for refactoring',
        'Identify code with too many dependencies'
      ],
      buildProjectGraph: [
        'Index a project for graph analysis',
        'Rebuild graph after code changes'
      ],
      buildProjectEmbeddings: [
        'Enable semantic search for a project',
        'Rebuild embeddings after major changes'
      ],
      getGraphStats: [
        'Get overview of indexed projects',
        'Check indexing status'
      ]
    };
    return useCases[toolName] || [];
  }

  private getRelatedTools(toolName: string): string[] {
    const related: Record<string, string[]> = {
      getCallers: ['getCallees', 'getCodeImpact', 'getGraphMetrics'],
      getCallees: ['getCallers', 'findCodePath', 'getGraphMetrics'],
      getCodeImpact: ['getCallers', 'getGraphMetrics'],
      findCodePath: ['getCallers', 'getCallees'],
      semanticCodeSearch: ['findSimilarCode', 'searchFantomCode'],
      findSimilarCode: ['semanticCodeSearch'],
      getGraphMetrics: ['getMostCalledFunctions', 'getMostComplexFunctions'],
      getMostCalledFunctions: ['getMostComplexFunctions', 'getGraphMetrics'],
      getMostComplexFunctions: ['getMostCalledFunctions', 'getGraphMetrics'],
      buildProjectGraph: ['buildProjectEmbeddings', 'getGraphStats'],
      buildProjectEmbeddings: ['buildProjectGraph', 'semanticCodeSearch'],
      getGraphStats: ['buildProjectGraph', 'buildProjectEmbeddings']
    };
    return related[toolName] || [];
  }
}

/**
 * Factory function to create a GraphAnalysisAgent
 */
export function createGraphAnalysisAgent(options: AgentInitOptions): GraphAnalysisAgent {
  return new GraphAnalysisAgent(options);
}
