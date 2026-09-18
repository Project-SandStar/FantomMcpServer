/**
 * LogSink — single point of file-output control for both the async
 * Logger pipeline (info/warn/error/debug) and the synchronous crash
 * forensics path (Jetsam SIGKILL survival).
 *
 * Design rules:
 *
 * 1. **No /tmp/.** All files live under `<repo>/logs/`.
 * 2. **Master toggle gates everything.** When `settings.debug.enabled === false`
 *    both `write()` and `crashWrite()` are no-ops — no streams opened, no
 *    fds consumed, no files created.
 * 3. **Hot-reloaded.** Settings are re-read from
 *    `config/fantomMcpServer-config.json` on a 1-second cache so dashboard
 *    saves apply without a restart.
 * 4. **SIGKILL durability.** `crashWrite()` uses `appendFileSync` so the
 *    last lines hit disk before macOS Jetsam drops the process. This is
 *    the property that let us diagnose silent kills.
 * 5. **Per-segment routing.** When `segments` is populated, only listed
 *    tags emit files (`logs/<tag>.log`). When empty/unset, everything
 *    funnels into `logs/all.log`.
 * 6. **Size cap with rotation.** Files larger than `maxFileMb` are rotated
 *    to `<file>.1` (overwriting any prior `.1`); a fresh file takes over.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

interface DebugSettings {
  enabled?: boolean;
  segments?: Record<string, boolean>;
  levelMin?: LogLevel;
  captureCrash?: boolean;
  maxFileMb?: number;
}

const LOGS_DIR = path.join(process.cwd(), 'logs');
const CRASH_FILE = path.join(LOGS_DIR, '_crash.log');
const ALL_FILE = path.join(LOGS_DIR, 'all.log');
const CONFIG_PATH = path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');

const SETTINGS_TTL_MS = 1000;
let cachedSettings: DebugSettings = {};
let cachedAt = 0;

function readDebugSettings(): DebugSettings {
  const now = Date.now();
  if (now - cachedAt < SETTINGS_TTL_MS) return cachedSettings;
  cachedAt = now;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      cachedSettings = (cfg?.debug as DebugSettings) ?? {};
      return cachedSettings;
    }
  } catch {
    /* swallow — bad config shouldn't break the app */
  }
  cachedSettings = {};
  return cachedSettings;
}

/** Force the settings cache to refresh on the next read. Wired into
 *  updateSettings() so dashboard saves apply within the same second. */
export function invalidateLogSinkCache(): void {
  cachedAt = 0;
}

/** Tags the running server has emitted at least once. Surfaces via
 *  `/admin/debug/segments` so the dashboard can render a checkbox per tag
 *  without hardcoding the 41 known tags. */
const seenSegments = new Set<string>();
export function listSeenSegments(): string[] {
  return [...seenSegments].sort();
}

let logsDirEnsured = false;
function ensureLogsDir(): void {
  if (logsDirEnsured) return;
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    logsDirEnsured = true;
  } catch {
    /* operator may have made it read-only; let the write throw */
  }
}

const streams = new Map<string, fs.WriteStream>();
function streamFor(filePath: string): fs.WriteStream | null {
  let s = streams.get(filePath);
  if (s && !s.destroyed) return s;
  try {
    ensureLogsDir();
    s = fs.createWriteStream(filePath, { flags: 'a' });
    s.on('error', () => streams.delete(filePath));
    streams.set(filePath, s);
    return s;
  } catch {
    return null;
  }
}

function rotateIfOversize(filePath: string, maxBytes: number): void {
  if (maxBytes <= 0) return;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < maxBytes) return;
    const rotated = `${filePath}.1`;
    // Drop any in-flight stream first so the new file isn't written to
    // an inode that just got renamed away.
    const s = streams.get(filePath);
    if (s) {
      s.end();
      streams.delete(filePath);
    }
    try { fs.unlinkSync(rotated); } catch { /* ok if missing */ }
    fs.renameSync(filePath, rotated);
  } catch {
    /* file may not exist yet */
  }
}

/** Async path: writes from `Logger.{info,warn,error,debug}`. Returns
 *  immediately when debug is off or the segment is gated out. */
export function write(tag: string, level: LogLevel, line: string): void {
  seenSegments.add(tag);
  const s = readDebugSettings();
  if (!s.enabled) return;
  const minLevel = LEVEL_ORDER[s.levelMin ?? 'info'];
  if (LEVEL_ORDER[level] < minLevel) return;

  // Per-segment gating: when `segments` is populated, only enabled tags
  // produce per-segment files. When unset/empty, everything goes to
  // `logs/all.log` so the operator gets one combined view.
  const segments = s.segments;
  let target: string;
  if (segments && Object.keys(segments).length > 0) {
    if (!segments[tag]) return;
    target = path.join(LOGS_DIR, `${tag}.log`);
  } else {
    target = ALL_FILE;
  }

  const maxBytes = (s.maxFileMb ?? 100) * 1024 * 1024;
  rotateIfOversize(target, maxBytes);

  const stream = streamFor(target);
  if (!stream) return;
  const ts = new Date().toISOString();
  stream.write(`${ts} [${level.toUpperCase()}:${tag}] ${line}\n`);
}

/** Sync path: SIGKILL-survivable forensics. Used by every former
 *  `crashLog`/`reCrash`/`vsCrash`/`ssCrash`/`semCrash`/`sidecarLogger` site.
 *  Writes to a single combined file so cross-segment ordering is preserved
 *  in the crash trail. */
export function crashWrite(tag: string, line: string): void {
  seenSegments.add(tag);
  const s = readDebugSettings();
  if (!s.enabled) return;
  if (s.captureCrash === false) return;

  const maxBytes = (s.maxFileMb ?? 100) * 1024 * 1024;
  rotateIfOversize(CRASH_FILE, maxBytes);
  ensureLogsDir();
  try {
    fs.appendFileSync(
      CRASH_FILE,
      `${new Date().toISOString()} pid=${process.pid} ${tag} ${line}\n`,
    );
  } catch {
    /* never block the app on a log write */
  }
}

/** Resolve current log file paths so the admin /debug/log routes can read
 *  them. Returns absolute paths. */
export function logFilePaths(): { crash: string; all: string; segment: (tag: string) => string; logsDir: string } {
  return {
    crash: CRASH_FILE,
    all: ALL_FILE,
    segment: (tag: string) => path.join(LOGS_DIR, `${tag}.log`),
    logsDir: LOGS_DIR,
  };
}
