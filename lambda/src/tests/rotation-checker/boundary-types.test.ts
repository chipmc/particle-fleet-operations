/**
 * Compile-time negative fixtures (WO-2026-09-30-001 design, Revision 5). Each
 * `@ts-expect-error` line must stay a type error: if a boundary type ever accepts a `value`,
 * an SDK type, an `Error`, or a pre-serialized string, the directive goes unused and ts-jest
 * fails this suite. Runtime boundary tests remain authoritative -- TypeScript does not strip
 * fields -- so these complement metadata-adapter.test.ts and emitters.test.ts, not replace them.
 */
import type { ApiKey } from '@aws-sdk/client-api-gateway';
import { listKeyMetadata } from '../../rotation-checker/metadata-adapter';
import { AlertPublisher, logRunSummary } from '../../rotation-checker/emitters';
import { KeyMetadataReadResult, MalformedKeySlot, ObservedKeySlot, RotationEvent, RotationRunSummary } from '../../rotation-checker/records';

const createdDate = new Date('2026-09-21T07:34:04Z');
const sdkItem: ApiKey = { id: 'k', name: 'n', enabled: true, createdDate, value: 'v' };

// Positive controls: the declared shapes compile.
const slot: ObservedKeySlot = { consumerId: 'c', slot: 'a', enabled: true, createdDate };
const event: RotationEvent = { event: 'ingestion_api_key_rotation_checker_failed', failure: 'api_gateway_read_failed' };
const summary: RotationRunSummary = {
  event: 'ingestion_api_key_rotation_check', checkedAt: '', consumersChecked: 0, overdue: [], inconsistencies: [], failure: null, publishFailures: 0,
};
const failed: KeyMetadataReadResult = { ok: false, failure: 'api_gateway_read_failed' };
const reading: Promise<KeyMetadataReadResult> = Promise.resolve(failed);
const overdueBase = {
  event: 'ingestion_api_key_rotation_overdue', consumerId: 'c', phase: null, secondarySlot: 'b', secondaryKeyCreatedDate: '', alertTargetAt: '', daysOverdue: 0, keys: [],
} as const;

/* eslint-disable @typescript-eslint/no-unused-vars */
// @ts-expect-error ObservedKeySlot has no value field.
const slotWithValue: ObservedKeySlot = { consumerId: 'c', slot: 'a', enabled: true, createdDate, value: 'v' };
// @ts-expect-error ObservedKeySlot has no API Gateway key id (Revision 6).
const slotWithId: ObservedKeySlot = { consumerId: 'c', slot: 'a', enabled: true, createdDate, id: 'k' };
// @ts-expect-error ObservedKeySlot has no raw key name (Revision 6).
const slotWithName: ObservedKeySlot = { consumerId: 'c', slot: 'a', enabled: true, createdDate, name: 'n' };
// @ts-expect-error A raw SDK ApiKey is not an ObservedKeySlot.
const slotFromSdk: ObservedKeySlot = sdkItem;
// @ts-expect-error ObservedKeySlot exposes no id to read.
const readId = slot.id;
// @ts-expect-error ObservedKeySlot exposes no value to read.
const readValue = slot.value;
// @ts-expect-error Malformed entries carry no key id.
const malformedWithId: MalformedKeySlot = { consumerId: 'c', slot: 'a', reason: 'missing_created_date', id: 'k' };
// @ts-expect-error Malformed entries carry no raw key name.
const malformedWithName: MalformedKeySlot = { consumerId: 'c', slot: 'a', reason: 'missing_created_date', name: 'n' };

// @ts-expect-error RotationEvent has no value field.
const eventWithValue: RotationEvent = { event: 'ingestion_api_key_rotation_checker_failed', failure: 'api_gateway_read_failed', value: 'v' };
// @ts-expect-error RotationEvent carries no Error.
const eventWithError: RotationEvent = { event: 'ingestion_api_key_rotation_checker_failed', failure: 'api_gateway_read_failed', error: new Error('x') };
// @ts-expect-error Failure codes are a closed set, not arbitrary (upstream) text.
const eventWithText: RotationEvent = { event: 'ingestion_api_key_rotation_checker_failed', failure: 'BadRequestException: something upstream' };
// @ts-expect-error An overdue event names the secondary by slot, never by key id (Revision 6).
const overdueWithKeyId: RotationEvent = { ...overdueBase, secondaryKeyId: 'k' };
// @ts-expect-error The secondary slot is a slot, not arbitrary text.
const overdueWithTextSlot: RotationEvent = { ...overdueBase, secondarySlot: 'key-1234' };
// @ts-expect-error Key summaries carry no value.
const summaryKeyWithValue: RotationEvent = { event: 'ingestion_api_key_rotation_inconsistency', consumerId: 'c', reason: 'no_keys', keyCount: 0, keys: [{ slot: 'a', enabled: true, value: 'v' }] };
// @ts-expect-error Key summaries carry no key id (Revision 6).
const summaryKeyWithId: RotationEvent = { event: 'ingestion_api_key_rotation_inconsistency', consumerId: 'c', reason: 'no_keys', keyCount: 0, keys: [{ slot: 'a', enabled: true, id: 'k' }] };
// @ts-expect-error Key summaries carry no raw key name (Revision 6).
const summaryKeyWithName: RotationEvent = { event: 'ingestion_api_key_rotation_inconsistency', consumerId: 'c', reason: 'no_keys', keyCount: 0, keys: [{ slot: 'a', enabled: true, name: 'n' }] };

// @ts-expect-error RotationRunSummary has no value field.
const summaryWithValue: RotationRunSummary = { ...summary, value: 'v' };
// @ts-expect-error RotationRunSummary failure is a closed code, not an Error.
const summaryWithError: RotationRunSummary = { ...summary, failure: new Error('x') };
// @ts-expect-error RotationRunSummary carries no key ids.
const summaryWithIds: RotationRunSummary = { ...summary, keyIds: ['k'] };
// @ts-expect-error RotationRunSummary has no API Gateway key id (Revision 6; Codex round 4, R4-3).
const summaryWithId: RotationRunSummary = { ...summary, id: 'k' };
// @ts-expect-error RotationRunSummary has no raw key name (Revision 6; R4-3).
const summaryWithName: RotationRunSummary = { ...summary, name: 'n' };
// @ts-expect-error Summary inconsistency entries carry no key id (R4-3).
const summaryEntryWithId: RotationRunSummary = { ...summary, inconsistencies: [{ consumerId: 'c', reason: 'no_keys', id: 'k' }] };
// @ts-expect-error Summary inconsistency entries carry no raw key name (R4-3).
const summaryEntryWithName: RotationRunSummary = { ...summary, inconsistencies: [{ consumerId: 'c', reason: 'no_keys', name: 'n' }] };

// @ts-expect-error The checker-failure event carries no key id (Revision 6; R4-3).
const failureEventWithId: RotationEvent = { event: 'ingestion_api_key_rotation_checker_failed', failure: 'api_gateway_read_failed', id: 'k' };
// @ts-expect-error The checker-failure event carries no raw key name (Revision 6; R4-3).
const failureEventWithName: RotationEvent = { event: 'ingestion_api_key_rotation_checker_failed', failure: 'api_gateway_read_failed', name: 'n' };
// @ts-expect-error The overdue event carries no key id alongside its slot (R4-3).
const overdueWithId: RotationEvent = { ...overdueBase, id: 'k' };
// @ts-expect-error The overdue event carries no raw key name (R4-3).
const overdueWithName: RotationEvent = { ...overdueBase, name: 'n' };
// @ts-expect-error The inconsistency event carries no key id (R4-3).
const inconsistencyWithId: RotationEvent = { event: 'ingestion_api_key_rotation_inconsistency', consumerId: 'c', reason: 'no_keys', keyCount: 0, keys: [], id: 'k' };
// @ts-expect-error The inconsistency event carries no raw key name (R4-3).
const inconsistencyWithName: RotationEvent = { event: 'ingestion_api_key_rotation_inconsistency', consumerId: 'c', reason: 'no_keys', keyCount: 0, keys: [], name: 'n' };

// @ts-expect-error The adapter's failure result carries no upstream error.
const failureWithError: KeyMetadataReadResult = { ok: false, failure: 'api_gateway_read_failed', error: new Error('x') };
// @ts-expect-error The adapter's failure result carries no request ID.
const failureWithRequestId: KeyMetadataReadResult = { ok: false, failure: 'api_gateway_read_failed', requestId: 'r' };
// @ts-expect-error The adapter's failure result carries no key id (Revision 6; R4-3).
const failureWithId: KeyMetadataReadResult = { ok: false, failure: 'api_gateway_read_failed', id: 'k' };
// @ts-expect-error The adapter's failure result carries no raw key name (Revision 6; R4-3).
const failureWithName: KeyMetadataReadResult = { ok: false, failure: 'api_gateway_read_failed', name: 'n' };
// @ts-expect-error The adapter's success result carries no key id beside its slots (R4-3).
const successWithId: KeyMetadataReadResult = { ok: true, slots: [], malformed: [], id: 'k' };
// @ts-expect-error The adapter's success result carries no raw key name beside its slots (R4-3).
const successWithName: KeyMetadataReadResult = { ok: true, slots: [], malformed: [], name: 'n' };
// @ts-expect-error The adapter's success result carries no raw SDK items.
const successWithSdkItems: KeyMetadataReadResult = { ok: true, slots: [sdkItem], malformed: [] };
// @ts-expect-error Malformed entries carry a closed reason, not upstream text.
const malformedWithText: KeyMetadataReadResult = { ok: true, slots: [], malformed: [{ consumerId: 'c', slot: 'a', reason: 'upstream said: v' }] };

function emitterInputs(publisher: AlertPublisher, raw: unknown): void {
  // @ts-expect-error The publisher accepts no Error.
  void publisher.publish(new Error('x'));
  // @ts-expect-error The publisher accepts no pre-serialized string.
  void publisher.publish('{"event":"x"}');
  // @ts-expect-error The publisher accepts no unknown payload.
  void publisher.publish(raw);
  // @ts-expect-error The publisher accepts no raw SDK item.
  void publisher.publish(sdkItem);
  // @ts-expect-error The logger accepts no Error.
  logRunSummary(new Error('x'));
  // @ts-expect-error The logger accepts no pre-serialized string.
  logRunSummary('{"event":"x"}');
  // @ts-expect-error The logger accepts no unknown payload.
  logRunSummary(raw);
}

function adapterSurface(): void {
  // @ts-expect-error The adapter takes registry-derived slot labels, not a client or SDK config.
  void listKeyMetadata({ region: 'us-east-1' });
  // @ts-expect-error The adapter takes a name-to-label map, not a bare set of names.
  void listKeyMetadata(new Set(['particle-ingestion-alpha']));
}
/* eslint-enable @typescript-eslint/no-unused-vars */

test('boundary types compile only for value-free records (ts-jest fails this suite on an unused @ts-expect-error)', () => {
  expect([slot.consumerId, event.event, summary.event, failed.ok]).toEqual(['c', 'ingestion_api_key_rotation_checker_failed', 'ingestion_api_key_rotation_check', false]);
  expect(reading).toBeInstanceOf(Promise);
  expect(typeof emitterInputs).toBe('function');
  expect(typeof adapterSurface).toBe('function');
});
