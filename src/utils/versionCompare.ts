/**
 * Version comparison utilities for SkySpark/Haxall version handling
 */

/**
 * Version components interface
 */
export interface VersionComponents {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Pod compatibility configuration
 */
export interface PodCompatibility {
  compatMinVersion?: string;
  compatMaxVersion?: string;
  compatVersions?: string[];
}

/**
 * Parse version string into components.
 * Handles formats like "3.0.1", "3.0", "3", and invalid strings.
 * Invalid strings return { major: 0, minor: 0, patch: 0 }
 *
 * @param version - Version string to parse
 * @returns Parsed version components
 */
export function parseVersion(version: string): VersionComponents {
  if (!version || typeof version !== "string") {
    return { major: 0, minor: 0, patch: 0 };
  }

  // Remove leading 'v' if present (e.g., "v3.0.1")
  const cleanVersion = version.trim().replace(/^v/i, "");

  // Split by dots and parse each component
  const parts = cleanVersion.split(".");

  const major = parseInt(parts[0], 10);
  const minor = parts.length > 1 ? parseInt(parts[1], 10) : 0;
  const patch = parts.length > 2 ? parseInt(parts[2], 10) : 0;

  // If any component is NaN, return zeros
  if (isNaN(major) || isNaN(minor) || isNaN(patch)) {
    return { major: 0, minor: 0, patch: 0 };
  }

  return { major, minor, patch };
}

/**
 * Compare two version strings (semver-like: major.minor.patch).
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b
 *
 * @param a - First version string
 * @param b - Second version string
 * @returns -1, 0, or 1 based on comparison
 */
export function compareVersions(a: string, b: string): number {
  const versionA = parseVersion(a);
  const versionB = parseVersion(b);

  // Compare major
  if (versionA.major < versionB.major) return -1;
  if (versionA.major > versionB.major) return 1;

  // Compare minor
  if (versionA.minor < versionB.minor) return -1;
  if (versionA.minor > versionB.minor) return 1;

  // Compare patch
  if (versionA.patch < versionB.patch) return -1;
  if (versionA.patch > versionB.patch) return 1;

  return 0;
}

/**
 * Check if a version is within a range.
 * Missing min means no lower bound, missing max means no upper bound.
 * Both missing means any version matches.
 *
 * @param version - Version to check
 * @param min - Minimum version (inclusive), undefined for no lower bound
 * @param max - Maximum version (inclusive), undefined for no upper bound
 * @returns true if version is within the range
 */
export function isVersionInRange(
  version: string,
  min?: string,
  max?: string
): boolean {
  if (!version) {
    return false;
  }

  // No bounds means any version is valid
  if (!min && !max) {
    return true;
  }

  // Check minimum bound
  if (min && compareVersions(version, min) < 0) {
    return false;
  }

  // Check maximum bound
  if (max && compareVersions(version, max) > 0) {
    return false;
  }

  return true;
}

/**
 * Check if a version matches a list of specific versions.
 * Uses exact matching with parsed components for comparison.
 *
 * @param version - Version to check
 * @param versions - List of specific versions to match against
 * @returns true if version matches any version in the list
 */
export function isVersionInList(version: string, versions: string[]): boolean {
  if (!version || !versions || versions.length === 0) {
    return false;
  }

  return versions.some((v) => compareVersions(version, v) === 0);
}

/**
 * Check if a pod is compatible with a given version.
 * Priority:
 * 1. If compatVersions is provided and non-empty, check against that list
 * 2. Otherwise check against min/max range
 * 3. If no constraints are defined, assume compatible
 *
 * @param pod - Pod compatibility configuration
 * @param version - Version to check compatibility against
 * @returns true if the pod is compatible with the version
 */
export function isPodCompatible(
  pod: PodCompatibility,
  version: string
): boolean {
  if (!pod || !version) {
    return false;
  }

  // If specific versions list is provided and non-empty, use it as override
  if (pod.compatVersions && pod.compatVersions.length > 0) {
    return isVersionInList(version, pod.compatVersions);
  }

  // Otherwise use range check
  return isVersionInRange(version, pod.compatMinVersion, pod.compatMaxVersion);
}

/**
 * Format a version range for display.
 * Handles various combinations of min, max, and version lists.
 *
 * @param min - Minimum version
 * @param max - Maximum version
 * @param versions - Specific version list
 * @returns Human-readable version range string
 */
export function formatVersionRange(
  min?: string,
  max?: string,
  versions?: string[]
): string {
  // If specific versions are provided, format as list
  if (versions && versions.length > 0) {
    if (versions.length === 1) {
      return versions[0];
    }
    return versions.join(", ");
  }

  // Handle range formatting
  if (min && max) {
    // Single version (min === max)
    if (compareVersions(min, max) === 0) {
      return min;
    }
    return `${min} - ${max}`;
  }

  if (min && !max) {
    return `>= ${min}`;
  }

  if (!min && max) {
    return `<= ${max}`;
  }

  return "any version";
}

/**
 * Validate if a string is a valid version format.
 * Accepts formats: "1", "1.0", "1.0.0", "v1.0.0"
 *
 * @param version - Version string to validate
 * @returns true if the version string is valid
 */
export function isValidVersion(version: string): boolean {
  if (!version || typeof version !== "string") {
    return false;
  }

  const cleanVersion = version.trim().replace(/^v/i, "");

  // Match semver-like pattern: number(.number(.number)?)?
  const versionPattern = /^\d+(\.\d+)?(\.\d+)?$/;

  return versionPattern.test(cleanVersion);
}

/**
 * Normalize a version string to full semver format (major.minor.patch).
 *
 * @param version - Version string to normalize
 * @returns Normalized version string or empty string if invalid
 */
export function normalizeVersion(version: string): string {
  const parsed = parseVersion(version);

  // If parsing returned all zeros and input wasn't "0" or "0.0" or "0.0.0"
  if (
    parsed.major === 0 &&
    parsed.minor === 0 &&
    parsed.patch === 0 &&
    !isValidVersion(version)
  ) {
    return "";
  }

  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

/**
 * Get the latest version from a list of versions.
 *
 * @param versions - Array of version strings
 * @returns The highest version, or undefined if list is empty
 */
export function getLatestVersion(versions: string[]): string | undefined {
  if (!versions || versions.length === 0) {
    return undefined;
  }

  return versions.reduce((latest, current) => {
    if (!latest) return current;
    return compareVersions(current, latest) > 0 ? current : latest;
  });
}

/**
 * Sort versions in ascending or descending order.
 *
 * @param versions - Array of version strings to sort
 * @param descending - If true, sort in descending order (default: false)
 * @returns New sorted array of versions
 */
export function sortVersions(
  versions: string[],
  descending: boolean = false
): string[] {
  if (!versions || versions.length === 0) {
    return [];
  }

  const sorted = [...versions].sort(compareVersions);

  return descending ? sorted.reverse() : sorted;
}
