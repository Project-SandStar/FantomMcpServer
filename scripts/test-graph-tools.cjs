// Test that graph tools are exposed via the agent framework

async function main() {
  const { createAgentFramework } = await import('../build/agents/index.js');

  // Create framework
  const framework = createAgentFramework({});

  // Initialize
  await framework.initialize();

  // Get all tools
  const tools = framework.getAllTools();

  console.log(`Total tools available: ${tools.length}\n`);

  // Find graph tools
  const graphTools = tools.filter(t =>
    t.name.includes('Caller') ||
    t.name.includes('Callee') ||
    t.name.includes('Impact') ||
    t.name.includes('semantic') ||
    t.name.includes('Similar') ||
    t.name.includes('Graph') ||
    t.name.includes('Path') ||
    t.name === 'buildProjectGraph' ||
    t.name === 'buildProjectEmbeddings'
  );

  console.log(`Graph analysis tools found: ${graphTools.length}`);
  console.log('\nGraph Tools:');
  graphTools.forEach(t => {
    console.log(`  - ${t.name}`);
    console.log(`    ${t.description.substring(0, 80)}...`);
  });

  // Shutdown
  await framework.shutdown();
}

main().catch(console.error);
