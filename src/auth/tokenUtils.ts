/**
 * Token Utilities for OAuth 2.1 Implementation
 *
 * Provides cryptographically secure token generation and PKCE helpers.
 */

import * as crypto from 'crypto';

// ============================================
// Token Generation
// ============================================

/**
 * Generate a cryptographically secure authorization code
 * @returns 32-byte hex string (64 characters)
 */
export function generateAuthorizationCode(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Generate a cryptographically secure access token
 * @returns 48-byte hex string (96 characters)
 */
export function generateAccessToken(): string {
  return crypto.randomBytes(48).toString('hex');
}

/**
 * Generate a cryptographically secure refresh token
 * @returns 64-byte hex string (128 characters)
 */
export function generateRefreshToken(): string {
  return crypto.randomBytes(64).toString('hex');
}

/**
 * Generate a client ID (UUID v4 format)
 */
export function generateClientId(): string {
  return crypto.randomUUID();
}

/**
 * Generate a client secret
 * @returns 32-byte hex string (64 characters)
 */
export function generateClientSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Generate a session ID
 * @returns UUID v4 string
 */
export function generateSessionId(): string {
  return crypto.randomUUID();
}

// ============================================
// PKCE Helpers
// ============================================

/**
 * Create a code challenge from a code verifier using SHA-256
 * @param codeVerifier The code verifier string
 * @returns Base64URL-encoded SHA-256 hash
 */
export function createCodeChallenge(codeVerifier: string): string {
  const hash = crypto.createHash('sha256').update(codeVerifier).digest();
  return base64UrlEncode(hash);
}

/**
 * Verify that a code verifier matches a code challenge
 * @param verifier The code verifier from the token request
 * @param challenge The code challenge from the authorization request
 * @returns true if the verifier matches the challenge
 */
export function verifyCodeChallenge(verifier: string, challenge: string): boolean {
  const computedChallenge = createCodeChallenge(verifier);
  // Use timing-safe comparison
  if (computedChallenge.length !== challenge.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(computedChallenge, 'utf-8'),
    Buffer.from(challenge, 'utf-8')
  );
}

/**
 * Validate that a code verifier meets the PKCE specification
 * RFC 7636: code_verifier is 43-128 characters from [A-Z], [a-z], [0-9], "-", ".", "_", "~"
 */
export function isValidCodeVerifier(verifier: string): boolean {
  if (!verifier || verifier.length < 43 || verifier.length > 128) {
    return false;
  }
  // Check for valid characters: [A-Z], [a-z], [0-9], "-", ".", "_", "~"
  return /^[A-Za-z0-9\-._~]+$/.test(verifier);
}

// ============================================
// URL Validation
// ============================================

/**
 * Validate a redirect URI against allowed patterns
 * @param uri The redirect URI to validate
 * @param allowedUris Array of allowed redirect URIs (can include wildcards)
 */
export function isValidRedirectUri(uri: string, allowedUris: string[]): boolean {
  if (!uri || !allowedUris || allowedUris.length === 0) {
    return false;
  }

  try {
    const parsedUri = new URL(uri);

    for (const allowed of allowedUris) {
      // Exact match
      if (uri === allowed) return true;

      try {
        const allowedParsed = new URL(allowed);

        // Match scheme and host exactly
        if (parsedUri.protocol === allowedParsed.protocol &&
            parsedUri.host === allowedParsed.host) {
          // Path prefix match
          if (parsedUri.pathname.startsWith(allowedParsed.pathname)) {
            return true;
          }
        }
      } catch {
        // Invalid allowed URI pattern, skip
        continue;
      }
    }
  } catch {
    return false;
  }

  return false;
}

/**
 * Extract Bearer token from Authorization header
 * @param authHeader The Authorization header value
 * @returns The token string or null if invalid
 */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.substring(7).trim();
  return token.length > 0 ? token : null;
}

// ============================================
// Encoding Helpers
// ============================================

/**
 * Encode a buffer as Base64URL (RFC 4648)
 */
export function base64UrlEncode(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Decode a Base64URL string to a buffer
 */
export function base64UrlDecode(str: string): Buffer {
  // Restore padding
  const padding = 4 - (str.length % 4);
  const padded = padding < 4 ? str + '='.repeat(padding) : str;

  // Restore standard base64 characters
  const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');

  return Buffer.from(base64, 'base64');
}

// ============================================
// Token Expiration Helpers
// ============================================

/**
 * Calculate token expiration date
 * @param ttlSeconds Time-to-live in seconds
 * @returns Date object for expiration time
 */
export function calculateExpiration(ttlSeconds: number): Date {
  return new Date(Date.now() + ttlSeconds * 1000);
}

/**
 * Check if a token is expired
 * @param expiresAt The expiration date
 * @returns true if the token is expired
 */
export function isTokenExpired(expiresAt: Date): boolean {
  return new Date() >= expiresAt;
}

// ============================================
// Constants
// ============================================

export const TOKEN_TTL = {
  AUTHORIZATION_CODE: 10 * 60,        // 10 minutes
  ACCESS_TOKEN: 60 * 60,              // 1 hour
  REFRESH_TOKEN: 30 * 24 * 60 * 60,   // 30 days
};

export const SUPPORTED_SCOPES = ['mcp:read', 'mcp:write', 'mcp:admin'];

export const SCOPE_DESCRIPTIONS: Record<string, string> = {
  'mcp:read': 'Read access to MCP tools and resources',
  'mcp:write': 'Write access to MCP tools (execute tools, modify resources)',
  'mcp:admin': 'Administrative access to server management',
};
