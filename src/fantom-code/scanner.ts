/**
 * Fantom File Scanner - discovers .fan files in directories
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ScanOptions, ScanResult, PodMeta } from './types.js';
import { DEFAULT_EXCLUDE_DIRS as SHARED_EXCLUDE_DIRS, loadGitignore } from './excludeDirs.js';

const DEFAULT_EXCLUDE_DIRS = [...SHARED_EXCLUDE_DIRS];

// Default file extensions scanned when indexing a project.
// Kept in sync with the tree-sitter language registry
// (src/parser/treeSitter/languageRegistry.ts) so the scanner is
// language-generic, not Fantom-only. Override per-project via
// ScanOptions.includePatterns.
const DEFAULT_INCLUDE_PATTERNS = [
  // Fantom / Haystack
  '.fan', '.trio', '.xeto', '.axon',
  // TypeScript / JavaScript
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  // Python
  '.py', '.pyw', '.pyi',
  // JVM
  '.java', '.kt', '.kts', '.scala', '.sc',
  // Systems
  '.go', '.rs', '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.cs',
  // Scripting
  '.rb', '.rake', '.gemspec', '.php', '.phtml',
  // Mobile
  '.swift', '.dart',
  // Web
  '.html', '.htm', '.xhtml', '.css', '.scss', '.less', '.vue',
  // Data
  '.json', '.jsonc', '.json5'
];

/**
 * Scanner for discovering Fantom source files
 */
export class FantomFileScanner {
  private excludeDirs: Set<string>;
  private includePatterns: string[];
  private maxDepth: number;
  private followSymlinks: boolean;
  private honorGitignore: boolean;
  private gitignoreMatcher: ((absPath: string) => boolean) | null = null;

  constructor(options?: ScanOptions & { honorGitignore?: boolean }) {
    this.excludeDirs = new Set([
      ...DEFAULT_EXCLUDE_DIRS,
      ...(options?.excludeDirs || [])
    ]);
    this.includePatterns = options?.includePatterns || DEFAULT_INCLUDE_PATTERNS;
    this.maxDepth = options?.maxDepth ?? 20;
    this.followSymlinks = options?.followSymlinks ?? false;
    this.honorGitignore = options?.honorGitignore ?? true;
  }

  /**
   * Scan a directory recursively for .fan files
   */
  async scanDirectory(dirPath: string): Promise<ScanResult> {
    const startTime = Date.now();
    const files: string[] = [];
    const errors: string[] = [];

    const absolutePath = path.resolve(dirPath);

    if (!fs.existsSync(absolutePath)) {
      return {
        files: [],
        scanTime: Date.now() - startTime,
        errors: [`Directory not found: ${absolutePath}`]
      };
    }

    if (this.honorGitignore) {
      try {
        this.gitignoreMatcher = await loadGitignore(absolutePath);
      } catch {
        this.gitignoreMatcher = null;
      }
    }

    try {
      await this.scanRecursive(absolutePath, files, errors, 0);
    } catch (err) {
      errors.push(`Scan error: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Try to find and parse build.fan for project metadata
    let projectMeta: PodMeta | undefined;
    const buildFanPath = path.join(absolutePath, 'build.fan');
    if (fs.existsSync(buildFanPath)) {
      try {
        projectMeta = this.parseBasicBuildFan(buildFanPath);
      } catch (err) {
        errors.push(`Failed to parse build.fan: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      files: files.sort(),
      projectMeta,
      scanTime: Date.now() - startTime,
      errors
    };
  }

  /**
   * Recursive directory scanning
   */
  private async scanRecursive(
    dirPath: string,
    files: string[],
    errors: string[],
    depth: number
  ): Promise<void> {
    if (depth > this.maxDepth) {
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (err) {
      errors.push(`Cannot read directory ${dirPath}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      try {
        if (entry.isSymbolicLink() && !this.followSymlinks) {
          continue;
        }

        // Honor .gitignore for both directories and files. Cheap short-circuit.
        if (this.gitignoreMatcher && this.gitignoreMatcher(fullPath)) {
          continue;
        }

        if (entry.isDirectory()) {
          // Skip excluded directories
          if (this.excludeDirs.has(entry.name)) {
            continue;
          }
          await this.scanRecursive(fullPath, files, errors, depth + 1);
        } else if (entry.isFile()) {
          // Check if file matches include patterns
          if (this.matchesPattern(entry.name)) {
            files.push(fullPath);
          }
        }
      } catch (err) {
        errors.push(`Error processing ${fullPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Check if a filename matches include patterns
   */
  private matchesPattern(filename: string): boolean {
    for (const pattern of this.includePatterns) {
      if (filename.endsWith(pattern)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Parse basic build.fan to extract pod metadata
   * This is a simplified parser for common build.fan patterns
   */
  private parseBasicBuildFan(buildFanPath: string): PodMeta {
    const content = fs.readFileSync(buildFanPath, 'utf-8');

    const meta: PodMeta = {
      podName: '',
      dependencies: [],
      srcDirs: ['fan']
    };

    // Extract pod name from podName = "name" or podName = name
    const podNameMatch = content.match(/podName\s*=\s*["']?(\w+)["']?/);
    if (podNameMatch) {
      meta.podName = podNameMatch[1];
    } else {
      // Fallback: use directory name
      meta.podName = path.basename(path.dirname(buildFanPath));
    }

    // Extract version
    const versionMatch = content.match(/version\s*=\s*Version\s*\(\s*["']([^"']+)["']\s*\)/);
    if (versionMatch) {
      meta.version = versionMatch[1];
    }

    // Extract description
    const descMatch = content.match(/summary\s*=\s*["']([^"']+)["']/);
    if (descMatch) {
      meta.description = descMatch[1];
    }

    // Extract dependencies from depends = [...]
    const dependsMatch = content.match(/depends\s*=\s*\[([\s\S]*?)\]/);
    if (dependsMatch) {
      const depsContent = dependsMatch[1];
      // Match "podName version" patterns
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
      meta.srcDirs = [];
      for (const match of dirMatches) {
        meta.srcDirs.push(match[1]);
      }
      if (meta.srcDirs.length === 0) {
        meta.srcDirs = ['fan'];
      }
    }

    // Extract outPodDir
    const outDirMatch = content.match(/outPodDir\s*=\s*`([^`]+)`/);
    if (outDirMatch) {
      meta.outPodDir = outDirMatch[1];
    }

    // Check for docApi/docSrc
    meta.docApi = /docApi\s*=\s*true/.test(content);
    meta.docSrc = /docSrc\s*=\s*true/.test(content);

    return meta;
  }

  /**
   * Find all build.fan files in a directory (for discovering multiple pods)
   */
  async findBuildFiles(dirPath: string): Promise<string[]> {
    const buildFiles: string[] = [];
    const absolutePath = path.resolve(dirPath);

    if (!fs.existsSync(absolutePath)) {
      return buildFiles;
    }

    await this.findBuildFilesRecursive(absolutePath, buildFiles, 0);
    return buildFiles;
  }

  private async findBuildFilesRecursive(
    dirPath: string,
    buildFiles: string[],
    depth: number
  ): Promise<void> {
    if (depth > 5) { // Don't go too deep looking for build.fan
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isFile() && entry.name === 'build.fan') {
        buildFiles.push(fullPath);
      } else if (entry.isDirectory() && !this.excludeDirs.has(entry.name)) {
        await this.findBuildFilesRecursive(fullPath, buildFiles, depth + 1);
      }
    }
  }

  /**
   * Check if a directory looks like a Fantom project
   */
  isFantomProject(dirPath: string): boolean {
    const buildFan = path.join(dirPath, 'build.fan');
    const fanDir = path.join(dirPath, 'fan');

    return fs.existsSync(buildFan) || fs.existsSync(fanDir);
  }

  /**
   * Get file statistics for a scanned file
   */
  getFileStats(filePath: string): { size: number; modified: Date } | null {
    try {
      const stats = fs.statSync(filePath);
      return {
        size: stats.size,
        modified: stats.mtime
      };
    } catch {
      return null;
    }
  }

  /**
   * Calculate a hash of file modification times for cache validation
   */
  getDirectoryHash(_dirPath: string, files: string[]): string {
    const times: number[] = [];

    for (const file of files) {
      const stats = this.getFileStats(file);
      if (stats) {
        times.push(stats.modified.getTime());
      }
    }

    return times.sort().join(':');
  }
}

/**
 * Create a default file scanner instance
 */
export function createFileScanner(options?: ScanOptions): FantomFileScanner {
  return new FantomFileScanner(options);
}
