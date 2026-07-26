import { detectAnomalies } from '../../utils/anomaly-detection';
import { DynamoIndexRecord } from '../../types';

describe('detectAnomalies', () => {
  it('preserves schemaVersion 1 anomaly behavior', () => {
    const events: DynamoIndexRecord[] = [
      {
        deviceId: 'device123',
        eventTime: '2026-07-13T10:05:00.000Z',
        eventName: 'Ubidots-Sensor-Hook-v1',
        receivedAt: '2026-07-13T10:05:05.000Z',
        s3Key: 'test-key',
        dataType: 'telemetry',
        schemaVersion: '1.0',
        battery: 25,
        connectTime: 200,
      },
    ];

    expect(detectAnomalies(events)).toEqual([
      expect.objectContaining({ severity: 'medium', type: 'low_battery', value: 25 }),
      expect.objectContaining({ severity: 'medium', type: 'high_connect_time', value: 200 }),
    ]);
  });
});
