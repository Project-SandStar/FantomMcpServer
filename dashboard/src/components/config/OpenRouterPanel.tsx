'use client';

/**
 * The OpenRouter section of the config page.
 *
 * Sections, in order: Live Activity, Connection (key + sandbox slots),
 * Workers, Routing Policy, Credits & Spend, Model Selection, Decision model.
 * Fantom calls OpenRouter itself; sidecars only hold the key for
 * ss-rlm-sandbox. Deliberately NOT here: a curated-models panel and a chat
 * catalogue — Fantom has no chat role, and the model list is three dropdowns'
 * worth of information that does not need a second rendering.
 *
 * No provider name is rendered anywhere. The pin still exists server-side
 * because the vector-compatibility gate needs it — two upstreams serving one
 * model slug can return different vectors — but it is not a thing anyone has
 * to reason about while choosing a model.
 */

import { useState, useEffect } from 'react';
import { RlmPipelineCard, type RlmCardDraft } from './RlmPipelineCard';
import { OpenRouterWorkersCard, workersDraftFrom, workersPatch, type WorkersDraft } from './OpenRouterWorkersCard';
import { DecisionModelCard } from './DecisionModelCard';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  api, VirtualRole, OpenRouterRoleActivity, OpenRouterCatalogueEntry, CompatibilityReport,
  RoutingPolicy, PolicyDrift, PolicyNote, OpenRouterProbeResult,
} from '@/lib/api';

const ACTIVITY_POLL_MS = 4000;
/** A call inside this window still counts the role as "active". */
const RECENT_MS = 30_000;
const ROLES: VirtualRole[] = ['code-embedding', 'embedding', 'reranker', 'code-assistant', 'rlm'];
const ROLE_TITLE: Record<string, string> = {
  'code-embedding': 'Code embedding',
  'embedding': 'Text embedding',
  'reranker': 'Reranker',
  'code-assistant': 'Code assistant',
  'rlm': 'RLM',
};

function fmtAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export function OpenRouterPanel() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['openrouter-config'],
    queryFn: api.getOpenRouterConfig,
  });
  const { data: live } = useQuery({
    queryKey: ['openrouter-activity'],
    queryFn: api.getOpenRouterActivity,
    refetchInterval: ACTIVITY_POLL_MS,
  });

  const [apiKey, setApiKey] = useState('');
  const [sandboxKey, setSandboxKey] = useState('');
  const [models, setModels] = useState<Partial<Record<VirtualRole, string>>>({});
  const [caps, setCaps] = useState<Partial<Record<VirtualRole, string>>>({});
  const [workersDraft, setWorkersDraft] = useState<WorkersDraft | null>(null);
  const [policies, setPolicies] = useState<Partial<Record<VirtualRole, RoutingPolicy>>>({});
  const [note, setNote] = useState<string | null>(null);
  const [rlmDraft, setRlmDraft] = useState<RlmCardDraft | null>(null);

  // Seed the form from the server once, and re-seed when the server's own
  // view changes. Never pre-fill the key field — see the helper text.
  useEffect(() => {
    if (!data) return;
    setModels(Object.fromEntries(
      ROLES.map(r => [
        r,
        r === 'rlm'
          // Seeded from the server's resolved value, which always carries one.
          // Leaving it '' and posting that is how Sound Suite's page clears a
          // configured model on an unrelated save.
          ? (data.rlm?.model ?? '')
          : data.settings.allowedModels[r]?.model ?? data.catalogue.find(c => c.role === r)?.options[0]?.id ?? '',
      ]),
    ));
    setCaps(Object.fromEntries(ROLES.map(r => [r, data.dailyCaps[r] ? String(data.dailyCaps[r]) : ''])));
    setWorkersDraft(workersDraftFrom(data));
    setPolicies({ ...data.policyByRole });
    if (data.rlm?.pipeline) {
      setRlmDraft({
        pipeline: { ...data.rlm.pipeline },
        jevPct: Math.round((data.rlm.jev?.minConfidence ?? 0.7) * 100),
      });
    }
  }, [data]);

  // Only changed RLM fields are sent, so an untouched control never
  // overwrites what is stored.
  const rlmPatch = (() => {
    const stored = data?.rlm?.pipeline;
    if (!rlmDraft || !stored) return {};
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(rlmDraft.pipeline) as Array<keyof typeof rlmDraft.pipeline>) {
      const v = rlmDraft.pipeline[k];
      // A blank number field means "leave alone", not 0.
      if (typeof v === 'number' && !Number.isFinite(v)) continue;
      if (v !== stored[k] && v !== undefined) out[k] = v;
    }
    return out;
  })();
  const storedJevPct = Math.round((data?.rlm?.jev?.minConfidence ?? 0.7) * 100);
  const jevPctChanged = !!rlmDraft && Number.isFinite(rlmDraft.jevPct) && rlmDraft.jevPct >= 1 && rlmDraft.jevPct <= 100 && rlmDraft.jevPct !== storedJevPct;
  const rlmDirty = Object.keys(rlmPatch).length > 0 || jevPctChanged;

  const save = useMutation({
    mutationFn: async () => {
      const allowedModels: Record<string, { model: string }> = {};
      // `rlm` is excluded on purpose. Its policy says which ENDPOINT runs the
      // recursive session; its model is the one the hosted sandbox calls, and
      // the sidecar reads that under the separate `rlm-sandbox` key. Sending
      // it as allowedModels.rlm would store a model nothing reads.
      for (const r of ROLES) if (r !== 'rlm' && models[r]) allowedModels[r] = { model: models[r]! };
      return api.pushOpenRouterConfig({
        apiKey: apiKey || undefined,
        sandboxKey: sandboxKey || undefined,
        ...workersPatch(workersDraft, data),
        policyByRole: policies,
        allowedModels: allowedModels as never,
        dailyCaps: Object.fromEntries(
          ROLES.map(r => [r, caps[r] === '' || caps[r] === undefined ? '' : Number(caps[r])]),
        ) as never,
        // Send these ONLY when they differ from what the server holds. An
        // unchanged control has no business appearing in a write — that is
        // how an unrelated save clears a configured model on the Sound Suite
        // page, and the server treats blank as "no change" as a second line
        // of defence.
        ...(models['rlm'] && models['rlm'] !== data?.rlm?.model ? { rlmSandboxModel: models['rlm'] } : {}),
        ...(Object.keys(rlmPatch).length ? { rlmPipeline: rlmPatch } : {}),
        ...(jevPctChanged ? { jevMinConfidence: rlmDraft!.jevPct } : {}),
      });
    },
    onSuccess: (r) => {
      setApiKey(''); // never keep it in component state after the push
      setSandboxKey('');
      setNote(r.note);
      void qc.invalidateQueries({ queryKey: ['openrouter-config'] });
      void qc.invalidateQueries({ queryKey: ['openrouter-activity'] });
      void qc.invalidateQueries({ queryKey: ['openrouter-credits'] });
    },
    onError: (e: Error) => setNote(e.message),
  });

  // Live read from OpenRouter: not polled, refreshed by the button.
  const creditsQ = useQuery({
    queryKey: ['openrouter-credits'],
    queryFn: api.getOpenRouterCredits,
    enabled: !!data?.hasKey,
    staleTime: 60_000,
  });

  const [verifyResult, setVerifyResult] = useState<{ reports: CompatibilityReport[]; error?: string } | null>(null);
  const verify = useMutation({
    mutationFn: api.verifyOpenRouterVectors,
    onSuccess: (r) => setVerifyResult({ reports: r.reports }),
    onError: (e: Error) => setVerifyResult({ reports: [], error: e.message }),
  });

  // Live round trips. Each result replaces only its own role, so "Test all"
  // and a single "Test" share one map and never wipe each other's rows.
  const [probes, setProbes] = useState<Partial<Record<VirtualRole, OpenRouterProbeResult>>>({});
  const test = useMutation({
    mutationFn: (roles?: VirtualRole[]) => api.testOpenRouter(roles ? { roles } : {}),
    onSuccess: (r) => setProbes(prev => ({ ...prev, ...Object.fromEntries(r.results.map(x => [x.role, x])) })),
    onError: (e: Error) => setNote(`Test failed: ${e.message}`),
  });
  const testing = (role: VirtualRole): boolean =>
    test.isPending && (test.variables === undefined || test.variables.includes(role));
  /** The pushed model for a role: the only one a test can exercise. */
  const storedModel = (role: VirtualRole): string | undefined =>
    role === 'rlm' ? data?.rlm?.model : data?.settings.allowedModels[role]?.model;

  if (isLoading || !data) return <div className="text-sm text-gray-500">Loading…</div>;

  const activity = live?.activity ?? data.activity;
  const credits = creditsQ.data?.credits ?? null;
  const remaining = credits?.limitRemaining ?? (
    credits?.totalCredits !== undefined && credits?.totalUsage !== undefined ? credits.totalCredits - credits.totalUsage : null
  );
  const nowMs = live?.nowMs ?? Date.now();
  const spendToday = live?.spendToday ?? data.spendToday;

  return (
    <div className="space-y-8">
      {/* ── 1. LIVE ACTIVITY ─────────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold text-gray-900">Live Activity</h3>
          <span className="text-xs text-gray-400">refreshes every {ACTIVITY_POLL_MS / 1000}s</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {ROLES.map(role => (
            <ActivityCard
              key={role}
              label={ROLE_TITLE[role]}
              data={activity.find(a => a.role === role)}
              nowMs={nowMs}
            />
          ))}
        </div>
      </section>

      {/* ── 2. CONNECTION ────────────────────────────────────────────── */}
      <section>
        <h3 className="text-lg font-semibold text-gray-900 mb-3">Connection</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={data.hasKey ? `Stored on this server (••••${data.keyLast4 ?? '????'})` : 'No key stored'}
              className={`w-full px-3 py-2 border rounded-md text-sm font-mono ${!data.hasKey && !apiKey ? 'border-red-400' : 'border-gray-300'}`}
            />
            {!data.hasKey && !apiKey && (
              <p className="mt-1 text-xs text-red-700">
                No key stored. Paste your key here, then press Save Settings.
              </p>
            )}
            <p className="text-xs text-gray-500 mt-1">
              {data.hasKey
                ? `${data.keySource === 'env' ? 'The key comes from the server env.' : 'The key is stored on this server.'} Leave blank to keep it. Paste a new key to replace it.`
                : 'Paste your key and press Save Settings. It is stored on this server only and is never shown again.'}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => save.mutate()}
              disabled={save.isPending}
              className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:opacity-50"
            >
              {save.isPending ? 'Saving…' : 'Save Settings'}
            </button>
          </div>

          {note && <p className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded p-2 whitespace-pre-line">{note}</p>}

          {/* Sandbox slots: the only thing sidecars still hold for Fantom. */}
          <div>
            <h4 className="text-sm font-medium text-gray-700 mb-1">Sandbox slots</h4>
            <p className="text-xs text-gray-500 mb-1">
              Sidecars only hold Fantom&apos;s separate sandbox key for ss-rlm-sandbox. Everything else calls OpenRouter directly.
            </p>
            {data.slots.length === 0 ? (
              <p className="text-xs text-gray-400">No sidecar reports a slot.</p>
            ) : (
              <ul className="text-xs text-gray-700 space-y-0.5">
                {data.slots.map(s => (
                  <li key={s.sidecarId}>
                    <span className={s.openrouter === 'configured' ? 'text-green-700' : s.openrouter === 'unset' ? 'text-amber-600' : 'text-gray-400'}>●</span>{' '}
                    {s.name} · {s.openrouter}
                    {s.lastPushAt
                      ? ` · last push ${s.lastPushOk ? 'ok' : 'failed'} ${fmtAgo(s.lastPushAt, nowMs)}`
                      : ' · not pushed yet'}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      {workersDraft && (
        <OpenRouterWorkersCard data={data} live={live} draft={workersDraft} setDraft={setWorkersDraft} />
      )}

      {/* ── 3. ROUTING POLICY ────────────────────────────────────────── */}
      <section>
        <h3 className="text-lg font-semibold text-gray-900 mb-1">Routing Policy</h3>
        <p className="text-xs text-gray-500 mb-3">
          How each role uses the GPUs and the cloud — whether they work together, take turns, or whether one
          of them is off. &ldquo;OpenRouter only&rdquo; is the one choice that takes the GPUs out of a role,
          and for the embedders it changes what the index <em>is</em>; read the note under it before picking
          it.
        </p>

        <div className="space-y-4">
          {data.catalogue.filter(c => c.role !== 'rlm').map(c => {
            const localVectors = data.storedVectorOrigin?.local ?? { providers: [], texts: 0, projects: 0 };
            const drift = data.policyDrift.find((d: PolicyDrift) => d.role === c.role);
            const note = data.policyNotes.find((n: PolicyNote) => n.role === c.role);
            const chosen = policies[c.role] ?? 'aggregate';
            const dirty = chosen !== data.policyByRole[c.role];
            return (
              <div key={c.role}>
                <label className="block text-sm font-medium text-gray-700 mb-1">{c.label}</label>
                <select
                  value={chosen}
                  onChange={(e) => setPolicies({ ...policies, [c.role]: e.target.value as RoutingPolicy })}
                  className="w-full md:w-96 px-3 py-2 border border-gray-300 rounded-md text-sm"
                >
                  {(data.policyOptionsByRole?.[c.role] ?? data.policyOptions).map(o => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">{policyHint(chosen, note)}</p>

                {/* The two costs of "OpenRouter only", stated before it is
                    saved rather than discovered afterwards. Neither is
                    reversible by flipping the dropdown back: the index has to
                    be rebuilt in whichever direction you move. */}
                {chosen === 'cloud' && isEmbeddingRole(c.role) && (
                  <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2 mt-1 space-y-1">
                    <p>
                      <strong>Every search costs a cloud round trip.</strong> The query has to be embedded by
                      the same providers that built the index, so each search waits on OpenRouter — hundreds
                      of milliseconds, against single-digit milliseconds on a local GPU. Fantom will not
                      quietly encode a query locally instead: if no cloud provider can serve, the search
                      fails and says why.
                    </p>
                    <p>
                      <strong>The whole index has to be rebuilt on cloud.</strong> Local Ollama serves this
                      model quantised (Q4_K_M) and the hosted providers run it at full precision; measured
                      agreement between them is 0.976, against 0.9986 between two local hosts. They are not
                      one vector space, so existing local vectors become unusable under this policy — and
                      vectors built under it become unusable if you switch back.
                    </p>
                    {/* The width mismatch is a harder stop than the precision
                        one and needs saying separately: LanceDB locks the
                        vector column when the table is created, so this is not
                        "the vectors disagree", it is "no cloud provider can
                        write into this table at all" until it is rebuilt. Live
                        for the docs embedder, whose table is 1024d while every
                        hosted model is 1536d or wider. */}
                    {(() => {
                      const tableW = data.tableDims?.[c.role];
                      const modelW = c.options.find(o => o.id === models[c.role])?.dims;
                      if (!tableW || !modelW || tableW === modelW) return null;
                      return (
                        <p className="text-red-800">
                          <strong>This table has to be rebuilt before cloud can serve it.</strong> It is{' '}
                          <code>{tableW}d</code> and the selected model produces <code>{modelW}d</code>.
                          LanceDB fixes the vector width when the table is created, so until it is rebuilt
                          at {modelW}d no OpenRouter provider passes the compatibility gate and every
                          search on this role will fail with that reason rather than return local results.
                        </p>
                      );
                    })()}
                    {/* code_vectors ONLY. `storedVectorOrigin` is built from
                        projectEmbeddingMeta, which covers the per-project code
                        table; docs vectors are not projects and are not counted
                        there. While "OpenRouter only" was withheld from the
                        docs embedder this block could not be reached for it —
                        now that it can, showing 971 projects and 227,561 texts
                        under Text embedding would bill the code index's cost to
                        a 14,351-row table nobody is touching. */}
                    {c.role === 'code-embedding' && localVectors.texts > 0 && (
                      <p>
                        <strong>
                          {localVectors.projects} project{localVectors.projects === 1 ? '' : 's'} in this
                          index {localVectors.projects === 1 ? 'was' : 'were'} last embedded locally
                        </strong>{' '}
                        ({localVectors.texts.toLocaleString()} texts, by {localVectors.providers.join(', ')}).
                        Saving this invalidates {localVectors.projects === 1 ? 'it' : 'them'}: re-embed on
                        cloud from the Vectors page, or searches will rank against rows the cloud query
                        encoder cannot match.
                      </p>
                    )}
                    {c.role === 'embedding' && (
                      <p>
                        <strong>This rebuilds the docs table, not the code one.</strong>{' '}
                        <code>docs_vectors</code> holds indexed documentation in one table rather than one
                        per project, so re-embedding it is a single job — 14,351 rows today. The code index
                        is governed by the Code embedding policy above and is untouched by this setting.
                      </p>
                    )}
                  </div>
                )}

                {/* A stored setting that never reached the sidecars is NOT in
                    effect, and must not be shown as though it were. */}
                {drift?.pending && !dirty && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 mt-1">
                    Stored but <strong>not in effect</strong>: the sidecars still report{' '}
                    <code>{drift.actualModes.join(', ')}</code> for this role, not <code>{drift.wantMode}</code>.
                    Press Save Settings to push it.
                  </p>
                )}
                {dirty && (
                  <p className="text-xs text-blue-700 mt-1">
                    Unsaved. Press Save Settings.
                  </p>
                )}
              </div>
            );
          })}
        </div>
        {/* RLM: route + model + Jev + sandbox + time limit, as one flow. */}
        {rlmDraft && data.rlm && (() => {
          const rlmCat = data.catalogue.find(c => c.role === 'rlm');
          return (
            <RlmPipelineCard
              draft={rlmDraft}
              setDraft={setRlmDraft}
              policy={policies['rlm'] ?? 'local'}
              setPolicy={(p) => setPolicies({ ...policies, rlm: p })}
              policyOptions={data.policyOptionsByRole?.['rlm'] ?? data.policyOptions}
              model={models['rlm'] ?? ''}
              setModel={(m) => setModels({ ...models, rlm: m })}
              modelOptions={rlmCat?.options ?? data.rlm.options}
              jev={data.rlm.jev}
              defaultBudgetSec={data.rlm.defaultBudgetSec ?? 120}
              sandboxKey={sandboxKey}
              setSandboxKey={setSandboxKey}
              hasSandboxKey={!!data.hasSandboxKey}
              sandboxKeyLast4={data.sandboxKeyLast4 ?? null}
              dirty={!!sandboxKey || rlmDirty || (policies['rlm'] !== data.policyByRole['rlm']) || (!!models['rlm'] && models['rlm'] !== data.rlm.model)}
            />
          );
        })()}
      </section>

      {/* ── 4. CREDITS & SPEND ───────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold text-gray-900">Credits &amp; Spend</h3>
          <button
            type="button"
            onClick={() => void creditsQ.refetch()}
            disabled={!data.hasKey || creditsQ.isFetching}
            className="text-xs text-blue-600 hover:underline disabled:text-gray-400 disabled:no-underline"
          >
            {creditsQ.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
          <Stat label="Remaining" value={money(remaining)} />
          <Stat label="Total credits" value={money(credits?.totalCredits)} />
          <Stat label="Total usage" value={money(credits?.totalUsage ?? credits?.usage)} />
          <Stat label="Spent today (all roles)" value={`$${spendToday.toFixed(4)}`} />
        </div>
        {!data.hasKey && <p className="text-xs text-gray-500 mb-4">No key stored, so credits cannot be read.</p>}
        {creditsQ.data && !creditsQ.data.ok && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 mb-4">
            Credits could not be read{creditsQ.data.reason ? `: ${creditsQ.data.reason}` : '.'}
          </p>
        )}
        {creditsQ.error && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 mb-4">
            Credits could not be read: {(creditsQ.error as Error).message}
          </p>
        )}
        {credits?.rateLimit?.requests !== undefined && (
          <p className="text-xs text-gray-500 mb-4">
            Account rate limit: {credits.rateLimit.requests} requests per {credits.rateLimit.interval ?? '?'}
            {credits.isFreeTier ? ' · free tier' : ''}
          </p>
        )}

        <h4 className="text-sm font-medium text-gray-700 mb-2">
          Daily spend caps (USD, per role — 0 or blank = uncapped)
        </h4>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {ROLES.map(role => {
            const a = activity.find(x => x.role === role);
            return (
              <div key={role}>
                <label className="block text-xs text-gray-600 mb-1">{ROLE_TITLE[role]}</label>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={caps[role] ?? ''}
                  onChange={(e) => setCaps({ ...caps, [role]: e.target.value })}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm"
                />
                <p className={`text-xs mt-1 ${a?.capped ? 'text-red-600' : 'text-gray-500'}`}>
                  today: ${(a?.spendTodayUsd ?? 0).toFixed(4)}{a?.capped ? ' · cap reached' : ''}
                </p>
              </div>
            );
          })}

        </div>
        <p className="text-xs text-gray-500 mt-3">
          Fantom uses one OpenRouter key for all roles. The Workers card above sets how many requests run at once.
        </p>
      </section>

      {/* ── 5. MODEL SELECTION ───────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold text-gray-900">Model Selection</h3>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => verify.mutate()}
              disabled={verify.isPending}
              title="Embed up to 10 stored row texts per role and compare with the stored vectors. Writes nothing."
              className="px-3 py-1.5 text-xs border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
            >
              {verify.isPending ? 'Verifying…' : 'Verify vectors'}
            </button>
            <button
              type="button"
              onClick={() => test.mutate(undefined)}
              disabled={test.isPending}
              title="One live request per role, with the saved key and model."
              className="px-3 py-1.5 text-xs border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
            >
              {test.isPending && test.variables === undefined ? 'Testing all…' : 'Test all'}
            </button>
          </div>
        </div>
        {verifyResult && (
          <div className="text-xs mb-4 border border-gray-200 rounded p-2 bg-gray-50 space-y-0.5">
            {verifyResult.error ? (
              <div className="text-red-600">Verify failed: {verifyResult.error}</div>
            ) : verifyResult.reports.length === 0 ? (
              <div className="text-gray-600">Nothing to verify: no OpenRouter embedder is in use.</div>
            ) : verifyResult.reports.map(r => (
              <div key={r.key} className={r.ok ? 'text-green-700' : 'text-red-700'}>
                {r.providerName}: {r.ok ? 'ok' : 'refused'}
                {r.minCosine !== undefined ? ` · min cosine ${r.minCosine.toFixed(4)}` : ''} · {r.reason}
              </div>
            ))}
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {data.catalogue.filter((c: OpenRouterCatalogueEntry) => c.role !== 'rlm').map((c: OpenRouterCatalogueEntry) => {
            const stored = storedModel(c.role);
            const unsaved = !!models[c.role] && models[c.role] !== stored;
            return (
              <div key={c.role}>
                <Picker
                  label={c.label}
                  value={models[c.role] ?? ''}
                  onChange={(v) => setModels({ ...models, [c.role]: v })}
                  options={c.options}
                  hint={c.hint}
                  notServedYet={c.servable === false}
                />
                <div className="flex items-center gap-2 mt-1">
                  <button
                    type="button"
                    onClick={() => test.mutate([c.role])}
                    disabled={test.isPending}
                    className="px-2 py-1 text-xs border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
                  >
                    {testing(c.role) ? 'Testing…' : 'Test'}
                  </button>
                  {/* A test can only exercise what is pushed. Say so next to
                      the button, or a pass on the old model reads as a pass
                      on the new one. */}
                  {unsaved && (
                    <span className="text-xs text-amber-700">
                      tests the saved model{stored ? <> <code>{stored}</code></> : null}, not this unsaved choice
                    </span>
                  )}
                </div>
                {probes[c.role] && <ProbeLine r={probes[c.role]!} />}
              </div>
            );
          })}
        </div>
        <p className="text-xs text-gray-500 mt-3">
          A cloud embedding provider still has to pass the vector-compatibility check — same texts, local vs
          cloud, cosine ≥ 0.99 at exactly {data.codeTableDims}d — before it may serve a single text into the
          table.
        </p>
      </section>

      <DecisionModelCard />
    </div>
  );
}

/**
 * What each choice actually does, in terms of the machines rather than the
 * protocol. The re-index / contention consequences are the part worth stating:
 * they are why "SideCar + OpenRouter" is not simply "turn both on".
 */
/** The two roles whose vectors share one table, and so carry the re-index cost. */
function isEmbeddingRole(role: VirtualRole): boolean {
  return role === 'code-embedding' || role === 'embedding';
}

function policyHint(policy: RoutingPolicy, note?: PolicyNote): string {
  if (policy === 'local') {
    return 'Only the sidecar GPUs serve this role. Nothing calls out to OpenRouter, even if a cloud '
      + 'provider is still registered.';
  }
  if (policy === 'cloud') {
    // Deliberately not "aggregate with the GPUs off": for an embedder it
    // changes what the index is, and the panel has to say that before the
    // re-index cost is discovered rather than chosen.
    return 'Only OpenRouter serves this role. The sidecar GPUs are excluded even when they are healthy and '
      + 'idle — this is the one policy where they do not take part at all.';
  }
  if (policy === 'backup') {
    return 'The sidecar GPUs serve. OpenRouter is used only when no healthy local provider exists, or the '
      + 'local request fails — so a GPU coming back takes the traffic again.';
  }
  if (note && !note.aggregateMeaningful) {
    // Role-agnostic on purpose: this branch fires for every role whose work is
    // one indivisible call (reranking a set, producing a completion), so
    // naming reranking here mislabelled the Code assistant picker.
    return 'This role is a single call, so there is no fan-out to spread across providers — it behaves '
      + 'exactly like "as backup" here.';
  }
  return 'The sidecar GPUs and OpenRouter work at the same time, both pulling from the same queue and '
    + 'weighted by measured speed, so capacity adds up. Cloud requests are capped by the shared call limit '
    + 'below, and a cloud provider must still pass the compatibility check before it serves anything.';
}

function money(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `$${v.toFixed(2)}`;
}

function ProbeLine({ r }: { r: OpenRouterProbeResult }) {
  const cls = r.ok
    ? 'text-green-700 bg-green-50 border-green-200'
    : 'text-red-700 bg-red-50 border-red-200';
  return (
    <div className={`text-xs border rounded px-2 py-1 mt-1 ${cls} break-words`}>
      {r.ok ? '✓' : '×'} {r.ms} ms · {r.model ?? 'no model'}
      {r.servedModel ? <> (served as <code>{r.servedModel}</code>)</> : null}
      {' '}· {r.route} · {r.message}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-lg font-semibold text-gray-900">{value}</div>
    </div>
  );
}

function Picker({
  label, value, onChange, options, hint, notServedYet,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { id: string; label: string }[];
  /** States the local model and width, so the re-index consequence of a
   *  mismatch is visible at the point of choice. */
  hint?: string;
  /** The setting stores and pushes, but nothing issues the request yet. */
  notServedYet?: boolean;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label}
        {notServedYet && (
          <span
            className="ml-2 text-xs font-normal px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 border border-gray-200"
            title="The choice is stored and pushed to the sidecars, but no code path issues this request yet."
          >
            not wired up yet
          </span>
        )}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
      >
        {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
      {/* Do not let a dropdown look live when nothing consumes it — that is
          the same "stored but inert" failure as a policy that never reached
          the sidecars, arriving through a third door. */}
      {notServedYet && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 mt-1">
          Saved and pushed to the sidecars, but <strong>nothing calls it yet</strong>: the sidecar has no
          chat action, and askCodebase still uses its existing synthesis provider. Your choice is stored and
          will take effect once both are wired.
        </p>
      )}
    </div>
  );
}

function ActivityCard({
  label, data, nowMs,
}: {
  label: string;
  data?: OpenRouterRoleActivity;
  nowMs: number;
}) {
  const d = data ?? {
    role: 'embedding' as VirtualRole, callsToday: 0, tokensToday: 0, spendTodayUsd: 0,
    inFlight: 0, lastCall: null, callsByServedBy: {}, capped: false,
  };
  const active = d.inFlight > 0 || (d.lastCall != null && nowMs - d.lastCall.at < RECENT_MS);
  const everCalled = d.callsToday > 0 || d.lastCall != null;
  const sources = Object.entries(d.callsByServedBy).sort((a, b) => b[1] - a[1]);

  return (
    <div className={`border rounded-md p-4 space-y-3 ${active ? 'border-green-300 bg-green-50' : 'border-gray-200 bg-white'}`}>
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-gray-800">{label}</div>
        <span className={`text-xs px-2 py-0.5 rounded-full ${
          active ? 'bg-green-100 text-green-800'
            : everCalled ? 'bg-gray-100 text-gray-600' : 'bg-gray-50 text-gray-400'
        }`}>
          {active
            ? `active${d.inFlight > 0 ? ` · ${d.inFlight} in flight` : ''}`
            : everCalled ? 'idle' : 'never called'}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <div className="text-gray-400">Calls today</div>
          <div className="text-gray-900 font-semibold">{d.callsToday}</div>
        </div>
        <div>
          <div className="text-gray-400">Tokens today</div>
          <div className="text-gray-900 font-semibold">{d.tokensToday.toLocaleString()}</div>
        </div>
        <div>
          <div className="text-gray-400">Spent today</div>
          <div className="text-gray-900 font-semibold">${d.spendTodayUsd.toFixed(4)}</div>
        </div>
      </div>

      <div className="text-xs text-gray-500">
        {d.lastCall ? (
          <>
            Last call: {fmtAgo(d.lastCall.at, nowMs)} · {d.lastCall.durationMs}ms ·{' '}
            <span className={d.lastCall.success ? 'text-gray-700' : 'text-red-600'}>
              {d.lastCall.success ? d.lastCall.servedBy : 'failed'}
            </span>
          </>
        ) : 'No calls yet'}
      </div>

      {sources.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {sources.map(([servedBy, count]) => (
            <span
              key={servedBy}
              className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-100"
              title={servedBy}
            >
              {servedBy}: {count}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
