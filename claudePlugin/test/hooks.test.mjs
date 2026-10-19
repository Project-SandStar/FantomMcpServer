// Hook and doctor tests against a fake Fantom MCP server. No real server,
// no claude CLI needed:  node --test claudePlugin/test/*.test.mjs  (after build)
//
// The fake server lives in this process, so hooks run with async spawn:
// spawnSync would block the event loop and the server could never answer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'dist');
const HOOKS = path.join(DIST, 'hooks');
const DOCTOR = path.join(DIST, 'bin', 'doctor.mjs');
const TOKEN = 'test-token-123';
const ISO = '2026-10-17T20:00:00.000Z';

const PROJECTS = [
  { id: 7, name: 'demo', path: '/x/proj', language: 'fantom' },
  { id: 8, name: 'other', path: '/y/other', language: 'typescript' },
];

let server; let base; let reports = [];
let data;

before(async () => {
  assert.ok(fs.existsSync(path.join(HOOKS, 'session-start.mjs')), 'run scripts/build.mjs first');
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const tok = req.headers['x-fantom-hook-token'];
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (u.pathname === '/health') return json(200, { status: 'ok', initialized: true, initStatus: { phase: 'ready' } });
    if (u.pathname === '/mcp') return json(400, { error: 'no session' });
    if (u.pathname === '/admin/indexing/context') {
      if (tok !== TOKEN) return json(401, { error: 'Invalid or missing report token' });
      const cwd = u.searchParams.get('cwd') || '';
      if (!cwd) return json(400, { error: 'cwd is required' });
      const hit = PROJECTS.find(p => cwd === p.path || cwd.startsWith(p.path + '/')) || null;
      const project = hit ? {
        ...hit, parserType: 'regex', versionGroup: { key: 'haxall/4.0.6', label: 'Haxall 4.0.6' }, lazy: true, autoIndex: true,
        indexMode: 'scan', functionCount: 12, typeCount: 3, lastIndexed: ISO,
        lastRun: { id: 1, trigger: 'report', startedAt: ISO, finishedAt: ISO, filesParsed: 1, changeSource: 'report', error: null },
        focusFiles: 2,
      } : null;
      return json(200, { ok: true, version: '9.9.9', now: ISO, cwd, project, projects: PROJECTS });
    }
    if (u.pathname === '/admin/indexing/report-token' && req.method === 'POST') {
      const auth = req.headers.authorization || '';
      const creds = Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString();
      if (creds !== 'admin:pw') return json(401, { error: 'unauthorized' });
      return json(200, { token: 'minted-token-xyz', createdAt: ISO });
    }
    if (u.pathname === '/admin/indexing/report' && req.method === 'POST') {
      if (tok !== TOKEN) return json(401, { error: 'bad token' });
      let s = ''; req.on('data', d => { s += d; }); req.on('end', () => { reports.push(JSON.parse(s)); json(202, { projectId: 7, queued: 1, taskId: 1, unknownFiles: [] }); });
      return;
    }
    json(404, { error: 'nope' });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'fantom-plugin-test-'));
});

after(async () => {
  await new Promise(r => server.close(r));
  fs.rmSync(data, { recursive: true, force: true });
});

/** Run a hook or the doctor as Claude Code would; resolves with its output. */
function run(script, { input, args = [], env: envExtra = {} } = {}) {
  const env = {
    ...process.env,
    HOME: data,
    CLAUDE_PLUGIN_ROOT: DIST,
    CLAUDE_PLUGIN_DATA: data,
    CLAUDE_PLUGIN_OPTION_SERVER_URL: base,
    CLAUDE_PLUGIN_OPTION_MCP_URL: base + '/mcp',
    CLAUDE_PLUGIN_OPTION_REPORT_TOKEN: TOKEN,
    FANTOM_PLUGIN_NO_CLI: '1',
    ...envExtra,
  };
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    const t = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => { clearTimeout(t); resolve({ code, out, err }); });
    child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
}

function ctxOf(out, event) {
  if (!out.trim()) return '';
  const j = JSON.parse(out.trim().split('\n').pop());
  assert.equal(j.hookSpecificOutput.hookEventName, event);
  return j.hookSpecificOutput.additionalContext;
}

test('session-start: registered project gets context, caches projects and session', async () => {
  const r = await run(path.join(HOOKS, 'session-start.mjs'), { input: { session_id: 's1', cwd: '/x/proj/sub', hook_event_name: 'SessionStart', source: 'startup' } });
  assert.equal(r.code, 0, r.err);
  const ctx = ctxOf(r.out, 'SessionStart');
  assert.match(ctx, /registered project "demo"/);
  assert.match(ctx, /id 7/);
  assert.match(ctx, /Haxall 4\.0\.6/);
  assert.match(ctx, /lazy indexing on/);
  assert.match(ctx, /2 files in focus/);
  assert.match(ctx, /ToolSearch\("fantom", 30\)/);
  assert.match(ctx, /versionGroup "haxall\/4\.0\.6"/);
  const pj = JSON.parse(fs.readFileSync(path.join(data, 'projects.json'), 'utf8'));
  assert.equal(pj.projects.length, 2);
  const sj = JSON.parse(fs.readFileSync(path.join(data, 'session-s1.json'), 'utf8'));
  assert.equal(sj.project.id, 7);
  assert.equal(sj.stale, false);
});

test('session-start: unknown directory prints nothing', async () => {
  const r = await run(path.join(HOOKS, 'session-start.mjs'), { input: { session_id: 's2', cwd: '/nowhere/at/all' } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), '');
  assert.ok(!fs.existsSync(path.join(data, 'session-s2.json')));
});

test('session-start: bad token is reported, nothing cached for the session', async () => {
  const r = await run(path.join(HOOKS, 'session-start.mjs'), { input: { session_id: 's3', cwd: '/x/proj' }, env: { CLAUDE_PLUGIN_OPTION_REPORT_TOKEN: 'wrong' } });
  assert.equal(r.code, 0, r.err);
  assert.match(ctxOf(r.out, 'SessionStart'), /no valid report token/);
});

test('session-start: server down falls back to the cached project list', async () => {
  const r = await run(path.join(HOOKS, 'session-start.mjs'), { input: { session_id: 's4', cwd: '/x/proj/deeper' }, env: { CLAUDE_PLUGIN_OPTION_SERVER_URL: 'http://127.0.0.1:1' } });
  assert.equal(r.code, 0, r.err);
  const ctx = ctxOf(r.out, 'SessionStart');
  assert.match(ctx, /did not answer/);
  assert.match(ctx, /"demo" \(id 7\)/);
  const sj = JSON.parse(fs.readFileSync(path.join(data, 'session-s4.json'), 'utf8'));
  assert.equal(sj.stale, true);
});

test('report-change: posts the edited file with the token and client name', async () => {
  reports = [];
  const r = await run(path.join(HOOKS, 'report-change.mjs'), { input: {
    session_id: 's1', cwd: '/x/proj', hook_event_name: 'PostToolUse', tool_name: 'Edit',
    tool_input: { file_path: '/x/proj/fan/A.fan', old_string: 'a', new_string: 'b' }, tool_response: {},
  } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '');
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].files, ['/x/proj/fan/A.fan']);
  assert.equal(reports[0].client, 'claude-code-plugin');
  assert.equal(reports[0].sessionId, 's1');
  assert.equal(reports[0].cwd, '/x/proj');
});

test('report-change: file outside every cached project is not sent', async () => {
  reports = [];
  const r = await run(path.join(HOOKS, 'report-change.mjs'), { input: { session_id: 's1', cwd: '/tmp', tool_name: 'Write', tool_input: { file_path: '/tmp/not-a-project/x.ts' } } });
  assert.equal(r.code, 0, r.err);
  assert.equal(reports.length, 0);
});

test('report-change: no token, no request, still exit 0', async () => {
  reports = [];
  const r = await run(path.join(HOOKS, 'report-change.mjs'), { input: { tool_name: 'Edit', tool_input: { file_path: '/x/proj/a.fan' } }, env: { CLAUDE_PLUGIN_OPTION_REPORT_TOKEN: '', FANTOM_REPORT_TOKEN: '' } });
  assert.equal(r.code, 0, r.err);
  assert.equal(reports.length, 0);
});

test('report-change: server down never fails the edit', async () => {
  const r = await run(path.join(HOOKS, 'report-change.mjs'), { input: { tool_name: 'Edit', tool_input: { file_path: '/x/proj/a.fan' } }, env: { CLAUDE_PLUGIN_OPTION_SERVER_URL: 'http://127.0.0.1:1' } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '');
});

test('report-change: empty stdin is ignored', async () => {
  const r = await run(path.join(HOOKS, 'report-change.mjs'));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '');
});

test('prompt-hint: names the tool for a callers question in a known session', async () => {
  const r = await run(path.join(HOOKS, 'prompt-hint.mjs'), { input: { session_id: 's1', prompt: 'who calls ConnTuning.pollTime and what breaks if I change it?' } });
  assert.equal(r.code, 0, r.err);
  const ctx = ctxOf(r.out, 'UserPromptSubmit');
  assert.match(ctx, /getCallers/);
  assert.match(ctx, /projectId 7/);
});

test('prompt-hint: silent for slash commands, short prompts and unknown sessions', async () => {
  for (const input of [
    { session_id: 's1', prompt: '/fantom-mcp:doctor' },
    { session_id: 's1', prompt: 'thanks' },
    { session_id: 'nope', prompt: 'who calls ConnTuning.pollTime in this project?' },
    { session_id: 's1', prompt: 'please rename the variable on line 12 to something shorter' },
  ]) {
    const r = await run(path.join(HOOKS, 'prompt-hint.mjs'), { input });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), '', JSON.stringify(input));
  }
});

test('doctor --json: all checks pass against the fake server', async () => {
  const r = await run(DOCTOR, { args: ['--json', '--cwd', '/x/proj'] });
  assert.equal(r.code, 0, r.out + r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.ok, true);
  const names = j.checks.map(c => c.name);
  for (const n of ['server', 'mcp endpoint', 'report token', 'token accepted', 'project', 'data dir']) assert.ok(names.includes(n), n);
  assert.ok(j.checks.find(c => c.name === 'project').detail.includes('"demo"'));
});

test('doctor: server down exits 1 with a start hint', async () => {
  const r = await run(DOCTOR, { args: ['--cwd', '/x/proj'], env: { CLAUDE_PLUGIN_OPTION_SERVER_URL: 'http://127.0.0.1:1', CLAUDE_PLUGIN_OPTION_MCP_URL: 'http://127.0.0.1:1/mcp' } });
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /✖ server: .*not reachable/);
  assert.match(r.out, /npm run start:dev/);
});

test('build output: manifest, skills and hooks are consistent', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'fantom-mcp');
  assert.ok(manifest.userConfig.report_token.sensitive);
  const hooks = JSON.parse(fs.readFileSync(path.join(DIST, 'hooks', 'hooks.json'), 'utf8'));
  for (const ev of Object.values(hooks.hooks)) for (const m of ev) for (const h of m.hooks) {
    const f = h.command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/)[1];
    assert.ok(fs.existsSync(path.join(DIST, f)), f);
  }
  const skills = fs.readdirSync(path.join(DIST, 'skills'));
  assert.ok(skills.includes('fantom-mcp') && skills.includes('doctor') && skills.includes('wf-create-pod'));
  for (const s of skills) {
    const md = fs.readFileSync(path.join(DIST, 'skills', s, 'SKILL.md'), 'utf8');
    assert.match(md, new RegExp(`^name: ${s}$`, 'm'), s);
    assert.match(md, /^description: .+/m, s);
    if (s.startsWith('wf-')) assert.doesNotMatch(md, /(^|[^\\])\$(\d|ARGUMENTS)/, `${s} has an unescaped $ placeholder`);
  }
  const mcp = JSON.parse(fs.readFileSync(path.join(DIST, '.mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers.fantom.url, '${user_config.mcp_url}');
  const pkg = JSON.parse(fs.readFileSync(path.join(DIST, 'package.json'), 'utf8'));
  assert.equal(pkg.version, manifest.version);
  assert.ok(fs.existsSync(path.join(DIST, pkg.bin['fantom-mcp'])));
});

const CLI = path.join(DIST, 'bin', 'fantom-mcp.mjs');

test('cli status --json: server, token and project for the cwd', async () => {
  const r = await run(CLI, { args: ['status', '--json', '--cwd', '/x/proj/deep'] });
  assert.equal(r.code, 0, r.out + r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.up, true);
  assert.equal(j.version, '9.9.9');
  assert.equal(j.projects, 2);
  assert.equal(j.project.id, 7);
  assert.equal(j.tokenSource, 'plugin option report_token');
});

test('cli status: server down exits 1 and says so', async () => {
  const r = await run(CLI, { args: ['status', '--cwd', '/x/proj'], env: { CLAUDE_PLUGIN_OPTION_SERVER_URL: 'http://127.0.0.1:1' } });
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /DOWN/);
});

test('cli token: reports presence without printing the value', async () => {
  const r = await run(CLI, { args: ['token'] });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /token present/);
  assert.doesNotMatch(r.out, new RegExp(TOKEN));
});

test('cli token --rotate: mints via admin.json, writes the token file', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fantom-plugin-home-'));
  const admin = path.join(home, 'admin.json');
  fs.writeFileSync(admin, JSON.stringify({ username: 'admin', password: 'pw' }));
  try {
    const r = await run(CLI, { args: ['token', '--rotate', '--admin-config', admin], env: { HOME: home, CLAUDE_PLUGIN_OPTION_REPORT_TOKEN: '' } });
    assert.equal(r.code, 0, r.out + r.err);
    const f = path.join(home, '.fantom-mcp', 'report-token');
    assert.equal(fs.readFileSync(f, 'utf8'), 'minted-token-xyz');
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.match(r.out, /plugin option not updated/); // claude CLI disabled in tests
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('cli clean-legacy --dry-run: lists every legacy entry, changes nothing', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fantom-plugin-home-'));
  const cj = { mcpServers: { 'fantom-mcp': { type: 'http', url: 'x' } }, projects: { '/a': { mcpServers: { 'fantom-mcp': {} } }, '/b': { mcpServers: {} } } };
  const settings = { hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: '/repo/scripts/hooks/fantom-report-change.sh' }] }] } };
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(cj));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(settings));
  try {
    const r = await run(CLI, { args: ['clean-legacy', '--dry-run'], env: { HOME: home } });
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /would remove user-scope/);
    assert.match(r.out, /would remove local-scope MCP server fantom-mcp for \/a/);
    assert.doesNotMatch(r.out, /for \/b/);
    assert.match(r.out, /would remove the fantom-report-change.sh/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')), cj);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('cli clean-legacy: removes the settings hook with a backup, keeps other hooks', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fantom-plugin-home-'));
  const settings = { permissions: { allow: ['Bash(ls:*)'] }, hooks: { PostToolUse: [
    { matcher: '', hooks: [{ type: 'command', command: 'bash ~/notify.sh' }] },
    { matcher: 'Edit|Write', hooks: [{ type: 'command', command: '/repo/scripts/hooks/fantom-report-change.sh', timeout: 5 }] },
  ] } };
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(settings));
  try {
    const r = await run(CLI, { args: ['clean-legacy'], env: { HOME: home } });
    assert.equal(r.code, 0, r.out + r.err);
    const s = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(s.permissions, settings.permissions);
    assert.equal(s.hooks.PostToolUse.length, 1);
    assert.equal(s.hooks.PostToolUse[0].hooks[0].command, 'bash ~/notify.sh');
    assert.ok(fs.readdirSync(path.join(home, '.claude')).some(n => n.startsWith('settings.json.bak.')));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('cli help and unknown command', async () => {
  const r = await run(CLI, { args: ['help'] });
  assert.equal(r.code, 0);
  assert.match(r.out, /fantom-mcp setup/);
  const u = await run(CLI, { args: ['bogus'] });
  assert.equal(u.code, 2);
});
