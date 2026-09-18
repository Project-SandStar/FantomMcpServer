/**
 * Haxall Source Code Indexer
 *
 * Indexes the entire Haxall source tree, discovering pods and their Fantom source files.
 * Creates FantomProject entries for each pod and indexes all functions and types.
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  FantomProject,
  PodMeta,
  IndexResult,
  ParseError
} from './types.js';
import { FantomFileScanner } from './scanner.js';
import { FantomCodeParser } from './codeParser.js';
import { FantomCodeIndexer, getFantomCodeIndexer } from './indexer.js';
import { FantomFunctionSearchIndex, getFantomFunctionSearchIndex } from './searchIndex.js';

// ============================================
// Types
// ============================================

export interface HaxallSourceStats {
  totalPods: number;
  totalFiles: number;
  totalFunctions: number;
  totalTypes: number;
  indexedPods: string[];
  failedPods: string[];
  duration: number;
  podStats: PodIndexStats[];
}

export interface PodIndexStats {
  podName: string;
  podPath: string;
  projectId: number;
  files: number;
  functions: number;
  types: number;
  errors: number;
  duration: number;
}

export interface HaxallPodInfo {
  podName: string;
  podPath: string;
  category: string;
  buildFanPath: string;
  podMeta?: PodMeta;
}

// ============================================
// Haxall Source Indexer
// ============================================

/**
 * Discovers and indexes all Fantom pods in a Haxall source tree
 */
export class HaxallSourceIndexer {
  private scanner: FantomFileScanner;
  private baseProjectId: number;

  constructor() {
    this.scanner = new FantomFileScanner({
      excludeDirs: ['node_modules', '.git', 'build', 'out', 'dist', 'lib', 'res', 'locale', 'js', 'es', 'test'],
      maxDepth: 10
    });
    this.baseProjectId = 100000; // Start IDs at 100000 for Haxall pods
  }

  /**
   * Discover all pods in a Haxall source directory
   */
  async discoverPods(sourcePath: string): Promise<HaxallPodInfo[]> {
    const pods: HaxallPodInfo[] = [];
    const absolutePath = path.resolve(sourcePath);

    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Source path does not exist: ${absolutePath}`);
    }

    // Find all build.fan files
    const buildFiles = await this.findAllBuildFans(absolutePath);

    for (const buildFanPath of buildFiles) {
      try {
        const podPath = path.dirname(buildFanPath);
        const podMeta = this.parseBuildFan(buildFanPath);

        // Determine category from path
        const relativePath = path.relative(absolutePath, podPath);
        const pathParts = relativePath.split(path.sep);
        const category = pathParts[0] || 'root';

        // Skip root-level and category-level build.fan files
        if (pathParts.length <= 1 && !this.hasFanDirectory(podPath)) {
          continue;
        }

        pods.push({
          podName: podMeta.podName || path.basename(podPath),
          podPath,
          category,
          buildFanPath,
          podMeta
        });
      } catch (err) {
        // Skip pods that fail to parse
        console.error(`Failed to parse pod at ${buildFanPath}: ${err}`);
      }
    }

    return pods;
  }

  /**
   * Find all build.fan files recursively
   */
  private async findAllBuildFans(dirPath: string): Promise<string[]> {
    const buildFiles: string[] = [];

    const scan = async (currentPath: string, depth: number = 0): Promise<void> => {
      if (depth > 5) return;

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentPath, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);

        if (entry.isFile() && entry.name === 'build.fan') {
          buildFiles.push(fullPath);
        } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
          await scan(fullPath, depth + 1);
        }
      }
    };

    await scan(dirPath);
    return buildFiles;
  }

  /**
   * Check if a directory has a fan/ subdirectory
   */
  private hasFanDirectory(podPath: string): boolean {
    return fs.existsSync(path.join(podPath, 'fan'));
  }

  /**
   * Parse a build.fan file to extract pod metadata
   */
  private parseBuildFan(buildFanPath: string): PodMeta {
    const content = fs.readFileSync(buildFanPath, 'utf-8');

    const meta: PodMeta = {
      podName: '',
      dependencies: [],
      srcDirs: ['fan']
    };

    // Extract pod name
    const podNameMatch = content.match(/podName\s*=\s*["']?(\w+)["']?/);
    if (podNameMatch) {
      meta.podName = podNameMatch[1];
    } else {
      meta.podName = path.basename(path.dirname(buildFanPath));
    }

    // Extract version
    const versionMatch = content.match(/version\s*=\s*Version\s*\(\s*["']([^"']+)["']\s*\)/);
    if (versionMatch) {
      meta.version = versionMatch[1];
    }

    // Extract description/summary
    const descMatch = content.match(/summary\s*=\s*["']([^"']+)["']/);
    if (descMatch) {
      meta.description = descMatch[1];
    }

    // Extract dependencies
    const dependsMatch = content.match(/depends\s*=\s*\[([\s\S]*?)\]/);
    if (dependsMatch) {
      const depsContent = dependsMatch[1];
      const depMatches = depsContent.matchAll(/["'](\w+)\s*([^"']*?)["']/g);
      for (const match of depMatches) {
        meta.dependencies.push(match[1]);
      }
    }

    // Extract srcDirs
    const srcDirsMatch = content.match(/srcDirs\s*=\s*\[([\s\S]*?)\]/);
    if (srcDirsMatch) {
      const srcContent = srcDirsMatch[1];
      const dirMatches = srcContent.matchAll(/`([^`]+)`/g);
      const dirs: string[] = [];
      for (const match of dirMatches) {
        dirs.push(match[1].replace(/\/$/, '')); // Remove trailing slash
      }
      if (dirs.length > 0) {
        meta.srcDirs = dirs;
      }
    }

    return meta;
  }

  /**
   * Index a single pod
   */
  async indexPod(
    podInfo: HaxallPodInfo,
    projectId: number,
    instanceId: number,
    indexer: FantomCodeIndexer
  ): Promise<IndexResult> {
    const startTime = Date.now();
    const errors: ParseError[] = [];
    let functionsIndexed = 0;
    let typesIndexed = 0;
    let filesProcessed = 0;

    // Create project entry
    const project: FantomProject = {
      id: projectId,
      name: podInfo.podName,
      path: podInfo.podPath,
      instanceId,
      podMeta: podInfo.podMeta,
      functionCount: 0,
      typeCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Scan for .fan files
    const fanFiles: string[] = [];
    const srcDirs = podInfo.podMeta?.srcDirs || ['fan'];

    for (const srcDir of srcDirs) {
      const srcPath = path.join(podInfo.podPath, srcDir);
      if (fs.existsSync(srcPath)) {
        const scanResult = await this.scanner.scanDirectory(srcPath);
        fanFiles.push(...scanResult.files);

        if (scanResult.errors.length > 0) {
          for (const err of scanResult.errors) {
            errors.push({
              file: srcPath,
              message: err,
              severity: 'warning'
            });
          }
        }
      }
    }

    // Parse each file
    const parser = new FantomCodeParser(projectId, podInfo.podMeta);

    for (const filePath of fanFiles) {
      try {
        const parsed = parser.parseFile(filePath);
        filesProcessed++;

        // Add types to indexer
        for (const type of parsed.types) {
          indexer.addType(type);
          typesIndexed++;
        }

        // Add functions to indexer
        for (const func of parsed.functions) {
          indexer.addFunction(func);
          functionsIndexed++;
        }

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

    // Register project with indexer
    indexer.registerProject(project);

    return {
      projectId,
      projectName: podInfo.podName,
      functionsIndexed,
      typesIndexed,
      filesProcessed,
      errors,
      duration: Date.now() - startTime
    };
  }

  /**
   * Generate a unique project ID for a pod
   */
  generateProjectId(instanceId: number, podIndex: number): number {
    // Use instanceId * 10000 + podIndex to create unique IDs
    return this.baseProjectId + (instanceId * 10000) + podIndex;
  }
}

// ============================================
// Main Indexing Function
// ============================================

/**
 * Index the entire Haxall source directory
 *
 * @param instanceId - Unique identifier for this indexing instance
 * @param sourcePath - Path to the Haxall src directory
 * @param options - Optional configuration
 * @returns Indexing statistics
 */
export async function indexHaxallSource(
  instanceId: number,
  sourcePath: string,
  options?: {
    indexer?: FantomCodeIndexer;
    searchIndex?: FantomFunctionSearchIndex;
    onProgress?: (progress: { current: number; total: number; podName: string }) => void;
    categoryFilter?: string[];
    podFilter?: string[];
  }
): Promise<HaxallSourceStats> {
  const startTime = Date.now();
  const haxallIndexer = new HaxallSourceIndexer();

  // Use provided indexer or get singleton
  const indexer = options?.indexer || getFantomCodeIndexer();
  const searchIndex = options?.searchIndex || getFantomFunctionSearchIndex();

  // Discover all pods
  const pods = await haxallIndexer.discoverPods(sourcePath);

  // Apply filters if provided
  let filteredPods = pods;
  if (options?.categoryFilter && options.categoryFilter.length > 0) {
    filteredPods = filteredPods.filter(p => options.categoryFilter!.includes(p.category));
  }
  if (options?.podFilter && options.podFilter.length > 0) {
    filteredPods = filteredPods.filter(p => options.podFilter!.includes(p.podName));
  }

  const stats: HaxallSourceStats = {
    totalPods: filteredPods.length,
    totalFiles: 0,
    totalFunctions: 0,
    totalTypes: 0,
    indexedPods: [],
    failedPods: [],
    duration: 0,
    podStats: []
  };

  // Index each pod
  for (let i = 0; i < filteredPods.length; i++) {
    const podInfo = filteredPods[i];
    const projectId = haxallIndexer.generateProjectId(instanceId, i);

    // Report progress
    if (options?.onProgress) {
      options.onProgress({
        current: i + 1,
        total: filteredPods.length,
        podName: podInfo.podName
      });
    }

    try {
      const result = await haxallIndexer.indexPod(podInfo, projectId, instanceId, indexer);

      stats.totalFiles += result.filesProcessed;
      stats.totalFunctions += result.functionsIndexed;
      stats.totalTypes += result.typesIndexed;
      stats.indexedPods.push(podInfo.podName);

      stats.podStats.push({
        podName: podInfo.podName,
        podPath: podInfo.podPath,
        projectId,
        files: result.filesProcessed,
        functions: result.functionsIndexed,
        types: result.typesIndexed,
        errors: result.errors.length,
        duration: result.duration
      });
    } catch (err) {
      stats.failedPods.push(podInfo.podName);
      console.error(`Failed to index pod ${podInfo.podName}: ${err}`);
    }
  }

  // Rebuild search index with new data
  searchIndex.rebuild(indexer);

  stats.duration = Date.now() - startTime;
  return stats;
}

/**
 * Get a summary of discovered pods without indexing
 */
export async function discoverHaxallPods(sourcePath: string): Promise<HaxallPodInfo[]> {
  const haxallIndexer = new HaxallSourceIndexer();
  return haxallIndexer.discoverPods(sourcePath);
}

/**
 * Index specific pods by name
 */
export async function indexHaxallPods(
  instanceId: number,
  sourcePath: string,
  podNames: string[],
  options?: {
    indexer?: FantomCodeIndexer;
    searchIndex?: FantomFunctionSearchIndex;
  }
): Promise<HaxallSourceStats> {
  return indexHaxallSource(instanceId, sourcePath, {
    ...options,
    podFilter: podNames
  });
}

/**
 * Index pods by category (core, conn, lib, etc.)
 */
export async function indexHaxallCategory(
  instanceId: number,
  sourcePath: string,
  categories: string[],
  options?: {
    indexer?: FantomCodeIndexer;
    searchIndex?: FantomFunctionSearchIndex;
  }
): Promise<HaxallSourceStats> {
  return indexHaxallSource(instanceId, sourcePath, {
    ...options,
    categoryFilter: categories
  });
}
