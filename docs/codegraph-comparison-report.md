# CodeGraph vs MCP Fantom: Feature Comparison Report

**Generated:** 2026-02-01
**Purpose:** Identify features in CodeGraph that could enhance MCP Fantom

---

## Executive Summary

CodeGraph is a semantic code intelligence tool that builds knowledge graphs from codebases to enhance Claude Code exploration. MCP Fantom is a comprehensive MCP server for Fantom/SkySpark/Haxall development with documentation search, code generation, and migration tools.

**Key Finding:** These projects have complementary strengths. CodeGraph excels at **code relationship analysis** while MCP Fantom excels at **domain-specific tooling and infrastructure**.

---

## Feature Comparison Matrix

| Feature Category | CodeGraph | MCP Fantom | Winner |
|-----------------|-----------|------------|--------|
| **Code Intelligence** | | | |
| Semantic Knowledge Graph | ✅ SQLite graph DB | ❌ Missing | CodeGraph |
| Call Graph Analysis | ✅ Callers/Callees | ❌ Missing | CodeGraph |
| Impact Analysis | ✅ Change radius | ❌ Missing | CodeGraph |
| AST Parsing | ✅ Tree-sitter (15+ langs) | ✅ Fantom-only | CodeGraph |
| Vector Embeddings | ✅ Local ONNX | ❌ Missing | CodeGraph |
| Auto-sync (Git hooks) | ✅ Post-commit | ❌ Missing | CodeGraph |
| **Search & Documentation** | | | |
| Full-text Search | ✅ FTS5 | ✅ FlexSearch | Tie |
| Semantic Search | ✅ Meaning-based | ❌ Text-only | CodeGraph |
| Documentation Crawling | ❌ None | ✅ Multi-source | MCP Fantom |
| Version-aware Search | ❌ None | ✅ Version filtering | MCP Fantom |
| **Infrastructure** | | | |
| HTTP Transport | ❌ Stdio only | ✅ Multi-client | MCP Fantom |
| Authentication | ❌ None | ✅ OAuth 2.1 PKCE | MCP Fantom |
| Admin Dashboard | ❌ None | ✅ Next.js UI | MCP Fantom |
| Backup/Restore | ❌ None | ✅ Full system | MCP Fantom |
| Usage Analytics | ❌ None | ✅ SQLite tracking | MCP Fantom |
| **Domain Features** | | | |
| Code Generation | ❌ None | ✅ Fantom artifacts | MCP Fantom |
| Migration Tools | ❌ None | ✅ SkySpark 3→4 | MCP Fantom |
| Instance Management | ❌ None | ✅ Multi-instance | MCP Fantom |
| Workflow Guides | ❌ None | ✅ 11 guides | MCP Fantom |
| Pod Compilation | ❌ None | ✅ Fan compiler | MCP Fantom |
| **Language Support** | | | |
| Multi-language | ✅ 15+ languages | ❌ Fantom only | CodeGraph |

---

## Features MCP Fantom is Missing

### 1. Semantic Knowledge Graph (HIGH PRIORITY)

**What it does:** Builds a graph database of code symbols (functions, classes, methods) and their relationships (calls, imports, extends, implements).

**CodeGraph Implementation:**
- SQLite database with `nodes` and `edges` tables
- 22 node kinds: function, class, method, variable, etc.
- 12 edge kinds: calls, imports, extends, implements, etc.
- Qualified names for precise symbol identification

**Why you need it:**
- Enables "Find all callers of this function"
- Enables "What does this function call?"
- Enables "Show me the impact of changing this"
- 30% reduction in explore agent token usage

**Recommended action:** Add graph database layer to Fantom code indexer

---

### 2. Call Graph Analysis (HIGH PRIORITY)

**What it does:** Traces function call relationships bidirectionally.

**CodeGraph Tools:**
```
codegraph_callers(symbol, limit)  → What calls this function
codegraph_callees(symbol, limit)  → What this function calls
```

**Why you need it:**
- Critical for understanding code flow
- Essential for refactoring safety
- Helps identify dead code
- Enables dependency tracking

**Recommended action:** Add caller/callee resolution during AST indexing

---

### 3. Impact Analysis (HIGH PRIORITY)

**What it does:** Calculates the complete "blast radius" of changing a symbol.

**CodeGraph Tool:**
```
codegraph_impact(symbol, depth: 2) → All transitively affected code
```

**Why you need it:**
- Prevents breaking changes
- Identifies test coverage gaps
- Guides code review focus
- Essential for large codebases

**Recommended action:** Implement graph traversal (BFS/DFS) with depth limits

---

### 4. Semantic Vector Search (MEDIUM PRIORITY)

**What it does:** Searches code by meaning, not just text.

**CodeGraph Implementation:**
- Uses `@xenova/transformers` (ONNX runtime)
- Local embeddings - no external API calls
- Stores vectors in SQLite with `sqlite-vss`
- Example: "authentication" finds `login()`, `validateToken()`

**Why you need it:**
- Better search recall (naming variations)
- Natural language queries work
- Finds conceptually related code
- 100% local/private

**Recommended action:** Add optional embedding generation during indexing

---

### 5. Tree-sitter Universal Parsing (MEDIUM PRIORITY)

**What it does:** Language-agnostic AST parsing via tree-sitter grammars.

**CodeGraph Languages:**
TypeScript, JavaScript, Python, Go, Rust, Java, C#, PHP, Ruby, C, C++, Swift, Kotlin

**Why you need it:**
- Parse non-Fantom code in projects (JS, SQL, etc.)
- Consistent parsing interface across languages
- Battle-tested grammar definitions
- Fast incremental parsing

**Recommended action:** Add tree-sitter alongside Fantom parser for mixed projects

---

### 6. Git Hooks Auto-sync (MEDIUM PRIORITY)

**What it does:** Automatically updates the code index on git commits.

**CodeGraph Implementation:**
```bash
codegraph hooks install  # Adds post-commit hook
```
- Runs `codegraph sync` after each commit
- Only processes changed files (incremental)
- Zero manual re-indexing needed

**Why you need it:**
- Index stays current automatically
- No stale search results
- Reduces user friction
- Works in background

**Recommended action:** Add `mcpfantom hooks install` command

---

### 7. Context Building for AI (LOW PRIORITY)

**What it does:** Builds focused, task-specific context from the graph.

**CodeGraph Tool:**
```
codegraph_context(task: "fix checkout bug", maxNodes: 20)
```

**Why you need it:**
- Reduces token usage
- More relevant code snippets
- AI gets better context faster
- Task-aware filtering

**Current MCP Fantom approach:** FlexSearch returns all matches
**Recommended action:** Add relevance scoring based on graph centrality

---

## Features MCP Fantom Already Has (CodeGraph Missing)

| Feature | MCP Fantom Implementation |
|---------|---------------------------|
| **OAuth 2.1 Provider** | Full PKCE flow, token refresh, session management |
| **HTTP Multi-client** | StreamableHTTP transport with session isolation |
| **Admin Dashboard** | Next.js 16 with React 19, TanStack Query |
| **Backup/Restore** | ZIP archives with selective restore |
| **Code Generation** | Generate Fantom classes, methods, pods, enums |
| **Migration Tools** | SkySpark 3.x → 4.0 automated migration |
| **Workflow Guides** | 11 markdown resources via MCP |
| **Usage Analytics** | Prisma-backed tool call tracking |
| **Instance Management** | Fantom/SkySpark/Haxall instance registry |
| **Pod Compilation** | Fan compiler integration with logs |
| **6-Agent Framework** | Coordinated multi-agent architecture |
| **Documentation Parsing** | Crawls fantom.org, haxall.io |
| **Version-aware Search** | Filter by SkySpark/Haxall version |

---

## Implementation Roadmap

### Phase 1: Graph Database Foundation (2-3 weeks)
1. Add SQLite graph schema (nodes, edges tables)
2. Extend Fantom parser to emit graph nodes
3. Add reference resolution for edges
4. Create `codegraph_search` equivalent tool

### Phase 2: Call Graph Analysis (1-2 weeks)
1. Track function calls during parsing
2. Implement `getCallers(symbol)` query
3. Implement `getCallees(symbol)` query
4. Add MCP tools: `getFantomCallers`, `getFantomCallees`

### Phase 3: Impact Analysis (1 week)
1. Implement BFS/DFS graph traversal
2. Calculate transitive dependencies
3. Add `getFantomImpact(symbol, depth)` tool

### Phase 4: Git Hooks (1 week)
1. Create `mcpfantom hooks install` CLI command
2. Add post-commit hook that runs incremental sync
3. Add file change detection (content hash comparison)

### Phase 5: Semantic Search (Optional, 2 weeks)
1. Integrate `@xenova/transformers` for embeddings
2. Add `vectors` table to schema
3. Generate embeddings during indexing
4. Add semantic search fallback when text search fails

---

## Performance Comparison

| Metric | CodeGraph Claims | MCP Fantom Current |
|--------|------------------|-------------------|
| Explore tokens | 29% reduction | Baseline |
| Tool calls | 25% reduction | Baseline |
| Per-agent tokens | 37% reduction | Baseline |
| Startup time | ~1-2s (indexing) | <1s (cache load) |

---

## Technology Stack Comparison

| Component | CodeGraph | MCP Fantom |
|-----------|-----------|------------|
| Runtime | Node.js 18+ | Node.js 18+ |
| Language | TypeScript | TypeScript |
| Database | SQLite (better-sqlite3) | SQLite (Prisma) |
| Search | FTS5 + sqlite-vss | FlexSearch |
| Parsing | tree-sitter | Custom Fantom parser |
| Embeddings | @xenova/transformers | None |
| MCP SDK | @modelcontextprotocol/sdk | @modelcontextprotocol/sdk |
| CLI | Commander.js | Commander.js |
| Testing | Vitest | Jest |

---

## Conclusion

MCP Fantom has a more complete infrastructure (auth, dashboard, backup, analytics) but lacks CodeGraph's code intelligence features (knowledge graph, call analysis, impact analysis, semantic search).

**Priority recommendations:**
1. **Must have:** Graph database + call graph analysis
2. **Should have:** Impact analysis + git hooks auto-sync
3. **Nice to have:** Semantic vector search + multi-language parsing

Adding graph-based code intelligence would make MCP Fantom significantly more powerful for code exploration while retaining its domain-specific strengths for Fantom/SkySpark development.
