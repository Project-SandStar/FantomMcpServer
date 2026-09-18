/**
 * SkySpark Documentation Scanner
 *
 * Scans doc folder structure to discover pods and HTML files.
 * Supports SkySpark 3.x (doc/) and 4.x (var/doc/) structures.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../../utils/index.js';
import type { ScanResult, PodInfo } from './types.js';

const logger = createLogger('doc-scanner');

/**
 * Check if an instance is a Haxall type
 */
export function isHaxallInstance(instanceType: string): boolean {
  return instanceType === 'haxall';
}

/**
 * Get the documentation path for a given instance
 *
 * Path detection order based on instance type:
 * - Haxall: {path}/home/doc
 * - SkySpark 4.x: {path}/var/doc
 * - SkySpark 3.x / Fantom: {path}/doc
 */
export function getDocPath(instancePath: string, instanceType: string): string | null {
  // Haxall: home/doc/
  // Check this first for haxall type, or as fallback for any type
  if (isHaxallInstance(instanceType)) {
    const haxallDocPath = path.join(instancePath, 'home', 'doc');
    if (fs.existsSync(haxallDocPath)) {
      return haxallDocPath;
    }
  }

  // SkySpark 4.x: var/doc/
  const docPath4x = path.join(instancePath, 'var', 'doc');
  if (fs.existsSync(docPath4x)) {
    return docPath4x;
  }

  // SkySpark 3.x: doc/
  const docPath3x = path.join(instancePath, 'doc');
  if (fs.existsSync(docPath3x)) {
    return docPath3x;
  }

  // Fallback: Check home/doc for any type (in case instance type is not set correctly)
  const haxallDocPath = path.join(instancePath, 'home', 'doc');
  if (fs.existsSync(haxallDocPath)) {
    return haxallDocPath;
  }

  // Pure Fantom installation: FAN_HOME/doc
  if (instanceType === 'fantom') {
    const fanDoc = path.join(instancePath, 'doc');
    if (fs.existsSync(fanDoc)) {
      return fanDoc;
    }
  }

  return null;
}

/**
 * Classify a pod by its name prefix
 */
function classifyPod(podName: string): PodInfo['category'] {
  // Documentation pods
  if (podName.startsWith('doc')) {
    return 'doc';
  }

  // Library pods (SkySpark extensions)
  if (podName.startsWith('lib-')) {
    return 'lib';
  }

  // Core Fantom pods
  return 'core';
}

/**
 * Check if a pod is an Axon library (contains Axon functions)
 */
function isAxonLibPod(podName: string): boolean {
  return podName === 'lib-axon' || podName === 'axon';
}

/**
 * Count HTML files in a directory
 */
function countHtmlFiles(dirPath: string): number {
  try {
    const files = fs.readdirSync(dirPath);
    return files.filter(f => f.endsWith('.html')).length;
  } catch (error) {
    return 0;
  }
}

/**
 * Scan the documentation directory structure
 */
export async function scanDocDirectory(
  docPath: string,
  instanceId: number,
  version?: string
): Promise<ScanResult> {
  logger.info(`Scanning doc directory: ${docPath}`);

  const result: ScanResult = {
    docPath,
    version,
    instanceId,
    pods: [],
    totalFiles: 0
  };

  try {
    const entries = fs.readdirSync(docPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const podPath = path.join(docPath, entry.name);
        const fileCount = countHtmlFiles(podPath);

        if (fileCount > 0) {
          const podInfo: PodInfo = {
            name: entry.name,
            path: podPath,
            category: classifyPod(entry.name),
            fileCount,
            isAxonLib: isAxonLibPod(entry.name)
          };

          result.pods.push(podInfo);
          result.totalFiles += fileCount;
        }
      }
    }

    // Sort pods by category and name
    result.pods.sort((a, b) => {
      // Core first, then lib, then doc
      const categoryOrder = { core: 0, lib: 1, doc: 2 };
      const catDiff = categoryOrder[a.category] - categoryOrder[b.category];
      if (catDiff !== 0) return catDiff;
      return a.name.localeCompare(b.name);
    });

    logger.info(`Found ${result.pods.length} pods with ${result.totalFiles} HTML files`);
    return result;

  } catch (error) {
    logger.error(`Failed to scan doc directory: ${error}`);
    throw error;
  }
}

/**
 * List HTML files in a pod directory
 */
export function listPodFiles(podPath: string): string[] {
  try {
    const files = fs.readdirSync(podPath);
    return files
      .filter(f => f.endsWith('.html'))
      .map(f => path.join(podPath, f))
      .sort();
  } catch (error) {
    logger.warn(`Failed to list files in ${podPath}: ${error}`);
    return [];
  }
}

/**
 * Determine file type based on filename pattern
 */
export function getFileType(filename: string): 'type' | 'function' | 'index' | 'chapter' | 'unknown' {
  const basename = path.basename(filename, '.html');

  // Index files
  if (basename === 'index') {
    return 'index';
  }

  // Axon function files (func~name.html)
  if (basename.startsWith('func~')) {
    return 'function';
  }

  // Type files (capitalized names like Bool.html, HttpClient.html)
  if (/^[A-Z][a-zA-Z0-9_]*$/.test(basename)) {
    return 'type';
  }

  // Documentation chapters (lowercase, often multi-word)
  return 'chapter';
}

/**
 * Check if a directory is a valid doc directory
 */
export function isValidDocDirectory(dirPath: string): boolean {
  if (!fs.existsSync(dirPath)) {
    return false;
  }

  // Check for common pods that should be present
  const commonPods = ['sys', 'build', 'concurrent'];
  for (const pod of commonPods) {
    const podPath = path.join(dirPath, pod);
    if (fs.existsSync(podPath)) {
      return true;
    }
  }

  // Also valid if it has any subdirectories with HTML files
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const podPath = path.join(dirPath, entry.name);
        if (countHtmlFiles(podPath) > 0) {
          return true;
        }
      }
    }
  } catch (error) {
    return false;
  }

  return false;
}
