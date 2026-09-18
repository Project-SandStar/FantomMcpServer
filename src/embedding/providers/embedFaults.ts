/**
 * Capability faults for embedding sidecars.
 *
 * A transport failure (host down) is transient and handled by marking the
 * sidecar unhealthy until its next heartbeat. A CAPABILITY fault is different:
 * the sidecar is up, heartbeats fine and advertises the model, but its runtime
 * refuses to embed with it. Observed 2026-09-14: native Ollama 0.32 on the
 * Macs answers `HTTP 501 "This server does not support embeddings. Start it
 * with --embeddings"` for hf.co/jinaai/jina-code-embeddings-1.5b-GGUF:Q8_0,
 * because that GGUF carries no `qwen2.pooling_type` key and Ollama ≥0.3x only
 * grants the embedding capability when the key is present (server/images.go:
 * `if m.metadata.Valid("pooling_type") → CapabilityEmbedding`). Ollama 0.24 in
 * Docker on BASWS35 does not check, so the same model works there.
 *
 * Retrying such a request is pointless and the heartbeat would immediately
 * clear an `unhealthy` mark, so the fault is remembered here (in memory, per
 * sidecar + capability + model) for FAULT_TTL_MS, skipped by provider
 * selection and the fan-out, and surfaced on GET /admin/sidecars.
 */
import type { SidecarCapabilityKind } from '../../admin/types.js';

export interface EmbedFault {
  sidecarId: string;
  sidecarName: string;
  kind: SidecarCapabilityKind;
  model: string;
  /** Short classification. */
  code: 'embeddings-unsupported' | 'model-missing' | 'other';
  /** The runtime's own message. */
  reason: string;
  /** What an operator should do. */
  remedy: string;
  at: string;
  expiresAt: string;
  occurrences: number;
}

export const FAULT_TTL_MS = 60 * 60_000;
/** A missing model is usually a pull in progress (the master pushed a new model
 *  name and the sidecar is still downloading it): re-probe much sooner. */
export const MODEL_MISSING_TTL_MS = 5 * 60_000;

const faults = new Map<string, EmbedFault>();

const key = (sidecarId: string, kind: string, model: string): string => `${sidecarId}|${kind}|${model}`;

/** Classify a sidecar embed error. Returns null when it is not a capability fault. */
export function classifyEmbedError(message: string): Pick<EmbedFault, 'code' | 'remedy'> | null {
  if (/does not support embeddings|--embeddings/i.test(message)) {
    return {
      code: 'embeddings-unsupported',
      remedy:
        'The Ollama on this host (≥0.3x) grants the embedding capability only to GGUFs that carry ' +
        '`<arch>.pooling_type`; this model file has none, so its runner starts without embeddings. ' +
        'Fix on the host: re-pack the GGUF with `qwen2.pooling_type = 3` (LAST) and `ollama create` it under ' +
        'the same name (scripts/dev/gguf-add-pooling.py), or run the code-embedding role on an Ollama image ' +
        'that predates the check (0.24, as on BASWS35). Verify with `ollama show <model>` → capabilities includes "embedding".',
    };
  }
  if (/model .* not found|try pulling it first/i.test(message)) {
    return { code: 'model-missing', remedy: 'Pull the model on the sidecar host (`ollama pull <model>`) or fix the role\'s model name in the sidecar config.' };
  }
  return null;
}

export function markEmbedFault(
  sc: { id: string; name: string },
  kind: SidecarCapabilityKind,
  model: string,
  reason: string,
  cls: Pick<EmbedFault, 'code' | 'remedy'>,
): EmbedFault {
  const k = key(sc.id, kind, model);
  const now = Date.now();
  const prev = faults.get(k);
  const f: EmbedFault = {
    sidecarId: sc.id,
    sidecarName: sc.name,
    kind,
    model,
    code: cls.code,
    reason: reason.length > 300 ? reason.slice(0, 300) + '…' : reason,
    remedy: cls.remedy,
    at: new Date(now).toISOString(),
    expiresAt: new Date(now + (cls.code === 'model-missing' ? MODEL_MISSING_TTL_MS : FAULT_TTL_MS)).toISOString(),
    occurrences: (prev?.occurrences ?? 0) + 1,
  };
  faults.set(k, f);
  return f;
}

function sweep(now = Date.now()): void {
  for (const [k, f] of faults) if (Date.parse(f.expiresAt) <= now) faults.delete(k);
}

/** Active fault for this sidecar (optionally narrowed to a capability / model). */
export function getEmbedFault(sidecarId: string, kind?: SidecarCapabilityKind, model?: string): EmbedFault | null {
  sweep();
  for (const f of faults.values()) {
    if (f.sidecarId !== sidecarId) continue;
    if (kind && f.kind !== kind) continue;
    if (model && f.model !== model) continue;
    return f;
  }
  return null;
}

export function listEmbedFaults(): EmbedFault[] {
  sweep();
  return Array.from(faults.values());
}

/** Clear faults for a sidecar (operator fixed the host and wants an immediate re-probe). */
export function clearEmbedFaults(sidecarId: string): number {
  let n = 0;
  for (const [k, f] of faults) if (f.sidecarId === sidecarId) { faults.delete(k); n++; }
  return n;
}
