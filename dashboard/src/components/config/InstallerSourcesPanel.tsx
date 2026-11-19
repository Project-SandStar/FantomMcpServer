'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, InstallerSettings, InstallerProviderType } from '@/lib/api';
import { PathInput } from '@/components/ui/FolderPicker';

const PROVIDERS: { value: InstallerProviderType; label: string; hint: string }[] = [
  { value: 'nextcloud-share', label: 'Nextcloud public share', hint: 'https://<host>/s/<token>' },
  { value: 'webdav', label: 'WebDAV folder', hint: 'https://<host>/remote.php/dav/files/<user>/<folder>/' },
  { value: 'local', label: 'Folder on this server', hint: '/mnt/installers' },
  { value: 'http', label: 'HTTP URL (file or index page)', hint: 'https://<host>/installers/' },
  { value: 'google-drive', label: 'Google Drive (not available yet)', hint: '' },
];

/** Settings > Installer sources: where Haxall / SkySpark come from and where builds go. */
export function InstallerSourcesPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['installer-settings'], queryFn: api.getInstallerSettings });
  const [s, setS] = useState<InstallerSettings | null>(null);
  const [password, setPassword] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [versionsText, setVersionsText] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (q.data && !s) {
      setS(q.data);
      setVersionsText(Object.entries(q.data.haxall.fantomVersions).map(([h, f]) => `${h}=${f}`).join('\n'));
    }
  }, [q.data, s]);

  const save = useMutation({
    mutationFn: (secrets: { skysparkSourcePassword?: string | null; githubToken?: string | null }) => {
      const fantomVersions: Record<string, string> = {};
      for (const line of versionsText.split('\n')) {
        const [h, f] = line.split('=').map(x => x?.trim());
        if (h && f) fantomVersions[h] = f;
      }
      return api.saveInstallerSettings({ ...s!, haxall: { ...s!.haxall, fantomVersions }, secrets });
    },
    onSuccess: d => {
      setMsg('Saved.'); setPassword(''); setGithubToken('');
      setS(d);
      qc.setQueryData(['installer-settings'], d);
    },
    onError: e => setMsg((e as Error).message),
  });

  if (q.isLoading || !s) return <div className="text-sm text-gray-500">Loading installer settings…</div>;
  if (q.error) return <div className="text-sm text-red-700">{(q.error as Error).message}</div>;

  const input = 'w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-sm';
  const src = s.skyspark.source ?? { provider: 'nextcloud-share' as InstallerProviderType, location: '' };
  const setSrc = (patch: Partial<typeof src>) => setS({ ...s, skyspark: { ...s.skyspark, source: { ...src, ...patch } } });
  const setH = (patch: Partial<InstallerSettings['haxall']>) => setS({ ...s, haxall: { ...s.haxall, ...patch } });
  const setK = (patch: Partial<InstallerSettings['skyspark']>) => setS({ ...s, skyspark: { ...s.skyspark, ...patch } });
  const row = (label: string, el: React.ReactNode, hint?: string) => (
    <label className="block text-sm">
      <span className="text-gray-700">{label}</span>
      <div className="mt-1">{el}</div>
      {hint && <span className="text-xs text-gray-500">{hint}</span>}
    </label>
  );
  const hint = PROVIDERS.find(p => p.value === src.provider)?.hint;

  return (
    <div id="installers" className="space-y-4">
      <div>
        <h3 className="font-medium text-gray-800">Installer sources</h3>
        <p className="text-sm text-gray-600">
          Used by &quot;Check &amp; add Haxall&quot; and &quot;Check &amp; add SkySpark&quot; on the Instances page.
          Paths are on the server. Passwords and tokens go to the server&apos;s secrets store, not the config file.
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {row('JDK 17 home', <PathInput value={s.jdkHome} onChange={v => setS({ ...s, jdkHome: v })} placeholder="/usr/lib/jvm/java-17-openjdk-amd64" />, 'Empty = JAVA_HOME of the server.')}
        <label className="flex items-center gap-2 text-sm mt-6">
          <input type="checkbox" checked={s.autoCheckDaily} onChange={e => setS({ ...s, autoCheckDaily: e.target.checked })} />
          Check daily and add the newest missing Haxall and SkySpark version
        </label>
      </div>

      <div className="border rounded-md p-3 space-y-3">
        <div className="font-medium text-sm">SkySpark</div>
        <div className="grid md:grid-cols-2 gap-3">
          {row('Source type', (
            <select className={input} value={src.provider} onChange={e => setSrc({ provider: e.target.value as InstallerProviderType })}>
              {PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          ))}
          {row('Location', <input className={input} value={src.location} placeholder={hint} onChange={e => setSrc({ location: e.target.value })} />)}
          {(src.provider === 'webdav' || src.provider === 'http') &&
            row('User', <input className={input} value={src.username ?? ''} onChange={e => setSrc({ username: e.target.value })} />)}
          {row(src.provider === 'nextcloud-share' ? 'Share password' : 'Password', (
            <div className="flex gap-2">
              <input type="password" className={input} value={password} autoComplete="new-password"
                placeholder={q.data?.secrets.skysparkSourcePassword ? '(set — type to replace)' : '(none)'}
                onChange={e => setPassword(e.target.value)} />
              {q.data?.secrets.skysparkSourcePassword && (
                <button type="button" className="text-sm text-red-600 whitespace-nowrap" onClick={() => save.mutate({ skysparkSourcePassword: null })}>Remove</button>
              )}
            </div>
          ))}
          {row('Download folder', <PathInput value={s.skyspark.downloadDir} onChange={v => setK({ downloadDir: v })} />)}
          {row('Install root', <PathInput value={s.skyspark.installRoot} onChange={v => setK({ installRoot: v })} />, 'Each version goes to <root>/skyspark-<version>.')}
          {row('Oldest version offered', <input className={input} value={s.skyspark.minVersion} onChange={e => setK({ minVersion: e.target.value })} />)}
          <label className="flex items-start gap-2 text-sm mt-6">
            <input type="checkbox" className="mt-1" checked={s.skyspark.acceptEula} onChange={e => setK({ acceptEula: e.target.checked })} />
            <span>Accept the SkySpark EULA for 3.x docs. SkySpark 3.x docgen needs <code>bin/setup</code>, which accepts the EULA. No license is needed. Off: 3.x docs come from compilerDoc (pod API docs only).</span>
          </label>
        </div>
        {s.skyspark.source && (
          <button type="button" className="text-sm text-red-600" onClick={() => setK({ source: null })}>Clear source</button>
        )}
      </div>

      <div className="border rounded-md p-3 space-y-3">
        <div className="font-medium text-sm">Haxall</div>
        <div className="grid md:grid-cols-2 gap-3">
          {row('GitHub repo', <input className={input} value={s.haxall.githubRepo} onChange={e => setH({ githubRepo: e.target.value })} />)}
          {row('GitHub token (optional)', (
            <input type="password" className={input} value={githubToken} autoComplete="new-password"
              placeholder={q.data?.secrets.githubToken ? '(set — type to replace)' : '(none: 60 API calls per hour)'}
              onChange={e => setGithubToken(e.target.value)} />
          ))}
          {row('Install root', <PathInput value={s.haxall.installRoot} onChange={v => setH({ installRoot: v })} />, 'Builds go to <root>/haxall-<version>/home.')}
          {row('Fantom root', <PathInput value={s.haxall.fantomRoot} onChange={v => setH({ fantomRoot: v })} />, 'Holds fantom-<version>/; missing releases are downloaded.')}
          {row('Xeto root', <PathInput value={s.haxall.xetoRoot} onChange={v => setH({ xetoRoot: v })} />, 'One clone per Haxall version: <root>/<version>/xeto.')}
          {row('Xeto repo URL', <input className={input} value={s.haxall.xetoRepoUrl} onChange={e => setH({ xetoRepoUrl: e.target.value })} />)}
          {row('haystack-defs folder', <PathInput value={s.haxall.haystackDefsDir} onChange={v => setH({ haystackDefsDir: v })} />, 'Cloned and built when lib/fan/ph.pod is missing.')}
          {row('haystack-defs repo URL', <input className={input} value={s.haxall.haystackDefsRepoUrl} onChange={e => setH({ haystackDefsRepoUrl: e.target.value })} />)}
          {row('Oldest version offered', <input className={input} value={s.haxall.minVersion} onChange={e => setH({ minVersion: e.target.value })} />)}
          {row('Fantom version per Haxall version', (
            <textarea className={input} rows={4} value={versionsText} onChange={e => setVersionsText(e.target.value)} />
          ), 'One "haxall=fantom" per line, e.g. 4.0.7=1.0.84. Without a row: the newest Fantom release published on or before the Haxall release.')}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button type="button" disabled={save.isPending}
          className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
          onClick={() => save.mutate({
            ...(password ? { skysparkSourcePassword: password } : {}),
            ...(githubToken ? { githubToken } : {}),
          })}>
          {save.isPending ? 'Saving…' : 'Save installer settings'}
        </button>
        {msg && <span className="text-sm text-gray-700">{msg}</span>}
      </div>
    </div>
  );
}
