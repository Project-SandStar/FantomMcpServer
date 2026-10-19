'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatRunAnchor, formatRelative } from '@/lib/time';

interface DeleteIndexRunButtonProps {
  projectId: number;
  /** The `asOf` anchor. The button shows only when it is exactly a run's startedAt. */
  selectedIso: string | null;
  /** Called after a delete with a one-line summary. */
  onDeleted: (summary: string) => void;
}

// "Delete this parse": a Delete button for the run picked in IndexRunStrip,
// with a confirm modal fed by the server's delete-preview. Semantics:
// src/fantom-code/indexRunDelete.ts (history rows + this run's vectors; the
// graph is kept).
export function DeleteIndexRunButton({ projectId, selectedIso, onDeleted }: DeleteIndexRunButtonProps) {
  const [open, setOpen] = useState(false);
  // Same key + limit as IndexRunStrip, so this reads its cache.
  const { data: runs } = useQuery({
    queryKey: ['index-runs', projectId],
    queryFn: () => api.listIndexRuns(projectId, 30),
    enabled: projectId > 0,
  });
  const run = selectedIso ? runs?.runs.find((r) => r.startedAt === selectedIso) : undefined;
  if (!run) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-2 py-1 text-xs rounded border border-red-300 text-red-700 hover:bg-red-50"
        title={`Delete run #${run.id}`}
      >
        Delete run #{run.id}
      </button>
      {open && (
        <DeleteIndexRunModal
          projectId={projectId}
          runId={run.id}
          onClose={() => setOpen(false)}
          onDeleted={(s) => { setOpen(false); onDeleted(s); }}
        />
      )}
    </>
  );
}

function DeleteIndexRunModal({
  projectId,
  runId,
  onClose,
  onDeleted,
}: {
  projectId: number;
  runId: number;
  onClose: () => void;
  onDeleted: (summary: string) => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const { data: preview, isLoading, error: previewError } = useQuery({
    queryKey: ['index-run-delete-preview', projectId, runId],
    queryFn: () => api.getIndexRunDeletePreview(projectId, runId),
    staleTime: 0,
  });

  const del = useMutation({
    mutationFn: () => api.deleteIndexRun(projectId, runId),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['index-runs', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project-diff', projectId] });
      queryClient.invalidateQueries({ queryKey: ['vector-stats'] });
      queryClient.invalidateQueries({ queryKey: ['indexing-state', projectId] });
      const parts = [
        `Deleted run #${r.runId}: ${r.apiChangesDeleted} symbol changes, ${r.edgeChangesDeleted} edge changes, ${r.vectorsDeleted} vectors`,
      ];
      if (r.indexedFilesCleared > 0) parts.push(`${r.indexedFilesCleared} files will be re-parsed on the next reindex`);
      if (r.vectorsDeleted > 0) parts.push('missing vectors re-embed on their own (or use Resume on the Vectors page)');
      onDeleted(parts.join('. ') + '.');
    },
    onError: (err: Error) => setError(err.message),
  });

  const ac = preview?.apiChanges;
  const atLeast = ac?.capped ? 'at least ' : '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Delete indexing run #{runId}</h3>

        {isLoading && <p className="text-sm text-gray-500">Checking what this removes…</p>}
        {previewError && (
          <p className="text-sm text-red-700">Failed to load preview: {String(previewError)}</p>
        )}

        {preview && ac && (
          <>
            <p className="text-sm text-gray-600 mb-3">
              {formatRunAnchor(preview.run.startedAt)} ({formatRelative(preview.run.startedAt)}) · trigger {preview.run.trigger}
              {preview.run.force ? ' · forced' : ''}
              {preview.run.isSeedingRun ? ' · seeding run' : ''}
              {preview.unfinished ? ' · unfinished (crashed)' : ''}
            </p>

            {preview.refusal ? (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 mb-4 text-sm text-yellow-800">
                {preview.refusal}
              </div>
            ) : (
              <>
                <div className="text-sm text-gray-800 mb-3">
                  <p className="font-medium mb-1">This removes:</p>
                  <ul className="list-disc pl-5 space-y-0.5">
                    <li>
                      The run record and {atLeast}{ac.total} symbol changes (+{ac.added} ~{ac.modified} -{ac.removed})
                    </li>
                    <li>{preview.edgeChanges} call-graph edge changes</li>
                    <li>
                      {preview.vectorSkipReason
                        ? `No vectors (${preview.vectorSkipReason})`
                        : `${preview.vectorRows ?? '?'} vector rows of ${preview.vectorSymbols} symbols; they re-embed from the current code`}
                    </li>
                    {preview.reparseFiles.length > 0 && (
                      <li>
                        The file-hash record of {preview.reparseFiles.length} files, so the next reindex re-parses them
                      </li>
                    )}
                  </ul>
                </div>
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 mb-4 text-xs text-yellow-800 space-y-1">
                  <p>The code graph stays as it is: it always holds the latest parse.</p>
                  {preview.isLatest && (
                    <p>
                      This is the latest run. Earlier time-travel diffs lose its changes, and the history
                      will not match the graph until the next reindex.
                    </p>
                  )}
                  <p>This cannot be undone.</p>
                </div>
              </>
            )}
          </>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4 text-sm text-red-800">{error}</div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!preview || !!preview.refusal || del.isPending}
            onClick={() => { setError(null); del.mutate(); }}
            className="px-4 py-2 text-sm text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50"
          >
            {del.isPending ? 'Deleting…' : 'Delete run'}
          </button>
        </div>
      </div>
    </div>
  );
}
