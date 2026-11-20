/**
 * Knowledge card builder: writer pass → check pass (→ one rewrite) → embed →
 * store. Runs on the OpenRouter worker pool's BULK lane, so it shares the
 * Workers limit and never starves interactive search.
 *
 * Spend: every call's usage.cost goes into a per-UTC-day ledger; the build
 * stops before a call once the day's cap is reached. Card calls use the
 * `code-assistant` activity role, which carries no daily cap of its own, so
 * card spend cannot block user asks.
 */
import { chat } from '../openrouter/client.js';
import { openRouterPool } from '../openrouter/workerPool.js';
import { getPoolSettings } from '../openrouter/settings.js';
import { selectQueryEmbeddingProvider } from '../embedding/providers/embeddingProvider.js';
import { createLogger } from '../utils/index.js';
import { getCardSettings, isSidecarModelId, noteAccountBlocked, type KnowledgeCardSettings } from './cardSettings.js';
import { sidecarCardChat, assertSidecarModelLive, stripThink } from './cardSidecar.js';
import {
  cardRowId, upsertCards, ensureCardTextIndex, cardsForProject, type KnowledgeCard, type CardClaim,
} from './cardStore.js';
import { selectTargets, gatherFacts, claimAllowed, clearFactFileCache, type CardFacts, type CardTarget } from './cardFacts.js';

const logger = createLogger('knowledge-cards');

// ── Spend ledger ───────────────────────────────────────────────────────────
let ledger = { day: '', usd: 0, byModel: {} as Record<string, number> };
function today(): string { return new Date().toISOString().slice(0, 10); }
export function noteSpend(model: string, usd: number | null | undefined): void {
  if (ledger.day !== today()) ledger = { day: today(), usd: 0, byModel: {} };
  const n = typeof usd === 'number' && Number.isFinite(usd) ? usd : 0;
  ledger.usd += n;
  ledger.byModel[model] = (ledger.byModel[model] ?? 0) + n;
}
export function spendToday(): { day: string; usd: number; byModel: Record<string, number> } {
  if (ledger.day !== today()) ledger = { day: today(), usd: 0, byModel: {} };
  return { ...ledger, byModel: { ...ledger.byModel } };
}
export function capReached(s = getCardSettings()): boolean {
  return spendToday().usd >= s.dailyCapUsd;
}
/** A build that only calls sidecar models spends nothing, so the daily cap does not gate it. */
export function buildIsFree(s: KnowledgeCardSettings, writer = s.writerModel): boolean {
  return isSidecarModelId(writer) && (!s.checkPass || isSidecarModelId(s.checkerModel));
}

// ── Model calls ────────────────────────────────────────────────────────────
interface CallOut { text: string; costUsd: number; model: string }

/** Learned per model: needs reasoning on; has no endpoint that takes response_format. */
const needsReasoning = new Set<string>();
const noJsonMode = new Set<string>();

/** Batch-only ids (`:batch`) cannot use /chat/completions. */
export function chatUsable(model: string): boolean { return !/:batch$/.test(model); }

async function bulkChat(system: string, user: string, model: string, projectId: number, maxTokens: number): Promise<CallOut> {
  const timeoutMs = Math.max(getPoolSettings().requestTimeoutMs, 180_000);
  if (isSidecarModelId(model)) {
    // Sidecar model: never through the OpenRouter pool or chat(); no paid fallback.
    const out = await sidecarCardChat(system, user, model, { maxTokens, timeoutMs, json: true, lane: 'bulk' });
    noteSpend(model, 0);
    return { text: out.text, costUsd: 0, model: out.model };
  }
  let usedReasoning = false;
  let usedJson = true;
  const once = () => {
    const reasoning = needsReasoning.has(model);
    usedReasoning = reasoning;
    usedJson = !noJsonMode.has(model);
    return openRouterPool().submit({
      role: 'knowledge-card', lane: 'bulk', projectId,
      run: () => chat([{ role: 'system', content: system }, { role: 'user', content: user }], {
        role: 'code-assistant', model, temperature: 0.1, timeoutMs, reasoning,
        // Reasoning spends from max_tokens; leave room for the answer.
        maxTokens: reasoning ? maxTokens + 3000 : maxTokens,
        extra: noJsonMode.has(model) ? undefined : { response_format: { type: 'json_object' } },
      }),
    });
  };
  let out;
  for (let attempt = 0; ; attempt++) {
    try { out = await once(); break; } catch (err) {
      const msg = String((err as Error).message ?? '');
      if (attempt >= 2) throw err;
      // Judge by what THIS call sent: a parallel call may have learned the flag already.
      if (/reasoning is mandatory/i.test(msg) && !usedReasoning) { needsReasoning.add(model); continue; }
      // A ZDR / data-policy refusal is an account setting; retrying cannot fix it.
      if (/ZDR|data policy/i.test(msg)) { noteAccountBlocked(model, msg); throw err; }
      if (/response_format|structured/i.test(msg) && usedJson) { noJsonMode.add(model); continue; }
      throw err;
    }
  }
  noteSpend(model, out.costUsd);
  return { text: out.text, costUsd: out.costUsd ?? 0, model: out.model };
}

/** Balanced top-level `{…}` spans, string- and escape-aware. */
function jsonObjectSpans(s: string): string[] {
  const out: string[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { if (depth > 0) inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}' && depth > 0) { depth--; if (depth === 0 && start >= 0) { out.push(s.slice(start, i + 1)); start = -1; } }
  }
  return out;
}

/**
 * The JSON object in a model reply. Tolerates think blocks, code fences,
 * preamble and trailing text. With `keys`, prefers the object that has one of
 * them (a thinking model may quote example objects before the real one).
 */
export function parseJsonReply(text: string, keys: string[] = []): any {
  const s = stripThink(text ?? '');
  const tryParse = (t: string): any => { try { const v = JSON.parse(t); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } };
  const whole = tryParse(s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim());
  if (whole) return whole;
  const cands = [
    ...[...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(m => m[1].trim()),
    ...jsonObjectSpans(s),
  ].map(tryParse).filter(Boolean);
  if (!cands.length) {
    // Legacy: first '{' to last '}'.
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    return i >= 0 && j > i ? tryParse(s.slice(i, j + 1)) : null;
  }
  const keyed = keys.length ? cands.filter(o => keys.some(k => k in o)) : [];
  return (keyed.length ? keyed[keyed.length - 1] : cands[cands.length - 1]);
}

const WRITER_SYSTEM = `You write a short knowledge card about one piece of code, using ONLY the facts given.
Facts are numbered source lines and graph edges (callers, callees, containment) from a code graph.
Return JSON: {"summary": "<one sentence: what it does>", "claims": [{"text": "<one fact>", "file": "<file path exactly as given>", "line": <line number from the facts>}]}
Rules:
- 3 to 8 claims. Cover: what it does, where it lives, what uses it (callers), what it uses (callees), how it connects to other code.
- Every claim names the file and a line number that appear in the facts and support it. No claim without a source.
- Do not guess behaviour you cannot see in the lines given. Plain English, no filler.`;

const CHECKER_SYSTEM = `You check a knowledge card against the source facts it was built from.
For each claim decide whether the cited file:line and the facts support it exactly.
Return JSON: {"claims": [{"i": <claim index from 0>, "ok": true|false, "why": "<short reason when false>"}], "confidence": <0..1 that the whole card is correct>}`;

interface Draft { summary: string; claims: CardClaim[]; dropped: number; costUsd: number }

async function writeDraft(f: CardFacts, model: string, projectId: number, feedback?: string): Promise<Draft> {
  const user = `${f.factText}${feedback ? `\n\nA checker rejected the previous card:\n${feedback}\nWrite it again; fix or drop those claims.` : ''}`;
  const out = await bulkChat(WRITER_SYSTEM, user, model, projectId, 1500);
  const j = parseJsonReply(out.text, ['summary', 'claims']) ?? {};
  const raw: CardClaim[] = Array.isArray(j.claims) ? j.claims : [];
  const claims: CardClaim[] = [];
  let dropped = 0;
  for (const c of raw) {
    const text = typeof c?.text === 'string' ? c.text.trim() : '';
    const file = typeof c?.file === 'string' ? c.file.trim() : '';
    const line = Number(c?.line);
    // A claim whose source is not in the supplied facts is cut, in code.
    if (!text || !file || !Number.isFinite(line) || !claimAllowed(f.allowed, file, line)) { dropped++; continue; }
    claims.push({ text, file, line });
  }
  return { summary: typeof j.summary === 'string' ? j.summary.trim() : '', claims, dropped, costUsd: out.costUsd };
}

interface Check { ok: boolean; confidence: number; failed: Array<{ i: number; why: string }>; costUsd: number }

async function checkDraft(f: CardFacts, d: Draft, model: string, projectId: number): Promise<Check> {
  const card = d.claims.map((c, i) => `${i}. ${c.text} [${c.file}:${c.line}]`).join('\n');
  const out = await bulkChat(CHECKER_SYSTEM, `FACTS:\n${f.factText}\n\nCARD:\nSummary: ${d.summary}\n${card}`, model, projectId, 1200);
  const j = parseJsonReply(out.text, ['confidence', 'claims']) ?? {};
  const list: any[] = Array.isArray(j.claims) ? j.claims : [];
  const failed = list.filter(x => x && x.ok === false).map(x => ({ i: Number(x.i), why: String(x.why ?? '') }));
  let confidence = Number(j.confidence);
  if (!Number.isFinite(confidence)) confidence = list.length ? (list.length - failed.length) / list.length : 0;
  confidence = Math.max(0, Math.min(1, confidence));
  if (failed.length) confidence = Math.min(confidence, 0.6);
  return { ok: failed.length === 0 && list.length > 0, confidence, failed, costUsd: out.costUsd };
}

export function renderCardText(t: CardTarget, d: Draft): string {
  const head = `${t.kind} ${t.qualifiedName}${t.filePath ? ` (${t.filePath}:${t.lineStart})` : ''}`;
  return [head, d.summary, ...d.claims.map(c => `- ${c.text} [${c.file}:${c.line}]`)].filter(Boolean).join('\n');
}

// ── One card ──────────────────────────────────────────────────────────────
export async function buildOne(f: CardFacts, s: KnowledgeCardSettings, writer: string, projectId: number): Promise<KnowledgeCard | null> {
  let draft = await writeDraft(f, writer, projectId);
  let writerCost = draft.costUsd;
  let checkerCost = 0;
  let attempts = 1;
  let checkResult = 'skipped';
  let firstCheck = 'skipped';
  let confidence = draft.claims.length ? 0.7 : 0;
  if (s.checkPass && draft.claims.length) {
    let chk = await checkDraft(f, draft, s.checkerModel, projectId);
    checkerCost += chk.costUsd;
    firstCheck = chk.ok ? 'pass' : 'fail';
    if (!chk.ok && (buildIsFree(s, writer) || !capReached(s))) {
      const feedback = chk.failed.map(x => `- claim ${x.i}: ${draft.claims[x.i]?.text ?? '?'} — ${x.why}`).join('\n') || '- the checker found no supported claims';
      draft = await writeDraft(f, writer, projectId, feedback);
      writerCost += draft.costUsd;
      attempts = 2;
      if (draft.claims.length) {
        chk = await checkDraft(f, draft, s.checkerModel, projectId);
        checkerCost += chk.costUsd;
      } else chk = { ok: false, confidence: 0, failed: [], costUsd: 0 };
    }
    checkResult = chk.ok ? 'pass' : 'fail';
    confidence = chk.confidence;
  }
  if (!draft.claims.length) { checkResult = checkResult === 'skipped' ? 'empty' : checkResult; confidence = 0; }
  const t = f.target;
  return {
    rowId: cardRowId(projectId, t.nodeId, writer), nodeId: t.nodeId, projectId, kind: t.kind, name: t.name,
    qualifiedName: t.qualifiedName, filePath: t.filePath, lineStart: t.lineStart, lineEnd: t.lineEnd,
    text: renderCardText(t, draft), claims: draft.claims, links: f.links, sources: f.sources,
    writerModel: writer, checkerModel: s.checkPass ? s.checkerModel : '', builtAt: new Date().toISOString(),
    confidence, checkResult, firstCheck, attempts, writerCostUsd: writerCost, checkerCostUsd: checkerCost,
    status: checkResult === 'pass' || (checkResult === 'skipped' && draft.claims.length) ? 'fresh' : 'flagged',
    embedModel: '',
  };
}

/** Card embeddings: the direct OpenRouter code embedder on the BULK lane,
 *  else the query encoder (interactive lane) when it is not configured. */
export async function cardEncoder(): Promise<{ embedBatch(t: string[]): Promise<Float32Array[]>; getModelName(): string }> {
  try {
    const { directEmbeddingProvider } = await import('../openrouter/embeddingProvider.js');
    const { tableDimsFor } = await import('../embedding/providers/embeddingProvider.js');
    const r = await directEmbeddingProvider('code-embedding', tableDimsFor('code'));
    if (r.provider) return r.provider;
    logger.warn(`card embeddings: bulk embedder unavailable (${r.reason}); using the query encoder`);
  } catch (err) {
    logger.warn(`card embeddings: ${(err as Error).message}; using the query encoder`);
  }
  return selectQueryEmbeddingProvider('code');
}

/**
 * Embed built cards, retrying on timeouts, 429 quota errors and 5xx.
 *
 * The card text is already paid for (or written by a free sidecar), so one
 * slow or rate-limited embedding call must not end the whole build. Waits
 * 30 s, 60 s, 2 min, 4 min, then 5 min per try, for up to `maxWaitMs`
 * (default 15 min). A stop request ends the wait early. Non-transient errors
 * (4xx other than 408/429) fail at once, as before.
 */
export async function embedCardsWithRetry(
  encoder: { embedBatch(t: string[]): Promise<Float32Array[]> },
  texts: string[],
  opts: { maxWaitMs?: number; shouldStop?: () => boolean; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Float32Array[]> {
  const maxWaitMs = opts.maxWaitMs ?? 15 * 60_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await encoder.embedBatch(texts);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      const transient = /\b(408|429|5\d\d)\b|timed? ?out|timeout|quota|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed/i.test(msg);
      if (!transient) throw err;
      const delay = Math.min(30_000 * 2 ** attempt, 5 * 60_000);
      if (waited + delay > maxWaitMs || opts.shouldStop?.()) throw err;
      logger.warn(`card embeddings failed (${msg.slice(0, 160)}); retry ${attempt + 1} in ${Math.round(delay / 1000)} s`);
      await sleep(delay);
      waited += delay;
      if (opts.shouldStop?.()) throw err;
    }
  }
}

// ── Build runs ────────────────────────────────────────────────────────────
export interface BuildRun {
  projectId: number;
  writerModel: string;
  state: 'running' | 'done' | 'stopped' | 'failed';
  startedAt: string;
  finishedAt?: string;
  targets: number;
  built: number;
  failedCalls: number;
  firstCheckFails: number;
  flagged: number;
  costUsd: number;
  ms?: number;
  error?: string;
  onlyStale: boolean;
}

const runs = new Map<string, BuildRun>();
const history: BuildRun[] = [];
const stopFlags = new Set<string>();
const runKey = (p: number, w: string) => `${p}|${w}`;

export function buildRuns(): BuildRun[] {
  return [...runs.values(), ...history.slice(-30)].map(r => ({ ...r }));
}
export function stopBuild(projectId: number, writer?: string): boolean {
  let any = false;
  for (const r of runs.values()) {
    if (r.projectId === projectId && (!writer || r.writerModel === writer)) { stopFlags.add(runKey(r.projectId, r.writerModel)); any = true; }
  }
  return any;
}

/** Rough token-based cost estimate for a build, from the catalogue prices. */
export function estimateCost(targets: number, s: KnowledgeCardSettings, prices: Record<string, { in: number; out: number }>, writer = s.writerModel): number {
  const price = (m: string) => (isSidecarModelId(m) ? { in: 0, out: 0 } : prices[m] ?? { in: 0.1, out: 0.4 });
  const w = price(writer);
  const c = price(s.checkerModel);
  // Measured shape: ~2.5k prompt / ~350 completion tokens per writer call,
  // ~3k / ~250 per check, ~30% rewrites.
  const perCard = (2500 * w.in + 350 * w.out) / 1e6 * 1.3 + (s.checkPass ? (3000 * c.in + 250 * c.out) / 1e6 * 1.3 : 0);
  return Math.round(targets * perCard * 10000) / 10000;
}

export interface BuildOptions {
  writerModel?: string;
  /** Only rebuild cards that are stale/check/missing. */
  onlyStale?: boolean;
  /** Cap on cards this run (else settings.maxCardsPerProject). */
  limit?: number;
  projectName?: string;
}

export function startBuild(projectId: number, opts: BuildOptions = {}): BuildRun {
  const s = getCardSettings();
  const writer = opts.writerModel ?? s.writerModel;
  const key = runKey(projectId, writer);
  const existing = runs.get(key);
  if (existing) return { ...existing };
  if (!chatUsable(writer) || !chatUsable(s.checkerModel)) {
    throw new Error(`${chatUsable(writer) ? s.checkerModel : writer} is a batch-only model id; OpenRouter does not serve it on /chat/completions`);
  }
  const run: BuildRun = {
    projectId, writerModel: writer, state: 'running', startedAt: new Date().toISOString(), targets: 0, built: 0,
    failedCalls: 0, firstCheckFails: 0, flagged: 0, costUsd: 0, onlyStale: opts.onlyStale === true,
  };
  runs.set(key, run);
  void runBuild(run, s, opts).catch(err => {
    run.state = 'failed';
    run.error = (err as Error).message.slice(0, 300);
    logger.warn(`card build ${key} failed: ${run.error}`);
  }).finally(() => {
    run.finishedAt = new Date().toISOString();
    run.ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
    runs.delete(key);
    stopFlags.delete(key);
    history.push(run);
    if (history.length > 100) history.shift();
    clearFactFileCache();
  });
  return { ...run };
}

async function runBuild(run: BuildRun, s: KnowledgeCardSettings, opts: BuildOptions): Promise<void> {
  const { projectId, writerModel: writer } = run;
  const key = runKey(projectId, writer);
  // A sidecar container with no online host: fail the run up front rather than every card.
  await assertSidecarModelLive(writer);
  if (s.checkPass) await assertSidecarModelLive(s.checkerModel);
  const capS = { ...s, maxCardsPerProject: opts.limit ?? s.maxCardsPerProject };
  let targets = await selectTargets(projectId, capS, opts.projectName ?? `project ${projectId}`);
  if (opts.onlyStale) {
    const have = new Map((await cardsForProject(projectId, writer)).map(c => [c.nodeId, c]));
    targets = targets.filter(t => { const c = have.get(t.nodeId); return !c || c.status === 'stale' || c.status === 'check'; });
  }
  run.targets = targets.length;
  if (!targets.length) { run.state = 'done'; return; }
  const encoder = await cardEncoder();
  const BATCH = 8;
  for (let i = 0; i < targets.length; i += BATCH) {
    if (stopFlags.has(key)) { run.state = 'stopped'; break; }
    if (!buildIsFree(s, writer) && capReached(s)) { run.state = 'stopped'; run.error = `daily cap $${s.dailyCapUsd} reached`; break; }
    const facts = await gatherFacts(projectId, targets.slice(i, i + BATCH));
    const built: KnowledgeCard[] = [];
    // `concurrency` jobs in flight; each still waits for a bulk worker.
    for (let j = 0; j < facts.length; j += s.concurrency) {
      const results = await Promise.allSettled(facts.slice(j, j + s.concurrency).map(f => buildOne(f, s, writer, projectId)));
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          built.push(r.value);
          run.costUsd += r.value.writerCostUsd + r.value.checkerCostUsd;
          if (r.value.firstCheck === 'fail') run.firstCheckFails++;
          if (r.value.status === 'flagged') run.flagged++;
        } else if (r.status === 'rejected') {
          run.failedCalls++;
          run.error = String((r.reason as Error)?.message ?? r.reason).slice(0, 400);
          logger.warn(`card call failed: ${run.error}`);
        }
      }
      // Same error on every card: stop instead of burning the whole list.
      if (run.built + built.length === 0 && run.failedCalls >= 6) {
        run.state = 'failed';
        break;
      }
    }
    if (run.state === 'failed') break;
    if (built.length) {
      let vecs: Float32Array[];
      try {
        vecs = await embedCardsWithRetry(encoder, built.map(c => c.text), { shouldStop: () => stopFlags.has(key) });
      } catch (err) {
        // Keep going: these cards are lost for this run (a later "only missing"
        // build picks them up), but the rest of the project still gets built.
        run.failedCalls += built.length;
        run.error = `card embeddings failed: ${String((err as Error)?.message ?? err).slice(0, 300)}`;
        logger.warn(run.error);
        continue;
      }
      const model = encoder.getModelName();
      await upsertCards(built.map((c, k) => ({ card: { ...c, embedModel: model }, vector: vecs[k] })));
      run.built += built.length;
    }
  }
  if (run.state === 'running') run.state = 'done';
  await ensureCardTextIndex(true).catch(err => logger.warn(`card FTS build failed: ${(err as Error).message}`));
}
export { bulkChat as __bulkChatForTest };
