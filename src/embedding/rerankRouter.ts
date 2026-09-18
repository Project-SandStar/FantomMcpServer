/**
 * Rerank routing: LOCAL FIRST, OpenRouter as fallback.
 *
 * This is deliberately NOT the embedding policy. Embedding uses every
 * provider concurrently because throughput is the whole point and a text
 * embedded anywhere lands in the same table. Rerank is one small
 * latency-sensitive request per search whose cost is metered per token, so a
 * healthy local cross-encoder should always win and the cloud should only
 * cover the gap.
 *
 * Mirrors the sidecar's own `local-first` semantics rather than inventing new
 * ones:
 *
 *   1. A usable local `reranker` sidecar is tried first.
 *   2. OpenRouter is used only when there is no local reranker, or the local
 *      request failed.
 *
 * ── On "re-evaluate per request" ───────────────────────────────────────────
 *
 * Local *selection* goes through `rerankerSidecarUsable()`, which already
 * carries the fleet's health and fault rules (`isSidecarUsable`) and caches
 * its scan for 60 s. So:
 *
 *   - a local FAILURE falls through to cloud immediately, for that request,
 *     and invalidates the cache so the next request re-scans rather than
 *     waiting out the TTL;
 *   - a local RECOVERY (gpu-01 registering again) is picked up within that
 *     60 s probe window, not literally on the next request.
 *
 * Re-scanning the registry on every rerank would mean a config-file read per
 * search for a fleet that changes on a heartbeat timescale; inheriting main's
 * probe cache is the better trade, and failure-driven invalidation keeps the
 * part that matters — a dead reranker never serves twice.
 *
 * Every rerank logs which path served it (`path=local` / `path=openrouter`)
 * so the Fleet panel and search logs finally have attribution — until now
 * `semanticSearch.rerank` had no backend at all, because gpu-01 never
 * registered a `reranker` capability.
 */

import { sidecarServiceUrl } from '../sidecars/registry.js';
import { rerankerSidecarUsable, resetRerankerCache } from './hybridSearch.js';
import {
  listVirtualContainers,
  getVirtualContainersConfig,
  DEFAULT_OR_RERANK_MODEL,
  type VirtualContainer,
} from '../sidecars/virtualContainers.js';
import { withCloudPermit } from './providers/cloudBudget.js';
import { noteCallStarted, noteCallFinished, isRoleCapped } from '../sidecars/openRouterActivity.js';
import { getOpenRouterSettings } from '../sidecars/openRouterConfig.js';
import { effectiveBehaviour, sanitizePolicies, cloudMayServe } from '../sidecars/routingPolicy.js';
import { virtualRerank } from '../sidecars/virtualInferenceClient.js';

export type RerankPath = 'local' | 'openrouter';

export interface RerankOutcome {
  /** Score per document, aligned to the INPUT order. Missing scores are 0. */
  scores: number[];
  /** Model that actually produced the scores. */
  model: string;
  path: RerankPath;
  /** Sidecar that served it — local host name, or the `-OR-` provider name. */
  servedBy: string;
  ms: number;
  /** Why local was skipped, when path==='openrouter'. */
  localSkipReason?: string;
}

export interface RerankRouterOptions {
  /** Pin the LOCAL model. Ignored by the OpenRouter path, whose model comes
   *  from the sidecar's per-master allow-list. */
  model?: string;
  timeoutMs?: number;
}

/** Score-shape parsing shared by both paths. Returns input-aligned scores. */
export function parseRerankScores(json: any, n: number): number[] | null {
  // Cohere-style: { results: [{index, relevance_score}] }
  if (Array.isArray(json?.results)) {
    const out = new Array<number>(n).fill(0);
    let any = false;
    for (const r of json.results) {
      const i = r?.index;
      const s = typeof r?.relevance_score === 'number' ? r.relevance_score
        : typeof r?.score === 'number' ? r.score : undefined;
      if (typeof i === 'number' && i >= 0 && i < n && typeof s === 'number') {
        out[i] = s;
        any = true;
      }
    }
    return any ? out : null;
  }
  // vLLM /v1/score: { data: [{score}] } aligned with input order.
  if (Array.isArray(json?.data) && json.data.length === n) {
    return json.data.map((r: any) =>
      typeof r?.score === 'number' ? r.score
        : typeof r?.relevance === 'number' ? r.relevance
        : typeof r?.relevance_score === 'number' ? r.relevance_score
        : 0,
    );
  }
  // Bare number array.
  if (Array.isArray(json) && json.length === n && json.every((x: any) => typeof x === 'number')) {
    return json as number[];
  }
  return null;
}

interface Attempt { ok: boolean; status: number; json?: any; text?: string }

async function post(url: string, body: unknown, authToken: string | undefined, timeoutMs: number): Promise<Attempt> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) return { ok: false, status: res.status, text: await res.text().catch(() => '') };
    return { ok: true, status: res.status, json: await res.json() };
  } catch (err) {
    return { ok: false, status: 0, text: (err as Error)?.message ?? String(err) };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Try the local cross-encoder. Returns null when no local reranker is usable
 * or the request failed; `reason` says which, so the fallback log line
 * explains itself.
 */
async function tryLocal(
  query: string,
  documents: string[],
  options: RerankRouterOptions,
  reason: { why?: string },
): Promise<RerankOutcome | null> {
  const started = Date.now();
  const sc = rerankerSidecarUsable();
  if (!sc) {
    reason.why = 'no usable sidecar advertises capability=reranker';
    return null;
  }
  const cap = sc.capabilities.reranker!;
  const model = options.model ?? cap.loaded ?? cap.models?.[0];
  if (!model) {
    reason.why = `local reranker '${sc.name}' advertises no model`;
    return null;
  }

  const baseUrl = sidecarServiceUrl(sc, 'reranker');
  const timeoutMs = options.timeoutMs ?? 60_000;

  // Cohere-style first, vLLM /v1/score on 404 or transport failure.
  let raw: any = null;
  const r1 = await post(`${baseUrl}/v1/rerank`, {
    model, query, documents, top_n: documents.length, return_documents: false,
  }, sc.authToken, timeoutMs);
  if (r1.ok) {
    raw = r1.json;
  } else if (r1.status === 404 || r1.status === 0) {
    const r2 = await post(`${baseUrl}/v1/score`, { model, text_1: query, text_2: documents }, sc.authToken, timeoutMs);
    if (r2.ok) raw = r2.json;
    else {
      reason.why = `local reranker '${sc.name}' failed: /v1/rerank → ${r1.status}, /v1/score → ${r2.status}`;
      // Drop the cached pick so the next request re-scans instead of sending
      // another rerank to a host that just failed.
      resetRerankerCache();
      return null;
    }
  } else {
    reason.why = `local reranker '${sc.name}' failed: /v1/rerank → ${r1.status} ${r1.text?.slice(0, 160) ?? ''}`;
    resetRerankerCache();
    return null;
  }

  const scores = parseRerankScores(raw, documents.length);
  if (!scores) {
    reason.why = `local reranker '${sc.name}' returned an unparseable score response`;
    resetRerankerCache();
    return null;
  }
  return { scores, model, path: 'local', servedBy: sc.name, ms: Date.now() - started };
}

/** Pick the OR reranker to use. Prefers one whose model matches the
 *  configured (cheap) default, then anything cloud-routable. */
export function selectVirtualReranker(): VirtualContainer | null {
  // "SideCar only" means no rerank ever leaves the building, even if a
  // cloud-routable container is still registered from a previous policy.
  if (!rerankMayUseCloud()) return null;
  const rows = listVirtualContainers('reranker');
  if (rows.length === 0) return null;
  const cfg = getVirtualContainersConfig();
  const want = (cfg.rerankModel ?? DEFAULT_OR_RERANK_MODEL).toLowerCase();
  return rows.find(r => r.model.toLowerCase() === want) ?? rows[0];
}

/**
 * May rerank fall back to OpenRouter at all?
 *
 * Both AGGREGATE and BACKUP say yes: rerank is a single call over one document
 * set, so there is no fan-out for "aggregate" to spread across — it degenerates
 * to the same local-first behaviour, which is what the UI tells the operator
 * rather than pretending the two differ.
 */
/**
 * Cached because `getOpenRouterSettings()` reads and parses the config file
 * SYNCHRONOUSLY, and this is called on every rerank — i.e. on the search path,
 * and thousands of times during a rebuild. A disk read per rerank is not a
 * price worth paying to notice a dropdown change a few seconds sooner.
 */
interface RerankPolicy {
  /** May this rerank call out to OpenRouter at all? */
  mayUseCloud: boolean;
  /** May the local reranker sidecar serve? False only under "OpenRouter only". */
  localServes: boolean;
}

let policyCache: { at: number; policy: RerankPolicy } | null = null;
const POLICY_TTL_MS = 5_000;

/**
 * `cloudMayServe`, not `allowsFallback`.
 *
 * Under the three policies where the GPUs serve, "may rerank use cloud" and
 * "does the policy allow a fallback" were the same question. "OpenRouter only"
 * separates them: it sets `allowsFallback: false` because cloud is the
 * PRIMARY, not the reserve — so the old spelling would have read "OpenRouter
 * only" as "never call OpenRouter" and silently left the reranker with no
 * backend at all.
 */
function rerankPolicy(): RerankPolicy {
  const now = Date.now();
  if (policyCache && now - policyCache.at < POLICY_TTL_MS) return policyCache.policy;
  try {
    const chosen = sanitizePolicies(getOpenRouterSettings().policyByRole).reranker!;
    const policy: RerankPolicy = {
      mayUseCloud: cloudMayServe('reranker', chosen),
      localServes: effectiveBehaviour('reranker', chosen).localServes,
    };
    policyCache = { at: now, policy };
    return policy;
  } catch (err) {
    // A transient read failure must not be mistaken for "the operator chose
    // local". Keep the last policy we actually read — silently switching
    // reranking off because the config file was briefly unreadable is a
    // search-quality regression nobody would attribute to this.
    if (policyCache) {
      console.warn(
        `[rerank] could not re-read the routing policy (${(err as Error).message}) — `
        + `keeping the last known value (cloud ${policyCache.policy.mayUseCloud ? 'on' : 'off'}, `
        + `local ${policyCache.policy.localServes ? 'on' : 'off'}).`,
      );
      policyCache = { at: now, policy: policyCache.policy };
      return policyCache.policy;
    }
    // Never read it successfully: do not start spending on a guess, and do not
    // take the GPUs away on one either.
    return { mayUseCloud: false, localServes: true };
  }
}

function rerankMayUseCloud(): boolean { return rerankPolicy().mayUseCloud; }

/** Test seam — the TTL would otherwise leak policy across cases. */
export function __resetRerankPolicyCacheForTest(): void {
  policyCache = null;
}

/** Note once per (provider, model) which model a slot actually allow-lists,
 *  when it differs from the one Fantom asked for. Informational only — the
 *  sidecar's allow-list is authoritative. */
const warnedModels = new Set<string>();

async function tryCloud(
  query: string,
  documents: string[],
  options: RerankRouterOptions,
  localSkipReason: string | undefined,
): Promise<RerankOutcome | null> {
  const vc = selectVirtualReranker();
  if (!vc) return null;
  const cfg = getVirtualContainersConfig();
  const preferred = cfg.rerankModel ?? DEFAULT_OR_RERANK_MODEL;

  if (vc.model.toLowerCase() !== preferred.toLowerCase()) {
    const key = `${vc.providerName}:${vc.model}`;
    if (!warnedModels.has(key)) {
      warnedModels.add(key);
      // Purely informational: the sidecar's per-master allow-list is
      // authoritative, so this says which model actually served the request,
      // not that the choice is wrong.
      console.log(
        `[rerank] ${vc.providerName} allow-lists '${vc.model}' but Fantom asked for '${preferred}'. `
        + 'The sidecar\'s allow-list wins — change it there, or in the OpenRouter section of the config page.',
      );
    }
  }

  if (isRoleCapped('reranker')) {
    console.warn('[rerank] OpenRouter reranking has hit its daily spend cap — falling back to input order. '
      + "Raise or clear the cap in the config page's OpenRouter section.");
    return null;
  }

  const started = Date.now();
  noteCallStarted('reranker');
  try {
    // Reranks spend the same OpenRouter key as the embedding fan-out, so
    // they draw from the same global permit pool. A rebuild saturating the
    // budget must not silently make search reranks fail; it makes them queue.
    const res = await withCloudPermit(() => virtualRerank(vc, query, documents, {
      topN: documents.length,
      requestedModel: cfg.strictRerankModel ? preferred : undefined,
      timeoutMs: options.timeoutMs ?? 60_000,
    }));
    noteCallFinished('reranker', {
      servedBy: vc.providerName,
      model: res.model ?? vc.model,
      tokens: res.totalTokens,
      durationMs: Date.now() - started,
      success: true,
    });
    const scores = parseRerankScores({ results: res.results ?? [] }, documents.length);
    if (!scores) {
      console.warn(`[rerank] ${vc.providerName} returned an unparseable score response`);
      return null;
    }
    return {
      scores,
      model: res.model ?? vc.model,
      path: 'openrouter',
      servedBy: vc.providerName,
      ms: Date.now() - started,
      localSkipReason,
    };
  } catch (err) {
    noteCallFinished('reranker', {
      servedBy: vc.providerName,
      model: vc.model,
      durationMs: Date.now() - started,
      success: false,
      error: (err as Error).message,
    });
    console.warn(`[rerank] ${vc.providerName} failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * How long a "no healthy local reranker" verdict is cached by
 * `rerankerSidecarUsable`. Surfaced deliberately: local FAILURE falls through
 * to cloud immediately and invalidates this cache, but local RECOVERY is only
 * noticed within this window. Anyone asking "gpu-01 is back, why is rerank
 * still on cloud?" should be able to read the answer off the page instead of
 * the source.
 */
export const LOCAL_RERANK_PROBE_TTL_MS = 60_000;

/** Last rerank's attribution, for the Fleet panel and admin surfaces. */
let lastRerank: { path: RerankPath; servedBy: string; model: string; at: string; ms: number } | null = null;

export interface RerankAttribution {
  path: RerankPath;
  servedBy: string;
  model: string;
  at: string;
  ms: number;
  /** See LOCAL_RERANK_PROBE_TTL_MS. */
  localProbeTtlMs: number;
  localProbeNote: string;
}

export function getLastRerankAttribution(): RerankAttribution | null {
  if (!lastRerank) return null;
  return {
    ...lastRerank,
    localProbeTtlMs: LOCAL_RERANK_PROBE_TTL_MS,
    localProbeNote:
      'A local reranker failure falls through to OpenRouter immediately. A local reranker coming back '
      + `is picked up within ${LOCAL_RERANK_PROBE_TTL_MS / 1000}s — the health probe is cached for that long, `
      + 'rather than re-run on every rerank.',
  };
}

/**
 * Rerank `documents` against `query`, local first, OpenRouter as fallback.
 * Returns null when neither path is available — callers keep their input
 * order unchanged rather than failing the search.
 */
export async function rerankLocalFirst(
  query: string,
  documents: string[],
  options: RerankRouterOptions = {},
): Promise<RerankOutcome | null> {
  if (documents.length === 0) {
    return { scores: [], model: options.model ?? '', path: 'local', servedBy: 'none', ms: 0 };
  }

  const reason: { why?: string } = {};
  // "OpenRouter only" takes the GPUs out of this role. Rerank is a ranking
  // refinement, not an index write, so a local rerank under that policy is not
  // a correctness hazard the way a local embed is — but it does make the
  // setting a lie, and the local reranker is a different model from the cloud
  // one, so which served it changes the order. Honour the choice.
  const policy = rerankPolicy();
  const local = policy.localServes ? await tryLocal(query, documents, options, reason) : null;
  if (!policy.localServes) reason.why = 'the reranker is on "OpenRouter only" — the sidecar GPUs are excluded';
  if (local) {
    console.log(`[rerank] path=local servedBy=${local.servedBy} model=${local.model} docs=${documents.length} ms=${local.ms}`);
    lastRerank = { path: 'local', servedBy: local.servedBy, model: local.model, at: new Date().toISOString(), ms: local.ms };
    return local;
  }

  const cloud = await tryCloud(query, documents, options, reason.why);
  if (cloud) {
    console.log(
      `[rerank] path=openrouter servedBy=${cloud.servedBy} model=${cloud.model} docs=${documents.length} `
      + `ms=${cloud.ms} localSkipReason="${cloud.localSkipReason ?? 'unknown'}"`,
    );
    lastRerank = { path: 'openrouter', servedBy: cloud.servedBy, model: cloud.model, at: new Date().toISOString(), ms: cloud.ms };
    return cloud;
  }

  console.warn(
    `[rerank] path=none — no backend served this rerank. local: ${reason.why ?? 'unavailable'}; `
    + `openrouter: ${listVirtualContainers('reranker').length === 0 ? "no cloud-routable reranker for Fantom's master slot" : 'request failed'}`,
  );
  return null;
}
