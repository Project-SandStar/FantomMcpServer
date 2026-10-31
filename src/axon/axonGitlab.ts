/**
 * Axon library from GitLab: settings, token handling, clone/pull, timer.
 *
 * Settings: `config/fantomMcpServer-config.json` → `axon.gitlab`, the same file
 * that holds Fantom's other API keys (OpenRouter, LLM providers). Env overrides:
 * AXON_GITLAB_URL, AXON_GITLAB_REPO, AXON_GITLAB_REF, AXON_GITLAB_TOKEN,
 * AXON_GITLAB_SUBPATH, AXON_GITLAB_REFRESH_MINUTES, AXON_GITLAB_ENABLED.
 *
 * The token never leaves this module: API views carry `hasToken` + `tokenLast4`,
 * git gets it as an `http.extraHeader` (never in the remote URL or .git/config),
 * and every message goes through redactSecrets().
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { readConfigFileWithRecovery, atomicWriteConfigFile } from '../config/index.js';
import { getCachePath } from '../utils/installRoot.js';

export interface AxonGitlabSettings {
  enabled: boolean;
  /** https://gitlab.example.com */
  baseUrl: string;
  /** group/sub/repo */
  repo: string;
  /** Branch; '' = the repo's default branch. */
  ref: string;
  /** Folder inside the repo that is the library root ('' = repo root). */
  subPath: string;
  /** 0 = no timer. */
  refreshMinutes: number;
  token: string;
}

export interface AxonGitlabState {
  lastSha: string;
  lastPullAt: string;
  lastError: string;
  lastResult: string;
}

export const DEFAULT_GITLAB: AxonGitlabSettings = {
  enabled: false,
  // No built-in server: set these on the Axon page, or with AXON_GITLAB_URL /
  // AXON_GITLAB_REPO (for example https://gitlab.example.com, group/axon-library).
  baseUrl: '',
  repo: '',
  ref: '',
  subPath: '',
  refreshMinutes: 60,
  token: '',
};

const configPath = (): string => path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');

/** Remove secrets (token, Authorization headers, user:pass@ in URLs) from text. */
export function redactSecrets(text: string, secrets: string[] = []): string {
  let out = String(text ?? '');
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('***');
  out = out.replace(/(Authorization:\s*(?:Bearer|Basic)\s+)[^\s"']+/gi, '$1***');
  out = out.replace(/(PRIVATE-TOKEN:\s*)[^\s"']+/gi, '$1***');
  out = out.replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1***@');
  out = out.replace(/glpat-[A-Za-z0-9_-]{8,}/g, 'glpat-***');
  return out;
}

export function validGitlabBaseUrl(u: string): boolean {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && !x.username && !x.password;
  } catch { return false; }
}

const REPO_RE = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/;
export function validGitlabRepo(r: string): boolean { return REPO_RE.test(r) && !r.includes('..'); }

function envBool(v: string | undefined): boolean | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

type Source = 'env' | 'saved' | 'default';

/** Saved section merged over defaults, env over both. */
export function getGitlabSettings(env: NodeJS.ProcessEnv = process.env, raw: any = readConfigFileWithRecovery(configPath())?.axon?.gitlab): {
  settings: AxonGitlabSettings; sources: Record<keyof AxonGitlabSettings, Source>;
} {
  const saved = raw && typeof raw === 'object' ? raw : {};
  const s: AxonGitlabSettings = { ...DEFAULT_GITLAB };
  const sources = {} as Record<keyof AxonGitlabSettings, Source>;
  const envMap: Record<keyof AxonGitlabSettings, string> = {
    enabled: 'AXON_GITLAB_ENABLED', baseUrl: 'AXON_GITLAB_URL', repo: 'AXON_GITLAB_REPO', ref: 'AXON_GITLAB_REF',
    subPath: 'AXON_GITLAB_SUBPATH', refreshMinutes: 'AXON_GITLAB_REFRESH_MINUTES', token: 'AXON_GITLAB_TOKEN',
  };
  for (const k of Object.keys(DEFAULT_GITLAB) as Array<keyof AxonGitlabSettings>) {
    sources[k] = 'default';
    const sv = saved[k];
    if (sv !== undefined && sv !== null && typeof sv === typeof DEFAULT_GITLAB[k]) { (s as any)[k] = sv; sources[k] = 'saved'; }
    const ev = env[envMap[k]];
    if (ev !== undefined && ev.trim() !== '') {
      if (k === 'enabled') s.enabled = !!envBool(ev);
      else if (k === 'refreshMinutes') s.refreshMinutes = Number(ev);
      else (s as any)[k] = ev.trim();
      sources[k] = 'env';
    }
  }
  if (!Number.isFinite(s.refreshMinutes) || s.refreshMinutes < 0) s.refreshMinutes = DEFAULT_GITLAB.refreshMinutes;
  s.baseUrl = s.baseUrl.replace(/\/+$/, '');
  s.subPath = s.subPath.replace(/^\/+|\/+$/g, '');
  return { settings: s, sources };
}

/** What the API returns: no token, only `hasToken` and the last 4 characters. */
export function gitlabView(env: NodeJS.ProcessEnv = process.env) {
  const { settings, sources } = getGitlabSettings(env);
  const { token, ...rest } = settings;
  return {
    ...rest,
    hasToken: !!token,
    tokenLast4: token ? token.slice(-4) : '',
    sources,
    state: readState(),
    cloneDir: cloneDirFor(settings),
    libraryPath: gitlabLibraryPath(settings),
  };
}

/**
 * Save from the API. `token`: '' or missing = keep the old one, null = clear.
 * Throws on a bad URL / repo.
 */
export function saveGitlabSettings(body: any): void {
  const cfg = readConfigFileWithRecovery(configPath());
  const old = { ...DEFAULT_GITLAB, ...(cfg?.axon?.gitlab ?? {}) } as AxonGitlabSettings;
  const next: AxonGitlabSettings = { ...old };
  if (typeof body?.enabled === 'boolean') next.enabled = body.enabled;
  if (typeof body?.baseUrl === 'string') next.baseUrl = body.baseUrl.trim().replace(/\/+$/, '');
  if (typeof body?.repo === 'string') next.repo = body.repo.trim().replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (typeof body?.ref === 'string') next.ref = body.ref.trim();
  if (typeof body?.subPath === 'string') next.subPath = body.subPath.trim().replace(/^\/+|\/+$/g, '');
  if (body?.refreshMinutes !== undefined) {
    const n = Number(body.refreshMinutes);
    if (!Number.isFinite(n) || n < 0 || n > 10080) throw new Error('refreshMinutes must be 0..10080');
    next.refreshMinutes = Math.round(n);
  }
  if (body?.token === null) next.token = '';
  else if (typeof body?.token === 'string' && body.token.trim()) next.token = body.token.trim();
  // Empty URL / repo may be saved while GitLab is off (nothing is set by default).
  if ((next.enabled || next.baseUrl) && !validGitlabBaseUrl(next.baseUrl)) throw new Error('GitLab URL must start with https:// and hold no user or password');
  if ((next.enabled || next.repo) && !validGitlabRepo(next.repo)) throw new Error('Repository must look like group/project');
  if (next.ref && !/^[A-Za-z0-9._\/-]{1,200}$/.test(next.ref)) throw new Error('Invalid branch name');
  if (next.subPath.split('/').includes('..')) throw new Error('Invalid sub-folder');
  cfg.axon = { ...(cfg.axon ?? {}), gitlab: next };
  atomicWriteConfigFile(configPath(), cfg);
  clearLocalLibraryPathIfGitlab();
}

/**
 * GitLab on and cloned = the clone is the only library. Drop a saved local
 * `axon.libraryPath` (often a Mac path that does not exist in the container).
 * Returns true when it removed one. The env value is not touched.
 */
export function clearLocalLibraryPathIfGitlab(file: string = configPath(), root?: string): boolean {
  try {
    const cfg = readConfigFileWithRecovery(file);
    const saved = cfg?.axon?.libraryPath;
    if (typeof saved !== 'string' || !saved.trim()) return false;
    const { settings } = getGitlabSettings(process.env, cfg?.axon?.gitlab);
    if (!gitlabLibraryPath(settings, root)) return false;
    cfg.axon = { ...cfg.axon, libraryPath: '' };
    atomicWriteConfigFile(file, cfg);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- state

const stateFile = (): string => getCachePath('axon-library-git', 'state.json');

export function readState(): AxonGitlabState {
  try {
    return { lastSha: '', lastPullAt: '', lastError: '', lastResult: '', ...JSON.parse(fs.readFileSync(stateFile(), 'utf-8')) };
  } catch {
    return { lastSha: '', lastPullAt: '', lastError: '', lastResult: '' };
  }
}

function writeState(s: AxonGitlabState): void {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2));
}

export function cloneDirFor(s: AxonGitlabSettings, root = getCachePath('axon-library-git')): string {
  return path.join(root, s.repo.replace(/[^A-Za-z0-9_.-]+/g, '__'));
}

/** Library root when GitLab is on and cloned; '' otherwise. */
export function gitlabLibraryPath(s: AxonGitlabSettings = getGitlabSettings().settings, root?: string): string {
  if (!s.enabled) return '';
  const dir = cloneDirFor(s, root);
  if (!fs.existsSync(path.join(dir, '.git'))) return '';
  return s.subPath ? path.join(dir, s.subPath) : dir;
}

// ---------------------------------------------------------------- git

function authHeader(token: string): string {
  // Basic oauth2:<token> works for personal, project and group access tokens.
  return `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`;
}

function git(args: string[], token: string, cwd?: string, timeoutMs = 300_000): Promise<string> {
  const full = token ? ['-c', `http.extraHeader=${authHeader(token)}`, ...args] : args;
  return new Promise((resolve, reject) => {
    execFile('git', full, {
      cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GCM_INTERACTIVE: 'never' },
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(redactSecrets(`git ${args[0]} failed: ${stderr || err.message}`, [token, authHeader(token)])));
      else resolve(String(stdout).trim());
    });
  });
}

export interface PullResult {
  sha: string;
  changed: boolean;
  cloned: boolean;
  libraryPath: string;
}

/** Remote URL without credentials (`remoteOverride`: tests use a local bare repo). */
export function remoteUrl(s: AxonGitlabSettings): string {
  return `${s.baseUrl}/${s.repo}.git`;
}

let pulling: Promise<PullResult> | null = null;

/**
 * Clone (first time, shallow) or fetch + hard reset to the remote branch.
 * Saves lastSha / lastPullAt / lastError. `onChanged` runs when the SHA moved.
 */
export function pullGitlabLibrary(opts: {
  settings?: AxonGitlabSettings;
  root?: string;
  remote?: string;
  onChanged?: (r: PullResult) => void;
} = {}): Promise<PullResult> {
  if (pulling) return pulling;
  pulling = (async () => {
    const s = opts.settings ?? getGitlabSettings().settings;
    const state = readState();
    try {
      if (!validGitlabRepo(s.repo)) throw new Error('Repository not set');
      if (!opts.remote && !validGitlabBaseUrl(s.baseUrl)) throw new Error('GitLab URL must be https://');
      if (!opts.remote && !s.token) throw new Error('No token: paste a GitLab access token (read_repository) on the Axon page');
      const dir = cloneDirFor(s, opts.root);
      const remote = opts.remote ?? remoteUrl(s);
      let cloned = false;
      if (!fs.existsSync(path.join(dir, '.git'))) {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        await git(['clone', '--depth', '1', ...(s.ref ? ['--branch', s.ref] : []), remote, dir], s.token);
        cloned = true;
      } else {
        const ref = s.ref || (await git(['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], s.token));
        await git(['-C', dir, 'fetch', '--depth', '1', 'origin', ref], s.token);
        await git(['-C', dir, 'reset', '--hard', 'FETCH_HEAD'], s.token);
      }
      const sha = await git(['-C', dir, 'rev-parse', 'HEAD'], s.token);
      const changed = sha !== state.lastSha;
      const result: PullResult = { sha, changed, cloned, libraryPath: s.subPath ? path.join(dir, s.subPath) : dir };
      writeState({ lastSha: sha, lastPullAt: new Date().toISOString(), lastError: '', lastResult: cloned ? 'cloned' : changed ? 'updated' : 'no change' });
      if (!opts.root) clearLocalLibraryPathIfGitlab();
      if (changed && opts.onChanged) {
        try { opts.onChanged(result); } catch { /* the caller logs */ }
      }
      return result;
    } catch (e) {
      const msg = redactSecrets(e instanceof Error ? e.message : String(e), [s.token]);
      writeState({ ...state, lastPullAt: new Date().toISOString(), lastError: msg, lastResult: 'error' });
      throw new Error(msg);
    }
  })().finally(() => { pulling = null; });
  return pulling;
}

/**
 * "Test" button: GitLab API project lookup. Returns name and default branch,
 * or a clear error (401 / 403 / 404).
 */
export async function testGitlab(s: AxonGitlabSettings = getGitlabSettings().settings, fetchImpl: typeof fetch = fetch): Promise<{
  ok: boolean; name?: string; defaultBranch?: string; webUrl?: string; error?: string; status?: number;
}> {
  if (!validGitlabBaseUrl(s.baseUrl)) return { ok: false, error: 'GitLab URL must start with https://' };
  if (!validGitlabRepo(s.repo)) return { ok: false, error: 'Repository must look like group/project' };
  if (!s.token) return { ok: false, error: 'No token saved' };
  try {
    const r = await fetchImpl(`${s.baseUrl}/api/v4/projects/${encodeURIComponent(s.repo)}`, {
      headers: { 'PRIVATE-TOKEN': s.token, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status === 401) return { ok: false, status: 401, error: 'Token rejected (401): wrong or expired token' };
    if (r.status === 403) return { ok: false, status: 403, error: 'No access (403): the token needs read_repository / read_api' };
    if (r.status === 404) return { ok: false, status: 404, error: 'Repository not found (404), or the token cannot see it' };
    if (!r.ok) return { ok: false, status: r.status, error: `GitLab answered ${r.status}` };
    const j: any = await r.json();
    return { ok: true, name: j.path_with_namespace ?? j.name, defaultBranch: j.default_branch, webUrl: j.web_url };
  } catch (e) {
    return { ok: false, error: redactSecrets(e instanceof Error ? e.message : String(e), [s.token]) };
  }
}

// ---------------------------------------------------------------- timer

let timer: NodeJS.Timeout | null = null;
let timerMinutes = -1;

/** (Re)start the refresh timer from the settings. Safe to call often. */
export function scheduleGitlabRefresh(onChanged: (r: PullResult) => void, log: (m: string) => void = () => {}): void {
  const { settings } = getGitlabSettings();
  const minutes = settings.enabled && settings.token ? settings.refreshMinutes : 0;
  if (minutes === timerMinutes) return;
  if (timer) { clearInterval(timer); timer = null; }
  timerMinutes = minutes;
  if (minutes <= 0) return;
  const run = (): void => {
    pullGitlabLibrary({ onChanged }).then(
      r => log(`Axon library: ${r.cloned ? 'cloned' : r.changed ? 'updated' : 'no change'} @ ${r.sha.slice(0, 8)}`),
      e => log(`Axon library pull failed: ${e instanceof Error ? e.message : String(e)}`),
    );
  };
  timer = setInterval(run, minutes * 60_000);
  timer.unref?.();
  setTimeout(run, 30_000).unref?.();
}

export function stopGitlabRefresh(): void {
  if (timer) clearInterval(timer);
  timer = null;
  timerMinutes = -1;
}
