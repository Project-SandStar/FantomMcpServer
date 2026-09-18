/**
 * Local Documentation Parser
 *
 * Main parser for local SkySpark/Fantom HTML documentation.
 * Parses documentation per instance with version-specific caching.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../../utils/index.js';
import { getCacheDir } from '../../utils/installRoot.js';
import { getFantomDatabase } from '../../fantom/database.js';
import {
  getDocPath,
  scanDocDirectory,
  listPodFiles,
  isValidDocDirectory
} from './skysparkDocScanner.js';
import { extractDocFile } from './docHtmlExtractor.js';
import type {
  LocalDocItem,
  ParseResult,
  LocalDocParseOptions,
  PodInfo,
  LocalDocSearchResult
} from './types.js';

const logger = createLogger('local-docs');

/**
 * Cache directory for parsed documentation
 */
const CACHE_DIR = getCacheDir();

/**
 * Get cache file path for an instance
 */
function getCacheFilePath(instanceId: number): string {
  return path.join(CACHE_DIR, `flexsearch-local-${instanceId}.json`);
}

/**
 * Load cached documentation for an instance
 */
export function loadCachedDocs(instanceId: number): LocalDocItem[] | null {
  const cacheFile = getCacheFilePath(instanceId);

  if (!fs.existsSync(cacheFile)) {
    return null;
  }

  try {
    const data = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    if (data.items && Array.isArray(data.items)) {
      logger.debug(`Loaded ${data.items.length} cached items for instance ${instanceId}`);
      return data.items;
    }
  } catch (error) {
    logger.warn(`Failed to load cache for instance ${instanceId}: ${error}`);
  }

  return null;
}

/**
 * Save documentation to cache
 */
function saveCachedDocs(
  instanceId: number,
  items: LocalDocItem[],
  version?: string,
  podStats?: Record<string, number>
): void {
  // Ensure cache directory exists
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  const cacheFile = getCacheFilePath(instanceId);
  const cacheData = {
    metadata: {
      instanceId,
      version,
      itemCount: items.length,
      podStats,
      timestamp: Date.now(),
      generatedAt: new Date().toISOString()
    },
    items
  };

  fs.writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2));
  logger.info(`Cached ${items.length} items for instance ${instanceId}`);
}

/**
 * Parse documentation for a specific instance
 */
export async function parseInstanceDocs(
  options: LocalDocParseOptions
): Promise<ParseResult> {
  const startTime = Date.now();
  const { instanceId, pods: filterPods, forceRefresh } = options;

  logger.info(`Parsing docs for instance ${instanceId}`);

  // Get instance from database
  const db = getFantomDatabase();
  await db.initialize();
  const instance = await db.getInstanceById(instanceId);

  if (!instance) {
    throw new Error(`Instance not found: ${instanceId}`);
  }

  // Check cache first
  if (!forceRefresh) {
    const cached = loadCachedDocs(instanceId);
    if (cached) {
      const podStats: Record<string, number> = {};
      for (const item of cached) {
        podStats[item.pod] = (podStats[item.pod] || 0) + 1;
      }
      return {
        instanceId,
        version: instance.version || undefined,
        items: cached,
        errors: [],
        duration: Date.now() - startTime,
        podStats
      };
    }
  }

  // Get documentation path
  const docPath = getDocPath(instance.path, instance.type);
  if (!docPath || !isValidDocDirectory(docPath)) {
    throw new Error(`Documentation not found for instance at ${instance.path}`);
  }

  // Scan for pods
  const scanResult = await scanDocDirectory(docPath, instanceId, instance.version || undefined);

  // Filter pods if specified
  let podsToProcess = scanResult.pods;
  if (filterPods && filterPods.length > 0) {
    podsToProcess = scanResult.pods.filter(p =>
      filterPods.includes(p.name)
    );
  }

  // Parse each pod
  const items: LocalDocItem[] = [];
  const errors: string[] = [];
  const podStats: Record<string, number> = {};

  for (const podInfo of podsToProcess) {
    try {
      const podItems = parsePodDocs(podInfo, instanceId, instance.version || undefined);
      items.push(...podItems);
      podStats[podInfo.name] = podItems.length;
      logger.debug(`Parsed ${podItems.length} items from ${podInfo.name}`);
    } catch (error) {
      const errMsg = `Failed to parse pod ${podInfo.name}: ${error}`;
      logger.warn(errMsg);
      errors.push(errMsg);
    }
  }

  // Save to cache
  saveCachedDocs(instanceId, items, instance.version || undefined, podStats);

  // Update DocIndex in database
  for (const [podName, itemCount] of Object.entries(podStats)) {
    const podInfo = podsToProcess.find(p => p.name === podName);
    if (podInfo) {
      await db.upsertDocIndex(
        instanceId,
        podName,
        podInfo.path,
        itemCount,
        instance.version || undefined,
        getCacheFilePath(instanceId)
      );
    }
  }

  const duration = Date.now() - startTime;
  logger.info(`Parsed ${items.length} items in ${duration}ms`);

  return {
    instanceId,
    version: instance.version || undefined,
    items,
    errors,
    duration,
    podStats
  };
}

/**
 * Parse documentation for a single pod
 */
function parsePodDocs(
  podInfo: PodInfo,
  instanceId: number,
  version?: string
): LocalDocItem[] {
  const items: LocalDocItem[] = [];
  const files = listPodFiles(podInfo.path);

  for (const filePath of files) {
    const extracted = extractDocFile(
      filePath,
      podInfo.name,
      instanceId,
      version,
      podInfo.isAxonLib
    );
    items.push(...extracted);
  }

  return items;
}

/**
 * Get documentation status for an instance
 */
export async function getDocStatus(instanceId: number): Promise<{
  hasCache: boolean;
  cacheFile?: string;
  itemCount?: number;
  lastIndexed?: string;
  docPath?: string;
  podCount?: number;
}> {
  const db = getFantomDatabase();
  await db.initialize();

  const instance = await db.getInstanceById(instanceId);
  if (!instance) {
    throw new Error(`Instance not found: ${instanceId}`);
  }

  const docPath = getDocPath(instance.path, instance.type);
  const cacheFile = getCacheFilePath(instanceId);
  const hasCache = fs.existsSync(cacheFile);

  const result: {
    hasCache: boolean;
    cacheFile?: string;
    itemCount?: number;
    lastIndexed?: string;
    docPath?: string;
    podCount?: number;
  } = {
    hasCache,
    docPath: docPath || undefined
  };

  if (hasCache) {
    result.cacheFile = cacheFile;
    try {
      const data = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      result.itemCount = data.metadata?.itemCount || data.items?.length;
      result.lastIndexed = data.metadata?.generatedAt;
      result.podCount = data.metadata?.podStats
        ? Object.keys(data.metadata.podStats).length
        : undefined;
    } catch (error) {
      logger.warn(`Failed to read cache metadata: ${error}`);
    }
  }

  return result;
}

/**
 * List available pods for an instance
 */
export async function listInstancePods(instanceId: number): Promise<PodInfo[]> {
  const db = getFantomDatabase();
  await db.initialize();

  const instance = await db.getInstanceById(instanceId);
  if (!instance) {
    throw new Error(`Instance not found: ${instanceId}`);
  }

  const docPath = getDocPath(instance.path, instance.type);
  if (!docPath || !isValidDocDirectory(docPath)) {
    return [];
  }

  const scanResult = await scanDocDirectory(docPath, instanceId, instance.version || undefined);
  return scanResult.pods;
}

/**
 * Clear documentation cache for an instance
 */
export function clearDocCache(instanceId: number): boolean {
  const cacheFile = getCacheFilePath(instanceId);
  if (fs.existsSync(cacheFile)) {
    fs.unlinkSync(cacheFile);
    logger.info(`Cleared doc cache for instance ${instanceId}`);
    return true;
  }
  return false;
}

/**
 * Clear all documentation caches
 */
export function clearAllDocCaches(): number {
  if (!fs.existsSync(CACHE_DIR)) {
    return 0;
  }

  let count = 0;
  const files = fs.readdirSync(CACHE_DIR);
  for (const file of files) {
    if (file.startsWith('flexsearch-local-') && file.endsWith('.json')) {
      fs.unlinkSync(path.join(CACHE_DIR, file));
      count++;
    }
  }

  logger.info(`Cleared ${count} doc caches`);
  return count;
}

/**
 * Search local documentation
 * Returns items matching the query with instance info
 *
 * Uses hybrid search (keyword + vector/semantic) with RRF fusion when
 * doc vectors are available. Falls back to keyword-only otherwise.
 *
 * For Haxall instances:
 * - If docSourceInstanceId is set, search the linked SkySpark instance's docs instead
 * - If docSourceInstanceId is not set, return empty results
 *
 * @param query - Search query string
 * @param options - Filter options:
 *   - instanceId: Filter by specific instance ID
 *   - instanceType: Filter by instance type ('skyspark', 'haxall', 'fantom')
 *   - pod: Filter by pod name
 *   - type: Filter by item type
 *   - language: Filter by language ('fantom', 'axon')
 *   - limit: Maximum results to return
 */
export async function searchLocalDocs(
  query: string,
  options: {
    instanceId?: number;
    instanceType?: 'skyspark' | 'haxall' | 'fantom';
    pod?: string;
    type?: LocalDocItem['type'];
    language?: 'fantom' | 'axon';
    limit?: number;
  } = {}
): Promise<LocalDocSearchResult[]> {
  const { hybridSearchLocalDocs } = await import('../../search/docsHybridSearchService.js');
  return hybridSearchLocalDocs(query, options);
}
