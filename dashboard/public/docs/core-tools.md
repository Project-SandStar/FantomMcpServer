# Core Tools

Basic retrieval, indexing, and migration tools.

## Tools

### getFantomType
Get detailed information about a specific Fantom type.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| qualifiedName | string | Yes | Qualified type name (e.g., "sys::Str") |

**Example:**
```json
{
  "qualifiedName": "sys::Str"
}
```

---

### listFantomPods
List all available Fantom pods in the indexed documentation.

**Status:** Testing...

**Parameters:** None

**Example:**
```json
{}
```

---

### refreshIndex
Refresh the documentation index by re-crawling and parsing.

**Status:** Testing...

**Parameters:** None

**Example:**
```json
{}
```

---

### migrateSkySpark4x
Automatically migrate a SkySpark 3.x project to 4.0.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| gitlabUrl | string | Yes | GitLab SSH URL |
| projectName | string | Yes | Project name |
| workDir | string | Yes | Working directory |
| skysparkBinPath | string | Yes | SkySpark bin directory path |
| dryRun | boolean | No | Preview without committing |

**Example:**
```json
{
  "gitlabUrl": "git@gitlab.com:team/project.git",
  "projectName": "myProject",
  "workDir": "/tmp/migration",
  "skysparkBinPath": "/opt/skyspark/bin",
  "dryRun": true
}
```

---

### commitMigration
Commit and push migration changes after review.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| projectPath | string | Yes | Full path to the project |

**Example:**
```json
{
  "projectPath": "/tmp/migration/myProject"
}
```

---

### rollbackMigration
Rollback migration changes to pre-migration state.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| projectPath | string | Yes | Full path to the project |

**Example:**
```json
{
  "projectPath": "/tmp/migration/myProject"
}
```

---

### generateFantomCode
Generate various Fantom code constructs.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| type | string | Yes | Type of code to generate (class, method, etc.) |
| options | object | Yes | Generation options |

**Example:**
```json
{
  "type": "class",
  "options": {
    "name": "MyClass",
    "extends": "Obj"
  }
}
```

---

## Test Results

| Tool | Status | Notes |
|------|--------|-------|
| getFantomType | - | - |
| listFantomPods | - | - |
| refreshIndex | - | - |
| migrateSkySpark4x | - | - |
| commitMigration | - | - |
| rollbackMigration | - | - |
| generateFantomCode | - | - |
