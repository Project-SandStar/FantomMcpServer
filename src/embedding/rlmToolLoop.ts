/**
 * Recursive RLM tool-use loop for mcpfantom.
 *
 * The dedicated RLM (ss-rlm, mit-oasys/rlm-qwen3-8b, vLLM OpenAI-compatible on
 * port 8100) iteratively calls code-search tools to gather the exact code
 * needed to answer a question, then hands the gathered evidence + a brief draft
 * back to the caller. GROQ (in answerSynthesis) synthesizes the final cited
 * answer from the seed context PLUS this gathered evidence.
 *
 * Ported from court-lens-mcp/src/lib/ai/stream-rlm.ts `runRlmWithTools` +
 * its context-budgeting and fallback-tool-call parser, with these deltas:
 *   - NON-streaming: read choices[0].message; no SSE re-POST on the final turn.
 *   - NON-generator: returns one result object; no event yields.
 *   - Discovery via mcpfantom's sidecar registry (NOT court-lens fleet-router).
 *   - Context window read dynamically from /v1/models (default 40960).
 *   - Any endpoint error → return null (caller falls back); never throws.
 */

import { getSidecarForCapability, sidecarServiceUrl } from '../sidecars/registry.js';
import { rlmToolsToken } from '../admin/rlmToolRoutes.js';
import {
  buildPlanPrompt,
  mergeEvidence,
  parsePlanJson,
  runWithConcurrency,
  splitEvidenceBlocks,
  stripRlmTemplate,
  type RlmPlan,
} from './rlmGatherPlan.js';

export { stripRlmTemplate, parsePlanJson } from './rlmGatherPlan.js';

// ──────────────────────────────────────────────────────────────────────────
// Types (ported verbatim)
// ──────────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface RlmToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Context budgeting — vLLM rejects requests where prompt_tokens + max_tokens >
// max_model_len. The tool-use loop accumulates chunk-sized tool results across
// rounds, easily crossing the ceiling. We defend each round by clamping
// max_tokens to fit the context window, trimming oldest history if needed.
// The context window is read once from the deployed model (/v1/models).
// ──────────────────────────────────────────────────────────────────────────
export const DEFAULT_CONTEXT_TOKENS = 40960;
export const TOKEN_CHAR_RATIO = 3.2;
export const SAFETY_MARGIN_TOKENS = 256;
export const MIN_OUTPUT_TOKENS = 768;

export function estimateInputTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content?.length ?? 0;
    const tc = (m as any).tool_calls;
    if (Array.isArray(tc)) {
      for (const c of tc) {
        try {
          chars += JSON.stringify(c).length;
        } catch {
          /* defensive — circular refs shouldn't happen here */
        }
      }
    }
  }
  return Math.ceil(chars / TOKEN_CHAR_RATIO);
}

export function clampOutputTokens(
  messages: ChatMessage[],
  requested: number,
  contextTokens: number,
): { maxTokens: number; clamped: boolean; estimatedInput: number } {
  const estimatedInput = estimateInputTokens(messages);
  const budget = contextTokens - estimatedInput - SAFETY_MARGIN_TOKENS;
  if (budget < MIN_OUTPUT_TOKENS) {
    return { maxTokens: MIN_OUTPUT_TOKENS, clamped: true, estimatedInput };
  }
  if (budget < requested) {
    return { maxTokens: budget, clamped: true, estimatedInput };
  }
  return { maxTokens: requested, clamped: false, estimatedInput };
}

/**
 * When estimatedInput + MIN_OUTPUT_TOKENS doesn't fit even after clamping,
 * trim the oldest assistant message and its trailing tool messages.
 * Preserves messages[0] (system) and messages[1] (the initial user turn).
 * Returns the number of messages removed.
 */
export function trimHistoryToFit(messages: ChatMessage[], contextTokens: number): number {
  let removed = 0;
  while (true) {
    const estimatedInput = estimateInputTokens(messages);
    if (estimatedInput + MIN_OUTPUT_TOKENS + SAFETY_MARGIN_TOKENS <= contextTokens) break;
    let assistantIdx = -1;
    for (let i = 2; i < messages.length - 1; i++) {
      if (messages[i].role === 'assistant') {
        assistantIdx = i;
        break;
      }
    }
    if (assistantIdx < 0) break; // nothing safe to remove
    let count = 1;
    while (
      assistantIdx + count < messages.length &&
      messages[assistantIdx + count].role === 'tool'
    ) {
      count++;
    }
    messages.splice(assistantIdx, count);
    removed += count;
  }
  return removed;
}

// ──────────────────────────────────────────────────────────────────────────
// Main entry — non-streaming, non-generator gather loop.
//
// Stages:
//   PLAN    one model call decomposes the question into 2–4 focused
//           sub-questions, each tagged search_code / search_symbols.
//   GATHER  the sub-question searches run in parallel (≤4 in flight); hits
//           are deduped by qualifiedName+location and bounded in chars.
//   COMBINE the tool-calling rounds start from the combined evidence so the
//           model can issue one or two follow-up searches, then draft.
// An overall deadline (default 75 s) spans all three; on expiry we return
// whatever was gathered instead of throwing.
// ──────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  'You are a code-investigation agent. Use the provided tools to gather the ' +
  'exact code needed to answer the question, then answer briefly and concretely, ' +
  'grounded in the code you found.\n\n' +
  'SEARCH STRATEGY — this matters more than anything else:\n' +
  '1. DECOMPOSE the question into its atomic concepts. Do NOT paste the whole ' +
  'question into a search. For "how does X load from Y", the concept is ' +
  '"load from Y" — search that, not the sentence.\n' +
  '2. Keep search_code queries SHORT and focused: 2–5 content words, one ' +
  'concept per query (e.g. "load from sax", "parse component xml"). Issue ' +
  'SEPARATE searches for separate concepts. Never use "A or B" disjunctions — ' +
  'split them into two searches.\n' +
  '3. If a likely function/identifier name is implied (e.g. loading-from-sax ' +
  '⇒ a function named "loadFromSax"/"parseSax"), ALSO call search_symbols with ' +
  'the bare identifier. Put file extensions and exact tokens like "app.sax" ' +
  'into search_symbols, NOT search_code.\n' +
  '3b. When the question names a library, framework, directory or file (e.g. ' +
  '"retejs", "sox"), call search_files with that bare word: it lists the files ' +
  'under that name and the functions/types they define, even when no symbol ' +
  'contains the word. Then search_symbols the interesting symbols it lists.\n' +
  '4. If a query returns nothing useful, REPHRASE shorter or differently next ' +
  'round rather than repeating it. Follow callers/callees and read source ' +
  'before answering. Use project_overview only for orientation.\n' +
  '5. ALWAYS begin by searching — never answer from the seed context alone. The ' +
  'seed is a weak first pass; issue at least one focused search before you ' +
  'conclude, even if the seed looks sufficient.\n' +
  'When you have enough evidence, stop calling tools and give the answer.';

export const DEFAULT_DEADLINE_MS = 75000;
export const DEFAULT_MAX_ROUNDS = 3;
export const DEFAULT_MAX_EVIDENCE_CHARS = 16000;
export const GATHER_CONCURRENCY = 4;
/** Skip a further model round when less than this remains on the deadline. */
const MIN_ROUND_BUDGET_MS = 4000;

/** One line of the live "thinking" feed — see askEvents.ts. */
export interface RlmEvent {
  kind: 'plan' | 'round' | 'ask' | 'answer' | 'thought' | 'done';
  text: string;
  id?: string;
  detail?: string;
  items?: string[];
  ms?: number;
  /** ms since the gather started */
  t: number;
}

export interface RlmGatherOptions {
  question: string;
  /** Receives every question the RLM asks and what came back, as it happens. */
  onEvent?: (e: RlmEvent) => void;
  seedContext: string;
  projectId?: number;
  tools: RlmToolSpec[];
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** Follow-up tool-calling rounds after the parallel gather (default 3). */
  maxRounds?: number;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Overall budget for plan + gather + rounds (default 75 s). */
  deadlineMs?: number;
  /** Set false to skip the PLAN stage (legacy single-question behaviour). */
  plan?: boolean;
  /** Structured description of the projects in scope (primary + related, their
   *  languages and libraries); shown to the planner so sub-questions target the
   *  project that actually holds a library or UI concept. */
  scopeNote?: string;
  /** Sub-questions the caller derived deterministically (e.g. a library named
   *  in the question that a scope project lists → search_files). Merged into
   *  the plan ahead of the model's own sub-questions, deduped by tool+query. */
  extraSubQuestions?: RlmPlan['subQuestions'];
  /** Upper bound on accumulated evidence chars (default 16000). */
  maxEvidenceChars?: number;
}

export interface RlmGatherResult {
  available: boolean;
  evidence: string;
  finalDraft: string;
  rounds: number;
  toolCalls: number;
  /** Sub-questions produced by the PLAN stage (empty when planning was skipped/failed). */
  subQuestions: string[];
}

interface RlmEndpoint {
  base: string;
  model: string;
  authHeader: Record<string, string>;
  /** True when this is the hosted ss-rlm-sandbox rather than a local ss-rlm. */
  sandbox?: boolean;
}

/** The sidecar's own HTTP API — a plain OpenAI-compatible chat route that
 *  pins our model and spends our key. This is what drives the loop. */
const SIDECAR_API_PORT = 8098;
/** The ss-rlm-sandbox container. Runs the recursive pattern itself, so it is
 *  NOT what a caller driving its own tool loop wants. Kept for callers that
 *  want to hand over a whole context and let the container recurse. */
export const SANDBOX_PORT = 8101;

/**
 * Which endpoint runs the recursive session, per the `rlm` routing policy.
 *
 * The sandbox reads the three sidecar modes at face value — unlike the
 * embedding roles, where the wire mode is an encoding with a trap in it:
 *
 *   local-only  (SideCar only)         never use the sandbox
 *   local-first (SideCar + as backup)  sandbox only when no sidecar runs ss-rlm
 *   cloud-only  (OpenRouter only)      always the sandbox; ss-rlm is not probed
 *
 * A model is required in every case. Without one the sandbox is skipped, and
 * under cloud-only that means RLM is OFF rather than silently reverting to
 * ss-rlm — the whole point of choosing "OpenRouter only" is that the GPUs are
 * not in this path, so quietly putting them back would be the failure.
 */
async function resolveRlmEndpoint(projectId?: number): Promise<RlmEndpoint | null> {
  let mode: 'local-only' | 'local-first' | 'cloud-only' = 'local-only';
  let sandboxModel: string | undefined;
  try {
    const { getOpenRouterSettings } = await import('../sidecars/openRouterConfig.js');
    const { sanitizePolicies, effectiveBehaviour } = await import('../sidecars/routingPolicy.js');
    const stored = getOpenRouterSettings();
    mode = effectiveBehaviour('rlm', sanitizePolicies(stored.policyByRole).rlm!).sidecarMode;
    sandboxModel = stored.rlmSandboxModel;
  } catch {
    // Unreadable config keeps the pre-sandbox behaviour: local ss-rlm or nothing.
  }

  const local = mode === 'cloud-only' ? null : getSidecarForCapability('rlm');
  if (local) {
    const model = local.capabilities.rlm?.loaded ?? local.capabilities.rlm?.models?.[0];
    if (model) {
      return {
        base: sidecarServiceUrl(local, 'rlm'),
        model,
        authHeader: local.authToken ? { Authorization: `Bearer ${local.authToken}` } : {},
      };
    }
  }
  if (mode === 'local-only') return null;
  if (!sandboxModel) {
    console.warn(
      `[RLM] policy is "${mode}" but no sandbox model is configured — skipping RLM. `
      + 'Set one under Model Selection on the OpenRouter config page.',
    );
    return null;
  }

  // Any enabled sidecar can host the container; it is reached on its own port,
  // not through a capability the registry tracks.
  const { listSidecars } = await import('../sidecars/registry.js');
  const host = listSidecars({ enabled: true })[0];
  if (!host) return null;

  // Identity. One container serves BOTH masters and each has its own key and
  // budget, so the sidecar refuses (409) rather than guess whose to spend. The
  // URL must byte-match the `serverUrl` we pushed — a trailing slash or a
  // different host spelling is a 404 that reads as "no config pushed" — so it
  // comes from the same source the push is keyed by, never a rebuilt string.
  let masterUrl: string | undefined;
  try {
    const { getSlotStatus, getVirtualContainersConfig } = await import('../sidecars/virtualContainers.js');
    masterUrl = getVirtualContainersConfig().masterServerUrl
      ?? getSlotStatus().find(sl => sl.serverUrl)?.serverUrl;
  } catch { /* handled below */ }
  if (!masterUrl) {
    console.warn('[RLM] cannot identify this master to the sandbox (no serverUrl known) — skipping RLM.');
    return null;
  }

  // ── Which cloud endpoint replaces ss-rlm ────────────────────────────────
  //
  // NOT the sandbox on :8101, though that is the container named after this
  // role. The sandbox runs the RLM pattern ITSELF — hand it a long context and
  // it chunks, greps and sub-queries internally, measured at 26-28s per call.
  //
  // This function drives its OWN loop: plan, call search_code, read, decide,
  // round again. Pointing it at :8101 nests one RLM inside another, and the
  // outer loop then waits ~26s for what should be one model turn. Against the
  // whole-request budget that is a guaranteed timeout — observed as
  // `deadlineMs=23177` against a 26s first round, so the stage always expired
  // with nothing gathered.
  //
  // What this loop actually needs from ss-rlm is what ss-rlm is: a plain
  // tool-capable chat completion. The sidecar's own route is exactly that,
  // measured at ~1.8s, and it passes `tools` through to OpenRouter untouched.
  // So the cloud endpoint is the sidecar API, and :8101 stays for callers that
  // want the container's recursion rather than their own.
  const base = `${host.protocol}://${host.host}:${SIDECAR_API_PORT}/api`;
  console.log(
    mode === 'cloud-only'
      ? `[RLM] "OpenRouter only": driving the loop on ${host.name} via the sidecar's OpenRouter route with ${sandboxModel}`
      : `[RLM] DEGRADED — no sidecar is running ss-rlm; driving the loop on ${host.name} via the sidecar's OpenRouter route with ${sandboxModel}`,
  );
  return {
    base,
    model: sandboxModel,
    // BOTH names, deliberately.
    //
    // `X-FantomMCP-Master` is the name this master should be identified by —
    // "SoundSuite" in a header Fantom sends is a leftover from whose codebase
    // the sandbox was built in, not a description of the caller.
    //
    // But the sidecar reads ONLY `x-soundsuite-master` today, in three places:
    // chat/completions route.ts (POST and GET) and the container's server.py.
    // Sending the new name alone would mean no identity, which with two
    // masters holding keys on this fleet is a 409 — verified working before
    // this change, so switching outright would break it.
    //
    // Unknown headers are ignored, so sending both costs nothing and this
    // starts working under the new name the moment the sidecar accepts it,
    // with no second Fantom deploy. Drop the old one once every sidecar in the
    // fleet reads the new one — not before.
    authHeader: {
      'X-FantomMCP-Master': masterUrl,
      'X-SoundSuite-Master': masterUrl,
      // ── This master's RLM is for CODE ────────────────────────────────
      //
      // One container serves both masters, and the two want different tools
      // injected into the session: Sound Suite retrieves over case law
      // ('legal'), Fantom over a codebase ('code'). Getting that wrong does
      // not error — it answers a code question with legal retrieval, which is
      // the confidently-wrong failure the contract is written to avoid.
      //
      // The AUTHORITATIVE declaration is `domain: 'code'` in the config push,
      // which the sidecar already stores per master (SandboxDomain in
      // virtual-inference.ts). This header restates it PER REQUEST, which is
      // the safer unit: stored config can be stale after a sidecar restart
      // loses its in-memory state, while a header cannot be.
      //
      // Nothing reads it yet — like the identity rename, it is sent now so it
      // works the moment the sidecar does, with no second Fantom deploy.
      'X-FantomMCP-Domain': 'code',
      // ── How the container reaches our retrieval ──────────────────────
      //
      // `tools_for_domain('code')` in server.py is where the code tools get
      // injected, and it needs two things: where Fantom is, and permission.
      // The first it already has — the identity header IS our base URL, so
      // the tools POST to `<master>/api/rlm-tools/search_code`. The second is
      // this, because those routes refuse an unauthenticated caller.
      //
      // SCOPE, deliberately: this token unlocks code SEARCH and nothing else.
      // It is not the OpenRouter key, which the spec keeps out of the
      // container precisely because model-written Python runs there and could
      // read it. The same reasoning applies here and is the reason the grant
      // is this narrow: the worst a leaked search token buys is reading an
      // index we are already exposing to the sandbox on purpose. Rotate it by
      // editing `semanticSearch.rlmToolsToken`; the routes re-read per
      // request, so no restart is needed.
      ...(rlmToolsToken() ? { 'X-FantomMCP-Tools-Token': rlmToolsToken()! } : {}),
      // WHICH project the tools should search.
      //
      // The documented tool contract is `{query, limit}` with no scope, and
      // that cannot work here: Fantom indexes 340 projects, and an unscoped
      // search fans out across all of them — the executor's own comment says
      // cross-project graph enrichment exhausts memory, and this box has hit
      // the 4 GB guard twice. There is no sensible default either; a primary
      // project is often unset, as it is now.
      //
      // But the caller always knows. askCodebase is project-scoped, so the id
      // travels with the question and comes back on the tool call, and the
      // sandbox searches the same project the question was asked about rather
      // than one an operator happened to pin.
      ...(projectId !== undefined ? { 'X-FantomMCP-Project': String(projectId) } : {}),
    },
    sandbox: true,
  };
}

export async function runRlmGather(opts: RlmGatherOptions): Promise<RlmGatherResult | null> {
  const ep = await resolveRlmEndpoint(opts.projectId);
  if (!ep) return null;
  const { base, model, authHeader } = ep;

  const maxRounds = Math.max(1, opts.maxRounds ?? DEFAULT_MAX_ROUNDS);
  const requestedMaxTokens = opts.maxTokens ?? 2048;
  const temperature = opts.temperature ?? 0.3;
  const maxEvidenceChars = opts.maxEvidenceChars ?? DEFAULT_MAX_EVIDENCE_CHARS;
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;

  // ── Deadline: one AbortController that fires on the overall budget OR the
  // caller's signal. A hung/slow sidecar must never block askCodebase.
  const t0 = Date.now();
  const deadlineAt = t0 + deadlineMs;
  const remaining = () => deadlineAt - Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`RLM deadline ${deadlineMs}ms exceeded`)), deadlineMs);
  const onCallerAbort = () => ac.abort(opts.signal?.reason ?? new Error('caller aborted'));
  if (opts.signal) {
    if (opts.signal.aborted) onCallerAbort();
    else opts.signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const signal = ac.signal;

  let evidence = '';
  let evidenceTruncated = false;
  const seenBlocks = new Set<string>();
  let toolCalls = 0;
  let usefulHits = 0; // tool results that actually carried code
  let rounds = 0;
  const subQuestions: string[] = [];
  const ev = (e: Omit<RlmEvent, 't'>): void => {
    try { opts.onEvent?.({ ...e, t: Date.now() - t0 }); } catch { /* a bad listener must not fail the gather */ }
  };

  const appendEvidence = (label: string, result: string) => {
    const merged = mergeEvidence([{ label, result }], seenBlocks, Math.max(0, maxEvidenceChars - evidence.length));
    if (merged.text.length > 0) evidence += (evidence ? '\n\n' : '') + merged.text;
    if (merged.truncated) evidenceTruncated = true;
    return merged;
  };

  const finish = (finalDraft: string, why?: string): RlmGatherResult => {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onCallerAbort);
    const draft = stripRlmTemplate(finalDraft);
    ev({ kind: 'done', text: `${toolCalls} question(s) over ${rounds} round(s)${why ? ` — ${why}` : ''}`, ms: Date.now() - t0, detail: draft ? draft.slice(0, 600) : undefined });
    console.log(
      `[RLM] gather done planned=${subQuestions.length} rounds=${rounds} toolCalls=${toolCalls} ` +
        `evidenceChars=${evidence.length}${evidenceTruncated ? ' (truncated)' : ''} draftChars=${draft.length} ` +
        `totalElapsed=${Date.now() - t0}ms${why ? ` reason=${why}` : ''}`,
    );
    return { available: true, evidence: evidence.trim(), finalDraft: draft, rounds, toolCalls, subQuestions };
  };

  try {
    // ── Context window — read the deployed max_model_len once. ─────────────
    let contextTokens = DEFAULT_CONTEXT_TOKENS;
    try {
      const r = await fetch(`${base}/v1/models`, { method: 'GET', headers: { ...authHeader }, signal });
      if (r.ok) {
        const body: any = await r.json().catch(() => null);
        const len = body?.data?.[0]?.max_model_len;
        if (typeof len === 'number' && len > 0) contextTokens = len;
      }
    } catch {
      // Best-effort; keep the default. (A failed /v1/models probe shouldn't
      // abort the run — the chat endpoint may still be reachable.)
    }

    console.log(
      `[RLM] gather start base=${base} model=${model} maxRounds=${maxRounds} deadlineMs=${deadlineMs} ctx=${contextTokens} tools=[${opts.tools
        .map((t) => t.function.name)
        .join(', ')}]`,
    );

    // ── Seed messages ──────────────────────────────────────────────────────
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `QUESTION: ${opts.question}\n\n` +
          `Initial retrieved code (seed context):\n${opts.seedContext || '(none)'}\n\n` +
          `Investigate using the tools, then answer the question briefly.`,
      },
    ];

    // ── STAGE 1: PLAN ──────────────────────────────────────────────────────
    let plan: RlmPlan | null = null;
    if (opts.plan !== false) {
      plan = await planQuestion(ep, opts, signal, remaining());
    }
    if (opts.extraSubQuestions?.length) {
      const base = plan ?? { restated: opts.question, subQuestions: [] };
      const seen = new Set(base.subQuestions.map((s) => `${s.tool}:${s.query.toLowerCase()}`));
      const extras = opts.extraSubQuestions.filter((s) => {
        const k = `${s.tool}:${s.query.toLowerCase()}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (extras.length) {
        plan = { restated: base.restated, subQuestions: [...extras, ...base.subQuestions] };
        console.log(`[RLM] plan += ${extras.length} caller sub-question(s): ${extras.map((e) => `${e.tool}(${JSON.stringify(e.query)})`).join(', ')}`);
      }
    }

    // ── STAGE 2: GATHER (parallel, capped) ─────────────────────────────────
    if (plan) {
      for (const sq of plan.subQuestions) subQuestions.push(sq.question);
      ev({ kind: 'plan', text: plan.restated, items: plan.subQuestions.map(s => `${s.tool}: ${s.query}`) });
      const gatherT0 = Date.now();
      const results = await runWithConcurrency(
        plan.subQuestions.map((sq, i) => async () => {
          const callT0 = Date.now();
          ev({ kind: 'ask', id: `g${i + 1}`, text: `${sq.tool}(${JSON.stringify(sq.query)})`, detail: sq.question });
          let result: string;
          try {
            result = await opts.executeTool(sq.tool, { query: sq.query });
          } catch (err) {
            result = `${sq.tool} failed: ${(err as Error).message}`;
          }
          const hits = splitEvidenceBlocks(result).length;
          ev({ kind: 'answer', id: `g${i + 1}`, text: hits > 0 ? `${hits} hit(s)` : (result.startsWith(sq.tool + ' failed') ? result.slice(0, 160) : 'nothing found'), ms: Date.now() - callT0, detail: firstHitLine(result) });
          console.log(
            `[RLM] gather sub[${i + 1}/${plan!.subQuestions.length}] ${sq.tool}(${JSON.stringify(sq.query)}) ` +
              `hits=${hits} chars=${result.length} elapsed=${Date.now() - callT0}ms`,
          );
          return { sq, result, hits };
        }),
        GATHER_CONCURRENCY,
      );

      // Inject the gathered evidence as a native assistant→tool exchange so the
      // COMBINE rounds see it exactly as if the model had issued the searches.
      const calls: ToolCall[] = [];
      const toolMsgs: ChatMessage[] = [];
      let blocks = 0;
      let dups = 0;
      results.forEach(({ sq, result, hits }, i) => {
        toolCalls++;
        if (hits > 0) usefulHits++;
        const id = `plan-${i}`;
        const args = JSON.stringify({ query: sq.query });
        calls.push({ id, type: 'function', function: { name: sq.tool, arguments: args } });
        toolMsgs.push({ role: 'tool', tool_call_id: id, name: sq.tool, content: result });
        const merged = appendEvidence(`${sq.tool}(${args}) [plan: ${sq.question}]`, result);
        blocks += merged.blocks;
        dups += merged.duplicates;
      });
      messages.push({
        role: 'assistant',
        content: `Research plan: ${plan.restated}\nSub-questions: ${plan.subQuestions.map((s) => s.question).join(' | ')}`,
        tool_calls: calls,
      });
      messages.push(...toolMsgs);
      console.log(
        `[RLM] gather merged subQuestions=${plan.subQuestions.length} blocks=${blocks} duplicates=${dups} ` +
          `evidenceChars=${evidence.length}${evidenceTruncated ? ' (truncated)' : ''} elapsed=${Date.now() - gatherT0}ms`,
      );
    }

    // ── STAGE 3: COMBINE — follow-up tool rounds, then draft ───────────────
    console.log(
      `[RLM] combine start maxRounds=${maxRounds} evidenceChars=${evidence.length} usefulHits=${usefulHits} remainingMs=${remaining()}`,
    );
    let nudged = false; // have we pushed the "search before answering" nudge yet?

    for (let round = 1; round <= maxRounds; round++) {
      if (remaining() < MIN_ROUND_BUDGET_MS) {
        console.warn(`[RLM] round ${round} skipped — ${remaining()}ms left on deadline`);
        return finish('', 'deadline');
      }
      rounds = round;
      const roundT0 = Date.now();
      ev({ kind: 'round', text: `round ${round}${round === maxRounds ? ' (final)' : ''}` });

      // ── Context budget enforcement: clamp, then trim oldest history if even
      // MIN_OUTPUT_TOKENS doesn't fit, then re-clamp.
      let clamp = clampOutputTokens(messages, requestedMaxTokens, contextTokens);
      if (clamp.estimatedInput + MIN_OUTPUT_TOKENS + SAFETY_MARGIN_TOKENS > contextTokens) {
        const before = messages.length;
        const removed = trimHistoryToFit(messages, contextTokens);
        if (removed > 0) {
          console.warn(
            `[RLM] round ${round} trim ${removed} oldest message(s) (was=${before}, now=${messages.length}) to fit ctx`,
          );
          clamp = clampOutputTokens(messages, requestedMaxTokens, contextTokens);
        }
      }
      const roundMaxTokens = clamp.maxTokens;

      const j = await chatCompletion(
        ep,
        {
          messages,
          tools: opts.tools,
          // 'auto' (native format) until the last round, which forbids tools so
          // the model MUST emit a final answer. We force "always gather once"
          // CONVERSATIONALLY below (a nudge message), NOT via tool_choice:
          // 'required' — this qwen3-8b fine-tune emits qwen-XML tool calls that
          // vLLM's 'required' constraint mangles into an empty response.
          tool_choice: round === maxRounds ? 'none' : 'auto',
          max_tokens: roundMaxTokens,
          temperature,
        },
        signal,
        `round ${round}`,
      );
      if (!j) {
        // Endpoint failed or deadline hit. If we already hold evidence, hand it
        // back (the caller synthesizes from it); otherwise let the caller fall back.
        if (evidence.length > 0) return finish('', signal.aborted ? 'deadline' : 'endpoint-error');
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onCallerAbort);
        return null;
      }

      const choice = j.choices?.[0];
      const msg = choice?.message;

      // On the final round tool_choice was 'none', so never interpret the
      // response as a tool call — whatever was produced is the final answer.
      let calls: ToolCall[] | undefined = round === maxRounds ? undefined : msg?.tool_calls;
      if (typeof msg?.content === 'string' && msg.content.trim()) {
        ev({ kind: 'thought', text: msg.content.trim().slice(0, 400) });
      }

      // Defensive fallback: vLLM's tool-call parser sometimes misses the shape
      // the Qwen3-8B fine-tune emits (qwen XML). Scan content for known shapes.
      if (
        round !== maxRounds &&
        (!calls || calls.length === 0) &&
        typeof msg?.content === 'string' &&
        msg.content.length > 0
      ) {
        const fallback = extractFallbackToolCalls(msg.content, opts.tools, round);
        if (fallback.length > 0) {
          console.warn(
            `[RLM] round ${round} fallback parser fired: ${fallback.length} call(s) for [${fallback
              .map((c) => c.function.name)
              .join(', ')}]`,
          );
          calls = fallback;
        }
      }

      if (calls && calls.length > 0) {
        // Append the assistant turn carrying the tool calls.
        messages.push({
          role: 'assistant',
          content: typeof msg.content === 'string' ? msg.content : '',
          tool_calls: calls,
        });

        // Follow-up searches run in parallel too (same concurrency cap).
        const outcomes = await runWithConcurrency(
          calls.map((call) => async () => {
            let args: Record<string, unknown> = {};
            try {
              args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
            } catch {
              args = {};
            }
            toolCalls++;
            const callT0 = Date.now();
            const evId = `r${round}-${toolCalls}`;
            ev({ kind: 'ask', id: evId, text: `${call.function.name}(${JSON.stringify(args).slice(0, 200)})` });
            console.log(
              `[RLM] round ${round} → tool ${call.function.name}(${JSON.stringify(args).slice(0, 200)})`,
            );
            let result: string;
            try {
              result = await opts.executeTool(call.function.name, args);
            } catch (err) {
              result = `Tool ${call.function.name} failed: ${(err as Error).message}`;
            }
            {
              const hits = splitEvidenceBlocks(result).length;
              ev({ kind: 'answer', id: evId, text: hits > 0 ? `${hits} hit(s)` : (result.startsWith('Tool ') ? result.slice(0, 160) : 'nothing found'), ms: Date.now() - callT0, detail: firstHitLine(result) });
            }
            console.log(
              `[RLM] round ${round} ← tool ${call.function.name} ${result.length} chars elapsed=${Date.now() - callT0}ms`,
            );
            return { call, args, result };
          }),
          GATHER_CONCURRENCY,
        );
        for (const { call, args, result } of outcomes) {
          if (splitEvidenceBlocks(result).length > 0) usefulHits++;
          // Accumulate evidence so the caller (Groq) can synthesize from the
          // exact code the RLM discovered. Deduped against the gather stage.
          const merged = appendEvidence(`${call.function.name}(${JSON.stringify(args)})`, result);
          if (call.function.name === 'project_overview' && merged.blocks === 0 && evidence.length < maxEvidenceChars) {
            // Overview is prose, not hit blocks — keep it verbatim (bounded).
            const room = maxEvidenceChars - evidence.length;
            evidence += `\n\n--- project_overview ---\n${result.slice(0, Math.max(0, room))}`;
          }
          messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: result });
        }
        console.log(`[RLM] round ${round} done elapsed=${Date.now() - roundT0}ms (gathering)`);
        continue;
      }

      // No tool calls. If the model tried to answer WITHOUT any useful
      // evidence yet, nudge it once to search first. Conversational, native
      // format — unlike tool_choice:'required', which this fine-tune mangles.
      if (usefulHits === 0 && !nudged && round < maxRounds) {
        nudged = true;
        messages.push({ role: 'assistant', content: typeof msg?.content === 'string' ? msg.content : '' });
        messages.push({
          role: 'user',
          content:
            'You answered without finding any code. Before concluding you MUST issue at ' +
            'least one focused search_code (a short 2–5 word concept query, e.g. ' +
            '"load from sax") or search_symbols (a bare identifier), then answer grounded in what it returns.',
        });
        console.log(`[RLM] round ${round} answered without evidence — nudging to search once`);
        continue;
      }

      // No tool calls — this is the final answer (draft). Stop.
      return finish(typeof msg?.content === 'string' ? msg.content : '');
    }

    // Unreachable in practice: the last round sends tool_choice:'none', so it
    // always returns a final answer above. Defensive return preserves any
    // gathered evidence rather than discarding it.
    console.warn(`[RLM] gather hit maxRounds=${maxRounds} without a final answer — returning gathered evidence`);
    return finish('', 'maxRounds');
  } catch (err) {
    // Never throw: return what we have, or null when nothing was gathered.
    console.warn(`[RLM] gather aborted: ${(err as Error).message}`);
    if (evidence.length > 0) return finish('', 'error');
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onCallerAbort);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Endpoint helpers
// ──────────────────────────────────────────────────────────────────────────

/** POST /v1/chat/completions; logs + returns null on any failure (never throws). */
async function chatCompletion(
  ep: RlmEndpoint,
  body: Record<string, unknown>,
  signal: AbortSignal,
  label: string,
): Promise<any | null> {
  let res: Response;
  try {
    res = await fetch(`${ep.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ep.authHeader },
      body: JSON.stringify({ model: ep.model, stream: false, ...body }),
      signal,
    });
  } catch (err) {
    console.warn(`[RLM] ${label} fetch failed: ${(err as Error).message}`);
    return null;
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.warn(`[RLM] ${label} HTTP ${res.status}: ${errBody.slice(0, 300)}`);
    return null;
  }
  try {
    return await res.json();
  } catch (err) {
    console.warn(`[RLM] ${label} JSON parse failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * STAGE 1 — ask the model to decompose the question into sub-questions.
 * Returns null (→ legacy single-question behaviour) on any failure.
 */
export async function planQuestion(
  ep: RlmEndpoint,
  opts: Pick<RlmGatherOptions, 'question' | 'tools' | 'scopeNote'>,
  signal: AbortSignal,
  remainingMs: number,
): Promise<RlmPlan | null> {
  if (remainingMs < MIN_ROUND_BUDGET_MS) {
    console.warn(`[RLM] plan skipped — ${remainingMs}ms left on deadline`);
    return null;
  }
  const toolNames = opts.tools.map((t) => t.function.name);
  const planT0 = Date.now();
  const j = await chatCompletion(
    ep,
    {
      messages: [
        {
          role: 'system',
          content:
            'You are a research planner for a code-search agent. You output strict JSON only — ' +
            'no prose, no markdown, no tool calls.',
        },
        { role: 'user', content: buildPlanPrompt(opts.question, toolNames, opts.scopeNote) },
      ],
      max_tokens: 512,
      temperature: 0.1,
    },
    signal,
    'plan',
  );
  const raw: string = typeof j?.choices?.[0]?.message?.content === 'string' ? j.choices[0].message.content : '';
  const plan = parsePlanJson(raw, toolNames, opts.question);
  if (!plan) {
    console.warn(
      `[RLM] plan unparseable (${raw.length} chars) — falling back to single-question gather. head=${JSON.stringify(
        raw.slice(0, 160),
      )}`,
    );
    return null;
  }
  console.log(
    `[RLM] plan restated=${JSON.stringify(plan.restated)} subQuestions=${plan.subQuestions.length} ` +
      plan.subQuestions.map((s) => `${s.tool}(${JSON.stringify(s.query)}) ← ${JSON.stringify(s.question)}`).join('; ') +
      ` elapsed=${Date.now() - planT0}ms`,
  );
  return plan;
}


// ---------------------------------------------------------------------------
// Fallback tool-call parser (ported verbatim from court-lens stream-rlm.ts)
// ---------------------------------------------------------------------------

/**
 * Scan free-text assistant content for tool calls the vLLM parser missed.
 * Detects: qwen XML (<tool_call><function=NAME><parameter=K>V</parameter>…),
 * hermes <tool_call>{json}</tool_call>, bare JSON line, pythonic positional
 * name("…"), and pythonic kwargs name(k="v", n=1).
 */
export function extractFallbackToolCalls(
  content: string,
  tools: RlmToolSpec[],
  round: number,
): ToolCall[] {
  const out: ToolCall[] = [];

  // Shape 0 — Qwen XML format (the mit-oasys RLM Qwen3-8B fine-tune emits this).
  const qwenXmlRe = /<tool_call>\s*<function\s*=\s*([A-Za-z_][\w-]*)\s*>([\s\S]*?)<\/function>\s*<\/tool_call>/g;
  const paramRe = /<parameter\s*=\s*([A-Za-z_][\w-]*)\s*>([\s\S]*?)<\/parameter>/g;
  let qm: RegExpExecArray | null;
  while ((qm = qwenXmlRe.exec(content)) !== null) {
    const fnName = qm[1];
    if (!tools.some((t) => t.function.name === fnName)) continue;
    const body = qm[2];
    const args: Record<string, unknown> = {};
    let pm: RegExpExecArray | null;
    while ((pm = paramRe.exec(body)) !== null) {
      const key = pm[1];
      const raw = pm[2].trim();
      if (/^-?\d+(?:\.\d+)?$/.test(raw)) args[key] = Number(raw);
      else if (raw === 'true') args[key] = true;
      else if (raw === 'false') args[key] = false;
      else if (raw === 'null') args[key] = null;
      else args[key] = raw;
    }
    out.push({
      id: `fallback-${round}-${out.length}`,
      type: 'function',
      function: { name: fnName, arguments: JSON.stringify(args) },
    });
  }

  // Shape 3 — hermes <tool_call>{...}</tool_call>
  const hermesRe = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
  let m: RegExpExecArray | null;
  while ((m = hermesRe.exec(content)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      if (obj && typeof obj.name === 'string' && tools.some((t) => t.function.name === obj.name)) {
        const args = obj.arguments ?? obj.parameters ?? {};
        out.push({
          id: `fallback-${round}-${out.length}`,
          type: 'function',
          function: { name: obj.name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
        });
      }
    } catch {
      /* skip malformed */
    }
  }

  // Shape 4 — bare JSON line (well-formed single-line objects)
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj.name === 'string' && tools.some((t) => t.function.name === obj.name)) {
        const args = obj.arguments ?? obj.parameters ?? {};
        const argStr = typeof args === 'string' ? args : JSON.stringify(args);
        if (out.some((c) => c.function.name === obj.name && c.function.arguments === argStr)) continue;
        out.push({
          id: `fallback-${round}-${out.length}`,
          type: 'function',
          function: { name: obj.name, arguments: argStr },
        });
      }
    } catch {
      /* skip */
    }
  }

  // Shapes 1 & 2 — pythonic per-tool
  for (const tool of tools) {
    const name = tool.function.name;
    const safeName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Pythonic positional: name("…") — capture first string arg as `query`.
    const posRe = new RegExp(`\\b${safeName}\\s*\\(\\s*(["'])((?:\\\\.|(?!\\1).)*)\\1\\s*\\)`, 'g');
    let pm: RegExpExecArray | null;
    while ((pm = posRe.exec(content)) !== null) {
      const queryArg = pm[2].replace(/\\(["'\\])/g, '$1');
      const argStr = JSON.stringify({ query: queryArg });
      if (out.some((c) => c.function.name === name && c.function.arguments === argStr)) continue;
      out.push({
        id: `fallback-${round}-${out.length}`,
        type: 'function',
        function: { name, arguments: argStr },
      });
    }

    // Pythonic kwargs: name(key="val", key2=123)
    const kwRe = new RegExp(`\\b${safeName}\\s*\\(\\s*([a-zA-Z_][a-zA-Z0-9_]*\\s*=[^)]*)\\)`, 'g');
    let km: RegExpExecArray | null;
    while ((km = kwRe.exec(content)) !== null) {
      const kwBody = km[1];
      const args: Record<string, unknown> = {};
      const pairRe =
        /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:(["'])((?:\\.|(?!\2).)*)\2|(-?\d+(?:\.\d+)?)|([a-zA-Z_][a-zA-Z0-9_]*))/g;
      let pm2: RegExpExecArray | null;
      while ((pm2 = pairRe.exec(kwBody)) !== null) {
        const k = pm2[1];
        if (pm2[2] !== undefined) {
          args[k] = pm2[3].replace(/\\(["'\\])/g, '$1');
        } else if (pm2[4] !== undefined) {
          args[k] = Number(pm2[4]);
        } else if (pm2[5] !== undefined) {
          const v = pm2[5];
          args[k] = v === 'true' ? true : v === 'false' ? false : v === 'null' ? null : v;
        }
      }
      if (Object.keys(args).length === 0) continue;
      const argStr = JSON.stringify(args);
      if (out.some((c) => c.function.name === name && c.function.arguments === argStr)) continue;
      out.push({
        id: `fallback-${round}-${out.length}`,
        type: 'function',
        function: { name, arguments: argStr },
      });
    }
  }

  return out;
}

/** First identifier-ish line of a tool result, for the feed's answer preview. */
function firstHitLine(result: string): string | undefined {
  const line = result.split('\n').map(l => l.trim()).find(l => l.length > 0 && !l.startsWith('---'));
  return line ? line.slice(0, 160) : undefined;
}
