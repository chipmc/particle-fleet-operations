/**
 * WO-2026-09-30-001 checker fixtures, as specified by the design's "Required implementation
 * verification" section.
 *
 * This file is the enforcement mechanism for "the checker never reads a key value". The
 * checker's role has apigateway:GET on /apikeys/*, and IAM cannot distinguish
 * includeValue(s)=true from false, so the role *can* read values. The fake API Gateway
 * below refuses (and records) every command except GetApiKeys with includeValues: false
 * and GetApiKey with includeValue: false -- GetUsagePlanKeys included -- and every test
 * asserts no violation occurred. Its responses use the shapes the real SDK returns:
 * createdDate is a Date (the SDK deserializes the wire's epoch seconds), items carry no
 * `value` when the include flag is false, and pagination is an opaque `position` token.
 */
import * as fs from 'fs';
import * as path from 'path';
import { GetApiKeyCommand, GetApiKeysCommand, GetUsagePlanKeysCommand } from '@aws-sdk/client-api-gateway';
import { PublishCommand } from '@aws-sdk/client-sns';
import {
  CheckerConsumer,
  ROTATION_ALERT_TARGET_MS,
  RotationEvent,
  runRotationCheck,
} from '../api-key-rotation-checker';

const VALUE_SENTINEL = 'SENTINEL-API-KEY-VALUE-must-never-appear';
const TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:rotation';
const HOUR_MS = 60 * 60 * 1000;

interface FakeKey {
  id: string;
  name: string;
  enabled: boolean;
  createdDate?: unknown;
  lastUpdatedDate?: Date;
}

class FakeApiGateway {
  readonly violations: string[] = [];
  readonly calls: string[] = [];
  /** Hostile mode: return `value` even when not asked, to prove the checker drops it. */
  leakValues = false;
  failGetApiKeyFor = new Set<string>();

  constructor(public keys: FakeKey[], private readonly pageSize = 2) {}

  private render(key: FakeKey): Record<string, unknown> {
    return {
      id: key.id,
      name: key.name,
      enabled: key.enabled,
      createdDate: key.createdDate,
      lastUpdatedDate: key.lastUpdatedDate,
      stageKeys: [],
      ...(this.leakValues ? { value: VALUE_SENTINEL } : {}),
    };
  }

  async send(command: unknown): Promise<unknown> {
    if (command instanceof GetApiKeysCommand) {
      this.calls.push('GetApiKeys');
      if (command.input.includeValues !== false) {
        this.violations.push(`GetApiKeys includeValues=${String(command.input.includeValues)}`);
        throw new Error('test harness: value-returning GetApiKeys refused');
      }
      const start = command.input.position ? Number(command.input.position.replace('opaque-', '')) : 0;
      const end = Math.min(start + Math.min(this.pageSize, command.input.limit ?? 25), this.keys.length);
      return {
        items: this.keys.slice(start, end).map(key => this.render(key)),
        position: end < this.keys.length ? `opaque-${end}` : undefined,
      };
    }
    if (command instanceof GetApiKeyCommand) {
      this.calls.push(`GetApiKey ${command.input.apiKey}`);
      if (command.input.includeValue !== false) {
        this.violations.push(`GetApiKey includeValue=${String(command.input.includeValue)}`);
        throw new Error('test harness: value-returning GetApiKey refused');
      }
      if (this.failGetApiKeyFor.has(command.input.apiKey!)) {
        const error = new Error('throttled');
        error.name = 'TooManyRequestsException';
        throw error;
      }
      const key = this.keys.find(k => k.id === command.input.apiKey);
      if (!key) throw Object.assign(new Error('not found'), { name: 'NotFoundException' });
      return this.render(key);
    }
    const name = (command as { constructor: { name: string } }).constructor.name;
    this.violations.push(`unexpected command ${name}`);
    throw new Error(`test harness: ${name} refused`);
  }
}

class FakeSns {
  readonly published: { subject: string; event: RotationEvent }[] = [];
  readonly raw: string[] = [];
  failFor = new Set<string>();

  async send(command: PublishCommand): Promise<unknown> {
    expect(command).toBeInstanceOf(PublishCommand);
    expect(command.input.TopicArn).toBe(TOPIC_ARN);
    const event = JSON.parse(command.input.Message!) as RotationEvent;
    if (this.failFor.has(event.consumerId)) throw Object.assign(new Error('nope'), { name: 'AuthorizationErrorException' });
    this.raw.push(JSON.stringify(command.input));
    this.published.push({ subject: command.input.Subject!, event });
    return { MessageId: 'm' };
  }

  overdue(consumerId?: string) {
    return this.published.map(p => p.event)
      .filter(e => e.event === 'ingestion_api_key_rotation_overdue' && (!consumerId || e.consumerId === consumerId));
  }

  inconsistencies(consumerId?: string) {
    return this.published.map(p => p.event)
      .filter((e): e is Extract<RotationEvent, { event: 'ingestion_api_key_rotation_inconsistency' }> =>
        e.event === 'ingestion_api_key_rotation_inconsistency' && (!consumerId || e.consumerId === consumerId));
  }
}

// Design timeline: deploy 1 starts at T0; the new key's createdDate is T0 + 4 minutes, at
// second precision with a nonzero UTC offset; the stack reaches UPDATE_COMPLETE at T0 + 9
// minutes. Only createdDate starts the clock.
const T0 = new Date('2026-09-21T15:30:04+08:00');
const ALPHA_B_CREATED = '2026-09-21T15:34:04+08:00';
const UPDATE_COMPLETE = new Date(T0.getTime() + 9 * 60 * 1000);
const ALPHA_B_CREATED_MS = new Date(ALPHA_B_CREATED).getTime();
const THRESHOLD_MS = ALPHA_B_CREATED_MS + 168 * HOUR_MS;
const OLD_KEY_CREATED = new Date('2026-03-01T12:00:00Z');

const OVERLAP: CheckerConsumer['apiKey'] = { primarySlot: 'a', rotation: { secondarySlot: 'b', phase: 'overlap' } };
const OLD_DISABLED: CheckerConsumer['apiKey'] = { primarySlot: 'a', rotation: { secondarySlot: 'b', phase: 'old-disabled' } };
const STEADY: CheckerConsumer['apiKey'] = { primarySlot: 'a' };

function alphaA(overrides: Partial<FakeKey> = {}): FakeKey {
  return { id: 'alpha-a', name: 'particle-ingestion-alpha', enabled: true, createdDate: OLD_KEY_CREATED, ...overrides };
}
function alphaB(overrides: Partial<FakeKey> = {}): FakeKey {
  // The SDK hands the checker a Date; built here from the CLI-rendered offset string.
  return {
    id: 'alpha-b',
    name: 'particle-ingestion-alpha-b',
    enabled: true,
    createdDate: new Date(ALPHA_B_CREATED),
    lastUpdatedDate: new Date(ALPHA_B_CREATED_MS + 30 * HOUR_MS),
    ...overrides,
  };
}
const BETA_A: FakeKey = { id: 'beta-a', name: 'particle-ingestion-beta', enabled: true, createdDate: OLD_KEY_CREATED };
const UNRELATED: FakeKey = { id: 'other-1', name: 'some-other-api-key', enabled: true, createdDate: OLD_KEY_CREATED };

let infoLog: jest.SpyInstance;

beforeEach(() => {
  infoLog = jest.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

async function check(
  keys: FakeKey[],
  consumers: CheckerConsumer[],
  now: number | Date,
  setup: (api: FakeApiGateway, sns: FakeSns) => void = () => undefined
): Promise<{ api: FakeApiGateway; sns: FakeSns; error?: Error }> {
  const api = new FakeApiGateway(keys);
  const sns = new FakeSns();
  setup(api, sns);
  let error: Error | undefined;
  try {
    await runRotationCheck({ apiGateway: api, sns, topicArn: TOPIC_ARN, now: new Date(now), consumers });
  } catch (e) {
    error = e as Error;
  }
  expect(api.violations).toEqual([]);
  const everything = JSON.stringify([sns.raw, infoLog.mock.calls, error?.message]);
  expect(everything).not.toContain(VALUE_SENTINEL);
  expect(everything).not.toMatch(/"value"/);
  return { api, sns, error };
}

describe('the rotation clock is the secondary key\'s createdDate', () => {
  const consumers: CheckerConsumer[] = [{ id: 'alpha', apiKey: OVERLAP }, { id: 'beta', apiKey: STEADY }];
  const keys = () => [alphaA(), UNRELATED, alphaB(), BETA_A];

  test.each([
    ['1 ms before createdDate + 168 h', THRESHOLD_MS - 1, 0],
    ['exactly createdDate + 168 h', THRESHOLD_MS, 1],
    ['1 ms after', THRESHOLD_MS + 1, 1],
  ])('%s: %i overdue event(s)', async (_label, now, expected) => {
    const { sns, error } = await check(keys(), consumers, now);
    expect(error).toBeUndefined();
    expect(sns.overdue('alpha')).toHaveLength(expected);
    expect(sns.overdue('beta')).toHaveLength(0);
    expect(sns.inconsistencies()).toHaveLength(0);
  });

  test('stack completion and lastUpdatedDate do not move the threshold', async () => {
    // UPDATE_COMPLETE + 168 h - 1 ms is already past createdDate + 168 h: still overdue.
    const pastByCreated = UPDATE_COMPLETE.getTime() + 168 * HOUR_MS - 1;
    expect(pastByCreated).toBeGreaterThan(THRESHOLD_MS);
    expect((await check(keys(), consumers, pastByCreated)).sns.overdue('alpha')).toHaveLength(1);
    // lastUpdatedDate (createdDate + 30 h) is ignored: 1 ms before the createdDate threshold is quiet.
    expect((await check(keys(), consumers, THRESHOLD_MS - 1)).sns.overdue('alpha')).toHaveLength(0);
  });

  test('createdDate as the CLI-rendered offset string is parsed as the same instant', async () => {
    const stringKeys = [alphaA(), alphaB({ createdDate: ALPHA_B_CREATED }), BETA_A];
    expect((await check(stringKeys, consumers, THRESHOLD_MS - 1)).sns.overdue()).toHaveLength(0);
    expect((await check(stringKeys, consumers, THRESHOLD_MS)).sns.overdue()).toHaveLength(1);
  });

  test('scheduled 09:00 UTC runs: none before the threshold, then one structured event per daily run', async () => {
    // Threshold is 2026-09-28T07:34:04Z.
    expect(new Date(THRESHOLD_MS).toISOString()).toBe('2026-09-28T07:34:04.000Z');
    const runs = ['2026-09-27T09:00:00Z', '2026-09-28T09:00:00Z', '2026-09-29T09:00:00Z', '2026-09-30T09:00:00Z'];
    const perRun = [];
    for (const run of runs) perRun.push((await check(keys(), consumers, new Date(run))).sns);
    expect(perRun.map(sns => sns.overdue('alpha').length)).toEqual([0, 1, 1, 1]);
    expect(perRun[1].published).toEqual([{
      subject: 'Ingestion API key rotation overdue: alpha',
      event: {
        event: 'ingestion_api_key_rotation_overdue',
        consumerId: 'alpha',
        phase: 'overlap',
        secondaryKeyId: 'alpha-b',
        secondaryKeyCreatedDate: '2026-09-21T07:34:04.000Z',
        alertTargetAt: '2026-09-28T07:34:04.000Z',
        daysOverdue: 0,
        keys: [{ id: 'alpha-a', slot: 'a', enabled: true }, { id: 'alpha-b', slot: 'b', enabled: true }],
      },
    }]);
    expect(perRun[3].overdue('alpha')[0]).toMatchObject({ daysOverdue: 2 });
  });

  test('a recreated secondary key starts its own target and is reported under its new ID', async () => {
    const recreatedAt = new Date('2026-09-25T10:00:00Z');
    const recreated = [alphaA(), alphaB({ id: 'alpha-b-2', createdDate: recreatedAt }), BETA_A];
    // Past the original key's threshold, but not the replacement's: quiet.
    expect((await check(recreated, consumers, THRESHOLD_MS + HOUR_MS)).sns.overdue()).toHaveLength(0);
    const { sns } = await check(recreated, consumers, recreatedAt.getTime() + 168 * HOUR_MS);
    expect(sns.overdue('alpha')).toEqual([expect.objectContaining({ secondaryKeyId: 'alpha-b-2', secondaryKeyCreatedDate: recreatedAt.toISOString() })]);
  });
});

describe('rotation state comes from the observed key count', () => {
  const late = THRESHOLD_MS + 2 * 24 * HOUR_MS;

  test('1 key, no declared rotation: steady state, no events, no GetApiKey reads', async () => {
    const { sns, api } = await check([alphaA(), BETA_A], [{ id: 'alpha', apiKey: STEADY }, { id: 'beta', apiKey: STEADY }], late);
    expect(sns.published).toEqual([]);
    expect(api.calls.filter(c => c.startsWith('GetApiKey '))).toEqual([]);
  });

  test('2 enabled keys (overlap): timed overdue event', async () => {
    const { sns } = await check([alphaA(), alphaB(), BETA_A], [{ id: 'alpha', apiKey: OVERLAP }, { id: 'beta', apiKey: STEADY }], late);
    expect(sns.overdue('alpha')).toEqual([expect.objectContaining({ phase: 'overlap', daysOverdue: 2 })]);
    expect(sns.inconsistencies()).toEqual([]);
  });

  test('2 keys, old one disabled (old-disabled): the disabled key still counts, overdue continues daily', async () => {
    const keys = [alphaA({ enabled: false }), alphaB(), BETA_A];
    const consumers = [{ id: 'alpha', apiKey: OLD_DISABLED }, { id: 'beta', apiKey: STEADY }];
    for (const day of [0, 1, 2]) {
      const { sns } = await check(keys, consumers, THRESHOLD_MS + day * 24 * HOUR_MS);
      expect(sns.overdue('alpha')).toEqual([expect.objectContaining({
        phase: 'old-disabled',
        daysOverdue: day,
        keys: [{ id: 'alpha-a', slot: 'a', enabled: false }, { id: 'alpha-b', slot: 'b', enabled: true }],
      })]);
    }
  });

  test('deploy 3 leaves one key: overdue alerts stop once the checker observes it', async () => {
    const { sns } = await check([alphaB(), BETA_A], [{ id: 'alpha', apiKey: { primarySlot: 'b' } }, { id: 'beta', apiKey: STEADY }], late);
    expect(sns.published).toEqual([]);
  });

  test('0 keys: inconsistency, not healthy', async () => {
    const { sns } = await check([BETA_A], [{ id: 'alpha', apiKey: STEADY }, { id: 'beta', apiKey: STEADY }], late);
    expect(sns.inconsistencies()).toEqual([expect.objectContaining({ consumerId: 'alpha', reason: 'no_keys', keyCount: 0 })]);
  });

  test('1 key with a declared rotation: inconsistency, not a completed migration', async () => {
    const { sns } = await check([alphaA(), BETA_A], [{ id: 'alpha', apiKey: OVERLAP }, { id: 'beta', apiKey: STEADY }], late);
    expect(sns.inconsistencies()).toEqual([expect.objectContaining({ consumerId: 'alpha', reason: 'rotation_declared_with_one_key', keyCount: 1 })]);
    expect(sns.overdue()).toEqual([]);
  });

  test('2 keys without a declared rotation: inconsistency, plus overdue from the newer key\'s createdDate', async () => {
    const { sns } = await check([alphaA(), alphaB(), BETA_A], [{ id: 'alpha', apiKey: STEADY }, { id: 'beta', apiKey: STEADY }], THRESHOLD_MS);
    expect(sns.inconsistencies('alpha')).toEqual([expect.objectContaining({ reason: 'two_keys_without_declared_rotation', keyCount: 2 })]);
    expect(sns.overdue('alpha')).toEqual([expect.objectContaining({ secondaryKeyId: 'alpha-b', phase: null })]);
    const quiet = await check([alphaA(), alphaB(), BETA_A], [{ id: 'alpha', apiKey: STEADY }, { id: 'beta', apiKey: STEADY }], THRESHOLD_MS - 1);
    expect(quiet.sns.overdue()).toEqual([]);
    expect(quiet.sns.inconsistencies('alpha')).toHaveLength(1);
  });

  test('3 keys (a duplicated slot name): ambiguity inconsistency, no guessed owner', async () => {
    const keys = [alphaA(), alphaA({ id: 'alpha-a-dup' }), alphaB(), BETA_A];
    const { sns, api } = await check(keys, [{ id: 'alpha', apiKey: OVERLAP }, { id: 'beta', apiKey: STEADY }], late);
    expect(sns.inconsistencies()).toEqual([expect.objectContaining({ consumerId: 'alpha', reason: 'ambiguous_key_names', keyCount: 3 })]);
    expect(sns.overdue()).toEqual([]);
    expect(api.calls.filter(c => c.startsWith('GetApiKey '))).toEqual([]);
  });

  test('the secondary must be newer than the primary', async () => {
    const keys = [alphaA({ createdDate: new Date(ALPHA_B_CREATED_MS + 1000) }), alphaB(), BETA_A];
    const { sns } = await check(keys, [{ id: 'alpha', apiKey: OVERLAP }, { id: 'beta', apiKey: STEADY }], THRESHOLD_MS - 1);
    expect(sns.inconsistencies('alpha')).toEqual([expect.objectContaining({ reason: 'secondary_not_newer_than_primary' })]);
  });

  test.each([
    ['missing', undefined],
    ['unparseable string', 'last tuesday'],
    ['offset-less string', '2026-09-21T15:34:04'],
    ['invalid Date', new Date('nope')],
  ])('%s createdDate: inconsistency, never healthy or silently skipped', async (_label, createdDate) => {
    const { sns, error } = await check([alphaA(), alphaB({ createdDate }), BETA_A], [{ id: 'alpha', apiKey: OVERLAP }, { id: 'beta', apiKey: STEADY }], late);
    expect(error).toBeUndefined();
    expect(sns.inconsistencies()).toEqual([expect.objectContaining({ consumerId: 'alpha', reason: 'missing_created_date' })]);
    expect(sns.overdue()).toEqual([]);
  });

  test('a healthy beta stays quiet while alpha is overdue', async () => {
    const { sns } = await check([alphaA(), alphaB(), BETA_A], [{ id: 'alpha', apiKey: OVERLAP }, { id: 'beta', apiKey: STEADY }], late);
    expect(sns.published.map(p => p.event.consumerId)).toEqual(['alpha']);
  });
});

describe('keys are attributed by exact full name', () => {
  test('alpha and alpha-long: each key counts only for its owner, regardless of prefix or enabled state', async () => {
    const keys = [
      { id: 'along-a', name: 'particle-ingestion-alpha-long', enabled: true, createdDate: OLD_KEY_CREATED },
      alphaA(),
      { id: 'along-x', name: 'particle-ingestion-alpha-longer', enabled: true, createdDate: OLD_KEY_CREATED },
      alphaB({ enabled: false }),
      { id: 'x', name: 'particle-ingestion-alpha-b-extra', enabled: true, createdDate: OLD_KEY_CREATED },
    ];
    const { sns, api } = await check(keys, [{ id: 'alpha', apiKey: OLD_DISABLED }, { id: 'alpha-long', apiKey: STEADY }], THRESHOLD_MS);
    expect(sns.inconsistencies()).toEqual([]);
    expect(sns.overdue()).toEqual([expect.objectContaining({ consumerId: 'alpha', secondaryKeyId: 'alpha-b' })]);
    expect(api.calls.filter(c => c.startsWith('GetApiKey ')).sort()).toEqual(['GetApiKey alpha-a', 'GetApiKey alpha-b']);
  });

  test('keys spread across GetApiKeys pages are all seen', async () => {
    const keys = [UNRELATED, BETA_A, { ...UNRELATED, id: 'other-2', name: 'other-2' }, { ...UNRELATED, id: 'other-3', name: 'other-3' }, alphaA(), alphaB()];
    const { sns, api } = await check(keys, [{ id: 'alpha', apiKey: OVERLAP }, { id: 'beta', apiKey: STEADY }], THRESHOLD_MS);
    expect(api.calls.filter(c => c === 'GetApiKeys')).toHaveLength(3);
    expect(sns.overdue('alpha')).toHaveLength(1);
  });
});

describe('credential values never reach the checker\'s output', () => {
  test('even if API Gateway returned values, none reach an alert, log, or error', async () => {
    const { sns } = await check(
      [alphaA(), alphaB(), BETA_A],
      [{ id: 'alpha', apiKey: OVERLAP }, { id: 'beta', apiKey: STEADY }],
      THRESHOLD_MS,
      api => { api.leakValues = true; }
    );
    expect(sns.overdue('alpha')).toHaveLength(1);
    // check() itself asserts the sentinel is absent from every SNS message, log line, and error.
  });

  test('the harness really refuses value-returning reads (so the assertions above can fail)', async () => {
    const api = new FakeApiGateway([alphaA()]);
    await expect(api.send(new GetApiKeysCommand({ includeValues: true }))).rejects.toThrow('refused');
    await expect(api.send(new GetApiKeyCommand({ apiKey: 'alpha-a', includeValue: true }))).rejects.toThrow('refused');
    await expect(api.send(new GetApiKeyCommand({ apiKey: 'alpha-a' }))).rejects.toThrow('refused');
    await expect(api.send(new GetUsagePlanKeysCommand({ usagePlanId: 'p' }))).rejects.toThrow('refused');
    expect(api.violations).toEqual([
      'GetApiKeys includeValues=true',
      'GetApiKey includeValue=true',
      'GetApiKey includeValue=undefined',
      'unexpected command GetUsagePlanKeysCommand',
    ]);
  });

  test('the checker source imports only the two value-free read commands from API Gateway', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'api-key-rotation-checker.ts'), 'utf8');
    const imports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@aws-sdk\/client-api-gateway'/g)];
    expect(imports).toHaveLength(1);
    expect(imports[0][1].split(',').map(s => s.trim()).filter(Boolean).sort()).toEqual(['APIGatewayClient', 'GetApiKeyCommand', 'GetApiKeysCommand']);
    expect(source).not.toMatch(/includeValues?:\s*true/);
    expect(source).not.toMatch(/require\(\s*'@aws-sdk\/client-api-gateway'/);
  });
});

describe('checker failures surface as errors (for the Errors alarm), not a quiet day', () => {
  const consumers: CheckerConsumer[] = [{ id: 'alpha', apiKey: OVERLAP }, { id: 'beta', apiKey: OVERLAP }];
  const keys = () => [alphaA(), alphaB(), { ...BETA_A }, { id: 'beta-b', name: 'particle-ingestion-beta-b', enabled: true, createdDate: new Date(ALPHA_B_CREATED) }];

  test('a publish failure for one consumer still publishes the others, then throws', async () => {
    const { sns, error } = await check(keys(), consumers, THRESHOLD_MS, (_api, s) => { s.failFor.add('alpha'); });
    expect(sns.overdue('beta')).toHaveLength(1);
    expect(error?.message).toMatch(/alpha.*AuthorizationErrorException/);
  });

  test('a GetApiKey failure publishes an inconsistency for that consumer and throws', async () => {
    const { sns, error } = await check(keys(), consumers, THRESHOLD_MS, api => { api.failGetApiKeyFor.add('alpha-b'); });
    expect(sns.inconsistencies('alpha')).toEqual([expect.objectContaining({ reason: 'missing_created_date' })]);
    expect(sns.overdue('beta')).toHaveLength(1);
    expect(error?.message).toMatch(/alpha: GetApiKey alpha-b failed: TooManyRequestsException/);
  });

  test('a GetApiKeys failure fails the whole run', async () => {
    const api = { send: jest.fn().mockRejectedValue(new Error('AccessDeniedException')) };
    const sns = new FakeSns();
    await expect(runRotationCheck({ apiGateway: api, sns, topicArn: TOPIC_ARN, now: new Date(THRESHOLD_MS), consumers }))
      .rejects.toThrow('AccessDeniedException');
    expect(sns.published).toEqual([]);
  });
});

test('ROTATION_ALERT_TARGET_MS is seven days', () => {
  expect(ROTATION_ALERT_TARGET_MS).toBe(7 * 24 * HOUR_MS);
});
