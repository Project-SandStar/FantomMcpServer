/**
 * Embedding cache (lazy-incremental-indexing.md 3.5, D6): LanceDB table
 * `embed_cache` keyed by (model, text_version, text_hash), holding the
 * vector a provider returned for that exact text.
 *
 * - Point lookups only (`key IN [...]`, chunks of 200). Never scanned into
 *   memory; search never reads it.
 * - Writes go through the per-table write queue (vectorWriteQueue.ts).
 * - The vector is stored as raw float32 bytes (Binary), so one table holds
 *   any dimension and a model switch needs no schema change.
 * - `embed.cache.enabled = false` in the runtime config turns lookups and
 *   writes off; the table stays. A cache failure never fails an embed: the
 *   caller falls back to the provider.
 *
 * Pruning (`cache-prune` task, `embed.cache.maxMb`) is a later phase.
 */

import { createHash } from 'crypto';
import type { Connection, Table } from '@lancedb/lancedb';
import { createLogger } from '../utils/index.js';
import { EMBED_TEXT_VERSION } from './embeddingText.js';
import { enqueueWrite } from './vectorWriteQueue.js';
import { readConfigFileWithRecovery } from '../config/index.js';
import { runtimeConfigPath } from '../indexing/lazyConfig.js';

const logger = createLogger('embed-cache');

export const EMBED_CACHE_TABLE = 'embed_cache';
const LOOKUP_CHUNK = 200;

export function textHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function cacheKey(model: string, textVersion: number, hash: string): string {
  return createHash('sha256').update(`${model}\u001f${textVersion}\u001f${hash}`).digest('hex');
}

function toBytes(v: Float32Array | number[]): Buffer {
  const f = v instanceof Float32Array ? v : Float32Array.from(v);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

function fromBytes(b: Uint8Array): Float32Array {
  // Copy: the arrow buffer may not be 4-byte aligned.
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

export interface EmbedCacheStats { hits: number; misses: number; writes: number }

export class EmbedCache {
  private table: Table | null = null;
  private opening: Promise<Table | null> | null = null;
  readonly stats: EmbedCacheStats = { hits: 0, misses: 0, writes: 0 };

  constructor(
    private readonly connect: () => Promise<Connection>,
    private readonly enabled: () => boolean = () => true,
  ) {}

  isEnabled(): boolean { return this.enabled(); }

  /** Open the table; with `create` false a missing table is null. */
  private async open(create: boolean): Promise<Table | null> {
    if (this.table) return this.table;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const conn = await this.connect();
      const names = await conn.tableNames();
      if (names.includes(EMBED_CACHE_TABLE)) {
        this.table = await conn.openTable(EMBED_CACHE_TABLE);
      } else if (create) {
        const now = new Date().toISOString();
        const t = await conn.createTable(EMBED_CACHE_TABLE, [{
          key: '__init__', model: '__init__', text_version: 0, text_hash: '__init__',
          vec: Buffer.alloc(4), dims: 1, bytes: 4, created_at: now, last_used_at: now,
        }]);
        await t.delete(`key = '__init__'`);
        this.table = t;
      }
      return this.table;
    })().finally(() => { this.opening = null; });
    return this.opening;
  }

  /** Vectors for the given text hashes that are in the cache (hash → vector). */
  async lookup(model: string, textVersion: number, hashes: string[]): Promise<Map<string, Float32Array>> {
    const out = new Map<string, Float32Array>();
    if (!this.enabled() || hashes.length === 0) return out;
    const table = await this.open(false);
    if (!table) { this.stats.misses += hashes.length; return out; }
    const byKey = new Map<string, string>();
    for (const h of hashes) byKey.set(cacheKey(model, textVersion, h), h);
    const keys = [...byKey.keys()];
    for (let i = 0; i < keys.length; i += LOOKUP_CHUNK) {
      const chunk = keys.slice(i, i + LOOKUP_CHUNK);
      const rows = await table.query()
        .where(`key IN (${chunk.map(k => `'${k}'`).join(',')})`)
        .select(['key', 'vec'])
        .toArray();
      for (const r of rows as Array<{ key: string; vec: Uint8Array }>) {
        const h = byKey.get(r.key);
        if (h) out.set(h, fromBytes(r.vec));
      }
    }
    this.stats.hits += out.size;
    this.stats.misses += new Set(hashes).size - out.size;
    if (out.size > 0) this.touch([...byKey.entries()].filter(([, h]) => out.has(h)).map(([k]) => k));
    return out;
  }

  /** Mark hit keys as used now (LRU order for prune). Best effort, queued. */
  private touch(keys: string[]): void {
    const table = this.table;
    if (!table || keys.length === 0) return;
    const now = new Date().toISOString();
    void enqueueWrite(`lance:${EMBED_CACHE_TABLE}`, async () => {
      for (let i = 0; i < keys.length; i += LOOKUP_CHUNK) {
        const chunk = keys.slice(i, i + LOOKUP_CHUNK);
        await table.update({ where: `key IN (${chunk.map(k => `'${k}'`).join(',')})`, values: { last_used_at: now } });
      }
    }).catch(err => logger.warn(`[embed-cache] touch failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** Total vector bytes and row count in the cache. */
  async size(): Promise<{ rows: number; bytes: number }> {
    const table = await this.open(false);
    if (!table) return { rows: 0, bytes: 0 };
    const rows = await table.query().select(['bytes']).toArray() as Array<{ bytes: number }>;
    return { rows: rows.length, bytes: rows.reduce((a, r) => a + Number(r.bytes ?? 0), 0) };
  }

  /**
   * The `cache-prune` task (3.5): delete least-recently-used rows until the
   * vector bytes are at or under `maxBytes`. The caller checks the heavy job.
   */
  async prune(maxBytes: number): Promise<{ rowsBefore: number; bytesBefore: number; rowsDeleted: number; bytesAfter: number }> {
    const table = await this.open(false);
    if (!table) return { rowsBefore: 0, bytesBefore: 0, rowsDeleted: 0, bytesAfter: 0 };
    return enqueueWrite(`lance:${EMBED_CACHE_TABLE}`, async () => {
      const rows = (await table.query().select(['key', 'bytes', 'last_used_at']).toArray() as Array<{ key: string; bytes: number; last_used_at: string }>)
        .map(r => ({ key: r.key, bytes: Number(r.bytes ?? 0), at: String(r.last_used_at ?? '') }));
      const bytesBefore = rows.reduce((a, r) => a + r.bytes, 0);
      let bytes = bytesBefore;
      const drop: string[] = [];
      if (bytes > maxBytes) {
        rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
        for (const r of rows) {
          if (bytes <= maxBytes) break;
          drop.push(r.key);
          bytes -= r.bytes;
        }
        for (let i = 0; i < drop.length; i += LOOKUP_CHUNK) {
          await table.delete(`key IN (${drop.slice(i, i + LOOKUP_CHUNK).map(k => `'${k}'`).join(',')})`);
        }
      }
      if (drop.length) logger.info(`[embed-cache] prune: ${drop.length}/${rows.length} rows deleted, ${Math.round(bytesBefore / 1048576)} → ${Math.round(bytes / 1048576)} MB`);
      return { rowsBefore: rows.length, bytesBefore, rowsDeleted: drop.length, bytesAfter: bytes };
    });
  }

  /** Store vectors by text hash; keys already present are skipped. */
  async store(model: string, textVersion: number, entries: Array<{ hash: string; vector: Float32Array | number[] }>): Promise<number> {
    if (!this.enabled() || entries.length === 0) return 0;
    const table = await this.open(true);
    if (!table) return 0;
    const unique = new Map<string, { hash: string; vector: Float32Array | number[] }>();
    for (const e of entries) unique.set(cacheKey(model, textVersion, e.hash), e);
    return enqueueWrite(`lance:${EMBED_CACHE_TABLE}`, async () => {
      const keys = [...unique.keys()];
      const present = new Set<string>();
      for (let i = 0; i < keys.length; i += LOOKUP_CHUNK) {
        const chunk = keys.slice(i, i + LOOKUP_CHUNK);
        const rows = await table.query().where(`key IN (${chunk.map(k => `'${k}'`).join(',')})`).select(['key']).toArray();
        for (const r of rows as Array<{ key: string }>) present.add(r.key);
      }
      const now = new Date().toISOString();
      const rows = keys.filter(k => !present.has(k)).map(k => {
        const e = unique.get(k)!;
        const vec = toBytes(e.vector);
        return {
          key: k, model, text_version: textVersion, text_hash: e.hash,
          vec, dims: vec.byteLength / 4, bytes: vec.byteLength, created_at: now, last_used_at: now,
        };
      });
      if (rows.length > 0) await table.add(rows);
      this.stats.writes += rows.length;
      return rows.length;
    });
  }

  /**
   * Embed `texts` through the cache: hits come from the table, only misses
   * reach `embedMisses` (the provider), and its vectors are written back.
   * Order of the result matches `texts`.
   */
  async embedThrough(
    model: string,
    texts: string[],
    embedMisses: (texts: string[]) => Promise<Float32Array[]>,
    textVersion: number = EMBED_TEXT_VERSION,
  ): Promise<{ vectors: Float32Array[]; hits: number; misses: number }> {
    const hashes = texts.map(textHash);
    let cached = new Map<string, Float32Array>();
    try {
      cached = await this.lookup(model, textVersion, hashes);
    } catch (err) {
      logger.warn(`[embed-cache] lookup failed, embedding all ${texts.length}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const missIdx: number[] = [];
    const missTexts: string[] = [];
    const firstOf = new Map<string, number>();
    hashes.forEach((h, i) => {
      if (cached.has(h) || firstOf.has(h)) return;
      firstOf.set(h, missIdx.length);
      missIdx.push(i);
      missTexts.push(texts[i]);
    });
    const fresh = missTexts.length > 0 ? await embedMisses(missTexts) : [];
    const vectors = hashes.map(h => cached.get(h) ?? fresh[firstOf.get(h)!]);
    if (fresh.length > 0) {
      try {
        await this.store(model, textVersion, missIdx.map((i, k) => ({ hash: hashes[i], vector: fresh[k] })));
      } catch (err) {
        logger.warn(`[embed-cache] write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { vectors, hits: texts.length - missTexts.length, misses: missTexts.length };
  }
}

let shared: EmbedCache | null = null;
let enabledAt = 0;
let enabledValue = true;

/** `embed.cache.enabled` in the runtime config (default on), re-read every 30 s. */
function readEnabled(): boolean {
  const now = Date.now();
  if (now - enabledAt < 30_000) return enabledValue;
  enabledAt = now;
  try {
    enabledValue = readConfigFileWithRecovery(runtimeConfigPath())?.embed?.cache?.enabled !== false;
  } catch { enabledValue = true; }
  return enabledValue;
}

/** Process-wide cache on the code LanceDB connection. */
export function getEmbedCache(): EmbedCache {
  if (!shared) {
    shared = new EmbedCache(async () => {
      const { getLanceConnection } = await import('./lanceConnection.js');
      return getLanceConnection();
    }, readEnabled);
  }
  return shared;
}

/** Test seam. */
export function __setEmbedCacheForTest(c: EmbedCache | null): void { shared = c; }

let bootFreeBytes: number | null = null;

/**
 * Cache cap (3.5): `maxMb` when > 0, else min(2 048 MB, 10 % of the free
 * disk measured once at boot). `freeBytes` is a test seam.
 */
export async function embedCacheCapBytes(maxMb = 0, freeBytes?: number): Promise<number> {
  if (maxMb > 0) return Math.floor(maxMb * 1048576);
  let free = freeBytes ?? bootFreeBytes;
  if (free == null) {
    try {
      const fs = await import('fs');
      const { getCacheDir } = await import('../utils/installRoot.js');
      const st = await fs.promises.statfs(getCacheDir());
      free = Number(st.bavail) * Number(st.bsize);
    } catch {
      free = 20 * 1024 * 1048576; // unknown: 10 % of 20 GB = 2 GB
    }
    if (freeBytes == null) bootFreeBytes = free;
  }
  return Math.min(2048 * 1048576, Math.floor(free * 0.1));
}
