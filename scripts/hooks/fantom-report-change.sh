#!/bin/bash
# Claude Code PostToolUse hook: report an edited file to the Fantom MCP server.
#
# Matcher: Edit|Write|MultiEdit|NotebookEdit. Reads the hook JSON from stdin
# and POSTs { files, cwd, sessionId, client } to /admin/indexing/report.
# Never blocks or fails the edit: 2 s cap, every error swallowed.
# Setup: workflows/setup-fantom-mcp.md.
#
#   FANTOM_URL           server base URL (default http://localhost:3848)
#   FANTOM_REPORT_TOKEN  report token; else ~/.fantom-mcp/report-token

FANTOM_URL="${FANTOM_URL:-http://localhost:3848}"
TOKEN="${FANTOM_REPORT_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -r "$HOME/.fantom-mcp/report-token" ]; then
  TOKEN="$(cat "$HOME/.fantom-mcp/report-token")"
fi
[ -z "$TOKEN" ] && exit 0
command -v node >/dev/null 2>&1 || exit 0
command -v curl >/dev/null 2>&1 || exit 0

BODY="$(node -e '
let s = "";
process.stdin.on("data", d => (s += d)).on("end", () => {
  try {
    const j = JSON.parse(s);
    const ti = j.tool_input || {};
    const f = ti.file_path || ti.notebook_path;
    if (!f) return;
    process.stdout.write(JSON.stringify({ files: [f], cwd: j.cwd, sessionId: j.session_id, client: "claude-code" }));
  } catch { /* not hook JSON: report nothing */ }
});' 2>/dev/null)"
[ -z "$BODY" ] && exit 0

curl -s -m 2 -o /dev/null -X POST "$FANTOM_URL/admin/indexing/report" \
  -H "Content-Type: application/json" \
  -H "X-Fantom-Hook-Token: $TOKEN" \
  --data "$BODY" || true
exit 0
