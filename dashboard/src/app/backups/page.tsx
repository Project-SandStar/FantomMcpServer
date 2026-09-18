'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { api, BackupInfo, CreateBackupOptions } from '../../lib/api';
import {
  HardDrive,
  Plus,
  Download,
  RotateCcw,
  Trash2,
  AlertCircle,
  Loader2,
  Check,
  X,
  Database,
  FileText,
  Search,
  Calendar,
  User,
  AlertTriangle,
} from 'lucide-react';

// ============================================
// Helper Functions
// ============================================

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString();
}

// ============================================
// Components
// ============================================

function CreateBackupModal({
  isOpen,
  onClose,
  onSuccess,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [includeDatabase, setIncludeDatabase] = useState(true);
  const [includeSearchIndexes, setIncludeSearchIndexes] = useState(false);
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: (options: CreateBackupOptions) => api.createBackup(options),
    onSuccess: () => {
      onSuccess();
      onClose();
      setDescription('');
      setError(null);
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    createMutation.mutate({
      includeDatabase,
      includeSearchIndexes,
      description: description || undefined,
    });
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <Plus className="w-5 h-5 text-blue-600" />
          Create Backup
        </h3>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Description (optional)
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="e.g., Before major update"
            />
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Include in backup:
            </label>

            <label className="flex items-center gap-3 p-3 border border-gray-200 rounded-lg hover:bg-gray-50 cursor-pointer">
              <input
                type="checkbox"
                checked={includeDatabase}
                onChange={(e) => setIncludeDatabase(e.target.checked)}
                className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
              />
              <Database className="w-5 h-5 text-gray-500" />
              <div>
                <p className="font-medium text-gray-900">Database</p>
                <p className="text-sm text-gray-500">Instances, pods, projects, settings</p>
              </div>
            </label>

            <label className="flex items-center gap-3 p-3 border border-gray-200 rounded-lg hover:bg-gray-50 cursor-pointer">
              <input
                type="checkbox"
                checked={includeSearchIndexes}
                onChange={(e) => setIncludeSearchIndexes(e.target.checked)}
                className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
              />
              <Search className="w-5 h-5 text-gray-500" />
              <div>
                <p className="font-medium text-gray-900">Search Indexes</p>
                <p className="text-sm text-gray-500">Local documentation cache (can be large)</p>
              </div>
            </label>

            <div className="flex items-center gap-3 p-3 border border-gray-200 rounded-lg bg-gray-50">
              <div className="w-4 h-4 flex items-center justify-center">
                <Check className="w-4 h-4 text-green-600" />
              </div>
              <FileText className="w-5 h-5 text-gray-500" />
              <div>
                <p className="font-medium text-gray-900">Configuration Files</p>
                <p className="text-sm text-gray-500">Always included (users, settings)</p>
              </div>
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700">
              <AlertCircle className="w-5 h-5" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <button
              type="submit"
              disabled={createMutation.isPending}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              {createMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
              Create Backup
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function RestoreConfirmModal({
  backup,
  isOpen,
  onClose,
  onSuccess,
}: {
  backup: BackupInfo | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [restoreConfig, setRestoreConfig] = useState(true);
  const [restoreDatabase, setRestoreDatabase] = useState(true);
  const [restoreSearchIndexes, setRestoreSearchIndexes] = useState(true);
  const [createBackupBeforeRestore, setCreateBackupBeforeRestore] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const restoreMutation = useMutation({
    mutationFn: () =>
      api.restoreBackup(backup!.id, {
        confirm: true,
        restoreConfig,
        restoreDatabase,
        restoreSearchIndexes,
        createBackupBeforeRestore,
      }),
    onSuccess: (result) => {
      if (result.success) {
        onSuccess();
        onClose();
        if (result.requiresRestart) {
          alert('Restore complete. Please restart the server for changes to take effect.');
        }
      } else {
        setError(result.errors?.join(', ') || 'Restore failed');
      }
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  if (!isOpen || !backup) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-yellow-600" />
          Restore Backup
        </h3>

        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-4">
          <p className="text-sm text-yellow-800">
            <strong>Warning:</strong> Restoring will overwrite existing data. This action cannot be undone.
          </p>
        </div>

        <div className="mb-4">
          <p className="text-sm text-gray-600">
            Restoring from: <strong>{backup.filename}</strong>
          </p>
          <p className="text-sm text-gray-500">
            Created: {formatDate(backup.createdAt)}
          </p>
        </div>

        <div className="space-y-2 mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            What to restore:
          </label>

          <label className="flex items-center gap-2 p-2">
            <input
              type="checkbox"
              checked={restoreConfig}
              onChange={(e) => setRestoreConfig(e.target.checked)}
              className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
            />
            <span className="text-sm text-gray-700">Configuration files</span>
          </label>

          {backup.metadata.contents.database && (
            <label className="flex items-center gap-2 p-2">
              <input
                type="checkbox"
                checked={restoreDatabase}
                onChange={(e) => setRestoreDatabase(e.target.checked)}
                className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
              />
              <span className="text-sm text-gray-700">Database</span>
            </label>
          )}

          {backup.metadata.contents.searchIndexes && (
            <label className="flex items-center gap-2 p-2">
              <input
                type="checkbox"
                checked={restoreSearchIndexes}
                onChange={(e) => setRestoreSearchIndexes(e.target.checked)}
                className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
              />
              <span className="text-sm text-gray-700">Search indexes</span>
            </label>
          )}

          <label className="flex items-center gap-2 p-2 mt-4 border-t border-gray-200 pt-4">
            <input
              type="checkbox"
              checked={createBackupBeforeRestore}
              onChange={(e) => setCreateBackupBeforeRestore(e.target.checked)}
              className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
            />
            <span className="text-sm text-gray-700">Create backup before restore (recommended)</span>
          </label>
        </div>

        {error && (
          <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 mb-4">
            <AlertCircle className="w-5 h-5" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={() => restoreMutation.mutate()}
            disabled={restoreMutation.isPending}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-yellow-600 hover:bg-yellow-700 text-white rounded-lg transition-colors disabled:opacity-50"
          >
            {restoreMutation.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RotateCcw className="w-4 h-4" />
            )}
            Restore
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function BackupRow({
  backup,
  onRestore,
  onDelete,
  isAdmin,
}: {
  backup: BackupInfo;
  onRestore: (backup: BackupInfo) => void;
  onDelete: (backup: BackupInfo) => void;
  isAdmin: boolean;
}) {
  const { contents } = backup.metadata;
  const { databaseStats } = contents;

  return (
    <tr className="border-b border-gray-200 hover:bg-gray-50">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <HardDrive className="w-5 h-5 text-blue-600" />
          <div>
            <p className="font-medium text-gray-900">{backup.filename}</p>
            {backup.metadata.description && (
              <p className="text-sm text-gray-500">{backup.metadata.description}</p>
            )}
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Calendar className="w-4 h-4" />
          {formatDate(backup.createdAt)}
        </div>
        {backup.metadata.createdBy && (
          <div className="flex items-center gap-1 text-xs text-gray-400 mt-1">
            <User className="w-3 h-3" />
            {backup.metadata.createdBy}
          </div>
        )}
      </td>
      <td className="px-4 py-3">
        <span className="text-sm text-gray-600">{formatBytes(backup.size)}</span>
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1">
          {contents.configFiles.length > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-100 text-green-700 text-xs rounded-full">
              <FileText className="w-3 h-3" />
              Config
            </span>
          )}
          {contents.database && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded-full">
              <Database className="w-3 h-3" />
              DB
              {databaseStats && (
                <span className="text-blue-500">
                  ({databaseStats.instances}i/{databaseStats.pods}p)
                </span>
              )}
            </span>
          )}
          {contents.searchIndexes && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-purple-100 text-purple-700 text-xs rounded-full">
              <Search className="w-3 h-3" />
              Index
            </span>
          )}
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1">
          <a
            href={api.downloadBackupUrl(backup.id)}
            className="p-1.5 text-gray-500 hover:text-blue-600 transition-colors"
            title="Download"
          >
            <Download className="w-4 h-4" />
          </a>
          {isAdmin && (
            <>
              <button
                onClick={() => onRestore(backup)}
                className="p-1.5 text-gray-500 hover:text-yellow-600 transition-colors"
                title="Restore"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
              <button
                onClick={() => onDelete(backup)}
                className="p-1.5 text-gray-500 hover:text-red-600 transition-colors"
                title="Delete"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

// ============================================
// Main Page
// ============================================

export default function BackupsPage() {
  const { role } = useAuth();
  const queryClient = useQueryClient();
  const isAdmin = role === 'admin';

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showRestoreModal, setShowRestoreModal] = useState(false);
  const [selectedBackup, setSelectedBackup] = useState<BackupInfo | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['backups'],
    queryFn: () => api.listBackups(),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteBackup(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backups'] });
      refetch();
    },
  });

  const handleDelete = (backup: BackupInfo) => {
    if (confirm(`Delete backup "${backup.filename}"? This cannot be undone.`)) {
      deleteMutation.mutate(backup.id);
    }
  };

  const handleRestore = (backup: BackupInfo) => {
    setSelectedBackup(backup);
    setShowRestoreModal(true);
  };

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ['backups'] });
    refetch();
  };

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <HardDrive className="w-8 h-8 text-blue-600" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Backups</h1>
            <p className="text-sm text-gray-500">Manage server configuration backups</p>
          </div>
        </div>

        {isAdmin && (
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
            Create Backup
          </button>
        )}
      </div>

      {/* Info Banner */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
        <p className="text-sm text-blue-800">
          Backups include user accounts, server configuration, and optionally the database and search indexes.
          Backups are stored in <code className="bg-blue-100 px-1 rounded">config/backups/</code>.
        </p>
      </div>

      {/* Backups Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 p-6 text-red-600">
            <AlertCircle className="w-5 h-5" />
            <span>Failed to load backups</span>
          </div>
        ) : data?.backups.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-gray-500">
            <HardDrive className="w-12 h-12 mb-3 text-gray-300" />
            <p className="text-lg font-medium">No backups yet</p>
            <p className="text-sm">Create a backup to get started</p>
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">
                  Backup
                </th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">
                  Created
                </th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">
                  Size
                </th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">
                  Contents
                </th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {data?.backups.map((backup) => (
                <BackupRow
                  key={backup.id}
                  backup={backup}
                  onRestore={handleRestore}
                  onDelete={handleDelete}
                  isAdmin={isAdmin}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Modals */}
      <CreateBackupModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSuccess={handleRefresh}
      />

      <RestoreConfirmModal
        backup={selectedBackup}
        isOpen={showRestoreModal}
        onClose={() => {
          setShowRestoreModal(false);
          setSelectedBackup(null);
        }}
        onSuccess={handleRefresh}
      />
    </div>
  );
}
