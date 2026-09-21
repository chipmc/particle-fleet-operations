import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  IngestionConsumer,
  buildApiKeyConsumerLookup,
  resetConsumerAuthCacheForTests,
  validateConsumerRequest,
} from '../consumer-auth';

const mockSend = jest.spyOn(SecretsManagerClient.prototype, 'send');

const CONSUMER_A: IngestionConsumer = {
  id: 'particle-cloud-webhook',
  displayName: 'Particle Cloud webhook',
  secretName: 'test/consumers/particle-cloud-webhook/webhook-secret',
  usagePlan: { ratePerSecond: 100, burst: 500 },
  status: 'active',
};
const CONSUMER_B: IngestionConsumer = {
  id: 'serial-forwarder',
  displayName: 'Pi serial log forwarder',
  secretName: 'test/consumers/serial-forwarder/webhook-secret',
  usagePlan: { ratePerSecond: 10, burst: 50 },
  status: 'active',
};

const SECRET_BY_NAME: Record<string, string> = {
  [CONSUMER_A.secretName]: 'a'.repeat(64),
  [CONSUMER_B.secretName]: 'b'.repeat(64),
};

function lookup(apiKeyId: string, mapping: Record<string, string>): string | undefined {
  return mapping[apiKeyId];
}

describe('validateConsumerRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetConsumerAuthCacheForTests();
    mockSend.mockImplementation(async command => {
      if (command instanceof GetSecretValueCommand) {
        const secretId = command.input.SecretId!;
        const value = SECRET_BY_NAME[secretId];
        if (value === undefined) throw new Error(`no fixture secret for ${secretId}`);
        return { SecretString: value } as never;
      }
      throw new Error('unexpected command');
    });
  });

  test('succeeds when the secret matches consumer A and the API key also maps to consumer A', async () => {
    const result = await validateConsumerRequest(
      SECRET_BY_NAME[CONSUMER_A.secretName],
      'key-a',
      id => lookup(id, { 'key-a': CONSUMER_A.id, 'key-b': CONSUMER_B.id }),
      [CONSUMER_A, CONSUMER_B]
    );
    expect(result).toEqual({ outcome: 'success', consumerId: CONSUMER_A.id });
  });

  test('missing secret fails fast without ever calling Secrets Manager', async () => {
    const result = await validateConsumerRequest(undefined, 'key-a', () => CONSUMER_A.id, [CONSUMER_A]);
    expect(result).toEqual({ outcome: 'failure', reason: 'missing_secret' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('a secret that matches no active consumer fails as invalid_secret', async () => {
    const result = await validateConsumerRequest(
      'not-a-real-secret-value-at-all',
      'key-a',
      id => lookup(id, { 'key-a': CONSUMER_A.id }),
      [CONSUMER_A, CONSUMER_B]
    );
    expect(result.outcome).toBe('failure');
    expect((result as { reason: string }).reason).toBe('invalid_secret');
  });

  test('a valid secret for consumer A paired with an API key belonging to consumer B fails as credential_pair_mismatch', async () => {
    const result = await validateConsumerRequest(
      SECRET_BY_NAME[CONSUMER_A.secretName],
      'key-b',
      id => lookup(id, { 'key-a': CONSUMER_A.id, 'key-b': CONSUMER_B.id }),
      [CONSUMER_A, CONSUMER_B]
    );
    expect(result).toEqual({ outcome: 'failure', reason: 'credential_pair_mismatch', apiKeyConsumerId: CONSUMER_B.id });
  });

  test('a valid secret with no resolvable API key consumer fails as credential_pair_mismatch, not success', async () => {
    const result = await validateConsumerRequest(
      SECRET_BY_NAME[CONSUMER_A.secretName],
      'unknown-key',
      () => undefined,
      [CONSUMER_A, CONSUMER_B]
    );
    expect(result).toEqual({ outcome: 'failure', reason: 'credential_pair_mismatch', apiKeyConsumerId: undefined });
  });

  test('two consumers sharing the same secret value is refused as a configuration error, not resolved to either -- this is what actually verifies "no early exit"', async () => {
    // The comparison loop must keep checking every candidate even after finding a match,
    // or a second matching consumer later in iteration order would never be discovered --
    // exactly what an early-`return`-on-first-match implementation would miss. Verified by
    // mutation: reverting the loop to `break` on the first match makes this test fail
    // while every other test in this file still passes, confirming this is the one that
    // actually enforces the property (the "constant-time" framing in the design doc is
    // fundamentally about response-latency timing, which isn't something a unit test can
    // assert deterministically -- this is the closest functional proxy for it).
    const duplicateB: IngestionConsumer = { ...CONSUMER_B, secretName: 'test/consumers/duplicate/webhook-secret' };
    SECRET_BY_NAME[duplicateB.secretName] = SECRET_BY_NAME[CONSUMER_A.secretName]; // same value as consumer A
    const result = await validateConsumerRequest(
      SECRET_BY_NAME[CONSUMER_A.secretName],
      'key-a',
      id => lookup(id, { 'key-a': CONSUMER_A.id }),
      [CONSUMER_A, duplicateB]
    );
    expect(result).toEqual({ outcome: 'failure', reason: 'credential_config_unavailable' });
    delete SECRET_BY_NAME[duplicateB.secretName];
  });

  test('a Secrets Manager failure surfaces as credential_config_unavailable, not an unhandled rejection', async () => {
    mockSend.mockRejectedValue(new Error('AccessDeniedException') as never);
    const result = await validateConsumerRequest(SECRET_BY_NAME[CONSUMER_A.secretName], 'key-a', () => CONSUMER_A.id, [CONSUMER_A]);
    expect(result).toEqual({ outcome: 'failure', reason: 'credential_config_unavailable' });
  });

  test('secrets are cached across calls within the TTL: a second call does not re-fetch', async () => {
    await validateConsumerRequest(SECRET_BY_NAME[CONSUMER_A.secretName], 'key-a', () => CONSUMER_A.id, [CONSUMER_A]);
    expect(mockSend).toHaveBeenCalledTimes(1);
    await validateConsumerRequest(SECRET_BY_NAME[CONSUMER_A.secretName], 'key-a', () => CONSUMER_A.id, [CONSUMER_A]);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test('a match later in the candidate list (not the first entry) still resolves correctly', async () => {
    const manyConsumers = [CONSUMER_A, CONSUMER_B, { ...CONSUMER_A, id: 'third-consumer', secretName: 'test/consumers/third/webhook-secret' }];
    SECRET_BY_NAME['test/consumers/third/webhook-secret'] = 'c'.repeat(64);
    const result = await validateConsumerRequest(
      SECRET_BY_NAME[CONSUMER_B.secretName],
      'key-b',
      id => lookup(id, { 'key-b': CONSUMER_B.id }),
      manyConsumers
    );
    expect(result).toEqual({ outcome: 'success', consumerId: CONSUMER_B.id });
    delete SECRET_BY_NAME['test/consumers/third/webhook-secret'];
  });
});

describe('buildApiKeyConsumerLookup', () => {
  test('maps a configured env var to the correct consumer id, per the naming convention', () => {
    const lookupFn = buildApiKeyConsumerLookup(
      { INGESTION_API_KEY_ID_PARTICLE_CLOUD_WEBHOOK: 'abc123', INGESTION_API_KEY_ID_SERIAL_FORWARDER: 'xyz789' },
      [CONSUMER_A, CONSUMER_B]
    );
    expect(lookupFn('abc123')).toBe(CONSUMER_A.id);
    expect(lookupFn('xyz789')).toBe(CONSUMER_B.id);
    expect(lookupFn('not-configured')).toBeUndefined();
  });

  test('a consumer with no configured env var simply resolves nothing for its key, not a crash', () => {
    const lookupFn = buildApiKeyConsumerLookup({}, [CONSUMER_A]);
    expect(lookupFn('anything')).toBeUndefined();
  });
});
