/**
 * API keys saved from the dashboard, kept on the server.
 *
 * One owner-only file per key in `<cache>/secrets/<ENV_NAME>`. The cache dir is
 * the persistent volume in Docker (`/app/.cache`), so a key saved on the
 * dashboard survives restarts and image rebuilds. The old place, `<root>/.env`,
 * lives inside the container in Docker and was lost on every rebuild, after
 * which the deployment env file's value came back silently.
 *
 * At boot `applyStoredSecretsToEnv()` copies each stored key into
 * `process.env`, OVER any value from the env file: a key saved on the
 * dashboard is the newest explicit choice. Code keeps reading `process.env`.
 *
 * Keys are never written to the config file, never logged, never returned.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getCacheDir } from '../utils/installRoot.js';

/** The only names this store accepts — the API keys the dashboard can set. */
export const SECRET_NAMES = [
  'FANTOM_OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'TYPESAFE_API_KEY',
  // Installer sources (src/installers/settings.ts): share password, GitHub token.
  'FANTOM_INSTALLER_SKYSPARK_PASSWORD',
  'FANTOM_INSTALLER_GITHUB_TOKEN',
] as const;
export type SecretName = typeof SECRET_NAMES[number];

export type SecretSource = 'stored' | 'env' | null;

/** Names whose current process.env value came from this store. */
const appliedFromStore = new Set<SecretName>();

function secretsDir(): string {
  return path.join(getCacheDir(), 'secrets');
}

function fileFor(name: SecretName): string {
  if (!(SECRET_NAMES as readonly string[]).includes(name)) throw new Error(`unknown secret name: ${name}`);
  return path.join(secretsDir(), name);
}

export function readStoredSecret(name: SecretName): string | null {
  try {
    const v = fs.readFileSync(fileFor(name), 'utf-8').trim();
    return v || null;
  } catch {
    return null;
  }
}

/**
 * Store a key (atomic: temp file + rename, mode 0600) and apply it to
 * process.env at once. Empty values are ignored. Throws if the write fails,
 * so the caller can tell the operator the key was NOT kept.
 */
export function storeSecret(name: SecretName, value: string): void {
  const v = value.trim();
  if (!v) return;
  const file = fileFor(name);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, v, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  process.env[name] = v;
  appliedFromStore.add(name);
}

/** Remove a stored key. process.env keeps its current value until restart. */
export function deleteStoredSecret(name: SecretName): boolean {
  appliedFromStore.delete(name);
  try {
    fs.rmSync(fileFor(name));
    return true;
  } catch {
    return false;
  }
}

/** Boot: copy every stored key into process.env (stored wins over the env file). */
export function applyStoredSecretsToEnv(): SecretName[] {
  const applied: SecretName[] = [];
  for (const name of SECRET_NAMES) {
    const v = readStoredSecret(name);
    if (!v) continue;
    process.env[name] = v;
    appliedFromStore.add(name);
    applied.push(name);
  }
  return applied;
}

/** Where the live value of a key comes from. */
export function secretSource(name: SecretName): SecretSource {
  if (!process.env[name]?.trim()) return null;
  return appliedFromStore.has(name) ? 'stored' : 'env';
}

/** Test seam. */
export function __resetSecretsStoreForTest(): void {
  appliedFromStore.clear();
}
