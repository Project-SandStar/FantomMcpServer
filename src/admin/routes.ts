/**
 * Admin API routes for the Fantom MCP Server dashboard
 */

import { Router, Request, Response, NextFunction } from 'express';
import { registerAxonRoutes } from './axonRoutes.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AdminContext, AuthenticatedUser } from './types.js';
import { getUserStore, UserStore } from './userStore.js';
import { compilePod, getCompileLogs, getCompileLog, getRunningCompilations } from '../fantom/compiler.js';
import {
  parseInstanceDocs,
  listInstancePods,
  getDocStatus,
  clearDocCache
} from '../parser/local/index.js';
import { DEFAULT_EXCLUDE_DIRS } from '../fantom-code/excludeDirs.js';
import { logFilePaths, listSeenSegments } from '../utils/logSink.js';
import {
  registerAutoEmbedStarter,
  startSidecarRetryWatchdog,
  registerEmbedMissingChecker,
  startEmbedMissingWatchdog,
} from '../embedding/autoPipelineBus.js';
import { getFantomCodeIndexer, getFantomBuildIndexer } from '../fantom-code/index.js';
import { FantomPod } from '../fantom/types.js';
import {
  detectFantomVersionWithSource,
  getAvailableFantomVersions
} from '../fantom/versionDetector.js';
import { isLadybugInitialized, ladybugQuery } from '../graph/ladybugConnection.js';
import { invalidateProjectNodeCount } from '../graph/projectNodeCounts.js';
import { getLadybugQueryManager } from '../graph/ladybugQueryManager.js';
import {
  listSidecars,
  getSidecar,
  createSidecar,
  updateSidecar,
  deleteSidecar,
  pingSidecar,
  listAvailableModels,
} from '../sidecars/registry.js';
import type { Sidecar, SidecarCapabilityKind } from './types.js';

/**
 * Compare two semver-like version strings
 * Returns: -1 if v1 < v2, 0 if v1 == v2, 1 if v1 > v2
 */
function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split('.').map(p => parseInt(p, 10) || 0);
  const parts2 = v2.split('.').map(p => parseInt(p, 10) || 0);

  const maxLength = Math.max(parts1.length, parts2.length);

  for (let i = 0; i < maxLength; i++) {
    const num1 = parts1[i] || 0;
    const num2 = parts2[i] || 0;

    if (num1 < num2) return -1;
    if (num1 > num2) return 1;
  }

  return 0;
}

/**
 * Normalize a filesystem path so '~' and relative segments compare equal
 * to a fully-expanded absolute path. Used when matching projects to pods
 * whose paths may have been stored in either form.
 */
function normalizePath(p: string | null | undefined): string {
  if (!p) return '';
  let expanded = p;
  if (expanded === '~' || expanded.startsWith('~/')) {
    expanded = path.join(os.homedir(), expanded.slice(1));
  }
  return path.resolve(expanded);
}

/**
 * Check if a pod is compatible with a given version
 * Returns true if:
 * - Version falls within min/max range (inclusive)
 * - OR version is in the compatVersions array
 * - OR no compatibility constraints are set (compatible with all)
 */
function isVersionCompatible(pod: FantomPod, version: string): boolean {
  // If no compatibility constraints, pod is compatible with everything
  if (!pod.compatMinVersion && !pod.compatMaxVersion && (!pod.compatVersions || pod.compatVersions.length === 0)) {
    return true;
  }

  // Check if version is in explicit compatVersions array
  if (pod.compatVersions && pod.compatVersions.length > 0) {
    if (pod.compatVersions.includes(version)) {
      return true;
    }
  }

  // Check min/max range
  let inRange = true;

  if (pod.compatMinVersion) {
    if (compareVersions(version, pod.compatMinVersion) < 0) {
      inRange = false;
    }
  }

  if (pod.compatMaxVersion && inRange) {
    if (compareVersions(version, pod.compatMaxVersion) > 0) {
      inRange = false;
    }
  }

  // If both min and max are set, check the range
  if (pod.compatMinVersion || pod.compatMaxVersion) {
    return inRange;
  }

  // If only compatVersions was set but version wasn't in it
  return false;
}

/**
 * Extension to language mapping
 */
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.fan': 'fantom',
  '.fwt': 'fantom',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.dart': 'dart',
  '.py': 'python',
  '.pyw': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.swift': 'swift',
  '.cs': 'csharp',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.c': 'c',
  '.h': 'c',
  '.hpp': 'cpp',
  '.hxx': 'cpp',
  '.php': 'php',
  '.scala': 'scala',
  '.clj': 'clojure',
  '.cljs': 'clojure',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.erl': 'erlang',
  '.hrl': 'erlang',
  '.hs': 'haskell',
  '.lhs': 'haskell',
  '.ml': 'ocaml',
  '.mli': 'ocaml',
  '.fs': 'fsharp',
  '.fsx': 'fsharp',
  '.lua': 'lua',
  '.pl': 'perl',
  '.pm': 'perl',
  '.r': 'r',
  '.R': 'r',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.fish': 'shell',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.sql': 'sql',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'sass',
  '.less': 'less',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.xml': 'xml',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.rst': 'restructuredtext',
  '.txt': 'text',
  '.axon': 'axon',
  '.trio': 'trio',
  '.zinc': 'zinc'
};

/**
 * Language detection result for a directory
 */
interface LanguageInfo {
  name: string;
  files: number;
  extensions: string[];
}

interface LanguageDetectionResult {
  languages: LanguageInfo[];
  totalFiles: number;
}

/**
 * Recursively scan a directory and detect all programming languages
 */
function detectLanguagesInDirectory(dirPath: string): LanguageDetectionResult {
  const extensionCounts: Record<string, number> = {};
  let totalFiles = 0;
  // Trio files often carry axon function bodies in `src:` fields. Track which
  // trios contain axon so we can surface axon as a top-level language even
  // when there are no standalone `.axon` files in the tree.
  const trioFilePaths: string[] = [];
  // Use the shared exclude set (imported at the top of the file). The earlier
  // require() worked under CJS but threw "require is not defined" under ESM,
  // which surfaced as the dashboard "AST" tab returning Internal Server Error.
  function scanDir(currentPath: string): void {
    try {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (DEFAULT_EXCLUDE_DIRS.has(entry.name)) continue;

        const fullPath = path.join(currentPath, entry.name);

        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (ext && EXTENSION_TO_LANGUAGE[ext]) {
            extensionCounts[ext] = (extensionCounts[ext] || 0) + 1;
            totalFiles++;
            if (ext === '.trio') trioFilePaths.push(fullPath);
          }
        }
      }
    } catch {
      // Silently skip directories we can't read
    }
  }

  scanDir(dirPath);

  // Count trio files containing axon function records. Cheap heuristic: a
  // record with a `func` marker on its own line plus a `src:` field is an
  // axon function (same pattern TrioParser.recordToFunction looks for).
  let trioFilesWithAxon = 0;
  let axonFunctionCount = 0;
  for (const p of trioFilePaths) {
    try {
      const txt = fs.readFileSync(p, 'utf-8');
      const matches = txt.match(/^func\s*$/gm);
      if (matches && /^src\s*:/m.test(txt)) {
        trioFilesWithAxon++;
        axonFunctionCount += matches.length;
      }
    } catch { /* skip unreadable */ }
  }

  // Group extensions by language
  const languageMap: Record<string, { files: number; extensions: Set<string> }> = {};

  for (const [ext, count] of Object.entries(extensionCounts)) {
    const lang = EXTENSION_TO_LANGUAGE[ext];
    if (!languageMap[lang]) {
      languageMap[lang] = { files: 0, extensions: new Set() };
    }
    languageMap[lang].files += count;
    languageMap[lang].extensions.add(ext);
  }

  // Convert to array and sort by file count descending
  const languages: LanguageInfo[] = Object.entries(languageMap)
    .map(([name, data]) => ({
      name,
      files: data.files,
      extensions: Array.from(data.extensions).sort()
    }))
    .sort((a, b) => b.files - a.files);

  // Promote axon to top-level when trio files carry axon function records.
  // Don't subtract from the trio entry — the file is both trio AND axon.
  if (trioFilesWithAxon > 0 && !languageMap['axon']) {
    languages.push({
      name: 'axon',
      files: trioFilesWithAxon,
      extensions: ['(in .trio src:)'],
      // Extra hint for clients that want it — non-breaking addition.
      ...(axonFunctionCount > 0 ? { functions: axonFunctionCount } : {}),
    } as LanguageInfo & { functions?: number });
    languages.sort((a, b) => b.files - a.files);
  } else if (trioFilesWithAxon > 0 && languageMap['axon']) {
    // Merge counts when standalone .axon files also exist.
    const axonEntry = languages.find(l => l.name === 'axon');
    if (axonEntry) {
      axonEntry.files += trioFilesWithAxon;
      if (!axonEntry.extensions.includes('(in .trio src:)')) {
        axonEntry.extensions = [...axonEntry.extensions, '(in .trio src:)'];
      }
    }
    languages.sort((a, b) => b.files - a.files);
  }

  return { languages, totalFiles };
}

/**
 * Detect the primary language of a project directory.
 * Returns language and parserType suitable for project creation.
 */
function detectProjectLanguage(dirPath: string): { language: string; parserType: string } {
  const result = detectLanguagesInDirectory(dirPath);
  const NON_SOURCE_LANGS = new Set(['json', 'yaml', 'markdown', 'text']);

  // Pick the dominant language by file count. The legacy implementation
  // short-circuited on any presence of `.vue` files — which mistagged
  // TypeScript projects containing a single .vue example as "vue". The
  // sorted list from detectLanguagesInDirectory is already files-desc.
  const sourceLangs = result.languages.filter(l => !NON_SOURCE_LANGS.has(l.name));
  if (sourceLangs.length === 0) {
    return { language: 'fantom', parserType: 'regex' };
  }

  const dominant = sourceLangs[0].name;
  if (dominant === 'fantom') {
    return { language: 'fantom', parserType: 'regex' };
  }

  return { language: dominant, parserType: 'tree-sitter-wasm' };
}

/**
 * Basic Auth middleware using UserStore
 * Authenticates users and attaches user info to the request
 */
function basicAuthWithUserStore(userStore: UserStore) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Basic ')) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Fantom MCP Admin"');
      return res.status(401).json({ error: 'Authentication required' });
    }

    const base64 = authHeader.split(' ')[1];
    const decoded = Buffer.from(base64, 'base64').toString();
    const colonIndex = decoded.indexOf(':');

    if (colonIndex === -1) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Fantom MCP Admin"');
      return res.status(401).json({ error: 'Invalid credentials format' });
    }

    const username = decoded.substring(0, colonIndex);
    const password = decoded.substring(colonIndex + 1);

    const user = userStore.authenticatePublic(username, password);

    if (user) {
      // Attach user to request for downstream handlers
      req.user = user as AuthenticatedUser;
      return next();
    }

    res.setHeader('WWW-Authenticate', 'Basic realm="Fantom MCP Admin"');
    return res.status(401).json({ error: 'Invalid credentials' });
  };
}

/**
 * Role-based access control middleware
 * Requires the user to have the 'admin' role
 */
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }

  next();
}

/**
 * Parse parameter info from a signature string like "Str myMethod(Int x, Str? name: null)"
 */
function parseParamsFromSignature(sig: string | null): Array<{ name: string; type: string; default?: string }> {
  if (!sig) return [];
  const match = sig.match(/\(([^)]*)\)/);
  if (!match || !match[1].trim()) return [];
  return match[1].split(',').map(p => {
    const trimmed = p.trim();
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      const [type, ...rest] = parts;
      const nameAndDefault = rest.join(' ');
      const [name, ...defaultParts] = nameAndDefault.split(':');
      return {
        name: name.trim(),
        type: type.trim(),
        ...(defaultParts.length ? { default: defaultParts.join(':').trim() } : {})
      };
    }
    return { name: trimmed, type: 'unknown' };
  });
}

/**
 * Create admin router with injected dependencies
 */
export function createAdminRouter(context: AdminContext): Router {
  const router = Router();
  const userStore = getUserStore(context.configDir);

  // Apply Basic Auth using UserStore to all admin routes
  router.use(basicAuthWithUserStore(userStore));

  // Pretty-print JSON for all admin routes
  router.use((_req: Request, res: Response, next: NextFunction) => {
    res.json = (data: unknown) => {
      res.type('application/json');
      return res.send(JSON.stringify(data, null, 2));
    };
    next();
  });

  // ============================================
  // Root endpoint - API index
  // ============================================

  router.get('/', (_req: Request, res: Response) => {
    res.json({
      name: 'Fantom MCP Admin API',
      version: '1.0.0',
      endpoints: {
        status: {
          'GET /admin/status': 'Server status and stats'
        },
        'primary-project': {
          'GET /admin/primary-project': 'Get current primary project',
          'POST /admin/primary-project': 'Set primary project'
        },
        cache: {
          'GET /admin/cache': 'List cache files',
          'POST /admin/cache/clear': 'Clear cache'
        },
        logs: {
          'GET /admin/logs': 'Real-time log stream (SSE)'
        },
        tools: {
          'GET /admin/tools': 'List all MCP tools with schemas',
          'GET /admin/tools/:name': 'Get specific tool by name'
        },
        settings: {
          'GET /admin/settings': 'Get server settings',
          'PUT /admin/settings': 'Update server settings',
          'GET /admin/settings/fantom-source-folder': 'Get Fantom source folder path',
          'POST /admin/settings/fantom-source-folder': 'Set Fantom source folder path',
          'GET /admin/settings/dashboard': 'Get dashboard settings (server URL)',
          'POST /admin/settings/dashboard': 'Set dashboard settings (server URL)'
        },
        'fantom-versions': {
          'GET /admin/fantom-versions': 'List available Fantom versions from source folder',
          'POST /admin/detect-fantom-version': 'Detect Fantom version from instance path'
        },
        'fantom-builds': {
          'GET /admin/fantom-builds': 'List all Fantom builds',
          'GET /admin/fantom-builds/:id': 'Get build by ID',
          'POST /admin/fantom-builds': 'Create a new build',
          'POST /admin/fantom-builds/scan': 'Scan source folder and register builds',
          'POST /admin/fantom-builds/index-all': 'Index all builds with source code',
          'POST /admin/fantom-builds/:id/index': 'Index a build (parse source code)',
          'POST /admin/fantom-builds/:id/clear': 'Clear index for a build',
          'DELETE /admin/fantom-builds/:id': 'Delete a build'
        },
        usage: {
          'GET /admin/usage': 'Usage statistics',
          'GET /admin/usage/database': 'Usage database info',
          'POST /admin/usage/clear': 'Clear usage data',
          'POST /admin/usage/reset': 'Reset usage database'
        },
        docs: {
          'GET /admin/docs/search': 'Search documentation',
          'GET /admin/pods': 'List indexed pods',
          'POST /admin/docs/index-all': 'Index documentation for all instances',
          'POST /admin/docs/embed-all': 'Embed documentation vectors for all instances'
        },
        instances: {
          'GET /admin/instances': 'List all Fantom instances',
          'GET /admin/instances/:id': 'Get instance by ID',
          'POST /admin/instances': 'Create a new instance',
          'PUT /admin/instances/:id': 'Update an instance',
          'DELETE /admin/instances/:id': 'Delete an instance',
          'POST /admin/instances/:id/validate': 'Validate instance path',
          'GET /admin/instances/:id/docs': 'Get documentation status',
          'POST /admin/instances/:id/docs/index': 'Index/refresh documentation',
          'GET /admin/instances/:id/docs/search': 'Search instance documentation',
          'GET /admin/instances/:id/docs/pods': 'List documentation pods',
          'POST /admin/instances/:id/docs/embed': 'Embed documentation vectors for instance',
          'DELETE /admin/instances/:id/docs/cache': 'Clear documentation cache',
          'GET /admin/instances/:id/source': 'Get source code indexing status',
          'POST /admin/instances/:id/source/index': 'Index source code for instance',
          'GET /admin/instances/:id/source/pods': 'List pods found in source code'
        },
        'fantom-pods': {
          'GET /admin/fantom-pods': 'List all Fantom pods (query: compatibleWith=<version>)',
          'GET /admin/fantom-pods/:id': 'Get pod by ID',
          'POST /admin/fantom-pods': 'Create a new pod (body: compatMinVersion, compatMaxVersion, compatVersions)',
          'PUT /admin/fantom-pods/:id': 'Update a pod (body: compatMinVersion, compatMaxVersion, compatVersions)',
          'DELETE /admin/fantom-pods/:id': 'Delete a pod',
          'GET /admin/fantom-pods/:id/build-files': 'List available build files',
          'GET /admin/fantom-pods/:id/compile-logs': 'Get compilation history',
          'GET /admin/fantom-pods/:id/languages': 'Detect languages in a pod',
          'POST /admin/fantom-pods/index-all-ast': 'Create code projects and index AST for all pods'
        },
        'active-instance': {
          'GET /admin/active-instance': 'Get active instance',
          'POST /admin/active-instance': 'Set active instance'
        },
        compile: {
          'POST /admin/compile': 'Compile a pod',
          'GET /admin/compile/:logId': 'Get compile log',
          'GET /admin/compile/running': 'Get running compilations'
        },
        'code-projects': {
          'GET /admin/code-projects': 'List all Fantom code projects',
          'GET /admin/code-projects/:id': 'Get code project by ID',
          'POST /admin/code-projects': 'Create a new code project',
          'PUT /admin/code-projects/:id': 'Update a code project',
          'DELETE /admin/code-projects/:id': 'Delete a code project',
          'POST /admin/code-projects/:id/reindex': 'Re-index a code project',
          'GET /admin/code-projects/:id/languages': 'Detect languages in a code project',
          'GET /admin/code-projects/:id/dependencies': 'Project dependencies (dependsOn/dependents/declared/scope)',
          'POST /admin/code-projects/:id/dependencies': 'Add a manual dependency { toProjectId }',
          'PATCH /admin/code-projects/:id/dependencies/:depId': 'Enable/disable a dependency { enabled }',
          'DELETE /admin/code-projects/:id/dependencies/:depId': 'Delete a manual dependency (?force=1 for automatic)',
          'POST /admin/code-projects/:id/dependencies/rebuild': 'Recompute automatic dependencies of a project',
          'POST /admin/code-projects/dependencies/rebuild-all': 'Recompute automatic dependencies of all projects',
          'GET /admin/project-dependencies/summary': 'Per-project dependency counts',
          'GET /admin/code-stats': 'Get code index statistics',
          'POST /admin/reindex': 'Enable autoIndex for all projects and rebuild search index',
          'POST /admin/graph/rebuild': 'Rebuild code graphs for all projects (callers/callees)',
          'POST /admin/graph/backfill-ladybug': 'Copy code graph from SQLite/Prisma into LadybugDB (projectId=<id|all>&dryRun=<bool>&mode=<fast|unwind>)',
          'GET /admin/graph/ladybug-stats': 'LadybugDB node/edge counts (optional projectId=<id>)'
        },
        'ast-cache': {
          'GET /admin/ast-cache': 'Get AST cache status for all pods'
        },
        backups: {
          'GET /admin/backups': 'List all backups',
          'POST /admin/backups': 'Create a new backup (Admin only)',
          'GET /admin/backups/:id': 'Get backup details',
          'GET /admin/backups/:id/download': 'Download backup ZIP file',
          'POST /admin/backups/:id/restore': 'Restore from backup (Admin only, requires confirm: true)',
          'DELETE /admin/backups/:id': 'Delete a backup (Admin only)'
        }
      },
      dashboard: '/dashboard'
    });
  });

  // ============================================
  // Status endpoint
  // ============================================

  router.get('/status', (_req: Request, res: Response) => {
    try {
      const status = context.getServerStatus();
      res.json(status);
    } catch (error) {
      console.error('[Admin] Failed to get server status:', error);
      res.status(500).json({ error: 'Failed to get server status', details: error instanceof Error ? error.message : String(error) });
    }
  });

  // ============================================
  // Cache endpoints
  // ============================================

  router.get('/cache', (_req: Request, res: Response) => {
    try {
      const caches = context.getCacheInfo();
      res.json(caches);
    } catch (error) {
      res.status(500).json({ error: 'Failed to get cache info' });
    }
  });

  router.post('/cache/clear', async (req: Request, res: Response) => {
    try {
      const { name } = req.body || {};
      await context.clearCache(name);
      res.json({ success: true, cleared: name || 'all' });
    } catch (error) {
      res.status(500).json({ error: 'Failed to clear cache' });
    }
  });

  // ============================================
  // Log endpoint (SSE stream)
  // ============================================

  router.get('/logs', (req: Request, res: Response) => {
    // SSE stream for real-time logs
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send recent logs first
    const logs = context.getLogBuffer();
    for (const log of logs) {
      res.write(`data: ${JSON.stringify({ message: log, timestamp: new Date().toISOString() })}\n\n`);
    }

    // Keep connection alive
    const interval = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 30000);

    req.on('close', () => {
      clearInterval(interval);
    });
  });

  // ============================================
  // Debug log endpoints — tail / SSE / download for the on-disk log files
  // under <repo>/logs/. The dashboard's Debug tab uses these. Resolves the
  // active path from logSink so a future config change to logsDir takes
  // effect without changing this file.
  // ============================================
  const paths = logFilePaths();
  // Default tail target: combined async file. The /:segment/* variants
  // below let the dashboard tail individual segments. The crash file is
  // separately surfaced because it's the SIGKILL-survivable trail and
  // operators usually want it as a primary view.
  const sanitizeSegment = (s: string): string | null => {
    // Allow only word chars + dash + underscore + dot. Tags from
    // createLogger() match this pattern; reject anything else to avoid
    // path traversal.
    return /^[A-Za-z0-9_.\-]+$/.test(s) ? s : null;
  };
  const resolveLogTarget = (segment: string | undefined): string => {
    if (!segment) return paths.all;
    if (segment === '_crash') return paths.crash;
    return paths.segment(segment);
  };
  const tailLogFile = async (filePath: string, tail: number): Promise<{ path: string; lines: string[]; size: number }> => {
    const fs = await import('node:fs');
    if (!fs.existsSync(filePath)) return { path: filePath, lines: [], size: 0 };
    const stat = fs.statSync(filePath);
    const READ_BYTES = 2 * 1024 * 1024;
    const start = Math.max(0, stat.size - READ_BYTES);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const allLines = buf.toString('utf-8').split('\n');
    return { path: filePath, lines: allLines.slice(-tail), size: stat.size };
  };

  // Lists every segment tag the running server has emitted. Drives the
  // checkbox grid in the Debug panel without hardcoding the 41 tags.
  router.get('/debug/segments', async (_req: Request, res: Response): Promise<void> => {
    res.json({ segments: listSeenSegments(), logsDir: paths.logsDir });
  });

  router.get('/debug/log', async (req: Request, res: Response): Promise<void> => {
    try {
      const tailRaw = Number(req.query.tail);
      const tail = Number.isFinite(tailRaw) && tailRaw > 0 ? Math.min(10000, tailRaw) : 500;
      // Default to the crash file when present (forensics-first), fall back
      // to the combined async file. The dashboard can pick explicitly via
      // ?source=all or /debug/log/:segment.
      const source = String(req.query.source ?? 'crash');
      const target = source === 'all' ? paths.all : paths.crash;
      res.json(await tailLogFile(target, tail));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/debug/log/:segment', async (req: Request, res: Response): Promise<void> => {
    const seg = sanitizeSegment(String(req.params.segment));
    if (!seg) { res.status(400).json({ error: 'invalid segment' }); return; }
    const tailRaw = Number(req.query.tail);
    const tail = Number.isFinite(tailRaw) && tailRaw > 0 ? Math.min(10000, tailRaw) : 500;
    res.json(await tailLogFile(resolveLogTarget(seg), tail));
  });

  router.get('/debug/log/download', async (_req: Request, res: Response): Promise<void> => {
    try {
      const fs = await import('node:fs');
      const target = paths.crash;
      if (!fs.existsSync(target)) { res.status(404).json({ error: 'log file not found' }); return; }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="fantom-mcp-crash.log"');
      fs.createReadStream(target).pipe(res);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/debug/log/:segment/download', async (req: Request, res: Response): Promise<void> => {
    try {
      const seg = sanitizeSegment(String(req.params.segment));
      if (!seg) { res.status(400).json({ error: 'invalid segment' }); return; }
      const fs = await import('node:fs');
      const target = resolveLogTarget(seg);
      if (!fs.existsSync(target)) { res.status(404).json({ error: 'log file not found' }); return; }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${seg}.log"`);
      fs.createReadStream(target).pipe(res);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // SSE follower factory — used by both /debug/log/stream (combined crash
  // file) and /debug/log/:segment/stream.
  const streamLogFile = async (filePath: string, req: Request, res: Response): Promise<void> => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const fs = await import('node:fs');
    let lastSize = 0;
    try { lastSize = fs.statSync(filePath).size; } catch { /* file may not exist yet */ }
    const tick = setInterval(() => {
      try {
        if (!fs.existsSync(filePath)) return;
        const stat = fs.statSync(filePath);
        if (stat.size <= lastSize) {
          if (stat.size < lastSize) lastSize = stat.size;
          return;
        }
        const fd = fs.openSync(filePath, 'r');
        const len = stat.size - lastSize;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, lastSize);
        fs.closeSync(fd);
        lastSize = stat.size;
        const lines = buf.toString('utf-8').split('\n').filter(Boolean);
        for (const line of lines) res.write(`data: ${JSON.stringify({ line })}\n\n`);
      } catch { /* ignore transient read errors */ }
    }, 1000);
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 30000);
    req.on('close', () => {
      clearInterval(tick);
      clearInterval(keepalive);
    });
  };

  router.get('/debug/log/stream', async (req: Request, res: Response): Promise<void> => {
    const source = String(req.query.source ?? 'crash');
    await streamLogFile(source === 'all' ? paths.all : paths.crash, req, res);
  });

  router.get('/debug/log/:segment/stream', async (req: Request, res: Response): Promise<void> => {
    const seg = sanitizeSegment(String(req.params.segment));
    if (!seg) { res.status(400).json({ error: 'invalid segment' }); return; }
    await streamLogFile(resolveLogTarget(seg), req, res);
  });

  // ============================================
  // Primary Project endpoints
  // ============================================

  router.get('/primary-project', (_req: Request, res: Response): void => {
    try {
      const primaryProject = context.getPrimaryProject();
      if (!primaryProject) {
        res.json({
          error: 'No primary project set',
          message: 'Use POST /admin/primary-project or setPrimaryProject MCP tool to set one'
        });
        return;
      }
      res.json(primaryProject);
    } catch (error) {
      res.status(500).json({ error: 'Failed to get primary project' });
    }
  });

  router.post('/primary-project', async (req: Request, res: Response): Promise<void> => {
    try {
      const { instance, project, setBy } = req.body;
      if (!instance || !project) {
        res.status(400).json({ error: 'Missing required fields: instance, project' });
        return;
      }

      // Accept setBy from request, default to 'api' for backwards compatibility
      const source = setBy || 'api';
      const result = await context.setPrimaryProject(instance, project, source);
      res.json({
        success: true,
        ...result,
        message: `Primary project set to ${instance}/${project}`
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: 'Failed to set primary project', details: message });
    }
  });

  // ============================================
  // Usage endpoint (optional)
  // ============================================

  router.get('/usage', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getUsageStats) {
        res.status(501).json({ error: 'Usage statistics not available' });
        return;
      }
      const days = parseInt(req.query.days as string) || 7;
      const stats = await context.getUsageStats(days);
      res.json(stats);
    } catch (error) {
      console.error('[Admin] Failed to get usage stats:', error);
      res.status(500).json({ error: 'Failed to get usage stats', details: String(error) });
    }
  });

  // ============================================
  // MCP Tools endpoints
  // ============================================

  router.get('/tools', (_req: Request, res: Response): void => {
    try {
      const tools = context.getAvailableTools();
      res.json({
        count: tools.length,
        tools: tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          category: tool.category || 'uncategorized',
          mcpExposed: tool.mcpExposed ?? false,
          inputSchema: tool.inputSchema
        }))
      });
    } catch (error) {
      console.error('[Admin] Failed to get tools:', error);
      res.status(500).json({ error: 'Failed to get tools' });
    }
  });

  router.get('/tools/:name', (req: Request, res: Response): void => {
    try {
      const tools = context.getAvailableTools();
      const tool = tools.find(t => t.name === req.params.name);
      if (!tool) {
        res.status(404).json({ error: 'Tool not found', name: req.params.name });
        return;
      }
      res.json(tool);
    } catch (error) {
      console.error('[Admin] Failed to get tool:', error);
      res.status(500).json({ error: 'Failed to get tool' });
    }
  });

  // ============================================
  // Settings endpoints
  // ============================================

  router.get('/settings', (_req: Request, res: Response): void => {
    try {
      const settings = context.getSettings();
      res.json(settings);
    } catch (error) {
      console.error('[Admin] Failed to get settings:', error);
      res.status(500).json({ error: 'Failed to get settings' });
    }
  });

  router.put('/settings', async (req: Request, res: Response): Promise<void> => {
    try {
      await context.updateSettings(req.body);
      res.json({ success: true, message: 'Settings updated' });
    } catch (error) {
      console.error('[Admin] Failed to update settings:', error);
      res.status(500).json({ error: 'Failed to update settings', details: String(error) });
    }
  });

  // ============================================
  // Fantom Source Folder Settings
  // ============================================

  router.get('/settings/fantom-source-folder', async (_req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Fantom database not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const path = await db.getFantomSourceFolder();
      res.json({ path });
    } catch (error) {
      console.error('[Admin] Failed to get Fantom source folder:', error);
      res.status(500).json({ error: 'Failed to get Fantom source folder' });
    }
  });

  router.post('/settings/fantom-source-folder', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Fantom database not available' });
        return;
      }
      const { path: folderPath } = req.body;
      if (!folderPath) {
        res.status(400).json({ error: 'path is required' });
        return;
      }

      // Validate the path exists
      if (!fs.existsSync(folderPath)) {
        res.status(400).json({ error: `Path does not exist: ${folderPath}` });
        return;
      }

      const db = await context.getFantomDatabase();
      await db.setFantomSourceFolder(folderPath);
      res.json({ success: true, path: folderPath });
    } catch (error) {
      console.error('[Admin] Failed to set Fantom source folder:', error);
      res.status(500).json({ error: 'Failed to set Fantom source folder', details: String(error) });
    }
  });

  // ============================================
  // OAuth Settings
  // ============================================

  router.get('/settings/oauth', async (_req: Request, res: Response): Promise<void> => {
    try {
      // Check current runtime status
      const runtimeEnabled = process.env.OAUTH_ENABLED === 'true';

      // Read configured value from .env file if it exists
      const envPath = path.join(process.cwd(), '.env');
      let configuredEnabled: boolean | null = null;

      if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf-8');
        const match = envContent.match(/^OAUTH_ENABLED\s*=\s*(.+)$/m);
        if (match) {
          configuredEnabled = match[1].trim().toLowerCase() === 'true';
        }
      }

      res.json({
        runtimeEnabled,
        configuredEnabled,
        requiresRestart: configuredEnabled !== null && configuredEnabled !== runtimeEnabled,
        message: runtimeEnabled
          ? 'OAuth is currently enabled'
          : 'OAuth is currently disabled'
      });
    } catch (error) {
      console.error('[Admin] Failed to get OAuth settings:', error);
      res.status(500).json({ error: 'Failed to get OAuth settings' });
    }
  });

  router.post('/settings/oauth', async (req: Request, res: Response): Promise<void> => {
    try {
      const { enabled } = req.body;

      if (typeof enabled !== 'boolean') {
        res.status(400).json({ error: 'enabled must be a boolean' });
        return;
      }

      const envPath = path.join(process.cwd(), '.env');
      let envContent = '';

      // Read existing .env file if it exists
      if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf-8');
      }

      // Update or add OAUTH_ENABLED line
      const oauthLine = `OAUTH_ENABLED=${enabled}`;
      if (envContent.match(/^OAUTH_ENABLED\s*=/m)) {
        // Replace existing line
        envContent = envContent.replace(/^OAUTH_ENABLED\s*=.+$/m, oauthLine);
      } else {
        // Add new line
        envContent = envContent.trim() + (envContent.trim() ? '\n' : '') + oauthLine + '\n';
      }

      // Write back to .env file
      fs.writeFileSync(envPath, envContent, 'utf-8');

      const runtimeEnabled = process.env.OAUTH_ENABLED === 'true';

      res.json({
        success: true,
        configuredEnabled: enabled,
        runtimeEnabled,
        requiresRestart: enabled !== runtimeEnabled,
        message: enabled !== runtimeEnabled
          ? `OAuth will be ${enabled ? 'enabled' : 'disabled'} after server restart`
          : `OAuth is already ${enabled ? 'enabled' : 'disabled'}`
      });
    } catch (error) {
      console.error('[Admin] Failed to set OAuth settings:', error);
      res.status(500).json({ error: 'Failed to set OAuth settings', details: String(error) });
    }
  });

  /**
   * Token Grant endpoint - issues OAuth tokens directly for authenticated users.
   * This allows the dashboard to auto-authenticate MCP when user is already
   * logged in via Basic Auth, without requiring the OAuth redirect flow.
   */
  router.post('/oauth/token-grant', async (req: Request, res: Response): Promise<void> => {
    try {
      // Check if OAuth is enabled
      const oauthEnabled = process.env.OAUTH_ENABLED === 'true';
      if (!oauthEnabled) {
        res.status(400).json({
          error: 'OAuth is not enabled',
          message: 'OAuth must be enabled to use token grant'
        });
        return;
      }

      // Get the OAuth provider
      const oauthProvider = context.getOAuthProvider?.();
      if (!oauthProvider) {
        res.status(503).json({
          error: 'OAuth provider not initialized',
          message: 'OAuth provider is not available yet. Try again in a moment.'
        });
        return;
      }

      // User is already authenticated via Basic Auth middleware (req.user is set)
      const user = req.user;
      if (!user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      // Get client ID from request (optional - if not provided, use a default dashboard client ID)
      const { clientId, scope } = req.body;
      const effectiveClientId = clientId || 'dashboard-auto-auth';
      const effectiveScope = scope || 'mcp:tools mcp:resources';

      // Get user agent and IP for session tracking
      const userAgent = req.headers['user-agent'];
      const ipAddress = req.ip || req.socket.remoteAddress;

      // Grant tokens directly
      const tokens = await oauthProvider.grantTokensForUser(
        user.username,
        effectiveClientId,
        effectiveScope,
        userAgent,
        ipAddress
      );

      console.log(`[Admin] Token grant for user: ${user.username}, client: ${effectiveClientId}`);

      res.json({
        ...tokens,
        username: user.username,
        obtained_at: Date.now()
      });
    } catch (error) {
      console.error('[Admin] Token grant failed:', error);
      res.status(500).json({
        error: 'Token grant failed',
        details: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // ============================================
  // Dashboard Settings (persisted server-side)
  // ============================================

  router.get('/settings/dashboard', async (_req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Database not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const serverUrl = await db.getSetting('dashboard_server_url');
      res.json({
        serverUrl: serverUrl || null
      });
    } catch (error) {
      console.error('[Admin] Failed to get dashboard settings:', error);
      res.status(500).json({ error: 'Failed to get dashboard settings' });
    }
  });

  router.post('/settings/dashboard', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Database not available' });
        return;
      }
      const { serverUrl } = req.body;

      const db = await context.getFantomDatabase();

      if (serverUrl === null || serverUrl === '') {
        // Clear the setting
        await db.setSetting('dashboard_server_url', '');
        res.json({ success: true, serverUrl: null, message: 'Dashboard server URL cleared' });
      } else {
        // Validate URL format
        try {
          new URL(serverUrl);
        } catch {
          res.status(400).json({ error: 'Invalid URL format', serverUrl });
          return;
        }
        await db.setSetting('dashboard_server_url', serverUrl);
        res.json({ success: true, serverUrl, message: 'Dashboard server URL saved' });
      }
    } catch (error) {
      console.error('[Admin] Failed to set dashboard settings:', error);
      res.status(500).json({ error: 'Failed to set dashboard settings', details: String(error) });
    }
  });

  // ============================================
  // Fantom Versions
  // ============================================

  router.get('/fantom-versions', async (_req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Fantom database not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const sourceFolder = await db.getFantomSourceFolder();

      if (!sourceFolder) {
        res.json({
          versions: [],
          message: 'No Fantom source folder configured. Set it via POST /admin/settings/fantom-source-folder'
        });
        return;
      }

      const versions = await getAvailableFantomVersions(sourceFolder);
      res.json({ sourceFolder, versions });
    } catch (error) {
      console.error('[Admin] Failed to get Fantom versions:', error);
      res.status(500).json({ error: 'Failed to get Fantom versions' });
    }
  });

  router.post('/detect-fantom-version', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Fantom database not available' });
        return;
      }
      const { path: instancePath } = req.body;
      if (!instancePath) {
        res.status(400).json({ error: 'path is required' });
        return;
      }

      if (!fs.existsSync(instancePath)) {
        res.status(400).json({ error: `Path does not exist: ${instancePath}` });
        return;
      }

      const db = await context.getFantomDatabase();
      const sourceFolder = await db.getFantomSourceFolder();

      const result = await detectFantomVersionWithSource(instancePath, sourceFolder);
      res.json(result);
    } catch (error) {
      console.error('[Admin] Failed to detect Fantom version:', error);
      res.status(500).json({ error: 'Failed to detect Fantom version', details: String(error) });
    }
  });

  // ============================================
  // Fantom Builds endpoints
  // ============================================

  // List all Fantom builds
  router.get('/fantom-builds', async (_req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Fantom database not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const builds = await db.getAllFantomBuilds();
      res.json({ builds });
    } catch (error) {
      console.error('[Admin] Failed to list Fantom builds:', error);
      res.status(500).json({ error: 'Failed to list Fantom builds', details: String(error) });
    }
  });

  // Get a specific Fantom build
  router.get('/fantom-builds/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Fantom database not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: 'Invalid build ID' });
        return;
      }
      const build = await db.getFantomBuildById(id);
      if (!build) {
        res.status(404).json({ error: 'Fantom build not found' });
        return;
      }
      // Also get the projects for this build
      const projects = await db.getProjectsForBuild(id);
      res.json({ build, projects });
    } catch (error) {
      console.error('[Admin] Failed to get Fantom build:', error);
      res.status(500).json({ error: 'Failed to get Fantom build', details: String(error) });
    }
  });

  // Create a new Fantom build
  router.post('/fantom-builds', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Fantom database not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const { version, path: buildPath, hasSource, isActive } = req.body;

      if (!version || !buildPath) {
        res.status(400).json({ error: 'version and path are required' });
        return;
      }

      if (!fs.existsSync(buildPath)) {
        res.status(400).json({ error: `Path does not exist: ${buildPath}` });
        return;
      }

      // Check for duplicate version
      const existing = await db.getFantomBuildByVersion(version);
      if (existing) {
        res.status(409).json({ error: `Build for version ${version} already exists`, existingId: existing.id });
        return;
      }

      const build = await db.createFantomBuild({
        version,
        path: buildPath,
        hasSource: hasSource ?? fs.existsSync(path.join(buildPath, 'src')),
        isActive: isActive ?? true
      });
      res.status(201).json({ build });
    } catch (error) {
      console.error('[Admin] Failed to create Fantom build:', error);
      res.status(500).json({ error: 'Failed to create Fantom build', details: String(error) });
    }
  });

  // Scan source folder and register all builds
  router.post('/fantom-builds/scan', async (_req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Fantom database not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const sourceFolder = await db.getFantomSourceFolder();

      if (!sourceFolder) {
        res.status(400).json({
          error: 'No Fantom source folder configured',
          message: 'Set it via POST /admin/settings/fantom-source-folder'
        });
        return;
      }

      const indexer = getFantomBuildIndexer();
      const result = await indexer.scanAndRegisterBuilds(sourceFolder);
      res.json({
        sourceFolder,
        registered: result.registered,
        builds: result.builds
      });
    } catch (error) {
      console.error('[Admin] Failed to scan Fantom builds:', error);
      res.status(500).json({ error: 'Failed to scan Fantom builds', details: String(error) });
    }
  });

  // Index all Fantom builds with source code
  router.post('/fantom-builds/index-all', async (_req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Fantom database not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const builds = await db.getAllFantomBuilds();
      const buildsWithSource = builds.filter(b => b.hasSource);

      if (buildsWithSource.length === 0) {
        res.json({
          success: true,
          message: 'No Fantom builds with source code found',
          totalBuilds: builds.length,
          indexed: 0,
          skipped: builds.length,
          results: []
        });
        return;
      }

      const indexer = getFantomBuildIndexer();
      const results: Array<{
        buildId: number;
        version: string;
        success: boolean;
        podsIndexed?: number;
        totalFunctions?: number;
        totalTypes?: number;
        duration?: number;
        error?: string;
      }> = [];

      let totalPods = 0;
      let totalFunctions = 0;
      let totalTypes = 0;

      for (const build of buildsWithSource) {
        try {
          console.log(`[FantomBuild] Indexing ${build.version}...`);
          const result = await indexer.indexBuild(build.id, build.path, build.version, (message: string) => {
            console.log(`[FantomBuild ${build.version}] ${message}`);
          });
          results.push({
            buildId: build.id,
            version: build.version,
            success: result.success,
            podsIndexed: result.podsIndexed,
            totalFunctions: result.totalFunctions,
            totalTypes: result.totalTypes,
            duration: result.duration
          });
          totalPods += result.podsIndexed;
          totalFunctions += result.totalFunctions;
          totalTypes += result.totalTypes;
        } catch (error) {
          results.push({
            buildId: build.id,
            version: build.version,
            success: false,
            error: String(error)
          });
        }
      }

      res.json({
        success: true,
        totalBuilds: builds.length,
        indexed: results.filter(r => r.success).length,
        skipped: builds.length - buildsWithSource.length,
        totalPods,
        totalFunctions,
        totalTypes,
        results
      });
    } catch (error) {
      console.error('[Admin] Failed to index all Fantom builds:', error);
      res.status(500).json({ error: 'Failed to index all Fantom builds', details: String(error) });
    }
  });

  // Index a specific Fantom build (parse source code)
  router.post('/fantom-builds/:id/index', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Fantom database not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: 'Invalid build ID' });
        return;
      }

      const build = await db.getFantomBuildById(id);
      if (!build) {
        res.status(404).json({ error: 'Fantom build not found' });
        return;
      }

      if (!build.hasSource) {
        res.status(400).json({
          error: 'Build does not have source code',
          message: `No src/ directory found at ${build.path}`
        });
        return;
      }

      const indexer = getFantomBuildIndexer();
      const result = await indexer.indexBuild(id, build.path, build.version, (message: string) => {
        console.log(`[FantomBuild ${build.version}] ${message}`);
      });
      res.json(result);
    } catch (error) {
      console.error('[Admin] Failed to index Fantom build:', error);
      res.status(500).json({ error: 'Failed to index Fantom build', details: String(error) });
    }
  });

  // Clear index for a Fantom build
  router.post('/fantom-builds/:id/clear', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Fantom database not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: 'Invalid build ID' });
        return;
      }

      const build = await db.getFantomBuildById(id);
      if (!build) {
        res.status(404).json({ error: 'Fantom build not found' });
        return;
      }

      // Get projects for this build and clear them from the indexer
      const projects = await db.getProjectsForBuild(id);
      const indexer = getFantomCodeIndexer();

      let clearedProjects = 0;
      for (const project of projects) {
        indexer.clearProject(project.id);
        // Delete the project from database
        await db.deleteProject(project.id);
        clearedProjects++;
      }

      // Reset build stats
      await db.updateFantomBuildIndexStats(id, {
        podCount: 0,
        functionCount: 0,
        typeCount: 0
      });

      res.json({
        success: true,
        buildId: id,
        version: build.version,
        clearedProjects,
        message: `Cleared index for Fantom ${build.version}`
      });
    } catch (error) {
      console.error('[Admin] Failed to clear Fantom build index:', error);
      res.status(500).json({ error: 'Failed to clear Fantom build index', details: String(error) });
    }
  });

  // Delete a Fantom build
  router.delete('/fantom-builds/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Fantom database not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: 'Invalid build ID' });
        return;
      }

      const deleted = await db.deleteFantomBuild(id);
      if (!deleted) {
        res.status(404).json({ error: 'Fantom build not found' });
        return;
      }

      res.json({ success: true, message: `Fantom build ${id} deleted` });
    } catch (error) {
      console.error('[Admin] Failed to delete Fantom build:', error);
      res.status(500).json({ error: 'Failed to delete Fantom build', details: String(error) });
    }
  });

  // ============================================
  // Usage database management endpoints
  // ============================================

  router.get('/usage/database', async (_req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getUsageDatabaseInfo) {
        res.status(501).json({ error: 'Usage database info not available' });
        return;
      }
      const info = await context.getUsageDatabaseInfo();
      res.json(info);
    } catch (error) {
      console.error('[Admin] Failed to get usage database info:', error);
      res.status(500).json({ error: 'Failed to get usage database info' });
    }
  });

  router.post('/usage/clear', async (_req: Request, res: Response): Promise<void> => {
    try {
      if (!context.clearUsageData) {
        res.status(501).json({ error: 'Clear usage data not available' });
        return;
      }
      await context.clearUsageData();
      res.json({ success: true, message: 'Usage data cleared' });
    } catch (error) {
      console.error('[Admin] Failed to clear usage data:', error);
      res.status(500).json({ error: 'Failed to clear usage data' });
    }
  });

  router.post('/usage/reset', async (_req: Request, res: Response): Promise<void> => {
    try {
      if (!context.resetUsageDatabase) {
        res.status(501).json({ error: 'Reset usage database not available' });
        return;
      }
      await context.resetUsageDatabase();
      res.json({ success: true, message: 'Usage database reset' });
    } catch (error) {
      console.error('[Admin] Failed to reset usage database:', error);
      res.status(500).json({ error: 'Failed to reset usage database' });
    }
  });

  // ============================================
  // Documentation search endpoints
  // ============================================

  router.get('/docs/search', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.searchDocs) {
        res.status(501).json({ error: 'Docs search not available' });
        return;
      }
      const query = req.query.q as string;
      if (!query) {
        res.status(400).json({ error: 'Query parameter "q" is required' });
        return;
      }
      const limit = parseInt(req.query.limit as string) || 20;
      const results = await context.searchDocs(query, limit);
      res.json({ query, count: results.length, results });
    } catch (error) {
      console.error('[Admin] Failed to search docs:', error);
      res.status(500).json({ error: 'Failed to search docs' });
    }
  });

  router.get('/pods', async (_req: Request, res: Response): Promise<void> => {
    try {
      // Combine pods from multiple sources
      const podSet = new Set<string>();

      // 1. Get pods from cached documentation search index
      if (context.getPods) {
        const docPods = context.getPods();
        docPods.forEach((p: string) => podSet.add(p));
      }

      // 2. Get pods from database (registered pods for compilation)
      if (context.getFantomDatabase) {
        try {
          const db = await context.getFantomDatabase();
          const dbPods = await db.getAllPods();
          dbPods.forEach(p => podSet.add(p.name));
        } catch (dbErr) {
          console.warn('[Admin] Could not get database pods:', dbErr);
        }
      }

      const pods = Array.from(podSet).sort();
      res.json({ count: pods.length, pods });
    } catch (error) {
      console.error('[Admin] Failed to get pods:', error);
      res.status(500).json({ error: 'Failed to get pods' });
    }
  });

  // ============================================
  // Fantom Instance Management endpoints
  // ============================================

  router.get('/instances', async (_req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Instance management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const instances = await db.getAllInstances();
      res.json({ count: instances.length, instances });
    } catch (error) {
      console.error('[Admin] Failed to get instances:', error);
      res.status(500).json({ error: 'Failed to get instances' });
    }
  });

  // Get SkySpark instances for doc source selection
  // Used when configuring Haxall instances to use SkySpark docs
  router.get('/instances/skyspark', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Instance management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const version = req.query.version as string | undefined;
      const result = await db.getSkySarkInstances(version);
      res.json(result);
    } catch (error) {
      console.error('[Admin] Failed to get SkySpark instances:', error);
      res.status(500).json({ error: 'Failed to get SkySpark instances' });
    }
  });

  router.get('/instances/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Instance management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const id = parseInt(req.params.id as string, 10);
      const instance = await db.getInstanceById(id);
      if (!instance) {
        res.status(404).json({ error: 'Instance not found' });
        return;
      }
      res.json(instance);
    } catch (error) {
      console.error('[Admin] Failed to get instance:', error);
      res.status(500).json({ error: 'Failed to get instance' });
    }
  });

  router.post('/instances', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Instance management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const { name, path: instancePath, type, version, fanExecutable, description, sourcePath, fantomVersion, fantomSourcePath, docSourceInstanceId } = req.body;

      if (!name || !instancePath) {
        res.status(400).json({ error: 'name and path are required' });
        return;
      }

      const instance = await db.createInstance({
        name,
        path: instancePath,
        type,
        version,
        fanExecutable,
        description,
        sourcePath,
        fantomVersion,
        fantomSourcePath,
        docSourceInstanceId
      });
      res.status(201).json(instance);
    } catch (error) {
      console.error('[Admin] Failed to create instance:', error);
      res.status(500).json({ error: 'Failed to create instance', details: String(error) });
    }
  });

  router.put('/instances/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Instance management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const id = parseInt(req.params.id as string, 10);
      const { name, path: instancePath, type, version, fanExecutable, description, sourcePath, fantomVersion, fantomSourcePath, docSourceInstanceId } = req.body;

      const instance = await db.updateInstance(id, {
        name,
        path: instancePath,
        type,
        version,
        fanExecutable,
        description,
        sourcePath,
        fantomVersion,
        fantomSourcePath,
        docSourceInstanceId
      });

      if (!instance) {
        res.status(404).json({ error: 'Instance not found' });
        return;
      }
      res.json(instance);
    } catch (error) {
      console.error('[Admin] Failed to update instance:', error);
      res.status(500).json({ error: 'Failed to update instance', details: String(error) });
    }
  });

  router.delete('/instances/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Instance management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const id = parseInt(req.params.id as string, 10);
      const deleted = await db.deleteInstance(id);

      if (!deleted) {
        res.status(404).json({ error: 'Instance not found' });
        return;
      }
      res.json({ success: true, message: 'Instance deleted' });
    } catch (error) {
      console.error('[Admin] Failed to delete instance:', error);
      res.status(500).json({ error: 'Failed to delete instance' });
    }
  });

  router.post('/instances/:id/validate', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Instance management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const id = parseInt(req.params.id as string, 10);
      const result = await db.validateInstance(id);
      res.json(result);
    } catch (error) {
      console.error('[Admin] Failed to validate instance:', error);
      res.status(500).json({ error: 'Failed to validate instance' });
    }
  });

  // ============================================
  // Instance Documentation endpoints
  // ============================================

  // Index docs for all instances
  router.post('/docs/index-all', async (_req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Instance management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const instances = await db.getAllInstances();

      const results: Array<{
        instanceId: number;
        name: string;
        success: boolean;
        itemCount?: number;
        duration?: number;
        error?: string;
        skipped?: boolean;
      }> = [];

      let totalItems = 0;
      let indexed = 0;
      let skipped = 0;
      let errors = 0;

      for (const instance of instances) {
        try {
          // Check if already cached
          const status = await getDocStatus(instance.id);
          const cachedCount = status.itemCount ?? 0;
          if (status.hasCache && cachedCount > 0) {
            results.push({
              instanceId: instance.id,
              name: instance.name,
              success: true,
              itemCount: cachedCount,
              skipped: true
            });
            totalItems += cachedCount;
            skipped++;
            continue;
          }

          // Index docs for this instance
          const result = await parseInstanceDocs({
            instanceId: instance.id,
            forceRefresh: false
          });

          results.push({
            instanceId: instance.id,
            name: instance.name,
            success: true,
            itemCount: result.items.length,
            duration: result.duration
          });
          totalItems += result.items.length;
          indexed++;
        } catch (err) {
          results.push({
            instanceId: instance.id,
            name: instance.name,
            success: false,
            error: err instanceof Error ? err.message : String(err)
          });
          errors++;
        }
      }

      res.json({
        success: errors === 0,
        totalInstances: instances.length,
        indexed,
        skipped,
        errors,
        totalItems,
        results
      });
    } catch (error) {
      console.error('[Admin] Failed to index all docs:', error);
      res.status(500).json({ error: 'Failed to index all documentation', details: String(error) });
    }
  });

  // Embed docs vectors for all instances (background job)
  router.post('/docs/embed-all', async (req: Request, res: Response): Promise<void> => {
    try {
      const { forceRefresh = false, batchSize } = req.body || {};
      const { startEmbedAllBackground, getActiveEmbedJob } = await import('../embedding/docsEmbeddingPipeline.js');

      // Check if already running
      const active = getActiveEmbedJob();
      if (active) {
        res.json({ success: true, jobId: active.jobId, alreadyRunning: true, progress: active });
        return;
      }

      const jobId = startEmbedAllBackground({ forceRefresh, batchSize });
      res.json({ success: true, jobId, alreadyRunning: false });
    } catch (error) {
      console.error('[Admin] Failed to start embed job:', error);
      res.status(500).json({ error: 'Failed to start embedding', details: String(error) });
    }
  });

  // Get embed job progress
  router.get('/docs/embed-status/:jobId', async (req: Request, res: Response): Promise<void> => {
    try {
      const { getEmbedJobProgress, getActiveEmbedJob } = await import('../embedding/docsEmbeddingPipeline.js');
      const jobId = req.params.jobId as string;

      // Support "active" as a special jobId to get current running job
      if (jobId === 'active') {
        const active = getActiveEmbedJob();
        if (active) {
          res.json(active);
        } else {
          res.json({ status: 'none' });
        }
        return;
      }

      const progress = getEmbedJobProgress(jobId);
      if (!progress) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      res.json(progress);
    } catch (error) {
      res.status(500).json({ error: 'Failed to get job status', details: String(error) });
    }
  });

  // Clear all doc embedding vectors
  /**
   * POST /admin/docs/re-embed
   * Drop the docs_vectors LanceDB table and re-embed every cached doc with
   * the currently configured embedding model. Required when changing model
   * dimensions — `embed-clear` only deletes rows, leaving the table's column
   * type (dimensions) locked to the prior model. This drops the table so the
   * next embed pass recreates it with the configured dimensions.
   */
  router.post('/docs/re-embed', async (_req: Request, res: Response): Promise<void> => {
    try {
      const { getActiveEmbedJob, startEmbedAllBackground } = await import('../embedding/docsEmbeddingPipeline.js');
      const { dropDocsVectorsTable } = await import('../embedding/lanceConnection.js');
      const { getDocsEmbeddingService } = await import('../embedding/embeddingService.js');

      const active = getActiveEmbedJob();
      if (active) {
        res.status(409).json({ error: 'Cannot re-embed while an embedding job is running' });
        return;
      }

      // ── 0. WHICH model is "currently configured" ────────────────────
      //
      // Under "OpenRouter only" it is NOT `semanticSearch.docsModel`. That
      // field names a local Ollama tag (qwen3-embedding:0.6b, 1024d) that
      // nothing will run, because the policy excludes the GPUs from this role.
      // Leaving it authoritative made this button self-defeating: it dropped
      // the table, recreated it at 1024d, and the cloud pool then refused
      // every provider for producing 2560d — a re-embed that destroyed the
      // old vectors and could not write new ones.
      //
      // So the effective model comes from the policy, and `docsDimensions` is
      // MOVED TO MATCH before the table is recreated. LanceDB locks the vector
      // width at creation, so writing that setting after the drop and before
      // the first insert is the only moment it can be changed.
      const { embeddingRoutingPolicy } = await import('../embedding/providers/embeddingProvider.js');
      let cloudOnlyDocs = false;
      try { cloudOnlyDocs = !(await embeddingRoutingPolicy('docs')).localServes; } catch { /* local path */ }

      let effectiveModel: string | undefined;
      let effectiveDims: number | undefined;
      if (cloudOnlyDocs) {
        const { getOpenRouterSettings } = await import('../sidecars/openRouterConfig.js');
        const { findModel } = await import('../sidecars/openRouterModels.js');
        const cfgd = getOpenRouterSettings().allowedModels['embedding'];
        effectiveModel = cfgd?.model;
        effectiveDims = findModel(cfgd?.model ?? '')?.dims ?? cfgd?.dims;
        if (!effectiveModel || !effectiveDims) {
          res.status(409).json({
            error: 'Text embedding is on "OpenRouter only" but no cloud model with a known width is '
              + 'configured for it. Pick one under Model Selection on the OpenRouter config page first — '
              + 'otherwise this would drop docs_vectors and have nothing able to refill it.',
          });
          return;
        }
        const { readConfigFileWithRecovery } = await import('../config/index.js');
        const cfgPath = path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');
        const cur = readConfigFileWithRecovery(cfgPath) ?? {};
        const storedDims = cur?.semanticSearch?.docsDimensions;
        if (storedDims !== effectiveDims) {
          await context.updateSettings({
            semanticSearch: { docsDimensions: effectiveDims, docsModel: effectiveModel },
          } as any);
          console.log(
            `[docs re-embed] docsDimensions ${storedDims ?? '(unset)'} -> ${effectiveDims} and docsModel `
            + `-> ${effectiveModel}, to match the "OpenRouter only" policy before the table is recreated.`,
          );
        }
      }

      // 1. Drop the table so the next insert picks up the configured model
      //    dimensions (LanceDB locks dimensions per column at table creation).
      await dropDocsVectorsTable();

      // 2. Reset the embedding service so it picks up the configured model
      //    on next call (in case it cached the old one).
      try {
        const svc = getDocsEmbeddingService();
        if (typeof (svc as any).reset === 'function') (svc as any).reset();
      } catch { /* best-effort */ }

      // 3. Kick off a background embed-all pass.
      const jobId = startEmbedAllBackground();

      res.json({
        success: true,
        droppedTable: true,
        jobId,
        model: effectiveModel,
        dimensions: effectiveDims,
        via: cloudOnlyDocs ? 'openrouter' : 'sidecar',
        message:
          `Dropped docs_vectors. Re-embedding via ${cloudOnlyDocs ? 'OpenRouter' : 'the sidecar GPUs'}`
          + `${effectiveModel ? ` with ${effectiveModel} at ${effectiveDims}d` : ' with the configured local model'}`
          + `. Poll /admin/docs/embed-status/${jobId} for progress.`,
      });
    } catch (error) {
      console.error('[Admin] Failed to re-embed docs:', error);
      res.status(500).json({ error: 'Failed to re-embed docs', details: String(error) });
    }
  });

  router.post('/docs/embed-clear', async (_req: Request, res: Response): Promise<void> => {
    try {
      const { getDocsVectorStore } = await import('../embedding/docsVectorStore.js');
      const { getActiveEmbedJob } = await import('../embedding/docsEmbeddingPipeline.js');

      // Don't allow clearing while a job is running
      const active = getActiveEmbedJob();
      if (active) {
        res.status(409).json({ error: 'Cannot clear vectors while an embedding job is running' });
        return;
      }

      const store = getDocsVectorStore();
      const countBefore = await store.count();

      // Delete all vectors by getting and clearing each instance
      const { getDocsLanceTable } = await import('../embedding/lanceConnection.js');
      const table = await getDocsLanceTable();
      if (countBefore > 0) {
        await table.delete('doc_id IS NOT NULL');
      }

      res.json({ success: true, deleted: countBefore });
    } catch (error) {
      console.error('[Admin] Failed to clear embeddings:', error);
      res.status(500).json({ error: 'Failed to clear embeddings', details: String(error) });
    }
  });

  router.get('/instances/:id/docs', async (req: Request, res: Response): Promise<void> => {
    try {
      const id = parseInt(req.params.id as string, 10);
      const status = await getDocStatus(id);
      res.json({ instanceId: id, ...status });
    } catch (error) {
      console.error('[Admin] Failed to get doc status:', error);
      res.status(500).json({ error: 'Failed to get documentation status', details: String(error) });
    }
  });

  router.post('/instances/:id/docs/index', async (req: Request, res: Response): Promise<void> => {
    try {
      const id = parseInt(req.params.id as string, 10);
      const { pods, forceRefresh = false } = req.body || {};

      const result = await parseInstanceDocs({
        instanceId: id,
        pods,
        forceRefresh
      });

      res.json({
        success: true,
        instanceId: result.instanceId,
        version: result.version,
        itemCount: result.items.length,
        duration: result.duration,
        podStats: result.podStats,
        errors: result.errors
      });
    } catch (error) {
      console.error('[Admin] Failed to index docs:', error);
      res.status(500).json({ error: 'Failed to index documentation', details: String(error) });
    }
  });

  // Embed docs vectors for a single instance
  router.post('/instances/:id/docs/embed', async (req: Request, res: Response): Promise<void> => {
    try {
      const id = parseInt(req.params.id as string, 10);
      const { forceRefresh = false, batchSize } = req.body || {};
      const { embedInstanceDocs } = await import('../embedding/docsEmbeddingPipeline.js');
      const result = await embedInstanceDocs(id, { forceRefresh, batchSize });

      res.json({
        success: !result.error,
        ...result
      });
    } catch (error) {
      console.error('[Admin] Failed to embed instance docs:', error);
      res.status(500).json({ error: 'Failed to embed documentation', details: String(error) });
    }
  });

  router.get('/instances/:id/docs/search', async (req: Request, res: Response): Promise<void> => {
    try {
      const id = parseInt(req.params.id as string, 10);
      const query = req.query.q as string;

      if (!query) {
        res.status(400).json({ error: 'Query parameter "q" is required' });
        return;
      }

      const pod = req.query.pod as string | undefined;
      const type = req.query.type as string | undefined;
      const language = req.query.language as 'fantom' | 'axon' | undefined;
      const limit = parseInt(req.query.limit as string) || 20;

      const { hybridSearchLocalDocsWithMeta } = await import('../search/docsHybridSearchService.js');
      const searchResult = await hybridSearchLocalDocsWithMeta(query, {
        instanceId: id,
        pod,
        type: type as any,
        language,
        limit
      });

      res.json({
        query,
        instanceId: id,
        count: searchResult.results.length,
        searchMethod: searchResult.searchMethod,
        keywordMatches: searchResult.keywordResults,
        vectorMatches: searchResult.vectorResults,
        vectorsAvailable: searchResult.vectorCount,
        results: searchResult.results.map(r => ({
          name: r.name,
          qualifiedName: r.qualifiedName,
          type: r.type,
          pod: r.pod,
          description: r.description,
          url: r.url,
          language: r.language,
          retrieval: {
            source: r.source,
            keywordRank: r.keywordRank,
            vectorRank: r.vectorRank,
            keywordScore: r.keywordScore,
            vectorScore: r.vectorScore,
            fusedScore: r.fusedScore
          }
        }))
      });
    } catch (error) {
      console.error('[Admin] Failed to search docs:', error);
      res.status(500).json({ error: 'Failed to search documentation', details: String(error) });
    }
  });

  router.get('/instances/:id/docs/pods', async (req: Request, res: Response): Promise<void> => {
    try {
      const id = parseInt(req.params.id as string, 10);
      const pods = await listInstancePods(id);

      res.json({
        instanceId: id,
        count: pods.length,
        pods: pods.map(p => ({
          name: p.name,
          category: p.category,
          fileCount: p.fileCount,
          isAxonLib: p.isAxonLib
        }))
      });
    } catch (error) {
      console.error('[Admin] Failed to list pods:', error);
      res.status(500).json({ error: 'Failed to list documentation pods', details: String(error) });
    }
  });

  router.delete('/instances/:id/docs/cache', async (req: Request, res: Response): Promise<void> => {
    try {
      const id = parseInt(req.params.id as string, 10);
      const cleared = clearDocCache(id);

      res.json({
        success: true,
        instanceId: id,
        cacheCleared: cleared
      });
    } catch (error) {
      console.error('[Admin] Failed to clear doc cache:', error);
      res.status(500).json({ error: 'Failed to clear documentation cache', details: String(error) });
    }
  });

  // ============================================
  // Instance Source Code Indexing endpoints
  // ============================================

  router.get('/instances/:id/source', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Instance management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const id = parseInt(req.params.id as string, 10);
      const instance = await db.getInstanceById(id);

      if (!instance) {
        res.status(404).json({ error: 'Instance not found' });
        return;
      }

      // Check if instance has a sourcePath configured
      if (!instance.sourcePath) {
        res.json({
          instanceId: id,
          hasSourcePath: false,
          sourcePath: null,
          isIndexed: false,
          message: 'No source path configured for this instance. Set sourcePath to enable source code indexing.'
        });
        return;
      }

      // Check if source path exists
      const sourcePathExists = fs.existsSync(instance.sourcePath);
      if (!sourcePathExists) {
        res.json({
          instanceId: id,
          hasSourcePath: true,
          sourcePath: instance.sourcePath,
          isIndexed: false,
          error: `Source path does not exist: ${instance.sourcePath}`
        });
        return;
      }

      // Get projects associated with this instance that are from the source path
      const projects = await db.getProjectsByInstance(id);
      const sourceProjects = projects.filter(p => p.path.startsWith(instance.sourcePath!));

      // Calculate totals from all source projects
      let totalFunctions = 0;
      let totalTypes = 0;
      let lastIndexed: string | undefined;

      for (const project of sourceProjects) {
        totalFunctions += project.functionCount;
        totalTypes += project.typeCount;
        if (project.lastIndexed) {
          if (!lastIndexed || project.lastIndexed > lastIndexed) {
            lastIndexed = project.lastIndexed;
          }
        }
      }

      res.json({
        instanceId: id,
        hasSourcePath: true,
        sourcePath: instance.sourcePath,
        isIndexed: sourceProjects.length > 0,
        podCount: sourceProjects.length,
        functionCount: totalFunctions,
        typeCount: totalTypes,
        lastIndexed: lastIndexed || null
      });
    } catch (error) {
      console.error('[Admin] Failed to get source status:', error);
      res.status(500).json({ error: 'Failed to get source code status', details: String(error) });
    }
  });

  router.post('/instances/:id/source/index', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Instance management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const id = parseInt(req.params.id as string, 10);
      const instance = await db.getInstanceById(id);

      if (!instance) {
        res.status(404).json({ error: 'Instance not found' });
        return;
      }

      if (!instance.sourcePath) {
        res.status(400).json({
          error: 'No source path configured',
          message: 'Set sourcePath on the instance before indexing source code'
        });
        return;
      }

      if (!fs.existsSync(instance.sourcePath)) {
        res.status(400).json({
          error: 'Source path does not exist',
          sourcePath: instance.sourcePath
        });
        return;
      }

      const startTime = Date.now();
      const results: Array<{
        podName: string;
        projectId: number;
        action: 'created' | 'reindexed';
        functionsIndexed: number;
        typesIndexed: number;
      }> = [];

      // Track skipped directories for diagnostics
      const skippedDirs: Array<{ name: string; reason: string }> = [];

      // Discover pods in source directory
      // Haxall src structure can be:
      //   - Flat: src/<podName>/fan/*.fan
      //   - Nested (Haxall): src/<category>/<podName>/fan/*.fan
      const srcEntries = fs.readdirSync(instance.sourcePath, { withFileTypes: true });
      const topLevelDirs = srcEntries
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => entry.name);

      // Collect all pod directories (with their paths)
      const podCandidates: Array<{ name: string; path: string; category?: string }> = [];

      for (const dirName of topLevelDirs) {
        const dirPath = path.join(instance.sourcePath, dirName);
        const fanDir = path.join(dirPath, 'fan');

        // Check if this is a direct pod (has fan/ subdirectory)
        if (fs.existsSync(fanDir)) {
          podCandidates.push({ name: dirName, path: dirPath });
        } else {
          // Check for nested pods (Haxall structure: category/podName/fan/)
          try {
            const nestedEntries = fs.readdirSync(dirPath, { withFileTypes: true });
            const nestedDirs = nestedEntries
              .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
              .map(entry => entry.name);

            let hasNestedPods = false;
            for (const nestedName of nestedDirs) {
              const nestedPath = path.join(dirPath, nestedName);
              const nestedFanDir = path.join(nestedPath, 'fan');

              if (fs.existsSync(nestedFanDir)) {
                podCandidates.push({
                  name: nestedName,
                  path: nestedPath,
                  category: dirName
                });
                hasNestedPods = true;
              }
            }

            if (!hasNestedPods) {
              skippedDirs.push({ name: dirName, reason: 'no fan/ subdirectory (checked nested too)' });
            }
          } catch {
            skippedDirs.push({ name: dirName, reason: 'could not read directory' });
          }
        }
      }

      let podsIndexed = 0;
      let totalFunctions = 0;
      let totalTypes = 0;

      for (const pod of podCandidates) {
        const podName = pod.name;
        const podPath = pod.path;

        // Check if project already exists
        const existingProjects = await db.getAllProjects();
        let project = existingProjects.find(p => normalizePath(p.path) === normalizePath(podPath));
        let action: 'created' | 'reindexed' = 'reindexed';

        if (!project) {
          // Create new project - include category in name for nested structures
          const projectName = pod.category
            ? `${instance.name}:${pod.category}/${podName}`
            : `${instance.name}:${podName}`;
          const description = pod.category
            ? `Source code from ${instance.name} (${pod.category}/${podName})`
            : `Source code from ${instance.name}`;

          project = await db.createProject({
            name: projectName,
            path: podPath,
            instanceId: id,
            podName: podName,
            description,
            autoIndex: true
          });
          action = 'created';
        }

        // Reindex the project
        if (context.reindexProject) {
          try {
            const indexResult = await context.reindexProject(project.id);
            results.push({
              podName,
              projectId: project.id,
              action,
              functionsIndexed: indexResult.indexResult.functionsIndexed,
              typesIndexed: indexResult.indexResult.typesIndexed
            });
            totalFunctions += indexResult.indexResult.functionsIndexed;
            totalTypes += indexResult.indexResult.typesIndexed;
            podsIndexed++;
          } catch (indexError) {
            console.error(`[Admin] Failed to index pod ${podName}:`, indexError);
          }
        } else {
          results.push({
            podName,
            projectId: project.id,
            action,
            functionsIndexed: 0,
            typesIndexed: 0
          });
          podsIndexed++;
        }
      }

      const duration = Date.now() - startTime;

      res.json({
        success: true,
        instanceId: id,
        sourcePath: instance.sourcePath,
        podsIndexed,
        totalFunctions,
        totalTypes,
        duration,
        results,
        // Include diagnostics to help debug 0 pods scenarios
        diagnostics: {
          totalDirectories: topLevelDirs.length,
          discoveredPods: podCandidates.length,
          skippedCount: skippedDirs.length,
          skipped: skippedDirs.slice(0, 10), // Limit to first 10
          expectedStructure: 'Supports flat (src/<pod>/fan/) and nested (src/<category>/<pod>/fan/) structures'
        }
      });
    } catch (error) {
      console.error('[Admin] Failed to index source code:', error);
      res.status(500).json({ error: 'Failed to index source code', details: String(error) });
    }
  });

  router.get('/instances/:id/source/pods', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Instance management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const id = parseInt(req.params.id as string, 10);
      const instance = await db.getInstanceById(id);

      if (!instance) {
        res.status(404).json({ error: 'Instance not found' });
        return;
      }

      if (!instance.sourcePath) {
        res.status(400).json({
          error: 'No source path configured',
          message: 'Set sourcePath on the instance to enable source code indexing'
        });
        return;
      }

      if (!fs.existsSync(instance.sourcePath)) {
        res.status(400).json({
          error: 'Source path does not exist',
          sourcePath: instance.sourcePath
        });
        return;
      }

      // Get projects associated with this instance
      const projects = await db.getProjectsByInstance(id);
      const sourceProjects = projects.filter(p => p.path.startsWith(instance.sourcePath!));

      // Also discover pods in source directory that might not be indexed yet
      const srcEntries = fs.readdirSync(instance.sourcePath, { withFileTypes: true });
      const podDirs = srcEntries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);

      const pods: Array<{
        name: string;
        path: string;
        isIndexed: boolean;
        projectId?: number;
        functionCount: number;
        typeCount: number;
        lastIndexed?: string;
      }> = [];

      for (const podName of podDirs) {
        const podPath = path.join(instance.sourcePath, podName);
        const fanDir = path.join(podPath, 'fan');

        // Only include directories that have a fan/ subdirectory
        if (!fs.existsSync(fanDir)) {
          continue;
        }

        const project = sourceProjects.find(p => normalizePath(p.path) === normalizePath(podPath));

        pods.push({
          name: podName,
          path: podPath,
          isIndexed: !!project,
          projectId: project?.id,
          functionCount: project?.functionCount || 0,
          typeCount: project?.typeCount || 0,
          lastIndexed: project?.lastIndexed
        });
      }

      // Sort by name
      pods.sort((a, b) => a.name.localeCompare(b.name));

      res.json({
        instanceId: id,
        sourcePath: instance.sourcePath,
        count: pods.length,
        indexedCount: pods.filter(p => p.isIndexed).length,
        pods
      });
    } catch (error) {
      console.error('[Admin] Failed to list source pods:', error);
      res.status(500).json({ error: 'Failed to list source code pods', details: String(error) });
    }
  });

  // ============================================
  // Active Instance endpoints
  // ============================================

  router.get('/active-instance', async (_req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Instance management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const instance = await db.getActiveInstance();
      if (!instance) {
        res.json({ active: false, message: 'No active instance set' });
        return;
      }
      res.json({ active: true, instance });
    } catch (error) {
      console.error('[Admin] Failed to get active instance:', error);
      res.status(500).json({ error: 'Failed to get active instance' });
    }
  });

  router.post('/active-instance', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Instance management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const { instanceId } = req.body;

      if (instanceId === null || instanceId === undefined) {
        await db.setActiveInstanceId(null);
        res.json({ success: true, message: 'Active instance cleared' });
        return;
      }

      const instance = await db.getInstanceById(instanceId);
      if (!instance) {
        res.status(404).json({ error: 'Instance not found' });
        return;
      }

      await db.setActiveInstanceId(instanceId);
      res.json({ success: true, instance });
    } catch (error) {
      console.error('[Admin] Failed to set active instance:', error);
      res.status(500).json({ error: 'Failed to set active instance' });
    }
  });

  // ============================================
  // Fantom Pod Management endpoints
  // ============================================

  router.get('/fantom-pods', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Pod management not available' });
        return;
      }
      const db = await context.getFantomDatabase();

      // Support filtering by instanceId
      const instanceIdParam = req.query.instanceId as string | undefined;
      const includeInstance = req.query.includeInstance === 'true';
      const unassignedOnly = req.query.unassigned === 'true';
      const compatibleWith = req.query.compatibleWith as string | undefined;

      let pods;

      if (unassignedOnly) {
        // Get only pods without an assigned instance
        pods = await db.getUnassignedPods();

        // Apply version compatibility filter if specified
        if (compatibleWith) {
          pods = pods.filter(pod => isVersionCompatible(pod, compatibleWith));
        }

        res.json({ count: pods.length, pods, filter: 'unassigned', compatibleWith });
        return;
      }

      if (instanceIdParam) {
        // Filter by specific instance
        const instanceId = parseInt(instanceIdParam, 10);
        if (isNaN(instanceId)) {
          res.status(400).json({ error: 'Invalid instanceId parameter' });
          return;
        }
        pods = await db.getPodsByInstance(instanceId);

        // Apply version compatibility filter if specified
        if (compatibleWith) {
          pods = pods.filter(pod => isVersionCompatible(pod, compatibleWith));
        }

        res.json({ count: pods.length, pods, instanceId, compatibleWith });
        return;
      }

      // Return all pods, optionally with instance info
      if (includeInstance) {
        pods = await db.getAllPodsWithInstance();
      } else {
        pods = await db.getAllPods();
      }

      // Apply version compatibility filter if specified
      if (compatibleWith) {
        pods = pods.filter(pod => isVersionCompatible(pod, compatibleWith));
      }

      // Also surface FantomProject rows that don't have a backing FantomPod
      // (typically projects added via the MCP `addFantomProject` tool, or
      // non-Fantom code projects). Without this, MCP-added projects were
      // invisible on the "Pods & Projects" page.
      const allProjects = await db.getAllProjects();
      const podPaths = new Set(pods.map(p => p.path));
      const orphanProjects = allProjects
        .filter(p => !podPaths.has(p.path))
        .map(p => ({
          id: p.id,
          name: p.name,
          path: p.path,
          podName: p.podName ?? null,
          instanceId: p.instanceId ?? null,
          language: (p as { language?: string }).language ?? 'fantom',
          parserType: (p as { parserType?: string }).parserType ?? 'regex',
          description: p.description ?? null,
          autoIndex: p.autoIndex !== false,
          functionCount: (p as { functionCount?: number }).functionCount ?? 0,
          typeCount: (p as { typeCount?: number }).typeCount ?? 0,
          lastIndexed: p.lastIndexed ?? null,
        }));

      res.json({
        count: pods.length,
        pods,
        compatibleWith,
        projects: orphanProjects,
        projectCount: orphanProjects.length,
      });
    } catch (error) {
      console.error('[Admin] Failed to get pods:', error);
      res.status(500).json({ error: 'Failed to get pods' });
    }
  });

  router.get('/fantom-pods/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Pod management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const id = parseInt(req.params.id as string, 10);
      const pod = await db.getPodById(id);
      if (!pod) {
        res.status(404).json({ error: 'Pod not found' });
        return;
      }
      res.json(pod);
    } catch (error) {
      console.error('[Admin] Failed to get pod:', error);
      res.status(500).json({ error: 'Failed to get pod' });
    }
  });

  router.post('/fantom-pods', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Pod management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const {
        name,
        path: podPath,
        buildFile,
        description,
        defaultInstanceId,
        compatMinVersion,
        compatMaxVersion,
        compatVersions
      } = req.body;

      if (!name || !podPath) {
        res.status(400).json({ error: 'name and path are required' });
        return;
      }

      const pod = await db.createPod({
        name,
        path: podPath,
        buildFile,
        description,
        defaultInstanceId,
        compatMinVersion,
        compatMaxVersion,
        compatVersions
      });
      res.status(201).json(pod);
    } catch (error) {
      console.error('[Admin] Failed to create pod:', error);
      res.status(500).json({ error: 'Failed to create pod', details: String(error) });
    }
  });

  router.put('/fantom-pods/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Pod management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const id = parseInt(req.params.id as string, 10);
      const {
        name,
        path: podPath,
        buildFile,
        description,
        defaultInstanceId,
        compatMinVersion,
        compatMaxVersion,
        compatVersions
      } = req.body;

      const pod = await db.updatePod(id, {
        name,
        path: podPath,
        buildFile,
        description,
        defaultInstanceId,
        compatMinVersion,
        compatMaxVersion,
        compatVersions
      });

      if (!pod) {
        res.status(404).json({ error: 'Pod not found' });
        return;
      }
      res.json(pod);
    } catch (error) {
      console.error('[Admin] Failed to update pod:', error);
      res.status(500).json({ error: 'Failed to update pod', details: String(error) });
    }
  });

  router.delete('/fantom-pods/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Pod management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const id = parseInt(req.params.id as string, 10);
      const deleted = await db.deletePod(id);

      if (!deleted) {
        res.status(404).json({ error: 'Pod not found' });
        return;
      }
      res.json({ success: true, message: 'Pod deleted' });
    } catch (error) {
      console.error('[Admin] Failed to delete pod:', error);
      res.status(500).json({ error: 'Failed to delete pod' });
    }
  });

  // Note: /fantom-pods/:id/languages endpoint is defined later with stable ID support

  // Index all pods AND projects. Previously this iterated only FantomPod
  // rows (~11 entries) and ignored the 230+ orphan FantomProject rows that
  // were added via MCP `addFantomProject`, admin `POST /code-projects`, or
  // source-indexing. Now it walks both, dedups by path, and runs the
  // unified indexing pipeline on each.
  //
  // Body: { force?: boolean } — when true, bypasses the hash-gate so every
  // project actually re-parses (used by the "Reindex All" button).
  router.post('/fantom-pods/index-all-ast', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Pod management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const force = req.body?.force === true || req.query.force === 'true';
      const pods = await db.getAllPods();
      const projects = await db.getAllProjects();

      const results: Array<{
        source: 'pod' | 'project';
        podId?: number;
        name: string;
        projectId: number;
        action: 'created' | 'exists';
        indexed: boolean;
        functionsIndexed?: number;
        typesIndexed?: number;
        error?: string;
      }> = [];

      let created = 0;
      let alreadyExists = 0;
      let indexedOk = 0;
      let indexErrors = 0;
      const handledProjectIds = new Set<number>();

      // Phase 1: pods → ensure a backing FantomProject exists, then index it
      for (const pod of pods) {
        const existingProject = projects.find(p => normalizePath(p.path) === normalizePath(pod.path));
        let project = existingProject;
        let action: 'created' | 'exists';

        if (existingProject) {
          alreadyExists++;
          action = 'exists';
        } else {
          project = await db.createProject({
            name: pod.name,
            path: pod.path,
            podName: pod.name,
            instanceId: pod.defaultInstanceId || undefined,
            description: pod.description || `AST cache for ${pod.name}`,
            autoIndex: true,
          });
          created++;
          action = 'created';
        }

        let indexed = false;
        let functionsIndexed: number | undefined;
        let typesIndexed: number | undefined;
        let errorMsg: string | undefined;
        if (project && context.reindexProject) {
          try {
            const r = await context.reindexProject(project.id, { force });
            indexed = !!(r as { success?: boolean })?.success;
            functionsIndexed = (r as { indexResult?: { functionsIndexed?: number } })?.indexResult?.functionsIndexed;
            typesIndexed = (r as { indexResult?: { typesIndexed?: number } })?.indexResult?.typesIndexed;
            if (indexed) indexedOk++;
            else indexErrors++;
          } catch (indexError) {
            console.error(`[Admin] Failed to index project ${project.id}:`, indexError);
            errorMsg = (indexError as Error).message ?? String(indexError);
            indexErrors++;
          }
        }

        if (project) handledProjectIds.add(project.id);
        results.push({
          source: 'pod',
          podId: pod.id,
          name: pod.name,
          projectId: project!.id,
          action,
          indexed,
          functionsIndexed,
          typesIndexed,
          error: errorMsg,
        });
      }

      // Phase 2: orphan FantomProject rows that don't share a path with any pod
      let orphanCount = 0;
      let orphanIndexed = 0;
      let orphanErrors = 0;
      for (const project of projects) {
        if (handledProjectIds.has(project.id)) continue;
        orphanCount++;
        let indexed = false;
        let functionsIndexed: number | undefined;
        let typesIndexed: number | undefined;
        let errorMsg: string | undefined;
        if (context.reindexProject) {
          try {
            const r = await context.reindexProject(project.id, { force });
            indexed = !!(r as { success?: boolean })?.success;
            functionsIndexed = (r as { indexResult?: { functionsIndexed?: number } })?.indexResult?.functionsIndexed;
            typesIndexed = (r as { indexResult?: { typesIndexed?: number } })?.indexResult?.typesIndexed;
            if (indexed) { indexedOk++; orphanIndexed++; }
            else { indexErrors++; orphanErrors++; }
          } catch (indexError) {
            console.error(`[Admin] Failed to index orphan project ${project.id}:`, indexError);
            errorMsg = (indexError as Error).message ?? String(indexError);
            indexErrors++;
            orphanErrors++;
          }
        }
        results.push({
          source: 'project',
          name: project.name,
          projectId: project.id,
          action: 'exists',
          indexed,
          functionsIndexed,
          typesIndexed,
          error: errorMsg,
        });
      }

      res.json({
        success: indexErrors === 0,
        processed: pods.length + orphanCount,
        podsProcessed: pods.length,
        projectsProcessed: orphanCount,
        created,
        alreadyExists,
        indexedOk,
        indexErrors,
        force,
        orphanIndexed,
        orphanErrors,
        results,
      });
    } catch (error) {
      console.error('[Admin] Failed to index all pods:', error);
      res.status(500).json({ error: 'Failed to index all pods', details: String(error) });
    }
  });

  router.get('/fantom-pods/:id/build-files', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Pod management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const id = parseInt(req.params.id as string, 10);
      const pod = await db.getPodById(id);

      if (!pod) {
        res.status(404).json({ error: 'Pod not found' });
        return;
      }

      const buildFiles = db.discoverBuildFiles(pod.path);
      res.json({ podId: id, path: pod.path, buildFiles });
    } catch (error) {
      console.error('[Admin] Failed to get build files:', error);
      res.status(500).json({ error: 'Failed to get build files' });
    }
  });

  router.get('/fantom-pods/:id/compile-logs', async (req: Request, res: Response): Promise<void> => {
    try {
      const id = parseInt(req.params.id as string, 10);
      const limit = parseInt(req.query.limit as string) || 20;
      const logs = await getCompileLogs(id, limit);
      res.json({ podId: id, count: logs.length, logs });
    } catch (error) {
      console.error('[Admin] Failed to get compile logs:', error);
      res.status(500).json({ error: 'Failed to get compile logs' });
    }
  });

  // ============================================
  // Compilation endpoints
  // ============================================

  router.post('/compile', async (req: Request, res: Response): Promise<void> => {
    try {
      const { podId, instanceId, buildFile } = req.body;

      if (!podId) {
        res.status(400).json({ error: 'podId is required' });
        return;
      }

      const result = await compilePod({
        podId,
        instanceId,
        buildFile
      });

      res.json(result);
    } catch (error) {
      console.error('[Admin] Compilation failed:', error);
      res.status(500).json({ error: 'Compilation failed', details: String(error) });
    }
  });

  router.get('/compile/running', async (_req: Request, res: Response): Promise<void> => {
    try {
      const running = await getRunningCompilations();
      res.json({ count: running.length, compilations: running });
    } catch (error) {
      console.error('[Admin] Failed to get running compilations:', error);
      res.status(500).json({ error: 'Failed to get running compilations' });
    }
  });

  router.get('/compile/:logId', async (req: Request, res: Response): Promise<void> => {
    try {
      const logId = parseInt(req.params.logId as string, 10);
      const log = await getCompileLog(logId);

      if (!log) {
        res.status(404).json({ error: 'Compile log not found' });
        return;
      }
      res.json(log);
    } catch (error) {
      console.error('[Admin] Failed to get compile log:', error);
      res.status(500).json({ error: 'Failed to get compile log' });
    }
  });

  // ============================================
  // Fantom Code Project Management endpoints
  // ============================================

  router.get('/code-projects', async (_req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Code project management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const projects = await db.getAllProjects();
      res.json({ count: projects.length, projects });
    } catch (error) {
      console.error('[Admin] Failed to get code projects:', error);
      res.status(500).json({ error: 'Failed to get code projects' });
    }
  });

  router.get('/code-projects/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Code project management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const id = parseInt(req.params.id as string, 10);
      const project = await db.getProjectById(id);
      if (!project) {
        res.status(404).json({ error: 'Code project not found' });
        return;
      }
      res.json(project);
    } catch (error) {
      console.error('[Admin] Failed to get code project:', error);
      res.status(500).json({ error: 'Failed to get code project' });
    }
  });

  router.get('/code-projects/:id/index-runs', async (req: Request, res: Response): Promise<void> => {
    try {
      const id = parseInt(req.params.id as string, 10);
      const limit = Math.min(Number(req.query.limit ?? 20) || 20, 200);
      const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
      const trigger = typeof req.query.trigger === 'string' ? req.query.trigger : undefined;

      const { getPrismaClient } = await import('../db/prisma.js');
      const prisma = getPrismaClient();

      const where: any = { projectId: id };
      if (trigger) where.trigger = trigger;

      const [total, rows] = await Promise.all([
        (prisma as any).indexRun.count({ where }),
        (prisma as any).indexRun.findMany({
          where,
          orderBy: { startedAt: 'desc' },
          take: limit,
          skip: offset,
        }),
      ]);

      res.json({
        total,
        offset,
        limit,
        runs: rows.map((r: any) => ({
          id: r.id,
          startedAt: r.startedAt?.toISOString() ?? null,
          finishedAt: r.finishedAt?.toISOString() ?? null,
          durationMs: r.durationMs,
          trigger: r.trigger,
          filesScanned: r.filesScanned,
          filesParsed: r.filesParsed,
          filesSkipped: r.filesSkipped,
          addedCount: r.addedCount,
          modifiedCount: r.modifiedCount,
          removedCount: r.removedCount,
          isSeedingRun: r.isSeedingRun,
          force: r.force,
          errorMessage: r.errorMessage,
          gitCommit: r.gitCommit ?? null,
          gitBranch: r.gitBranch ?? null,
        })),
      });
    } catch (error) {
      console.error('[Admin] Failed to list index runs:', error);
      res.status(500).json({ error: 'Failed to list index runs', details: String(error) });
    }
  });

  // Search shims used by scripts/test-fantom-mcp-soundsuite.sh — wrap the
  // in-memory FlexSearch index and the semantic vector store so the harness
  // can run without OAuth on /mcp.
  router.post('/search/code', async (req: Request, res: Response): Promise<void> => {
    try {
      const { query, projectId, projectName, limit = 10 } = req.body || {};
      if (!query) {
        res.status(400).json({ error: 'query required' });
        return;
      }
      const { getPrismaClient } = await import('../db/prisma.js');
      const { resolveProjectId } = await import('../utils/dbBootstrap.js');
      const pid = await resolveProjectId(getPrismaClient() as any, { projectId, projectName });
      const { getFantomFunctionSearchIndex } = await import('../fantom-code/searchIndex.js');
      const index = getFantomFunctionSearchIndex();
      const results = index.search(query, { projectId: pid, limit });
      res.json({ count: results.length, projectId: pid, results });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  router.post('/search/semantic', async (req: Request, res: Response): Promise<void> => {
    try {
      const { query, projectId, projectName, limit = 10, llmReranker, crossEncoderReranker, hybrid, rerank, minScore } = req.body || {};
      if (!query) {
        res.status(400).json({ error: 'query required' });
        return;
      }
      const { getPrismaClient } = await import('../db/prisma.js');
      const { resolveProjectId } = await import('../utils/dbBootstrap.js');
      const prisma = getPrismaClient();
      const pid = await resolveProjectId(prisma as any, { projectId, projectName });
      const { getSemanticSearchService } = await import('../embedding/semanticSearchService.js');
      const svc = getSemanticSearchService(prisma);

      // Merge server-default reranker config with per-request override.
      const settings = context.getSettings();
      const serverDefault = (settings.semanticSearch as any)?.llmReranker as
        | { enabled?: boolean; provider?: 'groq' | 'anthropic' | 'gemini'; model?: string; topK?: number; fromSidecar?: boolean }
        | undefined;
      const topProvider = settings.llmProviders?.defaultProvider;
      const merged = llmReranker || serverDefault
        ? {
            enabled: !!(llmReranker?.enabled ?? serverDefault?.enabled),
            provider: llmReranker?.provider ?? serverDefault?.provider ?? topProvider,
            model: llmReranker?.model ?? serverDefault?.model,
            topK: llmReranker?.topK ?? serverDefault?.topK,
            fromSidecar: llmReranker?.fromSidecar ?? serverDefault?.fromSidecar,
          }
        : undefined;

      // Cross-encoder rerank — same merge pattern (per-request override > server default).
      const xeServerDefault = (settings.semanticSearch as any)?.crossEncoderReranker as
        | { enabled?: boolean; model?: string; topK?: number }
        | undefined;
      const xeMerged = crossEncoderReranker || xeServerDefault
        ? {
            enabled: !!(crossEncoderReranker?.enabled ?? xeServerDefault?.enabled),
            model: crossEncoderReranker?.model ?? xeServerDefault?.model,
            topK: crossEncoderReranker?.topK ?? xeServerDefault?.topK,
          }
        : undefined;

      const t0 = Date.now();
      const results = await (svc as any).search(query, {
        projectId: pid,
        limit,
        llmReranker: merged,
        crossEncoderReranker: xeMerged,
        // Per-request retrieval overrides (default: runtime settings).
        ...(typeof hybrid === 'boolean' ? { hybrid } : {}),
        ...(rerank === 'auto' || rerank === 'on' || rerank === 'off' ? { rerank } : {}),
        // Calibration/debug: see what the absolute score floor is hiding.
        ...(typeof minScore === 'number' && Number.isFinite(minScore) ? { minScore } : {}),
      });
      res.json({ count: Array.isArray(results) ? results.length : 0, projectId: pid, elapsedMs: Date.now() - t0, results });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  router.get('/code-projects/:id/diff', async (req: Request, res: Response): Promise<void> => {
    try {
      const id = parseInt(req.params.id as string, 10);
      const from = req.query.from as string | undefined;
      const to = req.query.to as string | undefined;
      const scope = req.query.scope as string | undefined;
      const { getPrismaClient } = await import('../db/prisma.js');
      const { computeProjectDiff } = await import('../fantom-code/timeTravelDiff.js');
      const result = await computeProjectDiff(getPrismaClient(), id, from, to, { scope });
      res.json(result);
    } catch (error) {
      console.error('[Admin] Failed to compute project diff:', error);
      res.status(500).json({ error: 'Failed to compute diff', details: String(error) });
    }
  });

  router.get('/code-projects/:id/file-symbols', async (req: Request, res: Response): Promise<void> => {
    try {
      const id = parseInt(req.params.id as string, 10);
      const filePath = req.query.path as string;
      const atTime = req.query.atTime as string | undefined;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const offset = req.query.offset ? Number(req.query.offset) : undefined;
      if (!filePath) {
        res.status(400).json({ error: 'path query param required' });
        return;
      }
      const { getPrismaClient } = await import('../db/prisma.js');
      const { listFunctionsInFile } = await import('../fantom-code/fileSymbols.js');
      const result = await listFunctionsInFile(getPrismaClient(), {
        filePath, projectId: id, atTime, limit, offset,
      });
      res.json(result);
    } catch (error) {
      console.error('[Admin] Failed to list file symbols:', error);
      res.status(500).json({ error: 'Failed to list file symbols', details: String(error) });
    }
  });

  router.get('/code-projects/:id/health', async (req: Request, res: Response): Promise<void> => {
    try {
      const id = parseInt(req.params.id as string, 10);
      const { getPrismaClient } = await import('../db/prisma.js');
      const { getIndexHealth } = await import('../fantom-code/indexHealth.js');
      const report = await getIndexHealth(getPrismaClient(), id);
      res.json(report);
    } catch (error) {
      console.error('[Admin] Failed to get index health:', error);
      res.status(500).json({ error: 'Failed to get index health', details: String(error) });
    }
  });

  router.post('/code-projects', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Code project management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const {
        name,
        path: rawProjectPath,
        instanceId,
        podName,
        description,
        autoIndex,
        language,
        parserType,
      } = req.body;

      if (!name || !rawProjectPath) {
        res.status(400).json({ error: 'name and path are required' });
        return;
      }
      // Expand leading ~ and resolve. Without this, the file scanner walks
      // `~/foo` literally, finds zero files, and reindex returns 0/0/0.
      const projectPath = path.resolve(
        String(rawProjectPath).replace(/^~(?=$|[/\\])/, os.homedir()),
      );

      // If the caller didn't specify a language, auto-detect from the
      // directory contents. Surface the detection result in the response so
      // dashboards can show what we picked.
      let resolvedLanguage = language as string | undefined;
      let resolvedParserType = parserType as string | undefined;
      let detected: { language: string; parserType: string } | undefined;
      if (!resolvedLanguage) {
        try {
          detected = detectProjectLanguage(projectPath);
          resolvedLanguage = detected.language;
          resolvedParserType ??= detected.parserType;
        } catch {
          // Detection is best-effort; fall back to schema default.
        }
      }

      const project = await db.createProject({
        name,
        path: projectPath,
        instanceId,
        podName,
        description,
        autoIndex: autoIndex !== false,
        language: resolvedLanguage,
        parserType: resolvedParserType,
      });

      // Seed dependency rows (build.fan / package.json / workspace siblings)
      // right away so the project shows up in its neighbours' ask scope even
      // before its first index run. Best-effort.
      try {
        const { rebuildProjectDependenciesSafe } = await import('../fantom/projectDependencies.js');
        await rebuildProjectDependenciesSafe(project.id);
      } catch { /* logged inside */ }

      res.status(201).json({ ...project, ...(detected ? { detectedLanguage: detected } : {}) });
    } catch (error) {
      const { ProjectPathConflictError } = await import('../fantom/database.js');
      if (error instanceof ProjectPathConflictError) {
        res.status(409).json({
          error: error.message,
          code: error.code,
          existing: error.existing,
        });
        return;
      }
      console.error('[Admin] Failed to create code project:', error);
      res.status(500).json({ error: 'Failed to create code project', details: String(error) });
    }
  });

  router.put('/code-projects/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Code project management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const id = parseInt(req.params.id as string, 10);
      const { name, path: rawProjectPath, instanceId, podName, description, autoIndex, language, parserType } = req.body;

      const projectPath = rawProjectPath
        ? path.resolve(String(rawProjectPath).replace(/^~(?=$|[/\\])/, os.homedir()))
        : undefined;

      const project = await db.updateProject(id, {
        name,
        path: projectPath,
        instanceId,
        podName,
        description,
        autoIndex,
        language,
        parserType,
      });

      if (!project) {
        res.status(404).json({ error: 'Code project not found' });
        return;
      }
      res.json(project);
    } catch (error) {
      console.error('[Admin] Failed to update code project:', error);
      res.status(500).json({ error: 'Failed to update code project', details: String(error) });
    }
  });

  router.delete('/code-projects/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Code project management not available' });
        return;
      }
      const id = parseInt(req.params.id as string, 10);
      // Use the central lifecycle helper so we DON'T leak LadybugDB nodes,
      // LanceDB vectors, or in-memory FlexSearch entries (the previous bare
      // db.deleteProject() call was leaking all three).
      const { removeProject } = await import('../fantom-code/projectLifecycle.js');
      const { getPrismaClient } = await import('../db/prisma.js');
      try {
        const result = await removeProject(getPrismaClient(), id, { keepRow: false });
        // Surface partial-failure: e.g. graph step blocked by LadybugDB lock,
        // prisma row not deleted. Returning success:true here would lie to the
        // dashboard and the row would silently remain.
        const failedSteps = Object.entries(result.steps ?? {})
          .filter(([, v]) => v === 'failed')
          .map(([k]) => k);
        if (result.success === false || failedSteps.length > 0) {
          res.status(409).json({
            success: false,
            message: 'Code project removal blocked',
            failedSteps,
            firstError: (result.errors ?? [])[0],
            detail: result,
          });
          return;
        }
        res.json({ success: true, message: 'Code project removed', detail: result });
      } catch (err) {
        if (err instanceof Error && err.message.includes('not found')) {
          res.status(404).json({ error: err.message });
        } else {
          throw err;
        }
      }
    } catch (error) {
      console.error('[Admin] Failed to delete code project:', error);
      res.status(500).json({ error: 'Failed to delete code project', details: String(error) });
    }
  });

  // Clear a project's index data while keeping its registration row.
  // Useful when a project is polluted with build artifacts — clear,
  // tighten excludePatterns, then re-index.
  router.post('/code-projects/:id/clear-index', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Code project management not available' });
        return;
      }
      const id = parseInt(req.params.id as string, 10);
      const { removeProject } = await import('../fantom-code/projectLifecycle.js');
      const { getPrismaClient } = await import('../db/prisma.js');
      const result = await removeProject(getPrismaClient(), id, { keepRow: true });
      res.json({ success: true, message: 'Project index cleared (row kept)', detail: result });
    } catch (error) {
      console.error('[Admin] Failed to clear project index:', error);
      res.status(500).json({ error: 'Failed to clear project index', details: String(error) });
    }
  });

  // Phase 1 cross-project resolution: build the global name index across
  // every (or selected) Ladybug project DB and return summary stats. No edges
  // are written — Phase 2 storage decision is deferred (see specs/).
  router.get('/graph/cross-project-name-index', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Code project management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const filterIds = (req.query.projectIds as string | undefined)
        ?.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !Number.isNaN(n));
      const all = await db.getAllProjects();
      const projectIds = filterIds && filterIds.length > 0
        ? all.filter(p => filterIds.includes(p.id)).map(p => p.id)
        : all.map(p => p.id);
      const { getCodeIndexingService } = await import('../fantom-code/codeIndexingService.js');
      const { getPrismaClient } = await import('../db/prisma.js');
      const svc = getCodeIndexingService(getPrismaClient());
      const idx = await svc.buildCrossProjectNameIndex(projectIds);
      // Return summary by default; only return full entries when ?full=1.
      const full = req.query.full === '1' || req.query.full === 'true';
      const ambiguous = Object.entries(idx.entries)
        .filter(([, v]) => v.length > 1)
        .map(([name, v]) => ({ name, candidates: v.length }))
        .sort((a, b) => b.candidates - a.candidates)
        .slice(0, 50);
      res.json({
        projectsScanned: idx.projectsScanned,
        totalNodes: idx.totalNodes,
        distinctNames: idx.distinctNames,
        ambiguousTop50: ambiguous,
        ...(full ? { entries: idx.entries } : {}),
      });
    } catch (error) {
      console.error('[Admin] cross-project-name-index failed:', error);
      res.status(500).json({ error: 'Failed to build cross-project name index', details: String(error) });
    }
  });

  // Phase 2: actually persist cross-project edges to Prisma's
  // cross_project_edges table. Body: { projectIds?: number[] } — omit for all.
  router.post('/graph/resolve-cross-project', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Code project management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const requested: number[] | undefined = Array.isArray(req.body?.projectIds) ? req.body.projectIds : undefined;
      const all = await db.getAllProjects();
      const projectIds = requested && requested.length > 0
        ? all.filter(p => requested.includes(p.id)).map(p => p.id)
        : all.map(p => p.id);
      const { getCodeIndexingService } = await import('../fantom-code/codeIndexingService.js');
      const { getPrismaClient } = await import('../db/prisma.js');
      const svc = getCodeIndexingService(getPrismaClient());
      const result = await svc.resolveCrossProjectEdges(projectIds);
      res.json({ ok: true, ...result });
    } catch (error) {
      console.error('[Admin] resolve-cross-project failed:', error);
      res.status(500).json({ error: 'Failed to resolve cross-project edges', details: String(error) });
    }
  });

  // List persisted cross-project edges for a given project (either as source
  // or as target). Honors ?role=source|target|both (default both).
  router.get('/code-projects/:id/cross-project-edges', async (req: Request, res: Response): Promise<void> => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (Number.isNaN(id)) {
        res.status(400).json({ error: 'invalid project id' });
        return;
      }
      const { getPrismaClient } = await import('../db/prisma.js');
      const prisma = getPrismaClient();
      const role = (req.query.role as string) || 'both';
      const where = role === 'source'
        ? { sourceProjectId: id }
        : role === 'target'
          ? { targetProjectId: id }
          : { OR: [{ sourceProjectId: id }, { targetProjectId: id }] };
      const limit = Math.max(1, Math.min(parseInt(req.query.limit as string) || 500, 5000));
      const edges = await prisma.crossProjectEdge.findMany({
        where,
        orderBy: { resolvedAt: 'desc' },
        take: limit,
      });
      res.json({ projectId: id, role, count: edges.length, edges });
    } catch (error) {
      console.error('[Admin] cross-project-edges list failed:', error);
      res.status(500).json({ error: 'Failed to list cross-project edges', details: String(error) });
    }
  });

  // Cross-language edges (e.g. axon → fantom calls) within a project.
  router.get('/code-projects/:id/cross-language-edges', async (req: Request, res: Response): Promise<void> => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (Number.isNaN(id)) {
        res.status(400).json({ error: 'invalid project id' });
        return;
      }
      const { getCrossLanguageEdges } = await import('../graph/ladybugQueryManager.js');
      const rows = await getCrossLanguageEdges(id, {
        sourceLang: req.query.sourceLang as string | undefined,
        targetLang: req.query.targetLang as string | undefined,
        limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      });
      res.json({ projectId: id, count: rows.length, edges: rows });
    } catch (error) {
      console.error('[Admin] cross-language-edges failed:', error);
      res.status(500).json({ error: 'Failed to list cross-language edges', details: String(error) });
    }
  });

  // Detect languages in a code project
  router.get('/code-projects/:id/languages', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Code project management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const id = parseInt(req.params.id as string, 10);
      const project = await db.getProjectById(id);

      if (!project) {
        res.status(404).json({ error: 'Code project not found' });
        return;
      }

      if (!fs.existsSync(project.path)) {
        res.status(404).json({ error: 'Project directory not found', path: project.path });
        return;
      }

      const result = detectLanguagesInDirectory(project.path);
      res.json(result);
    } catch (error) {
      console.error('[Admin] Failed to detect languages in code project:', error);
      res.status(500).json({ error: 'Failed to detect languages', details: String(error) });
    }
  });

  // ============================================
  // Project dependencies (ask scope)
  // See src/fantom/projectDependencies.ts for kinds and the derivation rules.
  // ============================================

  /** Summary for list pages: per-project enabled counts + path → projectId map. */
  router.get('/project-dependencies/summary', async (_req: Request, res: Response): Promise<void> => {
    try {
      const { summarizeProjectDependencies } = await import('../fantom/projectDependencies.js');
      res.json(await summarizeProjectDependencies());
    } catch (error) {
      console.error('[Admin] Failed to summarize project dependencies:', error);
      res.status(500).json({ error: 'Failed to summarize project dependencies', details: String(error) });
    }
  });

  /** Rebuild the automatic dependency rows of every indexed project. */
  router.post('/code-projects/dependencies/rebuild-all', async (_req: Request, res: Response): Promise<void> => {
    try {
      const { rebuildAllProjectDependencies } = await import('../fantom/projectDependencies.js');
      res.json(await rebuildAllProjectDependencies());
    } catch (error) {
      console.error('[Admin] Failed to rebuild all project dependencies:', error);
      res.status(500).json({ error: 'Failed to rebuild project dependencies', details: String(error) });
    }
  });

  /** Dependencies (both directions) + scope preview + declared build.fan / package.json entries. */
  router.get('/code-projects/:id/dependencies', async (req: Request, res: Response): Promise<void> => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (!Number.isFinite(id)) { res.status(400).json({ error: 'Invalid project id' }); return; }
      const { listProjectDependencies, getDeclaredDependencies, getProjectScope } = await import('../fantom/projectDependencies.js');
      const list = await listProjectDependencies(id);
      if (!list) { res.status(404).json({ error: 'Code project not found' }); return; }
      const includeDeclared = req.query.declared !== 'false';
      const [declared, scope] = await Promise.all([
        includeDeclared ? getDeclaredDependencies(id) : Promise.resolve([]),
        getProjectScope(id),
      ]);
      res.json({ ...list, declared, scope: scope?.related ?? [], scopeFallback: scope?.fallback ?? false });
    } catch (error) {
      console.error('[Admin] Failed to list project dependencies:', error);
      res.status(500).json({ error: 'Failed to list project dependencies', details: String(error) });
    }
  });

  /** Add a manual dependency: { toProjectId, kind?: 'manual', source? } */
  router.post('/code-projects/:id/dependencies', async (req: Request, res: Response): Promise<void> => {
    try {
      const id = parseInt(req.params.id as string, 10);
      const toProjectId = Number(req.body?.toProjectId);
      const kind = typeof req.body?.kind === 'string' ? req.body.kind : 'manual';
      if (!Number.isFinite(id) || !Number.isFinite(toProjectId)) { res.status(400).json({ error: 'toProjectId is required' }); return; }
      if (kind !== 'manual') { res.status(400).json({ error: "Only kind 'manual' can be created; automatic kinds are derived by rebuild" }); return; }
      if (toProjectId === id) { res.status(400).json({ error: 'A project cannot depend on itself' }); return; }
      const { getPrismaClient } = await import('../db/prisma.js');
      const prisma = getPrismaClient();
      const [from, to] = await Promise.all([
        prisma.fantomProject.findUnique({ where: { id }, select: { id: true } }),
        prisma.fantomProject.findUnique({ where: { id: toProjectId }, select: { id: true, name: true } }),
      ]);
      if (!from || !to) { res.status(404).json({ error: 'Code project not found' }); return; }
      const source = typeof req.body?.source === 'string' && req.body.source.trim() ? req.body.source.trim() : 'dashboard';
      const row = await prisma.projectDependency.upsert({
        where: { fromProjectId_toProjectId_kind: { fromProjectId: id, toProjectId, kind: 'manual' } },
        create: { fromProjectId: id, toProjectId, kind: 'manual', source, confidence: 1.0, enabled: true },
        update: { source, enabled: true },
      });
      res.status(201).json({ ...row, name: to.name });
    } catch (error) {
      console.error('[Admin] Failed to add project dependency:', error);
      res.status(500).json({ error: 'Failed to add project dependency', details: String(error) });
    }
  });

  /** Recompute the automatic rows of one project. */
  router.post('/code-projects/:id/dependencies/rebuild', async (req: Request, res: Response): Promise<void> => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (!Number.isFinite(id)) { res.status(400).json({ error: 'Invalid project id' }); return; }
      const { rebuildProjectDependencies } = await import('../fantom/projectDependencies.js');
      res.json(await rebuildProjectDependencies(id));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/not found/i.test(msg)) { res.status(404).json({ error: msg }); return; }
      console.error('[Admin] Failed to rebuild project dependencies:', error);
      res.status(500).json({ error: 'Failed to rebuild project dependencies', details: msg });
    }
  });

  /** Toggle a relation without deleting it: { enabled: boolean }. Survives rebuilds. */
  router.patch('/code-projects/:id/dependencies/:depId', async (req: Request, res: Response): Promise<void> => {
    try {
      const id = parseInt(req.params.id as string, 10);
      const depId = parseInt(req.params.depId as string, 10);
      if (!Number.isFinite(id) || !Number.isFinite(depId)) { res.status(400).json({ error: 'Invalid id' }); return; }
      if (typeof req.body?.enabled !== 'boolean') { res.status(400).json({ error: 'enabled (boolean) is required' }); return; }
      const { getPrismaClient } = await import('../db/prisma.js');
      const prisma = getPrismaClient();
      const row = await prisma.projectDependency.findUnique({ where: { id: depId } });
      if (!row || (row.fromProjectId !== id && row.toProjectId !== id)) { res.status(404).json({ error: 'Dependency not found' }); return; }
      const updated = await prisma.projectDependency.update({ where: { id: depId }, data: { enabled: req.body.enabled } });
      res.json(updated);
    } catch (error) {
      console.error('[Admin] Failed to update project dependency:', error);
      res.status(500).json({ error: 'Failed to update project dependency', details: String(error) });
    }
  });

  /** Delete a manual dependency (automatic rows only with ?force=1 — they come back on the next rebuild; prefer PATCH enabled=false). */
  router.delete('/code-projects/:id/dependencies/:depId', async (req: Request, res: Response): Promise<void> => {
    try {
      const id = parseInt(req.params.id as string, 10);
      const depId = parseInt(req.params.depId as string, 10);
      if (!Number.isFinite(id) || !Number.isFinite(depId)) { res.status(400).json({ error: 'Invalid id' }); return; }
      const force = req.query.force === '1' || req.query.force === 'true';
      const { getPrismaClient } = await import('../db/prisma.js');
      const prisma = getPrismaClient();
      const row = await prisma.projectDependency.findUnique({ where: { id: depId } });
      if (!row || (row.fromProjectId !== id && row.toProjectId !== id)) { res.status(404).json({ error: 'Dependency not found' }); return; }
      if (row.kind !== 'manual' && !force) {
        res.status(409).json({ error: `Kind '${row.kind}' is derived automatically; use PATCH {enabled:false} to switch it off, or ?force=1 to delete until the next rebuild` });
        return;
      }
      await prisma.projectDependency.delete({ where: { id: depId } });
      res.json({ success: true, id: depId });
    } catch (error) {
      console.error('[Admin] Failed to delete project dependency:', error);
      res.status(500).json({ error: 'Failed to delete project dependency', details: String(error) });
    }
  });

  router.post('/code-projects/:id/reindex', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase || !context.reindexProject) {
        res.status(501).json({ error: 'Code project reindexing not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const id = parseInt(req.params.id as string, 10);
      const project = await db.getProjectById(id);

      if (!project) {
        res.status(404).json({ error: 'Code project not found' });
        return;
      }

      const force = req.query.force === 'true' || req.body?.force === true;
      const result = await context.reindexProject(id, { force });
      invalidateProjectNodeCount(id); // graph node count may have changed
      res.json(result);
    } catch (error) {
      const { HeavyJobBusyError } = await import('../embedding/embedGate.js');
      if (error instanceof HeavyJobBusyError) {
        res.status(409).json({ error: `Another heavy job is running: ${error.holder.kind} (${error.holder.label}) since ${error.holder.since}. Retry when it finishes.`, heavyJob: error.holder });
        return;
      }
      console.error('[Admin] Failed to reindex code project:', error);
      res.status(500).json({ error: 'Failed to reindex code project', details: String(error) });
    }
  });

  /**
   * POST /admin/code-projects/:id/rebuild-graph
   *
   * Re-parses the project's source files and rewrites just the Ladybug
   * nodes/edges for this project — no embedding work, no FlexSearch rebuild.
   * Useful when the 3D graph view shows stale/missing edges and a full
   * reindex would be overkill.
   */
  router.post('/code-projects/:id/rebuild-graph', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Graph rebuild not available' });
        return;
      }
      const id = parseInt(req.params.id as string, 10);
      if (!Number.isFinite(id)) {
        res.status(400).json({ error: 'Invalid project id' });
        return;
      }
      const db = await context.getFantomDatabase();
      const project = await db.getProjectById(id);
      if (!project) {
        res.status(404).json({ error: 'Code project not found' });
        return;
      }

      const { getPrismaClient } = await import('../db/prisma.js');
      const { getCodeIndexingService } = await import('../fantom-code/codeIndexingService.js');
      const service = getCodeIndexingService(getPrismaClient());
      const result = await service.rebuildGraph(id);
      invalidateProjectNodeCount(id); // graph node count may have changed
      // buildLadybugGraph swallows lock / native errors and returns
      // success=false with zeroed counters. Surface that to the UI instead
      // of reporting "Rebuilt: 0 nodes" — the user otherwise can't tell the
      // difference between "project has nothing to index" and "another
      // fantom-mcp process is holding the per-project Ladybug lock".
      if (!result.success) {
        res.status(409).json({
          success: false,
          projectId: id,
          projectName: project.name,
          nodeCount: result.nodeCount,
          edgeCount: result.edgeCount,
          errors: result.errors,
          error: result.errors[0] || 'Graph rebuild failed (see server logs)',
        });
        return;
      }
      res.json({
        success: true,
        projectId: id,
        projectName: project.name,
        nodeCount: result.nodeCount,
        edgeCount: result.edgeCount,
      });
    } catch (error) {
      console.error('[Admin] Failed to rebuild project graph:', error);
      res.status(500).json({ error: 'Failed to rebuild project graph', details: String(error) });
    }
  });

  router.get('/code-stats', (_req: Request, res: Response): void => {
    try {
      if (!context.getCodeStats) {
        res.status(501).json({ error: 'Code stats not available' });
        return;
      }
      const stats = context.getCodeStats();
      res.json(stats);
    } catch (error) {
      console.error('[Admin] Failed to get code stats:', error);
      res.status(500).json({ error: 'Failed to get code stats' });
    }
  });

  // ============================================
  // Reindex endpoint - enables autoIndex for all projects and rebuilds the index
  // ============================================

  router.post('/reindex', async (_req: Request, res: Response): Promise<void> => {
    try {
      if (!context.reindexCode) {
        res.status(501).json({ error: 'Reindex not available' });
        return;
      }

      const result = await context.reindexCode();
      res.json({
        success: true,
        projectsEnabled: result.projectsEnabled,
        indexedFunctions: result.indexedFunctions
      });
    } catch (error) {
      console.error('[Admin] Failed to reindex code:', error);
      res.status(500).json({ error: 'Failed to reindex code', details: String(error) });
    }
  });

  // ============================================
  // Graph Rebuild endpoint
  // ============================================

  // Per-project LadybugDB connection pool: open/cap, LRU entries, and how many
  // native closes have failed (a failed close orphans that DB's memory).
  router.get('/graph/connection-pool', async (_req: Request, res: Response): Promise<void> => {
    try {
      const { getProjectConnectionPoolStats } = await import('../graph/projectGraphConnection.js');
      const mem = process.memoryUsage();
      res.json({
        ...getProjectConnectionPoolStats(),
        process: { rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(mem.heapUsed / 1048576), externalMb: Math.round(mem.external / 1048576) },
      });
    } catch (err) {
      res.status(500).json({ error: String((err as Error).message ?? err) });
    }
  });

  router.post('/graph/rebuild', async (_req: Request, res: Response): Promise<void> => {
    try {
      if (!context.rebuildAllGraphs) {
        res.status(501).json({ error: 'Graph rebuild not available' });
        return;
      }

      const result = await context.rebuildAllGraphs();
      res.json({
        success: true,
        ...result
      });
    } catch (error) {
      console.error('[Admin] Failed to rebuild graphs:', error);
      res.status(500).json({ error: 'Failed to rebuild graphs', details: String(error) });
    }
  });

  /**
   * GET /admin/graph/ladybug-stats
   *
   * Diagnostic: returns node/edge counts from LadybugDB with optional
   * per-project breakdown. Lets us cross-check that the SQLite graph matches
   * Ladybug after the backfill without writing ad-hoc scripts.
   */
  router.get('/graph/ladybug-stats', async (req: Request, res: Response): Promise<void> => {
    try {
      // Open the connection (idempotent) so the health check has something
      // to ping — isLadybugInitialized() returns false until the first
      // getLadybugConnection() call, which only happens lazily.
      const { getLadybugConnection } = await import('../graph/ladybugConnection.js');
      await getLadybugConnection();
      if (!await isLadybugInitialized()) {
        res.json({ initialized: false });
        return;
      }
      const projectIdParam = req.query.projectId as string | undefined;
      if (projectIdParam) {
        const pid = parseInt(projectIdParam, 10);
        if (isNaN(pid)) {
          res.status(400).json({ error: 'projectId must be a number' });
          return;
        }
        const nodes = await ladybugQuery<{ c: number }>(
          `MATCH (n:CodeNode {project_id: ${pid}}) RETURN count(n) AS c`
        );
        const edges = await ladybugQuery<{ c: number }>(
          `MATCH (n:CodeNode {project_id: ${pid}})-[e:CodeEdge]->() RETURN count(e) AS c`
        );
        res.json({
          initialized: true,
          projectId: pid,
          nodes: nodes[0]?.c ?? 0,
          edges: edges[0]?.c ?? 0
        });
        return;
      }
      const [totals, byProject] = await Promise.all([
        Promise.all([
          ladybugQuery<{ c: number }>('MATCH (n:CodeNode) RETURN count(n) AS c'),
          ladybugQuery<{ c: number }>('MATCH ()-[e:CodeEdge]->() RETURN count(e) AS c')
        ]),
        ladybugQuery<{ pid: number; c: number }>(
          'MATCH (n:CodeNode) RETURN n.project_id AS pid, count(n) AS c ORDER BY pid'
        )
      ]);
      res.json({
        initialized: true,
        totalNodes: totals[0][0]?.c ?? 0,
        totalEdges: totals[1][0]?.c ?? 0,
        projects: byProject
      });
    } catch (error) {
      console.error('[Admin] ladybug-stats failed:', error);
      res.status(500).json({ error: 'ladybug-stats failed', details: String(error) });
    }
  });

  /**
   * Fast-mode backfill: one-shot full rebuild of the Ladybug graph from the
   * Prisma SQLite DB via bulk COPY FROM. Nodes use Kuzu's SQLite extension;
   * edges go through a transient CSV (Kuzu 0.15's SQLite-backed REL COPY has
   * an internal off-by-one bug — "Attempted to access index 3 within vector
   * of size 3" — so we route edges via a temp CSV instead).
   *
   * Wipes .cache/fantom-graph.db entirely, so any in-flight Ladybug writes
   * are lost. Intended for one-time migration, not ongoing incremental syncs.
   */
  async function runFastBackfill() {
    const { closeLadybugConnection, getLadybugConnection, ladybugQuery: lbq } =
      await import('../graph/ladybugConnection.js');
    const path = await import('path');
    const fs = await import('fs');
    const Database = (await import('better-sqlite3')).default;

    const t0 = Date.now();
    const { getCachePath } = await import('../utils/installRoot.js');
    const prismaDbPath = getCachePath('fantom.db');
    const graphDbPath = getCachePath('fantom-graph.db');
    const tmpDir = getCachePath('ladybug-backfill-tmp');
    const edgesCsv = path.join(tmpDir, 'edges.csv');

    const timing: Record<string, number> = {};
    let nodeCount = 0;
    let edgeCount = 0;

    try {
      // 1. Close existing Ladybug connection and wipe graph DB for a clean
      //    slate (Kuzu's COPY FROM into node tables requires empty tables,
      //    and the catalog persists stale ATTACH references otherwise).
      const t1 = Date.now();
      await closeLadybugConnection();
      if (fs.existsSync(graphDbPath)) {
        fs.rmSync(graphDbPath, { recursive: true, force: true });
      }
      if (fs.existsSync(graphDbPath + '.wal')) fs.rmSync(graphDbPath + '.wal');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      timing.prepMs = Date.now() - t1;

      // 2. Dump edges to CSV via better-sqlite3. Orphan edges (source/target
      //    missing in code_nodes) are filtered client-side — the SQL
      //    correlated-subquery form was O(edges × nodes) and degenerated into
      //    minutes of CPU on this dataset.
      const t2 = Date.now();
      const sqlite = new Database(prismaDbPath, { readonly: true });

      const validIds = new Set<string>();
      for (const r of sqlite.prepare('SELECT id FROM code_nodes').iterate() as Iterable<{ id: string }>) {
        validIds.add(r.id);
      }

      const edgeStmt = sqlite.prepare(`
        SELECT source_id, target_id, edge_type,
               COALESCE(line_number, 0) AS line_number,
               COALESCE(col_number, 0) AS col_number,
               CASE WHEN is_resolved = 1 THEN 'true' ELSE 'false' END AS is_resolved,
               COALESCE(metadata, '') AS metadata
        FROM code_edges
      `);
      const csvHeader = 'source_id,target_id,edge_type,line_number,col_number,is_resolved,confidence,metadata\n';
      const csvStream = fs.createWriteStream(edgesCsv, { encoding: 'utf8' });
      csvStream.write(csvHeader);
      let dumped = 0;
      let orphansDropped = 0;
      const escapeCsv = (v: unknown): string => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      };
      for (const row of edgeStmt.iterate() as Iterable<Record<string, unknown>>) {
        if (!validIds.has(row.source_id as string) || !validIds.has(row.target_id as string)) {
          orphansDropped++;
          continue;
        }
        csvStream.write(
          [
            escapeCsv(row.source_id),
            escapeCsv(row.target_id),
            escapeCsv(row.edge_type),
            String(row.line_number ?? 0),
            String(row.col_number ?? 0),
            String(row.is_resolved),
            '1.0',
            escapeCsv(row.metadata),
          ].join(',') + '\n'
        );
        dumped++;
      }
      await new Promise<void>((resolve, reject) => {
        csvStream.end((err: NodeJS.ErrnoException | null | undefined) =>
          err ? reject(err) : resolve()
        );
      });
      sqlite.close();
      timing.dumpEdgesMs = Date.now() - t2;

      // 3. Reopen Ladybug (fresh DB), install SQLite extension, ATTACH Prisma.
      const t3 = Date.now();
      const conn = await getLadybugConnection();
      const exec = async (cy: string) => {
        const r = await conn.query(cy);
        try { await (Array.isArray(r) ? r[0] : r).getAll(); } catch { /* ignore */ }
      };
      await exec('INSTALL sqlite');
      await exec('LOAD EXTENSION sqlite');
      await exec(`ATTACH '${prismaDbPath}' AS prisma_src (dbtype sqlite)`);

      // 4. Re-create the Kuzu graph schema from scratch (matches ladybugSchema.ts).
      await exec(`CREATE NODE TABLE CodeNode(
        id STRING, project_id INT64, node_type STRING, name STRING, qualified_name STRING,
        file_path STRING, line_start INT64, line_end INT64, col_start INT64, col_end INT64,
        signature STRING, documentation STRING, return_type STRING, modifiers STRING,
        facets STRING, parent_type STRING,
        is_public BOOLEAN, is_static BOOLEAN, is_abstract BOOLEAN, is_virtual BOOLEAN,
        is_override BOOLEAN, is_exported BOOLEAN, language STRING,
        PRIMARY KEY(id)
      )`);
      await exec(`CREATE REL TABLE CodeEdge(
        FROM CodeNode TO CodeNode,
        edge_type STRING, line_number INT64, col_number INT64,
        is_resolved BOOLEAN, confidence DOUBLE, metadata STRING
      )`);
      timing.schemaMs = Date.now() - t3;

      // 5. Bulk-load nodes via Kuzu's SQLite scanner (avoids the CSV round-
      //    trip for nodes — SQLite-sourced node COPY is stable in 0.15).
      //    SQLite booleans are INTs; Kuzu rejects CAST(INT64 AS BOOLEAN), so
      //    we express each flag as `col = 1`.
      const t4 = Date.now();
      await exec(`COPY CodeNode FROM (
        LOAD FROM prisma_src.code_nodes
        RETURN id, project_id, node_type, name, qualified_name, file_path,
               line_start, line_end, col_start, col_end,
               COALESCE(signature, '') AS signature,
               COALESCE(documentation, '') AS documentation,
               COALESCE(return_type, '') AS return_type,
               COALESCE(modifiers, '') AS modifiers,
               COALESCE(facets, '') AS facets,
               COALESCE(parent_type, '') AS parent_type,
               (is_public = 1) AS is_public,
               (is_static = 1) AS is_static,
               (is_abstract = 1) AS is_abstract,
               (is_virtual = 1) AS is_virtual,
               (is_override = 1) AS is_override,
               (is_exported = 1) AS is_exported,
               COALESCE(language, 'fantom') AS language
      )`);
      timing.copyNodesMs = Date.now() - t4;

      // 6. Bulk-load edges from the CSV. Kuzu's CSV COPY is mature and
      //    supports full parallel parsing.
      const t5 = Date.now();
      await exec(`COPY CodeEdge FROM '${edgesCsv}' (HEADER=true)`);
      timing.copyEdgesMs = Date.now() - t5;

      // 7. Verify counts.
      const nc = await lbq<{ c: number }>('MATCH (n:CodeNode) RETURN count(n) AS c');
      const ec = await lbq<{ c: number }>('MATCH ()-[e:CodeEdge]->() RETURN count(e) AS c');
      nodeCount = Number(nc[0]?.c ?? 0);
      edgeCount = Number(ec[0]?.c ?? 0);

      timing.totalMs = Date.now() - t0;

      return {
        success: true,
        mode: 'fast',
        nodeCount,
        edgeCount,
        edgesDumped: dumped,
        orphansDropped,
        timing,
      };
    } finally {
      // Leave temp CSV on disk if the import failed so the operator can
      // inspect it; otherwise clean up.
      if (edgeCount > 0 && fs.existsSync(edgesCsv)) {
        try { fs.unlinkSync(edgesCsv); } catch { /* ignore */ }
        try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
      }
    }
  }

  /**
   * POST /admin/graph/backfill-ladybug
   *
   * One-time migration helper: copies every project's code_nodes/code_edges
   * from SQLite/Prisma into LadybugDB so Ladybug can become the authoritative
   * read store without losing history. Safe to re-run — clearProjectGraph()
   * wipes a project's Ladybug data before re-inserting.
   *
   * Query params:
   *   projectId: numeric project id, or "all" (default: "all")
   *   dryRun:    "true" to report planned row counts without writing
   *   mode:      "fast" — uses Kuzu COPY FROM (wipes Ladybug DB first)
   */
  router.post('/graph/backfill-ladybug', async (req: Request, res: Response): Promise<void> => {
    try {
      const projectIdParam = (req.query.projectId as string | undefined) ?? 'all';
      const dryRun = String(req.query.dryRun ?? 'false').toLowerCase() === 'true';
      const mode = String(req.query.mode ?? 'unwind').toLowerCase();

      // Fast path: full-database COPY FROM CSV. 25,000× faster than the
      // per-project UNWIND path because Kuzu's COPY FROM bulk-loads in one
      // shot. Trade-off: wipes the entire Ladybug graph DB first (any in-
      // flight Ladybug writes are lost), so it only makes sense as a one-
      // shot migration. projectId/dryRun are ignored in fast mode.
      if (mode === 'fast' && !dryRun) {
        const fastResult = await runFastBackfill();
        res.json(fastResult);
        return;
      }

      // The UNWIND-based per-project loop was dropped once the Prisma graph
      // schema moved out (code_nodes / code_edges no longer exist). The
      // fast-mode COPY FROM path remains the sole backfill — it reads from a
      // SQLite snapshot file (pre-cutover) rather than the live Prisma client.
      res.status(410).json({
        success: false,
        error:
          'Unwind mode removed after Stage 3 cutover. Use mode=fast against the pre-cutover SQLite snapshot at .cache/fantom.db.pre-ladybug-cutover (if kept).',
        projectIdParam,
        dryRun,
      });
    } catch (error) {
      console.error('[Admin] backfill-ladybug failed:', error);
      res.status(500).json({ error: 'Backfill failed', details: String(error) });
    }
  });

  // ============================================
  // AST Cache Viewer endpoints
  // ============================================

  router.get('/code-projects/:id/ast', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Code project management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const id = parseInt(req.params.id as string, 10);
      const project = await db.getProjectById(id);

      if (!project) {
        res.status(404).json({ error: 'Code project not found' });
        return;
      }

      const indexer = getFantomCodeIndexer();
      const functions = indexer.getFunctionsByProject(id);
      const allTypes = indexer.getAllTypes();
      const types = allTypes.filter(t => t.projectId === id);

      // Group functions by class
      const functionsByClass: Record<string, typeof functions> = {};
      const standaloneFunctions: typeof functions = [];

      for (const func of functions) {
        if (func.className) {
          if (!functionsByClass[func.className]) {
            functionsByClass[func.className] = [];
          }
          functionsByClass[func.className].push(func);
        } else {
          standaloneFunctions.push(func);
        }
      }

      res.json({
        projectId: id,
        projectName: project.name,
        projectPath: project.path,
        lastIndexed: project.lastIndexed,
        summary: {
          totalFunctions: functions.length,
          totalTypes: types.length,
          totalClasses: Object.keys(functionsByClass).length
        },
        types: types.map(t => ({
          id: t.id,
          name: t.name,
          qualifiedName: t.qualifiedName,
          kind: t.kind,
          filePath: t.filePath,
          lineNumber: t.lineNumber,
          extends: t.extends,
          mixins: t.mixins,
          isPublic: t.isPublic,
          isAbstract: t.isAbstract,
          documentation: t.documentation,
          methodCount: t.methods?.length || 0,
          fieldCount: t.fields?.length || 0
        })),
        functions: functions.map(f => ({
          id: f.id,
          name: f.name,
          qualifiedName: f.qualifiedName,
          type: f.type,
          className: f.className,
          filePath: f.filePath,
          lineNumber: f.lineNumber,
          signature: f.signature,
          returnType: f.returnType,
          parameters: f.parameters,
          description: f.description,
          category: f.category,
          isPublic: f.isPublic,
          isStatic: f.isStatic,
          isAbstract: f.isAbstract
        })),
        functionsByClass
      });
    } catch (error) {
      console.error('[Admin] Failed to get AST data:', error);
      res.status(500).json({ error: 'Failed to get AST data', details: String(error) });
    }
  });

  router.get('/fantom-pods/:id/ast', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Pod management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      // Decode URL-encoded characters (e.g., %2E -> .)
      const idParam = decodeURIComponent(req.params.id as string);

      // Parse stable ID format: {podName}-{minVersion}-{maxVersion}
      // Example: hxEcobee-4.0.0-4.0.4 or bassgCommon-3.1.0-3.1.12
      // Version format is X.Y.Z so we look for the pattern
      const parseStableId = (stableId: string): { podName: string; minVersion: string; maxVersion: string } | null => {
        // Pattern: podName-X.Y.Z-X.Y.Z (versions are semver-like)
        const versionPattern = /^(.+)-(\d+\.\d+\.\d+)-(\d+\.\d+\.\d+)$/;
        const match = stableId.match(versionPattern);
        if (!match) return null;
        return { podName: match[1], minVersion: match[2], maxVersion: match[3] };
      };

      // Parse Fantom Build ID format: fantom.{version}.{podName}
      // Example: fantom.1.0.81.webmod, fantom.1.0.82.sys
      const parseFantomBuildId = (id: string): { version: string; podName: string } | null => {
        // Pattern: fantom.X.Y.Z.podName (version is semver-like)
        const fantomBuildPattern = /^fantom\.(\d+\.\d+\.\d+)\.(.+)$/;
        const match = id.match(fantomBuildPattern);
        if (!match) return null;
        return { version: match[1], podName: match[2] };
      };

      const instances = await db.getAllInstances();
      const projects = await db.getAllProjects();
      const pods = await db.getAllPods();

      let pod: { id: number; name: string; path: string; buildFile: string; description?: string; defaultInstanceId?: number; compatMinVersion?: string; compatMaxVersion?: string; compatVersions?: string[]; createdAt: string; updatedAt: string; } | undefined;
      let project: Awaited<ReturnType<typeof db.getAllProjects>>[0] | undefined;

      // First, try parsing as Fantom Build ID (fantom.{version}.{podName})
      const parsedFantomBuild = parseFantomBuildId(idParam);
      if (parsedFantomBuild) {
        // Find project directly by name (format: fantom.{version}.{podName})
        project = projects.find(p => p.name === idParam);
        if (project) {
          // Create synthetic pod from project
          pod = {
            id: project.id,
            name: parsedFantomBuild.podName,
            path: project.path,
            buildFile: 'build.fan',
            description: project.description || undefined,
            defaultInstanceId: undefined,
            compatMinVersion: parsedFantomBuild.version,
            compatMaxVersion: parsedFantomBuild.version,
            compatVersions: [],
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
          };
        }
      }

      // Try parsing as stable ID if not found
      const parsed = !pod && !project ? parseStableId(idParam) : null;

      if (parsed) {
        // Find by stable ID components: podName, minVersion, maxVersion
        const { podName, minVersion, maxVersion } = parsed;

        // First, try to find a pod with matching name and version range
        const matchedPod = pods.find(p => {
          if (p.name !== podName) return false;
          // Check if versions match (exact match or compatible range)
          const podMin = p.compatMinVersion || '0.0.0';
          const podMax = p.compatMaxVersion || podMin;
          return podMin === minVersion && podMax === maxVersion;
        });

        if (matchedPod) {
          pod = matchedPod;
          project = projects.find(p => normalizePath(p.path) === normalizePath(matchedPod.path));
        }

        // If not found in pods, try projects by podName and instance version
        if (!pod && !project) {
          // Find projects with matching podName
          const matchingProjects = projects.filter(p => (p.podName || p.name) === podName);

          // Try to find one with matching instance version
          for (const proj of matchingProjects) {
            if (proj.instanceId) {
              const inst = instances.find(i => i.id === proj.instanceId);
              // For source-indexed, minVersion === maxVersion === instance.version
              // Normalize null/undefined version to '0.0.0' to match stable ID generation
              const instVer = inst?.version || '0.0.0';
              if (instVer === minVersion && instVer === maxVersion) {
                project = proj;
                break;
              }
            }
          }

          // If no exact version match, just use the first matching podName
          if (!project && matchingProjects.length > 0) {
            project = matchingProjects[0];
          }
        }

        // Also check pods table by name if still not found
        if (!pod && !project) {
          const podByName = pods.find(p => p.name === podName);
          if (podByName) {
            pod = podByName;
            project = projects.find(p => normalizePath(p.path) === normalizePath(podByName.path));
          }
        }

        if (project && !pod) {
          // Create synthetic pod from project
          pod = {
            id: project.id,
            name: project.podName || project.name,
            path: project.path,
            buildFile: 'build.fan',
            description: project.description || undefined,
            defaultInstanceId: project.instanceId || undefined,
            compatMinVersion: minVersion,
            compatMaxVersion: maxVersion,
            compatVersions: [],
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
          };
        }
      } else {
        // Fallback: try parsing as numeric ID (for backwards compatibility)
        const numericId = parseInt(idParam, 10);
        if (!isNaN(numericId)) {
          // Handle negative IDs (legacy format)
          const isSourceProject = numericId < 0;
          const id = isSourceProject ? -numericId : numericId;

          if (isSourceProject) {
            project = projects.find(p => p.id === id);
          } else {
            const foundPod = await db.getPodById(id);
            if (foundPod) {
              pod = foundPod;
              project = projects.find(p => normalizePath(p.path) === normalizePath(foundPod.path));
            } else {
              project = projects.find(p => p.id === id);
            }
          }

          if (project && !pod) {
            pod = {
              id: project.id,
              name: project.podName || project.name,
              path: project.path,
              buildFile: 'build.fan',
              description: project.description || undefined,
              defaultInstanceId: project.instanceId || undefined,
              compatMinVersion: undefined,
              compatMaxVersion: undefined,
              compatVersions: [],
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
            };
          }
        }
      }

      if (!pod) {
        res.status(404).json({ error: 'Pod not found', id: idParam });
        return;
      }

      if (!project) {
        res.json({
          podId: idParam,
          podName: pod.name,
          podPath: pod.path,
          hasAstCache: false,
          message: 'No AST cache found. Create a code project for this path to enable AST parsing.'
        });
        return;
      }

      // Try LadybugDB first (universal: all languages), fall back to FantomCodeIndexer
      {
        try {
          const lqm = getLadybugQueryManager();
          const [lbFunctions, lbTypes, lbRelationships] = await Promise.all([
            lqm.getNodesByProject(project.id),
            lqm.getTypesByProject(project.id),
            lqm.getTypeRelationships(project.id),
          ]);

          if (lbFunctions.length > 0 || lbTypes.length > 0) {
            // Build type relationship maps
            const extendsMap = new Map<string, string[]>();
            const implementsMap = new Map<string, string[]>();
            for (const rel of lbRelationships) {
              const map = rel.edgeType === 'extends' ? extendsMap : implementsMap;
              if (!map.has(rel.sourceId)) map.set(rel.sourceId, []);
              map.get(rel.sourceId)!.push(rel.targetName);
            }

            // Group functions by parentType (className)
            const functionsByClass: Record<string, Array<Record<string, unknown>>> = {};
            const mappedFunctions = lbFunctions.map(f => {
              const mapped = {
                id: f.id,
                name: f.name,
                qualifiedName: f.qualifiedName,
                type: f.nodeType,
                className: f.parentType,
                filePath: f.filePath,
                lineNumber: f.lineStart,
                signature: f.signature,
                returnType: f.returnType,
                parameters: parseParamsFromSignature(f.signature),
                description: f.documentation,
                category: f.nodeType,
                isPublic: f.isPublic,
                isStatic: f.isStatic,
                isAbstract: f.isAbstract,
                language: f.language,
              };
              if (f.parentType) {
                if (!functionsByClass[f.parentType]) functionsByClass[f.parentType] = [];
                functionsByClass[f.parentType].push(mapped);
              }
              return mapped;
            });

            // Count methods/fields per type
            const methodCounts = new Map<string, number>();
            const fieldCounts = new Map<string, number>();
            for (const f of lbFunctions) {
              if (!f.parentType) continue;
              if (f.nodeType === 'field') {
                fieldCounts.set(f.parentType, (fieldCounts.get(f.parentType) || 0) + 1);
              } else {
                methodCounts.set(f.parentType, (methodCounts.get(f.parentType) || 0) + 1);
              }
            }

            res.json({
              podId: idParam,
              podName: pod.name,
              podPath: pod.path,
              hasAstCache: true,
              projectId: project.id,
              projectName: project.name,
              lastIndexed: project.lastIndexed,
              source: 'ladybugdb',
              summary: {
                totalFunctions: lbFunctions.length,
                totalTypes: lbTypes.length,
                totalClasses: Object.keys(functionsByClass).length,
              },
              types: lbTypes.map(t => ({
                id: t.id,
                name: t.name,
                qualifiedName: t.qualifiedName,
                kind: t.nodeType,
                filePath: t.filePath,
                lineNumber: t.lineStart,
                extends: extendsMap.get(t.id)?.[0] || null,
                mixins: implementsMap.get(t.id) || [],
                isPublic: t.isPublic,
                isAbstract: t.isAbstract,
                documentation: t.documentation,
                language: t.language,
                methodCount: methodCounts.get(t.name) || 0,
                fieldCount: fieldCounts.get(t.name) || 0,
              })),
              functions: mappedFunctions,
              functionsByClass,
            });
            return;
          }
        } catch (ladybugErr) {
          console.warn('[Admin] LadybugDB AST query failed, falling back to indexer:', ladybugErr);
        }
      }

      // Fallback: FantomCodeIndexer (Fantom-only, regex-based)
      const indexer = getFantomCodeIndexer();
      const functions = indexer.getFunctionsByProject(project.id);
      const allTypes = indexer.getAllTypes();
      const types = allTypes.filter(t => t.projectId === project.id);

      // Group functions by class
      const functionsByClass: Record<string, typeof functions> = {};

      for (const func of functions) {
        if (func.className) {
          if (!functionsByClass[func.className]) {
            functionsByClass[func.className] = [];
          }
          functionsByClass[func.className].push(func);
        }
      }

      res.json({
        podId: idParam,
        podName: pod.name,
        podPath: pod.path,
        hasAstCache: true,
        projectId: project.id,
        projectName: project.name,
        lastIndexed: project.lastIndexed,
        source: 'fantom-indexer',
        summary: {
          totalFunctions: functions.length,
          totalTypes: types.length,
          totalClasses: Object.keys(functionsByClass).length
        },
        types: types.map(t => ({
          id: t.id,
          name: t.name,
          qualifiedName: t.qualifiedName,
          kind: t.kind,
          filePath: t.filePath,
          lineNumber: t.lineNumber,
          extends: t.extends,
          mixins: t.mixins,
          isPublic: t.isPublic,
          isAbstract: t.isAbstract,
          documentation: t.documentation,
          methodCount: t.methods?.length || 0,
          fieldCount: t.fields?.length || 0
        })),
        functions: functions.map(f => ({
          id: f.id,
          name: f.name,
          qualifiedName: f.qualifiedName,
          type: f.type,
          className: f.className,
          filePath: f.filePath,
          lineNumber: f.lineNumber,
          signature: f.signature,
          returnType: f.returnType,
          parameters: f.parameters,
          description: f.description,
          category: f.category,
          isPublic: f.isPublic,
          isStatic: f.isStatic,
          isAbstract: f.isAbstract
        })),
        functionsByClass
      });
    } catch (error) {
      console.error('[Admin] Failed to get pod AST data:', error);
      res.status(500).json({ error: 'Failed to get pod AST data', details: String(error) });
    }
  });

  // Get AST cache status for ALL pods and source-indexed projects
  router.get('/ast-cache', async (_req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Pod management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const pods = await db.getAllPods();
      const projects = await db.getAllProjects();
      const instances = await db.getAllInstances();
      const indexer = getFantomCodeIndexer();

      // Helper to create stable ID: {podName}-{minVersion}-{maxVersion}
      // Example: bassgCommon-3.1.0-3.1.12, hxEcobee-4.0.0-4.0.4
      const createStableId = (podName: string, minVersion?: string, maxVersion?: string): string => {
        const min = minVersion || '0.0.0';
        const max = maxVersion || minVersion || '0.0.0';
        return `${podName}-${min}-${max}`;
      };

      const podResults: Array<{
        podId: string;  // Changed to string for stable IDs
        podName: string;
        podPath: string;
        hasAstCache: boolean;
        projectId?: number;
        lastIndexed?: string;
        sourceType?: 'pod' | 'source' | 'fantom-build';
        instanceId?: number;
        instanceName?: string;
        instanceType?: string;
        instanceVersion?: string;
        compatMinVersion?: string;
        compatMaxVersion?: string;
        fantomBuildId?: number;
        fantomBuildVersion?: string;
        language?: string;
        parserType?: string;
        summary?: {
          totalFunctions: number;
          totalTypes: number;
          totalClasses: number;
        };
      }> = [];

      // Get Fantom builds for later lookup
      const fantomBuilds = await db.getAllFantomBuilds();

      // Track which projects are already linked to pods
      const linkedProjectPaths = new Set<string>();

      // First, add all registered pods
      for (const pod of pods) {
        // Find matching project by path
        const project = projects.find(p => normalizePath(p.path) === normalizePath(pod.path));
        const podInstance = pod.defaultInstanceId ? instances.find(i => i.id === pod.defaultInstanceId) : undefined;

        if (project) {
          linkedProjectPaths.add(project.path);
        }

        // Create stable ID: {podName}-{minVersion}-{maxVersion}
        // Use pod's compatibility versions if available, otherwise instance version
        const minVer = pod.compatMinVersion || podInstance?.version || '0.0.0';
        const maxVer = pod.compatMaxVersion || podInstance?.version || minVer;
        const stableId = createStableId(pod.name, minVer, maxVer);

        if (!project) {
          podResults.push({
            podId: stableId,
            podName: pod.name,
            podPath: pod.path,
            hasAstCache: false,
            sourceType: 'pod',
            instanceId: pod.defaultInstanceId || undefined,
            instanceName: podInstance?.name,
            instanceType: podInstance?.type,
            instanceVersion: podInstance?.version || undefined,
            compatMinVersion: pod.compatMinVersion || undefined,
            compatMaxVersion: pod.compatMaxVersion || undefined,
            language: 'fantom',
            parserType: 'regex'
          });
        } else {
          const functions = indexer.getFunctionsByProject(project.id);
          const allTypes = indexer.getAllTypes();
          const types = allTypes.filter(t => t.projectId === project.id);

          // Count unique classes from functions
          const classNames = new Set<string>();
          for (const func of functions) {
            if (func.className) {
              classNames.add(func.className);
            }
          }

          podResults.push({
            podId: stableId,
            podName: pod.name,
            podPath: pod.path,
            hasAstCache: true,
            projectId: project.id,
            lastIndexed: project.lastIndexed,
            sourceType: 'pod',
            instanceId: pod.defaultInstanceId || undefined,
            instanceName: podInstance?.name,
            instanceType: podInstance?.type,
            instanceVersion: podInstance?.version || undefined,
            compatMinVersion: pod.compatMinVersion || undefined,
            compatMaxVersion: pod.compatMaxVersion || undefined,
            language: (project as any).language || 'fantom',
            parserType: (project as any).parserType || 'regex',
            summary: {
              totalFunctions: functions.length,
              totalTypes: types.length,
              totalClasses: classNames.size
            }
          });
        }
      }

      // Then, add source-indexed projects that aren't linked to a pod.
      // Previously we required project.instanceId here, which silently hid
      // every project added via the MCP tool without an instance — making
      // those projects invisible on this page even though they were indexed.
      // Drop the filter; instance is now optional on the rendered card.
      for (const project of projects) {
        // Skip if this project is already linked to a pod
        if (linkedProjectPaths.has(project.path)) {
          continue;
        }

        const instance = project.instanceId
          ? instances.find(i => i.id === project.instanceId)
          : undefined;
        const functions = indexer.getFunctionsByProject(project.id);
        const allTypes = indexer.getAllTypes();
        const types = allTypes.filter(t => t.projectId === project.id);

        // Count unique classes from functions
        const classNames = new Set<string>();
        for (const func of functions) {
          if (func.className) {
            classNames.add(func.className);
          }
        }

        const hasFunctions = functions.length > 0 || types.length > 0;
        const podName = project.podName || project.name;

        // Create stable ID: {podName}-{minVersion}-{maxVersion}
        // For source-indexed projects, use instance version as both min and max
        const instanceVer = instance?.version || '0.0.0';
        const stableId = createStableId(podName, instanceVer, instanceVer);

        podResults.push({
          podId: stableId,
          podName,
          podPath: project.path,
          hasAstCache: hasFunctions,
          projectId: project.id,
          lastIndexed: project.lastIndexed,
          sourceType: 'source',
          instanceId: project.instanceId,
          instanceName: instance?.name,
          instanceType: instance?.type,
          instanceVersion: instance?.version || undefined,
          language: (project as any).language || 'fantom',
          parserType: (project as any).parserType || 'regex',
          summary: hasFunctions ? {
            totalFunctions: functions.length,
            totalTypes: types.length,
            totalClasses: classNames.size
          } : undefined
        });
      }

      // Finally, add Fantom Build projects (projects with buildId)
      for (const project of projects) {
        // Skip if this project is already linked to a pod
        if (linkedProjectPaths.has(project.path)) {
          continue;
        }

        // Only include projects that have a buildId (Fantom Build indexed)
        if (!project.buildId) {
          continue;
        }

        const fantomBuild = fantomBuilds.find(b => b.id === project.buildId);
        const functions = indexer.getFunctionsByProject(project.id);
        const allTypes = indexer.getAllTypes();
        const types = allTypes.filter(t => t.projectId === project.id);

        // Count unique classes from functions
        const classNames = new Set<string>();
        for (const func of functions) {
          if (func.className) {
            classNames.add(func.className);
          }
        }

        const hasFunctions = functions.length > 0 || types.length > 0;
        const podName = project.podName || project.name;

        // For Fantom Build projects, use the project name directly as podId
        // (format: fantom.{version}.{podName})
        const podId = project.name;

        linkedProjectPaths.add(project.path);

        podResults.push({
          podId,
          podName,
          podPath: project.path,
          hasAstCache: hasFunctions,
          projectId: project.id,
          lastIndexed: project.lastIndexed,
          sourceType: 'fantom-build',
          fantomBuildId: project.buildId,
          fantomBuildVersion: fantomBuild?.version,
          language: (project as any).language || 'fantom',
          parserType: (project as any).parserType || 'regex',
          summary: hasFunctions ? {
            totalFunctions: functions.length,
            totalTypes: types.length,
            totalClasses: classNames.size
          } : undefined
        });
      }

      res.json({
        count: podResults.length,
        pods: podResults
      });
    } catch (error) {
      console.error('[Admin] Failed to get AST cache data:', error);
      res.status(500).json({ error: 'Failed to get AST cache data', details: String(error) });
    }
  });

  // Create code project for pod (to enable AST caching)
  router.post('/fantom-pods/:id/ast', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Pod management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      // Decode URL-encoded characters (e.g., %2E -> .)
      const idParam = decodeURIComponent(req.params.id as string);

      // Parse stable ID format: {podName}-{minVersion}-{maxVersion}
      // Example: hxEcobee-4.0.4-4.0.4 or bassgCommon-3.1.0-3.1.12
      const parseStableId = (stableId: string): { podName: string; minVersion: string; maxVersion: string } | null => {
        const versionPattern = /^(.+)-(\d+\.\d+\.\d+)-(\d+\.\d+\.\d+)$/;
        const match = stableId.match(versionPattern);
        if (!match) return null;
        return { podName: match[1], minVersion: match[2], maxVersion: match[3] };
      };

      // Parse Fantom Build ID format: fantom.{version}.{podName}
      // Example: fantom.1.0.81.webmod, fantom.1.0.82.sys
      const parseFantomBuildId = (id: string): { version: string; podName: string } | null => {
        const fantomBuildPattern = /^fantom\.(\d+\.\d+\.\d+)\.(.+)$/;
        const match = id.match(fantomBuildPattern);
        if (!match) return null;
        return { version: match[1], podName: match[2] };
      };

      const instances = await db.getAllInstances();
      const projects = await db.getAllProjects();
      const pods = await db.getAllPods();

      let existingProject: Awaited<ReturnType<typeof db.getAllProjects>>[0] | undefined;
      let pod: Awaited<ReturnType<typeof db.getPodById>> | undefined;

      // First, try parsing as Fantom Build ID (fantom.{version}.{podName})
      const parsedFantomBuild = parseFantomBuildId(idParam);
      if (parsedFantomBuild) {
        // Find project directly by name (format: fantom.{version}.{podName})
        existingProject = projects.find(p => p.name === idParam);
        if (existingProject) {
          // Reindex the existing project
          if (context.reindexProject) {
            const indexResult = await context.reindexProject(existingProject.id);
            res.json({
              success: true,
              message: 'Fantom build project reindexed',
              projectId: existingProject.id,
              indexResult
            });
          } else {
            res.json({
              success: true,
              message: 'Fantom build project already exists',
              projectId: existingProject.id
            });
          }
          return;
        } else {
          // Project doesn't exist for this Fantom Build pod - it should have been created during indexing
          res.status(404).json({
            error: 'Fantom build project not found. Index the Fantom build first from the Fantom Builds page.',
            id: idParam
          });
          return;
        }
      }

      // Try parsing as stable ID if not Fantom Build ID
      const parsed = parseStableId(idParam);

      if (parsed) {
        const { podName, minVersion, maxVersion } = parsed;

        // First, try to find a pod with matching name and version range
        const matchedPod = pods.find(p => {
          if (p.name !== podName) return false;
          const podMin = p.compatMinVersion || '0.0.0';
          const podMax = p.compatMaxVersion || podMin;
          return podMin === minVersion && podMax === maxVersion;
        });

        if (matchedPod) {
          pod = matchedPod;
          const matchedPath = normalizePath(matchedPod.path);
          existingProject = projects.find(p => normalizePath(p.path) === matchedPath);
        }

        // If not found in pods, try projects by podName and instance version
        if (!pod && !existingProject) {
          const matchingProjects = projects.filter(p => (p.podName || p.name) === podName);

          for (const proj of matchingProjects) {
            if (proj.instanceId) {
              const inst = instances.find(i => i.id === proj.instanceId);
              // Normalize null/undefined version to '0.0.0' to match stable ID generation
              const instVer = inst?.version || '0.0.0';
              if (instVer === minVersion && instVer === maxVersion) {
                existingProject = proj;
                break;
              }
            }
          }

          if (!existingProject && matchingProjects.length > 0) {
            existingProject = matchingProjects[0];
          }
        }

        // Also check pods table by name if still not found
        if (!pod && !existingProject) {
          const podByName = pods.find(p => p.name === podName);
          if (podByName) {
            pod = podByName;
            const podByNamePath = normalizePath(podByName.path);
            existingProject = projects.find(p => normalizePath(p.path) === podByNamePath);
          }
        }

        // If project exists, reindex it
        if (existingProject) {
          if (context.reindexProject) {
            const indexResult = await context.reindexProject(existingProject.id);
            res.json({
              success: true,
              message: 'Project reindexed',
              projectId: existingProject.id,
              indexResult
            });
          } else {
            res.json({
              success: true,
              message: 'Project already exists',
              projectId: existingProject.id
            });
          }
          return;
        }

        // If no project but have pod, create new project
        if (pod) {
          // Continue to create project below
        } else {
          res.status(404).json({ error: 'Pod or project not found', id: idParam });
          return;
        }
      } else {
        // Fallback: try parsing as numeric ID (for backwards compatibility)
        const numericId = parseInt(idParam, 10);
        if (!isNaN(numericId)) {
          const isSourceProject = numericId < 0;
          const id = isSourceProject ? -numericId : numericId;

          if (isSourceProject) {
            existingProject = projects.find(p => p.id === id);
            if (existingProject && context.reindexProject) {
              const indexResult = await context.reindexProject(existingProject.id);
              res.json({
                success: true,
                message: 'Project reindexed',
                projectId: existingProject.id,
                indexResult
              });
              return;
            }
          } else {
            pod = await db.getPodById(id);
            if (pod) {
              const podPath = normalizePath(pod.path);
              existingProject = projects.find(p => normalizePath(p.path) === podPath);
            }
          }
        }
      }

      if (!pod) {
        res.status(404).json({ error: 'Pod not found', id: idParam });
        return;
      }

      // Check if project already exists (shouldn't reach here if it does, but double-check)
      if (existingProject) {
        res.json({
          success: true,
          message: 'Code project already exists',
          projectId: existingProject.id
        });
        return;
      }

      // Safety net: project.name has a unique constraint, so if a project
      // with this name already exists (path-based lookup missed it, e.g.
      // stored as ~/foo vs /Users/me/foo), reuse it instead of failing.
      const projectByName = projects.find(p => p.name === pod!.name);
      if (projectByName) {
        if (context.reindexProject) {
          const indexResult = await context.reindexProject(projectByName.id);
          res.json({
            success: true,
            message: 'Project reindexed',
            projectId: projectByName.id,
            indexResult
          });
        } else {
          res.json({
            success: true,
            message: 'Code project already exists',
            projectId: projectByName.id
          });
        }
        return;
      }

      // Detect project language
      const detected = detectProjectLanguage(pod.path);

      // Create new code project
      const project = await db.createProject({
        name: pod.name,
        path: pod.path,
        podName: pod.name,
        instanceId: pod.defaultInstanceId || undefined,
        description: pod.description || `AST cache for ${pod.name}`,
        autoIndex: true,
        language: detected.language,
        parserType: detected.parserType
      });

      // Reindex the project if context supports it
      if (context.reindexProject) {
        const indexResult = await context.reindexProject(project.id);
        res.json({
          success: true,
          message: 'Code project created and indexed',
          projectId: project.id,
          indexResult
        });
      } else {
        res.json({
          success: true,
          message: 'Code project created',
          projectId: project.id
        });
      }
    } catch (error) {
      console.error('[Admin] Failed to create AST cache for pod:', error);
      res.status(500).json({ error: 'Failed to create AST cache', details: String(error) });
    }
  });

  // Get language breakdown for a project/pod
  // Returns file counts and sample files per language detected in the project
  router.get('/fantom-pods/:id/languages', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!context.getFantomDatabase) {
        res.status(501).json({ error: 'Pod management not available' });
        return;
      }
      const db = await context.getFantomDatabase();
      const idParam = decodeURIComponent(req.params.id as string);

      // Parse stable ID format: {podName}-{minVersion}-{maxVersion}
      const parseStableId = (stableId: string): { podName: string; minVersion: string; maxVersion: string } | null => {
        const versionPattern = /^(.+)-(\d+\.\d+\.\d+)-(\d+\.\d+\.\d+)$/;
        const match = stableId.match(versionPattern);
        if (!match) return null;
        return { podName: match[1], minVersion: match[2], maxVersion: match[3] };
      };

      // Parse Fantom Build ID format: fantom.{version}.{podName}
      const parseFantomBuildId = (id: string): { version: string; podName: string } | null => {
        const fantomBuildPattern = /^fantom\.(\d+\.\d+\.\d+)\.(.+)$/;
        const match = id.match(fantomBuildPattern);
        if (!match) return null;
        return { version: match[1], podName: match[2] };
      };

      // File extension to language mapping
      const extensionToLanguage: Record<string, string> = {
        '.fan': 'fantom',
        // TrioParser emits axon functions for `func`+`src:` records in .trio
        // files. Treat .trio (and standalone .axon) as axon so functionCount
        // for axon reflects what's actually been indexed.
        '.trio': 'axon',
        '.axon': 'axon',
        '.ts': 'typescript',
        '.tsx': 'typescript',
        '.js': 'javascript',
        '.jsx': 'javascript',
        '.mjs': 'javascript',
        '.vue': 'vue',
        '.dart': 'dart',
        '.py': 'python',
        '.java': 'java',
        '.kt': 'kotlin',
        '.go': 'go',
        '.rs': 'rust',
        '.html': 'html',
        '.css': 'css',
        '.scss': 'css',
        '.json': 'json',
        '.xml': 'xml',
        '.rb': 'ruby',
        '.php': 'php',
        '.swift': 'swift',
        '.cs': 'csharp',
        '.cpp': 'cpp',
        '.c': 'c',
        '.h': 'c',
        '.hpp': 'cpp',
      };

      // Get language from file path
      const getLanguageFromPath = (filePath: string): string => {
        const ext = path.extname(filePath).toLowerCase();
        return extensionToLanguage[ext] || 'other';
      };

      const instances = await db.getAllInstances();
      const projects = await db.getAllProjects();
      const pods = await db.getAllPods();
      const indexer = getFantomCodeIndexer();

      let project: Awaited<ReturnType<typeof db.getAllProjects>>[0] | undefined;

      // Try parsing as Fantom Build ID
      const parsedFantomBuild = parseFantomBuildId(idParam);
      if (parsedFantomBuild) {
        project = projects.find(p => p.name === idParam);
      }

      // Try parsing as stable ID
      const parsed = !project ? parseStableId(idParam) : null;
      if (parsed) {
        const { podName, minVersion, maxVersion } = parsed;
        const matchedPod = pods.find(p => {
          if (p.name !== podName) return false;
          const podMin = p.compatMinVersion || '0.0.0';
          const podMax = p.compatMaxVersion || podMin;
          return podMin === minVersion && podMax === maxVersion;
        });

        if (matchedPod) {
          project = projects.find(p => normalizePath(p.path) === normalizePath(matchedPod.path));
        }

        // If not found in pods, try projects
        if (!project) {
          const matchingProjects = projects.filter(p => (p.podName || p.name) === podName);
          for (const proj of matchingProjects) {
            if (proj.instanceId) {
              const inst = instances.find(i => i.id === proj.instanceId);
              const instVer = inst?.version || '0.0.0';
              if (instVer === minVersion && instVer === maxVersion) {
                project = proj;
                break;
              }
            }
          }
          if (!project && matchingProjects.length > 0) {
            project = matchingProjects[0];
          }
        }
      }

      // Fallback: try parsing as numeric ID
      if (!project) {
        const numericId = parseInt(idParam, 10);
        if (!isNaN(numericId)) {
          const isSourceProject = numericId < 0;
          const id = isSourceProject ? -numericId : numericId;
          if (isSourceProject) {
            project = projects.find(p => p.id === id);
          } else {
            const foundPod = await db.getPodById(id);
            if (foundPod) {
              project = projects.find(p => normalizePath(p.path) === normalizePath(foundPod.path));
            }
            if (!project) {
              project = projects.find(p => p.id === id);
            }
          }
        }
      }

      if (!project) {
        res.status(404).json({ error: 'Project not found', id: idParam });
        return;
      }

      // Scan directory for files and get language breakdown
      const dirResult = detectLanguagesInDirectory(project.path);

      // Get functions and types for this project by ID first, then by path as fallback
      let functions = indexer.getFunctionsByProject(project.id);
      let types = indexer.getAllTypes().filter(t => t.projectId === project.id);

      // If no results by ID, try path matching as fallback
      if (functions.length === 0 && types.length === 0) {
        const allFuncs = indexer.getAllFunctions();
        const allTypes = indexer.getAllTypes();
        const projectPath = project.path.endsWith('/') ? project.path : project.path + '/';
        functions = allFuncs.filter(f => f.filePath.startsWith(projectPath) || f.filePath.startsWith(project.path));
        types = allTypes.filter(t => t.filePath.startsWith(projectPath) || t.filePath.startsWith(project.path));
      }

      // Count functions and types per language
      const funcCountByLang: Record<string, number> = {};
      const typeCountByLang: Record<string, number> = {};
      const sampleCodeByLang: Record<string, string> = {};

      for (const func of functions) {
        const lang = getLanguageFromPath(func.filePath);
        funcCountByLang[lang] = (funcCountByLang[lang] || 0) + 1;
        if (!sampleCodeByLang[lang] && func.signature) {
          sampleCodeByLang[lang] = func.signature;
        }
      }
      for (const type of types) {
        const lang = getLanguageFromPath(type.filePath);
        typeCountByLang[lang] = (typeCountByLang[lang] || 0) + 1;
      }

      // Merge file scan with function/type counts
      const languages = dirResult.languages.map(langInfo => ({
        language: langInfo.name,
        fileCount: langInfo.files,
        functionCount: funcCountByLang[langInfo.name] || 0,
        typeCount: typeCountByLang[langInfo.name] || 0,
        sampleFiles: [] as string[],
        sampleCode: sampleCodeByLang[langInfo.name],
      }));

      res.json({
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path,
        totalFiles: dirResult.totalFiles,
        totalFunctions: functions.length,
        totalTypes: types.length,
        primaryLanguage: (project as any).language || languages[0]?.language || 'fantom',
        parserType: (project as any).parserType || 'regex',
        languages,
      });
    } catch (error) {
      console.error('[Admin] Failed to get language breakdown:', error);
      res.status(500).json({ error: 'Failed to get language breakdown', details: String(error) });
    }
  });

  // ============================================
  // User Management Endpoints
  // ============================================

  /**
   * GET /admin/users/me - Get current authenticated user
   * Available to any authenticated user
   */
  router.get('/users/me', (req: Request, res: Response): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    res.json(req.user);
  });

  /**
   * GET /admin/users - List all users
   * Admin only
   */
  router.get('/users', requireAdmin, (_req: Request, res: Response): void => {
    const users = userStore.getAllUsers();
    res.json({ users });
  });

  /**
   * POST /admin/users - Create a new user
   * Admin only
   */
  router.post('/users', requireAdmin, (req: Request, res: Response): void => {
    const { username, password, role = 'user' } = req.body;

    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }

    if (role !== 'admin' && role !== 'user') {
      res.status(400).json({ error: 'Role must be "admin" or "user"' });
      return;
    }

    try {
      const user = userStore.createUser(username, password, role);
      res.status(201).json({ success: true, user });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create user';
      res.status(400).json({ error: message });
    }
  });

  /**
   * PUT /admin/users/:username/password - Change user password
   * Users can change their own password, admins can change any user's password
   */
  router.put('/users/:username/password', (req: Request, res: Response): void => {
    const usernameParam = req.params.username as string;
    const { password } = req.body;
    const currentUser = req.user;

    if (!currentUser) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Users can only change their own password (unless admin)
    if (currentUser.username !== usernameParam.toLowerCase() && currentUser.role !== 'admin') {
      res.status(403).json({ error: 'Cannot change other users\' passwords' });
      return;
    }

    if (!password) {
      res.status(400).json({ error: 'Password is required' });
      return;
    }

    try {
      const success = userStore.updatePassword(usernameParam, password);
      if (!success) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      res.json({ success: true, message: 'Password updated' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update password';
      res.status(400).json({ error: message });
    }
  });

  /**
   * PUT /admin/users/:username/role - Update user role
   * Admin only
   */
  router.put('/users/:username/role', requireAdmin, (req: Request, res: Response): void => {
    const usernameParam = req.params.username as string;
    const { role } = req.body;

    if (!role || (role !== 'admin' && role !== 'user')) {
      res.status(400).json({ error: 'Role must be "admin" or "user"' });
      return;
    }

    try {
      const success = userStore.updateRole(usernameParam, role);
      if (!success) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      res.json({ success: true, message: `Role updated to ${role}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update role';
      res.status(400).json({ error: message });
    }
  });

  /**
   * DELETE /admin/users/:username - Delete a user
   * Admin only
   */
  router.delete('/users/:username', requireAdmin, (req: Request, res: Response): void => {
    const usernameParam = req.params.username as string;
    const currentUser = req.user;

    // Prevent self-deletion
    if (currentUser && currentUser.username === usernameParam.toLowerCase()) {
      res.status(400).json({ error: 'Cannot delete your own account' });
      return;
    }

    try {
      const success = userStore.deleteUser(usernameParam);
      if (!success) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      res.json({ success: true, message: 'User deleted' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete user';
      res.status(400).json({ error: message });
    }
  });

  // ============================================
  // Backup/Restore Endpoints
  // ============================================

  /**
   * GET /admin/backups - List all backups
   */
  router.get('/backups', async (_req: Request, res: Response): Promise<void> => {
    if (!context.listBackups) {
      res.status(501).json({ error: 'Backup functionality not available' });
      return;
    }

    try {
      const backups = await context.listBackups();
      res.json({ count: backups.length, backups });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list backups';
      res.status(500).json({ error: message });
    }
  });

  /**
   * POST /admin/backups - Create a new backup
   * Admin only
   */
  router.post('/backups', requireAdmin, async (req: Request, res: Response): Promise<void> => {
    if (!context.createBackup) {
      res.status(501).json({ error: 'Backup functionality not available' });
      return;
    }

    try {
      const { includeSearchIndexes, includeDatabase, description } = req.body || {};
      const result = await context.createBackup({
        includeSearchIndexes: includeSearchIndexes ?? false,
        includeDatabase: includeDatabase ?? true,
        description,
        createdBy: req.user?.username || 'unknown',
      });
      res.json({ success: result.success, backup: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create backup';
      res.status(500).json({ error: message });
    }
  });

  /**
   * GET /admin/backups/:id - Get backup details
   */
  router.get('/backups/:id', async (req: Request, res: Response): Promise<void> => {
    if (!context.getBackup) {
      res.status(501).json({ error: 'Backup functionality not available' });
      return;
    }

    const backupId = req.params.id as string;

    try {
      const backup = await context.getBackup(backupId);
      if (!backup) {
        res.status(404).json({ error: 'Backup not found' });
        return;
      }
      res.json(backup);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get backup';
      res.status(500).json({ error: message });
    }
  });

  /**
   * GET /admin/backups/:id/download - Download backup ZIP file
   */
  router.get('/backups/:id/download', async (req: Request, res: Response): Promise<void> => {
    if (!context.getBackupPath || !context.getBackup) {
      res.status(501).json({ error: 'Backup functionality not available' });
      return;
    }

    const backupId = req.params.id as string;

    try {
      const backup = await context.getBackup(backupId);
      if (!backup) {
        res.status(404).json({ error: 'Backup not found' });
        return;
      }

      const backupPath = await context.getBackupPath(backupId);
      if (!backupPath || !fs.existsSync(backupPath)) {
        res.status(404).json({ error: 'Backup file not found' });
        return;
      }

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${backup.filename}"`);

      const stream = fs.createReadStream(backupPath);
      stream.pipe(res);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to download backup';
      res.status(500).json({ error: message });
    }
  });

  /**
   * POST /admin/backups/:id/restore - Restore from backup
   * Admin only, requires { confirm: true } in body
   */
  router.post('/backups/:id/restore', requireAdmin, async (req: Request, res: Response): Promise<void> => {
    if (!context.restoreBackup) {
      res.status(501).json({ error: 'Backup functionality not available' });
      return;
    }

    const backupId = req.params.id as string;

    try {
      const {
        confirm = false,
        restoreConfig = true,
        restoreDatabase = true,
        restoreSearchIndexes = true,
        createBackupBeforeRestore = true,
      } = req.body || {};

      if (!confirm) {
        res.status(400).json({
          error: 'Restore not confirmed',
          message: 'Set confirm: true in the request body to proceed with restore. This will overwrite existing data.',
        });
        return;
      }

      const result = await context.restoreBackup(backupId, {
        confirm,
        restoreConfig,
        restoreDatabase,
        restoreSearchIndexes,
        createBackupBeforeRestore,
      });

      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to restore backup';
      res.status(500).json({ error: message });
    }
  });

  /**
   * DELETE /admin/backups/:id - Delete a backup
   * Admin only
   */
  router.delete('/backups/:id', requireAdmin, async (req: Request, res: Response): Promise<void> => {
    if (!context.deleteBackup) {
      res.status(501).json({ error: 'Backup functionality not available' });
      return;
    }

    const backupId = req.params.id as string;

    try {
      const success = await context.deleteBackup(backupId);
      if (!success) {
        res.status(404).json({ error: 'Backup not found or could not be deleted' });
        return;
      }
      res.json({ success: true, message: 'Backup deleted' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete backup';
      res.status(500).json({ error: message });
    }
  });

  // ============================================
  // Graph Visualization endpoints
  // ============================================

  /**
   * GET /admin/graph/visualize
   * Get graph data for visualization
   * Query params:
   *   - nodeId: Focal node ID (required for most graph types)
   *   - qualifiedName: Alternative to nodeId - find node by qualified name
   *   - projectId: Project ID (required for project graph type)
   *   - graphType: 'subgraph' | 'callers' | 'callees' | 'impact' | 'project'
   *   - depth: Traversal depth (default: 3)
   *   - maxNodes: Max nodes to return (default: 100)
   */
  /**
   * GET /admin/graph/data - Get graph nodes + edges as JSON for 3D visualization
   * Query params:
   *   - projectId: required, project to fetch
   *   - includeEdgeTypes: comma-separated edge types to include (default: all)
   *   - includeCommunities: 'true' to run community detection (default: false)
   */
  router.get('/graph/data', async (req: Request, res: Response): Promise<void> => {
    try {
      const { projectId, includeEdgeTypes, includeCommunities, atTime } = req.query;
      if (!projectId) {
        res.status(400).json({ error: 'projectId is required' });
        return;
      }

      const pid = parseInt(projectId as string, 10);

      // Helper: derive language from file path.
      const langFromPath = (fp: string): string => {
        const ext = fp.includes('.') ? '.' + fp.split('.').pop()!.toLowerCase() : '';
        return EXTENSION_TO_LANGUAGE[ext] || 'fantom';
      };

      // Per-project DB read.
      const nodeRows = await ladybugQuery<{
        id: string; name: string; qn: string; nt: string;
        fp: string; line: number; pub: boolean; stat: boolean;
      }>(
        pid,
        `MATCH (n:CodeNode)
         RETURN n.id AS id, n.name AS name, n.qualified_name AS qn,
                n.node_type AS nt, n.file_path AS fp, n.line_start AS line,
                n.is_public AS pub, n.is_static AS stat`
      );
      let nodes = nodeRows.map(n => ({
        id: n.id, name: n.name, qn: n.qn, nt: n.nt,
        fp: n.fp, line: Number(n.line), pub: Boolean(n.pub), stat: Boolean(n.stat),
        lang: langFromPath(n.fp),
      }));

      // Time-travel reconstruction: replay ApiChange backward from current
      // state to reconstruct the symbol set at atTime.
      // Limitation: edges aren't versioned (no EdgeChange table yet) — edges
      // returned reflect the current build, intersected with the at-time node
      // set for visual sanity.
      const atTimeIso = typeof atTime === 'string' && atTime ? atTime : null;
      let atTimeWarnings: string[] = [];
      if (atTimeIso) {
        try {
          const t = new Date(atTimeIso);
          if (isNaN(t.getTime())) throw new Error(`Invalid atTime: ${atTimeIso}`);
          const { getPrismaClient } = await import('../db/prisma.js');
          const prisma = getPrismaClient();
          const changes: Array<{
            qualifiedName: string; changeType: string; beforeSig: string | null;
            afterSig: string | null; filePath: string; kind: string;
            lineStart: number | null; lineEnd: number | null;
          }> = await (prisma as any).apiChange.findMany({
            where: { projectId: pid, occurredAt: { gt: t } },
            orderBy: { occurredAt: 'desc' },
            select: {
              qualifiedName: true, changeType: true, beforeSig: true,
              afterSig: true, filePath: true, kind: true,
              lineStart: true, lineEnd: true,
            },
          });

          const map = new Map<string, typeof nodes[number]>();
          for (const n of nodes) map.set(n.qn, n);

          for (const c of changes) {
            if (c.changeType === 'added') {
              map.delete(c.qualifiedName);
            } else if (c.changeType === 'removed') {
              if (!map.has(c.qualifiedName)) {
                map.set(c.qualifiedName, {
                  id: `historical:${c.qualifiedName}`,
                  name: c.qualifiedName.split('.').pop() ?? c.qualifiedName,
                  qn: c.qualifiedName,
                  nt: c.kind ?? 'function',
                  fp: c.filePath,
                  line: c.lineStart != null ? Number(c.lineStart) : 0,
                  pub: true,
                  stat: false,
                  lang: langFromPath(c.filePath),
                });
              }
            }
            // 'modified' doesn't change membership; skip.
          }
          nodes = [...map.values()];
          atTimeWarnings.push(
            'Edge history isn’t tracked — edges shown reflect current graph.',
            'Historical node positions are approximate (line columns may be null for older changes).',
          );
        } catch (err) {
          atTimeWarnings.push(`atTime reconstruction failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const nodeIds = new Set(nodes.map(n => n.id));

      const edgeTypeFilter = includeEdgeTypes
        ? `AND e.edge_type IN [${(includeEdgeTypes as string)
            .split(',')
            .map(t => `'${t.trim().replace(/'/g, "\\'")}'`)
            .join(',')}]`
        : '';
      const edgeRows = await ladybugQuery<{
        src: string; dst: string; et: string; line: number;
        conf: number; metadata: string;
      }>(
        pid,
        `MATCH (a:CodeNode)-[e:CodeEdge]->(b:CodeNode)
         WHERE 1=1 ${edgeTypeFilter}
         RETURN a.id AS src, b.id AS dst, e.edge_type AS et,
                e.line_number AS line, e.confidence AS conf,
                e.metadata AS metadata`
      );
      const edges = edgeRows
        .filter(e => nodeIds.has(e.src) && nodeIds.has(e.dst))
        .map(e => {
          let conf = e.conf != null ? Number(e.conf) : 1.0;
          if (e.metadata) {
            try {
              const meta = JSON.parse(e.metadata);
              if (meta.isDynamic) conf = 0.7;
              else if (meta.isConstructor) conf = 0.95;
            } catch { /* ignore */ }
          }
          return {
            src: e.src, dst: e.dst, et: e.et,
            conf, line: e.line != null ? Number(e.line) : 0,
          };
        });

      // Optionally include communities.
      let communityMap: Record<string, number> = {};
      if (includeCommunities === 'true') {
        try {
          const { getOrDetectCommunities } = await import('../graph/communityDetection.js');
          const result = await getOrDetectCommunities(pid);
          for (const c of result.communities) {
            for (const n of c.nodes) {
              communityMap[n.id] = c.id;
            }
          }
        } catch {
          // Community detection requires LadybugDB, skip silently
        }
      }

      // Count in-degrees for node sizing
      const inDegrees: Record<string, number> = {};
      for (const e of edges) {
        inDegrees[e.dst] = (inDegrees[e.dst] || 0) + 1;
      }

      // Compute language groups for stats
      const langCounts: Record<string, number> = {};
      for (const n of nodes) {
        langCounts[n.lang] = (langCounts[n.lang] || 0) + 1;
      }
      const LANG_COLORS: Record<string, string> = {
        fantom: '#1E88E5', typescript: '#3178C6', javascript: '#F7DF1E',
        css: '#264DE4', dart: '#0175C2', vue: '#42B883', python: '#3776AB',
        java: '#ED8B00', go: '#00ADD8', rust: '#DEA584', kotlin: '#7F52FF',
        swift: '#FA7343', default: '#95A5A6',
      };
      const languageGroups = Object.entries(langCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([lang, count]) => ({ language: lang, count, color: LANG_COLORS[lang] || LANG_COLORS.default }));

      res.json({
        nodes: nodes.map(n => ({
          id: n.id,
          name: n.name,
          qualifiedName: n.qn,
          nodeType: n.nt,
          filePath: n.fp,
          lineStart: n.line,
          isPublic: n.pub,
          isStatic: n.stat,
          community: communityMap[n.id] ?? -1,
          callerCount: inDegrees[n.id] || 0,
          language: n.lang,
        })),
        edges: edges.map(e => ({
          source: e.src,
          target: e.dst,
          edgeType: e.et,
          confidence: e.conf,
          lineNumber: e.line,
        })),
        stats: {
          nodeCount: nodes.length,
          edgeCount: edges.length,
          communityCount: Object.keys(communityMap).length > 0
            ? new Set(Object.values(communityMap)).size
            : 0,
          languageGroups,
        },
        atTime: atTimeIso,
        warnings: atTimeWarnings,
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: errMsg });
    }
  });

  router.get('/graph/visualize', async (req: Request, res: Response): Promise<void> => {
    try {
      const { nodeId, qualifiedName, projectId, graphType = 'subgraph', depth = '3', maxNodes = '100' } = req.query;

      const parsedDepth = parseInt(depth as string, 10) || 3;
      const parsedMaxNodes = parseInt(maxNodes as string, 10) || 100;

      // Import graph visualization service
      const { getGraphVisualizationService } = await import('../graph/graphVisualization.js');
      const { getPrismaClient } = await import('../db/prisma.js');
      const prisma = getPrismaClient();
      const vizService = getGraphVisualizationService(prisma);

      let resolvedNodeId = nodeId as string | undefined;

      // If qualifiedName provided instead of nodeId, look up the node (Ladybug-authoritative).
      if (!resolvedNodeId && qualifiedName) {
        const qnEsc = (qualifiedName as string).replace(/'/g, "\\'");
        const rows = await ladybugQuery<{ id: string }>(
          `MATCH (n:CodeNode {qualified_name: '${qnEsc}'}) RETURN n.id AS id LIMIT 1`
        );
        if (rows.length > 0) {
          resolvedNodeId = rows[0].id;
        } else {
          res.status(404).json({ error: 'Node not found', qualifiedName });
          return;
        }
      }

      let graphData: string;

      switch (graphType) {
        case 'project':
          if (!projectId) {
            res.status(400).json({ error: 'projectId required for project graph' });
            return;
          }
          graphData = await vizService.exportProjectGraph(
            parseInt(projectId as string, 10),
            { format: 'cytoscape', maxNodes: parsedMaxNodes }
          );
          break;

        case 'callers':
          if (!resolvedNodeId) {
            res.status(400).json({ error: 'nodeId or qualifiedName required' });
            return;
          }
          graphData = await vizService.exportCallerGraph(
            resolvedNodeId,
            parsedDepth,
            { format: 'cytoscape', maxNodes: parsedMaxNodes }
          );
          break;

        case 'callees':
          if (!resolvedNodeId) {
            res.status(400).json({ error: 'nodeId or qualifiedName required' });
            return;
          }
          graphData = await vizService.exportCalleeGraph(
            resolvedNodeId,
            parsedDepth,
            { format: 'cytoscape', maxNodes: parsedMaxNodes }
          );
          break;

        case 'impact':
          if (!resolvedNodeId) {
            res.status(400).json({ error: 'nodeId or qualifiedName required' });
            return;
          }
          graphData = await vizService.exportImpactGraph(
            resolvedNodeId,
            parsedDepth,
            { format: 'cytoscape', maxNodes: parsedMaxNodes }
          );
          break;

        case 'subgraph':
        default:
          if (!resolvedNodeId) {
            res.status(400).json({ error: 'nodeId or qualifiedName required' });
            return;
          }
          graphData = await vizService.exportSubgraph(
            resolvedNodeId,
            parsedDepth,
            { format: 'cytoscape', maxNodes: parsedMaxNodes }
          );
          break;
      }

      // Parse the JSON string back to object
      const parsed = JSON.parse(graphData);
      res.json(parsed);
    } catch (error) {
      console.error('[Admin] Graph visualization error:', error);
      const message = error instanceof Error ? error.message : 'Failed to get graph data';
      res.status(500).json({ error: message });
    }
  });

  /**
   * GET /admin/graph/visualize-indexer
   * Graph visualization using in-memory FantomCodeIndexer data
   * This works with regex-parsed projects that aren't in the code_nodes database
   */
  router.get('/graph/visualize-indexer', async (req: Request, res: Response): Promise<void> => {
    try {
      const { nodeId, qualifiedName, projectId, graphType = 'subgraph', depth = '2', maxNodes = '100' } = req.query;

      // Parse depth for multi-level traversal (1-30 levels supported)
      const parsedDepth = Math.min(Math.max(parseInt(depth as string, 10) || 2, 1), 30);
      const parsedMaxNodes = Math.min(parseInt(maxNodes as string, 10) || 100, 10000);

      const indexer = getFantomCodeIndexer();

      // Node type colors for Cytoscape
      const NODE_TYPE_COLORS: Record<string, string> = {
        type: '#4B8BBE',
        class: '#4B8BBE',
        interface: '#9B59B6',
        mixin: '#9B59B6',
        enum: '#E67E22',
        method: '#306998',
        constructor: '#FFE873',
        field: '#9B59B6',
        function: '#2ECC71',
        'css-rule': '#264DE4',
        file: '#607D8B',           // File/module node
        'external-ref': '#78909C', // External reference
        default: '#95A5A6'
      };

      const EDGE_TYPE_COLORS: Record<string, string> = {
        calls: '#2C3E50',
        extends: '#E74C3C',
        implements: '#3498DB',
        contains: '#95A5A6',
        uses: '#F39C12',
        imports: '#00BCD4',         // Import edge
        'imports-type': '#4DD0E1',  // Type-only import
        'imports-symbol': '#26C6DA', // Symbol import
        exports: '#8BC34A',         // Export edge
        'exports-default': '#9CCC65', // Default export
        're-exports': '#CDDC39',    // Re-export
        'circular': '#F44336',      // Circular dependency (warning)
        'uses-css': '#E91E63',      // CSS class usage (pink)
        'uses-type': '#FF9800',     // Type usage (orange)
        'accesses': '#9C27B0',      // Field access (purple)
        'instantiates': '#673AB7',  // Constructor instantiation (deep purple)
        'renders': '#61DAFB',       // React component rendering (React blue)
        'handles': '#FFC107',        // Event handler (amber/yellow)
        'overrides': '#00C853'       // Method override (green accent)
      };

      // Language colors for multi-language grouping
      const LANGUAGE_COLORS: Record<string, string> = {
        fantom: '#1E88E5',     // Blue
        typescript: '#3178C6', // TypeScript blue
        javascript: '#F7DF1E', // JS yellow
        css: '#264DE4',        // CSS blue
        dart: '#0175C2',       // Dart blue
        vue: '#42B883',        // Vue green
        python: '#3776AB',     // Python blue
        java: '#ED8B00',       // Java orange
        go: '#00ADD8',         // Go cyan
        rust: '#DEA584',       // Rust orange
        kotlin: '#7F52FF',     // Kotlin purple
        swift: '#FA7343',      // Swift orange
        default: '#95A5A6'
      };

      interface GraphNode {
        id: string;
        label: string;
        qualifiedName: string;
        nodeType: string;
        filePath: string;
        lineStart: number;
        color: string;
        isFocal: boolean;
        language?: string;
      }

      interface GraphEdge {
        id: string;
        source: string;
        target: string;
        edgeType: string;
        color: string;
        isAsync?: boolean; // For async call visualization
      }

      // Language group metadata (for UI filtering, not compound nodes)
      interface LanguageGroupMeta {
        id: string;
        label: string;
        language: string;
        color: string;
      }

      const nodes: GraphNode[] = [];
      const edges: GraphEdge[] = [];
      const languageGroupsMeta: LanguageGroupMeta[] = [];
      const nodeIds = new Set<string>();
      const languageGroupIds = new Set<string>();
      let focalNodeId: string | undefined;
      let edgeCounter = 0;

      // Helper to track language groups for metadata (no compound nodes created)
      const trackLanguageGroup = (language: string) => {
        const groupId = `lang-${language}`;
        if (!languageGroupIds.has(groupId)) {
          languageGroupIds.add(groupId);
          languageGroupsMeta.push({
            id: groupId,
            label: language.charAt(0).toUpperCase() + language.slice(1),
            language,
            color: LANGUAGE_COLORS[language] || LANGUAGE_COLORS.default
          });
        }
      };

      // Helper to add a node if not already added (no parent assignment for compound grouping)
      // bypassQuota allows CSS/Vue nodes to be added even when at the main quota
      const addNode = (id: string, label: string, qualifiedName: string, nodeType: string, filePath: string, lineStart: number, isFocal = false, language = 'fantom', bypassQuota = false) => {
        if (!nodeIds.has(id) && (bypassQuota || nodes.length < parsedMaxNodes)) {
          nodeIds.add(id);
          trackLanguageGroup(language);
          nodes.push({
            id,
            label,
            qualifiedName,
            nodeType,
            filePath,
            lineStart,
            color: NODE_TYPE_COLORS[nodeType] || NODE_TYPE_COLORS.default,
            isFocal,
            language
          });
        }
      };

      // Helper to add an edge
      const addEdge = (source: string, target: string, edgeType: string, isAsync = false) => {
        if (nodeIds.has(source) && nodeIds.has(target)) {
          edges.push({
            id: `e${edgeCounter++}`,
            source,
            target,
            edgeType,
            color: EDGE_TYPE_COLORS[edgeType] || EDGE_TYPE_COLORS.calls,
            isAsync
          });
        }
      };

      // Find the focal node
      let focalFunc: ReturnType<typeof indexer.getAllFunctions>[0] | undefined;
      let focalType: ReturnType<typeof indexer.getAllTypes>[0] | undefined;
      let focalDbNode: { id: string; name: string; qualifiedName: string; nodeType: string; filePath: string; lineStart: number; language: string; projectId: number } | undefined;

      if (nodeId) {
        // Try to find by ID in functions
        const allFuncs = indexer.getAllFunctions();
        focalFunc = allFuncs.find(f => f.id === nodeId);
        if (!focalFunc) {
          // Try types
          const allTypes = indexer.getAllTypes();
          focalType = allTypes.find(t => t.id === nodeId);
        }

        // If still not found, search Ladybug (for tree-sitter parsed nodes).
        if (!focalFunc && !focalType) {
          try {
            const idEsc = (nodeId as string).replace(/'/g, "\\'");
            const rows = await ladybugQuery<{ id: string; name: string; qualifiedName: string; nodeType: string; filePath: string; lineStart: number; language: string; projectId: number }>(
              `MATCH (n:CodeNode {id: '${idEsc}'}) RETURN n.id AS id, n.name AS name, n.qualified_name AS qualifiedName, n.node_type AS nodeType, n.file_path AS filePath, n.line_start AS lineStart, n.language AS language, n.project_id AS projectId LIMIT 1`
            );
            if (rows.length > 0) {
              focalDbNode = rows[0];
            }
          } catch (dbError) {
            console.log('[Admin] Could not search CodeNode for focal node:', dbError);
          }
        }
      } else if (qualifiedName) {
        // Search by qualified name
        const qnStr = qualifiedName as string;
        const allFuncs = indexer.getAllFunctions();
        focalFunc = allFuncs.find(f => f.qualifiedName === qnStr);
        if (!focalFunc) {
          const allTypes = indexer.getAllTypes();
          focalType = allTypes.find(t => t.qualifiedName === qnStr);
        }

        // If still not found, search Ladybug.
        if (!focalFunc && !focalType) {
          try {
            const qnEsc = qnStr.replace(/'/g, "\\'");
            const rows = await ladybugQuery<{ id: string; name: string; qualifiedName: string; nodeType: string; filePath: string; lineStart: number; language: string; projectId: number }>(
              `MATCH (n:CodeNode {qualified_name: '${qnEsc}'}) RETURN n.id AS id, n.name AS name, n.qualified_name AS qualifiedName, n.node_type AS nodeType, n.file_path AS filePath, n.line_start AS lineStart, n.language AS language, n.project_id AS projectId LIMIT 1`
            );
            if (rows.length > 0) {
              focalDbNode = rows[0];
            }
          } catch (dbError) {
            console.log('[Admin] Could not search CodeNode for focal node:', dbError);
          }
        }
      }

      // === MODULE/FILE DEPENDENCY GRAPH (Task #35) ===
      if (graphType === 'modules' && projectId) {
        // Show file-level dependency graph
        let projId = parseInt(projectId as string, 10);
        let projectPath: string | undefined;

        // Resolve project path
        try {
          if (context.getFantomDatabase) {
            const db = await context.getFantomDatabase();
            const pods = await db.getAllPods();
            const codeProjects = await db.getAllProjects();

            const pod = pods.find(p => p.id === projId);
            if (pod) {
              projectPath = pod.path;
              const codeProject = codeProjects.find(cp => normalizePath(cp.path) === normalizePath(pod.path));
              if (codeProject) projId = codeProject.id;
            } else {
              const codeProject = codeProjects.find(cp => cp.id === projId);
              if (codeProject) projectPath = codeProject.path;
            }
          }
        } catch (mappingError) {
          console.error('[Admin] Error mapping project ID for modules view:', mappingError);
        }

        if (!projectPath) {
          console.warn(`[Admin] Module graph: could not resolve path for projectId=${projId}. Available pods: ${(await (await context.getFantomDatabase!()).getAllPods()).map(p => `${p.id}:${p.name}`).join(', ')}`);
        }

        if (projectPath) {
          // Scan for all source files
          const sourceFiles: string[] = [];
          const scanDir = (dir: string) => {
            if (!fs.existsSync(dir)) return;
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory() && !entry.name.includes('node_modules') && !entry.name.startsWith('.') && entry.name !== 'build' && entry.name !== 'dist') {
                scanDir(fullPath);
              } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (['.ts', '.tsx', '.js', '.jsx', '.fan', '.css', '.scss', '.vue'].includes(ext)) {
                  sourceFiles.push(fullPath);
                }
              }
            }
          };
          scanDir(projectPath);

          // Create file nodes
          const filePathToNodeId = new Map<string, string>();
          let fileCounter = 0;

          for (const filePath of sourceFiles.slice(0, parsedMaxNodes)) {
            const fileName = path.basename(filePath);
            const relPath = filePath.replace(projectPath, '').replace(/^\//, '');
            const ext = path.extname(filePath).toLowerCase();
            const language = ext === '.fan' ? 'fantom'
              : ['.ts', '.tsx'].includes(ext) ? 'typescript'
              : ['.js', '.jsx'].includes(ext) ? 'javascript'
              : ['.css', '.scss'].includes(ext) ? 'css'
              : ext === '.vue' ? 'vue'
              : 'unknown';

            const nodeId = `file-${fileCounter++}`;
            filePathToNodeId.set(filePath, nodeId);
            filePathToNodeId.set(relPath, nodeId);
            filePathToNodeId.set('./' + relPath, nodeId);

            addNode(nodeId, fileName, relPath, 'file', filePath, 1, false, language);
          }

          // Parse imports to create edges
          const importEdges: Array<{ source: string; target: string; isCircular?: boolean }> = [];
          const { getTreeSitterParser } = await import('../parser/treeSitter/treeSitterParser.js');
          const parser = await getTreeSitterParser();

          // Helper to resolve import paths
          const resolveImportPath = (importSource: string, currentFile: string): string | null => {
            if (!importSource.startsWith('.') && !importSource.startsWith('/')) return null;
            const currentDir = path.dirname(currentFile);
            let resolvedPath = importSource.startsWith('.')
              ? path.resolve(currentDir, importSource)
              : path.join(projectPath!, importSource);

            const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];
            for (const ext of extensions) {
              const fullPath = resolvedPath + ext;
              if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                return fullPath;
              }
            }
            return null;
          };

          // Extract imports from TypeScript/JavaScript files
          for (const filePath of sourceFiles.slice(0, parsedMaxNodes)) {
            const ext = path.extname(filePath).toLowerCase();
            if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) continue;

            try {
              const source = fs.readFileSync(filePath, 'utf-8');
              const result = await parser.parseSource(source, 'typescript' as any, {
                extractBodies: false,
                extractCalls: false,
                extractDocs: false,
              });

              for (const imp of result.imports || []) {
                const resolvedTarget = resolveImportPath(imp.source, filePath);
                if (resolvedTarget) {
                  const sourceId = filePathToNodeId.get(filePath);
                  const targetId = filePathToNodeId.get(resolvedTarget);
                  if (sourceId && targetId && sourceId !== targetId) {
                    importEdges.push({ source: sourceId, target: targetId });
                  }
                }
              }
            } catch (parseError) {
              // Skip files that fail to parse
            }
          }

          // Detect circular dependencies using DFS
          const adjacencyList = new Map<string, string[]>();
          for (const edge of importEdges) {
            if (!adjacencyList.has(edge.source)) adjacencyList.set(edge.source, []);
            adjacencyList.get(edge.source)!.push(edge.target);
          }

          const circularEdges = new Set<string>();
          const detectCycles = (start: string) => {
            const visited = new Set<string>();
            const recursionStack = new Set<string>();
            const pathStack: string[] = [];

            const dfs = (node: string): boolean => {
              visited.add(node);
              recursionStack.add(node);
              pathStack.push(node);

              for (const neighbor of adjacencyList.get(node) || []) {
                if (!visited.has(neighbor)) {
                  if (dfs(neighbor)) return true;
                } else if (recursionStack.has(neighbor)) {
                  // Found a cycle - mark all edges in the cycle
                  const cycleStart = pathStack.indexOf(neighbor);
                  for (let i = cycleStart; i < pathStack.length; i++) {
                    const from = pathStack[i];
                    const to = pathStack[(i + 1) % pathStack.length] || neighbor;
                    circularEdges.add(`${from}->${to}`);
                  }
                  return true;
                }
              }

              recursionStack.delete(node);
              pathStack.pop();
              return false;
            };

            dfs(start);
          };

          // Run cycle detection from each node
          for (const [nodeId] of filePathToNodeId) {
            if (typeof nodeId === 'string' && nodeId.startsWith('file-')) {
              detectCycles(nodeId);
            }
          }

          // Create edges, marking circular ones
          for (const edge of importEdges) {
            const isCircular = circularEdges.has(`${edge.source}->${edge.target}`);
            addEdge(edge.source, edge.target, isCircular ? 'circular' : 'imports');
          }

          console.log(`[Admin] Module graph: ${nodes.length} files, ${edges.length} imports, ${circularEdges.size} circular dependencies`);
        }
      } else if (graphType === 'project' && projectId) {
        // Show all types and their methods for a project - multi-language support
        let projId = parseInt(projectId as string, 10);

        // Map fantomProject.id to codeProject.id if needed
        // The indexer uses codeProject.id, but the frontend might pass fantomProject.id
        let projectPath: string | undefined;
        try {
          if (context.getFantomDatabase) {
            const db = await context.getFantomDatabase();
            const pods = await db.getAllPods();
            const codeProjects = await db.getAllProjects();

            // Check if this is a fantomProject.id (pod ID)
            const pod = pods.find(p => p.id === projId);
            if (pod) {
              projectPath = pod.path;
              // Find the corresponding codeProject by matching path
              const codeProject = codeProjects.find(cp => normalizePath(cp.path) === normalizePath(pod.path));
              if (codeProject) {
                projId = codeProject.id;
              }
            } else {
              // It might already be a codeProject.id
              const codeProject = codeProjects.find(cp => cp.id === projId);
              if (codeProject) {
                projectPath = codeProject.path;
              }
            }
          }
        } catch (mappingError) {
          console.error('[Admin] Error mapping project ID:', mappingError);
        }

        // 1. Get Fantom types from regex indexer
        let projectTypes = indexer.getAllTypes().filter(t => t.projectId === projId);

        // If no results by ID, try path matching as fallback
        if (projectTypes.length === 0 && projectPath) {
          const normalizedPath = projectPath.endsWith('/') ? projectPath : projectPath + '/';
          projectTypes = indexer.getAllTypes().filter(t =>
            t.filePath.startsWith(normalizedPath) || t.filePath.startsWith(projectPath)
          );
        }

        for (const type of projectTypes) {
          if (nodes.length >= parsedMaxNodes) break;

          addNode(type.id, type.name, type.qualifiedName, type.kind || 'type', type.filePath, type.lineNumber || 0, false, 'fantom');

          // Add extends relationship
          if (type.extends) {
            const parentType = indexer.getAllTypes().find(t => t.qualifiedName === type.extends || t.name === type.extends);
            if (parentType) {
              addNode(parentType.id, parentType.name, parentType.qualifiedName, parentType.kind || 'type', parentType.filePath, parentType.lineNumber || 0, false, 'fantom');
              addEdge(type.id, parentType.id, 'extends');
            }
          }

          // Add mixin relationships
          for (const mixin of type.mixins || []) {
            const mixinType = indexer.getAllTypes().find(t => t.qualifiedName === mixin || t.name === mixin);
            if (mixinType) {
              addNode(mixinType.id, mixinType.name, mixinType.qualifiedName, mixinType.kind || 'mixin', mixinType.filePath, mixinType.lineNumber || 0, false, 'fantom');
              addEdge(type.id, mixinType.id, 'implements');
            }
          }
        }

        // 2. Get nodes from other languages - first try database, then tree-sitter extraction
        let multiLangNodesAdded = 0;
        try {
          // Ladybug-authoritative read of non-Fantom code nodes for this project.
          const takeLimit = parsedMaxNodes - nodes.length;
          const multiLangNodes = await ladybugQuery<{ id: string; name: string; qualifiedName: string; nodeType: string; filePath: string; lineStart: number; language: string; parentType: string | null }>(
            projId,
            `MATCH (n:CodeNode) WHERE n.language <> 'fantom' RETURN n.id AS id, n.name AS name, n.qualified_name AS qualifiedName, n.node_type AS nodeType, n.file_path AS filePath, n.line_start AS lineStart, n.language AS language, n.parent_type AS parentType LIMIT ${takeLimit}`
          );

          // Add nodes from other languages
          for (const dbNode of multiLangNodes) {
            if (nodes.length >= parsedMaxNodes) break;
            addNode(
              dbNode.id,
              dbNode.name,
              dbNode.qualifiedName,
              dbNode.nodeType,
              dbNode.filePath,
              dbNode.lineStart,
              false,
              dbNode.language
            );
            multiLangNodesAdded++;
          }

          // Fetch edges for these nodes (Ladybug-authoritative).
          if (multiLangNodes.length > 0) {
            const nodeIdSet = new Set(multiLangNodes.map(n => n.id));
            const idList = Array.from(nodeIdSet).map(id => `'${id.replace(/'/g, "\\'")}'`).join(', ');
            const dbEdges = await ladybugQuery<{ id: string; sourceId: string; targetId: string; edgeType: string }>(
              projId,
              `MATCH (s:CodeNode)-[e:CodeEdge]->(t:CodeNode) WHERE s.id IN [${idList}] OR t.id IN [${idList}] RETURN ID(e) AS id, s.id AS sourceId, t.id AS targetId, e.edge_type AS edgeType`
            );

            for (const dbEdge of dbEdges) {
              // Only add edge if both nodes exist in our graph
              if (nodeIds.has(dbEdge.sourceId) && nodeIds.has(dbEdge.targetId)) {
                addEdge(dbEdge.sourceId, dbEdge.targetId, dbEdge.edgeType);
              }
            }
          }
        } catch (dbError) {
          // Database might not have multi-language data yet - will try tree-sitter below
          console.log('[Admin] Multi-language graph: no code_nodes data available');
        }

        // 3. Scan for source files first to determine what needs processing
        // Scan for TypeScript, JavaScript, CSS, and Vue files
        const tsFiles: string[] = [];
        const cssFiles: string[] = [];
        const vueFiles: string[] = [];
        if (projectPath) {
          const scanDir = (dir: string) => {
            if (!fs.existsSync(dir)) return;
            try {
              const entries = fs.readdirSync(dir, { withFileTypes: true });
              for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory() && !entry.name.includes('node_modules') && !entry.name.startsWith('.')) {
                  scanDir(fullPath);
                } else if (entry.isFile()) {
                  if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') || entry.name.endsWith('.js') || entry.name.endsWith('.jsx')) {
                    tsFiles.push(fullPath);
                  } else if (entry.name.endsWith('.css') || entry.name.endsWith('.scss') || entry.name.endsWith('.less')) {
                    cssFiles.push(fullPath);
                  } else if (entry.name.endsWith('.vue')) {
                    vueFiles.push(fullPath);
                  }
                }
              }
            } catch {
              // Skip directories that can't be read
            }
          };
          scanDir(projectPath);
        }

        // Determine if we need to parse - always parse if there are CSS/Vue files (they won't be in DB yet)
        const edgeToNodeRatio = multiLangNodesAdded > 0 ? edges.length / multiLangNodesAdded : 0;
        const needsTsParse = multiLangNodesAdded === 0 || (multiLangNodesAdded > 10 && edgeToNodeRatio < 0.1);
        const hasCssOrVue = cssFiles.length > 0 || vueFiles.length > 0;
        const needsReparse = needsTsParse || hasCssOrVue;

        console.log(`[Admin] File scan: ${tsFiles.length} TS, ${cssFiles.length} CSS, ${vueFiles.length} Vue files found`);
        console.log(`[Admin] Parse decision: needsTsParse=${needsTsParse}, hasCssOrVue=${hasCssOrVue}, needsReparse=${needsReparse}, nodes=${nodes.length}, maxNodes=${parsedMaxNodes}`);

        // Allow CSS/Vue processing even when node count is at limit (they add to the graph dynamically)
        const shouldProcessCssVue = hasCssOrVue && projectPath;
        const shouldProcessTs = needsTsParse && projectPath && nodes.length < parsedMaxNodes;

        if ((shouldProcessCssVue || shouldProcessTs) && projectPath) {
          try {
            const { getTreeSitterParser } = await import('../parser/treeSitter/treeSitterParser.js');
            const parser = await getTreeSitterParser();

            // Limit files to process
            const filesToProcess = tsFiles.slice(0, 50);
            let nodeCounter = 0;

            // Maps for creating edges after all nodes are collected
            const classNameToId = new Map<string, string>();
            const interfaceNameToId = new Map<string, string>();
            const methodNameToId = new Map<string, string>(); // Track methods by name for call edges
            const functionNameToId = new Map<string, string>(); // Track functions by name for call edges
            const pendingEdges: Array<{ sourceId: string; targetName: string; edgeType: string; sourceFile?: string; isAsync?: boolean }> = [];

            // === OVERRIDE/IMPLEMENT TRACKING (Task #38) ===
            // Track class extends relationships and their methods
            const classExtendsMap = new Map<string, string>(); // childClass -> parentClass
            const classMethodsMap = new Map<string, Map<string, string>>(); // className -> (methodName -> methodId)

            // === CSS LINKING (Task #31) ===
            // Track CSS selectors to node IDs for linking to TypeScript code
            const cssSelectorToNodeId = new Map<string, string>(); // .class-name or #id -> node ID
            // Track CSS class usages found in TypeScript files
            const pendingCssEdges: Array<{ sourceId: string; sourceFile: string; cssClass: string }> = [];

            // === CROSS-FILE CALL RESOLUTION ===
            // Pre-load existing symbols from Ladybug for cross-file resolution.
            const dbSymbolToId = new Map<string, string>(); // name/qualifiedName -> database node ID
            try {
              const existingDbNodes = await ladybugQuery<{ id: string; name: string; qualifiedName: string; nodeType: string }>(
                projId,
                `MATCH (n:CodeNode) RETURN n.id AS id, n.name AS name, n.qualified_name AS qualifiedName, n.node_type AS nodeType`
              );

              for (const dbNode of existingDbNodes) {
                // Map by simple name and qualified name for flexible matching
                dbSymbolToId.set(dbNode.name, dbNode.id);
                dbSymbolToId.set(dbNode.qualifiedName, dbNode.id);
                // Also map by ClassName.methodName pattern
                if (dbNode.qualifiedName.includes('.')) {
                  const parts = dbNode.qualifiedName.split('.');
                  if (parts.length >= 2) {
                    dbSymbolToId.set(`${parts[parts.length - 2]}.${parts[parts.length - 1]}`, dbNode.id);
                  }
                }
              }
              console.log(`[Admin] Pre-loaded ${existingDbNodes.length} symbols for cross-file resolution`);
            } catch (dbLoadError) {
              console.log('[Admin] Could not pre-load database symbols:', dbLoadError);
            }

            // Track imports per file for alias resolution: fileAlias -> originalName
            const importAliases = new Map<string, Map<string, string>>(); // filePath -> (alias -> originalName)

            // === IMPORT/EXPORT TRACKING (Task #29) ===
            // Track file paths to node IDs for module dependency edges
            const filePathToNodeId = new Map<string, string>();
            // Pending import edges to resolve after all files are processed
            const pendingImportEdges: Array<{
              sourceFileId: string;
              sourceFilePath: string;
              targetPath: string;
              importedName: string;
              alias?: string;
              isDefault: boolean;
              isNamespace: boolean;
              isTypeOnly: boolean;
            }> = [];
            // Track exported symbols by file
            const exportedSymbols = new Map<string, {
              name: string;
              alias?: string;
              isDefault: boolean;
              fileNodeId: string;
              filePath: string;
              reExportSource?: string;
            }>();

            // Helper function to resolve import paths to actual file paths
            const resolveImportPath = (importSource: string, currentFile: string, projectRoot: string): string | null => {
              // Skip external packages (node_modules)
              if (!importSource.startsWith('.') && !importSource.startsWith('/')) {
                return null; // External package, skip for now
              }

              const currentDir = path.dirname(currentFile);
              let resolvedPath: string;

              if (importSource.startsWith('.')) {
                // Relative import
                resolvedPath = path.resolve(currentDir, importSource);
              } else if (importSource.startsWith('/')) {
                // Absolute import from project root
                resolvedPath = path.join(projectRoot, importSource);
              } else {
                return null;
              }

              // Try common extensions
              const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];
              for (const ext of extensions) {
                const fullPath = resolvedPath + ext;
                if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                  return fullPath;
                }
              }

              return null;
            };

            // ===========================================
            // PROCESS CSS FILES FIRST (with separate quota)
            // ===========================================
            const cssFilesToProcess = cssFiles.slice(0, 30);
            let cssNodesAdded = 0;
            const maxCssNodes = 500; // CSS nodes have their own quota
            console.log(`[Admin] Processing ${cssFilesToProcess.length} CSS files FIRST, current nodes: ${nodes.length}/${parsedMaxNodes}`);
            for (const cssFilePath of cssFilesToProcess) {
              if (cssNodesAdded >= maxCssNodes) break;
              try {
                const cssSource = fs.readFileSync(cssFilePath, 'utf-8');

                // Extract CSS selectors and rules using improved regex
                // This regex handles complex selectors including SCSS nesting, combinators, etc.
                const selectorRegex = /^([^{}@]+?)\s*\{/gm;
                let cssMatch;
                const seenSelectors = new Set<string>();
                const cssFileName = path.basename(cssFilePath);

                // Also extract ALL class names from the file using a simpler approach
                const classNameRegex = /\.([a-zA-Z_][\w-]*)/g;
                let classMatch;
                const allClassesInFile = new Set<string>();
                while ((classMatch = classNameRegex.exec(cssSource)) !== null) {
                  allClassesInFile.add(classMatch[1]); // Store without the dot
                }

                while ((cssMatch = selectorRegex.exec(cssSource)) !== null && cssNodesAdded < maxCssNodes) {
                  let selectorGroup = cssMatch[1].trim();
                  // Skip comments, media queries, imports, empty selectors
                  if (!selectorGroup || selectorGroup.length <= 1) continue;
                  if (selectorGroup.startsWith('//') || selectorGroup.startsWith('/*')) continue;
                  if (selectorGroup.startsWith('@')) continue;
                  // Skip SCSS-only constructs
                  if (selectorGroup.startsWith('$') || selectorGroup.includes(':')) {
                    // Allow pseudo-classes but skip SCSS variables and mixin calls
                    if (selectorGroup.startsWith('$') || selectorGroup.startsWith('@include')) continue;
                  }

                  // Clean up SCSS parent reference
                  selectorGroup = selectorGroup.replace(/&/g, '');

                  // Split comma-separated selectors
                  const individualSelectors = selectorGroup.split(',').map(s => s.trim()).filter(s => s.length > 0);

                  // Only create one node for the group, but track all individual selectors for linking
                  if (!seenSelectors.has(selectorGroup) && individualSelectors.length > 0) {
                    seenSelectors.add(selectorGroup);
                    const cssNodeId = `css-${nodeCounter++}`;
                    const lineNumber = cssSource.substring(0, cssMatch.index).split('\n').length;

                    // Use first selector as the display label
                    const displaySelector = individualSelectors[0] || selectorGroup;
                    // Skip selectors that are just whitespace after cleaning
                    if (!displaySelector || displaySelector.length <= 1) continue;

                    addNode(
                      cssNodeId,
                      displaySelector,
                      `${cssFileName}::${displaySelector}`,
                      'css-rule',
                      cssFilePath,
                      lineNumber,
                      false,
                      'css',
                      true // bypassQuota - CSS nodes have their own quota
                    );
                    cssNodesAdded++;

                    // Track ALL individual selectors and class names for linking to TypeScript code
                    for (const selector of individualSelectors) {
                      cssSelectorToNodeId.set(selector, cssNodeId);
                      // Extract and track individual class names from complex selectors
                      const classesInSelector = selector.match(/\.([a-zA-Z_][\w-]*)/g) || [];
                      for (const cls of classesInSelector) {
                        const className = cls.slice(1); // Remove the dot
                        cssSelectorToNodeId.set(cls, cssNodeId); // .my-class
                        cssSelectorToNodeId.set(className, cssNodeId); // my-class
                      }
                      // Also track without the prefix for simple class matching
                      if (selector.startsWith('.')) {
                        cssSelectorToNodeId.set(selector.slice(1), cssNodeId);
                      } else if (selector.startsWith('#')) {
                        cssSelectorToNodeId.set(selector.slice(1), cssNodeId);
                      }
                    }
                  }
                }

                // ALSO: Track all class names found anywhere in the file (catches SCSS nesting)
                // Create a single node to represent all classes in this CSS file
                if (allClassesInFile.size > 0 && cssNodesAdded < maxCssNodes) {
                  const fileNodeId = `css-file-${cssFilePath.replace(/[^a-zA-Z0-9]/g, '-')}`;
                  if (!nodeIds.has(fileNodeId)) {
                    addNode(
                      fileNodeId,
                      cssFileName,
                      `${cssFileName}::all-classes`,
                      'css-file',
                      cssFilePath,
                      1,
                      false,
                      'css',
                      true
                    );
                    cssNodesAdded++;
                    // Map all class names in the file to this node as fallback
                    for (const className of allClassesInFile) {
                      if (!cssSelectorToNodeId.has(className)) {
                        cssSelectorToNodeId.set(className, fileNodeId);
                        cssSelectorToNodeId.set('.' + className, fileNodeId);
                      }
                    }
                  }
                }
              } catch (cssParseError) {
                // Skip files that fail to parse
              }
            }
            if (cssNodesAdded > 0) {
              // Sample some tracked class names for debugging
              const sampleClasses = Array.from(cssSelectorToNodeId.keys()).filter(k => !k.startsWith('.') && !k.includes('::') && k.length > 3).slice(0, 15);
              console.log(`[Admin] CSS processing: ${cssNodesAdded} nodes from ${cssFilesToProcess.length} files, ${cssSelectorToNodeId.size} selectors tracked`);
              console.log(`[Admin] CSS sample classes: ${sampleClasses.join(', ')}`);
            } else {
              console.log(`[Admin] CSS processing: 0 nodes added (check selectors in CSS files)`);
            }

            // ===========================================
            // PROCESS VUE FILES SECOND (with separate quota)
            // ===========================================
            const vueFilesToProcess = vueFiles.slice(0, 50); // Process up to 50 Vue files
            let vueNodesAdded = 0;
            const maxVueNodes = 500; // Vue nodes have their own quota
            console.log(`[Admin] Processing ${vueFilesToProcess.length} Vue files, current nodes: ${nodes.length}/${parsedMaxNodes}`);
            for (const vueFilePath of vueFilesToProcess) {
              if (vueNodesAdded >= maxVueNodes) break;
              try {
                const vueSource = fs.readFileSync(vueFilePath, 'utf-8');
                const vueFileName = path.basename(vueFilePath);
                const componentName = vueFileName.replace('.vue', '');

                // Add the Vue component as a node
                const vueNodeId = `vue-${nodeCounter++}`;
                addNode(
                  vueNodeId,
                  componentName,
                  `${vueFileName}::${componentName}`,
                  'class', // Vue components are like classes
                  vueFilePath,
                  1,
                  false,
                  'vue',
                  true // bypassQuota - Vue nodes have their own quota
                );
                vueNodesAdded++;

                // Extract template section and find component usage
                const templateMatch = vueSource.match(/<template[^>]*>([\s\S]*?)<\/template>/);
                if (templateMatch) {
                  // Find component tags (PascalCase or kebab-case)
                  const componentRegex = /<([A-Z][a-zA-Z0-9]*|[a-z]+-[a-z-]+)[^>]*>/g;
                  let compMatch;
                  const usedComponents = new Set<string>();
                  while ((compMatch = componentRegex.exec(templateMatch[1])) !== null) {
                    const usedComp = compMatch[1];
                    // Skip HTML elements
                    if (!['div', 'span', 'p', 'a', 'button', 'input', 'form', 'ul', 'li', 'img', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'tr', 'td', 'th', 'thead', 'tbody', 'section', 'header', 'footer', 'nav', 'main', 'aside', 'article'].includes(usedComp.toLowerCase())) {
                      usedComponents.add(usedComp);
                    }
                  }

                  // Create "renders" edges to used components
                  for (const usedComp of usedComponents) {
                    pendingEdges.push({
                      sourceId: vueNodeId,
                      targetName: usedComp,
                      edgeType: 'renders',
                      sourceFile: vueFilePath
                    });
                  }
                }

                // Extract script section for methods
                const scriptMatch = vueSource.match(/<script[^>]*>([\s\S]*?)<\/script>/);
                if (scriptMatch) {
                  const scriptContent = scriptMatch[1];

                  // Find methods in Options API
                  const methodsMatch = scriptContent.match(/methods\s*:\s*\{([\s\S]*?)\}/);
                  if (methodsMatch) {
                    const methodRegex = /(\w+)\s*\([^)]*\)\s*\{/g;
                    let methodMatch;
                    while ((methodMatch = methodRegex.exec(methodsMatch[1])) !== null) {
                      if (vueNodesAdded >= maxVueNodes) break;
                      const methodName = methodMatch[1];
                      const methodId = `vue-${nodeCounter++}`;
                      const lineNumber = vueSource.substring(0, vueSource.indexOf(methodMatch[0])).split('\n').length;
                      addNode(
                        methodId,
                        methodName,
                        `${componentName}.${methodName}`,
                        'method',
                        vueFilePath,
                        lineNumber,
                        false,
                        'vue',
                        true // bypassQuota
                      );
                      addEdge(vueNodeId, methodId, 'contains');
                      methodNameToId.set(methodName, methodId);
                      methodNameToId.set(`${componentName}.${methodName}`, methodId);
                      vueNodesAdded++;
                    }
                  }

                  // Find setup() or <script setup> functions
                  const functionRegex = /(?:function|const|let|var)\s+(\w+)\s*(?:=\s*(?:async\s*)?\([^)]*\)\s*=>|\([^)]*\)\s*\{)/g;
                  let funcMatch;
                  while ((funcMatch = functionRegex.exec(scriptContent)) !== null) {
                    if (vueNodesAdded >= maxVueNodes) break;
                    const funcName = funcMatch[1];
                    if (!['defineProps', 'defineEmits', 'defineExpose', 'computed', 'ref', 'reactive', 'watch', 'onMounted', 'onUnmounted'].includes(funcName)) {
                      const funcId = `vue-${nodeCounter++}`;
                      const lineNumber = vueSource.substring(0, vueSource.indexOf(funcMatch[0])).split('\n').length;
                      addNode(
                        funcId,
                        funcName,
                        `${componentName}.${funcName}`,
                        'function',
                        vueFilePath,
                        lineNumber,
                        false,
                        'vue',
                        true // bypassQuota
                      );
                      addEdge(vueNodeId, funcId, 'contains');
                      functionNameToId.set(funcName, funcId);
                      functionNameToId.set(`${componentName}.${funcName}`, funcId);
                      vueNodesAdded++;
                    }
                  }
                }
              } catch (vueParseError) {
                // Skip files that fail to parse
              }
            }
            if (vueNodesAdded > 0) {
              console.log(`[Admin] Vue processing: ${vueNodesAdded} nodes from ${vueFilesToProcess.length} files`);
            }

            // ===========================================
            // SCAN ALL SOURCE FILES FOR CSS CLASS USAGE (before quota check)
            // ===========================================
            // This scan happens regardless of quota to enable CSS edge linking
            // Scans both TypeScript AND Vue files for class references

            // Helper to extract CSS classes from a source string
            const extractCssClasses = (source: string, fileNodeId: string, filePath: string) => {
              let cssMatch;

              // React JSX: className="..." or className='...'
              const classNameAttrRegex = /className\s*=\s*["']([^"']+)["']/g;
              while ((cssMatch = classNameAttrRegex.exec(source)) !== null) {
                const classes = cssMatch[1].split(/\s+/).filter(c => c.trim());
                for (const c of classes) {
                  pendingCssEdges.push({ sourceId: fileNodeId, sourceFile: filePath, cssClass: c });
                }
              }

              // React JSX: className={`...`} (template literals)
              const classNameTemplateRegex = /className\s*=\s*\{`([^`]+)`\}/g;
              while ((cssMatch = classNameTemplateRegex.exec(source)) !== null) {
                const staticClasses = cssMatch[1].replace(/\$\{[^}]+\}/g, ' ').split(/\s+/).filter(c => c.trim());
                for (const c of staticClasses) {
                  pendingCssEdges.push({ sourceId: fileNodeId, sourceFile: filePath, cssClass: c });
                }
              }

              // HTML/Vue: class="..." (static class attribute, NOT :class or v-bind:class)
              const htmlClassRegex = /(?<![:\w])class\s*=\s*["']([^"'{]+)["']/g;
              while ((cssMatch = htmlClassRegex.exec(source)) !== null) {
                const classes = cssMatch[1].split(/\s+/).filter(c => c.trim() && /^[a-zA-Z_][\w-]*$/.test(c));
                for (const c of classes) {
                  pendingCssEdges.push({ sourceId: fileNodeId, sourceFile: filePath, cssClass: c });
                }
              }

              // Vue: :class="{ 'class-name': condition }" or :class="['class1', 'class2']"
              const vueBindClassRegex = /:class\s*=\s*["']([^"']+)["']/g;
              while ((cssMatch = vueBindClassRegex.exec(source)) !== null) {
                // Extract string literals from the binding expression
                const bindExpr = cssMatch[1];
                const stringLiterals = bindExpr.match(/'([a-zA-Z][\w-]*)'/g) || [];
                for (const lit of stringLiterals) {
                  const cls = lit.replace(/'/g, '');
                  if (cls.length > 1) {
                    pendingCssEdges.push({ sourceId: fileNodeId, sourceFile: filePath, cssClass: cls });
                  }
                }
              }

              // Vue: :class with object shorthand like :class="{active: isActive, 'text-danger': hasError}"
              // Extract class names from both quoted and unquoted keys
              const vueBindClassObjRegex = /:class\s*=\s*"\{([^}]+)\}"/g;
              while ((cssMatch = vueBindClassObjRegex.exec(source)) !== null) {
                const objContent = cssMatch[1];
                // Match unquoted keys like: active, disabled
                const unquotedKeys = objContent.match(/\b([a-zA-Z][\w-]*)\s*:/g) || [];
                for (const key of unquotedKeys) {
                  const cls = key.replace(':', '').trim();
                  if (cls.length > 1 && !cls.includes('Class') && !cls.includes('Style')) {
                    pendingCssEdges.push({ sourceId: fileNodeId, sourceFile: filePath, cssClass: cls });
                  }
                }
              }

              // DOM: classList.add("..."), classList.remove("..."), classList.toggle("...")
              const classListRegex = /classList\.(add|remove|toggle)\s*\(\s*["']([^"']+)["']\s*\)/g;
              while ((cssMatch = classListRegex.exec(source)) !== null) {
                const classes = cssMatch[2].split(/\s+/).filter(c => c.trim());
                for (const c of classes) {
                  pendingCssEdges.push({ sourceId: fileNodeId, sourceFile: filePath, cssClass: c });
                }
              }

              // CSS Modules: styles.className
              const cssModulesRegex = /styles\.(\w+)/g;
              while ((cssMatch = cssModulesRegex.exec(source)) !== null) {
                pendingCssEdges.push({ sourceId: fileNodeId, sourceFile: filePath, cssClass: cssMatch[1] });
              }
            };

            // Scan TypeScript files
            for (const filePath of filesToProcess) {
              try {
                const source = fs.readFileSync(filePath, 'utf-8');
                const tsFileNodeId = `ts-file-${filePath.replace(/[^a-zA-Z0-9]/g, '-')}`;
                if (!filePathToNodeId.has(filePath)) {
                  filePathToNodeId.set(filePath, tsFileNodeId);
                }
                extractCssClasses(source, tsFileNodeId, filePath);
              } catch {
                // Skip files that fail to read
              }
            }

            // Scan Vue files for CSS class usage
            for (const filePath of vueFiles) {
              try {
                const source = fs.readFileSync(filePath, 'utf-8');
                const vueFileNodeId = `vue-file-${filePath.replace(/[^a-zA-Z0-9]/g, '-')}`;
                if (!filePathToNodeId.has(filePath)) {
                  filePathToNodeId.set(filePath, vueFileNodeId);
                }
                extractCssClasses(source, vueFileNodeId, filePath);
              } catch {
                // Skip files that fail to read
              }
            }
            console.log(`[Admin] CSS class scan: ${pendingCssEdges.length} class usages found in ${filesToProcess.length} TS + ${vueFiles.length} Vue files`);

            // ===========================================
            // PROCESS TYPESCRIPT FILES (for AST nodes)
            // ===========================================
            console.log(`[Admin] Processing ${filesToProcess.length} TypeScript files, current nodes: ${nodes.length}/${parsedMaxNodes}`);
            for (const filePath of filesToProcess) {
              if (nodes.length >= parsedMaxNodes) break;
              try {
                const source = fs.readFileSync(filePath, 'utf-8');

                // === IMPORT TRACKING FOR CROSS-FILE RESOLUTION ===
                // Parse import statements to track aliases: import { foo as bar } from './module'
                const fileAliases = new Map<string, string>();
                const importRegex = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
                const defaultImportRegex = /import\s+(\w+)\s+from\s*['"]([^'"]+)['"]/g;
                let importMatch;

                // Named imports: import { foo, bar as baz } from './module'
                while ((importMatch = importRegex.exec(source)) !== null) {
                  const imports = importMatch[1].split(',');
                  for (const imp of imports) {
                    const trimmed = imp.trim();
                    if (trimmed.includes(' as ')) {
                      const [original, alias] = trimmed.split(/\s+as\s+/).map(s => s.trim());
                      fileAliases.set(alias, original); // alias -> original
                    }
                    // Also track non-aliased imports by name
                    const name = trimmed.includes(' as ') ? trimmed.split(/\s+as\s+/)[1].trim() : trimmed;
                    if (name) {
                      // Map imported name to itself if not aliased
                      if (!fileAliases.has(name)) {
                        fileAliases.set(name, name);
                      }
                    }
                  }
                }

                // Default imports: import Foo from './module'
                while ((importMatch = defaultImportRegex.exec(source)) !== null) {
                  const importName = importMatch[1];
                  if (importName && !fileAliases.has(importName)) {
                    fileAliases.set(importName, importName);
                  }
                }

                importAliases.set(filePath, fileAliases);

                const result = await parser.parseSource(source, 'typescript' as any, {
                  extractBodies: false,
                  extractCalls: true,  // Enable call extraction for edge relationships
                  extractDocs: false,
                });

                // Add classes and track inheritance
                for (const cls of result.classes) {
                  if (nodes.length >= parsedMaxNodes) break;
                  const nodeId = `ts-${nodeCounter++}`;
                  classNameToId.set(cls.name, nodeId);
                  addNode(
                    nodeId,
                    cls.name,
                    cls.qualifiedName,
                    'class',
                    filePath,
                    cls.location.startLine,
                    false,
                    'typescript'
                  );

                  // Track extends relationships
                  if (cls.extends) {
                    pendingEdges.push({ sourceId: nodeId, targetName: cls.extends, edgeType: 'extends', sourceFile: filePath });
                    // Track for override detection
                    classExtendsMap.set(cls.name, cls.extends);
                  }

                  // Track implements relationships
                  for (const impl of cls.implements || []) {
                    pendingEdges.push({ sourceId: nodeId, targetName: impl, edgeType: 'implements', sourceFile: filePath });
                  }

                  // Initialize class methods map for override tracking
                  const classMethodMap = new Map<string, string>();
                  classMethodsMap.set(cls.name, classMethodMap);

                  // === FIELD TRACKING (Task #32) ===
                  // Track class fields for field access edges
                  const classFieldNameToId = new Map<string, string>();
                  for (const field of cls.fields || []) {
                    if (nodes.length >= parsedMaxNodes) break;
                    const fieldId = `ts-${nodeCounter++}`;
                    const fieldQualifiedName = `${cls.name}.${field.name}`;
                    classFieldNameToId.set(field.name, fieldId);
                    addNode(
                      fieldId,
                      field.name,
                      fieldQualifiedName,
                      'field',
                      filePath,
                      field.location?.startLine || cls.location.startLine,
                      false,
                      'typescript'
                    );
                    addEdge(nodeId, fieldId, 'contains');
                  }

                  // Add methods as separate nodes with 'contains' edges
                  for (const method of cls.methods || []) {
                    if (nodes.length >= parsedMaxNodes) break;
                    const methodId = `ts-${nodeCounter++}`;
                    const methodQualifiedName = `${cls.name}.${method.name}`;
                    methodNameToId.set(method.name, methodId);
                    methodNameToId.set(methodQualifiedName, methodId);
                    // Track for override detection
                    classMethodMap.set(method.name, methodId);

                    addNode(
                      methodId,
                      method.name,
                      methodQualifiedName,
                      'method',
                      filePath,
                      method.location.startLine,
                      false,
                      'typescript'
                    );
                    addEdge(nodeId, methodId, 'contains');

                    // Track method calls for edge creation
                    for (const call of method.calls || []) {
                      // Create call edges - target can be method.name or target.methodName
                      const callTarget = call.target ? `${call.target}.${call.name}` : call.name;
                      const isAsync = call.isAsync || false;
                      pendingEdges.push({ sourceId: methodId, targetName: call.name, edgeType: 'calls', sourceFile: filePath, isAsync });
                      if (callTarget !== call.name) {
                        pendingEdges.push({ sourceId: methodId, targetName: callTarget, edgeType: 'calls', sourceFile: filePath, isAsync });
                      }
                    }

                    // === TYPE USAGE EDGES (Task #30) ===
                    // Track parameter types
                    for (const param of method.parameters || []) {
                      if (param.type) {
                        // Extract base type (handle generics like Promise<User>)
                        const baseType = param.type.replace(/<.*>/, '').replace(/\[\]$/, '').trim();
                        if (baseType && !['string', 'number', 'boolean', 'void', 'any', 'unknown', 'null', 'undefined'].includes(baseType.toLowerCase())) {
                          pendingEdges.push({ sourceId: methodId, targetName: baseType, edgeType: 'uses-type', sourceFile: filePath });
                        }
                        // Extract generic type parameters
                        const genericMatch = param.type.match(/<([^>]+)>/);
                        if (genericMatch) {
                          const genericTypes = genericMatch[1].split(',').map(t => t.trim().replace(/<.*>/, ''));
                          for (const gt of genericTypes) {
                            if (gt && !['string', 'number', 'boolean', 'void', 'any', 'unknown'].includes(gt.toLowerCase())) {
                              pendingEdges.push({ sourceId: methodId, targetName: gt, edgeType: 'uses-type', sourceFile: filePath });
                            }
                          }
                        }
                      }
                    }
                    // Track return type
                    if (method.returnType) {
                      const baseReturnType = method.returnType.replace(/<.*>/, '').replace(/\[\]$/, '').trim();
                      if (baseReturnType && !['string', 'number', 'boolean', 'void', 'any', 'unknown', 'null', 'undefined', 'Promise'].includes(baseReturnType)) {
                        pendingEdges.push({ sourceId: methodId, targetName: baseReturnType, edgeType: 'uses-type', sourceFile: filePath });
                      }
                      const genericMatch = method.returnType.match(/<([^>]+)>/);
                      if (genericMatch) {
                        const genericTypes = genericMatch[1].split(',').map(t => t.trim().replace(/<.*>/, ''));
                        for (const gt of genericTypes) {
                          if (gt && !['string', 'number', 'boolean', 'void', 'any', 'unknown'].includes(gt.toLowerCase())) {
                            pendingEdges.push({ sourceId: methodId, targetName: gt, edgeType: 'uses-type', sourceFile: filePath });
                          }
                        }
                      }
                    }

                    // === FIELD ACCESS EDGES (Task #32) ===
                    // Scan for this.fieldName patterns in method body area
                    // Since we don't have method bodies, use regex on source around method line
                    const methodStartLine = method.location.startLine;
                    const methodEndLine = method.location.endLine || methodStartLine + 20;
                    const sourceLines = source.split('\n');
                    const methodSource = sourceLines.slice(methodStartLine - 1, methodEndLine).join('\n');

                    // Find this.fieldName accesses
                    const fieldAccessRegex = /this\.(\w+)/g;
                    let fieldMatch;
                    const accessedFields = new Set<string>();

                    while ((fieldMatch = fieldAccessRegex.exec(methodSource)) !== null) {
                      const fieldName = fieldMatch[1];
                      // Only create edge if it's a known field of this class
                      const fieldId = classFieldNameToId.get(fieldName);
                      if (fieldId && !accessedFields.has(fieldName)) {
                        accessedFields.add(fieldName);
                        addEdge(methodId, fieldId, 'accesses');
                      }
                    }
                  }
                }

                // Add interfaces
                for (const iface of result.interfaces) {
                  if (nodes.length >= parsedMaxNodes) break;
                  const nodeId = `ts-${nodeCounter++}`;
                  interfaceNameToId.set(iface.name, nodeId);
                  addNode(
                    nodeId,
                    iface.name,
                    iface.qualifiedName,
                    'interface',
                    filePath,
                    iface.location.startLine,
                    false,
                    'typescript'
                  );

                  // Track extends relationships for interfaces
                  for (const ext of iface.extends || []) {
                    pendingEdges.push({ sourceId: nodeId, targetName: ext, edgeType: 'extends', sourceFile: filePath });
                  }
                }

                // Add top-level functions
                for (const func of result.functions) {
                  if (nodes.length >= parsedMaxNodes) break;
                  const nodeId = `ts-${nodeCounter++}`;
                  functionNameToId.set(func.name, nodeId);
                  addNode(
                    nodeId,
                    func.name,
                    func.qualifiedName,
                    'function',
                    filePath,
                    func.location.startLine,
                    false,
                    'typescript'
                  );

                  // Track function calls for edge creation
                  for (const call of func.calls || []) {
                    const callTarget = call.target ? `${call.target}.${call.name}` : call.name;
                    const isAsync = call.isAsync || false;
                    pendingEdges.push({ sourceId: nodeId, targetName: call.name, edgeType: 'calls', sourceFile: filePath, isAsync });
                    if (callTarget !== call.name) {
                      pendingEdges.push({ sourceId: nodeId, targetName: callTarget, edgeType: 'calls', sourceFile: filePath, isAsync });
                    }
                  }

                  // === TYPE USAGE EDGES FOR FUNCTIONS (Task #30) ===
                  for (const param of func.parameters || []) {
                    if (param.type) {
                      const baseType = param.type.replace(/<.*>/, '').replace(/\[\]$/, '').trim();
                      if (baseType && !['string', 'number', 'boolean', 'void', 'any', 'unknown', 'null', 'undefined'].includes(baseType.toLowerCase())) {
                        pendingEdges.push({ sourceId: nodeId, targetName: baseType, edgeType: 'uses-type', sourceFile: filePath });
                      }
                      const genericMatch = param.type.match(/<([^>]+)>/);
                      if (genericMatch) {
                        const genericTypes = genericMatch[1].split(',').map(t => t.trim().replace(/<.*>/, ''));
                        for (const gt of genericTypes) {
                          if (gt && !['string', 'number', 'boolean', 'void', 'any', 'unknown'].includes(gt.toLowerCase())) {
                            pendingEdges.push({ sourceId: nodeId, targetName: gt, edgeType: 'uses-type', sourceFile: filePath });
                          }
                        }
                      }
                    }
                  }
                  if (func.returnType) {
                    const baseReturnType = func.returnType.replace(/<.*>/, '').replace(/\[\]$/, '').trim();
                    if (baseReturnType && !['string', 'number', 'boolean', 'void', 'any', 'unknown', 'null', 'undefined', 'Promise'].includes(baseReturnType)) {
                      pendingEdges.push({ sourceId: nodeId, targetName: baseReturnType, edgeType: 'uses-type', sourceFile: filePath });
                    }
                    const genericMatch = func.returnType.match(/<([^>]+)>/);
                    if (genericMatch) {
                      const genericTypes = genericMatch[1].split(',').map(t => t.trim().replace(/<.*>/, ''));
                      for (const gt of genericTypes) {
                        if (gt && !['string', 'number', 'boolean', 'void', 'any', 'unknown'].includes(gt.toLowerCase())) {
                          pendingEdges.push({ sourceId: nodeId, targetName: gt, edgeType: 'uses-type', sourceFile: filePath });
                        }
                      }
                    }
                  }
                }

                // === IMPORT/EXPORT TRACKING (Task #29) ===
                // Create file node for module-level dependencies
                const fileNodeId = `ts-file-${nodeCounter++}`;
                const fileName = path.basename(filePath);
                const fileQualifiedName = filePath.replace(projectPath, '').replace(/^\//, '');
                addNode(
                  fileNodeId,
                  fileName,
                  fileQualifiedName,
                  'file',
                  filePath,
                  1,
                  false,
                  'typescript'
                );

                // Track file path to node ID for import resolution
                filePathToNodeId.set(filePath, fileNodeId);
                // Also map by relative path patterns
                filePathToNodeId.set(fileQualifiedName, fileNodeId);
                filePathToNodeId.set('./' + fileQualifiedName, fileNodeId);

                // Process imports - create "imports" edges
                for (const imp of result.imports || []) {
                  // Track import for cross-file resolution
                  for (const item of imp.items) {
                    // Resolve the import source to a file path
                    const resolvedPath = resolveImportPath(imp.source, filePath, projectPath);
                    if (resolvedPath) {
                      pendingImportEdges.push({
                        sourceFileId: fileNodeId,
                        sourceFilePath: filePath,
                        targetPath: resolvedPath,
                        importedName: item.name,
                        alias: item.alias,
                        isDefault: item.isDefault,
                        isNamespace: item.isNamespace,
                        isTypeOnly: imp.isTypeOnly
                      });
                    }
                  }
                }

                // Process exports - create "exports" edges from symbol to file
                for (const exp of result.exports || []) {
                  const exportedName = exp.alias || exp.name;
                  // Track exports for this file
                  exportedSymbols.set(`${filePath}:${exportedName}`, {
                    name: exp.name,
                    alias: exp.alias,
                    isDefault: exp.isDefault,
                    fileNodeId,
                    filePath,
                    reExportSource: exp.source
                  });
                }

                // CSS CLASS SCANNING moved to separate pass above (before quota check)

                // === CONSTRUCTOR INSTANTIATION EDGES (Task #33) ===
                // Scan for new ClassName() patterns
                const newExpressionRegex = /new\s+([A-Z]\w*)\s*[(<]/g;
                let newMatch;
                const instantiatedClasses = new Set<string>();

                while ((newMatch = newExpressionRegex.exec(source)) !== null) {
                  const className = newMatch[1];
                  // Skip common built-in classes
                  if (!['Date', 'Array', 'Object', 'Map', 'Set', 'Error', 'Promise', 'RegExp', 'Function', 'Boolean', 'Number', 'String'].includes(className)) {
                    instantiatedClasses.add(className);
                  }
                }

                // Create pending instantiation edges from file to class
                for (const className of instantiatedClasses) {
                  pendingEdges.push({
                    sourceId: fileNodeId,
                    targetName: className,
                    edgeType: 'instantiates',
                    sourceFile: filePath
                  });
                }

                // === REACT/VUE COMPONENT HIERARCHY EDGES (Task #36) ===
                // Scan for JSX component usage: <ComponentName or <ComponentName>
                const jsxComponentRegex = /<([A-Z]\w+)[\s/>]/g;
                let jsxMatch;
                const renderedComponents = new Set<string>();

                while ((jsxMatch = jsxComponentRegex.exec(source)) !== null) {
                  const componentName = jsxMatch[1];
                  // Skip HTML elements and React built-ins
                  if (!['Fragment', 'Suspense', 'StrictMode', 'Profiler'].includes(componentName)) {
                    renderedComponents.add(componentName);
                  }
                }

                // Create pending renders edges from file to component
                for (const componentName of renderedComponents) {
                  pendingEdges.push({
                    sourceId: fileNodeId,
                    targetName: componentName,
                    edgeType: 'renders',
                    sourceFile: filePath
                  });
                }

                // === EVENT LISTENER/HANDLER EDGES (Task #37) ===
                // Scan for event handler bindings: onClick={handler}, onChange={this.handler}, etc.
                const eventHandlerRegex = /on[A-Z]\w+\s*=\s*\{(?:this\.)?(\w+)\}/g;
                // Also detect addEventListener patterns
                const addEventListenerRegex = /addEventListener\s*\(\s*['"](\w+)['"]\s*,\s*(?:this\.)?(\w+)\)/g;
                let eventMatch;
                const eventHandlers = new Set<string>();

                while ((eventMatch = eventHandlerRegex.exec(source)) !== null) {
                  const handlerName = eventMatch[1];
                  if (handlerName && !['undefined', 'null', 'true', 'false'].includes(handlerName)) {
                    eventHandlers.add(handlerName);
                  }
                }

                while ((eventMatch = addEventListenerRegex.exec(source)) !== null) {
                  const handlerName = eventMatch[2];
                  if (handlerName && !['undefined', 'null', 'true', 'false'].includes(handlerName)) {
                    eventHandlers.add(handlerName);
                  }
                }

                // Create pending event handler edges from file to handler
                for (const handlerName of eventHandlers) {
                  pendingEdges.push({
                    sourceId: fileNodeId,
                    targetName: handlerName,
                    edgeType: 'handles',
                    sourceFile: filePath
                  });
                }
              } catch (parseError) {
                // Skip files that fail to parse
              }
            }

            // === RESOLVE CSS EDGES (Task #31) ===
            // (CSS node creation moved earlier, before TypeScript processing)
            let cssEdgesCreated = 0;
            let cssSourceCreated = 0;
            let cssSelectorMissing = 0;

            // Group CSS edges by source file to avoid creating duplicate file nodes
            const cssEdgesBySource = new Map<string, { sourceId: string; sourceFile: string; cssClasses: string[] }>();
            for (const pending of pendingCssEdges) {
              const existing = cssEdgesBySource.get(pending.sourceFile);
              if (existing) {
                existing.cssClasses.push(pending.cssClass);
              } else {
                cssEdgesBySource.set(pending.sourceFile, {
                  sourceId: pending.sourceId,
                  sourceFile: pending.sourceFile,
                  cssClasses: [pending.cssClass]
                });
              }
            }

            for (const [sourceFile, { sourceId, cssClasses }] of cssEdgesBySource) {
              // Create file node for CSS linking if it doesn't exist
              if (!nodeIds.has(sourceId)) {
                const fileName = path.basename(sourceFile);
                const fileQualifiedName = projectPath ? sourceFile.replace(projectPath, '').replace(/^\//, '') : fileName;
                addNode(
                  sourceId,
                  fileName,
                  fileQualifiedName,
                  'file',
                  sourceFile,
                  1,
                  false,
                  'typescript',
                  true // bypassQuota - CSS linking nodes
                );
                cssSourceCreated++;
              }

              // Create edges for each CSS class
              for (const cssClass of cssClasses) {
                const cssNodeId = cssSelectorToNodeId.get(cssClass)
                  || cssSelectorToNodeId.get('.' + cssClass)
                  || cssSelectorToNodeId.get('#' + cssClass);

                if (!cssNodeId || !nodeIds.has(cssNodeId)) {
                  cssSelectorMissing++;
                  continue;
                }
                addEdge(sourceId, cssNodeId, 'uses-css');
                cssEdgesCreated++;
              }
            }
            // Log some sample unmatched CSS classes for debugging
            const unmatchedSample = [...new Set(pendingCssEdges.map(e => e.cssClass))].filter(c => !cssSelectorToNodeId.has(c) && !cssSelectorToNodeId.has('.' + c)).slice(0, 10);
            console.log(`[Admin] CSS linking: ${pendingCssEdges.length} refs, ${cssEdgesCreated} edges, ${cssSourceCreated} file nodes created, ${cssSelectorMissing} missing CSS selectors`);
            if (unmatchedSample.length > 0) {
              console.log(`[Admin] Sample unmatched CSS classes: ${unmatchedSample.join(', ')}`);
              // Debug: check if any of these exist with different patterns
              const testClass = unmatchedSample[0];
              console.log(`[Admin] DEBUG: Looking for '${testClass}': direct=${cssSelectorToNodeId.has(testClass)}, dotted=${cssSelectorToNodeId.has('.' + testClass)}`);
              // Sample some keys from the map
              const sampleKeys = Array.from(cssSelectorToNodeId.keys()).slice(0, 10);
              console.log(`[Admin] DEBUG: Sample selector keys: ${sampleKeys.join(', ')}`);
            }

            // (Vue node creation moved earlier, before TypeScript processing)

            // === CROSS-FILE CALL RESOLUTION ===
            // Create edges for inheritance/implementation/call relationships
            // Now with cross-file resolution using database symbols and import aliases
            let localResolved = 0;
            let crossFileResolved = 0;
            let aliasResolved = 0;

            for (const pending of pendingEdges) {
              let targetName = pending.targetName;
              let targetId: string | undefined;

              // Step 1: Check import aliases - if the call uses an alias, get the original name
              if (pending.sourceFile) {
                const fileAliases = importAliases.get(pending.sourceFile);
                if (fileAliases) {
                  // Check if the target (or its base name) is an alias
                  const baseName = targetName.includes('.') ? targetName.split('.')[0] : targetName;
                  const originalName = fileAliases.get(baseName);
                  if (originalName && originalName !== baseName) {
                    // Replace alias with original name
                    targetName = targetName.includes('.')
                      ? targetName.replace(baseName, originalName)
                      : originalName;
                    aliasResolved++;
                  }
                }
              }

              // Step 2: Look up target in local maps (current parsing batch)
              targetId = classNameToId.get(targetName)
                || interfaceNameToId.get(targetName)
                || methodNameToId.get(targetName)
                || functionNameToId.get(targetName);

              if (targetId && nodeIds.has(pending.sourceId) && nodeIds.has(targetId)) {
                addEdge(pending.sourceId, targetId, pending.edgeType, pending.isAsync);
                localResolved++;
                continue;
              }

              // Step 3: Cross-file resolution - look up in database symbols
              // Try multiple name patterns for flexible matching
              const namesToTry = [targetName];
              if (targetName.includes('.')) {
                // Also try just the method/function name
                namesToTry.push(targetName.split('.').pop()!);
              }

              for (const nameToTry of namesToTry) {
                const dbTargetId = dbSymbolToId.get(nameToTry);
                if (dbTargetId && nodeIds.has(pending.sourceId)) {
                  // Add the database node to the graph if not already present
                  if (!nodeIds.has(dbTargetId)) {
                    // We need to add the cross-file target node
                    // Note: This creates a "ghost" node - we don't have full info
                    // but we can still show the relationship
                    addNode(
                      dbTargetId,
                      nameToTry,
                      nameToTry,
                      'external-ref',
                      '', // No file path available
                      0,
                      false,
                      'typescript'
                    );
                  }
                  addEdge(pending.sourceId, dbTargetId, pending.edgeType, pending.isAsync);
                  crossFileResolved++;
                  break;
                }
              }
            }

            console.log(`[Admin] Edge resolution: ${localResolved} local, ${crossFileResolved} cross-file, ${aliasResolved} alias-resolved`);

            // === RESOLVE IMPORT/EXPORT EDGES (Task #29) ===
            let importEdgesCreated = 0;
            let exportEdgesCreated = 0;

            // Process pending import edges
            for (const importEdge of pendingImportEdges) {
              // Find target file node
              let targetFileId = filePathToNodeId.get(importEdge.targetPath);

              // If target file wasn't parsed in this batch, create a reference node
              if (!targetFileId && importEdge.targetPath) {
                const targetFileName = path.basename(importEdge.targetPath);
                const targetQualifiedName = importEdge.targetPath.replace(projectPath, '').replace(/^\//, '');
                targetFileId = `ts-file-ext-${targetQualifiedName.replace(/[^a-zA-Z0-9]/g, '-')}`;

                if (!nodeIds.has(targetFileId)) {
                  addNode(
                    targetFileId,
                    targetFileName,
                    targetQualifiedName,
                    'file',
                    importEdge.targetPath,
                    1,
                    false,
                    'typescript'
                  );
                  filePathToNodeId.set(importEdge.targetPath, targetFileId);
                }
              }

              // Create "imports" edge from source file to target file
              if (targetFileId && nodeIds.has(importEdge.sourceFileId)) {
                // Edge label includes imported item info
                const edgeType = importEdge.isTypeOnly ? 'imports-type' : 'imports';
                addEdge(importEdge.sourceFileId, targetFileId, edgeType);
                importEdgesCreated++;

                // Also create edges from imported symbol to its definition if we can find it
                const symbolKey = `${importEdge.targetPath}:${importEdge.importedName}`;
                const exportInfo = exportedSymbols.get(symbolKey);
                if (exportInfo) {
                  // Find the symbol node in our current graph
                  const symbolId = functionNameToId.get(importEdge.importedName)
                    || classNameToId.get(importEdge.importedName)
                    || interfaceNameToId.get(importEdge.importedName)
                    || methodNameToId.get(importEdge.importedName);
                  if (symbolId && nodeIds.has(symbolId)) {
                    addEdge(importEdge.sourceFileId, symbolId, 'imports-symbol');
                    importEdgesCreated++;
                  }
                }
              }
            }

            // Create "exports" edges for exported symbols
            for (const [_key, exportInfo] of exportedSymbols) {
              // Find the symbol node
              const symbolId = functionNameToId.get(exportInfo.name)
                || classNameToId.get(exportInfo.name)
                || interfaceNameToId.get(exportInfo.name)
                || methodNameToId.get(exportInfo.name);

              if (symbolId && nodeIds.has(symbolId) && nodeIds.has(exportInfo.fileNodeId)) {
                const edgeType = exportInfo.isDefault ? 'exports-default' : 'exports';
                addEdge(symbolId, exportInfo.fileNodeId, edgeType);
                exportEdgesCreated++;
              }

              // Handle re-exports: export { x } from './module'
              if (exportInfo.reExportSource) {
                const resolvedReExport = resolveImportPath(exportInfo.reExportSource, exportInfo.filePath, projectPath);
                if (resolvedReExport) {
                  const reExportFileId = filePathToNodeId.get(resolvedReExport);
                  if (reExportFileId && nodeIds.has(exportInfo.fileNodeId)) {
                    addEdge(exportInfo.fileNodeId, reExportFileId, 're-exports');
                    exportEdgesCreated++;
                  }
                }
              }
            }

            console.log(`[Admin] Import/Export edges: ${importEdgesCreated} imports, ${exportEdgesCreated} exports`);

            // === METHOD OVERRIDE DETECTION (Task #38) ===
            // After all classes are processed, detect method overrides
            // by comparing child class methods with parent class methods
            let overrideEdgesCreated = 0;

            for (const [childClass, parentClass] of classExtendsMap) {
              const childMethods = classMethodsMap.get(childClass);
              const parentMethods = classMethodsMap.get(parentClass);

              if (childMethods && parentMethods) {
                // Find methods in child that also exist in parent (overrides)
                for (const [methodName, childMethodId] of childMethods) {
                  const parentMethodId = parentMethods.get(methodName);
                  if (parentMethodId && nodeIds.has(childMethodId) && nodeIds.has(parentMethodId)) {
                    addEdge(childMethodId, parentMethodId, 'overrides');
                    overrideEdgesCreated++;
                  }
                }
              }
            }

            if (overrideEdgesCreated > 0) {
              console.log(`[Admin] Override detection: ${overrideEdgesCreated} method override edges created`);
            }

            // Persist tree-sitter parsed nodes/edges to Ladybug.
            try {
              const { createNodesFromBatch: createN, createEdgesFromBatch: createE } =
                await import('../graph/ladybugGraphBuilder.js');

              const tsNodes = nodes.filter(n => n.id.startsWith('ts-') || n.id.startsWith('css-'));
              if (tsNodes.length > 0) {
                // Dedup by qualified name; use deterministic IDs so subsequent
                // re-parses produce the same IDs and dedup naturally.
                const qualifiedNameToDbId = new Map<string, string>();
                const tempIdToDbId = new Map<string, string>();
                const seenQualifiedNames = new Set<string>();
                const uniqueNodes = tsNodes.filter(n => {
                  const dbId = `${projId}-${n.qualifiedName.replace(/[^a-zA-Z0-9]/g, '-')}`;
                  tempIdToDbId.set(n.id, dbId);
                  qualifiedNameToDbId.set(n.qualifiedName, dbId);
                  if (seenQualifiedNames.has(n.qualifiedName)) return false;
                  seenQualifiedNames.add(n.qualifiedName);
                  return true;
                });

                const nodeInputs = uniqueNodes.map(n => ({
                  id: qualifiedNameToDbId.get(n.qualifiedName)!,
                  name: n.label,
                  qualifiedName: n.qualifiedName,
                  nodeType: n.nodeType,
                  filePath: n.filePath,
                  lineStart: n.lineStart,
                  lineEnd: n.lineStart + 10,
                  projectId: projId,
                  language: n.language || 'typescript',
                }));
                const nodeResult = await createN(nodeInputs);
                if (nodeResult.created > 0) {
                  console.log(`[Admin] Persisted ${nodeResult.created} tree-sitter nodes to Ladybug`);
                }

                const tsEdges = edges.filter(e =>
                  (e.source.startsWith('ts-') || e.source.startsWith('css-')) &&
                  (e.target.startsWith('ts-') || e.target.startsWith('css-'))
                );
                if (tsEdges.length > 0) {
                  const edgeInputs = tsEdges
                    .map(e => {
                      const sourceId = tempIdToDbId.get(e.source);
                      const targetId = tempIdToDbId.get(e.target);
                      if (!sourceId || !targetId) return null;
                      return { sourceId, targetId, edgeType: e.edgeType };
                    })
                    .filter((e): e is NonNullable<typeof e> => e !== null);
                  const edgeResult = await createE(projId, edgeInputs);
                  if (edgeResult.created > 0) {
                    console.log(`[Admin] Persisted ${edgeResult.created} tree-sitter edges to Ladybug`);
                  }
                }
              }
            } catch (persistError) {
              // Non-critical - just log and continue
              console.log('[Admin] Failed to persist tree-sitter nodes:', persistError);
            }
          } catch (tsError) {
            console.log('[Admin] Tree-sitter extraction failed:', tsError);
          }
        }
      } else if (focalFunc) {
        // Function-centric graph (Fantom) with depth-based traversal
        focalNodeId = focalFunc.id;
        addNode(focalFunc.id, focalFunc.name, focalFunc.qualifiedName, focalFunc.type || 'method', focalFunc.filePath, focalFunc.lineNumber || 0, true, 'fantom');

        // Add the containing class if present
        if (focalFunc.className) {
          const containingType = indexer.getAllTypes().find(t => t.name === focalFunc.className || t.qualifiedName.endsWith(`::${focalFunc.className}`));
          if (containingType) {
            addNode(containingType.id, containingType.name, containingType.qualifiedName, containingType.kind || 'type', containingType.filePath, containingType.lineNumber || 0, false, 'fantom');
            addEdge(containingType.id, focalFunc.id, 'contains');
          }
        }

        const allFuncs = indexer.getAllFunctions();
        const visitedFuncIds = new Set<string>([focalFunc.id]);

        // Build call graph maps for efficient lookup
        const calleesMap = new Map<string, typeof allFuncs>(); // funcId -> functions it calls
        const callersMap = new Map<string, typeof allFuncs>(); // funcId -> functions that call it

        for (const func of allFuncs) {
          if (func.calls) {
            for (const call of func.calls) {
              const targetFunc = allFuncs.find(f =>
                f.qualifiedName === call.calledQualifiedName ||
                f.name === call.calledName
              );
              if (targetFunc) {
                // func calls targetFunc
                if (!calleesMap.has(func.id)) calleesMap.set(func.id, []);
                calleesMap.get(func.id)!.push(targetFunc);

                if (!callersMap.has(targetFunc.id)) callersMap.set(targetFunc.id, []);
                callersMap.get(targetFunc.id)!.push(func);
              }
            }
          }
        }

        // BFS traversal for callees
        if (graphType !== 'callers') {
          let currentCallees = [focalFunc];
          for (let d = 0; d < parsedDepth && nodes.length < parsedMaxNodes; d++) {
            const nextCallees: typeof allFuncs = [];
            for (const func of currentCallees) {
              const callees = calleesMap.get(func.id) || [];
              for (const callee of callees) {
                if (nodes.length >= parsedMaxNodes) break;
                if (!visitedFuncIds.has(callee.id)) {
                  visitedFuncIds.add(callee.id);
                  addNode(callee.id, callee.name, callee.qualifiedName, callee.type || 'method', callee.filePath, callee.lineNumber || 0, false, 'fantom');
                  nextCallees.push(callee);
                }
                addEdge(func.id, callee.id, 'calls');
              }
            }
            currentCallees = nextCallees;
            if (currentCallees.length === 0) break;
          }
        }

        // BFS traversal for callers
        if (graphType === 'callers' || graphType === 'subgraph') {
          let currentCallers = [focalFunc];
          for (let d = 0; d < parsedDepth && nodes.length < parsedMaxNodes; d++) {
            const nextCallers: typeof allFuncs = [];
            for (const func of currentCallers) {
              const callers = callersMap.get(func.id) || [];
              for (const caller of callers) {
                if (nodes.length >= parsedMaxNodes) break;
                if (!visitedFuncIds.has(caller.id)) {
                  visitedFuncIds.add(caller.id);
                  addNode(caller.id, caller.name, caller.qualifiedName, caller.type || 'method', caller.filePath, caller.lineNumber || 0, false, 'fantom');
                  nextCallers.push(caller);
                }
                addEdge(caller.id, func.id, 'calls');
              }
            }
            currentCallers = nextCallers;
            if (currentCallers.length === 0) break;
          }
        }
      } else if (focalType) {
        // Type-centric graph (Fantom)
        focalNodeId = focalType.id;
        addNode(focalType.id, focalType.name, focalType.qualifiedName, focalType.kind || 'type', focalType.filePath, focalType.lineNumber || 0, true, 'fantom');

        // Add methods
        for (const method of focalType.methods || []) {
          if (nodes.length >= parsedMaxNodes) break;
          addNode(method.id, method.name, method.qualifiedName, method.type || 'method', method.filePath, method.lineNumber || 0, false, 'fantom');
          addEdge(focalType.id, method.id, 'contains');
        }

        // Add fields
        for (const field of focalType.fields || []) {
          if (nodes.length >= parsedMaxNodes) break;
          addNode(field.id, field.name, field.qualifiedName, 'field', field.filePath, field.lineNumber || 0, false, 'fantom');
          addEdge(focalType.id, field.id, 'contains');
        }

        // Add extends
        if (focalType.extends) {
          const parentType = indexer.getAllTypes().find(t => t.qualifiedName === focalType.extends || t.name === focalType.extends);
          if (parentType) {
            addNode(parentType.id, parentType.name, parentType.qualifiedName, parentType.kind || 'type', parentType.filePath, parentType.lineNumber || 0, false, 'fantom');
            addEdge(focalType.id, parentType.id, 'extends');
          }
        }

        // Add mixins
        for (const mixin of focalType.mixins || []) {
          const mixinType = indexer.getAllTypes().find(t => t.qualifiedName === mixin || t.name === mixin);
          if (mixinType) {
            addNode(mixinType.id, mixinType.name, mixinType.qualifiedName, mixinType.kind || 'mixin', mixinType.filePath, mixinType.lineNumber || 0, false, 'fantom');
            addEdge(focalType.id, mixinType.id, 'implements');
          }
        }
      } else if (focalDbNode) {
        // Database node (tree-sitter parsed) - show focal node and its related nodes from DB
        // Now with depth-based traversal support
        focalNodeId = focalDbNode.id;
        addNode(focalDbNode.id, focalDbNode.name, focalDbNode.qualifiedName, focalDbNode.nodeType, focalDbNode.filePath, focalDbNode.lineStart, true, focalDbNode.language);

        // Fetch related edges and nodes from Ladybug with depth-based traversal.
        try {
          // Track nodes at each depth level for BFS traversal
          const visitedNodeIds = new Set<string>([focalDbNode.id]);
          let currentLevelNodeIds = [focalDbNode.id];
          const allEdges: Array<{ sourceId: string; targetId: string; edgeType: string; source: any; target: any }> = [];

          // BFS traversal up to parsedDepth levels
          for (let currentDepth = 0; currentDepth < parsedDepth && nodes.length < parsedMaxNodes; currentDepth++) {
            if (currentLevelNodeIds.length === 0) break;

            // Fetch edges for current level (Ladybug-authoritative).
            const idList = currentLevelNodeIds.map(id => `'${id.replace(/'/g, "\\'")}'`).join(', ');
            const takeLimit = (parsedMaxNodes - nodes.length) * 3;
            let cypher: string;
            if (graphType === 'callers') {
              cypher = `MATCH (s:CodeNode)-[e:CodeEdge]->(t:CodeNode) WHERE t.id IN [${idList}] RETURN s.id AS sId, s.name AS sName, s.qualified_name AS sQn, s.node_type AS sNt, s.file_path AS sFp, s.line_start AS sLs, s.language AS sLang, t.id AS tId, t.name AS tName, t.qualified_name AS tQn, t.node_type AS tNt, t.file_path AS tFp, t.line_start AS tLs, t.language AS tLang, e.edge_type AS edgeType LIMIT ${takeLimit}`;
            } else if (graphType === 'callees') {
              cypher = `MATCH (s:CodeNode)-[e:CodeEdge]->(t:CodeNode) WHERE s.id IN [${idList}] RETURN s.id AS sId, s.name AS sName, s.qualified_name AS sQn, s.node_type AS sNt, s.file_path AS sFp, s.line_start AS sLs, s.language AS sLang, t.id AS tId, t.name AS tName, t.qualified_name AS tQn, t.node_type AS tNt, t.file_path AS tFp, t.line_start AS tLs, t.language AS tLang, e.edge_type AS edgeType LIMIT ${takeLimit}`;
            } else {
              cypher = `MATCH (s:CodeNode)-[e:CodeEdge]->(t:CodeNode) WHERE s.id IN [${idList}] OR t.id IN [${idList}] RETURN s.id AS sId, s.name AS sName, s.qualified_name AS sQn, s.node_type AS sNt, s.file_path AS sFp, s.line_start AS sLs, s.language AS sLang, t.id AS tId, t.name AS tName, t.qualified_name AS tQn, t.node_type AS tNt, t.file_path AS tFp, t.line_start AS tLs, t.language AS tLang, e.edge_type AS edgeType LIMIT ${takeLimit}`;
            }
            const edgeRows = await ladybugQuery<{ sId: string; sName: string; sQn: string; sNt: string; sFp: string; sLs: number; sLang: string; tId: string; tName: string; tQn: string; tNt: string; tFp: string; tLs: number; tLang: string; edgeType: string }>(focalDbNode.projectId, cypher);
            const levelEdges: Array<{ sourceId: string; targetId: string; edgeType: string; source: { id: string; name: string; qualifiedName: string; nodeType: string; filePath: string; lineStart: number; language: string }; target: { id: string; name: string; qualifiedName: string; nodeType: string; filePath: string; lineStart: number; language: string } }> = edgeRows.map(r => ({
              sourceId: r.sId,
              targetId: r.tId,
              edgeType: r.edgeType,
              source: { id: r.sId, name: r.sName, qualifiedName: r.sQn, nodeType: r.sNt, filePath: r.sFp, lineStart: Number(r.sLs), language: r.sLang },
              target: { id: r.tId, name: r.tName, qualifiedName: r.tQn, nodeType: r.tNt, filePath: r.tFp, lineStart: Number(r.tLs), language: r.tLang }
            }));

            // Collect new nodes for next level
            const nextLevelNodeIds: string[] = [];

            for (const edge of levelEdges) {
              if (nodes.length >= parsedMaxNodes) break;

              // Store edge for later
              allEdges.push(edge);

              // Add source node if not visited
              if (!visitedNodeIds.has(edge.sourceId)) {
                visitedNodeIds.add(edge.sourceId);
                addNode(edge.source.id, edge.source.name, edge.source.qualifiedName, edge.source.nodeType, edge.source.filePath, edge.source.lineStart, false, edge.source.language);
                // For callers graph, follow the callers (sources)
                if (graphType === 'callers' || graphType === 'subgraph' || graphType === 'impact') {
                  nextLevelNodeIds.push(edge.sourceId);
                }
              }

              // Add target node if not visited
              if (!visitedNodeIds.has(edge.targetId)) {
                visitedNodeIds.add(edge.targetId);
                addNode(edge.target.id, edge.target.name, edge.target.qualifiedName, edge.target.nodeType, edge.target.filePath, edge.target.lineStart, false, edge.target.language);
                // For callees/impact graph, follow the callees (targets)
                if (graphType === 'callees' || graphType === 'subgraph' || graphType === 'impact') {
                  nextLevelNodeIds.push(edge.targetId);
                }
              }
            }

            // Move to next level
            currentLevelNodeIds = nextLevelNodeIds;
          }

          // Add all collected edges (now both nodes should exist)
          for (const edge of allEdges) {
            addEdge(edge.sourceId, edge.targetId, edge.edgeType);
          }

          // If no edges found, try to get nodes from the same project (Ladybug-authoritative).
          if (allEdges.length === 0) {
            const focalIdEsc = focalDbNode.id.replace(/'/g, "\\'");
            const projectNodes = await ladybugQuery<{ id: string; name: string; qualifiedName: string; nodeType: string; filePath: string; lineStart: number; language: string }>(
              focalDbNode.projectId,
              `MATCH (n:CodeNode) WHERE n.id <> '${focalIdEsc}' RETURN n.id AS id, n.name AS name, n.qualified_name AS qualifiedName, n.node_type AS nodeType, n.file_path AS filePath, n.line_start AS lineStart, n.language AS language LIMIT ${parsedMaxNodes - 1}`
            );

            for (const pNode of projectNodes) {
              if (nodes.length >= parsedMaxNodes) break;
              addNode(pNode.id, pNode.name, pNode.qualifiedName, pNode.nodeType, pNode.filePath, pNode.lineStart, false, pNode.language);
            }
          }
        } catch (dbError) {
          console.log('[Admin] Failed to fetch related nodes from database:', dbError);
        }
      } else {
        res.status(404).json({ error: 'Node not found in indexer or database', nodeId, qualifiedName });
        return;
      }

      // Format as Cytoscape JSON (no compound parent nodes, just regular nodes with language field)
      const result = {
        elements: {
          nodes: nodes.map(n => ({ data: n })),
          edges: edges.map(e => ({ data: e }))
        },
        metadata: {
          title: focalFunc?.qualifiedName || focalType?.qualifiedName || focalDbNode?.qualifiedName || `Project ${projectId}`,
          description: `${graphType} graph (depth: ${parsedDepth})`,
          nodeCount: nodes.length,
          edgeCount: edges.length,
          focalNodeId,
          depth: parsedDepth,
          maxNodes: parsedMaxNodes,
          languageGroups: languageGroupsMeta.map(g => ({
            id: g.id,
            label: g.label,
            language: g.language,
            color: g.color,
            count: nodes.filter(n => n.language === g.language).length
          }))
        }
      };

      res.json(result);
    } catch (error) {
      console.error('[Admin] Indexer graph visualization error:', error);
      const message = error instanceof Error ? error.message : 'Failed to get indexer graph data';
      res.status(500).json({ error: message });
    }
  });

  /**
   * GET /admin/graph/nodes/search
   * Search for nodes by name or qualified name
   * Searches both code_nodes table (tree-sitter) AND FantomCodeIndexer (regex parser)
   */
  router.get('/graph/nodes/search', async (req: Request, res: Response): Promise<void> => {
    try {
      const { q, projectId, limit = '20', source } = req.query;

      if (!q || typeof q !== 'string') {
        res.status(400).json({ error: 'Query parameter q is required' });
        return;
      }

      // Allow higher limit for "get all" queries (asterisk or empty)
      const isGetAll = q === '*' || (q as string).trim() === '';
      const maxLimit = isGetAll ? 1000 : 100;
      const parsedLimit = Math.min(parseInt(limit as string, 10) || 20, maxLimit);

      interface NodeSearchResult {
        id: string;
        name: string;
        qualifiedName: string;
        nodeType: string;
        filePath: string;
        lineStart: number;
        projectId: number;
        source: 'code_nodes' | 'indexer';
      }

      const allNodes: NodeSearchResult[] = [];

      // Search code_nodes table (tree-sitter parsed)
      if (!source || source === 'code_nodes' || source === 'all') {
        try {
          const { getPrismaClient } = await import('../db/prisma.js');
          const prisma = getPrismaClient();
          const searchTerm = `%${q.toLowerCase()}%`;

          interface DbNodeResult {
            id: string;
            name: string;
            qualified_name: string;
            node_type: string;
            file_path: string;
            line_start: number;
            project_id: number;
          }

          let rawNodes: DbNodeResult[];
          if (projectId) {
            const projectIdNum = parseInt(projectId as string, 10);
            if (isGetAll) {
              // Return all nodes for the project
              rawNodes = await prisma.$queryRaw<DbNodeResult[]>`
                SELECT id, name, qualified_name, node_type, file_path, line_start, project_id
                FROM code_nodes
                WHERE project_id = ${projectIdNum}
                ORDER BY name ASC
                LIMIT ${parsedLimit}
              `;
            } else {
              rawNodes = await prisma.$queryRaw<DbNodeResult[]>`
                SELECT id, name, qualified_name, node_type, file_path, line_start, project_id
                FROM code_nodes
                WHERE (LOWER(name) LIKE ${searchTerm} OR LOWER(qualified_name) LIKE ${searchTerm})
                  AND project_id = ${projectIdNum}
                ORDER BY name ASC
                LIMIT ${parsedLimit}
              `;
            }
          } else {
            if (isGetAll) {
              rawNodes = await prisma.$queryRaw<DbNodeResult[]>`
                SELECT id, name, qualified_name, node_type, file_path, line_start, project_id
                FROM code_nodes
                ORDER BY name ASC
                LIMIT ${parsedLimit}
              `;
            } else {
              rawNodes = await prisma.$queryRaw<DbNodeResult[]>`
                SELECT id, name, qualified_name, node_type, file_path, line_start, project_id
                FROM code_nodes
                WHERE LOWER(name) LIKE ${searchTerm} OR LOWER(qualified_name) LIKE ${searchTerm}
                ORDER BY name ASC
                LIMIT ${parsedLimit}
              `;
            }
          }

          for (const n of rawNodes) {
            allNodes.push({
              id: n.id,
              name: n.name,
              qualifiedName: n.qualified_name,
              nodeType: n.node_type,
              filePath: n.file_path,
              lineStart: n.line_start,
              projectId: n.project_id,
              source: 'code_nodes'
            });
          }
        } catch (dbError) {
          console.warn('[Admin] code_nodes search failed:', dbError);
        }
      }

      // Search FantomCodeIndexer (regex parsed)
      if (!source || source === 'indexer' || source === 'all') {
        try {
          const indexer = getFantomCodeIndexer();

          // For "get all", fetch all functions; otherwise search by name
          const indexerResults = isGetAll
            ? indexer.getAllFunctions().slice(0, parsedLimit)
            : indexer.searchByName(q, parsedLimit);

          for (const func of indexerResults) {
            // Apply projectId filter if specified
            if (projectId && func.projectId !== parseInt(projectId as string, 10)) {
              continue;
            }

            // Avoid duplicates by checking qualifiedName
            const isDuplicate = allNodes.some(n => n.qualifiedName === func.qualifiedName);
            if (!isDuplicate && func.projectId !== undefined) {
              allNodes.push({
                id: func.id,
                name: func.name,
                qualifiedName: func.qualifiedName,
                nodeType: func.type || 'function',
                filePath: func.filePath,
                lineStart: func.lineNumber || 0,
                projectId: func.projectId,
                source: 'indexer'
              });
            }
          }

          // Also search types from indexer
          const allTypes = indexer.getAllTypes();
          const queryLower = q.toLowerCase();
          for (const type of allTypes) {
            if (allNodes.length >= parsedLimit) break;

            // For "get all", include all types; otherwise filter by name
            const matchesQuery = isGetAll ||
              type.name.toLowerCase().includes(queryLower) ||
              type.qualifiedName.toLowerCase().includes(queryLower);

            if (matchesQuery) {
              // Apply projectId filter if specified
              if (projectId && type.projectId !== parseInt(projectId as string, 10)) {
                continue;
              }

              const isDuplicate = allNodes.some(n => n.qualifiedName === type.qualifiedName);
              if (!isDuplicate && type.projectId !== undefined) {
                allNodes.push({
                  id: type.id,
                  name: type.name,
                  qualifiedName: type.qualifiedName,
                  nodeType: type.kind || 'type',
                  filePath: type.filePath,
                  lineStart: type.lineNumber || 0,
                  projectId: type.projectId,
                  source: 'indexer'
                });
              }
            }
          }
        } catch (indexerError) {
          console.warn('[Admin] indexer search failed:', indexerError);
        }
      }

      // Sort by name and limit
      allNodes.sort((a, b) => a.name.localeCompare(b.name));
      const limitedNodes = allNodes.slice(0, parsedLimit);

      res.json({ count: limitedNodes.length, nodes: limitedNodes });
    } catch (error) {
      console.error('[Admin] Node search error:', error);
      const message = error instanceof Error ? error.message : 'Failed to search nodes';
      res.status(500).json({ error: message });
    }
  });

  // ============================================
  // Vector/Semantic Search endpoints
  // ============================================

  /**
   * POST /admin/vectors/search
   * Perform semantic search using embeddings
   */
  router.post('/vectors/search', async (req: Request, res: Response): Promise<void> => {
    try {
      const { query, projectId, nodeType, limit = 20, includeGraphContext = true } = req.body;

      if (!query || typeof query !== 'string') {
        res.status(400).json({ error: 'Query is required' });
        return;
      }

      const { getSemanticSearchService } = await import('../embedding/semanticSearchService.js');
      const { getPrismaClient } = await import('../db/prisma.js');
      const prisma = getPrismaClient();
      const searchService = getSemanticSearchService(prisma);

      const results = await searchService.search(query, {
        projectId: projectId ? parseInt(projectId, 10) : undefined,
        nodeType,
        limit: Math.min(limit, 50),
        includeGraphContext
      });

      res.json({
        query,
        count: results.length,
        results
      });
    } catch (error) {
      console.error('[Admin] Semantic search error:', error);
      const message = error instanceof Error ? error.message : 'Failed to perform semantic search';
      res.status(500).json({ error: message });
    }
  });

  /**
   * POST /admin/vectors/ask
   * RLM code Q&A — synthesize a grounded, cited answer from semantic search,
   * the call graph, and change history.
   * Body: { query, projectId?, provider?, model?, topK?, fast?, rlm?, rerank? }
   */
  router.post('/vectors/ask', async (req: Request, res: Response): Promise<void> => {
    try {
      const { query, projectId, provider, model, topK, fast, rlm, rerank, askId } = req.body || {};
      if (!query || typeof query !== 'string') {
        res.status(400).json({ error: 'query is required' });
        return;
      }
      const { answerCodeQuestion } = await import('../embedding/answerSynthesis.js');
      // Live feed: the client picks an id, polls /vectors/ask/:id/events while
      // this request runs, and sees each RLM question and its result.
      const feedId = typeof askId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(askId) ? askId : undefined;
      const { startAsk, endAsk } = await import('../embedding/askEvents.js');
      if (feedId) startAsk(feedId);
      const result = await answerCodeQuestion(query, {
        askId: feedId,
        projectId: projectId !== undefined ? parseInt(String(projectId), 10) : undefined,
        provider,
        model,
        topK: topK !== undefined ? parseInt(String(topK), 10) : undefined,
        // The dashboard sends fast:true. The MCP tool does not, and keeps the
        // full budget with the RLM stage — see AnswerCodeQuestionOptions.fast.
        fast: fast === true,
        // Stage switches. Absent → defaults (RLM unless fast; rerank on).
        rlm: typeof rlm === 'boolean' ? rlm : undefined,
        rerank: typeof rerank === 'boolean' ? rerank : undefined,
      });
      if (feedId) endAsk(feedId);
      res.json(result);
    } catch (error) {
      console.error('[Admin] Answer synthesis error:', error);
      const message = error instanceof Error ? error.message : 'Failed to synthesize answer';
      try {
        const { endAsk } = await import('../embedding/askEvents.js');
        const id = (req.body || {}).askId;
        if (typeof id === 'string') endAsk(id, message);
      } catch { /* ignore */ }
      res.status(500).json({ error: message });
    }
  });

  /**
   * GET /admin/vectors/ask/:askId/events?since=N
   * The live "thinking" feed for an in-flight (or recently finished) ask.
   */
  router.get('/vectors/ask/:askId/events', async (req: Request, res: Response): Promise<void> => {
    const { getAskEvents } = await import('../embedding/askEvents.js');
    const since = Number(req.query.since ?? 0);
    res.setHeader('Cache-Control', 'no-store');
    res.json(getAskEvents(String(req.params.askId), Number.isFinite(since) ? since : 0));
  });

  /**
   * POST /admin/search/code
   * Keyword search via the FlexSearch function index (mirrors searchFantomCode MCP tool).
   * Body: { query, projectId?, projectName?, limit? }
   */
  router.post('/search/code', async (req: Request, res: Response): Promise<void> => {
    try {
      const { query, projectId, projectName, limit = 20 } = req.body || {};
      if (!query || typeof query !== 'string') {
        res.status(400).json({ error: 'query is required' });
        return;
      }
      const { getFantomFunctionSearchIndex } = await import('../fantom-code/searchIndex.js');
      const { resolveProjectId } = await import('../utils/dbBootstrap.js');
      const { getPrismaClient } = await import('../db/prisma.js');
      const prisma = getPrismaClient();
      const pid = await resolveProjectId(prisma, { projectId, projectName });
      const idx = getFantomFunctionSearchIndex();
      const results = idx.search(query, { limit: Math.min(limit, 100), projectId: pid });
      res.json({
        query,
        projectId: pid,
        count: results.length,
        results: results.map(r => ({
          score: r.score,
          qualifiedName: r.function.qualifiedName,
          name: r.function.name,
          type: r.function.type,
          filePath: r.function.filePath,
          line: r.function.lineNumber,
        }))
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Code search failed';
      res.status(500).json({ error: message });
    }
  });

  /**
   * POST /admin/search/semantic
   * Semantic/vector search wrapper (mirrors semanticCodeSearch MCP tool).
   */
  router.post('/search/semantic', async (req: Request, res: Response): Promise<void> => {
    try {
      const {
        query,
        projectId,
        projectName,
        limit = 10,
        llmReranker,
        crossEncoderReranker,
        hybrid,
        rerank,
      } = req.body || {};
      if (!query || typeof query !== 'string') {
        res.status(400).json({ error: 'query is required' });
        return;
      }
      const { getSemanticSearchService } = await import('../embedding/semanticSearchService.js');
      const { resolveProjectId } = await import('../utils/dbBootstrap.js');
      const { getPrismaClient } = await import('../db/prisma.js');
      const prisma = getPrismaClient();
      const pid = await resolveProjectId(prisma, { projectId, projectName });
      const svc = getSemanticSearchService(prisma);
      const t0 = Date.now();
      const results = await svc.search(query, {
        projectId: pid,
        limit: Math.min(limit, 50),
        // Per-call reranker overrides — let test scripts exercise each
        // provider without flipping global settings between runs.
        ...(llmReranker ? { llmReranker } : {}),
        ...(crossEncoderReranker ? { crossEncoderReranker } : {}),
        ...(typeof hybrid === 'boolean' ? { hybrid } : {}),
        ...(rerank === 'auto' || rerank === 'on' || rerank === 'off' ? { rerank } : {}),
      });
      const elapsedMs = Date.now() - t0;
      res.json({
        query,
        projectId: pid,
        count: results.length,
        elapsedMs,
        rerankerProvider: llmReranker?.enabled ? (llmReranker.provider ?? 'default') : null,
        results,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Semantic search failed';
      res.status(500).json({ error: message });
    }
  });

  /**
   * GET /admin/vectors/project/:id
   * Get vector embeddings with 2D projections for a project
   */
  router.get('/vectors/project/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      const projectId = parseInt(req.params.id as string, 10);
      const limitStr = (req.query.limit as string) || '500';
      const parsedLimit = Math.min(parseInt(limitStr, 10), 1000);

      const { getPrismaClient } = await import('../db/prisma.js');
      const { getVectorStore } = await import('../embedding/vectorStore.js');
      const prisma = getPrismaClient();
      const vectorStore = getVectorStore(prisma);

      // Get vectors with embeddings from LanceDB
      const vectorRows = await vectorStore.getProjectVectorsWithEmbeddings(projectId, parsedLimit);
      const nodeIds = vectorRows.map(v => v.nodeId);

      // Fetch node metadata (Ladybug-authoritative).
      const idList = nodeIds.map(id => `'${id.replace(/'/g, "\\'")}'`).join(', ');
      // Per-project graph db (the single-arg form hits the stale shared db and
      // returned 0 nodes → the vector viewer showed an empty project).
      const nodes = nodeIds.length === 0 ? [] : await ladybugQuery<{ id: string; name: string; qualifiedName: string; nodeType: string; filePath: string; lineStart: number }>(
        projectId,
        `MATCH (n:CodeNode {project_id: ${projectId}}) WHERE n.id IN [${idList}] RETURN n.id AS id, n.name AS name, n.qualified_name AS qualifiedName, n.node_type AS nodeType, n.file_path AS filePath, n.line_start AS lineStart`
      );
      const nodeMap = new Map(nodes.map(n => [n.id, n]));

      // Simple 2D projection using first 2 dimensions of the embedding
      const projected = vectorRows.map((vr, index) => {
        const node = nodeMap.get(vr.nodeId);
        if (!node) return null;

        let x = 0, y = 0;
        if (vr.embedding.length >= 2) {
          x = vr.embedding[0] || 0;
          y = vr.embedding[1] || 0;
        } else {
          const cols = Math.ceil(Math.sqrt(vectorRows.length));
          x = (index % cols) / cols;
          y = Math.floor(index / cols) / cols;
        }

        return {
          id: node.id,
          name: node.name,
          qualifiedName: node.qualifiedName,
          nodeType: node.nodeType,
          filePath: node.filePath,
          lineStart: node.lineStart,
          x,
          y
        };
      }).filter(Boolean);

      res.json({
        projectId,
        count: projected.length,
        nodes: projected
      });
    } catch (error) {
      console.error('[Admin] Project vectors error:', error);
      const message = error instanceof Error ? error.message : 'Failed to get project vectors';
      res.status(500).json({ error: message });
    }
  });

  /**
   * Cached per-project vector counts.
   *
   * countByProject() scans the whole code table (200k+ rows during a rebuild)
   * and groups in JS, which blocks the event loop for ~100ms. Five dashboard
   * components poll /vectors/stats on a shared 10s key, and a running job adds
   * 2s polls elsewhere, so the stall was visible as UI sluggishness. A short
   * TTL collapses bursts without making progress look stale.
   */
  /**
   * Compact the write slot after this many ROWS have been appended to it.
   *
   * It used to be "every 10 completed projects", and that trigger was keyed to
   * the very thing fragmentation degrades. Measured on the cloud rebuild:
   *
   *   fragments 2,292 → compaction → 1,058
   *   throughput   24 rows/s → 75-130 rows/s      (4-5x)
   *   projects    1.0/min   → ~8/min
   *
   * Because the trigger counted PROJECTS, a fragmented slot completed projects
   * more slowly, so compaction ran less often, so it fragmented further. Slow
   * made it slower — a vicious cycle that bottomed out at 24 rows/s while the
   * cloud providers sat idle (inFlight=0) waiting on the write queue.
   *
   * Rows were the SECOND wrong unit, for the same reason. Measured on the
   * resumed job: 1-4 rows/s while fragments climbed 2,269 -> 2,463. Rows per
   * second is precisely what collapses, so a rows-based threshold also fires
   * least often exactly when it is needed most — 8,000 rows at 1.5 rows/s is
   * 90 minutes away, by which time the slot is unusable.
   *
   * APPENDS are the unit that does not depend on progress. Every store call
   * writes a fragment (plus a delete file, which is why fragments can grow
   * faster than rows), so this counter advances at the same rate whether the
   * table is fast or crawling — which is the whole point. It is the one signal
   * in this loop that a degrading write path cannot suppress.
   *
   * 300 appends keeps the slot near the ~1,000-fragment mark where throughput
   * measured 75-130 rows/s, against 24 rows/s at 2,300 and 1.5 rows/s at
   * 2,400. Compaction costs a few seconds; the collapse costs everything.
   */
  const COMPACT_EVERY_APPENDS = 300;
  /**
   * Accumulate this many rows before appending to the write slot.
   *
   * Lance targets 1M rows per fragment; this rebuild was writing ~85 per
   * append, giving ~2,300 fragments for 197k rows. Every append rewrites a
   * manifest proportional to the fragment list, so that is a quadratic write
   * path — the reason throughput fell from 130 rows/s to 1.5 while the cloud
   * providers sat idle.
   *
   * 1,500, lowered from 4,000 after the RSS guard killed this process at
   * 3,991 MB. The original sizing said "~40 MB per worker" and failed to
   * multiply: six concurrent workers is ~245 MB of new resident memory added
   * to a process that died with 11 MB of headroom. At 1,500 rows and three
   * workers it is ~45 MB total, and still ~18x fewer appends than the ~85-row
   * chunks that caused the collapse. The win here is overwhelmingly in the
   * first order of magnitude; the rest is not worth an OOM.
   */
  const STORE_FLUSH_ROWS = 1_500;
  const VECTOR_COUNT_TTL_MS = 5_000;
  // A shadow rebuild is the expensive case: the slot grows past 200k rows and
  // the v3 layout needs distinct node ids, so each scan materialises two
  // columns for every row. Progress only has to feel live, so widen the window
  // while building — one scan per 20s instead of one per poll.
  const VECTOR_COUNT_TTL_BUILDING_MS = 20_000;
  let vectorCountCache: { key: string; at: number; value: Map<number, number> } | null = null;
  let vectorCountInFlight: { key: string; p: Promise<Map<number, number>> } | null = null;
  async function countByProjectCached(
    store: { countByProject: (slot?: string) => Promise<Map<number, number>> },
    slotName: string | null,
  ): Promise<Map<number, number>> {
    const key = slotName ?? '<active>';
    const now = Date.now();
    const ttl = slotName ? VECTOR_COUNT_TTL_BUILDING_MS : VECTOR_COUNT_TTL_MS;
    if (vectorCountCache && vectorCountCache.key === key && now - vectorCountCache.at < ttl) {
      return vectorCountCache.value;
    }
    // Single-flight: concurrent pollers (five components, several pages) must
    // not each start their own scan of the same table.
    if (vectorCountInFlight && vectorCountInFlight.key === key) return vectorCountInFlight.p;
    const p = (async () => {
      try {
        const value = await store.countByProject(slotName ?? undefined);
        vectorCountCache = { key, at: Date.now(), value };
        return value;
      } finally {
        vectorCountInFlight = null;
      }
    })();
    vectorCountInFlight = { key, p };
    return p;
  }

  /**
   * GET /admin/vectors/stats
   * Get vector/embedding statistics
   */
  router.get('/vectors/stats', async (req: Request, res: Response): Promise<void> => {
    try {
      const { getPrismaClient } = await import('../db/prisma.js');
      const { getVectorStore } = await import('../embedding/vectorStore.js');
      const { getDocsVectorStore } = await import('../embedding/docsVectorStore.js');
      const { getLanceTableStats } = await import('../embedding/lanceConnection.js');
      const prisma = getPrismaClient();
      const vectorStore = getVectorStore(prisma);
      const docsVectorStore = getDocsVectorStore();

      // RESILIENT READS: a missing OR corrupt LanceDB table (e.g. an
      // interrupted re-embed left a dangling data-fragment reference) must NOT
      // 500 this endpoint — that blanks the whole dashboard even though the
      // projects (Prisma + graph) are intact. Each vector read degrades to
      // 0/empty on error so projects still render (at 0% coverage). The vector
      // counts repopulate once the table is rebuilt; getLanceTableStats is
      // already internally guarded.
      // While a full re-embed builds into the SHADOW slot, the active slot is
      // stale: every finished project still reads as 0 vectors and no progress
      // bar fills. Count the shadow slot instead so partial/complete projects
      // show real progress; `activeVectors` keeps reporting what search serves.
      const { isShadowReembedActive } = await import('../embedding/embedGate.js');
      const { getActiveCodeTableName, getInactiveCodeTableName, openCodeSlotReadonly } =
        await import('../embedding/lanceConnection.js');
      const shadowBuilding = isShadowReembedActive();
      const shadowSlot = shadowBuilding ? getInactiveCodeTableName() : null;

      // ALWAYS read what the inactive slot holds, building or not.
      //
      // A cancelled or interrupted rebuild leaves a full shadow on disk that
      // nothing promotes; reporting it only during a build made a stopped run
      // look like total data loss ("I stopped embedding, why did I lose
      // everything") when 225,008 rows across 324 projects were sitting there
      // intact. countRows is ~4ms, so this is cheap enough for every poll.
      //
      // Reading it DURING a build as well is what lets the payload carry
      // `rowsOnDisk` — vectors across both slots. That single number is what
      // answers "coverage fell after a restart": if it has not dropped, the
      // displayed figure changed table (see coverageSource.ts) and no vector
      // was lost. `pending` stays gated on !building, because a shadow that is
      // still being written is not a banked one an operator can promote.
      const inactiveSlotName = getInactiveCodeTableName();
      let inactiveRows = 0;
      try {
        const t = await openCodeSlotReadonly(inactiveSlotName);
        if (t) inactiveRows = await t.countRows();
      } catch { /* best effort — never fail stats over this */ }
      const pendingSlot: string | null = !shadowBuilding && inactiveRows > 0 ? inactiveSlotName : null;
      const pendingRows = pendingSlot ? inactiveRows : 0;

      const [totalVectors, projects, vectorsByProject, docsCount, docsByPod, lanceStats] = await Promise.all([
        vectorStore.count().catch((e) => { console.warn('[vectors/stats] code count unavailable (table missing/corrupt):', (e as Error).message?.slice(0, 120)); return 0; }),
        prisma.fantomProject.findMany({
          select: {
            id: true,
            name: true,
            functionCount: true,
            typeCount: true
          }
        }),
        countByProjectCached(vectorStore, shadowSlot).catch(() => new Map<number, number>()),
        docsVectorStore.count().catch(() => 0),
        docsVectorStore.countByPod().catch(() => new Map<string, number>()),
        getLanceTableStats()
      ]);

      // Per-project graph node counts — the AUTHORITATIVE denominator, read
      // from the same per-project graph dbs the embedder uses (cached). This is
      // why the headline and per-project rows now reconcile.
      // NON-BLOCKING: answered from the on-disk snapshot; anything stale is
      // refreshed by one background worker. The blocking form ran ~340 Kuzu
      // opens (45–130s) inside this request every ten minutes and after every
      // restart — that was the "project list sits over 30 seconds" report.
      const { getProjectNodeCountsNonBlocking } = await import('../graph/projectNodeCounts.js');
      const { counts: graphCounts, status: nodeCountsStatus } =
        getProjectNodeCountsNonBlocking(projects.map((p: { id: number }) => p.id));
      const { getAllProjectEmbeddingMeta, getFleetEmbeddingSplit } = await import('../embedding/projectEmbeddingMeta.js');
      const meta = getAllProjectEmbeddingMeta();
      // Real fan-out split across the fleet, local and cloud. Derived from the
      // per-project `servedBy` records already on disk — no extra I/O.
      const fleetSplit = getFleetEmbeddingSplit();
      const { findPausedJob, findActiveJob } = await import('./reembedJobs.js');
      const pausedJob = findPausedJob();
      const activeJob = findActiveJob();
      // Live per-project node count from the in-memory FantomCodeIndexer — used
      // ONLY as a fallback when a project's graph db reports 0 nodes.
      // LAZY: walking the whole in-memory index allocates a Map over every
      // function and type on each poll (10s) and blocks the event loop. It is
      // only ever consulted for projects whose graph db reports 0 nodes, so
      // skip it entirely when every project has graph counts.
      let liveCounts: Map<number, { fns: number; types: number }> | null = null;
      const needsLiveFallback = projects.some((p: { id: number }) => (graphCounts.get(p.id) ?? 0) === 0);
      try {
        if (!needsLiveFallback) throw new Error('skip-live-counts');
        const { getFantomCodeIndexer } = await import('../fantom-code/indexer.js');
        const idx = getFantomCodeIndexer();
        liveCounts = new Map<number, { fns: number; types: number }>();
        for (const f of idx.getAllFunctions()) {
          const pid = Number((f as { projectId?: number }).projectId);
          if (!Number.isFinite(pid)) continue;
          const cur = liveCounts.get(pid) ?? { fns: 0, types: 0 };
          cur.fns++;
          liveCounts.set(pid, cur);
        }
        for (const t of idx.getAllTypes()) {
          const pid = Number((t as { projectId?: number }).projectId);
          if (!Number.isFinite(pid)) continue;
          const cur = liveCounts.get(pid) ?? { fns: 0, types: 0 };
          cur.types++;
          liveCounts.set(pid, cur);
        }
      } catch { /* fall back to Prisma */ }
      const projectRows = projects.map((p: { id: number; name: string; functionCount: number; typeCount: number }) => {
        const vc = vectorsByProject.get(p.id) || 0;
        const m = meta[String(p.id)];
        const live = liveCounts?.get(p.id);
        const prismaTotal = (p.functionCount ?? 0) + (p.typeCount ?? 0);
        const liveTotal = live ? live.fns + live.types : 0;
        const graphN = graphCounts.get(p.id) ?? 0;
        // Authoritative = per-project graph CodeNode count (what gets embedded);
        // fall back to max(prisma, live) only when the graph is empty.
        const nodeCount = graphN > 0 ? graphN : Math.max(prismaTotal, liveTotal);
        return {
          id: p.id,
          name: p.name,
          nodeCount,
          vectorCount: vc,
          embeddingModel: vc > 0 ? (lanceStats.code.model ?? null) : null,
          embeddingDimensions: vc > 0 ? (lanceStats.code.dimensions ?? null) : null,
          // Per-project attribution from projectEmbeddingMeta.json.
          // GATED ON vc > 0, exactly like embeddingModel above. The meta file
          // survives table swaps and model changes, so a project with no rows
          // in the current table was still reporting the sidecar and model of
          // a run from weeks ago — rows sat at "0 vectors, model —" yet named
          // "BASWS35 / jina-code-embeddings" from June. Describing a past
          // event in one column while blanking it in the next is worse than
          // showing nothing.
          embeddingSidecarName: vc > 0 ? (m?.sidecarName ?? null) : null,
          embeddingSidecarHost: vc > 0 ? (m?.sidecarHost ?? null) : null,
          embeddingSidecarModel: vc > 0 ? (m?.sidecarModel ?? null) : null,
          embeddingSelectedSidecarName: vc > 0 ? (m?.selectedSidecarName ?? null) : null,
          embeddingServedBy: vc > 0 ? (m?.servedBy ?? null) : null,
          embeddedInProcess: vc > 0 ? (m?.inProcess ?? null) : null,
          embeddedAt: vc > 0 ? (m?.embeddedAt ?? null) : null,
        };
      });
      // Headline reconciles with the rows BY CONSTRUCTION (sum of the same
      // per-project denominators), so 95%-overall vs per-project no longer diverge.
      const totalNodes = projectRows.reduce((s, r) => s + r.nodeCount, 0);
      // Headline must match the rows: during a shadow rebuild the rows carry
      // shadow counts, so summing them (not the active-slot total) is what
      // keeps the percentage and the per-project bars telling the same story.
      const shownVectors = projectRows.reduce((s, r) => s + r.vectorCount, 0);

      // Name the slot the numbers above were counted from, and report rows
      // across both slots. `slotToCount` is dropped: it is the input to
      // countByProjectCached (already applied as `shadowSlot`), not something
      // the dashboard needs.
      const { resolveCoverageSource } = await import('../embedding/coverageSource.js');
      const { slotToCount: _slotToCount, ...coverage } = resolveCoverageSource({
        building: shadowBuilding,
        activeTable: getActiveCodeTableName(),
        inactiveTable: inactiveSlotName,
        activeRows: totalVectors,
        shadowRows: inactiveRows,
      });

      const payload = {
        totalVectors: shownVectors,
        totalNodes,
        coveragePercent: totalNodes > 0 ? (shownVectors / totalNodes * 100).toFixed(1) : '0',
        projects: projectRows,
        // Where the per-project node counts came from — 'partial' means some
        // rows show a pre-reindex or Prisma count while the worker refreshes.
        nodeCounts: nodeCountsStatus,
        docs: {
          totalVectors: docsCount,
          byPod: Object.fromEntries(docsByPod),
        },
        tables: lanceStats,
        // Which slot the per-project numbers came from. When `building` is
        // true the rows reflect the in-progress shadow rebuild, not what
        // semantic search currently serves (`activeTable`/`activeVectors`).
        shadow: {
          building: shadowBuilding,
          table: shadowSlot ?? pendingSlot,
          activeVectors: totalVectors,
          vectors: shadowBuilding
            ? Array.from(vectorsByProject.values()).reduce((a: number, b: number) => a + b, 0)
            : totalVectors,
          // WHICH TABLE THE HEADLINE WAS COUNTED FROM. Without this the same
          // endpoint answers "how many vectors?" from `code_vectors` or from
          // `code_vectors_b` depending on an in-process flag that a restart
          // clears, and the operator sees coverage fall from 100% to 70% with
          // nothing said about why. `rowsOnDisk` is the proof that goes with
          // it: vectors across BOTH slots, which does not move when the
          // displayed figure changes table. See coverageSource.ts.
          ...coverage,
          // An un-promoted rebuild sitting in the inactive slot. Present
          // whenever a run was stopped or interrupted before promotion.
          pending: pendingSlot ? { table: pendingSlot, rows: pendingRows } : null,
          // The paused job that banked it, so the banner can say
          // "paused at 324/340" instead of implying the work is gone. The
          // per-project count for a confirm dialog comes from
          // GET /vectors/shadow — computing it here would mean a column scan
          // on every 10 s dashboard poll.
          job: pausedJob ? {
            id: pausedJob.id,
            status: pausedJob.status,
            doneProjects: pausedJob.doneProjects,
            totalProjects: pausedJob.totalProjects,
            startedAt: pausedJob.startedAt,
          } : null,
          canResume: !!pendingSlot && !activeJob,
          canDiscard: !!pendingSlot && !activeJob,
          canPromoteAnyway: !!pendingSlot && !activeJob && pendingRows > 0,
        },
        // Real fan-out split across local and cloud providers.
        fanout: fleetSplit,
      };
      // ETag: the payload is ~200 KB and polled every 30s; over NetBird that is
      // real bandwidth for a list that rarely changes. Weak tag over the body,
      // `no-cache` so browsers revalidate (If-None-Match) instead of re-downloading.
      const { createHash } = await import('crypto');
      const json = JSON.stringify(payload);
      const etag = `W/"${createHash('sha1').update(json).digest('hex').slice(0, 24)}"`;
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'no-cache');
      if (req.headers['if-none-match'] === etag) {
        res.status(304).end();
        return;
      }
      res.type('application/json').send(json);
    } catch (error) {
      console.error('[Admin] Vector stats error:', error);
      const message = error instanceof Error ? error.message : 'Failed to get vector stats';
      res.status(500).json({ error: message });
    }
  });

  /**
   * POST /admin/vectors/generate/:projectId
   * Generate embeddings for all nodes in a project
   * Works with both code_nodes table (tree-sitter) AND FantomCodeIndexer (regex)
   */
  router.post('/vectors/generate/:projectId', async (req: Request, res: Response): Promise<void> => {
    try {
      const projectId = parseInt(req.params.projectId as string, 10);
      const { batchSize = 50 } = req.body;

      const { getPrismaClient } = await import('../db/prisma.js');
      const { selectEmbeddingProvider } = await import('../embedding/providers/embeddingProvider.js');
      const { getVectorStore } = await import('../embedding/vectorStore.js');

      const prisma = getPrismaClient();
      const embeddingService = selectEmbeddingProvider('code');
      const vectorStore = getVectorStore(prisma);

      // Initialize embedding service (no-op for sidecar provider)
      await embeddingService.initialize();

      // Get all project nodes from Ladybug.
      let allNodes = await ladybugQuery<{ id: string; name: string; qualifiedName: string; signature: string | null; documentation: string | null; nodeType: string }>(
        projectId,
        `MATCH (n:CodeNode) WHERE n.project_id = ${projectId} RETURN n.id AS id, n.name AS name, n.qualified_name AS qualifiedName, n.signature AS signature, n.documentation AS documentation, n.node_type AS nodeType`
      );

      // If the Ladybug graph has no nodes yet, sync them from the in-memory
      // FantomCodeIndexer via Ladybug's batch helper (no Prisma write path).
      if (allNodes.length === 0) {
        const indexer = getFantomCodeIndexer();
        const indexerFunctions = indexer.getAllFunctions().filter(f => f.projectId === projectId);
        const indexerTypes = indexer.getAllTypes().filter(t => t.projectId === projectId);

        if (indexerFunctions.length > 0 || indexerTypes.length > 0) {
          const { createNodesFromBatch: createN } = await import('../graph/ladybugGraphBuilder.js');
          const nodeInputs = [
            ...indexerFunctions.map(func => ({
              id: func.id,
              name: func.name,
              qualifiedName: func.qualifiedName,
              nodeType: func.type || 'method',
              signature: func.signature || null,
              documentation: func.documentation || null,
              filePath: func.filePath,
              lineStart: func.lineNumber || 0,
              lineEnd: (func.lineNumber || 0) + 10,
              projectId: func.projectId,
              language: 'fantom',
            })),
            ...indexerTypes.map(type => ({
              id: type.id,
              name: type.name,
              qualifiedName: type.qualifiedName,
              nodeType: type.kind || 'class',
              signature: null,
              documentation: type.documentation || null,
              filePath: type.filePath,
              lineStart: type.lineNumber || 0,
              lineEnd: (type.lineNumber || 0) + 50,
              projectId: type.projectId,
              language: 'fantom',
            })),
          ];
          await createN(nodeInputs);

          // Re-fetch after the sync write.
          allNodes = await ladybugQuery<{ id: string; name: string; qualifiedName: string; signature: string | null; documentation: string | null; nodeType: string }>(
            projectId,
            `MATCH (n:CodeNode) WHERE n.project_id = ${projectId} RETURN n.id AS id, n.name AS name, n.qualified_name AS qualifiedName, n.signature AS signature, n.documentation AS documentation, n.node_type AS nodeType`
          );
        }
      }

      // Filter out nodes that already have vectors in LanceDB
      const existingVectorNodeIds = await vectorStore.getNodeIdsForProject(projectId);
      const nodes = allNodes.filter(n => !existingVectorNodeIds.has(n.id));

      if (nodes.length === 0) {
        const existingVectors = await vectorStore.count(projectId);

        res.json({
          success: true,
          projectId,
          message: allNodes.length === 0 ? 'Project has no nodes in database' : 'All nodes already have embeddings',
          totalNodes: allNodes.length,
          existingVectors,
          generated: 0
        });
        return;
      }

      // Generate embeddings in batches
      let generated = 0;
      const errors: Array<{ nodeId: string; error: string }> = [];

      for (let i = 0; i < nodes.length; i += batchSize) {
        const batch = nodes.slice(i, i + batchSize);
        const embeddings: Array<{ nodeId: string; embedding: Float32Array }> = [];

        for (const node of batch) {
          try {
            const text = [
              node.name,
              node.qualifiedName,
              node.signature || '',
              node.documentation || ''
            ].filter(Boolean).join(' ');

            const embedding = await embeddingService.embed(text);
            embeddings.push({ nodeId: node.id, embedding });
          } catch (err) {
            errors.push({
              nodeId: node.id,
              error: err instanceof Error ? err.message : String(err)
            });
          }
        }

        if (embeddings.length > 0) {
          await vectorStore.storeEmbeddings(embeddings, projectId);
          generated += embeddings.length;
        }
      }

      res.json({
        success: true,
        projectId,
        totalNodes: nodes.length,
        generated,
        errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
        errorCount: errors.length
      });
    } catch (error) {
      console.error('[Admin] Vector generation error:', error);
      const message = error instanceof Error ? error.message : 'Failed to generate vectors';
      res.status(500).json({ error: message });
    }
  });

  /**
   * GET /admin/vectors/model-status
   * Check if stored vectors match the currently configured embedding model
   */
  router.get('/vectors/model-status', async (_req: Request, res: Response): Promise<void> => {
    try {
      const { getLanceTableStats } = await import('../embedding/lanceConnection.js');
      const { selectEmbeddingProvider } = await import('../embedding/providers/embeddingProvider.js');

      const stats = await getLanceTableStats();

      // ── What the configured model IS, without resolving a provider ──────
      //
      // This used to call selectEmbeddingProvider for both targets purely to
      // read a model name and a width. That resolves a LOCAL provider and
      // throws under strict-sidecar mode when no local sidecar advertises the
      // model — the permanent state under "OpenRouter only". So this endpoint
      // 500'd on every poll, and it is one the dashboard calls on load: the
      // page looked broken while the server was healthy.
      //
      // Same ordering bug as the re-embed job and buildProjectEmbeddings had.
      // Under a cloud-only policy the answer comes from the configured cloud
      // model instead, and no local provider is constructed at all.
      const { embeddingRoutingPolicy, tableDimsFor } =
        await import('../embedding/providers/embeddingProvider.js');
      const { getOpenRouterSettings } = await import('../sidecars/openRouterConfig.js');
      const { findModel } = await import('../sidecars/openRouterModels.js');

      type Configured = { getModelName: () => string; getDimensions: () => number };
      const configuredFor = async (target: 'code' | 'docs'): Promise<Configured> => {
        let cloudOnly = false;
        try { cloudOnly = !(await embeddingRoutingPolicy(target)).localServes; } catch { /* local, as before */ }
        if (!cloudOnly) return selectEmbeddingProvider(target);
        const role = target === 'code' ? 'code-embedding' : 'embedding';
        const cfg = getOpenRouterSettings().allowedModels[role];
        const name = cfg?.model ?? '(no cloud model configured)';
        const dims = findModel(cfg?.model ?? '')?.dims ?? cfg?.dims ?? tableDimsFor(target);
        return { getModelName: () => name, getDimensions: () => dims };
      };

      const codeService = await configuredFor('code');
      const docsService = await configuredFor('docs');

      // Mismatch fires on EITHER model-name OR dimension divergence.
      // Earlier we only checked names — that missed the case where
      // both sides report `qwen3-embedding:0.6b` but the table column
      // is locked at 384d from a previous bge-small write, causing
      // queries to fail with "no vector column matches dimension 1024".
      const codeMismatch = stats.code.rows > 0
        ? (
            (!!stats.code.model && stats.code.model !== codeService.getModelName())
            || (!!stats.code.dimensions && stats.code.dimensions !== codeService.getDimensions())
          )
        : false;

      const docsMismatch = stats.docs.rows > 0
        ? (
            (!!stats.docs.model && stats.docs.model !== docsService.getModelName())
            || (!!stats.docs.dimensions && stats.docs.dimensions !== docsService.getDimensions())
          )
        : false;

      // Text-layout version (EMBED_TEXT_VERSION): which indexed projects still
      // hold vectors built from an older embedding text. Recorded per project
      // on every vector write; projects indexed before tracking are 'unknown'.
      let textVersion: import('../embedding/embedTextVersions.js').EmbedTextVersionStatus | null = null;
      try {
        const { getEmbedTextVersionStatus } = await import('../embedding/embedTextVersions.js');
        const { getPrismaClient } = await import('../db/prisma.js');
        const indexed = await getPrismaClient().fantomProject.findMany({ where: { lastIndexed: { not: null } }, select: { id: true } });
        textVersion = getEmbedTextVersionStatus(indexed.map(p => p.id));
      } catch { /* status is best-effort */ }

      res.json({
        code: {
          configuredModel: codeService.getModelName(),
          configuredDimensions: codeService.getDimensions(),
          storedModel: stats.code.model || null,
          storedDimensions: stats.code.dimensions || null,
          storedRows: stats.code.rows,
          mismatch: codeMismatch,
          textVersion,
        },
        docs: {
          configuredModel: docsService.getModelName(),
          configuredDimensions: docsService.getDimensions(),
          storedModel: stats.docs.model || null,
          storedDimensions: stats.docs.dimensions || null,
          storedRows: stats.docs.rows,
          mismatch: docsMismatch,
        },
      });
    } catch (error) {
      console.error('[Admin] Model status error:', error);
      const message = error instanceof Error ? error.message : 'Failed to get model status';
      res.status(500).json({ error: message });
    }
  });

  /**
   * POST /admin/vectors/re-embed/:projectId
   * Drop all vectors for a project and regenerate with current model.
   * Use projectId=0 to re-embed ALL projects.
   */
  router.post('/vectors/re-embed/:projectId', async (req: Request, res: Response, next): Promise<void> => {
    // Defer to more specific handlers (e.g. /vectors/re-embed/start) when the
    // path segment isn't a numeric projectId.
    if (!/^-?\d+$/.test(String(req.params.projectId))) { next(); return; }
    // Heavy-job lock: refuse while a full re-embed / forced reindex / Axon
    // index owns the sidecar fleet (2026-09-14: a build-missing job launched
    // beside the v3 shadow rebuild raced through 235 projects, each aborting).
    {
      const { getHeavyJob } = await import('../embedding/embedGate.js');
      const heavy = getHeavyJob();
      if (heavy) {
        res.status(409).json({ error: `Another heavy job is running: ${heavy.kind} (${heavy.label}) since ${heavy.since}`, heavyJob: heavy });
        return;
      }
    }
    try {
      const projectId = parseInt(req.params.projectId as string, 10);
      const { batchSize = 50 } = req.body;

      const { getPrismaClient } = await import('../db/prisma.js');
      const { selectEmbeddingProvider } = await import('../embedding/providers/embeddingProvider.js');
      const { getVectorStore, resetVectorStore } = await import('../embedding/vectorStore.js');
      const { getLanceTableStats, dropCodeVectorsTable } = await import('../embedding/lanceConnection.js');

      const prisma = getPrismaClient();
      const embeddingService = selectEmbeddingProvider('code');
      await embeddingService.initialize();

      // Dimension safety: if the configured model produces vectors of a
      // different dimension than what's stored, drop the table outright
      // (LanceDB locks dim per column, so we can't just delete rows).
      const newDims = embeddingService.getDimensions();
      const stats = await getLanceTableStats();
      const storedDims = stats.code.dimensions ?? null;
      let droppedForDimChange = false;
      if (storedDims && storedDims !== newDims) {
        await dropCodeVectorsTable();
        if (typeof resetVectorStore === 'function') resetVectorStore();
        droppedForDimChange = true;
      }

      const vectorStore = getVectorStore(prisma);

      // Determine which projects to re-embed
      const projectIds: number[] = [];
      if (projectId === 0) {
        const projects = await prisma.fantomProject.findMany({ select: { id: true } });
        projectIds.push(...projects.map(p => p.id));
      } else {
        projectIds.push(projectId);
      }

      let totalDeleted = 0;
      let totalGenerated = 0;
      let totalErrors = 0;

      for (const pid of projectIds) {
        // Delete all existing vectors for this project
        const deleted = await vectorStore.deleteProjectVectors(pid);
        totalDeleted += deleted;

        // Get all project nodes from Ladybug (incl. file_path + line range so
        // the embedding text can include the source body — see embeddingText.ts).
        const { buildEmbeddingItems } = await import('../embedding/embeddingText.js');
        const { buildEmbeddingContext } = await import('../embedding/embeddingContext.js');
        const { buildSyntheticItems } = await import('../embedding/embedSynthetic.js');
        const allNodes = await ladybugQuery<{ id: string; name: string; qualifiedName: string; signature: string | null; documentation: string | null; nodeType: string; filePath: string | null; lineStart: number | null; lineEnd: number | null }>(
          pid,
          `MATCH (n:CodeNode) WHERE n.project_id = ${pid} RETURN n.id AS id, n.name AS name, n.qualified_name AS qualifiedName, n.signature AS signature, n.documentation AS documentation, n.node_type AS nodeType, n.file_path AS filePath, n.line_start AS lineStart, n.line_end AS lineEnd`
        );
        // v3: context pre-pass (paged, per project) → chunk items → file/project rows.
        const context = await buildEmbeddingContext(pid, allNodes);
        const workItems = [
          ...buildEmbeddingItems(allNodes, context),
          ...await buildSyntheticItems(prisma, pid, allNodes).catch(() => []),
        ];

        // Generate embeddings in batches
        for (let i = 0; i < workItems.length; i += batchSize) {
          const batch = workItems.slice(i, i + batchSize);
          const embeddings: import('../embedding/vectorStore.js').StoreEmbeddingItem[] = [];

          for (const item of batch) {
            try {
              const embedding = await embeddingService.embed(item.text);
              embeddings.push({ ...item, embedding });
            } catch {
              totalErrors++;
            }
          }

          if (embeddings.length > 0) {
            await vectorStore.storeEmbeddings(embeddings, pid);
            totalGenerated += embeddings.length;
          }
        }
      }

      res.json({
        success: true,
        projects: projectIds.length,
        deleted: totalDeleted,
        generated: totalGenerated,
        errors: totalErrors,
        model: embeddingService.getModelName(),
        dimensions: embeddingService.getDimensions(),
        droppedTableForDimChange: droppedForDimChange,
        previousDimensions: storedDims,
      });
    } catch (error) {
      console.error('[Admin] Re-embed error:', error);
      const message = error instanceof Error ? error.message : 'Failed to re-embed vectors';
      res.status(500).json({ error: message });
    }
  });

  // ─── Async re-embed jobs ──────────────────────────────────────────────
  router.post('/vectors/re-embed/start', async (req: Request, res: Response): Promise<void> => {
    const projectIdRaw = req.body?.projectId;
    const projectId = typeof projectIdRaw === 'number' ? projectIdRaw : Number(projectIdRaw);
    const batchSize = Number(req.body?.batchSize ?? 50);
    const { createJob, updateJob, getJob, appendError, findActiveJob, findPausedJob } = await import('./reembedJobs.js');
    // Concurrency guard: only ONE re-embed job at a time. Repeated dashboard
    // clicks otherwise stack jobs that race on the same LanceDB table (delete +
    // re-embed the same projects) and split the single embedding GPU between
    // them — the chaotic-state + slowness we hit. Return the in-flight job.
    // A `paused` job does NOT occupy the slot: resuming is how it is cleared.
    const inFlight = findActiveJob();
    if (inFlight) {
      res.status(409).json({ error: 'A re-embed job is already running; pause or discard it before starting another.', jobId: inFlight.id, scope: inFlight.scope });
      return;
    }

    // A fresh full rebuild DROPS the inactive slot before rebuilding into it
    // (openShadowCodeTable with resume=false). With a pause banked there, that
    // destroys the banked vectors — and this is the endpoint the dashboard's
    // "Re-embed all" button calls. So a start that would destroy banked work
    // is refused unless the caller either resumes into it or confirms the
    // destruction with its cost in front of them. Same contract as
    // /vectors/shadow/discard.
    const isFullStart = projectId === 0 || !Number.isFinite(projectId);
    if (isFullStart && req.body?.resume !== true && req.body?.live !== true && req.body?.confirm !== true) {
      const { getPendingShadowCodeTable } = await import('../embedding/lanceConnection.js');
      const pending = await getPendingShadowCodeTable();
      if (pending) {
        res.status(409).json({
          error: 'A paused or partial rebuild is banked in the inactive slot. Starting a fresh full re-embed '
            + 'destroys it. Resume with {"resume":true} to continue that work instead, or re-send with '
            + '{"confirm":true} to discard it and start over.',
          wouldDestroy: { vectors: pending.rows, projects: pending.projects, table: pending.name },
        });
        return;
      }
    }
    // Heavy-job lock: a code re-embed never overlaps a forced code reindex or an
    // Axon index job (two of these tripped the 4 GB RSS guard). 409 + holder.
    const { acquireHeavyJob, HeavyJobBusyError } = await import('../embedding/embedGate.js');
    let releaseHeavy: (() => void) | null = null;
    try {
      releaseHeavy = acquireHeavyJob('code-reembed', projectId === 0 || !Number.isFinite(projectId) ? 'full' : `project ${projectId}`);
    } catch (e) {
      if (e instanceof HeavyJobBusyError) {
        res.status(409).json({ error: `Another heavy job is running: ${e.holder.kind} (${e.holder.label}) since ${e.holder.since}. Wait for it to finish.`, heavyJob: e.holder });
        return;
      }
      throw e;
    }
    // A resume supersedes the paused job it continues, so the UI stops
    // offering Resume against a slot this run now owns.
    const pausedJob = findPausedJob();
    if (req.body?.resume === true && pausedJob) {
      updateJob(pausedJob.id, { status: 'done', finishedAt: new Date().toISOString() });
    }
    const job = createJob(isFullStart ? 'all' : { projectId });

    // Kick off the loop on next tick — return jobId immediately.
    queueMicrotask(async () => {
      const { setShadowReembedActive } = await import('../embedding/embedGate.js');
      const isAll = job.scope === 'all';
      let shadowName: string | null = null;
      let promoted = false;
      // Set only when finalizeHalt has already DISCARDED the slot, so the
      // finally block does not advertise a table that no longer exists. A
      // pause deliberately leaves this false: its "kept … resume:true" line is
      // exactly the right thing to print.
      let shadowSettled = false;
      let writeTable: import('@lancedb/lancedb').Table | undefined;
      // Appends to the write slot since the last compaction — NOT rows and NOT
      // projects, both of which stall exactly when compaction matters. Shared
      // by every worker; whichever one crosses the threshold takes the write
      // slot, which is safe because compactCodeTable enqueues on the same
      // serialized chain as the appends.
      let appendsSinceCompaction = 0;
      try {
        updateJob(job.id, { status: 'running' });
        const { getPrismaClient } = await import('../db/prisma.js');
        const { selectEmbeddingProvider, selectAllEmbeddingProvidersWithCloud, embedPipelineSettings, embeddingRoutingPolicy } = await import('../embedding/providers/embeddingProvider.js');
        // Read once for the whole job: whether the GPUs may write rows at all.
        // False only under "OpenRouter only", where every local fallback below
        // has to be closed or the rebuild silently mixes vector spaces.
        let localMayServeCorpus = true;
        try { localMayServeCorpus = (await embeddingRoutingPolicy('code')).localServes; } catch { /* assume yes, as before */ }
        const { embedTextsPipelined } = await import('../embedding/providers/embedScheduler.js');
        const { getVectorStore, resetVectorStore } = await import('../embedding/vectorStore.js');
        const { getLanceTableStats, dropCodeVectorsTable, openShadowCodeTable, promoteCodeTable, compactCodeTable } = await import('../embedding/lanceConnection.js');

        const prisma = getPrismaClient();
        // ── The corpus model, without resolving a provider we may not use ──
        //
        // This used to be `selectEmbeddingProvider('code')` unconditionally,
        // purely to read its dimensions and model name. That call resolves a
        // LOCAL provider and THROWS under strict-sidecar mode when no local
        // sidecar advertises the model — which is the permanent state under
        // "OpenRouter only", where the GPUs are excluded on purpose. So a
        // cloud rebuild died here, before it had even counted the projects,
        // with a message about a sidecar that was never going to arrive.
        //
        // Under cloud-only the model and width come from the configured cloud
        // model instead, and no local provider is constructed at all.
        let embeddingService: import('../embedding/providers/embeddingProvider.js').EmbeddingProvider | null = null;
        let corpusModel: string;
        let newDims: number;
        if (localMayServeCorpus) {
          embeddingService = selectEmbeddingProvider('code');
          await embeddingService.initialize();
          corpusModel = embeddingService.getModelName();
          newDims = embeddingService.getDimensions();
        } else {
          const { getOpenRouterSettings } = await import('../sidecars/openRouterConfig.js');
          const { findModel } = await import('../sidecars/openRouterModels.js');
          const cfgd = getOpenRouterSettings().allowedModels['code-embedding'];
          const dims = findModel(cfgd?.model ?? '')?.dims ?? cfgd?.dims;
          if (!cfgd?.model || !dims) {
            throw new Error(
              '[openrouter-only] code embedding is on "OpenRouter only" but no cloud model with a known '
              + 'width is configured — pick one under Model Selection on the config page before rebuilding.',
            );
          }
          corpusModel = cfgd.model;
          newDims = dims;
          console.log(`[reembed-job] "OpenRouter only": corpus model ${corpusModel} at ${newDims}d (GPUs excluded)`);
        }
        const stats = await getLanceTableStats();
        const storedDims = stats.code.dimensions ?? null;
        // SHADOW-SWAP for a full re-embed (scope 'all'): build into the INACTIVE
        // code slot, leaving the live table serving readers untouched for the
        // whole rebuild; flip atomically only on validated success (below). Gate
        // the auto-embed watchdog so it doesn't fight for the GPU or write
        // soon-discarded vectors into the live slot. A single-project re-embed
        // writes the live slot (delete-that-project then rebuild); a dim change
        // there still needs the unavoidable whole-table drop (LanceDB locks dim).
        // `live: true` on a full run writes straight into the ACTIVE slot (no
        // shadow, no promote): for a rebuild after the old vectors are already
        // gone or unusable (model changed), search improves as rows land
        // instead of only at the end. Requires the active slot to be at the new
        // dims (it is recreated empty when the dims differ).
        const liveAll = isAll && req.body?.live === true;
        // { resume: true } — reuse a shadow left behind by an interrupted run
        // (restart/deploy) and skip the projects already embedded into it.
        const wantResume = isAll && !liveAll && req.body?.resume === true;
        let resumedShadow = false;
        if (isAll && !liveAll) {
          setShadowReembedActive(true);
          const shadow = await openShadowCodeTable(wantResume);
          writeTable = shadow.table;
          shadowName = shadow.name;
          resumedShadow = shadow.resumed;
          updateJob(job.id, { resumed: shadow.resumed, shadowTable: shadow.name });
        } else if (liveAll) {
          setShadowReembedActive(true); // keep the watchdog out of the way
          if (storedDims && storedDims !== newDims) {
            await dropCodeVectorsTable();
            if (typeof resetVectorStore === 'function') resetVectorStore();
          }
          console.log(`[reembed-job] LIVE full rebuild into the active slot at ${newDims}d (no shadow)`);
        } else if (storedDims && storedDims !== newDims) {
          await dropCodeVectorsTable();
          if (typeof resetVectorStore === 'function') resetVectorStore();
        }
        updateJob(job.id, {
          model: corpusModel,
          dimensions: newDims,
          droppedTableForDimChange: isAll,
          previousDimensions: storedDims,
        });

        const vectorStore = getVectorStore(prisma);
        const projectIds: number[] = [];
        if (isAll) {
          const projects = await prisma.fantomProject.findMany({ select: { id: true } });
          projectIds.push(...projects.map(p => p.id));
        } else {
          projectIds.push((job.scope as { projectId: number }).projectId);
        }
        updateJob(job.id, { totalProjects: projectIds.length });

        // On resume, work out what the surviving shadow already covers. A
        // project whose shadow rows already reach its graph node count is
        // skipped; a partially-written one has its rows cleared first so the
        // rebuild cannot leave duplicates behind.
        let resumeCounts: Map<number, number> | null = null;
        let resumeNodes: Map<number, number> | null = null;
        if (resumedShadow && shadowName) {
          try {
            const { getProjectNodeCounts } = await import('../graph/projectNodeCounts.js');
            resumeCounts = await vectorStore.countByProject(shadowName);
            resumeNodes = await getProjectNodeCounts(projectIds);
            const complete = projectIds.filter(id =>
              (resumeNodes!.get(id) ?? 0) > 0 && (resumeCounts!.get(id) ?? 0) >= (resumeNodes!.get(id) ?? 0)).length;
            console.log(`[reembed-job] resuming: ${complete}/${projectIds.length} projects already complete in shadow '${shadowName}'`);
            // A resumed slot carries every fragment the interrupted run left
            // behind; compact before writing or the first appends pay for all
            // of them.
            if (writeTable) await compactCodeTable(writeTable, shadowName);
          } catch (e) {
            console.warn(`[reembed-job] resume survey failed, embedding everything: ${(e as Error).message}`);
            resumeCounts = null;
            resumeNodes = null;
          }
        }

        // ── Project-level work queue ───────────────────────────────────────
        // Projects are the unit of assignment: workers pull from one shared
        // queue, so several are in flight and the fleet stops idling on each
        // project's graph-context pre-pass. `queue.claim()` is the atomic
        // claim — see shadowRebuild.ts. Everything inside runProject is main's
        // existing per-project body, unchanged apart from `continue`/`return`
        // becoming per-project control flow and the halt vocabulary.
        const {
          createProjectQueue, haltRequested, finalizeHalt, decidePromotion,
          resolveMaxConcurrentProjects,
        } = await import('./shadowRebuild.js');
        const { runWithCloudBudgetProject, refreshCloudBudgetFromKey } =
          await import('../embedding/providers/cloudBudget.js');
        // Read the key's real limit once at the top of a rebuild. It never
        // throws: a failed probe leaves the conservative default in place,
        // which is the safe direction. A manual override on the admin page
        // still wins over whatever comes back.
        await refreshCloudBudgetFromKey(true).catch(() => undefined);
        const queue = createProjectQueue(projectIds);
        let halted: 'paused' | 'cancelled' | null = null;

        const runProject = async (pid: number): Promise<void> => {
          let servedTexts = 0;
          let storedVectors = 0;
          const halt = haltRequested(job.id);
          if (halt) { halted = halt; return; }
          updateJob(job.id, { currentProjectId: pid });

          // RESUME: skip a project the surviving shadow already covers, and
          // clear a half-written one so it is rebuilt cleanly.
          if (resumeCounts && resumeNodes) {
            const have = resumeCounts.get(pid) ?? 0;
            const want = resumeNodes.get(pid) ?? 0;
            if (want > 0 && have >= want) {
              const c0 = getJob(job.id);
              updateJob(job.id, {
                doneProjects: (c0?.doneProjects ?? 0) + 1,
                generated: (c0?.generated ?? 0) + have,
              });
              return;
            }
            if (have > 0 && writeTable) {
              try {
                // Through the write queue: a delete is a manifest commit like
                // an append, and this now runs from N concurrent workers.
                await vectorStore.deleteProjectVectors(pid, writeTable);
                console.log(`[reembed-job] project=${pid} resume: cleared ${have} partial row(s)`);
              } catch (e) {
                appendError(job.id, { projectId: pid, message: `resume cleanup failed: ${(e as Error).message}` });
              }
            }
          }

          // Re-pick the provider per project: a sidecar that faulted (model not
          // pulled yet, embeddings refused) is skipped, and one that recovered
          // (fault expired, new heartbeat) is used again. Same dims required.
          // Fan out across every usable sidecar that serves the configured model
          // (chunks in parallel, per-chunk failover) — one Mac alone measured
          // 33 s per 50-node batch for qwen3-embedding:4b.
          let fanout: import('../embedding/providers/embeddingProvider.js').EmbeddingProvider[] = [];
          const served = new Map<string, number>();
          try {
            // Only re-select a LOCAL provider when local may serve at all.
            // Under "OpenRouter only" this is the same throw as above, one
            // project deeper, and there is nothing it could usefully return.
            if (localMayServeCorpus) {
              const next = selectEmbeddingProvider('code');
              if (next.getDimensions() === newDims) {
                await next.initialize();
                embeddingService = next;
              }
            }
            // Local GPU providers AND every VERIFIED OpenRouter-backed one,
            // as peers — embedding is not local-first, each earns its share
            // by measured throughput in the pipelined scheduler. A cloud
            // provider that has not passed the vector-compatibility gate is
            // excluded by the selector, never merely deprioritised; the dims
            // filter below is a second guard on the same invariant.
            fanout = (await selectAllEmbeddingProvidersWithCloud('code', corpusModel))
              .filter(p => p.getDimensions() === newDims);
            // `embeddingService` is always a LOCAL provider — the single-pick
            // selector never constructs a cloud one. Under "OpenRouter only"
            // that makes this line the last silent local fallback on the
            // corpus path, so it is gated on the policy rather than on the
            // pool being empty. The selector has already thrown in that case;
            // this is the belt to its braces.
            if (fanout.length === 0 && localMayServeCorpus && embeddingService) fanout = [embeddingService];
          } catch (e) {
            appendError(job.id, { projectId: pid, message: `provider re-select failed: ${(e as Error).message}` });
            if (!localMayServeCorpus || !embeddingService) throw e;
            fanout = [embeddingService];
          }
          if (fanout.length === 0) {
            throw new Error(
              '[openrouter-only] no OpenRouter-backed provider is cleared to embed, and the GPUs are '
              + 'excluded by the "OpenRouter only" routing policy — refusing to rebuild this project on '
              + 'local vectors that the cloud query encoder would no longer match.',
            );
          }
          const credit = (p: unknown, n: number): void => {
            const name = (p as { getSidecarName?: () => string }).getSidecarName?.() ?? 'in-process';
            served.set(name, (served.get(name) ?? 0) + n);
          };
          try {
            // Single-project re-embed deletes that project's live vectors first.
            // The shadow ('all') is a fresh empty table — nothing to delete.
            if (!isAll) {
              const deleted = await vectorStore.deleteProjectVectors(pid);
              const cur = getJob(job.id);
              updateJob(job.id, { deleted: (cur?.deleted ?? 0) + deleted });
            }
            const { buildEmbeddingItems } = await import('../embedding/embeddingText.js');
            const { buildEmbeddingContext } = await import('../embedding/embeddingContext.js');
            const { buildSyntheticItems } = await import('../embedding/embedSynthetic.js');
            const allNodes = await ladybugQuery<{ id: string; name: string; qualifiedName: string; signature: string | null; documentation: string | null; nodeType: string; filePath: string | null; lineStart: number | null; lineEnd: number | null }>(
              pid,
              `MATCH (n:CodeNode) WHERE n.project_id = ${pid} RETURN n.id AS id, n.name AS name, n.qualified_name AS qualifiedName, n.signature AS signature, n.documentation AS documentation, n.node_type AS nodeType, n.file_path AS filePath, n.line_start AS lineStart, n.line_end AS lineEnd`,
            );
            // v3 (EMBED_TEXT_VERSION 3): graph-context pre-pass once per project,
            // chunk expansion (long symbols → several rows), plus one `kind: file`
            // row per file and one `kind: project` row. This is the path that
            // builds a FRESH table (shadow), so the v3 columns are present here.
            const context = await buildEmbeddingContext(pid, allNodes);
            const workItems = [
              ...buildEmbeddingItems(allNodes, context),
              ...await buildSyntheticItems(prisma, pid, allNodes).catch(() => []),
            ];
            // PIPELINED embed: the whole project's texts go to one scheduler in
            // which every sidecar pulls chunks sized to its own measured speed
            // and the fast GPU host keeps several requests in flight. The old
            // lock-step fan-out (split each 50-text batch, Promise.all) made
            // every batch wait for the slowest Mac — measured ~10 texts/s on a
            // fleet that can do ~15+. Vectors are stored per completed chunk,
            // overlapped with the requests still in flight. `batchSize` caps
            // the chunk a single request may carry.
            // Per-project write buffer. Each concurrent worker owns its own,
            // so flushes stay independent; the serialized write queue still
            // orders the appends themselves.
            type PendingSlice = { rows: Array<Record<string, unknown>>; provider: unknown };
            let pending: PendingSlice[] = [];
            let pendingRows = 0;
            const flushPending = async (): Promise<void> => {
              if (pending.length === 0) return;
              const batch = pending;
              pending = [];
              pendingRows = 0;
              // Group by producing provider so each row's model/dimensions stay
              // honest when one flush spans several of them. In practice a
              // flush is usually a single group.
              const byProvider = new Map<unknown, Array<Record<string, unknown>>>();
              for (const slice of batch) {
                const cur = byProvider.get(slice.provider);
                if (cur) cur.push(...slice.rows); else byProvider.set(slice.provider, [...slice.rows]);
              }
              let wrote = 0;
              for (const [provider, rows] of byProvider) {
                await vectorStore.storeEmbeddings(rows as never, pid, writeTable, provider as never);
                storedVectors += rows.length;
                wrote += rows.length;
                appendsSinceCompaction++;
              }
              const c = getJob(job.id);
              updateJob(job.id, { generated: (c?.generated ?? 0) + wrote });
              if (appendsSinceCompaction >= COMPACT_EVERY_APPENDS) {
                appendsSinceCompaction = 0;
                if (writeTable) await compactCodeTable(writeTable, shadowName ?? 'code');
              }
            };

            const pipeline = embedPipelineSettings();
            const texts = workItems.map(it => it.text);
            const run = await embedTextsPipelined(fanout, texts, {
              depth: pipeline.depth,
              targetChunkMs: pipeline.targetChunkMs,
              maxChunk: Math.max(8, batchSize),
              // Both halts stop dispatching; which one it was decides whether
              // the shadow survives, and that is settled after the pool drains.
              shouldCancel: () => haltRequested(job.id) !== null,
              onServed: credit,
              onChunk: async (indices, vecs, provider) => {
                const embeddings = indices
                  .map((idx, j) => ({ ...workItems[idx], embedding: vecs[j] }))
                  .filter((x) => x.embedding);
                servedTexts += indices.length;
                if (embeddings.length === 0) return;
                // Pass the provider that actually produced this chunk. Without
                // it the store falls back to the single-pick LOCAL selector
                // just to label the row, which throws under "OpenRouter only"
                // and loses a chunk that had already been embedded and paid
                // for. It is also the truthful attribution.
                // BUFFER, don't append. Every LanceDB append writes a fragment
                // and rewrites a manifest proportional to the fragment list, so
                // appending per chunk makes each write cost O(fragments) and
                // the run quadratic. That is the measured collapse: 130 rows/s
                // at ~1,000 fragments, 24 at 2,300, 1.5 at 2,400 — with the
                // OpenRouter pool idle the whole time.
                //
                // A chunk is sized for ~3s of EMBEDDING latency (~85 rows),
                // which is the right unit for a request and three orders of
                // magnitude off the right unit for a write: Lance targets 1M
                // rows per fragment. Buffering turns hundreds of appends per
                // large project into two or three.
                pending.push({ rows: embeddings, provider });
                pendingRows += embeddings.length;
                if (pendingRows >= STORE_FLUSH_ROWS) await flushPending();
              },
              log: (m) => console.log(`[reembed-job] project=${pid} ${m}`),
            });
            // The tail belongs to this project and must land before it is
            // marked done: resume decides what to redo by comparing stored rows
            // to node counts, so an unflushed remainder reads as incomplete and
            // gets embedded a second time.
            await flushPending();
            for (const message of run.errors.slice(0, 5)) appendError(job.id, { projectId: pid, message });
            if (run.failed > 0) appendError(job.id, { projectId: pid, message: `${run.failed} text(s) failed on every provider` });
            if (run.cancelled) {
              halted = haltRequested(job.id) ?? 'paused';
              return;
            }
          } catch (err) {
            appendError(job.id, { projectId: pid, message: (err as Error).message });
          }
          // Attribution for the dashboard: `served` (credited per chunk by the
          // scheduler) says which sidecar produced how many vectors; the top
          // one is the project's sidecar. Recording it here keeps
          // projectEmbeddingMeta.json from showing a stale (pre-failover) host.
          if (storedVectors > 0) {
            try {
              const { recordProjectEmbedding } = await import('../embedding/projectEmbeddingMeta.js');
              const svc = embeddingService as ({ getSidecarName?: () => string; getModelName: () => string } | null);
              const selectedName = svc && typeof svc.getSidecarName === 'function' ? svc.getSidecarName() : null;
              const servedBy = Array.from(served.entries()).map(([name, texts]) => ({ name, texts })).sort((a, b) => b.texts - a.texts);
              const topName = servedBy[0]?.name ?? selectedName;
              let host: string | null = null;
              try {
                const { listSidecars } = await import('../sidecars/registry.js');
                const sc = listSidecars().find(s => s.name === topName);
                if (sc) host = `${sc.host}:${sc.port}`;
              } catch { /* best effort */ }
              recordProjectEmbedding({
                projectId: pid,
                sidecarName: topName && topName !== 'in-process' ? topName : null,
                sidecarHost: host,
                sidecarModel: svc ? svc.getModelName() : corpusModel,
                inProcess: topName === 'in-process' || !topName,
                selectedSidecarName: selectedName,
                servedBy: servedBy.length ? servedBy : [{ name: selectedName ?? 'in-process', texts: servedTexts }],
                embeddedAt: new Date().toISOString(),
                lastProcessed: storedVectors,
              });
            } catch (e) {
              console.warn(`[re-embed] attribution not recorded for project ${pid}: ${(e as Error).message}`);
            }
          }
          const c = getJob(job.id);
          const doneNow = (c?.doneProjects ?? 0) + 1;
          updateJob(job.id, { doneProjects: doneNow });

          // Keep the write path cheap: without this, append cost grows with
          // fragment count until the GPUs idle waiting on stores. With
          // concurrent workers this counter can be crossed by whichever one
          // finishes Nth — that is fine, compaction takes the table's write
          // slot (see compactCodeTable) so it can never overlap an append
          // from another worker.
          if (appendsSinceCompaction >= COMPACT_EVERY_APPENDS) {
            appendsSinceCompaction = 0;
            // A LIVE full rebuild has no shadow — writeTable is undefined and
            // stores land in the active slot. It used to be safe to skip
            // compaction there only because projects ran one at a time; with
            // a worker pool the fragment growth that be32c7a fixed comes
            // straight back, so resolve the active table and compact that.
            const target = writeTable
              ?? (liveAll ? await (await import('../embedding/lanceConnection.js')).getLanceTable() : undefined);
            if (target) await compactCodeTable(target, shadowName ?? 'code');
          }
        };

        // Bounded worker pool. Each in-flight project holds its whole node set
        // plus graph context, and three concurrent forced reindexes once
        // tripped the RSS guard at 4,002 MB — so the default is 3, capped at 8.
        const cfgForConcurrency = await (async () => {
          try {
            const fsMod = await import('node:fs');
            const pathMod = await import('node:path');
            const p = pathMod.join(process.cwd(), 'config', 'fantomMcpServer-config.json');
            return fsMod.existsSync(p) ? JSON.parse(fsMod.readFileSync(p, 'utf-8')) : {};
          } catch { return {}; }
        })();
        const concurrency = Math.min(
          resolveMaxConcurrentProjects(cfgForConcurrency),
          Math.max(1, projectIds.length),
        );
        console.log(`[reembed-job] job=${job.id} queue=${projectIds.length} project(s), ${concurrency} concurrent worker(s)`);

        await Promise.all(Array.from({ length: concurrency }, async () => {
          for (;;) {
            const halt = haltRequested(job.id);
            if (halt) { halted = halt; return; }
            const pid = queue.claim();
            if (pid === undefined) return;
            // Tag the async context so the global cloud permit pool can
            // round-robin permits BETWEEN projects: without this every waiter
            // lands in one FIFO and the largest project starves the rest.
            try { await runWithCloudBudgetProject(pid, () => runProject(pid)); }
            finally { queue.release(pid); }   // released on success AND failure
          }
        }));

        if (halted) {
          // PAUSE keeps the shadow and stays resumable; DISCARD drops it.
          // `promoted` is the promotion RECORD, not a log flag — setting it
          // here would make a pause claim it promoted, and a discard claim it
          // promoted a slot that no longer exists. The finally block's log
          // ("kept … restart with resume:true") is exactly right for a pause,
          // so let it fire; `shadowSettled` only stops it after a discard.
          shadowSettled = true;
          await finalizeHalt(job.id, halted, shadowName, writeTable);
          return;
        }

        // VALIDATED PROMOTE: flip the active pointer to the shadow ONLY for a
        // full re-embed that finished every project and produced rows — never
        // a partial/empty shadow. A halt returns earlier (skipping this), so
        // the live table stays authoritative. An incomplete shadow is KEPT and
        // stays both resumable and force-promotable; see
        // /vectors/shadow/promote-anyway, which exists because stopping at
        // 324/340 used to bank nothing usable.
        if (isAll && shadowName && writeTable) {
          const done = getJob(job.id)?.doneProjects ?? 0;
          const rows = await writeTable.countRows().catch(() => 0);
          const decision = decidePromotion(done, projectIds.length, rows);
          if (decision.promote) {
            await promoteCodeTable(shadowName);
            promoted = true;
          } else {
            appendError(job.id, {
              projectId: 0,
              message: `shadow NOT promoted (live table kept; shadow KEPT, resumable and force-promotable): `
                + `${decision.reason}, rows=${rows}`,
            });
          }
        }
        updateJob(job.id, { status: 'done', finishedAt: new Date().toISOString(), currentProjectId: undefined });
      } catch (err) {
        console.error('[reembed-job] fatal:', err);
        updateJob(job.id, {
          status: 'error',
          finishedAt: new Date().toISOString(),
          errorMessage: (err as Error).message,
        });
      } finally {
        // KEEP an un-promoted shadow: it is hours of GPU work and the live slot
        // was never touched, so retaining it lets the next run continue with
        // { resume: true } instead of starting over. A non-resume run drops the
        // slot when it opens it, so this never leaks more than one table.
        if (shadowName && !promoted && !shadowSettled) {
          try {
            const rows = await writeTable?.countRows().catch(() => 0) ?? 0;
            console.log(`[reembed-job] shadow '${shadowName}' kept with ${rows} row(s) — restart with {projectId:0, resume:true} to continue`);
          } catch { /* best effort */ }
        }
        if (isAll) setShadowReembedActive(false);
        releaseHeavy?.();
      }
    });

    res.status(202).json({ jobId: job.id, scope: job.scope });
  });

  // ─── Per-project embedding overrides ─────────────────────────────────
  router.get('/vectors/project-overrides', (_req: Request, res: Response): void => {
    const settings = context.getSettings();
    const overrides = (settings as any).projectEmbeddingOverrides ?? {};
    res.json({ overrides });
  });

  router.put('/vectors/project-overrides/:projectId', async (req: Request, res: Response): Promise<void> => {
    const projectId = String(req.params.projectId);
    if (!/^\d+$/.test(projectId)) {
      res.status(400).json({ error: 'projectId must be numeric' });
      return;
    }
    const { model, sidecarId, dimensions } = (req.body ?? {}) as { model?: string; sidecarId?: string; dimensions?: number };
    const settings = context.getSettings();
    const overrides: Record<string, any> = { ...(settings as any).projectEmbeddingOverrides ?? {} };
    if (!model && !sidecarId) {
      delete overrides[projectId];
    } else {
      overrides[projectId] = { model, sidecarId, dimensions };
    }
    await context.updateSettings({ projectEmbeddingOverrides: overrides } as any);
    res.json({ ok: true, projectId, override: overrides[projectId] ?? null });
  });

  router.delete('/vectors/project-overrides/:projectId', async (req: Request, res: Response): Promise<void> => {
    const projectId = String(req.params.projectId);
    const settings = context.getSettings();
    const overrides: Record<string, any> = { ...(settings as any).projectEmbeddingOverrides ?? {} };
    delete overrides[projectId];
    await context.updateSettings({ projectEmbeddingOverrides: overrides } as any);
    res.json({ ok: true, projectId });
  });

  router.get('/vectors/auto-pipeline/status', async (_req: Request, res: Response): Promise<void> => {
    const { getAutoPipelineStatus } = await import('../embedding/autoPipelineBus.js');
    const status = getAutoPipelineStatus() as Record<string, unknown> & ReturnType<typeof getAutoPipelineStatus>;
    // Overlay a running background re-embed job (POST /vectors/re-embed/start)
    // so the dashboard's Embedding Activity panel reflects ALL embedding work,
    // not only the boot auto-pipeline that feeds autoPipelineBus.
    try {
      const { listJobs } = await import('./reembedJobs.js');
      const job = listJobs().find(j => j.status === 'running' || j.status === 'queued');
      if (job) {
        let currentProjectName: string | undefined;
        if (typeof job.currentProjectId === 'number') {
          try {
            const { getPrismaClient } = await import('../db/prisma.js');
            const p = await getPrismaClient().fantomProject.findUnique({ where: { id: job.currentProjectId }, select: { name: true } });
            currentProjectName = p?.name;
          } catch { /* name is cosmetic */ }
        }
        const scopeLabel = job.scope === 'all' ? 'full' : `project ${job.scope.projectId}`;
        status.reembedJob = {
          id: job.id, scope: job.scope, status: job.status, startedAt: job.startedAt,
          totalProjects: job.totalProjects, doneProjects: job.doneProjects,
          currentProjectId: job.currentProjectId, currentProjectName,
          generated: job.generated, deleted: job.deleted, errors: job.errors.length,
          model: job.model, dimensions: job.dimensions, cancelRequested: job.cancelRequested,
        };
        status.phaseLabel = `re-embed (${scopeLabel})`;
        status.running = true;
        if (status.currentPhase === 'idle' || status.currentPhase === 'done') {
          status.totalProjects = job.totalProjects;
          status.doneProjects = job.doneProjects;
          status.currentProjectId = job.currentProjectId;
          status.currentProjectName = currentProjectName;
          status.startedAt = job.startedAt;
          status.finishedAt = undefined;
        }
      }
    } catch { /* jobs module unavailable — plain pipeline status */ }
    // Heavy-job lock holder/queue (code re-embed, forced reindex, Axon index).
    try {
      const { getHeavyJob, getHeavyJobQueue } = await import('../embedding/embedGate.js');
      status.heavyJob = getHeavyJob();
      status.heavyJobQueue = getHeavyJobQueue();
    } catch { /* ignore */ }
    res.json(status);
  });

  /**
   * GET /admin/embeddings/heavy-job
   * The single heavy-job lock: current holder (code-reembed | code-reindex |
   * axon-index) and FIFO queue. Null holder = idle.
   */
  router.get('/embeddings/heavy-job', async (_req: Request, res: Response): Promise<void> => {
    const { getHeavyJob, getHeavyJobQueue, isShadowReembedActive } = await import('../embedding/embedGate.js');
    res.json({ holder: getHeavyJob(), queue: getHeavyJobQueue(), shadowReembedActive: isShadowReembedActive() });
  });

  // Re-trigger the auto-embed pipeline manually (e.g. after a sidecar comes
  // online late, or to retry the failedProjects list). Body is optional; when
  // omitted, embeds every project with a node count > 0. The pipeline runs
  // asynchronously and updates autoPipelineBus the same way the boot pipeline
  // does — clients poll /vectors/auto-pipeline/status for progress.
  // Shared auto-embed runner — used by both the manual POST endpoint and
  // the watchdog that auto-retries when a sidecar registers after the
  // boot-time gate has parked the pipeline. Exporting via a shared closure
  // keeps the two paths byte-for-byte identical.
  /** Whole `semanticSearch` block straight from the runtime config file. */
  const readRuntimeSemanticForAdmin = (): Record<string, unknown> => {
    try {
      const cfgPath = path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');
      if (!fs.existsSync(cfgPath)) return {};
      return JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))?.semanticSearch ?? {};
    } catch { return {}; }
  };

  let autoEmbedInFlight = false;

  /**
   * Operator kill-switch for background embedding.
   *
   * PERSISTED, not in-memory: the watchdog re-triggers every 60s and a restart
   * would otherwise resume filling the table. Read fresh each call so toggling
   * it takes effect without a restart.
   *
   * Exists because the auto-pipeline writes to the ACTIVE slot, and that work
   * is discarded whenever a shadow rebuild is promoted — ~26,000 vectors of GPU
   * time on 2026-09-15 alone, against a plan to rebuild the index elsewhere.
   */
  const autoEmbedDisabled = (): boolean => {
    try {
      // readRuntimeSemantic() and NOT context.getSettings(): getSettings builds
      // a WHITELISTED object (index.ts ~2279 lists minScore, graphWeight, …),
      // so any key not named there is silently dropped. This flag read as
      // false while the config file on disk said true — the switch looked
      // wired and did nothing. readRuntimeSemantic reads the file directly,
      // which also makes the toggle take effect without a restart.
      const semantic = readRuntimeSemanticForAdmin();
      return semantic?.autoEmbedDisabled === true;
    } catch { return false; }
  };
  // Per-project failure backoff (poison-project quarantine). A project whose
  // graph DB is unrecoverable or that fails repeatedly must NOT be retried
  // every 60s watchdog tick — that floods the log and hammers sidecars. After
  // each failure we set an exponentially-growing nextRetryAt; the auto-embed
  // skip-check honors it. Cleared on success. In-memory is fine (a restart is
  // a reasonable point to re-attempt).
  const embedFailBackoff = new Map<number, { fails: number; nextRetryAt: number }>();
  const BACKOFF_BASE_MS = 60_000;       // 1 min
  const BACKOFF_CAP_MS = 60 * 60_000;   // 1 hour
  // Per-project "Resume" (build-missing) in-flight set — dedupes rapid clicks
  // and lets the route return 202 immediately instead of blocking the button.
  const buildMissingInFlight = new Set<number>();
  const runAutoEmbedPipeline = async (projectIds: number[] | null = null): Promise<void> => {
    if (autoEmbedInFlight) return;
    if (autoEmbedDisabled()) {
      console.log('[auto-embed] disabled by the operator (semanticSearch.autoEmbedDisabled) — standing down');
      return;
    }
    // Stand down while a full shadow re-embed is building: the watchdog would
    // otherwise see "missing vectors" in the (old) live slot, fight the shadow
    // build for the single embedding GPU, and write vectors discarded on promote.
    {
      const { isShadowReembedActive, getHeavyJob } = await import('../embedding/embedGate.js');
      const heavy = getHeavyJob();
      if (isShadowReembedActive() || heavy) {
        console.log(`[auto-embed] ${heavy ? `${heavy.kind} (${heavy.label})` : 'shadow re-embed'} in progress — watchdog standing down`);
        return;
      }
    }
    autoEmbedInFlight = true;
    try {
      const { getPrismaClient } = await import('../db/prisma.js');
      const { getSemanticSearchService } = await import('../embedding/semanticSearchService.js');
      const { getVectorStore } = await import('../embedding/vectorStore.js');
      const { selectEmbeddingProvider } = await import('../embedding/providers/embeddingProvider.js');
      const { getLanceTableStats } = await import('../embedding/lanceConnection.js');
      const {
        autoPipelineStarting,
        autoPipelineProjectStarting,
        autoPipelineProjectDone,
        autoPipelineProjectSkipped,
        autoPipelineProjectFailed,
        autoPipelineFinished,
      } = await import('../embedding/autoPipelineBus.js');

      // Dim-safety: LanceDB locks the vector column's listSize at table
      // creation, so inserting mismatched-dim vectors silently truncates them.
      // The AUTO path must NEVER drop the table here: the configured provider
      // dimension flaps with sidecar availability (1024d qwen3 when a sidecar
      // is up, 384d in-process otherwise), so an automatic drop-on-mismatch
      // turns a transient sidecar blip into a catastrophic wipe-and-rebuild
      // loop ("never completes, keep resuming"). Instead, on mismatch we ABORT
      // this auto run (embedding would corrupt the table). A destructive
      // rebuild stays an EXPLICIT, operator-initiated action via
      // POST /vectors/re-embed/:projectId only.
      try {
        const prov = selectEmbeddingProvider('code');
        await prov.initialize();
        const newDims = prov.getDimensions();
        const stats = await getLanceTableStats();
        const storedDims = stats.code.dimensions ?? null;
        if (storedDims && storedDims !== newDims) {
          console.warn(`[auto-embed] code_vectors dim mismatch (stored=${storedDims}, configured=${newDims}); SKIPPING auto run (no destructive drop — use POST /vectors/re-embed to rebuild deliberately)`);
          return;
        }
      } catch (err) {
        console.warn('[auto-embed] dim-safety check failed:', (err as Error).message);
      }

      const prisma = getPrismaClient();
      const svc = getSemanticSearchService(prisma);
      const vectorStore = getVectorStore(prisma);
      const skipComplete = process.env.FANTOM_AUTO_EMBED_SKIP_COMPLETE !== '0';

      let projects = await prisma.fantomProject.findMany({
        select: { id: true, name: true, functionCount: true, typeCount: true },
      });
      if (projectIds) {
        const set = new Set(projectIds);
        projects = projects.filter(p => set.has(p.id));
      }
      projects = projects.filter(p => (p.functionCount ?? 0) + (p.typeCount ?? 0) > 0);
      const vectorsByProject = skipComplete ? await vectorStore.countByProject() : new Map<number, number>();
      // Authoritative per-project node counts (per-project graph db) — the
      // SAME denominator the dashboard uses. Comparing vectors against Prisma
      // functionCount+typeCount (a different, inflated universe) meant a project
      // was never "complete", so the watchdog re-fired forever and the operator
      // had to keep clicking Resume. Graph count = what buildProjectEmbeddings
      // actually embeds, so `have >= nodes` becomes a true completion signal.
      const { getProjectNodeCounts } = await import('../graph/projectNodeCounts.js');
      const graphCounts = await getProjectNodeCounts(projects.map(p => p.id));
      const nodesFor = (p: { id: number; functionCount: number; typeCount: number }): number => {
        const g = graphCounts.get(p.id) ?? 0;
        return g > 0 ? g : (p.functionCount ?? 0) + (p.typeCount ?? 0);
      };

      autoPipelineStarting(projects.length);
      const settings = context.getSettings();
      const parallelRaw = (settings.semanticSearch as any)?.parallelProjects;
      const parallel = Math.max(1, Math.min(8, Number.isFinite(parallelRaw) ? Number(parallelRaw) : 1));

      const queue = [...projects];
      const { projectNeedsGraphRebuild, clearProjectGraphRebuildFlag, closeProjectGraphDatabase } =
        await import('../graph/projectGraphConnection.js');
      const { invalidateProjectNodeCount } = await import('../graph/projectNodeCounts.js');
      const runOne = async (p: typeof projects[number]): Promise<void> => {
        // A heavy job (full re-embed / forced reindex / Axon index) owns the
        // fleet: skip instead of starting a run that aborts at its first batch.
        const { getHeavyJob: heavyJobNow } = await import('../embedding/embedGate.js');
        if (heavyJobNow()) { autoPipelineProjectSkipped(p.id, p.name); return; }
        // Honour a stop requested mid-run: the loop drains rather than
        // finishing every remaining project.
        if (autoEmbedDisabled()) { autoPipelineProjectSkipped(p.id, p.name); return; }
        // Poison-project quarantine: a project that keeps failing (e.g. an
        // unrecoverable graph DB) is skipped until its backoff window elapses,
        // instead of being hammered every 60s tick.
        const bo = embedFailBackoff.get(p.id);
        if (bo && Date.now() < bo.nextRetryAt) {
          autoPipelineProjectSkipped(p.id, p.name);
          return;
        }
        const nodes = nodesFor(p);
        // An EMPTY graph DB (0 nodes) for a project that Prisma says HAS code is
        // the "no progress" trap: buildProjectEmbeddings falls back to in-memory
        // nodes, but storeEmbeddings can't match them to the empty graph and
        // drops every vector. Treat it like a corruption reset → rebuild first.
        const graphEmpty =
          (graphCounts.get(p.id) ?? 0) === 0 && (p.functionCount ?? 0) + (p.typeCount ?? 0) > 0;
        const needsRebuild = projectNeedsGraphRebuild(p.id) || graphEmpty;
        if (skipComplete && !needsRebuild) {
          const have = vectorsByProject.get(p.id) ?? 0;
          if (have >= nodes) {
            autoPipelineProjectSkipped(p.id, p.name);
            return;
          }
        }
        autoPipelineProjectStarting(p.id, p.name, nodes);
        try {
          // Self-heal: rebuild the graph from source when it was reset after
          // corruption OR is empty-but-should-have-nodes, so there are real
          // nodes to embed (and storeEmbeddings can match them).
          if (needsRebuild) {
            const { getCodeIndexingService } = await import('../fantom-code/codeIndexingService.js');
            const rebuilt = await getCodeIndexingService(prisma).rebuildGraph(p.id);
            clearProjectGraphRebuildFlag(p.id);
            invalidateProjectNodeCount(p.id);
            console.warn(`[auto-embed] rebuilt graph for project ${p.id} (empty/flagged) → ${rebuilt?.nodeCount ?? '?'} nodes`);
            if (!rebuilt?.nodeCount) {
              // Rebuild produced 0 nodes (e.g. source moved/removed). Quarantine
              // to avoid a per-tick rebuild loop; surfaces in failedProjects.
              const fails = (embedFailBackoff.get(p.id)?.fails ?? 0) + 1;
              embedFailBackoff.set(p.id, { fails, nextRetryAt: Date.now() + Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (fails - 1)) });
              autoPipelineProjectFailed(p.id, p.name, 'graph rebuild produced 0 nodes (quarantined)');
              return;
            }
          }
          const r = await svc.buildProjectEmbeddings(p.id);
          if (r.yielded) autoPipelineProjectSkipped(p.id, p.name); else autoPipelineProjectDone(r.processed, r.errors);
          embedFailBackoff.delete(p.id); // success clears the quarantine
        } catch (err) {
          // Failure → exponential-backoff quarantine (1m, 2m, 4m … cap 1h).
          const fails = (embedFailBackoff.get(p.id)?.fails ?? 0) + 1;
          const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (fails - 1));
          embedFailBackoff.set(p.id, { fails, nextRetryAt: Date.now() + delay });
          autoPipelineProjectFailed(p.id, p.name, `${(err as Error).message} (quarantined ${Math.round(delay / 60000)}m, attempt ${fails})`);
        }
        try {
          await closeProjectGraphDatabase(p.id);
        } catch { /* best effort */ }
      };
      const workers = Array.from({ length: parallel }, async () => {
        while (true) {
          const p = queue.shift();
          if (!p) return;
          await runOne(p);
        }
      });
      await Promise.all(workers);
      autoPipelineFinished();
    } catch (err) {
      console.error('[auto-embed/start] fatal:', err);
    } finally {
      autoEmbedInFlight = false;
    }
  };

  // Wire the watchdog: while autoPipelineBus.currentPhase is
  // 'waiting-for-sidecar' AND a capable sidecar is registered, the bus
  // will call this starter on its next tick. The bus throttles repeated
  // triggers (30s gap) and requires two consecutive detections, so a
  // flapping sidecar registration won't kick off a doomed run.
  registerAutoEmbedStarter(() => runAutoEmbedPipeline(null));
  startSidecarRetryWatchdog(5_000);

  // Embed-missing watchdog: every 60s, sums per-project node counts vs
  // stored vector counts and fires runAutoEmbedPipeline() when (a) at
  // least one project is incomplete, (b) an embedding-capable sidecar is
  // registered, (c) no auto-embed run is currently in flight. Removes
  // the need for the operator to keep clicking "Resume Embed" / "Embed
  // Missing" on the home page.
  registerEmbedMissingChecker(async () => {
    try {
      const { getPrismaClient } = await import('../db/prisma.js');
      const { getVectorStore } = await import('../embedding/vectorStore.js');
      const { listSidecars } = await import('../sidecars/registry.js');
      const { getProjectNodeCounts } = await import('../graph/projectNodeCounts.js');
      const prisma = getPrismaClient();
      const vectorStore = getVectorStore(prisma);

      // While a full re-embed builds into the shadow slot, "missing vectors in
      // the live slot" is a meaningless number: the live slot is frozen by
      // design, so missingCount never moves and the watchdog declared the run
      // stale every 5 minutes ("stale for 110m, 199628 missing vectors —
      // restarting embed"). Each restart did stand down immediately at the
      // heavy-job guard, so nothing raced, but the operator saw a broken run
      // that was in fact healthy. Report "nothing missing" instead: the
      // rebuild owns the fleet and its own job reports progress.
      {
        const { isShadowReembedActive, getHeavyJob } = await import('../embedding/embedGate.js');
        if (isShadowReembedActive() || getHeavyJob() || autoEmbedDisabled()) {
          return { hasMissing: false, missingCount: 0, sidecarReady: false };
        }
      }

      const projects = await prisma.fantomProject.findMany({ select: { id: true, functionCount: true, typeCount: true } });
      const counts = await vectorStore.countByProject();
      // Use the authoritative per-project GRAPH node count (what actually gets
      // embedded), not Prisma functionCount+typeCount. With the inflated Prisma
      // number, `have < nodes` stayed true even for fully-embedded projects, so
      // the watchdog never went quiet and the operator kept clicking Resume.
      const graphCounts = await getProjectNodeCounts(projects.map(p => p.id));
      let missingCount = 0;
      const now = Date.now();
      for (const p of projects) {
        // A project inside its failure-backoff (quarantine) window must not
        // count as "missing": the pipeline would refuse it anyway, so counting
        // it only makes the watchdog restart the run every few minutes.
        const bo = embedFailBackoff.get(p.id);
        if (bo && bo.nextRetryAt > now) continue;
        const g = graphCounts.get(p.id) ?? 0;
        const nodes = g > 0 ? g : (p.functionCount ?? 0) + (p.typeCount ?? 0);
        if (nodes <= 0) continue;
        const have = counts.get(p.id) ?? 0;
        if (have < nodes) missingCount += (nodes - have);
      }
      // NOTE: no dim-mismatch escalation here. A dim flap (sidecar up/down)
      // must NOT auto-trigger a destructive table rebuild — that caused the
      // wipe-and-re-embed loop. Dimension changes are handled deliberately via
      // POST /vectors/re-embed; the auto path simply skips on mismatch.
      const sidecarReady = listSidecars({ capability: 'embedding', enabled: true })
        .some(s => s.capabilities.embedding?.available);
      return { hasMissing: missingCount > 0, missingCount, sidecarReady };
    } catch {
      return { hasMissing: false, missingCount: 0, sidecarReady: false };
    }
  });
  startEmbedMissingWatchdog(60_000);

  /**
   * Stop / resume background embedding. There was previously only a start
   * route, so a fleet quietly filling the live table could not be told to
   * stop — the watchdog re-armed every 60s and a restart resumed it.
   *
   * POST /vectors/auto-embed/stop    -> persist the kill-switch
   * POST /vectors/auto-embed/resume  -> clear it
   */
  const setAutoEmbedDisabled = async (disable: boolean, res: Response): Promise<void> => {
    const cur = context.getSettings() as { semanticSearch?: Record<string, unknown> };
    await context.updateSettings({
      semanticSearch: { ...(cur?.semanticSearch ?? {}), autoEmbedDisabled: disable },
    } as never);
    const { stopEmbedMissingWatchdog, startEmbedMissingWatchdog } =
      await import('../embedding/autoPipelineBus.js');
    // Silence the 60s tick too, so a disabled pipeline stops emitting "stale,
    // N missing vectors" events that read as a fault rather than a choice.
    if (disable) stopEmbedMissingWatchdog(); else startEmbedMissingWatchdog(60_000);
    console.log(`[auto-embed] ${disable ? 'STOPPED' : 'resumed'} by the operator`);
    res.json({
      ok: true,
      autoEmbedDisabled: disable,
      note: disable
        ? 'Background embedding is off and will stay off across restarts. An in-flight run drains at its next project boundary.'
        : 'Background embedding re-enabled; the watchdog will pick up missing vectors within 60s.',
    });
  };

  // Two plain routes rather than one `:action(stop|resume)` parameter — this
  // router (path-to-regexp v8) no longer accepts an inline regex group in a
  // path and throws at registration, which takes the whole server down at boot.
  /** Current state of background embedding, for the dashboard toggle. */
  router.get('/vectors/auto-embed/state', async (_req: Request, res: Response): Promise<void> => {
    const { getAutoPipelineStatus } = await import('../embedding/autoPipelineBus.js');
    let running = false;
    let phase: string | undefined;
    try {
      const st = getAutoPipelineStatus() as { running?: boolean; currentPhase?: string };
      running = st?.running === true;
      phase = st?.currentPhase;
    } catch { /* status is advisory */ }
    res.json({ autoEmbedDisabled: autoEmbedDisabled(), running, phase });
  });

  router.post('/vectors/auto-embed/stop', async (_req: Request, res: Response): Promise<void> => {
    await setAutoEmbedDisabled(true, res);
  });
  router.post('/vectors/auto-embed/resume', async (_req: Request, res: Response): Promise<void> => {
    await setAutoEmbedDisabled(false, res);
  });

  router.post('/vectors/auto-embed/start', async (req: Request, res: Response): Promise<void> => {
    const projectIds = Array.isArray(req.body?.projectIds)
      ? (req.body.projectIds as unknown[]).map(n => Number(n)).filter(n => Number.isFinite(n) && n > 0)
      : null;
    queueMicrotask(() => { void runAutoEmbedPipeline(projectIds); });
    res.status(202).json({ queued: projectIds ? projectIds.length : 'all-incomplete' });
  });

  // Fill-missing: incremental embedding for one project. Uses
  // SemanticSearchService.buildProjectEmbeddings which already skips nodes
  // that already have a vector — no destructive delete first.
  router.post('/vectors/build-missing/:projectId', async (req: Request, res: Response): Promise<void> => {
    // Heavy-job lock: refuse while a full re-embed / forced reindex / Axon
    // index owns the sidecar fleet (2026-09-14: a build-missing job launched
    // beside the v3 shadow rebuild raced through 235 projects, each aborting).
    {
      const { getHeavyJob } = await import('../embedding/embedGate.js');
      const heavy = getHeavyJob();
      if (heavy) {
        res.status(409).json({ error: `Another heavy job is running: ${heavy.kind} (${heavy.label}) since ${heavy.since}`, heavyJob: heavy });
        return;
      }
    }
    const projectId = parseInt(String(req.params.projectId), 10);
    if (!Number.isFinite(projectId) || projectId <= 0) {
      res.status(400).json({ error: 'projectId must be a positive integer' });
      return;
    }
    // NON-BLOCKING: this powers the per-project "Resume" button. Running
    // buildProjectEmbeddings synchronously parks on the embed semaphore (which
    // the auto-embed watchdog may be holding), so the button would hang on
    // "Working…" and look dead. Instead kick it off in the background and
    // return 202 immediately; the dashboard's 10s /vectors/stats poll surfaces
    // the climbing vector count. A per-project in-flight set dedupes rapid clicks.
    if (buildMissingInFlight.has(projectId)) {
      res.status(202).json({ ok: true, projectId, alreadyRunning: true });
      return;
    }
    buildMissingInFlight.add(projectId);
    queueMicrotask(async () => {
      try {
        const { getPrismaClient } = await import('../db/prisma.js');
        const { getSemanticSearchService } = await import('../embedding/semanticSearchService.js');
        const result = await getSemanticSearchService(getPrismaClient()).buildProjectEmbeddings(projectId);
        console.warn(`[build-missing] project ${projectId} done: processed=${result.processed} errors=${result.errors}`);
      } catch (err) {
        console.error(`[build-missing] project ${projectId} failed:`, (err as Error).message);
      } finally {
        buildMissingInFlight.delete(projectId);
      }
    });
    res.status(202).json({ ok: true, projectId, queued: true });
  });

  // Fill-missing for every project that has any un-embedded node. Async —
  // registers a reembedJob and runs in the background; client polls
  // /admin/vectors/re-embed/jobs/:id for progress.
  router.post('/vectors/build-missing', async (req: Request, res: Response): Promise<void> => {
    // Heavy-job lock: while a full re-embed / forced reindex / Axon index owns
    // the sidecar fleet, refuse (409 + holder) unless the caller passes
    // { force: true } — "force resume": cancel the running re-embed job(s),
    // wait for the lock to free (≤ 90 s), then fill missing vectors.
    // (2026-09-14: a build-missing job launched beside the v3 shadow rebuild
    // raced through 235 projects, each aborting at its first batch.)
    {
      const { getHeavyJob } = await import('../embedding/embedGate.js');
      let heavy = getHeavyJob();
      if (heavy && req.body?.force === true) {
        const { listJobs, requestCancel } = await import('./reembedJobs.js');
        for (const j of listJobs()) if (j.status === 'running') requestCancel(j.id);
        console.warn(`[build-missing] force: cancelling ${heavy.kind} (${heavy.label}) to resume missing-vector embedding`);
        const deadline = Date.now() + 90_000;
        while (getHeavyJob() && Date.now() < deadline) await new Promise(r => setTimeout(r, 1000));
        heavy = getHeavyJob();
      }
      if (heavy) {
        res.status(409).json({ error: `Another heavy job is running: ${heavy.kind} (${heavy.label}) since ${heavy.since}. Pass {force:true} to cancel it and resume.`, heavyJob: heavy });
        return;
      }
    }
    const fsMod = await import('node:fs');
    const { crashWrite } = await import('../utils/logSink.js');
    const reCrash = (s: string) => crashWrite('RESUME_EMBED', s);
    const memTagRE = () => {
      const m = process.memoryUsage();
      return `rss=${Math.round(m.rss / 1024 / 1024)}MB heap=${Math.round(m.heapUsed / 1024 / 1024)}MB`;
    };
    const ua = String(req.headers['user-agent'] ?? '?').slice(0, 100);
    const ip = req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? '?';
    reCrash(`HTTP_REQUEST_IN method=POST path=/admin/vectors/build-missing ip=${ip} ua=${ua} ${memTagRE()}`);

    const { getPrismaClient } = await import('../db/prisma.js');
    const { getVectorStore } = await import('../embedding/vectorStore.js');
    const { createJob, updateJob, getJob, appendError } = await import('./reembedJobs.js');

    // Guard: refuse to start when strict-sidecar mode is on and no
    // embedding-capable sidecar has registered. Without this guard, all
    // 242 projects fail in <1s with the same strict-sidecar error and the
    // resulting "dead job" pollutes the jobs list while telling the user
    // nothing actionable. Read settings fresh from disk so the dashboard
    // toggle takes effect immediately.
    try {
      const cfgPath = (await import('node:path')).join(process.cwd(), 'config', 'fantomMcpServer-config.json');
      if (fsMod.existsSync(cfgPath)) {
        const cfg = JSON.parse(fsMod.readFileSync(cfgPath, 'utf-8'));
        const strictCode = cfg?.semanticSearch?.codeFromSidecar === true;
        // Under "OpenRouter only" there is no local sidecar to be ready: the
        // GPUs are excluded by policy, so this guard would 425 forever on a
        // fleet that is working exactly as configured.
        const { localEmbedderRequired } = await import('../embedding/providers/embeddingProvider.js');
        const needsLocal = await localEmbedderRequired('code');
        if (strictCode && needsLocal) {
          const { listSidecars } = await import('../sidecars/registry.js');
          const ready = listSidecars({ capability: 'embedding', enabled: true }).filter(s => s.capabilities.embedding?.available);
          if (ready.length === 0) {
            const msg = 'Strict-sidecar mode is enabled but no embedding-capable sidecar is registered yet. Wait for the sidecar to connect via WebSocket, or disable codeFromSidecar in /dashboard/config/#semantic.';
            reCrash(`GUARD_NO_SIDECAR strictCode=true ready=0 → 425`);
            res.status(425).json({ error: msg, sidecarsReady: 0 });
            return;
          }
          reCrash(`GUARD_OK strictCode=true ready=${ready.length}`);
        }
      }
    } catch (err) {
      reCrash(`GUARD_CHECK_FAILED err=${err instanceof Error ? err.message : String(err)}`);
    }

    const prisma = getPrismaClient();
    const vectorStore = getVectorStore(prisma);
    reCrash(`PROJECTS_QUERY_START`);
    const t0 = Date.now();
    const projects = await prisma.fantomProject.findMany({ select: { id: true, functionCount: true, typeCount: true } });
    reCrash(`PROJECTS_QUERY_OK count=${projects.length} ms=${Date.now() - t0}`);

    reCrash(`VECTORS_COUNT_START`);
    const t1 = Date.now();
    const vectorsByProject = await vectorStore.countByProject();
    reCrash(`VECTORS_COUNT_OK projects=${vectorsByProject.size} ms=${Date.now() - t1}`);

    const incomplete = projects
      .map(p => ({ id: p.id, nodes: (p.functionCount ?? 0) + (p.typeCount ?? 0), vectors: vectorsByProject.get(p.id) ?? 0 }))
      .filter(p => p.nodes > 0 && p.vectors < p.nodes)
      .map(p => p.id);
    reCrash(`INCOMPLETE_PROJECTS count=${incomplete.length} ids=[${incomplete.slice(0, 20).join(',')}${incomplete.length > 20 ? `,…+${incomplete.length - 20}` : ''}]`);

    reCrash(`JOB_CREATE_BEGIN`);
    const job = createJob('all');
    reCrash(`JOB_CREATE_OK id=${job.id}`);
    updateJob(job.id, { totalProjects: incomplete.length, status: 'running' });
    reCrash(`JOB_CREATED id=${job.id} totalProjects=${incomplete.length} status=running`);

    // Wrap updateJob with a crash-log shadow so every state transition is
    // captured even when the kernel SIGKILLs us between transitions.
    const updateJobLogged = (id: string, patch: Record<string, unknown>) => {
      reCrash(`JOB_UPDATE id=${id} ${JSON.stringify(patch)}`);
      return updateJob(id, patch);
    };

    reCrash(`MICROTASK_QUEUED job=${job.id}`);
    queueMicrotask(async () => {
      reCrash(`WORKER_TASK_START job=${job.id} ${memTagRE()}`);
      try {
        reCrash(`SVC_IMPORT_BEGIN`);
        const { getSemanticSearchService } = await import('../embedding/semanticSearchService.js');
        reCrash(`SVC_IMPORT_OK`);
        const svc = getSemanticSearchService(getPrismaClient());
        // Read parallelProjects fresh from disk — context.getSettings() can
        // return a stale cached object that doesn't include the field after
        // a dashboard save. The semaphore inside buildProjectEmbeddings does
        // the same, so both layers stay in sync without a server restart.
        let parallel = 1;
        try {
          const cfgPath = (await import('node:path')).join(process.cwd(), 'config', 'fantomMcpServer-config.json');
          if (fsMod.existsSync(cfgPath)) {
            const cfg = JSON.parse(fsMod.readFileSync(cfgPath, 'utf-8'));
            const raw = cfg?.semanticSearch?.parallelProjects;
            if (Number.isFinite(raw) && raw > 0) parallel = Math.max(1, Math.min(8, Number(raw)));
          }
        } catch (err) {
          reCrash(`PARALLEL_READ_FAILED err=${err instanceof Error ? err.message : String(err)} (defaulting to 1)`);
        }
        reCrash(`WORKER_POOL_INIT job=${job.id} parallel=${parallel} queueSize=${incomplete.length} ${memTagRE()}`);

        const queue = [...incomplete];
        let workerIdSeq = 0;
        const runOne = async (workerId: number, pid: number, position: number): Promise<void> => {
          if (getJob(job.id)?.cancelRequested) {
            reCrash(`WORKER_${workerId} CANCELLED before pid=${pid}`);
            return;
          }
          updateJobLogged(job.id, { currentProjectId: pid });
          reCrash(`WORKER_${workerId} PROJECT_START pid=${pid} position=${position}/${incomplete.length} ${memTagRE()}`);
          const projStart = Date.now();
          try {
            reCrash(`WORKER_${workerId} BPE_AWAIT pid=${pid}`);
            const r = await svc.buildProjectEmbeddings(pid);
            reCrash(`WORKER_${workerId} BPE_RETURN pid=${pid} processed=${r.processed} errors=${r.errors}`);
            const cur = getJob(job.id);
            updateJobLogged(job.id, {
              generated: (cur?.generated ?? 0) + r.processed,
              doneProjects: (cur?.doneProjects ?? 0) + 1,
            });
            reCrash(`WORKER_${workerId} PROJECT_OK pid=${pid} processed=${r.processed} errors=${r.errors} ms=${Date.now() - projStart} ${memTagRE()}`);
          } catch (e) {
            const msg = (e as Error).message;
            const stack = e instanceof Error && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : '';
            appendError(job.id, { projectId: pid, message: msg });
            const cur = getJob(job.id);
            updateJobLogged(job.id, { doneProjects: (cur?.doneProjects ?? 0) + 1 });
            reCrash(`WORKER_${workerId} PROJECT_FAIL pid=${pid} ms=${Date.now() - projStart} err=${msg} stack=${stack}`);
          }
        };
        const workers = Array.from({ length: parallel }, async () => {
          const myId = ++workerIdSeq;
          reCrash(`WORKER_${myId} STARTED ${memTagRE()}`);
          let processed = 0;
          while (true) {
            if (getJob(job.id)?.cancelRequested) { reCrash(`WORKER_${myId} CANCELLED_LOOP processed=${processed}`); return; }
            const pid = queue.shift();
            if (pid === undefined) { reCrash(`WORKER_${myId} DRAINED processed=${processed}`); return; }
            const remaining = queue.length;
            const position = incomplete.length - remaining;
            reCrash(`WORKER_${myId} LOOP_PICK pid=${pid} remaining=${remaining}`);
            await runOne(myId, pid, position);
            processed++;
            reCrash(`WORKER_${myId} LOOP_AFTER pid=${pid} processed=${processed}`);
          }
        });
        reCrash(`WORKER_POOL_AWAIT job=${job.id} workers=${workers.length}`);
        await Promise.all(workers);
        reCrash(`WORKER_POOL_DONE job=${job.id} ${memTagRE()}`);
        if (getJob(job.id)?.cancelRequested) {
          updateJobLogged(job.id, { status: 'cancelled', finishedAt: new Date().toISOString() });
          reCrash(`JOB_CANCELLED id=${job.id}`);
          return;
        }
        updateJobLogged(job.id, { status: 'done', finishedAt: new Date().toISOString(), currentProjectId: undefined });
        reCrash(`JOB_DONE id=${job.id}`);
      } catch (err) {
        const msg = (err as Error).message;
        const stack = err instanceof Error && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : '';
        updateJobLogged(job.id, { status: 'error', finishedAt: new Date().toISOString(), errorMessage: msg });
        reCrash(`JOB_ERROR id=${job.id} err=${msg} stack=${stack}`);
      }
    });

    reCrash(`HTTP_RESPONSE_OUT 202 jobId=${job.id} projectsToProcess=${incomplete.length}`);
    res.status(202).json({ jobId: job.id, projectsToProcess: incomplete.length });
  });

  router.get('/vectors/re-embed/jobs', async (_req: Request, res: Response): Promise<void> => {
    const { listJobs } = await import('./reembedJobs.js');
    res.json({ jobs: listJobs() });
  });

  router.get('/vectors/re-embed/jobs/:id', async (req: Request, res: Response): Promise<void> => {
    const { getJob } = await import('./reembedJobs.js');
    const j = getJob(req.params.id as string);
    if (!j) { res.status(404).json({ error: 'Job not found' }); return; }
    res.json(j);
  });

  /**
   * DISCARD. Halts the job AND drops the shadow — the only irreversible
   * action in this flow. The UI must confirm it and must state how many
   * vectors and projects it destroys; `GET /vectors/shadow` supplies both.
   */
  router.post('/vectors/re-embed/jobs/:id/cancel', async (req: Request, res: Response): Promise<void> => {
    const { requestCancel } = await import('./reembedJobs.js');
    const j = requestCancel(req.params.id as string);
    if (!j) { res.status(404).json({ error: 'Job not found' }); return; }
    res.json({ ok: true, status: j.status, cancelRequested: j.cancelRequested, destructive: true });
  });

  /**
   * PAUSE. Halts the job and KEEPS the shadow. Reversible: resume with
   * POST /vectors/re-embed/start { projectId: 0, resume: true }.
   */
  router.post('/vectors/re-embed/jobs/:id/pause', async (req: Request, res: Response): Promise<void> => {
    const { requestPause } = await import('./reembedJobs.js');
    const j = requestPause(req.params.id as string);
    if (!j) { res.status(404).json({ error: 'Job not found' }); return; }
    res.json({
      ok: true,
      status: j.status,
      pauseRequested: j.pauseRequested,
      destructive: false,
      note: 'Vectors already written are kept. Resume with POST /admin/vectors/re-embed/start {"projectId":0,"resume":true}.',
    });
  });

  /**
   * The pending shadow — what a pause or a partial run left behind. This is
   * what stops a pause from reading as a wipe: the banner can show the banked
   * rows and projects instead of the page falling back to the active slot.
   */
  /**
   * POST /admin/vectors/index
   * Build the ANN index on the ACTIVE code table.
   *
   * Separate from the rebuild on purpose: an index is a property of the table,
   * not of the job that filled it, and the live table went unindexed for its
   * whole life because nothing owned that step. Idempotent — returns what it
   * found when an index already exists. `{"force":true}` rebuilds.
   */
  router.post('/vectors/index', async (req: Request, res: Response): Promise<void> => {
    try {
      const { getLanceTable, ensureCodeVectorIndex, getActiveCodeTableName } =
        await import('../embedding/lanceConnection.js');
      const table = await getLanceTable();
      const out = await ensureCodeVectorIndex(table, {
        label: getActiveCodeTableName(),
        force: req.body?.force === true,
      });
      res.json({ table: getActiveCodeTableName(), ...out });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'index build failed' });
    }
  });

  router.get('/vectors/shadow', async (_req: Request, res: Response): Promise<void> => {
    const { getPendingShadowCodeTable } = await import('../embedding/lanceConnection.js');
    const { findPausedJob, findActiveJob } = await import('./reembedJobs.js');
    const pending = await getPendingShadowCodeTable();
    const paused = findPausedJob();
    const active = findActiveJob();
    if (!pending) { res.json({ pending: null, jobRunning: !!active }); return; }
    res.json({
      pending: {
        ...pending,
        job: paused ? {
          id: paused.id, status: paused.status,
          doneProjects: paused.doneProjects, totalProjects: paused.totalProjects,
          startedAt: paused.startedAt,
        } : undefined,
      },
      canResume: !active,
      canDiscard: !active,
      canPromoteAnyway: !active && pending.rows > 0,
      jobRunning: !!active,
    });
  });

  /**
   * DISCARD a pending shadow with no job attached (e.g. after a restart).
   * Irreversible; requires an explicit confirm so a stray click cannot
   * destroy banked work.
   */
  router.post('/vectors/shadow/discard', async (req: Request, res: Response): Promise<void> => {
    const { findActiveJob } = await import('./reembedJobs.js');
    if (findActiveJob()) {
      res.status(409).json({ error: 'A re-embed job is running; pause it before discarding the shadow.' });
      return;
    }
    const { getPendingShadowCodeTable, dropShadowCodeTable } = await import('../embedding/lanceConnection.js');
    if (req.body?.confirm !== true) {
      const pending = await getPendingShadowCodeTable();
      res.status(400).json({
        error: 'Discard is irreversible. Re-send with {"confirm":true}.',
        wouldDestroy: pending ? { vectors: pending.rows, projects: pending.projects } : null,
      });
      return;
    }
    const r = await dropShadowCodeTable();
    res.json({ ok: true, ...r, destructive: true });
  });

  /**
   * PROMOTE ANYWAY. Ships a substantially-complete shadow rather than leaving
   * 95% of a rebuild unreachable behind a completeness check. The missing
   * projects will have NO vectors until a fill-missing run — the response says
   * so explicitly and the UI must show it before the click.
   */
  router.post('/vectors/shadow/promote-anyway', async (req: Request, res: Response): Promise<void> => {
    const { findActiveJob, findPausedJob, updateJob } = await import('./reembedJobs.js');
    if (findActiveJob()) {
      res.status(409).json({ error: 'A re-embed job is running; pause it before promoting.' });
      return;
    }
    const { getPendingShadowCodeTable, promoteCodeTable, getActiveCodeTableName, openCodeSlotReadonly } =
      await import('../embedding/lanceConnection.js');
    const pending = await getPendingShadowCodeTable();
    if (!pending) { res.status(404).json({ error: 'No pending shadow to promote' }); return; }

    // promoteCodeTable() DROPS the old slot after flipping the pointer. The
    // confirmation used to describe only what would be gained, so an operator
    // was asked to approve destroying live rows they were never shown — and
    // the active slot is not static: the auto-embed watchdog keeps writing to
    // it, so by the time anyone clicks it can hold far more than when the
    // shadow was started.
    const activeTable = getActiveCodeTableName();
    let activeRows = 0;
    try {
      const t = await openCodeSlotReadonly(activeTable);
      if (t) activeRows = await t.countRows();
    } catch { /* counting is best effort; never block the read-out */ }

    const { getPrismaClient } = await import('../db/prisma.js');
    const total = await getPrismaClient().fantomProject.count();
    const missing = Math.max(0, total - pending.projects);
    if (req.body?.confirm !== true) {
      res.status(400).json({
        error: activeRows > 0
          ? `Promoting replaces the live table and DROPS it: ${activeRows.toLocaleString()} vector(s) in '${activeTable}' will be destroyed, and ${missing} project(s) would have none. Re-send with {"confirm":true}.`
          : 'Promoting an incomplete shadow leaves projects without vectors. Re-send with {"confirm":true}.',
        wouldPromote: { vectors: pending.rows, projects: pending.projects, missingProjects: missing },
        wouldDestroy: { table: activeTable, vectors: activeRows },
        net: pending.rows - activeRows,
      });
      return;
    }
    await promoteCodeTable(pending.name);
    // Close the paused job that produced this slot — leaving it `paused` keeps
    // the UI offering Resume against a slot that no longer exists.
    const paused = findPausedJob();
    if (paused) updateJob(paused.id, { status: 'done', finishedAt: new Date().toISOString() });
    res.json({
      ok: true,
      promoted: pending.name,
      vectors: pending.rows,
      projects: pending.projects,
      missingProjects: missing,
      destroyed: { table: activeTable, vectors: activeRows },
      note: missing > 0
        ? `${missing} project(s) have NO vectors in the promoted table. Run POST /admin/vectors/build-missing to fill them.`
        : 'Every project is represented.',
    });
  });

  // ============================================
  // ============================================
  // Jobs API — surfaces all embed jobs (running + recent) and per-job
  // crash-log slices so the dashboard /jobs page can show live activity
  // and per-job log streams. Aliases the existing reembedJobs store.
  // ============================================
  router.get('/jobs', async (_req: Request, res: Response): Promise<void> => {
    const { listJobs } = await import('./reembedJobs.js');
    res.json({ jobs: listJobs() });
  });

  router.get('/jobs/:id', async (req: Request, res: Response): Promise<void> => {
    const { getJob } = await import('./reembedJobs.js');
    const j = getJob(req.params.id as string);
    if (!j) { res.status(404).json({ error: 'job not found' }); return; }
    res.json(j);
  });

  router.post('/jobs/:id/cancel', async (req: Request, res: Response): Promise<void> => {
    const { requestCancel } = await import('./reembedJobs.js');
    const j = requestCancel(req.params.id as string);
    if (!j) { res.status(404).json({ error: 'job not found' }); return; }
    res.json(j);
  });

  // Per-job log: returns the trailing N lines of the crash forensic file
  // that mention this jobId. Same backing file as /admin/debug/log so
  // RESUME_EMBED + WORKER_N + EMBED_LOOP + BPE + EMBED_SEM all surface.
  router.get('/jobs/:id/log', async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params.id);
    const tailRaw = Number(req.query.tail);
    const tail = Number.isFinite(tailRaw) && tailRaw > 0 ? Math.min(5000, tailRaw) : 500;
    try {
      const fs = await import('node:fs');
      const target = paths.crash;
      if (!fs.existsSync(target)) { res.json({ jobId: id, lines: [] }); return; }
      const stat = fs.statSync(target);
      const READ_BYTES = 4 * 1024 * 1024;
      const start = Math.max(0, stat.size - READ_BYTES);
      const fd = fs.openSync(target, 'r');
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      const text = buf.toString('utf-8');
      const matched = text.split('\n').filter(l => l.includes(id));
      res.json({ jobId: id, lines: matched.slice(-tail), size: stat.size });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Per-job SSE stream: pushes new lines that mention this jobId as they
  // appear in the crash forensic file.
  router.get('/jobs/:id/log/stream', async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params.id);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const fs = await import('node:fs');
    const logPath = paths.crash;
    let lastSize = 0;
    try { lastSize = fs.statSync(logPath).size; } catch { /* file may not exist yet */ }

    const tick = setInterval(() => {
      try {
        if (!fs.existsSync(logPath)) return;
        const stat = fs.statSync(logPath);
        if (stat.size <= lastSize) {
          if (stat.size < lastSize) lastSize = stat.size;
          return;
        }
        const fd = fs.openSync(logPath, 'r');
        const len = stat.size - lastSize;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, lastSize);
        fs.closeSync(fd);
        lastSize = stat.size;
        const lines = buf.toString('utf-8').split('\n').filter(l => l.includes(id));
        for (const line of lines) {
          res.write(`data: ${JSON.stringify({ line })}\n\n`);
        }
      } catch { /* ignore transient read errors */ }
    }, 800);

    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 30000);
    req.on('close', () => {
      clearInterval(tick);
      clearInterval(keepalive);
    });
  });

  // ============================================
  // Embedding Model Management
  // ============================================

  /**
   * GET /admin/models/status
   * Returns download status for all known embedding models
   */
  router.get('/models/status', async (_req: Request, res: Response): Promise<void> => {
    try {
      const { getAllModelStatuses } = await import('../embedding/modelManager.js');
      const models = getAllModelStatuses();
      res.json({ models });
    } catch (error) {
      console.error('[Admin] Model status error:', error);
      const message = error instanceof Error ? error.message : 'Failed to get model statuses';
      res.status(500).json({ error: message });
    }
  });

  /**
   * POST /admin/models/download
   * SSE-streamed model download with progress.
   * Body: { modelId: string }
   */
  router.post('/models/download', async (req: Request, res: Response): Promise<void> => {
    const { modelId } = req.body;

    if (!modelId || typeof modelId !== 'string') {
      res.status(400).json({ error: 'modelId is required' });
      return;
    }

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    try {
      const { downloadModel } = await import('../embedding/modelManager.js');

      await downloadModel(modelId, (progressData) => {
        res.write(`data: ${JSON.stringify(progressData)}\n\n`);
      });

      res.write(`data: ${JSON.stringify({ status: 'done', progress: 100, modelId })}\n\n`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Download failed';
      res.write(`data: ${JSON.stringify({ status: 'error', modelId, error: errMsg })}\n\n`);
    } finally {
      res.end();
    }
  });

  // ============================================
  // Tree-sitter Code Parser
  // ============================================

  // Get available grammars
  router.get('/tree-sitter/grammars', async (_req: Request, res: Response): Promise<void> => {
    try {
      const { getLanguageRegistry } = await import('../parser/treeSitter/languageRegistry.js');
      const registry = getLanguageRegistry();

      const supported = registry.getSupportedLanguages();
      const available = registry.getAvailableGrammars();
      const missing = supported.filter(l => !available.includes(l));

      res.json({ supported, available, missing });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get grammars';
      res.status(500).json({ error: message });
    }
  });

  // Get raw AST tree
  router.post('/tree-sitter/ast', async (req: Request, res: Response): Promise<void> => {
    try {
      const { code, language } = req.body;

      if (!code || typeof code !== 'string') {
        res.status(400).json({ error: 'Code is required' });
        return;
      }

      if (!language || typeof language !== 'string') {
        res.status(400).json({ error: 'Language is required' });
        return;
      }

      const { getTreeSitterParser } = await import('../parser/treeSitter/treeSitterParser.js');
      const parser = await getTreeSitterParser();

      // Get the raw tree
      const startTime = Date.now();
      const tree = await parser.getRawTree(code, language as any);
      const parseTime = Date.now() - startTime;

      if (!tree) {
        res.status(400).json({ error: `Failed to parse code as ${language}` });
        return;
      }

      // Convert tree to JSON-serializable format
      const convertNode = (node: any, depth: number = 0): any => {
        const result: any = {
          type: node.type,
          startPosition: { row: node.startPosition.row, column: node.startPosition.column },
          endPosition: { row: node.endPosition.row, column: node.endPosition.column },
          isNamed: node.isNamed,
          childCount: node.childCount,
        };

        // Add text for leaf nodes or small nodes
        if (node.childCount === 0 || (node.endPosition.row === node.startPosition.row && node.text.length < 100)) {
          result.text = node.text;
        }

        // Limit depth to prevent huge responses
        if (depth < 10 && node.childCount > 0) {
          result.children = [];
          for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child) {
              result.children.push(convertNode(child, depth + 1));
            }
          }
        } else if (node.childCount > 0) {
          result.truncated = true;
          result.childCount = node.childCount;
        }

        return result;
      };

      const rootNode = tree.rootNode;
      const ast = convertNode(rootNode);

      res.json({
        success: true,
        language,
        parseTime,
        rootNode: ast,
        hasErrors: tree.rootNode.hasError,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to parse code';
      res.status(500).json({ error: message });
    }
  });

  // Parse code
  router.post('/tree-sitter/parse', async (req: Request, res: Response): Promise<void> => {
    try {
      const { code, language } = req.body;

      if (!code || typeof code !== 'string') {
        res.status(400).json({ error: 'Code is required' });
        return;
      }

      if (!language || typeof language !== 'string') {
        res.status(400).json({ error: 'Language is required' });
        return;
      }

      const { getTreeSitterParser } = await import('../parser/treeSitter/treeSitterParser.js');
      const parser = await getTreeSitterParser();

      const result = await parser.parseSource(code, language as any, {
        extractBodies: false,
        extractCalls: true,
        extractDocs: true,
      });

      res.json({
        success: result.success,
        language: result.language,
        parseTime: result.parseTime,
        classes: result.classes,
        functions: result.functions,
        interfaces: result.interfaces,
        imports: result.imports,
        exports: result.exports,
        errors: result.errors,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to parse code';
      res.status(500).json({ error: message });
    }
  });

  // ============================================
  // Extract Functions from Files
  // ============================================

  /**
   * Extract functions/classes/interfaces from files using tree-sitter
   *
   * Supports two modes:
   * 1. Single file: { filePath: string, language: string }
   * 2. Project scan: { projectPath: string, languages: string[] }
   *
   * Returns extracted code structures with location information.
   */
  router.post('/tree-sitter/extract-functions', async (req: Request, res: Response): Promise<void> => {
    try {
      const { filePath, language, projectPath, languages } = req.body;

      // Validate input - must provide either single file or project scan params
      const isSingleFile = filePath && language;
      const isProjectScan = projectPath && languages && Array.isArray(languages);

      if (!isSingleFile && !isProjectScan) {
        res.status(400).json({
          error: 'Invalid parameters. Provide either { filePath, language } for single file or { projectPath, languages } for project scan.'
        });
        return;
      }

      const { getTreeSitterParser } = await import('../parser/treeSitter/treeSitterParser.js');
      const { getLanguageRegistry } = await import('../parser/treeSitter/languageRegistry.js');
      const parser = await getTreeSitterParser();
      const registry = getLanguageRegistry();

      // Result type for extracted functions
      interface ExtractedItem {
        name: string;
        qualifiedName: string;
        type: 'function' | 'method' | 'class' | 'interface';
        filePath: string;
        lineStart: number;
        lineEnd: number;
        signature?: string;
        language: string;
      }

      const functions: ExtractedItem[] = [];

      if (isSingleFile) {
        // Single file mode
        if (!fs.existsSync(filePath)) {
          res.status(404).json({ error: `File not found: ${filePath}` });
          return;
        }

        // Handle .trio files in single file mode
        if (filePath.endsWith('.trio')) {
          const { TrioParser } = await import('../fantom-code/trioParser.js');
          const trioParser = new TrioParser(0, path.basename(path.dirname(path.dirname(filePath))));
          const trioResult = await trioParser.parseFile(filePath);

          for (const func of trioResult.functions) {
            functions.push({
              name: func.name,
              qualifiedName: func.qualifiedName,
              type: 'function',
              filePath,
              lineStart: func.lineNumber || 1,
              lineEnd: (func.lineNumber || 1) + (func.sourceCode?.split('\n').length || 1),
              signature: func.signature,
              language: 'axon',
            });
          }
          for (const typeDef of trioResult.types) {
            functions.push({
              name: typeDef.name,
              qualifiedName: typeDef.qualifiedName,
              type: 'class',
              filePath,
              lineStart: typeDef.lineNumber || 1,
              lineEnd: (typeDef.lineNumber || 1) + 1,
              signature: typeDef.documentation?.substring(0, 120) || typeDef.name,
              language: 'axon',
            });
            for (const method of typeDef.methods) {
              functions.push({
                name: method.name,
                qualifiedName: method.qualifiedName,
                type: 'method',
                filePath,
                lineStart: method.lineNumber || 1,
                lineEnd: (method.lineNumber || 1) + 1,
                signature: method.signature || method.name,
                language: 'axon',
              });
            }
          }

          res.json({
            success: true,
            mode: 'single',
            filePath,
            language: 'trio/axon',
            functions,
            parseTime: 0,
            errors: trioResult.errors,
          });
          return;
        }

        const source = fs.readFileSync(filePath, 'utf-8');
        const result = await parser.parseSource(source, language as any, {
          extractBodies: false,
          extractCalls: false,
          extractDocs: true,
        });

        // Extract classes
        for (const cls of result.classes) {
          functions.push({
            name: cls.name,
            qualifiedName: cls.qualifiedName,
            type: 'class',
            filePath,
            lineStart: cls.location.startLine,
            lineEnd: cls.location.endLine,
            signature: `class ${cls.name}${cls.extends ? ` extends ${cls.extends}` : ''}${cls.implements.length > 0 ? ` implements ${cls.implements.join(', ')}` : ''}`,
            language,
          });

          // Extract methods from class
          for (const method of cls.methods) {
            functions.push({
              name: method.name,
              qualifiedName: method.qualifiedName,
              type: 'method',
              filePath,
              lineStart: method.location.startLine,
              lineEnd: method.location.endLine,
              signature: method.signature,
              language,
            });
          }
        }

        // Extract interfaces
        for (const iface of result.interfaces) {
          functions.push({
            name: iface.name,
            qualifiedName: iface.qualifiedName,
            type: 'interface',
            filePath,
            lineStart: iface.location.startLine,
            lineEnd: iface.location.endLine,
            signature: `interface ${iface.name}${iface.extends.length > 0 ? ` extends ${iface.extends.join(', ')}` : ''}`,
            language,
          });

          // Extract methods from interface
          for (const method of iface.methods) {
            functions.push({
              name: method.name,
              qualifiedName: method.qualifiedName,
              type: 'method',
              filePath,
              lineStart: method.location.startLine,
              lineEnd: method.location.endLine,
              signature: method.signature,
              language,
            });
          }
        }

        // Extract top-level functions
        for (const func of result.functions) {
          functions.push({
            name: func.name,
            qualifiedName: func.qualifiedName,
            type: 'function',
            filePath,
            lineStart: func.location.startLine,
            lineEnd: func.location.endLine,
            signature: func.signature,
            language,
          });
        }

        res.json({
          success: true,
          mode: 'single',
          filePath,
          language,
          functions,
          parseTime: result.parseTime,
          errors: result.errors,
        });
      } else {
        // Project scan mode
        if (!fs.existsSync(projectPath)) {
          res.status(404).json({ error: `Project path not found: ${projectPath}` });
          return;
        }

        const stats = fs.statSync(projectPath);
        if (!stats.isDirectory()) {
          res.status(400).json({ error: `Path is not a directory: ${projectPath}` });
          return;
        }

        // Build extension to language map for requested languages
        const requestedExtensions = new Map<string, string>();
        for (const lang of languages) {
          const config = registry.getLanguage(lang as any);
          if (config) {
            for (const ext of config.extensions) {
              requestedExtensions.set(`.${ext}`, lang);
            }
          }
          // Include .trio files when axon or trio language is requested
          if (lang === 'axon' || lang === 'trio') {
            requestedExtensions.set('.trio', 'trio');
            // Also include .axon files for trio-language projects
            if (lang === 'trio') {
              requestedExtensions.set('.axon', 'axon');
            }
          }
        }

        // Recursively find matching files
        const findFiles = (dir: string, files: string[] = []): string[] => {
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);

              // Skip common ignore patterns
              if (entry.name.startsWith('.') ||
                  entry.name === 'node_modules' ||
                  entry.name === 'dist' ||
                  entry.name === 'build' ||
                  entry.name === 'vendor' ||
                  entry.name === '__pycache__') {
                continue;
              }

              if (entry.isDirectory()) {
                findFiles(fullPath, files);
              } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (requestedExtensions.has(ext)) {
                  files.push(fullPath);
                }
              }
            }
          } catch (err) {
            // Skip directories we can't read
          }
          return files;
        };

        const files = findFiles(projectPath);
        let totalParseTime = 0;
        const allErrors: Array<{ file: string; errors: any[] }> = [];
        const processedFiles: string[] = [];

        // Process each file
        for (const file of files) {
          const ext = path.extname(file).toLowerCase();
          const fileLang = requestedExtensions.get(ext);
          if (!fileLang) continue;

          try {
            // Handle .trio files: extract Axon src and parse each function with tree-sitter
            if (ext === '.trio') {
              const { TrioParser } = await import('../fantom-code/trioParser.js');
              const trioParser = new TrioParser(0, path.basename(path.dirname(path.dirname(file))));
              const trioResult = await trioParser.parseFile(file);
              processedFiles.push(file);

              // Add trio functions
              for (const func of trioResult.functions) {
                const item: ExtractedItem = {
                  name: func.name,
                  qualifiedName: func.qualifiedName,
                  type: 'function',
                  filePath: file,
                  lineStart: func.lineNumber || 1,
                  lineEnd: (func.lineNumber || 1) + (func.sourceCode?.split('\n').length || 1),
                  signature: func.signature,
                  language: 'axon',
                };

                // Also parse with tree-sitter for richer extraction if source available
                if (func.sourceCode) {
                  try {
                    const tsResult = await parser.parseSource(func.sourceCode, 'axon' as any, {
                      extractBodies: false, extractCalls: false, extractDocs: true,
                    });
                    if (tsResult.functions.length > 0) {
                      const tsFunc = tsResult.functions[0];
                      item.signature = tsFunc.signature || item.signature;
                    }
                  } catch { /* use regex-parsed result */ }
                }
                functions.push(item);
              }

              // Add trio views and apps
              for (const typeDef of trioResult.types) {
                functions.push({
                  name: typeDef.name,
                  qualifiedName: typeDef.qualifiedName,
                  type: 'class',
                  filePath: file,
                  lineStart: typeDef.lineNumber || 1,
                  lineEnd: (typeDef.lineNumber || 1) + 1,
                  signature: typeDef.documentation?.substring(0, 120) || typeDef.name,
                  language: 'axon',
                });

                // Add subview methods
                for (const method of typeDef.methods) {
                  functions.push({
                    name: method.name,
                    qualifiedName: method.qualifiedName,
                    type: 'method',
                    filePath: file,
                    lineStart: method.lineNumber || 1,
                    lineEnd: (method.lineNumber || 1) + 1,
                    signature: method.signature || method.name,
                    language: 'axon',
                  });
                }
              }
              continue;
            }

            const source = fs.readFileSync(file, 'utf-8');

            // Skip very large files (> 1MB)
            if (source.length > 1024 * 1024) {
              continue;
            }

            const result = await parser.parseSource(source, fileLang as any, {
              extractBodies: false,
              extractCalls: false,
              extractDocs: true,
            });

            totalParseTime += result.parseTime;
            processedFiles.push(file);

            if (result.errors.length > 0) {
              allErrors.push({ file, errors: result.errors });
            }

            // Extract classes
            for (const cls of result.classes) {
              functions.push({
                name: cls.name,
                qualifiedName: cls.qualifiedName,
                type: 'class',
                filePath: file,
                lineStart: cls.location.startLine,
                lineEnd: cls.location.endLine,
                signature: `class ${cls.name}${cls.extends ? ` extends ${cls.extends}` : ''}${cls.implements.length > 0 ? ` implements ${cls.implements.join(', ')}` : ''}`,
                language: fileLang,
              });

              // Extract methods
              for (const method of cls.methods) {
                functions.push({
                  name: method.name,
                  qualifiedName: method.qualifiedName,
                  type: 'method',
                  filePath: file,
                  lineStart: method.location.startLine,
                  lineEnd: method.location.endLine,
                  signature: method.signature,
                  language: fileLang,
                });
              }
            }

            // Extract interfaces
            for (const iface of result.interfaces) {
              functions.push({
                name: iface.name,
                qualifiedName: iface.qualifiedName,
                type: 'interface',
                filePath: file,
                lineStart: iface.location.startLine,
                lineEnd: iface.location.endLine,
                signature: `interface ${iface.name}${iface.extends.length > 0 ? ` extends ${iface.extends.join(', ')}` : ''}`,
                language: fileLang,
              });

              // Extract methods from interface
              for (const method of iface.methods) {
                functions.push({
                  name: method.name,
                  qualifiedName: method.qualifiedName,
                  type: 'method',
                  filePath: file,
                  lineStart: method.location.startLine,
                  lineEnd: method.location.endLine,
                  signature: method.signature,
                  language: fileLang,
                });
              }
            }

            // Extract top-level functions
            for (const func of result.functions) {
              functions.push({
                name: func.name,
                qualifiedName: func.qualifiedName,
                type: 'function',
                filePath: file,
                lineStart: func.location.startLine,
                lineEnd: func.location.endLine,
                signature: func.signature,
                language: fileLang,
              });
            }
          } catch (err) {
            // Skip files that fail to parse
            const errMsg = err instanceof Error ? err.message : String(err);
            allErrors.push({ file, errors: [{ message: errMsg, type: 'error' }] });
          }
        }

        res.json({
          success: true,
          mode: 'project',
          projectPath,
          languages,
          filesProcessed: processedFiles.length,
          filesFound: files.length,
          functions,
          totalParseTime,
          errors: allErrors.length > 0 ? allErrors : undefined,
        });
      }
    } catch (error) {
      console.error('[Admin] Extract functions error:', error);
      const message = error instanceof Error ? error.message : 'Failed to extract functions';
      res.status(500).json({ error: message });
    }
  });

  // ============================================
  // Staleness Detection
  // ============================================

  router.get('/code-projects/:id/staleness', async (req: Request, res: Response): Promise<void> => {
    try {
      const id = parseInt(req.params.id as string, 10);
      const projectPath = req.query.projectPath as string | undefined;

      const { getPrismaClient } = await import('../db/prisma.js');
      const prisma = getPrismaClient();
      const { checkStaleness: checkStale } = await import('../graph/stalenessChecker.js');
      const result = await checkStale(prisma, id, projectPath);
      res.json(result);
    } catch (error) {
      console.error('[Admin] Staleness check failed:', error);
      res.status(500).json({ error: 'Staleness check failed', details: String(error) });
    }
  });

  // ============================================
  // Indexing Pipeline Progress (SSE)
  // ============================================

  router.get('/indexing/progress', async (req: Request, res: Response): Promise<void> => {
    try {
      // `require` is undefined in this ESM tree — @types/node declares it so
      // tsc accepts it, but at runtime it throws a ReferenceError straight
      // into the catch below, so this SSE stream has been answering 500 on
      // every connection. Same failure the comment near the top of this file
      // records for the AST tab.
      const { pipelineEvents } = await import('../fantom-code/indexingPipeline.js');

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const onProgress = (progress: unknown) => {
        res.write(`data: ${JSON.stringify(progress)}\n\n`);
      };

      pipelineEvents.on('progress', onProgress);

      req.on('close', () => {
        pipelineEvents.off('progress', onProgress);
      });
    } catch (error) {
      console.error('[Admin] Indexing progress SSE failed:', error);
      res.status(500).json({ error: 'Indexing progress not available' });
    }
  });

  /**
   * GET /admin/indexing/state/:projectId
   * Most recent PipelineProgress snapshot for a project, so the dashboard
   * paints live state on first render without waiting for an SSE event.
   */
  router.get('/indexing/state/:projectId', async (req: Request, res: Response): Promise<void> => {
    try {
      const projectId = parseInt(req.params.projectId as string, 10);
      const { getLatestPipelineProgress, isPipelineRunning } = await import(
        '../fantom-code/indexingPipeline.js'
      );
      res.json({
        projectId,
        running: isPipelineRunning(projectId),
        snapshot: getLatestPipelineProgress(projectId),
      });
    } catch (error) {
      console.error('[Admin] Indexing state failed:', error);
      res.status(500).json({ error: 'Failed to get indexing state' });
    }
  });

  /**
   * GET /admin/indexing/status
   * Lightweight summary of all currently-running pipelines. Used by the home
   * dashboard "N projects indexing now" indicator.
   */
  router.get('/indexing/status', async (_req: Request, res: Response): Promise<void> => {
    try {
      const { listRunningPipelines, getLatestPipelineProgress } = await import(
        '../fantom-code/indexingPipeline.js'
      );
      const ids = listRunningPipelines();
      res.json({
        count: ids.length,
        running: ids.map((id) => {
          const snap = getLatestPipelineProgress(id);
          return {
            projectId: id,
            projectName: snap?.projectName ?? null,
            currentStage: snap?.currentStage ?? null,
          };
        }),
      });
    } catch (error) {
      console.error('[Admin] Indexing status failed:', error);
      res.status(500).json({ error: 'Failed to get indexing status' });
    }
  });

  /**
   * GET /admin/ast/coverage
   * Aggregate AST coverage across all projects, for the home dashboard global
   * progress panel.
   *
   * Cross-project AST denominator is project-granular, not file-granular: we
   * have no canonical "expected file count" outside an active pipeline run,
   * so the truthful global metric is "how many projects have at least one
   * indexed node." Per-project file-level progress is delivered via SSE
   * during runs.
   */
  router.get('/ast/coverage', async (_req: Request, res: Response): Promise<void> => {
    try {
      const { getPrismaClient } = await import('../db/prisma.js');
      const prisma = getPrismaClient();
      const { listRunningPipelines } = await import('../fantom-code/indexingPipeline.js');

      const projects = await prisma.fantomProject.findMany({
        select: { id: true, functionCount: true, typeCount: true, lastIndexed: true },
      });

      let indexed = 0;
      let totalNodes = 0;
      for (const p of projects) {
        const nodes = (p.functionCount ?? 0) + (p.typeCount ?? 0);
        totalNodes += nodes;
        if (nodes > 0 && p.lastIndexed) indexed++;
      }
      const total = projects.length;
      const notIndexed = total - indexed;
      const projectsIndexing = listRunningPipelines().length;

      res.json({
        totalProjects: total,
        indexedProjects: indexed,
        notIndexedProjects: notIndexed,
        coveragePercent: total > 0 ? Number(((indexed / total) * 100).toFixed(1)) : 0,
        projectsIndexing,
        totalNodes,
      });
    } catch (error) {
      console.error('[Admin] AST coverage failed:', error);
      res.status(500).json({ error: 'Failed to compute AST coverage' });
    }
  });

  router.post('/indexing/run/:projectId', async (req: Request, res: Response): Promise<void> => {
    try {
      const projectId = parseInt(req.params.projectId as string, 10);
      const options = req.body || {};

      const { getPrismaClient } = await import('../db/prisma.js');
      const prisma = getPrismaClient();

      const project = await prisma.fantomProject.findUnique({ where: { id: projectId } });
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      const { runIndexingPipeline, isPipelineRunning } = await import('../fantom-code/indexingPipeline.js');

      if (isPipelineRunning(projectId)) {
        res.status(409).json({ error: 'Pipeline already running for this project' });
        return;
      }

      const { getCodeIndexingService } = await import('../fantom-code/index.js');
      const indexingService = getCodeIndexingService(prisma);

      // Run in background, return immediately
      runIndexingPipeline(prisma, indexingService, projectId, project.name, options)
        .catch(err => console.error(`[Admin] Pipeline failed: ${err}`));

      res.json({ status: 'started', projectId, projectName: project.name });
    } catch (error) {
      console.error('[Admin] Indexing pipeline start failed:', error);
      res.status(500).json({ error: 'Failed to start indexing pipeline', details: String(error) });
    }
  });

  router.post('/indexing/cancel/:projectId', async (req: Request, res: Response): Promise<void> => {
    try {
      const projectId = parseInt(req.params.projectId as string, 10);
      const { cancelIndexingPipeline } = await import('../fantom-code/indexingPipeline.js');
      const cancelled = cancelIndexingPipeline(projectId);
      res.json({ cancelled, projectId });
    } catch (error) {
      console.error('[Admin] Indexing cancel failed:', error);
      res.status(500).json({ error: 'Failed to cancel pipeline' });
    }
  });

  // ─── Sidecar Registry ──────────────────────────────────────────────────
  router.get('/sidecars', async (req: Request, res: Response): Promise<void> => {
    const capability = req.query.capability as SidecarCapabilityKind | undefined;
    const enabledStr = req.query.enabled as string | undefined;
    const enabled = enabledStr === undefined ? undefined : enabledStr === 'true';
    const { isSidecarConnected } = await import('../sidecars/wsServer.js');
    const { getEmbedFault } = await import('../embedding/providers/embedFaults.js');
    // Sidecars ≥2.x connect to the Sound Suite master relay (ws://:3003/sidecar),
    // not to /ws/sidecars, so ask that listener too: a peer whose last heartbeat
    // over the relay is under 90 s old counts as WS-connected.
    let relayPeers: Array<{ agentUrl: string; lastHeartbeatAgoMs: number | null }> = [];
    try {
      const { getMasterWsListenerStatus } = await import('../sidecars/soundsuiteMaster.js');
      relayPeers = getMasterWsListenerStatus().peers;
    } catch { /* relay not running */ }
    const relayConnected = (host: string): boolean =>
      relayPeers.some(p => p.agentUrl.includes(`//${host}:`) && p.lastHeartbeatAgoMs !== null && p.lastHeartbeatAgoMs < 90_000);
    const sidecars = listSidecars({ capability, enabled }).map(s => ({
      ...s,
      wsConnected: isSidecarConnected(s.id) || relayConnected(s.host),
      // Capability fault: up and heartbeating, but its runtime refuses to embed
      // with the advertised model (see embedFaults.ts). null when none.
      embedFault: getEmbedFault(s.id),
    }));
    // OpenRouter-backed providers. They hang off a host but are NOT that
    // host's GPU — no VRAM, no gpuPercent — so they are returned as their own
    // rows rather than folded into `capabilities`, and the Fleet panel marks
    // them cloud-backed. `slots` reports, per sidecar, whether OpenRouter is
    // configured for FANTOM's master slot specifically: capacity configured
    // for another master is deliberately unusable here, and that is the single
    // most likely reason this list is empty.
    const { listAllVirtualContainers, getSlotStatus, readMasterWsPort } =
      await import('../sidecars/virtualContainers.js');
    const { getLastRerankAttribution } = await import('../embedding/rerankRouter.js');
    const virtual = listAllVirtualContainers().map(v => ({
      ...v, cloudBacked: true, gpuPercent: null, vramMb: null,
    }));
    res.json({
      sidecars,
      total: sidecars.length,
      virtual,
      virtualTotal: virtual.length,
      masterWsPort: readMasterWsPort(),
      slots: getSlotStatus(),
      lastRerank: getLastRerankAttribution(),
    });
  });

  // ─── OpenRouter virtual-inference config ─────────────────────────────────
  // Fantom pushes its OWN OpenRouter config to the fleet. The sidecar scopes
  // key, allow-list and modes per master, so capacity configured for another
  // master is deliberately unusable here — pushing our own is the only way
  // Fantom gets cloud capacity at all.
  //
  // The key is write-only across this whole surface: accepted on POST,
  // forwarded on the WS frame, never stored, logged or returned. GET reports
  // only whether one has ever been pushed.

  /**
   * Split the most recent embedding pass of every project by who served it.
   *
   * Cheap — one small JSON file. It is here rather than in the panel because
   * "were these vectors built locally?" is a question about stored data, and
   * guessing at it from the policy would be exactly the kind of
   * plausible-but-unchecked warning an operator learns to dismiss.
   */
  async function storedVectorOrigin(): Promise<{
    local: { providers: string[]; texts: number; projects: number };
    cloud: { providers: string[]; texts: number; projects: number };
  }> {
    const empty = () => ({ providers: [] as string[], texts: 0, projects: 0 });
    const out = { local: empty(), cloud: empty() };
    try {
      const { getFleetEmbeddingSplit } = await import('../embedding/projectEmbeddingMeta.js');
      for (const row of getFleetEmbeddingSplit()) {
        const bucket = row.cloud ? out.cloud : out.local;
        bucket.providers.push(row.provider);
        bucket.texts += row.texts;
        bucket.projects += row.projects;
      }
    } catch { /* no attribution on file yet — the panel says nothing rather than guessing */ }
    return out;
  }

  router.get('/openrouter', async (_req: Request, res: Response): Promise<void> => {
    const { getOpenRouterSettings, defaultOpenRouterSettings, validateOpenRouterSettings } =
      await import('../sidecars/openRouterConfig.js');
    const { listAllVirtualContainers, getSlotStatus, readMasterWsPort, getVirtualContainersConfig } =
      await import('../sidecars/virtualContainers.js');
    const { isSoundSuiteSidecarConnected } = await import('../sidecars/soundsuiteMaster.js');
    const { isRoleServable } = await import('../sidecars/virtualContainers.js');
    const { cloudBudgetStats, hydrateCloudBudgetFromConfig, refreshCloudBudgetFromKey,
      MAX_ALLOWED_CONCURRENCY, CONSERVATIVE_DEFAULT_CONCURRENCY } =
      await import('../embedding/providers/cloudBudget.js');
    await hydrateCloudBudgetFromConfig();
    // TTL-cached (10 min); this only re-probes when it has gone stale.
    await refreshCloudBudgetFromKey().catch(() => undefined);

    const { catalogueFor, modelHint, optionLabel, ROLE_LOCAL, CODE_TABLE_DIMS,
      RLM_CATALOGUE, RLM_FALLBACK_MODES, DEFAULT_RLM_SANDBOX_MODEL, DEFAULT_RLM_FALLBACK_MODE,
      rlmOptionLabel, isRlmCapable } =
      await import('../sidecars/openRouterModels.js');
    const { allActivity, spendTodayTotal, getDailyCaps } = await import('../sidecars/openRouterActivity.js');
    const {
      ROUTING_POLICIES, POLICY_LABEL, sanitizePolicies, detectPolicyDrift,
      aggregateIsMeaningful, effectiveBehaviour, policiesFor,
    } = await import('../sidecars/routingPolicy.js');

    const stored = getOpenRouterSettings();
    const hasAny = Object.keys(stored.allowedModels).length > 0;
    const settings = hasAny ? stored : defaultOpenRouterSettings();
    res.json({
      settings,
      isDefault: !hasAny,
      keyPushed: stored.keyPushed === true,
      keyLast4: stored.keyLast4 ?? null,
      issues: validateOpenRouterSettings(settings, { hasKey: false }),
      masterWsPort: readMasterWsPort(),
      masterServerUrl: getVirtualContainersConfig().masterServerUrl ?? null,
      slots: getSlotStatus(),
      // The permit unit is ONE CONCURRENT CLOUD REQUEST — that is what the
      // pool hands out and what `manualConcurrency` caps.
      budget: {
        ...cloudBudgetStats(),
        unit: 'concurrent cloud requests',
        maxAllowed: MAX_ALLOWED_CONCURRENCY,
        conservativeDefault: CONSERVATIVE_DEFAULT_CONCURRENCY,
      },
      virtual: listAllVirtualContainers(),
      // Cloud routing is OPT-IN: while this is false nothing calls out to
      // OpenRouter and every role stays local.
      enabled: getVirtualContainersConfig().enabled === true,
      // Dropdown options + the hint under each, which is where the re-index
      // consequence of a width mismatch becomes visible.
      // The operator-facing routing choice. The sidecar's
      // local-only/local-first/cloud-only vocabulary is deliberately NOT
      // exposed — see routingPolicy.ts.
      policyByRole: sanitizePolicies(stored.policyByRole),
      policyOptions: ROUTING_POLICIES.map(p => ({ id: p, label: POLICY_LABEL[p] })),
      // Still per role, though every role now offers all four: the shape is
      // the hook for the next policy that is legal for one role and not
      // another, and the panel already reads it. "OpenRouter only" used to be
      // withheld from the docs embedder because nothing routed docs vectors to
      // cloud; that path is wired now. See routingPolicy.policySupported.
      policyOptionsByRole: Object.fromEntries(
        (['code-embedding', 'embedding', 'reranker', 'code-assistant', 'rlm'] as const).map(role => [
          role, policiesFor(role).map(p => ({ id: p, label: POLICY_LABEL[p] })),
        ]),
      ),
      // A stored policy that never reached the sidecars looks identical to one
      // in effect. This compares against what the fleet ACTUALLY reports, so
      // an inert setting is visible instead of silently believed.
      policyDrift: detectPolicyDrift(
        sanitizePolicies(stored.policyByRole),
        listAllVirtualContainers().map(v => ({ role: v.role, mode: v.mode, providerName: v.providerName })),
      ),
      policyNotes: (['code-embedding', 'embedding', 'reranker', 'code-assistant', 'rlm'] as const).map(role => ({
        role,
        aggregateMeaningful: aggregateIsMeaningful(role),
        joinsFanOut: effectiveBehaviour(role, sanitizePolicies(stored.policyByRole)[role]!).joinsFanOut,
      })),
      // Who actually produced the rows now in code_vectors. Choosing
      // "OpenRouter only" invalidates every locally-built one — a local vector
      // and a cloud one are 0.976 apart, so the cloud query encoder that
      // policy installs cannot search them. `projectEmbeddingMeta.servedBy`
      // records this per project, so the panel can say how much work is at
      // stake instead of warning in the abstract.
      storedVectorOrigin: await storedVectorOrigin(),
      catalogue: (['code-embedding', 'embedding', 'reranker', 'code-assistant', 'rlm'] as const).map(role => ({
        role,
        label: ROLE_LOCAL[role].label,
        // "<Label> · <dims>d [· drop-in] [· text-only]" — no provider name.
        // `dims` rides along unrendered so the panel can compare the chosen
        // model against the table's locked width without parsing the label.
        options: catalogueFor(role).map(m => ({ id: m.id, label: optionLabel(role, m), dims: m.dims })),
        hint: modelHint(role),
        // A role the sidecar can be CONFIGURED for but cannot yet SERVE. The
        // setting pushes and reports like any other; nothing issues the
        // request. Surfaced rather than left for someone to discover.
        servable: isRoleServable(role),
      })),
      codeTableDims: CODE_TABLE_DIMS,
      // The width each embedding table is actually committed to. LanceDB locks
      // the vector column at creation, so a model whose width differs cannot
      // write into the table at all — this is what lets the panel say "picking
      // this rebuilds docs_vectors" at the point of choice rather than after.
      tableDims: {
        'code-embedding': context.getSettings()?.semanticSearch?.codeDimensions ?? 2560,
        'embedding': context.getSettings()?.semanticSearch?.docsDimensions ?? 1024,
      },
      // ── RLM sandbox fallback — THIS master's setting ────────────────────
      // Stored per master and not pushed: Fantom's ss-rlm-sandbox half is not
      // implemented (no `domain: 'code'` in the push, no HTTP exposure of
      // search_code/search_symbols/search_files), so a control that looked
      // live would be a setting that saves cleanly and does nothing. `wired`
      // is false and the panel badges it, exactly as the code-assistant
      // picker is badged.
      rlm: {
        wired: false,
        model: stored.rlmSandboxModel ?? DEFAULT_RLM_SANDBOX_MODEL,
        mode: stored.rlmFallbackMode ?? DEFAULT_RLM_FALLBACK_MODE,
        // A stored model outside the catalogue is offered rather than dropped,
        // so the control never silently displays something other than what is
        // saved.
        options: [
          ...(stored.rlmSandboxModel && !isRlmCapable(stored.rlmSandboxModel)
            ? [{ id: stored.rlmSandboxModel, label: `${stored.rlmSandboxModel} — currently saved, not in the tools+reasoning list` }]
            : []),
          ...RLM_CATALOGUE.map(m => ({ id: m.id, label: rlmOptionLabel(m) })),
        ],
        modeOptions: RLM_FALLBACK_MODES,
        hint: `The RLM loop plans, calls a tool, reads the result and decides what to ask next over several `
          + `rounds, so only models supporting BOTH tools and reasoning are listed — ${RLM_CATALOGUE.length} of `
          + `${catalogueFor('code-assistant').length} in the catalogue. This is Fantom's own choice; the Sound Suite master `
          + `configures its own on the same fleet and the two never overwrite each other.`,
      },
      activity: allActivity(),
      spendToday: spendTodayTotal(),
      dailyCaps: getDailyCaps(),
      sidecars: listSidecars({ enabled: true }).map(s => ({
        id: s.id, name: s.name, host: s.host, port: s.port,
        wsConnected: isSoundSuiteSidecarConnected(s.id),
      })),
    });
  });

  router.post('/openrouter', async (req: Request, res: Response): Promise<void> => {
    const { getOpenRouterSettings, pushOpenRouterConfig, validateOpenRouterSettings } =
      await import('../sidecars/openRouterConfig.js');
    const { refreshAllVirtualContainers } = await import('../sidecars/virtualContainers.js');

    const body = (req.body ?? {}) as Record<string, unknown>;
    // Used once, in memory, then dropped. Never assigned into `settings`.
    const apiKey = typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : undefined;
    const { sanitizePolicies, modesFromPolicies } = await import('../sidecars/routingPolicy.js');
    const stored = getOpenRouterSettings();
    // `modeByRole` is DERIVED from the policy and is never accepted from the
    // client. That is what keeps the two from drifting apart in config, and it
    // guarantees every role gets a mode — an omitted role reads as local-only
    // on the sidecar, which once left 15 configured providers unable to call
    // OpenRouter with nothing in the UI to say why.
    const policyByRole = sanitizePolicies(body.policyByRole ?? stored.policyByRole);

    // Re-attach the upstream pin and width from the catalogue, server-side.
    // The UI deliberately renders no provider names, so it sends only
    // { model }. Taking that verbatim dropped the pin that was already on
    // file, and validation then refused the save with 400 "no pinned upstream
    // provider" — the operator could not fix it because the field they would
    // need is the one we hide on purpose. The catalogue already knows each
    // model's pin (`pinProvider`) and width, so derive both here rather than
    // asking the client for something it must not send.
    const { findModel, catalogueFor } = await import('../sidecars/openRouterModels.js');
    const withPins = (raw: unknown): unknown => {
      if (!raw || typeof raw !== 'object') return raw;
      const out: Record<string, unknown> = {};
      for (const [role, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!v || typeof v !== 'object') { out[role] = v; continue; }
        const entry = { ...(v as Record<string, unknown>) };
        const id = typeof entry.model === 'string' ? entry.model : undefined;
        const cat = id ? findModel(id) : undefined;
        if (cat?.pinProvider && !entry.provider) entry.provider = cat.pinProvider;
        if (cat?.dims !== undefined && entry.dims === undefined) entry.dims = cat.dims;
        out[role] = entry;
      }
      // A role whose policy routes to cloud but that carries no model is a
      // configuration the sidecar cannot honour — it falls back to local and
      // logs a misconfiguration. That was blocking every save with a 400 the
      // operator could not clear, because the new code-assistant role has no
      // stored model yet and defaults to a cloud-routable policy. Fill it from
      // the catalogue instead of refusing the save.
      for (const [role, policy] of Object.entries(policyByRole as Record<string, string>)) {
        if (policy === 'local') continue;
        if (out[role]) continue;
        const first = catalogueFor(role as never)[0];
        if (first) {
          out[role] = first.pinProvider
            ? { model: first.id, provider: first.pinProvider, dims: first.dims }
            : { model: first.id };
        }
      }
      return out;
    };

    // ── RLM sandbox: an untouched control must never write ───────────────
    //
    // `undefined` means "leave alone"; anything else is an explicit choice.
    // Note what is NOT accepted: the empty string. Sound Suite's page posts
    // `rlmSandboxModel: ''` when its state has not been seeded yet, its API
    // guards with `typeof body.x === 'string'`, and `''` passes — so changing
    // a routing dropdown there silently clears a configured RLM model. That
    // is the reported "I can't save the page changing it", and treating blank
    // as no-change is what stops it happening here.
    //
    // The id is validated against the catalogue before it is stored. An id
    // that reaches a sidecar and does not resolve upstream fails at call time,
    // which is far from the dropdown that caused it.
    const { isRlmCapable, isRlmFallbackMode } = await import('../sidecars/openRouterModels.js');
    const rlmModelRaw = typeof body.rlmSandboxModel === 'string' ? body.rlmSandboxModel.trim() : '';
    const rlmSandboxModel = rlmModelRaw
      ? (isRlmCapable(rlmModelRaw) ? rlmModelRaw : undefined)
      : undefined;
    if (rlmModelRaw && !rlmSandboxModel) {
      res.status(400).json({
        error: `'${rlmModelRaw}' is not a model the RLM loop can drive. It needs both tool calling and `
          + 'reasoning support; pick one from the list.',
      });
      return;
    }

    const settings = {
      allowedModels: withPins(body.allowedModels ?? stored.allowedModels) as any,
      policyByRole,
      modeByRole: modesFromPolicies(policyByRole) as any,
      keyPushed: stored.keyPushed,
      keyLast4: stored.keyLast4,
      rlmSandboxModel: rlmSandboxModel ?? stored.rlmSandboxModel,
      rlmFallbackMode: isRlmFallbackMode(body.rlmFallbackMode)
        ? body.rlmFallbackMode
        : stored.rlmFallbackMode,
    };

    // Enable/disable cloud routing. Off is the safe state and the default:
    // no key is spent and every role resolves locally.
    if (typeof body.enabled === 'boolean') {
      // `updateSettings` shallow-merges `semanticSearch`, so sending only this
      // one key preserves every sibling (maxConcurrentProjects,
      // codeDimensions, verificationReferenceSidecar, openRouter…) without
      // this handler having to read and re-send them. `virtualContainers`
      // itself IS replaced wholesale by that merge, so its own siblings do
      // have to be read — but the stale-read window is one nested object
      // instead of the whole subtree. This file has three co-writers and a
      // history of losing dashboard settings; the narrower the write, the
      // less a lost race can cost.
      const cur = (await import('../config/index.js')).readConfigFileWithRecovery(
        (await import('node:path')).join(process.cwd(), 'config', 'fantomMcpServer-config.json'),
      ) ?? {};
      const vc = { ...(cur?.semanticSearch?.virtualContainers ?? {}), enabled: body.enabled };
      await context.updateSettings({ semanticSearch: { virtualContainers: vc } } as any);
    }

    // Per-role daily spend caps, USD. 0/blank clears one.
    if (body.dailyCaps && typeof body.dailyCaps === 'object') {
      const { setDailyCap } = await import('../sidecars/openRouterActivity.js');
      for (const [role, raw] of Object.entries(body.dailyCaps as Record<string, unknown>)) {
        if (role !== 'code-embedding' && role !== 'embedding' && role !== 'reranker') continue;
        const n = raw === '' || raw === null || raw === undefined ? 0 : Number(raw);
        setDailyCap(role, Number.isFinite(n) && n > 0 ? n : null);
      }
    }

    const issues = validateOpenRouterSettings(settings, { hasKey: !!apiKey });
    if (issues.length > 0 && body.force !== true) {
      res.status(400).json({
        error: 'Configuration would not work as written. Fix the issues, or re-send with {"force":true} to push anyway.',
        issues,
      });
      return;
    }

    // Saving a policy ALWAYS re-pushes. A stored mode that never reached the
    // fleet is inert: modes were once changed to cloud-only while all 15
    // providers went on reporting local-only, because nothing re-pushed.
    const { results, pushedCount } = pushOpenRouterConfig(settings, apiKey);
    // The sidecar applies the push on receipt, but the frame is
    // fire-and-forget — give it a beat before re-reading /api/status.
    setTimeout(() => { void refreshAllVirtualContainers().catch(() => {}); }, 1500);

    res.json({
      ok: pushedCount > 0,
      pushedCount,
      results,
      issues,
      policyByRole,
      note: pushedCount === 0
        ? 'No sidecar has an open WS tunnel to Fantom\'s master slot, so nothing was pushed — the routing '
          + 'policy is stored but NOT in effect. Register Fantom as a master on each sidecar, then re-push.'
        : `Pushed to ${pushedCount} sidecar(s). The sidecar holds this config in memory only — it is lost on a `
          + 'sidecar restart; re-push then.',
    });
  });

  /**
   * Set (or clear) the manual cloud-budget ceiling.
   *
   * The unit is CONCURRENT CLOUD REQUESTS against the OpenRouter key. Manual
   * wins over the discovered limit, because the operator has a reason Fantom
   * cannot see: capping spend, or leaving headroom for the Sound Suite
   * master, which shares the same key and would otherwise be starved by a
   * Fantom rebuild.
   *
   * `null`/`''` clears it and returns to the discovered value. Takes effect
   * immediately — no restart, and raising it releases queued waiters on the
   * spot, so `permits in use` moves on the page mid-rebuild.
   */
  router.post('/openrouter/budget', async (req: Request, res: Response): Promise<void> => {
    const { setManualCloudConcurrency, cloudBudgetStats, isValidConcurrency,
      hydrateCloudBudgetFromConfig, MAX_ALLOWED_CONCURRENCY } =
      await import('../embedding/providers/cloudBudget.js');

    const raw = (req.body ?? {}).maxConcurrent;
    const clearing = raw === null || raw === undefined || raw === '';
    let value: number | null = null;
    if (!clearing) {
      const n = typeof raw === 'string' ? Number(raw.trim()) : raw;
      if (!isValidConcurrency(n)) {
        // Refuse a typo rather than letting it saturate the account.
        res.status(400).json({
          error: `maxConcurrent must be a whole number between 1 and ${MAX_ALLOWED_CONCURRENCY}, `
            + 'or blank to use the limit discovered from the key.',
          got: raw,
        });
        return;
      }
      value = n;
    }

    await context.updateSettings({ openRouterMaxConcurrent: value } as any);
    setManualCloudConcurrency(value);
    await hydrateCloudBudgetFromConfig(true);
    res.json({ ok: true, budget: cloudBudgetStats() });
  });

  /**
   * The Live Activity poll (every 4s on the page). Small on purpose: it is
   * the difference between "OpenRouter is configured" and "OpenRouter is
   * actually serving requests", which otherwise look identical.
   */
  router.get('/openrouter/activity', async (_req: Request, res: Response): Promise<void> => {
    const { allActivity, spendTodayTotal, getDailyCaps } = await import('../sidecars/openRouterActivity.js');
    const { cloudBudgetStats } = await import('../embedding/providers/cloudBudget.js');
    const { getLastRerankAttribution } = await import('../embedding/rerankRouter.js');
    res.json({
      nowMs: Date.now(),
      activity: allActivity(),
      spendToday: spendTodayTotal(),
      dailyCaps: getDailyCaps(),
      budget: cloudBudgetStats(),
      lastRerank: getLastRerankAttribution(),
    });
  });

  /** Credits and usage, read through a sidecar — Fantom holds no key. */
  router.get('/openrouter/credits', async (_req: Request, res: Response): Promise<void> => {
    const { refreshCloudBudgetFromKey, cloudBudgetStats } = await import('../embedding/providers/cloudBudget.js');
    const { spendTodayTotal } = await import('../sidecars/openRouterActivity.js');
    const budget = await refreshCloudBudgetFromKey(true).catch(() => cloudBudgetStats());
    res.json({
      ok: budget.discovery.ok,
      reason: budget.discovery.reason,
      credits: budget.credits ?? null,
      spendToday: spendTodayTotal(),
      budget,
    });
  });

  /** Re-probe the key's own rate limit through a sidecar, ignoring the TTL. */
  router.post('/openrouter/budget/refresh', async (_req: Request, res: Response): Promise<void> => {
    const { refreshCloudBudgetFromKey } = await import('../embedding/providers/cloudBudget.js');
    const budget = await refreshCloudBudgetFromKey(true);
    res.json({ ok: budget.discovery.ok, budget });
  });

  /** Re-push the stored config (models/modes only, no key) — for use after a
   *  sidecar restart, which clears its in-memory copy. */
  router.post('/openrouter/repush', async (_req: Request, res: Response): Promise<void> => {
    const { rePushStoredConfig } = await import('../sidecars/openRouterConfig.js');
    const out = rePushStoredConfig();
    if (!out) { res.status(400).json({ error: 'Nothing stored to re-push. Configure and push first.' }); return; }
    res.json({ ok: out.pushedCount > 0, ...out });
  });

  /** Force a virtual-container rediscovery poll (normally every 60s). */
  router.post('/sidecars/virtual/refresh', async (_req: Request, res: Response): Promise<void> => {
    const { refreshAllVirtualContainers, getSlotStatus } = await import('../sidecars/virtualContainers.js');
    const rows = await refreshAllVirtualContainers();
    res.json({ ok: true, virtual: rows, slots: getSlotStatus() });
  });

  /**
   * Vector-compatibility verdicts for every OR embedding provider: which are
   * cleared to join the fan-out, which are refused, and the cosine numbers
   * behind each decision. Distinct from /sidecars' `embedFault`, which is a
   * TTL-expiring RUNTIME fault — a vector-space verdict never expires.
   */
  router.get('/sidecars/virtual/verification', async (_req: Request, res: Response): Promise<void> => {
    const { listRefusals, listVerifications } = await import('../embedding/providers/vectorCompatibility.js');
    res.json({ verified: listVerifications(), refusals: listRefusals() });
  });

  /**
   * Run (or re-run) the compatibility gate for every OR code-embedding
   * provider and report the cosine numbers. Embeds 10 short probe texts on
   * each side — it does not touch the vector table and starts no job.
   *
   * The reference follows the policy, exactly as the fan-out's does. Under
   * "OpenRouter only" the table holds no local rows, so agreement with a local
   * Q4 host is not a property of it; the peer cloud provider is the reference
   * and a sole provider is checked on dimension and upstream pin. Running this
   * against a local host under that policy would report a failure that is not
   * one, on the very configuration the policy exists to allow.
   */
  router.post('/sidecars/virtual/verify', async (_req: Request, res: Response): Promise<void> => {
    try {
      const { listVirtualContainers } = await import('../sidecars/virtualContainers.js');
      const { selectAllEmbeddingProviders, embeddingRoutingPolicy } =
        await import('../embedding/providers/embeddingProvider.js');
      const { verifyVectorCompatibility, localReference, cloudReference, selectCloudReference } =
        await import('../embedding/providers/vectorCompatibility.js');
      const settings = context.getSettings();
      const expectedDims = settings.semanticSearch?.codeDimensions ?? 2560;
      const rows = listVirtualContainers('code-embedding');
      if (rows.length === 0) {
        res.json({ reports: [], note: 'No cloud-routable code-embedding provider for Fantom\'s master slot.' });
        return;
      }
      const routing = await embeddingRoutingPolicy('code');
      const reports = [];

      if (!routing.localServes) {
        // Anchor order, so this reports the same pairing the fan-out will use.
        const ordered = [...rows].sort((a, b) => a.providerName.localeCompare(b.providerName));
        for (const vc of ordered) {
          const peer = selectCloudReference(vc, ordered);
          reports.push(await verifyVectorCompatibility(
            vc, peer ? cloudReference(peer) : null, expectedDims, { regime: 'cloud-ref' },
          ));
        }
        res.json({
          reports, expectedDims, policy: routing.policy, regime: 'cloud-ref',
          reference: ordered[0].providerName,
          note: ordered.length === 1
            ? `${ordered[0].providerName} is the only cloud provider, so there is no peer to compare it with: `
              + 'dimension and upstream pin are the whole check, and nothing here detects an upstream that '
              + 'changes its serving stack behind the same pin.'
            : `Checked against each other; ${ordered[0].providerName} is the anchor.`,
        });
        return;
      }

      const local = selectAllEmbeddingProviders('code', settings.semanticSearch?.codeModel);
      if (local.length === 0) {
        res.status(425).json({ error: 'No local embedder available to verify against — under this policy local and cloud vectors share one table, so comparing cloud to cloud proves nothing about the rows already in it.' });
        return;
      }
      const refName = (settings.semanticSearch as any)?.verificationReferenceSidecar as string | undefined;
      const referenceProvider = (refName ? local.find(p => p.getSidecarName() === refName) : undefined) ?? local[0];
      const reference = localReference(referenceProvider);
      for (const vc of rows) {
        reports.push(await verifyVectorCompatibility(vc, reference, expectedDims, { regime: 'local-ref' }));
      }
      res.json({ reports, expectedDims, policy: routing.policy, regime: 'local-ref', reference: reference.name });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** Clear a sidecar's remembered embedding capability fault so it is probed
   *  again immediately (after the operator fixed the host). */
  router.post('/sidecars/:id/embed-fault/clear', async (req: Request, res: Response): Promise<void> => {
    const { clearEmbedFaults } = await import('../embedding/providers/embedFaults.js');
    const cleared = clearEmbedFaults(String(req.params.id));
    res.json({ cleared });
  });

  router.get('/sidecars/master-ws-port', async (_req: Request, res: Response): Promise<void> => {
    const { getMasterWsListenerStatus } = await import('../sidecars/soundsuiteMaster.js');
    const settings = context.getSettings();
    const status = getMasterWsListenerStatus();
    res.json({
      configuredPort: (settings as any).sidecarMasterWsPort ?? 3003,
      listener: status,
    });
  });

  router.post('/sidecars/master-ws-port', async (req: Request, res: Response): Promise<void> => {
    const port = Number((req.body ?? {}).port);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      res.status(400).json({ error: 'port must be 1-65535' });
      return;
    }
    await context.updateSettings({ sidecarMasterWsPort: port } as any);
    const { restartMasterWsListener } = await import('../sidecars/soundsuiteMaster.js');
    const result = restartMasterWsListener(port);
    res.json({ port, restart: result });
  });

  router.get('/sidecars/models', (req: Request, res: Response): void => {
    const kind = (req.query.kind as SidecarCapabilityKind) || 'embedding';
    res.json({ kind, models: listAvailableModels(kind) });
  });

  router.post('/sidecars', (req: Request, res: Response): void => {
    const body = req.body ?? {};
    for (const f of ['name', 'host', 'port'] as const) {
      if (body[f] === undefined || body[f] === null || body[f] === '') {
        res.status(400).json({ error: `Missing required field: ${f}` });
        return;
      }
    }
    const port = Number(body.port);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      res.status(400).json({ error: 'port must be 1-65535' });
      return;
    }
    const sc = createSidecar({
      name: String(body.name),
      host: String(body.host),
      port,
      protocol: body.protocol === 'https' ? 'https' : 'http',
      authToken: body.authToken ? String(body.authToken) : undefined,
      enabled: body.enabled !== false,
      capabilities: typeof body.capabilities === 'object' && body.capabilities ? body.capabilities : {},
      capabilitiesSource: 'manual',
    });
    res.status(201).json(sc);
  });

  router.put('/sidecars/:id', (req: Request, res: Response): void => {
    const id = req.params.id as string;
    const body = req.body ?? {};
    const patch: Partial<Sidecar> = {};
    for (const f of ['name', 'host', 'port', 'protocol', 'authToken', 'enabled', 'capabilities'] as const) {
      if (body[f] !== undefined) (patch as any)[f] = body[f];
    }
    const updated = updateSidecar(id, patch);
    if (!updated) {
      res.status(404).json({ error: 'Sidecar not found' });
      return;
    }
    res.json(updated);
  });

  router.delete('/sidecars/:id', (req: Request, res: Response): void => {
    const id = req.params.id as string;
    const ok = deleteSidecar(id);
    if (!ok) {
      res.status(404).json({ error: 'Sidecar not found' });
      return;
    }
    res.json({ success: true, message: `Sidecar ${id} deleted` });
  });

  /**
   * Register Fantom MCP as a master in the sidecar's `/api/masters` list.
   * Body: { masterUrl?: string, authToken?: string }
   * If masterUrl is omitted, builds it from FANTOM_PUBLIC_HOST (or 0.0.0.0)
   * + the configured HTTP port. wsPort is the configured sidecarMasterWsPort.
   */
  router.post('/sidecars/:id/register-as-master', async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id as string;
    const sc = getSidecar(id);
    if (!sc) { res.status(404).json({ error: 'Sidecar not found' }); return; }
    const settings = context.getSettings();
    const masterPort = settings.port;
    const wsPort = (settings as any).sidecarMasterWsPort ?? 3003;
    const host = (req.body?.masterUrl ? null : (process.env.FANTOM_PUBLIC_HOST || ''));
    const masterUrl: string = req.body?.masterUrl
      ?? (host ? `http://${host}:${masterPort}` : '');
    if (!masterUrl) {
      res.status(400).json({
        error: 'Cannot determine master URL.',
        hint: 'Set FANTOM_PUBLIC_HOST env var or pass { masterUrl } in the body. Example: { "masterUrl": "http://172.16.16.9:3848" }',
      });
      return;
    }
    const sidecarUrlBase = `${sc.protocol}://${sc.host}:${sc.port}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (sc.authToken) headers['Authorization'] = `Bearer ${sc.authToken}`;
    try {
      const r = await fetch(`${sidecarUrlBase}/api/masters`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ serverUrl: masterUrl, wsPort, authToken: req.body?.authToken }),
      });
      const text = await r.text();
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch {}
      if (!r.ok) {
        res.status(502).json({ error: `sidecar ${r.status}`, details: parsed });
        return;
      }
      res.json({ ok: true, masterUrl, wsPort, sidecarResponse: parsed });
    } catch (err) {
      res.status(502).json({ error: 'Failed to reach sidecar', details: String((err as Error).message ?? err) });
    }
  });

  /**
   * Remove Fantom from the sidecar's master list. Body: { masterUrl?: string }
   * — same default-resolution rules as register.
   */
  router.post('/sidecars/:id/unregister-as-master', async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id as string;
    const sc = getSidecar(id);
    if (!sc) { res.status(404).json({ error: 'Sidecar not found' }); return; }
    const settings = context.getSettings();
    const host = (req.body?.masterUrl ? null : (process.env.FANTOM_PUBLIC_HOST || ''));
    const masterUrl: string = req.body?.masterUrl
      ?? (host ? `http://${host}:${settings.port}` : '');
    if (!masterUrl) {
      res.status(400).json({ error: 'Cannot determine master URL.' });
      return;
    }
    const headers: Record<string, string> = {};
    if (sc.authToken) headers['Authorization'] = `Bearer ${sc.authToken}`;
    try {
      const r = await fetch(`${sc.protocol}://${sc.host}:${sc.port}/api/masters/${encodeURIComponent(masterUrl)}`, {
        method: 'DELETE', headers,
      });
      const text = await r.text();
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch {}
      if (!r.ok) {
        res.status(502).json({ error: `sidecar ${r.status}`, details: parsed });
        return;
      }
      res.json({ ok: true, masterUrl, sidecarResponse: parsed });
    } catch (err) {
      res.status(502).json({ error: 'Failed to reach sidecar', details: String((err as Error).message ?? err) });
    }
  });

  router.post('/sidecars/:id/health', async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id as string;
    if (!getSidecar(id)) {
      res.status(404).json({ error: 'Sidecar not found' });
      return;
    }
    const result = await pingSidecar(id);
    res.json(result);
  });

  // Live container/role snapshot. Prefer the in-memory snapshot pushed by
  // the sidecar over WS heartbeats; fall back to HTTP /status probe.
  router.get('/sidecars/:id/status', async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id as string;
    const sc = getSidecar(id);
    if (!sc) { res.status(404).json({ error: 'Sidecar not found' }); return; }
    const { getCachedSnapshotBySidecarId } = await import('../sidecars/soundsuiteMaster.js');
    const cached = getCachedSnapshotBySidecarId(id);
    if (cached) { res.json({ id, snapshot: cached, source: 'ws-heartbeat' }); return; }
    try {
      const { fetchSidecarStatus } = await import('../sidecars/sidecarActions.js');
      const snapshot = await fetchSidecarStatus(sc);
      res.json({ id, snapshot, source: 'http-status' });
    } catch (err) {
      res.status(502).json({ error: 'Failed to reach sidecar', details: String((err as Error).message ?? err) });
    }
  });

  // Container actions: start | stop | acquire | release | pull | pull-and-load
  router.post('/sidecars/:id/actions/:action', async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id as string;
    const action = req.params.action as string;
    const { role, model } = (req.body ?? {}) as { role?: string; model?: string };
    if (!role) { res.status(400).json({ error: 'Missing required field: role' }); return; }
    const sc = getSidecar(id);
    if (!sc) { res.status(404).json({ error: 'Sidecar not found' }); return; }
    const allowed = new Set(['start', 'stop', 'acquire', 'release', 'pull', 'pull-and-load']);
    if (!allowed.has(action)) { res.status(400).json({ error: `Unknown action: ${action}` }); return; }
    try {
      const { dispatchSidecarAction } = await import('../sidecars/sidecarActions.js');
      const result = await dispatchSidecarAction(sc, action as any, { role, model });
      res.json({ id, action, role, result });
    } catch (err) {
      res.status(502).json({ error: 'Action failed', details: String((err as Error).message ?? err) });
    }
  });

  // ─── LLM Provider settings ─────────────────────────────────────────────
  function maskKey(key?: string): string | null {
    if (!key) return null;
    if (key.length <= 8) return '****';
    return `${key.slice(0, 4)}****${key.slice(-4)}`;
  }

  router.get('/settings/llm-providers', (_req: Request, res: Response): void => {
    const settings = context.getSettings();
    const cfg = settings.llmProviders ?? {};
    res.json({
      defaultProvider: cfg.defaultProvider ?? null,
      groq: {
        enabled: cfg.groq?.enabled ?? false,
        model: cfg.groq?.model ?? null,
        apiKey: maskKey(process.env.GROQ_API_KEY),
        hasKey: !!process.env.GROQ_API_KEY,
      },
      anthropic: {
        enabled: cfg.anthropic?.enabled ?? false,
        model: cfg.anthropic?.model ?? null,
        apiKey: maskKey(process.env.ANTHROPIC_API_KEY),
        hasKey: !!process.env.ANTHROPIC_API_KEY,
      },
      gemini: {
        enabled: cfg.gemini?.enabled ?? false,
        model: cfg.gemini?.model ?? null,
        apiKey: maskKey(process.env.GEMINI_API_KEY),
        hasKey: !!process.env.GEMINI_API_KEY,
      },
    });
  });

  router.post('/settings/llm-providers', async (req: Request, res: Response): Promise<void> => {
    const body = req.body ?? {};
    const envPath = path.join(process.cwd(), '.env');
    let envContent = '';
    if (fs.existsSync(envPath)) envContent = fs.readFileSync(envPath, 'utf-8');

    const setEnvVar = (name: string, value: string | null | undefined) => {
      if (value === null || value === undefined || value === '') return;
      const re = new RegExp(`^${name}=.*$`, 'm');
      const line = `${name}=${value}`;
      if (re.test(envContent)) envContent = envContent.replace(re, line);
      else envContent = envContent + (envContent.endsWith('\n') || envContent === '' ? '' : '\n') + line + '\n';
      process.env[name] = value;
    };

    if (body.groq?.apiKey) setEnvVar('GROQ_API_KEY', body.groq.apiKey);
    if (body.anthropic?.apiKey) setEnvVar('ANTHROPIC_API_KEY', body.anthropic.apiKey);
    if (body.gemini?.apiKey) setEnvVar('GEMINI_API_KEY', body.gemini.apiKey);
    fs.writeFileSync(envPath, envContent);

    const llmProviders: any = {
      defaultProvider: body.defaultProvider ?? undefined,
      groq: { enabled: !!body.groq?.enabled, model: body.groq?.model },
      anthropic: { enabled: !!body.anthropic?.enabled, model: body.anthropic?.model },
      gemini: { enabled: !!body.gemini?.enabled, model: body.gemini?.model },
    };
    await context.updateSettings({ llmProviders } as any);
    res.json({ success: true, restartRequired: false });
  });

  // Axon MCP server integration: /admin/axon/* (src/admin/axonRoutes.ts)
  registerAxonRoutes(router);

  return router;
}
