/**
 * Hybrid search end-to-end against build/ WITHOUT starting the HTTP server.
 *
 *   DEBUG=fantom-mcp node test/smoke/test-hybrid-search.mjs [projectId query ...]
 *
 * Hydrates the FlexSearch symbol index for the given projects from their
 * LadybugDB graph (.cache/graph/<id>.db), then runs the real
 * SemanticSearchService.search() (query instruction → vector → keyword → RRF →
 * rerank decision) and prints each hit with its `sources`. Defaults:
 *   265 "retejs"                      (keyword leg; 265 may have no vectors)
 *   242 "green button usage point interval reading"   (vector + keyword)
 * Uses the checkout's own .cache + config (never the production server).
 */
import fs from 'node:fs';
import path from 'node:path';

const CONFIG = path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');
// Sidecar entries in this checkout's config copy are only "fresh" while prod
// heartbeats land there — they don't. Touch lastSeen so the provider selector
// treats the embedding sidecars as usable for the ONE query embed per search.
try {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  for (const sc of cfg.sidecars ?? []) if (sc.capabilities?.embedding || sc.capabilities?.['embedding-code']) sc.lastSeen = new Date().toISOString();
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
} catch (e) { console.warn('could not touch sidecar lastSeen:', e.message); }

const { getPrismaClient } = await import('../../build/db/prisma.js');
const { getCodeIndexingService } = await import('../../build/fantom-code/codeIndexingService.js');
const { getFantomFunctionSearchIndex } = await import('../../build/fantom-code/searchIndex.js');
const { getSemanticSearchService } = await import('../../build/embedding/semanticSearchService.js');

const args = process.argv.slice(2);
const cases = [];
for (let i = 0; i + 1 < args.length; i += 2) cases.push({ projectId: Number(args[i]), query: args[i + 1] });
if (cases.length === 0) cases.push({ projectId: 265, query: 'retejs' }, { projectId: 242, query: 'green button usage point interval reading' });

const prisma = getPrismaClient();
const cis = getCodeIndexingService(prisma);
for (const pid of [...new Set(cases.map(c => c.projectId))]) {
  const p = await prisma.fantomProject.findUnique({ where: { id: pid } });
  if (!p) { console.log(`project ${pid} not in DB`); continue; }
  const rows = await cis.hydrateIndexerFromLadybug({ ...p, language: p.language || 'fantom', parserType: p.parserType });
  console.log(`hydrated project ${pid} ${p.name}: ${rows} rows into the symbol index`);
}
// Hydration fills the in-memory indexer; the server rebuilds the FlexSearch
// index from it after boot hydration (index.ts). Do the same here.
const { getFantomCodeIndexer } = await import('../../build/fantom-code/indexer.js');
const idx = getFantomFunctionSearchIndex();
idx.rebuild(getFantomCodeIndexer());
console.log(`symbol check: rete@265 → ${idx.search('rete', { limit: 3, projectId: 265 }).length}, retejs@265 → ${idx.search('retejs', { limit: 3, projectId: 265 }).length} (raw token never matches; hybrid uses variants)`);

const svc = getSemanticSearchService(prisma);
for (const c of cases) {
  console.log(`\n=== search("${c.query}", {projectId: ${c.projectId}, limit: 8})`);
  const t0 = Date.now();
  try {
    const hits = await svc.search(c.query, { projectId: c.projectId, limit: 8, includeGraphContext: false });
    console.log(`count=${hits.length} ms=${Date.now() - t0}`);
    for (const r of hits) {
      console.log(`  ${(r.score ?? r.combinedScore).toFixed(3)} ${JSON.stringify(r.sources)} ${r.qualifiedName} @ ${String(r.filePath).split('/').slice(-2).join('/')}:${r.lineStart}` +
        (r.keywordScore != null ? ` kw=${r.keywordScore.toFixed(1)}` : '') + (r.semanticScore ? ` sem=${r.semanticScore.toFixed(3)}` : ''));
    }
  } catch (e) {
    console.log(`search failed: ${e.message}`);
  }
}
process.exit(0);
