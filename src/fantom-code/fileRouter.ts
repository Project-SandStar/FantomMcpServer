/**
 * One table that decides, per file, which parser family reads it and which
 * language its graph nodes carry. Every dispatch site (indexProject,
 * reindexFiles, rebuildGraph), the hash gate (indexVersion.ts) and the graph
 * builder call this, so routing and re-parse decisions cannot drift apart.
 *
 * The project's `language` stays the primary-language hint for the
 * tree-sitter parser. Fantom-family files (.fan, .trio, .axon) always go to
 * their own parsers, whatever the project language is. A mixed Vue/TS repo
 * that holds Fantom pods is one project.
 *
 * See docs/proposals/mixed-language-projects.md §3.1.
 */

import * as path from 'path';
import { getLanguageRegistry } from '../parser/treeSitter/languageRegistry.js';
import type { SupportedLanguage } from '../parser/treeSitter/types.js';

export type ParserKind =
  /** build.fan: pod metadata, not a source file. Yields no symbols. */
  | 'skip'
  /**
   * .fan → fantom tree-sitter when the grammar loads, else FantomCodeParser
   * (regex). Switched from regex-only on 2026-11-11 once the grammar parsed
   * 100% of the corpus clean (tree-sitter-fantom/CORPUS.md).
   */
  | 'fan'
  /** .trio → TrioParser (axon tree-sitter for `src:` blocks when available). */
  | 'trio'
  /** .axon → axon tree-sitter when the grammar loads, else the regex parser. */
  | 'axon'
  /** .vue → the primary tree-sitter parser's Vue splitter. */
  | 'vue'
  /** .md/.mdx → the primary tree-sitter parser's markdown sections. */
  | 'markdown'
  /** Everything else → the project's primary tree-sitter parser, else regex. */
  | 'primary';

export interface FileRoute {
  kind: ParserKind;
  /** Language stored on graph nodes; same-language call resolution uses it. */
  language: string;
  /** Lower-case extension without the dot ('' when none). */
  ext: string;
}

export const BUILD_FILE = 'build.fan';

export function isBuildFile(filePath: string): boolean {
  return path.basename(filePath) === BUILD_FILE;
}

export function routeFile(filePath: string): FileRoute {
  const base = path.basename(filePath);
  const ext = path.extname(base).slice(1).toLowerCase();
  if (base === BUILD_FILE) return { kind: 'skip', language: 'fantom', ext };
  switch (ext) {
    case 'fan': return { kind: 'fan', language: 'fantom', ext };
    case 'trio': return { kind: 'trio', language: 'axon', ext };
    case 'axon': return { kind: 'axon', language: 'axon', ext };
    case 'vue': return { kind: 'vue', language: 'vue', ext };
    case 'md':
    case 'mdx': return { kind: 'markdown', language: 'markdown', ext };
  }
  let lang: SupportedLanguage | undefined;
  try { lang = getLanguageRegistry().getLanguageByExtension(ext); } catch { lang = undefined; }
  return { kind: 'primary', language: lang ?? 'unknown', ext };
}
