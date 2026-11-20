#!/usr/bin/env node
/**
 * Benchmark the code-vector index on a COPY of the live table.
 *
 *   node scripts/bench-vector-index.mjs --phase copy|truth|pq|hnsw-build|hnsw [--dir <bench dir>]
 *
 * Inputs: <dir>/queries.json  = [{ q, v: number[] }] (query vectors, made by
 * Fantom's own embed client). The copy lives in <dir>/db/code_vectors.lance.
 * Ground truth = exact cosine search (bypassVectorIndex). Recall@k = share of
 * the exact top-k (node_id#chunk_index) found in the ANN top-k.
 * Every phase writes <dir>/<phase>.json and prints one JSON line at the end.
 * Run it in its own container so a memory spike cannot hit the server.
 */
import { connect, Index } from '@lancedb/lancedb';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const PHASE = arg('--phase');
const DIR = arg('--dir', path.join(process.cwd(), '.cache', 'bench'));
const SRC = arg('--src', path.join(process.cwd(), '.cache', 'fantomvector.db', 'code_vectors.lance'));
const DB = path.join(DIR, 'db');
const TABLE = 'code_vectors';
const LIMIT = 40; // production fetches limit*4 rows, then groups by node
const log = (m) => console.log(`[bench] ${m}`);

let peakRss = 0;
const t0 = Date.now();
const ticker = setInterval(() => {
  const rss = process.memoryUsage().rss; peakRss = Math.max(peakRss, rss);
  log(`… ${Math.round((Date.now() - t0) / 1000)}s rss=${Math.round(rss / 1048576)}MB`);
}, 30_000);
const sampleRss = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss); };

const keyOf = (r) => `${r.node_id}#${r.chunk_index ?? 0}`;
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const median = (xs) => pct(xs, 50);
const save = (name, obj) => { fs.writeFileSync(path.join(DIR, `${name}.json`), JSON.stringify(obj, null, 1)); };
const load = (name) => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf-8'));

async function openTable() {
  const db = await connect(DB);
  return db.openTable(TABLE);
}

/** The filters measured: none (all projects), a big project, a small one. */
function filtersFrom(truth) { return truth.filters; }

async function runSearch(table, v, { where, nprobes, refine, ef, exact }) {
  let q = table.vectorSearch(v).distanceType('cosine').select(['node_id', 'chunk_index']).limit(LIMIT);
  if (where) q = q.where(where);
  if (exact) q = q.bypassVectorIndex();
  if (nprobes) q = q.nprobes(nprobes);
  if (refine) q = q.refineFactor(refine);
  if (ef) q = q.ef(ef);
  return q.toArray();
}

async function measure(table, queries, truth, cfg) {
  const out = {};
  for (const f of filtersFrom(truth)) {
    const exact = truth.byFilter[f.label];
    // Warm-up pass (page cache, index load), then a timed pass.
    for (const qq of queries.slice(0, 5)) await runSearch(table, qq.v, { ...cfg, where: f.where });
    const ms = []; let r10 = 0; let r40 = 0; let empty = 0;
    for (let i = 0; i < queries.length; i++) {
      const s = performance.now();
      const rows = await runSearch(table, queries[i].v, { ...cfg, where: f.where });
      ms.push(performance.now() - s);
      sampleRss();
      const got = rows.map(keyOf);
      if (got.length === 0) empty++;
      const t = exact[i];
      const g10 = new Set(got.slice(0, 10)); const g40 = new Set(got);
      r10 += t.slice(0, 10).filter((k) => g10.has(k)).length / Math.max(1, Math.min(10, t.length));
      r40 += t.filter((k) => g40.has(k)).length / Math.max(1, t.length);
    }
    out[f.label] = {
      recall10: +(r10 / queries.length).toFixed(4),
      recall40: +(r40 / queries.length).toFixed(4),
      medianMs: +median(ms).toFixed(1),
      p95Ms: +pct(ms, 95).toFixed(1),
      empty,
    };
  }
  return out;
}

const report = { phase: PHASE, ms: 0 };
try {
  if (PHASE === 'copy') {
    fs.rmSync(DB, { recursive: true, force: true });
    fs.mkdirSync(DB, { recursive: true });
    execFileSync('cp', ['-a', SRC, path.join(DB, `${TABLE}.lance`)]);
    const table = await openTable();
    report.rows = await table.countRows();
    report.indices = (await table.listIndices()).map((i) => `${i.name}:${i.indexType}`);
  } else if (PHASE === 'truth') {
    const queries = JSON.parse(fs.readFileSync(path.join(DIR, 'queries.json'), 'utf-8'));
    const table = await openTable();
    // Pick a big and a small project for the filtered runs.
    const counts = new Map();
    for await (const batch of table.query().select(['project_id'])) {
      const col = batch.getChild('project_id');
      for (let i = 0; i < batch.numRows; i++) { const p = Number(col.get(i)); counts.set(p, (counts.get(p) ?? 0) + 1); }
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const big = counts.has(11) ? [11, counts.get(11)] : sorted[0];
    const small = sorted.find(([, n]) => n >= 2_000 && n <= 8_000) ?? sorted[Math.floor(sorted.length / 2)];
    const filters = [
      { label: 'all', where: undefined },
      { label: `p${big[0]} (${big[1]} rows)`, where: `project_id = ${big[0]}` },
      { label: `p${small[0]} (${small[1]} rows)`, where: `project_id = ${small[0]}` },
    ];
    const byFilter = {}; const exactMs = {};
    for (const f of filters) {
      byFilter[f.label] = []; const ms = [];
      for (const qq of queries) {
        const s = performance.now();
        const rows = await runSearch(table, qq.v, { where: f.where, exact: true });
        ms.push(performance.now() - s);
        byFilter[f.label].push(rows.map(keyOf));
      }
      exactMs[f.label] = { medianMs: +median(ms).toFixed(1), p95Ms: +pct(ms, 95).toFixed(1) };
      log(`truth ${f.label}: exact median ${exactMs[f.label].medianMs} ms`);
    }
    save('truth', { filters, byFilter, exactMs, projects: counts.size });
    report.exactMs = exactMs; report.filters = filters.map((f) => f.label);
  } else if (PHASE === 'pq' || PHASE === 'hnsw') {
    const queries = JSON.parse(fs.readFileSync(path.join(DIR, 'queries.json'), 'utf-8'));
    const truth = load('truth');
    const table = await openTable();
    report.indices = (await table.listIndices()).map((i) => `${i.name}:${i.indexType}`);
    const grid = [];
    if (PHASE === 'pq') {
      grid.push({ name: 'current unfiltered (default nprobes, refine 2)', refine: 2 });
      for (const nprobes of [20, 50, 96]) for (const refine of [1, 5, 10]) grid.push({ name: `nprobes ${nprobes} refine ${refine}`, nprobes, refine });
      grid.push({ name: 'current filtered (nprobes 96, refine 2)', nprobes: 96, refine: 2 });
    } else {
      const parts = Number(arg('--parts', '0')) || undefined;
      const probeSet = parts ? [...new Set([1, 2, 4, 8].filter((n) => n <= parts))] : [undefined];
      // ef must be >= k; with refine the index fetches limit*refine rows.
      for (const nprobes of probeSet) for (const ef of [50, 100, 200, 400]) {
        grid.push({ name: `nprobes ${nprobes ?? 'def'} ef ${ef}`, nprobes, ef });
        if (ef >= LIMIT * 2) grid.push({ name: `nprobes ${nprobes ?? 'def'} ef ${ef} refine 2`, nprobes, ef, refine: 2 });
      }
    }
    const results = [];
    for (const cfg of grid) {
      const r = await measure(table, queries, truth, cfg);
      results.push({ ...cfg, ...r });
      log(`${cfg.name}: ${JSON.stringify(r)}`);
      save(PHASE, results); // after each setting: a restart loses at most one
    }
    save(PHASE, results);
    report.results = results.length;
  } else if (PHASE === 'hnsw-build') {
    const table = await openTable();
    const rows = await table.countRows();
    const numPartitions = Number(arg('--parts', '0')) || Math.max(1, Math.round(rows / 100_000));
    const m = Number(arg('--m', '20'));
    const efConstruction = Number(arg('--efc', '300'));
    log(`IVF_HNSW_SQ ${numPartitions} partitions m=${m} efConstruction=${efConstruction} on ${rows} rows`);
    const s = Date.now();
    await table.createIndex('vector', {
      config: Index.hnswSq({ distanceType: 'cosine', numPartitions, m, efConstruction, sampleRate: 256, maxIterations: 25 }),
      replace: true,
    });
    report.buildMs = Date.now() - s;
    report.numPartitions = numPartitions; report.m = m; report.efConstruction = efConstruction;
    report.indices = (await table.listIndices()).map((i) => `${i.name}:${i.indexType}`);
  } else {
    console.error('need --phase copy|truth|pq|hnsw-build|hnsw');
    process.exit(2);
  }
  sampleRss();
  report.ms = Date.now() - t0;
  report.peakRssMb = Math.round(peakRss / 1048576);
  if (PHASE === 'hnsw-build' || PHASE === 'copy') save(PHASE, report);
  console.log(JSON.stringify(report));
} catch (e) {
  console.error(`[bench] failed: ${e?.stack ?? e}`);
  process.exitCode = 1;
} finally {
  clearInterval(ticker);
}
