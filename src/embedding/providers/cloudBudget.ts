/**
 * ONE global permit pool for every OpenRouter-backed call.
 *
 * The trap this exists to avoid: every sidecar Fantom pushes config to gets
 * the SAME OpenRouter key, and OpenRouter rate-limits per key, not per
 * caller. Three `<PCName>-OR-CodeEmbedding` providers each capped at 8
 * in-flight is 24 requests against one shared budget. A per-provider cap
 * therefore cannot protect the limit — the cap has to live here, above all of
 * them, held by the master.
 *
 * **The permit unit is one concurrent cloud request.** That is what the pool
 * hands out and what the manual override on the admin page sets. A discovered
 * `rate_limit {requests, interval}` is a REQUESTS-PER-MINUTE figure, not a
 * concurrency figure, so it is converted using the pool's own measured
 * round-trip latency:
 *
 *     concurrency ≈ (requests per second) × (mean seconds per request)
 *
 * which is Little's Law, and it re-derives itself as latency drifts. A
 * BELIEVED RPM is also enforced directly as a sliding-window second gate, so a
 * latency estimate that is briefly too high cannot overrun the account.
 *
 * That second gate is only armed for an RPM we trust. A funded account whose
 * `/key` reports a degenerate `rate_limit` — or none at all, which is the
 * modern shape — is sized from its credit balance instead, and then has no
 * window gate: nothing can be gated on a number nobody believes. What protects
 * the account there is the concurrency ceiling plus 429 adaptation (halve,
 * cool down, ramp back), and `rateLimitHits` in the stats says how often that
 * has had to fire. Arming the window on a vestigial 1/min was strictly worse:
 * it held the entire cloud fan-out to one request a minute.
 *
 * Local GPU providers never touch this module. A cloud backoff must not idle
 * the GPUs, and it cannot: `embedTextsPipelined` pulls work per provider, so
 * a blocked cloud provider simply stops pulling and the local ones keep
 * going.
 *
 * FAIRNESS: waiters are queued per project and served round-robin across
 * projects, so one large project in the section-2b worker pool cannot starve
 * the others behind a long FIFO of its own chunks.
 *
 * ADAPTIVE: a 429 (or any rate-limit-shaped error) halves the effective
 * budget and starts a jittered cooldown — never an immediate retry. A
 * sustained clean window ramps the budget back one permit at a time toward
 * the ceiling.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** Used when nothing could be discovered and the operator set no override.
 *  Deliberately small: assuming headroom we could not read is how you get a
 *  429 storm and a half-written table. */
export const CONSERVATIVE_DEFAULT_CONCURRENCY = 4;
/** A typo in the override box must not saturate the account. */
export const MAX_ALLOWED_CONCURRENCY = 256;

/**
 * Ceiling for a FUNDED account when `/key` gives no believable rate figure.
 *
 * Why a flat number and not something derived from the balance: OpenRouter
 * does not publish a requests-per-minute figure for paid traffic. Its limits
 * documentation lists exactly two rate limits — free-model request caps, and
 * DDoS protection — and points you at the `X-RateLimit-*` headers on a 429
 * rather than at `/api/v1/key`. The documented `Key` shape no longer carries
 * `rate_limit` at all. So there is no published function of balance to
 * evaluate; the honest statement is "funded accounts are not request-capped for
 * paid models, find the real ceiling by running into it".
 *
 * 16 is chosen to be worth having and cheap to be wrong about: enough to matter
 * beside BASWS35's measured 12-14 texts/s, small enough that overshooting costs
 * one halving. The adaptive limiter does the rest — a 429 halves the budget and
 * a clean window ramps it back — and an operator who knows their real ceiling
 * sets the manual override, which still wins over everything here.
 */
export const CREDITS_DERIVED_CONCURRENCY = 16;

/**
 * Below this, a `/key` rate figure on a FUNDED account is not believed.
 *
 * The case that forced it: a $100 account with $99.97 remaining reported
 * `discoveredRequestsPerMinute: 1`, which made `effectiveConcurrency` 1 AND
 * armed the sliding-window gate in `blockedFor()` at one request per minute —
 * the cloud provider contributed nothing at all. One request per minute is not
 * a rate limit anyone sells; it is a vestigial or zeroed field. Anything under
 * one request per second from a paying account is treated the same way.
 *
 * A free-tier key is NOT second-guessed: its low caps are real and documented.
 */
export const MIN_PLAUSIBLE_RPM_FUNDED = 60;
/** Seed latency before any request has completed (seconds). */
const INITIAL_LATENCY_S = 2;
/** Clean-window length that earns one permit back. */
const RAMP_INTERVAL_MS = 15_000;
/** Cooldown after a 429, before jitter. */
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;

export type LimiterState = 'steady' | 'ramping' | 'backing-off';

export interface CloudBudgetStats {
  /** What the pool is actually enforcing right now. */
  effectiveConcurrency: number;
  /** The ceiling it may ramp back to. */
  ceilingConcurrency: number;
  inFlight: number;
  queued: number;
  queuedProjects: number;
  state: LimiterState;
  rateLimitHits: number;
  /** What `/key`'s `rate_limit` implied, verbatim, believable or not. Shown so
   *  the operator can see the raw signal rather than only our verdict on it. */
  discoveredRequestsPerMinute: number | null;
  /** The RPM the sliding-window gate actually enforces. null = not gated,
   *  either because nothing was discovered or because what was discovered is
   *  not believed (see MIN_PLAUSIBLE_RPM_FUNDED). */
  enforcedRequestsPerMinute: number | null;
  /** False when a reported RPM was discarded as implausible. */
  rateLimitTrusted: boolean;
  /** Concurrency implied by the ENFORCED RPM at the measured latency. */
  discoveredConcurrency: number | null;
  /** Ceiling implied by the account holding credits, when no rate figure is
   *  believable. See CREDITS_DERIVED_CONCURRENCY. */
  creditsDerivedConcurrency: number | null;
  /** Operator override, null when the box is blank. */
  manualConcurrency: number | null;
  source: 'manual' | 'discovered' | 'credits' | 'fallback';
  /** One sentence naming where the ceiling came from — render it next to the
   *  number. A budget figure with no stated provenance is how a 1/minute limit
   *  survived on a $100 account. */
  sourceDetail: string;
  meanLatencyMs: number;
  requestsLastMinute: number;
  backoffUntil: string | null;
  discovery: {
    ok: boolean; reason?: string; unsupported?: boolean; at: string | null;
    /** `/key`'s `rate_limit` exactly as OpenRouter returned it. Evidence, not
     *  input: nothing in this module's arithmetic reads it. */
    rawRateLimit?: unknown;
    /** Top-level keys the envelope carried, so a field that moved upstream is
     *  visible without dumping values. */
    envelopeKeys?: string[];
  };
  /** Balance as OpenRouter reports it, read through a sidecar. Authoritative
   *  for spend; the per-role figures in openRouterActivity are estimates that
   *  exist so a daily cap can be enforced BEFORE a call. */
  credits: { remaining: number | null; totalCredits: number | null; totalUsage: number | null } | null;
}

interface Waiter {
  projectId: number;
  resolve: () => void;
}

/** Which project the current async context is embedding for, so the pool can
 *  round-robin between them. Set by the section-2b worker pool. */
const projectCtx = new AsyncLocalStorage<number>();

export function runWithCloudBudgetProject<T>(projectId: number, fn: () => T): T {
  return projectCtx.run(projectId, fn);
}

/** Which project the current async context belongs to, or undefined outside
 *  one. Exposed so a test can prove the tag survives the scheduler's promise
 *  chains — if it did not, every waiter would fall into bucket 0 and the
 *  round-robin would silently degrade to FIFO. */
export function currentCloudBudgetProject(): number | undefined {
  return projectCtx.getStore();
}

class CloudBudget {
  private inFlight = 0;
  /** Waiters already woken but not yet back in acquire(). Counted against the
   *  limit so a burst of releases cannot wake more waiters than permits. */
  private pendingWakes = 0;
  /** projectId → FIFO of that project's waiters. */
  private queues = new Map<number, Waiter[]>();
  private rrOrder: number[] = [];
  private rrCursor = 0;

  private manual: number | null = null;
  private discoveredRpm: number | null = null;
  private discovery: CloudBudgetStats['discovery'] = { ok: false, at: null };
  private credits: CloudBudgetStats['credits'] = null;

  /** Halving target; starts at the ceiling. */
  private effective = CONSERVATIVE_DEFAULT_CONCURRENCY;
  private rateLimitHits = 0;
  private backoffUntil = 0;
  private backoffMs = BASE_BACKOFF_MS;
  private lastRampAt = Date.now();
  private state: LimiterState = 'steady';

  private latencyEwmaMs = INITIAL_LATENCY_S * 1000;
  /** Completion timestamps, for the sliding-window RPM gate. */
  private recent: number[] = [];

  // ---- configuration -------------------------------------------------

  /** Blank/undefined clears the override and returns to the discovered value. */
  setManualConcurrency(n: number | null | undefined): void {
    const next = n === null || n === undefined ? null : n;
    if (next !== null && !isValidConcurrency(next)) {
      throw new Error(
        `cloud budget override must be a whole number between 1 and ${MAX_ALLOWED_CONCURRENCY} (got ${next})`,
      );
    }
    this.manual = next;
    // Live-adjustable: take effect now, do not wait for a restart or the next
    // job. Raising it releases queued waiters immediately.
    this.effective = Math.min(this.effective, this.ceiling());
    if (next !== null) this.effective = next;
    this.pump();
  }

  getManualConcurrency(): number | null { return this.manual; }

  setDiscovered(
    rpm: number | null,
    discovery: CloudBudgetStats['discovery'],
    credits?: CloudBudgetStats['credits'],
  ): void {
    this.discoveredRpm = rpm;
    this.discovery = discovery;
    if (credits !== undefined) this.credits = credits;
    if (this.manual === null) {
      this.effective = Math.min(Math.max(this.effective, 1), this.ceiling());
      if (this.source() !== 'fallback') this.effective = this.ceiling();
    }
    this.pump();
  }

  /** Does the account hold money? Decides whether a tiny `/key` rate figure is
   *  believable and whether a credits-derived ceiling applies. */
  private funded(): boolean {
    return typeof this.credits?.remaining === 'number' && this.credits.remaining > 0;
  }

  /**
   * The reported RPM, if it is believable.
   *
   * A funded account reporting under one request per second is discarded: that
   * is not a limit OpenRouter sells, and `rate_limit` is absent from the
   * documented `/key` shape. A free-tier or unfunded key is taken at its word —
   * its low caps are real.
   */
  private trustedRpm(): number | null {
    if (this.discoveredRpm === null) return null;
    if (this.funded() && this.discoveredRpm < MIN_PLAUSIBLE_RPM_FUNDED) return null;
    return this.discoveredRpm;
  }

  /** Little's Law: how many may be in flight without exceeding the RPM. */
  private discoveredConcurrency(): number | null {
    const rpm = this.trustedRpm();
    if (rpm === null) return null;
    const perSecond = rpm / 60;
    const latencyS = Math.max(this.latencyEwmaMs, 50) / 1000;
    return clamp(Math.round(perSecond * latencyS), 1, MAX_ALLOWED_CONCURRENCY);
  }

  /** A funded account is not request-capped for paid models; start somewhere
   *  useful and let 429s and the ramp find the real ceiling. */
  private creditsDerivedConcurrency(): number | null {
    return this.funded() ? CREDITS_DERIVED_CONCURRENCY : null;
  }

  /**
   * Manual wins when set; then the more generous of a believable `/key` rate
   * figure and the credits-derived floor; then the conservative default.
   *
   * Taking the MAX of the two matters in both directions: a genuinely large
   * `rate_limit` (600/min on a provisioned key) is not thrown away, and a
   * vestigial one cannot drag a funded account down to a single request.
   */
  private ceiling(): number {
    if (this.manual !== null) return this.manual;
    const fromRate = this.discoveredConcurrency();
    const fromCredits = this.creditsDerivedConcurrency();
    if (fromRate !== null && fromCredits !== null) return Math.max(fromRate, fromCredits);
    return fromRate ?? fromCredits ?? CONSERVATIVE_DEFAULT_CONCURRENCY;
  }

  private source(): CloudBudgetStats['source'] {
    if (this.manual !== null) return 'manual';
    const fromRate = this.discoveredConcurrency();
    const fromCredits = this.creditsDerivedConcurrency();
    if (fromRate !== null && (fromCredits === null || fromRate >= fromCredits)) return 'discovered';
    if (fromCredits !== null) return 'credits';
    return 'fallback';
  }

  /** Where the ceiling came from, in a sentence the config page can render. */
  private sourceDetail(): string {
    const reported = this.discoveredRpm;
    const distrusted = reported !== null && this.trustedRpm() === null;
    const balance = typeof this.credits?.remaining === 'number'
      ? `$${this.credits.remaining.toFixed(2)}`
      : 'an unknown balance';
    switch (this.source()) {
      case 'manual':
        return `set by hand (${this.manual} concurrent) — overrides everything discovered`;
      case 'discovered':
        return `from the key's own rate limit: ${reported}/min at ${Math.round(this.latencyEwmaMs)}ms mean latency`;
      case 'credits':
        return distrusted
          ? `sized from the account balance (${balance}); the key's own rate_limit reported `
            + `${reported}/min, which OpenRouter no longer documents and is not believed for a funded account — `
            + `429s and the ramp find the real ceiling from here, or set the override`
          : `sized from the account balance (${balance}); the key reported no rate limit — `
            + `429s and the ramp find the real ceiling from here, or set the override`;
      default:
        return this.discovery.ok
          ? 'conservative default — nothing discoverable and no credits on the key'
          : `conservative default — ${this.discovery.reason ?? 'discovery has not succeeded'}`;
    }
  }

  // ---- permits -------------------------------------------------------

  async acquire(): Promise<void> {
    for (;;) {
      this.rampIfClean();
      const wait = this.blockedFor();
      if (wait === 0) { this.inFlight++; return; }
      if (wait > 0) {
        // Hard wait: a cooldown or the RPM window, not a free permit.
        await sleep(wait);
        continue;
      }
      // wait < 0 — no permit free; park until one is released.
      const projectId = projectCtx.getStore() ?? 0;
      await new Promise<void>(resolve => this.enqueue({ projectId, resolve }));
      this.pendingWakes = Math.max(0, this.pendingWakes - 1);
      // Re-check rather than trusting the wake-up: the budget may have been
      // halved between the release and this continuation.
    }
  }

  /** 0 = go, >0 = sleep this many ms, <0 = park on the queue. */
  private blockedFor(): number {
    const now = Date.now();
    if (now < this.backoffUntil) return this.backoffUntil - now;
    if (this.inFlight + this.pendingWakes >= Math.max(1, Math.min(this.effective, this.ceiling()))) return -1;
    // Gate on the TRUSTED rpm only. Arming this window with a vestigial
    // `rate_limit` of 1 held the whole cloud fan-out to one request a minute,
    // which is indistinguishable from cloud being switched off.
    const gateRpm = this.trustedRpm();
    if (gateRpm !== null) {
      this.trimWindow(now);
      if (this.recent.length >= gateRpm) {
        return Math.max(1, this.recent[0] + 60_000 - now);
      }
    }
    return 0;
  }

  release(latencyMs?: number): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const now = Date.now();
    this.recent.push(now);
    this.trimWindow(now);
    if (typeof latencyMs === 'number' && Number.isFinite(latencyMs) && latencyMs > 0) {
      // EWMA, α = 0.2 — smooth enough that one slow chunk does not collapse
      // the derived concurrency.
      this.latencyEwmaMs = this.latencyEwmaMs * 0.8 + latencyMs * 0.2;
    }
    this.pump();
  }

  /** Called when a cloud request came back 429 / rate-limited. */
  noteRateLimited(retryAfterMs?: number): void {
    this.rateLimitHits++;
    this.effective = Math.max(1, Math.floor(Math.min(this.effective, this.ceiling()) / 2));
    const base = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : this.backoffMs;
    // Full jitter — synchronised retries across providers are how one 429
    // becomes a thundering herd of them.
    const jittered = Math.random() * base;
    this.backoffUntil = Date.now() + base / 2 + jittered;
    this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);
    this.lastRampAt = Date.now();
    this.state = 'backing-off';
    console.warn(
      `[cloud-budget] 429 #${this.rateLimitHits} — effective budget halved to ${this.effective} `
      + `concurrent request(s), cooling down ~${Math.round((this.backoffUntil - Date.now()) / 100) / 10}s. `
      + 'Local GPU providers are unaffected.',
    );
  }

  private rampIfClean(): void {
    const now = Date.now();
    if (now < this.backoffUntil) { this.state = 'backing-off'; return; }
    const ceiling = this.ceiling();
    if (this.effective >= ceiling) {
      this.state = 'steady';
      this.backoffMs = BASE_BACKOFF_MS; // a full clean window at the ceiling resets the escalation
      return;
    }
    this.state = 'ramping';
    if (now - this.lastRampAt >= RAMP_INTERVAL_MS) {
      this.effective = Math.min(ceiling, this.effective + 1);
      this.lastRampAt = now;
      this.pump();
    }
  }

  private trimWindow(now: number): void {
    const cutoff = now - 60_000;
    while (this.recent.length && this.recent[0] < cutoff) this.recent.shift();
  }

  // ---- fair queue ----------------------------------------------------

  private enqueue(w: Waiter): void {
    let q = this.queues.get(w.projectId);
    if (!q) { q = []; this.queues.set(w.projectId, q); this.rrOrder.push(w.projectId); }
    q.push(w);
  }

  /** Wake as many waiters as there are free permits, round-robin by project. */
  private pump(): void {
    // Wake as many as there are free permits. `pendingWakes` holds the seat
    // for each woken waiter until it is actually back inside acquire(), so a
    // burst of releases — or the operator raising the override mid-rebuild —
    // cannot wake more waiters than there are permits.
    while (this.rrOrder.length > 0 && this.blockedFor() === 0) {
      const w = this.nextWaiter();
      if (!w) return;
      this.pendingWakes++;
      w.resolve();
    }
  }

  private nextWaiter(): Waiter | undefined {
    // Each pass either returns a waiter or RETIRES one drained project, so
    // this terminates without an index. It must not be written as a `for`
    // over `rrOrder.length`: retiring a project shrinks the array under the
    // loop counter, and the loop then exits while another project still has
    // waiters parked — stranding them with the pool idle.
    while (this.rrOrder.length > 0) {
      const pid = this.rrOrder[this.rrCursor % this.rrOrder.length];
      this.rrCursor++;
      const q = this.queues.get(pid);
      if (q && q.length) return q.shift();
      this.queues.delete(pid);
      this.rrOrder = this.rrOrder.filter(p => p !== pid);
    }
    return undefined;
  }

  // ---- reporting -----------------------------------------------------

  stats(): CloudBudgetStats {
    this.trimWindow(Date.now());
    let queued = 0;
    for (const q of this.queues.values()) queued += q.length;
    return {
      effectiveConcurrency: Math.max(1, Math.min(this.effective, this.ceiling())),
      ceilingConcurrency: this.ceiling(),
      inFlight: this.inFlight,
      queued,
      queuedProjects: this.queues.size,
      state: this.state,
      rateLimitHits: this.rateLimitHits,
      discoveredRequestsPerMinute: this.discoveredRpm,
      enforcedRequestsPerMinute: this.trustedRpm(),
      rateLimitTrusted: this.discoveredRpm === null || this.trustedRpm() !== null,
      discoveredConcurrency: this.discoveredConcurrency(),
      creditsDerivedConcurrency: this.creditsDerivedConcurrency(),
      manualConcurrency: this.manual,
      source: this.source(),
      sourceDetail: this.sourceDetail(),
      meanLatencyMs: Math.round(this.latencyEwmaMs),
      requestsLastMinute: this.recent.length,
      backoffUntil: this.backoffUntil > Date.now() ? new Date(this.backoffUntil).toISOString() : null,
      discovery: this.discovery,
      credits: this.credits,
    };
  }

  reset(): void {
    this.inFlight = 0;
    this.queues.clear();
    this.pendingWakes = 0;
    this.rrOrder = [];
    this.rrCursor = 0;
    this.manual = null;
    this.discoveredRpm = null;
    this.discovery = { ok: false, at: null };
    this.credits = null;
    this.effective = CONSERVATIVE_DEFAULT_CONCURRENCY;
    this.rateLimitHits = 0;
    this.backoffUntil = 0;
    this.backoffMs = BASE_BACKOFF_MS;
    this.lastRampAt = Date.now();
    this.state = 'steady';
    this.latencyEwmaMs = INITIAL_LATENCY_S * 1000;
    this.recent = [];
  }
}

const budget = new CloudBudget();

export function isValidConcurrency(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_ALLOWED_CONCURRENCY;
}

/** Does this error look like OpenRouter (or a proxy) saying "slow down"? */
export function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /\b429\b/.test(msg) || /rate[ _-]?limit/i.test(msg) || /too many requests/i.test(msg);
}

/** Pull a `Retry-After`-ish hint out of an error message, if present. */
export function retryAfterMsFrom(err: unknown): number | undefined {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const m = /retry[- ]?after[":\s]*(\d+(?:\.\d+)?)\s*(ms|s)?/i.exec(msg);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return (m[2] ?? 's').toLowerCase() === 'ms' ? n : n * 1000;
}

/**
 * Run one cloud call under a global permit. Every OpenRouter-backed request
 * in the tree goes through here — that is the whole point of the pool.
 */
export async function withCloudPermit<T>(fn: () => Promise<T>): Promise<T> {
  await budget.acquire();
  const started = Date.now();
  try {
    const out = await fn();
    budget.release(Date.now() - started);
    return out;
  } catch (err) {
    budget.release(Date.now() - started);
    if (isRateLimitError(err)) budget.noteRateLimited(retryAfterMsFrom(err));
    throw err;
  }
}

export function cloudBudgetStats(): CloudBudgetStats { return budget.stats(); }
export function setManualCloudConcurrency(n: number | null | undefined): void {
  budget.setManualConcurrency(n);
}
export function getManualCloudConcurrency(): number | null { return budget.getManualConcurrency(); }
export function setDiscoveredCloudLimit(
  rpm: number | null,
  discovery: CloudBudgetStats['discovery'],
  credits?: CloudBudgetStats['credits'],
): void {
  budget.setDiscovered(rpm, discovery, credits);
}
export function noteCloudRateLimited(retryAfterMs?: number): void { budget.noteRateLimited(retryAfterMs); }

/** Test seam. */
export function __resetCloudBudgetForTest(): void { budget.reset(); }

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---- discovery -------------------------------------------------------

let lastDiscoveryAt = 0;
/** Limits move with spend tier, but not minute to minute. */
const DISCOVERY_TTL_MS = 10 * 60_000;
let inFlightDiscovery: Promise<void> | null = null;

/**
 * Read the key's real limit through whichever sidecar will answer, and feed
 * it to the pool. Never throws: a failed discovery leaves the conservative
 * default in place, which is the safe direction.
 */
export async function refreshCloudBudgetFromKey(force = false): Promise<CloudBudgetStats> {
  const now = Date.now();
  if (!force && now - lastDiscoveryAt < DISCOVERY_TTL_MS) return cloudBudgetStats();
  if (inFlightDiscovery) { await inFlightDiscovery; return cloudBudgetStats(); }

  inFlightDiscovery = (async () => {
    try {
      const { listAllVirtualContainers } = await import('../../sidecars/virtualContainers.js');
      const { virtualKeyInfo } = await import('../../sidecars/virtualInferenceClient.js');
      const { getOpenRouterSettings } = await import('../../sidecars/openRouterConfig.js');
      const { listSidecars } = await import('../../sidecars/registry.js');
      const { isSoundSuiteSidecarConnected } = await import('../../sidecars/soundsuiteMaster.js');

      // The account's credits and rate limit are properties of the KEY, not of
      // any role's routing policy. The precondition is therefore "a key was
      // pushed AND some sidecar can be reached" — nothing about modes.
      //
      // This used to call `listVirtualContainers()`, which drops every
      // `local-only` row. With all roles local-only that returned zero, so the
      // probe refused to run and reported "no virtual containers are
      // registered" while the rest of the page correctly listed 15 of them.
      // Worse, it made the balance unreadable in exactly the configuration
      // where you most want to read it: deciding whether to turn cloud on at
      // all. Discovering the ceiling BEFORE spending against it is the point,
      // and under the routing dropdown "SideCar only" is a perfectly normal
      // state in which to still want your balance.
      const settings = getOpenRouterSettings();
      if (!settings.keyPushed) {
        setDiscoveredCloudLimit(null, {
          ok: false, at: new Date().toISOString(),
          reason: 'no OpenRouter key has been pushed yet — save one in the config page\'s OpenRouter section',
        });
        return;
      }

      // Prefer hosts we have actually discovered containers on (they have
      // certainly applied our config), then any other tunnelled sidecar. Mode
      // is deliberately not consulted.
      const withContainers = listAllVirtualContainers();
      const seen = new Set<string>();
      const candidates: Array<{ sidecarId: string; providerName: string }> = [];
      for (const vc of withContainers) {
        if (seen.has(vc.sidecarId)) continue;
        seen.add(vc.sidecarId);
        candidates.push({ sidecarId: vc.sidecarId, providerName: vc.providerName });
      }
      for (const sc of listSidecars({ enabled: true })) {
        if (seen.has(sc.id)) continue;
        if (!isSoundSuiteSidecarConnected(sc.id)) continue;
        seen.add(sc.id);
        candidates.push({ sidecarId: sc.id, providerName: sc.name });
      }

      if (candidates.length === 0) {
        setDiscoveredCloudLimit(null, {
          ok: false, at: new Date().toISOString(),
          reason: 'a key is pushed, but no sidecar has an open WS tunnel to Fantom\'s master slot',
        });
        return;
      }

      // One sidecar answering is enough — they all hold the same key, which is
      // precisely why the budget is global.
      let lastReason = 'no sidecar answered';
      let unsupported = false;
      for (const vc of candidates) {
        const out = await virtualKeyInfo(vc);
        if (out.ok) {
          const rpm = out.info.requests !== undefined && out.info.intervalSeconds
            ? (out.info.requests / out.info.intervalSeconds) * 60
            : null;
          setDiscoveredCloudLimit(rpm === null ? null : Math.max(1, Math.round(rpm)), {
            ok: true, at: new Date().toISOString(),
            // Keep the envelope. It costs nothing and it is the only way to
            // tell "OpenRouter reported {requests:1, interval:'1m'}" from
            // "OpenRouter reported {requests:0}" after the fact — two
            // different diagnoses that both round to a displayed 1/min.
            rawRateLimit: out.info.rawRateLimit ?? null,
            envelopeKeys: out.info.envelopeKeys,
          }, {
            remaining: out.info.limitRemaining ?? null,
            totalCredits: out.info.limit ?? null,
            totalUsage: out.info.usage ?? null,
          });
          return;
        }
        lastReason = out.reason;
        unsupported = out.unsupported;
        if (out.unsupported) break; // every sidecar runs the same build
      }
      setDiscoveredCloudLimit(null, { ok: false, unsupported, reason: lastReason, at: new Date().toISOString() });
    } catch (err) {
      setDiscoveredCloudLimit(null, {
        ok: false, reason: (err as Error).message, at: new Date().toISOString(),
      });
    } finally {
      lastDiscoveryAt = Date.now();
    }
  })();

  try { await inFlightDiscovery; } finally { inFlightDiscovery = null; }
  return cloudBudgetStats();
}

/** Test seam. */
export function __resetCloudDiscoveryForTest(): void {
  lastDiscoveryAt = 0;
  inFlightDiscovery = null;
}

// ---- operator override, persisted in Fantom config -------------------

/**
 * Where the manual ceiling lives: `openRouterMaxConcurrent` in
 * `config/fantomMcpServer-config.json`, alongside the other routing settings.
 * `semanticSearch.openRouterMaxConcurrent` is accepted too, so it does not
 * matter which of the two an operator reaches for.
 *
 * It is NOT secret — unlike the key, which is write-only and never stored.
 *
 * Blank/absent means "use whatever discovery found", and discovery failing
 * with no override falls back to CONSERVATIVE_DEFAULT_CONCURRENCY.
 */
export function readManualConcurrencyFromConfig(cfg: unknown): number | null {
  const c = cfg as { openRouterMaxConcurrent?: unknown; semanticSearch?: { openRouterMaxConcurrent?: unknown } };
  const raw = c?.openRouterMaxConcurrent ?? c?.semanticSearch?.openRouterMaxConcurrent;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return isValidConcurrency(n) ? n : null;
}

let hydrated = false;

/** Load the persisted override. Cheap and idempotent; `force` re-reads after
 *  a write so a change takes effect with no restart. */
export async function hydrateCloudBudgetFromConfig(force = false): Promise<void> {
  if (hydrated && !force) return;
  hydrated = true;
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const p = path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');
    if (!fs.existsSync(p)) return;
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
    budget.setManualConcurrency(readManualConcurrencyFromConfig(cfg));
  } catch {
    /* A missing or malformed config must not disable cloud embedding; the
     * conservative default already protects the account. */
  }
}

/** Test seam. */
export function __resetCloudHydrationForTest(): void { hydrated = false; }
