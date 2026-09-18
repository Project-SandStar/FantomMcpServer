#!/bin/bash
# Restart the Fantom MCP Server

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "Restarting Fantom MCP Server..."
echo ""

# Stop the server
"$SCRIPT_DIR/stop-server.sh"

# Rebuild server (TypeScript -> build/) unless SKIP_BUILD=1
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "Building server..."
  (cd "$ROOT_DIR" && npm run build) || { echo "Server build failed"; exit 1; }

  echo "Building dashboard..."
  (cd "$ROOT_DIR/dashboard" && npm run build) || { echo "Dashboard build failed"; exit 1; }
fi

# Small delay to ensure port is released
sleep 1

# Start the server
"$SCRIPT_DIR/start-server.sh"
