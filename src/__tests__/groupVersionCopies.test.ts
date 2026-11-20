import { describe, it, expect } from '@jest/globals';
import { groupVersionCopies } from '../embedding/semanticSearchService.js';

const h = (nodeId: string, qualifiedName: string, filePath: string, projectId?: number) => ({ nodeId, qualifiedName, filePath, lineStart: 1, projectId }) as {
  nodeId: string; qualifiedName: string; filePath: string; lineStart: number; projectId?: number; alsoIn?: Array<{ projectId: number; label: string; nodeId: string; filePath: string; lineStart: number }> };
const label = (p: number) => `v${p}`;

describe('groupVersionCopies', () => {
  it('folds the same symbol + file name from other projects under the first hit, keeping order', () => {
    const out = groupVersionCopies([
      h('a1', 'sys::Unit.convertTo', '/x/4.0.4/Unit.fan', 1),
      h('b', 'sys::Other', '/x/Other.fan', 1),
      h('a2', 'sys::Unit.convertTo', '/y/4.0.6/Unit.fan', 2),
      h('a3', 'sys::Unit.convertTo', '/z/3.1/Unit.fan', 3),
    ], label);
    expect(out.map(r => r.nodeId)).toEqual(['a1', 'b']);
    expect(out[0].alsoIn!.map(a => a.label)).toEqual(['v2', 'v3']);
  });
  it('never folds within one project, or a different file name, or hits without a project', () => {
    const out = groupVersionCopies([
      h('a1', 'p::F.make', '/a/F.fan', 1),
      h('a2', 'p::F.make', '/a/F.fan', 1),
      h('c', 'p::F.make', '/b/G.fan', 2),
      h('d', 'p::F.make', '/a/F.fan', undefined),
    ], label);
    expect(out.map(r => r.nodeId)).toEqual(['a1', 'a2', 'c', 'd']);
    expect(out[0].alsoIn).toBeUndefined();
  });
  it('one alsoIn entry per project', () => {
    const out = groupVersionCopies([h('a', 'q', '/F.fan', 1), h('b', 'q', '/F.fan', 2), h('c', 'q', '/F.fan', 2)], label);
    expect(out.map(r => r.nodeId)).toEqual(['a', 'c']);
    expect(out[0].alsoIn!.map(a => a.projectId)).toEqual([2]);
  });
});
