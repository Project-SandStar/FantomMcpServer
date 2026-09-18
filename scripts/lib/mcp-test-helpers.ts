/**
 * Shared helpers for MCP tool test scripts.
 *
 * Usage in test scripts:
 *   import { mcpSession, callTool, printResult } from './lib/mcp-test-helpers.js';
 */

const BASE_URL = process.env.MCP_URL || 'http://localhost:3848';

let sessionId: string | null = null;
let jsonRpcId = 1;

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

  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  const contentType = res.headers.get('content-type') || '';

  let json: any;
  if (contentType.includes('text/event-stream')) {
    const text = await res.text();
    const dataLines = text.split('\n').filter(l => l.startsWith('data: '));
    if (dataLines.length === 0) throw new Error('No data in SSE response');
    json = JSON.parse(dataLines[dataLines.length - 1].slice(6));
  } else {
    json = await res.json();
  }

  if (json.error) {
    throw new Error(`JSON-RPC Error ${json.error.code}: ${json.error.message}`);
  }

  return json.result;
}

export async function mcpSession(fn: () => Promise<void>): Promise<void> {
  console.log(`Server: ${BASE_URL}`);

  // Health check
  try {
    const hRes = await fetch(`${BASE_URL}/health`);
    if (!hRes.ok) throw new Error(`${hRes.status}`);
  } catch {
    console.error(`\nERROR: Cannot reach server at ${BASE_URL}`);
    console.error('Start the server first: npm run start:http\n');
    process.exit(1);
  }

  // Initialize session
  await mcpRequest('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test-runner', version: '1.0.0' },
  });
  console.log(`Session: ${sessionId}\n`);

  await fn();
}

export async function callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
  try {
    return await mcpRequest('tools/call', { name, arguments: args });
  } catch (err: any) {
    return { error: err.message, content: [{ type: 'text', text: `ERROR: ${err.message}` }] };
  }
}

/**
 * Discover a valid graph node qualified name by running a code search.
 * Graph tools (getCallers, findSimilarCode, etc.) need CodeNode entries,
 * not function search index entries. This finds one that exists in both.
 */
export async function discoverGraphNodeQN(): Promise<string> {
  const r = await callTool('searchFantomCode', { query: 'make', limit: 5 });
  try {
    const data = JSON.parse(r.content[0].text);
    if (data.results?.length > 0) {
      return data.results[0].qualifiedName;
    }
  } catch { /* fall through */ }
  return 'Green Button Data::Build.make'; // fallback
}

export function printResult(result: any, maxLen = 500): void {
  if (result?.isError) {
    console.log('  STATUS: ERROR');
  } else if (result?.error) {
    console.log(`  STATUS: ERROR - ${result.error}`);
  } else {
    console.log('  STATUS: OK');
  }

  const text = result?.content?.[0]?.text || '(no content)';
  const preview = text.length > maxLen ? text.substring(0, maxLen) + '...' : text;
  console.log(`  OUTPUT: ${preview}`);
}
