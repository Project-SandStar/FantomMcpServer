/**
 * Installer jobs: one at a time, run in the background, with a live log the
 * dashboard polls (GET /admin/installers/jobs/:id?since=<line>).
 *
 * A job is a list of steps; each step may run child processes through
 * `run()`, which streams stdout/stderr into the job log line by line.
 */

import { spawn } from 'node:child_process';

export type InstallerJobKind = 'haxall-install' | 'haxall-compile' | 'skyspark-install' | 'auto-check';
export type InstallerJobStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface InstallerJob {
  id: string;
  kind: InstallerJobKind;
  label: string;
  status: InstallerJobStatus;
  step: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** Messages the operator must read (e.g. "docs fell back to compilerDoc"). */
  notes: string[];
  result?: Record<string, unknown>;
  /** Line number of log[0] (old lines are dropped past MAX_LINES). */
  logOffset: number;
  log: string[];
}

const MAX_LINES = 5000;
const MAX_JOBS = 20;
const jobs = new Map<string, InstallerJob>();
let activeId: string | null = null;
const children = new Map<string, Set<ReturnType<typeof spawn>>>();

export class JobCancelled extends Error {}

export interface JobContext {
  job: InstallerJob;
  log(line: string): void;
  step(name: string): void;
  note(msg: string): void;
  run(cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: (line: string, write: (s: string) => void) => void }): Promise<void>;
  checkCancelled(): void;
}

function pushLine(job: InstallerJob, line: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  job.log.push(`${ts} ${line}`);
  if (job.log.length > MAX_LINES) {
    const drop = job.log.length - MAX_LINES;
    job.log.splice(0, drop);
    job.logOffset += drop;
  }
}

export function getActiveInstallerJob(): InstallerJob | null {
  return activeId ? jobs.get(activeId) ?? null : null;
}

export function getInstallerJob(id: string): InstallerJob | null {
  return jobs.get(id) ?? null;
}

export function listInstallerJobs(): Omit<InstallerJob, 'log'>[] {
  return [...jobs.values()].reverse().map(({ log: _log, ...rest }) => rest);
}

/** Log lines from line number `since` on (line numbers survive trimming). */
export function jobLogSince(job: InstallerJob, since: number): { lines: string[]; next: number } {
  const start = Math.max(0, since - job.logOffset);
  return { lines: job.log.slice(start), next: job.logOffset + job.log.length };
}

export function cancelInstallerJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return false;
  job.status = 'cancelled';
  pushLine(job, 'Cancel requested; stopping child processes.');
  for (const c of children.get(id) ?? []) { try { c.kill('SIGTERM'); } catch { /* gone */ } }
  return true;
}

export class InstallerBusyError extends Error {
  constructor(public active: InstallerJob) { super(`Another installer job is running: ${active.label}`); }
}

/**
 * Start a job. Throws InstallerBusyError when one is running. Returns at
 * once; `body` runs in the background.
 */
export function startInstallerJob(
  kind: InstallerJobKind,
  label: string,
  body: (ctx: JobContext) => Promise<Record<string, unknown> | void>,
): InstallerJob {
  const active = getActiveInstallerJob();
  if (active) throw new InstallerBusyError(active);
  const id = `inst-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job: InstallerJob = { id, kind, label, status: 'running', step: 'starting', startedAt: new Date().toISOString(), notes: [], logOffset: 0, log: [] };
  jobs.set(id, job);
  while (jobs.size > MAX_JOBS) {
    const oldest = [...jobs.keys()].find(k => k !== id && jobs.get(k)!.status !== 'running');
    if (!oldest) break;
    jobs.delete(oldest);
  }
  activeId = id;
  children.set(id, new Set());

  const checkCancelled = (): void => { if (job.status === 'cancelled') throw new JobCancelled('cancelled'); };
  const ctx: JobContext = {
    job,
    log: line => pushLine(job, line),
    step: name => { checkCancelled(); job.step = name; pushLine(job, `== ${name}`); },
    note: msg => { job.notes.push(msg); pushLine(job, `NOTE: ${msg}`); },
    checkCancelled,
    run: (cmd, args, opts = {}) => new Promise<void>((resolve, reject) => {
      checkCancelled();
      pushLine(job, `$ ${cmd} ${args.join(' ')}`);
      const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
      children.get(id)!.add(child);
      const write = (s: string): void => { try { child.stdin.write(s); } catch { /* closed */ } };
      if (!opts.input) child.stdin.end();
      const onData = (buf: { s: string }) => (chunk: Buffer): void => {
        buf.s += chunk.toString();
        // Prompts end without a newline: hand the partial line to `input`.
        const parts = buf.s.split(/\r?\n/);
        buf.s = parts.pop() ?? '';
        for (const p of parts) { if (p.trim()) pushLine(job, p); opts.input?.(p, write); }
        if (buf.s && opts.input) opts.input(buf.s, write);
      };
      const out = { s: '' }, err = { s: '' };
      child.stdout.on('data', onData(out));
      child.stderr.on('data', onData(err));
      child.on('error', e => { children.get(id)?.delete(child); reject(new Error(`${cmd}: ${e.message}`)); });
      child.on('close', code => {
        children.get(id)?.delete(child);
        for (const b of [out, err]) if (b.s.trim()) pushLine(job, b.s);
        if (job.status === 'cancelled') reject(new JobCancelled('cancelled'));
        else if (code === 0) resolve();
        else reject(new Error(`${cmd} ${args[0] ?? ''} exited with code ${code}`));
      });
    }),
  };

  void (async () => {
    try {
      const result = await body(ctx);
      if (job.status === 'running') job.status = 'succeeded';
      if (result) job.result = result;
      pushLine(job, `Job ${job.status}.`);
    } catch (e) {
      if (job.status !== 'cancelled') {
        job.status = 'failed';
        job.error = (e as Error).message;
        pushLine(job, `ERROR: ${job.error}`);
      } else {
        pushLine(job, 'Job cancelled.');
      }
    } finally {
      job.finishedAt = new Date().toISOString();
      children.delete(id);
      if (activeId === id) activeId = null;
    }
  })();
  return job;
}

/** Test seam. */
export function __resetInstallerJobsForTest(): void {
  jobs.clear();
  activeId = null;
  children.clear();
}
