/**
 * Backup module exports
 */

export { BackupManager, getBackupManager } from './backupManager.js';
export type {
  BackupMetadata,
  BackupContents,
  DatabaseBackupStats,
  CreateBackupOptions,
  RestoreOptions,
  BackupInfo,
  BackupResult,
  RestoreResult,
} from './types.js';
