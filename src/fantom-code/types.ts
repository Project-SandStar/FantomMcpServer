/**
 * Type definitions for Fantom code parsing and indexing
 */

import { createHash } from 'crypto';

// ============================================
// Enums
// ============================================

export type FunctionType = 'method' | 'field' | 'constructor';
export type TypeDefKind = 'class' | 'mixin' | 'enum' | 'facet';

export enum FantomCategory {
  CORE = 'core',
  IO = 'io',
  NET = 'net',
  CONCURRENT = 'concurrent',
  WEB = 'web',
  SQL = 'sql',
  GRAPHICS = 'graphics',
  UI = 'ui',
  HAXALL = 'haxall',
  SKYSPARK = 'skyspark',
  HAYSTACK = 'haystack',
  UTIL = 'util',
  TEST = 'test',
  OTHER = 'other'
}

// ============================================
// Core Interfaces
// ============================================

export interface Parameter {
  name: string;
  type: string;
  defaultValue?: string;
}

// ============================================
// Function Call Tracking
// ============================================

export interface FunctionCall {
  /** Simple name of the called function/method */
  calledName: string;
  /** Qualified name if resolved (e.g., "sys::Str.trim") */
  calledQualifiedName?: string;
  /** Reference to CodeNode ID if resolved */
  calleeNodeId?: string;
  /** Line number where the call occurs */
  lineNumber: number;
  /** Column number where the call occurs */
  colNumber?: number;
  /** True if this is a static call (Type.method) */
  isStatic: boolean;
  /** True if this uses dynamic dispatch (->) */
  isDynamic: boolean;
  /** True if this is a constructor call */
  isConstructor: boolean;
  /** The object/type the call is made on (e.g., "this", "str", "Str") */
  target?: string;
  /** Whether the callee has been resolved to a known function */
  resolved: boolean;
}

export interface FantomFunction {
  id: string;
  projectId: number;
  name: string;
  qualifiedName: string;
  type: FunctionType;
  className?: string;
  filePath: string;
  lineNumber?: number;
  /** Last line of the symbol's span (inclusive). Populated by tree-sitter
   *  (endPosition) and the Fantom regex parser (brace-matched body); absent
   *  means unknown and consumers fall back to a fixed window. */
  lineEnd?: number;
  signature?: string;
  returnType?: string;
  parameters: Parameter[];
  description?: string;
  documentation?: string;
  sourceCode?: string;
  category: FantomCategory;
  tags: string[];
  isPublic: boolean;
  isStatic: boolean;
  isAbstract: boolean;
  isOverride: boolean;
  isVirtual: boolean;
  facets: string[];
  /** Function calls made within this function's body */
  calls?: FunctionCall[];
  /** Cached count of functions that call this function */
  callerCount?: number;
}

export interface FantomTypeDef {
  id: string;
  projectId: number;
  name: string;
  qualifiedName: string;
  kind: TypeDefKind;
  filePath: string;
  lineNumber?: number;
  /** Last line of the type body (inclusive), when the parser knows it. */
  lineEnd?: number;
  extends?: string;
  mixins: string[];
  facets: string[];
  documentation?: string;
  isPublic: boolean;
  isAbstract: boolean;
  isFinal: boolean;
  isConst: boolean;
  methods: FantomFunction[];
  fields: FantomFunction[];
}

export interface FantomProject {
  id: number;
  name: string;
  path: string;
  instanceId?: number;
  podMeta?: PodMeta;
  lastIndexed?: string;
  functionCount: number;
  typeCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PodMeta {
  podName: string;
  version?: string;
  description?: string;
  dependencies: string[];
  srcDirs: string[];
  outPodDir?: string;
  docApi?: boolean;
  docSrc?: boolean;
}

// ============================================
// Index Types
// ============================================

export interface FantomCodeIndex {
  functions: Map<string, FantomFunction>;
  types: Map<string, FantomTypeDef>;
  byProject: Map<number, string[]>;
  byCategory: Map<FantomCategory, string[]>;
  byTag: Map<string, string[]>;
  byClass: Map<string, string[]>;
  lastUpdated: Date;
}

export interface IndexResult {
  projectId: number;
  projectName: string;
  functionsIndexed: number;
  typesIndexed: number;
  filesProcessed: number;
  errors: ParseError[];
  duration: number;
}

export interface IndexStats {
  totalFunctions: number;
  totalTypes: number;
  totalProjects: number;
  byCategory: Record<string, number>;
  byProject: Record<string, number>;
  lastUpdated: string;
}

// ============================================
// Scanner Types
// ============================================

export interface ScanOptions {
  excludeDirs?: string[];
  includePatterns?: string[];
  maxDepth?: number;
  followSymlinks?: boolean;
}

export interface ScanResult {
  files: string[];
  projectMeta?: PodMeta;
  scanTime: number;
  errors: string[];
}

// ============================================
// Parser Types
// ============================================

export interface ParsedFile {
  filePath: string;
  types: FantomTypeDef[];
  functions: FantomFunction[];
  imports: string[];
  usings: string[];
  errors: ParseError[];
}

export interface ParseError {
  file: string;
  line?: number;
  column?: number;
  message: string;
  severity: 'error' | 'warning';
}

// ============================================
// Cache Types
// ============================================

export interface CacheData {
  version: string;
  projectPath: string;
  lastModified: string;
  fileHashes: Record<string, string>;
  functions: FantomFunction[];
  types: FantomTypeDef[];
}

export interface CacheMetadata {
  version: string;
  projectPath: string;
  lastModified: string;
  functionCount: number;
  typeCount: number;
  fileCount: number;
}

// ============================================
// Search Types
// ============================================

export interface FunctionSearchOptions {
  limit?: number;
  projectId?: number;
  instanceId?: number;
  podId?: number;
  category?: FantomCategory;
  type?: FunctionType;
  className?: string;
  isPublic?: boolean;
  compatibleWith?: string;
  useOrLogic?: boolean;  // Use OR logic for multi-word queries (default: true)
}

export interface FunctionSearchResult {
  function: FantomFunction;
  score: number;
  matchedFields: string[];
}

// ============================================
// Utility Functions
// ============================================

/**
 * Generate a unique ID for a function based on path, qualified name, and line number.
 * Line number is included to disambiguate functions with identical qualified names
 * (e.g. anonymous functions or functions in files where podName is not set).
 */
export function generateFunctionId(filePath: string, qualifiedName: string, lineNumber?: number): string {
  const key = lineNumber != null
    ? `${filePath}:${qualifiedName}:${lineNumber}`
    : `${filePath}:${qualifiedName}`;
  return createHash('md5')
    .update(key)
    .digest('hex')
    .substring(0, 16);
}

/**
 * Generate a unique ID for a type definition
 */
export function generateTypeId(filePath: string, qualifiedName: string, lineNumber?: number): string {
  const key = lineNumber != null
    ? `${filePath}:${qualifiedName}:${lineNumber}`
    : `${filePath}:${qualifiedName}`;
  return createHash('md5')
    .update(key)
    .digest('hex')
    .substring(0, 16);
}

/**
 * Build a qualified name from pod, class, and member name
 */
export function buildQualifiedName(podName: string, className?: string, memberName?: string): string {
  // Drop the leading "::" when there is no namespace. Non-Fantom projects
  // were producing "::ClassName.method" because podName fell through as ''.
  const ns = podName ? `${podName}::` : '';
  if (!className) {
    return podName;
  }
  if (!memberName) {
    return `${ns}${className}`;
  }
  return `${ns}${className}.${memberName}`;
}

/**
 * Parse a qualified name into its parts
 */
export function parseQualifiedName(qualifiedName: string): {
  pod?: string;
  className?: string;
  memberName?: string;
} {
  const podSplit = qualifiedName.split('::');
  if (podSplit.length === 1) {
    return { pod: qualifiedName };
  }

  const pod = podSplit[0];
  const rest = podSplit[1];

  const memberSplit = rest.split('.');
  if (memberSplit.length === 1) {
    return { pod, className: rest };
  }

  return {
    pod,
    className: memberSplit[0],
    memberName: memberSplit.slice(1).join('.')
  };
}

/**
 * Format a method signature from parameters
 */
export function formatSignature(
  name: string,
  returnType?: string,
  parameters?: Parameter[]
): string {
  const params = parameters?.map(p => `${p.type} ${p.name}`).join(', ') || '';
  const ret = returnType || 'Void';
  return `${ret} ${name}(${params})`;
}

/**
 * Categorize a function based on its context and content
 */
export function categorizeFunction(
  func: Partial<FantomFunction>,
  podMeta?: PodMeta
): FantomCategory {
  const podName = podMeta?.podName?.toLowerCase() || '';
  const className = func.className?.toLowerCase() || '';
  const funcName = func.name?.toLowerCase() || '';
  const doc = func.documentation?.toLowerCase() || '';

  // Check pod name for known categories
  if (podName.includes('hx') || podName.includes('haxall')) return FantomCategory.HAXALL;
  if (podName.includes('sky') || podName.includes('skyspark')) return FantomCategory.SKYSPARK;
  if (podName.includes('haystack')) return FantomCategory.HAYSTACK;
  if (podName.includes('test') || funcName.startsWith('test')) return FantomCategory.TEST;

  // Check content
  if (funcName.includes('sql') || className.includes('sql') || doc.includes('database')) {
    return FantomCategory.SQL;
  }
  if (funcName.includes('web') || className.includes('web') || doc.includes('http')) {
    return FantomCategory.WEB;
  }
  if (funcName.includes('net') || className.includes('net') || doc.includes('socket')) {
    return FantomCategory.NET;
  }
  if (funcName.includes('io') || className.includes('io') || doc.includes('stream')) {
    return FantomCategory.IO;
  }
  if (funcName.includes('concurrent') || className.includes('actor') || doc.includes('thread')) {
    return FantomCategory.CONCURRENT;
  }
  if (funcName.includes('gfx') || className.includes('graphics') || doc.includes('image')) {
    return FantomCategory.GRAPHICS;
  }
  if (funcName.includes('fwt') || className.includes('widget') || doc.includes('window')) {
    return FantomCategory.UI;
  }
  if (podName.includes('util') || funcName.includes('util')) {
    return FantomCategory.UTIL;
  }
  if (['sys', 'std'].includes(podName)) {
    return FantomCategory.CORE;
  }

  return FantomCategory.OTHER;
}

/**
 * Compare two semantic versions
 * Returns: -1 if v1 < v2, 0 if equal, 1 if v1 > v2
 */
export function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split('.').map(p => parseInt(p, 10) || 0);
  const parts2 = v2.split('.').map(p => parseInt(p, 10) || 0);

  const maxLen = Math.max(parts1.length, parts2.length);

  for (let i = 0; i < maxLen; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;

    if (p1 < p2) return -1;
    if (p1 > p2) return 1;
  }

  return 0;
}

/**
 * Check if a version is compatible with a target version
 * A version is compatible if it is less than or equal to the target
 */
export function isVersionCompatible(version: string | undefined, targetVersion: string): boolean {
  if (!version) return true; // If no version specified, assume compatible
  return compareVersions(version, targetVersion) <= 0;
}

/**
 * Generate tags for a function based on its properties
 */
export function generateTags(func: Partial<FantomFunction>): string[] {
  const tags: string[] = [];

  // Add type tag
  if (func.type) {
    tags.push(func.type);
  }

  // Add visibility tags
  if (func.isPublic) tags.push('public');
  else tags.push('private');

  if (func.isStatic) tags.push('static');
  if (func.isAbstract) tags.push('abstract');
  if (func.isOverride) tags.push('override');
  if (func.isVirtual) tags.push('virtual');

  // Add category tag
  if (func.category) {
    tags.push(func.category);
  }

  // Add return type tag
  if (func.returnType && func.returnType !== 'Void') {
    tags.push(`returns:${func.returnType}`);
  }

  // Add facet tags
  if (func.facets) {
    for (const facet of func.facets) {
      tags.push(`facet:${facet}`);
    }
  }

  return tags;
}
