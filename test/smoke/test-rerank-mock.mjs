/**
 * Rerank wiring check against build/ with a MOCKED reranker sidecar.
 *
 *   node test/smoke/test-rerank-mock.mjs
 *
 * 1. Starts a local HTTP stub that answers POST /v1/rerank (Cohere-style
 *    {results:[{index, relevance_score}]}) by scoring documents in REVERSE
 *    order, so a successful rerank visibly flips the candidate order.
 * 2. Calls crossEncoderRerank() with a fake Sidecar (capability `reranker`)
 *    pointing at the stub — exercises the same client the server uses.
 * 3. Repeats with a stub that stalls 10 s and timeoutMs=500 → the fused order
 *    must come back unchanged within ~0.5 s (fallback path).
 * 4. Reports what rerankerSidecarUsable() sees in the real registry (auto mode)
 *    and that isSidecarUsable() accepts a fresh reranker entry.
 */
import http from 'node:http';
import { crossEncoderRerank } from '../../build/embedding/crossEncoderReranker.js';
import { rerankerSidecarUsable, rrfFuse, countChangedPositions } from '../../build/embedding/hybridSearch.js';
import { isSidecarUsable } from '../../build/embedding/providers/embeddingProvider.js';

function stub(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => handler(req, res, body ? JSON.parse(body) : {}));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

const fakeSidecar = (port) => ({
  id: 'mock-gpu', name: 'mock-gpu-01', host: '127.0.0.1', port, protocol: 'http', enabled: true,
  capabilities: { reranker: { available: true, models: ['Qwen/Qwen3-Reranker-8B'], loaded: 'Qwen/Qwen3-Reranker-8B' } },
  healthStatus: 'healthy', lastSeen: new Date().toISOString(),
});

const candidates = Array.from({ length: 12 }, (_, i) => ({
  nodeId: `n${i}`, name: `fn${i}`, qualifiedName: `pod::Type.fn${i}`, nodeType: 'method',
  filePath: `src/f${i}.fan`, lineStart: i + 1, signature: `Void fn${i}()`, documentation: `doc ${i}`,
  semanticScore: 1 - i / 20, graphScore: 0, combinedScore: 1 - i / 20, sources: ['vector'],
}));
const key = (r) => r.nodeId;

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };

// --- 1+2: reverse-scoring stub -> order flips
{
  const seen = [];
  const { srv, port } = await stub((req, res, body) => {
    seen.push({ url: req.url, model: body.model, n: body.documents?.length, top_n: body.top_n, hasQuery: typeof body.query === 'string' });
    const n = body.documents.length;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ results: body.documents.map((_, index) => ({ index, relevance_score: index / n })) }));
  });
  const t0 = Date.now();
  const out = await crossEncoderRerank('sedona rete node', candidates, { enabled: true, topK: 50, timeoutMs: 8000, sidecar: fakeSidecar(port) });
  const ms = Date.now() - t0;
  srv.close();
  console.log(`request: ${JSON.stringify(seen[0])}`);
  check(seen[0]?.url === '/v1/rerank' && seen[0].n === 12 && seen[0].hasQuery, 'client POSTs /v1/rerank {model, query, documents, top_n} to the given sidecar');
  check(out[0].nodeId === 'n11' && typeof out[0].crossEncoderScore === 'number', 'reranker scores applied and order flipped (top is n11)');
  const changed = countChangedPositions(candidates, out, key, 10);
  console.log(`[rerank] n=${candidates.length} → top10 changed ${changed} positions sidecar=mock-gpu-01 ms=${ms}`);
  check(changed === 10, 'summary line reports 10/10 changed positions');
}

// --- 3: stalled stub + 500 ms timeout -> unchanged order, fast
{
  const { srv, port } = await stub((_req, res) => { setTimeout(() => res.end('{}'), 10_000); });
  const t0 = Date.now();
  const out = await crossEncoderRerank('q', candidates, { enabled: true, timeoutMs: 500, sidecar: fakeSidecar(port) });
  const ms = Date.now() - t0;
  srv.closeAllConnections?.(); srv.close();
  check(out.map(key).join(',') === candidates.map(key).join(','), `timeout falls back to input order (${ms} ms)`);
  check(ms < 3000, 'fallback happened within the timeout budget (not the old 60 s)');
}

// --- 4: auto-mode probe against the real registry (worktree config copy)
{
  const sc = rerankerSidecarUsable();
  console.log(`rerankerSidecarUsable() in this checkout → ${sc ? `${sc.name} (${sc.host}:${sc.port})` : 'null (no fresh reranker sidecar registered here; auto mode skips rerank)'}`);
  check(isSidecarUsable(fakeSidecar(1)) === true, 'isSidecarUsable accepts an enabled, healthy, freshly-seen reranker sidecar');
  check(isSidecarUsable({ ...fakeSidecar(1), lastSeen: new Date(Date.now() - 10 * 60_000).toISOString() }) === false, 'isSidecarUsable rejects one last seen 10 min ago');
}

// --- RRF sanity through the built module
{
  const fused = rrfFuse([
    { source: 'vector', weight: 1.0, items: candidates.slice(0, 5), key },
    { source: 'keyword', weight: 0.7, items: [candidates[3], candidates[9]], key },
  ]);
  check(fused[0].nodeId === undefined && fused[0].key === 'n3' && fused[0].sources[0] === 'both', 'RRF: item in both lists ranks first with sources=[both]');
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
