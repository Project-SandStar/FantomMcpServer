/**
 * Worker pool settings, under `semanticSearch.openRouter` in the config file.
 * Read through `readConfigFileWithRecovery`, cached 2 s, so a change on the
 * OpenRouter page applies to the next job without a restart.
 */
import path from 'path';
import { readConfigFileWithRecovery } from '../config/index.js';
import { clampSetting, type SettingRange } from '../embedding/vectorWriteSettings.js';

/** Max 8 until a measured run with the write buffer allows more (plan D4). */
export const POOL_LIMITS = {
  workerCount: { min: 1, max: 8, def: 6 },
  interactiveSlots: { min: 1, max: 8, def: 2 },
  requestTimeoutMs: { min: 5_000, max: 600_000, def: 120_000 },
} as const satisfies Record<string, SettingRange>;

export interface PoolSettings {
  workerCount: number;
  interactiveSlots: number;
  requestTimeoutMs: number;
}

export function sanitizePoolSettings(raw: unknown): PoolSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    workerCount: clampSetting(o.workerCount, POOL_LIMITS.workerCount),
    interactiveSlots: clampSetting(o.interactiveSlots, POOL_LIMITS.interactiveSlots),
    requestTimeoutMs: clampSetting(o.requestTimeoutMs, POOL_LIMITS.requestTimeoutMs),
  };
}

/** Range problems in a user-supplied value, as plain messages (empty = ok). */
export function validatePoolInput(raw: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, r] of Object.entries(POOL_LIMITS) as Array<[keyof PoolSettings, SettingRange]>) {
    if (raw[k] === undefined || raw[k] === null || raw[k] === '') continue;
    const n = Number(raw[k]);
    if (!Number.isInteger(n) || n < r.min || n > r.max) out.push(`${k} must be a whole number from ${r.min} to ${r.max}`);
  }
  return out;
}

const CACHE_MS = 2_000;
let cached: { at: number; value: PoolSettings } | null = null;
let override: PoolSettings | null = null;

export function configPath(): string {
  return path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');
}

export function getPoolSettings(): PoolSettings {
  if (override) return override;
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  let raw: unknown;
  try { raw = (readConfigFileWithRecovery(configPath()) as any)?.semanticSearch?.openRouter; } catch { raw = undefined; }
  const value = sanitizePoolSettings(raw);
  cached = { at: now, value };
  return value;
}

export function invalidatePoolSettings(): void { cached = null; }
export function __setPoolSettingsForTest(s: Partial<PoolSettings> | null): void {
  override = s ? { ...sanitizePoolSettings({}), ...s } : null;
  cached = null;
}
