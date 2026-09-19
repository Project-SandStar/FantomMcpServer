/**
 * Grammar Downloader
 *
 * Downloads pre-built tree-sitter WASM grammar files.
 * Uses tree-sitter grammars from npm packages or GitHub releases.
 */

import { createLogger } from '../../utils/index.js';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { SupportedLanguage } from './types.js';

const logger = createLogger('grammar-downloader');

// ============================================
// Grammar Sources
// ============================================

interface GrammarSource {
  /** NPM package containing WASM */
  npmPackage?: string;
  /** Direct URL to WASM file */
  url?: string;
  /** GitHub repo (owner/repo) */
  github?: string;
  /** Filename in the package/release */
  filename: string;
}

/**
 * Grammar sources for each language
 * Using tree-sitter-grammars from emscripten-forge CDN and other reliable sources
 */
const grammarSources: Record<SupportedLanguage, GrammarSource> = {
  typescript: {
    url: 'https://cdn.jsdelivr.net/npm/tree-sitter-typescript@0.23.2/tree-sitter-typescript.wasm',
    filename: 'tree-sitter-typescript.wasm'
  },
  javascript: {
    url: 'https://cdn.jsdelivr.net/npm/tree-sitter-javascript@0.23.1/tree-sitter-javascript.wasm',
    filename: 'tree-sitter-javascript.wasm'
  },
  python: {
    url: 'https://cdn.jsdelivr.net/npm/tree-sitter-python@0.23.6/tree-sitter-python.wasm',
    filename: 'tree-sitter-python.wasm'
  },
  java: {
    url: 'https://cdn.jsdelivr.net/npm/tree-sitter-java@0.23.5/tree-sitter-java.wasm',
    filename: 'tree-sitter-java.wasm'
  },
  go: {
    url: 'https://cdn.jsdelivr.net/npm/tree-sitter-go@0.23.4/tree-sitter-go.wasm',
    filename: 'tree-sitter-go.wasm'
  },
  rust: {
    url: 'https://cdn.jsdelivr.net/npm/tree-sitter-rust@0.23.2/tree-sitter-rust.wasm',
    filename: 'tree-sitter-rust.wasm'
  },
  c: {
    url: 'https://cdn.jsdelivr.net/npm/tree-sitter-c@0.23.4/tree-sitter-c.wasm',
    filename: 'tree-sitter-c.wasm'
  },
  cpp: {
    url: 'https://cdn.jsdelivr.net/npm/tree-sitter-cpp@0.23.4/tree-sitter-cpp.wasm',
    filename: 'tree-sitter-cpp.wasm'
  },
  csharp: {
    url: 'https://cdn.jsdelivr.net/npm/tree-sitter-c-sharp@0.23.1/tree-sitter-c_sharp.wasm',
    filename: 'tree-sitter-csharp.wasm'
  },
  ruby: {
    url: 'https://cdn.jsdelivr.net/npm/tree-sitter-ruby@0.23.1/tree-sitter-ruby.wasm',
    filename: 'tree-sitter-ruby.wasm'
  },
  php: {
    url: 'https://cdn.jsdelivr.net/npm/tree-sitter-php@0.23.11/tree-sitter-php.wasm',
    filename: 'tree-sitter-php.wasm'
  },
  kotlin: {
    url: 'https://cdn.jsdelivr.net/npm/@tree-sitter-grammars/tree-sitter-kotlin@1.1.0/tree-sitter-kotlin.wasm',
    filename: 'tree-sitter-kotlin.wasm'
  },
  swift: {
    // Swift WASM not readily available from npm - needs manual build
    filename: 'tree-sitter-swift.wasm'
  },
  scala: {
    url: 'https://cdn.jsdelivr.net/npm/tree-sitter-scala@0.23.4/tree-sitter-scala.wasm',
    filename: 'tree-sitter-scala.wasm'
  },
  fantom: {
    // Fantom uses our custom tree-sitter-fantom grammar
    // WASM needs to be built with: cd tree-sitter-fantom && npx tree-sitter build --wasm
    filename: 'tree-sitter-fantom.wasm'
  },
  xeto: {
    // Xeto uses our custom tree-sitter-xeto grammar
    // WASM needs to be built with: cd tree-sitter-xeto && npx tree-sitter build --wasm
    filename: 'tree-sitter-xeto.wasm'
  },
  axon: {
    // Axon uses our custom tree-sitter-axon grammar
    // WASM needs to be built with: cd tree-sitter-axon && npx tree-sitter build --wasm
    filename: 'tree-sitter-axon.wasm'
  },
  trio: {
    // Trio uses our custom tree-sitter-trio grammar
    // WASM needs to be built with: cd tree-sitter-trio && npx tree-sitter build --wasm
    filename: 'tree-sitter-trio.wasm'
  },
  html: {
    url: 'https://cdn.jsdelivr.net/npm/tree-sitter-html@0.23.2/tree-sitter-html.wasm',
    filename: 'tree-sitter-html.wasm'
  },
  css: {
    url: 'https://cdn.jsdelivr.net/npm/tree-sitter-css@0.23.1/tree-sitter-css.wasm',
    filename: 'tree-sitter-css.wasm'
  },
  json: {
    url: 'https://cdn.jsdelivr.net/npm/tree-sitter-json@0.24.8/tree-sitter-json.wasm',
    filename: 'tree-sitter-json.wasm'
  },
  vue: {
    // Vue uses HTML grammar - will use HTML parser for .vue files
    url: 'https://cdn.jsdelivr.net/npm/tree-sitter-html@0.23.2/tree-sitter-html.wasm',
    filename: 'tree-sitter-vue.wasm'
  },
  dart: {
    // Dart grammar from tree-sitter-dart - WASM needs to be built manually
    // cd /tmp/tree-sitter-dart && tree-sitter build --wasm
    filename: 'tree-sitter-dart.wasm'
  },
  polymer: {
    // Polymer uses HTML grammar - no dedicated tree-sitter grammar exists
    // Polymer 0.5 uses <polymer-element>, Polymer 2+ uses <dom-module>
    // Content detection at parse time determines if file is Polymer
    url: 'https://cdn.jsdelivr.net/npm/tree-sitter-html@0.23.2/tree-sitter-html.wasm',
    filename: 'tree-sitter-polymer.wasm'
  }
};

// Backup sources (GitHub releases)
const alternativeSources: Partial<Record<SupportedLanguage, string>> = {
  // These serve as fallbacks if CDN versions fail
};

// ============================================
// Grammar Downloader Class
// ============================================

export class GrammarDownloader {
  private grammarsPath: string;

  constructor(grammarsPath?: string) {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    this.grammarsPath = grammarsPath || resolve(currentDir, 'grammars');

    // Ensure grammars directory exists
    if (!existsSync(this.grammarsPath)) {
      mkdirSync(this.grammarsPath, { recursive: true });
    }
  }

  /**
   * Download a grammar for a specific language
   */
  async downloadGrammar(language: SupportedLanguage): Promise<boolean> {
    const source = grammarSources[language];
    if (!source) {
      logger.warn(`No grammar source defined for ${language}`);
      return false;
    }

    const targetPath = resolve(this.grammarsPath, `tree-sitter-${language}.wasm`);

    // Skip if already exists
    if (existsSync(targetPath)) {
      logger.info(`Grammar already exists: ${language}`);
      return true;
    }

    // Try primary source
    let url = source.url;

    // Build GitHub raw URL if github is specified
    if (!url && source.github) {
      url = `https://raw.githubusercontent.com/${source.github}/main/${source.filename}`;
    }

    if (url) {
      const success = await this.downloadFile(url, targetPath);
      if (success) return true;
    }

    // Try alternative source
    const altUrl = alternativeSources[language];
    if (altUrl) {
      logger.info(`Trying alternative source for ${language}`);
      return await this.downloadFile(altUrl, targetPath);
    }

    logger.error(`Failed to download grammar for ${language}`);
    return false;
  }

  /**
   * Download all available grammars
   */
  async downloadAll(languages?: SupportedLanguage[]): Promise<Map<SupportedLanguage, boolean>> {
    const results = new Map<SupportedLanguage, boolean>();
    const toDownload = languages || (Object.keys(grammarSources) as SupportedLanguage[]);

    for (const lang of toDownload) {
      // Skip fantom, xeto, axon, and trio - use custom local grammars
      if (lang === 'fantom' || lang === 'xeto' || lang === 'axon' || lang === 'trio') {
        results.set(lang, false);
        continue;
      }

      const success = await this.downloadGrammar(lang);
      results.set(lang, success);
    }

    return results;
  }

  /**
   * Download file from URL
   */
  private async downloadFile(url: string, targetPath: string): Promise<boolean> {
    logger.info(`Downloading: ${url}`);

    try {
      const response = await fetch(url);

      if (!response.ok) {
        logger.warn(`Download failed: ${response.status} ${response.statusText}`);
        return false;
      }

      const buffer = await response.arrayBuffer();
      writeFileSync(targetPath, Buffer.from(buffer));

      logger.info(`Downloaded to: ${targetPath}`);
      return true;
    } catch (error) {
      logger.error(`Download error: ${error}`);
      return false;
    }
  }

  /**
   * Check which grammars are available locally
   */
  getAvailableGrammars(): SupportedLanguage[] {
    const available: SupportedLanguage[] = [];

    for (const lang of Object.keys(grammarSources) as SupportedLanguage[]) {
      const path = resolve(this.grammarsPath, `tree-sitter-${lang}.wasm`);
      if (existsSync(path)) {
        available.push(lang);
      }
    }

    return available;
  }

  /**
   * Check which grammars are missing
   */
  getMissingGrammars(): SupportedLanguage[] {
    const missing: SupportedLanguage[] = [];

    for (const lang of Object.keys(grammarSources) as SupportedLanguage[]) {
      if (lang === 'fantom' || lang === 'xeto' || lang === 'axon' || lang === 'trio') continue; // Skip custom grammars
      const path = resolve(this.grammarsPath, `tree-sitter-${lang}.wasm`);
      if (!existsSync(path)) {
        missing.push(lang);
      }
    }

    return missing;
  }

  /**
   * Get grammars directory path
   */
  getGrammarsPath(): string {
    return this.grammarsPath;
  }
}

// ============================================
// Convenience Functions
// ============================================

let downloaderInstance: GrammarDownloader | null = null;

export function getGrammarDownloader(grammarsPath?: string): GrammarDownloader {
  if (!downloaderInstance) {
    downloaderInstance = new GrammarDownloader(grammarsPath);
  }
  return downloaderInstance;
}

/**
 * Download grammar for a specific language
 */
export async function downloadGrammar(
  language: SupportedLanguage,
  grammarsPath?: string
): Promise<boolean> {
  const downloader = getGrammarDownloader(grammarsPath);
  return downloader.downloadGrammar(language);
}

/**
 * Download all grammars
 */
export async function downloadAllGrammars(
  languages?: SupportedLanguage[],
  grammarsPath?: string
): Promise<Map<SupportedLanguage, boolean>> {
  const downloader = getGrammarDownloader(grammarsPath);
  return downloader.downloadAll(languages);
}
