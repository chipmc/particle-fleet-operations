/**
 * Parser utility tests
 * 
 * Phase 1: Test current parsing behavior
 * Phase 2: Add tests for normalization functions (scaffolded below)
 */

import {
  parseEventBody,
  extractDeviceId,
  extractTimestamp,
  extractEventName,
  safeParseData,
  buildParsedEvent,
  generateS3Key,
  normalizeEvent,
  parseSeverity,
  parseResetCause,
  parseQueueDepth,
  parseNetworkState,
} from '../../utils/parse';
import { ParticleWebhook } from '../../types';

describe('Parser Utilities', () => {
  describe('parseEventBody', () => {
    it('should parse valid JSON', () => {
      const result = parseEventBody('{"event":"test"}');
      expect(result).toEqual({ event: 'test' });
    });

    it('should handle empty string as empty object', () => {
      const result = parseEventBody('');
      expect(result).toEqual({});
    });

    it('should throw on invalid JSON', () => {
      expect(() => parseEventBody('invalid{')).toThrow('Invalid JSON body');
    });
  });

  describe('extractDeviceId', () => {
    it('should prefer coreid', () => {
      const body: ParticleWebhook = {
        coreid: 'from-coreid',
        deviceId: 'from-deviceId',
      };
      expect(extractDeviceId(body)).toBe('from-coreid');
    });

    it('should fallback to deviceId', () => {
      const body: ParticleWebhook = {
        deviceId: 'from-deviceId',
      };
      expect(extractDeviceId(body)).toBe('from-deviceId');
    });

    it('should fallback to "unknown"', () => {
      const body: ParticleWebhook = {};
      expect(extractDeviceId(body)).toBe('unknown');
    });
  });

  describe('extractTimestamp', () => {
    it('should prefer published_at', () => {
      const body: ParticleWebhook = {
        published_at: '2026-06-26T14:30:00.000Z',
        timestamp: '2026-06-26T14:31:00.000Z',
      };
      expect(extractTimestamp(body)).toBe('2026-06-26T14:30:00.000Z');
    });

    it('should fallback to timestamp', () => {
      const body: ParticleWebhook = {
        timestamp: '2026-06-26T14:31:00.000Z',
      };
      expect(extractTimestamp(body)).toBe('2026-06-26T14:31:00.000Z');
    });

    it('should fallback to current time', () => {
      const body: ParticleWebhook = {};
      const result = extractTimestamp(body);
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  describe('extractEventName', () => {
    it('should extract event name', () => {
      const body: ParticleWebhook = { event: 'occupancy' };
      expect(extractEventName(body)).toBe('occupancy');
    });

    it('should fallback to "unknown"', () => {
      const body: ParticleWebhook = {};
      expect(extractEventName(body)).toBe('unknown');
    });
  });

  describe('safeParseData', () => {
    it('should parse JSON string', () => {
      const result = safeParseData('{"count":5}');
      expect(result).toEqual({ count: 5 });
    });

    it('should keep plain text as-is', () => {
      const result = safeParseData('plain text');
      expect(result).toBe('plain text');
    });

    it('should keep non-string data as-is', () => {
      const data = { count: 5 };
      const result = safeParseData(data);
      expect(result).toBe(data);
    });

    it('should handle invalid JSON gracefully', () => {
      const result = safeParseData('invalid{');
      expect(result).toBe('invalid{');
    });
  });

  describe('buildParsedEvent', () => {
    it('should build complete parsed event', () => {
      const body: ParticleWebhook = {
        event: 'occupancy',
        data: '{"count":5}',
        coreid: 'device123',
        published_at: '2026-06-26T14:30:00.000Z',
        fw_version: '1.2.3',
        public: false,
      };

      const result = buildParsedEvent(body, 'test-agent', '1.2.3.4');

      expect(result).toMatchObject({
        eventName: 'occupancy',
        deviceId: 'device123',
        publishedAt: '2026-06-26T14:30:00.000Z',
        fw_version: '1.2.3',
        public: false,
        data: { count: 5 },
        userAgent: 'test-agent',
        sourceIp: '1.2.3.4',
      });
      expect(result.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('generateS3Key', () => {
    it('should generate correct S3 key format', () => {
      const key = generateS3Key(
        'occupancy',
        'device123',
        '2026-06-26T14:30:00.000Z'
      );

      expect(key).toBe(
        'particle-events/2026-06-26/occupancy/device123/2026-06-26T14-30-00-000Z.json'
      );
    });

    it('should sanitize timestamp colons and periods', () => {
      const key = generateS3Key(
        'test',
        'device123',
        '2026-12-31T23:59:59.999Z'
      );

      expect(key).toContain('2026-12-31T23-59-59-999Z');
      expect(key).not.toContain(':');
      expect(key).not.toMatch(/\.\d{3}Z/);
    });

    it('should preserve date prefix extraction', () => {
      const key = generateS3Key(
        'test',
        'device123',
        '2026-06-26T14:30:00.000Z'
      );

      expect(key.startsWith('particle-events/2026-06-26/')).toBe(true);
    });
  });
});

describe('Phase 2 Normalization Functions', () => {
  const context = {
    deviceId: 'device123',
    eventName: 'Ubidots-Sensor-Hook-v1',
    eventTime: '2026-06-26T14:30:00.000Z',
    s3Key: 'particle-events/2026-06-26/test/device123/event.json',
  };

  describe('normalizeEvent', () => {
    it('normalizes telemetry webhook metrics', () => {
      const body: ParticleWebhook = {
        event: context.eventName,
        coreid: context.deviceId,
        published_at: context.eventTime,
        deviceName: 'Counter-42',
        fw_version: '2.4.0',
      };
      const result = normalizeEvent(body, {
        battery: '91.5',
        connecttime: 14,
        resets: '2',
        alerts: 0,
        occupancy: 7,
        dailyoccupancy: '42',
        temp: 28.75,
      }, context);

      expect(result).toMatchObject({
        schemaVersion: '1.0',
        projectId: 'generalized-core-counter',
        plane: 'telemetry',
        eventType: 'telemetry.occupancy',
        eventVersion: '1.0',
        sourceType: 'particle-webhook',
        deviceName: 'Counter-42',
        isSyntheticTime: false,
        battery: 91.5,
        connectTime: 14,
        resetCount: 2,
        alertCount: 0,
        occupancy: 7,
        dailyOccupancy: 42,
        temperature: 28.75,
        fwVersion: '2.4.0',
        rawRef: { s3Key: context.s3Key },
      });
      expect(result.eventId).toMatch(/^[a-f0-9]{64}$/);
      expect(normalizeEvent(body, {}, context).eventId).toBe(result.eventId);
    });

    it('normalizes serial logs and parses severity', () => {
      const result = normalizeEvent({
        event: 'serialLog',
        sourceType: 'serial-forwarder',
        collectorId: 'pi-001',
        eventType: 'LOG',
        logLine: '2026-06-26 [WARN] modem reconnect',
      }, 'not-json', {
        ...context,
        eventName: 'serialLog',
      });

      expect(result).toMatchObject({
        plane: 'serial',
        eventType: 'serial.log',
        severity: 'WARN',
        collectorId: 'pi-001',
      });
    });

    it.each([
      ['watchdog-v2', 'forensic', 'fault.watchdog'],
      ['device-status', 'forensic', 'telemetry.status'],
    ])('classifies %s', (eventName, plane, eventType) => {
      const result = normalizeEvent({ event: eventName }, {}, {
        ...context,
        eventName,
      });

      expect(result).toMatchObject({ plane, eventType });
    });

    it('classifies health and serial lifecycle events', () => {
      expect(normalizeEvent(
        { event: 'sensor-hook' },
        { battery: 80 },
        { ...context, eventName: 'sensor-hook' }
      ).eventType).toBe('telemetry.health');

      expect(normalizeEvent(
        {
          event: 'SERIAL_CONNECTED',
          sourceType: 'serial-forwarder',
          eventType: 'SERIAL_CONNECTED',
        },
        undefined,
        { ...context, eventName: 'SERIAL_CONNECTED' }
      )).toMatchObject({
        plane: 'serial',
        eventType: 'serial.lifecycle',
      });
    });

    it('uses best-effort fallback for malformed payloads', () => {
      expect(() => normalizeEvent(
        { event: 'brand-new-event', data: '{"battery":' },
        '{"battery":',
        { ...context, eventName: 'brand-new-event' }
      )).not.toThrow();

      const result = normalizeEvent(
        { event: 'brand-new-event' },
        '{"battery":',
        { ...context, eventName: 'brand-new-event' }
      );
      expect(result.eventType).toBe('telemetry.event');
      expect(result.battery).toBeUndefined();
    });

    it('flags a generated event timestamp as synthetic', () => {
      const result = normalizeEvent(
        { event: 'test' },
        undefined,
        { ...context, eventName: 'test' }
      );
      expect(result.isSyntheticTime).toBe(true);
    });
  });

  describe('parseSeverity', () => {
    it.each(['TRACE', 'INFO', 'WARN', 'ERROR'])('extracts %s', severity => {
      expect(parseSeverity(`[${severity}] message`)).toBe(severity);
    });

    it('returns null for unclassified lines', () => {
      expect(parseSeverity('ordinary line')).toBeNull();
    });
  });
});
