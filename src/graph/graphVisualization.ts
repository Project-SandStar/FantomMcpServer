/**
 * Graph Visualization Export - Generate DOT/GraphViz and JSON for visualization
 *
 * Provides export formats for:
 * - DOT (GraphViz) - for command-line rendering with dot/neato
 * - JSON - for web-based graph visualization (D3.js, vis.js, etc.)
 * - SVG (via DOT) - for direct rendering
 */

import type { PrismaClient } from '@prisma/client';
import { ladybugQuery } from './ladybugConnection.js';

// ============================================
// Helpers
// ============================================

/** Escape single quotes for Cypher string literals */
function esc(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// ============================================
// Types
// ============================================

export interface VisualizationNode {
  id: string;
  name: string;
  qualifiedName: string;
  nodeType: string;
  filePath: string;
  lineStart: number;
  // Visual attributes
  group?: string;
  weight?: number;
  color?: string;
}

export interface VisualizationEdge {
  source: string;
  target: string;
  edgeType: string;
  lineNumber?: number;
  weight?: number;
}

export interface SubgraphData {
  nodes: VisualizationNode[];
  edges: VisualizationEdge[];
  metadata: {
    title?: string;
    description?: string;
    generatedAt: string;
    nodeCount: number;
    edgeCount: number;
    focalNodeId?: string;
  };
}

export interface ExportOptions {
  format: 'dot' | 'json' | 'd3' | 'cytoscape';
  includeMetadata?: boolean;
  colorScheme?: 'type' | 'file' | 'depth' | 'custom';
  layout?: 'hierarchical' | 'force' | 'radial' | 'circular';
  maxNodes?: number;
  title?: string;
}

// ============================================
// Color Schemes
// ============================================

const NODE_TYPE_COLORS: Record<string, string> = {
  type: '#4B8BBE',      // Blue for classes/types
  method: '#306998',    // Dark blue for methods
  constructor: '#FFE873', // Yellow for constructors
  field: '#9B59B6',     // Purple for fields
  function: '#2ECC71',  // Green for functions
  default: '#95A5A6'    // Gray for unknown
};

const EDGE_TYPE_COLORS: Record<string, string> = {
  calls: '#2C3E50',
  extends: '#E74C3C',
  implements: '#3498DB',
  contains: '#95A5A6',
  uses: '#F39C12',
  returns: '#1ABC9C',
  parameters: '#9B59B6',
  overrides: '#E67E22'
};

// ============================================
// Graph Visualization Service
// ============================================

export class GraphVisualizationService {
  /** When set, every internal Cypher query routes to that project's DB. */
  private projectId: number | undefined;

  constructor(_prisma?: PrismaClient, projectId?: number) {
    // PrismaClient kept in constructor signature for backward compat but queries now use LadybugDB
    this.projectId = projectId;
  }

  /** Internal: route a read query to per-project DB if bound, else legacy. */
  private async q<T = Record<string, unknown>>(cypher: string): Promise<T[]> {
    return this.projectId !== undefined
      ? ladybugQuery<T>(this.projectId, cypher)
      : ladybugQuery<T>(cypher);
  }

  /**
   * Export a subgraph around a focal node
   */
  async exportSubgraph(
    nodeId: string,
    depth: number = 2,
    options: ExportOptions = { format: 'dot' }
  ): Promise<string> {
    const subgraph = await this.getSubgraph(nodeId, depth, options.maxNodes);
    return this.formatExport(subgraph, options);
  }

  /**
   * Export caller graph for a function
   */
  async exportCallerGraph(
    nodeId: string,
    depth: number = 3,
    options: ExportOptions = { format: 'dot' }
  ): Promise<string> {
    const subgraph = await this.getCallerSubgraph(nodeId, depth, options.maxNodes);
    return this.formatExport(subgraph, options);
  }

  /**
   * Export callee graph for a function
   */
  async exportCalleeGraph(
    nodeId: string,
    depth: number = 3,
    options: ExportOptions = { format: 'dot' }
  ): Promise<string> {
    const subgraph = await this.getCalleeSubgraph(nodeId, depth, options.maxNodes);
    return this.formatExport(subgraph, options);
  }

  /**
   * Export impact graph (blast radius)
   */
  async exportImpactGraph(
    nodeId: string,
    depth: number = 5,
    options: ExportOptions = { format: 'dot' }
  ): Promise<string> {
    const subgraph = await this.getImpactSubgraph(nodeId, depth, options.maxNodes);
    return this.formatExport(subgraph, options);
  }

  /**
   * Export the full project graph (warning: can be large)
   */
  async exportProjectGraph(
    projectId: number,
    options: ExportOptions = { format: 'dot' }
  ): Promise<string> {
    const subgraph = await this.getProjectGraph(projectId, options.maxNodes || 500);
    return this.formatExport(subgraph, options);
  }

  // ============================================
  // Subgraph Extraction Methods
  // ============================================

  /**
   * Get subgraph around a focal node
   */
  private async getSubgraph(
    focalNodeId: string,
    depth: number,
    maxNodes?: number
  ): Promise<SubgraphData> {
    const nodeSet = new Set<string>();
    const edgeList: VisualizationEdge[] = [];

    // Get focal node
    const focalRows = await this.q<{
      id: string;
      name: string;
    }>(
      `MATCH (n:CodeNode {id: '${esc(focalNodeId)}'}) RETURN n.id AS id, n.name AS name`
    );

    if (focalRows.length === 0) {
      throw new Error(`Node not found: ${focalNodeId}`);
    }

    const focalNode = focalRows[0];
    nodeSet.add(focalNodeId);

    // BFS to expand subgraph in both directions
    const queue: Array<{ id: string; depth: number }> = [{ id: focalNodeId, depth: 0 }];
    const visited = new Set<string>([focalNodeId]);

    while (queue.length > 0 && (!maxNodes || nodeSet.size < maxNodes)) {
      const current = queue.shift()!;

      if (current.depth >= depth) continue;

      // Get outgoing edges
      const outEdges = await this.q<{
        targetId: string;
        edgeType: string;
        lineNumber: number | null;
      }>(
        `MATCH (src:CodeNode {id: '${esc(current.id)}'})-[e:CodeEdge]->(tgt:CodeNode)
         RETURN tgt.id AS targetId, e.edge_type AS edgeType, e.line_number AS lineNumber`
      );

      for (const edge of outEdges) {
        if (!maxNodes || nodeSet.size < maxNodes) {
          nodeSet.add(edge.targetId);
          edgeList.push({
            source: current.id,
            target: edge.targetId,
            edgeType: edge.edgeType,
            lineNumber: edge.lineNumber ?? undefined
          });

          if (!visited.has(edge.targetId)) {
            visited.add(edge.targetId);
            queue.push({ id: edge.targetId, depth: current.depth + 1 });
          }
        }
      }

      // Get incoming edges
      const inEdges = await this.q<{
        sourceId: string;
        edgeType: string;
        lineNumber: number | null;
      }>(
        `MATCH (src:CodeNode)-[e:CodeEdge]->(tgt:CodeNode {id: '${esc(current.id)}'})
         RETURN src.id AS sourceId, e.edge_type AS edgeType, e.line_number AS lineNumber`
      );

      for (const edge of inEdges) {
        if (!maxNodes || nodeSet.size < maxNodes) {
          nodeSet.add(edge.sourceId);
          edgeList.push({
            source: edge.sourceId,
            target: current.id,
            edgeType: edge.edgeType,
            lineNumber: edge.lineNumber ?? undefined
          });

          if (!visited.has(edge.sourceId)) {
            visited.add(edge.sourceId);
            queue.push({ id: edge.sourceId, depth: current.depth + 1 });
          }
        }
      }
    }

    // Fetch node details
    const nodes = await this.getNodeDetails(Array.from(nodeSet));

    return {
      nodes,
      edges: this.deduplicateEdges(edgeList),
      metadata: {
        title: `Subgraph around ${focalNode.name}`,
        generatedAt: new Date().toISOString(),
        nodeCount: nodes.length,
        edgeCount: edgeList.length,
        focalNodeId
      }
    };
  }

  /**
   * Get caller subgraph (upstream)
   */
  private async getCallerSubgraph(
    nodeId: string,
    depth: number,
    maxNodes?: number
  ): Promise<SubgraphData> {
    const limitClause = maxNodes ? `LIMIT ${maxNodes}` : '';

    const results = await this.q<{
      id: string;
      sourceId: string;
      edgeType: string;
      lineNumber: number | null;
      depth: number;
    }>(
      // Kuzu doesn't expose startNode()/endNode(); nodes()/rels() are
      // 1-indexed. For rel at idx, source = nodes[idx], target = nodes[idx+1].
      `MATCH p = (caller:CodeNode)-[e:CodeEdge*1..${depth}]->(target:CodeNode {id: '${esc(nodeId)}'})
       WHERE ALL(r IN rels(e) WHERE r.edge_type = 'calls')
       UNWIND range(1, size(rels(e))) AS idx
       WITH rels(e)[idx] AS rel, nodes(p)[idx] AS src, nodes(p)[idx + 1] AS tgt, idx AS depth
       RETURN tgt.id AS id, src.id AS sourceId,
              rel.edge_type AS edgeType, rel.line_number AS lineNumber,
              depth
       ORDER BY depth
       ${limitClause}`
    );

    // Collect all node IDs
    const nodeSet = new Set<string>([nodeId]);
    const edgeList: VisualizationEdge[] = [];

    for (const row of results) {
      nodeSet.add(row.sourceId);
      edgeList.push({
        source: row.sourceId,
        target: row.id,
        edgeType: row.edgeType,
        lineNumber: row.lineNumber ?? undefined
      });
    }

    const nodes = await this.getNodeDetails(Array.from(nodeSet));
    const focalNode = nodes.find(n => n.id === nodeId);

    return {
      nodes,
      edges: edgeList,
      metadata: {
        title: `Callers of ${focalNode?.name || nodeId}`,
        generatedAt: new Date().toISOString(),
        nodeCount: nodes.length,
        edgeCount: edgeList.length,
        focalNodeId: nodeId
      }
    };
  }

  /**
   * Get callee subgraph (downstream)
   */
  private async getCalleeSubgraph(
    nodeId: string,
    depth: number,
    maxNodes?: number
  ): Promise<SubgraphData> {
    const limitClause = maxNodes ? `LIMIT ${maxNodes}` : '';

    const results = await this.q<{
      id: string;
      targetId: string;
      edgeType: string;
      lineNumber: number | null;
      depth: number;
    }>(
      `MATCH p = (src:CodeNode {id: '${esc(nodeId)}'})-[e:CodeEdge*1..${depth}]->(callee:CodeNode)
       WHERE ALL(r IN rels(e) WHERE r.edge_type = 'calls')
       UNWIND range(1, size(rels(e))) AS idx
       WITH rels(e)[idx] AS rel, nodes(p)[idx] AS relSrc, nodes(p)[idx + 1] AS relTgt, idx AS depth
       RETURN relSrc.id AS id, relTgt.id AS targetId,
              rel.edge_type AS edgeType, rel.line_number AS lineNumber,
              depth
       ORDER BY depth
       ${limitClause}`
    );

    const nodeSet = new Set<string>([nodeId]);
    const edgeList: VisualizationEdge[] = [];

    for (const row of results) {
      nodeSet.add(row.targetId);
      edgeList.push({
        source: row.id,
        target: row.targetId,
        edgeType: row.edgeType,
        lineNumber: row.lineNumber ?? undefined
      });
    }

    const nodes = await this.getNodeDetails(Array.from(nodeSet));
    const focalNode = nodes.find(n => n.id === nodeId);

    return {
      nodes,
      edges: edgeList,
      metadata: {
        title: `Callees of ${focalNode?.name || nodeId}`,
        generatedAt: new Date().toISOString(),
        nodeCount: nodes.length,
        edgeCount: edgeList.length,
        focalNodeId: nodeId
      }
    };
  }

  /**
   * Get impact subgraph (what would be affected by changes)
   */
  private async getImpactSubgraph(
    nodeId: string,
    depth: number,
    maxNodes?: number
  ): Promise<SubgraphData> {
    const limitClause = maxNodes ? `LIMIT ${maxNodes}` : '';

    // Follow reverse edges: who depends on this node
    const results = await this.q<{
      id: string;
      sourceId: string;
      edgeType: string;
      depth: number;
    }>(
      `MATCH p = (affected:CodeNode)-[e:CodeEdge*1..${depth}]->(target:CodeNode {id: '${esc(nodeId)}'})
       WHERE ALL(r IN rels(e) WHERE r.edge_type IN ['calls', 'uses', 'extends', 'implements'])
       UNWIND range(1, size(rels(e))) AS idx
       WITH nodes(p)[idx + 1] AS tgt, nodes(p)[idx] AS src, rels(e)[idx] AS rel, idx AS depth
       RETURN tgt.id AS id, src.id AS sourceId,
              rel.edge_type AS edgeType, depth
       ORDER BY depth
       ${limitClause}`
    );

    const nodeSet = new Set<string>([nodeId]);
    const edgeList: VisualizationEdge[] = [];

    for (const row of results) {
      nodeSet.add(row.sourceId);
      edgeList.push({
        source: row.sourceId,
        target: row.id,
        edgeType: row.edgeType
      });
    }

    const nodes = await this.getNodeDetails(Array.from(nodeSet));
    const focalNode = nodes.find(n => n.id === nodeId);

    return {
      nodes,
      edges: edgeList,
      metadata: {
        title: `Impact of ${focalNode?.name || nodeId}`,
        description: 'Code that would be affected by changes to this node',
        generatedAt: new Date().toISOString(),
        nodeCount: nodes.length,
        edgeCount: edgeList.length,
        focalNodeId: nodeId
      }
    };
  }

  /**
   * Get project graph
   */
  private async getProjectGraph(
    projectId: number,
    maxNodes: number
  ): Promise<SubgraphData> {
    const nodes = await this.q<{
      id: string;
      name: string;
      qualifiedName: string;
      nodeType: string;
      filePath: string;
      lineStart: number;
    }>(
      `MATCH (n:CodeNode)
       WHERE n.project_id = ${projectId}
       RETURN n.id AS id, n.name AS name, n.qualified_name AS qualifiedName,
              n.node_type AS nodeType, n.file_path AS filePath, n.line_start AS lineStart
       LIMIT ${maxNodes}`
    );

    const nodeIds = nodes.map(n => n.id);

    // Only query edges if we have nodes
    let edges: VisualizationEdge[] = [];
    if (nodeIds.length > 0) {
      const idList = nodeIds.map(id => `'${esc(id)}'`).join(', ');
      const edgeRows = await this.q<{
        sourceId: string;
        targetId: string;
        edgeType: string;
        lineNumber: number | null;
      }>(
        `MATCH (src:CodeNode)-[e:CodeEdge]->(tgt:CodeNode)
         WHERE src.id IN [${idList}] AND tgt.id IN [${idList}]
         RETURN src.id AS sourceId, tgt.id AS targetId,
                e.edge_type AS edgeType, e.line_number AS lineNumber`
      );

      edges = edgeRows.map(e => ({
        source: e.sourceId,
        target: e.targetId,
        edgeType: e.edgeType,
        lineNumber: e.lineNumber ?? undefined
      }));
    }

    return {
      nodes: nodes.map(n => ({
        id: n.id,
        name: n.name,
        qualifiedName: n.qualifiedName,
        nodeType: n.nodeType,
        filePath: n.filePath,
        lineStart: n.lineStart
      })),
      edges,
      metadata: {
        title: `Project ${projectId} Graph`,
        generatedAt: new Date().toISOString(),
        nodeCount: nodes.length,
        edgeCount: edges.length
      }
    };
  }

  // ============================================
  // Export Formatters
  // ============================================

  /**
   * Format subgraph for export
   */
  private formatExport(subgraph: SubgraphData, options: ExportOptions): string {
    switch (options.format) {
      case 'dot':
        return this.formatDot(subgraph, options);
      case 'json':
        return this.formatJson(subgraph);
      case 'd3':
        return this.formatD3(subgraph);
      case 'cytoscape':
        return this.formatCytoscape(subgraph);
      default:
        return this.formatDot(subgraph, options);
    }
  }

  /**
   * Generate DOT format for GraphViz
   */
  private formatDot(subgraph: SubgraphData, options: ExportOptions): string {
    const lines: string[] = [];
    const layout = options.layout || 'hierarchical';

    // Graph header
    lines.push(`digraph CodeGraph {`);
    lines.push(`  // Generated: ${subgraph.metadata.generatedAt}`);
    lines.push(`  // Nodes: ${subgraph.metadata.nodeCount}, Edges: ${subgraph.metadata.edgeCount}`);
    lines.push('');

    // Graph attributes based on layout
    if (layout === 'hierarchical') {
      lines.push('  rankdir=TB;');
      lines.push('  splines=ortho;');
    } else if (layout === 'radial') {
      lines.push('  layout=twopi;');
      lines.push('  ranksep=3;');
    } else if (layout === 'circular') {
      lines.push('  layout=circo;');
    }

    lines.push('  node [shape=box, style=rounded, fontname="Helvetica"];');
    lines.push('  edge [fontname="Helvetica", fontsize=10];');
    lines.push('');

    // Add title if provided
    if (options.title || subgraph.metadata.title) {
      lines.push(`  label="${options.title || subgraph.metadata.title}";`);
      lines.push('  labelloc=t;');
      lines.push('  fontsize=16;');
      lines.push('');
    }

    // Nodes
    lines.push('  // Nodes');
    for (const node of subgraph.nodes) {
      const color = this.getNodeColor(node, options.colorScheme);
      const label = this.escapeLabel(node.name);
      const tooltip = this.escapeLabel(node.qualifiedName);

      const isFocal = node.id === subgraph.metadata.focalNodeId;
      const style = isFocal ? 'filled,bold' : 'filled';
      const penwidth = isFocal ? 3 : 1;

      lines.push(`  "${node.id}" [label="${label}", tooltip="${tooltip}", fillcolor="${color}", style="${style}", penwidth=${penwidth}];`);
    }
    lines.push('');

    // Edges
    lines.push('  // Edges');
    for (const edge of subgraph.edges) {
      const color = EDGE_TYPE_COLORS[edge.edgeType] || EDGE_TYPE_COLORS.calls;
      const label = edge.edgeType !== 'calls' ? edge.edgeType : '';
      const style = edge.edgeType === 'extends' || edge.edgeType === 'implements' ? 'dashed' : 'solid';

      lines.push(`  "${edge.source}" -> "${edge.target}" [color="${color}", label="${label}", style="${style}"];`);
    }

    lines.push('}');

    return lines.join('\n');
  }

  /**
   * Generate JSON format
   */
  private formatJson(subgraph: SubgraphData): string {
    return JSON.stringify(subgraph, null, 2);
  }

  /**
   * Generate D3.js compatible format
   */
  private formatD3(subgraph: SubgraphData): string {
    const d3Data = {
      nodes: subgraph.nodes.map(n => ({
        id: n.id,
        name: n.name,
        group: n.nodeType,
        qualifiedName: n.qualifiedName,
        filePath: n.filePath,
        lineStart: n.lineStart,
        color: NODE_TYPE_COLORS[n.nodeType] || NODE_TYPE_COLORS.default,
        isFocal: n.id === subgraph.metadata.focalNodeId
      })),
      links: subgraph.edges.map(e => ({
        source: e.source,
        target: e.target,
        type: e.edgeType,
        color: EDGE_TYPE_COLORS[e.edgeType] || EDGE_TYPE_COLORS.calls
      })),
      metadata: subgraph.metadata
    };

    return JSON.stringify(d3Data, null, 2);
  }

  /**
   * Generate Cytoscape.js compatible format
   */
  private formatCytoscape(subgraph: SubgraphData): string {
    const elements = {
      nodes: subgraph.nodes.map(n => ({
        data: {
          id: n.id,
          label: n.name,
          qualifiedName: n.qualifiedName,
          nodeType: n.nodeType,
          filePath: n.filePath,
          lineStart: n.lineStart,
          color: NODE_TYPE_COLORS[n.nodeType] || NODE_TYPE_COLORS.default,
          isFocal: n.id === subgraph.metadata.focalNodeId
        }
      })),
      edges: subgraph.edges.map((e, i) => ({
        data: {
          id: `e${i}`,
          source: e.source,
          target: e.target,
          edgeType: e.edgeType,
          color: EDGE_TYPE_COLORS[e.edgeType] || EDGE_TYPE_COLORS.calls
        }
      }))
    };

    return JSON.stringify({ elements, metadata: subgraph.metadata }, null, 2);
  }

  // ============================================
  // Helper Methods
  // ============================================

  /**
   * Get node details from database
   */
  private async getNodeDetails(nodeIds: string[]): Promise<VisualizationNode[]> {
    if (nodeIds.length === 0) return [];

    const idList = nodeIds.map(id => `'${esc(id)}'`).join(', ');
    const rows = await this.q<{
      id: string;
      name: string;
      qualifiedName: string;
      nodeType: string;
      filePath: string;
      lineStart: number;
    }>(
      `MATCH (n:CodeNode)
       WHERE n.id IN [${idList}]
       RETURN n.id AS id, n.name AS name, n.qualified_name AS qualifiedName,
              n.node_type AS nodeType, n.file_path AS filePath, n.line_start AS lineStart`
    );

    return rows.map(n => ({
      id: n.id,
      name: n.name,
      qualifiedName: n.qualifiedName,
      nodeType: n.nodeType,
      filePath: n.filePath,
      lineStart: n.lineStart
    }));
  }

  /**
   * Remove duplicate edges
   */
  private deduplicateEdges(edges: VisualizationEdge[]): VisualizationEdge[] {
    const seen = new Set<string>();
    return edges.filter(e => {
      const key = `${e.source}->${e.target}:${e.edgeType}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Get node color based on color scheme
   */
  private getNodeColor(node: VisualizationNode, scheme?: string): string {
    if (scheme === 'file') {
      // Hash file path to color
      let hash = 0;
      for (let i = 0; i < node.filePath.length; i++) {
        hash = ((hash << 5) - hash) + node.filePath.charCodeAt(i);
        hash = hash & hash;
      }
      const hue = Math.abs(hash % 360);
      return `hsl(${hue}, 70%, 85%)`;
    }

    // Default: color by node type
    return NODE_TYPE_COLORS[node.nodeType] || NODE_TYPE_COLORS.default;
  }

  /**
   * Escape string for DOT label
   */
  private escapeLabel(str: string): string {
    return str
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n');
  }
}

// ============================================
// Factory Function
// ============================================

let serviceInstance: GraphVisualizationService | null = null;

/**
 * Get or create the graph visualization service
 */
export function getGraphVisualizationService(prisma?: PrismaClient): GraphVisualizationService {
  if (!serviceInstance) {
    serviceInstance = new GraphVisualizationService(prisma);
  }
  return serviceInstance;
}

/**
 * Reset the service (for testing)
 */
export function resetGraphVisualizationService(): void {
  serviceInstance = null;
}
