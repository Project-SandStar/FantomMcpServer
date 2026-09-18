'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, CacheInfo, FantomSettings, UsageDatabaseInfo, FantomVersion, CodeStats, OAuthSettings, ModelStatusResponse, EmbeddingModelStatus, ModelStatusListResponse, BackfillLadybugResult, getApiBase, setApiBase, fetchDashboardSettings, saveDashboardSettings, downloadEmbeddingModel } from '@/lib/api';
import { SidecarsPanel } from '@/components/config/SidecarsPanel';
import { LLMProvidersPanel } from '@/components/config/LLMProvidersPanel';
import { OpenRouterPanel } from '@/components/config/OpenRouterPanel';
import { SidecarEmbeddingPicker } from '@/components/config/SidecarEmbeddingPicker';
import { AdvancedSearchPanel } from '@/components/config/AdvancedSearchPanel';
import { RunFromSidecarToggle } from '@/components/config/RunFromSidecarToggle';
import { DebugLogPanel } from '@/components/config/DebugLogPanel';

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let unitIndex = 0;
  let value = bytes;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

// ─── Settings Groups ────────────────────────────────────────────────────

type SettingsGroup =
  | 'connection'
  | 'server'
  | 'oauth'
  | 'cache'
  | 'storage'
  | 'search'
  | 'semantic'
  | 'sidecars'
  | 'openrouter'
  | 'llm-providers'
  | 'fantom-source'
  | 'code-index'
  | 'usage-db'
  | 'debug';

const GROUPS: { id: SettingsGroup; label: string; icon: string }[] = [
  { id: 'connection', label: 'Connection', icon: '🔗' },
  { id: 'server', label: 'Server', icon: '⚙' },
  { id: 'oauth', label: 'OAuth 2.1', icon: '🔐' },
  { id: 'cache', label: 'Cache', icon: '📦' },
  { id: 'storage', label: 'Storage', icon: '💾' },
  { id: 'search', label: 'Keyword Search', icon: '🔍' },
  { id: 'semantic', label: 'Semantic Search', icon: '🧠' },
  { id: 'sidecars', label: 'Sidecars', icon: '🛰' },
  { id: 'openrouter', label: 'OpenRouter', icon: '☁' },
  { id: 'llm-providers', label: 'LLM Providers', icon: '🤖' },
  { id: 'fantom-source', label: 'Fantom Source', icon: '📁' },
  { id: 'code-index', label: 'Code Index', icon: '🗂' },
  { id: 'usage-db', label: 'Usage Database', icon: '📊' },
  { id: 'debug', label: 'Debug', icon: '🐛' },
];

// ─── Documentation Content ──────────────────────────────────────────────

const DOCS: Record<SettingsGroup, { title: string; content: React.ReactNode }> = {
  connection: {
    title: 'Server Connection',
    content: (
      <div className="space-y-3 text-sm text-gray-600">
        <p>Configure the MCP server URL that the dashboard connects to.</p>
        <div className="bg-gray-50 p-3 rounded-md space-y-2">
          <p className="font-medium text-gray-700">Server URL</p>
          <p>Leave empty when the dashboard is served from the same server. Set to a URL like <code className="bg-gray-100 px-1 rounded text-xs">http://localhost:3848</code> when running the dashboard separately (e.g., <code className="text-xs">npm run dashboard:dev</code>).</p>
          <p>This setting is persisted server-side and synced across browser sessions.</p>
        </div>
      </div>
    ),
  },
  server: {
    title: 'Server Configuration',
    content: (
      <div className="space-y-3 text-sm text-gray-600">
        <p>Core server settings that affect how the MCP server operates.</p>
        <div className="bg-gray-50 p-3 rounded-md space-y-2">
          <p className="font-medium text-gray-700">Port</p>
          <p>The HTTP port the MCP server listens on. Changing this requires a server restart.</p>
          <p className="text-xs text-gray-500">Set via <code className="bg-gray-100 px-1 rounded">MCP_PORT</code> environment variable or config file.</p>
          <p className="text-xs text-gray-500">Called in: <code className="bg-gray-100 px-1 rounded">src/index.ts:startHttpServer()</code></p>
        </div>
      </div>
    ),
  },
  oauth: {
    title: 'OAuth 2.1 Authentication',
    content: (
      <div className="space-y-3 text-sm text-gray-600">
        <p>OAuth 2.1 with PKCE secures MCP tool access. When enabled, clients must authenticate before calling MCP tools.</p>
        <div className="bg-gray-50 p-3 rounded-md space-y-2">
          <p className="font-medium text-gray-700">Access Token TTL</p>
          <p>How long an access token remains valid. Shorter = more secure, but clients must refresh more often.</p>
          <p className="text-xs text-gray-500">Called in: <code className="bg-gray-100 px-1 rounded">src/auth/oauthProvider.ts:generateAccessToken()</code></p>
        </div>
        <div className="bg-gray-50 p-3 rounded-md space-y-2">
          <p className="font-medium text-gray-700">Refresh Token TTL</p>
          <p>How long a refresh token remains valid. After expiry, clients must re-authenticate from scratch.</p>
          <p className="text-xs text-gray-500">Called in: <code className="bg-gray-100 px-1 rounded">src/auth/oauthProvider.ts:generateRefreshToken()</code></p>
        </div>
        <div className="bg-gray-50 p-3 rounded-md space-y-2">
          <p className="font-medium text-gray-700">Auth Code TTL</p>
          <p>How long the one-time authorization code is valid during the OAuth login flow. Usually short (5-10 minutes).</p>
        </div>
        <div className="bg-amber-50 border border-amber-200 p-3 rounded-md">
          <p className="text-amber-800 text-xs">Changes to OAuth settings require a server restart to take effect.</p>
        </div>
      </div>
    ),
  },
  cache: {
    title: 'Cache Settings',
    content: (
      <div className="space-y-3 text-sm text-gray-600">
        <p>Controls how parsed documentation is cached to disk for faster startup.</p>
        <div className="bg-gray-50 p-3 rounded-md space-y-2">
          <p className="font-medium text-gray-700">Enable Caching</p>
          <p>When enabled, parsed documentation is saved to <code className="bg-gray-100 px-1 rounded text-xs">.cache/flexsearch-*.json</code> files. Disabling forces fresh parsing on every startup.</p>
          <p className="text-xs text-gray-500">Called in: <code className="bg-gray-100 px-1 rounded">src/cache/index.ts:CacheManager.load()</code></p>
        </div>
        <div className="bg-gray-50 p-3 rounded-md space-y-2">
          <p className="font-medium text-gray-700">Max Age</p>
          <p>How long cached data is considered valid before it expires and needs re-parsing.</p>
        </div>
      </div>
    ),
  },
  search: {
    title: 'Keyword Search Settings',
    content: (
      <div className="space-y-3 text-sm text-gray-600">
        <p>Controls the FlexSearch-based keyword search used by <code className="bg-gray-100 px-1 rounded text-xs">searchFantomCode</code> and <code className="bg-gray-100 px-1 rounded text-xs">searchLocalDocs</code> MCP tools.</p>
        <div className="bg-gray-50 p-3 rounded-md space-y-2">
          <p className="font-medium text-gray-700">Max Results</p>
          <p>Maximum number of results returned per keyword search query. Higher values return more results but increase response size.</p>
          <p className="text-xs text-gray-500">Called in: <code className="bg-gray-100 px-1 rounded">src/search/index.ts:SearchIndex.search()</code></p>
        </div>
        <div className="bg-gray-50 p-3 rounded-md space-y-2">
          <p className="font-medium text-gray-700">Min Score</p>
          <p>Minimum relevance score (0-1) for a result to be included. Higher values filter out less relevant matches. FlexSearch uses forward tokenization with BM25 ranking.</p>
          <p className="text-xs text-gray-500">Called in: <code className="bg-gray-100 px-1 rounded">src/search/index.ts:SearchIndex.search()</code></p>
        </div>
      </div>
    ),
  },
  semantic: {
    title: 'Semantic Code Search (AI)',
    content: (
      <div className="space-y-3 text-sm text-gray-600">
        <p>Controls the LanceDB-powered vector search used by the <code className="bg-gray-100 px-1 rounded text-xs">semanticCodeSearch</code> and <code className="bg-gray-100 px-1 rounded text-xs">findSimilarCode</code> MCP tools.</p>
        <p>Unlike keyword search, semantic search understands meaning. A query like &quot;functions that handle HTTP requests&quot; finds relevant code even without exact keyword matches.</p>
        <div className="bg-blue-50 border border-blue-200 p-3 rounded-md text-blue-800 text-xs">
          <strong>How it works:</strong> Each function in the code index has a vector embedding generated by an AI model. Queries are also embedded, and results are ranked by cosine similarity between embeddings, combined with a graph importance score.
        </div>
        <div className="bg-gray-50 p-3 rounded-md space-y-2">
          <p className="font-medium text-gray-700">Minimum Score</p>
          <p>The minimum cosine similarity (0.0-1.0) between the query embedding and a code embedding for a result to be included. Higher values return fewer but more relevant results.</p>
          <ul className="text-xs space-y-1 ml-3">
            <li><strong>0.3</strong> — Very permissive, many loose matches</li>
            <li><strong>0.5</strong> — Balanced (default), filters noise while keeping relevant results</li>
            <li><strong>0.7</strong> — Strict, only highly similar code</li>
            <li><strong>0.9</strong> — Near-exact semantic match only</li>
          </ul>
          <p className="text-xs text-gray-500">Called in: <code className="bg-gray-100 px-1 rounded">src/embedding/semanticSearchService.ts:search()</code></p>
          <p className="text-xs text-gray-500">Passed to: <code className="bg-gray-100 px-1 rounded">VectorStore.search(queryEmbedding, &#123;minScore&#125;)</code></p>
        </div>
        <div className="bg-gray-50 p-3 rounded-md space-y-2">
          <p className="font-medium text-gray-700">Graph Weight</p>
          <p>How much the graph importance score influences final ranking (0.0-1.0). The final score is:</p>
          <p className="font-mono text-xs bg-white p-2 rounded border">combined = semantic * (1 - graphWeight) + graph * graphWeight</p>
          <p>Graph score is based on how many callers a function has — heavily-called functions rank higher.</p>
          <ul className="text-xs space-y-1 ml-3">
            <li><strong>0.0</strong> — Pure vector similarity, ignore graph structure</li>
            <li><strong>0.3</strong> — Default. Slight boost for well-connected code</li>
            <li><strong>0.5</strong> — Equal weight between similarity and graph importance</li>
            <li><strong>1.0</strong> — Rank entirely by graph importance (not recommended)</li>
          </ul>
          <p className="text-xs text-gray-500">Called in: <code className="bg-gray-100 px-1 rounded">src/embedding/semanticSearchService.ts:search()</code></p>
          <p className="text-xs text-gray-500">Formula: <code className="bg-gray-100 px-1 rounded">graphScore = min(1.0, 0.3 + 0.3 * log10(callerCount + 1))</code></p>
        </div>
        <div className="bg-gray-50 p-3 rounded-md space-y-2">
          <p className="font-medium text-gray-700">Default Limit</p>
          <p>Default number of results returned when the MCP client doesn&apos;t specify a limit. Can be overridden per-query via the <code className="bg-gray-100 px-1 rounded text-xs">limit</code> parameter.</p>
          <p className="text-xs text-gray-500">Called in: <code className="bg-gray-100 px-1 rounded">src/index.ts:handleCallTool(&apos;semanticCodeSearch&apos;)</code></p>
        </div>
        <div className="bg-gray-50 p-3 rounded-md space-y-2">
          <p className="font-medium text-gray-700">Include Graph Context</p>
          <p>When enabled, each result includes lists of callers, callees, and related nodes. This provides richer context but increases response size and query time.</p>
          <p className="text-xs text-gray-500">Called in: <code className="bg-gray-100 px-1 rounded">src/embedding/semanticSearchService.ts:enrichResult()</code></p>
          <p className="text-xs text-gray-500">Adds: <code className="bg-gray-100 px-1 rounded">callerCount, calleeCount, relatedNodes[]</code> to each result</p>
        </div>
      </div>
    ),
  },
  sidecars: {
    title: 'Sidecars',
    content: (
      <div className="space-y-3 text-sm text-gray-600">
        <p>Register external sidecar services by IP/hostname. Sidecars off-load embeddings, LLM rerank, or other compute to a remote machine.</p>
        <div className="bg-gray-50 p-3 rounded-md space-y-2">
          <p className="font-medium text-gray-700">Types</p>
          <p><code className="bg-gray-100 px-1 rounded text-xs">embedding</code> &mdash; Ollama-compatible <code>/api/embed</code></p>
          <p><code className="bg-gray-100 px-1 rounded text-xs">llm</code> &mdash; chat / rerank LLM</p>
          <p><code className="bg-gray-100 px-1 rounded text-xs">reranker</code> &mdash; cross-encoder rerank service</p>
          <p className="text-xs text-gray-500">First enabled sidecar of each type wins. Disable to fall back to in-process.</p>
        </div>
      </div>
    ),
  },
  openrouter: {
    title: 'OpenRouter',
    content: (
      <div className="space-y-3 text-sm text-gray-600">
        <p>
          Routes a role to OpenRouter through a sidecar, so cloud capacity joins the fan-out as another
          provider. Off by default: while it is off nothing calls out and every role stays local.
        </p>
        <div className="bg-gray-50 p-3 rounded-md space-y-2">
          <p className="font-medium text-gray-700">The key never reaches Fantom&apos;s disk</p>
          <p>It is pushed to the sidecars, which hold it in memory and spend it. Fantom stores only the last four characters, so the field can say which key is configured.</p>
          <p className="text-xs text-gray-500">A sidecar restart clears its copy &mdash; use Re-push.</p>
        </div>
        <div className="bg-gray-50 p-3 rounded-md space-y-2">
          <p className="font-medium text-gray-700">Embedding is gated, reranking is not</p>
          <p>A cloud embedder must match the table width exactly and pass a cosine check against a local provider before it may serve one text. Reranking is stateless, so it needs no gate and is local-first with OpenRouter as fallback.</p>
        </div>
        <div className="bg-gray-50 p-3 rounded-md space-y-2">
          <p className="font-medium text-gray-700">One key, one limit</p>
          <p>Every sidecar gets the same key and OpenRouter limits per key, so the call ceiling is global rather than per provider. A 429 halves it and backs off; a clean window ramps it back.</p>
        </div>
      </div>
    ),
  },
  'llm-providers': {
    title: 'LLM Providers',
    content: (
      <div className="space-y-3 text-sm text-gray-600">
        <p>API keys for LLM-augmented semantic search. Keys are stored in <code className="bg-gray-100 px-1 rounded text-xs">.env</code> and masked on read.</p>
        <div className="bg-gray-50 p-3 rounded-md space-y-2">
          <p className="font-medium text-gray-700">Providers</p>
          <p>Groq, Anthropic Claude, Google Gemini.</p>
          <p>Pick a default; the semantic-search reranker calls it when enabled.</p>
        </div>
      </div>
    ),
  },
  'fantom-source': {
    title: 'Fantom Source Folder',
    content: (
      <div className="space-y-3 text-sm text-gray-600">
        <p>Path to a directory containing Fantom SDK installations (e.g., fantom-1.0.80, fantom-1.0.82).</p>
        <div className="bg-gray-50 p-3 rounded-md space-y-2">
          <p className="font-medium text-gray-700">Source Folder Path</p>
          <p>Each Fantom version in this directory that contains a <code className="bg-gray-100 px-1 rounded text-xs">src/</code> subfolder will be available for source-level documentation and code indexing.</p>
          <p className="text-xs text-gray-500">Called in: <code className="bg-gray-100 px-1 rounded">src/index.ts:detectFantomVersions()</code></p>
        </div>
      </div>
    ),
  },
  'code-index': {
    title: 'Code Index',
    content: (
      <div className="space-y-3 text-sm text-gray-600">
        <p>The code index powers the <code className="bg-gray-100 px-1 rounded text-xs">searchFantomCode</code> and <code className="bg-gray-100 px-1 rounded text-xs">getFantomFunction</code> MCP tools.</p>
        <div className="bg-gray-50 p-3 rounded-md space-y-2">
          <p className="font-medium text-gray-700">Rebuild Index</p>
          <p>Re-parses all registered projects using Tree-sitter, rebuilds the FlexSearch index, and updates the SQLite database. This can take several minutes for large codebases.</p>
          <p className="text-xs text-gray-500">Called in: <code className="bg-gray-100 px-1 rounded">src/fantom-code/indexer.ts:reindexAll()</code></p>
        </div>
        <div className="bg-gray-50 p-3 rounded-md space-y-2">
          <p className="font-medium text-gray-700">LadybugDB Backfill</p>
          <p>One-way migration step that copies every project&apos;s code graph from SQLite/Prisma into LadybugDB. Required once before reads are flipped to Ladybug as the authoritative graph store. Each project is cleared in Ladybug before re-inserting, so re-running is safe and idempotent.</p>
          <p className="text-xs text-gray-500">Endpoint: <code className="bg-gray-100 px-1 rounded">POST /admin/graph/backfill-ladybug?projectId=all</code></p>
        </div>
      </div>
    ),
  },
  storage: {
    title: 'Storage Overview',
    content: (
      <div className="space-y-3 text-sm text-gray-600">
        <p>All databases and cache files stored in the <code className="bg-gray-100 px-1 rounded text-xs">.cache/</code> directory.</p>
        <div className="bg-gray-50 p-3 rounded-md space-y-2">
          <p className="font-medium text-gray-700">LanceDB (Vector Store)</p>
          <p>Stores embedding vectors for semantic code search. Contains 384-dimensional vectors generated by the embedding model.</p>
        </div>
        <div className="bg-gray-50 p-3 rounded-md space-y-2">
          <p className="font-medium text-gray-700">SQLite Databases</p>
          <p>Main database (code nodes, edges, projects) and usage tracking database.</p>
        </div>
        <div className="bg-gray-50 p-3 rounded-md space-y-2">
          <p className="font-medium text-gray-700">JSON Caches</p>
          <p>FlexSearch indexes for keyword-based documentation search.</p>
        </div>
      </div>
    ),
  },
  'usage-db': {
    title: 'Usage Database',
    content: (
      <div className="space-y-3 text-sm text-gray-600">
        <p>SQLite database that tracks tool calls, search queries, and session activity for analytics.</p>
        <div className="bg-gray-50 p-3 rounded-md space-y-2">
          <p className="font-medium text-gray-700">Clear All Data</p>
          <p>Deletes all usage records but keeps the database structure intact.</p>
        </div>
        <div className="bg-gray-50 p-3 rounded-md space-y-2">
          <p className="font-medium text-gray-700">Delete &amp; Reset Database</p>
          <p>Completely deletes and recreates the database file. Use this if the database is corrupted.</p>
          <p className="text-xs text-gray-500">Location: <code className="bg-gray-100 px-1 rounded">.cache/usage.db</code></p>
        </div>
      </div>
    ),
  },
  debug: {
    title: 'Debug',
    content: (
      <div className="space-y-3 text-sm text-gray-600">
        <p>Live tail of the on-disk server log at <code className="bg-gray-100 px-1 rounded">logs/_crash.log</code> (per-segment files appear under the same <code className="bg-gray-100 px-1 rounded">logs/</code> directory when their tag is enabled).</p>
        <p>When debug is enabled, the viewer streams new lines as they appear and you can filter them with the search box.</p>
        <p>Use the Download button to grab the full log file as text — useful for sharing crash traces.</p>
      </div>
    ),
  },
};

// ─── Embedding Model Options ─────────────────────────────────────────────

interface EmbeddingModelOption {
  id: string;
  name: string;
  dimensions: number;
  size: string;
  description: string;
}

const CODE_MODELS: EmbeddingModelOption[] = [
  // Ollama-library models ship with the pooling metadata Ollama ≥0.3x needs for
  // the embedding capability, so they run on every sidecar (incl. host Ollama on
  // macOS) without a re-pack. Switching the model = full re-embed at the new
  // dimension (built into a shadow table, swapped in when complete).
  { id: 'qwen3-embedding:4b', name: 'qwen3-embedding:4b', dimensions: 2560, size: '~2.5 GB (sidecar)', description: 'Recommended. Code-trained, multilingual, 32K ctx, top open model on code retrieval. Needs ≥3.5 GB role budget.' },
  { id: 'qwen3-embedding:0.6b', name: 'qwen3-embedding:0.6b', dimensions: 1024, size: '~640 MB (sidecar)', description: 'Fast and small; same family as 4b with lower quality. Fits a 2 GB role budget.' },
  { id: 'qwen3-embedding:8b', name: 'qwen3-embedding:8b', dimensions: 4096, size: '~4.7 GB (sidecar)', description: 'Highest quality of the family; 4096d vectors (2.7× the storage of 1536d). GPU hosts only.' },
  { id: 'hf.co/jinaai/jina-code-embeddings-1.5b-GGUF:Q8_0', name: 'jina-code-embeddings-1.5b', dimensions: 1536, size: '~1.6 GB (sidecar)', description: 'Code-specialized (jina-code). GGUF lacks pooling_type: Ollama ≥0.3x refuses it (Macs) unless re-packed — see docs/reports. Works on Ollama 0.24.' },
  { id: 'Xenova/bge-small-en-v1.5', name: 'bge-small-en-v1.5', dimensions: 384, size: '~33 MB', description: 'Fast, lightweight code search (default)' },
  { id: 'Xenova/all-MiniLM-L6-v2', name: 'all-MiniLM-L6-v2', dimensions: 384, size: '~23 MB', description: 'General purpose, very fast' },
  { id: 'Xenova/bge-base-en-v1.5', name: 'bge-base-en-v1.5', dimensions: 768, size: '~110 MB', description: 'Higher quality, more memory' },
  { id: 'Xenova/gte-small', name: 'gte-small', dimensions: 384, size: '~33 MB', description: 'Good alternative for code' },
];

const DOCS_MODELS: EmbeddingModelOption[] = [
  { id: 'qwen3-embedding:0.6b', name: 'qwen3-embedding:0.6b', dimensions: 1024, size: '~640 MB (sidecar)', description: 'Multilingual, 32K ctx — requires embedding sidecar (current default)' },
  { id: 'qwen3-embedding:4b', name: 'qwen3-embedding:4b', dimensions: 2560, size: '~2.5 GB (sidecar)', description: 'Higher quality docs retrieval; same model as the code search pick, so one model serves both roles' },
  { id: 'qwen3-embedding:8b', name: 'qwen3-embedding:8b', dimensions: 4096, size: '~4.7 GB (sidecar)', description: 'Highest quality; large vectors, GPU hosts only' },
  { id: 'Xenova/jina-embeddings-v2-base-en', name: 'jina-embeddings-v2-base-en', dimensions: 768, size: '~137 MB', description: '8K context, ideal for long docs (default)' },
  { id: 'Xenova/bge-base-en-v1.5', name: 'bge-base-en-v1.5', dimensions: 768, size: '~110 MB', description: 'Strong retrieval, 512 token context' },
  { id: 'Xenova/bge-small-en-v1.5', name: 'bge-small-en-v1.5', dimensions: 384, size: '~33 MB', description: 'Lighter, shorter context' },
  { id: 'Xenova/all-MiniLM-L6-v2', name: 'all-MiniLM-L6-v2', dimensions: 384, size: '~23 MB', description: 'Fastest, basic quality' },
];

// ─── Main Component ─────────────────────────────────────────────────────

export default function ConfigPage() {
  const queryClient = useQueryClient();
  const [formData, setFormData] = useState<FantomSettings | null>(null);
  const [saveStatus, setSaveStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [fantomSourceFolder, setFantomSourceFolder] = useState('');
  const [fantomFolderInput, setFantomFolderInput] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [serverUrlInput, setServerUrlInput] = useState('');
  const [serverUrlSynced, setServerUrlSynced] = useState(false);
  const [activeGroup, setActiveGroupState] = useState<SettingsGroup>('connection');
  const [tabUrl, setTabUrl] = useState('');
  const validGroups = GROUPS.map(g => g.id);
  const setActiveGroup = (id: SettingsGroup) => {
    setActiveGroupState(id);
    if (typeof window !== 'undefined') {
      if (window.location.hash !== `#${id}`) history.pushState(null, '', `#${id}`);
      setTabUrl(`${window.location.origin}${window.location.pathname}#${id}`);
    }
  };
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sync = () => {
      const h = window.location.hash.replace(/^#/, '') as SettingsGroup;
      const next = (h && validGroups.includes(h)) ? h : 'connection';
      setActiveGroupState(next);
      setTabUrl(`${window.location.origin}${window.location.pathname}#${next}`);
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initialize server URL from localStorage, then sync with server
  useEffect(() => {
    const localUrl = getApiBase();
    setServerUrl(localUrl);
    setServerUrlInput(localUrl || 'http://localhost:3848');

    const syncWithServer = async () => {
      try {
        const serverSettings = await fetchDashboardSettings();
        if (serverSettings.serverUrl) {
          if (serverSettings.serverUrl !== localUrl) {
            setApiBase(serverSettings.serverUrl);
            setServerUrl(serverSettings.serverUrl);
            setServerUrlInput(serverSettings.serverUrl);
          }
          setServerUrlSynced(true);
        } else if (localUrl) {
          await saveDashboardSettings({ serverUrl: localUrl });
          setServerUrlSynced(true);
        }
      } catch {
        console.log('[Config] Could not sync with server, using localStorage only');
      }
    };

    syncWithServer();
  }, []);

  // Fetch all data
  const { data: settings, isLoading, error } = useQuery({
    queryKey: ['settings'],
    queryFn: api.getSettings,
  });
  const { data: dbInfo } = useQuery({ queryKey: ['usage-database'], queryFn: api.getUsageDatabase, retry: false });
  const { data: fantomFolderData } = useQuery({ queryKey: ['fantom-source-folder'], queryFn: api.getFantomSourceFolder, retry: false });
  const { data: fantomVersionsData } = useQuery({ queryKey: ['fantom-versions'], queryFn: api.getFantomVersions, retry: false });
  const { data: codeStats, isLoading: codeStatsLoading } = useQuery({ queryKey: ['code-stats'], queryFn: api.getCodeStats, retry: false });
  const { data: oauthSettings, isLoading: oauthLoading } = useQuery({ queryKey: ['oauth-settings'], queryFn: api.getOAuthSettings, retry: false });
  const { data: storageData, isLoading: storageLoading } = useQuery({ queryKey: ['storage'], queryFn: api.getCaches, retry: false });
  const { data: modelStatus } = useQuery<ModelStatusResponse>({ queryKey: ['model-status'], queryFn: api.getModelStatus, retry: false });
  const { data: embeddingModelStatuses } = useQuery<ModelStatusListResponse>({ queryKey: ['embedding-model-statuses'], queryFn: api.getEmbeddingModelStatuses, retry: false });

  // Download state: { modelId -> { progress, file } }
  const [downloadingModels, setDownloadingModels] = useState<Record<string, { progress: number; file: string }>>({});

  const handleDownloadModel = async (modelId: string) => {
    setDownloadingModels(prev => ({ ...prev, [modelId]: { progress: 0, file: 'initializing...' } }));
    try {
      await downloadEmbeddingModel(modelId, (data) => {
        if (data.status === 'downloading') {
          setDownloadingModels(prev => ({
            ...prev,
            [modelId]: { progress: data.progress ?? 0, file: data.file || '' },
          }));
        }
      });
      // Download complete - refresh statuses
      queryClient.invalidateQueries({ queryKey: ['embedding-model-statuses'] });
    } catch {
      // error already shown via progress
    } finally {
      setDownloadingModels(prev => {
        const next = { ...prev };
        delete next[modelId];
        return next;
      });
    }
  };

  // Mutations
  const updateMutation = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      setSaveStatus({ type: 'success', message: 'Settings saved successfully' });
      setTimeout(() => setSaveStatus(null), 3000);
    },
    onError: (err) => {
      setSaveStatus({ type: 'error', message: err instanceof Error ? err.message : 'Failed to save settings' });
    },
  });

  const clearUsageMutation = useMutation({
    mutationFn: api.clearUsageData,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['usage-database'] });
      setSaveStatus({ type: 'success', message: 'Usage data cleared' });
      setTimeout(() => setSaveStatus(null), 3000);
    },
  });

  const resetDbMutation = useMutation({
    mutationFn: api.resetUsageDatabase,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['usage-database'] });
      setSaveStatus({ type: 'success', message: 'Database reset successfully' });
      setTimeout(() => setSaveStatus(null), 3000);
    },
  });

  const setFantomFolderMutation = useMutation({
    mutationFn: api.setFantomSourceFolder,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fantom-source-folder'] });
      queryClient.invalidateQueries({ queryKey: ['fantom-versions'] });
      setSaveStatus({ type: 'success', message: 'Fantom source folder updated' });
      setTimeout(() => setSaveStatus(null), 3000);
    },
    onError: (err) => {
      setSaveStatus({ type: 'error', message: err instanceof Error ? err.message : 'Failed to set Fantom source folder' });
    },
  });

  const reindexCodeMutation = useMutation({
    mutationFn: api.reindexCode,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['code-stats'] });
      setSaveStatus({ type: 'success', message: `Reindex complete: ${result.projectsEnabled} projects, ${result.indexedFunctions} functions` });
      setTimeout(() => setSaveStatus(null), 5000);
    },
    onError: (err) => {
      setSaveStatus({ type: 'error', message: err instanceof Error ? err.message : 'Failed to reindex code' });
    },
  });

  const rebuildGraphMutation = useMutation({
    mutationFn: api.rebuildGraphs,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['code-stats'] });
      setSaveStatus({ type: 'success', message: `Graph rebuilt: ${result.projects} projects, ${result.totalNodes} nodes, ${result.totalEdges} edges, ${result.resolved} cross-refs resolved` });
      setTimeout(() => setSaveStatus(null), 5000);
    },
    onError: (err) => {
      setSaveStatus({ type: 'error', message: err instanceof Error ? err.message : 'Failed to rebuild graph' });
    },
  });

  const [backfillResult, setBackfillResult] = useState<BackfillLadybugResult | null>(null);
  const backfillLadybugMutation = useMutation({
    mutationFn: (dryRun: boolean) => api.backfillLadybug({ projectId: 'all', dryRun }),
    onSuccess: (result) => {
      setBackfillResult(result);
      const t = result.totals;
      const prefix = result.dryRun ? 'Dry-run' : 'Backfilled';
      setSaveStatus({
        type: 'success',
        message: `${prefix}: ${result.projectCount} projects, ${t.ladybugNodesCreated}/${t.prismaNodes} nodes, ${t.ladybugEdgesCreated}/${t.prismaEdges} edges${t.failed ? ` — ${t.failed} failed` : ''}`
      });
      setTimeout(() => setSaveStatus(null), 8000);
    },
    onError: (err) => {
      setSaveStatus({ type: 'error', message: err instanceof Error ? err.message : 'Backfill failed' });
    },
  });

  // Background re-embed job — starts the loop server-side, then polls progress.
  const [reembedJobId, setReembedJobId] = useState<string | null>(null);

  const reEmbedMutation = useMutation({
    mutationFn: () => api.startReembedJob(0, 50),
    onSuccess: (result) => {
      setReembedJobId(result.jobId);
      setSaveStatus({ type: 'success', message: `Re-embed started (job ${result.jobId.slice(0, 8)}…). Progress below.` });
    },
    onError: (err) => {
      setSaveStatus({ type: 'error', message: err instanceof Error ? err.message : 'Failed to start re-embed' });
    },
  });

  const { data: reembedJob } = useQuery({
    queryKey: ['reembed-job', reembedJobId],
    queryFn: () => reembedJobId ? api.getReembedJob(reembedJobId) : Promise.resolve(null),
    enabled: !!reembedJobId,
    refetchInterval: (q) => {
      const j = q.state.data as { status: string } | null | undefined;
      if (!j) return 2000;
      return (j.status === 'running' || j.status === 'queued') ? 2000 : false;
    },
  });

  // When a job completes, refresh model status / vector stats.
  useEffect(() => {
    if (reembedJob && (reembedJob.status === 'done' || reembedJob.status === 'cancelled' || reembedJob.status === 'error')) {
      queryClient.invalidateQueries({ queryKey: ['model-status'] });
      queryClient.invalidateQueries({ queryKey: ['vector-stats'] });
    }
  }, [reembedJob?.status, queryClient]);

  const cancelReembedMutation = useMutation({
    mutationFn: (jobId: string) => api.cancelReembedJob(jobId),
    onSuccess: () => setSaveStatus({ type: 'success', message: 'Cancel requested.' }),
  });

  const oauthMutation = useMutation({
    mutationFn: (enabled: boolean) => api.setOAuthEnabled(enabled),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['oauth-settings'] });
      setSaveStatus({ type: 'success', message: result.message });
      setTimeout(() => setSaveStatus(null), 5000);
    },
    onError: (err) => {
      setSaveStatus({ type: 'error', message: err instanceof Error ? err.message : 'Failed to update OAuth settings' });
    },
  });

  // Initialize form data
  useEffect(() => {
    if (settings) {
      setFormData({
        ...settings,
        semanticSearch: {
          ...settings.semanticSearch,
          minScore: settings.semanticSearch?.minScore ?? 0.5,
          graphWeight: settings.semanticSearch?.graphWeight ?? 0.3,
          defaultLimit: settings.semanticSearch?.defaultLimit ?? 10,
          includeGraphContext: settings.semanticSearch?.includeGraphContext ?? true,
          embeddingModel: settings.semanticSearch?.embeddingModel,
          embeddingDimensions: settings.semanticSearch?.embeddingDimensions,
          codeModel: settings.semanticSearch?.codeModel,
          codeDimensions: settings.semanticSearch?.codeDimensions,
          docsModel: settings.semanticSearch?.docsModel,
          docsDimensions: settings.semanticSearch?.docsDimensions,
          embeddingThreads: settings.semanticSearch?.embeddingThreads ?? 2,
          embeddingBatchSize: settings.semanticSearch?.embeddingBatchSize ?? 16,
        },
        auth: {
          accessTokenTtl: settings.auth?.accessTokenTtl || 3600,
          refreshTokenTtl: settings.auth?.refreshTokenTtl || 2592000,
          authCodeTtl: settings.auth?.authCodeTtl || 600,
        },
      });
    }
  }, [settings]);

  useEffect(() => {
    if (fantomFolderData?.path) {
      setFantomSourceFolder(fantomFolderData.path);
      setFantomFolderInput(fantomFolderData.path);
    }
  }, [fantomFolderData]);

  const handleSave = () => {
    if (formData) {
      updateMutation.mutate(formData);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading settings...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <h2 className="text-red-800 font-medium">Failed to load settings</h2>
        <p className="text-red-600 mt-1">{error instanceof Error ? error.message : 'Unknown error'}</p>
      </div>
    );
  }

  if (!formData) return null;

  // ─── Input Helper ─────────────────────────────────────────────────────
  const inputClass = "w-full rounded-md border border-gray-300 py-2 px-3 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";
  const labelClass = "block text-sm font-medium text-gray-700 mb-1";
  const helpClass = "mt-1 text-xs text-gray-500";

  // ─── Render Settings Panel Content ────────────────────────────────────

  function renderSettingsContent() {
    if (!formData) return null;
    switch (activeGroup) {
      case 'connection':
        return (
          <div className="space-y-4">
            <div>
              <label className={labelClass}>Server URL</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={serverUrlInput}
                  onChange={(e) => setServerUrlInput(e.target.value)}
                  placeholder="http://localhost:3848"
                  className={`flex-1 font-mono ${inputClass}`}
                />
                <button
                  onClick={async () => {
                    setApiBase(serverUrlInput);
                    setServerUrl(serverUrlInput);
                    try {
                      await saveDashboardSettings({ serverUrl: serverUrlInput });
                      setServerUrlSynced(true);
                      setSaveStatus({ type: 'success', message: 'Server URL saved. Refresh the page to apply.' });
                    } catch {
                      setSaveStatus({ type: 'success', message: 'Saved to browser only (server sync failed). Refresh to apply.' });
                    }
                    setTimeout(() => setSaveStatus(null), 4000);
                  }}
                  disabled={serverUrlInput === serverUrl}
                  className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
                >
                  Save
                </button>
                {serverUrl && (
                  <button
                    onClick={async () => {
                      setApiBase('');
                      setServerUrl('');
                      setServerUrlInput('');
                      try { await saveDashboardSettings({ serverUrl: null }); } catch {}
                      setSaveStatus({ type: 'success', message: 'Server URL cleared. Refresh to apply.' });
                      setTimeout(() => setSaveStatus(null), 3000);
                    }}
                    className="px-4 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 transition-colors text-sm"
                  >
                    Clear
                  </button>
                )}
              </div>
              {serverUrl && (
                <p className={helpClass}>
                  Current: <code className="bg-gray-100 px-1 rounded">{serverUrl}</code>
                  {serverUrlSynced && <span className="ml-2 text-green-600">(synced)</span>}
                </p>
              )}
            </div>
          </div>
        );

      case 'server':
        return (
          <div className="space-y-4">
            <div>
              <label className={labelClass}>Port</label>
              <input
                type="number"
                value={formData.port}
                onChange={(e) => setFormData({ ...formData, port: parseInt(e.target.value) || 3848 })}
                className={`w-32 ${inputClass}`}
              />
              <p className={helpClass}>HTTP server port (requires restart)</p>
            </div>
            <div>
              <label className={labelClass}>Memory limit (MB)</label>
              <input
                type="number"
                min={0}
                value={formData.rssGuardMb ?? 4000}
                onChange={(e) => setFormData({ ...formData, rssGuardMb: parseInt(e.target.value) || 0 })}
                className={`w-32 ${inputClass}`}
              />
              <p className={helpClass}>
                RSS-guard threshold. Self-watchdog exits the process when RSS exceeds this so macOS Jetsam doesn&apos;t SIGKILL it blind. Set 0 to disable. Default <code className="bg-gray-100 px-1 rounded text-xs">4000</code>. Boot indexer holds ~2 GB heap with tree-sitter; allow 2× headroom. Takes effect on next restart. Override at runtime via <code className="bg-gray-100 px-1 rounded text-xs">FANTOM_RSS_GUARD_MB</code> env var.
              </p>
            </div>
          </div>
        );

      case 'oauth':
        return (
          <div className="space-y-6">
            {oauthLoading ? (
              <p className="text-gray-500">Loading...</p>
            ) : oauthSettings ? (
              <>
                {/* Status */}
                <div className="flex items-center gap-4">
                  <div className={`h-3 w-3 rounded-full ${oauthSettings.runtimeEnabled ? 'bg-green-500' : 'bg-gray-400'}`} />
                  <span className="text-sm font-medium text-gray-700">
                    Runtime: {oauthSettings.runtimeEnabled ? 'Enabled' : 'Disabled'}
                  </span>
                </div>

                {oauthSettings.requiresRestart && (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
                    Server restart required. Configured as <strong>{oauthSettings.configuredEnabled ? 'enabled' : 'disabled'}</strong> but running as <strong>{oauthSettings.runtimeEnabled ? 'enabled' : 'disabled'}</strong>.
                  </div>
                )}

                {/* Toggle */}
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => oauthMutation.mutate(!oauthSettings.runtimeEnabled && oauthSettings.configuredEnabled !== true ? true : !(oauthSettings.configuredEnabled ?? oauthSettings.runtimeEnabled))}
                    disabled={oauthMutation.isPending}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                      (oauthSettings.configuredEnabled ?? oauthSettings.runtimeEnabled) ? 'bg-blue-600' : 'bg-gray-200'
                    }`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      (oauthSettings.configuredEnabled ?? oauthSettings.runtimeEnabled) ? 'translate-x-6' : 'translate-x-1'
                    }`} />
                  </button>
                  <span className="text-sm text-gray-700">
                    {(oauthSettings.configuredEnabled ?? oauthSettings.runtimeEnabled) ? 'Enabled' : 'Disabled'}
                  </span>
                  {oauthMutation.isPending && <span className="text-xs text-gray-500">Saving...</span>}
                </div>

                {/* Token TTLs */}
                <div className="pt-4 border-t border-gray-200">
                  <h3 className="text-sm font-medium text-gray-900 mb-4">Token Lifetimes</h3>
                  <div className="grid grid-cols-1 gap-4">
                    <div>
                      <label className={labelClass}>Access Token TTL</label>
                      <div className="flex items-center gap-2">
                        <input type="number" min="5" step="5" value={Math.round((formData.auth?.accessTokenTtl || 3600) / 60)}
                          onChange={(e) => setFormData({ ...formData, auth: { ...formData.auth, accessTokenTtl: (parseInt(e.target.value) || 60) * 60, refreshTokenTtl: formData.auth?.refreshTokenTtl || 2592000, authCodeTtl: formData.auth?.authCodeTtl || 600 } })}
                          className={`w-24 ${inputClass}`} />
                        <span className="text-sm text-gray-500">minutes</span>
                      </div>
                      <p className={helpClass}>Default: 60 min</p>
                    </div>
                    <div>
                      <label className={labelClass}>Refresh Token TTL</label>
                      <div className="flex items-center gap-2">
                        <input type="number" min="1" value={Math.round((formData.auth?.refreshTokenTtl || 2592000) / 86400)}
                          onChange={(e) => setFormData({ ...formData, auth: { ...formData.auth, accessTokenTtl: formData.auth?.accessTokenTtl || 3600, refreshTokenTtl: (parseInt(e.target.value) || 30) * 86400, authCodeTtl: formData.auth?.authCodeTtl || 600 } })}
                          className={`w-24 ${inputClass}`} />
                        <span className="text-sm text-gray-500">days</span>
                      </div>
                      <p className={helpClass}>Default: 30 days</p>
                    </div>
                    <div>
                      <label className={labelClass}>Auth Code TTL</label>
                      <div className="flex items-center gap-2">
                        <input type="number" min="1" max="30" value={Math.round((formData.auth?.authCodeTtl || 600) / 60)}
                          onChange={(e) => setFormData({ ...formData, auth: { ...formData.auth, accessTokenTtl: formData.auth?.accessTokenTtl || 3600, refreshTokenTtl: formData.auth?.refreshTokenTtl || 2592000, authCodeTtl: (parseInt(e.target.value) || 10) * 60 } })}
                          className={`w-24 ${inputClass}`} />
                        <span className="text-sm text-gray-500">minutes</span>
                      </div>
                      <p className={helpClass}>Default: 10 min</p>
                    </div>
                  </div>
                </div>
              </>
            ) : <p className="text-gray-500">OAuth settings not available</p>}
          </div>
        );

      case 'cache':
        return (
          <div className="space-y-4">
            <div className="flex items-center">
              <input type="checkbox" id="cache-enabled" checked={formData.cache.enabled}
                onChange={(e) => setFormData({ ...formData, cache: { ...formData.cache, enabled: e.target.checked } })}
                className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
              <label htmlFor="cache-enabled" className="ml-2 text-sm text-gray-700">Enable Caching</label>
            </div>
            <div>
              <label className={labelClass}>Max Age (hours)</label>
              <input type="number" value={Math.round(formData.cache.maxAge / 3600000)}
                onChange={(e) => setFormData({ ...formData, cache: { ...formData.cache, maxAge: (parseFloat(e.target.value) || 0) * 3600000 } })}
                className={`w-32 ${inputClass}`} />
            </div>
          </div>
        );

      case 'storage':
        return (
          <div className="space-y-5">
            {storageLoading ? <p className="text-gray-500">Loading storage info...</p> : storageData && storageData.length > 0 ? (
              <>
                {/* Total size summary */}
                <div className="bg-gray-50 p-4 rounded-lg">
                  <p className="text-xs text-gray-500 uppercase tracking-wide">Total Storage</p>
                  <p className="text-2xl font-semibold text-gray-900 mt-1">{formatBytes(storageData.reduce((sum: number, c: CacheInfo) => sum + c.size, 0))}</p>
                  <p className="text-xs text-gray-500 mt-1">{storageData.length} items in .cache/</p>
                </div>

                {/* Storage entries grouped by type */}
                {(['lancedb', 'sqlite', 'json-cache'] as const).map(sType => {
                  const items = storageData.filter((c: CacheInfo) => c.storageType === sType);
                  if (items.length === 0) return null;
                  const typeLabel = sType === 'lancedb' ? 'Vector Database (LanceDB)' : sType === 'sqlite' ? 'SQLite Databases' : 'JSON Caches';
                  return (
                    <div key={sType}>
                      <h3 className="text-sm font-medium text-gray-900 mb-2">{typeLabel}</h3>
                      <div className="space-y-2">
                        {items.map((item: CacheInfo) => (
                          <div key={item.name} className="flex items-center justify-between bg-white border border-gray-200 rounded-lg px-4 py-3">
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-gray-900 font-mono truncate">{item.name}</p>
                              <p className="text-xs text-gray-500 mt-0.5">
                                Modified {new Date(item.lastModified).toLocaleString()}
                                {item.metadata?.itemCount ? ` \u00b7 ${item.metadata.itemCount.toLocaleString()} items` : ''}
                              </p>
                            </div>
                            <span className="text-sm font-medium text-gray-700 ml-4 flex-shrink-0">{formatBytes(item.size)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </>
            ) : <p className="text-gray-500">No storage data available</p>}
          </div>
        );

      case 'search':
        return (
          <div className="space-y-4">
            <div>
              <label className={labelClass}>Max Results</label>
              <input type="number" value={formData.searchSettings.maxResults}
                onChange={(e) => setFormData({ ...formData, searchSettings: { ...formData.searchSettings, maxResults: parseInt(e.target.value) || 0 } })}
                className={`w-32 ${inputClass}`} />
            </div>
            <div>
              <label className={labelClass}>Min Score (0-1)</label>
              <input type="number" step="0.05" min="0" max="1" value={formData.searchSettings.minScore}
                onChange={(e) => setFormData({ ...formData, searchSettings: { ...formData.searchSettings, minScore: parseFloat(e.target.value) || 0 } })}
                className={`w-32 ${inputClass}`} />
            </div>
          </div>
        );

      case 'semantic':
        return (
          <div className="space-y-5">
            <div>
              <label className={labelClass}>Minimum Score (0.0 - 1.0)</label>
              <input type="range" min="0" max="1" step="0.05" value={formData.semanticSearch.minScore}
                onChange={(e) => setFormData({ ...formData, semanticSearch: { ...formData.semanticSearch, minScore: parseFloat(e.target.value) } })}
                className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600" />
              <div className="flex justify-between mt-1">
                <span className="text-xs text-gray-400">0.0 (permissive)</span>
                <span className="text-sm font-medium text-blue-600">{formData.semanticSearch.minScore.toFixed(2)}</span>
                <span className="text-xs text-gray-400">1.0 (strict)</span>
              </div>
              <p className={helpClass}>Results with similarity below this threshold are filtered out</p>
            </div>

            <div>
              <label className={labelClass}>Graph Weight (0.0 - 1.0)</label>
              <input type="range" min="0" max="1" step="0.05" value={formData.semanticSearch.graphWeight}
                onChange={(e) => setFormData({ ...formData, semanticSearch: { ...formData.semanticSearch, graphWeight: parseFloat(e.target.value) } })}
                className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600" />
              <div className="flex justify-between mt-1">
                <span className="text-xs text-gray-400">0.0 (pure similarity)</span>
                <span className="text-sm font-medium text-blue-600">{formData.semanticSearch.graphWeight.toFixed(2)}</span>
                <span className="text-xs text-gray-400">1.0 (graph only)</span>
              </div>
              <p className={helpClass}>How much graph importance affects ranking</p>
            </div>

            <div>
              <label className={labelClass}>Default Limit</label>
              <input type="number" min="1" max="100" value={formData.semanticSearch.defaultLimit}
                onChange={(e) => setFormData({ ...formData, semanticSearch: { ...formData.semanticSearch, defaultLimit: parseInt(e.target.value) || 10 } })}
                className={`w-32 ${inputClass}`} />
              <p className={helpClass}>Max results when client doesn&apos;t specify a limit</p>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={() => setFormData({ ...formData, semanticSearch: { ...formData.semanticSearch, includeGraphContext: !formData.semanticSearch.includeGraphContext } })}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                  formData.semanticSearch.includeGraphContext ? 'bg-blue-600' : 'bg-gray-200'
                }`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  formData.semanticSearch.includeGraphContext ? 'translate-x-6' : 'translate-x-1'
                }`} />
              </button>
              <div>
                <span className="text-sm text-gray-700">Include Graph Context</span>
                <p className={helpClass}>Add caller/callee counts and related nodes to results</p>
              </div>
            </div>

            {/* Sidecar embedding models (live from registered sidecars) */}
            <SidecarEmbeddingPicker
              currentModel={formData.semanticSearch.codeModel || formData.semanticSearch.embeddingModel || ''}
              onPick={(model) => setFormData({ ...formData, semanticSearch: { ...formData.semanticSearch, codeModel: model } })}
            />

            {/* Advanced search: cross-encoder + LLM rerank */}
            <AdvancedSearchPanel formData={formData} setFormData={setFormData} />

            {/* Embedding Models */}
            <div className="pt-4 border-t border-gray-200">
              <h3 className="text-sm font-medium text-gray-900 mb-3">Embedding Models</h3>
              <div className="space-y-3">
                {/* Code Search Model */}
                <div className="bg-blue-50 border border-blue-100 p-3 rounded-lg">
                  <p className="text-xs font-medium text-blue-700 uppercase tracking-wide mb-2">Code Search</p>
                  <select
                    value={formData.semanticSearch.codeModel || formData.semanticSearch.embeddingModel || 'Xenova/bge-small-en-v1.5'}
                    onChange={(e) => {
                      const selected = CODE_MODELS.find(m => m.id === e.target.value);
                      if (selected) {
                        // Sidecar-served models (non-Xenova, e.g. qwen3 / jina-code) must
                        // force codeFromSidecar so routing is strict — otherwise an `auto`
                        // fallback to the 384d in-process Xenova model would corrupt the
                        // table when the sidecar blips. Xenova/* run in-process → false.
                        const fromSidecar = !selected.id.startsWith('Xenova/');
                        const nextSemantic = { ...formData.semanticSearch, codeModel: selected.id, codeDimensions: selected.dimensions, codeFromSidecar: fromSidecar };
                        setFormData({ ...formData, semanticSearch: nextSemantic });
                        // PERSIST IMMEDIATELY. Re-embed (and the auto-pipeline) read the
                        // SAVED runtime config via selectEmbeddingProvider('code'); without
                        // an immediate save the selection lived only in this page's local
                        // form state, so re-embedding kept using the previously-saved model
                        // (qwen3). Saving here (model + dimensions + routing together) makes
                        // the picked model take effect without a separate Save click.
                        updateMutation.mutate({ semanticSearch: nextSemantic } as any);
                      }
                    }}
                    className="w-full px-3 py-2 border border-blue-200 rounded-md bg-white text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    {CODE_MODELS.map(m => {
                      const ms = embeddingModelStatuses?.models?.find(s => s.modelId === m.id);
                      return (
                        <option key={m.id} value={m.id}>
                          {m.name} ({m.dimensions}d, {m.size}) - {m.description}{ms?.downloaded ? ' [downloaded]' : ''}
                        </option>
                      );
                    })}
                  </select>
                  {(() => {
                    const selectedCodeModel = formData.semanticSearch.codeModel || formData.semanticSearch.embeddingModel || 'Xenova/bge-small-en-v1.5';
                    if (formData.semanticSearch.codeFromSidecar) {
                      return (
                        <div className="mt-2 flex items-center gap-1.5 text-xs text-blue-700">
                          <span className="w-2 h-2 rounded-full bg-blue-500 inline-block" />
                          Routed to sidecar (no local download)
                        </div>
                      );
                    }
                    const dlState = downloadingModels[selectedCodeModel];
                    const ms = embeddingModelStatuses?.models?.find(s => s.modelId === selectedCodeModel);
                    if (dlState) {
                      return (
                        <div className="mt-2 space-y-1">
                          <div className="flex items-center gap-2 text-xs text-blue-700">
                            <span className="animate-spin inline-block w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full" />
                            <span className="truncate">Downloading {dlState.file}... {dlState.progress}%</span>
                          </div>
                          <div className="w-full bg-blue-200 rounded-full h-1.5">
                            <div className="bg-blue-600 h-1.5 rounded-full transition-all duration-300" style={{ width: `${dlState.progress}%` }} />
                          </div>
                        </div>
                      );
                    }
                    if (ms?.downloaded) {
                      return (
                        <div className="mt-2 flex items-center gap-1.5 text-xs text-green-700">
                          <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
                          Downloaded ({formatBytes(ms.sizeOnDisk)})
                        </div>
                      );
                    }
                    return (
                      <div className="mt-2 flex items-center gap-2 text-xs text-gray-500">
                        <span className="w-2 h-2 rounded-full bg-gray-300 inline-block" />
                        <span>Not downloaded</span>
                        <button
                          onClick={() => handleDownloadModel(selectedCodeModel)}
                          className="ml-1 px-2 py-0.5 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors text-xs font-medium"
                        >
                          Download
                        </button>
                      </div>
                    );
                  })()}
                  <RunFromSidecarToggle
                    accent="blue"
                    on={!!formData.semanticSearch.codeFromSidecar}
                    onChange={v => setFormData({ ...formData, semanticSearch: { ...formData.semanticSearch, codeFromSidecar: v } })}
                    hint="Embed via sidecar capability `embedding`"
                  />
                  <div className="flex justify-between mt-2 text-xs text-gray-500">
                    <span>Dimensions: {formData.semanticSearch.codeDimensions || formData.semanticSearch.embeddingDimensions || 384}</span>
                    <span>Table: code_vectors</span>
                  </div>
                </div>
                {/* Documentation Search Model */}
                <div className="bg-purple-50 border border-purple-100 p-3 rounded-lg">
                  <p className="text-xs font-medium text-purple-700 uppercase tracking-wide mb-2">Documentation Search</p>
                  <select
                    value={formData.semanticSearch.docsModel || 'Xenova/jina-embeddings-v2-base-en'}
                    onChange={(e) => {
                      const selected = DOCS_MODELS.find(m => m.id === e.target.value);
                      if (selected) {
                        setFormData({ ...formData, semanticSearch: { ...formData.semanticSearch, docsModel: selected.id, docsDimensions: selected.dimensions } });
                      }
                    }}
                    className="w-full px-3 py-2 border border-purple-200 rounded-md bg-white text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                  >
                    {DOCS_MODELS.map(m => {
                      const ms = embeddingModelStatuses?.models?.find(s => s.modelId === m.id);
                      return (
                        <option key={m.id} value={m.id}>
                          {m.name} ({m.dimensions}d, {m.size}) - {m.description}{ms?.downloaded ? ' [downloaded]' : ''}
                        </option>
                      );
                    })}
                  </select>
                  {(() => {
                    const selectedDocsModel = formData.semanticSearch.docsModel || 'Xenova/jina-embeddings-v2-base-en';
                    if (formData.semanticSearch.docsFromSidecar) {
                      return (
                        <div className="mt-2 flex items-center gap-1.5 text-xs text-purple-700">
                          <span className="w-2 h-2 rounded-full bg-purple-500 inline-block" />
                          Routed to sidecar (no local download)
                        </div>
                      );
                    }
                    const dlState = downloadingModels[selectedDocsModel];
                    const ms = embeddingModelStatuses?.models?.find(s => s.modelId === selectedDocsModel);
                    if (dlState) {
                      return (
                        <div className="mt-2 space-y-1">
                          <div className="flex items-center gap-2 text-xs text-purple-700">
                            <span className="animate-spin inline-block w-3 h-3 border-2 border-purple-400 border-t-transparent rounded-full" />
                            <span className="truncate">Downloading {dlState.file}... {dlState.progress}%</span>
                          </div>
                          <div className="w-full bg-purple-200 rounded-full h-1.5">
                            <div className="bg-purple-600 h-1.5 rounded-full transition-all duration-300" style={{ width: `${dlState.progress}%` }} />
                          </div>
                        </div>
                      );
                    }
                    if (ms?.downloaded) {
                      return (
                        <div className="mt-2 flex items-center gap-1.5 text-xs text-green-700">
                          <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
                          Downloaded ({formatBytes(ms.sizeOnDisk)})
                        </div>
                      );
                    }
                    return (
                      <div className="mt-2 flex items-center gap-2 text-xs text-gray-500">
                        <span className="w-2 h-2 rounded-full bg-gray-300 inline-block" />
                        <span>Not downloaded</span>
                        <button
                          onClick={() => handleDownloadModel(selectedDocsModel)}
                          className="ml-1 px-2 py-0.5 bg-purple-600 text-white rounded hover:bg-purple-700 transition-colors text-xs font-medium"
                        >
                          Download
                        </button>
                      </div>
                    );
                  })()}
                  <RunFromSidecarToggle
                    accent="purple"
                    on={!!formData.semanticSearch.docsFromSidecar}
                    onChange={v => setFormData({ ...formData, semanticSearch: { ...formData.semanticSearch, docsFromSidecar: v } })}
                    hint="Embed via sidecar capability `embedding`"
                  />
                  <div className="flex justify-between mt-2 text-xs text-gray-500">
                    <span>Dimensions: {formData.semanticSearch.docsDimensions || 768}</span>
                    <span>Table: docs_vectors</span>
                  </div>
                </div>
              </div>
              <p className={`${helpClass} mt-2`}>Changing models requires re-embedding. Override with <code className="bg-gray-100 px-1 rounded">CODE_EMBEDDING_MODEL</code> / <code className="bg-gray-100 px-1 rounded">DOCS_EMBEDDING_MODEL</code> env vars.</p>
            </div>

            {/* Performance Settings */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>ONNX Threads</label>
                <input type="number" min="1" max="16" value={formData.semanticSearch.embeddingThreads ?? 2}
                  onChange={(e) => setFormData({ ...formData, semanticSearch: { ...formData.semanticSearch, embeddingThreads: parseInt(e.target.value) || 2 } })}
                  className={`w-32 ${inputClass}`} />
                <p className={helpClass}>CPU threads for embedding inference. Lower = less CPU spike but slower. Default: 2. Requires restart.</p>
              </div>
              <div>
                <label className={labelClass}>Batch Size</label>
                <input type="number" min="1" max="64" value={formData.semanticSearch.embeddingBatchSize ?? 16}
                  onChange={(e) => setFormData({ ...formData, semanticSearch: { ...formData.semanticSearch, embeddingBatchSize: parseInt(e.target.value) || 16 } })}
                  className={`w-32 ${inputClass}`} />
                <p className={helpClass}>Texts per batch. Lower = less memory, more batches. Default: 16. Requires restart.</p>
              </div>
              <div>
                <label className={labelClass}>Projects in parallel</label>
                <input type="number" min="1" max="8"
                  value={(formData.semanticSearch as { parallelProjects?: number }).parallelProjects ?? 1}
                  onChange={(e) => setFormData({ ...formData, semanticSearch: { ...formData.semanticSearch, parallelProjects: parseInt(e.target.value) || 1 } as typeof formData.semanticSearch })}
                  className={`w-32 ${inputClass}`} />
                <p className={helpClass}>How many projects buildProjectEmbeddings runs concurrently. 1 = serial (safest). 2–4 saturates GPU sidecars but raises local memory pressure (Jetsam-kill risk on macOS). Default: 1.</p>
              </div>
            </div>

            {/* Model Mismatch Warning & Re-embed */}
            {modelStatus && (modelStatus.code.mismatch || modelStatus.docs.mismatch) && (
              <div className="mt-4 bg-amber-50 border border-amber-300 rounded-lg p-4">
                <h4 className="text-sm font-semibold text-amber-800 mb-2">Model Mismatch Detected</h4>
                <div className="space-y-1 text-xs text-amber-700">
                  {modelStatus.code.mismatch && (
                    <p>Code vectors use <strong>{modelStatus.code.storedModel}</strong> ({modelStatus.code.storedDimensions}d, {modelStatus.code.storedRows} vectors) but configured model is <strong>{modelStatus.code.configuredModel}</strong> ({modelStatus.code.configuredDimensions}d)</p>
                  )}
                  {modelStatus.docs.mismatch && (
                    <p>Docs vectors use <strong>{modelStatus.docs.storedModel}</strong> ({modelStatus.docs.storedDimensions}d, {modelStatus.docs.storedRows} vectors) but configured model is <strong>{modelStatus.docs.configuredModel}</strong> ({modelStatus.docs.configuredDimensions}d)</p>
                  )}
                </div>
                <button
                  onClick={() => { if (confirm('This will delete all existing code vectors and regenerate them with the new model. The job runs in the background; progress shows below. Continue?')) reEmbedMutation.mutate(); }}
                  disabled={reEmbedMutation.isPending || (reembedJob?.status === 'running' || reembedJob?.status === 'queued')}
                  className="mt-3 px-4 py-2 bg-amber-600 text-white rounded-md hover:bg-amber-700 disabled:opacity-50 transition-colors text-sm font-medium"
                >
                  {(reembedJob?.status === 'running' || reembedJob?.status === 'queued')
                    ? 'Re-embed in progress…'
                    : reEmbedMutation.isPending ? 'Starting…' : 'Re-embed All Vectors'}
                </button>

                {reembedJob && (
                  <div className="mt-3 border border-gray-200 rounded p-3 bg-gray-50 text-xs">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-medium text-gray-800">
                        Job {reembedJob.id.slice(0, 8)}… · {reembedJob.status}
                        {reembedJob.model && <span className="ml-2 font-mono">{reembedJob.model}{reembedJob.dimensions ? ` (${reembedJob.dimensions}d)` : ''}</span>}
                      </span>
                      {(reembedJob.status === 'running' || reembedJob.status === 'queued') && (
                        <button
                          onClick={() => cancelReembedMutation.mutate(reembedJob.id)}
                          className="text-xs px-2 py-0.5 bg-red-50 hover:bg-red-100 text-red-700 rounded"
                        >Cancel</button>
                      )}
                    </div>
                    {reembedJob.totalProjects > 0 && (
                      <div className="w-full h-1.5 bg-gray-200 rounded overflow-hidden mb-1">
                        <div className="h-full bg-amber-500 transition-all"
                          style={{ width: `${Math.min(100, (reembedJob.doneProjects / reembedJob.totalProjects) * 100)}%` }} />
                      </div>
                    )}
                    <div className="text-gray-600">
                      {reembedJob.doneProjects}/{reembedJob.totalProjects} projects ·{' '}
                      {reembedJob.generated.toLocaleString()} generated · {reembedJob.deleted.toLocaleString()} deleted ·{' '}
                      {reembedJob.errors.length} errors
                      {reembedJob.currentProjectId !== undefined && (
                        <span className="ml-2 text-gray-500">now: project #{reembedJob.currentProjectId}</span>
                      )}
                    </div>
                    {reembedJob.errorMessage && (
                      <div className="mt-1 text-red-600">{reembedJob.errorMessage}</div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Vector Stats Summary */}
            {modelStatus && !modelStatus.code.mismatch && !modelStatus.docs.mismatch && modelStatus.code.storedRows > 0 && (
              <div className="mt-4 bg-green-50 border border-green-200 rounded-lg p-3">
                <div className="flex items-center gap-2 text-sm text-green-800">
                  <span className="text-green-600 font-medium">Models in sync</span>
                  <span className="text-green-600">|</span>
                  <span>{modelStatus.code.storedRows} code vectors</span>
                  {modelStatus.docs.storedRows > 0 && (
                    <><span className="text-green-600">|</span><span>{modelStatus.docs.storedRows} doc vectors</span></>
                  )}
                </div>
              </div>
            )}
          </div>
        );

      case 'sidecars':
        return <SidecarsPanel />;

      case 'openrouter':
        return <OpenRouterPanel />;

      case 'llm-providers':
        return <LLMProvidersPanel />;

      case 'fantom-source':
        return (
          <div className="space-y-4">
            <div>
              <label className={labelClass}>Source Folder Path</label>
              <div className="flex gap-2">
                <input type="text" value={fantomFolderInput} onChange={(e) => setFantomFolderInput(e.target.value)}
                  placeholder="~/fantom" className={`flex-1 font-mono ${inputClass}`} />
                <button onClick={() => { if (fantomFolderInput.trim()) setFantomFolderMutation.mutate(fantomFolderInput.trim()); }}
                  disabled={setFantomFolderMutation.isPending || !fantomFolderInput.trim() || fantomFolderInput === fantomSourceFolder}
                  className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm">
                  {setFantomFolderMutation.isPending ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
            {fantomVersionsData?.versions && fantomVersionsData.versions.length > 0 && (
              <div>
                <label className={`${labelClass} mb-2`}>Available Versions</label>
                <div className="flex flex-wrap gap-2">
                  {fantomVersionsData.versions.map((v: FantomVersion) => (
                    <span key={v.version} className={`px-3 py-1 text-sm rounded-full ${v.hasSource ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`} title={v.path}>
                      {v.version}{v.hasSource && <span className="ml-1 text-xs">(src)</span>}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {fantomVersionsData?.message && !fantomVersionsData.versions?.length && (
              <p className="text-sm text-gray-500 italic">{fantomVersionsData.message}</p>
            )}
          </div>
        );

      case 'code-index':
        return (
          <div className="space-y-4">
            {codeStatsLoading ? <p className="text-gray-500">Loading...</p> : codeStats ? (
              <>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: 'Functions', value: codeStats.totalFunctions.toLocaleString() },
                    { label: 'Types', value: codeStats.totalTypes.toLocaleString() },
                    { label: 'Projects', value: codeStats.totalProjects.toLocaleString() },
                    { label: 'Search Index', value: codeStats.searchIndexSize.toLocaleString() },
                  ].map(s => (
                    <div key={s.label} className="bg-gray-50 p-3 rounded-lg">
                      <p className="text-xs text-gray-500 uppercase tracking-wide">{s.label}</p>
                      <p className="text-xl font-semibold text-gray-900 mt-1">{s.value}</p>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <button onClick={() => reindexCodeMutation.mutate()} disabled={reindexCodeMutation.isPending}
                    className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors text-sm">
                    {reindexCodeMutation.isPending ? 'Reindexing...' : 'Rebuild Index'}
                  </button>
                  <button onClick={() => rebuildGraphMutation.mutate()} disabled={rebuildGraphMutation.isPending}
                    className="px-4 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 disabled:opacity-50 transition-colors text-sm">
                    {rebuildGraphMutation.isPending ? 'Rebuilding...' : 'Rebuild Graph'}
                  </button>
                </div>
                {codeStats.lastUpdated && <p className="text-xs text-gray-500">Last updated: {new Date(codeStats.lastUpdated).toLocaleString()}</p>}

                <div className="border-t border-gray-200 pt-4 mt-2">
                  <h3 className="text-sm font-semibold text-gray-900 mb-1">LadybugDB Backfill</h3>
                  <p className="text-xs text-gray-500 mb-3">
                    Copy the code graph from SQLite/Prisma into LadybugDB. Safe to re-run; each project is cleared in Ladybug before re-inserting. Use dry-run first to preview row counts without writing.
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => backfillLadybugMutation.mutate(true)}
                      disabled={backfillLadybugMutation.isPending}
                      className="px-4 py-2 bg-gray-100 text-gray-800 rounded-md hover:bg-gray-200 disabled:opacity-50 transition-colors text-sm"
                    >
                      {backfillLadybugMutation.isPending ? 'Working…' : 'Dry Run'}
                    </button>
                    <button
                      onClick={() => backfillLadybugMutation.mutate(false)}
                      disabled={backfillLadybugMutation.isPending}
                      className="px-4 py-2 bg-emerald-600 text-white rounded-md hover:bg-emerald-700 disabled:opacity-50 transition-colors text-sm"
                    >
                      {backfillLadybugMutation.isPending ? 'Backfilling…' : 'Backfill All Projects'}
                    </button>
                  </div>
                  {backfillResult && (
                    <div className="mt-4 border border-gray-200 rounded-md overflow-hidden">
                      <div className="bg-gray-50 px-3 py-2 text-xs text-gray-600 flex items-center justify-between">
                        <span>
                          {backfillResult.projectCount} projects in {(backfillResult.totalDurationMs / 1000).toFixed(1)}s
                          {backfillResult.dryRun && ' (dry run)'}
                        </span>
                        <span>
                          {backfillResult.totals.ladybugNodesCreated}/{backfillResult.totals.prismaNodes} nodes,{' '}
                          {backfillResult.totals.ladybugEdgesCreated}/{backfillResult.totals.prismaEdges} edges
                          {backfillResult.totals.orphanEdgesDropped > 0 && `, ${backfillResult.totals.orphanEdgesDropped} orphan edges dropped`}
                        </span>
                      </div>
                      <div className="max-h-64 overflow-y-auto">
                        <table className="w-full text-xs">
                          <thead className="bg-gray-50 sticky top-0">
                            <tr className="text-left text-gray-500">
                              <th className="px-3 py-1.5 font-medium">Project</th>
                              <th className="px-3 py-1.5 font-medium text-right">Nodes</th>
                              <th className="px-3 py-1.5 font-medium text-right">Edges</th>
                              <th className="px-3 py-1.5 font-medium text-right">ms</th>
                            </tr>
                          </thead>
                          <tbody>
                            {backfillResult.results.map(r => {
                              const nodeMatch = r.ladybugNodesCreated === r.prismaNodes;
                              const edgeMatch = r.ladybugEdgesCreated + r.orphanEdgesDropped === r.prismaEdges;
                              const ok = !r.error && (backfillResult.dryRun || (nodeMatch && edgeMatch));
                              return (
                                <tr key={r.projectId} className={`border-t border-gray-100 ${r.error ? 'bg-red-50' : ''}`}>
                                  <td className="px-3 py-1.5">
                                    <span className={`inline-block w-2 h-2 rounded-full mr-2 ${ok ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                                    {r.projectName}
                                    {r.error && <span className="ml-2 text-red-600">{r.error}</span>}
                                  </td>
                                  <td className="px-3 py-1.5 text-right font-mono">
                                    {backfillResult.dryRun ? r.prismaNodes : `${r.ladybugNodesCreated}/${r.prismaNodes}`}
                                  </td>
                                  <td className="px-3 py-1.5 text-right font-mono">
                                    {backfillResult.dryRun ? r.prismaEdges : `${r.ladybugEdgesCreated}/${r.prismaEdges}`}
                                    {r.orphanEdgesDropped > 0 && <span className="text-gray-400 ml-1">(-{r.orphanEdgesDropped})</span>}
                                  </td>
                                  <td className="px-3 py-1.5 text-right font-mono text-gray-500">{r.durationMs}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="text-gray-500">
                <p className="mb-4">Code index not available.</p>
                <button onClick={() => reindexCodeMutation.mutate()} disabled={reindexCodeMutation.isPending}
                  className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors text-sm">
                  {reindexCodeMutation.isPending ? 'Reindexing...' : 'Build Index'}
                </button>
              </div>
            )}
          </div>
        );

      case 'usage-db':
        return (
          <div className="space-y-4">
            {dbInfo ? (
              <>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: 'Tool Events', value: dbInfo.toolEvents.toLocaleString() },
                    { label: 'Search Events', value: dbInfo.searchEvents.toLocaleString() },
                    { label: 'Database Size', value: formatBytes(dbInfo.size) },
                    { label: 'Location', value: dbInfo.path.split('/').pop() || '' },
                  ].map(s => (
                    <div key={s.label} className="bg-gray-50 p-3 rounded-lg">
                      <p className="text-xs text-gray-500 uppercase tracking-wide">{s.label}</p>
                      <p className={`${s.label === 'Location' ? 'text-sm font-mono' : 'text-xl font-semibold'} text-gray-900 mt-1 truncate`} title={s.label === 'Location' ? dbInfo.path : undefined}>{s.value}</p>
                    </div>
                  ))}
                </div>
                <div className="flex gap-3">
                  <button onClick={() => clearUsageMutation.mutate()} disabled={clearUsageMutation.isPending}
                    className="px-4 py-2 bg-yellow-100 text-yellow-800 rounded-md hover:bg-yellow-200 disabled:opacity-50 transition-colors text-sm">
                    {clearUsageMutation.isPending ? 'Clearing...' : 'Clear All Data'}
                  </button>
                  <button onClick={() => { if (confirm('This will delete and recreate the database. Are you sure?')) resetDbMutation.mutate(); }}
                    disabled={resetDbMutation.isPending}
                    className="px-4 py-2 bg-red-100 text-red-800 rounded-md hover:bg-red-200 disabled:opacity-50 transition-colors text-sm">
                    {resetDbMutation.isPending ? 'Resetting...' : 'Delete & Reset'}
                  </button>
                </div>
              </>
            ) : <p className="text-gray-500">Usage database not available</p>}
          </div>
        );

      case 'debug':
        return (
          <DebugLogPanel
            config={formData.debug ?? {}}
            onChange={(next) => setFormData({ ...formData, debug: next })}
          />
        );
    }
  }

  // ─── 3-Pane Layout ──────────────────────────────────────────────────

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Server Configuration</h1>
        <p className="text-gray-600 mt-1">Configure your Fantom MCP Server settings</p>
      </div>

      {/* Status toast */}
      {saveStatus && (
        <div className={`mb-4 p-3 rounded-lg text-sm ${
          saveStatus.type === 'success'
            ? 'bg-green-50 border border-green-200 text-green-800'
            : 'bg-red-50 border border-red-200 text-red-800'
        }`}>
          {saveStatus.message}
        </div>
      )}

      {/* 3-Pane Layout */}
      <div className="flex gap-4" style={{ minHeight: 'calc(100vh - 200px)' }}>
        {/* Left Pane: Group Navigation */}
        <nav className="w-48 flex-shrink-0">
          <div className="bg-white rounded-lg shadow overflow-hidden">
            {GROUPS.map((group) => (
              <button
                key={group.id}
                onClick={() => setActiveGroup(group.id)}
                className={`w-full text-left px-4 py-3 text-sm flex items-center gap-2 transition-colors border-l-2 ${
                  activeGroup === group.id
                    ? 'bg-blue-50 text-blue-700 border-blue-600 font-medium'
                    : 'text-gray-700 border-transparent hover:bg-gray-50 hover:text-gray-900'
                }`}
              >
                <span className="text-base w-5 text-center">{group.icon}</span>
                <span>{group.label}</span>
              </button>
            ))}
          </div>

          {/* Save Button */}
          <div className="mt-4">
            <button onClick={handleSave} disabled={updateMutation.isPending}
              className="w-full px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors text-sm font-medium">
              {updateMutation.isPending ? 'Saving...' : 'Save All Settings'}
            </button>
          </div>
        </nav>

        {/* Middle Pane: Settings Controls */}
        <div className="flex-1 min-w-0">
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center justify-between gap-3 mb-1">
              <h2 className="text-lg font-semibold text-gray-900">
                {DOCS[activeGroup].title}
              </h2>
              {tabUrl && (
                <button
                  type="button"
                  onClick={() => navigator.clipboard.writeText(tabUrl)}
                  title="Click to copy"
                  className="text-xs font-mono text-gray-500 hover:text-blue-600 truncate max-w-[60%]"
                >
                  {tabUrl}
                </button>
              )}
            </div>
            <div className="border-b border-gray-200 mb-5 pb-1" />
            {renderSettingsContent()}
          </div>
        </div>

        {/* Right Pane: Documentation */}
        <div className="w-72 flex-shrink-0 min-w-0">
          <div className="bg-white rounded-lg shadow p-5 sticky top-4 overflow-hidden [&_code]:break-all">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Documentation</h3>
            {DOCS[activeGroup].content}
          </div>
        </div>
      </div>
    </div>
  );
}
