# Fantom Code Parser & MCP Explorer Implementation Plan

## Overview

This document outlines the implementation of a comprehensive Fantom code parsing and indexing system that mirrors the Axon MCP server's functionality. The goal is to parse Fantom code from local projects, index it with FlexSearch, and make it available through MCP tools.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Fantom MCP Server                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────┐     ┌──────────────────┐     ┌────────────────────┐   │
│  │  FileScanner    │────▶│  FantomCodeParser │────▶│  FantomCodeIndex   │   │
│  │  (*.fan files)  │     │  (AST + Metadata) │     │  (In-Memory Store) │   │
│  └─────────────────┘     └──────────────────┘     └─────────┬──────────┘   │
│          │                        │                         │              │
│          ▼                        ▼                         ▼              │
│  ┌─────────────────┐     ┌──────────────────┐     ┌────────────────────┐   │
│  │  Pod Discovery  │     │  Category/Tag    │     │  FlexSearch        │   │
│  │  (build.fan)    │     │  Classification  │     │  Function Index    │   │
│  └─────────────────┘     └──────────────────┘     └────────────────────┘   │
│                                                             │              │
│  ┌─────────────────────────────────────────────────────────┼──────────────┤
│  │                    Cache Layer                           │              │
│  │  ┌──────────────────┐  ┌──────────────────────────────┐ │              │
│  │  │ Global Cache     │  │ Project-Specific Cache       │ │              │
│  │  │ fantom-code.json │  │ fantom-code-{inst}-{proj}.json│              │
│  │  └──────────────────┘  └──────────────────────────────┘ │              │
│  └─────────────────────────────────────────────────────────┴──────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┤
│  │                    MCP Tools                                             │
│  │  • searchFantomCode      • getFantomFunction                            │
│  │  • analyzeFantomProject  • findFunctionUsage                            │
│  │  • listProjectFunctions  • getFunctionDependencies                      │
│  └─────────────────────────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────────────────────┘
```

## Database Schema Additions

### Table: `projects`
```sql
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  instance_id INTEGER,
  pod_meta TEXT,  -- JSON: dependencies, version from build.fan
  last_indexed TEXT,
  function_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE SET NULL
);
```

### Table: `functions`
```sql
CREATE TABLE functions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,  -- e.g., "myPod::MyClass.myMethod"
  type TEXT NOT NULL,  -- 'method', 'field', 'constructor'
  class_name TEXT,
  file_path TEXT NOT NULL,
  line_number INTEGER,
  signature TEXT,
  return_type TEXT,
  parameters TEXT,  -- JSON array of {name, type}
  description TEXT,
  documentation TEXT,
  source_code TEXT,
  category TEXT,
  tags TEXT,  -- JSON array
  is_public INTEGER DEFAULT 1,
  is_static INTEGER DEFAULT 0,
  is_abstract INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(project_id, qualified_name)
);
```

### Table: `type_definitions`
```sql
CREATE TABLE type_definitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  type TEXT NOT NULL,  -- 'class', 'mixin', 'enum', 'facet'
  file_path TEXT NOT NULL,
  line_number INTEGER,
  extends TEXT,
  mixins TEXT,  -- JSON array
  facets TEXT,  -- JSON array
  documentation TEXT,
  is_public INTEGER DEFAULT 1,
  is_abstract INTEGER DEFAULT 0,
  is_final INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(project_id, qualified_name)
);
```

### Table: `dependencies`
```sql
CREATE TABLE dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  depends_on TEXT NOT NULL,  -- Pod name
  version TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
```

## TypeScript Interfaces

```typescript
// src/fantom-code/types.ts

export type FunctionType = 'method' | 'field' | 'constructor';
export type TypeDefKind = 'class' | 'mixin' | 'enum' | 'facet';

export interface FantomFunction {
  id: string;  // MD5 hash of path + qualifiedName
  projectId: number;
  name: string;
  qualifiedName: string;
  type: FunctionType;
  className?: string;
  filePath: string;
  lineNumber?: number;
  signature?: string;
  returnType?: string;
  parameters?: Parameter[];
  description?: string;
  documentation?: string;
  sourceCode?: string;
  category?: FantomCategory;
  tags: string[];
  isPublic: boolean;
  isStatic: boolean;
  isAbstract: boolean;
}

export interface Parameter {
  name: string;
  type: string;
  defaultValue?: string;
}

export interface FantomTypeDef {
  id: string;
  projectId: number;
  name: string;
  qualifiedName: string;
  kind: TypeDefKind;
  filePath: string;
  lineNumber?: number;
  extends?: string;
  mixins: string[];
  facets: string[];
  documentation?: string;
  isPublic: boolean;
  isAbstract: boolean;
  isFinal: boolean;
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
}

export interface PodMeta {
  podName: string;
  version?: string;
  description?: string;
  dependencies: string[];
  srcDirs: string[];
}

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

export interface FantomCodeIndex {
  functions: Map<string, FantomFunction>;
  types: Map<string, FantomTypeDef>;
  byProject: Map<number, string[]>;  // projectId -> function IDs
  byCategory: Map<FantomCategory, string[]>;
  byTag: Map<string, string[]>;
  lastUpdated: Date;
}
```

## Implementation Modules

### 1. File Scanner (`src/fantom-code/scanner.ts`)

```typescript
/**
 * Scans directories for Fantom source files
 */
export class FantomFileScanner {
  /**
   * Scan a directory recursively for .fan files
   */
  async scanDirectory(path: string, options?: ScanOptions): Promise<ScanResult>;

  /**
   * Discover project structure from build.fan
   */
  async discoverProject(buildFanPath: string): Promise<PodMeta>;

  /**
   * Watch for file changes (for incremental updates)
   */
  watchDirectory(path: string, callback: FileChangeCallback): FSWatcher;
}

interface ScanOptions {
  excludeDirs?: string[];
  includePatterns?: string[];
  maxDepth?: number;
}

interface ScanResult {
  files: string[];
  projectMeta?: PodMeta;
  scanTime: number;
}
```

### 2. Build.fan Parser (`src/fantom-code/buildParser.ts`)

```typescript
/**
 * Parses build.fan files to extract pod metadata
 */
export class BuildFanParser {
  /**
   * Parse build.fan and extract pod configuration
   */
  parse(content: string): PodMeta;

  /**
   * Extract dependencies from depends = [...] statement
   */
  extractDependencies(content: string): string[];

  /**
   * Extract source directories
   */
  extractSrcDirs(content: string): string[];

  /**
   * Extract pod name and version
   */
  extractPodInfo(content: string): { name: string; version?: string };
}
```

### 3. Enhanced Code Parser (`src/fantom-code/codeParser.ts`)

```typescript
/**
 * Wraps the existing fantom-parser with additional metadata extraction
 */
export class FantomCodeParser {
  private parser: Parser;  // From src/fantom-parser

  /**
   * Parse a single .fan file into structured data
   */
  parseFile(filePath: string, content: string): ParsedFile;

  /**
   * Extract all types from an AST
   */
  extractTypes(ast: CompilationUnit): FantomTypeDef[];

  /**
   * Extract all methods/fields from a type
   */
  extractMembers(typeDef: TypeDef): FantomFunction[];

  /**
   * Extract documentation from facets and comments
   */
  extractDocumentation(node: ASTNode): string | undefined;

  /**
   * Categorize a function based on its context
   */
  categorize(func: FantomFunction, projectMeta?: PodMeta): FantomCategory;

  /**
   * Generate tags based on function content and context
   */
  generateTags(func: FantomFunction): string[];
}

interface ParsedFile {
  filePath: string;
  types: FantomTypeDef[];
  functions: FantomFunction[];
  imports: string[];
  errors: ParseError[];
}
```

### 4. Code Indexer (`src/fantom-code/indexer.ts`)

```typescript
/**
 * Manages the in-memory index of Fantom code
 */
export class FantomCodeIndexer {
  private index: FantomCodeIndex;
  private db: FantomDatabase;

  /**
   * Index a single project
   */
  async indexProject(project: FantomProject): Promise<IndexResult>;

  /**
   * Index all registered projects
   */
  async indexAll(): Promise<IndexResult[]>;

  /**
   * Add a function to the index
   */
  addFunction(func: FantomFunction): void;

  /**
   * Add a type definition to the index
   */
  addType(type: FantomTypeDef): void;

  /**
   * Remove all entries for a project (before re-indexing)
   */
  clearProject(projectId: number): void;

  /**
   * Get index statistics
   */
  getStats(): IndexStats;

  /**
   * Persist index to database
   */
  async persist(): Promise<void>;

  /**
   * Load index from database
   */
  async load(): Promise<void>;
}

interface IndexResult {
  projectId: number;
  projectName: string;
  functionsIndexed: number;
  typesIndexed: number;
  errors: string[];
  duration: number;
}
```

### 5. FlexSearch Function Index (`src/fantom-code/searchIndex.ts`)

```typescript
/**
 * FlexSearch-based search for Fantom functions
 */
export class FantomFunctionSearchIndex {
  private index: FlexSearch.Document<FantomFunction>;

  constructor() {
    this.index = new FlexSearch.Document({
      document: {
        id: 'id',
        index: [
          { field: 'name', tokenize: 'forward', resolution: 9 },
          { field: 'qualifiedName', tokenize: 'forward', resolution: 8 },
          { field: 'className', tokenize: 'forward', resolution: 7 },
          { field: 'description', tokenize: 'forward', context: { depth: 2, bidirectional: true } },
          { field: 'documentation', tokenize: 'forward', context: { depth: 2, bidirectional: true } },
          { field: 'signature', tokenize: 'forward', resolution: 6 },
          { field: 'sourceCode', tokenize: 'forward', resolution: 3 },
          { field: 'category', tokenize: 'strict' },
          { field: 'tags', tokenize: 'strict' },
          { field: 'returnType', tokenize: 'strict' }
        ],
        store: ['name', 'qualifiedName', 'className', 'filePath', 'lineNumber', 'signature', 'category']
      },
      cache: true,
      optimize: true,
      context: true
    });
  }

  /**
   * Add a function to the search index
   */
  add(func: FantomFunction): void;

  /**
   * Search for functions
   */
  search(query: string, options?: SearchOptions): SearchResult[];

  /**
   * Search with filters
   */
  searchWithFilters(query: string, filters: SearchFilters): SearchResult[];

  /**
   * Clear the index
   */
  clear(): void;

  /**
   * Rebuild the index from the code indexer
   */
  rebuild(indexer: FantomCodeIndexer): void;
}

interface SearchOptions {
  limit?: number;
  projectId?: number;
  category?: FantomCategory;
  type?: FunctionType;
}

interface SearchFilters {
  project?: string;
  category?: FantomCategory;
  className?: string;
  isPublic?: boolean;
  hasReturnType?: string;
}
```

### 6. Cache Manager Extension (`src/fantom-code/codeCache.ts`)

```typescript
/**
 * Manages caching for Fantom code index
 */
export class FantomCodeCache {
  private cacheDir: string;

  /**
   * Save project-specific cache
   */
  async saveProjectCache(project: FantomProject, data: CacheData): Promise<void>;

  /**
   * Load project-specific cache
   */
  async loadProjectCache(project: FantomProject): Promise<CacheData | null>;

  /**
   * Check if cache is valid
   */
  isCacheValid(project: FantomProject, maxAge?: number): boolean;

  /**
   * Invalidate cache for a project
   */
  invalidateProject(projectId: number): void;

  /**
   * Get cache metadata
   */
  getCacheMetadata(project: FantomProject): CacheMetadata | null;
}

interface CacheData {
  version: string;
  projectPath: string;
  lastModified: string;
  functions: FantomFunction[];
  types: FantomTypeDef[];
}

interface CacheMetadata {
  version: string;
  projectPath: string;
  lastModified: string;
  functionCount: number;
  typeCount: number;
}
```

## Initialization Flow

```
Server Start
  │
  ├─ 1. Load Configuration
  │     └─ Read fantom-config.json for codePath, cache settings
  │
  ├─ 2. Initialize Databases
  │     ├─ Usage database (existing)
  │     └─ Fantom database (instances, pods, projects, functions)
  │
  ├─ 3. Background Code Indexing (non-blocking)
  │     │
  │     ├─ 3.1 Load Registered Projects from DB
  │     │     └─ SELECT * FROM projects
  │     │
  │     ├─ 3.2 For Each Project:
  │     │     │
  │     │     ├─ Check Cache Validity
  │     │     │   └─ If valid → Load from cache
  │     │     │   └─ If invalid → Continue to scan
  │     │     │
  │     │     ├─ Scan Directory for .fan files
  │     │     │   └─ FantomFileScanner.scanDirectory()
  │     │     │
  │     │     ├─ Parse build.fan
  │     │     │   └─ BuildFanParser.parse()
  │     │     │
  │     │     ├─ Parse Each .fan File
  │     │     │   └─ FantomCodeParser.parseFile()
  │     │     │
  │     │     ├─ Index Functions & Types
  │     │     │   └─ FantomCodeIndexer.addFunction/addType()
  │     │     │
  │     │     └─ Save to Cache
  │     │         └─ FantomCodeCache.saveProjectCache()
  │     │
  │     ├─ 3.3 Build FlexSearch Index
  │     │     └─ FantomFunctionSearchIndex.rebuild()
  │     │
  │     └─ 3.4 Mark Initialization Complete
  │
  └─ 4. Ready for Tool Calls
        └─ Tools wait for initializationPromise if needed
```

## MCP Tools

### New Tools to Add

| Tool | Description |
|------|-------------|
| `searchFantomCode` | Search indexed Fantom functions by name, signature, or content |
| `getFantomFunction` | Get detailed function info including source code |
| `listProjectFunctions` | List all functions in a project with filtering |
| `analyzeFantomProject` | Analyze a project's structure, dependencies, and statistics |
| `findFunctionUsage` | Find where a function is called across projects |
| `getFunctionDependencies` | Get functions that a function depends on |
| `addFantomProject` | Register a new project for indexing |
| `refreshProjectIndex` | Re-index a specific project |

### Tool Schemas

```typescript
// searchFantomCode
{
  name: 'searchFantomCode',
  description: 'Search indexed Fantom functions by name, signature, documentation, or source code content',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      project: { type: 'string', description: 'Filter by project name' },
      category: { type: 'string', enum: Object.values(FantomCategory) },
      type: { type: 'string', enum: ['method', 'field', 'constructor'] },
      className: { type: 'string', description: 'Filter by class name' },
      limit: { type: 'number', default: 20 }
    },
    required: ['query']
  }
}

// getFantomFunction
{
  name: 'getFantomFunction',
  description: 'Get detailed information about a specific Fantom function',
  inputSchema: {
    type: 'object',
    properties: {
      qualifiedName: { type: 'string', description: 'Fully qualified function name (e.g., myPod::MyClass.myMethod)' },
      includeSource: { type: 'boolean', default: true }
    },
    required: ['qualifiedName']
  }
}

// addFantomProject
{
  name: 'addFantomProject',
  description: 'Register a new Fantom project directory for code indexing',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Full path to project directory containing build.fan' },
      name: { type: 'string', description: 'Project name (auto-detected from build.fan if not provided)' },
      instanceId: { type: 'number', description: 'Associated Fantom instance ID' }
    },
    required: ['path']
  }
}
```

## Admin API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/projects` | List all registered projects |
| GET | `/admin/projects/:id` | Get project details with stats |
| POST | `/admin/projects` | Register a new project |
| DELETE | `/admin/projects/:id` | Remove a project from indexing |
| POST | `/admin/projects/:id/reindex` | Trigger re-indexing |
| GET | `/admin/projects/:id/functions` | List functions in a project |
| GET | `/admin/code/search` | Search code via REST API |
| GET | `/admin/code/stats` | Get overall code index statistics |

## Dashboard Pages

### Projects Page (`/projects`)
- List all registered Fantom projects
- Show indexing status, function counts
- Add/remove projects
- Trigger re-indexing
- View project dependencies

### Code Explorer Page (`/code`)
- Search bar with FlexSearch
- Filter by project, category, type
- Function list with signatures
- Click to view full source code
- Syntax highlighting for Fantom code

## Configuration

```json
// fantom-config.json additions
{
  "codeIndexing": {
    "enabled": true,
    "autoDiscover": true,
    "watchForChanges": false,
    "excludeDirs": ["test", "build", ".git", "node_modules"],
    "maxFileSizeMb": 5,
    "cache": {
      "enabled": true,
      "maxAge": 86400000
    }
  }
}
```

## Implementation Phases

### Phase 1: Core Infrastructure
1. Create database schema additions
2. Implement FantomFileScanner
3. Implement BuildFanParser
4. Create FantomCodeParser (integrate existing fantom-parser)

### Phase 2: Indexing & Search
1. Implement FantomCodeIndexer
2. Implement FantomFunctionSearchIndex
3. Implement FantomCodeCache
4. Add project registration to FantomDatabase

### Phase 3: MCP Tools
1. Add searchFantomCode tool
2. Add getFantomFunction tool
3. Add listProjectFunctions tool
4. Add addFantomProject tool
5. Add refreshProjectIndex tool

### Phase 4: Admin API & Dashboard
1. Add project management endpoints
2. Add code search endpoint
3. Create Projects dashboard page
4. Create Code Explorer page

### Phase 5: Advanced Features
1. File watching for incremental updates
2. Function usage tracking
3. Dependency analysis
4. Cross-project search

## Example Paths from Requirements

Based on the user's environment:

**Instances:**
- `~/skyspark/skyspark-3.1.12` (SkySpark instance)

**Pods to Index:**
- `~/Code/myPod`
- `~/Code/MileSight/bassgmilesight/bassgMilesightExt`

These will be automatically discovered and indexed at boot time if registered as projects.
