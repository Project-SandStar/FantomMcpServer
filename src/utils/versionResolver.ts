/**
 * Version Resolver for searchVersionedApi tool
 *
 * Resolves version context using the following priority chain:
 * 1. Explicit `version` parameter → source: 'explicit'
 * 2. `instanceId` parameter → lookup → source: 'instance'
 * 3. `active_instance_id` setting → source: 'active'
 * 4. No version → source: 'none' (search all)
 */

import { getFantomDatabase, type FantomDatabase } from '../fantom/database.js';
import type { InstanceType } from '../fantom/types.js';
import { isVersionInRange, isValidVersion } from './versionCompare.js';

/**
 * Result of version resolution
 */
export interface VersionResolutionResult {
  version: string | null;
  source: 'explicit' | 'instance' | 'active' | 'none';
  instanceId?: number;
  instanceName?: string;
  instanceType?: InstanceType;
  resolved: boolean;
  warning?: string;
}

/**
 * Arguments for version resolution
 */
export interface VersionResolverArgs {
  version?: string;
  instanceId?: number;
}

/**
 * Resolve version context from provided arguments
 *
 * Priority chain:
 * 1. Explicit `version` parameter
 * 2. `instanceId` parameter → lookup instance version
 * 3. `active_instance_id` setting → lookup active instance version
 * 4. No version (search all)
 *
 * @param args - Arguments containing optional version or instanceId
 * @param db - Optional database instance (will use singleton if not provided)
 * @returns Resolution result with version, source, and instance metadata
 */
export async function resolveVersion(
  args: VersionResolverArgs,
  db?: FantomDatabase
): Promise<VersionResolutionResult> {
  const database = db || getFantomDatabase();
  await database.initialize();

  // Priority 1: Explicit version parameter
  if (args.version) {
    if (!isValidVersion(args.version)) {
      return {
        version: args.version,
        source: 'explicit',
        resolved: false,
        warning: `Invalid version format: ${args.version}. Expected format like "3.1.12" or "4.0.3".`
      };
    }
    return {
      version: args.version,
      source: 'explicit',
      resolved: true
    };
  }

  // Priority 2: instanceId parameter
  if (args.instanceId !== undefined) {
    const instance = await database.getInstanceById(args.instanceId);
    if (!instance) {
      return {
        version: null,
        source: 'instance',
        instanceId: args.instanceId,
        resolved: false,
        warning: `Instance not found: ${args.instanceId}`
      };
    }

    if (!instance.version) {
      return {
        version: null,
        source: 'instance',
        instanceId: instance.id,
        instanceName: instance.name,
        instanceType: instance.type,
        resolved: false,
        warning: `Instance "${instance.name}" has no version configured`
      };
    }

    return {
      version: instance.version,
      source: 'instance',
      instanceId: instance.id,
      instanceName: instance.name,
      instanceType: instance.type,
      resolved: true
    };
  }

  // Priority 3: Active instance
  const activeInstanceId = await database.getActiveInstanceId();
  if (activeInstanceId) {
    const activeInstance = await database.getInstanceById(activeInstanceId);
    if (activeInstance) {
      if (!activeInstance.version) {
        return {
          version: null,
          source: 'active',
          instanceId: activeInstance.id,
          instanceName: activeInstance.name,
          instanceType: activeInstance.type,
          resolved: false,
          warning: `Active instance "${activeInstance.name}" has no version configured`
        };
      }

      return {
        version: activeInstance.version,
        source: 'active',
        instanceId: activeInstance.id,
        instanceName: activeInstance.name,
        instanceType: activeInstance.type,
        resolved: true
      };
    }
  }

  // Priority 4: No version context
  return {
    version: null,
    source: 'none',
    resolved: true // No version is still a valid resolution (search all)
  };
}

/**
 * Extract numeric version from a version string.
 * Handles formats like "3.1.8", "skyspark-3.1.8", "haxall-4.0.4", "v3.1.8"
 *
 * @param version - Version string that may have prefixes
 * @returns Clean numeric version string (e.g., "3.1.8")
 */
function extractNumericVersion(version: string): string {
  if (!version) return '';

  // Remove common prefixes: skyspark-, haxall-, fantom-, v
  let cleaned = version
    .replace(/^(skyspark|haxall|fantom)-/i, '')
    .replace(/^v/i, '')
    .trim();

  // Extract version number pattern (X.Y.Z or X.Y)
  const match = cleaned.match(/(\d+(?:\.\d+){0,2})/);
  return match ? match[1] : cleaned;
}

/**
 * Check if a given version is compatible with a target version
 * A version is compatible if it is less than or equal to the target
 *
 * @param sourceVersion - The version of the source item
 * @param targetVersion - The version to check compatibility against
 * @returns true if sourceVersion <= targetVersion
 */
export function isVersionFilterCompatible(
  sourceVersion: string | undefined | null,
  targetVersion: string | null
): boolean {
  // If no target version specified, all versions are compatible
  if (!targetVersion) {
    return true;
  }

  // If no source version, assume compatible (backward compatibility)
  if (!sourceVersion) {
    return true;
  }

  // Extract numeric versions for comparison
  const sourceNumeric = extractNumericVersion(sourceVersion);
  const targetNumeric = extractNumericVersion(targetVersion);

  // If we can't extract versions, assume compatible
  if (!sourceNumeric || !targetNumeric) {
    return true;
  }

  // Use the isVersionInRange function with only max bound
  return isVersionInRange(sourceNumeric, undefined, targetNumeric);
}

/**
 * Format version context for response
 */
export function formatVersionContext(resolution: VersionResolutionResult): {
  resolved: string | null;
  source: 'explicit' | 'instance' | 'active' | 'none';
  instanceId?: number;
  instanceName?: string;
  instanceType?: InstanceType;
  warning?: string;
} {
  return {
    resolved: resolution.version,
    source: resolution.source,
    instanceId: resolution.instanceId,
    instanceName: resolution.instanceName,
    instanceType: resolution.instanceType,
    warning: resolution.warning
  };
}
