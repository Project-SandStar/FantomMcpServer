/**
 * `Fantom-OR-CodeEmbedding` / `Fantom-OR-Embedding`: embeddings straight from
 * OpenRouter through the worker pool.
 *
 * `getModelName()` is the catalogue id (`qwen/qwen3-embedding-8b`), the same
 * string the sidecar path stamped on every row, so stored vectors stay valid.
 * Bulk calls (index, re-embed) take a worker; a query embed takes the
 * interactive lane, so a search never waits behind a re-embed.
 */
import type { EmbeddingProvider } from '../embedding/providers/embeddingProvider.js';
import {
  verdictKey, isClearedToEmbed, getRefusal, ensureVerified, storedReference,
  type CompatCandidate, type VerificationRegime,
} from '../embedding/providers/vectorCompatibility.js';
import { embed } from './client.js';
import { openRouterPool, type Lane } from './workerPool.js';
import { getPoolSettings } from './settings.js';
import { cloudRoleModel, type CloudRoleModel } from './roles.js';
import { sampleStoredRows } from './storedSample.js';
import { workerName, tagWorkerSplit } from './workerAttribution.js';

export type EmbedRole = 'code-embedding' | 'embedding';

/** Largest batch per request; bigger input is split (and spread over workers). */
export const MAX_TEXTS_PER_REQUEST = 100;

export class DirectOpenRouterEmbeddingProvider implements EmbeddingProvider, CompatCandidate {
  readonly isVirtual = true;
  readonly providerName: string;
  readonly model: string;
  readonly upstreamProvider?: string;
  readonly role: EmbedRole;
  private readonly key: string;

  constructor(
    rm: CloudRoleModel & { role: EmbedRole },
    private readonly expectedDims: number,
    private readonly lane: Lane = 'bulk',
    private readonly regime: VerificationRegime = 'stored-ref',
  ) {
    this.role = rm.role;
    this.providerName = rm.providerName;
    this.model = rm.model;
    this.upstreamProvider = rm.pin;
    this.key = verdictKey({ providerName: this.providerName, model: this.model, upstreamProvider: this.upstreamProvider, reference: regime });
  }

  /** Same provider on the interactive lane (query path). */
  forQueries(): DirectOpenRouterEmbeddingProvider {
    return new DirectOpenRouterEmbeddingProvider(
      { role: this.role, providerName: this.providerName, model: this.model, pin: this.upstreamProvider },
      this.expectedDims, 'interactive', this.regime,
    );
  }

  getSidecarId(): string { return `or:fantom:${this.role}`; }
  getSidecarName(): string { return this.providerName; }
  getModelName(): string { return this.model; }
  getDimensions(): number { return this.expectedDims; }
  async initialize(): Promise<void> { /* stateless */ }
  verdictKey(): string { return this.key; }

  async embed(text: string): Promise<Float32Array> {
    const [v] = await this.embedBatch([text]);
    return v;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    if (!isClearedToEmbed(this.key)) {
      const r = getRefusal(this.key);
      throw new Error(
        `[vector-gate] ${this.providerName} is not cleared to embed`
        + (r ? ` (${r.kind}: ${r.reason})` : ` (has not passed the ${this.regime} check yet)`)
        + ` — refusing to write ${texts.length} vectors into the ${this.expectedDims}d table.`,
      );
    }
    return this.call(texts, this.lane);
  }

  /** The gate's own call: interactive lane, no clearance check. */
  async embedProbe(texts: string[]): Promise<{ vectors: Float32Array[]; dims: number }> {
    const vectors = await this.call(texts, 'interactive');
    return { vectors, dims: vectors[0]?.length ?? 0 };
  }

  private async call(texts: string[], lane: Lane): Promise<Float32Array[]> {
    const timeoutMs = getPoolSettings().requestTimeoutMs;
    const pool = openRouterPool();
    const parts: string[][] = [];
    for (let i = 0; i < texts.length; i += MAX_TEXTS_PER_REQUEST) parts.push(texts.slice(i, i + MAX_TEXTS_PER_REQUEST));
    const results = await Promise.all(parts.map(part => pool.submit({
      role: this.role,
      lane,
      run: async ({ worker }) => ({
        worker,
        vectors: (await embed(part, {
          role: this.role, model: this.model, pin: this.upstreamProvider ?? '', expectedDims: this.expectedDims, timeoutMs,
        })).vectors,
      }),
    })));
    const out = results.flatMap(r => r.vectors);
    // Bulk calls hold a pool slot: remember which slot served how many texts,
    // so attribution can say worker1 … workerN instead of one provider name.
    if (results.some(r => r.worker !== null)) {
      const split: Record<string, number> = {};
      for (const r of results) {
        const name = r.worker !== null ? workerName(r.worker) : this.providerName;
        split[name] = (split[name] ?? 0) + r.vectors.length;
      }
      tagWorkerSplit(out, split);
    }
    return out;
  }
}

/** Build and gate the provider for a role. Null with a reason when it cannot serve. */
export async function directEmbeddingProvider(
  role: EmbedRole,
  expectedDims: number,
): Promise<{ provider: DirectOpenRouterEmbeddingProvider | null; failure?: 'no-model' | 'width' | 'refused'; reason?: string }> {
  const rm = cloudRoleModel(role);
  if (!rm) return { provider: null, failure: 'no-model', reason: `no OpenRouter model is set for ${role}` };
  if (rm.dims && rm.dims !== expectedDims) {
    return { provider: null, failure: 'width', reason: `${rm.model} is ${rm.dims}d but the table is ${expectedDims}d` };
  }
  const p = new DirectOpenRouterEmbeddingProvider({ ...rm, role }, expectedDims);
  if (isClearedToEmbed(p.verdictKey())) return { provider: p };
  const rows = await sampleStoredRows(rm.model);
  const ok = await ensureVerified(p, rows.length > 0 ? storedReference(rows, `${rows.length} stored rows`) : null, expectedDims, 'stored-ref');
  if (!ok) {
    const r = getRefusal(p.verdictKey());
    return { provider: null, failure: 'refused', reason: r ? `${r.kind}: ${r.reason}` : 'refused by the vector gate' };
  }
  return { provider: p };
}
