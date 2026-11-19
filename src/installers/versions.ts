/**
 * Pure helpers for installer versions: compare dotted versions, read a
 * SkySpark version from an installer file name, and pick the Fantom release
 * that builds a Haxall release.
 */

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * `skyspark-4.0.7.zip` -> `4.0.7`. Only the canonical three-part name counts;
 * older names such as `SkySpark-305.zip` or `skyspark-3.04.zip` give null so
 * the caller can list them as unrecognized instead of guessing.
 */
export function parseSkysparkInstallerName(name: string): string | null {
  const m = /^skyspark-(\d+\.\d+\.\d+)\.zip$/i.exec(name.trim());
  return m ? m[1] : null;
}

export interface ReleaseInfo {
  version: string;
  publishedAt: string;
  body?: string;
}

/**
 * Fantom release for a Haxall release, in order:
 *   1. the settings table (`fantomVersions`),
 *   2. "Fantom build X.Y.Z" in the Haxall release notes (3.1.12 says so),
 *   3. the newest Fantom release published on or before the Haxall release
 *      (SkyFoundry publishes Fantom first, then Haxall the same day).
 * The Haxall Dockerfile ARG FAN_REL_VER is NOT used: for 4.0.7 it says
 * 1.0.82, but 4.0.7 needs 1.0.84.
 */
export function pickFantomVersion(
  haxall: ReleaseInfo,
  fantomReleases: ReleaseInfo[],
  table: Record<string, string> = {},
): { version: string | null; rule: 'table' | 'release-notes' | 'release-date' | 'none' } {
  if (table[haxall.version]) return { version: table[haxall.version], rule: 'table' };
  const m = /Fantom build (\d+\.\d+\.\d+)/i.exec(haxall.body ?? '');
  if (m) return { version: m[1], rule: 'release-notes' };
  const t = Date.parse(haxall.publishedAt);
  if (Number.isFinite(t)) {
    const before = fantomReleases
      .filter(f => Number.isFinite(Date.parse(f.publishedAt)) && Date.parse(f.publishedAt) <= t)
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
    if (before.length) return { version: before[0].version, rule: 'release-date' };
  }
  return { version: null, rule: 'none' };
}

/** `v4.0.7` -> `4.0.7`; null for anything that is not a plain release tag. */
export function tagToVersion(tag: string): string | null {
  const m = /^v?(\d+\.\d+\.\d+)$/.exec(tag.trim());
  return m ? m[1] : null;
}
