/**
 * DynamoDB query utilities for timeline inspection
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoIndexRecord, TimelineQueryOptions } from '../types';

/**
 * Create DynamoDB client with specified AWS profile
 */
export function createDynamoClient(profile: string): DynamoDBDocumentClient {
  const client = new DynamoDBClient({
    credentials: process.env.AWS_PROFILE === profile 
      ? undefined 
      : { 
          accessKeyId: '', 
          secretAccessKey: '' 
        },
  });
  return DynamoDBDocumentClient.from(client);
}

/**
 * Query device timeline from DynamoDB
 * 
 * @param tableName - DynamoDB table name
 * @param options - Query options (deviceId, time range, limit)
 * @param profile - AWS profile to use
 * @returns Array of timeline events in chronological order
 */
export async function queryDeviceTimeline(
  tableName: string,
  options: TimelineQueryOptions,
  profile: string = 'particle-admin'
): Promise<DynamoIndexRecord[]> {
  // Set AWS profile via environment variable
  process.env.AWS_PROFILE = profile;
  
  const ddb = createDynamoClient(profile);
  
  // Build key condition expression
  let keyConditionExpression = 'deviceId = :deviceId';
  const expressionAttributeValues: any = {
    ':deviceId': options.deviceId,
  };
  
  // Add time range filtering if specified
  if (options.startTime && options.endTime) {
    keyConditionExpression += ' AND eventTime BETWEEN :startTime AND :endTime';
    expressionAttributeValues[':startTime'] = options.startTime;
    expressionAttributeValues[':endTime'] = options.endTime;
  } else if (options.startTime) {
    keyConditionExpression += ' AND eventTime >= :startTime';
    expressionAttributeValues[':startTime'] = options.startTime;
  } else if (options.endTime) {
    keyConditionExpression += ' AND eventTime <= :endTime';
    expressionAttributeValues[':endTime'] = options.endTime;
  }
  
  const command = new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: keyConditionExpression,
    ExpressionAttributeValues: expressionAttributeValues,
    Limit: options.limit,
    ScanIndexForward: true, // chronological order (oldest first)
  });
  
  const response = await ddb.send(command);
  return (response.Items || []) as DynamoIndexRecord[];
}

/**
 * Calculate start time from hours offset
 * 
 * @param hours - Number of hours to look back
 * @returns ISO 8601 timestamp
 */
export function hoursAgo(hours: number): string {
  const date = new Date();
  date.setHours(date.getHours() - hours);
  return date.toISOString();
}
