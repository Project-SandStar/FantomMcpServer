/**
 * Scheduler throughput test with mocked providers modelled on the measured
 * fleet (2026-09-14): one GPU host that scales with concurrent requests and
 * two Macs that serialize requests. Time is scaled 1 ms = 10 ms of reality.
 */
import { embedTextsPipelined, _resetPipelineRatesForTests } from '../embedding/providers/embedScheduler.js';
import type { EmbeddingProvider } from '../embedding/providers/embeddingProvider.js';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

interface MockOpts {
  name: string;
  /** fixed per-request overhead (ms) */
  overhead: number;
  /** ms per text */
  perText: number;
  /** true = concurrent requests queue behind each other (a Mac); false = they overlap (GPU host) */
  serialize: boolean;
  failEvery?: number;
}

class MockProvider implements EmbeddingProvider {
  calls = 0;
  maxConcurrent = 0;
  private inFlight = 0;
  private chain: Promise<void> = Promise.resolve();
  constructor(private o: MockOpts) {}
  getSidecarId() { return `id-${this.o.name}`; }
  getSidecarName() { return this.o.name; }
  getModelName() { return 'mock'; }
  getDimensions() { return 4; }
  async initialize() {}
  async embed(t: string) { return (await this.embedBatch([t]))[0]; }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    this.calls++;
    this.inFlight++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);
    const work = async () => {
      await sleep(this.o.overhead + this.o.perText * texts.length);
      if (this.o.failEvery && this.calls % this.o.failEvery === 0) throw new Error(`${this.o.name} boom`);
    };
    try {
      if (this.o.serialize) {
        const p = this.chain.then(work, work);
        this.chain = p.catch(() => {});
        await p;
      } else {
        await work();
      }
      return texts.map((_, i) => Float32Array.of(i, 1, 2, 3));
    } finally {
      this.inFlight--;
    }
  }
}

/** The legacy lock-step fan-out: split every batch by rate, await all chunks. */
async function lockstep(providers: MockProvider[], texts: string[], batchSize: number, rates: number[]): Promise<number> {
  const t0 = Date.now();
  const wsum = rates.reduce((a, b) => a + b, 0);
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    let cursor = 0;
    const chunks = providers.map((_, c) => {
      const want = c === providers.length - 1 ? batch.length - cursor : Math.round(batch.length * rates[c] / wsum);
      const ch = batch.slice(cursor, cursor + want);
      cursor += want;
      return ch;
    });
    await Promise.all(chunks.map((c, i) => c.length ? providers[i].embedBatch(c) : []));
  }
  return Date.now() - t0;
}

// Scaled model: GPU host 50 ms overhead + 9 ms/text (≈11 texts/s at 36 texts),
// Macs 60 ms overhead + 55 ms/text (≈1.7 texts/s), serializing.
const fleet = () => [
  new MockProvider({ name: 'gpu', overhead: 50, perText: 9, serialize: false }),
  new MockProvider({ name: 'mac-a', overhead: 60, perText: 55, serialize: true }),
  new MockProvider({ name: 'mac-b', overhead: 60, perText: 55, serialize: true }),
];

describe('embedTextsPipelined', () => {
  beforeEach(() => _resetPipelineRatesForTests());

  test('beats lock-step fan-out, preserves order and attribution', async () => {
    const texts = Array.from({ length: 300 }, (_, i) => `text-${i}`);

    const legacy = fleet();
    const legacyMs = await lockstep(legacy, texts, 50, [10, 1.7, 1.7]);

    const providers = fleet();
    const stored: number[] = [];
    const served: Record<string, number> = {};
    const t0 = Date.now();
    const res = await embedTextsPipelined(providers, texts, {
      depth: 3,
      targetChunkMs: 300,
      onChunk: (indices) => { stored.push(...indices); },
      onServed: (p, n) => { const k = (p as MockProvider).getSidecarName(); served[k] = (served[k] ?? 0) + n; },
    });
    const pipelinedMs = Date.now() - t0;

    expect(res.cancelled).toBe(false);
    expect(res.failed).toBe(0);
    expect(res.vectors.every(v => v instanceof Float32Array)).toBe(true);
    expect(stored.sort((a, b) => a - b)).toEqual(texts.map((_, i) => i));
    expect(Object.values(served).reduce((a, b) => a + b, 0)).toBe(texts.length);
    expect(Object.values(res.servedBy).reduce((a, b) => a + b, 0)).toBe(texts.length);
    // The GPU host pipelines; the Macs only ever hold one request.
    expect(providers[0].maxConcurrent).toBeGreaterThan(1);
    expect(providers[0].maxConcurrent).toBeLessThanOrEqual(3);
    // The GPU host does the large majority of the work.
    expect(res.servedBy.gpu).toBeGreaterThan(texts.length * 0.6);
    // Throughput gain: at least 1.3x over lock-step on the same mocked fleet.
    // eslint-disable-next-line no-console
    console.log(`lock-step ${legacyMs}ms vs pipelined ${pipelinedMs}ms (${(legacyMs / pipelinedMs).toFixed(2)}x) servedBy=${JSON.stringify(res.servedBy)} requests=${res.requests}`);
    expect(pipelinedMs * 1.3).toBeLessThan(legacyMs);
  }, 60_000);

  test('re-queues failed chunks and drops a provider that keeps failing', async () => {
    const texts = Array.from({ length: 60 }, (_, i) => `t${i}`);
    const bad = new MockProvider({ name: 'bad', overhead: 5, perText: 1, serialize: false, failEvery: 1 });
    const good = new MockProvider({ name: 'good', overhead: 5, perText: 2, serialize: false });
    const logs: string[] = [];
    const res = await embedTextsPipelined([bad, good], texts, { depth: 2, targetChunkMs: 100, log: m => logs.push(m) });
    expect(res.failed).toBe(0);
    expect(res.vectors.every(v => v instanceof Float32Array)).toBe(true);
    expect(res.servedBy.good).toBe(texts.length);
    expect(res.servedBy.bad).toBeUndefined();
    expect(logs.some(l => /bad dropped/.test(l))).toBe(true);
    expect(res.errors.length).toBeGreaterThan(0);
  });

  test('reports texts as failed when every provider is gone', async () => {
    const bad = new MockProvider({ name: 'bad', overhead: 1, perText: 1, serialize: false, failEvery: 1 });
    const res = await embedTextsPipelined([bad], ['a', 'b', 'c'], { maxConsecutiveFailures: 1 });
    expect(res.failed).toBe(3);
    expect(res.vectors.every(v => v === undefined)).toBe(true);
  });

  test('cancellation stops dispatch and drains in-flight work', async () => {
    const texts = Array.from({ length: 200 }, (_, i) => `t${i}`);
    const p = new MockProvider({ name: 'gpu', overhead: 10, perText: 5, serialize: false });
    let chunks = 0;
    const res = await embedTextsPipelined([p], texts, {
      depth: 1,
      probeChunk: 10,
      targetChunkMs: 60,
      shouldCancel: () => chunks >= 2,
      onChunk: () => { chunks++; },
    });
    expect(res.cancelled).toBe(true);
    const got = res.vectors.filter(Boolean).length;
    expect(got).toBeGreaterThan(0);
    expect(got).toBeLessThan(texts.length);
    expect(res.skipped).toBe(texts.length - got);
    expect(p.calls).toBeLessThanOrEqual(3);
  });

  test('a slow provider does not take the last chunk (end-game rule)', async () => {
    const gpu = new MockProvider({ name: 'gpu', overhead: 20, perText: 3, serialize: false });
    const mac = new MockProvider({ name: 'mac', overhead: 20, perText: 60, serialize: true });
    const texts = Array.from({ length: 80 }, (_, i) => `t${i}`);
    const res = await embedTextsPipelined([gpu, mac], texts, { depth: 2, targetChunkMs: 200 });
    expect(res.failed).toBe(0);
    // Total wall should be close to the GPU host alone (~80*3+overheads ≈ 400ms),
    // never GPU + a trailing 1 s Mac chunk.
    expect(res.elapsedMs).toBeLessThan(900);
  });
});
