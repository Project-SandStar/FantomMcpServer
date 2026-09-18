# RLM Code Q&A — intelligent answers over the whole knowledge base

> Status: v1 in progress (2026-06-08). Turns the MCP server from "vector search" into a
> grounded, cited **answer** layer over code graph + vectors + change history, using a
> Reasoning LM (RLM) for synthesis.

## What "RLM" means here
**Reasoning Language Model** — the model that *synthesizes a cited answer* from retrieved
context. Provider is configurable; see model choice below. (Note: unrelated to the
"Recursive LM" inference technique that shares the acronym.)

## The stack is ~90% there
All retrieval primitives already exist and `callSidecarLlm()` can already target the
`ss-completion` sidecar. Only the *synthesis layer* + UI/MCP surface are new.
- **Retrieval:** `semanticCodeSearch` (vector → graph enrich → Qwen3-Reranker), `getCallers/Callees/CodeImpact/Neighbors` (Kuzu graph).
- **History:** `whatChangedRecently`, `getApiChangeHistory`, `getSymbolHistory`, `diffByTime`, `explainSymbolChange` over `ApiChange`/`EdgeChange`/`IndexRun` (before/after signatures + git commit/branch).
- **LLM clients:** `llmReranker` (groq/anthropic/gemini/sidecar) + `callSidecarLlm` (OpenAI-compatible `/v1/chat/completions` to any `llm`-capability sidecar).

## Architecture (June 2026 research)
Recommended end-state: **agentic tool-calling RAG** with an **Adaptive-RAG router** (cheap
classify → simple lookups one-shot, complex/temporal → agent loop over vector+graph+history),
**not** GraphRAG community summaries (stale on every reindex; graph is queryable live).
**MCP exposure = hybrid:** one server-side `ask` tool (RLM reasons, returns cited answer) +
keep retrieval primitives exposed (client-orchestration caps ~60–70% on complex flows).

### v1 (building now): reranked-RAG synthesis
```
NL question
  → semanticSearchService.search (vector → graph enrich → Qwen3-Reranker)   [top-K]
  → if temporal intent (/chang|history|when|version|breaking|migrat|deprecat/):
        also pull getApiChangeHistory / whatChangedRecently (before→after sigs)
  → assemble context (signatures, docs, file:line, caller/callee counts, diffs)
  → RLM synthesizes answer grounded ONLY in context, with inline citations
  → return { answer, citations[], usedResults[], provider, model }
```
v2 = layer an Adaptive-RAG router + multi-hop agent loop inside the same `ask` tool.

## Model choice (your actual options)
GPU on `ss-completion` is at 100%/9 GB (busy with embeddings + reranker), so synthesis there
contends with retrieval and **empirically times out / returns empty**. Provider is a **setting**;
**default = `auto`** (route by complexity, both via Groq to stay off the saturated GPU):
- **simple** → Groq `llama-3.1-8b-instant` (fast/cheap)
- **complex / multi-hop / temporal** → Groq `llama-3.3-70b-versatile` (strong reasoning)
- **sidecar `qwen3.5:9b`** stays a one-click **pinned on-prem** option (use when the GPU has headroom).
  Per-project graph DB buffer pool raised 16→64 MiB (env `FANTOM_GRAPH_DB_BUFFER_MIB`) to stop
  the "Buffer manager: buffer pool is full" error that `ask`'s retrieval hit.

| Role | Default | Alt / on-prem | Why |
|---|---|---|---|
| **Synthesis (RLM)** | Groq `llama-3.3-70b-versatile` | sidecar `qwen3.5:9b` | 70B ≫ 9B for multi-source reasoning; Groq is fast and frees the GPU. qwen3.5:9b = private/offline option. |
| **Reranker** | sidecar Qwen3-Reranker | — | lighter than synthesis; cross-encoder precision. |
| **Embeddings** | qwen3-embedding:0.6b (1024d) | jina-code-1.5B / Qwen3-Embedding-4B (future) | adequate; upgrade forces a full LanceDB re-index. |

Falls back to sidecar `qwen3.5:9b` if the configured cloud provider has no API key.

## Surface
- **MCP tool** `askCodebase(query, projectId?)` → cited answer (the common case). Primitives stay exposed for client-driven orchestration.
- **Admin** `POST /admin/vectors/ask { query, projectId?, provider?, model?, topK? }`.
- **Settings** `semanticSearch.answerSynthesis { enabled, provider, model, topK, includeHistory, maxContextChars }` (persisted + returned by GET /admin/settings).
- **Dashboard** vector-viewer: retrieval-mode dropdown (Vector-only / +Reranker / **RLM Answer**) → renders the synthesized answer + clickable citations. Config: AdvancedSearchPanel gets an "RLM Answer" toggle + provider/model/topK picker (mirrors the LLM-reranker UI).

## Caveats
- 2026 model specifics (Qwen3.5 sizes, leaderboards, VRAM) came from secondary sources — verify vs primary cards before any procurement/upgrade.
- Embedder upgrade is a corpus-wide re-index, not a hot-swap.
