import type { LLMProviderName } from './api';

export interface ModelOption {
  id: string;
  label: string;
  family?: string;
  recommended?: boolean;
}

export const PROVIDER_MODELS: Record<LLMProviderName, ModelOption[]> = {
  anthropic: [
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', family: 'fable', recommended: true },
    { id: 'claude-opus-5', label: 'Claude Opus 5', family: 'opus' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', family: 'sonnet' },
  ],
  groq: [
    { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile', family: 'llama', recommended: true },
    { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant', family: 'llama' },
    { id: 'openai/gpt-oss-120b', label: 'GPT OSS 120B', family: 'gpt-oss' },
    { id: 'openai/gpt-oss-20b', label: 'GPT OSS 20B', family: 'gpt-oss' },
    { id: 'groq/compound', label: 'Groq Compound (agentic)', family: 'compound' },
    { id: 'groq/compound-mini', label: 'Groq Compound Mini', family: 'compound' },
    { id: 'meta-llama/llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout 17B (preview)', family: 'llama' },
  ],
  gemini: [
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', family: 'gemini-3.8', recommended: true },
    { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', family: 'gemini-3.7' },
    { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', family: 'gemini-3.5' },
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)', family: 'gemini-3.1' },
  ],
};

export const DEFAULT_PROVIDER_MODELS: Record<LLMProviderName, string> = {
  anthropic: PROVIDER_MODELS.anthropic.find(m => m.recommended)!.id,
  groq: PROVIDER_MODELS.groq.find(m => m.recommended)!.id,
  gemini: PROVIDER_MODELS.gemini.find(m => m.recommended)!.id,
};

export interface RerankerOption {
  id: string;
  label: string;
  source: 'sidecar' | 'cloud';
  recommended?: boolean;
  notes?: string;
}

// Sidecar models are served by vLLM (vllm/vllm-openai) under their HF names.
// The user's reranker sidecar runs Qwen/Qwen3-Reranker-8B as `ss-reranker`.
export const RERANKER_MODELS: RerankerOption[] = [
  { id: 'Qwen/Qwen3-Reranker-8B', label: 'Qwen3 Reranker 8B (vLLM)', source: 'sidecar', recommended: true, notes: 'Pairs with qwen3-embedding' },
  { id: 'Qwen/Qwen3-Reranker-4B', label: 'Qwen3 Reranker 4B (vLLM)', source: 'sidecar' },
  { id: 'Qwen/Qwen3-Reranker-0.6B', label: 'Qwen3 Reranker 0.6B (vLLM)', source: 'sidecar' },
  { id: 'BAAI/bge-reranker-v2-m3', label: 'bge-reranker-v2-m3 (600M, multilingual)', source: 'sidecar' },
  { id: 'jinaai/jina-reranker-v2-base-multilingual', label: 'jina-reranker-v2-base-multilingual (270M)', source: 'sidecar' },
  { id: 'mixedbread-ai/mxbai-rerank-large-v2', label: 'mxbai-rerank-large-v2 (560M)', source: 'sidecar' },
];
