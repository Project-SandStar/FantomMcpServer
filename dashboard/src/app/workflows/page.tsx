'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, type WorkflowListItem } from '@/lib/api';

// Workflows are the markdown files in workflows/ that the MCP server serves as
// `workflow://<id>` resources. Saving here writes the file and the server
// tells connected MCP clients at once (resources/list_changed).

type View = 'edit' | 'split' | 'preview';

const NEW_TEMPLATE = `# New Workflow

One paragraph that says what this workflow is for. It becomes the resource description.

## Steps

1. First step.
2. Second step.
`;

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

export default function WorkflowsPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [loadedMtime, setLoadedMtime] = useState<number | null>(null);
  const [view, setView] = useState<View>('split');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [newId, setNewId] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [proposal, setProposal] = useState<{ text: string; model: string; costUsd: number | null } | null>(null);

  const flash = (kind: 'ok' | 'err', text: string) => {
    setMsg({ kind, text });
    setTimeout(() => setMsg(null), 5000);
  };

  // Poll so edits made on disk (or by another tab) show up here too.
  const list = useQuery({ queryKey: ['workflows'], queryFn: api.listWorkflows, refetchInterval: 10_000 });
  const workflows = list.data?.workflows ?? [];
  const current: WorkflowListItem | undefined = workflows.find(w => w.id === selected);
  const dirty = content !== original;
  const changedOnDisk = !!current && loadedMtime !== null && current.mtimeMs !== loadedMtime;

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return workflows;
    return workflows.filter(w =>
      w.id.toLowerCase().includes(q) || w.title.toLowerCase().includes(q) || w.description.toLowerCase().includes(q));
  }, [workflows, filter]);

  const load = async (id: string) => {
    try {
      const r = await api.getWorkflow(id);
      setSelected(id);
      setContent(r.fullContent);
      setOriginal(r.fullContent);
      setLoadedMtime(r.workflow.mtimeMs);
      setProposal(null);
    } catch (e) {
      flash('err', e instanceof Error ? e.message : String(e));
    }
  };

  const select = (id: string) => {
    if (id === selected) return;
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    void load(id);
  };

  // Open the first workflow on first load.
  useEffect(() => {
    if (!selected && workflows.length) void load(workflows[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflows.length]);

  const save = useMutation({
    mutationFn: () => api.saveWorkflow(selected!, content),
    onSuccess: r => {
      setOriginal(r.fullContent);
      setContent(r.fullContent);
      setLoadedMtime(r.workflow.mtimeMs);
      qc.invalidateQueries({ queryKey: ['workflows'] });
      flash('ok', `Saved ${r.workflow.id}.md — MCP clients notified`);
    },
    onError: e => flash('err', `Save failed: ${e instanceof Error ? e.message : String(e)}`),
  });

  const create = useMutation({
    mutationFn: () => api.createWorkflow(newId.trim(), NEW_TEMPLATE),
    onSuccess: r => {
      qc.invalidateQueries({ queryKey: ['workflows'] });
      setShowNew(false);
      setNewId('');
      setSelected(r.workflow.id);
      setContent(r.fullContent);
      setOriginal(r.fullContent);
      setLoadedMtime(r.workflow.mtimeMs);
      setProposal(null);
      flash('ok', `Created ${r.workflow.id}.md`);
    },
    onError: e => flash('err', `Create failed: ${e instanceof Error ? e.message : String(e)}`),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteWorkflow(id),
    onSuccess: (_r, id) => {
      qc.invalidateQueries({ queryKey: ['workflows'] });
      setSelected(null);
      setContent('');
      setOriginal('');
      setLoadedMtime(null);
      flash('ok', `Deleted ${id}.md`);
    },
    onError: e => flash('err', `Delete failed: ${e instanceof Error ? e.message : String(e)}`),
  });

  const optimize = useMutation({
    mutationFn: () => api.optimizeWorkflow(selected!, content, instructions || undefined),
    onSuccess: r => setProposal({ text: r.proposed, model: r.model, costUsd: r.costUsd }),
    onError: e => flash('err', `Optimize failed: ${e instanceof Error ? e.message : String(e)}`),
  });

  const acceptProposal = () => {
    if (!proposal) return;
    setContent(proposal.text);
    setProposal(null);
    flash('ok', 'Proposal copied to the editor — review it, then Save');
  };

  const btn = 'px-3 py-1.5 text-sm rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed';
  const btnPrimary = 'px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed';
  const tab = (v: View) => `px-3 py-1.5 text-xs ${view === v ? 'bg-gray-200 text-gray-900' : 'bg-white text-gray-600 hover:bg-gray-50'}`;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Workflows</h1>
          <p className="text-sm text-gray-500">
            Markdown guides in <code className="font-mono">workflows/</code>, served to MCP clients as{' '}
            <code className="font-mono">workflow://&lt;id&gt;</code>. Saving updates them live.
          </p>
        </div>
        <div className="flex gap-2">
          <button className={btn} onClick={() => list.refetch()} disabled={list.isFetching}>
            {list.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
          <button className={btnPrimary} onClick={() => setShowNew(v => !v)}>New workflow</button>
        </div>
      </div>

      {msg && (
        <div className={`rounded-md px-4 py-2 text-sm border ${msg.kind === 'ok' ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800'}`}>
          {msg.text}
        </div>
      )}
      {list.error && (
        <div className="rounded-md px-4 py-2 text-sm border bg-red-50 border-red-200 text-red-800">
          Could not load workflows: {list.error instanceof Error ? list.error.message : String(list.error)}
        </div>
      )}

      {showNew && (
        <div className="bg-white rounded-lg shadow p-4 flex items-end gap-3">
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-700 mb-1">Id (file name, no .md)</label>
            <input
              value={newId}
              onChange={e => setNewId(e.target.value)}
              placeholder="e.g. write-axon-tests"
              className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm font-mono focus:border-blue-500 focus:outline-none"
            />
          </div>
          <button className={btnPrimary} disabled={!/^[a-z0-9][a-z0-9_-]*$/i.test(newId.trim()) || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Creating…' : 'Create'}
          </button>
          <button className={btn} onClick={() => setShowNew(false)}>Cancel</button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4">
        {/* List */}
        <div className="bg-white rounded-lg shadow flex flex-col max-h-[calc(100vh-200px)]">
          <div className="p-3 border-b border-gray-200">
            <input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder={`Filter ${workflows.length} workflows…`}
              className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
          <ul className="overflow-y-auto divide-y divide-gray-100">
            {filtered.map(w => (
              <li key={w.id}>
                <button
                  onClick={() => select(w.id)}
                  className={`w-full text-left px-3 py-2 hover:bg-blue-50 ${w.id === selected ? 'bg-blue-50 border-l-2 border-blue-600' : ''}`}
                >
                  <div className="text-sm font-medium text-gray-900 truncate">{w.title}</div>
                  <div className="text-xs text-gray-500 font-mono truncate">{w.id} · {w.lines} lines</div>
                  <div className="text-xs text-gray-500 line-clamp-2 mt-0.5">{w.description}</div>
                </button>
              </li>
            ))}
            {!filtered.length && !list.isLoading && (
              <li className="px-3 py-6 text-center text-sm text-gray-500">No workflows found.</li>
            )}
          </ul>
        </div>

        {/* Editor */}
        <div className="bg-white rounded-lg shadow flex flex-col h-[calc(100vh-200px)] min-h-[500px]">
          {!selected ? (
            <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">Pick a workflow on the left.</div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-4 py-2 flex-wrap">
                <div className="min-w-0">
                  <div className="font-semibold text-gray-900 font-mono text-sm">{selected}.md</div>
                  <div className="text-xs text-gray-500">
                    {current ? `workflow://${current.id} · changed ${fmtTime(current.mtimeMs)}` : ''}
                    {dirty && <span className="ml-2 text-amber-600">unsaved changes</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex rounded-md border border-gray-300 overflow-hidden">
                    <button className={tab('edit')} onClick={() => setView('edit')}>Edit</button>
                    <button className={tab('split')} onClick={() => setView('split')}>Split</button>
                    <button className={tab('preview')} onClick={() => setView('preview')}>Preview</button>
                  </div>
                  <button className={btn} disabled={!dirty} onClick={() => setContent(original)}>Revert</button>
                  <button className={btnPrimary} disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
                    {save.isPending ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    className={`${btn} text-red-700 hover:bg-red-50`}
                    disabled={remove.isPending}
                    onClick={() => { if (window.confirm(`Delete ${selected}.md? This removes the file.`)) remove.mutate(selected); }}
                  >Delete</button>
                </div>
              </div>

              {changedOnDisk && (
                <div className="px-4 py-2 text-xs bg-amber-50 border-b border-amber-200 text-amber-800 flex items-center gap-3">
                  The file changed on disk since you opened it.
                  <button className="underline" onClick={() => { if (!dirty || window.confirm('Discard your edits and load the disk version?')) void load(selected); }}>
                    Load disk version
                  </button>
                </div>
              )}

              {/* Optimize bar */}
              <div className="px-4 py-2 border-b border-gray-200 flex items-center gap-2 bg-gray-50">
                <input
                  value={instructions}
                  onChange={e => setInstructions(e.target.value)}
                  placeholder="Optional: what to improve (e.g. shorter, add a testing step)…"
                  className="flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-purple-500 focus:outline-none"
                />
                <button
                  className="px-3 py-1.5 text-sm rounded-md bg-purple-600 text-white hover:bg-purple-700 disabled:bg-gray-300"
                  disabled={optimize.isPending || !content.trim()}
                  onClick={() => optimize.mutate()}
                  title="Ask the LLM (sidecar OpenRouter route) for a better version. Nothing is saved until you accept and Save."
                >
                  {optimize.isPending ? 'Optimizing…' : 'Optimize with AI'}
                </button>
              </div>

              <div className="flex flex-1 overflow-hidden">
                {proposal ? (
                  <>
                    <div className="w-1/2 h-full flex flex-col border-r border-gray-200">
                      <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase bg-gray-50 border-b border-gray-200">Current</div>
                      <textarea readOnly value={content} className="flex-1 resize-none bg-gray-50 p-4 font-mono text-xs text-gray-700 focus:outline-none" />
                    </div>
                    <div className="w-1/2 h-full flex flex-col">
                      <div className="px-3 py-1.5 text-xs bg-purple-50 border-b border-purple-200 flex items-center justify-between gap-2">
                        <span className="font-semibold text-purple-800 uppercase">
                          Proposal <span className="normal-case font-normal">· {proposal.model}{proposal.costUsd != null ? ` · $${proposal.costUsd.toFixed(4)}` : ''}</span>
                        </span>
                        <span className="flex gap-2">
                          <button className="px-2 py-0.5 rounded bg-purple-600 text-white hover:bg-purple-700" onClick={acceptProposal}>Use this</button>
                          <button className="px-2 py-0.5 rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50" onClick={() => setProposal(null)}>Discard</button>
                        </span>
                      </div>
                      <textarea
                        value={proposal.text}
                        onChange={e => setProposal({ ...proposal, text: e.target.value })}
                        spellCheck={false}
                        className="flex-1 resize-none p-4 font-mono text-xs text-gray-900 focus:outline-none"
                      />
                    </div>
                  </>
                ) : (
                  <>
                    {(view === 'edit' || view === 'split') && (
                      <textarea
                        value={content}
                        onChange={e => setContent(e.target.value)}
                        spellCheck={false}
                        className={`${view === 'split' ? 'w-1/2 border-r border-gray-200' : 'w-full'} h-full resize-none bg-gray-50 p-4 font-mono text-sm text-gray-900 focus:outline-none`}
                      />
                    )}
                    {(view === 'preview' || view === 'split') && (
                      <div className={`${view === 'split' ? 'w-1/2' : 'w-full'} h-full overflow-auto p-6`}>
                        <article className="prose prose-sm max-w-none">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
                        </article>
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
