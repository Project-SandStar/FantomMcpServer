/**
 * Fantom Build Source Code Indexer
 *
 * Indexes Fantom source code from Fantom installations (e.g., fantom-1.0.80, fantom-1.0.82).
 * Creates FantomProject entries for each pod with naming convention: fantom.{version}.{podName}
 */

import * as fs from 'fs';
import * as path from 'path';
import type { PodMeta } from './types.js';
import { FantomFileScanner } from './scanner.js';
import { FantomCodeParser } from './codeParser.js';
import { getFantomCodeIndexer } from './indexer.js';
import { getFantomFunctionSearchIndex } from './searchIndex.js';
import { getFantomDatabase } from '../fantom/database.js';
import type { FantomBuildIndexResult } from '../fantom/types.js';

// ============================================
// Types
// ============================================

export interface FantomBuildPodInfo {
  podName: string;
  podPath: string;
  category: string;  // e.g., 'sys', 'concurrent', 'web'
  buildFanPath: string;
  podMeta?: PodMeta;
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

/**
 * Extract the raw `depends = ["sys 1.0", "haystack 4.0", ...]` entries from a
 * build.fan. Shared by the build indexer (PodMeta.dependencies) and by
 * `src/fantom/projectDependencies.ts` (build.fan-depends edges).
 *
 * The bracket body is matched across lines; each entry is the string literal
 * inside double quotes, e.g. `sys @{fan.depend}` or `haystack 3.0+`. Use
 * `dependPodName()` to get the pod name (the token before the first space).
 */
export function parseBuildFanDepends(content: string): string[] {
  const dependsMatch = content.match(/depends\s*=\s*\[([\s\S]*?)\]/);
  if (!dependsMatch) return [];
  return dependsMatch[1]
    .split(',')
    .map(s => {
      const match = s.trim().match(/"([^"]+)"/);
      return match ? match[1] : '';
    })
    .filter(s => s.length > 0);
}

/** `"haystack 3.0+"` → `haystack`. */
export function dependPodName(entry: string): string {
  return entry.trim().split(/\s+/)[0] ?? '';
}

// ============================================
// Fantom Build Indexer
// ============================================

/**
 * Discovers and indexes all Fantom pods in a Fantom source installation
 */
export class FantomBuildIndexer {
  private scanner: FantomFileScanner;

  constructor() {
    this.scanner = new FantomFileScanner({
      excludeDirs: ['node_modules', '.git', 'build', 'out', 'dist', 'lib', 'res', 'locale', 'js', 'es', 'test', 'java', 'dotnet'],
      maxDepth: 10
    });
  }

  /**
   * Discover all pods in a Fantom source directory
   */
  async discoverPods(srcPath: string): Promise<FantomBuildPodInfo[]> {
    const pods: FantomBuildPodInfo[] = [];
    const absolutePath = path.resolve(srcPath);

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

        // The pod name is typically the directory name
        const podName = podMeta.podName || path.basename(podPath);

        // Category is the parent directory (if any)
        const category = pathParts.length > 1 ? pathParts[0] : 'core';

        // Skip if it's just the root build.fan
        if (!this.hasFanDirectory(podPath)) {
          continue;
        }

        pods.push({
          podName,
          podPath,
          category,
          buildFanPath,
          podMeta
        });
      } catch (err) {
        // Skip pods that fail to parse
        console.error(`[FantomBuildIndexer] Failed to parse pod at ${buildFanPath}: ${err}`);
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
        } else if (entry.isDirectory() && !entry.name.startsWith('.') && !this.isExcluded(entry.name)) {
          await scan(fullPath, depth + 1);
        }
      }
    };

    await scan(dirPath);
    return buildFiles;
  }

  /**
   * Check if directory should be excluded
   */
  private isExcluded(dirName: string): boolean {
    const excluded = ['node_modules', '.git', 'build', 'out', 'dist', 'lib', 'java', 'dotnet', 'javascript', 'res', 'locale'];
    return excluded.includes(dirName);
  }

  /**
   * Check if a pod directory has a fan/ subdirectory with .fan files
   */
  private hasFanDirectory(podPath: string): boolean {
    const fanDir = path.join(podPath, 'fan');
    if (!fs.existsSync(fanDir)) return false;

    try {
      const entries = fs.readdirSync(fanDir);
      return entries.some(f => f.endsWith('.fan'));
    } catch {
      return false;
    }
  }

  /**
   * Parse a build.fan file to extract pod metadata
   */
  private parseBuildFan(buildFanPath: string): PodMeta {
    const content = fs.readFileSync(buildFanPath, 'utf-8');

    const podMeta: PodMeta = {
      podName: '',
      version: '',
      srcDirs: ['fan'],
      dependencies: []
    };

    // Extract podName
    const podNameMatch = content.match(/podName\s*=\s*"([^"]+)"/);
    if (podNameMatch) {
      podMeta.podName = podNameMatch[1];
    }

    // Extract version
    const versionMatch = content.match(/version\s*=\s*Version\s*\(\s*"([^"]+)"\s*\)/);
    if (versionMatch) {
      podMeta.version = versionMatch[1];
    }

    // Extract srcDirs
    const srcDirsMatch = content.match(/srcDirs\s*=\s*\[([^\]]+)\]/);
    if (srcDirsMatch) {
      const srcDirs = srcDirsMatch[1]
        .split(',')
        .map(s => s.trim().replace(/`/g, '').replace(/"/g, ''))
        .filter(s => s.length > 0);
      if (srcDirs.length > 0) {
        podMeta.srcDirs = srcDirs;
      }
    }

    // Extract depends
    const dependencies = parseBuildFanDepends(content);
    if (dependencies.length > 0) {
      podMeta.dependencies = dependencies;
    }

    return podMeta;
  }

  /**
   * Index a single Fantom build
   */
  async indexBuild(
    buildId: number,
    buildPath: string,
    version: string,
    onProgress?: (message: string) => void
  ): Promise<FantomBuildIndexResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    const podStats: FantomBuildIndexResult['podStats'] = [];

    const srcPath = path.join(buildPath, 'src');
    if (!fs.existsSync(srcPath)) {
      return {
        success: false,
        buildId,
        version,
        podsIndexed: 0,
        totalFunctions: 0,
        totalTypes: 0,
        duration: Date.now() - startTime,
        errors: [`Source directory not found: ${srcPath}`],
        podStats: []
      };
    }

    onProgress?.(`Discovering pods in Fantom ${version}...`);

    // Discover all pods
    const pods = await this.discoverPods(srcPath);
    onProgress?.(`Found ${pods.length} pods`);

    const db = getFantomDatabase();
    const indexer = getFantomCodeIndexer();
    const searchIndex = getFantomFunctionSearchIndex();

    let totalFunctions = 0;
    let totalTypes = 0;
    let indexedPods = 0;

    for (let i = 0; i < pods.length; i++) {
      const pod = pods[i];

      onProgress?.(`[${i + 1}/${pods.length}] Indexing ${pod.podName}...`);

      try {
        // Create or update project for this pod
        const project = await db.createProjectForBuild(
          buildId,
          pod.podName,
          pod.podPath,
          version
        );

        // Clear existing data for this project
        indexer.clearProject(project.id);

        // Create parser for this pod's project
        const parser = new FantomCodeParser(project.id, pod.podMeta);

        // Register project with required fields
        const now = new Date().toISOString();
        indexer.registerProject({
          id: project.id,
          name: project.name,
          path: pod.podPath,
          podMeta: pod.podMeta,
          functionCount: 0,
          typeCount: 0,
          createdAt: now,
          updatedAt: now,
        });

        // Scan and parse the pod
        const scanResult = await this.scanner.scanDirectory(pod.podPath);
        let podFunctions = 0;
        let podTypes = 0;

        for (const filePath of scanResult.files) {
          try {
            const parsed = await parser.parseFile(filePath);

            // Add types
            for (const type of parsed.types) {
              indexer.addType({
                ...type,
                projectId: project.id,
                qualifiedName: `${pod.podName}::${type.name}`
              });
              podTypes++;
            }

            // Add functions
            for (const func of parsed.functions) {
              indexer.addFunction({
                ...func,
                projectId: project.id,
                qualifiedName: func.className
                  ? `${pod.podName}::${func.className}.${func.name}`
                  : `${pod.podName}::${func.name}`
              });
              podFunctions++;
            }
          } catch (err) {
            errors.push(`Error parsing ${filePath}: ${err}`);
          }
        }

        // Update project stats
        await db.updateProjectIndexStats(project.id, podFunctions, podTypes);

        totalFunctions += podFunctions;
        totalTypes += podTypes;
        indexedPods++;

        podStats.push({
          podName: pod.podName,
          projectId: project.id,
          functionsIndexed: podFunctions,
          typesIndexed: podTypes
        });

      } catch (err) {
        errors.push(`Failed to index pod ${pod.podName}: ${err}`);
      }
    }

    // Update build stats
    await db.updateFantomBuildIndexStats(buildId, {
      podCount: indexedPods,
      functionCount: totalFunctions,
      typeCount: totalTypes
    });

    // Rebuild search index
    onProgress?.('Rebuilding search index...');
    searchIndex.rebuild(indexer);

    const duration = Date.now() - startTime;
    onProgress?.(`Indexed ${indexedPods} pods (${totalFunctions} functions, ${totalTypes} types) in ${(duration / 1000).toFixed(2)}s`);

    return {
      success: errors.length === 0,
      buildId,
      version,
      podsIndexed: indexedPods,
      totalFunctions,
      totalTypes,
      duration,
      errors,
      podStats
    };
  }

  /**
   * Scan and register all Fantom builds from the source folder
   */
  async scanAndRegisterBuilds(sourceFolder: string): Promise<{ registered: number; builds: Array<{ version: string; path: string; hasSource: boolean }> }> {
    const db = getFantomDatabase();
    const builds: Array<{ version: string; path: string; hasSource: boolean }> = [];

    if (!fs.existsSync(sourceFolder)) {
      return { registered: 0, builds: [] };
    }

    const entries = fs.readdirSync(sourceFolder, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // Check if directory matches fantom-X.X.XX pattern
      const match = entry.name.match(/^fantom-(\d+\.\d+\.\d+)$/);
      if (!match) continue;

      const version = match[1];
      const buildPath = path.join(sourceFolder, entry.name);
      const srcPath = path.join(buildPath, 'src');
      const hasSource = fs.existsSync(srcPath);

      // Check if build already exists
      const existing = await db.getFantomBuildByVersion(version);
      if (!existing) {
        await db.createFantomBuild({
          version,
          path: buildPath,
          hasSource,
          isActive: true
        });
      } else {
        // Update path if changed
        if (existing.path !== buildPath || existing.hasSource !== hasSource) {
          await db.updateFantomBuild(existing.id, { path: buildPath, hasSource });
        }
      }

      builds.push({ version, path: buildPath, hasSource });
    }

    return { registered: builds.length, builds };
  }
}

// Singleton
let fantomBuildIndexerInstance: FantomBuildIndexer | null = null;

export function getFantomBuildIndexer(): FantomBuildIndexer {
  if (!fantomBuildIndexerInstance) {
    fantomBuildIndexerInstance = new FantomBuildIndexer();
  }
  return fantomBuildIndexerInstance;
}
