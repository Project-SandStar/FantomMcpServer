/**
 * Graph database summary for the dashboard Storage tab: engine + version,
 * data path, number of per-project stores, size on disk, quarantined files,
 * and the legacy shared store. Pool state (open / cap) is added by the route.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getCachePath, getInstallRoot } from '../utils/installRoot.js';

export interface GraphDirSummary {
  path: string;
  /** `<projectId>.db` files: one per project store. */
  storeCount: number;
  /** All live store files (.db + .wal + .shadow + ...), corrupt files excluded. */
  totalBytes: number;
  walCount: number;
  /** `*.corrupt-*` quarantined stores, kept until deleted by hand. */
  corruptCount: number;
  corruptBytes: number;
  lastModified: string | null;
}

function sizeOf(p: string): { bytes: number; mtime: number } {
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return { bytes: st.size, mtime: st.mtimeMs };
    if (st.isDirectory()) {
      let bytes = 0; let mtime = st.mtimeMs;
      for (const e of fs.readdirSync(p)) {
        const s = sizeOf(path.join(p, e));
        bytes += s.bytes; mtime = Math.max(mtime, s.mtime);
      }
      return { bytes, mtime };
    }
  } catch { /* vanished or unreadable */ }
  return { bytes: 0, mtime: 0 };
}

/** Scan one directory of per-project stores. Pure apart from reading `dir`. */
export function summarizeGraphDir(dir: string): GraphDirSummary {
  const out: GraphDirSummary = { path: dir, storeCount: 0, totalBytes: 0, walCount: 0, corruptCount: 0, corruptBytes: 0, lastModified: null };
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  let newest = 0;
  for (const name of names) {
    const s = sizeOf(path.join(dir, name));
    if (/\.corrupt/.test(name)) { out.corruptCount++; out.corruptBytes += s.bytes; continue; }
    if (/^\d+\.db$/.test(name)) out.storeCount++;
    if (/^\d+\.db\.wal$/.test(name)) out.walCount++;
    out.totalBytes += s.bytes;
    newest = Math.max(newest, s.mtime);
  }
  if (newest > 0) out.lastModified = new Date(newest).toISOString();
  return out;
}

/** Installed @ladybugdb/core version, or null. */
export function ladybugVersion(root = getInstallRoot()): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', '@ladybugdb', 'core', 'package.json'), 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch { return null; }
}

export interface GraphStorageInfo {
  engine: string;
  package: string;
  version: string | null;
  stores: GraphDirSummary;
  /** Legacy shared store (.cache/fantom-graph.db), null when absent. */
  shared: { path: string; bytes: number } | null;
}

export function getGraphStorageInfo(): GraphStorageInfo {
  const sharedPath = getCachePath('fantom-graph.db');
  let shared: GraphStorageInfo['shared'] = null;
  if (fs.existsSync(sharedPath)) {
    const wal = fs.existsSync(`${sharedPath}.wal`) ? sizeOf(`${sharedPath}.wal`).bytes : 0;
    shared = { path: sharedPath, bytes: sizeOf(sharedPath).bytes + wal };
  }
  return {
    engine: 'LadybugDB (Kuzu fork)',
    package: '@ladybugdb/core',
    version: ladybugVersion(),
    stores: summarizeGraphDir(getCachePath('graph')),
    shared,
  };
}
