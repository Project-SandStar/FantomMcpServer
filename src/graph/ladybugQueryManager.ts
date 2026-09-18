/**
 * LadybugDB Query Manager
 *
 * Replaces GraphQueryManager's SQLite recursive CTEs with native Cypher queries.
 * Returns the same result types so it's a drop-in replacement for graph traversal.
 *
 * Provides both graph traversal (where Cypher excels) and metadata lookups
 * (findNodesByPattern, getNodeByQualifiedName) so callers don't need Prisma.
 */

import { ladybugQuery } from './ladybugConnection.js';

/**
 * Per-project graph migration: the QueryManager is now project-aware. When
 * constructed with a projectId, every internal query routes to that project's
 * dedicated DB at `.cache/graph/<pid>.db` (via the C2 overload). When
 * constructed without a projectId — the legacy singleton path — queries route
 * to the shared `.cache/fantom-graph.db` for backward compatibility while
 * remaining call sites are converted.
 *
 * Use `getLadybugQueryManager(projectId)` for per-project usage.
 */
import type {
  EdgeType,
  CallerResult,
  CalleeResult,
  ImpactResult,
  PathResult,
  CycleResult,
  GraphMetrics
} from './types.js';

/** Escape single quotes for Cypher */
function esc(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Parse edge metadata JSON safely */
function parseMetadata(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export class LadybugQueryManager {
  private readonly projectId: number | undefined;

  /**
   * @param projectId — when set, all queries route to that project's DB
   *   (`.cache/graph/<projectId>.db`). When omitted, legacy singleton DB.
   */
  constructor(projectId?: number) {
    this.projectId = projectId;
  }

  /** Internal: route a read query to per-project DB if bound, else legacy. */
  private async q<T = Record<string, unknown>>(cypher: string): Promise<T[]> {
    return this.projectId !== undefined
      ? ladybugQuery<T>(this.projectId, cypher)
      : ladybugQuery<T>(cypher);
  }

  /**
   * Get all callers of a function (who calls this?)
   * Native Cypher variable-length path traversal.
   */
  async getCallers(nodeId: string, maxDepth = 5): Promise<CallerResult[]> {
    const rows = await this.q<{
      'caller.id': string;
      'caller.name': string;
      'caller.qualified_name': string;
      'caller.file_path': string;
      line_number: number;
      edge_type: string;
      confidence: number;
      metadata: string;
      depth: number;
    }>(
      // Kuzu's variable-length `e` is RECURSIVE_REL; `rels(e)` extracts the
      // LIST<REL>. Filter edge_type INSIDE the expansion `(r, _ | WHERE ...)`,
      // NOT via a post-hoc `WHERE ALL(rels(e)...)`. The post-hoc form expands
      // over EVERY edge type first and explodes the 24 MiB buffer pool on hub
      // nodes (high fan-in) before pruning — same path-explosion class as the
      // getMetrics depth query. Inline pruning only ever walks matching edges.
      `MATCH (caller:CodeNode)-[e:CodeEdge*1..${maxDepth} (r, _ | WHERE r.edge_type IN ['calls', 'uses'])]->(target:CodeNode {id: '${esc(nodeId)}'})
       WITH caller, rels(e)[1] AS first_e, length(e) AS depth
       RETURN DISTINCT caller.id, caller.name, caller.qualified_name,
              caller.file_path, first_e.line_number AS line_number,
              first_e.edge_type AS edge_type, first_e.confidence AS confidence,
              first_e.metadata AS metadata, depth
       ORDER BY depth ASC, caller.name ASC`
    );

    // Deduplicate by caller.id, keeping minimum depth
    const seen = new Map<string, CallerResult>();
    for (const r of rows) {
      const id = r['caller.id'];
      const depth = Number(r.depth);
      if (!seen.has(id) || depth < seen.get(id)!.depth) {
        const meta = parseMetadata(r.metadata);
        seen.set(id, {
          id,
          name: r['caller.name'],
          qualifiedName: r['caller.qualified_name'],
          depth,
          filePath: r['caller.file_path'],
          lineNumber: r.line_number ? Number(r.line_number) : undefined,
          edgeType: (r.edge_type || 'calls') as EdgeType,
          confidence: r.confidence != null ? Number(r.confidence) : undefined,
          isStatic: meta?.isStatic as boolean | undefined,
          isDynamic: meta?.isDynamic as boolean | undefined,
          isConstructor: meta?.isConstructor as boolean | undefined,
          callTarget: meta?.target as string | undefined
        });
      }
    }
    return Array.from(seen.values()).sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name));
  }

  /**
   * Get all callees of a function (what does this call?)
   */
  async getCallees(nodeId: string, maxDepth = 5): Promise<CalleeResult[]> {
    const rows = await this.q<{
      'callee.id': string;
      'callee.name': string;
      'callee.qualified_name': string;
      'callee.file_path': string;
      line_number: number;
      confidence: number;
      metadata: string;
      depth: number;
    }>(
      // Inline edge_type pruning — see getCallers; avoids hub-node pool blowup.
      `MATCH (src:CodeNode {id: '${esc(nodeId)}'})-[e:CodeEdge*1..${maxDepth} (r, _ | WHERE r.edge_type = 'calls')]->(callee:CodeNode)
       WITH callee, rels(e)[1] AS first_e, length(e) AS depth
       RETURN DISTINCT callee.id, callee.name, callee.qualified_name,
              callee.file_path, first_e.line_number AS line_number,
              first_e.confidence AS confidence, first_e.metadata AS metadata, depth
       ORDER BY depth ASC, callee.name ASC`
    );

    const seen = new Map<string, CalleeResult>();
    for (const r of rows) {
      const id = r['callee.id'];
      const depth = Number(r.depth);
      if (!seen.has(id) || depth < seen.get(id)!.depth) {
        const meta = parseMetadata(r.metadata);
        seen.set(id, {
          id,
          name: r['callee.name'],
          qualifiedName: r['callee.qualified_name'],
          depth,
          filePath: r['callee.file_path'],
          lineNumber: r.line_number ? Number(r.line_number) : undefined,
          confidence: r.confidence != null ? Number(r.confidence) : undefined,
          isStatic: meta?.isStatic as boolean | undefined,
          isDynamic: meta?.isDynamic as boolean | undefined,
          isConstructor: meta?.isConstructor as boolean | undefined,
          callTarget: meta?.target as string | undefined
        });
      }
    }
    return Array.from(seen.values()).sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name));
  }

  /**
   * Calculate impact/blast radius of changes to a node.
   * Finds all nodes that depend on the target (callers, extenders, implementors).
   */
  async getImpact(nodeId: string, maxDepth = 10): Promise<ImpactResult> {
    // Get focal node info
    const focalRows = await this.q<{
      'n.id': string;
      'n.name': string;
      'n.qualified_name': string;
    }>(
      `MATCH (n:CodeNode {id: '${esc(nodeId)}'}) RETURN n.id, n.name, n.qualified_name`
    );

    if (focalRows.length === 0) {
      throw new Error(`Node not found: ${nodeId}`);
    }
    const focal = focalRows[0];

    // Get all affected nodes via reverse edges
    const rows = await this.q<{
      'affected.id': string;
      'affected.name': string;
      'affected.qualified_name': string;
      'affected.file_path': string;
      edge_type: string;
      depth: number;
    }>(
      // Inline edge_type pruning — see getCallers; avoids hub-node pool blowup.
      `MATCH (affected:CodeNode)-[e:CodeEdge*1..${maxDepth} (r, _ | WHERE r.edge_type IN ['calls', 'extends', 'implements', 'uses', 'returns', 'parameters'])]->(target:CodeNode {id: '${esc(nodeId)}'})
       UNWIND rels(e) AS rel
       WITH affected, rel.edge_type AS edge_type, length(e) AS depth
       RETURN DISTINCT affected.id, affected.name, affected.qualified_name,
              affected.file_path, edge_type, depth
       ORDER BY depth ASC, affected.name ASC`
    );

    // Aggregate by node ID
    const breakdown: Record<EdgeType, number> = {
      calls: 0, extends: 0, implements: 0, contains: 0,
      uses: 0, returns: 0, parameters: 0, overrides: 0
    };
    const nodeMap = new Map<string, {
      id: string; name: string; qualifiedName: string;
      edgeTypes: Set<EdgeType>; minDepth: number; filePath: string;
    }>();

    for (const r of rows) {
      const id = r['affected.id'];
      const et = r.edge_type as EdgeType;
      const depth = Number(r.depth);

      if (!nodeMap.has(id)) {
        nodeMap.set(id, {
          id,
          name: r['affected.name'],
          qualifiedName: r['affected.qualified_name'],
          edgeTypes: new Set([et]),
          minDepth: depth,
          filePath: r['affected.file_path']
        });
      } else {
        const entry = nodeMap.get(id)!;
        entry.edgeTypes.add(et);
        entry.minDepth = Math.min(entry.minDepth, depth);
      }
      if (et in breakdown) breakdown[et]++;
    }

    const affectedNodes = Array.from(nodeMap.values()).map(n => ({
      id: n.id,
      name: n.name,
      qualifiedName: n.qualifiedName,
      edgeTypes: Array.from(n.edgeTypes),
      minDepth: n.minDepth,
      filePath: n.filePath
    }));

    return {
      focalNode: {
        id: focal['n.id'],
        name: focal['n.name'],
        qualifiedName: focal['n.qualified_name']
      },
      affectedNodes,
      totalAffected: affectedNodes.length,
      maxDepthReached: affectedNodes.length > 0
        ? Math.max(...affectedNodes.map(n => n.minDepth))
        : 0,
      breakdown
    };
  }

  /**
   * Find shortest path between two nodes.
   * Uses variable-length path + ORDER BY length LIMIT 1.
   */
  async findPath(fromId: string, toId: string, maxDepth = 10): Promise<PathResult> {
    const rows = await this.q<{
      name: string;
      id: string;
      qualified_name: string;
    }>(
      // `* SHORTEST` lets Kuzu compute the shortest path natively (bounded
      // frontier) instead of enumerating ALL paths up to maxDepth and sorting
      // by length — the latter explodes the buffer pool between hub nodes.
      `MATCH p = (a:CodeNode {id: '${esc(fromId)}'})-[e:CodeEdge* SHORTEST 1..${maxDepth}]->(b:CodeNode {id: '${esc(toId)}'})
       UNWIND nodes(p) AS n
       RETURN n.id AS id, n.name AS name, n.qualified_name AS qualified_name`
    );

    if (rows.length === 0) {
      return { found: false, path: [], edges: [], depth: 0 };
    }

    // Get edge types along the path
    const edgeRows = await this.q<{ edge_type: string }>(
      `MATCH p = (a:CodeNode {id: '${esc(fromId)}'})-[e:CodeEdge* SHORTEST 1..${maxDepth}]->(b:CodeNode {id: '${esc(toId)}'})
       UNWIND rels(e) AS rel
       RETURN rel.edge_type AS edge_type`
    );

    return {
      found: true,
      path: rows.map(r => ({
        id: r.id,
        name: r.name,
        qualifiedName: r.qualified_name
      })),
      edges: edgeRows.map(r => r.edge_type as EdgeType),
      depth: rows.length - 1
    };
  }

  /**
   * Detect cycles in the call graph for a project.
   * Uses Cypher's cycle-finding pattern: (a)-[*]->(a).
   */
  async detectCycles(projectId: number, maxCycles = 10): Promise<CycleResult[]> {
    const rows = await this.q<{
      'a.id': string;
      'a.name': string;
    }>(
      // `*TRAIL` forbids reusing an edge, so cycle search back to `(a)` can't
      // revisit edges and blow up — without it, `*1..20` over the cyclic call
      // graph (WALK semantics) exhausts the buffer pool. Inline edge_type
      // pruning keeps the frontier to 'calls' edges only.
      `MATCH (a:CodeNode {project_id: ${projectId}})-[e:CodeEdge*TRAIL 1..20 (r, _ | WHERE r.edge_type = 'calls')]->(a)
       RETURN DISTINCT a.id, a.name
       LIMIT ${maxCycles * 5}`
    );

    // Group cycle participants
    if (rows.length === 0) return [];

    // For each node in a cycle, trace one cycle path
    const cycles: CycleResult[] = [];
    const visited = new Set<string>();

    for (const row of rows) {
      if (visited.has(row['a.id']) || cycles.length >= maxCycles) break;

      const pathRows = await this.q<{ name: string; id: string }>(
        // TRAIL + inline 'calls' pruning (see detectCycles main query). Project
        // `nodes(p)` rather than `p` — Kuzu's binder rejects a bare recursive
        // path in WITH when the rel has an inline predicate.
        `MATCH p = (a:CodeNode {id: '${esc(row['a.id'])}'})-[e:CodeEdge*TRAIL 1..10 (r, _ | WHERE r.edge_type = 'calls')]->(a)
         WITH nodes(p) AS ns, length(p) AS depth
         ORDER BY depth LIMIT 1
         UNWIND ns AS n
         RETURN n.id AS id, n.name AS name`
      );

      if (pathRows.length > 0) {
        const ids = pathRows.map(r => r.id);
        const names = pathRows.map(r => r.name);
        ids.forEach(id => visited.add(id));

        cycles.push({
          path: ids,
          nodeNames: names,
          length: ids.length - 1
        });
      }
    }

    return cycles;
  }

  /**
   * Get graph metrics for a specific node.
   */
  /**
   * Degree metrics for MANY nodes in two grouped queries (incoming and
   * outgoing edges by type), instead of getMetrics()'s nine queries per node.
   *
   * Semantic search called getMetrics() in a loop for every vector hit (50)
   * and every keyword hit (up to 50): ~900 sequential Kuzu queries per search,
   * five projects per RLM tool call, three calls at once — the "keyword"
   * leg alone measured 0.7–1.4s per project. Now it is 2 queries per project.
   *
   * `depth` (containment depth, a recursive query) is NOT computed here — no
   * search path reads it; callers that need it use getMetrics() for one node.
   */
  async getMetricsBatch(nodeIds: string[]): Promise<Map<string, GraphMetrics>> {
    const out = new Map<string, GraphMetrics>();
    const ids = [...new Set(nodeIds.filter(Boolean))];
    if (ids.length === 0) return out;
    const zero = (id: string): GraphMetrics => ({
      nodeId: id, incomingEdgeCount: 0, outgoingEdgeCount: 0, callerCount: 0, calleeCount: 0,
      containsCount: 0, usedByCount: 0, extendsCount: 0, implementsCount: 0, depth: 0,
    });
    for (const id of ids) out.set(id, zero(id));
    const CHUNK = 300;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const list = ids.slice(i, i + CHUNK).map(id => `'${esc(id)}'`).join(', ');
      const [inRows, outRows] = await Promise.all([
        this.q<{ id: string; t: string; c: number }>(
          `MATCH ()-[e:CodeEdge]->(n:CodeNode) WHERE n.id IN [${list}] RETURN n.id AS id, e.edge_type AS t, count(e) AS c`,
        ),
        this.q<{ id: string; t: string; c: number }>(
          `MATCH (n:CodeNode)-[e:CodeEdge]->() WHERE n.id IN [${list}] RETURN n.id AS id, e.edge_type AS t, count(e) AS c`,
        ),
      ]);
      for (const r of inRows) {
        const m = out.get(r.id); if (!m) continue;
        const c = Number(r.c) || 0;
        m.incomingEdgeCount += c;
        if (r.t === 'calls') m.callerCount += c;
        else if (r.t === 'uses') m.usedByCount += c;
        else if (r.t === 'extends') m.extendsCount += c;
        else if (r.t === 'implements') m.implementsCount += c;
      }
      for (const r of outRows) {
        const m = out.get(r.id); if (!m) continue;
        const c = Number(r.c) || 0;
        m.outgoingEdgeCount += c;
        if (r.t === 'calls') m.calleeCount += c;
        else if (r.t === 'contains') m.containsCount += c;
      }
    }
    return out;
  }

  async getMetrics(nodeId: string): Promise<GraphMetrics> {
    // Run all degree queries in parallel
    const [
      inRows, outRows,
      callerRows, calleeRows, containsRows,
      usedByRows, extendsRows, implementsRows,
      depthRows
    ] = await Promise.all([
      this.q<{ c: number }>(
        `MATCH ()-[e:CodeEdge]->(n:CodeNode {id: '${esc(nodeId)}'}) RETURN count(e) AS c`
      ),
      this.q<{ c: number }>(
        `MATCH (n:CodeNode {id: '${esc(nodeId)}'})-[e:CodeEdge]->() RETURN count(e) AS c`
      ),
      this.q<{ c: number }>(
        `MATCH ()-[e:CodeEdge {edge_type: 'calls'}]->(n:CodeNode {id: '${esc(nodeId)}'}) RETURN count(e) AS c`
      ),
      this.q<{ c: number }>(
        `MATCH (n:CodeNode {id: '${esc(nodeId)}'})-[e:CodeEdge {edge_type: 'calls'}]->() RETURN count(e) AS c`
      ),
      this.q<{ c: number }>(
        `MATCH (n:CodeNode {id: '${esc(nodeId)}'})-[e:CodeEdge {edge_type: 'contains'}]->() RETURN count(e) AS c`
      ),
      this.q<{ c: number }>(
        `MATCH ()-[e:CodeEdge {edge_type: 'uses'}]->(n:CodeNode {id: '${esc(nodeId)}'}) RETURN count(e) AS c`
      ),
      this.q<{ c: number }>(
        `MATCH ()-[e:CodeEdge {edge_type: 'extends'}]->(n:CodeNode {id: '${esc(nodeId)}'}) RETURN count(e) AS c`
      ),
      this.q<{ c: number }>(
        `MATCH ()-[e:CodeEdge {edge_type: 'implements'}]->(n:CodeNode {id: '${esc(nodeId)}'}) RETURN count(e) AS c`
      ),
      // Containment depth. CRITICAL: filter edge_type INSIDE the recursive
      // expansion, not in a post-hoc WHERE. The old form `[:CodeEdge*0..10]`
      // followed by `WHERE ALL(r IN rels(p) WHERE r.edge_type='contains')`
      // expanded over ALL edge types first — enumerating every path up to
      // length 10 through the cyclic call graph — and only THEN filtered to
      // 'contains'. For hub nodes (high fan-in like `Buf`/`resolve`) that path
      // explosion exhausts the 24 MiB per-project buffer pool ("buffer pool is
      // full and no memory could be freed"), which is what broke `ask`/
      // project_overview on central nodes. The inline relationship predicate
      // `(r, _ | WHERE r.edge_type='contains')` prunes DURING traversal, so it
      // only ever walks the shallow contains tree — 2 ms vs OOM, same answer.
      this.q<{ depth: number }>(
        `MATCH p = (:CodeNode)-[:CodeEdge*0..10 (r, _ | WHERE r.edge_type = 'contains')]->(n:CodeNode {id: '${esc(nodeId)}'})
         RETURN length(p) AS depth
         ORDER BY depth DESC LIMIT 1`
      ),
    ]);

    return {
      nodeId,
      incomingEdgeCount: inRows[0]?.c ?? 0,
      outgoingEdgeCount: outRows[0]?.c ?? 0,
      callerCount: callerRows[0]?.c ?? 0,
      calleeCount: calleeRows[0]?.c ?? 0,
      containsCount: containsRows[0]?.c ?? 0,
      usedByCount: usedByRows[0]?.c ?? 0,
      extendsCount: extendsRows[0]?.c ?? 0,
      implementsCount: implementsRows[0]?.c ?? 0,
      depth: depthRows[0]?.depth ?? 0,
    };
  }

  /**
   * Get top N most-called functions in a project.
   */
  async getMostCalledFunctions(
    projectId: number,
    limit = 10
  ): Promise<Array<{ id: string; name: string; qualifiedName: string; callerCount: number }>> {
    const rows = await this.q<{
      'n.id': string;
      'n.name': string;
      'n.qualified_name': string;
      caller_count: number;
    }>(
      `MATCH ()-[e:CodeEdge {edge_type: 'calls'}]->(n:CodeNode {project_id: ${projectId}})
       RETURN n.id, n.name, n.qualified_name, count(e) AS caller_count
       ORDER BY caller_count DESC
       LIMIT ${limit}`
    );

    return rows.map(r => ({
      id: r['n.id'],
      name: r['n.name'],
      qualifiedName: r['n.qualified_name'],
      callerCount: Number(r.caller_count)
    }));
  }

  /**
   * Get top N functions with most outgoing calls.
   */
  async getMostComplexFunctions(
    projectId: number,
    limit = 10
  ): Promise<Array<{ id: string; name: string; qualifiedName: string; calleeCount: number }>> {
    const rows = await this.q<{
      'n.id': string;
      'n.name': string;
      'n.qualified_name': string;
      callee_count: number;
    }>(
      `MATCH (n:CodeNode {project_id: ${projectId}})-[e:CodeEdge {edge_type: 'calls'}]->()
       RETURN n.id, n.name, n.qualified_name, count(e) AS callee_count
       ORDER BY callee_count DESC
       LIMIT ${limit}`
    );

    return rows.map(r => ({
      id: r['n.id'],
      name: r['n.name'],
      qualifiedName: r['n.qualified_name'],
      calleeCount: Number(r.callee_count)
    }));
  }

  /**
   * Compute strongly connected components (SCCs) using Tarjan's algorithm.
   * LadybugDB doesn't have built-in SCC — we fetch edges and compute in JS.
   */
  async getStronglyConnectedComponents(
    projectId: number,
    minSize = 2
  ): Promise<Array<{ id: number; size: number; nodes: Array<{ id: string; name: string; qualifiedName: string }> }>> {
    // Fetch all call edges for the project
    const nodes = await this.q<{ id: string; name: string; qn: string }>(
      `MATCH (n:CodeNode {project_id: ${projectId}})
       RETURN n.id AS id, n.name AS name, n.qualified_name AS qn`
    );

    const edges = await this.q<{ src: string; dst: string }>(
      `MATCH (a:CodeNode {project_id: ${projectId}})-[e:CodeEdge {edge_type: 'calls'}]->(b:CodeNode)
       RETURN a.id AS src, b.id AS dst`
    );

    const n = nodes.length;
    if (n === 0) return [];

    // Build adjacency
    const nodeIndex = new Map<string, number>();
    const indexNode = new Map<number, string>();
    nodes.forEach((nd, i) => { nodeIndex.set(nd.id, i); indexNode.set(i, nd.id); });

    const adj: number[][] = Array.from({ length: n }, () => []);
    for (const edge of edges) {
      const from = nodeIndex.get(edge.src);
      const to = nodeIndex.get(edge.dst);
      if (from !== undefined && to !== undefined) adj[from].push(to);
    }

    // Tarjan's
    const ids = new Array(n).fill(-1);
    const low = new Array(n).fill(0);
    const onStack = new Array(n).fill(false);
    const stack: number[] = [];
    let idCounter = 0;
    const sccs: number[][] = [];

    function dfs(at: number) {
      ids[at] = low[at] = idCounter++;
      stack.push(at);
      onStack[at] = true;

      for (const to of adj[at]) {
        if (ids[to] === -1) dfs(to);
        if (onStack[to]) low[at] = Math.min(low[at], low[to]);
      }

      if (ids[at] === low[at]) {
        const scc: number[] = [];
        while (true) {
          const node = stack.pop()!;
          onStack[node] = false;
          scc.push(node);
          if (node === at) break;
        }
        if (scc.length >= minSize) sccs.push(scc);
      }
    }

    for (let i = 0; i < n; i++) {
      if (ids[i] === -1) dfs(i);
    }

    const nodeMap = new Map(nodes.map(nd => [nd.id, nd]));
    return sccs.map((scc, idx) => ({
      id: idx + 1,
      size: scc.length,
      nodes: scc.map(i => {
        const nd = nodeMap.get(indexNode.get(i)!)!;
        return { id: nd.id, name: nd.name, qualifiedName: nd.qn };
      })
    }));
  }

  /**
   * Compute PageRank scores.
   * Fetches graph structure from LadybugDB, computes in JS.
   */
  async getPageRank(
    projectId: number,
    iterations = 20,
    dampingFactor = 0.85,
    limit = 20
  ): Promise<Array<{ id: string; name: string; qualifiedName: string; pageRank: number }>> {
    const nodes = await this.q<{ id: string; name: string; qn: string }>(
      `MATCH (n:CodeNode {project_id: ${projectId}})
       RETURN n.id AS id, n.name AS name, n.qualified_name AS qn`
    );

    const edges = await this.q<{ src: string; dst: string }>(
      `MATCH (a:CodeNode {project_id: ${projectId}})-[e:CodeEdge {edge_type: 'calls'}]->(b:CodeNode)
       RETURN a.id AS src, b.id AS dst`
    );

    const n = nodes.length;
    if (n === 0) return [];

    const nodeIndex = new Map<string, number>();
    nodes.forEach((nd, i) => nodeIndex.set(nd.id, i));

    const outDegree = new Array(n).fill(0);
    const incoming: number[][] = Array.from({ length: n }, () => []);

    for (const edge of edges) {
      const from = nodeIndex.get(edge.src);
      const to = nodeIndex.get(edge.dst);
      if (from !== undefined && to !== undefined) {
        outDegree[from]++;
        incoming[to].push(from);
      }
    }

    let pr = new Array(n).fill(1 / n);
    const d = dampingFactor;

    for (let iter = 0; iter < iterations; iter++) {
      const newPr = new Array(n).fill((1 - d) / n);
      for (let i = 0; i < n; i++) {
        for (const j of incoming[i]) {
          if (outDegree[j] > 0) newPr[i] += d * pr[j] / outDegree[j];
        }
      }
      pr = newPr;
    }

    const results = nodes.map((nd, i) => ({
      id: nd.id, name: nd.name, qualifiedName: nd.qn, pageRank: pr[i]
    }));
    results.sort((a, b) => b.pageRank - a.pageRank);
    return results.slice(0, limit);
  }

  /**
   * Compute betweenness centrality.
   */
  async getBetweennessCentrality(
    projectId: number,
    sampleSize = 100,
    limit = 20
  ): Promise<Array<{ id: string; name: string; qualifiedName: string; centrality: number }>> {
    const nodes = await this.q<{ id: string; name: string; qn: string }>(
      `MATCH (n:CodeNode {project_id: ${projectId}})
       RETURN n.id AS id, n.name AS name, n.qualified_name AS qn`
    );

    const edges = await this.q<{ src: string; dst: string }>(
      `MATCH (a:CodeNode {project_id: ${projectId}})-[e:CodeEdge {edge_type: 'calls'}]->(b:CodeNode)
       RETURN a.id AS src, b.id AS dst`
    );

    const n = nodes.length;
    if (n === 0) return [];

    const nodeIndex = new Map<string, number>();
    nodes.forEach((nd, i) => nodeIndex.set(nd.id, i));

    const adj: number[][] = Array.from({ length: n }, () => []);
    for (const edge of edges) {
      const from = nodeIndex.get(edge.src);
      const to = nodeIndex.get(edge.dst);
      if (from !== undefined && to !== undefined) adj[from].push(to);
    }

    const centrality = new Array(n).fill(0);
    const sampleNodes = n <= sampleSize
      ? Array.from({ length: n }, (_, i) => i)
      : Array.from({ length: sampleSize }, () => Math.floor(Math.random() * n));

    for (const source of sampleNodes) {
      const dist = new Array(n).fill(-1);
      const sigma = new Array(n).fill(0);
      const pred: number[][] = Array.from({ length: n }, () => []);

      dist[source] = 0;
      sigma[source] = 1;
      const queue = [source];
      const stack: number[] = [];

      while (queue.length > 0) {
        const v = queue.shift()!;
        stack.push(v);
        for (const w of adj[v]) {
          if (dist[w] < 0) { dist[w] = dist[v] + 1; queue.push(w); }
          if (dist[w] === dist[v] + 1) { sigma[w] += sigma[v]; pred[w].push(v); }
        }
      }

      const delta = new Array(n).fill(0);
      while (stack.length > 0) {
        const w = stack.pop()!;
        for (const v of pred[w]) {
          delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w]);
        }
        if (w !== source) centrality[w] += delta[w];
      }
    }

    const scale = sampleNodes.length < n ? n / sampleNodes.length : 1;
    for (let i = 0; i < n; i++) centrality[i] *= scale;

    const results = nodes.map((nd, i) => ({
      id: nd.id, name: nd.name, qualifiedName: nd.qn, centrality: centrality[i]
    }));
    results.sort((a, b) => b.centrality - a.centrality);
    return results.slice(0, limit);
  }
  // ============================================
  // Node Lookup Methods (replaces Prisma metadata queries)
  // ============================================

  /**
   * Find a node by its qualified name.
   */
  async getNodeByQualifiedName(
    qualifiedName: string,
    projectId?: number
  ): Promise<{
    id: string;
    name: string;
    qualifiedName: string;
    nodeType: string;
    filePath: string;
    lineStart: number;
    signature: string | null;
    documentation: string | null;
  } | null> {
    const projectFilter = projectId ? `, project_id: ${projectId}` : '';
    const rows = await this.q<{
      id: string; name: string; qn: string; nt: string;
      fp: string; ls: number; sig: string; doc: string;
    }>(
      `MATCH (n:CodeNode {qualified_name: '${esc(qualifiedName)}'${projectFilter}})
       RETURN n.id AS id, n.name AS name, n.qualified_name AS qn, n.node_type AS nt,
              n.file_path AS fp, n.line_start AS ls, n.signature AS sig, n.documentation AS doc
       LIMIT 1`
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id, name: r.name, qualifiedName: r.qn, nodeType: r.nt,
      filePath: r.fp, lineStart: Number(r.ls),
      signature: r.sig || null, documentation: r.doc || null
    };
  }

  /**
   * Find nodes matching a pattern in their qualified name.
   */
  async findNodesByPattern(
    pattern: string,
    projectId?: number,
    limit: number = 20
  ): Promise<Array<{
    id: string;
    name: string;
    qualifiedName: string;
    nodeType: string;
    filePath: string;
  }>> {
    const projectFilter = projectId ? ` AND n.project_id = ${projectId}` : '';
    const rows = await this.q<{
      id: string; name: string; qn: string; nt: string; fp: string;
    }>(
      `MATCH (n:CodeNode)
       WHERE n.qualified_name CONTAINS '${esc(pattern)}'${projectFilter}
       RETURN n.id AS id, n.name AS name, n.qualified_name AS qn, n.node_type AS nt, n.file_path AS fp
       ORDER BY n.name ASC
       LIMIT ${limit}`
    );
    return rows.map(r => ({
      id: r.id, name: r.name, qualifiedName: r.qn, nodeType: r.nt, filePath: r.fp
    }));
  }

  /**
   * Find nodes by a list of IDs.
   */
  async findNodesByIds(
    ids: string[]
  ): Promise<Array<{
    id: string;
    name: string;
    qualifiedName: string;
    filePath: string;
    lineStart: number;
  }>> {
    if (ids.length === 0) return [];
    // Use OR conditions since LadybugDB may not support IN
    const conditions = ids.map(id => `n.id = '${id}'`).join(' OR ');
    const rows = await this.q<{
      id: string; name: string; qn: string; fp: string; ls: number;
    }>(
      `MATCH (n:CodeNode)
       WHERE ${conditions}
       RETURN n.id AS id, n.name AS name, n.qualified_name AS qn, n.file_path AS fp, n.line_start AS ls`
    );
    return rows.map(r => ({
      id: r.id, name: r.name, qualifiedName: r.qn, filePath: r.fp, lineStart: Number(r.ls)
    }));
  }
  // ============================================
  // AST Viewer Methods
  // ============================================

  /**
   * Get all function/method/constructor/field nodes for a project.
   * Used by AST viewer to list all functions.
   */
  async getNodesByProject(
    projectId: number,
    nodeTypes: string[] = ['method', 'field', 'constructor', 'function']
  ): Promise<Array<{
    id: string; name: string; qualifiedName: string; nodeType: string;
    filePath: string; lineStart: number; lineEnd: number;
    signature: string | null; returnType: string | null;
    documentation: string | null; parentType: string | null;
    modifiers: string | null; language: string | null;
    isPublic: boolean; isStatic: boolean; isAbstract: boolean;
    isVirtual: boolean; isOverride: boolean;
  }>> {
    const typeConditions = nodeTypes.map(t => `n.node_type = '${esc(t)}'`).join(' OR ');
    const rows = await this.q<{
      id: string; name: string; qn: string; nt: string;
      fp: string; ls: number; le: number;
      sig: string; rt: string; doc: string; pt: string;
      mods: string; lang: string;
      pub: boolean; stat: boolean; abs: boolean;
      virt: boolean; ovr: boolean;
    }>(
      `MATCH (n:CodeNode {project_id: ${projectId}})
       WHERE ${typeConditions}
       RETURN n.id AS id, n.name AS name, n.qualified_name AS qn, n.node_type AS nt,
              n.file_path AS fp, n.line_start AS ls, n.line_end AS le,
              n.signature AS sig, n.return_type AS rt, n.documentation AS doc,
              n.parent_type AS pt, n.modifiers AS mods, n.language AS lang,
              n.is_public AS pub, n.is_static AS stat, n.is_abstract AS abs,
              n.is_virtual AS virt, n.is_override AS ovr
       ORDER BY n.parent_type ASC, n.name ASC`
    );

    return rows.map(r => ({
      id: r.id,
      name: r.name,
      qualifiedName: r.qn,
      nodeType: r.nt,
      filePath: r.fp,
      lineStart: Number(r.ls) || 0,
      lineEnd: Number(r.le) || 0,
      signature: r.sig || null,
      returnType: r.rt || null,
      documentation: r.doc || null,
      parentType: r.pt || null,
      modifiers: r.mods || null,
      language: r.lang || null,
      isPublic: !!r.pub,
      isStatic: !!r.stat,
      isAbstract: !!r.abs,
      isVirtual: !!r.virt,
      isOverride: !!r.ovr,
    }));
  }

  /**
   * Get all type-level nodes (class, mixin, enum, facet, type) for a project.
   * Used by AST viewer to list types.
   */
  async getTypesByProject(
    projectId: number
  ): Promise<Array<{
    id: string; name: string; qualifiedName: string; nodeType: string;
    filePath: string; lineStart: number;
    documentation: string | null; modifiers: string | null;
    language: string | null;
    isPublic: boolean; isAbstract: boolean;
  }>> {
    const rows = await this.q<{
      id: string; name: string; qn: string; nt: string;
      fp: string; ls: number;
      doc: string; mods: string; lang: string;
      pub: boolean; abs: boolean;
    }>(
      `MATCH (n:CodeNode {project_id: ${projectId}})
       WHERE n.node_type = 'class' OR n.node_type = 'mixin' OR n.node_type = 'enum' OR n.node_type = 'facet' OR n.node_type = 'type'
       RETURN n.id AS id, n.name AS name, n.qualified_name AS qn, n.node_type AS nt,
              n.file_path AS fp, n.line_start AS ls,
              n.documentation AS doc, n.modifiers AS mods, n.language AS lang,
              n.is_public AS pub, n.is_abstract AS abs
       ORDER BY n.name ASC`
    );

    return rows.map(r => ({
      id: r.id,
      name: r.name,
      qualifiedName: r.qn,
      nodeType: r.nt,
      filePath: r.fp,
      lineStart: Number(r.ls) || 0,
      documentation: r.doc || null,
      modifiers: r.mods || null,
      language: r.lang || null,
      isPublic: !!r.pub,
      isAbstract: !!r.abs,
    }));
  }

  /**
   * Get type relationships (extends/implements edges) for a project's type nodes.
   */
  async getTypeRelationships(
    projectId: number
  ): Promise<Array<{
    sourceId: string; targetName: string; edgeType: string;
  }>> {
    const rows = await this.q<{
      sid: string; tname: string; et: string;
    }>(
      `MATCH (s:CodeNode {project_id: ${projectId}})-[e:CodeEdge]->(t:CodeNode)
       WHERE e.edge_type = 'extends' OR e.edge_type = 'implements'
       RETURN s.id AS sid, t.name AS tname, e.edge_type AS et`
    );

    return rows.map(r => ({
      sourceId: r.sid,
      targetName: r.tname,
      edgeType: r.et,
    }));
  }
}

// ============================================
// Factory — per-project + legacy
// ============================================

let legacyInstance: LadybugQueryManager | null = null;
const projectInstances = new Map<number, LadybugQueryManager>();

/**
 * Cross-language edges within a single project (e.g. axon function calling
 * a fantom method). Returns each edge with source/target qualifiedNames so
 * the dashboard can render the call without a second lookup.
 */
export async function getCrossLanguageEdges(
  projectId: number,
  opts: { sourceLang?: string; targetLang?: string; limit?: number } = {},
): Promise<Array<{
  edgeType: string; sourceQn: string; sourceLang: string;
  targetQn: string; targetLang: string; lineNumber: number | null;
}>> {
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000));
  const filters: string[] = [`e.cross_language = true`];
  if (opts.sourceLang) filters.push(`a.language = '${opts.sourceLang.replace(/'/g, "''")}'`);
  if (opts.targetLang) filters.push(`b.language = '${opts.targetLang.replace(/'/g, "''")}'`);
  const where = filters.join(' AND ');
  const rows = await ladybugQuery<{
    et: string; sqn: string; sl: string; tqn: string; tl: string; ln: number | null;
  }>(
    projectId,
    `MATCH (a:CodeNode)-[e:CodeEdge]->(b:CodeNode)
     WHERE ${where}
     RETURN e.edge_type AS et,
            a.qualified_name AS sqn, a.language AS sl,
            b.qualified_name AS tqn, b.language AS tl,
            e.line_number AS ln
     LIMIT ${limit}`,
  );
  return rows.map(r => ({
    edgeType: r.et,
    sourceQn: r.sqn, sourceLang: r.sl,
    targetQn: r.tqn, targetLang: r.tl,
    lineNumber: r.ln,
  }));
}

/**
 * Get a query manager bound to a project (`projectId` set) or the legacy
 * shared-DB instance (no arg). Both are cached for the lifetime of the
 * process; pass `resetLadybugQueryManager()` to clear.
 */
export function getLadybugQueryManager(projectId?: number): LadybugQueryManager {
  if (projectId !== undefined) {
    let pm = projectInstances.get(projectId);
    if (!pm) {
      pm = new LadybugQueryManager(projectId);
      projectInstances.set(projectId, pm);
    }
    return pm;
  }
  if (!legacyInstance) legacyInstance = new LadybugQueryManager();
  return legacyInstance;
}

export function resetLadybugQueryManager(): void {
  legacyInstance = null;
  projectInstances.clear();
}
