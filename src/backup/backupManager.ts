/**
 * Backup Manager - Core backup/restore logic with ZIP archive handling
 */

import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import archiver from 'archiver';
import AdmZip from 'adm-zip';
import { randomUUID } from 'crypto';
import type {
  BackupMetadata,
  BackupContents,
  DatabaseBackupStats,
  CreateBackupOptions,
  RestoreOptions,
  BackupInfo,
  BackupResult,
  RestoreResult,
} from './types.js';

const mkdirAsync = promisify(fs.mkdir);
const readdirAsync = promisify(fs.readdir);
const statAsync = promisify(fs.stat);
const unlinkAsync = promisify(fs.unlink);

// Server version from package.json
const SERVER_VERSION = '0.1.0';
const BACKUP_FORMAT_VERSION = '1.0';

export class BackupManager {
  private configDir: string;
  private cacheDir: string;
  private backupDir: string;

  constructor(configDir: string, cacheDir: string) {
    this.configDir = configDir;
    this.cacheDir = cacheDir;
    this.backupDir = path.join(configDir, 'backups');
  }

  /**
   * Ensure the backup directory exists
   */
  private async ensureBackupDir(): Promise<void> {
    if (!fs.existsSync(this.backupDir)) {
      await mkdirAsync(this.backupDir, { recursive: true });
    }
  }

  /**
   * Generate a unique backup filename
   */
  private generateBackupFilename(): string {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '-');
    const shortId = randomUUID().slice(0, 8);
    return `backup_${dateStr}_${timeStr}_${shortId}.zip`;
  }

  /**
   * Get database statistics for backup metadata
   */
  private async getDatabaseStats(): Promise<DatabaseBackupStats | undefined> {
    const dbPath = path.join(this.cacheDir, 'fantom.db');
    if (!fs.existsSync(dbPath)) {
      return undefined;
    }

    try {
      // Import better-sqlite3 dynamically to avoid circular deps
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(dbPath, { readonly: true });

      const stats: DatabaseBackupStats = {
        instances: 0,
        pods: 0,
        projects: 0,
        oauthClients: 0,
        settings: 0,
      };

      // Get counts from each table (if they exist)
      try {
        const instanceCount = db.prepare('SELECT COUNT(*) as count FROM fantom_instances').get() as { count: number };
        stats.instances = instanceCount?.count || 0;
      } catch { /* table may not exist */ }

      try {
        const podCount = db.prepare('SELECT COUNT(*) as count FROM fantom_pods').get() as { count: number };
        stats.pods = podCount?.count || 0;
      } catch { /* table may not exist */ }

      try {
        const projectCount = db.prepare('SELECT COUNT(*) as count FROM fantom_projects').get() as { count: number };
        stats.projects = projectCount?.count || 0;
      } catch { /* table may not exist */ }

      try {
        const oauthCount = db.prepare('SELECT COUNT(*) as count FROM oauth_clients').get() as { count: number };
        stats.oauthClients = oauthCount?.count || 0;
      } catch { /* table may not exist */ }

      try {
        const settingsCount = db.prepare('SELECT COUNT(*) as count FROM settings').get() as { count: number };
        stats.settings = settingsCount?.count || 0;
      } catch { /* table may not exist */ }

      db.close();
      return stats;
    } catch {
      return undefined;
    }
  }

  /**
   * Export database tables individually to the archive (streams per-table JSON to avoid memory issues)
   */
  private async exportDatabaseToArchive(archive: archiver.Archiver): Promise<string[]> {
    const dbPath = path.join(this.cacheDir, 'fantom.db');
    if (!fs.existsSync(dbPath)) {
      return [];
    }

    const exportedTables: string[] = [];

    try {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(dbPath, { readonly: true });

      // Get all tables
      const tables = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
      `).all() as { name: string }[];

      const SKIP_TABLES = ['oauth_access_tokens', 'oauth_refresh_tokens', 'oauth_authorization_codes'];

      for (const { name } of tables) {
        if (SKIP_TABLES.includes(name)) continue;

        try {
          const count = (db.prepare(`SELECT COUNT(*) as c FROM ${name}`).get() as { c: number })?.c ?? 0;
          // Skip tables with more than 50k rows to avoid memory issues in JSON export
          if (count > 50000) {
            continue;
          }
          const rows = db.prepare(`SELECT * FROM ${name}`).all();
          archive.append(JSON.stringify(rows, null, 2), { name: `database/tables/${name}.json` });
          exportedTables.push(name);
        } catch { /* table query failed */ }
      }

      db.close();
    } catch {
      // ignore export errors
    }

    return exportedTables;
  }

  /**
   * Create a backup
   */
  async createBackup(options: CreateBackupOptions = {}): Promise<BackupResult> {
    const {
      includeSearchIndexes = false,
      includeDatabase = true,
      description,
      createdBy,
    } = options;

    await this.ensureBackupDir();

    const backupId = randomUUID();
    const filename = this.generateBackupFilename();
    const backupPath = path.join(this.backupDir, filename);
    const warnings: string[] = [];

    // Build metadata
    const contents: BackupContents = {
      configFiles: [],
      database: false,
      searchIndexes: false,
    };

    // Pre-fetch async data before creating archive
    let dbStats: DatabaseBackupStats | undefined;

    if (includeDatabase) {
      const dbPath = path.join(this.cacheDir, 'fantom.db');
      if (fs.existsSync(dbPath)) {
        try {
          dbStats = await this.getDatabaseStats();
        } catch { /* ignore stats errors */ }
      }
    }

    // Create ZIP archive
    const output = fs.createWriteStream(backupPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.pipe(output);

    // Add config files
    const configFiles = [
      { src: path.join(this.configDir, 'users.json'), dest: 'config/users.json' },
      { src: path.join(this.configDir, 'admin.json'), dest: 'config/admin.json' },
      { src: path.join(this.configDir, 'fantomMcpServer-config.json'), dest: 'config/fantomMcpServer-config.json' },
      { src: path.join(process.cwd(), 'fantom-config.json'), dest: 'fantom-config.json' },
    ];

    for (const { src, dest } of configFiles) {
      if (fs.existsSync(src)) {
        archive.file(src, { name: dest });
        contents.configFiles.push(dest);
      }
    }

    // Add database
    if (includeDatabase) {
      const dbPath = path.join(this.cacheDir, 'fantom.db');
      if (fs.existsSync(dbPath)) {
        archive.file(dbPath, { name: 'database/fantom.db' });
        contents.database = true;

        if (dbStats) {
          contents.databaseStats = dbStats;
        }

        // Export individual tables as separate JSON files (avoids memory issues with large DBs)
        try {
          await this.exportDatabaseToArchive(archive);
        } catch { /* ignore export errors */ }
      } else {
        warnings.push('Database file not found');
      }
    }

    // Add LanceDB vector store directory
    if (includeDatabase) {
      const lanceDbDir = path.join(this.cacheDir, 'fantomvector.db');
      if (fs.existsSync(lanceDbDir) && fs.statSync(lanceDbDir).isDirectory()) {
        archive.directory(lanceDbDir, 'lancedb/fantomvector.db');
        contents.lanceDbIncluded = true;
      }
    }

    // Add search indexes (optional, can be large)
    if (includeSearchIndexes) {
      const searchIndexFiles: string[] = [];
      try {
        const cacheFiles = fs.readdirSync(this.cacheDir);
        for (const file of cacheFiles) {
          if (file.startsWith('flexsearch-local-') && file.endsWith('.json')) {
            const filePath = path.join(this.cacheDir, file);
            archive.file(filePath, { name: `cache/${file}` });
            searchIndexFiles.push(file);
          }
        }
        if (searchIndexFiles.length > 0) {
          contents.searchIndexes = true;
          contents.searchIndexFiles = searchIndexFiles;
        }
      } catch {
        warnings.push('Failed to include search indexes');
      }
    }

    // Add metadata inside the archive
    const tempMetadata: BackupMetadata = {
      id: backupId,
      createdAt: new Date().toISOString(),
      serverVersion: SERVER_VERSION,
      formatVersion: BACKUP_FORMAT_VERSION,
      description,
      createdBy,
      contents,
    };
    archive.append(JSON.stringify(tempMetadata, null, 2), { name: 'backup-metadata.json' });

    // Finalize archive and wait for it to complete
    archive.finalize();

    return new Promise((resolve, reject) => {
      output.on('close', async () => {
        try {
          const metadata: BackupMetadata = {
            id: backupId,
            createdAt: new Date().toISOString(),
            serverVersion: SERVER_VERSION,
            formatVersion: BACKUP_FORMAT_VERSION,
            description,
            createdBy,
            contents,
          };

          // Write metadata as a sidecar JSON file (more reliable than modifying zip)
          const metadataPath = backupPath.replace('.zip', '.meta.json');
          fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

          const finalStat = await statAsync(backupPath);

          resolve({
            success: true,
            backupId,
            path: backupPath,
            size: finalStat.size,
            metadata,
            warnings: warnings.length > 0 ? warnings : undefined,
          });
        } catch (err) {
          reject(err);
        }
      });

      archive.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * List all backups
   */
  async listBackups(): Promise<BackupInfo[]> {
    await this.ensureBackupDir();

    const files = await readdirAsync(this.backupDir);
    const backups: BackupInfo[] = [];

    for (const file of files) {
      if (!file.endsWith('.zip')) continue;

      const filePath = path.join(this.backupDir, file);
      const metadataPath = filePath.replace('.zip', '.meta.json');

      try {
        const stat = await statAsync(filePath);

        // Try to read sidecar metadata file first
        if (fs.existsSync(metadataPath)) {
          const metadataContent = fs.readFileSync(metadataPath, 'utf8');
          const metadata: BackupMetadata = JSON.parse(metadataContent);
          backups.push({
            id: metadata.id,
            filename: file,
            createdAt: metadata.createdAt,
            size: stat.size,
            path: filePath,
            metadata,
          });
        } else {
          // Fallback: try reading from inside the zip (for legacy backups)
          try {
            const zip = new AdmZip(filePath);
            const metadataEntry = zip.getEntry('backup-metadata.json');
            if (metadataEntry) {
              const metadata: BackupMetadata = JSON.parse(metadataEntry.getData().toString('utf8'));
              backups.push({
                id: metadata.id,
                filename: file,
                createdAt: metadata.createdAt,
                size: stat.size,
                path: filePath,
                metadata,
              });
            }
          } catch {
            // Skip backups without valid metadata
            console.error(`Backup ${file} has no readable metadata`);
          }
        }
      } catch (err) {
        // Skip invalid backup files
        console.error(`Failed to read backup ${file}:`, err);
      }
    }

    // Sort by creation date (newest first)
    backups.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return backups;
  }

  /**
   * Get backup info by ID
   */
  async getBackupInfo(id: string): Promise<BackupInfo | null> {
    const backups = await this.listBackups();
    return backups.find(b => b.id === id) || null;
  }

  /**
   * Get backup file path by ID
   */
  async getBackupPath(id: string): Promise<string | null> {
    const backup = await this.getBackupInfo(id);
    return backup?.path || null;
  }

  /**
   * Delete a backup
   */
  async deleteBackup(id: string): Promise<boolean> {
    const backup = await this.getBackupInfo(id);
    if (!backup) {
      return false;
    }

    try {
      await unlinkAsync(backup.path);
      // Also delete sidecar metadata file if it exists
      const metadataPath = backup.path.replace('.zip', '.meta.json');
      if (fs.existsSync(metadataPath)) {
        await unlinkAsync(metadataPath);
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Restore from a backup
   */
  async restoreBackup(id: string, options: RestoreOptions): Promise<RestoreResult> {
    if (!options.confirm) {
      return {
        success: false,
        backupId: id,
        restoredItems: [],
        skippedItems: [],
        warnings: ['Restore not confirmed. Set confirm: true to proceed.'],
        requiresRestart: false,
      };
    }

    const backup = await this.getBackupInfo(id);
    if (!backup) {
      return {
        success: false,
        backupId: id,
        restoredItems: [],
        skippedItems: [],
        errors: ['Backup not found'],
        requiresRestart: false,
      };
    }

    const {
      restoreConfig = true,
      restoreDatabase = true,
      restoreSearchIndexes = true,
      createBackupBeforeRestore = true,
    } = options;

    const restoredItems: string[] = [];
    const skippedItems: string[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];
    let preRestoreBackupId: string | undefined;

    // Create pre-restore backup
    if (createBackupBeforeRestore) {
      try {
        const preBackup = await this.createBackup({
          description: `Pre-restore backup (before restoring ${id})`,
          createdBy: 'system',
          includeDatabase: true,
          includeSearchIndexes: false,
        });
        preRestoreBackupId = preBackup.backupId;
      } catch (err) {
        warnings.push('Failed to create pre-restore backup');
      }
    }

    try {
      const zip = new AdmZip(backup.path);
      const entries = zip.getEntries();

      for (const entry of entries) {
        const entryName = entry.entryName;

        // Skip metadata file
        if (entryName === 'backup-metadata.json') continue;

        // Config files
        if (entryName.startsWith('config/') && restoreConfig) {
          const destPath = path.join(this.configDir, entryName.replace('config/', ''));
          try {
            const dir = path.dirname(destPath);
            if (!fs.existsSync(dir)) {
              await mkdirAsync(dir, { recursive: true });
            }
            zip.extractEntryTo(entry, path.dirname(destPath), false, true);
            restoredItems.push(entryName);
          } catch (err) {
            errors.push(`Failed to restore ${entryName}`);
          }
        }

        // Root config file
        if (entryName === 'fantom-config.json' && restoreConfig) {
          try {
            zip.extractEntryTo(entry, process.cwd(), false, true);
            restoredItems.push(entryName);
          } catch (err) {
            errors.push(`Failed to restore ${entryName}`);
          }
        }

        // Database
        if (entryName.startsWith('database/') && restoreDatabase) {
          if (entryName === 'database/fantom.db') {
            try {
              // Ensure cache dir exists
              if (!fs.existsSync(this.cacheDir)) {
                await mkdirAsync(this.cacheDir, { recursive: true });
              }
              zip.extractEntryTo(entry, this.cacheDir, false, true);
              restoredItems.push(entryName);
            } catch (err) {
              errors.push(`Failed to restore database: ${err}`);
            }
          } else {
            // Skip JSON export (it's just for inspection)
            skippedItems.push(entryName);
          }
        }

        // LanceDB vector store
        if (entryName.startsWith('lancedb/') && restoreDatabase) {
          try {
            const relativePath = entryName.replace('lancedb/', '');
            const destPath = path.join(this.cacheDir, relativePath);
            const dir = path.dirname(destPath);
            if (!fs.existsSync(dir)) {
              await mkdirAsync(dir, { recursive: true });
            }
            zip.extractEntryTo(entry, path.dirname(destPath), false, true);
            restoredItems.push(entryName);
          } catch (err) {
            errors.push(`Failed to restore ${entryName}`);
          }
        }

        // Search indexes
        if (entryName.startsWith('cache/') && restoreSearchIndexes) {
          if (backup.metadata.contents.searchIndexes) {
            try {
              if (!fs.existsSync(this.cacheDir)) {
                await mkdirAsync(this.cacheDir, { recursive: true });
              }
              zip.extractEntryTo(entry, this.cacheDir, false, true);
              restoredItems.push(entryName);
            } catch (err) {
              errors.push(`Failed to restore ${entryName}`);
            }
          }
        }
      }

      return {
        success: errors.length === 0,
        backupId: id,
        restoredItems,
        skippedItems,
        preRestoreBackupId,
        warnings: warnings.length > 0 ? warnings : undefined,
        errors: errors.length > 0 ? errors : undefined,
        requiresRestart: restoreDatabase || restoreConfig,
      };
    } catch (err) {
      return {
        success: false,
        backupId: id,
        restoredItems,
        skippedItems,
        preRestoreBackupId,
        errors: [`Restore failed: ${err}`],
        requiresRestart: false,
      };
    }
  }
}

// Singleton instance
let backupManagerInstance: BackupManager | null = null;

export function getBackupManager(configDir: string, cacheDir: string): BackupManager {
  if (!backupManagerInstance) {
    backupManagerInstance = new BackupManager(configDir, cacheDir);
  }
  return backupManagerInstance;
}
