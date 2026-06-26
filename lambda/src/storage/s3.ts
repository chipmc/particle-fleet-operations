/**
 * S3 storage operations for raw event archival
 * 
 * Preserves exact current behavior:
 * - Immutable raw event storage
 * - JSON format with particle + parsed structure
 * - Date-partitioned key structure
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { ParticleWebhook, ParsedEvent, S3StorageRecord } from '../types';

// Initialize client at module level to allow mocking
const s3 = new S3Client({});

/**
 * Store raw event in S3
 * 
 * Preserves exact current structure:
 * {
 *   "particle": <original webhook body>,
 *   "parsed": <safe record>
 * }
 * 
 * @param bucketName - S3 bucket name from environment
 * @param key - S3 object key (date-partitioned path)
 * @param particle - Original Particle webhook body
 * @param parsed - Parsed event record
 */
export async function storeRawEvent(
  bucketName: string,
  key: string,
  particle: ParticleWebhook,
  parsed: ParsedEvent
): Promise<void> {
  const record: S3StorageRecord = {
    particle,
    parsed,
  };

  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: JSON.stringify(record, null, 2),
      ContentType: 'application/json',
    })
  );
}

// Export for testing
export { s3 };
