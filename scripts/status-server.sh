#!/bin/bash
SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="$SERVER_DIR/config/fantomMcpServer-config.json"

# Read port from config file, fall back to env var, then default
if [ -f "$CONFIG_FILE" ]; then
    CONFIG_PORT=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('port', ''))" 2>/dev/null)
fi
MCP_PORT=${MCP_PORT:-${CONFIG_PORT:-3847}}

# Filter to LISTEN sockets only — outbound connections from mcp-proxy share
# the same port and would otherwise produce a false "running" verdict.
if ! lsof -i :$MCP_PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "Server is NOT running"
    exit 1
fi

echo "Server is running"
curl -s "http://localhost:$MCP_PORT/health" | python3 -m json.tool 2>/dev/null || curl -s "http://localhost:$MCP_PORT/health"
