/**
 * Tests for MCP Documentation Tools
 *
 * These tests verify the search functionality of the MCP Fantom server tools.
 * The tests use mocked search indices to ensure consistent, fast test execution.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { SearchIndex } from '../search/index.js';
import type { FantomDocItem } from '../types/index.js';
import type { LocalDocItem } from '../parser/local/types.js';

// Mock data for Fantom documentation
const mockFantomDocs: FantomDocItem[] = [
  {
    id: 'sys-Bool',
    type: 'type',
    name: 'Bool',
    qualifiedName: 'sys::Bool',
    pod: 'sys',
    description: 'Bool represents a boolean true/false value.',
    url: 'https://fantom.org/doc/sys/Bool.html',
    keywords: ['boolean', 'true', 'false', 'logic'],
  },
  {
    id: 'sys-Str',
    type: 'type',
    name: 'Str',
    qualifiedName: 'sys::Str',
    pod: 'sys',
    description: 'Str represents a sequence of Unicode characters.',
    url: 'https://fantom.org/doc/sys/Str.html',
    keywords: ['string', 'text', 'unicode', 'characters'],
    codeExample: 'str := "hello world"',
  },
  {
    id: 'sys-Int',
    type: 'type',
    name: 'Int',
    qualifiedName: 'sys::Int',
    pod: 'sys',
    description: 'Int is a 64-bit signed integer.',
    url: 'https://fantom.org/doc/sys/Int.html',
    keywords: ['integer', 'number', 'numeric'],
  },
  {
    id: 'sys-Str-toStr',
    type: 'slot',
    name: 'toStr',
    qualifiedName: 'sys::Str.toStr',
    pod: 'sys',
    parent: 'Str',
    signature: 'virtual override Str toStr()',
    description: 'Return this.',
    url: 'https://fantom.org/doc/sys/Str.html#toStr',
    keywords: ['convert', 'string'],
  },
  {
    id: 'sys-Str-size',
    type: 'slot',
    name: 'size',
    qualifiedName: 'sys::Str.size',
    pod: 'sys',
    parent: 'Str',
    signature: 'Int size()',
    description: 'Return the number of characters in this string.',
    url: 'https://fantom.org/doc/sys/Str.html#size',
    keywords: ['length', 'count', 'characters'],
  },
  {
    id: 'inet-HttpClient',
    type: 'type',
    name: 'HttpClient',
    qualifiedName: 'inet::HttpClient',
    pod: 'inet',
    description: 'HttpClient is used to make HTTP requests to a server.',
    url: 'https://fantom.org/doc/inet/HttpClient.html',
    keywords: ['http', 'network', 'request', 'web'],
  },
  {
    id: 'concurrent-Actor',
    type: 'type',
    name: 'Actor',
    qualifiedName: 'concurrent::Actor',
    pod: 'concurrent',
    description: 'Actor is the base class for actors which provide concurrency.',
    url: 'https://fantom.org/doc/concurrent/Actor.html',
    keywords: ['concurrency', 'parallel', 'message', 'async'],
  },
  {
    id: 'sys-guide-pods',
    type: 'guide',
    name: 'Pods',
    pod: 'sys',
    description: 'Guide to understanding Fantom pods and modules.',
    url: 'https://fantom.org/doc/docLang/Pods.html',
    keywords: ['pods', 'modules', 'packages', 'organization'],
  },
  {
    id: 'sys-example-hello',
    type: 'example',
    name: 'Hello World',
    pod: 'sys',
    description: 'A simple hello world example in Fantom.',
    url: 'https://fantom.org/doc/examples/hello.html',
    keywords: ['example', 'hello', 'beginner'],
    codeExample: 'class Main { static Void main() { echo("Hello, World!") } }',
  },
];

// Mock data for Haxall documentation
const mockHaxallDocs: FantomDocItem[] = [
  {
    id: 'hx-HxContext',
    type: 'type',
    name: 'HxContext',
    qualifiedName: 'hx::HxContext',
    pod: 'hx',
    description: 'HxContext provides the execution context for Haxall operations.',
    url: 'https://haxall.io/doc/hx/HxContext.html',
    keywords: ['context', 'execution', 'runtime'],
  },
  {
    id: 'axon-readAll',
    type: 'slot',
    name: 'readAll',
    qualifiedName: 'axon::readAll',
    pod: 'axon',
    signature: 'readAll(filter)',
    description: 'Read all records matching a filter expression.',
    url: 'https://haxall.io/doc/axon/readAll.html',
    keywords: ['read', 'query', 'filter', 'records'],
  },
  {
    id: 'haystack-Dict',
    type: 'type',
    name: 'Dict',
    qualifiedName: 'haystack::Dict',
    pod: 'haystack',
    description: 'Dict represents a map of name/value tag pairs.',
    url: 'https://haxall.io/doc/haystack/Dict.html',
    keywords: ['dictionary', 'tags', 'map', 'haystack'],
  },
  {
    id: 'obs-Obs',
    type: 'type',
    name: 'Obs',
    qualifiedName: 'obs::Obs',
    pod: 'obs',
    description: 'Obs provides observable pattern implementation.',
    url: 'https://haxall.io/doc/obs/Obs.html',
    keywords: ['observable', 'reactive', 'watch'],
  },
];

// Mock data for local documentation
const mockLocalDocs: LocalDocItem[] = [
  {
    id: 'local-sys-Bool',
    name: 'Bool',
    qualifiedName: 'sys::Bool',
    type: 'type',
    pod: 'sys',
    description: 'Bool represents a boolean true/false value.',
    url: 'file:///skyspark/doc/sys/Bool.html',
    version: '4.0.4',
    instanceId: 1,
    language: 'fantom',
    runtime: 'fantom',
    keywords: ['boolean', 'true', 'false'],
  },
  {
    id: 'local-lib-axon-abs',
    name: 'abs',
    qualifiedName: 'func:abs',
    type: 'function',
    pod: 'lib-axon',
    signature: 'abs(num)',
    description: 'Return the absolute value of a number.',
    url: 'file:///skyspark/doc/lib-axon/abs.html',
    version: '4.0.4',
    instanceId: 1,
    language: 'axon',
    runtime: 'fantom',
    keywords: ['math', 'absolute', 'number'],
  },
  {
    id: 'local-lib-axon-readAll',
    name: 'readAll',
    qualifiedName: 'func:readAll',
    type: 'function',
    pod: 'lib-axon',
    signature: 'readAll(filter)',
    description: 'Read all records matching a filter.',
    url: 'file:///skyspark/doc/lib-axon/readAll.html',
    version: '4.0.4',
    instanceId: 1,
    language: 'axon',
    runtime: 'fantom',
    keywords: ['read', 'query', 'filter'],
  },
  {
    id: 'local-sys-Str',
    name: 'Str',
    qualifiedName: 'sys::Str',
    type: 'type',
    pod: 'sys',
    description: 'String type for text values.',
    url: 'file:///skyspark/doc/sys/Str.html',
    version: '4.0.4',
    instanceId: 2,
    language: 'fantom',
    runtime: 'fantom',
    keywords: ['string', 'text'],
  },
];

describe('MCP Documentation Tools', () => {
  let searchIndex: SearchIndex;

  beforeAll(async () => {
    // Initialize search index with mock data
    searchIndex = new SearchIndex();
    await searchIndex.addItems(mockFantomDocs);
  });

  afterAll(() => {
    searchIndex.clear();
  });

  describe('searchFantomDocs', () => {
    it('should return results for valid query', async () => {
      const results = await searchIndex.search('Bool', 10);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].item.name).toBe('Bool');
      expect(results[0].item.qualifiedName).toBe('sys::Bool');
      expect(results[0].score).toBeGreaterThan(0);
    });

    it('should return results with relevance scoring', async () => {
      const results = await searchIndex.search('Str', 10);

      expect(results.length).toBeGreaterThan(0);
      // Exact match should have high relevance
      const strType = results.find((r) => r.item.name === 'Str' && r.item.type === 'type');
      expect(strType).toBeDefined();
      expect(strType!.relevance).toMatch(/exact|high/);
    });

    it('should filter by type', async () => {
      // Get all results first
      const allResults = await searchIndex.search('Str', 20);

      // Filter by type (simulating the tool's behavior)
      const typeFiltered = allResults.filter((r) => r.item.type === 'type');
      const slotFiltered = allResults.filter((r) => r.item.type === 'slot');

      // We should have both types and slots for 'Str'
      expect(typeFiltered.length).toBeGreaterThan(0);
      expect(slotFiltered.length).toBeGreaterThan(0);

      // Type results should only contain types
      typeFiltered.forEach((r) => {
        expect(r.item.type).toBe('type');
      });

      // Slot results should only contain slots
      slotFiltered.forEach((r) => {
        expect(r.item.type).toBe('slot');
      });
    });

    it('should filter by pod', async () => {
      // Search for terms that exist in sys pod
      const sysResults = await searchIndex.search('Bool', 10);
      expect(sysResults.length).toBeGreaterThan(0);

      // Filter to only sys pod results
      const filteredSys = sysResults.filter((r) => r.item.pod === 'sys');
      expect(filteredSys.length).toBeGreaterThan(0);
      filteredSys.forEach((r) => {
        expect(r.item.pod).toBe('sys');
      });

      // Search for inet pod items
      const inetResults = await searchIndex.search('HttpClient', 10);
      const httpResult = inetResults.find((r) => r.item.name === 'HttpClient');
      expect(httpResult).toBeDefined();
      expect(httpResult!.item.pod).toBe('inet');
    });

    it('should respect limit parameter', async () => {
      const results5 = await searchIndex.search('sys', 5);
      const results2 = await searchIndex.search('sys', 2);

      expect(results5.length).toBeLessThanOrEqual(5);
      expect(results2.length).toBeLessThanOrEqual(2);
      expect(results2.length).toBeLessThan(results5.length);
    });

    it('should search by keywords', async () => {
      const results = await searchIndex.search('boolean', 10);

      // Bool should be found via its keywords
      const boolResult = results.find((r) => r.item.name === 'Bool');
      expect(boolResult).toBeDefined();
    });

    it('should search in descriptions', async () => {
      const results = await searchIndex.search('Unicode', 10);

      // Str should be found via its description
      const strResult = results.find((r) => r.item.name === 'Str');
      expect(strResult).toBeDefined();
    });

    it('should return empty array for no matches', async () => {
      const results = await searchIndex.search('xyznonexistent123', 10);
      expect(results).toEqual([]);
    });

    it('should include code examples when available', async () => {
      const results = await searchIndex.search('Str', 10);
      const strResult = results.find((r) => r.item.name === 'Str' && r.item.type === 'type');

      expect(strResult).toBeDefined();
      expect(strResult!.item.codeExample).toBeDefined();
      expect(strResult!.item.codeExample).toContain('hello world');
    });
  });

  describe('searchHaxallDocs', () => {
    let haxallIndex: SearchIndex;

    beforeAll(async () => {
      haxallIndex = new SearchIndex();
      await haxallIndex.addItems(mockHaxallDocs);
    });

    afterAll(() => {
      haxallIndex.clear();
    });

    it('should return results for valid query', async () => {
      const results = await haxallIndex.search('HxContext', 10);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].item.name).toBe('HxContext');
      expect(results[0].item.pod).toBe('hx');
    });

    it('should handle pod-specific search', async () => {
      const allResults = await haxallIndex.search('read', 20);

      // Filter by axon pod
      const axonResults = allResults.filter((r) => r.item.pod === 'axon');

      expect(axonResults.length).toBeGreaterThan(0);
      expect(axonResults.some((r) => r.item.name === 'readAll')).toBe(true);
    });

    it('should find haystack types', async () => {
      const results = await haxallIndex.search('Dict', 10);

      const dictResult = results.find((r) => r.item.name === 'Dict');
      expect(dictResult).toBeDefined();
      expect(dictResult!.item.pod).toBe('haystack');
    });

    it('should search by function signatures', async () => {
      const results = await haxallIndex.search('filter', 10);

      // readAll has filter in its signature and description
      const readAllResult = results.find((r) => r.item.name === 'readAll');
      expect(readAllResult).toBeDefined();
    });
  });

  describe('searchLocalDocs', () => {
    // Helper function to simulate searchLocalDocs behavior
    function searchLocalDocsMock(
      query: string,
      items: LocalDocItem[],
      options: {
        instanceId?: number;
        pod?: string;
        type?: LocalDocItem['type'];
        language?: 'fantom' | 'axon';
        limit?: number;
      } = {}
    ): LocalDocItem[] {
      const { instanceId, pod, type, language, limit = 20 } = options;
      const queryLower = query.toLowerCase();

      let results = items.filter((item) => {
        // Must match query
        const matchesQuery =
          item.name.toLowerCase().includes(queryLower) ||
          item.qualifiedName.toLowerCase().includes(queryLower) ||
          item.description.toLowerCase().includes(queryLower) ||
          item.keywords.some((k) => k.toLowerCase().includes(queryLower));

        if (!matchesQuery) return false;

        // Apply filters
        if (instanceId !== undefined && item.instanceId !== instanceId) return false;
        if (pod && item.pod !== pod) return false;
        if (type && item.type !== type) return false;
        if (language && item.language !== language) return false;

        return true;
      });

      // Sort by relevance
      results.sort((a, b) => {
        const aExact = a.name.toLowerCase() === queryLower ? 0 : 1;
        const bExact = b.name.toLowerCase() === queryLower ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;

        const aStartsWith = a.name.toLowerCase().startsWith(queryLower) ? 0 : 1;
        const bStartsWith = b.name.toLowerCase().startsWith(queryLower) ? 0 : 1;
        if (aStartsWith !== bStartsWith) return aStartsWith - bStartsWith;

        return a.name.length - b.name.length;
      });

      return results.slice(0, limit);
    }

    it('should search instance docs', () => {
      const results = searchLocalDocsMock('Bool', mockLocalDocs);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toBe('Bool');
      expect(results[0].qualifiedName).toBe('sys::Bool');
    });

    it('should filter by instanceId', () => {
      // Verify data distribution
      const allInstance1 = mockLocalDocs.filter((d) => d.instanceId === 1);
      const allInstance2 = mockLocalDocs.filter((d) => d.instanceId === 2);

      expect(allInstance1.length).toBe(3);
      expect(allInstance2.length).toBe(1);

      // Search with filter - Bool exists only in instance 1
      const boolInst1 = searchLocalDocsMock('Bool', mockLocalDocs, { instanceId: 1 });
      const boolInst2 = searchLocalDocsMock('Bool', mockLocalDocs, { instanceId: 2 });

      expect(boolInst1.length).toBe(1);
      expect(boolInst2.length).toBe(0);
    });

    it('should filter by type (function)', () => {
      // Search for functions only
      const results = searchLocalDocsMock('abs', mockLocalDocs, {
        type: 'function',
      });

      expect(results.length).toBeGreaterThan(0);
      results.forEach((r) => {
        expect(r.type).toBe('function');
      });
    });

    it('should filter by language', () => {
      // Search for Axon functions
      const axonResults = searchLocalDocsMock('read', mockLocalDocs, {
        language: 'axon',
      });

      expect(axonResults.length).toBeGreaterThan(0);
      axonResults.forEach((r) => {
        expect(r.language).toBe('axon');
      });

      // Search for Fantom types
      const fantomResults = searchLocalDocsMock('Bool', mockLocalDocs, {
        language: 'fantom',
      });

      expect(fantomResults.length).toBeGreaterThan(0);
      fantomResults.forEach((r) => {
        expect(r.language).toBe('fantom');
      });
    });

    it('should filter by pod', () => {
      const libAxonResults = searchLocalDocsMock('abs', mockLocalDocs, {
        pod: 'lib-axon',
      });

      expect(libAxonResults.length).toBeGreaterThan(0);
      libAxonResults.forEach((r) => {
        expect(r.pod).toBe('lib-axon');
      });
    });

    it('should combine multiple filters', () => {
      const results = searchLocalDocsMock('read', mockLocalDocs, {
        instanceId: 1,
        language: 'axon',
        type: 'function',
      });

      expect(results.length).toBe(1);
      expect(results[0].name).toBe('readAll');
      expect(results[0].instanceId).toBe(1);
      expect(results[0].language).toBe('axon');
      expect(results[0].type).toBe('function');
    });

    it('should respect limit parameter', () => {
      // Use queries that match multiple items
      const axonResults1 = searchLocalDocsMock('axon', mockLocalDocs, { limit: 1 });
      const axonResults3 = searchLocalDocsMock('axon', mockLocalDocs, { limit: 3 });

      expect(axonResults1.length).toBeLessThanOrEqual(1);
      expect(axonResults3.length).toBeLessThanOrEqual(3);
    });

    it('should search by keywords', () => {
      const results = searchLocalDocsMock('math', mockLocalDocs);

      // abs has 'math' in keywords
      const absResult = results.find((r) => r.name === 'abs');
      expect(absResult).toBeDefined();
    });

    it('should include version information', () => {
      const results = searchLocalDocsMock('Bool', mockLocalDocs);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].version).toBe('4.0.4');
    });
  });

  describe('SearchIndex utility methods', () => {
    it('should get item by ID', () => {
      const item = searchIndex.getItem('sys-Bool');

      expect(item).toBeDefined();
      expect(item!.name).toBe('Bool');
      expect(item!.qualifiedName).toBe('sys::Bool');
    });

    it('should return undefined for non-existent ID', () => {
      const item = searchIndex.getItem('non-existent-id');
      expect(item).toBeUndefined();
    });

    it('should get all items', () => {
      const items = searchIndex.getAllItems();

      expect(items.length).toBe(mockFantomDocs.length);
      expect(items.some((i) => i.name === 'Bool')).toBe(true);
      expect(items.some((i) => i.name === 'Str')).toBe(true);
    });

    it('should get statistics', () => {
      const stats = searchIndex.getStats();

      expect(stats.totalItems).toBe(mockFantomDocs.length);
      expect(stats.byType).toBeDefined();
      expect(stats.byPod).toBeDefined();
      expect(stats.byType['type']).toBeGreaterThan(0);
      expect(stats.byPod['sys']).toBeGreaterThan(0);
    });

    it('should search by type', async () => {
      const types = await searchIndex.searchByType('type', 10);

      expect(types.length).toBeGreaterThan(0);
      types.forEach((t) => {
        expect(t.type).toBe('type');
      });
    });

    it('should search by pod', async () => {
      const sysItems = await searchIndex.searchByPod('sys', 50);

      expect(sysItems.length).toBeGreaterThan(0);
      sysItems.forEach((item) => {
        expect(item.pod).toBe('sys');
      });
    });

    it('should clear the index', async () => {
      const tempIndex = new SearchIndex();
      await tempIndex.addItems([mockFantomDocs[0]]);

      expect(tempIndex.getStats().totalItems).toBe(1);

      tempIndex.clear();

      expect(tempIndex.getStats().totalItems).toBe(0);
    });
  });

  describe('Edge cases and error handling', () => {
    it('should handle empty query gracefully', async () => {
      const results = await searchIndex.search('', 10);
      // Empty query behavior depends on FlexSearch implementation
      expect(Array.isArray(results)).toBe(true);
    });

    it('should handle special characters in query', async () => {
      const results = await searchIndex.search('sys::Str', 10);
      expect(Array.isArray(results)).toBe(true);
    });

    it('should handle very long queries', async () => {
      const longQuery = 'a'.repeat(1000);
      const results = await searchIndex.search(longQuery, 10);
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(0);
    });

    it('should handle limit of 0', async () => {
      const results = await searchIndex.search('Bool', 0);
      expect(results.length).toBe(0);
    });

    it('should handle negative limit gracefully', async () => {
      // The implementation may handle this differently
      const results = await searchIndex.search('Bool', -1);
      expect(Array.isArray(results)).toBe(true);
    });

    it('should handle concurrent searches', async () => {
      const searches = Promise.all([
        searchIndex.search('Bool', 5),
        searchIndex.search('Str', 5),
        searchIndex.search('Int', 5),
        searchIndex.search('HttpClient', 5),
        searchIndex.search('Actor', 5),
      ]);

      const allResults = await searches;

      expect(allResults.length).toBe(5);
      allResults.forEach((results) => {
        expect(Array.isArray(results)).toBe(true);
      });
    });
  });
});
