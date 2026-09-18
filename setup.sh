#!/usr/bin/env bash
# One-shot setup for a fresh checkout of the Fantom MCP Server.
#
#   ./setup.sh            # install, create .env + database, build server + dashboard
#   ./setup.sh --no-dashboard
#
# Everything it creates (.env, .cache/, config/*.json) is git-ignored.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

WITH_DASHBOARD=1
for a in "$@"; do [ "$a" = "--no-dashboard" ] && WITH_DASHBOARD=0; done

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

step "Node version"
node -v
case "$(node -v)" in v1[0-7].*) echo "Node >= 18 required"; exit 1;; esac

step "Install dependencies (runs prisma generate via postinstall)"
npm install

step "Environment file"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "created .env from .env.example (edit DATABASE_URL / API keys as needed)"
else
  echo ".env already exists — left untouched"
fi

step "Database (SQLite via Prisma)"
mkdir -p .cache
# Use the URL from .env if present, else the default location.
DB_URL="$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"' || true)"
export DATABASE_URL="${DB_URL:-file:.cache/fantom.db}"
npx prisma migrate deploy

step "Tree-sitter grammars"
if [ -z "$(ls -A src/parser/treeSitter/grammars 2>/dev/null)" ]; then
  npx tsx scripts/download-grammars.ts || echo "grammar download failed — code parsing will be limited (rerun: npm run grammars:download)"
else
  echo "grammars present"
fi

step "Build server"
npm run build

if [ "$WITH_DASHBOARD" = "1" ]; then
  step "Build dashboard"
  (cd dashboard && npm install && npm run build)
fi

cat <<'EOF'

Done.

  Start (HTTP + dashboard):   npm run start:http
  Dashboard:                  http://localhost:3848/dashboard/  (admin / admin — change it)
  Start (stdio, for MCP):     npm start

Nothing under config/, .cache/ or logs/ is tracked by git.
EOF
