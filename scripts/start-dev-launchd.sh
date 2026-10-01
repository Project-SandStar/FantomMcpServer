#!/bin/bash
# Start the dev server as a launchd user-domain job instead of a child of the
# calling app. On macOS 15 the Local Network permission is decided by the
# *responsible app* of the process; a server started from IntelliJ's terminal
# (or any unsigned launcher) inherits that app's denial and every fetch to the
# LAN (192.168.88.x — the Mac sidecars) fails with EHOSTUNREACH, while
# NetBird (100.x) and the 10.10.20.x subnet route keep working. A launchd job has no
# app ancestor, and measured 2026-09-29 it reaches the LAN.
#
#   bash scripts/start-dev-launchd.sh        # start (idempotent); FANTOM_GRAPH_MAX_OPEN defaults to 16 here
#   (8 in start-dev.sh): 5 re-embed workers + a search fan-out exceeded 8 and
#   the LRU evictor closed connections under live queries (SIGSEGV, 2026-09-29).
#   launchctl bootout gui/$(id -u)/com.fantom.mcp.dev   # detach the job (server keeps running; use stop-dev.sh to stop it)
set -e
LABEL=com.fantom.mcp.dev
PLIST=/tmp/$LABEL.plist
SERVER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if lsof -i :3848 -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "Port 3848 is already in use — run scripts/stop-dev.sh first."; exit 1
fi
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>-lc</string>
    <string>export PATH="/opt/homebrew/bin:/usr/local/bin:\$PATH"; export FANTOM_GRAPH_MAX_OPEN="${FANTOM_GRAPH_MAX_OPEN:-16}"; cd "$SERVER_DIR" &amp;&amp; exec bash scripts/start-dev.sh</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>/tmp/fantom-launchd.out</string>
  <key>StandardErrorPath</key><string>/tmp/fantom-launchd.err</string>
</dict></plist>
PL
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Submitted $LABEL — log: /tmp/fantom-launchd.out, server log: /tmp/fantom-mcp-dev.log"
