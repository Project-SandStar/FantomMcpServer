#!/usr/bin/env node
// PostToolUse hook (Edit|Write|MultiEdit|NotebookEdit): tell the Fantom MCP
// server which file changed. Same contract as scripts/hooks/fantom-report-change.sh
// in the server repo. Never blocks or fails the edit: 2 s cap, no output,
// exit 0 whatever happens. A missing token or a file outside every known
// project means no request at all.

import {
  CLIENT, http, projectForPath, projectsFile, readJson, readStdinJson, reportToken, serverUrl,
} from './_lib.mjs';

const input = await readStdinJson();
if (!input) process.exit(0);

const ti = input.tool_input || {};
const file = typeof ti.file_path === 'string' ? ti.file_path
  : typeof ti.notebook_path === 'string' ? ti.notebook_path : '';
if (!file) process.exit(0);

const { token } = reportToken();
if (!token) process.exit(0);

// Skip the request when the cached project list says the file is outside
// every registered project (non-Fantom repos). No cache: report anyway and
// let the server decide.
const cache = readJson(projectsFile());
if (cache && Array.isArray(cache.projects) && cache.projects.length && !projectForPath(cache.projects, file)) {
  process.exit(0);
}

await http('POST', `${serverUrl()}/admin/indexing/report`, {
  headers: { 'X-Fantom-Hook-Token': token },
  body: { files: [file], cwd: input.cwd, sessionId: input.session_id, client: CLIENT },
  timeoutMs: 2000,
});
process.exit(0);
