/**
 * Registry-side API key slot conventions shared by consumer-auth.ts (key-ID lookup) and
 * api-key-rotation-checker.ts (daily overdue-rotation check). Mirrors the naming in
 * infra/lib/ingestion-consumers.ts and infra-stack.ts; an infra test pins them together.
 *
 * Every consumer has two stable key slots, `a` and `b`. Normally only its primary slot
 * exists. During a rotation the registry also declares the other slot as secondary, and
 * both key IDs resolve to the same consumer until cleanup. See
 * docs/work-orders/WO-2026-09-30-001-design.md.
 */

export type ApiKeySlot = 'a' | 'b';
export type ApiKeyRotationPhase = 'overlap' | 'old-disabled';

export interface ConsumerApiKeyConfig {
  primarySlot: ApiKeySlot;
  rotation?: { secondarySlot: ApiKeySlot; phase: ApiKeyRotationPhase };
}

/** Exact API Gateway key name for a consumer's slot; matched by full-string equality only. */
export function apiKeySlotName(consumerId: string, slot: ApiKeySlot): string {
  return slot === 'a' ? `particle-ingestion-${consumerId}` : `particle-ingestion-${consumerId}-b`;
}

function envSuffix(consumerId: string): string {
  return consumerId.toUpperCase().replace(/-/g, '_');
}

/** The primary slot's key ID; the name predates slots and is kept so the no-rotation path is unchanged. */
export function primaryKeyIdEnvVar(consumerId: string): string {
  return `INGESTION_API_KEY_ID_${envSuffix(consumerId)}`;
}

/** The secondary slot's key ID, present only while a rotation is declared. */
export function rotationKeyIdEnvVar(consumerId: string): string {
  return `INGESTION_API_KEY_ROTATION_ID_${envSuffix(consumerId)}`;
}

const SLOTS: readonly unknown[] = ['a', 'b'];
const PHASES: readonly unknown[] = ['overlap', 'old-disabled'];

/**
 * Runtime re-check of a consumer's bundled apiKey block. `cdk synth` already rejects a
 * malformed registry, so this only fails if the bundle and the synth disagree -- and then it
 * must fail for that one consumer, not throw for all of them. Returns a reason, or undefined
 * when the block is well formed.
 */
export function apiKeyConfigProblem(apiKey: unknown): string | undefined {
  if (!apiKey || typeof apiKey !== 'object' || Array.isArray(apiKey)) return 'missing_api_key_config';
  const { primarySlot, rotation, ...extra } = apiKey as Record<string, unknown>;
  if (Object.keys(extra).length > 0) return 'unsupported_api_key_field';
  if (!SLOTS.includes(primarySlot)) return 'invalid_primary_slot';
  if (rotation === undefined) return undefined;
  if (!rotation || typeof rotation !== 'object' || Array.isArray(rotation)) return 'invalid_rotation';
  const { secondarySlot, phase, ...rotationExtra } = rotation as Record<string, unknown>;
  if (Object.keys(rotationExtra).length > 0) return 'unsupported_rotation_field';
  if (!SLOTS.includes(secondarySlot)) return 'invalid_secondary_slot';
  if (secondarySlot === primarySlot) return 'secondary_slot_equals_primary';
  if (!PHASES.includes(phase)) return 'invalid_rotation_phase';
  return undefined;
}
