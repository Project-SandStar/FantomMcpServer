/**
 * Tree-sitter Parser Module
 *
 * Provides multi-language code parsing using tree-sitter.
 */

// Types
export type {
  SupportedLanguage,
  LanguageConfig,
  NodeTypeMappings,
  ASTLocation,
  ASTNode,
  ExtractedFunction,
  ExtractedParameter,
  ExtractedCall,
  ExtractedClass,
  ExtractedField,
  ExtractedInterface,
  ExtractedImport,
  ExtractedExport,
  ParsedFile,
  ParseError,
  ParseOptions,
  ParserEvents
} from './types.js';

// Language Registry
export {
  LanguageRegistry,
  getLanguageRegistry,
  resetLanguageRegistry
} from './languageRegistry.js';

// AST Extractor
export { ASTExtractor, type ExtractionResult } from './astExtractor.js';

// Main Parser
export {
  TreeSitterParser,
  getTreeSitterParser,
  resetTreeSitterParser
} from './treeSitterParser.js';

// Grammar Downloader
export {
  GrammarDownloader,
  getGrammarDownloader,
  downloadAllGrammars,
  downloadGrammar
} from './grammarDownloader.js';

// Fantom Post-Processor
export {
  FantomPostProcessor,
  getFantomPostProcessor,
  type PostProcessResult
} from './fantomPostProcessor.js';
