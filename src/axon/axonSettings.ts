/**
 * Axon integration settings.
 *
 * Single source of truth for everything that derives from the Axon MCP server
 * location. Nothing else in the codebase may hardcode the Axon path — read
 * `getAxonSettings().projectPath` instead.
 *
 * The embedding model is deliberately NOT part of these settings: Axon vectors
 * always use the Code Search model (`settings.semanticSearch.codeModel` /
 * `codeDimensions`) so that `axon_vectors` and `code_vectors` share model and
 * dimensionality. See `resolveAxonEmbeddingModel()`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getOpenRouterSettings } from '../sidecars/openRouterConfig.js';
import { isCloudOnlyPolicy, sanitizePolicies } from '../sidecars/routingPolicy.js';

export type AxonTransport = 'stdio' | 'http';

export interface AxonSettings {
  /** Root of the Axon MCP server checkout (contains package.json, dist/, proj/). */
  projectPath: string;
  /** Offline Axon library: one folder per former customer project (.axon / trio backups). */
  libraryPath: string;
  /** Master switch — when false the MCP client never spawns/connects. */
  enabled: boolean;
  transport: AxonTransport;
  /** stdio: executable (default `node`). */
  command: string;
  /** stdio: arguments, resolved with cwd = projectPath (default `dist/index.js`). */
  args: string[];
  /** http: StreamableHTTP endpoint of an already-running Axon server. */
  url: string;
  /** Kick off an index run at boot when providers for the code model are available. */
  autoIndex: boolean;
}

export const DEFAULT_AXON_SETTINGS: AxonSettings = {
  // No default location: these are per-install paths, set on the dashboard's
  // Axon page or via AXON_PROJECT_PATH / AXON_LIBRARY_PATH. They used to
  // default to one developer's home directory, which is both wrong for every
  // other install and not something to publish.
  projectPath: process.env.AXON_PROJECT_PATH ?? '',
  libraryPath: process.env.AXON_LIBRARY_PATH ?? '',
  // The MCP client is internal (no dashboard controls): enabled by default,
  // connects lazily on first use to the Axon daemon over HTTP. Indexing and
  // search never depend on it — only callers/callees enrichment does.
  enabled: true,
  transport: 'http',
  command: 'node',
  // Mirrors the Axon server's own `npm start` line (package.json).
  args: ['--max-old-space-size=8192', 'dist/index.js'],
  url: 'http://localhost:3847/mcp',
  autoIndex: false,
};

const RUNTIME_CONFIG_PATH = path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');

function readRuntimeConfig(): any {
  try {
    if (!fs.existsSync(RUNTIME_CONFIG_PATH)) return {};
    return JSON.parse(fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf-8')) ?? {};
  } catch {
    return {};
  }
}

/** Merge persisted `axon` section over the defaults. Always returns a full object. */
export function getAxonSettings(): AxonSettings {
  const raw = readRuntimeConfig()?.axon ?? {};
  const merged: AxonSettings = { ...DEFAULT_AXON_SETTINGS, ...raw };
  if (!Array.isArray(merged.args)) merged.args = DEFAULT_AXON_SETTINGS.args;
  if (merged.transport !== 'http') merged.transport = 'stdio';
  // An unset path stays unset — `scanAllAxonProjects` reports "no Axon projects
  // found … check axon.projectPath", which is the truth. Substituting a
  // fallback here would have the indexer scan some unrelated directory.
  if (typeof merged.projectPath !== 'string') merged.projectPath = DEFAULT_AXON_SETTINGS.projectPath;
  if (typeof merged.libraryPath !== 'string') merged.libraryPath = DEFAULT_AXON_SETTINGS.libraryPath;
  return merged;
}

/** Absolute path to the offline Axon library root. */
export function getAxonLibraryDir(settings: AxonSettings = getAxonSettings()): string {
  return settings.libraryPath;
}

/** Absolute path to the synced SkySpark projects folder ('' when unconfigured). */
export function getAxonProjDir(settings: AxonSettings = getAxonSettings()): string {
  // Not `path.join('', 'proj')` — that yields the RELATIVE './proj', which the
  // scanner would happily read from whatever the process cwd happens to be.
  if (!settings.projectPath.trim()) return '';
  return path.join(settings.projectPath, 'proj');
}

/**
 * The embedding model Axon vectors use — the Code Search model. Read on every
 * call (index and search time) so a model switch in the config page is picked
 * up without a restart; a dims mismatch against a populated table is then
 * surfaced by `getAxonTableStats()` rather than silently re-creating anything.
 *
 * The name is resolved THROUGH the code-embedding routing policy, because
 * under "OpenRouter only" the corpus is not built by the local Ollama tag in
 * `semanticSearch.codeModel` — it is built by the cloud model named in
 * `openRouter.allowedModels['code-embedding']`, exactly as `code_vectors` is.
 * One resolver serves index-time row tagging, search-time resolution, the
 * table gate and the dashboard label: if they disagreed, a forced re-index
 * would clear the warning and `getAxonTableStats()` would immediately raise it
 * again against the rows that run had just written.
 *
 * Dims deliberately stay on `semanticSearch.codeDimensions` — the same number
 * `tableDimsFor('code')` hands the provider gate, so the width a provider is
 * verified against is the width the table is created at.
 */
export function resolveAxonEmbeddingModel(): { model: string; dimensions: number } {
  const sem = readRuntimeConfig()?.semanticSearch ?? {};
  const envModel = process.env.CODE_EMBEDDING_MODEL;
  const envDims = parseInt(process.env.CODE_EMBEDDING_DIMENSIONS || process.env.EMBEDDING_DIMENSIONS || '');
  const localModel: string = sem.codeModel || sem.embeddingModel || 'qwen3-embedding:4b';
  const model: string = envModel || resolveCloudOnlyCodeModel() || localModel;
  const dims: number = Number.isFinite(envDims) && envDims > 0
    ? envDims
    : (Number(sem.codeDimensions) || Number(sem.embeddingDimensions) || 2560);
  return { model, dimensions: dims };
}

/**
 * The OpenRouter code-embedding model when — and only when — that role is on
 * "OpenRouter only". Under the three GPU-serving policies the local pool
 * writes the rows, so the local tag stays correct and this returns undefined.
 */
function resolveCloudOnlyCodeModel(): string | undefined {
  try {
    const or = getOpenRouterSettings();
    // sanitizePolicies fills every role, so this is never a "missing role read
    // as disabled" — the same reader the fan-out and query encoder use.
    const policy = sanitizePolicies(or.policyByRole)['code-embedding'];
    if (!isCloudOnlyPolicy('code-embedding', policy)) return undefined;
    return or.allowedModels['code-embedding']?.model;
  } catch {
    // A config read that failed is not a licence to guess at the policy.
    return undefined;
  }
}
