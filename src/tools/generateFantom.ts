import { createLogger } from '../utils/index.js';
import { promises as fs } from 'fs';
import { join } from 'path';

const logger = createLogger('generate');

export interface GenerateClassOptions {
  name: string;
  pod?: string;
  extends?: string;
  mixins?: string[];
  fields?: FieldDef[];
  methods?: MethodDef[];
  facets?: string[];
  isAbstract?: boolean;
  isMixin?: boolean;
  isEnum?: boolean;
  enumValues?: string[];
  doc?: string;
}

export interface FieldDef {
  name: string;
  type: string;
  defaultValue?: string;
  isStatic?: boolean;
  isConst?: boolean;
  doc?: string;
}

export interface MethodDef {
  name: string;
  returnType?: string;
  params?: ParamDef[];
  isStatic?: boolean;
  isAbstract?: boolean;
  isOverride?: boolean;
  doc?: string;
  body?: string;
}

export interface ParamDef {
  name: string;
  type: string;
  defaultValue?: string;
}

export interface GeneratePodOptions {
  name: string;
  version?: string;
  description?: string;
  depends?: string[];
  outDir?: string;
}

/**
 * Generate Fantom class code
 */
export function generateClass(options: GenerateClassOptions): string {
  const lines: string[] = [];

  // Doc comment
  if (options.doc) {
    lines.push('/**');
    options.doc.split('\n').forEach(line => lines.push(` * ${line}`));
    lines.push(' */');
  }

  // Facets
  if (options.facets && options.facets.length > 0) {
    options.facets.forEach(facet => lines.push(`@${facet}`));
  }

  // Class declaration
  const modifiers: string[] = [];
  if (options.isAbstract) modifiers.push('abstract');
  
  let keyword = 'class';
  if (options.isMixin) keyword = 'mixin';
  if (options.isEnum) keyword = 'enum';

  let declaration = `${modifiers.join(' ')} ${keyword} ${options.name}`.trim();

  // Inheritance
  if (options.extends) {
    declaration += ` : ${options.extends}`;
  }
  if (options.mixins && options.mixins.length > 0) {
    const mixinList = options.mixins.join(', ');
    declaration += options.extends ? `, ${mixinList}` : ` : ${mixinList}`;
  }

  lines.push(declaration);
  lines.push('{');

  // Enum values
  if (options.isEnum && options.enumValues) {
    options.enumValues.forEach((val, idx) => {
      const comma = idx < options.enumValues!.length - 1 ? ',' : '';
      lines.push(`  ${val}${comma}`);
    });
    if (options.enumValues.length > 0) lines.push('');
  }

  // Fields
  if (options.fields && options.fields.length > 0) {
    options.fields.forEach(field => {
      if (field.doc) {
        lines.push('  /**');
        field.doc.split('\n').forEach(line => lines.push(`   * ${line}`));
        lines.push('   */');
      }

      const modifiers: string[] = [];
      if (field.isStatic) modifiers.push('static');
      if (field.isConst) modifiers.push('const');

      const modifier = modifiers.length > 0 ? modifiers.join(' ') + ' ' : '';
      const defaultVal = field.defaultValue ? ` := ${field.defaultValue}` : '';
      lines.push(`  ${modifier}${field.type} ${field.name}${defaultVal}`);
    });
    lines.push('');
  }

  // Methods
  if (options.methods && options.methods.length > 0) {
    options.methods.forEach((method, idx) => {
      if (idx > 0 || (options.fields && options.fields.length > 0)) {
        lines.push('');
      }

      if (method.doc) {
        lines.push('  /**');
        method.doc.split('\n').forEach(line => lines.push(`   * ${line}`));
        lines.push('   */');
      }

      const modifiers: string[] = [];
      if (method.isStatic) modifiers.push('static');
      if (method.isAbstract) modifiers.push('abstract');
      if (method.isOverride) modifiers.push('override');

      const modifier = modifiers.length > 0 ? modifiers.join(' ') + ' ' : '';
      const returnType = method.returnType || 'Void';
      const params = method.params || [];
      const paramStr = params
        .map(p => {
          const defaultVal = p.defaultValue ? ` := ${p.defaultValue}` : '';
          return `${p.type} ${p.name}${defaultVal}`;
        })
        .join(', ');

      lines.push(`  ${modifier}${returnType} ${method.name}(${paramStr})`);

      if (method.isAbstract) {
        // Abstract methods have no body
      } else {
        lines.push('  {');
        if (method.body) {
          method.body.split('\n').forEach(line => lines.push(`    ${line}`));
        } else {
          // Default body
          if (returnType !== 'Void') {
            lines.push('    // TODO: implement');
            lines.push('    return null');
          } else {
            lines.push('    // TODO: implement');
          }
        }
        lines.push('  }');
      }
    });
  }

  lines.push('}');

  return lines.join('\n');
}

/**
 * Generate Fantom pod structure
 */
export async function generatePod(options: GeneratePodOptions): Promise<{ files: Record<string, string>; structure: string }> {
  const files: Record<string, string> = {};
  const version = options.version || '1.0.0';
  const depends = options.depends || ['sys 1.0'];

  // build.fan
  const buildFan = `using build

class Build : BuildPod
{
  new make()
  {
    podName = "${options.name}"
    summary = "${options.description || `${options.name} pod`}"
    version = Version("${version}")
    meta = [
      "org.name":     "Your Org",
      "org.uri":      "https://yourorg.com/",
      "license.name": "MIT",
      "vcs.uri":      "https://github.com/yourorg/${options.name}"
    ]
    depends = [${depends.map(d => `"${d}"`).join(', ')}]
    srcDirs = [\`fan/\`]
    resDirs = [,]
  }
}
`;

  files['build.fan'] = buildFan;

  // Example class
  const exampleClass = generateClass({
    name: `${options.name}Main`,
    doc: `Main entry point for ${options.name}`,
    methods: [{
      name: 'main',
      isStatic: true,
      returnType: 'Void',
      doc: 'Main method',
      body: `echo("Hello from ${options.name}!")`
    }]
  });

  files['fan/Main.fan'] = exampleClass;

  // pod.fandoc
  const podDoc = `**************************************************************************
** ${options.name}
**************************************************************************

Overview
********
${options.description || `${options.name} pod`}

Usage
*****
TODO: Add usage examples

`;

  files['doc/pod.fandoc'] = podDoc;

  const structure = `${options.name}/
  build.fan
  fan/
    Main.fan
  doc/
    pod.fandoc`;

  return { files, structure };
}

/**
 * Generate method stub
 */
export function generateMethod(options: MethodDef): string {
  const lines: string[] = [];

  if (options.doc) {
    lines.push('/**');
    options.doc.split('\n').forEach(line => lines.push(` * ${line}`));
    lines.push(' */');
  }

  const modifiers: string[] = [];
  if (options.isStatic) modifiers.push('static');
  if (options.isAbstract) modifiers.push('abstract');
  if (options.isOverride) modifiers.push('override');

  const modifier = modifiers.length > 0 ? modifiers.join(' ') + ' ' : '';
  const returnType = options.returnType || 'Void';
  const params = options.params || [];
  const paramStr = params
    .map(p => {
      const defaultVal = p.defaultValue ? ` := ${p.defaultValue}` : '';
      return `${p.type} ${p.name}${defaultVal}`;
    })
    .join(', ');

  lines.push(`${modifier}${returnType} ${options.name}(${paramStr})`);

  if (!options.isAbstract) {
    lines.push('{');
    if (options.body) {
      options.body.split('\n').forEach(line => lines.push(`  ${line}`));
    } else {
      if (returnType !== 'Void') {
        lines.push('  // TODO: implement');
        lines.push('  return null');
      } else {
        lines.push('  // TODO: implement');
      }
    }
    lines.push('}');
  }

  return lines.join('\n');
}

/**
 * Validate Fantom code by running fan -check (if available)
 */
export async function validateFantomCode(code: string, tempDir?: string): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    // Check if fan is available
    try {
      await execAsync('fan -version');
    } catch {
      logger.debug('fan command not available, skipping validation');
      return { valid: true, errors: ['Validation skipped: fan runtime not found'] };
    }

    // Write code to temp file
    const tmpDir = tempDir || '/tmp';
    const tmpFile = join(tmpDir, `validate_${Date.now()}.fan`);
    await fs.writeFile(tmpFile, code);

    try {
      // Run fan -check
      const { stderr } = await execAsync(`fan -check ${tmpFile}`, { timeout: 5000 });
      
      if (stderr) {
        errors.push(...stderr.split('\n').filter(line => line.trim()));
      }

      // Clean up
      await fs.unlink(tmpFile);

      return { valid: errors.length === 0, errors };
    } catch (error: any) {
      // Parse error output
      if (error.stderr) {
        errors.push(...error.stderr.split('\n').filter((line: string) => line.trim()));
      }
      
      // Clean up
      try {
        await fs.unlink(tmpFile);
      } catch {}

      return { valid: false, errors };
    }
  } catch (error) {
    logger.error('Validation error:', error);
    return { valid: false, errors: [`Validation failed: ${error}`] };
  }
}
