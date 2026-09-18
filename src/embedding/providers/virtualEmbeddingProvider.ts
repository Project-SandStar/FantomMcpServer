/**
 * An OpenRouter-backed embedding provider — one `<PCName>-OR-CodeEmbedding`.
 *
 * It looks like any other EmbeddingProvider to `embedTextsPipelined`, which is
 * the point: the scheduler already measures per-provider throughput, sizes
 * chunks to it, and gives a fast provider more requests in flight. A cloud
 * provider needs no special casing there beyond its own concurrency cap.
 *
 * Two things do make it different:
 *
 * - **It fails closed on verification.** `embedBatch` refuses unless the
 *   vector-compatibility gate has cleared this exact (provider, model, pinned
 *   upstream) triple. Local and cloud vectors land in the same table during
 *   the same run, so an unverified provider serving even one chunk is a
 *   silently poisoned table.
 *
 * - **It spends from a GLOBAL permit pool, not a local cap.** OpenRouter
 *   rate-limits per KEY, and every sidecar we push config to holds the same
 *   key — so three providers each capped at 8 in-flight is 24 requests
 *   against one budget, and a per-provider cap protects nothing. Every call
 *   goes through `withCloudPermit` in `cloudBudget.ts`, which is the single
 *   account-wide authority. The scheduler's `depth` governs how many requests
 *   this provider *offers*; the pool governs how many actually fly, across
 *   all of them. `virtualContainers.embedMaxInFlight` survives only as a
 *   per-provider politeness ceiling underneath the global budget.
 *
 * `getSidecarId()` returns a key distinct from the host sidecar's id. The
 * scheduler memoises measured rates by that key — sharing the host's id would
 * blend a 2560d cloud route and a local GPU into one rate and mis-size chunks
 * for both.
 */

import { readRuntimeSemantic, type EmbeddingProvider } from './embeddingProvider.js';
import { virtualEmbed } from '../../sidecars/virtualInferenceClient.js';
import {
  getVirtualContainersConfig,
  DEFAULT_OR_EMBED_MAX_IN_FLIGHT,
  type VirtualContainer,
} from '../../sidecars/virtualContainers.js';
import {
  verdictKey, isClearedToEmbed, getRefusal, type VerificationRegime,
} from './vectorCompatibility.js';
import { withCloudPermit } from './cloudBudget.js';
import {
  noteCallStarted, noteCallFinished, isRoleCapped,
} from '../../sidecars/openRouterActivity.js';

/** Minimal counting semaphore — no dependency, no timer. */
class Gate {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.limit) { this.active++; return; }
    await new Promise<void>(resolve => this.waiters.push(resolve));
    this.active++;
  }
  release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
  get inFlight(): number { return this.active; }
}

/** One gate per provider name, shared across the provider objects that the
 *  per-project re-select creates — the OpenRouter rate limit is per account,
 *  so a fresh object per project must not reset the cap. */
const gates = new Map<string, Gate>();

function gateFor(providerName: string, limit: number): Gate {
  let g = gates.get(providerName);
  if (!g) { g = new Gate(limit); gates.set(providerName, g); }
  return g;
}

export class VirtualEmbeddingProvider implements EmbeddingProvider {
  readonly isVirtual = true;
  private readonly key: string;
  private readonly gate: Gate;

  /**
   * `regime` is passed in, never inferred. A verdict reached against a cloud
   * peer does not say this provider agrees with the local hosts, so the two
   * regimes keep separate ledger entries — and a provider that guessed which
   * one it was operating under would check the wrong entry and fail open on
   * exactly the case the gate exists for. It defaults to `local-ref`, the
   * stricter claim, so an un-migrated call site fails closed rather than open.
   */
  constructor(
    readonly container: VirtualContainer,
    private readonly expectedDims: number,
    private readonly regime: VerificationRegime = 'local-ref',
    maxInFlight?: number,
  ) {
    this.key = verdictKey({
      providerName: container.providerName,
      model: container.model,
      upstreamProvider: container.upstreamProvider,
      reference: regime,
    });
    const limit = maxInFlight
      ?? getVirtualContainersConfig().embedMaxInFlight
      ?? DEFAULT_OR_EMBED_MAX_IN_FLIGHT;
    this.gate = gateFor(container.providerName, limit);
  }

  /** Distinct from the host sidecar's id — see the module header. */
  getSidecarId(): string { return `or:${this.container.sidecarId}:${this.container.role}`; }
  /** What the scheduler and projectEmbeddingMeta attribute work to. */
  getSidecarName(): string { return this.container.providerName; }

  getModelName(): string { return this.container.model; }
  getDimensions(): number { return this.container.dims ?? this.expectedDims; }
  async initialize(): Promise<void> { /* the sidecar owns readiness */ }

  async embed(text: string): Promise<Float32Array> {
    const [v] = await this.embedBatch([text]);
    return v;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    // Fail closed. `isClearedToEmbed` is false both for a known-bad provider
    // and for one never checked — from the table's point of view those are
    // the same thing.
    if (!isClearedToEmbed(this.key)) {
      const r = getRefusal(this.key);
      throw new Error(
        `[vector-gate] ${this.container.providerName} is not cleared to embed`
        + (r ? ` (${r.kind}: ${r.reason})` : ` (never passed vector-compatibility verification under ${this.regime})`)
        + ` — refusing to write ${texts.length} vectors into the ${this.expectedDims}d table.`,
      );
    }

    // Global budget first, then the per-provider ceiling. A 429 raised here
    // halves the account-wide budget and starts a jittered cooldown; it never
    // touches the local GPU providers, which pull their own work.
    return withCloudPermit(async () => {
      await this.gate.acquire();
      try {
        return await this.embedOnce(texts);
      } finally {
        this.gate.release();
      }
    });
  }

  private async embedOnce(texts: string[]): Promise<Float32Array[]> {
    // A daily cap can only prevent spend if it is checked BEFORE the call.
    if (isRoleCapped(this.container.role as 'code-embedding' | 'embedding')) {
      throw new Error(
        `[spend-cap] ${this.container.providerName} has reached its daily cap for role `
        + `'${this.container.role}' — raise or clear the cap in the config page's OpenRouter section. `
        + 'Local GPU providers are unaffected and keep serving.',
      );
    }
    const startedAt = Date.now();
    const role = this.container.role as 'code-embedding' | 'embedding';
    noteCallStarted(role);
    try {
      // Size the timeout to the WORK, not to the worst case.
      //
      // virtualEmbed defaults to 120s, which is right for a batch of hundreds
      // during a rebuild and absurd for a single query text. An ask embeds the
      // query once per project in scope — seven times for a project with six
      // neighbours — so one unhealthy provider stalled the whole answer for
      // two minutes against a 20s budget, and the ask returned a 500 after
      // 136s. The budget could not bind because a single call could outlive it
      // by 6x.
      //
      // ~400ms per text with an 8s floor: a query gets 8s, a 300-text batch
      // still gets the full 120s.
      // NOT a hardcoded floor. The 8s floor that was here produced a worse
      // failure than the 120s it replaced: a query embed that ran 9s under
      // load timed out, the primary search returned empty, and synthesis
      // truthfully reported "no results found" for a project with 5,210
      // vectors. A slow answer beats a wrong one. The per-text floor is now
      // config (`semanticSearch.embedQueryTimeoutMs`, default 20s) and the
      // failover encoder retries across providers, so a slow host costs a
      // retry, not the result. Batches still scale with size.
      const perTextFloor = (() => {
        const v = Number(readRuntimeSemantic().embedQueryTimeoutMs);
        return Number.isFinite(v) && v >= 1_000 ? v : 20_000;
      })();
      const timeoutMs = Math.min(120_000, Math.max(perTextFloor, texts.length * 400));
      const res = await virtualEmbed(this.container, texts, timeoutMs);
      noteCallFinished(role, {
        servedBy: this.container.providerName,
        model: res.model ?? this.container.model,
        tokens: res.totalTokens,
        durationMs: Date.now() - startedAt,
        success: true,
      });
      const arrays = res.embeddings ?? [];
      if (arrays.length !== texts.length) {
        throw new Error(
          `${this.container.providerName} returned ${arrays.length} embeddings for ${texts.length} inputs`,
        );
      }
      const dim = arrays[0]?.length ?? 0;
      if (dim !== this.expectedDims) {
        // Width can drift after verification if the pinned upstream changes
        // behind the same model slug. Never store it.
        throw new Error(
          `${this.container.providerName} returned ${dim}-dim vectors but the table is ${this.expectedDims}-dim `
          + '— refusing to store them',
        );
      }
      return arrays.map(a => Float32Array.from(a));
    } catch (err) {
      noteCallFinished(role, {
        servedBy: this.container.providerName,
        model: this.container.model,
        durationMs: Date.now() - startedAt,
        success: false,
        error: (err as Error).message,
      });
      throw err;
    }
  }
}

/** Test seam. */
export function __resetVirtualEmbeddingGatesForTest(): void {
  gates.clear();
}
