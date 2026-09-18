#!/usr/bin/env tsx
/**
 * One-time migration script: copies graph data from Prisma SQLite to LadybugDB
 *
 * Usage: npx tsx scripts/migrate-prisma-to-ladybug.ts
 *
 * Reads from .cache/fantom.db (code_nodes + code_edges tables via better-sqlite3)
 * and writes to LadybugDB at .cache/fantom-graph.db via Cypher CREATE.
 */

import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';

const CACHE_DIR = path.join(process.cwd(), '.cache');
const SQLITE_PATH = path.join(CACHE_DIR, 'fantom.db');
const BATCH_SIZE = 100;

interface CodeNodeRow {
  id: string;
  project_id: number;
  node_type: string;
  name: string;
  qualified_name: string;
  file_path: string;
  line_start: number;
  line_end: number;
  col_start: number;
  col_end: number;
  signature: string | null;
  documentation: string | null;
  return_type: string | null;
  modifiers: string | null;
  facets: string | null;
  parent_type: string | null;
  is_public: number;
  is_static: number;
  is_abstract: number;
  is_virtual: number;
  is_override: number;
  is_exported: number;
  language: string | null;
}

interface CodeEdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  edge_type: string;
  line_number: number | null;
  col_number: number | null;
  is_resolved: number;
  metadata: string | null;
}

/** Escape single quotes for Cypher string literals */
function esc(val: string | null | undefined): string {
  if (val == null) return '';
  return val.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function main() {
  // --- Dynamic imports (ESM modules) ---
  const { getLadybugConnection } = await import('../src/graph/ladybugConnection.js');
  const { initLadybugSchema, clearProjectGraph } = await import('../src/graph/ladybugSchema.js');
  const { ladybugExecute, ladybugQuery } = await import('../src/graph/ladybugConnection.js');

  // Check if SQLite DB exists
  if (!fs.existsSync(SQLITE_PATH)) {
    console.error(`SQLite database not found at ${SQLITE_PATH}`);
    process.exit(1);
  }

  const db = new Database(SQLITE_PATH, { readonly: true });

  // Check if tables exist
  const nodesExist = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='code_nodes'"
  ).get();
  const edgesExist = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='code_edges'"
  ).get();

  if (!nodesExist) {
    console.log('No code_nodes table found in SQLite. Nothing to migrate.');
    db.close();
    process.exit(0);
  }

  // Count rows
  const { nodeCount } = db.prepare('SELECT COUNT(*) as nodeCount FROM code_nodes').get() as { nodeCount: number };
  const { edgeCount } = edgesExist
    ? db.prepare('SELECT COUNT(*) as edgeCount FROM code_edges').get() as { edgeCount: number }
    : { edgeCount: 0 };

  console.log(`Found ${nodeCount} nodes and ${edgeCount} edges to migrate`);

  if (nodeCount === 0) {
    console.log('Nothing to migrate.');
    db.close();
    process.exit(0);
  }

  // Initialize LadybugDB
  console.log('Initializing LadybugDB connection and schema...');
  await getLadybugConnection();
  await initLadybugSchema();

  // Get distinct project IDs
  const projects = db.prepare('SELECT DISTINCT project_id FROM code_nodes').all() as Array<{ project_id: number }>;
  console.log(`Projects to migrate: ${projects.map(p => p.project_id).join(', ')}`);

  // Clear existing graph data per project
  for (const { project_id } of projects) {
    const result = await clearProjectGraph(project_id);
    console.log(`Cleared project ${project_id}: ${result.nodesDeleted} existing nodes removed`);
  }

  // --- Migrate nodes in batches ---
  let nodesMigrated = 0;
  let nodesSkipped = 0;
  let offset = 0;

  const nodeStmt = db.prepare('SELECT * FROM code_nodes LIMIT ? OFFSET ?');

  while (offset < nodeCount) {
    const batch = nodeStmt.all(BATCH_SIZE, offset) as CodeNodeRow[];
    if (batch.length === 0) break;

    for (const row of batch) {
      try {
        await ladybugExecute(
          `CREATE (n:CodeNode {
            id: '${esc(row.id)}',
            project_id: ${row.project_id},
            node_type: '${esc(row.node_type)}',
            name: '${esc(row.name)}',
            qualified_name: '${esc(row.qualified_name)}',
            file_path: '${esc(row.file_path)}',
            line_start: ${row.line_start || 0},
            line_end: ${row.line_end || 0},
            col_start: ${row.col_start || 0},
            col_end: ${row.col_end || 0},
            signature: '${esc(row.signature)}',
            documentation: '${esc(row.documentation)}',
            return_type: '${esc(row.return_type)}',
            modifiers: '${esc(row.modifiers)}',
            facets: '${esc(row.facets)}',
            parent_type: '${esc(row.parent_type)}',
            is_public: ${row.is_public ? 'true' : 'false'},
            is_static: ${row.is_static ? 'true' : 'false'},
            is_abstract: ${row.is_abstract ? 'true' : 'false'},
            is_virtual: ${row.is_virtual ? 'true' : 'false'},
            is_override: ${row.is_override ? 'true' : 'false'},
            is_exported: ${row.is_exported ? 'true' : 'false'},
            language: '${esc(row.language || 'fantom')}'
          })`
        );
        nodesMigrated++;
      } catch (err) {
        nodesSkipped++;
        if (nodesSkipped <= 5) {
          console.warn(`  Skipped node ${row.id} (${row.qualified_name}): ${err}`);
        }
      }
    }

    offset += batch.length;
    process.stdout.write(`\rNodes: ${nodesMigrated}/${nodeCount} migrated (${nodesSkipped} skipped)`);
  }
  console.log('');

  // --- Migrate edges in batches ---
  if (!edgesExist || edgeCount === 0) {
    console.log('No edges to migrate.');
  } else {
    let edgesMigrated = 0;
    let edgesSkipped = 0;
    offset = 0;

    const edgeStmt = db.prepare('SELECT * FROM code_edges LIMIT ? OFFSET ?');

    // Collect all valid node IDs for fast lookup
    const nodeIds = new Set<string>();
    const idStmt = db.prepare('SELECT id FROM code_nodes');
    for (const row of idStmt.iterate() as Iterable<{ id: string }>) {
      nodeIds.add(row.id);
    }

    while (offset < edgeCount) {
      const batch = edgeStmt.all(BATCH_SIZE, offset) as CodeEdgeRow[];
      if (batch.length === 0) break;

      for (const row of batch) {
        // Skip edges referencing non-existent nodes
        if (!nodeIds.has(row.source_id) || !nodeIds.has(row.target_id)) {
          edgesSkipped++;
          continue;
        }

        // Determine confidence from edge type and metadata
        let confidence = 1.0;
        if (row.metadata) {
          try {
            const meta = JSON.parse(row.metadata);
            if (meta.isDynamic) confidence = 0.7;
            else if (meta.isConstructor) confidence = 0.95;
          } catch { /* ignore parse errors */ }
        }

        try {
          await ladybugExecute(
            `MATCH (a:CodeNode {id: '${esc(row.source_id)}'}), (b:CodeNode {id: '${esc(row.target_id)}'})
             CREATE (a)-[:CodeEdge {
               edge_type: '${esc(row.edge_type)}',
               line_number: ${row.line_number ?? 0},
               col_number: ${row.col_number ?? 0},
               is_resolved: ${row.is_resolved ? 'true' : 'false'},
               confidence: ${confidence},
               metadata: '${esc(row.metadata)}'
             }]->(b)`
          );
          edgesMigrated++;
        } catch (err) {
          edgesSkipped++;
          if (edgesSkipped <= 5) {
            console.warn(`  Skipped edge ${row.source_id}->${row.target_id}: ${err}`);
          }
        }
      }

      offset += batch.length;
      process.stdout.write(`\rEdges: ${edgesMigrated}/${edgeCount} migrated (${edgesSkipped} skipped)`);
    }
    console.log('');
  }

  // --- Verification ---
  console.log('\nVerification:');
  const lbNodes = await ladybugQuery<{ total: number }>(
    'MATCH (n:CodeNode) RETURN count(n) AS total'
  );
  const lbEdges = await ladybugQuery<{ total: number }>(
    'MATCH ()-[e:CodeEdge]->() RETURN count(e) AS total'
  );

  console.log(`  SQLite:    ${nodeCount} nodes, ${edgeCount} edges`);
  console.log(`  LadybugDB: ${lbNodes[0]?.total ?? 0} nodes, ${lbEdges[0]?.total ?? 0} edges`);

  const nodeMatch = (lbNodes[0]?.total ?? 0) >= nodeCount * 0.95;
  const edgeMatch = edgeCount === 0 || (lbEdges[0]?.total ?? 0) >= edgeCount * 0.8;

  if (nodeMatch && edgeMatch) {
    console.log('\nMigration successful! LadybugDB counts are within expected range.');
  } else {
    console.warn('\nWarning: Count mismatch. Some data may not have migrated.');
    console.warn('This is often due to orphaned edges or duplicate node IDs.');
  }

  db.close();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
