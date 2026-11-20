/**
 * Build a code vector table's indexes in a CHILD process.
 *
 * ANN (IVF_PQ), FTS on `text`, and scalar indexes on project_id / node_id /
 * node_type. Training IVF_PQ on hundreds of thousands of 4096d rows needs GBs
 * of native memory; in this process that trips the 4 GB RSS guard and kills
 * the server. The child (scripts/build-vector-index.mjs) has its own heap and
 * is not counted by the guard.
 *
 * Used before every shadow promotion (so a table is never promoted without
 * its indexes) and by POST /admin/vectors/index. One build per table at a time.
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { getInstallRoot, getCachePath } from '../utils/installRoot.js';

export interface IndexBuildReport {
  table: string;
  rows: number;
  built: string[];
  skipped: string[];
  failed: string[];
  ms: number;
  exitCode: number | null;
  error?: string;
}

const running = new Map<string, Promise<IndexBuildReport>>();
let last: IndexBuildReport | null = null;

/** Child heap. The training sample is native memory, outside this limit. */
const CHILD_HEAP_MB = Number(process.env.FANTOM_INDEX_BUILD_HEAP_MB) || 8192;
/** Safety net only: a 440k-row IVF_PQ build took minutes, not hours. */
const DEFAULT_TIMEOUT_MS = Number(process.env.FANTOM_INDEX_BUILD_TIMEOUT_MS) || 3 * 60 * 60_000;

export function lastIndexBuild(): IndexBuildReport | null { return last; }
export function indexBuildRunning(): string[] { return [...running.keys()]; }

export function buildCodeTableIndexes(
  table: string,
  opts: { force?: boolean; timeoutMs?: number; log?: (m: string) => void } = {},
): Promise<IndexBuildReport> {
  const cur = running.get(table);
  if (cur) return cur;
  const log = opts.log ?? ((m: string) => console.log(m));
  const script = path.join(getInstallRoot(), 'scripts', 'build-vector-index.mjs');
  const p = new Promise<IndexBuildReport>((resolve) => {
    const fail = (error: string, exitCode: number | null = null): IndexBuildReport =>
      ({ table, rows: 0, built: [], skipped: [], failed: [error], ms: 0, exitCode, error });
    if (!fs.existsSync(script)) { resolve(fail(`script not found: ${script}`)); return; }
    const args = [`--max-old-space-size=${CHILD_HEAP_MB}`, script, '--table', table, '--json'];
    if (opts.force) args.push('--force');
    const child = spawn(process.execPath, args, {
      cwd: getInstallRoot(),
      env: { ...process.env, FANTOM_LANCE_DIR: getCachePath('fantomvector.db') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let lastJson = '';
    const onLine = (line: string) => {
      const t = line.trim();
      if (!t) return;
      if (t.startsWith('{') && t.includes('"table"')) { lastJson = t; return; }
      log(`[index-build] ${t}`);
    };
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.on('data', (d: Buffer) => { for (const l of d.toString().split('\n')) onLine(l); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.on('error', (err) => { clearTimeout(timer); resolve(fail(`spawn failed: ${err.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buf) onLine(buf);
      try {
        const r = JSON.parse(lastJson) as Omit<IndexBuildReport, 'exitCode'>;
        resolve({ ...r, exitCode: code });
      } catch {
        resolve(fail(`index build exited ${code} without a report`, code));
      }
    });
  }).then(async (r) => {
    last = r;
    running.delete(table);
    // This process opened the table before the child changed it: move the
    // cached handle to the new version so searches use the new indexes.
    try {
      const { refreshCodeTableHandle } = await import('./lanceConnection.js');
      await refreshCodeTableHandle();
    } catch { /* next open sees it anyway */ }
    return r;
  });
  running.set(table, p);
  return p;
}

/**
 * At boot: make sure the ACTIVE code table has current ANN, FTS and scalar
 * indexes, building what is missing or out of date in a child process. This is how a table promoted by an
 * older build, or created before indexes existed, gets them without anyone
 * having to remember. Delayed so it does not compete with boot hydration.
 */
export function scheduleActiveTableIndexCheck(delayMs = 3 * 60_000): void {
  const t = setTimeout(() => {
    void (async () => {
      try {
        const { getLanceTable, getActiveCodeTableName } = await import('./lanceConnection.js');
        const table = await getLanceTable();
        const rows = await table.countRows();
        if (rows < 5_000) return;
        // The child script is idempotent and cheap when every index is
        // current (vector = IVF_HNSW_SQ, FTS built with the current tokenizer
        // config, scalar indexes present), so always run it: it rebuilds only
        // what is missing or out of date.
        const name = getActiveCodeTableName();
        console.log(`[index-build] checking indexes on active table ${name} (${rows} rows) in a child process`);
        const r = await buildCodeTableIndexes(name);
        console.log(`[index-build] ${name}: built=[${r.built.join('; ')}] failed=[${r.failed.join('; ')}] in ${Math.round(r.ms / 1000)}s`);
      } catch (err) {
        console.warn(`[index-build] boot check failed: ${(err as Error).message}`);
      }
    })();
  }, delayMs);
  t.unref?.();
}
