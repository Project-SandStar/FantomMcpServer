#!/bin/bash
# Start the Fantom MCP Server with HTTP transport

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS_DIR="$SERVER_DIR/logs"
LOG_FILE="$LOGS_DIR/server.log"
mkdir -p "$LOGS_DIR"
CONFIG_FILE="$SERVER_DIR/config/fantomMcpServer-config.json"
DASHBOARD_DIR="$SERVER_DIR/dashboard/out"

# Read port from config file, fall back to env var, then default
if [ -f "$CONFIG_FILE" ]; then
    CONFIG_PORT=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('port', ''))" 2>/dev/null)
fi
MCP_PORT=${MCP_PORT:-${CONFIG_PORT:-3847}}

cd "$SERVER_DIR" || exit 1

# Check if already running. Filter to LISTEN sockets — without -sTCP:LISTEN,
# an mcp-proxy holding an outbound connection to this port would falsely
# trigger "already running" and block startup.
if lsof -i :$MCP_PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "Server already running on port $MCP_PORT"
    exit 1
fi

# Build if needed
if [ ! -f "$SERVER_DIR/build/index.js" ]; then
    echo "Building server..."
    npm run build || exit 1
fi

# Check for tree-sitter grammars
GRAMMARS_DIR="$SERVER_DIR/src/parser/treeSitter/grammars"
if [ ! -d "$GRAMMARS_DIR" ] || [ -z "$(ls -A "$GRAMMARS_DIR" 2>/dev/null)" ]; then
    echo ""
    echo "⚠️  WARNING: Tree-sitter grammars not found!"
    echo "   Code parsing features will be limited."
    echo "   Run 'npm run grammars:download' to download grammars."
    echo ""
fi

# Rotate the previous log instead of wiping it, so the reason the last
# process exited is still readable after a restart (keep 3 generations).
if [ -s "$LOG_FILE" ]; then
    [ -f "$LOG_FILE.2" ] && mv -f "$LOG_FILE.2" "$LOG_FILE.3"
    [ -f "$LOG_FILE.1" ] && mv -f "$LOG_FILE.1" "$LOG_FILE.2"
    mv -f "$LOG_FILE" "$LOG_FILE.1"
fi
> "$LOG_FILE"

# Export environment
export MCP_TRANSPORT=http
export MCP_PORT

# Cap the LadybugDB/Kuzu connection pool.
#
# The default is 16 and each connection holds a ~64 MiB buffer pool, so the
# pool alone can sit near 1 GB. The boot-time graph sync walks every project
# in turn, which keeps the pool permanently at its cap: RSS was observed
# climbing ~5 MB per project to 4,091 MB, tripping the 4,002 MB guard and
# killing the process mid-rebuild — twice today.
#
# 8, not lower: the pool's own notes record that cap=2 thrashed
# (open/evict/reopen) against ~8 concurrently hot projects. This halves the
# buffer-pool footprint while staying above that threshold.
export FANTOM_GRAPH_MAX_OPEN=${FANTOM_GRAPH_MAX_OPEN:-8}

# Start server
nohup node --expose-gc --max-old-space-size=4096 "$SERVER_DIR/build/index.js" >> "$LOG_FILE" 2>&1 &
SERVER_PID=$!

# Wait for health check
echo "Starting Fantom MCP Server..."
for i in {1..10}; do
    sleep 1
    if curl -s "http://localhost:$MCP_PORT/health" >/dev/null 2>&1; then
        break
    fi
    echo -n "."
done
echo ""

# Verify
if curl -s "http://localhost:$MCP_PORT/health" >/dev/null 2>&1; then
    echo "Server started!"
    echo ""
    echo "  MCP Endpoint:  http://localhost:$MCP_PORT/mcp"
    echo "  Health Check:  http://localhost:$MCP_PORT/health"
    echo "  Admin API:     http://localhost:$MCP_PORT/admin"
    if [ -d "$DASHBOARD_DIR" ]; then
        echo "  Dashboard:     http://localhost:$MCP_PORT/dashboard"
    fi
    echo ""
    echo "  PID: $SERVER_PID"
    echo "  Logs: $LOG_FILE"
else
    echo "Failed to start. Check logs: $LOG_FILE"
    tail -20 "$LOG_FILE"
    exit 1
fi
