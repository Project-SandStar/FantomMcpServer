/**
 * Jev routing gates for askCodebase.
 *
 * The RLM investigation loop is the most expensive stage of an ask (35–95 s
 * measured) and the one most often not needed: "where is X defined" and
 * "what does Y return" are answered by retrieval alone. Today the caller
 * decides with a flag; when it does not, this gate asks Jev ONE Choice over
 * the question and the top retrieval hits and skips the loop when the answer
 * is `direct` with confidence at or above `semanticSearch.jev.minConfidence`.
 *
 * Advisory only: no Jev, no key, a timeout, or low confidence → the default
 * (`rlm` unless `fast`) stands. The decision and its confidence are logged and
 * returned so the ask feed and the MCP result can show why the loop ran or not.
 */
import { jevAsk, getJevSettings, type JevQuestion, type JevChoiceAnswer, type JevNoulAnswer, type JevScoreAnswer, type JevFetch } from './providers/jevClient.js';

export type AskRoute = 'direct' | 'rlm';

export interface AskRouteDecision {
  route: AskRoute;
  confidence: number;
  /** The question names an exact identifier (symbol, file, tag) — keyword search should lead. */
  identifier: boolean;
  identifierProbability: number;
  probabilities: Record<string, number>;
  model: string;
  ms: number;
  /** True when `route` cleared `minConfidence` and may override the default. */
  decisive: boolean;
}

export interface AskRouteInput {
  question: string;
  /** Top retrieval hits, name + type + file. Up to ~8; more adds nothing. */
  hits: Array<{ qualifiedName: string; nodeType: string; filePath: string }>;
  projectName?: string;
  versionGroup?: string;
}

export const ASK_ROUTE_QUESTIONS: Record<string, JevQuestion> = {
  route: {
    type: 'choice',
    instructions: {
      question:
        'The user asked `question` about a codebase. `hits` are the code symbols a semantic search already found; '
        + '`namedSymbolsFound` lists the identifiers from the question that appear among the hits (computed by code, reliable). '
        + 'Decide how to answer well: `direct` when the hits plus their source are enough to write a correct, cited answer; '
        + '`rlm` when a correct answer needs more searching first — following callers or callees across files, comparing several implementations, '
        + 'tracing a flow end to end, or when the hits do not cover what was asked.',
    },
    criteria: {
      direct: {
        covers: 'Answer now from the hits. The question is about one or two named symbols and those symbols are among the hits.',
        examples: ['where is X defined', 'what does Y return', 'what parameters does Z take', 'where is X defined and what does it return', 'which file holds tag T'],
        signal: 'namedSymbolsFound is non-empty and the question asks about those symbols only.',
      },
      rlm: {
        covers: 'Investigate first with more searches. The answer spans several places or a chain of calls, or the hits do not contain what the question names.',
        examples: ['how does A interact with B', 'why does X happen', 'trace a request end to end', 'compare the implementations of P and Q', 'list every place that does R'],
        signal: 'namedSymbolsFound is empty while the question names symbols, or the question asks how/why across components.',
      },
    },
  },
  identifier: {
    type: 'noul',
    instructions: 'Does `question` name an exact code identifier — a function, type, file, tag or config key spelled as it appears in code (for example `ph.lib`, `Ext.onStart`, `funcs.xeto`)?',
  },
};

function pickChoice(a: unknown): JevChoiceAnswer | null {
  return a && typeof a === 'object' && (a as JevChoiceAnswer).type === 'choice' && typeof (a as JevChoiceAnswer).choice === 'string' ? (a as JevChoiceAnswer) : null;
}
/** Yes-probability of a noul answer: the API's `noul` field, `probability` as a fallback. */
function noulProbability(a: unknown): number | null {
  if (!a || typeof a !== 'object' || (a as JevNoulAnswer).type !== 'noul') return null;
  const n = a as JevNoulAnswer;
  if (typeof n.noul === 'number') return n.noul;
  if (typeof n.probability === 'number') return n.probability;
  return null;
}

/**
 * Identifier-looking tokens of the question (camelCase, dotted, `::`, or
 * ≥4 letters) that match the last segment of a hit's qualified name.
 * Pure; exported for tests.
 */
export function namedSymbolsInHits(question: string, qualifiedNames: string[]): string[] {
  const tokens = question.match(/[A-Za-z_][A-Za-z0-9_.:]*[A-Za-z0-9_]/g) ?? [];
  const candidates = new Set(
    tokens
      .map((t) => t.replace(/^[.:]+|[.:]+$/g, ''))
      .filter((t) => t.length >= 3 && (/[A-Z]/.test(t.slice(1)) || /[.:]/.test(t) || t.length >= 4)),
  );
  if (candidates.size === 0) return [];
  const leaves = new Map<string, string>();
  for (const qn of qualifiedNames) {
    const leaf = qn.split(/::|\.|\//).filter(Boolean).pop() ?? qn;
    leaves.set(leaf.toLowerCase(), qn);
    leaves.set(qn.toLowerCase(), qn);
  }
  const found = new Set<string>();
  for (const c of candidates) {
    const lc = c.toLowerCase();
    const hit = leaves.get(lc) ?? leaves.get(lc.split(/::|\./).pop() ?? lc);
    if (hit && !/^(the|and|what|where|which|does|return|defined|take|file|does|how|why)$/i.test(c)) found.add(c);
  }
  return [...found];
}

/** Turn Jev's answers into a decision. Pure; exported for tests. */
export function decisionFromAnswers(
  answers: Record<string, unknown>,
  minConfidence: number,
  model: string,
  ms: number,
): AskRouteDecision | null {
  const route = pickChoice(answers.route);
  if (!route || (route.choice !== 'direct' && route.choice !== 'rlm')) return null;
  const identP = noulProbability(answers.identifier) ?? 0;
  const confidence = typeof route.confidence === 'number' ? route.confidence : 0;
  return {
    route: route.choice,
    confidence,
    identifier: identP >= 0.5,
    identifierProbability: identP,
    probabilities: route.probabilities ?? {},
    model,
    ms,
    decisive: confidence >= minConfidence,
  };
}

// ─── Gate 2: does the plan cover the question? ──────────────────────────────
//
// A plan that misses the symbol the question names, or spends three of its
// four sub-questions on the same concept, is the usual reason a gather comes
// back empty and the combine rounds start from nothing. The facts Jev needs
// are computed here: which identifiers from the question the plan searches
// for, and how many distinct queries it has.

export interface PlanCheckInput {
  question: string;
  restated: string;
  subQuestions: Array<{ question: string; tool: string; query: string }>;
}

export type PlanMissing = 'none' | 'identifier' | 'behaviour' | 'flow';

export interface PlanCheckDecision {
  /** 0–1 from Jev's Score: how well the sub-questions cover what was asked. */
  coverage: number;
  missing: PlanMissing;
  /** Identifiers named in the question that no sub-question searches for (code fact). */
  identifiersNotSearched: string[];
  confidence: number;
  model: string;
  ms: number;
  /** True when the confidence cleared `minConfidence` and the caller may act on it. */
  decisive: boolean;
}

/**
 * Score criteria are a LIST, best first; the API answers with an index into
 * it (0 = first item, fractional between items) plus `probabilities` per
 * index — NOT a 0–1 fraction. An object here is a 422 (`criteria: Input should
 * be a valid list`), which is what every plan gate call returned on
 * 2026-09-30 until this was fixed. `coverageFromScore` maps the index back to
 * 0–1 (0 → 1.0, last → 0.0).
 */
export const PLAN_COVERAGE_CRITERIA: readonly string[] = [
  'Every aspect of the question has a targeted search; every named identifier is searched; queries are distinct.',
  'The main concept is searched but a named identifier or one asked-about aspect (callers, flow, state) has no search.',
  'The searches would not find what the question is about — wrong concept, all duplicates, or the named symbol is absent.',
];

export const PLAN_CHECK_QUESTIONS: Record<string, JevQuestion> = {
  coverage: {
    type: 'score',
    instructions: {
      question:
        'A research planner decomposed `question` into `subQuestions` (each a search tool and a short query). '
        + '`identifiersNotSearched` lists identifiers the question names that NO sub-question searches for (computed by code, reliable); '
        + '`distinctQueries` is how many different queries the plan has. '
        + 'Score how well running these searches would gather what is needed to answer `question` correctly.',
    },
    criteria: [...PLAN_COVERAGE_CRITERIA],
  },
  missing: {
    type: 'choice',
    instructions: {
      question: 'What, if anything, is the plan missing to answer `question`?',
    },
    criteria: {
      none: { covers: 'Nothing important is missing.' },
      identifier: { covers: 'A function, type, file or tag the question names has no search_symbols/search_files sub-question.' },
      behaviour: { covers: 'The question asks what something DOES or HOW it works and no sub-question searches that behaviour.' },
      flow: { covers: 'The question asks about callers, callees, a sequence or an end-to-end path and no sub-question follows it.' },
    },
  },
};

/** Does `id` look like a file name (has a source/doc extension)? Pure. */
export function looksLikeFileName(id: string): boolean {
  return /\.(xeto|trio|fan|md|ts|tsx|js|json|axon|txt|html|css|yaml|yml)$/i.test(id);
}

/**
 * The tool that can find an identifier the plan missed.
 * - A symbol (`ConnPoller.onStart`, `pollMode`, `ph.lib`) → `search_symbols`.
 * - A file name that IS an indexed source path (`ConnExt.fan`) → `search_files`,
 *   which returns the file and the symbols it defines.
 * - A file name that is NOT indexed (`funcs.xeto`, `doc.md` — files convert4
 *   GENERATES; they exist only as string literals in its source) →
 *   `search_code`, the full-text leg that finds the literal. `search_files`
 *   on those answered "no indexed file path contains …" (2026-09-30).
 * `isIndexedPath` is the caller's lookup; without one a file name goes to
 * search_files. Pure; exported for tests.
 */
export function toolForIdentifier(
  id: string,
  isIndexedPath?: (id: string) => boolean,
): 'search_files' | 'search_symbols' | 'search_code' {
  if (!looksLikeFileName(id)) return 'search_symbols';
  if (!isIndexedPath) return 'search_files';
  return isIndexedPath(id) ? 'search_files' : 'search_code';
}

/** Identifier-looking tokens of the question that appear in none of the plan's queries. Pure; exported for tests. */
export function identifiersNotInPlan(question: string, queries: string[]): string[] {
  const tokens = question.match(/[A-Za-z_][A-Za-z0-9_.:]*[A-Za-z0-9_]/g) ?? [];
  const ids = new Set(
    tokens
      .map((t) => t.replace(/^[.:]+|[.:]+$/g, ''))
      .filter((t) => t.length >= 3 && (/[A-Z]/.test(t.slice(1)) || /[.:]/.test(t)))
      .filter((t) => !/^(the|and|what|where|which|does|how|why|when|from|into|with|that|this)$/i.test(t)),
  );
  if (ids.size === 0) return [];
  const hay = queries.map((q) => q.toLowerCase());
  return [...ids].filter((id) => {
    const lc = id.toLowerCase();
    // A dotted/qualified name is searched when ANY of its segments is: a
    // query for `ConnPoller` finds `ConnPoller.onStart`, and so does `onStart`.
    const parts = lc.split(/::|\./).filter((p) => p.length >= 3);
    return !hay.some((q) => q.includes(lc) || parts.some((p) => q.includes(p)));
  });
}

/** Index into a best-first criteria list → 0–1 coverage. Pure; exported for tests. */
export function coverageFromScore(score: number, criteriaCount: number): number {
  if (criteriaCount <= 1) return 1;
  const clamped = Math.min(criteriaCount - 1, Math.max(0, score));
  return 1 - clamped / (criteriaCount - 1);
}

/** Pure; exported for tests. */
export function planDecisionFromAnswers(
  answers: Record<string, unknown>,
  identifiersNotSearched: string[],
  minConfidence: number,
  model: string,
  ms: number,
  criteriaCount: number = PLAN_COVERAGE_CRITERIA.length,
): PlanCheckDecision | null {
  const cov = answers.coverage as JevScoreAnswer | undefined;
  const miss = pickChoice(answers.missing);
  if (!cov || cov.type !== 'score' || typeof cov.score !== 'number') return null;
  const missing: PlanMissing = miss && ['none', 'identifier', 'behaviour', 'flow'].includes(miss.choice) ? (miss.choice as PlanMissing) : 'none';
  const confidence = typeof cov.confidence === 'number' ? cov.confidence : 0;
  return {
    coverage: coverageFromScore(cov.score, criteriaCount),
    missing, identifiersNotSearched, confidence, model, ms,
    decisive: confidence >= minConfidence,
  };
}

/**
 * Ask Jev whether the RLM plan covers the question. Null when Jev is off, has
 * no key, fails, or answers something unusable. Advisory: the caller decides
 * what to add; today it appends a search_symbols sub-question per identifier
 * the plan missed.
 */
export async function checkPlan(input: PlanCheckInput, opts: { fetchImpl?: JevFetch } = {}): Promise<PlanCheckDecision | null> {
  const settings = getJevSettings();
  if (!settings.enabled || !settings.hasKey) return null;
  const queries = input.subQuestions.map((s) => s.query);
  const identifiersNotSearched = identifiersNotInPlan(input.question, queries);
  const state = {
    question: input.question,
    restated: input.restated,
    subQuestions: input.subQuestions.map((s) => ({ tool: s.tool, query: s.query, asks: s.question })),
    identifiersNotSearched,
    distinctQueries: new Set(queries.map((q) => q.toLowerCase().trim())).size,
  };
  const res = await jevAsk(state, PLAN_CHECK_QUESTIONS, { fetchImpl: opts.fetchImpl });
  if (!res) return null;
  const d = planDecisionFromAnswers(res.answers, identifiersNotSearched, settings.minConfidence, res.model, res.ms);
  if (!d) { console.warn('[jev] plan answer unusable — keeping the plan as is'); return null; }
  console.log(
    `[jev] plan coverage=${d.coverage.toFixed(2)} missing=${d.missing} conf=${d.confidence.toFixed(2)}${d.decisive ? '' : ` (below ${settings.minConfidence}, not applied)`}`
    + ` identifiersNotSearched=[${identifiersNotSearched.join(', ')}] subQuestions=${input.subQuestions.length} model=${d.model} ms=${d.ms}`,
  );
  return d;
}

/**
 * Symbols and files named in evidence blocks. Every RLM tool renders a hit as
 * `name (type) path:line` on its first line (answerSynthesis.ts:173), so the
 * header is the whole parse. Pure; exported for tests.
 */
export function evidenceSymbolsAndFiles(evidence: string): { symbols: string[]; files: string[] } {
  const symbols = new Set<string>();
  const files = new Set<string>();
  for (const block of evidence.split(/\n\s*\n(?=\S)/)) {
    const header = block.split('\n', 1)[0]?.trim() ?? '';
    const m = /^(\S+)\s+\([^)]*\)\s+(\S+?)(?::\d+)?\s*$/.exec(header) ?? /^(\S+)\s+(\S+?):\d+\s*$/.exec(header);
    if (!m) continue;
    symbols.add(m[1]);
    files.add(m[2]);
  }
  return { symbols: [...symbols], files: [...files] };
}

// ─── Gate 3: is the gathered evidence enough to answer? ─────────────────────
//
// The combine loop runs up to maxRounds tool rounds and lets the model decide
// when to stop. Two failure modes cost real time: the model answers thin after
// round 1 when the evidence is not there yet, or takes a second round when
// round 1 already held the answer. Jev sees a summary of what the evidence
// contains (symbol names, files, char counts — computed here) and the
// question, and says whether it is enough.

export interface EvidenceCheckInput {
  question: string;
  /** Symbols (qualified names) present in the evidence, deduped. */
  symbolsFound: string[];
  filesFound: string[];
  evidenceChars: number;
  usefulHits: number;
  round: number;
  maxRounds: number;
}

export interface EvidenceCheckDecision {
  sufficient: boolean;
  probability: number;
  /** Identifiers the question names that the evidence does not contain (code fact). */
  namedSymbolsMissing: string[];
  model: string;
  ms: number;
  decisive: boolean;
}

export const EVIDENCE_CHECK_QUESTIONS: Record<string, JevQuestion> = {
  sufficient: {
    type: 'noul',
    instructions:
      'A code-search agent gathered evidence to answer `question`. `symbolsFound` and `filesFound` are what the evidence contains; '
      + '`namedSymbolsMissing` lists identifiers the question names that are NOT in the evidence (computed by code, reliable); '
      + '`evidenceChars` is its size. Is this evidence enough to write a correct, cited answer to `question` now — '
      + 'without another search? Answer no when a named symbol is missing, when the question asks about a flow or callers '
      + 'and only one side of it is present, or when the evidence is empty.',
  },
};

/** Pure; exported for tests. */
export function evidenceDecisionFromAnswers(
  answers: Record<string, unknown>,
  namedSymbolsMissing: string[],
  minConfidence: number,
  model: string,
  ms: number,
): EvidenceCheckDecision | null {
  const p = noulProbability(answers.sufficient);
  if (p === null) return null;
  // A noul has no separate confidence: distance from 0.5 is the certainty.
  const certainty = Math.abs(p - 0.5) * 2;
  return { sufficient: p >= 0.5, probability: p, namedSymbolsMissing, model, ms, decisive: certainty >= minConfidence };
}

/**
 * Ask Jev whether the evidence gathered so far answers the question. Null
 * when Jev is off, has no key, fails, or answers something unusable.
 */
export async function checkEvidence(input: EvidenceCheckInput, opts: { fetchImpl?: JevFetch } = {}): Promise<EvidenceCheckDecision | null> {
  const settings = getJevSettings();
  if (!settings.enabled || !settings.hasKey) return null;
  const namedSymbolsMissing = identifiersNotInPlan(input.question, input.symbolsFound);
  const state = {
    question: input.question,
    symbolsFound: input.symbolsFound.slice(0, 40),
    filesFound: input.filesFound.slice(0, 20),
    namedSymbolsMissing,
    evidenceChars: input.evidenceChars,
    usefulHits: input.usefulHits,
    round: input.round,
    maxRounds: input.maxRounds,
  };
  const res = await jevAsk(state, EVIDENCE_CHECK_QUESTIONS, { fetchImpl: opts.fetchImpl });
  if (!res) return null;
  const d = evidenceDecisionFromAnswers(res.answers, namedSymbolsMissing, settings.minConfidence, res.model, res.ms);
  if (!d) { console.warn('[jev] evidence answer unusable — keeping the loop as is'); return null; }
  console.log(
    `[jev] evidence sufficient=${d.sufficient ? 'yes' : 'no'}(${d.probability.toFixed(2)})${d.decisive ? '' : ' (uncertain, not applied)'}`
    + ` namedSymbolsMissing=[${namedSymbolsMissing.join(', ')}] symbols=${input.symbolsFound.length} chars=${input.evidenceChars} round=${input.round}/${input.maxRounds} model=${d.model} ms=${d.ms}`,
  );
  return d;
}

/**
 * Ask Jev whether this question needs the RLM loop. Null when Jev is off,
 * has no key, fails, or answers something unusable.
 */
export async function decideAskRoute(input: AskRouteInput, opts: { fetchImpl?: JevFetch } = {}): Promise<AskRouteDecision | null> {
  const settings = getJevSettings();
  if (!settings.enabled || !settings.hasKey) return null;
  const hits = input.hits.slice(0, 8);
  const state = {
    question: input.question,
    ...(input.projectName ? { project: input.projectName } : {}),
    ...(input.versionGroup ? { versionGroup: input.versionGroup } : {}),
    hits: hits.map((h) => ({ symbol: h.qualifiedName, kind: h.nodeType, file: h.filePath })),
    // Known rule, kept in code: which identifiers the question names are
    // already among the hits. Jev gets the fact, not the job of matching.
    namedSymbolsFound: namedSymbolsInHits(input.question, hits.map((h) => h.qualifiedName)),
  };
  const res = await jevAsk(state, ASK_ROUTE_QUESTIONS, { fetchImpl: opts.fetchImpl });
  if (!res) return null;
  const d = decisionFromAnswers(res.answers, settings.minConfidence, res.model, res.ms);
  if (!d) {
    console.warn('[jev] route answer unusable — keeping the default route');
    return null;
  }
  console.log(
    `[jev] route=${d.route} conf=${d.confidence.toFixed(2)}${d.decisive ? '' : ` (below ${settings.minConfidence}, not applied)`}`
    + ` identifier=${d.identifier ? 'yes' : 'no'}(${d.identifierProbability.toFixed(2)})`
    + ` namedSymbolsFound=[${state.namedSymbolsFound.join(', ')}] hits=${hits.length} model=${d.model} ms=${d.ms}`
    + ` q="${input.question.slice(0, 80)}"`,
  );
  return d;
}
