/**
 * OAuth 2.1 Provider Implementation for Fantom MCP Server
 *
 * Implements the OAuthServerProvider interface from MCP SDK with PKCE support.
 */

import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { PrismaClientsStore } from './prismaClientsStore.js';
import { UserStore } from '../admin/userStore.js';
import {
  generateAuthorizationCode,
  generateAccessToken,
  generateRefreshToken,
  generateSessionId,
  verifyCodeChallenge,
  calculateExpiration,
  isTokenExpired,
  TOKEN_TTL,
} from './tokenUtils.js';
import { renderAuthorizePage } from './authorizePage.js';

// ============================================
// Types
// ============================================

export interface OAuthProviderConfig {
  issuerUrl: string;
  accessTokenTtl?: number;
  refreshTokenTtl?: number;
  authCodeTtl?: number;
}

interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  scope?: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state?: string;
  expiresAt: Date;
}

// ============================================
// OAuth Provider Implementation
// ============================================

export class FantomOAuthProvider implements OAuthServerProvider {
  private _clientsStore: PrismaClientsStore;
  private pendingAuths: Map<string, PendingAuthorization> = new Map();

  constructor(
    private prisma: PrismaClient,
    private userStore: UserStore,
    private config: OAuthProviderConfig
  ) {
    this._clientsStore = new PrismaClientsStore(prisma);
  }

  /**
   * The clients store for this provider
   */
  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clientsStore;
  }

  /**
   * Begin the authorization flow - render a login/consent page
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    // Generate a temporary auth ID to track this authorization
    const authId = generateSessionId();

    // Store the pending authorization details
    this.pendingAuths.set(authId, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      scope: params.scopes?.join(' '),
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: 'S256',
      state: params.state,
      expiresAt: calculateExpiration(TOKEN_TTL.AUTHORIZATION_CODE),
    });

    // Render the authorization page
    const html = renderAuthorizePage({
      authId,
      clientName: client.client_name || client.client_id,
      clientId: client.client_id,
      scopes: params.scopes || [],
      redirectUri: params.redirectUri,
    });

    res.type('text/html').send(html);
  }

  /**
   * Process the authorization form submission
   * This is called from a custom route handler
   */
  async processAuthorization(
    authId: string,
    username: string,
    password: string,
    userAgent?: string,
    ipAddress?: string
  ): Promise<{ success: true; redirectUrl: string } | { success: false; error: string }> {
    // Get the pending authorization
    const pending = this.pendingAuths.get(authId);
    if (!pending) {
      return { success: false, error: 'Authorization request expired or invalid' };
    }

    // Check if expired
    if (isTokenExpired(pending.expiresAt)) {
      this.pendingAuths.delete(authId);
      return { success: false, error: 'Authorization request expired' };
    }

    // Authenticate the user
    const user = this.userStore.authenticatePublic(username, password);
    if (!user) {
      return { success: false, error: 'Invalid username or password' };
    }

    // Generate authorization code
    const code = generateAuthorizationCode();
    const codeExpiresAt = calculateExpiration(
      this.config.authCodeTtl || TOKEN_TTL.AUTHORIZATION_CODE
    );

    // Store the authorization code in the database
    await this.prisma.authorizationCode.create({
      data: {
        code,
        clientId: pending.clientId,
        userId: user.username,
        redirectUri: pending.redirectUri,
        scope: pending.scope,
        codeChallenge: pending.codeChallenge,
        codeChallengeMethod: pending.codeChallengeMethod,
        expiresAt: codeExpiresAt,
        used: false,
      },
    });

    // Record the grant: one OAuthSession row per (client, user).
    await this.upsertSession({
      clientId: pending.clientId,
      clientName: (await this._clientsStore.getClient(pending.clientId))?.client_name || null,
      userId: user.username,
      scope: pending.scope ?? null,
      userAgent: userAgent || null,
      ipAddress: ipAddress || null,
    });

    // Clean up pending authorization
    this.pendingAuths.delete(authId);

    // Build redirect URL with authorization code
    const redirectUrl = new URL(pending.redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (pending.state) {
      redirectUrl.searchParams.set('state', pending.state);
    }

    return { success: true, redirectUrl: redirectUrl.toString() };
  }

  /**
   * Get the code challenge for an authorization code
   */
  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const authCode = await this.prisma.authorizationCode.findUnique({
      where: { code: authorizationCode },
    });

    if (!authCode) {
      throw new Error('Invalid authorization code');
    }

    return authCode.codeChallenge;
  }

  /**
   * Exchange an authorization code for tokens
   */
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    redirectUri?: string,
    _resource?: URL
  ): Promise<OAuthTokens> {
    // Find the authorization code
    const authCode = await this.prisma.authorizationCode.findUnique({
      where: { code: authorizationCode },
    });

    if (!authCode) {
      throw new Error('Invalid authorization code');
    }

    // Verify the code hasn't been used
    if (authCode.used) {
      throw new Error('Authorization code has already been used');
    }

    // Verify the code hasn't expired
    if (isTokenExpired(authCode.expiresAt)) {
      throw new Error('Authorization code has expired');
    }

    // Verify client ID matches
    if (authCode.clientId !== client.client_id) {
      throw new Error('Authorization code was issued to a different client');
    }

    // Verify redirect URI matches
    if (redirectUri && authCode.redirectUri !== redirectUri) {
      throw new Error('Redirect URI mismatch');
    }

    // Verify PKCE code verifier
    if (codeVerifier) {
      if (!verifyCodeChallenge(codeVerifier, authCode.codeChallenge)) {
        throw new Error('Invalid code verifier');
      }
    }

    // Mark the code as used
    await this.prisma.authorizationCode.update({
      where: { code: authorizationCode },
      data: { used: true },
    });

    // Generate tokens
    const accessToken = generateAccessToken();
    const refreshToken = generateRefreshToken();
    const accessTokenTtl = this.config.accessTokenTtl || TOKEN_TTL.ACCESS_TOKEN;
    const refreshTokenTtl = this.config.refreshTokenTtl || TOKEN_TTL.REFRESH_TOKEN;

    // Store access token
    await this.prisma.accessToken.create({
      data: {
        token: accessToken,
        clientId: client.client_id,
        userId: authCode.userId,
        scope: authCode.scope,
        expiresAt: calculateExpiration(accessTokenTtl),
      },
    });

    // Store refresh token
    await this.prisma.refreshToken.create({
      data: {
        token: refreshToken,
        clientId: client.client_id,
        userId: authCode.userId,
        scope: authCode.scope,
        expiresAt: calculateExpiration(refreshTokenTtl),
      },
    });

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: accessTokenTtl,
      refresh_token: refreshToken,
      scope: authCode.scope || undefined,
    };
  }

  /**
   * Exchange a refresh token for new tokens
   */
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshTokenValue: string,
    scopes?: string[],
    _resource?: URL
  ): Promise<OAuthTokens> {
    // Find the refresh token
    const refreshToken = await this.prisma.refreshToken.findUnique({
      where: { token: refreshTokenValue },
    });

    if (!refreshToken) {
      throw new Error('Invalid refresh token');
    }

    // Verify the token hasn't been revoked
    if (refreshToken.revokedAt) {
      throw new Error('Refresh token has been revoked');
    }

    // Verify the token hasn't expired
    if (isTokenExpired(refreshToken.expiresAt)) {
      throw new Error('Refresh token has expired');
    }

    // Verify client ID matches
    if (refreshToken.clientId !== client.client_id) {
      throw new Error('Refresh token was issued to a different client');
    }

    // Generate new access token
    const accessToken = generateAccessToken();
    const accessTokenTtl = this.config.accessTokenTtl || TOKEN_TTL.ACCESS_TOKEN;

    // Determine scope (use requested scopes if provided and subset of original)
    let scope = refreshToken.scope;
    if (scopes && scopes.length > 0) {
      const originalScopes = (refreshToken.scope || '').split(' ').filter(Boolean);
      const requestedScopes = scopes.filter(s => originalScopes.includes(s));
      scope = requestedScopes.join(' ') || refreshToken.scope;
    }

    // Store new access token
    await this.prisma.accessToken.create({
      data: {
        token: accessToken,
        clientId: client.client_id,
        userId: refreshToken.userId,
        scope,
        expiresAt: calculateExpiration(accessTokenTtl),
      },
    });

    // Update session last activity
    await this.prisma.oAuthSession.updateMany({
      where: {
        clientId: client.client_id,
        userId: refreshToken.userId,
      },
      data: { lastActivity: new Date() },
    });

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: accessTokenTtl,
      scope: scope || undefined,
    };
  }

  /**
   * Verify an access token
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const accessToken = await this.prisma.accessToken.findUnique({
      where: { token },
    });

    if (!accessToken) {
      throw new Error('Invalid access token');
    }

    // Check if revoked
    if (accessToken.revokedAt) {
      throw new Error('Access token has been revoked');
    }

    // Check if expired
    if (isTokenExpired(accessToken.expiresAt)) {
      throw new Error('Access token has expired');
    }

    // Update session last activity
    await this.prisma.oAuthSession.updateMany({
      where: {
        clientId: accessToken.clientId,
        userId: accessToken.userId,
      },
      data: { lastActivity: new Date() },
    });

    return {
      token: accessToken.token,
      clientId: accessToken.clientId,
      scopes: (accessToken.scope || '').split(' ').filter(Boolean),
      expiresAt: Math.floor(accessToken.expiresAt.getTime() / 1000),
      extra: {
        userId: accessToken.userId,
      },
    };
  }

  /**
   * Revoke a token
   */
  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    const now = new Date();

    // Try to revoke as access token
    const accessTokenResult = await this.prisma.accessToken.updateMany({
      where: {
        token: request.token,
        clientId: client.client_id,
        revokedAt: null,
      },
      data: { revokedAt: now },
    });

    if (accessTokenResult.count > 0) {
      return;
    }

    // Try to revoke as refresh token
    await this.prisma.refreshToken.updateMany({
      where: {
        token: request.token,
        clientId: client.client_id,
        revokedAt: null,
      },
      data: { revokedAt: now },
    });
  }

  // ============================================
  // Direct Token Grant (for authenticated users)
  // ============================================

  /**
   * Grant tokens directly to an authenticated user without PKCE flow.
   * Used when user has already authenticated via Basic Auth.
   */
  async grantTokensForUser(
    username: string,
    clientId: string,
    scope?: string,
    userAgent?: string,
    ipAddress?: string
  ): Promise<OAuthTokens> {
    // Ensure the client exists (required for foreign key constraint)
    const existingClient = await this.prisma.oAuthClient.findUnique({
      where: { clientId },
    });

    if (!existingClient) {
      // Create the client for token grant (internal/system client)
      await this.prisma.oAuthClient.create({
        data: {
          clientId,
          clientName: clientId === 'dashboard-auto-auth' ? 'Dashboard Auto-Auth' : clientId,
          redirectUris: '[]', // No redirects needed for direct grant
          scope: scope || 'mcp:tools mcp:resources',
        },
      });
    }

    // Generate tokens
    const accessToken = generateAccessToken();
    const refreshToken = generateRefreshToken();
    const accessTokenTtl = this.config.accessTokenTtl || TOKEN_TTL.ACCESS_TOKEN;
    const refreshTokenTtl = this.config.refreshTokenTtl || TOKEN_TTL.REFRESH_TOKEN;

    // Store access token
    await this.prisma.accessToken.create({
      data: {
        token: accessToken,
        clientId,
        userId: username,
        scope: scope || 'mcp:tools mcp:resources',
        expiresAt: calculateExpiration(accessTokenTtl),
      },
    });

    // Store refresh token
    await this.prisma.refreshToken.create({
      data: {
        token: refreshToken,
        clientId,
        userId: username,
        scope: scope || 'mcp:tools mcp:resources',
        expiresAt: calculateExpiration(refreshTokenTtl),
      },
    });

    // Record the grant: one OAuthSession row per (client, user). The gateway
    // (mcp-proxy) re-grants on every restart / token refresh; creating a row
    // each time accumulated 1000+ duplicates of the same grant.
    await this.upsertSession({
      clientId,
      clientName: (await this._clientsStore.getClient(clientId))?.client_name || 'Dashboard Auto-Auth',
      userId: username,
      scope: scope || 'mcp:tools mcp:resources',
      userAgent: userAgent || null,
      ipAddress: ipAddress || null,
    });

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: accessTokenTtl,
      refresh_token: refreshToken,
      scope: scope || 'mcp:tools mcp:resources',
    };
  }

  /**
   * Create-or-refresh the single OAuthSession row for a (clientId, userId)
   * pair. A grant is a relationship, not an event: re-granting to the same
   * client+user must update the existing row (scope, UA, IP, lastActivity),
   * never add another. Because exactly one row exists per pair, the
   * `updateMany({ clientId, userId })` lastActivity bumps in verify/refresh
   * touch exactly that row.
   */
  private async upsertSession(input: {
    clientId: string;
    clientName: string | null;
    userId: string;
    scope: string | null;
    userAgent: string | null;
    ipAddress: string | null;
  }): Promise<void> {
    const existing = await this.prisma.oAuthSession.findFirst({
      where: { clientId: input.clientId, userId: input.userId },
      orderBy: { createdAt: 'desc' },
    });
    const now = new Date();
    if (existing) {
      await this.prisma.oAuthSession.update({
        where: { id: existing.id },
        data: {
          clientName: input.clientName ?? existing.clientName,
          scope: input.scope ?? existing.scope,
          userAgent: input.userAgent ?? existing.userAgent,
          ipAddress: input.ipAddress ?? existing.ipAddress,
          lastActivity: now,
        },
      });
      // Defensive: collapse any older duplicates left over from the create-per-grant era.
      await this.prisma.oAuthSession.deleteMany({
        where: { clientId: input.clientId, userId: input.userId, id: { not: existing.id } },
      });
      return;
    }
    await this.prisma.oAuthSession.create({
      data: {
        sessionId: generateSessionId(),
        clientId: input.clientId,
        clientName: input.clientName,
        userId: input.userId,
        scope: input.scope,
        userAgent: input.userAgent,
        ipAddress: input.ipAddress,
        lastActivity: now,
      },
    });
  }

  // ============================================
  // Session Management (for dashboard)
  // ============================================

  /**
   * Get OAuth grants that still hold at least one live (unexpired, unrevoked)
   * access or refresh token. A grant whose tokens have all expired or been
   * revoked is not "active" and is left to the cleanup job.
   */
  async getSessions() {
    const [sessions, liveAccess, liveRefresh] = await Promise.all([
      this.prisma.oAuthSession.findMany({ orderBy: { lastActivity: 'desc' } }),
      this.prisma.accessToken.findMany({
        where: { revokedAt: null, expiresAt: { gt: new Date() } },
        select: { clientId: true, userId: true },
        distinct: ['clientId', 'userId'],
      }),
      this.prisma.refreshToken.findMany({
        where: { revokedAt: null, expiresAt: { gt: new Date() } },
        select: { clientId: true, userId: true },
        distinct: ['clientId', 'userId'],
      }),
    ]);
    const live = new Set<string>();
    for (const t of [...liveAccess, ...liveRefresh]) live.add(`${t.clientId} ${t.userId ?? ''}`);
    return sessions.filter(s => live.has(`${s.clientId} ${s.userId ?? ''}`));
  }

  /**
   * Revoke a specific OAuth session
   */
  async revokeSession(sessionId: string): Promise<boolean> {
    const session = await this.prisma.oAuthSession.findUnique({
      where: { sessionId },
    });

    if (!session) return false;

    // Revoke all tokens for this session
    const now = new Date();

    await this.prisma.accessToken.updateMany({
      where: {
        clientId: session.clientId,
        userId: session.userId,
        revokedAt: null,
      },
      data: { revokedAt: now },
    });

    await this.prisma.refreshToken.updateMany({
      where: {
        clientId: session.clientId,
        userId: session.userId,
        revokedAt: null,
      },
      data: { revokedAt: now },
    });

    // Delete the session
    await this.prisma.oAuthSession.delete({
      where: { sessionId },
    });

    return true;
  }

  /**
   * Revoke all OAuth sessions for a client
   */
  async revokeAllSessionsForClient(clientId: string): Promise<number> {
    const now = new Date();

    // Revoke all tokens
    await this.prisma.accessToken.updateMany({
      where: { clientId, revokedAt: null },
      data: { revokedAt: now },
    });

    await this.prisma.refreshToken.updateMany({
      where: { clientId, revokedAt: null },
      data: { revokedAt: now },
    });

    // Delete all sessions
    const result = await this.prisma.oAuthSession.deleteMany({
      where: { clientId },
    });

    return result.count;
  }
}
