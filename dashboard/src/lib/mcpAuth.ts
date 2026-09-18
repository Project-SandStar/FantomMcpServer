/**
 * MCP OAuth Authentication Library
 *
 * Handles OAuth 2.1 authentication with PKCE for the MCP Explorer.
 * Tokens are stored in localStorage and validated against the server's SQLite database.
 */

import { getApiBase } from './api';

// ============================================
// Types
// ============================================

export interface McpOAuthTokens {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  obtained_at: number; // timestamp when token was obtained
}

export interface McpAuthState {
  isAuthenticated: boolean;
  tokens: McpOAuthTokens | null;
  clientId: string | null;
  error: string | null;
}

// ============================================
// Storage Keys
// ============================================

const STORAGE_KEYS = {
  MCP_TOKENS: 'mcp_oauth_tokens',
  MCP_CLIENT_ID: 'mcp_oauth_client_id',
  MCP_CLIENT_SECRET: 'mcp_oauth_client_secret',
  MCP_PKCE_VERIFIER: 'mcp_pkce_verifier',
  MCP_PKCE_STATE: 'mcp_pkce_state',
};

// ============================================
// PKCE Utilities
// ============================================

/**
 * Generate a random string for PKCE code verifier
 */
function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

/**
 * Generate code challenge from verifier using SHA-256
 */
async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(hash));
}

/**
 * Base64 URL encode (no padding)
 */
function base64UrlEncode(buffer: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...buffer));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generate a random state parameter
 */
function generateState(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

// ============================================
// Token Storage
// ============================================

/**
 * Save tokens to localStorage
 */
export function saveTokens(tokens: McpOAuthTokens): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEYS.MCP_TOKENS, JSON.stringify(tokens));
}

/**
 * Load tokens from localStorage
 */
export function loadTokens(): McpOAuthTokens | null {
  if (typeof window === 'undefined') return null;
  const stored = localStorage.getItem(STORAGE_KEYS.MCP_TOKENS);
  if (!stored) return null;

  try {
    const tokens = JSON.parse(stored) as McpOAuthTokens;

    // Check if token is expired (with 60 second buffer)
    const expiresAt = tokens.obtained_at + (tokens.expires_in * 1000) - 60000;
    if (Date.now() > expiresAt) {
      // Token expired, but we might have a refresh token
      if (!tokens.refresh_token) {
        clearTokens();
        return null;
      }
    }

    return tokens;
  } catch {
    clearTokens();
    return null;
  }
}

/**
 * Clear tokens from localStorage
 */
export function clearTokens(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(STORAGE_KEYS.MCP_TOKENS);
}

/**
 * Save client credentials
 */
function saveClientCredentials(clientId: string, clientSecret?: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEYS.MCP_CLIENT_ID, clientId);
  if (clientSecret) {
    localStorage.setItem(STORAGE_KEYS.MCP_CLIENT_SECRET, clientSecret);
  }
}

/**
 * Load client credentials
 */
export function loadClientCredentials(): { clientId: string; clientSecret?: string } | null {
  if (typeof window === 'undefined') return null;
  const clientId = localStorage.getItem(STORAGE_KEYS.MCP_CLIENT_ID);
  if (!clientId) return null;

  const clientSecret = localStorage.getItem(STORAGE_KEYS.MCP_CLIENT_SECRET) || undefined;
  return { clientId, clientSecret };
}

/**
 * Clear client credentials
 */
export function clearClientCredentials(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(STORAGE_KEYS.MCP_CLIENT_ID);
  localStorage.removeItem(STORAGE_KEYS.MCP_CLIENT_SECRET);
}

// ============================================
// OAuth Flow
// ============================================

/**
 * Check if OAuth is enabled on the server
 */
export async function checkOAuthEnabled(): Promise<boolean> {
  try {
    const response = await fetch(`${getApiBase()}/.well-known/oauth-authorization-server`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Register the dashboard as an OAuth client (Dynamic Client Registration)
 */
async function registerClient(): Promise<{ clientId: string; clientSecret?: string }> {
  // Check if we already have a registered client
  const existing = loadClientCredentials();
  if (existing) {
    return existing;
  }

  const response = await fetch(`${getApiBase()}/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_name: 'Fantom MCP Dashboard',
      redirect_uris: [getDashboardCallbackUrl()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // Public client (SPA)
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to register OAuth client: ${error}`);
  }

  const data = await response.json();
  saveClientCredentials(data.client_id, data.client_secret);

  return {
    clientId: data.client_id,
    clientSecret: data.client_secret,
  };
}

/**
 * Get the callback URL for OAuth redirect
 * Uses the current window location to ensure we use the correct protocol and path
 */
function getDashboardCallbackUrl(): string {
  if (typeof window === 'undefined') {
    return 'http://localhost:3000/explorer/callback';
  }

  // Check if we're running on the MCP server (path starts with /dashboard)
  // or in Next.js dev mode (no /dashboard prefix)
  const currentPath = window.location.pathname;
  const isServedFromMcpServer = currentPath.startsWith('/dashboard');

  // Build callback URL with same origin (preserves http/https)
  const origin = window.location.origin;

  if (isServedFromMcpServer) {
    // Production: dashboard served from /dashboard/
    return `${origin}/dashboard/explorer/callback`;
  } else {
    // Dev mode: Next.js dev server at root
    return `${origin}/explorer/callback`;
  }
}

/**
 * Start the OAuth authorization flow
 * Returns the authorization URL to redirect to
 */
export async function startAuthFlow(): Promise<string> {
  // Register client if needed
  const { clientId } = await registerClient();

  // Generate PKCE values
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateState();

  // Store PKCE values for later verification
  localStorage.setItem(STORAGE_KEYS.MCP_PKCE_VERIFIER, codeVerifier);
  localStorage.setItem(STORAGE_KEYS.MCP_PKCE_STATE, state);

  // Build authorization URL
  const authUrl = new URL(`${getApiBase()}/authorize`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', getDashboardCallbackUrl());
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('scope', 'mcp:tools mcp:resources');

  return authUrl.toString();
}

/**
 * Handle the OAuth callback - exchange code for tokens
 */
export async function handleAuthCallback(
  code: string,
  state: string
): Promise<McpOAuthTokens> {
  // Verify state
  const storedState = localStorage.getItem(STORAGE_KEYS.MCP_PKCE_STATE);
  if (state !== storedState) {
    throw new Error('Invalid state parameter - possible CSRF attack');
  }

  // Get stored PKCE verifier
  const codeVerifier = localStorage.getItem(STORAGE_KEYS.MCP_PKCE_VERIFIER);
  if (!codeVerifier) {
    throw new Error('Missing PKCE code verifier');
  }

  // Get client credentials
  const credentials = loadClientCredentials();
  if (!credentials) {
    throw new Error('Missing OAuth client credentials');
  }

  // Exchange code for tokens
  const response = await fetch(`${getApiBase()}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: credentials.clientId,
      code,
      redirect_uri: getDashboardCallbackUrl(),
      code_verifier: codeVerifier,
    }),
  });

  // Clean up PKCE values
  localStorage.removeItem(STORAGE_KEYS.MCP_PKCE_VERIFIER);
  localStorage.removeItem(STORAGE_KEYS.MCP_PKCE_STATE);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  const tokenResponse = await response.json();

  // Add timestamp
  const tokens: McpOAuthTokens = {
    ...tokenResponse,
    obtained_at: Date.now(),
  };

  // Save tokens
  saveTokens(tokens);

  return tokens;
}

/**
 * Refresh the access token using the refresh token
 */
export async function refreshAccessToken(): Promise<McpOAuthTokens | null> {
  const currentTokens = loadTokens();
  if (!currentTokens?.refresh_token) {
    return null;
  }

  const credentials = loadClientCredentials();
  if (!credentials) {
    return null;
  }

  try {
    const response = await fetch(`${getApiBase()}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: credentials.clientId,
        refresh_token: currentTokens.refresh_token,
      }),
    });

    if (!response.ok) {
      clearTokens();
      return null;
    }

    const tokenResponse = await response.json();

    const tokens: McpOAuthTokens = {
      ...tokenResponse,
      // Keep the refresh token if not returned
      refresh_token: tokenResponse.refresh_token || currentTokens.refresh_token,
      obtained_at: Date.now(),
    };

    saveTokens(tokens);
    return tokens;
  } catch {
    clearTokens();
    return null;
  }
}

/**
 * Get a valid access token (refreshing if needed)
 */
export async function getValidAccessToken(): Promise<string | null> {
  let tokens = loadTokens();
  if (!tokens) {
    return null;
  }

  // Check if token is expired (with 60 second buffer)
  const expiresAt = tokens.obtained_at + (tokens.expires_in * 1000) - 60000;
  if (Date.now() > expiresAt) {
    // Try to refresh
    tokens = await refreshAccessToken();
    if (!tokens) {
      return null;
    }
  }

  return tokens.access_token;
}

/**
 * Check if we have valid authentication
 */
export function isAuthenticated(): boolean {
  const tokens = loadTokens();
  if (!tokens) return false;

  // Check if we have an access token that's not expired (or have a refresh token)
  const expiresAt = tokens.obtained_at + (tokens.expires_in * 1000) - 60000;
  return Date.now() < expiresAt || !!tokens.refresh_token;
}

/**
 * Logout - clear all OAuth data
 */
export function logout(): void {
  clearTokens();
  // Keep client credentials so we don't need to re-register
}

/**
 * Force re-registration - clear client credentials to fix stale registrations
 * Use this when OAuth redirects fail or return wrong URLs
 */
export function forceReregister(): void {
  clearTokens();
  clearClientCredentials();
  localStorage.removeItem(STORAGE_KEYS.MCP_PKCE_VERIFIER);
  localStorage.removeItem(STORAGE_KEYS.MCP_PKCE_STATE);
}

/**
 * Full logout - clear everything including client registration
 */
export function fullLogout(): void {
  clearTokens();
  clearClientCredentials();
  localStorage.removeItem(STORAGE_KEYS.MCP_PKCE_VERIFIER);
  localStorage.removeItem(STORAGE_KEYS.MCP_PKCE_STATE);
}

// ============================================
// Auto-Authentication via Token Grant
// ============================================

/**
 * Request OAuth tokens directly using admin credentials.
 * This bypasses the OAuth redirect flow by using the already-authenticated
 * admin session to request tokens from the server.
 *
 * @returns The tokens if successful, null if failed
 */
export async function requestTokenGrant(): Promise<McpOAuthTokens | null> {
  if (typeof window === 'undefined') return null;

  // Get admin credentials from localStorage
  const username = localStorage.getItem('admin_user') || 'admin';
  const password = localStorage.getItem('admin_pass') || 'admin';
  const authHeader = 'Basic ' + btoa(`${username}:${password}`);

  try {
    const response = await fetch(`${getApiBase()}/admin/oauth/token-grant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
      },
      body: JSON.stringify({
        scope: 'mcp:tools mcp:resources',
      }),
    });

    if (!response.ok) {
      // Token grant not available or failed
      console.log('[MCP Auth] Token grant not available:', response.status);
      return null;
    }

    const tokenResponse = await response.json();

    // Format as McpOAuthTokens
    const tokens: McpOAuthTokens = {
      access_token: tokenResponse.access_token,
      token_type: tokenResponse.token_type || 'Bearer',
      expires_in: tokenResponse.expires_in,
      refresh_token: tokenResponse.refresh_token,
      scope: tokenResponse.scope,
      obtained_at: tokenResponse.obtained_at || Date.now(),
    };

    // Save tokens
    saveTokens(tokens);

    console.log('[MCP Auth] Token grant successful for user:', tokenResponse.username);
    return tokens;
  } catch (error) {
    console.log('[MCP Auth] Token grant failed:', error);
    return null;
  }
}

/**
 * Attempt to auto-authenticate MCP using stored admin credentials.
 * This tries token grant first, and only prompts for OAuth redirect if that fails.
 *
 * @returns true if authenticated (either already or via token grant)
 */
export async function autoAuthenticate(): Promise<boolean> {
  // Check if we already have valid tokens
  if (isAuthenticated()) {
    return true;
  }

  // Try to refresh existing tokens
  const refreshed = await refreshAccessToken();
  if (refreshed) {
    return true;
  }

  // Try token grant with admin credentials
  const granted = await requestTokenGrant();
  return granted !== null;
}
