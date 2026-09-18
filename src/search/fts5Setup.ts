/**
 * FTS5 Setup Utility
 *
 * Creates and maintains FTS5 virtual tables for full-text search.
 * Since Prisma doesn't support virtual tables, we use raw SQL.
 */

import type { PrismaClient } from '@prisma/client';
import { createLogger } from '../utils/index.js';

const logger = createLogger('fts5-setup');

// ============================================
// FTS5 Table Definitions
// ============================================

const FTS5_TABLES = {
  // Code nodes FTS table
  codeNodesFts: `
    CREATE VIRTUAL TABLE IF NOT EXISTS code_nodes_fts USING fts5(
      name,
      qualified_name,
      signature,
      documentation,
      node_type,
      content='code_nodes',
      content_rowid='rowid'
    );
  `,

  // Code nodes sync triggers
  codeNodesTriggerInsert: `
    CREATE TRIGGER IF NOT EXISTS code_nodes_fts_ai AFTER INSERT ON code_nodes BEGIN
      INSERT INTO code_nodes_fts(rowid, name, qualified_name, signature, documentation, node_type)
      VALUES (NEW.rowid, NEW.name, NEW.qualified_name, NEW.signature, NEW.documentation, NEW.node_type);
    END;
  `,

  codeNodesTriggerDelete: `
    CREATE TRIGGER IF NOT EXISTS code_nodes_fts_ad AFTER DELETE ON code_nodes BEGIN
      INSERT INTO code_nodes_fts(code_nodes_fts, rowid, name, qualified_name, signature, documentation, node_type)
      VALUES('delete', OLD.rowid, OLD.name, OLD.qualified_name, OLD.signature, OLD.documentation, OLD.node_type);
    END;
  `,

  codeNodesTriggerUpdate: `
    CREATE TRIGGER IF NOT EXISTS code_nodes_fts_au AFTER UPDATE ON code_nodes BEGIN
      INSERT INTO code_nodes_fts(code_nodes_fts, rowid, name, qualified_name, signature, documentation, node_type)
      VALUES('delete', OLD.rowid, OLD.name, OLD.qualified_name, OLD.signature, OLD.documentation, OLD.node_type);
      INSERT INTO code_nodes_fts(rowid, name, qualified_name, signature, documentation, node_type)
      VALUES (NEW.rowid, NEW.name, NEW.qualified_name, NEW.signature, NEW.documentation, NEW.node_type);
    END;
  `,

  // Documentation FTS table (standalone, not content-linked)
  docsFts: `
    CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
      title,
      content,
      pod_name,
      doc_type,
      source_id UNINDEXED,
      tokenize='porter unicode61'
    );
  `
};

// ============================================
// Setup Functions
// ============================================

/**
 * Check if FTS5 tables exist
 */
export async function checkFTS5Tables(prisma: PrismaClient): Promise<{
  codeNodesFts: boolean;
  docsFts: boolean;
}> {
  const tables = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name IN ('code_nodes_fts', 'docs_fts')
  `;

  const tableNames = new Set(tables.map(t => t.name));

  return {
    codeNodesFts: tableNames.has('code_nodes_fts'),
    docsFts: tableNames.has('docs_fts')
  };
}

/**
 * Create FTS5 tables if they don't exist
 */
export async function setupFTS5Tables(prisma: PrismaClient): Promise<{
  created: string[];
  skipped: string[];
  errors: string[];
}> {
  const result = {
    created: [] as string[],
    skipped: [] as string[],
    errors: [] as string[]
  };

  // Check existing tables
  const existing = await checkFTS5Tables(prisma);

  // Create code_nodes_fts
  if (!existing.codeNodesFts) {
    try {
      await prisma.$executeRawUnsafe(FTS5_TABLES.codeNodesFts);
      await prisma.$executeRawUnsafe(FTS5_TABLES.codeNodesTriggerInsert);
      await prisma.$executeRawUnsafe(FTS5_TABLES.codeNodesTriggerDelete);
      await prisma.$executeRawUnsafe(FTS5_TABLES.codeNodesTriggerUpdate);
      result.created.push('code_nodes_fts');
      logger.info('Created code_nodes_fts table with sync triggers');
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      result.errors.push(`code_nodes_fts: ${errMsg}`);
      logger.error(`Failed to create code_nodes_fts: ${errMsg}`);
    }
  } else {
    result.skipped.push('code_nodes_fts');
  }

  // Create docs_fts
  if (!existing.docsFts) {
    try {
      await prisma.$executeRawUnsafe(FTS5_TABLES.docsFts);
      result.created.push('docs_fts');
      logger.info('Created docs_fts table');
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      result.errors.push(`docs_fts: ${errMsg}`);
      logger.error(`Failed to create docs_fts: ${errMsg}`);
    }
  } else {
    result.skipped.push('docs_fts');
  }

  return result;
}

/**
 * Rebuild FTS5 index for code nodes
 * Call this after bulk inserts or if index becomes stale
 */
export async function rebuildCodeNodesFTS(prisma: PrismaClient): Promise<number> {
  logger.info('Rebuilding code_nodes_fts index...');

  // Clear existing FTS data
  await prisma.$executeRawUnsafe(`DELETE FROM code_nodes_fts`);

  // Repopulate from code_nodes table
  await prisma.$executeRawUnsafe(`
    INSERT INTO code_nodes_fts(rowid, name, qualified_name, signature, documentation, node_type)
    SELECT rowid, name, qualified_name, signature, documentation, node_type
    FROM code_nodes
  `);

  const count = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(*) as count FROM code_nodes_fts
  `;

  const indexedCount = Number(count[0].count);
  logger.info(`Indexed ${indexedCount} code nodes in FTS5`);

  return indexedCount;
}

/**
 * Optimize FTS5 index (run periodically)
 */
export async function optimizeFTS5(prisma: PrismaClient): Promise<void> {
  logger.info('Optimizing FTS5 indexes...');

  await prisma.$executeRawUnsafe(`
    INSERT INTO code_nodes_fts(code_nodes_fts) VALUES('optimize')
  `);

  await prisma.$executeRawUnsafe(`
    INSERT INTO docs_fts(docs_fts) VALUES('optimize')
  `);

  logger.info('FTS5 optimization complete');
}

/**
 * Get FTS5 index statistics
 */
export async function getFTS5Stats(prisma: PrismaClient): Promise<{
  codeNodesFts: { rowCount: number; exists: boolean };
  docsFts: { rowCount: number; exists: boolean };
}> {
  const existing = await checkFTS5Tables(prisma);

  let codeNodesCount = 0;
  let docsCount = 0;

  if (existing.codeNodesFts) {
    const result = await prisma.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(*) as count FROM code_nodes_fts
    `;
    codeNodesCount = Number(result[0].count);
  }

  if (existing.docsFts) {
    const result = await prisma.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(*) as count FROM docs_fts
    `;
    docsCount = Number(result[0].count);
  }

  return {
    codeNodesFts: { rowCount: codeNodesCount, exists: existing.codeNodesFts },
    docsFts: { rowCount: docsCount, exists: existing.docsFts }
  };
}
