/**
 * Code Indexing Service - Coordinates code parsing, indexing, and graph building
 *
 * This service provides a unified interface for:
 * - In-memory code indexing (FantomCodeIndexer)
 * - Graph building (GraphBuilder)
 * - Combined operations with proper error handling
 */

import type { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import * as fsp from 'fs/promises';
import { createLogger } from '../utils/index.js';
import { FantomCodeIndexer, getFantomCodeIndexer } from './indexer.js';
import { FantomFileScanner } from './scanner.js';
import { FantomCodeParser } from './codeParser.js';
import { buildLadybugGraph } from '../graph/ladybugGraphBuilder.js';
import { ladybugQuery } from '../graph/ladybugConnection.js';
import { clearFileGraph } from '../graph/ladybugSchema.js';
import {
  TreeSitterCodeParser,
  createTreeSitterParser,
  createMultiLanguageScanner
} from './treeSitterAdapter.js';
import { TrioParser } from './trioParser.js';
import type { SupportedLanguage } from '../parser/treeSitter/types.js';
import type {
  FantomProject,
  IndexResult,
  ParsedFile,
  ParseError,
  PodMeta
} from './types.js';
import type { GraphBuildResult } from '../graph/types.js';

const logger = createLogger('code-indexing-service');

// ============================================
// Combined Result Types
// ============================================

export interface FullIndexResult extends IndexResult {
  graphResult?: GraphBuildResult;
  /** Surfaces when files.length === 0 — explains likely cause. */
  hint?: string;
  diagnostic?: {
    projectPath: string;
    language: string;
    parserType: string;
    scannerKind: 'fantom' | 'multi-language';
  };
  /** True when the hash-gate found no file changes and skipped re-parse.
   * Callers (runIndex) use this to suppress stats updates that would
   * otherwise overwrite Prisma counts with 0/0. */
  noChange?: boolean;
}

export interface IndexingOptions {
  buildGraph?: boolean;      // Whether to build the code graph (default: true)
  skipInMemory?: boolean;    // Skip in-memory indexing (default: false)
  resolveRefs?: boolean;     // Resolve references across projects (default: false)
  forceParser?: 'regex' | 'tree-sitter';  // Override parser selection
  // Incremental indexing controls (v1)
  force?: boolean;           // Skip the file-hash gate and rebuild fully (default: false)
  trigger?: 'manual' | 'auto' | 'watch' | 'mcp' | 'mcp-add' | 'mcp-refresh' | 'mcp-incremental' | 'admin-reindex' | 'file-watch'; // Recorded on the IndexRun row
  buildEmbeddings?: boolean; // Auto-embed LanceDB vectors after parse (default: true via runIndex)
  allowRegexFallback?: boolean; // For non-Fantom languages, opt in to degraded indexing if tree-sitter init fails (default: false — error instead).
}

// Extended project type with multi-language support
export interface ExtendedProject extends FantomProject {
  language?: string;         // fantom, typescript, javascript, python, etc.
  parserType?: string;       // regex, tree-sitter-wasm
}

// ============================================
// Code Indexing Service
// ============================================

export class CodeIndexingService {
  private prisma: PrismaClient;
  private indexer: FantomCodeIndexer;
  // Per-project mutex. Serializes indexProject + reindexFiles calls so an
  // in-flight rebuild can't trample concurrent writes.
  private projectLocks = new Map<number, Promise<unknown>>();

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    this.indexer = getFantomCodeIndexer();
  }

  private async withProjectLock<T>(projectId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.projectLocks.get(projectId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Swallow rejections from the chained promise so subsequent waiters don't inherit it.
    this.projectLocks.set(projectId, next.catch(() => undefined));
    return next as Promise<T>;
  }

  /**
   * Repopulate the in-memory FantomCodeIndexer for a project from the
   * LadybugDB authoritative graph. Used on stale-check short-circuit so
   * FlexSearch (which rebuilds from the indexer) doesn't lose visibility
   * of symbols just because no files changed since the last process boot.
   */
  async hydrateIndexerFromLadybug(project: ExtendedProject): Promise<number> {
    const rows = await ladybugQuery<{
      id: string; name: string; qn: string; nt: string; fp: string;
      ls: number; le: number; sig: string | null; doc: string | null;
      pt: string | null; pub: boolean; stat: boolean; abs: boolean;
    }>(project.id,
      `MATCH (n:CodeNode)
       RETURN n.id AS id, n.name AS name, n.qualified_name AS qn,
              n.node_type AS nt, n.file_path AS fp,
              n.line_start AS ls, n.line_end AS le,
              n.signature AS sig, n.documentation AS doc,
              n.parent_type AS pt, n.is_public AS pub,
              n.is_static AS stat, n.is_abstract AS abs`,
    );
    if (rows.length === 0) return 0;

    this.indexer.clearProject(project.id);
    this.indexer.registerProject(project);

    const typeKinds = new Set(['class', 'interface', 'mixin', 'enum', 'struct']);
    let typeCount = 0;
    let fnCount = 0;

    for (const r of rows) {
      const isType = typeKinds.has(r.nt);
      if (isType) {
        // Reconstruct a minimal FantomTypeDef. The indexer only needs name,
        // qualifiedName, kind, projectId, filePath for search; methods are
        // listed as separate function nodes.
        this.indexer.addType({
          id: r.id,
          projectId: project.id,
          name: r.name,
          qualifiedName: r.qn,
          kind: r.nt as any,
          filePath: r.fp,
          lineNumber: Number(r.ls) || 1,
          documentation: r.doc || undefined,
          isPublic: Boolean(r.pub),
          isAbstract: Boolean(r.abs),
          isFinal: false,
          methods: [],
          fields: [],
          mixins: [],
          facets: [],
        } as any);
        typeCount++;
      } else {
        this.indexer.addFunction({
          id: r.id,
          projectId: project.id,
          name: r.name,
          qualifiedName: r.qn,
          type: (r.nt || 'method') as any,
          signature: r.sig || '',
          parameters: [],
          returnType: '',
          documentation: r.doc || undefined,
          filePath: r.fp,
          lineNumber: Number(r.ls) || 1,
          className: r.pt || undefined,
          isPublic: Boolean(r.pub),
          isStatic: Boolean(r.stat),
          isAbstract: Boolean(r.abs),
          isVirtual: false,
          isOverride: false,
          facets: [],
          tags: [],
          category: 'general',
          calls: [],
        } as any);
        fnCount++;
      }
    }
    logger.info(
      `[hydrate] in-memory indexer for ${project.name}: +${fnCount} fns, +${typeCount} types from LadybugDB`,
    );
    return rows.length;
  }

  /**
   * Index a project with both in-memory index and graph building
   */
  async indexProject(
    project: FantomProject | ExtendedProject,
    options: IndexingOptions = {}
  ): Promise<FullIndexResult> {
    const { buildGraph = true, skipInMemory = false, forceParser, force = false, trigger = 'manual' } = options;
    const startTime = Date.now();
    const startedAt = new Date(startTime);
    const errors: ParseError[] = [];
    let functionsIndexed = 0;
    let typesIndexed = 0;
    let filesProcessed = 0;
    const parsedFiles: ParsedFile[] = [];

    // Detect language and parser type
    const extProject = project as ExtendedProject;
    const language = (extProject.language || 'fantom') as SupportedLanguage;
    let parserType = forceParser || extProject.parserType || 'regex';

    // Runtime guard: regex parser only handles Fantom syntax. Auto-promote to
    // tree-sitter-wasm for any non-Fantom language so the assistant doesn't
    // get garbage signatures (e.g. TypeScript parsed by the .fan regex
    // produces nonsense like "await writeChunk(Write final, boundary await…)").
    const langForGuard = language as string;
    const isFanLikeForGuard = langForGuard === 'fantom' || langForGuard === 'trio' || langForGuard === 'axon';
    if (!isFanLikeForGuard && parserType === 'regex') {
      // Only auto-promote when a grammar is actually loadable. Otherwise we
      // lock the project into tree-sitter-wasm even though the wasm is
      // missing, which makes Reindex appear to do nothing for that pod.
      let grammarAvailable = false;
      try {
        const { getLanguageRegistry } = await import('../parser/treeSitter/languageRegistry.js');
        grammarAvailable = getLanguageRegistry().isGrammarAvailable(language as SupportedLanguage);
      } catch { /* probe failure → treat as unavailable */ }
      if (grammarAvailable) {
        logger.warn(
          `Project ${project.name} has parserType='regex' on language='${language}'. ` +
          `Auto-correcting to 'tree-sitter-wasm' for this run. ` +
          `Run scripts/backfill-parser-type.mts to persist the fix on the project row.`,
        );
        parserType = 'tree-sitter-wasm';
      } else {
        logger.warn(
          `Project ${project.name} language='${language}' has no tree-sitter grammar in src/parser/treeSitter/grammars/. ` +
          `Keeping parserType='regex' (parse quality will be poor). Add the grammar wasm to enable tree-sitter for this language.`,
        );
      }
    }

    logger.info(`Indexing project ${project.name} at ${project.path} (language: ${language}, parser: ${parserType}, trigger: ${trigger}${force ? ', force=true' : ''})`);

    // Track diagnostic info that gets surfaced when files.length === 0.
    let zeroFilesDiagnostic: {
      hint: string;
      diagnostic: {
        projectPath: string;
        language: string;
        parserType: string;
        scannerKind: 'fantom' | 'multi-language';
      };
    } | null = null;

    // Select scanner based on language
    let files: string[] = [];
    let podMeta: PodMeta | undefined;

    const langStr = language as string;
    const isFanLike = langStr === 'fantom' || langStr === 'trio' || langStr === 'axon';
    if (isFanLike) {
      // Use Fantom-specific scanner for .fan and .trio files
      const scanner = new FantomFileScanner();
      const scanResult = await scanner.scanDirectory(project.path);
      files = scanResult.files;
      podMeta = scanResult.projectMeta || project.podMeta;

      if (scanResult.errors.length > 0) {
        for (const err of scanResult.errors) {
          errors.push({
            file: project.path,
            message: err,
            severity: 'warning'
          });
        }
      }
    } else {
      // Use multi-language scanner
      const scanner = createMultiLanguageScanner(language);
      const scanResult = await scanner.scanDirectory(project.path);
      files = scanResult.files;

      if (scanResult.errors.length > 0) {
        for (const err of scanResult.errors) {
          errors.push({
            file: project.path,
            message: err,
            severity: 'warning'
          });
        }
      }
    }

    logger.info(`[phase] scan DONE project=${project.name} files=${files.length}`);

    // Pathological-project guard: extremely large file counts almost always
    // indicate a misconfigured project.path (pointed at a monorepo root or
    // node_modules-bearing dir that escaped the exclude list). Refuse rather
    // than chew through tens of thousands of files and likely OOM.
    const MAX_FILES = Number(process.env.FANTOM_MAX_FILES_PER_PROJECT ?? '50000');
    if (files.length > MAX_FILES) {
      const msg = `Project "${project.name}" has ${files.length} files (> ${MAX_FILES}). Refusing to index — check project.path and excludePatterns.`;
      logger.error(msg);
      errors.push({ file: project.path, message: msg, severity: 'error' });
      files = [];
    }

    // Diagnostic when no files matched. Common causes: wrong project.path,
    // language mis-set, or every file is inside an excluded directory like
    // node_modules. Without this hint a successful-looking refresh leaves
    // the user staring at "0 functions indexed" with no clue why.
    if (files.length === 0) {
      const hint =
        `No source files matched for project "${project.name}" at ${project.path}. ` +
        `Common causes: (1) wrong project.path; (2) language='${language}' doesn't match any files in the directory ` +
        `(use addFantomProject({language: ...}) for non-Fantom projects); ` +
        `(3) all files are inside an excluded directory (node_modules, dist, .next, etc.) — ` +
        `set excludePatterns or update the project's .gitignore.`;
      logger.warn(hint);
      zeroFilesDiagnostic = {
        hint,
        diagnostic: {
          projectPath: project.path,
          language: langForGuard,
          parserType,
          scannerKind: isFanLike ? 'fantom' : 'multi-language',
        },
      };
    }

    // ============================================
    // Incremental indexing — file-level hash gate
    // ============================================
    // For each scanned file compute (mtimeMs, sha256) and compare against
    // the previously persisted IndexedFile row. If every file matches and
    // nothing was deleted, short-circuit: no parse, no graph rebuild — just
    // record a fast IndexRun with filesParsed=0.
    //
    // For projects that have never been indexed (no IndexedFile rows), this
    // is the "seeding run": parse everything, but skip per-symbol ApiChange
    // recording so we don't flood the change log with thousands of rows.
    const indexedRows = await this.prisma.indexedFile.findMany({
      where: { projectId: project.id }
    });
    const indexedMap = new Map(indexedRows.map(r => [r.filePath, r]));
    const isSeedingRun = indexedRows.length === 0;

    type FileHash = { path: string; mtimeMs: number; sha: string; size: number };
    const scanned: FileHash[] = [];
    const changedFiles: string[] = [];
    for (const fp of files) {
      try {
        const stat = await fsp.stat(fp);
        const mtimeMs = Math.floor(stat.mtimeMs);
        const prior = indexedMap.get(fp);
        // Cheap mtime check first; only hash if mtime differs
        if (prior && Number(prior.mtimeMs) === mtimeMs && Number(prior.byteSize) === stat.size) {
          scanned.push({ path: fp, mtimeMs, sha: prior.contentSha, size: stat.size });
          continue;
        }
        const buf = await fsp.readFile(fp);
        const sha = createHash('sha256').update(buf).digest('hex');
        scanned.push({ path: fp, mtimeMs, sha, size: buf.byteLength });
        if (!prior || prior.contentSha !== sha) {
          changedFiles.push(fp);
        }
      } catch (err) {
        errors.push({
          file: fp,
          message: `hash failed: ${err instanceof Error ? err.message : String(err)}`,
          severity: 'warning'
        });
      }
    }
    const scannedPaths = new Set(scanned.map(s => s.path));
    const removedFiles = indexedRows
      .filter(r => !scannedPaths.has(r.filePath))
      .map(r => r.filePath);

    // Capture git HEAD if the project root is a git checkout. Best-effort —
    // never block indexing on git failures. Provides finer-grained
    // time-travel anchors than IndexRun.startedAt alone.
    let gitCommit: string | null = null;
    let gitBranch: string | null = null;
    try {
      const { execSync } = await import('child_process');
      gitCommit = execSync(`git -C "${project.path.replace(/"/g, '\\"')}" rev-parse HEAD`, {
        timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
      }).toString().trim() || null;
      gitBranch = execSync(`git -C "${project.path.replace(/"/g, '\\"')}" rev-parse --abbrev-ref HEAD`, {
        timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
      }).toString().trim() || null;
    } catch {
      // Not a git repo, or git unavailable — leave both null.
    }

    // Open the IndexRun row early so we have a reference for ApiChange rows
    // and so a crashed run still leaves a trace in the DB.
    const indexRun = await this.prisma.indexRun.create({
      data: {
        projectId: project.id,
        startedAt,
        trigger,
        force,
        isSeedingRun,
        filesScanned: files.length,
        gitCommit,
        gitBranch,
      } as any,
    });

    // Short-circuit when nothing changed and the caller didn't force.
    // Seeding runs always proceed (changedFiles will equal `files`).
    const noChanges =
      !isSeedingRun && !force && changedFiles.length === 0 && removedFiles.length === 0;
    if (noChanges) {
      const durationMs = Date.now() - startTime;
      await this.prisma.indexRun.update({
        where: { id: indexRun.id },
        data: {
          finishedAt: new Date(),
          filesParsed: 0,
          filesSkipped: files.length,
          durationMs,
        },
      });

      // Hydrate the in-memory indexer from LadybugDB if it doesn't already
      // hold this project's symbols. Without this, FlexSearch (rebuilt from
      // the indexer in runIndex.ts) would return zero hits for projects
      // that were parsed in a prior process but whose in-memory state was
      // lost on restart. This is what caused the user-visible regression
      // where searchFantomCode returned 0 for a project Prisma reported
      // 4541 functions for.
      const indexerStats = this.indexer.getStats();
      const inMemoryCount = (indexerStats.byProject as Record<string, number>)[project.name] ?? 0;
      const expectedCount = (project as any).functionCount ?? 0;
      if (inMemoryCount < expectedCount) {
        try {
          await this.hydrateIndexerFromLadybug(project as ExtendedProject);
        } catch (hydrateErr) {
          logger.warn(
            `In-memory hydrate failed for ${project.name}: ${hydrateErr instanceof Error ? hydrateErr.message : String(hydrateErr)}`,
          );
        }
      }

      logger.info(
        `Indexing skipped (no changes): project ${project.name}, ${files.length} files unchanged in ${durationMs}ms`
      );
      return {
        projectId: project.id,
        projectName: project.name,
        functionsIndexed: 0,
        typesIndexed: 0,
        filesProcessed: 0,
        errors,
        duration: durationMs,
        noChange: true,
      };
    }

    // ============================================
    // Snapshot previous symbol set from LadybugDB before clearProjectGraph wipes it.
    // Used to compute added/modified/removed ApiChange rows. Skipped on
    // seeding runs (no prior state to diff against).
    // ============================================
    type PrevSym = { signature: string; filePath: string; kind: string; lineStart: number | null; lineEnd: number | null };
    const prevSymbols = new Map<string, PrevSym>();
    // Snapshot previous edges as (sourceQn|targetQn|edgeType) keys so we can
    // diff against the new graph after rebuild and emit EdgeChange rows.
    const prevEdges = new Set<string>();
    if (!isSeedingRun) {
      try {
        const rows = await ladybugQuery<{
          qn: string; sig: string | null; fp: string; nt: string;
          ls: number | null; le: number | null;
        }>(project.id,
          `MATCH (n:CodeNode)
           RETURN n.qualified_name AS qn, n.signature AS sig,
                  n.file_path AS fp, n.node_type AS nt,
                  n.line_start AS ls, n.line_end AS le`
        );
        for (const r of rows) {
          if (r.qn) prevSymbols.set(r.qn, {
            signature: r.sig || '', filePath: r.fp, kind: r.nt,
            lineStart: r.ls != null ? Number(r.ls) : null,
            lineEnd: r.le != null ? Number(r.le) : null,
          });
        }
        const edgeRows = await ladybugQuery<{
          sqn: string; tqn: string; et: string;
        }>(project.id,
          `MATCH (a:CodeNode)-[e:CodeEdge]->(b:CodeNode)
           RETURN a.qualified_name AS sqn, b.qualified_name AS tqn, e.edge_type AS et`
        );
        for (const e of edgeRows) {
          if (e.sqn && e.tqn && e.et) prevEdges.add(`${e.sqn}|${e.tqn}|${e.et}`);
        }
      } catch (err) {
        logger.warn(
          `Could not snapshot previous symbols for diff: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Select and initialize parser. Fantom is now supported by tree-sitter
    // (custom grammar at tree-sitter-fantom/, WASM in src/parser/treeSitter/grammars/),
    // so when parserType=tree-sitter-wasm we initialize the parser for Fantom too.
    // If the WASM is missing or fails to load on a Fantom project, we fall back
    // to the regex parser (it's still correct for Fantom, just less precise).
    let useTreeSitter = parserType === 'tree-sitter-wasm' || parserType === 'tree-sitter';
    let treeSitterParser: TreeSitterCodeParser | null = null;

    if (useTreeSitter && langStr !== 'trio') {
      // Namespace for qualified names. Fantom pods come from build.fan; for
      // TS/Vue/PHP projects there is no pod, and without a namespace the adapter
      // falls back to the FULL FILE PATH ("/Users/…/nodes.ts::createSedonaNode"),
      // which leaks into citations, embeddings and every name-based lookup. Use
      // the project's pod name or its name instead ("sedonaWebEditor::createSedonaNode").
      treeSitterParser = createTreeSitterParser(project.id, language, podMeta?.podName ?? (project as { podName?: string | null }).podName ?? project.name);
      // Wrap in try/catch — initialize() can throw (e.g. wasm load failure),
      // not just return false. Without this, an exception escapes into the
      // background pipeline and the dashboard's "Reindex" mutation never
      // sees the failure (response was already sent as {status:'started'}).
      let initialized = false;
      let initError: Error | null = null;
      try {
        initialized = await treeSitterParser.initialize();
      } catch (err) {
        initError = err instanceof Error ? err : new Error(String(err));
        logger.error(`Tree-sitter initialize() threw for ${language}: ${initError.message}`);
      }
      if (!initialized) {
        const fanLike = langStr === 'fantom' || langStr === 'axon';
        if (!fanLike && !options.allowRegexFallback) {
          // Soft fail instead of throwing — produce zero nodes for this run
          // and let the operator see the structured error. Throwing here
          // crashes the entire indexing pipeline silently in the background
          // and makes the dashboard look unresponsive.
          logger.error(
            `Tree-sitter grammar for "${language}" unavailable. Skipping parse for project ${project.id}. ` +
              `Cause: ${initError?.message ?? 'initialize() returned false'}. ` +
              `Run \`tsx scripts/check-grammars.mts\` to verify grammars in src/parser/treeSitter/grammars/.`,
          );
          useTreeSitter = false;
          treeSitterParser = null;
        } else {
          logger.warn(`Tree-sitter not available for ${language}, falling back to regex`);
          useTreeSitter = false;
          treeSitterParser = null;
        }
      }
    }

    // Initialize tree-sitter axon parser for trio files (to parse Axon src blocks)
    let axonTreeSitter: TreeSitterCodeParser | null = null;
    if (useTreeSitter || langStr === 'trio' || langStr === 'axon') {
      try {
        axonTreeSitter = createTreeSitterParser(project.id, 'axon' as any, podMeta?.podName);
        const initialized = await axonTreeSitter.initialize();
        if (!initialized) {
          logger.debug('Tree-sitter axon not available for trio parsing, using regex fallback');
          axonTreeSitter = null;
        }
      } catch {
        axonTreeSitter = null;
      }
    }

    // Create fallback regex parser for Fantom
    const regexParser = new FantomCodeParser(project.id, podMeta);
    // Create trio parser for .trio files (with optional tree-sitter for Axon src)
    const trioParser = new TrioParser(project.id, podMeta?.podName, axonTreeSitter);

    // Parse each file. Per-file logging here is deliberately verbose at
    // the info level because previously a single pathological file could
    // hang the parser silently and leave the operator with zero signal.
    // The "[parse] START" → "[parse] OK" pairing makes it trivial to
    // identify the offending file in /tmp/fantom-mcp-server.log.
    let parseFs: typeof import('node:fs') | null = null;
    try { parseFs = await import('node:fs'); } catch { /* fall through */ }

    const MAX_FILE_BYTES = Number(process.env.FANTOM_MAX_FILE_BYTES ?? String(5 * 1024 * 1024));
    logger.info(`[phase] parse START project=${project.name} files=${files.length}`);
    let parseSkipped = 0;
    // Streaming book-keeping: build symbolsPerFile + seedSymbols incrementally
    // so we don't have to walk parsedFiles a second time after the graph
    // build. Lets us drop parsedFiles immediately after buildLadybugGraph.
    const symbolsPerFile = new Map<string, number>();
    let seedSymbolsTotal = 0;

    for (const filePath of files) {
      const sizeBytes = (() => {
        try { return parseFs?.statSync(filePath).size ?? 0; } catch { return 0; }
      })();
      if (sizeBytes > MAX_FILE_BYTES) {
        logger.warn(`[parse] SKIP ${filePath} (${sizeBytes}B > ${MAX_FILE_BYTES}B max)`);
        errors.push({ file: filePath, message: `Skipped: file size ${sizeBytes}B exceeds limit ${MAX_FILE_BYTES}B`, severity: 'warning' });
        parseSkipped++;
        continue;
      }
      const parseStart = Date.now();
      const memBefore = process.memoryUsage().heapUsed;
      logger.info(`[parse] START ${filePath} (${sizeBytes}B)`);
      try {
        let parsed: ParsedFile;
        const isTrioFile = filePath.endsWith('.trio');
        if (isTrioFile) {
          parsed = await trioParser.parseFile(filePath);
        } else if (useTreeSitter && treeSitterParser) {
          parsed = await treeSitterParser.parseFile(filePath);
        } else {
          parsed = regexParser.parseFile(filePath);
        }
        const ms = Date.now() - parseStart;
        const heapDeltaMb = Math.round((process.memoryUsage().heapUsed - memBefore) / 1024 / 1024);
        if (ms > 1000 || heapDeltaMb > 50) {
          logger.warn(`[parse] SLOW/HEAVY ${filePath} ${ms}ms heapΔ=${heapDeltaMb}MB`);
        } else {
          logger.info(`[parse] OK ${filePath} ${ms}ms`);
        }

        parsedFiles.push(parsed);
        filesProcessed++;
        typesIndexed += parsed.types.length;
        let perFileSymbols = parsed.types.length;
        for (const type of parsed.types) {
          functionsIndexed += type.methods.length + type.fields.length;
          perFileSymbols += type.methods.length + type.fields.length;
        }
        const topFns = parsed.functions.filter(f => !f.className).length;
        functionsIndexed += topFns;
        perFileSymbols += topFns;
        symbolsPerFile.set(parsed.filePath, perFileSymbols);
        seedSymbolsTotal += perFileSymbols;
        errors.push(...parsed.errors);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[parse] FAILED ${filePath} after ${Date.now() - parseStart}ms: ${msg}`);
        errors.push({ file: filePath, message: msg, severity: 'error' });
      }
    }

    logger.info(`[phase] parse DONE project=${project.name} parsed=${filesProcessed} skipped=${parseSkipped} errors=${errors.length}`);

    // Build in-memory index
    if (!skipInMemory) {
      this.indexer.clearProject(project.id);
      this.indexer.registerProject(project);

      for (const parsed of parsedFiles) {
        for (const type of parsed.types) {
          this.indexer.addType(type);
        }
        for (const func of parsed.functions) {
          this.indexer.addFunction(func);
        }
      }
    }

    // Build graph in LadybugDB (authoritative store).
    let graphResult: GraphBuildResult | undefined;
    if (buildGraph && parsedFiles.length > 0) {
      const memBeforeGraph = process.memoryUsage();
      logger.info(`[phase] graph START project=${project.name} parsedFiles=${parsedFiles.length} rss=${Math.round(memBeforeGraph.rss / 1024 / 1024)}MB heap=${Math.round(memBeforeGraph.heapUsed / 1024 / 1024)}MB`);
      try {
        graphResult = await buildLadybugGraph(project.id, parsedFiles);
        logger.info(`[phase] graph DONE project=${project.name} nodes=${graphResult.nodeCount} edges=${graphResult.edgeCount}`);
        logger.info(`[LadybugDB] Graph built: ${graphResult.nodeCount} nodes, ${graphResult.edgeCount} edges`);
        for (const lErr of graphResult.errors) {
          errors.push({
            file: project.path,
            message: `LadybugDB: ${lErr}`,
            severity: 'warning',
          });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`LadybugDB graph build failed: ${errMsg}`);
        errors.push({
          file: project.path,
          message: `LadybugDB graph build failed: ${errMsg}`,
          severity: 'error',
        });
      }
    }

    // Streaming finale: drop the parsedFiles AST peak NOW so it doesn't
    // survive into EdgeChange diff + persist phases. The graph builder has
    // already absorbed everything it needs into LadybugDB; downstream phases
    // only need scanned[], symbolsPerFile (built incrementally), and the
    // graphResult counters. Without this, fantom.1.0.78.compiler's 98 ASTs
    // sat in scope for ~hundreds of ms after graph build, transiently
    // tripping macOS Jetsam mid-prisma-write.
    const beforeDrop = process.memoryUsage().heapUsed;
    parsedFiles.length = 0;
    if (typeof (globalThis as any).gc === 'function') {
      try {
        (globalThis as any).gc();
        const afterGc = process.memoryUsage().heapUsed;
        const reclaimedMb = Math.round((beforeDrop - afterGc) / 1024 / 1024);
        logger.info(`[phase] gc-after-graph project=${project.name} reclaimed=${reclaimedMb}MB`);
      } catch { /* gc failed; ignore */ }
    }

    // ============================================
    // EdgeChange recording. Skip seeding runs (no prior to diff against).
    // Cap at 5000 rows per run to avoid pathological floods.
    // ============================================
    if (!isSeedingRun && graphResult && (prevEdges.size > 0 || graphResult.edgeCount > 0)) {
      try {
        const newEdgeRows = await ladybugQuery<{ sqn: string; tqn: string; et: string }>(project.id,
          `MATCH (a:CodeNode)-[e:CodeEdge]->(b:CodeNode)
           RETURN a.qualified_name AS sqn, b.qualified_name AS tqn, e.edge_type AS et`
        );
        const newEdges = new Set<string>();
        for (const e of newEdgeRows) {
          if (e.sqn && e.tqn && e.et) newEdges.add(`${e.sqn}|${e.tqn}|${e.et}`);
        }
        const edgeChangeRows: Array<{
          runId: number; projectId: number; sourceQn: string; targetQn: string;
          edgeType: string; changeType: string;
        }> = [];
        for (const key of newEdges) {
          if (!prevEdges.has(key)) {
            const [sqn, tqn, et] = key.split('|');
            edgeChangeRows.push({
              runId: indexRun.id, projectId: project.id, sourceQn: sqn,
              targetQn: tqn, edgeType: et, changeType: 'added',
            });
          }
        }
        for (const key of prevEdges) {
          if (!newEdges.has(key)) {
            const [sqn, tqn, et] = key.split('|');
            edgeChangeRows.push({
              runId: indexRun.id, projectId: project.id, sourceQn: sqn,
              targetQn: tqn, edgeType: et, changeType: 'removed',
            });
          }
        }
        const MAX_EDGE_CHANGE_ROWS = 5000;
        if (edgeChangeRows.length > 0) {
          await (this.prisma as any).edgeChange.createMany({
            data: edgeChangeRows.slice(0, MAX_EDGE_CHANGE_ROWS),
          });
          if (edgeChangeRows.length > MAX_EDGE_CHANGE_ROWS) {
            logger.warn(
              `EdgeChange rows truncated: ${edgeChangeRows.length} -> ${MAX_EDGE_CHANGE_ROWS} for run ${indexRun.id}`
            );
          }
          logger.info(
            `[EdgeChange] run ${indexRun.id}: +${edgeChangeRows.filter((r) => r.changeType === 'added').length} -${edgeChangeRows.filter((r) => r.changeType === 'removed').length}`
          );
        }
      } catch (err) {
        logger.warn(
          `EdgeChange recording failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Update project in database
    await this.updateProjectStats(project.id, {
      functionCount: functionsIndexed,
      typeCount: typesIndexed,
      lastIndexed: new Date(),
      podMeta
    });

    // ============================================
    // Diff against pre-state snapshot, record ApiChange + IndexedFile rows.
    // Skip ApiChange recording on seeding runs (would flood the log on first index).
    // ============================================
    let addedCount = 0, modifiedCount = 0, removedCount = 0;
    if (!isSeedingRun && prevSymbols.size > 0) {
      type NewSym = { sig: string; filePath: string; kind: string; lineStart: number | null; lineEnd: number | null };
      const newSymbols = new Map<string, NewSym>();
      for (const pf of parsedFiles) {
        for (const t of pf.types) {
          newSymbols.set(t.qualifiedName, { sig: '', filePath: t.filePath, kind: 'type', lineStart: t.lineNumber ?? null, lineEnd: t.lineEnd ?? null });
          for (const m of t.methods) {
            newSymbols.set(m.qualifiedName, {
              sig: m.signature || '', filePath: m.filePath, kind: 'function',
              lineStart: m.lineNumber ?? null, lineEnd: m.lineEnd ?? null,
            });
          }
          for (const f of t.fields) {
            newSymbols.set(f.qualifiedName, {
              sig: f.signature || '', filePath: f.filePath, kind: 'field',
              lineStart: f.lineNumber ?? null, lineEnd: f.lineEnd ?? null,
            });
          }
        }
        for (const f of pf.functions) {
          if (!newSymbols.has(f.qualifiedName)) {
            newSymbols.set(f.qualifiedName, {
              sig: f.signature || '', filePath: f.filePath, kind: 'function',
              lineStart: f.lineNumber ?? null, lineEnd: f.lineEnd ?? null,
            });
          }
        }
      }

      const changeRows: Array<{
        runId: number; projectId: number; kind: string;
        qualifiedName: string; changeType: string;
        beforeSig: string | null; afterSig: string | null; filePath: string;
        lineStart: number | null; lineEnd: number | null;
      }> = [];
      for (const [qn, n] of newSymbols) {
        const prev = prevSymbols.get(qn);
        if (!prev) {
          addedCount++;
          changeRows.push({
            runId: indexRun.id, projectId: project.id, kind: n.kind,
            qualifiedName: qn, changeType: 'added',
            beforeSig: null, afterSig: n.sig, filePath: n.filePath,
            lineStart: n.lineStart, lineEnd: n.lineEnd,
          });
        } else if (prev.signature !== n.sig) {
          modifiedCount++;
          changeRows.push({
            runId: indexRun.id, projectId: project.id, kind: n.kind,
            qualifiedName: qn, changeType: 'modified',
            beforeSig: prev.signature, afterSig: n.sig, filePath: n.filePath,
            lineStart: n.lineStart, lineEnd: n.lineEnd,
          });
        }
      }
      for (const [qn, prev] of prevSymbols) {
        if (!newSymbols.has(qn)) {
          removedCount++;
          changeRows.push({
            runId: indexRun.id, projectId: project.id, kind: prev.kind,
            qualifiedName: qn, changeType: 'removed',
            beforeSig: prev.signature, afterSig: null, filePath: prev.filePath,
            lineStart: prev.lineStart, lineEnd: prev.lineEnd,
          });
        }
      }
      // Cap ApiChange writes per run to avoid pathological floods.
      const MAX_CHANGE_ROWS = 5000;
      if (changeRows.length > 0) {
        await this.prisma.apiChange.createMany({
          data: changeRows.slice(0, MAX_CHANGE_ROWS),
        });
        if (changeRows.length > MAX_CHANGE_ROWS) {
          logger.warn(
            `ApiChange rows truncated: ${changeRows.length} -> ${MAX_CHANGE_ROWS} for run ${indexRun.id}`
          );
        }
      }
    } else if (isSeedingRun) {
      // seedSymbolsTotal already accumulated during the streaming parse loop.
      addedCount = seedSymbolsTotal;
    }

    // Persist IndexedFile rows: replace the project's set with what we just scanned.
    // symbolsPerFile was built incrementally during the parse loop above.
    logger.info(`[phase] persist START project=${project.name} indexedFiles=${scanned.length}`);
    await this.prisma.indexedFile.deleteMany({ where: { projectId: project.id } });
    if (scanned.length > 0) {
      await this.prisma.indexedFile.createMany({
        data: scanned.map(s => ({
          projectId: project.id,
          filePath: s.path,
          mtimeMs: BigInt(s.mtimeMs),
          contentSha: s.sha,
          byteSize: s.size,
          symbolCount: symbolsPerFile.get(s.path) ?? 0,
          indexedAt: new Date(),
        })),
      });
    }

    // Finalize IndexRun row
    const durationMs = Date.now() - startTime;
    await this.prisma.indexRun.update({
      where: { id: indexRun.id },
      data: {
        finishedAt: new Date(),
        filesParsed: filesProcessed,
        filesSkipped: Math.max(0, files.length - filesProcessed),
        durationMs,
        addedCount,
        modifiedCount,
        removedCount,
      },
    });

    const result: FullIndexResult = {
      projectId: project.id,
      projectName: project.name,
      functionsIndexed,
      typesIndexed,
      filesProcessed,
      errors,
      duration: durationMs,
      graphResult,
      ...(zeroFilesDiagnostic ?? {}),
    };

    // Write per-project counts back to Prisma so dashboard /admin/vectors/stats
    // (which reads p.functionCount + p.typeCount) and the embed-missing
    // watchdog see fresh totals for tree-sitter / multi-language projects
    // too. Prior bug: only the legacy Fantom regex path called
    // db.updateProjectIndexStats; non-Fantom projects (TS, JS, Python, PHP,
    // Vue, trio) were left at seed values, producing absurd coverage
    // percentages like 5220% on the dashboard. Skip when files.length === 0
    // to avoid clobbering with zeros on misconfigured project paths.
    if (files.length > 0) {
      try {
        await this.prisma.fantomProject.update({
          where: { id: project.id },
          data: { functionCount: functionsIndexed, typeCount: typesIndexed },
        });
      } catch (err) {
        logger.warn(`Failed to update fantomProject counts for ${project.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    logger.info(`[phase] persist DONE project=${project.name} run=${indexRun.id} duration=${durationMs}ms`);
    logger.info(
      `Indexing complete: ${functionsIndexed} functions, ${typesIndexed} types in ${durationMs}ms (run #${indexRun.id}: +${addedCount} ~${modifiedCount} -${removedCount})`
    );

    await this.refreshProjectDependencies(project.id);

    return result;
  }

  /**
   * Refresh the project's dependency rows (build.fan / package.json /
   * cross_project_edges / workspace siblings — see
   * src/fantom/projectDependencies.ts) so the ask scope reflects what was just
   * indexed. Single hook for every indexing entry point (MCP add/refresh,
   * admin reindex, startup auto-index, incremental reindexFiles). Best-effort:
   * never fails the index run.
   */
  private async refreshProjectDependencies(projectId: number): Promise<void> {
    try {
      const { rebuildProjectDependenciesSafe } = await import('../fantom/projectDependencies.js');
      const deps = await rebuildProjectDependenciesSafe(projectId, this.prisma);
      if (deps) {
        logger.info(
          `[phase] dependencies DONE project=${projectId} +${deps.added} ~${deps.updated} -${deps.removed} ` +
            `${Object.entries(deps.kinds).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'} (${deps.durationMs}ms)`,
        );
      }
    } catch (err) {
      logger.warn(`dependency refresh failed for project ${projectId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Re-index a specific subset of files within a project. Used by the
   * MCP `reindexChangedFiles` tool: the assistant tells us exactly which
   * files it just edited and we update only those.
   *
   * Per-file scope: clears CodeNode/CodeEdge for each path, re-parses,
   * rebuilds graph for those parsed files only (clearProject=false), and
   * upserts IndexedFile rows. Records one IndexRun + ApiChange rows.
   *
   * Caveat: cross-file edges (other files that reference symbols in the
   * changed file) may go stale until a full project re-index runs. v1
   * accepts this — full re-index resolves it.
   */
  async reindexFiles(args: {
    projectId: number;
    paths: string[];
    trigger?: 'manual' | 'auto' | 'watch' | 'mcp' | 'mcp-add' | 'mcp-refresh' | 'mcp-incremental' | 'admin-reindex' | 'file-watch';
  }): Promise<FullIndexResult & { runId: number; addedCount: number; modifiedCount: number; removedCount: number; embeddedCount: number }> {
    const { projectId, paths, trigger = 'mcp-incremental' } = args;
    return this.withProjectLock(projectId, async () => {
      const startTime = Date.now();
      const startedAt = new Date(startTime);
      const errors: ParseError[] = [];

      const projectRow = await this.prisma.fantomProject.findUnique({ where: { id: projectId } });
      if (!projectRow) {
        throw new Error(`Project ${projectId} not found`);
      }
      const language = (projectRow.language || 'fantom') as SupportedLanguage;
      let parserType = projectRow.parserType || 'regex';
      const langStr = language as string;
      const isFanLike = langStr === 'fantom' || langStr === 'trio' || langStr === 'axon';
      if (!isFanLike && parserType === 'regex') {
        logger.warn(
          `Project ${projectId} (language=${langStr}) has parserType='regex'. Auto-correcting to 'tree-sitter-wasm' for this run.`,
        );
        parserType = 'tree-sitter-wasm';
      }

      // Resolve podMeta for fan/trio paths so the parser can attribute symbols correctly.
      let podMeta: PodMeta | undefined;
      if (isFanLike) {
        const scanner = new FantomFileScanner();
        try {
          // Cheaper than re-scanning: read the project's build.fan if any.
          podMeta = (await scanner.scanDirectory(projectRow.path)).projectMeta;
        } catch { /* best-effort */ }
      }

      // Open the IndexRun row up front.
      const indexRun = await this.prisma.indexRun.create({
        data: {
          projectId,
          startedAt,
          trigger,
          force: false,
          isSeedingRun: false,
          filesScanned: paths.length,
        },
      });

      // Initialize parsers (mirroring indexProject's setup).
      let useTreeSitter = parserType === 'tree-sitter-wasm' || parserType === 'tree-sitter';
      let treeSitterParser: TreeSitterCodeParser | null = null;
      if (useTreeSitter && langStr !== 'trio') {
        // Same namespace rule as indexProject (pod name → project name → file path).
        treeSitterParser = createTreeSitterParser(projectId, language, podMeta?.podName ?? projectRow.podName ?? projectRow.name);
        const ok = await treeSitterParser.initialize();
        if (!ok) {
          logger.warn(`Tree-sitter not available for ${language}, falling back to regex`);
          useTreeSitter = false;
          treeSitterParser = null;
        }
      }
      let axonTreeSitter: TreeSitterCodeParser | null = null;
      if (useTreeSitter || langStr === 'trio' || langStr === 'axon') {
        try {
          axonTreeSitter = createTreeSitterParser(projectId, 'axon' as any, podMeta?.podName);
          const ok = await axonTreeSitter.initialize();
          if (!ok) axonTreeSitter = null;
        } catch { axonTreeSitter = null; }
      }
      const regexParser = new FantomCodeParser(projectId, podMeta);
      const trioParser = new TrioParser(projectId, podMeta?.podName, axonTreeSitter);

      // Snapshot per-file existing symbols (for diff) BEFORE clearing.
      type PrevSym = { signature: string; filePath: string; kind: string };
      const prevSymbols = new Map<string, PrevSym>();
      const fpEscList = paths.map(p => `'${p.replace(/'/g, "\\'")}'`).join(',');
      if (paths.length > 0) {
        try {
          const rows = await ladybugQuery<{
            qn: string; sig: string | null; fp: string; nt: string;
          }>(projectId,
            `MATCH (n:CodeNode {project_id: ${projectId}})
             WHERE n.file_path IN [${fpEscList}]
             RETURN n.qualified_name AS qn, n.signature AS sig,
                    n.file_path AS fp, n.node_type AS nt`
          );
          for (const r of rows) {
            if (r.qn) prevSymbols.set(r.qn, { signature: r.sig || '', filePath: r.fp, kind: r.nt });
          }
        } catch (err) {
          logger.warn(`Snapshot failed for reindexFiles: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Clear graph nodes for each path so the rebuild is clean.
      for (const fp of paths) {
        try {
          await clearFileGraph(projectId, fp);
        } catch (err) {
          errors.push({
            file: fp,
            message: `clearFileGraph failed: ${err instanceof Error ? err.message : String(err)}`,
            severity: 'warning',
          });
        }
      }

      // Parse each path. Drop paths that no longer exist on disk — those become "removed" symbols.
      const parsedFiles: ParsedFile[] = [];
      const removedPaths: string[] = [];
      let functionsIndexed = 0, typesIndexed = 0, filesProcessed = 0;
      for (const fp of paths) {
        try {
          await fsp.stat(fp);
        } catch {
          removedPaths.push(fp);
          continue;
        }
        try {
          let parsed: ParsedFile;
          if (fp.endsWith('.trio')) {
            parsed = await trioParser.parseFile(fp);
          } else if (useTreeSitter && treeSitterParser) {
            parsed = await treeSitterParser.parseFile(fp);
          } else {
            parsed = regexParser.parseFile(fp);
          }
          parsedFiles.push(parsed);
          filesProcessed++;
          typesIndexed += parsed.types.length;
          for (const t of parsed.types) functionsIndexed += t.methods.length + t.fields.length;
          functionsIndexed += parsed.functions.filter(f => !f.className).length;
          errors.push(...parsed.errors);
        } catch (err) {
          errors.push({
            file: fp,
            message: err instanceof Error ? err.message : String(err),
            severity: 'error',
          });
        }
      }

      // In-memory index: remove old entries for these files, then re-add.
      this.indexer.removeFilesFromProject(projectId, paths);
      for (const pf of parsedFiles) {
        for (const t of pf.types) this.indexer.addType(t);
        for (const f of pf.functions) this.indexer.addFunction(f);
      }

      // Rebuild graph for parsed files only (clearProject: false — we already
      // wiped per-path above).
      let graphResult: GraphBuildResult | undefined;
      if (parsedFiles.length > 0) {
        try {
          graphResult = await buildLadybugGraph(projectId, parsedFiles, { clearProject: false });
        } catch (err) {
          errors.push({
            file: '',
            message: `LadybugDB rebuild failed: ${err instanceof Error ? err.message : String(err)}`,
            severity: 'error',
          });
        }
      }

      // Diff vs prevSymbols.
      type NewSym = { sig: string; filePath: string; kind: string };
      const newSymbols = new Map<string, NewSym>();
      for (const pf of parsedFiles) {
        for (const t of pf.types) {
          newSymbols.set(t.qualifiedName, { sig: '', filePath: t.filePath, kind: 'type' });
          for (const m of t.methods) newSymbols.set(m.qualifiedName, { sig: m.signature || '', filePath: m.filePath, kind: 'function' });
          for (const f of t.fields) newSymbols.set(f.qualifiedName, { sig: f.signature || '', filePath: f.filePath, kind: 'field' });
        }
        for (const f of pf.functions) {
          if (!newSymbols.has(f.qualifiedName)) {
            newSymbols.set(f.qualifiedName, { sig: f.signature || '', filePath: f.filePath, kind: 'function' });
          }
        }
      }
      let addedCount = 0, modifiedCount = 0, removedCount = 0;
      const changeRows: Array<{
        runId: number; projectId: number; kind: string; qualifiedName: string;
        changeType: string; beforeSig: string | null; afterSig: string | null; filePath: string;
      }> = [];
      for (const [qn, n] of newSymbols) {
        const prev = prevSymbols.get(qn);
        if (!prev) {
          addedCount++;
          changeRows.push({ runId: indexRun.id, projectId, kind: n.kind, qualifiedName: qn, changeType: 'added', beforeSig: null, afterSig: n.sig, filePath: n.filePath });
        } else if (prev.signature !== n.sig) {
          modifiedCount++;
          changeRows.push({ runId: indexRun.id, projectId, kind: n.kind, qualifiedName: qn, changeType: 'modified', beforeSig: prev.signature, afterSig: n.sig, filePath: n.filePath });
        }
      }
      for (const [qn, prev] of prevSymbols) {
        if (!newSymbols.has(qn)) {
          removedCount++;
          changeRows.push({ runId: indexRun.id, projectId, kind: prev.kind, qualifiedName: qn, changeType: 'removed', beforeSig: prev.signature, afterSig: null, filePath: prev.filePath });
        }
      }
      if (changeRows.length > 0) {
        await this.prisma.apiChange.createMany({ data: changeRows });
      }

      // Upsert IndexedFile rows for surviving paths; delete rows for removed paths.
      if (removedPaths.length > 0) {
        await this.prisma.indexedFile.deleteMany({
          where: { projectId, filePath: { in: removedPaths } },
        });
      }
      for (const pf of parsedFiles) {
        let stat;
        try { stat = await fsp.stat(pf.filePath); } catch { continue; }
        const buf = await fsp.readFile(pf.filePath).catch(() => null);
        if (!buf) continue;
        const sha = createHash('sha256').update(buf).digest('hex');
        const symbolCount =
          pf.types.length +
          pf.types.reduce((acc, t) => acc + t.methods.length + t.fields.length, 0) +
          pf.functions.filter(f => !f.className).length;
        await this.prisma.indexedFile.upsert({
          where: { projectId_filePath: { projectId, filePath: pf.filePath } },
          create: {
            projectId, filePath: pf.filePath,
            mtimeMs: BigInt(Math.floor(stat.mtimeMs)),
            contentSha: sha,
            byteSize: buf.byteLength,
            symbolCount,
            indexedAt: new Date(),
          },
          update: {
            mtimeMs: BigInt(Math.floor(stat.mtimeMs)),
            contentSha: sha,
            byteSize: buf.byteLength,
            symbolCount,
            indexedAt: new Date(),
          },
        });
      }

      // Update project stats best-effort: just bump lastIndexed.
      await this.prisma.fantomProject.update({
        where: { id: projectId },
        data: { lastIndexed: new Date() },
      });

      const durationMs = Date.now() - startTime;
      await this.prisma.indexRun.update({
        where: { id: indexRun.id },
        data: {
          finishedAt: new Date(),
          filesParsed: filesProcessed,
          filesSkipped: 0,
          durationMs,
          addedCount,
          modifiedCount,
          removedCount,
          errorMessage: errors.filter(e => e.severity === 'error').map(e => e.message).join('\n') || null,
        },
      });

      logger.info(
        `reindexFiles project=${projectId} paths=${paths.length} parsed=${filesProcessed} ` +
        `removed=${removedPaths.length} +${addedCount} ~${modifiedCount} -${removedCount} in ${durationMs}ms`
      );

      // Cross-project call edges (and thus 'cross-project-edges' rows) may
      // have changed with the edited files; refresh best-effort.
      await this.refreshProjectDependencies(projectId);

      // ── Re-embed the changed files' nodes so SEMANTIC SEARCH reflects the
      // edit. The graph rebuild above replaced these files' CodeNodes with new
      // ids — orphaning their old vectors and leaving the new nodes UNEMBEDDED —
      // so without this step semanticCodeSearch goes stale/empty for an edited
      // file (defeating the point of an incremental reindex). Embed
      // synchronously via the configured code provider (e.g. the jina sidecar)
      // so a single MCP call = parse + graph + vectors. Best-effort: if the
      // embedding sidecar is down the graph is still fresh and the auto-embed
      // watchdog backfills the missing vectors later. (Orphaned old vectors are
      // harmless — search enrichment drops any hit whose node no longer exists.)
      let embeddedCount = 0;
      try {
        const fileList = paths.map(p => `'${p.replace(/'/g, "\\'")}'`).join(', ');
        const nodes = fileList
          ? await ladybugQuery<{ id: string; name: string; qn: string; sig: string | null; doc: string | null; fp: string; ls: number; le: number; nt: string }>(
              projectId,
              `MATCH (n:CodeNode {project_id: ${projectId}}) WHERE n.file_path IN [${fileList}] ` +
              `RETURN n.id AS id, n.name AS name, n.qualified_name AS qn, n.signature AS sig, n.documentation AS doc, ` +
              `n.file_path AS fp, n.line_start AS ls, n.line_end AS le, n.node_type AS nt`,
            )
          : [];
        if (nodes.length > 0) {
          const { buildEmbeddingItems, fileNodeId } = await import('../embedding/embeddingText.js');
          const { buildEmbeddingContext } = await import('../embedding/embeddingContext.js');
          const { buildSyntheticItems } = await import('../embedding/embedSynthetic.js');
          const { selectEmbeddingProviderForProject } = await import('../embedding/providers/embeddingProvider.js');
          const { getVectorStore } = await import('../embedding/vectorStore.js');
          const provider = selectEmbeddingProviderForProject('code', projectId);
          await provider.initialize();
          const vs = getVectorStore(this.prisma);
          const embedNodes = nodes.map(n => ({
            id: n.id, name: n.name, qualifiedName: n.qn, signature: n.sig, documentation: n.doc, nodeType: n.nt,
            filePath: n.fp, lineStart: n.ls != null ? Number(n.ls) : null, lineEnd: n.le != null ? Number(n.le) : null,
          }));
          // v3: graph context for just these files (edge scan restricted to
          // them), chunk expansion, and a refreshed `kind: file` row per file.
          const context = await buildEmbeddingContext(projectId, embedNodes, { filePaths: paths });
          const workItems = [
            ...buildEmbeddingItems(embedNodes, context),
            ...await buildSyntheticItems(this.prisma, projectId, embedNodes, { filePaths: paths }).catch(() => []),
          ];
          // Files that no longer exist lose their file row (their nodes were removed above).
          for (const rp of removedPaths) { try { await vs.deleteEmbedding(fileNodeId(rp)); } catch { /* best effort */ } }
          const B = 50;
          for (let i = 0; i < workItems.length; i += B) {
            const batch = workItems.slice(i, i + B);
            const vecs = await provider.embedBatch(batch.map(it => it.text));
            const items = batch.map((it, j) => ({ ...it, embedding: vecs[j] })).filter(x => x.embedding);
            if (items.length) embeddedCount += await vs.storeEmbeddings(items, projectId);
          }
          logger.info(`reindexFiles project=${projectId} re-embedded ${embeddedCount} rows for ${nodes.length} changed-file nodes (${workItems.length} items)`);
        }
      } catch (err) {
        logger.warn(`reindexFiles re-embed failed (graph updated; vectors backfill via auto-embed): ${err instanceof Error ? err.message : String(err)}`);
      }

      return {
        runId: indexRun.id,
        projectId,
        projectName: projectRow.name,
        functionsIndexed,
        typesIndexed,
        filesProcessed,
        errors,
        duration: durationMs,
        graphResult,
        addedCount,
        modifiedCount,
        removedCount,
        embeddedCount,
      };
    });
  }

  /**
   * Index multiple projects
   */
  async indexProjects(
    projects: FantomProject[],
    options: IndexingOptions = {}
  ): Promise<FullIndexResult[]> {
    const results: FullIndexResult[] = [];

    for (const project of projects) {
      const result = await this.indexProject(project, options);
      results.push(result);
    }

    // Optionally resolve cross-project references
    if (options.resolveRefs && options.buildGraph !== false) {
      await this.resolveAllReferences(projects.map(p => p.id));
    }

    return results;
  }

  /**
   * Rebuild just the graph for an already-indexed project (supports all languages)
   *
   * @param onProgress optional callback invoked with phase milestones so the
   *   indexing pipeline can advance its parsing/graph-building stage bars in
   *   real time instead of jumping 0 → 100 at completion.
   */
  async rebuildGraph(
    projectId: number,
    onProgress?: (ev: {
      phase: 'scanning' | 'parsing' | 'graph-building';
      filesTotal?: number;
      filesProcessed?: number;
      parsedCount?: number;
      nodeCount?: number;
      edgeCount?: number;
    }) => void
  ): Promise<GraphBuildResult> {
    const project = await this.prisma.fantomProject.findUnique({
      where: { id: projectId }
    });

    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const language = (project.language || 'fantom') as SupportedLanguage;
    const parserType = project.parserType || 'regex';
    logger.info(`Rebuilding graph for project ${project.name} (language: ${language})`);

    let files: string[] = [];
    const podMeta = { podName: project.podName ?? project.name, dependencies: [], srcDirs: ['fan'] };

    onProgress?.({ phase: 'scanning' });
    if (language === 'fantom') {
      const scanner = new FantomFileScanner();
      const scanResult = await scanner.scanDirectory(project.path);
      files = scanResult.files;
    } else {
      const scanner = createMultiLanguageScanner(language);
      const scanResult = await scanner.scanDirectory(project.path);
      files = scanResult.files;
    }
    onProgress?.({ phase: 'parsing', filesTotal: files.length, filesProcessed: 0 });

    // Select parser. Fantom now has a tree-sitter grammar, so the previous
    // `language !== 'fantom'` exclusion has been dropped — when parserType
    // is tree-sitter-wasm we use tree-sitter for .fan too.
    const useTreeSitter = parserType === 'tree-sitter-wasm' || parserType === 'tree-sitter';
    let treeSitterParser: TreeSitterCodeParser | null = null;

    if (useTreeSitter) {
      treeSitterParser = createTreeSitterParser(project.id, language, podMeta?.podName);
      const initialized = await treeSitterParser.initialize();
      if (!initialized) {
        logger.warn(`Tree-sitter not available for ${language}, falling back to regex`);
        treeSitterParser = null;
      }
    }

    const regexParser = new FantomCodeParser(project.id, podMeta);
    const parsedFiles: ParsedFile[] = [];

    for (let i = 0; i < files.length; i++) {
      const filePath = files[i];
      try {
        if (treeSitterParser) {
          parsedFiles.push(await treeSitterParser.parseFile(filePath));
        } else {
          parsedFiles.push(regexParser.parseFile(filePath));
        }
      } catch (err) {
        logger.warn(`Failed to parse ${filePath}: ${err}`);
      }
      // Emit at most every 25 files to keep SSE chatter bounded but bar smooth.
      if (onProgress && (i === files.length - 1 || (i + 1) % 25 === 0)) {
        onProgress({ phase: 'parsing', filesTotal: files.length, filesProcessed: i + 1 });
      }
    }

    onProgress?.({ phase: 'graph-building', parsedCount: parsedFiles.length });
    const result = await buildLadybugGraph(projectId, parsedFiles);
    onProgress?.({
      phase: 'graph-building',
      parsedCount: parsedFiles.length,
      nodeCount: result.nodeCount,
      edgeCount: result.edgeCount,
    });
    logger.info(`[LadybugDB] rebuildGraph: ${result.nodeCount} nodes, ${result.edgeCount} edges`);
    return result;
  }

  /**
   * Rebuild graphs for ALL projects and resolve cross-project references
   */
  async rebuildAllGraphs(): Promise<{ projects: number; totalNodes: number; totalEdges: number; resolved: number }> {
    const projects = await this.prisma.fantomProject.findMany();
    let totalNodes = 0;
    let totalEdges = 0;

    for (const project of projects) {
      try {
        const result = await this.rebuildGraph(project.id);
        totalNodes += result.nodeCount;
        totalEdges += result.edgeCount;
        logger.info(`Graph rebuilt for ${project.name}: ${result.nodeCount} nodes, ${result.edgeCount} edges`);
      } catch (err) {
        logger.error(`Failed to rebuild graph for ${project.name}: ${err}`);
      }
    }

    // Resolve cross-project references
    const resolved = await this.resolveAllReferences(projects.map(p => p.id));

    logger.info(`All graphs rebuilt: ${projects.length} projects, ${totalNodes} nodes, ${totalEdges} edges, ${resolved} resolved`);
    return { projects: projects.length, totalNodes, totalEdges, resolved };
  }

  /**
   * Build a global name → candidates index across every per-project Ladybug
   * DB passed in. Phase 1 foundation for cross-project reference resolution
   * (axon in pod A calling fantom in pod B). Returns the index without
   * writing any edges — see specs/languages-agent-and-cross-language-edges.md
   * for the four storage options being evaluated for Phase 2.
   */
  async buildCrossProjectNameIndex(projectIds: number[]): Promise<{
    projectsScanned: number;
    totalNodes: number;
    distinctNames: number;
    entries: Record<string, Array<{ id: string; projectId: number; qualifiedName: string; language: string; pod: string }>>;
  }> {
    const { ladybugQuery } = await import('../graph/ladybugConnection.js');
    const podOf = (qn: string): string => qn.includes('::') ? qn.split('::', 1)[0]! : '';
    const entries: Record<string, Array<{ id: string; projectId: number; qualifiedName: string; language: string; pod: string }>> = {};
    let totalNodes = 0;
    let projectsScanned = 0;
    for (const projectId of projectIds) {
      try {
        const rows = await ladybugQuery<{ id: string; qn: string; n: string; lang: string }>(
          projectId,
          `MATCH (n:CodeNode {project_id: ${projectId}})
           RETURN n.id AS id, n.qualified_name AS qn, n.name AS n, n.language AS lang`,
        );
        projectsScanned++;
        for (const r of rows) {
          totalNodes++;
          const meta = {
            id: r.id,
            projectId,
            qualifiedName: r.qn,
            language: (r.lang || 'fantom').toLowerCase(),
            pod: podOf(r.qn),
          };
          const keys = new Set<string>([r.qn, r.n]);
          if (r.qn && r.qn.includes('::')) keys.add(r.qn.split('::').slice(1).join('::'));
          for (const k of keys) {
            if (!k) continue;
            const arr = entries[k];
            if (arr) arr.push(meta); else entries[k] = [meta];
          }
        }
      } catch (err) {
        logger.warn(`[cross-project-index] project ${projectId} skipped: ${err}`);
      }
    }
    return { projectsScanned, totalNodes, distinctNames: Object.keys(entries).length, entries };
  }

  /**
   * Phase 2 — actually persist cross-project edges to the Prisma
   * `cross_project_edges` table (Option 3 in the spec).
   *
   * Strategy: every CodeEdge with `is_resolved=true` whose target lives in a
   * different per-project DB cannot exist in Kuzu (REL requires same DB), so
   * it was dropped during build. We can re-derive these edges by walking each
   * function's *unresolved* call sites and looking them up in the global name
   * index. Since unresolved call sites aren't currently persisted, this
   * implementation makes a pragmatic approximation: it walks every function
   * node's `signature` (which contains the source body for axon trio funcs)
   * and matches `[A-Za-z_]\w*` identifiers against the global index, skipping
   * candidates from the same project (those would already be local edges).
   *
   * Returns counts: rowsWritten + scanned/skipped breakdown.
   */
  async resolveCrossProjectEdges(projectIds: number[]): Promise<{
    projectsScanned: number;
    sourceNodesScanned: number;
    edgesWritten: number;
    duplicatesSkipped: number;
    ambiguousSkipped: number;
  }> {
    if (!projectIds || projectIds.length === 0) {
      return { projectsScanned: 0, sourceNodesScanned: 0, edgesWritten: 0, duplicatesSkipped: 0, ambiguousSkipped: 0 };
    }
    const idx = await this.buildCrossProjectNameIndex(projectIds);
    const { ladybugQuery } = await import('../graph/ladybugConnection.js');
    const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/g;
    // Built-in axon ops we never want to chase as call targets.
    const STOPWORDS = new Set([
      'if','else','do','end','return','throw','try','catch','func','null','true','false','and','or','not',
      'as','is','def','var','let','this','super','new','typeof',
    ]);
    let sourceNodesScanned = 0;
    let edgesWritten = 0;
    let duplicatesSkipped = 0;
    let ambiguousSkipped = 0;
    for (const projectId of projectIds) {
      let rows: Array<{ id: string; qn: string; n: string; lang: string; sig: string | null; doc: string | null }>;
      try {
        // Don't filter on node_type — values vary across language adapters
        // ('function', 'method', etc.). Scan every node that has signature
        // or documentation text we can tokenize.
        rows = await ladybugQuery<{ id: string; qn: string; n: string; lang: string; sig: string | null; doc: string | null }>(
          projectId,
          `MATCH (n:CodeNode {project_id: ${projectId}})
           WHERE n.signature IS NOT NULL OR n.documentation IS NOT NULL
           RETURN n.id AS id, n.qualified_name AS qn, n.name AS n,
                  n.language AS lang, n.signature AS sig, n.documentation AS doc`,
        );
      } catch (err) {
        logger.warn(`[cross-project] project ${projectId}: scan failed: ${err}`);
        continue;
      }
      for (const r of rows) {
        sourceNodesScanned++;
        const body = `${r.sig || ''}\n${r.doc || ''}`;
        if (!body.trim()) continue;
        const seen = new Set<string>();
        const matches = body.match(IDENT_RE) || [];
        for (const ident of matches) {
          if (STOPWORDS.has(ident)) continue;
          if (seen.has(ident)) continue;
          seen.add(ident);
          // Guard against Object.prototype collisions: identifiers like
          // 'toString' would return Function from a plain-object lookup.
          const candidates = Object.prototype.hasOwnProperty.call(idx.entries, ident)
            ? idx.entries[ident]
            : undefined;
          if (!candidates || !Array.isArray(candidates) || candidates.length === 0) continue;
          // Drop candidates in the same project — those are local edges.
          const remote = candidates.filter(c => c.projectId !== projectId);
          if (remote.length === 0) continue;
          // Prefer same-language candidate, then deterministic by id.
          const callerLang = (r.lang || 'fantom').toLowerCase();
          remote.sort((a, b) => {
            const al = a.language === callerLang ? 1 : 0;
            const bl = b.language === callerLang ? 1 : 0;
            return (bl - al) || (a.id < b.id ? -1 : 1);
          });
          // If multiple cross-project candidates AND no language preference, log + skip.
          if (remote.length > 1 && remote.every(c => c.language === remote[0]!.language)) {
            ambiguousSkipped++;
            continue;
          }
          const tgt = remote[0]!;
          try {
            await this.prisma.crossProjectEdge.create({
              data: {
                sourceId: r.id,
                sourceProjectId: projectId,
                sourceQn: r.qn,
                sourceLanguage: callerLang,
                targetId: tgt.id,
                targetProjectId: tgt.projectId,
                targetQn: tgt.qualifiedName,
                targetLanguage: tgt.language,
                edgeType: 'calls',
                lineNumber: null,
                confidence: 0.6,
              },
            });
            edgesWritten++;
          } catch (err) {
            // Unique constraint violation → already known, skip silently.
            if (String(err).includes('Unique constraint')) {
              duplicatesSkipped++;
            } else {
              logger.warn(`[cross-project] edge insert failed: ${err}`);
            }
          }
        }
      }
    }
    logger.info(
      `[cross-project] persisted ${edgesWritten} edges across ${projectIds.length} projects ` +
      `(scanned ${sourceNodesScanned} source nodes, dupes ${duplicatesSkipped}, ambiguous ${ambiguousSkipped})`,
    );
    return {
      projectsScanned: projectIds.length,
      sourceNodesScanned,
      edgesWritten,
      duplicatesSkipped,
      ambiguousSkipped,
    };
  }

  /**
   * Resolve unresolved references across multiple projects.
   * Phase 1: builds the global name index and returns its size as a proxy
   * "resolved" count. Phase 2 (persisting cross-project edges) is in
   * resolveCrossProjectEdges() — call that separately so the cost is explicit.
   */
  async resolveAllReferences(projectIds: number[]): Promise<number> {
    if (!projectIds || projectIds.length === 0) return 0;
    try {
      const idx = await this.buildCrossProjectNameIndex(projectIds);
      logger.info(`[cross-project] indexed ${idx.totalNodes} nodes across ${idx.projectsScanned} projects (${idx.distinctNames} distinct names)`);
      return idx.distinctNames;
    } catch (err) {
      logger.warn(`[cross-project] resolveAllReferences failed: ${err}`);
      return 0;
    }
  }

  /**
   * Get graph statistics for a project (Ladybug-authoritative).
   */
  async getGraphStats(projectId: number): Promise<{
    nodeCount: number;
    edgeCount: number;
    unresolvedCount: number;
    lastBuildAt?: Date;
  } | null> {
    const { ladybugQuery } = await import('../graph/ladybugConnection.js');
    const [nc, ec] = await Promise.all([
      ladybugQuery<{ c: number }>(projectId, `MATCH (n:CodeNode {project_id: ${projectId}}) RETURN count(n) AS c`
      ),
      ladybugQuery<{ c: number }>(projectId, `MATCH (n:CodeNode {project_id: ${projectId}})-[e:CodeEdge]->() RETURN count(e) AS c`
      ),
    ]);
    const nodeCount = Number(nc[0]?.c ?? 0);
    const edgeCount = Number(ec[0]?.c ?? 0);
    if (nodeCount === 0 && edgeCount === 0) return null;

    // lastBuildAt is now derived from the project-level lastIndexed timestamp
    // (was previously cached in graphBuildStats, which has been dropped).
    const project = await this.prisma.fantomProject.findUnique({
      where: { id: projectId },
      select: { lastIndexed: true },
    });

    return {
      nodeCount,
      edgeCount,
      unresolvedCount: 0, // tracked inline in build result; not persisted
      lastBuildAt: project?.lastIndexed ?? undefined,
    };
  }

  /**
   * Update project statistics in database
   */
  private async updateProjectStats(
    projectId: number,
    stats: {
      functionCount: number;
      typeCount: number;
      lastIndexed: Date;
      podMeta?: PodMeta;
    }
  ): Promise<void> {
    try {
      await this.prisma.fantomProject.update({
        where: { id: projectId },
        data: {
          functionCount: stats.functionCount,
          typeCount: stats.typeCount,
          lastIndexed: stats.lastIndexed,
          podName: stats.podMeta?.podName
        }
      });
    } catch (err) {
      logger.warn(`Failed to update project stats: ${err}`);
    }
  }

  /**
   * Get the in-memory indexer
   */
  getIndexer(): FantomCodeIndexer {
    return this.indexer;
  }
}

// ============================================
// Factory Function
// ============================================

let serviceInstance: CodeIndexingService | null = null;

/**
 * Get or create the code indexing service
 */
export function getCodeIndexingService(prisma: PrismaClient): CodeIndexingService {
  if (!serviceInstance) {
    serviceInstance = new CodeIndexingService(prisma);
  }
  return serviceInstance;
}

/**
 * Reset the service instance (for testing)
 */
export function resetCodeIndexingService(): void {
  serviceInstance = null;
}
