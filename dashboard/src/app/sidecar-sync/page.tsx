'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { PathInput } from '@/components/ui/FolderPicker';
import Link from 'next/link';
import { api, MirrorProject, MirrorReloadResult, SidecarStatusEntry, SidecarAccountRow } from '../../lib/api';
import {
  RefreshCw, Plus, Pencil, Trash2, AlertCircle, Loader2, Check, X, Server, FolderSync, RotateCcw, KeyRound, Users,
} from 'lucide-react';

function formatMs(ms: number | null | undefined): string {
  return ms ? new Date(ms).toLocaleString() : '—';
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function ProjectModal({
  initial, mirrorRoot, onClose, onSave, saving, error,
}: {
  initial: MirrorProject | null;
  mirrorRoot: string;
  onClose: () => void;
  onSave: (p: MirrorProject) => void;
  saving: boolean;
  error: string | null;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [path, setPath] = useState(initial?.path ?? `${mirrorRoot}/`);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          {initial ? <Pencil className="w-5 h-5 text-blue-600" /> : <Plus className="w-5 h-5 text-blue-600" />}
          {initial ? 'Edit mirror project' : 'Add mirror project'}
        </h3>
        <form
          onSubmit={(e) => { e.preventDefault(); onSave({ name: name.trim(), path: path.trim() }); }}
          className="space-y-4"
        >
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input
              type="text" value={name} onChange={(e) => setName(e.target.value)} required
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="e.g., bas"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Path</label>
            <PathInput
              value={path} onChange={setPath} required
              inputClassName="flex-1 min-w-0 px-3 py-2 border border-gray-300 rounded-lg font-mono text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder={`${mirrorRoot}/{sidecar}/{root}`}
              pickerTitle="Choose the mirrored project folder"
            />
            <p className="text-xs text-gray-500 mt-1">Must be under {mirrorRoot}/&#123;sidecar&#125;/&#123;root&#125;.</p>
          </div>
          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-50 text-red-700 rounded-lg text-sm">
              <AlertCircle className="w-4 h-4" /> {error}
            </div>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
            <button
              type="submit" disabled={saving}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Sidecar accounts on the receiver (admin only, read only). Manage them on the Users page. */
function CredentialsTab() {
  const accounts = useQuery({ queryKey: ['sidecar-accounts'], queryFn: () => api.sidecarAccounts(), refetchInterval: 15000 });
  const list: SidecarAccountRow[] = accounts.data?.accounts ?? [];

  return (
    <div className="bg-white rounded-lg shadow overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-gray-900">Sidecar accounts</h2>
          <p className="text-xs text-gray-500">Each account is the sidecar sync login of a Fantom user. Add, change or remove it on the Users page.</p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => accounts.refetch()} className="text-sm text-gray-600 hover:text-gray-900 flex items-center gap-1">
            <RefreshCw className={`w-4 h-4 ${accounts.isFetching ? 'animate-spin' : ''}`} /> Refresh
          </button>
          <Link href="/users/" className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm">
            <Users className="w-4 h-4" /> Manage in Users
          </Link>
        </div>
      </div>
      {accounts.isLoading ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="w-8 h-8 text-blue-600 animate-spin" /></div>
      ) : accounts.error ? (
        <div className="flex items-center gap-2 p-6 text-red-600"><AlertCircle className="w-5 h-5" /> {(accounts.error as Error).message}</div>
      ) : accounts.data && !accounts.data.configured ? (
        <p className="p-6 text-sm text-yellow-800">Receiver not set up. Set SIDECAR_RECEIVER_URL and SIDECAR_RECEIVER_TOKEN on the server.</p>
      ) : accounts.data?.error ? (
        <div className="flex items-center gap-2 p-6 text-red-600"><AlertCircle className="w-5 h-5" /> {accounts.data.error}</div>
      ) : list.length === 0 ? (
        <p className="p-6 text-sm text-gray-500">No sidecar accounts.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              {['Username', 'Fantom user', 'Connected', 'Last login', 'Roots'].map((h) => (
                <th key={h} className="px-4 py-3 text-left font-medium text-gray-600">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.map((a) => (
              <tr key={a.username} className="border-t border-gray-100">
                <td className="px-4 py-3 font-medium text-gray-900">{a.username}</td>
                <td className="px-4 py-3 text-gray-700">
                  {a.user ? <>{a.user}{a.dashboardLogin === false && <span className="ml-2 text-xs text-gray-500">(no dashboard login)</span>}</>
                    : <span className="text-yellow-700">not linked</span>}
                </td>
                <td className="px-4 py-3">
                  {a.connected ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-100 text-green-800 text-xs">connected</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-200 text-gray-700 text-xs">offline</span>
                  )}
                </td>
                <td className="px-4 py-3 text-gray-700">{formatMs(a.last_login_ms)}</td>
                <td className="px-4 py-3 text-gray-700">{a.roots.length ? a.roots.join(', ') : <span className="text-gray-400">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Receiver status for a mirror project: match the receiver's real target path, then {sidecar}/{root}. */
function findRoot(sidecars: SidecarStatusEntry[], projectPath: string, sidecar: string | null, root: string | null) {
  const norm = (p: string) => p.replace(/\/+$/, '');
  for (const s of sidecars) {
    const r = s.roots.find((x) => norm(x.target) === norm(projectPath));
    if (r) return { sidecar: s, root: r };
  }
  const s = sidecars.find((x) => x.id === sidecar);
  return { sidecar: s, root: s?.roots.find((r) => r.name === root) };
}

export default function SidecarSyncPage() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const queryClient = useQueryClient();
  const [modal, setModal] = useState<{ edit: MirrorProject | null } | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [reload, setReload] = useState<MirrorReloadResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tab, setTab] = useState<'sync' | 'credentials'>('sync');

  const mirror = useQuery({ queryKey: ['sidecar-mirror'], queryFn: () => api.sidecarMirror() });
  const status = useQuery({
    queryKey: ['sidecar-status'], queryFn: () => api.sidecarStatus(), refetchInterval: 10000,
  });

  const refreshMirror = () => queryClient.invalidateQueries({ queryKey: ['sidecar-mirror'] });

  const save = useMutation({
    mutationFn: (p: MirrorProject) =>
      modal?.edit ? api.sidecarMirrorEdit(modal.edit.name, p) : api.sidecarMirrorAdd(p),
    onSuccess: () => { setModal(null); setModalError(null); refreshMirror(); },
    onError: (err: Error) => setModalError(err.message),
  });
  const remove = useMutation({
    mutationFn: (name: string) => api.sidecarMirrorRemove(name),
    onSuccess: () => { setActionError(null); refreshMirror(); },
    onError: (err: Error) => setActionError(err.message),
  });
  const setAuto = useMutation({
    mutationFn: (auto: boolean) => api.sidecarMirrorAuto(auto),
    onSuccess: () => { setActionError(null); refreshMirror(); },
    onError: (err: Error) => setActionError(err.message),
  });
  const doReload = useMutation({
    mutationFn: () => api.sidecarReload(),
    onSuccess: (r) => { setReload(r); setActionError(null); refreshMirror(); },
    onError: (err: Error) => setActionError(err.message),
  });

  const feed = status.data?.status;
  const sidecars = feed?.sidecars ?? [];

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <FolderSync className="w-8 h-8 text-blue-600" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900">fileSystem sidecar sync</h1>
            <p className="text-sm text-gray-500">Mirror projects and sidecar receiver status</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { status.refetch(); mirror.refetch(); }}
            className="flex items-center gap-2 px-4 py-2 text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 rounded-lg"
          >
            <RefreshCw className={`w-4 h-4 ${status.isFetching ? 'animate-spin' : ''}`} /> Refresh
          </button>
          {isAdmin && (
            <>
              <button
                onClick={() => doReload.mutate()} disabled={doReload.isPending}
                className="flex items-center gap-2 px-4 py-2 text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 rounded-lg disabled:opacity-50"
              >
                {doReload.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                Reload
              </button>
              <button
                onClick={() => { setModalError(null); setModal({ edit: null }); }}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg"
              >
                <Plus className="w-4 h-4" /> Add project
              </button>
            </>
          )}
        </div>
      </div>

      {/* Receiver banner */}
      <div className="bg-white rounded-lg shadow p-4 mb-6">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <span className="flex items-center gap-2 font-medium text-gray-900">
            <Server className="w-4 h-4 text-gray-500" /> Receiver
          </span>
          <span className="text-gray-600">URL: <b>{status.data?.settings.receiverUrl ?? '—'}</b></span>
          <span className="text-gray-600">Token: <b>{status.data?.settings.receiverToken ?? '—'}</b></span>
          {feed?.version && <span className="text-gray-600">Version: {feed.version}</span>}
          {status.data?.fetchedAt && (
            <span className="text-gray-600">Last result: {new Date(status.data.fetchedAt).toLocaleString()}</span>
          )}
        </div>
        {status.data && !status.data.configured && (
          <div className="mt-3 flex items-center gap-2 p-3 bg-yellow-50 border border-yellow-200 text-yellow-800 rounded-lg text-sm">
            <AlertCircle className="w-4 h-4" />
            Receiver not set up. Set SIDECAR_RECEIVER_URL and SIDECAR_RECEIVER_TOKEN on the server.
          </div>
        )}
        {status.data?.error && (
          <div className="mt-3 flex items-center gap-2 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
            <AlertCircle className="w-4 h-4" />
            {status.data.error}{status.data.status ? ' (showing the last result)' : ''}
          </div>
        )}
        {status.error && (
          <div className="mt-3 flex items-center gap-2 p-3 bg-red-50 text-red-700 rounded-lg text-sm">
            <AlertCircle className="w-4 h-4" /> {(status.error as Error).message}
          </div>
        )}
      </div>

      {isAdmin && (
        <div className="flex gap-1 mb-6 border-b border-gray-200">
          {([['sync', 'Sync', FolderSync], ['credentials', 'Credentials', KeyRound]] as const).map(([id, label, Icon]) => (
            <button
              key={id} onClick={() => setTab(id)}
              className={`flex items-center gap-2 px-4 py-2 text-sm border-b-2 -mb-px ${tab === id ? 'border-blue-600 text-blue-700 font-medium' : 'border-transparent text-gray-600 hover:text-gray-900'}`}
            >
              <Icon className="w-4 h-4" /> {label}
            </button>
          ))}
        </div>
      )}

      {isAdmin && tab === 'credentials' ? <CredentialsTab /> : (<>
      {actionError && (
        <div className="mb-4 flex items-center gap-2 p-3 bg-red-50 text-red-700 rounded-lg text-sm">
          <AlertCircle className="w-4 h-4" /> {actionError}
        </div>
      )}
      {reload && (
        <div className="mb-4 p-3 bg-blue-50 border border-blue-200 text-blue-800 rounded-lg text-sm flex items-start justify-between gap-4">
          <div className="space-y-1">
            <p>Reload done: {reload.created.length ? `added ${reload.created.join(', ')}` : 'no new projects'} ({reload.total} in list).</p>
            {reload.missingFolders.length > 0 && <p>Folder not found yet: {reload.missingFolders.join(', ')}</p>}
            {reload.notInList.length > 0 && (
              <p>Mirror projects not in the list (delete them on Pods &amp; Projects if not needed): {reload.notInList.join(', ')}</p>
            )}
          </div>
          <button onClick={() => setReload(null)} className="text-blue-600 hover:text-blue-800"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Mirror projects */}
      <div className="bg-white rounded-lg shadow overflow-hidden mb-6">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <div>
            <h2 className="font-semibold text-gray-900">Mirror projects</h2>
            <p className="text-xs text-gray-500">
              Source: {mirror.data?.source === 'settings' ? 'settings' : 'FANTOM_MIRROR_PROJECTS (startup seed)'}
              {mirror.data?.mirrorRoot && <> · Root: <code>{mirror.data.mirrorRoot}</code></>}
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox" checked={!!mirror.data?.auto} disabled={!isAdmin || setAuto.isPending}
              onChange={(e) => setAuto.mutate(e.target.checked)}
              className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
            />
            Auto (every mirror folder)
          </label>
        </div>
        {mirror.isLoading ? (
          <div className="flex items-center justify-center py-12"><Loader2 className="w-8 h-8 text-blue-600 animate-spin" /></div>
        ) : mirror.error ? (
          <div className="flex items-center gap-2 p-6 text-red-600"><AlertCircle className="w-5 h-5" /> Failed to load mirror projects</div>
        ) : !mirror.data?.effective.length ? (
          <div className="flex flex-col items-center justify-center py-12 text-gray-500">
            <FolderSync className="w-12 h-12 mb-3 text-gray-300" />
            <p className="text-lg font-medium">No mirror projects</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                {['Project', 'Sidecar', 'Connected', 'Last change', 'Hook', 'Files', ''].map((h) => (
                  <th key={h} className="px-4 py-3 text-left font-medium text-gray-600">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {mirror.data.effective.map((p) => {
                const m = findRoot(sidecars, p.path, p.sidecar, p.root);
                return (
                  <tr key={p.path} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900">{p.name}{p.fromAuto && <span className="ml-2 text-xs text-gray-500">(auto)</span>}</p>
                      <p className="font-mono text-xs text-gray-500">{p.path}{!p.exists && <span className="ml-2 text-yellow-700">folder not found</span>}</p>
                    </td>
                    <td className="px-4 py-3 text-gray-700">{p.sidecar}/{p.root}</td>
                    <td className="px-4 py-3">
                      {!m.sidecar ? <span className="text-gray-400">unknown</span> : m.sidecar.connected ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-100 text-green-800 text-xs">connected</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-200 text-gray-700 text-xs">offline</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      <p>{formatMs(m.root?.last_change_ms)}</p>
                      {m.root?.last_path && <p className="font-mono text-xs text-gray-500">{m.root.last_path}</p>}
                    </td>
                    <td className="px-4 py-3">
                      {!m.root?.hook ? <span className="text-gray-400">—</span> : m.root.hook.ok ? (
                        <span className="text-green-700 flex items-center gap-1"><Check className="w-4 h-4" /> ok</span>
                      ) : (
                        <span className="text-red-700" title={m.root.hook.error ?? ''}>failed{m.root.hook.error ? `: ${m.root.hook.error}` : ''}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {m.root ? `${m.root.files} · ${formatBytes(m.root.bytes)}` : '—'}
                    </td>
                    <td className="px-4 py-3">
                      {isAdmin && !p.fromAuto && (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => { setModalError(null); setModal({ edit: { name: p.name, path: p.path } }); }}
                            className="p-1.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded" title="Edit"
                          ><Pencil className="w-4 h-4" /></button>
                          <button
                            onClick={() => { if (confirm(`Remove "${p.name}" from the mirror list? The Fantom project and its index stay.`)) remove.mutate(p.name); }}
                            className="p-1.5 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded" title="Remove"
                          ><Trash2 className="w-4 h-4" /></button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Recent files */}
      <div className="bg-white rounded-lg shadow overflow-hidden mb-6">
        <div className="px-4 py-3 border-b border-gray-200"><h2 className="font-semibold text-gray-900">Recent files</h2></div>
        {!feed?.recent.length ? (
          <p className="p-6 text-sm text-gray-500">No recent files.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                {['Time', 'Sidecar / root', 'Path', 'Op', 'Size'].map((h) => (
                  <th key={h} className="px-4 py-2 text-left font-medium text-gray-600">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {feed.recent.slice(0, 50).map((e, i) => (
                <tr key={i} className="border-t border-gray-100">
                  <td className="px-4 py-2 text-gray-700 whitespace-nowrap">{formatMs(e.ts_ms)}</td>
                  <td className="px-4 py-2 text-gray-700">{e.sidecar}/{e.root}</td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-700">{e.path}</td>
                  <td className="px-4 py-2 text-gray-700">{e.op}</td>
                  <td className="px-4 py-2 text-gray-700">{typeof e.size === 'number' ? formatBytes(e.size) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {feed && feed.errors.length > 0 && (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200"><h2 className="font-semibold text-gray-900">Receiver errors</h2></div>
          <ul className="divide-y divide-gray-100 text-sm">
            {feed.errors.map((e, i) => (
              <li key={i} className="px-4 py-2 text-red-700">
                <span className="text-gray-500 mr-2">{formatMs(e.ts_ms)}</span>{e.sidecar}/{e.root}: {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      </>)}

      {modal && mirror.data && (
        <ProjectModal
          initial={modal.edit}
          mirrorRoot={mirror.data.mirrorRoot}
          onClose={() => setModal(null)}
          onSave={(p) => save.mutate(p)}
          saving={save.isPending}
          error={modalError}
        />
      )}
    </div>
  );
}
