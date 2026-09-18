# Documentation Tools

Tools for searching and browsing Fantom, SkySpark, and Haxall documentation.

## Tools

### docs_search
Search documentation by query string.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| query | string | Yes | Search query |
| limit | number | No | Maximum results (default: 20) |
| type | string | No | Filter by type (type, function, slot, etc.) |

**Example:**
```json
{
  "query": "Bool",
  "limit": 10,
  "type": "type"
}
```

---

### docs_getType
Get detailed information about a specific type.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| qualifiedName | string | Yes | Fully qualified type name (e.g., "sys::Str") |

**Example:**
```json
{
  "qualifiedName": "sys::Bool"
}
```

---

### docs_getPod
Get information about a specific pod.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| podName | string | Yes | Pod name (e.g., "sys") |

**Example:**
```json
{
  "podName": "haystack"
}
```

---

### docs_listPods
List all available pods in the documentation index.

**Status:** Testing...

**Parameters:** None

**Example:**
```json
{}
```

---

### docs_refreshIndex
Refresh the documentation index.

**Status:** Testing...

**Parameters:** None

**Example:**
```json
{}
```

---

### docs_searchBySignature
Search for functions by their signature pattern.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| signature | string | Yes | Signature pattern to match |

**Example:**
```json
{
  "signature": "Str -> Bool"
}
```

---

### docs_getExamples
Get code examples for a specific type or function.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| qualifiedName | string | Yes | Type or function name |

**Example:**
```json
{
  "qualifiedName": "sys::Str.split"
}
```

---

### docs_findRelated
Find related types, functions, or documentation.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| qualifiedName | string | Yes | Starting point for finding related items |

**Example:**
```json
{
  "qualifiedName": "sys::List"
}
```

---

## Test Results

| Tool | Status | Notes |
|------|--------|-------|
| docs_search | - | - |
| docs_getType | - | - |
| docs_getPod | - | - |
| docs_listPods | - | - |
| docs_refreshIndex | - | - |
| docs_searchBySignature | - | - |
| docs_getExamples | - | - |
| docs_findRelated | - | - |
