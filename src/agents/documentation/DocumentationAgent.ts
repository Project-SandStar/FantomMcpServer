/**
 * Documentation Agent
 * Responsible for searching, retrieving, and indexing documentation
 * from local SkySpark/Fantom installations and cached sources
 */

import {
  BaseAgent,
  ToolDefinition,
  ToolResult,
  IndexStats,
  AgentEvents,
} from '../base/index.js';
import { SearchIndex } from '../../search/index.js';
import { getFantomDatabase } from '../../fantom/database.js';
import {
  loadCachedDocs,
  parseInstanceDocs,
} from '../../parser/local/index.js';

export class DocumentationAgent extends BaseAgent {
  readonly name = 'documentation';
  readonly description = 'Search and retrieve documentation from cached docs and local sources';
  readonly category = 'documentation';

  private searchIndex: SearchIndex;
  private indexStats: IndexStats | null = null;

  constructor(options: any) {
    super(options);
    this.searchIndex = options.searchIndex ?? new SearchIndex();
  }

  protected async doInitialize(): Promise<void> {
    this.logger.info('Initializing Documentation Agent...');

    // Load local documentation from all instances
    await this.loadLocalDocs();

    this.updateIndexStats();
  }

  /**
   * Load local documentation from all configured instances into the search index
   */
  private async loadLocalDocs(): Promise<void> {
    try {
      const db = getFantomDatabase();
      await db.initialize();
      const instances = await db.getAllInstances();

      this.logger.info(`Loading local docs from ${instances.length} instances...`);

      let totalItems = 0;
      for (const instance of instances) {
        const cached = loadCachedDocs(instance.id);
        if (cached && cached.length > 0) {
          // Convert LocalDocItem to FantomDocItem format for search index
          // Map local types to FantomDocItem types
          const mapType = (t: string): 'type' | 'slot' | 'example' | 'guide' => {
            switch (t) {
              case 'function': return 'slot';
              case 'tag': return 'type';
              case 'chapter': return 'guide';
              case 'type':
              case 'slot':
              case 'example':
              case 'guide':
                return t;
              default: return 'type';
            }
          };
          const items = cached.map(item => ({
            id: item.id,
            name: item.name,
            qualifiedName: item.qualifiedName,
            type: mapType(item.type),
            pod: item.pod,
            description: item.description,
            signature: item.signature,
            url: item.url,
            keywords: item.keywords,
          }));
          await this.searchIndex.addItems(items);
          totalItems += items.length;
          this.logger.debug(`Loaded ${items.length} items from instance ${instance.name}`);
        }
      }

      this.logger.info(`Loaded ${totalItems} local documentation items`);
    } catch (error) {
      this.logger.warn(`Failed to load local docs: ${error}`);
    }
  }

  getTools(): ToolDefinition[] {
    return [
      this.createToolDefinition(
        'docs_search',
        'Unified search across all cached and local documentation sources',
        {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            sources: {
              type: 'array',
              items: { type: 'string', enum: ['fantom', 'haxall', 'local', 'project'] },
              description: 'Documentation sources to search (default: all)',
            },
            type: {
              type: 'string',
              enum: ['type', 'slot', 'example', 'guide'],
              description: 'Filter by item type',
            },
            pod: { type: 'string', description: 'Filter by pod name' },
            limit: { type: 'number', description: 'Maximum results (default: 10)' },
          },
          required: ['query'],
        },
        ['search', 'find', 'lookup', 'documentation', 'API', 'reference', 'fantom', 'haxall'],
        ['finding API documentation', 'looking up type information', 'searching for methods'],
        ['docs_getType', 'docs_getPod', 'searchAll']
      ),

      this.createToolDefinition(
        'docs_getType',
        'Get detailed type information with related slots',
        {
          type: 'object',
          properties: {
            qualifiedName: { type: 'string', description: 'Qualified type name (e.g., sys::Str)' },
            includeSlots: { type: 'boolean', description: 'Include slot information (default: true)' },
          },
          required: ['qualifiedName'],
        },
        ['type', 'class', 'mixin', 'enum', 'slots', 'methods', 'fields', 'API'],
        ['getting class details', 'viewing type methods and fields', 'understanding type hierarchy'],
        ['docs_search', 'docs_findRelated']
      ),

      this.createToolDefinition(
        'docs_getPod',
        'Get pod/library documentation overview',
        {
          type: 'object',
          properties: {
            podName: { type: 'string', description: 'Pod name' },
            source: {
              type: 'string',
              enum: ['fantom', 'haxall'],
              description: 'Documentation source',
            },
          },
          required: ['podName'],
        },
        ['pod', 'library', 'module', 'package', 'overview', 'documentation'],
        ['viewing pod contents', 'understanding library structure', 'exploring module types'],
        ['docs_listPods', 'docs_search']
      ),

      this.createToolDefinition(
        'docs_listPods',
        'List all indexed pods with item counts',
        {
          type: 'object',
          properties: {
            source: {
              type: 'string',
              enum: ['fantom', 'haxall', 'all'],
              description: 'Filter by source (default: all)',
            },
          },
        },
        ['pods', 'libraries', 'modules', 'list', 'available', 'index'],
        ['discovering available pods', 'listing all libraries', 'exploring codebase'],
        ['docs_getPod', 'docs_search']
      ),

      this.createToolDefinition(
        'docs_refreshIndex',
        'Rebuild documentation index from local SkySpark/Fantom instances',
        {
          type: 'object',
          properties: {},
        },
        ['refresh', 'rebuild', 'reindex', 'update', 'cache', 'sync'],
        ['updating documentation cache', 'refreshing search index', 'syncing local docs'],
        ['indexInstanceDocs']
      ),

      this.createToolDefinition(
        'docs_searchBySignature',
        'Find types/methods by signature pattern',
        {
          type: 'object',
          properties: {
            signature: { type: 'string', description: 'Signature pattern to match' },
            returnType: { type: 'string', description: 'Filter by return type' },
            limit: { type: 'number', description: 'Maximum results (default: 10)' },
          },
          required: ['signature'],
        },
        ['signature', 'method', 'function', 'return', 'parameter', 'pattern'],
        ['finding methods by signature', 'searching by return type', 'locating specific method patterns'],
        ['docs_search', 'code_findDefinition']
      ),

      this.createToolDefinition(
        'docs_getExamples',
        'Get code examples for a type or function',
        {
          type: 'object',
          properties: {
            qualifiedName: { type: 'string', description: 'Qualified name of type/function' },
            maxExamples: { type: 'number', description: 'Maximum examples to return (default: 5)' },
          },
          required: ['qualifiedName'],
        },
        ['examples', 'sample', 'code', 'usage', 'snippet', 'demo'],
        ['finding code examples', 'learning API usage', 'understanding how to use a type'],
        ['docs_getType', 'docs_search']
      ),

      this.createToolDefinition(
        'docs_findRelated',
        'Find related types and functions',
        {
          type: 'object',
          properties: {
            qualifiedName: { type: 'string', description: 'Qualified name to find relations for' },
            relationTypes: {
              type: 'array',
              items: { type: 'string', enum: ['parent', 'children', 'mixins', 'slots', 'usedBy'] },
              description: 'Types of relations to find',
            },
            limit: { type: 'number', description: 'Maximum results per relation type' },
          },
          required: ['qualifiedName'],
        },
        ['related', 'hierarchy', 'inheritance', 'parent', 'children', 'mixins', 'slots'],
        ['exploring type hierarchy', 'finding related classes', 'understanding inheritance'],
        ['docs_getType', 'code_findReferences']
      ),
    ];
  }

  async executeTool(toolName: string, params: Record<string, any>): Promise<ToolResult> {
    const startTime = Date.now();
    this.updateActivity();

    try {
      switch (toolName) {
        case 'docs_search':
          return this.doSearch(params, startTime);

        case 'docs_getType':
          return this.doGetType(params, startTime);

        case 'docs_getPod':
          return this.doGetPod(params, startTime);

        case 'docs_listPods':
          return this.doListPods(params, startTime);

        case 'docs_refreshIndex':
          return this.doRefreshIndex(params, startTime);

        case 'docs_searchBySignature':
          return this.doSearchBySignature(params, startTime);

        case 'docs_getExamples':
          return this.doGetExamples(params, startTime);

        case 'docs_findRelated':
          return this.doFindRelated(params, startTime);

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

  private async doSearch(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const { query, type, pod, limit = 10 } = params;

    const validationError = this.validateParams(params, ['query']);
    if (validationError) {
      return this.createToolResult(false, null, validationError, startTime);
    }

    let results = await this.searchIndex.search(query, limit * 2);

    // Apply filters
    if (type) {
      results = results.filter(r => r.item.type === type);
    }
    if (pod) {
      results = results.filter(r => r.item.pod === pod);
    }

    results = results.slice(0, limit);

    this.publishEvent(AgentEvents.DOCS_SEARCH_PERFORMED, { query, resultCount: results.length });

    return this.createToolResult(true, {
      query,
      totalResults: results.length,
      results: results.map(r => ({
        name: r.item.name,
        qualifiedName: r.item.qualifiedName,
        type: r.item.type,
        pod: r.item.pod,
        description: r.item.description?.substring(0, 200),
        signature: r.item.signature,
        url: r.item.url,
        score: r.score,
        relevance: r.relevance,
      })),
    }, undefined, startTime);
  }

  private async doGetType(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const { qualifiedName, includeSlots = true } = params;

    const validationError = this.validateParams(params, ['qualifiedName']);
    if (validationError) {
      return this.createToolResult(false, null, validationError, startTime);
    }

    // Search for exact match
    const results = await this.searchIndex.search(qualifiedName, 50);
    const typeItem = results.find(
      r => r.item.qualifiedName === qualifiedName || r.item.name === qualifiedName
    );

    if (!typeItem) {
      return this.createToolResult(false, null, `Type not found: ${qualifiedName}`, startTime);
    }

    let slots: any[] = [];
    if (includeSlots) {
      const allItems = this.searchIndex.getAllItems();
      slots = allItems
        .filter(item => item.parent === qualifiedName || item.parent === typeItem.item.name)
        .slice(0, 50)
        .map(slot => ({
          name: slot.name,
          type: slot.type,
          signature: slot.signature,
          description: slot.description?.substring(0, 150),
        }));
    }

    this.publishEvent(AgentEvents.DOCS_TYPE_FETCHED, { qualifiedName });

    return this.createToolResult(true, {
      type: typeItem.item,
      slots,
      slotCount: slots.length,
    }, undefined, startTime);
  }

  private async doGetPod(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const { podName, source } = params;

    const validationError = this.validateParams(params, ['podName']);
    if (validationError) {
      return this.createToolResult(false, null, validationError, startTime);
    }

    const podItems = await this.searchIndex.searchByPod(podName, 100);

    if (podItems.length === 0) {
      return this.createToolResult(false, null, `Pod not found: ${podName}`, startTime);
    }

    const types = podItems.filter(i => i.type === 'type');
    const slots = podItems.filter(i => i.type === 'slot');
    const examples = podItems.filter(i => i.type === 'example');

    return this.createToolResult(true, {
      pod: podName,
      source: source || 'unknown',
      typeCount: types.length,
      slotCount: slots.length,
      exampleCount: examples.length,
      types: types.slice(0, 20).map(t => ({
        name: t.name,
        qualifiedName: t.qualifiedName,
        description: t.description?.substring(0, 100),
      })),
    }, undefined, startTime);
  }

  private async doListPods(_params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const stats = this.searchIndex.getStats();

    const pods = Object.entries(stats.byPod)
      .map(([name, count]) => ({ name, itemCount: count }))
      .sort((a, b) => b.itemCount - a.itemCount);

    return this.createToolResult(true, {
      totalPods: pods.length,
      totalItems: stats.totalItems,
      pods,
    }, undefined, startTime);
  }

  private async doRefreshIndex(_params: Record<string, any>, startTime: number): Promise<ToolResult> {
    this.setBusy();

    try {
      // Clear existing index
      this.searchIndex.clear();

      // Re-parse local documentation from all instances
      const db = getFantomDatabase();
      await db.initialize();
      const instances = await db.getAllInstances();

      this.logger.info(`Re-parsing local docs from ${instances.length} instances...`);

      let totalItems = 0;
      const results: { instance: string; itemCount: number; error?: string }[] = [];

      for (const instance of instances) {
        try {
          // Parse docs for this instance (will also save to cache)
          const parseResult = await parseInstanceDocs({
            instanceId: instance.id,
            forceRefresh: true,
          });

          if (parseResult && parseResult.items && parseResult.items.length > 0) {
            // Map to FantomDocItem format
            const mapType = (t: string): 'type' | 'slot' | 'example' | 'guide' => {
              switch (t) {
                case 'function': return 'slot';
                case 'tag': return 'type';
                case 'chapter': return 'guide';
                case 'type':
                case 'slot':
                case 'example':
                case 'guide':
                  return t;
                default: return 'type';
              }
            };
            const mappedItems = parseResult.items.map(item => ({
              id: item.id,
              name: item.name,
              qualifiedName: item.qualifiedName,
              type: mapType(item.type),
              pod: item.pod,
              description: item.description,
              signature: item.signature,
              url: item.url,
              keywords: item.keywords,
            }));
            await this.searchIndex.addItems(mappedItems);
            totalItems += parseResult.items.length;
            results.push({ instance: instance.name, itemCount: parseResult.items.length });
            this.logger.info(`Indexed ${parseResult.items.length} items from ${instance.name}`);
          } else {
            results.push({ instance: instance.name, itemCount: 0 });
          }
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Failed to parse docs for ${instance.name}: ${error}`);
          results.push({ instance: instance.name, itemCount: 0, error });
        }
      }

      this.updateIndexStats();
      this.publishEvent(AgentEvents.DOCS_INDEX_UPDATED, { stats: this.indexStats });

      return this.createToolResult(true, {
        success: true,
        totalItems,
        instanceResults: results,
        stats: this.indexStats,
      }, undefined, startTime);
    } finally {
      this.setReady();
    }
  }

  private async doSearchBySignature(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const { signature, returnType, limit = 10 } = params;

    const allItems = this.searchIndex.getAllItems();

    let matches = allItems.filter(item => {
      if (!item.signature) return false;
      return item.signature.toLowerCase().includes(signature.toLowerCase());
    });

    if (returnType) {
      matches = matches.filter(item => {
        if (!item.signature) return false;
        return item.signature.includes(returnType);
      });
    }

    return this.createToolResult(true, {
      query: { signature, returnType },
      totalResults: Math.min(matches.length, limit),
      results: matches.slice(0, limit).map(item => ({
        name: item.name,
        qualifiedName: item.qualifiedName,
        signature: item.signature,
        pod: item.pod,
        url: item.url,
      })),
    }, undefined, startTime);
  }

  private async doGetExamples(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const { qualifiedName, maxExamples = 5 } = params;

    const allItems = this.searchIndex.getAllItems();

    // Find items with code examples related to the qualified name
    const withExamples = allItems.filter(item => {
      if (!item.codeExample) return false;
      return (
        item.qualifiedName === qualifiedName ||
        item.parent === qualifiedName ||
        item.name === qualifiedName
      );
    });

    return this.createToolResult(true, {
      qualifiedName,
      exampleCount: Math.min(withExamples.length, maxExamples),
      examples: withExamples.slice(0, maxExamples).map(item => ({
        name: item.name,
        type: item.type,
        codeExample: item.codeExample,
        description: item.description?.substring(0, 100),
      })),
    }, undefined, startTime);
  }

  private async doFindRelated(params: Record<string, any>, startTime: number): Promise<ToolResult> {
    const { qualifiedName, relationTypes = ['slots', 'parent'], limit = 10 } = params;

    const allItems = this.searchIndex.getAllItems();
    const targetItem = allItems.find(
      i => i.qualifiedName === qualifiedName || i.name === qualifiedName
    );

    const relations: Record<string, any[]> = {};

    if (relationTypes.includes('slots')) {
      relations.slots = allItems
        .filter(i => i.parent === qualifiedName || i.parent === targetItem?.name)
        .slice(0, limit)
        .map(i => ({ name: i.name, type: i.type, signature: i.signature }));
    }

    if (relationTypes.includes('parent') && targetItem?.parent) {
      const parentItem = allItems.find(i => i.name === targetItem.parent);
      if (parentItem) {
        relations.parent = [{
          name: parentItem.name,
          qualifiedName: parentItem.qualifiedName,
          type: parentItem.type,
        }];
      }
    }

    if (relationTypes.includes('children')) {
      relations.children = allItems
        .filter(i => i.parent === qualifiedName)
        .slice(0, limit)
        .map(i => ({ name: i.name, qualifiedName: i.qualifiedName, type: i.type }));
    }

    return this.createToolResult(true, {
      qualifiedName,
      relations,
    }, undefined, startTime);
  }

  // Helper methods

  private updateIndexStats(): void {
    const stats = this.searchIndex.getStats();
    this.indexStats = {
      totalItems: stats.totalItems,
      byType: stats.byType,
      byPod: stats.byPod,
      bySource: { fantom: stats.totalItems },
      lastUpdated: new Date(),
    };
  }

  // Public accessors for integration

  getSearchIndex(): SearchIndex {
    return this.searchIndex;
  }

  getIndexStats(): IndexStats | null {
    return this.indexStats;
  }
}
