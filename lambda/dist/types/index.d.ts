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
    body?: string;
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
    product_id?: string | number;
    productId?: string | number;
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
    severity?: EventSeverity | null;
    battery?: number;
    connectTime?: number;
    resetCount?: number;
    alertCount?: number;
    occupancy?: number;
    dailyOccupancy?: number;
    temperature?: number;
    fwVersion?: string;
    networkState?: string | null;
    serialCategory?: string | null;
    serialLogLine?: string;
    reconnectDetected?: boolean;
    watchdogDetected?: boolean;
    resetDetected?: boolean;
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
    sourceType?: string;
    collectorId?: string;
    transport?: string;
    eventType?: string;
    sourceEventType?: string;
    deviceName?: string;
    logLine?: string;
    schemaVersion?: string;
    eventId?: string;
    projectId?: string;
    plane?: EventPlane;
    eventVersion?: string;
    isSyntheticTime?: boolean;
    severity?: EventSeverity | null;
    battery?: number;
    connectTime?: number;
    resetCount?: number;
    alertCount?: number;
    occupancy?: number;
    dailyOccupancy?: number;
    temperature?: number;
    fwVersion?: string;
    serialLogLine?: string;
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
/**
 * Phase 2B: Query API Types
 */
/**
 * API Gateway HTTP API v2 event structure
 * https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-lambda.html
 */
export interface QueryEvent {
    version: string;
    routeKey: string;
    rawPath: string;
    rawQueryString?: string;
    headers: Record<string, string | undefined>;
    queryStringParameters?: Record<string, string | undefined>;
    pathParameters?: Record<string, string | undefined>;
    body?: string;
    isBase64Encoded?: boolean;
    requestContext: {
        accountId: string;
        apiId: string;
        domainName: string;
        domainPrefix: string;
        http: {
            method: string;
            path: string;
            protocol: string;
            sourceIp: string;
            userAgent: string;
        };
        requestId: string;
        routeKey: string;
        stage: string;
        time: string;
        timeEpoch: number;
    };
}
/**
 * Timeline query response
 */
export interface TimelineEvent {
    eventTime: string;
    eventName: string;
    eventId?: string;
    eventType?: string;
    plane?: string;
    battery?: number;
    connectTime?: number;
    resetCount?: number;
    alertCount?: number;
    temperature?: number;
    occupancy?: number;
    dailyOccupancy?: number;
    severity?: string;
    s3Key: string;
    fwVersion?: string;
    serialLogLine?: string;
    logLine?: string;
}
export interface TimelineResponse {
    deviceId: string;
    start: string;
    end: string;
    count: number;
    events: TimelineEvent[];
}
/**
 * Health query response
 */
export interface MetricStats {
    latest: number;
    min: number;
    max: number;
    average: number;
    change?: number;
}
export interface OccupancyStats {
    latest: number;
    total: number;
}
export interface TimeSpan {
    start: string;
    end: string;
    hours: number;
}
export interface HealthAnomaly {
    severity: 'low' | 'medium' | 'high';
    type: string;
    eventTime: string;
    message: string;
    value?: number | string;
}
export interface HealthResponse {
    deviceId: string;
    timeSpan: TimeSpan;
    eventCount: number;
    battery?: MetricStats;
    connectTime?: MetricStats;
    resetCount?: MetricStats;
    alertCount?: MetricStats;
    temperature?: MetricStats;
    occupancy?: OccupancyStats;
    firmwareVersions: string[];
    anomalies: HealthAnomaly[];
}
/**
 * Summary query response
 */
export interface SummaryResponse {
    deviceId: string;
    eventCount: number;
    firstEventTime: string;
    lastEventTime: string;
    timeSpan: {
        hours: number;
    };
    eventCounts: Record<string, number>;
    planes: Record<string, number>;
    firmwareVersions: string[];
    recentAnomalyCount: number;
}
/**
 * Anomalies query response
 */
export interface AnomaliesResponse {
    deviceId: string;
    count: number;
    anomalies: HealthAnomaly[];
}
/**
 * Phase 3: Fleet current-state types
 */
export type DeviceHealthStatus = 'healthy' | 'warning' | 'critical' | 'unknown';
export interface CurrentStateAnomaly {
    severity: 'low' | 'medium' | 'high';
    type: string;
    message: string;
}
export interface DeviceCurrentState {
    projectId: string;
    deviceId: string;
    deviceName?: string;
    deviceNameResolvedAt?: string;
    deviceNameSource?: 'particle-api';
    lastEventTime: string;
    lastIngestTime: string;
    lastEventType: string;
    lastPlane?: EventPlane;
    lastSourceType?: string;
    fwVersion?: string;
    battery?: number;
    connectTime?: number;
    resetCount?: number;
    alertCount?: number;
    occupancy?: number;
    dailyOccupancy?: number;
    temperature?: number;
    severity?: EventSeverity | null;
    networkState?: string | null;
    serialCategory?: string | null;
    lastSerialLogLine?: string;
    recentSerialErrorCount?: number;
    reconnectDetected?: boolean;
    watchdogDetected?: boolean;
    resetDetected?: boolean;
    healthStatus: DeviceHealthStatus;
    anomalyCount: number;
    anomalies?: CurrentStateAnomaly[];
    offlineCandidate: boolean;
    deviceStatusLedgerUpdatedAt?: string;
    deviceStatusLedgerFetchedAt?: string;
    deviceStatusLedgerSizeBytes?: number;
    deviceStatusLedgerData?: Record<string, unknown>;
    updatedAt: string;
}
export interface FleetSummaryResponse {
    projectId: string;
    deviceCount: number;
    healthy: number;
    warning: number;
    critical: number;
    unknown: number;
    lowBatteryCount: number;
    highConnectTimeCount: number;
    alertingDeviceCount: number;
    recentSerialErrorCount: number;
    devices: Array<{
        deviceId: string;
        deviceName: string | null;
    }>;
    generatedAt: string;
}
export interface FleetAnomaliesResponse {
    projectId: string;
    count: number;
    devices: Array<{
        deviceId: string;
        deviceName: string | null;
        healthStatus: DeviceHealthStatus;
        lastEventTime: string;
        battery?: number;
        connectTime?: number;
        anomalies: CurrentStateAnomaly[];
    }>;
}
export interface FleetOfflineResponse {
    projectId: string;
    thresholdHours: number;
    count: number;
    devices: Array<{
        deviceId: string;
        deviceName: string | null;
        lastEventTime: string;
        lastPlane?: EventPlane;
        lastEventType: string;
        offlineCandidate: true;
    }>;
}
//# sourceMappingURL=index.d.ts.map