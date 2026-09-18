/**
 * Graph Types for Code Intelligence
 *
 * These types mirror the Prisma schema and provide
 * convenient interfaces for graph operations.
 */

// ============================================
// Node Types
// ============================================

export type NodeType =
  | 'type'        // generic type (legacy/fallback)
  | 'class'       // class definition
  | 'mixin'       // mixin definition
  | 'enum'        // enum definition
  | 'facet'       // facet definition
  | 'function'    // top-level function
  | 'method'      // class method
  | 'field'       // class field
  | 'constructor' // constructor
  | 'parameter';  // function parameter

export type Language =
  | 'fantom'
  | 'axon'
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'vue'
  | 'css'
  | 'unknown';

export interface CodeNodeCreate {
  projectId: number;
  nodeType: NodeType;
  name: string;
  qualifiedName: string;
  filePath: string;
  lineStart: number;
  lineEnd?: number;
  colStart?: number;
  colEnd?: number;
  signature?: string;
  documentation?: string;
  returnType?: string;
  modifiers?: string[];   // Will be JSON stringified
  facets?: string[];      // Will be JSON stringified
  parentType?: string;
  isPublic?: boolean;
  isStatic?: boolean;
  isAbstract?: boolean;
  isVirtual?: boolean;
  isOverride?: boolean;
  isExported?: boolean;
  language?: Language;
}

export interface CodeNodeData extends CodeNodeCreate {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================
// Edge Types
// ============================================

export type EdgeType =
  | 'calls'       // Function A calls function B
  | 'extends'     // Class extends parent
  | 'implements'  // Class implements mixin
  | 'contains'    // Type contains member
  | 'uses'        // Function uses type
  | 'returns'     // Function returns type
  | 'parameters'  // Function has param of type
  | 'overrides';  // Method overrides parent

export interface CodeEdgeCreate {
  sourceId: string;
  targetId: string;
  edgeType: EdgeType;
  lineNumber?: number;
  colNumber?: number;
  isResolved?: boolean;
  metadata?: Record<string, unknown>;  // Will be JSON stringified
}

export interface CodeEdgeData extends Omit<CodeEdgeCreate, 'metadata'> {
  id: string;
  metadata?: string;  // JSON string
  createdAt: Date;
}

// ============================================
// Unresolved Reference Types
// ============================================

export interface UnresolvedRefCreate {
  projectId: number;
  fromNodeId: string;
  referenceName: string;
  refType: EdgeType;
  lineNumber: number;
  colNumber?: number;
  candidates?: string[];  // Will be JSON stringified
}

export interface UnresolvedRefData extends Omit<UnresolvedRefCreate, 'candidates'> {
  id: string;
  candidates?: string;  // JSON string
  createdAt: Date;
}

// ============================================
// Graph Build Stats
// ============================================

export interface GraphBuildStatsData {
  id: string;
  projectId: number;
  nodeCount: number;
  edgeCount: number;
  unresolvedCount: number;
  vectorCount: number;
  lastBuildAt?: Date;
  lastVectorAt?: Date;
  buildDurationMs?: number;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================
// Query Result Types
// ============================================

export interface CallerResult {
  id: string;
  name: string;
  qualifiedName: string;
  depth: number;
  filePath: string;
  lineNumber?: number;
  edgeType: EdgeType;
  confidence?: number;
  isStatic?: boolean;
  isDynamic?: boolean;
  isConstructor?: boolean;
  callTarget?: string;
}

export interface CalleeResult {
  id: string;
  name: string;
  qualifiedName: string;
  depth: number;
  filePath: string;
  lineNumber?: number;
  confidence?: number;
  isStatic?: boolean;
  isDynamic?: boolean;
  isConstructor?: boolean;
  callTarget?: string;
}

export interface ImpactResult {
  focalNode: {
    id: string;
    name: string;
    qualifiedName: string;
  };
  affectedNodes: Array<{
    id: string;
    name: string;
    qualifiedName: string;
    edgeTypes: EdgeType[];
    minDepth: number;
    filePath: string;
  }>;
  totalAffected: number;
  maxDepthReached: number;
  breakdown: Record<EdgeType, number>;
}

export interface PathResult {
  found: boolean;
  path: Array<{
    id: string;
    name: string;
    qualifiedName: string;
  }>;
  edges: EdgeType[];
  depth: number;
}

export interface CycleResult {
  path: string[];
  nodeNames: string[];
  length: number;
}

export interface GraphMetrics {
  nodeId: string;
  incomingEdgeCount: number;
  outgoingEdgeCount: number;
  callerCount: number;
  calleeCount: number;
  containsCount: number;
  usedByCount: number;     // Incoming 'uses' edges (other nodes reference this type)
  extendsCount: number;    // Incoming 'extends' edges (subtypes)
  implementsCount: number; // Incoming 'implements' edges
  depth: number;  // Depth in containment hierarchy
}

// ============================================
// Build Result Types
// ============================================

export interface GraphBuildResult {
  projectId: number;
  success: boolean;
  nodeCount: number;
  edgeCount: number;
  unresolvedCount: number;
  durationMs: number;
  errors: string[];
}

export interface VectorBuildResult {
  projectId: number;
  success: boolean;
  vectorCount: number;
  skipped: number;
  durationMs: number;
  errors: string[];
}
