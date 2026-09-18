#!/usr/bin/env node
/**
 * Offline Axon library parse report (no embedding, no LanceDB): per-folder
 * function counts, files that yielded no record, and one sample rendered
 * embedding text (function name only — no customer data is printed beyond it).
 *
 * Usage (after `npm run build`): node scripts/axon-library-report.mjs [sampleFunctionName]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const { getAxonLibraryDir } = await import('../build/axon/axonSettings.js');
const { scanAxonLibrary, parseAxonLibraryProject, validateAxonLibraryPath } = await import('../build/axon/axonLibraryParser.js');
const { buildAxonEmbeddingChunksFor } = await import('../build/axon/axonProjParser.js');

const libDir = getAxonLibraryDir();
const v = validateAxonLibraryPath(libDir);
console.log(`[validate] exists=${v.exists} folders=${v.folders.length} functions=${v.totalFunctions} problems=${JSON.stringify(v.problems)}`);
const scan = scanAxonLibrary(libDir);

let total = 0, withDoc = 0, withParams = 0, multi = 0, maxChars = 0, fromTrio = 0, noBody = 0;
const skipped = [];
const rows = [];
const t0 = Date.now();
for (const ref of scan.projects) {
  const recs = parseAxonLibraryProject(libDir, ref);
  // Count .axon files that produced no record.
  const axonFiles = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name.startsWith('.')) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.axon')) axonFiles.push(p); } })(ref.dir);
  const names = new Set(recs.map(r => r.name));
  for (const f of axonFiles) { const n = path.basename(f, '.axon').replace(/[^A-Za-z0-9_]/g, '_'); if (!names.has(n)) skipped.push(path.relative(libDir, f)); }
  for (const r of recs) {
    total++;
    if (r.doc) withDoc++;
    if (r.params.length) withParams++;
    if (r.trioPath) fromTrio++;
    if (!r.body) noBody++;
    const cs = buildAxonEmbeddingChunksFor(r);
    if (cs.length > 1) multi++;
    for (const c of cs) { if (c.text.length > 4000) throw new Error('chunk over cap ' + r.qualifiedName); maxChars = Math.max(maxChars, c.text.length); }
  }
  rows.push(`${ref.project.padEnd(20)} scan=${String(ref.functionCount).padStart(4)} parsed=${String(recs.length).padStart(4)} trio=${recs.filter(r => r.trioPath).length}`);
}
console.log(rows.join('\n'));
console.log(`[parse] folders=${scan.projects.length} functions=${total} (fromTrio=${fromTrio}) doc=${withDoc} params=${withParams} noBody=${noBody} multiChunk=${multi} maxChunkChars=${maxChars} in ${Date.now() - t0}ms`);
console.log(`[unparsed .axon files] ${skipped.length}${skipped.length ? ': ' + skipped.slice(0, 8).join(', ') : ''}`);

const want = process.argv[2] || 'toAhuHeatStage';
for (const ref of scan.projects) {
  const rec = parseAxonLibraryProject(libDir, ref).find(r => r.name === want);
  if (!rec) continue;
  const cs = buildAxonEmbeddingChunksFor(rec);
  console.log(`\n───── sample ${rec.qualifiedName} (source=${rec.source}, chunks=${cs.length}, lines ${rec.lineStart}-${rec.lineEnd}) ─────`);
  console.log(cs[0].text.split('\n').slice(0, 14).join('\n'));
  break;
}
