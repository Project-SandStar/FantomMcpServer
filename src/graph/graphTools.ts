/**
 * Graph Analysis MCP Tools - Schema definitions for graph-based code intelligence
 *
 * These tools provide:
 * - Call graph navigation (callers, callees)
 * - Impact analysis (blast radius of changes)
 * - Path finding between code elements
 * - Semantic code search with graph context
 */

// ============================================
// Tool Schema Types
// ============================================

export interface McpToolSchema {
  type: 'object';
  properties: Record<string, {
    type: string;
    description?: string;
    enum?: string[];
    items?: { type: string; enum?: string[] };
    default?: unknown;
  }>;
  required?: string[];
}

export interface GraphTool {
  name: string;
  description: string;
  category: string;
  inputSchema: McpToolSchema;
}

// ============================================
// Graph Analysis Tool Definitions
// ============================================

export const GRAPH_TOOLS: GraphTool[] = [
  {
    name: 'getCallers',
    description: 'Find all functions that call a given function - "who calls this?". ' +
      'Use this to trace upstream dependencies, find usages before refactoring, ' +
      'or understand how a function is being used across the codebase. ' +
      'Returns caller names, file locations, and call depths.',
    category: 'graph-analysis',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: {
          type: 'string',
          description: 'Code node ID (UUID) of the function/method to find callers for'
        },
        qualifiedName: {
          type: 'string',
          description: 'Fully qualified function name like "myPod::MyClass.myMethod" or "sys::Str.toInt"'
        },
        maxDepth: {
          type: 'number',
          description: 'How many levels of indirect callers to include (1=direct only, 5=default)',
          default: 5
        },
        projectId: {
          type: 'number',
          description: 'Restrict results to a specific project ID'
        }
      },
      required: []
    }
  },
  {
    name: 'getCallees',
    description: 'Find all functions called by a given function - "what does this call?". ' +
      'Use this to understand dependencies, trace execution flow downstream, ' +
      'or analyze what a function relies on. Returns called function names, locations, and depths.',
    category: 'graph-analysis',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: {
          type: 'string',
          description: 'Code node ID (UUID) of the function/method to find callees for'
        },
        qualifiedName: {
          type: 'string',
          description: 'Fully qualified function name like "myPod::MyClass.myMethod"'
        },
        maxDepth: {
          type: 'number',
          description: 'How many levels of indirect callees to include (1=direct only, 5=default)',
          default: 5
        }
      },
      required: []
    }
  },
  {
    name: 'getCodeImpact',
    description: 'Analyze the blast radius / impact of changing a function. ' +
      'Shows all code that could be affected by changes - essential for refactoring risk assessment. ' +
      'Use before making changes to critical code to understand consequences. ' +
      'Returns affected nodes grouped by relationship type (calls, uses, extends).',
    category: 'graph-analysis',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: {
          type: 'string',
          description: 'Code node ID (UUID) of the function to analyze impact for'
        },
        qualifiedName: {
          type: 'string',
          description: 'Fully qualified function name to analyze'
        },
        maxDepth: {
          type: 'number',
          description: 'How far to trace impact (10=default, higher finds more indirect effects)',
          default: 10
        }
      },
      required: []
    }
  },
  {
    name: 'findCodePath',
    description: 'Find how two functions are connected - the call chain between them. ' +
      'Use to trace execution paths, debug call flows, or understand code relationships. ' +
      'Returns the shortest path showing each function and edge type along the way.',
    category: 'graph-analysis',
    inputSchema: {
      type: 'object',
      properties: {
        fromNodeId: {
          type: 'string',
          description: 'Starting function node ID (UUID)'
        },
        fromQualifiedName: {
          type: 'string',
          description: 'Starting function qualified name like "myPod::Entry.main"'
        },
        toNodeId: {
          type: 'string',
          description: 'Target function node ID (UUID)'
        },
        toQualifiedName: {
          type: 'string',
          description: 'Target function qualified name like "myPod::Database.query"'
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum path length to search (10=default)',
          default: 10
        }
      },
      required: []
    }
  },
  {
    name: 'semanticCodeSearch',
    description: 'Search code using natural language - find functions by describing what they do. ' +
      'Uses AI embeddings for semantic similarity, not just keyword matching. ' +
      'Example queries: "authentication logic", "parse JSON response", "database connection handling".',
    category: 'semantic-search',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Describe what you\'re looking for in plain English: "handles user authentication", "parses CSV files", "validates email addresses"'
        },
        projectId: {
          type: 'number',
          description: 'Restrict search to a specific project ID'
        },
        nodeType: {
          type: 'string',
          description: 'Filter results by code element type',
          enum: ['type', 'class', 'mixin', 'enum', 'facet', 'method', 'field', 'constructor', 'function']
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (10=default)',
          default: 10
        },
        includeGraphContext: {
          type: 'boolean',
          description: 'Include caller/callee counts in results for context',
          default: true
        }
      },
      required: ['query']
    }
  },
  {
    name: 'findSimilarCode',
    description: 'Find functions similar to a given one - detect duplicates, related implementations, or code patterns. ' +
      'Uses AI embeddings for semantic similarity. Great for finding refactoring candidates or learning from similar code.',
    category: 'semantic-search',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: {
          type: 'string',
          description: 'Code node ID (UUID) of the reference function'
        },
        qualifiedName: {
          type: 'string',
          description: 'Qualified name of the function to find similar code for'
        },
        projectId: {
          type: 'number',
          description: 'Restrict to a specific project ID'
        },
        limit: {
          type: 'number',
          description: 'Number of similar functions to return (5=default)',
          default: 5
        }
      },
      required: []
    }
  },
  {
    name: 'getGraphMetrics',
    description: 'Get code metrics for a function: incoming/outgoing call counts, centrality score, complexity indicators. ' +
      'Use to identify important or problematic code. High caller count = critical code. High callee count = complex code.',
    category: 'graph-analysis',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: {
          type: 'string',
          description: 'Code node ID (UUID) to get metrics for'
        },
        qualifiedName: {
          type: 'string',
          description: 'Qualified function name to get metrics for'
        }
      },
      required: []
    }
  },
  {
    name: 'getMostCalledFunctions',
    description: 'Find the most frequently called functions in a project - identify critical/central code paths. ' +
      'These are the functions most likely to cause widespread issues if broken. Useful for prioritizing tests and reviews.',
    category: 'graph-analysis',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'number',
          description: 'Project ID to analyze for most-called functions'
        },
        limit: {
          type: 'number',
          description: 'How many top functions to return (10=default)',
          default: 10
        }
      },
      required: ['projectId']
    }
  },
  {
    name: 'getMostComplexFunctions',
    description: 'Find functions with the most dependencies (outgoing calls) - identify high-complexity/high-coupling code. ' +
      'These are refactoring candidates or functions that need careful testing. Helps identify code smell.',
    category: 'graph-analysis',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'number',
          description: 'Project ID to analyze for complex functions'
        },
        limit: {
          type: 'number',
          description: 'How many top functions to return (10=default)',
          default: 10
        }
      },
      required: ['projectId']
    }
  },
  {
    name: 'buildProjectGraph',
    description: 'Build or rebuild the code graph index for a project. ' +
      'Parses source code to extract functions, calls, and relationships. Run this after code changes or for initial setup. ' +
      'Must be run before using graph analysis tools like getCallers, getCallees, getCodeImpact.',
    category: 'graph-management',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'number',
          description: 'Project ID to build/rebuild graph for'
        },
        rebuildEmbeddings: {
          type: 'boolean',
          description: 'Also regenerate AI embeddings for semantic search (slower)',
          default: false
        }
      },
      required: ['projectId']
    }
  },
  {
    name: 'buildProjectEmbeddings',
    description: 'Generate AI embeddings for semantic code search. ' +
      'Creates vector representations of all functions for natural language search and similarity detection. ' +
      'Run this to enable semanticCodeSearch and findSimilarCode tools.',
    category: 'graph-management',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'number',
          description: 'Project ID to generate embeddings for'
        }
      },
      required: ['projectId']
    }
  },
  {
    name: 'getGraphStats',
    description: 'Get code graph statistics: node count (functions/types), edge count (calls/relationships), embedding count. ' +
      'Use to check indexing status or understand project size. Shows per-project or aggregate stats.',
    category: 'graph-management',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'number',
          description: 'Specific project ID, or omit for all projects'
        }
      },
      required: []
    }
  },
  {
    name: 'detectCycles',
    description: 'Detect circular dependencies in the codebase - find cyclic call chains where A calls B calls C calls A. ' +
      'Use this to identify architectural issues, tightly coupled code, or potential infinite loops. ' +
      'Returns the cycle paths showing each function in the loop. Essential for code quality analysis.',
    category: 'graph-analysis',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'number',
          description: 'Project ID to analyze for circular dependencies'
        },
        maxCycles: {
          type: 'number',
          description: 'Maximum number of cycles to detect (10=default, higher finds more but takes longer)',
          default: 10
        }
      },
      required: ['projectId']
    }
  },
  {
    name: 'queryGraph',
    description: 'Execute a graph query using the DSL (Domain-Specific Language). ' +
      'Supports pattern matching, traversals, path finding, and aggregations. ' +
      'Examples: ' +
      '"MATCH method WHERE name LIKE handle* CALLERS depth=3" - find callers of methods starting with handle. ' +
      '"PATH FROM init TO cleanup" - find call path between two functions. ' +
      '"COUNT type WHERE filePath CONTAINS /api/" - count types in api directory. ' +
      '"MATCH function WHERE qualifiedName CONTAINS Auth CALLEES" - find what auth functions call.',
    category: 'graph-query',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'DSL query string. Syntax: MATCH [type] WHERE <conditions> [TRAVERSAL]. ' +
            'Conditions: field = "value", field LIKE "pattern*", field CONTAINS "text". ' +
            'Traversals: CALLERS, CALLEES, ANCESTORS, DESCENDANTS with optional depth=N.'
        },
        projectId: {
          type: 'number',
          description: 'Optional project ID to restrict query scope'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'findConstrainedPath',
    description: 'Find paths between nodes with constraints - filter by edge types, avoid certain nodes, or require passing through specific nodes. ' +
      'More powerful than findCodePath for complex path queries.',
    category: 'graph-query',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Starting node qualified name or ID'
        },
        to: {
          type: 'string',
          description: 'Target node qualified name or ID'
        },
        edgeTypes: {
          type: 'array',
          description: 'Edge types to follow (calls, extends, implements, uses, returns, parameters)',
          items: { type: 'string', enum: ['calls', 'extends', 'implements', 'uses', 'returns', 'parameters'] }
        },
        mustPass: {
          type: 'array',
          description: 'Node names that the path must pass through',
          items: { type: 'string' }
        },
        mustAvoid: {
          type: 'array',
          description: 'Node names that the path must avoid',
          items: { type: 'string' }
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum path length (15=default)',
          default: 15
        }
      },
      required: ['from', 'to']
    }
  },
  {
    name: 'getStronglyConnectedComponents',
    description: 'Find strongly connected components (SCCs) in the call graph - groups of mutually recursive functions. ' +
      'Useful for identifying tightly coupled code clusters, circular dependencies, and refactoring candidates.',
    category: 'graph-algorithms',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'number',
          description: 'Project ID to analyze'
        },
        minSize: {
          type: 'number',
          description: 'Minimum component size to return (2=default, excludes single-node components)',
          default: 2
        }
      },
      required: ['projectId']
    }
  },
  {
    name: 'getPageRank',
    description: 'Compute PageRank scores for functions - identifies the most "important" functions based on call patterns. ' +
      'Functions with high PageRank are called by many other important functions. Useful for finding critical code paths.',
    category: 'graph-algorithms',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'number',
          description: 'Project ID to analyze'
        },
        iterations: {
          type: 'number',
          description: 'Number of PageRank iterations (20=default)',
          default: 20
        },
        limit: {
          type: 'number',
          description: 'Number of top results to return (20=default)',
          default: 20
        }
      },
      required: ['projectId']
    }
  },
  {
    name: 'getBetweennessCentrality',
    description: 'Find functions with high betweenness centrality - nodes that lie on many shortest paths. ' +
      'These are bottlenecks or bridge functions that connect different parts of the codebase. High centrality = critical integration points.',
    category: 'graph-algorithms',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'number',
          description: 'Project ID to analyze'
        },
        limit: {
          type: 'number',
          description: 'Number of top results to return (20=default)',
          default: 20
        }
      },
      required: ['projectId']
    }
  },
  {
    name: 'exportGraphVisualization',
    description: 'Export a subgraph as DOT (GraphViz), JSON, D3.js, or Cytoscape format for visualization. ' +
      'Generate visual representations of call graphs, impact graphs, or project structure. ' +
      'DOT output can be rendered with GraphViz tools (dot, neato). JSON formats work with web visualization libraries.',
    category: 'graph-visualization',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: {
          type: 'string',
          description: 'Code node ID (UUID) as focal point for the subgraph'
        },
        qualifiedName: {
          type: 'string',
          description: 'Qualified function name as focal point (alternative to nodeId)'
        },
        projectId: {
          type: 'number',
          description: 'Project ID to export full project graph (if nodeId not specified)'
        },
        graphType: {
          type: 'string',
          description: 'Type of subgraph to export',
          enum: ['subgraph', 'callers', 'callees', 'impact', 'project'],
          default: 'subgraph'
        },
        format: {
          type: 'string',
          description: 'Export format',
          enum: ['dot', 'json', 'd3', 'cytoscape'],
          default: 'dot'
        },
        depth: {
          type: 'number',
          description: 'Traversal depth from focal node (3=default)',
          default: 3
        },
        maxNodes: {
          type: 'number',
          description: 'Maximum nodes to include (100=default, prevents huge graphs)',
          default: 100
        },
        layout: {
          type: 'string',
          description: 'Layout hint for DOT format',
          enum: ['hierarchical', 'force', 'radial', 'circular'],
          default: 'hierarchical'
        },
        title: {
          type: 'string',
          description: 'Custom title for the graph'
        }
      },
      required: []
    }
  },
  {
    name: 'listCommunities',
    description: 'Detect and list code communities (clusters of closely-related functions) using the Louvain algorithm. ' +
      'Communities reveal module boundaries, tightly-coupled components, and architectural structure. ' +
      'Results are cached per project until the next reindex.',
    category: 'graph-algorithms',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'number',
          description: 'Project ID to analyze'
        },
        resolution: {
          type: 'number',
          description: 'Louvain resolution parameter (higher = more communities). Default: 1.0'
        },
        minSize: {
          type: 'number',
          description: 'Minimum community size to include. Default: 2'
        },
        refresh: {
          type: 'boolean',
          description: 'Force re-detection even if cached results exist. Default: false'
        }
      },
      required: ['projectId']
    }
  },
  {
    name: 'getProcessFlow',
    description: 'Trace execution flows from entry points through the call graph. ' +
      'Discovers entry points (constructors, handlers, main methods) and follows call chains ' +
      'to build ordered execution paths. Useful for understanding "what happens when X is called".',
    category: 'graph-algorithms',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'number',
          description: 'Project ID to analyze'
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum call chain depth to trace. Default: 10'
        },
        minSteps: {
          type: 'number',
          description: 'Minimum steps for a process to be included. Default: 3'
        },
        refresh: {
          type: 'boolean',
          description: 'Force re-tracing even if cached results exist. Default: false'
        }
      },
      required: ['projectId']
    }
  },
  {
    name: 'findProcessesForFunction',
    description: 'Find all execution processes that include a specific function. ' +
      'Shows which workflows/execution paths pass through a given function, helping understand ' +
      'the broader context of a function\'s usage.',
    category: 'graph-algorithms',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'number',
          description: 'Project ID'
        },
        nodeId: {
          type: 'string',
          description: 'Code node ID to search for in processes'
        },
        qualifiedName: {
          type: 'string',
          description: 'Qualified function name (alternative to nodeId)'
        }
      },
      required: ['projectId']
    }
  },
  {
    name: 'detectChanges',
    description: 'Map git changes to affected code symbols and assess downstream impact. ' +
      'Shows which functions are affected by recent code changes, their blast radius, ' +
      'and a risk score. Essential for pre-commit review and CI/CD impact analysis.',
    category: 'graph-analysis',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'number',
          description: 'Project ID to analyze'
        },
        projectPath: {
          type: 'string',
          description: 'Path to the project git repository'
        },
        scope: {
          type: 'string',
          description: 'Which changes to analyze',
          enum: ['staged', 'unstaged', 'head', 'branch', 'commit'],
          default: 'head'
        },
        ref: {
          type: 'string',
          description: 'Git reference for branch/commit scope (e.g., "main", commit SHA)'
        }
      },
      required: ['projectId']
    }
  },
  {
    name: 'checkStaleness',
    description: 'Check if the project graph index is outdated relative to git history. ' +
      'Returns staleness status, time since last build, and list of changed files. ' +
      'Use this before running analysis to ensure results are based on current code.',
    category: 'graph-management',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'number',
          description: 'Project ID to check staleness for'
        },
        projectPath: {
          type: 'string',
          description: 'Path to the project git repository'
        }
      },
      required: ['projectId']
    }
  },

  // AST Viewer Tools
  {
    name: 'getProjectFunctions',
    description:
      'List all functions, methods, constructors, and fields for a project. ' +
      'Works across all languages (Fantom, TypeScript, Vue, JS, Python, etc.) by querying LadybugDB. ' +
      'Returns name, qualified name, type, parent class, file path, line number, signature, and modifiers. ' +
      'Use this to explore the full function inventory of a codebase.',
    category: 'graph-analysis',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'number',
          description: 'Project ID to list functions for'
        },
        nodeTypes: {
          type: 'string',
          description: 'Comma-separated node types to include (default: method,field,constructor,function)'
        }
      },
      required: ['projectId']
    }
  },
  {
    name: 'getProjectTypes',
    description:
      'List all type-level nodes (classes, mixins, enums, facets) for a project. ' +
      'Works across all languages by querying LadybugDB. ' +
      'Returns name, qualified name, kind, file path, extends/implements info, and method/field counts.',
    category: 'graph-analysis',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'number',
          description: 'Project ID to list types for'
        }
      },
      required: ['projectId']
    }
  }
];

/**
 * Get all graph tool definitions for MCP registration
 */
export function getGraphToolDefinitions(): GraphTool[] {
  return GRAPH_TOOLS;
}

/**
 * Check if a tool name is a graph tool
 */
export function isGraphTool(toolName: string): boolean {
  return GRAPH_TOOLS.some(t => t.name === toolName);
}

/**
 * Get a specific graph tool by name
 */
export function getGraphTool(toolName: string): GraphTool | undefined {
  return GRAPH_TOOLS.find(t => t.name === toolName);
}
