/**
 * Database Module
 *
 * Exports Prisma client and database utilities.
 */

export {
  getPrismaClient,
  disconnectPrisma,
  resetPrismaClient,
  PrismaClient,
} from './prisma.js';

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
} from './prisma.js';
