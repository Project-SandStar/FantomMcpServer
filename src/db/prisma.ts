/**
 * Prisma Database Client
 *
 * Singleton Prisma client for the Fantom MCP Server.
 * Handles database connections for instances, pods, compile logs,
 * projects, documentation indexes, and usage tracking.
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/index.js';

const logger = createLogger('prisma');

/**
 * Resolve the SQLite datasource URL. `DATABASE_URL` (from .env or the
 * environment) wins; otherwise default to `<cwd>/.cache/fantom.db` so a fresh
 * checkout works without any manual configuration. The parent directory is
 * created up front — SQLite reports "Unable to open the database file" (code 14)
 * when it is missing, which is exactly what a blank checkout hits.
 */
function resolveDatasourceUrl(): string {
  // Prisma resolves relative `file:` URLs against the directory holding
  // schema.prisma (./prisma), not the cwd — hence the `../`.
  const url = process.env.DATABASE_URL?.trim() || 'file:../.cache/fantom.db';
  const m = /^file:(.+)$/.exec(url);
  if (m) {
    const filePath = path.resolve(process.cwd(), 'prisma', m[1].split('?')[0]);
    try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); } catch { /* best effort */ }
    if (!fs.existsSync(filePath)) {
      logger.warn(`Database ${filePath} does not exist yet — run \`npm run db:setup\` (prisma migrate deploy) to create the schema.`);
    }
  }
  return url;
}

// Global prisma client instance
let prisma: PrismaClient | null = null;

/**
 * Get or create the Prisma client instance
 */
export function getPrismaClient(): PrismaClient {
  if (!prisma) {
    logger.debug('Initializing Prisma client');
    prisma = new PrismaClient({
      datasourceUrl: resolveDatasourceUrl(),
      log: process.env.DEBUG?.includes('prisma')
        ? ['query', 'info', 'warn', 'error']
        : [],
    });
  }
  return prisma;
}

/**
 * Disconnect and cleanup Prisma client
 */
export async function disconnectPrisma(): Promise<void> {
  if (prisma) {
    logger.debug('Disconnecting Prisma client');
    await prisma.$disconnect();
    prisma = null;
  }
}

/**
 * Reset Prisma client (for testing)
 */
export function resetPrismaClient(): void {
  if (prisma) {
    prisma.$disconnect();
    prisma = null;
  }
}

// Re-export Prisma types for convenience.
// Graph models (CodeNode, CodeEdge, UnresolvedRef, GraphBuildStats) moved to
// LadybugDB and have been removed from the Prisma schema.
export type {
  Instance,
  Pod,
  CompileLog,
  FantomProject,
  Setting,
  DocIndex,
  ToolEvent,
  SearchEvent,
  FantomBuild,
} from '@prisma/client';

// Export the client type
export { PrismaClient };
