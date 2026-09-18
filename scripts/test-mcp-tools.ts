#!/usr/bin/env tsx
/**
 * MCP Tool Integration Tests
 *
 * Tests all 23 core MCP tools via the HTTP transport.
 * Requires the server to be running: npm run start:http
 *
 * Usage: npx tsx scripts/test-mcp-tools.ts
 *        npx tsx scripts/test-mcp-tools.ts --tool=semanticCodeSearch
 *        npx tsx scripts/test-mcp-tools.ts --group=search
 */

const BASE_URL = process.env.MCP_URL || 'http://localhost:3848';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin';

let sessionId: string | null = null;
let jsonRpcId = 1;

// ─── MCP Protocol Helpers ──────────────────────────────────────────────

async function mcpRequest(method: string, params?: Record<string, unknown>): Promise<any> {
  const body = {
    jsonrpc: '2.0',
    id: jsonRpcId++,
    method,
    params: params || {},
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const res = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  // Capture session ID from response
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  const contentType = res.headers.get('content-type') || '';

  let json: any;
  if (contentType.includes('text/event-stream')) {
    // Parse SSE response - extract JSON from "data:" lines
    const text = await res.text();
    const dataLines = text.split('\n').filter(l => l.startsWith('data: '));
    if (dataLines.length === 0) throw new Error('No data in SSE response');
    // Use the last data line (final result)
    json = JSON.parse(dataLines[dataLines.length - 1].slice(6));
  } else {
    json = await res.json();
  }

  if (json.error) {
    throw new Error(`JSON-RPC Error ${json.error.code}: ${json.error.message}`);
  }

  return json.result;
}

async function initSession(): Promise<void> {
  console.log('Initializing MCP session...');
  await mcpRequest('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test-runner', version: '1.0.0' },
  });
  console.log(`  Session ID: ${sessionId}\n`);
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
  return mcpRequest('tools/call', { name, arguments: args });
}

// ─── Test Infrastructure ───────────────────────────────────────────────

interface TestResult {
  tool: string;
  group: string;
  passed: boolean;
  duration: number;
  message: string;
  output?: string;
}

const results: TestResult[] = [];

async function runTest(
  tool: string,
  group: string,
  args: Record<string, unknown>,
  validate: (result: any) => string | null
): Promise<void> {
  const start = Date.now();
  try {
    const result = await callTool(tool, args);
    const duration = Date.now() - start;

    const error = validate(result);
    if (error) {
      results.push({ tool, group, passed: false, duration, message: error });
      console.log(`  FAIL  ${tool} (${duration}ms) - ${error}`);
    } else {
      const text = result?.content?.[0]?.text || '';
      const preview = text.substring(0, 120).replace(/\n/g, ' ');
      results.push({ tool, group, passed: true, duration, message: 'OK', output: preview });
      console.log(`  PASS  ${tool} (${duration}ms)`);
    }
  } catch (err: any) {
    const duration = Date.now() - start;
    results.push({ tool, group, passed: false, duration, message: err.message });
    console.log(`  FAIL  ${tool} (${duration}ms) - ${err.message}`);
  }
}

function hasContent(result: any): string | null {
  if (!result?.content || !Array.isArray(result.content) || result.content.length === 0) {
    return 'No content returned';
  }
  if (!result.content[0].text) {
    return 'Content text is empty';
  }
  return null;
}

function hasJsonContent(result: any): string | null {
  const err = hasContent(result);
  if (err) return err;
  try {
    JSON.parse(result.content[0].text);
    return null;
  } catch {
    return 'Content is not valid JSON';
  }
}

function hasTextContent(result: any): string | null {
  return hasContent(result);
}

// ─── Test Definitions ──────────────────────────────────────────────────

// Group 1: Documentation & Search
async function testDocSearch() {
  console.log('\n=== Documentation & Search ===\n');

  await runTest('getFantomType', 'doc-search', { qualifiedName: 'sys::Str' }, (r) => {
    const err = hasContent(r);
    if (err) return err;
    const text = r.content[0].text;
    if (!text.includes('Str')) return 'Expected type info for Str';
    return null;
  });

  await runTest('listFantomPods', 'doc-search', {}, (r) => {
    return hasContent(r);
  });

  await runTest('searchLocalDocs', 'doc-search', { query: 'point' }, (r) => {
    return hasContent(r);
  });

  await runTest('searchVersionedApi', 'doc-search', { query: 'Str', limit: 3 }, (r) => {
    return hasContent(r);
  });

  await runTest('listLocalPods', 'doc-search', { instanceId: 1 }, (r) => {
    // May fail if no instance 1 exists, that's ok - just check response shape
    return hasContent(r);
  });

  await runTest('getLocalDocStatus', 'doc-search', { instanceId: 1 }, (r) => {
    return hasContent(r);
  });
}

// Group 2: Code Search & Navigation (new tools)
async function testCodeSearch() {
  console.log('\n=== Code Search & Navigation ===\n');

  await runTest('searchFantomCode', 'code-search', { query: 'make', limit: 3 }, (r) => {
    return hasContent(r);
  });

  await runTest('getFantomFunction', 'code-search', { qualifiedName: 'sys::Str.toStr' }, (r) => {
    return hasContent(r);
  });

  await runTest('semanticCodeSearch', 'code-search', { query: 'HTTP connection handling', limit: 3 }, (r) => {
    return hasTextContent(r);
  });

  await runTest('findSimilarCode', 'code-search', { qualifiedName: 'sys::Str.toStr' }, (r) => {
    return hasTextContent(r);
  });

  await runTest('getCallers', 'code-search', { qualifiedName: 'sys::Str.toStr', maxDepth: 2 }, (r) => {
    return hasTextContent(r);
  });

  await runTest('getCallees', 'code-search', { qualifiedName: 'sys::Str.toStr', maxDepth: 2 }, (r) => {
    return hasTextContent(r);
  });

  await runTest('getCodeImpact', 'code-search', { qualifiedName: 'sys::Str.toStr', maxDepth: 3 }, (r) => {
    return hasTextContent(r);
  });
}

// Group 3: Project Management
async function testProjectMgmt() {
  console.log('\n=== Project Management ===\n');

  await runTest('listFantomProjects', 'project', {}, (r) => {
    return hasContent(r);
  });

  await runTest('getFantomCodeStats', 'project', {}, (r) => {
    return hasContent(r);
  });

  await runTest('listCompatiblePods', 'project', { version: '4.0.3' }, (r) => {
    return hasContent(r);
  });
}

// Group 4: Code Generation
async function testCodeGen() {
  console.log('\n=== Code Generation ===\n');

  await runTest(
    'generateFantomCode',
    'codegen',
    {
      type: 'class',
      name: 'TestWidget',
      pod: 'testPod',
      extends: 'Obj',
      fields: [{ name: 'label', type: 'Str' }],
      methods: [{ name: 'display', returnType: 'Void', body: 'echo(label)' }],
    },
    (r) => {
      const err = hasContent(r);
      if (err) return err;
      const text = r.content[0].text;
      if (!text.includes('TestWidget')) return 'Expected class name in output';
      return null;
    }
  );
}

// Group 5: Migration (dry-run only)
async function testMigration() {
  console.log('\n=== Migration (structure tests only) ===\n');

  // We can't run full migration without a real GitLab URL, so just test commitMigration/rollbackMigration
  // which should fail gracefully with no active migration.
  await runTest('commitMigration', 'migration', { message: 'test' }, (r) => {
    // Expected to fail since no migration is active - we just verify it responds
    return hasContent(r);
  });

  await runTest('rollbackMigration', 'migration', {}, (r) => {
    // Expected to fail since no migration is active - we just verify it responds
    return hasContent(r);
  });
}

// Group 6: Index Management
async function testIndexMgmt() {
  console.log('\n=== Index Management ===\n');

  // indexInstanceDocs needs a valid instanceId - test with instance 1
  await runTest('indexInstanceDocs', 'index', { instanceId: 1 }, (r) => {
    return hasContent(r);
  });
}

// Group 7: tools/list verification
async function testToolsList() {
  console.log('\n=== Tools List Verification ===\n');

  const start = Date.now();
  try {
    const result = await mcpRequest('tools/list');
    const duration = Date.now() - start;

    const toolNames = result.tools.map((t: any) => t.name);
    const count = toolNames.length;

    // Verify expected tools present
    const expectedTools = [
      'getFantomType', 'listFantomPods', 'searchLocalDocs', 'searchVersionedApi',
      'listLocalPods', 'getLocalDocStatus',
      'searchFantomCode', 'semanticCodeSearch', 'findSimilarCode',
      'getFantomFunction', 'getCallers', 'getCallees', 'getCodeImpact',
      'listFantomProjects', 'addFantomProject', 'refreshFantomProject',
      'getFantomCodeStats', 'listCompatiblePods',
      'generateFantomCode',
      'migrateSkySpark4x', 'commitMigration', 'rollbackMigration',
      'indexInstanceDocs',
    ];

    const missing = expectedTools.filter((t) => !toolNames.includes(t));
    const removedPresent = toolNames.includes('searchAll');

    if (missing.length > 0) {
      results.push({
        tool: 'tools/list',
        group: 'meta',
        passed: false,
        duration,
        message: `Missing tools: ${missing.join(', ')}`,
      });
      console.log(`  FAIL  tools/list (${duration}ms) - Missing: ${missing.join(', ')}`);
    } else if (removedPresent) {
      results.push({
        tool: 'tools/list',
        group: 'meta',
        passed: false,
        duration,
        message: 'searchAll should have been removed',
      });
      console.log(`  FAIL  tools/list (${duration}ms) - searchAll still present`);
    } else {
      results.push({
        tool: 'tools/list',
        group: 'meta',
        passed: true,
        duration,
        message: `${count} tools listed`,
      });
      console.log(`  PASS  tools/list (${duration}ms) - ${count} tools`);
    }

    // Check no agent tools leaked in
    const agentPrefixes = ['docs_', 'code_', 'project_', 'migration_', 'graph_', 'explorer_'];
    const leakedAgent = toolNames.filter((n: string) => agentPrefixes.some((p) => n.startsWith(p)));
    if (leakedAgent.length > 0) {
      results.push({
        tool: 'tools/list-no-agents',
        group: 'meta',
        passed: false,
        duration: 0,
        message: `Agent tools leaked: ${leakedAgent.join(', ')}`,
      });
      console.log(`  FAIL  tools/list-no-agents - Agent tools leaked: ${leakedAgent.slice(0, 5).join(', ')}...`);
    } else {
      results.push({
        tool: 'tools/list-no-agents',
        group: 'meta',
        passed: true,
        duration: 0,
        message: 'No agent tools in MCP listing',
      });
      console.log(`  PASS  tools/list-no-agents - No agent tools in MCP listing`);
    }
  } catch (err: any) {
    const duration = Date.now() - start;
    results.push({ tool: 'tools/list', group: 'meta', passed: false, duration, message: err.message });
    console.log(`  FAIL  tools/list (${duration}ms) - ${err.message}`);
  }
}

// ─── Main Runner ───────────────────────────────────────────────────────

const GROUP_MAP: Record<string, () => Promise<void>> = {
  'doc-search': testDocSearch,
  'code-search': testCodeSearch,
  project: testProjectMgmt,
  codegen: testCodeGen,
  migration: testMigration,
  index: testIndexMgmt,
  meta: testToolsList,
};

async function main() {
  const args = process.argv.slice(2);
  const toolFilter = args.find((a) => a.startsWith('--tool='))?.split('=')[1];
  const groupFilter = args.find((a) => a.startsWith('--group='))?.split('=')[1];

  console.log('╔══════════════════════════════════════════╗');
  console.log('║     MCP Tool Integration Test Suite      ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`\nServer: ${BASE_URL}`);

  // Verify server is reachable
  try {
    const healthRes = await fetch(`${BASE_URL}/health`);
    if (!healthRes.ok) throw new Error(`Health check failed: ${healthRes.status}`);
    const health = await healthRes.json();
    console.log(`Status: ${health.status || 'ok'}`);
  } catch (err: any) {
    console.error(`\nERROR: Cannot reach server at ${BASE_URL}`);
    console.error(`Start the server first: npm run start:http\n`);
    process.exit(1);
  }

  await initSession();

  if (toolFilter) {
    // Run single tool test
    console.log(`\nRunning single tool test: ${toolFilter}\n`);
    await runTest(toolFilter, 'manual', {}, hasContent);
  } else if (groupFilter && GROUP_MAP[groupFilter]) {
    await GROUP_MAP[groupFilter]();
  } else {
    // Run all groups
    await testToolsList();
    await testDocSearch();
    await testCodeSearch();
    await testProjectMgmt();
    await testCodeGen();
    await testMigration();
    await testIndexMgmt();
  }

  // ─── Summary ──────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║              Test Summary                ║');
  console.log('╚══════════════════════════════════════════╝\n');

  const passed = results.filter((r) => r.passed);
  const failed = results.filter((r) => !r.passed);

  console.log(`Total: ${results.length}  Passed: ${passed.length}  Failed: ${failed.length}\n`);

  if (failed.length > 0) {
    console.log('Failed tests:');
    for (const f of failed) {
      console.log(`  - ${f.tool}: ${f.message}`);
    }
    console.log('');
  }

  const totalDuration = results.reduce((s, r) => s + r.duration, 0);
  console.log(`Total duration: ${(totalDuration / 1000).toFixed(1)}s`);

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
