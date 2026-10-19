#!/usr/bin/env node
// Fantom MCP plugin CLI. Node 20+, built-ins only.
//
//   fantom-mcp setup [--marketplace <dir|owner/repo|url>] [--scope user|project|local]
//                    [--server-url <url>] [--mcp-url <url>] [--admin-config <admin.json>]
//                    [--remove-legacy] [--no-doctor]
//   fantom-mcp doctor [--json] [--cwd <dir>]
//   fantom-mcp status [--json] [--cwd <dir>]
//   fantom-mcp token [--rotate] [--admin-config <admin.json>]
//   fantom-mcp clean-legacy [--dry-run]
//   fantom-mcp disconnect [--purge-token]
//
// setup: health check, marketplace add, plugin install, report token (mint
// from admin.json or a prompt), plugin options, legacy cleanup, doctor.
// Every step prints one line. Nothing is deleted without a backup.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ago, http, mcpUrl, projectsFile, reportToken, serverUrl, tokenFile, writeJson } from '../hooks/_lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');              // dist/
const MARKET = 'fantom-mcp';
const PLUGIN = `fantom-mcp@${MARKET}`;
const NO_CLI = !!(process.env.FANTOM_PLUGIN_NO_CLI || process.env.FANTOM_PLUGIN_DOCTOR_NO_CLI);

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'help';
const flags = parseFlags(argv.slice(cmd === 'help' ? 0 : 1));

const out = s => process.stdout.write(s + '\n');
const step = s => out(`\n== ${s}`);
const ok = s => out(`   ok  ${s}`);
const warn = s => out(`   !   ${s}`);
const fail = s => out(`   ✖   ${s}`);

function parseFlags(a) {
  const f = { _: [] };
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (!t.startsWith('--')) { f._.push(t); continue; }
    const k = t.slice(2);
    const next = a[i + 1];
    if (next !== undefined && !next.startsWith('--')) { f[k] = next; i++; } else f[k] = true;
  }
  return f;
}

function claude(args, { quiet = false, cwd } = {}) {
  if (NO_CLI) return { ok: false, out: '', err: 'claude CLI disabled (FANTOM_PLUGIN_NO_CLI)' };
  const r = spawnSync('claude', args, { encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  if (r.error) return { ok: false, out: '', err: r.error.message };
  if (!quiet && r.status !== 0) return { ok: false, out: r.stdout || '', err: (r.stderr || r.stdout || '').trim() };
  return { ok: r.status === 0, out: r.stdout || '', err: (r.stderr || '').trim() };
}

function claudeJson(args) {
  const r = claude(args, { quiet: true });
  if (!r.ok) return null;
  const lines = r.out.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines.slice(i).join('\n')); } catch { /* keep looking */ } }
  return null;
}

function ask(question, { hidden = false } = {}) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const w = rl._writeToOutput;
      rl._writeToOutput = s => { if (s.includes(question)) w.call(rl, question); };
    }
    rl.question(question, a => { rl.close(); if (hidden) out(''); resolve(a.trim()); });
  });
}

function backup(file) {
  const b = `${file}.bak.${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
  fs.copyFileSync(file, b);
  return b;
}

function marketplaceDefault() {
  // dist/ sits inside the marketplace directory of a checkout.
  const dir = path.resolve(PLUGIN_ROOT, '..');
  return fs.existsSync(path.join(dir, '.claude-plugin', 'marketplace.json')) ? dir : '';
}

function adminConfigDefault() {
  const m = marketplaceDefault();
  if (!m) return '';
  const f = path.join(m, '..', 'config', 'admin.json');
  return fs.existsSync(f) ? path.resolve(f) : '';
}

async function adminCreds(explicit) {
  const f = explicit || adminConfigDefault();
  if (f) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j.username && j.password) return { user: j.username, pass: j.password, from: f };
    } catch { /* fall through to prompt */ }
  }
  if (!process.stdin.isTTY) return null;
  const user = await ask('   admin user: ');
  const pass = await ask('   admin password: ', { hidden: true });
  return user && pass ? { user, pass, from: 'prompt' } : null;
}

async function mintToken(srv, creds) {
  const r = await http('POST', `${srv}/admin/indexing/report-token`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${creds.user}:${creds.pass}`).toString('base64') },
    timeoutMs: 10000,
  });
  if (r.status === 200 && r.json && r.json.token) return { token: r.json.token };
  return { error: r.status === 401 ? 'admin login refused (401)' : r.error || `HTTP ${r.status} ${(r.text || '').slice(0, 100)}` };
}

function saveTokenFile(token) {
  const f = tokenFile();
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, token, { mode: 0o600 });
  try { fs.chmodSync(f, 0o600); } catch { /* windows */ }
  return f;
}

function configurePlugin(values) {
  if (NO_CLI) return { ok: false, err: 'claude CLI disabled' };
  const r = spawnSync('claude', ['plugin', 'configure', PLUGIN, '--values-stdin'], { input: JSON.stringify(values), encoding: 'utf8', timeout: 60000 });
  return { ok: r.status === 0, err: (r.stderr || r.stdout || '').trim() };
}

/** Legacy setup on this machine: manual MCP entries and the shell hook. */
function findLegacy() {
  const home = os.homedir();
  const res = { userMcp: false, localMcp: [], settingsHook: false, settingsFile: path.join(home, '.claude', 'settings.json'), claudeJson: path.join(home, '.claude.json') };
  try {
    const cj = JSON.parse(fs.readFileSync(res.claudeJson, 'utf8'));
    res.userMcp = !!(cj.mcpServers && cj.mcpServers['fantom-mcp']);
    res.localMcp = Object.entries(cj.projects || {}).filter(([, v]) => v && v.mcpServers && v.mcpServers['fantom-mcp']).map(([p]) => p);
  } catch { /* none */ }
  try { res.settingsHook = fs.readFileSync(res.settingsFile, 'utf8').includes('fantom-report-change.sh'); } catch { /* none */ }
  return res;
}

function cleanLegacy({ dryRun }) {
  const l = findLegacy();
  const found = l.userMcp || l.localMcp.length || l.settingsHook;
  if (!found) { ok('no legacy setup found'); return true; }
  const say = dryRun ? (s => out(`   would ${s}`)) : null;
  if (l.userMcp) {
    if (say) say('remove user-scope MCP server fantom-mcp (claude mcp remove fantom-mcp -s user)');
    else {
      const r = claude(['mcp', 'remove', 'fantom-mcp', '-s', 'user']);
      r.ok ? ok('removed user-scope MCP server fantom-mcp (restore: claude mcp add --transport http -s user fantom-mcp http://localhost:9191/fantom/mcp)') : warn(`could not remove user-scope entry: ${r.err}`);
    }
  }
  // Direct edit of ~/.claude.json, with a backup. Used when `claude mcp
  // remove` cannot see the entry: the directory is gone, or Claude Code maps
  // that cwd to another project key (e.g. a git root).
  const editClaudeJson = (dir, why) => {
    try {
      const b = backup(l.claudeJson);
      const cj = JSON.parse(fs.readFileSync(l.claudeJson, 'utf8'));
      delete cj.projects[dir].mcpServers['fantom-mcp'];
      fs.writeFileSync(l.claudeJson, JSON.stringify(cj, null, 2) + '\n');
      ok(`removed local-scope entry for ${dir} by editing ${l.claudeJson} (${why}; backup ${path.basename(b)})`);
    } catch (e) { warn(`could not edit ${l.claudeJson} for ${dir}: ${e.message}`); }
  };
  for (const dir of l.localMcp) {
    if (say) { say(`remove local-scope MCP server fantom-mcp for ${dir}`); continue; }
    if (!fs.existsSync(dir)) { editClaudeJson(dir, 'directory missing'); continue; }
    const r = claude(['mcp', 'remove', 'fantom-mcp', '-s', 'local'], { cwd: dir });
    if (r.ok) ok(`removed local-scope MCP server fantom-mcp for ${dir}`);
    else editClaudeJson(dir, `claude mcp remove said: ${r.err.split('\n')[0]}`);
  }
  if (l.settingsHook) {
    if (say) say(`remove the fantom-report-change.sh PostToolUse hook from ${l.settingsFile}`);
    else {
      try {
        const b = backup(l.settingsFile);
        const s = JSON.parse(fs.readFileSync(l.settingsFile, 'utf8'));
        const h = s.hooks || {};
        for (const ev of Object.keys(h)) {
          h[ev] = h[ev].map(m => ({ ...m, hooks: (m.hooks || []).filter(x => !String(x.command || '').includes('fantom-report-change.sh')) })).filter(m => m.hooks.length);
          if (!h[ev].length) delete h[ev];
        }
        fs.writeFileSync(l.settingsFile, JSON.stringify(s, null, 2) + '\n');
        ok(`removed the fantom-report-change.sh hook from ${l.settingsFile} (backup ${path.basename(b)})`);
      } catch (e) { warn(`could not edit ${l.settingsFile}: ${e.message}`); }
    }
  }
  return true;
}

function runDoctor(extra = []) {
  const r = spawnSync(process.execPath, [path.join(HERE, 'doctor.mjs'), ...extra], { stdio: 'inherit' });
  return r.status === 0;
}

// ---------------------------------------------------------------- commands

async function setup() {
  const srv = (flags['server-url'] || serverUrl()).replace(/\/+$/, '');
  const scope = flags.scope || 'user';
  const market = flags.marketplace || marketplaceDefault();
  if (!market) { fail('no marketplace given. Use --marketplace <dir|owner/repo|url>.'); return 2; }
  if (claude(['--version'], { quiet: true }).ok === false && !NO_CLI) { fail('claude CLI not found on PATH'); return 1; }

  step(`server ${srv}`);
  const h = await http('GET', `${srv}/health`, { timeoutMs: 6000 });
  const up = h.status === 200;
  up ? ok(`up (initialized=${h.json && h.json.initialized})`) : warn(`not reachable (${h.error || 'HTTP ' + h.status}); install continues, token minting is skipped`);

  step(`marketplace ${MARKET} -> ${market}`);
  const markets = claudeJson(['plugin', 'marketplace', 'list', '--json']);
  if (Array.isArray(markets) && markets.some(m => m.name === MARKET)) ok('already added');
  else {
    const r = claude(['plugin', 'marketplace', 'add', market]);
    if (!r.ok) { fail(`marketplace add failed: ${r.err}`); return 1; }
    ok('added');
  }

  step(`install ${PLUGIN} (scope ${scope})`);
  const plugins = claudeJson(['plugin', 'list', '--json']);
  if (Array.isArray(plugins) && plugins.some(p => p.id === PLUGIN)) ok('already installed (a directory marketplace is read in place; /reload-plugins picks up a new build)');
  else {
    const r = claude(['plugin', 'install', PLUGIN, '--scope', scope]);
    if (!r.ok) { fail(`install failed: ${r.err}`); return 1; }
    ok('installed');
  }

  step('report token');
  let { token, source } = reportToken();
  if (token) ok(`using ${source}`);
  else if (!up) warn('server down: no token minted. Re-run "fantom-mcp token --rotate" when it is up.');
  else {
    const creds = await adminCreds(flags['admin-config']);
    if (!creds) warn('no admin credentials (pass --admin-config <admin.json> or run in a terminal). Create a token in Dashboard > Indexing > Report token and save it to ' + tokenFile());
    else {
      const m = await mintToken(srv, creds);
      if (m.error) warn(`could not mint a token: ${m.error}`);
      else { token = m.token; ok(`new token saved to ${saveTokenFile(token)} (mode 600; any older token stopped working)`); }
    }
  }
  const values = {};
  if (token) values.report_token = token;
  if (flags['server-url']) values.server_url = srv;
  if (flags['mcp-url']) values.mcp_url = flags['mcp-url'];
  if (Object.keys(values).length) {
    const r = configurePlugin(values);
    r.ok ? ok(`plugin options set: ${Object.keys(values).join(', ')}`) : warn(`claude plugin configure failed (${r.err}); hooks fall back to ${tokenFile()} and the defaults`);
  }

  step('legacy setup');
  const l = findLegacy();
  if (flags['remove-legacy']) cleanLegacy({ dryRun: false });
  else if (l.userMcp || l.localMcp.length || l.settingsHook) {
    if (l.userMcp) warn('user-scope MCP server "fantom-mcp" (claude mcp add) exists: Claude Code keeps it and suppresses the plugin server.');
    if (l.localMcp.length) warn(`local-scope MCP server "fantom-mcp" in ${l.localMcp.length} director${l.localMcp.length === 1 ? 'y' : 'ies'}.`);
    if (l.settingsHook) warn('~/.claude/settings.json still runs fantom-report-change.sh: every edit is reported twice.');
    warn('fix all of it: fantom-mcp clean-legacy   (or re-run setup with --remove-legacy)');
  } else ok('none found');

  if (flags['no-doctor']) return 0;
  step(`doctor (${process.cwd()})`);
  const good = runDoctor();
  out('\nNext: start a new Claude Code session in a registered project, or /reload-plugins in an open one. /mcp shows the server as "fantom".');
  return good ? 0 : 1;
}

async function status() {
  const cwd = path.resolve(flags.cwd || process.cwd());
  const srv = serverUrl();
  const h = await http('GET', `${srv}/health`, { timeoutMs: 6000 });
  const res = { serverUrl: srv, mcpUrl: mcpUrl(), up: h.status === 200, cwd };
  if (res.up) {
    res.initialized = !!(h.json && h.json.initialized);
    res.phase = h.json && h.json.initStatus && h.json.initStatus.phase;
    res.uptimeSec = h.json && Math.round(h.json.uptime);
    const { token, source } = reportToken();
    res.tokenSource = source || null;
    if (token) {
      const r = await http('GET', `${srv}/admin/indexing/context?cwd=${encodeURIComponent(cwd)}`, { headers: { 'X-Fantom-Hook-Token': token }, timeoutMs: 4000 });
      if (r.status === 200 && r.json) {
        res.version = r.json.version;
        res.projects = r.json.projects.length;
        res.project = r.json.project;
        writeJson(projectsFile(), { at: r.json.now, serverVersion: r.json.version, projects: r.json.projects });
      } else res.contextError = r.status === 401 ? 'token refused' : (r.error || `HTTP ${r.status}`);
    }
  } else res.error = h.error || `HTTP ${h.status}`;
  if (flags.json) { out(JSON.stringify(res, null, 2)); return res.up ? 0 : 1; }
  out(`server    ${srv}  ${res.up ? `up (v${res.version || '?'}, ${res.phase || 'phase ?'}, uptime ${res.uptimeSec} s)` : `DOWN (${res.error})`}`);
  out(`mcp       ${res.mcpUrl}`);
  out(`token     ${res.tokenSource || 'none'}${res.contextError ? ` (${res.contextError})` : ''}`);
  if (res.projects != null) out(`projects  ${res.projects} registered`);
  const p = res.project;
  if (p) {
    out(`project   "${p.name}" id ${p.id}, ${p.language}, ${p.versionGroup.label}, lazy ${p.lazy ? 'on' : 'off'}, ${p.functionCount} fns / ${p.typeCount} types`);
    out(`index     last indexed ${p.lastIndexed ? ago(p.lastIndexed) : 'never'}${p.lastRun ? `, last run ${p.lastRun.trigger} ${ago(p.lastRun.startedAt)}${p.lastRun.error ? ' FAILED' : ''}` : ''}, ${p.focusFiles} focus files`);
  } else if (res.up && !res.contextError && res.tokenSource) out(`project   ${cwd} is not a registered project (/fantom-mcp:add-project)`);
  return res.up ? 0 : 1;
}

async function token() {
  const cur = reportToken();
  if (!flags.rotate) {
    out(cur.token ? `token present (${cur.source}); value hidden. Rotate: fantom-mcp token --rotate` : `no token. Mint one: fantom-mcp token --rotate`);
    return cur.token ? 0 : 1;
  }
  const srv = serverUrl();
  const creds = await adminCreds(flags['admin-config']);
  if (!creds) { fail('no admin credentials (--admin-config <admin.json>, or run in a terminal)'); return 1; }
  const m = await mintToken(srv, creds);
  if (m.error) { fail(`could not mint: ${m.error}`); return 1; }
  ok(`new token saved to ${saveTokenFile(m.token)}; the old one stopped working`);
  const r = configurePlugin({ report_token: m.token });
  r.ok ? ok('plugin option report_token updated') : warn(`plugin option not updated (${r.err}); hooks use the token file`);
  return 0;
}

function disconnect() {
  step('uninstall');
  const r1 = claude(['plugin', 'uninstall', PLUGIN]);
  r1.ok ? ok(`uninstalled ${PLUGIN}`) : warn(`uninstall: ${r1.err}`);
  const r2 = claude(['plugin', 'marketplace', 'remove', MARKET]);
  r2.ok ? ok(`removed marketplace ${MARKET}`) : warn(`marketplace remove: ${r2.err}`);
  if (flags['purge-token']) { try { fs.unlinkSync(tokenFile()); ok(`deleted ${tokenFile()}`); } catch { warn('no token file to delete'); } }
  else ok(`kept ${tokenFile()} (other clients may use it; --purge-token deletes it)`);
  return 0;
}

function help() {
  out(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 15).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  return cmd === 'help' ? 0 : 2;
}

const run = { setup, status, token, disconnect, help,
  doctor: () => (runDoctor(flags.json ? ['--json'] : []) ? 0 : 1),
  'clean-legacy': () => (cleanLegacy({ dryRun: !!flags['dry-run'] }) ? 0 : 1),
};
try {
  process.exit(await (run[cmd] || help)());
} catch (e) {
  fail(e && e.message ? e.message : String(e));
  process.exit(1);
}
