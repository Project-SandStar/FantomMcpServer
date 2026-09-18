/**
 * Types for local Fantom documentation parsing
 */

/**
 * A documentation item from local SkySpark/Fantom docs
 */
export interface LocalDocItem {
  id: string;
  name: string;
  qualifiedName: string;  // e.g., sys::Bool, func:abs
  type: 'type' | 'function' | 'tag' | 'slot' | 'example' | 'chapter';
  pod: string;
  signature?: string;
  description: string;
  url: string;           // file:// URL for local docs
  version?: string;      // SkySpark version (3.1.12, 4.0.4)
  instanceId: number;    // Link to Instance

  // Language classification
  language: 'fantom' | 'axon';  // axon for lib-axon functions
  runtime: 'fantom';            // Always fantom (axon runs on fantom)

  // Parent type for slots
  parent?: string;

  // Additional metadata
  metadata?: Record<string, string>;
  keywords: string[];
}

/**
 * Information about a pod in the documentation
 */
export interface PodInfo {
  name: string;
  path: string;
  category: 'core' | 'lib' | 'doc';  // sys vs lib-axon vs docLang
  fileCount: number;
  isAxonLib?: boolean;
}

/**
 * Result from scanning a doc directory
 */
export interface ScanResult {
  docPath: string;
  version?: string;
  instanceId: number;
  pods: PodInfo[];
  totalFiles: number;
}

/**
 * Result from parsing docs for an instance
 */
export interface ParseResult {
  instanceId: number;
  version?: string;
  items: LocalDocItem[];
  errors: string[];
  duration: number;
  podStats: Record<string, number>;
}

/**
 * Options for local doc parsing
 */
export interface LocalDocParseOptions {
  instanceId: number;
  pods?: string[];        // Specific pods to parse (all if empty)
  forceRefresh?: boolean; // Re-parse even if cached
}

/**
 * Options for searching local docs
 */
export interface LocalDocSearchOptions {
  instanceId?: number;    // Filter by instance
  instanceType?: 'skyspark' | 'haxall' | 'fantom';  // Filter by instance type
  pod?: string;           // Filter by pod
  type?: LocalDocItem['type'];
  language?: 'fantom' | 'axon';
  limit?: number;
}

/**
 * Search result with instance info
 */
export interface LocalDocSearchResult extends LocalDocItem {
  instanceName: string;
  instanceType: 'skyspark' | 'haxall' | 'fantom';
}
