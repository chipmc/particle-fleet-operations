/**
 * Tests for event correlation module
 */

import { correlateEvents } from '../src/lib/correlation';
import { DynamoIndexRecord, S3StorageRecord } from '../src/types';

describe('Event Correlation', () => {
  
  describe('correlateEvents', () => {
    
    it('should handle empty events', async () => {
      const correlation = await correlateEvents('test-device', [], new Map(), 5);
      
      expect(correlation.deviceId).toBe('test-device');
      expect(correlation.windowCount).toBe(0);
      expect(correlation.summary.totalInferences).toBe(0);
    });
    
    it('should group events into time windows', async () => {
      const events: DynamoIndexRecord[] = [
        {
          deviceId: 'test-device',
          eventTime: '2026-06-28T10:00:00.000Z',
          eventName: 'sensor-hook',
          receivedAt: '2026-06-28T10:00:01.000Z',
          s3Key: 'key-1',
          dataType: 'string',
        },
        {
          deviceId: 'test-device',
          eventTime: '2026-06-28T10:02:00.000Z',
          eventName: 'sensor-hook',
          receivedAt: '2026-06-28T10:02:01.000Z',
          s3Key: 'key-2',
          dataType: 'string',
        },
        {
          deviceId: 'test-device',
          eventTime: '2026-06-28T10:10:00.000Z',
          eventName: 'sensor-hook',
          receivedAt: '2026-06-28T10:10:01.000Z',
          s3Key: 'key-3',
          dataType: 'string',
        },
      ];
      
      const payloads = new Map<string, S3StorageRecord>();
      
      const correlation = await correlateEvents('test-device', events, payloads, 5);
      
      expect(correlation.windowCount).toBe(2); // Two 5-minute windows
      expect(correlation.windows[0].events.length).toBe(2); // First two events
      expect(correlation.windows[1].events.length).toBe(1); // Third event
    });
    
    it('should extract telemetry data', async () => {
      const events: DynamoIndexRecord[] = [
        {
          deviceId: 'test-device',
          eventTime: '2026-06-28T10:00:00.000Z',
          eventName: 'Ubidots-Sensor-Hook-v1',
          receivedAt: '2026-06-28T10:00:01.000Z',
          s3Key: 'key-1',
          dataType: 'string',
        },
      ];
      
      const payloads = new Map<string, S3StorageRecord>([
        ['key-1', {
          particle: {
            data: '{"battery": 85.5, "connecttime": 45, "temp": 28.5, "resets": 0, "alerts": 0}',
          },
          parsed: {},
        }],
      ]);
      
      const correlation = await correlateEvents('test-device', events, payloads, 5);
      
      expect(correlation.windows[0].telemetry.length).toBe(1);
      expect(correlation.windows[0].telemetry[0].battery).toBe(85.5);
      expect(correlation.windows[0].telemetry[0].connecttime).toBe(45);
      expect(correlation.windows[0].telemetry[0].temperature).toBe(28.5);
    });
    
    it('should detect connectivity degradation (high connecttime + modem errors)', async () => {
      const events: DynamoIndexRecord[] = [
        {
          deviceId: 'test-device',
          eventTime: '2026-06-28T10:00:00.000Z',
          eventName: 'sensor-hook',
          receivedAt: '2026-06-28T10:00:01.000Z',
          s3Key: 'key-1',
          dataType: 'string',
        },
        {
          deviceId: 'test-device',
          eventTime: '2026-06-28T10:01:00.000Z',
          eventName: 'serial-log',
          receivedAt: '2026-06-28T10:01:01.000Z',
          s3Key: 'key-2',
          dataType: 'string',
          sourceType: 'serial-forwarder',
          logLine: 'MODEM ERROR: cellular connection failed',
        },
      ];
      
      const payloads = new Map<string, S3StorageRecord>([
        ['key-1', {
          particle: {
            data: '{"battery": 85, "connecttime": 150}',
          },
          parsed: {},
        }],
      ]);
      
      const correlation = await correlateEvents('test-device', events, payloads, 5);
      
      expect(correlation.windows[0].inferences.length).toBeGreaterThan(0);
      const connectivityInference = correlation.windows[0].inferences.find(
        i => i.category === 'connectivity' && i.message.includes('Connectivity degradation')
      );
      expect(connectivityInference).toBeDefined();
      expect(connectivityInference!.severity).toBe('WARNING');
    });
    
    it('should detect USB instability (repeated serial connect/disconnect)', async () => {
      const events: DynamoIndexRecord[] = [
        {
          deviceId: 'test-device',
          eventTime: '2026-06-28T10:00:00.000Z',
          eventName: 'serial-connected',
          receivedAt: '2026-06-28T10:00:01.000Z',
          s3Key: 'key-1',
          dataType: 'string',
          eventType: 'SERIAL_CONNECTED',
        },
        {
          deviceId: 'test-device',
          eventTime: '2026-06-28T10:01:00.000Z',
          eventName: 'serial-disconnected',
          receivedAt: '2026-06-28T10:01:01.000Z',
          s3Key: 'key-2',
          dataType: 'string',
          eventType: 'SERIAL_DISCONNECTED',
        },
        {
          deviceId: 'test-device',
          eventTime: '2026-06-28T10:02:00.000Z',
          eventName: 'serial-connected',
          receivedAt: '2026-06-28T10:02:01.000Z',
          s3Key: 'key-3',
          dataType: 'string',
          eventType: 'SERIAL_CONNECTED',
        },
      ];
      
      const payloads = new Map<string, S3StorageRecord>();
      
      const correlation = await correlateEvents('test-device', events, payloads, 5);
      
      const usbInference = correlation.windows[0].inferences.find(
        i => i.category === 'hardware' && i.message.includes('USB instability')
      );
      expect(usbInference).toBeDefined();
      expect(usbInference!.severity).toBe('WARNING');
    });

    it('should preserve serial lifecycle subtypes from normalized records', async () => {
      const events: DynamoIndexRecord[] = [{
        deviceId: 'test-device',
        eventTime: '2026-06-28T10:00:00.000Z',
        eventName: 'SERIAL_CONNECTED',
        receivedAt: '2026-06-28T10:00:01.000Z',
        s3Key: 'key-1',
        dataType: 'string',
        plane: 'serial',
        eventType: 'serial.lifecycle',
        sourceEventType: 'SERIAL_CONNECTED',
      }];

      const correlation = await correlateEvents(
        'test-device',
        events,
        new Map<string, S3StorageRecord>(),
        5
      );

      expect(correlation.windows[0].serialLifecycle).toEqual([
        expect.objectContaining({ eventType: 'SERIAL_CONNECTED' }),
      ]);
    });
    
    it('should detect network stall causing watchdog (watchdog + high connecttime)', async () => {
      const events: DynamoIndexRecord[] = [
        {
          deviceId: 'test-device',
          eventTime: '2026-06-28T10:00:00.000Z',
          eventName: 'sensor-hook',
          receivedAt: '2026-06-28T10:00:01.000Z',
          s3Key: 'key-1',
          dataType: 'string',
        },
        {
          deviceId: 'test-device',
          eventTime: '2026-06-28T10:02:00.000Z',
          eventName: 'watchdog',
          receivedAt: '2026-06-28T10:02:01.000Z',
          s3Key: 'key-2',
          dataType: 'string',
        },
      ];
      
      const payloads = new Map<string, S3StorageRecord>([
        ['key-1', {
          particle: {
            data: '{"battery": 85, "connecttime": 240}',
          },
          parsed: {},
        }],
        ['key-2', {
          particle: {},
          parsed: {
            resetCause: 'network timeout',
          },
        }],
      ]);
      
      const correlation = await correlateEvents('test-device', events, payloads, 5);
      
      const networkStallInference = correlation.windows[0].inferences.find(
        i => i.category === 'connectivity' && i.message.includes('Network stall')
      );
      expect(networkStallInference).toBeDefined();
      expect(networkStallInference!.severity).toBe('CRITICAL');
    });
    
    it('should detect device reboot (reset count increase + watchdog)', async () => {
      const events: DynamoIndexRecord[] = [
        {
          deviceId: 'test-device',
          eventTime: '2026-06-28T10:00:00.000Z',
          eventName: 'sensor-hook',
          receivedAt: '2026-06-28T10:00:01.000Z',
          s3Key: 'key-1',
          dataType: 'string',
        },
        {
          deviceId: 'test-device',
          eventTime: '2026-06-28T10:01:00.000Z',
          eventName: 'watchdog',
          receivedAt: '2026-06-28T10:01:01.000Z',
          s3Key: 'key-2',
          dataType: 'string',
        },
        {
          deviceId: 'test-device',
          eventTime: '2026-06-28T10:03:00.000Z',
          eventName: 'sensor-hook',
          receivedAt: '2026-06-28T10:03:01.000Z',
          s3Key: 'key-3',
          dataType: 'string',
        },
      ];
      
      const payloads = new Map<string, S3StorageRecord>([
        ['key-1', {
          particle: { data: '{"resets": 5}' },
          parsed: {},
        }],
        ['key-2', {
          particle: {},
          parsed: { resetCause: 'watchdog' },
        }],
        ['key-3', {
          particle: { data: '{"resets": 6}' },
          parsed: {},
        }],
      ]);
      
      const correlation = await correlateEvents('test-device', events, payloads, 5);
      
      const rebootInference = correlation.windows[0].inferences.find(
        i => i.category === 'stability' && i.message.includes('Device reboot')
      );
      expect(rebootInference).toBeDefined();
      expect(rebootInference!.severity).toBe('CRITICAL');
    });
    
    it('should detect power anomaly (low battery + alerts)', async () => {
      const events: DynamoIndexRecord[] = [
        {
          deviceId: 'test-device',
          eventTime: '2026-06-28T10:00:00.000Z',
          eventName: 'sensor-hook',
          receivedAt: '2026-06-28T10:00:01.000Z',
          s3Key: 'key-1',
          dataType: 'string',
        },
      ];
      
      const payloads = new Map<string, S3StorageRecord>([
        ['key-1', {
          particle: {
            data: '{"battery": 25, "alerts": 2}',
          },
          parsed: {},
        }],
      ]);
      
      const correlation = await correlateEvents('test-device', events, payloads, 5);
      
      const powerInference = correlation.windows[0].inferences.find(
        i => i.category === 'power' && i.message.includes('Power anomaly')
      );
      expect(powerInference).toBeDefined();
      expect(powerInference!.severity).toBe('CRITICAL');
    });
    
    it('should detect reconnect loop', async () => {
      const events: DynamoIndexRecord[] = [
        {
          deviceId: 'test-device',
          eventTime: '2026-06-28T10:00:00.000Z',
          eventName: 'serial-log',
          receivedAt: '2026-06-28T10:00:01.000Z',
          s3Key: 'key-1',
          dataType: 'string',
          sourceType: 'serial-forwarder',
          logLine: 'Device attempting reconnect',
        },
        {
          deviceId: 'test-device',
          eventTime: '2026-06-28T10:01:00.000Z',
          eventName: 'serial-log',
          receivedAt: '2026-06-28T10:01:01.000Z',
          s3Key: 'key-2',
          dataType: 'string',
          sourceType: 'serial-forwarder',
          logLine: 'Retry connection attempt failed',
        },
      ];
      
      const payloads = new Map<string, S3StorageRecord>([
        ['key-1', { particle: {}, parsed: {} }],
        ['key-2', { particle: {}, parsed: {} }],
      ]);
      
      const correlation = await correlateEvents('test-device', events, payloads, 5);
      
      // Verify serial logs were extracted
      expect(correlation.windows[0].serialLogs.length).toBe(2);
      expect(correlation.windows[0].serialLogs[0].category).toBe('reconnect');
      expect(correlation.windows[0].serialLogs[1].category).toBe('reconnect');
      
      const reconnectInference = correlation.windows[0].inferences.find(
        i => i.category === 'connectivity' && i.message.includes('Reconnect loop')
      );
      expect(reconnectInference).toBeDefined();
      expect(reconnectInference!.severity).toBe('WARNING');
    });
    
    it('should calculate summary statistics correctly', async () => {
      const events: DynamoIndexRecord[] = [
        {
          deviceId: 'test-device',
          eventTime: '2026-06-28T10:00:00.000Z',
          eventName: 'sensor-hook',
          receivedAt: '2026-06-28T10:00:01.000Z',
          s3Key: 'key-1',
          dataType: 'string',
        },
        {
          deviceId: 'test-device',
          eventTime: '2026-06-28T10:10:00.000Z',
          eventName: 'sensor-hook',
          receivedAt: '2026-06-28T10:10:01.000Z',
          s3Key: 'key-2',
          dataType: 'string',
        },
      ];
      
      const payloads = new Map<string, S3StorageRecord>([
        ['key-1', {
          particle: { data: '{"battery": 15}' },
          parsed: {},
        }],
        ['key-2', {
          particle: { data: '{"connecttime": 200}' },
          parsed: {},
        }],
      ]);
      
      const correlation = await correlateEvents('test-device', events, payloads, 5);
      
      expect(correlation.summary.totalInferences).toBeGreaterThan(0);
      expect(correlation.summary.criticalCount).toBeGreaterThan(0);
      expect(correlation.summary.topCategories).toBeDefined();
    });
    
    it('should handle events with no inferences', async () => {
      const events: DynamoIndexRecord[] = [
        {
          deviceId: 'test-device',
          eventTime: '2026-06-28T10:00:00.000Z',
          eventName: 'sensor-hook',
          receivedAt: '2026-06-28T10:00:01.000Z',
          s3Key: 'key-1',
          dataType: 'string',
        },
      ];
      
      const payloads = new Map<string, S3StorageRecord>([
        ['key-1', {
          particle: { data: '{"battery": 85, "connecttime": 5}' },
          parsed: {},
        }],
      ]);
      
      const correlation = await correlateEvents('test-device', events, payloads, 5);
      
      expect(correlation.windows[0].inferences.length).toBe(0);
      expect(correlation.summary.totalInferences).toBe(0);
    });
    
  });
  
});
