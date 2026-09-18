/**
 * Search over `axon_vectors` in three modes:
 *   vector  — LanceDB ANN (cosine) with the Code Search model
 *   rerank  — top 50 → sidecar cross-encoder (`callSidecarReranker`)
 *   rlm     — top hits as seed context → `runRlmGather` with Axon-specific tools
 *
 * Result rows mirror the Fantom `SemanticSearchResult` shape so the Vector
 * Viewer renders them unchanged; `answer`/`citations` mirror `/admin/vectors/ask`.
 */

import * as fs from 'node:fs';
import { createLogger } from '../utils/index.js';
import { selectQueryEmbeddingProvider, type EmbeddingProvider } from '../embedding/providers/embeddingProvider.js';
import { callSidecarReranker } from '../embedding/sidecarRerankerClient.js';
import { runRlmGather, type RlmToolSpec } from '../embedding/rlmToolLoop.js';
import { getAxonLanceTable, axonTableExists } from './axonLance.js';
import { getAxonProjDir, getAxonLibraryDir, resolveAxonEmbeddingModel } from './axonSettings.js';
import type { AxonRecordSource } from './axonProjParser.js';
import { findAxonFunction } from './axonIndexer.js';
import * as path from 'node:path';

const logger = createLogger('axon-search');

export type AxonSearchMode = 'vector' | 'rerank' | 'rlm';

export interface AxonSearchResult {
  nodeId: string;
  source: AxonRecordSource;
  name: string;
  qualifiedName: string;
  nodeType: 'axon-function';
  filePath: string;
  lineStart: number;
  lineEnd: number;
  signature?: string;
  documentation?: string;
  params?: Array<{ name: string; type?: string; default?: string; required: boolean }>;
  returnType?: string;
  tags?: string[];
  chunkIndex?: number;
  chunkCount?: number;
  projectId: string;
  instance: string;
  project: string;
  semanticScore: number;
  graphScore: number;
  combinedScore: number;
  rerankScore?: number;
}

export interface AxonCitation {
  nodeId: string;
  source: AxonRecordSource;
  qualifiedName: string;
  filePath: string;
  lineStart: number;
  project: string;
}

export interface AxonSearchResponse {
  query: string;
  mode: AxonSearchMode;
  source: 'axon';
  count: number;
  results: AxonSearchResult[];
  model: string;
  /** Set when a requested stage was unavailable and the response fell back. */
  degraded?: 'no-reranker' | 'no-rlm' | 'empty-table';
  answer?: string;
  citations?: AxonCitation[];
  provider?: string;
  rlm?: { model: string | null; rounds: number; toolCalls: number };
}

export interface AxonSearchOptions {
  projectId?: string;
  /** 'proj' | 'library' | 'all' (default all). */
  source?: AxonRecordSource | 'all';
  mode?: AxonSearchMode;
  limit?: number;
  minScore?: number;
  /** Test hook. */
  provider?: EmbeddingProvider;
  signal?: AbortSignal;
}

/**
 * The query encoder must come from the same pool that built the rows it is
 * searching, so this reads the code-embedding routing policy exactly as the
 * indexer does: under "OpenRouter only" a local encoder against a cloud-built
 * `axon_vectors` is a mismatch on every single query, with no error to
 * attribute the bad hits to. `selectQueryEmbeddingProvider` returns the whole
 * verified cloud pool behind one failover facade, or throws with a named
 * reason; under the GPU-serving policies it falls through to local selection.
 */
async function pickQueryProvider(model: string, override?: EmbeddingProvider): Promise<EmbeddingProvider> {
  if (override) return override;
  return selectQueryEmbeddingProvider('code', model);
}

function esc(s: string): string { return s.replace(/'/g, "''"); }

export async function axonVectorSearch(
  query: string,
  opts: AxonSearchOptions = {},
): Promise<{ results: AxonSearchResult[]; model: string; degraded?: 'empty-table' }> {
  const { model } = resolveAxonEmbeddingModel();
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  if (!(await axonTableExists())) return { results: [], model, degraded: 'empty-table' };
  const table = await getAxonLanceTable();
  if ((await table.countRows()) === 0) return { results: [], model, degraded: 'empty-table' };

  const provider = await pickQueryProvider(model, opts.provider);
  const qv = await provider.embed(query);
  // Over-fetch: long functions contribute several chunk rows; dedupe by node_id.
  let q = table.vectorSearch(Array.from(qv)).distanceType('cosine').limit(limit * 3);
  const where: string[] = [];
  if (opts.projectId) where.push(`project_id = '${esc(opts.projectId)}'`);
  if (opts.source && opts.source !== 'all') where.push(`source = '${esc(opts.source)}'`);
  if (where.length) q = q.where(where.join(' AND '));
  const rows = await q.toArray();
  const projDir = getAxonProjDir();
  const libDir = getAxonLibraryDir();
  const minScore = opts.minScore ?? 0.25;
  const results: AxonSearchResult[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const distance: number = Number(row._distance ?? 0);
    const score = Math.max(0, 1 - distance);
    if (score < minScore) continue;
    const nodeId = String(row.node_id);
    if (seen.has(nodeId)) continue; // best chunk wins (rows arrive by distance)
    seen.add(nodeId);
    let params: AxonSearchResult['params'];
    try { params = row.params ? JSON.parse(String(row.params)) : undefined; } catch { params = undefined; }
    const source: AxonRecordSource = String(row.source ?? 'proj') === 'library' ? 'library' : 'proj';
    results.push({
      nodeId,
      source,
      name: String(row.name),
      qualifiedName: String(row.qualified_name),
      nodeType: 'axon-function',
      filePath: path.join(source === 'library' ? libDir : projDir, String(row.rel_path)),
      lineStart: Number(row.line_start ?? 1),
      lineEnd: Number(row.line_end ?? 1),
      signature: String(row.signature ?? ''),
      documentation: row.doc ? String(row.doc) : undefined,
      params,
      returnType: row.return_type ? String(row.return_type) : undefined,
      tags: row.tags ? String(row.tags).split(',').filter(Boolean) : undefined,
      chunkIndex: row.chunk_index !== undefined ? Number(row.chunk_index) : undefined,
      chunkCount: row.chunk_count !== undefined ? Number(row.chunk_count) : undefined,
      projectId: String(row.project_id),
      instance: String(row.instance),
      project: String(row.project),
      semanticScore: score,
      graphScore: 0,
      combinedScore: score,
    });
    if (results.length >= limit) break;
  }
  return { results, model };
}

function readSnippet(filePath: string, lineStart: number, maxLines = 40): string {
  try {
    const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
    const from = Math.max(0, lineStart - 1);
    return lines.slice(from, from + maxLines).join('\n');
  } catch { return ''; }
}

function rerankDoc(r: AxonSearchResult): string {
  return [r.qualifiedName, r.signature ?? '', r.documentation?.slice(0, 300) ?? '', readSnippet(r.filePath, r.lineStart, 30).slice(0, 800)].filter(Boolean).join('\n');
}

async function rerankResults(query: string, results: AxonSearchResult[], keep: number): Promise<{ results: AxonSearchResult[]; degraded?: 'no-reranker' }> {
  if (results.length === 0) return { results };
  const candidates = results.slice(0, 50);
  const rr = await callSidecarReranker(query, candidates.map(rerankDoc), { timeoutMs: 60_000 }).catch((e): null => {
    logger.warn(`axon rerank failed: ${(e as Error).message}`);
    return null;
  });
  if (!rr) return { results: results.slice(0, keep), degraded: 'no-reranker' };
  const scored = candidates.map((r, i) => ({ ...r, rerankScore: rr.scores[i] ?? 0 }));
  // Normalise cross-encoder scores into 0..1 for the UI bar; keep the raw score too.
  const max = Math.max(...scored.map(s => s.rerankScore!), 1e-6);
  const min = Math.min(...scored.map(s => s.rerankScore!));
  for (const s of scored) s.combinedScore = max === min ? s.semanticScore : (s.rerankScore! - min) / (max - min);
  scored.sort((a, b) => (b.rerankScore! - a.rerankScore!));
  return { results: scored.slice(0, keep) };
}

// ── RLM tools over Axon ─────────────────────────────────────────────────────

const AXON_RLM_TOOLS: RlmToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'axon_search',
      description:
        'Semantic search over the customer Axon (SkySpark) functions. Returns function name, ' +
        'project, file:line, signature and a source snippet. Pass ONE short concept per call ' +
        '(2-5 words, e.g. "energy baseline previous year").',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Short concept phrase' },
          source: { type: 'string', enum: ['proj', 'library', 'all'], description: 'proj = synced SkySpark projects, library = offline library, all (default)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'axon_function',
      description: 'Full source, parameters, doc and known callees of one Axon function by exact name.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Exact function name, e.g. kpiKwhDeltaPrevYear' } },
        required: ['name'],
      },
    },
  },
];

function formatHit(r: AxonSearchResult): string {
  const snip = readSnippet(r.filePath, r.lineStart, 40);
  return `${r.qualifiedName} (axon-function, ${r.source}) ${r.filePath}:${r.lineStart}\n  sig: ${r.signature || '(none)'}` +
    (r.documentation ? `\n  doc: ${r.documentation.slice(0, 300).replace(/\n/g, ' ')}` : '') +
    (snip ? `\n  source:\n${snip.split('\n').map(l => '    ' + l).join('\n')}` : '');
}

function buildAxonRlmExecutor(projectId?: string, source: AxonRecordSource | 'all' = 'all') {
  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    if (name === 'axon_search') {
      const q = typeof args.query === 'string' ? args.query : '';
      if (!q) return 'axon_search error: missing "query".';
      // The request-level source filter wins; the model may only narrow within it.
      const argSrc = args.source === 'proj' || args.source === 'library' ? args.source : undefined;
      const effSrc: AxonRecordSource | 'all' = source === 'all' ? (argSrc ?? 'all') : source;
      try {
        const { results } = await axonVectorSearch(q, { projectId, source: effSrc, limit: 8 });
        if (results.length === 0) return `axon_search: no results for "${q}".`;
        return results.map(formatHit).join('\n\n');
      } catch (e) { return `axon_search failed: ${(e as Error).message}`; }
    }
    if (name === 'axon_function') {
      const fn = typeof args.name === 'string' ? args.name : '';
      if (!fn) return 'axon_function error: missing "name".';
      const hits = findAxonFunction(fn, projectId, source);
      if (hits.length === 0) return `axon_function: no function named "${fn}"${projectId ? ` in ${projectId}` : ''}.`;
      return hits.slice(0, 3).map(h =>
        `${h.qualifiedName} ${h.filePath}:${h.lineStart}\n  sig: ${h.signature}\n` +
        (h.doc ? `  doc: ${h.doc.slice(0, 400)}\n` : '') +
        (h.calls.length ? `  calls: ${h.calls.join(', ')}\n` : '') +
        `  source:\n${h.body.split('\n').slice(0, 80).map(l => '    ' + l).join('\n')}`,
      ).join('\n\n');
    }
    return `unknown tool ${name}`;
  };
}

/** Build citations from the seed results plus names the draft mentions. */
function collectCitations(draft: string, results: AxonSearchResult[]): AxonCitation[] {
  const mentioned = results.filter(r => draft.includes(r.name));
  const seed = results.slice(0, 5);
  const seen = new Set<string>();
  const out: AxonCitation[] = [];
  for (const r of [...mentioned, ...seed]) {
    if (seen.has(r.nodeId)) continue;
    seen.add(r.nodeId);
    out.push({ nodeId: r.nodeId, source: r.source, qualifiedName: r.qualifiedName, filePath: r.filePath, lineStart: r.lineStart, project: r.projectId });
  }
  return out.slice(0, 10);
}

export async function axonSearch(query: string, opts: AxonSearchOptions = {}): Promise<AxonSearchResponse> {
  const mode: AxonSearchMode = opts.mode ?? 'vector';
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const t0 = Date.now();

  // Stage 1 — vector. Rerank/RLM want a wider candidate pool.
  const wide = mode === 'vector' ? limit : Math.max(limit, 50);
  const { results: vec, model, degraded: emptyTable } = await axonVectorSearch(query, { ...opts, limit: wide, minScore: mode === 'vector' ? opts.minScore : 0.1 });
  const resp: AxonSearchResponse = { query, mode, source: 'axon', count: 0, results: vec.slice(0, limit), model };
  if (emptyTable) { resp.degraded = emptyTable; resp.count = 0; return resp; }

  if (mode === 'rerank' || mode === 'rlm') {
    const rr = await rerankResults(query, vec, limit);
    resp.results = rr.results;
    if (rr.degraded) resp.degraded = rr.degraded;
  }

  if (mode === 'rlm') {
    const seed = resp.results.slice(0, 8).map((r, i) => `[${i + 1}] ${formatHit(r)}`).join('\n\n');
    const gather = await runRlmGather({
      question: query,
      seedContext: seed,
      tools: AXON_RLM_TOOLS,
      executeTool: buildAxonRlmExecutor(opts.projectId, opts.source ?? 'all'),
      maxRounds: 4,
      signal: opts.signal ?? AbortSignal.timeout(150_000),
    }).catch((e): null => { logger.warn(`axon RLM gather failed: ${(e as Error).message}`); return null; });
    if (!gather || !gather.available) {
      resp.degraded = resp.degraded ?? 'no-rlm';
    } else {
      resp.answer = gather.finalDraft?.trim() || gather.evidence?.trim() || '';
      resp.citations = collectCitations(resp.answer, resp.results);
      resp.provider = 'sidecar-rlm';
      resp.rlm = { model: null, rounds: gather.rounds, toolCalls: gather.toolCalls };
    }
  }

  resp.count = resp.results.length;
  logger.debug(`axonSearch "${query}" mode=${mode} → ${resp.count} in ${Date.now() - t0}ms${resp.degraded ? ` (degraded: ${resp.degraded})` : ''}`);
  return resp;
}
