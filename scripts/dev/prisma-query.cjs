const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  try {
    const proj = await p.fantomProject.findUnique({ where: { id: 271 } });
    console.log('Project 271:', JSON.stringify(proj, null, 2));
    
    const top = await p.fantomProject.findMany({
      where: { functionCount: { gt: 0 } },
      orderBy: { functionCount: 'desc' },
      take: 5
    });
    console.log('\nTop 5 projects by function_count:');
    top.forEach(x => console.log(`  ${x.name}: ${x.functionCount}`));
    
    const runs = await p.indexRun.findMany({
      where: { projectId: 271 },
      orderBy: { startedAt: 'desc' },
      take: 3
    });
    console.log('\nRecent runs for 271:');
    runs.forEach(r => {
      const start = new Date(r.startedAt).toISOString();
      console.log(`  ${start}: trigger=${r.trigger}, added=${r.addedCount}, mod=${r.modifiedCount}`);
    });
  } finally {
    await p.$disconnect();
  }
})();
