/**
 * Token Cleanup Job
 *
 * Periodically cleans up expired OAuth tokens and orphaned sessions.
 */

import { PrismaClient } from '@prisma/client';

// ============================================
// Types
// ============================================

export interface CleanupStats {
  authorizationCodes: number;
  accessTokens: number;
  refreshTokens: number;
  orphanedSessions: number;
  totalCleaned: number;
  duration: number;
}

export interface TokenStats {
  authorizationCodes: {
    total: number;
    expired: number;
    used: number;
  };
  accessTokens: {
    total: number;
    active: number;
    expired: number;
    revoked: number;
  };
  refreshTokens: {
    total: number;
    active: number;
    expired: number;
    revoked: number;
  };
  sessions: {
    total: number;
    active: number;
  };
}

// ============================================
// Token Cleanup Job
// ============================================

export class TokenCleanupJob {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private prisma: PrismaClient,
    private intervalMs: number = 60 * 60 * 1000 // Default: 1 hour
  ) {}

  /**
   * Start the cleanup job
   */
  start(): void {
    if (this.intervalId) {
      console.log('[TokenCleanup] Job already running');
      return;
    }

    console.log(`[TokenCleanup] Starting cleanup job (interval: ${this.intervalMs / 1000}s)`);

    // Run immediately on start
    this.cleanup().catch(err => {
      console.error('[TokenCleanup] Initial cleanup failed:', err);
    });

    // Schedule periodic cleanup
    this.intervalId = setInterval(() => {
      this.cleanup().catch(err => {
        console.error('[TokenCleanup] Scheduled cleanup failed:', err);
      });
    }, this.intervalMs);
  }

  /**
   * Stop the cleanup job
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[TokenCleanup] Job stopped');
    }
  }

  /**
   * Run cleanup manually
   */
  async cleanup(): Promise<CleanupStats> {
    if (this.isRunning) {
      console.log('[TokenCleanup] Cleanup already in progress, skipping');
      return {
        authorizationCodes: 0,
        accessTokens: 0,
        refreshTokens: 0,
        orphanedSessions: 0,
        totalCleaned: 0,
        duration: 0,
      };
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      const now = new Date();

      // 1. Delete expired authorization codes (immediately after expiration)
      const authCodesResult = await this.prisma.authorizationCode.deleteMany({
        where: {
          expiresAt: { lt: now },
        },
      });

      // 2. Delete access tokens expired more than 7 days ago (keep for audit trail)
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const accessTokensResult = await this.prisma.accessToken.deleteMany({
        where: {
          OR: [
            { expiresAt: { lt: sevenDaysAgo } },
            {
              revokedAt: { lt: sevenDaysAgo },
            },
          ],
        },
      });

      // 3. Delete refresh tokens expired more than 7 days ago
      const refreshTokensResult = await this.prisma.refreshToken.deleteMany({
        where: {
          OR: [
            { expiresAt: { lt: sevenDaysAgo } },
            {
              revokedAt: { lt: sevenDaysAgo },
            },
          ],
        },
      });

      // 4. Delete orphaned sessions (no active tokens for 7+ days)
      const orphanedSessions = await this.cleanupOrphanedSessions(sevenDaysAgo);

      const duration = Date.now() - startTime;
      const stats: CleanupStats = {
        authorizationCodes: authCodesResult.count,
        accessTokens: accessTokensResult.count,
        refreshTokens: refreshTokensResult.count,
        orphanedSessions,
        totalCleaned:
          authCodesResult.count +
          accessTokensResult.count +
          refreshTokensResult.count +
          orphanedSessions,
        duration,
      };

      if (stats.totalCleaned > 0) {
        console.log(
          `[TokenCleanup] Cleaned ${stats.totalCleaned} items in ${duration}ms:`,
          `codes=${stats.authorizationCodes},`,
          `access=${stats.accessTokens},`,
          `refresh=${stats.refreshTokens},`,
          `sessions=${stats.orphanedSessions}`
        );
      }

      return stats;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Cleanup orphaned sessions
   */
  private async cleanupOrphanedSessions(threshold: Date): Promise<number> {
    // Find sessions with no recent activity
    const inactiveSessions = await this.prisma.oAuthSession.findMany({
      where: {
        lastActivity: { lt: threshold },
      },
      select: { sessionId: true, clientId: true, userId: true },
    });

    let deletedCount = 0;

    for (const session of inactiveSessions) {
      // Check if there are any active tokens for this session
      const activeTokens = await this.prisma.accessToken.count({
        where: {
          clientId: session.clientId,
          userId: session.userId,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      });

      if (activeTokens === 0) {
        await this.prisma.oAuthSession.delete({
          where: { sessionId: session.sessionId },
        });
        deletedCount++;
      }
    }

    return deletedCount;
  }

  /**
   * Get current token statistics
   */
  async getStats(): Promise<TokenStats> {
    const now = new Date();

    // Authorization codes
    const [totalAuthCodes, expiredAuthCodes, usedAuthCodes] = await Promise.all([
      this.prisma.authorizationCode.count(),
      this.prisma.authorizationCode.count({ where: { expiresAt: { lt: now } } }),
      this.prisma.authorizationCode.count({ where: { used: true } }),
    ]);

    // Access tokens
    const [totalAccessTokens, activeAccessTokens, revokedAccessTokens] = await Promise.all([
      this.prisma.accessToken.count(),
      this.prisma.accessToken.count({
        where: { expiresAt: { gt: now }, revokedAt: null },
      }),
      this.prisma.accessToken.count({ where: { revokedAt: { not: null } } }),
    ]);
    const expiredAccessTokens = totalAccessTokens - activeAccessTokens - revokedAccessTokens;

    // Refresh tokens
    const [totalRefreshTokens, activeRefreshTokens, revokedRefreshTokens] = await Promise.all([
      this.prisma.refreshToken.count(),
      this.prisma.refreshToken.count({
        where: { expiresAt: { gt: now }, revokedAt: null },
      }),
      this.prisma.refreshToken.count({ where: { revokedAt: { not: null } } }),
    ]);
    const expiredRefreshTokens = totalRefreshTokens - activeRefreshTokens - revokedRefreshTokens;

    // Sessions
    const [totalSessions, activeSessions] = await Promise.all([
      this.prisma.oAuthSession.count(),
      this.prisma.oAuthSession.count({
        where: {
          lastActivity: { gt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) },
        },
      }),
    ]);

    return {
      authorizationCodes: {
        total: totalAuthCodes,
        expired: expiredAuthCodes,
        used: usedAuthCodes,
      },
      accessTokens: {
        total: totalAccessTokens,
        active: activeAccessTokens,
        expired: expiredAccessTokens,
        revoked: revokedAccessTokens,
      },
      refreshTokens: {
        total: totalRefreshTokens,
        active: activeRefreshTokens,
        expired: expiredRefreshTokens,
        revoked: revokedRefreshTokens,
      },
      sessions: {
        total: totalSessions,
        active: activeSessions,
      },
    };
  }
}
