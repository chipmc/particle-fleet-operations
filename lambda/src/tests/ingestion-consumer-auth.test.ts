import { handleIngestion } from '../ingestion';
import { validateConsumerRequest, buildApiKeyConsumerLookup } from '../consumer-auth';
import { storeRawEvent } from '../storage/s3';
import { indexEvent } from '../storage/dynamo';
import { getDeviceCurrentState, updateDeviceCurrentState } from '../storage/current-state';
import { resolveParticleDeviceName } from '../integrations/particle-api';
import { InboundEvent } from '../types';

// This file covers only how handleIngestion calls consumer-auth.ts and maps its outcomes
// to HTTP responses -- consumer-auth.ts's own validation logic (constant-time comparison,
// caching, the duplicate-secret and pair-mismatch cases) is unit-tested directly in
// consumer-auth.test.ts, not re-verified here. The legacy shared-secret HTTP API route
// this used to also dispatch to is retired; see docs/security/webhook-secret-rotation-runbook.md.
jest.mock('../consumer-auth');
jest.mock('../storage/s3');
jest.mock('../storage/dynamo');
jest.mock('../storage/current-state');
jest.mock('../integrations/particle-api');

const mockValidateConsumerRequest = validateConsumerRequest as jest.MockedFunction<typeof validateConsumerRequest>;
const mockBuildApiKeyConsumerLookup = buildApiKeyConsumerLookup as jest.MockedFunction<typeof buildApiKeyConsumerLookup>;
const mockStoreRawEvent = storeRawEvent as jest.MockedFunction<typeof storeRawEvent>;
const mockIndexEvent = indexEvent as jest.MockedFunction<typeof indexEvent>;
const mockGetCurrentState = getDeviceCurrentState as jest.MockedFunction<typeof getDeviceCurrentState>;
const mockUpdateCurrentState = updateDeviceCurrentState as jest.MockedFunction<typeof updateDeviceCurrentState>;
const mockResolveDeviceName = resolveParticleDeviceName as jest.MockedFunction<typeof resolveParticleDeviceName>;

function restApiEvent(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    body: JSON.stringify({ event: 'status', coreid: 'device123', published_at: '2026-09-21T00:00:00.000Z' }),
    headers: { 'x-particle-webhook-secret': 'consumer-secret-value' },
    apiKeyId: 'api-key-abc',
    requestContext: { http: { sourceIp: '203.0.113.5', userAgent: 'test-agent' } },
    ...overrides,
  };
}

describe('handleIngestion auth dispatch to consumer-auth.ts', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    mockBuildApiKeyConsumerLookup.mockReturnValue(() => undefined);
    mockStoreRawEvent.mockResolvedValue();
    mockIndexEvent.mockResolvedValue();
    mockGetCurrentState.mockResolvedValue(null);
    mockUpdateCurrentState.mockResolvedValue();
    mockResolveDeviceName.mockResolvedValue(null);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('handleIngestion calls validateConsumerRequest with the provided secret, apiKeyId, and a lookup function', async () => {
    mockValidateConsumerRequest.mockResolvedValue({ outcome: 'success', consumerId: 'particle-cloud-webhook' });

    const response = await handleIngestion(restApiEvent());

    expect(mockValidateConsumerRequest).toHaveBeenCalledWith(
      'consumer-secret-value', 'api-key-abc', expect.any(Function)
    );
    expect(response.statusCode).toBe(200);
  });

  test('consumer-auth failure (invalid_secret) returns 401, and the event is never stored', async () => {
    mockValidateConsumerRequest.mockResolvedValue({ outcome: 'failure', reason: 'invalid_secret' });

    const response = await handleIngestion(restApiEvent());

    expect(response.statusCode).toBe(401);
    expect(mockStoreRawEvent).not.toHaveBeenCalled();
  });

  test('consumer-auth failure (credential_pair_mismatch) also returns 401', async () => {
    mockValidateConsumerRequest.mockResolvedValue({ outcome: 'failure', reason: 'credential_pair_mismatch', apiKeyConsumerId: 'serial-forwarder' });

    const response = await handleIngestion(restApiEvent());

    expect(response.statusCode).toBe(401);
  });

  test('consumer-auth failure (credential_config_unavailable) returns 503, distinct from a secret failure', async () => {
    mockValidateConsumerRequest.mockResolvedValue({ outcome: 'failure', reason: 'credential_config_unavailable' });

    const response = await handleIngestion(restApiEvent());

    expect(response.statusCode).toBe(503);
  });
});
