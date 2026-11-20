/**
 * Decision model choice for the Jev gates: TypeSafe Jev (default) or
 * Cloudflare Clef on OpenRouter. Both take `{ model, state, questions }` and
 * return the same typed answers, so jevGates.ts calls `decisionAsk` and does
 * not care which one runs.
 *
 * Setting: `semanticSearch.decisionModel = { provider: 'jev' | 'clef', clefModel }`
 * in config/fantomMcpServer-config.json. Missing or bad value = 'jev'.
 * `minConfidence` and `timeoutMs` stay in `semanticSearch.jev` for both.
 *
 * With 'jev' every call goes to jevAsk / getJevSettings unchanged.
 * Selecting 'clef' is the opt-in; it needs only the OpenRouter key.
 */
import path from 'path';
import { atomicWriteConfigFile, readConfigFileWithRecovery } from '../../config/index.js';
import { getJevSettings, jevAsk, JEV_DEFAULT_MODEL, type JevFetch, type JevQuestion, type JevResponse, type JevSettings } from './jevClient.js';
import { clefAsk, clefAskDetailed, clefKey, normalizeClefModel, scrubKey, CLEF_DEFAULT_MODEL, CLEF_MODELS } from './clefClient.js';

export type DecisionProvider = 'jev' | 'clef';
export const DECISION_PROVIDERS: DecisionProvider[] = ['jev', 'clef'];

export interface DecisionModelSettings {
  provider: DecisionProvider;
  clefModel: string;
}

/** JevSettings plus which provider is active and why it is off, if it is. */
export interface DecisionSettings extends JevSettings {
  provider: DecisionProvider;
  whyNot?: string;
}

const DEFAULTS: DecisionModelSettings = { provider: 'jev', clefModel: CLEF_DEFAULT_MODEL };

let configPathOverride: string | null = null;
/** Tests only: read and write this file instead of the runtime config. */
export function setDecisionModelConfigPathForTests(p: string | null): void { configPathOverride = p; }

function configPath(): string {
  return configPathOverride ?? path.resolve(process.cwd(), 'config', 'fantomMcpServer-config.json');
}

function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Only `cloudflare/clef*` ids (clef, clef-flash, later members). */
function validClefModel(m: unknown): string | null {
  const full = normalizeClefModel(m);
  return full && /^cloudflare\/clef[a-z0-9._-]*$/i.test(full) ? full : null;
}

export function getDecisionModelSettings(): DecisionModelSettings {
  let raw: unknown;
  try { raw = readConfigFileWithRecovery(configPath())?.semanticSearch?.decisionModel; } catch { raw = undefined; }
  if (!isObj(raw)) return { ...DEFAULTS };
  return {
    provider: raw.provider === 'clef' ? 'clef' : 'jev',
    clefModel: validClefModel(raw.clefModel) ?? DEFAULTS.clefModel,
  };
}

export class DecisionModelValidationError extends Error {}

/**
 * Validate and save. Touches only `semanticSearch.decisionModel`, through the
 * crash-safe reader and writer. A field left out keeps its saved value.
 */
export function saveDecisionModelSettings(input: unknown): DecisionModelSettings {
  if (!isObj(input)) throw new DecisionModelValidationError('body must be an object');
  const cur = getDecisionModelSettings();
  const next: DecisionModelSettings = { ...cur };
  if (input.provider !== undefined) {
    if (input.provider !== 'jev' && input.provider !== 'clef') {
      throw new DecisionModelValidationError(`provider must be one of ${DECISION_PROVIDERS.join(', ')}`);
    }
    next.provider = input.provider;
  }
  if (input.clefModel !== undefined && input.clefModel !== '') {
    const m = validClefModel(input.clefModel);
    if (!m) throw new DecisionModelValidationError('clefModel must be a cloudflare/clef* model id, e.g. cloudflare/clef-flash');
    next.clefModel = m;
  }
  const p = configPath();
  const file = readConfigFileWithRecovery(p) ?? {};
  const ss = isObj(file.semanticSearch) ? file.semanticSearch : {};
  ss.decisionModel = { provider: next.provider, clefModel: next.clefModel };
  file.semanticSearch = ss;
  atomicWriteConfigFile(p, file);
  return next;
}

/** Settings the gates check before a call. Same fields as getJevSettings. */
export function getDecisionSettings(): DecisionSettings {
  const jev = getJevSettings();
  const dm = getDecisionModelSettings();
  if (dm.provider === 'jev') {
    const whyNot = !jev.enabled ? 'not enabled on LLM Providers' : !jev.hasKey ? 'no TYPESAFE_API_KEY' : undefined;
    return { ...jev, provider: 'jev', whyNot };
  }
  const hasKey = !!clefKey();
  return {
    enabled: true,
    hasKey,
    model: dm.clefModel,
    minConfidence: jev.minConfidence,
    timeoutMs: jev.timeoutMs,
    provider: 'clef',
    whyNot: hasKey ? undefined : 'no OpenRouter key',
  };
}

/** Selected provider is ready (enabled and has a key). */
export function decisionAvailable(): boolean {
  const s = getDecisionSettings();
  return s.enabled && s.hasKey;
}

/** The call the gates make. Null on any failure, like jevAsk. */
export async function decisionAsk(
  state: unknown,
  questions: Record<string, JevQuestion>,
  opts: { timeoutMs?: number; fetchImpl?: JevFetch } = {},
): Promise<JevResponse | null> {
  const dm = getDecisionModelSettings();
  if (dm.provider === 'jev') return jevAsk(state, questions, opts);
  const timeoutMs = opts.timeoutMs ?? getJevSettings().timeoutMs;
  return clefAsk(state, questions, { ...opts, timeoutMs, model: dm.clefModel });
}

export interface DecisionTestResult {
  ok: boolean;
  ms: number;
  provider: DecisionProvider;
  model: string;
  /** Yes-probability for the probe statement (should be high). */
  answer?: number;
  error?: string;
}

const PROBE_STATE = { statement: 'Water is wet.' };
const PROBE_QUESTIONS: Record<string, JevQuestion> = {
  ok: { type: 'noul', instructions: 'Is the statement true?' },
};

function probeAnswer(res: JevResponse): number | undefined {
  const a = res.answers.ok as { noul?: unknown; probability?: unknown } | undefined;
  if (typeof a?.noul === 'number') return a.noul;
  if (typeof a?.probability === 'number') return a.probability;
  return undefined;
}

/**
 * One tiny live decision with the given provider (not the saved one).
 * Never throws; the key never appears in `error`.
 */
export async function testDecisionModel(
  provider: DecisionProvider,
  opts: { fetchImpl?: JevFetch; clefModel?: string; timeoutMs?: number } = {},
): Promise<DecisionTestResult> {
  const timeoutMs = opts.timeoutMs ?? Math.max(getJevSettings().timeoutMs, 10_000);
  if (provider === 'clef') {
    const model = validClefModel(opts.clefModel) ?? getDecisionModelSettings().clefModel;
    const r = await clefAskDetailed(PROBE_STATE, PROBE_QUESTIONS, { model, timeoutMs, fetchImpl: opts.fetchImpl });
    if (!r.ok) return { ok: false, ms: r.ms, provider, model, error: r.error };
    const answer = probeAnswer(r.res);
    return answer === undefined
      ? { ok: false, ms: r.res.ms, provider, model: r.res.model, error: 'no noul answer in reply' }
      : { ok: true, ms: r.res.ms, provider, model: r.res.model, answer };
  }
  const jev = getJevSettings();
  const model = jev.model || JEV_DEFAULT_MODEL;
  if (!jev.hasKey) return { ok: false, ms: 0, provider, model, error: 'no TYPESAFE_API_KEY' };
  const t0 = Date.now();
  try {
    const res = await jevAsk(PROBE_STATE, PROBE_QUESTIONS, { fetchImpl: opts.fetchImpl, timeoutMs });
    if (!res) return { ok: false, ms: Date.now() - t0, provider, model, error: 'Jev call failed (see server log)' };
    const answer = probeAnswer(res);
    return answer === undefined
      ? { ok: false, ms: res.ms, provider, model: res.model, error: 'no noul answer in reply' }
      : { ok: true, ms: res.ms, provider, model: res.model, answer };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, provider, model, error: scrubKey(String((err as Error)?.message ?? err)) };
  }
}

/** For the dashboard: choices and readiness, never a key. */
export function describeDecisionModel(): {
  settings: DecisionModelSettings;
  providers: DecisionProvider[];
  clefModels: string[];
  jev: { enabled: boolean; hasKey: boolean; model: string };
  clef: { hasKey: boolean };
  active: { provider: DecisionProvider; model: string; ready: boolean; whyNot?: string };
} {
  const settings = getDecisionModelSettings();
  const jev = getJevSettings();
  const active = getDecisionSettings();
  return {
    settings,
    providers: DECISION_PROVIDERS,
    clefModels: [...CLEF_MODELS],
    jev: { enabled: jev.enabled, hasKey: jev.hasKey, model: jev.model },
    clef: { hasKey: !!clefKey() },
    active: { provider: active.provider, model: active.model, ready: active.enabled && active.hasKey, whyNot: active.whyNot },
  };
}
