/**
 * Boot-time validation for DATABASE_URL and friendly error classification
 * for Prisma failures. Both run before any DB query so the assistant gets
 * a clear, actionable error instead of a Prisma stack trace.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getCachePath } from './installRoot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Validate DATABASE_URL is set and points to a real SQLite file.
 * Resolves relative `file:` URLs against the server's repo root so that the
 * server works regardless of the cwd it was spawned from.
 *
 * Throws a single, clear Error when the env is misconfigured. Prints a
 * one-line message that copy/pastes into the user's MCP config.
 *
 * Mutates process.env.DATABASE_URL to the resolved absolute form when input
 * was relative, so all downstream Prisma clients see the same value.
 */
export function validateDatabaseUrl(): void {
  let raw = process.env.DATABASE_URL;
  if (!raw) {
    // Default to the canonical install-root cache. This avoids the round-8
    // class of bug where a client launches fantom-mcp with a different cwd
    // and Prisma silently lazy-creates a stray empty DB next to the user's
    // source. installRoot.ts always points at fantom-mcp's repo root.
    const defaultPath = getCachePath('fantom.db');
    raw = `file:${defaultPath}`;
    process.env.DATABASE_URL = raw;
    // eslint-disable-next-line no-console
    console.error(`[bootstrap] DATABASE_URL not set — defaulting to ${raw}`);
  }

  if (!raw.startsWith('file:')) {
    // Non-SQLite engines (postgres, mysql) — just trust it. Validation is
    // file-only because this project ships SQLite by design.
    return;
  }

  const rawPath = raw.slice('file:'.length);

  // Strip leading // for file:// URLs (per file URI spec, both are valid)
  const cleaned = rawPath.startsWith('//') ? rawPath.slice(2) : rawPath;

  let absPath: string;
  if (path.isAbsolute(cleaned)) {
    absPath = cleaned;
  } else {
    // Prisma resolves relative SQLite paths against the schema directory
    // (<root>/prisma/), NOT the repo root. We must match that, otherwise we
    // mutate DATABASE_URL to a wrong absolute path and Prisma can't open the
    // DB. We're in build/utils/dbBootstrap.js (or src/utils during tsx/dev),
    // so two levels up is the repo root, plus 'prisma' for the schema dir.
    const repoRoot = path.resolve(__dirname, '../..');
    const prismaRelative = path.resolve(repoRoot, 'prisma', cleaned);
    const rootRelative = path.resolve(repoRoot, cleaned);
    // Prefer the Prisma-style resolution (matches what Prisma itself does).
    // Fall back to repo-root resolution only if the Prisma path doesn't exist
    // but the root path does — handles users who set absolute-feeling relatives.
    if (fs.existsSync(prismaRelative) || !fs.existsSync(rootRelative)) {
      absPath = prismaRelative;
    } else {
      absPath = rootRelative;
    }
    // Rewrite so every consumer sees the same absolute path.
    process.env.DATABASE_URL = `file:${absPath}`;
  }

  if (!fs.existsSync(absPath)) {
    // SQLite will lazily create a fresh DB if missing. That's almost never
    // what the user wants in production — point them at the expected location.
    // We do NOT throw here, just warn loudly; the migration tooling needs to
    // be able to create the file.
    // eslint-disable-next-line no-console
    console.error(
      `[bootstrap] DATABASE_URL points at a missing file: ${absPath}. ` +
      `Prisma will create an empty DB on first query — if that's not intended, ` +
      `check the path or copy in your existing .cache/fantom.db.`
    );
  }
}

/**
 * Classify a Prisma/SQLite error for the assistant. Returns a one-line hint
 * the user can act on; falls through to the original message otherwise.
 */
export function classifyDbError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const msg = err.message;
  const name = err.name;

  if (name === 'PrismaClientInitializationError' || msg.includes('Can\'t reach database server')) {
    return 'Database not reachable. Check DATABASE_URL points to an existing SQLite file.';
  }
  if (msg.includes('SQLITE_BUSY') || msg.includes('database is locked')) {
    return 'Database is locked by another process. Stop conflicting servers (e.g. dashboard dev + MCP) and retry.';
  }
  if (msg.includes('no such table')) {
    return 'Schema mismatch — run `DATABASE_URL=file:/abs/path npx prisma db push` to sync the live DB to schema.prisma.';
  }
  if (msg.includes('SQLITE_CANTOPEN') || msg.includes('unable to open database')) {
    return 'Cannot open the SQLite file. The DATABASE_URL path likely doesn\'t exist or isn\'t writable.';
  }
  if (msg.includes('UNIQUE constraint failed')) {
    return `Unique constraint violated: ${msg}`;
  }
  return msg;
}

/**
 * Resolve `projectId` from either an explicit numeric id or a project name.
 * Throws clearly when neither is provided, or when the name doesn't match.
 * Use at the top of any tool handler that scopes by project.
 */
export async function resolveProjectId(
  prisma: { fantomProject: { findUnique: (args: any) => Promise<{ id: number } | null> } },
  args: { projectId?: number; projectName?: string },
): Promise<number | undefined> {
  if (typeof args.projectId === 'number') return args.projectId;
  if (!args.projectName) return undefined;
  const row = await prisma.fantomProject.findUnique({
    where: { name: args.projectName },
    select: { id: true },
  });
  if (!row) {
    throw new Error(`Project not found: "${args.projectName}". Use listFantomProjects to find the right name.`);
  }
  return row.id;
}

/**
 * Wrap a tool handler body so any thrown DB error is returned as a structured
 * MCP tool result instead of bubbling up as a stack trace. Use inside case
 * handlers that touch Prisma:
 *
 *   case 'foo': return wrapDbErrors('foo', async () => { ... });
 */
export async function wrapDbErrors<T>(
  toolName: string,
  fn: () => Promise<T>,
): Promise<T | { content: Array<{ type: 'text'; text: string }> }> {
  try {
    return await fn();
  } catch (err) {
    const hint = classifyDbError(err);
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(
          {
            error: 'database query failed',
            tool: toolName,
            message,
            hint,
          },
          null,
          2,
        ),
      }],
    };
  }
}
