#!/bin/bash
# Stop the Fantom MCP dev server. Mirrors stop-server.sh's clean-shutdown
# guarantees: SIGTERM, wait up to 30s for LadybugDB CHECKPOINT, only then
# SIGKILL — a mid-WAL kill -9 corrupts fantom-graph.db.wal.

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="/tmp/fantom-mcp-dev.pid"
CONFIG_FILE="$SERVER_DIR/config/fantomMcpServer-config.json"

if [ -f "$CONFIG_FILE" ]; then
    CONFIG_PORT=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('port', ''))" 2>/dev/null)
fi
MCP_PORT=${MCP_PORT:-${CONFIG_PORT:-3847}}

# Identify the dev server PID via the pidfile ONLY. We deliberately do NOT
# fall back to "whatever is bound to the port" — that could match a
# production daemon (start-server.sh / pm2) and kill it by accident. If the
# pidfile is missing/stale, we treat that as "no dev server running".
DEV_PID=""
if [ -f "$PID_FILE" ]; then
    CANDIDATE=$(cat "$PID_FILE" 2>/dev/null)
    if [ -n "$CANDIDATE" ] && kill -0 "$CANDIDATE" 2>/dev/null; then
        # Sanity: confirm it's actually a tsx watcher, not some random PID
        # that recycled into another process.
        if ps -o command= -p "$CANDIDATE" 2>/dev/null | grep -q "tsx"; then
            DEV_PID="$CANDIDATE"
        fi
    fi
    if [ -z "$DEV_PID" ]; then
        rm -f "$PID_FILE"
    fi
fi

if [ -z "$DEV_PID" ]; then
    echo "No dev server tracked (pidfile missing or stale). Nothing to stop."
    echo "(If you have a production daemon on port $MCP_PORT, use 'bash scripts/stop-server.sh'.)"
    exit 0
fi

echo "Stopping dev server (PID: $DEV_PID)..."
# Kill the whole process group so tsx's child node also exits.
# Negative PID to kill = signal the process group.
PGID=$(ps -o pgid= -p "$DEV_PID" 2>/dev/null | tr -d ' ')
if [ -n "$PGID" ]; then
    kill -TERM -"$PGID" 2>/dev/null
else
    kill -TERM "$DEV_PID" 2>/dev/null
fi

# Wait up to 30s for LadybugDB CHECKPOINT + clean shutdown.
for i in $(seq 1 30); do
    # -sTCP:LISTEN excludes outbound connections (e.g. mcp-proxy → us)
    # that share this port number.
    if ! kill -0 "$DEV_PID" 2>/dev/null && ! lsof -i :$MCP_PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
        echo "Dev server stopped cleanly after ${i}s"
        rm -f "$PID_FILE"
        exit 0
    fi
    sleep 1
done

echo "WARNING: dev server did not exit in 30s; sending SIGKILL (WAL may corrupt)"
if [ -n "$PGID" ]; then
    kill -9 -"$PGID" 2>/dev/null
fi
kill -9 "$DEV_PID" 2>/dev/null
# Belt and suspenders — tsx forks a child node with --watch wiring; reap it.
pkill -9 -f "tsx.*--watch.*src/index" 2>/dev/null
rm -f "$PID_FILE"
echo "Dev server stopped (forced)"
