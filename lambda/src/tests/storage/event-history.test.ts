/**
 * EventHistory storage tests
 *
 * Covers:
 *   - writeEventHistory: basic PutCommand write
 *   - writeIngestionEventHistory: one test per event type (5 total)
 *   - Non-blocking behaviour: EventHistory write failure does not prevent
 *     ingestion from succeeding
 *   - Regression: no writes when no conditions are met
 */

import { PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  ddb,
  writeEventHistory,
  writeIngestionEventHistory,
  EventHistoryItem,
  IngestionEventHistoryContext,
} from '../../storage/event-history';
import { DeviceCurrentState, NormalizedEventFields } from '../../types';

const mockDdbSend = jest.fn();
jest.spyOn(ddb, 'send').mockImplementation(mockDdbSend);

const TABLE = 'event-history-table';
const DEVICE_ID = 'device123';
const REPORT_TIME = '2026-07-28T10:00:00.000Z';

/** Minimal valid CurrentState with offlineCandidate = false */
function baseState(overrides: Partial<DeviceCurrentState> = {}): DeviceCurrentState {
  return {
    projectId: 'generalized-core-counter',
    deviceId: DEVICE_ID,
    lastEventTime: REPORT_TIME,
    lastIngestTime: REPORT_TIME,
    lastEventType: 'telemetry.health',
    healthStatus: 'healthy',
    anomalyCount: 0,
    offlineCandidate: false,
    updatedAt: REPORT_TIME,
    ...overrides,
  };
}

/** Minimal NormalizedEventFields */
function baseNormalized(overrides: Partial<NormalizedEventFields> = {}): NormalizedEventFields {
  return {
    schemaVersion: '1.0',
    eventId: 'evt-1',
    projectId: 'generalized-core-counter',
    plane: 'telemetry',
    eventType: 'telemetry.health',
    eventVersion: '1.0',
    isSyntheticTime: false,
    rawRef: { s3Key: 'test/key' },
    ...overrides,
  };
}

/** Minimal context (no conditions met — produces no writes) */
function baseContext(overrides: Partial<IngestionEventHistoryContext> = {}): IngestionEventHistoryContext {
  return {
    tableName: TABLE,
    deviceId: DEVICE_ID,
    publishedAt: REPORT_TIME,
    normalized: baseNormalized(),
    previousState: baseState(),
    ...overrides,
  };
}

describe('writeEventHistory', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sends a PutCommand with the provided item', async () => {
    mockDdbSend.mockResolvedValueOnce({});
    const item: EventHistoryItem = {
      deviceId: DEVICE_ID,
      eventTime: `${REPORT_TIME}#ANOMALY#evt-1`,
      eventType: 'ANOMALY',
      reportTime: REPORT_TIME,
      anomalyCount: 1,
      anomalies: [{ severity: 'high', type: 'critical_battery', message: 'Battery below 20%' }],
    };

    await writeEventHistory(TABLE, item);

    expect(mockDdbSend).toHaveBeenCalledTimes(1);
    expect(mockDdbSend).toHaveBeenCalledWith(expect.any(PutCommand));
  });
});

describe('writeIngestionEventHistory — event type: ANOMALY', () => {
  beforeEach(() => jest.clearAllMocks());

  it('writes ANOMALY when battery is below 20%', async () => {
    mockDdbSend.mockResolvedValue({});
    const ctx = baseContext({
      normalized: baseNormalized({ battery: 15 }),
    });

    await writeIngestionEventHistory(ctx);

    const putCalls = mockDdbSend.mock.calls.map((c) => c[0]);
    const anomalyCall = putCalls.find(
      (cmd) => cmd.input?.Item?.eventType === 'ANOMALY'
    );
    expect(anomalyCall).toBeDefined();
    expect(anomalyCall.input.Item.deviceId).toBe(DEVICE_ID);
    expect(anomalyCall.input.Item.reportTime).toBe(REPORT_TIME);
    expect(anomalyCall.input.Item.eventTime).toBe(`${REPORT_TIME}#ANOMALY#evt-1`);
    expect(anomalyCall.input.Item.anomalyCount).toBeGreaterThan(0);
    expect(anomalyCall.input.Item.anomalies).toContainEqual(
      expect.objectContaining({ type: 'critical_battery' })
    );
  });

  it('writes ANOMALY when connectTime exceeds the high threshold', async () => {
    mockDdbSend.mockResolvedValue({});
    const ctx = baseContext({
      normalized: baseNormalized({ connectTime: 350 }),
    });

    await writeIngestionEventHistory(ctx);

    const putCalls = mockDdbSend.mock.calls.map((c) => c[0]);
    const anomalyCall = putCalls.find(
      (cmd) => cmd.input?.Item?.eventType === 'ANOMALY'
    );
    expect(anomalyCall).toBeDefined();
    expect(anomalyCall.input.Item.anomalies).toContainEqual(
      expect.objectContaining({ type: 'very_high_connect_time' })
    );
  });

  it('does not write ANOMALY when no anomalies are present', async () => {
    mockDdbSend.mockResolvedValue({});
    const ctx = baseContext({
      normalized: baseNormalized({ battery: 75, connectTime: 30 }),
    });

    await writeIngestionEventHistory(ctx);

    const putCalls = mockDdbSend.mock.calls.map((c) => c[0]);
    const anomalyCall = putCalls.find(
      (cmd) => cmd.input?.Item?.eventType === 'ANOMALY'
    );
    expect(anomalyCall).toBeUndefined();
  });
});

describe('writeIngestionEventHistory — event type: FIRMWARE_UPDATE', () => {
  beforeEach(() => jest.clearAllMocks());

  it('writes FIRMWARE_UPDATE when firmware version changes', async () => {
    mockDdbSend.mockResolvedValue({});
    const ctx = baseContext({
      normalized: baseNormalized({ fwVersion: '15' }),
      previousState: baseState({ fwVersion: '14' }),
    });

    await writeIngestionEventHistory(ctx);

    const putCalls = mockDdbSend.mock.calls.map((c) => c[0]);
    const fwCall = putCalls.find(
      (cmd) => cmd.input?.Item?.eventType === 'FIRMWARE_UPDATE'
    );
    expect(fwCall).toBeDefined();
    expect(fwCall.input.Item.deviceId).toBe(DEVICE_ID);
    expect(fwCall.input.Item.reportTime).toBe(REPORT_TIME);
    expect(fwCall.input.Item.eventTime).toBe(`${REPORT_TIME}#FIRMWARE_UPDATE#evt-1`);
    expect(fwCall.input.Item.fromFwVersion).toBe('14');
    expect(fwCall.input.Item.toFwVersion).toBe('15');
  });

  it('does not write FIRMWARE_UPDATE when firmware version is unchanged', async () => {
    mockDdbSend.mockResolvedValue({});
    const ctx = baseContext({
      normalized: baseNormalized({ fwVersion: '14' }),
      previousState: baseState({ fwVersion: '14' }),
    });

    await writeIngestionEventHistory(ctx);

    const putCalls = mockDdbSend.mock.calls.map((c) => c[0]);
    const fwCall = putCalls.find(
      (cmd) => cmd.input?.Item?.eventType === 'FIRMWARE_UPDATE'
    );
    expect(fwCall).toBeUndefined();
  });

  it('does not write FIRMWARE_UPDATE when previous version is unknown', async () => {
    mockDdbSend.mockResolvedValue({});
    const ctx = baseContext({
      normalized: baseNormalized({ fwVersion: '15' }),
      previousState: baseState(), // no fwVersion
    });

    await writeIngestionEventHistory(ctx);

    const putCalls = mockDdbSend.mock.calls.map((c) => c[0]);
    const fwCall = putCalls.find(
      (cmd) => cmd.input?.Item?.eventType === 'FIRMWARE_UPDATE'
    );
    expect(fwCall).toBeUndefined();
  });
});

describe('writeIngestionEventHistory — event type: BATTERY_CRITICAL', () => {
  beforeEach(() => jest.clearAllMocks());

  it('writes BATTERY_CRITICAL when battery transitions into critical for the first time (no previous reading)', async () => {
    mockDdbSend.mockResolvedValue({});
    const ctx = baseContext({
      normalized: baseNormalized({ battery: 12 }),
      previousState: baseState(), // no previous battery — first time we see it below 20%
    });

    await writeIngestionEventHistory(ctx);

    const putCalls = mockDdbSend.mock.calls.map((c) => c[0]);
    const battCall = putCalls.find(
      (cmd) => cmd.input?.Item?.eventType === 'BATTERY_CRITICAL'
    );
    expect(battCall).toBeDefined();
    expect(battCall.input.Item.deviceId).toBe(DEVICE_ID);
    expect(battCall.input.Item.reportTime).toBe(REPORT_TIME);
    expect(battCall.input.Item.eventTime).toBe(`${REPORT_TIME}#BATTERY_CRITICAL#evt-1`);
    expect(battCall.input.Item.batteryLevel).toBe(12);
  });

  it('writes BATTERY_CRITICAL when battery drops from above 20% to below 20%', async () => {
    mockDdbSend.mockResolvedValue({});
    const ctx = baseContext({
      normalized: baseNormalized({ battery: 15 }),
      previousState: baseState({ battery: 25 }), // was above threshold
    });

    await writeIngestionEventHistory(ctx);

    const putCalls = mockDdbSend.mock.calls.map((c) => c[0]);
    const battCall = putCalls.find(
      (cmd) => cmd.input?.Item?.eventType === 'BATTERY_CRITICAL'
    );
    expect(battCall).toBeDefined();
    expect(battCall.input.Item.batteryLevel).toBe(15);
  });

  it('does not write BATTERY_CRITICAL when battery was already below 20% in previous state', async () => {
    mockDdbSend.mockResolvedValue({});
    const ctx = baseContext({
      normalized: baseNormalized({ battery: 12 }),
      previousState: baseState({ battery: 10 }), // already critical — not a new transition
    });

    await writeIngestionEventHistory(ctx);

    const putCalls = mockDdbSend.mock.calls.map((c) => c[0]);
    const battCall = putCalls.find(
      (cmd) => cmd.input?.Item?.eventType === 'BATTERY_CRITICAL'
    );
    expect(battCall).toBeUndefined();
  });

  it('does not write BATTERY_CRITICAL when battery is at or above 20%', async () => {
    mockDdbSend.mockResolvedValue({});
    const ctx = baseContext({
      normalized: baseNormalized({ battery: 20 }),
    });

    await writeIngestionEventHistory(ctx);

    const putCalls = mockDdbSend.mock.calls.map((c) => c[0]);
    const battCall = putCalls.find(
      (cmd) => cmd.input?.Item?.eventType === 'BATTERY_CRITICAL'
    );
    expect(battCall).toBeUndefined();
  });

  it('does not write BATTERY_CRITICAL when inherited battery was already critical (no transition)', async () => {
    mockDdbSend.mockResolvedValue({});
    const ctx = baseContext({
      normalized: baseNormalized(), // no battery in current report — inherits from previous
      previousState: baseState({ battery: 10 }), // previous was already critical
    });

    await writeIngestionEventHistory(ctx);

    const putCalls = mockDdbSend.mock.calls.map((c) => c[0]);
    const battCall = putCalls.find(
      (cmd) => cmd.input?.Item?.eventType === 'BATTERY_CRITICAL'
    );
    expect(battCall).toBeUndefined();
  });
});

describe('writeIngestionEventHistory — event type: DEVICE_RECOVERED', () => {
  beforeEach(() => jest.clearAllMocks());

  it('writes DEVICE_RECOVERED when previous state was an offline candidate and current report is newer', async () => {
    mockDdbSend.mockResolvedValue({});
    const ctx = baseContext({
      publishedAt: '2026-07-28T11:00:00.000Z',
      previousState: baseState({
        offlineCandidate: true,
        lastEventTime: '2026-07-28T09:00:00.000Z', // older than publishedAt
      }),
    });

    await writeIngestionEventHistory(ctx);

    const putCalls = mockDdbSend.mock.calls.map((c) => c[0]);
    const recCall = putCalls.find(
      (cmd) => cmd.input?.Item?.eventType === 'DEVICE_RECOVERED'
    );
    expect(recCall).toBeDefined();
    expect(recCall.input.Item.deviceId).toBe(DEVICE_ID);
    expect(recCall.input.Item.reportTime).toBe('2026-07-28T11:00:00.000Z');
    expect(recCall.input.Item.eventTime).toBe(`2026-07-28T11:00:00.000Z#DEVICE_RECOVERED#evt-1`);
  });

  it('does not write DEVICE_RECOVERED when previous state was not an offline candidate', async () => {
    mockDdbSend.mockResolvedValue({});
    const ctx = baseContext({
      previousState: baseState({ offlineCandidate: false }),
    });

    await writeIngestionEventHistory(ctx);

    const putCalls = mockDdbSend.mock.calls.map((c) => c[0]);
    const recCall = putCalls.find(
      (cmd) => cmd.input?.Item?.eventType === 'DEVICE_RECOVERED'
    );
    expect(recCall).toBeUndefined();
  });

  it('does not write DEVICE_RECOVERED when there is no previous state', async () => {
    mockDdbSend.mockResolvedValue({});
    const ctx = baseContext({ previousState: null });

    await writeIngestionEventHistory(ctx);

    const putCalls = mockDdbSend.mock.calls.map((c) => c[0]);
    const recCall = putCalls.find(
      (cmd) => cmd.input?.Item?.eventType === 'DEVICE_RECOVERED'
    );
    expect(recCall).toBeUndefined();
  });

  it('does not write DEVICE_RECOVERED when publishedAt is not newer than previous lastEventTime', async () => {
    mockDdbSend.mockResolvedValue({});
    const ctx = baseContext({
      publishedAt: REPORT_TIME,
      previousState: baseState({
        offlineCandidate: true,
        lastEventTime: REPORT_TIME, // same timestamp — not a new event
      }),
    });

    await writeIngestionEventHistory(ctx);

    const putCalls = mockDdbSend.mock.calls.map((c) => c[0]);
    const recCall = putCalls.find(
      (cmd) => cmd.input?.Item?.eventType === 'DEVICE_RECOVERED'
    );
    expect(recCall).toBeUndefined();
  });
});

describe('writeIngestionEventHistory — event type: LEDGER_SYNC_FAILED', () => {
  beforeEach(() => jest.clearAllMocks());

  it('writes LEDGER_SYNC_FAILED with errorKind and httpStatus when provided', async () => {
    mockDdbSend.mockResolvedValue({});
    const ctx = baseContext({
      ledgerSyncFailure: { errorKind: 'http_error', httpStatus: 404 },
    });

    await writeIngestionEventHistory(ctx);

    const putCalls = mockDdbSend.mock.calls.map((c) => c[0]);
    const failCall = putCalls.find(
      (cmd) => cmd.input?.Item?.eventType === 'LEDGER_SYNC_FAILED'
    );
    expect(failCall).toBeDefined();
    expect(failCall.input.Item.deviceId).toBe(DEVICE_ID);
    expect(failCall.input.Item.reportTime).toBe(REPORT_TIME);
    expect(failCall.input.Item.eventTime).toBe(`${REPORT_TIME}#LEDGER_SYNC_FAILED#evt-1`);
    expect(failCall.input.Item.errorKind).toBe('http_error');
    expect(failCall.input.Item.httpStatus).toBe(404);
  });

  it('writes LEDGER_SYNC_FAILED with errorKind only when httpStatus is absent', async () => {
    mockDdbSend.mockResolvedValue({});
    const ctx = baseContext({
      ledgerSyncFailure: { errorKind: 'exception' },
    });

    await writeIngestionEventHistory(ctx);

    const putCalls = mockDdbSend.mock.calls.map((c) => c[0]);
    const failCall = putCalls.find(
      (cmd) => cmd.input?.Item?.eventType === 'LEDGER_SYNC_FAILED'
    );
    expect(failCall).toBeDefined();
    expect(failCall.input.Item.errorKind).toBe('exception');
    expect(failCall.input.Item.httpStatus).toBeUndefined();
  });

  it('does not write LEDGER_SYNC_FAILED when no failure occurred', async () => {
    mockDdbSend.mockResolvedValue({});
    const ctx = baseContext(); // no ledgerSyncFailure

    await writeIngestionEventHistory(ctx);

    const putCalls = mockDdbSend.mock.calls.map((c) => c[0]);
    const failCall = putCalls.find(
      (cmd) => cmd.input?.Item?.eventType === 'LEDGER_SYNC_FAILED'
    );
    expect(failCall).toBeUndefined();
  });
});

describe('writeIngestionEventHistory — non-blocking behaviour', () => {
  it('rejects (propagates the error to the caller for try/catch isolation)', async () => {
    mockDdbSend.mockRejectedValueOnce(new Error('DynamoDB unavailable'));
    const ctx = baseContext({
      normalized: baseNormalized({ battery: 5 }), // triggers BATTERY_CRITICAL + ANOMALY
    });

    await expect(writeIngestionEventHistory(ctx)).rejects.toThrow('DynamoDB unavailable');
  });
});

describe('writeIngestionEventHistory — no writes when no conditions are met', () => {
  beforeEach(() => jest.clearAllMocks());

  it('performs zero DynamoDB writes when the event carries no anomalous signals', async () => {
    const ctx = baseContext({
      normalized: baseNormalized({ battery: 80, connectTime: 30, fwVersion: '14' }),
      previousState: baseState({ offlineCandidate: false, fwVersion: '14' }),
    });

    await writeIngestionEventHistory(ctx);

    expect(mockDdbSend).not.toHaveBeenCalled();
  });
});
