/**
 * LLM-written chunk context (EMBED_TEXT_VERSION 4) — the "contextual" half of
 * Anthropic's contextual retrieval. For every symbol node, a cheap chat model
 * writes 50–100 tokens that situate the symbol inside its file and pod for
 * search: what it is for, what it works with, the terms a reader would use.
 * The sentence is prepended to every chunk of the node, so it is in the vector
 * AND in the BM25 `text` column.
 *
 * Shape of the work: one request per FILE, not per node. The model gets the
 * whole file (capped) once and returns a JSON map `id → context` for the nodes
 * asked; that is the prompt-caching shape the paper relies on, without needing
 * provider-side caching. Results are cached in
 * `.cache/embed-context/<projectId>.json` keyed by node id → { hash, context }
 * where `hash` covers the node's own span + signature, so a re-embed with the
 * same source never pays again and an incremental reindex re-contextualises
 * only what changed.
 *
 * Never a hard dependency: any failure (no route, timeout, bad JSON) leaves
 * the node without a context and the v3 text is embedded as before. Enabled
 * by `semanticSearch.contextualize.enabled` (default true when
 * EMBED_TEXT_VERSION >= 4); `semanticSearch.contextualize.concurrency`
 * (default 4 files in flight), `.maxFileChars` (default 60_000).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { createLogger } from '../utils/index.js';
import { readRuntimeSemantic } from './providers/embeddingProvider.js';
import { EMBED_TEXT_VERSION, readSourceLines, type EmbeddingTextNode } from './embeddingText.js';

const logger = createLogger('embed-context');

export const CONTEXT_MAX_CHARS = 400;
const DEFAULT_MAX_FILE_CHARS = 60_000;
const DEFAULT_CONCURRENCY = 4;
/** 20 sentences × ~110 tokens ≈ 2.2k tokens of JSON; 40 overran a 4k
 *  max_tokens and the cut-off JSON parsed as nothing (30% of nodes without
 *  context in the first three projects of the 2026-09-29 run). */
const MAX_NODES_PER_REQUEST = 20;
const REPLY_MAX_TOKENS = 8192;

export interface ContextualizeSettings {
  enabled: boolean;
  concurrency: number;
  maxFileChars: number;
}

export function readContextualizeSettings(): ContextualizeSettings {
  const c = readRuntimeSemantic()?.contextualize ?? {};
  const conc = Number(c.concurrency);
  const maxFile = Number(c.maxFileChars);
  return {
    enabled: EMBED_TEXT_VERSION >= 4 && c.enabled !== false,
    concurrency: Number.isFinite(conc) && conc >= 1 ? Math.min(16, Math.floor(conc)) : DEFAULT_CONCURRENCY,
    maxFileChars: Number.isFinite(maxFile) && maxFile >= 5_000 ? maxFile : DEFAULT_MAX_FILE_CHARS,
  };
}

// ── Cache ───────────────────────────────────────────────────────────────────

interface CacheRecord { hash: string; context: string; at: string }
interface CacheFile { version: number; projects: Record<string, never>; nodes: Record<string, CacheRecord> }

function cacheDir(): string {
  return path.join(process.cwd(), '.cache', 'embed-context');
}
function cachePath(projectId: number): string {
  return path.join(cacheDir(), `${projectId}.json`);
}

export function loadContextCache(projectId: number): Map<string, CacheRecord> {
  try {
    const raw = fs.readFileSync(cachePath(projectId), 'utf-8');
    const parsed = JSON.parse(raw) as CacheFile;
    return new Map(Object.entries(parsed.nodes ?? {}));
  } catch {
    return new Map();
  }
}

export function saveContextCache(projectId: number, cache: Map<string, CacheRecord>): void {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    const p = cachePath(projectId);
    const tmp = `${p}.tmp`;
    const out: CacheFile = { version: 1, projects: {}, nodes: Object.fromEntries(cache) };
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, p);
  } catch (err) {
    logger.warn(`cache write failed for project ${projectId}: ${(err as Error).message}`);
  }
}

/** Content hash of what the context describes: the node's own span + signature + qualified name. */
export function nodeContentHash(node: EmbeddingTextNode, lines: string[] | null): string {
  const h = crypto.createHash('sha1');
  h.update(node.qualifiedName);
  h.update('\n');
  h.update(node.signature ?? '');
  h.update('\n');
  if (lines && node.lineStart && node.lineStart >= 1) {
    const end = typeof node.lineEnd === 'number' && node.lineEnd > node.lineStart ? node.lineEnd : node.lineStart + 25;
    h.update(lines.slice(node.lineStart - 1, Math.min(lines.length, end)).join('\n'));
  }
  return h.digest('hex').slice(0, 16);
}

// ── Prompt ──────────────────────────────────────────────────────────────────

export const CONTEXT_SYSTEM_PROMPT =
  'You write short retrieval context for code symbols. For each symbol asked, write ONE plain sentence of 40 to 80 words '
  + 'that situates it within its file and library for search: what it is for, what it works with or is called by, and the domain '
  + 'terms a developer would type when looking for it (include exact identifiers and tags as spelled). No preamble, no code, no markdown. '
  + 'Answer with a JSON object only: {"<id>": "<sentence>", ...} using exactly the ids given.';

export function buildContextUserPrompt(input: {
  filePath: string;
  pod?: string | null;
  fileText: string;
  nodes: Array<{ id: string; qualifiedName: string; kind: string; signature?: string | null; lineStart?: number | null; lineEnd?: number | null }>;
}): string {
  const list = input.nodes
    .map((n) => `- id ${n.id}: ${n.kind} ${n.qualifiedName}${n.signature ? ` — ${n.signature.replace(/\s+/g, ' ').trim().slice(0, 200)}` : ''}${n.lineStart ? ` (lines ${n.lineStart}${n.lineEnd && n.lineEnd > n.lineStart ? `-${n.lineEnd}` : ''})` : ''}`)
    .join('\n');
  return `File: ${input.filePath}${input.pod ? `\nLibrary/pod: ${input.pod}` : ''}\n\n<file>\n${input.fileText}\n</file>\n\nSymbols to describe (${input.nodes.length}):\n${list}\n\nReturn the JSON object now.`;
}

/**
 * Pull `{id: sentence}` out of a model reply. Tolerates prose or a fence
 * around the object AND the shapes deepseek-v4-flash actually produced on
 * 2026-09-29: one object per symbol on separate lines (`{"a": …}\n{"b": …}`),
 * a truncated tail, an unescaped quote inside a sentence. Each `"id": "…"`
 * pair is read on its own, so one bad pair costs one id, not the whole reply
 * (a whole-object JSON.parse lost 30% of nodes).
 */
export function parseContextReply(text: string, wantIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const want = new Set(wantIds);
  const take = (rawKey: string, v: string): void => {
    // The prompt lists symbols as `id <hash>`; some replies echo the prefix.
    const k = rawKey.replace(/^\s*id\s+/i, '').trim();
    if (!want.has(k) || out.has(k)) return;
    const s = v.replace(/\s+/g, ' ').trim();
    if (s.length < 20) return;
    out.set(k, s.length > CONTEXT_MAX_CHARS ? s.slice(0, CONTEXT_MAX_CHARS) : s);
  };
  // 1. Every well-formed pair, wherever it sits.
  const pair = /"([^"\\]{1,200})"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  for (const m of text.matchAll(pair)) {
    let v = m[2];
    try { v = JSON.parse(`"${v}"`); } catch { v = v.replace(/\\"/g, '"').replace(/\\n/g, ' '); }
    take(m[1], v);
  }
  // 2. Pairs whose closing quote never came (cut off by max_tokens, or an
  //    unescaped quote broke the regex above): take the text up to the next
  //    `"key":` — any key, so a short well-formed neighbour is never swallowed
  //    — or to the end.
  if (out.size < want.size) {
    for (const id of wantIds) {
      if (out.has(id)) continue;
      const hit = new RegExp(`"(?:id\\s+)?${id}"`).exec(text);
      if (!hit) continue;
      const rest = text.slice(hit.index + hit[0].length).replace(/^\s*:\s*"?/, '');
      const stop = rest.search(/"\s*,?\s*\}?\s*\n?\s*\{?\s*"[^"\n]{1,200}"\s*:/);
      const v = (stop >= 0 ? rest.slice(0, stop) : rest).replace(/["}\s]+$/, '');
      take(id, v);
    }
  }
  return out;
}

// ── Driver ──────────────────────────────────────────────────────────────────

export interface ContextualizeStats {
  nodes: number;
  cached: number;
  requested: number;
  written: number;
  files: number;
  requests: number;
  failed: number;
  costUsd: number;
  ms: number;
}

export type ContextChat = (system: string, user: string) => Promise<{ text: string; costUsd: number | null }>;

async function defaultChat(system: string, user: string): Promise<{ text: string; costUsd: number | null }> {
  const { openRouterChat } = await import('../sidecars/openRouterChat.js');
  const out = await openRouterChat(system, user, { maxTokens: REPLY_MAX_TOKENS, timeoutMs: 120_000, temperature: 0.1, role: 'rlm-sandbox' });
  return { text: out.text, costUsd: out.costUsd };
}

/**
 * Contexts for `nodes` of `projectId`: cache hits first, one model request per
 * file for the rest. Returns nodeId → context for every node that has one.
 * `opts.chat` is injectable for tests.
 */
export async function contextualizeNodes(
  projectId: number,
  nodes: Array<EmbeddingTextNode & { id: string }>,
  opts: { chat?: ContextChat; pod?: string | null; onProgress?: (s: ContextualizeStats) => void } = {},
): Promise<{ contexts: Map<string, string>; stats: ContextualizeStats }> {
  const t0 = Date.now();
  const settings = readContextualizeSettings();
  const stats: ContextualizeStats = { nodes: nodes.length, cached: 0, requested: 0, written: 0, files: 0, requests: 0, failed: 0, costUsd: 0, ms: 0 };
  const contexts = new Map<string, string>();
  if (!settings.enabled || nodes.length === 0) { stats.ms = Date.now() - t0; return { contexts, stats }; }

  const cache = loadContextCache(projectId);
  const byFile = new Map<string, Array<EmbeddingTextNode & { id: string; hash: string }>>();
  for (const n of nodes) {
    if (!n.filePath) continue;
    const lines = readSourceLines(n.filePath);
    const hash = nodeContentHash(n, lines);
    const hit = cache.get(n.id);
    if (hit && hit.hash === hash && hit.context) {
      contexts.set(n.id, hit.context);
      stats.cached++;
      continue;
    }
    const arr = byFile.get(n.filePath) ?? [];
    arr.push({ ...n, hash });
    byFile.set(n.filePath, arr);
  }
  stats.requested = [...byFile.values()].reduce((s, a) => s + a.length, 0);
  stats.files = byFile.size;
  if (stats.requested === 0) { stats.ms = Date.now() - t0; return { contexts, stats }; }

  const chat = opts.chat ?? defaultChat;
  const files = [...byFile.entries()];
  let cursor = 0;
  let dirty = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= files.length) return;
      const [filePath, fileNodes] = files[i];
      const lines = readSourceLines(filePath);
      let fileText = lines ? lines.join('\n') : '';
      if (fileText.length > settings.maxFileChars) fileText = fileText.slice(0, settings.maxFileChars) + '\n… (truncated)';
      // One request per group; the ids the reply left out get ONE more
      // request on their own. A reply that parses to nothing is logged with
      // its head — that is the only way a truncated or mis-shaped JSON shows.
      const ask = async (group: typeof fileNodes): Promise<Map<string, string>> => {
        const user = buildContextUserPrompt({
          filePath,
          pod: opts.pod,
          fileText,
          nodes: group.map((n) => ({ id: n.id, qualifiedName: n.qualifiedName, kind: n.nodeType ?? 'symbol', signature: n.signature, lineStart: n.lineStart, lineEnd: n.lineEnd })),
        });
        stats.requests++;
        const reply = await chat(CONTEXT_SYSTEM_PROMPT, user);
        if (typeof reply.costUsd === 'number') stats.costUsd += reply.costUsd;
        const got = parseContextReply(reply.text, group.map((n) => n.id));
        if (got.size === 0) {
          logger.warn(`project ${projectId} ${path.basename(filePath)}: reply had none of the ${group.length} ids (len=${reply.text.length}): ${reply.text.replace(/\s+/g, ' ').slice(0, 140)}`);
        }
        return got;
      };
      for (let j = 0; j < fileNodes.length; j += MAX_NODES_PER_REQUEST) {
        const group = fileNodes.slice(j, j + MAX_NODES_PER_REQUEST);
        try {
          const got = await ask(group);
          const missing = group.filter((n) => !got.has(n.id));
          if (missing.length > 0) {
            try { for (const [k, v] of await ask(missing)) got.set(k, v); }
            catch (err) { logger.warn(`project ${projectId} ${path.basename(filePath)}: retry for ${missing.length} id(s) failed: ${(err as Error).message.split('\n')[0].slice(0, 120)}`); }
          }
          const now = new Date().toISOString();
          for (const n of group) {
            const ctx = got.get(n.id);
            if (!ctx) { stats.failed++; continue; }
            contexts.set(n.id, ctx);
            cache.set(n.id, { hash: n.hash, context: ctx, at: now });
            stats.written++;
            dirty++;
          }
          if (dirty >= 200) { saveContextCache(projectId, cache); dirty = 0; }
        } catch (err) {
          stats.failed += group.length;
          logger.warn(`project ${projectId} ${path.basename(filePath)}: ${(err as Error).message.split('\n')[0].slice(0, 160)} — ${group.length} node(s) embed without context`);
        }
        opts.onProgress?.(stats);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(settings.concurrency, files.length) }, worker));
  if (dirty > 0) saveContextCache(projectId, cache);
  stats.ms = Date.now() - t0;
  logger.info(
    `project ${projectId}: ${stats.written} context(s) written, ${stats.cached} cached, ${stats.failed} without, `
    + `${stats.requests} request(s) over ${stats.files} file(s), $${stats.costUsd.toFixed(4)}, ${(stats.ms / 1000).toFixed(1)}s`,
  );
  return { contexts, stats };
}

/**
 * Merge LLM contexts into the graph-context map buildEmbeddingItems consumes:
 * the LLM sentence goes first (it carries the search terms), the graph line
 * after it. A node with neither keeps no context line.
 */
export function mergeContexts(graph: Map<string, string>, llm: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  const ids = new Set([...graph.keys(), ...llm.keys()]);
  for (const id of ids) {
    const l = llm.get(id);
    const g = graph.get(id);
    out.set(id, [l ? `about: ${l}` : null, g].filter(Boolean).join('\n'));
  }
  return out;
}
