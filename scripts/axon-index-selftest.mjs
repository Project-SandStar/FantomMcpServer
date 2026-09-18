#!/usr/bin/env node
/**
 * Axon indexer self-test — no sidecar fleet, no prod server.
 *
 * Exercises: proj scan → parse → embedding text model v1 → mock provider →
 * LanceDB `axon_vectors` write → per-project meta → vector search → dims guard.
 *
 * Usage (after `npm run build`):
 *   MCPFANTOM_CACHE_DIR=/tmp/axon-selftest-cache node scripts/axon-index-selftest.mjs [projectId]
 *
 * MCPFANTOM_CACHE_DIR MUST point at a scratch dir so the test never touches the
 * real .cache/fantomvector.db. The script refuses to run without it.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

if (!process.env.MCPFANTOM_CACHE_DIR || !path.isAbsolute(process.env.MCPFANTOM_CACHE_DIR)) {
  console.error('Refusing to run: set MCPFANTOM_CACHE_DIR to an absolute scratch directory.');
  process.exit(2);
}

const { getAxonSettings, getAxonProjDir, resolveAxonEmbeddingModel } = await import('../build/axon/axonSettings.js');
const { scanAxonProj, parseAxonProject, buildAxonEmbeddingChunksFor, validateAxonProjectPath } = await import('../build/axon/axonProjParser.js');
const { AXON_EMBED_TEXT_VERSION } = await import('../build/axon/axonEmbeddingText.js');
const { runAxonIndex, readAxonMeta, getAxonProjectsStatus, listAxonProjectFunctions } = await import('../build/axon/axonIndexer.js');
const { axonVectorSearch } = await import('../build/axon/axonSearch.js');
const { getAxonTableStats } = await import('../build/axon/axonLance.js');

const { model, dimensions } = resolveAxonEmbeddingModel();
console.log(`code model: ${model} @ ${dimensions}d; embed text version ${AXON_EMBED_TEXT_VERSION}`);
console.log(`cache dir: ${process.env.MCPFANTOM_CACHE_DIR}`);

// ── Deterministic mock provider: bag-of-tokens hashed into `dimensions` buckets, L2-normalised.
function mockEmbed(text) {
  const v = new Float32Array(dimensions);
  for (const tok of text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1)) {
    const h = createHash('md5').update(tok).digest();
    const idx = h.readUInt32LE(0) % dimensions;
    v[idx] += 1;
  }
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}
const mockProvider = {
  calls: 0,
  async initialize() {},
  async embed(t) { this.calls++; return mockEmbed(t); },
  async embedBatch(ts) { this.calls++; return ts.map(mockEmbed); },
  getModelName() { return model; },
  getDimensions() { return dimensions; },
};

// ── 1. validate + scan
const settings = getAxonSettings();
const v = validateAxonProjectPath(settings.projectPath);
console.log(`\n[validate] path=${v.projectPath} exists=${v.exists} packageJson=${v.packageJson} serverEntry=${v.serverEntry} instances=${v.instances.length} projects=${v.projects.length} functions=${v.totalFunctions} problems=${JSON.stringify(v.problems)}`);
if (!v.projExists) process.exit(1);

// ── 2. parse everything (no writes) — count, and check invariants
const projDir = getAxonProjDir(settings);
const scan = scanAxonProj(projDir);
let total = 0, withBody = 0, withDoc = 0, withSig = 0, chunks = 0, multi = 0, maxLen = 0, withReturn = 0, withDefaults = 0, withCalledBy = 0;
const t0 = Date.now();
for (const ref of scan.projects) {
  const recs = parseAxonProject(projDir, ref);
  for (const r of recs) {
    total++;
    if (r.body) withBody++;
    if (r.doc) withDoc++;
    if (r.params.length) withSig++;
    if (r.returnType) withReturn++;
    if (r.paramDefs.some(p => p.default !== undefined)) withDefaults++;
    if (r.calledBy.length) withCalledBy++;
    const cs = buildAxonEmbeddingChunksFor(r);
    chunks += cs.length; if (cs.length > 1) multi++;
    for (const c of cs) { if (c.text.length > 4000) throw new Error(`chunk over cap: ${r.qualifiedName}`); maxLen = Math.max(maxLen, c.text.length); }
    if (!r.body && !r.doc) throw new Error(`empty record: ${r.qualifiedName}`);
  }
}
console.log(`[parse] ${scan.projects.length} projects, ${total} functions in ${Date.now() - t0}ms — body=${withBody} doc=${withDoc} params=${withSig} returnType=${withReturn} defaults=${withDefaults} calledBy=${withCalledBy}; chunks=${chunks} (multi-chunk fns=${multi}) maxChunkChars=${maxLen}`);

// ── 3. sample embedding texts (structure only — function names, no customer data beyond names)
const samples = [['<instance>/<project>', 'ahuCoolAndHeatExample'], ['<instance>/<project>', 'kpiKwhDeltaPrevYear'], ['<instance>/<project2>', 'ahuBadOAT']];
for (const [pid, name] of samples) {
  const ref = scan.projects.find(p => p.projectId === pid);
  if (!ref) continue;
  const rec = parseAxonProject(projDir, ref).find(r => r.name === name);
  if (!rec) continue;
  const cs = buildAxonEmbeddingChunksFor(rec);
  console.log(`\n───── sample text ${rec.qualifiedName} (chunks=${cs.length}, lines ${rec.lineStart}-${rec.lineEnd}) ─────`);
  console.log(cs[0].text.split('\n').slice(0, 18).join('\n'));
  if (cs[0].text.split('\n').length > 18) console.log('…');
}

// ── 4. index one small project with the mock provider
const targetId = process.argv[2] || '<instance>/<project>';
const job = { id: 'selftest', kind: 'axon-index', scope: { projectId: targetId, force: true }, status: 'queued', startedAt: new Date().toISOString(), projectsTotal: 0, projectsDone: 0, functionsTotal: 0, functionsEmbedded: 0, model, dimensions, providers: [], errors: [] };
await runAxonIndex(job, { projectId: targetId, force: true, providers: [mockProvider], batchSize: 8 });
console.log(`\n[index] job status=${job.status} projectsDone=${job.projectsDone}/${job.projectsTotal} functionsEmbedded=${job.functionsEmbedded} providerCalls=${mockProvider.calls} errors=${JSON.stringify(job.errors)}`);
if (job.status !== 'done') process.exit(1);

const meta = readAxonMeta();
const pm = meta.projects[targetId];
console.log(`[meta] ${path.join(process.env.MCPFANTOM_CACHE_DIR, 'axon-embedding-meta.json')} → functionsFound=${pm.functionsFound} vectorsWritten=${pm.vectorsWritten} rowsWritten=${pm.rowsWritten} model=${pm.model} dims=${pm.dimensions} embedTextVersion=${pm.embedTextVersion}`);

const stats = await getAxonTableStats();
console.log(`[table] exists=${stats.exists} rows=${stats.rows} tableDims=${stats.tableDimensions} tableModel=${stats.tableModel} schemaCurrent=${stats.schemaCurrent} dimsMismatch=${stats.dimsMismatch}`);

const st = await getAxonProjectsStatus();
const ps = st.projects.find(p => p.projectId === targetId);
console.log(`[status] ${targetId}: functions=${ps.functionsFound} vectors=${ps.vectors} rows=${ps.rows} embedded=${ps.embeddedPercent}% stale=${ps.embedTextStale}; totals=${JSON.stringify(st.totals)}`);

const fl = await listAxonProjectFunctions(targetId, { page: 1, pageSize: 5 });
console.log(`[functions] total=${fl.total} embedded=${fl.embedded} first=${fl.functions.map(f => `${f.name}${f.embedded ? '✓' : '✗'}`).join(', ')}`);

// ── 5. search with the same mock provider
for (const q of ['cooling and heating periods intersection', 'kwh delta previous year baseline']) {
  const { results } = await axonVectorSearch(q, { projectId: targetId, limit: 5, provider: mockProvider, minScore: 0 });
  console.log(`[search] "${q}" → ${results.map(r => `${r.name}(${(r.combinedScore * 100).toFixed(0)}%)`).join(', ')}`);
  if (results.length === 0) throw new Error('search returned nothing');
  if (!results[0].signature) throw new Error('signature column missing in results');
}

// ── 6. dims guard: a provider returning the wrong size must fail the project, not corrupt the table
const badProvider = { ...mockProvider, async embedBatch(ts) { return ts.map(() => new Float32Array(8)); } };
const job2 = { ...job, id: 'selftest-bad', status: 'queued', errors: [], projectsDone: 0, functionsEmbedded: 0 };
await runAxonIndex(job2, { projectId: targetId, force: false, providers: [badProvider], batchSize: 8 });
const stats2 = await getAxonTableStats();
console.log(`[dims-guard] job status=${job2.status} error="${job2.errors[0]?.message?.slice(0, 90)}" rowsAfter=${stats2.rows} (unchanged=${stats2.rows === stats.rows})`);
if (stats2.rows !== stats.rows) throw new Error('dims guard failed: table changed');

console.log('\nSELFTEST OK');
process.exit(0);
