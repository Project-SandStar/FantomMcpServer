/**
 * Code Analysis Agent
 * Provides static analysis capabilities for Fantom source code,
 * including parsing, AST traversal, symbol extraction, and code intelligence
 */

import {
  BaseAgent,
  ToolDefinition,
  ToolResult,
  Symbol,
  SymbolType,
  AgentEvents,
} from '../base/index.js';
import {
  FantomCodeIndexer,
  getFantomCodeIndexer,
  type FantomProject,
} from '../../fantom-code/index.js';
import { getFantomDatabase } from '../../fantom/database.js';

interface ParsedUnit {
  success: boolean;
  symbols: Symbol[];
  errors: Array<{ line: number; column: number; message: string }>;
  ast?: any;
}

export class CodeAnalysisAgent extends BaseAgent {
  readonly name = 'code-analysis';
  readonly description = 'Static analysis for Fantom source code including parsing, AST, and code intelligence';
  readonly category = 'code-analysis';

  private codeIndexer: FantomCodeIndexer;
  private indexReady: boolean = false;

  constructor(options: any) {
    super(options);
    this.codeIndexer = options.codeIndexer ?? getFantomCodeIndexer();
  }

  protected async doInitialize(): Promise<void> {
    this.logger.info('Initializing Code Analysis Agent...');

    // Load indexed projects in the background — must not block init
    // (SQLite lock contention from a concurrent server can stall this for minutes).
    this.loadIndexedProjects().catch((err) => {
      this.logger.warn(`Background project indexing failed: ${err}`);
    });
  }

  /**
   * Load projects from database and index them
   */
  private async loadIndexedProjects(): Promise<void> {
    try {
      const db = getFantomDatabase();
      await db.initialize();
      const projects = await db.getAutoIndexProjects();

      this.logger.info(`Loading ${projects.length} projects for code indexing...`);

      for (const dbProject of projects) {
        const project: FantomProject = {
          id: dbProject.id,
          name: dbProject.name,
          path: dbProject.path,
          instanceId: dbProject.instanceId,
          functionCount: dbProject.functionCount,
          typeCount: dbProject.typeCount,
          lastIndexed: dbProject.lastIndexed,
          createdAt: dbProject.createdAt,
          updatedAt: dbProject.updatedAt,
        };

        try {
          const result = await this.codeIndexer.indexProject(project);
          this.logger.debug(`Indexed project ${project.name}: ${result.functionsIndexed} functions, ${result.typesIndexed} types`);

          // Update stats in database
          await db.updateProjectIndexStats(project.id, result.functionsIndexed, result.typesIndexed);
        } catch (err) {
          this.logger.warn(`Failed to index project ${project.name}: ${err}`);
        }
      }

      const stats = this.codeIndexer.getStats();
      this.logger.info(`Code indexer ready: ${stats.totalFunctions} functions, ${stats.totalTypes} types`);
      this.indexReady = true;
    } catch (error) {
      this.logger.warn(`Failed to load indexed projects: ${error}`);
    }
  }

  getTools(): ToolDefinition[] {
    return [
      this.createToolDefinition(
        'code_parse',
        'Parse Fantom source code and return AST',
        {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Fantom source code content' },
            filePath: { type: 'string', description: 'Path to .fan file (alternative to content)' },
          },
        },
        ['parse', 'AST', 'syntax', 'analyze', 'source', 'code'],
        ['parsing Fantom source', 'analyzing code structure', 'getting syntax tree'],
        ['code_getSymbols', 'code_validateSyntax']
      ),

      this.createToolDefinition(
        'code_getSymbols',
        'Extract all symbols (classes, methods, fields) from source',
        {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Fantom source code' },
            symbolTypes: {
              type: 'array',
              items: { type: 'string', enum: ['class', 'mixin', 'enum', 'method', 'field', 'facet', 'const'] },
              description: 'Filter by symbol types',
            },
          },
          required: ['content'],
        },
        ['symbols', 'extract', 'classes', 'methods', 'fields', 'outline'],
        ['extracting code symbols', 'getting document outline', 'listing all definitions'],
        ['code_parse', 'code_findDefinition']
      ),

      this.createToolDefinition(
        'code_findDefinition',
        'Find where a symbol is defined',
        {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Path to source file' },
            line: { type: 'number', description: 'Line number (1-based)' },
            column: { type: 'number', description: 'Column number (1-based)' },
          },
          required: ['filePath', 'line', 'column'],
        },
        ['definition', 'goto', 'navigate', 'find', 'declaration', 'location'],
        ['finding symbol definition', 'navigating to declaration', 'locating where defined'],
        ['code_findReferences', 'code_getSymbols']
      ),

      this.createToolDefinition(
        'code_findReferences',
        'Find all references to a symbol',
        {
          type: 'object',
          properties: {
            qualifiedName: { type: 'string', description: 'Qualified symbol name' },
            scope: {
              type: 'string',
              enum: ['file', 'pod', 'workspace'],
              description: 'Search scope (default: workspace)',
            },
          },
          required: ['qualifiedName'],
        },
        ['references', 'usages', 'find', 'where', 'used', 'callers'],
        ['finding all references', 'locating symbol usages', 'finding where used'],
        ['code_findDefinition', 'code_getCallHierarchy']
      ),

      this.createToolDefinition(
        'code_getCompletions',
        'Get code completions at cursor position',
        {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Source code content' },
            line: { type: 'number', description: 'Line number (1-based)' },
            column: { type: 'number', description: 'Column number (1-based)' },
          },
          required: ['content', 'line', 'column'],
        },
        ['completions', 'autocomplete', 'intellisense', 'suggestions', 'code'],
        ['getting code completions', 'autocomplete suggestions', 'intellisense at position'],
        ['code_getSymbols']
      ),

      this.createToolDefinition(
        'code_validateSyntax',
        'Validate Fantom syntax without full compilation',
        {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Fantom source code' },
          },
          required: ['content'],
        },
        ['validate', 'syntax', 'check', 'errors', 'lint', 'verify'],
        ['validating syntax', 'checking for errors', 'verifying code'],
        ['code_parse', 'gen_validateCode']
      ),

      this.createToolDefinition(
        'code_extractDependencies',
        'Extract pod dependencies from using statements',
        {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Fantom source code' },
            filePath: { type: 'string', description: 'Path to source file (alternative)' },
          },
        },
        ['dependencies', 'using', 'imports', 'pods', 'extract'],
        ['extracting dependencies', 'listing imports', 'finding used pods'],
        ['code_parse']
      ),

      this.createToolDefinition(
        'code_getCallHierarchy',
        'Get incoming/outgoing call hierarchy for a method',
        {
          type: 'object',
          properties: {
            qualifiedName: { type: 'string', description: 'Qualified method name' },
            direction: {
              type: 'string',
              enum: ['incoming', 'outgoing', 'both'],
              description: 'Call direction (default: both)',
            },
            depth: { type: 'number', description: 'Maximum depth to traverse (default: 3)' },
          },
          required: ['qualifiedName'],
        },
        ['call', 'hierarchy', 'callers', 'callees', 'incoming', 'outgoing'],
        ['viewing call hierarchy', 'finding callers', 'tracing method calls'],
        ['code_findReferences', 'code_findDefinition']
      ),
    ];
  }

  async executeTool(toolName: string, params: Record<string, any>): Promise<ToolResult> {
    const startTime = Date.now();
    this.updateActivity();

    try {
      switch (toolName) {
        case 'code_parse':
          return this.doParse(params, startTime);

        case 'code_getSymbols':
          return this.doGetSymbols(params, startTime);

        case 'code_findDefinition':
          return this.doFindDefinition(params, startTime);

        case 'code_findReferences':
          return this.doFindReferences(params, startTime);

        case 'code_getCompletions':
          return this.doGetCompletions(params, startTime);

        case 'code_validateSyntax':
          return this.doValidateSyntax(params, startTime);

        case 'code_extractDependencies':
          return this.doExtractDependencies(params, startTime);

        case 'code_getCallHierarchy':
          return this.doGetCallHierarchy(params, startTime);

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

  private async doParse(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const { content, filePath } = params;

    let sourceCode = content;
    if (!sourceCode && filePath) {
      try {
        const fs = await import('fs/promises');
        sourceCode = await fs.readFile(filePath, 'utf-8');
      } catch (err) {
        return this.createToolResult(false, null, `Failed to read file: ${filePath}`, startTime);
      }
    }

    if (!sourceCode) {
      return this.createToolResult(false, null, 'Either content or filePath is required', startTime);
    }

    const parsed = this.parseSource(sourceCode);

    this.publishEvent(AgentEvents.CODE_PARSED, {
      success: parsed.success,
      symbolCount: parsed.symbols.length,
    });

    return this.createToolResult(true, {
      success: parsed.success,
      symbols: parsed.symbols,
      errors: parsed.errors,
      lineCount: sourceCode.split('\n').length,
    }, undefined, startTime);
  }

  private async doGetSymbols(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const { content, symbolTypes } = params;

    const validationError = this.validateParams(params, ['content']);
    if (validationError) {
      return this.createToolResult(false, null, validationError, startTime);
    }

    const parsed = this.parseSource(content);
    let symbols = parsed.symbols;

    if (symbolTypes && symbolTypes.length > 0) {
      symbols = symbols.filter(s => symbolTypes.includes(s.type));
    }

    this.publishEvent(AgentEvents.CODE_SYMBOLS_EXTRACTED, { count: symbols.length });

    return this.createToolResult(true, {
      symbolCount: symbols.length,
      symbols: symbols.map(s => ({
        name: s.name,
        type: s.type,
        qualifiedName: s.qualifiedName,
        signature: s.signature,
        location: s.location,
        modifiers: s.modifiers,
      })),
    }, undefined, startTime);
  }

  private async doFindDefinition(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const { filePath, line, column } = params;

    const validationError = this.validateParams(params, ['filePath', 'line', 'column']);
    if (validationError) {
      return this.createToolResult(false, null, validationError, startTime);
    }

    // Read file and find symbol at position
    try {
      const fs = await import('fs/promises');
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');

      if (line < 1 || line > lines.length) {
        return this.createToolResult(false, null, `Line ${line} out of range`, startTime);
      }

      const lineContent = lines[line - 1];
      const word = this.getWordAtPosition(lineContent, column);

      if (!word) {
        return this.createToolResult(false, null, 'No symbol at position', startTime);
      }

      // Search in current file first
      const parsed = this.parseSource(content);
      const localDefinition = parsed.symbols.find(s => s.name === word);

      if (localDefinition) {
        return this.createToolResult(true, {
          symbol: word,
          source: 'local',
          definition: {
            name: localDefinition.name,
            type: localDefinition.type,
            qualifiedName: localDefinition.qualifiedName,
            location: { ...localDefinition.location, filePath },
            signature: localDefinition.signature,
          },
        }, undefined, startTime);
      }

      // Search in workspace index
      if (this.indexReady) {
        // Try to find as a type
        const typeMatch = this.codeIndexer.getTypeByQualifiedName(word) ||
          this.codeIndexer.getAllTypes().find(t => t.name === word);

        if (typeMatch) {
          return this.createToolResult(true, {
            symbol: word,
            source: 'workspace',
            definition: {
              name: typeMatch.name,
              type: typeMatch.kind,
              qualifiedName: typeMatch.qualifiedName,
              location: { line: typeMatch.lineNumber, filePath: typeMatch.filePath },
              signature: `${typeMatch.kind} ${typeMatch.name}${typeMatch.extends ? ` : ${typeMatch.extends}` : ''}`,
            },
          }, undefined, startTime);
        }

        // Try to find as a function/method
        const funcMatch = this.codeIndexer.getFunctionByQualifiedName(word) ||
          this.codeIndexer.searchByName(word, 1)[0];

        if (funcMatch) {
          return this.createToolResult(true, {
            symbol: word,
            source: 'workspace',
            definition: {
              name: funcMatch.name,
              type: funcMatch.type,
              qualifiedName: funcMatch.qualifiedName,
              location: { line: funcMatch.lineNumber, filePath: funcMatch.filePath },
              signature: funcMatch.signature,
            },
          }, undefined, startTime);
        }
      }

      return this.createToolResult(true, {
        symbol: word,
        definition: null,
        message: this.indexReady
          ? 'Definition not found in current file or workspace'
          : 'Definition not found in current file (workspace index not ready)',
      }, undefined, startTime);
    } catch (err) {
      return this.createToolResult(false, null, `Failed to read file: ${err}`, startTime);
    }
  }

  private async doFindReferences(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const { qualifiedName, scope = 'workspace' } = params;

    const validationError = this.validateParams(params, ['qualifiedName']);
    if (validationError) {
      return this.createToolResult(false, null, validationError, startTime);
    }

    // Extract simple name from qualified name
    const simpleName = qualifiedName.includes('::')
      ? qualifiedName.split('::').pop()!.split('.').pop()!
      : qualifiedName.split('.').pop()!;

    const references: Array<{
      filePath: string;
      line?: number;
      qualifiedName: string;
      type: string;
      context?: string;
    }> = [];

    if (!this.indexReady) {
      return this.createToolResult(true, {
        qualifiedName,
        scope,
        references: [],
        message: 'Workspace index not ready - no projects indexed yet',
      }, undefined, startTime);
    }

    // Search for types that reference this symbol (via extends, mixins)
    const allTypes = this.codeIndexer.getAllTypes();
    for (const type of allTypes) {
      // Check if type extends the target
      if (type.extends === qualifiedName || type.extends === simpleName) {
        references.push({
          filePath: type.filePath,
          line: type.lineNumber,
          qualifiedName: type.qualifiedName,
          type: 'extends',
          context: `${type.kind} ${type.name} : ${type.extends}`,
        });
      }

      // Check if type implements the target as a mixin
      if (type.mixins.includes(qualifiedName) || type.mixins.includes(simpleName)) {
        references.push({
          filePath: type.filePath,
          line: type.lineNumber,
          qualifiedName: type.qualifiedName,
          type: 'mixin',
          context: `${type.kind} ${type.name} : ${type.mixins.join(', ')}`,
        });
      }
    }

    // Search for functions that reference this symbol (via return type, parameters)
    const allFunctions = this.codeIndexer.getAllFunctions();
    for (const func of allFunctions) {
      // Check return type
      if (func.returnType === qualifiedName || func.returnType === simpleName) {
        references.push({
          filePath: func.filePath,
          line: func.lineNumber,
          qualifiedName: func.qualifiedName,
          type: 'return-type',
          context: func.signature,
        });
      }

      // Check parameters
      for (const param of func.parameters) {
        if (param.type === qualifiedName || param.type === simpleName) {
          references.push({
            filePath: func.filePath,
            line: func.lineNumber,
            qualifiedName: func.qualifiedName,
            type: 'parameter',
            context: func.signature,
          });
          break; // Only count each function once
        }
      }
    }

    return this.createToolResult(true, {
      qualifiedName,
      scope,
      referenceCount: references.length,
      references: references.slice(0, 50), // Limit results
      message: references.length === 0
        ? `No references found for "${simpleName}" in indexed projects`
        : undefined,
    }, undefined, startTime);
  }

  private async doGetCompletions(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const { content, line, column } = params;

    const validationError = this.validateParams(params, ['content', 'line', 'column']);
    if (validationError) {
      return this.createToolResult(false, null, validationError, startTime);
    }

    const lines = content.split('\n');
    if (line < 1 || line > lines.length) {
      return this.createToolResult(false, null, `Line ${line} out of range`, startTime);
    }

    const lineContent = lines[line - 1];
    const prefix = lineContent.substring(0, column - 1);

    // Parse to get available symbols from current file
    const parsed = this.parseSource(content);

    // Generate completions based on context (includes keywords and local symbols)
    const completions = this.generateCompletions(prefix, parsed.symbols);

    // Add completions from workspace index
    if (this.indexReady) {
      const lastWord = prefix.trim().split(/\s+/).pop()?.toLowerCase() || '';
      const existingLabels = new Set(completions.map(c => c.label));

      // Add types from workspace
      const workspaceTypes = this.codeIndexer.getAllTypes()
        .filter(t => t.name.toLowerCase().startsWith(lastWord) && !existingLabels.has(t.name))
        .slice(0, 15);

      for (const type of workspaceTypes) {
        completions.push({
          label: type.name,
          kind: type.kind,
          detail: type.qualifiedName,
          source: 'workspace',
        });
      }

      // Add functions from workspace (public only)
      const workspaceFuncs = this.codeIndexer.getAllFunctions()
        .filter(f => f.isPublic && f.name.toLowerCase().startsWith(lastWord) && !existingLabels.has(f.name))
        .slice(0, 15);

      for (const func of workspaceFuncs) {
        completions.push({
          label: func.name,
          kind: func.type,
          detail: func.signature || func.qualifiedName,
          source: 'workspace',
        });
      }
    }

    return this.createToolResult(true, {
      position: { line, column },
      prefix: prefix.trim().split(/\s+/).pop() || '',
      completionCount: completions.length,
      completions: completions.slice(0, 50), // Limit total completions
      workspaceIndexed: this.indexReady,
    }, undefined, startTime);
  }

  private async doValidateSyntax(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const { content } = params;

    const validationError = this.validateParams(params, ['content']);
    if (validationError) {
      return this.createToolResult(false, null, validationError, startTime);
    }

    const parsed = this.parseSource(content);

    this.publishEvent(AgentEvents.CODE_VALIDATED, {
      valid: parsed.success,
      errorCount: parsed.errors.length,
    });

    return this.createToolResult(true, {
      valid: parsed.success,
      errors: parsed.errors,
      warnings: [],
    }, undefined, startTime);
  }

  private async doExtractDependencies(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const { content, filePath } = params;

    let sourceCode = content;
    if (!sourceCode && filePath) {
      try {
        const fs = await import('fs/promises');
        sourceCode = await fs.readFile(filePath, 'utf-8');
      } catch (err) {
        return this.createToolResult(false, null, `Failed to read file: ${filePath}`, startTime);
      }
    }

    if (!sourceCode) {
      return this.createToolResult(false, null, 'Either content or filePath is required', startTime);
    }

    const dependencies = this.extractUsingStatements(sourceCode);

    return this.createToolResult(true, {
      dependencies,
      count: dependencies.length,
    }, undefined, startTime);
  }

  private async doGetCallHierarchy(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const { qualifiedName, direction = 'both', depth = 3 } = params;

    const validationError = this.validateParams(params, ['qualifiedName']);
    if (validationError) {
      return this.createToolResult(false, null, validationError, startTime);
    }

    if (!this.indexReady) {
      return this.createToolResult(true, {
        qualifiedName,
        direction,
        depth,
        incoming: [],
        outgoing: [],
        message: 'Workspace index not ready - no projects indexed yet',
      }, undefined, startTime);
    }

    // Find the target function/method
    const targetFunc = this.codeIndexer.getFunctionByQualifiedName(qualifiedName) ||
      this.codeIndexer.searchByName(qualifiedName.split('.').pop() || qualifiedName, 1)[0];

    if (!targetFunc) {
      return this.createToolResult(true, {
        qualifiedName,
        direction,
        depth,
        incoming: [],
        outgoing: [],
        message: `Function "${qualifiedName}" not found in indexed projects`,
      }, undefined, startTime);
    }

    const incoming: Array<{ qualifiedName: string; filePath: string; line?: number; signature?: string }> = [];
    const outgoing: Array<{ qualifiedName: string; filePath: string; line?: number; signature?: string }> = [];

    // For incoming calls: find functions that might call this method
    // This is a heuristic - we look for functions in the same class or that have this method's class as a parameter/return type
    if (direction === 'incoming' || direction === 'both') {
      const allFunctions = this.codeIndexer.getAllFunctions();
      const targetClassName = targetFunc.className;

      for (const func of allFunctions) {
        if (func.id === targetFunc.id) continue;

        // Check if this function is in the same class (could call our target)
        if (func.className === targetClassName && func.name !== targetFunc.name) {
          incoming.push({
            qualifiedName: func.qualifiedName,
            filePath: func.filePath,
            line: func.lineNumber,
            signature: func.signature,
          });
        }

        // Check if this function has our class as a parameter type (likely uses it)
        const usesTargetClass = func.parameters.some(p => p.type === targetClassName);
        if (usesTargetClass && incoming.length < 20) {
          if (!incoming.some(i => i.qualifiedName === func.qualifiedName)) {
            incoming.push({
              qualifiedName: func.qualifiedName,
              filePath: func.filePath,
              line: func.lineNumber,
              signature: func.signature,
            });
          }
        }
      }
    }

    // For outgoing calls: analyze what types/methods might be called from this function
    // This is based on parameter types and return types
    if (direction === 'outgoing' || direction === 'both') {
      // Get methods of types used as parameters
      for (const param of targetFunc.parameters) {
        const paramType = this.codeIndexer.getTypeByQualifiedName(param.type) ||
          this.codeIndexer.getAllTypes().find(t => t.name === param.type);

        if (paramType) {
          // Add public methods of this type as potential outgoing calls
          for (const method of paramType.methods.slice(0, 5)) {
            if (method.isPublic) {
              outgoing.push({
                qualifiedName: method.qualifiedName,
                filePath: method.filePath,
                line: method.lineNumber,
                signature: method.signature,
              });
            }
          }
        }
      }

      // Get methods of the return type
      if (targetFunc.returnType && targetFunc.returnType !== 'Void') {
        const returnType = this.codeIndexer.getTypeByQualifiedName(targetFunc.returnType) ||
          this.codeIndexer.getAllTypes().find(t => t.name === targetFunc.returnType);

        if (returnType) {
          for (const method of returnType.methods.slice(0, 5)) {
            if (method.isPublic && !outgoing.some(o => o.qualifiedName === method.qualifiedName)) {
              outgoing.push({
                qualifiedName: method.qualifiedName,
                filePath: method.filePath,
                line: method.lineNumber,
                signature: method.signature,
              });
            }
          }
        }
      }
    }

    return this.createToolResult(true, {
      qualifiedName,
      direction,
      depth,
      target: {
        name: targetFunc.name,
        qualifiedName: targetFunc.qualifiedName,
        filePath: targetFunc.filePath,
        line: targetFunc.lineNumber,
        signature: targetFunc.signature,
      },
      incomingCount: incoming.length,
      incoming: incoming.slice(0, 20),
      outgoingCount: outgoing.length,
      outgoing: outgoing.slice(0, 20),
      note: 'Call hierarchy is based on static type analysis; actual runtime calls may differ',
    }, undefined, startTime);
  }

  // Helper methods

  private parseSource(content: string): ParsedUnit {
    const symbols: Symbol[] = [];
    const errors: Array<{ line: number; column: number; message: string }> = [];
    const lines = content.split('\n');

    let currentClass: string | null = null;
    let braceDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Track brace depth
      braceDepth += (line.match(/\{/g) || []).length;
      braceDepth -= (line.match(/\}/g) || []).length;

      // Match class/mixin/enum declarations
      const classMatch = line.match(/^\s*(abstract\s+)?(class|mixin|enum)\s+(\w+)/);
      if (classMatch) {
        currentClass = classMatch[3];
        symbols.push({
          name: classMatch[3],
          type: classMatch[2] as SymbolType,
          qualifiedName: classMatch[3],
          location: { line: lineNum, column: 1 },
          modifiers: classMatch[1] ? ['abstract'] : [],
        });
        continue;
      }

      // Match field declarations (simplified)
      const fieldMatch = line.match(/^\s*(static\s+)?(const\s+)?(\w+)\s+(\w+)(\s*:=|\s*$)/);
      if (fieldMatch && currentClass && braceDepth > 0) {
        symbols.push({
          name: fieldMatch[4],
          type: fieldMatch[2] ? 'const' : 'field',
          qualifiedName: `${currentClass}.${fieldMatch[4]}`,
          location: { line: lineNum, column: line.indexOf(fieldMatch[4]) + 1 },
          signature: `${fieldMatch[3]} ${fieldMatch[4]}`,
          modifiers: [
            ...(fieldMatch[1] ? ['static'] : []),
            ...(fieldMatch[2] ? ['const'] : []),
          ],
        });
        continue;
      }

      // Match method declarations (simplified)
      const methodMatch = line.match(
        /^\s*(static\s+)?(override\s+)?(abstract\s+)?(\w+)\s+(\w+)\s*\(/
      );
      if (methodMatch && currentClass && braceDepth > 0) {
        symbols.push({
          name: methodMatch[5],
          type: 'method',
          qualifiedName: `${currentClass}.${methodMatch[5]}`,
          location: { line: lineNum, column: line.indexOf(methodMatch[5]) + 1 },
          signature: line.trim(),
          modifiers: [
            ...(methodMatch[1] ? ['static'] : []),
            ...(methodMatch[2] ? ['override'] : []),
            ...(methodMatch[3] ? ['abstract'] : []),
          ],
        });
      }

      // Reset current class at depth 0
      if (braceDepth === 0) {
        currentClass = null;
      }
    }

    return {
      success: errors.length === 0,
      symbols,
      errors,
    };
  }

  private getWordAtPosition(line: string, column: number): string | null {
    const before = line.substring(0, column);
    const after = line.substring(column - 1);

    const beforeMatch = before.match(/[\w]+$/);
    const afterMatch = after.match(/^[\w]+/);

    if (beforeMatch || afterMatch) {
      return (beforeMatch?.[0] || '') + (afterMatch?.[0]?.substring(1) || '');
    }
    return null;
  }

  private generateCompletions(prefix: string, symbols: Symbol[]): any[] {
    const lastWord = prefix.trim().split(/\s+/).pop() || '';
    const completions: any[] = [];

    // Add Fantom keywords
    const keywords = [
      'class', 'mixin', 'enum', 'abstract', 'virtual', 'override',
      'static', 'const', 'final', 'native', 'once', 'new',
      'return', 'if', 'else', 'while', 'for', 'foreach', 'switch', 'case',
      'try', 'catch', 'finally', 'throw', 'using', 'true', 'false', 'null',
    ];

    for (const kw of keywords) {
      if (kw.startsWith(lastWord.toLowerCase())) {
        completions.push({ label: kw, kind: 'keyword', detail: 'Keyword' });
      }
    }

    // Add symbols from current file
    for (const symbol of symbols) {
      if (symbol.name.toLowerCase().startsWith(lastWord.toLowerCase())) {
        completions.push({
          label: symbol.name,
          kind: symbol.type,
          detail: symbol.signature || symbol.qualifiedName,
        });
      }
    }

    return completions.slice(0, 20);
  }

  private extractUsingStatements(content: string): string[] {
    const dependencies: string[] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      const match = line.match(/^\s*using\s+(\w+)/);
      if (match) {
        dependencies.push(match[1]);
      }
    }

    return [...new Set(dependencies)];
  }
}
