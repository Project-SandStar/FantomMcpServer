/**
 * Local Documentation Parser Module
 *
 * Provides tools for parsing local SkySpark/Fantom HTML documentation
 * per instance with version-specific caching.
 */

// Types
export type {
  LocalDocItem,
  PodInfo,
  ScanResult,
  ParseResult,
  LocalDocParseOptions,
  LocalDocSearchOptions,
  LocalDocSearchResult
} from './types.js';

// Scanner functions
export {
  getDocPath,
  scanDocDirectory,
  listPodFiles,
  getFileType,
  isValidDocDirectory
} from './skysparkDocScanner.js';

// Extractor functions
export {
  extractTypeDoc,
  extractSlots,
  extractAxonFunction,
  extractChapter,
  extractDocFile
} from './docHtmlExtractor.js';

// Main parser functions
export {
  parseInstanceDocs,
  getDocStatus,
  listInstancePods,
  loadCachedDocs,
  clearDocCache,
  clearAllDocCaches,
  searchLocalDocs
} from './localDocsParser.js';
