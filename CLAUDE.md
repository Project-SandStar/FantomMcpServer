# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP Fantom is a Model Context Protocol (MCP) server that provides AI assistants with access to Fantom language documentation, Haxall/SkySpark documentation, code generation tools, and SkySpark 3.x to 4.0 migration capabilities.

## Build and Development Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript to build/ (also copies workflows)
npm run dev          # Run with tsx (development mode) - stdio transport
npm start            # Run compiled version (stdio transport)
npm run start:http   # Run with HTTP transport on port 3847
npm test             # Run Jest test suite
npm run clean        # Remove build/ and .cache/ directories
```

### HTTP Server Management
```bash
npm run start:http   # Start HTTP server directly
./scripts/start-server.sh  # Start as background process with logging
./scripts/stop-server.sh   # Stop background server
./scripts/status-server.sh # Check server status
npm run daemon:start # Start with PM2 process manager
npm run daemon:stop  # Stop PM2 daemon
npm run daemon:logs  # View PM2 logs
```

### Dashboard Commands
```bash
npm run dashboard:install  # Install dashboard dependencies
npm run dashboard:build    # Build dashboard (creates dashboard/out/)
npm run dashboard:dev      # Run dashboard in dev mode
```

### Test Scripts
```bash
npm run test:search  # Test documentation search functionality
npm run test:cache   # Test cache loading
npm run test:parse   # Test documentation parser (crawls fantom.org - takes minutes)
```

## Architecture

### Entry Point and MCP Server
`src/index.ts` - Main MCP server using `@modelcontextprotocol/sdk`. Supports dual transport:
- **Stdio transport** (default): Single client mode for Claude Desktop/CLI
- **HTTP transport**: Multi-client mode with session management, admin API, and dashboard

### Transport Selection
Set via `MCP_TRANSPORT` environment variable:
- `stdio` (default): Standard input/output transport
- `http`: StreamableHTTP transport on port 3847 (configurable via `MCP_PORT`)

### HTTP Server Endpoints (when MCP_TRANSPORT=http)
- `GET /health` - Server health and status
- `POST /mcp` - MCP protocol messages (with session management)
- `GET /mcp` - SSE stream for server notifications
- `DELETE /mcp` - Terminate session
- `/admin/*` - Admin REST API (Basic Auth required)
- `/dashboard/*` - Web dashboard UI

### Core Modules

**Documentation Parsing** (`src/parser/`)
- `FantomDocsParser` - Crawls and parses fantom.org HTML documentation
- `SmartDocsParser` - On-demand parser for haxall.io with lazy loading per pod

**Search** (`src/search/index.ts`)
- `SearchIndex` - FlexSearch-based document search with relevance scoring
- Indexes: name, qualifiedName, description, signature, keywords

**Cache** (`src/cache/index.ts`)
- `CacheManager` - Persists parsed documentation to `.cache/flexsearch-fantom.json`

**Migration** (`src/migration/index.ts`)
- `SkySpark4xMigrator` - Automates SkySpark 3.x → 4.0 migration

**Code Generation** (`src/tools/generateFantom.ts`)
- Functions to generate Fantom classes, methods, pods, enums, mixins

**Admin API** (`src/admin/`)
- `routes.ts` - Express router with Basic Auth middleware
- `types.ts` - TypeScript interfaces for admin endpoints

**Usage Tracking** (`src/usage/`)
- `usageTracker.ts` - SQLite-backed analytics (tool calls, searches)
- Database at `.cache/usage.db`

**Workflow Manager** (`src/workflows/`)
- `workflowManager.ts` - Dynamic loading of markdown workflow resources

### Types
`src/types/index.ts` - Core interfaces: `FantomDocItem`, `SearchResult`, `FantomConfig`

### MCP Tools Exposed
- `searchFantomDocs` - Search fantom.org documentation
- `searchHaxallDocs` - Search haxall.io documentation (lazy-loaded per pod)
- `getFantomType` - Get detailed type info with related slots
- `listFantomPods` - List indexed pods
- `refreshIndex` - Re-crawl and rebuild index
- `migrateSkySpark4x` - Full migration workflow
- `commitMigration` / `rollbackMigration` - Git operations for migration
- `generateFantomCode` - Generate Fantom code constructs

### MCP Resources
Workflow guides in `workflows/*.md` served as MCP resources with URIs like `workflow://create-pod`.

## Configuration

- `fantom-config.json` - Default settings (docsPath, crawlSettings, searchSettings)
- `config/admin.json` - Admin API credentials (default: admin/admin)
- `config/fantomMcpServer-config.json` - Runtime config (primary project, etc.)
- `.env` - Environment overrides

### Environment Variables
| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_TRANSPORT` | `stdio` | Transport mode: `stdio` or `http` |
| `MCP_PORT` | `3847` | HTTP server port |
| `ADMIN_USER` | `admin` | Admin API username |
| `ADMIN_PASS` | `admin` | Admin API password |
| `CACHE_ENABLED` | `true` | Enable/disable caching |

## Admin API Endpoints

All endpoints require Basic Auth (credentials from config/admin.json or env vars).

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /admin | API index |
| GET | /admin/status | Server status and memory |
| GET | /admin/cache | List cache files |
| POST | /admin/cache/clear | Clear cache |
| GET | /admin/logs | SSE log stream |
| GET | /admin/usage | Usage statistics |
| GET | /admin/primary-project | Get active project |
| POST | /admin/primary-project | Set active project |

## Key Patterns

- Server initializes lazily in background; tools wait for initialization
- HTTP mode creates isolated Server instance per session
- Session ID transmitted via `mcp-session-id` header
- Haxall docs use SmartDocsParser for on-demand pod fetching
- Migration tool creates backup tags before transforming
- FlexSearch Document index with forward tokenization

## Project Structure

```
mcpfantom/
├── src/
│   ├── index.ts          # Main server (dual transport)
│   ├── admin/            # Admin API routes and types
│   ├── cache/            # Cache management
│   ├── config/           # Configuration loading
│   ├── migration/        # SkySpark migration tool
│   ├── parser/           # Documentation parsers
│   ├── search/           # FlexSearch index
│   ├── tools/            # Code generation
│   ├── types/            # TypeScript interfaces
│   ├── usage/            # Usage tracking (SQLite)
│   └── workflows/        # Workflow manager
├── dashboard/            # Next.js admin dashboard
│   └── out/              # Static export (after build)
├── scripts/              # Server management scripts
├── config/               # Runtime configuration
├── workflows/            # Markdown workflow guides
├── specs/                # Architecture documentation
└── .cache/               # Cached data and SQLite DB
```

## How to implement the code.

Single file should not exceed the maximum allowed tokens (25000) that way, we don't have to utilize GrepTool. 