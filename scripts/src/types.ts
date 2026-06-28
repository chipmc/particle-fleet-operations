/**
 * Type definitions for timeline CLI tool
 * Matches current DynamoDB schema (Phase 1)
 */

/**
 * DynamoDB index record (as stored in current schema)
 */
export interface DynamoIndexRecord {
  deviceId: string;
  eventTime: string;
  eventName: string;
  receivedAt: string;
  s3Key: string;
  fw_version?: string;
  public?: boolean;
  dataType: string;
  
  // Extended fields from serial forwarder
  sourceType?: string;
  collectorId?: string;
  transport?: string;
  eventType?: string;
  deviceName?: string;
  logLine?: string;
}

/**
 * Timeline query options
 */
export interface TimelineQueryOptions {
  deviceId: string;
  startTime?: string;
  endTime?: string;
  limit?: number;
}

/**
 * S3 storage record format (what's actually stored in S3)
 */
export interface S3StorageRecord {
  particle: any;
  parsed: any;
}
