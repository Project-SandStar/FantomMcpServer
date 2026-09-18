/**
 * Project Management Agent
 * Handles SkySpark project operations, environment management, and migration workflows
 */

import {
  BaseAgent,
  ToolDefinition,
  ToolResult,
  PrimaryProjectContext,
  AgentEvents,
} from '../base/index.js';

export class ProjectManagementAgent extends BaseAgent {
  readonly name = 'project-management';
  readonly description = 'Handle SkySpark project operations, environment management, and migration workflows';
  readonly category = 'project-management';

  private primaryProject: PrimaryProjectContext | null = null;
  private migrator?: any; // SkySpark4xMigrator instance

  // Callbacks for external state management
  private onPrimaryProjectChange?: (context: PrimaryProjectContext) => void;
  private getPrimaryProjectExternal?: () => PrimaryProjectContext | null;
  private setPrimaryProjectExternal?: (context: PrimaryProjectContext) => Promise<void>;

  constructor(options: any) {
    super(options);
    this.migrator = options.migrator;
    this.onPrimaryProjectChange = options.onPrimaryProjectChange;
    this.getPrimaryProjectExternal = options.getPrimaryProjectExternal;
    this.setPrimaryProjectExternal = options.setPrimaryProjectExternal;

    // Load initial state
    if (this.getPrimaryProjectExternal) {
      this.primaryProject = this.getPrimaryProjectExternal();
    }
  }

  protected async doInitialize(): Promise<void> {
    this.logger.info('Initializing Project Management Agent...');
  }

  getTools(): ToolDefinition[] {
    return [
      this.createToolDefinition(
        'project_setPrimary',
        'Set the primary project context for subsequent operations',
        {
          type: 'object',
          properties: {
            instance: { type: 'string', description: 'SkySpark instance name' },
            project: { type: 'string', description: 'Project name' },
            setBy: {
              type: 'string',
              enum: ['vscode', 'dashboard', 'api', 'agent'],
              description: 'Source of the change',
            },
          },
          required: ['instance', 'project'],
        },
        ['project', 'context', 'primary', 'active', 'set', 'switch'],
        ['setting active project', 'switching project context', 'configuring working project'],
        ['project_getPrimary', 'project_listProjects']
      ),

      this.createToolDefinition(
        'project_getPrimary',
        'Get the current primary project context',
        {
          type: 'object',
          properties: {},
        },
        ['project', 'context', 'current', 'active', 'get'],
        ['checking current project', 'viewing active context', 'getting working project'],
        ['project_setPrimary']
      ),

      this.createToolDefinition(
        'project_detectEnvironment',
        'Detect SkySpark environment from a path',
        {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to check for SkySpark environment' },
          },
          required: ['path'],
        },
        ['detect', 'environment', 'skyspark', 'haxall', 'version', 'scan'],
        ['detecting SkySpark installation', 'checking environment version', 'scanning for SkySpark'],
        ['project_getConfig']
      ),

      this.createToolDefinition(
        'project_migrate4x',
        'Migrate a SkySpark 3.x project to 4.0',
        {
          type: 'object',
          properties: {
            gitlabUrl: { type: 'string', description: 'GitLab repository URL' },
            projectName: { type: 'string', description: 'Project name for the migration' },
            workDir: { type: 'string', description: 'Working directory for the migration' },
            dryRun: { type: 'boolean', description: 'Perform a dry run without making changes' },
          },
          required: ['gitlabUrl', 'projectName'],
        },
        ['migrate', 'upgrade', 'skyspark', '4.0', '4.x', 'conversion', 'xeto'],
        ['migrating to SkySpark 4.0', 'upgrading 3.x project', 'converting to 4.x'],
        ['project_commitMigration', 'project_rollbackMigration', 'migrateSkySpark4x']
      ),

      this.createToolDefinition(
        'project_commitMigration',
        'Commit migration changes to git',
        {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Path to the migrated project' },
            message: { type: 'string', description: 'Commit message' },
          },
          required: ['projectPath'],
        },
        ['commit', 'git', 'save', 'migration', 'push'],
        ['committing migration changes', 'saving migration to git', 'finalizing migration'],
        ['project_migrate4x', 'project_rollbackMigration', 'commitMigration']
      ),

      this.createToolDefinition(
        'project_rollbackMigration',
        'Rollback migration changes',
        {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Path to the project to rollback' },
          },
          required: ['projectPath'],
        },
        ['rollback', 'undo', 'revert', 'migration', 'reset'],
        ['reverting migration changes', 'undoing migration', 'restoring previous state'],
        ['project_migrate4x', 'project_commitMigration', 'rollbackMigration']
      ),

      this.createToolDefinition(
        'project_listProjects',
        'List available projects',
        {
          type: 'object',
          properties: {
            instanceFilter: { type: 'string', description: 'Filter by instance name' },
          },
        },
        ['projects', 'list', 'available', 'pods', 'instances'],
        ['listing all projects', 'viewing available projects', 'browsing project list'],
        ['project_setPrimary', 'project_getConfig']
      ),

      this.createToolDefinition(
        'project_getConfig',
        'Get project configuration',
        {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Path to the project' },
          },
          required: ['projectPath'],
        },
        ['config', 'configuration', 'settings', 'build', 'pod'],
        ['viewing project configuration', 'checking build settings', 'getting pod config'],
        ['project_listProjects', 'project_detectEnvironment']
      ),
    ];
  }

  async executeTool(toolName: string, params: Record<string, any>): Promise<ToolResult> {
    const startTime = Date.now();
    this.updateActivity();

    try {
      switch (toolName) {
        case 'project_setPrimary':
          return this.doSetPrimary(params, startTime);

        case 'project_getPrimary':
          return this.doGetPrimary(params, startTime);

        case 'project_detectEnvironment':
          return this.doDetectEnvironment(params, startTime);

        case 'project_migrate4x':
          return this.doMigrate4x(params, startTime);

        case 'project_commitMigration':
          return this.doCommitMigration(params, startTime);

        case 'project_rollbackMigration':
          return this.doRollbackMigration(params, startTime);

        case 'project_listProjects':
          return this.doListProjects(params, startTime);

        case 'project_getConfig':
          return this.doGetConfig(params, startTime);

        default:
          return this.createToolResult(false, null, `Unknown tool: ${toolName}`, startTime);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error executing ${toolName}:`, err);
      return this.createToolResult(false, null, error, startTime);
    }
  }

  // Tool implementations

  private async doSetPrimary(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const validationError = this.validateParams(params, ['instance', 'project']);
    if (validationError) {
      return this.createToolResult(false, null, validationError, startTime);
    }

    const context: PrimaryProjectContext = {
      instance: params.instance,
      project: params.project,
      setBy: params.setBy || 'agent',
      timestamp: new Date(),
    };

    this.primaryProject = context;

    // Persist externally if callback provided
    if (this.setPrimaryProjectExternal) {
      await this.setPrimaryProjectExternal(context);
    }

    // Notify callback if provided
    if (this.onPrimaryProjectChange) {
      this.onPrimaryProjectChange(context);
    }

    this.publishEvent(AgentEvents.PROJECT_CHANGED, context);

    return this.createToolResult(true, {
      success: true,
      context,
    }, undefined, startTime);
  }

  private async doGetPrimary(_params: Record<string, any>, startTime: number): Promise<ToolResult> {
    // Get from external source if available
    const context = this.getPrimaryProjectExternal
      ? this.getPrimaryProjectExternal()
      : this.primaryProject;

    return this.createToolResult(true, {
      context,
      isSet: context !== null,
    }, undefined, startTime);
  }

  private async doDetectEnvironment(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const validationError = this.validateParams(params, ['path']);
    if (validationError) {
      return this.createToolResult(false, null, validationError, startTime);
    }

    try {
      const fs = await import('fs/promises');
      const path = await import('path');

      const checkPath = params.path;
      const stat = await fs.stat(checkPath).catch(() => null);

      if (!stat) {
        return this.createToolResult(false, null, `Path does not exist: ${checkPath}`, startTime);
      }

      // Check for SkySpark indicators
      const indicators = {
        hasLibDir: false,
        hasProjDir: false,
        hasFanFile: false,
        hasEtcDir: false,
        version: 'unknown',
      };

      const dirContents: string[] = await fs.readdir(checkPath).catch(() => [] as string[]);

      indicators.hasLibDir = dirContents.includes('lib');
      indicators.hasProjDir = dirContents.includes('proj');
      indicators.hasEtcDir = dirContents.includes('etc');
      indicators.hasFanFile = dirContents.some((f) => f.endsWith('.fan'));

      // Try to detect version from lib/fan
      const fanLibPath = path.join(checkPath, 'lib', 'fan');
      const fanLibExists = await fs.stat(fanLibPath).catch(() => null);

      if (fanLibExists) {
        const fanLibContents: string[] = await fs.readdir(fanLibPath).catch(() => [] as string[]);
        if (fanLibContents.includes('skyarcd.pod')) {
          indicators.version = '4.x';
        } else if (fanLibContents.includes('skyspark.pod')) {
          indicators.version = '3.x';
        }
      }

      const isSkySpark = indicators.hasLibDir || indicators.hasProjDir || indicators.hasEtcDir;

      return this.createToolResult(true, {
        path: checkPath,
        isSkySpark,
        indicators,
        version: indicators.version,
      }, undefined, startTime);
    } catch (err) {
      return this.createToolResult(false, null, `Failed to detect environment: ${err}`, startTime);
    }
  }

  private async doMigrate4x(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const validationError = this.validateParams(params, ['gitlabUrl', 'projectName']);
    if (validationError) {
      return this.createToolResult(false, null, validationError, startTime);
    }

    this.setBusy();

    try {
      // Use provided migrator or create one dynamically
      let migrator = this.migrator;
      if (!migrator) {
        const { SkySpark4xMigrator } = await import('../../migration/index.js');
        migrator = new SkySpark4xMigrator({
          gitlabUrl: params.gitlabUrl,
          projectName: params.projectName,
          workDir: params.workDir || '/tmp/migration',
          libPrefix: 'akbin',
          skysparkBinPath: params.skysparkBinPath || '',
          dryRun: params.dryRun,
        });
      }

      const result = await migrator.migrate();

      this.publishEvent(AgentEvents.PROJECT_MIGRATED, {
        projectName: params.projectName,
        success: result.success,
      });

      return this.createToolResult(true, result, undefined, startTime);
    } catch (err) {
      return this.createToolResult(false, null, `Migration failed: ${err}`, startTime);
    } finally {
      this.setReady();
    }
  }

  private async doCommitMigration(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const validationError = this.validateParams(params, ['projectPath']);
    if (validationError) {
      return this.createToolResult(false, null, validationError, startTime);
    }

    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      const message = params.message || 'SkySpark 4.x migration';

      await execAsync(`cd "${params.projectPath}" && git add -A`);
      await execAsync(
        `cd "${params.projectPath}" && git commit -m "${message}" --author="MCP Migration <mcp@migration.local>"`
      );

      return this.createToolResult(true, {
        success: true,
        projectPath: params.projectPath,
        message,
      }, undefined, startTime);
    } catch (err) {
      return this.createToolResult(false, null, `Commit failed: ${err}`, startTime);
    }
  }

  private async doRollbackMigration(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const validationError = this.validateParams(params, ['projectPath']);
    if (validationError) {
      return this.createToolResult(false, null, validationError, startTime);
    }

    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      await execAsync(`cd "${params.projectPath}" && git reset --hard HEAD~1`);

      return this.createToolResult(true, {
        success: true,
        projectPath: params.projectPath,
        message: 'Migration rolled back',
      }, undefined, startTime);
    } catch (err) {
      return this.createToolResult(false, null, `Rollback failed: ${err}`, startTime);
    }
  }

  private async doListProjects(_params: Record<string, any>, startTime: number): Promise<ToolResult> {
    // Return placeholder - actual implementation would scan configured directories
    return this.createToolResult(true, {
      projects: [],
      message: 'Project listing requires configuration of project directories',
    }, undefined, startTime);
  }

  private async doGetConfig(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const validationError = this.validateParams(params, ['projectPath']);
    if (validationError) {
      return this.createToolResult(false, null, validationError, startTime);
    }

    try {
      const fs = await import('fs/promises');
      const path = await import('path');

      // Look for build.fan
      const buildPath = path.join(params.projectPath, 'build.fan');
      const buildContent = await fs.readFile(buildPath, 'utf-8').catch(() => null);

      // Look for pod.props
      const propsPath = path.join(params.projectPath, 'pod.props');
      const propsContent = await fs.readFile(propsPath, 'utf-8').catch(() => null);

      const config: any = {
        path: params.projectPath,
        hasBuildFan: buildContent !== null,
        hasPodProps: propsContent !== null,
      };

      // Parse build.fan for pod name
      if (buildContent) {
        const podNameMatch = buildContent.match(/podName\s*=\s*"([^"]+)"/);
        if (podNameMatch) {
          config.podName = podNameMatch[1];
        }

        const versionMatch = buildContent.match(/version\s*=\s*Version\("([^"]+)"\)/);
        if (versionMatch) {
          config.version = versionMatch[1];
        }
      }

      return this.createToolResult(true, config, undefined, startTime);
    } catch (err) {
      return this.createToolResult(false, null, `Failed to get config: ${err}`, startTime);
    }
  }

  // Public accessor
  getPrimaryProject(): PrimaryProjectContext | null {
    return this.getPrimaryProjectExternal
      ? this.getPrimaryProjectExternal()
      : this.primaryProject;
  }
}
