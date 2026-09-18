#!/bin/bash
# Restart the Fantom MCP dev server (clean stop + fresh start). Useful when
# tsx's file-watcher misses a change (e.g. you renamed a file or edited
# something outside src/) and you want a deterministic full reload.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bash "$SCRIPT_DIR/stop-dev.sh" || true
# stop-dev waits for clean shutdown; sleep is just paranoia in case the
# pidfile reports gone but the LadybugDB lock hasn't released yet.
sleep 1
bash "$SCRIPT_DIR/start-dev.sh"
