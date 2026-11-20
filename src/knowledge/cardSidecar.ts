/**
 * Sidecar models for knowledge cards, chosen by sidecar CONTAINER (role):
 * id `sidecar/<container>`, e.g. `sidecar/ss-completion`. The model sent is
 * the one that container serves on each host, read live from the heartbeat
 * (the same data the dashboard Sidecars tab shows), never hardcoded.
 *
 * Hosts and their state come from the Sidecars tab data (`listFleetSidecars`):
 * a host that tab shows as offline is unavailable here too.
 *
 * The single entry point for a sidecar card call is `sidecarCardChat`. It
 * never calls OpenRouter: when no online host runs the container, the call
 * fails with SidecarCardModelError and the caller fails that card (or falls
 * back to the normal ask path) without spending money.
 *
 * Host choice: online hosts whose container is running and reports a model,
 * not cooling down after a failure; least card calls in flight first. A host
 * that fails is cooled down in memory (never written to the config file) and
 * the call moves to the next host.
 *
 * Load: at most `sidecarPerHostLimit` card calls per host at once. Bulk calls
 * wait for a free slot; interactive calls do not wait (they fail at once with
 * SidecarCardBusyError so an ask never queues behind a build).
 */
import type { Sidecar } from '../admin/types.js';
import { listFleetSidecars, fleetHostOnline, completionContainerOf } from '../sidecars/fleetView.js';
import { callSidecarChat, type SidecarChatMessage, type SidecarChatResult } from '../embedding/sidecarLlmClient.js';
import { getCardSettings, sidecarModelName, sidecarModelId, isSidecarModelId, SUGGESTED_SIDECAR_CONTAINERS } from './cardSettings.js';

export class SidecarCardModelError extends Error {
  constructor(message: string) { super(message); this.name = 'SidecarCardModelError'; }
}
export class SidecarCardBusyError extends SidecarCardModelError {
  constructor(message: string) { super(message); this.name = 'SidecarCardBusyError'; }
}

/** One host as the Sidecars tab sees it, with its completion container. */
export interface CardHost {
  sc: Sidecar;
  /** Online on the Sidecars tab (enabled, WS-connected or fresh healthy heartbeat). */
  online: boolean;
  /** Container name, e.g. `ss-completion`. */
  container: string;
  /** Model the container serves; null when unknown. */
  model: string | null;
  /** Container status from the heartbeat (`running`…); null when no snapshot. */
  status: string | null;
  /** The host's `llm` capability is available with this model loaded. */
  llmLoaded?: boolean;
}

interface Deps {
  listHosts: () => Promise<CardHost[]>;
  call: (sc: Sidecar, messages: SidecarChatMessage[], opts: { model: string; maxTokens: number; temperature: number; timeoutMs: number; responseJsonObject: boolean; noThink: boolean }) => Promise<SidecarChatResult>;
  perHostLimit: () => number;
  now: () => number;
  /** Bulk calls with no serving host re-check this often… */
  noHostPollMs: number;
  /** …for at most this long, then fail. */
  noHostWaitMs: number;
}

/**
 * The fleet is read at call time (never a host list kept from build start),
 * cached for at most FLEET_CACHE_MS, so a host that stops serving drops out
 * and a host that starts serving is picked up within seconds.
 */
const FLEET_CACHE_MS = 10_000;
let fleetCache: { at: number; hosts: CardHost[] } | null = null;
async function realListHosts(): Promise<CardHost[]> {
  if (fleetCache && Date.now() - fleetCache.at < FLEET_CACHE_MS) return fleetCache.hosts;
  const out: CardHost[] = [];
  for (const s of await listFleetSidecars({ enabled: true })) {
    const c = await completionContainerOf(s);
    if (!c) continue;
    const cap = s.capabilities?.llm;
    const llmLoaded = !!cap?.available && !!c.model && cap.loaded === c.model;
    out.push({ sc: s, online: fleetHostOnline(s), container: c.container, model: c.model, status: c.status, llmLoaded });
  }
  fleetCache = { at: Date.now(), hosts: out };
  return out;
}

const realDeps: Deps = {
  listHosts: realListHosts,
  call: (sc, messages, opts) => callSidecarChat(sc, messages, { ...opts, capability: 'llm' }),
  perHostLimit: () => getCardSettings().sidecarPerHostLimit,
  now: () => Date.now(),
  noHostPollMs: 30_000,
  noHostWaitMs: 10 * 60_000,
};
let deps: Deps = realDeps;

/** A failed host is skipped for this long before it is tried again. */
const COOLDOWN_MS = 60_000;

const inFlight = new Map<string, number>();
const coolUntil = new Map<string, number>();
let waiters: Array<() => void> = [];

export function __setSidecarCardDepsForTest(d: Partial<Deps> | null): void {
  deps = d ? { ...realDeps, ...d } : realDeps;
  inFlight.clear();
  coolUntil.clear();
  waiters = [];
  fleetCache = null;
}

/** `sidecar/<container>`; a `sidecar/<model>` id (older form) matches the container serving that model. */
function matches(h: CardHost, name: string): boolean {
  return h.container === name || (!!h.model && h.model === name);
}
/** Online now and serving: container running, or `llm` available with the model loaded. */
function usable(h: CardHost, container: string): boolean {
  if (!matches(h, container) || !h.online || !h.model) return false;
  return h.status === null || h.status === 'running' || h.llmLoaded === true;
}

/** Hosts that can serve `container` now (cooling ones included). */
async function liveHostsFor(container: string): Promise<CardHost[]> {
  return (await deps.listHosts()).filter(h => usable(h, container));
}

export interface SidecarModelOption {
  /** Stored id, `sidecar/<container>`. */
  id: string;
  container: string;
  /** Model(s) the container serves on its online hosts (from the heartbeat). */
  models: string[];
  /** Online hosts that can take calls. */
  hosts: string[];
  /** Hosts that run the container but are offline / stopped on the Sidecars tab. */
  offline: string[];
  live: boolean;
  /** Why it cannot be chosen, when it cannot. */
  reason?: string;
}

/**
 * Sidecar options for the dropdowns: one entry per completion container
 * (normally just `ss-completion`), plus the suggested ones when no host runs
 * them. `live` only when an online host runs it.
 */
export async function sidecarModelOptions(): Promise<SidecarModelOption[]> {
  const all = await deps.listHosts();
  const names = new Set<string>(SUGGESTED_SIDECAR_CONTAINERS);
  for (const h of all) names.add(h.container);
  return [...names].sort().map(container => {
    const mine = all.filter(h => matches(h, container));
    const up = mine.filter(h => usable(h, container));
    const down = mine.filter(h => !usable(h, container));
    // Model from the online hosts; when none is online, from the listed ones.
    const models = [...new Set((up.length ? up : mine).map(h => h.model!).filter(Boolean))];
    const reason = up.length ? undefined
      : mine.length ? `its sidecars are offline (${down.map(h => h.sc.name).join(', ')})`
        : 'no sidecar runs it';
    return {
      id: sidecarModelId(container), container, models,
      hosts: up.map(h => h.sc.name), offline: down.map(h => h.sc.name), live: up.length > 0,
      ...(reason ? { reason } : {}),
    };
  });
}

export async function liveSidecarModelIds(): Promise<Set<string>> {
  return new Set((await sidecarModelOptions()).filter(o => o.live).map(o => o.id));
}

/** Throw when a sidecar id has no online host (no-op for OpenRouter ids). */
export async function assertSidecarModelLive(id: string): Promise<void> {
  if (!isSidecarModelId(id)) return;
  const container = sidecarModelName(id);
  if (!(await liveHostsFor(container)).length) {
    throw new SidecarCardModelError(`no online sidecar runs ${container}; card call not sent (no paid fallback)`);
  }
}

/** Strip think blocks: `<think>…</think>`, an unclosed leading one, or a lone closing tag. */
export function stripThink(text: string): string {
  let s = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  const close = s.search(/<\/think(?:ing)?>/i);
  if (close >= 0) s = s.slice(s.indexOf('>', close) + 1);
  s = s.replace(/<think(?:ing)?>[\s\S]*$/i, '');
  return s.trim();
}

function release(id: string): void {
  inFlight.set(id, Math.max(0, (inFlight.get(id) ?? 1) - 1));
  const w = waiters;
  waiters = [];
  for (const fn of w) fn();
}

/**
 * Pick and reserve a host from `live`, or null when every candidate is full.
 * Synchronous, so two calls never reserve the same last slot. `cooling` =
 * hosts this call has not tried that are cooling after an error; `wakeAt` =
 * when the first of them is ready again.
 */
function reserve(live: CardHost[], tried: Set<string>): { host: CardHost | null; candidates: number; cooling: number; wakeAt: number } {
  const now = deps.now();
  const limit = Math.max(1, deps.perHostLimit());
  const untried = live.filter(h => !tried.has(h.sc.id));
  const coolingEnds = untried.map(h => coolUntil.get(h.sc.id) ?? 0).filter(t => t > now);
  const cands = untried.filter(h => (coolUntil.get(h.sc.id) ?? 0) <= now);
  const load = (h: CardHost) => inFlight.get(h.sc.id) ?? 0;
  const free = cands.filter(h => load(h) < limit)
    .sort((a, b) => load(a) - load(b) || (a.sc.activeRequests ?? 0) - (b.sc.activeRequests ?? 0));
  const host = free[0] ?? null;
  if (host) inFlight.set(host.sc.id, load(host) + 1);
  return { host, candidates: cands.length, cooling: coolingEnds.length, wakeAt: coolingEnds.length ? Math.min(...coolingEnds) : 0 };
}

/** Wait for a slot release, or `ms` (null = release only). */
function waitFor(ms: number | null): Promise<void> {
  return new Promise<void>(resolve => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const fn = () => { if (t) clearTimeout(t); resolve(); };
    waiters.push(fn);
    if (ms !== null) t = setTimeout(() => { waiters = waiters.filter(w => w !== fn); resolve(); }, ms);
  });
}

export interface SidecarCardChatOptions {
  maxTokens: number;
  temperature?: number;
  timeoutMs: number;
  json?: boolean;
  /** 'interactive' never waits for a busy host. */
  lane: 'bulk' | 'interactive';
}
/** `model` is the stored id (`sidecar/ss-completion`); `servedModel` is what the host ran. */
export interface SidecarCardChatOut { text: string; costUsd: 0; model: string; servedModel: string; host: string }

export async function sidecarCardChat(
  system: string, user: string, id: string, opts: SidecarCardChatOptions,
): Promise<SidecarCardChatOut> {
  if (!isSidecarModelId(id)) throw new SidecarCardModelError(`${id} is not a sidecar model id`);
  const container = sidecarModelName(id);
  const messages: SidecarChatMessage[] = [{ role: 'system', content: system }, { role: 'user', content: user }];
  let tried = new Set<string>();
  const errors: string[] = [];
  let noHostSince: number | null = null;
  for (;;) {
    const { host, candidates, cooling, wakeAt } = reserve(await liveHostsFor(container), tried);
    if (!host) {
      if (!candidates && cooling) {
        // Hosts exist but are cooling after errors (e.g. a timeout). A bulk
        // call waits for the first to come back instead of failing every
        // remaining card at once; an interactive call does not wait.
        if (opts.lane === 'interactive') throw new SidecarCardBusyError(`every sidecar running ${container} is cooling down after errors`);
        await waitFor(Math.min(1_000, Math.max(10, wakeAt - deps.now())));
        continue;
      }
      if (!candidates) {
        const why = errors.length ? `every host failed: ${errors.join(' | ')}` : `no online sidecar runs ${container}`;
        // Every host this call tried failed: fail this card (hosts cool down).
        // Bulk: hosts come and go; wait and re-check the live fleet (a host
        // that starts serving is used at once) up to a limit, rather than
        // failing every remaining card. Interactive calls fail fast.
        const now = deps.now();
        noHostSince ??= now;
        if (errors.length || opts.lane === 'interactive' || now - noHostSince >= deps.noHostWaitMs) {
          const waited = !errors.length && opts.lane === 'bulk' && now > noHostSince ? ` (waited ${Math.round((now - noHostSince) / 1000)} s)` : '';
          throw new SidecarCardModelError(`${why}${waited}; card call not sent to a paid model`);
        }
        await waitFor(Math.min(deps.noHostPollMs, Math.max(10, noHostSince + deps.noHostWaitMs - now)));
        fleetCache = null;
        tried = new Set();
        continue;
      }
      noHostSince = null;
      if (opts.lane === 'interactive') throw new SidecarCardBusyError(`every sidecar running ${container} is at its card limit`);
      await waitFor(null);
      continue;
    }
    const model = host.model!;
    let res: SidecarChatResult;
    try {
      res = await deps.call(host.sc, messages, {
        model,
        // Thinking off: with it on, qwen3.5 spent the whole budget reasoning
        // and most card calls came back empty. The output limit is the
        // role's own (writer 1500, checker 1200, answer 900 tokens).
        maxTokens: opts.maxTokens,
        temperature: opts.temperature ?? 0.1,
        timeoutMs: opts.timeoutMs,
        responseJsonObject: opts.json === true,
        noThink: true,
      });
    } catch (err) {
      release(host.sc.id);
      tried.add(host.sc.id);
      coolUntil.set(host.sc.id, deps.now() + COOLDOWN_MS);
      errors.push(`${host.sc.name}: ${String((err as Error).message ?? err).slice(0, 200)}`);
      continue;
    }
    release(host.sc.id);
    const text = stripThink(res.content);
    // A reply with only reasoning (or cut off mid-thought) is not an answer;
    // fail the call rather than parse thinking text as a card.
    if (!text) {
      throw new SidecarCardModelError(`${host.sc.name} returned no answer text${res.finishReason === 'length' ? ' (ran out of tokens while thinking)' : ''}`);
    }
    return { text, costUsd: 0, model: id, servedModel: model, host: host.sc.name };
  }
}

/** Card calls in flight per host id (for the status view and tests). */
export function sidecarCardLoad(): Record<string, number> {
  return Object.fromEntries([...inFlight].filter(([, n]) => n > 0));
}
