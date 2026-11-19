/**
 * podParsers: each .fan/.trio file gets the pod of the nearest build.fan; files
 * outside every pod dir get the root pod; a build.fan change expands to its
 * directory. Fixture: a Vue/TS repo that holds two Fantom pods.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildPodMap, podForPath, rootPodMeta, PodParserSet, expandBuildFanPaths,
} from '../fantom-code/podParsers.js';
import { scannerFor } from '../indexing/changeDetector.js';

const ROOT_META = { podName: 'mac-alper-visualytik2026', dependencies: [], srcDirs: ['fan'] };

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-parsers-'));
  write(path.join(dir, 'pod/vizExt/build.fan'), [
    'using build',
    'class Build : BuildPod {',
    '  new make() {',
    '    podName = "bassgViz"',
    '    summary = "Viz extension"',
    '    depends = ["sys 1.0", "haystack 3.1"]',
    '    srcDirs = [`fan/`]',
    '  }',
    '}',
  ].join('\n'));
  write(path.join(dir, 'pod/vizExt/fan/VizExt.fan'), [
    'using haystack',
    'class VizExt {',
    '  ** Commit the diffs',
    '  Grid vizCommit(Obj diffs) { return Etc.emptyGrid }',
    '}',
  ].join('\n'));
  write(path.join(dir, 'pod/vizExt/lib/funcs.trio'), [
    'name: vizRefresh',
    'func',
    'src:',
    '  () => do',
    '    1 + 1',
    '  end',
  ].join('\n'));
  write(path.join(dir, 'pod/other/build.fan'), 'podName = "otherPod"\n');
  write(path.join(dir, 'pod/other/fan/Other.fan'), 'class Other { Void run() {} }\n');
  write(path.join(dir, 'src/main.ts'), 'export function main() {}\n');
  write(path.join(dir, 'stray/Loose.fan'), 'class Loose { Void go() {} }\n');
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('buildPodMap / podForPath', () => {
  it('finds one pod per build.fan and keys it by directory', async () => {
    const map = await buildPodMap(dir);
    expect([...map.values()].map(m => m.podName).sort()).toEqual(['bassgViz', 'otherPod']);
    expect(map.get(path.join(dir, 'pod/vizExt'))?.dependencies).toEqual(['sys', 'haystack']);
  });

  it('longest directory prefix wins, fallback outside pods', async () => {
    const map = await buildPodMap(dir);
    expect(podForPath(path.join(dir, 'pod/vizExt/fan/VizExt.fan'), map, ROOT_META).podName).toBe('bassgViz');
    expect(podForPath(path.join(dir, 'pod/other/fan/Other.fan'), map, ROOT_META).podName).toBe('otherPod');
    expect(podForPath(path.join(dir, 'stray/Loose.fan'), map, ROOT_META).podName).toBe('mac-alper-visualytik2026');
    // A sibling dir with the pod dir as a name prefix is not inside it.
    expect(podForPath(path.join(dir, 'pod/vizExtra/X.fan'), map, ROOT_META).podName).toBe('mac-alper-visualytik2026');
  });

  it('rootPodMeta is always a real object', () => {
    expect(rootPodMeta(undefined, null, 'proj').podName).toBe('proj');
    expect(rootPodMeta(undefined, 'podX', 'proj').podName).toBe('podX');
    expect(rootPodMeta({ podName: 'rootPod', dependencies: [], srcDirs: [] }, 'podX', 'proj').podName).toBe('rootPod');
  });
});

describe('PodParserSet.parse', () => {
  it('names Fantom symbols after the nearest pod, even with no primary parser', async () => {
    const podMap = await buildPodMap(dir);
    const set = new PodParserSet({ projectId: 1, rootMeta: ROOT_META, podMap, primary: null });

    const viz = await set.parse(path.join(dir, 'pod/vizExt/fan/VizExt.fan'));
    expect(viz.types.map(t => t.qualifiedName)).toEqual(['bassgViz::VizExt']);
    const commit = viz.types[0].methods.find(m => m.name === 'vizCommit');
    expect(commit?.qualifiedName).toBe('bassgViz::VizExt.vizCommit');
    expect(commit?.returnType).toBe('Grid');
    expect(commit?.parameters.map(p => [p.name, p.type])).toEqual([['diffs', 'Obj']]);

    const other = await set.parse(path.join(dir, 'pod/other/fan/Other.fan'));
    expect(other.types[0].qualifiedName).toBe('otherPod::Other');

    const loose = await set.parse(path.join(dir, 'stray/Loose.fan'));
    expect(loose.types[0].qualifiedName).toBe('mac-alper-visualytik2026::Loose');
  });

  it('trio records carry the pod name, never unknown::', async () => {
    const podMap = await buildPodMap(dir);
    const set = new PodParserSet({ projectId: 1, rootMeta: ROOT_META, podMap, primary: null });
    const trio = await set.parse(path.join(dir, 'pod/vizExt/lib/funcs.trio'));
    const names = [...trio.functions.map(f => f.qualifiedName), ...trio.types.map(t => t.qualifiedName)];
    expect(names.length).toBeGreaterThan(0);
    for (const qn of names) {
      expect(qn.startsWith('bassgViz::')).toBe(true);
      expect(qn.includes('unknown::')).toBe(false);
    }
  });

  it('build.fan yields no symbols', async () => {
    const set = new PodParserSet({ projectId: 1, rootMeta: ROOT_META, podMap: new Map(), primary: null });
    const r = await set.parse(path.join(dir, 'pod/vizExt/build.fan'));
    expect(r.types).toEqual([]);
    expect(r.functions).toEqual([]);
  });

  it('reuses one fantom tree-sitter parser per pod, regex untouched', async () => {
    const podMap = await buildPodMap(dir);
    const set = new PodParserSet({ projectId: 1, rootMeta: ROOT_META, podMap, primary: null });
    await set.parse(path.join(dir, 'pod/vizExt/fan/VizExt.fan'));
    await set.parse(path.join(dir, 'pod/other/fan/Other.fan'));
    await set.parse(path.join(dir, 'stray/Loose.fan'));
    expect(set.podNames().sort()).toEqual(['bassgViz', 'mac-alper-visualytik2026', 'otherPod']);
    const s = set as unknown as { fan: Map<string, unknown>; regex: Map<string, unknown> };
    expect(s.fan.size).toBe(3);
    expect([...s.fan.values()].every(Boolean)).toBe(true);
    expect(s.regex.size).toBe(0);
  });
});

describe('expandBuildFanPaths', () => {
  it('a build.fan change expands to every source file in its pod', async () => {
    const bf = path.join(dir, 'pod/vizExt/build.fan');
    const out = await expandBuildFanPaths([bf, path.join(dir, 'src/main.ts')], scannerFor('typescript'));
    expect(out).toContain(path.join(dir, 'pod/vizExt/fan/VizExt.fan'));
    expect(out).toContain(path.join(dir, 'pod/vizExt/lib/funcs.trio'));
    expect(out).toContain(path.join(dir, 'src/main.ts'));
    expect(out).not.toContain(path.join(dir, 'pod/other/fan/Other.fan'));
  });

  it('leaves a list with no build.fan unchanged', async () => {
    const paths = [path.join(dir, 'src/main.ts')];
    expect(await expandBuildFanPaths(paths, scannerFor('typescript'))).toEqual(paths);
  });
});
