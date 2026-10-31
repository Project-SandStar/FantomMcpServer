import { LadybugGraphBuilder } from '../graph/ladybugGraphBuilder.js';

// TS/JS/Vue qualified names are "<project>::fn", so two files with a `parse`
// share one qn. Both must become graph nodes, and both callers must link.
function fn(file: string, name: string, line: number, calls: string[] = []) {
  return {
    id: `${file}:${name}:${line}`,
    projectId: 1, name, qualifiedName: `P::${name}`, type: 'method',
    filePath: file, lineNumber: line, lineEnd: line + 5, signature: `${name}()`,
    parameters: [], category: 'other', tags: [], facets: [],
    isPublic: true, isStatic: false, isAbstract: false, isOverride: false, isVirtual: false,
    calls: calls.map(c => ({ calledName: c, lineNumber: line + 1, isStatic: false, isDynamic: false, isConstructor: false, resolved: false })),
  };
}

describe('LadybugGraphBuilder: same qualified name in two files', () => {
  it('keeps both nodes and links both callers', async () => {
    const files = [
      { filePath: '/p/types.ts', types: [], functions: [fn('/p/types.ts', 'balanceCheck', 10)], imports: [] },
      { filePath: '/p/apple.ts', types: [], functions: [fn('/p/apple.ts', 'parse', 30, ['balanceCheck'])], imports: [] },
      { filePath: '/p/generic.ts', types: [], functions: [fn('/p/generic.ts', 'parse', 50, ['balanceCheck'])], imports: [] },
    ];
    const b = new LadybugGraphBuilder(1);
    const { nodeRows, edgeRows } = await b.planFiles(files as never);
    const parseIds = nodeRows.filter(n => n.name === 'parse').map(n => n.id).sort();
    expect(parseIds).toEqual(['/p/apple.ts:parse:30', '/p/generic.ts:parse:50']);
    const callers = edgeRows
      .filter(e => e.edgeType === 'calls' && e.targetId === '/p/types.ts:balanceCheck:10')
      .map(e => e.sourceId).sort();
    expect(callers).toEqual(['/p/apple.ts:parse:30', '/p/generic.ts:parse:50']);
  });
});

describe('LadybugGraphBuilder: indexed name resolution', () => {
  it('resolves pod, class-context and unique simple names like the old scans', () => {
    const b = new LadybugGraphBuilder(1) as any;
    b.preloadExistingNames([
      ['sys::Str', 'str'],
      ['acme.Foo.run', 'foo-run'],
      ['acme.Bar.run', 'bar-run'],
      ['acme.Foo.only', 'foo-only'],
      // Old rule kept: "pod::Bar.run" has no "." before Bar, so no context match.
      ['pod::Baz.run', 'baz-run'],
      ['other::Str', 'str2'],
    ]);
    expect(b.resolveReference('sys::Str')).toBe('str');
    // Pod-qualified: first inserted wins.
    expect(b.resolveReference('Str')).toBe('str');
    expect(b.resolveReference('this.run', { className: 'Bar' })).toBe('bar-run');
    expect(b.resolveReference('run', { className: 'Foo' })).toBe('foo-run');
    // "run" is not unique without a class; "only" is.
    expect(b.resolveReference('run')).toBeUndefined();
    expect(b.resolveReference('only')).toBe('foo-only');
    expect(b.resolveReference('missing')).toBeUndefined();
    expect(b.resolveReference('this.run', { className: 'Baz' })).toBeUndefined();
  });

  it('resolves 20k names x 20k refs quickly', () => {
    const b = new LadybugGraphBuilder(1) as any;
    const N = 20000;
    const entries: [string, string][] = [];
    for (let i = 0; i < N; i++) entries.push([`p::C${i}.m${i}`, `id${i}`]);
    b.preloadExistingNames(entries);
    const t0 = Date.now();
    for (let i = 0; i < N; i++) expect(b.resolveReference(`m${i}`)).toBe(`id${i}`);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});
