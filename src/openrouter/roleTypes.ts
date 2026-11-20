/** OpenRouter role names and wire modes. No imports, so any module can use them. */
export type VirtualRole = 'embedding' | 'code-embedding' | 'reranker' | 'code-assistant' | 'rlm';
export const VIRTUAL_ROLES: VirtualRole[] = ['embedding', 'code-embedding', 'reranker', 'code-assistant', 'rlm'];
export type VirtualRoutingMode = 'local-only' | 'local-first' | 'cloud-only';
export const VIRTUAL_ROUTING_MODES: VirtualRoutingMode[] = ['local-only', 'local-first', 'cloud-only'];
export const DEFAULT_OR_RERANK_MODEL = 'qwen/qwen3-reranker-8b';
