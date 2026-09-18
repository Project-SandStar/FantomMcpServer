#!/bin/bash
# Start the Fantom MCP Server in DEV mode (tsx --watch, no build step).
# Source-file changes auto-restart the server. Pair with:
#   cd dashboard && npm run dev   (for Next.js HMR on the UI side)

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="/tmp/fantom-mcp-dev.log"
PID_FILE="/tmp/fantom-mcp-dev.pid"
CONFIG_FILE="$SERVER_DIR/config/fantomMcpServer-config.json"
DASHBOARD_DIR="$SERVER_DIR/dashboard/out"

# Read port from config file, fall back to env var, then default
if [ -f "$CONFIG_FILE" ]; then
    CONFIG_PORT=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('port', ''))" 2>/dev/null)
fi
MCP_PORT=${MCP_PORT:-${CONFIG_PORT:-3847}}

cd "$SERVER_DIR" || exit 1

# Refuse if anything is already LISTENING on the port — production daemon,
# prior dev instance, or a stray tsx watcher. -sTCP:LISTEN excludes outbound
# connections (e.g. mcp-proxy's SSE stream) that share the port number.
if lsof -i :$MCP_PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "Port $MCP_PORT is already in use. Stop the running server first:"
    echo "  bash scripts/stop-server.sh   # if production daemon"
    echo "  bash scripts/stop-dev.sh      # if a previous dev instance"
    exit 1
fi

# Refuse if a previous dev instance left a pidfile claiming a live process.
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE" 2>/dev/null)
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        echo "Dev server already running (PID: $OLD_PID)"
        echo "  bash scripts/stop-dev.sh"
        exit 1
    fi
    # Stale pidfile — clean up and proceed.
    rm -f "$PID_FILE"
fi

# Make sure tsx is available
if ! [ -x "$SERVER_DIR/node_modules/.bin/tsx" ]; then
    echo "tsx not found in node_modules. Run 'npm install' first."
    exit 1
fi

# Tree-sitter grammars warning (same as production script)
GRAMMARS_DIR="$SERVER_DIR/src/parser/treeSitter/grammars"
if [ ! -d "$GRAMMARS_DIR" ] || [ -z "$(ls -A "$GRAMMARS_DIR" 2>/dev/null)" ]; then
    echo ""
    echo "⚠️  WARNING: Tree-sitter grammars not found!"
    echo "   Code parsing features will be limited."
    echo "   Run 'npm run grammars:download' to download grammars."
    echo ""
fi

# Clear log
> "$LOG_FILE"

export MCP_TRANSPORT=http
export MCP_PORT
# Parity with the production script, which this drifted from twice.
#
# --expose-gc: the boot indexer forces a GC right before each native Kuzu call
# so the FFI allocation has maximum headroom. Without the flag `globalThis.gc`
# is undefined, the call is skipped silently, and dev hits the memory cliff
# that production does not.
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=4096 --expose-gc"

# Cap the LadybugDB/Kuzu pool. The default of 16 connections x ~64 MiB of
# buffer pool is ~1 GB, and the boot graph sync keeps the pool pinned at its
# cap while it walks every project — RSS was seen climbing to 4,091 MB and
# tripping the guard. 8 halves that and stays above the ~8-hot-project count
# where the pool's own notes record thrashing.
export FANTOM_GRAPH_MAX_OPEN=${FANTOM_GRAPH_MAX_OPEN:-8}

# Start tsx --watch in the background. tsx wraps node; we record its PID.
# Watch is restricted to src/** by default (tsx's behavior); .cache, build/,
# dashboard/ etc. won't trigger restarts.
nohup "$SERVER_DIR/node_modules/.bin/tsx" --watch "$SERVER_DIR/src/index.ts" \
    >> "$LOG_FILE" 2>&1 &
DEV_PID=$!
echo "$DEV_PID" > "$PID_FILE"

# Wait for health (boot is slow because of full project indexing)
echo "Starting Fantom MCP Server in DEV mode (PID: $DEV_PID)..."
HEALTH_OK=0
for i in $(seq 1 60); do
    sleep 1
    if curl -s "http://localhost:$MCP_PORT/health" >/dev/null 2>&1; then
        HEALTH_OK=1
        break
    fi
    if ! kill -0 "$DEV_PID" 2>/dev/null; then
        echo ""
        echo "Dev server exited prematurely. Tail of log:"
        tail -30 "$LOG_FILE"
        rm -f "$PID_FILE"
        exit 1
    fi
    echo -n "."
done
echo ""

if [ $HEALTH_OK -eq 1 ]; then
    echo "Dev server started! (changes to src/** will auto-restart)"
    echo ""
    echo "  MCP Endpoint:  http://localhost:$MCP_PORT/mcp"
    echo "  Health Check:  http://localhost:$MCP_PORT/health"
    echo "  Admin API:     http://localhost:$MCP_PORT/admin"
    if [ -d "$DASHBOARD_DIR" ]; then
        echo "  Dashboard:     http://localhost:$MCP_PORT/dashboard"
    fi
    echo ""
    echo "  PID:  $DEV_PID    (saved to $PID_FILE)"
    echo "  Logs: $LOG_FILE"
    echo ""
    echo "Stop:    bash scripts/stop-dev.sh"
    echo "Restart: bash scripts/restart-dev.sh"
else
    echo "Dev server didn't pass health check in 60s. Tail of log:"
    tail -30 "$LOG_FILE"
    echo ""
    echo "(Boot can take longer when indexing many projects — give it a"
    echo " bit more time, then 'curl http://localhost:$MCP_PORT/health'.)"
fi
