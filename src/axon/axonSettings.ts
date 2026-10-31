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
import { getGitlabSettings, gitlabLibraryPath } from './axonGitlab.js';
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
  projectPath: '',
  libraryPath: '',
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

export type AxonSettingSource = 'env' | 'saved' | 'empty' | 'gitlab';

/** Where each path setting came from (env wins over the saved config). */
export interface AxonSettingSources {
  projectPath: AxonSettingSource;
  libraryPath: AxonSettingSource;
  url: AxonSettingSource;
}

function envValue(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Merge env and the persisted `axon` section over the defaults.
 * AXON_PROJECT_PATH, AXON_LIBRARY_PATH and AXON_MCP_URL win over the saved
 * config (Docker: the compose file is the truth, not a path saved on a Mac).
 */
export function getAxonSettings(env: NodeJS.ProcessEnv = process.env, raw: any = readRuntimeConfig()?.axon ?? {}): AxonSettings {
  return getAxonSettingsWithSources(env, raw).settings;
}

export function getAxonSettingsWithSources(
  env: NodeJS.ProcessEnv = process.env,
  raw: any = readRuntimeConfig()?.axon ?? {},
): { settings: AxonSettings; sources: AxonSettingSources } {
  const merged: AxonSettings = { ...DEFAULT_AXON_SETTINGS, projectPath: '', libraryPath: '', ...(raw ?? {}) };
  if (!Array.isArray(merged.args)) merged.args = DEFAULT_AXON_SETTINGS.args;
  if (merged.transport !== 'http') merged.transport = 'stdio';
  // An unset path stays unset — `scanAllAxonProjects` reports "no Axon projects
  // found … check axon.projectPath", which is the truth. Substituting a
  // fallback here would have the indexer scan some unrelated directory.
  if (typeof merged.projectPath !== 'string') merged.projectPath = '';
  if (typeof merged.libraryPath !== 'string') merged.libraryPath = '';
  if (typeof merged.url !== 'string' || !merged.url.trim()) merged.url = DEFAULT_AXON_SETTINGS.url;
  const pick = (key: 'projectPath' | 'libraryPath' | 'url', envKey: string): AxonSettingSource => {
    const e = envValue(env, envKey);
    if (e) { merged[key] = e; return 'env'; }
    const savedRaw = raw?.[key];
    return typeof savedRaw === 'string' && savedRaw.trim() ? 'saved' : (key === 'url' ? 'saved' : 'empty');
  };
  const sources: AxonSettingSources = {
    projectPath: pick('projectPath', 'AXON_PROJECT_PATH'),
    libraryPath: pick('libraryPath', 'AXON_LIBRARY_PATH'),
    url: pick('url', 'AXON_MCP_URL'),
  };
  // GitLab library (enabled + cloned) wins over a saved folder, not over env.
  if (sources.libraryPath !== 'env') {
    try {
      const g = gitlabLibraryPath(getGitlabSettings(env).settings);
      if (g) { merged.libraryPath = g; sources.libraryPath = 'gitlab'; }
    } catch { /* no GitLab config */ }
  }
  return { settings: merged, sources };
}

/** Absolute path to the offline Axon library root. */
export function getAxonLibraryDir(settings: AxonSettings = getAxonSettings()): string {
  return settings.libraryPath;
}

/**
 * The `proj/` folder for a project path. Accepts both layouts: a folder that
 * contains `proj/` (the Axon checkout) and a folder that is itself `proj/`
 * (the synced mirror mounted at /axon). Returns which rule matched.
 */
export function resolveAxonProjDir(projectPath: string): { projDir: string; layout: 'contains-proj' | 'is-proj' | 'none' } {
  if (!projectPath.trim()) return { projDir: '', layout: 'none' };
  const inner = path.join(projectPath, 'proj');
  if (isDir(inner)) return { projDir: inner, layout: 'contains-proj' };
  if (path.basename(path.resolve(projectPath)) === 'proj' || looksLikeProjDir(projectPath)) {
    return { projDir: projectPath, layout: 'is-proj' };
  }
  return { projDir: inner, layout: 'none' };
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** `<instance>/<project>/func` below it: the folder is a proj/ folder. */
function looksLikeProjDir(p: string): boolean {
  try {
    for (const inst of fs.readdirSync(p, { withFileTypes: true })) {
      if (!inst.isDirectory() || inst.name.startsWith('.')) continue;
      for (const proj of fs.readdirSync(path.join(p, inst.name), { withFileTypes: true })) {
        if (proj.isDirectory() && isDir(path.join(p, inst.name, proj.name, 'func'))) return true;
      }
    }
  } catch { /* not readable */ }
  return false;
}

/** Absolute path to the synced SkySpark projects folder ('' when unconfigured). */
export function getAxonProjDir(settings: AxonSettings = getAxonSettings()): string {
  // Not `path.join('', 'proj')` — that yields the RELATIVE './proj', which the
  // scanner would happily read from whatever the process cwd happens to be.
  return resolveAxonProjDir(settings.projectPath).projDir;
}

/** Boot check: warn when a configured path does not exist in this container. */
export function axonPathWarnings(settings: AxonSettings = getAxonSettings(), sources?: AxonSettingSources): string[] {
  const out: string[] = [];
  if (settings.projectPath && !isDir(settings.projectPath)) out.push(`Axon project path does not exist: ${settings.projectPath}`);
  // GitLab clone in use: the local folder is not used, so it is not checked.
  if (sources?.libraryPath !== 'gitlab' && settings.libraryPath && !isDir(settings.libraryPath)) out.push(`Axon library path does not exist: ${settings.libraryPath}`);
  return out;
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
