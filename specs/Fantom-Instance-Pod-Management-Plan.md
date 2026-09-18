# Fantom Instance and Pod Management Implementation Plan

## Overview

This document outlines the implementation of a comprehensive Instance and Pod management system for the Fantom MCP Server, enabling users to:
- Manage multiple Fantom/SkySpark/Haxall installations (instances)
- Manage Fantom pods with configurable build files
- Compile pods against selected instances

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Dashboard (Next.js)                          │
├──────────┬──────────┬──────────┬──────────────────────────────────┤
│ Instance │ Pods     │ Compile  │ [InstanceSelector on all pages]  │
│ Manager  │ Manager  │ Output   │                                  │
└────┬─────┴────┬─────┴────┬─────┴─────────────────────────────────┘
     │          │          │
     ▼          ▼          ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Admin API (Express)                          │
├─────────────────────────────────────────────────────────────────┤
│  /admin/instances      - CRUD for Fantom instances              │
│  /admin/pods           - CRUD for Fantom pods                   │
│  /admin/compile        - Trigger compilation                    │
│  /admin/active-instance - Get/Set active instance               │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│              SQLite Database (.cache/fantom.db)                  │
├─────────────────────────────────────────────────────────────────┤
│  instances    - Fantom/SkySpark/Haxall installations            │
│  pods         - Fantom pod projects                             │
│  settings     - Active instance, preferences                    │
│  compile_logs - Compilation history                             │
└─────────────────────────────────────────────────────────────────┘
```

## Database Schema

### Table: `instances`
```sql
CREATE TABLE instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'fantom',  -- 'fantom', 'skyspark', 'haxall'
  version TEXT,
  fan_executable TEXT,  -- Path to fan executable (auto-detected or manual)
  description TEXT,
  is_valid INTEGER DEFAULT 1,  -- Whether path exists and fan is executable
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

### Table: `pods`
```sql
CREATE TABLE pods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  build_file TEXT NOT NULL DEFAULT 'build.fan',  -- e.g., 'build.fan', 'buildLocal.fan'
  description TEXT,
  default_instance_id INTEGER,  -- Optional preferred instance for this pod
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (default_instance_id) REFERENCES instances(id) ON DELETE SET NULL,
  UNIQUE(path, build_file)
);
```

### Table: `settings`
```sql
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
-- Keys: 'active_instance_id', 'last_compiled_pod_id', etc.
```

### Table: `compile_logs`
```sql
CREATE TABLE compile_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pod_id INTEGER NOT NULL,
  instance_id INTEGER NOT NULL,
  build_file TEXT NOT NULL,
  status TEXT NOT NULL,  -- 'success', 'failure', 'running'
  output TEXT,
  error TEXT,
  duration_ms INTEGER,
  started_at TEXT DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  FOREIGN KEY (pod_id) REFERENCES pods(id) ON DELETE CASCADE,
  FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE
);
```

## API Endpoints

### Instance Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/instances` | List all instances |
| GET | `/admin/instances/:id` | Get instance details |
| POST | `/admin/instances` | Add new instance |
| PUT | `/admin/instances/:id` | Update instance |
| DELETE | `/admin/instances/:id` | Delete instance |
| POST | `/admin/instances/:id/validate` | Validate instance path |
| GET | `/admin/active-instance` | Get active instance |
| POST | `/admin/active-instance` | Set active instance |

### Pod Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/pods` | List all pods |
| GET | `/admin/pods/:id` | Get pod details |
| POST | `/admin/pods` | Add new pod |
| PUT | `/admin/pods/:id` | Update pod (including build file) |
| DELETE | `/admin/pods/:id` | Delete pod |
| GET | `/admin/pods/:id/build-files` | List available build files in pod |
| POST | `/admin/pods/:id/compile` | Compile pod |
| GET | `/admin/pods/:id/compile-logs` | Get compilation history |

### Compilation

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/admin/compile` | Compile a pod with specific instance |
| GET | `/admin/compile/:logId` | Get compilation log |
| GET | `/admin/compile/running` | Get currently running compilations |

## TypeScript Interfaces

```typescript
// Instance
interface FantomInstance {
  id: number;
  name: string;
  path: string;
  type: 'fantom' | 'skyspark' | 'haxall';
  version?: string;
  fanExecutable: string;
  description?: string;
  isValid: boolean;
  createdAt: string;
  updatedAt: string;
}

// Pod
interface FantomPod {
  id: number;
  name: string;
  path: string;
  buildFile: string;
  description?: string;
  defaultInstanceId?: number;
  createdAt: string;
  updatedAt: string;
}

// Compilation Request
interface CompileRequest {
  podId: number;
  instanceId?: number;  // Uses active instance if not specified
  buildFile?: string;   // Uses pod's default if not specified
}

// Compilation Log
interface CompileLog {
  id: number;
  podId: number;
  instanceId: number;
  buildFile: string;
  status: 'success' | 'failure' | 'running';
  output?: string;
  error?: string;
  durationMs?: number;
  startedAt: string;
  completedAt?: string;
}
```

## Dashboard Pages

### 1. Instances Page (`/instances`)
- List all configured instances with status indicators
- Add/Edit/Delete instances
- Validate instance paths
- Set as active instance
- Show version info (detected from installation)

### 2. Pods Page (`/pods`)
- List all configured pods
- Add pod by selecting folder
- Select build file from available options
- Set default instance for pod
- Trigger compilation
- View compilation history

### 3. Compile Page (`/compile`) - Optional
- Select pod and instance
- Run compilation
- Real-time output streaming
- Compilation history

## Components

### InstanceSelector Component
- Dropdown showing all valid instances
- Displays active instance name
- Quick switch between instances
- Placed in dashboard header/nav
- Persists selection to database

## Implementation Steps

1. **Database Layer** (`src/fantom/database.ts`)
   - SQLite database manager
   - CRUD operations for instances and pods
   - Settings management

2. **Instance Manager** (`src/fantom/instanceManager.ts`)
   - Instance validation (check path, fan executable)
   - Version detection
   - Instance CRUD operations

3. **Pod Manager** (`src/fantom/podManager.ts`)
   - Pod CRUD operations
   - Build file discovery
   - Compilation execution

4. **Admin Routes** (`src/admin/routes.ts`)
   - Add instance/pod endpoints
   - Compilation endpoints

5. **Dashboard Components**
   - InstanceSelector component
   - Instances page
   - Pods page

## Compilation Flow

```
1. User selects pod and clicks "Compile"
2. Dashboard calls POST /admin/compile
3. Server resolves:
   - Instance: specified or active instance
   - Build file: specified or pod's default
4. Server validates:
   - Instance path exists
   - Fan executable works
   - Pod path exists
   - Build file exists
5. Server executes: `{instance.fanExecutable} {pod.path}/{buildFile}`
6. Server streams output to log
7. Server updates compile_logs with result
8. Dashboard shows success/failure
```

## Example Paths

**Instances:**
- `~/skyspark/skyspark-3.1.12` → `bin/fan`
- `~/skyspark/skyspark-3.1.9` → `bin/fan`
- `~/haxall/haxall-4.0.4` → `bin/fan`

**Pods:**
- `~/Code/myPod` → `build.fan`
- `~/Code/MileSight/bassgmilesight/bassgMilesightExt` → `buildLocal.fan`
