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

// ============================================================================
// Phase 2 Function Tests (Scaffolded - Currently Skipped)
// ============================================================================

describe.skip('Phase 2 Normalization Functions', () => {
  describe('normalizeEvent', () => {
    it('should normalize Particle webhook to canonical envelope', () => {
      // TODO Phase 2: Implement test
      expect(() => normalizeEvent()).toThrow('not implemented');
    });

    it('should map eventName to stable eventType', () => {
      // TODO Phase 2: Test eventName -> eventType mapping
      // Example: watchdog -> forensic.watchdog
      expect(() => normalizeEvent()).toThrow('not implemented');
    });

    it('should add schemaVersion and eventVersion', () => {
      // TODO Phase 2: Test version fields
      expect(() => normalizeEvent()).toThrow('not implemented');
    });

    it('should classify plane (telemetry|forensic|serial)', () => {
      // TODO Phase 2: Test plane classification
      expect(() => normalizeEvent()).toThrow('not implemented');
    });
  });

  describe('parseSeverity', () => {
    it('should extract INFO from log prefix', () => {
      // TODO Phase 2: Test [INFO] -> INFO
      expect(() => parseSeverity()).toThrow('not implemented');
    });

    it('should extract WARN from log prefix', () => {
      // TODO Phase 2: Test [WARN] -> WARN
      expect(() => parseSeverity()).toThrow('not implemented');
    });

    it('should extract ERROR from log prefix', () => {
      // TODO Phase 2: Test [ERROR] -> ERROR
      expect(() => parseSeverity()).toThrow('not implemented');
    });

    it('should classify watchdog events as ERROR', () => {
      // TODO Phase 2: Test watchdog -> ERROR
      expect(() => parseSeverity()).toThrow('not implemented');
    });

    it('should return null for non-log events', () => {
      // TODO Phase 2: Test telemetry events -> null
      expect(() => parseSeverity()).toThrow('not implemented');
    });
  });

  describe('parseResetCause', () => {
    it('should extract reset cause from watchdog event', () => {
      // TODO Phase 2: Test watchdog data parsing
      expect(() => parseResetCause()).toThrow('not implemented');
    });

    it('should extract reset cause from status event', () => {
      // TODO Phase 2: Test status data parsing
      expect(() => parseResetCause()).toThrow('not implemented');
    });

    it('should return null for non-reset events', () => {
      // TODO Phase 2: Test normal events -> null
      expect(() => parseResetCause()).toThrow('not implemented');
    });
  });

  describe('parseQueueDepth', () => {
    it('should extract queue depth from status event', () => {
      // TODO Phase 2: Test queue metrics extraction
      expect(() => parseQueueDepth()).toThrow('not implemented');
    });

    it('should return null for non-status events', () => {
      // TODO Phase 2: Test other events -> null
      expect(() => parseQueueDepth()).toThrow('not implemented');
    });
  });

  describe('parseNetworkState', () => {
    it('should extract modem state from connectivity events', () => {
      // TODO Phase 2: Test modem state extraction
      expect(() => parseNetworkState()).toThrow('not implemented');
    });

    it('should extract signal strength', () => {
      // TODO Phase 2: Test signal metrics
      expect(() => parseNetworkState()).toThrow('not implemented');
    });

    it('should return null for non-connectivity events', () => {
      // TODO Phase 2: Test other events -> null
      expect(() => parseNetworkState()).toThrow('not implemented');
    });
  });
});
