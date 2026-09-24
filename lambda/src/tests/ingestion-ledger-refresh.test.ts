import { handleIngestion } from '../ingestion';
import { refreshDeviceStatusLedger } from '../ledger-refresh';
import { resolveParticleDeviceName } from '../integrations/particle-api';
import { storeRawEvent } from '../storage/s3';
import { indexEvent } from '../storage/dynamo';
import { getDeviceCurrentState, updateDeviceCurrentState } from '../storage/current-state';
import { validateConsumerRequest } from '../consumer-auth';
import { InboundEvent } from '../types';

jest.mock('../storage/s3');
jest.mock('../storage/dynamo');
jest.mock('../storage/current-state');
jest.mock('../integrations/particle-api');
jest.mock('../ledger-refresh');
// Auth is incidental to what this file tests (ledger refresh) -- mocked to a fixed
// success so this test doesn't depend on consumer-auth.ts's real logic or real Secrets
// Manager calls. See consumer-auth.test.ts / ingestion-consumer-auth.test.ts for that.
jest.mock('../consumer-auth');

const mockStoreRawEvent = storeRawEvent as jest.MockedFunction<typeof storeRawEvent>;
const mockIndexEvent = indexEvent as jest.MockedFunction<typeof indexEvent>;
const mockGetCurrentState = getDeviceCurrentState as jest.MockedFunction<typeof getDeviceCurrentState>;
const mockUpdateCurrentState = updateDeviceCurrentState as jest.MockedFunction<typeof updateDeviceCurrentState>;
const mockResolveDeviceName = resolveParticleDeviceName as jest.MockedFunction<typeof resolveParticleDeviceName>;
const mockRefreshLedger = refreshDeviceStatusLedger as jest.MockedFunction<typeof refreshDeviceStatusLedger>;
const mockValidateConsumerRequest = validateConsumerRequest as jest.MockedFunction<typeof validateConsumerRequest>;

describe('ingestion device-status Ledger refresh', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      QUERY_API_SHARED_SECRET: 'test-secret-123',
      RAW_LOGS_BUCKET_NAME: 'raw-table',
      LOG_EVENTS_TABLE_NAME: 'history-table',
      DEVICE_CURRENT_STATE_TABLE_NAME: 'current-state-table',
      PARTICLE_LEDGER_REFRESH_ENABLED: 'true',
      PARTICLE_LEDGER_REFRESH_DEVICE_IDS: 'device123',
    };
    mockStoreRawEvent.mockResolvedValue();
    mockIndexEvent.mockResolvedValue();
    mockGetCurrentState.mockResolvedValue(null);
    mockUpdateCurrentState.mockResolvedValue();
    mockResolveDeviceName.mockResolvedValue(null);
    mockValidateConsumerRequest.mockResolvedValue({ outcome: 'success', consumerId: 'test-consumer' });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return HTTP 200 when Ledger refresh fails', async () => {
    mockRefreshLedger.mockResolvedValue('not_found_or_failed');
    const event: InboundEvent = {
      body: JSON.stringify({
        event: 'occupancy',
        coreid: 'device123',
        product_id: 12345,
        published_at: '2026-07-13T10:00:00.000Z',
      }),
      headers: { 'x-particle-webhook-secret': 'test-secret-123' },
      apiKeyId: 'test-api-key-id',
    };

    const response = await handleIngestion(event);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true, stored: true });
    expect(mockStoreRawEvent).toHaveBeenCalled();
    expect(mockIndexEvent).toHaveBeenCalled();
    expect(mockUpdateCurrentState).toHaveBeenCalled();
    expect(mockRefreshLedger).toHaveBeenCalledWith(expect.objectContaining({
      tableName: 'current-state-table',
      projectId: 'generalized-core-counter',
      deviceId: 'device123',
      previous: null,
    }));
  });
});