#!/usr/bin/env node
/**
 * One-shot migration: shared LadybugDB → per-project DBs.
 *
 * Reads .cache/fantom-graph.db (the legacy shared graph) and copies every
 * project's nodes + edges into .cache/graph/<projectId>.db (the new layout).
 *
 * Idempotent. After success, the old DB is renamed with a timestamp suffix
 * so it can be removed manually once you've verified per-project DBs work.
 *
 * Usage:
 *   node scripts/migrate-shared-graph.mjs
 *   node scripts/migrate-shared-graph.mjs --dry-run
 *
 * Pre-conditions:
 *   - The fantom-mcp HTTP server must be STOPPED (Kuzu holds an exclusive
 *     file lock; this script needs read access to the legacy DB and write
 *     access to the per-project DBs).
 *   - DATABASE_URL must point at the active prisma/fantom.db (used only to
 *     enumerate live project IDs; not modified).
 *
 * Failure modes:
 *   - "Could not set lock on file" → server is running. Stop it first.
 *   - "Table CodeNode does not exist" → the legacy DB is already empty;
 *     nothing to migrate.
 *   - Mid-migration crash → rerun. The script does no destructive deletes
 *     until the end; the old DB rename only happens on full success.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const cacheDir = path.join(repoRoot, '.cache');
const oldDbPath = path.join(cacheDir, 'fantom-graph.db');
const newDir = path.join(cacheDir, 'graph');

const dryRun = process.argv.includes('--dry-run');

if (!fs.existsSync(oldDbPath)) {
  console.log(`[migrate] Legacy ${oldDbPath} not found — nothing to migrate.`);
  process.exit(0);
}

const oldPidfile = `${oldDbPath}.pid`;
if (fs.existsSync(oldPidfile)) {
  const recorded = parseInt(fs.readFileSync(oldPidfile, 'utf-8').trim(), 10);
  let alive = false;
  try { process.kill(recorded, 0); alive = true; } catch { alive = false; }
  if (alive) {
    console.error(
      `[migrate] FATAL: another fantom-mcp process (PID ${recorded}) holds ` +
      `the legacy graph DB lock. Stop it first.`,
    );
    process.exit(1);
  }
  // stale pidfile — remove
  try { fs.unlinkSync(oldPidfile); } catch { /* */ }
}

if (!fs.existsSync(newDir)) {
  if (!dryRun) fs.mkdirSync(newDir, { recursive: true });
  console.log(`[migrate] Created ${newDir}`);
}

const { Database, Connection } = await import('@ladybugdb/core');

const oldDb = new Database(oldDbPath);
await oldDb.init();
const oldConn = new Connection(oldDb);
await oldConn.init();

const queryAll = async (cypher) => {
  const r = await oldConn.query(cypher);
  const qr = Array.isArray(r) ? r[0] : r;
  return qr.getAll();
};

let projectIds;
try {
  const rows = await queryAll('MATCH (n:CodeNode) RETURN DISTINCT n.project_id AS pid');
  projectIds = rows.map((r) => Number(r.pid)).filter((p) => Number.isFinite(p));
} catch (err) {
  if (String(err).includes('does not exist')) {
    console.log('[migrate] Legacy DB has no CodeNode table — nothing to migrate.');
    process.exit(0);
  }
  throw err;
}

console.log(`[migrate] Found ${projectIds.length} project(s) in legacy DB: [${projectIds.join(', ')}]`);

const SCHEMA_DDL = [
  `CREATE NODE TABLE IF NOT EXISTS CodeNode(
    id STRING, project_id INT64, node_type STRING, name STRING, qualified_name STRING,
    file_path STRING, line_start INT64, line_end INT64, col_start INT64, col_end INT64,
    signature STRING, documentation STRING, return_type STRING, modifiers STRING,
    facets STRING, parent_type STRING, is_public BOOLEAN, is_static BOOLEAN,
    is_abstract BOOLEAN, is_virtual BOOLEAN, is_override BOOLEAN, is_exported BOOLEAN,
    language STRING, PRIMARY KEY(id))`,
  `CREATE REL TABLE IF NOT EXISTS CodeEdge(
    FROM CodeNode TO CodeNode, edge_type STRING, line_number INT64, col_number INT64,
    is_resolved BOOLEAN, confidence DOUBLE, metadata STRING)`,
];

const escStr = (v) => (v == null ? '' : String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'"));

let totalNodes = 0;
let totalEdges = 0;

for (const pid of projectIds) {
  const targetPath = path.join(newDir, `${pid}.db`);
  console.log(`[migrate] Project ${pid} → ${targetPath}${dryRun ? ' (dry-run)' : ''}`);

  if (dryRun) {
    const cnt = await queryAll(`MATCH (n:CodeNode {project_id: ${pid}}) RETURN count(n) AS c`);
    const ec = await queryAll(`MATCH (a:CodeNode {project_id: ${pid}})-[e:CodeEdge]->(b:CodeNode {project_id: ${pid}}) RETURN count(e) AS c`);
    console.log(`           would migrate ${cnt[0]?.c ?? 0} nodes, ${ec[0]?.c ?? 0} edges`);
    continue;
  }

  // Per-project DB
  const newDb = new Database(targetPath);
  await newDb.init();
  const newConn = new Connection(newDb);
  await newConn.init();
  for (const ddl of SCHEMA_DDL) {
    try { await newConn.query(ddl); } catch (err) {
      if (!String(err).includes('already exists')) throw err;
    }
  }

  // Copy nodes
  const nodes = await queryAll(
    `MATCH (n:CodeNode {project_id: ${pid}})
     RETURN n.id AS id, n.project_id AS pid, n.node_type AS nt, n.name AS name,
            n.qualified_name AS qn, n.file_path AS fp, n.line_start AS ls,
            n.line_end AS le, n.col_start AS cs, n.col_end AS ce,
            n.signature AS sig, n.documentation AS doc, n.return_type AS rt,
            n.modifiers AS mod, n.facets AS facets, n.parent_type AS pt,
            n.is_public AS pub, n.is_static AS stat, n.is_abstract AS abs,
            n.is_virtual AS vir, n.is_override AS ovr, n.is_exported AS exp,
            n.language AS lang`,
  );
  for (const n of nodes) {
    const cypher = `CREATE (n:CodeNode {
      id: '${escStr(n.id)}', project_id: ${Number(n.pid)},
      node_type: '${escStr(n.nt)}', name: '${escStr(n.name)}',
      qualified_name: '${escStr(n.qn)}', file_path: '${escStr(n.fp)}',
      line_start: ${Number(n.ls) || 1}, line_end: ${Number(n.le) || 1},
      col_start: ${Number(n.cs) || 0}, col_end: ${Number(n.ce) || 0},
      signature: '${escStr(n.sig)}', documentation: '${escStr(n.doc)}',
      return_type: '${escStr(n.rt)}', modifiers: '${escStr(n.mod)}',
      facets: '${escStr(n.facets)}', parent_type: '${escStr(n.pt)}',
      is_public: ${!!n.pub}, is_static: ${!!n.stat}, is_abstract: ${!!n.abs},
      is_virtual: ${!!n.vir}, is_override: ${!!n.ovr}, is_exported: ${!!n.exp},
      language: '${escStr(n.lang) || 'fantom'}'
    })`;
    try { await newConn.query(cypher); } catch (err) {
      if (!String(err).includes('duplicated primary key')) throw err;
    }
  }
  totalNodes += nodes.length;

  // Copy edges
  const edges = await queryAll(
    `MATCH (a:CodeNode {project_id: ${pid}})-[e:CodeEdge]->(b:CodeNode {project_id: ${pid}})
     RETURN a.id AS sid, b.id AS tid, e.edge_type AS et, e.line_number AS ln,
            e.col_number AS cn, e.is_resolved AS ir, e.confidence AS conf, e.metadata AS meta`,
  );
  for (const e of edges) {
    const cypher = `MATCH (a:CodeNode {id: '${escStr(e.sid)}'}), (b:CodeNode {id: '${escStr(e.tid)}'})
      CREATE (a)-[:CodeEdge {
        edge_type: '${escStr(e.et)}', line_number: ${Number(e.ln) || 0},
        col_number: ${Number(e.cn) || 0}, is_resolved: ${e.ir == null ? true : !!e.ir},
        confidence: ${e.conf != null ? Number(e.conf) : 1.0},
        metadata: '${escStr(e.meta)}'
      }]->(b)`;
    try { await newConn.query(cypher); } catch { /* skip dups */ }
  }
  totalEdges += edges.length;

  try { await newConn.query('CHECKPOINT;'); } catch { /* */ }
  await newDb.close();
  console.log(`           ${nodes.length} nodes, ${edges.length} edges → done`);
}

await oldDb.close();

if (!dryRun) {
  const ts = Date.now();
  const archived = `${oldDbPath}.migrated-${ts}`;
  fs.renameSync(oldDbPath, archived);
  console.log(`\n[migrate] Migration complete: ${totalNodes} nodes, ${totalEdges} edges across ${projectIds.length} project(s).`);
  console.log(`[migrate] Legacy DB renamed to ${archived} — verify per-project DBs work, then delete.`);
} else {
  console.log(`\n[migrate] Dry run complete: ${projectIds.length} project(s) would be migrated.`);
}
