# Task Breakdown
# Fantom MCP Server Modernization

**Version:** 1.0
**Date:** 2026-01-15
**Based on:** Design Specification v1.0

---

## Overview

This document decomposes the design specification into granular, actionable tasks organized by work stream. Each task includes:
- **ID:** Unique identifier
- **Description:** What needs to be done
- **Dependencies:** Tasks that must complete first
- **Files:** Files to create/modify
- **Acceptance Criteria:** How to verify completion
- **Agent Assignment:** Suggested agent for parallel execution

---

## Work Stream 1: Core Infrastructure

### Task 1.1: Update Dependencies

**ID:** CORE-001
**Agent:** Agent-1 (Bash)
**Dependencies:** None
**Priority:** P0

**Description:**
Update package.json with new dependencies required for HTTP transport, admin API, and usage tracking.

**Files:**
- `package.json`

**Changes:**
```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.18.0",
    "better-sqlite3": "^11.0.0",
    "express": "^5.2.1"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/express": "^5.0.6"
  }
}
```

**Commands:**
```bash
cd /path/to/mcpfantom
npm install @modelcontextprotocol/sdk@^1.18.0 express@^5.2.1 better-sqlite3@^11.0.0
npm install -D @types/express@^5.0.6 @types/better-sqlite3@^7.6.13
```

**Acceptance Criteria:**
- [ ] package.json updated with new dependencies
- [ ] `npm install` completes without errors
- [ ] `npm run build` still works

---

### Task 1.2: Create Admin Types Module

**ID:** CORE-002
**Agent:** Agent-2 (Code)
**Dependencies:** None
**Priority:** P0

**Description:**
Create the admin types module defining interfaces for server status, cache info, and admin context.

**Files:**
- `src/admin/types.ts` (NEW)

**Content:** See design spec section 2.3

**Acceptance Criteria:**
- [ ] File created at src/admin/types.ts
- [ ] Exports: AdminCredentials, ServerStatus, CacheInfo, PrimaryProjectContext, AdminContext
- [ ] TypeScript compiles without errors

---

### Task 1.3: Create Admin Router Module

**ID:** CORE-003
**Agent:** Agent-2 (Code)
**Dependencies:** CORE-002
**Priority:** P0

**Description:**
Create the Express admin router with Basic Auth middleware and all admin endpoints.

**Files:**
- `src/admin/routes.ts` (NEW)
- `src/admin/index.ts` (NEW - re-export)

**Endpoints to implement:**
- GET /admin - API index
- GET /admin/status - Server status
- GET /admin/cache - Cache info
- POST /admin/cache/clear - Clear cache
- GET /admin/logs - SSE log stream
- GET /admin/primary-project - Get primary project
- POST /admin/primary-project - Set primary project

**Acceptance Criteria:**
- [ ] Router created with Basic Auth middleware
- [ ] All endpoints implemented
- [ ] Credentials loaded from config/admin.json or env
- [ ] TypeScript compiles without errors

---

### Task 1.4: Create Usage Tracker Module

**ID:** CORE-004
**Agent:** Agent-3 (Code)
**Dependencies:** CORE-001
**Priority:** P1

**Description:**
Create SQLite-backed usage tracking for tool calls and searches.

**Files:**
- `src/usage/types.ts` (NEW)
- `src/usage/usageTracker.ts` (NEW)
- `src/usage/index.ts` (NEW - re-export)

**Features:**
- Initialize SQLite database
- Track tool calls (name, duration, success)
- Track search queries (query, source, result count)
- Get usage statistics
- Clear/reset data

**Acceptance Criteria:**
- [ ] SQLite database created at .cache/usage.db
- [ ] trackToolCall() inserts records
- [ ] trackSearch() inserts records
- [ ] getStats() returns aggregated data
- [ ] TypeScript compiles without errors

---

### Task 1.5: Create Workflow Manager Module

**ID:** CORE-005
**Agent:** Agent-3 (Code)
**Dependencies:** None
**Priority:** P1

**Description:**
Create workflow manager for dynamic loading of markdown workflow resources.

**Files:**
- `src/workflows/workflowManager.ts` (NEW)
- `src/workflows/index.ts` (NEW - re-export)

**Features:**
- Load all .md files from workflows/ directory
- Extract title from first heading
- Extract description from first paragraph
- Provide list and get methods

**Acceptance Criteria:**
- [ ] WorkflowManager class created
- [ ] loadWorkflows() loads all .md files
- [ ] getWorkflowList() returns array of workflows
- [ ] getWorkflow(id) returns single workflow
- [ ] TypeScript compiles without errors

---

## Work Stream 2: HTTP Transport & Session Management

### Task 2.1: Refactor Main Server Class - Add State Variables

**ID:** HTTP-001
**Agent:** Agent-4 (Code)
**Dependencies:** CORE-002, CORE-004, CORE-005
**Priority:** P0

**Description:**
Add new state variables to FantomMCPServer class for HTTP transport, session management, initialization tracking, and logging.

**Files:**
- `src/index.ts` (MODIFY)

**Changes:**
Add these class members:
```typescript
// HTTP Transport
private httpTransports: Map<string, StreamableHTTPServerTransport> = new Map();
private httpSessions: Map<string, Server> = new Map();
private expressApp?: Application;

// Initialization
private initializationComplete: boolean = false;
private initializationPromise?: Promise<void>;

// Primary project context
private primaryContext: { instance: string; project: string; setBy: string; timestamp: Date } | null = null;

// Logging
private logBuffer: string[] = [];
private readonly maxLogBuffer = 500;
private startTime = Date.now();

// Usage tracking
private usageTracker: UsageTracker;

// Workflow manager
private workflowManager: WorkflowManager;
```

**Acceptance Criteria:**
- [ ] All state variables added
- [ ] TypeScript compiles without errors
- [ ] Existing functionality not broken

---

### Task 2.2: Implement Log Buffer Method

**ID:** HTTP-002
**Agent:** Agent-4 (Code)
**Dependencies:** HTTP-001
**Priority:** P0

**Description:**
Add logging method that writes to console.error and maintains buffer for dashboard.

**Files:**
- `src/index.ts` (MODIFY)

**Method:**
```typescript
private log(message: string): void {
  console.error(message);
  this.logBuffer.push(`[${new Date().toISOString()}] ${message}`);
  if (this.logBuffer.length > this.maxLogBuffer) {
    this.logBuffer.shift();
  }
}
```

**Acceptance Criteria:**
- [ ] log() method implemented
- [ ] Messages written to console.error
- [ ] Buffer maintained with max 500 entries

---

### Task 2.3: Implement setupHandlersOnServer Method

**ID:** HTTP-003
**Agent:** Agent-4 (Code)
**Dependencies:** HTTP-001
**Priority:** P0

**Description:**
Refactor handler setup to work on any Server instance (for both stdio and HTTP sessions).

**Files:**
- `src/index.ts` (MODIFY)

**Changes:**
- Extract existing handler setup into `setupHandlersOnServer(server: Server)`
- Call this from constructor for main server
- Call this for each new HTTP session server

**Acceptance Criteria:**
- [ ] setupHandlersOnServer() accepts Server parameter
- [ ] All existing handlers registered on passed server
- [ ] Existing stdio functionality preserved

---

### Task 2.4: Implement startHttpServer Method

**ID:** HTTP-004
**Agent:** Agent-4 (Code)
**Dependencies:** HTTP-002, HTTP-003, CORE-003
**Priority:** P0

**Description:**
Implement HTTP server startup with Express, including all endpoints.

**Files:**
- `src/index.ts` (MODIFY)

**Endpoints:**
- GET /health - Health check
- POST /mcp - Handle MCP requests (with session routing)
- GET /mcp - SSE stream for notifications
- DELETE /mcp - Terminate session
- /admin/* - Admin router
- /dashboard/* - Static dashboard files

**Acceptance Criteria:**
- [ ] Express server starts on configured port
- [ ] /health returns JSON status
- [ ] /mcp POST creates sessions and handles requests
- [ ] Session ID generated and returned in header
- [ ] Admin router mounted with Basic Auth
- [ ] Dashboard static files served (if built)

---

### Task 2.5: Implement Session Management in /mcp POST

**ID:** HTTP-005
**Agent:** Agent-4 (Code)
**Dependencies:** HTTP-004
**Priority:** P0

**Description:**
Implement full session management for the POST /mcp endpoint.

**Files:**
- `src/index.ts` (MODIFY)

**Logic:**
1. Check for mcp-session-id header
2. If exists and valid, route to existing session transport
3. If no session ID and is initialize request:
   - Create new Server instance
   - Setup handlers on new server
   - Create StreamableHTTPServerTransport
   - Connect server to transport
   - Store in maps
   - Handle request
4. If invalid, return 400 error

**Acceptance Criteria:**
- [ ] New sessions created on initialize request
- [ ] Existing sessions routed correctly
- [ ] Session cleanup on close
- [ ] Invalid requests rejected with 400

---

### Task 2.6: Implement Dual Transport run() Method

**ID:** HTTP-006
**Agent:** Agent-4 (Code)
**Dependencies:** HTTP-005
**Priority:** P0

**Description:**
Refactor run() method to support both stdio and HTTP transport modes.

**Files:**
- `src/index.ts` (MODIFY)

**Logic:**
```typescript
async run() {
  const transportMode = process.env.MCP_TRANSPORT || 'stdio';

  if (transportMode === 'http') {
    await this.startHttpServer();
    this.initializationPromise = this.initialize().then(() => {
      this.initializationComplete = true;
    });
    await new Promise(() => {}); // Keep alive
  } else {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    this.initializationPromise = this.initialize().then(() => {
      this.initializationComplete = true;
    });
  }
}
```

**Acceptance Criteria:**
- [ ] MCP_TRANSPORT=http starts HTTP server
- [ ] Default (stdio) behavior preserved
- [ ] Initialization runs in background
- [ ] HTTP server keeps process alive

---

### Task 2.7: Add Initialization Wait to Tool Handlers

**ID:** HTTP-007
**Agent:** Agent-4 (Code)
**Dependencies:** HTTP-006
**Priority:** P0

**Description:**
Modify tool handlers to wait for initialization before executing.

**Files:**
- `src/index.ts` (MODIFY)

**Change in CallToolRequestSchema handler:**
```typescript
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // Wait for initialization
  if (!this.initializationComplete && this.initializationPromise) {
    await this.initializationPromise;
  }
  // ... rest of handler
});
```

**Acceptance Criteria:**
- [ ] Tools wait for initialization
- [ ] No errors if called during startup
- [ ] Quick response once initialized

---

### Task 2.8: Implement createAdminContext Method

**ID:** HTTP-008
**Agent:** Agent-4 (Code)
**Dependencies:** HTTP-007, CORE-003
**Priority:** P0

**Description:**
Implement method to create context object for admin router.

**Files:**
- `src/index.ts` (MODIFY)

**Method:**
```typescript
private createAdminContext(): AdminContext {
  return {
    getServerStatus: () => this.getServerStatus(),
    getCacheInfo: () => this.getCacheInfo(),
    clearCache: (name) => this.clearCache(name),
    getLogBuffer: () => this.logBuffer,
    getPrimaryProject: () => this.primaryContext,
    setPrimaryProject: async (instance, project, setBy) => {
      this.primaryContext = { instance, project, setBy, timestamp: new Date() };
      return this.primaryContext;
    },
    configDir: path.join(process.cwd(), 'config'),
    cacheDir: this.config.cacheDir
  };
}
```

Also implement helper methods: getServerStatus(), getCacheInfo(), clearCache()

**Acceptance Criteria:**
- [ ] createAdminContext() returns valid AdminContext
- [ ] getServerStatus() returns correct data
- [ ] getCacheInfo() lists cache files
- [ ] clearCache() deletes files

---

## Work Stream 3: Configuration & Scripts

### Task 3.1: Create Config Directory Structure

**ID:** CONFIG-001
**Agent:** Agent-5 (Bash)
**Dependencies:** None
**Priority:** P1

**Description:**
Create config directory and admin credentials file.

**Commands:**
```bash
mkdir -p /path/to/mcpfantom/config
cat > /path/to/mcpfantom/config/admin.json << 'EOF'
{
  "username": "admin",
  "password": "<admin-password>"
}
EOF
```

**Acceptance Criteria:**
- [ ] config/ directory exists
- [ ] config/admin.json created with default credentials

---

### Task 3.2: Create Operational Scripts

**ID:** CONFIG-002
**Agent:** Agent-5 (Bash)
**Dependencies:** None
**Priority:** P0

**Description:**
Create shell scripts for server lifecycle management.

**Files:**
- `scripts/start-server.sh` (NEW)
- `scripts/stop-server.sh` (NEW)
- `scripts/status-server.sh` (NEW)

**Content:** See design spec section 6

**Acceptance Criteria:**
- [ ] All scripts created
- [ ] Scripts are executable (chmod +x)
- [ ] start-server.sh starts HTTP server with logging
- [ ] stop-server.sh kills server process
- [ ] status-server.sh shows health check output

---

### Task 3.3: Update Package.json Scripts

**ID:** CONFIG-003
**Agent:** Agent-5 (Bash)
**Dependencies:** CONFIG-002
**Priority:** P0

**Description:**
Add new npm scripts for HTTP mode and daemon management.

**Files:**
- `package.json` (MODIFY)

**Scripts to add:**
```json
{
  "start:http": "MCP_TRANSPORT=http MCP_PORT=3847 node --max-old-space-size=4096 build/index.js",
  "stop": "bash scripts/stop-server.sh",
  "status": "bash scripts/status-server.sh",
  "daemon:start": "MCP_TRANSPORT=http MCP_PORT=3847 pm2 start build/index.js --name fantom-mcp",
  "daemon:stop": "pm2 stop fantom-mcp",
  "daemon:restart": "pm2 restart fantom-mcp",
  "daemon:logs": "pm2 logs fantom-mcp",
  "dashboard:dev": "cd dashboard && npm run dev",
  "dashboard:build": "cd dashboard && npm run build",
  "dashboard:install": "cd dashboard && npm install"
}
```

**Acceptance Criteria:**
- [ ] All scripts added to package.json
- [ ] `npm run start:http` works
- [ ] `npm run stop` works
- [ ] `npm run status` works

---

### Task 3.4: Enhance Config Module for Primary Project Persistence

**ID:** CONFIG-004
**Agent:** Agent-5 (Code)
**Dependencies:** None
**Priority:** P1

**Description:**
Add function to save/load primary project to config file.

**Files:**
- `src/config/index.ts` (MODIFY)

**Functions to add:**
```typescript
export function savePrimaryProject(instance: string, project: string): void {
  const configPath = path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');
  let config = {};
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }
  config.primaryProject = { instance, project };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

export function loadPrimaryProject(): { instance: string; project: string } | null {
  const configPath = path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');
  if (!fs.existsSync(configPath)) return null;
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  return config.primaryProject || null;
}
```

**Acceptance Criteria:**
- [ ] savePrimaryProject() persists to config file
- [ ] loadPrimaryProject() reads from config file
- [ ] Works with non-existent file

---

## Work Stream 4: Dashboard

### Task 4.1: Initialize Next.js Dashboard Project

**ID:** DASH-001
**Agent:** Agent-6 (Bash)
**Dependencies:** None
**Priority:** P1

**Description:**
Create Next.js dashboard project with required dependencies.

**Commands:**
```bash
cd /path/to/mcpfantom
npx create-next-app@latest dashboard --typescript --tailwind --eslint --app --src-dir --no-import-alias
cd dashboard
npm install @tanstack/react-query
```

**Acceptance Criteria:**
- [ ] dashboard/ directory created
- [ ] Next.js project initialized
- [ ] Tailwind CSS configured
- [ ] React Query installed

---

### Task 4.2: Configure Dashboard for Static Export

**ID:** DASH-002
**Agent:** Agent-6 (Code)
**Dependencies:** DASH-001
**Priority:** P1

**Description:**
Configure Next.js for static HTML export.

**Files:**
- `dashboard/next.config.ts` (MODIFY)

**Content:**
```typescript
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'export',
  basePath: '/dashboard',
  trailingSlash: true,
};

export default nextConfig;
```

**Acceptance Criteria:**
- [ ] Static export enabled
- [ ] Base path set to /dashboard
- [ ] Build creates dashboard/out directory

---

### Task 4.3: Create Dashboard API Client

**ID:** DASH-003
**Agent:** Agent-6 (Code)
**Dependencies:** DASH-001
**Priority:** P1

**Description:**
Create API client for communicating with admin endpoints.

**Files:**
- `dashboard/src/lib/api.ts` (NEW)

**Content:** See design spec section 5.3

**Acceptance Criteria:**
- [ ] apiRequest function with Basic Auth
- [ ] All api methods defined
- [ ] Credentials from localStorage

---

### Task 4.4: Create Dashboard Layout and Navigation

**ID:** DASH-004
**Agent:** Agent-6 (Code)
**Dependencies:** DASH-003
**Priority:** P1

**Description:**
Create root layout with sidebar navigation.

**Files:**
- `dashboard/src/app/layout.tsx` (MODIFY)
- `dashboard/src/components/nav.tsx` (NEW)

**Features:**
- Sidebar with navigation links
- Links: Home, Cache, Logs, Usage, Config
- Active state highlighting

**Acceptance Criteria:**
- [ ] Layout with sidebar navigation
- [ ] All navigation links present
- [ ] Responsive design

---

### Task 4.5: Create Status Page (Home)

**ID:** DASH-005
**Agent:** Agent-6 (Code)
**Dependencies:** DASH-004
**Priority:** P1

**Description:**
Create home page showing server status.

**Files:**
- `dashboard/src/app/page.tsx` (MODIFY)
- `dashboard/src/components/status-card.tsx` (NEW)

**Features:**
- Server status (running/starting/error)
- Uptime display
- Memory usage (used/total/percentage)
- Indexed documents count
- Active sessions count

**Acceptance Criteria:**
- [ ] Status data fetched from /admin/status
- [ ] All metrics displayed
- [ ] Auto-refresh every 5 seconds

---

### Task 4.6: Create Cache Management Page

**ID:** DASH-006
**Agent:** Agent-6 (Code)
**Dependencies:** DASH-004
**Priority:** P1

**Description:**
Create page for viewing and managing cache files.

**Files:**
- `dashboard/src/app/cache/page.tsx` (NEW)
- `dashboard/src/components/cache-list.tsx` (NEW)

**Features:**
- List all cache files
- Show size, last modified, age
- Clear individual cache
- Clear all caches

**Acceptance Criteria:**
- [ ] Cache files listed from /admin/cache
- [ ] Clear buttons functional
- [ ] Confirmation before clear all

---

### Task 4.7: Create Logs Page

**ID:** DASH-007
**Agent:** Agent-6 (Code)
**Dependencies:** DASH-004
**Priority:** P2

**Description:**
Create page for viewing real-time server logs.

**Files:**
- `dashboard/src/app/logs/page.tsx` (NEW)
- `dashboard/src/components/log-viewer.tsx` (NEW)

**Features:**
- Connect to SSE stream at /admin/logs
- Display logs in scrollable container
- Auto-scroll to bottom
- Clear/pause buttons

**Acceptance Criteria:**
- [ ] SSE connection established
- [ ] Logs displayed in real-time
- [ ] Auto-scroll works
- [ ] Clean UI

---

### Task 4.8: Create Usage Analytics Page

**ID:** DASH-008
**Agent:** Agent-6 (Code)
**Dependencies:** DASH-004
**Priority:** P2

**Description:**
Create page for viewing usage statistics.

**Files:**
- `dashboard/src/app/usage/page.tsx` (NEW)
- `dashboard/src/components/usage-chart.tsx` (NEW)

**Features:**
- Total tool calls and searches
- Tool usage breakdown (table or chart)
- Top search queries
- Time period selector (7/30 days)

**Acceptance Criteria:**
- [ ] Usage data fetched from /admin/usage
- [ ] All metrics displayed
- [ ] Period selector works

---

### Task 4.9: Build Dashboard for Production

**ID:** DASH-009
**Agent:** Agent-6 (Bash)
**Dependencies:** DASH-005, DASH-006, DASH-007, DASH-008
**Priority:** P1

**Description:**
Build dashboard for static export.

**Commands:**
```bash
cd /path/to/mcpfantom/dashboard
npm run build
```

**Acceptance Criteria:**
- [ ] Build completes without errors
- [ ] dashboard/out/ directory created
- [ ] index.html present

---

## Work Stream 5: Integration & Testing

### Task 5.1: Add Usage Tracking to Tool Handlers

**ID:** TEST-001
**Agent:** Agent-4 (Code)
**Dependencies:** CORE-004, HTTP-007
**Priority:** P1

**Description:**
Integrate usage tracking into tool call handler.

**Files:**
- `src/index.ts` (MODIFY)

**Changes:**
Wrap tool execution with timing and tracking:
```typescript
const startTime = Date.now();
try {
  const result = await executeToolCall(name, args);
  this.usageTracker.trackToolCall({
    toolName: name,
    timestamp: new Date(),
    durationMs: Date.now() - startTime,
    success: true
  });
  return result;
} catch (error) {
  this.usageTracker.trackToolCall({
    toolName: name,
    timestamp: new Date(),
    durationMs: Date.now() - startTime,
    success: false,
    errorMessage: error.message
  });
  throw error;
}
```

**Acceptance Criteria:**
- [ ] All tool calls tracked
- [ ] Duration measured correctly
- [ ] Errors tracked with message

---

### Task 5.2: Add Search Tracking

**ID:** TEST-002
**Agent:** Agent-4 (Code)
**Dependencies:** CORE-004, TEST-001
**Priority:** P1

**Description:**
Track search queries in searchFantomDocs and searchHaxallDocs.

**Files:**
- `src/index.ts` (MODIFY)

**Changes:**
After executing search:
```typescript
this.usageTracker.trackSearch({
  query,
  source: 'fantom', // or 'haxall'
  resultCount: results.length,
  timestamp: new Date()
});
```

**Acceptance Criteria:**
- [ ] Fantom searches tracked
- [ ] Haxall searches tracked
- [ ] Result counts recorded

---

### Task 5.3: Integration Testing - HTTP Mode

**ID:** TEST-003
**Agent:** Agent-1 (Bash)
**Dependencies:** HTTP-006, CONFIG-003
**Priority:** P0

**Description:**
Test HTTP mode functionality.

**Test Steps:**
```bash
# Start server in HTTP mode
cd /path/to/mcpfantom
npm run build
MCP_TRANSPORT=http npm start &

# Wait for startup
sleep 5

# Test health endpoint
curl http://localhost:3847/health

# Test admin status (with auth)
curl -u admin:admin http://localhost:3847/admin/status

# Stop server
npm run stop
```

**Acceptance Criteria:**
- [ ] Server starts without errors
- [ ] Health endpoint returns JSON
- [ ] Admin endpoint requires auth
- [ ] Server stops cleanly

---

### Task 5.4: Integration Testing - MCP Client

**ID:** TEST-004
**Agent:** Agent-1 (Bash)
**Dependencies:** TEST-003
**Priority:** P0

**Description:**
Test MCP client connection via HTTP.

**Test Steps:**
1. Start server in HTTP mode
2. Use MCP inspector or test client to:
   - Initialize session
   - List tools
   - Call searchFantomDocs
   - Verify session cleanup on disconnect

**Acceptance Criteria:**
- [ ] Session created successfully
- [ ] Tools listed correctly
- [ ] Search returns results
- [ ] Session cleaned up on disconnect

---

### Task 5.5: Update Documentation

**ID:** TEST-005
**Agent:** Agent-2 (Code)
**Dependencies:** TEST-003, TEST-004
**Priority:** P1

**Description:**
Update CLAUDE.md and README.md with new features.

**Files:**
- `CLAUDE.md` (MODIFY)
- `README.md` (MODIFY)

**Additions:**
- HTTP mode instructions
- Admin API documentation
- Dashboard usage
- New npm scripts

**Acceptance Criteria:**
- [ ] CLAUDE.md updated with HTTP mode
- [ ] README.md updated with new features
- [ ] All new scripts documented

---

## Task Execution Order

### Phase 1: Foundation (Parallel)

**Agent-1:** CORE-001 (Dependencies)
**Agent-2:** CORE-002 (Admin Types), CORE-003 (Admin Router)
**Agent-3:** CORE-004 (Usage Tracker), CORE-005 (Workflow Manager)
**Agent-5:** CONFIG-001 (Config Dir), CONFIG-002 (Scripts)
**Agent-6:** DASH-001 (Init Dashboard)

### Phase 2: HTTP Transport (Sequential)

**Agent-4:** HTTP-001 → HTTP-002 → HTTP-003 → HTTP-004 → HTTP-005 → HTTP-006 → HTTP-007 → HTTP-008

### Phase 3: Dashboard (Parallel with Phase 2)

**Agent-6:** DASH-002 → DASH-003 → DASH-004 → DASH-005 → DASH-006 → DASH-007 → DASH-008 → DASH-009

### Phase 4: Integration (Sequential)

**Agent-4:** TEST-001 → TEST-002
**Agent-5:** CONFIG-003, CONFIG-004
**Agent-1:** TEST-003 → TEST-004
**Agent-2:** TEST-005

---

## Summary by Agent

| Agent | Primary Focus | Tasks |
|-------|---------------|-------|
| Agent-1 | Bash/Dependencies | CORE-001, TEST-003, TEST-004 |
| Agent-2 | Core Types/Admin | CORE-002, CORE-003, TEST-005 |
| Agent-3 | Usage/Workflows | CORE-004, CORE-005 |
| Agent-4 | HTTP Transport | HTTP-001 through HTTP-008, TEST-001, TEST-002 |
| Agent-5 | Config/Scripts | CONFIG-001 through CONFIG-004 |
| Agent-6 | Dashboard | DASH-001 through DASH-009 |

---

## Critical Path

The following tasks are on the critical path and must complete for MVP:

1. CORE-001 (Dependencies)
2. CORE-002, CORE-003 (Admin module)
3. HTTP-001 through HTTP-008 (Transport)
4. CONFIG-002, CONFIG-003 (Scripts)
5. TEST-003 (Integration test)

Dashboard (Work Stream 4) is P1 and can be completed after core functionality.

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| SDK version mismatch | Pin to exact version from Axon server |
| Session memory leaks | Implement cleanup timeouts |
| Dashboard build fails | Can deploy server without dashboard |
| SQLite issues | Usage tracking is P1, can be disabled |

---

*End of Task Breakdown*
