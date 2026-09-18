/**
 * Backup system type definitions
 */

export interface BackupMetadata {
  id: string;
  createdAt: string;
  serverVersion: string;
  formatVersion: string;
  description?: string;
  createdBy?: string;
  contents: BackupContents;
}

export interface BackupContents {
  configFiles: string[];
  database: boolean;
  databaseStats?: DatabaseBackupStats;
  searchIndexes: boolean;
  searchIndexFiles?: string[];
  lanceDbIncluded?: boolean;
}

export interface DatabaseBackupStats {
  instances: number;
  pods: number;
  projects: number;
  oauthClients: number;
  settings: number;
}

export interface CreateBackupOptions {
  includeSearchIndexes?: boolean;
  includeDatabase?: boolean;
  description?: string;
  createdBy?: string;
}

export interface RestoreOptions {
  confirm: boolean;
  restoreConfig?: boolean;
  restoreDatabase?: boolean;
  restoreSearchIndexes?: boolean;
  createBackupBeforeRestore?: boolean;
}

export interface BackupInfo {
  id: string;
  filename: string;
  createdAt: string;
  size: number;
  path: string;
  metadata: BackupMetadata;
}

export interface BackupResult {
  success: boolean;
  backupId: string;
  path: string;
  size: number;
  metadata: BackupMetadata;
  warnings?: string[];
  errors?: string[];
}

export interface RestoreResult {
  success: boolean;
  backupId: string;
  restoredItems: string[];
  skippedItems: string[];
  preRestoreBackupId?: string;
  warnings?: string[];
  errors?: string[];
  requiresRestart: boolean;
}
