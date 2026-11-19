/**
 * Parser / extractor versions for the incremental-indexing hash gate.
 *
 * The gate used to skip a file whenever its mtime+size (or sha) matched the
 * last run, so a parser upgrade (new extraction rules, a rebuilt grammar,
 * markdown support) never reached unchanged files — rows had to be deleted
 * from indexed_files by hand. Each IndexedFile row now records the version
 * string that produced it; a mismatch counts as "modified" and the file is
 * re-parsed. Only the file types whose version changed are re-parsed.
 *
 * Bump rules:
 *   - PARSER_SCHEMA_VERSION: anything that changes symbol ids or the stored
 *     shape for every language (it re-parses every project).
 *   - EXTRACTOR_VERSIONS[x]: an extraction rule change for one family.
 *   - Grammar wasm rebuilt: picked up automatically by the fingerprint.
 *
 * See docs/proposals/lazy-incremental-indexing.md §3.6.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getLanguageRegistry } from '../parser/treeSitter/languageRegistry.js';
import type { SupportedLanguage } from '../parser/treeSitter/types.js';
import { routeFile } from './fileRouter.js';

/** Bump by hand on any change that affects every language. Stored on index_runs.parser_version. */
// 2 = stable symbol keys (3.8): the graph nodes carry symbol_key / body_sha,
// indexed_files carries key_base. Re-parses every project once; a project
// gets the new ids only through the rekey task (fantom_projects.key_scheme).
// Never set back to 1 once a project is re-keyed.
export const PARSER_SCHEMA_VERSION = 2;

/** Per extractor family; bump the one whose rules changed. */
export const EXTRACTOR_VERSIONS = {
  fanRegex: 1,   // FantomCodeParser (.fan, regex fallback)
  fan: 1,        // .fan through the fantom tree-sitter grammar (2026-11-11), pod of the nearest build.fan
  treeSitter: 3, // treeSitterAdapter: 3 = node language by extension, not 'fantom' (2026-11-09)
  vue: 2,        // parseVueFile: 2 = node language 'vue' (2026-11-09)
  markdown: 2,   // parseMarkdownFile: 2 = node language 'markdown' (2026-11-09)
  trio: 2,       // TrioParser: 2 = pod from the nearest build.fan, never 'unknown::' (2026-11-09)
  axon: 1,       // .axon through the axon grammar, with the pod of the nearest build.fan
  skip: 1,       // build.fan: no symbols
  regexOther: 1, // generic regex fallback for languages without a grammar
} as const;

/** Grammars a file of this extension is parsed with (tree-sitter path only). */
const GRAMMARS_FOR_EXT: Record<string, SupportedLanguage[]> = {
  vue: ['vue', 'typescript', 'javascript', 'css'], // script/style blocks re-parse with their own grammar
  trio: ['trio', 'axon'],
};

const fingerprintCache = new Map<string, string>();

/**
 * Short hash of the grammar wasm files (name + size + mtime) for these
 * languages. Cached for the process lifetime: grammars change only on a
 * rebuild, which also restarts the dev server. Missing wasm → "none".
 */
function grammarFingerprint(langs: SupportedLanguage[]): string {
  const key = langs.join(',');
  const hit = fingerprintCache.get(key);
  if (hit) return hit;
  let dir: string;
  try { dir = getLanguageRegistry().getGrammarsPath(); } catch { return 'none'; }
  const h = createHash('sha256');
  let any = false;
  for (const lang of langs) {
    const file = path.join(dir, `tree-sitter-${lang}.wasm`);
    try {
      const st = fs.statSync(file);
      h.update(`${lang}:${st.size}:${Math.floor(st.mtimeMs)};`);
      any = true;
    } catch {
      h.update(`${lang}:missing;`);
    }
  }
  const fp = any ? h.digest('hex').slice(0, 8) : 'none';
  fingerprintCache.set(key, fp);
  return fp;
}

/** Test hook: forget cached fingerprints. */
export function resetGrammarFingerprints(): void {
  fingerprintCache.clear();
}

/**
 * Version of the code that extracts symbols from `filePath` under the given
 * project parser type. The parser family comes from the same router the
 * dispatch sites use (src/fantom-code/fileRouter.ts), so the two cannot
 * drift. Fantom-family files (.fan, .trio, .axon) have the same family under
 * every project language and parser type.
 */
export function extractorVersionFor(filePath: string, parserType: string): string {
  const route = routeFile(filePath);
  const treeSitter = parserType === 'tree-sitter-wasm' || parserType === 'tree-sitter';
  switch (route.kind) {
    case 'skip': return `skip:${EXTRACTOR_VERSIONS.skip}`;
    case 'fan': return `fan:${EXTRACTOR_VERSIONS.fan}:${grammarFingerprint(['fantom'])}`;
    case 'trio': return `trio:${EXTRACTOR_VERSIONS.trio}:${grammarFingerprint(GRAMMARS_FOR_EXT.trio)}`;
    case 'axon': return `axon:${EXTRACTOR_VERSIONS.axon}:${grammarFingerprint(['axon'])}`;
  }
  if (!treeSitter) return `fan-regex:${EXTRACTOR_VERSIONS.fanRegex}`;
  if (route.kind === 'markdown') return `md:${EXTRACTOR_VERSIONS.markdown}`;
  if (route.kind === 'vue') {
    return `vue:${EXTRACTOR_VERSIONS.vue}:${EXTRACTOR_VERSIONS.treeSitter}:${grammarFingerprint(GRAMMARS_FOR_EXT.vue)}`;
  }
  if (route.language === 'unknown') return `regex:${EXTRACTOR_VERSIONS.regexOther}`;
  const lang = route.language as SupportedLanguage;
  return `ts:${EXTRACTOR_VERSIONS.treeSitter}:${lang}:${grammarFingerprint([lang])}`;
}

/** Value stored in indexed_files.index_version and compared by the hash gate. */
export function indexVersionFor(filePath: string, parserType: string): string {
  return `${PARSER_SCHEMA_VERSION}:${parserType}:${extractorVersionFor(filePath, parserType)}`;
}
