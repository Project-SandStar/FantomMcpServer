import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

// Get the most recent admin-reindex run
const run = await p.indexRun.findFirst({
  where: { projectId: 271, trigger: 'admin-reindex' },
  orderBy: { startedAt: 'desc' }
});

console.log('Most recent admin-reindex:');
console.log(`  Started: ${run.startedAt}`);
console.log(`  filesScanned: ${run.filesScanned}`);
console.log(`  filesParsed: ${run.filesParsed}`);
console.log(`  filesSkipped: ${run.filesSkipped}`);
console.log(`  Added: ${run.addedCount}, Modified: ${run.modifiedCount}, Removed: ${run.removedCount}`);
console.log(`  Duration: ${run.durationMs}ms`);
console.log(`  isSeedingRun: ${run.isSeedingRun}`);
console.log(`  force: ${run.force}`);

// Count parsed vs unparsed files
const parsed = await p.indexedFile.count({
  where: { projectId: 271, wasParsed: true }
});
const unparsed = await p.indexedFile.count({
  where: { projectId: 271, wasParsed: { not: true } }
});

console.log('\nIndexedFile status:');
console.log(`  Parsed: ${parsed}`);
console.log(`  Not parsed: ${unparsed}`);

// Check all IndexedFile records to see if wasParsed is ever true
const allFiles = await p.indexedFile.findMany({
  where: { projectId: 271 },
  select: { filePath: true, wasParsed: true },
  take: 5
});
console.log('\nSample IndexedFile records:');
allFiles.forEach(f => console.log(`  ${f.filePath}: wasParsed=${f.wasParsed}`));

await p.$disconnect();
