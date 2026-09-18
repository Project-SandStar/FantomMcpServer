'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { getApiBase } from '../../lib/api';
import {
  Key,
  Monitor,
  Globe,
  Clock,
  Trash2,
  RefreshCw,
  AlertCircle,
  Loader2,
  Shield,
  Laptop,
  XCircle,
} from 'lucide-react';

// ============================================
// Types
// ============================================

interface OAuthSession {
  id: string;
  sessionId: string;
  clientId: string;
  clientName: string | null;
  userId: string | null;
  scope: string | null;
  createdAt: string;
  lastActivity: string;
  userAgent: string | null;
  ipAddress: string | null;
}

interface OAuthClient {
  client_id: string;
  client_secret?: string;
  client_name?: string;
  redirect_uris: string[];
  scope?: string;
  client_id_issued_at?: number;
}

// ============================================
// API Functions
// ============================================

interface McpLiveSession {
  sessionId: string;
  clientName: string | null;
  clientVersion: string | null;
  userId: string | null;
  createdAt: string;
  lastActivity: string;
}

async function fetchMcpSessions(authHeader: string): Promise<{ count: number; idleTimeoutMs: number; sessions: McpLiveSession[] }> {
  const response = await fetch(`${getApiBase()}/admin/mcp/sessions`, {
    headers: { Authorization: authHeader },
  });
  if (!response.ok) throw new Error('Failed to fetch MCP sessions');
  return response.json();
}

async function fetchSessions(authHeader: string): Promise<{ sessions: OAuthSession[] }> {
  const response = await fetch(`${getApiBase()}/admin/oauth/sessions`, {
    headers: { Authorization: authHeader },
  });
  if (!response.ok) {
    if (response.status === 503) {
      return { sessions: [] };
    }
    throw new Error('Failed to fetch sessions');
  }
  return response.json();
}

async function fetchClients(authHeader: string): Promise<{ clients: OAuthClient[] }> {
  const response = await fetch(`${getApiBase()}/admin/oauth/clients`, {
    headers: { Authorization: authHeader },
  });
  if (!response.ok) {
    if (response.status === 503) {
      return { clients: [] };
    }
    throw new Error('Failed to fetch clients');
  }
  return response.json();
}

async function revokeSession(authHeader: string, sessionId: string): Promise<void> {
  const response = await fetch(`${getApiBase()}/admin/oauth/sessions/${sessionId}`, {
    method: 'DELETE',
    headers: { Authorization: authHeader },
  });
  if (!response.ok) throw new Error('Failed to revoke session');
}

async function deleteClient(authHeader: string, clientId: string): Promise<void> {
  const response = await fetch(`${getApiBase()}/admin/oauth/clients/${clientId}`, {
    method: 'DELETE',
    headers: { Authorization: authHeader },
  });
  if (!response.ok) throw new Error('Failed to delete client');
}

// ============================================
// Helper Functions
// ============================================

function parseUserAgent(ua: string | null): { browser: string; os: string } {
  if (!ua) return { browser: 'Unknown', os: 'Unknown' };

  let browser = 'Unknown';
  let os = 'Unknown';

  // Detect browser
  if (ua.includes('Chrome')) browser = 'Chrome';
  else if (ua.includes('Firefox')) browser = 'Firefox';
  else if (ua.includes('Safari')) browser = 'Safari';
  else if (ua.includes('Edge')) browser = 'Edge';
  else if (ua.includes('Opera')) browser = 'Opera';

  // Detect OS
  if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Mac')) os = 'macOS';
  else if (ua.includes('Linux')) os = 'Linux';
  else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
  else if (ua.includes('Android')) os = 'Android';

  return { browser, os };
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

// ============================================
// Components
// ============================================

function SessionRow({
  session,
  onRevoke,
  isRevoking,
}: {
  session: OAuthSession;
  onRevoke: () => void;
  isRevoking: boolean;
}) {
  const { browser, os } = parseUserAgent(session.userAgent);

  return (
    <tr className="border-b border-gray-200 hover:bg-gray-50">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <Laptop className="w-4 h-4 text-gray-500" />
          <div>
            <div className="font-medium text-gray-900">
              {session.clientName || session.clientId.substring(0, 8)}...
            </div>
            <div className="text-xs text-gray-500">
              {browser} on {os}
            </div>
          </div>
        </div>
      </td>
      <td className="px-4 py-3 text-sm text-gray-600">
        {session.userId || 'N/A'}
      </td>
      <td className="px-4 py-3 text-sm text-gray-500">
        {session.scope || 'No scopes'}
      </td>
      <td className="px-4 py-3 text-sm text-gray-500">
        <div className="flex items-center gap-1">
          <Globe className="w-3 h-3" />
          {session.ipAddress || 'Unknown'}
        </div>
      </td>
      <td className="px-4 py-3 text-sm text-gray-500">
        <div className="flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {formatRelativeTime(session.lastActivity)}
        </div>
      </td>
      <td className="px-4 py-3">
        <button
          onClick={onRevoke}
          disabled={isRevoking}
          className="p-1 text-gray-500 hover:text-red-600 transition-colors disabled:opacity-50"
          title="Revoke session"
        >
          {isRevoking ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <XCircle className="w-4 h-4" />
          )}
        </button>
      </td>
    </tr>
  );
}

function ClientRow({
  client,
  onDelete,
  isDeleting,
}: {
  client: OAuthClient;
  onDelete: () => void;
  isDeleting: boolean;
}) {
  return (
    <tr className="border-b border-gray-200 hover:bg-gray-50">
      <td className="px-4 py-3">
        <div>
          <div className="font-medium text-gray-900">
            {client.client_name || 'Unnamed Client'}
          </div>
          <div className="text-xs text-gray-500 font-mono">
            {client.client_id.substring(0, 12)}...
          </div>
        </div>
      </td>
      <td className="px-4 py-3 text-sm">
        <div className="max-w-xs truncate text-gray-500">
          {client.redirect_uris.join(', ')}
        </div>
      </td>
      <td className="px-4 py-3 text-sm text-gray-500">
        {client.scope || 'All scopes'}
      </td>
      <td className="px-4 py-3 text-sm text-gray-500">
        {client.client_id_issued_at
          ? new Date(client.client_id_issued_at * 1000).toLocaleDateString()
          : 'N/A'}
      </td>
      <td className="px-4 py-3">
        <button
          onClick={onDelete}
          disabled={isDeleting}
          className="p-1 text-gray-500 hover:text-red-600 transition-colors disabled:opacity-50"
          title="Delete client"
        >
          {isDeleting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Trash2 className="w-4 h-4" />
          )}
        </button>
      </td>
    </tr>
  );
}

// ============================================
// Main Page
// ============================================

export default function SessionsPage() {
  const { role, getAuthHeader } = useAuth();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<'sessions' | 'clients'>('sessions');
  const isAdmin = role === 'admin';

  const {
    data: sessionsData,
    isLoading: sessionsLoading,
    error: sessionsError,
    refetch: refetchSessions,
  } = useQuery({
    queryKey: ['oauth-sessions'],
    queryFn: () => fetchSessions(getAuthHeader()),
    enabled: isAdmin,
    refetchInterval: 30000, // Auto-refresh every 30 seconds
  });

  const {
    data: clientsData,
    isLoading: clientsLoading,
    error: clientsError,
    refetch: refetchClients,
  } = useQuery({
    queryKey: ['oauth-clients'],
    queryFn: () => fetchClients(getAuthHeader()),
    enabled: isAdmin,
  });

  const { data: mcpData } = useQuery({
    queryKey: ['mcp-live-sessions'],
    queryFn: () => fetchMcpSessions(getAuthHeader()),
    enabled: isAdmin,
    refetchInterval: 15000,
  });

  const [revokingSession, setRevokingSession] = useState<string | null>(null);
  const [deletingClient, setDeletingClient] = useState<string | null>(null);

  const revokeSessionMutation = useMutation({
    mutationFn: (sessionId: string) => {
      setRevokingSession(sessionId);
      return revokeSession(getAuthHeader(), sessionId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['oauth-sessions'] });
      setRevokingSession(null);
    },
    onError: () => {
      setRevokingSession(null);
    },
  });

  const deleteClientMutation = useMutation({
    mutationFn: (clientId: string) => {
      setDeletingClient(clientId);
      return deleteClient(getAuthHeader(), clientId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['oauth-clients'] });
      queryClient.invalidateQueries({ queryKey: ['oauth-sessions'] });
      setDeletingClient(null);
    },
    onError: () => {
      setDeletingClient(null);
    },
  });

  if (!isAdmin) {
    return (
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <Key className="w-8 h-8 text-blue-600" />
          <h1 className="text-2xl font-bold text-gray-900">Sessions &amp; OAuth Grants</h1>
        </div>
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6">
          <div className="flex items-center gap-2 text-yellow-700">
            <AlertCircle className="w-5 h-5" />
            <span>Admin access required to view sessions and manage OAuth grants</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Key className="w-8 h-8 text-blue-600" />
          <h1 className="text-2xl font-bold text-gray-900">OAuth Management</h1>
        </div>
        <button
          onClick={() => {
            refetchSessions();
            refetchClients();
          }}
          className="flex items-center gap-2 px-3 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </div>

      {/* Tab Navigation */}
      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setActiveTab('sessions')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
            activeTab === 'sessions'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          <Monitor className="w-4 h-4" />
          Active Sessions
          {sessionsData?.sessions && (
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${
              activeTab === 'sessions'
                ? 'bg-blue-500 text-white'
                : 'bg-gray-200 text-gray-600'
            }`}>
              {sessionsData.sessions.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('clients')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
            activeTab === 'clients'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          <Shield className="w-4 h-4" />
          Registered Clients
          {clientsData?.clients && (
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${
              activeTab === 'clients'
                ? 'bg-blue-500 text-white'
                : 'bg-gray-200 text-gray-600'
            }`}>
              {clientsData.clients.length}
            </span>
          )}
        </button>
      </div>

      {/* Live MCP connections (in-memory transport sessions, one per connected client) */}
      {activeTab === 'sessions' && (
        <div className="bg-white rounded-lg shadow overflow-hidden mb-6">
          <div className="px-6 py-4 border-b border-gray-200">
            <h3 className="text-lg font-semibold text-gray-900">
              Live MCP Connections{mcpData ? ` (${mcpData.count})` : ''}
            </h3>
            <p className="text-sm text-gray-500">
              One session per connected client (each Claude Code window, subagent, or app). Idle sessions are
              reaped after {mcpData ? Math.round(mcpData.idleTimeoutMs / 3600000) : 24}h. Reset on server restart.
            </p>
          </div>
          {!mcpData || mcpData.sessions.length === 0 ? (
            <div className="px-6 py-6 text-sm text-gray-500">No MCP client is currently connected.</div>
          ) : (
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-2 text-left text-xs font-medium text-gray-500 uppercase">Client</th>
                  <th className="px-6 py-2 text-left text-xs font-medium text-gray-500 uppercase">User</th>
                  <th className="px-6 py-2 text-left text-xs font-medium text-gray-500 uppercase">Connected</th>
                  <th className="px-6 py-2 text-left text-xs font-medium text-gray-500 uppercase">Last activity</th>
                  <th className="px-6 py-2 text-left text-xs font-medium text-gray-500 uppercase">Session</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {mcpData.sessions.map(s => (
                  <tr key={s.sessionId}>
                    <td className="px-6 py-2 text-sm text-gray-900">{s.clientName ?? 'unknown'}{s.clientVersion ? ` ${s.clientVersion}` : ''}</td>
                    <td className="px-6 py-2 text-sm text-gray-700">{s.userId ?? '—'}</td>
                    <td className="px-6 py-2 text-sm text-gray-700">{new Date(s.createdAt).toLocaleString()}</td>
                    <td className="px-6 py-2 text-sm text-gray-700">{new Date(s.lastActivity).toLocaleString()}</td>
                    <td className="px-6 py-2 text-xs font-mono text-gray-500">{s.sessionId.slice(0, 8)}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* OAuth grants (persisted; one row per client + user with a live token) */}
      {activeTab === 'sessions' && (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h3 className="text-lg font-semibold text-gray-900">OAuth Grants</h3>
            <p className="text-sm text-gray-500">
              Token grants with a live access or refresh token, one per client and user. These are not connections;
              see Live MCP Connections above. Revoking a grant invalidates that client&apos;s tokens.
            </p>
          </div>

          {sessionsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
            </div>
          ) : sessionsError ? (
            <div className="flex items-center gap-2 p-6 text-red-600">
              <AlertCircle className="w-5 h-5" />
              <span>Failed to load sessions. OAuth may not be enabled.</span>
            </div>
          ) : sessionsData?.sessions.length === 0 ? (
            <div className="p-12 text-center text-gray-500">
              <Monitor className="w-12 h-12 mx-auto mb-4 text-gray-300" />
              <p>No active OAuth sessions</p>
              <p className="text-sm">OAuth sessions will appear here when clients authenticate</p>
            </div>
          ) : (
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">
                    Client
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">
                    User
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">
                    Scope
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">
                    IP
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">
                    Last Active
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {sessionsData?.sessions.map((session) => (
                  <SessionRow
                    key={session.sessionId}
                    session={session}
                    onRevoke={() => revokeSessionMutation.mutate(session.sessionId)}
                    isRevoking={revokingSession === session.sessionId}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Clients Tab */}
      {activeTab === 'clients' && (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h3 className="text-lg font-semibold text-gray-900">Registered OAuth Clients</h3>
            <p className="text-sm text-gray-500">
              Applications that have registered for OAuth access
            </p>
          </div>

          {clientsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
            </div>
          ) : clientsError ? (
            <div className="flex items-center gap-2 p-6 text-red-600">
              <AlertCircle className="w-5 h-5" />
              <span>Failed to load clients. OAuth may not be enabled.</span>
            </div>
          ) : clientsData?.clients.length === 0 ? (
            <div className="p-12 text-center text-gray-500">
              <Shield className="w-12 h-12 mx-auto mb-4 text-gray-300" />
              <p>No registered OAuth clients</p>
              <p className="text-sm">Clients can register via the /register endpoint</p>
            </div>
          ) : (
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">
                    Client
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">
                    Redirect URIs
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">
                    Scope
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">
                    Registered
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {clientsData?.clients.map((client) => (
                  <ClientRow
                    key={client.client_id}
                    client={client}
                    onDelete={() => {
                      if (confirm(`Delete client "${client.client_name || client.client_id}"? This will revoke all associated sessions.`)) {
                        deleteClientMutation.mutate(client.client_id);
                      }
                    }}
                    isDeleting={deletingClient === client.client_id}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
