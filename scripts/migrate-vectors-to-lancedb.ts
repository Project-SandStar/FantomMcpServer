#!/usr/bin/env tsx
/**
 * One-time migration script: moves vectors from SQLite code_vectors table to LanceDB
 *
 * Usage: npx tsx scripts/migrate-vectors-to-lancedb.ts
 *
 * Reads from the old code_vectors table (via better-sqlite3 directly, since
 * the Prisma model has been removed) and writes to LanceDB at .cache/fantomvector.db.
 */

import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import { connect } from '@lancedb/lancedb';

const CACHE_DIR = path.join(process.cwd(), '.cache');
const SQLITE_PATH = path.join(CACHE_DIR, 'fantom.db');
const LANCE_PATH = path.join(CACHE_DIR, 'fantomvector.db');
const TABLE_NAME = 'code_vectors';
const BATCH_SIZE = 500;

interface OldVectorRow {
  id: string;
  node_id: string;
  embedding: Buffer;
  model: string;
  dimensions: number;
  created_at: string;
}

interface CodeNodeRow {
  id: string;
  project_id: number;
  node_type: string;
}

async function main() {
  // Check if SQLite DB exists
  if (!fs.existsSync(SQLITE_PATH)) {
    console.error(`SQLite database not found at ${SQLITE_PATH}`);
    process.exit(1);
  }

  const db = new Database(SQLITE_PATH, { readonly: true });

  // Check if old table exists
  const tableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='code_vectors'"
  ).get();

  if (!tableExists) {
    console.log('No code_vectors table found in SQLite. Nothing to migrate.');
    db.close();
    process.exit(0);
  }

  // Count rows to migrate
  const { count } = db.prepare('SELECT COUNT(*) as count FROM code_vectors').get() as { count: number };
  console.log(`Found ${count} vectors to migrate from SQLite to LanceDB`);

  if (count === 0) {
    console.log('Nothing to migrate.');
    db.close();
    process.exit(0);
  }

  // Build a lookup map for code_node -> project_id, node_type
  const nodeRows = db.prepare('SELECT id, project_id, node_type FROM code_nodes').all() as CodeNodeRow[];
  const nodeMap = new Map<string, CodeNodeRow>();
  for (const row of nodeRows) {
    nodeMap.set(row.id, row);
  }
  console.log(`Loaded ${nodeMap.size} code_node records for denormalization`);

  // Connect to LanceDB
  const conn = await connect(LANCE_PATH);
  const existingTables = await conn.tableNames();

  let table;
  if (existingTables.includes(TABLE_NAME)) {
    table = await conn.openTable(TABLE_NAME);
    const existingCount = await table.countRows();
    console.log(`LanceDB table already exists with ${existingCount} rows`);
  } else {
    // Create with initial dummy row to set schema
    table = await conn.createTable(TABLE_NAME, [{
      node_id: '__init__',
      vector: new Array(384).fill(0),
      project_id: 0,
      node_type: '__init__',
      model: '__init__',
      dimensions: 384,
      created_at: new Date().toISOString(),
    }]);
    await table.delete("node_id = '__init__'");
    console.log('Created LanceDB table');
  }

  // Migrate in batches
  let migrated = 0;
  let skipped = 0;
  let offset = 0;

  const stmt = db.prepare(`SELECT * FROM code_vectors LIMIT ? OFFSET ?`);

  while (offset < count) {
    const batch = stmt.all(BATCH_SIZE, offset) as OldVectorRow[];
    if (batch.length === 0) break;

    const records: Array<Record<string, unknown>> = [];

    for (const row of batch) {
      const node = nodeMap.get(row.node_id);
      if (!node) {
        skipped++;
        continue;
      }

      // Convert embedding Buffer to float array
      const embedding = row.embedding;
      const dims = row.dimensions || 384;
      const floats = new Float32Array(embedding.buffer, embedding.byteOffset, dims);

      records.push({
        node_id: row.node_id,
        vector: Array.from(floats),
        project_id: node.project_id,
        node_type: node.node_type,
        model: row.model || 'all-MiniLM-L6-v2',
        dimensions: dims,
        created_at: row.created_at || new Date().toISOString(),
      });
    }

    if (records.length > 0) {
      await table.add(records);
      migrated += records.length;
    }

    offset += batch.length;
    process.stdout.write(`\rMigrated ${migrated}/${count} (${skipped} skipped)`);
  }

  console.log(`\nMigration complete: ${migrated} vectors migrated, ${skipped} skipped`);

  // Verify
  const lanceCount = await table.countRows();
  console.log(`LanceDB now has ${lanceCount} vectors`);

  db.close();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
