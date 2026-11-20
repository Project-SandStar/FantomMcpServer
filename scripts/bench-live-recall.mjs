#!/usr/bin/env node
/**
 * Live recall check: run the production search settings against the LIVE
 * code table (read-only) and score them against the benchmark ground truth
 * (<dir>/truth.json, exact search on a copy). Run in its own container.
 *   node scripts/bench-live-recall.mjs [--dir .cache/bench]
 */
import { connect } from '@lancedb/lancedb';
import * as fs from 'node:fs';
import * as path from 'node:path';
const i = process.argv.indexOf('--dir');
const DIR = i > 0 ? process.argv[i + 1] : path.join(process.cwd(), '.cache', 'bench');
const LIVE = path.join(process.cwd(), '.cache', 'fantomvector.db');
const queries = JSON.parse(fs.readFileSync(path.join(DIR, 'queries.json'), 'utf-8'));
const truth = JSON.parse(fs.readFileSync(path.join(DIR, 'truth.json'), 'utf-8'));
const db = await connect(LIVE);
const table = await db.openTable('code_vectors');
const idx = (await table.listIndices()).find((x) => x.columns.includes('vector'));
const LIMIT = 40; const REFINE = 2;
const out = { vectorIndex: idx?.indexType, filters: {} };
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
for (const f of truth.filters) {
  const exact = truth.byFilter[f.label]; const ms = []; let r10 = 0;
  for (let k = 0; k < queries.length; k++) {
    let q = table.vectorSearch(queries[k].v).distanceType('cosine').select(['node_id', 'chunk_index'])
      .refineFactor(REFINE).nprobes(96).ef(Math.max(100, LIMIT * REFINE)).limit(LIMIT);
    if (f.where) q = q.where(f.where);
    const s = performance.now(); const rows = await q.toArray(); ms.push(performance.now() - s);
    const got = new Set(rows.slice(0, 10).map((r) => `${r.node_id}#${r.chunk_index ?? 0}`));
    const t = exact[k].slice(0, 10); r10 += t.filter((x) => got.has(x)).length / Math.max(1, t.length);
  }
  out.filters[f.label] = { recall10: +(r10 / queries.length).toFixed(3), medianMs: +pct(ms, 50).toFixed(1), p95Ms: +pct(ms, 95).toFixed(1) };
}
console.log(JSON.stringify(out));
