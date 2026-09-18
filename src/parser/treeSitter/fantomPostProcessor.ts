/**
 * Fantom Post-Processor
 *
 * Extracts additional information from Fantom code that the tree-sitter
 * grammar doesn't fully support. Uses regex-based extraction for:
 * - Map type syntax (Str:Str:Type[:])
 * - It-block closures (|This| f)
 * - Complex type annotations
 */

import type { ParsedFile, ExtractedFunction, ParseError } from './types.js';

// ============================================
// Regex Patterns for Fantom Syntax
// ============================================

// Map type: Type:Type or Type:Type:Type etc, optionally with [:]
const MAP_TYPE_PATTERN = /(\w+(?::\w+)+)(?:\[\s*:?\s*\])?/g;

// It-block closure: |Type1, Type2| or |Type1 name, Type2 name|
const IT_BLOCK_PATTERN = /\|([^|]+)\|/g;

// Field with complex type: const/private/etc Type:Type:Type name := value
const FIELD_WITH_MAP_TYPE = /(?:private|public|protected|internal|const|static|readonly)\s+(?:const\s+)?(\w+(?::\w+)+(?:\[\s*:?\s*\])?)\s+(\w+)\s*(?::=|=)/g;

// ============================================
// Post-Processor Class
// ============================================

export interface PostProcessResult {
  /** Enhanced fields with corrected types */
  enhancedFields: Map<string, { type: string; isMapType: boolean }>;
  /** Detected it-block closures */
  closures: Array<{
    location: { line: number; column: number };
    params: Array<{ type: string; name?: string }>;
    returnType?: string;
  }>;
  /** Errors that should be suppressed (known grammar limitations) */
  suppressedErrors: Set<string>;
  /** Additional extracted info */
  additionalInfo: {
    mapTypes: string[];
    itBlocks: string[];
  };
}

export class FantomPostProcessor {
  /**
   * Process parsed Fantom file to extract additional information
   */
  process(parsedFile: ParsedFile, source: string): ParsedFile {
    if (parsedFile.language !== 'fantom') {
      return parsedFile;
    }

    const lines = source.split('\n');
    const result = this.extractAdditionalInfo(source, lines);

    // Clean up spurious fields from map type parsing failures
    this.cleanupSpuriousFields(parsedFile, lines);

    // Enhance field types
    this.enhanceFieldTypes(parsedFile, result, lines);

    // Enhance method parameters (closures)
    this.enhanceMethodParameters(parsedFile, result, lines);

    // Filter suppressed errors
    parsedFile.errors = this.filterErrors(parsedFile.errors, result);

    return parsedFile;
  }

  /**
   * Remove spurious fields created by map type parsing failures
   * These are typically Fantom built-in types or keywords that got misidentified as field names
   */
  private cleanupSpuriousFields(parsedFile: ParsedFile, lines: string[]): void {
    const builtInTypes = new Set([
      'Str', 'Int', 'Bool', 'Float', 'Void', 'Obj', 'This', 'It',
      'List', 'Map', 'Type', 'Slot', 'Field', 'Method', 'Func',
      'Duration', 'DateTime', 'Date', 'Time', 'TimeZone', 'Uri',
      'Decimal', 'Num', 'Range', 'Regex', 'Err', 'Buf', 'InStream', 'OutStream'
    ]);

    for (const cls of parsedFile.classes) {
      // Filter out fields that look like misidentified types or keywords
      cls.fields = cls.fields.filter(field => {
        // Field name shouldn't be a built-in type
        if (builtInTypes.has(field.name)) {
          return false;
        }

        // Field type shouldn't be a common variable name (swapped type/name)
        if (field.type && /^[a-z]/.test(field.type) && field.type.length < 10) {
          // Likely swapped - this is a misparse
          return false;
        }

        // Check if field is on a line that has map type syntax
        const fieldLine = lines[field.location.startLine - 1] || '';
        if (fieldLine.match(/\w+:\w+/) && !fieldLine.match(/^\s*(private|public|protected|const|static)\s+const\s+\w+\s+\w+\s*:=/)) {
          // Line has colon type syntax but isn't a proper field declaration
          // Keep only if it looks like a valid field name
          if (!field.name.match(/^[a-z][a-zA-Z0-9]*$/)) {
            return false;
          }
        }

        return true;
      });
    }
  }

  /**
   * Extract additional information using regex
   */
  private extractAdditionalInfo(source: string, _lines: string[]): PostProcessResult {
    const result: PostProcessResult = {
      enhancedFields: new Map(),
      closures: [],
      suppressedErrors: new Set(),
      additionalInfo: {
        mapTypes: [],
        itBlocks: []
      }
    };

    // Find all map types
    let match: RegExpExecArray | null;
    while ((match = MAP_TYPE_PATTERN.exec(source)) !== null) {
      result.additionalInfo.mapTypes.push(match[1]);
    }

    // Find all it-blocks
    IT_BLOCK_PATTERN.lastIndex = 0;
    while ((match = IT_BLOCK_PATTERN.exec(source)) !== null) {
      const blockContent = match[1];
      const params = this.parseItBlockParams(blockContent);

      // Calculate line/column
      const beforeMatch = source.substring(0, match.index);
      const line = (beforeMatch.match(/\n/g) || []).length + 1;
      const lastNewline = beforeMatch.lastIndexOf('\n');
      const column = match.index - lastNewline - 1;

      result.closures.push({
        location: { line, column },
        params: params.params,
        returnType: params.returnType
      });

      result.additionalInfo.itBlocks.push(match[0]);

      // Mark these locations for error suppression
      result.suppressedErrors.add(`${line}:${column}`);
    }

    // Find fields with map types
    FIELD_WITH_MAP_TYPE.lastIndex = 0;
    while ((match = FIELD_WITH_MAP_TYPE.exec(source)) !== null) {
      const mapType = match[1];
      const fieldName = match[2];
      result.enhancedFields.set(fieldName, {
        type: this.formatMapType(mapType),
        isMapType: true
      });
    }

    return result;
  }

  /**
   * Parse it-block parameters: |Type1, Type2->RetType| or |Type1 name|
   */
  private parseItBlockParams(content: string): {
    params: Array<{ type: string; name?: string }>;
    returnType?: string;
  } {
    const params: Array<{ type: string; name?: string }> = [];
    let returnType: string | undefined;

    // Check for return type arrow
    const arrowIndex = content.indexOf('->');
    let paramsPart = content;
    if (arrowIndex !== -1) {
      paramsPart = content.substring(0, arrowIndex).trim();
      returnType = content.substring(arrowIndex + 2).trim();
    }

    // Parse parameters
    const paramList = paramsPart.split(',').map(p => p.trim()).filter(p => p);
    for (const param of paramList) {
      const parts = param.split(/\s+/);
      if (parts.length >= 2) {
        params.push({ type: parts[0], name: parts[1] });
      } else if (parts.length === 1) {
        params.push({ type: parts[0] });
      }
    }

    return { params, returnType };
  }

  /**
   * Format map type for display: Str:Str:Type -> [Str:Str:Type]
   */
  private formatMapType(mapType: string): string {
    // Already has brackets
    if (mapType.includes('[')) {
      return mapType;
    }
    return `[${mapType}]`;
  }

  /**
   * Enhance field types with map type information
   */
  private enhanceFieldTypes(
    parsedFile: ParsedFile,
    result: PostProcessResult,
    _lines: string[]
  ): void {
    for (const cls of parsedFile.classes) {
      for (const field of cls.fields) {
        const enhanced = result.enhancedFields.get(field.name);
        if (enhanced) {
          field.type = enhanced.type;
        }
      }
    }
  }

  /**
   * Enhance method parameters with closure information
   */
  private enhanceMethodParameters(
    parsedFile: ParsedFile,
    _result: PostProcessResult,
    lines: string[]
  ): void {
    for (const cls of parsedFile.classes) {
      for (const method of cls.methods) {
        // Check if any parameter might be a closure
        const methodLine = lines[method.location.startLine - 1] || '';

        // Look for it-block pattern in method signature
        const itBlockMatch = methodLine.match(/\|([^|]+)\|\s*(\w+)/);
        if (itBlockMatch) {
          const closureInfo = this.parseItBlockParams(itBlockMatch[1]);

          // Find or update the parameter
          const paramName = itBlockMatch[2];
          const existingParam = method.parameters.find(p => p.name === paramName);

          if (existingParam) {
            // Build closure type string
            const paramTypes = closureInfo.params.map(p => p.type).join(', ');
            const retType = closureInfo.returnType || 'Void';
            existingParam.type = `|${paramTypes}->${retType}|`;
          } else {
            // Add the parameter if not found
            const paramTypes = closureInfo.params.map(p => p.type).join(', ');
            const retType = closureInfo.returnType || 'Void';
            method.parameters.push({
              name: paramName,
              type: `|${paramTypes}->${retType}|`,
              isOptional: false,
              isRest: false
            });
          }

          // Update signature
          method.signature = this.buildSignature(method);
        }
      }
    }
  }

  /**
   * Build method signature from parameters
   */
  private buildSignature(method: ExtractedFunction): string {
    const params = method.parameters.map(p => {
      let str = p.name;
      if (p.type) str += `: ${p.type}`;
      return str;
    }).join(', ');

    let sig = `${method.name}(${params})`;
    if (method.returnType) {
      sig += `: ${method.returnType}`;
    }
    return sig;
  }

  /**
   * Filter out errors for known grammar limitations
   */
  private filterErrors(errors: ParseError[], result: PostProcessResult): ParseError[] {
    return errors.filter(error => {
      // Check if this error is at a suppressed location
      const locKey = `${error.location.startLine}:${error.location.startColumn}`;
      if (result.suppressedErrors.has(locKey)) {
        return false;
      }

      const msg = error.message;

      // Suppress map type errors (colon in type declarations)
      // Patterns: ":", ":Str", ":Int", ":]", ":Obj?", etc.
      if (msg.match(/unexpected token ":[^"]*"/) ||
          msg.match(/unexpected token "\[:\]"/) ||
          msg.match(/unexpected token ",\]"/)) {  // Trailing comma in list
        return false;
      }

      // Suppress common Fantom syntax patterns
      if (msg.includes('[:]') ||
          msg.includes('|This|') ||
          msg.includes('|It|') ||
          msg.includes('|Obj|') ||
          msg.includes('|Func|')) {
        return false;
      }

      // Suppress errors for common Fantom types in it-blocks
      if (msg.match(/unexpected token "(?:This|It|Obj|Void|Str|Int|Bool|Float|List|Map|Num|Duration)"/)) {
        return false;
      }

      // Suppress errors inside closures - check if any closure is on the same line
      for (const closure of result.closures) {
        if (closure.location.line === error.location.startLine) {
          return false;
        }
      }

      // Suppress copyright/license comment errors at line 1
      if (error.location.startLine === 1 && msg.includes('//')) {
        return false;
      }

      // Suppress "expected ]" errors - usually from map/list literals
      if (msg.includes('expected ]') || msg.includes('expected )')) {
        return false;
      }

      return true;
    });
  }
}

// ============================================
// Singleton Instance
// ============================================

let processorInstance: FantomPostProcessor | null = null;

export function getFantomPostProcessor(): FantomPostProcessor {
  if (!processorInstance) {
    processorInstance = new FantomPostProcessor();
  }
  return processorInstance;
}
