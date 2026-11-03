'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, LLMProviderName, LLMProbeResult, LLMProbeTarget } from '@/lib/api';
import { PROVIDER_MODELS, DEFAULT_PROVIDER_MODELS } from '@/lib/llmModels';

const inputClass = "w-full rounded-md border border-gray-300 py-2 px-3 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";
const labelClass = "block text-xs font-medium text-gray-600 mb-1";

type ProviderState = { enabled: boolean; model: string; apiKey: string; hasKey: boolean; masked: string | null; keySource?: 'stored' | 'env' | null };

/** Where the live key comes from: saved here (server secrets store) or the deployment env file. */
function keySourceLabel(src?: 'stored' | 'env' | null): string {
  return src === 'stored' ? 'saved on server' : src === 'env' ? 'from env file' : 'set';
}

const DEFAULT: ProviderState = { enabled: false, model: '', apiKey: '', hasKey: false, masked: null };

const PROVIDER_LABELS: Record<LLMProviderName, string> = {
  groq: 'Groq',
  anthropic: 'Anthropic Claude',
  gemini: 'Google Gemini',
};

const DEFAULT_MODELS = DEFAULT_PROVIDER_MODELS;

const ALL_TARGETS: LLMProbeTarget[] = ['groq', 'anthropic', 'gemini', 'typesafe', 'rlm'];

/** One line per probe: pass/fail, time, model, route, and the provider's own text. */
function ProbeLine({ r }: { r: LLMProbeResult }) {
  const cls = r.ok
    ? 'text-green-700 bg-green-50 border-green-200'
    : 'text-red-700 bg-red-50 border-red-200';
  return (
    <div className={`text-xs border rounded px-2 py-1 ${cls} break-words`}>
      {r.ok ? '✓' : '×'} {r.ms} ms · {r.model ?? 'no model'}
      {r.servedModel ? <> (served as <code>{r.servedModel}</code>)</> : null}
      {' '}· {r.route} · {r.message}
    </div>
  );
}

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
  // TypeSafe Jev: routing judgments only (RLM on/off per question). Not in
  // the rerank-provider list, so it has its own card and state.
  const [typesafe, setTypesafe] = useState<ProviderState>(DEFAULT);

  useEffect(() => {
    if (!data) return;
    setDefaultProvider(data.defaultProvider ?? '');
    setGroq({ enabled: data.groq.enabled, model: data.groq.model ?? '', apiKey: '', hasKey: data.groq.hasKey, masked: data.groq.apiKey, keySource: data.groq.keySource ?? null });
    setAnthropic({ enabled: data.anthropic.enabled, model: data.anthropic.model ?? '', apiKey: '', hasKey: data.anthropic.hasKey, masked: data.anthropic.apiKey, keySource: data.anthropic.keySource ?? null });
    setGemini({ enabled: data.gemini.enabled, model: data.gemini.model ?? '', apiKey: '', hasKey: data.gemini.hasKey, masked: data.gemini.apiKey, keySource: data.gemini.keySource ?? null });
    setTypesafe({ enabled: data.typesafe?.enabled ?? false, model: data.typesafe?.model ?? '', apiKey: '', hasKey: data.typesafe?.hasKey ?? false, masked: data.typesafe?.apiKey ?? null, keySource: data.typesafe?.keySource ?? null });
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
      typesafe: { enabled: typesafe.enabled, model: typesafe.model || undefined, apiKey: typesafe.apiKey || undefined },
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

  // Live probes. Results are kept per target so one card's result survives
  // another card's test. The model sent is the dropdown value, so an unsaved
  // selection is what gets tested; the KEY is always the saved one.
  const [probeResults, setProbeResults] = useState<Partial<Record<LLMProbeTarget, LLMProbeResult>>>({});
  const [probing, setProbing] = useState<Set<LLMProbeTarget>>(new Set());
  const [probeError, setProbeError] = useState<string | null>(null);

  const modelsForProbe = (): Partial<Record<LLMProbeTarget, string>> => ({
    groq: groq.model || DEFAULT_MODELS.groq,
    anthropic: anthropic.model || DEFAULT_MODELS.anthropic,
    gemini: gemini.model || DEFAULT_MODELS.gemini,
    ...(typesafe.model ? { typesafe: typesafe.model } : {}),
  });

  const runProbe = async (targets: LLMProbeTarget[]) => {
    setProbeError(null);
    setProbing((prev) => new Set([...prev, ...targets]));
    try {
      const { results } = await api.testLLMProviders({ targets, models: modelsForProbe() });
      setProbeResults((prev) => {
        const next = { ...prev };
        for (const r of results) next[r.target] = r;
        return next;
      });
    } catch (err) {
      setProbeError((err as Error)?.message ?? 'test request failed');
    } finally {
      setProbing((prev) => {
        const next = new Set(prev);
        for (const t of targets) next.delete(t);
        return next;
      });
    }
  };

  const testButton = (target: LLMProbeTarget) => (
    <button
      type="button"
      onClick={() => runProbe([target])}
      disabled={probing.has(target)}
      className="px-2.5 py-1 text-xs rounded border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-50"
      title="One short request with the saved key"
    >
      {probing.has(target) ? 'Testing…' : 'Test'}
    </button>
  );

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>;

  const providerCard = (
    name: LLMProviderName,
    state: ProviderState,
    setState: (s: ProviderState) => void,
  ) => (
    <div className="border border-gray-200 rounded-md p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-gray-900">{PROVIDER_LABELS[name]}</h4>
        <div className="flex items-center gap-3">
          {testButton(name)}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={state.enabled}
              onChange={e => setState({ ...state, enabled: e.target.checked })} />
            <span>Enabled</span>
          </label>
        </div>
      </div>
      {probeResults[name] && <ProbeLine r={probeResults[name]!} />}
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
            API Key {state.hasKey && <span className="text-green-600">· {keySourceLabel(state.keySource)}</span>}
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

      <div className="border border-indigo-200 bg-indigo-50/40 rounded-md p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-semibold text-gray-900">TypeSafe Jev · routing</h4>
            <p className="text-xs text-gray-600 mt-0.5">
              One typed judgment per ask (~200 ms, fractions of a cent): skips the 35–95 s RLM loop when
              retrieval already answers the question. Advisory — below the confidence floor the default route runs.
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {testButton('typesafe')}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={typesafe.enabled}
                onChange={e => setTypesafe({ ...typesafe, enabled: e.target.checked })} />
              <span>Enabled</span>
            </label>
          </div>
        </div>
        {probeResults.typesafe && <ProbeLine r={probeResults.typesafe} />}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClass}>Model</label>
            <input type="text" className={inputClass} value={typesafe.model}
              placeholder="jev-latest"
              onChange={e => setTypesafe({ ...typesafe, model: e.target.value })} />
          </div>
          <div>
            <label className={labelClass}>
              API Key {typesafe.hasKey && <span className="text-green-600">· {keySourceLabel(typesafe.keySource)}</span>}
            </label>
            <input type="password" className={inputClass} value={typesafe.apiKey}
              placeholder={typesafe.masked ?? 'paste key to update'}
              onChange={e => setTypesafe({ ...typesafe, apiKey: e.target.value })} />
          </div>
        </div>
        <p className="text-xs text-gray-500">
          Confidence floor: <code className="bg-gray-100 px-1 rounded">semanticSearch.jev.minConfidence</code> (default 0.7),
          timeout <code className="bg-gray-100 px-1 rounded">semanticSearch.jev.timeoutMs</code> (default 4000) in the runtime config.
          Decisions show in the ask feed and the log as <code className="bg-gray-100 px-1 rounded">[jev] route=…</code>.
        </p>
      </div>

      <div className="border border-amber-200 bg-amber-50/40 rounded-md p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-semibold text-gray-900">RLM sandbox model</h4>
            <p className="text-xs text-gray-600 mt-0.5">
              Tests the model the RLM loop resolves right now (local ss-rlm, a <code>direct:</code> provider with
              its key above, or the sidecar&apos;s OpenRouter route). Set it on the OpenRouter page.
              A fail here is why an ask shows <code>rlm 0.3s</code> and 0 questions.
            </p>
          </div>
          <div className="shrink-0">{testButton('rlm')}</div>
        </div>
        {probeResults.rlm && <ProbeLine r={probeResults.rlm} />}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => runProbe(ALL_TARGETS)}
          disabled={probing.size > 0}
          className="px-4 py-2 bg-white border border-gray-300 text-gray-800 rounded-md hover:bg-gray-50 disabled:opacity-50 text-sm font-medium"
        >
          {probing.size > 0 ? 'Testing…' : 'Test all'}
        </button>
        {probeError && (
          <span className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
            × Test failed: {probeError}
          </span>
        )}
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
        <code className="bg-gray-100 px-1 rounded">ANTHROPIC_API_KEY</code>, <code className="bg-gray-100 px-1 rounded">GEMINI_API_KEY</code>,
        <code className="bg-gray-100 px-1 rounded">TYPESAFE_API_KEY</code>.
        Server picks them up immediately; restart not required.
      </p>
    </div>
  );
}
