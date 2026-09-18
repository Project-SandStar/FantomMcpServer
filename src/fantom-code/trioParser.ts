/**
 * Trio Parser - parses SkySpark .trio files containing Axon functions and view definitions
 *
 * Ported from the official SkySpark TrioReader.fan:
 * - Records separated by lines starting with "-"
 * - name:value tag pairs; no colon = marker tag
 * - Empty value after colon = indented multi-line text block
 * - Trio: prefix = recursively parsed nested trio record
 * - Supports both single-record files and multi-record files (--- separated)
 */

import * as fs from 'fs';
import { createLogger } from '../utils/index.js';
import type {
  FantomFunction,
  FantomTypeDef,
  ParsedFile,
  ParseError,
  Parameter,
  FunctionCall,
  PodMeta,
  TypeDefKind
} from './types.js';
import {
  generateFunctionId,
  generateTypeId,
  categorizeFunction,
  generateTags,
  formatSignature,
  FantomCategory
} from './types.js';
import type { TreeSitterCodeParser } from './treeSitterAdapter.js';

const logger = createLogger('trio-parser');

// ============================================
// Trio Record Type
// ============================================

/** Marker value for tags with no value (e.g., "func" on its own line) */
const MARKER = Symbol('marker');

type TrioValue = string | boolean | number | typeof MARKER | TrioRecord | null;

interface TrioRecord {
  [key: string]: TrioValue;
}

// ============================================
// Trio Reader - port of TrioReader.fan
// ============================================

class TrioReader {
  private lines: string[];
  private cursor: number = 0;
  private pushback: string | null = null;

  constructor(text: string) {
    this.lines = text.split('\n');
  }

  /** Read all records from the text */
  readAllRecords(): TrioRecord[] {
    const records: TrioRecord[] = [];
    while (true) {
      const rec = this.readRecord();
      if (rec === null) break;
      records.push(rec);
    }
    return records;
  }

  /** Read next record, or null if at end */
  private readRecord(): TrioRecord | null {
    const tags: TrioRecord = {};

    // Skip separator lines and find first tag
    let r = this.readTag();
    if (r === null) return null; // end of file
    while (r === 'separator') {
      r = this.readTag();
      if (r === null) return null;
    }

    // First tag
    tags[r.name] = r.value;

    // Read remaining tags in this record
    while (true) {
      r = this.readTag();
      if (r === null || r === 'separator') break;
      tags[r.name] = r.value;
    }

    return Object.keys(tags).length > 0 ? tags : null;
  }

  /** Read a single tag. Returns null for EOF, 'separator' for record boundary, or {name, value} */
  private readTag(): { name: string; value: TrioValue } | 'separator' | null {
    let line = this.readLine();

    // Skip empty lines and comments
    while (true) {
      if (line === null) return null; // EOF
      if (line.startsWith('-')) return 'separator';
      if (line.trim().length === 0 || line.startsWith('//')) {
        line = this.readLine();
        continue;
      }
      break;
    }

    // Parse name:value
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      // Marker tag (no colon) - e.g., "func"
      return { name: line.trim(), value: MARKER };
    }

    const name = line.substring(0, colonIdx).trim();
    const valStr = line.substring(colonIdx + 1).trim();

    let value: TrioValue;
    if (valStr.length === 0) {
      // Empty value = read indented text block
      value = this.readIndentedText();
    } else {
      value = this.parseScalar(valStr);
    }

    return { name, value };
  }

  /** Read indented text block (multi-line value). Lines must start with whitespace. */
  private readIndentedText(): string {
    let minIndent = Infinity;
    const textLines: string[] = [];

    while (true) {
      const line = this.readLine();
      if (line === null) break;

      // Non-indented, non-empty line = end of block (push back)
      if (line.length > 0 && !line[0].match(/\s/)) {
        this.pushback = line;
        break;
      }

      textLines.push(line.trimEnd());

      // Find minimum indent of non-empty lines
      for (let i = 0; i < line.length; i++) {
        if (!line[i].match(/\s/)) {
          if (i < minIndent) minIndent = i;
          break;
        }
      }
    }

    // Strip minimum indent from all lines
    if (minIndent === Infinity) minIndent = 0;
    return textLines
      .map(l => l.length <= minIndent ? '' : l.substring(minIndent))
      .join('\n');
  }

  /** Parse a scalar value string */
  private parseScalar(s: string): TrioValue {
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'NA' || s === 'NaN' || s === 'INF' || s === 'R') return s;

    // Trio: prefix = nested trio record
    if (s === 'Trio:') {
      const text = this.readIndentedText();
      const reader = new TrioReader(text);
      const rec = reader.readAllRecords();
      return rec.length > 0 ? rec[0] : null;
    }

    // Quoted string
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('`') && s.endsWith('`'))) {
      return s.substring(1, s.length - 1);
    }

    // Ref
    if (s.startsWith('@')) return s;

    // Return as plain string for everything else
    return s;
  }

  private readLine(): string | null {
    if (this.pushback !== null) {
      const s = this.pushback;
      this.pushback = null;
      return s;
    }
    if (this.cursor >= this.lines.length) return null;
    return this.lines[this.cursor++];
  }
}

// ============================================
// Axon Source Helpers
// ============================================

/** Axon parameter pattern: (param1: default, param2, param3: val) => */
const AXON_PARAMS_PATTERN = /\(([^)]*)\)\s*=>/;

/** Extract parameters from Axon function source */
function extractAxonParams(src: string): Parameter[] {
  // Skip leading comments and blank lines to find the lambda signature
  const lines = src.split('\n');
  let codePart = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.length === 0) continue;
    codePart = trimmed;
    break;
  }

  const match = codePart.match(AXON_PARAMS_PATTERN);
  if (!match || !match[1].trim()) return [];

  const paramStr = match[1].trim();
  const params: Parameter[] = [];

  for (const part of paramStr.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx !== -1) {
      params.push({
        name: trimmed.substring(0, colonIdx).trim(),
        type: 'Obj',
        defaultValue: trimmed.substring(colonIdx + 1).trim()
      });
    } else {
      params.push({ name: trimmed, type: 'Obj' });
    }
  }
  return params;
}

/** Extract function calls from Axon source code */
function extractAxonCalls(src: string, baseLineNumber: number): FunctionCall[] {
  const calls: FunctionCall[] = [];
  const seen = new Set<string>();
  const lines = src.split('\n');

  // Axon keywords to exclude
  const excluded = new Set([
    'if', 'else', 'do', 'end', 'for', 'while', 'try', 'catch', 'throw',
    'return', 'true', 'false', 'null', 'not', 'and', 'or', 'each',
    'eachWhile', 'map', 'findAll', 'find', 'any', 'all', 'reduce',
    'toGrid', 'toList', 'toRecList'
  ]);

  // Direct function calls: funcName(
  const directCallPattern = /(?<![.\->])\b([a-z_]\w*)\s*\(/gi;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comment lines
    if (line.trim().startsWith('//')) continue;

    let match: RegExpExecArray | null;
    directCallPattern.lastIndex = 0;
    while ((match = directCallPattern.exec(line)) !== null) {
      const name = match[1];
      if (excluded.has(name)) continue;

      const key = `${name}:${i}`;
      if (seen.has(key)) continue;
      seen.add(key);

      calls.push({
        calledName: name,
        lineNumber: baseLineNumber + i,
        isStatic: false,
        isDynamic: false,
        isConstructor: false,
        resolved: false
      });
    }
  }

  return calls;
}

// ============================================
// View Description Builder
// ============================================

/** Build a human-readable description from a view's trio record for embedding */
function buildViewDescription(rec: TrioRecord): string {
  const parts: string[] = [];

  const dis = rec['dis'];
  if (typeof dis === 'string') parts.push(`Display: ${dis}`);

  const appName = rec['appName'];
  if (typeof appName === 'string') parts.push(`App: ${appName}`);

  // Extract src block info
  const src = rec['src'];
  if (typeof src === 'string') {
    // Extract layout
    const layoutMatch = src.match(/layout:\s*\{[^}]*defVal:"([^"]+)"/);
    if (layoutMatch) parts.push(`Layout: ${layoutMatch[1]}`);

    // Extract subview types
    const subViews: string[] = [];
    const inheritPattern = /(\w+):\s*Trio:\s*\n\s*view:\s*\{inherit:"(\w+)"/g;
    let m: RegExpExecArray | null;
    while ((m = inheritPattern.exec(src)) !== null) {
      subViews.push(`${m[1]}(${m[2]})`);
    }
    if (subViews.length > 0) parts.push(`SubViews: ${subViews.join(', ')}`);

    // Extract data expressions for embedding context
    const exprPattern = /data:\s*\{expr:"([^"]+)"/g;
    const exprs: string[] = [];
    while ((m = exprPattern.exec(src)) !== null) {
      exprs.push(m[1].replace(/\\\\/g, '\\').substring(0, 100));
    }
    if (exprs.length > 0) parts.push(`Data expressions: ${exprs.join('; ')}`);
  }

  return parts.join('. ') || 'SkySpark view definition';
}

/** Extract subview methods from a view record's src for graph building */
function extractSubViewMethods(
  rec: TrioRecord,
  filePath: string,
  projectId: number,
  viewQualifiedName: string,
  lineNumber: number
): FantomFunction[] {
  const methods: FantomFunction[] = [];
  const src = rec['src'];
  if (typeof src !== 'string') return methods;

  // Match subView definitions: subViewN: Trio:
  const subViewPattern = /^(\w+):\s*Trio:$/gm;
  let m: RegExpExecArray | null;
  const srcLines = src.split('\n');

  while ((m = subViewPattern.exec(src)) !== null) {
    const subName = m[1];
    const subLineIdx = src.substring(0, m.index).split('\n').length;

    // Find the inherit type and data expr for this subview
    let inheritType = 'unknown';
    let dataExpr = '';
    // Look at lines after the Trio: line
    for (let i = subLineIdx; i < srcLines.length && i < subLineIdx + 10; i++) {
      const line = srcLines[i];
      const inhMatch = line.match(/view:\s*\{inherit:"(\w+)"/);
      if (inhMatch) inheritType = inhMatch[1];
      const dataMatch = line.match(/data:\s*\{expr:"([^"]+)"/);
      if (dataMatch) dataExpr = dataMatch[1].replace(/\\\\/g, '\\');
    }

    const subQName = `${viewQualifiedName}.${subName}`;
    methods.push({
      id: generateFunctionId(filePath, subQName, lineNumber + subLineIdx),
      projectId,
      name: subName,
      qualifiedName: subQName,
      type: 'field',
      className: rec['view'] as string || undefined,
      filePath,
      lineNumber: lineNumber + subLineIdx,
      signature: `${inheritType} ${subName}`,
      returnType: inheritType,
      parameters: [],
      description: dataExpr ? `Data: ${dataExpr.substring(0, 200)}` : `SubView of type ${inheritType}`,
      sourceCode: undefined,
      category: FantomCategory.UI,
      tags: ['subview', inheritType, 'axon'],
      isPublic: true,
      isStatic: false,
      isAbstract: false,
      isOverride: false,
      isVirtual: false,
      facets: []
    });
  }

  return methods;
}

// ============================================
// Main Parser
// ============================================

export class TrioParser {
  private projectId: number;
  private podName?: string;
  private treeSitter: TreeSitterCodeParser | null;

  constructor(projectId: number, podName?: string, treeSitter?: TreeSitterCodeParser | null) {
    this.projectId = projectId;
    this.podName = podName;
    this.treeSitter = treeSitter || null;
  }

  /** Parse a .trio file and return a ParsedFile compatible with the indexing pipeline */
  async parseFile(filePath: string): Promise<ParsedFile> {
    const errors: ParseError[] = [];
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return await this.parseString(content, filePath, errors);
    } catch (err) {
      errors.push({
        file: filePath,
        message: `Failed to read trio file: ${err instanceof Error ? err.message : String(err)}`,
        severity: 'error'
      });
      return { filePath, types: [], functions: [], imports: [], usings: [], errors };
    }
  }

  /** Parse trio text content into a ParsedFile */
  async parseString(content: string, filePath: string, errors: ParseError[] = []): Promise<ParsedFile> {
    const functions: FantomFunction[] = [];
    const types: FantomTypeDef[] = [];

    try {
      const reader = new TrioReader(content);
      const records = reader.readAllRecords();

      let lineOffset = 1;
      for (const rec of records) {
        if (this.isFunctionRecord(rec)) {
          const func = await this.recordToFunction(rec, filePath, lineOffset);
          if (func) functions.push(func);
        } else if (this.isViewRecord(rec)) {
          const view = this.recordToView(rec, filePath, lineOffset);
          if (view) types.push(view);
        } else if (this.isAppRecord(rec)) {
          const app = this.recordToApp(rec, filePath, lineOffset);
          if (app) types.push(app);
        }

        // Estimate line offset for next record (count lines in src + tags)
        const src = rec['src'];
        if (typeof src === 'string') {
          lineOffset += src.split('\n').length + Object.keys(rec).length + 1;
        } else {
          lineOffset += Object.keys(rec).length + 1;
        }
      }

      logger.debug(`Parsed ${filePath}: ${functions.length} functions, ${types.length} views/apps`);
    } catch (err) {
      errors.push({
        file: filePath,
        message: `Trio parse error: ${err instanceof Error ? err.message : String(err)}`,
        severity: 'error'
      });
    }

    return { filePath, types, functions, imports: [], usings: [], errors };
  }

  // ============================================
  // Record Classification
  // ============================================

  private isFunctionRecord(rec: TrioRecord): boolean {
    // Explicit func marker (pod format: name + func + src)
    if (rec['func'] === MARKER && typeof rec['name'] === 'string') return true;
    // Implicit function: has name + src with Axon lambda pattern (project export format)
    if (typeof rec['name'] === 'string' && typeof rec['src'] === 'string') {
      const src = rec['src'] as string;
      return /^\s*\(.*?\)\s*=>/.test(src);
    }
    return false;
  }

  private isViewRecord(rec: TrioRecord): boolean {
    return typeof rec['view'] === 'string' && typeof rec['src'] === 'string';
  }

  private isAppRecord(rec: TrioRecord): boolean {
    return typeof rec['app'] === 'string';
  }

  // ============================================
  // Record Conversion
  // ============================================

  /** Convert a function trio record to FantomFunction */
  private async recordToFunction(rec: TrioRecord, filePath: string, lineNumber: number): Promise<FantomFunction | null> {
    const nameVal = rec['name'];
    if (typeof nameVal !== 'string') return null;

    // Strip quotes if present
    const name = nameVal.replace(/^"|"$/g, '');
    const src = typeof rec['src'] === 'string' ? rec['src'] : '';
    const pod = this.podName || 'unknown';
    const qualifiedName = `${pod}::${name}`;

    let params: Parameter[];
    let calls: FunctionCall[];
    let description: string;

    // Try tree-sitter for richer Axon parsing
    if (this.treeSitter && src) {
      try {
        const tsResult = await this.treeSitter.parseFile(`${name}.axon`, src);
        // Use tree-sitter extracted functions if available
        const tsFunc = tsResult.functions[0];
        if (tsFunc) {
          params = tsFunc.parameters.length > 0 ? tsFunc.parameters : extractAxonParams(src);
          calls = tsFunc.calls || extractAxonCalls(src, lineNumber);
          description = tsFunc.documentation || tsFunc.description || this.extractDescription(src);
        } else {
          params = extractAxonParams(src);
          calls = extractAxonCalls(src, lineNumber);
          description = this.extractDescription(src);
        }
      } catch {
        // Fall back to regex on tree-sitter failure
        params = extractAxonParams(src);
        calls = extractAxonCalls(src, lineNumber);
        description = this.extractDescription(src);
      }
    } else {
      params = extractAxonParams(src);
      calls = extractAxonCalls(src, lineNumber);
      description = this.extractDescription(src);
    }

    const func: FantomFunction = {
      id: generateFunctionId(filePath, qualifiedName, lineNumber),
      projectId: this.projectId,
      name,
      qualifiedName,
      type: 'method',
      filePath,
      lineNumber,
      signature: formatSignature(name, 'Obj', params),
      returnType: 'Obj',
      parameters: params,
      description,
      documentation: description,
      sourceCode: src,
      category: categorizeFunction({ name, documentation: description }, { podName: pod } as PodMeta),
      tags: ['axon', 'trio', ...generateTags({ name, type: 'method', isPublic: true, category: FantomCategory.OTHER })],
      isPublic: true,
      isStatic: false,
      isAbstract: false,
      isOverride: false,
      isVirtual: false,
      facets: [],
      calls
    };

    return func;
  }

  /** Convert a view trio record to FantomTypeDef */
  private recordToView(rec: TrioRecord, filePath: string, lineNumber: number): FantomTypeDef | null {
    const viewName = rec['view'] as string;
    if (!viewName) return null;

    const pod = this.podName || 'unknown';
    const qualifiedName = `${pod}::${viewName}`;
    const dis = typeof rec['dis'] === 'string' ? rec['dis'] : viewName;
    const appName = typeof rec['appName'] === 'string' ? rec['appName'] : undefined;
    const description = buildViewDescription(rec);

    // Extract subview methods for graph building
    const methods = extractSubViewMethods(rec, filePath, this.projectId, qualifiedName, lineNumber);

    const view: FantomTypeDef = {
      id: generateTypeId(filePath, qualifiedName, lineNumber),
      projectId: this.projectId,
      name: viewName,
      qualifiedName,
      kind: 'class' as TypeDefKind,
      filePath,
      lineNumber,
      documentation: `[View] ${dis}${appName ? ` (App: ${appName})` : ''}. ${description}`,
      isPublic: true,
      isAbstract: false,
      isFinal: false,
      isConst: false,
      mixins: [],
      facets: ['view', 'trio', 'axon'],
      methods,
      fields: []
    };

    return view;
  }

  /** Convert an app trio record to FantomTypeDef */
  private recordToApp(rec: TrioRecord, filePath: string, lineNumber: number): FantomTypeDef | null {
    const appVal = rec['app'];
    const appName = typeof appVal === 'string' ? appVal.replace(/^"|"$/g, '') : 'unknown';
    const dis = typeof rec['dis'] === 'string'
      ? (rec['dis'] as string).replace(/^"|"$/g, '')
      : appName;

    const pod = this.podName || 'unknown';
    const qualifiedName = `${pod}::app_${appName}`;
    const icon = typeof rec['icon'] === 'string' ? (rec['icon'] as string).replace(/^"|"$/g, '') : undefined;

    const app: FantomTypeDef = {
      id: generateTypeId(filePath, qualifiedName, lineNumber),
      projectId: this.projectId,
      name: appName,
      qualifiedName,
      kind: 'class' as TypeDefKind,
      filePath,
      lineNumber,
      documentation: `[App] ${dis}${icon ? ` (icon: ${icon})` : ''}. SkySpark application entry point.`,
      isPublic: true,
      isAbstract: false,
      isFinal: false,
      isConst: false,
      mixins: [],
      facets: ['app', 'trio', 'axon'],
      methods: [],
      fields: []
    };

    return app;
  }

  // ============================================
  // Helpers
  // ============================================

  /** Extract description from leading comments in Axon source */
  private extractDescription(src: string): string {
    const lines = src.split('\n');
    const commentLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('//')) {
        commentLines.push(trimmed.substring(2).trim());
      } else if (trimmed.length === 0) {
        continue; // skip blank lines between comments
      } else {
        break; // hit code
      }
    }

    return commentLines.join(' ').trim() || '';
  }
}
