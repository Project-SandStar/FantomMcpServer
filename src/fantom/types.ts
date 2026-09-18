/**
 * Type definitions for Fantom Instance and Pod Management
 */

// Instance types
export type InstanceType = 'fantom' | 'skyspark' | 'haxall';

export interface FantomInstance {
  id: number;
  name: string;
  path: string;
  type: InstanceType;
  version?: string;
  fanExecutable: string;
  description?: string;
  sourcePath?: string; // For open-source instances (e.g., Haxall: {basePath}/src)
  fantomVersion?: string; // Fantom version used by this instance (e.g., "1.0.82")
  fantomSourcePath?: string; // Path to Fantom source (e.g., "~/fantom/fantom-1.0.82")
  docSourceInstanceId?: number; // For Haxall: reference to SkySpark instance for documentation
  isValid: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateInstanceInput {
  name: string;
  path: string;
  type?: InstanceType;
  version?: string;
  fanExecutable?: string;
  description?: string;
  sourcePath?: string; // For open-source instances (e.g., Haxall: {basePath}/src)
  fantomVersion?: string; // Fantom version used by this instance (e.g., "1.0.82")
  fantomSourcePath?: string; // Path to Fantom source
  docSourceInstanceId?: number; // For Haxall: reference to SkySpark instance for documentation
}

export interface UpdateInstanceInput {
  name?: string;
  path?: string;
  type?: InstanceType;
  version?: string;
  fanExecutable?: string;
  description?: string;
  sourcePath?: string; // For open-source instances (e.g., Haxall: {basePath}/src)
  fantomVersion?: string; // Fantom version used by this instance (e.g., "1.0.82")
  fantomSourcePath?: string; // Path to Fantom source
  docSourceInstanceId?: number | null; // For Haxall: reference to SkySpark instance for documentation (null to clear)
}

// Pod types
export interface FantomPod {
  id: number;
  name: string;
  path: string;
  buildFile: string;
  description?: string;
  defaultInstanceId?: number;
  compatMinVersion?: string;
  compatMaxVersion?: string;
  compatVersions?: string[];
  createdAt: string;
  updatedAt: string;
}

// Pod with instance info (for grouped display)
export interface FantomPodWithInstance extends FantomPod {
  instance?: {
    id: number;
    name: string;
    type: InstanceType;
    version?: string;
  };
}

// Pod with instance info and item counts (for listFantomPods)
export interface FantomPodWithCounts extends FantomPodWithInstance {
  counts: {
    docItems: number;      // Documentation items from DocIndex
    functions: number;     // Functions from FantomProject (if indexed as project)
    types: number;         // Types from FantomProject (if indexed as project)
  };
}

export interface CreatePodInput {
  name: string;
  path: string;
  buildFile?: string;
  description?: string;
  defaultInstanceId?: number;
  compatMinVersion?: string;
  compatMaxVersion?: string;
  compatVersions?: string[];
}

export interface UpdatePodInput {
  name?: string;
  path?: string;
  buildFile?: string;
  description?: string;
  defaultInstanceId?: number;
  compatMinVersion?: string;
  compatMaxVersion?: string;
  compatVersions?: string[];
}

// Compilation types
export type CompileStatus = 'success' | 'failure' | 'running';

export interface CompileLog {
  id: number;
  podId: number;
  instanceId: number;
  buildFile: string;
  status: CompileStatus;
  output?: string;
  error?: string;
  durationMs?: number;
  startedAt: string;
  completedAt?: string;
}

export interface CompileRequest {
  podId: number;
  instanceId?: number;  // Uses active instance if not specified
  buildFile?: string;   // Uses pod's default if not specified
}

export interface CompileResult {
  success: boolean;
  logId: number;
  output: string;
  error?: string;
  durationMs: number;
}

// Settings
export interface FantomInstanceSettings {
  activeInstanceId: number | null;
  lastCompiledPodId: number | null;
}

// Project types (for code indexing)
export interface FantomProjectRecord {
  id: number;
  name: string;
  path: string;
  instanceId?: number;
  buildId?: number;  // Link to FantomBuild for Fantom source pods
  podName?: string;
  description?: string;
  functionCount: number;
  typeCount: number;
  lastIndexed?: string;
  autoIndex: boolean;
  language?: string;
  parserType?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  name: string;
  path: string;
  instanceId?: number;
  podName?: string;
  description?: string;
  autoIndex?: boolean;
  language?: string;
  parserType?: string;
}

export interface UpdateProjectInput {
  name?: string;
  path?: string;
  instanceId?: number;
  podName?: string;
  description?: string;
  autoIndex?: boolean;
  language?: string;
  parserType?: string;
}

// Fantom Version types (for version detection and source linking)
export interface FantomVersion {
  version: string;           // e.g., "1.0.82"
  path: string;              // e.g., "~/fantom/fantom-1.0.82"
  hasSource: boolean;        // true if src/ directory exists
}

export interface DetectFantomVersionResult {
  detectedVersion: string | null;
  sourceAvailable: boolean;
  sourcePath: string | null;
}

// Fantom Build types (for Fantom source code indexing)
export interface FantomBuild {
  id: number;
  version: string;           // e.g., "1.0.82"
  path: string;              // e.g., "~/fantom/fantom-1.0.82"
  hasSource: boolean;        // true if src/ directory exists
  podCount: number;          // Number of pods indexed
  functionCount: number;     // Total functions indexed
  typeCount: number;         // Total types indexed
  lastIndexed?: string;
  isActive: boolean;         // Whether to include in indexing
  createdAt: string;
  updatedAt: string;
}

export interface CreateFantomBuildInput {
  version: string;
  path: string;
  hasSource?: boolean;
  isActive?: boolean;
}

export interface UpdateFantomBuildInput {
  path?: string;
  hasSource?: boolean;
  isActive?: boolean;
}

export interface FantomBuildIndexResult {
  success: boolean;
  buildId: number;
  version: string;
  podsIndexed: number;
  totalFunctions: number;
  totalTypes: number;
  duration: number;
  errors: string[];
  podStats: Array<{
    podName: string;
    projectId: number;
    functionsIndexed: number;
    typesIndexed: number;
  }>;
}
