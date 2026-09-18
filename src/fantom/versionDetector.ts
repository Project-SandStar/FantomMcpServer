/**
 * Fantom Version Detection
 *
 * Detects Fantom versions used by SkySpark/Haxall instances and finds
 * corresponding Fantom source code installations.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { FantomVersion, DetectFantomVersionResult } from './types.js';

/**
 * Detect the Fantom version used by an instance
 *
 * Detection methods:
 * 1. Read home/etc/build/config.props (Haxall with home subdir) - buildVersion=1.0.XX
 * 2. Read etc/build/config.props (SkySpark) - buildVersion=1.0.XX
 * 3. Parse from directory name (fantom-X.X.XX)
 *
 * Note: For Haxall, the root etc/build/config.props contains the Haxall version (e.g., 4.0.4),
 * while home/etc/build/config.props contains the actual Fantom version (e.g., 1.0.82).
 * We check home/ first to get the correct Fantom version.
 */
export async function detectFantomVersion(instancePath: string): Promise<string | null> {
  // Method 1: Read home/etc/build/config.props (Haxall with home subdir)
  // This is where Haxall stores the Fantom buildVersion
  const homeConfigPath = path.join(instancePath, 'home', 'etc', 'build', 'config.props');
  const version = await readBuildVersionFromConfig(homeConfigPath);
  if (version && isFantomVersion(version)) {
    return version;
  }

  // Method 2: Read etc/build/config.props (SkySpark)
  const configPath = path.join(instancePath, 'etc', 'build', 'config.props');
  const rootVersion = await readBuildVersionFromConfig(configPath);
  if (rootVersion && isFantomVersion(rootVersion)) {
    return rootVersion;
  }

  // Method 3: Parse from directory name (fantom-X.X.XX)
  const dirName = path.basename(instancePath);
  const match = dirName.match(/fantom-(\d+\.\d+\.\d+)/);
  if (match) {
    return match[1];
  }

  return null;
}

/**
 * Read buildVersion from a config.props file
 */
async function readBuildVersionFromConfig(configPath: string): Promise<string | null> {
  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const content = await fs.promises.readFile(configPath, 'utf-8');
    // Look for buildVersion=X.X.XX pattern
    const match = content.match(/buildVersion=(\d+\.\d+\.\d+)/);
    if (match) {
      return match[1];
    }
  } catch (err) {
    console.warn(`[VersionDetector] Failed to read config.props at ${configPath}: ${err}`);
  }

  return null;
}

/**
 * Check if a version string looks like a Fantom version (1.0.XX)
 * Fantom versions are typically 1.0.XX (e.g., 1.0.80, 1.0.82)
 * This helps distinguish from app versions like Haxall 4.0.4
 */
function isFantomVersion(version: string): boolean {
  // Fantom versions start with 1.0.
  return version.startsWith('1.0.');
}

/**
 * Find the Fantom source path for a given version
 */
export async function findFantomSourcePath(
  version: string,
  sourceFolder: string
): Promise<{ path: string; hasSource: boolean } | null> {
  if (!sourceFolder || !fs.existsSync(sourceFolder)) {
    return null;
  }

  // Look for fantom-{version} folder
  const versionPath = path.join(sourceFolder, `fantom-${version}`);
  if (fs.existsSync(versionPath)) {
    const srcPath = path.join(versionPath, 'src');
    return {
      path: versionPath,
      hasSource: fs.existsSync(srcPath)
    };
  }

  return null;
}

/**
 * Get all available Fantom versions from a source folder
 *
 * Scans the folder for directories matching fantom-X.X.XX pattern
 */
export async function getAvailableFantomVersions(sourceFolder: string): Promise<FantomVersion[]> {
  if (!sourceFolder || !fs.existsSync(sourceFolder)) {
    return [];
  }

  const versions: FantomVersion[] = [];

  try {
    const entries = await fs.promises.readdir(sourceFolder, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // Check if directory matches fantom-X.X.XX pattern
      const match = entry.name.match(/^fantom-(\d+\.\d+\.\d+)$/);
      if (match) {
        const versionPath = path.join(sourceFolder, entry.name);
        const srcPath = path.join(versionPath, 'src');

        versions.push({
          version: match[1],
          path: versionPath,
          hasSource: fs.existsSync(srcPath)
        });
      }
    }

    // Sort by version (newest first)
    versions.sort((a, b) => compareVersions(b.version, a.version));
  } catch (err) {
    console.error(`[VersionDetector] Failed to scan source folder: ${err}`);
  }

  return versions;
}

/**
 * Detect Fantom version from instance and check if source is available
 */
export async function detectFantomVersionWithSource(
  instancePath: string,
  sourceFolder: string | null
): Promise<DetectFantomVersionResult> {
  const detectedVersion = await detectFantomVersion(instancePath);

  if (!detectedVersion) {
    return {
      detectedVersion: null,
      sourceAvailable: false,
      sourcePath: null
    };
  }

  if (!sourceFolder) {
    return {
      detectedVersion,
      sourceAvailable: false,
      sourcePath: null
    };
  }

  const sourceInfo = await findFantomSourcePath(detectedVersion, sourceFolder);

  return {
    detectedVersion,
    sourceAvailable: sourceInfo?.hasSource || false,
    sourcePath: sourceInfo?.path || null
  };
}

/**
 * Compare two semver-like version strings
 * Returns: -1 if v1 < v2, 0 if v1 == v2, 1 if v1 > v2
 */
function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split('.').map(p => parseInt(p, 10) || 0);
  const parts2 = v2.split('.').map(p => parseInt(p, 10) || 0);

  const maxLength = Math.max(parts1.length, parts2.length);

  for (let i = 0; i < maxLength; i++) {
    const num1 = parts1[i] || 0;
    const num2 = parts2[i] || 0;

    if (num1 < num2) return -1;
    if (num1 > num2) return 1;
  }

  return 0;
}
