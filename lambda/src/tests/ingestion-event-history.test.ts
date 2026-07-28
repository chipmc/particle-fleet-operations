/**
 * handleIngestion — EventHistory (Phase 4) integration tests
 *
 * Validates:
 *  - EventHistory write is triggered for a report with anomalous signals
 *  - EventHistory write failure is non-blocking (ingestion still returns 200)
 *  - Regression: existing S3, log-events, and CurrentState behaviour is unchanged
 *    when EVENT_HISTORY_TABLE_NAME is set
 */

import { handleIngestion } from '../ingestion';
import { storeRawEvent } from '../storage/s3';
import { indexEvent } from '../storage/dynamo';
import { getDeviceCurrentState, updateDeviceCurrentState } from '../storage/current-state';
import { writeIngestionEventHistory } from '../storage/event-history';
import { resolveParticleDeviceName } from '../integrations/particle-api';
import { refreshDeviceStatusLedger } from '../ledger-refresh';
import { InboundEvent } from '../types';

jest.mock('../storage/s3');
jest.mock('../storage/dynamo');
jest.mock('../storage/current-state');
jest.mock('../storage/event-history');
jest.mock('../integrations/particle-api');
jest.mock('../ledger-refresh');

const mockStoreRawEvent = storeRawEvent as jest.MockedFunction<typeof storeRawEvent>;
const mockIndexEvent = indexEvent as jest.MockedFunction<typeof indexEvent>;
const mockGetCurrentState = getDeviceCurrentState as jest.MockedFunction<typeof getDeviceCurrentState>;
const mockUpdateCurrentState = updateDeviceCurrentState as jest.MockedFunction<typeof updateDeviceCurrentState>;
const mockWriteIngestionEventHistory = writeIngestionEventHistory as jest.MockedFunction<typeof writeIngestionEventHistory>;
const mockResolveDeviceName = resolveParticleDeviceName as jest.MockedFunction<typeof resolveParticleDeviceName>;
const mockRefreshLedger = refreshDeviceStatusLedger as jest.MockedFunction<typeof refreshDeviceStatusLedger>;

const DEVICE_ID = 'device123';
const EVENT_TIME = '2026-07-28T10:00:00.000Z';
const SECRET = 'test-secret-123';

/** Minimal valid Particle webhook body */
const minimalBody = JSON.stringify({
  event: 'Ubidots-Sensor-Hook-v1',
  coreid: DEVICE_ID,
  product_id: 12345,
  published_at: EVENT_TIME,
});

/** Inbound event with auth header */
function makeEvent(body: string = minimalBody): InboundEvent {
  return {
    body,
    headers: { 'x-particle-webhook-secret': SECRET },
  };
}

describe('handleIngestion — EventHistory Phase 4', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      PARTICLE_WEBHOOK_SECRET: SECRET,
      RAW_LOGS_BUCKET_NAME: 'raw-bucket',
      LOG_EVENTS_TABLE_NAME: 'log-events-table',
      DEVICE_CURRENT_STATE_TABLE_NAME: 'current-state-table',
      EVENT_HISTORY_TABLE_NAME: 'event-history-table',
    };
    mockStoreRawEvent.mockResolvedValue();
    mockIndexEvent.mockResolvedValue();
    mockGetCurrentState.mockResolvedValue(null);
    mockUpdateCurrentState.mockResolvedValue();
    mockResolveDeviceName.mockResolvedValue(null);
    mockRefreshLedger.mockResolvedValue('disabled');
    mockWriteIngestionEventHistory.mockResolvedValue();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('calls writeIngestionEventHistory with the correct table name and device id', async () => {
    const response = await handleIngestion(makeEvent());

    expect(response.statusCode).toBe(200);
    expect(mockWriteIngestionEventHistory).toHaveBeenCalledTimes(1);
    expect(mockWriteIngestionEventHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        tableName: 'event-history-table',
        deviceId: DEVICE_ID,
        publishedAt: EVENT_TIME,
      })
    );
  });

  it('returns HTTP 200 even when writeIngestionEventHistory throws', async () => {
    mockWriteIngestionEventHistory.mockRejectedValueOnce(new Error('DynamoDB timeout'));

    const response = await handleIngestion(makeEvent());

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true, stored: true });
  });

  it('still calls storeRawEvent and indexEvent when EventHistory write fails', async () => {
    mockWriteIngestionEventHistory.mockRejectedValueOnce(new Error('EventHistory unavailable'));

    await handleIngestion(makeEvent());

    expect(mockStoreRawEvent).toHaveBeenCalledTimes(1);
    expect(mockIndexEvent).toHaveBeenCalledTimes(1);
  });

  it('still calls updateDeviceCurrentState when EventHistory write fails', async () => {
    mockWriteIngestionEventHistory.mockRejectedValueOnce(new Error('EventHistory unavailable'));

    await handleIngestion(makeEvent());

    expect(mockUpdateCurrentState).toHaveBeenCalledTimes(1);
  });

  it('skips EventHistory write when EVENT_HISTORY_TABLE_NAME is not set', async () => {
    delete process.env.EVENT_HISTORY_TABLE_NAME;

    const response = await handleIngestion(makeEvent());

    expect(response.statusCode).toBe(200);
    expect(mockWriteIngestionEventHistory).not.toHaveBeenCalled();
  });

  it('regression — S3, log-events, and CurrentState writes are unchanged', async () => {
    const response = await handleIngestion(makeEvent());

    expect(response.statusCode).toBe(200);
    expect(mockStoreRawEvent).toHaveBeenCalledTimes(1);
    expect(mockIndexEvent).toHaveBeenCalledTimes(1);
    expect(mockGetCurrentState).toHaveBeenCalledTimes(1);
    expect(mockUpdateCurrentState).toHaveBeenCalledTimes(1);
    expect(mockRefreshLedger).toHaveBeenCalledTimes(1);
  });
});
