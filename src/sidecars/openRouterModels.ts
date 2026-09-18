/**
 * OpenRouter model catalogue for Fantom's three roles.
 *
 * It is hand-maintained because it cannot be discovered: `GET /api/v1/models`
 * returns chat models and ZERO embedding or rerank models, and there is no
 * `/api/v1/rerank/models` endpoint (it 404s). So a dropdown has to be fed from
 * a curated list or from nothing.
 *
 * `pinProvider` is INTERNAL. It is never rendered — the operator does not want
 * provider names in the UI — but it must not be removed: the
 * vector-compatibility gate pins embedding calls to one upstream because two
 * providers serving one model slug do not guarantee identical vectors, and a
 * silent reroute splits one logical vector space in two. Hidden, not gone.
 *
 * `dropInFor` is the operationally important field. Swapping a role to a model
 * whose width differs from the existing table forces a full re-index of every
 * project; the hint under each dropdown says so at the point of choice, which
 * is the only place it can still prevent the mistake.
 */

export type FantomRole = 'code-embedding' | 'embedding' | 'reranker' | 'code-assistant' | 'rlm';

export interface CatalogueModel {
  id: string;
  label: string;
  /** Output width. Undefined for rerankers, which produce scores. */
  dims?: number;
  contextTokens: number;
  /** Trained for code retrieval, not just prose. Filters the code dropdown. */
  codeCapable: boolean;
  /** The local model this matches, where one exists. */
  localCounterpart?: string;
  /** INTERNAL — the upstream embedding calls pin to. Never rendered. */
  pinProvider?: string;
  /** Roles whose EXISTING table this is a width-exact drop-in for. */
  dropInFor?: Array<'embedding' | 'code-embedding'>;
  /** Chat models only: can it call tools? */
  tools?: boolean;
  /**
   * Chat models only: does it support reasoning?
   *
   * This is the `code-assistant` analogue of `dims` — the flag that decides
   * whether a choice quietly degrades something. askCodebase is a
   * plan -> gather -> synthesise loop with tool calls across several rounds,
   * and a model without reasoning support is a weaker fit for it. Every Qwen
   * coder variant and devstral report tools:true, reasoning:false, so the
   * explicitly-requested model is on the wrong side of this line and the
   * label has to say so.
   */
  reasoning?: boolean;
  /** USD per million INPUT tokens. */
  priceIn?: number;
  /** USD per million OUTPUT tokens. */
  priceOut?: number;
}

/**
 * The LOCAL counterpart each role runs today, and therefore the width its
 * existing table is committed to. A hosted model that does not match forces a
 * full re-index of every project, which is the single most expensive mistake
 * this page can let someone make in one click.
 */
export const ROLE_LOCAL: Record<FantomRole, { model: string; dims?: number; label: string }> = {
  'code-embedding': { model: 'qwen3-embedding:4b', dims: 2560, label: 'Code embedding (ss-code-embedding)' },
  'embedding': { model: 'qwen3-embedding:0.6b', dims: 1024, label: 'Text embedding (ss-embedding)' },
  'reranker': { model: 'Qwen/Qwen3-Reranker-8B', label: 'Reranker' },
  // No local counterpart: Fantom has no local chat model for this role, which
  // is part of why it is not servable yet.
  'code-assistant': { model: 'none', label: 'Code assistant' },
  // The local counterpart is a whole sidecar role (`ss-rlm`, the
  // mit-oasys/rlm-qwen3-8b fine-tune on :8100), not an Ollama tag — which is
  // why this role's policy is about WHICH ENDPOINT runs the recursive session
  // rather than which model produces a vector.
  'rlm': { model: 'ss-rlm (rlm-qwen3-8b)', label: 'RLM — recursive code Q&A' },
};

/** Fantom's `code_vectors` table today: qwen3-embedding:4b at 2560d. */
export const CODE_TABLE_DIMS = 2560;

export const EMBEDDING_CATALOGUE: CatalogueModel[] = [
  {
    id: 'qwen/qwen3-embedding-4b',
    label: 'Qwen3 Embedding 4B',
    dims: 2560,
    contextTokens: 32_768,
    codeCapable: true,
    localCounterpart: 'qwen3-embedding:4b',
    pinProvider: 'DeepInfra',
    // The only width-exact drop-in for the live 2560d code table.
    dropInFor: ['code-embedding'],
  },
  {
    id: 'qwen/qwen3-embedding-8b',
    label: 'Qwen3 Embedding 8B',
    dims: 4096,
    contextTokens: 32_768,
    codeCapable: true,
    localCounterpart: 'qwen3-embedding:8b',
    pinProvider: 'DeepInfra',
  },
  {
    id: 'openai/text-embedding-3-small',
    label: 'OpenAI text-embedding-3-small',
    dims: 1536,
    contextTokens: 8_191,
    codeCapable: false,
    pinProvider: 'OpenAI',
  },
  {
    id: 'openai/text-embedding-3-large',
    label: 'OpenAI text-embedding-3-large',
    dims: 3072,
    contextTokens: 8_191,
    codeCapable: false,
    pinProvider: 'OpenAI',
  },
  {
    id: 'google/gemini-embedding-001',
    label: 'Google Gemini Embedding 001',
    dims: 3072,
    contextTokens: 2_048,
    codeCapable: false,
    pinProvider: 'Google',
  },
];

/**
 * 8B is the only reranker size on OpenRouter with a provider actually serving
 * it, and it is what the Sound Suite master slot already pins here — so it is
 * proven in this environment rather than merely listed.
 */
export const RERANK_CATALOGUE: CatalogueModel[] = [
  {
    id: 'qwen/qwen3-reranker-8b',
    label: 'Qwen3 Reranker 8B',
    contextTokens: 40_960,
    codeCapable: true,
    localCounterpart: 'Qwen/Qwen3-Reranker-8B',
    pinProvider: 'Fireworks',
  },
];

/**
 * Chat models for the `code-assistant` role. Verified live against
 * `GET /api/v1/models` on 2026-09-15.
 *
 * WHY THE DEFAULT IS NOT THE REQUESTED MODEL. Fantom and Axon are not in any
 * model's training data, so code specialisation buys much less here than it
 * would on Python or TypeScript — long context and in-context learning matter
 * more (see docs/reports/coder-llms-for-obscure-languages-2026-09-15.md).
 * `laguna-s-2.1` has four times the context of `qwen3-coder`, supports
 * reasoning, and costs a third of the price per input token. `qwen3-coder` is
 * listed because it was asked for, and it is one click away.
 */
export const CHAT_CATALOGUE: CatalogueModel[] = [
  {
    id: 'poolside/laguna-s-2.1',
    label: 'Laguna S 2.1',
    contextTokens: 1_050_000,
    codeCapable: true,
    tools: true,
    reasoning: true,
    priceIn: 0.09,
    priceOut: 0.18,
  },
  {
    id: 'poolside/laguna-s-2.1:free',
    label: 'Laguna S 2.1 (free tier)',
    contextTokens: 262_000,
    codeCapable: true,
    tools: true,
    reasoning: true,
    priceIn: 0,
    priceOut: 0,
  },
  {
    id: 'deepseek/deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    contextTokens: 1_050_000,
    codeCapable: true,
    tools: true,
    reasoning: true,
    priceIn: 0.09,
    priceOut: 0.17,
  },
  {
    id: 'qwen/qwen3-coder',
    label: 'Qwen3 Coder',
    contextTokens: 262_000,
    codeCapable: true,
    tools: true,
    reasoning: false,
    priceIn: 0.30,
    priceOut: 1.00,
  },
  {
    id: 'qwen/qwen3-coder-plus',
    label: 'Qwen3 Coder Plus',
    contextTokens: 1_000_000,
    codeCapable: true,
    tools: true,
    reasoning: false,
    priceIn: 0.65,
    priceOut: 3.25,
  },
  {
    id: 'mistralai/devstral-2512',
    label: 'Devstral 2512',
    contextTokens: 262_000,
    codeCapable: true,
    tools: true,
    reasoning: false,
    priceIn: 0.40,
    priceOut: 2.00,
  },
  {
    id: 'openai/gpt-5.1-codex',
    label: 'GPT-5.1 Codex',
    contextTokens: 400_000,
    codeCapable: true,
    tools: true,
    reasoning: true,
    priceIn: 1.25,
    priceOut: 10.00,
  },
  {
    id: 'google/gemini-3.6-flash',
    label: 'Gemini 3.6 Flash',
    contextTokens: 1_050_000,
    codeCapable: true,
    tools: true,
    reasoning: true,
    priceIn: 0.75,
    priceOut: 3.75,
  },
];

export const DEFAULT_CODE_ASSISTANT_MODEL = 'poolside/laguna-s-2.1';

/**
 * ── RLM sandbox fallback ──────────────────────────────────────────────────
 *
 * `ss-rlm-sandbox` is the hosted REPL that runs the Recursive LM loop when no
 * `ss-rlm` sidecar is available. The loop is multi-round evidence gathering —
 * plan, call a tool, read the result, decide what to ask next — so the model
 * must support BOTH tool calling and reasoning. That is a hard filter, not a
 * preference: a tools-only model tends to answer after one round instead of
 * converging, which looks like a weak answer rather than a misconfiguration.
 *
 * Drawn from CHAT_CATALOGUE rather than a second list, so a model added for
 * the code assistant becomes eligible here automatically and the two cannot
 * describe the same model differently.
 *
 * Sound Suite's equivalent picker offers 292 models because its page fetches
 * `/api/v1/models` live and filters the result. Fantom's catalogue is
 * hand-maintained (embedding and rerank models are not discoverable at all —
 * see the module header), so this is the curated subset. The setting is
 * per-master: Fantom stores its own choice and Sound Suite stores its own,
 * on the same sidecar fleet, and neither overwrites the other.
 */
export const RLM_CATALOGUE: CatalogueModel[] = CHAT_CATALOGUE.filter(m => m.tools && m.reasoning);

/**
 * Not `poolside/laguna-s-2.1`, which matches on price and capability but is
 * served by a single upstream — the same single-provider exposure that took
 * two Qwen rerankers dark. DeepSeek V4 Flash has 17.
 */
export const DEFAULT_RLM_SANDBOX_MODEL = 'deepseek/deepseek-v4-flash';

export type RlmFallbackMode = 'local-only' | 'local-first';

export const RLM_FALLBACK_MODES: Array<{ id: RlmFallbackMode; label: string }> = [
  { id: 'local-only', label: 'Local only (default) — no ss-rlm sidecar means no RLM' },
  { id: 'local-first', label: 'Allow sandbox fallback — use ss-rlm-sandbox when ss-rlm is unavailable' },
];

export const DEFAULT_RLM_FALLBACK_MODE: RlmFallbackMode = 'local-only';

export function isRlmFallbackMode(v: unknown): v is RlmFallbackMode {
  return v === 'local-only' || v === 'local-first';
}

/** Is this a model the RLM loop can actually drive? */
export function isRlmCapable(id: string): boolean {
  return RLM_CATALOGUE.some(m => m.id === id);
}

/** "<Label> · <ctx> · $<in>/M in" — price matters here in a way it does not
 *  for an embedder, because the RLM loop makes several calls per question. */
export function rlmOptionLabel(m: CatalogueModel): string {
  const parts = [m.label, `${fmtContext(m.contextTokens)} ctx`];
  if (m.priceIn !== undefined) parts.push(`$${m.priceIn.toFixed(2)}/M in`);
  return parts.join(' · ');
}

export function catalogueFor(role: FantomRole): CatalogueModel[] {
  // The sandbox drives a multi-round tool-use loop, so the same hard
  // tools+reasoning filter the RLM picker uses applies to the role's model.
  if (role === 'rlm') return RLM_CATALOGUE;
  if (role === 'code-assistant') return CHAT_CATALOGUE;
  if (role === 'reranker') return RERANK_CATALOGUE;
  // The code role only offers models trained for code retrieval. A
  // general-purpose text embedder will "work" on code and quietly retrieve
  // worse, which is the kind of regression nobody attributes to a dropdown.
  if (role === 'code-embedding') return EMBEDDING_CATALOGUE.filter(m => m.codeCapable);
  return EMBEDDING_CATALOGUE;
}

export function findModel(id: string): CatalogueModel | undefined {
  return [...EMBEDDING_CATALOGUE, ...RERANK_CATALOGUE, ...CHAT_CATALOGUE].find(m => m.id === id);
}

/** "1.05M" / "262K" — context is the headline number for a chat model the way
 *  dims are for an embedder. */
export function fmtContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  return `${Math.round(tokens / 1000)}K`;
}

/** The upstream to pin embedding calls to. INTERNAL; never rendered. */
export function pinFor(id: string): string | undefined {
  return findModel(id)?.pinProvider;
}

/**
 * Dropdown option text: "<Label> · <dims>d", plus "· drop-in" when the width
 * matches this role's existing table and "· text-only" when the model is not
 * trained for code retrieval.
 *
 * Note what is NOT here: the pinned provider. The pin still exists and the
 * compatibility gate still uses it — it just has no business being a thing
 * the operator has to reason about while picking a model.
 */
export function optionLabel(role: FantomRole, m: CatalogueModel): string {
  if (role === 'rlm') return rlmOptionLabel(m);
  if (role === 'code-assistant') {
    // Context and the reasoning flag, for the same reason the embedders show
    // dims: they are the two properties that decide whether a choice quietly
    // degrades the thing that consumes it.
    return [
      m.label,
      `${fmtContext(m.contextTokens)} ctx`,
      m.reasoning ? 'tools + reasoning' : 'tools only',
    ].join(' · ');
  }
  const parts: string[] = [m.label];
  if (m.dims !== undefined) parts.push(`${m.dims}d`);
  const local = ROLE_LOCAL[role];
  if (m.dims !== undefined && local.dims !== undefined && m.dims === local.dims) parts.push('drop-in');
  if (!m.codeCapable) parts.push('text-only');
  return parts.join(' · ');
}

/**
 * The line under each picker. It names the local model and its width, then
 * says whether anything on offer matches — and therefore whether choosing
 * from this list costs a full re-index.
 */
export function modelHint(role: FantomRole): string {
  if (role === 'rlm') {
    return 'Which endpoint runs the recursive session. "SideCar only" uses ss-rlm '
      + '(rlm-qwen3-8b on :8100) and nothing else; "OpenRouter only" always uses the hosted '
      + 'ss-rlm-sandbox and never probes for ss-rlm; "as backup" uses the sandbox only when no '
      + 'sidecar is running ss-rlm. A model is required in every case — without one the sandbox '
      + 'is skipped, and under "OpenRouter only" that means RLM is off rather than silently '
      + 'reverting to ss-rlm.';
  }
  if (role === 'code-assistant') {
    return 'askCodebase plans, gathers and synthesises over several rounds of tool calls, so a model '
      + 'marked "tools only" — no reasoning support — is a weaker fit and will give shallower answers. '
      + 'Fantom and Axon are in no model\'s training data, so long context matters more here than code '
      + 'specialisation does.';
  }
  const local = ROLE_LOCAL[role];
  if (role === 'reranker') {
    return `Local: ${local.model} on gpu-01. Rerank is stateless — changing it never requires a re-index.`;
  }
  const options = catalogueFor(role);
  const matches = options.filter(m => m.dims === local.dims);
  const head = `Local: ${local.model} (${local.dims}d).`;
  if (matches.length === 0) {
    return `${head} No hosted model matches that width — switching means a full re-index.`;
  }
  const names = matches.map(m => m.label.replace(/^Qwen3 Embedding /, '')).join(' and ');
  return `${head} The ${names} below matches that width exactly — no re-index.`;
}
