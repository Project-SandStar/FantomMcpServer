/**
 * Per-role OpenRouter activity: calls, tokens, spend, and what served them.
 *
 * This is the proof the wiring works. Without it, "OpenRouter is configured"
 * and "OpenRouter is actually serving requests" look identical from the admin
 * page, and the difference is hours of a rebuild going nowhere.
 *
 * In memory only, and deliberately so: it is a live view, not an accounting
 * ledger. `config/fantomMcpServer-config.json` already has three co-writers
 * and a history of losing dashboard settings; a per-call counter has no
 * business joining them. Counters roll at local midnight.
 *
 * SPEND is estimated from token counts and the catalogue price. OpenRouter's
 * own `/api/v1/credits` is authoritative and is surfaced next to it; this
 * figure exists so a per-role daily cap can be enforced BEFORE a call, which
 * a balance polled every few seconds cannot do.
 */

import type { FantomRole } from './openRouterModels.js';

export interface LastCall {
  at: number;
  durationMs: number;
  success: boolean;
  servedBy: string;
  error?: string;
}

export interface RoleActivity {
  role: FantomRole;
  callsToday: number;
  tokensToday: number;
  spendTodayUsd: number;
  inFlight: number;
  lastCall: LastCall | null;
  /** providerName → calls today. */
  callsByServedBy: Record<string, number>;
  /** Daily cap in USD; 0 or undefined means uncapped. */
  dailyCapUsd?: number;
  capped: boolean;
}

/** USD per million tokens, for the spend estimate. */
const PRICE_PER_M: Record<string, number> = {
  'qwen/qwen3-embedding-4b': 0.02,
  'qwen/qwen3-embedding-8b': 0.01,
  'openai/text-embedding-3-small': 0.02,
  'openai/text-embedding-3-large': 0.13,
  'google/gemini-embedding-001': 0.15,
  'qwen/qwen3-reranker-8b': 0.20,
};

/**
 * CHAT MODELS ARE DELIBERATELY ABSENT from the table above, and must stay out
 * until the call path exists.
 *
 * Embedding and rerank bill one direction, so one rate per model is exact.
 * Chat bills input and output at different rates — often 8x apart — while
 * `estimateSpendUsd` receives a single `totalTokens`. Pricing a 50k-input /
 * 500-output call entirely at the output rate would read $0.505 instead of
 * ~$0.068 for gpt-5.1-codex. "Conservative" is the right direction for a
 * spend cap, but an 8x overestimate would trip a cap the operator set from
 * the real price list, which is a worse failure than no estimate.
 *
 * Whoever wires the code-assistant role should split the token counts:
 * `noteCallFinished` needs prompt/completion separately, and the catalogue
 * already carries `priceIn` and `priceOut` per model, ready for it. Until
 * then a chat call contributes 0 to spend — which is accurate, because none
 * is ever made.
 */

const ROLES: FantomRole[] = ['code-embedding', 'embedding', 'reranker', 'code-assistant'];

interface Counters {
  calls: number;
  tokens: number;
  spend: number;
  inFlight: number;
  last: LastCall | null;
  byServedBy: Map<string, number>;
}

function blank(): Counters {
  return { calls: 0, tokens: 0, spend: 0, inFlight: 0, last: null, byServedBy: new Map() };
}

const counters = new Map<FantomRole, Counters>(ROLES.map(r => [r, blank()]));
const caps = new Map<FantomRole, number>();
let dayStamp = todayStamp();

function todayStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Roll the day's counters over at local midnight, lazily. */
function rollIfNewDay(): void {
  const now = todayStamp();
  if (now === dayStamp) return;
  dayStamp = now;
  for (const r of ROLES) {
    const c = counters.get(r)!;
    // Keep `last` across the roll: "never called" and "last called yesterday"
    // are different answers and the page shows both.
    counters.set(r, { ...blank(), last: c.last, inFlight: c.inFlight });
  }
}

function get(role: FantomRole): Counters {
  rollIfNewDay();
  let c = counters.get(role);
  if (!c) { c = blank(); counters.set(role, c); }
  return c;
}

export function estimateSpendUsd(model: string, tokens: number): number {
  const price = PRICE_PER_M[model];
  if (!price || !tokens) return 0;
  return (tokens / 1_000_000) * price;
}

export function noteCallStarted(role: FantomRole): void {
  get(role).inFlight++;
}

export function noteCallFinished(
  role: FantomRole,
  args: { servedBy: string; model: string; tokens?: number; durationMs: number; success: boolean; error?: string },
): void {
  const c = get(role);
  c.inFlight = Math.max(0, c.inFlight - 1);
  c.last = {
    at: Date.now(),
    durationMs: args.durationMs,
    success: args.success,
    servedBy: args.servedBy,
    error: args.error,
  };
  if (!args.success) return;
  c.calls++;
  const tokens = args.tokens ?? 0;
  c.tokens += tokens;
  c.spend += estimateSpendUsd(args.model, tokens);
  c.byServedBy.set(args.servedBy, (c.byServedBy.get(args.servedBy) ?? 0) + 1);
}

/** Daily caps, in USD per role. 0/undefined/blank = uncapped. */
export function setDailyCap(role: FantomRole, usd: number | null | undefined): void {
  if (usd === null || usd === undefined || !Number.isFinite(usd) || usd <= 0) caps.delete(role);
  else caps.set(role, usd);
}

export function getDailyCaps(): Partial<Record<FantomRole, number>> {
  const out: Partial<Record<FantomRole, number>> = {};
  for (const [r, v] of caps) out[r] = v;
  return out;
}

/**
 * Has this role spent its daily allowance? Checked BEFORE a call, which is
 * the only point at which a cap can actually prevent spend.
 */
export function isRoleCapped(role: FantomRole): boolean {
  const cap = caps.get(role);
  if (!cap) return false;
  return get(role).spend >= cap;
}

export function roleActivity(role: FantomRole): RoleActivity {
  const c = get(role);
  return {
    role,
    callsToday: c.calls,
    tokensToday: c.tokens,
    spendTodayUsd: c.spend,
    inFlight: c.inFlight,
    lastCall: c.last,
    callsByServedBy: Object.fromEntries(c.byServedBy),
    dailyCapUsd: caps.get(role),
    capped: isRoleCapped(role),
  };
}

export function allActivity(): RoleActivity[] {
  return ROLES.map(roleActivity);
}

export function spendTodayTotal(): number {
  rollIfNewDay();
  let t = 0;
  for (const r of ROLES) t += counters.get(r)!.spend;
  return t;
}

/** Test seam. */
export function __resetActivityForTest(): void {
  for (const r of ROLES) counters.set(r, blank());
  caps.clear();
  dayStamp = todayStamp();
}
