'use client';

/**
 * RLM — recursive code Q&A. One card for the three engines an ask can use:
 *   1 Fantom RLM (built-in loop) → 2 Jev checks → 3 ss-rlm-sandbox
 * plus the per-ask time limit. State lives in OpenRouterPanel so the one
 * Save Settings button stores it; only changed fields are sent.
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { RlmPipelineSettings, RlmSandboxMode, RoutingPolicy } from '@/lib/api';

export interface RlmCardDraft {
  pipeline: RlmPipelineSettings;
  /** Jev route-gate threshold, percent. */
  jevPct: number;
}

const SANDBOX_MODES: Array<{ id: RlmSandboxMode; label: string }> = [
  { id: 'off', label: 'Off' },
  { id: 'backup', label: 'Only as backup' },
  { id: 'always', label: 'Always instead of Fantom RLM' },
];
/** Must match SYNTHESIS_RESERVE_MS on the server. */
const ANSWER_RESERVE_SEC = 14;

const selectCls = 'px-2 py-1 border border-gray-300 rounded-md text-sm max-w-full min-w-0';

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-gray-100 pt-3">
      <div className="text-sm font-medium text-gray-800 mb-1">
        <span className="inline-flex items-center justify-center w-5 h-5 mr-1.5 rounded-full bg-purple-100 text-purple-800 text-xs">{n}</span>
        {title}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-gray-700 pl-6">{children}</div>
    </div>
  );
}

export function RlmPipelineCard({
  draft, setDraft, policy, setPolicy, policyOptions, model, setModel, modelOptions, jev, defaultBudgetSec, dirty,
  sandboxKey, setSandboxKey, hasSandboxKey, sandboxKeyLast4,
}: {
  draft: RlmCardDraft;
  setDraft: (d: RlmCardDraft) => void;
  policy: RoutingPolicy;
  setPolicy: (p: RoutingPolicy) => void;
  policyOptions: Array<{ id: RoutingPolicy; label: string }>;
  model: string;
  setModel: (m: string) => void;
  modelOptions: Array<{ id: string; label: string }>;
  jev?: { providerEnabled: boolean; hasKey: boolean; minConfidence: number };
  defaultBudgetSec: number;
  dirty: boolean;
  /** Draft value of the sandbox-only key (cleared after save). */
  sandboxKey: string;
  setSandboxKey: (k: string) => void;
  hasSandboxKey: boolean;
  sandboxKeyLast4: string | null;
}) {
  const p = draft.pipeline;
  const set = (patch: Partial<RlmPipelineSettings>) => setDraft({ ...draft, pipeline: { ...p, ...patch } });
  const always = p.sandboxMode === 'always';
  const { data: hostData, isLoading: hostsLoading } = useQuery({
    queryKey: ['rlm-sandbox-hosts'],
    queryFn: api.getRlmSandboxHosts,
    refetchInterval: 60_000,
  });

  const budget = p.budgetSec ?? defaultBudgetSec;
  const search = Math.min(Number.isFinite(p.retrievalCapSec) ? p.retrievalCapSec : 30, budget);
  const answer = Math.min(ANSWER_RESERVE_SEC, Math.max(0, budget - search));
  const middle = Math.max(0, budget - search - answer);
  const pct = (v: number) => `${budget > 0 ? (v / budget) * 100 : 0}%`;
  const jevUsable = !!jev?.providerEnabled && !!jev?.hasKey;

  return (
    <div className="mt-6 rounded-lg border border-gray-200 p-4 space-y-3 min-w-0">
      <div>
        <h4 className="text-base font-semibold text-gray-900">RLM — recursive code Q&amp;A</h4>
        <p className="text-xs text-gray-500 mt-0.5 flex flex-wrap items-center gap-1">
          Flow:
          <span className={`px-1.5 py-0.5 rounded border ${p.fantomRlm && !always ? 'border-purple-300 bg-purple-50' : 'border-gray-200 text-gray-400 line-through'}`}>1 Fantom RLM</span>
          <span aria-hidden>─▶</span>
          <span className={`px-1.5 py-0.5 rounded border ${p.jevEnabled ? 'border-purple-300 bg-purple-50' : 'border-gray-200 text-gray-400 line-through'}`}>2 Jev checks</span>
          <span aria-hidden>─▶</span>
          <span className={`px-1.5 py-0.5 rounded border ${p.sandboxMode !== 'off' ? 'border-purple-300 bg-purple-50' : 'border-gray-200 text-gray-400 line-through'}`}>3 ss-rlm-sandbox</span>
        </p>
      </div>

      <Step n={1} title="Fantom RLM (built-in loop)">
        <select aria-label="Fantom RLM" className={selectCls} value={p.fantomRlm ? 'on' : 'off'} onChange={(e) => set({ fantomRlm: e.target.value === 'on' })}>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
        <label className="flex items-center gap-1.5 min-w-0">Runs on:
          <select aria-label="RLM route" className={selectCls} value={policy} onChange={(e) => setPolicy(e.target.value as RoutingPolicy)}>
            {policyOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1.5 min-w-0">Model:
          <select aria-label="RLM model" className={`${selectCls} w-64`} value={model} onChange={(e) => setModel(e.target.value)}>
            {modelOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>
        {always && <p className="w-full text-xs text-gray-500">Not used while the sandbox is set to &ldquo;Always&rdquo;.</p>}
      </Step>

      <Step n={2} title="Jev checks">
        <select aria-label="Jev checks" className={selectCls} value={p.jevEnabled ? 'on' : 'off'} onChange={(e) => set({ jevEnabled: e.target.value === 'on' })}>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
        <label className="flex items-center gap-1.5">
          Skip RLM when Jev says &ldquo;direct&rdquo; at ≥
          <input
            type="number" min={0} max={100} aria-label="Jev threshold percent"
            className="w-16 px-2 py-1 border border-gray-300 rounded-md text-sm"
            value={Number.isFinite(draft.jevPct) ? draft.jevPct : ''}
            onChange={(e) => setDraft({ ...draft, jevPct: e.target.value === '' ? NaN : Number(e.target.value) })}
          />%
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={p.jevPlanCoverage} onChange={(e) => set({ jevPlanCoverage: e.target.checked })} /> plan coverage
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={p.jevEvidence} onChange={(e) => set({ jevEvidence: e.target.checked })} /> enough evidence
        </label>
        {!jevUsable && (
          <p className="w-full text-xs text-amber-700">
            Jev is not usable now: {!jev?.providerEnabled ? 'turn on TypeSafe on the LLM Providers page' : 'no TYPESAFE_API_KEY on the server'}. Asks run as if it were off.
          </p>
        )}
        {always && <p className="w-full text-xs text-gray-500">With &ldquo;Always&rdquo;, only the route gate runs. The plan and evidence checks belong to the Fantom loop and do not run.</p>}
      </Step>

      <Step n={3} title="ss-rlm-sandbox">
        <select aria-label="Sandbox mode" className={selectCls} value={p.sandboxMode} onChange={(e) => set({ sandboxMode: e.target.value as RlmSandboxMode })}>
          {SANDBOX_MODES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        <span className="text-xs text-gray-500 min-w-0">Model: {model.startsWith('direct:') ? 'the default sandbox model (a direct: model is not sent to the sandbox)' : `same as Fantom RLM (${model || 'none'})`}</span>
        <span className="flex flex-wrap items-center gap-2 text-xs min-w-0">Hosts:
          {hostsLoading && <span className="text-gray-400">checking…</span>}
          {!hostsLoading && (hostData?.hosts.length ?? 0) === 0 && <span className="text-amber-700">no host runs the rlm-sandbox role</span>}
          {hostData?.hosts.map(h => (
            <span key={h.id} className="flex items-center gap-1" title={h.healthy ? `${h.model ?? ''} ${h.ms ?? ''}ms` : h.error}>
              <span className={`inline-block w-2 h-2 rounded-full ${h.healthy ? 'bg-emerald-500' : 'bg-red-500'}`} />{h.name}
            </span>
          ))}
        </span>
        <label className="w-full flex flex-col gap-1 text-xs text-gray-700 min-w-0">
          Sandbox key (low spending limit)
          <input
            type="password"
            autoComplete="new-password"
            aria-label="Sandbox key (low spending limit)"
            value={sandboxKey}
            onChange={(e) => setSandboxKey(e.target.value)}
            placeholder={hasSandboxKey ? `Stored on this server (••••${sandboxKeyLast4 ?? '????'})` : 'No sandbox key stored'}
            className={`w-full max-w-md px-2 py-1 border rounded-md text-sm font-mono ${!hasSandboxKey && !sandboxKey ? 'border-amber-400' : 'border-gray-300'}`}
          />
          <span className="text-gray-500">
            A separate OpenRouter key with a low limit. Only this key goes to the sandbox; the main key never does.
          </span>
        </label>
        {!hasSandboxKey && !sandboxKey && (
          <p className="w-full text-xs text-amber-700 font-medium">
            Sandbox off: no sandbox key. Add a separate low-limit key above to use ss-rlm-sandbox.
          </p>
        )}
        <p className="w-full text-xs text-amber-700">
          The sandbox runs without Fantom&apos;s code-search tools until the sidecar side is fixed. It sees only
          the context Fantom sends with the question.
        </p>
        <p className="w-full text-xs text-gray-500">
          {p.sandboxMode === 'off' && 'Never used.'}
          {p.sandboxMode === 'backup' && `Gets the whole question once, only when Fantom RLM had no host, failed or found nothing, and at least ${p.sandboxMinSec}s are left.`}
          {always && 'Gets the whole question once, in place of the Fantom loop. Jev in-loop checks do not run.'}
        </p>
      </Step>

      <div className="border-t border-gray-100 pt-3 space-y-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-gray-700">
          <label className="flex items-center gap-1.5">Time limit per ask
            <input
              type="number" min={20} max={900} aria-label="Time limit per ask, seconds"
              className="w-20 px-2 py-1 border border-gray-300 rounded-md text-sm"
              value={p.budgetSec ?? ''}
              placeholder={String(defaultBudgetSec)}
              onChange={(e) => set({ budgetSec: e.target.value === '' ? undefined : Number(e.target.value) })}
            /> s
          </label>
          <label className="flex items-center gap-1.5">Search at most
            <input
              type="number" min={5} max={600} aria-label="Search cap, seconds"
              className="w-20 px-2 py-1 border border-gray-300 rounded-md text-sm"
              value={Number.isFinite(p.retrievalCapSec) ? p.retrievalCapSec : ''}
              onChange={(e) => set({ retrievalCapSec: e.target.value === '' ? NaN : Number(e.target.value) })}
            /> s
          </label>
        </div>
        <div className="flex h-5 w-full overflow-hidden rounded text-[10px] leading-5 text-white" aria-label="Budget split">
          <div className="bg-sky-500 px-1 truncate" style={{ width: pct(search) }} title={`search ≤ ${search}s`}>search ≤{search}s</div>
          <div className="bg-purple-500 px-1 truncate" style={{ width: pct(middle) }} title={`RLM / sandbox ~${middle}s`}>RLM / sandbox ~{middle}s</div>
          <div className="bg-emerald-500 px-1 truncate" style={{ width: pct(answer) }} title={`answer ${answer}s`}>answer {answer}s</div>
        </div>
        <p className="text-xs text-gray-500">The search cap stops the graph step and related-project searches; the main search is never cut.</p>
        {dirty && <p className="text-xs text-blue-700">Unsaved — press Save Settings to store this.</p>}
      </div>
    </div>
  );
}
