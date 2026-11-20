/**
 * The OpenRouter roles Fantom serves itself, and their model/pin per role.
 *
 * Replaces the sidecar "virtual container" rows (`<PCName>-OR-<Role>`): there
 * is one provider per role now, named `Fantom-OR-<Role>`.
 */
import { getOpenRouterSettings, type OpenRouterRoleConfig } from '../sidecars/openRouterConfig.js';
import { pinFor } from '../sidecars/openRouterModels.js';

import { DEFAULT_OR_RERANK_MODEL, type VirtualRole } from './roleTypes.js';
export * from './roleTypes.js';

const PROVIDER_NAME: Record<VirtualRole, string> = {
  'code-embedding': 'Fantom-OR-CodeEmbedding',
  'embedding': 'Fantom-OR-Embedding',
  'reranker': 'Fantom-OR-Reranker',
  'code-assistant': 'Fantom-OR-Chat',
  'rlm': 'Fantom-OR-RLM',
};

export function providerNameFor(role: VirtualRole): string {
  return PROVIDER_NAME[role];
}

export interface CloudRoleModel {
  role: VirtualRole;
  providerName: string;
  model: string;
  /** Upstream pin: the configured one, else the catalogue's. */
  pin?: string;
  dims?: number;
}

/** The model this role uses on OpenRouter, or null when none is configured. */
export function cloudRoleModel(role: VirtualRole, settings = getOpenRouterSettings()): CloudRoleModel | null {
  const m: OpenRouterRoleConfig | undefined = settings.allowedModels[role];
  if (!m?.model) {
    if (role === 'reranker') {
      return { role, providerName: PROVIDER_NAME[role], model: DEFAULT_OR_RERANK_MODEL, pin: pinFor(DEFAULT_OR_RERANK_MODEL) };
    }
    if (role === 'rlm' && settings.rlmSandboxModel && !settings.rlmSandboxModel.startsWith('direct:')) {
      return { role, providerName: PROVIDER_NAME[role], model: settings.rlmSandboxModel };
    }
    return null;
  }
  return {
    role,
    providerName: PROVIDER_NAME[role],
    model: m.model,
    pin: m.provider ?? pinFor(m.model),
    dims: m.dims,
  };
}
