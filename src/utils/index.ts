import { isDebugEnabled } from "../config/index.js";
import { write as logSinkWrite } from "./logSink.js";

// Best-effort string formatter — keeps Logger.info(...args) shape working
// when args are mixed types (numbers, errors, objects). Mirrors what
// console.error would print, minus styling. Errors get their stack so
// log files contain the stack trace instead of "[object Object]".
function formatArgs(args: unknown[]): string {
  return args.map((a) => {
    if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}

// Re-export version comparison utilities
export {
  compareVersions,
  isVersionInRange,
  isVersionInList,
  isPodCompatible,
  parseVersion,
  formatVersionRange,
  isValidVersion,
  normalizeVersion,
  getLatestVersion,
  sortVersions,
  type VersionComponents,
  type PodCompatibility,
} from "./versionCompare.js";

// Note: versionResolver.ts is NOT exported here to avoid circular dependency.
// Import directly from './utils/versionResolver.js' when needed.

/**
 * Logger utility with debug mode support
 */
export class Logger {
  private prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  debug(...args: any[]): void {
    if (isDebugEnabled()) {
      // stderr: stdout is reserved for MCP JSON-RPC in stdio transport mode
      console.error(`[DEBUG:${this.prefix}]`, ...args);
    }
    // logSink decides whether to persist based on settings.debug; when
    // debug.enabled is false this is a no-op even when isDebugEnabled()
    // (config-side flag) is true.
    logSinkWrite(this.prefix, 'debug', formatArgs(args));
  }

  info(...args: any[]): void {
    // stderr: stdout is reserved for MCP JSON-RPC in stdio transport mode
    console.error(`[INFO:${this.prefix}]`, ...args);
    logSinkWrite(this.prefix, 'info', formatArgs(args));
  }

  warn(...args: any[]): void {
    console.warn(`[WARN:${this.prefix}]`, ...args);
    logSinkWrite(this.prefix, 'warn', formatArgs(args));
  }

  error(...args: any[]): void {
    console.error(`[ERROR:${this.prefix}]`, ...args);
    logSinkWrite(this.prefix, 'error', formatArgs(args));
  }
}

/**
 * Create a logger instance
 */
export function createLogger(prefix: string): Logger {
  return new Logger(prefix);
}

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Sanitize a string for use as a filename or ID
 */
export function sanitizeId(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Extract qualified name from Fantom type reference
 * e.g., "sys::Str" -> { pod: "sys", name: "Str" }
 */
export function parseQualifiedName(qualifiedName: string): {
  pod?: string;
  name: string;
} {
  const parts = qualifiedName.split("::");
  if (parts.length === 2) {
    return { pod: parts[0], name: parts[1] };
  }
  return { name: qualifiedName };
}

/**
 * Truncate text to a maximum length
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength - 3) + "...";
}

/**
 * Extract text content from HTML
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Generate a unique ID from components
 */
export function generateId(...components: string[]): string {
  return components.filter(Boolean).map(sanitizeId).join("-");
}

/**
 * Check if a string is a valid URL
 */
export function isUrl(str: string): boolean {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize URL by removing trailing slashes and fragments
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    let normalized = parsed.toString();
    if (normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch {
    return url;
  }
}

export class NumberUtils {
  static isCodePointSpace(n: number) {
    if (n === 0) {
      return false;
    }
    return (
      n === " ".codePointAt(0) ||
      n === "\n".codePointAt(0) ||
      n === "\t".codePointAt(0) ||
      n === "\r".codePointAt(0) ||
      n === "\f".codePointAt(0)
    );
  }

  static isCodePointAlpha(n?: number): boolean {
    if (!n) {
      return false;
    }
    if (!Number.isFinite(n)) return false;
    try {
      const ch = String.fromCodePoint(n);
      return /\p{L}/u.test(ch); // Unicode letter property
    } catch {
      return false;
    }
  }

  static isCodePointDigit(n?: number): boolean {
    if (!n) return false;
    if (!Number.isFinite(n)) return false;
    try {
      const ch = String.fromCodePoint(n);
      return /\p{Nd}/u.test(ch); // Unicode decimal digit property
    } catch {
      return false;
    }
  }

  static isCodePointAlphaNumeric(n?: number): boolean {
    return this.isCodePointAlpha(n) || this.isCodePointDigit(n);
  }
}

export class StringUtils {
  static isUpper(s: string | null): boolean {
    if (!s) return false;
    return s === s.toUpperCase();
  }

  static isLower(s: string | null): boolean {
    if (!s) return false;
    return s === s.toLowerCase();
  }
}
