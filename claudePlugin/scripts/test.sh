#!/usr/bin/env bash
# Full plugin test: build + validate, unit tests against a fake server, then
# live checks against the real server when it is up.
#
#   claudePlugin/scripts/test.sh            everything
#   claudePlugin/scripts/test.sh --unit     no live part
#
#   FANTOM_URL  real server (default http://localhost:3848)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$HERE/.." && pwd)"
FANTOM_URL="${FANTOM_URL:-http://localhost:3848}"
UNIT_ONLY=0; [ "${1:-}" = "--unit" ] && UNIT_ONLY=1

printf '== build + validate\n'
node "$HERE/build.mjs" --check

printf '\n== unit tests (fake server)\n'
node --test "$PLUGIN_DIR"/test/*.test.mjs

[ "$UNIT_ONLY" = 1 ] && exit 0

printf '\n== live checks against %s\n' "$FANTOM_URL"
if ! curl -s -m 3 "$FANTOM_URL/health" >/dev/null; then
  printf '   server not reachable, live part skipped\n'
  exit 0
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export CLAUDE_PLUGIN_ROOT="$PLUGIN_DIR/dist" CLAUDE_PLUGIN_DATA="$TMP" CLAUDE_PLUGIN_OPTION_SERVER_URL="$FANTOM_URL"
CWD="$(cd "$PLUGIN_DIR/.." && pwd)"

printf -- '-- SessionStart for %s\n' "$CWD"
printf '{"session_id":"plugin-test","cwd":"%s","hook_event_name":"SessionStart","source":"startup"}' "$CWD" \
  | node "$PLUGIN_DIR/dist/hooks/session-start.mjs" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{ if(!s.trim()){console.log("   (no output: directory not registered or no token)");return;} const j=JSON.parse(s); console.log("   "+j.hookSpecificOutput.additionalContext.split("\n").join("\n   ")) })'

printf -- '-- PostToolUse report for a file in that directory\n'
printf '{"session_id":"plugin-test","cwd":"%s","tool_name":"Edit","tool_input":{"file_path":"%s/README.md"}}' "$CWD" "$CWD" \
  | node "$PLUGIN_DIR/dist/hooks/report-change.mjs" && printf '   sent (exit 0)\n'

printf -- '-- UserPromptSubmit hint\n'
printf '{"session_id":"plugin-test","prompt":"who calls reportChanges and what breaks if I change it?"}' \
  | node "$PLUGIN_DIR/dist/hooks/prompt-hint.mjs" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{ console.log(s.trim()?"   "+JSON.parse(s).hookSpecificOutput.additionalContext:"   (no hint)") })'

printf -- '-- doctor\n'
node "$PLUGIN_DIR/dist/bin/doctor.mjs" --cwd "$CWD" | sed 's/^/   /' || true
printf '\nlive checks done\n'
