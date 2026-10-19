#!/usr/bin/env node
// Fantom MCP plugin doctor: server, proxy, token, plugin install, legacy
// duplicates, project registration for the current directory.
//   node doctor.mjs [--json] [--cwd <dir>]
// Exit 0 when the plugin can work here, 1 otherwise.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ago, dataDir, http, mcpUrl, projectsFile, reportToken, serverUrl, writeJson } from '../hooks/_lib.mjs';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const cwdIdx = args.indexOf('--cwd');
const cwd = cwdIdx >= 0 && args[cwdIdx + 1] ? path.resolve(args[cwdIdx + 1]) : process.cwd();

const checks = [];
const add = (ok, name, detail, level = ok ? 'ok' : 'fail') => checks.push({ ok, level, name, detail });
const warn = (name, detail) => checks.push({ ok: true, level: 'warn', name, detail });

const srv = serverUrl();
const mcp = mcpUrl();

// 1. server
const health = await http('GET', `${srv}/health`, { timeoutMs: 6000 });
const up = health.status === 200;
add(up, 'server', up
  ? `${srv} up, initialized=${health.json && health.json.initialized}, phase=${health.json && health.json.initStatus && health.json.initStatus.phase}`
  : /timeout|aborted/i.test(health.error || '')
    ? `${srv} did not answer within 6 s: busy with a heavy index job, or hung. Check /admin/vectors/shadow and /admin/jobs, or restart: npm run restart:dev in the mcpfantom repo.`
    : `${srv} not reachable (${health.error || 'HTTP ' + health.status}). Start it: npm run start:dev (macOS: npm run start:dev:launchd) in the mcpfantom repo.`);

// 2. proxy / MCP endpoint: any HTTP answer means the listener is there.
const m = await http('GET', mcp, { timeoutMs: 2500, headers: { Accept: 'application/json, text/event-stream' } });
add(m.status > 0, 'mcp endpoint', m.status > 0
  ? `${mcp} answers (HTTP ${m.status})`
  : `${mcp} not reachable (${m.error}). Start mcp-proxy on :9191, or set the plugin option mcp_url to ${srv}/mcp.`);

// 3. token
const { token, source } = reportToken();
add(!!token, 'report token', token ? `found (${source})` : 'none. Create one: Dashboard > Indexing > Report token, or claudePlugin/scripts/install-local.sh.');

// 4. context for cwd
let ctx = null;
if (up && token) {
  const r = await http('GET', `${srv}/admin/indexing/context?cwd=${encodeURIComponent(cwd)}`, { headers: { 'X-Fantom-Hook-Token': token }, timeoutMs: 3000 });
  if (r.status === 200 && r.json && r.json.ok) {
    ctx = r.json;
    add(true, 'token accepted', `server v${ctx.version}, ${ctx.projects.length} registered projects`);
  } else if (r.status === 401) {
    add(false, 'token accepted', 'server refused the token (401). Rotate it: POST /admin/indexing/report-token, then update the plugin option.');
  } else if (r.status === 404) {
    add(false, 'token accepted', 'server has no /admin/indexing/context route: update the mcpfantom server (needs the claudePlugin change).');
  } else {
    add(false, 'token accepted', `unexpected answer HTTP ${r.status} ${r.error || ''}`.trim());
  }
}
if (ctx) {
  // Refresh the project cache the hooks read (same as SessionStart does).
  writeJson(projectsFile(), { at: ctx.now, serverVersion: ctx.version, projects: ctx.projects });
  const p = ctx.project;
  if (p) {
    add(true, 'project', `"${p.name}" (id ${p.id}, ${p.language}, ${p.versionGroup.label}, lazy ${p.lazy ? 'on' : 'off'}, ${p.functionCount} fns, last indexed ${p.lastIndexed ? ago(p.lastIndexed) : 'never'})`);
    if (!p.lazy) warn('lazy indexing', `off for project ${p.id}: commits are not watched. Enable it in config/fantomMcpServer-config.json indexing.lazy.projects.`);
    if (p.lastRun && p.lastRun.error) warn('last index run', `failed: ${String(p.lastRun.error).slice(0, 120)}`);
  } else {
    warn('project', `${cwd} is not inside a registered project. Register it with /fantom-mcp:add-project (addFantomProject).`);
  }
}

// 5. plugin installed and enabled
let plugins = null;
const skipCli = !!(process.env.FANTOM_PLUGIN_NO_CLI || process.env.FANTOM_PLUGIN_DOCTOR_NO_CLI); // tests: no claude CLI round trip
if (!skipCli) {
  try {
    plugins = JSON.parse(execFileSync('claude', ['plugin', 'list', '--json'], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch { /* claude not on PATH or no JSON */ }
}
if (skipCli) {
  /* nothing to report */
} else if (Array.isArray(plugins)) {
  const mine = plugins.find(p => typeof p.id === 'string' && p.id.startsWith('fantom-mcp@'));
  add(!!mine && mine.enabled !== false, 'plugin', mine
    ? `${mine.id} v${mine.version} ${mine.enabled === false ? 'DISABLED' : 'enabled'} (${mine.scope}) at ${mine.installPath}`
    : 'fantom-mcp is not installed. Run claudePlugin/scripts/install-local.sh (or fantom-mcp setup).');
} else {
  warn('plugin', 'could not run "claude plugin list --json" (claude not on PATH?); skipped.');
}

// 6. legacy duplicates
const home = os.homedir();
try {
  const settings = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
  if (settings.includes('fantom-report-change.sh')) {
    warn('legacy hook', '~/.claude/settings.json still runs scripts/hooks/fantom-report-change.sh: every edit is reported twice. Remove that PostToolUse entry.');
  }
} catch { /* no settings */ }
try {
  const cj = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  const fixes = [];
  if (cj.mcpServers && cj.mcpServers['fantom-mcp']) fixes.push('claude mcp remove fantom-mcp -s user');
  const locals = Object.entries(cj.projects || {})
    .filter(([, v]) => v && v.mcpServers && v.mcpServers['fantom-mcp'])
    .map(([p]) => p);
  if (locals.length) fixes.push(`in each of ${locals.length} director${locals.length === 1 ? 'y' : 'ies'} (${locals.slice(0, 5).join(', ')}${locals.length > 5 ? ', ...' : ''}): claude mcp remove fantom-mcp -s local`);
  if (fixes.length) warn('legacy MCP entry', `"fantom-mcp" from claude mcp add is still configured. Claude Code then suppresses the plugin's own server ("plugin:fantom-mcp:fantom") and keeps the manual one, so plugin option mcp_url has no effect. Fix all at once: node ${path.join(path.dirname(new URL(import.meta.url).pathname), 'fantom-mcp.mjs')} clean-legacy. By hand: ${fixes.join('; ')}.`);
} catch { /* no ~/.claude.json */ }
try {
  const mcpJson = path.join(cwd, '.mcp.json');
  if (fs.existsSync(mcpJson)) {
    const pj = JSON.parse(fs.readFileSync(mcpJson, 'utf8'));
    if (pj.mcpServers && pj.mcpServers['fantom-mcp']) warn('legacy MCP entry', `${mcpJson} also declares "fantom-mcp" (project scope).`);
  }
} catch { /* ignore */ }

// 7. data dir
const dd = dataDir();
let writable = false;
try { fs.accessSync(dd, fs.constants.W_OK); writable = true; } catch { /* not writable */ }
add(writable, 'data dir', writable ? dd : `${dd} not writable: hooks cannot cache the project list.`);

const failed = checks.filter(c => !c.ok);
if (asJson) {
  process.stdout.write(JSON.stringify({ ok: failed.length === 0, cwd, serverUrl: srv, mcpUrl: mcp, checks }, null, 2) + '\n');
} else {
  const mark = c => c.level === 'ok' ? '✔' : c.level === 'warn' ? '!' : '✖';
  for (const c of checks) process.stdout.write(`${mark(c)} ${c.name}: ${c.detail}\n`);
  process.stdout.write(failed.length ? `\n${failed.length} problem${failed.length === 1 ? '' : 's'}.\n` : '\nReady.\n');
}
process.exit(failed.length ? 1 : 0);
