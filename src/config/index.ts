import { config as dotenvConfig } from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { resolve, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import type { FantomConfig } from '../types/index.js';
import { getInstallRoot } from '../utils/installRoot.js';

// Load .env relative to this file's location, not process.cwd().
// When the MCP server is spawned via stdio from a foreign cwd
// (e.g. another project), cwd-relative .env loading fails and
// DATABASE_URL ends up unset, which breaks Prisma-backed tools.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// build/config/index.js -> repo root is two levels up
dotenvConfig({ path: path.resolve(__dirname, '../../.env') });

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: FantomConfig = {
  cacheDir: './.cache',
  searchSettings: {
    maxResults: 50,
    minScore: 0.3,
  },
};

/**
 * Load configuration from file and environment variables
 */
export function loadConfig(): FantomConfig {
  let fileConfig: Partial<FantomConfig> = {};

  // Try to load static install-time config
  try {
    const configPath = resolve(process.cwd(), 'fantom-config.json');
    const configContent = fs.readFileSync(configPath, 'utf-8');
    fileConfig = JSON.parse(configContent);
  } catch (error) {
    // Config file is optional, use defaults
    console.warn('No fantom-config.json found, using defaults');
  }

  // Layer dashboard-managed runtime config (config/fantomMcpServer-config.json)
  // on top so user choices made via the dashboard survive a restart.
  // Read through the crash-safe helper: a truncated/corrupt runtime config
  // (Jetsam-killed mid-write, or clobbered by a co-writer) recovers from
  // .backup instead of silently dropping ALL dashboard settings to defaults.
  const runtimePath = resolve(process.cwd(), 'config', 'fantomMcpServer-config.json');
  const runtimeConfig: Partial<FantomConfig> = readConfigFileWithRecovery(runtimePath);

  // Merge: defaults < fantom-config.json < runtime config < env vars
  const config: FantomConfig = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    ...runtimeConfig,
    cacheDir:
      process.env.CACHE_DIR
      || (runtimeConfig as any).cacheDir
      || fileConfig.cacheDir
      || DEFAULT_CONFIG.cacheDir,
    searchSettings: {
      ...DEFAULT_CONFIG.searchSettings,
      ...fileConfig.searchSettings,
      ...(runtimeConfig as any).searchSettings,
    },
    semanticSearch: {
      ...fileConfig.semanticSearch,
      ...(runtimeConfig as any).semanticSearch,
      ...(process.env.EMBEDDING_MODEL && { embeddingModel: process.env.EMBEDDING_MODEL }),
      ...(process.env.EMBEDDING_DIMENSIONS && { embeddingDimensions: parseInt(process.env.EMBEDDING_DIMENSIONS) }),
      ...(process.env.CODE_EMBEDDING_MODEL && { codeModel: process.env.CODE_EMBEDDING_MODEL }),
      ...(process.env.CODE_EMBEDDING_DIMENSIONS && { codeDimensions: parseInt(process.env.CODE_EMBEDDING_DIMENSIONS) }),
      ...(process.env.DOCS_EMBEDDING_MODEL && { docsModel: process.env.DOCS_EMBEDDING_MODEL }),
      ...(process.env.DOCS_EMBEDDING_DIMENSIONS && { docsDimensions: parseInt(process.env.DOCS_EMBEDDING_DIMENSIONS) }),
      ...(process.env.EMBEDDING_THREADS && { embeddingThreads: parseInt(process.env.EMBEDDING_THREADS) }),
      ...(process.env.EMBEDDING_BATCH_SIZE && { embeddingBatchSize: parseInt(process.env.EMBEDDING_BATCH_SIZE) }),
    },
  };

  return config;
}

/**
 * Get resolved cache directory path. When `config.cacheDir` is relative,
 * it resolves against fantom-mcp's install root — NOT process.cwd() —
 * so spawning the server from a client project's directory doesn't
 * create a stray .cache tree alongside the user's source.
 */
export function getCacheDir(config: FantomConfig): string {
  if (isAbsolute(config.cacheDir)) return config.cacheDir;
  return resolve(getInstallRoot(), config.cacheDir);
}

/**
 * Check if debug mode is enabled
 */
export function isDebugEnabled(): boolean {
  return process.env.DEBUG?.includes('fantom-mcp') || false;
}

/**
 * Check if cache is enabled
 */
export function isCacheEnabled(): boolean {
  return process.env.CACHE_ENABLED !== 'false';
}

/**
 * Atomically write JSON to `targetPath`: snapshot the current file to
 * `<target>.backup`, write to `<target>.tmp`, then rename over the target.
 * rename(2) is atomic on the same filesystem, so a crash/Jetsam-kill mid-write
 * can never leave a truncated file that fails to parse on the next boot. The
 * .backup is the recovery source for loadConfig().
 *
 * Exported so every writer of fantomMcpServer-config.json (here + the dashboard
 * updateSettings path in index.ts) uses the same crash-safe sequence.
 */
export function atomicWriteConfigFile(targetPath: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  // Snapshot to .backup ONLY if the current file is valid JSON. Otherwise a
  // corrupt/torn primary would overwrite the last-good backup, destroying the
  // recovery source (exactly how a single bad read previously wiped settings
  // AND the backup together).
  if (fs.existsSync(targetPath)) {
    try {
      JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
      fs.copyFileSync(targetPath, `${targetPath}.backup`);
    } catch { /* current is corrupt — keep the existing good .backup */ }
  }
  const tmpPath = `${targetPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2));
  fs.renameSync(tmpPath, targetPath);
}

/**
 * Crash-safe read of a JSON config file. On a parse failure (truncated by a
 * mid-write kill, or a torn read while another writer is mid-write) recover
 * from `<path>.backup` and restore it over the corrupt primary so the next
 * writer merges onto valid state. Returns {} only if BOTH are unreadable.
 *
 * CRITICAL: this exists because multiple components read+rewrite the SAME
 * fantomMcpServer-config.json (dashboard settings via updateSettings, the
 * sidecar registry on every heartbeat, primary-project). A reader that returns
 * {} on a bad parse and then writes the whole object back wipes every key it
 * didn't know about. Always read through this, never bare JSON.parse → {}.
 */
export function readConfigFileWithRecovery(targetPath: string): any {
  if (!fs.existsSync(targetPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
  } catch (err) {
    const backupPath = `${targetPath}.backup`;
    try {
      if (fs.existsSync(backupPath)) {
        const recovered = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
        try { fs.copyFileSync(backupPath, targetPath); } catch { /* best effort */ }
        console.warn(`[config] ${path.basename(targetPath)} unreadable (${(err as Error).message}); recovered from .backup`);
        return recovered;
      }
    } catch { /* backup also bad */ }
    console.warn(`[config] ${path.basename(targetPath)} unreadable and no usable .backup; using {}`);
    return {};
  }
}

/**
 * Save the primary project configuration
 */
export function savePrimaryProject(instance: string, project: string): void {
  const configPath = path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');
  let config: any = {};
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }
  config.primaryProject = { instance, project };
  atomicWriteConfigFile(configPath, config);
}

/**
 * Load the primary project configuration
 */
export function loadPrimaryProject(): { instance: string; project: string } | null {
  const configPath = path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return config.primaryProject || null;
  } catch {
    return null;
  }
}

/**
 * Load the server configuration (port, etc.)
 */
export function loadServerConfig(): { port?: number } {
  const configPath = path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');
  if (!fs.existsSync(configPath)) return {};
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return { port: config.port };
  } catch {
    return {};
  }
}

/**
 * Get the configured port (config file > env var > default)
 */
export function getServerPort(): number {
  const serverConfig = loadServerConfig();
  return serverConfig.port || parseInt(process.env.MCP_PORT || '3847');
}
