/**
 * Reference rows for the `stored-ref` gate: rows the live code table already
 * holds for a model, with the exact text that was embedded (the v4 `text`
 * column). The docs and axon tables keep no text, so both embedding roles
 * check against code rows when they use the same model; a model with no
 * stored rows yet is checked on width and pin only.
 */
import { getLanceTable } from '../embedding/lanceConnection.js';

export interface StoredRow { text: string; vector: Float32Array }

const cache = new Map<string, { at: number; rows: StoredRow[] }>();
const CACHE_MS = 10 * 60_000;

function esc(s: string): string { return s.replace(/'/g, "''"); }

export async function sampleStoredRows(model: string, n = 10): Promise<StoredRow[]> {
  const hit = cache.get(model);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
  let rows: StoredRow[] = [];
  try {
    const table = await getLanceTable();
    const raw = await table.query()
      .where(`model = '${esc(model)}' AND text IS NOT NULL AND text != ''`)
      .select(['text', 'vector'])
      .limit(n * 5)
      .toArray();
    // Spread the sample over what came back (one file's chunks look alike).
    const step = Math.max(1, Math.floor(raw.length / n));
    for (let i = 0; i < raw.length && rows.length < n; i += step) {
      const r = raw[i] as { text?: string; vector?: ArrayLike<number> };
      if (typeof r.text === 'string' && r.text.trim() && r.vector) {
        rows.push({ text: r.text, vector: Float32Array.from(r.vector as ArrayLike<number>) });
      }
    }
  } catch {
    rows = [];
  }
  cache.set(model, { at: Date.now(), rows });
  return rows;
}

export function __clearStoredSampleCache(): void { cache.clear(); }
