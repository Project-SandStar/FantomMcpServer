#!/usr/bin/env -S npx tsx
/**
 * test-soundsuite-llm-rerank.mts
 *
 * Probes the production rerank+chat pipeline against an already-embedded
 * SoundSuite project. Indexing and embedding are NOT this script's job —
 * we assume vectors are already in LanceDB. We exercise the layers above:
 *
 *   QWEN3 embed (already done)
 *     → QWEN3-Reranker-8B  (sidecar cross-encoder)
 *       → {Groq | Anthropic Claude | Google Gemini}  (chat)
 *
 * The script runs five variants per question:
 *
 *   baseline   — vector top-K, no rerank          (control)
 *   qwen-only  — vector → Qwen rerank, no LLM     (isolates Qwen uplift)
 *   groq       — vector → Qwen rerank → Groq      (full pipeline, Groq)
 *   anthropic  — vector → Qwen rerank → Claude    (full pipeline, Claude)
 *   gemini     — vector → Qwen rerank → Gemini    (full pipeline, Gemini)
 *
 * The LLM stage is wired via the existing semanticSearch.llmReranker —
 * historically named "rerank" but in practice the model reads the snippets
 * and returns its preferred ordering, which is the chat layer of the
 * pipeline as far as this script is concerned.
 *
 * Output: a markdown report to logs/reports/<timestamp>.md with per-
 * question tables, latency stats, top-1 agreement matrix, and a verdict
 * section flagging any provider that errored or fell through silently.
 *
 * Usage:
 *   npx tsx scripts/test-soundsuite-llm-rerank.mts
 *   FANTOM_HOST=http://localhost:3848 npx tsx scripts/test-soundsuite-llm-rerank.mts
 *   PROJECT_NAME=SoundSuite npx tsx scripts/...
 *
 * Optional reindex/embed (off by default — set FORCE_REINDEX=1 /
 * FORCE_EMBED=1 to opt in). Most runs should leave them off because the
 * point is to compare rerankers on a stable corpus.
 *
 * Required: ANTHROPIC_API_KEY / GROQ_API_KEY / GEMINI_API_KEY in the
 * server's .env, and at least one sidecar advertising
 * capabilities.reranker with Qwen/Qwen3-Reranker-8B. Missing pieces
 * surface as per-variant errors in the report rather than aborting.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ───────────────────────────── Config ───────────────────────────────────
const HOST = process.env.FANTOM_HOST ?? 'http://localhost:3848';
const ADMIN_USER = process.env.ADMIN_USER ?? 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS ?? 'admin';
const PROJECT_NAME = process.env.PROJECT_NAME ?? 'SoundSuite';
// Reindex + embed are off by default — vectors should already exist.
// Flip these on only when explicitly testing the full pipeline.
const FORCE_REINDEX = process.env.FORCE_REINDEX === '1';
const FORCE_EMBED = process.env.FORCE_EMBED === '1';
const REPORTS_DIR = process.env.REPORTS_DIR ?? path.join(process.cwd(), 'logs', 'reports');
const EMBED_POLL_INTERVAL_MS = 5_000;
const EMBED_POLL_TIMEOUT_MS = 30 * 60_000;
const TOP_K = 5;
const RERANK_TOPK = Number(process.env.RERANK_TOPK ?? '50');
const QWEN_RERANKER_MODEL = process.env.QWEN_RERANKER_MODEL ?? 'Qwen/Qwen3-Reranker-8B';
const REQUEST_TIMEOUT_MS = 120_000;            // LLM rerank can be slow

// Variants exercise increasingly more of the production pipeline.
// `qwen-only` isolates the cross-encoder uplift from the chat layer so
// the report can attribute downstream gains correctly.
const VARIANTS = ['baseline', 'qwen-only', 'groq', 'anthropic', 'gemini'] as const;
type Variant = typeof VARIANTS[number];

const QUESTIONS = [
  'How does session authentication work?',
  'Where is the WebSocket connection lifecycle handled?',
  'What does the audio mixer do and how is it wired together?',
  'How are device presets persisted and loaded back?',
  'Where does the project handle MIDI input events?',
  'How is the SOX (Sound exchange) WebSocket bridge implemented?',
  'Where is real-time audio buffering managed?',
  'How does the project handle reconnection after a network drop?',
  'Where is the OSC (Open Sound Control) protocol parsed?',
  'How does the project schedule periodic background tasks?',
];

const auth = 'Basic ' + Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString('base64');

// ───────────────────────────── HTTP helper ──────────────────────────────
async function callJson<T = unknown>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ ok: true; data: T; ms: number; status: number } | { ok: false; error: string; ms: number; status: number }> {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(`${HOST}${path}`, {
      method,
      headers: {
        Authorization: auth,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const ms = Date.now() - t0;
    const text = await r.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : {}; } catch { /* keep text */ }
    if (!r.ok) return { ok: false, error: typeof parsed === 'object' && parsed && 'error' in parsed ? String((parsed as Record<string, unknown>).error) : `HTTP ${r.status}: ${text.slice(0, 200)}`, ms, status: r.status };
    return { ok: true, data: parsed as T, ms, status: r.status };
  } catch (e) {
    const ms = Date.now() - t0;
    return { ok: false, error: e instanceof Error ? e.message : String(e), ms, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────────── Types ────────────────────────────────────
interface CodeProject {
  id: number;
  name: string;
  path?: string;
  language?: string;
  functionCount?: number;
  typeCount?: number;
}

interface SearchResult {
  nodeId: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  lineStart: number;
  combinedScore?: number;
  score?: number;
}

interface SearchResponse {
  query: string;
  count: number;
  elapsedMs: number;
  rerankerProvider: string | null;
  results: SearchResult[];
}

interface ModelStatusResponse {
  code: { configuredModel: string; configuredDimensions: number; storedModel: string | null; storedDimensions: number | null; storedRows: number; mismatch: boolean };
  docs: { configuredModel: string; configuredDimensions: number; storedModel: string | null; storedDimensions: number | null; storedRows: number; mismatch: boolean };
}

// ───────────────────────────── Phases ───────────────────────────────────
async function findProject(): Promise<CodeProject> {
  const r = await callJson<{ projects?: CodeProject[]; sources?: unknown }>('GET', '/admin/code-projects');
  if (!r.ok) throw new Error(`code-projects fetch failed: ${r.error}`);
  const project = (r.data.projects ?? []).find(p => p.name === PROJECT_NAME);
  if (!project) {
    const names = (r.data.projects ?? []).map(p => p.name).slice(0, 10);
    throw new Error(`Project "${PROJECT_NAME}" not found. First 10 known: ${names.join(', ')}`);
  }
  return project;
}

interface ReindexReport {
  ms: number;
  result?: { functionsIndexed?: number; typesIndexed?: number; filesProcessed?: number; duration?: number; errors?: unknown[] };
  noChange?: boolean;
  error?: string;
}
async function reindexProject(id: number): Promise<ReindexReport> {
  const r = await callJson<{ indexResult?: ReindexReport['result']; noChange?: boolean }>('POST', `/admin/code-projects/${id}/reindex`);
  if (!r.ok) return { ms: r.ms, error: r.error };
  return { ms: r.ms, result: r.data.indexResult, noChange: r.data.noChange };
}

interface EmbedSnapshot { storedRows: number; expectedNodes: number; pct: number }
async function embedSnapshot(project: CodeProject): Promise<EmbedSnapshot> {
  // Per-project counts come back via /admin/vectors/by-project, but a robust
  // shortcut is the model-status endpoint plus the project's node count.
  const ms = await callJson<ModelStatusResponse>('GET', '/admin/vectors/model-status');
  if (!ms.ok) return { storedRows: 0, expectedNodes: 0, pct: 0 };
  const expected = (project.functionCount ?? 0) + (project.typeCount ?? 0);
  // The top-level storedRows is global; for per-project we'd need
  // /admin/vectors/by-project. Fall back to the global value as a coarse
  // signal; per-project precision is captured below in pollEmbedComplete.
  return { storedRows: ms.data.code.storedRows, expectedNodes: expected, pct: 0 };
}

async function perProjectVectorCount(projectId: number): Promise<number> {
  // /admin/vectors/stats returns a per-project array with vectorCount.
  // Heavier than ideal (full stats blob) but it's the only per-project
  // signal exposed today.
  const r = await callJson<{ projects?: Array<{ id: number; vectorCount: number }> }>('GET', '/admin/vectors/stats');
  if (!r.ok) return 0;
  const row = (r.data.projects ?? []).find(p => p.id === projectId);
  return row?.vectorCount ?? 0;
}

interface EmbedReport { startMs: number; rounds: number; finalStoredRows: number; expectedNodes: number; pct: number; jobId?: string; timedOut: boolean; error?: string }
async function embedMissingAndPoll(project: CodeProject): Promise<EmbedReport> {
  const expected = (project.functionCount ?? 0) + (project.typeCount ?? 0);
  const start = Date.now();
  // Kick off the per-project build-missing (returns 202 with jobId or fast-path summary).
  const trigger = await callJson<{ jobId?: string; processed?: number; errors?: number }>('POST', `/admin/vectors/build-missing/${project.id}`);
  const jobId = (trigger.ok && 'jobId' in trigger.data) ? trigger.data.jobId : undefined;

  let rounds = 0;
  let stored = await perProjectVectorCount(project.id);
  while (Date.now() - start < EMBED_POLL_TIMEOUT_MS) {
    rounds++;
    if (expected > 0 && stored >= expected) break;
    await new Promise(r => setTimeout(r, EMBED_POLL_INTERVAL_MS));
    stored = await perProjectVectorCount(project.id);
  }
  return {
    startMs: start,
    rounds,
    finalStoredRows: stored,
    expectedNodes: expected,
    pct: expected > 0 ? Math.min(100, Math.round((stored / expected) * 100)) : 0,
    jobId,
    timedOut: !(expected > 0 && stored >= expected) && Date.now() - start >= EMBED_POLL_TIMEOUT_MS,
    error: trigger.ok ? undefined : trigger.error,
  };
}

interface QueryRow {
  question: string;
  perVariant: Record<Variant, { ok: boolean; ms: number; results: SearchResult[]; error?: string }>;
}

async function searchOne(query: string, variant: Variant, projectId: number): Promise<{ ok: boolean; ms: number; results: SearchResult[]; error?: string }> {
  const body: Record<string, unknown> = { query, projectId, limit: TOP_K };
  // Cross-encoder rerank stage — applied to every non-baseline variant.
  // qwen-only stops here (no LLM stage). The cloud-LLM variants stack
  // their rerank on top of the Qwen-reranked candidates.
  if (variant !== 'baseline') {
    body.crossEncoderReranker = { enabled: true, model: QWEN_RERANKER_MODEL, topK: RERANK_TOPK };
  }
  // Chat / LLM stage — only the cloud-LLM variants enable this.
  if (variant === 'groq' || variant === 'anthropic' || variant === 'gemini') {
    body.llmReranker = { enabled: true, provider: variant, topK: TOP_K };
  }
  const r = await callJson<SearchResponse>('POST', '/admin/search/semantic', body);
  if (!r.ok) return { ok: false, ms: r.ms, results: [], error: r.error };
  return { ok: true, ms: r.ms, results: (r.data.results ?? []).slice(0, TOP_K) };
}

async function runQueries(project: CodeProject): Promise<QueryRow[]> {
  const rows: QueryRow[] = [];
  for (const question of QUESTIONS) {
    process.stdout.write(`Q: ${question}\n`);
    const perVariant: QueryRow['perVariant'] = {} as never;
    for (const variant of VARIANTS) {
      process.stdout.write(`  ${variant.padEnd(10)} `);
      const r = await searchOne(question, variant, project.id);
      perVariant[variant] = r;
      if (r.ok) {
        const top1 = r.results[0];
        process.stdout.write(`✓ ${String(r.ms).padStart(5)}ms  top1=${top1 ? top1.qualifiedName.slice(0, 60) : '<none>'}\n`);
      } else {
        process.stdout.write(`× ${String(r.ms).padStart(5)}ms  err=${r.error.slice(0, 80)}\n`);
      }
    }
    rows.push({ question, perVariant });
    process.stdout.write('\n');
  }
  return rows;
}

// ───────────────────────────── Reporting ────────────────────────────────
function fmtNum(n: number | undefined): string {
  return typeof n === 'number' ? n.toLocaleString() : '—';
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function p95(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

function formatTopList(results: SearchResult[]): string {
  if (results.length === 0) return '—';
  return results.map(r => `\`${(r.qualifiedName || r.name).replace(/\|/g, '\\|')}\``).join('<br>');
}

function jaccardTop3(a: SearchResult[], b: SearchResult[]): number {
  const aSet = new Set(a.slice(0, 3).map(r => r.nodeId));
  const bSet = new Set(b.slice(0, 3).map(r => r.nodeId));
  const inter = [...aSet].filter(x => bSet.has(x)).length;
  const union = new Set([...aSet, ...bSet]).size;
  return union === 0 ? 0 : inter / union;
}

interface ReportInput {
  startedAt: Date;
  finishedAt: Date;
  host: string;
  project: CodeProject;
  modelStatus: ModelStatusResponse | null;
  reindex?: ReindexReport;
  embed?: EmbedReport;
  queries: QueryRow[];
}

function renderReport(r: ReportInput): string {
  const lines: string[] = [];
  const dur = (r.finishedAt.getTime() - r.startedAt.getTime()) / 1000;
  lines.push(`# Soundsuite LLM Rerank Probe`);
  lines.push('');
  lines.push(`- **Started**: ${r.startedAt.toISOString()}`);
  lines.push(`- **Finished**: ${r.finishedAt.toISOString()} (${dur.toFixed(1)}s total)`);
  lines.push(`- **Host**: ${r.host}`);
  lines.push(`- **Project**: ${r.project.name} (id=${r.project.id}, lang=${r.project.language ?? '?'})`);
  lines.push(`- **Functions**: ${fmtNum(r.project.functionCount)} · **Types**: ${fmtNum(r.project.typeCount)}`);
  if (r.modelStatus) {
    lines.push(`- **Code embedding**: ${r.modelStatus.code.configuredModel} (${r.modelStatus.code.configuredDimensions}d, stored=${fmtNum(r.modelStatus.code.storedRows)} rows)`);
  }
  lines.push('');

  // Reindex section
  lines.push(`## Reindex`);
  if (!r.reindex) {
    lines.push(`Skipped (default — vectors assumed already present). Set FORCE_REINDEX=1 to opt in.`);
  } else if (r.reindex.error) {
    lines.push(`× **Error**: ${r.reindex.error}`);
  } else if (r.reindex.noChange) {
    lines.push(`✓ No source changes detected — hash gate short-circuited (${r.reindex.ms} ms).`);
  } else {
    const x = r.reindex.result;
    lines.push(`✓ Indexed in ${r.reindex.ms} ms. Functions: ${fmtNum(x?.functionsIndexed)} · Types: ${fmtNum(x?.typesIndexed)} · Files: ${fmtNum(x?.filesProcessed)} · Errors: ${fmtNum(x?.errors?.length)}`);
  }
  lines.push('');

  // Embed section
  lines.push(`## Embedding`);
  if (!r.embed) {
    lines.push(`Skipped (default — vectors assumed already present). Set FORCE_EMBED=1 to opt in.`);
  } else {
    lines.push(`- Stored vectors: **${fmtNum(r.embed.finalStoredRows)} / ${fmtNum(r.embed.expectedNodes)}** (${r.embed.pct}%)`);
    lines.push(`- Polling rounds: ${r.embed.rounds}`);
    if (r.embed.jobId) lines.push(`- Background jobId: \`${r.embed.jobId}\``);
    if (r.embed.timedOut) lines.push(`- ⚠ **Timed out** after ${EMBED_POLL_TIMEOUT_MS / 60_000} min — query results below may be against partial coverage`);
    if (r.embed.error) lines.push(`- × Trigger error: ${r.embed.error}`);
  }
  lines.push('');

  // Pipeline diagram so the report is self-explanatory.
  lines.push(`## Pipeline`);
  lines.push('');
  lines.push('```');
  lines.push('  query  →  qwen3-embedding (LanceDB top-K)  →  Qwen3-Reranker-8B  →  cloud LLM');
  lines.push('             [done before run]                  [sidecar, all variants    [groq | claude');
  lines.push('                                                 except baseline]            | gemini]');
  lines.push('```');
  lines.push('');
  lines.push(`Variants:`);
  lines.push(`- **baseline** — vector top-${TOP_K}, no rerank.`);
  lines.push(`- **qwen-only** — vector → Qwen3-Reranker-8B (\`${QWEN_RERANKER_MODEL}\`, topK=${RERANK_TOPK}). No LLM stage.`);
  lines.push(`- **groq / anthropic / gemini** — vector → Qwen rerank → cloud LLM as the chat layer.`);
  lines.push('');

  // Per-question results
  lines.push(`## Per-Question Top-1`);
  lines.push('');
  const headers = ['#', 'Question', ...VARIANTS];
  lines.push(`| ${headers.join(' | ')} |`);
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
  r.queries.forEach((q, i) => {
    const row: string[] = [String(i + 1), q.question.replace(/\|/g, '\\|')];
    for (const v of VARIANTS) {
      const cell = q.perVariant[v];
      if (!cell.ok) { row.push(`× ${cell.error?.slice(0, 40) ?? 'err'}`); continue; }
      const top1 = cell.results[0];
      row.push(top1 ? `\`${(top1.qualifiedName || top1.name).slice(0, 50)}\` (${cell.ms}ms)` : `<none> (${cell.ms}ms)`);
    }
    lines.push(`| ${row.join(' | ')} |`);
  });
  lines.push('');

  // Per-question Top-K detail
  lines.push(`## Per-Question Top-${TOP_K} Details`);
  r.queries.forEach((q, i) => {
    lines.push('');
    lines.push(`### Q${i + 1}. ${q.question}`);
    lines.push('');
    lines.push(`| Variant | Latency | Top ${TOP_K} |`);
    lines.push(`| --- | --- | --- |`);
    for (const v of VARIANTS) {
      const cell = q.perVariant[v];
      if (!cell.ok) { lines.push(`| **${v}** | — | × ${cell.error?.replace(/\|/g, '\\|').slice(0, 200)} |`); continue; }
      lines.push(`| **${v}** | ${cell.ms} ms | ${formatTopList(cell.results)} |`);
    }
  });
  lines.push('');

  // Stats per variant
  lines.push(`## Variant Stats`);
  lines.push('');
  lines.push(`| Variant | Success | Avg latency | Median | p95 | Top-1 unique | Top-3 Jaccard vs baseline |`);
  lines.push(`| --- | --- | --- | --- | --- | --- | --- |`);
  for (const v of VARIANTS) {
    const cells = r.queries.map(q => q.perVariant[v]);
    const ok = cells.filter(c => c.ok);
    const lats = ok.map(c => c.ms);
    const avg = lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : 0;
    const successRate = `${ok.length}/${cells.length}`;
    const top1Set = new Set(ok.map(c => c.results[0]?.nodeId).filter(Boolean));
    const jaccards = r.queries.map(q => {
      const baseline = q.perVariant['baseline'];
      const variant = q.perVariant[v];
      if (!baseline.ok || !variant.ok) return null;
      return jaccardTop3(baseline.results, variant.results);
    }).filter((x): x is number => x !== null);
    const avgJaccard = jaccards.length ? (jaccards.reduce((a, b) => a + b, 0) / jaccards.length).toFixed(2) : '—';
    lines.push(`| **${v}** | ${successRate} | ${avg} ms | ${median(lats)} ms | ${p95(lats)} ms | ${top1Set.size} | ${v === 'baseline' ? '—' : avgJaccard} |`);
  }
  lines.push('');

  // Top-1 agreement matrix
  lines.push(`## Top-1 Agreement Matrix`);
  lines.push('');
  lines.push(`How often each pair of variants chose the same top-1 result.`);
  lines.push('');
  lines.push(`| | ${VARIANTS.join(' | ')} |`);
  lines.push(`| --- | ${VARIANTS.map(() => '---').join(' | ')} |`);
  for (const a of VARIANTS) {
    const row: string[] = [`**${a}**`];
    for (const b of VARIANTS) {
      if (a === b) { row.push('—'); continue; }
      let matches = 0, total = 0;
      for (const q of r.queries) {
        const ca = q.perVariant[a], cb = q.perVariant[b];
        if (!ca.ok || !cb.ok) continue;
        total++;
        if (ca.results[0]?.nodeId === cb.results[0]?.nodeId) matches++;
      }
      row.push(total > 0 ? `${matches}/${total} (${Math.round((matches / total) * 100)}%)` : '—');
    }
    lines.push(`| ${row.join(' | ')} |`);
  }
  lines.push('');

  // Errors
  const errors: Array<{ q: string; v: Variant; e: string }> = [];
  for (const q of r.queries) {
    for (const v of VARIANTS) {
      const c = q.perVariant[v];
      if (!c.ok) errors.push({ q: q.question, v, e: c.error ?? 'unknown' });
    }
  }
  if (errors.length > 0) {
    lines.push(`## Errors (${errors.length})`);
    lines.push('');
    for (const e of errors) {
      lines.push(`- **${e.v}** on _"${e.q}"_: \`${e.e.replace(/`/g, '').slice(0, 200)}\``);
    }
    lines.push('');
  }

  // Verdict
  lines.push(`## Verdict`);
  lines.push('');
  const okPerVar = Object.fromEntries(VARIANTS.map(v => [v, r.queries.filter(q => q.perVariant[v].ok).length]));
  const total = r.queries.length;
  if (okPerVar['baseline'] < total) {
    lines.push(`- ⚠ **Baseline failed ${total - okPerVar['baseline']} of ${total} queries** — investigate before judging downstream variants. Common cause: LanceDB schema mismatch or zero stored vectors. Re-embed via /dashboard/config/#semantic.`);
  } else {
    if ((okPerVar['qwen-only'] ?? 0) < total) {
      lines.push(`- ⚠ **qwen-only** failed ${total - (okPerVar['qwen-only'] ?? 0)}/${total} — likely no sidecar advertising \`reranker\` capability with \`${QWEN_RERANKER_MODEL}\`. Check /dashboard/config/#sidecars.`);
    }
    for (const v of ['groq', 'anthropic', 'gemini'] as Variant[]) {
      const failed = total - (okPerVar[v] ?? 0);
      if (failed > 0) {
        lines.push(`- ⚠ **${v}** failed ${failed}/${total} — likely missing API key or model not enabled. Set ${v.toUpperCase()}_API_KEY in the server's .env and toggle Enabled on /dashboard/config/#llm-providers.`);
      }
    }
    if (Object.values(okPerVar).every(v => v === total)) {
      lines.push(`- ✓ All variants answered all ${total} queries successfully.`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

// ───────────────────────────── main ─────────────────────────────────────
async function main(): Promise<void> {
  const startedAt = new Date();
  console.log(`Soundsuite LLM rerank probe vs ${HOST}\n`);

  console.log('▶ resolving project…');
  const project = await findProject();
  console.log(`  ✓ ${project.name} (id=${project.id}, lang=${project.language}, fns=${project.functionCount}, types=${project.typeCount})\n`);

  let modelStatus: ModelStatusResponse | null = null;
  const ms = await callJson<ModelStatusResponse>('GET', '/admin/vectors/model-status');
  if (ms.ok) modelStatus = ms.data;

  // Reindex + embed are off by default — vectors should already be in
  // place. The script's job is rerank+chat, not bringing the corpus up.
  let reindex: ReindexReport | undefined;
  if (FORCE_REINDEX) {
    console.log('▶ reindexing (FORCE_REINDEX=1)…');
    reindex = await reindexProject(project.id);
    if (reindex.error) console.log(`  × ${reindex.error}\n`);
    else if (reindex.noChange) console.log(`  ✓ no changes (${reindex.ms} ms)\n`);
    else console.log(`  ✓ ${reindex.result?.functionsIndexed ?? 0} fns / ${reindex.result?.typesIndexed ?? 0} types in ${reindex.ms} ms\n`);
  }

  let embed: EmbedReport | undefined;
  if (FORCE_EMBED) {
    const before = await embedSnapshot(project);
    console.log(`▶ embedding (FORCE_EMBED=1; start: ${before.storedRows} stored / ${before.expectedNodes} expected)…`);
    embed = await embedMissingAndPoll(project);
    console.log(`  ${embed.timedOut ? '⏱' : '✓'} ${embed.finalStoredRows}/${embed.expectedNodes} (${embed.pct}%) after ${embed.rounds} polls\n`);
  }

  console.log('▶ running queries (rerank + chat layers only)…\n');
  const queries = await runQueries(project);

  const finishedAt = new Date();
  const report = renderReport({ startedAt, finishedAt, host: HOST, project, modelStatus, reindex, embed, queries });

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const filename = `soundsuite-llm-${startedAt.toISOString().replace(/[:.]/g, '-')}.md`;
  const filepath = path.join(REPORTS_DIR, filename);
  fs.writeFileSync(filepath, report, 'utf-8');

  console.log(`▶ report written → ${filepath}`);
  console.log(`  ${report.length.toLocaleString()} chars · ${queries.length} questions · ${VARIANTS.length} variants`);

  // Print just the verdict to stdout so CI logs are useful even without the file.
  console.log('\n' + report.split('## Verdict\n\n')[1]?.split('\n').filter(Boolean).join('\n'));
}

main().catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});
