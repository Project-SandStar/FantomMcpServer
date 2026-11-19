import { describe, it, expect } from '@jest/globals';
import { FantomFunctionSearchIndex } from '../fantom-code/searchIndex.js';

function fn(id: string, projectId: number, name: string): any {
  return {
    id, projectId, name, qualifiedName: `pod::T.${name}`, className: 'T',
    description: '', documentation: '', signature: `Void ${name}()`, sourceCode: '',
    category: 'method', tags: [], returnType: 'Void', filePath: `/p${projectId}/fan/T.fan`,
    parameters: [], isPublic: true,
  };
}

/** Minimal stand-in for FantomCodeIndexer with the calls rebuildProject uses. */
function fakeIndexer(funcs: any[], types: any[] = []): any {
  const projects = [...new Set(funcs.map(f => f.projectId))].map(id => ({ id, name: `p${id}` }));
  return {
    getProjects: () => projects,
    getProject: (id: number) => projects.find(p => p.id === id),
    getAllFunctions: () => funcs,
    getAllTypes: () => types,
    getFunctionsByProject: (id: number) => funcs.filter(f => f.projectId === id),
  };
}

const ids = (idx: FantomFunctionSearchIndex, q: string) =>
  idx.search(q, { limit: 50 } as any).map((r: any) => (r.function ?? r).id).sort();

describe('FantomFunctionSearchIndex.rebuildProject', () => {
  it('replaces only the given project and keeps the others', () => {
    const idx = new FantomFunctionSearchIndex();
    idx.rebuild(fakeIndexer([fn('a1', 1, 'alphaOld'), fn('b1', 2, 'betaOne')]));

    idx.rebuildProject(fakeIndexer([fn('a2', 1, 'alphaNew'), fn('b1', 2, 'betaOne')]), 1);

    expect(ids(idx, 'alphaOld')).toEqual([]);
    expect(ids(idx, 'alphaNew')).toEqual(['a2']);
    expect(ids(idx, 'betaOne')).toEqual(['b1']);
  });

  it('adds the project types and drops a removed project', () => {
    const idx = new FantomFunctionSearchIndex();
    idx.rebuild(fakeIndexer([fn('a1', 1, 'alphaOld')]));
    const type = { id: 't1', projectId: 1, name: 'GammaType', qualifiedName: 'pod::GammaType', kind: 'class', filePath: '/p1/fan/G.fan', isPublic: true };

    idx.rebuildProject(fakeIndexer([], [type]), 1);
    expect(ids(idx, 'alphaOld')).toEqual([]);
    expect(ids(idx, 'GammaType')).toEqual(['t1']);
    expect(idx.getProject(1)).toBeUndefined();
  });
});
