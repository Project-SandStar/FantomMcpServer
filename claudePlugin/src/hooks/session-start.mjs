#!/usr/bin/env node
// SessionStart hook: tell the model whether this directory is a registered
// Fantom MCP project, how fresh its index is, and which tools to reach for.
//
// One GET to /admin/indexing/context (hook token, 1.5 s cap). The answer is
// cached under CLAUDE_PLUGIN_DATA so the other hooks need no network and so
// a server that is down can still be named. Prints nothing for directories
// the server does not know (unless they look like Fantom code).

import {
  ago, emit, http, looksLikeFantomDir, projectForPath, projectsFile, pruneSessions,
  readJson, readStdinJson, reportToken, serverUrl, sessionFile, writeJson,
} from './_lib.mjs';

const input = (await readStdinJson()) || {};
const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
const sessionId = input.session_id || process.env.CLAUDE_SESSION_ID || 'unknown';
const srv = serverUrl();
const { token } = reportToken();

let ctx = null;
let status = 'down'; // up | down | badtoken | notoken | error
if (token) {
  // 2.5 s: a down server refuses at once; a busy one (heavy embed job) may
  // need a moment. hooks.json caps the whole hook at 5 s.
  const r = await http('GET', `${srv}/admin/indexing/context?cwd=${encodeURIComponent(cwd)}`, {
    headers: { 'X-Fantom-Hook-Token': token },
    timeoutMs: 2500,
  });
  if (r.status === 200 && r.json && r.json.ok) { ctx = r.json; status = 'up'; }
  else if (r.status === 401) status = 'badtoken';
  else if (r.status === 0) status = 'down';
  else status = 'error';
} else {
  const h = await http('GET', `${srv}/health`, { timeoutMs: 1000 });
  status = h.status === 200 ? 'notoken' : 'down';
}

pruneSessions();

// Cache: project roots (for the other hooks and for the "server down" case)
// and this session's project.
const cachedProjects = readJson(projectsFile());
let project = null;
if (ctx) {
  project = ctx.project;
  writeJson(projectsFile(), { at: ctx.now, serverVersion: ctx.version, projects: ctx.projects });
  if (project) writeJson(sessionFile(sessionId), { cwd, at: ctx.now, project, stale: false });
} else if (cachedProjects && Array.isArray(cachedProjects.projects)) {
  const hit = projectForPath(cachedProjects.projects, cwd);
  if (hit) {
    project = hit;
    writeJson(sessionFile(sessionId), { cwd, at: new Date().toISOString(), project: hit, stale: true });
  }
}

const lines = [];
if (status === 'up') {
  if (project) lines.push(...describe(ctx));
  else if (looksLikeFantomDir(cwd)) {
    lines.push(`Fantom MCP plugin: server up (v${ctx.version}) but this directory is not a registered project. It looks like Fantom/Axon code: run /fantom-mcp:add-project to index it, or listFantomProjects to see what is registered.`);
  }
} else if (status === 'down') {
  if (project) {
    lines.push(`Fantom MCP plugin: the server at ${srv} did not answer (down, or busy with a heavy index job). This directory is registered project "${project.name}" (id ${project.id}). Its tools may fail or be slow until the server is back; run /fantom-mcp:doctor to check. Do not guess Fantom/Axon APIs from memory meanwhile; say the index is unavailable.`);
  }
} else if (status === 'badtoken' || status === 'notoken') {
  lines.push(`Fantom MCP plugin: the server at ${srv} is up but the plugin has no valid report token, so edits are not reported and project context is unavailable. Run /fantom-mcp:doctor, or claudePlugin/scripts/install-local.sh in the mcpfantom repo.`);
} else if (status === 'error' && project) {
  lines.push(`Fantom MCP plugin: the server at ${srv} answered with an error for this directory (project "${project.name}", id ${project.id}). Run /fantom-mcp:doctor.`);
}

emit('SessionStart', lines.join('\n'));

function describe(c) {
  const p = c.project;
  const bits = [`id ${p.id}`, p.language];
  if (p.versionGroup && p.versionGroup.key !== 'other') bits.push(`version group "${p.versionGroup.label}"`);
  bits.push(`lazy indexing ${p.lazy ? 'on' : 'off'}`);
  bits.push(`${p.functionCount} functions / ${p.typeCount} types`);
  bits.push(`last indexed ${p.lastIndexed ? ago(p.lastIndexed) : 'never'}`);
  if (p.lastRun) bits.push(`last run "${p.lastRun.trigger}" ${ago(p.lastRun.startedAt)}${p.lastRun.error ? ' FAILED' : ''}`);
  if (p.focusFiles) bits.push(`${p.focusFiles} file${p.focusFiles === 1 ? '' : 's'} in focus`);
  const scope = p.versionGroup && p.versionGroup.key !== 'other'
    ? `projectId ${p.id} or versionGroup "${p.versionGroup.key}"`
    : `projectId ${p.id}`;
  const out = [
    `Fantom MCP plugin: server up (v${c.version}). This directory is registered project "${p.name}" (${bits.join(', ')}).`,
    `Use the Fantom MCP tools before grepping or guessing an API. Tools are deferred: run ToolSearch("fantom", 30) once, then: askCodebase (how does X work, where is Y; ${scope}) · searchFantomCode / semanticCodeSearch (find code; ${scope}) · getCallers + getCodeImpact (before changing a symbol) · whatChangedRecently / getSymbolHistory (why did it change) · searchLocalDocs (Fantom/Haxall/SkySpark docs) · searchVersionedApi (SkySpark 3.x to 4.0). Edits made with Edit/Write are reported by the plugin hook; call reportChanges only for files changed by shell commands.`,
  ];
  if (p.lastRun && p.lastRun.error) out.push(`The last index run failed: ${String(p.lastRun.error).slice(0, 160)}. Results may be stale; refreshFantomProject or /fantom-mcp:doctor.`);
  else if (!p.lastIndexed) out.push('This project has never been indexed: call refreshFantomProject before relying on search results.');
  return out;
}
