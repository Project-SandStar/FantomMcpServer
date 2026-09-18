import { promises as fs } from 'fs';
import { join, basename } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../utils/index.js';

const execAsync = promisify(exec);
const logger = createLogger('migration');

export interface MigrationConfig {
  gitlabUrl: string;
  projectName: string;
  workDir: string;
  libPrefix: string;
  skysparkBinPath: string;
  dryRun?: boolean;
}

export interface MigrationResult {
  success: boolean;
  branch: string;
  filesChanged: string[];
  filesCreated: string[];
  compilationSuccess: boolean;
  errors: string[];
  warnings: string[];
  summary: string;
}

export class SkySpark4xMigrator {
  private config: MigrationConfig;
  private projectPath: string;

  constructor(config: MigrationConfig) {
    this.config = config;
    this.projectPath = join(config.workDir, config.projectName);
  }

  /**
   * Main migration workflow
   */
  async migrate(): Promise<MigrationResult> {
    const result: MigrationResult = {
      success: false,
      branch: '4.0.3',
      filesChanged: [],
      filesCreated: [],
      compilationSuccess: false,
      errors: [],
      warnings: [],
      summary: '',
    };

    try {
      logger.info('Starting SkySpark 4.0 migration...');

      // Step 1: Clone repository
      await this.cloneRepository();

      // Step 2: Create backup tag
      await this.createBackup();

      // Step 3: Create and checkout 4.0.3 branch
      await this.createBranch('4.0.3');

      // Step 4: Analyze project structure
      const analysis = await this.analyzeProject();
      logger.info('Project analysis:', analysis);

      // Step 5: Transform code files
      const transformResults = await this.transformCode();
      result.filesChanged = transformResults.changed;

      // Step 6: Create/update lib structure
      if (analysis.isMultiPod) {
        // For multi-pod projects, create lib/ for each pod
        for (const podDir of analysis.podDirs) {
          const podPath = join(this.projectPath, podDir);
          const podAnalysis = await this.analyzePod(podPath, podDir);
          const libResults = await this.createLibStructureForPod(podPath, podAnalysis);
          result.filesCreated.push(...libResults.created);
        }
      } else {
        // Single pod project
        const libResults = await this.createLibStructure(analysis);
        result.filesCreated = libResults.created;
      }

      // Step 7: Update/create buildLocal.fan
      if (analysis.isMultiPod) {
        // For multi-pod projects, collect pod versions first
        const podVersions = new Map<string, string>();
        for (const podDir of analysis.podDirs) {
          const podPath = join(this.projectPath, podDir);
          const buildFanPath = join(podPath, 'build.fan');
          try {
            const buildContent = await fs.readFile(buildFanPath, 'utf-8');
            const versionMatch = buildContent.match(/version\s*=\s*Version\("([^"]+)"\)/);
            if (versionMatch) {
              podVersions.set(podDir, versionMatch[1]);
            }
          } catch (error) {
            // Ignore if build.fan not found
          }
        }
        
        // Now create buildLocal.fan for each pod
        for (const podDir of analysis.podDirs) {
          const podPath = join(this.projectPath, podDir);
          const podAnalysis = await this.analyzePod(podPath, podDir);
          await this.updateBuildFileForPod(podPath, podAnalysis, podVersions);
          result.filesCreated.push(join(podPath, 'buildLocal.fan'));
        }
      } else {
        await this.updateBuildFile(analysis);
      }

      // Step 8: Validate compilation
      if (analysis.isMultiPod) {
        // For multi-pod projects, validate each pod separately
        logger.info('Validating compilation for multi-pod project...');
        const allErrors: string[] = [];
        const allWarnings: string[] = [];
        let allSuccess = true;
        
        for (const podDir of analysis.podDirs) {
          const podPath = join(this.projectPath, podDir);
          logger.info(`Compiling pod: ${podDir}...`);
          const compileResult = await this.validatePodCompilation(podPath, podDir);
          
          if (!compileResult.success) {
            allSuccess = false;
          }
          
          allErrors.push(...compileResult.errors);
          allWarnings.push(...compileResult.warnings);
        }
        
        result.compilationSuccess = allSuccess;
        result.errors = allErrors;
        result.warnings = allWarnings;
      } else {
        const compileResult = await this.validateCompilation();
        result.compilationSuccess = compileResult.success;
        result.errors = compileResult.errors;
        result.warnings = compileResult.warnings;
      }

      // Step 9: Generate summary
      result.summary = this.generateSummary(result);
      result.success = result.compilationSuccess && result.errors.length === 0;

      logger.info('Migration complete:', result.summary);
      return result;
    } catch (error) {
      logger.error('Migration failed:', error);
      result.errors.push(error instanceof Error ? error.message : String(error));
      result.summary = `Migration failed: ${result.errors.join(', ')}`;
      return result;
    }
  }

  /**
   * Commit and push changes after approval
   */
  async commitAndPush(): Promise<void> {
    logger.info('Committing and pushing changes...');

    // Stage all changes
    await this.gitExec('git add .');

    // Commit
    await this.gitExec(`git commit -m "Migrate to SkySpark 4.0.3

- Updated API imports (skyarcd → hx)
- Converted @Axon to @Api facets
- Created lib/ structure with Xeto specs
- Updated buildLocal.fan with ph.lib and xeto.bindings
- Applied ${this.config.libPrefix} library prefix

Auto-migrated by MCP Fantom Server"`);

    // Safety check: ensure not on main
    const { stdout: currentBranch } = await this.gitExec(
      'git rev-parse --abbrev-ref HEAD'
    );
    if (currentBranch.trim() === 'main' || currentBranch.trim() === 'master') {
      throw new Error('SAFETY ERROR: Refusing to push to main branch');
    }

    // Push to 4.0.3 branch
    await this.gitExec('git push origin 4.0.3');
    logger.info('Successfully pushed to origin/4.0.3');
  }

  /**
   * Rollback changes
   */
  async rollback(): Promise<void> {
    logger.info('Rolling back changes...');
    await this.gitExec('git reset --hard pre-migration-backup');
    await this.gitExec('git checkout main');
    logger.info('Rollback complete');
  }

  /**
   * Clone repository from GitLab
   */
  private async cloneRepository(): Promise<void> {
    logger.info(`Cloning ${this.config.gitlabUrl}...`);

    // Check if directory already exists
    try {
      await fs.access(this.projectPath);
      logger.info('Project directory exists, using existing repository...');
      // Make sure we're on the right branch and up to date
      try {
        await this.gitExec('git checkout main || git checkout master');
        await this.gitExec('git pull');
        logger.info('Updated from remote');
      } catch (error) {
        logger.warn('Could not update from remote, continuing with local copy');
      }
    } catch {
      // Directory doesn't exist, clone it
      await execAsync(`git clone ${this.config.gitlabUrl} ${this.projectPath}`);
      logger.info('Repository cloned successfully');
    }
  }

  /**
   * Create backup tag
   */
  private async createBackup(): Promise<void> {
    try {
      await this.gitExec('git tag -d pre-migration-backup');
    } catch {
      // Tag doesn't exist, that's fine
    }
    await this.gitExec('git tag pre-migration-backup');
    logger.info('Created backup tag');
  }

  /**
   * Create new branch
   */
  private async createBranch(branchName: string): Promise<void> {
    try {
      // Try to checkout existing branch
      await this.gitExec(`git checkout ${branchName}`);
      logger.info(`Checked out existing branch: ${branchName}`);
    } catch {
      // Branch doesn't exist, create it
      await this.gitExec(`git checkout -b ${branchName}`);
      logger.info(`Created new branch: ${branchName}`);
    }
  }

  /**
   * Analyze project structure
   */
  private async analyzeProject(): Promise<ProjectAnalysis> {
    logger.info('Analyzing project structure...');

    const analysis: ProjectAnalysis = {
      podName: this.config.projectName,
      hasLib: false,
      hasBuildLocal: false,
      isMultiPod: false,
      podDirs: [],
      fanFiles: [],
      axonFunctions: [],
      dependencies: [],
      extMetadata: {},
    };

    // Check if this is a multi-pod project (BuildGroup)
    try {
      const buildFanPath = join(this.projectPath, 'build.fan');
      const buildContent = await fs.readFile(buildFanPath, 'utf-8');
      if (buildContent.includes('BuildGroup')) {
        analysis.isMultiPod = true;
        analysis.podDirs = await this.findPodDirectories();
        logger.info(`Detected multi-pod project with ${analysis.podDirs.length} pods`);
      }
    } catch {
      // No build.fan or not a BuildGroup
    }

    // Check for lib/ directory
    try {
      await fs.access(join(this.projectPath, 'lib'));
      analysis.hasLib = true;
    } catch {
      analysis.hasLib = false;
    }

    // Check for buildLocal.fan
    try {
      await fs.access(join(this.projectPath, 'buildLocal.fan'));
      analysis.hasBuildLocal = true;
      const buildContent = await fs.readFile(
        join(this.projectPath, 'buildLocal.fan'),
        'utf-8'
      );
      analysis.extMetadata = this.extractBuildMetadata(buildContent);
    } catch {
      analysis.hasBuildLocal = false;
    }

    // Find all .fan files
    analysis.fanFiles = await this.findFanFiles(this.projectPath);
    logger.info(`Found ${analysis.fanFiles.length} Fantom files`);

    // Extract Axon functions
    for (const file of analysis.fanFiles) {
      const content = await fs.readFile(file, 'utf-8');
      const funcs = this.extractAxonFunctions(content);
      analysis.axonFunctions.push(...funcs);
    }

    logger.info(`Found ${analysis.axonFunctions.length} Axon functions`);

    return analysis;
  }

  /**
   * Transform all code files
   */
  private async transformCode(): Promise<{ changed: string[] }> {
    logger.info('Transforming code files...');
    const changed: string[] = [];

    const analysis = await this.analyzeProject();

    for (const file of analysis.fanFiles) {
      const content = await fs.readFile(file, 'utf-8');
      const transformed = this.transformFanFile(content);

      // Check if this is the main extension class file that needs splitting
      if (this.isMainExtensionFile(content, analysis)) {
        // Split into FooExt.fan and FooFuncs.fan
        const split = await this.splitExtensionFile(file, transformed, analysis);
        changed.push(...split.created);
        logger.info(`Split ${basename(file)} into Ext and Funcs files`);
      } else if (transformed !== content) {
        await fs.writeFile(file, transformed, 'utf-8');
        changed.push(file);
        logger.info(`Transformed: ${basename(file)}`);
      }
    }

    return { changed };
  }

  /**
   * Check if this is the main extension file that should be split
   */
  private isMainExtensionFile(content: string, _analysis: ProjectAnalysis): boolean {
    // Check if file contains both extension class and @Api functions
    const hasExtClass = /class\s+\w+(?:Ext|Lib)\s+:\s+(?:Ext|ExtObj|ConnExt)/.test(content);
    const hasApiFunctions = /@(?:Api|Axon)/.test(content);
    
    return hasExtClass && hasApiFunctions;
  }

  /**
   * Split extension file into FooExt.fan and FooFuncs.fan
   */
  private async splitExtensionFile(
    originalFile: string,
    content: string,
    analysis: ProjectAnalysis
  ): Promise<{ created: string[] }> {
    const dir = join(originalFile, '..');
    const podName = analysis.podName;
    
    // Extract extension class and @Api functions
    const extClass = this.extractExtensionClass(content);
    const apiFunctions = this.extractApiFunctionsCode(content);
    const imports = this.extractImports(content);
    
    // Create FooExt.fan
    const extFile = join(dir, `${podName}Ext.fan`);
    const extContent = this.generateExtFile(imports, extClass, podName);
    await fs.writeFile(extFile, extContent, 'utf-8');
    
    // Create FooFuncs.fan if there are @Api functions
    const created = [extFile];
    if (apiFunctions.length > 0) {
      const funcsFile = join(dir, `${podName}Funcs.fan`);
      const funcsContent = this.generateFuncsFile(imports, apiFunctions, podName);
      await fs.writeFile(funcsFile, funcsContent, 'utf-8');
      created.push(funcsFile);
    }
    
    // Remove original file if it had a different name
    if (!originalFile.endsWith(`${podName}Ext.fan`) && !originalFile.endsWith(`${podName}Funcs.fan`)) {
      await fs.unlink(originalFile);
      logger.info(`Removed old file: ${basename(originalFile)}`);
    }
    
    return { created };
  }

  /**
   * Extract using statements
   */
  private extractImports(content: string): string[] {
    const imports: string[] = [];
    const pattern = /^using\s+\w+$/gm;
    let match;
    
    while ((match = pattern.exec(content)) !== null) {
      imports.push(match[0]);
    }
    
    return imports;
  }

  /**
   * Extract extension class definition
   */
  private extractExtensionClass(content: string): string {
    // Match the extension class (not the @Api functions)
    const classPattern = /(?:\/\*\*[\s\S]*?\*\/\s*)?((?:@\w+\s*)*class\s+\w+(?:Ext|Lib)\s+:\s+(?:Ext|ExtObj|ConnExt)[\s\S]*?)(?=\n(?:@(?:Api|Axon)|\/\*\*\s*\n\s*\*\*\s*@(?:Api|Axon))|$)/;
    const match = content.match(classPattern);
    
    return match ? match[1].trim() : '';
  }

  /**
   * Extract @Api function definitions as code blocks
   */
  private extractApiFunctionsCode(content: string): string[] {
    const functions: string[] = [];
    
    // Match @Api/@Axon functions with their doc comments
    const pattern = /((?:\/\*\*[\s\S]*?\*\/\s*)?@(?:Api|Axon)(?:\s*\{[^}]*\})?\s*(?:\/\/.*)?$\s*(?:public\s+)?static\s+\w+\??[\s\S]*?\n\s*\})/gm;
    let match;
    
    while ((match = pattern.exec(content)) !== null) {
      functions.push(match[1].trim());
    }
    
    return functions;
  }

  /**
   * Generate FooExt.fan file content
   */
  private generateExtFile(imports: string[], extClass: string, _podName: string): string {
    return `${imports.join('\n')}\n\n${extClass}\n`;
  }

  /**
   * Generate FooFuncs.fan file content
   */
  private generateFuncsFile(imports: string[], functions: string[], podName: string): string {
    const header = `**\n** ${podName} Axon functions\n**`;
    const className = `${podName}Funcs`;
    
    return `${imports.join('\n')}\n\n${header}\nconst class ${className}\n{\n\n${functions.join('\n\n')}\n\n}\n`;
  }

  /**
   * Transform a single Fantom file
   */
  private transformFanFile(content: string): string {
    let transformed = content;

    // 1. Update using statements - skyarcd, axon, folio, connExt are now in hx 4.0
    //    BUT haystack remains a separate pod in 4.x
    transformed = transformed.replace(/using skyarcd/g, 'using hx');
    transformed = transformed.replace(/using axon/g, 'using hx');
    transformed = transformed.replace(/using folio/g, 'using hx');
    transformed = transformed.replace(/using connExt/g, 'using hx');
    
    // 1a. Deduplicate "using hx" statements
    const lines = transformed.split('\n');
    let hasHxUsing = false;
    const deduped: string[] = [];
    
    for (const line of lines) {
      if (line.trim() === 'using hx') {
        if (!hasHxUsing) {
          deduped.push(line);
          hasHxUsing = true;
        }
        // Skip duplicate using hx lines
      } else {
        deduped.push(line);
        // Reset flag after using block ends (empty line or non-using statement)
        if (!line.trim().startsWith('using') && line.trim() !== '') {
          hasHxUsing = false;
        }
      }
    }
    transformed = deduped.join('\n');

    // 2. Convert @Axon to @Api
    transformed = transformed.replace(/@Axon(\s+)/g, '@Api$1');

    // 2a. Uncomment commented-out @Api and @Axon facets
    // Handles: // @Api, // @Api { admin = true }, // @Axon, etc.
    transformed = transformed.replace(/\/\/\s*(@(?:Api|Axon)(?:\s*\{[^}]*\})?)\s*(?:\/\/.*)?$/gm, '$1');
    
    // Remove TODO comments about converting to @Api
    transformed = transformed.replace(/\/\/\s*TODO:\s*Convert to @Api.*$/gmi, '');

    // 3. Update class names: FooLib -> FooExt or FooFuncs
    transformed = transformed.replace(
      /class\s+(\w+)Lib(\s+:\s+Ext)/g,
      'class $1Ext$2'
    );

    // Also handle ConnLib -> ConnExt for connectors
    transformed = transformed.replace(
      /class\s+(\w+)Lib(\s+:\s+ConnExt)/g,
      'class $1Ext$2'
    );

    // 4. Update API calls: libs.get() -> exts.get()
    transformed = transformed.replace(/\.libs\.get\(/g, '.exts.get(');

    // 5. Update extension lookups to use dotted names
    const libGetPattern = /exts\.get\("([^"]+)"\)/g;
    transformed = transformed.replace(libGetPattern, (match, extName) => {
      // If it's not already dotted, add hx. prefix
      if (!extName.includes('.')) {
        return `exts.get("hx.${extName}")`;
      }
      return match;
    });

    // 6. Update ProjTest -> HxTest
    transformed = transformed.replace(/:\s*ProjTest\b/g, ': HxTest');
    transformed = transformed.replace(/class\s+(\w+)\s+:\s+HxTest/g, 'class $1 : HxTest');

    // 7. Add Context parameter to @Api functions if not present
    const apiMethodPattern = /@Api[^\n]*\n\s*(?:public\s+)?static\s+(\w+\??)\s+(\w+)\s*\(([^)]*)\)/g;
    transformed = transformed.replace(apiMethodPattern, (match, _returnType, _methodName, params) => {
      // Check if Context is already first parameter
      if (!params.trim().startsWith('Context')) {
        const newParams = params.trim() ? `Context cx, ${params}` : 'Context cx';
        return match.replace(`(${params})`, `(${newParams})`);
      }
      return match;
    });

    // 8. Transform Axon code in string literals
    transformed = this.transformAxonInStrings(transformed);

    // 9. Update connector-specific patterns
    transformed = this.transformConnectorPatterns(transformed);

    // 10. Transform Axon API calls in Fantom code (not just strings)
    // Remove ConnFwFuncs prefix - these are now standard APIs in 4.0
    transformed = transformed.replace(/ConnFwFuncs\.connLearn\(/g, 'connLearn(');
    transformed = transformed.replace(/ConnFwFuncs\.connSyncCur\(/g, 'connSyncCur(');
    transformed = transformed.replace(/ConnFwFuncs\.connSyncHis\(/g, 'connSyncHis(');
    transformed = transformed.replace(/ConnFwFuncs\.connWrite\(/g, 'connWrite(');

    return transformed;
  }

  /**
   * Transform Axon code within string literals and triple-quoted strings
   */
  private transformAxonInStrings(content: string): string {
    let transformed = content;

    // Handle triple-quoted strings (Axon code blocks)
    const tripleQuotePattern = /"""([\s\S]*?)"""/g;
    transformed = transformed.replace(tripleQuotePattern, (_match, axonCode) => {
      const transformedAxon = this.transformAxonCode(axonCode);
      return `"""${transformedAxon}"""`;
    });

    // Handle regular string literals containing Axon-like code
    // Be conservative - only transform obvious Axon patterns
    const stringPattern = /"([^"]*(?:addExt|libGet|watchSub|watchUnsub)[^"]*)"/g;
    transformed = transformed.replace(stringPattern, (_match, str) => {
      const transformedStr = this.transformAxonCode(str);
      return `"${transformedStr}"`;
    });

    return transformed;
  }

  /**
   * Transform Axon code syntax (for both Axon strings and Fantom code calling Axon APIs)
   */
  private transformAxonCode(axonCode: string): string {
    let transformed = axonCode;

    // 1. addExt() -> libAdd()
    transformed = transformed.replace(/addExt\(/g, 'libAdd(');

    // 2. Update extension names in libAdd/libGet
    transformed = transformed.replace(/libAdd\("([^"]+)"\)/g, (match, extName) => {
      if (!extName.includes('.')) {
        return `libAdd("hx.${extName}")`;
      }
      return match;
    });

    // 3. libGet() -> exts.get() (in Axon context)
    transformed = transformed.replace(/libGet\("([^"]+)"\)/g, (_match, extName) => {
      const dottedName = extName.includes('.') ? extName : `hx.${extName}`;
      return `exts.get("${dottedName}")`;
    });

    // 4. watchSub() -> watchAdd()
    transformed = transformed.replace(/watchSub\(/g, 'watchAdd(');

    // 5. watchUnsub() -> watchRemove()
    transformed = transformed.replace(/watchUnsub\(/g, 'watchRemove(');

    // 6. Connector framework functions (ConnFwFuncs)
    // connLearn() is now the standard API in 4.0
    transformed = transformed.replace(/ConnFwFuncs\.connLearn\(/g, 'connLearn(');
    transformed = transformed.replace(/ConnFwFuncs\.connSyncCur\(/g, 'connSyncCur(');
    transformed = transformed.replace(/ConnFwFuncs\.connSyncHis\(/g, 'connSyncHis(');
    transformed = transformed.replace(/ConnFwFuncs\.connWrite\(/g, 'connWrite(');
    
    // 7. Mark deprecated functions with warnings
    transformed = transformed.replace(/degreeDayHisSrc\(/g, '/* DEPRECATED: degreeDayHisSrc */ degreeDayHisSrc(');
    transformed = transformed.replace(/\binvoke\(/g, '/* DEPRECATED: invoke */ invoke(');
    transformed = transformed.replace(/invokeAction\(/g, '/* DEPRECATED: invokeAction */ invokeAction(');

    return transformed;
  }

  /**
   * Transform connector-specific patterns
   */
  private transformConnectorPatterns(content: string): string {
    let transformed = content;

    // 1. connExt framework -> hxConn framework
    transformed = transformed.replace(/using connExt/g, 'using hxConn');

    // 2. Check for connModel() method and suggest modelName()
    if (content.includes('connModel()')) {
      transformed = transformed.replace(
        /override\s+Str\s+connModel\(\)/g,
        '// MIGRATION NOTE: connModel() renamed to modelName() in 4.0\n  override Str modelName()'
      );
    }

    // 3. Update connDupRef and connPointsVia calls to use dotted names
    const connRefPattern = /conn(?:DupRef|PointsVia)\("([^"]+)"\)/g;
    transformed = transformed.replace(connRefPattern, (match, extName) => {
      if (!extName.includes('.')) {
        return match.replace(`"${extName}"`, `"hx.${extName}"`);
      }
      return match;
    });

    return transformed;
  }

  /**
   * Create lib/ structure with Xeto specs
   */
  private async createLibStructure(analysis: ProjectAnalysis): Promise<{ created: string[] }> {
    logger.info('Creating lib/ structure...');
    const created: string[] = [];
    const libDir = join(this.projectPath, 'lib');

    // Create lib/ directory if it doesn't exist
    await fs.mkdir(libDir, { recursive: true });

    // Create lib.trio
    const libTrioPath = join(libDir, 'lib.trio');
    const libTrio = this.generateLibTrio(analysis);
    await fs.writeFile(libTrioPath, libTrio, 'utf-8');
    created.push(libTrioPath);
    logger.info('Created lib.trio');

    // Create funcs.xeto if there are Axon functions
    if (analysis.axonFunctions.length > 0) {
      const funcsXetoPath = join(libDir, 'funcs.xeto');
      const funcsXeto = this.generateFuncsXeto(analysis.axonFunctions);
      await fs.writeFile(funcsXetoPath, funcsXeto, 'utf-8');
      created.push(funcsXetoPath);
      logger.info('Created funcs.xeto');
    }

    // Analyze and create settings.xeto if settings are detected
    const settings = await this.analyzeSettings(analysis);
    if (settings && settings.fields.length > 0) {
      const settingsXetoPath = join(libDir, 'settings.xeto');
      const settingsXeto = this.generateSettingsXeto(settings);
      await fs.writeFile(settingsXetoPath, settingsXeto, 'utf-8');
      created.push(settingsXetoPath);
      logger.info('Created settings.xeto with configuration schema');
    }

    // Create lib.xeto with connector notes if applicable
    const libXetoPath = join(libDir, 'lib.xeto');
    const isConnector = await this.isConnectorExtension(analysis);
    let libXeto = this.generateLibXeto(analysis);
    
    if (isConnector) {
      libXeto += this.generateConnectorNotes(analysis.podName);
      logger.info('Detected connector extension - added migration notes');
    }
    
    await fs.writeFile(libXetoPath, libXeto, 'utf-8');
    created.push(libXetoPath);
    logger.info('Created lib.xeto');

    return { created };
  }

  /**
   * Analyze individual pod in multi-pod project
   */
  private async analyzePod(podPath: string, podName: string): Promise<ProjectAnalysis> {
    logger.info(`Analyzing pod: ${podName}...`);

    const analysis: ProjectAnalysis = {
      podName: podName,
      hasLib: false,
      hasBuildLocal: false,
      isMultiPod: false,
      podDirs: [],
      fanFiles: [],
      axonFunctions: [],
      dependencies: [],
      extMetadata: {},
    };

    // Check for lib/ directory
    try {
      await fs.access(join(podPath, 'lib'));
      analysis.hasLib = true;
    } catch {
      analysis.hasLib = false;
    }

    // Check for buildLocal.fan
    try {
      await fs.access(join(podPath, 'buildLocal.fan'));
      analysis.hasBuildLocal = true;
      const buildContent = await fs.readFile(join(podPath, 'buildLocal.fan'), 'utf-8');
      analysis.extMetadata = this.extractBuildMetadata(buildContent);
    } catch {
      // Try build.fan instead
      try {
        const buildContent = await fs.readFile(join(podPath, 'build.fan'), 'utf-8');
        analysis.extMetadata = this.extractBuildMetadata(buildContent);
        analysis.hasBuildLocal = false;
      } catch {
        analysis.hasBuildLocal = false;
      }
    }

    // Find all .fan files in this pod
    analysis.fanFiles = await this.findFanFiles(podPath);
    logger.info(`Found ${analysis.fanFiles.length} Fantom files in ${podName}`);

    // Extract Axon functions
    for (const file of analysis.fanFiles) {
      const content = await fs.readFile(file, 'utf-8');
      const funcs = this.extractAxonFunctions(content);
      analysis.axonFunctions.push(...funcs);
    }

    logger.info(`Found ${analysis.axonFunctions.length} Axon functions in ${podName}`);

    return analysis;
  }

  /**
   * Create lib structure for individual pod
   */
  private async createLibStructureForPod(podPath: string, analysis: ProjectAnalysis): Promise<{ created: string[] }> {
    logger.info(`Creating lib/ structure for pod: ${analysis.podName}...`);
    const created: string[] = [];
    const libDir = join(podPath, 'lib');

    // Create lib/ directory if it doesn't exist
    await fs.mkdir(libDir, { recursive: true });

    // Create lib.trio
    const libTrioPath = join(libDir, 'lib.trio');
    const libTrio = this.generateLibTrio(analysis);
    await fs.writeFile(libTrioPath, libTrio, 'utf-8');
    created.push(libTrioPath);
    logger.info(`Created lib.trio for ${analysis.podName}`);

    // Create funcs.xeto if there are Axon functions
    if (analysis.axonFunctions.length > 0) {
      const funcsXetoPath = join(libDir, 'funcs.xeto');
      const funcsXeto = this.generateFuncsXeto(analysis.axonFunctions);
      await fs.writeFile(funcsXetoPath, funcsXeto, 'utf-8');
      created.push(funcsXetoPath);
      logger.info(`Created funcs.xeto for ${analysis.podName}`);
    }

    // Analyze and create settings.xeto if settings are detected
    const settings = await this.analyzeSettings(analysis);
    if (settings && settings.fields.length > 0) {
      const settingsXetoPath = join(libDir, 'settings.xeto');
      const settingsXeto = this.generateSettingsXeto(settings);
      await fs.writeFile(settingsXetoPath, settingsXeto, 'utf-8');
      created.push(settingsXetoPath);
      logger.info(`Created settings.xeto for ${analysis.podName}`);
    }

    // Create lib.xeto
    const libXetoPath = join(libDir, 'lib.xeto');
    const isConnector = await this.isConnectorExtension(analysis);
    let libXeto = this.generateLibXeto(analysis);
    
    if (isConnector) {
      libXeto += this.generateConnectorNotes(analysis.podName);
      logger.info(`Detected connector in ${analysis.podName} - added migration notes`);
    }
    
    await fs.writeFile(libXetoPath, libXeto, 'utf-8');
    created.push(libXetoPath);
    logger.info(`Created lib.xeto for ${analysis.podName}`);

    return { created };
  }

  /**
   * Update or create buildLocal.fan for individual pod
   */
  private async updateBuildFileForPod(podPath: string, analysis: ProjectAnalysis, podVersions: Map<string, string>): Promise<void> {
    const buildLocalPath = join(podPath, 'buildLocal.fan');
    const buildFanPath = join(podPath, 'build.fan');

    // Always create fresh buildLocal.fan from build.fan (cleaner approach)
    try {
      const buildContent = await fs.readFile(buildFanPath, 'utf-8');
      logger.info(`Creating buildLocal.fan from build.fan for ${analysis.podName}...`);
      
      // Extract metadata from build.fan
      const metadata = this.extractBuildMetadata(buildContent);
      
      // Generate clean buildLocal.fan without StackHub dependencies
      const buildLocal = this.generateBuildLocalFromBuildFan(buildContent, analysis, metadata, podVersions);
      
      await fs.writeFile(buildLocalPath, buildLocal, 'utf-8');
      logger.info(`Created buildLocal.fan for ${analysis.podName}`);
    } catch (error) {
      // No build.fan, create new buildLocal.fan from scratch
      logger.info(`Creating new buildLocal.fan for ${analysis.podName}...`);
      const newBuild = this.generateBuildLocal(analysis);
      await fs.writeFile(buildLocalPath, newBuild, 'utf-8');
    }
  }

  /**
   * Update or create buildLocal.fan
   */
  private async updateBuildFile(analysis: ProjectAnalysis): Promise<void> {
    // Skip build file generation for multi-pod projects
    if (analysis.isMultiPod) {
      logger.info('Multi-pod project detected - skipping root build file generation');
      logger.info('Each pod should have its own build.fan or buildLocal.fan');
      return;
    }

    const buildLocalPath = join(this.projectPath, 'buildLocal.fan');
    const buildFanPath = join(this.projectPath, 'build.fan');

    // Try to create from build.fan first (cleaner approach)
    try {
      const buildContent = await fs.readFile(buildFanPath, 'utf-8');
      logger.info('Creating buildLocal.fan from build.fan...');
      
      // Extract metadata from build.fan
      const metadata = this.extractBuildMetadata(buildContent);
      
      // For single-pod, create empty podVersions (not needed)
      const podVersions = new Map<string, string>();
      
      // Generate clean buildLocal.fan
      const buildLocal = this.generateBuildLocalFromBuildFan(buildContent, analysis, metadata, podVersions);
      
      await fs.writeFile(buildLocalPath, buildLocal, 'utf-8');
      logger.info('Created buildLocal.fan');
    } catch (error) {
      // No build.fan, create new buildLocal.fan from scratch
      logger.info('Creating new buildLocal.fan...');
      const newBuild = this.generateBuildLocal(analysis);
      await fs.writeFile(buildLocalPath, newBuild, 'utf-8');
    }
  }

  /**
   * Validate compilation with SkySpark fan compiler
   */
  private async validateCompilation(): Promise<{
    success: boolean;
    errors: string[];
    warnings: string[];
  }> {
    logger.info('Validating compilation...');

    const result = {
      success: false,
      errors: [] as string[],
      warnings: [] as string[],
    };

    try {
      const fanPath = join(this.config.skysparkBinPath, 'fan');
      const { stdout, stderr } = await execAsync(
        `${fanPath} buildLocal.fan`,
        { cwd: this.projectPath }
      );

      // Check output for errors/warnings
      const output = stdout + stderr;

      if (output.includes('BUILD SUCCESS')) {
        result.success = true;
        logger.info('Compilation successful');
      } else if (output.includes('ERROR') || output.includes('error')) {
        result.errors.push(output);
        logger.error('Compilation failed:', output);
      }

      // Extract warnings
      const warningMatches = output.match(/WARN:.*$/gm);
      if (warningMatches) {
        result.warnings.push(...warningMatches);
      }
    } catch (error: any) {
      result.errors.push(error.message || String(error));
      logger.error('Compilation error:', error);
    }

    return result;
  }

  /**
   * Validate compilation for individual pod
   */
  private async validatePodCompilation(podPath: string, podName: string): Promise<{
    success: boolean;
    errors: string[];
    warnings: string[];
  }> {
    logger.info(`Validating compilation for pod: ${podName}...`);

    const result = {
      success: false,
      errors: [] as string[],
      warnings: [] as string[],
    };

    try {
      const fanPath = join(this.config.skysparkBinPath, 'fan');
      const { stdout, stderr } = await execAsync(
        `${fanPath} buildLocal.fan`,
        { cwd: podPath }
      );

      // Check output for errors/warnings
      const output = stdout + stderr;

      if (output.includes('BUILD SUCCESS')) {
        result.success = true;
        logger.info(`Pod ${podName} compiled successfully`);
      } else if (output.includes('ERROR') || output.includes('error')) {
        result.errors.push(`[${podName}] ${output}`);
        logger.error(`Pod ${podName} compilation failed:`, output);
      }

      // Extract warnings
      const warningMatches = output.match(/WARN:.*$/gm);
      if (warningMatches) {
        result.warnings.push(...warningMatches.map(w => `[${podName}] ${w}`));
      }
    } catch (error: any) {
      const errMsg = `[${podName}] ${error.message || String(error)}`;
      result.errors.push(errMsg);
      logger.error(`Pod ${podName} compilation error:`, error);
    }

    return result;
  }

  /**
   * Generate lib.trio content
   */
  private generateLibTrio(analysis: ProjectAnalysis): string {
    const metadata = analysis.extMetadata;
    const libName = analysis.podName.toLowerCase();
    const qualifiedName = `${this.config.libPrefix}.${libName}`;
    const typeName = `${analysis.podName}::${analysis.podName}Ext`;
    
    // Build depends list with proper format: [^lib:ph, ^lib:hx, ...]
    const depends = ['ph', 'hx', ...analysis.dependencies.map(d => d.replace(/\s.*$/, ''))];
    const dependsStr = depends.map(d => `^lib:${d}`).join(', ');

    return `--------------------------------------------------------------------------
def: ^lib:${qualifiedName}
depends: [${dependsStr}]
typeName:"${typeName}"
doc: "${metadata.doc || 'Migrated to SkySpark 4.0'}"
--------------------------------------------------------------------------
`;
  }

  /**
   * Generate funcs.xeto content
   */
  private generateFuncsXeto(functions: AxonFunction[]): string {
    let content = '// Axon functions\n\n';

    for (const func of functions) {
      content += `${func.name}: Func {\n`;
      content += `  doc: "${func.doc || func.name}"\n`;

      // Add parameters
      for (const param of func.params) {
        content += `  ${param.name}: ${param.type || 'Obj'}${param.optional ? '?' : ''}\n`;
      }

      // Add return type
      if (func.returnType) {
        content += `  returns: ${func.returnType}\n`;
      }

      content += `}\n\n`;
    }

    return content;
  }

  /**
   * Generate lib.xeto content
   */
  private generateLibXeto(_analysis: ProjectAnalysis): string {
    return `// Xeto specifications


// Add custom type specs here as needed
`;
  }

  /**
   * Generate new buildLocal.fan
   */
  private generateBuildLocal(analysis: ProjectAnalysis): string {
    const libName = analysis.podName.toLowerCase();
    const fullLibName = `${this.config.libPrefix}.${libName}`;

    return `#!/usr/bin/env fan

using build

**
** Build: ${analysis.podName} (Local build)
**
class BuildLocal : BuildPod {
  new make() {
    podName = "${analysis.podName}"
    version = Version("4.0.0")
    depends = [
      "sys 1.0",
      "hx 4.0"${analysis.dependencies.map(dep => `,\n      "${dep}"`).join('')}
    ]
    srcDirs = [\`fan/\`]
    resDirs = [\`lib/\`]
    index = ["xeto.bindings":"${fullLibName}", "ph.lib": "${libName}"]
  }
}
`;
  }

  /**
   * Generate buildLocal.fan from existing build.fan
   */
  private generateBuildLocalFromBuildFan(buildContent: string, analysis: ProjectAnalysis, metadata: Record<string, string>, podVersions: Map<string, string>): string {
    const libName = analysis.podName.toLowerCase();
    const fullLibName = `${this.config.libPrefix}.${libName}`;
    
    // Extract key information from build.fan
    const podName = analysis.podName;
    const version = '4.0.3'; // Always use 4.0.3 for migrated pods
    const summary = metadata.doc || `${podName} extension`;
    
    // Extract meta section and clean it up
    const metaMatch = buildContent.match(/meta\s*=\s*\[([\s\S]*?)\]/);
    // Organization stamped into migrated build.fan meta. Configurable so the
    // tool is not tied to one company: MIGRATION_ORG_NAME / MIGRATION_ORG_URI.
    const orgName = process.env.MIGRATION_ORG_NAME?.trim() || 'Your Organization';
    const orgUri = process.env.MIGRATION_ORG_URI?.trim() || 'https://example.com/';
    let metaContent = metaMatch ? metaMatch[1].trim() : `"org.name": "${orgName}",\n      "org.uri": "${orgUri}"`;

    // Clean up meta: remove commented lines and replace the Fantom template placeholder
    if (metaContent) {
      // Remove commented lines
      metaContent = metaContent
        .split('\n')
        .filter(line => !line.trim().startsWith('//'))
        .join('\n')
        .trim();

      // If it still has the "Acme" placeholder from the pod template, replace it
      if (metaContent.includes('"Acme"')) {
        metaContent = metaContent.replace(/"org\.name":\s*"Acme"/, `"org.name": "${orgName}"`);
        // Add org.uri if missing
        if (!metaContent.includes('org.uri')) {
          metaContent = metaContent.replace(
            /("org\.name":[^\n]+)/,
            `$1\n      "org.uri": "${orgUri}",`
          );
        }
      }
    }
    
    // Extract depends - clean up and update for 4.0
    const dependsMatch = buildContent.match(/depends\s*=\s*\[([\s\S]*?)\]/);
    const deps: string[] = [];
    
    if (dependsMatch) {
      const seen = new Set<string>();
      seen.add('sys'); // We'll add this ourselves
      seen.add('hx');  // We'll add this ourselves
      
      const rawDeps = dependsMatch[1]
        .split(/[\n,]/)
        .map(d => d.trim())
        .filter(d => d && d.length > 0)
        .map(d => d.replace(/\/\/.*$/, '').trim()) // Remove comments
        .filter(d => d && !d.startsWith('//'));
      
      for (let dep of rawDeps) {
        // Remove quotes and extract pod name and version
        const depMatch = dep.match(/["']([^"'\s]+)\s+([^"']+)["']/);
        if (!depMatch) continue;
        
        const [, depPodName, podVersion] = depMatch;
        
        // Skip if already seen
        if (seen.has(depPodName)) continue;
        
        // Skip old 3.x deps that are now in hx (but keep haystack - it's still separate in 4.x)
        if (['folio', 'axon', 'skyarcd', 'connExt'].includes(depPodName)) {
          continue;
        }
        
        // Update haystack version to 4.0.3
        if (depPodName === 'haystack') {
          seen.add(depPodName);
          deps.push(`"haystack 4.0.3"`);
          continue;
        }
        
        // Skip fresco - it was removed in 4.x (replaced by domkit/graphics)
        if (depPodName === 'fresco') {
          continue;
        }
        
        // Update versions for SkySpark pods
        let newVersion = podVersion;
        if (['skyarc', 'ui'].includes(depPodName)) {
          newVersion = '4.0.3';
        } else if (podVersions.has(depPodName)) {
          // Use actual version from pod build files for local pods
          newVersion = podVersions.get(depPodName)!;
        }
        
        seen.add(depPodName);
        deps.push(`"${depPodName} ${newVersion}"`);
      }
    }
    
    let depends = '"sys 1.0",\n               "hx 4.0"';
    if (deps.length > 0) {
      depends += ',\n               ' + deps.join(',\n               ');
    }
    
    // Extract srcDirs
    const srcDirsMatch = buildContent.match(/srcDirs\s*=\s*\[([\s\S]*?)\]/);
    const srcDirs = srcDirsMatch ? srcDirsMatch[1].trim() : '`fan/`';
    
    // Extract resDirs
    const resDirsMatch = buildContent.match(/resDirs\s*=\s*\[([\s\S]*?)\]/);
    const resDirs = resDirsMatch ? resDirsMatch[1].trim() : '`lib/`';
    
    return `#!/usr/bin/env fan

using build

**
** Build: ${podName} (Local build without StackHub)
**
class BuildLocal : BuildPod {
  new make()
  {
    podName = "${podName}"
    summary = "${summary}"
    version = Version("${version}")
    meta    = [
                ${metaContent}
              ]
    depends = [${depends}]
    srcDirs = [${srcDirs}]
    resDirs = [${resDirs}]
    index   = ["xeto.bindings":"${fullLibName}", "ph.lib": "${libName}"]
  }
}
`;
  }

  /**
   * Extract build metadata from build file
   */
  private extractBuildMetadata(content: string): Record<string, string> {
    const metadata: Record<string, string> = {};

    const patterns = {
      version: /version\s*=\s*Version\("([^"]+)"\)/,
      dis: /"ext\.name":\s*"([^"]+)"/,
      icon: /"ext\.icon":\s*"([^"]+)"/,
      doc: /summary\s*=\s*"([^"]+)"/,
    };

    for (const [key, pattern] of Object.entries(patterns)) {
      const match = content.match(pattern);
      if (match) {
        metadata[key] = match[1];
      }
    }

    return metadata;
  }

  /**
   * Extract Axon functions from Fantom code
   */
  private extractAxonFunctions(content: string): AxonFunction[] {
    const functions: AxonFunction[] = [];

    // Match @Axon or @Api functions (including commented-out ones that will be uncommented)
    const pattern = /(?:\/\/\s*)?@(?:Axon|Api)(?:\s*\{[^}]*\})?\s*(?:\/\/.*)?$\s*(?:public\s+)?static\s+(\w+\??)\s+(\w+)\s*\(([^)]*)\)/gm;
    let match;

    while ((match = pattern.exec(content)) !== null) {
      const [, returnType, name, paramsStr] = match;

      // Parse parameters
      const params: FunctionParam[] = [];
      if (paramsStr.trim()) {
        const paramParts = paramsStr.split(',');
        for (const part of paramParts) {
          const paramMatch = part.trim().match(/(\w+\??)\s+(\w+)(?:\s*:?=\s*(.+))?/);
          if (paramMatch) {
            const [, type, paramName, defaultValue] = paramMatch;
            // Skip Context parameter
            if (type !== 'Context') {
              params.push({
                name: paramName,
                type: this.mapFantomTypeToXeto(type),
                optional: !!defaultValue,
              });
            }
          }
        }
      }

      functions.push({
        name,
        returnType: this.mapFantomTypeToXeto(returnType),
        params,
        doc: '',
      });
    }

    return functions;
  }

  /**
   * Map Fantom types to Xeto types with enhanced detection
   */
  private mapFantomTypeToXeto(fantomType: string): string {
    // Handle nullable types
    const isNullable = fantomType.endsWith('?');
    const baseType = isNullable ? fantomType.slice(0, -1) : fantomType;

    // Handle array/list types
    if (baseType.endsWith('[]')) {
      return isNullable ? 'List?' : 'List';
    }

    // Handle generic List types
    const listMatch = baseType.match(/List<(.+)>/);
    if (listMatch) {
      // Note: Xeto doesn't support generics in same way as Fantom
      // We just use List and add type info in doc/comments
      return isNullable ? `List?` : 'List';
    }

    // Handle generic Dict types  
    const dictMatch = baseType.match(/Dict<(.+),\s*(.+)>/);
    if (dictMatch) {
      return isNullable ? 'Dict?' : 'Dict';
    }

    // Basic type mappings
    const typeMap: Record<string, string> = {
      'Str': 'Str',
      'Int': 'Number',
      'Float': 'Number',
      'Decimal': 'Number',
      'Duration': 'Number',
      'Bool': 'Bool',
      'Obj': 'Obj',
      'Dict': 'Dict',
      'List': 'List',
      'Ref': 'Ref',
      'Void': 'Void',
      'Date': 'Date',
      'Time': 'Time',
      'DateTime': 'DateTime',
      'Uri': 'Uri',
      'Buf': 'Buf',
      'Grid': 'Grid',
      'Number': 'Number',
      'Marker': 'Marker',
    };

    const xetoType = typeMap[baseType] || 'Obj';  // Default to Obj for unknown types
    return isNullable ? `${xetoType}?` : xetoType;
  }

  /**
   * Analyze project for extension settings
   */
  private async analyzeSettings(analysis: ProjectAnalysis): Promise<ExtensionSettings | null> {
    logger.info('Analyzing extension settings...');

    const settings: ExtensionSettings = {
      fields: [],
      hasSettings: false,
    };

    // Look for settings patterns in fan files
    for (const file of analysis.fanFiles) {
      const content = await fs.readFile(file, 'utf-8');

      // Find @Config fields (common in connectors)
      const configPattern = /@Config\s+(\w+\??)\s+(\w+)\s*:?=\s*(.+)?/g;
      let match;

      while ((match = configPattern.exec(content)) !== null) {
        const [, type, name, defaultValue] = match;
        settings.fields.push({
          name,
          type: this.mapFantomTypeToXeto(type),
          defaultValue: defaultValue?.trim().replace(/["']/g, ''),
          doc: `Configuration field: ${name}`,
        });
        settings.hasSettings = true;
      }

      // Look for explicit settings patterns
      if (content.includes('settings') || content.includes('config')) {
        settings.hasSettings = true;
      }
    }

    return settings.hasSettings ? settings : null;
  }

  /**
   * Generate settings.xeto file
   */
  private generateSettingsXeto(settings: ExtensionSettings): string {
    let content = '// Extension settings\n\n';
    content += 'Settings: Dict {\n';
    content += '  doc: "Extension configuration settings"\n\n';

    for (const field of settings.fields) {
      content += `  ${field.name}: ${field.type}`;
      
      if (field.defaultValue) {
        content += ` <def:${this.formatDefaultValue(field.type, field.defaultValue)}>`;
      }
      
      content += ' {\n';
      content += `    doc: "${field.doc}"\n`;
      content += '  }\n\n';
    }

    content += '}\n';
    return content;
  }

  /**
   * Format default value for Xeto
   */
  private formatDefaultValue(type: string, value: string): string {
    const baseType = type.replace('?', '');
    
    if (baseType === 'Str') {
      return `"${value}"`;
    } else if (baseType === 'Number') {
      return value;
    } else if (baseType === 'Bool') {
      return value.toLowerCase();
    }
    
    return value;
  }

  /**
   * Detect if this is a connector extension
   */
  private async isConnectorExtension(analysis: ProjectAnalysis): Promise<boolean> {
    for (const file of analysis.fanFiles) {
      const content = await fs.readFile(file, 'utf-8');
      
      // Check for connector-related patterns
      if (content.includes(': ConnExt') || 
          content.includes('extends ConnExt') ||
          content.includes('using hxConn') ||
          content.includes('using connExt')) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Find pod directories in a multi-pod project
   */
  private async findPodDirectories(): Promise<string[]> {
    const podDirs: string[] = [];
    const entries = await fs.readdir(this.projectPath, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const podPath = join(this.projectPath, entry.name);
        
        // Check if this directory has a build.fan or buildLocal.fan
        try {
          await fs.access(join(podPath, 'build.fan'));
          podDirs.push(entry.name);
        } catch {
          try {
            await fs.access(join(podPath, 'buildLocal.fan'));
            podDirs.push(entry.name);
          } catch {
            // Not a pod directory
          }
        }
      }
    }
    
    return podDirs;
  }

  /**
   * Generate connector-specific notes
   */
  private generateConnectorNotes(projectName: string): string {
    return `
// CONNECTOR MIGRATION NOTES:
//
// Model Name Inference:
// - Library name: akbin.${projectName}
// - Inferred model name: ${projectName} (last segment of lib name)
//
// If you need a different model name (e.g., camelCase), override modelName():
//   override Str modelName() { "customName" }
//
// Connector Framework:
// - Old connExt framework is NO LONGER SUPPORTED
// - Must use hxConn framework (should already be converted)
//
// Discovery:
// - Implement onDiscover() for device/point discovery
// - Use proper Haystack tags in discovered records
//
// Point Mapping:
// - Ensure points have proper connRef to this connector
// - Use connector-specific tags for addressing (e.g., modbusReg, bacnetObj)
`;
  }

  /**
   * Find all .fan files recursively
   */
  private async findFanFiles(dir: string): Promise<string[]> {
    const files: string[] = [];

    async function scan(currentDir: string) {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(currentDir, entry.name);

        if (entry.isDirectory()) {
          // Skip certain directories
          if (!['node_modules', '.git', 'build', 'lib'].includes(entry.name)) {
            await scan(fullPath);
          }
        } else if (entry.isFile() && entry.name.endsWith('.fan')) {
          files.push(fullPath);
        }
      }
    }

    await scan(dir);
    return files;
  }

  /**
   * Generate migration summary
   */
  private generateSummary(result: MigrationResult): string {
    const parts = [
      `Migration to SkySpark 4.0.3 ${result.success ? 'COMPLETED' : 'FAILED'}`,
      `Files changed: ${result.filesChanged.length}`,
      `Files created: ${result.filesCreated.length}`,
      `Compilation: ${result.compilationSuccess ? 'SUCCESS' : 'FAILED'}`,
    ];

    if (result.errors.length > 0) {
      parts.push(`Errors: ${result.errors.length}`);
    }

    if (result.warnings.length > 0) {
      parts.push(`Warnings: ${result.warnings.length}`);
    }

    return parts.join('\n');
  }

  /**
   * Execute git command in project directory
   */
  private async gitExec(command: string): Promise<{ stdout: string; stderr: string }> {
    return execAsync(command, { cwd: this.projectPath });
  }
}

// Type definitions
interface ProjectAnalysis {
  podName: string;
  hasLib: boolean;
  hasBuildLocal: boolean;
  isMultiPod: boolean;
  podDirs: string[];
  fanFiles: string[];
  axonFunctions: AxonFunction[];
  dependencies: string[];
  extMetadata: Record<string, string>;
}

interface AxonFunction {
  name: string;
  returnType: string;
  params: FunctionParam[];
  doc: string;
}

interface FunctionParam {
  name: string;
  type: string;
  optional: boolean;
}

interface ExtensionSettings {
  fields: SettingsField[];
  hasSettings: boolean;
}

interface SettingsField {
  name: string;
  type: string;
  defaultValue?: string;
  doc: string;
}
