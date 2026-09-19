/**
 * Tree-sitter Parser Types
 *
 * Type definitions for AST nodes, parsing results, and language configuration.
 */

import type { Language } from 'web-tree-sitter';

// ============================================
// Language Configuration
// ============================================

export type SupportedLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'java'
  | 'go'
  | 'rust'
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'ruby'
  | 'php'
  | 'kotlin'
  | 'swift'
  | 'scala'
  | 'fantom'
  | 'xeto'
  | 'axon'
  | 'trio'
  | 'html'
  | 'css'
  | 'json'
  | 'vue'
  | 'dart'
  | 'polymer';

export interface LanguageConfig {
  /** Language identifier */
  id: SupportedLanguage;
  /** Display name */
  name: string;
  /** File extensions (without dot) */
  extensions: string[];
  /** Path to WASM grammar file */
  wasmPath?: string;
  /** Whether grammar is loaded */
  loaded: boolean;
  /** Tree-sitter Language instance */
  language?: Language;
  /** Node type mappings for this language */
  nodeMappings: NodeTypeMappings;
}

export interface NodeTypeMappings {
  /** Node types representing functions/methods */
  functionTypes: string[];
  /** Node types representing classes */
  classTypes: string[];
  /** Node types representing interfaces */
  interfaceTypes: string[];
  /** Node types representing variables/fields */
  variableTypes: string[];
  /** Node types representing imports */
  importTypes: string[];
  /** Node types representing exports */
  exportTypes: string[];
  /** Node types representing comments */
  commentTypes: string[];
  /** Node types representing function calls */
  callTypes: string[];
  /** Field name for getting function/class name */
  nameField: string;
  /** Field name for getting function parameters */
  parametersField: string;
  /** Field name for getting function body */
  bodyField: string;
}

// ============================================
// AST Node Types
// ============================================

export interface ASTLocation {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  startIndex: number;
  endIndex: number;
}

export interface ASTNode {
  /** Node type from tree-sitter */
  type: string;
  /** Node text content */
  text: string;
  /** Location in source */
  location: ASTLocation;
  /** Named children */
  children: ASTNode[];
  /** Parent node reference */
  parent?: ASTNode;
  /** Named fields */
  fields: Record<string, ASTNode | ASTNode[] | undefined>;
}

// ============================================
// Extracted Code Structures
// ============================================

export interface ExtractedFunction {
  /** Function/method name */
  name: string;
  /** Fully qualified name (class.method) */
  qualifiedName: string;
  /** Function signature */
  signature: string;
  /** Parameters */
  parameters: ExtractedParameter[];
  /** Return type if available */
  returnType?: string;
  /** Documentation comment */
  documentation?: string;
  /** Location in source */
  location: ASTLocation;
  /** Containing class/interface if any */
  containingType?: string;
  /** Visibility modifier */
  visibility?: 'public' | 'private' | 'protected' | 'internal';
  /** Whether function is async */
  isAsync: boolean;
  /** Whether function is static */
  isStatic: boolean;
  /** Whether function is abstract */
  isAbstract: boolean;
  /** Function body text */
  body?: string;
  /** Function calls within body */
  calls: ExtractedCall[];
}

export interface ExtractedParameter {
  /** Parameter name */
  name: string;
  /** Parameter type if available */
  type?: string;
  /** Default value if any */
  defaultValue?: string;
  /** Whether parameter is optional */
  isOptional: boolean;
  /** Whether parameter is rest/varargs */
  isRest: boolean;
}

export interface ExtractedCall {
  /** Called function/method name */
  name: string;
  /** Full call expression */
  expression: string;
  /** Target object if method call */
  target?: string;
  /** Location in source */
  location: ASTLocation;
  /** Whether call is async (await) */
  isAsync: boolean;
}

export interface ExtractedClass {
  /** Class name */
  name: string;
  /** Fully qualified name */
  qualifiedName: string;
  /** Documentation comment */
  documentation?: string;
  /** Location in source */
  location: ASTLocation;
  /** Extended class */
  extends?: string;
  /** Implemented interfaces */
  implements: string[];
  /** Class methods */
  methods: ExtractedFunction[];
  /** Class fields/properties */
  fields: ExtractedField[];
  /** Visibility modifier */
  visibility?: 'public' | 'private' | 'protected' | 'internal';
  /** Whether class is abstract */
  isAbstract: boolean;
}

export interface ExtractedField {
  /** Field name */
  name: string;
  /** Field type if available */
  type?: string;
  /** Documentation comment */
  documentation?: string;
  /** Location in source */
  location: ASTLocation;
  /** Visibility modifier */
  visibility?: 'public' | 'private' | 'protected' | 'internal';
  /** Whether field is static */
  isStatic: boolean;
  /** Whether field is readonly/final */
  isReadonly: boolean;
  /** Default value if any */
  defaultValue?: string;
}

export interface ExtractedInterface {
  /** Interface name */
  name: string;
  /** Fully qualified name */
  qualifiedName: string;
  /** Documentation comment */
  documentation?: string;
  /** Location in source */
  location: ASTLocation;
  /** Extended interfaces */
  extends: string[];
  /** Interface methods */
  methods: ExtractedFunction[];
  /** Interface properties */
  properties: ExtractedField[];
}

export interface ExtractedImport {
  /** Module/package path */
  source: string;
  /** Imported items */
  items: Array<{
    name: string;
    alias?: string;
    isDefault: boolean;
    isNamespace: boolean;
  }>;
  /** Location in source */
  location: ASTLocation;
  /** Whether import is type-only */
  isTypeOnly: boolean;
}

export interface ExtractedExport {
  /** Exported name */
  name: string;
  /** Alias if renamed */
  alias?: string;
  /** Location in source */
  location: ASTLocation;
  /** Whether export is default */
  isDefault: boolean;
  /** Whether export is type-only */
  isTypeOnly: boolean;
  /** Re-exported source if any */
  source?: string;
}

// ============================================
// Parsing Results
// ============================================

export interface ParsedFile {
  /** File path */
  filePath: string;
  /** Language used for parsing */
  language: SupportedLanguage;
  /** Whether parsing succeeded */
  success: boolean;
  /** Parse errors if any */
  errors: ParseError[];
  /** Extracted classes */
  classes: ExtractedClass[];
  /** Extracted interfaces */
  interfaces: ExtractedInterface[];
  /** Top-level functions */
  functions: ExtractedFunction[];
  /** Imports */
  imports: ExtractedImport[];
  /** Exports */
  exports: ExtractedExport[];
  /** Root AST node */
  ast?: ASTNode;
  /** Parse duration in ms */
  parseTime: number;
}

export interface ParseError {
  /** Error message */
  message: string;
  /** Error location */
  location: ASTLocation;
  /** Error type */
  type: 'syntax' | 'semantic' | 'warning' | 'info';
}

export interface ParseOptions {
  /** Include full AST in results */
  includeAST?: boolean;
  /** Extract function bodies */
  extractBodies?: boolean;
  /** Extract function calls */
  extractCalls?: boolean;
  /** Extract documentation comments */
  extractDocs?: boolean;
  /** Maximum file size to parse (bytes) */
  maxFileSize?: number;
  /** Timeout for parsing (ms) */
  timeout?: number;
}

// ============================================
// Parser Events
// ============================================

export interface ParserEvents {
  /** Called when grammar is loaded */
  onGrammarLoaded?: (language: SupportedLanguage) => void;
  /** Called when file parsing starts */
  onParseStart?: (filePath: string) => void;
  /** Called when file parsing completes */
  onParseComplete?: (result: ParsedFile) => void;
  /** Called on parse error */
  onParseError?: (filePath: string, error: Error) => void;
}
