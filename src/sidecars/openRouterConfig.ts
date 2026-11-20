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
 * The key is never written to config, never logged and never returned by any
 * endpoint. It arrives on the admin request and goes out over the WS frame;
 * Fantom also stores it on the server (`secretsStore.ts`, or reads
 * FANTOM_OPENROUTER_API_KEY from the env) so it can re-key a slot that a sidecar restart or a new
 * master URL left empty — see `availablePushKey` and `openRouterAutoPush.ts`.
 * What Fantom persists is only what it is safe to persist: which roles have a
 * model mapped, which upstream provider is pinned, the routing modes, and the
 * fact that a push happened.
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
import type { VirtualRole, VirtualRoutingMode } from '../openrouter/roleTypes.js';
import { VIRTUAL_ROLES, DEFAULT_OR_RERANK_MODEL } from '../openrouter/roleTypes.js';
import {
  DEFAULT_CODE_ASSISTANT_MODEL, RETIRED_CHAT_MODELS, isRlmFallbackMode, type RlmFallbackMode,
} from './openRouterModels.js';
import {
  modesFromPolicies, sanitizePolicies, policyFromMode,
  type PolicyByRole,
} from './routingPolicy.js';
import { sanitizeRlmPipeline, type RlmPipelineSettings } from '../embedding/rlmPipeline.js';
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
  /** Which engines an ask runs (Fantom RLM, Jev checks, ss-rlm-sandbox) and
   *  its time budget. Always present when read; see embedding/rlmPipeline.ts. */
  rlmPipeline?: RlmPipelineSettings;
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
    return { allowedModels: {}, modeByRole: modesFromPolicies(policies), policyByRole: policies, rlmPipeline: sanitizeRlmPipeline(undefined) };
  }
  return {
    allowedModels: sanitizeAllowedModels(raw.allowedModels),
    // modeByRole is DERIVED. A legacy config that stored modes but no policy
    // is migrated by reading the policy back out of the modes.
    policyByRole: policiesFrom(raw),
    modeByRole: modesFromPolicies(policiesFrom(raw)),
    // A stored model that is no longer in the catalogue is kept, not silently
    // swapped: the panel prepends it to the options labelled as such, so the
    // control can never display a different model than the one on file.
    rlmSandboxModel: typeof raw.rlmSandboxModel === 'string' && raw.rlmSandboxModel.trim()
      ? (RETIRED_CHAT_MODELS.includes(raw.rlmSandboxModel.trim()) ? DEFAULT_CODE_ASSISTANT_MODEL : raw.rlmSandboxModel.trim())
      : undefined,
    rlmFallbackMode: isRlmFallbackMode(raw.rlmFallbackMode) ? raw.rlmFallbackMode : undefined,
    rlmPipeline: sanitizeRlmPipeline(raw.rlmPipeline),
  };
}

/** Keys from the sidecar-push era, dropped on the next save (2026-11-19). */
const DROPPED_KEYS = ['apiKey', 'keyPushed', 'keyLast4', 'lastPushedAt', 'lastPushedTo'];
/** Worker-pool keys live in the same object but are written by their own save. */
const POOL_KEYS = ['workerCount', 'interactiveSlots', 'requestTimeoutMs', 'maxPendingRows', 'writeBatchRows', 'masterServerUrl'];

export function saveOpenRouterSettings(next: OpenRouterSettings): void {
  const cfg = readAll() ?? {};
  cfg.semanticSearch = cfg.semanticSearch ?? {};
  const prev = (cfg.semanticSearch.openRouter ?? {}) as Record<string, unknown>;
  const safe: Record<string, unknown> = { ...next, allowedModels: sanitizeAllowedModels(next.allowedModels) };
  if (typeof next.rlmSandboxModel === 'string' && RETIRED_CHAT_MODELS.includes(next.rlmSandboxModel)) {
    safe.rlmSandboxModel = DEFAULT_CODE_ASSISTANT_MODEL;
  }
  for (const k of POOL_KEYS) if (prev[k] !== undefined && safe[k] === undefined) safe[k] = prev[k];
  for (const k of DROPPED_KEYS) delete safe[k];
  cfg.semanticSearch.openRouter = safe;
  // The virtual-container switch no longer exists: Fantom calls OpenRouter
  // itself and the routing policy alone decides whether a role uses it.
  delete cfg.semanticSearch.virtualContainers;
  atomicWriteConfigFile(CONFIG_PATH, cfg);
}

/** Save worker-pool numbers (already validated) without touching the rest. */
export function saveOpenRouterPoolSettings(values: Partial<Record<'workerCount' | 'interactiveSlots' | 'requestTimeoutMs' | 'maxPendingRows' | 'writeBatchRows', number>>): void {
  const cfg = readAll() ?? {};
  cfg.semanticSearch = cfg.semanticSearch ?? {};
  cfg.semanticSearch.openRouter = { ...(cfg.semanticSearch.openRouter ?? {}), ...values };
  atomicWriteConfigFile(CONFIG_PATH, cfg);
}

function sanitizeAllowedModels(raw: unknown): Partial<Record<VirtualRole, OpenRouterRoleConfig>> {
  const out: Partial<Record<VirtualRole, OpenRouterRoleConfig>> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [role, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(VIRTUAL_ROLES as string[]).includes(role)) continue;
    const o = typeof v === 'string' ? { model: v } : (v as Record<string, unknown> | null);
    if (!o || typeof o.model !== 'string' || !o.model) continue;
    // A model OpenRouter no longer serves reads as the current default, so the
    // page shows a working choice and a save does not fail on it.
    const model = RETIRED_CHAT_MODELS.includes(o.model) ? DEFAULT_CODE_ASSISTANT_MODEL : o.model;
    out[role as VirtualRole] = {
      model,
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
  opts: { hasKey: boolean; codeDimensions?: number },
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!opts.hasKey && Object.values(s.modeByRole).some(m => m && m !== 'local-only')) {
    issues.push({ message: 'No OpenRouter API key is stored on this server and none was supplied. Fantom calls OpenRouter itself, so a role routed to OpenRouter needs one.' });
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
      issues.push({ role, message: `Role "${role}" is ${mode} but no OpenRouter model is mapped for it.` });
      continue;
    }
    // Only the EMBEDDING roles pin an upstream and declare a width. Testing
    // `role !== 'reranker'` was a fine proxy while there were three roles; it
    // silently became wrong the moment a fourth arrived, demanding a vector
    // pin from a chat model that has no vector space to split.
    const isEmbeddingRole = role === 'embedding' || role === 'code-embedding';
    if (isEmbeddingRole && !m.provider) {
      issues.push({ role, message: `Embedding role "${role}" has no pinned upstream provider. Two upstreams serving "${m.model}" can return different vectors, so an unpinned route can split the vector space between requests — Fantom refuses to embed through it.` });
    }
    // Compare against the CONFIGURED table width, not a literal: the literal
    // was the 4B's 2560 and blocked the 2026-09-29 switch to the 8B (4096d)
    // even though the full re-embed that follows a width change is exactly
    // what makes the new width right. A mismatch is still worth a warning —
    // it means a shadow rebuild is required before this model can serve.
    const tableDims = opts.codeDimensions ?? 2560;
    if (isEmbeddingRole && m.dims && m.dims !== tableDims) {
      issues.push({ role, message: `Role "${role}" declares ${m.dims}d but the code table is ${tableDims}d. It would be refused by the compatibility gate until a full re-embed at ${m.dims}d (set semanticSearch.codeDimensions to ${m.dims} and run POST /admin/vectors/re-embed/start {projectId:0}).` });
    }
  }
  return issues;
}
