/**
 * Value-free core fixtures. These are the reviewer-specified Revision 3 checker fixtures
 * (WO-2026-09-30-001 design, "Required implementation verification"), carried over to the
 * Revision 5/6 core: the ±1 ms threshold around createdDate + 168 h with a second-precision
 * `+08:00` timestamp, scheduled 09:00 UTC runs, a recreated secondary key, the 0/1/2/3-key
 * states, a disabled key still counting, exact-name attribution (alpha vs alpha-long), and
 * unreadable metadata never reading as healthy (round-2 F5).
 *
 * Revision 6 contract change: keys are identified by registry consumer ID and slot only, so
 * events carry `secondarySlot` and key summaries carry `{ slot, enabled }` -- never an API
 * Gateway key ID or name.
 */
import { APIGatewayClient } from '@aws-sdk/client-api-gateway';
import { listKeyMetadata } from '../../rotation-checker/metadata-adapter';
import { CheckerConsumer, ROTATION_ALERT_TARGET_MS, evaluateRotation, expectedKeySlots } from '../../rotation-checker/rotation-core';
import { MalformedKeySlot, ObservedKeySlot, RotationEvent } from '../../rotation-checker/records';

const HOUR_MS = 60 * 60 * 1000;

// Design timeline: deploy 1 starts at T0; the new key's createdDate is T0 + 4 minutes at
// second precision with a nonzero UTC offset; the stack is UPDATE_COMPLETE at T0 + 9 min.
const T0 = new Date('2026-09-21T15:30:04+08:00');
const ALPHA_B_CREATED = new Date('2026-09-21T15:34:04+08:00');
const UPDATE_COMPLETE = new Date(T0.getTime() + 9 * 60 * 1000);
const THRESHOLD_MS = ALPHA_B_CREATED.getTime() + 168 * HOUR_MS;
const OLD_KEY_CREATED = new Date('2026-03-01T12:00:00Z');
const LATE = THRESHOLD_MS + 2 * 24 * HOUR_MS;

const OVERLAP: CheckerConsumer['apiKey'] = { primarySlot: 'a', rotation: { secondarySlot: 'b', phase: 'overlap' } };
const OLD_DISABLED: CheckerConsumer['apiKey'] = { primarySlot: 'a', rotation: { secondarySlot: 'b', phase: 'old-disabled' } };
const STEADY: CheckerConsumer['apiKey'] = { primarySlot: 'a' };

const observed = (consumerId: string, slot: 'a' | 'b', createdDate: Date, enabled = true): ObservedKeySlot => ({ consumerId, slot, enabled, createdDate });
const alphaA = (o: Partial<ObservedKeySlot> = {}) => ({ ...observed('alpha', 'a', OLD_KEY_CREATED), ...o });
const alphaB = (o: Partial<ObservedKeySlot> = {}) => ({ ...observed('alpha', 'b', ALPHA_B_CREATED), ...o });
const BETA_A = observed('beta', 'a', OLD_KEY_CREATED);

function run(slots: ObservedKeySlot[], consumers: CheckerConsumer[], now: number | Date, malformed: MalformedKeySlot[] = []): RotationEvent[] {
  return evaluateRotation({ slots, malformed, consumers, now: new Date(now) });
}
const overdue = (events: RotationEvent[], consumerId?: string) =>
  events.filter(e => e.event === 'ingestion_api_key_rotation_overdue' && (!consumerId || e.consumerId === consumerId));
const inconsistencies = (events: RotationEvent[], consumerId?: string) =>
  events.filter(e => e.event === 'ingestion_api_key_rotation_inconsistency' && (!consumerId || e.consumerId === consumerId));

const ALPHA_BETA: CheckerConsumer[] = [{ id: 'alpha', apiKey: OVERLAP }, { id: 'beta', apiKey: STEADY }];

describe('the rotation clock is the secondary key\'s createdDate', () => {
  const slots = () => [alphaA(), alphaB(), BETA_A];

  test.each([
    ['1 ms before createdDate + 168 h', THRESHOLD_MS - 1, 0],
    ['exactly createdDate + 168 h', THRESHOLD_MS, 1],
    ['1 ms after', THRESHOLD_MS + 1, 1],
  ])('%s: %i overdue event(s)', (_label, now, expected) => {
    const events = run(slots(), ALPHA_BETA, now);
    expect(overdue(events, 'alpha')).toHaveLength(expected);
    expect(overdue(events, 'beta')).toHaveLength(0);
    expect(inconsistencies(events)).toHaveLength(0);
  });

  test('stack completion does not move the threshold', () => {
    const pastByCreated = UPDATE_COMPLETE.getTime() + 168 * HOUR_MS - 1;
    expect(pastByCreated).toBeGreaterThan(THRESHOLD_MS);
    expect(overdue(run(slots(), ALPHA_BETA, pastByCreated), 'alpha')).toHaveLength(1);
  });

  test('scheduled 09:00 UTC runs: none before the threshold, then one exact structured event per daily run', () => {
    expect(new Date(THRESHOLD_MS).toISOString()).toBe('2026-09-28T07:34:04.000Z');
    const runs = ['2026-09-27T09:00:00Z', '2026-09-28T09:00:00Z', '2026-09-29T09:00:00Z', '2026-09-30T09:00:00Z'];
    const perRun = runs.map(r => run(slots(), ALPHA_BETA, new Date(r)));
    expect(perRun.map(events => overdue(events, 'alpha').length)).toEqual([0, 1, 1, 1]);
    expect(perRun[1]).toEqual([{
      event: 'ingestion_api_key_rotation_overdue',
      consumerId: 'alpha',
      phase: 'overlap',
      secondarySlot: 'b',
      secondaryKeyCreatedDate: '2026-09-21T07:34:04.000Z',
      alertTargetAt: '2026-09-28T07:34:04.000Z',
      daysOverdue: 0,
      keys: [{ slot: 'a', enabled: true }, { slot: 'b', enabled: true }],
    }]);
    expect(overdue(perRun[3], 'alpha')[0]).toMatchObject({ daysOverdue: 2 });
  });

  test('a recreated secondary key starts its own target from its own createdDate', () => {
    const recreatedAt = new Date('2026-09-25T10:00:00Z');
    const recreated = [alphaA(), alphaB({ createdDate: recreatedAt }), BETA_A];
    expect(overdue(run(recreated, ALPHA_BETA, THRESHOLD_MS + HOUR_MS))).toHaveLength(0);
    expect(overdue(run(recreated, ALPHA_BETA, recreatedAt.getTime() + 168 * HOUR_MS), 'alpha'))
      .toEqual([expect.objectContaining({ secondarySlot: 'b', secondaryKeyCreatedDate: recreatedAt.toISOString() })]);
  });
});

describe('rotation state comes from the observed key count', () => {
  test('1 key, no declared rotation, readable date: steady state, no events', () => {
    expect(run([alphaA(), BETA_A], [{ id: 'alpha', apiKey: STEADY }, { id: 'beta', apiKey: STEADY }], LATE)).toEqual([]);
  });

  test('2 enabled keys (overlap): timed overdue event only', () => {
    const events = run([alphaA(), alphaB(), BETA_A], ALPHA_BETA, LATE);
    expect(overdue(events, 'alpha')).toEqual([expect.objectContaining({ phase: 'overlap', secondarySlot: 'b', daysOverdue: 2 })]);
    expect(inconsistencies(events)).toEqual([]);
  });

  test('2 keys, old one disabled (old-disabled): the disabled key still counts, overdue continues daily', () => {
    const consumers = [{ id: 'alpha', apiKey: OLD_DISABLED }, { id: 'beta', apiKey: STEADY }];
    for (const day of [0, 1, 2]) {
      expect(overdue(run([alphaA({ enabled: false }), alphaB(), BETA_A], consumers, THRESHOLD_MS + day * 24 * HOUR_MS), 'alpha')).toEqual([expect.objectContaining({
        phase: 'old-disabled',
        daysOverdue: day,
        keys: [{ slot: 'a', enabled: false }, { slot: 'b', enabled: true }],
      })]);
    }
  });

  test('deploy 3 leaves one key: overdue alerts stop once observed', () => {
    expect(run([alphaB(), BETA_A], [{ id: 'alpha', apiKey: { primarySlot: 'b' } }, { id: 'beta', apiKey: STEADY }], LATE)).toEqual([]);
  });

  test('0 keys: inconsistency, not healthy', () => {
    expect(inconsistencies(run([BETA_A], [{ id: 'alpha', apiKey: STEADY }, { id: 'beta', apiKey: STEADY }], LATE)))
      .toEqual([expect.objectContaining({ consumerId: 'alpha', reason: 'no_keys', keyCount: 0 })]);
  });

  test('1 key with a declared rotation: inconsistency, not a completed migration', () => {
    const events = run([alphaA(), BETA_A], ALPHA_BETA, LATE);
    expect(inconsistencies(events)).toEqual([expect.objectContaining({ consumerId: 'alpha', reason: 'rotation_declared_with_one_key', keyCount: 1 })]);
    expect(overdue(events)).toEqual([]);
  });

  test('1 key in the non-primary slot: inconsistency', () => {
    expect(inconsistencies(run([alphaB(), BETA_A], [{ id: 'alpha', apiKey: STEADY }, { id: 'beta', apiKey: STEADY }], LATE)))
      .toEqual([expect.objectContaining({ consumerId: 'alpha', reason: 'only_key_is_not_primary_slot' })]);
  });

  test('2 keys without a declared rotation: inconsistency, plus overdue from the newer key\'s createdDate', () => {
    const consumers = [{ id: 'alpha', apiKey: STEADY }, { id: 'beta', apiKey: STEADY }];
    const events = run([alphaA(), alphaB(), BETA_A], consumers, THRESHOLD_MS);
    expect(inconsistencies(events, 'alpha')).toEqual([expect.objectContaining({ reason: 'two_keys_without_declared_rotation', keyCount: 2 })]);
    expect(overdue(events, 'alpha')).toEqual([expect.objectContaining({ secondarySlot: 'b', phase: null })]);
    const quiet = run([alphaA(), alphaB(), BETA_A], consumers, THRESHOLD_MS - 1);
    expect(overdue(quiet)).toEqual([]);
    expect(inconsistencies(quiet, 'alpha')).toHaveLength(1);
  });

  test('3 keys (a duplicated slot name): ambiguity inconsistency, no guessed owner and no ID emitted', () => {
    const events = run([alphaA(), alphaA(), alphaB(), BETA_A], ALPHA_BETA, LATE);
    expect(inconsistencies(events)).toEqual([expect.objectContaining({ consumerId: 'alpha', reason: 'ambiguous_key_names', keyCount: 3 })]);
    expect(overdue(events)).toEqual([]);
  });

  test('the secondary must be newer than the primary', () => {
    const events = run([alphaA({ createdDate: new Date(ALPHA_B_CREATED.getTime() + 1000) }), alphaB(), BETA_A], ALPHA_BETA, THRESHOLD_MS - 1);
    expect(inconsistencies(events, 'alpha')).toEqual([expect.objectContaining({ reason: 'secondary_not_newer_than_primary' })]);
  });

  test('an invalid registry apiKey block is an inconsistency', () => {
    const consumers = [{ id: 'alpha', apiKey: { primarySlot: 'c' } as unknown as CheckerConsumer['apiKey'] }];
    expect(inconsistencies(run([alphaA()], consumers, LATE))).toEqual([expect.objectContaining({ reason: 'registry_api_key_config_invalid' })]);
  });

  test('a healthy beta stays quiet while alpha is overdue', () => {
    expect(run([alphaA(), alphaB(), BETA_A], ALPHA_BETA, LATE).map(e => (e as { consumerId: string }).consumerId)).toEqual(['alpha']);
  });
});

describe('unreadable metadata is never healthy, whatever the key count (round-2 F5)', () => {
  const consumers = [{ id: 'alpha', apiKey: STEADY }, { id: 'beta', apiKey: STEADY }];

  test.each(['missing_created_date', 'invalid_key_metadata'] as const)('1 key, no declared rotation, %s: inconsistency', reason => {
    const events = run([BETA_A], consumers, LATE, [{ consumerId: 'alpha', slot: 'a', reason }]);
    expect(events).toEqual([expect.objectContaining({ event: 'ingestion_api_key_rotation_inconsistency', consumerId: 'alpha', reason, keyCount: 1 })]);
  });

  test('2 keys, one unreadable: inconsistency, no overdue guessed', () => {
    const events = run([alphaA(), BETA_A], ALPHA_BETA, LATE, [{ consumerId: 'alpha', slot: 'b', reason: 'missing_created_date' }]);
    expect(events).toEqual([expect.objectContaining({ consumerId: 'alpha', reason: 'missing_created_date', keyCount: 2 })]);
  });

  test('an unreadable key in the same slot as a readable one is ambiguous', () => {
    const events = run([alphaA(), BETA_A], consumers, LATE, [{ consumerId: 'alpha', slot: 'a', reason: 'invalid_key_metadata' }]);
    expect(events).toEqual([expect.objectContaining({ consumerId: 'alpha', reason: 'ambiguous_key_names', keyCount: 2 })]);
  });
});

describe('keys are attributed by exact full name (adapter lookup feeding the core)', () => {
  afterEach(() => jest.restoreAllMocks());

  test('alpha and alpha-long: each key counts only for its owner, regardless of prefix or enabled state', async () => {
    const consumers = [{ id: 'alpha', apiKey: OLD_DISABLED }, { id: 'alpha-long', apiKey: STEADY }];
    jest.spyOn(APIGatewayClient.prototype, 'send').mockImplementation(async () => ({ items: [
      { name: 'particle-ingestion-alpha-long', enabled: true, createdDate: OLD_KEY_CREATED },
      { name: 'particle-ingestion-alpha', enabled: true, createdDate: OLD_KEY_CREATED },
      { name: 'particle-ingestion-alpha-longer', enabled: true, createdDate: OLD_KEY_CREATED },
      { name: 'particle-ingestion-alpha-b', enabled: false, createdDate: ALPHA_B_CREATED },
      { name: 'particle-ingestion-alpha-b-extra', enabled: true, createdDate: OLD_KEY_CREATED },
    ] }) as never);
    const read = await listKeyMetadata(expectedKeySlots(consumers));
    if (!read.ok) throw new Error('read failed');
    expect(read.slots.map(s => `${s.consumerId}/${s.slot}`).sort()).toEqual(['alpha-long/a', 'alpha/a', 'alpha/b']);
    const events = evaluateRotation({ slots: read.slots, malformed: read.malformed, consumers, now: new Date(THRESHOLD_MS) });
    expect(inconsistencies(events)).toEqual([]);
    expect(overdue(events)).toEqual([expect.objectContaining({ consumerId: 'alpha', secondarySlot: 'b' })]);
  });

  test('the lookup table is exactly each consumer\'s two slot names, labeled from the registry', () => {
    expect([...expectedKeySlots([{ id: 'alpha', apiKey: STEADY }, { id: 'alpha-long', apiKey: STEADY }])].sort()).toEqual([
      ['particle-ingestion-alpha', { consumerId: 'alpha', slot: 'a' }],
      ['particle-ingestion-alpha-b', { consumerId: 'alpha', slot: 'b' }],
      ['particle-ingestion-alpha-long', { consumerId: 'alpha-long', slot: 'a' }],
      ['particle-ingestion-alpha-long-b', { consumerId: 'alpha-long', slot: 'b' }],
    ]);
  });
});

test('ROTATION_ALERT_TARGET_MS is seven days', () => {
  expect(ROTATION_ALERT_TARGET_MS).toBe(7 * 24 * HOUR_MS);
});
