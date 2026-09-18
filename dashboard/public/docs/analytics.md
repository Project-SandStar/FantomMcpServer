# Analytics Tools

Tools for tracking usage, metrics, and analyzing tool performance.

## Tools

### analytics_getUsage
Get usage statistics for the MCP server.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| startDate | string | No | Start date (ISO format) |
| endDate | string | No | End date (ISO format) |

**Example:**
```json
{
  "startDate": "2024-01-01",
  "endDate": "2024-01-31"
}
```

---

### analytics_getTopSearches
Get the most common search queries.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| limit | number | No | Maximum results (default: 10) |
| source | string | No | Filter by source |

**Example:**
```json
{
  "limit": 20
}
```

---

### analytics_getToolMetrics
Get performance metrics for specific tools.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| toolName | string | No | Specific tool name |
| period | string | No | Time period (day, week, month) |

**Example:**
```json
{
  "toolName": "docs_search",
  "period": "week"
}
```

---

### analytics_getSessionStats
Get session statistics.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| sessionId | string | No | Specific session ID |

**Example:**
```json
{}
```

---

### analytics_exportData
Export analytics data.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| format | string | No | Export format (json, csv) |
| dataType | string | No | Type of data to export |

**Example:**
```json
{
  "format": "json",
  "dataType": "tool_events"
}
```

---

### analytics_clearData
Clear analytics data.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| olderThan | string | No | Clear data older than date |
| dataType | string | No | Type of data to clear |

**Example:**
```json
{
  "olderThan": "2024-01-01",
  "dataType": "search_events"
}
```

---

### analytics_getDatabaseInfo
Get database information and statistics.

**Status:** Testing...

**Parameters:** None

**Example:**
```json
{}
```

---

### analytics_trackCustomEvent
Track a custom event.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| eventName | string | Yes | Event name |
| data | object | No | Event data |

**Example:**
```json
{
  "eventName": "user_action",
  "data": { "action": "export", "format": "pdf" }
}
```

---

## Test Results

| Tool | Status | Notes |
|------|--------|-------|
| analytics_getUsage | - | - |
| analytics_getTopSearches | - | - |
| analytics_getToolMetrics | - | - |
| analytics_getSessionStats | - | - |
| analytics_exportData | - | - |
| analytics_clearData | - | - |
| analytics_getDatabaseInfo | - | - |
| analytics_trackCustomEvent | - | - |
