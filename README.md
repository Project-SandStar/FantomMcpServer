# FantomMcpServer

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI assistants a working knowledge of a **Fantom / Haxall / SkySpark** codebase — not just its documentation, but the actual code: what calls what, what changed last week, and which function does the thing you are describing in plain English.

It indexes Fantom source and Axon functions, embeds them for semantic search, builds a call graph, and exposes all of it over MCP alongside a web dashboard for running and watching the indexing.

> **Status:** 1.0.0 — first public release.

---

## What it does

**Semantic code search.** Ask *"where do we roll up point history by day and normalise by revenue"* and get the functions that implement it, not the ones that happen to contain those words. Code is chunked at syntactic boundaries, embedded, and searched by vector similarity with an optional cross-encoder rerank.

**Natural-language Q&A over the codebase.** `askCodebase` runs a retrieval loop over the index and synthesises a cited answer.

**A real call graph.** `getCallers`, `getCallees`, `getCodeImpact` and `getCodeNeighbors` answer structural questions — stored in an embedded graph database, not recomputed by grepping.

**Axon support.** SkySpark Axon functions (both synced `proj/` folders and offline library exports) are parsed with a **tree-sitter grammar**, so chunks land on statement boundaries, `defcomp` cells are surfaced as the component's interface, and comments are preserved as search signal.

**History.** `whatChangedRecently`, `getSymbolHistory`, `explainSymbolChange` and `diffIndexRuns` answer questions about how the code got this way.

**Documentation.** Fantom (`fantom.org`) and Haxall (`haxall.io`) docs are crawled and indexed, plus any local pod docs.

**SkySpark 3.x → 4.0 migration.** `migrateSkySpark4x` automates the transformation and tags a backup first; `commitMigration` / `rollbackMigration` finish or undo it.

41 MCP tools in total.

---

## Requirements

- **Node.js 20+**
- An **embedding provider** — either a local model or an OpenRouter key (see [Embedding providers](#embedding-providers))
- Optional: a running SkySpark instance for live Axon evaluation; everything else works offline

## Install

```bash
git clone https://github.com/Project-SandStar/FantomMcpServer.git
cd FantomMcpServer
npm install          # also runs prisma generate
npm run build
```

## Run

```bash
npm start            # stdio transport (Claude Desktop / CLI)
npm run start:http   # HTTP transport + dashboard on :3847
npm run dev          # stdio, tsx watch
```

### Connect an MCP client

```json
{
  "mcpServers": {
    "fantom": {
      "command": "node",
      "args": ["/absolute/path/to/FantomMcpServer/build/index.js"]
    }
  }
}
```

For HTTP mode, point the client at `http://localhost:3847/mcp`.

### Dashboard

```bash
npm run dashboard:install
npm run dashboard:build
npm run start:http
```

Then open `http://localhost:3847/dashboard/`. It shows index coverage, embedding progress, the vector and graph stores, provider routing, and per-project controls. The admin API is behind Basic Auth — **change the default credentials before exposing it.**

---

## Configuration

Runtime configuration lives in `config/fantomMcpServer-config.json`, created from the example on first start. Nothing in `config/` is version-controlled except the examples.

```bash
cp config/fantomMcpServer-config.example.json config/fantomMcpServer-config.json
cp .env.example .env
```

| Variable | Default | Purpose |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_PORT` | `3847` | HTTP port |
| `ADMIN_USER` / `ADMIN_PASS` | `admin` / `admin` | Admin API + dashboard auth — **change these** |
| `FANTOM_CODE_PATH` | — | Local `.fan` source to index |
| `AXON_PROJECT_PATH` | — | Axon server checkout (`proj/` is read from here) |
| `AXON_LIBRARY_PATH` | — | Offline Axon library root |
| `CACHE_ENABLED` | `true` | Disable to force re-crawls |

### Embedding providers

Each role (`code-embedding`, `embedding`, `reranker`, `code-assistant`, `rlm`) is routed independently by policy:

| Policy | Behaviour |
|---|---|
| `local` | Local GPU/sidecar hosts only |
| `cloud` | OpenRouter only |
| `aggregate` | Both, in one fan-out pool |
| `backup` | Local first, cloud held in reserve |

Cloud providers must pass a vector-compatibility check before they may write into a table, so a corpus is never half-built from vectors that do not match the query encoder. The query encoder always comes from the same pool that built the rows.

---

## Data it stores

All generated locally under `.cache/`, all regenerable, none of it version-controlled:

| Store | Contents |
|---|---|
| SQLite (Prisma) | projects, pods, instances, index runs |
| LanceDB | code / docs / Axon vectors |
| LadybugDB (Kuzu) | the code graph — nodes and edges |
| SQLite | usage analytics |

Delete `.cache/` to start clean; the server rebuilds on the next index run.

---

## Development

```bash
npm test             # Jest suite
npm run build        # tsc + copy workflows
npm run clean        # drop build/ and .cache/
npm run test:search  # search smoke test
```

Notes for contributors:

- Source files are kept under ~25k tokens so they stay readable in one pass.
- `src/admin/routes.ts` is large — read it with an offset.
- The Axon tree-sitter grammar source is in `tree-sitter-axon/`; the compiled grammar ships in `assets/grammars/`.

### Layout

```
src/
  index.ts          MCP server (stdio + HTTP)
  admin/            admin REST API
  axon/             Axon parsing, indexing, search
  embedding/        providers, routing, vector stores
  graph/            LadybugDB code graph
  fantom-parser/    Fantom tokenizer and parser
  migration/        SkySpark 3.x → 4.0
  parser/           documentation crawlers
  search/           FlexSearch index
dashboard/          Next.js admin UI
assets/grammars/    compiled tree-sitter grammars
workflows/          markdown guides served as MCP resources
```

---

## Security

- `config/` and `.env` are git-ignored; only `*.example.json` and `.env.example` are tracked.
- The admin API ships with `admin`/`admin`. Change it before binding to anything but localhost.
- Indexed source and embeddings stay in `.cache/` on your machine. Nothing is uploaded unless you configure a cloud provider, in which case code chunks are sent to that provider for embedding.

## License

[Project Sandstar Source-Available License (PSSL) v1.1](LICENSE).

## Links

- [Model Context Protocol](https://modelcontextprotocol.io)
- [Fantom](https://fantom.org) · [Haxall](https://haxall.io) · [SkySpark](https://skyfoundry.com)
