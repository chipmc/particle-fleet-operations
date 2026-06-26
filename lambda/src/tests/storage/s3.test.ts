/**
 * S3 storage module tests
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { storeRawEvent, s3 } from '../../storage/s3';
import { ParticleWebhook, ParsedEvent } from '../../types';

// Mock S3 client send method
const mockS3Send = jest.fn();
jest.spyOn(s3, 'send').mockImplementation(mockS3Send);

describe('S3 Storage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should store event with correct structure', async () => {
    const particle: ParticleWebhook = {
      event: 'occupancy',
      data: '{"count":5}',
      coreid: 'device123',
      published_at: '2026-06-26T14:30:00.000Z',
    };

    const parsed: ParsedEvent = {
      eventName: 'occupancy',
      deviceId: 'device123',
      publishedAt: '2026-06-26T14:30:00.000Z',
      receivedAt: '2026-06-26T14:30:05.000Z',
      data: { count: 5 },
    };

    mockS3Send.mockResolvedValue({});

    await storeRawEvent('test-bucket', 'test-key', particle, parsed);

    expect(mockS3Send).toHaveBeenCalledWith(
      expect.any(PutObjectCommand)
    );

    const command = mockS3Send.mock.calls[0][0] as PutObjectCommand;
    expect(command.input).toMatchObject({
      Bucket: 'test-bucket',
      Key: 'test-key',
      ContentType: 'application/json',
    });

    // Verify structure: { particle, parsed }
    const body = JSON.parse(command.input.Body as string);
    expect(body).toEqual({
      particle,
      parsed,
    });
  });

  it('should format JSON with indentation', async () => {
    const particle: ParticleWebhook = {
      event: 'test',
      coreid: 'device123',
    };

    const parsed: ParsedEvent = {
      eventName: 'test',
      deviceId: 'device123',
      publishedAt: '2026-06-26T14:30:00.000Z',
      receivedAt: '2026-06-26T14:30:05.000Z',
      data: {},
    };

    mockS3Send.mockResolvedValue({});

    await storeRawEvent('test-bucket', 'test-key', particle, parsed);

    const command = mockS3Send.mock.calls[0][0] as PutObjectCommand;
    const body = command.input.Body as string;

    // Verify pretty-printed JSON (2-space indent)
    expect(body).toContain('\n');
    expect(body).toMatch(/"particle":/);
    expect(body).toMatch(/"parsed":/);
  });
});
