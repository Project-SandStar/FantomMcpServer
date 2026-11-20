'use client';

/**
 * Decision model card: which model makes the small yes/no calls in the ask
 * gates (Jev or Clef). Saved on its own, apart from the OpenRouter Save.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type DecisionProvider, type DecisionTestResult } from '@/lib/api';

const LABEL: Record<DecisionProvider, string> = { jev: 'Jev', clef: 'Clef' };

export function DecisionModelCard() {
  const qc = useQueryClient();
  const { data, error } = useQuery({ queryKey: ['decision-model'], queryFn: api.getDecisionModel });
  // null = not edited: show the server's value.
  const [providerDraft, setProvider] = useState<DecisionProvider | null>(null);
  const [clefDraft, setClefModel] = useState<string | null>(null);
  const provider: DecisionProvider = providerDraft ?? data?.settings.provider ?? 'jev';
  const clefModel = clefDraft ?? data?.settings.clefModel ?? data?.clefModels[0] ?? '';
  const [note, setNote] = useState<string | null>(null);
  const [tests, setTests] = useState<Partial<Record<DecisionProvider, DecisionTestResult>>>({});

  const save = useMutation({
    mutationFn: () => api.saveDecisionModel({ provider, ...(clefModel ? { clefModel } : {}) }),
    onSuccess: (r) => {
      setNote(r.ok ? 'Saved.' : `Not saved: ${r.error ?? 'unknown error'}`);
      if (r.ok) { setProvider(null); setClefModel(null); }
      void qc.invalidateQueries({ queryKey: ['decision-model'] });
    },
    onError: (e: Error) => setNote(`Not saved: ${e.message}`),
  });

  const test = useMutation({
    mutationFn: (p: DecisionProvider) =>
      api.testDecisionModel({ provider: p, ...(p === 'clef' && clefModel ? { clefModel } : {}) }),
    onSuccess: (r, p) => setTests(prev => ({ ...prev, [p]: r })),
    onError: (e: Error, p) => setTests(prev => ({ ...prev, [p]: { ok: false, ms: 0, provider: p, model: '', error: e.message } })),
  });

  if (error) return <p className="text-xs text-red-600">Decision model: {(error as Error).message}</p>;
  if (!data) return null;

  const providers = data.providers.length ? data.providers : (['jev', 'clef'] as DecisionProvider[]);
  const dirty = provider !== data.settings.provider || (!!clefModel && clefModel !== data.settings.clefModel);

  return (
    <section>
      <h3 className="text-lg font-semibold text-gray-900 mb-1">Decision model</h3>
      <p className="text-xs text-gray-500 mb-3">
        Makes the small yes/no calls before an ask (for example: skip the RLM loop or not).
        Now active: {LABEL[data.active.provider]} ({data.active.model})
        {data.active.ready ? '' : ` · not ready${data.active.whyNot ? `: ${data.active.whyNot}` : ''}`}
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs text-gray-600 mb-1">Model</label>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as DecisionProvider)}
            className="px-3 py-2 border border-gray-300 rounded-md text-sm"
          >
            {providers.map(p => <option key={p} value={p}>{LABEL[p] ?? p}</option>)}
          </select>
        </div>
        {provider === 'clef' && (
          <div>
            <label className="block text-xs text-gray-600 mb-1">Clef model</label>
            <select
              value={clefModel}
              onChange={(e) => setClefModel(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm"
            >
              {data.clefModels.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        )}
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={save.isPending || !dirty}
          className="px-3 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
      <p className="text-xs text-gray-500 mt-2">
        Jev key: {data.jev.hasKey ? 'yes' : 'no'}{data.jev.enabled ? '' : ' (off)'} · Clef key: {data.clef.hasKey ? 'yes' : 'no'}
      </p>
      {note && <p className="text-xs text-gray-600 mt-1">{note}</p>}

      <div className="mt-3 space-y-1">
        {providers.map(p => {
          const r = tests[p];
          const busy = test.isPending && test.variables === p;
          return (
            <div key={p} className="flex items-center gap-2 text-xs">
              <button
                type="button"
                onClick={() => test.mutate(p)}
                disabled={test.isPending}
                className="px-2 py-1 border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
              >
                {busy ? 'Testing…' : `Test ${LABEL[p] ?? p}`}
              </button>
              {r && (r.ok ? (
                <span className="text-green-700">
                  ok · {r.ms} ms · {r.model}{r.answer !== undefined ? ` · yes = ${(r.answer * 100).toFixed(0)}%` : ''}
                </span>
              ) : (
                <span className="text-red-600">failed{r.ms ? ` · ${r.ms} ms` : ''}: {r.error ?? 'unknown error'}</span>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
