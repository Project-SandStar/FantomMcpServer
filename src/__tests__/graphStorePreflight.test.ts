/**
 * Graph store pre-flight: a per-project LadybugDB file without the LBUG magic
 * can never open. At boot such a file must be quarantined (renamed, not
 * deleted) and the project flagged for a forced rebuild, BEFORE any open is
 * attempted. Regression for project 367 (2026-09-20), whose store failed with
 * "Unable to open database. The file is not a valid Lbug database file!" on
 * every open and was never healed.
 */

import { jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

jest.setTimeout(30_000);

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fantom-preflight-'));
process.env.MCPFANTOM_CACHE_DIR = cacheDir;

const graphDir = path.join(cacheDir, 'graph');
fs.mkdirSync(graphDir, { recursive: true });

const mod = await import('../graph/projectGraphConnection.js');
const { preflightProjectGraphStore, preflightAllProjectGraphStores, projectNeedsGraphRebuild, clearProjectGraphRebuildFlag } = mod;

function write(id: number, content: Buffer | string, suffix = ''): string {
  const p = path.join(graphDir, `${id}.db${suffix}`);
  fs.writeFileSync(p, content);
  return p;
}

afterAll(() => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

describe('preflightProjectGraphStore', () => {
  test('missing file is fine (first index creates it)', () => {
    const r = preflightProjectGraphStore(9001);
    expect(r).toEqual({ ok: true, exists: false });
    expect(projectNeedsGraphRebuild(9001)).toBe(false);
  });

  test('valid LBUG header passes and is left untouched', () => {
    const p = write(9002, Buffer.concat([Buffer.from('LBUG'), Buffer.alloc(64)]));
    const r = preflightProjectGraphStore(9002);
    expect(r).toEqual({ ok: true, exists: true });
    expect(fs.existsSync(p)).toBe(true);
    expect(projectNeedsGraphRebuild(9002)).toBe(false);
  });

  test('file without the magic is quarantined, sidecars removed, project flagged', () => {
    // The real project-367 header: little-endian ints, no magic.
    const p = write(9003, Buffer.from('0500000000000000010000008e030000', 'hex'));
    write(9003, 'x', '.wal');
    write(9003, '', '.wal.checkpoint');
    const r = preflightProjectGraphStore(9003);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/bad header/);
    expect(r.quarantinedTo).toMatch(/9003\.db\.corrupt-/);
    expect(fs.existsSync(p)).toBe(false);
    expect(fs.existsSync(r.quarantinedTo!)).toBe(true);
    expect(fs.existsSync(`${p}.wal`)).toBe(false);
    expect(fs.existsSync(`${p}.wal.checkpoint`)).toBe(false);
    expect(projectNeedsGraphRebuild(9003)).toBe(true);
    clearProjectGraphRebuildFlag(9003);
    // Second pass: nothing left to quarantine.
    expect(preflightProjectGraphStore(9003)).toEqual({ ok: true, exists: false });
  });

  test('zero-byte file is quarantined', () => {
    write(9004, '');
    const r = preflightProjectGraphStore(9004);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/0 bytes/);
    expect(projectNeedsGraphRebuild(9004)).toBe(true);
    clearProjectGraphRebuildFlag(9004);
  });
});

describe('preflightAllProjectGraphStores', () => {
  test('scans every <id>.db and reports what it quarantined', () => {
    write(9005, Buffer.concat([Buffer.from('LBUG'), Buffer.alloc(16)]));
    write(9006, 'not a database');
    fs.writeFileSync(path.join(graphDir, 'notes.txt'), 'ignored');
    const r = preflightAllProjectGraphStores();
    expect(r.checked).toBeGreaterThanOrEqual(2);
    expect(r.quarantined.map(q => q.projectId)).toEqual([9006]);
    expect(projectNeedsGraphRebuild(9006)).toBe(true);
    expect(projectNeedsGraphRebuild(9005)).toBe(false);
    clearProjectGraphRebuildFlag(9006);
  });
});
