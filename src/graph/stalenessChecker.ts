/**
 * Staleness Detection for Graph Index
 *
 * Compares the graph build timestamp against the latest git activity
 * to determine if the graph index is outdated.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import type { PrismaClient } from '@prisma/client';
import { createLogger } from '../utils/index.js';

const execAsync = promisify(exec);
const logger = createLogger('staleness-checker');

export type StalenessStatus = 'fresh' | 'stale' | 'unknown';

export interface StalenessResult {
  status: StalenessStatus;
  lastBuildAt: Date | null;
  latestCommitAt: Date | null;
  staleSinceSeconds: number | null;
  changedFileCount: number;
  changedFiles: string[];
}

/**
 * Check staleness of a project's graph index.
 * Compares GraphBuildStats.lastBuildAt against git history.
 */
export async function checkStaleness(
  prisma: PrismaClient,
  projectId: number,
  projectPath?: string
): Promise<StalenessResult> {
  const unknown: StalenessResult = {
    status: 'unknown',
    lastBuildAt: null,
    latestCommitAt: null,
    staleSinceSeconds: null,
    changedFileCount: 0,
    changedFiles: []
  };

  try {
    // Use FantomProject.lastIndexed as the staleness anchor — the dedicated
    // GraphBuildStats table was removed with the Prisma graph schema; since
    // the graph is rebuilt alongside indexing, lastIndexed is the effective
    // "last graph build" timestamp.
    const project = await prisma.fantomProject.findUnique({
      where: { id: projectId },
      select: { lastIndexed: true }
    });

    if (!project?.lastIndexed) {
      return { ...unknown, status: 'stale' };
    }

    const lastBuildAt = project.lastIndexed;
    const cwd = projectPath || process.cwd();

    // Get latest commit timestamp
    let latestCommitAt: Date | null = null;
    try {
      const { stdout } = await execAsync('git log -1 --format=%ct', { cwd });
      const timestamp = parseInt(stdout.trim(), 10);
      if (!isNaN(timestamp)) {
        latestCommitAt = new Date(timestamp * 1000);
      }
    } catch {
      logger.debug('Could not get git log, repo may not exist at path');
      return unknown;
    }

    // Get files changed since last build
    const buildTimestamp = Math.floor(lastBuildAt.getTime() / 1000);
    let changedFiles: string[] = [];
    try {
      const { stdout } = await execAsync(
        `git diff --name-only HEAD $(git rev-list -1 --before=${buildTimestamp} HEAD) 2>/dev/null || git diff --name-only --diff-filter=ACMR HEAD`,
        { cwd }
      );
      changedFiles = stdout.trim().split('\n').filter(f => f.length > 0);
    } catch {
      // Fallback: check git status for modified files
      try {
        const { stdout } = await execAsync('git diff --name-only', { cwd });
        changedFiles = stdout.trim().split('\n').filter(f => f.length > 0);
      } catch {
        logger.debug('Could not determine changed files');
      }
    }

    // Determine staleness
    const staleSinceSeconds = latestCommitAt
      ? Math.max(0, Math.floor((latestCommitAt.getTime() - lastBuildAt.getTime()) / 1000))
      : null;

    const isStale = (latestCommitAt && latestCommitAt > lastBuildAt) || changedFiles.length > 0;

    return {
      status: isStale ? 'stale' : 'fresh',
      lastBuildAt,
      latestCommitAt,
      staleSinceSeconds: isStale ? staleSinceSeconds : 0,
      changedFileCount: changedFiles.length,
      changedFiles: changedFiles.slice(0, 50) // Cap at 50
    };
  } catch (error) {
    logger.error(`Staleness check failed: ${error}`);
    return unknown;
  }
}
