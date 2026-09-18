/**
 * MCP Session Management Library
 * Handles communication with the Fantom MCP Server via JSON-RPC over HTTP
 * Supports OAuth 2.1 authentication when enabled on the server.
 */

import { getApiBase } from './api';
import { getValidAccessToken, loadTokens, clearTokens } from './mcpAuth';

let sessionId: string | null = null;

/**
 * Get authorization headers for MCP requests
 * Returns Bearer token if OAuth authenticated, otherwise empty object
 */
async function getAuthHeaders(): Promise<Record<string, string>> {
  const accessToken = await getValidAccessToken();
  if (accessToken) {
    return { 'Authorization': `Bearer ${accessToken}` };
  }
  return {};
}

/**
 * Check if we need OAuth authentication (401 with WWW-Authenticate: Bearer)
 */
export function needsOAuthAuth(response: Response): boolean {
  if (response.status !== 401) return false;
  const wwwAuth = response.headers.get('WWW-Authenticate');
  return wwwAuth?.includes('Bearer') ?? false;
}

/**
 * Check if we have OAuth tokens stored
 */
export function hasOAuthTokens(): boolean {
  return loadTokens() !== null;
}

/**
 * Parse Server-Sent Events (SSE) response format
 */
function parseSSEResponse(text: string): unknown {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        const data = JSON.parse(line.slice(6));
        if (data.result !== undefined) return data.result;
        if (data.error) {
          throw new Error(data.error.message || JSON.stringify(data.error));
        }
      } catch (e) {
        if (e instanceof SyntaxError) continue; // Skip malformed lines
        throw e;
      }
    }
  }
  throw new Error('No valid result in SSE response');
}

/**
 * Initialize a new MCP session
 */
export async function initMcpSession(): Promise<string> {
  const authHeaders = await getAuthHeaders();

  const response = await fetch(`${getApiBase()}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...authHeaders,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'fantom-explorer', version: '1.0.0' },
      },
    }),
  });

  // Check if OAuth authentication is required
  if (needsOAuthAuth(response)) {
    clearTokens();
    throw new Error('OAUTH_REQUIRED');
  }

  const newSessionId = response.headers.get('mcp-session-id');
  if (!newSessionId) {
    throw new Error('Failed to establish MCP session - no session ID returned');
  }

  // Parse the initialization response
  const text = await response.text();
  try {
    parseSSEResponse(text);
  } catch (e) {
    console.warn('Init response parse warning:', e);
  }

  sessionId = newSessionId;
  return newSessionId;
}

/**
 * Ensure we have a valid MCP session, initializing if needed
 */
export async function ensureMcpSession(): Promise<string> {
  if (sessionId) return sessionId;
  return initMcpSession();
}

/**
 * Reset the current session (forces re-initialization on next call)
 */
export function resetMcpSession(): void {
  sessionId = null;
}

/**
 * Get the current session ID
 */
export function getMcpSessionId(): string | null {
  return sessionId;
}

/**
 * Call an MCP tool with the given arguments
 */
export async function callMcpTool(
  toolName: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  const session = await ensureMcpSession();
  const authHeaders = await getAuthHeaders();

  const response = await fetch(`${getApiBase()}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'mcp-session-id': session,
      ...authHeaders,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });

  // Check if OAuth authentication is required
  if (needsOAuthAuth(response)) {
    clearTokens();
    throw new Error('OAUTH_REQUIRED');
  }

  // Handle session expiry
  if (response.status === 400) {
    const errorText = await response.text();
    if (errorText.includes('session') || errorText.includes('Session')) {
      // Session expired, reset and retry once
      resetMcpSession();
      return callMcpTool(toolName, args);
    }
    throw new Error(`MCP request failed: ${errorText}`);
  }

  if (!response.ok) {
    throw new Error(`MCP request failed with status ${response.status}`);
  }

  const text = await response.text();
  return parseSSEResponse(text);
}

/**
 * List available tools from the MCP server
 */
export async function listMcpTools(): Promise<unknown> {
  const session = await ensureMcpSession();
  const authHeaders = await getAuthHeaders();

  const response = await fetch(`${getApiBase()}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'mcp-session-id': session,
      ...authHeaders,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/list',
      params: {},
    }),
  });

  // Check if OAuth authentication is required
  if (needsOAuthAuth(response)) {
    clearTokens();
    throw new Error('OAUTH_REQUIRED');
  }

  if (!response.ok) {
    throw new Error(`Failed to list tools: ${response.status}`);
  }

  const text = await response.text();
  return parseSSEResponse(text);
}

/**
 * Read an MCP resource by URI
 */
export async function readMcpResource(uri: string): Promise<unknown> {
  const session = await ensureMcpSession();
  const authHeaders = await getAuthHeaders();

  const response = await fetch(`${getApiBase()}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'mcp-session-id': session,
      ...authHeaders,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'resources/read',
      params: { uri },
    }),
  });

  // Check if OAuth authentication is required
  if (needsOAuthAuth(response)) {
    clearTokens();
    throw new Error('OAUTH_REQUIRED');
  }

  if (!response.ok) {
    throw new Error(`Failed to read resource: ${response.status}`);
  }

  const text = await response.text();
  return parseSSEResponse(text);
}

/**
 * Tool execution result type
 */
export interface ToolResult {
  content: Array<{
    type: string;
    text?: string;
    data?: unknown;
  }>;
  isError?: boolean;
}

/**
 * Extract text content from tool result
 */
export function extractToolResultText(result: unknown): string {
  if (!result) return '';

  const toolResult = result as ToolResult;
  if (toolResult.content && Array.isArray(toolResult.content)) {
    const textContent = toolResult.content.find(c => c.type === 'text');
    if (textContent?.text) {
      try {
        // Try to parse as JSON for pretty display
        return JSON.stringify(JSON.parse(textContent.text), null, 2);
      } catch {
        return textContent.text;
      }
    }
  }

  // Fallback to stringifying the whole result
  return JSON.stringify(result, null, 2);
}

/**
 * Check if tool result is an error
 */
export function isToolResultError(result: unknown): boolean {
  const toolResult = result as ToolResult;
  return toolResult?.isError === true;
}

/**
 * Detailed tool execution result with raw request/response data
 */
export interface McpToolCallDetails {
  request: {
    jsonrpc: string;
    id: number;
    method: string;
    params: {
      name: string;
      arguments: Record<string, unknown>;
    };
  };
  rawResponse: unknown;
  parsedResult: unknown;
  executionTime: number;
  isError: boolean;
}

/**
 * Parse SSE response and return both raw and parsed data
 */
function parseSSEResponseWithRaw(text: string): { raw: unknown; parsed: unknown } {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        const data = JSON.parse(line.slice(6));
        if (data.result !== undefined) {
          return { raw: data, parsed: data.result };
        }
        if (data.error) {
          return {
            raw: data,
            parsed: { error: data.error.message || JSON.stringify(data.error) }
          };
        }
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
  }
  throw new Error('No valid result in SSE response');
}

/**
 * Call an MCP tool with detailed request/response capture
 * Used by the explorer to show users exactly what LLMs see
 */
export async function callMcpToolWithDetails(
  toolName: string,
  args: Record<string, unknown> = {}
): Promise<McpToolCallDetails> {
  const session = await ensureMcpSession();
  const authHeaders = await getAuthHeaders();
  const startTime = Date.now();

  // Build the request object
  const requestId = Date.now();
  const request = {
    jsonrpc: '2.0' as const,
    id: requestId,
    method: 'tools/call' as const,
    params: { name: toolName, arguments: args },
  };

  const response = await fetch(`${getApiBase()}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'mcp-session-id': session,
      ...authHeaders,
    },
    body: JSON.stringify(request),
  });

  const executionTime = Date.now() - startTime;

  // Check if OAuth authentication is required
  if (needsOAuthAuth(response)) {
    // Reset session and clear tokens so next attempt will get fresh credentials
    resetMcpSession();
    clearTokens();
    return {
      request,
      rawResponse: { error: 'OAuth authentication required' },
      parsedResult: null,
      executionTime,
      isError: true,
      needsAuth: true,
    } as McpToolCallDetails & { needsAuth: boolean };
  }

  // Handle session expiry
  if (response.status === 400) {
    const errorText = await response.text();
    if (errorText.includes('session') || errorText.includes('Session')) {
      resetMcpSession();
      return callMcpToolWithDetails(toolName, args);
    }
    return {
      request,
      rawResponse: { error: errorText },
      parsedResult: null,
      executionTime,
      isError: true,
    };
  }

  if (!response.ok) {
    return {
      request,
      rawResponse: { error: `HTTP ${response.status}` },
      parsedResult: null,
      executionTime,
      isError: true,
    };
  }

  const text = await response.text();

  try {
    const { raw, parsed } = parseSSEResponseWithRaw(text);
    const toolResult = parsed as ToolResult | null;

    return {
      request,
      rawResponse: raw,
      parsedResult: parsed,
      executionTime,
      isError: toolResult?.isError === true,
    };
  } catch (e) {
    return {
      request,
      rawResponse: { error: text },
      parsedResult: null,
      executionTime,
      isError: true,
    };
  }
}
