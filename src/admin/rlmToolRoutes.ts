/**
 * Retrieval tools for `ss-rlm-sandbox`, over HTTP.
 *
 * The sandbox runs the Recursive-LM loop inside a container on the sidecar. It
 * holds its context as a REPL variable and chunks / greps / sub-queries it, and
 * to do that against OUR data it needs our retrieval. The `rlms` library cannot
 * take a host callable across a process boundary, so the container's Python
 * tools are small functions that POST here instead.
 *
 * ── Why this is not part of the admin router ──────────────────────────────
 *
 * `/admin` is Basic-auth. The sandbox sends `Authorization: Bearer <token>`,
 * which Basic auth rejects, so mounting these there would fail every call.
 * They are mounted separately in index.ts and carry their own bearer check.
 *
 * ── Auth is mandatory, and closed by default ──────────────────────────────
 *
 * These endpoints expose the entire code index to anything that can reach the
 * port. The fleet is VPN-only and single-tenant, which is a reason to keep the
 * token simple, NOT a reason to ship them open: the Sound Suite sidecar's own
 * equivalent route is currently unauthenticated inside the Docker network and
 * its own spec calls that a known gap rather than a precedent.
 *
 * With no token configured the routes refuse every request rather than
 * allowing them. An endpoint that silently opens when its config is missing is
 * how a VPN-only assumption becomes a public index.
 *
 * ── Nothing calls these yet, and that is not a mistake ────────────────────
 *
 * As of the 2026-09-16 revision of `01-how-it-works.md`, the container's
 * `custom_tools` hook is STUBBED — the diagram marks the `custom_tools →
 * master HTTP` hop "(not built)". So a sandbox session today runs the
 * recursive loop over the seed context the master sends and cannot reach this
 * router at all.
 *
 * These routes are built anyway because they are Fantom's half of the
 * contract, they are what the sidecar side is waiting on, and the alternative
 * — wiring them the day the container starts calling — is how an integration
 * ends up debugged through two layers at once. When `custom_tools` lands, this
 * works without a Fantom change.
 *
 * Do not delete them as dead code. `GET /api/rlm-tools/ping` exists so the
 * other side can prove reachability and the token before anyone tries a whole
 * recursive session.
 *
 * ── Responses stay small on purpose ───────────────────────────────────────
 *
 * An RLM issues many sub-calls per question, so a fat response multiplies by
 * the round count. These return structured JSON rows, not the prose blocks the
 * in-process loop feeds its own model: the sandbox re-queries and chunks, and
 * does not need the narrative.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { readConfigFileWithRecovery } from '../config/index.js';
import * as path from 'path';

/** Max rows any one tool call may return, whatever the caller asks for. */
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

export interface RlmToolRow {
  path: string;
  line?: number;
  snippet: string;
  score?: number;
  project?: string;
  symbol?: string;
}

function configPath(): string {
  return path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');
}

/**
 * The bearer token these routes accept.
 *
 * Read from the config file on every request rather than cached at mount time,
 * so rotating it takes effect without a restart — this process has a history
 * of settings that only applied on reboot and looked live in the meantime.
 */
export function rlmToolsToken(): string | null {
  try {
    const cfg = readConfigFileWithRecovery(configPath());
    const t = cfg?.semanticSearch?.rlmToolsToken;
    return typeof t === 'string' && t.trim().length >= 16 ? t.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Constant-time-ish comparison. Not a defence against a local attacker with a
 * timer, but it costs nothing and removes the trivially-measurable early exit.
 */
function tokensMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function requireBearer(req: Request, res: Response, next: NextFunction): void {
  const expected = rlmToolsToken();
  if (!expected) {
    // Closed by default. A missing token is a configuration error, not an
    // invitation: `semanticSearch.rlmToolsToken` must be set (>=16 chars) and
    // pushed to whatever calls these.
    res.status(503).json({
      error: 'RLM tool endpoints are not configured. Set semanticSearch.rlmToolsToken '
        + '(16+ characters) in config/fantomMcpServer-config.json.',
    });
    return;
  }
  const header = String(req.headers.authorization ?? '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || !tokensMatch(token, expected)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

/**
 * The project every tool call is scoped to.
 *
 * `search_code` MUST carry a projectId: the executor's own comment records that
 * cross-project Kuzu enrichment OOMs this box, and it has hit the 4 GB RSS
 * guard twice today. The sandbox's wire contract carries only `{query, limit}`,
 * so an explicit `projectId` is accepted and otherwise the primary project is
 * used — never "all projects", which on this index means 340 of them.
 */
function resolveProjectId(req: Request): number | undefined {
  const asId = (raw: unknown): number | undefined => {
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
  };
  // 1. The body, for a caller that can set it.
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fromBody = asId(body.projectId);
  if (fromBody !== undefined) return fromBody;
  // 2. The header Fantom puts on the sandbox call, which server.py forwards.
  //    This is the path that actually carries scope in practice: the sandbox's
  //    documented tool contract is `{query, limit}` with nowhere to put a
  //    project, so it rides alongside identity and domain instead.
  const fromHeader = asId(req.headers['x-fantommcp-project'] ?? req.headers['x-soundsuite-project']);
  if (fromHeader !== undefined) return fromHeader;
  // 3. An operator-pinned default, then the primary project. Both are usually
  //    unset; neither is guessed at, and the caller gets a 409 saying so
  //    rather than a search across 340 projects.
  try {
    const cfg = readConfigFileWithRecovery(configPath());
    return asId(cfg?.semanticSearch?.rlmToolsDefaultProjectId)
      ?? asId(cfg?.primaryProject?.project?.id)
      ?? asId(cfg?.primaryProject?.projectId);
  } catch {
    return undefined;
  }
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(n));
}

/**
 * Turn the executor's prose block into rows.
 *
 * `buildRlmExecutor` returns text shaped for a model to read, because that is
 * what the in-process loop needs. The sandbox wants data. Rather than fork the
 * retrieval — two implementations of "search our code" WILL drift, and the
 * drift is invisible until answers differ between the two RLM paths — we call
 * the same executor and parse its blocks back into rows here.
 *
 * The parse is deliberately forgiving: an unparseable block still yields a row
 * carrying the raw text, so a formatting change upstream degrades the
 * structure rather than dropping evidence.
 */
function blocksToRows(text: string): RlmToolRow[] {
  if (!text || !text.trim()) return [];
  const rows: RlmToolRow[] = [];
  // Blocks are separated by a blank line; the first line carries the location.
  for (const block of text.split(/\n{2,}/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const lines = trimmed.split('\n');
    const head = lines[0] ?? '';
    // e.g. "sys::Build.compile  /path/to/build.fan:42  [project: foo]"
    const loc = head.match(/([^\s]+\.[A-Za-z0-9_]+):(\d+)/);
    const proj = head.match(/\[project:\s*([^\]]+)\]/);
    const sym = head.match(/^([A-Za-z0-9_:.$]+)/);
    rows.push({
      path: loc?.[1] ?? '',
      line: loc?.[2] ? Number(loc[2]) : undefined,
      symbol: sym?.[1],
      project: proj?.[1]?.trim(),
      snippet: lines.slice(1).join('\n').slice(0, 1200) || head.slice(0, 1200),
    });
  }
  return rows;
}

/** One handler shape for all three tools; only the tool name differs. */
function toolHandler(tool: 'search_code' | 'search_symbols' | 'search_files') {
  return async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (!query) {
      res.status(400).json({ error: `'${tool}' requires a non-empty "query" string.` });
      return;
    }
    const limit = clampLimit(body.limit);
    const projectId = resolveProjectId(req);
    if (projectId === undefined) {
      res.status(409).json({
        error: 'No project scope. Send the X-FantomMCP-Project header (Fantom sets it on the '
          + 'sandbox call), pass "projectId" in the body, or set semanticSearch.'
          + 'rlmToolsDefaultProjectId. An unscoped search would fan out across every indexed '
          + 'project and exhaust memory.',
      });
      return;
    }

    try {
      const { buildRlmExecutor } = await import('../embedding/answerSynthesis.js');
      // Read the reranker setting from the config file, the way the rest of
      // this module reads its own settings — `context.getSettings()` returns a
      // whitelisted object that silently drops keys it does not name, which
      // has already cost a day's debugging once on this codebase.
      let crossEncoderReranker: unknown;
      try {
        crossEncoderReranker = readConfigFileWithRecovery(configPath())?.semanticSearch?.crossEncoderReranker;
      } catch { /* the executor treats undefined as "no reranker" */ }
      const execute = buildRlmExecutor({ projectId, crossEncoderReranker });
      const raw = await execute(tool, { query, limit });
      const results = blocksToRows(raw).slice(0, limit);
      res.json({ tool, projectId, results });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[rlm-tools] ${tool} failed: ${message}`);
      res.status(500).json({ error: message });
    }
  };
}

/**
 * Mounted at `/api/rlm-tools` in index.ts, OUTSIDE the Basic-auth admin router.
 */
export function createRlmToolRouter(): Router {
  const router = Router();
  router.use(requireBearer);
  router.post('/search_code', toolHandler('search_code'));
  router.post('/search_symbols', toolHandler('search_symbols'));
  router.post('/search_files', toolHandler('search_files'));
  // A cheap liveness probe the sandbox (or an operator) can hit to confirm the
  // token works before debugging a whole recursive session through two layers.
  router.get('/ping', (_req, res) => { res.json({ ok: true, tools: ['search_code', 'search_symbols', 'search_files'] }); });
  return router;
}
