/**
 * Typed emitters (WO-2026-09-30-001 design, Revision 5): each serializes only the declared
 * fields of its closed record type, by name. Asserted on the exact command and log line
 * produced, including when a record arrives carrying an undeclared runtime property.
 */
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { createAlertPublisher, eventFields, logRunSummary, summaryFields } from '../../rotation-checker/emitters';
import { RotationEvent, RotationRunSummary } from '../../rotation-checker/records';
import { VALUE_SENTINEL, findSentinel } from '../helpers/sentinel';
import { awsEnvFor, startFakeAwsEndpoint } from '../helpers/fake-aws-endpoint';

const TOPIC = 'arn:aws:sns:us-east-1:123456789012:rotation';

const OVERDUE: RotationEvent = {
  event: 'ingestion_api_key_rotation_overdue',
  consumerId: 'alpha',
  phase: 'overlap',
  secondarySlot: 'b',
  secondaryKeyCreatedDate: '2026-09-21T07:34:04.000Z',
  alertTargetAt: '2026-09-28T07:34:04.000Z',
  daysOverdue: 0,
  keys: [{ slot: 'a', enabled: true }, { slot: 'b', enabled: true }],
};
const INCONSISTENT: RotationEvent = {
  event: 'ingestion_api_key_rotation_inconsistency', consumerId: 'beta', reason: 'no_keys', keyCount: 0, keys: [],
};
const FAILED: RotationEvent = { event: 'ingestion_api_key_rotation_checker_failed', failure: 'api_gateway_read_failed' };

/** A record carrying undeclared runtime properties, as a type assertion would let through. */
function smuggled<T extends object>(record: T): T {
  const copy = { ...record, value: VALUE_SENTINEL, error: new Error(VALUE_SENTINEL) } as T;
  Object.defineProperty(copy, 'hidden', { value: VALUE_SENTINEL, enumerable: false });
  if ('keys' in copy) (copy as { keys: unknown[] }).keys = (copy as { keys: object[] }).keys.map(k => ({ ...k, value: VALUE_SENTINEL }));
  return copy;
}

afterEach(() => jest.restoreAllMocks());

describe('SNS alert publisher', () => {
  test.each([
    ['overdue', OVERDUE, 'Ingestion API key rotation overdue: alpha'],
    ['inconsistency', INCONSISTENT, 'Ingestion API key rotation inconsistency: beta'],
    ['checker failure', FAILED, 'Ingestion API key rotation checker failed'],
  ])('%s: publishes exactly the declared fields, even from a record carrying extra properties', async (_label, event, subject) => {
    const sent: PublishCommand[] = [];
    jest.spyOn(SNSClient.prototype, 'send').mockImplementation(async command => { sent.push(command as PublishCommand); return {} as never; });
    expect(await createAlertPublisher(TOPIC).publish(smuggled(event))).toBe('published');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(PublishCommand);
    expect(sent[0].input).toEqual({ TopicArn: TOPIC, Subject: subject, Message: JSON.stringify(event, null, 2) });
    expect(findSentinel(sent[0].input)).toEqual([]);
  });

  test('a publish failure becomes a fixed outcome; the SNS error is never touched', async () => {
    const touched: string[] = [];
    const watcher = new Proxy({}, {
      get: (_t, key) => { touched.push(String(key)); return undefined; },
      ownKeys: () => { touched.push('ownKeys'); return []; },
      getPrototypeOf: () => { touched.push('getPrototypeOf'); return null; },
    });
    jest.spyOn(SNSClient.prototype, 'send').mockImplementation(async () => { throw watcher; });
    expect(await createAlertPublisher(TOPIC).publish(OVERDUE)).toBe('publish_failed');
    expect(touched).toEqual([]);
  });
});

test('a failed publish is attempted exactly once on the wire: the design\'s "no retries" holds inside the SDK too', async () => {
  const endpoint = await startFakeAwsEndpoint();
  const originalEnv = process.env;
  try {
    process.env = { ...awsEnvFor(endpoint.url) };
    endpoint.publish = () => ({ status: 500, headers: { 'content-type': 'text/xml' }, body: '<ErrorResponse><Error><Code>InternalError</Code></Error></ErrorResponse>' });
    expect(await createAlertPublisher(TOPIC).publish(OVERDUE)).toBe('publish_failed');
    expect(endpoint.requests.filter(r => r.form.Action === 'Publish')).toHaveLength(1);
  } finally {
    process.env = originalEnv;
    await endpoint.close();
  }
});

describe('run-summary logger', () => {
  const SUMMARY: RotationRunSummary = {
    event: 'ingestion_api_key_rotation_check',
    checkedAt: '2026-09-28T09:00:00.000Z',
    consumersChecked: 2,
    overdue: ['alpha'],
    inconsistencies: [{ consumerId: 'beta', reason: 'no_keys' }],
    failure: null,
    publishFailures: 0,
  };

  test('logs exactly one line with exactly the declared fields, even from a record carrying extra properties', () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const extra = smuggled(SUMMARY);
    (extra as { inconsistencies: unknown }).inconsistencies = SUMMARY.inconsistencies.map(i => ({ ...i, value: VALUE_SENTINEL }));
    logRunSummary(extra);
    expect(info.mock.calls).toEqual([[JSON.stringify(SUMMARY)]]);
    expect(summaryFields(extra)).toEqual(SUMMARY);
  });

  test('eventFields reproduces each declared event exactly', () => {
    for (const event of [OVERDUE, INCONSISTENT, FAILED]) expect(eventFields(smuggled(event))).toEqual(event);
  });
});
