import { promises as fs } from 'fs';
import { join } from 'path';
import { ensureDir } from 'fs-extra';
import type { CachedIndex, CacheMetadata, FantomDocItem } from '../types/index.js';
import { createLogger } from '../utils/index.js';
import { getCacheDir, isCacheEnabled } from '../config/index.js';
import type { FantomConfig } from '../types/index.js';

const logger = createLogger('cache');

const CACHE_VERSION = '1.0.0';
const DOCS_CACHE_FILE = 'flexsearch-fantom.json';
const HAXALL_CACHE_FILE = 'flexsearch-haxall.json';
const CODE_CACHE_FILE = 'flexsearch-code.json';

/**
 * Cache manager for storing and retrieving indexed data
 */
export class CacheManager {
  private cacheDir: string;
  private enabled: boolean;

  constructor(config: FantomConfig) {
    this.cacheDir = getCacheDir(config);
    this.enabled = isCacheEnabled();
  }

  /**
   * Initialize cache directory
   */
  async initialize(): Promise<void> {
    if (!this.enabled) {
      logger.debug('Cache is disabled');
      return;
    }

    try {
      await ensureDir(this.cacheDir);
      logger.debug(`Cache directory initialized: ${this.cacheDir}`);
    } catch (error) {
      logger.error('Failed to initialize cache directory:', error);
      throw error;
    }
  }

  /**
   * Save documentation index to cache
   */
  async saveDocsIndex(items: FantomDocItem[]): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const cacheData: CachedIndex = {
      metadata: {
        version: CACHE_VERSION,
        timestamp: Date.now(),
        itemCount: items.length,
        source: 'fantom-docs',
      },
      items,
    };

    const cachePath = join(this.cacheDir, DOCS_CACHE_FILE);
    try {
      await fs.writeFile(cachePath, JSON.stringify(cacheData, null, 2), 'utf-8');
      logger.info(`Saved ${items.length} documentation items to cache`);
    } catch (error) {
      logger.error('Failed to save docs cache:', error);
      throw error;
    }
  }

  /**
   * Load documentation index from cache
   */
  async loadDocsIndex(): Promise<FantomDocItem[] | null> {
    if (!this.enabled) {
      return null;
    }

    const cachePath = join(this.cacheDir, DOCS_CACHE_FILE);
    try {
      const content = await fs.readFile(cachePath, 'utf-8');
      const cacheData: CachedIndex = JSON.parse(content);

      // Validate cache version
      if (cacheData.metadata.version !== CACHE_VERSION) {
        logger.warn('Cache version mismatch, ignoring cache');
        return null;
      }

      // Log detailed breakdown
      const byType: Record<string, number> = {};
      const byPod: Record<string, number> = {};
      for (const item of cacheData.items) {
        byType[item.type || 'unknown'] = (byType[item.type || 'unknown'] || 0) + 1;
        byPod[item.pod || 'unknown'] = (byPod[item.pod || 'unknown'] || 0) + 1;
      }

      logger.info(`Loaded ${cacheData.items.length} Fantom docs from cache:`);
      logger.info(`  Types: ${Object.entries(byType).map(([t, c]) => `${t}=${c}`).join(', ')}`);
      logger.info(`  Pods: ${Object.keys(byPod).length} (${Object.entries(byPod).slice(0, 5).map(([p, c]) => `${p}=${c}`).join(', ')}${Object.keys(byPod).length > 5 ? '...' : ''})`);

      return cacheData.items;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.debug('No cache file found');
        return null;
      }
      logger.error('Failed to load docs cache:', error);
      return null;
    }
  }

  /**
   * Save Haxall documentation index to cache
   */
  async saveHaxallIndex(items: FantomDocItem[]): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const cacheData: CachedIndex = {
      metadata: {
        version: CACHE_VERSION,
        timestamp: Date.now(),
        itemCount: items.length,
        source: 'haxall-docs',
      },
      items,
    };

    const cachePath = join(this.cacheDir, HAXALL_CACHE_FILE);
    try {
      await fs.writeFile(cachePath, JSON.stringify(cacheData, null, 2), 'utf-8');
      logger.info(`Saved ${items.length} Haxall documentation items to cache`);
    } catch (error) {
      logger.error('Failed to save Haxall cache:', error);
      throw error;
    }
  }

  /**
   * Load Haxall documentation index from cache
   */
  async loadHaxallIndex(): Promise<FantomDocItem[] | null> {
    if (!this.enabled) {
      return null;
    }

    const cachePath = join(this.cacheDir, HAXALL_CACHE_FILE);
    try {
      const content = await fs.readFile(cachePath, 'utf-8');
      const cacheData: CachedIndex = JSON.parse(content);

      // Validate cache version
      if (cacheData.metadata.version !== CACHE_VERSION) {
        logger.warn('Cache version mismatch, ignoring cache');
        return null;
      }

      // Log detailed breakdown
      const byType: Record<string, number> = {};
      const byPod: Record<string, number> = {};
      for (const item of cacheData.items) {
        byType[item.type || 'unknown'] = (byType[item.type || 'unknown'] || 0) + 1;
        byPod[item.pod || 'unknown'] = (byPod[item.pod || 'unknown'] || 0) + 1;
      }

      logger.info(`Loaded ${cacheData.items.length} Haxall docs from cache:`);
      logger.info(`  Types: ${Object.entries(byType).map(([t, c]) => `${t}=${c}`).join(', ')}`);
      logger.info(`  Pods: ${Object.keys(byPod).length} (${Object.entries(byPod).slice(0, 5).map(([p, c]) => `${p}=${c}`).join(', ')}${Object.keys(byPod).length > 5 ? '...' : ''})`);

      return cacheData.items;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.debug('No Haxall cache file found');
        return null;
      }
      logger.error('Failed to load Haxall cache:', error);
      return null;
    }
  }

  /**
   * Save code index to cache
   */
  async saveCodeIndex(items: any[]): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const cacheData: CachedIndex = {
      metadata: {
        version: CACHE_VERSION,
        timestamp: Date.now(),
        itemCount: items.length,
        source: 'fantom-code',
      },
      items,
    };

    const cachePath = join(this.cacheDir, CODE_CACHE_FILE);
    try {
      await fs.writeFile(cachePath, JSON.stringify(cacheData, null, 2), 'utf-8');
      logger.info(`Saved ${items.length} code items to cache`);
    } catch (error) {
      logger.error('Failed to save code cache:', error);
      throw error;
    }
  }

  /**
   * Load code index from cache
   */
  async loadCodeIndex(): Promise<any[] | null> {
    if (!this.enabled) {
      return null;
    }

    const cachePath = join(this.cacheDir, CODE_CACHE_FILE);
    try {
      const content = await fs.readFile(cachePath, 'utf-8');
      const cacheData: CachedIndex = JSON.parse(content);

      if (cacheData.metadata.version !== CACHE_VERSION) {
        logger.warn('Cache version mismatch, ignoring cache');
        return null;
      }

      logger.info(`Loaded ${cacheData.items.length} code items from cache`);
      return cacheData.items;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.debug('No code cache file found');
        return null;
      }
      logger.error('Failed to load code cache:', error);
      return null;
    }
  }

  /**
   * Clear all caches
   */
  async clearCache(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    try {
      const files = [DOCS_CACHE_FILE, HAXALL_CACHE_FILE, CODE_CACHE_FILE];
      for (const file of files) {
        const cachePath = join(this.cacheDir, file);
        try {
          await fs.unlink(cachePath);
          logger.debug(`Deleted cache file: ${file}`);
        } catch (error) {
          // Ignore if file doesn't exist
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        }
      }
      logger.info('Cache cleared');
    } catch (error) {
      logger.error('Failed to clear cache:', error);
      throw error;
    }
  }

  /**
   * Get cache metadata
   */
  async getCacheMetadata(type: 'docs' | 'haxall' | 'code'): Promise<CacheMetadata | null> {
    if (!this.enabled) {
      return null;
    }

    const file = type === 'docs' ? DOCS_CACHE_FILE : type === 'haxall' ? HAXALL_CACHE_FILE : CODE_CACHE_FILE;
    const cachePath = join(this.cacheDir, file);

    try {
      const content = await fs.readFile(cachePath, 'utf-8');
      const cacheData: CachedIndex = JSON.parse(content);
      return cacheData.metadata;
    } catch (error) {
      return null;
    }
  }
}
