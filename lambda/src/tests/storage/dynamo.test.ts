/**
 * DynamoDB storage module tests
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { indexEvent, ddb } from '../../storage/dynamo';
import { ParticleWebhook } from '../../types';

// Mock DynamoDB DocumentClient send method
const mockDdbSend = jest.fn();
jest.spyOn(ddb, 'send').mockImplementation(mockDdbSend);

describe('DynamoDB Storage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should index event with current schema', async () => {
    const body: ParticleWebhook = {
      event: 'occupancy',
      data: { count: 5 },
      coreid: 'device123',
      published_at: '2026-06-26T14:30:00.000Z',
      fw_version: '1.2.3',
      public: false,
    };

    mockDdbSend.mockResolvedValue({});

    await indexEvent(
      'test-table',
      'device123',
      '2026-06-26T14:30:00.000Z',
      'occupancy',
      '2026-06-26T14:30:05.000Z',
      'test-s3-key',
      body,
      { count: 5 }
    );

    expect(mockDdbSend).toHaveBeenCalledWith(
      expect.any(PutCommand)
    );

    const command = mockDdbSend.mock.calls[0][0] as PutCommand;
    expect(command.input).toMatchObject({
      TableName: 'test-table',
      Item: {
        deviceId: 'device123',
        eventTime: '2026-06-26T14:30:00.000Z',
        eventName: 'occupancy',
        receivedAt: '2026-06-26T14:30:05.000Z',
        s3Key: 'test-s3-key',
        fw_version: '1.2.3',
        public: false,
        dataType: 'object',
      },
    });
  });

  it('should include extended fields from serial forwarder', async () => {
    const body: ParticleWebhook = {
      event: 'serialLog',
      data: '[INFO] Test',
      deviceId: 'device123',
      published_at: '2026-06-26T14:30:00.000Z',
      sourceType: 'serial',
      collectorId: 'pi-001',
      transport: 'usb',
      eventType: 'serial.log',
      deviceName: 'Counter-42',
      logLine: '[INFO] Test',
    };

    mockDdbSend.mockResolvedValue({});

    await indexEvent(
      'test-table',
      'device123',
      '2026-06-26T14:30:00.000Z',
      'serialLog',
      '2026-06-26T14:30:05.000Z',
      'test-s3-key',
      body,
      '[INFO] Test'
    );

    const command = mockDdbSend.mock.calls[0][0] as PutCommand;
    expect(command.input.Item).toMatchObject({
      sourceType: 'serial',
      collectorId: 'pi-001',
      transport: 'usb',
      eventType: 'serial.log',
      deviceName: 'Counter-42',
      logLine: '[INFO] Test',
    });
  });

  it('should handle optional fields correctly', async () => {
    const body: ParticleWebhook = {
      event: 'test',
      coreid: 'device123',
    };

    mockDdbSend.mockResolvedValue({});

    await indexEvent(
      'test-table',
      'device123',
      '2026-06-26T14:30:00.000Z',
      'test',
      '2026-06-26T14:30:05.000Z',
      'test-s3-key',
      body,
      undefined
    );

    const command = mockDdbSend.mock.calls[0][0] as PutCommand;
    const item = command.input.Item as any;

    // Required fields present
    expect(item.deviceId).toBe('device123');
    expect(item.eventName).toBe('test');

    // Optional fields undefined (not present or explicitly undefined)
    expect(item.fw_version).toBeUndefined();
    expect(item.sourceType).toBeUndefined();
  });
});
