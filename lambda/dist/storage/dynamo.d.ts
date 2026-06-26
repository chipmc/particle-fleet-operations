/**
 * DynamoDB operations for event indexing
 *
 * Preserves exact current behavior:
 * - Fast indexed retrieval by deviceId + eventTime
 * - Current schema (no normalization yet)
 * - Extended fields from serial forwarder
 */
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ParticleWebhook } from '../types';
declare const ddb: DynamoDBDocumentClient;
/**
 * Index event in DynamoDB for fast retrieval
 *
 * Preserves exact current schema:
 * - Partition key: deviceId
 * - Sort key: eventTime
 * - Includes s3Key reference for raw data replay
 *
 * @param tableName - DynamoDB table name from environment
 * @param deviceId - Device identifier
 * @param eventTime - Event timestamp (published_at)
 * @param eventName - Event name
 * @param receivedAt - Ingestion timestamp
 * @param s3Key - S3 key for raw event
 * @param body - Original webhook body (for extended fields)
 * @param parsedData - Parsed data (for dataType)
 */
export declare function indexEvent(tableName: string, deviceId: string, eventTime: string, eventName: string, receivedAt: string, s3Key: string, body: ParticleWebhook, parsedData: any): Promise<void>;
export { ddb };
//# sourceMappingURL=dynamo.d.ts.map