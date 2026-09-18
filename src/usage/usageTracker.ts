/**
 * Usage tracker with Prisma backend for tracking tool calls and searches
 */

import * as fs from 'fs';
import { getPrismaClient } from '../db/index.js';
import { getCachePath } from '../utils/installRoot.js';
import type { ToolEvent, SearchEvent, UsageStats, RecentSearch } from './types.js';

/**
 * Singleton usage tracker for recording and analyzing tool and search usage
 */
export class UsageTracker {
  private initialized = false;

  constructor(_dbPath?: string) {
    // dbPath is no longer used with Prisma
  }

  /**
   * Initialize the tracker
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Prisma client handles connection automatically
    this.initialized = true;
  }

  /**
   * Track a tool call event
   */
  async trackToolCall(event: ToolEvent): Promise<void> {
    const prisma = getPrismaClient();

    await prisma.toolEvent.create({
      data: {
        toolName: event.toolName,
        timestamp: event.timestamp,
        durationMs: event.durationMs ?? null,
        success: event.success,
        errorMessage: event.errorMessage ?? null,
        sessionId: event.sessionId ?? null,
      },
    });
  }

  /**
   * Track a search event
   */
  async trackSearch(event: SearchEvent): Promise<void> {
    const prisma = getPrismaClient();

    await prisma.searchEvent.create({
      data: {
        query: event.query,
        source: event.source,
        resultCount: event.resultCount,
        timestamp: event.timestamp,
        sessionId: event.sessionId ?? null,
      },
    });
  }

  /**
   * Get aggregated usage statistics for the specified number of days
   */
  async getStats(days: number = 7): Promise<UsageStats> {
    const prisma = getPrismaClient();

    const periodEnd = new Date();
    const periodStart = new Date();
    periodStart.setDate(periodStart.getDate() - days);

    // Get total tool calls
    const totalToolCalls = await prisma.toolEvent.count({
      where: {
        timestamp: {
          gte: periodStart,
          lte: periodEnd,
        },
      },
    });

    // Get total searches
    const totalSearches = await prisma.searchEvent.count({
      where: {
        timestamp: {
          gte: periodStart,
          lte: periodEnd,
        },
      },
    });

    // Get tool usage breakdown
    const toolUsageRows = await prisma.toolEvent.groupBy({
      by: ['toolName'],
      _count: {
        toolName: true,
      },
      where: {
        timestamp: {
          gte: periodStart,
          lte: periodEnd,
        },
      },
      orderBy: {
        _count: {
          toolName: 'desc',
        },
      },
    });

    const toolUsage: Record<string, number> = {};
    for (const row of toolUsageRows) {
      toolUsage[row.toolName] = row._count.toolName;
    }

    // Get top searches
    const topSearchesRows = await prisma.searchEvent.groupBy({
      by: ['query'],
      _count: {
        query: true,
      },
      where: {
        timestamp: {
          gte: periodStart,
          lte: periodEnd,
        },
      },
      orderBy: {
        _count: {
          query: 'desc',
        },
      },
      take: 20,
    });

    const topSearches = topSearchesRows.map(row => ({
      query: row.query,
      count: row._count.query,
    }));

    // Get recent searches (last 20)
    const recentSearchesRows = await prisma.searchEvent.findMany({
      where: {
        timestamp: {
          gte: periodStart,
          lte: periodEnd,
        },
      },
      orderBy: {
        timestamp: 'desc',
      },
      take: 20,
    });

    const recentSearches: RecentSearch[] = recentSearchesRows.map(row => ({
      query: row.query,
      source: row.source,
      resultCount: row.resultCount,
      timestamp: row.timestamp.toISOString(),
    }));

    return {
      totalToolCalls,
      totalSearches,
      toolUsage,
      topSearches,
      recentSearches,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
    };
  }

  /**
   * Clear all usage data from the database
   */
  async clearData(): Promise<void> {
    const prisma = getPrismaClient();

    await prisma.toolEvent.deleteMany({});
    await prisma.searchEvent.deleteMany({});
  }

  /**
   * Get database information including path and size
   */
  getDatabaseInfo(): { path: string; sizeBytes: number; sizeMB: string } {
    const dbPath = getCachePath('fantom.db');
    const stats = fs.existsSync(dbPath) ? fs.statSync(dbPath) : null;
    const sizeBytes = stats?.size || 0;
    const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);

    return {
      path: dbPath,
      sizeBytes,
      sizeMB: `${sizeMB} MB`,
    };
  }

  /**
   * Get event counts for tool and search events
   */
  async getEventCounts(): Promise<{ toolEvents: number; searchEvents: number }> {
    const prisma = getPrismaClient();

    const toolEvents = await prisma.toolEvent.count();
    const searchEvents = await prisma.searchEvent.count();

    return {
      toolEvents,
      searchEvents,
    };
  }

  /**
   * Reset the database by deleting all events
   */
  async resetDatabase(): Promise<void> {
    await this.clearData();
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    // Prisma client is managed globally
  }
}

// Singleton instance
let usageTrackerInstance: UsageTracker | null = null;

/**
 * Get the singleton UsageTracker instance
 */
export function getUsageTracker(_dbPath?: string): UsageTracker {
  if (!usageTrackerInstance) {
    usageTrackerInstance = new UsageTracker();
  }
  return usageTrackerInstance;
}

/**
 * Reset the singleton instance (useful for testing)
 */
export async function resetUsageTracker(): Promise<void> {
  if (usageTrackerInstance) {
    await usageTrackerInstance.close();
    usageTrackerInstance = null;
  }
}
