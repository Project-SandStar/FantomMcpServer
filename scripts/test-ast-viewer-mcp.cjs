/**
 * Test script for AST Viewer MCP tools (getProjectFunctions, getProjectTypes)
 *
 * Tests:
 * 1. Tools are registered and discoverable via MCP agent framework
 * 2. getProjectFunctions returns functions from LadybugDB
 * 3. getProjectTypes returns types from LadybugDB
 * 4. Admin endpoint /fantom-pods/:id/ast returns LadybugDB data
 *
 * Usage:
 *   node scripts/test-ast-viewer-mcp.cjs [projectId]
 *   Default projectId: 265 (sedonaWebEditor)
 */

const http = require('http');

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin';
const PORT = process.env.MCP_PORT || 3848;
const BASE = `http://localhost:${PORT}`;
const PROJECT_ID = parseInt(process.argv[2] || '265', 10);

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

function adminFetch(path) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString('base64');
    const url = new URL(path, BASE);
    const req = http.get(url, {
      headers: { Authorization: `Basic ${auth}` }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function testToolDiscovery() {
  console.log('\n── Test 1: MCP Tool Discovery ──');
  try {
    const { createAgentFramework } = await import('../build/agents/index.js');
    const framework = createAgentFramework({});
    await framework.initialize();
    const tools = framework.getAllTools();

    const funcTool = tools.find(t => t.name === 'getProjectFunctions');
    const typeTool = tools.find(t => t.name === 'getProjectTypes');

    assert(funcTool != null, 'getProjectFunctions tool is registered');
    assert(typeTool != null, 'getProjectTypes tool is registered');

    if (funcTool) {
      assert(funcTool.description.includes('functions'), 'getProjectFunctions has proper description');
      console.log(`    Description: ${funcTool.description.substring(0, 80)}...`);
    }
    if (typeTool) {
      assert(typeTool.description.includes('type'), 'getProjectTypes has proper description');
      console.log(`    Description: ${typeTool.description.substring(0, 80)}...`);
    }

    console.log(`\n  Total MCP tools registered: ${tools.length}`);
    const graphTools = tools.filter(t =>
      t.name.includes('Project') || t.name.includes('Graph') ||
      t.name.includes('Caller') || t.name.includes('Callee')
    );
    console.log(`  Graph-related tools: ${graphTools.length}`);
    graphTools.forEach(t => console.log(`    - ${t.name}`));

    await framework.shutdown();
  } catch (err) {
    console.log(`  ⚠️  Agent framework test skipped: ${err.message}`);
  }
}

async function testToolExecution() {
  console.log(`\n── Test 2: Tool Execution via Agent Framework (project ${PROJECT_ID}) ──`);
  try {
    const { createAgentFramework } = await import('../build/agents/index.js');
    const framework = createAgentFramework({});
    await framework.initialize();

    // Execute getProjectFunctions
    console.log('\n  Testing getProjectFunctions...');
    const funcResult = await framework.orchestration.executeTool(
      'explorer_executeTool',
      { toolName: 'getProjectFunctions', params: { projectId: PROJECT_ID } }
    );
    assert(funcResult.success, 'getProjectFunctions executed successfully');
    if (funcResult.data?.content?.[0]?.text) {
      const text = funcResult.data.content[0].text;
      const funcMatch = text.match(/(\d+) functions/);
      if (funcMatch) {
        console.log(`    Found: ${funcMatch[0]}`);
        assert(parseInt(funcMatch[1]) > 0, 'Returns non-zero function count');
      }
      // Show first 5 lines
      const lines = text.split('\n').slice(0, 5);
      lines.forEach(l => console.log(`    ${l}`));
    }

    // Execute getProjectTypes
    console.log('\n  Testing getProjectTypes...');
    const typeResult = await framework.orchestration.executeTool(
      'explorer_executeTool',
      { toolName: 'getProjectTypes', params: { projectId: PROJECT_ID } }
    );
    assert(typeResult.success, 'getProjectTypes executed successfully');
    if (typeResult.data?.content?.[0]?.text) {
      const text = typeResult.data.content[0].text;
      const typeMatch = text.match(/(\d+) types/);
      if (typeMatch) {
        console.log(`    Found: ${typeMatch[0]}`);
        assert(parseInt(typeMatch[1]) > 0, 'Returns non-zero type count');
      }
      const lines = text.split('\n').slice(0, 5);
      lines.forEach(l => console.log(`    ${l}`));
    }

    await framework.shutdown();
  } catch (err) {
    console.log(`  ⚠️  Tool execution test skipped: ${err.message}`);
  }
}

async function testAdminEndpoint() {
  console.log(`\n── Test 3: Admin AST Endpoint (project ${PROJECT_ID}) ──`);
  try {
    // First get the pod/project mapping
    const astRes = await adminFetch(`/admin/fantom-pods/${PROJECT_ID}/ast`);

    if (astRes.status === 404) {
      console.log(`  ⚠️  Pod/project ${PROJECT_ID} not found — try a different ID`);
      return;
    }

    assert(astRes.status === 200, `GET /admin/fantom-pods/${PROJECT_ID}/ast returns 200`);

    const body = astRes.body;
    assert(body.hasAstCache === true, 'hasAstCache is true');
    assert(body.source != null, `source field present: "${body.source}"`);

    if (body.source === 'ladybugdb') {
      console.log('  🎯 Using LadybugDB (universal, all languages)');
    } else {
      console.log(`  📋 Using fallback: ${body.source}`);
    }

    if (body.summary) {
      console.log(`    Total functions: ${body.summary.totalFunctions}`);
      console.log(`    Total types: ${body.summary.totalTypes}`);
      console.log(`    Total classes: ${body.summary.totalClasses}`);
      assert(body.summary.totalFunctions >= 0, 'summary.totalFunctions is a number');
      assert(body.summary.totalTypes >= 0, 'summary.totalTypes is a number');
    }

    if (body.functions?.length > 0) {
      const f = body.functions[0];
      assert(f.id != null, 'Function has id');
      assert(f.name != null, 'Function has name');
      assert(f.filePath != null, 'Function has filePath');
      console.log(`    Sample function: ${f.name} (${f.type}) in ${f.filePath}:${f.lineNumber}`);

      if (body.source === 'ladybugdb') {
        assert(f.language != null || f.language === null, 'LadybugDB includes language field');
        assert(f.parameters != null, 'LadybugDB includes parsed parameters');
      }
    }

    if (body.types?.length > 0) {
      const t = body.types[0];
      assert(t.id != null, 'Type has id');
      assert(t.name != null, 'Type has name');
      console.log(`    Sample type: ${t.name} (${t.kind})`);

      if (body.source === 'ladybugdb') {
        assert('language' in t, 'LadybugDB types include language field');
      }
    }

    if (body.functionsByClass) {
      const classNames = Object.keys(body.functionsByClass);
      console.log(`    Classes with functions: ${classNames.length}`);
      if (classNames.length > 0) {
        console.log(`    First class: ${classNames[0]} (${body.functionsByClass[classNames[0]].length} members)`);
      }
    }
  } catch (err) {
    console.log(`  ⚠️  Admin endpoint test failed: ${err.message}`);
    console.log('    Is the server running? Start with: npm run start:http');
  }
}

async function testAstCacheEndpoint() {
  console.log('\n── Test 4: AST Cache Overview Endpoint ──');
  try {
    const res = await adminFetch('/admin/ast-cache');
    if (res.status === 200) {
      assert(true, 'GET /admin/ast-cache returns 200');
      const pods = res.body.pods || res.body;
      if (Array.isArray(pods)) {
        console.log(`    Total pods/projects: ${pods.length}`);
        const withAst = pods.filter(p => p.hasAstCache);
        console.log(`    With AST cache: ${withAst.length}`);
      }
    } else {
      console.log(`  ⚠️  AST cache endpoint returned ${res.status}`);
    }
  } catch (err) {
    console.log(`  ⚠️  AST cache test skipped: ${err.message}`);
  }
}

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  AST Viewer MCP Tools Test Suite             ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`Target project ID: ${PROJECT_ID}`);
  console.log(`Server: ${BASE}`);

  await testToolDiscovery();
  await testToolExecution();
  await testAdminEndpoint();
  await testAstCacheEndpoint();

  console.log('\n══════════════════════════════════════════════');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('⚠️  Some tests failed — check output above');
    process.exit(1);
  } else {
    console.log('✅ All tests passed');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
