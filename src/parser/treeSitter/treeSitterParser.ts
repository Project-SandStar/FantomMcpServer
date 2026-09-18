/**
 * Tree-sitter Parser
 *
 * Main parser wrapper that uses tree-sitter to parse source code
 * into structured AST representations.
 */

import { Parser, Tree, Node, Query, type QueryMatch } from 'web-tree-sitter';
import { createLogger } from '../../utils/index.js';
import { LanguageRegistry, getLanguageRegistry } from './languageRegistry.js';
import type {
  SupportedLanguage,
  ASTNode,
  ASTLocation,
  ParsedFile,
  ParseOptions,
  ParseError,
  ParserEvents
} from './types.js';
import { ASTExtractor } from './astExtractor.js';
import { getFantomPostProcessor } from './fantomPostProcessor.js';

const logger = createLogger('tree-sitter-parser');

// Default parse options
const DEFAULT_OPTIONS: ParseOptions = {
  includeAST: false,
  extractBodies: true,
  extractCalls: true,
  extractDocs: true,
  maxFileSize: 1024 * 1024, // 1MB
  timeout: 30000 // 30 seconds
};

// ============================================
// Tree-sitter Parser Class
// ============================================

export class TreeSitterParser {
  private registry: LanguageRegistry;
  private extractor: ASTExtractor;
  private events: ParserEvents;

  constructor(
    registry?: LanguageRegistry,
    events: ParserEvents = {}
  ) {
    this.registry = registry || getLanguageRegistry();
    this.extractor = new ASTExtractor(this.registry);
    this.events = events;
  }

  /**
   * Initialize the parser
   */
  async initialize(): Promise<void> {
    await this.registry.initialize();
    logger.info('TreeSitterParser initialized');
  }

  /**
   * Parse a source file
   */
  async parseFile(
    filePath: string,
    source: string,
    options: ParseOptions = {}
  ): Promise<ParsedFile> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const startTime = Date.now();

    // Detect language
    const language = this.registry.detectLanguage(filePath);
    if (!language) {
      return this.createErrorResult(
        filePath,
        'fantom', // Default fallback
        `Unable to detect language for file: ${filePath}`,
        startTime
      );
    }

    // Emit parse start event
    this.events.onParseStart?.(filePath);

    // Check file size
    if (source.length > (opts.maxFileSize || DEFAULT_OPTIONS.maxFileSize!)) {
      return this.createErrorResult(
        filePath,
        language,
        `File too large: ${source.length} bytes exceeds ${opts.maxFileSize} limit`,
        startTime
      );
    }

    // Load language grammar
    const loaded = await this.registry.loadLanguage(language);
    if (!loaded) {
      // For languages without grammar, return minimal result
      return this.createErrorResult(
        filePath,
        language,
        `Grammar not available for language: ${language}`,
        startTime
      );
    }

    try {
      // Parse with tree-sitter
      const result = await this.parseWithTimeout(
        source,
        language,
        opts.timeout || DEFAULT_OPTIONS.timeout!
      );

      if (!result) {
        return this.createErrorResult(
          filePath,
          language,
          'Parse timeout exceeded',
          startTime
        );
      }

      const { tree } = result;

      // Convert to our AST format if requested
      const ast = opts.includeAST
        ? this.convertToASTNode(tree.rootNode)
        : undefined;

      // Extract errors from tree
      const errors = this.extractErrors(tree.rootNode);

      // Extract code structures
      const extracted = this.extractor.extractAll(
        tree.rootNode,
        language,
        source,
        opts
      );

      // Build result
      let parsedFile: ParsedFile = {
        filePath,
        language,
        success: errors.filter(e => e.type === 'syntax').length === 0,
        errors,
        classes: extracted.classes,
        interfaces: extracted.interfaces,
        functions: extracted.functions,
        imports: extracted.imports,
        exports: extracted.exports,
        ast,
        parseTime: Date.now() - startTime
      };

      // Apply Fantom post-processor to extract additional info
      if (language === 'fantom') {
        const postProcessor = getFantomPostProcessor();
        parsedFile = postProcessor.process(parsedFile, source);
        // Re-evaluate success after filtering errors
        parsedFile.success = parsedFile.errors.filter(e => e.type === 'syntax').length === 0;
      }

      // Clean up
      tree.delete();

      // Emit complete event
      this.events.onParseComplete?.(parsedFile);

      return parsedFile;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Parse error for ${filePath}: ${errorMessage}`);
      this.events.onParseError?.(filePath, error as Error);

      return this.createErrorResult(filePath, language, errorMessage, startTime);
    }
  }

  /**
   * Parse multiple files
   */
  async parseFiles(
    files: Array<{ path: string; source: string }>,
    options: ParseOptions = {}
  ): Promise<ParsedFile[]> {
    const results: ParsedFile[] = [];

    for (const file of files) {
      const result = await this.parseFile(file.path, file.source, options);
      results.push(result);
    }

    return results;
  }

  /**
   * Parse source with language (when language is known)
   */
  async parseSource(
    source: string,
    language: SupportedLanguage,
    options: ParseOptions = {}
  ): Promise<ParsedFile> {
    // Create a virtual file path
    const virtualPath = `<source>.${this.getExtensionForLanguage(language)}`;
    return this.parseFile(virtualPath, source, options);
  }

  /**
   * Get raw tree-sitter tree (for advanced usage)
   */
  async getRawTree(
    source: string,
    language: SupportedLanguage
  ): Promise<Tree | null> {
    const loaded = await this.registry.loadLanguage(language);
    if (!loaded) return null;

    const parser = this.registry.getParser();
    if (!parser) return null;

    const config = this.registry.getLanguage(language);
    if (!config?.language) return null;

    parser.setLanguage(config.language);
    // Wall-clock abort via progressCallback. parser.parse(...) is sync
    // WASM and JS can't preempt mid-call, but tree-sitter periodically
    // invokes progressCallback during parsing. Returning true aborts.
    const TIMEOUT_MS = Number(process.env.FANTOM_PARSE_TIMEOUT_MS ?? '30000');
    const start = Date.now();
    return parser.parse(source, null, {
      progressCallback: () => Date.now() - start > TIMEOUT_MS,
    });
  }

  /**
   * Query AST with tree-sitter query syntax
   */
  async query(
    source: string,
    language: SupportedLanguage,
    queryString: string
  ): Promise<QueryMatch[]> {
    const tree = await this.getRawTree(source, language);
    if (!tree) return [];

    const config = this.registry.getLanguage(language);
    if (!config?.language) {
      tree.delete();
      return [];
    }

    try {
      const query = new Query(config.language, queryString);
      const matches = query.matches(tree.rootNode);
      query.delete();
      tree.delete();
      return matches;
    } catch (error) {
      logger.error(`Query error: ${error}`);
      tree.delete();
      return [];
    }
  }

  /**
   * Parse with timeout protection
   */
  private async parseWithTimeout(
    source: string,
    language: SupportedLanguage,
    timeoutMs: number
  ): Promise<{ tree: Tree; parser: Parser } | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        logger.warn(`Parse timeout for ${language}`);
        resolve(null);
      }, timeoutMs);

      try {
        const parser = this.registry.getParser();
        if (!parser) {
          clearTimeout(timer);
          resolve(null);
          return;
        }

        const config = this.registry.getLanguage(language);
        if (!config?.language) {
          clearTimeout(timer);
          resolve(null);
          return;
        }

        parser.setLanguage(config.language);
        const TIMEOUT_MS = Number(process.env.FANTOM_PARSE_TIMEOUT_MS ?? '30000');
        const parseStart = Date.now();
        const tree = parser.parse(source, null, {
          progressCallback: () => Date.now() - parseStart > TIMEOUT_MS,
        });

        clearTimeout(timer);
        if (!tree) {
          resolve(null);
          return;
        }
        resolve({ tree, parser });
      } catch (error) {
        clearTimeout(timer);
        throw error;
      }
    });
  }

  /**
   * Convert tree-sitter node to our AST format
   */
  private convertToASTNode(node: Node, parent?: ASTNode): ASTNode {
    const astNode: ASTNode = {
      type: node.type,
      text: node.text,
      location: this.getLocation(node),
      children: [],
      parent,
      fields: {}
    };

    // Convert named children
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) {
        astNode.children.push(this.convertToASTNode(child, astNode));
      }
    }

    // Extract fields
    const fieldNames = node.type ? this.getFieldNames(node) : [];
    for (const fieldName of fieldNames) {
      const fieldNode = node.childForFieldName(fieldName);
      if (fieldNode) {
        astNode.fields[fieldName] = this.convertToASTNode(fieldNode, astNode);
      }
    }

    return astNode;
  }

  /**
   * Get field names for a node (based on type)
   */
  private getFieldNames(node: Node): string[] {
    // Common field names across languages
    const commonFields = [
      'name',
      'body',
      'parameters',
      'arguments',
      'type',
      'value',
      'condition',
      'consequence',
      'alternative',
      'left',
      'right',
      'operator'
    ];

    // Filter to fields that exist on this node
    return commonFields.filter(field => {
      try {
        return node.childForFieldName(field) !== null;
      } catch {
        return false;
      }
    });
  }

  /**
   * Extract parse errors from tree
   * Limits errors to prevent overwhelming output for files with grammar limitations
   */
  private extractErrors(rootNode: Node, maxErrors: number = 20): ParseError[] {
    const errors: ParseError[] = [];
    const seenLocations = new Set<string>();

    const traverse = (node: Node) => {
      // Stop early if we've hit the limit
      if (errors.length >= maxErrors) return;

      if (node.type === 'ERROR' || node.isMissing) {
        // Deduplicate errors at the same location
        const locKey = `${node.startPosition.row}:${node.startPosition.column}`;
        if (!seenLocations.has(locKey)) {
          seenLocations.add(locKey);

          // Get a preview of the problematic text
          const preview = node.text.substring(0, 30).replace(/\n/g, ' ');

          errors.push({
            message: node.isMissing
              ? `Missing: expected ${node.type}`
              : `Syntax error: unexpected token "${preview}"`,
            location: this.getLocation(node),
            type: 'syntax'
          });
        }
      }

      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) {
          traverse(child);
        }
      }
    };

    traverse(rootNode);

    // Add a note if we hit the limit
    if (errors.length >= maxErrors) {
      errors.push({
        message: `... and more errors (showing first ${maxErrors})`,
        location: {
          startLine: 0,
          startColumn: 0,
          endLine: 0,
          endColumn: 0,
          startIndex: 0,
          endIndex: 0
        },
        type: 'info'
      });
    }

    return errors;
  }

  /**
   * Get location from tree-sitter node
   */
  private getLocation(node: Node): ASTLocation {
    return {
      startLine: node.startPosition.row + 1,
      startColumn: node.startPosition.column,
      endLine: node.endPosition.row + 1,
      endColumn: node.endPosition.column,
      startIndex: node.startIndex,
      endIndex: node.endIndex
    };
  }

  /**
   * Create error result
   */
  private createErrorResult(
    filePath: string,
    language: SupportedLanguage,
    message: string,
    startTime: number
  ): ParsedFile {
    return {
      filePath,
      language,
      success: false,
      errors: [
        {
          message,
          location: {
            startLine: 1,
            startColumn: 0,
            endLine: 1,
            endColumn: 0,
            startIndex: 0,
            endIndex: 0
          },
          type: 'syntax'
        }
      ],
      classes: [],
      interfaces: [],
      functions: [],
      imports: [],
      exports: [],
      parseTime: Date.now() - startTime
    };
  }

  /**
   * Get file extension for a language
   */
  private getExtensionForLanguage(language: SupportedLanguage): string {
    const config = this.registry.getLanguage(language);
    return config?.extensions[0] || 'txt';
  }

  /**
   * Get supported languages
   */
  getSupportedLanguages(): SupportedLanguage[] {
    return this.registry.getSupportedLanguages();
  }

  /**
   * Get available grammars
   */
  getAvailableGrammars(): SupportedLanguage[] {
    return this.registry.getAvailableGrammars();
  }

  /**
   * Check if language is supported
   */
  isLanguageSupported(language: SupportedLanguage): boolean {
    return this.registry.isGrammarAvailable(language);
  }
}

// ============================================
// Factory Function
// ============================================

let parserInstance: TreeSitterParser | null = null;

export async function getTreeSitterParser(
  events?: ParserEvents
): Promise<TreeSitterParser> {
  if (!parserInstance) {
    parserInstance = new TreeSitterParser(undefined, events);
    await parserInstance.initialize();
  }
  return parserInstance;
}

export function resetTreeSitterParser(): void {
  parserInstance = null;
}
