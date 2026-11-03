# shellcheck shell=bash disable=SC2034
# config.sh - Fantom stack on basws42. Read by lib.sh. Local only (not in git).
NAME=fantom
SSH_HOST=basws42
STACK_DIR='C:\sidecar-deploy\fantom'
COMPOSE_PROJECT=fantom
COMPOSE_FILE=docker-compose.yml
NET_CT=fantom-net   # network owner (<stack>-net): app, netbird and caddy use network_mode container:fantom-net
APP_CT=fantom-mcp
NETBIRD_CT=fantom-netbird
CADDY_CT=fantom-caddy
EXTRA_CTS="fantom-receiver"
IMAGE=fantom-mcp
DOCKERFILE=Dockerfile
BUILD_CONTEXT=.
HEALTH_PORT=3848
HEALTH_PATH=/health
HEALTH_TIMEOUT=420
ENV_FILE=fantom.env
# Must stay: without an OpenRouter key, auto-embed hangs the server.
REQUIRED_ENV="FANTOM_AUTO_EMBED_DISABLED=1 FANTOM_API_TOKEN"
ENTRYPOINT_FILES="docker/netbird-entrypoint.sh docker/caddy-entrypoint.sh"
STATUS_IMAGES="sidecar-receiver sidecar-caddy netbirdio/netbird"
SETTINGS_URL="http://basws42:3848/dashboard/config/#netbird"
