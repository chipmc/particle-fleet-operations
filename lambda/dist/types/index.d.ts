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
    sourceType?: string;
    collectorId?: string;
    transport?: string;
    eventType?: string;
    deviceName?: string;
    logLine?: string;
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
    sourceType?: string;
    collectorId?: string;
    transport?: string;
    eventType?: string;
    deviceName?: string;
    logLine?: string;
}
/**
 * Lambda response structure
 */
export interface LambdaResponse {
    statusCode: number;
    body: string;
}
/**
 * Canonical event envelope
 * From: docs/contracts/canonical-event-envelope.md
 *
 * This will be implemented in Phase 2 - Normalization
 * Keeping type definition here for future reference
 */
//# sourceMappingURL=index.d.ts.map