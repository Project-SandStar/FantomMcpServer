'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getApiBase } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';

interface DocFile {
  name: string;
  path: string;
  label: string;
}

interface ServerInfo {
  serverPath: string;
  port: number;
}

// Base path must match next.config.ts basePath for static file fetching
const BASE_PATH = '/dashboard';

const DOC_FILES: DocFile[] = [
  { name: 'index', path: `${BASE_PATH}/docs/index.md`, label: 'Overview' },
  { name: 'setup', path: `${BASE_PATH}/docs/setup.md`, label: 'Setup Guide' },
  { name: 'installation', path: `${BASE_PATH}/docs/installation.md`, label: 'Installation' },
  { name: 'sidecars', path: `${BASE_PATH}/docs/sidecars.md`, label: 'Sidecars (GPU)' },
  { name: 'tool-status', path: `${BASE_PATH}/docs/tool-status.md`, label: 'Tool Status' },
  { name: 'documentation', path: `${BASE_PATH}/docs/documentation.md`, label: 'Documentation Tools' },
  { name: 'code-analysis', path: `${BASE_PATH}/docs/code-analysis.md`, label: 'Code Analysis' },
  { name: 'code-generation', path: `${BASE_PATH}/docs/code-generation.md`, label: 'Code Generation' },
  { name: 'project-management', path: `${BASE_PATH}/docs/project-management.md`, label: 'Project Management' },
  { name: 'analytics', path: `${BASE_PATH}/docs/analytics.md`, label: 'Analytics' },
  { name: 'explorer', path: `${BASE_PATH}/docs/explorer.md`, label: 'Explorer' },
  { name: 'core-tools', path: `${BASE_PATH}/docs/core-tools.md`, label: 'Core Tools' },
  { name: 'llmIntegration', path: `${BASE_PATH}/docs/llmIntegration.md`, label: 'LLM Integration' },
  { name: 'axon-integration', path: `${BASE_PATH}/docs/axon-integration.md`, label: 'Axon Integration' },
];

// Loading fallback for Suspense
function DocumentationLoading() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-gray-500">Loading documentation...</div>
    </div>
  );
}

// Main page wrapper with Suspense boundary
export default function DocumentationPage() {
  return (
    <Suspense fallback={<DocumentationLoading />}>
      <DocumentationContent />
    </Suspense>
  );
}

// Inner component that uses useSearchParams
function DocumentationContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const docParam = searchParams.get('doc');
  const { isLoading: authLoading, getAuthHeader } = useAuth();

  // Initialize from URL or default to 'index'
  const [selectedDoc, setSelectedDoc] = useState<string>(docParam || 'index');
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);

  // Fetch server info when auth is ready to get dynamic path and port
  useEffect(() => {
    // Wait for auth to finish loading before fetching server info
    if (authLoading) return;

    const fetchServerInfo = async () => {
      try {
        // Use auth context's credentials
        const authHeader = getAuthHeader();

        const response = await fetch(`${getApiBase()}/admin/status`, {
          headers: authHeader ? { 'Authorization': authHeader } : {},
        });
        if (response.ok) {
          const data = await response.json();
          setServerInfo({
            serverPath: data.serverPath || '/path/to/mcpfantom/build/index.js',
            port: data.port || 3847,
          });
        } else {
          // Use window.location.port as fallback for port
          const currentPort = window.location.port ? parseInt(window.location.port) : 3847;
          setServerInfo({
            serverPath: '/path/to/mcpfantom/build/index.js',
            port: currentPort,
          });
        }
      } catch {
        // Use window.location.port as fallback for port
        const currentPort = window.location.port ? parseInt(window.location.port) : 3847;
        setServerInfo({
          serverPath: '/path/to/mcpfantom/build/index.js',
          port: currentPort,
        });
      }
    };
    fetchServerInfo();
  }, [authLoading, getAuthHeader]);

  // Sync URL param to state on mount/change
  useEffect(() => {
    if (docParam && docParam !== selectedDoc) {
      const validDoc = DOC_FILES.find(d => d.name === docParam);
      if (validDoc) {
        setSelectedDoc(docParam);
      }
    }
  }, [docParam, selectedDoc]);

  // Handle document selection - update URL
  // Note: router.push automatically prepends basePath, so don't include it here
  const handleSelectDoc = (docName: string) => {
    setSelectedDoc(docName);
    const url = docName === 'index'
      ? '/documentation/'
      : `/documentation/?doc=${docName}`;
    router.push(url);
  };

  // Replace placeholders in content with actual server values
  const processContent = (text: string): string => {
    if (!serverInfo) return text;
    // Extract directory from serverPath (remove /build/index.js)
    const serverDir = serverInfo.serverPath.replace(/\/build\/index\.js$/, '');
    return text
      .replace(/\{\{SERVER_PATH\}\}/g, serverInfo.serverPath)
      .replace(/\{\{SERVER_DIR\}\}/g, serverDir)
      .replace(/\{\{PORT\}\}/g, String(serverInfo.port));
  };

  useEffect(() => {
    const loadDoc = async () => {
      setLoading(true);
      setError(null);

      const docFile = DOC_FILES.find(d => d.name === selectedDoc);
      if (!docFile) {
        setError('Document not found');
        setLoading(false);
        return;
      }

      try {
        const response = await fetch(docFile.path);
        if (!response.ok) {
          throw new Error(`Failed to load: ${response.status}`);
        }
        const text = await response.text();
        setContent(text);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load document');
      } finally {
        setLoading(false);
      }
    };

    loadDoc();
  }, [selectedDoc]);

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="w-64 bg-white border-r border-gray-200 p-4 overflow-y-auto">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Documentation</h2>
        <nav className="space-y-1">
          {DOC_FILES.map((doc) => (
            <button
              key={doc.name}
              onClick={() => handleSelectDoc(doc.name)}
              className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                selectedDoc === doc.name
                  ? 'bg-blue-100 text-blue-700 font-medium'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              {doc.label}
            </button>
          ))}
        </nav>

        <div className="mt-8 pt-4 border-t border-gray-200">
          <h3 className="text-sm font-medium text-gray-700 mb-2">Quick Links</h3>
          <div className="space-y-1">
            <a
              href={`${BASE_PATH}/explorer/`}
              className="block px-3 py-2 text-sm text-blue-600 hover:bg-blue-50 rounded-md"
            >
              → MCP Explorer
            </a>
            <a
              href={`${BASE_PATH}/docs/`}
              className="block px-3 py-2 text-sm text-blue-600 hover:bg-blue-50 rounded-md"
            >
              → Docs Explorer
            </a>
            <a
              href={`${BASE_PATH}/cache/`}
              className="block px-3 py-2 text-sm text-blue-600 hover:bg-blue-50 rounded-md"
            >
              → Cache Status
            </a>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-8">
        {loading || authLoading || !serverInfo ? (
          <div className="flex items-center justify-center h-64">
            <div className="text-gray-500">Loading documentation...</div>
          </div>
        ) : error ? (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <h2 className="text-red-800 font-medium">Error loading documentation</h2>
            <p className="text-red-600 mt-1">{error}</p>
          </div>
        ) : (
          <article className="prose prose-slate max-w-none prose-headings:font-semibold prose-h1:text-3xl prose-h2:text-2xl prose-h3:text-xl prose-code:bg-gray-100 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-gray-800 prose-pre:bg-gray-900 prose-pre:text-gray-100 prose-pre:overflow-x-auto [&_pre_code]:bg-transparent [&_pre_code]:text-gray-100 [&_pre_code]:p-0 prose-table:border prose-th:bg-gray-100 prose-th:p-2 prose-td:p-2 prose-td:border">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {processContent(content)}
            </ReactMarkdown>
          </article>
        )}
      </div>
    </div>
  );
}
