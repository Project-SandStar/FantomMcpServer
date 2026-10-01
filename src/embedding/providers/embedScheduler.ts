/**
 * Pipelined, per-provider embedding scheduler.
 *
 * Why this exists (measured 2026-09-14 on the full code re-embed, see
 * docs/tasks/reembed-throughput-2026-09-14.md): `embedBatchFanout` splits ONE
 * 50-text batch across every sidecar and awaits Promise.all, so every batch
 * lasts as long as its slowest chunk. With one fast GPU host (~11 texts/s) and
 * two Macs (~1.7 texts/s each) the GPU host finished its share in ~3.2 s and
 * then idled ~1.6 s per round waiting for a Mac — the job ran at ~10 texts/s
 * while the fleet could do ~15+. The GPU host also processes concurrent
 * requests in parallel (4 in flight ≈ 1.8× one request) which lock-step
 * rounds never exploit; the Macs serialize concurrent requests (no gain).
 *
 * This scheduler instead gives every provider its own worker loop that PULLS
 * chunks from a shared queue of texts:
 *   - chunk size per provider = measured texts/s × target chunk latency
 *     (a fast host takes ~30 texts per request, a Mac ~5) so requests on every
 *     host last about the same;
 *   - a provider that is at least `slowDepthRatio` as fast as the best one may
 *     keep `depth` requests in flight (the GPU host pipelines); slower ones
 *     keep one (serializing hosts gain nothing from more);
 *   - end-game rule: a provider does not take a chunk whose expected duration
 *     exceeds 1.5× the time the whole pool needs for the remaining work, so a
 *     Mac cannot hold the last chunk of a project while the GPU host idles;
 *   - a failed chunk is re-queued at the front for other providers; after
 *     `maxConsecutiveFailures` the provider is dropped for this run;
 *   - `onChunk` (store the vectors) runs serialized and overlapped with the
 *     requests still in flight; `shouldCancel` is consulted before each
 *     dispatch and in-flight requests drain before the call resolves.
 *
 * Rates persist per provider key across calls (one call per project) so the
 * second project starts with correct chunk sizes.
 */

import type { EmbeddingProvider } from './embeddingProvider.js';

export interface PipelineOptions {
  /** Called once per completed chunk, serialized in completion order; may be async (e.g. LanceDB write). */
  onChunk?: (indices: number[], vectors: Float32Array[], provider: EmbeddingProvider) => void | Promise<void>;
  /** Attribution hook — which provider produced how many vectors. */
  onServed?: (provider: EmbeddingProvider, count: number) => void;
  /** Checked before every dispatch; when true no further chunks start. */
  shouldCancel?: () => boolean;
  /** Max requests in flight for a provider close to the fastest one (default 3). */
  depth?: number;
  /** Target latency of one request (default 3000 ms) — sizes chunks per provider. */
  targetChunkMs?: number;
  /** Chunk size bounds (default 2 .. 64). */
  minChunk?: number;
  maxChunk?: number;
  /** Chunk size used for a provider with no rate history yet (default 8). */
  probeChunk?: number;
  /** A provider slower than this fraction of the best gets depth 1 (default 0.5). */
  slowDepthRatio?: number;
  /** A provider slower than this fraction of the best is not given work at all (default 0.05). */
  minRateRatio?: number;
  /** Consecutive failures after which a provider is dropped for this run (default 2). */
  maxConsecutiveFailures?: number;
  /** Multiplier on the pool's remaining ETA above which a slow provider declines a chunk (default 1.5). */
  endgameFactor?: number;
  /**
   * A provider parked as "too slow" gets one fresh probe chunk after this many
   * chunks were dispatched to the others (default 20). Its memo is the only
   * thing that can rehabilitate it, and only a completed chunk updates the
   * memo — without this, one timed-out first sample (the Mac lanes, 0.7 t/s
   * from a 15 s probe) parked a healthy lane for the whole 262k-row run.
   */
  reprobeEvery?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface PipelineResult {
  /** Same length/order as the input; `undefined` where every provider failed or the run was cancelled. */
  vectors: Array<Float32Array | undefined>;
  /** Texts that were attempted and failed on every available provider. */
  failed: number;
  /** Texts never attempted because the run was cancelled. */
  skipped: number;
  cancelled: boolean;
  errors: string[];
  /** provider name → texts served. */
  servedBy: Record<string, number>;
  requests: number;
  elapsedMs: number;
}

interface ProviderState {
  p: EmbeddingProvider;
  key: string;
  name: string;
  inFlight: number;
  done: number;
  firstDispatchAt: number | null;
  activeSince: number | null;
  busyMs: number;
  consecutiveFailures: number;
  dropped: boolean;
}

interface RateMemo { reqRate: number; throughput: number }

/** texts/s per provider key, EMA over requests (persists across calls in this process). */
const rateMemo = new Map<string, RateMemo>();

export function providerKey(p: EmbeddingProvider): string {
  const withId = p as { getSidecarId?: () => string };
  return withId.getSidecarId?.() ?? `inprocess:${p.getModelName()}`;
}

function providerName(p: EmbeddingProvider): string {
  const withName = p as { getSidecarName?: () => string };
  return withName.getSidecarName?.() ?? 'in-process';
}

export function getPipelineRates(): Record<string, RateMemo> {
  return Object.fromEntries(rateMemo);
}

export function _resetPipelineRatesForTests(): void {
  rateMemo.clear();
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export async function embedTextsPipelined(
  providers: EmbeddingProvider[],
  texts: string[],
  opts: PipelineOptions = {},
): Promise<PipelineResult> {
  const now = opts.now ?? (() => Date.now());
  const t0 = now();
  const depth = Math.max(1, Math.floor(opts.depth ?? 3));
  const targetChunkMs = opts.targetChunkMs ?? 3000;
  const minChunk = Math.max(1, opts.minChunk ?? 2);
  const maxChunk = Math.max(minChunk, opts.maxChunk ?? 64);
  const probeChunk = clamp(opts.probeChunk ?? 8, minChunk, maxChunk);
  const slowDepthRatio = opts.slowDepthRatio ?? 0.5;
  const minRateRatio = opts.minRateRatio ?? 0.05;
  const maxFailures = Math.max(1, opts.maxConsecutiveFailures ?? 2);
  const endgameFactor = opts.endgameFactor ?? 1.5;
  const reprobeEvery = Math.max(1, Math.floor(opts.reprobeEvery ?? 20));
  const log = opts.log ?? (() => {});
  // Chunks dispatched to anyone, and per-provider the count at which it was
  // last skipped as too slow — the gap between them is its wait.
  let dispatched = 0;
  const parkedAt = new Map<string, number>();

  const result: PipelineResult = {
    vectors: new Array<Float32Array | undefined>(texts.length).fill(undefined),
    failed: 0,
    skipped: 0,
    cancelled: false,
    errors: [],
    servedBy: {},
    requests: 0,
    elapsedMs: 0,
  };
  if (texts.length === 0) return result;
  if (providers.length === 0) throw new Error('embedTextsPipelined: no providers');

  const states: ProviderState[] = providers.map(p => ({
    p,
    key: providerKey(p),
    name: providerName(p),
    inFlight: 0,
    done: 0,
    firstDispatchAt: null,
    activeSince: null,
    busyMs: 0,
    consecutiveFailures: 0,
    dropped: false,
  }));

  // Queue of text indices; failed chunks go back to the FRONT so they are
  // retried before new work.
  const queue: number[] = texts.map((_, i) => i);
  let storeChain: Promise<void> = Promise.resolve();
  let cancelled = false;
  let settled = false;
  let resolveDone!: () => void;
  const done = new Promise<void>(r => { resolveDone = r; });

  const memo = (s: ProviderState): RateMemo | undefined => rateMemo.get(s.key);
  /** Best estimate of a provider's sustained texts/s (all in-flight requests together). */
  const busyWallMs = (s: ProviderState): number =>
    s.busyMs + (s.inFlight > 0 && s.activeSince !== null ? now() - s.activeSince : 0);
  const throughputOf = (s: ProviderState): number | undefined => {
    const busy = busyWallMs(s);
    if (s.done > 0 && busy > 0) return s.done / (busy / 1000);
    return memo(s)?.throughput;
  };
  /** texts/s of a single request on this provider — sizes one chunk. */
  const reqRateOf = (s: ProviderState): number | undefined => memo(s)?.reqRate;

  const active = () => states.filter(s => !s.dropped);
  const totalInFlight = () => states.reduce((a, s) => a + s.inFlight, 0);

  const finish = () => {
    if (settled) return;
    settled = true;
    resolveDone();
  };

  const checkDone = () => {
    if (settled) return;
    if (totalInFlight() > 0) return;
    if (cancelled) {
      result.skipped = queue.length;
      queue.length = 0;
      finish();
      return;
    }
    if (queue.length === 0) { finish(); return; }
    if (active().length === 0) {
      // Every provider dropped: what is left cannot be embedded in this run.
      result.failed += queue.length;
      queue.length = 0;
      finish();
    }
  };

  const noteCompletion = (s: ProviderState, n: number, ms: number) => {
    const r = n / (Math.max(1, ms) / 1000);
    const prev = memo(s);
    const reqRate = prev ? prev.reqRate * 0.7 + r * 0.3 : r;
    const thr = throughputOf(s) ?? reqRate;
    rateMemo.set(s.key, { reqRate, throughput: thr });
  };

  const dispatch = (s: ProviderState, indices: number[]) => {
    const chunk = indices.map(i => texts[i]);
    const start = now();
    if (s.firstDispatchAt === null) s.firstDispatchAt = start;
    if (s.inFlight === 0) s.activeSince = start;
    s.inFlight++;
    result.requests++;
    void (async () => {
      let vecs: Float32Array[] | null = null;
      let err: unknown = null;
      try {
        vecs = await s.p.embedBatch(chunk);
        if (!Array.isArray(vecs) || vecs.length !== chunk.length) {
          throw new Error(`provider ${s.name} returned ${vecs?.length ?? 0} vectors for ${chunk.length} texts`);
        }
      } catch (e) {
        err = e;
      }
      const ms = now() - start;
      s.inFlight--;
      // Busy wall for the provider = union of its in-flight intervals, so a
      // host with 3 overlapping requests is not counted three times.
      if (s.inFlight === 0 && s.activeSince !== null) {
        s.busyMs += now() - s.activeSince;
        s.activeSince = null;
      }
      if (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // A 429 is the UPSTREAM saying busy (DeepInfra: "Model busy, retry
        // later"), not this lane being broken — every lane reaches the same
        // upstream. Counting it toward the drop threshold banned the Mac
        // lane five times in two projects on 2026-09-29 while the other
        // lanes carried on against the same host. Re-queue the chunk, do
        // not advance the failure count; the cloud budget already backs off.
        // NOT a gate refusal: "[vector-gate] X is not cleared to embed (probe-failed: …429…)"
        // quotes the 429 that failed its probe, but the lane itself is
        // refused and will keep failing — counting that as rate-limited
        // re-queued the same chunk forever, and the log lines from that loop
        // took the process to the V8 heap limit (2026-09-29, 13:25).
        const gateRefused = /not cleared to embed|\[vector-gate\]/i.test(msg);
        const rateLimited = !gateRefused && /\b429\b|rate.?limit|Model busy|engine_overloaded/i.test(msg);
        if (!rateLimited) s.consecutiveFailures++;
        result.errors.push(`${s.name}: ${msg.split('\n')[0].slice(0, 200)}`);
        queue.unshift(...indices);
        if (rateLimited) {
          log(`provider ${s.name} chunk of ${chunk.length} rate-limited upstream, re-queued (${msg.split('\n')[0].slice(0, 120)})`);
        } else if (s.consecutiveFailures >= maxFailures) {
          s.dropped = true;
          log(`provider ${s.name} dropped after ${s.consecutiveFailures} consecutive failures (${msg.split('\n')[0].slice(0, 120)})`);
        } else {
          log(`provider ${s.name} chunk of ${chunk.length} failed, re-queued (${msg.split('\n')[0].slice(0, 120)})`);
        }
      } else {
        s.done += chunk.length;
        s.consecutiveFailures = 0;
        noteCompletion(s, chunk.length, ms);
        for (let j = 0; j < indices.length; j++) result.vectors[indices[j]] = vecs![j];
        result.servedBy[s.name] = (result.servedBy[s.name] ?? 0) + chunk.length;
        opts.onServed?.(s.p, chunk.length);
        if (opts.onChunk) {
          const cb = opts.onChunk;
          storeChain = storeChain
            .then(() => cb(indices, vecs!, s.p))
            .catch(e => { result.errors.push(`onChunk: ${e instanceof Error ? e.message : String(e)}`); });
        }
      }
      pump();
      checkDone();
    })();
  };

  const pump = () => {
    if (settled) return;
    if (!cancelled && opts.shouldCancel?.()) {
      cancelled = true;
      log(`cancel requested — draining ${totalInFlight()} in-flight request(s), ${queue.length} text(s) left`);
    }
    if (cancelled) return;
    const live = active();
    if (live.length === 0) return;
    const thrs = live.map(s => throughputOf(s)).filter((v): v is number => typeof v === 'number' && v > 0);
    const best = thrs.length ? Math.max(...thrs) : undefined;
    const poolRate = thrs.length ? thrs.reduce((a, b) => a + b, 0) : undefined;

    // Fastest first so the GPU host gets first pick when work is scarce.
    const order = [...live].sort((a, b) => (throughputOf(b) ?? 0) - (throughputOf(a) ?? 0));
    let progressed = true;
    while (progressed && queue.length > 0) {
      progressed = false;
      for (const s of order) {
        if (queue.length === 0) break;
        const thr = throughputOf(s);
        const rr = reqRateOf(s);
        // Depth: unknown-rate providers probe with one request; only providers
        // close to the best may pipeline.
        let allowed = 1;
        let reprobe = false;
        if (thr !== undefined && best !== undefined) {
          if (thr < best * minRateRatio && live.length > 1) {
            // Too slow to be worth a chunk — unless it has waited long enough
            // for a fresh sample. One probe-sized chunk, depth 1; a good
            // completion lifts its memo and it rejoins on merit.
            const since = parkedAt.get(s.key);
            if (since === undefined) { parkedAt.set(s.key, dispatched); continue; }
            if (dispatched - since < reprobeEvery || s.inFlight > 0) continue;
            reprobe = true;
          } else {
            allowed = thr >= best * slowDepthRatio ? depth : 1;
          }
        }
        if (s.inFlight >= allowed) continue;
        let k = reprobe
          ? probeChunk
          : rr ? clamp(Math.round(rr * targetChunkMs / 1000), minChunk, maxChunk) : probeChunk;
        k = Math.min(k, queue.length);
        // End-game: do not let a slow provider take a chunk that would outlast
        // what the pool needs for everything that is left (plus the chunk the
        // best provider would take). A re-probe is exempt: its whole point is
        // a sample, and it is one small chunk.
        if (!reprobe && thr !== undefined && best !== undefined && thr < best && poolRate) {
          const remaining = queue.length + totalInFlight();
          const poolEtaS = remaining / poolRate;
          const myEtaS = k / thr;
          if (myEtaS > endgameFactor * poolEtaS + 0.5) continue;
        }
        if (reprobe) {
          parkedAt.set(s.key, dispatched);
          // A fresh sample, not an average with the bad one: the in-run rate
          // is done/busy, and one 15 s timeout in `busy` would keep the lane
          // under the floor for dozens more probes.
          s.done = 0;
          s.busyMs = 0;
          log(`provider ${s.name} re-probed with ${k} text(s) after ${reprobeEvery} chunks parked (memo ${(thr ?? 0).toFixed(1)}/s vs best ${(best ?? 0).toFixed(1)}/s)`);
        }
        const indices = queue.splice(0, k);
        dispatched++;
        dispatch(s, indices);
        progressed = true;
      }
    }
  };

  pump();
  checkDone();
  await done;
  await storeChain;
  result.cancelled = cancelled;
  result.elapsedMs = now() - t0;
  const summary = states.map(s => `${s.name}=${s.done}${s.dropped ? '(dropped)' : ''}@${(throughputOf(s) ?? 0).toFixed(1)}/s`).join(' ');
  log(`pipeline done texts=${texts.length} requests=${result.requests} failed=${result.failed} skipped=${result.skipped} elapsed=${result.elapsedMs}ms ${summary}`);
  return result;
}
