/**
 * One chat completion on OpenRouter, called by Fantom itself (2026-11-19).
 *
 * Before, this went through a sidecar's `/api/v1/chat/completions` proxy
 * (~1.8 s per call; 0.45 s direct for the same model). The signature is
 * unchanged for the callers: answer synthesis, the contextualiser, the
 * workflow optimiser and the Test button.
 *
 * Model: the same one the sidecar used to pick for us, the RLM sandbox model
 * (an OpenRouter id; a `direct:` model maps to the default sandbox model).
 * A caller may pass `model` to override it.
 *
 * Lane: `bulk` work (contextualiser) waits for a worker; everything else is
 * interactive and never waits behind a re-embed.
 */
import { chat } from '../openrouter/client.js';
import { openRouterPool, type Lane } from '../openrouter/workerPool.js';
import { sandboxModelForPush, DEFAULT_SANDBOX_MODEL } from './sandboxSlots.js';

export class OpenRouterChatUnavailable extends Error {
  readonly code = 'openrouter-chat-unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'OpenRouterChatUnavailable';
  }
}

export interface OpenRouterChatResult {
  text: string;
  /** The model that answered. */
  model: string;
  /** USD for this call, as OpenRouter reported it. Null when not returned. */
  costUsd: number | null;
  servedBy: string;
}

const DEFAULT_TIMEOUT_MS = 90_000;

export async function openRouterChat(
  system: string,
  user: string,
  opts: {
    maxTokens?: number;
    timeoutMs?: number;
    temperature?: number;
    reasoning?: boolean;
    /** Kept for callers; hosts no longer matter (no sidecar hop). */
    role?: string;
    model?: string;
    lane?: Lane;
    projectId?: number;
  } = {},
): Promise<OpenRouterChatResult> {
  const model = opts.model ?? sandboxModelForPush() ?? DEFAULT_SANDBOX_MODEL;
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  let maxTokens = opts.maxTokens ?? 1024;
  const run = async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const out = await chat(messages, {
        role: 'code-assistant',
        model,
        maxTokens,
        temperature: opts.temperature,
        reasoning: opts.reasoning,
        timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      // A thinking model can spend max_tokens on reasoning and return no
      // content (finish_reason "length"): retry once with twice the room.
      if (!out.text.trim() && out.finishReason === 'length' && attempt === 0) {
        console.warn(`[openrouter-chat] ${model}: hit max_tokens=${maxTokens} with no content; retrying with ${maxTokens * 2}`);
        maxTokens *= 2;
        continue;
      }
      return out;
    }
    throw new OpenRouterChatUnavailable(`${model} returned no content`);
  };
  try {
    const out = await openRouterPool().submit({
      role: 'code-assistant', lane: opts.lane ?? 'interactive', projectId: opts.projectId, run,
    });
    if (!out.text.trim()) {
      throw new OpenRouterChatUnavailable(`empty completion from ${out.model} (finish_reason=${out.finishReason ?? '?'})`);
    }
    return { text: out.text, model: out.model, costUsd: out.costUsd, servedBy: 'fantom' };
  } catch (err) {
    if (err instanceof OpenRouterChatUnavailable) throw err;
    throw new OpenRouterChatUnavailable((err as Error).message);
  }
}
