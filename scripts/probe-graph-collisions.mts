#!/usr/bin/env tsx
import { ladybugQuery } from '../src/graph/ladybugConnection.js';

async function main() {
  // Check if any nodes share file paths with SoundSuite (court-lens-mcp).
  const collisions = await ladybugQuery<{ pid: number; cnt: number }>(
    `MATCH (n:CodeNode) WHERE n.file_path STARTS WITH '~/Code/court-lens-mcp' RETURN n.project_id AS pid, count(n) AS cnt`,
  );
  console.log('nodes with court-lens-mcp file path, by project:');
  console.log(JSON.stringify(collisions, null, 2));

  // Total node count
  const total = await ladybugQuery<{ cnt: number }>(
    `MATCH (n:CodeNode) RETURN count(n) AS cnt`,
  );
  console.log('\ntotal LadybugDB nodes:', total[0]?.cnt);

  // Top-N projects by node count
  const top = await ladybugQuery<{ pid: number; cnt: number }>(
    `MATCH (n:CodeNode) RETURN n.project_id AS pid, count(n) AS cnt ORDER BY cnt DESC LIMIT 5`,
  );
  console.log('\ntop 5 projects by node count:', JSON.stringify(top));
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
