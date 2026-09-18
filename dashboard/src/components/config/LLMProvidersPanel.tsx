'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, LLMProviderName } from '@/lib/api';
import { PROVIDER_MODELS, DEFAULT_PROVIDER_MODELS } from '@/lib/llmModels';

const inputClass = "w-full rounded-md border border-gray-300 py-2 px-3 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";
const labelClass = "block text-xs font-medium text-gray-600 mb-1";

type ProviderState = { enabled: boolean; model: string; apiKey: string; hasKey: boolean; masked: string | null };

const DEFAULT: ProviderState = { enabled: false, model: '', apiKey: '', hasKey: false, masked: null };

const PROVIDER_LABELS: Record<LLMProviderName, string> = {
  groq: 'Groq',
  anthropic: 'Anthropic Claude',
  gemini: 'Google Gemini',
};

const DEFAULT_MODELS = DEFAULT_PROVIDER_MODELS;

export function LLMProvidersPanel() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['llm-providers'],
    queryFn: () => api.getLLMProviders(),
  });

  const [defaultProvider, setDefaultProvider] = useState<LLMProviderName | ''>('');
  const [groq, setGroq] = useState<ProviderState>(DEFAULT);
  const [anthropic, setAnthropic] = useState<ProviderState>(DEFAULT);
  const [gemini, setGemini] = useState<ProviderState>(DEFAULT);

  useEffect(() => {
    if (!data) return;
    setDefaultProvider(data.defaultProvider ?? '');
    setGroq({ enabled: data.groq.enabled, model: data.groq.model ?? '', apiKey: '', hasKey: data.groq.hasKey, masked: data.groq.apiKey });
    setAnthropic({ enabled: data.anthropic.enabled, model: data.anthropic.model ?? '', apiKey: '', hasKey: data.anthropic.hasKey, masked: data.anthropic.apiKey });
    setGemini({ enabled: data.gemini.enabled, model: data.gemini.model ?? '', apiKey: '', hasKey: data.gemini.hasKey, masked: data.gemini.apiKey });
  }, [data]);

  // Snapshot of what was last saved so we can show the operator the
  // exact values that hit the wire — surfaces any state mismatch
  // between the toggle and the request body, which was the root cause
  // of "I clicked enable but it didn't save" reports.
  const [lastSaved, setLastSaved] = useState<null | { groq: boolean; anthropic: boolean; gemini: boolean; default: string | null }>(null);

  const saveMut = useMutation({
    mutationFn: () => api.saveLLMProviders({
      defaultProvider: defaultProvider || null,
      groq: { enabled: groq.enabled, model: groq.model || undefined, apiKey: groq.apiKey || undefined },
      anthropic: { enabled: anthropic.enabled, model: anthropic.model || undefined, apiKey: anthropic.apiKey || undefined },
      gemini: { enabled: gemini.enabled, model: gemini.model || undefined, apiKey: gemini.apiKey || undefined },
    }),
    onSuccess: async () => {
      // Capture the values we believed we just saved.
      setLastSaved({ groq: groq.enabled, anthropic: anthropic.enabled, gemini: gemini.enabled, default: defaultProvider || null });
      // Force a refetch (invalidate alone is a no-op if nothing is
      // observing). If the server-confirmed values diverge from what
      // we saved, the useEffect above will overwrite the local state
      // and the user sees the truth — no silent drift.
      await qc.invalidateQueries({ queryKey: ['llm-providers'] });
      await qc.refetchQueries({ queryKey: ['llm-providers'] });
    },
  });

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>;

  const providerCard = (
    name: LLMProviderName,
    state: ProviderState,
    setState: (s: ProviderState) => void,
  ) => (
    <div className="border border-gray-200 rounded-md p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-gray-900">{PROVIDER_LABELS[name]}</h4>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={state.enabled}
            onChange={e => setState({ ...state, enabled: e.target.checked })} />
          <span>Enabled</span>
        </label>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Model</label>
          <select className={inputClass}
            value={state.model || DEFAULT_MODELS[name]}
            onChange={e => setState({ ...state, model: e.target.value })}>
            {PROVIDER_MODELS[name].map(m => (
              <option key={m.id} value={m.id}>
                {m.label}{m.recommended ? ' (recommended)' : ''}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>
            API Key {state.hasKey && <span className="text-green-600">· stored</span>}
          </label>
          <input type="password" className={inputClass} value={state.apiKey}
            placeholder={state.masked ?? 'paste key to update'}
            onChange={e => setState({ ...state, apiKey: e.target.value })} />
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div>
        <label className={labelClass}>Default provider for semantic-search rerank</label>
        <select className={inputClass} value={defaultProvider}
          onChange={e => setDefaultProvider(e.target.value as LLMProviderName | '')}>
          <option value="">— none —</option>
          <option value="groq">Groq</option>
          <option value="anthropic">Anthropic Claude</option>
          <option value="gemini">Google Gemini</option>
        </select>
      </div>

      {providerCard('groq', groq, setGroq)}
      {providerCard('anthropic', anthropic, setAnthropic)}
      {providerCard('gemini', gemini, setGemini)}

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => saveMut.mutate()}
          disabled={saveMut.isPending}
          className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
        >
          {saveMut.isPending ? 'Saving…' : 'Save providers'}
        </button>
        {saveMut.isSuccess && lastSaved && (
          <span className="text-sm text-green-700 bg-green-50 border border-green-200 rounded px-2 py-1">
            ✓ Saved · default: <code>{lastSaved.default ?? 'none'}</code> · enabled:{' '}
            <code>groq={String(lastSaved.groq)}</code>{' '}
            <code>anthropic={String(lastSaved.anthropic)}</code>{' '}
            <code>gemini={String(lastSaved.gemini)}</code>
          </span>
        )}
        {saveMut.isError && (
          <span className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
            × Save failed: {(saveMut.error as Error)?.message ?? 'unknown'}
          </span>
        )}
      </div>

      <p className="text-xs text-gray-500">
        Keys are written to <code className="bg-gray-100 px-1 rounded">.env</code> as <code className="bg-gray-100 px-1 rounded">GROQ_API_KEY</code>,
        <code className="bg-gray-100 px-1 rounded">ANTHROPIC_API_KEY</code>, <code className="bg-gray-100 px-1 rounded">GEMINI_API_KEY</code>.
        Server picks them up immediately; restart not required.
      </p>
    </div>
  );
}
