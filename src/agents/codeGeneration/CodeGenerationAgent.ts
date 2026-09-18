/**
 * Code Generation Agent
 * Generates Fantom code artifacts including classes, methods, pods, enums, and mixins
 */

import {
  BaseAgent,
  ToolDefinition,
  ToolResult,
  AgentEvents,
} from '../base/index.js';
import {
  generateClass,
  generateMethod,
  generatePod,
  validateFantomCode,
  GenerateClassOptions,
  MethodDef,
} from '../../tools/generateFantom.js';

export class CodeGenerationAgent extends BaseAgent {
  readonly name = 'code-generation';
  readonly description = 'Generate Fantom code artifacts including classes, methods, pods, enums, and mixins';
  readonly category = 'code-generation';

  constructor(options: any) {
    super(options);
  }

  protected async doInitialize(): Promise<void> {
    this.logger.info('Initializing Code Generation Agent...');
  }

  getTools(): ToolDefinition[] {
    return [
      this.createToolDefinition(
        'gen_class',
        'Generate a Fantom class with fields and methods',
        {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Class name' },
            pod: { type: 'string', description: 'Pod name' },
            extends: { type: 'string', description: 'Parent class' },
            mixins: {
              type: 'array',
              items: { type: 'string' },
              description: 'Mixins to implement',
            },
            fields: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  type: { type: 'string' },
                  defaultValue: { type: 'string' },
                  isStatic: { type: 'boolean' },
                  isConst: { type: 'boolean' },
                  doc: { type: 'string' },
                },
                required: ['name', 'type'],
              },
              description: 'Class fields',
            },
            methods: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  returnType: { type: 'string' },
                  params: { type: 'array' },
                  body: { type: 'string' },
                  isStatic: { type: 'boolean' },
                  isAbstract: { type: 'boolean' },
                  isOverride: { type: 'boolean' },
                  doc: { type: 'string' },
                },
                required: ['name'],
              },
              description: 'Class methods',
            },
            isAbstract: { type: 'boolean', description: 'Is abstract class' },
            doc: { type: 'string', description: 'Class documentation' },
          },
          required: ['name'],
        },
        ['generate', 'class', 'create', 'new', 'code', 'fantom', 'scaffold'],
        ['creating a new Fantom class', 'generating class boilerplate', 'scaffolding type structure'],
        ['gen_method', 'gen_mixin', 'generateFantomCode']
      ),

      this.createToolDefinition(
        'gen_method',
        'Generate a Fantom method stub',
        {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Method name' },
            returnType: { type: 'string', description: 'Return type (default: Void)' },
            params: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  type: { type: 'string' },
                  defaultValue: { type: 'string' },
                },
                required: ['name', 'type'],
              },
              description: 'Method parameters',
            },
            body: { type: 'string', description: 'Method body code' },
            isStatic: { type: 'boolean', description: 'Static method' },
            isAbstract: { type: 'boolean', description: 'Abstract method' },
            isOverride: { type: 'boolean', description: 'Override method' },
            doc: { type: 'string', description: 'Method documentation' },
          },
          required: ['name'],
        },
        ['generate', 'method', 'function', 'create', 'stub', 'code'],
        ['creating a new method', 'generating function stub', 'adding method to class'],
        ['gen_class', 'generateFantomCode']
      ),

      this.createToolDefinition(
        'gen_pod',
        'Generate a Fantom pod structure with build.fan',
        {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Pod name' },
            version: { type: 'string', description: 'Version (default: 1.0.0)' },
            description: { type: 'string', description: 'Pod description' },
            depends: {
              type: 'array',
              items: { type: 'string' },
              description: 'Pod dependencies (default: [sys 1.0])',
            },
          },
          required: ['name'],
        },
        ['generate', 'pod', 'library', 'module', 'project', 'scaffold', 'create'],
        ['creating a new pod', 'scaffolding library structure', 'initializing new project'],
        ['gen_buildFile', 'gen_class', 'generateFantomCode']
      ),

      this.createToolDefinition(
        'gen_enum',
        'Generate a Fantom enum type',
        {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Enum name' },
            values: {
              type: 'array',
              items: { type: 'string' },
              description: 'Enum values',
            },
            pod: { type: 'string', description: 'Pod name' },
            doc: { type: 'string', description: 'Enum documentation' },
          },
          required: ['name', 'values'],
        },
        ['generate', 'enum', 'enumeration', 'constants', 'create'],
        ['creating an enum type', 'generating enumeration values'],
        ['gen_class', 'generateFantomCode']
      ),

      this.createToolDefinition(
        'gen_mixin',
        'Generate a Fantom mixin',
        {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Mixin name' },
            methods: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  returnType: { type: 'string' },
                  params: { type: 'array' },
                  isAbstract: { type: 'boolean' },
                  doc: { type: 'string' },
                },
                required: ['name'],
              },
              description: 'Mixin methods',
            },
            pod: { type: 'string', description: 'Pod name' },
            doc: { type: 'string', description: 'Mixin documentation' },
          },
          required: ['name'],
        },
        ['generate', 'mixin', 'interface', 'trait', 'create'],
        ['creating a mixin interface', 'generating trait definition'],
        ['gen_class', 'generateFantomCode']
      ),

      this.createToolDefinition(
        'gen_test',
        'Generate a Fantom test class',
        {
          type: 'object',
          properties: {
            targetClass: { type: 'string', description: 'Class to test' },
            methods: {
              type: 'array',
              items: { type: 'string' },
              description: 'Methods to generate tests for',
            },
            pod: { type: 'string', description: 'Test pod name' },
          },
          required: ['targetClass'],
        },
        ['generate', 'test', 'unit', 'testing', 'verify', 'scaffold'],
        ['creating unit tests', 'generating test class', 'scaffolding test methods'],
        ['gen_class', 'gen_validateCode']
      ),

      this.createToolDefinition(
        'gen_buildFile',
        'Generate a build.fan file for a pod',
        {
          type: 'object',
          properties: {
            podName: { type: 'string', description: 'Pod name' },
            depends: {
              type: 'array',
              items: { type: 'string' },
              description: 'Pod dependencies',
            },
            srcDirs: {
              type: 'array',
              items: { type: 'string' },
              description: 'Source directories',
            },
            version: { type: 'string', description: 'Version string' },
            description: { type: 'string', description: 'Pod summary' },
          },
          required: ['podName'],
        },
        ['generate', 'build', 'config', 'dependencies', 'build.fan'],
        ['creating build configuration', 'generating build.fan file'],
        ['gen_pod']
      ),

      this.createToolDefinition(
        'gen_validateCode',
        'Validate generated Fantom code',
        {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'Fantom code to validate' },
            useCompiler: { type: 'boolean', description: 'Use fan -check for validation (default: false)' },
          },
          required: ['code'],
        },
        ['validate', 'check', 'verify', 'syntax', 'compile', 'lint'],
        ['validating code syntax', 'checking for compile errors', 'verifying generated code'],
        ['code_validateSyntax']
      ),
    ];
  }

  async executeTool(toolName: string, params: Record<string, any>): Promise<ToolResult> {
    const startTime = Date.now();
    this.updateActivity();

    try {
      switch (toolName) {
        case 'gen_class':
          return this.doGenerateClass(params, startTime);

        case 'gen_method':
          return this.doGenerateMethod(params, startTime);

        case 'gen_pod':
          return this.doGeneratePod(params, startTime);

        case 'gen_enum':
          return this.doGenerateEnum(params, startTime);

        case 'gen_mixin':
          return this.doGenerateMixin(params, startTime);

        case 'gen_test':
          return this.doGenerateTest(params, startTime);

        case 'gen_buildFile':
          return this.doGenerateBuildFile(params, startTime);

        case 'gen_validateCode':
          return this.doValidateCode(params, startTime);

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

  private async doGenerateClass(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const validationError = this.validateParams(params, ['name']);
    if (validationError) {
      return this.createToolResult(false, null, validationError, startTime);
    }

    const options: GenerateClassOptions = {
      name: params.name,
      pod: params.pod,
      extends: params.extends,
      mixins: params.mixins,
      fields: params.fields,
      methods: params.methods,
      isAbstract: params.isAbstract,
      doc: params.doc,
    };

    const code = generateClass(options);
    const filename = `${params.name}.fan`;

    this.publishEvent(AgentEvents.CODE_GENERATED, {
      type: 'class',
      name: params.name,
    });

    return this.createToolResult(true, {
      code,
      filename,
      lineCount: code.split('\n').length,
    }, undefined, startTime);
  }

  private async doGenerateMethod(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const validationError = this.validateParams(params, ['name']);
    if (validationError) {
      return this.createToolResult(false, null, validationError, startTime);
    }

    const methodDef: MethodDef = {
      name: params.name,
      returnType: params.returnType || 'Void',
      params: params.params,
      body: params.body,
      isStatic: params.isStatic,
      isAbstract: params.isAbstract,
      isOverride: params.isOverride,
      doc: params.doc,
    };

    const code = generateMethod(methodDef);

    this.publishEvent(AgentEvents.CODE_GENERATED, {
      type: 'method',
      name: params.name,
    });

    return this.createToolResult(true, {
      code,
      lineCount: code.split('\n').length,
    }, undefined, startTime);
  }

  private async doGeneratePod(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const validationError = this.validateParams(params, ['name']);
    if (validationError) {
      return this.createToolResult(false, null, validationError, startTime);
    }

    const result = await generatePod({
      name: params.name,
      version: params.version,
      description: params.description,
      depends: params.depends,
    });

    this.publishEvent(AgentEvents.CODE_GENERATED, {
      type: 'pod',
      name: params.name,
    });

    return this.createToolResult(true, {
      podName: params.name,
      files: result.files,
      structure: result.structure,
      fileCount: Object.keys(result.files).length,
    }, undefined, startTime);
  }

  private async doGenerateEnum(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const validationError = this.validateParams(params, ['name', 'values']);
    if (validationError) {
      return this.createToolResult(false, null, validationError, startTime);
    }

    const options: GenerateClassOptions = {
      name: params.name,
      pod: params.pod,
      isEnum: true,
      enumValues: params.values,
      doc: params.doc,
    };

    const code = generateClass(options);
    const filename = `${params.name}.fan`;

    this.publishEvent(AgentEvents.CODE_GENERATED, {
      type: 'enum',
      name: params.name,
    });

    return this.createToolResult(true, {
      code,
      filename,
      valueCount: params.values.length,
    }, undefined, startTime);
  }

  private async doGenerateMixin(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const validationError = this.validateParams(params, ['name']);
    if (validationError) {
      return this.createToolResult(false, null, validationError, startTime);
    }

    const options: GenerateClassOptions = {
      name: params.name,
      pod: params.pod,
      isMixin: true,
      methods: params.methods?.map((m: any) => ({
        ...m,
        isAbstract: m.isAbstract ?? true,
      })),
      doc: params.doc,
    };

    const code = generateClass(options);
    const filename = `${params.name}.fan`;

    this.publishEvent(AgentEvents.CODE_GENERATED, {
      type: 'mixin',
      name: params.name,
    });

    return this.createToolResult(true, {
      code,
      filename,
      lineCount: code.split('\n').length,
    }, undefined, startTime);
  }

  private async doGenerateTest(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const validationError = this.validateParams(params, ['targetClass']);
    if (validationError) {
      return this.createToolResult(false, null, validationError, startTime);
    }

    const testClassName = `${params.targetClass}Test`;
    const methods = params.methods || ['example'];

    const testMethods: MethodDef[] = methods.map((methodName: string) => ({
      name: `test${methodName.charAt(0).toUpperCase()}${methodName.slice(1)}`,
      returnType: 'Void',
      doc: `Test ${methodName} method`,
      body: `// TODO: Implement test for ${methodName}\nverify(true)`,
    }));

    const options: GenerateClassOptions = {
      name: testClassName,
      extends: 'Test',
      methods: testMethods,
      doc: `Unit tests for ${params.targetClass}`,
    };

    const code = `using util\n\n${generateClass(options)}`;
    const filename = `${testClassName}.fan`;

    this.publishEvent(AgentEvents.CODE_GENERATED, {
      type: 'test',
      name: testClassName,
      targetClass: params.targetClass,
    });

    return this.createToolResult(true, {
      code,
      filename,
      testCount: testMethods.length,
    }, undefined, startTime);
  }

  private async doGenerateBuildFile(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const validationError = this.validateParams(params, ['podName']);
    if (validationError) {
      return this.createToolResult(false, null, validationError, startTime);
    }

    const depends = params.depends || ['sys 1.0'];
    const srcDirs = params.srcDirs || ['fan/'];
    const version = params.version || '1.0.0';
    const description = params.description || `${params.podName} pod`;

    const code = `using build

class Build : BuildPod
{
  new make()
  {
    podName = "${params.podName}"
    summary = "${description}"
    version = Version("${version}")
    meta = [
      "org.name":     "Your Organization",
      "org.uri":      "https://yourorg.com/",
      "license.name": "MIT"
    ]
    depends = [${depends.map((d: string) => `"${d}"`).join(', ')}]
    srcDirs = [${srcDirs.map((d: string) => `\`${d}\``).join(', ')}]
  }
}
`;

    this.publishEvent(AgentEvents.CODE_GENERATED, {
      type: 'buildFile',
      podName: params.podName,
    });

    return this.createToolResult(true, {
      code,
      filename: 'build.fan',
    }, undefined, startTime);
  }

  private async doValidateCode(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const validationError = this.validateParams(params, ['code']);
    if (validationError) {
      return this.createToolResult(false, null, validationError, startTime);
    }

    if (params.useCompiler) {
      // Use fan -check for validation
      const result = await validateFantomCode(params.code);
      return this.createToolResult(true, {
        valid: result.valid,
        errors: result.errors,
        method: 'compiler',
      }, undefined, startTime);
    }

    // Basic syntax validation
    const errors: string[] = [];
    const lines = params.code.split('\n');

    // Check for balanced braces
    let braceCount = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      braceCount += (line.match(/\{/g) || []).length;
      braceCount -= (line.match(/\}/g) || []).length;
    }
    if (braceCount !== 0) {
      errors.push('Unbalanced braces');
    }

    // Check for class/mixin/enum declaration
    if (!/\b(class|mixin|enum)\s+\w+/.test(params.code)) {
      errors.push('No type declaration found');
    }

    return this.createToolResult(true, {
      valid: errors.length === 0,
      errors,
      method: 'basic',
    }, undefined, startTime);
  }
}
