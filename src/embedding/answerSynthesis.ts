/**
 * RLM code Q&A (v1) — grounded, cited answer synthesis over the retrieval +
 * change-history stack.
 *
 * Reranked-RAG, NOT an agentic loop: a single LLM synthesis call over a
 * context block assembled from semantic search (with graph context) and,
 * for temporal questions, symbol change history.
 *
 * Provider is configurable (groq | anthropic | gemini | sidecar). Cloud
 * providers fall back to the sidecar (qwen3.5:9b) when their API key is
 * missing or the call throws — the returned `provider`/`model` reflect what
 * actually ran.
 */

import type { RerankMode } from './hybridSearch.js';
import { emitAskEvent } from './askEvents.js';
import * as fs from 'fs';
import * as path from 'path';
import { getSemanticSearchService } from './semanticSearchService.js';
import type { SemanticSearchResult } from './semanticSearchService.js';
import { getPrismaClient } from '../db/prisma.js';
import { loadConfig } from '../config/index.js';
import { getProjectScope } from '../fantom/projectDependencies.js';
import type { ScopeProject } from '../fantom/projectDependencies.js';
import type { RlmToolSpec } from './rlmToolLoop.js';
import { readRuntimeSemantic } from './providers/embeddingProvider.js';

/** Read the source snippet for a retrieved symbol so the model can explain the
 *  actual logic, not just the signature. Best-effort; bounded. */
const SNIPPET_FILE_CACHE_MAX = 64;
const snippetFileCache = new Map<string, { mtimeMs: number; lines: string[] }>();
/** Lines of a source file, cached by path+mtime. One RLM round formats ~30
 *  hits, several from the same 5,000-line .vue; re-reading and re-splitting
 *  each time was measurable. */
function fileLinesCached(filePath: string): string[] {
  const st = fs.statSync(filePath);
  const hit = snippetFileCache.get(filePath);
  if (hit && hit.mtimeMs === st.mtimeMs) {
    snippetFileCache.delete(filePath); snippetFileCache.set(filePath, hit);
    return hit.lines;
  }
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  snippetFileCache.set(filePath, { mtimeMs: st.mtimeMs, lines });
  while (snippetFileCache.size > SNIPPET_FILE_CACHE_MAX) {
    snippetFileCache.delete(snippetFileCache.keys().next().value as string);
  }
  return lines;
}

function readSourceSnippet(filePath: string, lineStart: number, maxLines = 35, maxChars = 1400): string {
  try {
    if (!filePath || !lineStart || lineStart < 1) return '';
    const allLines = fileLinesCached(filePath);
    const start = Math.max(0, lineStart - 1);
    let body = allLines.slice(start, start + maxLines).join('\n');
    if (body.length > maxChars) body = body.slice(0, maxChars) + '\n…';
    return body;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// RLM tool-use loop — tool specs the RLM can call to gather evidence, and the
// executors that run them. The specs are static; the executors are built as a
// closure inside answerCodeQuestion so they can capture runtime context
// (projectId, cross-encoder reranker config, prisma client).
// ---------------------------------------------------------------------------

/** search_code — semantic code search (vector → graph enrich → cross-encoder). */
const RLM_SEARCH_CODE_TOOL: RlmToolSpec = {
  type: 'function',
  function: {
    name: 'search_code',
    description:
      'Semantic code search over the indexed codebase. Returns the most relevant ' +
      'functions/types with their signature, file:line, and a source snippet. ' +
      'Pass ONE short focused concept per call and issue several calls for several ' +
      'concepts — short concept queries rank the right code far higher than a full ' +
      'sentence.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'A SHORT focused concept phrase, 2–5 content words (e.g. "load from sax", ' +
            '"parse component xml"). Do NOT pass the full question, and do NOT use "A or B" ' +
            'disjunctions — split those into separate calls. For a literal identifier or a ' +
            'token with punctuation (e.g. "loadFromSax", "app.sax") use search_symbols instead.',
        },
        // NOTE: no projectId — the search is automatically scoped to the asked
        // project. (The model used to hallucinate projectId:1, which silently
        // sent every search to the wrong project; the param is removed so it
        // can't, and the executor ignores any value anyway.)
      },
      required: ['query'],
    },
  },
};

/** project_overview — project metadata, most-called functions, top types, README. */
const RLM_PROJECT_OVERVIEW_TOOL: RlmToolSpec = {
  type: 'function',
  function: {
    name: 'project_overview',
    description:
      'High-level overview of a project: name/language/pod, function & type counts, ' +
      'the most-called functions, a sample of top-level types, and the project README ' +
      'or build file. Use for orientation before diving into specific code. ' +
      'Automatically summarizes the asked project — takes no arguments.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
};

/** search_symbols — keyword/identifier (FlexSearch) exact matching. Catches
 *  exact names that semantic search ranks too low (e.g. a function literally
 *  named `loadFromSax`, or "app.sax"). */
const RLM_SEARCH_SYMBOLS_TOOL: RlmToolSpec = {
  type: 'function',
  function: {
    name: 'search_symbols',
    description:
      'Keyword/identifier search (exact-ish name matching) over indexed functions & types. ' +
      'Use this when you know a likely identifier or literal term and semantic search missed it ' +
      '— e.g. a function name like "loadFromSax", or a term like "app.sax" / "parseSax".',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Identifier or keyword to match (e.g. "loadFromSax").' },
        // No projectId — auto-scoped to the asked project (see search_code).
      },
      required: ['query'],
    },
  },
};

/** search_files — file-path substring search over the indexed files of the
 *  asked project and its dependency scope, returning each file with the
 *  symbols it defines. Bridges the gap where a library/directory word from the
 *  question ("rete") appears in a PATH but in no symbol name or body. */
const RLM_SEARCH_FILES_TOOL: RlmToolSpec = {
  type: 'function',
  function: {
    name: 'search_files',
    description:
      'Find indexed files whose path contains a word (library, directory or file name, e.g. ' +
      '"rete", "sox", "types.ts") and list the functions/types each file defines. Use it when ' +
      'the question names a library, framework, folder or file, or when search_symbols finds ' +
      'nothing for a word that is probably a directory or package name.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Bare word or path fragment to match against file paths (e.g. "rete").' },
      },
      required: ['query'],
    },
  },
};

export const RLM_TOOLS: RlmToolSpec[] = [RLM_SEARCH_CODE_TOOL, RLM_SEARCH_SYMBOLS_TOOL, RLM_SEARCH_FILES_TOOL, RLM_PROJECT_OVERVIEW_TOOL];

const SEARCH_FILES_MAX_FILES = 8;
const SEARCH_FILES_MAX_SYMBOLS = 12;

/** Format one semantic-search hit the way the RLM (and Groq) sees it. */
function formatHitForRlm(r: SemanticSearchResult): string {
  const snippet = readSourceSnippet(r.filePath, r.lineStart);
  return (
    `${r.qualifiedName} (${r.nodeType}) ${r.filePath}:${r.lineStart}\n` +
    `  sig: ${r.signature ?? '(none)'}\n` +
    (snippet ? `  source:\n${snippet.split('\n').map((l) => '    ' + l).join('\n')}` : '  source: (unavailable)')
  );
}

/**
 * Build the executeTool dispatcher the RLM loop calls each time it issues a
 * tool call. Captures runtime context so the static specs stay context-free.
 * IMPORTANT (memory bound): search_code always passes a projectId when the ask
 * provided one — cross-project Kuzu enrichment OOMs the box.
 */
/**
 * Related projects of the asked project — its persisted dependencies AND
 * dependents from `project_dependencies` (build.fan depends, package.json,
 * cross-project call edges, workspace siblings, manual), see
 * src/fantom/projectDependencies.ts. A frontend and its backend are usually
 * indexed as two projects (e.g. …/swe/sedonaWebEditor and
 * …/swe/bassgSoxWebSocket); a question scoped to one often needs the other —
 * "what is retejs mapping sedona state?" asked on the Fantom backend found zero
 * hits for `retejs`, which lives in the Vue sibling. Related projects are always
 * part of the search scope (capped, every search still project-scoped); the
 * primary project's hits stay first and related hits are tagged by project.
 * When the table has no rows for the project yet, getProjectScope falls back to
 * same-parent-directory siblings so behaviour never regresses.
 */
type WorkspaceSibling = ScopeProject;
async function getRelatedProjects(projectId: number | undefined, maxProjects?: number): Promise<WorkspaceSibling[]> {
  if (typeof projectId !== 'number') return [];
  try {
    const scope = await getProjectScope(projectId, { maxProjects });
    return scope?.related ?? [];
  } catch {
    return [];
  }
}

/** Structured scope for the PLAN prompt (T2): one line per project with
 *  language, link kind, direction and libraries, so the planner can send a
 *  library-specific sub-question to the project that lists that library. */
function buildScopeNote(primaryName: string, primaryLanguage: string, related: ScopeProject[]): string {
  const lines = [`- primary: "${primaryName}" (${primaryLanguage})`];
  for (const p of related) {
    const rel = p.direction === 'dependent' ? 'depends on the primary' : 'the primary depends on it';
    const libs = p.libraries.length ? `; libs: ${p.libraries.slice(0, 8).join(', ')}` : '';
    const summary = p.summary ? `; ${p.summary.slice(0, 120)}` : '';
    lines.push(`- related: "${p.name}" (${p.language}; ${p.kinds.join('+')}; ${rel}${libs}${summary})`);
  }
  return lines.join('\n');
}

/**
 * Deterministic sub-questions for libraries named in the question. "What is
 * retejs mapping sedona state?" names the `rete` package that only the Vue
 * project lists; the 8B planner routinely ignores it, so when a question token
 * (with a trailing "js"/".js" stripped) equals a scope project's library or
 * name, search_files + search_symbols for that token are added to the plan.
 */
function libraryScopeSubQuestions(question: string, related: ScopeProject[]): Array<{ question: string; tool: 'search_files' | 'search_symbols'; query: string }> {
  const norm = (t: string): string => t.toLowerCase().replace(/[^a-z0-9@/._-]/g, '').replace(/[.-]?js$/, '');
  const tokens = new Set(question.split(/\s+/).map(norm).filter((t) => t.length >= 3));
  const out: Array<{ question: string; tool: 'search_files' | 'search_symbols'; query: string }> = [];
  const seen = new Set<string>();
  for (const p of related) {
    const names = [...p.libraries, p.name];
    for (const lib of names) {
      const key = norm(lib);
      // "rete-vue-plugin" → also match its head "rete".
      const head = key.split(/[-/@]/).filter(Boolean)[0] ?? key;
      const hit = tokens.has(key) ? key : tokens.has(head) ? head : null;
      if (!hit || seen.has(hit)) continue;
      seen.add(hit);
      out.push({ question: `Which files of "${p.name}" belong to ${hit}, and what do they define?`, tool: 'search_files', query: hit });
      out.push({ question: `Which symbols mention ${hit}?`, tool: 'search_symbols', query: hit });
    }
  }
  return out.slice(0, 4);
}

/** Caps for promoting RLM-found code to numbered context (keeps the synthesis
 *  prompt bounded even after a wide gather). */
const RLM_PROMOTE_MAX_ITEMS = 12;
const RLM_PROMOTE_MAX_CHARS = 10000;

function describeScopeProject(p: ScopeProject): string {
  const rel = p.direction === 'dependent' ? 'depends on this project' : 'this project depends on it';
  const kind = p.kinds.join('+');
  const libs = p.libraries.length ? `; libs: ${p.libraries.slice(0, 6).join(', ')}` : '';
  return `"${p.name}" (${p.language}, ${kind}, ${rel}${libs})`;
}

/**
 * Exported so the ss-rlm-sandbox HTTP tool routes can reuse the SAME retrieval
 * the in-process RLM loop uses. The sandbox runs in a container and cannot
 * hold a host callable, so its Python tools POST to /api/rlm-tools/* — which
 * must dispatch through this, not a second implementation that would drift.
 */
export function buildRlmExecutor(ctx: {
  projectId?: number;
  siblings?: WorkspaceSibling[];
  crossEncoderReranker: unknown;
  /** 'off' disables the cross-encoder pass on the RLM's own searches. */
  rerank?: RerankMode;
  /** Receives every hit a tool returned so the caller can promote RLM-found
   *  code to numbered, citable context items (T1: citable RLM evidence). */
  collect?: (hit: RlmFoundHit) => void;
}): (name: string, args: Record<string, unknown>) => Promise<string> {
  const collectSemantic = (h: SemanticSearchResult, project?: string): void => {
    ctx.collect?.({ nodeId: h.nodeId, qualifiedName: h.qualifiedName, nodeType: h.nodeType, filePath: h.filePath, lineStart: h.lineStart, signature: h.signature, project });
  };
  return async (name, args): Promise<string> => {
    if (name === 'search_code') {
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query) return 'search_code error: missing "query" argument.';
      // ALWAYS use the asked project; never a model-supplied projectId. The RLM
      // (an 8B fine-tune) routinely hallucinated projectId:1 even with the param
      // removed from the schema (the fallback parser can still surface one), and
      // honoring it silently sent every search to the wrong project — the
      // dominant cause of the RLM "finding nothing". `args` is intentionally
      // ignored for scoping.
      const pid = ctx.projectId;
      try {
        const svc = getSemanticSearchService(getPrismaClient());
        // No per-hit related-node queries (formatHitForRlm never reads
        // relatedNodes) and a 16-doc rerank: the RLM sees 8 hits, and three
        // concurrent 50-doc reranks measured 1.7 / 4.7 / 6.2s on the cloud path.
        const hits = await svc.search(query, {
          projectId: pid,
          limit: 8,
          includeGraphContext: false,
          crossEncoderReranker: { ...((ctx.crossEncoderReranker as Record<string, unknown> | undefined) ?? {}), topK: 16 } as any,
          rerank: ctx.rerank,
        });
        const out: string[] = hits.map(formatHitForRlm);
        for (const h of hits) collectSemantic(h);
        if (ctx.siblings?.length) {
          const widened: string[] = [];
          // Legs are independent: run them together, and skip the
          // cross-encoder — a 5-hit widening set does not justify a 50-doc
          // rerank round-trip per sibling (it logged "changed 0 positions"
          // nearly every time and was a third of a 51s tool call). The
          // primary project's results above are still reranked.
          const legs = await Promise.all(ctx.siblings.map(async (sib) => {
            try {
              const more = await svc.search(query, { projectId: sib.id, limit: 5, includeGraphContext: false, crossEncoderReranker: ctx.crossEncoderReranker as any, rerank: 'off' });
              return { sib, more };
            } catch { return { sib, more: [] as SemanticSearchResult[] }; }
          }));
          for (const { sib, more } of legs) {
            for (const h of more) {
              widened.push(`[project: ${sib.name}]\n${formatHitForRlm(h)}`);
              collectSemantic(h, sib.name);
            }
          }
          if (widened.length) {
            console.log(`[RLM] search_code("${query}") widened to workspace siblings: +${widened.length} hits from ${ctx.siblings.map(x => x.name).join(', ')}`);
            out.push(`--- results from workspace sibling projects (${ctx.siblings.map(x => x.name).join(', ')}) ---`, ...widened);
          }
        }
        if (out.length === 0) return `search_code: no results for "${query}".`;
        return out.join('\n\n');
      } catch (err) {
        return `search_code failed: ${(err as Error).message}`;
      }
    }

    if (name === 'search_symbols') {
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query) return 'search_symbols error: missing "query" argument.';
      // Always the asked project; ignore any model-supplied projectId (see search_code).
      const pid = ctx.projectId;
      try {
        const { getFantomFunctionSearchIndex } = await import('../fantom-code/searchIndex.js');
        let hits = getFantomFunctionSearchIndex().search(query, { limit: 10, projectId: pid });
        const tagged = new Map<unknown, string>();
        if (ctx.siblings?.length) {
          for (const sib of ctx.siblings) {
            const more = getFantomFunctionSearchIndex().search(query, { limit: 6, projectId: sib.id });
            for (const h of more) tagged.set(h, sib.name);
            hits = hits.concat(more);
          }
          if (tagged.size) console.log(`[RLM] search_symbols("${query}") widened to workspace siblings: +${tagged.size} hits`);
        }
        if (hits.length === 0) return `search_symbols: no keyword matches for "${query}".`;
        return hits
          .map((h) => {
            const projTag = tagged.has(h) ? `[project: ${tagged.get(h)}] ` : '';
            const f = h.function as { id?: string; qualifiedName?: string; filePath?: string; lineStart?: number; signature?: string; type?: string };
            const fp = f.filePath ?? '';
            const ls = f.lineStart ?? 0;
            const snip = fp && ls ? readSourceSnippet(fp, ls) : '';
            if (fp && ls) {
              ctx.collect?.({ nodeId: f.id ?? `${fp}:${ls}`, qualifiedName: f.qualifiedName ?? '(unknown)', nodeType: f.type ?? 'symbol', filePath: fp, lineStart: ls, signature: f.signature, project: tagged.get(h) });
            }
            return (
              `${projTag}${f.qualifiedName ?? '(unknown)'} ${fp}:${ls}\n  sig: ${f.signature ?? '(none)'}` +
              (snip ? `\n  source:\n${snip.split('\n').map((l) => '    ' + l).join('\n')}` : '')
            );
          })
          .join('\n\n');
      } catch (err) {
        return `search_symbols failed: ${(err as Error).message}`;
      }
    }

    if (name === 'search_files') {
      const raw = typeof args.query === 'string' ? args.query : typeof args.pattern === 'string' ? args.pattern : '';
      // Normalise "rete.js" / "retejs" / "Rete" → "rete"; keep path fragments as typed.
      const query = raw.trim().replace(/[.-]?js$/i, '').replace(/^\.\//, '');
      if (!query) return 'search_files error: missing "query" argument.';
      const pid = ctx.projectId;
      if (typeof pid !== 'number') return 'search_files error: no project in scope for this ask.';
      try {
        const prisma = getPrismaClient();
        const projectIds = [pid, ...(ctx.siblings ?? []).map((s) => s.id)];
        const projects = await prisma.fantomProject.findMany({ where: { id: { in: projectIds } }, select: { id: true, name: true, path: true } });
        const byId = new Map(projects.map((p) => [p.id, p]));
        // Primary project first, then scope projects; SQLite LIKE is case-insensitive.
        const files = await prisma.indexedFile.findMany({
          where: { projectId: { in: projectIds }, filePath: { contains: query } },
          select: { projectId: true, filePath: true, symbolCount: true },
          orderBy: [{ symbolCount: 'desc' }],
          take: SEARCH_FILES_MAX_FILES * 3,
        });
        files.sort((a, b) => (a.projectId === pid ? 0 : 1) - (b.projectId === pid ? 0 : 1) || (b.symbolCount ?? 0) - (a.symbolCount ?? 0));
        const chosen = files.slice(0, SEARCH_FILES_MAX_FILES);
        if (chosen.length === 0) return `search_files: no indexed file path contains "${query}" in the projects in scope.`;
        const { listFunctionsInFile } = await import('../fantom-code/fileSymbols.js');
        const out: string[] = [];
        let collected = 0;
        for (const f of chosen) {
          const proj = byId.get(f.projectId);
          const rel = proj?.path && f.filePath.startsWith(proj.path) ? f.filePath.slice(proj.path.length).replace(/^[\\/]/, '') : f.filePath;
          const tag = f.projectId !== pid && proj ? `[project: ${proj.name}] ` : '';
          let symLines: string[] = [];
          try {
            const res = await listFunctionsInFile(prisma, { filePath: f.filePath, projectId: f.projectId, limit: SEARCH_FILES_MAX_SYMBOLS });
            symLines = res.symbols.map((s) => {
              if (s.lineStart) {
                ctx.collect?.({ nodeId: s.id, qualifiedName: s.qualifiedName, nodeType: s.nodeType, filePath: f.filePath, lineStart: s.lineStart, signature: s.signature, project: f.projectId !== pid ? proj?.name : undefined });
                collected++;
              }
              return `    ${s.qualifiedName} (${s.nodeType})${s.lineStart ? ` :${s.lineStart}` : ''}${s.signature ? ` — ${s.signature.slice(0, 100)}` : ''}`;
            });
            if (res.total > res.symbols.length) symLines.push(`    … ${res.total - res.symbols.length} more symbols`);
          } catch (err) {
            symLines = [`    (symbols unavailable: ${(err as Error).message})`];
          }
          out.push(`${tag}${rel} (${f.symbolCount ?? symLines.length} symbols)\n${symLines.join('\n') || '    (no symbols indexed)'}`);
        }
        console.log(`[RLM] search_files("${query}") → ${chosen.length} files (${files.length} matched), ${collected} symbols across ${projectIds.length} projects`);
        return out.join('\n\n');
      } catch (err) {
        return `search_files failed: ${(err as Error).message}`;
      }
    }

    if (name === 'project_overview') {
      // Always the asked project; ignore any model-supplied projectId (see search_code).
      const pid = ctx.projectId;
      if (typeof pid !== 'number') return 'project_overview error: no project in scope for this ask.';
      try {
        return await buildProjectOverview(pid);
      } catch (err) {
        return `project_overview failed: ${(err as Error).message}`;
      }
    }

    return `Unknown tool: ${name}`;
  };
}

/** Assemble the project_overview tool result: metadata + hot functions + README. */
async function buildProjectOverview(projectId: number): Promise<string> {
  const { FantomDatabase } = await import('../fantom/database.js');
  const { ladybugQuery } = await import('../graph/ladybugConnection.js');

  const db = new FantomDatabase();
  const project = await db.getProjectById(projectId);
  if (!project) return `project_overview: no project with id ${projectId}.`;

  const lines: string[] = [];
  lines.push(`Project: ${project.name} (id=${project.id})`);
  lines.push(
    `  language=${project.language ?? 'unknown'} pod=${project.podName ?? '(none)'} ` +
      `functions=${project.functionCount} types=${project.typeCount}`,
  );
  lines.push(`  path: ${project.path}`);

  // Top ~15 most-called functions in this project (per-project graph DB).
  try {
    const hot = await ladybugQuery<{ qn: string; fp: string; callers: number }>(
      projectId,
      `MATCH (c:CodeNode)-[e:CodeEdge]->(t:CodeNode {project_id: ${projectId}}) ` +
        `WHERE e.edge_type='calls' ` +
        `RETURN t.qualified_name AS qn, t.file_path AS fp, count(c) AS callers ` +
        `ORDER BY callers DESC LIMIT 15`,
    );
    if (hot.length > 0) {
      lines.push('', 'Most-called functions:');
      for (const h of hot) lines.push(`  ${h.callers}× ${h.qn} (${h.fp})`);
    }
  } catch (err) {
    lines.push('', `(most-called functions unavailable: ${(err as Error).message})`);
  }

  // A few top-level types for orientation.
  try {
    const types = await ladybugQuery<{ qn: string; fp: string }>(
      projectId,
      `MATCH (t:CodeNode {project_id: ${projectId}}) ` +
        `WHERE t.node_type='class' OR t.node_type='mixin' OR t.node_type='enum' ` +
        `OR t.node_type='facet' OR t.node_type='type' ` +
        `RETURN t.qualified_name AS qn, t.file_path AS fp LIMIT 10`,
    );
    if (types.length > 0) {
      lines.push('', 'Top-level types:');
      for (const t of types) lines.push(`  ${t.qn} (${t.fp})`);
    }
  } catch {
    /* best-effort */
  }

  // README / build file from disk (first that exists, truncated).
  const candidates = ['README.md', 'package.json', 'build.fan'];
  for (const fname of candidates) {
    try {
      const fpath = path.join(project.path, fname);
      if (fs.existsSync(fpath)) {
        let body = fs.readFileSync(fpath, 'utf-8');
        if (body.length > 1500) body = body.slice(0, 1500) + '\n…';
        lines.push('', `${fname}:`, body);
        break;
      }
    } catch {
      /* skip unreadable */
    }
  }

  return lines.join('\n');
}

export type AnswerProvider = 'groq' | 'anthropic' | 'gemini' | 'sidecar' | 'openrouter';
/** 'auto' = let the server pick the model by query complexity. */
export type AnswerProviderSetting = AnswerProvider | 'auto';

/**
 * Whole-request budget, in ms.
 *
 * This answer is consumed by an MCP client, and an MCP client gives up at a
 * fixed timeout — commonly 60s. A staged pipeline that budgets each stage
 * separately blows through that: the RLM alone was set to 60s, and synthesis
 * ran AFTER it, so a slow question could spend 60s investigating and then be
 * killed mid-sentence with nothing to show. From the caller's side that is
 * indistinguishable from a hang.
 *
 * So there is ONE budget for the request and the stages spend from it in
 * order. Each checks what is left before starting and degrades instead of
 * overrunning: no time for the RLM means answer from search results alone, no
 * time for synthesis means return the RLM draft. A shorter answer beats a
 * timeout, because a timeout returns nothing at all.
 *
 * The default was 45s, sized against "a 60s MCP client timeout" — a premise I
 * never verified and which turned out to be wrong: Claude Code's
 * MCP_TOOL_TIMEOUT is effectively unlimited unless a per-server "timeout" is
 * set in .mcp.json. So the MCP path was being squeezed to fit a limit that
 * did not exist, and hard questions paid for it. 120s now, still configurable
 * via semanticSearch.answerSynthesis.budgetMs; the UI keeps its own short
 * budget because a person is watching that one. Deployments that DO set a
 * client timeout should set this below it.
 */
export const DEFAULT_ANSWER_BUDGET_MS = 120_000;
/**
 * Never start the RLM with less than this left.
 *
 * Was 9s, which was measured to be worse than skipping: a run given 11.9s came
 * back `planned=0 rounds=0 toolCalls=0` after 13.6s — the PLAN call alone
 * consumed the slice, so the stage returned no evidence AND overran, taking
 * time from the synthesis that then had to answer without it.
 *
 * A useful run needs the plan (~6-8s through the proxy) plus at least one
 * round of tool calls and a gather. 20s is the point where it starts paying
 * for itself; below that the honest move is to skip and spend the time
 * answering from retrieval, which is what the caller gets either way.
 */
const MIN_RLM_MS = 20_000;
/** Always keep this much for the final pass, so the answer is cited prose. */
const SYNTHESIS_RESERVE_MS = 14_000;
/**
 * Slack for the RLM overrunning its slice.
 *
 * runRlmGather checks the clock BETWEEN turns, so a turn starting just inside
 * the deadline still runs to completion — measured at 26.4s against a 21s
 * deadline. Asking for less than we can afford absorbs that, instead of the
 * overrun eating the synthesis reserve and pushing the whole answer past the
 * caller's timeout.
 */
const RLM_OVERRUN_SLACK_MS = 6_000;

export interface AnswerCodeQuestionOptions {
  projectId?: number;
  provider?: AnswerProviderSetting;
  model?: string;
  topK?: number;
  includeHistory?: boolean;
  maxContextChars?: number;
  /** Whole-request budget. See DEFAULT_ANSWER_BUDGET_MS. */
  budgetMs?: number;
  /**
   * Stage progress, for callers that can show it — the MCP tool forwards these
   * as `notifications/progress` so a client sees "retrieving…", "investigating
   * (round 2)…", "synthesizing…" instead of a silent wait. Feedback, not a
   * keepalive: it does not extend any client timeout.
   */
  onProgress?: (p: { stage: 'retrieving' | 'investigating' | 'synthesizing' | 'done'; message: string; progress: number; total: number }) => void;
  /**
   * Skip the RLM gather stage.
   *
   * The two readers of this function want opposite things. An MCP server will
   * wait 45s for a deeply-investigated answer and has a hard client timeout to
   * respect. A person watching a spinner will not wait 45s for anything, and
   * the RLM is most of that time.
   *
   * So the UI asks for `fast` and gets retrieval + synthesis in ~15s; the MCP
   * tool takes the default and keeps the RLM evidence that produces the
   * "found by RLM" citations. Same endpoint, same code path, one flag.
   */
  fast?: boolean;
  /**
   * Run the RLM investigation loop (tool calls over search + graph) before
   * synthesis. Default `!fast`. An explicit `true` also lifts the fast budget:
   * a multi-round tool loop cannot fit in 20s and pretending otherwise just
   * skips it.
   */
  rlm?: boolean;
  /**
   * Cross-encoder rerank of every retrieval (primary, siblings, RLM tool
   * calls). Default true — the routing policy decides local GPU vs OpenRouter.
   * `false` keeps the fused vector+keyword order.
   */
  rerank?: boolean;
  /**
   * Publish a live "thinking" feed under this id (see askEvents.ts): stage
   * changes, the RLM's plan, every question it asks and what came back. The
   * dashboard polls it; without an id nothing is recorded.
   */
  askId?: string;
}

/** Budget for an interactive ask — a person is watching this one. */
export const FAST_ANSWER_BUDGET_MS = 20_000;

export interface AnswerCitation {
  nodeId: string;
  qualifiedName: string;
  filePath: string;
  lineStart: number;
  /** Project the item belongs to when it came from a related (dependency) project. */
  project?: string;
  /** 'seed' = semantic-search hit in the initial context; 'rlm' = found by the
   *  investigation model's tool calls and promoted to a numbered context item. */
  via?: 'seed' | 'rlm';
}

/** A code location the RLM surfaced through search_code / search_symbols. */
interface RlmFoundHit {
  nodeId: string;
  qualifiedName: string;
  nodeType: string;
  filePath: string;
  lineStart: number;
  signature?: string | null;
  project?: string;
}

function hitKey(h: { filePath: string; lineStart: number }): string {
  return `${h.filePath}:${h.lineStart}`;
}

export interface AskTimings {
  retrievalMs: number;
  rlmMs: number;
  synthesisMs: number;
  totalMs: number;
  budgetMs: number;
  fast: boolean;
  /** Stage switches this run used, so the UI can say "no RLM" honestly. */
  rlm: boolean;
  rerank: boolean;
  /** ms past the budget — 0 when it held. The synthesis floor may carry a run
   *  a few seconds over on purpose; this is the honest figure for it. */
  overBudget: number;
}

export interface AnswerCodeQuestionResult {
  /** Where the time went. Absent only on the degraded citations-only path. */
  timings?: AskTimings;
  answer: string;
  citations: AnswerCitation[];
  usedResults: number;
  provider: string;
  model: string;
  historyIncluded: boolean;
  /** 'simple' | 'complex' when the provider was auto-routed; null otherwise. */
  complexity?: 'simple' | 'complex' | null;
  /** Stage-1 RLM (ss-rlm) usage: whether it drafted, which model, and the
   *  tool-use loop stats (rounds / tool calls) when the recursive gather ran. */
  rlm?: { used: boolean; model?: string | null; rounds?: number; toolCalls?: number; /** RLM-found items promoted to citable context. */ citations?: number };
}

/**
 * Classify a question's complexity to pick the synthesis model in 'auto' mode.
 * Complex = multi-hop / temporal / reasoning / multi-part / many candidates →
 * route to the strong cloud model (groq llama-3.3-70b). Simple = short factual
 * lookup → keep it on the on-prem sidecar (qwen3.5:9b). Cheap heuristic, no LLM call.
 */
function classifyComplexity(query: string, resultCount: number): 'simple' | 'complex' {
  const q = query.toLowerCase();
  const words = q.split(/\s+/).filter(Boolean).length;
  const multiHop = /\b(call|caller|callee|impact|depend|across|relationship|trace|chain|flow|every|compare|versus|vs)\b/.test(q);
  const reasoning = /\b(why|how does|how is|explain|walk through|architecture|design|interaction|end[- ]to[- ]end)\b/.test(q);
  const multiPart = /\b(and|then|also)\b/.test(q) || (q.match(/\?/g)?.length ?? 0) > 1;
  if (words >= 14 || multiHop || reasoning || multiPart || TEMPORAL_RE.test(query) || resultCount >= 12) {
    return 'complex';
  }
  return 'simple';
}

const DEFAULT_MODELS: Record<AnswerProvider, string> = {
  groq: 'llama-3.3-70b-versatile',
  anthropic: 'claude-sonnet-5',
  gemini: 'gemini-3.8-flash',
  sidecar: 'qwen3.5:9b',
  // Informational only. The sidecar route pins the model from our own
  // allowedModels['rlm-sandbox'] and strips `model` from the body, so a
  // request cannot choose one — this is what the operator has selected.
  openrouter: 'deepseek/deepseek-v4-flash',
};

const SIDECAR_FALLBACK_MODEL = 'qwen3.5:9b';

const TEMPORAL_RE =
  /chang(e|ed|es)|history|when |version|breaking|migrat|deprecat|recent|diff/i;

/**
 * The synthesis instruction.
 *
 * The previous version was three sentences whose only emphasis was "use ONLY
 * the provided context" and "say so if it is insufficient". It got exactly
 * what it asked for: with fourteen sources in hand — including the two backend
 * files that implement the mechanism — the model replied that the conversion
 * "is not detailed in the snippets" and stopped. Terse refusal was the
 * lowest-risk way to satisfy that prompt, so that is what it produced.
 *
 * Grounding still matters and is unchanged: no invented APIs, cite everything.
 * What changed is the bar for effort. The reader is another MCP server asking
 * how code works, so the useful answer traces the mechanism across the files
 * it was given and names the types and functions on the path. Signatures plus
 * call-graph context are usually enough to describe a flow accurately, and
 * saying which step is not shown is far more useful than discarding the
 * fourteen that are.
 */
const SYSTEM_PROMPT =
  'You are a senior engineer explaining how a codebase works to another ' +
  'engineer who cannot see it. Ground every claim in the numbered context and ' +
  'cite inline as [n]. Never invent an API, file, type or behaviour that is ' +
  'not in the context.\n\n' +
  'HOW TO ANSWER:\n' +
  '- Lead with a two-or-three sentence answer to the question as asked. No ' +
  'preamble, no restating the question.\n' +
  '- Then trace the MECHANISM in order: entry point, the types and functions ' +
  'on the path, what each one does with the data, where it ends up. Name real ' +
  'identifiers from the context — `SoxSession.receive`, not "the handler".\n' +
  '- Use short markdown sections and bullets when the flow has distinct ' +
  'stages. Inline-code every identifier, file and field.\n' +
  '- Say which project each part lives in when the answer spans more than ' +
  'one; a frontend and its backend are usually separate projects here.\n\n' +
  'PARTIAL EVIDENCE IS NORMAL, AND NOT A REASON TO GIVE UP. You are given ' +
  'signatures, documentation and call-graph neighbours rather than whole ' +
  'files. Reconstruct what the code does from them and describe it plainly. ' +
  'If one specific step is genuinely absent, explain everything you CAN see, ' +
  'then name the missing step and the file most likely to contain it. An ' +
  'answer that traces four of five stages is useful; "the context is ' +
  'insufficient" thrown over a dozen relevant sources is not.\n\n' +
  'For "what changed" questions, reason chronologically about the ' +
  'before -> after signatures.';

// ---------------------------------------------------------------------------
// Cloud provider chat callers (prose output — NO json_object response format)
// Keys come from process.env.{GROQ,ANTHROPIC,GEMINI}_API_KEY.
// ---------------------------------------------------------------------------

async function callGroqChat(model: string, system: string, user: string, maxTokens: number): Promise<string> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY not set');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Groq HTTP ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  return json.choices?.[0]?.message?.content ?? '';
}

async function callAnthropicChat(model: string, system: string, user: string, maxTokens: number): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  if (Array.isArray(json.content)) {
    return json.content.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('');
  }
  return '';
}

async function callGeminiChat(model: string, system: string, user: string, maxTokens: number): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens },
    }),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  return json.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? '').join('') ?? '';
}


// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------

function truncate(s: string | undefined, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function assembleContext(
  results: SemanticSearchResult[],
  changes: Array<{ qualifiedName: string; changeType: string; beforeSig: string | null; afterSig: string | null; occurredAt: string }>,
  maxContextChars: number,
): { context: string; usedResults: number } {
  const lines: string[] = [];
  let usedResults = 0;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const snippet = readSourceSnippet(r.filePath, r.lineStart);
    const block =
      `[${i + 1}] ${r.qualifiedName} (${r.nodeType}) ${r.filePath}:${r.lineStart}\n` +
      `  sig: ${r.signature ?? '(none)'}\n` +
      `  doc: ${truncate(r.documentation, 300) || '(none)'}\n` +
      (snippet ? `  source:\n${snippet.split('\n').map((l) => '    ' + l).join('\n')}\n` : '') +
      `  graph: ${r.callerCount ?? 0} callers / ${r.calleeCount ?? 0} callees`;
    // Stop adding items once we'd blow the budget (always keep at least one).
    if (usedResults > 0 && lines.join('\n').length + block.length > maxContextChars) break;
    lines.push(block);
    usedResults++;
  }

  if (changes.length > 0) {
    const changeLines = ['', 'Recent changes:'];
    for (const c of changes) {
      changeLines.push(
        `${c.qualifiedName}: ${c.changeType} ${c.beforeSig ?? '∅'} -> ${c.afterSig ?? '∅'} (${c.occurredAt})`,
      );
    }
    const joined = changeLines.join('\n');
    if (lines.join('\n').length + joined.length <= maxContextChars) {
      lines.push(joined);
    }
  }

  return { context: lines.join('\n'), usedResults };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function answerCodeQuestion(
  query: string,
  opts: AnswerCodeQuestionOptions = {},
): Promise<AnswerCodeQuestionResult> {
  // a. Defaults from settings.semanticSearch.answerSynthesis merged with opts.
  let semanticSearch: any = {};
  try {
    semanticSearch = (loadConfig() as any)?.semanticSearch ?? {};
  } catch {
    semanticSearch = {};
  }
  const synth: any = semanticSearch.answerSynthesis ?? {};

  // Configured choice may be 'auto' (server routes by complexity). Default 'auto'
  // so the MCP picks: simple → on-prem qwen3.5:9b, complex → groq llama-3.3-70b.
  const configuredProvider: AnswerProviderSetting =
    (opts.provider ?? synth.provider ?? 'auto') as AnswerProviderSetting;
  // One clock for the whole request; every stage below spends from it.
  const fast = opts.fast === true;
  const useRlm = opts.rlm ?? !fast;
  const useRerank = opts.rerank !== false;
  // 'off' disables the cross-encoder pass; undefined lets config/policy decide.
  const rerankMode: RerankMode | undefined = useRerank ? undefined : 'off';
  const budgetMs = opts.budgetMs
    ?? (fast && !useRlm ? FAST_ANSWER_BUDGET_MS : (synth.budgetMs ?? DEFAULT_ANSWER_BUDGET_MS));
  const startedAt = Date.now();
  const msLeft = (): number => budgetMs - (Date.now() - startedAt);
  // Stage marks, reported back to the caller as `timings`. "Why was that slow"
  // has been answered by log archaeology all day; the answer should carry it.
  const marks = { retrievalDone: 0, rlmDone: 0, synthesisDone: 0 };
  const progress = (stage: 'retrieving' | 'investigating' | 'synthesizing' | 'done', message: string, n: number) => {
    try { opts.onProgress?.({ stage, message, progress: n, total: 4 }); } catch { /* a bad listener must not fail the ask */ }
    if (opts.askId) emitAskEvent(opts.askId, { kind: 'stage', text: message, detail: stage });
  };
  progress('retrieving', `searching project${opts.projectId !== undefined ? ` ${opts.projectId}` : ''}…`, 1);

  // ── Retrieval gets a SLICE of the budget, not all of it ─────────────────
  //
  // Retrieval was the one stage with no deadline, and it overran the whole
  // budget three times today (once by 86s), so every downstream stage inherited
  // nothing. A stage that can consume the entire allowance makes the others'
  // deadlines decorative.
  //
  // 35% of the budget: 7s of a 20s fast ask, ~16s of a 45s full one. With the
  // ANN index a single project search is ~1.4s, so this is generous when the
  // fleet is healthy and binding when it is not.
  //
  // HONEST LIMITATION: `svc.search` takes no AbortSignal, so a timed-out search
  // is not cancelled — we stop WAITING for it and it finishes in the background.
  // That bounds the caller's latency, which is the point, at the cost of some
  // wasted work on a bad day. Plumbing a signal through the search stack is
  // the proper fix and is noted in docs/tasks/ask-unbounded-retrieval.
  // Not 35%, not any fixed share. A hard question is allowed to take longer;
  // a slice that cuts retrieval off early manufactures empty results, which
  // is worse than a late answer. The default share is the WHOLE budget, so
  // this deadline is a safety net against a hung fan-out, not a quality knob.
  // Tune down via `semanticSearch.answerSynthesis.retrievalShare` (0.1-1.0)
  // if a deployment truly needs it. The floor is one embed attempt.
  const retrievalShare = (() => {
    const v = Number(synth.retrievalShare);
    return Number.isFinite(v) && v >= 0.1 && v <= 1 ? v : 1.0;
  })();
  const embedFloorMs = (() => {
    const v = Number(readRuntimeSemantic().embedQueryTimeoutMs);
    return Number.isFinite(v) && v >= 1_000 ? v : 20_000;
  })();
  const retrievalDeadlineAt = startedAt + Math.max(embedFloorMs, Math.round(budgetMs * retrievalShare));
  const raceDeadline = async <T,>(work: Promise<T>, fallback: T, label: string): Promise<T> => {
    const ms = retrievalDeadlineAt - Date.now();
    if (ms <= 0) { console.warn(`[answerCodeQuestion] ${label}: retrieval deadline already passed — skipped`); return fallback; }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<T>(res => { timer = setTimeout(() => {
      console.warn(`[answerCodeQuestion] ${label}: exceeded the retrieval slice (${ms}ms) — continuing with what we have`);
      res(fallback);
    }, ms); });
    try { return await Promise.race([work, timeout]); } finally { if (timer) clearTimeout(timer); }
  };
  const topK = opts.topK ?? synth.topK ?? 8;
  const maxContextChars = opts.maxContextChars ?? synth.maxContextChars ?? 12000;
  const includeHistory = opts.includeHistory ?? synth.includeHistory ?? true;
  const projectId = opts.projectId;

  // b. RETRIEVE via semantic search (vector → graph enrich → cross-encoder).
  const svc = getSemanticSearchService(getPrismaClient());
  // Related projects (dependencies + dependents, capped — memory guard: every
  // search below stays scoped to exactly one projectId; never unscoped).
  const maxScopeProjects: number | undefined = typeof synth.maxScopeProjects === 'number' ? synth.maxScopeProjects : undefined;
  const tScope0 = Date.now();
  const siblings = await getRelatedProjects(projectId, maxScopeProjects);
  const scopeMs = Date.now() - tScope0;
  const tPrimary0 = Date.now();
  // The PRIMARY search is not raced. It is the one stage the answer cannot do
  // without: racing it to a 7s slice (35% of a 20s fast budget) returned `[]`
  // whenever the query embed ran long — the embed itself is allowed 8s — and
  // synthesis then truthfully reported "no results found" for a project with
  // 5,210 vectors. The overruns that motivated the deadline came from the
  // sibling fan-out below, which is optional and IS raced. A slow primary
  // search is a slow answer; an empty one is a wrong answer.
  let results = await svc.search(query, {
    projectId,
    limit: topK,
    includeGraphContext: true,
    crossEncoderReranker: semanticSearch.crossEncoderReranker,
    rerank: rerankMode,
  });
  const primaryMs = Date.now() - tPrimary0;
  let siblingsMs = 0;
  const tSiblings0 = Date.now();
  if (siblings.length) {
    // Dependency scope: a question about one project usually spans its
    // neighbours (frontend ↔ backend). Always add the related projects' best
    // hits; the primary project's hits stay first, and the RLM tools below
    // search them too. (Formerly only when the primary had < 3 hits — that
    // missed the case where the backend had exactly 3 relevant functions and
    // the frontend held the actual answer.)
    // IN PARALLEL, and bounded.
    //
    // These ran in a sequential for-loop, and every iteration re-embedded the
    // SAME query. Under "OpenRouter only" each embedding is a cloud round trip,
    // so a project with eight neighbours spent eight of them before the RLM
    // had started: measured at 24s of a 45s budget, which is exactly why the
    // RLM stage was being skipped for want of time. They are independent
    // reads — nothing about them needed to be serial.
    //
    // Capped as well: the tail neighbours contribute little after `slice`, and
    // a project with twenty of them should not be able to spend the whole
    // budget on retrieval no matter how fast each one is.
    const MAX_PARALLEL_SIBLINGS = 6;
    // In fast mode, search the primary project ONLY. Each sibling is a full
    // search — a cloud query embedding, a vector scan, graph enrichment — and
    // seven of them in parallel are what consumed a 20s budget before
    // synthesis got a turn, leaving it the 8s floor and a 500. A person at the
    // UI asked about one project; the neighbours are the RLM's job, and fast
    // mode has already opted out of the RLM.
    const searched = await Promise.all(
      (fast && !useRlm ? [] : siblings.slice(0, MAX_PARALLEL_SIBLINGS)).map(sib =>
        raceDeadline(svc.search(query, {
          projectId: sib.id,
          limit: topK,
          includeGraphContext: true,
          crossEncoderReranker: semanticSearch.crossEncoderReranker,
          // Sibling context is supplementary; the primary project's results
          // are reranked. Three concurrent 50-doc cloud reranks cost up to 6s.
          rerank: 'off',
        }).catch(() => [] as typeof results), [] as typeof results, `sibling ${sib.name}`)),
    );
    for (const more of searched) results = results.concat(more);
    siblingsMs = Date.now() - tSiblings0;
    results = results.slice(0, topK + 4);
    console.log(`[answerCodeQuestion] scoped project ${projectId}: retrieval includes related projects ${siblings.map(s => `${s.name}[${s.kind}/${s.direction}]`).join(', ')} → ${results.length} results`);
  }

  marks.retrievalDone = Date.now();
  // Where retrieval spent its time. Measured 5.8s in one warm run and 21.9s in
  // the next for the same question; the split says which step wandered.
  console.log(`[answerCodeQuestion] retrieval ${marks.retrievalDone - startedAt}ms = scope ${scopeMs}ms + primary ${primaryMs}ms + siblings(${siblings.length}) ${siblingsMs}ms → ${results.length} results`);
  progress('investigating', `${results.length} hits in ${((marks.retrievalDone - startedAt) / 1000).toFixed(1)}s — investigating…`, 2);

  // b2. SYNTHESIS provider. Two-stage design: the RLM (ss-rlm) does the deep
  // reasoning (stage 1, below); the final cited synthesis is done by GROQ
  // (llama-3.3-70b) by default. An explicit non-auto provider (e.g. 'anthropic'
  // for Claude) is honored — "groq or claude, whichever the MCP selects".
  const complexity: 'simple' | 'complex' | null = classifyComplexity(query, results.length);
  let provider: AnswerProvider = 'groq';
  let requestedModel: string = opts.model ?? synth.heavyModel ?? DEFAULT_MODELS.groq;
  if (configuredProvider !== 'auto' && configuredProvider !== 'groq') {
    provider = configuredProvider;
    requestedModel = opts.model ?? synth.model ?? DEFAULT_MODELS[provider] ?? DEFAULT_MODELS.groq;
  }
  // AUTO follows the fleet. Once OpenRouter is switched on, answering through
  // a separate GROQ account — a different key, a different bill, a model
  // nobody chose on the config page — is not what "auto" should mean. It was
  // also simply broken: with the GPUs excluded by policy, groq's own fallback
  // is the local sidecar, which no longer advertises `llm` or `rlm`, so the
  // Answer box failed on both paths. This is the "Answer does not work since
  // we moved to OpenRouter" fix.
  if (configuredProvider === 'auto') {
    try {
      const { getVirtualContainersConfig } = await import('../sidecars/virtualContainers.js');
      if (getVirtualContainersConfig().enabled === true) {
        provider = 'openrouter';
        requestedModel = opts.model ?? DEFAULT_MODELS.openrouter;
      }
    } catch { /* keep the pre-OpenRouter default */ }
  }

  // c. TEMPORAL INTENT: fetch change history for the top ~3 result names.
  const temporal = includeHistory !== false && TEMPORAL_RE.test(query);
  const changes: Array<{ qualifiedName: string; changeType: string; beforeSig: string | null; afterSig: string | null; occurredAt: string }> = [];
  let historyIncluded = false;
  if (temporal && results.length > 0) {
    try {
      const { getSymbolHistory } = await import('../fantom-code/timeTravelTools.js');
      const prisma = getPrismaClient();
      const top = results.slice(0, 3);
      for (const r of top) {
        const hist = await getSymbolHistory(prisma, { qualifiedName: r.qualifiedName, projectId });
        for (const ev of hist.events) {
          changes.push({
            qualifiedName: r.qualifiedName,
            changeType: ev.changeType,
            beforeSig: ev.beforeSig,
            afterSig: ev.afterSig,
            occurredAt: ev.occurredAt,
          });
        }
      }
      historyIncluded = changes.length > 0;
    } catch {
      // History is best-effort; never block the answer.
      historyIncluded = false;
    }
  }

  // d. ASSEMBLE CONTEXT.
  const { context, usedResults } = assembleContext(results, changes, maxContextChars);

  // e. PROMPT.
  const userPrompt =
    `QUESTION: ${query}\n\n` +
    `CONTEXT (numbered code search results` +
    (changes.length > 0 ? ` + recent change history` : '') +
    `):\n${context || '(no results found)'}\n\n` +
    `Answer the question now, citing sources inline as [n].`;

  // e2. STAGE 1 — RECURSIVE RLM. If a sidecar advertises the dedicated
  // Recursive LM (ss-rlm / mit-oasys/rlm-qwen3-8b on port 8100), drive it
  // through a tool-use loop: it iteratively calls search_code / project_overview
  // to gather the exact code needed, then produces a brief draft. The gathered
  // EVIDENCE is appended to the context Groq synthesizes from (so Groq sees the
  // code the RLM discovered, not just the seed hits). Best-effort: if no rlm
  // sidecar is available or the loop errors, runRlmGather returns null and we
  // keep the existing direct-Groq path.
  let rlmDraft = '';
  let rlmModel: string | null = null;
  let rlmEvidence = '';
  let rlmRounds = 0;
  let rlmToolCalls = 0;
  // Every code location the RLM's tools returned, keyed by file:line. After the
  // gather, the ones not already in the numbered seed context are promoted to
  // numbered items so the final answer can cite RLM-found code as [n] instead
  // of describing it uncited (or inventing a number).
  const rlmFound = new Map<string, RlmFoundHit>();
  try {
    const { getSidecarForCapability } = await import('../sidecars/registry.js');
    const rlmSc = getSidecarForCapability('rlm');
    // Do NOT gate on a local ss-rlm sidecar.
    //
    // This used to read `if (rlmSc)`, which meant the whole stage was skipped
    // whenever no host ran ss-rlm — the permanent state once the RLM role
    // moved to "OpenRouter only", where the GPUs are excluded by design. The
    // sandbox was reachable and configured and never got asked, which is the
    // other half of "the RLM stopped working when we moved to OpenRouter".
    //
    // `resolveRlmEndpoint()` inside runRlmGather already answers this
    // properly: local ss-rlm, hosted sandbox, or null per the routing policy.
    // Asking the registry here only duplicated the question and got it wrong.
    //
    // The budget check is the real gate now. Starting a multi-round tool loop
    // with a few seconds left produces nothing and spends the reserve that the
    // final cited pass needs.
    const rlmBudget = msLeft() - SYNTHESIS_RESERVE_MS;
    if (!useRlm) {
      console.log(`[answerCodeQuestion] RLM stage off (rlm=false${fast ? ', fast mode' : ''}) — answering from retrieval.`);
    } else if (rlmBudget < MIN_RLM_MS) {
      console.log(
        `[answerCodeQuestion] skipping the RLM stage — ${Math.round(msLeft() / 1000)}s left of the `
        + `${Math.round(budgetMs / 1000)}s budget, not enough for a round plus synthesis. `
        + 'Answering from the retrieved context.',
      );
    } else {
      rlmModel = rlmSc?.capabilities.rlm?.loaded ?? rlmSc?.capabilities.rlm?.models?.[0] ?? null;
      const { runRlmGather } = await import('./rlmToolLoop.js');
      const tools = RLM_TOOLS;
      const executeTool = buildRlmExecutor({
        projectId,
        siblings,
        crossEncoderReranker: semanticSearch.crossEncoderReranker,
        rerank: rerankMode,
        collect: (h) => {
          const k = hitKey(h);
          if (!rlmFound.has(k)) rlmFound.set(k, h);
        },
      });
      const primaryRow = siblings.length
        ? await getPrismaClient().fantomProject.findUnique({ where: { id: projectId! }, select: { name: true, language: true } })
        : null;
      const primaryName = primaryRow?.name ?? String(projectId);
      const primaryLanguage = primaryRow?.language ?? 'unknown';
      const workspaceNote = siblings.length
        ? `Projects in scope: primary "${primaryName}" plus related projects ${siblings.map(describeScopeProject).join(', ')}. Searches cover all of them; results from related projects are tagged [project: name]. When a sub-question mentions a library or UI concept, target the project that lists it.`
        : '';
      const gather = await runRlmGather({
        // Feed: every question/answer to the dashboard log AND to the MCP
        // client's progress stream, so both see "asking X → 8 hits" live.
        onEvent: (e) => {
          if (opts.askId) emitAskEvent(opts.askId, { kind: e.kind, text: e.text, id: e.id, detail: e.detail, items: e.items, ms: e.ms });
          if (e.kind === 'ask' || e.kind === 'answer' || e.kind === 'thought') {
            const line = e.kind === 'ask' ? `asking ${e.text}` : e.kind === 'answer' ? `→ ${e.text}${e.ms !== undefined ? ` (${(e.ms / 1000).toFixed(1)}s)` : ''}` : `thinking: ${e.text.slice(0, 160)}`;
            try { opts.onProgress?.({ stage: 'investigating', message: line, progress: 2, total: 4 }); } catch { /* ignore */ }
          }
        },
        question: query,
        seedContext: workspaceNote ? `${workspaceNote}\n\n${context}` : context,
        scopeNote: siblings.length ? buildScopeNote(primaryName, primaryLanguage, siblings) : undefined,
        extraSubQuestions: libraryScopeSubQuestions(query, siblings),
        projectId,
        // Evidence is the dominant term in synthesis latency — the prompt is
        // read before a single token comes back, and 16k chars of it bought a
        // 2k answer. 9k keeps the RLM-found code that makes the answer good
        // (7 promoted citations in the measured run) without paying for a
        // prompt nobody reads twice.
        // Raised from 9k now that the ANN index cut retrieval from ~30s to
        // ~10s — the headroom is better spent on evidence than left idle.
        // This is the material the answer is built from; starving it produced
        // the "not detailed in the snippets" reply.
        maxEvidenceChars: 13_000,
        tools,
        executeTool,
        // With the PLAN → parallel GATHER stage in front, the model already
        // starts from 3–4 searches' worth of evidence; the rounds here are
        // follow-ups only. 4 rounds after a plan was measured at 55 s of a
        // 77 s ask; 2 keeps the whole ask near 40 s.
        maxRounds: 2,
        // Was a flat 60s, which on its own exceeded a 60s MCP client before
        // synthesis had run at all. Now it gets whatever the shared budget has
        // left after retrieval, minus the reserve that guarantees a final
        // cited pass — and the `finish()` path returns the evidence gathered
        // so far when the clock runs out, so a short deadline degrades the
        // answer rather than losing it.
        deadlineMs: Math.max(MIN_RLM_MS, msLeft() - SYNTHESIS_RESERVE_MS - RLM_OVERRUN_SLACK_MS),
      });
      if (gather && gather.available) {
        rlmDraft = (gather.finalDraft ?? '').trim();
        rlmEvidence = gather.evidence ?? '';
        rlmRounds = gather.rounds;
        rlmToolCalls = gather.toolCalls;
      }
    }
  } catch (err) {
    console.warn(`[answerCodeQuestion] RLM gather stage skipped: ${(err as Error).message}`);
    rlmDraft = '';
    rlmEvidence = '';
  }
  const rlmUsed = rlmDraft.length > 0 || rlmEvidence.length > 0;

  // f. STAGE 2 — synthesis (Groq by default). Fold in the RLM-gathered evidence
  // AND its draft so Groq grounds the final cited answer in the code the RLM
  // discovered, not just the seed hits. Bound the evidence so a long gather
  // doesn't dwarf the prompt.
  const boundedEvidence = rlmEvidence.length > 16000 ? rlmEvidence.slice(0, 16000) + '\n…' : rlmEvidence;
  let synthUserPrompt = userPrompt;
  // Promote RLM-found locations that the seed context does not already number.
  const seedKeys = new Set(results.slice(0, usedResults).map(hitKey));
  const promoted: RlmFoundHit[] = [];
  const promotedBlocks: string[] = [];
  let promotedChars = 0;
  for (const h of rlmFound.values()) {
    if (promoted.length >= RLM_PROMOTE_MAX_ITEMS) break;
    if (seedKeys.has(hitKey(h))) continue;
    const n = usedResults + promoted.length + 1;
    const snippet = readSourceSnippet(h.filePath, h.lineStart);
    const block =
      `[${n}] ${h.qualifiedName} (${h.nodeType}) ${h.filePath}:${h.lineStart}` +
      (h.project ? ` [project: ${h.project}]` : '') +
      `\n  sig: ${h.signature ?? '(none)'}` +
      (snippet ? `\n  source:\n${snippet.split('\n').map((l) => '    ' + l).join('\n')}` : '');
    if (promoted.length > 0 && promotedChars + block.length > RLM_PROMOTE_MAX_CHARS) break;
    promoted.push(h);
    promotedBlocks.push(block);
    promotedChars += block.length;
  }
  if (promoted.length) {
    synthUserPrompt +=
      `\n\nADDITIONAL CONTEXT (numbered items ${usedResults + 1}–${usedResults + promoted.length}, code found by the investigation model; cite them as [n] like the items above):\n` +
      promotedBlocks.join('\n');
    console.log(`[answerCodeQuestion] promoted ${promoted.length} RLM-found locations to citable context (${rlmFound.size} found, ${seedKeys.size} already in seed)`);
  }
  if (boundedEvidence) {
    synthUserPrompt +=
      `\n\nADDITIONAL EVIDENCE (code gathered by a recursive investigation model via tool calls):\n${boundedEvidence}`;
  }
  if (rlmDraft) {
    synthUserPrompt +=
      `\n\nA recursive reasoning model (RLM) drafted this answer after investigating:\n"""\n${rlmDraft}\n"""\n\nProduce the FINAL answer: keep claims supported by the context/evidence, correct or drop anything unsupported, and cite sources inline as [n].`;
  } else if (boundedEvidence) {
    synthUserPrompt += `\n\nAnswer the question now using the context and the gathered evidence, citing sources inline as [n].`;
  }

  marks.rlmDone = Date.now();
  progress('synthesizing', rlmToolCalls > 0
    ? `RLM made ${rlmToolCalls} tool call(s) — writing the answer…`
    : 'writing the answer…', 3);
  const maxTokens = 1024;
  let answer = '';
  let usedProvider: string = provider;
  let usedModel: string = requestedModel;

  const runSidecar = async (): Promise<string> => {
    const { callSidecarLlm } = await import('./sidecarLlmClient.js');
    const fullPrompt = `${SYSTEM_PROMPT}\n\n${synthUserPrompt}`;
    // Sidecar order for the final pass:
    //   1. the RLM (vLLM on a GPU, sub-second for short prompts) — it already
    //      did stage 1, so it is loaded and warm;
    //   2. the general 'llm' sidecar (Ollama, often CPU-bound) — a 16 KB
    //      prompt there was measured to exceed 120 s and abort.
    // An explicitly requested sidecar model still goes to 'llm' first.
    const attempts: Array<{ capability: 'rlm' | 'llm'; model: string | undefined; timeoutMs: number }> =
      provider === 'sidecar'
        ? [{ capability: 'llm', model: requestedModel, timeoutMs: 120000 }, { capability: 'rlm', model: rlmModel ?? undefined, timeoutMs: 90000 }]
        : [{ capability: 'rlm', model: rlmModel ?? undefined, timeoutMs: 90000 }, { capability: 'llm', model: SIDECAR_FALLBACK_MODEL, timeoutMs: 120000 }];
    let lastErr: unknown;
    for (const a of attempts) {
      try {
        const text = await callSidecarLlm(fullPrompt, {
          capability: a.capability,
          model: a.model,
          // Thinking models spend tokens reasoning before final content; give
          // 4× headroom so they don't exhaust the budget mid-thought → blank.
          maxTokens: Math.max(maxTokens, 4096),
          timeoutMs: a.timeoutMs,
        });
        usedProvider = 'sidecar';
        usedModel = a.model ?? a.capability;
        return text;
      } catch (err) {
        lastErr = err;
        console.warn(`[answerCodeQuestion] sidecar '${a.capability}' final pass failed: ${(err as Error).message}`);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  };

  /** Final cited pass through the sidecar's OpenRouter route. */
  const runOpenRouter = async (): Promise<string> => {
    const { openRouterChat } = await import('../sidecars/openRouterChat.js');
    // A working generation is never cut by the budget. Measured today:
    // deepseek-flash synthesis via the sidecar takes 13-40s (longer with RLM
    // context), and every fixed window tried so far — 15s, 25s, 44s — killed
    // a generation that was mid-answer and returned citations-only for a
    // question that had an answer. The budget is a target (reported through
    // `overBudget`), not a client deadline; the only limit here is a generous
    // safety net against a hung upstream, `answerSynthesis.synthesisMaxMs`
    // (default 120s). Failover remains for hard failures (refused/5xx/409).
    const synthMax = (() => { const v = Number(synth.synthesisMaxMs); return Number.isFinite(v) && v >= 10_000 ? v : 120_000; })();
    const out = await openRouterChat(SYSTEM_PROMPT, synthUserPrompt, {
      // Fast mode: a UI answer measured at ~2k chars (~500 tokens); 4096 only
      // invites a longer, slower generation the reader did not ask for. The
      // full MCP path keeps the 4x headroom for thinking models.
      maxTokens: fast ? 1024 : Math.max(maxTokens, 4096),
      timeoutMs: synthMax,
      temperature: 0.2,
    });
    usedProvider = 'openrouter';
    usedModel = out.model;
    console.log(
      `[answerCodeQuestion] synthesis via OpenRouter (${out.model}) on ${out.servedBy}`
      + `${out.costUsd !== null ? ` cost=$${out.costUsd.toFixed(6)}` : ''} `
      + `at ${Math.round((Date.now() - startedAt) / 1000)}s of ${Math.round(budgetMs / 1000)}s`,
    );
    return out.text;
  };

  try {
    if (provider === 'openrouter') {
      answer = await runOpenRouter();
    } else if (provider === 'sidecar') {
      answer = await runSidecar();
    } else if (provider === 'groq') {
      answer = await callGroqChat(requestedModel, SYSTEM_PROMPT, synthUserPrompt, maxTokens);
    } else if (provider === 'anthropic') {
      answer = await callAnthropicChat(requestedModel, SYSTEM_PROMPT, synthUserPrompt, maxTokens);
    } else if (provider === 'gemini') {
      // Gemini 3.x are thinking models: reasoning tokens count against
      // maxOutputTokens, so a 1024 budget truncated answers mid-sentence
      // (finishReason MAX_TOKENS). Give the same 4× headroom as the sidecar.
      answer = await callGeminiChat(requestedModel, SYSTEM_PROMPT, synthUserPrompt, Math.max(maxTokens, 4096));
    } else {
      answer = await runSidecar();
    }
  } catch (err) {
    // Cloud provider failed (missing key, network, etc.) — fall back to sidecar.
    console.warn(`[answerCodeQuestion] provider '${provider}' failed: ${(err as Error).message}; trying the remaining paths`);
    try {
      // OpenRouter first, then the local sidecar. The old order went straight
      // to the sidecar, which under "OpenRouter only" advertises neither 'llm'
      // nor 'rlm' — so the fallback for a failed cloud provider was a path
      // guaranteed to fail too, and the caller waited out both timeouts to be
      // told nothing. Skipped when OpenRouter is what just failed.
      answer = provider === 'openrouter' ? await runSidecar() : await runOpenRouter();
      answer = `${answer}\n\n_(Note: requested provider '${provider}' was unavailable; answered via ${usedProvider} ${usedModel}.)_`;
    } catch (err2) {
      // Last resort: stage 1 already produced a cited draft from the RLM. A
      // draft with a note beats a 500 after the user waited for two timeouts.
      if (rlmDraft) {
        usedProvider = 'sidecar';
        usedModel = rlmModel ?? 'rlm';
        answer = `${rlmDraft}\n\n_(Note: final synthesis was unavailable — provider '${provider}': ${(err as Error).message.split('\n')[0]}; sidecar: ${(err2 as Error).message}. This is the RLM's draft.)_`;
      } else {
        // Do NOT throw. By this point retrieval has produced ranked, cited
        // sources — the thing a caller can least afford to lose. A 500
        // discards all of it and, from the UI, reads as "the feature is
        // broken" after a 30s wait. Return what we have and say plainly why
        // there is no prose. An MCP caller can work from ranked sources; it
        // cannot work from a 500.
        usedProvider = 'none';
        usedModel = 'unavailable';
        const why = (err as Error).message.split('\n')[0].slice(0, 200);
        answer =
          'Synthesis was unavailable, so this is the retrieved evidence without a written answer.\n\n'
          + `The sources below are the ranked matches for the question${results.length ? '' : ' (none found)'}. `
          + `Reason: ${why}`;
        console.warn(`[answerCodeQuestion] degraded to citations-only: ${why}`);
      }
    }
  }

  // g. Citations from the result items actually used in the context.
  const citations: AnswerCitation[] = results.slice(0, usedResults).map((r) => ({
    nodeId: r.nodeId,
    qualifiedName: r.qualifiedName,
    filePath: r.filePath,
    lineStart: r.lineStart,
    via: 'seed' as const,
  }));
  for (const h of promoted) {
    citations.push({ nodeId: h.nodeId, qualifiedName: h.qualifiedName, filePath: h.filePath, lineStart: h.lineStart, project: h.project, via: 'rlm' });
  }

  marks.synthesisDone = Date.now();
  progress('done', `answered in ${((marks.synthesisDone - startedAt) / 1000).toFixed(1)}s`, 4);
  return {
    answer,
    citations,
    usedResults,
    provider: usedProvider,
    model: usedModel,
    historyIncluded,
    // Where the time went, so a slow answer explains itself. `overBudget` is
    // the honest number: the budget is a target the stages spend against, and
    // the synthesis floor can carry a run a few seconds past it on purpose.
    timings: {
      retrievalMs: marks.retrievalDone - startedAt,
      rlmMs: Math.max(0, marks.rlmDone - marks.retrievalDone),
      synthesisMs: Math.max(0, marks.synthesisDone - marks.rlmDone),
      totalMs: marks.synthesisDone - startedAt,
      budgetMs,
      fast,
      rlm: useRlm,
      rerank: useRerank,
      overBudget: Math.max(0, (marks.synthesisDone - startedAt) - budgetMs),
    },
    complexity,
    rlm: { used: rlmUsed, model: rlmModel, rounds: rlmRounds, toolCalls: rlmToolCalls, citations: promoted.length },
  };
}
