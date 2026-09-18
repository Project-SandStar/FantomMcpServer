#!/usr/bin/env node
/**
 * Build the ANN index on the active code table, OUT OF PROCESS.
 *
 * Why a script and not the admin endpoint (which also exists):
 *
 * Training IVF_PQ over 212k x 2560 float32 is memory-hungry, and the server
 * runs with `--max-old-space-size=4096` behind a 4,000 MB RSS guard that kills
 * it on breach. Building in-process did exactly that — RSS 4,454 MB, killed
 * mid-train, no index — because the boot-time code hydration was still running
 * and the two together did not fit. The machine has 64 GB; the server's budget
 * is deliberately small and this job should not have to live inside it.
 *
 * Run it with the server stopped, or while it idles. LanceDB is a file format,
 * so a separate process opening the same directory is fine — but a concurrent
 * WRITER is not, so do not run this during a re-embed.
 *
 *   node --max-old-space-size=12288 scripts/build-vector-index.mjs [--force]
 *
 * Idempotent: reports and exits when an index already exists, unless --force.
 */

import { connect, Index } from '@lancedb/lancedb';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DB_DIR = path.join(process.cwd(), '.cache', 'fantomvector.db');
const POINTER = path.join(DB_DIR, '.active-code-table');
const FORCE = process.argv.includes('--force');

/** The slot the pointer names — never guessed, because indexing the inactive
 *  slot would spend minutes and leave every live query still scanning. */
function activeTableName() {
  try {
    const raw = fs.readFileSync(POINTER, 'utf-8').trim();
    if (raw === 'code_vectors' || raw === 'code_vectors_b') return raw;
    console.warn(`[index] pointer holds ${JSON.stringify(raw)}, which is not a slot name — defaulting to code_vectors`);
  } catch {
    console.warn('[index] no .active-code-table pointer — defaulting to code_vectors');
  }
  return 'code_vectors';
}

const name = activeTableName();
console.log(`[index] db=${DB_DIR}`);
console.log(`[index] active table = ${name}`);

const db = await connect(DB_DIR);
const table = await db.openTable(name);

const rows = await table.countRows();
const existing = await table.listIndices();
console.log(`[index] rows=${rows.toLocaleString()} existing=${existing.length ? existing.map(i => `${i.name}(${i.columns})`).join(', ') : 'none'}`);

if (existing.some(i => i.columns.includes('vector')) && !FORCE) {
  console.log('[index] a vector index already exists — pass --force to rebuild. Nothing to do.');
  process.exit(0);
}
if (rows < 5_000) {
  console.log(`[index] only ${rows} rows; a brute-force scan is cheaper than an index. Nothing to do.`);
  process.exit(0);
}

// sqrt(rows) is the usual partition heuristic; 2560 / 64 = 40 dims per
// sub-vector, which divides evenly (an uneven split is rejected outright).
const numPartitions = Math.max(1, Math.min(4096, Math.round(Math.sqrt(rows))));
const numSubVectors = 64;

console.log(`[index] building IVF_PQ: ${numPartitions} partitions x ${numSubVectors} sub-vectors, cosine…`);
console.log('[index] this trains on a sample of the table and takes minutes — leave it running.');

const t0 = Date.now();
const ticker = setInterval(() => {
  const mb = Math.round(process.memoryUsage().rss / 1048576);
  console.log(`[index]   … ${Math.round((Date.now() - t0) / 1000)}s elapsed, rss=${mb}MB`);
}, 30_000);

try {
  await table.createIndex('vector', {
    config: Index.ivfPq({ numPartitions, numSubVectors, distanceType: 'cosine' }),
    replace: true,
  });
  clearInterval(ticker);
  const after = await table.listIndices();
  console.log(`[index] DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`[index] indices now: ${after.map(i => `${i.name}(${i.columns})`).join(', ')}`);
} catch (err) {
  clearInterval(ticker);
  console.error(`[index] FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${err?.message ?? err}`);
  console.error('[index] the table is unchanged and still answers queries by scan.');
  process.exit(1);
}
