/**
 * S3 storage operations for raw event archival
 *
 * Preserves exact current behavior:
 * - Immutable raw event storage
 * - JSON format with particle + parsed structure
 * - Date-partitioned key structure
 */
import { S3Client } from '@aws-sdk/client-s3';
import { ParticleWebhook, ParsedEvent } from '../types';
declare const s3: S3Client;
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
export declare function storeRawEvent(bucketName: string, key: string, particle: ParticleWebhook, parsed: ParsedEvent): Promise<void>;
export { s3 };
//# sourceMappingURL=s3.d.ts.map