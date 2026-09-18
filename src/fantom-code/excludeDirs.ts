/**
 * Single source of truth for directories the source-code scanners skip.
 * Used by both FantomFileScanner (scanner.ts) and MultiLanguageScanner
 * (treeSitterAdapter.ts) so they stay in lockstep.
 *
 * Match is by directory ENTRY NAME, not full path. To exclude based on
 * path patterns (e.g. "**​/generated/**") use .gitignore parsing —
 * supported via the `ignore` package, see loadGitignore() below.
 */

import * as fs from 'fs';
import * as path from 'path';
import ignore from 'ignore';

export const DEFAULT_EXCLUDE_DIRS: ReadonlySet<string> = new Set([
  // VCS
  '.git', '.svn', '.hg',
  // Editors
  '.idea', '.vscode',
  // OS junk
  '.DS_Store',
  // JS/TS package managers + build outputs
  'node_modules', 'dist', 'build', 'out', '.output', '.next', '.nuxt',
  '.cache', 'coverage', '.turbo', '.parcel-cache', '.svelte-kit',
  // NOTE: 'lib' is intentionally NOT excluded — Next.js / Nuxt / and most
  // monorepos use 'src/lib' as a source directory. If a project actually
  // ships a 'lib/' bundler output, list it in the project's .gitignore.
  // Python
  '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', 'venv', '.venv',
  // JVM
  'target', '.gradle',
  // Rust
  // 'target' already covered above
  // Misc
  'tmp', 'temp', '.tmp',
]);

/**
 * Load a .gitignore file from a project root (if it exists) and return a
 * matcher function `(absPath) => boolean`. The matcher returns true when
 * the path is gitignored.
 *
 * Returns null when the project has no .gitignore — caller should treat
 * that as "match nothing" (no exclusions beyond DEFAULT_EXCLUDE_DIRS).
 *
 * Uses the `ignore` package which implements full gitignore semantics
 * (negations, directory-only rules, **​ globs).
 */
export async function loadGitignore(
  projectRoot: string,
): Promise<((absPath: string) => boolean) | null> {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  if (!fs.existsSync(gitignorePath)) return null;

  let content: string;
  try {
    content = fs.readFileSync(gitignorePath, 'utf-8');
  } catch {
    return null;
  }

  const ig = ignore().add(content);
  return (absPath: string) => {
    // Convert to project-relative path; gitignore is rooted there.
    let rel = path.relative(projectRoot, absPath);
    if (!rel || rel.startsWith('..')) return false;
    // ignore expects POSIX-style separators
    rel = rel.split(path.sep).join('/');
    if (!rel) return false;
    return ig.ignores(rel);
  };
}
