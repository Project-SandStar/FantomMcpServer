#!/usr/bin/env bash
# Remove the Fantom MCP plugin and its local marketplace.
#   claudePlugin/scripts/uninstall-local.sh [--purge-token]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$HERE/.." && pwd)"
[ -f "$PLUGIN_DIR/dist/bin/fantom-mcp.mjs" ] || node "$HERE/build.mjs"
exec node "$PLUGIN_DIR/dist/bin/fantom-mcp.mjs" disconnect "$@"
