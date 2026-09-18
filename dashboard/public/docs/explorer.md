# Explorer Tools

Meta-tools for discovering and executing other MCP tools.

## Tools

### explorer_listTools
List all available MCP tools with their schemas.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| category | string | No | Filter by category |

**Example:**
```json
{
  "category": "docs"
}
```

---

### explorer_getToolSchema
Get the full schema for a specific tool.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| toolName | string | Yes | Name of the tool |

**Example:**
```json
{
  "toolName": "gen_class"
}
```

---

### explorer_executeTool
Execute a tool by name with provided arguments.

**Status:** Testing...

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| toolName | string | Yes | Name of the tool to execute |
| args | object | No | Arguments to pass to the tool |

**Example:**
```json
{
  "toolName": "docs_search",
  "args": { "query": "Bool" }
}
```

---

## Test Results

| Tool | Status | Notes |
|------|--------|-------|
| explorer_listTools | - | - |
| explorer_getToolSchema | - | - |
| explorer_executeTool | - | - |
