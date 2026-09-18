/**
 * AST Extractor
 *
 * Extracts structured code elements (functions, classes, etc.)
 * from tree-sitter syntax trees.
 */

import type { Node } from 'web-tree-sitter';
import type { LanguageRegistry } from './languageRegistry.js';
import type {
  SupportedLanguage,
  ASTLocation,
  ExtractedFunction,
  ExtractedParameter,
  ExtractedCall,
  ExtractedClass,
  ExtractedField,
  ExtractedInterface,
  ExtractedImport,
  ExtractedExport,
  ParseOptions,
  NodeTypeMappings
} from './types.js';

// ============================================
// Extraction Result Type
// ============================================

export interface ExtractionResult {
  classes: ExtractedClass[];
  interfaces: ExtractedInterface[];
  functions: ExtractedFunction[];
  imports: ExtractedImport[];
  exports: ExtractedExport[];
}

// ============================================
// AST Extractor Class
// ============================================

export class ASTExtractor {
  private registry: LanguageRegistry;

  constructor(registry: LanguageRegistry) {
    this.registry = registry;
  }

  /**
   * Extract all code structures from AST
   */
  extractAll(
    rootNode: Node,
    language: SupportedLanguage,
    source: string,
    options: ParseOptions
  ): ExtractionResult {
    const config = this.registry.getLanguage(language);
    if (!config) {
      return {
        classes: [],
        interfaces: [],
        functions: [],
        imports: [],
        exports: []
      };
    }

    const mappings = config.nodeMappings;

    // Extract all structures
    const classes = this.extractClasses(rootNode, mappings, source, options);
    const interfaces = this.extractInterfaces(rootNode, mappings, source, options);
    const functions = this.extractTopLevelFunctions(rootNode, mappings, source, options);
    const imports = this.extractImports(rootNode, mappings, source);
    const exports = this.extractExports(rootNode, mappings, source);

    return {
      classes,
      interfaces,
      functions,
      imports,
      exports
    };
  }

  /**
   * Extract classes from AST
   */
  private extractClasses(
    rootNode: Node,
    mappings: NodeTypeMappings,
    source: string,
    options: ParseOptions
  ): ExtractedClass[] {
    const classes: ExtractedClass[] = [];

    this.traverseNodes(rootNode, mappings.classTypes, (node) => {
      const classInfo = this.extractClassInfo(node, mappings, source, options);
      if (classInfo) {
        classes.push(classInfo);
      }
    });

    return classes;
  }

  /**
   * Extract single class info
   */
  private extractClassInfo(
    node: Node,
    mappings: NodeTypeMappings,
    source: string,
    options: ParseOptions
  ): ExtractedClass | null {
    // Try field first, then look for child by type (for Fantom)
    const nameNode = node.childForFieldName(mappings.nameField) ||
      this.findChildByTypes(node, ['identifier', 'name']);
    if (!nameNode) return null;

    const name = nameNode.text;
    const doc = options.extractDocs ? this.extractDocComment(node, mappings) : undefined;

    // Extract inheritance
    const extendsClause = this.findChildByTypes(node, [
      'extends_clause',
      'superclass',
      'extends',
      'class_heritage'
    ]);
    const extendsName = extendsClause?.text?.replace(/^extends\s*/, '').trim();

    // Extract implements
    const implementsClause = this.findChildByTypes(node, [
      'implements_clause',
      'super_interfaces',
      'implements'
    ]);
    const implementsList = implementsClause
      ? this.extractIdentifiers(implementsClause)
      : [];

    // Extract methods - try field first, then child by type (for Fantom class_body)
    const bodyNode = node.childForFieldName(mappings.bodyField) ||
      this.findChildByTypes(node, ['class_body', 'body', 'block']);
    const methods: ExtractedFunction[] = [];
    const fields: ExtractedField[] = [];

    if (bodyNode) {
      this.traverseNodes(bodyNode, mappings.functionTypes, (methodNode) => {
        const method = this.extractFunctionInfo(
          methodNode,
          mappings,
          source,
          options,
          name
        );
        if (method) {
          methods.push(method);
        }
      });

      this.traverseNodes(bodyNode, mappings.variableTypes, (fieldNode) => {
        const field = this.extractFieldInfo(fieldNode, mappings, source);
        if (field) {
          fields.push(field);
        }
      });
    }

    return {
      name,
      qualifiedName: name,
      documentation: doc,
      location: this.getLocation(node),
      extends: extendsName,
      implements: implementsList,
      methods,
      fields,
      visibility: this.extractVisibility(node),
      isAbstract: this.hasModifier(node, 'abstract')
    };
  }

  /**
   * Extract interfaces from AST
   */
  private extractInterfaces(
    rootNode: Node,
    mappings: NodeTypeMappings,
    source: string,
    options: ParseOptions
  ): ExtractedInterface[] {
    const interfaces: ExtractedInterface[] = [];

    this.traverseNodes(rootNode, mappings.interfaceTypes, (node) => {
      const interfaceInfo = this.extractInterfaceInfo(node, mappings, source, options);
      if (interfaceInfo) {
        interfaces.push(interfaceInfo);
      }
    });

    return interfaces;
  }

  /**
   * Extract single interface info
   */
  private extractInterfaceInfo(
    node: Node,
    mappings: NodeTypeMappings,
    source: string,
    options: ParseOptions
  ): ExtractedInterface | null {
    const nameNode = node.childForFieldName(mappings.nameField);
    if (!nameNode) return null;

    const name = nameNode.text;
    const doc = options.extractDocs ? this.extractDocComment(node, mappings) : undefined;

    // Extract extends
    const extendsClause = this.findChildByTypes(node, [
      'extends_type_clause',
      'extends_clause',
      'extends'
    ]);
    const extendsList = extendsClause
      ? this.extractIdentifiers(extendsClause)
      : [];

    // Extract methods and properties
    const bodyNode = node.childForFieldName(mappings.bodyField);
    const methods: ExtractedFunction[] = [];
    const properties: ExtractedField[] = [];

    if (bodyNode) {
      this.traverseNodes(bodyNode, mappings.functionTypes, (methodNode) => {
        const method = this.extractFunctionInfo(
          methodNode,
          mappings,
          source,
          options,
          name
        );
        if (method) {
          methods.push(method);
        }
      });

      this.traverseNodes(bodyNode, mappings.variableTypes, (propNode) => {
        const prop = this.extractFieldInfo(propNode, mappings, source);
        if (prop) {
          properties.push(prop);
        }
      });
    }

    return {
      name,
      qualifiedName: name,
      documentation: doc,
      location: this.getLocation(node),
      extends: extendsList,
      methods,
      properties
    };
  }

  /**
   * Extract module-scoped functions from AST.
   *
   * The original implementation only walked direct children of rootNode. For
   * TypeScript / JavaScript / Python — where most code lives in module-scoped
   * arrow functions and `const x = () => {}` declarations — that produced
   * essentially empty output (we'd see only `function name() {}` at file
   * root, missing exports, arrow functions, and named function expressions).
   *
   * This walker recurses through the whole tree but skips into class and
   * interface bodies (those are handled by extractClasses / extractInterfaces
   * to avoid double-counting their methods).
   */
  private extractTopLevelFunctions(
    rootNode: Node,
    mappings: NodeTypeMappings,
    source: string,
    options: ParseOptions
  ): ExtractedFunction[] {
    const functions: ExtractedFunction[] = [];
    const seen = new Set<string>(); // dedup by `${name}:${startLine}`

    const skipDescendants = new Set<string>([
      ...mappings.classTypes,
      ...mappings.interfaceTypes,
    ]);

    const visit = (node: Node) => {
      // Direct function-shaped node — extract and continue (do NOT recurse
      // into the body; nested closures get their own visit via children
      // of the function body, but those are usually anonymous and noisy).
      if (mappings.functionTypes.includes(node.type)) {
        // Only treat anonymous function/arrow as top-level when wrapped in
        // a variable_declarator with a name (handled below). Bare anonymous
        // arrows inside calls are not interesting symbols.
        const isNamed = !!node.childForFieldName(mappings.nameField);
        if (isNamed) {
          const func = this.extractFunctionInfo(node, mappings, source, options);
          if (func) {
            const key = `${func.name}:${func.location?.startLine ?? 0}`;
            if (!seen.has(key)) {
              seen.add(key);
              functions.push(func);
            }
          }
        }
        return;
      }

      // `const name = () => {}` / `let name = function() {}` patterns —
      // tree-sitter-typescript wraps these in lexical_declaration →
      // variable_declarator(name, value=arrow_function|function_expression).
      // Anonymous arrows have no own name field, so extractFunctionInfo
      // returns null on them. Build a minimal ExtractedFunction using the
      // outer declarator name in that case.
      if (node.type === 'variable_declarator') {
        const nameNode = node.childForFieldName('name');
        const valueNode = node.childForFieldName('value');
        if (
          nameNode &&
          valueNode &&
          mappings.functionTypes.includes(valueNode.type)
        ) {
          const declaredName = nameNode.text;
          let func = this.extractFunctionInfo(
            valueNode,
            mappings,
            source,
            options,
          );
          if (!func) {
            // Synthetic extraction for anonymous arrow / function expressions.
            const paramsNode = valueNode.childForFieldName(
              mappings.parametersField,
            );
            const parameters = paramsNode
              ? this.extractParameters(paramsNode)
              : [];
            const returnType = this.extractReturnType(valueNode);
            func = {
              name: declaredName,
              qualifiedName: declaredName,
              signature: this.buildSignature(declaredName, parameters, returnType),
              parameters,
              returnType,
              documentation: undefined,
              location: this.getLocation(valueNode),
              containingType: undefined,
              visibility: 'public',
              modifiers: [],
              isAsync: valueNode.text.startsWith('async'),
              isStatic: false,
              isAbstract: false,
              calls: [],
              body: undefined,
            } as ExtractedFunction;
          } else {
            func.name = declaredName;
            func.qualifiedName = declaredName;
          }
          const key = `${func.name}:${func.location?.startLine ?? 0}`;
          if (!seen.has(key)) {
            seen.add(key);
            functions.push(func);
          }
          return;
        }
      }

      // Don't descend into class / interface bodies — extractClasses and
      // extractInterfaces own those.
      if (skipDescendants.has(node.type)) {
        return;
      }

      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) visit(child);
      }
    };

    visit(rootNode);
    return functions;
  }

  /**
   * Extract function/method info
   */
  private extractFunctionInfo(
    node: Node,
    mappings: NodeTypeMappings,
    _source: string,
    options: ParseOptions,
    containingType?: string
  ): ExtractedFunction | null {
    // Get function name - try field first, then child by type
    let name: string | undefined;
    let nameNode = node.childForFieldName(mappings.nameField);

    if (nameNode) {
      name = nameNode.text;
    } else {
      // Try alternative patterns (including Fantom which uses child nodes)
      const identifier = this.findChildByTypes(node, ['identifier', 'property_identifier', 'name']);
      name = identifier?.text;
    }

    if (!name) return null;

    const doc = options.extractDocs ? this.extractDocComment(node, mappings) : undefined;

    // Extract parameters - try field first, then child by type (for Fantom)
    const paramsNode = node.childForFieldName(mappings.parametersField) ||
      this.findChildByTypes(node, ['param_list', 'parameters', 'formal_parameters']);
    const parameters = paramsNode
      ? this.extractParameters(paramsNode)
      : [];

    // Extract return type
    const returnType = this.extractReturnType(node);

    // Build signature
    const signature = this.buildSignature(name, parameters, returnType);

    // Extract body and calls - try field first, then child by type (for Fantom)
    const methodBodyNode = node.childForFieldName(mappings.bodyField) ||
      this.findChildByTypes(node, ['block', 'body', 'function_body']);
    let body: string | undefined;
    let calls: ExtractedCall[] = [];

    if (methodBodyNode) {
      if (options.extractBodies) {
        body = methodBodyNode.text;
      }
      if (options.extractCalls) {
        calls = this.extractCalls(methodBodyNode, mappings);
      }
    }

    return {
      name,
      qualifiedName: containingType ? `${containingType}.${name}` : name,
      signature,
      parameters,
      returnType,
      documentation: doc,
      location: this.getLocation(node),
      containingType,
      visibility: this.extractVisibility(node),
      isAsync: this.hasModifier(node, 'async') || node.type.includes('async'),
      isStatic: this.hasModifier(node, 'static'),
      isAbstract: this.hasModifier(node, 'abstract'),
      body,
      calls
    };
  }

  /**
   * Extract parameters from parameter list node
   */
  private extractParameters(paramsNode: Node): ExtractedParameter[] {
    const params: ExtractedParameter[] = [];

    for (let i = 0; i < paramsNode.namedChildCount; i++) {
      const paramNode = paramsNode.namedChild(i);
      if (!paramNode) continue;

      // Skip non-parameter nodes
      if (paramNode.type === ',' || paramNode.type === '(' || paramNode.type === ')') {
        continue;
      }

      const param = this.extractParameter(paramNode);
      if (param) {
        params.push(param);
      }
    }

    return params;
  }

  /**
   * Extract single parameter info
   */
  private extractParameter(node: Node): ExtractedParameter | null {
    let name: string | undefined;
    let type: string | undefined;
    let defaultValue: string | undefined;
    let isOptional = false;
    let isRest = false;

    // Check for rest/spread parameter
    if (node.type.includes('rest') || node.type.includes('spread')) {
      isRest = true;
    }

    // Find name - handle Fantom's param structure (type_ref followed by identifier)
    const nameNode = node.childForFieldName('name') ||
      this.findChildByTypes(node, ['identifier', 'pattern']);
    if (nameNode) {
      name = nameNode.text;
    } else if (node.type === 'identifier') {
      name = node.text;
    }

    if (!name) return null;

    // Find type annotation - handle Fantom's type_ref
    let typeNode = node.childForFieldName('type') ||
      this.findChildByTypes(node, ['type_annotation', 'type', 'type_ref']);
    if (typeNode) {
      // For Fantom, extract identifier from type_ref
      if (typeNode.type === 'type_ref') {
        const identifier = this.findChildByTypes(typeNode, ['identifier']);
        type = identifier?.text || typeNode.text;
      } else {
        type = typeNode.text.replace(/^:\s*/, '');
      }
    }

    // Find default value
    const valueNode = node.childForFieldName('value') ||
      this.findChildByTypes(node, ['default_value']);
    if (valueNode) {
      defaultValue = valueNode.text.replace(/^=\s*/, '');
      isOptional = true;
    }

    // Check for optional marker
    if (node.type.includes('optional') || name.endsWith('?')) {
      isOptional = true;
      name = name.replace(/\?$/, '');
    }

    return {
      name,
      type,
      defaultValue,
      isOptional,
      isRest
    };
  }

  /**
   * Extract return type from function node
   */
  private extractReturnType(node: Node): string | undefined {
    const returnNode = node.childForFieldName('return_type') ||
      this.findChildByTypes(node, ['type_annotation', 'return_type', 'type_ref']);

    if (returnNode) {
      // For Fantom, type_ref contains the full type tree, extract just the identifier
      if (returnNode.type === 'type_ref') {
        const identifier = this.findChildByTypes(returnNode, ['identifier']);
        if (identifier) {
          return identifier.text;
        }
      }
      return returnNode.text.replace(/^:\s*/, '').trim();
    }

    return undefined;
  }

  /**
   * Extract function calls from body
   */
  private extractCalls(bodyNode: Node, mappings: NodeTypeMappings): ExtractedCall[] {
    const calls: ExtractedCall[] = [];

    this.traverseNodes(bodyNode, mappings.callTypes, (node) => {
      const call = this.extractCallInfo(node);
      if (call) {
        calls.push(call);
      }
    });

    return calls;
  }

  /**
   * Extract call info
   */
  private extractCallInfo(node: Node): ExtractedCall | null {
    let name: string | undefined;
    let target: string | undefined;
    let isAsync = false;

    // Check for await
    if (node.parent?.type === 'await_expression') {
      isAsync = true;
    }

    // Get function being called
    const functionNode = node.childForFieldName('function') ||
      node.childForFieldName('callee') ||
      node.namedChild(0);

    if (!functionNode) return null;

    if (functionNode.type === 'member_expression' || functionNode.type === 'property_access_expression') {
      // Method call: obj.method()
      const objectNode = functionNode.childForFieldName('object') || functionNode.namedChild(0);
      const propertyNode = functionNode.childForFieldName('property') ||
        functionNode.childForFieldName('name') ||
        functionNode.namedChild(1);

      target = objectNode?.text;
      name = propertyNode?.text;
    } else if (functionNode.type === 'identifier') {
      // Direct function call
      name = functionNode.text;
    } else {
      // Complex expression
      name = functionNode.text;
    }

    if (!name) return null;

    return {
      name,
      expression: node.text,
      target,
      location: this.getLocation(node),
      isAsync
    };
  }

  /**
   * Extract field/property info
   */
  private extractFieldInfo(
    node: Node,
    _mappings: NodeTypeMappings,
    _source: string
  ): ExtractedField | null {
    const nameNode = node.childForFieldName('name') ||
      this.findChildByTypes(node, ['property_identifier', 'identifier']);

    if (!nameNode) return null;

    const name = nameNode.text;

    // Handle Fantom's type_ref structure
    let typeNode = node.childForFieldName('type') ||
      this.findChildByTypes(node, ['type_annotation', 'type_ref']);
    let type: string | undefined;
    if (typeNode) {
      if (typeNode.type === 'type_ref') {
        const identifier = this.findChildByTypes(typeNode, ['identifier']);
        type = identifier?.text || typeNode.text;
      } else {
        type = typeNode.text?.replace(/^:\s*/, '');
      }
    }

    // Handle Fantom's literal default values
    const valueNode = node.childForFieldName('value') ||
      this.findChildByTypes(node, ['literal', 'default_value']);
    const defaultValue = valueNode?.text;

    return {
      name,
      type,
      location: this.getLocation(node),
      visibility: this.extractVisibility(node),
      isStatic: this.hasModifier(node, 'static'),
      isReadonly: this.hasModifier(node, 'readonly') || this.hasModifier(node, 'final') || this.hasModifier(node, 'const'),
      defaultValue
    };
  }

  /**
   * Extract imports
   */
  private extractImports(
    rootNode: Node,
    mappings: NodeTypeMappings,
    _source: string
  ): ExtractedImport[] {
    const imports: ExtractedImport[] = [];

    this.traverseNodes(rootNode, mappings.importTypes, (node) => {
      const importInfo = this.extractImportInfo(node);
      if (importInfo) {
        imports.push(importInfo);
      }
    });

    return imports;
  }

  /**
   * Extract single import info
   */
  private extractImportInfo(node: Node): ExtractedImport | null {
    let source: string | undefined;
    const items: ExtractedImport['items'] = [];
    let isTypeOnly = false;

    // Handle Fantom's using_statement: using <dotted_name>
    if (node.type === 'using_statement') {
      const dottedName = this.findChildByTypes(node, ['dotted_name']);
      if (dottedName) {
        source = dottedName.text;
        return {
          source,
          items: [{
            name: source.split('.').pop() || source,
            isDefault: false,
            isNamespace: true
          }],
          location: this.getLocation(node),
          isTypeOnly: false
        };
      }
    }

    // Find source/module path
    const sourceNode = node.childForFieldName('source') ||
      this.findChildByTypes(node, ['string', 'string_literal']);
    if (sourceNode) {
      source = sourceNode.text.replace(/['"]/g, '');
    }

    if (!source) return null;

    // Check for type-only import
    if (node.text.includes('import type') || this.hasModifier(node, 'type')) {
      isTypeOnly = true;
    }

    // Extract imported items
    const clauseNode = this.findChildByTypes(node, ['import_clause', 'named_imports']);

    if (clauseNode) {
      // Default import
      const defaultImport = clauseNode.childForFieldName('default') ||
        this.findChildByTypes(clauseNode, ['identifier']);
      if (defaultImport && !defaultImport.type.includes('named')) {
        items.push({
          name: defaultImport.text,
          isDefault: true,
          isNamespace: false
        });
      }

      // Named imports
      const namedImports = this.findChildByTypes(clauseNode, ['named_imports']);
      if (namedImports) {
        for (let i = 0; i < namedImports.namedChildCount; i++) {
          const specifier = namedImports.namedChild(i);
          if (!specifier) continue;

          const nameNode = specifier.childForFieldName('name') || specifier.namedChild(0);
          const aliasNode = specifier.childForFieldName('alias') || specifier.namedChild(1);

          if (nameNode) {
            items.push({
              name: nameNode.text,
              alias: aliasNode?.text !== nameNode.text ? aliasNode?.text : undefined,
              isDefault: false,
              isNamespace: false
            });
          }
        }
      }

      // Namespace import
      const namespaceImport = this.findChildByTypes(clauseNode, ['namespace_import']);
      if (namespaceImport) {
        const aliasNode = namespaceImport.childForFieldName('alias') ||
          this.findChildByTypes(namespaceImport, ['identifier']);
        if (aliasNode) {
          items.push({
            name: '*',
            alias: aliasNode.text,
            isDefault: false,
            isNamespace: true
          });
        }
      }
    }

    return {
      source,
      items,
      location: this.getLocation(node),
      isTypeOnly
    };
  }

  /**
   * Extract exports
   */
  private extractExports(
    rootNode: Node,
    mappings: NodeTypeMappings,
    _source: string
  ): ExtractedExport[] {
    const exports: ExtractedExport[] = [];

    this.traverseNodes(rootNode, mappings.exportTypes, (node) => {
      const exportInfos = this.extractExportInfo(node);
      exports.push(...exportInfos);
    });

    return exports;
  }

  /**
   * Extract export info
   */
  private extractExportInfo(node: Node): ExtractedExport[] {
    const exports: ExtractedExport[] = [];
    const isTypeOnly = node.text.includes('export type');

    // Default export
    if (node.text.includes('default')) {
      const declaration = node.namedChild(0);
      const name = declaration?.childForFieldName('name')?.text || 'default';
      exports.push({
        name,
        location: this.getLocation(node),
        isDefault: true,
        isTypeOnly
      });
      return exports;
    }

    // Named exports
    const exportClause = this.findChildByTypes(node, ['export_clause']);
    if (exportClause) {
      for (let i = 0; i < exportClause.namedChildCount; i++) {
        const specifier = exportClause.namedChild(i);
        if (!specifier) continue;

        const nameNode = specifier.childForFieldName('name') || specifier.namedChild(0);
        const aliasNode = specifier.childForFieldName('alias');

        if (nameNode) {
          exports.push({
            name: nameNode.text,
            alias: aliasNode?.text,
            location: this.getLocation(node),
            isDefault: false,
            isTypeOnly
          });
        }
      }
    }

    // Direct export declarations (export function, export class, etc.)
    const declaration = node.namedChild(0);
    if (declaration && !exportClause) {
      const nameNode = declaration.childForFieldName('name');
      if (nameNode) {
        exports.push({
          name: nameNode.text,
          location: this.getLocation(node),
          isDefault: false,
          isTypeOnly
        });
      }
    }

    return exports;
  }

  /**
   * Extract doc comment preceding a node
   */
  private extractDocComment(node: Node, mappings: NodeTypeMappings): string | undefined {
    // Look for comment node before this node
    let prev = node.previousSibling;

    while (prev) {
      if (mappings.commentTypes.includes(prev.type)) {
        const text = prev.text;
        // Check if it's a doc comment
        if (text.startsWith('/**') || text.startsWith('///') || text.startsWith('##')) {
          return this.cleanDocComment(text);
        }
      }
      // Stop if we hit non-whitespace, non-comment
      if (prev.type !== 'comment' && !prev.type.includes('comment')) {
        break;
      }
      prev = prev.previousSibling;
    }

    return undefined;
  }

  /**
   * Clean up doc comment text
   */
  private cleanDocComment(text: string): string {
    return text
      .replace(/^\/\*\*?\s*/m, '')
      .replace(/\s*\*\/$/m, '')
      .replace(/^\s*\*\s?/gm, '')
      .replace(/^\/\/\/?\s*/gm, '')
      .trim();
  }

  /**
   * Extract visibility modifier
   */
  private extractVisibility(node: Node): 'public' | 'private' | 'protected' | 'internal' | undefined {
    if (this.hasModifier(node, 'public')) return 'public';
    if (this.hasModifier(node, 'private')) return 'private';
    if (this.hasModifier(node, 'protected')) return 'protected';
    if (this.hasModifier(node, 'internal')) return 'internal';
    return undefined;
  }

  /**
   * Check if node has a modifier
   */
  private hasModifier(node: Node, modifier: string): boolean {
    // Check in modifiers field
    const modifiersNode = node.childForFieldName('modifiers');
    if (modifiersNode?.text.includes(modifier)) {
      return true;
    }

    // Check accessibility modifier
    const accessibilityNode = node.childForFieldName('accessibility');
    if (accessibilityNode?.text === modifier) {
      return true;
    }

    // Check direct children
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === modifier || child?.text === modifier) {
        return true;
      }
    }

    return false;
  }

  /**
   * Build function signature string
   */
  private buildSignature(
    name: string,
    params: ExtractedParameter[],
    returnType?: string
  ): string {
    const paramsStr = params.map(p => {
      let str = p.name;
      if (p.isRest) str = `...${str}`;
      if (p.type) str += `: ${p.type}`;
      if (p.isOptional && !p.defaultValue) str += '?';
      if (p.defaultValue) str += ` = ${p.defaultValue}`;
      return str;
    }).join(', ');

    let sig = `${name}(${paramsStr})`;
    if (returnType) {
      sig += `: ${returnType}`;
    }

    return sig;
  }

  /**
   * Traverse nodes matching types
   */
  private traverseNodes(
    node: Node,
    types: string[],
    callback: (node: Node) => void
  ): void {
    if (types.includes(node.type)) {
      callback(node);
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) {
        this.traverseNodes(child, types, callback);
      }
    }
  }

  /**
   * Find child by types
   */
  private findChildByTypes(node: Node, types: string[]): Node | undefined {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && types.includes(child.type)) {
        return child;
      }
    }
    return undefined;
  }

  /**
   * Extract identifiers from a node
   */
  private extractIdentifiers(node: Node): string[] {
    const identifiers: string[] = [];

    const traverse = (n: Node) => {
      if (n.type === 'identifier' || n.type === 'type_identifier') {
        identifiers.push(n.text);
      }
      for (let i = 0; i < n.childCount; i++) {
        const child = n.child(i);
        if (child) traverse(child);
      }
    };

    traverse(node);
    return identifiers;
  }

  /**
   * Get location from node
   */
  private getLocation(node: Node): ASTLocation {
    return {
      startLine: node.startPosition.row + 1,
      startColumn: node.startPosition.column,
      endLine: node.endPosition.row + 1,
      endColumn: node.endPosition.column,
      startIndex: node.startIndex,
      endIndex: node.endIndex
    };
  }
}
