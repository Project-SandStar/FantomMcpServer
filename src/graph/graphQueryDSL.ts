/**
 * Graph Query DSL - Domain-Specific Language for code graph queries
 *
 * Provides a structured way to express complex graph queries:
 * - Pattern matching on nodes (name, type, file path)
 * - Relationship traversal (callers, callees, ancestors, descendants)
 * - Filtering by depth, edge type, and properties
 * - Aggregations and grouping
 *
 * Example queries:
 *   MATCH function WHERE name LIKE "handle*" CALLERS depth=3
 *   MATCH type WHERE qualifiedName = "myPod::MyClass" CALLEES edgeType=calls
 *   FIND PATH FROM "init" TO "cleanup" maxDepth=10
 */

import type { PrismaClient } from '@prisma/client';
import type { EdgeType, NodeType } from './types.js';
import { createLogger } from '../utils/index.js';
import { ladybugQuery } from './ladybugConnection.js';

const logger = createLogger('graph-dsl');

// ============================================
// DSL Types
// ============================================

export type QueryOperator =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'regex'
  | 'in'
  | 'notIn';

export type TraversalDirection = 'callers' | 'callees' | 'ancestors' | 'descendants' | 'related';

export interface PropertyFilter {
  field: string;
  operator: QueryOperator;
  value: string | string[] | RegExp;
}

export interface TraversalOptions {
  direction: TraversalDirection;
  maxDepth: number;
  edgeTypes?: EdgeType[];
  includeStart?: boolean;
}

export interface GraphQuery {
  /** Type of query */
  type: 'match' | 'path' | 'aggregate';
  /** Node type filter (type, method, field, etc.) */
  nodeType?: NodeType;
  /** Property filters */
  filters: PropertyFilter[];
  /** Traversal options */
  traversal?: TraversalOptions;
  /** Path finding options */
  pathOptions?: {
    from: string;
    to: string;
    maxDepth: number;
    edgeTypes?: EdgeType[];
  };
  /** Aggregation options */
  aggregation?: {
    groupBy?: string;
    count?: boolean;
    sum?: string;
    avg?: string;
  };
  /** Project filter */
  projectId?: number;
  /** Result limit */
  limit: number;
  /** Result offset */
  offset: number;
}

export interface QueryResult {
  success: boolean;
  query: GraphQuery;
  results: Array<{
    id: string;
    name: string;
    qualifiedName: string;
    nodeType: string;
    filePath: string;
    lineStart: number;
    depth?: number;
    edgeType?: string;
    matchedFilter?: string;
  }>;
  totalCount: number;
  executionTimeMs: number;
  error?: string;
}

// ============================================
// Query Builder Class
// ============================================

export class GraphQueryBuilder {
  private query: GraphQuery;

  constructor() {
    this.query = {
      type: 'match',
      filters: [],
      limit: 50,
      offset: 0
    };
  }

  /** Set the query type */
  type(queryType: 'match' | 'path' | 'aggregate'): this {
    this.query.type = queryType;
    return this;
  }

  /** Filter by node type */
  nodeType(nodeType: NodeType): this {
    this.query.nodeType = nodeType;
    return this;
  }

  /** Add a property filter */
  where(field: string, operator: QueryOperator, value: string | string[]): this {
    this.query.filters.push({ field, operator, value });
    return this;
  }

  /** Shorthand for equals filter */
  whereEquals(field: string, value: string): this {
    return this.where(field, 'equals', value);
  }

  /** Shorthand for contains filter */
  whereContains(field: string, value: string): this {
    return this.where(field, 'contains', value);
  }

  /** Shorthand for starts with filter */
  whereStartsWith(field: string, value: string): this {
    return this.where(field, 'startsWith', value);
  }

  /** Add traversal */
  traverse(direction: TraversalDirection, maxDepth: number = 5, edgeTypes?: EdgeType[]): this {
    this.query.traversal = {
      direction,
      maxDepth,
      edgeTypes,
      includeStart: false
    };
    return this;
  }

  /** Get callers */
  callers(maxDepth: number = 5): this {
    return this.traverse('callers', maxDepth, ['calls']);
  }

  /** Get callees */
  callees(maxDepth: number = 5): this {
    return this.traverse('callees', maxDepth, ['calls']);
  }

  /** Get ancestors (via extends/implements) */
  ancestors(maxDepth: number = 10): this {
    return this.traverse('ancestors', maxDepth, ['extends', 'implements']);
  }

  /** Get descendants (via extends/implements) */
  descendants(maxDepth: number = 10): this {
    return this.traverse('descendants', maxDepth, ['extends', 'implements']);
  }

  /** Find path between two nodes */
  pathBetween(from: string, to: string, maxDepth: number = 10): this {
    this.query.type = 'path';
    this.query.pathOptions = { from, to, maxDepth };
    return this;
  }

  /** Group by field */
  groupBy(field: string): this {
    this.query.type = 'aggregate';
    this.query.aggregation = { ...this.query.aggregation, groupBy: field };
    return this;
  }

  /** Count results */
  count(): this {
    this.query.type = 'aggregate';
    this.query.aggregation = { ...this.query.aggregation, count: true };
    return this;
  }

  /** Filter by project */
  inProject(projectId: number): this {
    this.query.projectId = projectId;
    return this;
  }

  /** Set result limit */
  limit(limit: number): this {
    this.query.limit = limit;
    return this;
  }

  /** Set result offset */
  offset(offset: number): this {
    this.query.offset = offset;
    return this;
  }

  /** Build the query */
  build(): GraphQuery {
    return { ...this.query };
  }
}

// ============================================
// Query Executor
// ============================================

export class GraphQueryExecutor {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_prisma?: PrismaClient) {
    // PrismaClient accepted for backward compatibility but all queries use LadybugDB
  }

  async execute(query: GraphQuery): Promise<QueryResult> {
    const startTime = Date.now();

    try {
      switch (query.type) {
        case 'match':
          return await this.executeMatch(query, startTime);
        case 'path':
          return await this.executePath(query, startTime);
        case 'aggregate':
          return await this.executeAggregate(query, startTime);
        default:
          throw new Error(`Unknown query type: ${query.type}`);
      }
    } catch (error) {
      logger.error(`Query execution failed: ${error}`);
      return {
        success: false,
        query,
        results: [],
        totalCount: 0,
        executionTimeMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async executeMatch(query: GraphQuery, startTime: number): Promise<QueryResult> {
    // Build Cypher WHERE clause from filters
    const whereClauses = this.buildCypherWhere(query, 'n');
    const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Get matching nodes
    const nodes = await ladybugQuery<{
      id: string;
      name: string;
      qualified_name: string;
      node_type: string;
      file_path: string;
      line_start: number;
    }>(`MATCH (n:CodeNode) ${whereStr} RETURN n.id AS id, n.name AS name, n.qualified_name AS qualified_name, n.node_type AS node_type, n.file_path AS file_path, n.line_start AS line_start ORDER BY n.name ASC SKIP ${query.offset} LIMIT ${query.limit}`);

    // If traversal is specified, expand results
    let results = nodes.map(n => ({
      id: n.id,
      name: n.name,
      qualifiedName: n.qualified_name,
      nodeType: n.node_type,
      filePath: n.file_path,
      lineStart: n.line_start
    }));

    if (query.traversal && nodes.length > 0) {
      results = await this.executeTraversal(nodes[0].id, query.traversal);
    }

    // Get total count
    const countResult = await ladybugQuery<{ total: number }>(
      `MATCH (n:CodeNode) ${whereStr} RETURN count(n) AS total`
    );
    const totalCount = countResult.length > 0 ? countResult[0].total : 0;

    return {
      success: true,
      query,
      results,
      totalCount,
      executionTimeMs: Date.now() - startTime
    };
  }

  private async executePath(query: GraphQuery, startTime: number): Promise<QueryResult> {
    if (!query.pathOptions) {
      throw new Error('Path options required for path query');
    }

    const { from, to, maxDepth } = query.pathOptions;
    const escapedFrom = from.replace(/'/g, "\\'");
    const escapedTo = to.replace(/'/g, "\\'");

    // Find source and target nodes
    const [sourceNodes, targetNodes] = await Promise.all([
      ladybugQuery<{
        id: string; name: string; qualified_name: string; node_type: string;
        file_path: string; line_start: number;
      }>(`MATCH (n:CodeNode) WHERE n.qualified_name = '${escapedFrom}' OR n.name = '${escapedFrom}' RETURN n.id AS id, n.name AS name, n.qualified_name AS qualified_name, n.node_type AS node_type, n.file_path AS file_path, n.line_start AS line_start LIMIT 1`),
      ladybugQuery<{
        id: string; name: string; qualified_name: string; node_type: string;
        file_path: string; line_start: number;
      }>(`MATCH (n:CodeNode) WHERE n.qualified_name = '${escapedTo}' OR n.name = '${escapedTo}' RETURN n.id AS id, n.name AS name, n.qualified_name AS qualified_name, n.node_type AS node_type, n.file_path AS file_path, n.line_start AS line_start LIMIT 1`)
    ]);

    const sourceNode = sourceNodes[0] || null;
    const targetNode = targetNodes[0] || null;

    if (!sourceNode || !targetNode) {
      return {
        success: false,
        query,
        results: [],
        totalCount: 0,
        executionTimeMs: Date.now() - startTime,
        error: `Node not found: ${!sourceNode ? from : to}`
      };
    }

    // Find shortest path using Cypher variable-length relationship
    const pathResult = await ladybugQuery<{
      id: string;
      name: string;
      qualified_name: string;
      node_type: string;
      file_path: string;
      line_start: number;
    }>(`MATCH p = shortestPath((src:CodeNode {id: '${sourceNode.id}'})-[:CodeEdge*1..${maxDepth}]->(dst:CodeNode {id: '${targetNode.id}'})) UNWIND nodes(p) AS node RETURN node.id AS id, node.name AS name, node.qualified_name AS qualified_name, node.node_type AS node_type, node.file_path AS file_path, node.line_start AS line_start`);

    if (pathResult.length === 0) {
      return {
        success: true,
        query,
        results: [],
        totalCount: 0,
        executionTimeMs: Date.now() - startTime
      };
    }

    const results = pathResult.map((node, idx) => ({
      id: node.id,
      name: node.name,
      qualifiedName: node.qualified_name,
      nodeType: node.node_type,
      filePath: node.file_path,
      lineStart: node.line_start,
      depth: idx
    }));

    return {
      success: true,
      query,
      results,
      totalCount: results.length,
      executionTimeMs: Date.now() - startTime
    };
  }

  private async executeAggregate(query: GraphQuery, startTime: number): Promise<QueryResult> {
    const whereClauses = this.buildCypherWhere(query, 'n');
    const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    if (query.aggregation?.count) {
      const countResult = await ladybugQuery<{ total: number }>(
        `MATCH (n:CodeNode) ${whereStr} RETURN count(n) AS total`
      );
      const count = countResult.length > 0 ? countResult[0].total : 0;

      return {
        success: true,
        query,
        results: [{
          id: 'count',
          name: `Total: ${count}`,
          qualifiedName: '',
          nodeType: 'aggregate',
          filePath: '',
          lineStart: 0
        }],
        totalCount: count,
        executionTimeMs: Date.now() - startTime
      };
    }

    if (query.aggregation?.groupBy) {
      const field = this.toCypherField(query.aggregation.groupBy);
      const results = await ladybugQuery<{
        group_value: string;
        count: number;
      }>(`MATCH (n:CodeNode) ${whereStr} RETURN n.${field} AS group_value, count(n) AS count ORDER BY count DESC LIMIT ${query.limit}`);

      return {
        success: true,
        query,
        results: results.map((r, idx) => ({
          id: `group-${idx}`,
          name: `${r.group_value}: ${r.count}`,
          qualifiedName: r.group_value,
          nodeType: 'aggregate',
          filePath: '',
          lineStart: 0,
          depth: Number(r.count)
        })),
        totalCount: results.length,
        executionTimeMs: Date.now() - startTime
      };
    }

    return {
      success: false,
      query,
      results: [],
      totalCount: 0,
      executionTimeMs: Date.now() - startTime,
      error: 'No aggregation specified'
    };
  }

  private async executeTraversal(
    nodeId: string,
    options: TraversalOptions
  ): Promise<QueryResult['results']> {
    const { direction, maxDepth, edgeTypes } = options;
    const edgeTypeFilter = edgeTypes?.map(t => `'${t}'`).join(', ') || "'calls'";

    let cypher: string;
    if (direction === 'callers' || direction === 'ancestors') {
      // Traverse incoming edges: find nodes that have edges pointing TO nodeId
      cypher = `MATCH (caller:CodeNode)-[e:CodeEdge]->(target:CodeNode {id: '${nodeId}'}) WHERE e.edge_type IN [${edgeTypeFilter}] RETURN caller.id AS id, caller.name AS name, caller.qualified_name AS qualified_name, caller.node_type AS node_type, caller.file_path AS file_path, caller.line_start AS line_start, 1 AS depth, e.edge_type AS edge_type ORDER BY name ASC`;
      // For multi-depth, use variable-length paths
      if (maxDepth > 1) {
        cypher = `MATCH path = (caller:CodeNode)-[e:CodeEdge*1..${maxDepth}]->(target:CodeNode {id: '${nodeId}'}) WHERE ALL(rel IN e WHERE rel.edge_type IN [${edgeTypeFilter}]) WITH caller, length(path) AS depth, e[0].edge_type AS edge_type RETURN DISTINCT caller.id AS id, caller.name AS name, caller.qualified_name AS qualified_name, caller.node_type AS node_type, caller.file_path AS file_path, caller.line_start AS line_start, min(depth) AS depth, edge_type ORDER BY depth ASC, name ASC`;
      }
    } else {
      // Traverse outgoing edges: find nodes that nodeId has edges pointing TO
      cypher = `MATCH (source:CodeNode {id: '${nodeId}'})-[e:CodeEdge]->(callee:CodeNode) WHERE e.edge_type IN [${edgeTypeFilter}] RETURN callee.id AS id, callee.name AS name, callee.qualified_name AS qualified_name, callee.node_type AS node_type, callee.file_path AS file_path, callee.line_start AS line_start, 1 AS depth, e.edge_type AS edge_type ORDER BY name ASC`;
      // For multi-depth, use variable-length paths
      if (maxDepth > 1) {
        cypher = `MATCH path = (source:CodeNode {id: '${nodeId}'})-[e:CodeEdge*1..${maxDepth}]->(callee:CodeNode) WHERE ALL(rel IN e WHERE rel.edge_type IN [${edgeTypeFilter}]) WITH callee, length(path) AS depth, e[0].edge_type AS edge_type RETURN DISTINCT callee.id AS id, callee.name AS name, callee.qualified_name AS qualified_name, callee.node_type AS node_type, callee.file_path AS file_path, callee.line_start AS line_start, min(depth) AS depth, edge_type ORDER BY depth ASC, name ASC`;
      }
    }

    const results = await ladybugQuery<{
      id: string;
      name: string;
      qualified_name: string;
      node_type: string;
      file_path: string;
      line_start: number;
      depth: number;
      edge_type: string;
    }>(cypher);

    return results.map(r => ({
      id: r.id,
      name: r.name,
      qualifiedName: r.qualified_name,
      nodeType: r.node_type,
      filePath: r.file_path,
      lineStart: r.line_start,
      depth: r.depth,
      edgeType: r.edge_type
    }));
  }

  /** Map camelCase field names to snake_case Cypher property names */
  private toCypherField(field: string): string {
    const fieldMap: Record<string, string> = {
      projectId: 'project_id',
      nodeType: 'node_type',
      qualifiedName: 'qualified_name',
      filePath: 'file_path',
      lineStart: 'line_start',
      lineEnd: 'line_end',
      returnType: 'return_type',
      parentType: 'parent_type',
      isPublic: 'is_public',
      isStatic: 'is_static',
      isAbstract: 'is_abstract',
      isVirtual: 'is_virtual',
      isOverride: 'is_override',
      isExported: 'is_exported',
    };
    return fieldMap[field] || field;
  }

  /** Escape a string value for use in Cypher single-quoted strings */
  private escapeCypherString(value: string): string {
    return value.replace(/'/g, "\\'");
  }

  /** Build Cypher WHERE clause fragments from query filters */
  private buildCypherWhere(query: GraphQuery, alias: string): string[] {
    const clauses: string[] = [];

    if (query.projectId) {
      clauses.push(`${alias}.project_id = ${query.projectId}`);
    }

    if (query.nodeType) {
      clauses.push(`${alias}.node_type = '${this.escapeCypherString(query.nodeType)}'`);
    }

    for (const filter of query.filters) {
      const { field, operator, value } = filter;
      const cypherField = `${alias}.${this.toCypherField(field)}`;

      switch (operator) {
        case 'equals':
          clauses.push(`${cypherField} = '${this.escapeCypherString(value as string)}'`);
          break;
        case 'notEquals':
          clauses.push(`${cypherField} <> '${this.escapeCypherString(value as string)}'`);
          break;
        case 'contains':
          clauses.push(`${cypherField} CONTAINS '${this.escapeCypherString(value as string)}'`);
          break;
        case 'startsWith':
          clauses.push(`${cypherField} STARTS WITH '${this.escapeCypherString(value as string)}'`);
          break;
        case 'endsWith':
          clauses.push(`${cypherField} ENDS WITH '${this.escapeCypherString(value as string)}'`);
          break;
        case 'in': {
          const inValues = (value as string[]).map(v => `'${this.escapeCypherString(v)}'`).join(', ');
          clauses.push(`${cypherField} IN [${inValues}]`);
          break;
        }
        case 'notIn': {
          const notInValues = (value as string[]).map(v => `'${this.escapeCypherString(v)}'`).join(', ');
          clauses.push(`NOT ${cypherField} IN [${notInValues}]`);
          break;
        }
      }
    }

    return clauses;
  }
}

// ============================================
// DSL Parser (Text to Query)
// ============================================

export class GraphDSLParser {
  /**
   * Parse a text query into a GraphQuery object
   *
   * Syntax:
   *   MATCH [nodeType] WHERE <conditions> [TRAVERSAL] [OPTIONS]
   *   PATH FROM "start" TO "end" [maxDepth=N]
   *   COUNT [nodeType] WHERE <conditions>
   *
   * Conditions:
   *   field = "value"
   *   field LIKE "pattern*"
   *   field IN ["a", "b", "c"]
   *
   * Traversals:
   *   CALLERS [depth=N]
   *   CALLEES [depth=N]
   *   ANCESTORS [depth=N]
   *   DESCENDANTS [depth=N]
   */
  parse(queryText: string): GraphQuery {
    const builder = new GraphQueryBuilder();
    const tokens = this.tokenize(queryText);
    let i = 0;

    const consume = () => tokens[i++];
    const peek = () => tokens[i];
    const expect = (expected: string) => {
      const token = consume();
      if (token?.toUpperCase() !== expected.toUpperCase()) {
        throw new Error(`Expected ${expected}, got ${token}`);
      }
      return token;
    };

    // Parse command type
    const command = consume()?.toUpperCase();

    switch (command) {
      case 'MATCH':
        builder.type('match');
        break;
      case 'PATH':
        builder.type('path');
        expect('FROM');
        const from = this.parseQuotedString(consume() || '');
        expect('TO');
        const to = this.parseQuotedString(consume() || '');
        let maxDepth = 10;
        if (peek()?.toLowerCase().startsWith('maxdepth')) {
          const [, depth] = consume()!.split('=');
          maxDepth = parseInt(depth, 10);
        }
        builder.pathBetween(from, to, maxDepth);
        break;
      case 'COUNT':
        builder.type('aggregate').count();
        break;
      default:
        throw new Error(`Unknown command: ${command}`);
    }

    // Parse optional node type
    if (peek() && !['WHERE', 'CALLERS', 'CALLEES', 'LIMIT'].includes(peek()!.toUpperCase())) {
      const nodeType = consume()!.toLowerCase() as NodeType;
      builder.nodeType(nodeType);
    }

    // Parse WHERE conditions
    if (peek()?.toUpperCase() === 'WHERE') {
      consume(); // consume WHERE

      while (i < tokens.length && !['CALLERS', 'CALLEES', 'ANCESTORS', 'DESCENDANTS', 'LIMIT', 'PROJECT'].includes(peek()?.toUpperCase() || '')) {
        const field = consume();
        const op = consume()?.toUpperCase();
        const value = this.parseQuotedString(consume() || '');

        if (!field || !op) break;

        switch (op) {
          case '=':
          case '==':
            builder.whereEquals(field, value);
            break;
          case 'LIKE':
            if (value.endsWith('*')) {
              builder.whereStartsWith(field, value.slice(0, -1));
            } else if (value.startsWith('*')) {
              builder.where(field, 'endsWith', value.slice(1));
            } else {
              builder.whereContains(field, value);
            }
            break;
          case 'CONTAINS':
            builder.whereContains(field, value);
            break;
          case 'IN':
            builder.where(field, 'in', value.split(',').map(v => v.trim()));
            break;
        }

        // Skip AND/OR connectors
        if (peek()?.toUpperCase() === 'AND' || peek()?.toUpperCase() === 'OR') {
          consume();
        }
      }
    }

    // Parse traversal
    const traversalKeywords = ['CALLERS', 'CALLEES', 'ANCESTORS', 'DESCENDANTS'];
    if (traversalKeywords.includes(peek()?.toUpperCase() || '')) {
      const direction = consume()!.toLowerCase() as TraversalDirection;
      let depth = 5;

      if (peek()?.toLowerCase().startsWith('depth')) {
        const [, d] = consume()!.split('=');
        depth = parseInt(d, 10);
      }

      builder.traverse(direction, depth);
    }

    // Parse PROJECT filter
    if (peek()?.toUpperCase() === 'PROJECT') {
      consume();
      const projectId = parseInt(consume() || '0', 10);
      builder.inProject(projectId);
    }

    // Parse LIMIT
    if (peek()?.toUpperCase() === 'LIMIT') {
      consume();
      const limit = parseInt(consume() || '50', 10);
      builder.limit(limit);
    }

    return builder.build();
  }

  private tokenize(text: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inQuotes = false;

    for (const char of text) {
      if (char === '"' || char === "'") {
        inQuotes = !inQuotes;
        current += char;
      } else if (!inQuotes && /\s/.test(char)) {
        if (current) {
          tokens.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }

    if (current) {
      tokens.push(current);
    }

    return tokens;
  }

  private parseQuotedString(token: string): string {
    if ((token.startsWith('"') && token.endsWith('"')) ||
        (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1);
    }
    return token;
  }
}

// ============================================
// Factory Functions
// ============================================

export function createQueryBuilder(): GraphQueryBuilder {
  return new GraphQueryBuilder();
}

export function createQueryExecutor(prisma?: PrismaClient): GraphQueryExecutor {
  return new GraphQueryExecutor(prisma);
}

export function createDSLParser(): GraphDSLParser {
  return new GraphDSLParser();
}
