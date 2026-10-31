'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { getApiBase, api, SidecarAccountRow } from '../../lib/api';
import {
  Shield,
  User,
  UserPlus,
  Key,
  Trash2,
  Check,
  X,
  AlertCircle,
  Loader2,
  Crown,
  FolderSync,
  Link2,
} from 'lucide-react';

// ============================================
// Types
// ============================================

interface UserData {
  id: string;
  username: string;
  role: 'admin' | 'user';
  createdAt: string;
  lastLogin?: string;
  dashboardLogin?: boolean;
  sidecarSync?: { enabled: boolean; roots: string[]; linkedAt?: string };
}

// ============================================
// API Functions
// ============================================

async function fetchUsers(authHeader: string): Promise<{ users: UserData[] }> {
  const response = await fetch(`${getApiBase()}/admin/users`, {
    headers: { Authorization: authHeader },
  });
  if (!response.ok) throw new Error('Failed to fetch users');
  return response.json();
}

async function createUser(
  authHeader: string,
  data: { username: string; password: string; role: 'admin' | 'user' }
): Promise<{ success: boolean; user: UserData }> {
  const response = await fetch(`${getApiBase()}/admin/users`, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to create user');
  }
  return response.json();
}

async function updatePassword(
  authHeader: string,
  username: string,
  password: string
): Promise<{ success: boolean }> {
  const response = await fetch(`${getApiBase()}/admin/users/${username}/password`, {
    method: 'PUT',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to update password');
  }
  return response.json();
}

async function updateRole(
  authHeader: string,
  username: string,
  role: 'admin' | 'user'
): Promise<{ success: boolean }> {
  const response = await fetch(`${getApiBase()}/admin/users/${username}/role`, {
    method: 'PUT',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ role }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to update role');
  }
  return response.json();
}

async function deleteUser(
  authHeader: string,
  username: string
): Promise<{ success: boolean }> {
  const response = await fetch(`${getApiBase()}/admin/users/${username}`, {
    method: 'DELETE',
    headers: { Authorization: authHeader },
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to delete user');
  }
  return response.json();
}

async function saveSyncLogin(
  authHeader: string,
  username: string,
  method: 'PUT' | 'DELETE',
  body?: { enabled: boolean; password?: string; roots: string[] }
): Promise<{ user: UserData }> {
  const response = await fetch(`${getApiBase()}/admin/users/${encodeURIComponent(username)}/sidecar-sync`, {
    method,
    headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Failed to save the sync login');
  return data;
}

// ============================================
// Components
// ============================================

/** "Sidecar sync login" editor for one user. The sync password is write-only. */
function SyncLoginForm({
  user, account, rootNames, onDone,
}: {
  user: UserData;
  account: SidecarAccountRow | undefined;
  /** Root names the receiver knows (its map + roots seen). */
  rootNames: string[];
  onDone: () => void;
}) {
  const { getAuthHeader } = useAuth();
  const [enabled, setEnabled] = useState(user.sidecarSync?.enabled ?? true);
  const [password, setPassword] = useState('');
  const [roots, setRoots] = useState((user.sidecarSync?.roots ?? []).join(', '));
  const picked = roots.split(',').map((r) => r.trim()).filter(Boolean);
  const choices = [...new Set([...rootNames, ...(account?.roots ?? []), ...picked])].sort((a, b) => a.localeCompare(b));
  const toggle = (name: string) =>
    setRoots((picked.includes(name) ? picked.filter((r) => r !== name) : [...picked, name]).join(', '));
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (m: 'PUT' | 'DELETE') => saveSyncLogin(
      getAuthHeader(), user.username, m,
      m === 'PUT' ? { enabled, roots: roots.split(',').map((r) => r.trim()).filter(Boolean), ...(password ? { password } : {}) } : undefined,
    ),
    onSuccess: () => { setPassword(''); setError(null); onDone(); },
    onError: (err: Error) => setError(err.message),
  });
  const needsPw = enabled && !account;

  return (
    <form
      className="space-y-3 bg-gray-50 border border-gray-200 rounded-lg p-4"
      onSubmit={(e) => { e.preventDefault(); mutation.mutate('PUT'); }}
    >
      <p className="text-sm font-medium text-gray-900">Sidecar sync login for &quot;{user.username}&quot;</p>
      <p className="text-xs text-gray-500">
        The sync password is separate from the dashboard password. The receiver keeps it; Fantom does not store it.
      </p>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Sync login on
      </label>
      <div className="flex flex-wrap gap-3">
        <label className="text-sm text-gray-700">
          <span className="block text-xs text-gray-500 mb-1">Sync password</span>
          <input
            type="password" autoComplete="new-password" value={password} disabled={!enabled}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={account ? 'Empty = keep the current one' : 'At least 8 characters'}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm w-60 disabled:opacity-50"
          />
        </label>
        {choices.length ? (
          <fieldset className="text-sm text-gray-700" disabled={!enabled}>
            <legend className="block text-xs text-gray-500 mb-1">
              Allowed roots (none ticked = all roots). The receiver refuses changes to other roots.
            </legend>
            <div className="flex flex-wrap gap-3">
              {choices.map((name) => (
                <label key={name} className="flex items-center gap-1 font-mono">
                  <input type="checkbox" checked={picked.includes(name)} onChange={() => toggle(name)} />
                  {name}
                </label>
              ))}
            </div>
          </fieldset>
        ) : (
          <label className="text-sm text-gray-700">
            <span className="block text-xs text-gray-500 mb-1">Allowed roots (comma list, empty = all)</span>
            <input
              value={roots} disabled={!enabled} onChange={(e) => setRoots(e.target.value)}
              placeholder="BAS, soundSuite"
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono w-72 disabled:opacity-50"
            />
          </label>
        )}
      </div>
      <div className="flex gap-2">
        <button
          type="submit" disabled={mutation.isPending || (needsPw && password.length < 8) || (!!password && password.length < 8)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm disabled:opacity-50"
        >
          {mutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />} Save
        </button>
        {account && (
          <button
            type="button" disabled={mutation.isPending}
            onClick={() => { if (confirm(`Remove the sync login of "${user.username}"? Its sidecar can not log in any more.`)) mutation.mutate('DELETE'); }}
            className="px-4 py-2 border border-red-300 text-red-700 hover:bg-red-50 rounded-lg text-sm disabled:opacity-50"
          >
            Remove sync login
          </button>
        )}
        <button type="button" onClick={onDone} className="px-4 py-2 border border-gray-300 hover:bg-gray-100 rounded-lg text-sm">
          Cancel
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}

function SyncCell({ user, account }: { user: UserData; account: SidecarAccountRow | undefined }) {
  if (!user.sidecarSync?.enabled) return <span className="text-sm text-gray-400">Off</span>;
  const roots = user.sidecarSync.roots.length ? user.sidecarSync.roots : account?.roots ?? [];
  const enforced = account?.allowed_roots ?? [];
  return (
    <div className="text-sm">
      <span className={`mr-2 inline-block h-2 w-2 rounded-full ${account?.connected ? 'bg-green-500' : 'bg-gray-400'}`} />
      <span className="text-gray-700">{account ? (account.connected ? 'Connected' : 'Not connected') : 'Not on receiver'}</span>
      <p className="text-xs text-gray-500">
        Last login {account?.last_login_ms ? new Date(account.last_login_ms).toLocaleString() : 'never'}
        {' · '}Roots {roots.length ? roots.join(', ') : 'all'}
        {!user.sidecarSync.roots.length && roots.length ? ' (reported)' : ''}
        {account && enforced.length === 0 && user.sidecarSync.roots.length ? ' · receiver allows all' : ''}
      </p>
    </div>
  );
}

function CurrentUserCard({ user }: { user: UserData }) {
  const { getAuthHeader, refreshUser } = useAuth();
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const passwordMutation = useMutation({
    mutationFn: (password: string) => updatePassword(getAuthHeader(), user.username, password),
    onSuccess: () => {
      setSuccess(true);
      setIsChangingPassword(false);
      setNewPassword('');
      setConfirmPassword('');
      setError(null);
      // Update stored credentials
      localStorage.setItem('admin_pass', newPassword);
      refreshUser();
      setTimeout(() => setSuccess(false), 3000);
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  const handlePasswordSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (newPassword.length < 4) {
      setError('Password must be at least 4 characters');
      return;
    }
    setError(null);
    passwordMutation.mutate(newPassword);
  };

  return (
    <div className="bg-white rounded-lg shadow p-6 mb-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center">
          {user.role === 'admin' ? (
            <Crown className="w-6 h-6 text-blue-600" />
          ) : (
            <User className="w-6 h-6 text-blue-600" />
          )}
        </div>
        <div>
          <h2 className="text-xl font-semibold text-gray-900">{user.username}</h2>
          <span className={`text-sm px-2 py-0.5 rounded-full ${
            user.role === 'admin'
              ? 'bg-purple-100 text-purple-700'
              : 'bg-gray-100 text-gray-600'
          }`}>
            {user.role}
          </span>
        </div>
      </div>

      <div className="text-sm text-gray-500 mb-4">
        <p>Created: {new Date(user.createdAt).toLocaleDateString()}</p>
        {user.lastLogin && (
          <p>Last login: {new Date(user.lastLogin).toLocaleString()}</p>
        )}
      </div>

      {success && (
        <div className="flex items-center gap-2 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 mb-4">
          <Check className="w-5 h-5" />
          <span>Password updated successfully</span>
        </div>
      )}

      {!isChangingPassword ? (
        <button
          onClick={() => setIsChangingPassword(true)}
          className="flex items-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg transition-colors"
        >
          <Key className="w-4 h-4" />
          Change Password
        </button>
      ) : (
        <form onSubmit={handlePasswordSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              New Password
            </label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="Enter new password"
              minLength={4}
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Confirm Password
            </label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="Confirm new password"
              minLength={4}
              required
            />
          </div>
          {error && (
            <div className="flex items-center gap-2 text-red-600 text-sm">
              <AlertCircle className="w-4 h-4" />
              {error}
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={passwordMutation.isPending}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              {passwordMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Check className="w-4 h-4" />
              )}
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setIsChangingPassword(false);
                setNewPassword('');
                setConfirmPassword('');
                setError(null);
              }}
              className="flex items-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg transition-colors"
            >
              <X className="w-4 h-4" />
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function CreateUserForm({ onSuccess }: { onSuccess: () => void }) {
  const { getAuthHeader } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'user'>('user');
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () => createUser(getAuthHeader(), { username, password, role }),
    onSuccess: () => {
      setUsername('');
      setPassword('');
      setRole('user');
      setError(null);
      onSuccess();
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    createMutation.mutate();
  };

  return (
    <div className="bg-white rounded-lg shadow p-6 mb-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
        <UserPlus className="w-5 h-5" />
        Create New User
      </h3>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Username
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="Enter username"
              minLength={3}
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="Enter password"
              minLength={4}
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Role
            </label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as 'admin' | 'user')}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </div>
        </div>
        {error && (
          <div className="flex items-center gap-2 text-red-600 text-sm">
            <AlertCircle className="w-4 h-4" />
            {error}
          </div>
        )}
        <button
          type="submit"
          disabled={createMutation.isPending}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors disabled:opacity-50"
        >
          {createMutation.isPending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <UserPlus className="w-4 h-4" />
          )}
          Create User
        </button>
      </form>
    </div>
  );
}

function UserRow({
  user,
  currentUsername,
  onRefresh,
  account,
  rootNames,
}: {
  user: UserData;
  currentUsername: string;
  onRefresh: () => void;
  account: SidecarAccountRow | undefined;
  rootNames: string[];
}) {
  const [editSync, setEditSync] = useState(false);
  const { getAuthHeader } = useAuth();
  const [isEditingRole, setIsEditingRole] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const isCurrentUser = user.username === currentUsername;

  const roleMutation = useMutation({
    mutationFn: (newRole: 'admin' | 'user') => updateRole(getAuthHeader(), user.username, newRole),
    onSuccess: () => {
      setIsEditingRole(false);
      onRefresh();
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  const passwordMutation = useMutation({
    mutationFn: (password: string) => updatePassword(getAuthHeader(), user.username, password),
    onSuccess: () => {
      setIsChangingPassword(false);
      setNewPassword('');
      setError(null);
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteUser(getAuthHeader(), user.username),
    onSuccess: () => {
      onRefresh();
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  return (
    <>
    <tr className="border-b border-gray-200 hover:bg-gray-50">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
            user.role === 'admin' ? 'bg-purple-100' : 'bg-gray-100'
          }`}>
            {user.role === 'admin' ? (
              <Crown className="w-4 h-4 text-purple-600" />
            ) : (
              <User className="w-4 h-4 text-gray-600" />
            )}
          </div>
          <span className="font-medium text-gray-900">{user.username}</span>
          {isCurrentUser && (
            <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
              You
            </span>
          )}
          {user.dashboardLogin === false && (
            <span className="text-xs text-gray-500">(no dashboard login)</span>
          )}
        </div>
      </td>
      <td className="px-4 py-3">
        {isEditingRole && !isCurrentUser ? (
          <div className="flex items-center gap-2">
            <select
              defaultValue={user.role}
              onChange={(e) => roleMutation.mutate(e.target.value as 'admin' | 'user')}
              disabled={roleMutation.isPending}
              className="px-2 py-1 border border-gray-300 rounded text-sm"
            >
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
            <button
              onClick={() => setIsEditingRole(false)}
              className="text-gray-500 hover:text-gray-700"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <span
            className={`text-sm px-2 py-0.5 rounded-full cursor-pointer ${
              user.role === 'admin'
                ? 'bg-purple-100 text-purple-700'
                : 'bg-gray-100 text-gray-600'
            } ${!isCurrentUser ? 'hover:ring-2 hover:ring-blue-300' : ''}`}
            onClick={() => !isCurrentUser && setIsEditingRole(true)}
            title={isCurrentUser ? 'Cannot change own role' : 'Click to change role'}
          >
            {user.role}
          </span>
        )}
      </td>
      <td className="px-4 py-3 text-sm text-gray-500">
        {user.lastLogin ? new Date(user.lastLogin).toLocaleString() : 'Never'}
      </td>
      <td className="px-4 py-3">
        <SyncCell user={user} account={account} />
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          {isChangingPassword ? (
            <div className="flex items-center gap-2">
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="px-2 py-1 border border-gray-300 rounded text-sm w-32"
                placeholder="New password"
                minLength={4}
              />
              <button
                onClick={() => {
                  if (newPassword.length >= 4) {
                    passwordMutation.mutate(newPassword);
                  }
                }}
                disabled={passwordMutation.isPending || newPassword.length < 4}
                className="text-green-600 hover:text-green-700 disabled:opacity-50"
              >
                {passwordMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Check className="w-4 h-4" />
                )}
              </button>
              <button
                onClick={() => {
                  setIsChangingPassword(false);
                  setNewPassword('');
                }}
                className="text-gray-500 hover:text-gray-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <>
              <button
                onClick={() => setEditSync((v) => !v)}
                className="p-1 text-gray-500 hover:text-teal-600 transition-colors"
                title="Sidecar sync login"
              >
                <FolderSync className="w-4 h-4" />
              </button>
              <button
                onClick={() => setIsChangingPassword(true)}
                className="p-1 text-gray-500 hover:text-blue-600 transition-colors"
                title="Change password"
              >
                <Key className="w-4 h-4" />
              </button>
              {!isCurrentUser && (
                <button
                  onClick={() => {
                    if (confirm(`Delete user "${user.username}"?`)) {
                      deleteMutation.mutate();
                    }
                  }}
                  disabled={deleteMutation.isPending}
                  className="p-1 text-gray-500 hover:text-red-600 transition-colors disabled:opacity-50"
                  title="Delete user"
                >
                  {deleteMutation.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4" />
                  )}
                </button>
              )}
            </>
          )}
        </div>
        {error && (
          <div className="text-xs text-red-600 mt-1">{error}</div>
        )}
      </td>
    </tr>
    {editSync && (
      <tr className="border-b border-gray-200">
        <td colSpan={5} className="px-4 py-3">
          <SyncLoginForm user={user} account={account} rootNames={rootNames} onDone={() => { setEditSync(false); onRefresh(); }} />
        </td>
      </tr>
    )}
    </>
  );
}

// ============================================
// Main Page
// ============================================

export default function UsersPage() {
  const { user, role, getAuthHeader } = useAuth();
  const queryClient = useQueryClient();
  const isAdmin = role === 'admin';

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['users'],
    queryFn: () => fetchUsers(getAuthHeader()),
    enabled: isAdmin,
  });

  const accounts = useQuery({
    queryKey: ['sidecar-accounts'],
    queryFn: () => api.sidecarAccounts(),
    enabled: isAdmin,
    refetchInterval: 15000,
  });
  const accountFor = (name: string) =>
    accounts.data?.accounts.find((a) => a.username.toLowerCase() === name.toLowerCase());
  const unlinked = (accounts.data?.accounts ?? []).filter((a) => !a.user);
  const [linkMsg, setLinkMsg] = useState<string | null>(null);
  const link = useMutation({
    mutationFn: () => api.sidecarAccountsLink(),
    onSuccess: (r) => {
      const n = r.linked.length + r.created.length;
      setLinkMsg(n ? `Linked ${n} receiver account(s): ${[...r.linked, ...r.created].join(', ')}` : 'All receiver accounts are linked');
      handleRefresh();
    },
    onError: (err: Error) => setLinkMsg(err.message),
  });

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ['users'] });
    queryClient.invalidateQueries({ queryKey: ['sidecar-accounts'] });
    refetch();
  };

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Shield className="w-8 h-8 text-blue-600" />
        <h1 className="text-2xl font-bold text-gray-900">User Management</h1>
      </div>

      {/* Current User Card */}
      {user && <CurrentUserCard user={user as UserData} />}

      {/* Admin-only sections */}
      {isAdmin ? (
        <>
          {/* Create User Form */}
          <CreateUserForm onSuccess={handleRefresh} />

          {/* Users Table */}
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">All Users</h3>
              {accounts.data?.configured && (
                <button
                  onClick={() => link.mutate()} disabled={link.isPending}
                  className="flex items-center gap-2 px-3 py-1.5 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  title="Link receiver accounts to users with the same name (new users get no dashboard login)"
                >
                  <Link2 className="w-4 h-4" /> Link receiver accounts
                </button>
              )}
            </div>
            {accounts.data && !accounts.data.configured && (
              <p className="px-6 py-2 text-sm text-gray-500">Sidecar receiver not set up (SIDECAR_RECEIVER_URL, SIDECAR_RECEIVER_TOKEN).</p>
            )}
            {accounts.data?.error && <p className="px-6 py-2 text-sm text-red-600">Receiver: {accounts.data.error}</p>}
            {unlinked.length > 0 && (
              <p className="px-6 py-2 text-sm text-yellow-700">
                Receiver accounts without a user: {unlinked.map((a) => a.username).join(', ')}. Click &quot;Link receiver accounts&quot;.
              </p>
            )}
            {linkMsg && <p className="px-6 py-2 text-sm text-gray-700">{linkMsg}</p>}

            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
              </div>
            ) : error ? (
              <div className="flex items-center gap-2 p-6 text-red-600">
                <AlertCircle className="w-5 h-5" />
                <span>Failed to load users</span>
              </div>
            ) : (
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">
                      User
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">
                      Role
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">
                      Last Login
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">
                      Sidecar sync login
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data?.users.map((u) => (
                    <UserRow
                      key={u.id}
                      user={u}
                      currentUsername={user?.username || ''}
                      onRefresh={handleRefresh}
                      account={accountFor(u.username)}
                      rootNames={accounts.data?.rootNames ?? []}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6">
          <div className="flex items-center gap-2 text-yellow-700">
            <AlertCircle className="w-5 h-5" />
            <span>Admin access required to manage other users</span>
          </div>
        </div>
      )}
    </div>
  );
}
