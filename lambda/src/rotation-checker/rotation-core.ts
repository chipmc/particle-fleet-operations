/**
 * Rotation-state evaluation for the daily checker. Pure and value-free (WO-2026-09-30-001
 * design, Revisions 5 and 6): it takes the adapter's registry-labeled key slots, the
 * registry, and the time, and returns events. Keys are identified only by consumer ID and
 * slot, never by an API Gateway key ID or name. It has no SDK import and no output capability.
 *
 * Rotation state comes from what API Gateway actually holds, not from the registry's
 * declaration: for each registered consumer, count the keys whose names exactly equal its
 * two slot names. One key is the steady state. Two keys -- both enabled (`overlap`) or one
 * disabled (`old-disabled`) -- is a rotation in progress, and its clock starts at the
 * secondary key's API Gateway `createdDate`; 168 hours later each daily run reports it
 * overdue until cleanup leaves one key. Zero keys, a duplicated name, a declared rotation
 * with one key, two keys with no declared rotation, or unreadable metadata are
 * inconsistencies, never a healthy result.
 */
import { ApiKeySlot, ConsumerApiKeyConfig, apiKeyConfigProblem, apiKeySlotName } from '../api-key-slots';
import { InconsistencyReason, KeySlotLabel, KeySummary, MalformedKeySlot, ObservedKeySlot, RotationEvent } from './records';

export const ROTATION_ALERT_TARGET_MS = 168 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CheckerConsumer {
  readonly id: string;
  readonly apiKey: ConsumerApiKeyConfig;
}

export interface RotationInput {
  readonly slots: readonly ObservedKeySlot[];
  readonly malformed: readonly MalformedKeySlot[];
  readonly consumers: readonly CheckerConsumer[];
  readonly now: Date;
}

/**
 * The adapter's lookup table: each consumer's two exact slot names, mapped to the registry
 * label (consumer ID and slot) the adapter attaches to a matching key. Names are compared by
 * full-string equality only, so `alpha` never matches `alpha-b` or `alpha-long`.
 */
export function expectedKeySlots(consumers: readonly CheckerConsumer[]): ReadonlyMap<string, KeySlotLabel> {
  const map = new Map<string, KeySlotLabel>();
  for (const c of consumers) {
    for (const slot of ['a', 'b'] as const) map.set(apiKeySlotName(c.id, slot), { consumerId: c.id, slot });
  }
  return map;
}

function summarize(slots: readonly ObservedKeySlot[]): KeySummary[] {
  return slots.map(s => ({ slot: s.slot, enabled: s.enabled }));
}

function evaluateConsumer(consumer: CheckerConsumer, input: RotationInput): RotationEvent[] {
  const slotted = input.slots
    .filter(s => s.consumerId === consumer.id)
    .sort((x, y) => x.slot.localeCompare(y.slot));
  const malformed = input.malformed.filter(m => m.consumerId === consumer.id);
  const keyCount = slotted.length + malformed.length;
  const inconsistency = (reason: InconsistencyReason): RotationEvent => ({
    event: 'ingestion_api_key_rotation_inconsistency',
    consumerId: consumer.id,
    reason,
    keyCount,
    keys: summarize(slotted),
  });

  const perSlot = (slot: ApiKeySlot) => slotted.filter(s => s.slot === slot).length + malformed.filter(m => m.slot === slot).length;
  if (perSlot('a') > 1 || perSlot('b') > 1) return [inconsistency('ambiguous_key_names')];
  if (apiKeyConfigProblem(consumer.apiKey)) return [inconsistency('registry_api_key_config_invalid')];
  if (malformed.length > 0) return [inconsistency(malformed[0].reason)];

  const { primarySlot, rotation } = consumer.apiKey;
  if (slotted.length === 0) return [inconsistency('no_keys')];
  if (slotted.length === 1) {
    if (rotation) return [inconsistency('rotation_declared_with_one_key')];
    if (slotted[0].slot !== primarySlot) return [inconsistency('only_key_is_not_primary_slot')];
    return [];
  }

  // Two keys: a rotation is in progress whether or not both are enabled, and whether or not
  // the registry still declares it.
  const events: RotationEvent[] = [];
  let secondary: ObservedKeySlot;
  if (rotation) {
    secondary = slotted.find(s => s.slot === rotation.secondarySlot)!;
    const primary = slotted.find(s => s.slot === primarySlot)!;
    if (secondary.createdDate.getTime() <= primary.createdDate.getTime()) {
      events.push(inconsistency('secondary_not_newer_than_primary'));
    }
  } else {
    events.push(inconsistency('two_keys_without_declared_rotation'));
    secondary = slotted.reduce((newer, s) => (s.createdDate.getTime() > newer.createdDate.getTime() ? s : newer));
  }

  const alertTargetMs = secondary.createdDate.getTime() + ROTATION_ALERT_TARGET_MS;
  if (input.now.getTime() >= alertTargetMs) {
    events.push({
      event: 'ingestion_api_key_rotation_overdue',
      consumerId: consumer.id,
      phase: rotation?.phase ?? null,
      secondarySlot: secondary.slot,
      secondaryKeyCreatedDate: secondary.createdDate.toISOString(),
      alertTargetAt: new Date(alertTargetMs).toISOString(),
      daysOverdue: Math.floor((input.now.getTime() - alertTargetMs) / DAY_MS),
      keys: summarize(slotted),
    });
  }
  return events;
}

export function evaluateRotation(input: RotationInput): RotationEvent[] {
  return input.consumers.flatMap(consumer => evaluateConsumer(consumer, input));
}
