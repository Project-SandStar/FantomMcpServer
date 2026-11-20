/**
 * The OpenRouter API key, as Fantom holds it.
 *
 * One place only: the secrets store (`<cache>/secrets/FANTOM_OPENROUTER_API_KEY`,
 * applied to `process.env` at boot, a stored key wins over the env file). It is
 * never written to the config file, never logged, never returned by a route.
 */
import { deleteStoredSecret, readStoredSecret, secretSource, storeSecret, type SecretSource } from '../config/secretsStore.js';

const NAME = 'FANTOM_OPENROUTER_API_KEY' as const;

/**
 * The key, or null. `process.env` already holds the stored secret (boot
 * applies it, `storeSecret` sets it), so this is a memory read per call; the
 * file is read only when env is empty.
 */
export function openRouterKey(): string | null {
  const env = (process.env[NAME] ?? '').trim();
  if (env) return env;
  let stored: string | null = null;
  try { stored = readStoredSecret(NAME); } catch { stored = null; }
  return stored?.trim() || null;
}

export function hasOpenRouterKey(): boolean {
  return openRouterKey() !== null;
}

export function openRouterKeySource(): SecretSource {
  return hasOpenRouterKey() ? secretSource(NAME) : null;
}

/** Last four characters for display ("••••abcd"), or undefined. */
export function keyLast4(): string | undefined {
  const k = openRouterKey();
  return k ? k.slice(-4) : undefined;
}

/** Save a key typed on the dashboard. Throws on a store failure. */
export function saveOpenRouterKey(key: string): void {
  storeSecret(NAME, key.trim());
}

/**
 * The sandbox key: a separate OpenRouter key with a low spending limit, used
 * only by ss-rlm-sandbox. The sandbox runs model-written code in the same
 * process that holds the key, so it must never get the main key. There is no
 * fallback to the main key.
 */
const SANDBOX_NAME = 'FANTOM_OPENROUTER_SANDBOX_KEY' as const;

export function sandboxKey(): string | null {
  const env = (process.env[SANDBOX_NAME] ?? '').trim();
  if (env) return env;
  let stored: string | null = null;
  try { stored = readStoredSecret(SANDBOX_NAME); } catch { stored = null; }
  return stored?.trim() || null;
}

export function hasSandboxKey(): boolean {
  return sandboxKey() !== null;
}

export function sandboxKeyLast4(): string | undefined {
  const k = sandboxKey();
  return k ? k.slice(-4) : undefined;
}

export function saveSandboxKey(key: string): void {
  storeSecret(SANDBOX_NAME, key.trim());
}

export function clearSandboxKey(): void {
  deleteStoredSecret(SANDBOX_NAME);
  delete process.env[SANDBOX_NAME];
}

/** Remove the key (and any key-shaped token) from a string before it is shown or logged. */
export function redactKey(text: string): string {
  let out = text;
  for (const k of [openRouterKey(), sandboxKey()]) if (k) out = out.split(k).join('[redacted]');
  out = out.replace(/sk-or-[A-Za-z0-9_-]{8,}/g, 'sk-or-[redacted]');
  return out;
}
