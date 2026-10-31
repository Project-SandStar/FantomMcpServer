# Fantom MCP server (HTTP transport). fileSystemSideCar Task 8.3.
# Volumes: /app/.cache (SQLite, LanceDB, LadybugDB), /app/.cache/models
# (embedding models), /mirror (sidecar-receiver output, read-only).
# TLS: terminate in a reverse proxy (deploy/Caddyfile).
# /dashboard: admin pages, built from dashboard/ (static export to dashboard/out).

FROM node:22-bookworm-slim AS dashboard
WORKDIR /dashboard
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci
# next-env.d.ts is not in git; `next build` makes it.
COPY dashboard/next.config.ts dashboard/tsconfig.json dashboard/postcss.config.mjs ./
COPY dashboard/public ./public
COPY dashboard/src ./src
RUN npm run build

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
# `npm ci` runs the `prepare` script (npm run build), so the sources must be here first.
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY workflows ./workflows
RUN npm ci && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    MCP_PORT=3848 \
    DATABASE_URL=file:../.cache/fantom.db \
    FANTOM_MIRROR_ROOT=/mirror \
    FANTOM_WORKFLOWS_DIR=/app/.cache/workflows
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/build ./build
COPY --from=dashboard /dashboard/out ./dashboard/out
# Built-in workflows: copied into FANTOM_WORKFLOWS_DIR (on the cache volume) when missing.
COPY --from=build /app/workflows ./workflows-builtin
# tree-sitter grammars are loaded from src/parser/treeSitter/grammars when not next to build/
COPY --from=build /app/src/parser/treeSitter/grammars ./src/parser/treeSitter/grammars
COPY config/*.example.json ./config/
RUN mkdir -p /app/.cache/models /mirror
VOLUME ["/app/.cache", "/app/.cache/models"]
EXPOSE 3848
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_PORT||3848)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "npx prisma migrate deploy && exec node --expose-gc --max-old-space-size=4096 build/index.js"]
