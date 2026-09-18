/**
 * Test graph tool execution directly
 */

async function main() {
  const { createAgentFramework } = await import('../build/agents/index.js');

  console.log('Creating agent framework...');
  const framework = createAgentFramework({});

  console.log('Initializing...');
  await framework.initialize();

  console.log('\n=== Testing Graph Tools ===\n');

  // Test 1: getGraphStats
  console.log('1. Testing getGraphStats...');
  try {
    const result = await framework.graphAnalysis.executeTool('getGraphStats', {});
    console.log('   Result:', result.success ? 'SUCCESS' : 'FAILED');
    if (result.data?.content?.[0]?.text) {
      console.log('   Output:', result.data.content[0].text.substring(0, 200));
    }
  } catch (e) {
    console.log('   Error:', e.message);
  }

  // Test 2: getMostCalledFunctions
  console.log('\n2. Testing getMostCalledFunctions (projectId: 1)...');
  try {
    const result = await framework.graphAnalysis.executeTool('getMostCalledFunctions', { projectId: 1 });
    console.log('   Result:', result.success ? 'SUCCESS' : 'FAILED');
    if (result.error) console.log('   Error:', result.error);
    if (result.data?.content?.[0]?.text) {
      console.log('   Output:', result.data.content[0].text.substring(0, 200));
    }
  } catch (e) {
    console.log('   Error:', e.message);
  }

  // Test 3: semanticCodeSearch
  console.log('\n3. Testing semanticCodeSearch (query: "parse json")...');
  try {
    const result = await framework.graphAnalysis.executeTool('semanticCodeSearch', {
      query: 'parse json',
      limit: 5
    });
    console.log('   Result:', result.success ? 'SUCCESS' : 'FAILED');
    if (result.error) console.log('   Error:', result.error);
    if (result.data?.content?.[0]?.text) {
      console.log('   Output:', result.data.content[0].text.substring(0, 300));
    }
  } catch (e) {
    console.log('   Error:', e.message);
  }

  // Test 4: getCallers
  console.log('\n4. Testing getCallers (qualifiedName: "sys::Str.toInt")...');
  try {
    const result = await framework.graphAnalysis.executeTool('getCallers', {
      qualifiedName: 'sys::Str.toInt',
      maxDepth: 2
    });
    console.log('   Result:', result.success ? 'SUCCESS' : 'FAILED');
    if (result.error) console.log('   Error:', result.error);
    if (result.data?.content?.[0]?.text) {
      console.log('   Output:', result.data.content[0].text.substring(0, 300));
    }
  } catch (e) {
    console.log('   Error:', e.message);
  }

  console.log('\n=== Tests Complete ===\n');

  await framework.shutdown();
}

main().catch(console.error);
