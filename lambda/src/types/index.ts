/**
 * Type definitions for Particle log ingestion Lambda
 * 
 * Phase 1: Current schema (preserved exactly)
 * Phase 2: Will add CanonicalEvent types from canonical-event-envelope.md
 */

/**
 * API Gateway HTTP event structure
 */
export interface InboundEvent {
  body: string;
  headers: Record<string, string | undefined>;
  requestContext?: {
    http?: {
      userAgent?: string;
      sourceIp?: string;
    };
  };
}

/**
 * Particle webhook payload structure
 * This is the raw inbound format from Particle Cloud
 */
export interface ParticleWebhook {
  event?: string;
  data?: string | object;
  coreid?: string;
  deviceId?: string;
  published_at?: string;
  timestamp?: string;
  public?: boolean;
  fw_version?: string;
  
  // Extended fields from serial forwarder
  sourceType?: string;
  collectorId?: string;
  transport?: string;
  eventType?: string;
  deviceName?: string;
  logLine?: string;
  projectId?: string;
}

export type EventPlane = 'telemetry' | 'forensic' | 'serial';
export type EventSeverity = 'TRACE' | 'INFO' | 'WARN' | 'ERROR';

/**
 * Additive Phase 2 fields written alongside the existing DynamoDB index.
 * The raw payload remains exclusively in S3.
 */
export interface NormalizedEventFields {
  schemaVersion: '1.0';
  eventId: string;
  projectId: string;
  plane: EventPlane;
  eventType: string;
  eventVersion: '1.0';
  sourceType?: string;
  deviceName?: string;
  collectorId?: string;
  isSyntheticTime: boolean;
  severity?: EventSeverity;
  battery?: number;
  connectTime?: number;
  resetCount?: number;
  alertCount?: number;
  occupancy?: number;
  dailyOccupancy?: number;
  temperature?: number;
  fwVersion?: string;
  rawRef: {
    s3Key: string;
  };
}

/**
 * Parsed event data for internal processing
 * This is the current "safe record" structure
 */
export interface ParsedEvent {
  eventName: string;
  deviceId: string;
  publishedAt: string;
  receivedAt: string;
  public?: boolean;
  fw_version?: string;
  data: any;
  userAgent?: string;
  sourceIp?: string;
}

/**
 * S3 storage record format
 * Current structure: { particle, parsed }
 */
export interface S3StorageRecord {
  particle: ParticleWebhook;
  parsed: ParsedEvent;
}

/**
 * DynamoDB index record format
 * Current schema (exact preservation)
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
  
  // Extended fields
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
  plane?: EventPlane;
  eventVersion?: string;
  isSyntheticTime?: boolean;
  severity?: EventSeverity;
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
 * Lambda response structure
 */
export interface LambdaResponse {
  statusCode: number;
  body: string;
}
