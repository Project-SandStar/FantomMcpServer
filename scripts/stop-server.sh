#!/bin/bash
SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="$SERVER_DIR/config/fantomMcpServer-config.json"

# Read port from config file, fall back to env var, then default
if [ -f "$CONFIG_FILE" ]; then
    CONFIG_PORT=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('port', ''))" 2>/dev/null)
fi
MCP_PORT=${MCP_PORT:-${CONFIG_PORT:-3847}}

# Filter to LISTEN sockets only. Without -sTCP:LISTEN, lsof also matches
# *outbound* connections to this port (e.g. mcp-proxy's SSE stream to us),
# so a naive `lsof -ti :3848` would return PID(s) we must not kill.
PID=$(lsof -i :$MCP_PORT -sTCP:LISTEN -t)
if [ -z "$PID" ]; then
    echo "No server running on port $MCP_PORT"
    exit 0
fi

echo "Stopping server (PID: $PID)..."
kill $PID

# Wait up to 30s for LadybugDB CHECKPOINT + clean shutdown.
# Mid-WAL kill -9 corrupts fantom-graph.db.wal — do not shorten this.
for i in $(seq 1 30); do
    if ! lsof -i :$MCP_PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
        echo "Server stopped cleanly after ${i}s"
        exit 0
    fi
    sleep 1
done

echo "WARNING: server did not exit in 30s; sending SIGKILL (WAL may corrupt)"
kill -9 $PID
echo "Server stopped (forced)"
