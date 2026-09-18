/**
 * Fantom Code Module - exports for code parsing, indexing, and search
 */

// Types
export type {
  FantomFunction,
  FantomTypeDef,
  FantomProject,
  PodMeta,
  FantomCodeIndex,
  IndexResult,
  IndexStats,
  ScanOptions,
  ScanResult,
  ParsedFile,
  ParseError,
  CacheData,
  CacheMetadata,
  FunctionSearchOptions,
  FunctionSearchResult,
  Parameter,
  FunctionType,
  TypeDefKind
} from './types.js';

export { FantomCategory } from './types.js';

export {
  generateFunctionId,
  generateTypeId,
  buildQualifiedName,
  parseQualifiedName,
  formatSignature,
  categorizeFunction,
  generateTags,
  compareVersions,
  isVersionCompatible
} from './types.js';

// Scanner
export { FantomFileScanner, createFileScanner } from './scanner.js';

// Parser
export { FantomCodeParser, parseFantomFile, parseFantomFiles } from './codeParser.js';

// Indexer
export {
  FantomCodeIndexer,
  getFantomCodeIndexer,
  resetFantomCodeIndexer
} from './indexer.js';

// Search Index
export {
  FantomFunctionSearchIndex,
  getFantomFunctionSearchIndex,
  resetFantomFunctionSearchIndex
} from './searchIndex.js';

// Haxall Source Indexer
export type {
  HaxallSourceStats,
  PodIndexStats,
  HaxallPodInfo
} from './haxallSourceIndexer.js';

export {
  HaxallSourceIndexer,
  indexHaxallSource,
  discoverHaxallPods,
  indexHaxallPods,
  indexHaxallCategory
} from './haxallSourceIndexer.js';

// Fantom Build Indexer
export type {
  FantomBuildPodInfo,
  PodIndexStats as FantomBuildPodIndexStats
} from './fantomBuildIndexer.js';

export {
  FantomBuildIndexer,
  getFantomBuildIndexer
} from './fantomBuildIndexer.js';

// Code Indexing Service (with graph integration)
export type {
  FullIndexResult,
  IndexingOptions,
  ExtendedProject
} from './codeIndexingService.js';

export {
  CodeIndexingService,
  getCodeIndexingService,
  resetCodeIndexingService
} from './codeIndexingService.js';

// Tree-sitter Adapter (multi-language support)
export {
  TreeSitterCodeParser,
  MultiLanguageScanner,
  createTreeSitterParser,
  createMultiLanguageScanner
} from './treeSitterAdapter.js';

// Call Extractor
export { FantomCallExtractor, extractCalls } from './callExtractor.js';

// FunctionCall type for call graph
export type { FunctionCall } from './types.js';
