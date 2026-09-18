/**
 * Code Sample Extractor for searchVersionedApi
 *
 * Extracts code samples from:
 * - Workflow markdown files (fenced code blocks)
 * - Source code (method bodies from indexed functions)
 *
 * Provides two main search approaches:
 * 1. Find Usage - Find all call sites where a function/method is called
 * 2. Get Examples - Get real-world usage examples sorted by complexity
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/index.js';
import { getFantomFunctionSearchIndex } from '../fantom-code/searchIndex.js';
import type { FantomFunction } from '../fantom-code/types.js';

const logger = createLogger('code-samples');

/**
 * Represents a function usage/call site found in source code
 */
export interface FantomFunctionUsage {
  functionName: string;
  file: string;
  line: number;
  column: number;
  context: string;              // The exact line of code
  arguments: string[];          // Parsed function arguments
  callingFunction?: string;     // Which function contains this call
  isMethodCall: boolean;
  receiver?: string;            // For method calls like client.get()
  surroundingLines: string[];   // ±2-5 lines of context
  projectId: number;
  instanceId?: number;
  version?: string;
}

/**
 * Represents a code example with complexity rating
 */
export interface FantomFunctionExample {
  file: string;
  line: number;
  code: string;                 // Full surrounding code block
  description?: string;         // "Method call on X, N arguments, called from Y"
  complexity: 'simple' | 'medium' | 'complex';
  version?: string;
  source: 'workflow' | 'source';
}

/**
 * Code sample from a workflow markdown file
 */
export interface WorkflowCodeSample {
  id: string;
  workflowId: string;
  workflowTitle: string;
  language: 'fantom' | 'axon' | 'shell' | 'other';
  code: string;
  context: string;              // Surrounding text/heading
  line: number;
  version?: string;             // Detected version context
}

/**
 * Options for searching code samples
 */
export interface CodeSampleSearchOptions {
  query: string;
  limit?: number;
  version?: string;
  language?: 'fantom' | 'axon' | 'all';
  complexity?: 'simple' | 'medium' | 'complex' | 'all';
  includeWorkflows?: boolean;
  includeSourceCode?: boolean;
}

/**
 * Result from searching code samples
 */
export interface CodeSampleSearchResult {
  samples: FantomFunctionExample[];
  usages: FantomFunctionUsage[];
  workflowSamples: WorkflowCodeSample[];
  totalCount: number;
  searchDuration: number;
}

/**
 * Extract code samples from workflow markdown files
 */
export class CodeSampleExtractor {
  private workflowDir: string;
  private cachedWorkflowSamples: WorkflowCodeSample[] | null = null;

  constructor(workflowDir: string = path.join(process.cwd(), 'workflows')) {
    this.workflowDir = workflowDir;
  }

  /**
   * Search for code samples matching a query
   */
  async search(options: CodeSampleSearchOptions): Promise<CodeSampleSearchResult> {
    const startTime = Date.now();
    const limit = options.limit || 10;
    const language = options.language || 'all';

    const result: CodeSampleSearchResult = {
      samples: [],
      usages: [],
      workflowSamples: [],
      totalCount: 0,
      searchDuration: 0
    };

    // Search workflow samples
    if (options.includeWorkflows !== false) {
      const workflowSamples = await this.searchWorkflowSamples(
        options.query,
        language,
        options.version,
        limit
      );
      result.workflowSamples = workflowSamples;
    }

    // Search source code for usages
    if (options.includeSourceCode !== false) {
      const { usages, examples } = await this.searchSourceCode(
        options.query,
        options.version,
        options.complexity || 'all',
        limit
      );
      result.usages = usages;
      result.samples = examples;
    }

    result.totalCount = result.samples.length + result.usages.length + result.workflowSamples.length;
    result.searchDuration = Date.now() - startTime;

    return result;
  }

  /**
   * Search workflow markdown files for code samples
   */
  private async searchWorkflowSamples(
    query: string,
    language: 'fantom' | 'axon' | 'all',
    version: string | undefined,
    limit: number
  ): Promise<WorkflowCodeSample[]> {
    // Load and cache workflow samples
    if (!this.cachedWorkflowSamples) {
      this.cachedWorkflowSamples = await this.parseWorkflowFiles();
    }

    const queryLower = query.toLowerCase();

    // Filter samples by query match
    let matches = this.cachedWorkflowSamples.filter(sample => {
      // Check code content
      if (sample.code.toLowerCase().includes(queryLower)) return true;
      // Check context
      if (sample.context.toLowerCase().includes(queryLower)) return true;
      return false;
    });

    // Filter by language
    if (language !== 'all') {
      matches = matches.filter(s => s.language === language);
    }

    // Filter by version compatibility (if version context provided)
    if (version) {
      matches = matches.filter(s => {
        // If sample has no version, include it
        if (!s.version) return true;
        // Simple version comparison (sample version <= target version)
        return this.isVersionCompatible(s.version, version);
      });
    }

    // Score and sort by relevance
    const scored = matches.map(sample => ({
      sample,
      score: this.scoreSample(query, sample)
    }));

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map(s => s.sample);
  }

  /**
   * Search source code for function usages and examples
   */
  private async searchSourceCode(
    query: string,
    version: string | undefined,
    complexity: 'simple' | 'medium' | 'complex' | 'all',
    limit: number
  ): Promise<{ usages: FantomFunctionUsage[]; examples: FantomFunctionExample[] }> {
    const usages: FantomFunctionUsage[] = [];
    const examples: FantomFunctionExample[] = [];

    const searchIndex = getFantomFunctionSearchIndex();

    // Search for functions that match the query
    const searchResults = searchIndex.search(query, {
      limit: limit * 2,
      compatibleWith: version
    });

    // Extract usages and examples from matched functions
    for (const result of searchResults) {
      const func = result.function;

      // If the function has source code, extract examples from it
      if (func.sourceCode) {
        const extracted = this.extractExamplesFromFunction(func, query);
        examples.push(...extracted.examples);
        usages.push(...extracted.usages);
      }
    }

    // Now search for call sites where the query function is USED
    // This searches in the sourceCode of ALL indexed functions
    const callSiteResults = this.findCallSites(query, version, limit);
    usages.push(...callSiteResults);

    // Filter by complexity
    let filteredExamples = examples;
    if (complexity !== 'all') {
      filteredExamples = examples.filter(e => e.complexity === complexity);
    }

    // Sort examples by complexity (simple first)
    const complexityOrder = { simple: 0, medium: 1, complex: 2 };
    filteredExamples.sort((a, b) => complexityOrder[a.complexity] - complexityOrder[b.complexity]);

    return {
      usages: usages.slice(0, limit),
      examples: filteredExamples.slice(0, limit)
    };
  }

  /**
   * Find call sites where a function is invoked in other code
   */
  private findCallSites(
    functionName: string,
    version: string | undefined,
    limit: number
  ): FantomFunctionUsage[] {
    const usages: FantomFunctionUsage[] = [];
    const searchIndex = getFantomFunctionSearchIndex();

    // Get all functions and search their source code for call sites
    // We search in sourceCode field for the function name being called
    const allResults = searchIndex.search(functionName, {
      limit: 1000, // Search broadly
      compatibleWith: version
    });

    // Build regex to match function calls (not definitions)
    // Match: functionName( or .functionName( or ::functionName(
    const callPattern = new RegExp(
      `(?:\\.|::)?${escapeRegex(functionName)}\\s*\\(`,
      'g'
    );

    for (const result of allResults) {
      const func = result.function;
      if (!func.sourceCode) continue;

      // Skip the function's own definition
      if (func.name === functionName) continue;

      // Search for call sites in the source code
      const lines = func.sourceCode.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (callPattern.test(line)) {
          // Found a call site
          const context = this.extractSurroundingLines(lines, i, 2);

          usages.push({
            functionName,
            file: func.filePath,
            line: (func.lineNumber || 0) + i,
            column: line.indexOf(functionName),
            context: line.trim(),
            arguments: this.parseArguments(line, functionName),
            callingFunction: func.name,
            isMethodCall: line.includes(`.${functionName}`),
            receiver: this.extractReceiver(line, functionName),
            surroundingLines: context,
            projectId: func.projectId
          });
        }

        // Reset regex lastIndex
        callPattern.lastIndex = 0;
      }
    }

    return usages.slice(0, limit);
  }

  /**
   * Extract examples from a function's source code
   */
  private extractExamplesFromFunction(
    func: FantomFunction,
    _query: string // Query param reserved for future query-based filtering
  ): { examples: FantomFunctionExample[]; usages: FantomFunctionUsage[] } {
    const examples: FantomFunctionExample[] = [];
    const usages: FantomFunctionUsage[] = [];

    if (!func.sourceCode) {
      return { examples, usages };
    }

    // The function itself is an example of the query pattern
    const complexity = this.calculateComplexity(func);

    // Extract version from project/instance
    let version: string | undefined;
    const searchIndex = getFantomFunctionSearchIndex();
    const project = searchIndex.getProject(func.projectId);
    if (project?.instanceId) {
      const instance = searchIndex.getInstance(project.instanceId);
      version = instance?.version;
    }
    // Fallback: extract version from file path (e.g., /fantom-1.0.78/)
    if (!version) {
      const versionMatch = func.filePath.match(/fantom-(\d+\.\d+\.\d+)|haxall-(\d+\.\d+\.\d+)/);
      if (versionMatch) {
        version = versionMatch[1] ? `Fantom ${versionMatch[1]}` : `Haxall ${versionMatch[2]}`;
      }
    }

    examples.push({
      file: func.filePath,
      line: func.lineNumber || 0,
      code: func.sourceCode,
      description: this.describeFunction(func),
      complexity,
      version,
      source: 'source'
    });

    return { examples, usages };
  }

  /**
   * Parse workflow markdown files and extract code samples
   */
  private async parseWorkflowFiles(): Promise<WorkflowCodeSample[]> {
    const samples: WorkflowCodeSample[] = [];

    if (!fs.existsSync(this.workflowDir)) {
      logger.warn(`Workflow directory not found: ${this.workflowDir}`);
      return samples;
    }

    const files = fs.readdirSync(this.workflowDir)
      .filter(f => f.endsWith('.md'));

    for (const file of files) {
      try {
        const filePath = path.join(this.workflowDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const workflowId = file.replace(/\.md$/, '');
        const workflowTitle = this.extractTitle(content) || workflowId;

        // Extract fenced code blocks
        const codeBlocks = this.extractCodeBlocks(content, workflowId, workflowTitle);
        samples.push(...codeBlocks);
      } catch (error) {
        logger.warn(`Failed to parse workflow ${file}: ${error}`);
      }
    }

    logger.debug(`Parsed ${samples.length} code samples from ${files.length} workflow files`);
    return samples;
  }

  /**
   * Extract fenced code blocks from markdown content
   */
  private extractCodeBlocks(
    content: string,
    workflowId: string,
    workflowTitle: string
  ): WorkflowCodeSample[] {
    const samples: WorkflowCodeSample[] = [];

    // Match fenced code blocks with optional language
    const codeBlockRegex = /```(\w+)?\s*\n([\s\S]*?)```/g;

    let match;
    let lineNumber = 1;

    while ((match = codeBlockRegex.exec(content)) !== null) {
      const lang = match[1]?.toLowerCase() || 'other';
      const code = match[2].trim();

      // Calculate line number
      const beforeMatch = content.substring(0, match.index);
      lineNumber = (beforeMatch.match(/\n/g) || []).length + 1;

      // Determine language type
      let language: 'fantom' | 'axon' | 'shell' | 'other';
      if (lang === 'fantom' || lang === 'fan') {
        language = 'fantom';
      } else if (lang === 'axon') {
        language = 'axon';
      } else if (lang === 'bash' || lang === 'sh' || lang === 'shell') {
        language = 'shell';
      } else {
        language = 'other';
      }

      // Extract surrounding context (previous heading or paragraph)
      const context = this.extractContext(content, match.index);

      // Detect version from context
      const version = this.detectVersionFromContext(context);

      samples.push({
        id: `${workflowId}-${lineNumber}`,
        workflowId,
        workflowTitle,
        language,
        code,
        context,
        line: lineNumber,
        version
      });
    }

    return samples;
  }

  /**
   * Extract context (heading or preceding text) for a code block
   */
  private extractContext(content: string, codeBlockIndex: number): string {
    const beforeBlock = content.substring(0, codeBlockIndex);
    const lines = beforeBlock.split('\n').reverse();

    // Find the nearest heading
    for (let i = 0; i < Math.min(lines.length, 10); i++) {
      const line = lines[i].trim();
      if (line.startsWith('#')) {
        return line.replace(/^#+\s*/, '');
      }
    }

    // If no heading found, return last non-empty line
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('```')) {
        return trimmed.substring(0, 100);
      }
    }

    return '';
  }

  /**
   * Extract title from markdown content
   */
  private extractTitle(content: string): string | null {
    const match = content.match(/^#+\s+(.+)$/m);
    return match ? match[1].trim() : null;
  }

  /**
   * Detect version from context text
   */
  private detectVersionFromContext(context: string): string | undefined {
    // Look for version patterns like "4.0", "3.1.12", "SkySpark 4.0.3"
    const versionMatch = context.match(/(?:version\s+)?(\d+\.\d+(?:\.\d+)?)/i);
    if (versionMatch) {
      return versionMatch[1];
    }

    // Check for major version keywords
    if (context.toLowerCase().includes('4.0') || context.toLowerCase().includes('4.x')) {
      return '4.0';
    }
    if (context.toLowerCase().includes('3.1') || context.toLowerCase().includes('3.x')) {
      return '3.1';
    }

    return undefined;
  }

  /**
   * Score a workflow sample for relevance
   */
  private scoreSample(query: string, sample: WorkflowCodeSample): number {
    let score = 0;
    const queryLower = query.toLowerCase();
    const codeLower = sample.code.toLowerCase();
    const contextLower = sample.context.toLowerCase();

    // Exact match in code
    if (codeLower.includes(queryLower)) {
      score += 2;
    }

    // Match in context
    if (contextLower.includes(queryLower)) {
      score += 1;
    }

    // Prefer Fantom/Axon over shell/other
    if (sample.language === 'fantom' || sample.language === 'axon') {
      score += 0.5;
    }

    // Prefer smaller, focused examples
    const lineCount = (sample.code.match(/\n/g) || []).length + 1;
    if (lineCount <= 10) {
      score += 0.3;
    }

    return score;
  }

  /**
   * Calculate complexity of a function
   */
  private calculateComplexity(func: FantomFunction): 'simple' | 'medium' | 'complex' {
    // Simple: no params or single simple param
    if (func.parameters.length === 0) {
      return 'simple';
    }
    if (func.parameters.length === 1 && !func.parameters[0].type.includes('|')) {
      return 'simple';
    }

    // Complex: 4+ params or complex types
    if (func.parameters.length >= 4) {
      return 'complex';
    }

    const hasComplexTypes = func.parameters.some(p =>
      p.type.includes('|') ||
      p.type.includes('[') ||
      p.type.includes(':') ||
      p.type.includes('{')
    );

    if (hasComplexTypes) {
      return 'complex';
    }

    return 'medium';
  }

  /**
   * Generate a description for a function
   */
  private describeFunction(func: FantomFunction): string {
    const parts: string[] = [];

    if (func.isStatic) parts.push('Static');
    parts.push(func.type);
    parts.push(`"${func.name}"`);

    if (func.className) {
      parts.push(`in ${func.className}`);
    }

    if (func.parameters.length > 0) {
      parts.push(`with ${func.parameters.length} parameter(s)`);
    }

    if (func.returnType && func.returnType !== 'Void') {
      parts.push(`returning ${func.returnType}`);
    }

    return parts.join(' ');
  }

  /**
   * Extract surrounding lines for context
   */
  private extractSurroundingLines(lines: string[], index: number, radius: number): string[] {
    const start = Math.max(0, index - radius);
    const end = Math.min(lines.length, index + radius + 1);
    return lines.slice(start, end);
  }

  /**
   * Parse arguments from a function call
   */
  private parseArguments(line: string, functionName: string): string[] {
    // Find the function call and extract arguments
    const callStart = line.indexOf(functionName);
    if (callStart === -1) return [];

    const parenStart = line.indexOf('(', callStart);
    if (parenStart === -1) return [];

    let depth = 1;
    let current = '';
    const args: string[] = [];

    for (let i = parenStart + 1; i < line.length && depth > 0; i++) {
      const char = line[i];
      if (char === '(') depth++;
      else if (char === ')') depth--;
      else if (char === ',' && depth === 1) {
        args.push(current.trim());
        current = '';
        continue;
      }
      if (depth > 0) current += char;
    }

    if (current.trim()) {
      args.push(current.trim());
    }

    return args;
  }

  /**
   * Extract receiver from a method call
   */
  private extractReceiver(line: string, functionName: string): string | undefined {
    const pattern = new RegExp(`(\\w+)\\.${escapeRegex(functionName)}\\s*\\(`);
    const match = line.match(pattern);
    return match ? match[1] : undefined;
  }

  /**
   * Simple version compatibility check
   */
  private isVersionCompatible(sourceVersion: string, targetVersion: string): boolean {
    const source = sourceVersion.split('.').map(n => parseInt(n, 10) || 0);
    const target = targetVersion.split('.').map(n => parseInt(n, 10) || 0);

    for (let i = 0; i < Math.max(source.length, target.length); i++) {
      const s = source[i] || 0;
      const t = target[i] || 0;
      if (s < t) return true;
      if (s > t) return false;
    }
    return true; // Equal versions
  }

  /**
   * Clear cached workflow samples
   */
  clearCache(): void {
    this.cachedWorkflowSamples = null;
  }
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Singleton instance
let codeSampleExtractorInstance: CodeSampleExtractor | null = null;

/**
 * Get the singleton CodeSampleExtractor instance
 */
export function getCodeSampleExtractor(workflowDir?: string): CodeSampleExtractor {
  if (!codeSampleExtractorInstance) {
    codeSampleExtractorInstance = new CodeSampleExtractor(workflowDir);
  }
  return codeSampleExtractorInstance;
}

/**
 * Reset the singleton instance
 */
export function resetCodeSampleExtractor(): void {
  if (codeSampleExtractorInstance) {
    codeSampleExtractorInstance.clearCache();
    codeSampleExtractorInstance = null;
  }
}
