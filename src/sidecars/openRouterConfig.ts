/**
 * Pushing Fantom's OpenRouter config to the sidecar fleet.
 *
 * The sidecar scopes its OpenRouter key, allow-list and routing modes PER
 * MASTER (`virtual-inference.ts`, `G.byMaster` keyed on serverUrl). An absent
 * entry means local-only for every role. That is why Fantom currently sees no
 * cloud capacity even though the sidecars have OpenRouter configured: the
 * config belongs to the Sound Suite master's slot, and a master's key is
 * never applied to a request that arrived under a different slot.
 *
 * So Fantom has to push its own. This module is that push.
 *
 * ── Key hygiene ────────────────────────────────────────────────────────────
 *
 * The key is WRITE-ONLY here. It arrives on the admin request, goes straight
 * out over the WS frame, and is never written to config, never logged, never
 * returned by any endpoint, and never held past the call. What Fantom
 * persists is only what it is safe to persist: which roles have a model
 * mapped, which upstream provider is pinned, the routing modes, and the fact
 * that a push happened. The sidecar holds the key, exactly as before; Fantom
 * is now the thing that hands it over, not a second place it lives.
 *
 * Re-pushing without a key is supported and is the normal case for changing a
 * mode or a model: the sidecar merges a partial push onto the entry it
 * already has (`setOpenRouterConfig` keeps `existing?.apiKey`). The one time
 * a key is required is the first push to a slot that has none — the sidecar
 * logs "pushed with no apiKey (and none on file) — ignoring" and drops it.
 *
 * ── Embedding pins, rerank does not ────────────────────────────────────────
 *
 * An embedding model MUST name an upstream provider. Two OpenRouter upstreams
 * serving the same model do not guarantee identical vectors, so an unpinned
 * embedding route can split one vector space between requests; the sidecar
 * fails closed on this and so does Fantom's compatibility gate. Rerank is
 * stateless and needs no pin.
 */

import * as path from 'path';
import type { VirtualRole, VirtualRoutingMode } from './virtualContainers.js';
import { VIRTUAL_ROLES, DEFAULT_OR_RERANK_MODEL } from './virtualContainers.js';
import { DEFAULT_CODE_ASSISTANT_MODEL, isRlmFallbackMode, type RlmFallbackMode } from './openRouterModels.js';
import {
  modesFromPolicies, sanitizePolicies, policyFromMode,
  type PolicyByRole,
} from './routingPolicy.js';
import { listSidecars } from './registry.js';
import { pushConfigToSidecar, isSoundSuiteSidecarConnected } from './soundsuiteMaster.js';
import { atomicWriteConfigFile, readConfigFileWithRecovery } from '../config/index.js';

const CONFIG_PATH = path.join(process.cwd(), 'config', 'fantomMcpServer-config.json');

/** One role's OpenRouter mapping, as Fantom stores and pushes it. */
export interface OpenRouterRoleConfig {
  model: string;
  /** Pinned upstream. REQUIRED for the embedding roles. */
  provider?: string;
  dims?: number;
  note?: string;
}

export interface OpenRouterSettings {
  /** Roles with a model mapped — the sidecar's `allowedModels`. */
  allowedModels: Partial<Record<VirtualRole, OpenRouterRoleConfig>>;
  /**
   * DERIVED from `policyByRole` — never authored directly. Kept in the shape
   * the sidecar expects so the push payload stays unchanged.
   */
  modeByRole: Partial<Record<VirtualRole, VirtualRoutingMode>>;
  /**
   * The operator-facing choice per role: aggregate / backup / local. This is
   * the stored truth; `modeByRole` is computed from it on every read and push,
   * so the two can never drift apart in config.
   */
  policyByRole?: PolicyByRole;
  /** Whether a key has ever been pushed from here. Never the key itself. */
  keyPushed?: boolean;
  /**
   * The last 4 characters of the pushed key, so the field can say WHICH key is
   * stored — "Configured (••••498a)" — instead of a bare "a key exists".
   * Four trailing characters identify a key to someone who already has it and
   * are useless to someone who does not; the key itself is never written.
   */
  keyLast4?: string;
  lastPushedAt?: string;
  /** Sidecars the last push reached. */
  lastPushedTo?: string[];
  /**
   * ── This master's RLM sandbox settings ──────────────────────────────────
   *
   * Fantom (code domain) and Sound Suite (legal domain) both register as
   * masters on the same sidecar fleet and each declares its OWN sandbox model
   * and fallback mode. They are stored per master and pushed under this
   * master's slot; neither overwrites the other. See
   * docs/tasks/ss-rlm-sandbox-2026-09-15.md for the two-master contract.
   *
   * `undefined` means "not set" and is distinct from any stored value — the
   * save path must never turn an untouched control into a write. Sound Suite's
   * own page has that bug: it posts `rlmSandboxModel: ''`, the API's guard
   * accepts it because `''` is a string, and an unrelated save silently clears
   * a configured model. Not reproduced here on purpose.
   */
  rlmSandboxModel?: string;
  rlmFallbackMode?: RlmFallbackMode;
}

/** The defaults Fantom proposes: the qwen embedder it already uses at 2560d,
 *  and the qwen reranker, which is the only size OpenRouter actually serves
 *  and the one the Sound Suite slot already pins here. */
export function defaultOpenRouterSettings(): OpenRouterSettings {
  return {
    allowedModels: {
      'embedding': { model: 'qwen/qwen3-embedding-4b', provider: 'DeepInfra', dims: 2560 },
      'code-embedding': { model: 'qwen/qwen3-embedding-4b', provider: 'DeepInfra', dims: 2560 },
      'reranker': { model: DEFAULT_OR_RERANK_MODEL },
      // Long context beats code specialisation on languages no model was
      // trained on — see openRouterModels.ts.
      'code-assistant': { model: DEFAULT_CODE_ASSISTANT_MODEL },
    },
    // Aggregate for the embedders (capacity adds up) and backup for rerank,
    // which has no fan-out to join. See routingPolicy.ts for why neither of
    // these is `local-first` on the wire.
    // `rlm` defaults to LOCAL, not backup: every other role's cloud fallback
    // costs one request, while an RLM session is a multi-round recursive loop
    // whose cost is many. Opting into that should be a decision, not a default
    // someone discovers on an invoice.
    policyByRole: {
      'embedding': 'aggregate', 'code-embedding': 'aggregate',
      'reranker': 'backup', 'code-assistant': 'backup', 'rlm': 'local',
    },
    modeByRole: modesFromPolicies({
      'embedding': 'aggregate', 'code-embedding': 'aggregate',
      'reranker': 'backup', 'code-assistant': 'backup', 'rlm': 'local',
    }),
  };
}

function readAll(): any {
  return readConfigFileWithRecovery(CONFIG_PATH);
}

export function getOpenRouterSettings(): OpenRouterSettings {
  const raw = readAll()?.semanticSearch?.openRouter;
  if (!raw || typeof raw !== 'object') {
    // No stored config is not "disabled" — it is "not configured yet", and the
    // defaults are what we would propose. Returning empty modeByRole here is
    // what previously produced 15 providers the sidecars read as local-only.
    const policies = sanitizePolicies(undefined);
    return { allowedModels: {}, modeByRole: modesFromPolicies(policies), policyByRole: policies };
  }
  return {
    allowedModels: sanitizeAllowedModels(raw.allowedModels),
    // modeByRole is DERIVED. A legacy config that stored modes but no policy
    // is migrated by reading the policy back out of the modes.
    policyByRole: policiesFrom(raw),
    modeByRole: modesFromPolicies(policiesFrom(raw)),
    keyPushed: raw.keyPushed === true,
    keyLast4: typeof raw.keyLast4 === 'string' ? raw.keyLast4.slice(-4) : undefined,
    lastPushedAt: typeof raw.lastPushedAt === 'string' ? raw.lastPushedAt : undefined,
    lastPushedTo: Array.isArray(raw.lastPushedTo) ? raw.lastPushedTo.map(String) : undefined,
    // A stored model that is no longer in the catalogue is kept, not silently
    // swapped: the panel prepends it to the options labelled as such, so the
    // control can never display a different model than the one on file.
    rlmSandboxModel: typeof raw.rlmSandboxModel === 'string' && raw.rlmSandboxModel.trim()
      ? raw.rlmSandboxModel.trim()
      : undefined,
    rlmFallbackMode: isRlmFallbackMode(raw.rlmFallbackMode) ? raw.rlmFallbackMode : undefined,
  };
}

function saveOpenRouterSettings(next: OpenRouterSettings): void {
  const cfg = readAll();
  cfg.semanticSearch = cfg.semanticSearch ?? {};
  // Defensive: whatever the caller hands us, an apiKey never lands on disk.
  const { ...safe } = next;
  delete (safe as Record<string, unknown>).apiKey;
  cfg.semanticSearch.openRouter = safe;
  atomicWriteConfigFile(CONFIG_PATH, cfg);
}

function sanitizeAllowedModels(raw: unknown): Partial<Record<VirtualRole, OpenRouterRoleConfig>> {
  const out: Partial<Record<VirtualRole, OpenRouterRoleConfig>> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [role, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(VIRTUAL_ROLES as string[]).includes(role)) continue;
    const o = typeof v === 'string' ? { model: v } : (v as Record<string, unknown> | null);
    if (!o || typeof o.model !== 'string' || !o.model) continue;
    out[role as VirtualRole] = {
      model: o.model,
      provider: typeof o.provider === 'string' && o.provider ? o.provider : undefined,
      dims: typeof o.dims === 'number' && o.dims > 0 ? o.dims : undefined,
      note: typeof o.note === 'string' && o.note ? o.note : undefined,
    };
  }
  return out;
}

/**
 * The stored policy, migrating a legacy config that only has `modeByRole`.
 *
 * Every role is filled. A missing role must never be read as "disabled": the
 * sidecar treats an absent mode as local-only, so an empty map once left every
 * configured provider unable to call OpenRouter with nothing to explain it.
 */
function policiesFrom(raw: Record<string, unknown>): Required<PolicyByRole> {
  if (raw.policyByRole && typeof raw.policyByRole === 'object') {
    return sanitizePolicies(raw.policyByRole);
  }
  const modes = (raw.modeByRole && typeof raw.modeByRole === 'object'
    ? raw.modeByRole : {}) as Record<string, unknown>;
  const migrated: Record<string, unknown> = {};
  for (const role of VIRTUAL_ROLES) {
    const m = modes[role];
    if (typeof m === 'string') {
      const p = policyFromMode(m as VirtualRoutingMode);
      if (p) migrated[role] = p;
    }
  }
  return sanitizePolicies(migrated);
}

export interface ValidationIssue { role?: VirtualRole; message: string }

/**
 * Reject a config that would be unusable or unsafe BEFORE it reaches the
 * fleet — a bad push is discovered later as a role that silently stays local.
 */
export function validateOpenRouterSettings(
  s: OpenRouterSettings,
  opts: { hasKey: boolean },
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!opts.hasKey && !s.keyPushed) {
    issues.push({ message: 'No OpenRouter API key has been pushed to the fleet yet, and none was supplied. The first push to a slot must carry a key or the sidecar ignores it.' });
  }
  for (const [role, mode] of Object.entries(s.modeByRole) as Array<[VirtualRole, VirtualRoutingMode]>) {
    if (mode === 'local-only') continue;
    // `rlm` sources its model from `rlmSandboxModel`, not `allowedModels.rlm`:
    // the ROLE says which endpoint runs the recursive session, the MODEL is
    // the one the hosted sandbox calls, and the sidecar reads it under the
    // separate `rlm-sandbox` key. Looking in the wrong place here reported a
    // correctly-configured RLM as a misconfiguration and blocked every save.
    if (role === 'rlm') {
      if (!s.rlmSandboxModel) {
        issues.push({
          role,
          message: `RLM is "${mode}" but no sandbox model is selected. Without one the sandbox is skipped `
            + `— and under "OpenRouter only" that turns RLM off rather than falling back to ss-rlm.`,
        });
      }
      continue;
    }
    const m = s.allowedModels[role];
    if (!m) {
      issues.push({ role, message: `Role "${role}" is ${mode} but no OpenRouter model is mapped for it — the sidecar will fall back to local and log a misconfiguration.` });
      continue;
    }
    // Only the EMBEDDING roles pin an upstream and declare a width. Testing
    // `role !== 'reranker'` was a fine proxy while there were three roles; it
    // silently became wrong the moment a fourth arrived, demanding a vector
    // pin from a chat model that has no vector space to split.
    const isEmbeddingRole = role === 'embedding' || role === 'code-embedding';
    if (isEmbeddingRole && !m.provider) {
      issues.push({ role, message: `Embedding role "${role}" has no pinned upstream provider. Two upstreams serving "${m.model}" can return different vectors, so an unpinned route can split the vector space between requests — the sidecar refuses it and falls back to local.` });
    }
    if (isEmbeddingRole && m.dims && m.dims !== 2560) {
      issues.push({ role, message: `Role "${role}" declares ${m.dims}d but code_vectors is 2560d. It would be refused by the compatibility gate.` });
    }
  }
  return issues;
}

export interface PushResult {
  sidecarId: string;
  name: string;
  pushed: boolean;
  reason?: string;
}

/**
 * Push the config to every enabled sidecar with an open WS tunnel.
 *
 * `apiKey` is optional and used once, in memory: it is placed on the outgoing
 * frame and then dropped. Omit it to update models or modes without
 * re-sending the key — the sidecar merges partial pushes.
 */
export function pushOpenRouterConfig(
  settings: OpenRouterSettings,
  apiKey?: string,
): { results: PushResult[]; pushedCount: number } {
  // Derive the wire modes HERE rather than trusting what the caller put in
  // `modeByRole`. The policy is the stored truth and the mode is a projection
  // of it; every other reader already recomputes it, and this was the last
  // place a hand-authored mode could have reached the fleet and disagreed with
  // the dropdown the operator is looking at. It matters more now that three
  // different policies project onto `cloud-only`.
  const modeByRole = modesFromPolicies(sanitizePolicies(settings.policyByRole));
  const resolved: OpenRouterSettings = { ...settings, modeByRole };
  // ── The two-master contract ────────────────────────────────────────────
  //
  // `domain` tells the sidecar which retrieval tools to inject into the
  // ss-rlm-sandbox session: Fantom is 'code' (search_code / search_symbols /
  // search_files), Sound Suite is 'legal'. HARDCODED on purpose — which domain
  // a codebase retrieves over is a fact about the software, not an operator
  // preference, and a toggle would only create a way to misclick legal tools
  // onto a code caller. It is also never inferred from the port: :3000 and
  // :3848 are a deployment detail, and a master that declares no domain is
  // treated as unconfigured rather than defaulting to either side, because the
  // failure mode of guessing is a confidently wrong answer instead of an error.
  //
  // `rlm-sandbox` is the MODEL key and is deliberately not the same string as
  // the `rlm` policy role: the role says which endpoint runs the session, the
  // model key says which hosted model the sandbox calls. The sidecar answers
  // 503 for a master it knows but that has no model under this key.
  const allowedModels: Record<string, unknown> = { ...resolved.allowedModels };
  // The `rlm` POLICY role carries no model of its own — it chooses an endpoint.
  // Anything auto-filled under that key is a chat model nothing reads, and it
  // shows up in the sidecar's `rolesWithModel` as if it were configured.
  delete allowedModels['rlm'];
  if (settings.rlmSandboxModel) {
    allowedModels['rlm-sandbox'] = { model: settings.rlmSandboxModel };
  }

  // Mode under BOTH keys. Fantom decides the endpoint itself
  // (`resolveRlmEndpoint` reads the local policy), so this is informational for
  // us — but the sidecar files it per master and Sound Suite's verified slot
  // keys it `rlm-sandbox`, while 01-how-it-works documents `mode.rlm`. Writing
  // one and not the other leaves a slot that disagrees with the reference
  // shape, and whichever the sidecar grows to read, it finds the same answer.
  const modeByRoleOut: Record<string, string> = { ...modeByRole };
  if (modeByRoleOut.rlm) modeByRoleOut['rlm-sandbox'] = modeByRoleOut.rlm;

  const payload: Record<string, unknown> = {
    openrouter: {
      ...(apiKey ? { apiKey } : {}),
      allowedModels,
      modeByRole: modeByRoleOut,
      domain: 'code',
    },
  };
  settings = resolved;

  const results: PushResult[] = [];
  for (const sc of listSidecars({ enabled: true })) {
    if (!isSoundSuiteSidecarConnected(sc.id)) {
      results.push({ sidecarId: sc.id, name: sc.name, pushed: false, reason: 'no open WS tunnel — the sidecar has not connected to Fantom\'s master slot' });
      continue;
    }
    const ok = pushConfigToSidecar(sc.id, payload);
    results.push({ sidecarId: sc.id, name: sc.name, pushed: ok, reason: ok ? undefined : 'send failed' });
  }

  // A send is not an outcome. pushConfigToSidecar only reports that the socket
  // accepted the frame; the sidecar answers asynchronously and can reject the
  // whole config — notably when the push carries no key and it has none on
  // file, which it treats as "ignore everything", modes included. Reporting
  // that as "pushed to 5/5" is how a fleet-wide rejection looked like success.
  const pushedTo = results.filter(r => r.pushed).map(r => r.name);
  const deliveredTo = pushedTo.length;
  // Log modes and models, never the key — mirrors the sidecar's own hygiene.
  console.log(
    `[openrouter] delivered config to ${deliveredTo}/${results.length} sidecar(s): ${pushedTo.join(', ') || 'none'} · `
    + `modes ${Object.entries(settings.modeByRole).map(([r, m]) => `${r}=${m}`).join(', ') || '(none)'} · `
    + `models for ${Object.keys(settings.allowedModels).join(', ') || '(none)'}`
    + `${apiKey ? ' · key included' : ' · key unchanged (merge)'}`,
  );

  saveOpenRouterSettings({
    ...settings,
    keyPushed: settings.keyPushed || !!apiKey,
    keyLast4: apiKey ? apiKey.slice(-4) : settings.keyLast4,
    lastPushedAt: new Date().toISOString(),
    lastPushedTo: pushedTo,
  });

  return { results, pushedCount: pushedTo.length };
}

/**
 * Re-push on demand. The sidecar holds the config in memory only, so it is
 * lost on a sidecar restart — this is what the "Re-push" button calls, and
 * what a future reconnect hook would call.
 */
export function rePushStoredConfig(): { results: PushResult[]; pushedCount: number } | null {
  const s = getOpenRouterSettings();
  if (Object.keys(s.allowedModels).length === 0) return null;
  return pushOpenRouterConfig(s);
}
