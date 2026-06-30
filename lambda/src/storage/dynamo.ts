/**
 * DynamoDB operations for event indexing
 * 
 * Preserves the Phase 1 index shape and adds Phase 2A normalized fields:
 * - Fast indexed retrieval by deviceId + eventTime
 * - Unchanged partition and sort key model
 * - Extended fields from serial forwarder
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  ParticleWebhook,
  DynamoIndexRecord,
  NormalizedEventFields,
} from '../types';

// Initialize client at module level to allow mocking
const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

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
 * @param normalized - Best-effort Phase 2 normalization fields
 */
export async function indexEvent(
  tableName: string,
  deviceId: string,
  eventTime: string,
  eventName: string,
  receivedAt: string,
  s3Key: string,
  body: ParticleWebhook,
  parsedData: any,
  normalized?: NormalizedEventFields
): Promise<void> {
  const item: DynamoIndexRecord = {
    deviceId,
    eventTime,
    eventName,
    receivedAt,
    s3Key,
    fw_version: body.fw_version,
    public: body.public,
    dataType: typeof parsedData,

    // Extended fields from serial forwarder
    sourceType: body.sourceType,
    collectorId: body.collectorId,
    transport: body.transport,
    eventType: body.eventType,
    sourceEventType: body.eventType,
    deviceName: body.deviceName,
    logLine: body.logLine,

    // Additive normalized/enriched fields. Canonical eventType intentionally
    // supersedes the inbound value; sourceEventType retains the raw value.
    ...normalized,
  };

  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: item,
    })
  );
}

// Export for testing
export { ddb };
