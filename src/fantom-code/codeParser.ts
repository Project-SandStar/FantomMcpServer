/**
 * Fantom Code Parser - extracts types, methods, and fields from Fantom source files
 *
 * This parser uses regex patterns for reliable extraction of Fantom code structures.
 * It's designed to work alongside or as a fallback to AST-based parsing.
 */

import * as fs from 'fs';
import type {
  FantomFunction,
  FantomTypeDef,
  ParsedFile,
  PodMeta,
  Parameter,
  TypeDefKind
} from './types.js';
import {
  generateFunctionId,
  generateTypeId,
  buildQualifiedName,
  categorizeFunction,
  generateTags,
  formatSignature
} from './types.js';
import { FantomCallExtractor } from './callExtractor.js';

// ============================================
// Regex Patterns for Fantom Syntax
// ============================================

// Facet prefix used in front of types/methods/fields/constructors.
// Two valid Fantom syntaxes (both can repeat):
//   @Js                      — bare name facet (Fantom 1.0+ — used heavily by
//                              fantom-1.0.78 stdlib pods like xml, fwt, dom)
//   @[FacetName{x=1}]        — older bracketed-payload form
// The previous patterns only recognized the bracket form, so bare-facet types
// like `@Js class XParser` matched zero of the type/method/field regexes —
// silently producing 1+1 counts on the entire xml pod (round-12 regression).
const FACET_PREFIX = String.raw`(?:(?:@\[.*?\]|@\w+)\s+)*`;

const PATTERNS = {
  // Type definitions: class, mixin, enum, facet
  typeDef: new RegExp(
    String.raw`^(\s*)(` + FACET_PREFIX + String.raw`)((?:(?:abstract|final|const|public|internal)\s+)*)(class|mixin|enum|facet)\s+(\w+)(?:\s*:\s*([\w\s,.:]+))?(?:\s*\{)?`,
    'gm',
  ),

  // Method definitions with all modifiers. Includes JS/TS keywords
  // (async, export, default) defensively — this regex is meant for Fantom
  // but it has been observed leaking onto .ts files via legacy code paths
  // and capturing `async` as a return type. Recognizing the keyword as a
  // modifier here prevents that regression.
  methodDef: new RegExp(
    String.raw`^(\s*)(` + FACET_PREFIX + String.raw`)((?:(?:abstract|virtual|override|static|native|once|new|public|private|protected|internal|async|export|default)\s+)*)(\w+(?:\[\])?(?:\?)?(?:<[\w,\s<>\[\]?]+>)?)\s+(\w+)\s*\(([\s\S]*?)\)\s*(?:\{|$)`,
    'gm',
  ),

  // Field definitions
  fieldDef: new RegExp(
    String.raw`^(\s*)(` + FACET_PREFIX + String.raw`)((?:(?:const|static|readonly|public|private|protected|internal)\s+)*)(\w+(?:\[\])?(?:\?)?(?:<[\w,\s<>\[\]?]+>)?)\s+(\w+)(?:\s*:=\s*(.+?))?(?:\s*\{.*\})?$`,
    'gm',
  ),

  // Constructor (make method)
  constructorDef: new RegExp(
    String.raw`^(\s*)(` + FACET_PREFIX + String.raw`)((?:(?:new|public|private|protected|internal)\s+)*)new\s+make\s*\(([\s\S]*?)\)`,
    'gm',
  ),

  // Using statements
  usingStmt: /^\s*using\s+([\w.]+)(?:\s+as\s+(\w+))?/gm,

  // Documentation comments (Fandoc)
  docComment: /\/\*\*([\s\S]*?)\*\//g,
  lineDocComment: /^(\s*)\*\*(.*)$/gm,

  // Facets
  facet: /@\[(\w+)(?:\s*\{([^}]*)\})?\]/g,

  // Parameters parsing
  parameter: /(\w+(?:\[\])?(?:\?)?(?:<[\w,\s<>\[\]?]+>)?)\s+(\w+)(?:\s*:=\s*([^,)]+))?/g,
};

// ============================================
// Parser Class
// ============================================

export class FantomCodeParser {
  private projectId: number;
  private podMeta?: PodMeta;
  private callExtractor: FantomCallExtractor;

  constructor(projectId: number, podMeta?: PodMeta) {
    this.projectId = projectId;
    this.podMeta = podMeta;
    this.callExtractor = new FantomCallExtractor();
  }

  /**
   * Parse a single .fan file
   */
  parseFile(filePath: string, content?: string): ParsedFile {
    const fileContent = content ?? fs.readFileSync(filePath, 'utf-8');
    const lines = fileContent.split('\n');

    const result: ParsedFile = {
      filePath,
      types: [],
      functions: [],
      imports: [],
      usings: [],
      errors: []
    };

    try {
      // Extract usings
      result.usings = this.extractUsings(fileContent);

      // Extract types with their members
      const types = this.extractTypes(filePath, fileContent, lines);
      result.types = types;

      // Collect all functions from types
      for (const type of types) {
        result.functions.push(...type.methods);
        result.functions.push(...type.fields);
      }
    } catch (err) {
      result.errors.push({
        file: filePath,
        message: err instanceof Error ? err.message : String(err),
        severity: 'error'
      });
    }

    return result;
  }

  /**
   * Extract using statements
   */
  private extractUsings(content: string): string[] {
    const usings: string[] = [];
    const regex = new RegExp(PATTERNS.usingStmt.source, 'gm');
    let match;

    while ((match = regex.exec(content)) !== null) {
      usings.push(match[1]);
    }

    return usings;
  }

  /**
   * Extract type definitions (classes, mixins, enums)
   */
  private extractTypes(filePath: string, content: string, lines: string[]): FantomTypeDef[] {
    const types: FantomTypeDef[] = [];
    const regex = new RegExp(PATTERNS.typeDef.source, 'gm');
    let match;

    while ((match = regex.exec(content)) !== null) {
      const [fullMatch, _indent, facetsStr, modifiers, typeKeyword, typeName, inheritance] = match;
      const lineNumber = this.getLineNumber(content, match.index);

      // Determine type kind
      let kind: TypeDefKind = 'class';
      if (typeKeyword === 'mixin') kind = 'mixin';
      else if (typeKeyword === 'enum') kind = 'enum';
      else if (typeKeyword === 'facet') kind = 'facet';

      // Parse inheritance
      let extendsType: string | undefined;
      const mixins: string[] = [];
      if (inheritance) {
        const parts = inheritance.split(',').map(s => s.trim());
        // First one might be extends (for class), rest are mixins
        if (parts.length > 0 && kind === 'class') {
          extendsType = parts[0];
          mixins.push(...parts.slice(1));
        } else {
          mixins.push(...parts);
        }
      }

      // Parse facets
      const facets = this.extractFacets(facetsStr || '');

      // Get documentation
      const doc = this.extractDocumentation(content, match.index, lines);

      // Parse modifiers
      const isAbstract = modifiers?.includes('abstract') ?? false;
      const isFinal = modifiers?.includes('final') ?? false;
      const isConst = modifiers?.includes('const') ?? false;
      const isPublic = !modifiers?.includes('internal');

      const qualifiedName = buildQualifiedName(this.podMeta?.podName || '', typeName);
      const typeId = generateTypeId(filePath, qualifiedName);

      // Find the type body and extract members
      const typeBody = this.extractTypeBody(content, match.index + fullMatch.length - 1);
      const methods = this.extractMethods(filePath, typeBody, typeName, lineNumber);
      const fields = this.extractFields(filePath, typeBody, typeName, lineNumber);
      // Closing brace line: header newlines + body newlines (body excludes the
      // braces themselves, the closing one sits right after the body).
      const lineEnd = lineNumber + this.countLines(fullMatch) + this.countLines(typeBody);

      types.push({
        id: typeId,
        projectId: this.projectId,
        name: typeName,
        qualifiedName,
        kind,
        filePath,
        lineNumber,
        lineEnd,
        extends: extendsType,
        mixins,
        facets,
        documentation: doc,
        isPublic,
        isAbstract,
        isFinal,
        isConst,
        methods,
        fields
      });
    }

    return types;
  }

  /**
   * Extract type body by matching braces
   */
  private extractTypeBody(content: string, startIndex: number): string {
    let depth = 1;
    let i = startIndex + 1;

    while (i < content.length && depth > 0) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') depth--;
      i++;
    }

    return content.substring(startIndex + 1, i - 1);
  }

  /**
   * Extract methods from type body
   */
  private extractMethods(
    filePath: string,
    typeBody: string,
    className: string,
    baseLineNumber: number
  ): FantomFunction[] {
    const methods: FantomFunction[] = [];
    const regex = new RegExp(PATTERNS.methodDef.source, 'gm');
    let match;

    while ((match = regex.exec(typeBody)) !== null) {
      const [fullMatch, _indent, facetsStr, modifiers, rawReturnType, methodName, paramsStr] = match;

      // Sanitize: strip any JS/TS keyword that leaked into the returnType
      // capture group (e.g. `async ping()` produced returnType="async" before
      // the modifier list was widened). When the captured token is a known
      // keyword, fall back to undefined.
      const KEYWORD_SET = new Set([
        'async', 'await', 'export', 'default', 'public', 'private',
        'protected', 'static', 'abstract', 'override', 'virtual', 'final',
        'const', 'readonly', 'new', 'native', 'once', 'internal',
      ]);
      const returnType = KEYWORD_SET.has(rawReturnType) ? '' : rawReturnType;

      // Skip if this looks like a field
      if (!paramsStr && paramsStr !== '') continue;

      const lineNumber = baseLineNumber + this.countLines(typeBody.substring(0, match.index));
      const parameters = this.parseParameters(paramsStr);
      const facets = this.extractFacets(facetsStr || '');

      // Parse modifiers
      const isPublic = !modifiers?.includes('private') && !modifiers?.includes('protected');
      const isStatic = modifiers?.includes('static') ?? false;
      const isAbstract = modifiers?.includes('abstract') ?? false;
      const isOverride = modifiers?.includes('override') ?? false;
      const isVirtual = modifiers?.includes('virtual') ?? false;

      const qualifiedName = buildQualifiedName(
        this.podMeta?.podName || '',
        className,
        methodName
      );
      const funcId = generateFunctionId(filePath, qualifiedName);

      // Extract method body for source code
      const methodBody = this.extractMethodBody(typeBody, match.index + fullMatch.length - 1);
      const sourceCode = fullMatch + methodBody;

      // Get documentation
      const doc = this.extractDocumentationFromBody(typeBody, match.index);

      // Extract function calls from method body
      const calls = methodBody ? this.callExtractor.extractCalls(methodBody, lineNumber) : [];

      const func: FantomFunction = {
        id: funcId,
        projectId: this.projectId,
        name: methodName,
        qualifiedName,
        type: methodName === 'make' ? 'constructor' : 'method',
        className,
        filePath,
        lineNumber,
        // fullMatch spans from the indent to the opening brace (or to end of
        // an abstract declaration); methodBody is brace-inclusive.
        lineEnd: lineNumber + this.countLines(sourceCode),
        signature: formatSignature(methodName, returnType, parameters),
        returnType,
        parameters,
        description: doc?.split('\n')[0],
        documentation: doc,
        sourceCode,
        category: categorizeFunction({ name: methodName, className, documentation: doc }, this.podMeta),
        tags: [],
        isPublic,
        isStatic,
        isAbstract,
        isOverride,
        isVirtual,
        facets,
        calls: calls.length > 0 ? calls : undefined,
      };

      func.tags = generateTags(func);
      methods.push(func);
    }

    return methods;
  }

  /**
   * Extract method body by matching braces
   */
  private extractMethodBody(content: string, startIndex: number): string {
    // Find the opening brace
    let i = startIndex;
    while (i < content.length && content[i] !== '{') {
      if (content[i] === '\n' && !content.substring(startIndex, i).includes('{')) {
        // No body (abstract method)
        return '';
      }
      i++;
    }

    if (i >= content.length) return '';

    let depth = 1;
    const start = i;
    i++;

    while (i < content.length && depth > 0) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') depth--;
      i++;
    }

    return content.substring(start, i);
  }

  /**
   * Extract fields from type body
   */
  private extractFields(
    filePath: string,
    typeBody: string,
    className: string,
    baseLineNumber: number
  ): FantomFunction[] {
    const fields: FantomFunction[] = [];

    // Simple field pattern: type name [:= value] [{ get; set }]
    const fieldRegex = /^(\s*)((?:@\[.*?\]\s*)*)?((?:(?:const|static|readonly|public|private|protected|internal)\s+)*)(\w+(?:\[\])?(?:\?)?(?:<[\w,\s<>\[\]?]+>)?)\s+(\w+)\s*(?::=|$|\{)/gm;
    let match;

    while ((match = fieldRegex.exec(typeBody)) !== null) {
      const [fullMatch, _indent, facetsStr, modifiers, fieldType, fieldName] = match;

      // Skip if it looks like a method (has parentheses after name)
      const afterMatch = typeBody.substring(match.index + fullMatch.length, match.index + fullMatch.length + 10);
      if (afterMatch.trim().startsWith('(')) continue;

      // Skip common false positives
      if (['if', 'for', 'while', 'switch', 'try', 'catch', 'return', 'throw'].includes(fieldName)) {
        continue;
      }

      const lineNumber = baseLineNumber + this.countLines(typeBody.substring(0, match.index));
      const facets = this.extractFacets(facetsStr || '');

      // Parse modifiers
      const isPublic = !modifiers?.includes('private') && !modifiers?.includes('protected');
      const isStatic = modifiers?.includes('static') ?? false;
      const isConst = modifiers?.includes('const') ?? false;

      const qualifiedName = buildQualifiedName(
        this.podMeta?.podName || '',
        className,
        fieldName
      );
      const funcId = generateFunctionId(filePath, qualifiedName);

      const doc = this.extractDocumentationFromBody(typeBody, match.index);

      const field: FantomFunction = {
        id: funcId,
        projectId: this.projectId,
        name: fieldName,
        qualifiedName,
        type: 'field',
        className,
        filePath,
        lineNumber,
        lineEnd: lineNumber,
        signature: `${fieldType} ${fieldName}`,
        returnType: fieldType,
        parameters: [],
        description: doc?.split('\n')[0],
        documentation: doc,
        sourceCode: fullMatch.trim(),
        category: categorizeFunction({ name: fieldName, className, documentation: doc }, this.podMeta),
        tags: [],
        isPublic,
        isStatic,
        isAbstract: false,
        isOverride: false,
        isVirtual: false,
        facets
      };

      if (isConst) field.tags.push('const');
      field.tags = generateTags(field);
      fields.push(field);
    }

    return fields;
  }

  /**
   * Parse parameter string into Parameter array
   */
  private parseParameters(paramsStr: string): Parameter[] {
    if (!paramsStr?.trim()) return [];

    const params: Parameter[] = [];
    const regex = new RegExp(PATTERNS.parameter.source, 'g');
    let match;

    while ((match = regex.exec(paramsStr)) !== null) {
      params.push({
        name: match[2],
        type: match[1],
        defaultValue: match[3]?.trim()
      });
    }

    return params;
  }

  /**
   * Extract facets from facet string
   */
  private extractFacets(facetsStr: string): string[] {
    const facets: string[] = [];
    const regex = new RegExp(PATTERNS.facet.source, 'g');
    let match;

    while ((match = regex.exec(facetsStr)) !== null) {
      facets.push(match[1]);
    }

    return facets;
  }

  /**
   * Extract documentation comment before an index
   */
  private extractDocumentation(content: string, index: number, _lines: string[]): string | undefined {
    // Look for ** comments before this position
    const beforeContent = content.substring(Math.max(0, index - 500), index);
    const docLines: string[] = [];

    // Find consecutive ** lines
    const lineMatches = beforeContent.matchAll(/^\s*\*\*\s*(.*)$/gm);
    for (const match of lineMatches) {
      docLines.push(match[1].trim());
    }

    if (docLines.length > 0) {
      return docLines.join('\n');
    }

    return undefined;
  }

  /**
   * Extract documentation from type body
   */
  private extractDocumentationFromBody(body: string, index: number): string | undefined {
    const beforeContent = body.substring(Math.max(0, index - 300), index);
    const lines = beforeContent.split('\n').reverse();
    const docLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('**')) {
        docLines.unshift(trimmed.substring(2).trim());
      } else if (trimmed === '' && docLines.length > 0) {
        continue;
      } else if (docLines.length > 0) {
        break;
      }
    }

    return docLines.length > 0 ? docLines.join('\n') : undefined;
  }

  /**
   * Get line number at a given character index
   */
  private getLineNumber(content: string, index: number): number {
    return content.substring(0, index).split('\n').length;
  }

  /**
   * Count newlines in a string
   */
  private countLines(str: string): number {
    return (str.match(/\n/g) || []).length;
  }
}

/**
 * Parse a single Fantom file
 */
export function parseFantomFile(
  filePath: string,
  projectId: number,
  podMeta?: PodMeta
): ParsedFile {
  const parser = new FantomCodeParser(projectId, podMeta);
  return parser.parseFile(filePath);
}

/**
 * Parse multiple Fantom files
 */
export function parseFantomFiles(
  filePaths: string[],
  projectId: number,
  podMeta?: PodMeta
): ParsedFile[] {
  const parser = new FantomCodeParser(projectId, podMeta);
  return filePaths.map(fp => parser.parseFile(fp));
}
