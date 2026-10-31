#!/usr/bin/env node
// PreToolUse hook (Grep, Glob, Bash): when the model searches code with grep,
// rg, find or the Grep tool inside a registered project, add a short tip to
// try the Fantom MCP tools first. Never blocks the call. No network: reads
// the session cache written by session-start.
//
// Throttled per session so it stays a tip, not noise: the first search gets
// it, then at most once every HINT_GAP_MS. Once the model has called a Fantom
// MCP tool this session (the PostToolUse mark below), the tip stops.

import path from 'node:path';
import { dataDir, emit, readJson, readStdinJson, safeId, sessionFile, writeJson } from './_lib.mjs';

const HINT_GAP_MS = 10 * 60 * 1000;

const input = (await readStdinJson()) || {};
const sessionId = input.session_id || process.env.CLAUDE_SESSION_ID || 'unknown';
const tool = String(input.tool_name || '');
const ti = input.tool_input || {};
const stateFile = path.join(dataDir(), 'search-hint-' + safeId(sessionId) + '.json');

// PostToolUse on a Fantom MCP tool: remember that the model uses them.
if (/^mcp__.*fantom/i.test(tool)) {
  const st = readJson(stateFile) || {};
  writeJson(stateFile, { ...st, usedFantom: true });
  process.exit(0);
}

if (!isCodeSearch(tool, ti)) process.exit(0);

const sess = readJson(sessionFile(sessionId));
const project = sess && sess.project;
if (!project) process.exit(0);

const st = readJson(stateFile) || {};
if (st.usedFantom) process.exit(0);
const now = Date.now();
if (st.lastHint && now - st.lastHint < HINT_GAP_MS) process.exit(0);
writeJson(stateFile, { ...st, lastHint: now, hints: (st.hints || 0) + 1 });

emit('PreToolUse',
  `Fantom MCP tip: this is registered project "${project.name}" (projectId ${project.id}). ` +
  `For "how does X work / where is Y / who calls Z", askCodebase, searchFantomCode or getCallers (projectId ${project.id}) ` +
  `answer with the call graph and citations; load them with ToolSearch("fantom", 30). ` +
  `Grep is fine for an exact string you already know.`);
process.exit(0);

/** True for a code search: the Grep tool, or grep/rg/ag/ack/find/git grep in a Bash command. */
function isCodeSearch(name, args) {
  if (name === 'Grep') return true;
  if (name === 'Glob') return false; // file-name listing, not a code question
  if (name !== 'Bash') return false;
  const cmd = String(args.command || '');
  return /(^|[\s;&|(])(rg|grep|egrep|ag|ack|git\s+grep)\s/.test(cmd) ||
    /(^|[\s;&|(])find\s+\S+.*\s-name\s/.test(cmd);
}
