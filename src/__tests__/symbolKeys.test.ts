/**
 * Stable symbol keys (lazy-incremental-indexing.md 3.8, phase 2): ids survive
 * a line shift, overloads get distinct keys, the key base is the owning
 * (nested) git root, PARSER_SCHEMA_VERSION 2 and key_base drive the hash
 * gate, and a populated legacy graph store gains symbol_key / body_sha
 * without losing nodes. Temp dirs only.
 */
import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.setTimeout(60_000);

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fantom-symkey-'));
process.env.MCPFANTOM_CACHE_DIR = cacheDir;

const { symbolKey, nodeIdFor, applySymbolKeys, createKeyBaseResolver, storedKeyBase, legacyNodeId, bodySha } = await import('../fantom-code/symbolKey.js');
const { FantomCodeParser } = await import('../fantom-code/codeParser.js');
const { generateFunctionId } = await import('../fantom-code/types.js');
const { PARSER_SCHEMA_VERSION, indexVersionFor } = await import('../fantom-code/indexVersion.js');
const { gateCandidates } = await import('../indexing/changeDetector.js');
const { createTestDb, addProject } = await import('../indexing/__testSupport__/lazyIndexTestDb.js');

afterAll(async () => {
  try {
    const { closeAllProjectConnections } = await import('../graph/projectGraphConnection.js');
    await closeAllProjectConnections();
  } catch { /* not opened */ }
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

const FAN = `class Calc
{
  Int add(Int a, Int b)
  {
    return a + b
  }

  Str name() { "calc" }
}
`;

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

describe('symbolKey', () => {
  it('has no line number: inserting 10 lines above keeps key and id', () => {
    const dir = tmp('symkey-shift-');
    const file = path.join(dir, 'Calc.fan');
    fs.writeFileSync(file, FAN);
    const p = new FantomCodeParser(7, { podName: 'demo', dependencies: [], srcDirs: ['fan'] } as any);
    const a = p.parseFile(file);
    const ma = applySymbolKeys(a, { projectId: 7, keyBase: dir });
    fs.writeFileSync(file, '// pad\n'.repeat(10) + FAN);
    const b = p.parseFile(file);
    const mb = applySymbolKeys(b, { projectId: 7, keyBase: dir });

    expect(ma.length).toBeGreaterThanOrEqual(3);
    const ids = (ms: typeof ma) => Object.fromEntries(ms.map(m => [m.qualifiedName, [m.newId, m.symbolKey, m.bodySha]]));
    expect(ids(mb)).toEqual(ids(ma));
    // (The regex parser's legacy ids carry no line; tree-sitter's do.)
    for (const m of mb) expect(m.newId).toMatch(/^[0-9a-f]{16}$/);
    // Parsed ids were rewritten in place (graph builder reuses them).
    const add = b.types[0].methods.find(m => m.name === 'add')!;
    expect(add.id).toBe(ids(ma)[add.qualifiedName][0]);
    expect(add.symbolKey).toBe(ids(ma)[add.qualifiedName][1]);
  });

  it('a line-numbered legacy id moves with the line, the stable id does not', () => {
    const fn = (line: number) => ({ filePath: '/r/m.ts', types: [], imports: [], usings: [], errors: [],
      functions: [{ id: legacyNodeId('/r/m.ts', 'm.f', line), projectId: 1, name: 'f', qualifiedName: 'm.f', type: 'function', filePath: '/r/m.ts', lineNumber: line, calls: [] }] }) as any;
    const a = applySymbolKeys(fn(3), { projectId: 1, keyBase: '/r', source: 'x\n'.repeat(20) })[0];
    const b = applySymbolKeys(fn(13), { projectId: 1, keyBase: '/r', source: 'x\n'.repeat(20) })[0];
    expect(a.legacyId).not.toBe(b.legacyId);
    expect(a.newId).toBe(b.newId);
  });

  it('legacyNodeId matches the old generateFunctionId formula', () => {
    expect(legacyNodeId('/a/b.fan', 'demo::B.x', 12)).toBe(generateFunctionId('/a/b.fan', 'demo::B.x', 12));
  });

  it('body sha ignores indentation and blank lines', () => {
    expect(bodySha(['  a', '', '    b'])).toBe(bodySha(['a', 'b']));
    expect(bodySha(['a', 'b'])).not.toBe(bodySha(['a', 'c']));
  });

  it('keeps projectId out of the portable key and in the store id', () => {
    const k = symbolKey('src/A.fan', 'demo::A.x');
    expect(nodeIdFor(1, k)).not.toBe(nodeIdFor(2, k));
    expect(symbolKey('src/A.fan', 'demo::A.x')).toBe(k);
  });

  it('disambiguates overloads by parameter types, then by ordinal', () => {
    const fn = (line: number, params: string[]) => ({
      id: `legacy${line}`, projectId: 1, name: 'f', qualifiedName: 'm.f', type: 'function', filePath: '/r/m.ts',
      lineNumber: line, lineEnd: line, signature: '', parameters: params.map(t => ({ name: 'x', type: t })),
      calls: [], isPublic: true,
    }) as any;
    const parsed = {
      filePath: '/r/m.ts', types: [], imports: [], usings: [], errors: [],
      functions: [fn(1, ['Int']), fn(3, ['Str']), fn(5, ['Str'])],
    } as any;
    const ms = applySymbolKeys(parsed, { projectId: 1, keyBase: '/r', source: 'a\nb\nc\nd\ne\nf' });
    expect(new Set(ms.map(m => m.newId)).size).toBe(3);
    expect(ms[0].symbolKey).toBe(symbolKey('m.ts', 'm.f', 'Int'));
    expect(ms[1].symbolKey).toBe(symbolKey('m.ts', 'm.f', 'Str'));
    expect(ms[2].symbolKey).toBe(symbolKey('m.ts', 'm.f', 'Str', 1));
    // A single symbol uses neither.
    const one = applySymbolKeys({ ...parsed, functions: [fn(1, ['Int'])] }, { projectId: 1, keyBase: '/r', source: 'a' });
    expect(one[0].symbolKey).toBe(symbolKey('m.ts', 'm.f'));
  });

  it('strips an absolute-path namespace from the qualified name', () => {
    const parsed = {
      filePath: '/home/u/r/x.ts', types: [], imports: [], usings: [], errors: [],
      functions: [{ id: 'a', projectId: 1, name: 'f', qualifiedName: '/home/u/r/x.ts::f', type: 'function', filePath: '/home/u/r/x.ts', lineNumber: 1, calls: [] }],
    } as any;
    const other = JSON.parse(JSON.stringify(parsed).split('/home/u/').join('/srv/clone/'));
    const a = applySymbolKeys(parsed, { projectId: 1, keyBase: '/home/u/r', source: 'x' });
    const b = applySymbolKeys(other, { projectId: 1, keyBase: '/srv/clone/r', source: 'x' });
    expect(a[0].symbolKey).toBe(b[0].symbolKey);
  });
});

describe('key base', () => {
  it('is the longest (nested) git root, else the project root', () => {
    const root = tmp('symkey-base-');
    fs.mkdirSync(path.join(root, '.git'));
    fs.mkdirSync(path.join(root, 'libs', 'inner', '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, 'libs', 'inner', 'src'), { recursive: true });
    const resolve = createKeyBaseResolver(root);
    expect(resolve(path.join(root, 'a.fan'))).toBe(root);
    expect(resolve(path.join(root, 'libs', 'inner', 'src', 'b.fan'))).toBe(path.join(root, 'libs', 'inner'));
    expect(storedKeyBase(resolve(path.join(root, 'a.fan')), root)).toBe('');

    const plain = tmp('symkey-nogit-');
    // No .git anywhere under tmp for this dir (tmp is not a repo): project root.
    expect(createKeyBaseResolver(plain)(path.join(plain, 'x', 'y.fan'))).toBe(plain);

    // The same file keys the same from the inner repo, wherever it is mounted.
    const parsed = (abs: string) => ({ filePath: abs, types: [], imports: [], usings: [], errors: [],
      functions: [{ id: 'a', projectId: 1, name: 'f', qualifiedName: 'p::f', type: 'function', filePath: abs, lineNumber: 1, calls: [] }] }) as any;
    const f = path.join(root, 'libs', 'inner', 'src', 'b.fan');
    const k = applySymbolKeys(parsed(f), { projectId: 1, keyBase: resolve(f), source: 'x' })[0].symbolKey;
    expect(k).toBe(symbolKey('src/b.fan', 'p::f'));
  });
});

describe('hash gate', () => {
  it('re-parses a file indexed under parser schema 1, and on a key base change', async () => {
    expect(PARSER_SCHEMA_VERSION).toBe(2);
    const db = await createTestDb();
    try {
      const dir = tmp('symkey-gate-');
      const file = path.join(dir, 'a.ts');
      fs.writeFileSync(file, 'export const a = 1;\n');
      const st = fs.statSync(file);
      const crypto = await import('crypto');
      const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      const pid = await addProject(db.prisma, 'g', dir);
      const project = { id: pid, name: 'g', path: dir, language: 'typescript', parserType: 'tree-sitter-wasm' };
      const current = indexVersionFor(file, 'tree-sitter-wasm');
      const v1 = current.replace(/^2:/, '1:');
      await db.prisma.indexedFile.create({ data: {
        projectId: pid, filePath: file, mtimeMs: BigInt(Math.floor(st.mtimeMs)), contentSha: sha, byteSize: st.size, indexVersion: v1,
      } });
      expect((await gateCandidates(db.prisma, project, [file], [])).changed).toEqual([file]);

      await db.prisma.indexedFile.update({ where: { projectId_filePath: { projectId: pid, filePath: file } }, data: { indexVersion: current } });
      expect((await gateCandidates(db.prisma, project, [file], [])).unchanged).toBe(1);

      // Key scheme 2: a stored key base that no longer matches re-parses.
      await db.prisma.indexedFile.update({ where: { projectId_filePath: { projectId: pid, filePath: file } }, data: { keyBase: '/elsewhere' } });
      expect((await gateCandidates(db.prisma, project, [file], [])).unchanged).toBe(1); // scheme 1: not gated
      expect((await gateCandidates(db.prisma, { ...project, keyScheme: 2 }, [file], [])).changed).toEqual([file]);
    } finally {
      await db.close();
    }
  });
});

describe('graph store', () => {
  it('adds symbol_key / body_sha to a populated legacy store without losing nodes', async () => {
    const { createNodesFromBatch } = await import('../graph/ladybugGraphBuilder.js');
    const { ladybugQuery } = await import('../graph/ladybugConnection.js');
    const pid = 9101;
    const base = { projectId: pid, nodeType: 'function', filePath: '/r/a.fan' };
    await createNodesFromBatch([{ ...base, id: 'legacy0000000001', name: 'a', qualifiedName: 'p::a' }]);
    await createNodesFromBatch([{ ...base, id: 'stable0000000001', name: 'b', qualifiedName: 'p::b', symbolKey: 'k1', bodySha: 's1' }]);
    const rows = await ladybugQuery<{ id: string; k: string; s: string }>(pid,
      `MATCH (n:CodeNode) RETURN n.id AS id, n.symbol_key AS k, n.body_sha AS s ORDER BY n.id`);
    expect(rows).toEqual([
      { id: 'legacy0000000001', k: '', s: '' },
      { id: 'stable0000000001', k: 'k1', s: 's1' },
    ]);
  });
});
