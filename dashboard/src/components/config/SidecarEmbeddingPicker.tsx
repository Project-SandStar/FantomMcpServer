'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Friendly display name for a raw model id: drop the hf.co/org/ path prefix
 *  and the -GGUF/quant suffix. e.g.
 *  "hf.co/jinaai/jina-code-embeddings-1.5b-GGUF:Q8_0" → "jina-code-embeddings-1.5b".
 *  Leaves short ids like "qwen3-embedding:0.6b" untouched. */
function prettyModel(id: string): string {
  const base = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  return base.replace(/-GGUF.*$/i, '');
}

/**
 * Read-only sidecar ROUTING status for the configured code model.
 *
 * This used to be an interactive picker, but selecting a model here only set
 * codeModel (not codeDimensions), so a re-embed after picking saw "no dim
 * change" and silently refused to drop+rebuild — writing 1536d vectors into a
 * 1024d table. The model is now chosen ONLY in the Code Search dropdown above
 * (which sets model + dimensions + sidecar routing together); this panel just
 * shows where the selected model auto-routes. Routing is by model name across
 * the embedding-code capability (dedicated, own port) then the general
 * embedding capability — no manual picking needed.
 */
export function SidecarEmbeddingPicker({
  currentModel,
}: {
  currentModel: string;
  /** Accepted for backwards-compat with the parent; no longer used. */
  onPick?: (model: string) => void;
}) {
  const { data: sidecars } = useQuery({
    queryKey: ['sidecars'],
    queryFn: () => api.listSidecars({ enabled: true }),
    refetchInterval: 5000,
  });

  const list = sidecars?.sidecars ?? [];

  // Auto-routing: the sidecar that will serve the configured code model —
  // prefer the dedicated 'embedding-code' capability (own port), then the
  // general 'embedding' one. Mirrors capabilityKindsFor('code') on the server.
  const route = (() => {
    if (!currentModel) return null;
    for (const kind of ['embedding-code', 'embedding'] as const) {
      const sc = list.find(s => s.capabilities?.[kind]?.models?.includes(currentModel));
      if (sc) return { sc, kind, cap: sc.capabilities[kind]! };
    }
    return null;
  })();

  return (
    <div className="pt-4 border-t border-gray-200">
      <h3 className="text-sm font-medium text-gray-900 mb-1">Sidecar routing</h3>
      <p className="text-xs text-gray-500 mb-2">
        Code embeddings route automatically to whichever enabled sidecar serves the
        selected model — no manual selection. Change the model in the <span className="font-medium">Code Search</span> dropdown above.
      </p>
      {!currentModel ? (
        <p className="text-xs text-gray-400 italic">No code model configured.</p>
      ) : route ? (
        <div className="flex items-center gap-2 text-sm border border-emerald-200 bg-emerald-50 rounded-md p-3">
          <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />
          <span className="text-gray-700">
            <span className="font-mono">{prettyModel(currentModel)}</span>
            {' → '}
            <span className="font-medium">{route.sc.name}</span>{' '}
            <span className="text-xs text-gray-500 font-mono">{route.sc.host}:{route.cap.port ?? route.sc.port}</span>{' '}
            <span className="text-xs text-emerald-700">({route.kind})</span>
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm border border-amber-200 bg-amber-50 rounded-md p-3">
          <span className="w-2 h-2 rounded-full bg-amber-500 inline-block" />
          <span className="text-amber-800">
            No enabled sidecar currently advertises <span className="font-mono">{prettyModel(currentModel)}</span>.
            Re-embedding will fail until a sidecar serving it is up.
          </span>
        </div>
      )}
    </div>
  );
}
