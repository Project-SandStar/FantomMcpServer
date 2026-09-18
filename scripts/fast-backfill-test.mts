// Stand-alone reproduction of runFastBackfill() in src/admin/routes.ts.
// Useful for timing + debugging without going through the HTTP layer.
import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import {
  closeLadybugConnection,
  getLadybugConnection,
  ladybugQuery,
} from '/path/to/mcpfantom/build/graph/ladybugConnection.js';

const t0 = Date.now();
const prismaDbPath = path.join(process.cwd(), '.cache', 'fantom.db');
const graphDbPath = path.join(process.cwd(), '.cache', 'fantom-graph.db');
const tmpDir = path.join(process.cwd(), '.cache', 'ladybug-backfill-tmp');
const edgesCsv = path.join(tmpDir, 'edges.csv');

const timing: Record<string, number> = {};

await closeLadybugConnection();
if (fs.existsSync(graphDbPath)) fs.rmSync(graphDbPath, { recursive: true, force: true });
if (fs.existsSync(graphDbPath + '.wal')) fs.rmSync(graphDbPath + '.wal');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
timing.prepMs = Date.now() - t0;
console.log(`prep: ${timing.prepMs}ms`);

// Dump edges → CSV. We filter orphan edges (source/target missing in
// code_nodes) client-side — the SQLite correlated subquery version was
// O(edges × nodes) and hit 160B comparisons on this dataset.
const t2 = Date.now();
const sqlite = new Database(prismaDbPath, { readonly: true });

const validIds = new Set<string>();
for (const row of sqlite.prepare('SELECT id FROM code_nodes').iterate() as Iterable<{ id: string }>) {
  validIds.add(row.id);
}

const edgeStmt = sqlite.prepare(`
  SELECT source_id, target_id, edge_type,
         COALESCE(line_number, 0) AS line_number,
         COALESCE(col_number, 0) AS col_number,
         CASE WHEN is_resolved = 1 THEN 'true' ELSE 'false' END AS is_resolved,
         COALESCE(metadata, '') AS metadata
  FROM code_edges
`);
const csvStream = fs.createWriteStream(edgesCsv, { encoding: 'utf8' });
csvStream.write('source_id,target_id,edge_type,line_number,col_number,is_resolved,confidence,metadata\n');
let dumped = 0;
let orphans = 0;
const escapeCsv = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
};
for (const row of edgeStmt.iterate() as Iterable<Record<string, unknown>>) {
  if (!validIds.has(row.source_id as string) || !validIds.has(row.target_id as string)) {
    orphans++;
    continue;
  }
  csvStream.write(
    [
      escapeCsv(row.source_id), escapeCsv(row.target_id), escapeCsv(row.edge_type),
      String(row.line_number ?? 0), String(row.col_number ?? 0),
      String(row.is_resolved), '1.0', escapeCsv(row.metadata),
    ].join(',') + '\n'
  );
  dumped++;
}
await new Promise<void>((resolve, reject) => csvStream.end((err: NodeJS.ErrnoException | null | undefined) => err ? reject(err) : resolve()));
sqlite.close();
timing.dumpEdgesMs = Date.now() - t2;
console.log(`dump ${dumped} edges: ${timing.dumpEdgesMs}ms`);

// Open Ladybug
const t3 = Date.now();
const conn = await getLadybugConnection();
const exec = async (cy: string) => {
  const r = await conn.query(cy);
  try { await (Array.isArray(r) ? r[0] : r).getAll(); } catch { /* ignore */ }
};
await exec('INSTALL sqlite');
await exec('LOAD EXTENSION sqlite');
await exec(`ATTACH '${prismaDbPath}' AS prisma_src (dbtype sqlite)`);
await exec(`CREATE NODE TABLE CodeNode(
  id STRING, project_id INT64, node_type STRING, name STRING, qualified_name STRING,
  file_path STRING, line_start INT64, line_end INT64, col_start INT64, col_end INT64,
  signature STRING, documentation STRING, return_type STRING, modifiers STRING,
  facets STRING, parent_type STRING,
  is_public BOOLEAN, is_static BOOLEAN, is_abstract BOOLEAN, is_virtual BOOLEAN,
  is_override BOOLEAN, is_exported BOOLEAN, language STRING,
  PRIMARY KEY(id)
)`);
await exec(`CREATE REL TABLE CodeEdge(
  FROM CodeNode TO CodeNode,
  edge_type STRING, line_number INT64, col_number INT64,
  is_resolved BOOLEAN, confidence DOUBLE, metadata STRING
)`);
timing.schemaMs = Date.now() - t3;
console.log(`schema: ${timing.schemaMs}ms`);

// COPY nodes
const t4 = Date.now();
await exec(`COPY CodeNode FROM (
  LOAD FROM prisma_src.code_nodes
  RETURN id, project_id, node_type, name, qualified_name, file_path,
         line_start, line_end, col_start, col_end,
         COALESCE(signature, '') AS signature,
         COALESCE(documentation, '') AS documentation,
         COALESCE(return_type, '') AS return_type,
         COALESCE(modifiers, '') AS modifiers,
         COALESCE(facets, '') AS facets,
         COALESCE(parent_type, '') AS parent_type,
         (is_public = 1) AS is_public,
         (is_static = 1) AS is_static,
         (is_abstract = 1) AS is_abstract,
         (is_virtual = 1) AS is_virtual,
         (is_override = 1) AS is_override,
         (is_exported = 1) AS is_exported,
         COALESCE(language, 'fantom') AS language
)`);
timing.copyNodesMs = Date.now() - t4;
console.log(`copy nodes: ${timing.copyNodesMs}ms`);

// COPY edges
const t5 = Date.now();
await exec(`COPY CodeEdge FROM '${edgesCsv}' (HEADER=true)`);
timing.copyEdgesMs = Date.now() - t5;
console.log(`copy edges: ${timing.copyEdgesMs}ms`);

const nc = await ladybugQuery<{ c: number }>('MATCH (n:CodeNode) RETURN count(n) AS c');
const ec = await ladybugQuery<{ c: number }>('MATCH ()-[e:CodeEdge]->() RETURN count(e) AS c');
console.log(`FINAL: nodes=${nc[0]?.c}  edges=${ec[0]?.c}`);
console.log(`total: ${Date.now() - t0}ms`);

// cleanup
fs.unlinkSync(edgesCsv);
fs.rmdirSync(tmpDir);
await closeLadybugConnection();
process.exit(0);
