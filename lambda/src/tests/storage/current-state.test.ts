/**
 * DeviceCurrentState storage tests
 */

import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  buildCurrentState,
  determineHealthStatus,
  ddb,
  projectMissingDeviceSettingsLedger,
  queryDeviceCurrentStates,
  updateDeviceSettingsLedgerSnapshot,
  updateDeviceStatusLedgerSnapshot,
  updateProductDefaultsLedgerSnapshot,
  updateDeviceCurrentState,
} from '../../storage/current-state';
import { normalizeEvent, safeParseData } from '../../utils/parse';
import { NormalizedEventFields, ParticleWebhook, ParsedEvent } from '../../types';

const mockDdbSend = jest.fn();
jest.spyOn(ddb, 'send').mockImplementation(mockDdbSend);

describe('DeviceCurrentState storage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const parsed: ParsedEvent = {
    eventName: 'Ubidots-Sensor-Hook-v1',
    deviceId: 'device123',
    publishedAt: '2026-06-26T14:30:00.000Z',
    receivedAt: '2026-06-26T14:30:05.000Z',
    data: {},
  };

  const normalized: NormalizedEventFields = {
    schemaVersion: '1.0',
    eventId: 'event-id',
    projectId: 'generalized-core-counter',
    plane: 'telemetry',
    eventType: 'telemetry.health',
    eventVersion: '1.0',
    sourceType: 'particle-webhook',
    isSyntheticTime: false,
    battery: 22,
    connectTime: 190,
    resetCount: 3,
    alertCount: 0,
    occupancy: 5,
    dailyOccupancy: 42,
    temperature: 71.5,
    fwVersion: '14',
    rawRef: { s3Key: 'test-key' },
  };

  it('should update current state from telemetry event', async () => {
    const body: ParticleWebhook = {
      event: 'Ubidots-Sensor-Hook-v1',
      coreid: 'device123',
      published_at: '2026-06-26T14:30:00.000Z',
    };

    mockDdbSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await updateDeviceCurrentState(
      'current-state-table',
      'device123',
      '2026-06-26T14:30:00.000Z',
      'Ubidots-Sensor-Hook-v1',
      body,
      parsed,
      normalized
    );

    expect(mockDdbSend).toHaveBeenNthCalledWith(1, expect.any(GetCommand));
    expect(mockDdbSend).toHaveBeenNthCalledWith(2, expect.any(UpdateCommand));

    const updateCommand = mockDdbSend.mock.calls[1][0] as UpdateCommand;
    expect(updateCommand.input).toMatchObject({
      TableName: 'current-state-table',
      Key: {
        projectId: 'generalized-core-counter',
        deviceId: 'device123',
      },
    });
    expect(updateCommand.input.ExpressionAttributeValues).toMatchObject({
      ':lastEventType': 'telemetry.health',
      ':lastPlane': 'telemetry',
      ':battery': 22,
      ':connectTime': 190,
      ':healthStatus': 'warning',
      ':anomalyCount': 2,
    });
    expect(updateCommand.input.ExpressionAttributeValues).not.toHaveProperty(':projectId');
    expect(updateCommand.input.ExpressionAttributeValues).not.toHaveProperty(':deviceId');
    expect(updateCommand.input.UpdateExpression).not.toContain('#projectId');
    expect(updateCommand.input.UpdateExpression).not.toContain('#deviceId');
  });

  it('should write DeviceCurrentState from a real normalized telemetry event', async () => {
    const body: ParticleWebhook = {
      event: 'Ubidots-Sensor-Hook-v1',
      data: JSON.stringify({
        battery: 88,
        connecttime: 18,
        resets: 2,
        alerts: 0,
        occupancy: 3,
        dailyoccupancy: 19,
        temp: 72.4,
      }),
      coreid: 'real-normalized-device',
      published_at: '2026-07-01T12:00:00.000Z',
      fw_version: '14',
    };
    const parsedData = safeParseData(body.data);
    const normalizedFromParser = normalizeEvent(body, parsedData, {
      deviceId: 'real-normalized-device',
      eventName: 'Ubidots-Sensor-Hook-v1',
      eventTime: '2026-07-01T12:00:00.000Z',
      s3Key: 'particle-events/2026-07-01/Ubidots-Sensor-Hook-v1/real-normalized-device/2026-07-01T12-00-00-000Z.json',
    });

    mockDdbSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await updateDeviceCurrentState(
      'current-state-table',
      'real-normalized-device',
      '2026-07-01T12:00:00.000Z',
      'Ubidots-Sensor-Hook-v1',
      body,
      {
        ...parsed,
        deviceId: 'real-normalized-device',
        eventName: 'Ubidots-Sensor-Hook-v1',
        publishedAt: '2026-07-01T12:00:00.000Z',
        receivedAt: '2026-07-01T12:00:05.000Z',
        data: parsedData,
      },
      normalizedFromParser
    );

    const updateCommand = mockDdbSend.mock.calls[1][0] as UpdateCommand;
    expect(updateCommand.input).toMatchObject({
      TableName: 'current-state-table',
      Key: {
        projectId: 'generalized-core-counter',
        deviceId: 'real-normalized-device',
      },
    });
    expect(updateCommand.input.ExpressionAttributeValues).toMatchObject({
      ':lastEventType': 'telemetry.occupancy',
      ':lastPlane': 'telemetry',
      ':lastApplicationReportAt': '2026-07-01T12:00:00.000Z',
      ':battery': 88,
      ':connectTime': 18,
      ':resetCount': 2,
      ':alertCount': 0,
      ':occupancy': 3,
      ':dailyOccupancy': 19,
      ':temperature': 72.4,
      ':healthStatus': 'healthy',
      ':anomalyCount': 0,
    });
  });

  it('should persist Particle API device-name metadata in current state', async () => {
    const body: ParticleWebhook = {
      event: 'occupancy',
      coreid: 'device123',
      published_at: '2026-07-01T10:00:00.000Z',
    };

    mockDdbSend.mockResolvedValueOnce({});

    await updateDeviceCurrentState(
      'current-state-table',
      'device123',
      '2026-07-01T10:00:00.000Z',
      'occupancy',
      body,
      parsed,
      normalized,
      {
        previous: null,
        deviceNameResolution: {
          deviceName: 'trail-counter-17',
          deviceNameResolvedAt: '2026-07-01T10:00:00.000Z',
          deviceNameSource: 'particle-api',
        },
      }
    );

    const updateCommand = mockDdbSend.mock.calls[0][0] as UpdateCommand;
    expect(updateCommand.input.ExpressionAttributeValues).toMatchObject({
      ':deviceName': 'trail-counter-17',
      ':deviceNameResolvedAt': '2026-07-01T10:00:00.000Z',
      ':deviceNameSource': 'particle-api',
    });
  });

  it('should conditionally write a newer device-status Ledger snapshot', async () => {
    mockDdbSend.mockResolvedValueOnce({});

    await expect(updateDeviceStatusLedgerSnapshot(
      'current-state-table',
      'generalized-core-counter',
      'device123',
      {
        updatedAt: '2026-07-13T10:05:00.000Z',
        fetchedAt: '2026-07-13T10:10:00.000Z',
        sizeBytes: 256,
        data: { connection: { state: 'connected' } },
      }
    )).resolves.toBe('updated');

    const updateCommand = mockDdbSend.mock.calls[0][0] as UpdateCommand;
    expect(updateCommand.input).toMatchObject({
      TableName: 'current-state-table',
      Key: {
        projectId: 'generalized-core-counter',
        deviceId: 'device123',
      },
      ConditionExpression: 'attribute_not_exists(#ledgerUpdatedAt) OR #ledgerUpdatedAt < :incomingUpdatedAt',
      ExpressionAttributeNames: {
        '#ledgerUpdatedAt': 'deviceStatusLedgerUpdatedAt',
        '#ledgerFetchedAt': 'deviceStatusLedgerFetchedAt',
        '#ledgerSizeBytes': 'deviceStatusLedgerSizeBytes',
        '#ledgerData': 'deviceStatusLedgerData',
      },
      ExpressionAttributeValues: {
        ':incomingUpdatedAt': '2026-07-13T10:05:00.000Z',
        ':fetchedAt': '2026-07-13T10:10:00.000Z',
        ':sizeBytes': 256,
        ':ledgerData': { connection: { state: 'connected' } },
      },
    });
  });

  it('should treat a failed conditional device-status Ledger write as stale', async () => {
    mockDdbSend.mockRejectedValueOnce(Object.assign(new Error('stale'), { name: 'ConditionalCheckFailedException' }));

    await expect(updateDeviceStatusLedgerSnapshot(
      'current-state-table',
      'generalized-core-counter',
      'device123',
      {
        updatedAt: '2026-07-13T10:05:00.000Z',
        fetchedAt: '2026-07-13T10:10:00.000Z',
        data: { connection: { state: 'connected' } },
      }
    )).resolves.toBe('stale');
  });

  it('should project product-defaults and device-settings snapshots with distinct field names', async () => {
    mockDdbSend.mockResolvedValue({});
    const defaults = { timing: { reportingIntervalSec: 3600, connectAttemptBudgetSec: 300 } };
    const overrides = { timing: { reportingIntervalSec: 1800 } };

    await updateProductDefaultsLedgerSnapshot('current-state-table', 'generalized-core-counter', 'device123', {
      updatedAt: '2026-07-13T09:00:00.000Z',
      fetchedAt: '2026-07-13T10:10:00.000Z',
      data: defaults,
    });
    await updateDeviceSettingsLedgerSnapshot('current-state-table', 'generalized-core-counter', 'device123', {
      updatedAt: '2026-07-13T09:30:00.000Z',
      fetchedAt: '2026-07-13T10:10:00.000Z',
      data: overrides,
    });

    const defaultsCommand = mockDdbSend.mock.calls[0][0] as UpdateCommand;
    const settingsCommand = mockDdbSend.mock.calls[1][0] as UpdateCommand;
    expect(defaultsCommand.input.ExpressionAttributeNames).toMatchObject({
      '#ledgerUpdatedAt': 'productDefaultsLedgerUpdatedAt',
      '#ledgerFetchedAt': 'productDefaultsLedgerFetchedAt',
      '#ledgerData': 'productDefaultsLedgerData',
    });
    expect(settingsCommand.input.ExpressionAttributeNames).toMatchObject({
      '#ledgerUpdatedAt': 'deviceSettingsLedgerUpdatedAt',
      '#ledgerFetchedAt': 'deviceSettingsLedgerFetchedAt',
      '#ledgerData': 'deviceSettingsLedgerData',
    });
  });

  it('should project an optional missing device-settings Ledger by clearing old overrides', async () => {
    mockDdbSend.mockResolvedValueOnce({});

    await expect(projectMissingDeviceSettingsLedger(
      'current-state-table',
      'generalized-core-counter',
      'device123',
      '2026-07-13T10:10:00.000Z'
    )).resolves.toBe('updated');

    const command = mockDdbSend.mock.calls[0][0] as UpdateCommand;
    expect(command.input.UpdateExpression).toBe(
      'SET #ledgerFetchedAt = :fetchedAt REMOVE #ledgerUpdatedAt, #ledgerSizeBytes, #ledgerData'
    );
    expect(command.input.ExpressionAttributeNames).toMatchObject({
      '#ledgerFetchedAt': 'deviceSettingsLedgerFetchedAt',
      '#ledgerData': 'deviceSettingsLedgerData',
    });
  });

  it('should update current state from serial event without health metrics', () => {
    const state = buildCurrentState({
      projectId: 'generalized-core-counter',
      deviceId: 'device123',
      eventTime: '2026-06-26T14:30:00.000Z',
      eventName: 'serialLog',
      body: {
        event: 'serialLog',
        deviceId: 'device123',
        sourceType: 'serial-forwarder',
        logLine: '[ERROR] modem fault',
      },
      parsed: { ...parsed, eventName: 'serialLog', data: '[ERROR] modem fault' },
      normalized: {
        schemaVersion: '1.0',
        eventId: 'serial-event-id',
        projectId: 'generalized-core-counter',
        plane: 'serial',
        eventType: 'serial.log',
        eventVersion: '1.0',
        sourceType: 'serial-forwarder',
        isSyntheticTime: false,
        severity: 'ERROR',
        serialLogLine: '[ERROR] modem watchdog fault',
        serialCategory: 'modem',
        watchdogDetected: true,
        rawRef: { s3Key: 'serial-key' },
      },
      previous: null,
      updatedAt: '2026-06-26T14:30:05.000Z',
    });

    expect(state).toMatchObject({
      lastPlane: 'serial',
      lastSourceType: 'serial-forwarder',
      lastEventType: 'serial.log',
      severity: 'ERROR',
      serialCategory: 'modem',
      lastSerialLogLine: '[ERROR] modem watchdog fault',
      watchdogDetected: true,
      healthStatus: 'critical',
      anomalyCount: 2,
    });
  });

  it('should update current state from serial lifecycle event without degrading telemetry health', () => {
    const state = buildCurrentState({
      projectId: 'generalized-core-counter',
      deviceId: 'device123',
      eventTime: '2026-06-26T14:30:00.000Z',
      eventName: 'serialLog',
      body: {
        event: 'serialLog',
        deviceId: 'device123',
        sourceType: 'serial-forwarder',
        eventType: 'SERIAL_CONNECTED',
      },
      parsed: { ...parsed, eventName: 'serialLog', data: undefined },
      normalized: {
        schemaVersion: '1.0',
        eventId: 'serial-connected-id',
        projectId: 'generalized-core-counter',
        plane: 'serial',
        eventType: 'serial.lifecycle.connected',
        eventVersion: '1.0',
        sourceType: 'serial-forwarder',
        isSyntheticTime: false,
        severity: null,
        serialCategory: null,
        networkState: 'connected',
        rawRef: { s3Key: 'serial-connected-key' },
      },
      previous: {
        projectId: 'generalized-core-counter',
        deviceId: 'device123',
        lastEventTime: '2026-06-26T13:30:00.000Z',
        lastIngestTime: '2026-06-26T13:30:05.000Z',
        lastEventType: 'telemetry.health',
        lastPlane: 'telemetry',
        lastApplicationReportAt: '2026-06-26T13:30:00.000Z',
        severity: 'ERROR',
        serialCategory: 'modem',
        battery: 24,
        healthStatus: 'warning',
        anomalyCount: 1,
        anomalies: [{ severity: 'medium', type: 'low_battery', message: 'Battery below 30%' }],
        offlineCandidate: false,
        updatedAt: '2026-06-26T13:30:05.000Z',
      },
      updatedAt: '2026-06-26T14:30:05.000Z',
    });

    expect(state).toMatchObject({
      lastPlane: 'serial',
      lastSourceType: 'serial-forwarder',
      lastEventType: 'serial.lifecycle.connected',
      lastApplicationReportAt: '2026-06-26T13:30:00.000Z',
      severity: null,
      serialCategory: null,
      networkState: 'connected',
      battery: 24,
      healthStatus: 'warning',
    });
  });

  it('should write current-state fields from a real normalized serial LOG event', async () => {
    const body: ParticleWebhook = {
      event: 'serialLog',
      sourceType: 'serial-forwarder',
      collectorId: 'serial-forwarder-pi-01',
      transport: 'usb-serial',
      deviceName: 'boron-soak-1',
      deviceId: 'e00fce688e592afaf23ac4fb',
      eventType: 'LOG',
      timestamp: '2026-06-21T08:35:11.794131+00:00',
      logLine: '0030908768 [ncp.client] ERROR: modem reconnect watchdog reset',
    };
    const normalizedSerial = normalizeEvent(body, safeParseData(body.data), {
      deviceId: body.deviceId!,
      eventName: 'serialLog',
      eventTime: body.timestamp!,
      s3Key: 'serial-key',
    });

    mockDdbSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await updateDeviceCurrentState(
      'current-state-table',
      body.deviceId!,
      body.timestamp!,
      'serialLog',
      body,
      {
        ...parsed,
        deviceId: body.deviceId!,
        eventName: 'serialLog',
        publishedAt: body.timestamp!,
        data: body.logLine,
      },
      normalizedSerial
    );

    const updateCommand = mockDdbSend.mock.calls[1][0] as UpdateCommand;
    expect(updateCommand.input.ExpressionAttributeValues).toMatchObject({
      ':deviceName': 'boron-soak-1',
      ':lastEventType': 'serial.log',
      ':lastPlane': 'serial',
      ':lastSourceType': 'serial-forwarder',
      ':severity': 'ERROR',
      ':serialCategory': 'modem',
      ':networkState': 'reconnecting',
      ':lastSerialLogLine': '0030908768 [ncp.client] ERROR: modem reconnect watchdog reset',
      ':recentSerialErrorCount': 1,
      ':reconnectDetected': true,
      ':watchdogDetected': true,
      ':resetDetected': true,
      ':healthStatus': 'critical',
    });
  });

  it('should detect warning when reset count increases', () => {
    expect(determineHealthStatus({ resetCount: 6 }, true)).toBe('warning');
  });

  it('should query current-state table by projectId without scanning event history', async () => {
    mockDdbSend.mockResolvedValue({ Items: [] });

    await queryDeviceCurrentStates('current-state-table', 'generalized-core-counter', 100);

    expect(mockDdbSend).toHaveBeenCalledWith(expect.any(QueryCommand));
    const command = mockDdbSend.mock.calls[0][0] as QueryCommand;
    expect(command.input).toMatchObject({
      TableName: 'current-state-table',
      KeyConditionExpression: 'projectId = :projectId',
      ExpressionAttributeValues: {
        ':projectId': 'generalized-core-counter',
      },
      Limit: 100,
    });
    expect(command.constructor.name).not.toBe('ScanCommand');
  });
});
