/**
 * EmbeddingProvider abstraction. Two implementations:
 *  - InProcessProvider: wraps existing EmbeddingService / DocsEmbeddingService.
 *  - HttpSidecarProvider: calls a remote Ollama-compatible /api/embed endpoint.
 *
 * Default behavior is unchanged. Callers that want sidecar routing can use
 * `selectEmbeddingProvider('code'|'docs')` which picks a sidecar of type
 * 'embedding' if one is registered + enabled, else falls back to in-process.
 */

import type { VirtualContainer } from '../../sidecars/virtualContainers.js';
import { classifyEmbedError, markEmbedFault, getEmbedFault } from './embedFaults.js';
import * as fs from 'fs';
import * as path from 'path';
import { getEmbeddingService, getDocsEmbeddingService } from '../embeddingService.js';
import { getSidecarForCapability, listSidecars, sidecarServiceUrl, updateSidecar } from '../../sidecars/registry.js';
import type { Sidecar, SidecarCapabilityKind } from '../../admin/types.js';
import { createLogger } from '../../utils/index.js';
import { crashWrite } from '../../utils/logSink.js';

const sidecarLogger = createLogger('embed-sidecar');

// Mirror sidecar-embed events to the unified crash sink so silent SIGKILLs
// (Jetsam OOM, uncatchable kernel kills) still leave a breadcrumb. logSink's
// crashWrite uses appendFileSync — each line hits disk before we proceed.
// All writes are gated on settings.debug.enabled; flipping the toggle on the
// dashboard takes effect on the next call without a restart.
function crashLog(line: string): void {
  crashWrite('EMBED', line);
}

const RUNTIME_CONFIG_PATH = path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');

export function readRuntimeSemantic(): any {
  try {
    if (!fs.existsSync(RUNTIME_CONFIG_PATH)) return {};
    return JSON.parse(fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf-8'))?.semanticSearch ?? {};
  } catch { return {}; }
}

export interface EmbeddingProvider {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  getModelName(): string;
  getDimensions(): number;
  initialize(): Promise<void>;
}

class InProcessCodeProvider implements EmbeddingProvider {
  private svc = getEmbeddingService();
  initialize() { return this.svc.initialize(); }
  embed(text: string) { return this.svc.embed(text); }
  embedBatch(texts: string[]) { return this.svc.embedBatch(texts); }
  getModelName() { return this.svc.getModelName(); }
  getDimensions() { return this.svc.getDimensions(); }
}

class InProcessDocsProvider implements EmbeddingProvider {
  private svc = getDocsEmbeddingService();
  initialize() { return this.svc.initialize(); }
  embed(text: string) { return this.svc.embed(text); }
  embedBatch(texts: string[]) { return this.svc.embedBatch(texts); }
  getModelName() { return this.svc.getModelName(); }
  getDimensions() { return this.svc.getDimensions(); }
}

// Per-request timeout for a sidecar embed call. A 1.5B GGUF model on a
// saturated consumer GPU has been measured at ~1s/text, so a 50-text batch
// needs well over the old 30s default. Overridable via
// settings.semanticSearch.embedTimeoutMs.
const DEFAULT_EMBED_TIMEOUT_MS = 120_000;
// Max concurrent embed requests per sidecar. Bounds the socket count against a
// slow/hung Ollama (hundreds of aborted-but-ESTABLISHED sockets were observed)
// and stops us from queueing work the GPU can't drain. Overridable via
// settings.semanticSearch.embedMaxInFlightPerSidecar.
const DEFAULT_MAX_IN_FLIGHT_PER_SIDECAR = 4;

export function embedTimeoutMs(): number {
  const v = Number(readRuntimeSemantic().embedTimeoutMs);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_EMBED_TIMEOUT_MS;
}

function maxInFlightPerSidecar(): number {
  const v = Number(readRuntimeSemantic().embedMaxInFlightPerSidecar);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : DEFAULT_MAX_IN_FLIGHT_PER_SIDECAR;
}

/**
 * Tuning for the pipelined scheduler (embedScheduler.ts) used by the full
 * re-embed job. `embedPipelineDepth` requests may be in flight per fast
 * provider (bounded by the per-sidecar cap above); `embedTargetChunkMs` is
 * the request latency chunks are sized for. Both overridable in
 * settings.semanticSearch without a restart.
 */
export function embedPipelineSettings(): { depth: number; targetChunkMs: number } {
  const s = readRuntimeSemantic();
  const d = Number(s.embedPipelineDepth);
  const t = Number(s.embedTargetChunkMs);
  return {
    depth: Math.min(maxInFlightPerSidecar(), Number.isFinite(d) && d >= 1 ? Math.floor(d) : 3),
    targetChunkMs: Number.isFinite(t) && t >= 500 ? t : 3000,
  };
}

// sidecarId → simple counting semaphore shared by every provider instance
// pointing at that sidecar (fan-out creates a fresh provider per project).
const inFlightBySidecar = new Map<string, { active: number; waiters: Array<() => void> }>();

async function acquireSidecarSlot(sidecarId: string): Promise<() => void> {
  let slot = inFlightBySidecar.get(sidecarId);
  if (!slot) { slot = { active: 0, waiters: [] }; inFlightBySidecar.set(sidecarId, slot); }
  const limit = maxInFlightPerSidecar();
  if (slot.active >= limit) {
    await new Promise<void>(resolve => slot!.waiters.push(resolve));
  }
  slot.active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    slot!.active--;
    const next = slot!.waiters.shift();
    if (next) next();
  };
}

export class HttpSidecarProvider implements EmbeddingProvider {
  constructor(
    private sidecar: Sidecar,
    private resolvedModel: string,
    private fallbackDims: number,
    // Which capability this provider speaks to. Code embedders served by a
    // dedicated 'embedding-code' sidecar live on a DIFFERENT port than the
    // general 'embedding' one, so the URL must resolve against the matched
    // capability — not hardcoded to 'embedding'.
    private capabilityKind: SidecarCapabilityKind = 'embedding',
    private timeoutMs = embedTimeoutMs(),
  ) {}

  /** Registry id of the sidecar this provider talks to (for failover bookkeeping). */
  getSidecarId(): string { return this.sidecar.id; }
  getSidecarName(): string { return this.sidecar.name; }

  private get model(): string { return this.resolvedModel; }

  getModelName(): string { return this.model; }
  getDimensions(): number { return this.fallbackDims; }
  async initialize(): Promise<void> { /* sidecar handles its own readiness */ }

  async embed(text: string): Promise<Float32Array> {
    const [v] = await this.embedBatch([text]);
    return v;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    // Fail fast while a capability fault is active: a provider bound before
    // the fault was recorded would otherwise keep hitting the same 404/501.
    const fault = getEmbedFault(this.sidecar.id, this.capabilityKind);
    if (fault) throw new Error(`Sidecar ${this.sidecar.name} skipped: ${fault.code} for ${fault.model} until ${fault.expiresAt}`);
    const cap = this.sidecar.capabilities[this.capabilityKind];
    const endpoint = cap?.endpoint ?? '/api/embed';
    const url = `${sidecarServiceUrl(this.sidecar, this.capabilityKind)}${endpoint}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.sidecar.authToken) headers['Authorization'] = `Bearer ${this.sidecar.authToken}`;

    const body = JSON.stringify({ model: this.model, input: texts });
    const bodyBytes = Buffer.byteLength(body, 'utf-8');
    const totalChars = texts.reduce((s, t) => s + t.length, 0);
    const maxChars = texts.reduce((m, t) => Math.max(m, t.length), 0);
    const memBefore = process.memoryUsage();
    const ctx = `sidecar=${this.sidecar.name}@${this.sidecar.host}:${this.sidecar.port} model=${this.model} batch=${texts.length} bytes=${bodyBytes} chars=${totalChars} maxChars=${maxChars}`;

    const doRequest = async (attempt: 1 | 2): Promise<Float32Array[]> => {
      const ctrl = new AbortController();
      const t = setTimeout(() => {
        ctrl.abort();
        sidecarLogger.warn(`[embed] TIMEOUT attempt=${attempt} ${ctx} timeoutMs=${this.timeoutMs}`);
        crashLog(`TIMEOUT attempt=${attempt} ${ctx}`);
      }, this.timeoutMs);
      const reqStart = Date.now();
      sidecarLogger.info(`[embed] REQ START attempt=${attempt} ${ctx} url=${url} rss=${Math.round(memBefore.rss / 1024 / 1024)}MB heap=${Math.round(memBefore.heapUsed / 1024 / 1024)}MB`);
      crashLog(`REQ START attempt=${attempt} ${ctx} url=${url}`);
      try {
        crashLog(`REQ FETCH_BEGIN attempt=${attempt} ${ctx}`);
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: ctrl.signal,
        });
        const ttfb = Date.now() - reqStart;
        sidecarLogger.info(`[embed] REQ HEADERS attempt=${attempt} ${ctx} status=${res.status} ttfb=${ttfb}ms`);
        crashLog(`REQ HEADERS attempt=${attempt} ${ctx} status=${res.status} ttfb=${ttfb}ms contentLength=${res.headers.get('content-length') ?? '?'}`);
        if (!res.ok) {
          const errBody = await res.text().catch(() => '<read failed>');
          const snip = errBody.length > 500 ? errBody.slice(0, 500) + '…' : errBody;
          crashLog(`HTTP_ERR attempt=${attempt} ${ctx} status=${res.status} body=${snip}`);
          throw new Error(`Sidecar /api/embed → HTTP ${res.status}: ${snip}`);
        }
        crashLog(`REQ BODY_BEGIN attempt=${attempt} ${ctx}`);
        const bodyStart = Date.now();
        const json = await res.json() as { embeddings?: number[][]; data?: Array<{ embedding: number[] }> };
        crashLog(`REQ BODY_PARSED attempt=${attempt} ${ctx} bodyMs=${Date.now() - bodyStart}`);
        // Ollama returns { embeddings: [[...]] }; OpenAI-compat returns { data: [{embedding: [...]}] }
        const arrays = json.embeddings ?? json.data?.map(d => d.embedding) ?? [];
        if (arrays.length !== texts.length) {
          crashLog(`COUNT_MISMATCH attempt=${attempt} ${ctx} got=${arrays.length}`);
          throw new Error(`Sidecar returned ${arrays.length} embeddings for ${texts.length} inputs`);
        }
        const dim = arrays[0]?.length ?? 0;
        const totalMs = Date.now() - reqStart;
        const memAfter = process.memoryUsage();
        const heapDelta = Math.round((memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024);
        sidecarLogger.info(`[embed] REQ OK attempt=${attempt} ${ctx} dim=${dim} totalMs=${totalMs} heapΔ=${heapDelta}MB`);
        crashLog(`REQ OK attempt=${attempt} ${ctx} dim=${dim} totalMs=${totalMs} heapΔ=${heapDelta}MB`);
        return arrays.map(a => Float32Array.from(a));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error && err.stack ? err.stack.split('\n').slice(0, 5).join(' | ') : '';
        sidecarLogger.error(`[embed] REQ FAIL attempt=${attempt} ${ctx} after=${Date.now() - reqStart}ms err=${msg}`);
        crashLog(`REQ FAIL attempt=${attempt} ${ctx} after=${Date.now() - reqStart}ms err=${msg} stack=${stack}`);
        throw err;
      } finally {
        clearTimeout(t);
      }
    };

    const release = await acquireSidecarSlot(this.sidecar.id);
    try {
      try {
        return await doRequest(1);
      } catch (err) {
        // A capability fault (the runtime refuses to embed with this model) is
        // deterministic: do not retry, remember it, let the caller fail over.
        const firstMsg = err instanceof Error ? err.message : String(err);
        const cls = classifyEmbedError(firstMsg);
        if (cls) {
          const f = markEmbedFault(this.sidecar, this.capabilityKind, this.model, firstMsg, cls);
          if (f.occurrences === 1) {
            sidecarLogger.error(`[embed] capability fault on ${this.sidecar.name}@${this.sidecar.host} (${this.capabilityKind}/${this.model}): ${firstMsg.trim()} — skipping this sidecar for embeddings until ${f.expiresAt}. Remedy: ${cls.remedy}`);
          }
          throw err;
        }
        sidecarLogger.warn(`[embed] retrying after first failure ${ctx}`);
        try {
          return await doRequest(2);
        } catch (err2) {
          // Both attempts failed. A transport-level failure (host down,
          // connection refused, DNS, abort/timeout) means the sidecar is not
          // serving right now: mark it unhealthy so provider selection and the
          // fan-out skip it until its next heartbeat sets it healthy again.
          const msg = err2 instanceof Error ? `${err2.message} ${String((err2 as { cause?: unknown }).cause ?? '')}` : String(err2);
          if (/fetch failed|ECONN|EHOSTDOWN|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|ETIMEDOUT|aborted/i.test(msg)) {
            try {
              updateSidecar(this.sidecar.id, { healthStatus: 'unhealthy' });
              sidecarLogger.warn(`[embed] marked sidecar ${this.sidecar.name}@${this.sidecar.host} unhealthy after transport failure: ${msg.trim()}`);
            } catch { /* registry write is best effort */ }
          }
          throw err2;
        }
      }
    } finally {
      release();
    }
  }
}

// A sidecar whose last heartbeat is older than this is treated as gone even if
// the registry still says 'healthy' (the master never demotes a silent peer).
const SIDECAR_FRESHNESS_MS = 5 * 60_000;

/** True when the registry entry looks alive enough to send work to. */
export function isSidecarUsable(sc: Sidecar, now = Date.now()): boolean {
  if (getEmbedFault(sc.id)) return false;
  if (!sc.enabled) return false;
  if (sc.healthStatus === 'unhealthy') return false;
  if (sc.lastSeen) {
    const seen = Date.parse(sc.lastSeen);
    if (Number.isFinite(seen) && now - seen > SIDECAR_FRESHNESS_MS) return false;
  }
  return true;
}

export type EmbeddingTarget = 'code' | 'docs';

/**
 * Return ONE provider per enabled embedding-capable sidecar (excluding the
 * in-process fallback). Used by the auto-embed loop to fan out a single
 * project's batches across multiple sidecars in parallel. Order is the
 * registry order returned by listSidecars (already sorted by gpu% / load
 * via getSidecarForCapability internals).
 *
 * Returns an empty array when no sidecar advertises embedding — caller
 * should fall back to selectEmbeddingProvider() (single-pick) which
 * applies the strict-mode rules.
 */
/**
 * Capability kinds a target may be served by, in PREFERENCE order. Code
 * embeddings prefer a dedicated 'embedding-code' sidecar (e.g. jina-code on its
 * own port) and fall back to the general 'embedding' capability for setups that
 * serve the code model there. Docs only ever use 'embedding'.
 */
export function capabilityKindsFor(target: EmbeddingTarget): SidecarCapabilityKind[] {
  return target === 'code' ? ['embedding-code', 'embedding'] : ['embedding'];
}

export function selectAllEmbeddingProviders(
  target: EmbeddingTarget,
  desiredModel?: string,
): HttpSidecarProvider[] {
  const semantic = readRuntimeSemantic();
  const fallbackDims = target === 'code'
    ? (semantic.codeDimensions ?? 384)
    : (semantic.docsDimensions ?? 768);
  const fallbackModel = target === 'code' ? 'bge-small-en-v1.5' : 'jina-embeddings-v2-base-en';

  const providers: HttpSidecarProvider[] = [];
  // Dedupe a sidecar that advertises >1 matching PHYSICAL kind — those share
  // one GPU queue, so collapsing them is right. It does NOT collapse a host's
  // OpenRouter capacity, which is separate capacity that merely happens to be
  // reachable through the same agent; those are added by
  // selectAllEmbeddingProvidersWithCloud below, with their own provider keys.
  const seen = new Set<string>();
  for (const kind of capabilityKindsFor(target)) {
    for (const sc of listSidecars({ capability: kind, enabled: true })) {
      const cap = sc.capabilities[kind];
      if (!cap?.available) continue;
      if (desiredModel && !cap.models?.includes(desiredModel)) continue;
      if (seen.has(sc.id)) continue;
      if (!isSidecarUsable(sc)) {
        sidecarLogger.warn(`[embed] skipping ${sc.name}@${sc.host}:${sc.port} for fan-out: healthStatus=${sc.healthStatus ?? '?'} lastSeen=${sc.lastSeen ?? 'never'}`);
        continue;
      }
      seen.add(sc.id);
      const model = desiredModel ?? cap.loaded ?? cap.models?.[0] ?? fallbackModel;
      providers.push(new HttpSidecarProvider(sc, model, fallbackDims, kind));
    }
  }
  return providers;
}

/** The policy role that governs an embedding target. */
export function policyRoleFor(target: EmbeddingTarget): 'code-embedding' | 'embedding' {
  return target === 'code' ? 'code-embedding' : 'embedding';
}

export interface TargetRoutingPolicy {
  role: 'code-embedding' | 'embedding';
  policy: import('../../sidecars/routingPolicy.js').RoutingPolicy;
  label: string;
  /** False ONLY under "OpenRouter only". */
  localServes: boolean;
  joinsFanOut: boolean;
}

/**
 * Resolve the routing policy for an embedding target.
 *
 * One reader, used by the fan-out AND the query encoder, because those two
 * must never disagree: a corpus built on cloud and searched with a local
 * encoder is the 0.976 mismatch applied to 100% of queries, and it returns
 * plausible results with no error to attribute them to.
 */
export async function embeddingRoutingPolicy(target: EmbeddingTarget): Promise<TargetRoutingPolicy> {
  const role = policyRoleFor(target);
  const { getOpenRouterSettings } = await import('../../sidecars/openRouterConfig.js');
  const { effectiveBehaviour, sanitizePolicies, POLICY_LABEL } =
    await import('../../sidecars/routingPolicy.js');
  const policy = sanitizePolicies(getOpenRouterSettings().policyByRole)[role]!;
  const b = effectiveBehaviour(role, policy);
  return { role, policy, label: POLICY_LABEL[policy], localServes: b.localServes, joinsFanOut: b.joinsFanOut };
}

/**
 * The width the target's TABLE is committed to.
 *
 * One reader, because the gate, the fan-out and the query encoder must all
 * mean the same number by "expected dims". LanceDB locks the vector column at
 * table creation, so this is not a preference — a provider whose output is a
 * different width cannot write into the table at all.
 */
export function tableDimsFor(target: EmbeddingTarget): number {
  const semantic = readRuntimeSemantic();
  return target === 'code' ? (semantic.codeDimensions ?? 2560) : (semantic.docsDimensions ?? 1024);
}

/**
 * Must a LOCAL embedding sidecar exist before this target can be built?
 *
 * Three gates predate the cloud policy and all three ask the registry "is an
 * embedding-capable sidecar present?": the boot-time wait in index.ts, the 425
 * guard on /vectors/build-missing, and the per-project provider resolution in
 * semanticSearchService. Under "OpenRouter only" that is the wrong question —
 * the GPUs are excluded by policy, so the gates wait forever for something
 * that is not coming and a re-embed dies with `[strict-sidecar] ... no enabled
 * sidecar advertises capability 'embedding'` while five verified cloud
 * providers sit idle.
 *
 * Deliberately does NOT pre-check that the cloud pool can serve. That question
 * is already answered, once, by `selectAllEmbeddingProvidersWithCloud`, which
 * throws `CloudOnlyUnavailableError` with a named reason. Asking it here too
 * would give two places that can disagree about whether cloud is ready.
 *
 * Unreadable policy returns true: the pre-cloud behaviour is the safe default,
 * because waiting is recoverable and writing wrong-width vectors is not.
 */
export async function localEmbedderRequired(target: EmbeddingTarget): Promise<boolean> {
  try {
    return (await embeddingRoutingPolicy(target)).localServes;
  } catch {
    return true;
  }
}

/** Why no cloud provider could serve, in a form a caller can branch on. */
export type CloudPoolFailure =
  | 'openrouter-disabled'
  | 'no-cloud-provider-discovered'
  | 'no-cloud-provider-verified'
  | 'cloud-width-mismatch'
  | 'cloud-discovery-failed';

/**
 * One EmbeddingProvider that fails over across several.
 *
 * Built for the QUERY path. A query is one short text and a search cannot
 * proceed without its vector, so the cost of a single provider stalling is
 * "no results at all" — the worst available outcome, and one that four idle,
 * verified peers could have prevented. This tries each in turn and throws only
 * when every one has failed, with each failure named.
 *
 * Order: the provider that answered last time goes first. Verified providers
 * agree to 0.9999, so which one encodes the query does not affect the match;
 * which one answers quickly does.
 *
 * Deliberately NOT used for the corpus fan-out, which has its own scheduler
 * with per-chunk failover and throughput weighting. This is the query-side
 * counterpart, and it is small on purpose.
 */
export class FailoverQueryEncoder implements EmbeddingProvider {
  /** Every member is a VirtualEmbeddingProvider, so the facade IS virtual.
   *  This is the contract callers and tests use to mean "cloud-backed
   *  encoder — never a local Q4 model"; the wrapper must not hide it. */
  readonly isVirtual = true;
  private lastGood = 0;
  constructor(private readonly providers: EmbeddingProvider[]) {
    if (providers.length === 0) throw new Error('FailoverQueryEncoder: no providers');
  }
  private ordered(): EmbeddingProvider[] {
    const p = this.providers;
    return [p[this.lastGood], ...p.filter((_, i) => i !== this.lastGood)];
  }
  getModelName(): string { return this.providers[0].getModelName(); }
  getDimensions(): number { return this.providers[0].getDimensions(); }
  /** The anchor's name — what the corpus was measured against. */
  getSidecarName(): string {
    return (this.providers[0] as { getSidecarName?: () => string }).getSidecarName?.() ?? 'cloud';
  }
  async initialize(): Promise<void> {
    // Best-effort on all; a provider that cannot initialise is skipped at embed
    // time, not fatal here, or one bad host would block the healthy ones.
    await Promise.allSettled(this.providers.map(p => p.initialize()));
  }
  async embed(text: string): Promise<Float32Array> {
    return (await this.embedBatch([text]))[0];
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const errors: string[] = [];
    // Cycle the whole pool more than once. One pass gives each provider one
    // shot; a transient stall on all of them at the same moment (a re-verify
    // burst right after a restart does exactly this) should cost a second
    // pass, not the query. `semanticSearch.queryEmbedCycles`, default 2.
    const cycles = (() => {
      const v = Number(readRuntimeSemantic().queryEmbedCycles);
      return Number.isFinite(v) && v >= 1 ? Math.min(5, Math.floor(v)) : 2;
    })();
    const attempts = Array.from({ length: cycles }, () => this.ordered()).flat();
    for (const p of attempts) {
      const name = (p as { getSidecarName?: () => string }).getSidecarName?.() ?? p.getModelName();
      try {
        const out = await p.embedBatch(texts);
        this.lastGood = this.providers.indexOf(p);
        if (errors.length > 0) {
          sidecarLogger.warn(`[query-encoder] ${name} answered after ${errors.length} failure(s): ${errors.join('; ')}`);
        }
        return out;
      } catch (err) {
        errors.push(`${name}: ${(err as Error).message.split('\n')[0].slice(0, 120)}`);
      }
    }
    throw new Error(`[query-encoder] every verified cloud provider failed to embed the query — ${errors.join('; ')}`);
  }
}

/**
 * Thrown instead of quietly handing back a local provider when the role is on
 * "OpenRouter only" and the cloud pool cannot serve.
 *
 * This is the whole point of the policy's failure mode. A local encoder on a
 * cloud-built index does not error, does not look wrong, and returns ranked
 * results that are subtly and permanently mis-ordered — the one outcome worse
 * than no answer. So there is no fallback: the caller gets a named reason and
 * decides, and every caller that could have fallen back is listed at the
 * `CloudPoolFailure` union so nothing new can silently join them.
 */
export class CloudOnlyUnavailableError extends Error {
  readonly code = 'cloud-only-unavailable';
  constructor(
    readonly target: EmbeddingTarget,
    readonly reason: CloudPoolFailure,
    message: string,
  ) {
    super(message);
    this.name = 'CloudOnlyUnavailableError';
  }
}

/** Human sentence for each failure, so the message is the same everywhere. */
function cloudPoolMessage(target: EmbeddingTarget, reason: CloudPoolFailure): string {
  const head = `[openrouter-only] '${target}' is on the "OpenRouter only" routing policy`;
  const tail = ' Refusing to use a local embedder: the index is built from cloud vectors, and a local '
    + 'query vector against it is a 0.976-cosine mismatch that returns plausible, wrongly ordered '
    + 'results with no error.';
  switch (reason) {
    case 'openrouter-disabled':
      return `${head}, but OpenRouter is switched off in the config page's OpenRouter section.${tail}`;
    case 'no-cloud-provider-discovered':
      return `${head}, but no OpenRouter-backed provider is registered for this role — check that a sidecar `
        + `holds Fantom's master slot and that the config push reached it.${tail}`;
    case 'no-cloud-provider-verified':
      return `${head}, but no OpenRouter-backed provider has passed the vector-compatibility gate — see `
        + `/admin/sidecars/virtual/verification for the refusal on each one.${tail}`;
    case 'cloud-width-mismatch':
      return `${head}, but no OpenRouter model on offer produces vectors of the width this table is `
        + `committed to (${tableDimsFor(target)}d). LanceDB locks the vector column when the table is `
        + `created, so the table has to be rebuilt at the selected model's width before cloud can serve `
        + `it — see the width note under the model picker.${tail}`;
    case 'cloud-discovery-failed':
      return `${head}, but discovering its cloud providers failed.${tail}`;
  }
}

/**
 * Every OpenRouter-backed provider cleared to serve this target right now, in
 * anchor order, under the cloud verification regime.
 *
 * Under "OpenRouter only" the gate's reference is another CLOUD provider, not
 * a local host — see `vectorCompatibility.ts`. The first same-model provider
 * by name is the anchor and is checked on dimension and upstream pin; the rest
 * are checked against it.
 */
async function selectVerifiedCloudProviders(
  role: 'code-embedding' | 'embedding',
  expectedDims: number,
): Promise<{ providers: EmbeddingProvider[]; failure?: CloudPoolFailure }> {
  const { listVirtualContainers, getVirtualContainersConfig } =
    await import('../../sidecars/virtualContainers.js');
  const { VirtualEmbeddingProvider } = await import('./virtualEmbeddingProvider.js');
  const { ensureVerified, cloudReference, selectCloudReference } = await import('./vectorCompatibility.js');

  if (getVirtualContainersConfig().enabled !== true) {
    return { providers: [], failure: 'openrouter-disabled' };
  }
  const rows = listVirtualContainers(role);
  if (rows.length === 0) return { providers: [], failure: 'no-cloud-provider-discovered' };

  // Separate the width mismatch from a failed verification BEFORE running the
  // gate, because the two need completely different actions and the gate
  // reports both as "not verified". Every configured model being the wrong
  // width is a table rebuild; a verified-but-disagreeing provider is a routing
  // problem. This is the live case for docs: the table is 1024d and every
  // hosted model is 1536d or wider, so without this the operator would get
  // "no provider passed the gate" and no hint that no provider ever could.
  const { findModel } = await import('../../sidecars/openRouterModels.js');
  const widths = rows.map(vc => findModel(vc.model ?? '')?.dims).filter((d): d is number => d !== undefined);
  if (widths.length > 0 && !widths.includes(expectedDims)) {
    sidecarLogger.warn(
      `[embed] every OpenRouter provider for '${role}' produces ${[...new Set(widths)].join('/')}d, but the `
      + `table is ${expectedDims}d — no provider can serve it until the table is rebuilt at that width.`,
    );
    return { providers: [], failure: 'cloud-width-mismatch' };
  }

  // Anchor order, so the provider the others are measured against is the same
  // one across restarts and the query encoder below picks it first.
  const ordered = [...rows].sort((a, b) => a.providerName.localeCompare(b.providerName));
  const { isClearedToEmbed, verdictKey } = await import('./vectorCompatibility.js');
  const keyOf = (vc: VirtualContainer) => verdictKey({
    providerName: vc.providerName, model: vc.model, upstreamProvider: vc.upstreamProvider, reference: 'cloud-ref',
  });
  // Never wait on a PROBE when something is already verified. The old form
  // awaited ensureVerified() for every provider in one Promise.all, so one
  // unverified host with a dead tunnel (a 15s probe timeout) held the whole
  // selection — and this runs on the query path every 60s. Measured: a
  // retrieval stage of 21.6s where the search itself took 3.3s. Verified
  // providers serve now; the rest are probed in the background (single-flight
  // inside ensureVerified) and join on the next refresh. Only when NOTHING is
  // verified yet — first boot — do we wait, or there would be no encoder.
  const anyCleared = ordered.some(vc => isClearedToEmbed(keyOf(vc)));
  const verify = (vc: VirtualContainer): Promise<boolean> => {
    const peer = selectCloudReference(vc, ordered);
    return ensureVerified(vc, peer ? cloudReference(peer) : null, expectedDims, 'cloud-ref');
  };
  const checked = await Promise.all(ordered.map(async vc => {
    try {
      if (isClearedToEmbed(keyOf(vc))) return new VirtualEmbeddingProvider(vc, expectedDims, 'cloud-ref');
      if (anyCleared) {
        void verify(vc).catch(err => sidecarLogger.warn(`[embed] background verification of ${vc.providerName} threw: ${(err as Error).message}`));
        return null;
      }
      const ok = await verify(vc);
      return ok ? new VirtualEmbeddingProvider(vc, expectedDims, 'cloud-ref') : null;
    } catch (err) {
      sidecarLogger.warn(`[embed] cloud-reference verification of ${vc.providerName} threw: ${(err as Error).message}`);
      return null;
    }
  }));
  const providers = checked.filter((p): p is InstanceType<typeof VirtualEmbeddingProvider> => p !== null);
  return providers.length > 0
    ? { providers }
    : { providers: [], failure: 'no-cloud-provider-verified' };
}

/**
 * Every provider that may serve this target RIGHT NOW.
 *
 * Under AGGREGATE that is the local GPU providers plus every VERIFIED
 * OpenRouter-backed one, as peers. Unlike rerank, embedding is NOT
 * local-first: every healthy provider pulls chunks from the same
 * `embedTextsPipelined` queue at the same time and earns its share by measured
 * throughput. That is precisely what makes the compatibility gate
 * load-bearing — local and cloud vectors land in the same table during the
 * same run, so an unverified cloud provider is EXCLUDED here rather than
 * deprioritised.
 *
 * Verification then needs a local reference already serving the live table:
 * comparing cloud against cloud proves nothing about the rows already in it.
 * Which local host is used matters more than it looks — two *identical* local
 * Ollama stacks serving qwen3-embedding:4b measured a pairwise cosine of only
 * ~0.9986 on this fleet, so the 0.99 floor has ~0.0014 of headroom and a
 * borderline cloud provider could pass against one host and fail against
 * another. `semanticSearch.verificationReferenceSidecar` pins it; unset falls
 * back to the first available local provider.
 *
 * Under "OpenRouter only" none of that applies: no local provider is in the
 * pool at all, so there are no local rows for a cloud provider to be
 * interchangeable WITH, and the reference moves to a cloud peer. If the cloud
 * pool cannot serve, this THROWS rather than returning the local providers —
 * every caller here writes rows into the table, and one local row in a
 * cloud-built index is the silent poisoning the gate exists to prevent.
 */
export async function selectAllEmbeddingProvidersWithCloud(
  target: EmbeddingTarget,
  desiredModel?: string,
): Promise<EmbeddingProvider[]> {
  const local = selectAllEmbeddingProviders(target, desiredModel);
  const role = policyRoleFor(target);
  const expectedDims = tableDimsFor(target);

  let routing: TargetRoutingPolicy;
  try {
    routing = await embeddingRoutingPolicy(target);
  } catch (err) {
    sidecarLogger.warn(`[embed] could not read the routing policy: ${(err as Error).message}`);
    return local;
  }

  // ── "OpenRouter only": the GPUs are not in this pool at all ─────────────
  if (!routing.localServes) {
    const { providers, failure } = await selectVerifiedCloudProviders(role, expectedDims)
      .catch((err): { providers: EmbeddingProvider[]; failure: CloudPoolFailure } => {
        sidecarLogger.warn(`[embed] cloud provider discovery failed: ${(err as Error).message}`);
        return { providers: [], failure: 'cloud-discovery-failed' };
      });
    if (failure) throw new CloudOnlyUnavailableError(target, failure, cloudPoolMessage(target, failure));
    sidecarLogger.info(
      `[embed] ${role} is on "${routing.label}" — fan-out pool is cloud only: `
      + `${providers.map(p => (p as { getSidecarName?: () => string }).getSidecarName?.() ?? '?').join(', ')}`
      + `${local.length > 0 ? ` (${local.length} local provider(s) excluded by policy)` : ''}`,
    );
    return providers;
  }

  let cloud: EmbeddingProvider[] = [];
  try {
    const { listVirtualContainers } = await import('../../sidecars/virtualContainers.js');
    const { VirtualEmbeddingProvider } = await import('./virtualEmbeddingProvider.js');
    const { ensureVerified, localReference } = await import('./vectorCompatibility.js');

    // AGGREGATE ("SideCar + OpenRouter") is the only remaining policy that
    // puts a cloud provider in the fan-out beside the GPUs. Under BACKUP the
    // container stays registered and cloud-routable, but it is held in reserve
    // rather than pulling chunks alongside them; under LOCAL it is excluded
    // outright so a stale discovery row cannot quietly duplicate local work.
    if (!routing.joinsFanOut) {
      sidecarLogger.info(
        `[embed] ${role} is on "${routing.label}" — cloud providers are not joining the `
        + 'fan-out. Local GPUs serve this run.',
      );
      return local;
    }

    const rows = listVirtualContainers(role);
    if (rows.length === 0) return local;

    const referenceName = readRuntimeSemantic().verificationReferenceSidecar;
    const referenceProvider = (referenceName
      ? local.find(p => p.getSidecarName() === referenceName)
      : undefined) ?? local[0];
    if (!referenceProvider) {
      sidecarLogger.warn(
        `[embed] ${rows.length} OpenRouter provider(s) discovered but no local embedder is available to verify `
        + 'them against — refusing cloud capacity rather than trusting it unverified.',
      );
      return local;
    }
    const reference = localReference(referenceProvider);

    const checked = await Promise.all(rows.map(async vc => {
      try {
        return (await ensureVerified(vc, reference, expectedDims, 'local-ref'))
          ? new VirtualEmbeddingProvider(vc, expectedDims, 'local-ref')
          : null;
      } catch (err) {
        sidecarLogger.warn(`[embed] verification of ${vc.providerName} threw: ${(err as Error).message}`);
        return null;
      }
    }));
    cloud = checked.filter((p): p is InstanceType<typeof VirtualEmbeddingProvider> => p !== null);
  } catch (err) {
    sidecarLogger.warn(`[embed] cloud provider discovery failed: ${(err as Error).message}`);
    return local;
  }

  if (cloud.length > 0) {
    const name = (p: EmbeddingProvider) =>
      (p as { getSidecarName?: () => string }).getSidecarName?.() ?? 'in-process';
    sidecarLogger.info(
      `[embed] fan-out pool: ${[...local, ...cloud].map(name).join(', ')} (${cloud.length} cloud-backed)`,
    );
  }
  return [...local, ...cloud];
}

/**
 * The encoder for a QUERY, as opposed to the corpus.
 *
 * Before "OpenRouter only" existed there was no such thing: queries went
 * through `selectEmbeddingProvider`, which never constructs a
 * `VirtualEmbeddingProvider`, so every query was embedded LOCALLY regardless
 * of policy. Under the three GPU-serving policies that is fine — the local
 * hosts wrote most of the table and any cloud provider in it had to pass a
 * 0.99 cosine against one of them to get there.
 *
 * Under "OpenRouter only" it is the one thing that must not happen. The corpus
 * is entirely cloud vectors; a local Q4_K_M query vector against it is the
 * measured 0.976 mismatch, not on half the corpus but on every single search,
 * for as long as the policy is set. So the query encoder comes from the same
 * cloud pool as the corpus, and if the pool cannot serve, this throws with a
 * named reason instead of returning something that works.
 */
export async function selectQueryEmbeddingProvider(
  target: EmbeddingTarget,
  desiredModelOrOpts?: string | SelectOptions,
): Promise<EmbeddingProvider> {
  {
    let routing: TargetRoutingPolicy | null = null;
    try {
      routing = await embeddingRoutingPolicy(target);
    } catch (err) {
      // A config read that failed is not a licence to guess. Under the three
      // GPU-serving policies local is correct and this is a harmless miss;
      // under cloud it would be the exact silent failure. Since we cannot tell
      // which we are in, say so and keep the pre-existing behaviour — the log
      // is the only thing that makes the ambiguity visible.
      sidecarLogger.warn(
        `[embed] could not read the routing policy for the query encoder (${(err as Error).message}) — `
        + 'falling through to local selection.',
      );
    }
    if (routing && !routing.localServes) {
      const expectedDims = tableDimsFor(target);
      const { providers, failure } = await selectVerifiedCloudProviders(policyRoleFor(target), expectedDims)
        .catch((err): { providers: EmbeddingProvider[]; failure: CloudPoolFailure } => {
          sidecarLogger.warn(`[embed] cloud query-encoder discovery failed: ${(err as Error).message}`);
          return { providers: [], failure: 'cloud-discovery-failed' };
        });
      if (failure) throw new CloudOnlyUnavailableError(target, failure, cloudPoolMessage(target, failure));
      // ALL of them, behind one failover facade — not just the anchor.
      //
      // This returned `providers[0]` alone, and that single object was cached
      // as the query encoder for every search on the box. When its one hop to
      // OpenRouter ran slow once, the embed timed out and every search and
      // every ask returned 500 — while four other verified providers sat idle.
      // The corpus was built by all of them, verified to agree at 0.9999, so
      // any of them encodes a query the corpus will match. Anchor still goes
      // first; the rest are the failover.
      return new FailoverQueryEncoder(providers);
    }
  }
  return selectEmbeddingProvider(target, desiredModelOrOpts);
}

/**
 * Embed one batch across several sidecars: the texts are split into one chunk
 * per provider, chunks run in parallel, and a chunk whose sidecar fails is
 * retried on the other providers in turn. `onServed` reports which provider
 * produced how many vectors (attribution). Throws only when every provider
 * failed for some chunk.
 */
/** Measured throughput per provider (texts per second, EMA) so the fan-out
 *  gives a fast GPU host proportionally more of each batch than a Mac. Keyed
 *  by sidecar id (or model for in-process). */
const providerRate = new Map<string, number>();
const rateKey = (p: EmbeddingProvider): string =>
  (p as { getSidecarId?: () => string }).getSidecarId?.() ?? `inprocess:${p.getModelName()}`;
function noteRate(p: EmbeddingProvider, texts: number, ms: number): void {
  if (texts <= 0 || ms <= 0) return;
  const r = texts / (ms / 1000);
  const k = rateKey(p);
  const prev = providerRate.get(k);
  providerRate.set(k, prev === undefined ? r : prev * 0.7 + r * 0.3);
}
export function getProviderRates(): Record<string, number> {
  return Object.fromEntries(providerRate);
}

export async function embedBatchFanout(
  providers: EmbeddingProvider[],
  texts: string[],
  onServed?: (provider: EmbeddingProvider, count: number) => void,
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  if (providers.length === 0) throw new Error('embedBatchFanout: no providers');
  if (providers.length === 1) {
    const t0 = Date.now();
    const out = await providers[0].embedBatch(texts);
    noteRate(providers[0], texts.length, Date.now() - t0);
    onServed?.(providers[0], texts.length);
    return out;
  }
  const N = providers.length;
  // Proportional split: unknown providers get the average known rate (or 1).
  const known = providers.map(p => providerRate.get(rateKey(p))).filter((r): r is number => typeof r === 'number');
  const avg = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
  const weights = providers.map(p => Math.max(0.2, providerRate.get(rateKey(p)) ?? avg));
  const wsum = weights.reduce((a, b) => a + b, 0);
  const chunks: string[][] = [];
  let cursor = 0;
  for (let c = 0; c < N; c++) {
    const want = c === N - 1 ? texts.length - cursor : Math.round((texts.length * weights[c]) / wsum);
    chunks.push(texts.slice(cursor, cursor + Math.max(0, want)));
    cursor += Math.max(0, want);
  }
  const one = async (chunk: string[], primaryIdx: number): Promise<Float32Array[]> => {
    if (chunk.length === 0) return [];
    let lastErr: unknown;
    for (let step = 0; step < N; step++) {
      const p = providers[(primaryIdx + step) % N];
      try {
        const t0 = Date.now();
        const out = await p.embedBatch(chunk);
        noteRate(p, chunk.length, Date.now() - t0);
        onServed?.(p, chunk.length);
        return out;
      } catch (err) {
        lastErr = err;
        const name = (p as { getSidecarName?: () => string }).getSidecarName?.() ?? 'provider';
        sidecarLogger.warn(`[embed] fan-out chunk on ${name} failed (${(err as Error).message.split('\n')[0].slice(0, 160)}); ${step + 1 < N ? 'failing over' : 'no providers left'}`);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  };
  const parts = await Promise.all(chunks.map((c, i) => one(c, i)));
  return parts.flat();
}

export type ProviderForce = 'auto' | 'sidecar' | 'inprocess';

export interface SelectOptions {
  desiredModel?: string;
  /** Override the toggle from config; for tests / one-offs. */
  force?: ProviderForce;
}

/**
 * Pick the embedding provider for a given target.
 *
 * Resolution order:
 *   1. `force` argument (if provided)
 *   2. settings.semanticSearch.{code|docs}FromSidecar
 *   3. settings.semanticSearch.{code|docs}Model used as desired model when not given
 *   4. auto-detect: prefer sidecar if one advertises the model; else in-process
 *
 * `force: 'sidecar'` will throw if no sidecar advertises an embedding capability.
 */
/**
 * Per-project override lookup. Reads the runtime config's
 * `projectEmbeddingOverrides` map. Returns null if no override is set.
 */
export function getProjectEmbeddingOverride(projectId: number): { model?: string; sidecarId?: string; dimensions?: number } | null {
  try {
    if (!fs.existsSync(RUNTIME_CONFIG_PATH)) return null;
    const cfg = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf-8'));
    const overrides = cfg?.projectEmbeddingOverrides ?? {};
    const o = overrides[String(projectId)];
    return o && (o.model || o.sidecarId) ? o : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the embedding provider for a specific project. Honors the
 * per-project override map (model + sidecarId) before falling back to
 * the global selectEmbeddingProvider logic.
 */
export function selectEmbeddingProviderForProject(
  target: EmbeddingTarget,
  projectId: number,
): EmbeddingProvider {
  const override = getProjectEmbeddingOverride(projectId);
  if (override?.model) {
    // Force sidecar when an override is set — overrides only make sense
    // when pointing at a specific sidecar-served model.
    return selectEmbeddingProvider(target, { desiredModel: override.model, force: 'sidecar' });
  }
  return selectEmbeddingProvider(target);
}

export function selectEmbeddingProvider(
  target: EmbeddingTarget,
  desiredModelOrOpts?: string | SelectOptions,
): EmbeddingProvider {
  const opts: SelectOptions = typeof desiredModelOrOpts === 'string'
    ? { desiredModel: desiredModelOrOpts }
    : (desiredModelOrOpts ?? {});

  const semantic = readRuntimeSemantic();
  const fromSidecarFlag = target === 'code' ? semantic.codeFromSidecar : semantic.docsFromSidecar;
  const configuredModel = target === 'code' ? semantic.codeModel : semantic.docsModel;
  const force: ProviderForce =
    opts.force
    ?? (fromSidecarFlag === true ? 'sidecar'
      : fromSidecarFlag === false ? 'inprocess'
      : 'auto');

  const desiredModel = opts.desiredModel ?? configuredModel;
  const fallbackModel = target === 'code' ? 'bge-small-en-v1.5' : 'jina-embeddings-v2-base-en';
  const fallbackDims = target === 'code'
    ? (semantic.codeDimensions ?? 384)
    : (semantic.docsDimensions ?? 768);

  if (force === 'inprocess') {
    return target === 'code' ? new InProcessCodeProvider() : new InProcessDocsProvider();
  }

  // Resolve against the target's capability kinds in preference order
  // (code → 'embedding-code' then 'embedding'; docs → 'embedding'). The matched
  // kind is threaded into the provider so its request URL resolves to the right
  // port (each Sound Suite role has its own).
  const kinds = capabilityKindsFor(target);
  let sc: Sidecar | null = null;
  let matchedKind: SidecarCapabilityKind = kinds[0];
  // A sidecar with an active capability fault for this kind (refuses the
  // model, or has not pulled it yet) is skipped so a single-provider caller
  // (the re-embed job) does not get a provider that fails every batch.
  const faulted = (kind: SidecarCapabilityKind) => (s: Sidecar): boolean => !!getEmbedFault(s.id, kind);
  // First try strict match: a sidecar advertising the desired model.
  for (const kind of kinds) {
    const found = getSidecarForCapability(kind, desiredModel, faulted(kind));
    if (found) { sc = found; matchedKind = kind; break; }
  }

  // Strict-sidecar fallback BETWEEN exact-model and any-model: at boot the
  // WS heartbeat may not have refreshed the registry yet, so try any
  // sidecar that advertises an embedding kind before giving up. This still
  // requires a real sidecar — does NOT fall back to Xenova in-process.
  if (!sc && force === 'sidecar') {
    for (const kind of kinds) {
      const found = getSidecarForCapability(kind, undefined, faulted(kind));
      if (found) { sc = found; matchedKind = kind; break; }
    }
    if (sc && desiredModel) {
      console.warn(
        `[selectEmbeddingProvider] sidecar '${sc.name}' does not yet advertise '${desiredModel}'; using its current models. Will refresh on next heartbeat.`,
      );
    }
  }

  if (sc) {
    const cap = sc.capabilities[matchedKind]!;
    const model =
      desiredModel
      ?? cap.loaded
      ?? cap.models?.[0]
      ?? fallbackModel;
    return new HttpSidecarProvider(sc, model, fallbackDims, matchedKind);
  }

  // Strict-sidecar mode: when the user has set codeFromSidecar=true /
  // docsFromSidecar=true (or passed force:'sidecar' explicitly) we MUST
  // NOT fall back to in-process Xenova — that would write 384d vectors
  // into the configured 1024d LanceDB table, corrupting it. Throwing
  // here is caught by the per-project try/catch in the auto-embed loop
  // (recorded as a failure) and by ad-hoc callers (returns a clear error
  // through the MCP layer). Operators see "waiting for sidecar" instead
  // of silent dimension drift.
  if (force === 'sidecar') {
    throw new Error(
      `[strict-sidecar] '${target}' is forced to sidecar (codeFromSidecar/docsFromSidecar=true) but no enabled sidecar advertises capability 'embedding'`
        + (desiredModel ? ` with model '${desiredModel}'` : '')
        + `. Refusing to fall back to in-process — would corrupt the LanceDB table with mismatched dimensions. Wait for the sidecar to register or disable strict-sidecar mode.`,
    );
  }

  return target === 'code' ? new InProcessCodeProvider() : new InProcessDocsProvider();
}
