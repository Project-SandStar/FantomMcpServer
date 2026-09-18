import { describe, it, expect } from '@jest/globals';
import { buildQueryText, modelWantsInstruction, QUERY_TASKS } from '../embedding/queryInstruction.js';

describe('queryInstruction.buildQueryText', () => {
  it('auto + qwen3-embedding wraps the query in the exact Qwen3 format', () => {
    const r = buildQueryText('retejs', { modelId: 'qwen3-embedding:4b', target: 'code', setting: 'auto' });
    expect(r.instruction).toBe(QUERY_TASKS.code);
    expect(r.text).toBe(`Instruct: ${QUERY_TASKS.code}\nQuery: retejs`);
  });

  it('auto + non-qwen model returns the raw query', () => {
    const r = buildQueryText('retejs', { modelId: 'hf.co/jinaai/jina-code-embeddings-1.5b-GGUF:Q8_0', target: 'code', setting: 'auto' });
    expect(r.instruction).toBeNull();
    expect(r.text).toBe('retejs');
  });

  it('defaults to auto when the setting is missing', () => {
    const r = buildQueryText('q', { modelId: 'qwen3-embedding:0.6b', target: 'docs' });
    expect(r.text).toBe(`Instruct: ${QUERY_TASKS.docs}\nQuery: q`);
  });

  it('off never wraps, even for qwen3', () => {
    const r = buildQueryText('q', { modelId: 'qwen3-embedding:8b', target: 'code', setting: 'off' });
    expect(r.text).toBe('q');
    expect(r.instruction).toBeNull();
  });

  it('a custom string is used verbatim as the task for any model', () => {
    const r = buildQueryText('q', { modelId: 'Xenova/bge-small-en-v1.5', target: 'code', setting: 'Find Fantom pods' });
    expect(r.text).toBe('Instruct: Find Fantom pods\nQuery: q');
  });

  it('code and docs task texts differ', () => {
    expect(QUERY_TASKS.code).not.toBe(QUERY_TASKS.docs);
    expect(QUERY_TASKS.code).toBe('Given a code search query, retrieve relevant code snippets, functions, classes and files');
    expect(QUERY_TASKS.docs).toBe('Given a question, retrieve documentation passages that answer it');
  });

  it('modelWantsInstruction recognises Ollama tags and HF ids', () => {
    expect(modelWantsInstruction('qwen3-embedding:4b')).toBe(true);
    expect(modelWantsInstruction('Qwen/Qwen3-Embedding-8B')).toBe(true);
    expect(modelWantsInstruction('hf.co/Qwen/Qwen3-Embedding-4B-GGUF:Q8_0')).toBe(true);
    expect(modelWantsInstruction('nomic-embed-text')).toBe(false);
    expect(modelWantsInstruction(undefined)).toBe(false);
  });
});
