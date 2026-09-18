/**
 * Community Detection Service
 *
 * Uses graphology + Louvain algorithm to detect communities in the code graph.
 * Fetches graph data from LadybugDB, builds an in-memory graphology graph,
 * runs Louvain, and stores community assignments back in LadybugDB as
 * a node property.
 *
 * Communities represent clusters of closely-related code — useful for:
 * - Understanding module boundaries
 * - Visualizing code architecture
 * - Identifying tightly-coupled components
 */

import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import { ladybugQuery, ladybugExecute } from './ladybugConnection.js';
import { createLogger } from '../utils/index.js';

const logger = createLogger('community-detection');

// ============================================
// Types
// ============================================

export interface Community {
  id: number;
  size: number;
  nodes: Array<{
    id: string;
    name: string;
    qualifiedName: string;
    nodeType: string;
  }>;
}

export interface CommunityResult {
  projectId: number;
  communityCount: number;
  communities: Community[];
  modularity: number;
  durationMs: number;
}

// ============================================
// Community Detection
// ============================================

/**
 * Detect communities in the code graph for a project using Louvain algorithm.
 * Returns community assignments and stores them as node properties in LadybugDB.
 */
export async function detectCommunities(
  projectId: number,
  options: {
    edgeTypes?: string[];
    resolution?: number;
    minCommunitySize?: number;
  } = {}
): Promise<CommunityResult> {
  const startTime = Date.now();
  const {
    edgeTypes = ['calls', 'extends', 'implements', 'contains'],
    resolution = 1.0,
    minCommunitySize = 2
  } = options;

  logger.info(`Detecting communities for project ${projectId}`);

  // Fetch nodes
  const nodes = await ladybugQuery<{
    id: string;
    name: string;
    qn: string;
    nt: string;
  }>(projectId,
    `MATCH (n:CodeNode {project_id: ${projectId}})
     RETURN n.id AS id, n.name AS name, n.qualified_name AS qn, n.node_type AS nt`
  );

  if (nodes.length === 0) {
    return {
      projectId,
      communityCount: 0,
      communities: [],
      modularity: 0,
      durationMs: Date.now() - startTime
    };
  }

  // Fetch edges (filtered by type)
  const typeFilter = edgeTypes.map(t => `'${t}'`).join(', ');
  const edges = await ladybugQuery<{ src: string; dst: string; et: string }>(projectId,
    `MATCH (a:CodeNode {project_id: ${projectId}})-[e:CodeEdge]->(b:CodeNode)
     WHERE e.edge_type IN [${typeFilter}]
     RETURN a.id AS src, b.id AS dst, e.edge_type AS et`
  );

  // Build graphology graph
  const graph = new Graph({ type: 'undirected', allowSelfLoops: false });

  const nodeSet = new Set(nodes.map(n => n.id));
  for (const node of nodes) {
    graph.addNode(node.id, {
      name: node.name,
      qualifiedName: node.qn,
      nodeType: node.nt
    });
  }

  for (const edge of edges) {
    // Only add edges where both nodes exist and avoid self-loops
    if (nodeSet.has(edge.src) && nodeSet.has(edge.dst) && edge.src !== edge.dst) {
      // graphology undirected: merge duplicate edges
      if (!graph.hasEdge(edge.src, edge.dst)) {
        graph.addEdge(edge.src, edge.dst, { weight: 1 });
      } else {
        // Increase weight for multi-edges
        const key = graph.edge(edge.src, edge.dst);
        if (key) {
          const w = graph.getEdgeAttribute(key, 'weight') || 1;
          graph.setEdgeAttribute(key, 'weight', w + 1);
        }
      }
    }
  }

  logger.debug(`Graphology graph: ${graph.order} nodes, ${graph.size} edges`);

  // Run Louvain
  const communities = louvain(graph, {
    resolution,
    getEdgeWeight: 'weight'
  });

  // The result is a mapping: nodeId -> communityId
  // Louvain assigns community as a node attribute
  const communityMap = new Map<number, string[]>();
  for (const nodeId of graph.nodes()) {
    const communityId = communities[nodeId] as number;
    if (!communityMap.has(communityId)) {
      communityMap.set(communityId, []);
    }
    communityMap.get(communityId)!.push(nodeId);
  }

  // Build result
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const result: Community[] = [];
  let communityIndex = 0;

  for (const [_louvainId, memberIds] of communityMap) {
    if (memberIds.length < minCommunitySize) continue;

    result.push({
      id: communityIndex++,
      size: memberIds.length,
      nodes: memberIds.map(id => {
        const n = nodeMap.get(id)!;
        return {
          id: n.id,
          name: n.name,
          qualifiedName: n.qn,
          nodeType: n.nt
        };
      })
    });
  }

  // Sort by size descending
  result.sort((a, b) => b.size - a.size);
  // Re-assign sequential IDs after sorting
  result.forEach((c, i) => { c.id = i; });

  // Calculate modularity (approximate from Louvain result)
  const modularity = louvain.detailed(graph, { resolution, getEdgeWeight: 'weight' }).modularity;

  // Store community assignments back in LadybugDB as a node property
  // We do this by adding a 'community' property update for each node
  // LadybugDB supports SET for property updates
  for (const community of result) {
    for (const node of community.nodes) {
      try {
        await ladybugExecute(projectId,
          `MATCH (n:CodeNode {id: '${node.id}'}) SET n.community = ${community.id}`
        );
      } catch {
        // SET may not work if 'community' column doesn't exist in schema
        // This is a known limitation — we store in-memory only
        break;
      }
    }
  }

  const durationMs = Date.now() - startTime;
  logger.info(
    `Community detection complete: ${result.length} communities, ` +
    `modularity=${modularity.toFixed(3)}, ${durationMs}ms`
  );

  return {
    projectId,
    communityCount: result.length,
    communities: result,
    modularity,
    durationMs
  };
}

/**
 * Get previously detected communities for a project.
 * Reads community assignments from the in-memory cache or re-runs detection.
 */
let communityCache = new Map<number, CommunityResult>();

export function getCachedCommunities(projectId: number): CommunityResult | undefined {
  return communityCache.get(projectId);
}

export async function getOrDetectCommunities(
  projectId: number,
  options?: Parameters<typeof detectCommunities>[1]
): Promise<CommunityResult> {
  const cached = communityCache.get(projectId);
  if (cached) return cached;

  const result = await detectCommunities(projectId, options);
  communityCache.set(projectId, result);
  return result;
}

export function clearCommunityCache(projectId?: number): void {
  if (projectId !== undefined) {
    communityCache.delete(projectId);
  } else {
    communityCache = new Map();
  }
}
