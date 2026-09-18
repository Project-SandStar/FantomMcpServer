/**
 * Query-side instruction for instruction-tuned embedding models.
 *
 * Qwen3-Embedding is trained to receive an instruction on the QUERY only, in
 * exactly this format:
 *
 *     Instruct: {task}\nQuery: {query}
 *
 * Documents are embedded WITHOUT an instruction, so nothing here touches the
 * embed-batch / buildCodeEmbeddingText path — stored vectors stay valid and no
 * re-embed is needed. Only the search-time query is wrapped.
 *
 * Setting: `semanticSearch.queryInstruction`
 *   'auto'  (default) — wrap only when the active model id starts with
 *                       'qwen3-embedding' (Ollama tag) or is a Qwen3-Embedding
 *                       HF id; other models get the raw query.
 *   'off'             — never wrap.
 *   any other string  — use it verbatim as the task text for every model.
 */

import { readRuntimeSemantic } from './providers/embeddingProvider.js';

export type QueryInstructionTarget = 'code' | 'docs';
export type QueryInstructionSetting = 'auto' | 'off' | string;

export const QUERY_TASKS: Record<QueryInstructionTarget, string> = {
  code: 'Given a code search query, retrieve relevant code snippets, functions, classes and files',
  docs: 'Given a question, retrieve documentation passages that answer it',
};

/** Models that were trained with a query-side instruction. */
export function modelWantsInstruction(modelId: string | undefined | null): boolean {
  if (!modelId) return false;
  const m = modelId.toLowerCase();
  // "qwen3-embedding:4b", "qwen3-embedding:0.6b", "Qwen/Qwen3-Embedding-8B",
  // "hf.co/Qwen/Qwen3-Embedding-4B-GGUF:Q8_0"
  return m.startsWith('qwen3-embedding') || m.includes('/qwen3-embedding');
}

export interface BuildQueryTextOptions {
  modelId: string | undefined | null;
  target: QueryInstructionTarget;
  setting?: QueryInstructionSetting | null;
}

/** Pure: decide the instruction and format the query. */
export function buildQueryText(
  query: string,
  { modelId, target, setting }: BuildQueryTextOptions,
): { text: string; instruction: string | null } {
  const mode = (setting ?? 'auto').trim();
  if (mode === 'off') return { text: query, instruction: null };
  let instruction: string | null = null;
  if (mode === 'auto' || mode === '') {
    if (modelWantsInstruction(modelId)) instruction = QUERY_TASKS[target];
  } else {
    instruction = mode; // custom task text, used for every model
  }
  if (!instruction) return { text: query, instruction: null };
  return { text: `Instruct: ${instruction}\nQuery: ${query}`, instruction };
}

export function readQueryInstructionSetting(): QueryInstructionSetting {
  const v = readRuntimeSemantic()?.queryInstruction;
  return typeof v === 'string' && v.trim() ? v : 'auto';
}

// Log once per process per (target, model, instruction) so the active mode is
// visible in the server log without spamming every query.
const logged = new Set<string>();

/**
 * Wrap `query` for the active model according to the runtime setting.
 * Returns the text to embed (the raw query when no instruction applies).
 */
export function applyQueryInstruction(
  query: string,
  modelId: string | undefined | null,
  target: QueryInstructionTarget,
): string {
  const setting = readQueryInstructionSetting();
  const { text, instruction } = buildQueryText(query, { modelId, target, setting });
  const key = `${target}|${modelId ?? '?'}|${instruction ?? '-'}`;
  if (!logged.has(key)) {
    logged.add(key);
    if (instruction) {
      console.log(`[query-instruction] ${target} model=${modelId} setting=${setting} instruction="${instruction}"`);
    } else {
      console.log(`[query-instruction] ${target} model=${modelId} setting=${setting} — no instruction applied`);
    }
  }
  return text;
}
