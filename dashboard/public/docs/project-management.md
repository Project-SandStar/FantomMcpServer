# Project Management Tools

Tools for managing Fantom projects, migrations, and configurations.

## Tools

### project_setPrimary
Set the primary/active project for operations.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| projectId | number | Yes | Project ID to set as primary |

**Example:**
```json
{
  "projectId": 1
}
```

---

### project_getPrimary
Get the currently active project.

**Status:** Testing...

**Parameters:** None

**Example:**
```json
{}
```

---

### project_detectEnvironment
Detect the Fantom/SkySpark environment and configuration.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| path | string | No | Path to check (uses current if not specified) |

**Example:**
```json
{
  "path": "/Users/dev/skyspark-3.1.12"
}
```

---

### project_migrate4x
Migrate a SkySpark 3.x project to 4.0.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| projectPath | string | Yes | Path to the project |
| skysparkBinPath | string | Yes | Path to SkySpark bin |
| dryRun | boolean | No | Preview without making changes |

**Example:**
```json
{
  "projectPath": "/path/to/project",
  "skysparkBinPath": "/opt/skyspark/bin",
  "dryRun": true
}
```

---

### project_commitMigration
Commit migration changes to git.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| projectPath | string | Yes | Path to the migrated project |
| message | string | No | Commit message |

**Example:**
```json
{
  "projectPath": "/path/to/project",
  "message": "Migrate to SkySpark 4.0"
}
```

---

### project_rollbackMigration
Rollback migration changes.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| projectPath | string | Yes | Path to the project |

**Example:**
```json
{
  "projectPath": "/path/to/project"
}
```

---

### project_listProjects
List all registered projects.

**Status:** Testing...

**Parameters:** None

**Example:**
```json
{}
```

---

### project_getConfig
Get project configuration.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| projectId | number | No | Specific project ID |

**Example:**
```json
{
  "projectId": 1
}
```

---

## Test Results

| Tool | Status | Notes |
|------|--------|-------|
| project_setPrimary | - | - |
| project_getPrimary | - | - |
| project_detectEnvironment | - | - |
| project_migrate4x | - | - |
| project_commitMigration | - | - |
| project_rollbackMigration | - | - |
| project_listProjects | - | - |
| project_getConfig | - | - |
