/**
 * DynamoDB operations for event indexing
 * 
 * Preserves exact current behavior:
 * - Fast indexed retrieval by deviceId + eventTime
 * - Current schema (no normalization yet)
 * - Extended fields from serial forwarder
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ParticleWebhook, DynamoIndexRecord } from '../types';

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
 */
export async function indexEvent(
  tableName: string,
  deviceId: string,
  eventTime: string,
  eventName: string,
  receivedAt: string,
  s3Key: string,
  body: ParticleWebhook,
  parsedData: any
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
    deviceName: body.deviceName,
    logLine: body.logLine,
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
