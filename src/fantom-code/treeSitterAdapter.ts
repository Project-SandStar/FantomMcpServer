/**
 * Tree-sitter Adapter - Converts tree-sitter parsed output to Fantom types
 *
 * This adapter allows tree-sitter parsers to be used with the existing
 * code indexing infrastructure by converting their output format.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/index.js';
import { getLanguageRegistry, LanguageRegistry } from '../parser/treeSitter/languageRegistry.js';
import type {
  SupportedLanguage,
  ParsedFile as TreeSitterParsedFile,
  ExtractedClass,
  ExtractedFunction as TSFunction,
  ExtractedInterface,
  ExtractedField,
  ExtractedImport,
  ExtractedCall
} from '../parser/treeSitter/types.js';
import type {
  FantomFunction,
  FantomTypeDef,
  ParsedFile,
  Parameter,
  FunctionType,
  FunctionCall
} from './types.js';
import {
  generateFunctionId,
  generateTypeId,
  categorizeFunction,
  generateTags,
  formatSignature,
  FantomCategory
} from './types.js';

const logger = createLogger('tree-sitter-adapter');

// ============================================
// File Scanner for Multi-Language Support
// ============================================

const LANGUAGE_EXTENSIONS: Record<SupportedLanguage, string[]> = {
  typescript: ['ts', 'tsx', 'mts', 'cts'],
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  python: ['py', 'pyw', 'pyi'],
  java: ['java'],
  go: ['go'],
  rust: ['rs'],
  c: ['c', 'h'],
  cpp: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx'],
  csharp: ['cs'],
  ruby: ['rb', 'rake', 'gemspec'],
  php: ['php', 'phtml'],
  kotlin: ['kt', 'kts'],
  swift: ['swift'],
  scala: ['scala', 'sc'],
  fantom: ['fan'],
  xeto: ['xeto'],
  axon: ['axon'],
  html: ['html', 'htm', 'xhtml'],
  css: ['css', 'scss', 'less'],
  json: ['json', 'jsonc'],
  vue: ['vue'],
  dart: ['dart'],
  polymer: [] // Detected by content
};

export class MultiLanguageScanner {
  private extensions: string[];

  constructor(language: SupportedLanguage) {
    if (language === 'vue') {
      // Vue projects contain .vue, .ts, .js, .css files
      this.extensions = [
        ...LANGUAGE_EXTENSIONS.vue,
        ...LANGUAGE_EXTENSIONS.typescript,
        ...LANGUAGE_EXTENSIONS.javascript,
        ...LANGUAGE_EXTENSIONS.css
      ];
    } else {
      this.extensions = LANGUAGE_EXTENSIONS[language] || [];
    }

    // Always include .fan, .xeto, and .axon files — this is a Fantom MCP server
    if (language !== 'fantom' && !this.extensions.includes('fan')) {
      this.extensions.push('fan');
    }
    if (language !== 'xeto' && !this.extensions.includes('xeto')) {
      this.extensions.push('xeto');
    }
    if (language !== 'axon' && !this.extensions.includes('axon')) {
      this.extensions.push('axon');
    }
  }

  async scanDirectory(dirPath: string): Promise<{
    files: string[];
    errors: string[];
  }> {
    const files: string[] = [];
    const errors: string[] = [];
    const { DEFAULT_EXCLUDE_DIRS, loadGitignore } = await import('./excludeDirs.js');

    let gitignoreMatcher: ((p: string) => boolean) | null = null;
    try {
      gitignoreMatcher = await loadGitignore(dirPath);
    } catch {
      gitignoreMatcher = null;
    }

    try {
      await this.scanRecursive(dirPath, files, errors, DEFAULT_EXCLUDE_DIRS, gitignoreMatcher);
    } catch (err) {
      errors.push(`Scan error: ${err}`);
    }

    return { files, errors };
  }

  private async scanRecursive(
    dir: string,
    files: string[],
    errors: string[],
    excludeDirs: ReadonlySet<string>,
    gitignoreMatcher: ((p: string) => boolean) | null,
  ): Promise<void> {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        // .gitignore short-circuit (applies to both files and directories).
        if (gitignoreMatcher && gitignoreMatcher(fullPath)) continue;

        if (entry.isDirectory()) {
          if (excludeDirs.has(entry.name)) continue;
          await this.scanRecursive(fullPath, files, errors, excludeDirs, gitignoreMatcher);
        } else if (entry.isFile()) {
          const ext = entry.name.split('.').pop()?.toLowerCase();
          if (ext && this.extensions.includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    } catch (err) {
      errors.push(`Failed to scan ${dir}: ${err}`);
    }
  }
}

// ============================================
// Tree-sitter Code Parser Adapter
// ============================================

export class TreeSitterCodeParser {
  private projectId: number;
  private language: SupportedLanguage;
  private registry: LanguageRegistry;
  private podName?: string;
  private initialized = false;

  constructor(projectId: number, language: SupportedLanguage, podName?: string) {
    this.projectId = projectId;
    this.language = language;
    this.podName = podName;
    this.registry = getLanguageRegistry();
  }

  async initialize(): Promise<boolean> {
    if (this.initialized) return true;

    await this.registry.initialize();
    const loaded = await this.registry.loadLanguage(this.language);

    if (!loaded) {
      logger.warn(`Grammar not available for ${this.language}, falling back to basic parsing`);
      return false;
    }

    this.initialized = true;
    return true;
  }

  /**
   * Detect the language for a file based on extension
   */
  private detectLanguageFromExtension(ext: string): SupportedLanguage | null {
    const map: Record<string, SupportedLanguage> = {
      '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
      '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
      '.css': 'css', '.scss': 'css', '.less': 'css',
      '.vue': 'vue',
      '.py': 'python', '.java': 'java', '.go': 'go', '.rs': 'rust',
      '.fan': 'fantom', '.xeto': 'xeto', '.axon': 'axon', '.dart': 'dart', '.html': 'html',
      '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp',
      '.cs': 'csharp', '.rb': 'ruby', '.php': 'php',
      '.kt': 'kotlin', '.swift': 'swift', '.scala': 'scala',
    };
    return map[ext] || null;
  }

  /**
   * Parse content as a specific language (used for embedded blocks)
   */
  private async parseFileAsLanguage(
    filePath: string,
    content: string,
    lang: SupportedLanguage,
    lineOffset: number = 0
  ): Promise<ParsedFile> {
    const config = this.registry.getLanguage(lang);
    if (!config?.language) {
      return this.parseWithRegex(filePath, content);
    }

    const parser = this.registry.getParser();
    if (!parser) {
      return this.parseWithRegex(filePath, content);
    }

    try {
      parser.setLanguage(config.language);
      const tree = parser.parse(content);
      if (!tree) {
        return this.parseWithRegex(filePath, content);
      }

      const classes: ExtractedClass[] = [];
      const interfaces: ExtractedInterface[] = [];
      const functions: TSFunction[] = [];
      const imports: ExtractedImport[] = [];

      this.extractFromNode(tree.rootNode, config.nodeMappings, classes, interfaces, functions, imports);

      // Apply line offset for embedded blocks
      if (lineOffset > 0) {
        for (const f of functions) {
          f.location.startLine += lineOffset;
          f.location.endLine += lineOffset;
        }
        for (const c of classes) {
          c.location.startLine += lineOffset;
          c.location.endLine += lineOffset;
        }
        for (const i of interfaces) {
          i.location.startLine += lineOffset;
          i.location.endLine += lineOffset;
        }
      }

      const tsResult: TreeSitterParsedFile = {
        filePath,
        language: lang,
        success: true,
        errors: [],
        classes,
        interfaces,
        functions,
        imports,
        exports: [],
        parseTime: 0
      };

      return this.convertTreeSitterResult(tsResult, filePath);
    } catch (err) {
      logger.warn(`parseFileAsLanguage failed for ${filePath} (${lang}): ${err}`);
      return this.parseWithRegex(filePath, content);
    }
  }

  /**
   * Parse a .vue file by extracting embedded <script> and <style> blocks
   */
  private async parseVueFile(filePath: string, content: string): Promise<ParsedFile> {
    const result: ParsedFile = {
      filePath,
      types: [],
      functions: [],
      imports: [],
      usings: [],
      errors: []
    };

    // Extract <script> blocks
    const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = scriptRegex.exec(content)) !== null) {
      const attrs = match[1];
      const langMatch = attrs.match(/lang=["'](\w+)["']/);
      const lang = langMatch ? langMatch[1] : 'javascript';
      const scriptContent = match[2];
      const lineOffset = content.substring(0, match.index).split('\n').length;

      const tsLang: SupportedLanguage = (lang === 'ts' || lang === 'typescript') ? 'typescript' : 'javascript';

      // Load grammar if needed
      await this.registry.loadLanguage(tsLang);

      const parsed = await this.parseFileAsLanguage(filePath, scriptContent, tsLang, lineOffset);
      result.types.push(...parsed.types);
      result.functions.push(...parsed.functions);
      result.imports.push(...parsed.imports);
      result.errors.push(...parsed.errors);
    }

    // Extract <style> blocks
    const styleRegex = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
    while ((match = styleRegex.exec(content)) !== null) {
      const styleContent = match[1];
      const lineOffset = content.substring(0, match.index).split('\n').length;

      await this.registry.loadLanguage('css');

      const parsed = await this.parseFileAsLanguage(filePath, styleContent, 'css', lineOffset);
      result.types.push(...parsed.types);
      result.functions.push(...parsed.functions);
      result.errors.push(...parsed.errors);
    }

    return result;
  }

  /**
   * Parse a source file and return in the standard ParsedFile format
   */
  async parseFile(filePath: string, content?: string): Promise<ParsedFile> {
    const fileContent = content ?? fs.readFileSync(filePath, 'utf-8');

    const result: ParsedFile = {
      filePath,
      types: [],
      functions: [],
      imports: [],
      usings: [],
      errors: []
    };

    try {
      const ext = path.extname(filePath).toLowerCase();

      // Route .vue files to Vue parser
      if (ext === '.vue') {
        return this.parseVueFile(filePath, fileContent);
      }

      // For mixed-language projects (e.g., .ts in a Vue project), detect per-file language
      const fileLanguage = this.detectLanguageFromExtension(ext);
      if (fileLanguage && fileLanguage !== this.language && this.initialized) {
        await this.registry.loadLanguage(fileLanguage);
        return this.parseFileAsLanguage(filePath, fileContent, fileLanguage);
      }

      // Try tree-sitter parsing with the project's primary language
      if (this.initialized) {
        const treeSitterResult = await this.parseWithTreeSitter(filePath, fileContent);
        if (treeSitterResult) {
          return this.convertTreeSitterResult(treeSitterResult, filePath);
        }
      }

      // Fallback to basic regex parsing for unsupported languages
      return this.parseWithRegex(filePath, fileContent);
    } catch (err) {
      result.errors.push({
        file: filePath,
        message: err instanceof Error ? err.message : String(err),
        severity: 'error'
      });
      return result;
    }
  }

  private async parseWithTreeSitter(filePath: string, content: string): Promise<TreeSitterParsedFile | null> {
    const config = this.registry.getLanguage(this.language);
    if (!config?.language) return null;

    const parser = this.registry.getParser();
    if (!parser) return null;

    try {
      parser.setLanguage(config.language);
      const tree = parser.parse(content);

      if (!tree) {
        return null;
      }

      // Extract structures from tree
      const classes: ExtractedClass[] = [];
      const interfaces: ExtractedInterface[] = [];
      const functions: TSFunction[] = [];
      const imports: ExtractedImport[] = [];

      this.extractFromNode(tree.rootNode, config.nodeMappings, classes, interfaces, functions, imports);

      return {
        filePath,
        language: this.language,
        success: true,
        errors: [],
        classes,
        interfaces,
        functions,
        imports,
        exports: [],
        parseTime: 0
      };
    } catch (err) {
      logger.warn(`Tree-sitter parse failed for ${filePath}: ${err}`);
      return null;
    }
  }

  private extractFromNode(
    node: unknown,
    mappings: { functionTypes: string[]; classTypes: string[]; interfaceTypes: string[]; importTypes: string[] },
    classes: ExtractedClass[],
    interfaces: ExtractedInterface[],
    functions: TSFunction[],
    imports: ExtractedImport[]
  ): void {
    // Type guard for tree-sitter node
    const tsNode = node as {
      type: string;
      text: string;
      startPosition: { row: number; column: number };
      endPosition: { row: number; column: number };
      startIndex: number;
      endIndex: number;
      childCount: number;
      children: unknown[];
      childForFieldName: (name: string) => unknown | null;
    };

    if (!tsNode || typeof tsNode.type !== 'string') return;

    // Extract based on node type
    if (mappings.classTypes.includes(tsNode.type)) {
      const cls = this.extractClass(tsNode, mappings);
      if (cls) classes.push(cls);
      return; // Don't recurse — extractClass handles class body children
    } else if (mappings.interfaceTypes.includes(tsNode.type)) {
      const iface = this.extractInterface(tsNode, mappings);
      if (iface) interfaces.push(iface);
      return; // Don't recurse — extractInterface handles interface body children
    } else if (mappings.functionTypes.includes(tsNode.type)) {
      const func = this.extractFunction(tsNode, mappings);
      if (func) functions.push(func);
    } else if (mappings.importTypes.includes(tsNode.type)) {
      const imp = this.extractImport(tsNode);
      if (imp) imports.push(imp);
    }

    // Recurse into children (but not for classes/interfaces — handled above)
    if (tsNode.children) {
      for (const child of tsNode.children) {
        this.extractFromNode(child, mappings, classes, interfaces, functions, imports);
      }
    }
  }

  private extractClass(node: unknown, mappings: { functionTypes: string[]; classTypes: string[]; interfaceTypes: string[]; importTypes: string[]; callTypes?: string[]; variableTypes?: string[] }): ExtractedClass | null {
    const tsNode = node as {
      type: string;
      text: string;
      startPosition: { row: number; column: number };
      endPosition: { row: number; column: number };
      childForFieldName: (name: string) => unknown | null;
      children: unknown[];
    };

    const nameNode = tsNode.childForFieldName('name') || this.findChildByType(tsNode.children, ['identifier', 'type_identifier']);
    // A node without a name (CSS rule_set blocks, anonymous class expressions)
    // used to be recorded as "anonymous" — hundreds per Vue project, and they
    // polluted vectors (top semantic hits for a Rete question were scss rules).
    if (!nameNode) return null;
    const name = (nameNode as { text: string }).text;

    // Extract methods and fields from class body
    const methods: TSFunction[] = [];
    const fields: ExtractedField[] = [];
    const bodyNode = tsNode.childForFieldName('body') || this.findChildByType(tsNode.children, ['class_body', 'body', 'block']);
    if (bodyNode) {
      const body = bodyNode as { children: unknown[] };
      for (const child of body.children || []) {
        const childNode = child as { type: string };
        if (mappings.functionTypes.includes(childNode.type)) {
          const method = this.extractFunction(child, mappings);
          if (method) methods.push(method);
        } else if (mappings.variableTypes?.includes(childNode.type) || childNode.type === 'public_field_definition' || childNode.type === 'property_declaration') {
          const field = this.extractFieldFromNode(child);
          if (field) fields.push(field);
        }
      }
    }

    // Extract extends
    const extendsClause = this.findChildByType(tsNode.children, ['extends_clause', 'class_heritage']);
    const extendsName = extendsClause ? this.extractTextContent(extendsClause, 'extends') : undefined;

    // Extract implements
    const implementsClause = this.findChildByType(tsNode.children, ['implements_clause']);
    const implementsList = implementsClause ? this.extractIdentifierList(implementsClause) : [];

    return {
      name,
      qualifiedName: this.buildQualifiedName(name),
      location: {
        startLine: tsNode.startPosition.row + 1,
        startColumn: tsNode.startPosition.column,
        endLine: tsNode.endPosition.row + 1,
        endColumn: tsNode.endPosition.column,
        startIndex: 0,
        endIndex: 0
      },
      extends: extendsName,
      methods,
      fields,
      implements: implementsList,
      isAbstract: tsNode.text.includes('abstract class')
    };
  }

  private extractInterface(node: unknown, mappings: { functionTypes: string[]; classTypes: string[]; interfaceTypes: string[]; importTypes: string[]; callTypes?: string[]; variableTypes?: string[] }): ExtractedInterface | null {
    const tsNode = node as {
      text: string;
      startPosition: { row: number; column: number };
      endPosition: { row: number; column: number };
      childForFieldName: (name: string) => unknown | null;
      children: unknown[];
    };

    const nameNode = tsNode.childForFieldName('name') || this.findChildByType(tsNode.children, ['identifier', 'type_identifier']);
    // A node without a name (CSS rule_set blocks, anonymous class expressions)
    // used to be recorded as "anonymous" — hundreds per Vue project, and they
    // polluted vectors (top semantic hits for a Rete question were scss rules).
    if (!nameNode) return null;
    const name = (nameNode as { text: string }).text;

    // Extract methods and properties from interface body
    const methods: TSFunction[] = [];
    const properties: ExtractedField[] = [];
    const bodyNode = tsNode.childForFieldName('body') || this.findChildByType(tsNode.children, ['interface_body', 'object_type', 'body']);
    if (bodyNode) {
      const body = bodyNode as { children: unknown[] };
      for (const child of body.children || []) {
        const childNode = child as { type: string };
        if (childNode.type === 'method_signature' || mappings.functionTypes.includes(childNode.type)) {
          const method = this.extractFunction(child, mappings);
          if (method) methods.push(method);
        } else if (childNode.type === 'property_signature') {
          const field = this.extractFieldFromNode(child);
          if (field) properties.push(field);
        }
      }
    }

    // Extract extends
    const extendsClause = this.findChildByType(tsNode.children, ['extends_type_clause', 'extends_clause']);
    const extendsList = extendsClause ? this.extractIdentifierList(extendsClause) : [];

    return {
      name,
      qualifiedName: this.buildQualifiedName(name),
      location: {
        startLine: tsNode.startPosition.row + 1,
        startColumn: tsNode.startPosition.column,
        endLine: tsNode.endPosition.row + 1,
        endColumn: tsNode.endPosition.column,
        startIndex: 0,
        endIndex: 0
      },
      methods,
      properties,
      extends: extendsList
    };
  }

  private extractFunction(node: unknown, mappings?: { functionTypes?: string[]; classTypes?: string[]; interfaceTypes?: string[]; importTypes?: string[]; callTypes?: string[]; variableTypes?: string[] }): TSFunction | null {
    const tsNode = node as {
      type: string;
      text: string;
      startPosition: { row: number; column: number };
      endPosition: { row: number; column: number };
      childForFieldName: (name: string) => unknown | null;
      children: unknown[];
      parent?: { type: string; childForFieldName: (name: string) => unknown | null; children: unknown[] } | null;
    };

    let name: string;
    if (tsNode.type === 'arrow_function' || tsNode.type === 'function_expression' || tsNode.type === 'function') {
      // An arrow/function expression has no name of its own. Its first
      // identifier child is a PARAMETER (`s => s.isProp` → "s"), which used to
      // be recorded as a function named "s". Take the name from what the
      // expression is assigned to (`const foo = () => …`, `{ foo: () => … }`,
      // `this.foo = () => …`, class fields) and skip anonymous callbacks passed
      // as arguments — they are bodies of the enclosing function, not symbols.
      const parent = tsNode.parent ?? null;
      let assigned: unknown | null = null;
      if (parent) {
        if (parent.type === 'variable_declarator' || parent.type === 'public_field_definition' || parent.type === 'field_definition' || parent.type === 'property_definition') {
          assigned = parent.childForFieldName('name');
        } else if (parent.type === 'pair' || parent.type === 'pair_pattern') {
          assigned = parent.childForFieldName('key');
        } else if (parent.type === 'assignment_expression') {
          const left = parent.childForFieldName('left') as { type: string; text: string; childForFieldName?: (n: string) => unknown | null } | null;
          assigned = left && left.type === 'member_expression' && left.childForFieldName ? left.childForFieldName('property') : left;
        } else if (parent.type === 'method_definition') {
          assigned = parent.childForFieldName('name');
        }
      }
      if (!assigned) return null;
      name = (assigned as { text: string }).text;
    } else {
      const nameNode = tsNode.childForFieldName('name') || this.findChildByType(tsNode.children, ['identifier', 'property_identifier']);
      if (!nameNode) return null;
      name = (nameNode as { text: string }).text;
    }

    // Extract parameters
    const paramsNode = tsNode.childForFieldName('parameters') || this.findChildByType(tsNode.children, ['formal_parameters']);
    const parameters = this.extractParameters(paramsNode);

    // Extract return type
    const returnTypeNode = tsNode.childForFieldName('return_type') || this.findChildByType(tsNode.children, ['type_annotation']);
    const returnType = returnTypeNode ? (returnTypeNode as { text: string }).text.replace(/^:\s*/, '') : undefined;

    // Extract calls from function body
    const calls: ExtractedCall[] = [];
    const callTypes = mappings?.callTypes || ['call_expression', 'new_expression'];
    const bodyNode = tsNode.childForFieldName('body') || this.findChildByType(tsNode.children, ['statement_block', 'block', 'expression']);
    if (bodyNode) {
      this.collectCalls(bodyNode, callTypes, calls);
    }

    // Build signature
    const paramStr = parameters.map(p => p.name + (p.type ? ': ' + p.type : '')).join(', ');
    const sig = `${name}(${paramStr})${returnType ? ': ' + returnType : ''}`;

    return {
      name,
      qualifiedName: this.buildQualifiedName(name),
      signature: sig,
      returnType,
      parameters,
      location: {
        startLine: tsNode.startPosition.row + 1,
        startColumn: tsNode.startPosition.column,
        endLine: tsNode.endPosition.row + 1,
        endColumn: tsNode.endPosition.column,
        startIndex: 0,
        endIndex: 0
      },
      isAsync: tsNode.type === 'arrow_function' ? false : tsNode.text.startsWith('async'),
      isStatic: tsNode.text.includes('static '),
      isAbstract: tsNode.text.startsWith('abstract '),
      calls
    };
  }

  private extractImport(node: unknown): ExtractedImport | null {
    const tsNode = node as {
      text: string;
      startPosition: { row: number; column: number };
      endPosition: { row: number; column: number };
    };

    return {
      source: tsNode.text,
      items: [],
      location: {
        startLine: tsNode.startPosition.row + 1,
        startColumn: tsNode.startPosition.column,
        endLine: tsNode.endPosition.row + 1,
        endColumn: tsNode.endPosition.column,
        startIndex: 0,
        endIndex: 0
      },
      isTypeOnly: false
    };
  }

  private findChildByType(children: unknown[], types: string[]): unknown | null {
    if (!Array.isArray(children)) return null;
    for (const child of children) {
      const tsChild = child as { type: string };
      if (types.includes(tsChild.type)) return child;
    }
    return null;
  }

  /**
   * Extract parameters from a formal_parameters node
   */
  private extractParameters(paramsNode: unknown): Array<{ name: string; type?: string; defaultValue?: string; isOptional: boolean; isRest: boolean }> {
    if (!paramsNode) return [];
    const node = paramsNode as { children: unknown[] };
    const params: Array<{ name: string; type?: string; defaultValue?: string; isOptional: boolean; isRest: boolean }> = [];
    for (const child of node.children || []) {
      const childNode = child as { type: string; text: string; childForFieldName: (n: string) => unknown | null; children: unknown[] };
      if (childNode.type === 'required_parameter' || childNode.type === 'optional_parameter' || childNode.type === 'formal_parameter' || childNode.type === 'rest_parameter') {
        const nameN = childNode.childForFieldName('pattern') || childNode.childForFieldName('name') || this.findChildByType(childNode.children, ['identifier']);
        const typeN = childNode.childForFieldName('type') || this.findChildByType(childNode.children, ['type_annotation']);
        const name = nameN ? (nameN as { text: string }).text : childNode.text;
        const type = typeN ? (typeN as { text: string }).text.replace(/^:\s*/, '') : undefined;
        params.push({ name, type, isOptional: childNode.type === 'optional_parameter', isRest: childNode.type === 'rest_parameter' });
      }
    }
    return params;
  }

  /**
   * Recursively collect call expressions from a node
   */
  private collectCalls(node: unknown, callTypes: string[], calls: ExtractedCall[]): void {
    const tsNode = node as { type: string; text: string; children: unknown[]; startPosition: { row: number; column: number }; childForFieldName: (n: string) => unknown | null };
    if (!tsNode || typeof tsNode.type !== 'string') return;

    if (callTypes.includes(tsNode.type)) {
      const call = this.extractCallExpression(tsNode);
      if (call) calls.push(call);
    }

    for (const child of tsNode.children || []) {
      this.collectCalls(child, callTypes, calls);
    }
  }

  /**
   * Extract a call expression into an ExtractedCall
   */
  private extractCallExpression(node: { type: string; text: string; children: unknown[]; startPosition: { row: number; column: number }; childForFieldName: (n: string) => unknown | null }): ExtractedCall | null {
    const funcNode = node.childForFieldName('function') || (node.children && node.children[0]);
    if (!funcNode) return null;

    const fn = funcNode as { type: string; text: string; childForFieldName: (n: string) => unknown | null };
    let name = fn.text;
    let target: string | undefined;

    // member_expression: obj.method()
    if (fn.type === 'member_expression') {
      const obj = fn.childForFieldName('object');
      const prop = fn.childForFieldName('property');
      if (obj && prop) {
        target = (obj as { text: string }).text;
        name = (prop as { text: string }).text;
      }
    }
    // new_expression: new Foo()
    if (node.type === 'new_expression') {
      name = fn.text;
    }

    return {
      name,
      expression: node.text.slice(0, 200),
      target,
      location: {
        startLine: node.startPosition.row + 1,
        startColumn: node.startPosition.column,
        endLine: node.startPosition.row + 1,
        endColumn: node.startPosition.column,
        startIndex: 0,
        endIndex: 0
      },
      isAsync: false
    };
  }

  /**
   * Extract a field from a node (property_declaration, public_field_definition, etc.)
   */
  private extractFieldFromNode(node: unknown): ExtractedField | null {
    const tsNode = node as { type: string; text: string; startPosition: { row: number; column: number }; endPosition: { row: number; column: number }; childForFieldName: (n: string) => unknown | null; children: unknown[] };
    const nameNode = tsNode.childForFieldName('name') || this.findChildByType(tsNode.children, ['property_identifier', 'identifier']);
    if (!nameNode) return null;
    const name = (nameNode as { text: string }).text;
    const typeNode = tsNode.childForFieldName('type') || this.findChildByType(tsNode.children, ['type_annotation']);
    const type = typeNode ? (typeNode as { text: string }).text.replace(/^:\s*/, '') : undefined;
    return {
      name,
      type,
      location: {
        startLine: tsNode.startPosition.row + 1,
        startColumn: tsNode.startPosition.column,
        endLine: tsNode.endPosition.row + 1,
        endColumn: tsNode.endPosition.column,
        startIndex: 0,
        endIndex: 0
      },
      visibility: tsNode.text.includes('private') ? 'private' as const : tsNode.text.includes('protected') ? 'protected' as const : 'public' as const,
      isStatic: tsNode.text.includes('static '),
      isReadonly: tsNode.text.includes('readonly ')
    };
  }

  /**
   * Extract text content, stripping a keyword prefix
   */
  private extractTextContent(node: unknown, keyword: string): string | undefined {
    const tsNode = node as { text: string; children: unknown[] };
    // Try to find the actual type/name identifier
    const identNode = this.findChildByType(tsNode.children || [], ['identifier', 'type_identifier']);
    if (identNode) return (identNode as { text: string }).text;
    // Fallback: strip keyword
    return tsNode.text?.replace(new RegExp(`^${keyword}\\s+`), '').trim() || undefined;
  }

  /**
   * Extract a list of identifiers from a clause (e.g., implements A, B)
   */
  private extractIdentifierList(node: unknown): string[] {
    const tsNode = node as { children: unknown[] };
    const ids: string[] = [];
    for (const child of tsNode.children || []) {
      const c = child as { type: string; text: string };
      if (c.type === 'identifier' || c.type === 'type_identifier') {
        ids.push(c.text);
      }
    }
    return ids;
  }

  private buildQualifiedName(name: string): string {
    return this.podName ? `${this.podName}::${name}` : name;
  }

  /**
   * Build a file-scoped qualified name for a type so that duplicate simple
   * class names across files (common in PHP/JS) do not collide on the
   * (projectId, qualifiedName) unique key. Uses the full file path when no
   * pod namespace is available, because basenames alone still collide across
   * directories (e.g. app/Controller.php vs vendor/Foo/Controller.php).
   */
  private buildTypeQualifiedName(name: string, filePath: string): string {
    const ns = this.fileNamespace(filePath);
    return `${ns}::${name}`;
  }

  private fileNamespace(filePath: string): string {
    return this.podName || filePath;
  }

  /**
   * Convert tree-sitter result to standard ParsedFile format
   */
  private convertTreeSitterResult(tsResult: TreeSitterParsedFile, filePath: string): ParsedFile {
    const result: ParsedFile = {
      filePath,
      types: [],
      functions: [],
      imports: tsResult.imports.map(i => i.source),
      usings: [],
      errors: tsResult.errors.map(e => ({
        file: filePath,
        message: e.message,
        line: e.location.startLine,
        severity: e.type === 'syntax' ? 'error' : 'warning' as 'error' | 'warning'
      }))
    };

    // Convert classes to FantomTypeDef
    for (const cls of tsResult.classes) {
      const typeDef = this.convertClass(cls, filePath);
      result.types.push(typeDef);
      result.functions.push(...typeDef.methods, ...typeDef.fields);
    }

    // Convert interfaces to FantomTypeDef (as mixin)
    for (const iface of tsResult.interfaces) {
      const typeDef = this.convertInterface(iface, filePath);
      result.types.push(typeDef);
      result.functions.push(...typeDef.methods);
    }

    // Convert standalone functions
    for (const func of tsResult.functions) {
      result.functions.push(this.convertFunction(func, filePath));
    }

    return result;
  }

  private convertClass(cls: ExtractedClass, filePath: string): FantomTypeDef {
    const methods: FantomFunction[] = cls.methods.map(m => this.convertFunction(m, filePath, cls.name));
    const fields: FantomFunction[] = cls.fields.map(f => this.convertField(f, filePath, cls.name));
    const qualifiedName = this.buildTypeQualifiedName(cls.name, filePath);

    return {
      id: generateTypeId(filePath, qualifiedName, cls.location.startLine),
      projectId: this.projectId,
      name: cls.name,
      qualifiedName,
      kind: 'class',
      filePath,
      lineNumber: cls.location.startLine,
      lineEnd: cls.location.endLine,
      extends: cls.extends,
      mixins: cls.implements,
      facets: [],
      documentation: cls.documentation,
      isPublic: cls.visibility !== 'private',
      isAbstract: cls.isAbstract,
      isFinal: false,
      isConst: false,
      methods,
      fields
    };
  }

  private convertInterface(iface: ExtractedInterface, filePath: string): FantomTypeDef {
    const methods: FantomFunction[] = iface.methods.map(m => this.convertFunction(m, filePath, iface.name));
    const fields: FantomFunction[] = iface.properties.map(p => this.convertField(p, filePath, iface.name));
    const qualifiedName = this.buildTypeQualifiedName(iface.name, filePath);

    return {
      id: generateTypeId(filePath, qualifiedName, iface.location.startLine),
      projectId: this.projectId,
      name: iface.name,
      qualifiedName,
      kind: 'mixin',
      filePath,
      lineNumber: iface.location.startLine,
      lineEnd: iface.location.endLine,
      mixins: iface.extends,
      facets: [],
      documentation: iface.documentation,
      isPublic: true,
      isAbstract: true,
      isFinal: false,
      isConst: false,
      methods,
      fields
    };
  }

  private convertFunction(func: TSFunction, filePath: string, className?: string): FantomFunction {
    const ns = this.fileNamespace(filePath);
    const qualifiedName = className
      ? `${ns}::${className}.${func.name}`
      : `${ns}::${func.name}`;

    const params: Parameter[] = func.parameters.map(p => ({
      name: p.name,
      type: p.type || 'dynamic',
      defaultValue: p.defaultValue
    }));

    const funcType: FunctionType = className ? 'method' : 'method';

    // Filter out calls with minified/single-char targets (compiled TS/JS output)
    const calls: FunctionCall[] = func.calls
      .filter(c => {
        // Skip calls on single-char variables (minified: c.method, t.emit, x.foo)
        if (c.target && c.target.length <= 2 && /^[a-z_$]$/i.test(c.target)) return false;
        return true;
      })
      .map(c => ({
        calledName: c.name,
        target: c.target,
        lineNumber: c.location.startLine,
        isStatic: false,
        isDynamic: false,
        isConstructor: false,
        resolved: false
      }));

    const fantomFunc: FantomFunction = {
      id: generateFunctionId(filePath, qualifiedName, func.location.startLine),
      projectId: this.projectId,
      name: func.name,
      qualifiedName,
      type: funcType,
      className,
      filePath,
      lineNumber: func.location.startLine,
      lineEnd: func.location.endLine,
      signature: func.signature || formatSignature(func.name, func.returnType, params),
      returnType: func.returnType,
      parameters: params,
      documentation: func.documentation,
      category: FantomCategory.OTHER,
      tags: [],
      isPublic: func.visibility !== 'private',
      isStatic: func.isStatic,
      isAbstract: func.isAbstract,
      isOverride: false,
      isVirtual: false,
      facets: [],
      calls
    };

    // Apply categorization and tagging
    fantomFunc.category = categorizeFunction(fantomFunc);
    fantomFunc.tags = generateTags(fantomFunc);

    return fantomFunc;
  }

  private convertField(field: ExtractedField, filePath: string, className: string): FantomFunction {
    const ns = this.fileNamespace(filePath);
    const qualifiedName = `${ns}::${className}.${field.name}`;

    const fantomField: FantomFunction = {
      id: generateFunctionId(filePath, qualifiedName, field.location.startLine),
      projectId: this.projectId,
      name: field.name,
      qualifiedName,
      type: 'field',
      className,
      filePath,
      lineNumber: field.location.startLine,
      lineEnd: field.location.endLine,
      signature: `${field.type || 'dynamic'} ${field.name}`,
      returnType: field.type,
      parameters: [],
      documentation: field.documentation,
      category: FantomCategory.OTHER,
      tags: [],
      isPublic: field.visibility !== 'private',
      isStatic: field.isStatic,
      isAbstract: false,
      isOverride: false,
      isVirtual: false,
      facets: []
    };

    // Apply categorization and tagging
    fantomField.category = categorizeFunction(fantomField);
    fantomField.tags = generateTags(fantomField);

    return fantomField;
  }

  /**
   * Basic regex-based parsing for unsupported languages
   */
  private parseWithRegex(filePath: string, content: string): ParsedFile {
    const result: ParsedFile = {
      filePath,
      types: [],
      functions: [],
      imports: [],
      usings: [],
      errors: []
    };

    // Extract imports
    const importRegex = /^(?:import|require|using|include)\s+['"]?([^'";\s]+)['"]?/gm;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      result.imports.push(match[1]);
    }

    // Extract basic function definitions (very generic)
    const funcRegex = /(?:function|def|fn|func|fun)\s+(\w+)\s*\(/gm;
    while ((match = funcRegex.exec(content)) !== null) {
      const lineNumber = content.substring(0, match.index).split('\n').length;
      const qualifiedName = this.buildQualifiedName(match[1]);

      result.functions.push({
        id: generateFunctionId(filePath, qualifiedName, lineNumber),
        projectId: this.projectId,
        name: match[1],
        qualifiedName,
        type: 'method',
        filePath,
        lineNumber,
        signature: `${match[1]}()`,
        parameters: [],
        category: FantomCategory.OTHER,
        tags: ['function'],
        isPublic: true,
        isStatic: false,
        isAbstract: false,
        isOverride: false,
        isVirtual: false,
        facets: []
      });
    }

    // Extract basic class definitions
    const classRegex = /(?:class|struct|interface|type)\s+(\w+)/gm;
    while ((match = classRegex.exec(content)) !== null) {
      const lineNumber = content.substring(0, match.index).split('\n').length;
      const qualifiedName = this.buildQualifiedName(match[1]);

      result.types.push({
        id: generateTypeId(filePath, qualifiedName, lineNumber),
        projectId: this.projectId,
        name: match[1],
        qualifiedName,
        kind: 'class',
        filePath,
        lineNumber,
        mixins: [],
        facets: [],
        isPublic: true,
        isAbstract: false,
        isFinal: false,
        isConst: false,
        methods: [],
        fields: []
      });
    }

    return result;
  }
}

// ============================================
// Factory Functions
// ============================================

export function createTreeSitterParser(
  projectId: number,
  language: SupportedLanguage,
  podName?: string
): TreeSitterCodeParser {
  return new TreeSitterCodeParser(projectId, language, podName);
}

export function createMultiLanguageScanner(language: SupportedLanguage): MultiLanguageScanner {
  return new MultiLanguageScanner(language);
}
