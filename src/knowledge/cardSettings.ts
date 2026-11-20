/**
 * Knowledge Graph Cards settings, under the top-level `knowledgeCards` key of
 * config/fantomMcpServer-config.json. Read through readConfigFileWithRecovery
 * (cached 2 s) and written with atomicWriteConfigFile, like every other writer
 * of that file.
 */
import path from 'path';
import { readConfigFileWithRecovery, atomicWriteConfigFile } from '../config/index.js';

export interface CardKinds {
  projects: boolean;
  pods: boolean;
  classes: boolean;
  functions: boolean;
}

export interface KnowledgeCardSettings {
  enabled: boolean;
  writerModel: string;
  checkerModel: string;
  answerModel: string;
  /** 'all' = every project; 'list' = only projectIds. */
  projectScope: 'all' | 'list';
  projectIds: number[];
  kinds: CardKinds;
  /** Smallest class / function (in source lines) that gets a card. */
  minLines: number;
  /** Most cards one build writes for one project (highest fan-in first). */
  maxCardsPerProject: number;
  checkPass: boolean;
  /** A card below this confidence is never served. */
  minConfidence: number;
  autoRefresh: boolean;
  useForAsks: boolean;
  /** Cosine similarity the best card must reach before the fast path answers. */
  matchThreshold: number;
  /** USD per UTC day for card building (writer + checker). 0 = no building. */
  dailyCapUsd: number;
  /** Card jobs one build keeps in flight (each also waits for a bulk worker). */
  concurrency: number;
  /** Card calls one sidecar host runs at once (sidecar models only), so card
   *  work cannot swamp a GPU that other roles share. */
  sidecarPerHostLimit: number;
}

export interface NumRange { min: number; max: number; def: number; step?: number }

export const CARD_LIMITS = {
  minLines: { min: 1, max: 500, def: 8 },
  maxCardsPerProject: { min: 1, max: 20_000, def: 300 },
  minConfidence: { min: 0, max: 1, def: 0.8, step: 0.01 },
  matchThreshold: { min: 0, max: 1, def: 0.55, step: 0.01 },
  dailyCapUsd: { min: 0, max: 1000, def: 2, step: 0.01 },
  concurrency: { min: 1, max: 8, def: 3 },
  sidecarPerHostLimit: { min: 1, max: 8, def: 1 },
} as const satisfies Record<string, NumRange>;

export const DEFAULT_WRITER_MODEL = 'qwen/qwen3.7-flash';
export const DEFAULT_CHECKER_MODEL = 'deepseek/deepseek-v4-flash';
export const DEFAULT_ANSWER_MODEL = 'deepseek/deepseek-v4-flash';

/** Offered in the dropdowns; each is checked live against /api/v1/models. */
export const CARD_MODEL_OPTIONS = [
  'qwen/qwen3.7-flash',
  // `z-ai/glm-5.3-flash:batch` is batch-API only (HTTP 404 on /chat/completions); use the plain id.
  'z-ai/glm-5.3-flash',
  'openai/gpt-oss-20b',
  'deepseek/deepseek-v4-flash',
];

/**
 * OpenRouter models this account refused (ZDR / data policy), learned from a
 * failed call; the picker shows them disabled with the reason. In memory only.
 */
const accountBlocked = new Map<string, string>();
export function noteAccountBlocked(model: string, message: string): void {
  if (!isSidecarModelId(model)) accountBlocked.set(model, /ZDR/i.test(message) ? 'blocked for this account by OpenRouter (ZDR policy)' : 'blocked for this account by OpenRouter (data policy)');
}
export function accountBlockedReason(model: string): string | undefined { return accountBlocked.get(model); }
export function __clearAccountBlockedForTest(): void { accountBlocked.clear(); }

const MODEL_ID = /^[a-z0-9._-]+\/[a-z0-9._:-]+$/i;

/**
 * Sidecar choices are stored by container as `sidecar/<container>` (e.g.
 * `sidecar/ss-completion`); the model is whatever that container serves on
 * each host (qwen3.5:9b today), read live. The prefix keeps them apart from
 * OpenRouter ids and passes MODEL_ID, so sanitizeCardSettings never swaps a
 * sidecar choice for a paid default.
 */
export const SIDECAR_MODEL_PREFIX = 'sidecar/';
/** Offered even when no sidecar runs them (shown disabled with a reason). */
export const SUGGESTED_SIDECAR_CONTAINERS = ['ss-completion'];

export function isSidecarModelId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(SIDECAR_MODEL_PREFIX) && id.length > SIDECAR_MODEL_PREFIX.length;
}
export function sidecarModelName(id: string): string { return id.slice(SIDECAR_MODEL_PREFIX.length); }
export function sidecarModelId(model: string): string { return `${SIDECAR_MODEL_PREFIX}${model}`; }

export const CARD_MODEL_FIELDS = ['writerModel', 'checkerModel', 'answerModel'] as const;

/**
 * Save-time check of model choices: an OpenRouter id must be in the catalogue
 * (`openRouterIds` null = catalogue unreachable, accept). A sidecar id is
 * generic (`sidecar/<container>`) and saves whether or not a host serves it
 * right now; each call finds a live host then. Only fields that differ from
 * the stored value are checked.
 */
export function validateModelChoices(
  raw: Record<string, unknown>,
  current: Pick<KnowledgeCardSettings, typeof CARD_MODEL_FIELDS[number]>,
  openRouterIds: Set<string> | null,
): string[] {
  const out: string[] = [];
  for (const f of CARD_MODEL_FIELDS) {
    const v = typeof raw[f] === 'string' ? (raw[f] as string).trim() : undefined;
    if (!v || v === current[f]) continue;
    if (isSidecarModelId(v)) continue;
    if (openRouterIds && !openRouterIds.has(v)) {
      out.push(`${f}: ${v} is not in the OpenRouter model list`);
    }
  }
  return out;
}

function clamp(v: unknown, r: NumRange, integer: boolean): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return r.def;
  const c = Math.min(r.max, Math.max(r.min, n));
  return integer ? Math.round(c) : c;
}

const INTEGER_FIELDS = new Set(['minLines', 'maxCardsPerProject', 'concurrency', 'sidecarPerHostLimit']);

export function sanitizeCardSettings(raw: unknown): KnowledgeCardSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const model = (v: unknown, def: string) => (typeof v === 'string' && MODEL_ID.test(v.trim()) ? v.trim() : def);
  const k = (o.kinds && typeof o.kinds === 'object' ? o.kinds : {}) as Record<string, unknown>;
  const num = (f: keyof typeof CARD_LIMITS) => clamp(o[f], CARD_LIMITS[f], INTEGER_FIELDS.has(f));
  return {
    enabled: o.enabled === true,
    writerModel: model(o.writerModel, DEFAULT_WRITER_MODEL),
    checkerModel: model(o.checkerModel, DEFAULT_CHECKER_MODEL),
    answerModel: model(o.answerModel, DEFAULT_ANSWER_MODEL),
    projectScope: o.projectScope === 'list' ? 'list' : 'all',
    projectIds: Array.isArray(o.projectIds)
      ? [...new Set(o.projectIds.map(Number).filter((n: number) => Number.isInteger(n) && n > 0))] as number[]
      : [],
    kinds: {
      projects: k.projects !== false,
      pods: k.pods !== false,
      classes: k.classes !== false,
      functions: k.functions !== false,
    },
    minLines: num('minLines'),
    maxCardsPerProject: num('maxCardsPerProject'),
    checkPass: o.checkPass !== false,
    minConfidence: num('minConfidence'),
    autoRefresh: o.autoRefresh === true,
    useForAsks: o.useForAsks === true,
    matchThreshold: num('matchThreshold'),
    dailyCapUsd: num('dailyCapUsd'),
    concurrency: num('concurrency'),
    sidecarPerHostLimit: num('sidecarPerHostLimit'),
  };
}

/** Range problems in user input, as plain messages (empty = ok). */
export function validateCardInput(raw: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [f, r] of Object.entries(CARD_LIMITS) as Array<[string, NumRange]>) {
    const v = raw[f];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    const integer = INTEGER_FIELDS.has(f);
    if (!Number.isFinite(n) || n < r.min || n > r.max || (integer && !Number.isInteger(n))) {
      out.push(`${f} must be ${integer ? 'a whole number' : 'a number'} from ${r.min} to ${r.max}`);
    }
  }
  for (const f of ['writerModel', 'checkerModel', 'answerModel']) {
    const v = raw[f];
    if (v !== undefined && (typeof v !== 'string' || !MODEL_ID.test(v.trim()))) out.push(`${f} must be an OpenRouter model id such as ${DEFAULT_WRITER_MODEL}, or ${SIDECAR_MODEL_PREFIX}<model> for a sidecar model`);
    else if (typeof v === 'string' && /:batch$/.test(v.trim())) out.push(`${f}: ${v.trim()} is batch-API only; OpenRouter does not serve it on chat/completions`);
  }
  if (raw.projectScope !== undefined && raw.projectScope !== 'all' && raw.projectScope !== 'list') out.push("projectScope must be 'all' or 'list'");
  if (raw.projectIds !== undefined && !Array.isArray(raw.projectIds)) out.push('projectIds must be a list of project ids');
  return out;
}

export function cardConfigPath(): string {
  return path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');
}

const CACHE_MS = 2_000;
let cached: { at: number; value: KnowledgeCardSettings } | null = null;
let override: KnowledgeCardSettings | null = null;

export function getCardSettings(): KnowledgeCardSettings {
  if (override) return override;
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  let raw: unknown;
  try { raw = readConfigFileWithRecovery(cardConfigPath())?.knowledgeCards; } catch { raw = undefined; }
  const value = sanitizeCardSettings(raw);
  cached = { at: Date.now(), value };
  return value;
}

const SETTING_KEYS = new Set<string>(Object.keys(sanitizeCardSettings({})));

/**
 * Partial update: only known keys that are present (not undefined / null /
 * '') are changed; every other stored value stays as it is. A save from an
 * old or partly loaded form cannot flip a field it did not send.
 */
export function cardSettingsPatch(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (!SETTING_KEYS.has(k) || v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out;
}

/** Merge `patch` (partial, see cardSettingsPatch) onto the stored settings and write the file. */
export function saveCardSettings(rawPatch: Record<string, unknown>): KnowledgeCardSettings {
  const patch = cardSettingsPatch(rawPatch);
  const file = cardConfigPath();
  const cur = readConfigFileWithRecovery(file) ?? {};
  const prev = sanitizeCardSettings(cur.knowledgeCards);
  const merged = sanitizeCardSettings({
    ...prev,
    ...patch,
    kinds: { ...prev.kinds, ...((patch.kinds as object) ?? {}) },
  });
  atomicWriteConfigFile(file, { ...cur, knowledgeCards: merged });
  cached = null;
  return merged;
}

/** Is this project in the card-building scope? */
export function projectInScope(projectId: number, s = getCardSettings()): boolean {
  return s.projectScope === 'all' || s.projectIds.includes(projectId);
}

export function __setCardSettingsForTest(s: Partial<KnowledgeCardSettings> | null): void {
  override = s ? { ...sanitizeCardSettings({}), ...s } : null;
  cached = null;
}
