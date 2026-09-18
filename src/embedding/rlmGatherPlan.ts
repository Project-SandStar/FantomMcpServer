/**
 * Pure helpers for the RLM gather stage (see rlmToolLoop.ts):
 *
 *   - PLAN parsing: turn the model's (hopefully) JSON decomposition of the user
 *     question into validated sub-questions, each tagged with the search tool
 *     that fits it best.
 *   - Evidence merging: dedupe search-result blocks across sub-questions by
 *     their header line (qualifiedName + file:line) and bound total chars.
 *   - Bounded parallelism: run tool executors with a concurrency cap.
 *   - Template stripping: remove the fine-tune's "You responded with:\n[Answer]"
 *     wrapper and stray closing fences from the final draft.
 *
 * Everything here is side-effect free and unit-testable without a model.
 */

export type RlmPlanTool = 'search_code' | 'search_symbols' | 'search_files';

export interface RlmSubQuestion {
  /** Human-readable sub-question ("where is retejs mapping defined"). */
  question: string;
  /** Tool best suited to answer it. */
  tool: RlmPlanTool;
  /** Short query to hand to that tool (2–5 content words or an identifier). */
  query: string;
}

export interface RlmPlan {
  restated: string;
  subQuestions: RlmSubQuestion[];
}

export const PLAN_MIN_SUBQUESTIONS = 1;
export const PLAN_MAX_SUBQUESTIONS = 4;

const PLAN_TOOLS: ReadonlySet<string> = new Set<RlmPlanTool>(['search_code', 'search_symbols', 'search_files']);

/** Prompt asking the model for a strict-JSON decomposition of the question. */
export function buildPlanPrompt(question: string, availableTools: string[], scopeNote?: string): string {
  const tools = availableTools.filter((t) => PLAN_TOOLS.has(t));
  const toolList = tools.length > 0 ? tools : Array.from(PLAN_TOOLS);
  const scope = scopeNote && scopeNote.trim() ? `SCOPE (projects the searches cover):\n${scopeNote.trim()}\n\n` : '';
  return (
    `Decompose the following code question into a research plan.\n\n` +
    `QUESTION: ${question}\n\n` +
    scope +
    `Return ONLY a JSON object, no prose, no markdown fences, with this exact shape:\n` +
    `{"restated": "<one sentence restating what is being asked>",\n` +
    ` "subQuestions": [\n` +
    `   {"question": "<focused sub-question>", "tool": "<${toolList.join('|')}>", "query": "<2-5 word search query or bare identifier>"}\n` +
    ` ]}\n\n` +
    `Rules:\n` +
    `- Produce 2 to 4 sub-questions covering DISTINCT aspects (e.g. "where is X defined", ` +
    `"how does X map to Y", "which callers use X", "what state/fields does X hold").\n` +
    `- Use "search_code" for concepts and behaviour ("map sedona state"), ` +
    `"search_symbols" for probable identifiers, type names or exact tokens ("SedonaState", "handleSedonaState"), ` +
    (toolList.includes('search_files')
      ? `"search_files" for a library, directory or file name to find WHICH FILES belong to it and the symbols they define ("rete", "sox", "types.ts").\n`
      : '\n') +
    `- Each "query" is SHORT: one concept per query, no "A or B" disjunctions, never the whole question.\n` +
    `- Every proper noun, library name or CamelCase identifier in the question (e.g. "retejs", "SedonaState") ` +
    `MUST get its own "search_symbols" sub-question with the bare token as the query.\n` +
    (scope
      ? `- When a library, framework or UI concept in the question is listed under a related project's libs, ` +
        `phrase that sub-question in the related project's language (component/class/method names for TypeScript or Vue, ` +
        `func/type names for Fantom) so the search matches how it is written there.\n`
      : '') +
    `- Output the JSON object and nothing else.`
  );
}

/**
 * Parse the model's plan output defensively. Accepts fenced JSON, the RLM
 * template wrapper, and stray prose around the object. Returns null when no
 * usable plan can be recovered (caller falls back to single-question mode).
 */
export function parsePlanJson(raw: string, availableTools: string[], question: string): RlmPlan | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let text = stripRlmTemplate(raw);
  // Drop markdown fences if present.
  text = text.replace(/```(?:json)?/gi, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let obj: any;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    // Try trimming trailing commas — a common small-model slip.
    try {
      obj = JSON.parse(text.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;

  const allowed = new Set(availableTools.filter((t) => PLAN_TOOLS.has(t)));
  const defaultTool: RlmPlanTool = allowed.has('search_code')
    ? 'search_code'
    : allowed.has('search_symbols')
      ? 'search_symbols'
      : 'search_code';

  const rawSubs: unknown[] = Array.isArray(obj.subQuestions)
    ? obj.subQuestions
    : Array.isArray(obj.sub_questions)
      ? obj.sub_questions
      : Array.isArray(obj.questions)
        ? obj.questions
        : [];

  const seen = new Set<string>();
  const subQuestions: RlmSubQuestion[] = [];
  for (const s of rawSubs) {
    if (subQuestions.length >= PLAN_MAX_SUBQUESTIONS) break;
    let q = '';
    let tool: string | undefined;
    let query = '';
    if (typeof s === 'string') {
      q = s.trim();
    } else if (s && typeof s === 'object') {
      const o = s as Record<string, unknown>;
      q = typeof o.question === 'string' ? o.question.trim() : '';
      tool = typeof o.tool === 'string' ? o.tool.trim() : undefined;
      query = typeof o.query === 'string' ? o.query.trim() : '';
    }
    if (!q && !query) continue;
    if (!q) q = query;
    if (!query) query = q;
    // Ignore a tool the caller did not register; fall back to the default.
    const finalTool: RlmPlanTool =
      tool && allowed.has(tool) ? (tool as RlmPlanTool) : defaultTool;
    // Keep queries short — clamp runaway sentences to ~80 chars.
    if (query.length > 80) query = query.slice(0, 80).trim();
    const key = `${finalTool}:${query.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    subQuestions.push({ question: q, tool: finalTool, query });
  }
  if (subQuestions.length < PLAN_MIN_SUBQUESTIONS) return null;

  const restated =
    typeof obj.restated === 'string' && obj.restated.trim().length > 0
      ? obj.restated.trim()
      : question;
  return { restated, subQuestions };
}

// ──────────────────────────────────────────────────────────────────────────
// Template stripping
// ──────────────────────────────────────────────────────────────────────────

/**
 * Strip the RLM fine-tune's output wrapper so callers get clean text:
 *   "You responded with:\n[Answer]\n<text>\n\"\"\""  →  "<text>"
 * Also tolerates a bare leading "[Answer]", leading/trailing triple quotes,
 * and surrounding whitespace. Idempotent.
 */
export function stripRlmTemplate(text: string): string {
  if (typeof text !== 'string') return '';
  let out = text.trim();
  // Leading wrapper: "You responded with:" optionally followed by "[Answer]".
  out = out.replace(/^You responded with:\s*/i, '');
  out = out.replace(/^\[Answer\]\s*/i, '');
  // Some outputs open with a fence of triple quotes.
  out = out.replace(/^"""\s*/, '');
  // Closing triple quotes (possibly followed by whitespace / a lone newline).
  out = out.replace(/\s*"""\s*$/, '');
  // A trailing "[/Answer]"-style closer, if the model invents one.
  out = out.replace(/\s*\[\/?Answer\]\s*$/i, '');
  return out.trim();
}

// ──────────────────────────────────────────────────────────────────────────
// Evidence merging
// ──────────────────────────────────────────────────────────────────────────

/** True when a tool result string carries no hits (error / no-results messages). */
export function isEmptyToolResult(result: string): boolean {
  const t = result.trim();
  if (t.length === 0) return true;
  return /^(search_code|search_symbols|project_overview)(:| error:| failed:)/.test(t) && !t.includes('\n');
}

/**
 * Split a search tool result into per-hit blocks. Hits are separated by a
 * blank line and each starts flush-left with "<qualifiedName> … <file>:<line>".
 */
export function splitEvidenceBlocks(result: string): string[] {
  if (isEmptyToolResult(result)) return [];
  return result
    .split(/\n\s*\n(?=\S)/)
    .map((b) => b.trimEnd())
    .filter((b) => b.trim().length > 0);
}

/** Dedupe key for a block: its header line (qualifiedName + location), normalised. */
export function evidenceBlockKey(block: string): string {
  const header = block.split('\n', 1)[0] ?? '';
  // "name (type) path:line" or "name path:line" → drop the "(type)" so the same
  // node found via search_code and search_symbols collapses to one key.
  return header.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

export interface MergedEvidence {
  /** Combined evidence text, sections labelled per sub-question. */
  text: string;
  /** Distinct blocks kept. */
  blocks: number;
  /** Blocks dropped as duplicates. */
  duplicates: number;
  /** True when the char bound truncated the output. */
  truncated: boolean;
}

/**
 * Merge per-sub-question results, dropping blocks already seen (by header
 * key) and bounding total chars. The `seen` set is mutated so later rounds can
 * keep deduping against what the gather stage already collected.
 */
export function mergeEvidence(
  results: Array<{ label: string; result: string }>,
  seen: Set<string>,
  maxChars: number,
): MergedEvidence {
  let text = '';
  let blocks = 0;
  let duplicates = 0;
  let truncated = false;
  for (const { label, result } of results) {
    const parts = splitEvidenceBlocks(result);
    const kept: string[] = [];
    for (const b of parts) {
      const key = evidenceBlockKey(b);
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);
      kept.push(b);
    }
    if (kept.length === 0) continue;
    const section = `\n\n--- ${label} ---\n${kept.join('\n\n')}`;
    if (text.length + section.length > maxChars) {
      const room = maxChars - text.length;
      if (room > 200) text += section.slice(0, room) + '\n…';
      truncated = true;
      break;
    }
    text += section;
    blocks += kept.length;
  }
  return { text: text.trim(), blocks, duplicates, truncated };
}

// ──────────────────────────────────────────────────────────────────────────
// Bounded parallelism
// ──────────────────────────────────────────────────────────────────────────

/** Run `tasks` with at most `limit` in flight; results keep input order. */
export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}
