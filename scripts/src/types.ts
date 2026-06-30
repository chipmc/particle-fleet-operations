/**
 * Type definitions for timeline CLI tool
 * Matches the additive Phase 2 DynamoDB schema while remaining compatible
 * with Phase 1 records.
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
  sourceEventType?: string;
  deviceName?: string;
  logLine?: string;

  // Phase 2 normalized/enriched fields
  schemaVersion?: string;
  eventId?: string;
  projectId?: string;
  plane?: 'telemetry' | 'forensic' | 'serial';
  eventVersion?: string;
  isSyntheticTime?: boolean;
  severity?: 'TRACE' | 'INFO' | 'WARN' | 'ERROR';
  battery?: number;
  connectTime?: number;
  resetCount?: number;
  alertCount?: number;
  occupancy?: number;
  dailyOccupancy?: number;
  temperature?: number;
  fwVersion?: string;
  rawRef?: {
    s3Key: string;
  };
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
