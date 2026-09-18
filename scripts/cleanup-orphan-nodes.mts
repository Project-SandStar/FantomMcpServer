#!/usr/bin/env tsx
/**
 * One-shot cleanup: delete LadybugDB nodes whose project_id no longer exists
 * in Prisma fantom_projects. Surfaces orphan rows left behind by failed
 * removeFantomProject cascades (task #21).
 */
import { ladybugQuery, ladybugExecute } from '../src/graph/ladybugConnection.js';
import { getPrismaClient } from '../src/db/prisma.js';

async function main() {
  const prisma = getPrismaClient();
  const projects = await prisma.fantomProject.findMany({ select: { id: true } });
  const liveIds = new Set(projects.map((p) => p.id));

  const projectsInGraph = await ladybugQuery<{ pid: number; cnt: number }>(
    `MATCH (n:CodeNode) RETURN DISTINCT n.project_id AS pid, count(n) AS cnt`,
  );
  const orphans = projectsInGraph.filter((r) => !liveIds.has(Number(r.pid)));

  if (orphans.length === 0) {
    console.log('no orphan project_id values in graph — clean');
    return;
  }

  console.log('orphan projects in graph:');
  for (const o of orphans) console.log('  pid=%s nodes=%s', o.pid, o.cnt);

  for (const o of orphans) {
    const pid = Number(o.pid);
    // Delete edges first (Kuzu doesn't auto-cascade), then nodes.
    await ladybugExecute(
      `MATCH (a:CodeNode {project_id: ${pid}})-[e:CodeEdge]->(b:CodeNode) DELETE e`,
    );
    await ladybugExecute(
      `MATCH (a:CodeNode)-[e:CodeEdge]->(b:CodeNode {project_id: ${pid}}) DELETE e`,
    );
    await ladybugExecute(
      `MATCH (n:CodeNode {project_id: ${pid}}) DELETE n`,
    );
    console.log('cleared orphan pid=%s', pid);
  }
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
