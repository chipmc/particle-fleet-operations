/**
 * Handler unit tests
 * 
 * Tests current behavior:
 * - Authentication (401 on missing/invalid secret)
 * - JSON validation (400 on invalid body)
 * - Successful ingestion (200 with storage)
 * - Burst handling (performance under load)
 */

import { handler } from '../handler';
import { storeRawEvent } from '../storage/s3';
import { indexEvent } from '../storage/dynamo';
import { InboundEvent } from '../types';

// Mock AWS SDK clients
jest.mock('../storage/s3');
jest.mock('../storage/dynamo');

const mockStoreRawEvent = storeRawEvent as jest.MockedFunction<typeof storeRawEvent>;
const mockIndexEvent = indexEvent as jest.MockedFunction<typeof indexEvent>;

describe('Lambda Handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      PARTICLE_WEBHOOK_SECRET: 'test-secret-123',
      RAW_LOGS_BUCKET_NAME: 'test-bucket',
      LOG_EVENTS_TABLE_NAME: 'test-table',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Authentication', () => {
    it('should return 401 when webhook secret is missing', async () => {
      const event: InboundEvent = {
        body: '{}',
        headers: {},
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body)).toEqual({
        ok: false,
        error: 'unauthorized',
      });
      expect(mockStoreRawEvent).not.toHaveBeenCalled();
      expect(mockIndexEvent).not.toHaveBeenCalled();
    });

    it('should return 401 when webhook secret is invalid', async () => {
      const event: InboundEvent = {
        body: '{}',
        headers: {
          'x-particle-webhook-secret': 'wrong-secret',
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body)).toEqual({
        ok: false,
        error: 'unauthorized',
      });
    });

    it('should accept lowercase header name', async () => {
      const event: InboundEvent = {
        body: JSON.stringify({ event: 'test', coreid: 'device123' }),
        headers: {
          'x-particle-webhook-secret': 'test-secret-123',
        },
      };

      mockStoreRawEvent.mockResolvedValue();
      mockIndexEvent.mockResolvedValue();

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
    });

    it('should accept uppercase header name', async () => {
      const event: InboundEvent = {
        body: JSON.stringify({ event: 'test', coreid: 'device123' }),
        headers: {
          'X-Particle-Webhook-Secret': 'test-secret-123',
        },
      };

      mockStoreRawEvent.mockResolvedValue();
      mockIndexEvent.mockResolvedValue();

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
    });
  });

  describe('JSON Validation', () => {
    it('should return 400 on invalid JSON', async () => {
      const event: InboundEvent = {
        body: 'invalid-json{',
        headers: {
          'x-particle-webhook-secret': 'test-secret-123',
        },
      };

      const response = await handler(event);

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({
        ok: false,
        error: 'invalid_json',
      });
      expect(mockStoreRawEvent).not.toHaveBeenCalled();
    });

    it('should handle empty body', async () => {
      const event: InboundEvent = {
        body: '',
        headers: {
          'x-particle-webhook-secret': 'test-secret-123',
        },
      };

      mockStoreRawEvent.mockResolvedValue();
      mockIndexEvent.mockResolvedValue();

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
    });
  });

  describe('Successful Ingestion', () => {
    it('should store Particle webhook event', async () => {
      const event: InboundEvent = {
        body: JSON.stringify({
          event: 'occupancy',
          data: '{"count":5}',
          coreid: 'e00fce68d0f8f8e5c7c3f0a9',
          published_at: '2026-06-26T14:30:00.000Z',
          fw_version: '1.2.3',
          public: false,
        }),
        headers: {
          'x-particle-webhook-secret': 'test-secret-123',
        },
        requestContext: {
          http: {
            userAgent: 'ParticleBot/1.0',
            sourceIp: '1.2.3.4',
          },
        },
      };

      mockStoreRawEvent.mockResolvedValue();
      mockIndexEvent.mockResolvedValue();

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        ok: true,
        stored: true,
      });

      // Verify S3 storage called
      expect(mockStoreRawEvent).toHaveBeenCalledWith(
        'test-bucket',
        expect.stringContaining('particle-events/2026-06-26/occupancy'),
        expect.objectContaining({
          event: 'occupancy',
          coreid: 'e00fce68d0f8f8e5c7c3f0a9',
        }),
        expect.objectContaining({
          eventName: 'occupancy',
          deviceId: 'e00fce68d0f8f8e5c7c3f0a9',
        })
      );

      // Verify DynamoDB indexing called
      expect(mockIndexEvent).toHaveBeenCalledWith(
        'test-table',
        'e00fce68d0f8f8e5c7c3f0a9',
        '2026-06-26T14:30:00.000Z',
        'occupancy',
        expect.any(String),
        expect.stringContaining('particle-events/2026-06-26/occupancy'),
        expect.any(Object),
        expect.any(Object),
        expect.objectContaining({
          schemaVersion: '1.0',
          eventType: 'telemetry.event',
          plane: 'telemetry',
          isSyntheticTime: false,
        })
      );
    });

    it('should handle serial forwarder events', async () => {
      const event: InboundEvent = {
        body: JSON.stringify({
          event: 'serialLog',
          data: '[INFO] Boot complete',
          deviceId: 'e00fce68d0f8f8e5c7c3f0a9',
          published_at: '2026-06-26T14:30:00.000Z',
          sourceType: 'serial',
          collectorId: 'pi-001',
          transport: 'usb',
          eventType: 'serial.log',
          deviceName: 'Counter-42',
          logLine: '[INFO] Boot complete',
        }),
        headers: {
          'x-particle-webhook-secret': 'test-secret-123',
        },
      };

      mockStoreRawEvent.mockResolvedValue();
      mockIndexEvent.mockResolvedValue();

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      
      // Verify extended fields passed to DynamoDB
      expect(mockIndexEvent).toHaveBeenCalledWith(
        'test-table',
        expect.any(String),
        expect.any(String),
        'serialLog',
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          sourceType: 'serial',
          collectorId: 'pi-001',
          deviceName: 'Counter-42',
        }),
        expect.any(String),
        expect.objectContaining({
          eventType: 'serial.log',
          severity: 'INFO',
          plane: 'serial',
        })
      );
    });

    it('should handle device ID fallback chain', async () => {
      const eventWithCoreid: InboundEvent = {
        body: JSON.stringify({ event: 'test', coreid: 'device-from-coreid' }),
        headers: { 'x-particle-webhook-secret': 'test-secret-123' },
      };

      mockStoreRawEvent.mockResolvedValue();
      mockIndexEvent.mockResolvedValue();

      await handler(eventWithCoreid);
      expect(mockIndexEvent).toHaveBeenCalledWith(
        expect.any(String),
        'device-from-coreid',
        expect.any(String),
        'test',
        expect.any(String),
        expect.any(String),
        expect.any(Object),
        undefined, // data field is undefined when not present
        expect.objectContaining({ isSyntheticTime: true })
      );

      jest.clearAllMocks();

      const eventWithDeviceId: InboundEvent = {
        body: JSON.stringify({ event: 'test', deviceId: 'device-from-deviceId' }),
        headers: { 'x-particle-webhook-secret': 'test-secret-123' },
      };

      await handler(eventWithDeviceId);
      expect(mockIndexEvent).toHaveBeenCalledWith(
        expect.any(String),
        'device-from-deviceId',
        expect.any(String),
        'test',
        expect.any(String),
        expect.any(String),
        expect.any(Object),
        undefined,
        expect.objectContaining({ isSyntheticTime: true })
      );
    });
  });

  describe('Performance', () => {
    it('should handle burst traffic without blocking', async () => {
      const event: InboundEvent = {
        body: JSON.stringify({
          event: 'occupancy',
          coreid: 'device123',
        }),
        headers: {
          'x-particle-webhook-secret': 'test-secret-123',
        },
      };

      mockStoreRawEvent.mockResolvedValue();
      mockIndexEvent.mockResolvedValue();

      // Simulate 500 concurrent requests (top-of-hour burst)
      const startTime = Date.now();
      const promises = Array.from({ length: 500 }, () => handler(event));
      await Promise.all(promises);
      const duration = Date.now() - startTime;

      // Verify no serialization bottlenecks
      // With async operations, 500 requests should complete quickly
      expect(duration).toBeLessThan(5000); // Reasonable threshold

      expect(mockStoreRawEvent).toHaveBeenCalledTimes(500);
      expect(mockIndexEvent).toHaveBeenCalledTimes(500);
    });
  });
});
