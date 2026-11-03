'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { api, NetbirdView, NetbirdUpdate } from '@/lib/api';
import { AlertCircle, Check, Loader2, Lock, Network, RefreshCw, Trash2 } from 'lucide-react';

function Badge({ data }: { data: NetbirdView | undefined }) {
  if (!data) return null;
  if (!data.configured) {
    return <span className="px-3 py-1 rounded-full text-sm font-medium bg-yellow-100 text-yellow-800">Container missing</span>;
  }
  if (data.status?.connected) {
    return <span className="px-3 py-1 rounded-full text-sm font-medium bg-green-100 text-green-800">Connected</span>;
  }
  return <span className="px-3 py-1 rounded-full text-sm font-medium bg-gray-200 text-gray-700">Not connected</span>;
}

function HttpsBadge({ data }: { data: NetbirdView | undefined }) {
  if (!data) return null;
  const h = data.https;
  const s = h.status;
  if (!h.enabled) return <span className="px-3 py-1 rounded-full text-sm font-medium bg-gray-200 text-gray-700">Off</span>;
  if (!s) return <span className="px-3 py-1 rounded-full text-sm font-medium bg-yellow-100 text-yellow-800">Caddy container missing</span>;
  if (s.running && s.certificate) return <span className="px-3 py-1 rounded-full text-sm font-medium bg-green-100 text-green-800">Running</span>;
  if (s.running) return <span className="px-3 py-1 rounded-full text-sm font-medium bg-blue-100 text-blue-800">Getting certificate</span>;
  return <span className="px-3 py-1 rounded-full text-sm font-medium bg-yellow-100 text-yellow-800">Waiting</span>;
}

function Switch({ on, set, disabled, label }: { on: boolean; set: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <label className="flex items-center gap-3 cursor-pointer select-none">
      <button
        type="button" role="switch" aria-checked={on} disabled={disabled}
        onClick={() => set(!on)}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${on ? 'bg-blue-600' : 'bg-gray-300'} disabled:opacity-50`}
      >
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${on ? 'translate-x-6' : 'translate-x-1'}`} />
      </button>
      <span className="text-sm text-gray-700">{label}</span>
    </label>
  );
}

const inputCls = 'w-full px-3 py-2 border border-gray-300 rounded-lg font-mono text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent';

/** NetBird + HTTPS + Advanced. Settings page, tab "NetBird" (/dashboard/config/#netbird). */
export function NetbirdPanel() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['netbird'], queryFn: () => api.netbird(), refetchInterval: 10000 });

  const [setupKey, setSetupKey] = useState('');
  const [hostname, setHostname] = useState('fantom');
  const [managementUrl, setManagementUrl] = useState('https://api.netbird.io:443');
  const [wireguardPort, setWireguardPort] = useState('0');
  const [externalIpMap, setExternalIpMap] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [httpsOn, setHttpsOn] = useState(false);
  const [domain, setDomain] = useState('');
  const [cfToken, setCfToken] = useState('');
  const [email, setEmail] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const fill = (v: NetbirdView) => {
    setHostname(v.hostname); setManagementUrl(v.managementUrl); setEnabled(v.enabled);
    setWireguardPort(String(v.wireguardPort ?? 0)); setExternalIpMap(v.externalIpMap ?? '');
    setHttpsOn(v.https.enabled); setDomain(v.https.domain); setEmail(v.https.email);
  };

  // Fill the form once from the server.
  useEffect(() => {
    if (q.data && !loaded) { fill(q.data); setLoaded(true); }
  }, [q.data, loaded]);

  const onDone = (v: NetbirdView) => {
    queryClient.setQueryData(['netbird'], v);
    fill(v);
    setSetupKey(''); setCfToken(''); setError(null); setSaved(true);
  };
  const onFail = (err: Error) => { setError(err.message); setSaved(false); };

  const save = useMutation({
    mutationFn: () => {
      const port = Number(wireguardPort.trim() || '0');
      const body: NetbirdUpdate = {
        ...(setupKey.trim() ? { setupKey: setupKey.trim() } : {}),
        hostname: hostname.trim(), managementUrl: managementUrl.trim(), enabled,
        wireguardPort: port, externalIpMap: externalIpMap.trim(),
        https: {
          enabled: httpsOn, domain: domain.trim(), email: email.trim(),
          ...(cfToken.trim() ? { cloudflareToken: cfToken.trim() } : {}),
        },
      };
      return api.netbirdSave(body);
    },
    onSuccess: onDone,
    onError: onFail,
  });
  const removeKey = useMutation({ mutationFn: () => api.netbirdRemoveKey(), onSuccess: onDone, onError: onFail });
  const removeToken = useMutation({ mutationFn: () => api.netbirdRemoveToken(), onSuccess: onDone, onError: onFail });

  const d = q.data;
  const st = d?.status;
  const hs = d?.https.status;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Network className="w-8 h-8 text-blue-600" />
          <div>
            <h2 className="text-lg font-semibold text-gray-900">NetBird</h2>
            <p className="text-sm text-gray-500">Join this server to the NetBird network and serve it over HTTPS</p>
          </div>
        </div>
        <button
          onClick={() => q.refetch()}
          className="flex items-center gap-2 px-4 py-2 text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 rounded-lg"
        >
          <RefreshCw className={`w-4 h-4 ${q.isFetching ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {/* Status */}
      <div className="bg-white rounded-lg shadow p-4 mb-6 space-y-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <span className="font-medium text-gray-900 w-16">NetBird</span>
          <Badge data={d} />
          {st?.connected && (
            <>
              <span className="text-gray-600">Name: <b className="font-mono">{st.fqdn ?? '—'}</b></span>
              <span className="text-gray-600">NetBird IP: <b className="font-mono">{st.ip ?? '—'}</b></span>
              <span className="text-gray-600">Peers: {st.peersConnected} / {st.peersTotal}</span>
            </>
          )}
          {st?.updatedAt && <span className="text-gray-500">Checked: {new Date(st.updatedAt).toLocaleString()}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <span className="font-medium text-gray-900 w-16">HTTPS</span>
          <HttpsBadge data={d} />
          {d?.https.enabled && <span className="text-gray-600">Address: <b className="font-mono">{d.https.address}</b></span>}
          {hs?.certificate && (
            <span className="text-gray-600">
              Certificate: <b className="font-mono">{hs.certificate.names.join(', ') || '—'}</b>
              {hs.certificate.notAfter && <> · expires {new Date(hs.certificate.notAfter).toLocaleDateString()}</>}
            </span>
          )}
        </div>
        {d?.https.enabled && hs?.error && (
          <div className="flex items-center gap-2 p-3 bg-yellow-50 border border-yellow-200 text-yellow-800 rounded-lg text-sm">
            <AlertCircle className="w-4 h-4 shrink-0" /> <span className="break-all">Last error: {hs.error}</span>
          </div>
        )}
        {d && !d.configured && (
          <div className="flex items-center gap-2 p-3 bg-yellow-50 border border-yellow-200 text-yellow-800 rounded-lg text-sm">
            <AlertCircle className="w-4 h-4" />
            NetBird container not configured. You can still save the settings; they apply when the container runs.
          </div>
        )}
        {q.error && (
          <div className="flex items-center gap-2 p-3 bg-red-50 text-red-700 rounded-lg text-sm">
            <AlertCircle className="w-4 h-4" /> {(q.error as Error).message}
          </div>
        )}
      </div>

      {/* Settings */}
      <form
        onSubmit={(e) => { e.preventDefault(); setSaved(false); save.mutate(); }}
        className="bg-white rounded-lg shadow p-6 space-y-4"
      >
        <p className="text-sm text-gray-600">
          Make a setup key in the NetBird admin (Setup Keys), paste it here, then Save.
          The service will appear as <b className="font-mono">{hostname || 'fantom'}</b> in your NetBird network.
        </p>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Setup key</label>
          <input
            type="password" value={setupKey} onChange={(e) => setSetupKey(e.target.value)} disabled={!isAdmin}
            autoComplete="off" className={inputCls}
            placeholder={d?.hasKey ? 'Leave empty to keep the saved key' : 'Paste the setup key'}
          />
          <p className="text-xs text-gray-500 mt-1">
            {d?.hasKey ? `Key saved, ends in ${d.keyHint}` : 'No key saved'}
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Hostname</label>
          <input
            type="text" value={hostname} onChange={(e) => setHostname(e.target.value)} disabled={!isAdmin} required
            className={inputCls} placeholder="fantom"
          />
          <p className="text-xs text-gray-500 mt-1">Lowercase letters, digits and &quot;-&quot;. Up to 63 characters.</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Management URL</label>
          <input
            type="url" value={managementUrl} onChange={(e) => setManagementUrl(e.target.value)} disabled={!isAdmin} required
            className={inputCls} placeholder="https://netbird.example.com:443"
          />
        </div>

        <Switch on={enabled} set={setEnabled} disabled={!isAdmin} label="Enable NetBird" />

        {/* HTTPS */}
        <div className="pt-4 border-t border-gray-200 space-y-4">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900"><Lock className="w-5 h-5" /> HTTPS</h2>
          <p className="text-sm text-gray-600">
            Serves this server as <b className="font-mono">https://{hostname || 'fantom'}.{domain || 'example.com'}</b> on
            the NetBird IP. The certificate comes from Let&apos;s Encrypt; Caddy proves the name with a Cloudflare DNS record.
          </p>
          <Switch on={httpsOn} set={setHttpsOn} disabled={!isAdmin} label="Enable HTTPS" />
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Domain</label>
            <input
              type="text" value={domain} onChange={(e) => setDomain(e.target.value)} disabled={!isAdmin}
              className={inputCls} placeholder="example.com"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Cloudflare API token</label>
            <input
              type="password" value={cfToken} onChange={(e) => setCfToken(e.target.value)} disabled={!isAdmin}
              autoComplete="off" className={inputCls}
              placeholder={d?.https.hasToken ? 'Leave empty to keep the saved token' : 'Paste the token'}
            />
            <p className="text-xs text-gray-500 mt-1">
              {d?.https.hasToken ? `Token saved, ends in ${d.https.tokenHint}` : 'No token saved'}.
              Make it in Cloudflare with the &quot;Edit zone DNS&quot; template, for your domain&apos;s zone only.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email (optional)</label>
            <input
              type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={!isAdmin}
              className={inputCls} placeholder="Let's Encrypt account email"
            />
          </div>
        </div>

        {/* Advanced */}
        <details className="pt-4 border-t border-gray-200">
          <summary className="cursor-pointer text-sm font-medium text-gray-700">Advanced</summary>
          <div className="mt-3">
            <label className="block text-sm font-medium text-gray-700 mb-1">WireGuard port</label>
            <input
              type="number" min={0} max={65535} value={wireguardPort} onChange={(e) => setWireguardPort(e.target.value)}
              disabled={!isAdmin} className={inputCls}
            />
            <p className="text-xs text-gray-500 mt-1">0 = NetBird picks a free port. Set a fixed port to forward it on the firewall (UDP) for direct peer-to-peer links.</p>
          </div>
          <div className="mt-3">
            <label className="block text-sm font-medium text-gray-700 mb-1">Advertised public IP (optional)</label>
            <input
              type="text" value={externalIpMap} onChange={(e) => setExternalIpMap(e.target.value)}
              disabled={!isAdmin} className={inputCls} placeholder="203.0.113.10"
            />
            <p className="text-xs text-gray-500 mt-1">The public IP that forwards the WireGuard port (UDP) to this host. Peers then connect here directly instead of through the relay. Empty = not set. Passed as netbird up --external-ip-map.</p>
          </div>
        </details>

        {error && (
          <div className="flex items-center gap-2 p-3 bg-red-50 text-red-700 rounded-lg text-sm">
            <AlertCircle className="w-4 h-4" /> {error}
          </div>
        )}
        {saved && !error && (
          <div className="flex items-center gap-2 p-3 bg-green-50 text-green-700 rounded-lg text-sm">
            <Check className="w-4 h-4" /> Saved. The containers pick up the change in about 10 seconds.
          </div>
        )}

        {isAdmin ? (
          <div className="flex flex-wrap justify-end gap-3 pt-2">
            <button
              type="button" disabled={!d?.https.hasToken || removeToken.isPending}
              onClick={() => { if (confirm('Remove the Cloudflare token?')) { setSaved(false); removeToken.mutate(); } }}
              className="flex items-center gap-2 px-4 py-2 text-red-700 bg-white border border-red-300 hover:bg-red-50 rounded-lg disabled:opacity-50"
            >
              {removeToken.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              Remove token
            </button>
            <button
              type="button" disabled={!d?.hasKey || removeKey.isPending}
              onClick={() => { if (confirm('Remove the setup key and turn NetBird off?')) { setSaved(false); removeKey.mutate(); } }}
              className="flex items-center gap-2 px-4 py-2 text-red-700 bg-white border border-red-300 hover:bg-red-50 rounded-lg disabled:opacity-50"
            >
              {removeKey.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              Remove key
            </button>
            <button
              type="submit" disabled={save.isPending}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg"
            >
              {save.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              Save
            </button>
          </div>
        ) : (
          <p className="text-sm text-gray-500">Only admins can change these settings.</p>
        )}
      </form>
    </div>
  );
}
