/**
 * Process/Execution Flow Tracer
 *
 * Discovers entry points and traces execution flows through the call graph.
 * Uses BFS from entry points (constructors, public handlers, main methods)
 * to build ordered execution paths.
 *
 * Entry point scoring:
 * - Name patterns: make, main, onXxx, doXxx, handleXxx (+3)
 * - Public API status: isPublic && !isStatic (+2)
 * - Call ratio: high outgoing / low incoming calls (+1-3)
 * - Constructor type (+2)
 *
 * Process flows are cached per project and re-detected on demand.
 */

import { ladybugQuery } from './ladybugConnection.js';
import { createLogger } from '../utils/index.js';

const logger = createLogger('process-tracer');

// ============================================
// Types
// ============================================

export interface ProcessStep {
  nodeId: string;
  name: string;
  qualifiedName: string;
  nodeType: string;
  stepIndex: number;
}

export interface ProcessFlow {
  id: number;
  name: string;
  entryPoint: {
    id: string;
    name: string;
    qualifiedName: string;
  };
  terminal: {
    id: string;
    name: string;
    qualifiedName: string;
  };
  steps: ProcessStep[];
  stepCount: number;
  flowType: 'intra_module' | 'cross_module';
}

export interface ProcessTracingResult {
  projectId: number;
  entryPointCount: number;
  processCount: number;
  processes: ProcessFlow[];
  durationMs: number;
}

interface NodeInfo {
  id: string;
  name: string;
  qualifiedName: string;
  nodeType: string;
  filePath: string;
  isPublic: boolean;
  isStatic: boolean;
}

// ============================================
// Entry Point Discovery
// ============================================

/** Fantom/general entry point name patterns */
const ENTRY_POINT_PATTERNS = [
  /^make$/,           // Fantom constructors
  /^main$/,           // Main entry point
  /^on[A-Z]/,         // Event handlers (onStart, onLoad, etc.)
  /^do[A-Z]/,         // Action methods (doSave, doProcess, etc.)
  /^handle[A-Z]/,     // Request handlers
  /^init$/,           // Initialization methods
  /^setup$/,          // Setup methods
  /^run$/,            // Runner methods
  /^start$/,          // Startup methods
  /^execute$/,        // Execution entry points
  /^process$/,        // Processing entry points
];

function scoreEntryPoint(
  node: NodeInfo,
  inDegree: number,
  outDegree: number
): number {
  let score = 0;

  // Name pattern match
  if (ENTRY_POINT_PATTERNS.some(p => p.test(node.name))) {
    score += 3;
  }

  // Constructor
  if (node.nodeType === 'constructor') {
    score += 2;
  }

  // Public non-static (API surface)
  if (node.isPublic && !node.isStatic) {
    score += 2;
  }

  // Call ratio: calls many, called by few
  if (outDegree > 0 && inDegree === 0) {
    score += 3; // Pure entry point — nothing calls it
  } else if (outDegree > 0 && inDegree <= 2 && outDegree >= 3) {
    score += 2; // High fan-out, low fan-in
  } else if (outDegree > inDegree) {
    score += 1;
  }

  return score;
}

// ============================================
// BFS Tracing
// ============================================

async function bfsTrace(
  projectId: number,
  entryId: string,
  maxDepth: number,
  maxBranching: number
): Promise<string[][]> {
  // Get all call edges from the entry point outward
  const paths: string[][] = [];
  const visited = new Set<string>();
  const queue: Array<{ nodeId: string; path: string[]; depth: number }> = [
    { nodeId: entryId, path: [entryId], depth: 0 }
  ];

  while (queue.length > 0) {
    const { nodeId, path, depth } = queue.shift()!;

    if (depth >= maxDepth) {
      if (path.length >= 3) paths.push(path);
      continue;
    }

    // Get callees of this node
    const callees = await ladybugQuery<{ id: string }>(projectId,
      `MATCH (n:CodeNode {id: '${nodeId}'})-[e:CodeEdge {edge_type: 'calls'}]->(callee:CodeNode)
       WHERE e.confidence >= 0.5
       RETURN callee.id AS id
       LIMIT ${maxBranching}`
    );

    if (callees.length === 0) {
      // Terminal node — save path if long enough
      if (path.length >= 3) {
        paths.push(path);
      }
      continue;
    }

    for (const callee of callees) {
      if (visited.has(`${entryId}->${callee.id}`)) continue;
      if (path.includes(callee.id)) continue; // Avoid cycles

      visited.add(`${entryId}->${callee.id}`);
      queue.push({
        nodeId: callee.id,
        path: [...path, callee.id],
        depth: depth + 1
      });
    }
  }

  return paths;
}

/**
 * Remove subset paths: if path A is a prefix of path B, keep only B.
 */
function deduplicatePaths(paths: string[][]): string[][] {
  // Sort by length descending
  paths.sort((a, b) => b.length - a.length);

  const result: string[][] = [];
  for (const path of paths) {
    const pathStr = path.join(',');
    const isSubset = result.some(kept => kept.join(',').includes(pathStr));
    if (!isSubset) {
      result.push(path);
    }
  }

  return result;
}

// ============================================
// Main Tracing Function
// ============================================

export async function traceProcessFlows(
  projectId: number,
  options: {
    minEntryScore?: number;
    maxEntryPoints?: number;
    maxDepth?: number;
    maxBranching?: number;
    minSteps?: number;
  } = {}
): Promise<ProcessTracingResult> {
  const startTime = Date.now();
  const {
    minEntryScore = 3,
    maxEntryPoints = 50,
    maxDepth = 10,
    maxBranching = 4,
    minSteps = 3
  } = options;

  logger.info(`Tracing process flows for project ${projectId}`);

  // Get all nodes with their degrees
  const nodes = await ladybugQuery<{
    id: string; name: string; qn: string; nt: string;
    fp: string; pub: boolean; stat: boolean;
  }>(projectId,
    `MATCH (n:CodeNode {project_id: ${projectId}})
     RETURN n.id AS id, n.name AS name, n.qualified_name AS qn,
            n.node_type AS nt, n.file_path AS fp,
            n.is_public AS pub, n.is_static AS stat`
  );

  // Get in-degree and out-degree for each node
  const inDegrees = new Map<string, number>();
  const outDegrees = new Map<string, number>();

  const inRows = await ladybugQuery<{ id: string; c: number }>(projectId,
    `MATCH ()-[e:CodeEdge {edge_type: 'calls'}]->(n:CodeNode {project_id: ${projectId}})
     RETURN n.id AS id, count(e) AS c`
  );
  for (const r of inRows) inDegrees.set(r.id, Number(r.c));

  const outRows = await ladybugQuery<{ id: string; c: number }>(projectId,
    `MATCH (n:CodeNode {project_id: ${projectId}})-[e:CodeEdge {edge_type: 'calls'}]->()
     RETURN n.id AS id, count(e) AS c`
  );
  for (const r of outRows) outDegrees.set(r.id, Number(r.c));

  // Score entry points
  const entryPoints: Array<{ node: NodeInfo; score: number }> = [];
  for (const n of nodes) {
    const nodeInfo: NodeInfo = {
      id: n.id, name: n.name, qualifiedName: n.qn,
      nodeType: n.nt, filePath: n.fp,
      isPublic: n.pub, isStatic: n.stat
    };
    const score = scoreEntryPoint(
      nodeInfo,
      inDegrees.get(n.id) || 0,
      outDegrees.get(n.id) || 0
    );
    if (score >= minEntryScore) {
      entryPoints.push({ node: nodeInfo, score });
    }
  }

  // Sort by score descending and limit
  entryPoints.sort((a, b) => b.score - a.score);
  const topEntries = entryPoints.slice(0, maxEntryPoints);

  logger.debug(`Found ${topEntries.length} entry points (from ${nodes.length} nodes)`);

  // Trace from each entry point
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const allProcesses: ProcessFlow[] = [];
  let processId = 0;

  for (const entry of topEntries) {
    const rawPaths = await bfsTrace(projectId, entry.node.id, maxDepth, maxBranching);
    const paths = deduplicatePaths(rawPaths);

    for (const path of paths) {
      if (path.length < minSteps) continue;

      const steps: ProcessStep[] = path.map((nodeId, idx) => {
        const n = nodeMap.get(nodeId);
        return {
          nodeId,
          name: n?.name || 'unknown',
          qualifiedName: n?.qn || nodeId,
          nodeType: n?.nt || 'unknown',
          stepIndex: idx
        };
      });

      const terminalNode = nodeMap.get(path[path.length - 1]);

      // Determine flow type: check if entry and terminal are in the same file
      const entryFile = entry.node.filePath;
      const termFile = terminalNode?.fp || '';
      const flowType = entryFile === termFile ? 'intra_module' : 'cross_module';

      allProcesses.push({
        id: processId++,
        name: `${entry.node.name} → ${terminalNode?.name || '?'}`,
        entryPoint: {
          id: entry.node.id,
          name: entry.node.name,
          qualifiedName: entry.node.qualifiedName
        },
        terminal: {
          id: path[path.length - 1],
          name: terminalNode?.name || 'unknown',
          qualifiedName: terminalNode?.qn || path[path.length - 1]
        },
        steps,
        stepCount: steps.length,
        flowType
      });
    }
  }

  // Sort by step count descending
  allProcesses.sort((a, b) => b.stepCount - a.stepCount);

  const durationMs = Date.now() - startTime;
  logger.info(
    `Process tracing complete: ${allProcesses.length} flows from ` +
    `${topEntries.length} entry points, ${durationMs}ms`
  );

  return {
    projectId,
    entryPointCount: topEntries.length,
    processCount: allProcesses.length,
    processes: allProcesses,
    durationMs
  };
}

/**
 * Find all processes that include a specific function.
 */
export function findProcessesForFunction(
  result: ProcessTracingResult,
  nodeId: string
): ProcessFlow[] {
  return result.processes.filter(p =>
    p.steps.some(s => s.nodeId === nodeId)
  );
}

// ============================================
// Cache
// ============================================

let processCache = new Map<number, ProcessTracingResult>();

export function getCachedProcessFlows(projectId: number): ProcessTracingResult | undefined {
  return processCache.get(projectId);
}

export async function getOrTraceProcessFlows(
  projectId: number,
  options?: Parameters<typeof traceProcessFlows>[1]
): Promise<ProcessTracingResult> {
  const cached = processCache.get(projectId);
  if (cached) return cached;

  const result = await traceProcessFlows(projectId, options);
  processCache.set(projectId, result);
  return result;
}

export function clearProcessCache(projectId?: number): void {
  if (projectId !== undefined) {
    processCache.delete(projectId);
  } else {
    processCache = new Map();
  }
}
