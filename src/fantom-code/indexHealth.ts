/**
 * Cross-store consistency audit for a single project.
 *
 * Returns counts from each authoritative store along with the gaps between
 * them, so the user (or a future automated check) can see at a glance whether
 * Prisma, LadybugDB, LanceDB, and FlexSearch agree on what's indexed.
 *
 * Used by:
 *   - MCP tool getIndexHealth (src/index.ts)
 *   - Admin endpoint GET /admin/code-projects/:id/health (admin/routes.ts)
 */

import type { PrismaClient } from '@prisma/client';
import { ladybugQuery } from '../graph/ladybugConnection.js';
import { getFantomCodeIndexer } from './indexer.js';

export interface IndexHealthReport {
  project: { id: number; name: string; path: string; language: string };
  prisma: { functions: number; types: number };
  ladybug: { nodes: number; edges: number; byLanguage: Array<{ language: string; count: number }> };
  lance: { vectors: number; coverage: number };
  flexsearch: { symbols: number };
  indexRun: {
    latestId: number | null;
    startedAt: string | null;
    finishedAt: string | null;
    trigger: string | null;
    errors: number;
  } | null;
  diff: {
    missingFromGraph: number;
    missingFromVectors: number;
    missingFromSearch: number;
  };
  topMissingExamples: Array<{ qualifiedName: string; missingFrom: string[] }>;
  healthy: boolean;
  warnings: string[];
}

const langFromPath = (fp: string): string => {
  const ext = fp.includes('.') ? '.' + fp.split('.').pop()!.toLowerCase() : '';
  const map: Record<string, string> = {
    '.fan': 'fantom', '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript', '.vue': 'vue',
    '.py': 'python', '.java': 'java', '.go': 'go', '.rs': 'rust',
    '.css': 'css', '.dart': 'dart', '.cs': 'csharp', '.rb': 'ruby',
    '.php': 'php',
  };
  return map[ext] || 'unknown';
};

export async function getIndexHealth(
  prisma: PrismaClient,
  projectId: number,
): Promise<IndexHealthReport> {
  const project = await prisma.fantomProject.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, path: true, language: true, functionCount: true, typeCount: true },
  });
  if (!project) throw new Error(`Project ${projectId} not found`);

  const warnings: string[] = [];

  // ---------- LadybugDB ----------
  const lbNodes = await ladybugQuery<{ c: number }>(projectId,
    `MATCH (n:CodeNode {project_id: ${projectId}}) RETURN count(n) AS c`,
  );
  const lbEdges = await ladybugQuery<{ c: number }>(projectId,
    `MATCH (a:CodeNode {project_id: ${projectId}})-[e:CodeEdge]->(b:CodeNode) RETURN count(e) AS c`,
  );
  const lbByLang = await ladybugQuery<{ fp: string; c: number }>(projectId,
    `MATCH (n:CodeNode {project_id: ${projectId}}) RETURN n.file_path AS fp, count(n) AS c`,
  );
  const langCounts: Record<string, number> = {};
  for (const r of lbByLang) {
    const l = langFromPath(r.fp);
    langCounts[l] = (langCounts[l] || 0) + Number(r.c);
  }

  const ladybugNodeCount = Number(lbNodes[0]?.c ?? 0);
  const ladybugEdgeCount = Number(lbEdges[0]?.c ?? 0);

  // ---------- LanceDB vectors ----------
  let vectorCount = 0;
  try {
    const { getVectorStore } = await import('../embedding/vectorStore.js');
    const vs = getVectorStore(prisma);
    const ids = await vs.getNodeIdsForProject(projectId);
    vectorCount = ids.size;
  } catch (err) {
    warnings.push(`vector check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ---------- FlexSearch ----------
  let flexSymbols = 0;
  try {
    const indexer = getFantomCodeIndexer();
    const stats = indexer.getStats();
    flexSymbols = stats.byProject[project.name] ?? 0;
  } catch {
    /* FlexSearch is best-effort */
  }

  // ---------- IndexRun (latest) ----------
  let indexRun: IndexHealthReport['indexRun'] = null;
  try {
    const latest = await (prisma as any).indexRun.findFirst({
      where: { projectId },
      orderBy: { startedAt: 'desc' },
      select: {
        id: true,
        startedAt: true,
        finishedAt: true,
        trigger: true,
        errorMessage: true,
        addedCount: true,
        modifiedCount: true,
        removedCount: true,
        isSeedingRun: true,
        filesParsed: true,
      },
    });
    if (latest) {
      indexRun = {
        latestId: latest.id,
        startedAt: latest.startedAt?.toISOString() ?? null,
        finishedAt: latest.finishedAt?.toISOString() ?? null,
        trigger: latest.trigger ?? null,
        errors: latest.errorMessage ? 1 : 0,
      };
      // If the latest run was either seeding or a no-change short-circuit,
      // ApiChange rows aren't expected — surface that as a warning so
      // callers don't read the empty changes table as a bug.
      if (latest.isSeedingRun) {
        warnings.push('Latest run was a seeding run — ApiChange events were intentionally not emitted (would flood the log on first index). Edit a file and reindex to populate change history.');
      } else if (latest.filesParsed === 0) {
        warnings.push('Latest run was a no-change short-circuit (hash gate). ApiChange events emit only when files actually re-parsed.');
      }
    }
  } catch (err) {
    // Schema mismatch or stale Prisma client — surface so we don't silently null the field.
    warnings.push(`indexRun query failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const prismaTotal = project.functionCount + project.typeCount;
  const missingFromGraph = Math.max(0, prismaTotal - ladybugNodeCount);
  const missingFromVectors = Math.max(0, ladybugNodeCount - vectorCount);
  const missingFromSearch = Math.max(0, prismaTotal - flexSymbols);

  // ---------- Top missing examples ----------
  const topMissingExamples: Array<{ qualifiedName: string; missingFrom: string[] }> = [];
  if (missingFromVectors > 0 || missingFromGraph > 0) {
    try {
      const sample = await ladybugQuery<{ id: string; qn: string }>(projectId,
        `MATCH (n:CodeNode {project_id: ${projectId}}) RETURN n.id AS id, n.qualified_name AS qn LIMIT 200`,
      );
      const { getVectorStore } = await import('../embedding/vectorStore.js');
      const vs = getVectorStore(prisma);
      const vectorIds = await vs.getNodeIdsForProject(projectId);
      const missingExamples = sample
        .filter((s) => !vectorIds.has(s.id))
        .slice(0, 5);
      for (const m of missingExamples) {
        topMissingExamples.push({ qualifiedName: m.qn, missingFrom: ['vectors'] });
      }
    } catch {
      // sample is best-effort
    }
  }

  if (ladybugNodeCount === 0 && prismaTotal > 0) {
    warnings.push(
      'graph empty despite Prisma rows — earlier reindex likely hit cross-project hash collisions; run scripts/cleanup-orphan-nodes.mts then reindex',
    );
  }
  if (vectorCount === 0 && ladybugNodeCount > 0) {
    warnings.push('no vectors built — POST /admin/vectors/embed-all to backfill');
  }
  if (project.language && project.language !== 'fantom' && flexSymbols < 100 && prismaTotal > 100) {
    warnings.push(
      `FlexSearch underpopulated for ${project.language} project — searchFantomCode will return empty results`,
    );
  }

  const healthy =
    missingFromGraph === 0 &&
    missingFromVectors === 0 &&
    missingFromSearch === 0 &&
    warnings.length === 0;

  return {
    project: {
      id: project.id,
      name: project.name,
      path: project.path,
      language: project.language,
    },
    prisma: { functions: project.functionCount, types: project.typeCount },
    ladybug: {
      nodes: ladybugNodeCount,
      edges: ladybugEdgeCount,
      byLanguage: Object.entries(langCounts).map(([language, count]) => ({ language, count })),
    },
    lance: {
      vectors: vectorCount,
      coverage:
        ladybugNodeCount > 0
          ? Math.round((vectorCount / ladybugNodeCount) * 100) / 100
          : 0,
    },
    flexsearch: { symbols: flexSymbols },
    indexRun,
    diff: { missingFromGraph, missingFromVectors, missingFromSearch },
    topMissingExamples,
    healthy,
    warnings,
  };
}
