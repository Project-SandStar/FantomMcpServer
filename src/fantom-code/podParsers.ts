/**
 * Pod map and per-pod parser set.
 *
 * A repo can hold more than one Fantom pod (`pod/vizExt/build.fan`,
 * `pod/other/build.fan`) next to TypeScript and Vue code. Each `.fan`,
 * `.trio` and `.axon` file gets the pod of the nearest `build.fan` above it,
 * so `pod/vizExt/fan/VizExt.fan` yields `bassgViz::VizExt.vizCommit` and not
 * `<project name>::VizExt.vizCommit`. Files outside every pod dir get
 * `rootMeta` (the root build.fan, or the project row's pod name, or the
 * project name). The fallback is always a real object: with `podMeta`
 * undefined the regex parser drops the `::` prefix.
 *
 * One parser instance per (pod name, parser family), created on first use.
 * The three dispatch sites in codeIndexingService (indexProject,
 * reindexFiles, rebuildGraph) all parse through `PodParserSet.parse`, which
 * applies the router (fileRouter.ts) and the pod map.
 *
 * See docs/proposals/mixed-language-projects.md §3.2.
 */

import * as path from 'path';
import { createLogger } from '../utils/index.js';
import { FantomFileScanner } from './scanner.js';
import { FantomCodeParser } from './codeParser.js';
import { TrioParser } from './trioParser.js';
import { createTreeSitterParser, type TreeSitterCodeParser } from './treeSitterAdapter.js';
import { isBuildFile, routeFile } from './fileRouter.js';
import type { ParsedFile, PodMeta } from './types.js';

const logger = createLogger('PodParsers');

/** `Map<absolute pod dir, PodMeta>` from every build.fan under the project (depth ≤ 5). */
export async function buildPodMap(
  projectPath: string,
  scanner: FantomFileScanner = new FantomFileScanner(),
): Promise<Map<string, PodMeta>> {
  const map = new Map<string, PodMeta>();
  let buildFiles: string[] = [];
  try {
    buildFiles = await scanner.findBuildFiles(path.resolve(projectPath));
  } catch (err) {
    logger.warn(`findBuildFiles failed for ${projectPath}: ${err instanceof Error ? err.message : String(err)}`);
    return map;
  }
  for (const bf of buildFiles) {
    try {
      map.set(path.dirname(path.resolve(bf)), scanner.parseBasicBuildFan(bf));
    } catch (err) {
      logger.warn(`Failed to parse ${bf}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return map;
}

/** Pod of the longest directory prefix of `filePath`, else `fallback`. */
export function podForPath(filePath: string, podMap: Map<string, PodMeta>, fallback: PodMeta): PodMeta {
  const abs = path.resolve(filePath);
  let best: PodMeta | undefined;
  let bestLen = -1;
  for (const [dir, meta] of podMap) {
    if (dir.length > bestLen && abs.startsWith(dir + path.sep)) {
      best = meta;
      bestLen = dir.length;
    }
  }
  return best ?? fallback;
}

/** Root pod for files outside every build.fan directory. */
export function rootPodMeta(rootMeta: PodMeta | undefined, podName: string | null | undefined, projectName: string): PodMeta {
  if (rootMeta?.podName) return rootMeta;
  return { podName: podName || projectName, dependencies: [], srcDirs: ['fan'] };
}

/**
 * A changed, added or removed `build.fan` renames every symbol in its pod, so
 * the change list grows to every source file under that directory (the
 * project scanner decides what a source file is). Other paths pass through.
 */
export async function expandBuildFanPaths(
  paths: string[],
  scanner: { scanDirectory(dir: string): Promise<{ files: string[] }> },
): Promise<string[]> {
  const out = new Set<string>(paths);
  for (const p of paths) {
    if (!isBuildFile(p)) continue;
    const dir = path.dirname(p);
    try {
      const { files } = await scanner.scanDirectory(dir);
      for (const f of files) out.add(f);
    } catch (err) {
      logger.warn(`expandBuildFanPaths: scan of ${dir} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return [...out];
}

export function emptyParsedFile(filePath: string): ParsedFile {
  return { filePath, types: [], functions: [], imports: [], usings: [], errors: [] };
}

export interface PodParserSetOptions {
  projectId: number;
  /** Pod for files that are under no build.fan directory. */
  rootMeta: PodMeta;
  podMap: Map<string, PodMeta>;
  /**
   * The project's primary tree-sitter parser (TypeScript, Vue, PHP, ...),
   * already initialized, or null when tree-sitter is off or failed to load.
   * Receives every file the router marks `primary`, `vue` or `markdown`.
   */
  primary: TreeSitterCodeParser | null;
}

export class PodParserSet {
  private readonly regex = new Map<string, FantomCodeParser>();
  private readonly trio = new Map<string, TrioParser>();
  private readonly axon = new Map<string, TreeSitterCodeParser | null>();
  private readonly fan = new Map<string, TreeSitterCodeParser | null>();
  /** False once the axon grammar failed to load; later pods skip the attempt. */
  private axonGrammar = true;
  /** False once the fantom grammar failed to load; .fan then uses regex. */
  private fanGrammar = true;

  constructor(private readonly o: PodParserSetOptions) {}

  podFor(filePath: string): PodMeta {
    return podForPath(filePath, this.o.podMap, this.o.rootMeta);
  }

  /** Distinct pod names seen in the map plus the root pod (for logs and tests). */
  podNames(): string[] {
    const names = new Set<string>([this.o.rootMeta.podName]);
    for (const m of this.o.podMap.values()) names.add(m.podName);
    return [...names];
  }

  async parse(filePath: string): Promise<ParsedFile> {
    const route = routeFile(filePath);
    const pod = this.podFor(filePath);
    switch (route.kind) {
      case 'skip':
        return emptyParsedFile(filePath);
      case 'fan': {
        const ts = await this.fanFor(pod);
        return ts ? ts.parseFile(filePath) : this.regexFor(pod).parseFile(filePath);
      }
      case 'trio':
        return (await this.trioFor(pod)).parseFile(filePath);
      case 'axon': {
        const ts = await this.axonFor(pod);
        return ts ? ts.parseFile(filePath) : this.regexFor(pod).parseFile(filePath);
      }
      default:
        return this.o.primary ? this.o.primary.parseFile(filePath) : this.regexFor(pod).parseFile(filePath);
    }
  }

  private regexFor(pod: PodMeta): FantomCodeParser {
    let p = this.regex.get(pod.podName);
    if (!p) {
      p = new FantomCodeParser(this.o.projectId, pod);
      this.regex.set(pod.podName, p);
    }
    return p;
  }

  private async trioFor(pod: PodMeta): Promise<TrioParser> {
    let p = this.trio.get(pod.podName);
    if (!p) {
      p = new TrioParser(this.o.projectId, pod.podName, await this.axonFor(pod));
      this.trio.set(pod.podName, p);
    }
    return p;
  }

  private async fanFor(pod: PodMeta): Promise<TreeSitterCodeParser | null> {
    if (!this.fanGrammar) return null;
    if (this.fan.has(pod.podName)) return this.fan.get(pod.podName) ?? null;
    let parser: TreeSitterCodeParser | null = null;
    try {
      const p = createTreeSitterParser(this.o.projectId, 'fantom', pod.podName);
      if (await p.initialize()) parser = p;
    } catch {
      parser = null;
    }
    if (!parser) {
      this.fanGrammar = false;
      logger.warn('Tree-sitter fantom grammar not available; .fan files use the regex parser');
    }
    this.fan.set(pod.podName, parser);
    return parser;
  }

  private async axonFor(pod: PodMeta): Promise<TreeSitterCodeParser | null> {
    if (!this.axonGrammar) return null;
    if (this.axon.has(pod.podName)) return this.axon.get(pod.podName) ?? null;
    let parser: TreeSitterCodeParser | null = null;
    try {
      const p = createTreeSitterParser(this.o.projectId, 'axon', pod.podName);
      if (await p.initialize()) parser = p;
    } catch {
      parser = null;
    }
    if (!parser) {
      this.axonGrammar = false;
      logger.debug('Tree-sitter axon not available; .axon and trio src blocks use the regex path');
    }
    this.axon.set(pod.podName, parser);
    return parser;
  }
}
