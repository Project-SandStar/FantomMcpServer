/**
 * OpenAI-compatible chat-completions client targeting a sidecar's `llm`
 * capability. Used when `semanticSearch.llmReranker.fromSidecar=true`.
 *
 * The sidecar must serve an OpenAI-style `/v1/chat/completions` endpoint —
 * which is what vLLM and Ollama (with /v1 enabled) both expose. The model
 * name is whatever the sidecar advertises under `capabilities.llm.models`.
 */

import { getSidecarForCapability, sidecarServiceUrl } from '../sidecars/registry.js';

export class SidecarLlmUnavailableError extends Error {
  constructor(model?: string) {
    super(`No enabled sidecar advertises capability 'llm'${model ? ` with model '${model}'` : ''}`);
    this.name = 'SidecarLlmUnavailableError';
  }
}

export interface SidecarLlmCallOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseJsonObject?: boolean;
  timeoutMs?: number;
  /** Which sidecar capability to target. 'llm' = ss-completion (qwen3.5:9b);
   *  'rlm' = the dedicated Recursive LM (ss-rlm / rlm-qwen3-8b on port 8100). */
  capability?: 'llm' | 'rlm';
}

/**
 * Send a single user prompt to a sidecar's chat-completions endpoint and
 * return the assistant text. Throws SidecarLlmUnavailableError if no sidecar
 * is registered for the capability.
 */
export async function callSidecarLlm(
  prompt: string,
  options: SidecarLlmCallOptions = {},
): Promise<string> {
  const capability = options.capability ?? 'llm';
  const sc = getSidecarForCapability(capability, options.model);
  if (!sc) throw new SidecarLlmUnavailableError(options.model);

  const cap = sc.capabilities[capability]!;
  const model = options.model ?? cap.loaded ?? cap.models?.[0];
  if (!model) {
    throw new Error(`Sidecar ${sc.name} advertises '${capability}' but reports no models`);
  }

  const endpoint = cap.endpoint ?? '/v1/chat/completions';
  const url = `${sidecarServiceUrl(sc, capability)}${endpoint}`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (sc.authToken) headers['Authorization'] = `Bearer ${sc.authToken}`;

  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: options.temperature ?? 0,
    max_tokens: options.maxTokens ?? 4096,
  };
  if (options.responseJsonObject) body.response_format = { type: 'json_object' };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), options.timeoutMs ?? 60_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Sidecar LLM ${url} → HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    const json = await res.json() as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
    };
    const msg = json.choices?.[0]?.message;
    // Thinking models (e.g. qwen3.5) sometimes leave `content` empty and put
    // text in `reasoning_content` (or exhaust max_tokens mid-thought) — fall
    // back so the caller gets an answer instead of a blank string.
    const content = (msg?.content ?? '').trim();
    return content || (msg?.reasoning_content ?? '').trim();
  } finally {
    clearTimeout(t);
  }
}
