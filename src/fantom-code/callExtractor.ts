/**
 * Fantom Call Extractor - extracts function calls from method bodies
 *
 * This module identifies and extracts function/method calls from Fantom source code.
 * It handles various Fantom calling conventions:
 * - Direct calls: foo()
 * - Method calls: obj.foo() or this.foo()
 * - Static calls: Type.foo()
 * - Qualified calls: pod::Type.foo()
 * - Dynamic calls: obj->foo()
 * - Constructor calls: Type() or Type.make()
 * - Closure calls: |arg| { ... }
 * - It-block calls: it.foo or implicit it
 */

import type { FunctionCall } from './types.js';

// ============================================
// Regex Patterns for Call Detection
// ============================================

const CALL_PATTERNS = {
  // Method call on object: obj.method() or this.method() or super.method()
  // Captures: [1]=object, [2]=method
  methodCall: /\b(this|super|it|[a-z_]\w*)\s*\.\s*([a-z_]\w*)\s*\(/gi,

  // Static call: Type.method() - Type starts with uppercase
  // Captures: [1]=Type, [2]=method
  staticCall: /\b([A-Z]\w*)\s*\.\s*([a-z_]\w*)\s*\(/g,

  // Qualified call: pod::Type.method()
  // Captures: [1]=pod, [2]=Type, [3]=method
  qualifiedCall: /\b([a-z]\w*)::([A-Z]\w*)\s*\.\s*([a-z_]\w*)\s*\(/g,

  // Dynamic call: obj->method()
  // Captures: [1]=object, [2]=method
  dynamicCall: /\b([a-z_]\w*)\s*->\s*([a-z_]\w*)\s*\(/gi,

  // Direct function call: foo() - not preceded by . or ->
  // We use negative lookbehind to exclude method calls
  // Captures: [1]=function
  directCall: /(?<![.\->])\b([a-z_]\w*)\s*\(/gi,

  // Constructor call: Type() or Type { ... }
  // Captures: [1]=Type
  constructorCall: /\b([A-Z]\w*)\s*(?:\(|\{)/g,

  // Constructor with make: Type.make()
  // Captures: [1]=Type
  makeCall: /\b([A-Z]\w*)\s*\.\s*make\s*\(/g,

  // Slot call with # operator: Type#slot or obj.typeof#slot
  // Captures: [1]=Type/expr, [2]=slot
  slotRef: /\b(\w+(?:\.\w+)*)\s*#\s*(\w+)/g,
};

// Keywords and built-ins to exclude from call detection
const EXCLUDED_KEYWORDS = new Set([
  // Control flow
  'if', 'else', 'for', 'while', 'switch', 'case', 'try', 'catch', 'finally',
  'throw', 'return', 'break', 'continue', 'default',
  // Declarations
  'class', 'mixin', 'enum', 'facet', 'using', 'abstract', 'virtual', 'override',
  'static', 'const', 'final', 'private', 'protected', 'public', 'internal',
  'native', 'once', 'new', 'readonly',
  // Literals and built-ins
  'true', 'false', 'null', 'this', 'super', 'it', 'typeof', 'is', 'as', 'isnot',
]);

// Common Fantom types (for static call detection) - reserved for future use
// const COMMON_TYPES = new Set([
//   'Str', 'Int', 'Float', 'Bool', 'List', 'Map', 'Obj', 'Void', 'Type', 'Slot',
//   'Method', 'Field', 'Func', 'Range', 'Duration', 'DateTime', 'Date', 'Time',
//   'TimeZone', 'Uri', 'File', 'Buf', 'InStream', 'OutStream', 'Err', 'Env',
//   'Log', 'Pod', 'Num', 'Decimal', 'Regex', 'Uuid', 'Version', 'Depend', 'Locale',
//   'Unit', 'Actor', 'Future', 'ActorPool', 'AtomicInt', 'AtomicRef', 'AtomicBool',
// ]);

// ============================================
// Call Extractor Class
// ============================================

export class FantomCallExtractor {
  private seenCalls: Set<string> = new Set();

  /**
   * Extract all function calls from a method body
   *
   * @param methodBody The source code of the method body (inside braces)
   * @param startLine The starting line number of the method body
   * @returns Array of FunctionCall objects
   */
  extractCalls(methodBody: string, startLine: number): FunctionCall[] {
    if (!methodBody?.trim()) {
      return [];
    }

    this.seenCalls.clear();
    const calls: FunctionCall[] = [];
    const lines = methodBody.split('\n');

    // Process each line
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = startLine + i;

      // Skip comment lines
      if (this.isCommentLine(line)) {
        continue;
      }

      // Remove string literals to avoid false positives
      const cleanLine = this.removeStringLiterals(line);

      // Extract different types of calls
      this.extractQualifiedCalls(cleanLine, lineNumber, calls);
      this.extractStaticCalls(cleanLine, lineNumber, calls);
      this.extractMethodCalls(cleanLine, lineNumber, calls);
      this.extractDynamicCalls(cleanLine, lineNumber, calls);
      this.extractConstructorCalls(cleanLine, lineNumber, calls);
      this.extractDirectCalls(cleanLine, lineNumber, calls);
    }

    return calls;
  }

  /**
   * Check if a line is a comment
   */
  private isCommentLine(line: string): boolean {
    const trimmed = line.trim();
    return trimmed.startsWith('//') || trimmed.startsWith('**');
  }

  /**
   * Remove string literals to avoid false positives
   */
  private removeStringLiterals(line: string): string {
    // Remove double-quoted strings
    let result = line.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    // Remove single-quoted chars
    result = result.replace(/'(?:[^'\\]|\\.)*'/g, "''");
    // Remove triple-quoted strings (simplified)
    result = result.replace(/"""[\s\S]*?"""/g, '""');
    // Remove backtick strings (Fantom DSL)
    result = result.replace(/`[^`]*`/g, '``');
    return result;
  }

  /**
   * Create a unique key for deduplication
   */
  private callKey(name: string, line: number, target?: string): string {
    return `${target || ''}:${name}:${line}`;
  }

  /**
   * Add a call if not already seen
   */
  private addCall(call: FunctionCall, calls: FunctionCall[]): void {
    const key = this.callKey(call.calledName, call.lineNumber, call.target);
    if (!this.seenCalls.has(key)) {
      this.seenCalls.add(key);
      calls.push(call);
    }
  }

  /**
   * Extract qualified calls: pod::Type.method()
   */
  private extractQualifiedCalls(line: string, lineNumber: number, calls: FunctionCall[]): void {
    const regex = new RegExp(CALL_PATTERNS.qualifiedCall.source, 'g');
    let match;

    while ((match = regex.exec(line)) !== null) {
      const [, pod, typeName, methodName] = match;

      if (EXCLUDED_KEYWORDS.has(methodName)) continue;

      this.addCall({
        calledName: methodName,
        calledQualifiedName: `${pod}::${typeName}.${methodName}`,
        lineNumber,
        colNumber: match.index,
        isStatic: true,
        isDynamic: false,
        isConstructor: methodName === 'make',
        target: `${pod}::${typeName}`,
        resolved: false,
      }, calls);
    }
  }

  /**
   * Extract static calls: Type.method()
   */
  private extractStaticCalls(line: string, lineNumber: number, calls: FunctionCall[]): void {
    const regex = new RegExp(CALL_PATTERNS.staticCall.source, 'g');
    let match;

    while ((match = regex.exec(line)) !== null) {
      const [, typeName, methodName] = match;

      if (EXCLUDED_KEYWORDS.has(methodName)) continue;
      if (EXCLUDED_KEYWORDS.has(typeName.toLowerCase())) continue;

      // Skip if this was already captured as a qualified call
      if (line.substring(Math.max(0, match.index - 10), match.index).includes('::')) {
        continue;
      }

      this.addCall({
        calledName: methodName,
        calledQualifiedName: undefined, // Will be resolved later
        lineNumber,
        colNumber: match.index,
        isStatic: true,
        isDynamic: false,
        isConstructor: methodName === 'make',
        target: typeName,
        resolved: false,
      }, calls);
    }
  }

  /**
   * Extract method calls: obj.method() or this.method()
   */
  private extractMethodCalls(line: string, lineNumber: number, calls: FunctionCall[]): void {
    const regex = new RegExp(CALL_PATTERNS.methodCall.source, 'gi');
    let match;

    while ((match = regex.exec(line)) !== null) {
      const [, target, methodName] = match;

      if (EXCLUDED_KEYWORDS.has(methodName)) continue;

      // Skip if target is a type (uppercase first letter) - handled by staticCalls
      if (target[0] === target[0].toUpperCase() && target !== 'this' && target !== 'super' && target !== 'it') {
        continue;
      }

      this.addCall({
        calledName: methodName,
        lineNumber,
        colNumber: match.index,
        isStatic: false,
        isDynamic: false,
        isConstructor: false,
        target: target,
        resolved: false,
      }, calls);
    }
  }

  /**
   * Extract dynamic calls: obj->method()
   */
  private extractDynamicCalls(line: string, lineNumber: number, calls: FunctionCall[]): void {
    const regex = new RegExp(CALL_PATTERNS.dynamicCall.source, 'gi');
    let match;

    while ((match = regex.exec(line)) !== null) {
      const [, target, methodName] = match;

      if (EXCLUDED_KEYWORDS.has(methodName)) continue;

      this.addCall({
        calledName: methodName,
        lineNumber,
        colNumber: match.index,
        isStatic: false,
        isDynamic: true,
        isConstructor: false,
        target: target,
        resolved: false,
      }, calls);
    }
  }

  /**
   * Extract constructor calls: Type() or Type.make()
   */
  private extractConstructorCalls(line: string, lineNumber: number, calls: FunctionCall[]): void {
    // Type.make() calls
    const makeRegex = new RegExp(CALL_PATTERNS.makeCall.source, 'g');
    let match;

    while ((match = makeRegex.exec(line)) !== null) {
      const [, typeName] = match;

      if (EXCLUDED_KEYWORDS.has(typeName.toLowerCase())) continue;

      // Skip if already captured
      const key = this.callKey('make', lineNumber, typeName);
      if (this.seenCalls.has(key)) continue;

      this.addCall({
        calledName: 'make',
        lineNumber,
        colNumber: match.index,
        isStatic: true,
        isDynamic: false,
        isConstructor: true,
        target: typeName,
        resolved: false,
      }, calls);
    }

    // Direct constructor: Type()
    const ctorRegex = new RegExp(CALL_PATTERNS.constructorCall.source, 'g');

    while ((match = ctorRegex.exec(line)) !== null) {
      const [fullMatch, typeName] = match;

      if (EXCLUDED_KEYWORDS.has(typeName.toLowerCase())) continue;

      // Skip if this looks like Type.method() (handled elsewhere)
      const afterMatch = line.substring(match.index + fullMatch.length - 1);
      if (afterMatch.startsWith('.')) continue;

      // Skip common type declarations
      if (['List', 'Map'].includes(typeName) && afterMatch.trim().startsWith('{')) {
        // This is likely a literal, not a constructor
        continue;
      }

      this.addCall({
        calledName: 'make', // Constructor is always 'make' in Fantom
        lineNumber,
        colNumber: match.index,
        isStatic: true,
        isDynamic: false,
        isConstructor: true,
        target: typeName,
        resolved: false,
      }, calls);
    }
  }

  /**
   * Extract direct function calls: foo()
   */
  private extractDirectCalls(line: string, lineNumber: number, calls: FunctionCall[]): void {
    // We need to be careful here as many things match this pattern
    const regex = /\b([a-z_]\w*)\s*\(/gi;
    let match;

    while ((match = regex.exec(line)) !== null) {
      const [, funcName] = match;

      // Skip keywords and already captured calls
      if (EXCLUDED_KEYWORDS.has(funcName)) continue;

      // Check if preceded by . or -> (method call, handled elsewhere)
      const before = line.substring(Math.max(0, match.index - 2), match.index);
      if (before.endsWith('.') || before.endsWith('->') || before.endsWith('::')) {
        continue;
      }

      // Skip if this is a closure parameter list |x|
      if (line.substring(Math.max(0, match.index - 1), match.index) === '|') {
        continue;
      }

      const key = this.callKey(funcName, lineNumber, undefined);
      if (this.seenCalls.has(key)) continue;

      this.addCall({
        calledName: funcName,
        lineNumber,
        colNumber: match.index,
        isStatic: false,
        isDynamic: false,
        isConstructor: false,
        target: undefined, // Could be 'this' implicitly
        resolved: false,
      }, calls);
    }
  }
}

/**
 * Convenience function to extract calls from a method body
 */
export function extractCalls(methodBody: string, startLine: number): FunctionCall[] {
  const extractor = new FantomCallExtractor();
  return extractor.extractCalls(methodBody, startLine);
}
