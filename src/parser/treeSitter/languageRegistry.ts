/**
 * Language Registry
 *
 * Manages tree-sitter language grammars with lazy loading.
 * Provides file extension mapping and grammar configuration.
 */

import { Parser, Language } from 'web-tree-sitter';
import { createLogger } from '../../utils/index.js';
import type {
  SupportedLanguage,
  LanguageConfig,
  NodeTypeMappings
} from './types.js';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const logger = createLogger('language-registry');

// ============================================
// Node Type Mappings Per Language
// ============================================

const typescriptMappings: NodeTypeMappings = {
  functionTypes: [
    'function_declaration',
    'method_definition',
    'arrow_function',
    'function_expression',
    'method_signature'
  ],
  classTypes: ['class_declaration', 'class'],
  interfaceTypes: ['interface_declaration'],
  variableTypes: [
    'variable_declaration',
    'lexical_declaration',
    'property_signature',
    'public_field_definition'
  ],
  importTypes: ['import_statement', 'import_clause'],
  exportTypes: ['export_statement', 'export_clause'],
  commentTypes: ['comment', 'documentation_comment'],
  callTypes: ['call_expression', 'new_expression'],
  nameField: 'name',
  parametersField: 'parameters',
  bodyField: 'body'
};

const javascriptMappings: NodeTypeMappings = {
  functionTypes: [
    'function_declaration',
    'method_definition',
    'arrow_function',
    'function_expression'
  ],
  classTypes: ['class_declaration', 'class'],
  interfaceTypes: [],
  variableTypes: ['variable_declaration', 'lexical_declaration'],
  importTypes: ['import_statement'],
  exportTypes: ['export_statement'],
  commentTypes: ['comment'],
  callTypes: ['call_expression', 'new_expression'],
  nameField: 'name',
  parametersField: 'parameters',
  bodyField: 'body'
};

const pythonMappings: NodeTypeMappings = {
  functionTypes: ['function_definition'],
  classTypes: ['class_definition'],
  interfaceTypes: [],
  variableTypes: ['assignment', 'annotated_assignment'],
  importTypes: ['import_statement', 'import_from_statement'],
  exportTypes: [],
  commentTypes: ['comment', 'string'], // docstrings are strings
  callTypes: ['call'],
  nameField: 'name',
  parametersField: 'parameters',
  bodyField: 'body'
};

const javaMappings: NodeTypeMappings = {
  functionTypes: ['method_declaration', 'constructor_declaration'],
  classTypes: ['class_declaration'],
  interfaceTypes: ['interface_declaration'],
  variableTypes: ['field_declaration', 'local_variable_declaration'],
  importTypes: ['import_declaration'],
  exportTypes: [],
  commentTypes: ['comment', 'block_comment', 'line_comment'],
  callTypes: ['method_invocation', 'object_creation_expression'],
  nameField: 'name',
  parametersField: 'formal_parameters',
  bodyField: 'body'
};

const goMappings: NodeTypeMappings = {
  functionTypes: ['function_declaration', 'method_declaration'],
  classTypes: ['type_declaration'],
  interfaceTypes: ['interface_type'],
  variableTypes: ['var_declaration', 'const_declaration', 'short_var_declaration'],
  importTypes: ['import_declaration'],
  exportTypes: [],
  commentTypes: ['comment'],
  callTypes: ['call_expression'],
  nameField: 'name',
  parametersField: 'parameters',
  bodyField: 'body'
};

const rustMappings: NodeTypeMappings = {
  functionTypes: ['function_item'],
  classTypes: ['struct_item', 'enum_item'],
  interfaceTypes: ['trait_item'],
  variableTypes: ['let_declaration', 'const_item', 'static_item'],
  importTypes: ['use_declaration'],
  exportTypes: [],
  commentTypes: ['line_comment', 'block_comment', 'doc_comment'],
  callTypes: ['call_expression', 'macro_invocation'],
  nameField: 'name',
  parametersField: 'parameters',
  bodyField: 'body'
};

const cMappings: NodeTypeMappings = {
  functionTypes: ['function_definition'],
  classTypes: ['struct_specifier'],
  interfaceTypes: [],
  variableTypes: ['declaration', 'field_declaration'],
  importTypes: ['preproc_include'],
  exportTypes: [],
  commentTypes: ['comment'],
  callTypes: ['call_expression'],
  nameField: 'declarator',
  parametersField: 'parameters',
  bodyField: 'body'
};

const cppMappings: NodeTypeMappings = {
  functionTypes: ['function_definition', 'template_function'],
  classTypes: ['class_specifier', 'struct_specifier'],
  interfaceTypes: [],
  variableTypes: ['declaration', 'field_declaration'],
  importTypes: ['preproc_include'],
  exportTypes: [],
  commentTypes: ['comment'],
  callTypes: ['call_expression'],
  nameField: 'declarator',
  parametersField: 'parameters',
  bodyField: 'body'
};

const csharpMappings: NodeTypeMappings = {
  functionTypes: ['method_declaration', 'constructor_declaration'],
  classTypes: ['class_declaration', 'struct_declaration'],
  interfaceTypes: ['interface_declaration'],
  variableTypes: ['field_declaration', 'property_declaration'],
  importTypes: ['using_directive'],
  exportTypes: [],
  commentTypes: ['comment', 'xml_comment'],
  callTypes: ['invocation_expression', 'object_creation_expression'],
  nameField: 'name',
  parametersField: 'parameter_list',
  bodyField: 'body'
};

const rubyMappings: NodeTypeMappings = {
  functionTypes: ['method', 'singleton_method'],
  classTypes: ['class', 'module'],
  interfaceTypes: [],
  variableTypes: ['assignment'],
  importTypes: ['require', 'require_relative'],
  exportTypes: [],
  commentTypes: ['comment'],
  callTypes: ['method_call', 'call'],
  nameField: 'name',
  parametersField: 'parameters',
  bodyField: 'body'
};

const phpMappings: NodeTypeMappings = {
  functionTypes: ['function_definition', 'method_declaration'],
  classTypes: ['class_declaration'],
  interfaceTypes: ['interface_declaration'],
  variableTypes: ['property_declaration'],
  importTypes: ['namespace_use_declaration'],
  exportTypes: [],
  commentTypes: ['comment', 'doc_comment'],
  callTypes: [
    'function_call_expression',
    'member_call_expression',
    'scoped_call_expression',
    'nullsafe_member_call_expression',
    'object_creation_expression'
  ],
  nameField: 'name',
  parametersField: 'formal_parameters',
  bodyField: 'body'
};

const kotlinMappings: NodeTypeMappings = {
  functionTypes: ['function_declaration'],
  classTypes: ['class_declaration', 'object_declaration'],
  interfaceTypes: ['interface_declaration'],
  variableTypes: ['property_declaration'],
  importTypes: ['import_header'],
  exportTypes: [],
  commentTypes: ['line_comment', 'multiline_comment', 'kdoc'],
  callTypes: ['call_expression'],
  nameField: 'simple_identifier',
  parametersField: 'function_value_parameters',
  bodyField: 'function_body'
};

const swiftMappings: NodeTypeMappings = {
  functionTypes: ['function_declaration', 'init_declaration'],
  classTypes: ['class_declaration', 'struct_declaration'],
  interfaceTypes: ['protocol_declaration'],
  variableTypes: ['variable_declaration', 'constant_declaration'],
  importTypes: ['import_declaration'],
  exportTypes: [],
  commentTypes: ['comment', 'multiline_comment'],
  callTypes: ['call_expression'],
  nameField: 'name',
  parametersField: 'parameter_clause',
  bodyField: 'function_body'
};

const scalaMappings: NodeTypeMappings = {
  functionTypes: ['function_definition', 'def_definition'],
  classTypes: ['class_definition', 'object_definition'],
  interfaceTypes: ['trait_definition'],
  variableTypes: ['val_definition', 'var_definition'],
  importTypes: ['import_statement'],
  exportTypes: [],
  commentTypes: ['comment', 'block_comment', 'doc_comment'],
  callTypes: ['call_expression'],
  nameField: 'name',
  parametersField: 'parameters',
  bodyField: 'body'
};

// Fantom mappings - based on tree-sitter-fantom grammar
// Note: The Fantom grammar has some limitations:
// - Map type syntax (Str:Str:Type[:]) partially supported
// - It-block closures (|This| f) not fully supported
const fantomMappings: NodeTypeMappings = {
  functionTypes: ['method_def', 'ctor_def'], // Methods and constructors
  classTypes: ['class_definition'],
  interfaceTypes: ['mixin_definition'],
  variableTypes: ['field_def'],
  importTypes: ['using_statement'],
  exportTypes: [],
  commentTypes: ['comment', 'doc_comment'],
  callTypes: ['postfix_expr', 'call_args'],
  // Fantom AST uses child nodes, not fields for names
  nameField: 'identifier', // Actually a child type, handled specially
  parametersField: 'param_list',
  bodyField: 'block'
};

// Xeto mappings - based on tree-sitter-xeto grammar
// Xeto is a data type definition language for Project Haystack / Haxall
const xetoMappings: NodeTypeMappings = {
  functionTypes: ['slot_def'],
  classTypes: ['spec_def'],
  interfaceTypes: ['mixin_def'],
  variableTypes: ['marker_slot', 'typed_scalar'],
  importTypes: [],
  exportTypes: [],
  commentTypes: ['comment', 'block_comment'],
  callTypes: [],
  nameField: 'name',
  parametersField: 'type',
  bodyField: 'body'
};

// Axon mappings - based on tree-sitter-axon grammar
// Axon is the scripting language for SkySpark / Haxall building automation
const axonMappings: NodeTypeMappings = {
  functionTypes: ['lambda', 'trailing_lambda_call'],
  classTypes: ['defcomp'],
  interfaceTypes: [],
  variableTypes: ['define_var'],
  importTypes: [],
  exportTypes: [],
  commentTypes: ['line_comment', 'block_comment'],
  callTypes: ['call_expr', 'dot_call', 'trap_call'],
  nameField: 'name',
  parametersField: 'params',
  bodyField: 'body'
};

// Trio record files (tree-sitter-trio). Records are the only "type"; tags are
// its members. `.trio` files are routed to TrioParser by the indexer, so these
// mappings only matter for generic AST walks.
const trioMappings: NodeTypeMappings = {
  functionTypes: [],
  classTypes: ['record'],
  interfaceTypes: [],
  variableTypes: ['tag', 'block_tag'],
  importTypes: [],
  exportTypes: [],
  commentTypes: ['comment'],
  callTypes: [],
  nameField: 'name',
  parametersField: 'params',
  bodyField: 'value'
};

const htmlMappings: NodeTypeMappings = {
  functionTypes: [],
  classTypes: [],
  interfaceTypes: [],
  variableTypes: [],
  importTypes: [],
  exportTypes: [],
  commentTypes: ['comment'],
  callTypes: [],
  nameField: 'tag_name',
  parametersField: 'attribute',
  bodyField: 'content'
};

const cssMappings: NodeTypeMappings = {
  functionTypes: [],
  classTypes: ['rule_set'],
  interfaceTypes: [],
  variableTypes: ['declaration'],
  importTypes: ['import_statement'],
  exportTypes: [],
  commentTypes: ['comment'],
  callTypes: ['call_expression'],
  nameField: 'selector',
  parametersField: 'arguments',
  bodyField: 'block'
};

const jsonMappings: NodeTypeMappings = {
  functionTypes: [],
  classTypes: ['object'],
  interfaceTypes: [],
  variableTypes: ['pair'],
  importTypes: [],
  exportTypes: [],
  commentTypes: [],
  callTypes: [],
  nameField: 'key',
  parametersField: '',
  bodyField: 'value'
};

// Vue uses HTML grammar with some extensions
const vueMappings: NodeTypeMappings = {
  functionTypes: ['method_definition'],
  classTypes: ['element'],
  interfaceTypes: [],
  variableTypes: ['attribute'],
  importTypes: [],
  exportTypes: [],
  commentTypes: ['comment'],
  callTypes: [],
  nameField: 'tag_name',
  parametersField: 'attribute',
  bodyField: 'content'
};

// Dart mappings - based on tree-sitter-dart grammar
const dartMappings: NodeTypeMappings = {
  functionTypes: ['function_signature', 'method_signature', 'constructor_signature', 'getter_signature', 'setter_signature'],
  classTypes: ['class_definition'],
  interfaceTypes: ['mixin_declaration', 'extension_declaration'],
  variableTypes: ['initialized_variable_definition', 'static_final_declaration', 'final_const_var_or_type'],
  importTypes: ['import_or_export'],
  exportTypes: ['import_or_export'],
  commentTypes: ['comment', 'documentation_comment'],
  callTypes: ['selector', 'arguments'],
  nameField: 'identifier',
  parametersField: 'formal_parameter_list',
  bodyField: 'function_body'
};

// Polymer mappings - uses HTML grammar with Polymer-specific patterns
// Supports Polymer 0.5 (<polymer-element>) and Polymer 2+ (<dom-module>)
const polymerMappings: NodeTypeMappings = {
  functionTypes: [], // Extracted from embedded <script> tags
  classTypes: ['element'], // Custom elements: <polymer-element>, <dom-module>
  interfaceTypes: [],
  variableTypes: ['attribute'], // Element attributes and properties
  importTypes: [], // <link rel="import"> handled specially
  exportTypes: [],
  commentTypes: ['comment'],
  callTypes: [],
  nameField: 'tag_name',
  parametersField: 'attribute',
  bodyField: 'content'
};

// ============================================
// Default Language Configurations
// ============================================

const defaultLanguageConfigs: Record<SupportedLanguage, Omit<LanguageConfig, 'loaded' | 'language'>> = {
  typescript: {
    id: 'typescript',
    name: 'TypeScript',
    extensions: ['ts', 'tsx', 'mts', 'cts'],
    nodeMappings: typescriptMappings
  },
  javascript: {
    id: 'javascript',
    name: 'JavaScript',
    extensions: ['js', 'jsx', 'mjs', 'cjs'],
    nodeMappings: javascriptMappings
  },
  python: {
    id: 'python',
    name: 'Python',
    extensions: ['py', 'pyw', 'pyi'],
    nodeMappings: pythonMappings
  },
  java: {
    id: 'java',
    name: 'Java',
    extensions: ['java'],
    nodeMappings: javaMappings
  },
  go: {
    id: 'go',
    name: 'Go',
    extensions: ['go'],
    nodeMappings: goMappings
  },
  rust: {
    id: 'rust',
    name: 'Rust',
    extensions: ['rs'],
    nodeMappings: rustMappings
  },
  c: {
    id: 'c',
    name: 'C',
    extensions: ['c', 'h'],
    nodeMappings: cMappings
  },
  cpp: {
    id: 'cpp',
    name: 'C++',
    extensions: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx'],
    nodeMappings: cppMappings
  },
  csharp: {
    id: 'csharp',
    name: 'C#',
    extensions: ['cs'],
    nodeMappings: csharpMappings
  },
  ruby: {
    id: 'ruby',
    name: 'Ruby',
    extensions: ['rb', 'rake', 'gemspec'],
    nodeMappings: rubyMappings
  },
  php: {
    id: 'php',
    name: 'PHP',
    extensions: ['php', 'phtml', 'php3', 'php4', 'php5'],
    nodeMappings: phpMappings
  },
  kotlin: {
    id: 'kotlin',
    name: 'Kotlin',
    extensions: ['kt', 'kts'],
    nodeMappings: kotlinMappings
  },
  swift: {
    id: 'swift',
    name: 'Swift',
    extensions: ['swift'],
    nodeMappings: swiftMappings
  },
  scala: {
    id: 'scala',
    name: 'Scala',
    extensions: ['scala', 'sc'],
    nodeMappings: scalaMappings
  },
  fantom: {
    id: 'fantom',
    name: 'Fantom',
    extensions: ['fan'],
    nodeMappings: fantomMappings
  },
  xeto: {
    id: 'xeto',
    name: 'Xeto',
    extensions: ['xeto'],
    nodeMappings: xetoMappings
  },
  axon: {
    id: 'axon',
    name: 'Axon',
    extensions: ['axon'],
    nodeMappings: axonMappings
  },
  trio: {
    id: 'trio',
    name: 'Trio',
    extensions: ['trio'],
    nodeMappings: trioMappings
  },
  html: {
    id: 'html',
    name: 'HTML',
    extensions: ['html', 'htm', 'xhtml'],
    nodeMappings: htmlMappings
  },
  css: {
    id: 'css',
    name: 'CSS',
    extensions: ['css', 'scss', 'less'],
    nodeMappings: cssMappings
  },
  json: {
    id: 'json',
    name: 'JSON',
    extensions: ['json', 'jsonc', 'json5'],
    nodeMappings: jsonMappings
  },
  vue: {
    id: 'vue',
    name: 'Vue',
    extensions: ['vue'],
    nodeMappings: vueMappings
  },
  dart: {
    id: 'dart',
    name: 'Dart',
    extensions: ['dart'],
    nodeMappings: dartMappings
  },
  polymer: {
    id: 'polymer',
    name: 'Polymer',
    // .html files with Polymer patterns - detection happens at parse time
    // by checking for <polymer-element> (0.5) or <dom-module> (2.0+)
    extensions: [], // Empty - detected by content, not extension
    nodeMappings: polymerMappings
  }
};

// ============================================
// Language Registry Class
// ============================================

export class LanguageRegistry {
  private languages: Map<SupportedLanguage, LanguageConfig> = new Map();
  private extensionMap: Map<string, SupportedLanguage> = new Map();
  private parser: Parser | null = null;
  private initialized = false;
  private grammarsPath: string;

  constructor(grammarsPath?: string) {
    // Default to grammars subdirectory - handle both src and build directories
    const currentDir = dirname(fileURLToPath(import.meta.url));

    if (grammarsPath) {
      this.grammarsPath = grammarsPath;
    } else {
      // Try relative path first (for src directory)
      let grammarDir = resolve(currentDir, 'grammars');

      // If not found, try to find it relative to project root
      if (!existsSync(grammarDir)) {
        // Go up to find src/parser/treeSitter/grammars
        const projectRoot = resolve(currentDir, '..', '..', '..');
        grammarDir = resolve(projectRoot, 'src', 'parser', 'treeSitter', 'grammars');
      }

      this.grammarsPath = grammarDir;
    }

    // Initialize language configs
    for (const [id, config] of Object.entries(defaultLanguageConfigs)) {
      const langConfig: LanguageConfig = {
        ...config,
        loaded: false,
        wasmPath: resolve(this.grammarsPath, `tree-sitter-${id}.wasm`)
      };
      this.languages.set(id as SupportedLanguage, langConfig);

      // Build extension map
      for (const ext of config.extensions) {
        this.extensionMap.set(ext, id as SupportedLanguage);
      }
    }
  }

  /**
   * Initialize web-tree-sitter
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await Parser.init();
      this.parser = new Parser();
      this.initialized = true;
      logger.info('Tree-sitter parser initialized');

      // Log grammar availability
      this.logGrammarStatus();
    } catch (error) {
      logger.error(`Failed to initialize tree-sitter: ${error}`);
      throw error;
    }
  }

  /**
   * Log status of available grammars
   */
  private logGrammarStatus(): void {
    const available = this.getAvailableGrammars();
    const total = this.getSupportedLanguages().length;

    if (available.length === 0) {
      logger.warn('No tree-sitter grammars found! Run "npm run grammars:download" to enable code parsing.');
    } else if (available.length < total) {
      const missing = this.getSupportedLanguages().filter(l => !this.isGrammarAvailable(l));
      logger.info(`Tree-sitter grammars: ${available.length}/${total} available`);
      if (missing.length <= 5) {
        logger.info(`Missing grammars: ${missing.join(', ')}`);
      }
    } else {
      logger.info(`All ${total} tree-sitter grammars available`);
    }
  }

  /**
   * Load a language grammar
   */
  async loadLanguage(languageId: SupportedLanguage): Promise<boolean> {
    const config = this.languages.get(languageId);
    if (!config) {
      logger.warn(`Unknown language: ${languageId}`);
      return false;
    }

    if (config.loaded && config.language) {
      return true;
    }

    if (!this.initialized) {
      await this.initialize();
    }

    if (!config.wasmPath) {
      logger.warn(`No WASM path for language: ${languageId}`);
      return false;
    }

    if (!existsSync(config.wasmPath)) {
      logger.warn(`Grammar not found: ${config.wasmPath}`);
      return false;
    }

    try {
      const language = await Language.load(config.wasmPath);
      config.language = language;
      config.loaded = true;
      logger.info(`Loaded grammar for ${languageId}`);
      return true;
    } catch (error) {
      logger.error(`Failed to load grammar for ${languageId}: ${error}`);
      return false;
    }
  }

  /**
   * Get language configuration
   */
  getLanguage(languageId: SupportedLanguage): LanguageConfig | undefined {
    return this.languages.get(languageId);
  }

  /**
   * Get language by file extension
   */
  getLanguageByExtension(extension: string): SupportedLanguage | undefined {
    // Remove leading dot if present
    const ext = extension.startsWith('.') ? extension.slice(1) : extension;
    return this.extensionMap.get(ext.toLowerCase());
  }

  /**
   * Detect language from file path
   */
  detectLanguage(filePath: string): SupportedLanguage | undefined {
    const ext = filePath.split('.').pop();
    if (!ext) return undefined;
    return this.getLanguageByExtension(ext);
  }

  /**
   * Get the parser instance
   */
  getParser(): Parser | null {
    return this.parser;
  }

  /**
   * Get all supported languages
   */
  getSupportedLanguages(): SupportedLanguage[] {
    return Array.from(this.languages.keys());
  }

  /**
   * Get all loaded languages
   */
  getLoadedLanguages(): SupportedLanguage[] {
    return Array.from(this.languages.entries())
      .filter(([, config]) => config.loaded)
      .map(([id]) => id);
  }

  /**
   * Check if a language grammar is available
   */
  isGrammarAvailable(languageId: SupportedLanguage): boolean {
    const config = this.languages.get(languageId);
    if (!config?.wasmPath) return false;
    return existsSync(config.wasmPath);
  }

  /**
   * Get available grammars (WASM files that exist)
   */
  getAvailableGrammars(): SupportedLanguage[] {
    return this.getSupportedLanguages().filter(lang => this.isGrammarAvailable(lang));
  }

  /**
   * Set custom WASM path for a language
   */
  setWasmPath(languageId: SupportedLanguage, wasmPath: string): void {
    const config = this.languages.get(languageId);
    if (config) {
      config.wasmPath = wasmPath;
      config.loaded = false; // Reset loaded state
      config.language = undefined;
    }
  }

  /**
   * Get grammar directory path
   */
  getGrammarsPath(): string {
    return this.grammarsPath;
  }
}

// ============================================
// Singleton Instance
// ============================================

let registryInstance: LanguageRegistry | null = null;

export function getLanguageRegistry(grammarsPath?: string): LanguageRegistry {
  if (!registryInstance) {
    registryInstance = new LanguageRegistry(grammarsPath);
  }
  return registryInstance;
}

export function resetLanguageRegistry(): void {
  registryInstance = null;
}
