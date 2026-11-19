/**
 * Installer settings: where Haxall / SkySpark installers come from and where
 * builds and installs go. Stored in `config/fantomMcpServer-config.json` under
 * the key `installers`, always through `readConfigFileWithRecovery` /
 * `atomicWriteConfigFile` (that file has other writers).
 *
 * Secrets (share password, GitHub token) never go in this file. They live in
 * the secrets store (`src/config/secretsStore.ts`); the settings only say
 * whether one is set.
 *
 * No company location is a code default. The SkySpark source is empty until
 * an admin sets it on the dashboard.
 */

import * as path from 'node:path';
import { readConfigFileWithRecovery, atomicWriteConfigFile } from '../config/index.js';
import { getCacheDir } from '../utils/installRoot.js';
import { readStoredSecret, storeSecret, deleteStoredSecret, type SecretName } from '../config/secretsStore.js';

export type InstallerProviderType = 'nextcloud-share' | 'webdav' | 'local' | 'http' | 'google-drive';

export interface InstallerSource {
  provider: InstallerProviderType;
  /** Share URL, WebDAV URL, folder path, or HTTP index URL. */
  location: string;
  /** WebDAV / HTTP user. Not used for a Nextcloud public share (the token is the user). */
  username?: string;
}

export interface HaxallInstallerSettings {
  /** GitHub repo that publishes Haxall releases. */
  githubRepo: string;
  /** Source trees and built homes: <installRoot>/haxall-<ver>/home. */
  installRoot: string;
  /** Fantom releases: <fantomRoot>/fantom-<ver>. Missing ones are downloaded. */
  fantomRoot: string;
  /** Xeto clones, one per Haxall version: <xetoRoot>/<haxallVer>/xeto. */
  xetoRoot: string;
  xetoRepoUrl: string;
  /** haystack-defs checkout (its lib/fan pods are copied as they are). */
  haystackDefsDir: string;
  haystackDefsRepoUrl: string;
  /** Haxall version -> Fantom version. Wins over the release-date rule. */
  fantomVersions: Record<string, string>;
  /** Releases older than this are not offered. */
  minVersion: string;
}

export interface SkysparkInstallerSettings {
  source: InstallerSource | null;
  /** Zips are kept here after download. */
  downloadDir: string;
  /** Each version is unpacked to <installRoot>/skyspark-<ver>. */
  installRoot: string;
  minVersion: string;
  /**
   * SkySpark 3.x docgen needs `bin/setup`, which accepts the SkyFoundry EULA.
   * Off: 3.x docs come from compilerDoc instead.
   */
  acceptEula: boolean;
}

export interface InstallerSettings {
  /** JDK 17 home used for builds and docgen. Empty = JAVA_HOME. */
  jdkHome: string;
  /** Once a day: check both products and install the newest missing version. */
  autoCheckDaily: boolean;
  haxall: HaxallInstallerSettings;
  skyspark: SkysparkInstallerSettings;
}

/** What the API returns: settings plus which secrets are set (never their values). */
export interface InstallerSettingsView extends InstallerSettings {
  secrets: { skysparkSourcePassword: boolean; githubToken: boolean };
}

export const SKYSPARK_SECRET: SecretName = 'FANTOM_INSTALLER_SKYSPARK_PASSWORD';
export const GITHUB_SECRET: SecretName = 'FANTOM_INSTALLER_GITHUB_TOKEN';

const configPath = (): string => path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');

/** Default work root: env FANTOM_INSTALL_ROOT, else <cache>/installs (a volume in Docker). */
export function defaultWorkRoot(): string {
  return process.env.FANTOM_INSTALL_ROOT?.trim() || path.join(getCacheDir(), 'installs');
}

export function defaultInstallerSettings(): InstallerSettings {
  const root = defaultWorkRoot();
  return {
    jdkHome: process.env.JAVA_HOME?.trim() || '',
    autoCheckDaily: false,
    haxall: {
      githubRepo: 'haxall/haxall',
      installRoot: path.join(root, 'haxall'),
      fantomRoot: path.join(root, 'fantom'),
      xetoRoot: path.join(root, 'xeto'),
      xetoRepoUrl: 'https://github.com/Project-Haystack/xeto.git',
      haystackDefsDir: path.join(root, 'haystack-defs'),
      haystackDefsRepoUrl: 'https://github.com/Project-Haystack/haystack-defs.git',
      fantomVersions: { '4.0.6': '1.0.83', '4.0.7': '1.0.84' },
      minVersion: '4.0.6',
    },
    skyspark: {
      source: null,
      downloadDir: path.join(root, 'downloads', 'skyspark'),
      installRoot: path.join(root, 'skyspark'),
      minVersion: '3.1.0',
      acceptEula: false,
    },
  };
}

const PROVIDERS: InstallerProviderType[] = ['nextcloud-share', 'webdav', 'local', 'http', 'google-drive'];

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

function versionMap(v: unknown, fallback: Record<string, string>): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return fallback;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (/^\d+(\.\d+)*$/.test(k) && typeof val === 'string' && /^\d+(\.\d+)*$/.test(val.trim())) out[k] = val.trim();
  }
  return out;
}

function sanitizeSource(v: unknown): InstallerSource | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const provider = PROVIDERS.includes(o.provider as InstallerProviderType) ? (o.provider as InstallerProviderType) : null;
  const location = typeof o.location === 'string' ? o.location.trim() : '';
  if (!provider || !location) return null;
  const username = typeof o.username === 'string' && o.username.trim() ? o.username.trim() : undefined;
  return { provider, location, ...(username ? { username } : {}) };
}

/** Merge stored values onto defaults; unknown or bad values fall back. */
export function sanitizeInstallerSettings(raw: unknown): InstallerSettings {
  const d = defaultInstallerSettings();
  const r = (raw && typeof raw === 'object' ? raw : {}) as any;
  const h = r.haxall ?? {};
  const s = r.skyspark ?? {};
  return {
    jdkHome: typeof r.jdkHome === 'string' ? r.jdkHome.trim() : d.jdkHome,
    autoCheckDaily: typeof r.autoCheckDaily === 'boolean' ? r.autoCheckDaily : d.autoCheckDaily,
    haxall: {
      githubRepo: /^[\w.-]+\/[\w.-]+$/.test(String(h.githubRepo ?? '')) ? String(h.githubRepo) : d.haxall.githubRepo,
      installRoot: str(h.installRoot, d.haxall.installRoot),
      fantomRoot: str(h.fantomRoot, d.haxall.fantomRoot),
      xetoRoot: str(h.xetoRoot, d.haxall.xetoRoot),
      xetoRepoUrl: str(h.xetoRepoUrl, d.haxall.xetoRepoUrl),
      haystackDefsDir: str(h.haystackDefsDir, d.haxall.haystackDefsDir),
      haystackDefsRepoUrl: str(h.haystackDefsRepoUrl, d.haxall.haystackDefsRepoUrl),
      fantomVersions: versionMap(h.fantomVersions, d.haxall.fantomVersions),
      minVersion: str(h.minVersion, d.haxall.minVersion),
    },
    skyspark: {
      source: s.source === undefined ? d.skyspark.source : sanitizeSource(s.source),
      downloadDir: str(s.downloadDir, d.skyspark.downloadDir),
      installRoot: str(s.installRoot, d.skyspark.installRoot),
      minVersion: str(s.minVersion, d.skyspark.minVersion),
      acceptEula: typeof s.acceptEula === 'boolean' ? s.acceptEula : d.skyspark.acceptEula,
    },
  };
}

export function getInstallerSettings(): InstallerSettings {
  return sanitizeInstallerSettings(readConfigFileWithRecovery(configPath())?.installers);
}

export function getInstallerSettingsView(): InstallerSettingsView {
  return {
    ...getInstallerSettings(),
    secrets: {
      skysparkSourcePassword: !!readStoredSecret(SKYSPARK_SECRET),
      githubToken: !!readStoredSecret(GITHUB_SECRET),
    },
  };
}

/**
 * Save settings. `secrets.skysparkSourcePassword` / `secrets.githubToken`:
 * a non-empty string stores it, `null` removes it, absent keeps it.
 */
export function saveInstallerSettings(body: unknown): InstallerSettingsView {
  const b = (body && typeof body === 'object' ? body : {}) as any;
  const current = getInstallerSettings();
  const merged = sanitizeInstallerSettings({
    ...current,
    ...b,
    haxall: { ...current.haxall, ...(b.haxall ?? {}) },
    skyspark: { ...current.skyspark, ...(b.skyspark ?? {}) },
  });
  const cfg = readConfigFileWithRecovery(configPath());
  cfg.installers = merged;
  atomicWriteConfigFile(configPath(), cfg);

  const sec = b.secrets ?? {};
  for (const [key, name] of [['skysparkSourcePassword', SKYSPARK_SECRET], ['githubToken', GITHUB_SECRET]] as const) {
    if (sec[key] === null) deleteStoredSecret(name);
    else if (typeof sec[key] === 'string' && sec[key].trim()) storeSecret(name, sec[key]);
  }
  return getInstallerSettingsView();
}

export function readInstallerSecret(name: SecretName): string | null {
  return readStoredSecret(name) ?? (process.env[name]?.trim() || null);
}
