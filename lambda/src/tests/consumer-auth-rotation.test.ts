/**
 * WO-2026-09-30-001 auth-path fixtures, as specified by the design's "Required
 * implementation verification" section (consumers alpha and beta; alpha has key IDs
 * alpha-a and alpha-b, beta has beta-a). End to end through handleIngestion with the real
 * consumer-auth.ts -- only the bundled registry, Secrets Manager, and storage are stubbed --
 * so each assertion is on the HTTP status a client would see.
 */
import * as crypto from 'crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { handleIngestion } from '../ingestion';
import { resetConsumerAuthCacheForTests } from '../consumer-auth';
import { InboundEvent } from '../types';

jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return { ...actual, timingSafeEqual: jest.fn(actual.timingSafeEqual) };
});

// The registry the Lambda bundles. Mutated per test via setRegistry() below.
jest.mock('../../../config/ingestion-consumers.json', () => ({ schemaVersion: 2, consumers: [] }));
const mockRegistry: { consumers: unknown[] } = jest.requireMock('../../../config/ingestion-consumers.json');
jest.mock('../storage/s3');
jest.mock('../storage/dynamo');
jest.mock('../storage/current-state');
jest.mock('../integrations/particle-api');

const SECRET_BY_CONSUMER: Record<string, string> = {
  alpha: 'alpha-webhook-secret-fixture-'.padEnd(64, 'x'),
  beta: 'beta-webhook-secret-fixture-'.padEnd(64, 'y'),
  gamma: 'gamma-webhook-secret-fixture-'.padEnd(64, 'z'),
};

function consumer(id: string, apiKey: unknown): unknown {
  return {
    id,
    displayName: id,
    secretName: `test/consumers/${id}/webhook-secret`,
    usagePlan: { ratePerSecond: 10, burst: 50 },
    status: 'active',
    apiKey,
  };
}

function setRegistry(consumers: unknown[]): void {
  mockRegistry.consumers = consumers;
}

const OVERLAP = { primarySlot: 'a', rotation: { secondarySlot: 'b', phase: 'overlap' } };
const STEADY = { primarySlot: 'a' };

const ROTATION_ENV = {
  INGESTION_API_KEY_ID_ALPHA: 'alpha-a',
  INGESTION_API_KEY_ROTATION_ID_ALPHA: 'alpha-b',
  INGESTION_API_KEY_ID_BETA: 'beta-a',
};

async function post(apiKeyId: string, secretOf: string | undefined): Promise<number> {
  const event: InboundEvent = {
    body: JSON.stringify({ event: 'status', coreid: 'device123', published_at: '2026-09-21T00:00:00.000Z' }),
    headers: secretOf ? { 'x-particle-webhook-secret': SECRET_BY_CONSUMER[secretOf] } : {},
    apiKeyId,
    requestContext: { http: { sourceIp: '203.0.113.5', userAgent: 'test-agent' } },
  };
  return (await handleIngestion(event)).statusCode;
}

const originalEnv = process.env;
let errorLog: jest.SpyInstance;
const timingSafeEqualMock = crypto.timingSafeEqual as jest.MockedFunction<typeof crypto.timingSafeEqual>;

beforeEach(() => {
  jest.clearAllMocks();
  resetConsumerAuthCacheForTests();
  jest.spyOn(SecretsManagerClient.prototype, 'send').mockImplementation(async command => {
    if (!(command instanceof GetSecretValueCommand)) throw new Error('unexpected command');
    const id = /test\/consumers\/([^/]+)\//.exec(command.input.SecretId!)![1];
    return { SecretString: SECRET_BY_CONSUMER[id] } as never;
  });
  errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  process.env = originalEnv;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('overlap: two key IDs resolve to one consumer', () => {
  beforeEach(() => {
    setRegistry([consumer('alpha', OVERLAP), consumer('beta', STEADY)]);
    process.env = { ...originalEnv, ...ROTATION_ENV };
  });

  test('alpha-a and alpha-b each succeed with alpha\'s secret; beta-a with beta\'s', async () => {
    expect(await post('alpha-a', 'alpha')).toBe(200);
    expect(await post('alpha-b', 'alpha')).toBe(200);
    expect(await post('beta-a', 'beta')).toBe(200);
  });

  test('every cross-consumer key/secret pairing fails 401', async () => {
    expect(await post('alpha-a', 'beta')).toBe(401);
    expect(await post('alpha-b', 'beta')).toBe(401);
    expect(await post('beta-a', 'alpha')).toBe(401);
  });

  test('no clock in the Lambda: both alpha keys still resolve 1 ms before, at, and 1 ms after createdDate + 168 h', async () => {
    const alertTarget = new Date('2026-09-21T15:34:04+08:00').getTime() + 168 * 60 * 60 * 1000;
    for (const at of [alertTarget - 1, alertTarget, alertTarget + 1]) {
      jest.useFakeTimers({ now: at, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] });
      resetConsumerAuthCacheForTests();
      expect(Date.now()).toBe(at);
      expect(await post('alpha-a', 'alpha')).toBe(200);
      expect(await post('alpha-b', 'alpha')).toBe(200);
      jest.useRealTimers();
    }
  });

  test('old-disabled keeps both IDs mapped in the Lambda (API Gateway, not the Lambda, rejects alpha-a)', async () => {
    setRegistry([consumer('alpha', { primarySlot: 'a', rotation: { secondarySlot: 'b', phase: 'old-disabled' } }), consumer('beta', STEADY)]);
    expect(await post('alpha-a', 'alpha')).toBe(200);
    expect(await post('alpha-b', 'alpha')).toBe(200);
  });
});

describe('malformed alpha rotation: 503 for alpha\'s known key only, never for beta', () => {
  const MALFORMED: [string, unknown, Record<string, string>, string][] = [
    ['missing secondary ID', OVERLAP, { INGESTION_API_KEY_ID_ALPHA: 'alpha-a', INGESTION_API_KEY_ID_BETA: 'beta-a' }, 'missing_secondary_key_id'],
    ['invalid slot', { primarySlot: 'c', rotation: { secondarySlot: 'b', phase: 'overlap' } }, ROTATION_ENV, 'invalid_primary_slot'],
    ['invalid secondary slot', { primarySlot: 'a', rotation: { secondarySlot: 'z', phase: 'overlap' } }, ROTATION_ENV, 'invalid_secondary_slot'],
    ['malformed rotation metadata (unknown phase)', { primarySlot: 'a', rotation: { secondarySlot: 'b', phase: 'later' } }, ROTATION_ENV, 'invalid_rotation_phase'],
    ['malformed rotation metadata (deadline field)', { primarySlot: 'a', rotation: { secondarySlot: 'b', phase: 'overlap', expiresAt: '2026-10-01T00:00:00Z' } }, ROTATION_ENV, 'unsupported_rotation_field'],
    ['secondary ID supplied with no declared rotation', STEADY, ROTATION_ENV, 'undeclared_secondary_key_id'],
    ['secondary ID equal to primary', OVERLAP, { INGESTION_API_KEY_ID_ALPHA: 'alpha-a', INGESTION_API_KEY_ROTATION_ID_ALPHA: 'alpha-a', INGESTION_API_KEY_ID_BETA: 'beta-a' }, 'secondary_key_id_equals_primary'],
  ];

  test.each(MALFORMED)('%s', async (_label, alphaApiKey, env, reason) => {
    setRegistry([consumer('alpha', alphaApiKey), consumer('beta', STEADY)]);
    process.env = { ...originalEnv, ...env };

    expect(await post('alpha-a', 'alpha')).toBe(503);
    expect(await post('beta-a', 'beta')).toBe(200);
    expect(await post('beta-a', 'alpha')).toBe(401);
    expect(await post('unknown-key-id', 'alpha')).toBe(401);
    expect(await post('unknown-key-id', 'beta')).toBe(401);

    const configLogs = errorLog.mock.calls
      .map(([line]) => JSON.parse(line as string))
      .filter(entry => entry.event === 'consumer_auth_api_key_config_error');
    expect(configLogs).toEqual([{ event: 'consumer_auth_api_key_config_error', consumerIds: ['alpha'], reason, apiKeyId: 'alpha-a' }]);
    const allLogged = JSON.stringify(errorLog.mock.calls);
    for (const secret of Object.values(SECRET_BY_CONSUMER)) expect(allLogged).not.toContain(secret);
  });

  test('an unprovided secondary ID stays unknown (401), not attributed to alpha', async () => {
    setRegistry([consumer('alpha', OVERLAP), consumer('beta', STEADY)]);
    process.env = { ...originalEnv, INGESTION_API_KEY_ID_ALPHA: 'alpha-a', INGESTION_API_KEY_ID_BETA: 'beta-a' };
    expect(await post('alpha-b', 'alpha')).toBe(401);
  });
});

describe('one key ID claimed by two consumers', () => {
  test('is a configuration error for that ID, not resolved by registry order; an unrelated consumer still succeeds', async () => {
    for (const order of [['alpha', 'beta'], ['beta', 'alpha']]) {
      resetConsumerAuthCacheForTests();
      setRegistry([...order.map(id => consumer(id, STEADY)), consumer('gamma', STEADY)]);
      process.env = { ...originalEnv, INGESTION_API_KEY_ID_ALPHA: 'shared-id', INGESTION_API_KEY_ID_BETA: 'shared-id', INGESTION_API_KEY_ID_GAMMA: 'gamma-a' };
      errorLog.mockClear();
      expect(await post('shared-id', 'alpha')).toBe(503);
      expect(await post('shared-id', 'beta')).toBe(503);
      expect(await post('gamma-a', 'gamma')).toBe(200);
      // The log names every consumer claiming the ID (approved: consumerIds, plural), in
      // either registry order -- not just whichever claimed it first.
      const configLogs = errorLog.mock.calls
        .map(([line]) => JSON.parse(line as string))
        .filter(entry => entry.event === 'consumer_auth_api_key_config_error');
      expect(configLogs).toHaveLength(2);
      for (const entry of configLogs) {
        expect(entry).toEqual({ event: 'consumer_auth_api_key_config_error', consumerIds: expect.any(Array), reason: 'duplicate_api_key_id', apiKeyId: 'shared-id' });
        expect([...entry.consumerIds].sort()).toEqual(['alpha', 'beta']);
      }
    }
  });
});

describe('every candidate secret is compared, with no early exit', () => {
  beforeEach(() => {
    process.env = { ...originalEnv, ...ROTATION_ENV };
  });

  const CASES: [string, unknown, string, string | undefined][] = [
    ['malformed alpha key', { primarySlot: 'a', rotation: { secondarySlot: 'b', phase: 'later' } }, 'alpha-a', 'alpha'],
    ['unknown key ID', OVERLAP, 'unknown-key-id', 'alpha'],
    ['valid beta key', OVERLAP, 'beta-a', 'beta'],
    ['mismatched secret', OVERLAP, 'alpha-a', 'beta'],
    ['secret matching no consumer', OVERLAP, 'alpha-a', 'gamma'],
  ];

  test.each(CASES)('%s: both alpha and beta candidates compared', async (_label, alphaApiKey, apiKeyId, secretOf) => {
    setRegistry([consumer('alpha', alphaApiKey), consumer('beta', STEADY)]);
    await post(apiKeyId, secretOf);
    expect(timingSafeEqualMock).toHaveBeenCalledTimes(2);
  });

  test('missing secret keeps its fast path: no comparisons at all', async () => {
    setRegistry([consumer('alpha', OVERLAP), consumer('beta', STEADY)]);
    expect(await post('alpha-a', undefined)).toBe(401);
    expect(timingSafeEqualMock).not.toHaveBeenCalled();
  });

  test('duplicate secret values across consumers still yield the existing configuration error', async () => {
    setRegistry([consumer('alpha', OVERLAP), consumer('beta', STEADY)]);
    const betaSecret = SECRET_BY_CONSUMER.beta;
    SECRET_BY_CONSUMER.beta = SECRET_BY_CONSUMER.alpha;
    try {
      expect(await post('alpha-a', 'alpha')).toBe(503);
      expect(timingSafeEqualMock).toHaveBeenCalledTimes(2);
      expect(errorLog.mock.calls.map(([line]) => JSON.parse(line as string).event)).toContain('consumer_auth_duplicate_secret');
    } finally {
      SECRET_BY_CONSUMER.beta = betaSecret;
    }
  });
});
