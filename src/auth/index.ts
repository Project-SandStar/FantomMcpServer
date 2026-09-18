/**
 * Authentication Module for Fantom MCP Server
 *
 * Exports OAuth 2.1 provider, clients store, and related utilities.
 */

// OAuth Provider
export { FantomOAuthProvider, type OAuthProviderConfig } from './oauthProvider.js';

// Clients Store
export { PrismaClientsStore } from './prismaClientsStore.js';

// Token Utilities
export {
  generateAuthorizationCode,
  generateAccessToken,
  generateRefreshToken,
  generateClientId,
  generateClientSecret,
  generateSessionId,
  createCodeChallenge,
  verifyCodeChallenge,
  isValidCodeVerifier,
  isValidRedirectUri,
  extractBearerToken,
  base64UrlEncode,
  base64UrlDecode,
  calculateExpiration,
  isTokenExpired,
  TOKEN_TTL,
  SUPPORTED_SCOPES,
  SCOPE_DESCRIPTIONS,
} from './tokenUtils.js';

// Authorization Page
export { renderAuthorizePage, renderErrorPage } from './authorizePage.js';

// Token Cleanup
export { TokenCleanupJob, type CleanupStats, type TokenStats } from './tokenCleanup.js';
