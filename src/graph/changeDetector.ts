/**
 * Git-Diff Impact Mapping
 *
 * Maps code changes (git diff) to affected symbols in the graph,
 * then uses graph traversal to assess downstream impact.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { ladybugQuery } from './ladybugConnection.js';
import { getLadybugQueryManager } from './ladybugQueryManager.js';
import { getOrTraceProcessFlows, findProcessesForFunction } from './processTracer.js';
import type { ImpactResult } from './types.js';
import { createLogger } from '../utils/index.js';

const execAsync = promisify(exec);
const logger = createLogger('change-detector');

/** Escape single quotes for Cypher string literals */
function esc(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// ============================================
// Types
// ============================================

export type DiffScope = 'staged' | 'unstaged' | 'head' | 'branch' | 'commit';

export interface FileChange {
  filePath: string;
  lineRanges: Array<{ start: number; end: number }>;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
}

export interface AffectedSymbol {
  id: string;
  name: string;
  qualifiedName: string;
  nodeType: string;
  filePath: string;
  lineStart: number;
  changeType: 'direct' | 'indirect';
}

export interface ChangeImpactResult {
  changes: FileChange[];
  affectedSymbols: AffectedSymbol[];
  impact: ImpactResult | null;
  processesAffected: number;
  riskScore: number; // 0-100
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
}

// ============================================
// Git Diff Parsing
// ============================================

/**
 * Get changed files from git diff
 */
export async function getChangedFiles(
  projectPath: string,
  scope: DiffScope = 'head',
  ref?: string
): Promise<FileChange[]> {
  let diffCmd: string;

  switch (scope) {
    case 'staged':
      diffCmd = 'git diff --cached -U0 --diff-filter=ACMR';
      break;
    case 'unstaged':
      diffCmd = 'git diff -U0 --diff-filter=ACMR';
      break;
    case 'head':
      diffCmd = 'git diff HEAD~1 -U0 --diff-filter=ACMR';
      break;
    case 'branch':
      diffCmd = `git diff ${ref || 'main'}...HEAD -U0 --diff-filter=ACMR`;
      break;
    case 'commit':
      diffCmd = `git diff ${ref || 'HEAD~1'}..${ref ? ref + '~1' : 'HEAD'} -U0 --diff-filter=ACMR`;
      break;
    default:
      diffCmd = 'git diff HEAD~1 -U0 --diff-filter=ACMR';
  }

  try {
    const { stdout } = await execAsync(diffCmd, { cwd: projectPath });
    return parseDiffOutput(stdout);
  } catch (error) {
    logger.error(`Git diff failed: ${error}`);
    return [];
  }
}

/**
 * Parse unified diff output into FileChange objects
 */
function parseDiffOutput(diff: string): FileChange[] {
  const files = new Map<string, FileChange>();
  let currentFile: string | null = null;

  for (const line of diff.split('\n')) {
    // Match file header: +++ b/path/to/file
    if (line.startsWith('+++ b/')) {
      currentFile = line.substring(6);
      if (!files.has(currentFile)) {
        files.set(currentFile, {
          filePath: currentFile,
          lineRanges: [],
          status: 'modified'
        });
      }
    }

    // Match hunk header: @@ -old,count +new,count @@
    if (line.startsWith('@@') && currentFile) {
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (match) {
        const start = parseInt(match[1], 10);
        const count = parseInt(match[2] || '1', 10);
        const end = start + Math.max(count - 1, 0);
        files.get(currentFile)!.lineRanges.push({ start, end });
      }
    }

    // Detect new files
    if (line.startsWith('--- /dev/null') && currentFile) {
      const fc = files.get(currentFile);
      if (fc) fc.status = 'added';
    }
  }

  return Array.from(files.values());
}

// ============================================
// Symbol Mapping
// ============================================

/**
 * Map file changes to affected symbols in the graph
 */
export async function mapChangesToSymbols(
  changes: FileChange[],
  projectId: number
): Promise<AffectedSymbol[]> {
  const affected: AffectedSymbol[] = [];
  const seenIds = new Set<string>();

  for (const change of changes) {
    // Find all nodes in this file
    const rows = await ladybugQuery<{
      'n.id': string;
      'n.name': string;
      'n.qualified_name': string;
      'n.node_type': string;
      'n.file_path': string;
      'n.line_start': number;
    }>(projectId,
      `MATCH (n:CodeNode {project_id: ${projectId}})
       WHERE n.file_path ENDS WITH '${esc(change.filePath)}'
       RETURN n.id, n.name, n.qualified_name, n.node_type, n.file_path, n.line_start
       ORDER BY n.line_start`
    );

    for (const row of rows) {
      const id = row['n.id'];
      if (seenIds.has(id)) continue;

      // Check if any change range overlaps with this node's location
      const lineStart = Number(row['n.line_start']);
      const isDirect = change.lineRanges.length === 0 || // Whole file changed
        change.status === 'added' ||
        change.lineRanges.some(r => lineStart >= r.start && lineStart <= r.end);

      if (isDirect || change.status === 'added') {
        seenIds.add(id);
        affected.push({
          id,
          name: row['n.name'],
          qualifiedName: row['n.qualified_name'],
          nodeType: row['n.node_type'],
          filePath: row['n.file_path'],
          lineStart: lineStart,
          changeType: isDirect ? 'direct' : 'indirect'
        });
      }
    }
  }

  return affected;
}

// ============================================
// Impact Assessment
// ============================================

/**
 * Assess impact of changes: combine affected symbols with graph traversal
 */
export async function assessChangeImpact(
  projectPath: string,
  projectId: number,
  scope: DiffScope = 'head',
  ref?: string
): Promise<ChangeImpactResult> {
  // Step 1: Get changed files
  const changes = await getChangedFiles(projectPath, scope, ref);

  if (changes.length === 0) {
    return {
      changes: [],
      affectedSymbols: [],
      impact: null,
      processesAffected: 0,
      riskScore: 0,
      riskLevel: 'low',
      summary: 'No code changes detected.'
    };
  }

  // Step 2: Map to symbols
  const affectedSymbols = await mapChangesToSymbols(changes, projectId);

  if (affectedSymbols.length === 0) {
    return {
      changes,
      affectedSymbols: [],
      impact: null,
      processesAffected: 0,
      riskScore: 5,
      riskLevel: 'low',
      summary: `${changes.length} files changed but no indexed symbols affected.`
    };
  }

  // Step 3: Get graph impact for the most significant symbol
  const qm = getLadybugQueryManager();
  let combinedImpact: ImpactResult | null = null;
  let totalAffected = 0;

  // Get impact for each directly changed symbol (limit to top 10)
  const directSymbols = affectedSymbols
    .filter(s => s.changeType === 'direct')
    .slice(0, 10);

  for (const symbol of directSymbols) {
    try {
      const impact = await qm.getImpact(symbol.id, 5);
      totalAffected += impact.totalAffected;
      if (!combinedImpact || impact.totalAffected > combinedImpact.totalAffected) {
        combinedImpact = impact;
      }
    } catch {
      // Node might not have edges
    }
  }

  // Step 4: Check process flows affected
  let processesAffected = 0;
  try {
    const processResult = await getOrTraceProcessFlows(projectId);
    const affectedProcessIds = new Set<number>();
    for (const symbol of affectedSymbols) {
      const procs = findProcessesForFunction(processResult, symbol.id);
      for (const p of procs) affectedProcessIds.add(p.id);
    }
    processesAffected = affectedProcessIds.size;
  } catch {
    // Process tracing not available
  }

  // Step 5: Calculate risk score
  const riskScore = calculateRiskScore(
    affectedSymbols.length,
    totalAffected,
    processesAffected,
    changes.length
  );

  const riskLevel = riskScore >= 75 ? 'critical'
    : riskScore >= 50 ? 'high'
    : riskScore >= 25 ? 'medium'
    : 'low';

  const summary = [
    `${changes.length} file(s) changed, ${affectedSymbols.length} symbol(s) affected.`,
    totalAffected > 0 ? `${totalAffected} downstream node(s) impacted.` : '',
    processesAffected > 0 ? `${processesAffected} execution flow(s) affected.` : '',
    `Risk: ${riskLevel} (${riskScore}/100).`
  ].filter(Boolean).join(' ');

  return {
    changes,
    affectedSymbols,
    impact: combinedImpact,
    processesAffected,
    riskScore,
    riskLevel,
    summary
  };
}

/**
 * Calculate a risk score from 0-100
 */
function calculateRiskScore(
  symbolCount: number,
  downstreamCount: number,
  processCount: number,
  fileCount: number
): number {
  let score = 0;

  // File count contributes up to 20 points
  score += Math.min(fileCount * 4, 20);

  // Direct symbol changes contribute up to 25 points
  score += Math.min(symbolCount * 5, 25);

  // Downstream impact contributes up to 35 points
  score += Math.min(downstreamCount * 2, 35);

  // Process flow disruption contributes up to 20 points
  score += Math.min(processCount * 5, 20);

  return Math.min(score, 100);
}
