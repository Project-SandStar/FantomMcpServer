/**
 * Test building the code graph for a project
 */

async function main() {
  const { createAgentFramework } = await import('../build/agents/index.js');
  const { getPrismaClient } = await import('../build/db/prisma.js');

  console.log('Creating agent framework...');
  const framework = createAgentFramework({});

  console.log('Initializing...');
  await framework.initialize();

  // Get first project from database
  const prisma = getPrismaClient();
  const projects = await prisma.fantomProject.findMany({ take: 3 });

  if (projects.length === 0) {
    console.log('No projects found in database');
    await framework.shutdown();
    return;
  }

  console.log(`\nFound ${projects.length} projects:`);
  projects.forEach(p => console.log(`  - [${p.id}] ${p.name} (${p.path})`));

  const testProject = projects[0];
  console.log(`\n=== Building graph for project: ${testProject.name} (ID: ${testProject.id}) ===\n`);

  // Test buildProjectGraph
  console.log('1. Building project graph...');
  try {
    const result = await framework.graphAnalysis.executeTool('buildProjectGraph', {
      projectId: testProject.id,
      rebuildEmbeddings: false
    });
    console.log('   Result:', result.success ? 'SUCCESS' : 'FAILED');
    if (result.error) console.log('   Error:', result.error);
    if (result.data?.content?.[0]?.text) {
      console.log('   Output:\n', result.data.content[0].text);
    }
  } catch (e) {
    console.log('   Error:', e.message);
  }

  // Check graph stats after build
  console.log('\n2. Checking graph stats...');
  try {
    const result = await framework.graphAnalysis.executeTool('getGraphStats', {
      projectId: testProject.id
    });
    console.log('   Result:', result.success ? 'SUCCESS' : 'FAILED');
    if (result.data?.content?.[0]?.text) {
      console.log('   Output:\n', result.data.content[0].text);
    }
  } catch (e) {
    console.log('   Error:', e.message);
  }

  console.log('\n=== Done ===');
  await framework.shutdown();
  await prisma.$disconnect();
}

main().catch(console.error);
