/**
 * RLM pipeline settings and the pure decisions an ask makes from them.
 *
 * Three engines can investigate a question before the final answer:
 *
 *   1. Fantom RLM  — the built-in plan/search/read loop (rlmToolLoop.ts).
 *   2. Jev checks  — TypeSafe Jev gates around it: the route gate (skip the
 *                    loop for a lookup) and the in-loop plan-coverage and
 *                    evidence checks.
 *   3. ss-rlm-sandbox — the container on a sidecar's :8101 that runs a whole
 *                    recursive session for ONE call. It gets the whole
 *                    question once, never one call per loop turn: nesting it
 *                    per turn timed out (commit 0fa026e).
 *
 * Stored under `semanticSearch.openRouter.rlmPipeline`. Every field has a
 * default that reproduces the behaviour before this setting existed, except
 * `sandboxMode`, which defaults to 'backup'.
 *
 * Nothing in this file does I/O, so every decision here is unit-tested.
 */

export type RlmSandboxMode = 'off' | 'backup' | 'always';
export const RLM_SANDBOX_MODES: Array<{ id: RlmSandboxMode; label: string }> = [
  { id: 'off', label: 'Off' },
  { id: 'backup', label: 'Only as backup' },
  { id: 'always', label: 'Always instead of Fantom RLM' },
];

export interface RlmPipelineSettings {
  /** Run Fantom's built-in RLM loop. */
  fantomRlm: boolean;
  /** Use Jev in the ask pipeline (route gate + in-loop checks). Jev also has
   *  to be enabled with a key on the LLM Providers page. */
  jevEnabled: boolean;
  /** In-loop check: does the plan cover the question? */
  jevPlanCoverage: boolean;
  /** In-loop check: is the evidence enough to stop early? */
  jevEvidence: boolean;
  sandboxMode: RlmSandboxMode;
  /** Whole-ask budget, seconds. Undefined = `answerSynthesis.budgetMs` or 120. */
  budgetSec?: number;
  /** Cap on the optional retrieval work (graph step, related projects), seconds. */
  retrievalCapSec: number;
  /** The sandbox is not started with less than this left, seconds. */
  sandboxMinSec: number;
}

export const DEFAULT_RETRIEVAL_CAP_SEC = 30;
/** A sandbox session was measured at 26-28 s; less than this is a sure timeout. */
export const DEFAULT_SANDBOX_MIN_SEC = 25;

export function defaultRlmPipeline(): RlmPipelineSettings {
  return {
    fantomRlm: true,
    jevEnabled: true,
    jevPlanCoverage: true,
    jevEvidence: true,
    sandboxMode: 'backup',
    retrievalCapSec: DEFAULT_RETRIEVAL_CAP_SEC,
    sandboxMinSec: DEFAULT_SANDBOX_MIN_SEC,
  };
}

export function isRlmSandboxMode(v: unknown): v is RlmSandboxMode {
  return v === 'off' || v === 'backup' || v === 'always';
}

function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 'on') return true;
  if (v === 'off') return false;
  return undefined;
}

function secs(v: unknown, min: number, max: number): number | undefined {
  if (v === '' || v === null || v === undefined) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Overlay the valid fields of `patch` on `base`. A missing, empty or invalid
 * field leaves the base value alone — the save route relies on this so an
 * untouched control never overwrites a stored value.
 */
export function mergeRlmPipeline(base: RlmPipelineSettings, patch: unknown): RlmPipelineSettings {
  const out: RlmPipelineSettings = { ...base };
  if (!patch || typeof patch !== 'object') return out;
  const p = patch as Record<string, unknown>;
  const fr = bool(p.fantomRlm); if (fr !== undefined) out.fantomRlm = fr;
  const je = bool(p.jevEnabled); if (je !== undefined) out.jevEnabled = je;
  const jp = bool(p.jevPlanCoverage); if (jp !== undefined) out.jevPlanCoverage = jp;
  const jv = bool(p.jevEvidence); if (jv !== undefined) out.jevEvidence = jv;
  if (isRlmSandboxMode(p.sandboxMode)) out.sandboxMode = p.sandboxMode;
  const b = secs(p.budgetSec, 20, 900); if (b !== undefined) out.budgetSec = b;
  const r = secs(p.retrievalCapSec, 5, 600); if (r !== undefined) out.retrievalCapSec = r;
  const m = secs(p.sandboxMinSec, 5, 600); if (m !== undefined) out.sandboxMinSec = m;
  return out;
}

/** Stored value → settings, with defaults for anything missing or bad. */
export function sanitizeRlmPipeline(raw: unknown): RlmPipelineSettings {
  return mergeRlmPipeline(defaultRlmPipeline(), raw);
}

// ── Stage reporting ───────────────────────────────────────────────────────

export type AskStageName = 'search' | 'jev' | 'fantom-rlm' | 'sandbox' | 'answer';
export type AskStageStatus = 'ran' | 'skipped' | 'off' | 'failed';
export interface AskStageReport {
  stage: AskStageName;
  status: AskStageStatus;
  reason: string;
  ms?: number;
}

const s = (ms: number): string => `${Math.max(0, Math.round(ms / 1000))}s`;

/** "no time left (12s of 120s)" — the one wording every stage uses. */
export function noTimeReason(msLeft: number, budgetMs: number, neededMs: number): string {
  return `no time left (${s(msLeft)} of ${s(budgetMs)}; needs ${s(neededMs)})`;
}

/** What the Fantom loop did, as far as the sandbox decision cares. */
export type FantomRlmOutcome =
  | 'useful'      // ran and gathered evidence or a draft
  | 'empty'       // ran, found nothing useful
  | 'failed'      // threw or timed out
  | 'no-host'     // no endpoint could drive it
  | 'not-needed'  // Jev said direct, or the ask turned RLM off
  | 'off'         // turned off in settings
  | 'no-time'     // skipped for budget
  | 'replaced';   // sandbox mode 'always'

export interface SandboxDecisionInput {
  mode: RlmSandboxMode;
  fantom: FantomRlmOutcome;
  msLeft: number;
  budgetMs: number;
  minSandboxMs: number;
  /** The sandbox needs a model; without one it cannot run. */
  hasModel: boolean;
  /** The sandbox needs its own low-limit key (never the main key). Default true. */
  hasSandboxKey?: boolean;
}

export function decideSandbox(i: SandboxDecisionInput): { run: boolean; status: AskStageStatus; reason: string } {
  if (i.mode === 'off') return { run: false, status: 'off', reason: 'sandbox off in settings' };
  if (i.fantom === 'not-needed') return { run: false, status: 'skipped', reason: 'RLM not needed for this ask' };
  if (i.mode === 'backup') {
    if (i.fantom === 'useful') return { run: false, status: 'skipped', reason: 'backup not needed — Fantom RLM found evidence' };
    if (i.fantom === 'off') return { run: false, status: 'skipped', reason: 'backup only — Fantom RLM is off in settings' };
    if (i.fantom === 'no-time') return { run: false, status: 'skipped', reason: 'backup not run — no time left after search' };
  }
  if (!i.hasModel) return { run: false, status: 'skipped', reason: 'no sandbox model set' };
  if (i.hasSandboxKey === false) return { run: false, status: 'skipped', reason: 'sandbox off: no sandbox key' };
  if (i.msLeft < i.minSandboxMs) {
    return { run: false, status: 'skipped', reason: noTimeReason(i.msLeft, i.budgetMs, i.minSandboxMs) };
  }
  const why = i.mode === 'always'
    ? 'always instead of Fantom RLM'
    : i.fantom === 'no-host' ? 'backup: no Fantom RLM host'
      : i.fantom === 'failed' ? 'backup: Fantom RLM failed'
        : 'backup: Fantom RLM found nothing useful';
  return { run: true, status: 'ran', reason: why };
}

/** The one-line settings summary shown at the top of the ask feed. */
export function describeSettings(x: {
  p: RlmPipelineSettings;
  rlmRoute: string;
  rlmModel?: string;
  jevAvailable: boolean;
  jevWhyNot?: string;
  minConfidence: number;
  sandboxModel?: string;
  budgetMs: number;
  retrievalCapMs: number;
  answerReserveMs: number;
}): string {
  const fantom = x.p.sandboxMode === 'always'
    ? 'Fantom RLM replaced by sandbox'
    : `Fantom RLM ${x.p.fantomRlm ? 'on' : 'off'} (route ${x.rlmRoute}${x.rlmModel ? `, ${x.rlmModel}` : ''})`;
  const jev = !x.p.jevEnabled
    ? 'Jev off'
    : x.jevAvailable
      ? `Jev on ≥${Math.round(x.minConfidence * 100)}%${x.p.sandboxMode === 'always' ? ' (route gate only)' : ''}`
      : `Jev on but ${x.jevWhyNot ?? 'unavailable'}`;
  const sb = `sandbox ${RLM_SANDBOX_MODES.find(m => m.id === x.p.sandboxMode)?.label.toLowerCase() ?? x.p.sandboxMode}`
    + (x.p.sandboxMode !== 'off' && x.sandboxModel ? ` (${x.sandboxModel})` : '');
  const mid = Math.max(0, x.budgetMs - x.retrievalCapMs - x.answerReserveMs);
  const budget = `budget ${s(x.budgetMs)}: search ≤${s(x.retrievalCapMs)} · RLM ~${s(mid)} · answer ${s(x.answerReserveMs)}`;
  return [fantom, jev, sb, budget].join(' · ');
}
