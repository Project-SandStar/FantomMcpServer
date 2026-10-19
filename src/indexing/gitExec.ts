/**
 * Read-only git calls for lazy indexing (lazy-incremental-indexing.md 3.2.2).
 *
 * execFile, no shell, maxBuffer 64 MB. Retried on `index.lock` contention
 * with the user's own git. A small semaphore keeps at most
 * `git.concurrency` calls in flight across roots; callers serialise per root.
 */

import { execFile } from 'child_process';

export interface GitExecOptions {
  retries?: number;
  retryMs?: number;
  timeoutMs?: number;
  /** Exit codes that are answers, not failures (e.g. 1 for merge-base --is-ancestor). */
  okCodes?: number[];
}

export interface GitResult { stdout: string; code: number }

export class GitError extends Error {
  constructor(message: string, readonly code: number | null, readonly stderr: string) {
    super(message);
    this.name = 'GitError';
  }
}

let limit = 2;
let active = 0;
const waiters: Array<() => void> = [];

export function setGitConcurrency(n: number): void { limit = Math.max(1, n); }

async function acquire(): Promise<void> {
  if (active < limit) { active++; return; }
  await new Promise<void>(r => waiters.push(r));
  active++;
}

function release(): void {
  active--;
  const w = waiters.shift();
  if (w) w();
}

function runOnce(cwd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise(resolve => {
    execFile('git', ['-C', cwd, ...args], {
      maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, encoding: 'utf8',
      // No pager, no prompts, no locale-dependent messages.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : -1) : 0;
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code });
    });
  });
}

/** Run `git -C <cwd> <args>`; throws GitError on a non-ok exit after retries. */
export async function git(cwd: string, args: string[], opts: GitExecOptions = {}): Promise<GitResult> {
  const retries = opts.retries ?? 5;
  const retryMs = opts.retryMs ?? 2_000;
  const ok = new Set([0, ...(opts.okCodes ?? [])]);
  await acquire();
  try {
    for (let attempt = 0; ; attempt++) {
      const r = await runOnce(cwd, args, opts.timeoutMs ?? 60_000);
      if (ok.has(r.code)) return { stdout: r.stdout, code: r.code };
      const locked = /index\.lock|\.lock': File exists|Unable to create .*\.lock/i.test(r.stderr);
      if (locked && attempt < retries) {
        await new Promise(res => setTimeout(res, retryMs));
        continue;
      }
      throw new GitError(`git ${args[0]} failed (${r.code}): ${r.stderr.trim().slice(0, 500)}`, r.code, r.stderr);
    }
  } finally {
    release();
  }
}

let gitAvailable: boolean | null = null;

/** Probed once per process (3.2.5): no git binary → every project is scan mode. */
export async function isGitAvailable(): Promise<boolean> {
  if (gitAvailable !== null) return gitAvailable;
  const r = await runOnce(process.cwd(), ['--version'], 5_000).catch(() => ({ code: -1 }));
  gitAvailable = r.code === 0;
  return gitAvailable;
}
