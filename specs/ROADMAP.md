# MCP Fantom Features Roadmap

Feature enhancement roadmap for mcpfantom based on MCP ecosystem best practices, tailored specifically for Fantom/Haxall/SkySpark development.

---

## Current State Summary

### Existing Capabilities (48 Tools)

| Agent              | Tools | Status      |
|--------------------|-------|-------------|
| Documentation      | 8     | ✅ Complete |
| Code Analysis      | 8     | ✅ Complete |
| Code Generation    | 8     | ✅ Complete |
| Project Management | 8     | ✅ Complete |
| Analytics          | 8     | ✅ Complete |
| Explorer           | 8     | ✅ Complete |

**Tool details per agent:**
- **Documentation**: search, getType, getPod, listPods, refreshIndex, searchBySignature, getExamples, findRelated
- **Code Analysis**: parse, getSymbols, findDefinition, findReferences, getCompletions, validateSyntax, extractDependencies, getCallHierarchy
- **Code Generation**: class, method, pod, enum, mixin, test, buildFile, validateCode
- **Project Management**: setPrimary, getPrimary, detectEnvironment, migrate4x, commitMigration, rollbackMigration, listProjects, getConfig
- **Analytics**: getUsage, getTopSearches, getToolMetrics, getSessionStats, exportData, clearData, getDatabaseInfo, trackCustomEvent
- **Explorer**: listTools, getToolSchema, executeTool, getAgentStatus, getSystemHealth, browseCategories, searchTools, getWorkflows

---

## Gap Analysis (Fantom-Specific)

| Feature          | Current Status         | Gap                        | Priority  |
|------------------|------------------------|----------------------------|-----------|
| Git Operations   | Migration commits only | Full git workflow          | 🔴 High   |
| Pod Compilation  | External only          | Integrated compilation     | 🔴 High   |
| Test Execution   | Generation only        | Run tests, report results  | 🟡 Medium |
| Fantom REPL      | Not available          | Interactive evaluation     | 🟡 Medium |
| Code Refactoring | None                   | Extract/rename/inline      | 🟡 Medium |
| Pod Dependencies | Basic extraction       | Vulnerability scan/updates | 🟢 Low    |
| Live Diagnostics | None                   | File watch + error stream  | 🟢 Low    |

---

## Feature Roadmap

### Phase 1: Developer Workflow Essentials

#### 1.1 Full Git Operations
**Priority**: 🔴 High
**Effort**: 1-2 weeks

Extend beyond migration-only git to full version control workflow.

**New Tools**:
| Tool | Description |
|------|-------------|
| `git_status` | Show working tree status |
| `git_diff` | Show staged/unstaged changes |
| `git_branch` | Create, list, switch branches |
| `git_commit` | Create commits with message |
| `git_push` | Push to remote |
| `git_pull` | Pull from remote |
| `git_log` | View commit history |
| `git_stash` | Stash/unstash changes |

**Technology**: `simple-git` npm package

**Integration Point**: Project Management Agent

---

#### 1.2 Integrated Pod Compilation
**Priority**: 🔴 High
**Effort**: 1-2 weeks

Compile Fantom pods directly from MCP tools with structured output.

**New Tools**:
| Tool | Description |
|------|-------------|
| `compile_pod` | Compile single pod |
| `compile_all` | Compile all pods in project |
| `compile_clean` | Clean build artifacts |
| `compile_status` | Check compilation state |

**Technology**: Fantom `fan` CLI wrapper, build.fan execution

**Integration Point**: Project Management Agent (existing compile endpoints in Admin API)

---

### Phase 2: Testing & Debugging

#### 2.1 Test Runner Integration
**Priority**: 🟡 Medium
**Effort**: 1-2 weeks

Execute Fantom tests and report results through MCP.

**New Tools**:
| Tool | Description |
|------|-------------|
| `test_run` | Run all tests in pod |
| `test_runClass` | Run tests in specific class |
| `test_runMethod` | Run single test method |
| `test_list` | List available tests |
| `test_results` | Get last test results |

**Technology**: Fantom `fant` test runner, result parsing

**Integration Point**: New Testing Agent or Code Analysis Agent

---

#### 2.2 Fantom REPL/Shell
**Priority**: 🟡 Medium
**Effort**: 2-3 weeks

Interactive Fantom code evaluation for quick experiments.

**New Tools**:
| Tool | Description |
|------|-------------|
| `repl_eval` | Evaluate Fantom expression |
| `repl_evalAxon` | Evaluate Axon expression |
| `repl_loadPod` | Load pod into REPL context |
| `repl_reset` | Reset REPL state |

**Technology**: Fantom shell subprocess, sandbox isolation

**Integration Point**: New Execution Agent

---

### Phase 3: Code Quality

#### 3.1 Code Refactoring
**Priority**: 🟡 Medium
**Effort**: 3-4 weeks

Safe automated code transformations for Fantom.

**New Tools**:
| Tool | Description |
|------|-------------|
| `refactor_rename` | Rename symbol across codebase |
| `refactor_extractMethod` | Extract selection to method |
| `refactor_extractClass` | Extract members to new class |
| `refactor_inline` | Inline method/variable |
| `refactor_changeSignature` | Modify method parameters |
| `refactor_preview` | Preview refactoring changes |

**Technology**: Custom AST transforms using existing Fantom parser

**Integration Point**: Code Generation Agent

---

#### 3.2 Pod Dependency Analysis
**Priority**: 🟢 Low
**Effort**: 2 weeks

Analyze pod dependencies for issues and updates.

**New Tools**:
| Tool | Description |
|------|-------------|
| `deps_tree` | Show full dependency tree |
| `deps_outdated` | Check for newer pod versions |
| `deps_unused` | Find unused dependencies |
| `deps_circular` | Detect circular dependencies |

**Technology**: build.fan parsing, Fantom repo (fanr) queries

**Integration Point**: Code Analysis Agent

---

#### 3.3 Live Diagnostics
**Priority**: 🟢 Low
**Effort**: 2-3 weeks

Real-time error/warning streaming as files change.

**New Tools**:
| Tool | Description |
|------|-------------|
| `diag_watch` | Start watching directory |
| `diag_stop` | Stop watching |
| `diag_getErrors` | Get current errors |
| `diag_subscribe` | SSE stream of diagnostics |

**Technology**: chokidar file watcher + Fantom parser/compiler

**Note**: Fantom lacks native file watching capabilities. The `sys::File` API provides file I/O but no OS-level event notifications (inotify/FSEvents/ReadDirectoryChangesW). Implementation requires:
- **File watching**: chokidar (Node.js) - already in our stack, cross-platform
- **Code analysis**: Fantom `compiler` pod or existing mcpfantom parser for error detection

**Integration Point**: Code Analysis Agent

---

## Implementation Summary

| Phase     | Feature          | New Tools | Effort      | Technologies    |
|-----------|------------------|-----------|-------------|-----------------|
| 1         | Git Operations   | 8         | 1-2 weeks   | simple-git      |
| 1         | Pod Compilation  | 4         | 1-2 weeks   | fan CLI         |
| 2         | Test Runner      | 5         | 1-2 weeks   | fant CLI        |
| 2         | Fantom REPL      | 4         | 2-3 weeks   | fan shell       |
| 3         | Refactoring      | 6         | 3-4 weeks   | AST transforms  |
| 3         | Dependencies     | 4         | 2 weeks     | fanr, build.fan |
| 3         | Live Diagnostics | 4         | 2-3 weeks   | chokidar        |
| **Total** | -                | **35**    | **~14 wks** | -               |

---

## Agent Architecture Update

After implementation, the agent structure would be:

| Agent                 | Tools                   | Change            |
|-----------------------|-------------------------|-------------------|
| Documentation         | 8                       | No change         |
| Code Analysis         | 12 (+4 diag)            | +Live diagnostics |
| Code Generation       | 14 (+6 refactor)        | +Refactoring      |
| Project Management    | 20 (+8 git, +4 compile) | +Git, +Compile    |
| Analytics             | 8                       | No change         |
| Explorer              | 8                       | No change         |
| **NEW: Testing**      | 5                       | New agent         |
| **NEW: Execution**    | 4                       | New agent (REPL)  |
| **NEW: Dependencies** | 4                       | New agent         |
| **Total**             | **83**                  | up from 48        |

---

## Sources

- [MCP Specification](https://modelcontextprotocol.io/specification/2025-11-25)
- [Official MCP Servers](https://github.com/modelcontextprotocol/servers)
- [Git MCP Server](https://www.pulsemcp.com/servers/modelcontextprotocol-git)
- [MCP Testing Tools](https://testomat.io/blog/mcp-server-testing-tools/)
- [Code Refactoring MCP](https://github.com/dave-hillier/refactor-mcp)