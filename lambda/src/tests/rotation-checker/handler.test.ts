/**
 * Production-handler fixture (WO-2026-09-30-001 design, Revision 5). Runs the exported
 * `handler` -- real adapter, core, and emitters, real SDK clients -- against a local fake
 * API Gateway/SNS endpoint. It does not use the real bundled registry: the jest.mock below
 * gives the handler and this test the real consumer IDs, each in steady state, so the
 * expectations hold in any rotation state of the checked-in file. The real registry and
 * bundle run in infra/test/api-key-rotation.test.ts's deployed-entry-point test. Every
 * registered consumer is given its own key state that yields exactly one attributable event,
 * so a handler that skips any consumer, publishes to the wrong topic, or uses the wrong clock
 * fails here.
 */
jest.mock('../../../../config/ingestion-consumers.json', () => {
  const real = jest.requireActual('../../../../config/ingestion-consumers.json');
  return { ...real, consumers: real.consumers.map((c: object) => ({ ...c, apiKey: { primarySlot: 'a' } })) };
});
import consumerRegistry from '../../../../config/ingestion-consumers.json';
import { CHECKER_FAILED_MESSAGE, handler } from '../../rotation-checker/handler';
import * as core from '../../rotation-checker/rotation-core';
import { VALUE_SENTINEL, allOwnKeys, findSentinel } from '../helpers/sentinel';
import { FakeAwsEndpoint, WireKey, apiKeysPage, awsEnvFor, startFakeAwsEndpoint } from '../helpers/fake-aws-endpoint';

const TOPIC = 'arn:aws:sns:us-east-1:123456789012:rotation-from-env';
const HOUR_S = 60 * 60;
const registered = (consumerRegistry.consumers as { id: string }[]).map(c => c.id);

const originalEnv = process.env;
let endpoint: FakeAwsEndpoint;
let info: jest.SpyInstance;

beforeEach(async () => {
  endpoint = await startFakeAwsEndpoint();
  process.env = { ...awsEnvFor(endpoint.url), ROTATION_ALERT_TOPIC_ARN: TOPIC };
  info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(async () => {
  process.env = originalEnv;
  jest.restoreAllMocks();
  await endpoint.close();
});

/**
 * Each registered consumer: two keys, no declared rotation. Every secondary is 100 h old
 * (not overdue) except the last consumer's, which is 200 h old (overdue by 32 h). Only the
 * real clock yields exactly that: a clock far in the past makes nothing overdue, one far
 * in the future makes everything overdue.
 */
const OVERDUE_CONSUMER_INDEX = registered.length - 1;
function secondaryAgeHours(i: number): number {
  return i === OVERDUE_CONSUMER_INDEX ? 200 : 100;
}
function everyConsumerMidRotation(nowSeconds: number): WireKey[] {
  return registered.flatMap((id, i) => [
    { id: `key${i}a`, name: `particle-ingestion-${id}`, enabled: true, createdDate: nowSeconds - 2000 * HOUR_S, value: VALUE_SENTINEL },
    { id: `key${i}b`, name: `particle-ingestion-${id}-b`, enabled: true, createdDate: nowSeconds - secondaryAgeHours(i) * HOUR_S, value: VALUE_SENTINEL },
  ]);
}
function expectedEvents(nowSeconds: number): unknown[] {
  return registered.flatMap((id, i) => {
    const keys = [{ slot: 'a', enabled: true }, { slot: 'b', enabled: true }];
    const inconsistency = { event: 'ingestion_api_key_rotation_inconsistency', consumerId: id, reason: 'two_keys_without_declared_rotation', keyCount: 2, keys };
    if (i !== OVERDUE_CONSUMER_INDEX) return [inconsistency];
    const createdMs = (nowSeconds - secondaryAgeHours(i) * HOUR_S) * 1000;
    return [inconsistency, {
      event: 'ingestion_api_key_rotation_overdue',
      consumerId: id,
      phase: null,
      secondarySlot: 'b',
      secondaryKeyCreatedDate: new Date(createdMs).toISOString(),
      alertTargetAt: new Date(createdMs + 168 * HOUR_S * 1000).toISOString(),
      daysOverdue: 1,
      keys,
    }];
  });
}

const published = () => endpoint.requests.filter(r => r.form.Action === 'Publish');
const publishedEvents = () => published().map(r => JSON.parse(r.form.Message));
const loggedSummaries = () => info.mock.calls.map(([line]) => JSON.parse(line as string));

async function rejection(): Promise<Error> {
  try {
    await handler();
  } catch (e) {
    return e as Error;
  }
  throw new Error('handler did not throw');
}

test('every registered consumer is evaluated and reported, to the topic from the environment, on the real clock', async () => {
  expect(registered.length).toBeGreaterThanOrEqual(2);
  const nowSeconds = Math.floor(Date.now() / 1000);
  endpoint.getApiKeys = () => apiKeysPage(everyConsumerMidRotation(nowSeconds));

  const startedMs = Date.now();
  await handler();
  const finishedMs = Date.now();

  expect(endpoint.requests.filter(r => r.path === '/apikeys').map(r => r.query)).toEqual([{ includeValues: 'false', limit: '500' }]);
  const events = publishedEvents();
  expect(published().map(r => r.form.TopicArn)).toEqual(events.map(() => TOPIC));
  expect([...new Set(events.map(e => e.consumerId))].sort()).toEqual([...registered].sort());
  expect(events).toEqual(expectedEvents(nowSeconds));
  const summaries = loggedSummaries();
  expect(summaries).toEqual([{
    event: 'ingestion_api_key_rotation_check',
    checkedAt: expect.any(String),
    consumersChecked: registered.length,
    overdue: [registered[OVERDUE_CONSUMER_INDEX]],
    inconsistencies: registered.map(id => ({ consumerId: id, reason: 'two_keys_without_declared_rotation' })),
    failure: null,
    publishFailures: 0,
  }]);
  // The run's clock is the real one: checkedAt falls inside the call.
  const checkedAtMs = Date.parse(summaries[0].checkedAt);
  expect(checkedAtMs).toBeGreaterThanOrEqual(startedMs);
  expect(checkedAtMs).toBeLessThanOrEqual(finishedMs);
  expect(findSentinel([endpoint.requests, info.mock.calls])).toEqual([]);
});

test('an API Gateway failure carrying the value: fixed checker-failure alert, fixed summary, fixed thrown error', async () => {
  endpoint.getApiKeys = () => ({
    status: 400,
    headers: { 'content-type': 'application/json', 'x-amzn-errortype': `Bad${VALUE_SENTINEL}`, 'x-amzn-requestid': VALUE_SENTINEL },
    body: JSON.stringify({ message: VALUE_SENTINEL }),
  });
  const thrown = await rejection();
  expect(thrown.message).toBe(CHECKER_FAILED_MESSAGE);
  expect(thrown.cause).toBeUndefined();
  expect(allOwnKeys(thrown).sort()).toEqual(['message', 'stack']);
  expect(publishedEvents()).toEqual([{ event: 'ingestion_api_key_rotation_checker_failed', failure: 'api_gateway_read_failed' }]);
  expect(loggedSummaries()).toEqual([expect.objectContaining({ failure: 'api_gateway_read_failed', overdue: [], inconsistencies: [] })]);
  expect(findSentinel([thrown, endpoint.requests.filter(r => r.form.Action), info.mock.calls])).toEqual([]);
});

test('without a configured topic it fails before any API Gateway call', async () => {
  delete process.env.ROTATION_ALERT_TOPIC_ARN;
  const thrown = await rejection();
  expect(thrown.message).toBe(CHECKER_FAILED_MESSAGE);
  expect(endpoint.requests).toEqual([]);
  expect(loggedSummaries()).toEqual([expect.objectContaining({ failure: 'alert_topic_not_configured' })]);
});

test('a publish failure still attempts every event exactly once (no SDK retries), then fails with the fixed error', async () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  endpoint.getApiKeys = () => apiKeysPage(everyConsumerMidRotation(nowSeconds));
  endpoint.publish = () => ({ status: 500, headers: { 'content-type': 'text/xml' }, body: `<ErrorResponse><Error><Code>Internal${VALUE_SENTINEL}</Code><Message>${VALUE_SENTINEL}</Message></Error><RequestId>${VALUE_SENTINEL}</RequestId></ErrorResponse>` });
  const thrown = await rejection();
  expect(thrown.message).toBe(CHECKER_FAILED_MESSAGE);
  // One wire request per event, in order: the design's "no retries" holds at the SDK too.
  const expected = expectedEvents(nowSeconds);
  expect(published()).toHaveLength(expected.length);
  expect(publishedEvents()).toEqual(expected);
  expect(loggedSummaries()).toEqual([expect.objectContaining({ publishFailures: expected.length, failure: null })]);
  expect(findSentinel([thrown, info.mock.calls])).toEqual([]);
});

test('an unexpected exception inside the run is reduced to the fixed error; the exception is never relayed', async () => {
  endpoint.getApiKeys = () => apiKeysPage([]);
  const boom = Object.assign(new Error(VALUE_SENTINEL), { name: VALUE_SENTINEL, extra: VALUE_SENTINEL });
  jest.spyOn(core, 'evaluateRotation').mockImplementation(() => { throw boom; });
  const thrown = await rejection();
  expect(thrown.message).toBe(CHECKER_FAILED_MESSAGE);
  expect(thrown).not.toBe(boom);
  expect(thrown.cause).toBeUndefined();
  expect(loggedSummaries()).toEqual([expect.objectContaining({ failure: 'unexpected_checker_error' })]);
  expect(findSentinel([thrown, info.mock.calls])).toEqual([]);
});
