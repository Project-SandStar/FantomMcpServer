'use client';

import type { FantomSettings, LLMProviderName } from '@/lib/api';
import { PROVIDER_MODELS, DEFAULT_PROVIDER_MODELS, RERANKER_MODELS } from '@/lib/llmModels';
import { RunFromSidecarToggle } from './RunFromSidecarToggle';

const inputClass = "w-full rounded-md border border-gray-300 py-2 px-3 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";
const labelClass = "block text-xs font-medium text-gray-600 mb-1";

const PROVIDERS: { id: LLMProviderName; label: string }[] = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'groq', label: 'Groq' },
  { id: 'gemini', label: 'Gemini' },
];

export function AdvancedSearchPanel({
  formData,
  setFormData,
}: {
  formData: FantomSettings;
  setFormData: (s: FantomSettings) => void;
}) {
  const llm = formData.semanticSearch.llmReranker ?? { enabled: false };
  const xe = formData.semanticSearch.crossEncoderReranker ?? { enabled: false };

  const setLlm = (patch: Partial<NonNullable<FantomSettings['semanticSearch']['llmReranker']>>) => {
    setFormData({
      ...formData,
      semanticSearch: { ...formData.semanticSearch, llmReranker: { ...llm, ...patch } as any },
    });
  };
  const setXe = (patch: Partial<NonNullable<FantomSettings['semanticSearch']['crossEncoderReranker']>>) => {
    setFormData({
      ...formData,
      semanticSearch: { ...formData.semanticSearch, crossEncoderReranker: { ...xe, ...patch } as any },
    });
  };

  const llmProvider: LLMProviderName = llm.provider ?? 'anthropic';
  const llmModel = llm.model ?? DEFAULT_PROVIDER_MODELS[llmProvider];

  // RLM Answer (Q&A synthesis)
  type AnswerSynthesis = NonNullable<FantomSettings['semanticSearch']['answerSynthesis']>;
  type AnswerProvider = NonNullable<AnswerSynthesis['provider']>;
  const ANSWER_PROVIDERS: { id: AnswerProvider; label: string }[] = [
    { id: 'auto', label: 'Auto — route by complexity (recommended)' },
    { id: 'sidecar', label: 'Sidecar (qwen3.5:9b — on-prem)' },
    { id: 'groq', label: 'Groq' },
    { id: 'anthropic', label: 'Anthropic' },
    { id: 'gemini', label: 'Gemini' },
  ];
  const ANSWER_DEFAULT_MODELS: Record<AnswerProvider, string> = {
    auto: '',
    sidecar: 'qwen3.5:9b',
    groq: 'llama-3.3-70b-versatile',
    anthropic: DEFAULT_PROVIDER_MODELS.anthropic,
    gemini: DEFAULT_PROVIDER_MODELS.gemini,
  };
  const ans: AnswerSynthesis = formData.semanticSearch.answerSynthesis ?? { enabled: false };
  const setAns = (patch: Partial<AnswerSynthesis>) => {
    setFormData({
      ...formData,
      semanticSearch: { ...formData.semanticSearch, answerSynthesis: { ...ans, ...patch } as AnswerSynthesis },
    });
  };
  const ansProvider: AnswerProvider = ans.provider ?? 'auto';
  const ansModel = ans.model ?? ANSWER_DEFAULT_MODELS[ansProvider];

  // Retrieval quality (query-time only; never re-embeds)
  const sem = formData.semanticSearch;
  const qi = sem.queryInstruction ?? 'auto';
  const hybrid = sem.hybrid ?? { enabled: true, vectorWeight: 1.0, keywordWeight: 0.7 };
  const rerankMode = sem.rerank ?? 'auto';
  const setSem = (patch: Partial<FantomSettings['semanticSearch']>) =>
    setFormData({ ...formData, semanticSearch: { ...sem, ...patch } });
  const setHybrid = (patch: Partial<NonNullable<FantomSettings['semanticSearch']['hybrid']>>) =>
    setSem({ hybrid: { ...hybrid, ...patch } });

  return (
    <div className="pt-4 border-t border-gray-200 space-y-5">
      <div>
        <h3 className="text-sm font-medium text-gray-900 mb-1">Advanced search</h3>
        <p className="text-xs text-gray-500">
          Optional layers on top of vector retrieval. Cross-encoder rerank uses a sidecar
          model (e.g. Qwen3-Reranker-8B on vLLM); LLM rerank/rewrite uses one of your
          cloud providers (Groq / Anthropic / Gemini).
        </p>
      </div>

      {/* Retrieval quality: query instruction, hybrid RRF, rerank mode */}
      <div className="border border-gray-200 rounded-md p-4 space-y-3">
        <div>
          <h4 className="text-sm font-semibold text-gray-900">Retrieval</h4>
          <p className="text-xs text-gray-500 mt-0.5">
            Query-time only — changing these never re-embeds. Pipeline: instruction-wrapped query →
            vector top-50 ⊕ keyword (symbol index) top-50 fused with RRF (k=60) → reranker over the fused top-50.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={labelClass}>Query instruction</label>
            <select className={inputClass} value={qi === 'auto' || qi === 'off' ? qi : 'auto'}
              onChange={e => setSem({ queryInstruction: e.target.value as 'auto' | 'off' })}>
              <option value="auto">Auto (Qwen3-Embedding only)</option>
              <option value="off">Off</option>
            </select>
            <p className="mt-1 text-xs text-gray-500">
              Qwen3-Embedding gets <code>Instruct: …\nQuery: …</code> on the query side.
            </p>
          </div>
          <div>
            <label className={labelClass}>Hybrid (vector + keyword)</label>
            <label className="flex items-center gap-2 text-sm py-2">
              <input type="checkbox" checked={hybrid.enabled}
                onChange={e => setHybrid({ enabled: e.target.checked })} />
              <span>Enabled</span>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelClass}>Vector w.</label>
                <input type="number" min={0} max={5} step={0.1} className={inputClass}
                  value={hybrid.vectorWeight ?? 1.0} disabled={!hybrid.enabled}
                  onChange={e => setHybrid({ vectorWeight: Math.max(0, parseFloat(e.target.value) || 0) })} />
              </div>
              <div>
                <label className={labelClass}>Keyword w.</label>
                <input type="number" min={0} max={5} step={0.1} className={inputClass}
                  value={hybrid.keywordWeight ?? 0.7} disabled={!hybrid.enabled}
                  onChange={e => setHybrid({ keywordWeight: Math.max(0, parseFloat(e.target.value) || 0) })} />
              </div>
            </div>
          </div>
          <div>
            <label className={labelClass}>Rerank</label>
            <select className={inputClass} value={rerankMode}
              onChange={e => setSem({ rerank: e.target.value as 'auto' | 'on' | 'off' })}>
              <option value="auto">Auto (when a reranker sidecar is up)</option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
            <p className="mt-1 text-xs text-gray-500">
              Reranks the fused top-50 (8 s timeout, falls back to fused order). Model / top-K below.
            </p>
          </div>
        </div>
      </div>

      {/* Cross-encoder reranker (sidecar) */}
      <div className="border border-gray-200 rounded-md p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-semibold text-gray-900">Cross-encoder reranker</h4>
            <p className="text-xs text-amber-700">Reranker works from sidecar only.</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Pipeline: query embedded with qwen3 → top-K from LanceDB → reranker scores them →
              optional LLM search reads ranked snippets and returns the answer.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={xe.enabled}
              onChange={e => setXe({ enabled: e.target.checked })} />
            <span>Enabled</span>
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClass}>Reranker model</label>
            <select className={inputClass}
              value={xe.model ?? RERANKER_MODELS.find(m => m.recommended)!.id}
              onChange={e => setXe({ model: e.target.value })}>
              {RERANKER_MODELS.map(m => (
                <option key={m.id} value={m.id}>
                  {m.label}{m.recommended ? ' (recommended)' : ''}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500">
              Sidecar must advertise this model under <code>capabilities.reranker.models</code>.
            </p>
          </div>
          <div>
            <label className={labelClass}>Rerank top-K</label>
            <input type="number" min={5} max={200} className={inputClass}
              value={xe.topK ?? 50}
              onChange={e => setXe({ topK: parseInt(e.target.value, 10) || 50 })} />
            <p className="mt-1 text-xs text-gray-500">
              Pull this many candidates from LanceDB, then rerank.
            </p>
          </div>
        </div>
      </div>

      {/* LLM Search and Chat (cloud providers) */}
      <div className="border border-gray-200 rounded-md p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-semibold text-gray-900">LLM Search and Chat</h4>
            <p className="text-xs text-gray-500">
              Calls the provider chosen below to score top-K candidates. Keys are managed
              in the <a href="#llm-providers" className="text-blue-600 underline">LLM Providers</a> tab.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={llm.enabled}
              onChange={e => setLlm({ enabled: e.target.checked })} />
            <span>Enabled</span>
          </label>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={labelClass}>Provider</label>
            <select className={inputClass} value={llmProvider}
              onChange={e => setLlm({ provider: e.target.value as LLMProviderName, model: undefined })}>
              {PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>
          <div>
            <label className={labelClass}>Model</label>
            <select className={inputClass} value={llmModel}
              onChange={e => setLlm({ model: e.target.value })}>
              {PROVIDER_MODELS[llmProvider].map(m => (
                <option key={m.id} value={m.id}>
                  {m.label}{m.recommended ? ' (recommended)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>Rerank top-K</label>
            <input type="number" min={5} max={100} className={inputClass}
              value={llm.topK ?? 20}
              onChange={e => setLlm({ topK: parseInt(e.target.value, 10) || 20 })} />
          </div>
        </div>
        <RunFromSidecarToggle
          accent="gray"
          on={!!llm.fromSidecar}
          onChange={v => setLlm({ fromSidecar: v })}
          hint={llm.fromSidecar ? 'Calls are internal to your own GPU' : 'Calls cloud provider in LLM Providers'}
        />
      </div>

      {/* RLM Answer (Q&A synthesis) */}
      <div className="border border-gray-200 rounded-md p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-semibold text-gray-900">RLM Answer (Q&amp;A synthesis)</h4>
            <p className="text-xs text-gray-500">
              Synthesizes a cited natural-language answer from the top vector-search results.
              Powers the &quot;RLM Answer&quot; mode in the Vector Viewer.
            </p>
            <p className="text-xs text-amber-700 mt-0.5">
              Default follows the provider's recommended model (Gemini 3.8 Flash, Claude Fable 5.1); pick sidecar
              qwen3.5:9b to keep answers fully on-prem.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={ans.enabled}
              onChange={e => setAns({ enabled: e.target.checked })} />
            <span>Enabled</span>
          </label>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={labelClass}>Provider</label>
            <select className={inputClass} value={ansProvider}
              onChange={e => setAns({ provider: e.target.value as AnswerProvider, model: undefined })}>
              {ANSWER_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>
          <div>
            <label className={labelClass}>Model</label>
            <input type="text" className={inputClass}
              value={ansModel}
              placeholder={ANSWER_DEFAULT_MODELS[ansProvider]}
              onChange={e => setAns({ model: e.target.value })} />
          </div>
          <div>
            <label className={labelClass}>Top-K</label>
            <input type="number" min={1} max={50} className={inputClass}
              value={ans.topK ?? 8}
              onChange={e => setAns({ topK: parseInt(e.target.value, 10) || 8 })} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={ans.includeHistory ?? true}
            onChange={e => setAns({ includeHistory: e.target.checked })} />
          <span>Include conversation history</span>
        </label>
      </div>
    </div>
  );
}
