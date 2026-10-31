/**
 * Fixes found on a Windows Docker host:
 * - "auto" mirror projects skip install trees and FANTOM_MIRROR_EXCLUDE names
 * - xetodoc (4.0.6+) doc pages yield types, slots and Axon functions
 * - UserStore caches verified credentials and throttles users.json writes
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mirrorProjectSpecs, isInstallHome, isInstallTreeRoot } from '../indexing/mirror.js';
import { extractDocFile } from '../parser/local/docHtmlExtractor.js';
import { UserStore } from '../admin/userStore.js';
import { getDocPath } from '../parser/local/skysparkDocScanner.js';
import AdmZip from 'adm-zip';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srvfix-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function touch(p: string, body = ''): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

describe('auto mirror projects skip install trees', () => {
  it('skips install homes, folders of homes, and excluded names', () => {
    const root = path.join(tmp, 'mirror');
    touch(path.join(root, 'mac', 'myPod', 'build.fan'));
    touch(path.join(root, 'mac', 'other', 'src', 'A.fan'));
    touch(path.join(root, 'mac', 'skyspark', 'skyspark-4.0.6', 'fan.props'));
    touch(path.join(root, 'mac', 'haxall', 'haxall-4.0.6', 'home', 'fan.props'));
    touch(path.join(root, 'mac', 'fantom', 'fantom-1.0.82', 'src', 'sys', 'build.fan'));
    touch(path.join(root, 'mac', 'sky312', 'fan.props'));

    expect(isInstallHome(path.join(root, 'mac', 'sky312'))).toBe(true);
    expect(isInstallTreeRoot(path.join(root, 'mac', 'skyspark'))).toBe(true);
    expect(isInstallTreeRoot(path.join(root, 'mac', 'myPod'))).toBe(false);

    const specs = mirrorProjectSpecs({ FANTOM_MIRROR_ROOT: root, FANTOM_MIRROR_PROJECTS: 'auto', FANTOM_MIRROR_EXCLUDE: 'other' });
    expect(specs.map(s => s.name)).toEqual(['mac-myPod']);
  });
});

const STR_HTML = `<html><body><xetodoc-main>
<xetodoc-tab id='doc-header'>class</xetodoc-tab>
<xetodoc-section><h1>Str</h1><xetodoc-slot><code>const class Str : <a href='Obj.html'>Obj</a></code></xetodoc-slot>
<p><p>Str represents a sequence of Unicode characters.</p></p></xetodoc-section>
<xetodoc-tab id='doc-methods'>methods</xetodoc-tab>
<xetodoc-section><xetodoc-prop-table><xetodoc-prop-tr><xetodoc-prop-th><a href='#compare'>compare</a></xetodoc-prop-th><xetodoc-prop-td>x</xetodoc-prop-td></xetodoc-prop-tr></xetodoc-prop-table></xetodoc-section>
<xetodoc-tab id='compare'>compare</xetodoc-tab>
<xetodoc-section><xetodoc-slot><code>virtual Int compare(Obj obj)</code></xetodoc-slot><p><p>Compare based on Unicode.</p></p></xetodoc-section>
<xetodoc-tab id='size'>size</xetodoc-tab>
<xetodoc-section><xetodoc-slot><code>Int size()</code></xetodoc-slot><p><p>Return number of chars.</p></p></xetodoc-section>
</xetodoc-main></body></html>`;

const FUNCS_HTML = `<html><body><xetodoc-main>
<xetodoc-tab id='doc-header'>mixin</xetodoc-tab>
<xetodoc-section><h1>Funcs</h1><xetodoc-slot><code>Funcs : Funcs</code></xetodoc-slot><p></p></xetodoc-section>
<xetodoc-tab id='doc-slots'>slots</xetodoc-tab><xetodoc-section></xetodoc-section>
<xetodoc-tab id='abs'>abs</xetodoc-tab>
<xetodoc-section><xetodoc-slot><code>(val: Number?) => Number?</code></xetodoc-slot><p><p>Return absolute value of a number</p></p></xetodoc-section>
</xetodoc-main></body></html>`;

describe('xetodoc (4.0.6+) doc pages', () => {
  it('extracts the type and its slots', () => {
    const f = path.join(tmp, 'fan.sys', 'Str.html');
    touch(f, STR_HTML);
    const items = extractDocFile(f, 'sys', 5, '4.0.6');
    expect(items[0]).toMatchObject({ type: 'type', name: 'Str', qualifiedName: 'sys::Str', signature: 'const class Str : Obj' });
    expect(items[0].description).toContain('Unicode characters');
    const slots = items.filter(i => i.type === 'slot');
    expect(slots.map(s => s.qualifiedName)).toEqual(['sys::Str.compare', 'sys::Str.size']);
    expect(slots[0].description).toBe('Compare based on Unicode.');
  });

  it('turns Funcs mixin slots into Axon functions', () => {
    const f = path.join(tmp, 'axon', 'Funcs.html');
    touch(f, FUNCS_HTML);
    const funcs = extractDocFile(f, 'axon', 5, '4.0.6').filter(i => i.type === 'function');
    expect(funcs).toHaveLength(1);
    expect(funcs[0]).toMatchObject({ name: 'abs', qualifiedName: 'func:abs', language: 'axon', signature: 'abs(val: Number?)' });
  });
});

describe('UserStore auth cache', () => {
  it('verifies once, rejects wrong passwords, and writes users.json at most once a minute', () => {
    const store = new UserStore(tmp);
    const file = path.join(tmp, 'users.json');
    expect(store.authenticate('admin', 'admin')).not.toBeNull();
    const m1 = fs.statSync(file).mtimeMs;
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) expect(store.authenticate('admin', 'admin')).not.toBeNull();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(fs.statSync(file).mtimeMs).toBe(m1);
    expect(store.authenticate('admin', 'wrong')).toBeNull();
    expect(store.authenticate('nobody', 'admin')).toBeNull();
  });
});

describe('doc.zip instances (SkySpark 3.1.8)', () => {
  it('unpacks doc.zip once into the cache, skipping __MACOSX', () => {
    const inst = path.join(tmp, 'sky318');
    fs.mkdirSync(inst, { recursive: true });
    const zip = new AdmZip();
    zip.addFile('doc/docSkySpark/Tuning.html', Buffer.from('<h1>Tuning</h1>'));
    zip.addFile('__MACOSX/doc/._docSkySpark', Buffer.from('x'));
    zip.writeZip(path.join(inst, 'doc.zip'));
    process.env.FANTOM_DOC_ZIP_DIR = path.join(tmp, 'zips');
    try {
      const p = getDocPath(inst, 'skyspark');
      expect(p).not.toBeNull();
      expect(fs.existsSync(path.join(p!, 'docSkySpark', 'Tuning.html'))).toBe(true);
      expect(fs.existsSync(path.join(tmp, 'zips', path.basename(path.dirname(p!)), '__MACOSX'))).toBe(false);
      expect(getDocPath(inst, 'skyspark')).toBe(p);
    } finally {
      delete process.env.FANTOM_DOC_ZIP_DIR;
    }
  });
});

describe('instance source pods → pods table', () => {
  it('finds flat and nested (Haxall) pods and creates only missing rows', async () => {
    const { discoverSourcePods, syncInstanceSourcePods } = await import('../fantom/sourcePods.js');
    const src = path.join(tmp, 'haxall', 'src');
    touch(path.join(src, 'build.fan'));
    touch(path.join(src, 'conn', 'build.fan'));
    touch(path.join(src, 'conn', 'hxEcobee', 'fan', 'A.fan'));
    touch(path.join(src, 'core', 'haystack', 'fan', 'B.fan'));
    touch(path.join(src, 'flatPod', 'fan', 'C.fan'));
    expect(discoverSourcePods(src).map(p => p.name)).toEqual(['flatPod', 'haystack', 'hxEcobee']);

    const made: Array<{ name: string; path: string; defaultInstanceId?: number }> = [];
    const created = await syncInstanceSourcePods({
      listInstances: async () => [{ id: 6, name: 'Haxall 4.0.6', version: '4.0.6', sourcePath: src }, { id: 5, name: 'SkySpark', sourcePath: null }],
      listPodPaths: async () => [path.join(src, 'flatPod')],
      createPod: async (i) => { made.push(i); return i; },
    });
    expect(created).toHaveLength(2);
    expect(made.map(m => [m.name, m.defaultInstanceId])).toEqual([['haystack', 6], ['hxEcobee', 6]]);
  });
});
