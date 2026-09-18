#!/usr/bin/env tsx
import { ladybugQuery } from '../src/graph/ladybugConnection.js';

async function main() {
  const projectId = parseInt(process.argv[2] || '270', 10);
  const cnt = await ladybugQuery(`MATCH (n:CodeNode {project_id: ${projectId}}) RETURN count(n) AS cnt`);
  console.log('node count:', JSON.stringify(cnt));
  const byType = await ladybugQuery(`MATCH (n:CodeNode {project_id: ${projectId}}) RETURN n.node_type AS t, count(n) AS c`);
  console.log('by type:', JSON.stringify(byType));
  const sample = await ladybugQuery(`MATCH (n:CodeNode {project_id: ${projectId}}) RETURN n.name, n.qualified_name, n.node_type LIMIT 10`);
  console.log('sample:', JSON.stringify(sample, null, 2));
  const edges = await ladybugQuery(`MATCH (n:CodeNode {project_id: ${projectId}})-[e:CodeEdge]->(m:CodeNode) RETURN count(e) AS cnt`);
  console.log('edges from project:', JSON.stringify(edges));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e); process.exit(1)});
