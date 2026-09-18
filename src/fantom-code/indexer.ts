/**
 * Fantom Code Indexer - manages the in-memory index of Fantom functions and types
 */

import type {
  FantomFunction,
  FantomTypeDef,
  FantomProject,
  FantomCodeIndex,
  IndexResult,
  IndexStats,
  FantomCategory,
  ParseError
} from './types.js';
import { FantomFileScanner } from './scanner.js';
import { FantomCodeParser } from './codeParser.js';

/**
 * In-memory indexer for Fantom code
 */
export class FantomCodeIndexer {
  private index: FantomCodeIndex;
  private projects: Map<number, FantomProject>;

  constructor() {
    this.index = {
      functions: new Map(),
      types: new Map(),
      byProject: new Map(),
      byCategory: new Map(),
      byTag: new Map(),
      byClass: new Map(),
      lastUpdated: new Date()
    };
    this.projects = new Map();
  }

  /**
   * Index a single project.
   *
   * **Fantom-only.** This is the legacy regex pipeline; it scans every
   * extension the FantomFileScanner emits and applies a Fantom-syntax regex,
   * which silently produces garbage on TypeScript/PHP/etc. (~30 spurious
   * matches per repo from `async`-modifier method-like lines). If a non-Fantom
   * project lands here, refuse loudly so the regression is impossible to
   * miss; non-Fantom projects must go through `CodeIndexingService` (via
   * `runIndex`), which dispatches to tree-sitter.
   */
  async indexProject(project: FantomProject): Promise<IndexResult> {
    const projLang = ((project as unknown as { language?: string }).language || 'fantom').toLowerCase();
    if (projLang !== 'fantom') {
      throw new Error(
        `FantomCodeIndexer.indexProject is .fan-only — project ${project.id} (${project.name}) ` +
        `has language='${projLang}'. Route through CodeIndexingService/runIndex instead so ` +
        `tree-sitter dispatches correctly.`
      );
    }
    const startTime = Date.now();
    const errors: ParseError[] = [];
    let functionsIndexed = 0;
    let typesIndexed = 0;
    let filesProcessed = 0;

    // Clear existing project data
    this.clearProject(project.id);

    // Store project
    this.projects.set(project.id, project);

    // Scan for .fan files
    const scanner = new FantomFileScanner();
    const scanResult = await scanner.scanDirectory(project.path);

    if (scanResult.errors.length > 0) {
      for (const err of scanResult.errors) {
        errors.push({
          file: project.path,
          message: err,
          severity: 'warning'
        });
      }
    }

    // Use pod metadata from scan or project
    const podMeta = scanResult.projectMeta || project.podMeta;

    // Parse each file
    const parser = new FantomCodeParser(project.id, podMeta);

    for (const filePath of scanResult.files) {
      try {
        const parsed = parser.parseFile(filePath);
        filesProcessed++;

        // Index types
        for (const type of parsed.types) {
          this.addType(type);
          typesIndexed++;
        }

        // Index functions (methods and fields from types)
        for (const func of parsed.functions) {
          this.addFunction(func);
          functionsIndexed++;
        }

        // Collect parse errors
        errors.push(...parsed.errors);
      } catch (err) {
        errors.push({
          file: filePath,
          message: err instanceof Error ? err.message : String(err),
          severity: 'error'
        });
      }
    }

    // Update project stats
    project.functionCount = functionsIndexed;
    project.typeCount = typesIndexed;
    project.lastIndexed = new Date().toISOString();
    project.podMeta = podMeta;

    this.index.lastUpdated = new Date();

    return {
      projectId: project.id,
      projectName: project.name,
      functionsIndexed,
      typesIndexed,
      filesProcessed,
      errors,
      duration: Date.now() - startTime
    };
  }

  /**
   * Index multiple projects
   */
  async indexAll(projects: FantomProject[]): Promise<IndexResult[]> {
    const results: IndexResult[] = [];

    for (const project of projects) {
      const result = await this.indexProject(project);
      results.push(result);
    }

    return results;
  }

  /**
   * Add a function to the index
   */
  addFunction(func: FantomFunction): void {
    // Coerce projectId to Number on insert. The hydrate path
    // (CodeIndexingService.hydrateIndexerFromLadybug) can pass through
    // BigInt/string values from Kuzu; comparing those against numeric ids
    // in searchFantomCode silently fails every filter.
    if (func.projectId !== undefined && typeof func.projectId !== 'number') {
      func = { ...func, projectId: Number(func.projectId) };
    }

    // Check if this function ID already exists (prevent duplicates)
    const isNew = !this.index.functions.has(func.id);

    // Store in main map (overwrites if existing)
    this.index.functions.set(func.id, func);

    // Only add to index arrays if this is a new entry
    if (isNew) {
      // Index by project
      if (!this.index.byProject.has(func.projectId)) {
        this.index.byProject.set(func.projectId, []);
      }
      this.index.byProject.get(func.projectId)!.push(func.id);

      // Index by category
      if (!this.index.byCategory.has(func.category)) {
        this.index.byCategory.set(func.category, []);
      }
      this.index.byCategory.get(func.category)!.push(func.id);

      // Index by tags
      for (const tag of func.tags) {
        if (!this.index.byTag.has(tag)) {
          this.index.byTag.set(tag, []);
        }
        this.index.byTag.get(tag)!.push(func.id);
      }

      // Index by class
      if (func.className) {
        if (!this.index.byClass.has(func.className)) {
          this.index.byClass.set(func.className, []);
        }
        this.index.byClass.get(func.className)!.push(func.id);
      }
    }
  }

  /**
   * Add a type definition to the index
   */
  addType(type: FantomTypeDef): void {
    if (type.projectId !== undefined && typeof type.projectId !== 'number') {
      type = { ...type, projectId: Number(type.projectId) };
    }
    this.index.types.set(type.id, type);
  }

  /**
   * Remove in-memory entries for a specific subset of files within a project.
   * Used by reindexFiles before re-adding fresh parses for the same paths.
   */
  removeFilesFromProject(projectId: number, filePaths: string[]): void {
    const pathSet = new Set(filePaths);
    // Functions keyed in byProject — filter by filePath.
    const functionIds = this.index.byProject.get(projectId) || [];
    const remaining: string[] = [];
    for (const funcId of functionIds) {
      const func = this.index.functions.get(funcId);
      if (!func) continue;
      if (!pathSet.has(func.filePath)) {
        remaining.push(funcId);
        continue;
      }
      // Detach from secondary indices.
      const cat = this.index.byCategory.get(func.category);
      if (cat) {
        const i = cat.indexOf(funcId);
        if (i > -1) cat.splice(i, 1);
      }
      for (const tag of func.tags) {
        const tagFuncs = this.index.byTag.get(tag);
        if (tagFuncs) {
          const i = tagFuncs.indexOf(funcId);
          if (i > -1) tagFuncs.splice(i, 1);
        }
      }
      if (func.className) {
        const classFuncs = this.index.byClass.get(func.className);
        if (classFuncs) {
          const i = classFuncs.indexOf(funcId);
          if (i > -1) classFuncs.splice(i, 1);
        }
      }
      this.index.functions.delete(funcId);
    }
    if (remaining.length > 0) this.index.byProject.set(projectId, remaining);
    else this.index.byProject.delete(projectId);

    for (const [typeId, type] of this.index.types) {
      if (type.projectId === projectId && pathSet.has(type.filePath)) {
        this.index.types.delete(typeId);
      }
    }
  }

  /**
   * Remove all entries for a project
   */
  clearProject(projectId: number): void {
    // Get function IDs for this project
    const functionIds = this.index.byProject.get(projectId) || [];

    // Remove functions from all indices
    for (const funcId of functionIds) {
      const func = this.index.functions.get(funcId);
      if (func) {
        // Remove from category index
        const categoryFuncs = this.index.byCategory.get(func.category);
        if (categoryFuncs) {
          const idx = categoryFuncs.indexOf(funcId);
          if (idx > -1) categoryFuncs.splice(idx, 1);
        }

        // Remove from tag indices
        for (const tag of func.tags) {
          const tagFuncs = this.index.byTag.get(tag);
          if (tagFuncs) {
            const idx = tagFuncs.indexOf(funcId);
            if (idx > -1) tagFuncs.splice(idx, 1);
          }
        }

        // Remove from class index
        if (func.className) {
          const classFuncs = this.index.byClass.get(func.className);
          if (classFuncs) {
            const idx = classFuncs.indexOf(funcId);
            if (idx > -1) classFuncs.splice(idx, 1);
          }
        }

        // Remove from main map
        this.index.functions.delete(funcId);
      }
    }

    // Clear project mapping
    this.index.byProject.delete(projectId);

    // Remove types for this project
    for (const [typeId, type] of this.index.types) {
      if (type.projectId === projectId) {
        this.index.types.delete(typeId);
      }
    }

    // Remove project
    this.projects.delete(projectId);
  }

  /**
   * Get a function by ID
   */
  getFunction(id: string): FantomFunction | undefined {
    return this.index.functions.get(id);
  }

  /**
   * Get a function by qualified name
   */
  getFunctionByQualifiedName(qualifiedName: string): FantomFunction | undefined {
    // First pass: exact match (Fantom-style)
    for (const func of this.index.functions.values()) {
      if (func.qualifiedName === qualifiedName) return func;
    }
    // Second pass: tolerant match for non-Fantom projects where the stored
    // qualifiedName may use file path or project name as namespace, while the
    // caller passes "<projectName>::Class.method" or just "Class.method".
    // Strip any leading "<ns>::" and compare suffixes.
    const suffix = qualifiedName.includes('::')
      ? qualifiedName.split('::').slice(1).join('::')
      : qualifiedName;
    if (suffix !== qualifiedName) {
      for (const func of this.index.functions.values()) {
        const stored = func.qualifiedName.includes('::')
          ? func.qualifiedName.split('::').slice(1).join('::')
          : func.qualifiedName;
        if (stored === suffix) return func;
      }
    }
    // Third pass: bare "Class.method" against any stored "*::Class.method"
    for (const func of this.index.functions.values()) {
      if (func.qualifiedName.endsWith(`::${qualifiedName}`)) return func;
    }
    return undefined;
  }

  /**
   * Get a type by ID
   */
  getType(id: string): FantomTypeDef | undefined {
    return this.index.types.get(id);
  }

  /**
   * Get a type by qualified name
   */
  getTypeByQualifiedName(qualifiedName: string): FantomTypeDef | undefined {
    for (const type of this.index.types.values()) {
      if (type.qualifiedName === qualifiedName) return type;
    }
    // Tolerant match — same logic as getFunctionByQualifiedName.
    const suffix = qualifiedName.includes('::')
      ? qualifiedName.split('::').slice(1).join('::')
      : qualifiedName;
    if (suffix !== qualifiedName) {
      for (const type of this.index.types.values()) {
        const stored = type.qualifiedName.includes('::')
          ? type.qualifiedName.split('::').slice(1).join('::')
          : type.qualifiedName;
        if (stored === suffix) return type;
      }
    }
    for (const type of this.index.types.values()) {
      if (type.qualifiedName.endsWith(`::${qualifiedName}`)) return type;
    }
    return undefined;
  }

  /**
   * Get all functions
   */
  getAllFunctions(): FantomFunction[] {
    return Array.from(this.index.functions.values());
  }

  /**
   * Get all types
   */
  getAllTypes(): FantomTypeDef[] {
    return Array.from(this.index.types.values());
  }

  /**
   * Get functions by project
   */
  getFunctionsByProject(projectId: number): FantomFunction[] {
    const ids = this.index.byProject.get(projectId) || [];
    return ids
      .map(id => this.index.functions.get(id))
      .filter((f): f is FantomFunction => f !== undefined);
  }

  /**
   * Get functions by category
   */
  getFunctionsByCategory(category: FantomCategory): FantomFunction[] {
    const ids = this.index.byCategory.get(category) || [];
    return ids
      .map(id => this.index.functions.get(id))
      .filter((f): f is FantomFunction => f !== undefined);
  }

  /**
   * Get functions by tag
   */
  getFunctionsByTag(tag: string): FantomFunction[] {
    const ids = this.index.byTag.get(tag) || [];
    return ids
      .map(id => this.index.functions.get(id))
      .filter((f): f is FantomFunction => f !== undefined);
  }

  /**
   * Get functions by class
   */
  getFunctionsByClass(className: string): FantomFunction[] {
    const ids = this.index.byClass.get(className) || [];
    return ids
      .map(id => this.index.functions.get(id))
      .filter((f): f is FantomFunction => f !== undefined);
  }

  /**
   * Search functions by name (simple substring match)
   */
  searchByName(query: string, limit: number = 20): FantomFunction[] {
    const results: FantomFunction[] = [];
    const queryLower = query.toLowerCase();

    for (const func of this.index.functions.values()) {
      if (func.name.toLowerCase().includes(queryLower) ||
          func.qualifiedName.toLowerCase().includes(queryLower)) {
        results.push(func);
        if (results.length >= limit) break;
      }
    }

    return results;
  }

  /**
   * Get index statistics
   */
  getStats(): IndexStats {
    const byCategory: Record<string, number> = {};
    for (const [category, ids] of this.index.byCategory) {
      byCategory[category] = ids.length;
    }

    const byProject: Record<string, number> = {};
    for (const [projectId, project] of this.projects) {
      byProject[project.name] = this.index.byProject.get(projectId)?.length || 0;
    }

    return {
      totalFunctions: this.index.functions.size,
      totalTypes: this.index.types.size,
      totalProjects: this.projects.size,
      byCategory,
      byProject,
      lastUpdated: this.index.lastUpdated.toISOString()
    };
  }

  /**
   * Register a project without indexing it
   * (Used when adding functions/types directly)
   */
  registerProject(project: FantomProject): void {
    this.projects.set(project.id, project);
  }

  /**
   * Get all registered projects
   */
  getProjects(): FantomProject[] {
    return Array.from(this.projects.values());
  }

  /**
   * Get a project by ID
   */
  getProject(id: number): FantomProject | undefined {
    return this.projects.get(id);
  }

  /**
   * Export index data for caching
   */
  exportData(): {
    functions: FantomFunction[];
    types: FantomTypeDef[];
    projects: FantomProject[];
  } {
    return {
      functions: this.getAllFunctions(),
      types: this.getAllTypes(),
      projects: this.getProjects()
    };
  }

  /**
   * Import index data from cache
   */
  importData(data: {
    functions: FantomFunction[];
    types: FantomTypeDef[];
    projects: FantomProject[];
  }): void {
    // Clear existing data
    this.index.functions.clear();
    this.index.types.clear();
    this.index.byProject.clear();
    this.index.byCategory.clear();
    this.index.byTag.clear();
    this.index.byClass.clear();
    this.projects.clear();

    // Import projects
    for (const project of data.projects) {
      this.projects.set(project.id, project);
    }

    // Import types
    for (const type of data.types) {
      this.addType(type);
    }

    // Import functions
    for (const func of data.functions) {
      this.addFunction(func);
    }

    this.index.lastUpdated = new Date();
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.index.functions.clear();
    this.index.types.clear();
    this.index.byProject.clear();
    this.index.byCategory.clear();
    this.index.byTag.clear();
    this.index.byClass.clear();
    this.projects.clear();
    this.index.lastUpdated = new Date();
  }
}

// Singleton instance
let indexerInstance: FantomCodeIndexer | null = null;

/**
 * Get the singleton indexer instance
 */
export function getFantomCodeIndexer(): FantomCodeIndexer {
  if (!indexerInstance) {
    indexerInstance = new FantomCodeIndexer();
  }
  return indexerInstance;
}

/**
 * Reset the singleton instance
 */
export function resetFantomCodeIndexer(): void {
  if (indexerInstance) {
    indexerInstance.clear();
    indexerInstance = null;
  }
}
