/**
 * FlexSearch-based search index for Fantom functions
 */

import FlexSearch from 'flexsearch';
import type {
  FantomFunction,
  FantomTypeDef,
  FantomProject,
  FunctionSearchOptions,
  FunctionSearchResult,
  FantomCategory
} from './types.js';
import { isVersionCompatible } from './types.js';
import { FantomCodeIndexer } from './indexer.js';

// Type for FlexSearch Document
interface FlexSearchDocument {
  id: string;
  name: string;
  qualifiedName: string;
  className: string;
  description: string;
  documentation: string;
  signature: string;
  sourceCode: string;
  category: string;
  tags: string;
  returnType: string;
  /** Directory segments + file stem of filePath ("src rete types"), so
   *  library/directory names such as "rete" are searchable. */
  pathTokens: string;
  projectId: number;
}

/**
 * FlexSearch-based search for Fantom functions
 */
// Instance info for version filtering
interface InstanceInfo {
  id: number;
  name: string;
  type: string;
  version?: string;
}

export class FantomFunctionSearchIndex {
  private index: FlexSearch.Document<FlexSearchDocument>;
  private functions: Map<string, FantomFunction>;
  private projects: Map<number, FantomProject>;
  private instances: Map<number, InstanceInfo>;

  constructor() {
    this.functions = new Map();
    this.projects = new Map();
    this.instances = new Map();

    // Create FlexSearch Document index
    // Using 'as any' to bypass strict FlexSearch type checking
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.index = new FlexSearch.Document<FlexSearchDocument>({
      document: {
        id: 'id',
        index: [
          { field: 'name', tokenize: 'forward', resolution: 9 },
          { field: 'qualifiedName', tokenize: 'forward', resolution: 8 },
          { field: 'className', tokenize: 'forward', resolution: 7 },
          { field: 'description', tokenize: 'forward', resolution: 5 },
          { field: 'documentation', tokenize: 'forward', resolution: 4 },
          { field: 'signature', tokenize: 'forward', resolution: 6 },
          { field: 'sourceCode', tokenize: 'forward', resolution: 3 },
          { field: 'category', tokenize: 'strict' },
          { field: 'tags', tokenize: 'strict' },
          { field: 'returnType', tokenize: 'strict' },
          { field: 'pathTokens', tokenize: 'forward', resolution: 7 }
        ],
        store: true
      },
      cache: 100,
      optimize: true,
      context: true
    } as any);
  }

  /** "…/src/rete/types.ts" → "src rete types". Drops the project root prefix
   *  (everything up to the last "src|fan|lib|app|packages" segment when present)
   *  so tokens describe the file's place in the project, not the machine. */
  static pathTokensFor(filePath: string | undefined): string {
    if (!filePath) return '';
    const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
    const stem = (parts.pop() ?? '').replace(/\.[^.]+$/, '');
    const anchors = new Set(['src', 'fan', 'lib', 'app', 'packages', 'components', 'pages']);
    let start = 0;
    for (let i = parts.length - 1; i >= 0; i--) { if (anchors.has(parts[i])) { start = i; break; } }
    const segs = parts.slice(start).concat(stem ? [stem] : []);
    // Also split camelCase / kebab stems so "SedonaStateService" → "sedona state service".
    const extra = stem.split(/[-_]|(?<=[a-z0-9])(?=[A-Z])/).filter(x => x.length > 2).map(x => x.toLowerCase());
    return [...new Set([...segs.map(x => x.toLowerCase()), ...extra])].join(' ');
  }

  /**
   * Add a type definition (class / mixin / enum / interface) to the index so
   * search_symbols finds types, not only functions. Stored as a
   * FantomFunction-shaped record with category 'type'.
   */
  addTypeDef(t: FantomTypeDef): void {
    const asFn = {
      id: t.id,
      projectId: t.projectId,
      name: t.name,
      qualifiedName: t.qualifiedName,
      className: t.name,
      description: `${t.kind} ${t.name}` + (t.extends ? ` extends ${t.extends}` : ''),
      documentation: t.documentation ?? '',
      signature: `${t.kind} ${t.name}` + (t.mixins?.length ? ` : ${t.mixins.join(', ')}` : ''),
      sourceCode: '',
      category: 'type',
      tags: [t.kind, ...(t.facets ?? [])],
      returnType: '',
      filePath: t.filePath,
      lineStart: t.lineNumber ?? 0,
      lineNumber: t.lineNumber ?? 0,
      isPublic: t.isPublic,
      parameters: [],
    } as unknown as FantomFunction;
    this.add(asFn);
  }

  /**
   * Add a function to the search index
   */
  add(func: FantomFunction): void {
    this.functions.set(func.id, func);

    const doc: FlexSearchDocument = {
      id: func.id,
      name: func.name,
      qualifiedName: func.qualifiedName,
      className: func.className || '',
      description: func.description || '',
      documentation: func.documentation || '',
      signature: func.signature || '',
      sourceCode: func.sourceCode || '',
      category: func.category,
      tags: func.tags.join(' '),
      returnType: func.returnType || '',
      pathTokens: FantomFunctionSearchIndex.pathTokensFor((func as { filePath?: string }).filePath),
      projectId: func.projectId
    };

    this.index.add(doc);
  }

  /**
   * Remove a function from the index
   */
  remove(funcId: string): void {
    this.functions.delete(funcId);
    this.index.remove(funcId);
  }

  /**
   * Search for functions
   * @param query - Search query (can be multiple words)
   * @param options - Search options including useOrLogic (default: true)
   */
  /**
   * Library-name normaliser: people write "retejs", "rete.js", "vuejs"; code
   * and paths say "rete", "vue". When a query yields nothing, retry with the
   * js suffix stripped from each token. Returns null when nothing changes.
   */
  private static normalizeLibraryTokens(query: string): string | null {
    const out = query
      .split(/\s+/)
      .map(t => t.replace(/\.?js$/i, '').replace(/[-_.]js$/i, ''))
      .filter(Boolean)
      .join(' ');
    return out && out !== query ? out : null;
  }

  search(query: string, options?: FunctionSearchOptions): FunctionSearchResult[] {
    const primary = this.searchRaw(query, options);
    if (primary.length > 0) return primary;
    const alt = FantomFunctionSearchIndex.normalizeLibraryTokens(query);
    return alt ? this.searchRaw(alt, options) : primary;
  }

  private searchRaw(query: string, options?: FunctionSearchOptions): FunctionSearchResult[] {
    const limit = options?.limit || 20;
    const useOrLogic = options?.useOrLogic ?? true; // Default to OR logic
    // FlexSearch is queried GLOBALLY and the projectId/category/... filters are
    // applied afterwards. With ~180k indexed symbols a `limit*3` global cut
    // routinely contained zero rows from the requested project (common words
    // like "rete", "state" are dominated by other projects), so a scoped query
    // came back empty. Pull a much deeper candidate pool whenever a filter is
    // in play; the post-filter + scoring below trims it back to `limit`.
    const hasFilter = options?.projectId !== undefined || options?.instanceId !== undefined
      || options?.podId !== undefined || options?.category !== undefined || options?.type !== undefined
      || options?.className !== undefined || options?.isPublic !== undefined || !!options?.compatibleWith;
    const innerLimit = hasFilter ? Math.max(limit * 3, 2000) : limit * 3;

    // Collect unique results with scores
    const resultMap = new Map<string, { score: number; fields: string[] }>();

    if (useOrLogic) {
      // OR logic: search each word separately and combine results
      const words = query.trim().split(/\s+/).filter(w => w.length > 0);

      for (const word of words) {
        const searchResults = this.index.search(word, {
          limit: innerLimit, // Get more results for scoring (deeper when a filter applies)
          enrich: true
        });

        for (const fieldResult of searchResults) {
          const field = fieldResult.field;
          if (fieldResult.result) {
            for (let i = 0; i < fieldResult.result.length; i++) {
              const item = fieldResult.result[i];
              const id = typeof item === 'object' && item !== null ? (item as { id: string }).id : String(item);
              const existingScore = resultMap.get(id)?.score || 0;
              // Score based on position and field importance
              const fieldScore = this.getFieldWeight(field) * (1 - i / fieldResult.result.length);
              resultMap.set(id, {
                score: existingScore + fieldScore,
                fields: [...(resultMap.get(id)?.fields || []), field]
              });
            }
          }
        }
      }
    } else {
      // AND logic: search the entire query as-is (original behavior)
      const searchResults = this.index.search(query, {
        limit: limit * 3, // Get more results for scoring
        enrich: true
      });

      for (const fieldResult of searchResults) {
        const field = fieldResult.field;
        if (fieldResult.result) {
          for (let i = 0; i < fieldResult.result.length; i++) {
            const item = fieldResult.result[i];
            const id = typeof item === 'object' && item !== null ? (item as { id: string }).id : String(item);
            const existingScore = resultMap.get(id)?.score || 0;
            // Score based on position and field importance
            const fieldScore = this.getFieldWeight(field) * (1 - i / fieldResult.result.length);
            resultMap.set(id, {
              score: existingScore + fieldScore,
              fields: [...(resultMap.get(id)?.fields || []), field]
            });
          }
        }
      }
    }

    // Convert to results array
    let results: FunctionSearchResult[] = [];

    // Parse query words for smarter scoring
    const queryWords = query.toLowerCase().trim().split(/\s+/).filter(w => w.length > 0);
    const queryLower = query.toLowerCase();

    for (const [id, data] of resultMap) {
      const func = this.functions.get(id);
      if (!func) continue;

      // Apply filters. projectId is coerced to Number on both sides because
      // hydrateIndexerFromLadybug can populate funcs with a stringified id
      // (Cypher returns BigInt → toString) while the MCP handler passes a
      // raw number. A strict !== silently skipped every result for valid
      // projectIds — see round-6 report.
      const fnPid = Number((func as any).projectId);
      if (options?.projectId !== undefined && fnPid !== Number(options.projectId)) continue;
      if (options?.category && func.category !== options.category) continue;
      if (options?.type && func.type !== options.type) continue;
      if (options?.className && func.className !== options.className) continue;
      if (options?.isPublic !== undefined && func.isPublic !== options.isPublic) continue;

      // Filter by instanceId - get project and check its instanceId
      if (options?.instanceId !== undefined) {
        const project = this.projects.get(fnPid) ?? this.projects.get(func.projectId);
        if (!project || project.instanceId !== options.instanceId) continue;
      }

      // Filter by podId - podId refers to a project ID that represents a specific pod
      if (options?.podId !== undefined && fnPid !== Number(options.podId)) continue;

      // Filter by version compatibility - check if the project's instance version is compatible
      if (options?.compatibleWith) {
        const project = this.projects.get(func.projectId);
        if (project?.instanceId) {
          const instance = this.instances.get(project.instanceId);
          if (instance?.version && !isVersionCompatible(instance.version, options.compatibleWith)) {
            continue;
          }
        }
      }

      // Calculate final score with relevance boosts
      let score = data.score;

      const nameLower = func.name.toLowerCase();
      const classNameLower = (func.className || '').toLowerCase();
      const descLower = (func.description || '').toLowerCase();

      // Boost exact name matches (highest priority)
      if (nameLower === queryLower) {
        score += 15;
      } else if (nameLower.startsWith(queryLower)) {
        score += 8;
      } else if (nameLower.includes(queryLower)) {
        score += 4;
      }

      // Boost for multiple query word matches (smarter OR logic scoring)
      if (queryWords.length > 1) {
        let wordMatches = 0;
        for (const word of queryWords) {
          if (nameLower.includes(word) || classNameLower.includes(word) || descLower.includes(word)) {
            wordMatches++;
          }
        }
        // Bonus for matching multiple words (more matches = higher score)
        score += wordMatches * 2;
        // Extra bonus if all words match
        if (wordMatches === queryWords.length) {
          score += 5;
        }
      }

      // Boost for matches in multiple fields (indicates higher relevance)
      const uniqueFields = new Set(data.fields);
      if (uniqueFields.size > 1) {
        score += uniqueFields.size * 0.5;
      }

      // Boost matches in high-value fields
      if (data.fields.includes('name')) score += 2;
      if (data.fields.includes('qualifiedName')) score += 1.5;
      if (data.fields.includes('signature')) score += 1;

      // Boost public functions (more likely to be what user wants)
      if (func.isPublic) {
        score += 1;
      }

      // Boost methods over fields (usually more relevant for searches)
      if (func.type === 'method') {
        score += 0.5;
      }

      results.push({
        function: func,
        score,
        matchedFields: data.fields
      });
    }

    // Sort by score and limit
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * Search with filters
   */
  searchWithFilters(
    query: string,
    filters: {
      project?: string;
      category?: FantomCategory;
      className?: string;
      isPublic?: boolean;
      hasReturnType?: string;
    }
  ): FunctionSearchResult[] {
    // First, get all matching functions
    const results = this.search(query, { limit: 1000 });

    // Then filter
    return results.filter(result => {
      const func = result.function;

      if (filters.category && func.category !== filters.category) return false;
      if (filters.className && func.className !== filters.className) return false;
      if (filters.isPublic !== undefined && func.isPublic !== filters.isPublic) return false;
      if (filters.hasReturnType && func.returnType !== filters.hasReturnType) return false;

      return true;
    });
  }

  /**
   * Get field weight for scoring
   */
  private getFieldWeight(field: string): number {
    const weights: Record<string, number> = {
      name: 1.0,
      qualifiedName: 0.9,
      className: 0.8,
      signature: 0.7,
      description: 0.6,
      documentation: 0.5,
      returnType: 0.4,
      tags: 0.3,
      category: 0.3,
      sourceCode: 0.2,
      pathTokens: 1.0,
    };
    return weights[field] || 0.1;
  }

  /**
   * Clear the index
   */
  clear(): void {
    this.functions.clear();
    this.projects.clear();
    this.instances.clear();
    // Recreate the index
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.index = new FlexSearch.Document<FlexSearchDocument>({
      document: {
        id: 'id',
        index: [
          { field: 'name', tokenize: 'forward', resolution: 9 },
          { field: 'qualifiedName', tokenize: 'forward', resolution: 8 },
          { field: 'className', tokenize: 'forward', resolution: 7 },
          { field: 'description', tokenize: 'forward', resolution: 5 },
          { field: 'documentation', tokenize: 'forward', resolution: 4 },
          { field: 'signature', tokenize: 'forward', resolution: 6 },
          { field: 'sourceCode', tokenize: 'forward', resolution: 3 },
          { field: 'category', tokenize: 'strict' },
          { field: 'tags', tokenize: 'strict' },
          { field: 'returnType', tokenize: 'strict' },
          { field: 'pathTokens', tokenize: 'forward', resolution: 7 }
        ],
        store: true
      },
      cache: 100,
      optimize: true,
      context: true
    } as any);
  }

  /**
   * Rebuild the index from the code indexer
   */
  rebuild(indexer: FantomCodeIndexer): void {
    this.clear();

    // Store projects for instanceId filtering
    const projects = indexer.getProjects();
    for (const project of projects) {
      this.projects.set(project.id, project);
    }

    const functions = indexer.getAllFunctions();
    for (const func of functions) {
      this.add(func);
    }
    // Types too (classes, mixins, interfaces, enums): previously only functions
    // were searchable, so a TS interface like SedonaStateResponse or a Fantom
    // mixin was invisible to search_symbols (RLM log: hits=0).
    for (const t of indexer.getAllTypes()) {
      if (!this.functions.has(t.id)) this.addTypeDef(t);
    }
  }

  /**
   * Get a project by ID
   */
  getProject(projectId: number): FantomProject | undefined {
    return this.projects.get(projectId);
  }

  /**
   * Get total number of indexed functions
   */
  get size(): number {
    return this.functions.size;
  }

  /**
   * Get a function by ID (for enriching search results)
   */
  getFunction(id: string): FantomFunction | undefined {
    return this.functions.get(id);
  }

  /**
   * Set instance info for version filtering
   */
  setInstance(id: number, info: InstanceInfo): void {
    this.instances.set(id, info);
  }

  /**
   * Get instance info by ID
   */
  getInstance(id: number): InstanceInfo | undefined {
    return this.instances.get(id);
  }

  /**
   * Get all instances
   */
  getAllInstances(): InstanceInfo[] {
    return Array.from(this.instances.values());
  }

  /**
   * Get projects filtered by version compatibility
   */
  getProjectsCompatibleWith(version: string): FantomProject[] {
    const compatibleProjects: FantomProject[] = [];

    for (const project of this.projects.values()) {
      if (project.instanceId) {
        const instance = this.instances.get(project.instanceId);
        if (instance?.version && !isVersionCompatible(instance.version, version)) {
          continue;
        }
      }
      compatibleProjects.push(project);
    }

    return compatibleProjects;
  }
}

// Singleton instance
let searchIndexInstance: FantomFunctionSearchIndex | null = null;

/**
 * Get the singleton search index instance
 */
export function getFantomFunctionSearchIndex(): FantomFunctionSearchIndex {
  if (!searchIndexInstance) {
    searchIndexInstance = new FantomFunctionSearchIndex();
  }
  return searchIndexInstance;
}

/**
 * Reset the singleton instance
 */
export function resetFantomFunctionSearchIndex(): void {
  if (searchIndexInstance) {
    searchIndexInstance.clear();
    searchIndexInstance = null;
  }
}
