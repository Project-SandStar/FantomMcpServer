# Product Requirements Document (PRD)
# Fantom MCP Server Modernization

**Version:** 1.0
**Date:** 2026-01-15
**Status:** Draft
**Author:** Architecture Team

---

## 1. Executive Summary

### 1.1 Project Overview

This document outlines the comprehensive refactoring and enhancement of the existing Fantom MCP Server to adopt the architectural methodologies, communication patterns, and feature set of the reference Axon MCP Server implementation.

### 1.2 Current State

The **Fantom MCP Server** (`mcp-fantom`) is a Model Context Protocol server providing:
- Fantom language documentation search (fantom.org crawling)
- Haxall documentation search (haxall.io on-demand)
- SkySpark 3.x → 4.0 migration tools
- Fantom code generation utilities
- Workflow resources (markdown guides)

**Current Limitations:**
- **Transport:** Stdio-only (single client per process)
- **No Admin API:** No REST endpoints for management
- **No Dashboard:** No web UI for monitoring
- **No Session Management:** Cannot handle multiple concurrent clients
- **No Usage Tracking:** No analytics on tool usage
- **Limited Configuration:** File-based only, no runtime updates

### 1.3 Target State

The modernized **Fantom MCP Server** will mirror the Axon MCP Server architecture:
- **Dual Transport:** Stdio + HTTP (StreamableHTTP) with session management
- **Admin REST API:** Full management endpoints with Basic Auth
- **Web Dashboard:** Next.js admin UI for monitoring and control
- **Multi-Client Support:** Concurrent sessions via HTTP transport
- **Usage Analytics:** SQLite-backed tool usage tracking
- **Runtime Configuration:** Live config updates, primary project context

### 1.4 Critical Constraint

The Axon MCP Server relies on **HTTP streaming** (StreamableHTTPServerTransport) for communication. This streaming mechanism must be fully understood and replicated in the Fantom server architecture.

---

## 2. Stakeholders

| Role | Description | Interest |
|------|-------------|----------|
| AI Assistants | Claude, Copilot, other MCP clients | Primary consumers of tools |
| Developers | Fantom/SkySpark developers | Use for docs, migration, code gen |
| Operators | System administrators | Monitor and manage server |
| Dashboard Users | Technical staff | Visual monitoring and control |

---

## 3. Requirements

### 3.1 Functional Requirements

#### FR-1: Dual Transport Support

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-1.1 | Support stdio transport for single-client mode (Claude Desktop, CLI) | P0 |
| FR-1.2 | Support HTTP/StreamableHTTP transport for multi-client mode | P0 |
| FR-1.3 | Transport mode selectable via `MCP_TRANSPORT` environment variable | P0 |
| FR-1.4 | HTTP server on configurable port (default: 3847) via `MCP_PORT` | P0 |
| FR-1.5 | Health check endpoint at `/health` returning server status | P0 |
| FR-1.6 | MCP endpoint at `/mcp` supporting POST (requests), GET (SSE), DELETE (terminate) | P0 |

#### FR-2: Session Management (HTTP Mode)

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-2.1 | Generate unique session ID (UUID) for each new client connection | P0 |
| FR-2.2 | Create isolated Server instance per session | P0 |
| FR-2.3 | Track active sessions in Map with session ID keys | P0 |
| FR-2.4 | Clean up sessions on disconnect (transport.onclose) | P0 |
| FR-2.5 | Session ID transmitted via `mcp-session-id` header | P0 |
| FR-2.6 | Reject requests without valid session ID (except initialize) | P0 |

#### FR-3: Admin REST API

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-3.1 | Base path `/admin` with Basic Auth middleware | P0 |
| FR-3.2 | `GET /admin/status` - Server status (uptime, memory, initialization state) | P0 |
| FR-3.3 | `GET /admin/cache` - List cache files with size and age | P0 |
| FR-3.4 | `POST /admin/cache/clear` - Clear specific or all caches | P0 |
| FR-3.5 | `GET /admin/logs` - SSE stream of server logs | P1 |
| FR-3.6 | `GET /admin/usage` - Tool usage statistics | P1 |
| FR-3.7 | `GET /admin/config` - List configuration files | P1 |
| FR-3.8 | `PUT /admin/config/:name` - Update configuration | P2 |
| FR-3.9 | `GET /admin/primary-project` - Get active project context | P1 |
| FR-3.10 | `POST /admin/primary-project` - Set active project context | P1 |

#### FR-4: Web Dashboard

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-4.1 | Next.js dashboard served at `/dashboard` | P1 |
| FR-4.2 | Home page: Server status, uptime, memory, indexed counts | P1 |
| FR-4.3 | Cache page: View and clear cache files | P1 |
| FR-4.4 | Logs page: Real-time log streaming | P2 |
| FR-4.5 | Usage page: Tool call analytics and charts | P2 |
| FR-4.6 | Config page: View/edit server configuration | P2 |
| FR-4.7 | Sessions page: Active session monitoring | P2 |
| FR-4.8 | Authentication via localStorage credentials | P1 |

#### FR-5: Usage Tracking

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-5.1 | Track every tool call (tool name, timestamp, duration, success) | P1 |
| FR-5.2 | Track search queries (query text, result count, source) | P1 |
| FR-5.3 | Persist to SQLite database (`.cache/usage.db`) | P1 |
| FR-5.4 | Aggregate daily statistics | P2 |
| FR-5.5 | Export usage data as JSON | P2 |
| FR-5.6 | Clear/reset usage data endpoints | P2 |

#### FR-6: Enhanced MCP Tools

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-6.1 | All existing tools preserved (searchFantomDocs, searchHaxallDocs, etc.) | P0 |
| FR-6.2 | Add `setPrimaryProject` tool for context switching | P1 |
| FR-6.3 | Add `getPrimaryProject` tool for context query | P1 |
| FR-6.4 | Tools wait for initialization if called before ready | P0 |
| FR-6.5 | Tool calls tracked in usage database | P1 |

#### FR-7: Configuration Management

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-7.1 | Load config from `fantom-config.json` or environment | P0 |
| FR-7.2 | Persist primary project context across restarts | P1 |
| FR-7.3 | Admin credentials from `config/admin.json` or `ADMIN_USER`/`ADMIN_PASS` env | P0 |
| FR-7.4 | Runtime config reload via admin API | P2 |

#### FR-8: Operational Scripts

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-8.1 | `scripts/start-server.sh` - Start with HTTP transport, logging | P0 |
| FR-8.2 | `scripts/stop-server.sh` - Graceful shutdown | P0 |
| FR-8.3 | `scripts/status-server.sh` - Check if running | P1 |
| FR-8.4 | npm scripts: `start:http`, `daemon:start`, `daemon:stop`, etc. | P0 |
| FR-8.5 | PM2 integration for process management | P2 |

### 3.2 Non-Functional Requirements

#### NFR-1: Performance

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1.1 | Server startup to HTTP listening | < 2 seconds |
| NFR-1.2 | Full initialization (cache load) | < 30 seconds |
| NFR-1.3 | Tool response time (cached data) | < 100ms |
| NFR-1.4 | Memory usage (idle) | < 200 MB |
| NFR-1.5 | Concurrent sessions supported | 10+ |

#### NFR-2: Reliability

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-2.1 | Graceful degradation on initialization error | Continue with partial functionality |
| NFR-2.2 | Session isolation | Session errors don't affect others |
| NFR-2.3 | Cache corruption recovery | Auto-rebuild on invalid cache |

#### NFR-3: Security

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-3.1 | Admin API authentication | Basic Auth required |
| NFR-3.2 | No sensitive data in logs | Credentials redacted |
| NFR-3.3 | MCP endpoint | No auth (protocol handles trust) |

#### NFR-4: Maintainability

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-4.1 | Code structure mirrors Axon server | Same directory layout |
| NFR-4.2 | TypeScript strict mode | All files |
| NFR-4.3 | Consistent logging format | `[Module] Message` |

---

## 4. Architecture Overview

### 4.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Fantom MCP Server                            │
├─────────────────────────────────────────────────────────────────┤
│  Transport Layer                                                 │
│  ┌──────────────┐    ┌──────────────────────────────────────┐  │
│  │ Stdio        │    │ Express HTTP Server                   │  │
│  │ Transport    │    │ ├─ /mcp (StreamableHTTP)             │  │
│  │              │    │ ├─ /health                            │  │
│  │ (single      │    │ ├─ /admin/* (Basic Auth)             │  │
│  │  client)     │    │ └─ /dashboard (static)               │  │
│  └──────────────┘    └──────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│  Session Layer (HTTP mode only)                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Session Manager                                           │  │
│  │ ├─ httpTransports: Map<sessionId, Transport>             │  │
│  │ ├─ httpSessions: Map<sessionId, Server>                  │  │
│  │ └─ Session lifecycle (create, route, cleanup)            │  │
│  └──────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│  Core Layer                                                      │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐  │
│  │ MCP Server │ │ Search     │ │ Cache      │ │ Config     │  │
│  │ (handlers) │ │ Index      │ │ Manager    │ │ Manager    │  │
│  └────────────┘ └────────────┘ └────────────┘ └────────────┘  │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐  │
│  │ Fantom     │ │ Haxall     │ │ Migration  │ │ Code Gen   │  │
│  │ Parser     │ │ Parser     │ │ Tool       │ │ Tool       │  │
│  └────────────┘ └────────────┘ └────────────┘ └────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│  Supporting Layer                                                │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐  │
│  │ Usage      │ │ Workflow   │ │ Admin      │ │ Logger     │  │
│  │ Tracker    │ │ Manager    │ │ Router     │ │            │  │
│  └────────────┘ └────────────┘ └────────────┘ └────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 HTTP Streaming Protocol

The StreamableHTTP transport implements the MCP protocol over HTTP:

```
Client                                  Server (port 3847)
  │                                          │
  │ POST /mcp (initialize request, no sid)   │
  │────────────────────────────────────────>│
  │                                          │ Create session
  │                                          │ Generate UUID
  │                                          │ Create Server instance
  │<───────────── mcp-session-id header ─────│
  │                                          │
  │ POST /mcp (tool call, sid in header)     │
  │────────────────────────────────────────>│
  │                                          │ Route to session
  │<───────────── JSON-RPC response ─────────│
  │                                          │
  │ GET /mcp (sid in header)                 │
  │────────────────────────────────────────>│
  │<───────────── SSE stream (notifications) │
  │                                          │
  │ DELETE /mcp (sid in header)              │
  │────────────────────────────────────────>│
  │                                          │ Cleanup session
  │<───────────── 200 OK ────────────────────│
```

### 4.3 Directory Structure (Target)

```
mcpfantom/
├── src/
│   ├── index.ts                    # Main server entry point (refactored)
│   ├── admin/                      # NEW: Admin API
│   │   ├── routes.ts               # Express router
│   │   └── types.ts                # Admin types
│   ├── cache/                      # EXISTING: Enhanced
│   │   └── index.ts
│   ├── config/                     # EXISTING: Enhanced
│   │   └── index.ts
│   ├── parser/                     # EXISTING
│   │   ├── index.ts
│   │   ├── SmartDocsParser.ts
│   │   └── HaxallDocsParser.ts
│   ├── search/                     # EXISTING
│   │   └── index.ts
│   ├── migration/                  # EXISTING
│   │   └── index.ts
│   ├── tools/                      # EXISTING
│   │   └── generateFantom.ts
│   ├── types/                      # EXISTING: Enhanced
│   │   └── index.ts
│   ├── usage/                      # NEW: Usage tracking
│   │   ├── usageTracker.ts
│   │   ├── usageStore.ts
│   │   └── types.ts
│   ├── utils/                      # EXISTING
│   │   └── index.ts
│   └── workflows/                  # NEW: Workflow manager
│       └── workflowManager.ts
├── dashboard/                      # NEW: Next.js dashboard
│   ├── src/
│   │   ├── app/                    # Pages
│   │   ├── components/             # React components
│   │   └── lib/                    # API client
│   ├── package.json
│   └── next.config.ts
├── scripts/                        # NEW: Operational scripts
│   ├── start-server.sh
│   ├── stop-server.sh
│   ├── status-server.sh
│   └── copy-workflows.cjs         # EXISTING
├── config/                         # NEW: Runtime configs
│   ├── admin.json
│   └── fantomMcpServer-config.json
├── workflows/                      # EXISTING
├── docs/                           # EXISTING
├── specs/                          # NEW: This documentation
├── .cache/                         # EXISTING
├── build/                          # EXISTING
├── package.json                    # ENHANCED
├── tsconfig.json                   # EXISTING
└── fantom-config.json              # EXISTING
```

---

## 5. Gap Analysis

### 5.1 Components to Add

| Component | Description | Effort |
|-----------|-------------|--------|
| HTTP Transport | StreamableHTTPServerTransport integration | High |
| Session Manager | Multi-session tracking and isolation | High |
| Admin Router | Express router with Basic Auth | Medium |
| Usage Tracker | SQLite-backed analytics | Medium |
| Workflow Manager | Dynamic workflow resource loading | Low |
| Dashboard | Next.js admin UI | High |
| Operational Scripts | Shell scripts for server lifecycle | Low |

### 5.2 Components to Modify

| Component | Changes | Effort |
|-----------|---------|--------|
| `src/index.ts` | Add HTTP server, session management, dual transport | High |
| `src/config/` | Add primary project persistence, admin credentials | Medium |
| `src/cache/` | Add cache info reporting for admin API | Low |
| `src/types/` | Add admin types, usage types | Low |
| `package.json` | Add dependencies, new scripts | Low |

### 5.3 Dependencies to Add

```json
{
  "dependencies": {
    "express": "^5.2.1",
    "better-sqlite3": "^11.0.0",
    "@types/better-sqlite3": "^7.6.13"
  },
  "devDependencies": {
    "@types/express": "^5.0.6"
  }
}
```

---

## 6. Success Criteria

### 6.1 Acceptance Criteria

| ID | Criterion | Verification |
|----|-----------|--------------|
| AC-1 | Server starts in HTTP mode with `MCP_TRANSPORT=http` | Manual test |
| AC-2 | Health endpoint returns valid JSON | `curl /health` |
| AC-3 | Multiple MCP clients can connect simultaneously | Connect 2+ clients |
| AC-4 | Admin API requires authentication | 401 without auth |
| AC-5 | Dashboard loads and displays status | Browser test |
| AC-6 | All existing tools continue to work | Test suite |
| AC-7 | Tool calls logged to usage database | Query SQLite |
| AC-8 | Server survives initialization errors | Kill network during crawl |

### 6.2 Definition of Done

- [ ] All P0 requirements implemented and tested
- [ ] All P1 requirements implemented
- [ ] Documentation updated (CLAUDE.md, README.md)
- [ ] No regressions in existing functionality
- [ ] Dashboard builds and serves correctly
- [ ] Scripts work on macOS/Linux

---

## 7. Risks and Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| StreamableHTTP SDK compatibility | High | Low | Use exact SDK version from Axon server |
| Session memory leaks | Medium | Medium | Implement cleanup on disconnect, timeout |
| Breaking existing clients | High | Low | Maintain stdio mode compatibility |
| Dashboard complexity | Medium | Medium | Start with essential pages only |
| SQLite performance | Low | Low | Index frequently queried columns |

---

## 8. Timeline and Phases

### Phase 1: Core Infrastructure (Foundation)
- HTTP transport implementation
- Session management
- Health endpoint
- Basic admin API (status, cache)

### Phase 2: Admin Capabilities
- Full admin API
- Usage tracking
- Configuration management
- Operational scripts

### Phase 3: Dashboard
- Next.js setup
- Core pages (status, cache, logs)
- API client
- Authentication

### Phase 4: Polish and Testing
- Comprehensive testing
- Documentation
- Performance optimization
- Edge case handling

---

## 9. References

- **Axon MCP Server:** `~/Code/axon-mcp-server`
- **Current Fantom MCP Server:** `/path/to/mcpfantom`
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **StreamableHTTP Transport:** `@modelcontextprotocol/sdk/server/streamableHttp.js`

---

## 10. Appendix

### A. Axon Server Package Versions (Reference)

```json
{
  "@modelcontextprotocol/sdk": "^1.18.0",
  "express": "^5.2.1",
  "@prisma/adapter-better-sqlite3": "^7.2.0",
  "@prisma/client": "^7.2.0"
}
```

### B. Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_TRANSPORT` | `stdio` | Transport mode: `stdio` or `http` |
| `MCP_PORT` | `3847` | HTTP server port |
| `ADMIN_USER` | `admin` | Admin API username |
| `ADMIN_PASS` | `admin` | Admin API password |
| `CACHE_ENABLED` | `true` | Enable/disable caching |
| `DEBUG` | - | Debug logging pattern |

### C. MCP Session Header

All HTTP requests after initialization must include:
```
mcp-session-id: <uuid>
```

---

*End of Product Requirements Document*
