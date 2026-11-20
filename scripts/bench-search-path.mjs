#!/usr/bin/env node
/**
 * Reproduce the production vector search (vectorStore.searchSimilar) against
 * the LIVE code table, read-only, and time it under different LanceDB session
 * cache sizes and nprobes/ef/refine. Recall@10 vs <dir>/truth.json.
 *   node scripts/bench-search-path.mjs <indexCacheMB> [--grid]
 */
import { connect, Session } from '@lancedb/lancedb';
import * as fs from 'node:fs';
const cacheMb = Number(process.argv[2] || 1024);
const GRID = process.argv.includes('--grid');
const DIR = '.cache/bench';
const queries = JSON.parse(fs.readFileSync(`${DIR}/queries.json`, 'utf-8'));
const truth = JSON.parse(fs.readFileSync(`${DIR}/truth.json`, 'utf-8'));
const db = await connect('.cache/fantomvector.db', { session: new Session(BigInt(cacheMb) * 1048576n, 256n * 1048576n) });
const t = await db.openTable('code_vectors');
const cols = ['node_id', 'project_id', 'node_type', 'chunk_index', 'chunk_count', 'line_start', 'line_end', 'qualified_name', 'file_path'];
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))].toFixed(1); };
const grid = GRID
  ? [ { fetch: 200, refine: 2, ef: 400, nprobes: 96 }, { fetch: 200, refine: 1, ef: 200, nprobes: 96 }, { fetch: 200, refine: 1, ef: 250, nprobes: 96 },
      { fetch: 200, refine: 2, ef: 400, nprobes: 3 }, { fetch: 200, refine: 1, ef: 200, nprobes: 3 }, { fetch: 200, refine: 1, ef: 200, nprobes: 2 },
      { fetch: 100, refine: 1, ef: 100, nprobes: 96 }, { fetch: 100, refine: 2, ef: 200, nprobes: 96 } ]
  : [ { fetch: 200, refine: 2, ef: 400, nprobes: 96 } ];
const out = [];
for (const g of grid) {
  for (const f of truth.filters) {
    const exact = truth.byFilter[f.label];
    const ms = []; let r10 = 0;
    for (let k = 0; k < queries.length; k++) {
      let q = t.vectorSearch(queries[k].v).distanceType('cosine').select(cols).nprobes(g.nprobes).ef(g.ef).limit(g.fetch);
      if (g.refine > 1) q = q.refineFactor(g.refine);
      if (f.where) q = q.where(f.where);
      const s = performance.now(); const rows = await q.toArray(); ms.push(performance.now() - s);
      // production keeps each node's best chunk, then the top 10 nodes
      const seen = new Set(); const top = [];
      for (const r of rows) { if (seen.has(r.node_id)) continue; seen.add(r.node_id); top.push(`${r.node_id}#${r.chunk_index ?? 0}`); if (top.length === 10) break; }
      const tt = exact[k].slice(0, 10); const set = new Set(rows.slice(0, 40).map((r) => `${r.node_id}#${r.chunk_index ?? 0}`));
      r10 += tt.filter((x) => set.has(x)).length / Math.max(1, tt.length);
    }
    out.push({ cacheMb, ...g, filter: f.label.split(' ')[0], recall10in40: +(r10 / queries.length).toFixed(3), firstMs: +ms[0].toFixed(0), medianMs: pct(ms, 50), p95Ms: pct(ms, 95), rssMb: Math.round(process.memoryUsage().rss / 1048576) });
    console.log(JSON.stringify(out[out.length - 1]));
  }
}
