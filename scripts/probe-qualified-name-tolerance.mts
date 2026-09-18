#!/usr/bin/env tsx
/**
 * Verify the tolerant getFunctionByQualifiedName lookup added in round 4.
 * Tests three call shapes against the same TS symbol to ensure each resolves:
 *   1. Exact stored shape: <filePath>::Class.method
 *   2. Pod-prefixed alias:  <projectName>::Class.method
 *   3. Bare suffix:         Class.method
 */
import { getFantomCodeIndexer } from '../src/fantom-code/indexer.js';

async function main() {
  // Hydrate from LadybugDB so the indexer has TS symbols.
  const { getCodeIndexingService } = await import('../src/fantom-code/codeIndexingService.js');
  const { getPrismaClient } = await import('../src/db/prisma.js');
  const prisma = getPrismaClient();
  const svc = getCodeIndexingService(prisma);
  // The hydrate helper is private; force a stale-check refresh through the
  // public path so it runs.
  const proj = await prisma.fantomProject.findFirst({ where: { name: 'SoundSuite' } });
  if (!proj) throw new Error('SoundSuite not found');
  await (svc as any).indexProject({
    ...proj,
    podMeta: undefined,
    functionCount: 0,
    typeCount: 0,
  });

  const indexer = getFantomCodeIndexer();

  const cases = [
    '~/Code/court-lens-mcp/src/services/__tests__/worker-pool-integration.test.ts::MockRedis.ping',
    'SoundSuite::MockRedis.ping',
    'MockRedis.ping',
  ];
  for (const qn of cases) {
    const fn = indexer.getFunctionByQualifiedName(qn);
    console.log(`${fn ? 'OK ' : 'FAIL'}  ${qn} → ${fn?.qualifiedName ?? 'not found'}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
