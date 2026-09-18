/**
 * LLM-augmented re-ranker for semantic search results.
 *
 * Provider is selected via:
 *   options.provider  (per-query override)
 *   semanticSearch.llmReranker.provider  (server default)
 *   llmProviders.defaultProvider  (top-level default)
 *
 * Keys come from process.env.{GROQ,ANTHROPIC,GEMINI}_API_KEY.
 *
 * Strategy: send the top N (default 20) candidates and ask the model to return
 * a JSON array of {nodeId, score} ordered best-first. Missing nodes keep their
 * original combinedScore. Network or parse errors fall through silently — the
 * caller still gets the graph-ranked list.
 */

import type { SemanticSearchResult } from './semanticSearchService.js';

export type LLMProviderName = 'groq' | 'anthropic' | 'gemini';

export interface LLMRerankerOptions {
  enabled: boolean;
  provider?: LLMProviderName;
  model?: string;
  topK?: number;
  /** Route to a sidecar with capability `llm` (OpenAI-compat) instead of the cloud provider. */
  fromSidecar?: boolean;
}

interface RerankItem { nodeId: string; score: number }

const DEFAULT_MODELS: Record<LLMProviderName, string> = {
  groq: 'llama-3.3-70b-versatile',
  anthropic: 'claude-sonnet-5',
  gemini: 'gemini-3.8-flash',
};

function buildPrompt(query: string, candidates: SemanticSearchResult[]): string {
  const items = candidates.map((r, i) => ({
    idx: i,
    nodeId: r.nodeId,
    name: r.qualifiedName || r.name,
    type: r.nodeType,
    signature: r.signature,
    doc: r.documentation?.slice(0, 280),
  }));
  return `You are re-ranking code search results for relevance to this query:

QUERY: ${query}

CANDIDATES (JSON):
${JSON.stringify(items, null, 2)}

Return STRICT JSON only — no prose, no markdown — of shape:
{"ranked": [{"nodeId": "<id>", "score": <0..1>}, ...]}
Higher score = more relevant. Include every nodeId from the candidates exactly once.`;
}

function parseRanked(raw: string): RerankItem[] {
  // Strip code fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const obj = JSON.parse(cleaned);
  const ranked = obj.ranked ?? obj;
  if (!Array.isArray(ranked)) throw new Error('rerank: response not an array');
  return ranked
    .filter((r: any) => r && typeof r.nodeId === 'string' && typeof r.score === 'number')
    .map((r: any) => ({ nodeId: r.nodeId, score: r.score }));
}

async function callGroq(model: string, prompt: string): Promise<string> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY not set');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`Groq HTTP ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  return json.choices?.[0]?.message?.content ?? '';
}

async function callAnthropic(model: string, prompt: string): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  return json.content?.[0]?.text ?? '';
}

async function callGemini(model: string, prompt: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' },
    }),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  return json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

export async function llmRerank(
  query: string,
  results: SemanticSearchResult[],
  options: LLMRerankerOptions,
): Promise<SemanticSearchResult[]> {
  if (!options.enabled || results.length === 0) return results;
  const provider = options.provider;
  // When fromSidecar=true, model is required (no DEFAULT_MODELS); fall back to whatever the sidecar exposes.
  const model = options.model || (provider ? DEFAULT_MODELS[provider] : undefined);
  const topK = Math.min(options.topK ?? 20, results.length);
  const candidates = results.slice(0, topK);

  const prompt = buildPrompt(query, candidates);
  let raw = '';
  try {
    if (options.fromSidecar) {
      const { callSidecarLlm } = await import('./sidecarLlmClient.js');
      raw = await callSidecarLlm(prompt, {
        model,
        responseJsonObject: true,
        temperature: 0,
      });
    } else if (provider === 'groq') {
      if (!model) throw new Error('groq rerank: model required');
      raw = await callGroq(model, prompt);
    } else if (provider === 'anthropic') {
      if (!model) throw new Error('anthropic rerank: model required');
      raw = await callAnthropic(model, prompt);
    } else if (provider === 'gemini') {
      if (!model) throw new Error('gemini rerank: model required');
      raw = await callGemini(model, prompt);
    } else {
      // Reranker enabled but no provider and not fromSidecar — bail safely.
      return results;
    }
  } catch (err) {
    console.warn(`[llmRerank] ${options.fromSidecar ? 'sidecar' : provider} failed:`, (err as Error).message);
    return results;
  }

  let ranked: RerankItem[];
  try {
    ranked = parseRanked(raw);
  } catch (err) {
    console.warn('[llmRerank] parse failed:', (err as Error).message);
    return results;
  }

  const scoreMap = new Map(ranked.map(r => [r.nodeId, r.score]));
  const reranked = candidates
    .map(r => ({
      ...r,
      llmScore: scoreMap.get(r.nodeId),
      combinedScore: scoreMap.get(r.nodeId) ?? r.combinedScore,
    }))
    .sort((a, b) => (b.combinedScore ?? 0) - (a.combinedScore ?? 0));

  // Append any results that were beyond topK, preserving their original order at the tail.
  const tail = results.slice(topK);
  return [...reranked, ...tail];
}
