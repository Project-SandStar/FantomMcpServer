# Fantom MCP Server Documentation

Welcome to the Fantom MCP Server documentation. This server provides AI assistants with tools to code and verify Fantom programming.

## Overview

The MCP (Model Context Protocol) server exposes 55 tools organized into the following categories:

| Category | Tools | Description |
|----------|-------|-------------|
| [Documentation](./documentation.md) | 8 | Search and browse Fantom/SkySpark/Haxall documentation |
| [Code Analysis](./code-analysis.md) | 8 | Parse, analyze, and validate Fantom code |
| [Code Generation](./code-generation.md) | 8 | Generate Fantom classes, methods, pods, and more |
| [Project Management](./project-management.md) | 8 | Manage projects, migrations, and configurations |
| [Analytics](./analytics.md) | 8 | Track usage, metrics, and export data |
| [Explorer](./explorer.md) | 3 | Meta-tools for discovering and executing other tools |
| [Core Tools](./core-tools.md) | 6 | Basic retrieval, indexing, and migration tools |

## Quick Start

### For AI Assistants

1. **Search Documentation**: Use `searchLocalDocs` to find types, functions, and tags
2. **Analyze Code**: Use `code_parse` to parse Fantom files and extract symbols
3. **Generate Code**: Use `gen_class`, `gen_method`, etc. to scaffold Fantom code
4. **Validate**: Use `code_validateSyntax` and `gen_validateCode` to check code

### Common Workflows

#### Finding a Fantom Type
```
Tool: docs_getType
Args: { "qualifiedName": "sys::Str" }
```

#### Parsing a Fantom File
```
Tool: code_parse
Args: { "filePath": "/path/to/MyClass.fan" }
```

#### Generating a New Class
```
Tool: gen_class
Args: {
  "name": "MyService",
  "pod": "myPod",
  "extends": "Obj",
  "fields": [{ "name": "count", "type": "Int", "defaultValue": "0" }]
}
```

## Tool Status

**Last tested: 2026-01-18**

| Status | Count | Percentage |
|--------|-------|------------|
| Working | 27 | 53% |
| Partial | 13 | 25% |
| Broken | 11 | 22% |
| **Total** | **51** | 100% |

### Priority Fixes Needed

1. **Explorer tools** (7 broken) - Routing issue in ExplorerOrchestrationAgent
2. **Documentation tools** (8 partial/broken) - fantom.org blocks LLM crawlers, need local doc parsing
3. **Migration tool** (1 broken) - SkySpark4xMigrator not configured

See **[Tool Status Report](./tool-status.md)** for detailed test results.
