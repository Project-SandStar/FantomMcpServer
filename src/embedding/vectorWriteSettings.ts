/**
 * Settings for the vector write buffer (ORDW-05).
 *
 *   semanticSearch.openRouter.maxPendingRows  rows a table may hold in its
 *                                             buffer before producers wait
 *   semanticSearch.openRouter.writeBatchRows  rows the single writer commits
 *                                             per delete + add
 *
 * Read from the runtime config file through the crash-safe reader, with a
 * short cache so a change applies to the next commit without a restart.
 * Every value is clamped; a missing, non-numeric or NaN value gives the
 * default. The write concurrency per table is fixed at 1 (LanceDB has no
 * commit-conflict handling) and is reported, never read from config.
 */

import path from 'path';
import { readConfigFileWithRecovery } from '../config/index.js';

export interface SettingRange { min: number; max: number; def: number }

export const VECTOR_WRITE_LIMITS = {
  maxPendingRows: { min: 100, max: 20000, def: 2000 },
  writeBatchRows: { min: 100, max: 5000, def: 1000 },
} as const satisfies Record<string, SettingRange>;

/** One writer per table. Shown in stats; not a setting. */
export const VECTOR_WRITE_CONCURRENCY = 1;

export interface VectorWriteSettings {
  maxPendingRows: number;
  writeBatchRows: number;
}

/** Clamp `v` into `r`; anything that is not a finite number gives the default. */
export function clampSetting(v: unknown, r: SettingRange): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return r.def;
  return Math.min(r.max, Math.max(r.min, Math.round(v)));
}

/** Clamp a raw `semanticSearch.openRouter` object (or anything else). */
export function sanitizeVectorWriteSettings(raw: unknown): VectorWriteSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    maxPendingRows: clampSetting(o.maxPendingRows, VECTOR_WRITE_LIMITS.maxPendingRows),
    writeBatchRows: clampSetting(o.writeBatchRows, VECTOR_WRITE_LIMITS.writeBatchRows),
  };
}

const CACHE_MS = 1000;
let cached: { at: number; value: VectorWriteSettings } | null = null;
let override: VectorWriteSettings | null = null;

function configPath(): string {
  return path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');
}

/** Current settings. Re-read from disk at most once a second. */
export function getVectorWriteSettings(): VectorWriteSettings {
  if (override) return override;
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  let raw: unknown;
  try {
    raw = readConfigFileWithRecovery(configPath())?.semanticSearch?.openRouter;
  } catch {
    raw = undefined;
  }
  const value = sanitizeVectorWriteSettings(raw);
  cached = { at: now, value };
  return value;
}

/** Test seam: pin settings (clamped), or pass null to read config again. */
export function __setVectorWriteSettingsForTest(s: Partial<VectorWriteSettings> | null): void {
  override = s ? sanitizeVectorWriteSettings(s) : null;
  cached = null;
}
