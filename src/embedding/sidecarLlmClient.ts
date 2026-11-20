/**
 * OpenAI-compatible chat-completions client targeting a sidecar's `llm`
 * capability. Used when `semanticSearch.llmReranker.fromSidecar=true`.
 *
 * The sidecar must serve an OpenAI-style `/v1/chat/completions` endpoint —
 * which is what vLLM and Ollama (with /v1 enabled) both expose. The model
 * name is whatever the sidecar advertises under `capabilities.llm.models`.
 */

import { getSidecarForCapability, sidecarServiceUrl } from '../sidecars/registry.js';
import type { Sidecar } from '../admin/types.js';

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
  /**
   * Turn the model's thinking off (callSidecarChat only). Sent as Ollama's
   * native `/api/chat` with `think: false` and `options.num_predict` =
   * maxTokens, since the OpenAI-style route has no portable think switch.
   * A host without `/api/chat` (HTTP 404/405, e.g. vLLM) gets the OpenAI
   * route with `chat_template_kwargs.enable_thinking: false`.
   */
  noThink?: boolean;
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

  const out = await callSidecarChat(sc, [{ role: 'user', content: prompt }], { ...options, capability, model });
  // Thinking models (e.g. qwen3.5) sometimes leave `content` empty and put
  // text in `reasoning_content` (or exhaust max_tokens mid-thought) — fall
  // back so the caller gets an answer instead of a blank string.
  return out.content || out.reasoning;
}

export interface SidecarChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface SidecarChatResult { content: string; reasoning: string; finishReason: string | null; model: string; host: string }

/**
 * One chat call to a named sidecar host (no host choice here). Returns the
 * raw content, the reasoning text and finish_reason so a caller can decide
 * whether a reasoning-only or cut-off reply counts as a failure.
 */
export async function callSidecarChat(
  sc: Sidecar,
  messages: SidecarChatMessage[],
  options: SidecarLlmCallOptions & { model: string },
): Promise<SidecarChatResult> {
  const capability = options.capability ?? 'llm';
  const cap = sc.capabilities[capability];
  if (!cap) throw new Error(`Sidecar ${sc.name} does not advertise '${capability}'`);
  const endpoint = cap.endpoint ?? '/v1/chat/completions';
  const url = `${sidecarServiceUrl(sc, capability)}${endpoint}`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (sc.authToken) headers['Authorization'] = `Bearer ${sc.authToken}`;

  const body: Record<string, unknown> = {
    model: options.model,
    messages,
    temperature: options.temperature ?? 0,
    max_tokens: options.maxTokens ?? 4096,
  };
  if (options.responseJsonObject) body.response_format = { type: 'json_object' };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), options.timeoutMs ?? 60_000);
  try {
    if (options.noThink) {
      const nativeUrl = `${sidecarServiceUrl(sc, capability)}/api/chat`;
      const nb: Record<string, unknown> = {
        model: options.model,
        messages,
        stream: false,
        think: false,
        options: { temperature: options.temperature ?? 0, num_predict: options.maxTokens ?? 4096 },
      };
      if (options.responseJsonObject) nb.format = 'json';
      const nr = await fetch(nativeUrl, { method: 'POST', headers, body: JSON.stringify(nb), signal: ctrl.signal });
      if (nr.ok) {
        const j = await nr.json() as { model?: string; done_reason?: string | null; message?: { content?: string; thinking?: string } };
        return {
          content: (j.message?.content ?? '').trim(),
          reasoning: (j.message?.thinking ?? '').trim(),
          finishReason: j.done_reason ?? null,
          model: j.model ?? options.model,
          host: sc.name,
        };
      }
      if (nr.status !== 404 && nr.status !== 405) {
        const text = await nr.text().catch(() => '');
        throw new Error(`Sidecar LLM ${nativeUrl} → HTTP ${nr.status}: ${text.slice(0, 400)}`);
      }
      // Not Ollama: OpenAI route with the chat-template switch (vLLM / qwen).
      body.chat_template_kwargs = { enable_thinking: false };
    }
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
      model?: string;
      choices?: Array<{ finish_reason?: string | null; message?: { content?: string; reasoning_content?: string; reasoning?: string } }>;
    };
    const choice = json.choices?.[0];
    const msg = choice?.message;
    return {
      content: (msg?.content ?? '').trim(),
      reasoning: (msg?.reasoning_content ?? msg?.reasoning ?? '').trim(),
      finishReason: choice?.finish_reason ?? null,
      model: json.model ?? options.model,
      host: sc.name,
    };
  } finally {
    clearTimeout(t);
  }
}
